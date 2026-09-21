// RecallFlow ↔ opencode 的本地中继：连接本机 MCP server，处理 browser_read 请求。
//
// 传输：HTTP 长轮询为主（扩展 service worker 用 fetch 访问本机最稳），WebSocket 为辅。
// 服务端收到 MCP 工具调用后，优先经 WebSocket 推送；无 WS 时排队等扩展长轮询取走。
//
// 说明：MCP server 由用户显式配置并启动；本中继只做「读页面」，不写数据、不执行代码。
import { executeTool, closeAgentWindow } from '../assistant/tools.js';

const RELAY_HOST = '127.0.0.1:7801';
// 与 MCP server 共享的本地桥接 token：HTTP 走请求头、WS 走查询参数，配合服务端
// Host 校验，让网页脚本无法直接访问本机桥接端口。
const RELAY_TOKEN = 'recallflow-local-bridge-v1';
const RELAY_HTTP = 'http://' + RELAY_HOST;
const RELAY_WS = 'ws://' + RELAY_HOST + '/?token=' + encodeURIComponent(RELAY_TOKEN);
const RELAY_AUTH_HEADERS = { 'X-RecallFlow-Token': RELAY_TOKEN };

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let httpLoopRunning = false;

// ---------------- WebSocket（辅助通道） ----------------
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, 8000);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    try {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    } catch (e) {}
  }, 25000);
}
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function connectWs() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(RELAY_WS);
  } catch (e) {
    socket = null;
    scheduleReconnect();
    return;
  }
  socket.addEventListener('open', () => {
    try {
      socket.send(JSON.stringify({ type: 'hello', client: 'recallflow-extension' }));
    } catch (e) {}
    startHeartbeat();
  });
  socket.addEventListener('message', (ev) => handleWsMessage(ev.data));
  socket.addEventListener('close', () => {
    socket = null;
    stopHeartbeat();
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    try {
      socket.close();
    } catch (e) {}
  });
}

async function handleWsMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (!msg || msg.id === undefined || !msg.method) return;
  const reply = (payload) => {
    try {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(Object.assign({ id: msg.id }, payload)));
    } catch (e) {}
  };
  try {
    reply({ result: await dispatch(msg.method, msg.params || {}) });
  } catch (e) {
    reply({ error: String((e && e.message) || e) });
  }
}

// ---------------- HTTP 长轮询（主通道） ----------------
async function httpLoop() {
  if (httpLoopRunning) return;
  httpLoopRunning = true;
  while (httpLoopRunning) {
    try {
      const res = await fetch(RELAY_HTTP + '/poll', { cache: 'no-store', headers: RELAY_AUTH_HEADERS });
      const data = await res.json();
      const requests = (data && data.requests) || [];
      for (const req of requests) {
        let payload;
        try {
          payload = { id: req.id, result: await dispatch(req.method, req.params || {}) };
        } catch (e) {
          payload = { id: req.id, error: String((e && e.message) || e) };
        }
        try {
          await fetch(RELAY_HTTP + '/result', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, RELAY_AUTH_HEADERS),
            body: JSON.stringify(payload),
          });
        } catch (e) {}
      }
    } catch (e) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ---------------- 请求分发 ----------------
async function dispatch(method, params) {
  if (method === 'browser_read') return await browserRead(params);
  if (method === 'read_console') return await readActiveTab('read_console', params);
  if (method === 'read_network') return await readActiveTab('read_network', params);
  if (method === 'get_element_source') return await readActiveTab('get_element_source', params);
  if (method === 'get_picked_element') return await getPickedElement();
  throw new Error('unknown method: ' + method);
}

// 返回用户最近在页面上「选取」的元素（选择器 + 标签 + 文本 + 前端源码位置）。
async function getPickedElement() {
  try {
    const d = await chrome.storage.local.get('recallflow.lastPicked');
    const picked = d && d['recallflow.lastPicked'];
    if (!picked || !picked.selector) return { found: false };
    return { found: true, picked };
  } catch (e) {
    return { found: false, error: e.message };
  }
}

// 读取用户「当前活动标签页」的运行时信息（console / network），用于前端调试。
async function readActiveTab(kind, params) {
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs && tabs[0];
  } catch (e) {}
  if (!tab || !tab.id) throw new Error('未找到活动标签页（请切到要调试的页面）');
  const ctx = { tabId: tab.id, pageUrl: tab.url || '', pageTitle: tab.title || '' };
  const res = await executeTool(kind, params || {}, ctx);
  return { text: (res && res.result) || '' };
}

// 用隔离窗口打开 URL、读取渲染后正文、返回；读取完自动关闭窗口。
async function browserRead(params) {
  const url = String(params.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('browser_read 仅支持 http/https URL');
  const ctx = {
    browsingMode: 'isolated',
    maxOpenedTabs: 8,
    openedTabs: [],
    openedTabCount: 0,
  };
  const opened = await executeTool('open_tab', { url }, ctx);
  if (!opened || opened.ok === false) throw new Error((opened && opened.result) || '打开页面失败');
  ctx.tabId = opened.targetTabId;
  if (opened.targetTab) {
    ctx.pageUrl = opened.targetTab.url || '';
    ctx.pageTitle = opened.targetTab.title || '';
  }
  let text = '';
  try {
    const read = await executeTool('read_current_page', {}, ctx);
    text = String((read && read.result) || '');
    text = text.replace(/^页面标题：[^\n]*\n页面URL：[^\n]*\n\n/, '');
  } finally {
    try {
      await closeAgentWindow(ctx);
    } catch (e) {}
  }
  const finalUrl = (opened.targetTab && opened.targetTab.url) || url;
  const title = (opened.targetTab && opened.targetTab.title) || '';
  return { url: finalUrl, title, text, quotes: [] };
}

// ---------------- 启动 ----------------
let started = false;
export function startMcpRelay() {
  connectWs();
  httpLoop();
  if (started) return;
  started = true;
  // 用 chrome.alarms 周期性确保长轮询/连接存活：MV3 service worker 休眠后
  // 循环会停，alarm 能唤醒 worker 并重启轮询（自愈）。
  try {
    if (chrome && chrome.alarms) {
      chrome.alarms.create('recallflow-relay', { periodInMinutes: 1 });
      chrome.alarms.onAlarm.addListener((a) => {
        if (a && a.name === 'recallflow-relay') {
          connectWs();
          httpLoop();
        }
      });
    }
  } catch (e) {}
}

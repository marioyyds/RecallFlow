// RecallFlow ↔ opencode 的本地中继：扩展作为 WebSocket 客户端连接本机 MCP server，
// 收到 browser_read 请求时，用真实浏览器会话（隔离窗口）打开并读取页面，返回正文。
// 说明：MCP server 由用户显式配置并启动；本中继只做「读页面」，不写数据、不执行代码。
import { executeTool, closeAgentWindow } from '../assistant/tools.js';

const RELAY_URL = 'ws://127.0.0.1:7801';
let socket = null;
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(RELAY_URL);
  } catch (e) {
    socket = null;
    scheduleReconnect();
    return;
  }
  socket.addEventListener('open', () => {
    try {
      socket.send(JSON.stringify({ type: 'hello', client: 'recallflow-extension' }));
    } catch (e) {}
  });
  socket.addEventListener('message', (ev) => {
    handleRaw(ev.data);
  });
  socket.addEventListener('close', () => {
    socket = null;
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    try {
      socket.close();
    } catch (e) {}
  });
}

async function handleRaw(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (!msg || msg.id === undefined || !msg.method) return;
  const reply = (payload) => {
    try {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(Object.assign({ id: msg.id }, payload)));
      }
    } catch (e) {}
  };
  try {
    const result = await dispatch(msg.method, msg.params || {});
    reply({ result });
  } catch (e) {
    reply({ error: String((e && e.message) || e) });
  }
}

async function dispatch(method, params) {
  if (method === 'browser_read') return await browserRead(params);
  throw new Error('unknown method: ' + method);
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
    // 去掉 read_current_page 前置的“页面标题/页面URL”头部，正文单独返回。
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

let started = false;
export function startMcpRelay() {
  if (started) return;
  started = true;
  connect();
}

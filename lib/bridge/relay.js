// RecallFlow ↔ DSH 的客户端：连接 **DSH 自身服务上的单插件集成**，处理页面能力调用。
//
// 架构变化（为什么这里不再叫"中继到 7801"）：
//   新架构里只有一条会话，页面能力由 DSH 内的一个插件直接注册成工具，
//   插件再通过 WebSocket 把调用转给扩展执行。因此这里连的是 DSH 自己的端口，
//   不再需要单独的桥接进程，也不再需要 token。
//
// 为什么只用 WebSocket 而没有 HTTP 长轮询（旧版是以长轮询为主的）：
//   MV3 的 service worker 空闲约 30 秒会被回收，而 WebSocket 活动在 Chrome 里
//   是明确的保活条件 —— 用 WS 既传消息又保活，一条通道就够。
//
// 安全性：插件侧对 HTTP 与 WS 都做了**来源白名单**（只放行 127.0.0.1/localhost
//   与 chrome-extension://），因此任意网页读不到本机；旧版的 token 是个公开常量，
//   本来也不构成真正的防护。
import { executeTool, closeAgentWindow, collectPageDiagnostics, collectElementSource, verifyPageTargets } from '../assistant/tools.js';
import { getHandoff, listHandoffs } from '../shared/handoff-store.js';
import { BRIDGE_METHODS } from '../shared/bridge-methods.js';
import { getAISettings } from '../shared/settings.js';
import { screenshotAttempts } from '../shared/utils.js';
import * as cdp from '../backend/cdp.js';

/** DSH 自己的服务。实测 /recallflow/* 不在鉴权栅栏内（/ 与 /api/* 才返回 401）。 */
const RELAY_HOST = '127.0.0.1:3080';
const RELAY_HTTP = 'http://' + RELAY_HOST;
const RELAY_WS = 'ws://' + RELAY_HOST + '/recallflow/ws';
const SAY_PATH = '/recallflow/say';

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;

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
  // 会话事件：插件把「这条会话发生了什么」推过来，扩展转给面板渲染。
  // 新架构里面板就是这条会话的另一个视图，所以事件就是会话事件本身，
  // 不再需要旧版那套 say/tool 映射。
  if (msg && msg.kind === 'session-event') {
    forwardSessionEvent(msg);
    return;
  }
  // 工具调用：{ kind:'tool-call', callId, method, payload }
  // method 沿用扩展自己的能力清单（dispatch），因此这套实现原样复用。
  if (msg && msg.kind === 'tool-call') {
    const reply = (payload) => {
      try {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(Object.assign({ kind: 'tool-result', callId: msg.callId }, payload)));
        }
      } catch (e) {}
    };
    try {
      reply({ ok: true, value: await dispatch(msg.method, msg.payload || {}) });
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
    return;
  }
  // hello / pong / session-registered：仅用于判活，不需要回复
}

// 把服务端推来的**会话事件**转给「当前活动标签页」的面板。
// 工具调用的作用对象就是活动标签页（本文件的各方法都基于 activeTab），
// 因此事件也送到那里 —— 多标签页时才不会张冠李戴。
function forwardSessionEvent(frame) {
  if (!frame) return;
  activeTab()
    .then((tab) => {
      if (!tab || tab.id == null) return;
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'rfSessionEvent', frame }, () => void chrome.runtime.lastError);
      } catch (e) {}
    })
    .catch(() => {});
}

// 旧版把「外部 agent 干了什么」按 say/tool 形状转给面板；新版直接用会话事件
// （见 forwardSessionEvent）。保留这个函数名会让人以为还有两条通道，所以删掉。

// ---------------- HTTP 长轮询：**已删除** ----------------
// 旧版以长轮询为主通道（理由是"service worker 用 fetch 访问本机最稳"），
// 新架构把它删掉了：插件只在 WebSocket 上推工具调用，而且 WS 本身就是 MV3 的保活条件，
// 一条通道既传消息又保活，比"轮询 + WS 双通道"更简单也更可靠。
// 代价说清楚：WS 断开期间工具调用会立刻失败（插件返回"浏览器侧没有连接"），
// 而不是排队等下次轮询 —— 这是有意的取舍：失败要看得见，不要静默排队。


// ---------------- 请求分发 ----------------
async function dispatch(method, params) {
  if (method === 'browser_read') return await browserRead(params);
  if (method === 'read_console') return await readActiveTab('read_console', params);
  if (method === 'read_network') return await readActiveTab('read_network', params);
  if (method === 'get_element_source') return await readElementSource(params);
  if (method === 'page_health') return await readPageDiagnostics();
  if (method === 'verify_change') return await readVerifyChange(params);
  if (method === 'get_picked_element') return await getPickedElement();
  // 交接包：读取用户在浏览器面板里复制出来的会话（凭 RF-XXXXXX 标识）。
  // 存储就在后台可直接访问，无需再经内容脚本。
  if (method === 'handoff_get') return await getHandoff(params && params.id);
  if (method === 'handoff_list') return await listHandoffs(params && params.limit);
  if (method === 'screenshot_capture') return await screenshotCapture(params);
  throw new Error('unknown method: ' + method);
}

// 供上层做「清单 ↔ 分支」一致性核对（见 tests/bridge-contract.test.mjs）：
// 清单里有但这里没分支 = 调用方会收到 unknown method。
export const SUPPORTED_BRIDGE_METHODS = BRIDGE_METHODS;

/**
 * 把「用户在面板里说的一句话」送进 DSH 的这条会话（面板 → DSH）。
 *
 * 新架构下这不是"同步"，而是**直接发消息**：插件用 agent.send(msg,'next-turn',true)
 * 把它变成这条会话的真实用户消息（能唤醒空闲会话）—— 两个界面看到的本来就是同一条。
 *
 * 因此只发**用户自己说的话**（role 为 user）。面板助手自己的回复不再推过去：
 * 那会变成冒充用户消息，而且新架构下回复本就来自这条会话。
 *
 * 为什么必须经后台：内容脚本的 fetch 会被同源策略限制（面板所在的网页不是 127.0.0.1），
 * 后台凭 host_permissions 才能直连本机。失败静默 —— 这是附加能力，不该影响面板自身。
 */
export async function sayToDsh(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return false;
  try {
    const r = await fetch(RELAY_HTTP + SAY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t }),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

// 截图：MCP 客户端请求当前页面的一张图（给有视觉能力的模型，或留档备查）。
// 图片体积只能靠 format/quality 控制（Page.captureScreenshot 不支持缩放），
// 因此沿用与内置 take_screenshot 相同的降质阶梯，避免超长 base64 撑爆桥接消息。
async function screenshotCapture(params) {
  const p = params || {};
  let tabId = null;
  try {
    const tab = await activeTab();
    tabId = tab && tab.id;
  } catch (e) {
    tabId = null;
  }
  if (!tabId) return { ok: false, error: '没有可截图的活动标签页' };
  // 尊重用户的设置开关：关闭 CDP 时不偷偷截图。
  try {
    const settings = await getAISettings();
    if (settings && settings.cdpEnabled === false) {
      return { ok: false, error: 'CDP 已在设置中关闭，截图不可用' };
    }
  } catch (e) {
    /* 设置读不到时不阻断，交由 isCdpAvailable 决定 */
  }
  if (!cdp.isCdpAvailable()) return { ok: false, error: 'CDP 不可用（debugger API 未就绪）' };

  const wantPng = p.format === 'png';
  const ladder = screenshotAttempts(wantPng ? 'png' : 'jpeg', p.quality);
  const MAX_B64 = 400000;
  let data = '';
  let used = ladder[0];
  let degraded = false;
  for (let i = 0; i < ladder.length; i++) {
    try {
      data = await cdp.screenshot(tabId, { format: ladder[i].format, quality: ladder[i].quality, fullPage: p.fullPage === true });
    } catch (e) {
      data = '';
    }
    used = ladder[i];
    degraded = i > 0;
    if (data && data.length <= MAX_B64) break;
  }
  if (!data) return { ok: false, error: '截图失败：CDP 无法附加到该标签页（可能被其它调试工具占用）' };

  let width = 0;
  let height = 0;
  try {
    const m = await cdp.command(tabId, 'Page.getLayoutMetrics');
    const box = p.fullPage === true ? m.cssContentSize || m.contentSize : m.cssVisualViewport || m.visualViewport;
    if (box) {
      width = Math.round(box.clientWidth || box.width || 0);
      height = Math.round(box.clientHeight || box.height || 0);
    }
  } catch (e) {}
  return {
    ok: true,
    image: {
      data,
      mimeType: used.format === 'png' ? 'image/png' : 'image/jpeg',
      width,
      height,
      bytes: Math.round((data.length * 3) / 4),
      format: used.format,
      quality: used.quality,
      degraded,
    },
  };
}

// 返回用户最近在页面上「选取」的元素（选择器 + 标签 + 文本 + 前端源码位置）。
async function getPickedElement() {
  try {
    const d = await chrome.storage.local.get(['recallflow.lastPicked', 'recallflow.lastPickedList']);
    const picked = d && d['recallflow.lastPicked'];
    const list = (d && d['recallflow.lastPickedList']) || [];
    if (!picked || !picked.selector) return { found: false };
    return { found: true, picked, list };
  } catch (e) {
    return { found: false, error: e.message };
  }
}

// 读取用户「当前活动标签页」的运行时信息（console / network），用于前端调试。
async function activeTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return (tabs && tabs[0]) || null;
  } catch (e) {
    return null;
  }
}

async function readActiveTab(kind, params) {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('未找到活动标签页（请切到要调试的页面）');
  const ctx = { tabId: tab.id, pageUrl: tab.url || '', pageTitle: tab.title || '' };
  const res = await executeTool(kind, params || {}, ctx);
  return { text: (res && res.result) || '' };
}

// 结构化读取元素源码位置（get_element_source）：返回 source 对象而非格式化文本，
// 让 MCP 侧按字段归一化，不再依赖「元素源码位置：」这类文案。
async function readElementSource(params) {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('未找到活动标签页（请切到要调试的页面）');
  return await collectElementSource(tab.id, params || {});
}

// 结构化页面诊断（page_health）：返回原始条目而非文本，
// 以便 MCP 侧用 at 时间戳做增量游标、用 stack 定位源码。
async function readPageDiagnostics() {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('未找到活动标签页（请切到要调试的页面）');
  const data = await collectPageDiagnostics(tab.id);
  return {
    found: true,
    tabId: tab.id,
    pageUrl: tab.url || '',
    pageTitle: tab.title || '',
    console: (data && data.console) || [],
    network: (data && data.network) || [],
    consoleError: (data && data.consoleError) || '',
    networkError: (data && data.networkError) || '',
  };
}

// 改完代码后的验证：一次往返同时拿到「目标元素的渲染态」与「运行时诊断」，
// 保证两部分证据取自同一时刻，避免两次读取之间的页面变化造成误判。
async function readVerifyChange(params) {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('未找到活动标签页（请切到要调试的页面）');
  const targets = (params && params.targets) || [];
  const [states, diag] = await Promise.all([
    verifyPageTargets(tab.id, targets),
    collectPageDiagnostics(tab.id),
  ]);
  return {
    found: true,
    tabId: tab.id,
    pageUrl: tab.url || '',
    pageTitle: tab.title || '',
    targets: (states && states.targets) || [],
    targetsError: (states && states.found === false && states.reason) || '',
    console: (diag && diag.console) || [],
    network: (diag && diag.network) || [],
    consoleError: (diag && diag.consoleError) || '',
    networkError: (diag && diag.networkError) || '',
  };
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
  if (started) return;
  started = true;
  // 用 chrome.alarms 周期性确保 WebSocket 存活：MV3 service worker 被回收后连接会断，
  // alarm 能唤醒 worker 并重连（自愈）。WS 活动本身也会延长 worker 寿命，
  // 两者配合 —— alarm 负责"睡死之后叫醒"，WS 负责"别睡死"。
  try {
    if (chrome && chrome.alarms) {
      chrome.alarms.create('recallflow-relay', { periodInMinutes: 1 });
      chrome.alarms.onAlarm.addListener((a) => {
        if (a && a.name === 'recallflow-relay') connectWs();
      });
    }
  } catch (e) {}
}

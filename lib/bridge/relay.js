// RecallFlow ↔ opencode 的本地中继：连接本机 MCP server，处理 browser_read 请求。
//
// 传输：HTTP 长轮询为主（扩展 service worker 用 fetch 访问本机最稳），WebSocket 为辅。
// 服务端收到 MCP 工具调用后，优先经 WebSocket 推送；无 WS 时排队等扩展长轮询取走。
//
// 说明：MCP server 由用户显式配置并启动；本中继只做「读页面」，不写数据、不执行代码。
import { executeTool, closeAgentWindow, collectPageDiagnostics, collectElementSource, verifyPageTargets } from '../assistant/tools.js';
import { getHandoff, listHandoffs } from '../shared/handoff-store.js';
import { BRIDGE_METHODS } from '../shared/bridge-methods.js';
import { getAISettings } from '../shared/settings.js';
import { screenshotAttempts } from '../shared/utils.js';
import * as cdp from '../backend/cdp.js';

const RELAY_HOST = '127.0.0.1:7801';
// 与 MCP server 共享的本地桥接 token：HTTP 走请求头、WS 走查询参数，配合服务端
// Host 校验，让网页脚本无法直接访问本机桥接端口。
const RELAY_TOKEN = 'recallflow-local-bridge-v1';
const RELAY_HTTP = 'http://' + RELAY_HOST;
const RELAY_WS = 'ws://' + RELAY_HOST + '/?token=' + encodeURIComponent(RELAY_TOKEN);
const RELAY_AUTH_HEADERS = { 'X-RecallFlow-Token': RELAY_TOKEN };

// ---------------------------------------------------------------------------
// 第二条通道：DSH 自身服务上的单插件集成（新架构）。
//
// **为什么是"另加一条"而不是"换掉上面那条"**：7801 桥接不只服务 DSH ——
// opencode 也在用它（MCP client 那条）。我一度把扩展的桥接连接换成指向 DSH，
// 结果 opencode 的页面工具会**静默失效**（没报错，只是永远拿不到结果）。
// 教训：迁移不等于替换；确认某个组件只有一个消费者之前不要换掉它。
// 所以两条并存，各司其职：
//   7801 → MCP 工具调用（opencode 与 DSH 的 MCP client 共用）
//   3080 → DSH 这条会话本身（会话事件 + 面板输入），这是新架构要的那条
// ---------------------------------------------------------------------------
const DSH_HOST = '127.0.0.1:3080';
const DSH_HTTP = 'http://' + DSH_HOST;
const DSH_WS = 'ws://' + DSH_HOST + '/recallflow/ws';
const DSH_SAY_PATH = '/recallflow/say';

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let httpLoopRunning = false;

// 第二条通道（DSH 会话）自己的状态，与桥接那条**互不影响**：
// 一条断了不该牵连另一条，否则"并存"就失去意义了。
let dshSocket = null;
let dshReconnectTimer = null;
let dshHeartbeatTimer = null;

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
  // 请求/响应：桥接推来的工具调用。事件那条路已随旧插件一起删除 ——
  // 面板现在直接显示 DSH 会话本身的事件（见下方 DSH 会话通道）。
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

// （已删除）forwardBridgeEvent：把桥接推来的 say/tool 事件转给面板。
// 生产者（旧 DSH 插件）与消费者（面板的 renderBridgeEvent）都已移除 ——
// 面板现在渲染的是 DSH 会话本身的事件，见 forwardSessionEvent。

// ---------------- WebSocket：DSH 会话通道（新架构） ----------------
function scheduleDshReconnect() {
  if (dshReconnectTimer) return;
  dshReconnectTimer = setTimeout(() => {
    dshReconnectTimer = null;
    connectDshWs();
  }, 8000);
}

function startDshHeartbeat() {
  stopDshHeartbeat();
  dshHeartbeatTimer = setInterval(() => {
    try {
      if (dshSocket && dshSocket.readyState === WebSocket.OPEN) dshSocket.send(JSON.stringify({ kind: 'ping' }));
    } catch (e) {}
  }, 25000);
}
function stopDshHeartbeat() {
  if (dshHeartbeatTimer) {
    clearInterval(dshHeartbeatTimer);
    dshHeartbeatTimer = null;
  }
}

function connectDshWs() {
  if (dshSocket && (dshSocket.readyState === WebSocket.OPEN || dshSocket.readyState === WebSocket.CONNECTING)) return;
  try {
    dshSocket = new WebSocket(DSH_WS);
  } catch (e) {
    dshSocket = null;
    scheduleDshReconnect();
    return;
  }
  dshSocket.addEventListener('open', () => startDshHeartbeat());
  dshSocket.addEventListener('message', (ev) => handleDshMessage(ev.data));
  dshSocket.addEventListener('close', () => {
    dshSocket = null;
    stopDshHeartbeat();
    scheduleDshReconnect();
  });
  dshSocket.addEventListener('error', () => {
    try {
      dshSocket.close();
    } catch (e) {}
  });
}

async function handleDshMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return;
  }
  // 会话事件：DSH 那条会话发生了什么。面板是它的视图，因此直接转过去渲染。
  if (msg && msg.kind === 'session-event') {
    forwardSessionEvent(msg);
    return;
  }
  // 工具调用：与桥接那条通道**共用同一个 dispatch**，扩展的能力只有一份实现。
  if (msg && msg.kind === 'tool-call') {
    const reply = (payload) => {
      try {
        if (dshSocket && dshSocket.readyState === WebSocket.OPEN) {
          dshSocket.send(JSON.stringify(Object.assign({ kind: 'tool-result', callId: msg.callId }, payload)));
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

/** 把 DSH 会话的事件转给当前活动标签页的面板（新架构唯一的"往下推"通道）。 */
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

// ---------------- HTTP 长轮询（主通道） ----------------
async function httpLoop() {
  if (httpLoopRunning) return;
  httpLoopRunning = true;
  while (httpLoopRunning) {
    try {
      const res = await fetch(RELAY_HTTP + '/poll', { cache: 'no-store', headers: RELAY_AUTH_HEADERS });
      const data = await res.json();
      const requests = (data && data.requests) || [];
      // 桥接返回体里的 events 已不再处理：那是 say/tool 事件（面板事件），
      // 随旧插件一起废弃了。请求（工具调用）仍然走这里 —— 那才是桥接现在的职责。
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

/** 把「用户在面板里说的一句话」送进 DSH 的这条会话（新架构的输入通道）。
 *
 * 它取代了旧的 postPanelTurn：那条是把面板的回合"上报"给桥接、再由旧插件注入成模型侧
 * 上下文；这条是**直接发消息** —— 插件的 agent.send(msg,'next-turn',true) 让它成为这条会话的
 * 真实用户消息（能唤醒空闲会话）。两个界面看到的本来就是同一条，所以不需要同步。
 *
 * 只发**用户自己说的话**：面板助手自己的回复不再推过去 ——
 * 那会变成冒充用户消息，而且新架构下回复本就来自这条会话。
 *
 * 走后台而不是内容脚本：内容脚本所在网页不是 127.0.0.1，直连会被同源策略挡住；
 * 后台凭 host_permissions 才能访问本机。失败静默 —— 附加能力不该影响面板自身。
 */
export async function sayToDsh(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return { ok: false, rpcId: '' };
  try {
    const r = await fetch(DSH_HTTP + DSH_SAY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t }),
    });
    let body = null;
    try {
      body = await r.json();
    } catch (e) {}
    // ok 以 **HTTP 状态**为准：body 解析不出来不该算失败（那只是拿不到 rpcId）。
    // 把 rpcId 一并回传：面板用它把本地那条回合与从会话回声回来的那条**精确对齐**。
    // 在此之前只能靠"最近 8 条 + 文本相同"猜，同一句话说两遍就分不清。
    return { ok: !!r.ok, rpcId: (body && body.rpcId) || '' };
  } catch (e) {
    return { ok: false, rpcId: '' };
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
  httpLoop();
  connectDshWs(); // 第二条通道（DSH 会话）与桥接并行启动，互不影响
  if (started) return;
  started = true;
  // 用 chrome.alarms 周期性确保两条连接存活：MV3 service worker 休眠后循环会停，
  // alarm 能唤醒 worker 并重启（自愈）。WS 活动本身也会延长 worker 寿命，两者配合。
  try {
    if (chrome && chrome.alarms) {
      chrome.alarms.create('recallflow-relay', { periodInMinutes: 1 });
      chrome.alarms.onAlarm.addListener((a) => {
        if (a && a.name === 'recallflow-relay') {
          connectWs();
          httpLoop();
          connectDshWs();
        }
      });
    }
  } catch (e) {}
}

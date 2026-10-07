// RecallFlow 扩展的本地通道：只连 DSH 自己的服务（3080）。
//
// 三条路径都在这个文件里：面板输入送进会话（sayToDsh）、会话事件转给面板
// （forwardSessionEvent）、以及在 WebSocket 上执行 DSH 发来的工具调用（dispatch）。
//
// 历史（值得留着）：这里原本还有**第二条**通道连本机 7801 桥接（RecallFlow ↔ opencode
// 的 MCP 工具服务，HTTP 长轮询为主、WS 为辅）。当初之所以"另加一条"而不是换掉它，
// 是因为它不只服务 DSH —— 换掉会让 opencode 的页面工具**静默失效**（没报错，只是永远
// 拿不到结果）。用户 2026-10-08 明确说不再用 opencode，那个消费者消失之后，
// 这条通道与桥接整包都已删除（见 docs/deletion-plan.md）。
import { executeTool, closeAgentWindow, collectPageDiagnostics, collectElementSource, verifyPageTargets } from '../assistant/tools.js';
import { getHandoff, listHandoffs } from '../shared/handoff-store.js';
import {
  BRIDGE_METHODS,
  BROWSER_ACTION_METHODS,
  DANGEROUS_BACKGROUND_METHODS,
  DANGEROUS_CONTENT_METHODS,
  PAGE_ACTION_BACKGROUND_METHODS,
  PAGE_ACTION_CONTENT_METHODS,
  READONLY_BACKGROUND_METHODS,
  READONLY_CONTENT_METHODS,
} from '../shared/bridge-methods.js';
import { getAISettings } from '../shared/settings.js';
import { screenshotAttempts } from '../shared/utils.js';
import * as cdp from '../backend/cdp.js';

const DSH_HOST = '127.0.0.1:3080';
const DSH_HTTP = 'http://' + DSH_HOST;
const DSH_WS = 'ws://' + DSH_HOST + '/recallflow/ws';
const DSH_SAY_PATH = '/recallflow/say';

// DSH 通道自己的连接状态。
// （原来这里还并列着桥接那条的 socket/reconnectTimer/heartbeatTimer/httpLoopRunning，
//   以及"两条通道互不影响"的说明 —— 桥接删掉后只剩这一条，说明也就不需要了。）
let dshSocket = null;
let dshReconnectTimer = null;
let dshHeartbeatTimer = null;

// ---------------- WebSocket：DSH 会话通道 ----------------
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

// ---------------- 请求分发 ----------------

/**
 * content 路由的工具：拿到活动标签页上下文后交给 executeTool。
 * 用 executeTool 而不是自己重写一遍逻辑 —— 单一实现，扩展侧改一处两边都跟着变。
 */
async function runContentTool(method, params) {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('未找到活动标签页（请切到要调试的页面）');
  const ctx = { tabId: tab.id, pageUrl: tab.url || '', pageTitle: tab.title || '' };
  const res = await executeTool(method, params || {}, ctx);
  // 与其它工具一致：失败要**抛**（调用方据此报错），而不是把错误文本当结果返回。
  if (res && res.ok === false) throw new Error(String(res.result || (method + ' 执行失败')));
  return res;
}

/** background 路由的工具：不需要页面。 */
async function runBackgroundTool(method, params) {
  const res = await executeTool(method, params || {}, {});
  if (res && res.ok === false) throw new Error(String(res.result || (method + ' 执行失败')));
  return res;
}

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

  // 只读档（给 DSH 插件用，见 lib/shared/bridge-methods.js 里两套清单的说明）。
  // 这两个分支**故意**用清单查表而不是逐个 if —— 清单是唯一来源，避免"加了清单忘了分支"
  // 或"删了分支忘了清单"；契约测试核对 EXTENSION_METHODS 与这两组清单不出现空洞。
  if (READONLY_CONTENT_METHODS.includes(method)) return await runContentTool(method, params);
  if (READONLY_BACKGROUND_METHODS.includes(method)) return await runBackgroundTool(method, params);

  // 改页面档（第二档）：会**修改用户正在看的页面**。
  // **审批在插件侧**（默认拒绝，除非 profile 的插件 config 写了 allowPageActions: true）——
  // 扩展只负责执行，不做审批决策；这样"谁能触发"只有一个地方要审。
  if (PAGE_ACTION_CONTENT_METHODS.includes(method)) return await runContentTool(method, params);
  if (PAGE_ACTION_BACKGROUND_METHODS.includes(method)) return await runBackgroundTool(method, params);

  // 浏览器/网络档（第三档）与危险档（第四档）。同样是**插件侧**做审批门禁：
  // 扩展只执行，不管"该不该执行"—— 审批逻辑只有一处，才审得清。
  if (BROWSER_ACTION_METHODS.includes(method)) return await runBackgroundTool(method, params);
  if (DANGEROUS_CONTENT_METHODS.includes(method)) return await runContentTool(method, params);
  if (DANGEROUS_BACKGROUND_METHODS.includes(method)) return await runBackgroundTool(method, params);

  throw new Error('unknown method: ' + method);
}

// 供上层做「清单 ↔ 分支」一致性核对（见 tests/bridge-contract.test.mjs）：
// 清单里有但这里没分支 = 调用方会收到 unknown method。
export const SUPPORTED_BRIDGE_METHODS = BRIDGE_METHODS;

/** 把「用户在面板里说的一句话」送进 DSH 的这条会话（新架构的输入通道）。
 *
 * 它取代了旧的 postPanelTurn：那条是把面板的回合"上报"给桥接、再由旧插件注入成模型侧
 * 上下文；这条是**直接发消息** —— 插件的 agent.send(msg,'next-step',true) 让它成为这条会话的
 * 真实用户消息（能唤醒空闲会话）。两个界面看到的本来就是同一条，所以不需要同步。
 * （target 用 'next-step' 而非 'next-turn'：后者要等整轮结束、且可能在轮次边界被清掉 ——
 *  用户反馈"发了没反应"就是它；见 docs/two-way-sync.md 踩坑第 13 条。）
 *
 * 只发**用户自己说的话**：面板助手自己的回复不再推过去 ——
 * 那会变成冒充用户消息，而且新架构下回复本就来自这条会话。
 *
 * 走后台而不是内容脚本：内容脚本所在网页不是 127.0.0.1，直连会被同源策略挡住；
 * 后台凭 host_permissions 才能访问本机。失败静默 —— 附加能力不该影响面板自身。
 *
 * `sessionId`（2026-10-08 加）：面板选了"跟哪条会话说话"时带上它。**不传就是旧行为**
 * （插件按 currentSessionId 挑最近活跃的那条）。插件在"指定了却找不到"时会回 404 + 明确原因，
 * 那句话原样带回去（`error`）—— 让面板能说清"这条没发出去"，而不是让人以为发出去了。
 */
export async function sayToDsh(text, sessionId, elements) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return { ok: false, rpcId: '', error: '空文本，未发送' };
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  // 面板拾取的元素：**只在非空时**放进请求体（不拾取 = 请求体与以前一模一样）。
  // 它由插件拼进消息文本，所以模型一定读得到、会话里也看得见。
  const els = Array.isArray(elements) ? elements.filter((e) => e && typeof e === 'object') : [];
  const payload = { text: t };
  if (sid) payload.sessionId = sid;
  if (els.length) payload.elements = els;
  try {
    const r = await fetch(DSH_HTTP + DSH_SAY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let body = null;
    try {
      body = await r.json();
    } catch (e) {}
    // ok 以 **HTTP 状态**为准：body 解析不出来不该算失败（那只是拿不到 rpcId）。
    // 把 rpcId 一并回传：面板用它把本地那条回合与从会话回声回来的那条**精确对齐**。
    // 在此之前只能靠"最近 8 条 + 文本相同"猜，同一句话说两遍就分不清。
    // error 只在失败时有意义（例如"找不到指定的会话"）；成功时留空串，保持返回形状稳定。
    return { ok: !!r.ok, rpcId: (body && body.rpcId) || '', error: (body && body.error) || '' };
  } catch (e) {
    return { ok: false, rpcId: '', error: String((e && e.message) || e) };
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
  let readError = '';
  try {
    const read = await executeTool('read_current_page', {}, ctx);
    // executeTool **不抛异常**，失败时返回 { ok:false, result:'读取页面失败：…' }。
    // 原来这里无条件把 result 当正文（text = read.result），于是那句错误说明会
    // 一路当成"页面正文"返回给模型 —— 我看到的就是这样（text 里是那句报错，
    // 而不是空串或明确的失败）。修法：显式判别 ok。
    if (read && read.ok === false) {
      readError = String(read.result || '读取页面失败');
    } else {
      text = String((read && read.result) || '');
      text = text.replace(/^页面标题：[^\n]*\n页面URL：[^\n]*\n\n/, '');
    }
  } catch (e) {
    readError = '读取页面失败：' + String((e && e.message) || e);
  } finally {
    try {
      await closeAgentWindow(ctx);
    } catch (e) {}
  }
  const finalUrl = (opened.targetTab && opened.targetTab.url) || url;
  const title = (opened.targetTab && opened.targetTab.title) || '';
  if (readError) {
    // 失败就要看起来像失败：text 留空 + 明确的 error 字段，并带上诊断
    // （是否复用已有标签页 / 当时内容脚本就绪了没有 / 选中标签页与窗口的状态），
    // 方便下次一眼定位 —— 用户实测的这个 bug 之前只能靠猜。
    return {
      url: finalUrl,
      title,
      text: '',
      quotes: [],
      error: readError,
      reused: Boolean(opened.reused),
      tabReady: Boolean(opened.targetTab && opened.targetTab.ready),
      diag: opened.diag || null,
    };
  }
  return { url: finalUrl, title, text, quotes: [] };
}

// ---------------- 启动 ----------------
let started = false;

/** 启动 RecallFlow 的本地通道（只剩 DSH 这一条）。
 *
 * 名字不再叫 `startMcpRelay`：它已经不连 MCP 了，旧名字会让下一个人以为还有一条桥接。
 * 调用点在 background.js，已同步更新。
 */
export function startRecallFlowRelay() {
  connectDshWs();
  if (started) return;
  started = true;
  // 用 chrome.alarms 周期性确保连接存活：MV3 service worker 休眠后循环会停，
  // alarm 能唤醒 worker 并重启（自愈）。WS 活动本身也会延长 worker 寿命，两者配合。
  try {
    if (chrome && chrome.alarms) {
      chrome.alarms.create('recallflow-relay', { periodInMinutes: 1 });
      chrome.alarms.onAlarm.addListener((a) => {
        if (a && a.name === 'recallflow-relay') connectDshWs();
      });
    }
  } catch (e) {}
}

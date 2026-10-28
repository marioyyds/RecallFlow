// RecallFlow ↔ opencode 的本地中继：连接本机 MCP server，处理 browser_read 请求。
//
// 传输：HTTP 长轮询为主（扩展 service worker 用 fetch 访问本机最稳），WebSocket 为辅。
// 服务端收到 MCP 工具调用后，优先经 WebSocket 推送；无 WS 时排队等扩展长轮询取走。
//
// 说明：MCP server 由用户显式配置并启动；本中继只做「读页面」，不写数据、不执行代码。
import { executeTool, closeAgentWindow, collectPageDiagnostics, collectElementSource, verifyPageTargets } from '../assistant/tools.ts';
import { getHandoff, listHandoffs } from '../shared/handoff-store.ts';
import { BRIDGE_METHODS } from '../shared/bridge-methods.ts';
import { validateBridgeWrite } from '../shared/bridge-write-policy.ts';
import { getAISettings } from '../shared/settings.ts';
import { screenshotAttempts } from '../shared/utils.ts';
import { DEFAULT_SCREENSHOT_BUDGET_MS, captureWithLadder } from '../assistant/screenshot-tool.ts';
import * as cdp from '../backend/cdp.ts';

const RELAY_HOST = '127.0.0.1:7801';
const RELAY_HTTP = 'http://' + RELAY_HOST;

type BridgeParams = Record<string, unknown>;

interface RelayMessage {
  id?: string | number;
  method?: string;
  params?: BridgeParams;
  session?: unknown;
}

interface RelayRequest {
  id: string | number;
  method: string;
  params?: BridgeParams;
  session?: unknown;
}

interface RelayReplyPayload {
  id?: string | number;
  result?: unknown;
  error?: string;
  session?: unknown;
}

interface BrowserReadContext {
  browsingMode: string;
  maxOpenedTabs: number;
  openedTabs: unknown[];
  openedTabCount: number;
  tabId?: number;
  pageUrl?: string;
  pageTitle?: string;
}

interface ViewportBox {
  clientWidth?: number;
  clientHeight?: number;
  width?: number;
  height?: number;
}

interface LayoutMetrics {
  cssContentSize?: ViewportBox;
  contentSize?: ViewportBox;
  cssVisualViewport?: ViewportBox;
  visualViewport?: ViewportBox;
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
  fullChars: number;
}

// WS 的 token 只能放在查询串里：浏览器 WebSocket API 无法设置请求头。
// 这是本文件唯一把 token 放进 URL 的位置（HTTP 通道走请求头）。
function relayWsUrl(): string {
  return 'ws://' + RELAY_HOST + '/?token=' + encodeURIComponent(relayToken);
}

// 与 MCP server 共享的本地桥接 token。
//
// **默认 token 已恢复（用户明确要求）**：此前这里和 server 侧共用常量
// 'recallflow-local-bridge-v1'，且它出现在 README 里 —— 等于把共享密钥提交进仓库，
// 任何本机进程都能用它冒充扩展、返回伪造的"证据"快照。
// 中间版本一度改成"不配置就不连接"，为了开箱即用又改回默认值。
// 覆盖方式：设置页「桥接 Token」填自定义值，server 侧设同一个 RECALLFLOW_BRIDGE_TOKEN。
export const DEFAULT_BRIDGE_TOKEN = 'recallflow-local-bridge-v1';
let relayToken = '';
let tokenLoaded = false;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let httpLoopRunning = false;

async function loadRelayToken(): Promise<string> {
  if (tokenLoaded) return relayToken;
  try {
    const settings = await getAISettings();
    relayToken = String((settings && settings.bridgeToken) || '').trim();
  } catch (e) {
    relayToken = '';
  }
  // 留空即用内置默认值（与 server 的默认值一致，因此无需任何配置即可连通）。
  if (!relayToken) relayToken = DEFAULT_BRIDGE_TOKEN;
  tokenLoaded = true;
  return relayToken;
}

function authHeaders(): Record<string, string> {
  // WS 无法在浏览器端设置请求头，因此 token 只走 HTTP 头与 WS 握手负载，绝不进 URL。
  return relayToken ? { 'X-RecallFlow-Token': relayToken } : {};
}

async function connectWs(): Promise<void> {
  if (!(await loadRelayToken())) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(relayWsUrl());
  } catch (e) {
    socket = null;
    scheduleReconnect();
    return;
  }
  socket.addEventListener('open', () => {
    try {
      socket!.send(JSON.stringify({ type: 'hello', client: 'recallflow-extension' }));
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
      socket!.close();
    } catch (e) {}
  });
}

// ---------------- WebSocket（辅助通道） ----------------
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, 8000);
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    try {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    } catch (e) {}
  }, 25000);
}
function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function handleWsMessage(raw: string): Promise<void> {
  let msg: RelayMessage | null | undefined;
  try {
    msg = JSON.parse(raw) as RelayMessage | null;
  } catch (e) {
    return;
  }
  if (!msg || msg.id === undefined || !msg.method) return;
  const reply = (payload: RelayReplyPayload) => {
    try {
      if (socket && socket.readyState === WebSocket.OPEN) {
        // 回带 session，让服务端把结果路由回发起的那个会话（与 HTTP 通道同理）。
        const out: RelayReplyPayload = Object.assign({ id: msg!.id }, payload);
        if (msg!.session !== undefined && msg!.session !== null) out.session = msg!.session;
        socket.send(JSON.stringify(out));
      }
    } catch (e) {}
  };
  try {
    reply({ result: await dispatch(msg.method, msg.params || {}) });
  } catch (e) {
    reply({ error: String(((e as { message?: string } | null) && (e as { message?: string }).message) || e) });
  }
}

// ---------------- HTTP 长轮询（主通道） ----------------
async function httpLoop(): Promise<void> {
  if (httpLoopRunning) return;
  // 没配置 token 就不要开始轮询：否则每 3 秒对 127.0.0.1 发一次注定 401 的请求，
  // 既刷控制台也掩盖真正的原因（用户还没填 token）。
  if (!(await loadRelayToken())) return;
  httpLoopRunning = true;
  while (httpLoopRunning) {
    try {
      const res = await fetch(RELAY_HTTP + '/poll', { cache: 'no-store', headers: authHeaders() });
      const data = (await res.json()) as { requests?: RelayRequest[] } | null;
      const requests = (data && data.requests) || [];
      for (const req of requests) {
        // req.session 由服务端标注（它是哪个 MCP 会话的请求）。扩展**不解释**这个值，
        // 只在回结果时原样带回去，让服务端把结果路由到正确的会话。
        // 不这么做的话，多客户端并发时 A 可能拿到 B 的页面正文。
        const session = req.session;
        let payload: RelayReplyPayload;
        try {
          payload = { id: req.id, result: await dispatch(req.method, req.params || {}) };
        } catch (e) {
          payload = { id: req.id, error: String(((e as { message?: string } | null) && (e as { message?: string }).message) || e) };
        }
        if (session !== undefined && session !== null) payload.session = session;
        try {
          await fetch(RELAY_HTTP + '/result', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
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
async function dispatch(method: string, params: BridgeParams): Promise<unknown> {
  if (method === 'browser_read') return await browserRead(params);
  // 诊断类统一入口：kind 由 params 指定（桥接方法名 == 扩展工具名，因此参数形状也一致）。
  if (method === 'read_diagnostics') return await readActiveTab('read_diagnostics', params);
  if (method === 'get_element_source') return await readElementSource(params);
  if (method === 'page_health') return await readPageDiagnostics();
  if (method === 'verify_change') return await readVerifyChange(params);
  if (method === 'get_picked_element') return await getPickedElement();
  // 交接包：读取用户在浏览器面板里复制出来的会话（凭 RF-XXXXXX 标识）。
  // 存储就在后台可直接访问，无需再经内容脚本。
  if (method === 'handoff_get') return await getHandoff(params && params.id);
  if (method === 'handoff_list') return await listHandoffs((params && params.limit) as number | undefined);
  if (method === 'screenshot_capture') return await screenshotCapture(params);
  if (method === 'page_action') return await pageAction(params);
  throw new Error('unknown method: ' + method);
}

// 写入通道：外部客户端驱动的页面动作。
//
// 为什么需要它：文档承诺的前端调试闭环是「元素 → 源码 → 改代码 → 断言渲染结果」，
// 但此前 MCP 面只有 12 个**只读**工具 —— 外部 agent 无法点击/输入，
// 于是既复现不了 bug（没有交互就没有请求），也验证不了修复（触发不了动作）。
//
// 安全边界：本函数**不**复用 agent 循环的审批（那条路在 agent.js 里），
// 因此必须自己过一遍 bridge-write-policy 的白名单；未列出的工具一律拒绝并给出替代路径。
async function pageAction(params: BridgeParams): Promise<Record<string, unknown>> {
  const p = params || {};
  const verdict = validateBridgeWrite(p.tool as string, p.args || {});
  if (!verdict.ok) return { ok: false, error: verdict.error, code: verdict.code };
  const tab = await activeTab();
  if (!tab || !tab.id) return { ok: false, error: '未找到活动标签页（请先让用户切到要调试的页面）', code: 'NO_ACTIVE_TAB' };
  const ctx = { tabId: tab.id, pageUrl: tab.url || '', pageTitle: tab.title || '' };
  const res = await executeTool(verdict.name as string, (p.args || {}) as Record<string, unknown>, ctx);
  return {
    ok: res && res.ok !== false,
    tool: verdict.name,
    result: (res && res.result) || '',
    // 把观测到的验证字段原样带出去：外部 agent 判断"这一步真的生效了吗"靠的就是它。
    verification: (res && res.verification) || null,
    hadEffect: Boolean(res && res.hadEffect),
    tabId: ctx.tabId,
    pageUrl: ctx.pageUrl,
  };
}

// 供上层做「清单 ↔ 分支」一致性核对（见 tests/bridge-contract.test.mjs）：
// 清单里有但这里没分支 = 调用方会收到 unknown method。
export const SUPPORTED_BRIDGE_METHODS = BRIDGE_METHODS;

// 截图：MCP 客户端请求当前页面的一张图（给有视觉能力的模型，或留档备查）。
// 图片体积只能靠 format/quality 控制（Page.captureScreenshot 不支持缩放），
// 因此沿用与内置 take_screenshot 相同的降质阶梯，避免超长 base64 撑爆桥接消息。
async function screenshotCapture(params: BridgeParams): Promise<Record<string, unknown>> {
  const p = params || {};
  let tabId: number | undefined | null = null;
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
  // ⚠ 与面板侧同一套实现（`captureWithLadder`）：
  //   · 单张体积上限与总预算共用同一个常量（两份真值必然漂移）；
  //   · 阶梯必须有**总预算**并按剩余预算下传超时 —— 否则三档各等默认 8s = 24s+，
  //     调用方（外部 agent）等不到就会把自己的超时算在扩展头上；
  //   · 失败要**区分"超时"与"附加失败"**：两者的下一步动作不同（前者该换读法，
  //     后者多半是 DevTools 占用了调试器）。原实现一律报"无法附加"，把人指错方向 ✗
  const shot = await captureWithLadder({
    cdp,
    tabId,
    ladder,
    budgetMs: DEFAULT_SCREENSHOT_BUDGET_MS,
    fullPage: p.fullPage === true,
  });
  const data = shot.data;
  const used = shot.used;
  const degraded = shot.degraded;
  if (!data) {
    return {
      ok: false,
      error: shot.timedOut
        ? '截图超时：CDP 未在 ' + DEFAULT_SCREENSHOT_BUDGET_MS + 'ms 预算内响应（页面过重或调试器被占用）。可改用 browser_read / page_action 取结构化信息。'
        : '截图失败：CDP 无法附加到该标签页（可能被其它调试工具占用）。',
    };
  }

  let width = 0;
  let height = 0;
  try {
    // 同一份预算（阶梯留下的 deadline）：这一步也是 CDP 命令，不该各自重新起算。
    const m = (await cdp.command(tabId, 'Page.getLayoutMetrics', {}, { timeoutMs: Math.max(400, shot.deadline - Date.now()) })) as LayoutMetrics;
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
async function getPickedElement(): Promise<Record<string, unknown>> {
  try {
    const d = await chrome.storage.local.get(['recallflow.lastPicked', 'recallflow.lastPickedList']);
    const picked = (d && d['recallflow.lastPicked']) as { selector?: string } | null | undefined;
    const list = (d && d['recallflow.lastPickedList']) || [];
    if (!picked || !picked.selector) return { found: false };
    return { found: true, picked, list };
  } catch (e) {
    return { found: false, error: (e as { message?: string }).message };
  }
}

// 读取用户「当前活动标签页」的运行时信息（console / network），用于前端调试。
async function activeTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return (tabs && tabs[0]) || null;
  } catch (e) {
    return null;
  }
}

async function readActiveTab(kind: string, params: BridgeParams): Promise<{ text: string }> {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('未找到活动标签页（请切到要调试的页面）');
  const ctx = { tabId: tab.id, pageUrl: tab.url || '', pageTitle: tab.title || '' };
  const res = await executeTool(kind, params || {}, ctx);
  return { text: (res && res.result) || '' };
}

// 结构化读取元素源码位置（get_element_source）：返回 source 对象而非格式化文本，
// 让 MCP 侧按字段归一化，不再依赖「元素源码位置：」这类文案。
async function readElementSource(params: BridgeParams): Promise<unknown> {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('未找到活动标签页（请切到要调试的页面）');
  return await collectElementSource(tab.id, params || {});
}

// 结构化页面诊断（page_health）：返回原始条目而非文本，
// 以便 MCP 侧用 at 时间戳做增量游标、用 stack 定位源码。
async function readPageDiagnostics(): Promise<Record<string, unknown>> {
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
async function readVerifyChange(params: BridgeParams): Promise<Record<string, unknown>> {
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

// 按 maxChars 截断正文，并如实标注截断（纯函数，便于直测）。
// 为什么单独抽出来：截断的**语义**容易写错 —— 不说清"这是片段"，
// 调用方会把部分正文当成全文，进而基于不完整内容下结论。
//
// ⚠ 还差半句（本仓库对截断的判据是"给可恢复 id，或明确说取不回 + 怎么取"）：
// 原文**没有**留在任何暂存里 ⇒ 不要暗示"可以用 id 取回"；能做的只有"调大 maxChars 重读"，
// 所以那句话必须写出来，否则调用方只知道"少了"，不知道下一步该做什么。
export function truncateEvidenceText(input: unknown, maxChars?: number): TruncateResult {
  const full = String(input === undefined || input === null ? '' : input);
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 12000;
  if (full.length <= limit) return { text: full, truncated: false, fullChars: full.length };
  return {
    text:
      full.slice(0, limit) +
      '\n…（正文共 ' + full.length + ' 字符，已按 maxChars=' + limit + ' 截断；' +
      '**被截掉的部分无法用 id 取回**，需要时请用更大的 maxChars 重新调用 browser_read）',
    truncated: true,
    fullChars: full.length,
  };
}

// 用隔离窗口打开 URL、读取渲染后正文、返回；读取完自动关闭窗口。
async function browserRead(params: BridgeParams): Promise<Record<string, unknown>> {
  const url = String(params.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('browser_read 仅支持 http/https URL');
  // 这两个参数此前**被静默丢弃**（MCP 侧 schema 声明了、也转发了，这里却不读）：
  //   waitFor  → SPA 上等待元素出现，否则会读到空壳页面（表现为「挂住/正文为空」）
  //   maxChars → 正文上限，否则整页正文灌进上下文（默认 12000 见 MCP schema）
  const waitFor = String((params && params.waitFor) || '').trim();
  const maxCharsRaw = Number(params && params.maxChars);
  const maxChars = Number.isFinite(maxCharsRaw) && maxCharsRaw > 0 ? Math.floor(maxCharsRaw) : 12000;
  const ctx: BrowserReadContext = {
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
  // 等待目标选择器出现。wait_for_element 自身带超时并返回结构化结果，
  // 失败时**不抛错**：SPA 里该元素可能本来就不需要，继续读取正文比直接失败更有用。
  let waitError = '';
  if (waitFor) {
    try {
      const waited = await executeTool('wait_for_element', { selector: waitFor, state: 'visible' }, ctx);
      if (waited && waited.ok === false) waitError = String(waited.result || '等待超时').slice(0, 200);
    } catch (e) {
      waitError = String(((e as { message?: string } | null) && (e as { message?: string }).message) || e).slice(0, 200);
    }
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
  // 生效 maxChars：截断要**如实说明**，否则调用方会以为拿到了全文。
  const cut = truncateEvidenceText(text, maxChars);
  text = cut.text;
  return {
    url: finalUrl,
    title,
    text,
    quotes: [],
    // 等待超时不当作失败，但必须让调用方看见 —— 否则「页面是空壳」会被误当成「页面本来就没内容」。
    waitError: waitError || undefined,
    truncated: cut.truncated,
    fullChars: cut.fullChars,
  };
}

// ---------------- 启动 ----------------
let started = false;
export function startMcpRelay(): void {
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

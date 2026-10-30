// 网页端 AI 助手 UI：悬浮按钮(FAB)/划词气泡/对话面板 + Markdown 渲染 + 对话持久化
import { getAISettings, updateAISettings, AI_SETTINGS_DEFAULTS, expandQuickPrompt } from '../../shared/settings.ts';
import {
  composeProgressText,
  summarizePickedForMessage,
  pickedSummaryHtml,
  selectedTextMessageHtml,
  formatElementLocator,
} from '../../shared/utils.ts';
import {
  buildTranscript,
  serializeCompleteConversationMessages,
  alreadyCommittedAsText,
  dedupeAdjacentTextParts,
  collapseImmediateRepeatedText,
  normalizeConversationDuplicates,
  buildPartialTurn,
  buildFailedTurn,
  buildInterruptedTurn,
} from './transcript.ts';
import { createFrameScheduler } from './render-scheduler.ts';
import { createLruCache } from '../../shared/lru.ts';
import { createExportGuard, HOST_ID } from './save-clean.ts';
import { PanelThemeController } from '../panel/theme-controller.ts';
import { PanelProgressController, stateLabel } from '../panel/progress-controller.ts';
import { PanelScreenshotView } from '../panel/screenshot-view.ts';
import {
  argHint,
  msgActionsHtml,
  sessionTimeText,
  summarizeToolParts,
  thinkLabelText,
  userActionsHtml,
} from '../panel/conversation-format.ts';
import { computeRunControls } from '../../application/panel/run-controls.ts';
import { PanelSessionState } from '../../application/panel/session-state.ts';
import { FollowedRunState } from '../../application/panel/followed-run-state.ts';
import { StreamViewState } from '../../application/panel/stream-view-state.ts';
import type { DomPort } from '../../application/ports/dom.ts';
export { computeRunControls } from '../../application/panel/run-controls.ts';

// 扩展被重新加载/停用后，旧内容脚本的 chrome.* 调用会抛 "Extension context invalidated"。
// 用它做防御性判断，避免未捕获异常刷屏。
function isExtContextAlive() {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return false;
    chrome.runtime.getManifest();
    return true;
  } catch (e: any) {
    return false;
  }
}
// 取扩展资源 URL；扩展上下文失效时返回空串，避免抛 "Extension context invalidated"。
function extUrl(path: any) {
  try {
    return chrome.runtime.getURL(path);
  } catch (e: any) {
    return '';
  }
}
// 扩展被重新加载后，旧内容脚本失效：提示用户刷新，且只提示一次。
let extDeadWarned = false;
function warnExtDead() {
  if (extDeadWarned) return;
  extDeadWarned = true;
  try {
    const d = document.createElement('div');
    d.textContent = 'RecallFlow 已更新，当前页面助手已失效，请刷新页面后重试。';
    d.style.cssText =
      'position:fixed;z-index:2147483647;left:50%;top:16px;transform:translateX(-50%);' +
      'background:#e74c3c;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.3);font-family:inherit;';
    (document.body || document.documentElement).appendChild(d);
    setTimeout(() => { try { d.remove(); } catch (e: any) {} }, 6000);
  } catch (e: any) {}
}
import { extractPageText } from '../../application/page/page-text.ts';
import { newHandoffId, normalizeHandoffId, buildHandoffRecord, buildToolTrail, prepareHandoffTrail, formatHandoffPrompt } from '../../shared/handoff.ts';
import { clearCiteHighlight, isPointerInCitationRange, findAndHighlightCitation } from '../../application/page/citation.ts';
import { escHtml, renumberCitations, renumberCitationsAcross, decodeSnippet, renderAnswer, planCitationOpen, parseSuggestionOptions } from './markdown.ts';
import { PANEL_CSS } from './panel-css.ts';
import {
  clampPanelSize,
  clampPanelIntoView,
  clampPanelAnchoredIntoView,
  panelAnchoredOffsets,
  loadGlobalPanelLayout,
  PANEL_LAYOUT_STORAGE_KEY,
  readPanelLayout,
  readGlobalPanelLayout,
  saveGlobalPanelLayout,
  writePanelLayout,
  resolvePanelPlacement,
} from './panel-layout.ts';
import type { PanelLayoutStorage } from './panel-layout.ts';
import { applyRunEvent, runStateToAssistantMessage } from '../../application/agent/run-hub.ts';
import { loadScreenshot } from '../../shared/screenshot-store.ts';
import {
  createFabController,
  createFabPeekController,
  FAB_POSITION_KEY,
  normalizeFabRatio as normFabRatio,
} from './fab-position.ts';
import { createPanelVisibilityController } from '../../application/panel/visibility.ts';
import { createPanelRunSession } from '../../application/panel/run-session.ts';
import { createPanelStreamState } from '../../application/panel/stream-state.ts';
import { UNAVAILABLE_RUNTIME_PORT, type RuntimePort } from '../../application/ports/runtime.ts';
import type { StoragePort } from '../../application/ports/storage.ts';
import {
  describeApprovalRequest as describeApprovalRequestView,
  renderApprovalPrompt as renderApprovalPromptView,
} from '../panel/approval-view.ts';
import {
  authChallengeHtml,
  authChallengeElement,
  clipDetail,
  toolStepHtml,
  toolStepElement,
} from '../panel/tool-step-view.ts';


/**
 * 宿主用**自定义元素** `<rf-ai-host>`，不是 `<div>` —— 这是"存档里不出现悬浮球"的主防线。
 *
 * 实测（真 Chromium + 真扩展，CDP Page.captureSnapshot 即「另存为」用的同一套序列化器）：
 * 浏览器会把 open shadow root 一起写进存档 `<template shadowrootmode="open">`，
 * 里面的 `.fab`、图标 `<img src="chrome-extension://…">` 全都在 —— 用户保存本地页后
 * 离线打开，就看到一个点不动的 RecallFlow 图标。所以"图标在 shadow 里就安全"是错的。
 *
 * 自定义元素的妙处是 `:defined` 是**运行期状态**，不进 HTML：存档里没有我们的脚本，
 * `rf-ai-host` 不会被升级，`PANEL_CSS` 里的 `:host(:not(:defined)){display:none}` 命中，
 * 整块 UI 在存档里是隐藏的；而实时页面里脚本一 define，它立刻变成可见。
 *
 * 兜底：万一 define 失败（例如页面已经占用了这个名字），退回 `<div>` 继续跑 ——
 * 宁可回到"存档里会带图标"的老行为，也不能让用户的悬浮球彻底消失。
 */
const HOST_TAG = 'rf-ai-host';

/**
 * 造宿主元素：优先自定义元素，主世界脚本没跑到就退回 `<div>`。
 *
 * ⚠ 隔离世界里 `customElements` 是 **null**（实测：`typeof` 仍是 'object'，一调 .get 就抛），
 * 所以既不能在这里 define，也读不到注册表。定义由页面主世界完成
 * （manifest 里 `world: MAIN` 的 lib/page/debug-hook.js，document_start）。
 * 这里只能问 DOM 本身："这个名字被升级了吗" —— `:defined` 对已升级的自定义元素为真。
 *
 * 退回 div 是**有意的降级**：宁可回到"存档里会带图标"的老行为，也不能因为一个优化
 * 让悬浮球彻底消失 —— 入口比干净更重要。
 */
function createHostElement() {
  try {
    const el = document.createElement(HOST_TAG);
    if (el && typeof el.matches === 'function' && el.matches(':defined')) return el;
  } catch (e: any) {}
  return document.createElement('div');
}

/**
 * 本地页（`file://`）与普通网页在 UI 上**没有区别**：打开就能看到悬浮球与划词气泡。
 *
 * 之所以要在这里写一段，是因为"本地页不常驻"曾经是一个看似合理、实际用错了的取舍：
 * 它确实能让"页面自己保存"也绝不带上扩展节点，但代价是用户打开自己那份 HTML 时
 * 发现助手不见了 —— 而这恰恰是"支持本地页"最直接的期待。所以结论是：
 *   · 常驻 UI，本地页和网页一致；
 *   · 存档里不留悬浮球，靠上面那条 `:defined` 闸门（对任何保存方式都成立）；
 *   · 打印 / Ctrl+S 另存由 `save-clean.js` 在导出那一瞬间再把宿主摘出文档（双保险）。
 */

// 导出期（Ctrl+S / 打印）：宿主已被摘出文档，所有自动重建路径都必须停手，
// 否则会在"浏览器正在序列化的那一刻"把宿主挂回去（见 save-clean.js 的说明）。
let uiSuspended = false;
let exportGuard: any = null;

let host: any = null;
let shadow: any = null;
let bubble: any = null;
let panel: any = null;
let panelBody: any = null;
let lastText = '';
let lastResponse = '';
let dragState: any = null;
let resizeState: any = null;
let pageText = '';
let panelTextEl: any = null;
let fab: any = null;
let fabDragState: any = null;
let fabSuppressClickUntil = 0;
let lastShortcutToggleAt = 0;
let panelTitleEl: any = null;
let panelSessionMenuEl: any = null;
let panelSessionBtnEl: any = null;
let panelSessionMenuOpen = false;
// 全浏览器共享的面板开合状态。序号、权威开合值与广播抑制由独立控制器封装；
// 内容脚本只负责把 DOM 的 open/close 动作注入进来。
const panelVisibility = createPanelVisibilityController({
  send: (type, payload) => sendPanelMessage(type, payload),
  isMounted: () => Boolean(panel),
  open: () => {
    ensureHost();
    lastText = '';
    pageText = streamView.pageContextEnabled ? extractPageText() : '';
    openPanel(0, 0, true, true);
  },
  close: () => removePanel({ publish: false }),
});
const runSession = createPanelRunSession();
const panelSessionState = new PanelSessionState();
const followedRun = new FollowedRunState();
const streamView = new StreamViewState();
const streamState = createPanelStreamState();
let runtimePort: RuntimePort = UNAVAILABLE_RUNTIME_PORT;
// ⚠ stopBtn / sendBtn 必须是**模块级**：模块级的 restoreStreamingUI()（流式重开面板时恢复 UI）
// 要用它们把"任务还在跑"的按钮状态恢复回来。sendBtn 原先声明在 openPanel 内部（const），
// 于是模块级函数一碰它就 ReferenceError —— 面板会**半构建**（连接口都没有），
// 而所有静态门禁都看不到这个作用域错误，只有真浏览器重开面板才暴露（本轮踩到）。
let stopBtn: any = null;
let sendBtn: any = null;

/**
 * 运行状态的单一渲染入口：发送按钮、停止按钮、进度条都从这里取状态。
 * owner 页（streaming）和跟随页（followedRunState）必须表现一致，
 * 否则会出现「B 页看得到任务在跑，却没有停止按钮」这种状态分裂。
 */
function updateRunControlState() {
  const control = computeRunControls({ streaming: runSession.isRunning, followed: followedRun.followedRunState });
  if (stopBtn) {
    stopBtn.style.display = control.showStop ? '' : 'none';
    stopBtn.disabled = control.stopDisabled;
    stopBtn.textContent = control.stopText;
  }
  if (sendBtn) sendBtn.disabled = control.sendDisabled;
}

// 流式渲染合并器：chunk 是**逐 token** 到达的，若每条都重绘一次，
// 第 N 个 token 要把前 N 个 token 重新解析 + 重建 DOM + 两次强制布局 —— 超线性成本。
// 合并到每帧一次之后，渲染次数只与帧率有关，与 token 数无关。
// 详见 lib/page/render-scheduler.js。
const streamRender = createFrameScheduler();

// ---- 标签页重新可见时「补一次渲染 + 贴底」----
//
// 对应用户实测缺陷②"对话进行中切到其它 tab，流式也没有到最底下"。
//
// 隐藏标签页里浏览器**暂停 rAF**，而流式的每次重绘/置底都排在 rAF 上
// （`streamRender.schedule('answer'|'layout', …)`）⇒ 整个隐藏期间视图一动不动，
// 回到标签页时停在离开前那一屏。`render-scheduler.js` 里的兜底定时器已保证
// "总会有下一次渲染"（定时器在隐藏页只是被降频、不被暂停），这里再补一道**确定性**的收口：
// 重新可见时立刻把挂起的渲染 flush 掉，并在"用户本来就在底部"时贴底。
//
// ⚠ 只 flush、不 cancel：挂起的那批是**最新内容**，丢掉就等于丢渲染。
// ⚠ 用 `pinToBottom()`（内部认 `observerAutoScroll`）：用户切走前自己滚上去看历史时，
//   切回来不许把他拽到底部。
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // flush 会同步执行挂起的 'layout' 回调（内含 fitPanelHeight + 置底），
    // 之后这次 pinToBottom 兜住"flush 时面板还不存在/尺寸还没算出来"的残余情况。
    streamRender.flush();
    pinToBottom();
  });
}

const themeController = new PanelThemeController();
themeController.init();
const progressController = new PanelProgressController();
let panelKeyHandler: any = null;
let keepAliveTimer: any = null;
/**
 * 清空标题栏的 token 用量标识（`usageEl`）。
 *
 * 它只表示「当前会话这一轮运行」的用量，而全文件唯一的清空点在发送指令的流程里
 * （新一轮开始且没有 resume 快照时）。于是任何不经过那条流程的换会话动作
 * —— 新建、切换、删掉当前会话后回退 —— 都会让上一个会话最后那轮的总量
 * 一直挂在标题栏上（TITA-52：全新空会话显示 `tokens 257768`）。
 * 换会话统一走 adoptPanelSession()，所以清空也收敛在那里。
 */
function resetUsageChip() {
  if (streamView.usageEl) streamView.usageEl.textContent = '';
}
// 交接标识：把本次会话打包给外部 agent（opencode / DSH 等）凭标识经 MCP 取回。
// 存在 localStorage 里按来源隔离（每个站点一个），清空对话时轮换新标识。
let handoffId = '';
let conversationLoaded = false;
let conversationLoadPromise: any = null;
let handoffEl: any = null;
// 每个页面各自独立的对话（conversation 仅存于本页内存），不做跨 tab 同步。

// FAB 位置逻辑已抽到 ./fab-position.js（依赖显式注入，因而可被真测试覆盖）。
// 这里只保留一个控制器实例与几个薄封装 —— 语义与原实现一致，只是换了实现位置。
// 详见 fab-position.js 头部的说明：chat.js 只导出 initAssistant，
// 那段逻辑留在里面就只能靠读源码的正则断言"测"，等于没测。
const fabCtl = createFabController({
  getFab: () => fab,
  win: window,
  storage: typeof chrome !== 'undefined' ? chrome.storage : null,
  localStore: (() => { try { return localStorage; } catch (e: any) { return null; } })(),
});

/**
 * 气泡的收起 / 展开（TITA-36）。
 *
 * 与位置控制器 `fabCtl` 并列存在：两者共用「当前气泡元素」这一个取法，但**不共享
 * 持久化** —— 位置存 ratio，收起只切 class。混在一起就是 L-11。
 */
const fabPeek = createFabPeekController({
  getFab: () => fab,
  // ⚠ 必须是**布局视口**宽度（`documentElement.clientWidth`，不含滚动条）：
  // 气泡的 `right` 是相对布局视口算的，用 `innerWidth`（含滚动条）会让热区整体
  // 右偏一个滚动条宽度，页面一有滚动条就点不到最右边那条边。
  getViewportWidth: () => document.documentElement.clientWidth,
});

function fabHeight() {
  return fabCtl.fabHeight();
}

function currentFabTop() {
  return fabCtl.currentFabTop();
}

function clampFabTop(top: any) {
  return fabCtl.clampFabTop(top);
}

function normalizeFabRatio(value: any) {
  return normFabRatio(value);
}

function legacyFabRatio() {
  return fabCtl.legacyRatio();
}

function applySavedFabPosition() {
  fabCtl.applySaved();
}

function persistFabPosition() {
  fabCtl.persist();
}

async function loadFabPosition() {
  await fabCtl.load();
}

function moveFabBy(delta: any) {
  fabCtl.moveBy(delta);
}

function togglePanelFromShortcut() {
  const now = Date.now();
  if (now - lastShortcutToggleAt < 250) return;
  lastShortcutToggleAt = now;
  togglePanel();
}

function ensureHost() {
  // 导出中：宿主是被**故意**摘掉的（见 save-clean.js），此刻绝不能重建或复位它 ——
  // 那会把 UI 挂回文档，正好被序列化写进用户保存的那份文件里。
  if (uiSuspended) return;
  // SPA（Turbo 等客户端导航）可能把 <body> 乃至整个 <html> 子树替换掉：宿主被移出 DOM，
  // 但内容脚本不会重新注入、模块级 host 引用仍指向已脱离的节点 —— 只查 `if (host) return`
  // 会让 FAB/面板永久消失。先复位已脱离的 DOM 引用（**不动 port、不动 conversation**，
  // 进行中的任务由既有连接续跑，UI 重挂），再走正常构建。
  if (host && !host.isConnected) resetDetachedHostState();
  if (host) return;
  // 扩展被重新加载后旧内容脚本失效，避免继续创建 UI / 调用 chrome.*。
  if (!isExtContextAlive()) {
    warnExtDead();
    return;
  }
  // 存档残渣：页面自带的 DOM 里已经有一个宿主 id，说明这是一份**被保存过的副本**
  // （保存时把我们的宿主一起写进去了），或者页面把带扩展的 DOM 缓存了下来。
  // 不清理的话，打开这种副本会出现"旧的死图标 + 新注入的悬浮球"两个。
  // 只在 `host` 为空（准备新建）时清，所以不会误删自己的面板。
  try {
    const stale = document.getElementById(HOST_ID);
    if (stale) stale.remove();
  } catch (e: any) {}

  host = createHostElement();
  host.id = HOST_ID;
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  host.style.left = '0';
  host.style.top = '0';
  shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);

  fab = document.createElement('button');
  fab.className = 'fab';
  const fabIcon = document.createElement('img');
  fabIcon.src = extUrl('docs/assets/recallflow-mark.svg');
  fabIcon.alt = '';
  fab.appendChild(fabIcon);
  fab.title = 'RecallFlow（Alt+Shift+R 打开/关闭，可上下拖动）';
  fab.setAttribute('aria-label', '打开 RecallFlow，快捷键 Alt+Shift+R');
  fab.addEventListener('click', (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    if (Date.now() < fabSuppressClickUntil) return;
    togglePanel();
  });
  // 收起 / 展开：悬浮或键盘聚焦时整颗滑出，移出后回到贴右缘。
  // 触屏没有 hover，pointerenter 不会来 —— 那种设备由 CSS 的 `@media (hover: none)`
  // 直接取消收起（见 panel-css.js），否则 12px 的露出宽度等于点不到。
  // 悬浮 ⇒ 整颗滑出。不用 pointerleave 收起：气泡向左滑出时会"自己离开鼠标"，
  // 那会让它在原地来回抖；收起改由 document 上的 pointermove 按坐标判定
  // （见 lib/page/fab-position.js 的 isPointerInFabZone）。
  fab.addEventListener('pointerenter', () => fabPeek.setHovered(true));
  fab.addEventListener('focus', () => fabPeek.setFocused(true));
  fab.addEventListener('blur', () => fabPeek.setFocused(false));
  fab.addEventListener('pointerdown', (e: any) => {
    if (e.button !== 0 || !e.isPrimary) return;
    fabDragState = {
      pointerId: e.pointerId,
      startY: e.clientY,
      origTop: currentFabTop(),
      moved: false,
    };
    fab.classList.add('dragging');
    // 拖拽期间必须整颗可见：否则鼠标按在露出的那 12px 上，气泡却往回缩，手感是"抓不住"。
    fabPeek.setDragging(true);
    try { fab.setPointerCapture(e.pointerId); } catch (err: any) {}
    e.preventDefault();
    e.stopPropagation();
  });
  fab.addEventListener('pointermove', (e: any) => {
    if (!fabDragState || fabDragState.pointerId !== e.pointerId) return;
    const dy = e.clientY - fabDragState.startY;
    if (Math.abs(dy) > 3) fabDragState.moved = true;
    if (!fabDragState.moved) return;
    fab.style.top = clampFabTop(fabDragState.origTop + dy) + 'px';
    e.preventDefault();
  });
  const finishFabDrag = (e: any) => {
    if (!fabDragState || fabDragState.pointerId !== e.pointerId) return;
    const moved = fabDragState.moved;
    fabDragState = null;
    fab.classList.remove('dragging');
    fabPeek.setDragging(false);
    try { fab.releasePointerCapture(e.pointerId); } catch (err: any) {}
    if (moved) {
      fabSuppressClickUntil = Date.now() + 350;
      persistFabPosition();
    }
  };
  fab.addEventListener('pointerup', finishFabDrag);
  fab.addEventListener('pointercancel', finishFabDrag);
  fab.addEventListener('keydown', (e: any) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    moveFabBy(e.key === 'ArrowUp' ? -16 : 16);
  });
  shadow.appendChild(fab);
  // 面板此时必然是关的 ⇒ 一开始就是收起态（只露出一条边）。
  fabPeek.apply();
  applySavedFabPosition();
  loadFabPosition();

  document.documentElement.appendChild(host);
}

/**
 * 复位「宿主已被 SPA 导航从 DOM 移除」留下的悬空 DOM 引用。
 *
 * 为什么不用 removePanel()：它会走「用户关了面板」的落盘路径，按 panel 当前的 rect/offset
 * 把位置与尺寸写回 localStorage —— 这里 panel 已脱离 DOM，量出来全是 0（`persistPanelLayoutNow`
 * 虽然挡住了 0 尺寸，位置却会被写成 0,0）。也因为这根本不是一次「关闭」。所以只清引用；
 * port / streaming / conversation 全部保留（与「流式中关闭面板」同一原则）。
 */
function resetDetachedHostState() {
  if (streamView.picking) {
    try { chrome.runtime.sendMessage({ type: 'pick:cancel' }); } catch (e: any) {}
    streamView.picking = false;
    if (streamView.pickUi) streamView.pickUi = null;
  }
  if (panelKeyHandler) {
    document.removeEventListener('keydown', panelKeyHandler, true);
    panelKeyHandler = null;
  }
  panel = null;
  panelBody = null;
  panelCmdInput = null;
  resetPanelFitCache();
  panelTextEl = null;
  panelTitleEl = null;
  streamView.planBar = null;
  stopBtn = null;
  sendBtn = null;
  bubble = null;
  host = null;
  shadow = null;
  fab = null;
  fabDragState = null;
}

/**
 * 宿主保活：被 SPA 客户端导航移除后自动重建。
 *
 * 为什么用低频轮询而不是 MutationObserver：Turbo 这类导航可能替换整个 <html> 子树，
 * MutationObserver 会随被替换的节点一起失效；而内容脚本的 JS 上下文仍在（同一个 document）。
 * 每 1 秒只做一次 isConnected 检查，成本可忽略。宿主脱离后重建 —— FAB 回来，
 * 进行中的任务由既有的 port 续跑（见 ensureHost 的说明）。
 */
function watchHostKeepalive() {
  setInterval(() => {
    try {
      // 导出期宿主是**故意**脱离文档的：这里若把它当成"SPA 换了 DOM"去重建，
      // 就会在序列化窗口里挂回 UI。挂起态下整轮跳过。
      if (uiSuspended) return;
      if (host && !host.isConnected) {
        ensureHost();
        // SPA（Turbo 等）导航会连面板 DOM 一起换掉：若此刻任务仍在跑，
        // 重新打开面板并恢复流式 UI，否则用户只能看到一个没有输出的空面板/关闭状态。
        if (panelVisibility.isOpen) {
          openPanel(0, 0, true, true);
          if (runSession.isRunning) restoreStreamingUI();
        }
      }
    } catch (e: any) {}
  }, 1000);
}

/**
 * 安装导出期守卫（见 save-clean.js）。
 *
 * 它与 `ensureHost` / `watchHostKeepalive` 的关系是**一问一答**：
 * 守卫负责"把宿主摘掉 / 挂回来"，本文件负责"在挂起期间谁都不许再建宿主"。
 * 两边各管一半，是因为守卫不该知道面板的内部状态，而面板不该知道浏览器怎么导出。
 */
function installExportGuard() {
  if (exportGuard) return exportGuard;
  exportGuard = createExportGuard({
    getHost: () => host,
    onSuspend: () => {
      uiSuspended = true;
    },
    onResume: () => {
      uiSuspended = false;
    },
  });
  exportGuard.install();
  return exportGuard;
}

function removeBubble() {
  if (bubble) {
    bubble.remove();
    bubble = null;
  }
}

function removeSelectionPreview() {
  if (panelTextEl) {
    panelTextEl.remove();
    panelTextEl = null;
  }
}

/**
 * 同步输入区下方的“待发送选文”条。
 *
 * 它既可能在首次打开面板时创建，也可能在面板已经打开后用户再次划词时创建，
 * 所以不能只在 openPanel 里拼一次 DOM。空选文时删除整条，而不是留下一个空框。
 */
function syncPanelSelectionPreview() {
  if (!panel) return;
  const text = String(lastText || '').trim();
  if (!text) {
    removeSelectionPreview();
    return;
  }
  if (!panelTextEl || !panelTextEl.isConnected) {
    const bar = document.createElement('div');
    bar.className = 'p-text';
    const quote = document.createElement('span');
    quote.className = 'p-text-quote';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'p-text-clear';
    clear.textContent = '✕';
    clear.title = '移除页面选文';
    clear.setAttribute('aria-label', '移除页面选文');
    clear.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearSelectedText();
    });
    bar.appendChild(quote);
    bar.appendChild(clear);
    const quickPrompts = panel.querySelector('.quick-prompts');
    if (quickPrompts && quickPrompts.parentNode) quickPrompts.parentNode.insertBefore(bar, quickPrompts);
    else panel.appendChild(bar);
    panelTextEl = bar;
  }
  const quote = panelTextEl.querySelector('.p-text-quote');
  if (quote) {
    quote.textContent = text.length > 200 ? text.slice(0, 200) + '…' : text;
    quote.title = text;
  }
}

/**
 * 清除“下一条消息要附带的页面选文”。
 *
 * 这是用户显式取消，不会改动已经发送的消息。发送流程也会在把选文快照写进
 * 用户消息后调用它，避免下一条指令误带上一轮引用。
 */
function clearSelectedText(options?: any) {
  const opts = options || {};
  lastText = '';
  removeSelectionPreview();
  try {
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  } catch (e: any) {}
  if (opts.render !== false && panelBody && !runSession.isRunning && !panelSessionState.conversation.length && !followedRun.followedMessages.length) {
    renderConversation();
  }
  if (panel && opts.render !== false) fitPanelHeight();
}

function publishPanelUi(open: any, scope: any) {
  return panelVisibility.publish(open === true, scope === 'membership' ? 'membership' : 'global');
}

function removePanel(options?: any) {
  if (!(options && options.invalidateOpen === false)) panelOpenGeneration += 1;
  const hadPanel = Boolean(panel);
  // 关闭面板时若仍在拾取模式，通知后台让所有 frame 停止拾取。
  if (streamView.picking) {
    try { chrome.runtime.sendMessage({ type: 'pick:cancel' }); } catch (e: any) {}
    streamView.picking = false;
    if (streamView.pickUi) streamView.pickUi.setActive(false);
  }
  // 流式中关闭面板只是「隐藏」：不关 port、不 endStream，让助手继续生成，
  // 重新打开时能恢复正在输出的内容（见 restoreStreamingUI）。
  if (!runSession.isRunning) closePort();
  // 解除 document 级 Esc 监听，避免面板关闭后仍捕获按键。
  if (panelKeyHandler) {
    document.removeEventListener('keydown', panelKeyHandler, true);
    panelKeyHandler = null;
  }
  screenshotView.lightboxOpen = false; // 放大层随面板一起移除，标记必须复位，否则下次 Esc 关不掉面板
  clearCiteHighlight();
  if (panel) {
    // 布局在拖动/缩放结束、窗口夹取和打开时已经写入全局存储。关闭本身不再回写：
    // 全局关闭会同时关闭所有标签页，旧标签页若在这里落盘，会用旧布局覆盖刚编辑的布局。
    panel.remove();
    panel = null;
    panelBody = null;
    panelCmdInput = null;
    resetPanelFitCache();
    panelTextEl = null;
    panelTitleEl = null;
    // 计划条随面板一起被销毁：置空避免流式过程中（面板已隐藏但助手仍在跑）
    // renderPlan 往一个脱离文档的节点里写。重开面板时由 renderConversation 回填。
    streamView.planBar = null;
    if (fab) fab.classList.remove('hidden');
    // 面板关了 ⇒ 回到收起态（鼠标还悬在上面时保持展开，见 resolveFabPeek）。
    fabPeek.setPanelOpen(false);
  }
  if (hadPanel && !(options && options.publish === false)) publishPanelUi(false, 'global');
  if (hadPanel && !(options && options.publish === false)) {
    resetFollowedRun();
    sendPanelMessage('panel:run:unsubscribe').catch(() => {});
  }
}

function closePort() {
  runSession.closePort();
}

function showBubble(x: any, y: any) {
  if (!shadow) return; // host 未创建（如扩展上下文已失效）
  removeBubble();
  removePanel({ publish: false });
  bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = '<span class="dot"></span><span>RecallFlow</span>';
  bubble.addEventListener('mousedown', (e: any) => {
    e.preventDefault();
    e.stopPropagation();
  });
  bubble.addEventListener('click', (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    openPanel(x, y);
  });
  shadow.appendChild(bubble);
  // 入场动画会缩放 getBoundingClientRect；offset 尺寸不受 transform 影响，
  // 否则定位会按“缩小后的气泡”计算，动画结束后间距变窄。
  const bubbleWidth = bubble.offsetWidth;
  const bubbleHeight = bubble.offsetHeight;
  const maxLeft = Math.max(4, window.innerWidth - bubbleWidth - 4);
  const maxTop = Math.max(4, window.innerHeight - bubbleHeight - 4);
  const left = Math.min(Math.max(4, x), maxLeft);
  const preferredTop = y - bubbleHeight - 8 > 4 ? y - bubbleHeight - 8 : y + 12;
  const top = Math.min(Math.max(4, preferredTop), maxTop);
  bubble.style.left = left + 'px';
  bubble.style.top = top + 'px';
}

function togglePanel() {
  if (panel) {
    removePanel();
  } else {
    ensureHost();
    lastText = '';
    pageText = streamView.pageContextEnabled ? extractPageText() : '';
    openPanel(0, 0, true);
  }
}

/**
 * 置底用的滚动哨兵：一个远大于任何真实内容高度的 `scrollTop`。
 *
 * 浏览器会把越界的 `scrollTop` **自动夹到最大值**，结果就是"停在底部"，
 * 与 `scrollTop = scrollHeight` 完全等价 —— 但后者必须先读一次 `scrollHeight`，
 * 也就是先**强制一次同步布局**（见 fitPanelHeight 收尾处的注释）。这是阶段1A 实测里
 * "每帧 3 次强制布局"中最容易去掉的一次。
 *
 * 上限取 1e7 px：比任何会话的内容高度都大得多（500 条会话实测内容高度 ~2 万 px 量级），
 * 又远低于 Blink LayoutUnit 的上限（~3.3e7），不会被内部饱和逻辑再截断一次。
 */
const BOTTOM_SCROLL_PX = 1e7;

/**
 * chrome 测量的复用窗口（毫秒）。
 *
 * 签名（见 `fitChromeSignature`）能覆盖绝大多数"chrome 高度变了"的情形，
 * 但它终究是廉价的近似（不看实际几何），剩下的是"签名不变、高度却变了"。
 * 500ms 让这种误差最多存在半秒，代价是每秒多 2 次全量测量 —— 相比省下的
 * 每帧两次全量重排可以忽略。
 *
 * ⚠ 起算点是**上一次真实测量**（`chromeMeasure.measuredAt`），**不是**上一次命中。
 *   命中时若顺手把它续期成"本次命中时间"，条件就恒真 —— 于是整轮流式期间一次都不重测，
 *   签名漏判的高度变化会一直错下去（评审实测的缺陷，`ttl-probe.mjs` 可复现）。
 *   快路径因此**只**允许更新 `usedAt`。
 */
const CHROME_MEASURE_TTL_MS = 500;

/** 上一次真实测量的 chrome 结果，供同一结论的输入/视口复用。见 fitPanelHeight 里的快路径。 */
let chromeMeasure: any = null;
/** 上一次真实测量后，正文是否已被可用高度夹住（⇒ 内容再涨结论也不变）。 */
let fitBodyClamped = false;
/**
 * 面板输入框（textarea）的引用。
 *
 * 为什么需要它：`input` 事件会把它从 34px 撑到最多 120px，而 **textarea 的当前 value
 * 不在 `textContent` 里**（textContent 只是它的初始子节点内容，实际为空）—— 只看
 * `child.textContent.length` 的签名会漏掉"用户在打字、输入区变高"这件事。
 * 用模块级引用而不是每次 `panel.querySelector('.cmd-input')`：后者是 O(整棵面板子树) 的
 * 遍历（面板里可能挂着几百条消息），而这函数在流式路径上每帧都要跑。
 * 面板销毁时随 `panel` 一起置空，避免持有已脱离文档的节点。
 */
let panelCmdInput: any = null;
function resetPanelFitCache() {
  chromeMeasure = null;
  fitBodyClamped = false;
}

/**
 * 面板 chrome 的廉价签名：不读任何几何量（读了就会触发同步布局），
 * 只取"能改变各 chrome 子节点高度"的可枚举状态。
 */
function fitChromeSignature() {
  let sig = panel.className + '#';
  // 输入框是当前值唯一会凭空增长的控件（见 panelCmdInput 的说明），单独计入它的 value 长度。
  sig += (panelCmdInput && panelCmdInput.isConnected ? String(panelCmdInput.value || '').length : '-') + '#';
  for (const child of panel.children) {
    if (child === panelBody || child.classList.contains('resize-handle')) continue;
    sig +=
      child.tagName +
      '.' +
      String(child.className || '') +
      ':' +
      String(child.hidden ? 1 : 0) +
      ':' +
      (child.style ? String(child.style.height || '') : '') +
      ':' +
      child.children.length +
      ':' +
      String(child.textContent || '').length +
      '|';
  }
  return sig;
}

// 根据内容自动调整面板高度
export function fitPanelHeight() {
  if (!panel || !panelBody) return;
  // 导出期宿主不在文档里：此时量出来的高度全是 0，会把用户的面板尺寸写成 0×0。
  if (uiSuspended) return;
  // ⚠ **先记住"改高度之前是否贴着底"**：下面会把 `panel`/`panelBody` 的高度重置成 `auto` 再重算，
  //   而**滚动容器高度一变，浏览器就会把 `scrollTop` 归零/夹紧** ✗ —— 本函数有 28 个调用点，
  //   其中一大批在**流式渲染路径**上（每来一段正文/思考增量都会调）⇒ 视图就这样一遍遍**跳回顶部** ✓
  //   这正是用户反馈"模型在思考的时候，没有流式置底"的**真根因** ✓
  //   （之前只给渲染回调加置底是**治标**：置底之后紧接着一次 fitPanelHeight 又把它抹掉了 ✗）
  const wasPinned = isPinnedForFollow();
  // 用户调整过窗口尺寸后，严格尊重用户配置，不再覆盖高度。
  if (panel._manualSize) return;

  // ---- 快路径：面板已经饱和且 chrome 没变时，整次重排的结论与上一次一字不差 ----
  //
  // 为什么要绕开下面的测量：为了量出 chrome（输入区/计划条/底栏…）的**自然**高度，
  // 必须先把 `panel` 与 `panelBody` 的高度重置成 `auto` —— 那会让已经很长的正文
  // 按"不被裁切"重排**一整遍**，紧接着把算好的高度写回去又要**再排一遍**。
  // 流式渲染每帧都走到这里（阶段1A 实测：2,000-chunk 场景 fitPanelHeight 自耗时 24.6%，
  // 摊到每次重绘约 17ms），而这条路上 chrome 与视口**几乎不变**。
  //
  // 安全边界：① 只有当上一次真实测量的结论是"正文已被可用高度夹住"（`fitBodyClamped`）
  //   时才可能跳过 —— 内容继续增长仍会得出同样的 height/overflow，一字不差；
  // ② chrome 签名（标签/类名/内容长度/内联高度/子节点数）+ panel 类名 + 视口尺寸
  //   任一变化就落回下面的全量测量；③ 签名再全也有漏网的（内容等长改写、
  //   子元素自身高度变化），因此再加 500ms 的时间上限兜底：最坏情况是错最多半秒后自愈。
  const vp = panelViewport();
  const vw = vp.width;
  const vh = vp.height;
  const now = Date.now();
  const sig = fitChromeSignature();
  const reusable =
    chromeMeasure &&
    chromeMeasure.sig === sig &&
    chromeMeasure.vw === vw &&
    chromeMeasure.vh === vh &&
    now - chromeMeasure.measuredAt < CHROME_MEASURE_TTL_MS;
  if (reusable && fitBodyClamped) {
    // ⚠ 只更新"最近一次命中时间"。**不许**动 `measuredAt` —— TTL 必须从"上一次真实测量"
    //   起算，否则每次命中都把计时清零，上面的 500ms 兜底就永远不会到期
    //   （评审在 d9f69ed 上实测：整轮流式期间一次都没有重测）。
    chromeMeasure.usedAt = now;
    markSelfScroll();
    if (wasPinned) panelBody.scrollTop = BOTTOM_SCROLL_PX;
    return;
  }

  // 使用视口比例避免 4K 屏幕上面板贴得过低；桌面端限制上下限保证稳定。
  const dockGap = getDockGap();
  const topLimit = Math.max(12, Math.round(vh * 0.10));
  // 停靠模式以底部为锚点，最大高度不超过顶部安全区；增长时只向上扩展。
  let maxH = Math.max(320, vh - dockGap - topLimit);
  // 底部固定控件（审批/自动批准/输入区/底栏）可能本身就很高。此时若仍坚持
  // “对话区至少 120px”并锁死上面算出的 maxH，溢出内容会被 `overflow:hidden` 裁掉，
  // 底部 resize 手柄还会盖住原本可见的按钮。允许向视口内继续扩展，优先保证控件可点。
  const hardMaxH = Math.max(320, vh - 24);
  panel.style.height = 'auto';
  panelBody.style.height = 'auto';
  panelBody.style.flex = '';
  panelBody.style.overflowY = 'auto';
  let chromeH = 0;
  for (const child of panel.children) {
    if (child !== panelBody && !child.classList.contains('resize-handle')) chromeH += child.offsetHeight;
  }
  const MIN_BODY_H = 120;
  if (chromeH + MIN_BODY_H > maxH) maxH = Math.min(hardMaxH, chromeH + MIN_BODY_H);
  const bodyNatH = panelBody.scrollHeight;
  // 快捷语句、输入区与底栏属于固定区域，优先为它们预留高度；
  // 仅压缩可滚动的对话内容，避免底部“清空对话”被裁掉。
  const bodyAvailableH = Math.max(MIN_BODY_H, maxH - chromeH);
  const bodyH = Math.min(bodyNatH, bodyAvailableH);
  // 记录"正文是否已超过可用高度"：只有在这种情况下，下一次重复的 fitPanelHeight
  // 才会得出一模一样的结论，可以在入口安全跳过（见上面的快路径）。
  fitBodyClamped = bodyNatH > bodyAvailableH;
  chromeMeasure = { sig, chromeH, vw, vh, measuredAt: now, usedAt: now };
  panelBody.style.flex = 'none';
  panelBody.style.height = bodyH + 'px';
  panelBody.style.overflowY = bodyNatH > bodyH ? 'auto' : 'hidden';
  const totalH = Math.min(maxH, Math.max(320, chromeH + bodyH));
  panel.style.height = totalH + 'px';
  if (panel.classList.contains('docked') && !panel._manualPos) {
    panel.style.top = 'auto';
    // 面板比「视口 - 留白」还高时（底部控件占太多 / 窗口很矮），留白会把顶部顶出屏幕。
    // 正常视口下 Math.min 取到的仍是 dockGap，观感不变。
    panel.style.bottom = Math.min(dockGap, Math.max(0, vh - totalH - 8)) + 'px';
  }
  // ⚠ 收尾：**如果本来贴着底，改完高度要再置底一次** —— 否则上面那次高度重算导致的归零就留在那儿了 ✗
  //   只认"**本来贴底**"（`wasPinned` 在入口处算好 ✓）：用户自己滚上去看历史时，这里**不许**把他拽回来 ✓
  //   ⚠ 不要在这里再读一次 `observerAutoScroll` —— 改高度本身也可能触发一次 scroll 事件把它置 false ✗
  //
  //   ⚠ 另外必须 `markSelfScroll()`：本函数改的是**容器高度**，浏览器会因此自己夹紧 `scrollTop`
  //     并派发 scroll 事件；不屏蔽的话，那次事件会被当成"用户滚上去看历史"而**永久**关掉自动跟随
  //     （实测轨迹见 openPanel 里 scroll 监听器处的注释）。
  markSelfScroll();
  // ⚠ 写 `BOTTOM_SCROLL_PX` 而不是 `panelBody.scrollHeight`：后者为了拿到目标值必须先
  //   **读**一次 `scrollHeight`，而这一读会把上面刚写完的 height / overflow 强制兑现成
  //   一次同步布局 —— 流式路径每帧都要走一次正面这几行，2,000-chunk 场景里布局总量
  //   是 9.3s / 852 次（阶段1A 实测），摊到每帧约 3 次里有 1 次就来自这一读。
  //   写一个会被浏览器自己夹到底部的大值语义完全等价，且不必再触发一次布局。
  if (wasPinned) panelBody.scrollTop = BOTTOM_SCROLL_PX;
}

/**
 * 面板 fixed 定位使用的布局视口（不含滚动条）。
 *
 * ⚠ 必须用 `documentElement.clientWidth/clientHeight` 而不是 `window.innerWidth/innerHeight`：
 * CSS 的 `right`/`bottom` 相对布局视口，用 inner* 会把滚动条宽度算进去 ——
 * 右下角间距每开合一次就累加一次滚动条宽度，表现为面板持续向左/上漂。
 */
function panelViewport() {
  const el = typeof document !== 'undefined' ? document.documentElement : null;
  return {
    width: (el && el.clientWidth) || window.innerWidth,
    height: (el && el.clientHeight) || window.innerHeight,
  };
}

// 停靠模式使用相对视口高度的底部留白：大屏幕适当上移，小屏幕保持紧凑。
function getDockGap() {
  const vp = panelViewport();
  return vp.width <= 640 ? 12 : Math.min(520, Math.max(120, Math.round(vp.height * 0.30)));
}

/**
 * 把对话区贴到底部（"跟随最新一条"）。
 *
 * ⚠ **只能在面板真正进入文档之后再调用**。这不是风格问题，而是一个真实的静默失效：
 *   `openPanel` 里 `renderConversation()` / `fitPanelHeight()` / 置底原先都写在
 *   `panel.appendChild(panelBody)` **之前**，而面板本体更要等到函数末尾的
 *   `shadow.appendChild(panel)` 才进文档 —— 在那之前 `panelBody.isConnected === false`，
 *   `scrollHeight` 与 `clientHeight` **恒为 0** ⇒ `scrollTop = scrollHeight` 什么也没做，
 *   而且**不报错**。症状正是用户反馈的「关掉会话再打开，没有停在最后一条」。
 *   实测（修复前）：重开后 `scrollTop=0 / scrollHeight=780 / clientHeight=226`（偏差 554px），
 *   而手动置底能到 553 ⇒ 说明是"根本没执行"，不是"执行完又被抹掉"。
 *
 * 只认"本来就在底部"（`observerAutoScroll`）：用户自己滚上去看历史时不许把他拽回来。
 * 这是全文件十几处置底共同的纪律，入口收在这里以免各写各的。
 */
export function pinToBottom() {
  if (!followedRun.observerAutoScroll) return false;
  if (!panelBody || !panelBody.isConnected) return false;
  markSelfScroll();
  // 与 fitPanelHeight 收尾同理：写哨兵而不是读 `scrollHeight`，避免为了置底再强制一次同步布局
  // （本函数是流式路径上每帧都要走的一行，见 BOTTOM_SCROLL_PX 的说明）。
  panelBody.scrollTop = BOTTOM_SCROLL_PX;
  return true;
}

/**
 * 标记"接下来这一小段窗口里的 scroll 事件是我们自己造成的"，供置底与改高度共用。
 *
 * 为什么需要它：内容变化会触发 `fitPanelHeight()` 重算 `.p-body` 高度，
 * 而**容器高度一变，浏览器就会自己夹紧 `scrollTop` 并派发 scroll 事件** ——
 * 那与"用户滚上去看历史"在事件层面无法区分，于是 `.p-body` 的 scroll 监听器
 * 会把自动跟随**永久**关掉（实测轨迹见 openPanel 里监听器处的注释）。
 * 屏蔽窗口取 300ms：既覆盖"布局变动引起的迟到事件"，又短到不会吞掉用户的操作。
 */
const SELF_SCROLL_MUTE_MS = 300;
let selfScrollMuteUntil = 0;
function markSelfScroll() {
  selfScrollMuteUntil = Date.now() + SELF_SCROLL_MUTE_MS;
}

// 用户自己的滚动意图（滚轮 / 触摸 / 拖滚动条 / 键盘）。
//
// 为什么必须单独记：`selfScrollMuteUntil` 是为了屏蔽"布局变化引起的 scroll 事件"，
// 但流式期间 `fitPanelHeight()` 每来一段内容就刷新它 —— 若只看时间窗口，
// 用户的真实滚轮会被一起吞掉，`observerAutoScroll` 永远保持 true，
// 下一次 `pinToBottom()` 就把视图拉回底部（实测缺陷）。
const USER_SCROLL_INTENT_MS = 900;
let userScrollIntentUntil = 0;
function markUserScrollIntent(up: any) {
  const now = Date.now();
  userScrollIntentUntil = now + USER_SCROLL_INTENT_MS;
  // 向上滚立刻暂停跟随：不能等 scroll 事件（它可能被流式布局的屏蔽窗口吞掉）。
  if (up === true) followedRun.observerAutoScroll = false;
}

/** 是否应该继续跟随底部。用户的向上滚动意图优先于"当前离底很近"的像素读数。 */
function isPinnedForFollow() {
  if (Date.now() < userScrollIntentUntil && followedRun.observerAutoScroll === false) return false;
  if (!panelBody) return false;
  return (
    !!followedRun.observerAutoScroll ||
    panelBody.scrollHeight - panelBody.scrollTop - panelBody.clientHeight < 40
  );
}

const screenshotView = new PanelScreenshotView({
  load: (id) => loadScreenshot(typeof chrome !== 'undefined' ? chrome : null, id),
  escape: escHtml,
  getPanel: () => panel,
  canRepaint: () => !runSession.isRunning && Boolean(panelBody),
  onRepaint: () => {
    try {
      renderConversation();
      fitPanelHeight();
      pinToBottom();
    } catch {}
  },
});

let layoutTimer: any = null;
let panelLayoutStorage: PanelLayoutStorage | null = null;
let panelLayoutWriteChain: Promise<unknown> = Promise.resolve();
let panelLayoutWriteWarned = false;
let panelOpenGeneration = 0;
let unsubscribePanelLayoutChanges: (() => void) | null = null;

// 节流持久化面板布局（避免拖拽/拉伸 mousemove 高频写入）。
function persistPanelLayoutThrottled() {
  if (layoutTimer || !panel) return;
  layoutTimer = setTimeout(() => { layoutTimer = null; persistPanelLayoutNow(); }, 200);
}

// 立即把当前面板布局写入 localStorage。
//
// ⚠ 判据**不再**是 `_manualPos || top !== 'auto'`：默认停靠面板的 `top` 就是 `auto`，
//   旧判据让「打开→关闭」这条路径从不落盘（实测：关闭后 localStorage 里没有 pos），
//   重开就只能用 CSS 停靠默认值或更早的旧值 —— 这正是用户报的「位置没保存」。
//   现在无条件记录：`docked` 记录停靠态，`manualPos` 决定 left/top 是像素还是 null。
//
// `opts.size === false`：只写位置。打开面板时用这个 —— 那一刻的高度是 `fitPanelHeight()`
// 刚算出来的**自动高度**，若连同它一起存，下次打开会被当成用户手动尺寸（`_manualSize`）
// 而不再随内容伸缩。尺寸仍由「关闭 / 拖拽 / 拉伸结束」三条路径记录。
function queuePanelLayoutWrite(snapshot: any): Promise<any> {
  if (!panelLayoutStorage) {
    try {
      return Promise.resolve(writePanelLayout(localStorage, snapshot));
    } catch (e: any) {
      return Promise.resolve(null);
    }
  }
  const write = panelLayoutWriteChain
    .catch(() => null)
    .then(() => saveGlobalPanelLayout(panelLayoutStorage, snapshot))
    .then((record: any) => {
      if (!record && !panelLayoutWriteWarned) {
        panelLayoutWriteWarned = true;
        try {
          console.warn('RecallFlow: 无法保存全浏览器面板布局，请检查扩展存储权限。');
        } catch (e: any) {}
      }
      return record;
    });
  panelLayoutWriteChain = write.catch(() => null);
  return write;
}

function persistPanelLayoutNow(opts?: any): Promise<any> {
  if (!panel) return Promise.resolve(null);
  // 面板脱离文档时 offset 全是 0：此时写盘会把用户存的尺寸覆盖成 0×0（见 resetDetachedHostState）。
  if (!panel.offsetWidth || !panel.offsetHeight) return Promise.resolve(null);
  const r = panel.getBoundingClientRect();
  const docked = panel.classList.contains('docked');
  const manualPos = docked ? Boolean(panel._manualPos) : true;
  // 停靠面板手动拖过之后，按「离哪条边更近」逐轴记录锚点：明显靠近右边记 right、
  // 明显靠近下边记 bottom，其余方向记 left / top。这样中间的会话面板换页后仍从左上角
  // 生长，不会因为内容变高而顶到右上；拖到右下角的面板则仍按右下角间距还原（换屏不漂）。
  // ⚠ 必须用布局视口（不含滚动条）反算：用 innerWidth 会把滚动条宽度算进间距，
  //   每开合一次就向左/上多漂一截。
  const vp = panelViewport();
  const anchored = docked && manualPos ? panelAnchoredOffsets(r, vp) : null;
  let left: number | undefined;
  let top: number | undefined;
  let right: number | undefined;
  let bottom: number | undefined;
  if (docked && manualPos) {
    // 只有**明显更靠近**右/下边时才按对应边锚定；中间大区域默认 left/top。
    // 阈值用「另一侧没有面板的路程」的 60% 做比较，等价于间距小于可移动路程的 37.5%：
    // 中间位置不会被判定成右下角，内容变高时继续向下生长，不会顶到右上。
    const gapRight = Math.max(0, vp.width - r.right);
    const gapBottom = Math.max(0, vp.height - r.bottom);
    const anchorRight = Boolean(anchored) && gapRight < Math.max(0, r.left) * 0.6;
    const anchorBottom = Boolean(anchored) && gapBottom < Math.max(0, r.top) * 0.6;
    if (anchorRight) right = anchored ? anchored.right : undefined;
    else left = r.left;
    if (anchorBottom) bottom = anchored ? anchored.bottom : undefined;
    else top = r.top;
  } else if (!docked) {
    // 浮动面板按划词点打开，保持左上角基准。
    left = r.left;
    top = r.top;
  }
  return queuePanelLayoutWrite({
    width: panel.offsetWidth,
    height: panel.offsetHeight,
    left,
    top,
    right,
    bottom,
    docked,
    // 浮动面板的 left/top 就是它的位置；停靠面板只有在用户拖动/拉伸过之后才算手动位置。
    manualPos,
    // 只拖动（没拉伸过）时不要把自动高度固化成用户尺寸；否则重开会把拖动瞬间的
    // 内容高度当成手动尺寸，内容一变面板顶部就跟着漂。
    writeSize: opts && opts.size === false ? false : panel._manualSize === true,
  });
}

/** 等本页最后一次布局写入完成，再从扩展存储读全局布局，避免关闭后立刻重开读到旧值。 */
function loadPanelLayoutForOpen(): Promise<any> {
  return panelLayoutWriteChain
    .catch(() => null)
    .then(() => {
      if (!panelLayoutStorage) return readPanelLayout(localStorage);
      return loadGlobalPanelLayout(panelLayoutStorage, localStorage);
    })
    .catch(() => readPanelLayout(localStorage));
}

function applyPanelPlacement(placement: any) {
  if (!panel) return;
  if (placement.docked) panel.classList.add('docked');
  else panel.classList.remove('docked');
  panel.style.right = placement.right == null ? 'auto' : placement.right + 'px';
  panel.style.bottom = placement.bottom == null ? 'auto' : placement.bottom + 'px';
  panel.style.left = placement.left == null ? 'auto' : placement.left + 'px';
  panel.style.top = placement.top == null ? 'auto' : placement.top + 'px';
  panel._manualPos = placement.manualPos;
}

/**
 * 把另一个标签页写入的全局布局实时应用到当前面板。
 *
 * 尺寸来自全局记录，位置仍按当前视口夹取；因此不同窗口尺寸下不会跑到屏幕外，
 * 但用户看到的宽高与布局模式保持一致。
 */
function applyGlobalPanelLayoutChange(value: unknown) {
  if (!panel) return;
  const layout = readGlobalPanelLayout(value);
  const viewport = panelViewport();
  const savedSize = clampPanelSize(layout as any, viewport);
  if (savedSize) {
    panel.style.width = savedSize.width + 'px';
    panel.style.height = savedSize.height + 'px';
    panel._manualSize = true;
    if (panelBody) {
      panelBody.style.flex = '1 1 auto';
      panelBody.style.height = 'auto';
      panelBody.style.overflowY = 'auto';
    }
  } else if (layout.docked === false && !layout.hasPos) {
    // 没有用户尺寸/位置时只有停靠态可同步；浮动气泡仍按自己的打开点摆放。
    panel.classList.remove('docked');
    panel._manualPos = false;
    return;
  }
  const placement = resolvePanelPlacement({
    layout,
    docked: layout.docked == null ? panel.classList.contains('docked') : layout.docked,
    viewport,
    size: { width: panel.offsetWidth, height: panel.offsetHeight },
    dockGap: getDockGap(),
  });
  applyPanelPlacement(placement);
}

function installPanelLayoutSync() {
  if (unsubscribePanelLayoutChanges) {
    try { unsubscribePanelLayoutChanges(); } catch (e: any) {}
    unsubscribePanelLayoutChanges = null;
  }
  const subscribe = panelLayoutStorage && panelLayoutStorage.onChanged;
  if (typeof subscribe !== 'function') return;
  unsubscribePanelLayoutChanges = subscribe.call(panelLayoutStorage, (changes) => {
    const change = changes && changes[PANEL_LAYOUT_STORAGE_KEY];
    if (!change || typeof change !== 'object' || !Object.prototype.hasOwnProperty.call(change, 'newValue')) return;
    // 本标签页正在拖拽/拉伸时不抢控制权；松手后的写入会成为新的全局布局。
    if (dragState || resizeState) return;
    applyGlobalPanelLayoutChange((change as any).newValue);
  });
}

// 面板越出可视区时夹回来：按各轴实际锚点（left/right、top/bottom）分别收窄。
// 重开后窗口变小、或开着时缩窗口都走这里。
function clampPanelToViewport() {
  if (!panel) return;
  if (!panel.offsetWidth || !panel.offsetHeight) return;
  const vp = panelViewport();
  const vw = vp.width;
  const vh = vp.height;
  const docked = panel.classList.contains('docked');
  if (docked && !panel._manualPos) {
    // 停靠面板的高度是用户尺寸，可能比"视口 - 底部留白"还高 —— 只有真的越界时才收窄留白，
    // 正常视口下保持原样（否则大屏上的上移观感会被抹掉）。
    const top = panel.getBoundingClientRect().top;
    if (top < 0) panel.style.bottom = Math.max(0, vh - panel.offsetHeight - 8) + 'px';
    return;
  }
  if (!panel._manualPos) return;
  const r = panel.getBoundingClientRect();
  // 逐轴夹取：right/bottom 锚定的轴按右/下边缘收窄，left/top 锚定的轴按左上角收窄；
  // 两者可以混合（例如 right + top），不要整块换算成 left/top。
  const rightAnchored = panel.style.right !== 'auto';
  const bottomAnchored = panel.style.bottom !== 'auto';
  if (rightAnchored || bottomAnchored) {
    const anchored = clampPanelAnchoredIntoView(r, { width: vw, height: vh });
    if (rightAnchored && panel.style.right !== anchored.right + 'px') panel.style.right = anchored.right + 'px';
    if (bottomAnchored && panel.style.bottom !== anchored.bottom + 'px') panel.style.bottom = anchored.bottom + 'px';
  }
  if (!rightAnchored || !bottomAnchored) {
    const next = clampPanelIntoView(
      { left: r.left, top: r.top, width: panel.offsetWidth, height: panel.offsetHeight },
      { width: vw, height: vh }
    );
    if (!rightAnchored && Math.round(next.left) !== Math.round(r.left)) panel.style.left = next.left + 'px';
    if (!bottomAnchored && Math.round(next.top) !== Math.round(r.top)) panel.style.top = next.top + 'px';
  }
}

// 若会话最后一条是含 <options> 的触底决策建议，渲染可点击方案按钮（防重复渲染）。
function renderDecisionButtonsIfPresent() {
  if (!panelBody || !panel) return;
  if (panelBody.querySelector('.suggestion-options')) return;
  const last = panelSessionState.conversation[panelSessionState.conversation.length - 1];
  if (last && last.role === 'assistant' && /<options>/i.test(String(last.content || ''))) {
    renderSuggestionButtons(panelBody, last.content, panel._sendFn || activeSendFn);
    fitPanelHeight();
  }
}

/** 按段状态刷新思考记录的标题（进行中 / 已思考 + 字数）。 */
function refreshThinkHead(seg: any) {
  if (!seg || !seg.block) return;
  const label = seg.block.querySelector('.think-label');
  if (!label) return;
  const text = thinkLabelText(seg.done === true, String(seg.text || '').length, seg.truncated === true);
  if (label.textContent !== text) label.textContent = text;
}

/**
 * 思考块的标记 HTML（**唯一来源**）。
 *
 * 为什么必须只有一处：这块标记有两条消费者 —— ① 流式挂载（mountThinkSegment）；
 * ② 面板重开时按 conversation 重建（renderConversation）。
 * 此前只有 ① 有标记，而 ② 的渲染分支里**根本没有 thinking** ⇒ 一轮结束后关掉面板再打开，
 * 所有思考记录整块消失（用户实测反馈：「关闭 recallflow 对话，再打开，思考历史消失了」。
 * 数据其实一直在 chrome.storage.session 里，是渲染分支漏了它）。
 * 现在两条路都从这里出；谁再写第二份标记，`tests/thinking-record.test.mjs` 会红。
 *
 * @param {string} text 思维链原文
 * @param {{open?: boolean, done?: boolean, truncated?: boolean}} [opts]
 *        `open` 不传 = 折叠（默认折叠与是否定稿无关）。
 */
function thinkBlockHtml(text: any, opts: any) {
  const o = opts || {};
  const body = String(text == null ? '' : text);
  return (
    '<div class="think-block" data-state="' + (o.done === true ? 'done' : 'running') + '" data-open="' + (o.open === true ? 'true' : 'false') + '">' +
      '<button type="button" class="think-head">' +
        '<span class="think-dots"><span></span><span></span><span></span></span>' +
        '<span class="think-label">' + escHtml(thinkLabelText(o.done === true, body.length, o.truncated === true)) + '</span>' +
        '<span class="think-caret" aria-hidden="true">▾</span>' +
      '</button>' +
      '<div class="think-body">' + escHtml(body) + '</div>' +
    '</div>'
  );
}

/**
 * 把一段思维链挂进对话流（**追加**到末尾）。
 *
 * 追加而不是插到最前：思考与它前后的叙述、工具步骤有时间对应关系 ——
 * 全部堆在最上面就看不出「这段思考是针对哪一步的」了。
 *
 * **默认折叠**（用户明确要求："思考中时应该折叠，用户自己根据需要展开"）：
 * 无论进行中还是已定稿，都只显示一条可点击的折叠条 —— 进行中是「思考中…」，
 * 定稿后是「已思考（N 字）」。点击展开后才看到全文。
 *
 * 标记本体在 `thinkBlockHtml`（唯一来源，历史重建那条路也用它）；
 * 开合**不在本函数挂监听** —— 统一委托给 panelBody 的 click 处理（见 openPanel）：
 * 重开面板时历史块是用 innerHTML 重建的、没有任何监听器，委托一处两条路都覆盖，
 * 也避免"两条路各挂一份 ⇒ 一次点击切换两次"。
 *
 * @param seg 段落对象（需要 text；block/body 会被填回来）
 * @param open 初始展开态。**只有**面板重建那条路径会传它（把用户之前的手动选择带回来）；
 *             其余调用一律不传 = 折叠。
 */
function mountThinkSegment(seg: any, open?: any) {
  if (!streamView.flowEl) return null;
  // 解析标记用 Range，而**不**建一个中间容器元素：
  // 单文件里"创建了元素却没挂载"正是 tests/static-checks.test.mjs 盯着的静默失效形态
  //（真实近失：按钮建好、事件也接好，就是忘了 append ⇒ 永远不出现）。
  // 这里确实只需要"把一段标记变成节点"，不需要一个装它的壳。
  const frag = document.createRange().createContextualFragment(
    thinkBlockHtml(seg.text, { open: open, done: seg.done, truncated: seg.truncated })
  );
  const block = frag.firstElementChild;
  if (!block) return null;
  seg.block = block;
  seg.body = block.querySelector('.think-body');
  refreshThinkHead(seg);
  // 追加到 flow **末尾**（穿插在对话里），而不是插到最前。
  streamView.flowEl.appendChild(block);
  return block;
}

/** 把已固化的叙述段 / 思考 / 工具步骤按原顺序渲染进给定 flow。 */
function renderCommittedParts(flow: any) {
  // `mountThinkSegment()` 往**模块级 flowEl** 追加；调用方可能刚建了一个新 flow，
  // 而关面板时 `removePanel()` 并不清空 flowEl，所以这里必须先指过去。
  streamView.flowEl = flow;
  for (const p of streamState.parts) {
    if (p.type === 'thinking' && p.text) {
      // 思考记录也是 flow 的一环，必须按原位置还原 ——
      // 否则重开面板后所有思考都会挤到最前面，与它前后步骤的对应关系就没了。
      mountThinkSegment({ text: p.text, done: true, block: null, body: null });
    } else if (p.type === 'narration' && p.text) {
      const d = document.createElement('div');
      d.className = 'agent-content';
      d.innerHTML = renderAnswer(p.text, streamView.currentCitations, false);
      flow.appendChild(d);
    } else if (p.type === 'tool-call') {
      flow.appendChild(
        toolStepElement('🔧 ', p.name, argHint(p.args), '参数', clipDetail(JSON.stringify(p.args || {}, null, 2), 2000))
      );
    } else if (p.type === 'tool-result') {
      flow.appendChild(
        toolStepElement(
          p.status === 'completed' ? '✓ 工具已完成：' : p.status === 'failed' ? '✗ 工具失败：' : '— 工具未执行：',
          p.name,
          '',
          p.status === 'failed' ? '错误信息' : '返回结果',
          clipDetail(p.result, 4000)
        )
      );
      const authEl = authChallengeElement(p.authChallenge);
      if (authEl) flow.appendChild(authEl);
    }
  }
}

function restoreStreamingUI() {
  if (!panelBody || !runSession.isRunning) return;
  if (streamView.pendingContentEl && streamView.pendingContentEl.isConnected) return; // 已恢复过
  const aiMsg = document.createElement('div');
  aiMsg.className = 'msg ai';
  const flow = document.createElement('div');
  flow.className = 'agent-flow';
  aiMsg.appendChild(flow);
  // 已固化的叙述段与工具步骤先渲染回 flow（顺序错误曾导致重开面板时思考块全部丢失）。
  renderCommittedParts(flow);
  const contentEl = document.createElement('div');
  contentEl.className = 'agent-content';
  if (streamState.narration) {
    contentEl.innerHTML = renderAnswer(streamState.narration, streamView.currentCitations, false);
  } else {
    contentEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  }
  flow.appendChild(contentEl);
  if (streamState.narration) showStreamingAnswer(contentEl, streamState.narration, streamView.currentCitations);
  panelBody.appendChild(aiMsg);
  streamView.pendingAiMsg = aiMsg;
  streamView.pendingContentEl = contentEl;
  // 流式中关闭过面板再打开：**进行中**的那段思考也要恢复（它的位置在所有已固化步骤之后、
  // 正文之前）。已定稿的段已由上面的 pendingParts 循环按原位置还原 ——
  // 它们的展开态回到默认（折叠）；而**进行中这一段**要把用户刚才的手动选择带回来，
  // 否则"重开面板"就等于替他改了一次选择。
  if (streamView.thinkSeg && streamView.thinkSeg.text) {
    streamView.thinkSeg.block = null;
    streamView.thinkSeg.body = null;
    mountThinkSegment(streamView.thinkSeg, streamView.thinkExpandedManual === true);
  }
  streamView.typingEl = streamState.narration ? null : contentEl;
  streamView.pendingAiMsg._raw = streamState.content;
  // 重开面板时把进度条也恢复上（保留原计时，不重置已用时）。
  if (progressController.el) {
    if (!progressController.startedAt) progressController.startedAt = Date.now();
    progressController.el.classList.add('on');
    progressController.render();
    if (!progressController.timer) progressController.timer = setInterval(() => progressController.render(), 1000);
  }
  // 注意：这里**不要**去动「■ 停止」/「发送」的按钮状态 ——
  // 本函数跑在 openPanel 里**早于**那两个按钮的创建（见 openPanel 中创建它们的注释），
  // 在这儿碰到的只会是上一个面板遗留的、已脱离文档的按钮。它们的初值由创建处以
  // `streaming` 为准（这样流式中重开也能一次就对）。
  fitPanelHeight();
  pinToBottom();
}

// 面板内短暂提示（如引用定位失败）。
function showCitationHint(text: any) {
  if (!panelBody) return;
  const hint = document.createElement('div');
  hint.style.cssText = 'color:#b45309;font-size:11px;margin:4px 0;padding:4px 6px;background:rgba(180,83,9,.08);border-radius:4px;';
  hint.textContent = text;
  panelBody.appendChild(hint);
  fitPanelHeight();
  setTimeout(() => { if (hint.parentNode) hint.parentNode.removeChild(hint); }, 5000);
}

/** 未配置 API Key 时常驻提示；配置后自动隐藏（storage.onChanged 会再次调用）。 */
function refreshApiKeyBanner() {
  if (!streamView.apiKeyBanner) return;
  getAISettings()
    .then((s) => {
      if (!streamView.apiKeyBanner) return;
      const missing = !String((s && s.apiKey) || '').trim();
      streamView.apiKeyBanner.style.display = missing ? 'flex' : 'none';
      fitPanelHeight();
    })
    .catch(() => {});
}

/** 关闭自动批准浮层；点击面板外、面板内其它区域或按 Esc 都走这里。 */
function closeApprovalPopover() {
  if (!streamView.approvalPopoverEl || streamView.approvalPopoverEl.hidden) return;
  streamView.approvalPopoverEl.hidden = true;
  if (panel) panel.classList.remove('approval-open');
  fitPanelHeight();
}

/**
 * 渲染工具审批条。抽出来是因为它有两个入口：
 *   ① 正常流式 tool-call 事件；② 刷新 reattach 后的快照（审批可能正等着用户点）。
 */
export function describeApprovalRequest(name: any, args: any, risk: any, allowSession: any) {
  return describeApprovalRequestView(name, args, risk, allowSession);
}

export function renderApprovalPrompt(box: any, conn: any, callId: any, name: any, args: any, risk: any, allowSession: any) {
  return renderApprovalPromptView(box, conn, callId, name, args, risk, allowSession, () => {
    fitPanelHeight();
    pinToBottom();
  });
}

// 当前面板的发送函数（openPanel 里绑定 run），供 renderSuggestionButtons 触发「继续」。
let activeSendFn: any = null;

// 解析触底建议中的「可选操作」，返回 [{label, desc}]（最多 4 条）。
// 把建议按钮渲染到 AI 回复下方；点击后以「继续上一任务」方式重发指令。
// sendFn 用于绑定「所属面板」的发送函数。
function renderSuggestionButtons(container: any, text: any, sendFn: any) {
  const options = parseSuggestionOptions(text);
  if (!options.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'suggestion-options';
  const title = document.createElement('div');
  title.className = 'suggestion-title';
  title.textContent = '可选择继续方式：';
  wrap.appendChild(title);
  options.forEach((opt) => {
    const b = document.createElement('button');
    b.className = 'suggestion-option';
    b.textContent = opt.label;
    if (opt.desc) b.title = opt.desc;
    b.addEventListener('click', () => {
      if (runSession.isRunning) return;
      const fn = sendFn || activeSendFn;
      if (typeof fn === 'function') {
        fn(opt.label + (opt.desc ? '：' + opt.desc : ''), { continuation: true });
      }
    });
    wrap.appendChild(b);
  });
  container.appendChild(wrap);
}

function citeSourcesHtml(cites: any) {
  if (!cites || !cites.length) return '';
  return (
    '<div class="cite-sources"><span class="cite-label">参考来源：</span>' +
    cites
      .map(
        (c: any) =>
          '<button class="cite-badge" data-cite-id="' + escAttr(c.id || '') + '" data-cite-source="' + escAttr(c.source || 'kb') + '" data-cite-url="' + escAttr(c.url || '') + '" data-cite-snippet="' + escAttr(c.snippet || '') + '" title="打开证据：' + escAttr(c.title) + '">' +
          '<span class="cite-idx">[' + c.index + ']</span>' + escAttr(c.title.length > 18 ? c.title.slice(0, 18) + '…' : c.title) + '</button>'
      )
      .join('') +
    '</div>'
  );
}

function escAttr(s: any) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// 已定稿段落的 Markdown 解析结果。跟随页每 40ms 重建 live 消息，
// 若不缓存，旧段落会被反复解析（长回答下是超线性成本）。
const ANSWER_HTML_CACHE_MAX = 240;
const answerHtmlCache = createLruCache(ANSWER_HTML_CACHE_MAX);
function cachedAnswerHtml(text: any, citations: any) {
  const list = Array.isArray(citations) ? citations : [];
  const sig = list.map((c) => String(c.index) + '|' + String(c.title || '') + '|' + String(c.url || '')).join(',');
  const key = String(text) + '\u0000' + sig;
  const cached = answerHtmlCache.get(key);
  if (cached !== undefined) return cached;
  const html = renderAnswer(text, citations, false);
  answerHtmlCache.set(key, html);
  return html;
}

// 流式游标必须是一个**持久 DOM 节点**。
//
// 以前把 `<span class="stream-cursor">` 拼进 Markdown 生成的 HTML，然后每批增量都
// `innerHTML = ...`。文字一变，游标节点就被销毁重建，CSS 动画也从 0 重新开始；
// 同步面板每 40ms 左右刷新一次，于是看起来像密集闪动。
//
// 现在正文照常重绘，但游标放在正文元素的**兄弟节点**上，只更新坐标、不重建。
const streamingCursors = new WeakMap();

/** 在对话流里新建一个正文块。`ensureTextEl` 与错误渲染共用（原先两份一样的代码）。 */
function makeContentEl(flow: any) {
  if (!flow) return null;
  const el = document.createElement('div');
  el.className = 'agent-content';
  flow.appendChild(el);
  return el;
}

/**
 * 把「这一轮失败了」写进对话流。导出以便直测（它此前只被 E2E 间接碰过一次）。
 *
 * 钉住的是一条很容易写反的规则：**已经流出正文时，错误必须追加，不能覆盖**。
 * 原实现无条件 `pendingContentEl.textContent = errText`，于是在「回答读到一半时 API 报错」
 * 这种最常见的失败形态下，用户已经看完的那半截回答会**当场从屏幕上消失**，
 * 只剩一行红字；而它其实还留在 conversation 里，重开面板又会冒出来 —— 前后还不一致。
 *
 * @returns {Element|null} 写入错误的那个元素（拿不到对话流时返回 null）
 */
export function renderRunError(flow: any, contentEl: any, errText: any, hasPartial: any) {
  // 有半截回答 ⇒ 另起一块写在它后面；否则复用那块占位（它可能还停在「正在输入」的三个点上）。
  const el = hasPartial || !contentEl ? makeContentEl(flow) : contentEl;
  if (!el) return null;
  removeStreamCursor(el);
  el.textContent = String(errText === undefined || errText === null ? '' : errText);
  el.style.color = '#e74c3c';
  return el;
}

/** 「打开设置」按钮（缺少 API Key 时给用户的唯一出口）。导出以便直测点击后发的是什么消息。 */
export function buildOpenSettingsButton() {
  const go = document.createElement('button');
  go.textContent = '打开设置';
  go.style.cssText =
    'margin-left:8px;border:1px solid #4a90d9;color:#4a90d9;background:none;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px;';
  go.addEventListener('click', () => {
    try { chrome.runtime.sendMessage({ type: 'openOptions' }); } catch (e: any) {}
  });
  return go;
}

function removeStreamCursor(host: any) {
  const rec = host && streamingCursors.get(host);
  if (!rec) return;
  if (rec.cursor && rec.cursor.parentNode) rec.cursor.parentNode.removeChild(rec.cursor);
  streamingCursors.delete(host);
  cursorFlowCache.delete(host);
}

// 正文容器 -> 它的绝对定位包含块。
//
// 原实现**每帧**都沿祖先链逐个 `getComputedStyle` 往上爬，直到遇到非 static 的祖先；
// 而刚替换过 innerHTML 之后样式是脏的，第一次 `getComputedStyle` 会顺带触发一次样式重算。
// 包含块在一次流式渲染期间几乎不变，所以按容器缓存；容器脱离/被重建时（整轮重绘、
// removeStreamCursor）缓存自动失效。
const cursorFlowCache = new WeakMap();

/** 找到 host 的绝对定位包含块（拿不到时返回 null，调用方早退）。 */
function cursorContainingBlock(host: any) {
  const cached = cursorFlowCache.get(host);
  if (cached && cached.isConnected && cached.contains(host)) return cached;
  let flow = host && host.parentElement;
  // absolute 游标的坐标是相对“最近的已定位祖先”算的。发起页里这个祖先就是
  // .agent-flow；跟随页里正文先落在 .follow-live-tail 内，因此不能假设 parentElement
  // 就是包含块，否则 top 会整体偏移。向上找到真正的包含块再计算。
  while (flow && getComputedStyle(flow).position === 'static') flow = flow.parentElement;
  if (flow) cursorFlowCache.set(host, flow);
  return flow;
}

/**
 * root 子树里**文档序最后一个有实际内容的文本节点**。
 *
 * 原来是 `createTreeWalker(host, SHOW_TEXT)` 把整段正文的文本节点全部走一遍
 * （长正文下数百次 nextNode），而我们只要最后一个。倒着从最后一个子节点往里走
 * 是 O(树深)，命中顺序与 TreeWalker 的文档序完全一致 —— 因此游标位置不变，
 * 只是不再为找它而遍历整段正文。
 */
function lastNonNullTextNode(root: any): any {
  if (!root) return null;
  const children = root.childNodes;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (!child) continue;
    if (child.nodeType === 3) {
      if (child.nodeValue && /\S/.test(child.nodeValue)) return child;
      continue;
    }
    if (child.nodeType === 1) {
      const found = lastNonNullTextNode(child);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 把持久游标放到正文最后一个字符的右侧。
 *
 * 游标采用绝对定位，因此不参与正文布局；正文重排时只改 left/top。
 * 这样 Markdown 可以整段重渲染，而游标节点与它的 CSS 动画都保持不变。
 */
export function positionStreamCursor(host: any, cursor: any) {
  const flow = cursorContainingBlock(host);
  if (!flow || !cursor) return;
  let rect = null;
  try {
    const lastText = lastNonNullTextNode(host);
    if (lastText) {
      let end = lastText.nodeValue.length;
      while (end > 0 && /\s/.test(lastText.nodeValue.charAt(end - 1))) end -= 1;
      if (end > 0) {
        const range = document.createRange();
        range.setStart(lastText, end - 1);
        range.setEnd(lastText, end);
        rect = range.getBoundingClientRect();
      }
    }
  } catch (e: any) {
    rect = null;
  }
  const flowRect = flow.getBoundingClientRect();
  if (rect && (rect.width || rect.height)) {
    cursor.style.left = Math.max(0, rect.right - flowRect.left) + 'px';
    cursor.style.top = Math.max(0, rect.top - flowRect.top) + 'px';
  } else {
    const hostRect = host.getBoundingClientRect();
    cursor.style.left = Math.max(0, hostRect.left - flowRect.left) + 'px';
    cursor.style.top = Math.max(0, hostRect.bottom - flowRect.top - 13) + 'px';
  }
}

/**
 * 流式正文重绘的**自适应节流**。
 *
 * 背景（阶段1A 实测）：2,000 个小 chunk 的一条回答，SSE 只占 4 秒，
 * 主线程却被占掉 90% —— 每一帧都要把**累积全文**重新解析成 HTML、重建整棵子树、
 * 再重新算一遍样式与布局。帧越多，重复付出的尾巴越长。
 *
 * 这里做的是让"下一帧什么时候画"跟**上一帧画了多久**挂钩：上一次重绘花了 C 毫秒，
 * 就至少隔 C 毫秒再画下一次（上限 120ms，避免在弱机上直接退化成几秒才出一行）。
 * 短回答一帧只要几毫秒 ⇒ 间隔约等于 0 ⇒ 行为与逐帧渲染完全一致，不会回退首帧；
 * 长回答/密集小 chunk 才会自动放宽到几十毫秒一帧，把总工作量降下来。
 *
 * ⚠ 被跳过的帧**必须补**：流式可能在任何时刻停住（模型在思考、网络抖动），
 *   停住后就不再有 chunk 来排下一次绘制，最后几个字会一直悬在屏幕外。
 *   所以这里在决定跳过的同时挂一个兜底定时器，到点把它补画一次。
 */
const STREAM_PAINT_GAP_CAP_MS = 120;
let lastStreamPaintAt = 0;
let lastStreamPaintMs = 0;
let streamPaintTimer: any = null;

/** 结束一轮流式时清掉兜底定时器（收尾有自己的最终渲染，晚到的补画没有意义）。 */
export function cancelStreamPaintRetry() {
  if (streamPaintTimer) {
    clearTimeout(streamPaintTimer);
    streamPaintTimer = null;
  }
  lastStreamPaintAt = 0;
  lastStreamPaintMs = 0;
}

/**
 * 判断本次"正文重绘"是否该让位。
 * @returns {boolean} true = 本次不画（已安排补画），false = 现在就画
 */
function throttleStreamPaint(paint: any) {
  const now = Date.now();
  const gapMs = Math.min(STREAM_PAINT_GAP_CAP_MS, lastStreamPaintMs);
  if (!lastStreamPaintAt || now - lastStreamPaintAt >= gapMs) return false;
  if (!streamPaintTimer) {
    streamPaintTimer = setTimeout(
      () => {
        streamPaintTimer = null;
        streamRender.schedule('answer', paint);
      },
      Math.max(1, gapMs - (now - lastStreamPaintAt))
    );
  }
  return true;
}

/** 记一次完成的重绘，作为下一次间隔的依据。 */
function noteStreamPaint(startedAt: any) {
  const ended = Date.now();
  lastStreamPaintMs = ended - startedAt;
  lastStreamPaintAt = ended;
}

/** 流式更新正文，并复用同一个游标节点。 */
function showStreamingAnswer(host: any, text: any, citations: any) {
  if (!host) return;
  host.innerHTML = renderAnswer(text, citations, false);
  let rec = streamingCursors.get(host);
  if (!rec || !rec.cursor || !rec.cursor.isConnected) {
    const cursor = document.createElement('span');
    cursor.className = 'stream-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.dataset.streamCursor = 'stable';
    const parent = host.parentNode;
    if (!parent) return;
    parent.insertBefore(cursor, host.nextSibling);
    rec = { cursor };
    streamingCursors.set(host, rec);
  }
  rec.cursor.hidden = false;
  positionStreamCursor(host, rec.cursor);
}

/** 单个 part 的 HTML（整轮重绘与增量 part 节点共用）。 */
function partHtml(p: any, citations: any) {
  if (p.type === 'tool-call') {
    return toolStepHtml('🔧 ', p.name, argHint(p.args), '参数', clipDetail(JSON.stringify(p.args || {}, null, 2), 2000));
  }
  if (p.type === 'tool-result') {
    const html = toolStepHtml(
      p.status === 'completed' ? '✓ 工具已完成：' : p.status === 'failed' ? '✗ 工具失败：' : '— 工具未执行：',
      p.name,
      '',
      p.status === 'failed' ? '错误信息' : '返回结果',
      clipDetail(p.result, 4000)
    );
    return html + authChallengeHtml(p.authChallenge);
  }
  if (p.type === 'screenshot') return screenshotView.html(p);
  if (p.type === 'thinking' && p.text) {
    // 思考记录必须能在重开面板后重建；历史段按定稿态，live 段保持 run 动画。
    return thinkBlockHtml(p.text, { done: p.live !== true, truncated: p.textTruncated === true });
  }
  if ((p.type === 'narration' || p.type === 'text') && p.text) {
    // 游标由 streamingCursors 单独维护；整段 HTML 里不再放会随重绘重建的游标。
    return '<div class="agent-content">' + cachedAnswerHtml(p.text, citations) + '</div>';
  }
  if (p.type === 'notice' && p.text) {
    return '<div class="agent-step" style="color:' + escAttr(p.color || '#6b7280') + '">' + escHtml(p.text) + '</div>';
  }
  return '';
}

/** 单条 assistant 消息的 HTML。抽出来供“整轮重绘”与“只重绘 live 消息”共用。 */
function assistantMessageHtml(m: any, index: any, viewLength: any) {
  const parts = Array.isArray(m.parts) ? m.parts : [];
  const terminalNotices = parts.filter((p: any) => p && p.type === 'notice' && p.terminal === true && p.text);
  const flowHtml = parts
    .filter((p: any) => !(p && p.type === 'notice' && p.terminal === true))
    .map((p: any) => partHtml(p, m.citations))
    .join('');
  const hasInlineText = parts.some((p: any) => p.type === 'narration' || (p.type === 'text' && p.text));
  // 失败 / 中断的一轮**强制**渲染 content：它们的原因文字与「已中断」说明只放在 content 里
  //（不占一个 text part，否则导出侧会跳过「### 失败 / ### 中断」标题），
  // 而 hasInlineText 只统计 parts —— 一旦这一轮之前有过叙述，原因就会被整段藏起来。
  const rawContent = String(m.content || '');
  // 流式消息刚建立时 content/parts 都可能为空。此时 renderAnswer('') 会返回
  // `<p>（无内容）</p>`，把应该显示的 typing 动画顶掉 —— 同步窗口刚连上时
  // 就会短暂出现「（无内容）」。live 空消息必须留空，交给下面的 typing 占位。
  const contentHtml = hasInlineText && !m.failed && !m.interrupted
    ? ''
    : m.live && !rawContent
      ? ''
      : cachedAnswerHtml(rawContent, m.citations);
  // 失败保持红色、中断用琥珀色：否则刷新之后看起来像一条正常的 AI 回复。
  const failedStyle = m.failed ? ' style="color:#e74c3c"' : m.interrupted ? ' style="color:#b45309"' : '';
  const typingHtml = m.live && !flowHtml && !contentHtml ? '<span class="typing"><span></span><span></span><span></span></span>' : '';
  const sourceHtml = !m.live || m.showCitations ? citeSourcesHtml(m.citations) : '';
  const terminalHtml = terminalNotices
    .map((p: any) => '<div class="agent-step verify-final" style="color:' + escAttr(p.color || '#16a34a') + '">' + escHtml(p.text) + '</div>')
    .join('');
  return (
    '<div class="msg ai"' + failedStyle + '>' + '<div class="agent-flow">' + flowHtml + '</div>' +
    contentHtml +
    typingHtml +
    sourceHtml +
    terminalHtml +
    (m.content && !m.live ? msgActionsHtml(index === viewLength - 1) : '') +
    '</div>'
  );
}

function renderConversation() {
  if (!panelBody) return;
  followedRun.followedLiveReady = false;
  followedRun.followedDom = null;
  const view = followedRun.followedMessages.length ? panelSessionState.conversation.concat(followedRun.followedMessages) : panelSessionState.conversation;
  if (!view.length) {
    panelBody.className = 'p-body';
    panelBody.innerHTML = '<div class="msg ai">' + (lastText ? '输入指令，AI 将基于选中文本执行。' : '输入指令，AI 将直接执行（可基于知识库）。') + '</div>';
    renderPlan([]);
    return;
  }
  panelBody.className = 'p-body';
  panelBody.innerHTML = view
    .map((m: any, index: any) => {
      if (m.role === 'user') {
        return '<div class="user-turn"><div class="msg user">' + escHtml(m.content) + selectedTextMessageHtml(m.selectedText) + pickedSummaryHtml(m.pickedElements) + '</div>' + (m.live ? '' : userActionsHtml(index)) + '</div>';
      }
      return assistantMessageHtml(m, index, view.length);
    })
    .join('');
  // 执行计划不入消息正文，而是回填到输入框上方的计划条 —— 单一位置，避免
  // 「消息里一份、计划条里一份」在重开面板时重复显示。取最近一条带计划的助手消息。
  const withPlan = [...view].reverse().find((m) => m && m.role === 'assistant' && Array.isArray(m.plan) && m.plan.length);
  renderPlan(withPlan ? withPlan.plan : []);
  // 关联原始文本，供操作栏复制使用
  const aiEls = panelBody.querySelectorAll('.msg.ai');
  let aiIdx = 0;
  for (const m of view) {
    if (m.role === 'user') continue;
    if (aiEls[aiIdx]) aiEls[aiIdx]._raw = m.content || '';
    aiIdx++;
  }
}

function rebuildFollowedMessages() {
  followedRun.followedMessages = [];
  if (!followedRun.followedRunState) return;
  const instruction = String(followedRun.followedRunState.instruction || '').trim();
  const last = panelSessionState.conversation.length ? panelSessionState.conversation[panelSessionState.conversation.length - 1] : null;
  const alreadyHasUser =
    last && last.role === 'user' && String(last.content || '').trim() === instruction;
  if (instruction && !alreadyHasUser) {
    followedRun.followedMessages.push({ role: 'user', content: instruction, live: true });
  }
  const assistant = runStateToAssistantMessage(followedRun.followedRunState);
  if (assistant) followedRun.followedMessages.push(assistant);
}

function followedRunCommitted() {
  if (!followedRun.followedRunState) return false;
  const instruction = String(followedRun.followedRunState.instruction || '').trim();
  if (!instruction) return false;
  let userIndex = -1;
  for (let i = panelSessionState.conversation.length - 1; i >= 0; i--) {
    if (panelSessionState.conversation[i] && panelSessionState.conversation[i].role === 'user' && String(panelSessionState.conversation[i].content || '').trim() === instruction) {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return false;
  return panelSessionState.conversation.slice(userIndex + 1).some((m: any) => m && m.role === 'assistant' && !m.live);
}

/** 一条已定稿 part 的 DOM 节点（跟随页增量渲染用）。 */
function followedPartElement(part: any, citations: any) {
  if (!part) return null;
  const wrap = document.createElement('div');
  wrap.innerHTML = partHtml(part, citations);
  return wrap.firstElementChild;
}

function ensureFollowedDom() {
  if (followedRun.followedDom && followedRun.followedDom.aiEl && followedRun.followedDom.aiEl.isConnected && followedRun.followedDom.aiEl.parentNode === panelBody) {
    return followedRun.followedDom;
  }
  const instruction = String(followedRun.followedRunState.instruction || '').trim();
  const last = panelSessionState.conversation.length ? panelSessionState.conversation[panelSessionState.conversation.length - 1] : null;
  const alreadyHasUser = last && last.role === 'user' && String(last.content || '').trim() === instruction;
  if (!panelSessionState.conversation.length) panelBody.innerHTML = '';
  panelBody.querySelectorAll('.follow-live-user,.follow-live-ai').forEach((el: any) => el.remove());
  let userEl = null;
  if (instruction && !alreadyHasUser) {
    userEl = document.createElement('div');
    userEl.className = 'user-turn follow-live-user';
    userEl.innerHTML = '<div class="msg user">' + escHtml(instruction) + '</div>';
    panelBody.appendChild(userEl);
  }
  const aiEl = document.createElement('div');
  aiEl.className = 'msg ai follow-live-ai';
  const flowEl = document.createElement('div');
  flowEl.className = 'agent-flow';
  const committedEl = document.createElement('div');
  committedEl.className = 'follow-committed';
  const liveEl = document.createElement('div');
  liveEl.className = 'follow-live-tail';
  flowEl.appendChild(committedEl);
  flowEl.appendChild(liveEl);
  aiEl.appendChild(flowEl);
  panelBody.appendChild(aiEl);
  followedRun.followedDom = {
    userEl,
    aiEl,
    flowEl,
    committedEl,
    liveEl,
    renderedParts: 0,
    liveThink: null,
    liveTextEl: null,
    liveText: '',
    typingEl: null,
  };
  return followedRun.followedDom;
}

/**
 * 跟随页的增量渲染：历史只建一次；当前 live 消息也拆成
 * “已定稿容器 + 尾部思考/正文”，不再每帧替换整条消息。
 *
 * 这同时保证用户展开的思考块、工具详情不会被下一条 delta 重置。
 */
function renderFollowedLive() {
  if (!panelBody || !followedRun.followedRunState) return;
  if (!followedRun.followedLiveReady) {
    followedRun.followedMessages = [];
    renderConversation();
    followedRun.followedLiveReady = true;
    followedRun.followedDom = null;
  }
  const dom = ensureFollowedDom();
  const assistant = runStateToAssistantMessage(followedRun.followedRunState);
  if (!assistant) return;
  const parts = Array.isArray(assistant.parts) ? assistant.parts : [];
  const committedParts = parts.filter(
    (p) => !(p && p.type === 'thinking' && p.live) && !(p && p.type === 'narration' && p.live)
  );
  const liveThinking = parts.find((p) => p && p.type === 'thinking' && p.live);
  const liveNarration = parts.find((p) => p && p.type === 'narration' && p.live);

  for (let i = dom.renderedParts; i < committedParts.length; i++) {
    const part = committedParts[i];
    let el = null;
    // 思考刚定稿时，把正在显示的块搬到 committed 里（保留用户的展开状态），
    // 而不是销毁后按默认折叠重建。
    if (part.type === 'thinking' && dom.liveThink && part.text === dom.liveThink.text) {
      el = dom.liveThink.el;
      el.dataset.state = 'done';
      const label = el.querySelector('.think-label');
      if (label) label.textContent = thinkLabelText(true, String(part.text || '').length, part.textTruncated === true);
      dom.liveThink = null;
    } else if ((part.type === 'narration' || part.type === 'text') && dom.liveTextEl && part.text === dom.liveText) {
      el = dom.liveTextEl;
      removeStreamCursor(el);
      dom.liveTextEl = null;
      dom.liveText = '';
    } else {
      el = followedPartElement(part, assistant.citations);
    }
    if (el) dom.committedEl.appendChild(el);
  }
  dom.renderedParts = committedParts.length;

  if (liveThinking && liveThinking.text) {
    if (!dom.liveThink) {
      const wrap = document.createElement('div');
      wrap.innerHTML = thinkBlockHtml(liveThinking.text, { done: false });
      const el = wrap.firstElementChild;
      if (el) {
        dom.liveEl.appendChild(el);
        dom.liveThink = { el, text: liveThinking.text };
      }
    } else {
      dom.liveThink.text = liveThinking.text;
      const body = dom.liveThink.el.querySelector('.think-body');
      if (body) body.textContent = liveThinking.text;
      const label = dom.liveThink.el.querySelector('.think-label');
      if (label) label.textContent = thinkLabelText(false, liveThinking.text.length, false);
    }
  } else if (dom.liveThink) {
    dom.liveThink.el.remove();
    dom.liveThink = null;
  }

  if (liveNarration && liveNarration.text) {
    if (!dom.liveTextEl) {
      dom.liveTextEl = document.createElement('div');
      dom.liveTextEl.className = 'agent-content';
      dom.liveEl.appendChild(dom.liveTextEl);
    }
    if (dom.liveText !== liveNarration.text) {
      showStreamingAnswer(dom.liveTextEl, liveNarration.text, assistant.citations);
      dom.liveText = liveNarration.text;
    }
  } else if (dom.liveTextEl) {
    removeStreamCursor(dom.liveTextEl);
    dom.liveTextEl.remove();
    dom.liveTextEl = null;
    dom.liveText = '';
  }

  const hasLiveContent = Boolean(dom.liveThink || dom.liveTextEl);
  if (!hasLiveContent && !dom.typingEl) {
    dom.typingEl = document.createElement('div');
    dom.typingEl.className = 'agent-content';
    dom.typingEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    dom.liveEl.appendChild(dom.typingEl);
  } else if (hasLiveContent && dom.typingEl) {
    dom.typingEl.remove();
    dom.typingEl = null;
  }

  dom.aiEl._raw = assistant.content || '';
  renderPlan(Array.isArray(assistant.plan) ? assistant.plan : []);
  if (streamView.usageEl) streamView.usageEl.textContent = followedRun.followedRunState.tokens ? 'tokens ' + followedRun.followedRunState.tokens : '';
  fitPanelHeight();
  pinToBottom();
}

function renderFollowedRun() {
  if (!panelBody) return;
  streamRender.schedule('follow-live', () => {
    renderFollowedLive();
  });
  if (streamView.usageEl) streamView.usageEl.textContent = followedRun.followedRunState && followedRun.followedRunState.tokens ? 'tokens ' + followedRun.followedRunState.tokens : '';
  if (followedRun.followedRunState && followedRun.followedRunState.status === 'running') {
    if (progressController.el) {
      progressController.el.classList.add('on');
      progressController.startedAt = Number(followedRun.followedRunState.startedAt) || Date.now();
      progressController.state = stateLabel(followedRun.followedRunState.progress && followedRun.followedRunState.progress.state) || '跟随运行';
      progressController.step = Number(followedRun.followedRunState.progress && followedRun.followedRunState.progress.step) || 0;
      progressController.max = Number(followedRun.followedRunState.progress && followedRun.followedRunState.progress.max) || 0;
      if (!progressController.timer) progressController.timer = setInterval(() => progressController.render(), 1000);
      progressController.render();
    }
  }
  updateRunControlState();
  ensureFollowedRunWatch();
}

function ensureFollowedRunWatch() {
  if (followedRun.followStatusTimer) return;
  followedRun.followStatusTimer = setInterval(async () => {
    if (!followedRun.followedRunState) {
      clearInterval(followedRun.followStatusTimer);
      followedRun.followStatusTimer = null;
      return;
    }
    if (followedRun.followRefreshTimer) return;
    const sessionId = panelSessionState.panelSessionId;
    const res = await sendPanelMessage('panel:run:subscribe', { sessionId });
    if (sessionId !== panelSessionState.panelSessionId) return;
    if (res && res.ok && res.snapshot && res.snapshot.status === 'running') {
      followedRun.followedRunState = res.snapshot;
      followedRun.followedRunId = res.snapshot.runId;
      followedRun.followedCursor = Number(res.snapshot.cursor) || 0;
      rebuildFollowedMessages();
      renderFollowedRun();
      return;
    }
    // run 已结束，或 SW 已没有这个 run。结束广播可能在页面重载窗口里丢失，
    // 这里用轮询作为兜底；最终以落盘会话为准。
    scheduleFollowedRunRefresh();
  }, 1200);
}

function resetFollowedRun(options?: any) {
  const opts = options || {};
  if (followedRun.followRefreshTimer) {
    clearTimeout(followedRun.followRefreshTimer);
    followedRun.followRefreshTimer = null;
  }
  if (followedRun.followStatusTimer) {
    clearInterval(followedRun.followStatusTimer);
    followedRun.followStatusTimer = null;
  }
  followedRun.followedRunState = null;
  followedRun.followedRunId = '';
  followedRun.followedCursor = 0;
  followedRun.followedMessages = [];
  followedRun.followedLiveReady = false;
  followedRun.followedDom = null;
  if (!runSession.isRunning) {
    progressController.stop();
  }
  updateRunControlState();
  if (opts.render) {
    renderConversation();
    fitPanelHeight();
  }
}

function applyFollowedSnapshot(snapshot: any) {
  if (!snapshot || !snapshot.runId) {
    resetFollowedRun({ render: true });
    return;
  }
  if (snapshot.status !== 'running') {
    scheduleFollowedRunRefresh();
    return;
  }
  followedRun.followedRunState = snapshot;
  followedRun.followedRunId = snapshot.runId;
  followedRun.followedCursor = Number(snapshot.cursor) || 0;
  rebuildFollowedMessages();
  renderFollowedRun();
}

async function subscribePanelRun() {
  if (!panelSessionState.panelSessionId) return;
  const sessionId = panelSessionState.panelSessionId;
  const res = await sendPanelMessage('panel:run:subscribe', { sessionId });
  if (sessionId !== panelSessionState.panelSessionId) return;
  if (!res || !res.ok || res.selfOwned) {
    resetFollowedRun({ render: Boolean(followedRun.followedRunState) });
    return;
  }
  if (res.snapshot && res.snapshot.status === 'running') applyFollowedSnapshot(res.snapshot);
  else if (res.snapshot) resetFollowedRun({ render: Boolean(followedRun.followedRunState) });
  else if (followedRun.followedRunState) resetFollowedRun({ render: true });
}

function scheduleFollowedRunRefresh() {
  if (followedRun.followRefreshTimer) clearTimeout(followedRun.followRefreshTimer);
  let attempts = 0;
  const tick = async () => {
    attempts += 1;
    const sessionId = panelSessionState.panelSessionId;
    const got = await sendPanelMessage('panel:get', { id: sessionId });
    if (sessionId !== panelSessionState.panelSessionId) return;
    const instruction = String(followedRun.followedRunState && followedRun.followedRunState.instruction ? followedRun.followedRunState.instruction : '').trim();
    const messages = got && got.ok && got.session ? got.session.messages || [] : [];
    let userIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user' && String(messages[i].content || '').trim() === instruction) {
        userIndex = i;
        break;
      }
    }
    const hasCommittedTurn =
      userIndex >= 0 && messages.slice(userIndex + 1).some((m: any) => m && m.role === 'assistant');
    if (got && got.ok && got.session && (Number(got.session.seq) > panelSessionState.panelSessionSeq || hasCommittedTurn)) {
      resetFollowedRun();
      adoptPanelSession(got.session, { activeId: got.activeId || sessionId });
      subscribePanelRun().catch(() => {});
      return;
    }
    if (attempts < 6) {
      followedRun.followRefreshTimer = setTimeout(tick, 300);
    } else {
      resetFollowedRun({ render: true });
    }
  };
  followedRun.followRefreshTimer = setTimeout(tick, 250);
}

function handleRunStarted(msg: any) {
  if (!msg || String(msg.sessionId || '') !== panelSessionState.panelSessionId) return;
  subscribePanelRun().catch(() => {});
}

function handleRunDelta(msg: any) {
  if (!msg || String(msg.sessionId || '') !== panelSessionState.panelSessionId) return;
  if (!followedRun.followedRunState || String(msg.runId || '') !== followedRun.followedRunId) {
    subscribePanelRun().catch(() => {});
    return;
  }
  const cursor = Number(msg.cursor) || 0;
  if (cursor !== followedRun.followedCursor + 1) {
    subscribePanelRun().catch(() => {});
    return;
  }
  followedRun.followedCursor = cursor;
  applyRunEvent(followedRun.followedRunState, msg.event);
  renderFollowedRun();
  if (msg.event && (msg.event.type === 'end' || msg.event.type === 'error')) {
    scheduleFollowedRunRefresh();
  }
}

function renderPlan(plan: any) {
  streamView.lastPlan = Array.isArray(plan) ? plan : [];
  if (!streamView.planBar) return;
  if (!streamView.lastPlan.length) {
    streamView.planBar.style.display = 'none';
    streamView.planBar.innerHTML = '';
    streamView.planExpanded = null;
    return;
  }
  const total = streamView.lastPlan.length;
  const doneCount = streamView.lastPlan.filter((p: any) => p && p.status === 'done').length;
  const allDone = total > 0 && doneCount === total;
  const current = streamView.lastPlan.find((p: any) => p && p.status === 'in_progress') || streamView.lastPlan.find((p: any) => p && p.status !== 'done');
  // 「完成 ↔ 进行中」切换时回到默认收起状态；同一状态内的反复更新不动用户的选择
  // （否则用户展开后，任何一次计划更新都会把它收回去）。
  if (allDone !== streamView.planWasAllDone) streamView.planExpanded = null;
  streamView.planWasAllDone = allDone;
  // 默认收成一行。**不再用「限高 + 内层滚动条」处理步骤过多** ——
  // 那个方案会让计划条变成一个小滚动框，既难看又要二次滚动。
  // 现在改为「收一行 / 展开全部」：展开时不设高度上限，因此永远不会出现内层滚动条。
  const collapsed = streamView.planExpanded !== true;

  const items = streamView.lastPlan
    .map((p: any) => {
      const st = p.status === 'done' ? 'done' : p.status === 'in_progress' ? 'in_progress' : 'pending';
      const mark = st === 'done' ? '✓' : st === 'in_progress' ? '▶' : '○';
      return '<div class="agent-plan-item ' + st + '">' + mark + ' ' + escHtml(p.text || '') + '</div>';
    })
    .join('');
  // 收起时把「做了多少 + 正在做什么」都塞进那一行，信息量不因收起而丢失。
  const title = collapsed
    ? '执行计划 · ' +
      doneCount +
      '/' +
      total +
      (allDone ? ' 步已完成' : current ? ' · ▶ ' + String(current.text || '').slice(0, 40) : '') +
      '（点击展开）'
    : '执行计划 · ' + doneCount + '/' + total + '（点击收起）';
  streamView.planBar.classList.toggle('collapsed', collapsed);
  streamView.planBar.innerHTML =
    '<div class="agent-plan-title" role="button" tabindex="0" title="点击展开/折叠">' + escHtml(title) + '</div>' +
    '<div class="agent-plan-items">' +
    items +
    '</div>';
  streamView.planBar.style.display = '';
  fitPanelHeight();
  pinToBottom();
}
// ---- 结构化导出 ----
// 具体格式与理由见 lib/page/transcript.js（纯函数，便于单测）。
// 这里只负责把页面上的实时值喂进去，不再自己拼 markdown。

// 导出/交接用的消息列表：已入库的对话 + **正在进行中的这一轮**。
// 助手条目只在 'end' 收尾时入库，所以任务进行中直接读 conversation 只能拿到用户消息 ——
// 正在发生的叙述、工具步骤、已流出的答复全都不见。而「面板里正出问题、把现场交给外部 AI」
// 恰恰是这个功能最典型的使用时刻，交出去一个空包毫无意义。
function messagesForExport() {
  const list = Array.isArray(panelSessionState.conversation) ? panelSessionState.conversation.slice() : [];
  const partial = buildPartialTurn(streamState.parts, streamState.responseText);
  if (partial) list.push(partial);
  return list;
}

/**
 * 生成可导出的 markdown。
 *
 * 两档的理由（用户反馈"导出读不到完整信息"）：粘贴给另一个 AI 时上下文成本真实存在，
 * 所以默认档刻意截断工具结果；但**留档、排查、以及"前一个 AI 到底试过什么"**需要无损版本。
 * 一个按钮兼两用会让人猜不到，所以做成两档并各给一个按钮。
 *
 * @param {'brief'|'full'} [mode] 默认 brief（单条工具结果 500 字）；full 不截断
 */
function buildTranscriptMarkdown(mode: any) {
  return buildTranscript({
    title: document.title || '(无标题)',
    url: location.href,
    exportedAt: new Date().toLocaleString(),
    handoffId: handoffId || '',
    conversation: messagesForExport(),
    // ⚠ `maxResultLen` 是本模块**唯一**的裁剪点（用户与助手正文原样输出），
    // 所以给足上限就等于无损 —— 不要以为这里还有别的暗坑。
    ...(mode === 'full' ? { maxResultLen: 1e9 } : {}),
  });
}

function serializeConversation() {
  // 完整副本持久化到 IndexedDB；模型上下文由 agent.js 单独做 token 限制。
  // 不能再用导出口径的 20 条/2KB 裁剪来当存储策略。
  return serializeCompleteConversationMessages(panelSessionState.conversation);
}

function sendPanelMessage(type: any, payload?: any): Promise<any> {
  if (!isExtContextAlive()) {
    return Promise.resolve({ ok: false, error: '扩展已更新，请刷新页面后重试' });
  }
  return runtimePort.request(Object.assign({ type }, payload || {}));
}

function applyPanelSessionSummaries(state: any) {
  if (!state) return;
  if (Array.isArray(state.sessions)) panelSessionState.panelSessionList = state.sessions.slice();
  if (typeof state.activeId === 'string') panelSessionState.panelSessionActiveId = state.activeId;
  renderSessionButton();
  renderSessionMenu();
}

function mergePanelSessionSummary(session: any) {
  if (!session || !session.id) return;
  const summary = {
    id: session.id,
    title: session.title || '新会话',
    createdAt: Number(session.createdAt) || 0,
    updatedAt: Number(session.updatedAt) || 0,
    messageCount: Array.isArray(session.messages) ? session.messages.length : Number(session.messageCount) || 0,
    seq: Number(session.seq) || 0,
    origin: String(session.origin || ''),
    handoffId: String(session.handoffId || ''),
    lastRunId: String(session.lastRunId || ''),
    titleAuto: session.titleAuto !== false,
  };
  const old = panelSessionState.panelSessionList.find((s: any) => s.id === session.id);
  if (old) Object.assign(old, summary);
  else panelSessionState.panelSessionList.push(summary);
  panelSessionState.panelSessionList.sort((a: any, b: any) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  renderSessionButton();
  renderSessionMenu();
}

function renderSessionButton() {
  if (!panelSessionBtnEl) return;
  const current = panelSessionState.panelSessionList.find((s: any) => s.id === panelSessionState.panelSessionId);
  const count = panelSessionState.panelSessionList.length;
  panelSessionBtnEl.textContent = '🗂 会话' + (count ? ' ' + count : '');
  if (panelTitleEl) {
    const titleText = current && current.title ? current.title : 'RecallFlow';
    panelTitleEl.textContent = titleText;
    panelTitleEl.title = titleText;
  }
  const label = current
    ? '当前会话：' + current.title + '（' + count + ' 个会话，点击切换 / 新建）'
    : '会话列表（' + count + ' 个，点击切换 / 新建）';
  panelSessionBtnEl.title = label;
  panelSessionBtnEl.setAttribute('aria-label', label);
}

function closeSessionMenu() {
  panelSessionMenuOpen = false;
  if (panelSessionMenuEl) panelSessionMenuEl.hidden = true;
  if (panelSessionBtnEl) panelSessionBtnEl.setAttribute('aria-expanded', 'false');
}

function renderSessionMenu() {
  if (!panelSessionMenuEl) return;
  panelSessionMenuEl.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'session-menu-head';
  const label = document.createElement('span');
  label.textContent = '最近会话';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'session-menu-close';
  close.textContent = '✕';
  close.title = '关闭';
  close.addEventListener('click', closeSessionMenu);
  head.appendChild(label);
  head.appendChild(close);
  panelSessionMenuEl.appendChild(head);

  const list = document.createElement('div');
  list.className = 'session-list';
  if (!panelSessionState.panelSessionList.length) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = '还没有会话';
    list.appendChild(empty);
  }
  for (const session of panelSessionState.panelSessionList) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.setAttribute('data-session-id', session.id);
    if (session.id === panelSessionState.panelSessionId) item.classList.add('active');
    if (session.id === panelSessionState.panelSessionActiveId) item.classList.add('shared-active');
    if (session.locked) item.classList.add('running');

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'session-main';
    main.setAttribute('data-session-action', 'switch');
    main.setAttribute('data-session-id', session.id);
    main.title =
      session.title +
      '\n' +
      (session.origin || '') +
      '\n' +
      session.messageCount +
      ' 条消息 · 约 ' +
      (Number(session.tokenEstimate) || 0).toLocaleString() +
      ' tokens';
    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = (session.locked ? '● ' : '') + (session.title || '新会话');
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = sessionTimeText(session.updatedAt) + ' · ' + (Number(session.messageCount) || 0) + ' 条' +
      (session.id === panelSessionState.panelSessionActiveId ? ' · 浏览器当前' : '') +
      (session.storageWarning ? ' · 超 1M tokens' : '');
    main.appendChild(title);
    main.appendChild(meta);
    item.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'session-actions';
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.title = '重命名';
    rename.setAttribute('aria-label', '重命名会话');
    rename.textContent = '✎';
    rename.setAttribute('data-session-action', 'rename');
    rename.setAttribute('data-session-id', session.id);
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.title = '导出该会话为 Markdown';
    exportBtn.setAttribute('aria-label', '导出会话');
    exportBtn.textContent = '⤓';
    exportBtn.setAttribute('data-session-action', 'export');
    exportBtn.setAttribute('data-session-id', session.id);
    const del = document.createElement('button');
    del.type = 'button';
    del.title = '删除';
    del.setAttribute('aria-label', '删除会话');
    del.textContent = '🗑';
    del.setAttribute('data-session-action', 'delete');
    del.setAttribute('data-session-id', session.id);
    actions.appendChild(rename);
    actions.appendChild(exportBtn);
    actions.appendChild(del);
    item.appendChild(actions);
    list.appendChild(item);
  }
  panelSessionMenuEl.appendChild(list);

  const foot = document.createElement('button');
  foot.type = 'button';
  foot.className = 'session-new';
  foot.textContent = '＋ 新建会话';
  foot.addEventListener('click', () => {
    newPanelSession().catch(() => {});
  });
  panelSessionMenuEl.appendChild(foot);
}

async function refreshPanelSessionState() {
  const state = await sendPanelMessage('panel:state');
  if (state && state.ok) applyPanelSessionSummaries(state);
  return state;
}

function adoptPanelSession(session: any, options: any) {
  if (!session || !session.id) return false;
  const opts = options || {};
  // 只有真的换了会话才清掉用量标识：同一会话的回写刷新（save 冲突 / 跟随后接管落盘会话）
  // 也会走这里，那两次标识上的数字正是刚跑完那轮的总量，不能顺手清掉。
  if (panelSessionState.panelSessionId !== session.id) resetUsageChip();
  panelSessionState.panelSessionId = session.id;
  panelSessionState.panelSessionSeq = Number(session.seq) || 0;
  if (opts.activeId) panelSessionState.panelSessionActiveId = String(opts.activeId);
  panelSessionState.conversation = normalizeConversationDuplicates(Array.isArray(session.messages) ? session.messages : []);
  handoffId = normalizeHandoffId(session.handoffId || '') || loadHandoffId() || newHandoffId();
  try {
    localStorage.setItem(HANDOFF_ID_KEY, handoffId);
  } catch (e: any) {}
  mergePanelSessionSummary(Object.assign({}, session, { messageCount: panelSessionState.conversation.length, handoffId }));
  if (followedRun.followedRunState) {
    // 结束广播可能正好落在跟随页整页重载的窗口里。落盘消息是最终权威：
    // 当前指令之后已经有正式 assistant 消息时，立即撤掉 live 覆盖层并恢复输入。
    if (followedRunCommitted()) resetFollowedRun();
    else rebuildFollowedMessages();
  }
  if (panelBody && !runSession.isRunning) {
    renderConversation();
    renderHandoffChip();
    fitPanelHeight();
    pinToBottom();
  }
  renderSessionButton();
  if (panel && !runSession.isRunning) subscribePanelRun().catch(() => {});
  return true;
}

function saveConversation(options?: any) {
  const opts = options || {};
  const id = panelSessionState.panelSessionId;
  if (!id) return Promise.resolve({ ok: false, skipped: true });
  // 快照必须在调用当下取：流式/撤销连续触发时，队列里排着的是各自那一刻的内容。
  const messages = serializeConversation();
  const baseSeq = panelSessionState.panelSessionSeq;
  const runId = runSession.runId;
  const savedHandoffId = handoffId;
  panelSessionState.panelSessionSaveChain = panelSessionState.panelSessionSaveChain
    .catch(() => {})
    .then(async () => {
      const res = await sendPanelMessage('panel:save', {
        id,
        messages,
        baseSeq,
        allowShrink: opts.allowShrink === true,
        handoffId: savedHandoffId,
        lastRunId: runId,
        origin: location.href,
      });
      if (res && res.ok && res.session) {
        if (id === panelSessionState.panelSessionId) panelSessionState.panelSessionSeq = Number(res.session.seq) || panelSessionState.panelSessionSeq;
        mergePanelSessionSummary(res.session);
        if (Array.isArray(res.sessions)) panelSessionState.panelSessionList = res.sessions.slice();
        renderSessionButton();
        renderSessionMenu();
      } else if (res && (res.conflict || res.stale) && res.session) {
        // 旧标签页的回写不能覆盖完整会话；远端更新时也不覆盖当前未完成输出。
        // 空闲时切到存储里的版本，正在输出时保留当前 DOM，等结束后再同步。
        if (id === panelSessionState.panelSessionId && !runSession.isRunning) {
          adoptPanelSession(res.session, { activeId: res.activeId });
          showCitationHint(
            res.stale
              ? '检测到旧标签页的回写，已保留更完整的会话内容。'
              : '该会话已在其他标签页更新，已为你刷新到最新内容。'
          );
        }
      }
      return res;
    });
  return panelSessionState.panelSessionSaveChain;
}

async function loadConversation() {
  try {
    const state = await sendPanelMessage('panel:state');
    if (state && state.ok) applyPanelSessionSummaries(state);
    const target = (state && state.activeId) || (panelSessionState.panelSessionList[0] && panelSessionState.panelSessionList[0].id) || '';
    if (target) {
      const got = await sendPanelMessage('panel:get', { id: target });
      if (got && got.ok && got.session) {
        adoptPanelSession(got.session, { activeId: got.activeId || target });
        return;
      }
    }
    // 索引存在但正文缺失，或首次启动时后台不可用：再尝试建一个本地空会话。
    const created = await sendPanelMessage('panel:create', { handoffId: newHandoffId() });
    if (created && created.ok && created.session) {
      adoptPanelSession(created.session, { activeId: created.activeId });
    }
  } catch (e: any) {
  } finally {
    conversationLoaded = true;
  }
}

function showPanelDialog(config: any) {
  if (!panel) return;
  const options = config || {};
  const old = panel.querySelector('.session-dialog-backdrop');
  if (old) old.remove();
  const previousFocus: any = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'session-dialog-backdrop';
  const box = document.createElement('div');
  box.className = 'session-dialog';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const dialogId = 'rf-panel-dialog-' + Date.now().toString(36);
  box.id = dialogId;
  box.setAttribute('aria-labelledby', dialogId + '-title');
  const title = document.createElement('div');
  title.className = 'session-dialog-title';
  title.id = dialogId + '-title';
  title.textContent = options.title || '会话';
  const message = document.createElement('div');
  message.className = 'session-dialog-message';
  message.textContent = options.message || '';
  box.appendChild(title);
  box.appendChild(message);
  let input = null;
  if (options.input) {
    input = document.createElement('input');
    input.className = 'session-dialog-input';
    input.type = 'text';
    input.maxLength = 60;
    input.value = String(options.value || '');
    input.placeholder = options.placeholder || '';
    box.appendChild(input);
  }
  const actions = document.createElement('div');
  actions.className = 'session-dialog-actions';
  const extra = options.extraText
    ? (() => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'session-dialog-extra';
        b.textContent = options.extraText;
        b.addEventListener('click', () => {
          close();
          try {
            if (options.onExtra) options.onExtra();
          } catch (e: any) {}
        });
        return b;
      })()
    : null;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = options.cancelText || '取消';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = options.danger ? 'danger' : 'primary';
  ok.textContent = options.confirmText || '确定';
  const close = () => {
    document.removeEventListener('keydown', onDialogKey, true);
    try {
      backdrop.remove();
    } catch (e: any) {}
    if (previousFocus && previousFocus.isConnected) {
      try { previousFocus.focus(); } catch (e: any) {}
    }
  };
  const onDialogKey = (e: any) => {
    if (!backdrop.isConnected) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable: any[] = [...box.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!box.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  cancel.addEventListener('click', close);
  const submit = async () => {
    const value = input ? input.value.trim() : '';
    if (input && !value) {
      input.focus();
      return;
    }
    ok.disabled = true;
    cancel.disabled = true;
    try {
      const keep = await options.onConfirm?.(value);
      if (keep !== false) close();
    } catch (e: any) {
      message.textContent = e && e.message ? e.message : String(e);
    } finally {
      ok.disabled = false;
      cancel.disabled = false;
    }
  };
  ok.addEventListener('click', () => void submit());
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
  }
  if (extra) actions.appendChild(extra);
  actions.appendChild(cancel);
  actions.appendChild(ok);
  box.appendChild(actions);
  backdrop.appendChild(box);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  panel.appendChild(backdrop);
  document.addEventListener('keydown', onDialogKey, true);
  setTimeout(() => {
    if (input) {
      input.focus();
      input.select();
    } else {
      ok.focus();
    }
  }, 0);
  return { close };
}

async function switchPanelSession(id: any, options?: any) {
  const opts = options || {};
  const wanted = String(id || '');
  if (!wanted) return false;
  if (runSession.isRunning) {
    showCitationHint('当前任务还在运行，结束后才能切换会话。');
    return false;
  }
  if (wanted === panelSessionState.panelSessionId && !opts.force) {
    closeSessionMenu();
    return true;
  }
  if (panelSessionState.panelSessionSwitchInFlight) return false;
  panelSessionState.panelSessionSwitchInFlight = true;
  try {
    let res;
    if (opts.activate === false) {
      res = await sendPanelMessage('panel:get', { id: wanted });
    } else {
      res = await sendPanelMessage('panel:activate', { id: wanted });
    }
    if (!res || !res.ok || !res.session) {
      showCitationHint((res && res.error) || '切换会话失败');
      return false;
    }
    adoptPanelSession(res.session, { activeId: res.activeId || wanted });
    if (Array.isArray(res.sessions)) panelSessionState.panelSessionList = res.sessions.slice();
    renderSessionButton();
    renderSessionMenu();
    closeSessionMenu();
    return true;
  } finally {
    panelSessionState.panelSessionSwitchInFlight = false;
    if (panelSessionState.deferredRemoteSessionId && !runSession.isRunning && panelSessionState.deferredRemoteSessionId !== panelSessionState.panelSessionId) {
      const next = panelSessionState.deferredRemoteSessionId;
      panelSessionState.deferredRemoteSessionId = '';
      setTimeout(() => {
        switchPanelSession(next, { activate: false, force: true }).catch(() => {});
      }, 0);
    }
  }
}

async function newPanelSession() {
  if (runSession.isRunning) {
    showCitationHint('当前任务还在运行，结束后才能新建会话。');
    return false;
  }
  closeSessionMenu();
  const res = await sendPanelMessage('panel:create', {
    handoffId: newHandoffId(),
    origin: location.href,
  });
  if (!res || !res.ok || !res.session) {
    showCitationHint((res && res.error) || '新建会话失败');
    return false;
  }
  adoptPanelSession(res.session, { activeId: res.activeId });
  if (Array.isArray(res.sessions)) panelSessionState.panelSessionList = res.sessions.slice();
  renderSessionButton();
  renderSessionMenu();
  closeSessionMenu();
  if (panelBody) {
    renderConversation();
    fitPanelHeight();
    pinToBottom();
  }
  return true;
}

function renamePanelSession(id: any) {
  const session = panelSessionState.panelSessionList.find((s: any) => s.id === id);
  if (!session) return;
  showPanelDialog({
    title: '重命名会话',
    message: '名称只影响会话列表，不会改动对话内容。',
    input: true,
    value: session.title,
    placeholder: '例如：GitHub 搜索调研',
    confirmText: '保存',
    onConfirm: async (title: any) => {
      const res = await sendPanelMessage('panel:rename', { id, title });
      if (!res || !res.ok) {
        showCitationHint((res && res.error) || '重命名失败');
        return false;
      }
      if (Array.isArray(res.sessions)) panelSessionState.panelSessionList = res.sessions.slice();
      if (id === panelSessionState.panelSessionId && res.session) {
        panelSessionState.panelSessionSeq = Number(res.session.seq) || panelSessionState.panelSessionSeq;
      }
      renderSessionButton();
      renderSessionMenu();
      return true;
    },
  });
}

function deletePanelSession(id: any) {
  const session = panelSessionState.panelSessionList.find((s: any) => s.id === id);
  if (!session) return;
  showPanelDialog({
    title: '删除会话',
    message: '将永久删除「' + session.title + '」及其中的 ' + session.messageCount + ' 条消息。',
    confirmText: '删除',
    danger: true,
    onConfirm: async () => {
      const res = await sendPanelMessage('panel:delete', { id });
      if (!res || !res.ok) {
        showCitationHint((res && res.error) || '删除失败');
        return false;
      }
      if (Array.isArray(res.sessions)) panelSessionState.panelSessionList = res.sessions.slice();
      if (id === panelSessionState.panelSessionId) {
        const nextId = res.activeId || (res.sessions && res.sessions[0] && res.sessions[0].id);
        if (nextId) await switchPanelSession(nextId, { force: true });
      } else {
        panelSessionState.panelSessionActiveId = res.activeId || panelSessionState.panelSessionActiveId;
        renderSessionButton();
        renderSessionMenu();
      }
      return true;
    },
  });
}

async function exportPanelSession(id: any, btn: any) {
  const session = panelSessionState.panelSessionList.find((s: any) => s.id === id);
  if (!session) return;
  const res = await sendPanelMessage('panel:get', { id });
  if (!res || !res.ok || !res.session) {
    showCitationHint((res && res.error) || '读取会话失败');
    return;
  }
  let text = '';
  try {
    text = buildTranscript({
      title: res.session.title || document.title || '(无标题)',
      url: res.session.origin || location.href,
      exportedAt: new Date().toLocaleString(),
      handoffId: res.session.handoffId || '',
      conversation: res.session.messages || [],
    });
  } catch (e: any) {}
  if (!text) {
    showCitationHint('该会话暂无可导出的内容。');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => (btn.textContent = old), 1200);
    } else {
      showCitationHint('已复制会话记录（' + text.length + ' 字）。');
    }
  } catch (e: any) {
    showCitationHint('复制失败，请检查剪贴板权限。');
  }
}

async function acquirePanelSessionLock(runId: any, takeover: any) {
  if (!panelSessionState.panelSessionId) return { ok: false, error: '会话尚未就绪' };
  const res = await sendPanelMessage('panel:lock', {
    id: panelSessionState.panelSessionId,
    runId,
    takeover: takeover === true,
  });
  if (res && res.ok) {
    panelSessionState.panelSessionLockHeld = true;
    panelSessionState.panelSessionLockRunId = runId;
    if (Array.isArray(res.sessions)) {
      panelSessionState.panelSessionList = res.sessions.slice();
      renderSessionMenu();
    }
  }
  return res || { ok: false, error: '运行锁获取失败' };
}

function releasePanelSessionLock() {
  if (!panelSessionState.panelSessionLockHeld || !panelSessionState.panelSessionLockRunId) return Promise.resolve();
  const id = panelSessionState.panelSessionId;
  const runId = panelSessionState.panelSessionLockRunId;
  panelSessionState.panelSessionLockHeld = false;
  panelSessionState.panelSessionLockRunId = '';
  return sendPanelMessage('panel:unlock', { id, runId });
}

function renewPanelSessionLock() {
  if (!panelSessionState.panelSessionLockHeld || !panelSessionState.panelSessionLockRunId) return;
  sendPanelMessage('panel:lock', {
    id: panelSessionState.panelSessionId,
    runId: panelSessionState.panelSessionLockRunId,
    takeover: false,
  }).then((res) => {
    if (res && res.locked && !res.ok) {
      panelSessionState.panelSessionLockHeld = false;
      showCitationHint('该会话已在另一个标签页接管，本页任务将停止。');
      runSession.requestStop();
    }
  }).catch(() => {});
}

async function handleRemotePanelSessions(state: any) {
  if (!state) return;
  applyPanelSessionSummaries(state);
  const nextActive = String(state.activeId || '');
  if (!nextActive) return;
  if (runSession.isRunning || panelSessionState.panelSessionSwitchInFlight) {
    if (nextActive !== panelSessionState.panelSessionId) panelSessionState.deferredRemoteSessionId = nextActive;
    return;
  }
  if (nextActive !== panelSessionState.panelSessionId) {
    await switchPanelSession(nextActive, { activate: false, force: true });
    return;
  }
  // 同一会话被其他标签页更新：空闲时同步正文。
  const current = panelSessionState.panelSessionList.find((s: any) => s.id === panelSessionState.panelSessionId);
  // 同一会话有新版本就拉正文。这里不能再要求 `oldActive === nextActive`：
  // 新标签页刚加载时 panelSessionActiveId 可能还是空串（旧值是 ''，nextActive 已是目标会话），
  // 那个条件会把“最终回复已落盘”的更新直接跳过，页面于是停在半截快照。
  if (current && Number(current.seq) > panelSessionState.panelSessionSeq) {
    await switchPanelSession(panelSessionState.panelSessionId, { activate: false, force: true });
  }
}

// 等待对话恢复完成。交接包必须等它 —— conversation 初值是空数组，
// 若在恢复完成前点标识芯片，快照会拿到空对话（实测出现过 messageCount: 0）。
function whenConversationReady() {
  if (conversationLoaded) return Promise.resolve();
  if (conversationLoadPromise) return conversationLoadPromise.catch(() => {});
  return Promise.resolve();
}

// ---- 交接标识（handoff）----

const HANDOFF_ID_KEY = 'recallflow-handoff-id';

function loadHandoffId() {
  try {
    return normalizeHandoffId(localStorage.getItem(HANDOFF_ID_KEY) || '');
  } catch (e: any) {
    return '';
  }
}

function ensureHandoffId() {
  if (!handoffId) handoffId = loadHandoffId() || newHandoffId();
  return handoffId;
}

function renderHandoffChip() {
  if (!handoffEl) return;
  const id = ensureHandoffId();
  handoffEl.textContent = '⧉ ' + id;
  handoffEl.title = '复制交接指令给 AI（会话标识 ' + id + '）：AI 可据此经 MCP 读取本次会话上下文';
}

/**
 * 把当前上下文写入交接包存储。
 * 内容刻意自包含：对话 + 页面 + 拾取元素 + **此刻**的控制台错误快照
 * （错误之后再查可能已消失，而它往往是定位问题的关键）。
 */
async function snapshotHandoff() {
  if (!isExtContextAlive()) return false;
  const id = ensureHandoffId();
  // 等对话恢复完成：否则 conversation 还是空数组，交接包会缺掉整段上下文。
  await whenConversationReady();
  let consoleEntries = [];
  try {
    // 用内容脚本入口共享出来的**同一个已打包实例**（见 entries/content.js）。
    // 此前这里是 `import(extUrl('lib/page/debug-capture.js'))` 现取模块 ——
    // 内容脚本打包成单文件后，那个 URL 不再指向可用模块，于是控制台快照会**静默缺失**。
    const dc = (window as any).__rfDebugCapture;
    if (dc && typeof dc.getDebugBuffer === 'function') {
      consoleEntries = await dc.getDebugBuffer('console');
    }
  } catch (e: any) {
    /* 取不到控制台快照不影响交接 */
  }
  let picked = Array.isArray(streamView.pickedElements) ? streamView.pickedElements : [];
  if (!picked.length) {
    try {
      const d: any = await new Promise((resolve) => {
        chrome.storage.local.get(['recallflow.lastPickedList'], (r) => resolve(r || {}));
      });
      picked = (d && d['recallflow.lastPickedList']) || [];
    } catch (e: any) {
      picked = [];
    }
  }
  let record;
  let trailItems = [];
  try {
    record = buildHandoffRecord({
      id,
      pageUrl: location.href,
      pageTitle: document.title,
      // ⚠ 这一句**必须**保持对 `messagesForExport()` 的直接调用：门禁
      //   `export-completeness-wiring`（「两条路径都走 messagesForExport」）就盯它
      messages: messagesForExport(),
      pickedElements: picked,
      selection: lastText,
      consoleEntries,
    });
    // ⚠ 全量轨迹必须**单独再算一遍**：`buildHandoffRecord` 只把**摘要**放进记录，
    //   全量那份算完就丢了 ✗ ⇒ 后台（入参就是这份 record）永远拿不到全量。
    //   多算一次导出的代价很小，换来的是"独立 key 真的存全量" ✓
    trailItems = prepareHandoffTrail(buildToolTrail(messagesForExport())).items;
  } catch (e: any) {
    return false;
  }
  // 返回是否真的落库：复制是同步的、保存是异步的，若用户刚复制就粘贴，
  // AI 可能还查不到这条记录。调用方据此在芯片上如实显示状态。
  return await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'handoff:save', record, trailItems }, (resp) => {
        resolve(!chrome.runtime.lastError && !(resp && resp.ok === false));
      });
    } catch (e: any) {
      resolve(false);
    }
  });
}

function openPanel(x: any, y: any, docked?: any, restore?: any): void | Promise<void> {
  if (!isExtContextAlive()) {
    warnExtDead();
    return;
  }
  removeBubble();
  removePanel({ publish: false, invalidateOpen: false });
  const openGeneration = ++panelOpenGeneration;
  if (fab) fab.classList.add('hidden');
  // 面板开着 ⇒ 气泡不收起（它此刻是 hidden，收起状态只会留下一闪而过的残影）。
  fabPeek.setPanelOpen(true);

  if (!panelLayoutStorage) {
    createPanelWithLayout(x, y, docked, restore, readPanelLayout(localStorage), openGeneration);
    return;
  }
  return loadPanelLayoutForOpen().then((layout) => {
    createPanelWithLayout(x, y, docked, restore, layout, openGeneration);
  });
}

function createPanelWithLayout(
  x: any,
  y: any,
  docked: any,
  restore: any,
  layout: any,
  openGeneration: number
) {
  // ⚠ 读档必须在 removePanel 之后：上一个面板关闭时刚把最新布局写进去。
  // 扩展存储写入是异步的，因此 loadPanelLayoutForOpen 会先排空本页写入队列。
  // 等待存储期间面板可能被关闭、远端同步关闭，或又被另一次打开请求取代。
  if (openGeneration !== panelOpenGeneration || !isExtContextAlive()) return;
  // 「停靠还是浮动」看**调用方意图**，存档只还位置与尺寸（评审退回项）：
  //   · FAB / Alt+Shift+R → docked=true，始终停靠；
  //   · 划词气泡 → docked=false，始终浮动；
  //   · `restore=true`（SPA 保活重挂 / 跨标签页同步 / run 恢复）→ 交给存档，还原关闭前的样子。
  // 反过来让存档盖住意图的话，「上次是气泡关的」之后 FAB 就再也不停靠了 —— 那是把模式改掉了。
  const dockedIntent = restore ? null : docked === true;

  panel = document.createElement('div');
  panel.className = 'panel' + (themeController.preferred() === 'dark' ? ' dark' : '');
  // 面板语义上是一个非模态对话框：声明角色，消息区用 aria-live 让流式输出可被读屏播报。
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', 'RecallFlow 浏览器助手');
  // 尺寸：恢复上次的宽高（夹在视口内）。停靠面板被自动高度撑大后，重开会把它当成
  // 用户尺寸（`_manualSize`）—— 这是既有语义，本次不改，但它意味着重开后
  // `fitPanelHeight()` 不再重算高度，所以下面摆放位置时用的是**恢复后的尺寸**。
  const savedSize = clampPanelSize(layout as any, panelViewport());
  if (savedSize) {
    panel.style.width = savedSize.width + 'px';
    panel.style.height = savedSize.height + 'px';
    panel._manualSize = true;
  }

  const head = document.createElement('div');
  head.className = 'p-head';
  const logo = document.createElement('img');
  logo.className = 'logo';
  logo.src = extUrl('docs/assets/recallflow-mark.svg');
  logo.alt = 'RecallFlow';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = 'RecallFlow';
  panelTitleEl = title;
  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '✕';
  close.setAttribute('aria-label', '关闭 RecallFlow');
  close.addEventListener('click', () => removePanel());
  const usageChip = document.createElement('span');
  usageChip.className = 'usage';
  streamView.usageEl = usageChip;
  // 会话入口：列表 + 新建，放在交接芯片旁。标题栏其余部分仍可拖动。
  panelSessionBtnEl = document.createElement('button');
  panelSessionBtnEl.type = 'button';
  panelSessionBtnEl.className = 'session-btn';
  panelSessionBtnEl.setAttribute('aria-haspopup', 'true');
  panelSessionBtnEl.setAttribute('aria-expanded', 'false');
  panelSessionBtnEl.setAttribute('aria-controls', 'rf-session-menu');
  renderSessionButton();
  panelSessionMenuEl = document.createElement('div');
  panelSessionMenuEl.id = 'rf-session-menu';
  panelSessionMenuEl.className = 'session-menu';
  panelSessionMenuEl.hidden = true;
  panelSessionMenuEl.setAttribute('role', 'menu');
  panelSessionBtnEl.addEventListener('click', async (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    panelSessionMenuOpen = !panelSessionMenuOpen;
    panelSessionMenuEl.hidden = !panelSessionMenuOpen;
    panelSessionBtnEl.setAttribute('aria-expanded', panelSessionMenuOpen ? 'true' : 'false');
    if (panelSessionMenuOpen) {
      renderSessionMenu();
      await refreshPanelSessionState();
      fitPanelHeight();
    }
  });
  panelSessionMenuEl.addEventListener('click', (e: any) => {
    const target = e.target.closest('[data-session-action]');
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const id = target.getAttribute('data-session-id') || '';
    const action = target.getAttribute('data-session-action');
    if (action === 'switch') switchPanelSession(id).catch(() => {});
    else if (action === 'rename') renamePanelSession(id);
    else if (action === 'delete') deletePanelSession(id);
    else if (action === 'export') exportPanelSession(id, target).catch(() => {});
  });
  panel.appendChild(panelSessionMenuEl);
  // 交接标识芯片：点击即复制一段可直接粘给 AI 的指令，并异步写入交接包快照。
  const handoffBtn = document.createElement('button');
  handoffBtn.className = 'handoff';
  handoffEl = handoffBtn;
  renderHandoffChip();
  handoffBtn.addEventListener('click', () => {
    const id = ensureHandoffId();
    const prompt = formatHandoffPrompt(id, { pageTitle: document.title });
    // 复制必须在用户手势内同步发起，因此不 await 后面的快照。
    const copied = navigator.clipboard.writeText(prompt).then(
      () => true,
      () => false
    );
    const saved = snapshotHandoff();
    Promise.all([copied, saved]).then(([okCopy, okSave]) => {
      // 明确区分「已复制」与「已落库」：只复制未保存时 AI 还查不到这条会话。
      handoffBtn.textContent = okCopy
        ? okSave
          ? '✓ 已复制并保存'
          : '⚠ 已复制·未保存'
        : '⚠ 复制失败';
      handoffBtn.classList.toggle('copied', Boolean(okCopy && okSave));
      setTimeout(() => {
        handoffBtn.textContent = '⧉ ' + id;
        handoffBtn.classList.remove('copied');
      }, 1800);
    });
  });
  // 主题切换：跟随系统 ↔ 深色 ↔ 浅色 循环（深色主题样式早已写好，此前从未被接上）。
  themeController.button = document.createElement('button');
  themeController.button.className = 'theme';
  themeController.button.addEventListener('click', () => themeController.cycle());
  themeController.apply();
  head.appendChild(logo);
  head.appendChild(title);
  head.appendChild(usageChip);
  head.appendChild(panelSessionBtnEl);
  head.appendChild(handoffBtn);
  head.appendChild(themeController.button);
  head.appendChild(close);
  panel.appendChild(head);
  shadow.addEventListener('mousedown', (e: any) => {
    if (panelSessionMenuOpen && !e.target.closest('.session-menu') && !e.target.closest('.session-btn')) {
      closeSessionMenu();
    }
  });

  // 进度条：显示「第几步 / 正在做什么 / 已用时」，长任务不再黑箱。
  progressController.el = document.createElement('div');
  progressController.el.className = 'p-progress';
  const ppDot = document.createElement('span');
  ppDot.className = 'pp-dot';
  progressController.messageEl = document.createElement('span');
  progressController.messageEl.className = 'pp-msg';
  progressController.timeEl = document.createElement('span');
  progressController.timeEl.className = 'pp-time';
  progressController.el.appendChild(ppDot);
  progressController.el.appendChild(progressController.messageEl);
  progressController.el.appendChild(progressController.timeEl);
  panel.appendChild(progressController.el);

  panelBody = document.createElement('div');
  resetPanelFitCache();
  panelBody.className = 'p-body';
  panelBody.setAttribute('role', 'log');
  panelBody.setAttribute('aria-live', 'polite');
  panelBody.setAttribute('aria-atomic', 'false');
  panelBody.setAttribute('aria-label', '对话内容');
  // 可聚焦：否则 PageUp/ArrowUp 等键盘滚动事件到不了这里的 keydown 监听器。
  panelBody.setAttribute('tabindex', '0');
  followedRun.observerAutoScroll = true;
  // ---- 自动跟随的判据只认「用户自己的滚动意图」----
  //
  // 为什么需要这层屏蔽（实测缺陷，用户反馈②"流式没有到最底下"的另一半）：
  //   `.p-body` 的高度由 `fitPanelHeight()` 反复重算（内容一变就重算），而**容器高度一变，
  //   浏览器就会自己夹紧/改动 `scrollTop` 并派发 scroll 事件**。这个事件与"用户滚上去看历史"
  //   不可区分，于是监听器按"距底 < 40px"重算 `observerAutoScroll` 时读到的是**变动中的布局**，
  //   一旦算出 >= 40 就把自动跟随**永久**关掉 —— 之后每次流式置底都被守卫跳过，视图不再跟手。
  //   实测轨迹（修复前，同一轮流式内）：
  //     SCROLL->oas=true  h=451 c=226 t=225
  //     SCROLL->oas=false h=502 c=199 t=255   ← 容器被压到 199，t 被夹紧
  //     SCROLL->oas=false h=621 c=199 t=129   ← 迟到的 scroll 事件，按"离底 293px"误判
  //   修法：**我们自己改布局/改 scrollTop 引起的事件不算用户意图**，屏蔽一个短窗口
  //   （`markSelfScroll()`）；窗口内用户真滚了也不丢 —— 之后的下一个事件就会正常更新
  //   （用户不会只滚 300ms 就停手）。
  const pbEl = panelBody;
  pbEl.addEventListener('scroll', () => {
    // 直接引用创建时的元素（不依赖可能被置空的模块变量 panelBody），彻底规避空指针。
    if (!pbEl) return;
    const now = Date.now();
    const userDriven = now < userScrollIntentUntil;
    if (!userDriven && now < selfScrollMuteUntil) return;
    // 连续拖动/滚轮期间持续续期，避免一次拖拽超过窗口后被流式布局事件重新接管。
    if (userDriven) userScrollIntentUntil = now + USER_SCROLL_INTENT_MS;
    // 距底部 < 40px 视为在底部（恢复自动跟随），否则用户在看历史（暂停跟随）。
    followedRun.observerAutoScroll = pbEl.scrollHeight - pbEl.scrollTop - pbEl.clientHeight < 40;
  });
  // 显式记录用户滚动意图：滚轮、触摸、拖动滚动条、键盘翻页。
  // 这些事件优先于「布局变化产生的 scroll 事件」的屏蔽窗口。
  pbEl.addEventListener('wheel', (e: any) => {
    markUserScrollIntent(Number(e.deltaY) < 0);
  }, { passive: true });
  let touchStartY: any = null;
  pbEl.addEventListener('touchstart', (e: any) => {
    const t = e.touches && e.touches[0];
    touchStartY = t ? t.clientY : null;
    markUserScrollIntent(false);
  }, { passive: true });
  pbEl.addEventListener('touchmove', (e: any) => {
    const t = e.touches && e.touches[0];
    if (t && touchStartY != null) markUserScrollIntent(t.clientY > touchStartY);
  }, { passive: true });
  pbEl.addEventListener('mousedown', (e: any) => {
    // 点在滚动条上时 target 就是容器本身；内容上的点击不算滚动意图。
    if (e.target === pbEl) markUserScrollIntent(false);
  });
  pbEl.addEventListener('keydown', (e: any) => {
    if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) markUserScrollIntent(true);
    else if (['PageDown', 'ArrowDown', 'End', ' '].includes(e.key)) markUserScrollIntent(false);
  });
  panelBody.addEventListener('click', (e: any) => {
    // 思考记录的开合：**委托**在这一层。
    // 两条路都要能用：实时挂载（mountThinkSegment）与重开面板后的历史重建
    //（renderConversation 用 innerHTML 生成，那种块**没有**自己的监听器）。
    const thinkHead = e.target.closest('.think-head');
    if (thinkHead) {
      const block = thinkHead.closest('.think-block');
      if (block) {
        // 开合会**改变内容高度**（展开一条思考最多能多出几百像素）：若本来贴着底，
        // 开合之后必须再贴一次底 —— 否则视图就停在离底 167px 的地方不动了
        //（实测：E2E 里"思考流式置底"那条断言因此时红时绿；真实使用里表现为
        //  "展开一条历史思考，面板莫名往上跳"）。
        // 只认"**本来**贴底"，与其它十几处同一条纪律：用户自己滚上去看历史时不打扰他。
        const wasPinned = isPinnedForFollow();
        const opening = block.dataset.open !== 'true';
        block.dataset.open = opening ? 'true' : 'false';
        // 只有「正在进行的这一段」需要记住用户的选择；历史段各自独立开合。
        if (streamView.thinkSeg && streamView.thinkSeg.block === block) streamView.thinkExpandedManual = opening;
        // 读 scrollHeight 会强制一次布局，因此这行看到的是**展开后**的真实高度。
        if (wasPinned && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      }
      return;
    }
    const rewind = e.target.closest('.act-rewind');
      if (rewind) {
        if (runSession.isRunning) return;
        const index = Number(rewind.getAttribute('data-turn-index'));
        if (Number.isInteger(index) && panelSessionState.conversation[index] && panelSessionState.conversation[index].role === 'user') {
          const undone = panelSessionState.conversation[index];
          panelSessionState.conversation = panelSessionState.conversation.slice(0, index);
          saveConversation({ allowShrink: true });
          renderConversation();
          fitPanelHeight();
          pinToBottom();
          // 撤销后将用户指令回填到输入框，方便修改后重发。
          if (undone && typeof undone.content === 'string') {
            cmdInput.value = undone.content;
            cmdInput.style.height = 'auto';
            cmdInput.style.height = Math.min(120, cmdInput.scrollHeight) + 'px';
            cmdInput.focus();
          }
        }
        return;
      }
    const userCopy = e.target.closest('.act-user-copy');
    if (userCopy) {
      const turn = userCopy.closest('.user-turn');
      const msgEl = turn && turn.querySelector('.msg.user');
      if (msgEl) navigator.clipboard.writeText(msgEl.textContent || '').then(() => {
        userCopy.textContent = '✓ 已复制';
        setTimeout(() => (userCopy.textContent = '⧉ 复制'), 1200);
      });
      return;
    }
    const actBtn = e.target.closest('.act-copy');
    if (actBtn) {
      const msgEl = actBtn.closest('.msg');
      const raw = msgEl && msgEl._raw;
      if (raw) {
        navigator.clipboard.writeText(raw).then(() => {
          actBtn.textContent = '✓ 已复制';
          setTimeout(() => (actBtn.textContent = '⧉ 复制'), 1200);
        });
      }
      return;
    }
    // 截图放大：data URL 直接内联展示，避免 window.open 弹窗拦截与 blob 生命周期问题。
    const shotImg = e.target.closest('.agent-shot img');
    if (shotImg) {
      screenshotView.openLightbox(shotImg.getAttribute('src') || '');
      return;
    }
    // 重新生成：截断到最后一条用户消息之前，用同一条指令再跑一次。
    const regen = e.target.closest('.act-regen');
    if (regen) {
      if (runSession.isRunning) return;
      let lastUser = -1;
      for (let i = panelSessionState.conversation.length - 1; i >= 0; i--) {
        if (panelSessionState.conversation[i] && panelSessionState.conversation[i].role === 'user') {
          lastUser = i;
          break;
        }
      }
      if (lastUser < 0) return;
      const instruction = String(panelSessionState.conversation[lastUser].content || '');
      if (!instruction) return;
      panelSessionState.conversation = panelSessionState.conversation.slice(0, lastUser);
      saveConversation({ allowShrink: true });
      renderConversation();
      run(instruction);
      fitPanelHeight();
      return;
    }
    const btn = e.target.closest('.code-copy');
    if (btn) {
      const wrap = btn.closest('.code-wrap');
      const codeEl = wrap && wrap.querySelector('code');
      if (!codeEl) return;
      navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '复制';
          btn.classList.remove('copied');
        }, 1200);
      });
      return;
    }
    // 引用徽章点击：同页→就地高亮证据片段；跨页→深链打开（浏览器原生文本高亮）。
    // 「能不能打开」的安全策略集中在 planCitationOpen（纯函数、有单测）里。
    const cite = e.target.closest('.cite-badge');
    if (cite) {
      const id = cite.getAttribute('data-cite-id');
      const url = cite.getAttribute('data-cite-url');
      const snippet = cite.getAttribute('data-cite-snippet') || '';
      const plan = planCitationOpen(url, location.href, snippet);
      if (plan.action === 'highlight') {
        // 同页：就地高亮证据片段，尽力多试几次（整段→缩短），不跳转。
        const found = findAndHighlightCitation(snippet)
          || (snippet.length > 80 ? findAndHighlightCitation(snippet.slice(0, 80)) : false)
          || (snippet.length > 200 ? findAndHighlightCitation(snippet.slice(0, 200)) : false);
        if (!found) showCitationHint('未能在当前页面定位该引用的证据文本（内容可能已变化或尚未加载）。');
      } else if (plan.action === 'open') {
        window.open(plan.target, '_blank', 'noopener');
      } else if (plan.action === 'deny') {
        showCitationHint(plan.reason || '该引用的链接不被允许打开。');
      } else if (id) {
        try { chrome.runtime.sendMessage({ type: 'openManager', focusId: id }); } catch (e: any) {}
      } else {
        showCitationHint('该引用没有可打开的链接。');
      }
    }
  });
  const approvalSettings = document.createElement('div');
  approvalSettings.className = 'approval-settings';
  approvalSettings.innerHTML =
    '<button class="approval-settings-toggle" type="button">自动批准：读取 <span>›</span></button>' +
    '<div class="approval-settings-popover" hidden>' +
      '<label class="approval-autopilot"><input data-autopilot type="checkbox"> <b>自动驾驶（全部自动批准）</b></label>' +
      '<div class="approval-settings-caption">未开启时，按下列类别逐项控制是否免确认：</div>' +
      '<div class="approval-group"><div class="approval-group-title">读取</div>' +
        '<label class="approval-item"><input data-policy="read" type="checkbox"> 读取内容 <small>搜索、读取页面、列出标签页</small></label>' +
      '</div>' +
      '<div class="approval-group"><div class="approval-group-title">写入</div>' +
        '<label class="approval-item"><input data-policy="edit" type="checkbox"> 编辑知识库 <small>新增 / 修改 / 删除收藏</small></label>' +
        '<label class="approval-item"><input data-policy="commands" type="checkbox"> 页面命令 <small>点击、输入、滚动、高亮、运行 JavaScript 等</small></label>' +
      '</div>' +
      '<div class="approval-group"><div class="approval-group-title">外部</div>' +
        '<label class="approval-item"><input data-policy="browser" type="checkbox"> 浏览器与网络 <small>打开标签页、抓取网页</small></label>' +
        '<label class="approval-item"><input data-policy="mcp" type="checkbox"> MCP 服务器 <small>调用外部工具</small></label>' +
      '</div>' +
    '</div>';
  streamView.approvalSettingsEl = approvalSettings;
  const autopilotEl: any = approvalSettings.querySelector('[data-autopilot]');
  autopilotEl.addEventListener('change', () => {
    const on = autopilotEl.checked;
    approvalSettings.querySelectorAll('[data-policy]').forEach((x: any) => {
      x.checked = on;
      x.dispatchEvent(new Event('change'));
    });
  });
  const approvalToggle: any = approvalSettings.querySelector('.approval-settings-toggle');
  const approvalPopover: any = approvalSettings.querySelector('.approval-settings-popover');
  streamView.approvalPopoverEl = approvalPopover;
  panel.addEventListener('click', (e: any) => {
    if (!approvalSettings.contains(e.target)) closeApprovalPopover();
  });
  const refreshApprovalLabel = () => {
    const names: Record<string, string> = { read: '读取', edit: '编辑', commands: '命令', browser: '浏览器', mcp: 'MCP' };
    const on = [...approvalSettings.querySelectorAll('[data-policy]:checked')].map((x: any) => names[x.dataset.policy]);
  approvalToggle.innerHTML = '自动批准：' + (on.length ? on.join('、') : '无') + ' <span>›</span>';
  };
  approvalToggle.addEventListener('click', () => {
    const opening = approvalPopover.hidden;
    approvalPopover.hidden = !opening;
    panel.classList.toggle('approval-open', opening);
    fitPanelHeight();
  });
  getAISettings().then((s) => { const p = s.toolApprovalPolicy || { read: true }; approvalSettings.querySelectorAll('[data-policy]').forEach((x: any) => { x.checked = (p as any)[x.dataset.policy] === true; x.addEventListener('change', async () => { const policy = Object.fromEntries([...approvalSettings.querySelectorAll('[data-policy]')].map((y: any) => [y.dataset.policy, y.checked])); try { await updateAISettings({ toolApprovalPolicy: policy }); } catch (e: any) { warnExtDead(); } autopilotEl.checked = ['read', 'edit', 'commands', 'browser', 'mcp'].every((k) => (policy as any)[k] === true); refreshApprovalLabel(); }); }); autopilotEl.checked = ['read', 'edit', 'commands', 'browser', 'mcp'].every((k) => (p as any)[k] === true); refreshApprovalLabel(); }).catch(() => {});

  // API Key 缺失提示常驻在输入区上方：用户一打开面板就能看到，不必先发一条消息。
  streamView.apiKeyBanner = document.createElement('div');
  streamView.apiKeyBanner.className = 'api-key-banner';
  streamView.apiKeyBanner.style.cssText =
    'display:none;margin:4px 0;padding:6px 8px;border:1px solid #f0c36d;background:#fff8e6;' +
    'border-radius:6px;color:#8a5a00;font-size:12px;align-items:center;gap:8px;justify-content:space-between;';
  const apiKeyText = document.createElement('span');
  apiKeyText.textContent = '尚未配置 API Key，配置后才能开始对话。';
  const apiKeySettingsBtn = document.createElement('button');
  apiKeySettingsBtn.type = 'button';
  apiKeySettingsBtn.className = 'api-key-settings';
  apiKeySettingsBtn.textContent = '打开设置';
  apiKeySettingsBtn.style.cssText =
    'border:1px solid #c98a00;color:#8a5a00;background:#fff;border-radius:5px;padding:2px 8px;cursor:pointer;font-size:12px;';
  apiKeySettingsBtn.addEventListener('click', () => {
    try { chrome.runtime.sendMessage({ type: 'openOptions' }); } catch (e: any) {}
  });
  streamView.apiKeyBanner.appendChild(apiKeyText);
  streamView.apiKeyBanner.appendChild(apiKeySettingsBtn);

  // 计划条元素在这里创建（必须在 renderConversation() 之前 —— 它会把最近一条带计划的
  // 助手消息回填进来），但**挂载点在对话区顶部**，见下面 panel.appendChild(planBar)。
  streamView.planBar = document.createElement('div');
  streamView.planBar.className = 'agent-plan agent-plan-bar';
  streamView.planBar.style.display = 'none';
  // 点标题可手动展开 / 折叠。全部步骤完成后会自动折叠成一行。
  streamView.planBar.addEventListener('click', (e: any) => {
    if (!e.target || !e.target.closest || !e.target.closest('.agent-plan-title')) return;
    // 当前是折叠态 → 用户要展开；当前是展开态 → 用户要折叠。
    streamView.planExpanded = streamView.planBar.classList.contains('collapsed');
    renderPlan(streamView.lastPlan);
  });

  renderConversation();
  // 流式中关闭过面板再打开：恢复正在生成的回复 UI（助手在后台继续输出）。
  restoreStreamingUI();
  // ⚠ 这里**先不要** fitPanelHeight / 置底：此刻 `panelBody` 还没进文档
  //   （插入在下面 `panel.appendChild(panelBody)` 那一行），任何尺寸读数都是 0。
  //   尺寸与置底统一挪到插入之后做 —— 见那边的说明。只留计划条回填。
  renderDecisionButtonsIfPresent();

  const cmdArea = document.createElement('div');
  cmdArea.className = 'cmd-area';
  // 执行计划放在**底部控件区的最上面一格**（快捷指令之上）。
  // 试过三个位置，各自的毛病：
  //   ① 助手消息开头 —— 对话一长就滚出视野，「还剩哪几步」恰恰要一直看得见；
  //   ② 对话区顶部（header 之下）—— 它压在**内容**上方，把对话整个推下去；
  //      计划是**过程**、对话是**内容**，让过程占内容区最顶上的版面本身就是错的；
  //   ③ 紧贴输入框（快捷指令之下）—— 那一格已经有 4 条，只有输入框真正属于「输入」。
  // 现在是 ④：底部控件区的**第一格**。它在对话之外（不压内容），又和用户操作的
  // 那一整块在一起（不在输入框旁边抢位置），视觉上就是「对话 / 执行状态 / 控件」三段。
  cmdArea.appendChild(streamView.planBar);
  const approvalArea = document.createElement('div');
  approvalArea.className = 'tool-approval';
  approvalArea.style.display = 'none';
  cmdArea.appendChild(approvalArea);
  const quickWrap = document.createElement('div');
  quickWrap.className = 'quick-prompts';
  cmdArea.appendChild(quickWrap);
  // 自动批准位于快捷指令下方、输入框上方，方便随时调整且不打断输入。
  cmdArea.appendChild(streamView.apiKeyBanner);
  cmdArea.appendChild(approvalSettings);
  refreshApiKeyBanner();
  const pickBar = document.createElement('div');
  pickBar.className = 'pick-bar';
  pickBar.style.display = 'none';
  cmdArea.appendChild(pickBar);
  const cmdWrap = document.createElement('div');
  cmdWrap.className = 'cmd-box';
  const cmdInput = document.createElement('textarea');
  // 记下引用供 `fitChromeSignature()` 用：textarea 的当前 value 不在 textContent 里，
  // 而它变高会改变 chrome 的高度（详见该变量声明处的说明）。
  panelCmdInput = cmdInput;
  cmdInput.className = 'cmd-input';
  cmdInput.rows = 1;
  cmdInput.placeholder = '输入指令后回车，如：翻译成中文 / 解释这段代码 / 优化并补全…';
  // 注意：赋值给**模块级** sendBtn（见文件顶部的说明），不加 const ——
  // 模块级的 restoreStreamingUI() 也要能读写它的 disabled 状态。
  sendBtn = document.createElement('button');
  sendBtn.className = 'cmd-send';
  sendBtn.textContent = '发送';
  // 流式中重开面板时它必须是禁用的（run() 起始与 endStream() 也各自维护这条状态）。
  sendBtn.disabled = runSession.isRunning;
  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.className = 'cmd-pick';
  // 鼠标指针图标（lucide mouse-pointer）；仅图标，文案移入 title/aria-label。
  pickBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px">' +
    '<path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/></svg>';
  pickBtn.title = '点击选择页面元素（可多选；↑↓ 选父/子元素；Esc 完成），把它和对应的前端源码位置一起发给 AI';
  pickBtn.setAttribute('aria-label', '选择页面元素');
  cmdWrap.appendChild(cmdInput);
  cmdWrap.appendChild(pickBtn);
  cmdWrap.appendChild(sendBtn);
  cmdArea.appendChild(cmdWrap);

  // 已选元素 chip（支持多个）+ 拾取模式开关。
  // 定位串交给 utils 的唯一实现（原先这里手写了一份，在"只有 name 没有 role"时会输出
  // 畸形的 `role=name="…"`，而"复制定位"按钮复制的正是它）。
  const locatorText = (p: any) => formatElementLocator(p && p.locator, p && p.selector, p && p.tag);
  const renderPick = () => {
    pickBar.innerHTML = '';
    if (!streamView.pickedElements.length) {
      pickBar.style.display = 'none';
      return;
    }
    pickBar.style.display = '';
    streamView.pickedElements.forEach((p: any, idx: any) => {
      const src = p.source || {};
      const loc = src.file ? src.file + (src.line ? ':' + src.line : '') : '';
      const chip = document.createElement('span');
      chip.className = 'pick-chip';
      const txt = document.createElement('span');
      txt.className = 'pick-chip-text';
      txt.textContent =
        (streamView.pickedElements.length > 1 ? idx + 1 + '. ' : '') +
        (p.tag || '') + (p.label ? '「' + p.label + '」' : '') +
        (loc ? ' → ' + loc : '');
      txt.title = locatorText(p);
      const copy = document.createElement('button');
      copy.className = 'pick-copy';
      copy.textContent = '⧉';
      copy.title = '复制定位：' + locatorText(p);
      copy.addEventListener('click', () => {
        const text = locatorText(p);
        navigator.clipboard.writeText(text).then(
          () => { copy.textContent = '✓'; setTimeout(() => (copy.textContent = '⧉'), 1000); },
          () => {}
        );
      });
      const clear = document.createElement('button');
      clear.className = 'pick-clear';
      clear.textContent = '✕';
      clear.title = '移除该元素';
      clear.addEventListener('click', () => {
        streamView.pickedElements.splice(idx, 1);
        renderPick();
      });
      chip.appendChild(txt);
      chip.appendChild(copy);
      chip.appendChild(clear);
      pickBar.appendChild(chip);
    });
    if (streamView.pickedElements.length > 1) {
      const clearAll = document.createElement('button');
      clearAll.className = 'pick-clear-all';
      clearAll.textContent = '清空';
      clearAll.addEventListener('click', () => {
        streamView.pickedElements = [];
        renderPick();
      });
      pickBar.appendChild(clearAll);
    }
    fitPanelHeight();
  };
  // 拾取通过后台广播到所有 frame（含跨域 iframe），结果由后台回传顶层。
  streamView.pickUi = {
    setActive: (on: any) => {
      streamView.picking = !!on;
      pickBtn.classList.toggle('active', !!on);
    },
    onPicked: (list: any) => {
      streamView.pickedElements = Array.isArray(list) ? list : list ? [list] : [];
      renderPick();
      cmdInput.focus();
    },
  };
  pickBtn.addEventListener('click', () => {
    if (streamView.picking) {
      try { chrome.runtime.sendMessage({ type: 'pick:cancel' }); } catch (e: any) {}
      streamView.pickUi.setActive(false);
      return;
    }
    streamView.pickUi.setActive(true);
    try {
      chrome.runtime.sendMessage({ type: 'pick:start' });
    } catch (e: any) {
      streamView.pickUi.setActive(false);
    }
  });
  renderPick();
  panel.appendChild(panelBody);
  panel.appendChild(cmdArea);
  syncPanelSelectionPreview();

  getAISettings().then((s) => {
    quickWrap.innerHTML = '';
    (s.quickPrompts || AI_SETTINGS_DEFAULTS.quickPrompts || []).slice(0, 12).forEach((prompt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'quick-prompt';
      b.textContent = prompt;
      b.addEventListener('click', () => {
        if (runSession.isRunning) return;
        run(expandQuickPrompt(prompt));
      });
      quickWrap.appendChild(b);
    });
    fitPanelHeight();
  }).catch(() => {});

  const foot = document.createElement('div');
  foot.className = 'p-foot';
  const clearBtn = document.createElement('button');
  clearBtn.className = 'new-session-btn';
  clearBtn.textContent = '＋ 新建会话';
  clearBtn.title = '保留当前对话并开启一个新会话';
  clearBtn.addEventListener('click', () => newPanelSession().catch(() => {}));
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = '导出记录';
  copyBtn.title = '导出为结构化 markdown（含角色分隔与工具明细），可直接交给 AI 或贴进工单；单条工具结果按 500 字截断以便粘贴';
  // 「完整」档单独一个按钮：留档与排查需要无损版本，而一个按钮兼两用会让人猜不到。
  const copyFullBtn = document.createElement('button');
  copyFullBtn.className = 'copy-btn';
  copyFullBtn.textContent = '导出完整';
  copyFullBtn.title = '同上，但**不截断**工具结果 —— 适合留档、排查、或让接手的 AI 看到前一个 AI 试过的全部步骤';
  /**
   * 把某一档导出发起复制，并在按钮上给即时反馈。
   * @param {HTMLButtonElement} btn 触发按钮（反馈写在它身上）
   * @param {'brief'|'full'} mode
   */
  const exportTranscript = (btn: any, mode: any) => {
    const label = btn.textContent;
    const restore = () => setTimeout(() => (btn.textContent = label), 1600);
    // 结构化导出：从对话数据模型生成，而不是 panelBody.textContent ——
    // 后者会掺入输入框 placeholder 与按钮文字（「↶ 撤销⧉ 复制」），且用户与 AI 无角色分隔。
    let text = '';
    try {
      text = buildTranscriptMarkdown(mode);
    } catch (e: any) {
      text = '';
    }
    if (!text) {
      btn.textContent = '暂无可导出的对话';
      restore();
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => {
        btn.textContent = '已复制 ' + text.length + ' 字';
        restore();
      },
      () => {
        btn.textContent = '复制失败';
        restore();
      }
    );
  };
  copyBtn.addEventListener('click', () => exportTranscript(copyBtn, 'brief'));
  copyFullBtn.addEventListener('click', () => exportTranscript(copyFullBtn, 'full'));
  stopBtn = document.createElement('button');
  stopBtn.className = 'stop-btn';
  stopBtn.textContent = '■ 停止';
  // 初值统一走 updateRunControlState：owner 的 streaming 与跟随页的
  // followedRunState 都可能让面板处在「运行中」，两边的停止按钮行为必须一致。
  updateRunControlState();
  stopBtn.addEventListener('click', interrupt);
  foot.appendChild(clearBtn);
  foot.appendChild(copyBtn);
  foot.appendChild(copyFullBtn);
  foot.appendChild(stopBtn);
  panel.appendChild(foot);

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'resize-handle bottom-right';
  const startResize = (e: any, origin: any) => {
    e.preventDefault();
    e.stopPropagation();
    panel._manualSize = true;
    // 拉伸统一转自由定位：固定当前 left/top，避免 docked 底部锚点（bottom）在拉伸中
    // 与 top 混合导致面板底部“复位/跳动”。之后用 left/top/width/height 精确定位并 clamp。
    panel._manualPos = true;
    const r = panel.getBoundingClientRect();
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = r.left + 'px';
    panel.style.top = r.top + 'px';
    resizeState = {
      startX: e.clientX,
      startY: e.clientY,
      origWidth: panel.offsetWidth,
      origHeight: panel.offsetHeight,
      origin,
    };
  };
  resizeHandle.addEventListener('mousedown', (e) => startResize(e, 'bottom-right'));
  panel.appendChild(resizeHandle);
  ['top-left','top','top-right','left','right','bottom-left','bottom'].forEach((origin) => { const h = document.createElement('div'); h.className = 'resize-handle ' + origin; h.addEventListener('mousedown', (e) => startResize(e, origin)); panel.appendChild(h); });

  shadow.appendChild(panel);

  // 摆放：**所有**打开路径都走同一条规则（以前只有 docked 分支读存档，划词气泡
  // 直接按鼠标点摆，于是「从气泡打开的面板位置和关掉时不一样」）。存档里有手动位置
  // 就用它，否则停靠默认位 / 鼠标点。
  const placement = resolvePanelPlacement({
    layout,
    docked: dockedIntent,
    point: { x, y },
    viewport: panelViewport(),
    size: { width: panel.offsetWidth, height: panel.offsetHeight },
    dockGap: getDockGap(),
  });
  applyPanelPlacement(placement);

  // 打开即落盘（只写位置，不写刚算出的自动高度）：
  // ① 用户拖过之后即使页面被 SPA 整棵换掉、扩展被重载、标签页崩溃，下次打开也回到原位；
  // ② 停靠面板的「自动停靠」也要有一条记录（left/top=null + docked=true），
  //    否则重开只能靠 CSS 默认值，窗口一变位置就跟着变。
  // ⚠ 这里**直接用 placement 的数值**，不回读 rect：宿主刚被 SPA 重挂时 rect 可能还是 0,0，
  //   回读会把刚恢复的位置就地写成 0,0（实测复现）。
  void queuePanelLayoutWrite({
    docked: placement.docked,
    manualPos: placement.manualPos,
    left: placement.left,
    top: placement.top,
    right: placement.right,
    bottom: placement.bottom,
    width: panel.offsetWidth,
    height: panel.offsetHeight,
    writeSize: false,
  });

  function endStream() {
    // 先丢弃仍在排队的流式渲染：下面的重置会把 pendingContentEl / pendingNarration
    // 清空，排队中的回调再去读它们已经没有意义；而 error 分支刚写好的错误文本
    // 也可能被一次晚到的流式重绘覆盖掉。放在这里是因为它是唯一的收尾出口。
    streamRender.cancel();
    // 连同"下一次补帧"的兜底定时器一起取消：收尾有自己的最终渲染，晚到的补画只会重复做一次。
    cancelStreamPaintRetry();
    const endedRunId = runSession.runId;
    const endedSessionId = panelSessionState.panelSessionId;
    runSession.finish();
    progressController.stop();
    updateRunControlState();
    streamView.pendingAiMsg = null;
    streamView.pendingContentEl = null;
    streamView.flowEl = null;
    streamState.reset();
    streamView.typingEl = null;
    // 刻意**不**清空计划条：它已固定在输入框上方，任务结束后保留最终状态，
    // 便于回头确认「哪几步做完了」。下一轮开始时才清掉（见 newRun 处）。
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    // 等本轮最后一次落盘完成再释放锁：否则另一标签页可能在保存前就接管，
    // 随后本页的迟到写入会把对方看到的内容覆盖掉。
    panelSessionState.panelSessionSaveChain
      .catch(() => null)
      .then(async (saved: any) => {
        await releasePanelSessionLock();
        // 正式消息确认写入共享会话后，才允许后台关闭本次 run 的辅助页。
        // 这解决了“repositories 页先被关，导致回答只存在于已销毁面板”的竞态。
        if (saved && saved.ok && endedRunId) {
          await sendPanelMessage('panel:run:committed', {
            runId: endedRunId,
            sessionId: endedSessionId,
          }).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!panelSessionState.deferredRemoteSessionId || runSession.isRunning) return;
        const next = panelSessionState.deferredRemoteSessionId;
        panelSessionState.deferredRemoteSessionId = '';
        if (next !== panelSessionState.panelSessionId) switchPanelSession(next, { activate: false, force: true }).catch(() => {});
      });
  }

  // 移除初始的“正在输入”占位元素，避免它残留在叙述/步骤之前。
  function removeTypingEl() {
    if (streamView.typingEl && streamView.typingEl.parentNode) {
      streamView.typingEl.parentNode.removeChild(streamView.typingEl);
      if (streamView.pendingContentEl === streamView.typingEl) streamView.pendingContentEl = null;
    }
    streamView.typingEl = null;
  }

  // 当前叙述段落对应的文本元素：每段一个 div，工具步骤插在段落之间。
  function ensureTextEl() {
    return makeContentEl(streamView.flowEl);
  }

  // ---- 思考记录 ----
  //
  // 思维链逐 token 到达。**每一段思考单独挂一块，追加到对话流末尾** ——
  // 于是它与前后的叙述、工具步骤自然按发生顺序穿插，而不是全堆在消息最上面。
  // 折叠状态是三态的（见模块顶部 thinkExpandedManual 的注释）。

  /** 收到一段思维链增量。 */
  function pushReasoning(text: any) {
    const piece = String(text || '');
    if (!piece) return;
    // 没有「进行中的段」就开一段新的 —— 定稿过的段已经置 null，因此新段必然另起一块。
    if (!streamView.thinkSeg || streamView.thinkSeg.done) {
      streamView.thinkSeg = { id: ++streamView.thinkSegSeq, text: '', done: false, block: null, body: null };
      streamView.thinkExpandedManual = null; // 新一段：用户还没表过态
      mountThinkSegment(streamView.thinkSeg);
    }
    const seg = streamView.thinkSeg;
    seg.text += piece;
    // ⚠ 这里**故意不写** seg.block.dataset.open：
    // 默认折叠由 mountThinkSegment 在挂载时决定；增量到达时若再写一次开合状态，
    // 就等于"新事件把用户手动展开/折叠的选择改回去" ✗（用户明确要求以他的选择为准）。
    // 折叠态下正文仍然照常累积进 seg.text 并写进 DOM，用户点开时看到的是完整全文。
    // 与正文共用同一合并器：逐 token 重绘会把长思维链的渲染成本变成超线性。
    //
    // ⚠ key **必须带段号**。合并器是按 key 去重的（同 key 只保留最后一次回调）——
    // 若所有段共用 'reason'，那么"下一段开始时的排入"会**顶掉上一段尚未执行的回调**，
    // 上一段的内容就永远写不进 DOM（实测症状：第一块思考记录是空的，而块数是对的）。
    // 这个 bug 单测看不出来（调度器本身没问题），只有真浏览器 + 两段思维链才暴露。
    streamRender.schedule('reason-' + seg.id, () => {
      if (seg.body) seg.body.textContent = seg.text;
      refreshThinkHead(seg);
      // ⚠ **思考过程也要流式置底**：段头（字数/预览）随 token 增长，面板高度一直在变，
      //   这里原先不调用置底 ⇒ 思考期间视图**不会**跟着走（用户反馈的现象）。
      //   与其它十几处路径一致：只有"用户自己滚上去了"（observerAutoScroll=false）才不打扰他。
      pinToBottom();
    });
  }

  /** 思考结束（回答开始 / 本轮结束 / 进入工具步骤时都要调）。 */
  function finishReasoning() {
    const seg = streamView.thinkSeg;
    if (!seg || seg.done) return;
    seg.done = true;
    if (seg.block) {
      seg.block.dataset.state = 'done';
      // 定稿只把状态从 running 改成 done —— **不动**用户的开合选择。
      // 这里的写是"兜底归位"（默认本就是折叠，等于空操作）；真正要守住的是**不覆盖用户的选择**：
      // 用户手动展开过（thinkExpandedManual === true）时一个字都不写。
      if (streamView.thinkExpandedManual === null) seg.block.dataset.open = 'false';
    }
    refreshThinkHead(seg);
    // flush 一次，确保收起前正文区已经写满 —— 否则会停在半截思维链上。
    // key 同样带段号：否则会顶掉 pushReasoning 排入的那次渲染。
    streamRender.schedule('reason-' + seg.id, () => {
      if (seg.body) seg.body.textContent = seg.text;
      refreshThinkHead(seg);
      // ⚠ **思考过程也要流式置底**：段头（字数/预览）随 token 增长，面板高度一直在变，
      //   这里原先不调用置底 ⇒ 思考期间视图**不会**跟着走（用户反馈的现象）。
      //   与其它十几处路径一致：只有"用户自己滚上去了"（observerAutoScroll=false）才不打扰他。
      pinToBottom();
    });
    // 记进 flow 记录：位置由 push 顺序天然决定，面板重建时据此还原到原来的位置。
    // 注意 transcript.js 只认 narration / text / tool-* / screenshot，
    // 因此思考记录**不会**进入导出给外部 AI 的交接文本（它是展示层，不是证据）。
    streamState.appendPart({ type: 'thinking', text: seg.text });
    // 关键：断掉「进行中的段」指针，下一段思考就会另起一块 —— 这是"穿插"的实现要点。
    streamView.thinkSeg = null;
  }

  /** 新一轮开始：清掉上一轮的思考记录指针（上一轮那几块留在历史里，不动）。 */
  function resetReasoning() {
    streamView.thinkSeg = null;
    streamView.thinkExpandedManual = null;
  }

  // 追加一个工具步骤卡片：先把已经流式输出的叙述段落固化成一条记录，
  // 再插入步骤，使后续叙述从新元素继续，形成“叙述 → 工具 → 叙述”的时间线。
  function appendStep(step: any) {
    removeTypingEl();
    // 进入工具步骤：本次思考到此为止（该轮答案可能没有正文，只有工具调用）。
    finishReasoning();
    if (streamState.narration) {
      const narration = streamState.flushNarration() || '';
      // 叙述段结束时用非流式模式重渲染，去掉末尾一直在闪烁的 stream-cursor。
      if (streamView.pendingContentEl) {
        removeStreamCursor(streamView.pendingContentEl);
        streamView.pendingContentEl.innerHTML = renderAnswer(narration, streamView.currentCitations, false);
      }
    }
    streamView.pendingContentEl = null;
    if (streamView.flowEl) streamView.flowEl.appendChild(step);
  }

  // 过程提示（意图、校验、限流等）原先只写 DOM，不进入 conversation.parts：
  // 发起页面板重开或跟随页切换到正式落盘消息时，这些步骤会凭空消失。
  // 这里统一“显示 + 入库”，确保即时与最终态一致。
  function appendNoticePart(text: any, color?: any, className?: any) {
    const value = String(text || '').trim();
    if (!value) return;
    const step = document.createElement('div');
    step.className = 'agent-step' + (className ? ' ' + className : '');
    if (color) step.style.color = color;
    step.textContent = value;
    appendStep(step);
    streamState.appendPart({ type: 'notice', text: value, color: color || '' });
  }

  function commitPendingVerifyPass() {
    streamState.commitVerifyPass();
  }

  /** 跟随页点「停止」：不碰 owner 的 port，向 SW 发一条按会话定向的停止请求。 */
  async function stopFollowedRun() {
    if (!followedRun.followedRunState || followedRun.followedRunState.status !== 'running' || followedRun.followedRunState.stopping) return;
    const runId = followedRun.followedRunId;
    followedRun.followedRunState.stopping = true;
    updateRunControlState();
    const res = await sendPanelMessage('panel:run:stop', { sessionId: panelSessionState.panelSessionId, runId });
    // 另一个标签页可能刚刚已经发出停止请求；这对当前页是等价结果，不该报成失败。
    if (res && (res.ok || res.code === 'already-stopping')) return;
    if (followedRun.followedRunId === runId && followedRun.followedRunState) {
      followedRun.followedRunState.stopping = false;
      updateRunControlState();
    }
    showCitationHint((res && res.error) || '停止失败：任务可能已经结束');
    scheduleFollowedRunRefresh();
  }

  async function interrupt(source: any) {
    if (!runSession.isRunning) {
      if (source === 'remote') return;
      await stopFollowedRun();
      return;
    }
    const remote = source === 'remote';
    // ⚠ 停止也是"这一轮的收尾"：**先把进行中的思考定稿**。
    // 否则这段思考只活在 DOM 里（pendingParts 里没有它），一关面板就没了 ——
    // 用户看到的现象正是「停止/中断过的那一轮，重开后思考消失」。
    finishReasoning();
    commitPendingVerifyPass();
    // 停止必须**显式**告诉后台中止 run：端口断开不再自动 abort（整页刷新也要靠它续跑，
    // 见 background.js 的 tabControllers 注释）。先发 stop 再断端口，保证顺序。
    if (!remote) {
      try {
        if (activeConn) activeConn.postMessage({ type: 'stop' });
      } catch (e: any) {}
    }
    const acc = streamState.content;
    closePort();
    if (streamView.pendingAiMsg && streamView.pendingAiMsg.parentNode) {
      lastResponse = streamState.responseText;
      if (acc) {
        if (streamView.pendingContentEl) {
          removeStreamCursor(streamView.pendingContentEl);
          streamView.pendingContentEl.innerHTML = renderAnswer(streamState.narration || lastResponse, streamView.currentCitations, false);
        }
        streamView.pendingAiMsg._raw = acc;
      } else if (!streamState.parts.length) {
        // 连一段思考都没收到：只在界面上说「已停止」，不往对话里塞一条空记录。
        if (streamView.pendingContentEl) {
          removeStreamCursor(streamView.pendingContentEl);
          streamView.pendingContentEl.textContent = '（已停止）';
          streamView.pendingContentEl.style.color = '#999';
        }
      }
      // 与 'end' 路径同样的去重：若本段已作为叙述段固化，就不再重复记一条文本。
      if (lastResponse && !alreadyCommittedAsText(streamState.parts, lastResponse)) {
        streamState.appendPart({ type: 'text', text: lastResponse });
      }
      // ⚠ **必须带 parts**：思考（type:'thinking'）与工具步骤只存在 parts 里。
      // 原先这里只写 content + toolSummary ⇒ 停止过的轮次在重开面板后思考与步骤整块消失，
      // 而正文还在 —— 所以症状看起来像"只有思考丢了"。
      // 另外：原先只在 `acc` 非空时入栈，"只思考到一半就停止"的那一轮**什么都没留下**。
      if (acc || streamState.parts.length) {
        panelSessionState.conversation.push({
          role: 'assistant',
          content: acc,
          toolSummary: summarizeToolParts(streamState.parts),
          parts: streamState.parts.slice(),
          // 计划条的唯一来源就是消息里的 plan（renderConversation 取"最近一条带计划的助手消息"）：
          // 停止的这一轮若不记它，重开面板后计划条会回退到更早那一轮的状态。
          plan: streamView.lastPlan.slice(),
        });
        saveConversation();
      }
      const note = document.createElement('div');
      note.className = 'stopped-note';
      note.textContent = '· 已停止生成';
      streamView.pendingAiMsg.appendChild(note);
      // 停止后的消息就是最后一条，给出「重新生成」入口。
      streamView.pendingAiMsg.insertAdjacentHTML('beforeend', msgActionsHtml(true));
    }
    endStream();
    fitPanelHeight();
    pinToBottom();
  }

  /**
   * 异常收尾（断线重试耗尽 / 后台未能恢复会话 / 长时间无响应）：把**已经流出的这一段**诚实入库。
   *
   * 为什么必须有它：这些路径原先直接 `endStream()`，而 endStream 会清空 pendingParts ——
   * 于是屏幕上已经出现的思考、工具步骤、正文**只在 DOM 里**，关掉面板再打开就全都没了
   *（数据从未进过 conversation，也就从未被持久化）。与 `buildFailedTurn` 是同一族问题：
   * **中断/失败恰恰是最需要留档的时刻**。
   *
   * 幂等：同一轮重复调用不会重复入栈（重连过程中可能被走两次）。
   */
  function commitInterruptedTurn(reasonText: any) {
    const last = panelSessionState.conversation.length ? panelSessionState.conversation[panelSessionState.conversation.length - 1] : null;
    if (last && last.role === 'assistant' && last.interrupted) return;
    commitPendingVerifyPass();
    const turn = buildInterruptedTurn(streamState.parts, streamState.responseText, reasonText);
    if (!turn.parts!.length && !String(streamState.responseText || '').trim()) return;
    panelSessionState.conversation.push(turn);
    saveConversation();
  }

  // 断线重连次数上限：只重试少量几次。
  // 不做无限重试的理由：后台若真的已被回收/扩展已被更新，重试只会变成
  // 「一直转圈 + 反复失败」，比起如实报错更糟。
  const MAX_PORT_RETRIES = 2;
  let portRetries = 0;
  let activeInstruction = '';
  let activeSelection = '';
  let lastRunOpts: any = null;
  let activeConn: any = null;
  let readyWaiter: any = null;

  // 轮询「中断的会话是否已落盘」。见 onDisconnect 里的说明。
  function waitSessionReady(timeoutMs: any) {
    return new Promise((resolve) => {
      const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 4000);
      const tick = () => {
        const activePort = runSession.port;
        if (!activePort || !runSession.isRunning) { resolve(false); return; }
        if (Date.now() > deadline) { resolve(false); return; }
        readyWaiter = (ok: any) => { if (ok) resolve(true); else setTimeout(tick, 250); };
        try { activePort.postMessage({ type: 'session-ready', runId: runSession.runId }); } catch (e: any) { resolve(false); }
      };
      tick();
    });
  }

  // 把「发一次 agent 请求」抽出来，供首次发送与断线重连复用。
  // 必须复用同一个 activeRunId：后台在端口断开时刻意保留了会话
  //（agent.js 的 AbortError 分支 persist({phase:'interrupted'}) 并把 messages 回滚到
  // 最近一个完整 tool turn），只有同 runId + continuation 才会被当成"接着跑"。
  function sendAgentRequest() {
    if (!runSession.port || !activeConn) return;
    try {
      activeConn.postMessage({
        action: 'agent',
        runId: runSession.runId,
        sessionId: panelSessionState.panelSessionId,
        question: activeInstruction,
        text: activeSelection,
        page: pageText,
        pageUrl: location.href,
        pageTitle: document.title,
        history: panelSessionState.conversation.slice(),
        ...(portRetries > 0 || (lastRunOpts && lastRunOpts.continuation) ? { continuation: true } : {}),
        ...(streamView.pickedElements.length ? { pickedElements: streamView.pickedElements } : {}),
      });
    } catch (e: any) {
      // 端口已死（扩展被更新等）：如实告知，不要假装还在跑。
      removeTypingEl();
      showCitationHint('与扩展的连接已断开（扩展可能刚被更新），请刷新页面后重试。');
      endStream();
    }
  }

  async function run(instruction: any, opts?: any) {
    const runOptions = opts || {};
    // 整页刷新后自动续跑：沿用 SW 侧已持久化的 runId（见 maybeResumeRunAfterReload）。
    runSession.setRunId(runOptions.presetRunId || runSession.createRunId());
    activeInstruction = String(instruction || '');
    // 每轮固定一份选文快照：首次请求发出后会清掉待发送预览，但断线重连
    // 仍必须把同一段原文带给后台，不能因为 lastText 已清空而丢上下文。
    activeSelection = String(lastText || '').trim();
    // 首屏恢复尚未完成时不能起跑：否则会用空 history 覆盖刚恢复的会话。
    try {
      if (conversationLoadPromise) await conversationLoadPromise;
    } catch (e: any) {}
    if (!panelSessionState.panelSessionId) {
      showCitationHint('会话尚未恢复完成，请稍后重试。');
      endStream();
      return;
    }
    if (panelSessionState.panelSessionActiveId && panelSessionState.panelSessionActiveId !== panelSessionState.panelSessionId) {
      const activated = await sendPanelMessage('panel:activate', { id: panelSessionState.panelSessionId });
      if (activated && activated.ok) {
        panelSessionState.panelSessionActiveId = panelSessionState.panelSessionId;
        if (Array.isArray(activated.sessions)) panelSessionState.panelSessionList = activated.sessions.slice();
        renderSessionButton();
        renderSessionMenu();
      }
    }
    const acquired = await acquirePanelSessionLock(runSession.runId, runOptions._lockTakeover === true);
    if (!acquired || !acquired.ok) {
      if (acquired && acquired.locked && !runOptions._lockConflictShown) {
        const owner = acquired.lock || {};
        showPanelDialog({
          title: '会话正在另一个标签页运行',
          message:
            '这个会话当前由另一个标签页操作' +
            (owner.tabId ? '（标签页 ' + owner.tabId + '）' : '') +
            '。接管会停止那一边的本轮任务，然后在本页继续。',
          confirmText: '接管并运行',
          cancelText: '改天再试',
          extraText: '新建会话',
          onExtra: () => {
            newPanelSession()
              .then((ok) => {
                if (ok) run(instruction, Object.assign({}, runOptions, { _lockConflictShown: true }));
              })
              .catch(() => {});
          },
          onConfirm: () => {
            run(
              instruction,
              Object.assign({}, runOptions, { _lockTakeover: true, _lockConflictShown: true })
            ).catch(() => {});
            return true;
          },
        });
      } else {
        showCitationHint((acquired && acquired.error) || '无法获取会话运行权，请稍后重试。');
      }
      return;
    }
    closePort();
    lastRunOpts = runOptions;
    portRetries = 0;
    // 响应看门狗：避免“三个点一直转”无反馈。15s 提示等待，45s 仍未收到任何消息则报错结束。
    let respTimer: any = null;
    let respFailTimer: any = null;
    let respWarned = false;
    const clearRespTimers = () => {
      if (respTimer) { clearTimeout(respTimer); respTimer = null; }
      if (respFailTimer) { clearTimeout(respFailTimer); respFailTimer = null; }
    };
    lastResponse = '';
    // 拾取的元素要**跟着这条消息一起留下**（显示 + 持久化）。
    // 原先它只随本次请求发给模型，发完就清空 —— 于是对话里完全没有痕迹：
    // 看不到刚才选了什么，刷新后也找不回，而交接包里反而带着它（体验倒挂）。
    // 选文快照在 run 入口固定；这里直接复用它，避免本段逻辑与重连请求各自取一份。
    const pickedForMessage = summarizePickedForMessage(streamView.pickedElements);
    const selectedForMessage = activeSelection;
    // 整页刷新后的自动续跑会传 skipUserTurn：对话历史里已经有这条用户消息
    //（persist 后恢复的），不要再重复 push、也不要重复渲染。
    const skipUserTurn = Boolean(runOptions.skipUserTurn);
    if (!skipUserTurn) {
      panelSessionState.conversation.push(
        Object.assign(
          { role: 'user', content: instruction },
          selectedForMessage ? { selectedText: selectedForMessage } : {},
          pickedForMessage.length ? { pickedElements: pickedForMessage } : {}
        )
      );
      // 用户消息**一进对话就落盘**：整页跳转（如 GitHub 搜索）发生在这一轮中途时，
      // 新文档恢复对话才不会把这条指令丢掉。此前只在收尾/中断时 save，跳转会把它整条吞掉。
      saveConversation();
      const userMsg = document.createElement('div');
      userMsg.className = 'user-turn';
      userMsg.innerHTML =
        '<div class="msg user">' + escHtml(instruction) + selectedTextMessageHtml(selectedForMessage) + pickedSummaryHtml(pickedForMessage) + '</div>' +
        userActionsHtml(panelSessionState.conversation.length - 1);
      panelBody.appendChild(userMsg);
      // 选文已经被这条消息消费并持久化；清掉输入区预览，避免下一轮误带。
      clearSelectedText({ render: false });
    }
    const aiMsg = document.createElement('div');
    aiMsg.className = 'msg ai';
    streamView.flowEl = document.createElement('div');
    streamView.flowEl.className = 'agent-flow';
    const contentEl = document.createElement('div');
    contentEl.className = 'agent-content';
    contentEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    streamView.flowEl.appendChild(contentEl);
    aiMsg.appendChild(streamView.flowEl);
    panelBody.appendChild(aiMsg);
    fitPanelHeight();
    pinToBottom();

    // 刷新后接管/续跑时，SW 的运行快照里已有刷新前的工具步骤/叙述/思考。
    // 先把它们画回新面板，再从新端口继续接增量 —— 否则用户会看到前半轮凭空消失。
    const resumeSnapshot =
      runOptions.resumeSnapshot && typeof runOptions.resumeSnapshot === 'object'
        ? runOptions.resumeSnapshot
        : null;
    /**
     * 把一份运行快照铺回当前 AI 消息。
     * 刷新接管会在两个时刻调用：刚打开面板时（query-run 的快照）和 reattach 成功时
     * （后台补发的最新快照）。后者会覆盖前者，保证快照与后续事件之间没有缺口。
     */
    const applyResumeSnapshot = (snapshot: any, approvalConn?: any) => {
      if (!snapshot || typeof snapshot !== 'object') return;
      streamState.restore(snapshot);
      streamView.currentCitations = Array.isArray(snapshot.citations) ? snapshot.citations.slice() : null;
      const plan = Array.isArray(snapshot.plan) ? snapshot.plan.slice() : [];
      renderPlan(plan);
      streamView.lastPlan = plan;
      if (streamView.usageEl) streamView.usageEl.textContent = snapshot.tokens ? 'tokens ' + snapshot.tokens : '';
      // 先清掉默认的 typing 占位，再按原顺序重建已固化的段落。
      streamView.flowEl.innerHTML = '';
      renderCommittedParts(streamView.flowEl);
      resetReasoning();
      if (snapshot.reasoning) {
        streamView.thinkSeg = { id: ++streamView.thinkSegSeq, text: String(snapshot.reasoning), done: false, block: null, body: null };
        mountThinkSegment(streamView.thinkSeg);
      }
      contentEl.innerHTML = streamState.narration
        ? renderAnswer(streamState.narration, streamView.currentCitations, false)
        : '<span class="typing"><span></span><span></span><span></span></span>';
      streamView.flowEl.appendChild(contentEl);
      if (streamState.narration) showStreamingAnswer(contentEl, streamState.narration, streamView.currentCitations);
      streamView.typingEl = streamState.narration ? null : contentEl;
      streamView.pendingAiMsg = aiMsg;
      streamView.pendingContentEl = contentEl;
      streamView.pendingAiMsg._raw = streamState.content;
      // 进度条接着刷新前的计时与步骤走，不要从 0 重新开始。
      progressController.startedAt = Number(snapshot.startedAt) || progressController.startedAt || Date.now();
      const p = snapshot.progress || {};
      progressController.state = stateLabel(p.state) || '继续运行';
      progressController.step = Number(p.step) || 0;
      progressController.max = Number(p.max) || 0;
      if (progressController.el) progressController.el.classList.add('on');
      progressController.render();
      updateRunControlState();
      // 刷新时可能正卡在审批上：把审批条也画回来，否则新页面看不到"等确认"。
      if (snapshot.approval && approvalConn) {
        const approval = snapshot.approval;
        renderApprovalPrompt(
          approvalArea,
          approvalConn,
          approval.callId,
          approval.name,
          approval.args,
          approval.risk,
          approval.allowSession
        );
      }
    };
    if (!resumeSnapshot) {
      streamState.beginNew();
      if (streamView.usageEl) streamView.usageEl.textContent = '';
      // 新一轮开始：先清掉上一轮的计划条，等本轮的 update_plan 到达再显示。
      renderPlan([]);
      streamView.lastPlan = [];
      streamView.pendingAiMsg = aiMsg;
      streamView.pendingContentEl = contentEl;
      streamView.typingEl = contentEl;
      // 新一轮：上一轮的思考记录已成为历史，这里只清指针，不动那块 DOM。
      resetReasoning();
    }
    runSession.setRunning(true);
    progressController.start();
    if (resumeSnapshot) applyResumeSnapshot(resumeSnapshot);
    updateRunControlState();

    if (!isExtContextAlive()) {
      showCitationHint('扩展已更新，当前页面的助手已失效，请刷新页面后重试。');
      endStream();
      return;
    }
    let conn: any;
    try {
      conn = chrome.runtime.connect({ name: 'ai-stream' });
      runSession.setPort(conn);
    } catch (e: any) {
      showCitationHint('扩展已更新，当前页面的助手已失效，请刷新页面后重试。');
      endStream();
      return;
    }
    activeConn = conn;
    conn.onMessage.addListener((resp: any) => {
      if (resp.runId && resp.runId !== runSession.runId) return;
      clearRespTimers();
      if (resp.type === 'reattached') {
        // 后台补发的最新快照：覆盖 query-run 时那份，补齐 attach 之前的事件。
        applyResumeSnapshot(resp.snapshot, conn);
        return;
      } else if (resp.type === 'reattach-failed') {
        showCitationHint(resp.reason || '任务已结束，正在刷新会话。');
        endStream();
        if (!adoptFinishedRunSnapshot(resp.snapshot)) loadConversation().catch(() => {});
        return;
      } else if (resp.type === 'citations') {
        streamView.currentCitations = resp.citations || null;
      } else if (resp.type === 'tool-call') {
        streamState.appendPart({ type: 'tool-call', callId: resp.callId, name: resp.name, args: resp.args || {}, risk: resp.risk || 'unknown' });
        appendStep(
          toolStepElement('🔧 ', resp.name, argHint(resp.args), '参数', clipDetail(JSON.stringify(resp.args || {}, null, 2), 2000))
        );
        if (resp.requiresApproval) {
          renderApprovalPrompt(approvalArea, conn, resp.callId, resp.name, resp.args, resp.risk, resp.allowSession);
        }
        fitPanelHeight();
        pinToBottom();
      } else if (resp.type === 'tool-result') {
        const resultPart: any = {
          type: 'tool-result',
          callId: resp.callId,
          name: resp.name,
          status: resp.status,
          result: resp.result || '',
        };
        if (resp.needsLogin === true) {
          resultPart.needsLogin = true;
          resultPart.authChallenge =
            resp.authChallenge && resp.authChallenge.required === true
              ? resp.authChallenge
              : {
                  required: true,
                  reason: 'login-required',
                  summary: String(resp.authMessage || '操作被登录 / 权限拦截，请登录后重试。'),
                  loginUrl: String(resp.loginUrl || ''),
                };
        }
        streamState.appendPart(resultPart);
        appendStep(
          toolStepElement(
            resp.status === 'completed' ? '✓ 工具已完成：' : resp.status === 'failed' ? '✗ 工具失败：' : '— 工具未执行：',
            resp.name,
            '',
            resp.status === 'failed' ? '错误信息' : '返回结果',
            clipDetail(resp.result, 4000)
          )
        );
        const authEl = authChallengeElement(resultPart.authChallenge);
        if (authEl) appendStep(authEl);
        fitPanelHeight();
        pinToBottom();
      } else if (resp.type === 'agent-state') {
        // 事件字段名是 `state`（agent-state.js 的 transition 返回 { state: next }），
        // 不是 status —— 写错会导致状态标签永远取不到，只剩步数。
        const st = resp.state || resp.status;
        const label = stateLabel(st);
        if (label) progressController.state = label;
        const step = Number(resp.step);
        if (Number.isFinite(step) && step > 0) progressController.step = step;
        const max = Number(resp.maxSteps);
        if (Number.isFinite(max) && max > 0) progressController.max = max;
        progressController.render();
      } else if (resp.type === 'screenshot') {
        // 图片给用户看：渲染成缩略图，点击放大。base64 只留在内存缓存里，
        // 不写进 pendingParts（否则会话持久化会背着几百 KB 的图到处走）；
        // 图片本体已按 id 共享落盘，其它标签页/历史会话会按需取回。
        if (resp.id && resp.dataUrl) screenshotView.cache.set(resp.id, resp.dataUrl);
        streamState.appendPart({ type: 'screenshot', id: resp.id, label: resp.label, width: resp.width, height: resp.height, bytes: resp.bytes });
        appendStep(screenshotView.element(resp));
        fitPanelHeight();
        pinToBottom();
      } else if (resp.type === 'stuck-warning') {
        appendNoticePart('⚠ ' + (resp.message || '动作暂未产生可观察进展'), '#b45309');
        fitPanelHeight();
        pinToBottom();
      } else if (resp.type === 'tool-disabled') {
        appendNoticePart('⛔ 已停止使用工具「' + (resp.name || '') + '」：' + (resp.reason || ''), '#6b7280');
        fitPanelHeight();
        pinToBottom();
      } else if (resp.type === 'budget-exceeded') {
        streamState.markBudgetStopped();
        appendNoticePart('⏹ ' + (resp.message || 'Agent 已达到安全上限并停止'), '#b91c1c');
        fitPanelHeight();
        pinToBottom();
      } else if (resp.type === 'tab-switched') {
        appendNoticePart('↗ 已切换标签页：' + (resp.title || resp.url || ('tabId=' + resp.tabId)));
        fitPanelHeight();
        pinToBottom();
      } else if (resp.type === 'tabs-closed') {
        const count = Array.isArray(resp.tabIds) ? resp.tabIds.length : 0;
        if (count) {
          appendNoticePart('🗑 任务结束，已自动关闭 ' + count + ' 个本次打开的标签页', '#6b7280');
          fitPanelHeight();
          pinToBottom();
        }
      } else if (resp.type === 'tabs-close-pending') {
        const count = Array.isArray(resp.tabIds) ? resp.tabIds.length : 0;
        if (count) {
          appendNoticePart('🗂 任务结束，将在最终回复保存后关闭 ' + count + ' 个辅助标签页', '#6b7280');
          fitPanelHeight();
          pinToBottom();
        }
      } else if (resp.type === 'intent') {
        appendNoticePart('🧭 意图识别：' + (resp.label || resp.intent || '普通对话'));
        fitPanelHeight();
        pinToBottom();
      } else if (resp.type === 'intent-upgraded') {
        appendNoticePart('🔄 已切换为' + (resp.label || '资料研究') + '模式，可用浏览器/网络工具继续');
        fitPanelHeight();
        pinToBottom();
      } else if (resp.type === 'verify') {
        let text = '';
        if (resp.ok) {
          text = '✓ 完成前校验通过' + (resp.reason ? '：' + resp.reason : '');
        } else if (resp.inconclusive) {
          // 校验器没给出结论（超时/报错），任务按通过放行。
          // 不能渲染成"校验未通过"—— 那是在同一句里既否决又放行。
          text = '… 未能完成校验：' + (resp.reason || '校验器不可用');
        } else if (resp.deterministic) {
          // 确定性规则命中：与 LLM 校验区分开，用户才好判断这条结论的来路。
          text = '⚠ 完成前检查未通过（确定性规则，未消耗模型调用）：' + (resp.reason || '声称与实际动作不符');
        } else if (resp.repeated) {
          // 同一份证据的重复送审：没花模型调用，直接判否并要求新证据。
          text = '⚠ 校验未通过（证据与上次完全相同，未重复调用模型）：' + (resp.reason || '证据没有变化');
        } else {
          text = '⚠ 校验未通过：' + (resp.reason || '目标可能未达成') + (resp.missing ? '（还差：' + resp.missing + '）' : '');
        }
        if (resp.ok === true) {
          // 校验通过发生在 complete_task 之后、最终回答之前。若立刻插进时间线，
          // 它会停在「工具已完成：complete_task」后面，看起来像任务中间状态。
          // 先暂存，等 end 事件把最终回答与来源渲染完，再作为收尾状态放在最后。
          streamState.setVerifyPass({ type: 'notice', text, color: '#16a34a', terminal: true });
        } else {
          appendNoticePart(text, '#b45309');
          fitPanelHeight();
          pinToBottom();
        }
      } else if (resp.type === 'usage') {
        if (streamView.usageEl) streamView.usageEl.textContent = 'tokens ' + (resp.totalTokens || 0);
      } else if (resp.type === 'plan') {
        renderPlan(resp.plan);
      } else if (resp.type === 'skill') {
        const skills = Array.isArray(resp.skills) ? resp.skills : [];
        if (skills.length) {
          appendNoticePart('🛠 启用技能：' + skills.map((s: any) => s.title || s.name).join('、'), '', 'agent-skill');
          fitPanelHeight();
          pinToBottom();
        }
      } else if (resp.type === 'reasoning') {
        // 思维链增量（只有推理模型会发）。它到达时把「正在输入」占位换掉 ——
        // 此时用户已经能看到实时思考内容，比三个点更有信息量。
        removeTypingEl();
        pushReasoning(resp.text);
      } else if (resp.type === 'chunk') {
        removeTypingEl();
        // 正文开始 → 思考记录定稿（它**本来就是折叠的**；用户手动展开过则保持展开，
        // 「定稿」不改变用户的选择）。
        finishReasoning();
        streamState.appendChunk(resp.text);
        if (!streamView.pendingContentEl) {
          streamView.pendingContentEl = ensureTextEl();
          if (streamView.pendingContentEl) streamView.pendingContentEl.innerHTML = '';
        }
        // 只累积，不立刻重绘：本条 chunk 与同帧内的其它 chunk 会被合并成一次渲染。
        // 累积文本在 schedule 的回调里读取，因此拿到的总是最新的一份。
        streamRender.schedule('answer', () => {
          const paintPendingAnswer = () => {
            const startedAt = Date.now();
            // 流式过程中也统一重编号引用，保证正文始终从 [1] 连续
            //（生成结束后会再次校正，幂等）。
            if (streamView.pendingContentEl) showStreamingAnswer(streamView.pendingContentEl, streamState.narration, streamView.currentCitations);
            streamView.pendingAiMsg._raw = streamState.content;
            noteStreamPaint(startedAt);
          };
          // 上一次重绘很贵时让位一帧（说明见 throttleStreamPaint）—— 画得越贵，间隔越长，
          // 但被跳过的帧一定会由兜底定时器补上，不会把最后几个字漏在屏幕外。
          if (throttleStreamPaint(paintPendingAnswer)) return;
          paintPendingAnswer();
        });
        // 布局与自动滚动同样合并：fitPanelHeight 是先写 style 再读 scrollHeight 的
        // 强制同步布局，逐 token 调用等于每 token 强制回流两次。
        streamRender.schedule('layout', () => {
          fitPanelHeight();
          pinToBottom();
        });
      } else if (resp.type === 'end') {
        removeTypingEl();
        // 本轮结束：没有正文的轮次（纯工具轮）也要让思考记录定稿，否则它会一直转。
        finishReasoning();
        // 收尾前先 flush：否则下面设好的最终渲染会被一个仍在排队的流式渲染覆盖掉。
        streamRender.flush();
        lastResponse = collapseImmediateRepeatedText(streamState.responseText);
        // 去重必须在引文重编号**之前**。重编号会改变 `[n]`，若拿重编号后的 finalText
        // 去和 parts 里的原始文本比较，同一段答案会被误判成新内容并再追加一份。
        if (lastResponse && !alreadyCommittedAsText(streamState.parts, lastResponse)) {
          streamState.appendPart({ type: 'text', text: lastResponse });
        }
        // 最终回复统一重编号引用：正文从 [1] 开始，参考来源只保留被引用的文章。
        //
        // **必须跨整条消息算**：渲染时每一段文字（narration / text）都按位置对齐同一份
        // citations，若只重编号最终答复那一段，其余段落里的 [n] 仍是全局编号，
        // 会指到错误的来源（实测症状：「参考来源」列的东西与正文说的不是一回事）。
        const textParts = streamState.parts.filter((p: any) => (p.type === 'narration' || p.type === 'text') && p.text);
        const renumbered = renumberCitationsAcross(
          textParts.map((p: any) => p.text).concat([lastResponse]),
          streamView.currentCitations
        );
        const finalText = renumbered.apply(lastResponse);
        const finalCitations = renumbered.citations;
        if (!streamState.started) {
          const el = ensureTextEl();
          if (el) el.textContent = streamState.budgetStopped ? '（任务已停止，未生成最终回复）' : '（无返回内容）';
        } else if (streamView.pendingContentEl) {
          removeStreamCursor(streamView.pendingContentEl);
          streamView.pendingContentEl.innerHTML = renderAnswer(lastResponse, streamView.currentCitations, false);
          streamView.pendingAiMsg._raw = streamState.content;
        }
        // 最终文本只在此处统一追加一次（见下方 dedupe），这里不再 push，避免重复记录。

        // 附加引用来源区域（仅列出正文实际引用的来源）
        if (finalCitations.length) {
          const srcWrap = document.createElement('div');
          srcWrap.className = 'cite-sources';
          srcWrap.innerHTML =
            '<span class="cite-label">参考来源：</span>' +
            finalCitations
              .map((c) => {
                const t = c.title.length > 18 ? c.title.slice(0, 18) + '…' : c.title;
                const idAttr = String(c.id || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
                const tAttr = String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
                const titleAttr = String(c.title).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
                const sourceAttr = String(c.source || 'kb').replace(/"/g, '&quot;');
                const urlAttr = String(c.url || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
                const snippetAttr = String(c.snippet || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
                return '<button class="cite-badge" data-cite-id="' + idAttr + '" data-cite-source="' + sourceAttr + '" data-cite-url="' + urlAttr + '" data-cite-snippet="' + snippetAttr + '" title="打开证据：' + titleAttr + '"><span class="cite-idx">[' + c.index + ']</span>' + tAttr + '</button>';
              })
              .join('');
          streamView.pendingAiMsg.appendChild(srcWrap);
        }
        // 校验通过的提示是收尾状态：放在最终正文与参考来源之后，
        // 而不是紧跟 complete_task 的工具结果。
        if (streamState.verifyPass) {
          const verifyEl = document.createElement('div');
          verifyEl.className = 'agent-step verify-final';
          verifyEl.style.color = streamState.verifyPass.color || '#16a34a';
          verifyEl.textContent = streamState.verifyPass.text;
          streamView.pendingAiMsg.appendChild(verifyEl);
        }
        // 刚结束的这条就是最后一条消息，直接给出「重新生成」入口
        // （否则要等面板重开触发 renderConversation 才出现）。
        if (lastResponse) streamView.pendingAiMsg.insertAdjacentHTML('beforeend', msgActionsHtml(true));
        commitPendingVerifyPass();
        // 整条消息的每一段都过同一张映射表，保证正文、工具结果与参考来源区三者一致。
        const finalParts = dedupeAdjacentTextParts(streamState.parts.map((p: any) => {
          if (p.type === 'narration' || p.type === 'text') {
            return p.text
              ? Object.assign({}, p, { text: renumbered.apply(collapseImmediateRepeatedText(p.text)) })
              : p;
          }
          // 工具结果里的 [n] 是纯文本渲染（不走 renderAnswer），但同样与参考来源区共用编号。
          if (p.type === 'tool-result' && typeof p.result === 'string') {
            return Object.assign({}, p, { result: renumbered.apply(p.result) });
          }
          return p;
        }));
        panelSessionState.conversation.push({ role: 'assistant', content: finalText, citations: finalCitations, plan: streamView.lastPlan.slice(), toolSummary: summarizeToolParts(finalParts), parts: finalParts });
        saveConversation();
        // 触底收尾：解析模型输出的「【可选操作】」小节，渲染可点击继续按钮。
        //
        // ⚠ 若流式期间面板 DOM 被重建过（SPA 导航 / 对话恢复重绘），pendingAiMsg 已脱离文档：
        // 这时最终输出只存在于 conversation 里，必须**从对话重建一次** —— 否则回答写进已脱离的
        // 节点，用户看到的就是"跳转后模型输出没了、回退又出现"（实测反馈）。
        if (!streamView.pendingAiMsg || !streamView.pendingAiMsg.isConnected) {
          try { renderConversation(); } catch (e: any) {}
        } else {
          renderSuggestionButtons(streamView.pendingAiMsg, finalText, run);
        }
        fitPanelHeight();
        streamView.currentCitations = null;
        endStream();
        closePort();
      } else if (resp.type === 'error') {
        removeTypingEl();
        const errText = String(resp.error || '任务失败（未提供错误信息）');
        // 已经流出正文时错误追加在后面（不能覆盖 —— 见 renderRunError 的说明）。
        const hasPartial = streamState.hasPartial();
        renderRunError(streamView.flowEl, streamView.pendingContentEl, errText, hasPartial);
        if (resp.needSetup) {
          refreshApiKeyBanner();
          // ⚠ pendingAiMsg 可能已经是 null（endStream 跑过、或错误被重发一次）：
          // 直接 appendChild 会抛 TypeError，而它在消息监听器里 ⇒ 后面的
          // 「失败轮次入库 / endStream / closePort」全部不执行，面板会卡在「正在运行」。 
          const anchor = streamView.pendingAiMsg || streamView.flowEl;
          if (anchor) {
            anchor.appendChild(document.createElement('br'));
            anchor.appendChild(buildOpenSettingsButton());
          }
        }
        // 失败也必须在对话里留下痕迹。
        // 原实现只把错误写进 DOM：于是「导出记录」与「会话交接」都看不到它，
        // 面板一刷新更是彻底消失 —— 而失败正是最需要交接给外部 AI 的时刻。
        // 必须赶在 endStream() 之前取 pendingParts：它会把进行中的状态全部清空。
        panelSessionState.conversation.push(buildFailedTurn(streamState.parts, errText, streamState.responseText));
        saveConversation();
        endStream();
        closePort();
      }
    });
    conn.onDisconnect.addListener(() => {
      // 判定顺序很重要，这里曾经写错过一次（导致整段重连代码变成死代码）：
      //   ① `conn !== activeConn` → 忽略已被替换的旧连接。
      //      注意 closePort() **不再**把 activeConn 置空 —— 它会在 run() 起始被调用，
      //      若在那里置空，新连接的 activeConn 仍为 null，这一条就恒成立、永不重连。
      //   ② 不是当前 port → 说明是正常结束（closePort 已置空），不重连。
      if (conn !== activeConn) return; // 旧的/已被替换的连接，忽略
      runSession.clearPort(conn);
      if (!runSession.isRunning) return; // 正常结束后 closePort() 也会触发这里，不该重连
      // 后台在端口断开时刻意保留会话（agent.js 的 AbortError 分支），
      // 这里用**同一个 runId** 重连即可接着跑 —— 否则一次几分钟的任务会直接丢失，
      // 而完整的恢复机制永远不被触发（此前就是这样：恢复逻辑是死代码）。
      if (portRetries >= MAX_PORT_RETRIES) {
        // 重连次数用尽：如实入库"中断"这一轮，再收尾（否则屏幕上那些思考/步骤只有 DOM 有）。
        commitInterruptedTurn('任务中断：与扩展的连接反复断开，已停止重连。');
        endStream();
        return;
      }
      portRetries += 1;
      let nextPort: any;
      try {
        nextPort = chrome.runtime.connect({ name: 'ai-stream' });
        runSession.setPort(nextPort);
      } catch (e: any) {
        endStream();
        return;
      }
      activeConn = nextPort;
      nextPort.onMessage.addListener((resp: any) => {
        if (resp.runId && resp.runId !== runSession.runId) return;
        if (resp.type === 'session-ready') {
          if (readyWaiter) { const w = readyWaiter; readyWaiter = null; w(resp.ready === true); }
          return;
        }
        if (resp.type === 'end' || resp.type === 'error') runSession.finish();
      });
      // 重连前确认「后台已把中断的会话落盘」。
      // 只延迟固定时间是不够的：persist 是异步的，若重连早于落盘，
      // runAgentStream 的 canResume 为 false，会把重连当成一次**新任务**从头开始 ——
      // 用户看到重复执行，历史里同一条指令出现两次。
      // 因此轮询就绪探针；若始终不就绪，则如实收尾而不是盲目重发。
      (async () => {
        const ready = await waitSessionReady(6000);
        if (!runSession.isRunning) return;
        if (!ready) {
          removeTypingEl();
          showCitationHint('任务被中断且后台未能恢复会话，请重新发送指令。');
          commitInterruptedTurn('任务中断：后台未能恢复会话（扩展可能刚被更新或回收）。');
          endStream();
          return;
        }
        sendAgentRequest();
      })();
    });
    // 长任务心跳：每 20s 发一次空消息，避免 MV3 service worker 因空闲被回收。
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
      try { conn.postMessage({ type: 'keepalive' }); } catch (e: any) {}
      renewPanelSessionLock();
    }, 20000);
    if (runOptions.reattach) {
      // 直接挂到仍然活着的 run 上：不启动第二次 agent 请求，也不重新执行工具。
      conn.postMessage({ type: 'reattach', runId: runSession.runId, sessionId: panelSessionState.panelSessionId });
    } else {
      conn.postMessage({
        action: 'agent',
        runId: runSession.runId,
        sessionId: panelSessionState.panelSessionId,
        question: instruction,
        text: activeSelection,
        page: pageText,
        pageUrl: location.href,
        pageTitle: document.title,
        history: panelSessionState.conversation.slice(),
        ...(runOptions.continuation ? { continuation: true } : {}),
        ...(streamView.pickedElements.length ? { pickedElements: streamView.pickedElements } : {}),
      });
    }
    // 断线重连复用同一个 activeRunId（见 onDisconnect）：
    // 后台在端口断开时刻意保留会话，只有同 runId + continuation 才会"接着跑"而不是重开。
    // 已选元素随本次消息发出后清空。
    if (streamView.pickedElements.length) {
      streamView.pickedElements = [];
      try { renderPick(); } catch (e: any) {}
    }
    // E2E 专用钩子：让测试能主动断开端口，从而验证「断线重连 + 用同一 runId 恢复」这条路径。
    // 为什么需要它：真实触发 MV3 worker 回收要等空闲超时，E2E 里不可控；
    // 而这条逻辑恰恰属于"不能靠读代码确认正确性"的那一类（面板 port 状态机），必须真跑一次。
    //
    // 为什么走 window 事件而不是挂全局函数：内容脚本运行在**隔离世界**，
    // `page.evaluate()`（主世界）看不到挂在隔离世界 window 上的函数。
    // 但 DOM 事件是跨世界共享的 —— 页面派发的事件，隔离世界的监听器能收到。
    // 事件名带 __RF_E2E__ 标记，且只做「断开当前端口」这一件与 worker 被回收等价的事。
    window.addEventListener('__RF_E2E__dropPort', () => {
      // 注意：**必须由后台侧断开**。实测面板自己调用 port.disconnect() 不会触发
      // 它自己的 onDisconnect（本端主动断开不走该事件），因此那条路测不到重连。
      // 后台侧断开才是真实场景（MV3 worker 被回收）。见 background.js 的 e2e-drop-port。
      try { runSession.port?.postMessage({ type: 'e2e-drop-port' }); } catch (e: any) {}
      window.dispatchEvent(new CustomEvent('__RF_E2E__dropped'));
    });
    // 15 秒无任何回流 → 提示等待；45 秒仍无 → 报错结束，避免无限转圈。
    respTimer = setTimeout(() => {
      if (!runSession.isRunning || respWarned) return;
      respWarned = true;
      if (streamView.pendingContentEl) {
        const note = document.createElement('div');
        note.style.cssText = 'color:#999;font-size:11px;margin-top:4px;';
        note.textContent = '⏳ 正在等待模型响应…（网络较慢或模型繁忙）';
        streamView.pendingContentEl.appendChild(note);
      }
    }, 15000);
    respFailTimer = setTimeout(() => {
      if (!runSession.isRunning) return;
      const el = streamView.pendingContentEl || ensureTextEl();
      if (el) {
        removeStreamCursor(el);
        el.textContent = '未收到模型响应，请检查网络连接或 API 配置后重试。';
        el.style.color = '#e74c3c';
      }
      // 同上：入库，别让已经发生的思考/步骤随 endStream 一起蒸发。
      commitInterruptedTurn('任务中断：45 秒内未收到模型响应。');
      endStream();
      closePort();
    }, 45000);
  }

  function send() {
    if (runSession.isRunning) return;
    const cmd = cmdInput.value.trim();
    if (!cmd) return;
    run(expandQuickPrompt(cmd));
    cmdInput.value = '';
    cmdInput.style.height = 'auto';
    cmdInput.style.height = '34px';
    cmdInput.focus();
  }

  // 绑定当前面板的发送函数到面板元素，供「决策建议按钮」触发继续。
  panel._sendFn = run;
  activeSendFn = run;

  sendBtn.addEventListener('click', send);
  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (streamView.picking) return; // 拾取中由拾取器处理 Esc，不关闭面板
      e.preventDefault();
      e.stopPropagation();
      removePanel();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // 中文等输入法在候选词阶段也会派发 Enter。此时 Enter 属于组词确认，
      // 不能当作"发送消息"，否则用户选词时会把半句话发出去。
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      send();
    }
  });
  cmdInput.addEventListener('input', () => {
    cmdInput.style.height = 'auto';
    cmdInput.style.height = Math.min(120, cmdInput.scrollHeight) + 'px';
  });
  // Esc 关闭提升到 document 级：原先只绑在输入框上，点过消息区或面板空白后按 Esc 毫无反应。
  // 拾取模式下交给拾取器处理；审批提示展示中不关闭，避免误关掉安全确认。
  panelKeyHandler = (e: any) => {
    if (e.key !== 'Escape') return;
    if (streamView.picking) return;
    // 最上层浮层优先消费 Esc。尤其是会话重命名/删除弹窗：
    // 这里若直接关整个面板，用户会同时丢失弹窗和当前阅读位置。
    if (panel && panel.querySelector('.session-dialog-backdrop')) return;
    if (panelSessionMenuOpen) {
      e.preventDefault();
      e.stopPropagation();
      closeSessionMenu();
      return;
    }
    if (streamView.approvalPopoverEl && !streamView.approvalPopoverEl.hidden) {
      e.preventDefault();
      e.stopPropagation();
      closeApprovalPopover();
      return;
    }
    if (screenshotView.lightboxOpen) return; // 放大看截图时 Esc 只关图，不关面板
    if (approvalArea && approvalArea.style.display !== 'none') return;
    e.preventDefault();
    e.stopPropagation();
    removePanel();
  };
  document.addEventListener('keydown', panelKeyHandler, true);
  cmdInput.focus();

  // 拖拽
  head.addEventListener('mousedown', (e: any) => {
    if (e.target.closest('button')) return;
    // 用视口坐标作起点，脱离 dock 底停靠（bottom）后立即固定到当前位置，保证后续平移基准正确。
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: panel.getBoundingClientRect().left,
      origTop: panel.getBoundingClientRect().top,
    };
    panel._manualPos = true;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = dragState.origLeft + 'px';
    panel.style.top = dragState.origTop + 'px';
    e.preventDefault();
  });

  // ⚠ **面板收尾必须放在整个 openPanel 的最后**，因为面板本体直到上面
  //   `shadow.appendChild(panel)` 才进文档 —— 在那之前 `panelBody.isConnected` 是 false，
  //   `scrollHeight` 与 `clientHeight` **恒为 0**，`scrollTop = scrollHeight` 等于什么都没做，
  //   而且**不报错**。原先这两句写在 `renderConversation()` 旁边（约 140 行之前），
  //   症状正是用户反馈的「关掉会话再打开，没有停在最后一条」。
  //   实测（修复前）：重开后 scrollTop=0 / scrollHeight=780 / clientHeight=226（偏差 554px），
  //   而手动置底能到 553 ⇒ 说明是"根本没执行"，不是"执行完又被抹掉"。
  //   插桩日志（`pinToBottom` 里的 isConnected 前置判断）显示它当时确实返回 not connected。
  fitPanelHeight();
  pinToBottom();

  // 把 run 挂到模块级引用，供整页刷新后的自动续跑入口调用（见 maybeResumeRunAfterReload）。
  runSession.bindRunner(run);
  runSession.bindInterrupt(interrupt);
  if (panelVisibility.canPublish) publishPanelUi(true, 'global');
  subscribePanelRun().catch(() => {});
}

// 选中新内容时，刷新已打开的对话框
function refreshPanelForSelection() {
  // 流式中不打断当前生成，仅刷新选中文本预览；正在输出的回复通过 restoreStreamingUI 恢复。
  if (!runSession.isRunning) closePort();
  lastResponse = '';
  syncPanelSelectionPreview();
  renderConversation();
  restoreStreamingUI();
}

/**
 * 把「刷新窗口里已经跑完」的 run 快照落成一条正式 assistant 消息。
 *
 * 为什么需要：旧页面销毁后没有人再做 UI 收尾；若 run 在新面板 reattach 之前
 * 就结束了，只靠 loadConversation 会只剩用户消息，最终回答永远丢失。
 */
function adoptFinishedRunSnapshot(snapshot: any) {
  if (!snapshot || snapshot.status === 'running' || !Array.isArray(snapshot.parts)) return false;
  const instruction = String(snapshot.instruction || '').trim();
  if (!instruction) return false;
  let userIndex = -1;
  for (let i = panelSessionState.conversation.length - 1; i >= 0; i--) {
    if (panelSessionState.conversation[i] && panelSessionState.conversation[i].role === 'user' && String(panelSessionState.conversation[i].content || '').trim() === instruction) {
      userIndex = i;
      break;
    }
  }
  if (userIndex >= 0 && panelSessionState.conversation.slice(userIndex + 1).some((m: any) => m && m.role === 'assistant' && !m.live)) {
    return false; // 已经有正式回复（例如旧页面在卸载前已落盘）
  }
  const msg = runStateToAssistantMessage(snapshot);
  if (!msg) return false;
  msg.live = false;
  msg.liveStatus = 'completed';
  msg.showCitations = true;
  panelSessionState.conversation.push(msg);
  saveConversation();
  if (panelBody && !runSession.isRunning) {
    renderConversation();
    fitPanelHeight();
    pinToBottom();
  }
  return true;
}

// 整页刷新后的自动续跑：问 SW 本 tab 是否有可续跑的 run，有则重开面板、用同一 runId 续跑。
// abort 与落盘是异步的：SW 可能回 pending=true（会话还没写出来），只在 pending 时重试。
function maybeResumeRunAfterReload() {
  let attempts = 0;
  const MAX_ATTEMPTS = 12;
  const tick = () => {
    if (runSession.isRunning) return;
    attempts += 1;
    if (attempts > MAX_ATTEMPTS) return;
    let p: any = null;
    let handled = false;
    try {
      p = chrome.runtime.connect({ name: 'ai-stream' });
      p.onMessage.addListener(async (resp: any) => {
        if (handled || !resp || resp.type !== 'run-state') return;
        handled = true;
        try { p.disconnect(); } catch (e: any) {}
        if (!resp.resumable && resp.finished && resp.snapshot && !runSession.isRunning) {
          try {
            if (conversationLoadPromise) await conversationLoadPromise;
          } catch (e: any) {}
          try {
            if (panelVisibility.ready) await panelVisibility.ready;
          } catch (e: any) {}
          if (!runSession.isRunning) adoptFinishedRunSnapshot(resp.snapshot);
          return;
        }
        if (resp.resumable && resp.runId && resp.instruction && !runSession.isRunning) {
          // ⚠ 必须先等对话恢复完成再起跑：否则 run 函数会基于**空 conversation** 起一轮，
          // 随后 loadConversation 落地时 renderConversation 把正在流式输出的面板整块重建 ——
          // 用户看到的就是"跳转后模型输出不见了、回退又出现"（实测反馈）。
          try {
            if (conversationLoadPromise) await conversationLoadPromise;
          } catch (e: any) {}
          try {
            if (panelVisibility.ready) await panelVisibility.ready;
          } catch (e: any) {}
          if (runSession.isRunning) return;
          // 面板被用户主动关过：刷新后**不得**再把面板拉开。后台 run 因整页刷新已经失去
          // 本页 port，这里显式停止，避免 8s 宽限期后无声 abort、或再次触发自动重开。
          if (!panelVisibility.isOpen) {
            try {
              await sendPanelMessage('panel:run:stop', {
                runId: String(resp.runId),
                sessionId: panelSessionState.panelSessionId,
              });
            } catch (e: any) {}
            try {
              await loadConversation();
            } catch (e: any) {}
            return;
          }
          if (resp.live !== true) {
            showCitationHint('后台连接曾中断，已从已保存的进度继续本轮任务。');
          }
          await panelVisibility.withSuppressed(async () => {
            openPanel(0, 0, true, true); // 先让 openPanel 把 run 挂到 runAgent
          });
          // 对话历史若已恢复出这条用户消息，就跳过重复 push（见 run 的 skipUserTurn）。
          const last = panelSessionState.conversation.length ? panelSessionState.conversation[panelSessionState.conversation.length - 1] : null;
          const alreadyHas = last && last.role === 'user' && String(last.content || '').trim() === String(resp.instruction).trim();
          if (runSession.hasRunner) {
            runSession.invokeRunner(String(resp.instruction), {
              // live=true：run 还在跑，直接 reattach；否则才是 abort 后的续跑。
              continuation: resp.live !== true,
              reattach: resp.live === true,
              presetRunId: String(resp.runId),
              skipUserTurn: Boolean(alreadyHas),
              // 刷新前已经发生的工具步骤/叙述都在 SW 的运行快照里。没有它，
              // 新面板只能从"续跑之后"开始画，前半轮会凭空消失。
              resumeSnapshot: resp.snapshot || null,
            });
          }
        } else if (resp.pending) {
          setTimeout(tick, 300);
        }
      });
      p.postMessage({ type: 'query-run' });
    } catch (e: any) {
      try { if (p) p.disconnect(); } catch (e2) {}
    }
  };
  tick();
}

// ---- 事件绑定与初始化 ----
export function initAssistant(options: { runtime?: RuntimePort; dom?: DomPort; storage?: StoragePort } = {}) {
  if (options.runtime) runtimePort = options.runtime;
  if (options.dom) screenshotView.setDom(options.dom);
  if (options.storage) panelLayoutStorage = options.storage;
  installPanelLayoutSync();
  // 页面即将卸载（整页跳转 / 返回）前把对话落盘：这是用户消息"进对话即落盘"之外的
  // 一道兜底，盖住"刚发完立刻跳转"这类极小窗口。sendMessage 是尽力而为，不阻塞卸载。
  try {
    window.addEventListener('pagehide', () => {
      // 跟随页/刚加载到一半的标签页可能只有半截快照；它不该在卸载时把
      // 发起页刚落盘的最终回复回写成更短的版本。等正式消息收齐后 followedRunState
      // 会被 reset，此时再保存才是安全的。
      if (followedRun.followedRunState || followedRun.followedMessages.length) return;
      try { saveConversation(); } catch (e: any) {}
    });
  } catch (e: any) {}

  document.addEventListener('mousedown', (e) => {
    if (host && e.composedPath().includes(host)) return;
    closeSessionMenu();
    removeBubble();
  });
  // 自动批准浮层：点面板外、点面板内其它区域都要收起。
  // 用 composedPath 判断，才能正确穿透面板自己的 shadow root。
  document.addEventListener('pointerdown', (e) => {
    if (!streamView.approvalPopoverEl || streamView.approvalPopoverEl.hidden) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(streamView.approvalSettingsEl)) return;
    closeApprovalPopover();
  }, true);

  // 气泡收起时只露出右边一条；鼠标一旦离开「气泡地盘」就滑回贴边态。
  // 见 lib/page/fab-position.js 的 isPointerInFabZone：判据是坐标而不是 pointerleave。
  document.addEventListener('pointermove', (e) => fabPeek.handlePointerMove(e.clientX, e.clientY), true);

  document.addEventListener('scroll', () => removeBubble(), true);
  window.addEventListener('resize', () => {
    if (fab) applySavedFabPosition();
    // 窗口缩小后，用户手动摆放的面板可能大半个身子在视口外 —— 立刻夹回来并落盘，
    // 而不是等下一次打开才发现位置不对。
    clampPanelToViewport();
    if (panel && panel._manualPos) persistPanelLayoutNow({ size: false });
  });

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyR') {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) togglePanelFromShortcut();
      return;
    }
    if (e.key === 'Escape') {
      // 拾取模式下 Esc 用于「结束选取」，不要顺带关闭面板。
      if (streamView.picking) return;
      removeBubble();
      // 面板打开时由 panelKeyHandler 统一处理最上层浮层（弹窗 / 菜单 / 截图）。
      // 这里若再关一次面板，会在面板级处理器之前抢走 Esc，
      // 导致「关会话弹窗却把整个面板一起关掉」。
      if (panel) return;
    }
  }, true);

  document.addEventListener('mousemove', (e) => {
    // 高亮覆盖层不接管鼠标事件，改为根据 Range 判断指针是否进入/离开证据文本。
    // 只有用户实际进入过高亮内容后才在离开时清除，避免点击引用后立刻消失。
    const inCitation = isPointerInCitationRange(e);
    if (inCitation) streamView.citeHighlightEntered = true;
    else if (streamView.citeHighlightEntered) {
      streamView.citeHighlightEntered = false;
      clearCiteHighlight();
    }
    if (dragState && panel) {
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      let left = dragState.origLeft + dx;
      let top = dragState.origTop + dy;
      // 边界限制：保证面板完整可见（面板小于视口时），面板高于视口时至少保留头部可抓取，
      // 避免被拖出视口后无法再交互（尤其拖出底部后输入区不可达）。
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      const vp = panelViewport();
      const maxLeft = Math.max(0, vp.width - Math.min(pw, vp.width - 24));
      const maxTop = Math.max(0, vp.height - Math.min(ph, vp.height - 24));
      left = Math.min(Math.max(0, left), maxLeft);
      top = Math.min(Math.max(0, top), maxTop);
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      // 位置变化节流写入 localStorage（随页面持久化）。
      persistPanelLayoutThrottled();
    } else if (resizeState && panel) {
      const dw = e.clientX - resizeState.startX;
      const dh = e.clientY - resizeState.startY;
      const minW = 280, minH = 320;
      const vp = panelViewport();
      const maxW = Math.max(minW, vp.width - 24);
      const maxH = Math.max(minH, vp.height - 24);
      const leftSide = resizeState.origin.includes('left');
      const topSide = resizeState.origin.includes('top');
      const rightSide = resizeState.origin.includes('right');
      const bottomSide = resizeState.origin.includes('bottom');
      let w = Math.max(minW, Math.min(maxW, resizeState.origWidth + (leftSide ? -dw : (rightSide ? dw : 0))));
      let h = Math.max(minH, Math.min(maxH, resizeState.origHeight + (topSide ? -dh : (bottomSide ? dh : 0))));
      // 保持对边锚点：拉伸左/上边时，右/下边缘不动；拉伸右/下边时 left/top 不动。
      const r = panel.getBoundingClientRect();
      let left = r.left;
      let top = r.top;
      if (leftSide) left = r.right - w;
      if (topSide) top = r.bottom - h;
      // clamp 到视口内：面板完整可见（高度已被 maxH 限制，不会超过视口），
      // 避免拉伸导致面板底部/顶部被拖出视口后无法交互（“底部复位”问题）。
      left = Math.min(Math.max(0, left), Math.max(0, vp.width - w));
      top = Math.min(Math.max(0, top), Math.max(0, vp.height - h));
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
      // 手动拉伸后恢复消息区的 flex 布局，避免新增高度堆积在输入框下方。
      if (panelBody) {
        panelBody.style.flex = '1 1 auto';
        panelBody.style.height = 'auto';
        panelBody.style.overflowY = 'auto';
      }
      // 大小/位置变化节流写入 localStorage（随页面持久化）。
      persistPanelLayoutThrottled();
    }
  });
  document.addEventListener('mouseup', () => {
    // 拖拽/拉伸结束：立即持久化最终布局。
    if (dragState || resizeState) {
      if (layoutTimer) { clearTimeout(layoutTimer); layoutTimer = null; }
      persistPanelLayoutNow();
    }
    dragState = null;
    resizeState = null;
  });

  document.addEventListener('mouseup', (e) => {
    if (host && e.composedPath().includes(host)) return;
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (text.length < 2) {
      removeBubble();
      return;
    }
    lastText = text;
    clearCiteHighlight();
    pageText = streamView.pageContextEnabled ? extractPageText() : '';
    const range = sel!.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    if (panel) {
      refreshPanelForSelection();
      return;
    }
    ensureHost();
    // Range 与 fixed 定位的气泡都使用视口坐标；这里不能再叠加 scrollY。
    showBubble(rect.left + rect.width / 2, rect.top);
  });

  getAISettings().then((s) => {
    streamView.pageContextEnabled = s.pageContext !== false;
  }).catch(() => {});

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes) return;
      if (changes.aiSettings) refreshApiKeyBanner();
      if (!changes[FAB_POSITION_KEY]) return;
      const next: any = changes[FAB_POSITION_KEY].newValue;
      const ratio = normalizeFabRatio(next && next.ratio);
      if (ratio == null) return;
      fabCtl.setRatio(ratio);
      applySavedFabPosition();
    });
  } catch (e: any) {}

  // 拾取结果/取消由后台回传（跨域 iframe 内的命中也会经后台回到顶层）。
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'kbPickResult') {
        if (streamView.pickUi) {
          streamView.pickUi.setActive(false);
          streamView.pickUi.onPicked(msg.pickedList || msg.picked);
        } else {
          streamView.picking = false;
        }
      } else if (msg.type === 'kbPickCancel') {
        if (streamView.pickUi) streamView.pickUi.setActive(false);
        else streamView.picking = false;
      } else if (msg.type === 'panel:sessions-changed') {
        handleRemotePanelSessions(msg).catch(() => {});
      } else if (msg.type === 'panel:ui-changed') {
        panelVisibility.apply(msg).catch(() => {});
      } else if (msg.type === 'run:started') {
        handleRunStarted(msg);
      } else if (msg.type === 'run:delta') {
        handleRunDelta(msg);
      } else if (msg.type === 'run:ended') {
        if (String(msg.sessionId || '') === panelSessionState.panelSessionId) scheduleFollowedRunRefresh();
      } else if (msg.type === 'run:stopped') {
        // 跟随页发起的停止：owner 不在 runHub 的 delta 接收者里，必须由 SW 直接通知。
        if (
          String(msg.sessionId || '') === panelSessionState.panelSessionId &&
          String(msg.runId || '') === String(runSession.runId || '')
        ) {
          runSession.requestStop('remote');
        }
      } else if (msg.type === 'panel:lock-lost') {
        if (String(msg.id || '') !== panelSessionState.panelSessionId) return;
        if (String(msg.runId || '') && panelSessionState.panelSessionLockRunId && String(msg.runId) !== panelSessionState.panelSessionLockRunId) return;
        showCitationHint('另一个标签页已接管该会话，本页任务已停止。');
        runSession.requestStop();
      } else if (msg.type === 'panel:toggle') {
        togglePanelFromShortcut();
      }
      return false;
    });
  } catch (e: any) {
    warnExtDead();
  }

  // 导出期守卫先于任何宿主创建装好：Ctrl+S / 打印时它负责把宿主摘出文档。
  installExportGuard();

  // 一进来就把 FAB 挂上 —— 本地页也一样（理由见文件顶部那段说明：入口不做取舍）。
  ensureHost();
  // SPA 导航移除宿主后自动重建（详见函数注释）。宿主不存在时它什么都不做。
  watchHostKeepalive();

  // 恢复该标签页上次的对话（SPA 跳转 / 刷新后不丢上下文）。
  // 保存 promise 供 snapshotHandoff 等待，避免「对话还没读回来就打包交接包」的竞态。
  conversationLoadPromise = loadConversation();
  // 新页面继承全浏览器面板开合状态；远端切换时由 onMessage 的 panel:ui-changed 应用。
  panelVisibility.syncOnInit();
  // 整页刷新后自动接管"被中断的任务"：问 SW 本 tab 是否有可续跑的 run，
  // 有则重开面板、用同一 runId 续跑（SW 从持久化消息恢复，不重新执行）。
  maybeResumeRunAfterReload();

  // 跨页引用跳转落地：读取 URL 里的 kbSnippet 参数，容错高亮证据片段。
  // 页面（尤其 SPA）可能延迟渲染，做几次延迟重试。
  const kbSnippet = (typeof URLSearchParams !== 'undefined' && new URLSearchParams(location.search).get('kbSnippet')) || '';
  if (kbSnippet) {
    const snippet = decodeSnippet(kbSnippet);
    if (snippet) {
      const attempt = (tries: any) => {
        if (findAndHighlightCitation(snippet)) return;
        if (tries > 0) setTimeout(() => attempt(tries - 1), 700);
      };
      setTimeout(() => attempt(4), 300);
    }
  }
}

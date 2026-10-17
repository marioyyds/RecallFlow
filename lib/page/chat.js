// 网页端 AI 助手 UI：悬浮按钮(FAB)/划词气泡/对话面板 + Markdown 渲染 + 对话持久化
import { getAISettings, updateAISettings, AI_SETTINGS_DEFAULTS, resolveCodeExecutionApproval } from '../shared/settings.js';
import { composeProgressText, summarizePickedForMessage, pickedSummaryHtml, formatElementLocator } from '../shared/utils.js';
import { buildTranscript, serializeConversationMessages, alreadyCommittedAsText, buildPartialTurn, buildFailedTurn, buildInterruptedTurn } from './transcript.js';
import { createFrameScheduler } from './render-scheduler.js';
import { createLruCache } from '../shared/lru.js';

// 扩展被重新加载/停用后，旧内容脚本的 chrome.* 调用会抛 "Extension context invalidated"。
// 用它做防御性判断，避免未捕获异常刷屏。
function isExtContextAlive() {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return false;
    chrome.runtime.getManifest();
    return true;
  } catch (e) {
    return false;
  }
}
// 取扩展资源 URL；扩展上下文失效时返回空串，避免抛 "Extension context invalidated"。
function extUrl(path) {
  try {
    return chrome.runtime.getURL(path);
  } catch (e) {
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
    setTimeout(() => { try { d.remove(); } catch (e) {} }, 6000);
  } catch (e) {}
}
import { extractPageText } from './page-text.js';
import { newHandoffId, normalizeHandoffId, buildHandoffRecord, buildToolTrail, prepareHandoffTrail, formatHandoffPrompt } from '../shared/handoff.js';
import { clearCiteHighlight, isPointerInCitationRange, findAndHighlightCitation } from './citation.js';
import { escHtml, renumberCitations, renumberCitationsAcross, decodeSnippet, renderAnswer, planCitationOpen, parseSuggestionOptions } from './markdown.js';
import { PANEL_CSS } from './panel-css.js';
import { applyRunEvent, runStateToAssistantMessage } from '../assistant/run-hub.js';


let host = null;
let shadow = null;
let bubble = null;
let panel = null;
let panelBody = null;
let lastText = '';
let lastResponse = '';
let port = null;
let dragState = null;
let resizeState = null;
let pageText = '';
let panelTextEl = null;
let fab = null;
let conversation = [];
// 全浏览器共享的会话状态。正文仍只在内存里；Service Worker 是唯一写者。
let panelSessionId = '';
let panelSessionSeq = 0;
let panelSessionList = [];
let panelSessionActiveId = '';
let panelSessionMenuEl = null;
let panelSessionBtnEl = null;
let panelSessionMenuOpen = false;
let panelSessionSaveChain = Promise.resolve();
let panelSessionSwitchInFlight = false;
let deferredRemoteSessionId = '';
let panelSessionLockHeld = false;
let panelSessionLockRunId = '';
let activeInterruptFn = null;
// 全浏览器共享的面板开合状态。openTabs 由 Service Worker 维护，内容脚本只发
// “全局切换”或“本页已同步”的回执，避免远端应用状态时又触发一轮广播。
let panelUiSeq = 0;
let panelUiOpen = false;
let suppressPanelUiPublish = false;
let panelUiReadyPromise = null;
// 跟随另一个标签页的运行流。状态归约与 SW 使用同一份纯函数。
let followedRunState = null;
let followedRunId = '';
let followedCursor = 0;
let followedMessages = [];
let followRefreshTimer = null;
let followStatusTimer = null;
// ⚠ stopBtn / sendBtn 必须是**模块级**：模块级的 restoreStreamingUI()（流式重开面板时恢复 UI）
// 要用它们把"任务还在跑"的按钮状态恢复回来。sendBtn 原先声明在 openPanel 内部（const），
// 于是模块级函数一碰它就 ReferenceError —— 面板会**半构建**（连接口都没有），
// 而所有静态门禁都看不到这个作用域错误，只有真浏览器重开面板才暴露（本轮踩到）。
let stopBtn = null;
let sendBtn = null;
let streaming = false;
// openPanel 执行时把内部的 run 函数挂到这里，供模块级的自动续跑入口调用。
// （run 是 openPanel 里的闭包，模块级函数拿不到它 —— 用这个引用桥接。）
let runAgent = null;
let pendingAcc = '';
let pendingAiMsg = null;
let pendingContentEl = null;
let pendingStarted = false;
let pendingParts = [];
let budgetStopped = false;
let flowEl = null;
let pendingNarration = '';
let lastNarration = '';
let typingEl = null;
// ---- 思考记录（思维链）----
// **每段思考一块，按发生顺序穿插在对话流里**（思考 → 叙述 → 工具 → 思考 → …）。
// **默认折叠**：每块只显示一条可点击的折叠条（「思考中…」/「已思考（N 字）」），
// 用户点开才看全文 —— 需求原话是"思考中时应该折叠比较好，用户自己根据其需要展开"。
// 刻意**不**做成「一个总块 + 内层滚动条」：
//   ① 那样就丢掉了「这段思考是针对哪一步的」对应关系 —— 而它恰恰是思考记录最有用的部分；
//   ② 内层滚动条与面板自身的滚动会互相打架（滚轮到底了到底该滚哪个）。
// 定稿的段落进 pendingParts（type:'thinking'），位置由 push 顺序天然决定 ——
// 于是面板重建（关掉再打开、窗口重挂）也能按原顺序还原。
//
// 只有**推理模型**会发 reasoning 事件（deepseek-reasoner）；deepseek-chat 没有思维链，
// 此时这里全程为空，用户看到的仍是「正在输入」三个点 + FAB 呼吸动画。
//
// ⚠ 思维链**只用于展示**：它不进 conversation 的正文，也不会被写回请求 ——
// 既不破坏请求前缀缓存，也不会因为 reasoning_content 不是可回传字段而被 API 拒绝。
let thinkSeg = null;            // 当前**进行中**的那一段（定稿后置 null，下一段重新开块）
let thinkSegSeq = 0;            // 段序号：给渲染合并器当 key 用（见 pushReasoning 的注释）
// 用户对「当前段」是否手动开合过。**三态**（与 planExpanded 同一个理由）：
//   null = 没表过态 → **折叠**（这是默认：进行中也折叠，用户要看就自己点开）
//   true = 用户显式展开 → 不再自动收起，流式增量也不会把它合上
//   false = 用户显式收起 → 不再自动展开
// ⚠ "用户的选择优先"是**结构性**保证的：写 data-open 的地方只有两处 ——
//   mountThinkSegment（挂载时的初值）与下面的点击处理，外加 finishReasoning 里那处
//   `thinkExpandedManual === null` 守卫的写。**流式路径（pushReasoning）一个字都不写**，
//   所以新到的增量在结构上不可能把用户手动展开/折叠的状态改回去。
let thinkExpandedManual = null;
let activeRunId = null;
let planBar = null;
let lastPlan = [];
// 计划条的展开状态。**三态**：
//   null  = 用户没表过态 → 收成一行（默认）
//   true  = 用户显式要展开
//   false = 用户显式要收起
// 注意不能再写成「单一布尔 + 初值 true」：那样 `collapsed` 的判据会恒为 false，
// 收起分支永远进不去（截图里 8/8 全划掉却仍整块铺开，就是这个 bug）。
let planExpanded = null;
// 上一次渲染时「是否全部完成」。只在完成↔进行中**切换**时把 planExpanded 归零，
// 否则用户展开后每一次计划更新都会把它收回去。
let planWasAllDone = false;

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

// ---- 面板主题 ----
// 深色主题此前是死代码：CSS 里约 50 条 .panel.dark 规则，但全仓库没有任何地方加上 dark 类
// （panel.className 一直硬编码为 'panel'）。这里把它接上：默认跟随系统，可手动覆盖。
const THEME_KEY = 'recallflow-panel-theme';
let themeBtn = null;

function savedThemeOverride() {
  try {
    return localStorage.getItem(THEME_KEY) || '';
  } catch (e) {
    return '';
  }
}
function preferredTheme() {
  const saved = savedThemeOverride();
  if (saved === 'dark' || saved === 'light') return saved;
  try {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (e) {
    return 'light';
  }
}
function applyTheme() {
  if (!panel) return;
  const mode = preferredTheme();
  panel.classList.toggle('dark', mode === 'dark');
  if (themeBtn) {
    const override = savedThemeOverride();
    const label = override
      ? '主题：' + (mode === 'dark' ? '深色' : '浅色') + '（点击切换）'
      : '主题：跟随系统（点击切换）';
    themeBtn.textContent = override ? (mode === 'dark' ? '🌙' : '☀️') : '🌗';
    themeBtn.title = label;
    themeBtn.setAttribute('aria-label', label);
  }
}
function cycleTheme() {
  const cur = savedThemeOverride();
  const next = cur === '' ? 'dark' : cur === 'dark' ? 'light' : '';
  try {
    if (next) localStorage.setItem(THEME_KEY, next);
    else localStorage.removeItem(THEME_KEY);
  } catch (e) {}
  applyTheme();
}
try {
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onSys = () => {
    if (!savedThemeOverride()) applyTheme();
  };
  if (mq.addEventListener) mq.addEventListener('change', onSys);
  else if (mq.addListener) mq.addListener(onSys);
} catch (e) {}

// ---- 进度与耗时 ----
// Agent 每轮都会发 agent-state 事件，但前端此前没有任何处理器 ——
// 长任务只剩一行行工具往下滚，用户无从知道「第几步、多久了、是不是卡住了」。
let progressEl = null;
let progressMsgEl = null;
let progressTimeEl = null;
let progressTimer = null;
let runStartedAt = 0;
// 只保存「原始事实」，文案每帧从零拼装 ——
// 曾经把上一帧的完整文案当兜底值拼进来，结果累积成「第 4/32 步 · 第 3/32 步 · 第 3/32 步 · …」。
let progressState = '';
let progressStep = 0;
let progressMax = 0;
let panelKeyHandler = null;

// 状态取值来自 agent-state.js 的 RUN_STATUS。
const STATE_LABELS = {
  created: '准备中',
  planning: '规划步骤',
  waiting_approval: '等待你确认',
  executing: '执行动作',
  observing: '查看结果',
  paused: '已暂停',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  timeout: '已达上限',
};
function stateLabel(status) {
  const key = String(status || '').toLowerCase();
  return STATE_LABELS[key] || '';
}
function renderProgress() {
  if (progressTimeEl) {
    progressTimeEl.textContent = runStartedAt ? '已用时 ' + Math.round((Date.now() - runStartedAt) / 1000) + 's' : '';
  }
  if (progressMsgEl) progressMsgEl.textContent = composeProgressText(progressStep, progressMax, progressState);
}
function startProgress() {
  runStartedAt = Date.now();
  progressState = '';
  progressStep = 0;
  progressMax = 0;
  if (progressEl) progressEl.classList.add('on');
  renderProgress();
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(renderProgress, 1000);
}
function stopProgress() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
  if (progressEl) progressEl.classList.remove('on');
  runStartedAt = 0;
  progressState = '';
  progressStep = 0;
  progressMax = 0;
}
let keepAliveTimer = null;
let usageEl = null;
// 交接标识：把本次会话打包给外部 agent（opencode / DSH 等）凭标识经 MCP 取回。
// 存在 localStorage 里按来源隔离（每个站点一个），清空对话时轮换新标识。
let handoffId = '';
let conversationLoaded = false;
let conversationLoadPromise = null;
let handoffEl = null;
let pickedElements = []; // 当前已拾取的元素（单选取为 1 个，多选取为多个）
let pickUi = null; // 当前面板的拾取 UI 引用 { setActive, onPicked }
let picking = false;
let currentCitations = null; // 当前回答的引用来源元数据
let pageContextEnabled = true;
let citeHighlightEntered = false;
// 每个页面各自独立的对话（conversation 仅存于本页内存），不做跨 tab 同步。

function ensureHost() {
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
  host = document.createElement('div');
  host.id = '__kb-ai-host';
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
  fab.title = 'RecallFlow';
  fab.setAttribute('aria-label', '打开 RecallFlow');
  fab.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePanel();
  });
  fab.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  shadow.appendChild(fab);

  document.documentElement.appendChild(host);
}

/**
 * 复位「宿主已被 SPA 导航从 DOM 移除」留下的悬空 DOM 引用。
 *
 * 为什么不用 removePanel()：它会按 `panel.offsetWidth/Height` 把**当前尺寸**写回 localStorage ——
 * 这里 panel 已经脱离 DOM、offset 全是 0，会把用户保存的面板尺寸覆盖成 0×0。
 * 所以只清引用；port / streaming / conversation 全部保留（与「流式中关闭面板」同一原则）。
 */
function resetDetachedHostState() {
  if (picking) {
    try { chrome.runtime.sendMessage({ type: 'pick:cancel' }); } catch (e) {}
    picking = false;
    if (pickUi) pickUi = null;
  }
  if (panelKeyHandler) {
    document.removeEventListener('keydown', panelKeyHandler, true);
    panelKeyHandler = null;
  }
  panel = null;
  panelBody = null;
  panelTextEl = null;
  planBar = null;
  stopBtn = null;
  sendBtn = null;
  bubble = null;
  host = null;
  shadow = null;
  fab = null;
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
      if (host && !host.isConnected) {
        ensureHost();
        // SPA（Turbo 等）导航会连面板 DOM 一起换掉：若此刻任务仍在跑，
        // 重新打开面板并恢复流式 UI，否则用户只能看到一个没有输出的空面板/关闭状态。
        if (panelUiOpen) {
          openPanel(0, 0, true);
          if (streaming) restoreStreamingUI();
        }
      }
    } catch (e) {}
  }, 1000);
}

function removeBubble() {
  if (bubble) {
    bubble.remove();
    bubble = null;
  }
}

function publishPanelUi(open, scope) {
  panelUiOpen = open === true;
  if (suppressPanelUiPublish) return Promise.resolve(null);
  return sendPanelMessage('panel:ui:set', {
    open: panelUiOpen,
    scope: scope === 'membership' ? 'membership' : 'global',
  })
    .then((res) => {
      if (res && res.ok && res.ui) {
        const seq = Number(res.ui.seq) || 0;
        // 快速“开→关”时两个响应可能乱序；只接受不比本页已见版本更旧的权威值。
        if (seq >= panelUiSeq) {
          panelUiSeq = seq;
          panelUiOpen = res.ui.open === true;
        }
      }
      return res;
    })
    .catch(() => null);
}

async function applyPanelUiState(ui) {
  if (!ui) return;
  const seq = Number(ui.seq) || 0;
  if (seq < panelUiSeq) return;
  panelUiSeq = seq;
  panelUiOpen = ui.open === true;
  if (panelUiOpen) {
    if (!panel) {
      suppressPanelUiPublish = true;
      try {
        ensureHost();
        lastText = '';
        pageText = pageContextEnabled ? extractPageText() : '';
        openPanel(0, 0, true);
      } finally {
        suppressPanelUiPublish = false;
      }
    }
    await publishPanelUi(true, 'membership');
  } else {
    if (panel) {
      suppressPanelUiPublish = true;
      try {
        removePanel({ publish: false });
      } finally {
        suppressPanelUiPublish = false;
      }
    }
    await publishPanelUi(false, 'membership');
  }
}

async function syncPanelUiOnInit() {
  const res = await sendPanelMessage('panel:ui:get');
  if (!res || !res.ok || !res.ui) return;
  const seq = Number(res.ui.seq) || 0;
  if (seq < panelUiSeq) return;
  panelUiSeq = seq;
  panelUiOpen = res.ui.open === true;
  if (panelUiOpen) await applyPanelUiState(res.ui);
}

function removePanel(options) {
  const hadPanel = Boolean(panel);
  // 关闭面板时若仍在拾取模式，通知后台让所有 frame 停止拾取。
  if (picking) {
    try { chrome.runtime.sendMessage({ type: 'pick:cancel' }); } catch (e) {}
    picking = false;
    if (pickUi) pickUi.setActive(false);
  }
  // 流式中关闭面板只是「隐藏」：不关 port、不 endStream，让助手继续生成，
  // 重新打开时能恢复正在输出的内容（见 restoreStreamingUI）。
  if (!streaming) closePort();
  // 解除 document 级 Esc 监听，避免面板关闭后仍捕获按键。
  if (panelKeyHandler) {
    document.removeEventListener('keydown', panelKeyHandler, true);
    panelKeyHandler = null;
  }
  shotLightboxOpen = false; // 放大层随面板一起移除，标记必须复位，否则下次 Esc 关不掉面板
  clearCiteHighlight();
  if (panel) {
    if (panel.offsetWidth && panel.offsetHeight) localStorage.setItem('recallflow-panel-size', JSON.stringify({ width: panel.offsetWidth, height: panel.offsetHeight }));
    if (panel._manualPos || panel.style.top !== 'auto') { const r = panel.getBoundingClientRect(); localStorage.setItem('recallflow-panel-pos', JSON.stringify({ left: r.left, top: r.top })); }
    panel.remove();
    panel = null;
    panelBody = null;
    panelTextEl = null;
    // 计划条随面板一起被销毁：置空避免流式过程中（面板已隐藏但助手仍在跑）
    // renderPlan 往一个脱离文档的节点里写。重开面板时由 renderConversation 回填。
    planBar = null;
    if (fab) fab.classList.remove('hidden');
  }
  if (hadPanel && !(options && options.publish === false)) publishPanelUi(false, 'global');
  if (hadPanel && !(options && options.publish === false)) {
    resetFollowedRun();
    sendPanelMessage('panel:run:unsubscribe').catch(() => {});
  }
}

function closePort() {
  if (port) {
    try {
      port.disconnect();
    } catch (e) {}
    port = null;
  }
}

function showBubble(x, y) {
  if (!shadow) return; // host 未创建（如扩展上下文已失效）
  removeBubble();
  removePanel({ publish: false });
  bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = '<span class="dot"></span><span>RecallFlow</span>';
  bubble.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  bubble.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPanel(x, y);
  });
  shadow.appendChild(bubble);
  const r = bubble.getBoundingClientRect();
  const left = Math.min(Math.max(4, x), window.innerWidth - r.width - 4);
  const top = y - r.height - 8 > 4 ? y - r.height - 8 : y + 12;
  bubble.style.left = left + 'px';
  bubble.style.top = top + 'px';
}

function togglePanel() {
  if (panel) {
    removePanel();
  } else {
    ensureHost();
    lastText = '';
    pageText = pageContextEnabled ? extractPageText() : '';
    openPanel(0, 0, true);
  }
}

// 根据内容自动调整面板高度
function fitPanelHeight() {
  if (!panel || !panelBody) return;
  // ⚠ **先记住"改高度之前是否贴着底"**：下面会把 `panel`/`panelBody` 的高度重置成 `auto` 再重算，
  //   而**滚动容器高度一变，浏览器就会把 `scrollTop` 归零/夹紧** ✗ —— 本函数有 28 个调用点，
  //   其中一大批在**流式渲染路径**上（每来一段正文/思考增量都会调）⇒ 视图就这样一遍遍**跳回顶部** ✓
  //   这正是用户反馈"模型在思考的时候，没有流式置底"的**真根因** ✓
  //   （之前只给渲染回调加置底是**治标**：置底之后紧接着一次 fitPanelHeight 又把它抹掉了 ✗）
  const wasPinned =
    !!observerAutoScroll ||
    panelBody.scrollHeight - panelBody.scrollTop - panelBody.clientHeight < 40;
  // 用户调整过窗口尺寸后，严格尊重用户配置，不再覆盖高度。
  if (panel._manualSize) return;
  // 使用视口比例避免 4K 屏幕上面板贴得过低；桌面端限制上下限保证稳定。
  const dockGap = getDockGap();
  const topLimit = Math.max(12, Math.round(window.innerHeight * 0.10));
  // 停靠模式以底部为锚点，最大高度不超过顶部安全区；增长时只向上扩展。
  let maxH = Math.max(320, window.innerHeight - dockGap - topLimit);
  // 底部固定控件（审批/自动批准/输入区/底栏）可能本身就很高。此时若仍坚持
  // “对话区至少 120px”并锁死上面算出的 maxH，溢出内容会被 `overflow:hidden` 裁掉，
  // 底部 resize 手柄还会盖住原本可见的按钮。允许向视口内继续扩展，优先保证控件可点。
  const hardMaxH = Math.max(320, window.innerHeight - 24);
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
  panelBody.style.flex = 'none';
  panelBody.style.height = bodyH + 'px';
  panelBody.style.overflowY = bodyNatH > bodyH ? 'auto' : 'hidden';
  const totalH = Math.min(maxH, Math.max(320, chromeH + bodyH));
  panel.style.height = totalH + 'px';
  if (panel.classList.contains('docked') && !panel._manualPos) {
    panel.style.top = 'auto';
    panel.style.bottom = dockGap + 'px';
  }
  // ⚠ 收尾：**如果本来贴着底，改完高度要再置底一次** —— 否则上面那次高度重算导致的归零就留在那儿了 ✗
  //   只认"**本来贴底**"（`wasPinned` 在入口处算好 ✓）：用户自己滚上去看历史时，这里**不许**把他拽回来 ✓
  //   ⚠ 不要在这里再读一次 `observerAutoScroll` —— 改高度本身也可能触发一次 scroll 事件把它置 false ✗
  //
  //   ⚠ 另外必须 `markSelfScroll()`：本函数改的是**容器高度**，浏览器会因此自己夹紧 `scrollTop`
  //     并派发 scroll 事件；不屏蔽的话，那次事件会被当成"用户滚上去看历史"而**永久**关掉自动跟随
  //     （实测轨迹见 openPanel 里 scroll 监听器处的注释）。
  markSelfScroll();
  if (wasPinned) panelBody.scrollTop = panelBody.scrollHeight;
}

// 停靠模式使用相对视口高度的底部留白：大屏幕适当上移，小屏幕保持紧凑。
function getDockGap() {
  return window.innerWidth <= 640 ? 12 : Math.min(520, Math.max(120, Math.round(window.innerHeight * 0.30)));
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
function pinToBottom() {
  if (!observerAutoScroll) return false;
  if (!panelBody || !panelBody.isConnected) return false;
  markSelfScroll();
  panelBody.scrollTop = panelBody.scrollHeight;
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

// ---- 轻量语法高亮 ----
// AI 回复底部操作栏（元宝风格：复制等）
function msgActionsHtml(isLast) {
  return (
    '<div class="msg-actions"><button class="act-copy" title="复制回答内容">⧉ 复制</button>' +
    (isLast ? '<button class="act-regen" title="按上一条指令重新生成">⟳ 重新生成</button>' : '') +
    '</div>'
  );
}

// ---- 工具步骤渲染：默认一行摘要，点开看完整参数/结果 ----

// 摘要里只显示「最能说明这一步在做什么」的参数，避免摘要行过长。
function argHint(args) {
  if (!args || typeof args !== 'object') return '';
  if (typeof args.query === 'string') return args.query;
  if (typeof args.id === 'string') return args.id;
  if (typeof args.selector === 'string') return args.selector;
  if (Array.isArray(args.selectors) && args.selectors.length) {
    const head = args.selectors.slice(0, 3).join('、');
    return args.selectors.length > 3 ? head + ' 等 ' + args.selectors.length + ' 个' : head;
  }
  if (typeof args.text === 'string') return args.text;
  // type_text 的负载是 value；不写这一条时，步骤行会退化成「ref、clearFirst」这种键名提示。
  if (typeof args.value === 'string') return args.value;
  if (typeof args.urls === 'object' && args.urls) return '';
  if (typeof args.url === 'string') return args.url;
  if (typeof args.code === 'string') return args.code.replace(/\s+/g, ' ').slice(0, 60);
  const keys = Object.keys(args).filter((k) => args[k] !== undefined && args[k] !== '');
  return keys.length ? keys.slice(0, 3).join('、') : '';
}

function clipDetail(text, max) {
  const t = String(text === undefined || text === null ? '' : text);
  if (!t) return '';
  return t.length > max ? t.slice(0, max) + '\n…（共 ' + t.length + ' 字符，已截断）' : t;
}

// 工具步骤 HTML：有细节时输出 <details>（原生可键盘展开，顺带满足可访问性）。
function toolStepHtml(lead, name, hint, detailLabel, detail) {
  const head =
    '<span class="agent-tool">' + escHtml(lead) + escHtml(name) + '</span>' +
    (hint ? '<span class="agent-tool-arg">：' + escHtml(hint) + '</span>' : '');
  if (!detail) return '<div class="agent-step">' + head + '</div>';
  return (
    '<details class="agent-step"><summary>' + head + '</summary>' +
    '<div class="agent-step-detail">' +
    (detailLabel ? '<div class="agent-step-label">' + escHtml(detailLabel) + '</div>' : '') +
    '<pre class="agent-step-pre">' + escHtml(detail) + '</pre>' +
    '</div></details>'
  );
}

function toolStepElement(lead, name, hint, detailLabel, detail) {
  const wrap = document.createElement('div');
  wrap.innerHTML = toolStepHtml(lead, name, hint, detailLabel, detail);
  return wrap.firstElementChild;
}

// ---- 截图渲染 ----
// base64 只存内存缓存，不写进 pendingParts：会话会被持久化到 chrome.storage.session，
// 每张图几百 KB 会把存储撑爆。重载后面板如实显示「已失效」而不是留个坏图。
//
// 容量必须受限：内容脚本的生命周期等于页面生命周期，而每张截图是几百 KB ——
// 原先是个只写不删的 Map，长时间自动化会话里内存只涨不落。
// 用 LRU 而不是 FIFO：正在看的那张往往会被反复读取，不该先被淘汰。
const SHOT_CACHE_MAX = 30;
const shotCache = createLruCache(SHOT_CACHE_MAX);
let shotLightboxOpen = false;

function shotCapText(meta) {
  const m = meta || {};
  const parts = [];
  if (m.label) parts.push(String(m.label));
  if (m.width && m.height) parts.push(m.width + '×' + m.height);
  if (m.bytes) parts.push(Math.round(Number(m.bytes) / 1024) + 'KB');
  return parts.join(' · ');
}

function screenshotHtml(meta) {
  const m = meta || {};
  const url = m.id ? shotCache.get(m.id) : '';
  if (!url) {
    return (
      '<div class="agent-shot gone">🖼 截图' +
      (m.label ? '（' + escHtml(String(m.label)) + '）' : '') +
      '：已随页面重载失效（图片不写入对话存储，避免撑爆配额）</div>'
    );
  }
  return (
    '<div class="agent-shot"><img src="' +
    escHtml(url) +
    '" alt="' +
    escHtml(String(m.label || '页面截图')) +
    '" loading="lazy"><span class="agent-shot-cap">🖼 ' +
    escHtml(shotCapText(m)) +
    ' · 点击放大</span></div>'
  );
}

function screenshotElement(meta) {
  const wrap = document.createElement('div');
  wrap.innerHTML = screenshotHtml(meta);
  return wrap.firstElementChild;
}

function openShotLightbox(url) {
  if (!url || !panel) return;
  const box = document.createElement('div');
  box.className = 'shot-lightbox';
  const img = document.createElement('img');
  img.src = url;
  box.appendChild(img);
  const close = () => {
    box.remove();
    shotLightboxOpen = false;
  };
  box.addEventListener('click', close);
  shotLightboxOpen = true;
  panel.appendChild(box);
}

function userActionsHtml(index) {
  return '<div class="user-actions"><button class="act-rewind" data-turn-index="' + index + '" title="撤销这条指令及其后续对话">↶ 撤销</button><button class="act-user-copy" title="复制这条指令">⧉ 复制</button></div>';
}

let layoutTimer = null;

// 节流持久化面板布局（避免拖拽/拉伸 mousemove 高频写入）。
function persistPanelLayoutThrottled() {
  if (layoutTimer || !panel) return;
  layoutTimer = setTimeout(() => { layoutTimer = null; persistPanelLayoutNow(); }, 200);
}

// 立即把当前面板布局写入 localStorage。
function persistPanelLayoutNow() {
  if (!panel) return;
  const r = panel.getBoundingClientRect();
  const layout = { width: panel.offsetWidth, height: panel.offsetHeight, left: Math.round(r.left), top: Math.round(r.top) };
  try {
    localStorage.setItem('recallflow-panel-size', JSON.stringify({ width: layout.width, height: layout.height }));
    localStorage.setItem('recallflow-panel-pos', JSON.stringify({ left: layout.left, top: layout.top }));
  } catch (e) {}
}

// 若会话最后一条是含 <options> 的触底决策建议，渲染可点击方案按钮（防重复渲染）。
function renderDecisionButtonsIfPresent() {
  if (!panelBody || !panel) return;
  if (panelBody.querySelector('.suggestion-options')) return;
  const last = conversation[conversation.length - 1];
  if (last && last.role === 'assistant' && /<options>/i.test(String(last.content || ''))) {
    renderSuggestionButtons(panelBody, last.content, panel._sendFn || activeSendFn);
    fitPanelHeight();
  }
}

// 流式中面板被关闭后重新打开：恢复「正在生成的回复」UI。
// 流式状态（pendingNarration/pendingAcc/pendingParts/flowEl 等）都在模块级变量里，
// 不因面板 DOM 重建而丢失，重新挂接元素即可让后续 chunk/end 继续写进新面板。
//
// ⚠ 下面两个思考记录的挂载函数**必须留在模块顶层**：
// 它们被本函数（模块级）调用，而 openPanel 内部的函数在模块级不可见。
// 这个坑真实发生过一次 —— 当时把 mountThinkSegment 写在 openPanel 里，
// 于是「流式中重开面板」这条路一走到就 ReferenceError，而
// ① 接线门禁是源码正则（看不到作用域）② E2E 从没在流式中重开过面板 —— 两边都没抓到。
// 现在有 tests/panel-scope.test.mjs 专门盯「模块级函数不得调用更深层的函数」。

/**
 * 思考块的标题文案（**唯一来源**：实时刷新与标记生成共用，避免两处文案漂移）。
 *
 * 「保存时已截断」不是装饰：持久化会按 `MAX_PART_TEXT_CHARS` 裁掉超长思维链
 *（见 lib/page/transcript.js 的 clipPart），若重开面板后把它当成完整全文显示，
 * 用户会以为模型只想到这儿 —— 本仓库硬纪律：丢东西必须说明。
 */
function thinkLabelText(done, len, truncated) {
  if (!done) return '思考中…';
  return '已思考（' + len + ' 字' + (truncated ? '，保存时已截断' : '') + '）';
}

/** 按段状态刷新思考记录的标题（进行中 / 已思考 + 字数）。 */
function refreshThinkHead(seg) {
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
function thinkBlockHtml(text, opts) {
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
function mountThinkSegment(seg, open) {
  if (!flowEl) return null;
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
  flowEl.appendChild(block);
  return block;
}

function restoreStreamingUI() {
  if (!panelBody || !streaming) return;
  if (pendingContentEl && pendingContentEl.isConnected) return; // 已恢复过
  const aiMsg = document.createElement('div');
  aiMsg.className = 'msg ai';
  const flow = document.createElement('div');
  flow.className = 'agent-flow';
  aiMsg.appendChild(flow);
  // ⚠ **必须在下面的循环之前**把 flowEl 指向新的 flow。
  //   循环里的 `mountThinkSegment()` 是往**模块级 flowEl** 追加的，而叙述段/工具步骤用的是
  //   局部 `flow`（所以它们不受影响）。而关面板时 `removePanel()` 并**不**清空 flowEl，
  //   于是重开时 flowEl 还指着**上一个面板的孤儿节点** ⇒ 思考块全被追加到那儿，一个都看不见 ✗
  //   症状正是用户实测的"流式输出中途关掉再打开，停止与思考都没了"（其它都在、只有思考没）。
  //   ⚠ 这条路径此前**没有任何 E2E** 走过：旧用例只在"一轮结束之后"关面板，那时走的是
  //   renderConversation（不经过本函数），于是这个顺序错误一直没被抓住。
  flowEl = flow;
  // 已固化的叙述段与工具步骤先渲染回 flow。
  for (const p of pendingParts) {
    if (p.type === 'thinking' && p.text) {
      // 思考记录也是 flow 的一环，必须按原位置还原 ——
      // 否则重开面板后所有思考都会挤到最前面，与它前后步骤的对应关系就没了。
      mountThinkSegment({ text: p.text, done: true, block: null, body: null });
    } else if (p.type === 'narration' && p.text) {
      const d = document.createElement('div');
      d.className = 'agent-content';
      d.innerHTML = renderAnswer(p.text, currentCitations, false);
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
    }
  }
  const contentEl = document.createElement('div');
  contentEl.className = 'agent-content';
  if (pendingNarration) {
    contentEl.innerHTML = renderAnswer(pendingNarration, currentCitations, true);
  } else {
    contentEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  }
  flow.appendChild(contentEl);
  panelBody.appendChild(aiMsg);
  pendingAiMsg = aiMsg;
  pendingContentEl = contentEl;
  // 流式中关闭过面板再打开：**进行中**的那段思考也要恢复（它的位置在所有已固化步骤之后、
  // 正文之前）。已定稿的段已由上面的 pendingParts 循环按原位置还原 ——
  // 它们的展开态回到默认（折叠）；而**进行中这一段**要把用户刚才的手动选择带回来，
  // 否则"重开面板"就等于替他改了一次选择。
  if (thinkSeg && thinkSeg.text) {
    thinkSeg.block = null;
    thinkSeg.body = null;
    mountThinkSegment(thinkSeg, thinkExpandedManual === true);
  }
  typingEl = pendingNarration ? null : contentEl;
  pendingStarted = pendingStarted || Boolean(pendingNarration || pendingAcc);
  pendingAiMsg._raw = pendingAcc;
  // 重开面板时把进度条也恢复上（保留原计时，不重置已用时）。
  if (progressEl) {
    if (!runStartedAt) runStartedAt = Date.now();
    progressEl.classList.add('on');
    renderProgress();
    if (!progressTimer) progressTimer = setInterval(renderProgress, 1000);
  }
  // 注意：这里**不要**去动「■ 停止」/「发送」的按钮状态 ——
  // 本函数跑在 openPanel 里**早于**那两个按钮的创建（见 openPanel 中创建它们的注释），
  // 在这儿碰到的只会是上一个面板遗留的、已脱离文档的按钮。它们的初值由创建处以
  // `streaming` 为准（这样流式中重开也能一次就对）。
  fitPanelHeight();
  pinToBottom();
}

// 面板内短暂提示（如引用定位失败）。
function showCitationHint(text) {
  if (!panelBody) return;
  const hint = document.createElement('div');
  hint.style.cssText = 'color:#b45309;font-size:11px;margin:4px 0;padding:4px 6px;background:rgba(180,83,9,.08);border-radius:4px;';
  hint.textContent = text;
  panelBody.appendChild(hint);
  fitPanelHeight();
  setTimeout(() => { if (hint.parentNode) hint.parentNode.removeChild(hint); }, 5000);
}

// 当前面板的发送函数（openPanel 里绑定 run），供 renderSuggestionButtons 触发「继续」。
let activeSendFn = null;

// 解析触底建议中的「可选操作」，返回 [{label, desc}]（最多 4 条）。
// 把建议按钮渲染到 AI 回复下方；点击后以「继续上一任务」方式重发指令。
// sendFn 用于绑定「所属面板」的发送函数。
function renderSuggestionButtons(container, text, sendFn) {
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
      if (streaming) return;
      const fn = sendFn || activeSendFn;
      if (typeof fn === 'function') {
        fn(opt.label + (opt.desc ? '：' + opt.desc : ''), { continuation: true });
      }
    });
    wrap.appendChild(b);
  });
  container.appendChild(wrap);
}

function renderConversation() {
  if (!panelBody) return;
  const view = followedMessages.length ? conversation.concat(followedMessages) : conversation;
  if (!view.length) {
    panelBody.className = 'p-body';
    panelBody.innerHTML = '<div class="msg ai">' + (lastText ? '输入指令，AI 将基于选中文本执行。' : '输入指令，AI 将直接执行（可基于知识库）。') + '</div>';
    renderPlan([]);
    return;
  }
  // 渲染引用来源区域
  const citeSourcesHtml = (cites) => {
    if (!cites || !cites.length) return '';
    return (
      '<div class="cite-sources"><span class="cite-label">参考来源：</span>' +
      cites
        .map(
          (c) =>
            '<button class="cite-badge" data-cite-id="' + escAttr(c.id || '') + '" data-cite-source="' + escAttr(c.source || 'kb') + '" data-cite-url="' + escAttr(c.url || '') + '" data-cite-snippet="' + escAttr(c.snippet || '') + '" title="打开证据：' + escAttr(c.title) + '">' +
            '<span class="cite-idx">[' + c.index + ']</span>' + escAttr(c.title.length > 18 ? c.title.slice(0, 18) + '…' : c.title) + '</button>'
        )
        .join('') +
      '</div>'
    );
  };
  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  panelBody.className = 'p-body';
  panelBody.innerHTML = view
    .map((m, index) => {
      if (m.role === 'user') {
        return '<div class="user-turn"><div class="msg user">' + escHtml(m.content) + pickedSummaryHtml(m.pickedElements) + '</div>' + (m.live ? '' : userActionsHtml(index)) + '</div>';
      }
      const parts = Array.isArray(m.parts) ? m.parts : [];
      const flowHtml = parts
        .map((p) => {
          if (p.type === 'tool-call') {
            return toolStepHtml('🔧 ', p.name, argHint(p.args), '参数', clipDetail(JSON.stringify(p.args || {}, null, 2), 2000));
          }
          if (p.type === 'tool-result') {
            return toolStepHtml(
              p.status === 'completed' ? '✓ 工具已完成：' : p.status === 'failed' ? '✗ 工具失败：' : '— 工具未执行：',
              p.name,
              '',
              p.status === 'failed' ? '错误信息' : '返回结果',
              clipDetail(p.result, 4000)
            );
          }
          if (p.type === 'screenshot') {
            return screenshotHtml(p);
          }
          if (p.type === 'thinking' && p.text) {
            // 思考记录必须能在重开面板后重建 —— 否则用户看到的是「思考历史凭空消失」（实测反馈）。
            // 位置由 parts 顺序决定。⚠ 已知差异：两段思考之间**没有工具步骤**时，
            // 中间那段正文从未固化成 narration part（一路留在 pendingNarration 到 'end'），
            // 因此 parts 里它排在两段思考之后 ⇒ 重建后正文出现在两块思考之下。
            // 这是 parts 模型本来的信息缺口，不是本次修复引入的（详见 E2E 的 ⑨ 说明）。
            // 定稿态挂载（done）：静止的历史段不该继续跑"思考中"的动画。
            if (p.live) return thinkBlockHtml(p.text, { done: false, truncated: p.textTruncated === true });
            return thinkBlockHtml(p.text, { done: true, truncated: p.textTruncated === true });
          }
          if (p.type === 'narration' && p.text) {
            return '<div class="agent-content">' + renderAnswer(p.text, m.citations, false) + '</div>';
          }
          if (p.type === 'text' && p.text) {
            return '<div class="agent-content">' + renderAnswer(p.text, m.citations, false) + '</div>';
          }
          if (p.type === 'notice' && p.text) {
            return '<div class="agent-step" style="color:' + escAttr(p.color || '#6b7280') + '">' + escHtml(p.text) + '</div>';
          }
          return '';
        })
        .join('');
      const hasInlineText = parts.some((p) => p.type === 'narration' || (p.type === 'text' && p.text));
      // 失败 / 中断的一轮**强制**渲染 content：它们的原因文字与「已中断」说明只放在 content 里
      //（不占一个 text part，否则导出侧会跳过「### 失败 / ### 中断」标题），
      // 而 hasInlineText 只统计 parts —— 一旦这一轮之前有过叙述，原因就会被整段藏起来。
      const contentHtml = hasInlineText && !m.failed && !m.interrupted ? '' : renderAnswer(m.content || '', m.citations);
      // 失败保持红色、中断用琥珀色：否则刷新之后看起来像一条正常的 AI 回复。
      const failedStyle = m.failed ? ' style="color:#e74c3c"' : m.interrupted ? ' style="color:#b45309"' : '';
      const typingHtml = m.live && !flowHtml && !contentHtml ? '<span class="typing"><span></span><span></span><span></span></span>' : '';
      const sourceHtml = !m.live || m.showCitations ? citeSourcesHtml(m.citations) : '';
      return (
        '<div class="msg ai"' + failedStyle + '>' + '<div class="agent-flow">' + flowHtml + '</div>' +
        contentHtml +
        typingHtml +
        sourceHtml +
        (m.content && !m.live ? msgActionsHtml(index === view.length - 1) : '') +
        '</div>'
      );
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
  followedMessages = [];
  if (!followedRunState) return;
  const instruction = String(followedRunState.instruction || '').trim();
  const last = conversation.length ? conversation[conversation.length - 1] : null;
  const alreadyHasUser =
    last && last.role === 'user' && String(last.content || '').trim() === instruction;
  if (instruction && !alreadyHasUser) {
    followedMessages.push({ role: 'user', content: instruction, live: true });
  }
  const assistant = runStateToAssistantMessage(followedRunState);
  if (assistant) followedMessages.push(assistant);
}

function followedRunCommitted() {
  if (!followedRunState) return false;
  const instruction = String(followedRunState.instruction || '').trim();
  if (!instruction) return false;
  let userIndex = -1;
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (conversation[i] && conversation[i].role === 'user' && String(conversation[i].content || '').trim() === instruction) {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return false;
  return conversation.slice(userIndex + 1).some((m) => m && m.role === 'assistant' && !m.live);
}

function renderFollowedRun() {
  if (!panelBody) return;
  streamRender.schedule('follow-live', () => {
    renderConversation();
    fitPanelHeight();
    pinToBottom();
  });
  if (usageEl) usageEl.textContent = followedRunState && followedRunState.tokens ? 'tokens ' + followedRunState.tokens : '';
  if (followedRunState && followedRunState.status === 'running') {
    if (sendBtn) sendBtn.disabled = true;
    if (progressEl) {
      progressEl.classList.add('on');
      runStartedAt = Number(followedRunState.startedAt) || Date.now();
      progressState = stateLabel(followedRunState.progress && followedRunState.progress.state) || '跟随运行';
      progressStep = Number(followedRunState.progress && followedRunState.progress.step) || 0;
      progressMax = Number(followedRunState.progress && followedRunState.progress.max) || 0;
      if (!progressTimer) progressTimer = setInterval(renderProgress, 1000);
      renderProgress();
    }
  }
  ensureFollowedRunWatch();
}

function ensureFollowedRunWatch() {
  if (followStatusTimer) return;
  followStatusTimer = setInterval(async () => {
    if (!followedRunState) {
      clearInterval(followStatusTimer);
      followStatusTimer = null;
      return;
    }
    if (followRefreshTimer) return;
    const sessionId = panelSessionId;
    const res = await sendPanelMessage('panel:run:subscribe', { sessionId });
    if (sessionId !== panelSessionId) return;
    if (res && res.ok && res.snapshot && res.snapshot.status === 'running') {
      followedRunState = res.snapshot;
      followedRunId = res.snapshot.runId;
      followedCursor = Number(res.snapshot.cursor) || 0;
      rebuildFollowedMessages();
      renderFollowedRun();
      return;
    }
    // run 已结束，或 SW 已没有这个 run。结束广播可能在页面重载窗口里丢失，
    // 这里用轮询作为兜底；最终以落盘会话为准。
    scheduleFollowedRunRefresh();
  }, 1200);
}

function resetFollowedRun(options) {
  const opts = options || {};
  if (followRefreshTimer) {
    clearTimeout(followRefreshTimer);
    followRefreshTimer = null;
  }
  if (followStatusTimer) {
    clearInterval(followStatusTimer);
    followStatusTimer = null;
  }
  followedRunState = null;
  followedRunId = '';
  followedCursor = 0;
  followedMessages = [];
  if (!streaming) {
    stopProgress();
    if (sendBtn) sendBtn.disabled = false;
  }
  if (opts.render) {
    renderConversation();
    fitPanelHeight();
  }
}

function applyFollowedSnapshot(snapshot) {
  if (!snapshot || !snapshot.runId) {
    resetFollowedRun({ render: true });
    return;
  }
  if (snapshot.status !== 'running') {
    scheduleFollowedRunRefresh();
    return;
  }
  followedRunState = snapshot;
  followedRunId = snapshot.runId;
  followedCursor = Number(snapshot.cursor) || 0;
  rebuildFollowedMessages();
  renderFollowedRun();
}

async function subscribePanelRun() {
  if (!panelSessionId) return;
  const sessionId = panelSessionId;
  const res = await sendPanelMessage('panel:run:subscribe', { sessionId });
  if (sessionId !== panelSessionId) return;
  if (!res || !res.ok || res.selfOwned) {
    resetFollowedRun({ render: Boolean(followedRunState) });
    return;
  }
  if (res.snapshot && res.snapshot.status === 'running') applyFollowedSnapshot(res.snapshot);
  else if (res.snapshot) resetFollowedRun({ render: Boolean(followedRunState) });
  else if (followedRunState) resetFollowedRun({ render: true });
}

function scheduleFollowedRunRefresh() {
  if (followRefreshTimer) clearTimeout(followRefreshTimer);
  let attempts = 0;
  const tick = async () => {
    attempts += 1;
    const sessionId = panelSessionId;
    const got = await sendPanelMessage('panel:get', { id: sessionId });
    if (sessionId !== panelSessionId) return;
    const instruction = String(followedRunState && followedRunState.instruction ? followedRunState.instruction : '').trim();
    const messages = got && got.ok && got.session ? got.session.messages || [] : [];
    let userIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user' && String(messages[i].content || '').trim() === instruction) {
        userIndex = i;
        break;
      }
    }
    const hasCommittedTurn =
      userIndex >= 0 && messages.slice(userIndex + 1).some((m) => m && m.role === 'assistant');
    if (got && got.ok && got.session && (Number(got.session.seq) > panelSessionSeq || hasCommittedTurn)) {
      resetFollowedRun();
      adoptPanelSession(got.session, { activeId: got.activeId || sessionId });
      subscribePanelRun().catch(() => {});
      return;
    }
    if (attempts < 6) {
      followRefreshTimer = setTimeout(tick, 300);
    } else {
      resetFollowedRun({ render: true });
    }
  };
  followRefreshTimer = setTimeout(tick, 250);
}

function handleRunStarted(msg) {
  if (!msg || String(msg.sessionId || '') !== panelSessionId) return;
  subscribePanelRun().catch(() => {});
}

function handleRunDelta(msg) {
  if (!msg || String(msg.sessionId || '') !== panelSessionId) return;
  if (!followedRunState || String(msg.runId || '') !== followedRunId) {
    subscribePanelRun().catch(() => {});
    return;
  }
  const cursor = Number(msg.cursor) || 0;
  if (cursor !== followedCursor + 1) {
    subscribePanelRun().catch(() => {});
    return;
  }
  followedCursor = cursor;
  applyRunEvent(followedRunState, msg.event);
  rebuildFollowedMessages();
  renderFollowedRun();
  if (msg.event && (msg.event.type === 'end' || msg.event.type === 'error')) {
    scheduleFollowedRunRefresh();
  }
}

function renderPlan(plan) {
  lastPlan = Array.isArray(plan) ? plan : [];
  if (!planBar) return;
  if (!lastPlan.length) {
    planBar.style.display = 'none';
    planBar.innerHTML = '';
    planExpanded = null;
    return;
  }
  const total = lastPlan.length;
  const doneCount = lastPlan.filter((p) => p && p.status === 'done').length;
  const allDone = total > 0 && doneCount === total;
  const current = lastPlan.find((p) => p && p.status === 'in_progress') || lastPlan.find((p) => p && p.status !== 'done');
  // 「完成 ↔ 进行中」切换时回到默认收起状态；同一状态内的反复更新不动用户的选择
  // （否则用户展开后，任何一次计划更新都会把它收回去）。
  if (allDone !== planWasAllDone) planExpanded = null;
  planWasAllDone = allDone;
  // 默认收成一行。**不再用「限高 + 内层滚动条」处理步骤过多** ——
  // 那个方案会让计划条变成一个小滚动框，既难看又要二次滚动。
  // 现在改为「收一行 / 展开全部」：展开时不设高度上限，因此永远不会出现内层滚动条。
  const collapsed = planExpanded !== true;

  const items = lastPlan
    .map((p) => {
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
  planBar.classList.toggle('collapsed', collapsed);
  planBar.innerHTML =
    '<div class="agent-plan-title" role="button" tabindex="0" title="点击展开/折叠">' + escHtml(title) + '</div>' +
    '<div class="agent-plan-items">' +
    items +
    '</div>';
  planBar.style.display = '';
  fitPanelHeight();
  pinToBottom();
}

// 对话持久化（按 tab，存 chrome.storage.session）：SPA 跳转 / 刷新后仍保留上下文。
// 把一轮里的工具执行轨迹压成一行摘要，随 assistant 消息一起保存，
// 使「继续上一步」时模型能看到做过什么（见 context.js normalizeHistory）。
function summarizeToolParts(parts) {
  const done = (Array.isArray(parts) ? parts : []).filter((p) => p && p.type === 'tool-result');
  if (!done.length) return '';
  return done
    .slice(-6)
    .map((p) => p.name + (p.status === 'failed' ? '（失败）' : '') + '：' + String(p.result || '').replace(/\s+/g, ' ').trim().slice(0, 120))
    .join('；');
}
// ---- 结构化导出 ----
// 具体格式与理由见 lib/page/transcript.js（纯函数，便于单测）。
// 这里只负责把页面上的实时值喂进去，不再自己拼 markdown。

// 导出/交接用的消息列表：已入库的对话 + **正在进行中的这一轮**。
// 助手条目只在 'end' 收尾时入库，所以任务进行中直接读 conversation 只能拿到用户消息 ——
// 正在发生的叙述、工具步骤、已流出的答复全都不见。而「面板里正出问题、把现场交给外部 AI」
// 恰恰是这个功能最典型的使用时刻，交出去一个空包毫无意义。
function messagesForExport() {
  const list = Array.isArray(conversation) ? conversation.slice() : [];
  const partial = buildPartialTurn(pendingParts, pendingNarration || pendingAcc);
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
function buildTranscriptMarkdown(mode) {
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
  // 实现在 transcript.js（纯函数、可单测）：这里的对话要存进 chrome.storage.session，
  // 而**配额是所有标签页共享的**，所以上限的取舍属于"记录格式"这件事，和导出同源。
  return serializeConversationMessages(conversation);
}

function sendPanelMessage(type, payload) {
  return new Promise((resolve) => {
    if (!isExtContextAlive()) {
      resolve({ ok: false, error: '扩展已更新，请刷新页面后重试' });
      return;
    }
    try {
      chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message || '与扩展后台通信失败' });
        } else {
          resolve(resp || { ok: false, error: '扩展后台无响应' });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
}

function sessionTimeText(ts) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const d = new Date(n);
  const pad = (v) => String(v).padStart(2, '0');
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function applyPanelSessionSummaries(state) {
  if (!state) return;
  if (Array.isArray(state.sessions)) panelSessionList = state.sessions.slice();
  if (typeof state.activeId === 'string') panelSessionActiveId = state.activeId;
  renderSessionButton();
  renderSessionMenu();
}

function mergePanelSessionSummary(session) {
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
  const old = panelSessionList.find((s) => s.id === session.id);
  if (old) Object.assign(old, summary);
  else panelSessionList.push(summary);
  panelSessionList.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  renderSessionButton();
  renderSessionMenu();
}

function renderSessionButton() {
  if (!panelSessionBtnEl) return;
  const current = panelSessionList.find((s) => s.id === panelSessionId);
  const count = panelSessionList.length;
  panelSessionBtnEl.textContent = '🗂 会话' + (count ? ' ' + count : '');
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
  if (!panelSessionList.length) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = '还没有会话';
    list.appendChild(empty);
  }
  for (const session of panelSessionList) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.setAttribute('data-session-id', session.id);
    if (session.id === panelSessionId) item.classList.add('active');
    if (session.id === panelSessionActiveId) item.classList.add('shared-active');
    if (session.locked) item.classList.add('running');

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'session-main';
    main.setAttribute('data-session-action', 'switch');
    main.setAttribute('data-session-id', session.id);
    main.title = session.title + '\n' + (session.origin || '') + '\n' + session.messageCount + ' 条消息';
    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = (session.locked ? '● ' : '') + (session.title || '新会话');
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = sessionTimeText(session.updatedAt) + ' · ' + (Number(session.messageCount) || 0) + ' 条' +
      (session.id === panelSessionActiveId ? ' · 浏览器当前' : '');
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

function adoptPanelSession(session, options) {
  if (!session || !session.id) return false;
  const opts = options || {};
  panelSessionId = session.id;
  panelSessionSeq = Number(session.seq) || 0;
  if (opts.activeId) panelSessionActiveId = String(opts.activeId);
  conversation = Array.isArray(session.messages) ? session.messages : [];
  handoffId = normalizeHandoffId(session.handoffId || '') || loadHandoffId() || newHandoffId();
  try {
    localStorage.setItem(HANDOFF_ID_KEY, handoffId);
  } catch (e) {}
  mergePanelSessionSummary(Object.assign({}, session, { messageCount: conversation.length, handoffId }));
  if (followedRunState) {
    // 结束广播可能正好落在跟随页整页重载的窗口里。落盘消息是最终权威：
    // 当前指令之后已经有正式 assistant 消息时，立即撤掉 live 覆盖层并恢复输入。
    if (followedRunCommitted()) resetFollowedRun();
    else rebuildFollowedMessages();
  }
  if (panelBody && !streaming) {
    renderConversation();
    renderHandoffChip();
    fitPanelHeight();
    pinToBottom();
  }
  renderSessionButton();
  if (panel && !streaming) subscribePanelRun().catch(() => {});
  return true;
}

function saveConversation() {
  const id = panelSessionId;
  if (!id) return Promise.resolve({ ok: false, skipped: true });
  // 快照必须在调用当下取：流式/撤销连续触发时，队列里排着的是各自那一刻的内容。
  const messages = serializeConversation();
  const baseSeq = panelSessionSeq;
  const runId = activeRunId || '';
  const savedHandoffId = handoffId;
  panelSessionSaveChain = panelSessionSaveChain
    .catch(() => {})
    .then(async () => {
      const res = await sendPanelMessage('panel:save', {
        id,
        messages,
        baseSeq,
        handoffId: savedHandoffId,
        lastRunId: runId,
        origin: location.href,
      });
      if (res && res.ok && res.session) {
        if (id === panelSessionId) panelSessionSeq = Number(res.session.seq) || panelSessionSeq;
        mergePanelSessionSummary(res.session);
        if (Array.isArray(res.sessions)) panelSessionList = res.sessions.slice();
        renderSessionButton();
        renderSessionMenu();
      } else if (res && res.conflict && res.session) {
        // 另一个标签页先写了同一会话：不覆盖远端内容。空闲时切到最新版本；
        // 正在输出时保留当前 DOM，等结束后再同步。
        if (id === panelSessionId && !streaming) {
          adoptPanelSession(res.session, { activeId: res.activeId });
          showCitationHint('该会话已在其他标签页更新，已为你刷新到最新内容。');
        }
      }
      return res;
    });
  return panelSessionSaveChain;
}

async function loadConversation() {
  try {
    const state = await sendPanelMessage('panel:state');
    if (state && state.ok) applyPanelSessionSummaries(state);
    const target = (state && state.activeId) || (panelSessionList[0] && panelSessionList[0].id) || '';
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
  } catch (e) {
  } finally {
    conversationLoaded = true;
  }
}

function showPanelDialog(config) {
  if (!panel) return;
  const options = config || {};
  const old = panel.querySelector('.session-dialog-backdrop');
  if (old) old.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'session-dialog-backdrop';
  const box = document.createElement('div');
  box.className = 'session-dialog';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const title = document.createElement('div');
  title.className = 'session-dialog-title';
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
          } catch (e) {}
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
    try {
      backdrop.remove();
    } catch (e) {}
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
    } catch (e) {
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

async function switchPanelSession(id, options) {
  const opts = options || {};
  const wanted = String(id || '');
  if (!wanted) return false;
  if (streaming) {
    showCitationHint('当前任务还在运行，结束后才能切换会话。');
    return false;
  }
  if (wanted === panelSessionId && !opts.force) {
    closeSessionMenu();
    return true;
  }
  if (panelSessionSwitchInFlight) return false;
  panelSessionSwitchInFlight = true;
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
    if (Array.isArray(res.sessions)) panelSessionList = res.sessions.slice();
    renderSessionButton();
    renderSessionMenu();
    closeSessionMenu();
    return true;
  } finally {
    panelSessionSwitchInFlight = false;
    if (deferredRemoteSessionId && !streaming && deferredRemoteSessionId !== panelSessionId) {
      const next = deferredRemoteSessionId;
      deferredRemoteSessionId = '';
      setTimeout(() => {
        switchPanelSession(next, { activate: false, force: true }).catch(() => {});
      }, 0);
    }
  }
}

async function newPanelSession() {
  if (streaming) {
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
  if (Array.isArray(res.sessions)) panelSessionList = res.sessions.slice();
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

function renamePanelSession(id) {
  const session = panelSessionList.find((s) => s.id === id);
  if (!session) return;
  showPanelDialog({
    title: '重命名会话',
    message: '名称只影响会话列表，不会改动对话内容。',
    input: true,
    value: session.title,
    placeholder: '例如：GitHub 搜索调研',
    confirmText: '保存',
    onConfirm: async (title) => {
      const res = await sendPanelMessage('panel:rename', { id, title });
      if (!res || !res.ok) {
        showCitationHint((res && res.error) || '重命名失败');
        return false;
      }
      if (Array.isArray(res.sessions)) panelSessionList = res.sessions.slice();
      if (id === panelSessionId && res.session) {
        panelSessionSeq = Number(res.session.seq) || panelSessionSeq;
      }
      renderSessionButton();
      renderSessionMenu();
      return true;
    },
  });
}

function deletePanelSession(id) {
  const session = panelSessionList.find((s) => s.id === id);
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
      if (Array.isArray(res.sessions)) panelSessionList = res.sessions.slice();
      if (id === panelSessionId) {
        const nextId = res.activeId || (res.sessions && res.sessions[0] && res.sessions[0].id);
        if (nextId) await switchPanelSession(nextId, { force: true });
      } else {
        panelSessionActiveId = res.activeId || panelSessionActiveId;
        renderSessionButton();
        renderSessionMenu();
      }
      return true;
    },
  });
}

async function exportPanelSession(id, btn) {
  const session = panelSessionList.find((s) => s.id === id);
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
  } catch (e) {}
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
  } catch (e) {
    showCitationHint('复制失败，请检查剪贴板权限。');
  }
}

async function acquirePanelSessionLock(runId, takeover) {
  if (!panelSessionId) return { ok: false, error: '会话尚未就绪' };
  const res = await sendPanelMessage('panel:lock', {
    id: panelSessionId,
    runId,
    takeover: takeover === true,
  });
  if (res && res.ok) {
    panelSessionLockHeld = true;
    panelSessionLockRunId = runId;
    if (Array.isArray(res.sessions)) {
      panelSessionList = res.sessions.slice();
      renderSessionMenu();
    }
  }
  return res || { ok: false, error: '运行锁获取失败' };
}

function releasePanelSessionLock() {
  if (!panelSessionLockHeld || !panelSessionLockRunId) return Promise.resolve();
  const id = panelSessionId;
  const runId = panelSessionLockRunId;
  panelSessionLockHeld = false;
  panelSessionLockRunId = '';
  return sendPanelMessage('panel:unlock', { id, runId });
}

function renewPanelSessionLock() {
  if (!panelSessionLockHeld || !panelSessionLockRunId) return;
  sendPanelMessage('panel:lock', {
    id: panelSessionId,
    runId: panelSessionLockRunId,
    takeover: false,
  }).then((res) => {
    if (res && res.locked && !res.ok) {
      panelSessionLockHeld = false;
      showCitationHint('该会话已在另一个标签页接管，本页任务将停止。');
      if (activeInterruptFn) activeInterruptFn();
    }
  }).catch(() => {});
}

async function handleRemotePanelSessions(state) {
  if (!state) return;
  const oldActive = panelSessionActiveId;
  applyPanelSessionSummaries(state);
  const nextActive = String(state.activeId || '');
  if (!nextActive) return;
  if (streaming || panelSessionSwitchInFlight) {
    if (nextActive !== panelSessionId) deferredRemoteSessionId = nextActive;
    return;
  }
  if (nextActive !== panelSessionId) {
    await switchPanelSession(nextActive, { activate: false, force: true });
    return;
  }
  // 同一会话被其他标签页更新：空闲时同步正文。
  const current = panelSessionList.find((s) => s.id === panelSessionId);
  if (current && Number(current.seq) > panelSessionSeq && oldActive === nextActive) {
    await switchPanelSession(panelSessionId, { activate: false, force: true });
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
  } catch (e) {
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
    const dc = window.__rfDebugCapture;
    if (dc && typeof dc.getDebugBuffer === 'function') {
      consoleEntries = await dc.getDebugBuffer('console');
    }
  } catch (e) {
    /* 取不到控制台快照不影响交接 */
  }
  let picked = Array.isArray(pickedElements) ? pickedElements : [];
  if (!picked.length) {
    try {
      const d = await new Promise((resolve) => {
        chrome.storage.local.get(['recallflow.lastPickedList'], (r) => resolve(r || {}));
      });
      picked = (d && d['recallflow.lastPickedList']) || [];
    } catch (e) {
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
  } catch (e) {
    return false;
  }
  // 返回是否真的落库：复制是同步的、保存是异步的，若用户刚复制就粘贴，
  // AI 可能还查不到这条记录。调用方据此在芯片上如实显示状态。
  return await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'handoff:save', record, trailItems }, (resp) => {
        resolve(!chrome.runtime.lastError && !(resp && resp.ok === false));
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function openPanel(x, y, docked) {
  if (!isExtContextAlive()) {
    warnExtDead();
    return;
  }
  removeBubble();
  removePanel({ publish: false });
  if (fab) fab.classList.add('hidden');

  panel = document.createElement('div');
  panel.className = 'panel' + (preferredTheme() === 'dark' ? ' dark' : '');
  // 面板语义上是一个非模态对话框：声明角色，消息区用 aria-live 让流式输出可被读屏播报。
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', 'RecallFlow 浏览器助手');
  if (docked) panel.classList.add('docked');
  try { const saved = JSON.parse(localStorage.getItem('recallflow-panel-size') || 'null'); if (saved) { panel.style.width = Math.min(window.innerWidth - 24, Math.max(280, saved.width)) + 'px'; panel.style.height = Math.min(window.innerHeight - 24, Math.max(320, saved.height)) + 'px'; panel._manualSize = true; } } catch (_) { /* ignore invalid saved size */ }
  let savedPos = null;
  try { savedPos = JSON.parse(localStorage.getItem('recallflow-panel-pos') || 'null'); } catch (_) { savedPos = null; }

  const head = document.createElement('div');
  head.className = 'p-head';
  const logo = document.createElement('img');
  logo.className = 'logo';
  logo.src = extUrl('docs/assets/recallflow-mark.svg');
  logo.alt = 'RecallFlow';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = 'RecallFlow';
  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '✕';
  close.addEventListener('click', () => removePanel());
  const usageChip = document.createElement('span');
  usageChip.className = 'usage';
  usageEl = usageChip;
  // 会话入口：列表 + 新建，放在交接芯片旁。标题栏其余部分仍可拖动。
  panelSessionBtnEl = document.createElement('button');
  panelSessionBtnEl.type = 'button';
  panelSessionBtnEl.className = 'session-btn';
  panelSessionBtnEl.setAttribute('aria-haspopup', 'true');
  panelSessionBtnEl.setAttribute('aria-expanded', 'false');
  renderSessionButton();
  panelSessionMenuEl = document.createElement('div');
  panelSessionMenuEl.className = 'session-menu';
  panelSessionMenuEl.hidden = true;
  panelSessionMenuEl.setAttribute('role', 'menu');
  panelSessionBtnEl.addEventListener('click', async (e) => {
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
  panelSessionMenuEl.addEventListener('click', (e) => {
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
  themeBtn = document.createElement('button');
  themeBtn.className = 'theme';
  themeBtn.addEventListener('click', cycleTheme);
  applyTheme();
  head.appendChild(logo);
  head.appendChild(title);
  head.appendChild(usageChip);
  head.appendChild(panelSessionBtnEl);
  head.appendChild(handoffBtn);
  head.appendChild(themeBtn);
  head.appendChild(close);
  panel.appendChild(head);
  shadow.addEventListener('mousedown', (e) => {
    if (!panelSessionMenuOpen) return;
    if (e.target.closest('.session-menu') || e.target.closest('.session-btn')) return;
    closeSessionMenu();
  });

  // 进度条：显示「第几步 / 正在做什么 / 已用时」，长任务不再黑箱。
  progressEl = document.createElement('div');
  progressEl.className = 'p-progress';
  const ppDot = document.createElement('span');
  ppDot.className = 'pp-dot';
  progressMsgEl = document.createElement('span');
  progressMsgEl.className = 'pp-msg';
  progressTimeEl = document.createElement('span');
  progressTimeEl.className = 'pp-time';
  progressEl.appendChild(ppDot);
  progressEl.appendChild(progressMsgEl);
  progressEl.appendChild(progressTimeEl);
  panel.appendChild(progressEl);

  if (lastText) {
    const text = document.createElement('div');
    text.className = 'p-text';
    text.textContent = lastText.length > 200 ? lastText.slice(0, 200) + '…' : lastText;
    text.title = lastText;
    panelTextEl = text;
    panel.appendChild(text);
  }

  panelBody = document.createElement('div');
  panelBody.className = 'p-body';
  panelBody.setAttribute('role', 'log');
  panelBody.setAttribute('aria-live', 'polite');
  panelBody.setAttribute('aria-atomic', 'false');
  panelBody.setAttribute('aria-label', '对话内容');
  observerAutoScroll = true;
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
    if (Date.now() < selfScrollMuteUntil) return;
    // 距底部 < 40px 视为在底部（恢复自动跟随），否则用户在看历史（暂停跟随）。
    observerAutoScroll = pbEl.scrollHeight - pbEl.scrollTop - pbEl.clientHeight < 40;
  });
  panelBody.addEventListener('click', (e) => {
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
        const wasPinned =
          !!observerAutoScroll ||
          (panelBody && panelBody.scrollHeight - panelBody.scrollTop - panelBody.clientHeight < 40);
        const opening = block.dataset.open !== 'true';
        block.dataset.open = opening ? 'true' : 'false';
        // 只有「正在进行的这一段」需要记住用户的选择；历史段各自独立开合。
        if (thinkSeg && thinkSeg.block === block) thinkExpandedManual = opening;
        // 读 scrollHeight 会强制一次布局，因此这行看到的是**展开后**的真实高度。
        if (wasPinned && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      }
      return;
    }
    const rewind = e.target.closest('.act-rewind');
      if (rewind) {
        if (streaming) return;
        const index = Number(rewind.getAttribute('data-turn-index'));
        if (Number.isInteger(index) && conversation[index] && conversation[index].role === 'user') {
          const undone = conversation[index];
          conversation = conversation.slice(0, index);
          saveConversation();
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
      openShotLightbox(shotImg.getAttribute('src') || '');
      return;
    }
    // 重新生成：截断到最后一条用户消息之前，用同一条指令再跑一次。
    const regen = e.target.closest('.act-regen');
    if (regen) {
      if (streaming) return;
      let lastUser = -1;
      for (let i = conversation.length - 1; i >= 0; i--) {
        if (conversation[i] && conversation[i].role === 'user') {
          lastUser = i;
          break;
        }
      }
      if (lastUser < 0) return;
      const instruction = String(conversation[lastUser].content || '');
      if (!instruction) return;
      conversation = conversation.slice(0, lastUser);
      saveConversation();
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
        try { chrome.runtime.sendMessage({ type: 'openManager', focusId: id }); } catch (e) {}
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
        '<label class="approval-item"><input data-policy="commands" type="checkbox"> 页面命令 <small>点击、输入、滚动、高亮等</small></label>' +
      '</div>' +
      '<div class="approval-group"><div class="approval-group-title">外部</div>' +
        '<label class="approval-item"><input data-policy="browser" type="checkbox"> 浏览器与网络 <small>打开标签页、抓取网页</small></label>' +
        '<label class="approval-item"><input data-policy="mcp" type="checkbox"> MCP 服务器 <small>调用外部工具</small></label>' +
      '</div>' +
      '<div class="approval-group"><div class="approval-group-title">高风险</div>' +
        '<label class="approval-item approval-runjs">代码执行审批：<select data-runjs><option value="each">每次确认</option><option value="session">本任务内允许一次</option><option value="auto">自动批准</option></select></label>' +
      '</div>' +
    '</div>';
  const runjsEl = approvalSettings.querySelector('[data-runjs]');
  const autopilotEl = approvalSettings.querySelector('[data-autopilot]');
  autopilotEl.addEventListener('change', () => {
    const on = autopilotEl.checked;
    approvalSettings.querySelectorAll('[data-policy]').forEach((x) => {
      x.checked = on;
      x.dispatchEvent(new Event('change'));
    });
  });
  const approvalToggle = approvalSettings.querySelector('.approval-settings-toggle');
  const approvalPopover = approvalSettings.querySelector('.approval-settings-popover');
  const refreshApprovalLabel = () => {
    const names = { read: '读取', edit: '编辑', commands: '命令', browser: '浏览器', mcp: 'MCP' };
    const on = [...approvalSettings.querySelectorAll('[data-policy]:checked')].map((x) => names[x.dataset.policy]);
  approvalToggle.innerHTML = '自动批准：' + (on.length ? on.join('、') : '无') + ' <span>›</span>';
  };
  approvalToggle.addEventListener('click', () => { approvalPopover.hidden = !approvalPopover.hidden; panel.classList.toggle('approval-open', !approvalPopover.hidden); fitPanelHeight(); });
  getAISettings().then((s) => { const p = s.toolApprovalPolicy || { read: true }; approvalSettings.querySelectorAll('[data-policy]').forEach((x) => { x.checked = p[x.dataset.policy] === true; x.addEventListener('change', async () => { const policy = Object.fromEntries([...approvalSettings.querySelectorAll('[data-policy]')].map((y) => [y.dataset.policy, y.checked])); try { await updateAISettings({ toolApprovalPolicy: policy }); } catch (e) { warnExtDead(); } autopilotEl.checked = ['read', 'edit', 'commands', 'browser', 'mcp'].every((k) => policy[k] === true); refreshApprovalLabel(); }); }); autopilotEl.checked = ['read', 'edit', 'commands', 'browser', 'mcp'].every((k) => p[k] === true); runjsEl.value = resolveCodeExecutionApproval(s); runjsEl.addEventListener('change', async () => { try { await updateAISettings({ codeExecutionApproval: runjsEl.value }); } catch (e) { warnExtDead(); } }); refreshApprovalLabel(); }).catch(() => {});

  // 计划条元素在这里创建（必须在 renderConversation() 之前 —— 它会把最近一条带计划的
  // 助手消息回填进来），但**挂载点在对话区顶部**，见下面 panel.appendChild(planBar)。
  planBar = document.createElement('div');
  planBar.className = 'agent-plan agent-plan-bar';
  planBar.style.display = 'none';
  // 点标题可手动展开 / 折叠。全部步骤完成后会自动折叠成一行。
  planBar.addEventListener('click', (e) => {
    if (!e.target || !e.target.closest || !e.target.closest('.agent-plan-title')) return;
    // 当前是折叠态 → 用户要展开；当前是展开态 → 用户要折叠。
    planExpanded = planBar.classList.contains('collapsed');
    renderPlan(lastPlan);
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
  cmdArea.appendChild(planBar);
  const approvalArea = document.createElement('div');
  approvalArea.className = 'tool-approval';
  approvalArea.style.display = 'none';
  cmdArea.appendChild(approvalArea);
  const quickWrap = document.createElement('div');
  quickWrap.className = 'quick-prompts';
  cmdArea.appendChild(quickWrap);
  // 自动批准位于快捷指令下方、输入框上方，方便随时调整且不打断输入。
  cmdArea.appendChild(approvalSettings);
  const pickBar = document.createElement('div');
  pickBar.className = 'pick-bar';
  pickBar.style.display = 'none';
  cmdArea.appendChild(pickBar);
  const cmdWrap = document.createElement('div');
  cmdWrap.className = 'cmd-box';
  const cmdInput = document.createElement('textarea');
  cmdInput.className = 'cmd-input';
  cmdInput.rows = 1;
  cmdInput.placeholder = '输入指令后回车，如：翻译成中文 / 解释这段代码 / 优化并补全…';
  // 注意：赋值给**模块级** sendBtn（见文件顶部的说明），不加 const ——
  // 模块级的 restoreStreamingUI() 也要能读写它的 disabled 状态。
  sendBtn = document.createElement('button');
  sendBtn.className = 'cmd-send';
  sendBtn.textContent = '发送';
  // 流式中重开面板时它必须是禁用的（run() 起始与 endStream() 也各自维护这条状态）。
  sendBtn.disabled = streaming === true;
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
  const locatorText = (p) => formatElementLocator(p && p.locator, p && p.selector, p && p.tag);
  const renderPick = () => {
    pickBar.innerHTML = '';
    if (!pickedElements.length) {
      pickBar.style.display = 'none';
      return;
    }
    pickBar.style.display = '';
    pickedElements.forEach((p, idx) => {
      const src = p.source || {};
      const loc = src.file ? src.file + (src.line ? ':' + src.line : '') : '';
      const chip = document.createElement('span');
      chip.className = 'pick-chip';
      const txt = document.createElement('span');
      txt.className = 'pick-chip-text';
      txt.textContent =
        (pickedElements.length > 1 ? idx + 1 + '. ' : '') +
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
        pickedElements.splice(idx, 1);
        renderPick();
      });
      chip.appendChild(txt);
      chip.appendChild(copy);
      chip.appendChild(clear);
      pickBar.appendChild(chip);
    });
    if (pickedElements.length > 1) {
      const clearAll = document.createElement('button');
      clearAll.className = 'pick-clear-all';
      clearAll.textContent = '清空';
      clearAll.addEventListener('click', () => {
        pickedElements = [];
        renderPick();
      });
      pickBar.appendChild(clearAll);
    }
    fitPanelHeight();
  };
  // 拾取通过后台广播到所有 frame（含跨域 iframe），结果由后台回传顶层。
  pickUi = {
    setActive: (on) => {
      picking = !!on;
      pickBtn.classList.toggle('active', !!on);
    },
    onPicked: (list) => {
      pickedElements = Array.isArray(list) ? list : list ? [list] : [];
      renderPick();
      cmdInput.focus();
    },
  };
  pickBtn.addEventListener('click', () => {
    if (picking) {
      try { chrome.runtime.sendMessage({ type: 'pick:cancel' }); } catch (e) {}
      pickUi.setActive(false);
      return;
    }
    pickUi.setActive(true);
    try {
      chrome.runtime.sendMessage({ type: 'pick:start' });
    } catch (e) {
      pickUi.setActive(false);
    }
  });
  renderPick();
  panel.appendChild(panelBody);
  panel.appendChild(cmdArea);

  getAISettings().then((s) => {
    quickWrap.innerHTML = '';
    (s.quickPrompts || AI_SETTINGS_DEFAULTS.quickPrompts || []).slice(0, 12).forEach((prompt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'quick-prompt';
      b.textContent = prompt;
      b.addEventListener('click', () => {
        if (streaming) return;
        run(prompt);
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
  const exportTranscript = (btn, mode) => {
    const label = btn.textContent;
    const restore = () => setTimeout(() => (btn.textContent = label), 1600);
    // 结构化导出：从对话数据模型生成，而不是 panelBody.textContent ——
    // 后者会掺入输入框 placeholder 与按钮文字（「↶ 撤销⧉ 复制」），且用户与 AI 无角色分隔。
    let text = '';
    try {
      text = buildTranscriptMarkdown(mode);
    } catch (e) {
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
  // ⚠ 初值必须跟着 `streaming` 走，不能写死 none：
  //   面板可能是**在任务进行中**被重新打开的（流式中关掉再打开）—— 那时新面板的停止按钮
  //   若还是 display:none，而 restoreStreamingUI() 又跑在**本行之前**（它碰到的只会是
  //   上一个面板遗留的那个按钮），用户就再也按不到「■ 停止」（实测反馈："停止与思考都没了"）。
  stopBtn.style.display = streaming ? '' : 'none';
  stopBtn.addEventListener('click', interrupt);
  foot.appendChild(clearBtn);
  foot.appendChild(copyBtn);
  foot.appendChild(copyFullBtn);
  foot.appendChild(stopBtn);
  panel.appendChild(foot);

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'resize-handle bottom-right';
  const startResize = (e, origin) => {
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

  const prw = panel.offsetWidth;
  const prh = panel.offsetHeight;
  if (docked) {
    const edgeGap = getDockGap();
    if (savedPos && Number.isFinite(savedPos.left) && Number.isFinite(savedPos.top)) {
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
      panel.style.left = Math.min(maxLeft, Math.max(0, savedPos.left)) + 'px';
      panel.style.top = Math.min(maxTop, Math.max(0, savedPos.top)) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel._manualPos = true;
    } else {
      panel.style.right = '0px';
      panel.style.left = 'auto';
      panel.style.top = 'auto';
      panel.style.bottom = edgeGap + 'px';
    }
  } else {
    panel.style.right = 'auto';
    const left = Math.min(Math.max(4, x), window.innerWidth - prw - 4);
    const top = Math.min(Math.max(4, y), window.innerHeight - Math.min(prh, window.innerHeight - 24) - 4);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function endStream() {
    // 先丢弃仍在排队的流式渲染：下面的重置会把 pendingContentEl / pendingNarration
    // 清空，排队中的回调再去读它们已经没有意义；而 error 分支刚写好的错误文本
    // 也可能被一次晚到的流式重绘覆盖掉。放在这里是因为它是唯一的收尾出口。
    streamRender.cancel();
    streaming = false;
    stopProgress();
    if (stopBtn) stopBtn.style.display = 'none';
    if (sendBtn) sendBtn.disabled = false;
    pendingAiMsg = null;
    pendingContentEl = null;
    pendingStarted = false;
    pendingAcc = '';
    pendingParts = [];
    budgetStopped = false;
    flowEl = null;
    pendingNarration = '';
    lastNarration = '';
    typingEl = null;
    // 刻意**不**清空计划条：它已固定在输入框上方，任务结束后保留最终状态，
    // 便于回头确认「哪几步做完了」。下一轮开始时才清掉（见 newRun 处）。
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    // 等本轮最后一次落盘完成再释放锁：否则另一标签页可能在保存前就接管，
    // 随后本页的迟到写入会把对方看到的内容覆盖掉。
    panelSessionSaveChain
      .catch(() => {})
      .then(() => releasePanelSessionLock())
      .catch(() => {})
      .finally(() => {
        if (!deferredRemoteSessionId || streaming) return;
        const next = deferredRemoteSessionId;
        deferredRemoteSessionId = '';
        if (next !== panelSessionId) switchPanelSession(next, { activate: false, force: true }).catch(() => {});
      });
  }

  // 移除初始的“正在输入”占位元素，避免它残留在叙述/步骤之前。
  function removeTypingEl() {
    if (typingEl && typingEl.parentNode) {
      typingEl.parentNode.removeChild(typingEl);
      if (pendingContentEl === typingEl) pendingContentEl = null;
    }
    typingEl = null;
  }

  // 当前叙述段落对应的文本元素：每段一个 div，工具步骤插在段落之间。
  function ensureTextEl() {
    if (!flowEl) return null;
    const el = document.createElement('div');
    el.className = 'agent-content';
    flowEl.appendChild(el);
    return el;
  }

  // ---- 思考记录 ----
  //
  // 思维链逐 token 到达。**每一段思考单独挂一块，追加到对话流末尾** ——
  // 于是它与前后的叙述、工具步骤自然按发生顺序穿插，而不是全堆在消息最上面。
  // 折叠状态是三态的（见模块顶部 thinkExpandedManual 的注释）。

  /** 收到一段思维链增量。 */
  function pushReasoning(text) {
    const piece = String(text || '');
    if (!piece) return;
    // 没有「进行中的段」就开一段新的 —— 定稿过的段已经置 null，因此新段必然另起一块。
    if (!thinkSeg || thinkSeg.done) {
      thinkSeg = { id: ++thinkSegSeq, text: '', done: false, block: null, body: null };
      thinkExpandedManual = null; // 新一段：用户还没表过态
      mountThinkSegment(thinkSeg);
    }
    const seg = thinkSeg;
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
    const seg = thinkSeg;
    if (!seg || seg.done) return;
    seg.done = true;
    if (seg.block) {
      seg.block.dataset.state = 'done';
      // 定稿只把状态从 running 改成 done —— **不动**用户的开合选择。
      // 这里的写是"兜底归位"（默认本就是折叠，等于空操作）；真正要守住的是**不覆盖用户的选择**：
      // 用户手动展开过（thinkExpandedManual === true）时一个字都不写。
      if (thinkExpandedManual === null) seg.block.dataset.open = 'false';
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
    pendingParts.push({ type: 'thinking', text: seg.text });
    // 关键：断掉「进行中的段」指针，下一段思考就会另起一块 —— 这是"穿插"的实现要点。
    thinkSeg = null;
  }

  /** 新一轮开始：清掉上一轮的思考记录指针（上一轮那几块留在历史里，不动）。 */
  function resetReasoning() {
    thinkSeg = null;
    thinkExpandedManual = null;
  }

  // 追加一个工具步骤卡片：先把已经流式输出的叙述段落固化成一条记录，
  // 再插入步骤，使后续叙述从新元素继续，形成“叙述 → 工具 → 叙述”的时间线。
  function appendStep(step) {
    removeTypingEl();
    // 进入工具步骤：本次思考到此为止（该轮答案可能没有正文，只有工具调用）。
    finishReasoning();
    if (pendingNarration) {
      lastNarration = pendingNarration;
      pendingParts.push({ type: 'narration', text: pendingNarration });
      // 叙述段结束时用非流式模式重渲染，去掉末尾一直在闪烁的 stream-cursor。
      if (pendingContentEl) {
        pendingContentEl.innerHTML = renderAnswer(pendingNarration, currentCitations, false);
      }
      pendingNarration = '';
    }
    pendingContentEl = null;
    if (flowEl) flowEl.appendChild(step);
  }

  // 过程提示（意图、校验、限流等）原先只写 DOM，不进入 conversation.parts：
  // 发起页面板重开或跟随页切换到正式落盘消息时，这些步骤会凭空消失。
  // 这里统一“显示 + 入库”，确保即时与最终态一致。
  function appendNoticePart(text, color, className) {
    const value = String(text || '').trim();
    if (!value) return;
    const step = document.createElement('div');
    step.className = 'agent-step' + (className ? ' ' + className : '');
    if (color) step.style.color = color;
    step.textContent = value;
    appendStep(step);
    pendingParts.push({ type: 'notice', text: value, color: color || '' });
  }

  function interrupt() {
    if (!streaming) return;
    // ⚠ 停止也是"这一轮的收尾"：**先把进行中的思考定稿**。
    // 否则这段思考只活在 DOM 里（pendingParts 里没有它），一关面板就没了 ——
    // 用户看到的现象正是「停止/中断过的那一轮，重开后思考消失」。
    finishReasoning();
    // 停止必须**显式**告诉后台中止 run：端口断开不再自动 abort（整页刷新也要靠它续跑，
    // 见 background.js 的 tabControllers 注释）。先发 stop 再断端口，保证顺序。
    try {
      if (activeConn) activeConn.postMessage({ type: 'stop' });
    } catch (e) {}
    const acc = pendingAcc;
    closePort();
      if (pendingAiMsg && pendingAiMsg.parentNode) {
        lastResponse = pendingNarration || lastNarration || acc;
        if (acc) {
          if (pendingContentEl) pendingContentEl.innerHTML = renderAnswer(pendingNarration || lastResponse, currentCitations, false);
          pendingAiMsg._raw = acc;
        } else if (!pendingParts.length) {
          // 连一段思考都没收到：只在界面上说「已停止」，不往对话里塞一条空记录。
          if (pendingContentEl) {
            pendingContentEl.textContent = '（已停止）';
            pendingContentEl.style.color = '#999';
          }
        }
        // 与 'end' 路径同样的去重：若本段已作为叙述段固化，就不再重复记一条文本。
        if (lastResponse && !alreadyCommittedAsText(pendingParts, lastResponse)) pendingParts.push({ type: 'text', text: lastResponse });
        // ⚠ **必须带 parts**：思考（type:'thinking'）与工具步骤只存在 parts 里。
        // 原先这里只写 content + toolSummary ⇒ 停止过的轮次在重开面板后思考与步骤整块消失，
        // 而正文还在 —— 所以症状看起来像"只有思考丢了"。
        // 另外：原先只在 `acc` 非空时入栈，"只思考到一半就停止"的那一轮**什么都没留下**。
        if (acc || pendingParts.length) {
          conversation.push({
            role: 'assistant',
            content: acc,
            toolSummary: summarizeToolParts(pendingParts),
            parts: pendingParts.slice(),
            // 计划条的唯一来源就是消息里的 plan（renderConversation 取"最近一条带计划的助手消息"）：
            // 停止的这一轮若不记它，重开面板后计划条会回退到更早那一轮的状态。
            plan: lastPlan.slice(),
          });
          saveConversation();
        }
        const note = document.createElement('div');
        note.className = 'stopped-note';
        note.textContent = '· 已停止生成';
        pendingAiMsg.appendChild(note);
        // 停止后的消息就是最后一条，给出「重新生成」入口。
        pendingAiMsg.insertAdjacentHTML('beforeend', msgActionsHtml(true));
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
  function commitInterruptedTurn(reasonText) {
    const last = conversation.length ? conversation[conversation.length - 1] : null;
    if (last && last.role === 'assistant' && last.interrupted) return;
    const turn = buildInterruptedTurn(pendingParts, pendingNarration || pendingAcc, reasonText);
    if (!turn.parts.length && !String(pendingNarration || pendingAcc || '').trim()) return;
    conversation.push(turn);
    saveConversation();
  }

  // 断线重连次数上限：只重试少量几次。
  // 不做无限重试的理由：后台若真的已被回收/扩展已被更新，重试只会变成
  // 「一直转圈 + 反复失败」，比起如实报错更糟。
  const MAX_PORT_RETRIES = 2;
  let portRetries = 0;
  let activeInstruction = '';
  let lastRunOpts = null;
  let activeConn = null;
  let readyWaiter = null;

  // 轮询「中断的会话是否已落盘」。见 onDisconnect 里的说明。
  function waitSessionReady(timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 4000);
      const tick = () => {
        if (!port || !streaming) { resolve(false); return; }
        if (Date.now() > deadline) { resolve(false); return; }
        readyWaiter = (ok) => { if (ok) resolve(true); else setTimeout(tick, 250); };
        try { port.postMessage({ type: 'session-ready', runId: activeRunId }); } catch (e) { resolve(false); }
      };
      tick();
    });
  }

  // 把「发一次 agent 请求」抽出来，供首次发送与断线重连复用。
  // 必须复用同一个 activeRunId：后台在端口断开时刻意保留了会话
  //（agent.js 的 AbortError 分支 persist({phase:'interrupted'}) 并把 messages 回滚到
  // 最近一个完整 tool turn），只有同 runId + continuation 才会被当成"接着跑"。
  function sendAgentRequest() {
    if (!port || !activeConn) return;
    try {
      activeConn.postMessage({
        action: 'agent',
        runId: activeRunId,
        sessionId: panelSessionId,
        question: activeInstruction,
        text: lastText,
        page: pageText,
        pageUrl: location.href,
        pageTitle: document.title,
        history: conversation.slice(),
        ...(portRetries > 0 || (lastRunOpts && lastRunOpts.continuation) ? { continuation: true } : {}),
        ...(pickedElements.length ? { pickedElements } : {}),
      });
    } catch (e) {
      // 端口已死（扩展被更新等）：如实告知，不要假装还在跑。
      removeTypingEl();
      showCitationHint('与扩展的连接已断开（扩展可能刚被更新），请刷新页面后重试。');
      endStream();
    }
  }

  async function run(instruction, opts) {
    const runOptions = opts || {};
    // 整页刷新后自动续跑：沿用 SW 侧已持久化的 runId（见 maybeResumeRunAfterReload）。
    activeRunId = runOptions.presetRunId || ('run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7));
    activeInstruction = String(instruction || '');
    // 首屏恢复尚未完成时不能起跑：否则会用空 history 覆盖刚恢复的会话。
    try {
      if (conversationLoadPromise) await conversationLoadPromise;
    } catch (e) {}
    if (!panelSessionId) {
      showCitationHint('会话尚未恢复完成，请稍后重试。');
      endStream();
      return;
    }
    if (panelSessionActiveId && panelSessionActiveId !== panelSessionId) {
      const activated = await sendPanelMessage('panel:activate', { id: panelSessionId });
      if (activated && activated.ok) {
        panelSessionActiveId = panelSessionId;
        if (Array.isArray(activated.sessions)) panelSessionList = activated.sessions.slice();
        renderSessionButton();
        renderSessionMenu();
      }
    }
    const acquired = await acquirePanelSessionLock(activeRunId, runOptions._lockTakeover === true);
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
    let respTimer = null;
    let respFailTimer = null;
    let respWarned = false;
    const clearRespTimers = () => {
      if (respTimer) { clearTimeout(respTimer); respTimer = null; }
      if (respFailTimer) { clearTimeout(respFailTimer); respFailTimer = null; }
    };
    lastResponse = '';
    // 拾取的元素要**跟着这条消息一起留下**（显示 + 持久化）。
    // 原先它只随本次请求发给模型，发完就清空 —— 于是对话里完全没有痕迹：
    // 看不到刚才选了什么，刷新后也找不回，而交接包里反而带着它（体验倒挂）。
    // 注意必须在清空之前取：真正的清空在 sendAgentRequest 里（见该处注释）。
    const pickedForMessage = summarizePickedForMessage(pickedElements);
    // 整页刷新后的自动续跑会传 skipUserTurn：对话历史里已经有这条用户消息
    //（persist 后恢复的），不要再重复 push、也不要重复渲染。
    const skipUserTurn = Boolean(runOptions.skipUserTurn);
    if (!skipUserTurn) {
      conversation.push(
        Object.assign(
          { role: 'user', content: instruction },
          pickedForMessage.length ? { pickedElements: pickedForMessage } : {}
        )
      );
      // 用户消息**一进对话就落盘**：整页跳转（如 GitHub 搜索）发生在这一轮中途时，
      // 新文档恢复对话才不会把这条指令丢掉。此前只在收尾/中断时 save，跳转会把它整条吞掉。
      saveConversation();
      const userMsg = document.createElement('div');
      userMsg.className = 'user-turn';
      userMsg.innerHTML =
        '<div class="msg user">' + escHtml(instruction) + pickedSummaryHtml(pickedForMessage) + '</div>' +
        userActionsHtml(conversation.length - 1);
      panelBody.appendChild(userMsg);
    }
    const aiMsg = document.createElement('div');
    aiMsg.className = 'msg ai';
    flowEl = document.createElement('div');
    flowEl.className = 'agent-flow';
    const contentEl = document.createElement('div');
    contentEl.className = 'agent-content';
    contentEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    flowEl.appendChild(contentEl);
    aiMsg.appendChild(flowEl);
    panelBody.appendChild(aiMsg);
    fitPanelHeight();
    pinToBottom();

    pendingAcc = '';
    // 新一轮开始：先清掉上一轮的计划条，等本轮的 update_plan 到达再显示。
    renderPlan([]);
    lastPlan = [];
    if (usageEl) usageEl.textContent = '';
    pendingAiMsg = aiMsg;
    pendingContentEl = contentEl;
    typingEl = contentEl;
    // 新一轮：上一轮的思考记录已成为历史，这里只清指针，不动那块 DOM。
    resetReasoning();
    pendingStarted = false;
    streaming = true;
    startProgress();
    if (stopBtn) stopBtn.style.display = '';
    if (sendBtn) sendBtn.disabled = true;

    if (!isExtContextAlive()) {
      showCitationHint('扩展已更新，当前页面的助手已失效，请刷新页面后重试。');
      endStream();
      return;
    }
    try {
      port = chrome.runtime.connect({ name: 'ai-stream' });
    } catch (e) {
      showCitationHint('扩展已更新，当前页面的助手已失效，请刷新页面后重试。');
      endStream();
      return;
    }
    const conn = port;
    activeConn = conn;
    conn.onMessage.addListener((resp) => {
      if (resp.runId && resp.runId !== activeRunId) return;
      clearRespTimers();
      if (resp.type === 'citations') {
        currentCitations = resp.citations || null;
      } else if (resp.type === 'tool-call') {
        pendingParts.push({ type: 'tool-call', callId: resp.callId, name: resp.name, args: resp.args || {}, risk: resp.risk || 'unknown' });
        appendStep(
          toolStepElement('🔧 ', resp.name, argHint(resp.args), '参数', clipDetail(JSON.stringify(resp.args || {}, null, 2), 2000))
        );
        if (resp.requiresApproval) {
          // 有两个工具的参数里含**用户必须逐字看到**的长文本：
          //   · run_javascript.code  —— 将要执行的代码；
          //   · save_skill.content   —— 将要**保存下来、进入今后系统提示**的技能正文
          //     （它是持久化的指令，比一次代码执行的影响更长远，见 lib/assistant/tool-metadata.js）。
          // 两者都从 JSON 摘要里摘出来单独用 <pre> 完整展示：截断会让这个「确认」形同虚设。
          const LONG_TEXT_FIELD = { run_javascript: 'code', save_skill: 'content' };
          const longField = LONG_TEXT_FIELD[resp.name];
          const longText = longField && resp.args ? String(resp.args[longField] || '') : '';
          // type_text 的负载字段是 value（text 现在只用于定位）。
          // 这里必须遮蔽 value，否则用户要输入的敏感内容会出现在审批提示里。
          const approvalArgs = resp.name === 'type_text' && resp.args
            ? { ...resp.args, value: '[输入内容已隐藏]' }
            : longText
              ? { ...resp.args, [longField]: '[完整内容见下方]' }
              : resp.args;
          const detail = approvalArgs && Object.keys(approvalArgs).length ? ' 参数：' + JSON.stringify(approvalArgs) : '';
          // 高风险工具（run_javascript / save_skill 每次都需审批）必须让用户看到**完整**内容：
          // 截断到 400 字符会让这个「确认」形同虚设。
          const codeBlock = longText
            ? '<div class="tool-approval-label">' +
              (resp.name === 'save_skill' ? '将要保存的技能正文（会进入今后的系统提示）' : '将要执行的完整代码') +
              '</div><pre class="tool-approval-code">' + escHtml(longText) + '</pre>'
            : '';
          const riskLabel = resp.risk === 'high' ? '高风险' : resp.risk === 'medium' ? '需确认' : '外部操作';
          // 是否显示「本任务内允许」由后台按设置下发（allowSession）；默认允许。
          const sessionBtn = resp.allowSession === false
            ? ''
            : '<button class="tool-approve-session" aria-label="本任务内允许此工具">本任务内允许</button>';
          approvalArea.innerHTML =
            '<div class="tool-approval-title">执行前需要你的确认</div>' +
            '<div class="tool-approval-summary">Agent 请求调用 <span class="tool-approval-tool">' + escHtml(resp.name) + '</span><span class="tool-approval-risk">' + riskLabel + '</span></div>' +
            (detail ? '<div class="tool-approval-detail">' + escHtml(detail.replace(/^ 参数：/, '')) + '</div>' : '') +
            codeBlock +
            '<div class="tool-approval-actions"><button class="tool-approve" aria-label="仅允许本次工具调用">允许一次</button>' + sessionBtn + '<button class="tool-reject" aria-label="拒绝工具调用">拒绝</button></div>';
          approvalArea.style.display = '';
          const decide = (decision) => {
            conn.postMessage({ type: 'tool-approval', callId: resp.callId, decision });
            approvalArea.style.display = 'none';
            approvalArea.innerHTML = '';
          };
          approvalArea.querySelector('.tool-approve').addEventListener('click', () => decide('once'));
          const sessionEl = approvalArea.querySelector('.tool-approve-session');
          if (sessionEl) sessionEl.addEventListener('click', () => decide('session'));
          approvalArea.querySelector('.tool-reject').addEventListener('click', () => decide('reject'));
        }
        fitPanelHeight();
        pinToBottom();
      } else if (resp.type === 'tool-result') {
        pendingParts.push({ type: 'tool-result', callId: resp.callId, name: resp.name, status: resp.status, result: resp.result || '' });
        appendStep(
          toolStepElement(
            resp.status === 'completed' ? '✓ 工具已完成：' : resp.status === 'failed' ? '✗ 工具失败：' : '— 工具未执行：',
            resp.name,
            '',
            resp.status === 'failed' ? '错误信息' : '返回结果',
            clipDetail(resp.result, 4000)
          )
        );
        fitPanelHeight();
        pinToBottom();
      } else if (resp.type === 'agent-state') {
        // 事件字段名是 `state`（agent-state.js 的 transition 返回 { state: next }），
        // 不是 status —— 写错会导致状态标签永远取不到，只剩步数。
        const st = resp.state || resp.status;
        const label = stateLabel(st);
        if (label) progressState = label;
        const step = Number(resp.step);
        if (Number.isFinite(step) && step > 0) progressStep = step;
        const max = Number(resp.maxSteps);
        if (Number.isFinite(max) && max > 0) progressMax = max;
        renderProgress();
      } else if (resp.type === 'screenshot') {
        // 图片给用户看：渲染成缩略图，点击放大。base64 只留在内存缓存里，
        // 不写进 pendingParts（否则会话持久化会背着几百 KB 的图到处走）。
        if (resp.id && resp.dataUrl) shotCache.set(resp.id, resp.dataUrl);
        pendingParts.push({ type: 'screenshot', id: resp.id, label: resp.label, width: resp.width, height: resp.height, bytes: resp.bytes });
        appendStep(screenshotElement(resp));
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
        budgetStopped = true;
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
        } else if (resp.deterministic) {
          // 确定性规则命中：与 LLM 校验区分开，用户才好判断这条结论的来路。
          text = '⚠ 完成前检查未通过（确定性规则，未消耗模型调用）：' + (resp.reason || '声称与实际动作不符');
        } else {
          text = '⚠ 校验未通过：' + (resp.reason || '目标可能未达成') + (resp.missing ? '（还差：' + resp.missing + '）' : '');
        }
        appendNoticePart(text, resp.ok ? '#16a34a' : '#b45309');
        fitPanelHeight();
        pinToBottom();
      } else if (resp.type === 'usage') {
        if (usageEl) usageEl.textContent = 'tokens ' + (resp.totalTokens || 0);
      } else if (resp.type === 'plan') {
        renderPlan(resp.plan);
      } else if (resp.type === 'skill') {
        const skills = Array.isArray(resp.skills) ? resp.skills : [];
        if (skills.length) {
          appendNoticePart('🛠 启用技能：' + skills.map((s) => s.title || s.name).join('、'), '', 'agent-skill');
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
        pendingAcc += resp.text;
        pendingNarration += resp.text;
        pendingStarted = true;
        if (!pendingContentEl) {
          pendingContentEl = ensureTextEl();
          if (pendingContentEl) pendingContentEl.innerHTML = '';
        }
        // 只累积，不立刻重绘：本条 chunk 与同帧内的其它 chunk 会被合并成一次渲染。
        // 累积文本在 schedule 的回调里读取，因此拿到的总是最新的一份。
        streamRender.schedule('answer', () => {
          // 流式过程中也统一重编号引用，保证正文始终从 [1] 连续
          //（生成结束后会再次校正，幂等）。
          if (pendingContentEl) pendingContentEl.innerHTML = renderAnswer(pendingNarration, currentCitations, true);
          pendingAiMsg._raw = pendingAcc;
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
        lastResponse = pendingNarration || lastNarration || '';
        // 最终回复统一重编号引用：正文从 [1] 开始，参考来源只保留被引用的文章。
        //
        // **必须跨整条消息算**：渲染时每一段文字（narration / text）都按位置对齐同一份
        // citations，若只重编号最终答复那一段，其余段落里的 [n] 仍是全局编号，
        // 会指到错误的来源（实测症状：「参考来源」列的东西与正文说的不是一回事）。
        const textParts = pendingParts.filter((p) => (p.type === 'narration' || p.type === 'text') && p.text);
        const renumbered = renumberCitationsAcross(
          textParts.map((p) => p.text).concat([lastResponse]),
          currentCitations
        );
        const finalText = renumbered.apply(lastResponse);
        const finalCitations = renumbered.citations;
        if (!pendingStarted) {
          const el = ensureTextEl();
          if (el) el.textContent = budgetStopped ? '（任务已停止，未生成最终回复）' : '（无返回内容）';
        } else if (pendingContentEl) {
          pendingContentEl.innerHTML = renderAnswer(lastResponse, currentCitations, false);
          pendingAiMsg._raw = pendingAcc;
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
          pendingAiMsg.appendChild(srcWrap);
        }
        // 刚结束的这条就是最后一条消息，直接给出「重新生成」入口
        // （否则要等面板重开触发 renderConversation 才出现）。
        if (lastResponse) pendingAiMsg.insertAdjacentHTML('beforeend', msgActionsHtml(true));
        // 最终文本只追加一次，且不与刚固化过的叙述段重复。
        // 背景：complete_task 且模型本轮无文本时，Agent 会把工具结果当 chunk 补发，
        // 于是 pendingNarration 与 lastResponse 是同一段文字 —— 曾经因此被记录两次、重渲染时显示两遍。
        if (finalText && !alreadyCommittedAsText(pendingParts, finalText)) {
          pendingParts.push({ type: 'text', text: finalText });
        }
        // 整条消息的每一段都过同一张映射表，保证正文、工具结果与参考来源区三者一致。
        const finalParts = pendingParts.map((p) => {
          if (p.type === 'narration' || p.type === 'text') {
            return p.text ? Object.assign({}, p, { text: renumbered.apply(p.text) }) : p;
          }
          // 工具结果里的 [n] 是纯文本渲染（不走 renderAnswer），但同样与参考来源区共用编号。
          if (p.type === 'tool-result' && typeof p.result === 'string') {
            return Object.assign({}, p, { result: renumbered.apply(p.result) });
          }
          return p;
        });
        conversation.push({ role: 'assistant', content: finalText, citations: finalCitations, plan: lastPlan.slice(), toolSummary: summarizeToolParts(finalParts), parts: finalParts });
        saveConversation();
        // 触底收尾：解析模型输出的「【可选操作】」小节，渲染可点击继续按钮。
        //
        // ⚠ 若流式期间面板 DOM 被重建过（SPA 导航 / 对话恢复重绘），pendingAiMsg 已脱离文档：
        // 这时最终输出只存在于 conversation 里，必须**从对话重建一次** —— 否则回答写进已脱离的
        // 节点，用户看到的就是"跳转后模型输出没了、回退又出现"（实测反馈）。
        if (!pendingAiMsg || !pendingAiMsg.isConnected) {
          try { renderConversation(); } catch (e) {}
        } else {
          renderSuggestionButtons(pendingAiMsg, finalText, run);
        }
        fitPanelHeight();
        currentCitations = null;
        endStream();
        closePort();
      } else if (resp.type === 'error') {
        removeTypingEl();
        const errText = String(resp.error || '任务失败（未提供错误信息）');
        const errEl = pendingContentEl || ensureTextEl();
        if (errEl) {
          errEl.textContent = errText;
          errEl.style.color = '#e74c3c';
        }
        if (resp.needSetup) {
          const go = document.createElement('button');
          go.textContent = '打开设置';
          go.style.cssText =
            'margin-left:8px;border:1px solid #4a90d9;color:#4a90d9;background:none;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px;';
          go.addEventListener('click', () => { try { chrome.runtime.sendMessage({ type: 'openOptions' }); } catch (e) {} });
          pendingAiMsg.appendChild(document.createElement('br'));
          pendingAiMsg.appendChild(go);
        }
        // 失败也必须在对话里留下痕迹。
        // 原实现只把错误写进 DOM：于是「导出记录」与「会话交接」都看不到它，
        // 面板一刷新更是彻底消失 —— 而失败正是最需要交接给外部 AI 的时刻。
        // 必须赶在 endStream() 之前取 pendingParts：它会把进行中的状态全部清空。
        conversation.push(buildFailedTurn(pendingParts, errText));
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
      if (port === conn) port = null;
      if (!streaming) return; // 正常结束后 closePort() 也会触发这里，不该重连
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
      try {
        port = chrome.runtime.connect({ name: 'ai-stream' });
      } catch (e) {
        endStream();
        return;
      }
      activeConn = port;
      port.onMessage.addListener((resp) => {
        if (resp.runId && resp.runId !== activeRunId) return;
        if (resp.type === 'session-ready') {
          if (readyWaiter) { const w = readyWaiter; readyWaiter = null; w(resp.ready === true); }
          return;
        }
        if (resp.type === 'end' || resp.type === 'error') streaming = false;
      });
      // 重连前确认「后台已把中断的会话落盘」。
      // 只延迟固定时间是不够的：persist 是异步的，若重连早于落盘，
      // runAgentStream 的 canResume 为 false，会把重连当成一次**新任务**从头开始 ——
      // 用户看到重复执行，历史里同一条指令出现两次。
      // 因此轮询就绪探针；若始终不就绪，则如实收尾而不是盲目重发。
      (async () => {
        const ready = await waitSessionReady(6000);
        if (!streaming) return;
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
      try { conn.postMessage({ type: 'keepalive' }); } catch (e) {}
      renewPanelSessionLock();
    }, 20000);
    conn.postMessage({
      action: 'agent',
      runId: activeRunId,
      sessionId: panelSessionId,
      question: instruction,
      text: lastText,
      page: pageText,
      pageUrl: location.href,
      pageTitle: document.title,
      history: conversation.slice(),
      ...(runOptions.continuation ? { continuation: true } : {}),
      ...(pickedElements.length ? { pickedElements } : {}),
    });
    // 断线重连复用同一个 activeRunId（见 onDisconnect）：
    // 后台在端口断开时刻意保留会话，只有同 runId + continuation 才会"接着跑"而不是重开。
    // 已选元素随本次消息发出后清空。
    if (pickedElements.length) {
      pickedElements = [];
      try { renderPick(); } catch (e) {}
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
      try { if (port) port.postMessage({ type: 'e2e-drop-port' }); } catch (e) {}
      window.dispatchEvent(new CustomEvent('__RF_E2E__dropped'));
    });
    // 15 秒无任何回流 → 提示等待；45 秒仍无 → 报错结束，避免无限转圈。
    respTimer = setTimeout(() => {
      if (!streaming || respWarned) return;
      respWarned = true;
      if (pendingContentEl) {
        const note = document.createElement('div');
        note.style.cssText = 'color:#999;font-size:11px;margin-top:4px;';
        note.textContent = '⏳ 正在等待模型响应…（网络较慢或模型繁忙）';
        pendingContentEl.appendChild(note);
      }
    }, 15000);
    respFailTimer = setTimeout(() => {
      if (!streaming) return;
      const el = pendingContentEl || ensureTextEl();
      if (el) { el.textContent = '未收到模型响应，请检查网络连接或 API 配置后重试。'; el.style.color = '#e74c3c'; }
      // 同上：入库，别让已经发生的思考/步骤随 endStream 一起蒸发。
      commitInterruptedTurn('任务中断：45 秒内未收到模型响应。');
      endStream();
      closePort();
    }, 45000);
  }

  function send() {
    if (streaming) return;
    const cmd = cmdInput.value.trim();
    if (!cmd) return;
    run(cmd);
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
      if (picking) return; // 拾取中由拾取器处理 Esc，不关闭面板
      e.preventDefault();
      e.stopPropagation();
      removePanel();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
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
  panelKeyHandler = (e) => {
    if (e.key !== 'Escape') return;
    if (picking) return;
    if (shotLightboxOpen) return; // 放大看截图时 Esc 只关图，不关面板
    if (approvalArea && approvalArea.style.display !== 'none') return;
    e.preventDefault();
    e.stopPropagation();
    removePanel();
  };
  document.addEventListener('keydown', panelKeyHandler, true);
  cmdInput.focus();

  // 拖拽
  head.addEventListener('mousedown', (e) => {
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
  runAgent = run;
  activeInterruptFn = interrupt;
  if (!suppressPanelUiPublish) publishPanelUi(true, 'global');
  subscribePanelRun().catch(() => {});
}

// 选中新内容时，刷新已打开的对话框
function refreshPanelForSelection() {
  // 流式中不打断当前生成，仅刷新选中文本预览；正在输出的回复通过 restoreStreamingUI 恢复。
  if (!streaming) closePort();
  lastResponse = '';
  if (panelTextEl) {
    panelTextEl.textContent = lastText.length > 200 ? lastText.slice(0, 200) + '…' : lastText;
    panelTextEl.title = lastText;
  }
  renderConversation();
  restoreStreamingUI();
}

// 面板是否自动跟随底部：用户手动向上滚动（查看历史）时置 false，滚回底部恢复。
let observerAutoScroll = true;

// 整页刷新后的自动续跑：问 SW 本 tab 是否有可续跑的 run，有则重开面板、用同一 runId 续跑。
// abort 与落盘是异步的：SW 可能回 pending=true（会话还没写出来），只在 pending 时重试。
function maybeResumeRunAfterReload() {
  let attempts = 0;
  const MAX_ATTEMPTS = 12;
  const tick = () => {
    if (streaming) return;
    attempts += 1;
    if (attempts > MAX_ATTEMPTS) return;
    let p = null;
    let handled = false;
    try {
      p = chrome.runtime.connect({ name: 'ai-stream' });
      p.onMessage.addListener(async (resp) => {
        if (handled || !resp || resp.type !== 'run-state') return;
        handled = true;
        try { p.disconnect(); } catch (e) {}
        if (resp.resumable && resp.runId && resp.instruction && !streaming) {
          // ⚠ 必须先等对话恢复完成再起跑：否则 run 函数会基于**空 conversation** 起一轮，
          // 随后 loadConversation 落地时 renderConversation 把正在流式输出的面板整块重建 ——
          // 用户看到的就是"跳转后模型输出不见了、回退又出现"（实测反馈）。
          try {
            if (conversationLoadPromise) await conversationLoadPromise;
          } catch (e) {}
          try {
            if (panelUiReadyPromise) await panelUiReadyPromise;
          } catch (e) {}
          if (streaming) return;
          // 面板全局关闭时，续跑仍要启动，但不能把其他标签页的面板重新拉开。
          const keepClosed = !panelUiOpen;
          suppressPanelUiPublish = keepClosed;
          openPanel(0, 0, true); // 先让 openPanel 把 run 挂到 runAgent
          suppressPanelUiPublish = false;
          // 对话历史若已恢复出这条用户消息，就跳过重复 push（见 run 的 skipUserTurn）。
          const last = conversation.length ? conversation[conversation.length - 1] : null;
          const alreadyHas = last && last.role === 'user' && String(last.content || '').trim() === String(resp.instruction).trim();
          let runPromise = null;
          if (runAgent) {
            runPromise = runAgent(String(resp.instruction), {
              continuation: true,
              presetRunId: String(resp.runId),
              skipUserTurn: Boolean(alreadyHas),
            });
          }
          if (keepClosed && runPromise && typeof runPromise.finally === 'function') {
            runPromise.finally(() => {
              if (panel) removePanel({ publish: false });
            }).catch(() => {});
          }
        } else if (resp.pending) {
          setTimeout(tick, 300);
        }
      });
      p.postMessage({ type: 'query-run' });
    } catch (e) {
      try { if (p) p.disconnect(); } catch (e2) {}
    }
  };
  tick();
}

// ---- 事件绑定与初始化 ----
export function initAssistant() {
  // 页面即将卸载（整页跳转 / 返回）前把对话落盘：这是用户消息"进对话即落盘"之外的
  // 一道兜底，盖住"刚发完立刻跳转"这类极小窗口。sendMessage 是尽力而为，不阻塞卸载。
  try {
    window.addEventListener('pagehide', () => {
      try { saveConversation(); } catch (e) {}
    });
  } catch (e) {}

  document.addEventListener('mousedown', (e) => {
    if (host && e.composedPath().includes(host)) return;
    closeSessionMenu();
    removeBubble();
  });

  document.addEventListener('scroll', () => removeBubble(), true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 拾取模式下 Esc 用于「结束选取」，不要顺带关闭面板。
      if (picking) return;
      removeBubble();
      if (panel) {
        removePanel();
        return;
      }
    }
  }, true);

  document.addEventListener('mousemove', (e) => {
    // 高亮覆盖层不接管鼠标事件，改为根据 Range 判断指针是否进入/离开证据文本。
    // 只有用户实际进入过高亮内容后才在离开时清除，避免点击引用后立刻消失。
    const inCitation = isPointerInCitationRange(e);
    if (inCitation) citeHighlightEntered = true;
    else if (citeHighlightEntered) {
      citeHighlightEntered = false;
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
      const maxLeft = Math.max(0, window.innerWidth - Math.min(pw, window.innerWidth - 24));
      const maxTop = Math.max(0, window.innerHeight - Math.min(ph, window.innerHeight - 24));
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
      const maxW = Math.max(minW, window.innerWidth - 24);
      const maxH = Math.max(minH, window.innerHeight - 24);
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
      left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - w));
      top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - h));
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
    pageText = pageContextEnabled ? extractPageText() : '';
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    if (panel) {
      refreshPanelForSelection();
      return;
    }
    ensureHost();
    showBubble(rect.left + rect.width / 2, rect.top + window.scrollY);
  });

  getAISettings().then((s) => {
    pageContextEnabled = s.pageContext !== false;
  }).catch(() => {});

  // 拾取结果/取消由后台回传（跨域 iframe 内的命中也会经后台回到顶层）。
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'kbPickResult') {
        if (pickUi) {
          pickUi.setActive(false);
          pickUi.onPicked(msg.pickedList || msg.picked);
        } else {
          picking = false;
        }
      } else if (msg.type === 'kbPickCancel') {
        if (pickUi) pickUi.setActive(false);
        else picking = false;
      } else if (msg.type === 'panel:sessions-changed') {
        handleRemotePanelSessions(msg).catch(() => {});
      } else if (msg.type === 'panel:ui-changed') {
        applyPanelUiState(msg).catch(() => {});
      } else if (msg.type === 'run:started') {
        handleRunStarted(msg);
      } else if (msg.type === 'run:delta') {
        handleRunDelta(msg);
      } else if (msg.type === 'run:ended') {
        if (String(msg.sessionId || '') === panelSessionId) scheduleFollowedRunRefresh();
      } else if (msg.type === 'panel:lock-lost') {
        if (String(msg.id || '') !== panelSessionId) return;
        if (String(msg.runId || '') && panelSessionLockRunId && String(msg.runId) !== panelSessionLockRunId) return;
        showCitationHint('另一个标签页已接管该会话，本页任务已停止。');
        if (activeInterruptFn) activeInterruptFn();
      }
    });
  } catch (e) {
    warnExtDead();
  }

  ensureHost();
  // SPA 导航移除宿主后自动重建（详见函数注释）。
  watchHostKeepalive();

  // 恢复该标签页上次的对话（SPA 跳转 / 刷新后不丢上下文）。
  // 保存 promise 供 snapshotHandoff 等待，避免「对话还没读回来就打包交接包」的竞态。
  conversationLoadPromise = loadConversation();
  // 新页面继承全浏览器面板开合状态；远端切换时由 onMessage 的 panel:ui-changed 应用。
  panelUiReadyPromise = syncPanelUiOnInit();
  // 整页刷新后自动接管"被中断的任务"：问 SW 本 tab 是否有可续跑的 run，
  // 有则重开面板、用同一 runId 续跑（SW 从持久化消息恢复，不重新执行）。
  maybeResumeRunAfterReload();

  // 跨页引用跳转落地：读取 URL 里的 kbSnippet 参数，容错高亮证据片段。
  // 页面（尤其 SPA）可能延迟渲染，做几次延迟重试。
  const kbSnippet = (typeof URLSearchParams !== 'undefined' && new URLSearchParams(location.search).get('kbSnippet')) || '';
  if (kbSnippet) {
    const snippet = decodeSnippet(kbSnippet);
    if (snippet) {
      const attempt = (tries) => {
        if (findAndHighlightCitation(snippet)) return;
        if (tries > 0) setTimeout(() => attempt(tries - 1), 700);
      };
      setTimeout(() => attempt(4), 300);
    }
  }
}

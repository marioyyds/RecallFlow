// 网页端 AI 助手 UI：悬浮按钮(FAB)/划词气泡/对话面板 + Markdown 渲染 + 对话持久化
import { getAISettings, AI_SETTINGS_DEFAULTS } from '../shared/settings.js';
import { composeProgressText } from '../shared/utils.js';

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
// 扩展被重新加载后，旧内容脚本失效：提示用户刷新。
//
// `force` 的用途（用户实测教训）：原来这里**只提示一次**（extDeadWarned 一置位就再也不提示），
// 而重载扩展后**没有刷新页面**时，点击悬浮按钮会被 openPanel 开头的
// `if (!isExtContextAlive()) { warnExtDead(); return; }` 静默挡掉 ——
// 那条红提示 6 秒后消失，之后用户点什么都是**完全没动静**（"气泡不消失但面板打不开"）。
// 所以由**用户点击**触发时传 force=true，每次都明确告诉他该刷新页面。
let extDeadWarned = false;
function warnExtDead(force) {
  if (!force && extDeadWarned) return;
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
import { newHandoffId, normalizeHandoffId, buildHandoffRecord, formatHandoffPrompt } from '../shared/handoff.js';

// 把值放进 HTML 属性时的转义。
//
// **必须在模块顶层、且在第一次使用之前**（这里就是）。原来的 bug：
// 这个助手只定义在 openPanel 内部某个函数里（局部 `const`），而模块顶层的
// `userActionsHtml()` 也用了它 —— 于是**面板一渲染对话就抛**
// `ReferenceError: escAttr is not defined`，表现为「气泡还在、面板永远打不开」。
// 那是我自己引入的（加"稳定 turnId 撤销"时用了这个助手，没注意它的作用域）。
// 现在全文件只保留**一处**定义。契约测试钉住"恰好一处 + 在顶层 + 早于首次使用"。
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

import { clearCiteHighlight, isPointerInCitationRange, findAndHighlightCitation } from './citation.js';
import { escHtml, renumberCitations, decodeSnippet, renderAnswer, planCitationOpen, parseSuggestionOptions } from './markdown.js';
import { PANEL_CSS } from './panel-css.js';
import { createBinding, normalizeBinding, describeBinding, endBinding } from '../shared/session-binding.js';
import { newSpeakTurns, countSpeakTurns, recentSpeakTurns } from '../shared/panel-turns.js';
import { sessionEntryFromFrame, trimSessionEntries, resolveRewindIndex, SESSION_SOURCE } from '../shared/session-view.js';
import {
  chosenStillExists,
  describeSessionChoice,
  shouldRenderSessionFrame,
  shortSessionId,
  sortSessionChoices,
} from '../shared/session-choice.js';

/** 载入既有历史时最多同步多少条（多了会把桥接缓冲刷满）。 */
const LOAD_PUSH_MAX = 6;
import { getDebugBuffer } from './debug-capture.js';


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
let stopBtn = null;
let streaming = false;
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
let activeRunId = null;
let planEl = null;
let lastPlan = [];

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

function removeBubble() {
  if (bubble) {
    bubble.remove();
    bubble = null;
  }
}

function removePanel() {
  // 面板销毁后步骤钩子会引用已移除的 DOM，必须解除挂载。
  panelStep = null;
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
    if (fab) fab.classList.remove('hidden');
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
  removePanel();
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
  // 用户调整过窗口尺寸后，严格尊重用户配置，不再覆盖高度。
  if (panel._manualSize) return;
  // 使用视口比例避免 4K 屏幕上面板贴得过低；桌面端限制上下限保证稳定。
  const dockGap = getDockGap();
  const topLimit = Math.max(12, Math.round(window.innerHeight * 0.10));
  // 停靠模式以底部为锚点，最大高度不超过顶部安全区；增长时只向上扩展。
  const maxH = Math.max(320, window.innerHeight - dockGap - topLimit);
  panel.style.height = 'auto';
  panelBody.style.height = 'auto';
  panelBody.style.flex = '';
  panelBody.style.overflowY = 'auto';
  let chromeH = 0;
  for (const child of panel.children) {
    if (child !== panelBody && !child.classList.contains('resize-handle')) chromeH += child.offsetHeight;
  }
  const bodyNatH = panelBody.scrollHeight;
  // 快捷语句、输入区与底栏属于固定区域，优先为它们预留高度；
  // 仅压缩可滚动的对话内容，避免底部“清空对话”被裁掉。
  const bodyAvailableH = Math.max(120, maxH - chromeH);
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
}

// 停靠模式使用相对视口高度的底部留白：大屏幕适当上移，小屏幕保持紧凑。
function getDockGap() {
  return window.innerWidth <= 640 ? 12 : Math.min(520, Math.max(120, Math.round(window.innerHeight * 0.30)));
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
const shotCache = new Map();
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

/** 给会话条目一个稳定 id —— "撤销"按钮靠它定位，而不是靠会漂移的数组下标。 */
function uid() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 让"增量推送游标"与当前 conversation 对齐。
 *
 * 游标的语义是"这份 conversation 里已经推送过多少条 speak turn"。
 * 所以每当 conversation 被**替换或截短**（清空、撤销、转发失败撤回），都必须重新对齐 ——
 * 否则游标偏高，增量推送会把新消息当成"已经推过了"而**静默跳过**。
 *
 * 现在有 run() 直送那条路兜着，所以症状被掩盖了；但**旧版扩展**（走增量推送）
 * 在"撤销/清空之后又说话"这个顺序下就会踩到。
 * 抽成一处而不是在每个变更点各写一行 —— 复制出来的第二份迟早会漏（本会话的教训）。
 */
function syncPushCursor() {
  try {
    // 注意：这一行**不能**写成 syncPushCursor() ——
    // 我用批量替换统一赋值点时，脚本把函数体里这一行也替换了，
    // 于是它变成自我递归，又被 try/catch 吞掉，成了静默空操作（与意图正好相反）。
    pushedSpeakTurns = countSpeakTurns(conversation);
  } catch (e) {}
}

function userActionsHtml(index, turnId) {
  // 同时带 id 与下标：id 是稳定的（裁剪后仍然对得上），下标只作老数据的退路。
  // 只用下标的后果：数组裁剪后所有下标前移，"撤销"会作用到**另一条**用户回合上。
  const idAttr = turnId ? ' data-turn-id="' + escAttr(String(turnId)) + '"' : '';
  return '<div class="user-actions"><button class="act-rewind"' + idAttr + ' data-turn-index="' + index + '" title="撤销这条指令及其后续对话">↶ 撤销</button><button class="act-user-copy" title="复制这条指令">⧉ 复制</button></div>';
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
function restoreStreamingUI() {
  if (!panelBody || !streaming) return;
  if (pendingContentEl && pendingContentEl.isConnected) return; // 已恢复过
  const aiMsg = document.createElement('div');
  aiMsg.className = 'msg ai';
  const flow = document.createElement('div');
  flow.className = 'agent-flow';
  aiMsg.appendChild(flow);
  // 已固化的叙述段与工具步骤先渲染回 flow。
  for (const p of pendingParts) {
    if (p.type === 'narration' && p.text) {
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
  flowEl = flow;
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
  fitPanelHeight();
  if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
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

// ---------------- 会话绑定（面板 ↔ 标签页 ↔ 捕获起点）----------------
// 面板每 tab 一个、会话是全局的，而 console/network 捕获一直是「常开但无归属」的。
// 用户点「启动」把"这个会话在讨论哪个页面、从哪一刻算起"显式化：
// 点击那一刻的缓冲快照就是起点（而不是一个会被 150 条环形缓冲挤掉的指针）。
// 纯逻辑在 lib/shared/session-binding.js（已单测）；这里只做 UI 与存储往返。
let bindingEl = null;
// ---- 会话选择：面板跟 DSH 的**哪一条**会话说话 ----
// 空串 = 未指定 = **旧行为**（插件按 currentSessionId 挑最近活跃那条）。
// 绝不默认改成"指定某条"，否则这次改动会动到所有既有用法。
let chosenSessionId = '';
/** 插件 /status 报上来的会话列表：[{ id, lastAt, isCurrent }] */
let knownSessions = [];
/** 插件当前认为"最近活跃"的那条 —— 只用于显示与比较，不决定发送目标 */
let dshCurrentSessionId = '';
let sessionChooserEl = null;
/** 上一次打过的日志内容，避免 renderSessionChooser 每次都被调时刷屏 */
let lastChooserLog = '';
let binding = null;
let navListenersBound = false;
let lastBindingState = null;
// 往对话流追加一个步骤的钩子。appendStep 定义在 openPanel 的闭包内、顶层够不到，
// 因此由 openPanel 把 appendStep 赋给它（与既有的 activeSendFn 同一手法）。
// 两个用途共用：页面漂移提示、以及外部 agent（DSH）经桥接推来的事件。
let panelStep = null;
// 外部（DSH）条目在内存里的上限：DSH 会话可能很长，不能让它无限撑大历史。
const MAX_EXTERNAL_TURNS = 200;
// 工具行单独用更紧的上限：一条会话的工具事件能到四位数，而用户与助手的对话也要留得住。
// 只按总条数裁的话，面板最后会变成"一片 ⚙，看不到聊了什么"。
const MAX_TOOL_TURNS = 60;

// 记录漂移：SPA 的 pushState 在隔离世界钩不到（改主世界钩子会修改页面行为），
// 因此 v1 靠「片段导航事件 + 交互时刷新」发现漂移；完整覆盖需 webNavigation 权限（见方案文档 §10.4）。
function bindPageNavListeners() {
  if (navListenersBound) return; // 面板可被销毁重建（removePanel/openPanel），监听器不能累积
  navListenersBound = true;
  const refresh = () => renderBindingChip();
  try {
    window.addEventListener('popstate', refresh);
    window.addEventListener('hashchange', refresh);
    window.addEventListener('focus', refresh);
  } catch (e) {}
}

function renderBindingChip() {
  if (!bindingEl) return;
  // 会话选择器跟着状态芯片一起重画：面板被销毁重建时也会走到这里，
  // 所以不需要知道顶部 HTML 的具体结构（插在既有芯片旁边即可）。
  renderSessionChooser();
  const d = describeBinding(binding, location.href, { now: Date.now() });
  bindingEl.textContent = d.text;
  bindingEl.title = d.title;
  bindingEl.setAttribute('data-state', d.state);
  bindingEl.setAttribute('aria-label', d.title);
  // 漂移只在「跃迁进 drifted」时提示一次：SPA 会频繁 pushState，每次导航都提示会变成噪音；
  // 而一旦进入 drifted，后续导航不再改变状态，因此不会重复刷屏。
  if (d.state === 'drifted' && lastBindingState !== 'drifted' && panelStep && binding) {
    notifyDriftInline(binding.startUrl, location.href);
  }
  lastBindingState = d.state;
}

/**
 * 顶部「这条消息送进哪条 DSH 会话」的选择器。
 *
 * 为什么做成 `<select>`：原生控件自带键盘可达与"当前选了什么"的显示，
 * 不需要自己写下拉 —— 而这个功能最怕的就是**看不出实际发给了谁**。
 * 插在既有状态芯片旁边，因此不依赖顶部 HTML 的具体结构。
 */
function ensureSessionChooser() {
  if (sessionChooserEl && sessionChooserEl.isConnected) return sessionChooserEl;
  const host = bindingEl && bindingEl.parentNode;
  if (!host) return null;
  const sel = document.createElement('select');
  sel.className = 'rf-session-chooser';
  sel.setAttribute('aria-label', '选择这条消息送进哪条 DSH 会话');
  sel.addEventListener('change', () => {
    chosenSessionId = sel.value || '';
    try {
      chrome.storage.local.set({ 'recallflow.dshSession': chosenSessionId });
    } catch (e) {}
    renderSessionChooser();
  });
  // 点开/聚焦时刷一次列表：插件的登记是"有人发消息时才补全"的，
  // 只在面板载入时取一次会让列表越来越旧（表现为"新会话不在里面"）。
  sel.addEventListener('focus', refreshSessionChoices);
  sel.addEventListener('mousedown', refreshSessionChoices);
  host.insertBefore(sel, bindingEl.nextSibling);
  sessionChooserEl = sel;
  return sel;
}

/** 重画选择器：选项、当前值、以及"选中的那条已经不在列表里"的提示。 */
function renderSessionChooser() {
  const sel = ensureSessionChooser();
  if (!sel) return;
  const list = sortSessionChoices(knownSessions, dshCurrentSessionId);
  const missing = !!chosenSessionId && !chosenStillExists(chosenSessionId, knownSessions);
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '跟随最近活跃（未指定）';
  sel.appendChild(auto);
  for (const it of list) {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent =
      shortSessionId(it.id) +
      (it.isCurrent ? '（最近活跃）' : '') +
      // 「未载入」必须说出来：那种会话插件拿不到 agent，选了也发不进去。
      // 让用户在选择时就看到，而不是打完字才撞上 503。
      (it.live === false ? '（未载入·发送前请先在 DSH 里打开它）' : '');
    sel.appendChild(o);
  }
  // 选中的会话不在列表里（被关了、或插件重启后还没见过它）：**补一个选项并标出来**。
  // 不能让它悄悄掉回"跟随最近活跃" —— 那正是"以为发给了 A、实际发给了 B"的来源。
  if (missing) {
    const o = document.createElement('option');
    o.value = chosenSessionId;
    o.textContent = shortSessionId(chosenSessionId) + '（不在当前列表里）';
    sel.appendChild(o);
  }
  sel.value = chosenSessionId;
  const desc = describeSessionChoice(chosenSessionId, dshCurrentSessionId);
  sel.title = missing ? desc + ' —— 这条会话不在列表里，消息可能发不出去' : desc;
  // 一条**低噪**日志（只在内容变化时打）：面板在 shadow DOM 里，普通 DOM 快照看不见它，
  // 所以"面板上到底有没有选择器、认到几条会话"从外部只能靠 console 读出来。
  // 这条日志是排查"不能选择"时唯一的窗口，别删。
  const stamp = list.length + '|' + chosenSessionId + '|' + (missing ? 'missing' : 'ok');
  if (stamp !== lastChooserLog) {
    lastChooserLog = stamp;
    console.log('[recallflow] 会话选择器已就绪：' + (list.length + 1) + ' 个选项，当前=' + (chosenSessionId || '未指定'));
  }
  sel.setAttribute('data-state', missing ? 'missing' : chosenSessionId ? 'pinned' : 'auto');
}

/** 问后台要一次会话列表（列表来自插件 /status）。失败不影响面板自身。 */
function refreshSessionChoices() {
  try {
    chrome.runtime.sendMessage({ type: 'panel:sessions' }, (resp) => {
      void chrome.runtime.lastError;
      if (resp && resp.ok) {
        knownSessions = resp.sessions || [];
        dshCurrentSessionId = resp.currentSessionId || '';
        renderSessionChooser();
      }
    });
  } catch (e) {}
}

// 选择是持久的：面板重开也要记得。读到空 = 未指定 = 旧行为。
try {
  chrome.storage.local.get(['recallflow.dshSession'], (r) => {
    void chrome.runtime.lastError;
    chosenSessionId = String((r && r['recallflow.dshSession']) || '');
    renderSessionChooser();
    refreshSessionChoices();
  });
} catch (e) {}

/** 把「页面变了」写进对话流，而不是只让顶部芯片变色 —— 芯片容易被忽略。 */function notifyDriftInline(from, to) {
  if (!panelBody || !panelBody.isConnected) return;
  // 与外部条目同样直接挂进消息列表：走 appendStep 会在「没有进行中的对话流」时
  // 被静默丢弃（flowEl 为 null），而漂移恰恰常发生在没有运行中的时候。
  appendExternalEntry(
    'dsh',
    'warn',
    '⚠ 页面已变化：本会话开始时是 ' + (from || '(未记录)') + '，现在是 ' + (to || location.href) +
      '。工具会作用于「当前」页面。若要以当前页面为新起点，点顶部状态结束，再点一次即可重新绑定。'
  );
}

/**
 * （已删除）renderBridgeEvent：渲染旧 DSH 插件经桥接推来的 say/tool 事件。
 *
 * 那条路整条消失了：生产者（旧插件）与传输（桥接的 /event + events 队列）都已移除，
 * 面板现在渲染 DSH 会话本身的事件（renderSessionEvent → lib/shared/session-view.js）。
 * 保留这段说明是为了让后来者知道"为什么这里少了一块"，而不是以为漏了实现。
 */

/**
 * 渲染一条**会话事件**（新架构：只有一条会话，面板是它的一个视图）。
 *
 * 判断逻辑（渲染哪些、如何去重）在 lib/shared/session-view.js 里，是纯函数、可单测；
 * 这里只负责把它给的动作落到 DOM 与内存里。
 *
 * 落库与渲染都沿用 renderBridgeEvent 那一套（role:'external' + appendExternalEntry），
 * 这样实时渲染、重载后重建、导出三条路径共用同一份形状，不需要第三种真相。
 */
function renderSessionEvent(frame) {
  try {
    // 顺手记下"插件认为最近活跃的是哪条"（只用于显示与比较，不决定发送目标）。
    if (frame && frame.sessionId) dshCurrentSessionId = String(frame.sessionId);
    // 选了会话就**只看那条** —— 否则切了会话还会看到别的会话的消息混进来。
    // 未指定时恒为 true（旧行为一点不变）；帧里没有 sessionId 也不隐藏
    // （宁可多显示，也不要让人以为消息丢了）。规则在被单测钉住的纯函数里。
    if (!shouldRenderSessionFrame(frame, chosenSessionId)) return;
    const d = sessionEntryFromFrame(frame, conversation);
    if (d.action === 'mark-local') {
      // 回声：把本地那条标记一下，不再重复显示
      const m = conversation[d.index];
      if (m) m.echoedFromSession = true;
      saveConversation();
      return;
    }
    if (d.action !== 'append') return;

    conversation.push({
      role: 'external',
      source: SESSION_SOURCE,
      who: d.who,
      kind: d.kind, // 'tool' | 'user' | 'assistant' —— 裁剪时工具行用更紧的上限（见 trimSessionEntries）
      level: '',
      content: d.line,
    });
    // 裁剪交给纯函数（lib/shared/session-view.js），两条渲染路径共用同一套规则。
    // 就在本地改这个数组的内容，不换引用 —— 其他地方还持有 conversation。
    const before = conversation.length;
    const kept = trimSessionEntries(conversation, { maxExternal: MAX_EXTERNAL_TURNS, maxTool: MAX_TOOL_TURNS });
    const removed = before - kept.length;
    conversation.length = 0;
    conversation.push(...kept);
    // **DOM 也要跟着裁**：上面只裁了数组，而 appendExternalEntry 每来一个事件就追加一个节点。
    // 一条会话的 eventsSeen 已到四位数 —— 面板开几小时就是上千个节点，
    // 越用越卡，而且症状（变慢）跟"数据不对"看起来毫无关系。
    // 数组里被裁掉的都是 external，而它们对应的正是 panelBody 里 .msg.ext 的顺序。
    if (removed > 0 && panelBody && panelBody.isConnected) {
      const nodes = panelBody.querySelectorAll('.msg.ext');
      for (let i = 0; i < removed && i < nodes.length; i++) {
        try {
          nodes[i].remove();
        } catch (e) {}
      }
    }
    saveConversation();
    // 把 kind 一起传下去：appendExternalEntry 靠它决定助手消息要不要走 Markdown。
    appendExternalEntry(d.who, '', d.line, d.kind);
  } catch (e) {}
}

/**
 * 把一条用户回合画进消息列表，返回画出来的节点（面板没开时返回 null）。
 *
 * 为什么必须是一个共用函数：这条路径原本只存在于 runLocally 里，
 * 而我改成"先试 DSH"之后，run() 只把回合记进 conversation、**没有画** ——
 * 于是回声回来时走的是 mark-local（只标记、不追画），
 * 结果**用户自己说的话永远不会显示**。这个 bug 在测试里看不见（DOM 路径），
 * 只有真实面板能暴露。
 *
 * 两条路径必须共用同一份实现 —— 复制一份就会像上面那样漏掉渲染（或漏掉别的东西）。
 */
function appendUserTurn(instruction, index) {
  if (!panelBody || !panelBody.isConnected) return null;
  const userMsg = document.createElement('div');
  userMsg.className = 'user-turn';
  const idx = Number.isFinite(index) ? index : conversation.length - 1;
  const turnId = conversation[idx] && conversation[idx].id;
  userMsg.innerHTML =
    '<div class="msg user">' + escHtml(instruction) + '</div>' + userActionsHtml(idx, turnId);
  panelBody.appendChild(userMsg);
  try {
    panelBody.scrollTop = panelBody.scrollHeight;
  } catch (e) {}
  return userMsg;
}

/**
 * 把一条外部条目画进消息列表。
 *
 * 为什么**不**用 appendStep：它只把 step 追加进 flowEl，而 flowEl 只在一次 agent 运行
 * 期间存在（在 openPanel/流式路径里创建、运行结束时清空）。DSH 事件随时会来，那时
 * flowEl 多半是 null → step 被 `if (flowEl)` 静默丢弃。
 * 表现正是用户报的「导出里有、屏幕上看不到」。
 * 这里直接用与 renderConversation 的 external 分支**同构**的 .msg.ext，保证实时渲染
 * 与重载后重建的长相一致。
 */
function appendExternalEntry(who, level, line, kind) {
  if (!panelBody || !panelBody.isConnected) return;
  const el = document.createElement('div');
  el.className = 'msg ext ' + (who === 'user' ? 'ext-user' : level === 'warn' ? 'ext-warn' : 'ext-dsh');
  // 助手消息必须走 Markdown 渲染。
  //
  // 早先这里是无条件 `el.textContent = line` —— 于是**从 DSH 会话回声回来的**助手回答
  // 全部当成纯文本显示：`**加粗**`、表格、代码块都原样露出来
  // （用户实测："recallflow 的 md 渲染不对"，而他截图里左边 DSH GUI 是正常渲染的）。
  // 面板本地生成的回答走的是 renderAnswer（见上面多处），回声这条必须用同一个渲染器，
  // 否则同一段话在两个界面里长得不一样。
  //
  // 只对 assistant 这么做：user / tool 行是过程信息（谁说了什么、调了什么工具），
  // 按 Markdown 解释它们反而会把工具名、路径里的符号吃掉。它们保持纯文本。
  if (kind === 'assistant') {
    try {
      el.innerHTML = renderAnswer(String(line == null ? '' : line), [], false);
    } catch (e) {
      el.textContent = line;
    }
  } else {
    el.textContent = line;
  }
  panelBody.appendChild(el);
  try {
    panelBody.scrollTop = panelBody.scrollHeight;
  } catch (e) {}
}

function loadBinding() {
  try {
    chrome.runtime.sendMessage({ type: 'bind:get' }, (r) => {
      if (chrome.runtime.lastError) return;
      binding = normalizeBinding(r && r.binding);
      renderBindingChip();
    });
  } catch (e) {}
}

function startBinding() {
  if (!bindingEl) return;
  bindingEl.textContent = '… 正在建立起点';
  bindingEl.setAttribute('data-state', 'busy');
  // 起点 = 当前缓冲快照。取不到（主世界钩子未就绪）时退化为空快照，不阻塞绑定。
  Promise.all([getDebugBuffer('console').catch(() => []), getDebugBuffer('network').catch(() => [])]).then(
    ([consoleBuf, networkBuf]) => {
      const next = createBinding({
        url: location.href,
        title: document.title,
        console: consoleBuf,
        network: networkBuf,
        now: Date.now(),
      });
      try {
        chrome.runtime.sendMessage({ type: 'bind:save', binding: next }, (r) => {
          // 必须读一次 lastError：否则控制台会多出 "Unchecked runtime.lastError"。
          // 这是个用来调试页面的工具，自己污染控制台是自相矛盾的。
          void chrome.runtime.lastError;
          binding = normalizeBinding((r && r.binding) || next);
          renderBindingChip();
        });
      } catch (e) {
        binding = next;
        renderBindingChip();
      }
    }
  );
}

function endCurrentBinding(reason) {
  if (!binding) return;
  const ended = endBinding(binding, reason || '用户结束', Date.now());
  binding = ended;
  renderBindingChip();
  try {
    chrome.runtime.sendMessage({ type: 'bind:save', binding: ended }, () => void chrome.runtime.lastError);
  } catch (e) {}
}

function onBindingClick() {
  // 已绑定 → 再点即结束。这里**不弹 native confirm**：
  // 1) 结束是可恢复的（记录保留 endedAt 与起点快照，再点一次就重启）；
  // 2) 面板是注入在别人页面里的，弹页面级原生模态很打扰，且与面板自己的审批 UI 风格不一。
  if (binding && !binding.endedAt) {
    endCurrentBinding('用户结束');
    return;
  }
  startBinding();
}

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
  if (!conversation.length) {
    panelBody.className = 'p-body';
    panelBody.innerHTML = '<div class="msg ai">' + (lastText ? '输入指令，AI 将基于选中文本执行。' : '输入指令，AI 将直接执行（可基于知识库）。') + '</div>';
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

  panelBody.className = 'p-body';
  panelBody.innerHTML = conversation
    .map((m, index) => {
      if (m.role === 'user') {
        return '<div class="user-turn"><div class="msg user">' + escHtml(m.content) + '</div>' + userActionsHtml(index, m.id) + '</div>';
      }
      // 外部（DSH）条目必须独立渲染：否则下面那条通用分支会把它当成「AI 说过的话」。
      // 这类条目由桥接事件写入（见 renderBridgeEvent），因此也会出现在导出与会话历史里。
      if (m.role === 'external') {
        const cls = m.who === 'user' ? 'ext-user' : m.level === 'warn' ? 'ext-warn' : 'ext-dsh';
        return '<div class="msg ext ' + cls + '">' + escHtml(m.content || '') + '</div>';
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
          if (p.type === 'narration' && p.text) {
            return '<div class="agent-content">' + renderAnswer(p.text, m.citations, false) + '</div>';
          }
          if (p.type === 'text' && p.text) {
            return '<div class="agent-content">' + renderAnswer(p.text, m.citations, false) + '</div>';
          }
          return '';
        })
        .join('');
      const hasInlineText = parts.some((p) => p.type === 'narration' || (p.type === 'text' && p.text));
      const contentHtml = hasInlineText ? '' : renderAnswer(m.content || '', m.citations);
      return (
        '<div class="msg ai">' + planHtml(m.plan) + '<div class="agent-flow">' + flowHtml + '</div>' +
        contentHtml +
        citeSourcesHtml(m.citations) +
        (m.content ? msgActionsHtml(index === conversation.length - 1) : '') +
        '</div>'
      );
    })
    .join('');
  // 关联原始文本，供操作栏复制使用
  const aiEls = panelBody.querySelectorAll('.msg.ai');
  let aiIdx = 0;
  for (const m of conversation) {
    // external 条目不是 .msg.ai，必须跳过，否则 aiIdx 会错位、把原文关联到错的元素上。
    if (m.role === 'user' || m.role === 'external') continue;
    if (aiEls[aiIdx]) aiEls[aiIdx]._raw = m.content || '';
    aiIdx++;
  }
}

function renderPlan(plan) {
  lastPlan = Array.isArray(plan) ? plan : [];
  if (!pendingAiMsg) return;
  if (!planEl || !planEl.isConnected) {
    planEl = document.createElement('div');
    planEl.className = 'agent-plan';
    pendingAiMsg.insertBefore(planEl, pendingAiMsg.firstChild);
  }
  const items = lastPlan
    .map((p) => {
      const st = p.status === 'done' ? 'done' : p.status === 'in_progress' ? 'in_progress' : 'pending';
      const mark = st === 'done' ? '✓' : st === 'in_progress' ? '▶' : '○';
      return '<div class="agent-plan-item ' + st + '">' + mark + ' ' + escHtml(p.text || '') + '</div>';
    })
    .join('');
  planEl.innerHTML = '<div class="agent-plan-title">执行计划</div>' + items;
  fitPanelHeight();
  if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
}

function planHtml(plan) {
  if (!Array.isArray(plan) || !plan.length) return '';
  const items = plan
    .map((p) => {
      const st = p.status === 'done' ? 'done' : p.status === 'in_progress' ? 'in_progress' : 'pending';
      const mark = st === 'done' ? '✓' : st === 'in_progress' ? '▶' : '○';
      return '<div class="agent-plan-item ' + st + '">' + mark + ' ' + escHtml(p.text || '') + '</div>';
    })
    .join('');
  return '<div class="agent-plan"><div class="agent-plan-title">执行计划</div>' + items + '</div>';
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
// 从对话数据模型生成 markdown，而不是抓 panelBody.textContent ——
// 后者会掺入输入框 placeholder、按钮文字（「↶ 撤销⧉ 复制」）且丢失角色分隔，
// 作为交给 AI 或贴进工单的记录基本不可读。
function buildTranscriptMarkdown() {
  const clip = (s, n) => {
    const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  const out = [];
  out.push('# RecallFlow 对话记录');
  out.push('');
  out.push('- 页面：' + (document.title || '(无标题)'));
  out.push('- URL：' + location.href);
  out.push('- 导出时间：' + new Date().toLocaleString());
  const hid = handoffId || '';
  if (hid) {
    out.push('- 会话标识：' + hid + '（AI 可调用 recallflow_session("' + hid + '") 取回完整上下文）');
  }
  out.push('');
  if (!conversation.length) {
    out.push('（暂无对话）');
    return out.join('\n') + '\n';
  }
  for (const m of conversation) {
    if (!m) continue;
    if (m.role === 'user') {
      out.push('## 用户');
      out.push('');
      out.push(String(m.content || ''));
      out.push('');
      continue;
    }
    out.push('## RecallFlow');
    out.push('');
    const parts = Array.isArray(m.parts) ? m.parts : [];
    const results = new Map();
    for (const p of parts) {
      if (p && p.type === 'tool-result' && p.callId) results.set(p.callId, p);
    }
    const narrations = [];
    const toolLines = [];
    for (const p of parts) {
      if (!p) continue;
      if ((p.type === 'narration' || p.type === 'text') && p.text) {
        const t = String(p.text).trim();
        if (t) narrations.push(t);
      } else if (p.type === 'tool-call') {
        const r = results.get(p.callId);
        const mark = !r ? '…' : r.status === 'completed' ? '✓' : r.status === 'failed' ? '✗' : '—';
        const args = p.args && Object.keys(p.args).length ? clip(JSON.stringify(p.args), 240) : '{}';
        toolLines.push('- `' + p.name + '` ' + args + ' → ' + mark + ' ' + clip(r ? r.result : '', 500));
      }
    }
    for (const n of narrations) {
      out.push(n);
      out.push('');
    }
    if (toolLines.length) {
      out.push('### 工具执行（' + toolLines.length + ' 步）');
      out.push('');
      out.push(...toolLines);
      out.push('');
    }
    // 结论：若最后一段叙述就是最终文本则不重复
    const content = String(m.content || '').trim();
    const dup = content && narrations.length && narrations[narrations.length - 1] === content;
    if (content && !dup) {
      out.push('### 结论');
      out.push('');
      out.push(content);
      out.push('');
    }
    if (Array.isArray(m.citations) && m.citations.length) {
      out.push('### 参考来源');
      out.push('');
      for (const c of m.citations) {
        out.push('- [' + c.index + '] ' + (c.title || '') + (c.url ? ' — ' + c.url : ''));
      }
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function serializeConversation() {
  // 存之前先按**同一套规则**裁剪，而且必须带上 kind。
  //
  // 两个都踩过：
  //  ① 原来只 slice(-20)。工具行会渲染之后，最后 20 条可能**全是 ⚙** ——
  //     重载后面板就只剩一堆工具行，用户与助手的对话整体消失。
  //  ② 原来不存 kind。重载后工具行不再被认作工具行，于是 trimSessionEntries
  //     的"工具行单独限流"形同虚设 —— 这类"新加的字段忘了过持久化边界"的问题，
  //     只有在重载后才暴露，而重载恰好是每次改代码的必经步骤。
  // 上限直接复用显示那套常量，而不是另写一组数字 ——
  // 两处各写一组，迟早会各自演化（我上一版就是 60 显示 / 20 落盘，还得额外解释）。
  const kept = trimSessionEntries(conversation, {
    maxExternal: MAX_EXTERNAL_TURNS,
    maxTool: MAX_TOOL_TURNS,
  }).slice(-MAX_EXTERNAL_TURNS);
  return kept.map((m) => {
    const copy = { role: m.role };
    if (typeof m.content === 'string') copy.content = m.content.slice(0, 4000);
    if (typeof m.toolSummary === 'string' && m.toolSummary) copy.toolSummary = m.toolSummary.slice(0, 600);
    if (Array.isArray(m.parts)) copy.parts = m.parts.slice(-30);
    if (Array.isArray(m.citations)) {
      copy.citations = m.citations.slice(0, 20).map((c) => ({
        index: c.index, source: c.source, id: c.id, title: c.title, url: c.url,
        snippet: String(c.snippet || '').slice(0, 300),
      }));
    }
    if (Array.isArray(m.plan)) copy.plan = m.plan;
    // 外部（DSH）条目的来源标记：不带上就会在重载后失去"谁说的"这一信息
    if (m.who) copy.who = m.who;
    if (m.level) copy.level = m.level;
    if (m.source) copy.source = m.source;
    // kind 必须一起存：裁剪靠它区分"工具行"与"对话"，不存就静默失效
    if (m.kind) copy.kind = m.kind;
    // 回声去重的两个字段同理：不存则重载后退回"文本 + 最近若干条"的猜法，
    // 而那条路在同一句话说两遍时**必然分不清** —— 正是 rpcId 机制要解决的问题。
    if (m.rpcId) copy.rpcId = m.rpcId;
    if (m.echoedFromSession) copy.echoedFromSession = true;
    return copy;
  });
}
function saveConversation() {
  try {
    chrome.runtime.sendMessage({ type: 'conv:save', conversation: serializeConversation() });
  } catch (e) {}
  pushPanelTurnIfNew();
}

// 反向通道（面板 → DSH）：把面板**自己的**回合推给桥接，DSH 侧用 panel_history 读回。
// 挂在 saveConversation 上，因为它在每次对话变化时都会被调用。
//
// 注意「按已推条数增量推送」而不是"只取最新一条" —— 后者有一个真实缺陷：
// 用户回合在 chat.js 里 push 之后**没有立刻调用 saveConversation**，等到下一次保存时
// 最新一条已经是助手的回答，于是**用户回合被整个跳过**，反向同步里永远看不到
// "用户在面板里问了什么"。规则在 lib/shared/panel-turns.js（纯函数，有测试钉死）。
let pushedSpeakTurns = 0;
function sendPanelTurn(m) {
  try {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'panel:turn',
          role: m.role,
          text: m.content,
          // 选了会话就带上；未指定时**不带这个字段** —— 请求体与改动前一模一样。
          ...(chosenSessionId ? { sessionId: chosenSessionId } : {}),
          pageUrl: location.href,
          pageTitle: document.title,
        },
        (resp) => {
          // 后台把插件回传的 rpcId 交回来。把它记在**这条本地回合**上，
          // 这样当同一句话从 DSH 会话回声回来时（事件里带着同一个 rpcId），
          // 面板能精确认出"这是我刚发出去的那条"，而不是靠文本+最近若干条去猜
          // —— 同一句话说两遍时，猜法必然分不清。
          void chrome.runtime.lastError;
          const rpcId = resp && resp.rpcId;
          if (rpcId) {
            try {
              m.rpcId = rpcId;
              saveConversation();
            } catch (e) {}
          }
          // 失败时**明确说清"这条没送出去"**：指定会话时最可能的失败就是"找不到那条会话"。
          // 这里静默格外糟 —— 用户会以为消息已经进了某条对话（而它并没有）。
          if (resp && resp.ok === false && resp.error) {
            try {
              appendExternalEntry('dsh', 'warn', '⚠ 这条没送进 DSH：' + resp.error);
            } catch (e) {}
          }
          resolve(!!(resp && resp.ok));
        }
      );
    });
  } catch (e) {
    return Promise.resolve(false);
  }
}
function pushPanelTurnIfNew() {
  try {
    const { turns, pushed } = newSpeakTurns(conversation, pushedSpeakTurns);
    pushedSpeakTurns = pushed;
    for (const m of turns) sendPanelTurn(m);
  } catch (e) {}
}
async function loadConversation() {
  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'conv:get' }, (r) => resolve(r || { conversation: [] }));
    });
    if (res && Array.isArray(res.conversation) && res.conversation.length) {
      conversation = res.conversation;
      // 老数据可能没有 id（id 是后来加的）：补上，否则"撤销"只能退回下标，
      // 而裁剪会让下标漂移、指到另一条回合上。
      for (const m of conversation) {
        if (m && m.role === 'user' && !m.id) m.id = uid();
      }      // **不要把载入的历史再推给 DSH。**
      // 这里原本会把最近若干条重推一次，注释写着"由服务端连续去重兜住" ——
      // 而那个去重（recordPanelTurn）已在删除清单第 4 步随桥接的同步部分一起移除。
      // 新架构下这么做的后果比旧版严重得多：面板里缓存的旧消息会以**真实用户消息**的身份
      // 重新进入会话，还会唤醒空闲会话（旧版只是重复显示一遍）。
      // 设计上它本来就是错的：只有一条会话，会话才是真相，面板里的副本只是本地缓存。
      // 计数器同步仍要做，否则下一次增量推送会把老内容当成新的再发一遍。
      syncPushCursor();
      if (panelBody) {
        renderConversation();
        fitPanelHeight();
      }
    }
  } catch (e) {
  } finally {
    conversationLoaded = true;
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

/** 轮换出一个新标识（用于「清空对话」后开启新会话）。 */
function resetHandoffId() {
  handoffId = newHandoffId();
  try {
    localStorage.setItem(HANDOFF_ID_KEY, handoffId);
  } catch (e) {}
  renderHandoffChip();
  return handoffId;
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
    const url = extUrl('lib/page/debug-capture.js');
    if (url) {
      const dc = await import(url);
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
  try {
    record = buildHandoffRecord({
      id,
      pageUrl: location.href,
      pageTitle: document.title,
      messages: conversation,
      pickedElements: picked,
      selection: lastText,
      consoleEntries,
    });
  } catch (e) {
    return false;
  }
  // 返回是否真的落库：复制是同步的、保存是异步的，若用户刚复制就粘贴，
  // AI 可能还查不到这条记录。调用方据此在芯片上如实显示状态。
  return await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'handoff:save', record }, (resp) => {
        resolve(!chrome.runtime.lastError && !(resp && resp.ok === false));
      });
    } catch (e) {
      resolve(false);
    }
  });
}

/** 打开面板的安全外壳。
 *
 * 为什么需要：openPanel 一开头就把悬浮气泡藏起来（`fab.classList.add('hidden')`），
 * 然后在后面几百行里建面板。**中途任何一步抛异常**，界面就停在
 * 「气泡消失了、面板也没出来」的死状态 —— 用户实测报的正是这个现象，
 * 而且此时他只能刷新页面才能再点开。
 *
 * 所以：任何异常都必须把气泡放回去，并把原因显示在面板上。这样至少
 * ①用户能继续操作，②我们能看到真实错误信息（扩展的 console 捕获目前是空的，
 * 这条提示是唯一能把它带出来的路径）。
 */
function openPanel(x, y, docked) {
  try {
    openPanelInner(x, y, docked);
  } catch (e) {
    try {
      if (fab) fab.classList.remove('hidden');
    } catch (_) {}
    const msg = (e && e.message) || String(e);
    try {
      showCitationHint('面板打开失败：' + msg + '（已恢复悬浮按钮，可重试）');
    } catch (_) {}
    console.error('[recallflow] openPanel 失败：', e);
  }
}

function openPanelInner(x, y, docked) {
  if (!isExtContextAlive()) {
    // force=true：用户**点了按钮**，每次都告诉他"要刷新页面" —— 详见 warnExtDead 的注释。
    warnExtDead(true);
    // 同时把状态写到悬浮按钮上，这样即使提示已经淡出，鼠标悬停也能看到该怎么办。
    try {
      if (fab) {
        fab.title = 'RecallFlow 已更新：请刷新页面后重试';
        fab.setAttribute('aria-label', 'RecallFlow 已更新，请刷新页面');
        fab.classList.add('ext-dead');
      }
    } catch (_) {}
    return;
  }
  // 一旦探测到扩展上下文恢复（用户刷新过页面），把上面的标记清掉。
  try {
    if (fab) {
      fab.classList.remove('ext-dead');
      fab.title = 'RecallFlow';
      fab.setAttribute('aria-label', '打开 RecallFlow');
    }
  } catch (_) {}
  removeBubble();
  removePanel();
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
  close.addEventListener('click', removePanel);
  const usage = document.createElement('span');
  usage.className = 'usage';
  usageEl = usage;
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
  // 会话绑定芯片：点一下把「这个面板 ↔ 当前页面 ↔ 捕获起点」显式绑起来。
  const bindBtn = document.createElement('button');
  bindBtn.className = 'bind';
  bindingEl = bindBtn;
  renderBindingChip();
  bindBtn.addEventListener('click', onBindingClick);

  // 主题切换：跟随系统 ↔ 深色 ↔ 浅色 循环（深色主题样式早已写好，此前从未被接上）。
  themeBtn = document.createElement('button');
  themeBtn.className = 'theme';
  themeBtn.addEventListener('click', cycleTheme);
  applyTheme();
  head.appendChild(logo);
  head.appendChild(title);
  head.appendChild(bindBtn);
  // 会话选择器**必须在这里**插：芯片在上一行之前还没有 parentNode，
  // 而 `ensureSessionChooser()` 是靠 `bindingEl.parentNode` 找位置的。
  // 实测过一次：只在 `renderBindingChip()` 里顺手调它（那时 append 还没发生）
  // → 选择器**从未被创建**，用户侧的全部表现就是"不能选择"。
  ensureSessionChooser();
  renderSessionChooser();
  head.appendChild(usage);
  head.appendChild(handoffBtn);
  head.appendChild(themeBtn);
  head.appendChild(close);
  panel.appendChild(head);
  // 绑定状态来自后台（内容脚本默认读不到 storage.session），因此异步加载后刷新芯片。
  loadBinding();
  bindPageNavListeners();

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
  const pbEl = panelBody;
  pbEl.addEventListener('scroll', () => {
    // 直接引用创建时的元素（不依赖可能被置空的模块变量 panelBody），彻底规避空指针。
    if (!pbEl) return;
    // 距底部 < 40px 视为在底部（恢复自动跟随），否则用户在看历史（暂停跟随）。
    observerAutoScroll = pbEl.scrollHeight - pbEl.scrollTop - pbEl.clientHeight < 40;
  });
  panelBody.addEventListener('click', (e) => {
    const rewind = e.target.closest('.act-rewind');
      if (rewind) {
        if (streaming) return;
        // 优先按稳定 id 定位：数组会被裁剪，旧下标可能已经指向**另一条**用户回合。
        // 解析逻辑抽成纯函数（lib/shared/session-view.js 的 resolveRewindIndex），有单测。
        const index = resolveRewindIndex(conversation, rewind.getAttribute('data-turn-id'), rewind.getAttribute('data-turn-index'));
        if (index >= 0 && conversation[index] && conversation[index].role === 'user') {
          const undone = conversation[index];
          conversation = conversation.slice(0, index);

          syncPushCursor();
          saveConversation();
          renderConversation();
          fitPanelHeight();
          if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
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

      syncPushCursor();
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
        '<label class="approval-item approval-runjs">run_javascript 审批：<select data-runjs><option value="each">每次确认</option><option value="session">本任务内允许一次</option><option value="auto">自动批准</option></select></label>' +
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
  getAISettings().then((s) => { const p = s.toolApprovalPolicy || { read: true }; approvalSettings.querySelectorAll('[data-policy]').forEach((x) => { x.checked = p[x.dataset.policy] === true; x.addEventListener('change', async () => { const policy = Object.fromEntries([...approvalSettings.querySelectorAll('[data-policy]')].map((y) => [y.dataset.policy, y.checked])); try { await chrome.storage.local.set({ aiSettings: { ...s, toolApprovalPolicy: policy } }); } catch (e) { warnExtDead(); } autopilotEl.checked = ['read', 'edit', 'commands', 'browser', 'mcp'].every((k) => policy[k] === true); refreshApprovalLabel(); }); }); autopilotEl.checked = ['read', 'edit', 'commands', 'browser', 'mcp'].every((k) => p[k] === true); runjsEl.value = s.runJavascriptApproval || 'session'; runjsEl.addEventListener('change', async () => { try { await chrome.storage.local.set({ aiSettings: { ...s, runJavascriptApproval: runjsEl.value } }); } catch (e) { warnExtDead(); } }); refreshApprovalLabel(); }).catch(() => {});

  renderConversation();
  // 流式中关闭过面板再打开：恢复正在生成的回复 UI（助手在后台继续输出）。
  restoreStreamingUI();
  fitPanelHeight();
  if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
  renderDecisionButtonsIfPresent();

  const cmdArea = document.createElement('div');
  cmdArea.className = 'cmd-area';
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
  const sendBtn = document.createElement('button');
  sendBtn.className = 'cmd-send';
  sendBtn.textContent = '发送';
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
  const locatorText = (p) => {
    const l = (p && p.locator) || {};
    if (l.role || l.name) return 'role=' + (l.role || '') + (l.name ? (l.role ? ' ' : '') + 'name="' + l.name + '"' : '');
    if (l.testid) return 'testid=' + l.testid;
    if (p && p.selector) return p.selector;
    return (p && p.tag) || '';
  };
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
  clearBtn.textContent = '清空对话';
  clearBtn.addEventListener('click', () => {
    conversation = [];
    syncPushCursor(); // 数组被替换了，游标必须跟着归零
    saveConversation();
    // 清空即开启新会话：轮换标识，避免旧标识指向已被替换的内容。
    resetHandoffId();
    snapshotHandoff();
    renderConversation();
    fitPanelHeight();
  });
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = '导出记录';
  copyBtn.title = '导出为结构化 markdown（含角色分隔与工具明细），可直接交给 AI 或贴进工单';
  copyBtn.addEventListener('click', () => {
    // 结构化导出：从对话数据模型生成，而不是 panelBody.textContent ——
    // 后者会掺入输入框 placeholder 与按钮文字（「↶ 撤销⧉ 复制」），且用户与 AI 无角色分隔。
    let text = '';
    try {
      text = buildTranscriptMarkdown();
    } catch (e) {
      text = '';
    }
    if (!text) {
      copyBtn.textContent = '暂无可导出的对话';
      setTimeout(() => (copyBtn.textContent = '导出记录'), 1600);
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => {
        copyBtn.textContent = '已复制 ' + text.length + ' 字';
        setTimeout(() => (copyBtn.textContent = '导出记录'), 1600);
      },
      () => {
        copyBtn.textContent = '复制失败';
        setTimeout(() => (copyBtn.textContent = '导出记录'), 1600);
      }
    );
  });
  stopBtn = document.createElement('button');
  stopBtn.className = 'stop-btn';
  stopBtn.textContent = '■ 停止';
  stopBtn.style.display = 'none';
  stopBtn.addEventListener('click', interrupt);
  foot.appendChild(clearBtn);
  foot.appendChild(copyBtn);
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
    planEl = null;
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
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


  // 追加一个工具步骤卡片：先把已经流式输出的叙述段落固化成一条记录，
  // 再插入步骤，使后续叙述从新元素继续，形成“叙述 → 工具 → 叙述”的时间线。
  function appendStep(step) {
    removeTypingEl();
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

  // 装配给顶层的步骤钩子（见 panelStep 的声明处）：把"页面变了"、以及外部 agent 的动作
  // 写进对话流，而不是只让顶部芯片变色 —— 芯片容易被忽略。
  panelStep = appendStep;

  function interrupt() {
    if (!streaming) return;
    const acc = pendingAcc;
    closePort();
      if (pendingAiMsg && pendingAiMsg.parentNode) {
        if (acc) {
          lastResponse = pendingNarration || lastNarration || acc;
          if (pendingContentEl) pendingContentEl.innerHTML = renderAnswer(pendingNarration || lastResponse, currentCitations, false);
          pendingAiMsg._raw = acc;
          // 与 'end' 路径同样的去重：若本段已作为叙述段固化，就不再重复记一条文本。
          {
            const lastCommitted = pendingParts.length ? pendingParts[pendingParts.length - 1] : null;
            const alreadyAsNarration =
              lastCommitted && lastCommitted.type === 'narration' && lastCommitted.text === lastResponse;
            if (lastResponse && !alreadyAsNarration) pendingParts.push({ type: 'text', text: lastResponse });
          }
          conversation.push({ role: 'assistant', content: acc, toolSummary: summarizeToolParts(pendingParts) });
          saveConversation();
          const note = document.createElement('div');
          note.className = 'stopped-note';
          note.textContent = '· 已停止生成';
          pendingAiMsg.appendChild(note);
          // 停止后的消息就是最后一条，给出「重新生成」入口。
          pendingAiMsg.insertAdjacentHTML('beforeend', msgActionsHtml(true));
        } else {
        if (pendingContentEl) {
          pendingContentEl.textContent = '（已停止）';
          pendingContentEl.style.color = '#999';
        }
      }
    }
    endStream();
    fitPanelHeight();
    if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
  }

  /**
   * 新架构的入口：先把这句话送进 DSH 的那条会话。
   *
   * 送进去了就**不再跑面板自己的 agent** —— 回复会从会话经 rfSessionEvent 推回来，
   * 面板只是这条会话的视图（用户的话也会由会话回声回来并渲染，因此这里不用本地画一遍，
   * 也就不存在"本地一条 + 回声一条"的重复）。
   *
   * 送不进去（DSH 没开 / 插件没装 / 扩展没连上）则退回本地 agent：面板自身仍然可用。
   * 这条退路是刻意的过渡保险，不是长期形态 —— 见 docs/deletion-plan.md 第 1 步。
   *
   * 为什么用 opts.localOnly 这个开关而不是删掉本地路径：删除清单要求"先并存验证，再删旧的"，
   * 而且本地 agent 还承担着面板自己的工具审批等交互，不能一刀切。
   */
  function run(instruction, opts) {
    if (opts && opts.localOnly) {
      runLocally(instruction, opts);
      return;
    }
    // **先记本地回合，再送 DSH** —— 顺序不是随意的：
    // sendPanelTurn 会把插件回传的 rpcId 盖在**这个对象**上，于是从会话回声回来时
    // （带同一个 rpcId）能被精确识别，而不是靠"文本 + 最近若干条"猜。
    // 我上一版先送再记，且自己复制了一份 sendMessage（forwardToDsh），
    // 结果是：既多了一份实现，又永远拿不到 rpcId —— 精确去重形同虚设。
    const turn = { role: 'user', content: instruction, id: uid() };
    conversation.push(turn);
    // **立刻画出来**：用户要马上看到自己说的话。
    // 回声回来时走的是 mark-local（只标记、不追画）—— 这里是唯一会画它的地方，
    // 不画就永远不画。这个 bug 测试看不见（DOM 路径），只有真实面板能暴露。
    const el = appendUserTurn(instruction, conversation.length - 1);
    const undo = () => {
      const i = conversation.lastIndexOf(turn);
      if (i >= 0) conversation.splice(i, 1);
      // 连 DOM 一起撤回，否则失败回退到本地 agent 时会多出一个气泡
      if (el) {
        try {
          el.remove();
        } catch (e) {}
      }
    };
    sendPanelTurn(turn)
      .then((forwarded) => {
        if (!forwarded) {
          // 送不进去（DSH 没开/插件没装）：撤回刚记的这条，交给本地 agent，
          // 否则会话里会留一条"其实没进 DSH"的记录。
          undo();
          runLocally(instruction, opts);
          return;
        }
        try {
          // 这句已经**直送**过 DSH 了，因此把增量推送的计数器推到"目前全部已推送"，
          // 否则下一次 saveConversation 触发 pushPanelTurnIfNew 时会把它**再发一遍**
          // —— 用户会看到自己说的话在会话里出现两次。
          syncPushCursor();
          saveConversation();
        } catch (e) {}
        showCitationHint('已送进 DSH 会话 —— 你的话与回复都会作为同一条会话出现在这里。');
      })
      .catch(() => {
        undo();
        runLocally(instruction, opts);
      });
  }

  function runLocally(instruction, opts) {
    closePort();
    // 每次运行前刷新绑定芯片：SPA 漂移（pushState）在隔离世界钩不到，
    // 至少保证「用户真的要用它」这一刻，面板显示的是当前页面的真实状态，
    // 而不是静默地继续讨论一个已经离开的页面。
    renderBindingChip();
    activeRunId = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    // 响应看门狗：避免“三个点一直转”无反馈。15s 提示等待，45s 仍未收到任何消息则报错结束。
    let respTimer = null;
    let respFailTimer = null;
    let respWarned = false;
    const clearRespTimers = () => {
      if (respTimer) { clearTimeout(respTimer); respTimer = null; }
      if (respFailTimer) { clearTimeout(respFailTimer); respFailTimer = null; }
    };
    lastResponse = '';
    conversation.push({ role: 'user', content: instruction, id: uid() });
    const userMsg = appendUserTurn(instruction, conversation.length - 1);
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
    if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;

    pendingAcc = '';
    planEl = null;
    lastPlan = [];
    if (usageEl) usageEl.textContent = '';
    pendingAiMsg = aiMsg;
    pendingContentEl = contentEl;
    typingEl = contentEl;
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
          const codeText = resp.name === 'run_javascript' && resp.args ? String(resp.args.code || '') : '';
          const approvalArgs = resp.name === 'type_text' && resp.args
            ? { ...resp.args, text: '[输入内容已隐藏]' }
            : codeText
              ? { ...resp.args, code: '[完整代码见下方]' }
              : resp.args;
          const detail = approvalArgs && Object.keys(approvalArgs).length ? ' 参数：' + JSON.stringify(approvalArgs) : '';
          // 高风险工具（run_javascript 每次都需审批）必须让用户看到**完整**代码：
          // 截断到 400 字符会让这个「确认」形同虚设。
          const codeBlock = codeText
            ? '<div class="tool-approval-label">将要执行的完整代码</div><pre class="tool-approval-code">' + escHtml(codeText) + '</pre>'
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
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
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
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
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
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'stuck-warning') {
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.style.color = '#b45309';
        step.textContent = '⚠ ' + (resp.message || '动作暂未产生可观察进展');
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'tool-disabled') {
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.style.color = '#6b7280';
        step.textContent = '⛔ 已停止使用工具「' + (resp.name || '') + '」：' + (resp.reason || '');
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'budget-exceeded') {
        budgetStopped = true;
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.style.color = '#b91c1c';
        step.textContent = '⏹ ' + (resp.message || 'Agent 已达到安全上限并停止');
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'tab-switched') {
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.textContent = '↗ 已切换标签页：' + (resp.title || resp.url || ('tabId=' + resp.tabId));
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'tabs-closed') {
        const count = Array.isArray(resp.tabIds) ? resp.tabIds.length : 0;
        if (count) {
          const step = document.createElement('div');
          step.className = 'agent-step';
          step.style.color = '#6b7280';
          step.textContent = '🗑 任务结束，已自动关闭 ' + count + ' 个本次打开的标签页';
          appendStep(step);
          fitPanelHeight();
          if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
        }
      } else if (resp.type === 'intent') {
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.textContent = '🧭 意图识别：' + (resp.label || resp.intent || '普通对话');
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'intent-upgraded') {
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.textContent = '🔄 已切换为' + (resp.label || '资料研究') + '模式，可用浏览器/网络工具继续';
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'verify') {
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.style.color = resp.ok ? '#16a34a' : '#b45309';
        if (resp.ok) {
          step.textContent = '✓ 完成前校验通过' + (resp.reason ? '：' + resp.reason : '');
        } else if (resp.deterministic) {
          // 确定性规则命中：与 LLM 校验区分开，用户才好判断这条结论的来路。
          step.textContent = '⚠ 完成前检查未通过（确定性规则，未消耗模型调用）：' + (resp.reason || '声称与实际动作不符');
        } else {
          step.textContent = '⚠ 校验未通过：' + (resp.reason || '目标可能未达成') + (resp.missing ? '（还差：' + resp.missing + '）' : '');
        }
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'usage') {
        if (usageEl) usageEl.textContent = 'tokens ' + (resp.totalTokens || 0);
      } else if (resp.type === 'plan') {
        renderPlan(resp.plan);
      } else if (resp.type === 'skill') {
        const skills = Array.isArray(resp.skills) ? resp.skills : [];
        if (skills.length) {
          const step = document.createElement('div');
          step.className = 'agent-step agent-skill';
          step.textContent = '🛠 启用技能：' + skills.map((s) => s.title || s.name).join('、');
          appendStep(step);
          fitPanelHeight();
          if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
        }
      } else if (resp.type === 'chunk') {
        removeTypingEl();
        pendingAcc += resp.text;
        pendingNarration += resp.text;
        pendingStarted = true;
        if (!pendingContentEl) {
          pendingContentEl = ensureTextEl();
          if (pendingContentEl) pendingContentEl.innerHTML = '';
        }
        // 流式过程中也统一重编号引用，保证正文始终从 [1] 连续（生成结束后会再次校正，幂等）。
        if (pendingContentEl) {
          pendingContentEl.innerHTML = renderAnswer(pendingNarration, currentCitations, true);
        }
        pendingAiMsg._raw = pendingAcc;
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'end') {
        removeTypingEl();
        lastResponse = pendingNarration || lastNarration || '';
        // 最终回复统一重编号引用：正文从 [1] 开始，参考来源只保留被引用的文章。
        const renumbered = renumberCitations(lastResponse, currentCitations);
        const finalText = renumbered.text;
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
        const lastCommitted = pendingParts.length ? pendingParts[pendingParts.length - 1] : null;
        const alreadyAsNarration =
          lastCommitted && lastCommitted.type === 'narration' && lastCommitted.text === finalText;
        if (finalText && !alreadyAsNarration) {
          pendingParts.push({ type: 'text', text: finalText });
        }
        conversation.push({ role: 'assistant', content: finalText, citations: finalCitations, plan: lastPlan.slice(), toolSummary: summarizeToolParts(pendingParts), parts: pendingParts.map((p) => (p.type === 'text' && p.text === lastResponse ? Object.assign({}, p, { text: finalText }) : p)) });
        saveConversation();
        // 触底收尾：解析模型输出的「【可选操作】」小节，渲染可点击继续按钮。
        renderSuggestionButtons(pendingAiMsg, finalText, run);
        fitPanelHeight();
        currentCitations = null;
        endStream();
        closePort();
      } else if (resp.type === 'error') {
        removeTypingEl();
        const errEl = pendingContentEl || ensureTextEl();
        if (errEl) {
          errEl.textContent = resp.error;
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
        endStream();
        closePort();
      }
    });
    conn.onDisconnect.addListener(() => {
      if (port === conn) port = null;
      if (port === null && streaming) endStream();
    });
    // 长任务心跳：每 20s 发一次空消息，避免 MV3 service worker 因空闲被回收。
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
      try { conn.postMessage({ type: 'keepalive' }); } catch (e) {}
    }, 20000);
    conn.postMessage({
      action: 'agent',
      runId: activeRunId,
      question: instruction,
      text: lastText,
      page: pageText,
      pageUrl: location.href,
      pageTitle: document.title,
      history: conversation.slice(),
      ...(opts && opts.continuation ? { continuation: true } : {}),
      ...(pickedElements.length ? { pickedElements } : {}),
    });
    // 已选元素随本次消息发出后清空。
    if (pickedElements.length) {
      pickedElements = [];
      try { renderPick(); } catch (e) {}
    }
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
      endStream();
      closePort();
    }, 45000);
  }

  function send() {
    const cmd = cmdInput.value.trim();
    if (!cmd) return;
    if (streaming) {
      // **不要静默丢弃**。用户实测反馈：「点了发送没反应」—— 表现是字还留在输入框里、
      // 没有任何提示，看起来像按钮坏了。原因是这一行以前直接 `return`：
      // 面板自己的本地 AI 正在流式输出时（runLocally 里 streaming = true），
      // 点发送什么都不会发生。现在明确告诉他为什么，并**保留输入内容**方便重发。
      // （只提示不排队：本地 AI 那条路并发跑两轮会把渲染搅乱。DSH 那边的消息由
      //   插件用 agent.send(..., 'next-step', ...) 排队，不经过这里。）
      showCitationHint('AI 正在回答中，这条没有发出 —— 等它结束再点发送，或点 ⏹ 中断后重发。');
      return;
    }
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
    if (e.target.closest('.close')) return;
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

// ---- 事件绑定与初始化 ----
export function initAssistant() {
  document.addEventListener('mousedown', (e) => {
    if (host && e.composedPath().includes(host)) return;
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
      } else if (msg.type === 'rfUrlChanged') {
        // 后台经 chrome.webNavigation 报告 SPA 导航（pushState/replaceState）。
        // 刷新绑定芯片即可：漂移是「URL 与绑定起点不一致」，由 renderBindingChip 判定，
        // 并在跃迁进 drifted 时在对话区留一条一次性提示。
        renderBindingChip();
      } else if (msg.type === 'rfSessionEvent') {
        // DSH 那条会话本身的消息（面板是它的视图）。
        // 旧的 rfBridgeEvent 分支已随旧插件一起删除（见 renderSessionEvent 上方的说明）。
        renderSessionEvent(msg.frame);
      }
    });
  } catch (e) {
    warnExtDead();
  }

  ensureHost();

  // 恢复该标签页上次的对话（SPA 跳转 / 刷新后不丢上下文）。
  // 保存 promise 供 snapshotHandoff 等待，避免「对话还没读回来就打包交接包」的竞态。
  conversationLoadPromise = loadConversation();

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

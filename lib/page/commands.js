// 页面命令系统：结构化命令控制当前页面 DOM（高亮、滚动、改样式、点击、描边、读取）。
// 通过 chrome.runtime 消息由后台 Agent 工具（page_command）或用户直接调用。
import { normalizeCitationText, PAGE_TEXT_EXCLUDE, buildPageCharMap, findRangeBySubstr, overlayElement, overlayColor, overlayRange, disposeOverlays } from './citation.js';
import { getInteractiveElementByRef, elementSelector, absoluteRect } from './page-text.js';

let cmdStyleReverters = []; // set_style 的还原函数
let cmdTimers = []; // outline / set_style 的定时器

// 动作撤销栈：每个可逆动作（输入/勾选/选择/改样式/滚动）压入一个还原闭包。
// 页面导航会自然重置（内容脚本重载），因此无需持久化。
const undoStack = [];
const MAX_UNDO = 40;
function pushUndo(fn) {
  if (typeof fn !== 'function') return;
  undoStack.push(fn);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

export function undoLast() {
  const fn = undoStack.pop();
  if (!fn) return { ok: false, error: '没有可撤销的操作（仅输入/勾选/选择/改样式/滚动可撤销）' };
  try {
    fn();
    return { ok: true, result: '已撤销上一步操作' };
  } catch (e) {
    return { ok: false, error: '撤销失败：' + (e && e.message ? e.message : String(e)) };
  }
}

function clearCmdOverlays() {
  disposeOverlays('cmd');
}

export function resetPageCommands() {
  clearCmdOverlays();
  cmdStyleReverters.forEach((fn) => {
    try { fn(); } catch (e) {}
  });
  cmdStyleReverters = [];
  cmdTimers.forEach((t) => clearTimeout(t));
  cmdTimers = [];
}

// 递归查询：穿透同源 iframe 与开放 shadow DOM（跨源 iframe 会被 try/catch 跳过）。
function queryAllInFrames(root, selector, into = []) {
  try {
    Array.prototype.push.apply(into, root.querySelectorAll(selector));
  } catch (e) {}
  try {
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) queryAllInFrames(el.shadowRoot, selector, into);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        const doc = el.contentDocument;
        if (doc && doc !== root) queryAllInFrames(doc, selector, into);
      }
    });
  } catch (e) {}
  return into;
}

// 按文本查找最具体（最深）的匹配元素，避免返回整个 body/大容器
function findElementsByText(text, limit) {
  const q = normalizeCitationText(text);
  if (!q) return [];
  const cands = queryAllInFrames(document, 'p,h1,h2,h3,h4,h5,h6,li,td,th,dt,dd,span,a,div,blockquote,figcaption');
  const hits = [];
  for (const el of cands) {
    if (el.closest(PAGE_TEXT_EXCLUDE)) continue;
    if (normalizeCitationText(el.textContent).includes(q)) hits.push(el);
  }
  // 只保留最深层（最具体）的命中：排除「还包含其他命中元素」的容器，避免返回整个 body/大容器
  const deepest = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
  return deepest.slice(0, limit || 10);
}

// ---- Locator 抽象：ref → role+name → testid → text → css，逐级回退 ----
function cssEscapeLocal(value) {
  const s = String(value || '');
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

// 隐式 role（无显式 role 属性时按标签/类型推断），与 AX 树的常见 role 对齐。
function roleOf(el) {
  const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
  if (tag === 'button') return 'button';
  if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'option') return 'option';
  if (tag === 'summary') return 'button';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'input') {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'submit' || t === 'button' || t === 'reset' || t === 'file') return 'button';
    if (t === 'search') return 'searchbox';
    if (t === 'range') return 'slider';
    if (t === 'number') return 'spinbutton';
    return 'textbox';
  }
  return '';
}

// 可访问名（accessible name）：aria-label → aria-labelledby → <label> → placeholder → title → alt → 文本。
function accessibleName(el) {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const parts = labelledby
      .split(/\s+/)
      .map((id) => { const t = document.getElementById(id); return t ? t.textContent || '' : ''; })
      .filter(Boolean);
    if (parts.length) return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  if (el.labels && el.labels.length) {
    const t = Array.from(el.labels).map((l) => l.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  for (const attr of ['placeholder', 'title', 'alt']) {
    const v = el.getAttribute(attr);
    if (v && v.trim()) return v.trim();
  }
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (el.tagName === 'INPUT' && (type === 'submit' || type === 'button' || type === 'reset') && el.value) return String(el.value).trim();
  return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function normName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findElementsByRoleName(role, name) {
  const wantRole = normName(role);
  const wantName = normName(name);
  const cands = queryAllInFrames(document, 'a,button,input,textarea,select,summary,option,[role],[contenteditable="true"]');
  const hits = [];
  for (const el of cands) {
    if (el.closest(PAGE_TEXT_EXCLUDE)) continue;
    if (!isVisibleForAction(el)) continue;
    if (wantRole && roleOf(el) !== wantRole) continue;
    if (wantName) {
      const an = normName(accessibleName(el));
      if (!an || an.indexOf(wantName) === -1) continue;
    }
    hits.push(el);
  }
  return hits;
}

function findElementsByTestId(testid) {
  const q = String(testid || '');
  if (!q) return [];
  const esc = cssEscapeLocal(q);
  const sel = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-name']
    .map((a) => '[' + a + '="' + esc + '"]')
    .join(',');
  try {
    return queryAllInFrames(document, sel);
  } catch (e) {
    return [];
  }
}

// 按 ref / role+name / testid / selector / text 解析目标元素列表
function findElementsFor(params) {
  let els = [];
  if (params.ref) {
    const el = getInteractiveElementByRef(params.ref);
    els = el ? [el] : [];
  } else if (params.role || params.name) {
    els = findElementsByRoleName(params.role, params.name);
  } else if (params.testid) {
    els = findElementsByTestId(params.testid);
  } else if (params.selector) {
    try {
      els = queryAllInFrames(document, params.selector);
    } catch (e) {
      els = [];
    }
  } else if (params.text) {
    els = findElementsByText(params.text, 10);
  }
  // index 支持在重复结构中选第 N 个匹配（从 0 开始）。
  if (params.index !== undefined && params.index !== null) {
    const i = Number(params.index);
    return Number.isInteger(i) && i >= 0 && i < els.length ? [els[i]] : [];
  }
  return els;
}

// 把 ref/selector/text 解析为一个唯一 CSS 选择器（供主世界据此解析元素源码位置）。
export function resolveElementSelector(params) {
  try {
    const els = findElementsFor(params || {});
    if (!els.length) return null;
    return elementSelector(els[0]);
  } catch (e) {
    return null;
  }
}

// 解析目标元素并返回「唯一选择器 + 绝对视口坐标」，供后台用 CDP 按坐标做可信输入。
export function resolveTargetInfo(params) {
  try {
    const els = findElementsFor(params || {});
    if (!els.length) return { found: false, reason: '未找到目标元素' };
    const el = els[0];
    const label = String(
      el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') ||
      el.innerText || el.textContent || el.getAttribute('name') || ''
    ).replace(/\s+/g, ' ').trim().slice(0, 60);
    return {
      found: true,
      selector: elementSelector(el),
      rect: absoluteRect(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      label,
    };
  } catch (e) {
    return { found: false, reason: e.message };
  }
}

// 按文本精确定位 Range（复用引用定位的字符级匹配）
function findRangeFor(params) {
  if (!params.text) return null;
  try {
    return findRangeBySubstr(buildPageCharMap(), params.text);
  } catch (e) {
    return null;
  }
}

function scrollRangeIntoView(range) {
  const rect = range.getBoundingClientRect();
  if (rect && rect.height) {
    window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - window.innerHeight * 0.38), behavior: 'smooth' });
  } else {
    const el = range.startContainer.parentElement;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function cmdHighlight(params) {
  const color = params.color || overlayColor();
  // 批量模式：一次调用高亮多个文本片段（texts 数组），避免逐条调用浪费 Agent 轮次。
  if (params.texts && Array.isArray(params.texts)) {
    const texts = params.texts.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
    if (!texts.length) return { ok: false, error: 'texts 数组为空或全部为空串' };
    const map = buildPageCharMap();
    let hit = 0;
    const misses = [];
    for (const t of texts) {
      const range = findRangeBySubstr(map, t);
      if (range) {
        overlayRange(range, color, 'cmd');
        hit += 1;
      } else {
        misses.push(t);
      }
    }
    if (!hit) return { ok: false, error: '未在页面中找到任何待高亮文本' };
    const missNote = misses.length
      ? '；未找到 ' + misses.length + ' 条：' + misses.map((m) => m.slice(0, 16) + (m.length > 16 ? '…' : '')).join('、')
      : '';
    return { ok: true, result: '已高亮 ' + hit + ' / ' + texts.length + ' 处关键信息' + missNote };
  }
  if (params.text) {
    const range = findRangeFor(params);
    if (!range) return { ok: false, error: '未在页面中找到文本：' + params.text };
    overlayRange(range, color, 'cmd');
    // 高亮时不自动滚动页面，避免连续高亮多条关键句时页面反复跳动；
    // 需要定位时请用 scroll_page 或点击引用徽章。
    return { ok: true, result: '已高亮文本' };
  }
  if (params.selector) {
    const els = findElementsFor(params);
    if (!els.length) return { ok: false, error: '未找到选择器匹配元素：' + params.selector };
    els.forEach((el) => overlayElement(el, color, false, 'cmd'));
    return { ok: true, result: '已高亮 ' + els.length + ' 个元素' };
  }
  return { ok: false, error: 'highlight 需要 texts、text 或 selector 参数' };
}

function cmdScrollTo(params) {
  const behavior = params.behavior === 'auto' ? 'auto' : 'smooth';
  const block = params.block || 'start';
  const beforeX = window.scrollX;
  const beforeY = window.scrollY;
  const pushScrollUndo = () => pushUndo(() => window.scrollTo(beforeX, beforeY));
  if (params.ref || params.text || params.selector) {
    if (params.text) {
      const range = findRangeFor(params);
      if (range) {
        scrollRangeIntoView(range);
        pushScrollUndo();
        return { ok: true, result: '已滚动到目标文本' };
      }
    }
    const els = findElementsFor(params);
    if (!els.length) return { ok: false, error: '未找到目标元素（可先 get_page_snapshot 获取 ref，或改用 text/selector）' };
    els[0].scrollIntoView({ behavior, block });
    pushScrollUndo();
    return { ok: true, selector: elementSelector(els[0]), result: '已滚动到目标元素' };
  }
  if (typeof params.top === 'number' || typeof params.left === 'number') {
    window.scrollTo({ top: Number(params.top) || 0, left: Number(params.left) || 0, behavior });
    pushScrollUndo();
    return { ok: true, result: '已滚动到指定位置' };
  }
  return { ok: false, error: 'scroll_to 需要 ref/text/selector 或 top/left 参数' };
}

function cmdScrollBy(params) {
  const beforeX = window.scrollX;
  const beforeY = window.scrollY;
  window.scrollBy({
    top: Number(params.y) || 0,
    left: Number(params.x) || 0,
    behavior: params.behavior === 'auto' ? 'auto' : 'smooth',
  });
  pushUndo(() => window.scrollTo(beforeX, beforeY));
  return { ok: true, result: '已滚动' };
}

function cmdOutline(params) {
  const color = params.color || '#ff5722';
  const els = findElementsFor(params);
  if (!els.length) return { ok: false, error: '未找到目标元素' };
  // 用独立 owner 管理本批次描边，duration 到后整体清理；描边同样滚动跟随。
  const owner = 'cmd-outline-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  els.forEach((el) => overlayElement(el, color, true, owner));
  els[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  const dur = Math.max(0, Number(params.duration) || 1500);
  const t = setTimeout(() => {
    disposeOverlays(owner);
  }, dur);
  cmdTimers.push(t);
  return { ok: true, result: '已描边 ' + els.length + ' 个元素' };
}

function cmdSetStyle(params) {
  const els = findElementsFor(params);
  if (!els.length) return { ok: false, error: '未找到目标元素' };
  const styles = params.styles;
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)) {
    return { ok: false, error: 'set_style 需要 styles 对象' };
  }
  const backups = els.map((el) => ({ el, old: el.style.cssText }));
  els.forEach((el) => {
    Object.keys(styles).forEach((k) => {
      try { el.style[k] = styles[k]; } catch (e) {}
    });
  });
  const revert = () => backups.forEach((b) => { b.el.style.cssText = b.old; });
  pushUndo(revert);
  const dur = Number(params.duration);
  if (dur > 0) {
    cmdTimers.push(setTimeout(revert, dur));
    return { ok: true, result: '已修改 ' + els.length + ' 个元素样式（' + dur + 'ms 后还原）' };
  }
  cmdStyleReverters.push(revert);
  return { ok: true, result: '已修改 ' + els.length + ' 个元素样式（clear_highlights 还原）' };
}

async function cmdClick(params) {
  const els = findElementsFor(params);
  if (!els.length) return { ok: false, error: '未找到目标元素' };
  const el = els[0];
  const ready = await ensureActionable(el);
  if (!ready) {
    // 自愈：被遮挡或 pointer-events 受限时，退化为程序化 click（绕过遮挡），
    // 仍失败则如实上报，交由后台用 CDP 可信事件兜底。
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      return { ok: false, error: '目标元素不可操作（已禁用）：' + (el.tagName || '').toLowerCase() };
    }
    try {
      if (typeof el.click === 'function') {
        el.click();
        return { ok: true, forced: true, selector: elementSelector(el), result: '目标元素被遮挡或暂不可交互，已改用程序化点击' };
      }
    } catch (e) {}
    return { ok: false, error: '目标元素不可操作（不可见、被遮挡或尚未就绪）：' + (el.tagName || '').toLowerCase() };
  }
  try {
    dispatchRealisticClick(el);
  } catch (e) {
    return { ok: false, error: '点击失败：' + e.message };
  }
  return { ok: true, selector: elementSelector(el), result: '已点击元素 ' + (el.tagName || '').toLowerCase() };
}

function cmdGetText(params) {
  if (params.text) {
    const range = findRangeFor(params);
    if (range) return { ok: true, result: range.toString() };
    return { ok: false, error: '未找到文本：' + params.text };
  }
  const els = findElementsFor(params);
  if (!els.length) return { ok: false, error: '未找到目标元素' };
  const text = els.map((el) => (el.innerText || el.textContent || '').trim()).filter(Boolean).join('\n---\n').slice(0, 4000);
  return { ok: true, result: text || '（空内容）' };
}

function firstTarget(params, includeText = true) {
  const source = params || {};
  const target = { ref: source.ref, selector: source.selector };
  if (includeText) target.text = source.text;
  const els = findElementsFor(target);
  return els.length ? els[0] : null;
}

function isVisibleForAction(el) {
  if (!el || !el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// 元素中心点是否被其他元素遮挡（loading 遮罩、弹层等）。
function isElementCovered(el) {
  if (!el || !el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const x = rect.left + Math.min(rect.width / 2, 8);
  const y = rect.top + Math.min(rect.height / 2, 8);
  const top = document.elementFromPoint(x, y);
  if (!top) return false;
  // 命中元素自身或其子元素都算可点击；命中无关元素视为被遮挡。
  return top !== el && !el.contains(top);
}

function isActionable(el) {
  if (!el || !el.isConnected) return false;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
  const style = window.getComputedStyle(el);
  if (style.pointerEvents === 'none') return false;
  return isVisibleForAction(el) && !isElementCovered(el);
}

// 动作前准备：滚动到视口，并轮询等待元素可见、可用、不被遮挡。
function ensureActionable(el, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const scroll = () => {
      try { el.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch (e) {}
    };
    scroll();
    const check = () => {
      if (isActionable(el)) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      scroll();
      setTimeout(check, 90);
    };
    check();
  });
}

// 派发完整的指针/鼠标事件序列，兼容只监听 pointerdown/mousedown 的框架；
// 最后用 el.click() 触发浏览器默认行为（链接跳转、表单提交）。
function dispatchRealisticClick(el) {
  const rect = el.getBoundingClientRect();
  const opts = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
    buttons: 1,
  };
  const pointerOpts = Object.assign({}, opts, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
  el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  if (el.click) el.click();
}

function editableValue(el) {
  if (!el) return null;
  if (el.isContentEditable) return String(el.textContent || '');
  if (typeof el.value === 'string') return el.value;
  return null;
}

function setNativeValue(el, value) {
  if (el.isContentEditable) {
    el.textContent = value;
    return;
  }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && descriptor.set) descriptor.set.call(el, value);
  else el.value = value;
}

function dispatchInputChange(el, text) {
  try {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  } catch (e) {
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

async function cmdTypeText(params) {
  const el = firstTarget(params, false);
  if (!el) return { ok: false, error: '未找到可输入的目标元素' };
  const isEditable = el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
  if (!isEditable) return { ok: false, error: '目标元素不是 input、textarea 或 contenteditable' };
  if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') return { ok: false, error: '目标输入元素不可编辑' };
  if (el.tagName === 'INPUT' && ['file', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) {
    return { ok: false, error: '不支持向该 input 类型输入文本：' + el.type };
  }
  const ready = await ensureActionable(el);
  if (!ready) return { ok: false, error: '目标输入元素不可操作（不可见、被遮挡或尚未就绪）' };
  const text = String(params.text === undefined || params.text === null ? '' : params.text);
  const before = editableValue(el) || '';
  const next = params.clearFirst === true ? text : before + text;
  try {
    el.focus();
    setNativeValue(el, next);
    dispatchInputChange(el, text);
  } catch (e) {
    return { ok: false, error: '输入文本失败：' + e.message };
  }
  if (before !== next) {
    pushUndo(() => {
      try { setNativeValue(el, before); dispatchInputChange(el, before); } catch (e) {}
    });
  }
  return {
    ok: true,
    changed: before !== next,
    alreadySatisfied: before === next,
    valuePresent: Boolean(next),
    selector: elementSelector(el),
    result: (params.clearFirst === true ? '已清空并输入 ' : '已输入 ') + text.length + ' 个字符',
  };
}

function keyCodeFor(key) {
  const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Space: 32 };
  return codes[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
}

function keyCodeName(key) {
  if (key.length === 1 && /^[a-z]$/i.test(key)) return 'Key' + key.toUpperCase();
  if (key.length === 1 && /^\d$/.test(key)) return 'Digit' + key;
  return key;
}

function cmdPressKey(params) {
  const el = firstTarget(params, false) || (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body);
  if (!el) return { ok: false, error: '没有可接收键盘事件的目标元素' };
  const key = String(params.key || '');
  if (!key) return { ok: false, error: 'key 不能为空' };
  const modifiers = Array.isArray(params.modifiers) ? params.modifiers.map((x) => String(x).toUpperCase()) : [];
  const init = {
    key,
    code: keyCodeName(key),
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: modifiers.includes('CTRL'),
    altKey: modifiers.includes('ALT'),
    shiftKey: modifiers.includes('SHIFT'),
    metaKey: modifiers.includes('META'),
    keyCode: keyCodeFor(key),
    which: keyCodeFor(key),
  };
  try {
    if (el.focus) el.focus();
    const down = new KeyboardEvent('keydown', init);
    el.dispatchEvent(down);
    if (key.length === 1 || key === 'Enter' || key === 'Space') el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    // 合成 KeyboardEvent 不会自动触发浏览器默认行为；补齐最常用的 Enter/Space 行为。
    if (!down.defaultPrevented && (key === 'Enter' || key === 'Space')) {
      if (el.form && key === 'Enter' && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
      else if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && el.click) el.click();
    }
  } catch (e) {
    return { ok: false, error: '键盘事件失败：' + e.message };
  }
  return { ok: true, eventDispatched: true, selector: el && el.tagName ? elementSelector(el) : undefined, result: '已向目标元素派发按键：' + key };
}

function cmdSelectOption(params) {
  const el = firstTarget(params, false);
  if (!el) return { ok: false, error: '未找到 select 元素' };
  if (el.tagName !== 'SELECT') return { ok: false, error: '目标元素不是 select' };
  if (el.disabled) return { ok: false, error: 'select 元素不可用' };
  const options = Array.from(el.options || []);
  let index = -1;
  if (params.index !== undefined && params.index !== null) index = Number(params.index);
  else if (params.value !== undefined) index = options.findIndex((o) => o.value === String(params.value));
  else if (params.label !== undefined) index = options.findIndex((o) => String(o.textContent || '').trim() === String(params.label).trim());
  if (!Number.isInteger(index) || index < 0 || index >= options.length) return { ok: false, error: '未找到匹配的 option' };
  if (options[index].disabled) return { ok: false, error: '目标 option 已禁用' };
  const before = el.selectedIndex;
  try {
    el.selectedIndex = index;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  } catch (e) {
    return { ok: false, error: '选择 option 失败：' + e.message };
  }
  if (before !== el.selectedIndex) {
    pushUndo(() => {
      try {
        el.selectedIndex = before;
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } catch (e) {}
    });
  }
  return {
    ok: true,
    changed: before !== el.selectedIndex,
    alreadySatisfied: before === el.selectedIndex,
    selectedIndex: el.selectedIndex,
    selectedLabel: String(options[index].textContent || '').trim().slice(0, 200),
    selector: elementSelector(el),
    result: '已选择：' + String(options[index].textContent || '').trim().slice(0, 200),
  };
}

function isCheckControl(el) {
  if (!el) return false;
  const type = String(el.type || '').toLowerCase();
  const role = el.getAttribute('role');
  return ['checkbox', 'radio'].includes(type) || role === 'checkbox' || role === 'radio';
}

// 定位 checkbox/radio：优先 ref/selector/index；用 text 定位时，文本命中的往往是
// 关联的 label/容器，自动解析到其绑定的 checkbox/radio 控件。
function resolveCheckTarget(params) {
  let el = firstTarget(params, true);
  if (el && isCheckControl(el)) return el;
  if (el && params.text) {
    const label = el.closest('label');
    const linked = label && (isCheckControl(label.control) ? label.control : label.querySelector('input[type="checkbox"],input[type="radio"]'));
    if (linked) return linked;
    const container = el.closest('label,li,div,td');
    if (container) {
      const found = container.querySelector('input[type="checkbox"],input[type="radio"]');
      if (found) return found;
    }
  }
  return el;
}

function cmdCheckBox(params) {
  const el = resolveCheckTarget(params);
  if (!el) return { ok: false, error: '未找到 checkbox 或 radio 元素' };
  const type = String(el.type || '').toLowerCase();
  const role = el.getAttribute('role');
  if (!isCheckControl(el)) {
    return { ok: false, error: '目标元素不是 checkbox 或 radio（可按 text 定位关联 label，或改用 ref/selector）' };
  }
  const desired = params.checked === true;
  const before = type ? Boolean(el.checked) : el.getAttribute('aria-checked') === 'true';
  if (type === 'radio' && !desired) return { ok: false, error: 'radio 不能切换为未选中' };
  if (before !== desired) {
    try { el.click(); } catch (e) { return { ok: false, error: '切换选项失败：' + e.message }; }
  }
  const after = type ? Boolean(el.checked) : el.getAttribute('aria-checked') === 'true';
  // checkbox 可再次点击还原；radio 无法通过再次点击取消，故不记录撤销。
  if (before !== after && type !== 'radio') {
    pushUndo(() => { try { el.click(); } catch (e) {} });
  }
  return { ok: true, changed: before !== after, alreadySatisfied: before === desired, checked: after, selector: elementSelector(el), result: after ? '已选中' : '已取消选中' };
}

function waitStateMatches(el, params, state) {
  if (state === 'attached') return Boolean(el && el.isConnected);
  if (state === 'detached') return !el || !el.isConnected;
  if (!el || !el.isConnected) return false;
  if (state === 'enabled') return isVisibleForAction(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  if (state === 'text_contains') return String(el.innerText || el.textContent || '').includes(String(params.text || ''));
  return isVisibleForAction(el);
}

function cmdWaitForElement(params) {
  const state = ['attached', 'visible', 'enabled', 'text_contains', 'count', 'detached', 'url_contains'].includes(params.state) ? params.state : 'visible';
  if (state === 'url_contains') {
    if (!params.text) return Promise.resolve({ ok: false, matched: false, error: 'url_contains 需要 text 作为目标 URL 片段' });
  } else if (state === 'count') {
    if (!params.selector && !params.text) return Promise.resolve({ ok: false, matched: false, error: 'count 需要 selector 或 text 定位' });
  } else if (!params.ref && !params.selector && !params.text) {
    return Promise.resolve({ ok: false, matched: false, error: 'wait_for_element 需要 ref、selector 或 text' });
  }
  const timeoutMs = Math.min(15000, Math.max(100, Number(params.timeoutMs) || 8000));
  const pollMs = Math.min(1000, Math.max(25, Number(params.pollMs) || 100));
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let interval;
    let timeout;
    let observer;
    const cleanup = () => {
      clearInterval(interval);
      clearTimeout(timeout);
      if (observer) observer.disconnect();
    };
    const finish = (response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const check = () => {
      if (state === 'count') {
        const count = findElementsFor(params).length;
        const target = Math.max(1, Number(params.count) || 1);
        if (count >= target) {
          finish({ ok: true, matched: true, count, result: '已等到 ' + count + ' 个匹配元素（目标 >= ' + target + '）' });
          return;
        }
      } else if (state === 'url_contains') {
        if (location.href.includes(String(params.text || ''))) {
          finish({ ok: true, matched: true, result: 'URL 已包含：' + params.text });
          return;
        }
      } else if (state === 'detached') {
        const el = firstTarget(params);
        if (!el || !el.isConnected) {
          finish({ ok: true, matched: true, result: '目标元素已消失' });
          return;
        }
      } else {
      const el = firstTarget(params);
      if (el && waitStateMatches(el, params, state)) {
        finish({ ok: true, matched: true, result: '已等到目标元素（' + state + '）' });
        return;
      }
      }
      if (Date.now() - started >= timeoutMs) {
        finish({ ok: false, matched: false, error: '等待元素超时（' + timeoutMs + 'ms）' });
      }
    };
    interval = setInterval(check, pollMs);
    timeout = setTimeout(check, timeoutMs + 5);
    if (typeof MutationObserver !== 'undefined' && document.documentElement) {
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    check();
  });
}

function cmdGetAttribute(params) {
  const el = firstTarget(params);
  if (!el) return { ok: false, error: '未找到目标元素' };
  const attribute = String(params.attribute || '').trim().toLowerCase();
  if (!/^[a-zA-Z_:][a-zA-Z0-9:._-]*$/.test(attribute)) return { ok: false, error: '属性名无效' };
  const raw = el.getAttribute(attribute);
  const inputType = String(el.type || '').toLowerCase();
  const sensitive = attribute === 'value' && (inputType === 'password' || /cc-number|cc-csc|one-time-code/i.test(el.getAttribute('autocomplete') || ''));
  const value = sensitive ? null : raw === null ? null : String(raw).slice(0, 2000);
  return {
    ok: true,
    attribute,
    present: raw !== null,
    value,
    valueRedacted: sensitive,
    result: sensitive ? '属性存在，但敏感值已隐藏' : (raw === null ? '属性不存在：' + attribute : attribute + ' = ' + value),
  };
}

export async function executePageCommand(command, params) {
  params = params || {};
  switch (command) {
    case 'highlight': return cmdHighlight(params);
    case 'clear_highlights': resetPageCommands(); return { ok: true, result: '已清除页面高亮与样式' };
    case 'scroll_to': return cmdScrollTo(params);
    case 'scroll_by': return cmdScrollBy(params);
    case 'outline': return cmdOutline(params);
    case 'set_style': return cmdSetStyle(params);
    case 'click': return cmdClick(params);
    case 'get_text': return cmdGetText(params);
    default: return { ok: false, error: '未知页面命令：' + command };
  }
}

// 独立的浏览器 Agent 工具：参数丰富的表单/等待操作不塞进 page_command，
// 便于统一注册表做权限控制和参数校验。
export function typeText(params) { return cmdTypeText(params || {}); }
export function pressKey(params) { return cmdPressKey(params || {}); }
export function selectOption(params) { return cmdSelectOption(params || {}); }
export function checkBox(params) { return cmdCheckBox(params || {}); }
export function waitForElement(params) { return cmdWaitForElement(params || {}); }
export function getAttribute(params) { return cmdGetAttribute(params || {}); }

// 受控的 JS 逃生舱：在内容脚本隔离世界里执行模型提供的代码，并用「白名单作用域」屏蔽
// 高权限能力。注意：内容脚本隔离世界本身可访问 chrome.runtime / chrome.storage，因此必须
// 显式屏蔽，不能只依赖 world 隔离。这里能挡住直接引用 chrome.*（含 window.chrome）与
// fetch/XHR/storage 等，但无法完全阻止通过函数构造器（如 (function(){}).constructor）绕过；
// 因此该工具仍强制逐次审批，不因本隔离而放松。
// 代码体是一个函数体，最后应通过 return 返回结果（或返回 Promise）。
const SANDBOX_ALLOWED = [
  'window', 'document', 'location', 'navigator', 'JSON', 'Math', 'Date', 'Number', 'String',
  'Boolean', 'Array', 'Object', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'console', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'parseInt',
  'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
  'decodeURI', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'atob', 'btoa',
  'structuredClone', 'getComputedStyle', 'performance', 'Node', 'NodeFilter', 'Element',
  'HTMLElement', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'MutationObserver',
  'IntersectionObserver', 'ResizeObserver', 'DOMParser', 'undefined', 'NaN', 'Infinity',
];
const SANDBOX_BLOCKED = [
  'chrome', 'browser', 'globalThis', 'self', 'top', 'parent', 'frames', 'fetch',
  'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'BroadcastChannel',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'importScripts', 'eval', 'Function',
];
function buildSandboxArgs() {
  const blocked = new Set(SANDBOX_BLOCKED);
  const realWindow = globalThis;
  // window 也走代理：屏蔽 window.chrome / window.fetch 等；函数方法绑定到真实 window，
  // 避免调用 window 方法时触发 "Illegal invocation"。
  const safeWindow = new Proxy(realWindow, {
    get(target, prop) {
      if (typeof prop === 'string' && blocked.has(prop)) return undefined;
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
    has(target, prop) {
      return !(typeof prop === 'string' && blocked.has(prop));
    },
  });
  // 把允许/屏蔽的名字都作为函数形参传入：形参会 shadow 掉同名全局，从而在不解构
  // 全局对象的前提下完成白名单隔离（比 with(proxy) 更不易被外部变量解析绕过）。
  const names = [];
  const values = [];
  for (const name of SANDBOX_ALLOWED) {
    names.push(name);
    values.push(name === 'window' ? safeWindow : globalThis[name]);
  }
  for (const name of SANDBOX_BLOCKED) {
    names.push(name);
    values.push(undefined);
  }
  return { names, values, safeWindow };
}

async function cmdRunJs(params) {
  const code = String((params && params.code) || '').trim();
  if (!code) return { ok: false, error: 'run_javascript 需要 code 参数' };
  if (code.length > 20000) return { ok: false, error: '代码过长（上限 20000 字符），请精简逻辑' };
  let value;
  try {
    // 代码体作为函数体注入（可用 return 返回结果）；形参白名单隔离高权限全局，
    // this 绑定到 safeWindow，避免通过 this.chrome 绕过。
    const { names, values, safeWindow } = buildSandboxArgs();
    const fn = new Function(...names, code);
    value = fn.call(safeWindow, ...values);
  } catch (e) {
    return { ok: false, error: 'JS 执行出错：' + (e && e.message ? e.message : String(e)) };
  }
  if (value && typeof value.then === 'function') {
    try {
      value = await value;
    } catch (e) {
      return { ok: false, error: '异步 JS 执行出错：' + (e && e.message ? e.message : String(e)) };
    }
  }
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (e) {
    serialized = String(value);
  }
  if (serialized === undefined) serialized = 'undefined';
  if (serialized.length > 2000) serialized = serialized.slice(0, 2000) + '\n…（结果过长已截断）';
  return { ok: true, result: serialized };
}

export function runJs(params) { return cmdRunJs(params || {}); }

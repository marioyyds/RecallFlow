// 页面命令系统：结构化命令控制当前页面 DOM（高亮、滚动、改样式、点击、描边、读取）。
// 通过 chrome.runtime 消息由后台 Agent 工具（page_command）或用户直接调用。
import { normalizeCitationText, PAGE_TEXT_EXCLUDE, isElementCollectExcluded, buildPageCharMap, findRangeBySubstr, overlayElement, overlayColor, overlayRange, disposeOverlays } from './citation.js';
import { getInteractiveElementByRef, getRefFingerprint, elementSelector, absoluteRect, findMainContent, isElementRendered, shadowDepth, ancestorPath, resolveElementRef } from './page-text.js';
import { expandTableGrid, formatTableText } from '../shared/table.js';
// 页面原文（含图表/数学/表情符号里的星形平面字符）一律用 sliceSafe 截断：
// 按码元下标切会留下孤立代理，进请求体就会被服务端整单拒收（见 surrogates.js 的事故说明）。
import { sliceSafe } from '../shared/surrogates.js';
import { formatInspectSummary, formatInspectMatches, formatHighlightResult, DEFAULT_STYLE_PROPS, formatStylesSummary, formatSelectOptions, formatInvalidControls } from '../shared/utils.js';
import { HIGHLIGHT_MAX_TEXTS } from '../shared/constants.js';
import { waitForSettle } from './settle.js';
import { editableTextSummary } from '../shared/editable-text.js';

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
    if (isElementCollectExcluded(el)) continue;
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
export function roleOf(el) {
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
export function accessibleName(el) {
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
  return sliceSafe((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), 0, 120);
}

function normName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// 可交互候选的统一选择器：role/name 查找与「近似候选」诊断共用，保证两者看到同一批元素。
const TARGET_CANDIDATE_SELECTOR = 'a,button,input,textarea,select,summary,option,[role],[contenteditable="true"]';

function findElementsByRoleName(role, name) {
  const wantRole = normName(role);
  const wantName = normName(name);
  const cands = queryAllInFrames(document, TARGET_CANDIDATE_SELECTOR);
  const hits = [];
  for (const el of cands) {
    // 用**元素收集**的排除名单，而不是正文抽取那份：后者含 button/input/select，
    // 会让 role/name 定位永远找不到原生控件（实测：页面只有 <button>提交</button> 时，
    // click_element({role:'button',name:'提交'}) 恒报"页面上没有 role=button 的可交互元素"）。
    // 详见 citation.js 的 ELEMENT_COLLECT_EXCLUDE。
    if (isElementCollectExcluded(el)) continue;
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

/** 两个名字的相似度：公共前缀长度 ×2 + 公共字符数。用于给「近似候选」排序。 */
export function nameSimilarity(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return 0;
  let prefix = 0;
  while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix++;
  const setB = new Set(y);
  let shared = 0;
  for (const ch of new Set(x)) if (setB.has(ch)) shared++;
  return prefix * 2 + shared;
}

/**
 * 定位失败时的「近似候选」说明（返回 '' 表示给不出线索）。
 *
 * 动机：实测 `click_element({role:'button', name:'主题：深色（点击切换）'})` 只回一句
 * 「未找到目标元素」，没有任何线索。模型只能猜 —— 它当时归因成「语义定位器对 shadow DOM
 * 的适配问题」，但代码里 role+name 路径本来就穿透 shadow root，那个结论站不住；
 * 真实原因很可能是那个按钮是三态循环、aria-label 已经变成「主题：跟随系统（点击切换）」。
 *
 * 只要把「同 role 但名字不同」的候选连同它们的准确名字列出来，这类问题**一轮就能自纠**，
 * 而不是让模型在错误归因上继续消耗额度。
 */
export function describeLookupMiss(params = {}, limit = 5) {
  const wantRole = normName(params.role);
  const wantName = normName(params.name);
  if (!wantRole && !wantName) return '';
  let pool;
  try {
    const cands = queryAllInFrames(document, TARGET_CANDIDATE_SELECTOR);
    pool = cands.filter((el) => !isElementCollectExcluded(el) && isVisibleForAction(el));
  } catch (e) {
    return '';
  }
  if (wantRole) pool = pool.filter((el) => roleOf(el) === wantRole);
  const described = pool
    .map((el) => ({ el, name: String(accessibleName(el) || '').replace(/\s+/g, ' ').trim() }))
    .filter((x) => x.name);
  if (!described.length) {
    // 连同 role 的候选都没有 —— 这本身就是有用的信息（说明 role 就不对）。
    return wantRole && !pool.length ? '页面上没有 role=' + params.role + ' 的可交互元素。' : '';
  }
  const sorted = wantName
    ? described.slice().sort((a, b) => nameSimilarity(b.name, params.name) - nameSimilarity(a.name, params.name))
    : described;
  const shown = sorted.slice(0, limit);
  const lines = shown.map((x) => {
    const role = roleOf(x.el) || x.el.tagName.toLowerCase();
    let sel = '';
    try {
      sel = elementSelector(x.el);
    } catch (e) {}
    return '  - ' + role + '「' + x.name.slice(0, 60) + '」' + (sel ? '  ' + sel : '');
  });
  return (
    '页面上有 ' +
    described.length +
    ' 个相近的可交互元素' +
    (wantRole ? '（role=' + params.role + '）' : '') +
    '，但没有一个匹配这个名字：\n' +
    lines.join('\n') +
    (sorted.length > shown.length ? '\n  …还有 ' + (sorted.length - shown.length) + ' 个' : '') +
    '\n若其中某个就是目标，请照抄它的准确 role/name（或直接用 selector / ref 定位）。'
  );
}

/**
 * 动作完成后回报目标的可观测状态。
 *
 * 动机：实测主题按钮是**三态循环**（跟随系统 → 深色 → 浅色），agent 连点几次后
 * 停在「跟随系统」而无法复原 —— 它缺少「读回当前状态」的手段，只能靠猜。
 * 点击后把状态属性一并回报，"点了之后变成了什么"就不再需要猜。
 */
export function describeTargetState(el) {
  if (!el) return '';
  const parts = [];
  for (const attr of ['aria-label', 'aria-pressed', 'aria-checked', 'aria-expanded', 'aria-selected', 'aria-disabled', 'title']) {
    const v = el.getAttribute && el.getAttribute(attr);
    if (v !== null && v !== undefined && String(v).trim()) parts.push(attr + '=' + JSON.stringify(sliceSafe(String(v).replace(/\s+/g, ' ').trim(), 0, 60)));
  }
  const text = String((el.innerText || el.textContent || '')).replace(/\s+/g, ' ').trim();
  if (text && text.length <= 80) parts.push('text=' + JSON.stringify(text));
  return parts.join(' ');
}

/** 统一的定位失败信息：附上近似候选。 */
function targetMissError(params) {
  if (params && params.ref) {
    if (getRefFingerprint(params.ref)) {
      return 'ref「' + params.ref + '」已失效：页面结构已变化（元素被替换/移除）。请重新 get_page_snapshot 获取新 ref，不要继续用旧 ref。';
    }
    return 'ref「' + params.ref + '」不存在或已被清理。请重新 get_page_snapshot 获取 ref。';
  }
  const hint = describeLookupMiss(params || {});
  return hint ? '未找到目标元素。' + hint : '未找到目标元素';
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
    if (!els.length) return { found: false, reason: targetMissError(params) };
    const el = els[0];
    const label = sliceSafe(
      String(
        el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') ||
        el.innerText || el.textContent || el.getAttribute('name') || ''
      ).replace(/\s+/g, ' ').trim(),
      0,
      60
    );
    return {
      found: true,
      selector: elementSelector(el),
      rect: absoluteRect(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      contentEditable: Boolean(el.isContentEditable),
      editable: Boolean(el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'),
      label,
    };
  } catch (e) {
    return { found: false, reason: e.message };
  }
}

// ---- 元素渲染态读取（供 MCP 的 verify_change 断言「改完代码后页面对不对」）----

// 元素是否被渲染出可见布局。注意语义是「有布局且可见」，不要求落在当前视口内。
function isRenderedForVerify(el) {
  try {
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  } catch (e) {
    return false;
  }
}

function normalizeInnerText(el) {
  return sliceSafe(String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), 0, 300);
}

// 读取单个元素的渲染态；styles 为需要额外读取的计算样式属性名列表。
function readElementState(el, styles) {
  const rect = el.getBoundingClientRect();
  const cs = window.getComputedStyle(el);
  const state = {
    selector: elementSelector(el),
    tag: el.tagName.toLowerCase(),
    visible: isRenderedForVerify(el),
    text: normalizeInnerText(el),
    box: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
  };
  if (typeof el.value === 'string') state.value = sliceSafe(el.value, 0, 300);
  if (Array.isArray(styles) && styles.length) {
    const out = {};
    for (const p of styles.slice(0, 12)) {
      const prop = String(p || '').trim();
      if (!prop) continue;
      try {
        out[prop] = sliceSafe(String(cs.getPropertyValue(prop) || '').trim(), 0, 120);
      } catch (e) {}
    }
    state.styles = out;
  }
  return state;
}

/**
 * 批量读取目标元素的渲染态，供断言使用。
 * 定位复用 ref / role+name / testid / selector / text（findElementsFor），
 * 因此与 click_element / type_text 等工具使用同一套定位语义，HMR 后不会因换定位方式而失配。
 * @param {Array} targets - [{label, selector|ref|role+name|testid|text, index?, styles?}]
 */
export function verifyTargets(targets) {
  const list = Array.isArray(targets) ? targets.slice(0, 20) : [];
  return list.map((t, i) => {
    const src = t || {};
    const hasLocator = Boolean(src.ref || src.role || src.name || src.testid || src.selector || src.text);
    // 注意：不能把 index 交给 findElementsFor —— 它会切片成单元素，导致 count 失真。
    const locator = { ref: src.ref, role: src.role, name: src.name, testid: src.testid, selector: src.selector, text: src.text };
    let els = [];
    try {
      els = findElementsFor(locator);
    } catch (e) {
      els = [];
    }
    const idxRaw = Number(src.index);
    const idx = Number.isInteger(idxRaw) && idxRaw >= 0 ? idxRaw : 0;
    const el = els[idx] || null;
    const out = { index: i, label: String(src.label || '').trim(), count: els.length, found: Boolean(el) };
    if (el) {
      Object.assign(out, readElementState(el, src.styles));
    } else if (!hasLocator) {
      out.reason = '目标未提供定位方式（需要 selector / ref / role+name / testid / text 之一）';
    } else {
      out.reason = els.length
        ? 'index ' + idx + ' 超出匹配元素数量（共 ' + els.length + ' 个）'
        : '未找到匹配元素';
    }
    return out;
  });
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
    const requested = params.texts.map((t) => String(t).trim()).filter(Boolean);
    // 单次上限是性能护栏（每条都要建字符映射 + 落一层浮层），但不能**默默**截断。
    // 原实现先 slice(0, 20) 再报 texts.length，于是传 25 条会返回
    // 「已高亮 20 / 20 处关键信息」—— 调用方以为 25 条全做了。
    // 这和一个上限被当成答案同样危险：它让「少做了 5 条」看起来像「全部完成」。
    const texts = requested.slice(0, HIGHLIGHT_MAX_TEXTS);
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
    return {
      ok: true,
      hit,
      attempted: texts.length,
      requested: requested.length,
      result: formatHighlightResult({
        hit,
        attempted: texts.length,
        requested: requested.length,
        misses,
        limit: HIGHLIGHT_MAX_TEXTS,
      }),
    };
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
    // ⚠ 给 **x/y 偏移** 时，滚的是**这个元素自己**，不是窗口。
    //
    // 修的是一个真实的能力缺口：**内部可滚动容器**（虚拟列表 / 带 overflow 的面板）
    // 原先没有任何一等公民的滚法 ——
    //   · `{ selector }` 走 scrollIntoView，对已经在视口里的容器是**空操作**，`y` 被直接忽略；
    //   · 不带目标时走 `scroll_by`，那是 `window.scrollBy`，**只动窗口**。
    // 于是"把容器滚到第 87 条"只能靠反复 scrollIntoView 可见行慢慢推，
    // 或者用 run_javascript 自己设 scrollTop（一次高危审批）。
    // 现在 `scroll_page({ selector: '#list', y: 3480 })` = "把该容器向下滚 3480px"，
    // 与 schema 里 `y` 的既有描述（"纵向偏移(px)，正数向下"）一致。
    const offY = Number(params.y) || 0;
    const offX = Number(params.x) || 0;
    if (offY || offX) {
      const target = (params.ref || params.selector) ? findElementsFor(params)[0] : null;
      const range = !target && params.text ? findRangeFor(params) : null;
      const box = target || (range && (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement));
      if (!box) {
        return { ok: false, error: targetMissError(params) + '（可先 get_page_snapshot 获取 ref，或改用 role/name 定位）' };
      }
      const prevTop = box.scrollTop;
      const prevLeft = box.scrollLeft;
      box.scrollTop = prevTop + offY;
      box.scrollLeft = prevLeft + offX;
      pushUndo(() => {
        box.scrollTop = prevTop;
        box.scrollLeft = prevLeft;
      });
      const moved = Math.round(box.scrollTop) !== Math.round(prevTop) || Math.round(box.scrollLeft) !== Math.round(prevLeft);
      return {
        ok: true,
        selector: elementSelector(box),
        result:
          '已滚动容器（偏移 y=' + offY + ' x=' + offX + '）→ scrollTop=' + Math.round(box.scrollTop) +
          ' scrollLeft=' + Math.round(box.scrollLeft) +
          (moved ? '' : '（位置没变：该元素可能本来就不可滚动，或已经到边界）'),
      };
    }
    if (params.text) {
      const range = findRangeFor(params);
      if (range) {
        scrollRangeIntoView(range);
        pushScrollUndo();
        return { ok: true, result: '已滚动到目标文本' };
      }
    }
    const els = findElementsFor(params);
    if (!els.length) return { ok: false, error: targetMissError(params) + '（可先 get_page_snapshot 获取 ref，或改用 role/name 定位）' };
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
  if (!els.length) return { ok: false, error: targetMissError(params) };
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
  // hide 语法糖：隐藏是最高频用法，且比「从 DOM 移除」安全得多
  // （移除节点会让站点自身的状态跟踪失准：无限滚动、内容可见性、广告 SDK 都会报错）。
  const hide = params.hide;
  let styles = params.styles;
  if (hide === true) styles = { display: 'none' };
  else if (hide === false) styles = { display: '' };
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)) {
    return { ok: false, error: 'set_style 需要 styles 对象，或直接用 hide:true 隐藏 / hide:false 还原' };
  }

  // 批量：一次处理多个选择器。没有批量参数时，「隐藏 N 个元素」= N 次工具调用，
  // 模型会倾向改用 run_javascript 写循环 —— 而循环里往往顺手 remove() 掉节点。
  const selectorList = Array.isArray(params.selectors)
    ? params.selectors.map((s) => String(s === undefined || s === null ? '' : s).trim()).filter(Boolean).slice(0, 20)
    : [];

  let els = [];
  const misses = [];
  if (selectorList.length) {
    for (const sel of selectorList) {
      let hit = [];
      try {
        hit = findElementsFor({ selector: sel });
      } catch (e) {
        hit = [];
      }
      if (hit.length) els = els.concat(hit);
      else misses.push(sel);
    }
    els = Array.from(new Set(els)); // 同一元素可能同时匹配多个选择器
    if (!els.length) {
      return { ok: false, error: '未找到任何目标元素（全部未命中：' + misses.join('、') + '）' };
    }
  } else {
    els = findElementsFor(params);
    if (!els.length) return { ok: false, error: targetMissError(params) };
  }

  const backups = els.map((el) => ({ el, old: el.style.cssText }));
  els.forEach((el) => {
    Object.keys(styles).forEach((k) => {
      try { el.style[k] = styles[k]; } catch (e) {}
    });
  });
  const revert = () => backups.forEach((b) => { b.el.style.cssText = b.old; });
  pushUndo(revert);

  const verb = hide === true ? '隐藏' : hide === false ? '还原' : '修改';
  const missNote = misses.length
    ? '；未命中 ' + misses.length + ' 个选择器：' + misses.map((m) => m.slice(0, 24)).join('、')
    : '';
  const tail = '（' + (Number(params.duration) > 0 ? Number(params.duration) + 'ms 后还原' : 'clear_highlights 还原') + '）';
  const summary = '已' + verb + ' ' + els.length + ' 个元素' + missNote + tail;

  const dur = Number(params.duration);
  if (dur > 0) {
    cmdTimers.push(setTimeout(revert, dur));
    return { ok: true, result: summary, changed: true, alreadySatisfied: false };
  }
  cmdStyleReverters.push(revert);
  return { ok: true, result: summary, changed: true, alreadySatisfied: false };
}

// 元素侦查：一次回答「这些元素在哪、还看不看得见、属于哪个容器、容器是否含正文」。
// 这四件事以前都要模型用 run_javascript 逐层查 DOM —— 一次去广告任务因此多出十几轮往返
// （探查 → 等结果 → 再探查），而每一轮都是一次完整的模型请求。
// 收集**没通过 HTML5 原生校验**的表单控件（含匹配元素内部的）。
//
// 为什么必须由工具给出这一条：页面对"没通过校验"通常是**静默**的 ——
// 浏览器只在**它自己的原生气泡**里提示（工具读不到），DOM 里既没有错误文案、
// 提交也不会发生、状态文案也不变。于是"点了提交没反应"看起来像"按钮坏了"。
//
// 实测（真模型探针）：模型为此换了 **8 次调用**四处找原因
//（read_current_page ×2 / read_diagnostics / inspect_element ×2 / get_ax_snapshot /
// get_page_snapshot），还**借道 run_javascript 自己扫 DOM**（一次高危审批）——
// 而它最早、最自然的那个动作就是 `inspect_element({op:"inspect", selector:"body"})`，
// 只要那一步能回答，后面全都不必发生。所以这一档补在 **inspect** 上。
//
// 关键：`validationMessage` 是**浏览器语言**的（中英日随环境变），拿它做判据会脆；
// 所以同时给出**与语言无关的约束名**（valueMissing / tooShort / typeMismatch …）。
function collectInvalidControls(root) {
  const out = [];
  const seenSel = new Set();
  // 扫描范围：元素自身 + 它内部的控件 + **它所在的那个表单**。
  //
  // 为什么必须带上"所在表单"：实测模型遇到"提交没反应"时，`op:"inspect"` 看的是
  // **它刚点的那个按钮**（`#ok`）—— 按钮内部当然没有无效字段，于是它拿不到答案，
  // 只好连续 9 次 `get_attribute` 把 required/pattern/type 全读一遍自己推（31 次调用、2 次审批）。
  // 校验的作用域本来就是**表单**，所以被查元素在某个 form 里时，一并把那个 form 的
  // 未通过字段报出来 —— 这才是用户/模型真正想问的那个问题。
  const roots = [];
  const push = (el) => {
    if (el && roots.indexOf(el) === -1) roots.push(el);
  };
  push(root);
  try {
    if (root && root.closest) push(root.closest('form'));
  } catch (e) {}
  for (const scope of roots) {
    let nodes = [];
    try {
      nodes = Array.prototype.slice.call(scope.querySelectorAll('input, select, textarea'));
    } catch (e) {
      nodes = [];
    }
    if (scope && /^(INPUT|SELECT|TEXTAREA)$/.test(String(scope.tagName || ''))) nodes.unshift(scope);
    for (const el of nodes) {
      const v = el.validity;
      if (!v || v.valid !== false) continue;
      const sel = elementSelector(el);
      if (seenSel.has(sel)) continue;
      seenSel.add(sel);
      const reasons = [
        'valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort',
        'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError',
      ].filter((k) => v[k] === true);
      out.push({
        selector: sel,
        name: sliceSafe(String(el.getAttribute('aria-label') || el.name || el.id || ''), 0, 60),
        reasons,
        message: sliceSafe(String(el.validationMessage || ''), 0, 160),
        value: typeof el.value === 'string' ? sliceSafe(el.value, 0, 80) : '',
      });
      if (out.length >= 12) return out;
    }
  }
  return out;
}

function cmdInspectElement(params) {
  // 命中总数必须在**截断之前**取。
  // 原实现先 slice(0, 8) 再把 matches.length 当作命中数报出去，于是任何命中 ≥8 个
  // 元素的选择器都恒返回「命中 8 个元素」—— 而调用方无法区分「正好 8 个」与
  // 「至少 8 个」。实测会话里调用方正好在找「8 处高亮」，工具恒回 8，
  // 一个截断上限被当成了答案：这类「永远返回期望值」的输出比返回错误值更危险。
  const all = findElementsFor(params);
  if (!all.length) return { ok: false, error: targetMissError(params) };
  const MAX_LISTED = 8;
  const listed = all.slice(0, MAX_LISTED);
  const truncated = all.length > listed.length;
  const main = findMainContent();
  const mainSel = main && main.selector ? main.selector : '';
  const matches = listed.map((el) => {
    const rect = el.getBoundingClientRect();
    let containsMain = false;
    if (mainSel) {
      try {
        containsMain = elementSelector(el) === mainSel || Boolean(el.querySelector(mainSel));
      } catch (e) {
        containsMain = false;
      }
    }
    return {
      selector: elementSelector(el),
      tag: String(el.tagName || '').toLowerCase(),
      visible: isElementRendered(el),
      shadowDepth: shadowDepth(el) || undefined,
      size: { w: Math.round(rect.width), h: Math.round(rect.height) },
      textLength: String(el.textContent || '').length,
      path: ancestorPath(el),
      containsMainContent: containsMain || undefined,
    };
  });
  const visibleCount = matches.filter((m) => m.visible).length;
  const hidden = matches.length - visibleCount;
  // 表单合法性：只把**没通过**的列出来（全通过时不加任何内容，避免给每次 inspect 都塞一段废话）。
  const invalid = collectInvalidControls(listed[0]);
  // 正文容器提醒只在**命中项确实触到它**时给出。
  // 原先无条件附加，于是「查高亮浮层」这类无关查询也会收到
  // 「疑似正文容器：#root…不要连带隐藏它」，实测 5 次调用重复 5 遍，纯噪声。
  const touchesMain = matches.some((m) => m.containsMainContent);
  return {
    ok: true,
    count: all.length, // 命中总数（截断前）
    listed: matches.length, // 本次列出条数
    truncated,
    visibleCount,
    mainContent: main ? { selector: main.selector, textLength: main.textLength } : null,
    matches,
    invalidControls: invalid.length ? invalid : undefined,
    result:
      formatInspectSummary({
        total: all.length,
        listed: matches.length,
        visibleCount,
        truncated,
        touchesMain,
        main,
      }) +
      // 逐元素明细必须并进 result —— 页面命令走到模型的那条路只取 result 字符串，
      // 只放在 matches 字段里等于丢掉（见 formatInspectMatches 的注释）。
      (() => {
        const detail = formatInspectMatches(matches);
        return detail ? '\n列出：\n' + detail : '';
      })() +
      // 同一约定：合法性也要并进 result（模型只读得到这一段文本）
      formatInvalidControls(invalid),
  };
}

/**
 * 结构化元素查询（inspect_element({op:"query"})）。
 *
 * 为什么需要它：小红书实操里 70 次工具调用有 35 次 run_javascript，绝大多数是在
 * “找 custom element / 读 rect / 查 shadow / 找可滚动容器”。这些是只读查询，
 * 不该借道高危 JS，更不该靠反复试探。
 *
 * 与 op:"inspect" 的区别：inspect 面向“已知目标，判断状态”；query 面向
 * “给条件，返回候选清单”，并且把 ref / rect / role / name / customElement / shadowDepth
 * 一次交齐，后续动作可以直接用返回的 ref。
 */
function cmdQueryElements(params) {
  const p = params || {};
  const limit = Math.min(50, Math.max(1, Number(p.limit) || 20));
  const includeHidden = p.includeHidden === true;
  const seen = new Set();
  const all = [];
  // 有多少命中因为「不可见」被筛掉。零命中时这是最有用的诊断：
  // 元素存在但被折叠/懒加载/透明，与「页面上根本没有它」是两种完全不同的下一步。
  let hiddenSkipped = 0;
  const push = (el) => {
    if (!el || seen.has(el)) return;
    if (isElementCollectExcluded(el)) return;
    if (!includeHidden && !isElementRendered(el)) {
      hiddenSkipped += 1;
      return;
    }
    seen.add(el);
    all.push(el);
  };

  if (p.selector) {
    try { queryAllInFrames(document, p.selector).forEach(push); } catch (e) {}
  } else if (p.role || p.name) {
    findElementsByRoleName(p.role, p.name).forEach(push);
    // custom element 未必有 role：按可访问名再补一轮，解决 xhs-publish-btn 这类目标。
    if (p.name) {
      try {
        queryAllInFrames(document, '*').forEach((el) => {
          const tag = String(el.tagName || '').toLowerCase();
          if (!tag.includes('-')) return;
          if (normName(accessibleName(el)).indexOf(normName(p.name)) === -1) return;
          push(el);
        });
      } catch (e) {}
    }
  } else if (p.testid) {
    findElementsByTestId(p.testid).forEach(push);
  } else if (p.text) {
    const q = normalizeCitationText(p.text);
    if (q) {
      // 先收集**文本命中**（含隐藏），再区分可见/隐藏。
      // 不能边扫边按可见性丢：textContent 会把 display:none 子树里的文字也算进来，
      // 于是 body 这类可见容器会因为「内部有个隐藏按钮」而假命中（实测夹具：
      // 查「隐藏操作」只返回 body，零命中诊断就永远触发不了）。
      const raw = [];
      try {
        queryAllInFrames(document, '*').forEach((el) => {
          if (isElementCollectExcluded(el)) return;
          const text = normalizeCitationText(el.textContent);
          if (!text.includes(q)) return;
          raw.push(el);
        });
      } catch (e) {}
      const hiddenRaw = [];
      const visibleRaw = [];
      for (const el of raw) {
        (isElementRendered(el) ? visibleRaw : hiddenRaw).push(el);
      }
      const visibleTextHas = (el) => {
        try {
          return normalizeCitationText(el.innerText).includes(q);
        } catch (e) {
          return true; // 读不到 innerText 时不要凭猜测把候选丢掉
        }
      };
      const reclassifiedHidden = [];
      const visibleMatches = [];
      for (const el of visibleRaw) {
        // 只有「可见容器内部还有隐藏命中」才需要用渲染文本复核 —— innerText 会触发布局，
        // 不该对每个候选都读。这一步正是为了挡住 body/大容器的假命中。
        const hasHiddenInside = hiddenRaw.some((h) => h !== el && el.contains(h));
        if (!hasHiddenInside || visibleTextHas(el)) visibleMatches.push(el);
        else reclassifiedHidden.push(el);
      }
      if (includeHidden) {
        // 与 selector 分支同义：includeHidden 时把隐藏命中也列出来。
        visibleMatches.push(...hiddenRaw);
      } else {
        const hiddenAll = hiddenRaw.concat(reclassifiedHidden);
        // 只数最深层：一个隐藏子树里的祖先与后代都含同一段文字，数祖先会虚报。
        hiddenSkipped = hiddenAll.filter(
          (el) => !hiddenAll.some((o) => o !== el && el.contains(o))
        ).length;
      }
      // 只保留最深层命中，避免把 body/大容器也列出来。
      // 自定义元素宿主必须保留：它的内部文字会命中，但它本身才是可点击/可读的组件边界。
      const deepest = visibleMatches.filter((el) => {
        if (String(el.tagName || '').toLowerCase().includes('-')) return true;
        return !visibleMatches.some((other) => other !== el && el.contains(other));
      });
      all.length = 0;
      seen.clear();
      deepest.forEach(push);
    }
  } else {
    return { ok: false, error: 'query 需要 selector、role/name、testid 或 text 之一作为查询条件' };
  }

  const sorted = all
    .slice()
    .sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const va = ra.width > 0 && ra.height > 0 ? 0 : 1;
      const vb = rb.width > 0 && rb.height > 0 ? 0 : 1;
      return va - vb || ra.top - rb.top || ra.left - rb.left;
    });
  const listed = sorted.slice(0, limit);
  const items = listed.map((el) => {
    const rect = el.getBoundingClientRect();
    const tag = String(el.tagName || '').toLowerCase();
    const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const role = roleOf(el);
    return {
      ref: resolveElementRef(el),
      tag,
      role: role || undefined,
      name: sliceSafe(accessibleName(el), 0, 120),
      selector: elementSelector(el),
      text: sliceSafe(text, 0, 180),
      visible: isElementRendered(el),
      customElement: tag.includes('-') || undefined,
      shadowDepth: shadowDepth(el) || undefined,
      editable: Boolean(el.isContentEditable || tag === 'textarea' || tag === 'input'),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
      path: ancestorPath(el),
    };
  });
  const lines = items.map((it, i) =>
    '[' + (i + 1) + '] ref=' + it.ref + ' tag=' + it.tag +
    ' selector=' + it.selector +
    (it.role ? ' role=' + it.role : '') +
    (it.name ? ' name=' + JSON.stringify(it.name) : '') +
    (it.customElement ? ' custom=true' : '') +
    ' ' + it.rect.width + '×' + it.rect.height +
    ' center=(' + it.center.x + ',' + it.center.y + ')' +
    (it.text ? ' text=' + JSON.stringify(it.text.slice(0, 60)) : '')
  );
  if (!items.length) {
    // 零命中不是「答案为空」，而是一个需要给出下一步的分叉。
    // 不返回 ok:false：查询本身成功执行了，零结果也是有效结果；
    // 但必须说清是「隐藏」「没渲染」还是「这里根本看不到它」。
    const reasons = [];
    if (hiddenSkipped) {
      reasons.push(
        '有 ' + hiddenSkipped + ' 个元素命中但当前不可见（折叠菜单/懒加载/透明/零尺寸）。' +
          '传 includeHidden:true 可列出它们，或先点击展开再查。'
      );
    }
    if (p.text) {
      let bodyText = '';
      try {
        bodyText = normalizeCitationText(document.body ? document.body.innerText : '');
      } catch (e) {}
      const q = normalizeCitationText(p.text);
      reasons.push(
        q && bodyText.includes(q)
          ? '这段文字在当前可见正文里，但没有落到可定位的元素边界；改用 selector / role+name，或用 get_ax_snapshot 取可访问节点。'
          : '当前可见正文里没有这段文字：可能尚未渲染（用 wait_for_element 等它出现），或在跨域 iframe（list_frames）/ canvas / closed shadow 里。'
      );
    } else if (p.selector) {
      reasons.push(
        '选择器当前没有命中：确认它是否在开放 shadow root 内（本工具会穿透），或先用 wait_for_element({selector, state:"attached"}) 等它挂载。'
      );
    } else {
      reasons.push('可换 role+name / testid / text 再查，或先用 get_page_snapshot 看页面上有哪些可交互元素。');
    }
    if (!hiddenSkipped && (p.selector || p.role || p.name || p.testid)) {
      reasons.push('若目标在跨域 iframe，用 list_frames 找到 frameId 后先 get_page_snapshot({frameId}) 再操作。');
    }
    return {
      ok: true,
      count: 0,
      listed: 0,
      truncated: false,
      hiddenSkipped,
      elements: [],
      result: '元素查询命中 0 个。\n诊断：\n- ' + reasons.join('\n- '),
    };
  }
  return {
    ok: true,
    count: all.length,
    listed: items.length,
    truncated: all.length > items.length,
    elements: items,
    result:
      '元素查询命中 ' + all.length + ' 个（列出 ' + items.length + ' 个）：\n' +
      (lines.join('\n') || '（无）') +
      '\n提示：可直接把 ref 传给 click_element / type_text / get_attribute；custom=true 表示自定义元素，center 可用于 click_at 降级。',
  };
}

// 读取一批元素的**计算样式**（只读：不 eval、不写 DOM、不需要审批）。
//
// 为什么必须有它（本轮做「UI 美化」时暴露的缺口）：
//   `annotate({ op:"style" })` 只回一句「已修改 N 个元素」—— 那证明的是"调用发出去了"，
//   不是"样式真的生效了"（可能被 `!important` 覆盖、或因取值非法被忽略）。
//   在此之前面板侧唯一的取证路径是 `run_javascript` 读 getComputedStyle，而它有两个硬伤：
//     ① 元数据是 `alwaysRequireApproval`：**任何审批策略都拦不住地打断用户**；
//     ② 它经 eval 执行，而 MV3 扩展自身的 CSP 不允许 eval（与页面无关），
//        所以**必须**另开 CDP 才能落到页面主世界。
//   而"读一下算出来的样式"本来是彻头彻尾的只读操作 —— 它就该和 inspect/text/table 一样
//   待在只读工具里，而不是借道一个高危工具。
//
// 复用 `readElementState`（原本只给 MCP 侧的 verify_change 用），所以不引入新的取值逻辑。
// 读 `<select>` 的选项清单。
//
// 为什么需要它（与 cmdReadStyles 同一类缺口，实测挖出来的）：
//   · 闭合的 `<select>` 里 `<option>` **没有布局盒子**，正文抽取按"不可见"跳过 ——
//     所以 `get_page_snapshot` 的正文里**看不到选项文案**（价格/规格常常只写在选项里）；
//   · `get_attribute` 只读**属性**，读不了 `outerHTML`。
// 于是"这个下拉框有哪些选项"此前**没有只读办法**。
// 真模型探针实测：任务"选最便宜的那个"时，模型只能先写一段 run_javascript
//（`Array.from(s.options).map(...)`）—— 白花一次高危审批，CSP 严的页面还会直接失败。
//
// 返回里同时给结构化 items 与拼好的文本；**文本必须并进 result**（见 docs/tool-design.md §6）。
function cmdReadOptions(params) {
  const els = findElementsFor(params);
  if (!els.length) return { ok: false, error: targetMissError(params) };
  const el = els[0];
  const tag = (el.tagName || '').toUpperCase();
  if (tag !== 'SELECT') {
    // 说清"这是什么元素"，而不是只报"不是 select" —— 模型据此才知道该换个目标
    return {
      ok: false,
      error:
        '目标元素不是 <select>（实际是 ' + (tag || '未知') + describeTargetState(el) + '）。' +
        'read_options 只能读下拉框；要读别的元素的文字请用 op:"text"。',
    };
  }
  const MAX_OPTIONS = 60;
  const all = Array.prototype.slice.call(el.options || []);
  const listed = all.slice(0, MAX_OPTIONS);
  const items = listed.map((o, i) => ({
    index: i,
    value: o.value,
    label: String(o.textContent == null ? '' : o.textContent).replace(/\s+/g, ' ').trim(),
    selected: !!o.selected,
    disabled: !!o.disabled,
  }));
  const multiple = !!el.multiple;
  const optionsText = formatSelectOptions(items);
  return {
    ok: true,
    count: all.length,
    truncated: all.length > listed.length,
    multiple,
    selectedIndex: el.selectedIndex,
    items,
    result:
      '下拉框选项（共 ' + all.length + ' 项' + (multiple ? '，多选' : '') +
      (all.length > listed.length ? '，只列出前 ' + listed.length + ' 项' : '') + '）：\n' +
      (optionsText || '（没有选项）') +
      '\n（选中请用 select_option：按 value 或 label 都行）',
  };
}

function cmdReadStyles(params) {
  const els = findElementsFor(params);
  if (!els.length) return { ok: false, error: targetMissError(params) };
  const wanted =
    Array.isArray(params.props) && params.props.length
      ? params.props.map((p) => String(p === undefined || p === null ? '' : p).trim()).filter(Boolean).slice(0, 12)
      : DEFAULT_STYLE_PROPS.slice();
  const MAX_LISTED = 8;
  const listed = els.slice(0, MAX_LISTED);
  const items = listed.map((el) => readElementState(el, wanted));
  return {
    ok: true,
    count: els.length,
    truncated: els.length > listed.length,
    props: wanted,
    items,
    result: formatStylesSummary(items, els.length),
  };
}

// 结构化提取 <table>：把合并单元格还原成矩形网格后再输出。
// 朴素做法（逐行取 td 文本）在 rowspan/colspan 存在时必然整体错位。
// 网格展开算法在 lib/shared/table.js（纯函数，有单测）。
function cmdExtractTable(params) {
  const p = params || {};
  let table = null;
  let total = 0;
  try {
    const all = findElementsFor({ selector: 'table' });
    total = all.length;
    if (p.selector) {
      const hit = findElementsFor({ selector: p.selector });
      for (const el of hit) {
        if (el.tagName === 'TABLE') {
          table = el;
          break;
        }
        const inner = el.querySelector && el.querySelector('table');
        if (inner) {
          table = inner;
          break;
        }
      }
    } else {
      const idx = Math.max(0, Number(p.index) || 0);
      table = all[idx] || null;
    }
  } catch (e) {
    return { ok: false, error: '查找表格失败：' + ((e && e.message) || String(e)) };
  }
  if (!table) {
    return {
      ok: false,
      error: p.selector ? '未找到匹配的表格：' + p.selector : '页面上没有表格（或 index 超出范围；共 ' + total + ' 个）',
    };
  }

  // 只取属于本表的行：嵌套表格的行 closest('table') 会指向内层表，必须排除。
  let rows = [];
  try {
    rows = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.closest('table') === table);
  } catch (e) {
    rows = [];
  }
  const raw = rows.map((tr) =>
    Array.from(tr.children || [])
      .filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
      .map((c) => ({
        // innerText 对 display:none 的单元格返回空串，正是我们想要的（隐藏列不该进数据）
        text: (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim(),
        colspan: Number(c.getAttribute('colspan')) || 1,
        rowspan: Number(c.getAttribute('rowspan')) || 1,
        isHeader: c.tagName === 'TH',
      }))
  );

  const grid = expandTableGrid(raw, { maxRows: p.maxRows, maxCols: p.maxCols, fillMerged: p.fillMerged !== false });
  // markdown 只算一次，同时作为结构化字段与 result 正文的来源（避免两处各拼一遍、日后漂移）。
  const markdown = formatTableText(grid, { maxRows: 40 });
  return {
    ok: true,
    selector: elementSelector(table),
    tableIndex: p.selector ? undefined : Math.max(0, Number(p.index) || 0),
    tableCount: total,
    headers: grid.headers,
    rows: grid.rows,
    widths: grid.widths,
    rowCount: grid.rows.length,
    mergedCells: grid.mergedCells,
    markdown,
    result:
      '表格「' + elementSelector(table) + '」：' + grid.rows.length + ' 行 × ' + grid.widths + ' 列' +
      (grid.mergedCells ? '（含 ' + grid.mergedCells + ' 个合并单元格，已展开对齐）' : '') +
      (grid.headers.length ? '，表头：' + grid.headers.join(' / ') : '，无表头') +
      (total > 1 ? '。页面上共 ' + total + ' 个表格。' : '') +
      // ⚠ 表格**数据本身**必须并进 result。
      // 原先只把它放在 markdown / rows 字段里，而页面命令走到模型的那条路
      // （executePageTool）只取 result 字符串 —— 于是模型只收到
      // 「4 行 × 4 列（含 4 个合并单元格，已展开对齐）」这一句摘要，
      // 而 expandTableGrid + formatTableText 辛苦还原出来的对齐数据**被整份丢掉**。
      // 这个工具存在的全部理由就是"把合并单元格还原成对齐网格再给模型"，
      // 丢掉数据等于它只剩一句自我介绍。
      '\n' + markdown,
  };
}

async function cmdClick(params) {
  const els = findElementsFor(params);
  if (!els.length) return { ok: false, error: targetMissError(params) };
  const el = els[0];
  const tag = (el.tagName || '').toLowerCase();
  const beforeHref = location.href;
  const ready = await ensureActionable(el);
  if (!ready) {
    // 自愈：被遮挡或 pointer-events 受限时，退化为程序化 click（绕过遮挡），
    // 仍失败则如实上报，交由后台用 CDP 可信事件兜底。
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      return { ok: false, error: '目标元素不可操作（已禁用）：' + tag + ' ' + describeTargetState(el) };
    }
    try {
      if (typeof el.click === 'function') {
        el.click();
        await nextPaint();
        const navigated = location.href !== beforeHref ? '（页面已导航到 ' + location.href + '）' : '';
        return { ok: true, forced: true, selector: elementSelector(el), result: '目标元素被遮挡或暂不可交互，已改用程序化点击' + stateSuffix(el) + navigated };
      }
    } catch (e) {}
    return { ok: false, error: '目标元素不可操作（不可见、被遮挡或尚未就绪）：' + tag + ' ' + describeTargetState(el) };
  }
  const before = describeTargetState(el);
  try {
    dispatchRealisticClick(el);
  } catch (e) {
    return { ok: false, error: '点击失败：' + e.message };
  }
  // 点击后回报状态：三态开关 / 展开收起 / 勾选这类控件，光说「已点击」等于没说 ——
  // 实测 agent 连点主题按钮后无法复原，正是因为它读不到「现在是什么状态」。
  await nextPaint();
  const after = describeTargetState(el);
  const navigated = location.href !== beforeHref ? '（页面已导航到 ' + location.href + '）' : '';
  let changed = '';
  if (after && after !== before) changed = '（点击前：' + (before || '无状态属性') + '）';
  return {
    ok: true,
    selector: elementSelector(el),
    stateBefore: before,
    stateAfter: after,
    result: '已点击元素 ' + tag + stateSuffix(el) + changed + navigated,
  };
}

/**
 * 动作后等页面稳定，再读状态。
 *
 * 原实现是 `setTimeout(resolve, 50)` 的固定睡眠。50ms 对同步渲染够用，但对 SPA
 * （异步渲染、受控组件回写、请求回来后再渲染）远远不够 —— 于是「动作后立刻读值」
 * 会拿到点击前的旧值：工具把成功报成失败，或把失败报成成功（旧值恰好满足断言）。
 * 对以「验证改动是否生效」为卖点的调试工具，这是地基问题。
 *
 * 现在改为等真实静默（rAF + MutationObserver 静默窗口 + 硬上限，见 settle.js）：
 * 简单页面通常几十 ms 就返回（比固定 50ms 更快），复杂页面会等到真正稳定。
 * 仍是 await 语义，因此所有调用点无需改动。
 */
function nextPaint() {
  return waitForSettle();
}

function stateSuffix(el) {
  const state = describeTargetState(el);
  if (!state) return '';
  // 元素可能已被点击导航掉：此时读不到状态，如实说而不是假装有。
  if (!el.isConnected) return '（该元素已不在页面上）';
  return '；点击后状态：' + state;
}

function cmdGetText(params) {
  if (params.text) {
    const range = findRangeFor(params);
    if (range) return { ok: true, result: range.toString() };
    return { ok: false, error: '未找到文本：' + params.text };
  }
  const els = findElementsFor(params);
  if (!els.length) return { ok: false, error: targetMissError(params) };
  const text = els.map((el) => (el.innerText || el.textContent || '').trim()).filter(Boolean).join('\n---\n').slice(0, 4000);
  // 「这次读真的发生了」的页面可见信号（详见 notifyElementsRead 的注释）。
  notifyElementsRead(els);
  return { ok: true, result: text || '（空内容）' };
}

/**
 * 把「**读取**了这几个元素」这件事通知给页面自己。
 *
 * 为什么需要：页面上有些值是**会过期的**（库存 / 报价 / 余量），而"过期"的时钟该从
 * **第一次真的被读到**开始走 —— 不是从"元素被展开"开始走。可在页面看来，
 * 读取是**不可观测**的：`innerText` / `textContent` 不产生任何 DOM 变更，
 * `MutationObserver` 只能看见**写**。于是页面无从知道"agent 已经看到了缓存值"。
 * 这里补上这个信号：在**真的读了**的每个元素上派发一个不冒泡的 `CustomEvent`，
 * 页面想参与就监听（不监听=零影响）。
 *
 * ⚠ 事件用 `bubbles: false`：只通知**被读的那个元素自己**，不惊动祖先/全局监听者；
 *   同时它对**主世界**（页面自己的脚本）可见 —— 内容脚本与主世界共享 DOM，
 *   在节点上派发的 DOM 事件两个世界都能收到（这是标准的页面↔扩展通信方式）。
 *   夹具 `/pick` 就是靠它把"重新询价"的时钟从"展开时"挪到"第一次读之后"的。
 *
 * ⚠ **代价（刻意接受，写在这里以免日后被当成疏漏）**：DOM 事件对**主世界**可见 ⇒
 *   页面脚本**可以**监听这个读信号事件，从而得知"扩展正在读我的元素"（**扩展指纹**）。
 *   接受它的理由：① 与本仓库既有做法一致 —— 注入的调试节点本来就**显式**加 `data-rf-injected`
 *   属性；② 信号**不携带被读到的文本**、不冒泡、只在真的发生读时才出现；
 *   ③ 它换来的是"过期数据"这类难点可以做成**结构性**的（见上）。
 *   若将来认为指纹风险不可接受，替代做法是让页面**不必**知道"被读"：
 *   把"重新询价"改成一个**必须点击**的按钮 —— 页面只依赖它本来就看得见的 click。
 *
 * 派发本身包在 try 里：页面里存在同名监听器却抛异常时，**不能**因此让"读文本"失败 ——
 * 读取类工具的结果与页面脚本的健壮性无关。
 */
function notifyElementsRead(els) {
  try {
    const list = Array.isArray(els) ? els : [els];
    for (const el of list) {
      if (!el || typeof el.dispatchEvent !== 'function') continue;
      el.dispatchEvent(new CustomEvent('recallflow:element-read', { bubbles: false, detail: { op: 'text' } }));
    }
  } catch (e) { /* 页面监听器抛异常不影响读取结果 */ }
}

function firstTarget(params, includeText = true) {
  const source = params || {};
  // ⚠ **必须把语义定位符一起转发**。
  //
  // `findElementsFor` 支持 ref / role+name / testid / selector / text / index 全套，
  // 而这里原先只转发 ref 与 selector（text 还要调用方额外指定）——
  // 于是 `type_text({role:'textbox', name:'站内搜索'})` 这类**按 schema 说明写的调用**
  // 永远找不到元素，报的却是「未找到可输入的目标元素」：
  // 读起来像"页面上没有这个输入框"，实际是**根本没按这个条件去找**。
  // 模型看到这种错误只会以为页面缺元素，然后换参数乱试或直接放弃。
  //
  // 实测：`cmdClick` 直接传 `findElementsFor(params)` 所以 role+name 一直好用，
  // 而 `cmdTypeText` / `cmdPressKey` / `cmdSelectOption` / `cmdCheckBox` / `cmdGetAttribute`
  // 走的是本函数 —— 同一个页面里"点按钮能用语义定位、填输入框不能"，就是这个原因。
  const target = {
    ref: source.ref,
    role: source.role,
    name: source.name,
    testid: source.testid,
    selector: source.selector,
    index: source.index,
  };
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
//
// ⚠ 必须**穿透 shadow tree** 才判得准。`document.elementFromPoint` 只到 shadow **宿主**
// 为止（它不进入 shadow tree），于是任何 shadow 内的元素都会被判成"被宿主遮挡"。
// 实测后果（做 Shadow DOM 场景时踩到，而且是**静默**的）：
//   · `type_text` 往组件内的输入框打字**直接失败**，报「目标输入元素不可操作（不可见、被遮挡或尚未就绪）」；
//   · `click_element` 看似能用，其实只是靠"被遮挡就改用程序化点击"的兜底，
//     而且反馈里那句「被遮挡」是**假的** —— 它会把模型引向"有东西挡住了"这个错误方向。
// `ShadowRoot` 上也有 `elementFromPoint`，逐层往下钻即可拿到真正的命中元素。
function deepestElementAt(x, y) {
  let el = document.elementFromPoint(x, y);
  let guard = 0;
  // 最多下钻 10 层，防止异常结构造成死循环
  while (el && el.shadowRoot && guard < 10) {
    let inner = null;
    try {
      inner = el.shadowRoot.elementFromPoint(x, y);
    } catch (e) {
      inner = null;
    }
    if (!inner || inner === el) break;
    el = inner;
    guard += 1;
  }
  return el;
}

// node 是否就是 el、或位于 el 的（穿透 shadow 边界的）子树里。
// 为什么不能用 `el.contains(node)`：`contains` **不跨 shadow 边界**，
// 于是"命中元素其实是 el 的 shadow 子节点"这种情况会被误判成遮挡。
function isSelfOrShadowDescendant(node, el) {
  let n = node;
  let guard = 0;
  while (n && guard < 50) {
    if (n === el) return true;
    // ShadowRoot 的 nodeType 是 11，往上要经 host 才能接回宿主所在的树
    n = n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentNode;
    guard += 1;
  }
  return false;
}

function isElementCovered(el) {
  if (!el || !el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const x = rect.left + Math.min(rect.width / 2, 8);
  const y = rect.top + Math.min(rect.height / 2, 8);
  const top = deepestElementAt(x, y);
  if (!top) return false;
  // 命中元素自身、或其（含 shadow）子元素都算可点击；命中无关元素视为被遮挡。
  return !isSelfOrShadowDescendant(top, el);
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
  // contenteditable 的 textContent 会把段落边界压成连续文本；innerText 保留换行。
  // 输入校验必须基于用户实际看到/编辑器实际读到的文本。
  if (el.isContentEditable) return String(el.innerText !== undefined ? el.innerText : el.textContent || '');
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

function selectEditableContents(el) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  } catch (e) {}
}

function placeCaretAtEnd(el) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  } catch (e) {}
}

/**
 * 富文本写入策略。
 *
 * 直接写 `textContent` 会绕过编辑器状态机（ProseMirror/Tiptap 等），
 * 实测会把换行压平、只保留一部分内容，并让卡片出现重复/残留。
 * 优先用浏览器的编辑命令，让页面收到正常的 input/beforeinput；
 * 命令不可用时才退回 DOM 写入，并由调用方按回读结果判定是否真的成功。
 */
function writeContentEditable(el, value, clearFirst) {
  el.focus();
  try {
    if (clearFirst === true) {
      selectEditableContents(el);
      document.execCommand('delete', false, null);
    } else {
      placeCaretAtEnd(el);
    }
    const text = String(value);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        // 单次 insertText 在部分编辑器里会把 \n 规整成空格；逐段插入更可靠。
        const para = document.execCommand('insertParagraph', false, null);
        if (!para) {
          const br = document.execCommand('insertLineBreak', false, null);
          if (!br) document.execCommand('insertText', false, '\n');
        }
      }
      if (lines[i] || i === 0) {
        const ok = document.execCommand('insertText', false, lines[i]);
        if (!ok) throw new Error('insertText 返回 false');
      }
    }
    return 'execCommand-insertText';
  } catch (e) {
    // 最后的兼容路径：不能保证编辑器状态，但至少保持旧的 DOM 写入能力；
    // 返回值会带上 strategy，且调用方会用回读结果做严格判定。
    el.textContent = String(value);
    dispatchInputChange(el, String(value));
    return 'textContent-fallback';
  }
}

async function cmdTypeText(params) {
  // includeText 走默认 true：type_text 的 schema 明确写着
  // 「value 是要输入的文本，text 是用于定位元素的文本片段，两者语义不同」，
  // 所以 text 是**定位符**，必须转发。原先传 false（那是 value/text 尚未拆分时的遗留），
  // 结果是 schema 承诺的 text 定位对 type_text 静默失效。
  const el = firstTarget(params);
  if (!el) return { ok: false, error: '未找到可输入的目标元素' };
  const isEditable = el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
  if (!isEditable) return { ok: false, error: '目标元素不是 input、textarea 或 contenteditable' };
  if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') return { ok: false, error: '目标输入元素不可编辑' };
  if (el.tagName === 'INPUT' && ['file', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) {
    return { ok: false, error: '不支持向该 input 类型输入文本：' + el.type };
  }
  const ready = await ensureActionable(el);
  if (!ready) return { ok: false, error: '目标输入元素不可操作（不可见、被遮挡或尚未就绪）' };
  // 负载取 params.value；`params.text` 只作为**旧宏的兼容回退**。
  // 拆分原因：`text` 曾经同时充当「定位片段」与「输入内容」，导致
  // 「在含某文本的元素里输入」在实现上不可能成立 —— 定位用的是它、要输入的也是它。
  // 现在 text 只用于定位（见 findElementsFor），value 才是输入内容。
  // 旧宏（保存时只有 text）仍能回放，但新记录一律写 value（见 tools.js recordTraceStep）。
  const text = String(
    params.value !== undefined && params.value !== null
      ? params.value
      : params.text === undefined || params.text === null
        ? ''
        : params.text
  );
  const before = editableValue(el) || '';
  const next = params.clearFirst === true ? text : before + text;
  let strategy = 'native-value';
  try {
    el.focus();
    if (el.isContentEditable) {
      strategy = writeContentEditable(el, text, params.clearFirst === true);
    } else {
      setNativeValue(el, next);
      dispatchInputChange(el, text);
    }
  } catch (e) {
    return { ok: false, error: '输入文本失败：' + e.message };
  }
  if (before !== next) {
    pushUndo(() => {
      try {
        if (el.isContentEditable) writeContentEditable(el, before, true);
        else setNativeValue(el, before);
        dispatchInputChange(el, before);
      } catch (e) {}
    });
  }
  // 回读实际值。原先只声称「已清空并输入 N 个字符」，**不回读** —— 于是当最终值出现
  // 意外前缀（实测 `a冒烟测试 smoke-test 123`）时，无法判断是工具没清干净，
  // 还是别处（宏回放里的 press_key？）写进去的。不回读就无法归因，只能靠猜。
  await nextPaint();
  const after = editableValue(el) || '';
  const summary = editableTextSummary(next, after);
  const matched = summary.matchesIntent;
  const clip = (s) => JSON.stringify(String(s).slice(0, 80));
  const result = {
    ok: matched,
    changed: before !== next,
    alreadySatisfied: before === next,
    valuePresent: Boolean(next),
    valueBefore: before,
    valueAfter: after,
    matchesIntent: matched,
    partial: !matched,
    strategy,
    expectedLength: summary.expectedLength,
    actualLength: summary.actualLength,
    firstDifference: summary.firstDifference,
    selector: elementSelector(el),
    result:
      matched
        ? (params.clearFirst === true ? '已清空并输入 ' : '已输入 ') +
          text.length +
          ' 个字符；实际值（' +
          summary.actualLength +
          ' 字符）：' +
          clip(after)
        : '输入未达到预期（strategy=' +
          strategy +
          '）：预期 ' +
          summary.expectedLength +
          ' 字符，实际 ' +
          summary.actualLength +
          ' 字符，首个差异在 ' +
          summary.firstDifference.index +
          '。实际值：' +
          clip(after) +
          '。⚠ 与预期不符 —— 预期为 ' +
          clip(next) +
          '。不要假设已写入，请重读编辑器或改用粘贴/编辑器专用写入。',
  };
  return result;
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
        const current = firstTarget(params);
        const currentText = current
          ? String(current.innerText || current.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160)
          : '';
        const currentCount = findElementsFor(params).length;
        const hint = currentText
          ? '当前命中的元素文本是：' + JSON.stringify(currentText) + '。请核对 text 条件或改用 selector/ref。'
          : describeLookupMiss(params, 3) || '当前没有命中元素；若是自定义组件/异步渲染，请重读快照或改用 selector。';
        finish({
          ok: false,
          matched: false,
          timeout: true,
          currentCount,
          currentText,
          error: '等待元素超时（' + timeoutMs + 'ms）。' + hint,
        });
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
  if (!el) return { ok: false, error: targetMissError(params) };
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
    case 'inspect_element': return cmdInspectElement(params);
    case 'read_styles': return cmdReadStyles(params);
    case 'read_options': return cmdReadOptions(params);
    case 'extract_table': return cmdExtractTable(params);
    case 'query_elements': return cmdQueryElements(params);
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
    // 同样包一层 async：允许 `await`，并保持 `return` 语义。
    // 沙箱仍会被 MV3 扩展 CSP 拦截并自动降级到页面主世界，但契约本身必须正确。
    const fn = new Function(...names, 'return (async () => {\n' + code + '\n})();');
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

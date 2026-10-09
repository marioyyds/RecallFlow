// 页面正文提取 + Agent 感知快照：
// - extractPageText：去噪后的纯文本（供 read_current_page 与 AI 上下文）。
// - extractPageSnapshot：给模型观察/动作验证用的「可交互元素 + 正文」快照。
//   改进点：更全的可交互选择器、视口优先排序、稳定 ref（跨快照复用）、更丰富的状态字段。
import { PAGE_TEXT_EXCLUDE, isPageContentExcluded } from './citation.js';
import { trimElementsToBudget } from '../shared/utils.js';

export function extractPageText(options = {}) {
  // visibleOnly：按真实可见性过滤（见 collectVisibleText 的说明）。
  // 需要判断「某内容是否还看得见」时必须用这个模式。
  if (options && options.visibleOnly) {
    try {
      return collectVisibleText(document.body, { maxChars: 12000 });
    } catch (e) {
      return '';
    }
  }
  try {
    const doc = document.body;
    if (!doc) return '';
    const clone = doc.cloneNode(true);
    clone
      .querySelectorAll(PAGE_TEXT_EXCLUDE)
      .forEach((el) => el.remove());
    let text = clone.innerText || '';
    text = text
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length > 12000) text = text.slice(0, 12000) + '……（页面内容过长，已截断）';
    return text;
  } catch (e) {
    return '';
  }
}

// 不需要走入文本的标签。
const TEXT_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG', 'CANVAS']);
const BLOCKISH_DISPLAY = /^(block|flex|grid|list-item|table|table-row|table-cell|table-caption|flow-root)$/;

function isHiddenForText(el, computedStyle) {
  try {
    // 复用调用方已经取到的计算样式：getComputedStyle 会强制样式解析，
    // 大页面上每个元素取两次是实打实的开销。
    const cs = computedStyle || window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    if (Number(cs.opacity) === 0) return true;
  } catch (e) {
    /* 计算样式取不到时按可见处理，避免整页文本丢失 */
  }
  return false;
}

/**
 * 真正按可见性过滤的文本。
 *
 * 与 extractPageText 的**关键区别**：后者克隆 body 后读 `clone.innerText`，而游离节点没有布局，
 * innerText 会退化成 textContent —— 因此它**包含隐藏节点的文字**。用它判断「广告文案是否还在
 * 屏幕上」必然得出错误结论（这正是此前完成前校验反复误判、并让 Agent 反复返工的根因）。
 *
 * 本函数自上而下遍历，遇到隐藏的祖先即剪掉整棵子树（因此 display:none 的继承能被正确处理），
 * 并穿透开放 shadow root（MSN 等站点的广告常藏在那里）。
 */
export function collectVisibleText(root, options = {}) {
  const parts = [];
  const maxChars = Math.max(200, Number(options.maxChars) || 12000);
  let len = 0;
  let truncated = false;
  const push = (s) => {
    if (!s || truncated) return;
    parts.push(s);
    len += s.length;
    if (len > maxChars) truncated = true;
  };
  const walk = (node) => {
    if (!node || truncated) return;
    if (node.nodeType === 3) {
      const v = String(node.nodeValue || '');
      if (v.trim()) push(v);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    if (TEXT_SKIP_TAGS.has(el.tagName)) return;
    // 必须走穿透 shadow 的判断：closest() 到 ShadowRoot 就停，永远到不了
    // `#__kb-ai-host` 这个宿主，于是本扩展自己的面板会被当成页面正文。
    if (isPageContentExcluded(el)) return;
    let cs = null;
    try {
      cs = window.getComputedStyle(el);
    } catch (e) {}
    if (isHiddenForText(el, cs)) return;
    const display = cs ? cs.display || '' : '';
    const isBlock = BLOCKISH_DISPLAY.test(display);
    // 只在块级边界插入分隔，避免把同一段内的行内文本拆开导致关键词匹配失败。
    if (isBlock) push(' ');
    if (el.shadowRoot) {
      for (const c of el.shadowRoot.childNodes) walk(c);
    }
    for (const c of el.childNodes) walk(c);
    if (isBlock) push(' ');
  };

  const start = root && (root.nodeType === 1 || root.nodeType === 11) ? root : document.body;
  if (start) {
    if (start.nodeType === 1 && start !== document.body) walk(start);
    else for (const c of start.childNodes) walk(c);
  }

  let text = parts
    .join('')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (truncated || text.length > maxChars) text = text.slice(0, maxChars) + '……（可见内容过长，已截断）';
  return text;
}

/**
 * 关键词可见性核查：分别统计「可见文本中出现次数」与「DOM 中出现次数」。
 * 两者不一致即说明该文案仍在 DOM 里但已不可见 —— 这是判断「广告是否真的清干净」的唯一可靠依据。
 * @param {string[]} texts
 * @returns {Array<{text:string, visible:number, dom:number, context:string}>}
 */
export function checkTextVisibility(texts, shared) {
  const list = (Array.isArray(texts) ? texts : [])
    .map((t) => String(t === undefined || t === null ? '' : t).trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!list.length) return [];

  // 允许调用方传入已经遍历好的文本，避免同一请求里重复走两遍 DOM。
  let visibleText = shared && typeof shared.visibleText === 'string' ? shared.visibleText : '';
  let allText = shared && typeof shared.allText === 'string' ? shared.allText : '';
  if (!visibleText && !allText) {
    try {
      visibleText = collectVisibleText(document.body, { maxChars: 40000 });
    } catch (e) {
      visibleText = '';
    }
    try {
      allText = document.body ? String(document.body.textContent || '') : '';
    } catch (e) {
      allText = '';
    }
  }

  const countOf = (hay, needle) => {
    if (!hay || !needle) return 0;
    let n = 0;
    let i = 0;
    for (;;) {
      i = hay.indexOf(needle, i);
      if (i === -1) break;
      n += 1;
      i += needle.length;
    }
    return n;
  };

  return list.map((kw) => {
    const visible = countOf(visibleText, kw);
    const dom = countOf(allText, kw);
    let context = '';
    if (visible > 0) {
      const at = visibleText.indexOf(kw);
      context = visibleText.slice(Math.max(0, at - 30), at + kw.length + 30);
    }
    return { text: kw, visible, dom, context };
  });
}

// 可交互元素：原生控件 + 常见 ARIA role + tabindex + contenteditable + 带 onclick/href 的元素。
// 覆盖复杂组件（下拉菜单项、日期选择器、开关、滑块、树节点、标签页等）。
const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'textarea', 'select', 'summary', 'details > summary',
  'label', 'option',
  '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
  '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
  '[role="option"]', '[role="combobox"]', '[role="listbox"]', '[role="textbox"]',
  '[role="searchbox"]', '[role="spinbutton"]', '[role="slider"]', '[role="treeitem"]',
  '[role="gridcell"]', '[role="row"]', '[role="columnheader"]',
  '[aria-haspopup]', '[aria-expanded]', '[aria-pressed]',
  '[tabindex]:not([tabindex="-1"])',
  '[onclick]',
].join(',');

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'combobox', 'listbox', 'textbox', 'searchbox', 'spinbutton',
  'slider', 'treeitem', 'gridcell', 'row', 'columnheader',
]);

function normalizeSnapshotText(value, max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isVisibleElement(el) {
  if (!el || !el.isConnected || isPageContentExcluded(el)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function cssEscape(value) {
  const text = String(value || '');
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(text);
  return text.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

function selectorUnique(selector) {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch (e) {
    return false;
  }
}

function attributeSelector(el, attr, withTag) {
  const value = el.getAttribute(attr);
  if (!value) return null;
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const tag = withTag ? el.tagName.toLowerCase() : '*';
  return tag + '[' + attr + '="' + escaped + '"]';
}

// 生成尽量短且唯一的 CSS 选择器：唯一 id → 测试/数据属性 → name → 带 class/nth 的路径。
export function elementSelector(el) {
  if (el.id) {
    const byId = '#' + cssEscape(el.id);
    if (selectorUnique(byId)) return byId;
  }
  for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-name', 'name', 'aria-label']) {
    const byAttr = attributeSelector(el, attr, false);
    if (byAttr && selectorUnique(byAttr)) return byAttr;
  }
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement && depth < 8) {
    let part = node.tagName.toLowerCase();
    if (node.classList && node.classList.length) {
      const stableClass = Array.from(node.classList).find((c) => /^[a-zA-Z][a-zA-Z0-9_-]{1,30}$/.test(c));
      if (stableClass) part += '.' + cssEscape(stableClass);
    }
    let index = 1;
    let sibling = node;
    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.tagName === node.tagName) index += 1;
    }
    part += ':nth-of-type(' + index + ')';
    parts.unshift(part);
    depth += 1;
    const candidate = parts.join(' > ');
    if (selectorUnique(candidate)) return candidate;
    node = node.parentElement;
  }
  return parts.join(' > ');
}

// 递归收集可交互元素：穿透同源 iframe 与开放 shadow DOM（跨源 iframe 不可达）。
function collectInteractiveInFrames(root, into = []) {
  try {
    root.querySelectorAll(INTERACTIVE_SELECTOR).forEach((el) => {
      if (isVisibleElement(el)) into.push(el);
    });
  } catch (e) {}
  try {
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) collectInteractiveInFrames(el.shadowRoot, into);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        const doc = el.contentDocument;
        if (doc && doc !== root) collectInteractiveInFrames(doc, into);
      }
    });
  } catch (e) {}
  return into;
}

// ---------------- 稳定 ref 注册表 ----------------
// 同一元素在多次快照间复用同一个 ref，动作时按 ref 取回元素并校验身份；
// 元素被重新渲染（脱离文档）后校验失败，返回 null 让 Agent 重新快照，避免「静默点错」。
let refSeq = 0;
const refToEl = new Map(); // ref -> WeakRef<Element>
const elToRef = new WeakMap(); // Element -> ref
const refFingerprint = new Map(); // ref -> 指纹字符串

// 身份指纹：只用稳定属性（不用 textContent，避免计时器等动态文本导致 ref 频繁失效）。
// ref 本身已由 WeakRef 绑定到具体元素对象，这里再校验属性结构，防虚拟列表复用节点。
function fingerprintEl(el) {
  return [
    el.tagName,
    el.getAttribute('role') || '',
    el.getAttribute('type') || '',
    el.id || '',
    el.getAttribute('name') || '',
    el.getAttribute('aria-label') || '',
  ].join('|');
}

function refFor(el) {
  let ref = elToRef.get(el);
  const fp = fingerprintEl(el);
  if (ref && refToEl.has(ref)) {
    const cur = refToEl.get(ref).deref && refToEl.get(ref).deref();
    if (cur === el) {
      refFingerprint.set(ref, fp);
      return ref;
    }
  }
  ref = 'rf-' + (++refSeq);
  elToRef.set(el, ref);
  try {
    refToEl.set(ref, new WeakRef(el));
  } catch (e) {
    // 不支持 WeakRef 时退化为强引用（旧浏览器）。
    refToEl.set(ref, { deref: () => el });
  }
  refFingerprint.set(ref, fp);
  return ref;
}

function pruneRefs() {
  for (const [ref, holder] of refToEl) {
    const el = holder && holder.deref ? holder.deref() : null;
    if (!el || !el.isConnected) {
      refToEl.delete(ref);
      refFingerprint.delete(ref);
    }
  }
}

// 同一元素的绝对视口坐标（含同源 iframe 偏移），供 CDP 按坐标点击。
export function absoluteRect(el) {
  const r = el.getBoundingClientRect();
  let x = r.x;
  let y = r.y;
  try {
    let win = el.ownerDocument && el.ownerDocument.defaultView;
    while (win && win !== window && win.frameElement) {
      const fr = win.frameElement.getBoundingClientRect();
      x += fr.x;
      y += fr.y;
      win = win.parent;
    }
  } catch (e) {}
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(r.width),
    height: Math.round(r.height),
    centerX: Math.round(x + r.width / 2),
    centerY: Math.round(y + r.height / 2),
  };
}

function inViewport(rect) {
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
}

function hashSnapshot(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function describeElement(el, index) {
  const rect = el.getBoundingClientRect();
  const abs = absoluteRect(el);
  const label = normalizeSnapshotText(
    el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') ||
    el.getAttribute('alt') || el.innerText || el.textContent || el.getAttribute('name') || '',
    180
  );
  return {
    ref: refFor(el),
    index: index + 1,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || '',
    type: el.getAttribute('type') || '',
    label,
    name: el.getAttribute('name') || '',
    placeholder: el.getAttribute('placeholder') || '',
    href: el.tagName === 'A' ? normalizeSnapshotText(el.getAttribute('href'), 120) : undefined,
    selector: elementSelector(el),
    disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    checked: typeof el.checked === 'boolean' ? el.checked : undefined,
    expanded: el.hasAttribute('aria-expanded') ? el.getAttribute('aria-expanded') === 'true' : undefined,
    hasPopup: el.getAttribute('aria-haspopup') || undefined,
    valuePresent: ['INPUT', 'TEXTAREA'].includes(el.tagName) ? Boolean(el.value) : undefined,
    selectedIndex: el.tagName === 'SELECT' ? el.selectedIndex : undefined,
    selectedLabel: el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]
      ? normalizeSnapshotText(el.selectedOptions[0].textContent, 120)
      : undefined,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    center: { x: abs.centerX, y: abs.centerY },
    inViewport: inViewport(rect),
  };
}

/**
 * 生成供 Agent 观察和动作验证使用的轻量 DOM 快照。
 * 视口内的元素优先展示（不再从 DOM 头部截断），并给出绝对坐标供 CDP 按坐标操作。
 * 不包含 input.value / textarea.value，避免把密码和用户输入带回模型。
 */
// 推断「正文容器」：用于提醒 Agent 不要整体隐藏它。
// 背景：曾出现把同时包含推荐流与文章正文的容器整体 display:none，结果连正文一起隐藏，
// 只能事后恢复。给出正文容器的选择器与字数，能让 Agent 在动手前避开它。
export function findMainContent() {
  const candidates = [];
  try {
    document
      .querySelectorAll('article,main,[role="main"],#content,.article-body,.post-content,.entry-content,.content')
      .forEach((el) => candidates.push(el));
  } catch (e) {}
  if (!candidates.length) {
    try {
      const kids = document.body ? Array.from(document.body.children) : [];
      let best = null;
      let bestLen = 0;
      for (const k of kids) {
        const len = String(k.textContent || '').length;
        if (len > bestLen) {
          bestLen = len;
          best = k;
        }
      }
      if (best) candidates.push(best);
    } catch (e) {}
  }
  let winner = null;
  for (const el of candidates) {
    const len = String(el.textContent || '').length;
    if (!winner || len > winner.len) winner = { el, len };
  }
  // 字数太少说明没抓到真正的正文，宁可不报也不要误报。
  if (!winner || winner.len < 300) return null;
  let selector = '';
  try {
    selector = elementSelector(winner.el);
  } catch (e) {
    selector = '';
  }
  return {
    selector,
    tag: winner.el.tagName.toLowerCase(),
    textLength: winner.len,
    note: '疑似正文容器。隐藏广告/推广时不要整体隐藏它或它的祖先，否则会连正文一起隐藏。',
  };
}

/**
 * 一次性读出「正文文本」与「关键词可见性」，DOM 只遍历一遍。
 * 分开调用 extractPageText({visibleOnly}) 与 checkTextVisibility() 会走两遍全树，
 * 而每一遍都要对每个元素取计算样式 —— 大页面上这是明显的浪费。
 * @param {string[]} texts 要核查的关键词（空数组表示不核查）
 * @param {{visibleOnly?: boolean}} options
 * @returns {{text: string, visibility: Array|null}}
 */
export function readTextWithVisibility(texts, options = {}) {
  const wantCheck = Array.isArray(texts) && texts.length > 0;
  const wantVisible = options.visibleOnly === true;
  let visibleText = '';
  if (wantCheck || wantVisible) {
    try {
      visibleText = collectVisibleText(document.body, { maxChars: 40000 });
    } catch (e) {
      visibleText = '';
    }
  }
  let visibility = null;
  if (wantCheck) {
    let allText = '';
    try {
      allText = document.body ? String(document.body.textContent || '') : '';
    } catch (e) {
      allText = '';
    }
    visibility = checkTextVisibility(texts, { visibleText, allText });
  }
  const text = wantVisible ? visibleText.slice(0, 12000) : extractPageText();
  return { text, visibility };
}

// 跨 shadow 边界的父节点：parentElement 在 shadow root 边界处会返回 null。
export function parentCrossingShadow(el) {
  if (!el) return null;
  if (el.parentElement) return el.parentElement;
  try {
    const root = el.getRootNode();
    if (root && root.host) return root.host;
  } catch (e) {}
  return null;
}

function segmentOf(el, maxSegLen) {
  const tag = String(el.tagName || '').toLowerCase();
  const id = el.id ? '#' + String(el.id).slice(0, 24) : '';
  let cls = '';
  try {
    const list = Array.from(el.classList || []).filter(Boolean).slice(0, 2);
    cls = list.length ? '.' + list.join('.') : '';
  } catch (e) {}
  const seg = tag + id + cls;
  return seg.length > maxSegLen ? seg.slice(0, maxSegLen) : seg;
}

// 紧凑祖先链（跨 shadow 边界）。让模型直接看出「这些元素共同属于哪个容器」，
// 不必再写 run_javascript 逐层查 parentElement —— 那类探查一次就能多出十几轮往返。
export function ancestorPath(el, maxLevels = 4, maxSegLen = 32) {
  const segs = [];
  let cur = parentCrossingShadow(el);
  let guard = 0;
  while (cur && cur !== document.body && cur !== document.documentElement && guard < 12) {
    segs.unshift(segmentOf(cur, maxSegLen));
    if (segs.length >= maxLevels) break;
    cur = parentCrossingShadow(cur);
    guard += 1;
  }
  return segs.join(' > ');
}

// 元素处在第几层 shadow root 内（0 = 不在 shadow 内）。MSN 这类站点的广告常藏在这里。
export function shadowDepth(el) {
  let depth = 0;
  let cur = el;
  let guard = 0;
  while (cur && guard < 20) {
    let root = null;
    try {
      root = cur.getRootNode();
    } catch (e) {}
    if (root && root.host) {
      depth += 1;
      cur = root.host;
    } else break;
    guard += 1;
  }
  return depth;
}

/**
 * 元素是否真的渲染出来了（含被隐藏祖先的情况 —— 靠 rect 为 0 兜住）。
 * 与 isVisibleElement 的区别：这里不看 PAGE_TEXT_EXCLUDE（那是「是否参与正文抽取」的语义），
 * 专门用来回答「这个广告位到底还看不看得见」。
 */
export function isElementRendered(el) {
  if (!el || !el.isConnected) return false;
  try {
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (Number(cs.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  } catch (e) {
    return true;
  }
}

export function extractPageSnapshot(options = {}) {
  try {
    const body = document.body;
    if (!body) return { version: 2, url: location.href, title: document.title || '', elements: [], text: '', fingerprint: 'empty' };
    pruneRefs();
    const maxElements = Math.min(150, Math.max(1, Number(options.maxElements) || 60));
    const maxText = Math.min(8000, Math.max(500, Number(options.maxText) || 4000));
    const nodes = collectInteractiveInFrames(document);
    // 视口优先：在视口内 → 距离视口中心越近越靠前；视口外 → 距离越近越靠前。
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const cx = vw / 2;
    const cy = vh / 2;
    const ranked = nodes
      .map((el) => {
        const r = el.getBoundingClientRect();
        const visible = inViewport(r);
        const dx = Math.max(0, Math.max(r.left - vw, -r.right));
        const dy = Math.max(0, Math.max(r.top - vh, -r.bottom));
        const dist = Math.hypot(dx, dy);
        const inViewDist = Math.hypot(r.x + r.width / 2 - cx, r.y + r.height / 2 - cy);
        return { el, visible, sortKey: visible ? inViewDist : 1e6 + dist };
      })
      .sort((a, b) => a.sortKey - b.sortKey)
      .slice(0, maxElements)
      .map((x) => x.el);
    // 全部入围元素都算描述：ref 的发放顺序与指纹覆盖面都不因体积裁剪而改变。
    const describedAll = ranked.map((el, index) => describeElement(el, index));
    const text = extractPageText().slice(0, maxText);
    // 体积预算：见 SNAPSHOT_CHAR_BUDGET 与 trimElementsToBudget 的说明。
    const { elements, omittedBySize } = trimElementsToBudget(describedAll, text.length);
    const snapshot = {
      version: 2,
      url: location.href,
      title: document.title || '',
      text,
      elements,
      mainContent: findMainContent(),
      counts: {
        interactive: nodes.length,
        shown: elements.length,
        omittedBySize,
        inViewport: elements.filter((e) => e.inViewport).length,
        forms: document.forms ? document.forms.length : 0,
        headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
      },
      scroll: {
        x: Math.round(window.scrollX || 0),
        y: Math.round(window.scrollY || 0),
        height: Math.round(document.documentElement.scrollHeight || 0),
        viewport: Math.round(window.innerHeight || 0),
      },
    };
    // 指纹忽略坐标和动态 ref，只关注页面可观察内容及元素结构。
    // 刻意覆盖**全部**入围元素（describedAll）且不把体积裁剪相关的计数算进去：
    // 否则同一次动作前后两次快照的裁剪边界一旦不同，指纹就会因为「省略了几个」
    // 而变化，被 verifyPageAction 误判成页面内容变了。
    snapshot.fingerprint = hashSnapshot(JSON.stringify({
      url: snapshot.url,
      title: snapshot.title,
      text: snapshot.text,
      elements: describedAll.map((e) => [e.tag, e.role, e.type, e.label, e.selector, e.disabled, e.checked, e.valuePresent, e.selectedIndex, e.selectedLabel]),
      counts: {
        interactive: nodes.length,
        inViewport: describedAll.filter((e) => e.inViewport).length,
        forms: document.forms ? document.forms.length : 0,
        headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
      },
    }));
    return snapshot;
  } catch (e) {
    return { version: 2, url: location.href, title: document.title || '', elements: [], text: '', fingerprint: 'error', error: e.message };
  }
}

// 按 ref 取回元素：校验元素仍在文档且指纹未变，否则返回 null（让 Agent 重新快照）。
export function getInteractiveElementByRef(ref) {
  const key = String(ref || '').trim();
  const holder = refToEl.get(key);
  const el = holder && holder.deref ? holder.deref() : null;
  if (el && el.isConnected && refFingerprint.get(key) === fingerprintEl(el)) return el;
  return null;
}

export function getRefFingerprint(ref) {
  return refFingerprint.get(String(ref || '').trim()) || null;
}

export function resolveElementRef(el) {
  return el ? refFor(el) : null;
}

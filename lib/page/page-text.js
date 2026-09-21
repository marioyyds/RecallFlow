// 页面正文提取 + Agent 感知快照：
// - extractPageText：去噪后的纯文本（供 read_current_page 与 AI 上下文）。
// - extractPageSnapshot：给模型观察/动作验证用的「可交互元素 + 正文」快照。
//   改进点：更全的可交互选择器、视口优先排序、稳定 ref（跨快照复用）、更丰富的状态字段。
import { PAGE_TEXT_EXCLUDE } from './citation.js';

export function extractPageText() {
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
  if (!el || !el.isConnected || el.closest(PAGE_TEXT_EXCLUDE)) return false;
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
    const elements = ranked.map((el, index) => describeElement(el, index));
    const text = extractPageText().slice(0, maxText);
    const snapshot = {
      version: 2,
      url: location.href,
      title: document.title || '',
      text,
      elements,
      counts: {
        interactive: nodes.length,
        shown: elements.length,
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
    snapshot.fingerprint = hashSnapshot(JSON.stringify({
      url: snapshot.url,
      title: snapshot.title,
      text: snapshot.text,
      elements: elements.map((e) => [e.tag, e.role, e.type, e.label, e.selector, e.disabled, e.checked, e.valuePresent, e.selectedIndex, e.selectedLabel]),
      counts: snapshot.counts,
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

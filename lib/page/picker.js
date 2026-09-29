// 元素拾取模式：进入后鼠标移动高亮候选元素，点击确认并返回一组拾取结果：
// [{ selector, locator, tag, label, text, attributes, ancestors, inShadow, source }]。
// 选取：每次点击把元素加入选区（可多选）；Esc / Enter 结束并提交；Esc 在未选任何元素时取消。
// 键盘：↑ 选父元素、↓ 选子元素、Enter 完成、Esc 结束/取消。
// 高亮为 DevTools 风格盒模型（内容蓝 / 内边距绿 / 外边距橙）+ 尺寸与标签提示。
import { elementSelector } from './page-text.js';
import { getElementSource } from './debug-capture.js';
import { roleOf, accessibleName } from './commands.js';

let active = false;
let overlayMargin = null;
let overlayPadding = null;
let overlayContent = null;
let tooltip = null;
let currentEl = null;
let selection = [];
let onPickCb = null;
let onCancelCb = null;
let savedCursor = '';
let lastX = 0;
let lastY = 0;
let rafId = 0;

function isOwnNode(el) {
  if (!el || el === overlayMargin || el === overlayPadding || el === overlayContent || el === tooltip) return true;
  try {
    return !!(el.closest && el.closest('#__kb-ai-host'));
  } catch (e) {
    return false;
  }
}

// DevTools 风格盒模型：内容(蓝) / 内边距(绿) / 外边距(橙) 三层叠加。
function ensureOverlay() {
  if (overlayContent && overlayContent.isConnected) return;
  const mk = (bg, extra) => {
    const d = document.createElement('div');
    d.style.cssText =
      'position:fixed;z-index:2147483645;pointer-events:none;box-sizing:border-box;border-radius:2px;display:none;' +
      'background:' + bg + ';' + (extra || '');
    return d;
  };
  overlayMargin = mk('rgba(246,178,107,.35)');
  overlayPadding = mk('rgba(147,196,125,.42)');
  overlayContent = mk('rgba(111,168,220,.50)', 'box-shadow:inset 0 0 0 1px rgba(26,115,232,.85);');
  tooltip = document.createElement('div');
  tooltip.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;background:#1f2937;color:#fff;' +
    'font:12px/1.5 Consolas,"Cascadia Code",monospace;padding:3px 8px;border-radius:6px;' +
    'max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;';
  document.documentElement.appendChild(overlayMargin);
  document.documentElement.appendChild(overlayPadding);
  document.documentElement.appendChild(overlayContent);
  document.documentElement.appendChild(tooltip);
}

function removeOverlay() {
  if (overlayMargin) { overlayMargin.remove(); overlayMargin = null; }
  if (overlayPadding) { overlayPadding.remove(); overlayPadding = null; }
  if (overlayContent) { overlayContent.remove(); overlayContent = null; }
  if (tooltip) { tooltip.remove(); tooltip = null; }
}

function setBox(node, box) {
  if (!node) return;
  node.style.display = '';
  node.style.left = box.x + 'px';
  node.style.top = box.y + 'px';
  node.style.width = Math.max(0, box.w) + 'px';
  node.style.height = Math.max(0, box.h) + 'px';
}

// 由 rect（border box）+ computedStyle 推出 margin/border/padding/content 四个盒子。
function boxModel(el) {
  const r = el.getBoundingClientRect();
  let cs;
  try { cs = window.getComputedStyle(el); } catch (e) { cs = null; }
  const num = (v) => (parseFloat(v) || 0);
  const bt = cs ? num(cs.borderTopWidth) : 0;
  const br = cs ? num(cs.borderRightWidth) : 0;
  const bb = cs ? num(cs.borderBottomWidth) : 0;
  const bl = cs ? num(cs.borderLeftWidth) : 0;
  const pt = cs ? num(cs.paddingTop) : 0;
  const pr = cs ? num(cs.paddingRight) : 0;
  const pb = cs ? num(cs.paddingBottom) : 0;
  const pl = cs ? num(cs.paddingLeft) : 0;
  const mt = cs ? num(cs.marginTop) : 0;
  const mr = cs ? num(cs.marginRight) : 0;
  const mb = cs ? num(cs.marginBottom) : 0;
  const ml = cs ? num(cs.marginLeft) : 0;
  return {
    marginBox: { x: r.left - ml, y: r.top - mt, w: r.width + ml + mr, h: r.height + mt + mb },
    borderBox: { x: r.left, y: r.top, w: r.width, h: r.height },
    paddingBox: { x: r.left + bl, y: r.top + bt, w: r.width - bl - br, h: r.height - bt - bb },
    contentBox: { x: r.left + bl + pl, y: r.top + bt + pt, w: r.width - bl - br - pl - pr, h: r.height - bt - bb - pt - pb },
  };
}

function elementAt(e) {
  let el = null;
  try {
    const path = e.composedPath ? e.composedPath() : null;
    el = path && path.length ? path[0] : e.target;
  } catch (err) {
    el = e.target;
  }
  if (el && el.nodeType === 3) el = el.parentElement;
  if (!el || el.nodeType !== 1 || isOwnNode(el)) return null;
  return el;
}

// 交互/语义元素判定：原生控件 + 交互类 role + onclick/tabindex/contenteditable。
// 注意只认「交互类」role（button/link/…），不认 main/navigation 等地标 role，避免吸附到整块容器。
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'details', 'option', 'output']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'combobox', 'listbox', 'textbox', 'searchbox', 'spinbutton',
  'slider', 'treeitem', 'gridcell', 'row', 'columnheader',
]);
function isInteractiveEl(el) {
  if (!el || el.nodeType !== 1) return false;
  if (INTERACTIVE_TAGS.has(el.tagName.toLowerCase())) return true;
  try {
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.hasAttribute('tabindex')) return true;
    if (el.isContentEditable) return true;
  } catch (e) {}
  return false;
}

// 把最内层元素吸附到最近的交互/语义祖先（避免点到 button 里的 span/svg 选错）；
// 本身就是交互元素、或找不到祖先时保持原元素。想选更内层可用 ↓ 下钻。
function resolvePickTarget(el) {
  if (!el) return el;
  if (isInteractiveEl(el)) return el;
  let n = el.parentElement;
  let depth = 0;
  while (n && n !== document.body && depth < 6) {
    if (isInteractiveEl(n)) return n;
    n = n.parentElement;
    depth += 1;
  }
  return el;
}

// 选第一个有可见盒子的子元素（供 ↓ 键下钻）。
function pickChild(el) {
  if (!el || !el.children) return null;
  for (const c of el.children) {
    if (isOwnNode(c)) continue;
    const r = c.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return c;
  }
  return null;
}

function ancestorPath(el) {
  const out = [];
  let n = el && el.parentElement;
  let depth = 0;
  while (n && n !== document.documentElement && depth < 4) {
    const t = n.tagName ? n.tagName.toLowerCase() : '';
    const id = n.id ? '#' + n.id : '';
    const cls = n.classList && n.classList.length ? '.' + Array.from(n.classList)[0] : '';
    out.unshift(t + id + cls);
    n = n.parentElement;
    depth += 1;
  }
  return out;
}

function describe(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  const id = el.id ? '#' + el.id : '';
  const cls = el.classList && el.classList.length ? '.' + Array.from(el.classList).slice(0, 2).join('.') : '';
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const ariaLabel = el.getAttribute ? el.getAttribute('aria-label') || '' : '';
  const label =
    ariaLabel ||
    (el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt'))) ||
    text;
  return { tag, name: tag + id + cls, label: String(label || '').slice(0, 120), text };
}

// 稳健定位链：role+name / testid / text / css，供 AI 优先用语义定位。
function buildLocator(el) {
  let role = '';
  let name = '';
  try { role = roleOf(el) || ''; } catch (e) {}
  try { name = String(accessibleName(el) || '').slice(0, 80); } catch (e) {}
  const testid =
    (el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test') || el.getAttribute('data-cy') || el.getAttribute('data-name'))) || '';
  const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  let css = '';
  try { css = elementSelector(el); } catch (e) {}
  return { role, name, testid, text, css };
}

function collect(el) {
  const d = describe(el);
  const locator = buildLocator(el);
  const attributes = {};
  for (const a of ['id', 'class', 'name', 'type', 'role', 'href', 'placeholder', 'aria-label', 'aria-expanded', 'data-testid']) {
    const v = el.getAttribute && el.getAttribute(a);
    if (v) attributes[a] = String(v).slice(0, 120);
  }
  let inShadow = false;
  try { inShadow = el.getRootNode() !== document; } catch (e) {}
  return {
    selector: locator.css || '',
    locator,
    tag: d.tag,
    label: d.label,
    text: d.text,
    attributes,
    ancestors: ancestorPath(el),
    inShadow,
    source: null,
  };
}

function placeTooltip(x, y) {
  if (!tooltip) return;
  const tw = tooltip.offsetWidth || 160;
  const th = tooltip.offsetHeight || 22;
  let tx = x + 12;
  let ty = y + 16;
  if (tx + tw > window.innerWidth - 8) tx = x - tw - 12;
  if (ty + th > window.innerHeight - 8) ty = y - th - 12;
  tooltip.style.left = Math.max(4, tx) + 'px';
  tooltip.style.top = Math.max(4, ty) + 'px';
}

function paint(el, x, y) {
  if (!overlayContent || !el) return;
  const r = el.getBoundingClientRect();
  const b = boxModel(el);
  setBox(overlayMargin, b.marginBox);
  setBox(overlayPadding, b.borderBox); // 边框 + 内边距区域
  setBox(overlayContent, b.contentBox);
  const d = describe(el);
  let role = '';
  try { role = roleOf(el) || ''; } catch (e) {}
  tooltip.style.display = '';
  const size = Math.round(r.width) + '×' + Math.round(r.height);
  const base = d.name + (role ? ' [' + role + ']' : '') + '  ' + size + (d.label ? '  · ' + d.label : '');
  const hint = selection.length
    ? '已选 ' + selection.length + ' 个 · 继续点击添加 · Esc 完成'
    : '点击选择（可多选）· ↑↓ 选父/子 · Esc 完成';
  tooltip.textContent = base + '　—　' + hint;
  placeTooltip(x, y);
}

function onMove(e) {
  if (!active) return;
  lastX = e.clientX;
  lastY = e.clientY;
  const el = elementAt(e);
  if (!el) return;
  currentEl = resolvePickTarget(el);
  if (rafId) return; // rAF 节流：每帧最多重绘一次
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (active && currentEl) paint(currentEl, lastX, lastY);
  });
}

async function finishWith(list) {
  stop();
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!arr.length) {
    if (onCancelCb) onCancelCb();
    return;
  }
  for (const p of arr) {
    let source = null;
    try { source = await getElementSource(p.selector); } catch (e) {}
    p.source = source || null;
  }
  if (onPickCb) onPickCb(arr);
}

function onClick(e) {
  if (!active) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  const el = resolvePickTarget(elementAt(e) || currentEl);
  if (!el) return;
  // 每次点击把元素加入选区（按选择器去重），继续拾取，直到 Esc / Enter 结束。
  const p = collect(el);
  if (!p.selector || !selection.some((s) => s.selector === p.selector)) selection.push(p);
  paint(el, e.clientX, e.clientY);
}

// 消费按键：阻止默认行为 + 阻止冒泡 + 阻止同节点后续监听（如面板的 Esc 关闭）。
function consumeKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
}

function onKey(e) {
  if (!active) return;
  if (e.key === 'Escape') {
    consumeKey(e);
    // 有选区 → 结束并提交；没有选区 → 视为取消。
    if (selection.length) finishWith(selection);
    else {
      stop();
      if (onCancelCb) onCancelCb();
    }
    return;
  }
  if (e.key === 'ArrowUp') {
    consumeKey(e);
    if (currentEl && currentEl.parentElement && !isOwnNode(currentEl.parentElement)) {
      currentEl = currentEl.parentElement;
      paint(currentEl, lastX, lastY);
    }
    return;
  }
  if (e.key === 'ArrowDown') {
    consumeKey(e);
    const c = pickChild(currentEl);
    if (c) {
      currentEl = c;
      paint(c, lastX, lastY);
    }
    return;
  }
  if (e.key === 'Enter') {
    consumeKey(e);
    if (selection.length) finishWith(selection);
    else if (currentEl) finishWith([collect(currentEl)]);
  }
}

export function isPickerActive() {
  return active;
}

export function startPicker(onPick, onCancel) {
  if (active) stop();
  ensureOverlay();
  active = true;
  selection = [];
  onPickCb = onPick || null;
  onCancelCb = onCancel || null;
  currentEl = null;
  lastX = window.innerWidth / 2;
  lastY = window.innerHeight / 2;
  savedCursor = document.documentElement.style.cursor || '';
  document.documentElement.style.cursor = 'crosshair';
  // 挂在 window 捕获阶段：比 document/页面监听更早，尽量拦截页面自身的点击/按键副作用。
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
}

export function stopPicker() {
  stop();
}

function stop() {
  if (active) {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    document.documentElement.style.cursor = savedCursor || '';
  }
  active = false;
  selection = [];
  currentEl = null;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  removeOverlay();
}

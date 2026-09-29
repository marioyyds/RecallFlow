// 元素拾取模式：进入后鼠标移动高亮候选元素，点击确认并返回一组拾取结果：
// [{ selector, locator, tag, label, text, attributes, ancestors, inShadow, source }]。
//
// 交互：
// - 点击        加入选区（按选择器去重，重复点击有提示）；多选后继续拾取
// - Esc         有选区 → 提交；无选区 → 取消
// - Enter       同 Esc（无选区时提交当前悬停元素）
// - ↑ / ↓       选父元素 / 下钻到鼠标所在子元素
// - ⌫ / Delete  撤销最后一次选择
// - 右键        有选区 → 提交；无选区 → 取消（并屏蔽浏览器菜单）
// - 滚动 / 缩放 高亮实时跟随（overlay 是 fixed，不跟随就会「粘」在原地）
//
// 高亮为 DevTools 风格盒模型（内容蓝 / 内边距绿 / 外边距橙）+ 尺寸与标签提示。
// 性能：mousemove 每秒可触发 60~120 次，因此与滚动无关的派生数据（盒模型尺寸、
// role、文案）按元素缓存，悬停路径用 textContent 而非 innerText（后者会强制布局），
// 浮层尺寸只在文案变化时量一次。
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
// 悬停缓存：每次 mousemove 都重算 innerText / getComputedStyle / roleOf 是实打实的开销，
// 而 mousemove 每秒可触发 60~120 次。这里只缓存「与滚动无关」的派生数据，
// 矩形每帧重算（滚动会改变它），因此缓存不会失效。
let hoverCache = new WeakMap();
let cursorStyleEl = null;
let tooltipSize = { w: 0, h: 0 };
// 一次性提示（如「该元素已在选区中」）：由 paint 合并进文案，移动鼠标后自动清除，
// 否则会被紧接着的 paint 覆盖掉、用户看不到任何反馈。
let transientHint = '';

// 跨 shadow 边界的父节点：parentElement 在 shadow root 边界返回 null，
// 而 Web Component 里的按钮（如 <cs-card> 内部）恰恰需要跨过这一层才能吸附到宿主。
function parentCrossingShadow(el) {
  if (!el) return null;
  if (el.parentElement) return el.parentElement;
  try {
    const root = el.getRootNode();
    if (root && root.host) return root.host;
  } catch (e) {}
  return null;
}

// 强制十字光标：只改 documentElement.style.cursor 会被页面自身样式
// （如 a{cursor:pointer}）覆盖，导致悬停在链接上时光标不再是十字。
function ensureCursorStyle() {
  if (cursorStyleEl && cursorStyleEl.isConnected) return;
  cursorStyleEl = document.createElement('style');
  cursorStyleEl.textContent = '*{cursor:crosshair !important;}';
  document.documentElement.appendChild(cursorStyleEl);
}
function removeCursorStyle() {
  if (cursorStyleEl && cursorStyleEl.parentNode) cursorStyleEl.parentNode.removeChild(cursorStyleEl);
  cursorStyleEl = null;
}

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

// 由 rect（border box）+ 缓存的盒模型尺寸推出四个盒子。
// 尺寸（border/padding/margin 宽度）与滚动无关，可缓存；矩形每帧重算。
function boxMetrics(el) {
  let cs;
  try { cs = window.getComputedStyle(el); } catch (e) { cs = null; }
  const num = (v) => (parseFloat(v) || 0);
  return {
    bt: cs ? num(cs.borderTopWidth) : 0,
    br: cs ? num(cs.borderRightWidth) : 0,
    bb: cs ? num(cs.borderBottomWidth) : 0,
    bl: cs ? num(cs.borderLeftWidth) : 0,
    pt: cs ? num(cs.paddingTop) : 0,
    pr: cs ? num(cs.paddingRight) : 0,
    pb: cs ? num(cs.paddingBottom) : 0,
    pl: cs ? num(cs.paddingLeft) : 0,
    mt: cs ? num(cs.marginTop) : 0,
    mr: cs ? num(cs.marginRight) : 0,
    mb: cs ? num(cs.marginBottom) : 0,
    ml: cs ? num(cs.marginLeft) : 0,
  };
}

function boxesFrom(r, m) {
  return {
    marginBox: { x: r.left - m.ml, y: r.top - m.mt, w: r.width + m.ml + m.mr, h: r.height + m.mt + m.mb },
    borderBox: { x: r.left, y: r.top, w: r.width, h: r.height },
    paddingBox: { x: r.left + m.bl, y: r.top + m.bt, w: r.width - m.bl - m.br, h: r.height - m.bt - m.bb },
    contentBox: { x: r.left + m.bl + m.pl, y: r.top + m.bt + m.pt, w: r.width - m.bl - m.br - m.pl - m.pr, h: r.height - m.bt - m.bb - m.pt - m.pb },
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
  let n = parentCrossingShadow(el);
  let depth = 0;
  while (n && n !== document.body && depth < 6) {
    if (isInteractiveEl(n)) return n;
    n = parentCrossingShadow(n);
    depth += 1;
  }
  return el;
}

// 优先取「鼠标当前所在」的子元素（符合 DevTools 直觉），否则取第一个有可见盒子的子元素。
// 同时下探开放 shadow root —— Web Component 的内容都在里面。
function visibleChild(c) {
  if (!c || c.nodeType !== 1 || isOwnNode(c)) return null;
  const r = c.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? c : null;
}

function pickChild(el, x, y) {
  if (!el) return null;
  // 1) 阴影根优先：宿主的可见内容通常在里面
  try {
    if (el.shadowRoot && el.shadowRoot.children) {
      for (const c of el.shadowRoot.children) {
        const hit = visibleChild(c);
        if (!hit) continue;
        if (x == null || y == null) return hit;
        const r = hit.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return hit;
      }
    }
  } catch (e) {}
  if (!el.children) return null;
  // 2) 命中鼠标位置的子元素
  if (x != null && y != null) {
    for (const c of el.children) {
      const hit = visibleChild(c);
      if (!hit) continue;
      const r = hit.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return hit;
    }
  }
  // 3) 退化为第一个可见子元素
  for (const c of el.children) {
    const hit = visibleChild(c);
    if (hit) return hit;
  }
  return null;
}

function ancestorPath(el) {
  const out = [];
  let n = parentCrossingShadow(el);
  let depth = 0;
  while (n && n !== document.documentElement && depth < 4) {
    const t = n.tagName ? n.tagName.toLowerCase() : '';
    const id = n.id ? '#' + n.id : '';
    const cls = n.classList && n.classList.length ? '.' + Array.from(n.classList)[0] : '';
    out.unshift(t + id + cls);
    n = parentCrossingShadow(n);
    depth += 1;
  }
  return out;
}

// cheap=true 时用 textContent 而非 innerText：
// innerText 会强制浏览器做一次布局，在 mousemove 高频路径上代价极高；
// 只有真正要落库的「点击采集」才需要 innerText 的渲染后文本。
function describe(el, cheap) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  const id = el.id ? '#' + el.id : '';
  const cls = el.classList && el.classList.length ? '.' + Array.from(el.classList).slice(0, 2).join('.') : '';
  const rawText = cheap ? el.textContent : el.innerText || el.textContent;
  const text = (rawText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
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

// 与滚动无关的悬停信息，按元素缓存（mousemove 高频路径上只做一次）。
function hoverInfo(el) {
  let c = hoverCache.get(el);
  if (c) return c;
  const d = describe(el, true);
  let role = '';
  try { role = roleOf(el) || ''; } catch (e) {}
  c = { name: d.name, role, label: d.label, metrics: boxMetrics(el) };
  hoverCache.set(el, c);
  return c;
}

function hideOverlay() {
  if (overlayContent) overlayContent.style.display = 'none';
  if (overlayPadding) overlayPadding.style.display = 'none';
  if (overlayMargin) overlayMargin.style.display = 'none';
  if (tooltip) tooltip.style.display = 'none';
}

// 用缓存的浮层尺寸定位，避免每帧读 offsetWidth/offsetHeight（强制布局）。
function placeTooltip(x, y) {
  if (!tooltip) return;
  const tw = tooltipSize.w || 160;
  const th = tooltipSize.h || 22;
  let tx = x + 12;
  let ty = y + 16;
  if (tx + tw > window.innerWidth - 8) tx = x - tw - 12;
  if (ty + th > window.innerHeight - 8) ty = y - th - 12;
  tooltip.style.left = Math.max(4, tx) + 'px';
  tooltip.style.top = Math.max(4, ty) + 'px';
}

function paint(el, x, y) {
  if (!overlayContent || !el) return;
  // 矩形每帧重算（滚动会改变它），其余派生数据走缓存。
  const r = el.getBoundingClientRect();
  const info = hoverInfo(el);
  const b = boxesFrom(r, info.metrics);
  setBox(overlayMargin, b.marginBox);
  setBox(overlayPadding, b.borderBox);
  setBox(overlayContent, b.contentBox);
  const size = Math.round(r.width) + '×' + Math.round(r.height);
  const base = info.name + (info.role ? ' [' + info.role + ']' : '') + '  ' + size + (info.label ? '  · ' + info.label : '');
  const baseHint = selection.length
    ? '已选 ' + selection.length + ' 个 · 点击添加 · ⌫ 撤销 · Esc 完成'
    : '点击选择（可多选）· ↑↓ 父/子 · 右键取消';
  const hint = transientHint ? transientHint + '　—　' + baseHint : baseHint;
  const text = base + '　—　' + hint;
  if (tooltip) {
    // 只在文案变化时改 DOM 并重新量尺寸；同元素内移动光标只挪位置。
    if (tooltip.textContent !== text) {
      tooltip.textContent = text;
      tooltip.style.display = '';
      tooltipSize.w = tooltip.offsetWidth;
      tooltipSize.h = tooltip.offsetHeight;
    }
    placeTooltip(x, y);
  }
}

function schedulePaint() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (!active) return;
    if (currentEl) paint(currentEl, lastX, lastY);
    else hideOverlay();
  });
}

function onMove(e) {
  if (!active) return;
  lastX = e.clientX;
  lastY = e.clientY;
  transientHint = '';
  const el = elementAt(e);
  const next = el ? resolvePickTarget(el) : null;
  // 悬浮到自己 UI 上时保留 currentEl（方向键仍可用），但把高亮藏起来，避免框住上一个元素造成误导。
  if (next) currentEl = next;
  schedulePaint();
}

// 滚动/缩放时高亮必须跟着走：overlay 是 position:fixed，
// 页面一滚它的位置就错了，而 mousemove 不会触发 —— 不修就会看到框「粘」在原地。
function onScrollResize() {
  if (!active || !currentEl) return;
  schedulePaint();
}

// 阻止页面自身的按下副作用（有些框架在 mousedown 就触发动作，早于 click）。
function onMouseDown(e) {
  if (!active) return;
  if (e.button === 2) return; // 右键交给 contextmenu 处理，那里才能可靠地屏蔽浏览器菜单
  consumeKey(e);
}

// 右键 = 结束拾取（有选区则提交，无选区则取消），并屏蔽页面右键菜单。
function onContextMenu(e) {
  if (!active) return;
  consumeKey(e);
  if (selection.length) finishWith(selection);
  else {
    stop();
    if (onCancelCb) onCancelCb();
  }
}

// 交给 finishWith 的列表：并行取源码。
async function finishWith(list) {
  const arr = (Array.isArray(list) ? list.filter(Boolean) : []).slice();
  stop();
  if (!arr.length) {
    if (onCancelCb) onCancelCb();
    return;
  }
  // 并行取源码：逐个 await 会让 10 个元素串行十次往返。
  await Promise.all(
    arr.map(async (p) => {
      try {
        p.source = (await getElementSource(p.selector)) || null;
      } catch (e) {
        p.source = null;
      }
    })
  );
  if (onPickCb) onPickCb(arr);
}

function onClick(e) {
  if (!active) return;
  consumeKey(e);
  const el = resolvePickTarget(elementAt(e) || currentEl);
  if (!el) return;
  // 每次点击把元素加入选区（按选择器去重），继续拾取，直到 Esc / Enter / 右键结束。
  const p = collect(el);
  if (!p.selector) return;
  if (selection.some((s) => s.selector === p.selector)) {
    // 重复点击不再入列，但要给出反馈，否则用户以为没生效。
    transientHint = '该元素已在选区中';
  } else {
    transientHint = '';
    selection.push(p);
  }
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
    const up = currentEl ? parentCrossingShadow(currentEl) : null;
    if (up && !isOwnNode(up)) {
      currentEl = up;
      paint(currentEl, lastX, lastY);
    }
    return;
  }
  if (e.key === 'ArrowDown') {
    consumeKey(e);
    // 优先下钻到鼠标所在的那个子元素（符合 DevTools 直觉）。
    const c = pickChild(currentEl, lastX, lastY);
    if (c) {
      currentEl = c;
      paint(c, lastX, lastY);
    }
    return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    // 撤销最后一次选择：选错了不必整轮重来。
    consumeKey(e);
    if (selection.length) {
      selection.pop();
      if (currentEl) paint(currentEl, lastX, lastY);
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
  hoverCache = new WeakMap();
  tooltipSize = { w: 0, h: 0 };
  transientHint = '';
  onPickCb = onPick || null;
  onCancelCb = onCancel || null;
  currentEl = null;
  lastX = window.innerWidth / 2;
  lastY = window.innerHeight / 2;
  savedCursor = document.documentElement.style.cursor || '';
  document.documentElement.style.cursor = 'crosshair';
  ensureCursorStyle();
  // 挂在 window 捕获阶段：比 document/页面监听更早，尽量拦截页面自身的点击/按键副作用。
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('keydown', onKey, true);
  // 滚动（capture 以覆盖内部滚动容器）与缩放时同步高亮位置。
  window.addEventListener('scroll', onScrollResize, true);
  window.addEventListener('resize', onScrollResize, true);
}

export function stopPicker() {
  stop();
}

function stop() {
  if (active) {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScrollResize, true);
    window.removeEventListener('resize', onScrollResize, true);
    document.documentElement.style.cursor = savedCursor || '';
    removeCursorStyle();
  }
  active = false;
  selection = [];
  currentEl = null;
  hoverCache = new WeakMap();
  transientHint = '';
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  removeOverlay();
}

// 元素拾取模式：进入后鼠标移动高亮候选元素，点击确认并返回
// { selector, tag, label, source }，其中 source 为该元素对应的框架源码位置（开发构建才有）。
import { elementSelector } from './page-text.js';
import { getElementSource } from './debug-capture.js';

let active = false;
let overlay = null;
let tooltip = null;
let currentEl = null;
let onPickCb = null;
let onCancelCb = null;
let savedCursor = '';

function isOwnNode(el) {
  if (!el || el === overlay || el === tooltip) return true;
  try {
    return !!(el.closest && el.closest('#__kb-ai-host'));
  } catch (e) {
    return false;
  }
}

function ensureOverlay() {
  if (overlay && overlay.isConnected) return;
  overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;' +
    'border:2px solid #4a90d9;background:rgba(74,144,217,.12);border-radius:2px;display:none;';
  tooltip = document.createElement('div');
  tooltip.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;background:#1f2937;color:#fff;' +
    'font:12px/1.5 Consolas,"Cascadia Code",monospace;padding:3px 8px;border-radius:6px;' +
    'max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;';
  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(tooltip);
}

function removeOverlay() {
  if (overlay) { overlay.remove(); overlay = null; }
  if (tooltip) { tooltip.remove(); tooltip = null; }
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

function describe(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  const id = el.id ? '#' + el.id : '';
  const cls = el.classList && el.classList.length ? '.' + Array.from(el.classList).slice(0, 2).join('.') : '';
  const label =
    (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title'))) ||
    (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return { tag, name: tag + id + cls, label: String(label || '') };
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
  const r = el.getBoundingClientRect();
  overlay.style.display = '';
  overlay.style.left = r.left + 'px';
  overlay.style.top = r.top + 'px';
  overlay.style.width = r.width + 'px';
  overlay.style.height = r.height + 'px';
  const d = describe(el);
  tooltip.style.display = '';
  tooltip.textContent = d.name + (d.label ? ' · ' + d.label : '');
  placeTooltip(x, y);
}

function onMove(e) {
  if (!active) return;
  const el = elementAt(e);
  if (!el) return;
  if (el !== currentEl) currentEl = el;
  paint(currentEl, e.clientX, e.clientY);
}

async function onClick(e) {
  if (!active) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  const el = elementAt(e) || currentEl;
  stop();
  if (!el) {
    if (onCancelCb) onCancelCb();
    return;
  }
  let selector = '';
  try { selector = elementSelector(el); } catch (err) {}
  const d = describe(el);
  let source = null;
  try { source = await getElementSource(selector); } catch (err) {}
  if (onPickCb) onPickCb({ selector, tag: d.tag, label: d.label, source: source || null });
}

function onKey(e) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  stop();
  if (onCancelCb) onCancelCb();
}

export function isPickerActive() {
  return active;
}

export function startPicker(onPick, onCancel) {
  if (active) stop();
  ensureOverlay();
  active = true;
  onPickCb = onPick || null;
  onCancelCb = onCancel || null;
  currentEl = null;
  savedCursor = document.documentElement.style.cursor || '';
  document.documentElement.style.cursor = 'crosshair';
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
}

export function stopPicker() {
  stop();
}

function stop() {
  if (active) {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    document.documentElement.style.cursor = savedCursor || '';
  }
  active = false;
  currentEl = null;
  removeOverlay();
}

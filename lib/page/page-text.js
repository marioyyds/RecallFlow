// 页面正文提取：去除脚本/样式/导航等噪音后的纯文本（供 AI 上下文与 read_current_page 工具）
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

const INTERACTIVE_SELECTOR = [
  'a', 'button', 'input', 'textarea', 'select', 'summary',
  '[role="button"]', '[role="link"]', '[role="checkbox"]',
  '[role="tab"]', '[contenteditable="true"]',
].join(',');

function normalizeSnapshotText(value, max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isVisibleElement(el) {
  if (!el || el.closest(PAGE_TEXT_EXCLUDE)) return false;
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
function elementSelector(el) {
  if (el.id) {
    const byId = '#' + cssEscape(el.id);
    if (selectorUnique(byId)) return byId;
  }
  for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-name']) {
    const byAttr = attributeSelector(el, attr, false);
    if (byAttr && selectorUnique(byAttr)) return byAttr;
  }
  if (el.getAttribute('name')) {
    const byName = attributeSelector(el, 'name', true);
    if (byName && selectorUnique(byName)) return byName;
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

// 递归收集可交互元素：穿透同源 iframe 与开放 shadow DOM。
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

function hashSnapshot(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 生成供 Agent 观察和动作验证使用的轻量 DOM 快照。
 * 不包含 input.value / textarea.value，避免把密码和用户输入带回模型。
 */
export function extractPageSnapshot(options = {}) {
  try {
    const body = document.body;
    if (!body) return { version: 1, url: location.href, title: document.title || '', elements: [], text: '', fingerprint: 'empty' };
    const maxElements = Math.min(120, Math.max(1, Number(options.maxElements) || 60));
    const maxText = Math.min(8000, Math.max(500, Number(options.maxText) || 4000));
    const nodes = collectInteractiveInFrames(document);
    const elements = nodes.slice(0, maxElements).map((el, index) => {
      const rect = el.getBoundingClientRect();
      const inViewport =
        rect.top < (window.innerHeight || document.documentElement.clientHeight) &&
        rect.bottom > 0 &&
        rect.left < (window.innerWidth || document.documentElement.clientWidth) &&
        rect.right > 0;
      const label = normalizeSnapshotText(
        el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') ||
        el.innerText || el.textContent || el.getAttribute('name') || el.getAttribute('alt') || '',
        180
      );
      return {
        ref: 'rf-' + (index + 1),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        type: el.getAttribute('type') || '',
        label,
        selector: elementSelector(el),
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        checked: typeof el.checked === 'boolean' ? el.checked : undefined,
        // 只返回是否有值，不返回真实输入内容。
        valuePresent: ['INPUT', 'TEXTAREA'].includes(el.tagName) ? Boolean(el.value) : undefined,
        selectedIndex: el.tagName === 'SELECT' ? el.selectedIndex : undefined,
        selectedLabel: el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]
          ? normalizeSnapshotText(el.selectedOptions[0].textContent, 120)
          : undefined,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        inViewport,
      };
    });
    const text = extractPageText().slice(0, maxText);
    const snapshot = {
      version: 1,
      url: location.href,
      title: document.title || '',
      text,
      elements,
      counts: {
        interactive: nodes.length,
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
    return { version: 1, url: location.href, title: document.title || '', elements: [], text: '', fingerprint: 'error', error: e.message };
  }
}

export function getInteractiveElementByRef(ref) {
  const match = String(ref || '').match(/^rf-(\d+)$/);
  if (!match) return null;
  const nodes = collectInteractiveInFrames(document);
  return nodes[Number(match[1]) - 1] || null;
}

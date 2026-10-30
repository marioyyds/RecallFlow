import {
  buildPageCharMap,
  findRangeBySubstr,
  isElementCollectExcluded,
  normalizeCitationText,
} from '../citation.ts';
import {
  absoluteRect,
  elementSelector,
  getInteractiveElementByRef,
  getRefFingerprint,
} from '../page-text.ts';
import { sliceSafe } from '../../../shared/surrogates.ts';

/** Recursively query same-origin frames and open shadow roots. */
export function queryAllInFrames(root: any, selector: any, into: any[] = []) {
  try {
    Array.prototype.push.apply(into, root.querySelectorAll(selector));
  } catch {}
  try {
    root.querySelectorAll('*').forEach((el: any) => {
      if (el.shadowRoot) queryAllInFrames(el.shadowRoot, selector, into);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        const doc = el.contentDocument;
        if (doc && doc !== root) queryAllInFrames(doc, selector, into);
      }
    });
  } catch {}
  return into;
}

export function isVisibleForAction(el: any): boolean {
  if (!el || !el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Resolve a visible text fragment to a DOM Range. */
export function findRangeFor(params: any) {
  if (!params.text) return null;
  try {
    return findRangeBySubstr(buildPageCharMap(), params.text);
  } catch {
    return null;
  }
}

function findElementsByText(text: any, limit: any) {
  const query = normalizeCitationText(text);
  if (!query) return [];
  const candidates = queryAllInFrames(
    document,
    'p,h1,h2,h3,h4,h5,h6,li,td,th,dt,dd,span,a,div,blockquote,figcaption'
  );
  const hits: any[] = [];
  for (const el of candidates) {
    if (isElementCollectExcluded(el)) continue;
    if (normalizeCitationText(el.textContent).includes(query)) hits.push(el);
  }
  const deepest = hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
  return deepest.slice(0, limit || 10);
}

function cssEscapeLocal(value: any) {
  const text = String(value || '');
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(text);
  return text.replace(/[^a-zA-Z0-9_-]/g, (char) => '\\' + char);
}

export function roleOf(el: any) {
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
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'file') return 'button';
    if (type === 'search') return 'searchbox';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    return 'textbox';
  }
  return '';
}

export function accessibleName(el: any) {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const parts = labelledby
      .split(/\s+/)
      .map((id: any) => {
        const target = document.getElementById(id);
        return target ? target.textContent || '' : '';
      })
      .filter(Boolean);
    if (parts.length) return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  if (el.labels && el.labels.length) {
    const label = Array.from<any>(el.labels)
      .map((item: any) => item.textContent || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (label) return label;
  }
  for (const attribute of ['placeholder', 'title', 'alt']) {
    const value = el.getAttribute(attribute);
    if (value && value.trim()) return value.trim();
  }
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (
    el.tagName === 'INPUT' &&
    (type === 'submit' || type === 'button' || type === 'reset') &&
    el.value
  ) {
    return String(el.value).trim();
  }
  return sliceSafe((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), 0, 120);
}

export function normName(value: any) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export const TARGET_CANDIDATE_SELECTOR =
  'a,button,input,textarea,select,summary,option,[role],[contenteditable="true"]';

export function findElementsByRoleName(role: any, name: any) {
  const wantRole = normName(role);
  const wantName = normName(name);
  const candidates = queryAllInFrames(document, TARGET_CANDIDATE_SELECTOR);
  const hits = [];
  for (const el of candidates) {
    if (isElementCollectExcluded(el)) continue;
    if (!isVisibleForAction(el)) continue;
    if (wantRole && roleOf(el) !== wantRole) continue;
    if (wantName) {
      const accessible = normName(accessibleName(el));
      if (!accessible || accessible.indexOf(wantName) === -1) continue;
    }
    hits.push(el);
  }
  return hits;
}

export function nameSimilarity(a: any, b: any) {
  const left = normName(a);
  const right = normName(b);
  if (!left || !right) return 0;
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  const rightChars = new Set(right);
  let shared = 0;
  for (const character of new Set(left)) if (rightChars.has(character)) shared++;
  return prefix * 2 + shared;
}

export function describeLookupMiss(params: any = {}, limit = 5) {
  const wantRole = normName(params.role);
  const wantName = normName(params.name);
  if (!wantRole && !wantName) return '';
  let pool;
  try {
    const candidates = queryAllInFrames(document, TARGET_CANDIDATE_SELECTOR);
    pool = candidates.filter((el) => !isElementCollectExcluded(el) && isVisibleForAction(el));
  } catch {
    return '';
  }
  if (wantRole) pool = pool.filter((el) => roleOf(el) === wantRole);
  const described = pool
    .map((el) => ({
      el,
      name: String(accessibleName(el) || '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((item) => item.name);
  if (!described.length) {
    return wantRole && !pool.length ? '页面上没有 role=' + params.role + ' 的可交互元素。' : '';
  }
  const sorted = wantName
    ? described
        .slice()
        .sort((a, b) => nameSimilarity(b.name, params.name) - nameSimilarity(a.name, params.name))
    : described;
  const shown = sorted.slice(0, limit);
  const lines = shown.map((item) => {
    const role = roleOf(item.el) || item.el.tagName.toLowerCase();
    let selector = '';
    try {
      selector = elementSelector(item.el);
    } catch {}
    return '  - ' + role + '「' + item.name.slice(0, 60) + '」' + (selector ? '  ' + selector : '');
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

export function describeTargetState(el: any) {
  if (!el) return '';
  const parts = [];
  for (const attribute of [
    'aria-label',
    'aria-pressed',
    'aria-checked',
    'aria-expanded',
    'aria-selected',
    'aria-disabled',
    'title',
  ]) {
    const value = el.getAttribute && el.getAttribute(attribute);
    if (value !== null && value !== undefined && String(value).trim()) {
      parts.push(
        attribute +
          '=' +
          JSON.stringify(sliceSafe(String(value).replace(/\s+/g, ' ').trim(), 0, 60))
      );
    }
  }
  const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text && text.length <= 80) parts.push('text=' + JSON.stringify(text));
  return parts.join(' ');
}

export function targetMissError(params: any) {
  if (params && params.ref) {
    if (getRefFingerprint(params.ref)) {
      return (
        'ref「' +
        params.ref +
        '」已失效：页面结构已变化（元素被替换/移除）。请重新 get_page_snapshot 获取新 ref，不要继续用旧 ref。'
      );
    }
    return 'ref「' + params.ref + '」不存在或已被清理。请重新 get_page_snapshot 获取 ref。';
  }
  const hint = describeLookupMiss(params || {});
  return hint ? '未找到目标元素。' + hint : '未找到目标元素';
}

export function findElementsByTestId(testid: any) {
  const query = String(testid || '');
  if (!query) return [];
  const escaped = cssEscapeLocal(query);
  const selector = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-name']
    .map((attribute) => '[' + attribute + '="' + escaped + '"]')
    .join(',');
  try {
    return queryAllInFrames(document, selector);
  } catch {
    return [];
  }
}

/** Resolve ref, role+name, test id, selector or visible text, with optional index. */
export function findElementsFor(params: any) {
  let elements = [];
  if (params.ref) {
    const el = getInteractiveElementByRef(params.ref);
    elements = el ? [el] : [];
  } else if (params.role || params.name) {
    elements = findElementsByRoleName(params.role, params.name);
  } else if (params.testid) {
    elements = findElementsByTestId(params.testid);
  } else if (params.selector) {
    try {
      elements = queryAllInFrames(document, params.selector);
    } catch {
      elements = [];
    }
  } else if (params.text) {
    elements = findElementsByText(params.text, 10);
  }
  if (params.index !== undefined && params.index !== null) {
    const index = Number(params.index);
    return Number.isInteger(index) && index >= 0 && index < elements.length
      ? [elements[index]]
      : [];
  }
  return elements;
}

export function resolveElementSelector(params: any) {
  try {
    const elements = findElementsFor(params || {});
    if (!elements.length) return null;
    return elementSelector(elements[0]);
  } catch {
    return null;
  }
}

export function resolveTargetInfo(params: any) {
  try {
    const elements = findElementsFor(params || {});
    if (!elements.length) return { found: false, reason: targetMissError(params) };
    const el = elements[0];
    const label = sliceSafe(
      String(
        el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.getAttribute('placeholder') ||
          el.innerText ||
          el.textContent ||
          el.getAttribute('name') ||
          ''
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
  } catch (error) {
    return { found: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// 最小 DOM 桩：给"只能靠读源码做正则断言"的页面模块（lib/ui/page/chat.ts）一个真 import 的机会。
//
// 为什么需要它：chat.js 有 4900 行、12 个测试文件提到它，但**没有一个真的 import 过**。
// 那些测试全是 `fs.readFileSync` + 正则 —— 它们能钉住"某句话还在文件里"，
// 却完全不知道代码跑起来会不会抛。fab 位置那个 bug（存的值里 ratio 为 null 时气泡跳到顶部）
// 就是这么漏过去的。
//
// 设计取舍：**显式实现，不用 Proxy 兜底**。Proxy 让任何未知属性都返回 no-op 函数，
// 于是 `if (el.someNewApi)` 恒为真 —— 被测代码会走进不存在的分支，
// 测出来的"通过"是桩的行为、不是代码的行为。宁可在这里补一个成员，也不要万能桩。
// 缺什么就抛 `不是函数`，那正好指向要补的位置。
//
// innerHTML 是**真的解析**（见 parseHtml），而不是吞掉字符串：
// chat.js 大量使用 `el.innerHTML = '<label><input data-policy="edit">...'` 之后
// `el.querySelector('[data-policy]')` —— 桩如果让 querySelector 随便造一个节点，
// 那"标记里写错属性名"这类真 bug 就永远测不出来。代价是一个很小的解析器。

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

class ClassList {
  constructor(owner) { this._owner = owner; }
  get _set() { return this._owner._classes; }
  add(...names) { for (const n of names) if (n) this._set.add(String(n)); }
  remove(...names) { for (const n of names) this._set.delete(String(n)); }
  contains(name) { return this._set.has(String(name)); }
  toggle(name, force) {
    const key = String(name);
    const has = this._set.has(key);
    const want = force === undefined ? !has : Boolean(force);
    if (want) this._set.add(key); else this._set.delete(key);
    return want;
  }
  item(i) { return Array.from(this._set)[i] || null; }
  get length() { return this._set.size; }
  toString() { return Array.from(this._set).join(' '); }
}

class Style {
  constructor() { this._props = new Map(); this._cssText = ''; }
  setProperty(k, v) { this._props.set(String(k), String(v)); }
  getPropertyValue(k) { return this._props.get(String(k)) || ''; }
  removeProperty(k) { this._props.delete(String(k)); }
  // `style.cssText = '...'` 在页面代码里用得不少（一次性写整串内联样式）。
  // 不实现会静默丢掉这些样式 —— 桩不需要真的渲染，只需要不抛且留下痕迹。
  get cssText() { return this._cssText; }
  set cssText(v) { this._cssText = String(v == null ? '' : v); }
}

/** 事件目标的最小实现：记录监听器，并提供"派发"给测试用。 */
class EventTargetish {
  constructor() { this._listeners = new Map(); }
  addEventListener(type, fn, opts) {
    if (typeof fn !== 'function') return;
    const key = String(type);
    if (!this._listeners.has(key)) this._listeners.set(key, []);
    const list = this._listeners.get(key);
    const capture = typeof opts === 'boolean' ? opts : Boolean(opts && opts.capture);
    // 同一函数 + 同一捕获标志只登记一次（浏览器语义）
    if (!list.some((x) => x.fn === fn && x.capture === capture)) list.push({ fn, capture });
  }
  removeEventListener(type, fn, opts) {
    const list = this._listeners.get(String(type));
    if (!list) return;
    const capture = typeof opts === 'boolean' ? opts : Boolean(opts && opts.capture);
    const i = list.findIndex((x) => x.fn === fn && x.capture === capture);
    if (i >= 0) list.splice(i, 1);
  }
  /** 测试用：同步调用该类型上登记的监听器（按登记顺序）。 */
  emit(type, event) {
    const list = (this._listeners.get(String(type)) || []).slice();
    const ev = event || {};
    if (!ev.type) ev.type = String(type);
    if (!ev.target) ev.target = this;
    if (typeof ev.composedPath !== 'function') ev.composedPath = () => [this];
    if (typeof ev.preventDefault !== 'function') ev.preventDefault = () => {};
    if (typeof ev.stopPropagation !== 'function') ev.stopPropagation = () => {};
    for (const { fn } of list) fn.call(this, ev);
    return ev;
  }
  /** 真实的 dispatchEvent 语义（同步、只发本节点的监听器 —— 桩不建冒泡链）。 */
  dispatchEvent(event) {
    const ev = event || {};
    if (!ev.type) return true;
    this.emit(ev.type, ev);
    return !ev.defaultPrevented;
  }
  listenerCount(type) { return (this._listeners.get(String(type)) || []).length; }
  hasListener(type) { return this.listenerCount(type) > 0; }
}

// ---------------------------------------------------------------- HTML 解析

/** 解析一个属性串：`a="1" b c='2'` → { a:'1', b:'', c:'2' } */
function parseAttrs(raw) {
  const out = {};
  const re = /([:\w-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const key = m[1];
    let val = m[2];
    if (val === undefined) val = '';
    else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

/**
 * 把一段 HTML 字符串解析成子节点数组（只支持本项目实际用到的那一小撮语法）。
 *
 * 支持：成对标签、自闭合标签、void 元素、属性（带/不带值、双/单引号）、
 * 注释（丢弃）、纯文本。**不支持**：实体解码、`<template>`、命名空间。
 * 遇到不认识的语法按文本处理 —— 宁可多一个文本节点，也不要静默丢内容。
 */
export function parseHtml(html) {
  const src = String(html == null ? '' : html);
  const root = { children: [] };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) {
      const text = src.slice(i, lt);
      if (text.trim()) top().children.push({ text });
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) { top().children.push({ text: src.slice(lt) }); break; }
    const inner = src.slice(lt + 1, gt);
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim().toLowerCase();
      // 关到最近的同名节点；找不到就忽略（容错，不抛）
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) { stack.length = k; break; }
      }
      i = gt + 1;
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^([a-zA-Z][\w:-]*)/.exec(body);
    if (!nameMatch) { top().children.push({ text: src.slice(lt, gt + 1) }); i = gt + 1; continue; }
    const tag = nameMatch[1].toLowerCase();
    const node = { tag, attrs: parseAttrs(body.slice(nameMatch[1].length)), children: [] };
    top().children.push(node);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(node);
    i = gt + 1;
  }
  return root.children.map(toNode);
}

// ---------------------------------------------------------------- 选择器

/** 解析一个复合选择器（不含空格组合子）：`div.a#b[data-x="1"]:checked:not([disabled])` */
function parseCompound(sel) {
  const tokens = [];
  let i = 0;
  const s = String(sel).trim();
  while (i < s.length) {
    const c = s[i];
    if (c === '*') { i += 1; continue; }
    if (c === '#') {
      const m = /^#([\w-]+)/.exec(s.slice(i));
      if (!m) return null;
      tokens.push({ kind: 'id', value: m[1] }); i += m[0].length; continue;
    }
    if (c === '.') {
      const m = /^\.([\w-]+)/.exec(s.slice(i));
      if (!m) return null;
      tokens.push({ kind: 'class', value: m[1] }); i += m[0].length; continue;
    }
    if (c === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) return null;
      const body = s.slice(i + 1, end);
      const eq = body.indexOf('=');
      if (eq < 0) tokens.push({ kind: 'attr', name: body.trim() });
      else {
        let val = body.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        tokens.push({ kind: 'attrEq', name: body.slice(0, eq).trim(), value: val });
      }
      i = end + 1; continue;
    }
    if (c === ':') {
      const m = /^:([\w-]+)(?:\(([^)]*)\))?/.exec(s.slice(i));
      if (!m) return null;
      if (m[1] === 'checked') tokens.push({ kind: 'checked' });
      else if (m[1] === 'not') {
        const sub = parseCompound(m[2] || '');
        if (!sub) return null;
        tokens.push({ kind: 'not', sub });
      }
      // 其它伪类（:hover 等）在静态树里恒不成立；这里按"不参与匹配"处理，
      // 因为被测代码只用 :not 与 :checked。
      i += m[0].length; continue;
    }
    const m = /^([a-zA-Z][\w-]*)/.exec(s.slice(i));
    if (!m) return null;
    tokens.push({ kind: 'tag', value: m[1].toLowerCase() });
    i += m[0].length;
  }
  return tokens;
}

function matchesTokens(node, tokens) {
  if (!node || node.nodeType !== 1) return false;
  for (const t of tokens) {
    if (t.kind === 'tag' && String(node.tagName || '').toLowerCase() !== t.value) return false;
    if (t.kind === 'id' && node.id !== t.value) return false;
    if (t.kind === 'class' && !node.classList.contains(t.value)) return false;
    if (t.kind === 'attr' && !node.hasAttribute(t.name)) return false;
    if (t.kind === 'attrEq' && node.getAttribute(t.name) !== t.value) return false;
    if (t.kind === 'checked' && node.checked !== true) return false;
    if (t.kind === 'not' && matchesTokens(node, t.sub)) return false;
  }
  return true;
}

/** 支持逗号分隔的简单选择器列表（不含后代组合子 —— 本项目没用到）。 */
export function matchesSelector(node, selector) {
  const parts = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    // 有后代组合子时退化成"只看最后一段"：比返回 null 更接近真实语义，
    // 且不会把"元素明明在树里"判成不存在。
    const last = p.split(/\s+/).pop();
    const tokens = parseCompound(last);
    if (tokens && matchesTokens(node, tokens)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 节点

class Element extends EventTargetish {
  constructor(tagName) {
    super();
    this.tagName = String(tagName || 'div').toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this.childNodes = [];
    this.parentNode = null;
    this.style = new Style();
    this._classes = new Set();
    this.classList = new ClassList(this);
    this.dataset = {};
    this._attrs = new Map();
    this._text = '';
    this._html = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.id = '';
    this.title = '';
    this.src = '';
    this.alt = '';
    this.type = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.clientWidth = 0;
    this.offsetWidth = 320;
    this.offsetHeight = 480;
    this.shadowRoot = null;
  }
  get children() { return this.childNodes.filter((n) => n && n.nodeType === 1); }
  get className() { return Array.from(this._classes).join(' '); }
  set className(v) {
    this._classes = new Set(String(v == null ? '' : v).split(/\s+/).filter(Boolean));
    this._attrs.set('class', this.className);
  }
  // isConnected：ensureHost() 用它判断宿主是否被 SPA 导航踢出了 DOM（见该函数注释）。
  // 没有它，`host.isConnected` 是 undefined ⇒ 恒假 ⇒ 每次调用都走"重新挂载"分支。
  get isConnected() {
    let n = this;
    while (n) {
      if (n.nodeType === 9) return true; // document
      if (n._shadowHost) return n._shadowHost.isConnected;
      n = n.parentNode;
    }
    return false;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  // nextSibling / previousSibling：此前恒返回 null，于是"按原位插回"这类断言**恒真**
  // （导出守卫 save-clean.js 靠 nextSibling 把宿主插回原位置；chat.js 的流式光标
  // 也要插在 host.nextSibling 之前）。桩缺这一项，就等于把两条真实行为测成了空话。
  get nextSibling() {
    const p = this.parentNode;
    if (!p || !p.childNodes) return null;
    const i = p.childNodes.indexOf(this);
    return i >= 0 ? p.childNodes[i + 1] || null : null;
  }
  get previousSibling() {
    const p = this.parentNode;
    if (!p || !p.childNodes) return null;
    const i = p.childNodes.indexOf(this);
    return i > 0 ? p.childNodes[i - 1] || null : null;
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v == null ? '' : v);
    this.childNodes.length = 0;
    for (const node of parseHtml(this._html)) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  get textContent() {
    if (!this.childNodes.length) return this._text;
    return this.childNodes.map((n) => (n.nodeType === 3 ? n.nodeValue : n.textContent)).join('');
  }
  set textContent(v) {
    this._text = String(v == null ? '' : v);
    this.childNodes.length = 0;
    this._html = '';
  }
  // appendChild / insertBefore 必须**先从原父节点摘掉**再挂 —— 这是真实 DOM 的语义
  //（一个节点在文档里只有一个位置）。桩此前只往新父节点 push，于是"把节点移走"
  //（导出守卫摘宿主、面板改挂载点）在测试里看起来"既在新位置又在旧位置"，
  // 而"宿主还在文档里吗"这种断言就永远为真。
  _detachFromOldParent(nextParent) {
    const old = this.parentNode;
    if (!old || old === nextParent || !old.childNodes) return;
    const i = old.childNodes.indexOf(this);
    if (i >= 0) old.childNodes.splice(i, 1);
  }
  appendChild(node) {
    if (!node) return node;
    if (typeof node._detachFromOldParent === 'function') node._detachFromOldParent(this);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? createText(n) : n); }
  insertBefore(node, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) return this.appendChild(node);
    if (typeof node._detachFromOldParent === 'function') node._detachFromOldParent(this);
    node.parentNode = this;
    this.childNodes.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) { this.childNodes.splice(i, 1); node.parentNode = null; }
    return node;
  }
  replaceChildren(...nodes) {
    this.childNodes.length = 0;
    for (const n of nodes) this.appendChild(n);
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(node) {
    if (node === this) return true;
    return this.childNodes.some((c) => c && typeof c.contains === 'function' && c.contains(node));
  }
  setAttribute(k, v) {
    const key = String(k);
    this._attrs.set(key, String(v));
    if (key === 'id') this.id = String(v);
    if (key === 'class') this.className = String(v);
    const data = /^data-(.+)$/.exec(key);
    if (data) this.dataset[data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(k) { return this._attrs.has(String(k)) ? this._attrs.get(String(k)) : null; }
  removeAttribute(k) { this._attrs.delete(String(k)); }
  hasAttribute(k) { return this._attrs.has(String(k)); }
  insertAdjacentHTML(pos, html) {
    const nodes = parseHtml(html);
    if (String(pos).startsWith('before')) {
      for (let i = nodes.length - 1; i >= 0; i--) this.insertBefore(nodes[i], this.firstChild);
    } else {
      for (const n of nodes) this.appendChild(n);
    }
    this._html += String(html == null ? '' : html);
  }
  /** 深度优先遍历所有后代元素。 */
  _walk(out = []) {
    for (const n of this.childNodes) {
      if (n && n.nodeType === 1) { out.push(n); n._walk(out); }
    }
    return out;
  }
  querySelector(sel) { return this._walk().find((n) => matchesSelector(n, sel)) || null; }
  querySelectorAll(sel) { return this._walk().filter((n) => matchesSelector(n, sel)); }
  closest(sel) {
    let n = this;
    while (n && n.nodeType === 1) {
      if (matchesSelector(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  matches(sel) { return matchesSelector(this, sel); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 320, bottom: 480, width: 320, height: 480, x: 0, y: 0 }; }
  getClientRects() { return []; }
  getRootNode() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n;
  }
  attachShadow() {
    const root = new Element('#shadow-root');
    root.nodeType = 11; // DocumentFragment
    root.host = this;
    root._shadowHost = this;
    this.shadowRoot = root;
    return root;
  }
  focus() {}
  blur() {}
  click() { this.emit('click', {}); }
  scrollIntoView() {}
  setSelectionRange() {}
  select() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  animate() { return { cancel() {}, finished: Promise.resolve() }; }
}

function createText(text) {
  const node = {
    nodeType: 3,
    nodeName: '#text',
    nodeValue: String(text == null ? '' : text),
    parentNode: null,
    contains: () => false,
  };
  Object.defineProperty(node, 'textContent', {
    get: () => node.nodeValue,
    set: (v) => { node.nodeValue = String(v == null ? '' : v); },
    configurable: true,
  });
  return node;
}

/** parseHtml 的产物是纯数据，这里转成真正的节点对象（含事件能力）。 */
function toNode(spec, parent) {
  const node = createText(spec.text === undefined ? '' : spec.text);
  if (spec.tag === undefined) {
    node.parentNode = parent || null;
    return node;
  }
  const el = new Element(spec.tag);
  el.parentNode = parent || null;
  for (const [k, v] of Object.entries(spec.attrs || {})) el.setAttribute(k, v);
  // 布尔属性：真 DOM 里 `<div hidden>` 会让 `el.hidden === true`，这里必须一致 ——
  // chat.js 用 `!el.hidden` 判断「审批设置弹层是否打开」，桩不认的话 Esc 永远被吞掉。
  if (Object.prototype.hasOwnProperty.call(spec.attrs || {}, 'hidden')) el.hidden = true;
  if (Object.prototype.hasOwnProperty.call(spec.attrs || {}, 'disabled')) el.disabled = true;
  if (Object.prototype.hasOwnProperty.call(spec.attrs || {}, 'checked')) el.checked = true;
  for (const child of spec.children || []) {
    const c = toNode(child, el);
    el.childNodes.push(c);
  }
  return el;
}

// ---------------------------------------------------------------- 全局安装

/** 造一个只实现被测代码真的用到的成员的 document。 */
export function createDocumentStub() {
  const doc = new EventTargetish();
  doc.nodeType = 9;
  doc.createElement = (tag) => new Element(tag);
  doc.createTextNode = (text) => createText(text);
  doc.createDocumentFragment = () => new Element('#fragment');
  doc.createRange = () => ({
    setStart() {}, setEnd() {}, selectNodeContents() {}, collapse() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    getClientRects: () => [],
    toString: () => '',
  });
  doc.head = new Element('head');
  doc.body = new Element('body');
  doc.documentElement = new Element('html');
  doc.documentElement.nodeType = 1;
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.head.parentNode = doc.documentElement;
  doc.body.parentNode = doc.documentElement;
  doc.documentElement.parentNode = doc;
  doc.head.ownerDocument = doc;
  doc.body.ownerDocument = doc;
  doc.querySelector = (sel) => doc.documentElement.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);
  doc.getElementById = (id) => doc.documentElement.querySelector('#' + id);
  doc.getElementsByTagName = (tag) => doc.documentElement.querySelectorAll(tag);
  doc.visibilityState = 'visible';
  doc.hidden = false;
  doc.title = 'test';
  doc.activeElement = doc.body;
  return doc;
}

export function createWindowStub(doc) {
  const win = new EventTargetish();
  win.document = doc;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.scrollX = 0;
  win.scrollY = 0;
  win.devicePixelRatio = 1;
  // 布局视口（不含滚动条）也按同一个视口给。页面侧有代码用
  // `documentElement.clientWidth` 做几何判定（气泡悬浮热区，见 lib/ui/page/fab-position.ts）：
  // 桩若给 0，那条判定会**恒假**，于是"鼠标还在气泡上"这件事永远检测不到。
  if (doc.documentElement) {
    doc.documentElement.clientWidth = win.innerWidth;
    doc.documentElement.clientHeight = win.innerHeight;
  }
  win.location = { href: 'https://example.test/page', search: '', origin: 'https://example.test' };
  win.getSelection = () => null;
  win.getComputedStyle = () => ({ getPropertyValue: () => '', getPropertyPriority: () => '', length: 0 });
  win.matchMedia = (q) => ({
    media: String(q), matches: false,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  win.requestAnimationFrame = (fn) => {
    // 同步执行一次：被测代码只关心"下一帧会跑"，不关心真的等一帧。
    try { fn(0); } catch (e) {}
    return 1;
  };
  win.cancelAnimationFrame = () => {};
  win.requestIdleCallback = (fn) => { try { fn({ didTimeout: false, timeRemaining: () => 8 }); } catch (e) {} return 1; };
  win.cancelIdleCallback = () => {};
  return win;
}

/**
 * 安装全局桩，返回 `{ restore }`。
 *
 * 只覆盖页面侧（window / document / localStorage 等），**不动 chrome** ——
 * 那个由 tests/helpers/chrome-stub.mjs 统一管，两处各造一个就会开始漂移。
 */
export function installDomStub() {
  const doc = createDocumentStub();
  const win = createWindowStub(doc);
  const saved = new Map();
  const names = ['window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location', 'HTMLElement', 'Node', 'CustomEvent', 'Event', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'];
  for (const n of names) saved.set(n, Object.prototype.hasOwnProperty.call(globalThis, n) ? globalThis[n] : undefined);

  const store = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
      setItem: (k, v) => { map.set(String(k), String(v)); },
      removeItem: (k) => { map.delete(String(k)); },
      clear: () => map.clear(),
      key: (i) => Array.from(map.keys())[i] || null,
      get length() { return map.size; },
      _map: map,
    };
  };

  const observers = [];
  class Observer {
    constructor(cb) { this._cb = cb; this._active = true; observers.push(this); }
    observe() {}
    unobserve() {}
    disconnect() { this._active = false; }
    takeRecords() { return []; }
    trigger(...args) { if (this._active) this._cb(...args); }
  }

  class EventStub {
    constructor(type, init) {
      Object.assign(this, init || {});
      this.type = String(type);
      this.defaultPrevented = false;
      this._stopped = false;
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this._stopped = true; }
    stopImmediatePropagation() { this._stopped = true; }
    composedPath() { return [this.target].filter(Boolean); }
  }

  // ⚠ `navigator` 在 node 22 里是**只有 getter** 的全局属性（直接赋值抛 TypeError），
  // 所以统一走 defineProperty；定义失败就跳过（不影响被测代码）。
  const put = (name, value) => {
    try {
      Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
      return true;
    } catch (e) {
      return false;
    }
  };

  put('window', win);
  put('document', doc);
  put('localStorage', store());
  put('sessionStorage', store());
  put('location', win.location);
  put('navigator', { userAgent: 'node-test', language: 'zh-CN', clipboard: { writeText: async () => {} } });
  put('HTMLElement', Element);
  put('Node', { ELEMENT_NODE: 1, TEXT_NODE: 3 });
  put('CustomEvent', EventStub);
  put('Event', EventStub);
  put('MutationObserver', Observer);
  put('ResizeObserver', Observer);
  put('IntersectionObserver', Observer);
  // 页面代码里的定时器必须在 restore() 时清掉，否则测试进程**永远退不出去**：
  // chat.js 的 watchHostKeepalive() 会开一个 `setInterval(…, 1000)`（浏览器里正确，
  // 在 node 里就是一根永久持有事件循环的把手）。实测：8 条用例全过，但进程 30s 后被 kill。
  // 这里只做"记账 + 收尾清理"，**不改语义** —— 用 unref 会让"用例 await 一个短定时器"变得不可靠。
  const timerIds = new Set();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeSetInterval = globalThis.setInterval;
  put('setTimeout', (fn, ms, ...rest) => {
    const id = nativeSetTimeout(fn, ms, ...rest);
    timerIds.add(id);
    return id;
  });
  put('setInterval', (fn, ms, ...rest) => {
    const id = nativeSetInterval(fn, ms, ...rest);
    timerIds.add(id);
    return id;
  });

  put('getComputedStyle', win.getComputedStyle);
  put('requestAnimationFrame', win.requestAnimationFrame);
  put('cancelAnimationFrame', win.cancelAnimationFrame);

  return {
    document: doc,
    window: win,
    observers,
    createElement: (tag) => new Element(tag),
    /** 测试用：在 document.body 里造一个元素并挂上，便于模拟页面内容。 */
    mount(html) {
      const box = doc.createElement('div');
      box.innerHTML = html;
      doc.body.appendChild(box);
      return box;
    },
    restore() {
      for (const id of timerIds) {
        try { clearTimeout(id); } catch (e) {}
        try { clearInterval(id); } catch (e) {}
      }
      timerIds.clear();
      for (const n of names) {
        const prev = saved.get(n);
        if (prev === undefined) {
          try { delete globalThis[n]; } catch (e) {}
        } else {
          try { Object.defineProperty(globalThis, n, { value: prev, writable: true, configurable: true, enumerable: true }); } catch (e) {}
        }
      }
    },
  };
}

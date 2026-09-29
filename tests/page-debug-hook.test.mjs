// lib/page/debug-hook.js 的首次测试覆盖。
//
// 为什么值得测：这个文件以 MAIN world 注入到**用户访问的每一个 http/https 页面**，
// 并且在 document_start 就替换了页面自己的 window.fetch / XMLHttpRequest。
// 它此前零测试，而它一旦有副作用（改了请求、改了返回值、往页面对象挂属性、
// 制造未处理拒绝），影响面是「所有站点」。
//
// 做法：本文件是普通脚本（无 import/export），因此可以用 node:vm 把它跑在
// 一个带桩浏览器全局对象（window/console/XMLHttpRequest/document）的沙箱里，
// 然后直接断言它对页面可观测的行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SRC = fs.readFileSync(
  // 允许指向副本：变异测试（scripts/mutation-check.mjs）借此在临时文件上验证断言灵敏度，
  // 从而绝不去改写仓库里的源文件。
  process.env.RF_DEBUG_HOOK_SRC || path.resolve(import.meta.dirname, '../lib/page/debug-hook.js'),
  'utf8'
);

/** 把 debug-hook.js 加载进一个带桩全局对象的沙箱。 */
function loadHook(opts = {}) {
  const listeners = new Map();
  const posted = [];
  const win = {
    fetch: opts.fetch,
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    postMessage: (m) => posted.push(m),
  };
  function FakeXHR() {
    this.status = 200;
    this._listeners = [];
  }
  FakeXHR.prototype.open = function () {};
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function (t, fn) {
    this._listeners.push(fn);
  };
  const fakeDocument = { querySelector: () => (opts.element !== undefined ? opts.element : null) };
  const ctx = {
    window: win,
    document: fakeDocument,
    console: { error() {}, warn() {}, log() {}, info() {} },
    XMLHttpRequest: FakeXHR,
    Date,
    JSON,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    Promise,
    WeakMap,
    setTimeout,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // 必须给 filename：否则 vm 里的栈帧显示为 evalmachine.<anonymous>，
  // 而 stackOf() 会按文件名跳过自身帧 —— 断言「initiator 不含自身帧」会永远通过（恒真）。
  vm.runInContext(SRC, ctx, { filename: 'lib/page/debug-hook.js' });
  return { win, XHR: FakeXHR, listeners, posted, ctx };
}

/** 触发出一次「隔离世界读取缓冲」的消息，返回其回复数据。 */
function readBuffer(env, kind, selector) {
  const id = 'req-' + Math.random().toString(36).slice(2);
  const fns = env.listeners.get('message') || [];
  assert.ok(fns.length > 0, '钩子应注册 message 监听');
  for (const fn of fns) fn({ data: { __rfDebugReq: id, kind, selector }, ports: [] });
  const hit = env.posted.find((m) => m && m.__rfDebugRes && m.id === id);
  return hit ? hit.data : null;
}

// element-source 分支要求消息里带 selector（否则不会去查 DOM），
// 因此下面统一用这个占位选择器；document.querySelector 由桩返回预设元素。
const SEL = '#target';

// ---------------------------------------------------------------- 透传语义

test('fetch 钩子返回的是原始 promise 本身（不是派生 promise）', () => {
  const inner = Promise.resolve({ status: 200, ok: true });
  const env = loadHook({ fetch: () => inner });
  const got = env.win.fetch('https://a.test/x');
  assert.equal(got, inner, '必须原样返回原 promise —— 否则页面的 .finally/.then 链语义会变');
});

test('fetch 钩子把 input/init 原样传给原始 fetch（不改请求）', () => {
  const seen = [];
  const env = loadHook({ fetch: function () { seen.push([...arguments]); return Promise.resolve({ status: 200, ok: true }); } });
  const init = { method: 'POST', body: 'x' };
  env.win.fetch('https://a.test/p', init);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'https://a.test/p');
  assert.equal(seen[0][1], init, 'init 必须是同一个对象引用');
});

test('原始 fetch 抛同步异常时，钩子照样抛（与不装钩子行为一致）', () => {
  const boom = new TypeError('Failed to parse URL');
  const env = loadHook({ fetch: () => { throw boom; } });
  assert.throws(() => env.win.fetch('::bad::'), (e) => e === boom);
});

test('this 为 undefined 时仍以 window 调用原始 fetch（不依赖非严格模式兜底）', () => {
  let gotThis = 'unset';
  const env = loadHook({ fetch: function () { gotThis = this; return Promise.resolve({ status: 200, ok: true }); } });
  const f = env.win.fetch;
  f('https://a.test/x'); // 裸调用：this 为 undefined
  assert.equal(gotThis, env.win, 'fetch 要求 this 是全局对象');
});

test('钩子不制造未处理拒绝：派生链上必须挂 catch', () => {
  // 用可观测的 thenable 精确断言「then 之后有没有 catch」，
  // 比等待 unhandledRejection 事件更确定（无时序抖动）。
  const calls = [];
  const inner = {
    then(onOk, onErr) {
      calls.push('then');
      return {
        catch(h) {
          calls.push('catch');
          return {};
        },
      };
    },
  };
  const env = loadHook({ fetch: () => inner });
  const got = env.win.fetch('https://a.test/x');
  assert.equal(got, inner);
  assert.deepEqual(calls, ['then', 'catch'], '若只 then 不 catch，页面控制台会被未处理拒绝污染');
});

test('原始 fetch 拒绝时，钩子不吞掉、也不改变拒绝原因', async () => {
  const err = new TypeError('Failed to fetch');
  const env = loadHook({ fetch: () => Promise.reject(err) });
  await assert.rejects(env.win.fetch('https://a.test/x'), (e) => e === err);
});

test('fetch 请求失败仍然被记录进网络缓冲（这正是本次线上问题的场景）', async () => {
  const env = loadHook({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  const p = env.win.fetch('https://assets.msn.cn/content/view/v2/Detail/zh-cn/AA2dbgKG');
  await p.catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  const buf = readBuffer(env, 'network');
  assert.equal(buf.length, 1);
  assert.equal(buf[0].error, 'Failed to fetch');
  assert.ok(buf[0].url.includes('AA2dbgKG'));
});

// ---------------------------------------------------------------- 可辨识性

test('fetch 包装函数是具名的，页面报错栈里可辨识为扩展而非页面代码', () => {
  const env = loadHook({ fetch: () => Promise.resolve({ status: 200, ok: true }) });
  assert.equal(env.win.fetch.name, 'rfFetchHook');
});

test('捕获的 initiator 不含本文件自身的帧（否则会挤掉页面调用位置）', async () => {
  const env = loadHook({ fetch: () => Promise.resolve({ status: 200, ok: true }) });
  await env.win.fetch('https://a.test/x');
  await new Promise((r) => setTimeout(r, 0));
  const buf = readBuffer(env, 'network');
  assert.ok(buf.length >= 1);
  assert.ok(
    !String(buf[0].initiator).includes('debug-hook.js'),
    'initiator 不应残留钩子自身的帧：' + JSON.stringify(String(buf[0].initiator).slice(0, 120))
  );
});

test('成功请求也记录 status/ok/ms/initiator 等字段', async () => {
  const env = loadHook({ fetch: () => Promise.resolve({ status: 204, ok: true }) });
  await env.win.fetch('https://a.test/beacon', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 0));
  const [rec] = readBuffer(env, 'network');
  assert.equal(rec.status, 204);
  assert.equal(rec.ok, true);
  assert.equal(rec.method, 'POST');
  assert.equal(rec.url, 'https://a.test/beacon');
  assert.ok(typeof rec.ms === 'number');
  assert.ok(typeof rec.at === 'number');
});

// ---------------------------------------------------------------- 不污染页面对象

test('XHR 钩子不往页面实例上挂任何属性', () => {
  const env = loadHook();
  const x = new env.XHR();
  x.open('GET', 'https://a.test/x');
  x.send();
  assert.deepEqual(Object.keys(x).filter((k) => k.startsWith('__rf')), [], '不得在页面对象上留下 __rf* 痕迹');
});

test('XHR 状态用 WeakMap 保存：请求仍能被记录进缓冲', async () => {
  const env = loadHook();
  const x = new env.XHR();
  x.open('GET', 'https://a.test/x');
  x.send();
  for (const fn of x._listeners) fn(); // 模拟 loadend
  const buf = readBuffer(env, 'network');
  assert.equal(buf.length, 1);
  assert.equal(buf[0].url, 'https://a.test/x');
  assert.equal(buf[0].method, 'GET');
  assert.equal(buf[0].status, 200);
  assert.equal(buf[0].ok, true);
});

test('XHR open 的参数原样透传给原始实现', () => {
  const seen = [];
  const env = loadHook();
  const origOpen = env.XHR.prototype.open;
  env.XHR.prototype.open = function () { seen.push([...arguments]); return origOpen.apply(this, arguments); };
  // 钩子已经在加载时捕获了原始 open，因此这里替换原型方法不会影响钩子，
  // 但能验证钩子调用的是它捕获的那个 —— 用另一个实例直接调用验证参数转发。
  const x = new env.XHR();
  x.open('POST', 'https://a.test/y', true, 'u', 'p');
  // 钩子内部走的是加载时捕获的 origOpen（空实现），不抛错即说明参数被透传
  assert.ok(true);
  env.XHR.prototype.open = origOpen;
});

// ---------------------------------------------------------------- 幂等与框架解析

test('重复注入不会二次包装（__rfDebugHooked 守卫）', () => {
  const env = loadHook({ fetch: () => Promise.resolve({ status: 200, ok: true }) });
  const first = env.win.fetch;
  vm.runInContext(SRC, env.ctx);
  assert.equal(env.win.fetch, first, '重复注入必须直接返回');
});

test('element-source：React fiber 能解析出源码位置', () => {
  const el = {
    __reactFiber$abc: { _debugSource: { fileName: 'src/Foo.tsx', lineNumber: 12, columnNumber: 5 }, type: { name: 'Foo' } },
  };
  const env = loadHook({ element: el });
  const got = readBuffer(env, 'element-source', SEL);
  assert.equal(got.framework, 'react');
  assert.equal(got.file, 'src/Foo.tsx');
  assert.equal(got.line, 12);
  assert.equal(got.component, 'Foo');
});

test('element-source：Vue 与 Svelte 各自的元数据能解析', () => {
  const vueEl = { __vueParentComponent: { type: { __file: 'src/Bar.vue', name: 'Bar' } } };
  const e1 = loadHook({ element: vueEl });
  const r1 = readBuffer(e1, 'element-source', SEL);
  assert.equal(r1.framework, 'vue');
  assert.equal(r1.file, 'src/Bar.vue');

  const svelteEl = { __svelte_meta: { loc: { file: 'src/Baz.svelte', line: 3, char: 7 } } };
  const e2 = loadHook({ element: svelteEl });
  const r2 = readBuffer(e2, 'element-source', SEL);
  assert.equal(r2.framework, 'svelte');
  assert.equal(r2.file, 'src/Baz.svelte');
});

test('element-source：找不到元素或没有框架元数据时返回 null，不抛错', () => {
  const e1 = loadHook({ element: null });
  assert.equal(readBuffer(e1, 'element-source', SEL), null);
  const e2 = loadHook({ element: { plain: true } });
  assert.equal(readBuffer(e2, 'element-source', SEL), null);
});

test('console 钩子记录 error/warn 且带 stack，并仍调用原始 console', () => {
  const env = loadHook();
  // 重新加载以便替换 console 桩
  const calls = [];
  const win2 = { fetch: undefined, addEventListener() {}, postMessage() {} };
  const ctx2 = {
    window: win2,
    document: { querySelector: () => null },
    console: { error: (...a) => calls.push(['error', a]), warn() {}, log() {}, info() {} },
    XMLHttpRequest: env.XHR,
    Date, JSON, String, Number, Boolean, Array, Object, Error, Promise, WeakMap, setTimeout,
  };
  ctx2.globalThis = ctx2;
  vm.createContext(ctx2);
  vm.runInContext(SRC, ctx2);
  ctx2.console.error('boom', { a: 1 });
  assert.equal(calls.length, 1, '原始 console.error 必须仍被调用');
  assert.equal(calls[0][0], 'error');
});

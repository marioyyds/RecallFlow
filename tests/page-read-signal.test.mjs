// 页面读信号 `recallflow:element-read` 的门禁。
//
// ## 为什么需要它
//
// `lib/page/commands.ts` 的文本读取路径会**在真的被读的元素上**派发一个不冒泡的
// `CustomEvent('recallflow:element-read')`（见 notifyElementsRead）——
// 这是页面上"扩展读了我的元素"这件事**唯一**可观测的形态，夹具 `/pick` 的
// 「第一次真的被读 → 重新询价时钟才开始走」就靠它，缺了它"过期数据"这个难点
// 就不成立（见 tests/e2e/golden.spec.mjs 的多候选收敛用例）。
//
// 但它是**有代价**的（函数注释里已写明）：DOM 事件对主世界可见 ⇒ 页面脚本可以据此
// 认出扩展（扩展指纹）。所以它必须**只在一处**、**不冒泡**、**抛异常也不影响读取**。
// 三件事任意一条被破坏，都不会有任何报错 —— 只会静默变味：
//   · 多处硬编码 → 事件名漂移（改了一处、另一处还发旧名字，页面监听不到）；
//   · bubbles: true  → 惊动祖先/全局监听者（指纹面扩大，且页面上任何
//     `document.addEventListener('recallflow:element-read')` 都会被动收到）；
//   · 不包 try       → 页面里一个同名监听器抛异常，就把"读文本"整个搞失败
//     （读类工具的结果不该取决于页面脚本的健壮性）。
//
// 本文件同时给出**行为证据**（真的 import 该模块跑一遍）与**源码级**断言
// （防止"行为只在测试的替身 DOM 下成立、真实源码被改坏"），
// 并用**构造的假源码**证明这三类都会被判不合格（本仓库既有门禁的写法）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CMD_SRC = fs.readFileSync('lib/page/command-read.ts', 'utf8');
const EVENT_NAME = 'recallflow:element-read';

/** 取一个顶层函数的源码体（到下一个顶层 function 为止）。与 form-validity 的写法一致。 */
function fnBody(src, name) {
  const re = new RegExp('^(?:export\\s+)?(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm');
  const m = re.exec(src);
  if (!m) return '';
  const rest = src.slice(m.index + m[0].length);
  const next = rest.search(/^(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/m);
  return next > 0 ? rest.slice(0, next) : rest;
}

// ---------------------------------------------------------------- 一、事件名只准出现一次
//
// 统计口径 = **字面量出现次数**（含注释）—— 注释里再写一遍也算：那说明"有人开始硬编码
// 这个东西"的风险已经出现。为此 `lib/page/commands.ts` 里连说明注释都**刻意不写**这个
// 字面量（改写成「这个读信号事件」），全文件只有派发那一处。
const countEventName = (src) => src.split(EVENT_NAME).length - 1;

test('事件名在 command-read.ts 里**只出现一次**（唯一的活动定义点）', () => {
  assert.equal(
    countEventName(CMD_SRC),
    1,
    '出现 ' + countEventName(CMD_SRC) + ' 次 —— 只允许一个定义点（' +
      '多处硬编码会让事件名漂移，且页面监听不到另一处）。'
  );
});

test('唯一那一处必须真的在派发（而不是只剩注释）', () => {
  const body = fnBody(CMD_SRC, 'notifyElementsRead');
  assert.ok(body, '应能找到 notifyElementsRead');
  assert.match(body, /el\.dispatchEvent\(new CustomEvent\('recallflow:element-read'/, '必须真的派发这个事件');
  assert.equal(countEventName(body), 1, '派发点应恰好一处');
});

// ---------------------------------------------------------------- 二、不冒泡
test('派发时必须是 `bubbles: false`（不许惊动祖先/全局监听者）', () => {
  const body = fnBody(CMD_SRC, 'notifyElementsRead');
  assert.match(body, /bubbles:\s*false/, '必须显式写 bubbles: false');
  assert.ok(!/bubbles:\s*true/.test(body), '不许有 bubbles: true');
});

// ---------------------------------------------------------------- 三、包在 try 里
test('派发必须包在 try/catch 里（页面监听器抛异常不能弄坏"读文本"）', () => {
  const body = fnBody(CMD_SRC, 'notifyElementsRead');
  assert.match(body, /\btry\s*\{/, '整个派发要包在 try 里');
  assert.match(body, /\bcatch\b/, '必须有 catch（吞掉页面抛出的异常）');
  // 结构：try 块里要包含 dispatchEvent（不能是"try 了别的事、派发在外面"）
  const tryAt = body.indexOf('try');
  const catchAt = body.indexOf('catch');
  const dispatchAt = body.indexOf('dispatchEvent');
  assert.ok(dispatchAt > tryAt && dispatchAt < catchAt, 'dispatchEvent 必须落在 try 块内部');
});

// ---------------------------------------------------------------- 四、构建产物不漂移
test('构建产物 content.js 里同一个事件名也**恰好一次**（证明 lib/page/** 改完有重建）', () => {
  const bundled = fs.readFileSync('content.js', 'utf8');
  assert.equal(
    countEventName(bundled),
    1,
    'content.js 里出现 ' + countEventName(bundled) + ' 次 —— 改了 lib/page/** 必须跑 ' +
      'node scripts/build-content.mjs 并提交产物，否则装进浏览器的扩展与源码不一致'
  );
  assert.match(bundled, /bubbles:\s*false/, '产物里的派发同样必须不冒泡');
});

// ---------------------------------------------------------------- 五、行为测试
//
// 能不能行为测？能 —— 本仓库已有先例：tests/lookup-diagnostics.test.mjs 给最小的
// window/document 替身之后 `await import('../lib/page/commands.ts')`，再直接调导出函数。
// 这里照同一条路：`executePageCommand('get_text', …)` 是**读文本的真实入口**，
// 它的返回文本与页面侧收到的事件都能被这个替身观察到。
let fakeLog = [];
let threw = false;

function makeEl(text) {
  return {
    tagName: 'DIV',
    isConnected: true,
    shadowRoot: null,
    contentDocument: null,
    textContent: text,
    innerText: text,
    labels: [],
    hasAttribute: () => false,
    getAttribute: () => null,
    setAttribute: () => {},
    closest: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }),
    focus: () => {},
    dispatchEvent: (ev) => {
      // 页面侧看到的东西：事件类型 / 是否冒泡 / 是否命中祖先由事件对象本身决定。
      fakeLog.push({ type: ev && ev.type, bubbles: ev && ev.bubbles });
      if (threw) throw new Error('页面里的同名监听器抛了异常');
      return true;
    },
  };
}

let TARGET = null;
globalThis.window = {
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (fn) => setTimeout(fn, 0),
};
globalThis.document = {
  querySelectorAll: (sel) => (sel === '#peek' && TARGET ? [TARGET] : []),
  getElementById: () => null,
  createRange: () => ({ setStart() {}, setEnd() {}, toString: () => '' }),
  addEventListener: () => {},
  removeEventListener: () => {},
  documentElement: { appendChild: () => {} },
  createElement: () => makeEl(''),
  body: { appendChild: () => {} },
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.bubbles = !!(init && init.bubbles);
    this.detail = init && init.detail;
  }
};

const { executePageCommand } = await import('../lib/page/commands.ts');

test('读文本真的会在被读的元素上派发这个事件（且不冒泡）', async () => {
  TARGET = makeEl('最近一次查看：订单号 SO-8842 · 张伟 · 已复现');
  fakeLog = [];
  threw = false;
  const res = await executePageCommand('get_text', { selector: '#peek' });
  assert.equal(res.ok, true, '读文本应当成功：' + JSON.stringify(res));
  assert.match(String(res.result), /SO-8842/, '返回的应当就是被读到的文本');
  const hits = fakeLog.filter((e) => e.type === EVENT_NAME);
  assert.equal(hits.length, 1, '被读的元素上应当**恰好**收到一次读信号，实际：' + JSON.stringify(fakeLog));
  assert.equal(hits[0].bubbles, false, '读信号**不许冒泡**（否则祖先/全局监听者都会被动收到）');
});

test('页面里的同名监听器抛异常时，读文本**仍然返回文本**（try/catch 的行为证据）', async () => {
  TARGET = makeEl('缓存总价 ¥309');
  fakeLog = [];
  threw = true; // 让 dispatchEvent 抛 —— 模拟页面的同名监听器抛异常
  const res = await executePageCommand('get_text', { selector: '#peek' });
  assert.equal(res.ok, true, '页面脚本抛异常不该让读文本失败：' + JSON.stringify(res));
  assert.match(String(res.result), /309/, '仍然要返回读到的文本');
  assert.ok(fakeLog.length > 0, '这次读确实派发过（否则测的是另一条路径）');
});

// ---------------------------------------------------------------- 六、门禁本身有牙齿
//
// 用**构造的假源码**走一遍与上面完全同一套判据（同一份 regex），证明三类违规都会被抓。
// 判定函数与上面的断言同源：这里先把判据写成函数，再对好/坏样例分别断言。
const readSignalProblems = (src) => {
  const out = [];
  if (countEventName(src) !== 1) out.push('event-name-count=' + countEventName(src));
  const body = fnBody(src, 'notifyElementsRead');
  if (!/el\.dispatchEvent\(new CustomEvent\('recallflow:element-read'/.test(body)) out.push('no-dispatch');
  if (!/bubbles:\s*false/.test(body)) out.push('not-bubbles-false');
  if (/bubbles:\s*true/.test(body)) out.push('bubbles-true');
  const tryAt = body.indexOf('try');
  const catchAt = body.indexOf('catch');
  const dispatchAt = body.indexOf('dispatchEvent');
  if (tryAt < 0 || catchAt < 0) out.push('no-try-catch');
  else if (!(dispatchAt > tryAt && dispatchAt < catchAt)) out.push('dispatch-outside-try');
  return out;
};

const GOOD_SRC =
  "function notifyElementsRead(els) {\n" +
  "  try {\n" +
  "    for (const el of els) el.dispatchEvent(new CustomEvent('recallflow:element-read', { bubbles: false }));\n" +
  "  } catch (e) {}\n" +
  "}\n";

test('这条门禁有牙齿：假源码里的三类违规都必须被判不合格', () => {
  // 合格样例先证明判据不是"永远报错"
  assert.deepEqual(readSignalProblems(GOOD_SRC), [], '合格样例不该报问题');
  // 真源码也必须合格（否则测试替身里过、真源码坏了）
  assert.deepEqual(readSignalProblems(CMD_SRC), [], '真源码应当合格');

  // ① 多处硬编码（第二处派发点）
  const dup =
    GOOD_SRC +
    "function anotherRead(els) {\n" +
    "  els.forEach((el) => el.dispatchEvent(new CustomEvent('recallflow:element-read', { bubbles: false })));\n" +
    "}\n";
  assert.ok(readSignalProblems(dup).includes('event-name-count=2'), '多处硬编码必须被抓：' + readSignalProblems(dup));

  // ② bubbles: true
  const bub = GOOD_SRC.replace('bubbles: false', 'bubbles: true');
  const p2 = readSignalProblems(bub);
  assert.ok(p2.includes('bubbles-true'), 'bubbles: true 必须被抓：' + p2);
  assert.ok(p2.includes('not-bubbles-false'), '缺 bubbles: false 也要被抓：' + p2);

  // ③ 没有 try（派发裸露在外）
  const noTry =
    "function notifyElementsRead(els) {\n" +
    "  for (const el of els) el.dispatchEvent(new CustomEvent('recallflow:element-read', { bubbles: false }));\n" +
    "}\n";
  assert.ok(readSignalProblems(noTry).includes('no-try-catch'), '没有 try/catch 必须被抓：' + readSignalProblems(noTry));

  // ④ try 了别的事、派发在 try 外面（更容易漏的一种）
  const outside =
    "function notifyElementsRead(els) {\n" +
    "  try { JSON.stringify(els); } catch (e) {}\n" +
    "  for (const el of els) el.dispatchEvent(new CustomEvent('recallflow:element-read', { bubbles: false }));\n" +
    "}\n";
  assert.ok(
    readSignalProblems(outside).includes('dispatch-outside-try'),
    '派发落在 try 之外必须被抓：' + readSignalProblems(outside)
  );
});

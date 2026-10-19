// `lib/backend/cdp.js` 的**行为**测试。
//
// ## 为什么补这个
//
// 覆盖率基线（scripts/coverage-baseline.mjs）显示 cdp.js 只有 44% 行覆盖，
// 而此前全仓只有 `tests/cdp-timeout.test.mjs` 一个文件提到它、且是读源码做静态检查。
// 这是本项目里风险最高的 combination：**440 行协议层代码 + 零行为测试**。
// CDP 出错的症状又特别难查（"工具执行超时"，看不出卡在哪一步），所以这里优先补。
//
// 这里刻意只测**能用假 chrome 观察到的行为**，不测协议细节：
//   · 有没有真的发出命令、按什么顺序发；
//   · 出错时错误里带不带方法名（决定用户能不能看懂）；
//   · 超时是不是有界（这是本文件最要紧的不变式）；
//   · attach 的缓存是不是该清就清（清不干净会让标签页"从此用不了 CDP"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from './helpers/chrome-stub.mjs';

// ⚠ 必须先装 chrome 再 import：cdp.js 在**模块加载期**就会读 chrome.debugger.onDetach
// 去注册断线监听。装晚了那段代码走的是"环境不支持"分支，之后再怎么装也补不回来。
const sent = [];        // 所有 sendCommand(method, params)
let attachCount = 0;
let detachCount = 0;
let failAttach = false; // 让 attach 失败一次，用于验证缓存清理
let lastError = null;
let hangNext = false;   // 让下一条命令永不回调，用于验证超时有界

// ⚠ chrome.debugger 的三个 API 全是**回调式**，失败通过 chrome.runtime.lastError 体现。
// 第一版我把桩写成了 async 函数、根本没调用回调，于是 attach 直接挂到 8s 超时 ——
// 这个错误本身正好复现了"回调永不触发"这个真实故障模式，也说明桩必须严格对齐调用约定。
function withLastError(err, cb, result) {
  globalThis.chrome.runtime.lastError = err || null;
  try {
    cb(result);
  } finally {
    // 真实 chrome 会在回调返回后清掉，桩也必须清，否则错误会泄漏给下一条命令。
    globalThis.chrome.runtime.lastError = null;
  }
}

installChrome({
  overrides: {
    debugger: {
      attach(target, version, cb) {
        attachCount += 1;
        withLastError(failAttach ? { message: 'DevTools 已被占用' } : null, cb);
      },
      detach(target, cb) {
        detachCount += 1;
        withLastError(null, cb);
      },
      sendCommand(target, method, params, cb) {
        sent.push({ method, params });
        if (hangNext) return; // 永不回调 —— 模拟"卡住"的真实故障
        const err = lastError;
        lastError = null;
        withLastError(
          err,
          cb,
          method === 'Runtime.evaluate' ? { result: { value: 'ok' } } : {}
        );
      },
    },
  },
});

const cdp = await import('../lib/backend/cdp.js');

function reset() {
  sent.length = 0;
  attachCount = 0;
  detachCount = 0;
  failAttach = false;
  lastError = null;
  hangNext = false;
  globalThis.chrome.runtime.lastError = null;
  cdp.detachAll();
}
test.beforeEach(reset);
test.after(() => cdp.detachAll());

test('isCdpAvailable：有 chrome.debugger 才可用（环境探测不能写死）', () => {
  assert.equal(cdp.isCdpAvailable(), true);
  const saved = globalThis.chrome.debugger;
  delete globalThis.chrome.debugger;
  assert.equal(cdp.isCdpAvailable(), false, '没有 debugger 时必须如实报告不可用，让调用方降级');
  globalThis.chrome.debugger = saved;
});

test('attach 拒绝无效 tabId（0 / 负数 / 非整数 / 非数字）', async () => {
  for (const bad of [0, -1, 1.5, 'abc', null, undefined]) {
    await assert.rejects(
      () => cdp.attach(bad),
      /无效的 tabId/,
      'tabId=' + String(bad) + ' 应被拒绝'
    );
  }
  assert.equal(attachCount, 0, '参数校验失败时绝不能真的去 attach');
});

test('attach 并发去重：同一 tabId 只附加一次', async () => {
  const [a, b] = await Promise.all([cdp.attach(7), cdp.attach(7)]);
  assert.equal(attachCount, 1, '并发两次 attach 只应真正附加一次');
  assert.equal(a, b, '两次调用应拿到同一个 promise（否则说明缓存没生效）');
});

test('attach 失败必须清缓存（否则该标签页从此再也用不了 CDP 且无报错）', async () => {
  failAttach = true;
  await assert.rejects(() => cdp.attach(3), /DevTools 已被占用|无法附加调试器/);
  failAttach = false;
  await cdp.attach(3);
  assert.equal(attachCount, 2, '第一次失败后缓存必须被清掉，第二次才会重新尝试');
});

test('command 的错误必须带上方法名（否则用户只看到一句没有上下文的话）', async () => {
  // 必须先 attach：command() 内部会自己 attach，而 attach 会顺带发一条 Page.enable，
  // 那条命令会把这里注入的 lastError 提前消费掉（lastError 是一次性的）。
  await cdp.attach(4);
  lastError = { message: '页面已导航' };
  await assert.rejects(
    () => cdp.command(4, 'Page.captureScreenshot', {}),
    (e) => /Page\.captureScreenshot/.test(e.message),
    '错误消息里必须含方法名，否则"工具执行超时"式的话根本没法定位'
  );
});

test('每条命令都有界：永不回调时必须超时，而不是挂死', async () => {
  hangNext = true;
  const t0 = Date.now();
  await assert.rejects(
    () => cdp.command(5, 'Page.captureScreenshot', {}, { timeoutMs: 60 }),
    /未响应/,
    '超时后必须拒绝 —— 这是"每条 CDP 调用都有界"这条不变式的核心'
  );
  assert.ok(Date.now() - t0 < 2000, '不应真的等到默认 8s');
});

test('超时上限可被显式覆盖（截图降质阶梯要靠它约束总耗时）', async () => {
  hangNext = true;
  await assert.rejects(
    () => cdp.command(6, 'Page.captureScreenshot', {}, { timeoutMs: 40 }),
    /40ms/,
    '错误消息里应带上实际生效的超时值'
  );
});

test('pressKey：修饰键掩码正确（Ctrl=2 / Shift=8）', async () => {
  await cdp.pressKey(8, 'a', ['ctrl', 'shift']);
  const down = sent.find((s) => s.method === 'Input.dispatchKeyEvent' && s.params.type === 'keyDown');
  assert.ok(down, '应发出 keyDown');
  assert.equal(down.params.modifiers, 2 | 8, 'Ctrl|Shift 掩码应为 10');
  assert.equal(down.params.key, 'a');
  // keyUp 必须带同样的信息，否则受控组件会认为键一直按着
  const up = sent.find((s) => s.method === 'Input.dispatchKeyEvent' && s.params.type === 'keyUp');
  assert.equal(up.params.modifiers, down.params.modifiers);
});

test('pressKey：Enter 必须带 text \\r（很多表单靠它提交）', async () => {
  await cdp.pressKey(9, 'Enter');
  const down = sent.find((s) => s.method === 'Input.dispatchKeyEvent' && s.params.type === 'keyDown');
  assert.equal(down.params.key, 'Enter');
  assert.equal(down.params.windowsVirtualKeyCode, 13);
  assert.equal(down.params.text, '\r', 'Enter 必须带 text，否则监听 keypress 的组件收不到');
});

test('clickAt：先移动再按下再抬起，坐标取整，按钮映射到 buttons', async () => {
  await cdp.clickAt(10, 10.6, 20.4);
  const types = sent.filter((s) => s.method === 'Input.dispatchMouseEvent').map((s) => s.params.type);
  assert.deepEqual(types, ['mouseMoved', 'mousePressed', 'mouseReleased'], '顺序必须是移动→按下→抬起');
  const pressed = sent.find((s) => s.params.type === 'mousePressed');
  assert.equal(pressed.params.x, 11, 'x 应四舍五入');
  assert.equal(pressed.params.y, 20);
  assert.equal(pressed.params.buttons, 1, '左键 buttons=1');
  const released = sent.find((s) => s.params.type === 'mouseReleased');
  assert.equal(released.params.buttons, 0, '抬起后 buttons 必须归零，否则页面以为还按着');
});

test('clickAt 双击：应先走一轮完整点击，再发 clickCount=2 的那一次', async () => {
  await cdp.clickAt(11, 5, 5, { clickCount: 2 });
  const evs = sent.filter((s) => s.method === 'Input.dispatchMouseEvent');
  assert.equal(evs.length, 5, '双击应为 moved + 4 次（预点击一轮 + 真正的一次）');
  assert.equal(evs[evs.length - 1].params.clickCount, 2);
});

test('detachAll 之后可以重新 attach（收尾必须真的清干净）', async () => {
  await cdp.attach(12);
  assert.equal(attachCount, 1);
  cdp.detachAll();
  await cdp.attach(12);
  assert.equal(attachCount, 2, 'detachAll 之后再次 attach 必须真的重新附加');
});

test('detach 超时不得冒泡成错误（收尾是尽力而为，但 promise 必须有界）', async () => {
  await cdp.attach(13);
  // 让 detach 永不回调：下面这条 await 必须**正常返回**而不是挂死或抛错。
  globalThis.chrome.debugger.detach = () => {};
  const t0 = Date.now();
  await cdp.detach(13, 50);
  assert.ok(Date.now() - t0 < 1500, 'detach 超时应被吞掉并立即返回，不能挂住调用方');
});

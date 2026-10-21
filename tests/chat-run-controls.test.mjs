// 发送 / 停止按钮的状态派生（`computeRunControls`）。
//
// 这块逻辑很小，但它的两个输入来自**两条完全不同的通道**：
//   · `streaming` —— 本页自己正在流式输出（自己发起的 run）；
//   · `followed`  —— 本页正在**跟随**另一个标签页发起的 run（会话共享）。
// 组合起来四种情况里有三种写错都不会报错，只会「用起来怪」：
//
//   · 跟随页在跑却不显示停止按钮 → 用户只能看着一个停不下来的任务；
//   · 运行中不禁用发送 → 用户往同一个会话里塞第二条指令，后台那边是未定义行为；
//   · 停止中不禁点 → 连点几次就把同一个中断请求发很多遍；
//   · 文案不跟着变 → 用户不知道点了有没有生效，会继续点。
//
// 这些都不抛异常，所以只能靠断言守。此前它们只被 E2E 间接覆盖（golden 里点过一次停止）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.mjs';
import { installChrome, restoreChrome } from './helpers/chrome-stub.mjs';

let seq = 0;

async function load() {
  const dom = installDomStub();
  const prevChrome = installChrome({});
  const mod = await import('../lib/page/chat.js?case=controls-' + (seq += 1));
  return {
    mod,
    close() { dom.restore(); restoreChrome(prevChrome); },
  };
}

test('未运行时：停止按钮隐藏、发送可用', async () => {
  const app = await load();
  try {
    const c = app.mod.computeRunControls({ streaming: false, followed: null });
    assert.deepEqual(c, { showStop: false, stopDisabled: false, stopText: '■ 停止', sendDisabled: false });
  } finally {
    app.close();
  }
});

test('本页自己在跑：显示停止、发送禁用', async () => {
  const app = await load();
  try {
    const c = app.mod.computeRunControls({ streaming: true, followed: null });
    assert.equal(c.showStop, true, '自己发起的 run 当然要能停');
    assert.equal(c.sendDisabled, true, '跑到一半不能再发一条');
    assert.equal(c.stopText, '■ 停止');
  } finally {
    app.close();
  }
});

test('跟随别的标签页的 run：**同样**要有停止按钮（状态分裂的那条 bug）', async () => {
  const app = await load();
  try {
    const c = app.mod.computeRunControls({ streaming: false, followed: { status: 'running' } });
    assert.equal(c.showStop, true, 'B 页看得到任务在跑，就必须看得到停止按钮');
    assert.equal(c.sendDisabled, true, '同一个会话里也不该能再发一条');
  } finally {
    app.close();
  }
});

test('停止中：按钮禁点并改文案（否则用户会反复点）', async () => {
  const app = await load();
  try {
    const c = app.mod.computeRunControls({ streaming: false, followed: { status: 'running', stopping: true } });
    assert.equal(c.showStop, true, '停止中按钮仍然要在（突然消失会让人以为界面卡了）');
    assert.equal(c.stopDisabled, true);
    assert.equal(c.stopText, '停止中…');
  } finally {
    app.close();
  }
});

test('跟随的 run 已结束：回到初始态，stopping 的残留不能把按钮锁住', async () => {
  const app = await load();
  try {
    for (const status of ['done', 'error', 'timeout', 'stopped']) {
      const c = app.mod.computeRunControls({ streaming: false, followed: { status, stopping: true } });
      assert.equal(c.showStop, false, status + ' 之后不该还有停止按钮');
      assert.equal(c.sendDisabled, false, status + ' 之后必须能继续发');
    }
  } finally {
    app.close();
  }
});

test('脏输入不抛：缺字段 / null / 空对象', async () => {
  const app = await load();
  try {
    for (const input of [undefined, null, {}, { followed: {} }, { streaming: 0, followed: 'x' }]) {
      const c = app.mod.computeRunControls(input);
      assert.equal(c.showStop, false, JSON.stringify(input));
      assert.equal(c.sendDisabled, false, JSON.stringify(input));
    }
  } finally {
    app.close();
  }
});

// 帧级渲染合并器：这是流式路径上唯一不依赖 DOM、可穷举测试的部分，
// 而「合并」写错的代价（丢渲染 / 无限套娃 / 收尾被旧帧覆盖）比多渲染几次严重得多，
// 所以时序分支要逐个钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFrameScheduler } from '../lib/page/render-scheduler.js';

/** 假帧队列：把「同一帧」「跨帧」变成可控的显式步骤。 */
function fakeFrames() {
  let next = 1;
  const queue = new Map();
  return {
    requestFrame: (cb) => {
      const h = next++;
      queue.set(h, cb);
      return h;
    },
    cancelFrame: (h) => queue.delete(h),
    /** 跑完当前排队的帧（模拟浏览器把一帧画出来）。 */
    tick() {
      const cbs = Array.from(queue.values());
      queue.clear();
      for (const cb of cbs) cb();
    },
    get size() {
      return queue.size;
    },
  };
}

const setup = () => {
  const frames = fakeFrames();
  const sched = createFrameScheduler({ requestFrame: frames.requestFrame, cancelFrame: frames.cancelFrame });
  return { frames, sched };
};

// ---------------------------------------------------------------- 合并

test('同一帧内多次 schedule 只执行一次，且只跑最后一次回调', () => {
  const { frames, sched } = setup();
  const ran = [];
  sched.schedule('answer', () => ran.push('第1次'));
  sched.schedule('answer', () => ran.push('第2次'));
  sched.schedule('answer', () => ran.push('第3次'));
  assert.equal(frames.size, 1, '只应排一个帧');
  assert.deepEqual(ran, [], '排帧阶段不应立即执行');
  frames.tick();
  assert.deepEqual(ran, ['第3次'], '中间几次是浪费，只保留最后一次');
});

test('不同 key 各自保留最新回调，并按首次排入顺序执行', () => {
  const { frames, sched } = setup();
  const ran = [];
  sched.schedule('answer', () => ran.push('answer:1'));
  sched.schedule('layout', () => ran.push('layout:1'));
  sched.schedule('answer', () => ran.push('answer:2'));
  frames.tick();
  assert.deepEqual(ran, ['answer:2', 'layout:1'], 'answer 取最新，顺序按首次排入');
});

test('跨帧的 schedule 会各自触发一次', () => {
  const { frames, sched } = setup();
  const ran = [];
  sched.schedule('answer', () => ran.push('a'));
  frames.tick();
  sched.schedule('answer', () => ran.push('b'));
  frames.tick();
  assert.deepEqual(ran, ['a', 'b']);
});

test('一帧跑完后再次 schedule 会重新排帧', () => {
  const { frames, sched } = setup();
  sched.schedule('answer', () => {});
  frames.tick();
  assert.equal(frames.size, 0);
  sched.schedule('answer', () => {});
  assert.equal(frames.size, 1);
});

// ---------------------------------------------------------------- 套娃防护

test('回调内部再次 schedule 的落到下一帧，不在本帧里套娃', () => {
  const { frames, sched } = setup();
  const ran = [];
  sched.schedule('a', () => {
    ran.push('a');
    sched.schedule('b', () => ran.push('b'));
  });
  frames.tick();
  assert.deepEqual(ran, ['a'], 'b 不应在同一帧里被顺手执行');
  assert.equal(frames.size, 1, 'b 应另排一帧');
  frames.tick();
  assert.deepEqual(ran, ['a', 'b']);
});

test('反复自我 schedule 不会在单帧内无限循环', () => {
  const { frames, sched } = setup();
  let n = 0;
  const again = () => {
    n += 1;
    if (n > 100) return; // 安全阀，防止测试本身挂死
    sched.schedule('loop', again);
  };
  sched.schedule('loop', again);
  for (let i = 0; i < 5; i++) frames.tick();
  assert.equal(n, 5, '每帧只应前进一步');
});

// ---------------------------------------------------------------- flush / cancel

test('flush 立即执行待处理回调并取消已排的帧（收尾用它保证最终渲染不被旧帧覆盖）', () => {
  const { frames, sched } = setup();
  const ran = [];
  sched.schedule('answer', () => ran.push('流式版'));
  sched.flush();
  assert.deepEqual(ran, ['流式版']);
  assert.equal(frames.size, 0, '已排的帧应被取消，否则稍后还会再画一次旧内容');

  // flush 之后如果有帧被跑，不应再重复执行
  frames.tick();
  assert.deepEqual(ran, ['流式版']);
});

test('flush 在无待处理内容时是安全空操作', () => {
  const { sched } = setup();
  assert.doesNotThrow(() => sched.flush());
  assert.equal(sched.pendingCount, 0);
});

test('cancel 丢弃待处理回调，不执行', () => {
  const { frames, sched } = setup();
  let ran = 0;
  sched.schedule('answer', () => { ran += 1; });
  sched.cancel();
  frames.tick();
  assert.equal(ran, 0);
  assert.equal(sched.pendingCount, 0);
});

test('pendingCount 反映待处理的目标数', () => {
  const { frames, sched } = setup();
  assert.equal(sched.pendingCount, 0);
  sched.schedule('a', () => {});
  sched.schedule('b', () => {});
  sched.schedule('a', () => {}); // 覆盖同一 key
  assert.equal(sched.pendingCount, 2);
  frames.tick();
  assert.equal(sched.pendingCount, 0);
});

// ---------------------------------------------------------------- 健壮性

test('单个回调抛错不影响同帧其余回调', () => {
  const { frames, sched } = setup();
  const ran = [];
  sched.schedule('bad', () => { throw new Error('boom'); });
  sched.schedule('good', () => ran.push('good'));
  assert.doesNotThrow(() => frames.tick());
  assert.deepEqual(ran, ['good'], '布局那一步不应被一个坏回调带崩');
});

test('非函数与脏 key 被安全忽略', () => {
  const { sched, frames } = setup();
  assert.doesNotThrow(() => sched.schedule('x', null));
  assert.doesNotThrow(() => sched.schedule(null, () => {}));
  assert.equal(sched.pendingCount, 1, 'null key 会被转成字符串，仍算一个目标');
  sched.cancel();
  assert.equal(frames.size, 0);
});

test('未注入 rAF 时退化为 setTimeout，不抛错', () => {
  const sched = createFrameScheduler({ requestFrame: (cb) => setTimeout(cb, 0), cancelFrame: (h) => clearTimeout(h) });
  assert.doesNotThrow(() => sched.schedule('a', () => {}));
  sched.cancel();
});

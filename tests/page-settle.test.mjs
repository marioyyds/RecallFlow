// page/settle.js：动作后「等真实静默」的原语。
//
// 为什么值得单独测：它取代了 `setTimeout(50)` 的固定等待，而这个改动直接影响
// 「动作后读到的值是点击前的旧值还是新值」—— 对以「验证改动是否生效」为卖点的调试工具，
// 这是地基。DOM 层本仓库没有测试，所以把这段逻辑抽成可注入桩的纯模块并在这里钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { waitForSettle, normalizeSettleOptions, SETTLE_DEFAULTS } from '../lib/page/settle.js';

// 可控的假时钟 + 假定时器：让「静默/超时」的比较在测试里确定且瞬时。
function makeHarness() {
  let now = 0;
  const timers = new Map();
  let seq = 1;
  const setTimeoutFn = (fn, ms) => {
    const id = seq++;
    timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0) });
    return id;
  };
  const clearTimeoutFn = (id) => timers.delete(id);
  // 推进假时钟：**只触发推进前就已存在的**定时器。
  // 踩过的坑：若把推进过程中新排的定时器也一并触发，就会死循环 ——
  // settle 的 observer 每次回调都会重置静默窗口（排一个新 timer），
  // 于是「推进 50ms 并触发一次变更」永远走不完。
  const advance = (ms) => {
    const target = now + ms;
    const due = [];
    for (const [id, t] of timers) if (t.at <= target) due.push({ id, at: t.at, fn: t.fn });
    due.sort((a, b) => a.at - b.at || a.id - b.id);
    for (const d of due) {
      if (!timers.has(d.id)) continue;
      timers.delete(d.id);
      now = d.at;
      d.fn();
    }
    now = target;
  };
  let observerCallback = null;
  let observed = null;
  let disconnected = false;
  class FakeMutationObserver {
    constructor(cb) {
      observerCallback = cb;
    }
    observe(target, opts) {
      observed = { target, opts };
    }
    disconnect() {
      disconnected = true;
    }
  }
  const doc = { documentElement: {}, body: {} };
  return {
    env: { doc, now: () => now, setTimeoutFn, clearTimeoutFn },
    advance,
    mutate: () => observerCallback && observerCallback(),
    get observed() { return observed; },
    get disconnected() { return disconnected; },
    MutationObserverClass: FakeMutationObserver,
  };
}

test('normalizeSettleOptions：非法值退回默认，不把 0 当"不等待"', () => {
  assert.deepEqual(normalizeSettleOptions(), {
    quietMs: SETTLE_DEFAULTS.quietMs,
    maxMs: SETTLE_DEFAULTS.maxMs,
    fallbackStepMs: SETTLE_DEFAULTS.fallbackStepMs,
  });
  const bad = normalizeSettleOptions({ quietMs: 0, maxMs: -5, fallbackStepMs: NaN });
  assert.equal(bad.quietMs, SETTLE_DEFAULTS.quietMs);
  assert.equal(bad.maxMs, SETTLE_DEFAULTS.maxMs);
  assert.equal(bad.fallbackStepMs, SETTLE_DEFAULTS.fallbackStepMs);
});

test('normalizeSettleOptions：maxMs 至少覆盖一个静默窗口', () => {
  // 否则永远等不到静默就已超时，表现为「看起来在等、其实总走上限」——比固定 sleep 更难查。
  const o = normalizeSettleOptions({ quietMs: 500, maxMs: 100 });
  assert.equal(o.quietMs, 500);
  assert.equal(o.maxMs, 500);
});

test('无 DOM 可观察时仍会等待（不能退化成"立刻返回"）', async () => {
  const h = makeHarness();
  const p = waitForSettle({ doc: null, now: h.env.now, setTimeoutFn: h.env.setTimeoutFn, clearTimeoutFn: h.env.clearTimeoutFn }, { quietMs: 100 });
  let settled = false;
  p.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, '不应在同一个微任务里就结束');
  h.advance(200);
  const r = await p;
  assert.equal(r.settled, true);
  assert.equal(r.reason, 'no-observer');
});

test('持续变更时不会提前结束，但到达上限必然结束（不挂死）', async () => {
  const h = makeHarness();
  globalThis.MutationObserver = h.MutationObserverClass;
  try {
    const p = waitForSettle(h.env, { quietMs: 100, maxMs: 1000 });
    // 每 50ms 变更一次，始终不静默。
    // 关键：让最后一次变更离 maxMs 足够近（< quietMs），这样静默窗口来不及走完，
    // 只能由上限触发结束 —— 否则「静默」与「上限」两个到期点会重合，结果取决于顺序。
    for (let i = 0; i < 19; i++) {
      h.advance(50);
      h.mutate();
    }
    h.advance(1200);
    const r = await p;
    assert.equal(r.settled, false, '一直有变更时应以上限结束');
    assert.equal(r.reason, 'timeout');
    assert.ok(r.mutations >= 10, '变更次数应被统计，实际 ' + r.mutations);
    assert.ok(r.elapsedMs <= 1100, '不应超过上限太多，实际 ' + r.elapsedMs);
  } finally {
    delete globalThis.MutationObserver;
  }
});

test('变更停止后按静默窗口提前结束（比固定 sleep 更快也更可靠）', async () => {
  const h = makeHarness();
  globalThis.MutationObserver = h.MutationObserverClass;
  try {
    const p = waitForSettle(h.env, { quietMs: 200, maxMs: 5000 });
    h.advance(30);
    h.mutate();
    h.advance(30);
    h.mutate();
    // 之后不再变更 → 应在最后一次变更 + quietMs 处结束，而不是等到 maxMs
    h.advance(400);
    const r = await p;
    assert.equal(r.settled, true);
    assert.equal(r.reason, 'quiet');
    assert.ok(r.elapsedMs < 1000, '应远早于上限结束，实际 ' + r.elapsedMs);
    assert.equal(h.disconnected, true, '结束后必须断开 observer，否则泄漏监听');
  } finally {
    delete globalThis.MutationObserver;
  }
});

test('observer 配置为观察整个子树的变更（漏了 subtree 就观察不到深层渲染）', async () => {
  const h = makeHarness();
  globalThis.MutationObserver = h.MutationObserverClass;
  try {
    const p = waitForSettle(h.env, { quietMs: 50, maxMs: 200 });
    h.advance(300);
    await p;
    assert.ok(h.observed, '应调用 observe');
    assert.equal(h.observed.opts.subtree, true);
    assert.equal(h.observed.opts.childList, true);
    assert.equal(h.observed.opts.attributes, true);
  } finally {
    delete globalThis.MutationObserver;
  }
});

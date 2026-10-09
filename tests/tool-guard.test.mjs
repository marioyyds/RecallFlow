import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolGuard, canonicalize } from '../lib/assistant/tool-guard.js';

const okResult = (extra = {}) => Object.assign({ ok: true, result: 'done' }, extra);
const failResult = (extra = {}) => Object.assign({ ok: false, result: 'boom' }, extra);

test('canonicalize is key-order insensitive', () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
});

test('repeated identical write call soft-lands with disable at the limit', () => {
  const guard = createToolGuard({ maxSameToolCalls: 3 });
  const call = () => guard.observe({ name: 'click_element', args: { selector: '#a' }, result: okResult(), readOnly: false });
  assert.equal(call().level, 'ok');
  assert.equal(call().level, 'ok');
  assert.equal(call().level, 'reflect');
  assert.equal(call().level, 'disable');
});

test('read-only repeats are tolerated longer than writes', () => {
  const guard = createToolGuard({ maxSameToolCalls: 2, readOnlySameToolCalls: 4 });
  const call = () => guard.observe({ name: 'get_page_snapshot', args: {}, result: okResult(), readOnly: true });
  assert.equal(call().level, 'ok');
  assert.equal(call().level, 'ok');
  assert.equal(call().level, 'reflect');
  assert.equal(call().level, 'reflect');
  assert.equal(call().level, 'disable');
});

test('consecutive failures disable a write tool', () => {
  const guard = createToolGuard({ toolFailStreak: 2 });
  assert.equal(guard.observe({ name: 'edit', args: { i: 1 }, result: failResult(), readOnly: false }).level, 'ok');
  const second = guard.observe({ name: 'edit', args: { i: 2 }, result: failResult(), readOnly: false });
  assert.equal(second.level, 'disable');
  assert.equal(second.reason, 'toolFailStreak');
});

test('read-only failures are also caught (higher threshold)', () => {
  const guard = createToolGuard({ toolFailStreak: 2, readOnlyFailStreak: 3 });
  assert.equal(guard.observe({ name: 'read_console', args: {}, result: failResult(), readOnly: true }).level, 'ok');
  assert.equal(guard.observe({ name: 'read_console', args: {}, result: failResult(), readOnly: true }).level, 'reflect');
  assert.equal(guard.observe({ name: 'read_console', args: {}, result: failResult(), readOnly: true }).level, 'disable');
});

test('validation failure counts as a failure', () => {
  const guard = createToolGuard({ toolFailStreak: 2 });
  assert.equal(guard.observe({ name: 'click_at', args: {}, result: { ok: false, result: 'missing x' }, validationFailed: true }).level, 'ok');
  assert.equal(guard.observe({ name: 'click_at', args: {}, result: { ok: false, result: 'missing x' }, validationFailed: true }).level, 'disable');
});

test('observable progress resets the repeat window', () => {
  const guard = createToolGuard({ maxSameToolCalls: 4, stuckWarnThreshold: 2 });
  const call = (progress = false) => guard.observe({ name: 'scroll_page', args: { to: 'bottom' }, result: okResult(), readOnly: false, progress });
  assert.equal(call().level, 'ok');
  assert.equal(call().level, 'reflect');
  const after = call(true);
  assert.equal(after.repeated, 1);
  assert.equal(after.level, 'ok');
});

test('a rejected call accumulates no-progress but never disables the tool', () => {
  const guard = createToolGuard({ toolFailStreak: 2, stuckStopThreshold: 3, stuckWarnThreshold: 2 });
  const reject = () => guard.observe({ name: 'run_javascript', args: { code: 'x' }, result: { ok: false }, rejected: true, readOnly: false });
  assert.equal(reject().level, 'ok');
  assert.equal(reject().level, 'reflect');
  assert.equal(reject().level, 'stop');
});

test('alternating distinct failing tools still trip the no-progress stop', () => {
  const guard = createToolGuard({ stuckStopThreshold: 3, stuckWarnThreshold: 2, toolFailStreak: 9 });
  assert.equal(guard.observe({ name: 'a', args: {}, result: failResult(), readOnly: false }).level, 'ok');
  assert.equal(guard.observe({ name: 'b', args: {}, result: failResult(), readOnly: false }).level, 'reflect');
  assert.equal(guard.observe({ name: 'c', args: {}, result: failResult(), readOnly: false }).level, 'stop');
});

test('snapshot and restore preserve guard state', () => {
  const guard = createToolGuard({ maxSameToolCalls: 2 });
  guard.observe({ name: 'click_element', args: { s: 1 }, result: okResult(), readOnly: false });
  guard.observe({ name: 'click_element', args: { s: 1 }, result: okResult(), readOnly: false });
  const revived = createToolGuard({ maxSameToolCalls: 2 });
  revived.restore(guard.snapshot());
  const decision = revived.observe({ name: 'click_element', args: { s: 1 }, result: okResult(), readOnly: false });
  assert.equal(decision.level, 'disable');
});

// ---------------------------------------------------------------- 按工具累计上限

test('per-tool cap: 参数各异的重复调用也会触发（指纹去重抓不到的情形）', () => {
  // 这正是 run_javascript 泛滥的场景：每次换选择器 → 指纹全不同，旧逻辑永不触发。
  const guard = createToolGuard({ maxCallsPerTool: { run_javascript: 3 }, maxSameToolCalls: 99, toolFailStreak: 99 });
  const levels = [];
  for (let i = 0; i < 4; i++) {
    const d = guard.observe({ name: 'run_javascript', args: { code: 'sel' + i }, result: okResult(), readOnly: false });
    levels.push(d.level);
  }
  assert.deepEqual(levels.slice(0, 3), ['ok', 'ok', 'ok']);
  assert.equal(levels[3], 'disable');
});

test('per-tool cap: 报出累计次数与上限，并指明应换工具', () => {
  // 语义：maxCallsPerTool: N = 允许 N 次，第 N+1 次拦截。
  const guard = createToolGuard({ maxCallsPerTool: { run_javascript: 2 }, maxSameToolCalls: 99, toolFailStreak: 99 });
  assert.equal(guard.observe({ name: 'run_javascript', args: { code: 'a' }, result: okResult(), readOnly: false }).level, 'ok');
  assert.equal(guard.observe({ name: 'run_javascript', args: { code: 'b' }, result: okResult(), readOnly: false }).level, 'ok');
  const d = guard.observe({ name: 'run_javascript', args: { code: 'c' }, result: okResult(), readOnly: false });
  assert.equal(d.level, 'disable');
  assert.equal(d.reason, 'maxCallsPerTool');
  assert.equal(d.totalCalls, 3);
  assert.ok(d.message.includes('3'), d.message);
  assert.ok(d.message.includes('2'), d.message);
  assert.ok(d.message.includes('换工具'), d.message);
});

test('per-tool cap: 只约束指定工具，其它工具不受影响', () => {
  const guard = createToolGuard({ maxCallsPerTool: { run_javascript: 1 }, maxSameToolCalls: 99, toolFailStreak: 99 });
  assert.equal(guard.observe({ name: 'run_javascript', args: { code: 'a' }, result: okResult(), readOnly: false }).level, 'ok');
  assert.equal(guard.observe({ name: 'run_javascript', args: { code: 'b' }, result: okResult(), readOnly: false }).level, 'disable');
  for (let i = 0; i < 5; i++) {
    assert.notEqual(
      guard.observe({ name: 'get_page_snapshot', args: {}, result: okResult(), readOnly: true }).level,
      'disable',
      '未配置上限的工具不应被摘除'
    );
  }
});

test('per-tool cap: 未配置上限时行为不变', () => {
  const guard = createToolGuard({ maxSameToolCalls: 99, toolFailStreak: 99 });
  for (let i = 0; i < 10; i++) {
    const d = guard.observe({ name: 'run_javascript', args: { code: 'x' + i }, result: okResult(), readOnly: false });
    assert.notEqual(d.level, 'disable');
  }
});

test('per-tool cap: 累计次数随 snapshot/restore 保留（否则「继续」后闸门失效）', () => {
  const opts = { maxCallsPerTool: { run_javascript: 3 }, maxSameToolCalls: 99, toolFailStreak: 99 };
  const guard = createToolGuard(opts);
  guard.observe({ name: 'run_javascript', args: { code: 'a' }, result: okResult(), readOnly: false });
  guard.observe({ name: 'run_javascript', args: { code: 'b' }, result: okResult(), readOnly: false });
  guard.observe({ name: 'run_javascript', args: { code: 'c' }, result: okResult(), readOnly: false });

  const revived = createToolGuard(opts);
  revived.restore(guard.snapshot());
  // 恢复后已是第 4 次 → 超过上限 3。若计数没恢复，全新 guard 会判 ok。
  const d = revived.observe({ name: 'run_javascript', args: { code: 'd' }, result: okResult(), readOnly: false });
  assert.equal(d.level, 'disable');
  assert.equal(d.totalCalls, 4);
});

test('per-tool cap: reset 会清零累计计数', () => {
  const guard = createToolGuard({ maxCallsPerTool: { run_javascript: 2 }, maxSameToolCalls: 99, toolFailStreak: 99 });
  guard.observe({ name: 'run_javascript', args: { code: 'a' }, result: okResult(), readOnly: false });
  guard.reset();
  assert.equal(guard.observe({ name: 'run_javascript', args: { code: 'b' }, result: okResult(), readOnly: false }).level, 'ok');
});

// 上限的语义是「**自上次产出可观察进展以来**连续调用了多少次」，不是「本任务累计」。
// 起因：实测一次正常的 DOM 排查会调用 run_javascript 十几次，而每一次都返回了新内容 ——
// 那不是失控，是干活，不该被闸门掐掉。

test('per-tool cap: 有进展的调用会清零计数，长探索不会被误拦', () => {
  const guard = createToolGuard({ maxCallsPerTool: { run_javascript: 3 }, maxSameToolCalls: 99, toolFailStreak: 99 });
  // 每一次都换选择器（指纹全不同）且都产出新信息 → 永远不该被摘除
  for (let i = 0; i < 50; i++) {
    const d = guard.observe({ name: 'run_javascript', args: { code: 'sel' + i }, result: okResult(), readOnly: false, progress: true });
    assert.notEqual(d.level, 'disable', '第 ' + (i + 1) + ' 次有进展的调用不该触发上限');
  }
});

test('per-tool cap: 连续无进展才累计（真正的空转仍会被拦）', () => {
  const guard = createToolGuard({ maxCallsPerTool: { run_javascript: 3 }, maxSameToolCalls: 99, toolFailStreak: 99 });
  const noProgress = (i) => guard.observe({ name: 'run_javascript', args: { code: 'sel' + i }, result: okResult(), readOnly: false, progress: false });
  assert.equal(noProgress(0).level, 'ok');
  assert.equal(noProgress(1).level, 'ok');
  assert.equal(noProgress(2).level, 'ok');
  assert.equal(noProgress(3).level, 'disable');
});

test('per-tool cap: 进展只清零自己的计数，不影响其它工具', () => {
  // 上限语义：允许 N 次，第 N+1 次拦截。
  const guard = createToolGuard({ maxCallsPerTool: { run_javascript: 2, set_element_style: 1 }, maxSameToolCalls: 99, toolFailStreak: 99 });
  const js = (code, progress) => guard.observe({ name: 'run_javascript', args: { code }, result: okResult(), readOnly: false, progress });
  const style = (selector) => guard.observe({ name: 'set_element_style', args: { selector }, result: okResult(), readOnly: false, progress: false });

  assert.equal(js('a', false).level, 'ok'); // run_javascript 第 1 次
  assert.equal(style('#x').level, 'ok'); // set_element_style 第 1 次（上限 1）
  assert.equal(js('b', true).level, 'ok'); // 有进展 → 计数清零后记为第 1 次
  assert.equal(js('c', false).level, 'ok', 'run_javascript 被自己的进展清零过，尚在上限内');
  assert.equal(style('#y').level, 'disable', 'set_element_style 没有进展，应照常累计到上限');
});

test('per-tool cap: 有进展时计为第 1 次而不是 0 次', () => {
  const guard = createToolGuard({ maxCallsPerTool: { run_javascript: 1 }, maxSameToolCalls: 99, toolFailStreak: 99 });
  const d = guard.observe({ name: 'run_javascript', args: { code: 'a' }, result: okResult(), readOnly: false, progress: true });
  assert.equal(d.level, 'ok');
  assert.equal(d.totalCalls, 1, '本次调用本身要计入，清零发生在它之前');
});

test('per-tool cap: 文案说明是「连续无进展」，而不是「累计调用」', () => {
  const guard = createToolGuard({ maxCallsPerTool: { run_javascript: 1 }, maxSameToolCalls: 99, toolFailStreak: 99 });
  guard.observe({ name: 'run_javascript', args: { code: 'a' }, result: okResult(), readOnly: false, progress: false });
  const d = guard.observe({ name: 'run_javascript', args: { code: 'b' }, result: okResult(), readOnly: false, progress: false });
  assert.equal(d.level, 'disable');
  assert.match(d.message, /没有产生可观察进展/, '文案必须说明这是无进展连击，否则模型不知道自己为什么被摘除');
  assert.match(d.message, /换工具/);
});

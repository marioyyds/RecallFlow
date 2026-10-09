// 工具守卫的新契约：**只提醒，不否决**（对齐 DSH 的 repeat-tool-reminder）。
//
// 旧契约是 ok / reflect / disable / stop —— 命中阈值即摘除工具或终止任务。
// 实测代价：一次冒烟测试里 outline_element 因「连续失败熔断」被停用，
// agent 只能在报告里解释「不是页面问题，是策略所致」。守卫不该替模型做决定：
// 只有模型知道这次重复是空转还是幂等轮询。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolGuard,
  canonicalize,
  REPEAT_THRESHOLDS,
  FAIL_THRESHOLDS,
  NO_PROGRESS_THRESHOLDS,
  ARGS_PREVIEW_CHARS,
  DEFAULT_EXCLUDED_TOOLS,
} from '../lib/assistant/tool-guard.js';

const okResult = (extra = {}) => Object.assign({ ok: true, result: 'done' }, extra);
const failResult = (extra = {}) => Object.assign({ ok: false, result: 'boom' }, extra);
const LEVELS = ['ok', 'reflect'];

test('canonicalize is key-order insensitive', () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
});

// ---------------------------------------------------------------- 核心契约

test('永不摘除工具、永不终止任务 —— 重复 50 次也只出 ok / reflect', () => {
  const guard = createToolGuard();
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const d = guard.observe({ name: 'click_element', args: { selector: '#a' }, result: okResult(), readOnly: false });
    seen.add(d.level);
  }
  assert.deepEqual([...seen].sort(), LEVELS, '出现 ok / reflect 之外的等级：' + [...seen].join(','));
});

test('永不摘除工具 —— 连续失败 30 次也只出 ok / reflect', () => {
  const guard = createToolGuard();
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    seen.add(guard.observe({ name: 'edit', args: { i }, result: failResult(), readOnly: false }).level);
  }
  assert.deepEqual([...seen].sort(), LEVELS);
});

test('永不终止任务 —— 跨工具连续无进展 30 次也只出 ok / reflect', () => {
  const guard = createToolGuard();
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    seen.add(guard.observe({ name: 'tool' + i, args: {}, result: failResult(), readOnly: false }).level);
  }
  assert.deepEqual([...seen].sort(), LEVELS);
});

// ---------------------------------------------------------------- 重复链：分级 + 精确跨越

test('重复链只在**精确达到**阈值时提醒（3 / 5 / 8）', () => {
  const guard = createToolGuard();
  const call = () => guard.observe({ name: 'read_current_page', args: {}, result: okResult(), readOnly: true });
  const warnedAt = [];
  for (let i = 1; i <= 12; i++) {
    const d = call();
    if (d.level === 'reflect') warnedAt.push(i);
  }
  assert.deepEqual(warnedAt, REPEAT_THRESHOLDS.slice(), '提醒次数点应为 ' + REPEAT_THRESHOLDS.join('/'));
});

test('超过最高阈值后不再打扰（DSH 的已知限制，照做）', () => {
  const guard = createToolGuard({ repeatThresholds: [3, 5] });
  const call = () => guard.observe({ name: 'x', args: {}, result: okResult() });
  const warnedAt = [];
  for (let i = 1; i <= 10; i++) if (call().level === 'reflect') warnedAt.push(i);
  assert.deepEqual(warnedAt, [3, 5], '超过最高阈值后不该继续提醒');
});

test('首次提醒简短，后续提醒详细并列出重复的参数', () => {
  const guard = createToolGuard();
  const call = () => guard.observe({ name: 'click_element', args: { selector: '#submit' }, result: okResult() });
  let first = null;
  let later = null;
  for (let i = 1; i <= 5; i++) {
    const d = call();
    if (d.repeated === 3) first = d;
    if (d.repeated === 5) later = d;
  }
  assert.ok(first && first.message, '第 3 次应有提醒');
  assert.ok(!/连续次数/.test(first.message), '首次提醒应简短，不该带详细模板');
  assert.ok(later && /连续次数/.test(later.message), '后续提醒应带「连续次数」');
  assert.ok(later.message.includes('#submit'), '后续提醒应列出重复的参数');
});

test('参数预览有上限，超长时标注省略了多少字符', () => {
  const guard = createToolGuard({ repeatThresholds: [3, 5] });
  const long = { q: 'x'.repeat(ARGS_PREVIEW_CHARS * 2) };
  let msg = '';
  for (let i = 1; i <= 5; i++) {
    const d = guard.observe({ name: 'search', args: long, result: okResult() });
    if (d.repeated === 5) msg = d.message;
  }
  assert.ok(msg.length < ARGS_PREVIEW_CHARS * 2, '提醒不该把超长参数整段塞进上下文');
  assert.match(msg, /\(\+\d+ more chars\)/, '应标注被省略的字符数');
});

test('参数不同就不算重复（精确匹配，不做模糊）', () => {
  const guard = createToolGuard();
  assert.equal(guard.observe({ name: 'x', args: { a: 1 }, result: okResult() }).repeated, 1);
  assert.equal(guard.observe({ name: 'x', args: { a: 2 }, result: okResult() }).repeated, 1, '换了参数 → 链重置');
  assert.equal(guard.observe({ name: 'x', args: { a: 1 }, result: okResult() }).repeated, 1, '换回来也算新链');
});

test('换成另一个被跟踪的工具 → 链重置为 1', () => {
  const guard = createToolGuard();
  guard.observe({ name: 'a', args: {}, result: okResult() });
  guard.observe({ name: 'a', args: {}, result: okResult() });
  assert.equal(guard.observe({ name: 'b', args: {}, result: okResult() }).repeated, 1);
  assert.equal(guard.observe({ name: 'b', args: {}, result: okResult() }).repeated, 2);
});

test('被排除的工具对链**透明**：穿插其间不能掩盖循环', () => {
  const guard = createToolGuard({ repeatThresholds: [3] });
  const tracked = () => guard.observe({ name: 'grep', args: { q: 'x' }, result: okResult() });
  assert.equal(tracked().repeated, 1);
  guard.observe({ name: 'update_plan', args: {}, result: okResult() }); // 默认排除
  assert.equal(tracked().repeated, 2, '穿插的记录类工具不该打断链');
  assert.equal(tracked().repeated, 3);
});

test('默认排除 update_plan（对应 DSH 默认排除 todo_write）', () => {
  assert.ok(DEFAULT_EXCLUDED_TOOLS.includes('update_plan'));
  const guard = createToolGuard();
  const d = guard.observe({ name: 'update_plan', args: {}, result: okResult() });
  assert.equal(d.repeated, 0, '被排除的工具不参与链计数');
});

test('被拒绝的调用也计入重复链（模型反复尝试被拒的调用正是要打破的循环）', () => {
  const guard = createToolGuard({ repeatThresholds: [3] });
  const call = () => guard.observe({ name: 'run_javascript', args: { code: 'x' }, result: null, rejected: true });
  assert.equal(call().repeated, 1);
  assert.equal(call().repeated, 2);
  const third = call();
  assert.equal(third.repeated, 3);
  assert.equal(third.level, 'reflect', '被拒绝的重复也应触发提醒');
});

test('有进展就断开重复链', () => {
  const guard = createToolGuard();
  guard.observe({ name: 'x', args: {}, result: okResult() });
  guard.observe({ name: 'x', args: {}, result: okResult() });
  assert.equal(guard.observe({ name: 'x', args: {}, result: okResult(), progress: true }).repeated, 1);
});

// ---------------------------------------------------------------- 失败与无进展：同样只提醒

test('连续失败只提醒，不摘除工具', () => {
  const guard = createToolGuard();
  const warnedAt = [];
  for (let i = 1; i <= 6; i++) {
    const d = guard.observe({ name: 'edit', args: { i }, result: failResult(), readOnly: false });
    if (d.level === 'reflect' && d.reason === 'toolFailStreak') warnedAt.push(i);
  }
  assert.deepEqual(warnedAt, FAIL_THRESHOLDS.slice());
  assert.ok(FAIL_THRESHOLDS.length > 0);
});

test('校验失败也算失败', () => {
  const guard = createToolGuard();
  const d = guard.observe({ name: 'edit', args: {}, result: okResult(), validationFailed: true });
  assert.equal(d.failStreak, 1);
});

test('无进展连击只提醒，不停止任务', () => {
  const guard = createToolGuard();
  const warnedAt = [];
  for (let i = 1; i <= 9; i++) {
    const d = guard.observe({ name: 't' + i, args: {}, result: failResult(), readOnly: false });
    if (d.level === 'reflect' && /重新读取页面/.test(d.message)) warnedAt.push(i);
  }
  assert.deepEqual(warnedAt, NO_PROGRESS_THRESHOLDS.slice());
});

test('可观察进展清空无进展连击', () => {
  const guard = createToolGuard();
  guard.observe({ name: 'a', args: {}, result: failResult() });
  guard.observe({ name: 'b', args: {}, result: failResult() });
  const d = guard.observe({ name: 'c', args: {}, result: okResult(), progress: true });
  assert.equal(d.noProgressStreak, 0);
});

// ---------------------------------------------------------------- 状态

test('snapshot / restore 保留重复链', () => {
  const guard = createToolGuard({ repeatThresholds: [3] });
  guard.observe({ name: 'x', args: { a: 1 }, result: okResult() });
  guard.observe({ name: 'x', args: { a: 1 }, result: okResult() });
  const state = guard.getState();
  assert.equal(state.chain.count, 2, '前置：链应记到 2');

  const revived = createToolGuard({ repeatThresholds: [3] });
  revived.restore(state);
  assert.equal(revived.observe({ name: 'x', args: { a: 1 }, result: okResult() }).repeated, 3, '链应跨恢复延续');
});

test('snapshot / restore 保留失败连击', () => {
  const guard = createToolGuard();
  guard.observe({ name: 'edit', args: { i: 1 }, result: failResult() });
  const revived = createToolGuard();
  revived.restore(guard.getState());
  assert.equal(revived.observe({ name: 'edit', args: { i: 2 }, result: failResult() }).failStreak, 2);
});

test('链的语义是「当前连续链」：调另一个工具本就该结束它（不是历史累计）', () => {
  const guard = createToolGuard();
  guard.observe({ name: 'x', args: {}, result: okResult() });
  guard.observe({ name: 'x', args: {}, result: okResult() });
  guard.observe({ name: 'y', args: {}, result: okResult() });
  assert.equal(guard.observe({ name: 'x', args: {}, result: okResult() }).repeated, 1, 'x 的链已被 y 打断');
});

test('reset 清空全部状态', () => {
  const guard = createToolGuard();
  guard.observe({ name: 'x', args: {}, result: failResult() });
  guard.reset();
  const d = guard.observe({ name: 'x', args: {}, result: failResult() });
  assert.equal(d.repeated, 1);
  assert.equal(d.failStreak, 1);
  assert.equal(d.noProgressStreak, 1);
});

test('脏输入安全：空 / null / 缺字段都不抛', () => {
  const guard = createToolGuard();
  assert.doesNotThrow(() => guard.observe());
  assert.doesNotThrow(() => guard.observe(null));
  assert.doesNotThrow(() => guard.observe({ name: '', args: null }));
  assert.equal(guard.observe({}).level, 'ok');
});

test('非法阈值配置回落到默认，不静默变成"永不提醒"', () => {
  const guard = createToolGuard({ repeatThresholds: [] });
  const call = () => guard.observe({ name: 'x', args: {}, result: okResult() });
  for (let i = 1; i < 3; i++) call();
  assert.equal(call().level, 'reflect', '空阈值应回落到默认 [3,5,8] 而不是永不提醒');
});

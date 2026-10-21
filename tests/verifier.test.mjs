import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerificationReflection, buildStuckReflection } from '../lib/assistant/verifier.js';

test('verification reflection includes reason, missing and suggestion', () => {
  const r = buildVerificationReflection({ ok: false, reason: '目标页未打开', missing: '目标页未加载', suggestion: '重新 open_tab' });
  assert.ok(r.includes('未通过'));
  assert.ok(r.includes('目标页未加载'));
  assert.ok(r.includes('重新 open_tab'));
});

test('stuck reflection suggests alternative strategies', () => {
  const r = buildStuckReflection('连续 3 次无进展');
  assert.ok(r.includes('连续 3 次无进展'));
  assert.ok(r.includes('role+name') || r.includes('CDP'));
});

test('反思按成因分派：重复调用 → 提示区分"幂等轮询"与"换参数"', () => {
  // 原先三种成因共用一个模板。重复调用最需要的不是"换工具"，
  // 而是先判断"我是不是在靠重复调用来等页面" —— 那是完全不同的下一步。
  const m = buildStuckReflection('重复 3 次', { reason: 'maxSameToolCalls' });
  assert.match(m, /幂等|轮询/, '必须点出"可能是在等渲染"这种合法情形');
  assert.match(m, /wait_for_element/, '要给出明确等待这个正确做法，而不是笼统说换个方式');
  assert.doesNotMatch(m, /前置条件/, '前置条件是"连续失败"那条路径的建议，不该串台');
});

test('反思按成因分派：连续失败 → 提示先查前置条件', () => {
  const m = buildStuckReflection('连续失败 3 次', { reason: 'toolFailStreak' });
  assert.match(m, /前置条件/, '连续失败时该查的是"为什么没生效"');
  assert.match(m, /CDP|get_ax_snapshot/, '要给出合成事件失效时的升级路径');
});

test('反思按成因分派：无进展 → 提示超时不等于没生效、先重读状态', () => {
  const m = buildStuckReflection('连续无进展', { reason: 'noProgress' });
  assert.match(m, /get_page_snapshot/, '必须先重新读取状态再决定');
  assert.match(m, /超时|生效/, '必须提醒"超时 ≠ 没生效"，否则模型会重复已生效的写操作');
});

test('未知成因回落到通用模板，且不抛', () => {
  const m = buildStuckReflection('x', { reason: 'somethingNew' });
  assert.match(m, /换一种方式/, '未知成因仍要给得出方向');
  assert.ok(m.length > 20);
});

test('第三档提醒必须给出"如实收尾"这个出口（没有出口的催促只会耗尽预算）', () => {
  const first = buildStuckReflection('x', { reason: 'noProgress', attempt: 1 });
  const third = buildStuckReflection('x', { reason: 'noProgress', attempt: 3 });
  // 判别式要用"收尾出口"那一行本身：各种成因的建议里本来就会出现"如实说明"字样
  // （例如 noProgress 建议里就有"如实说明做不到"），用 /如实/ 做否定断言会误伤。
  assert.doesNotMatch(first, /这已经是第/, '第一次提醒不该出现"第 N 次"的收尾催促');
  assert.match(third, /这已经是第/, '第三次必须出现收尾出口');
  assert.match(third, /第 3 次/, '要让模型知道这是第几次，它才能判断该不该放弃');
});

test('不传 opts 时与旧行为一致（向后兼容）', () => {
  const legacy = buildStuckReflection('连续 3 次无进展');
  assert.match(legacy, /连续 3 次无进展/);
  assert.match(legacy, /换一种方式/, '旧调用方（无第二参数）仍应拿到通用建议');
});

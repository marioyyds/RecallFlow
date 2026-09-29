// 跨域 iframe 路由：验证目标按框架正确分组、ref 前缀被剥离、顺序可还原。
// 这是 verify_change 能覆盖跨源 iframe 的基础。
import test from 'node:test';
import assert from 'node:assert/strict';

import { planFrameBatches } from '../lib/assistant/tools.js';

test('planFrameBatches: 无 frameId 与无 ref 前缀的目标归入顶层框架 0', () => {
  const batches = planFrameBatches([{ selector: '#a' }, { selector: '#b' }]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].frameId, 0);
  assert.equal(batches[0].items.length, 2);
  assert.deepEqual(batches[0].items.map((x) => x.at), [0, 1]);
});

test('planFrameBatches: 显式 frameId 决定归属', () => {
  const batches = planFrameBatches([{ selector: '#a', frameId: 3 }, { selector: '#b', frameId: 5 }]);
  assert.equal(batches.length, 2);
  const byId = Object.fromEntries(batches.map((b) => [b.frameId, b]));
  assert.equal(byId[3].items.length, 1);
  assert.equal(byId[5].items.length, 1);
});

test('planFrameBatches: ref 的 f<frameId>: 前缀决定归属并被剥离', () => {
  const batches = planFrameBatches([{ ref: 'f3:rf-2' }]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].frameId, 3);
  // 发给该框架的参数必须是本地 ref（不能带前缀），且不得残留 frameId
  assert.equal(batches[0].items[0].target.ref, 'rf-2');
  assert.equal(batches[0].items[0].target.frameId, undefined);
});

test('planFrameBatches: 显式 frameId 优先于 ref 前缀', () => {
  const batches = planFrameBatches([{ ref: 'f3:rf-2', frameId: 7 }]);
  assert.equal(batches[0].frameId, 7);
  assert.equal(batches[0].items[0].target.ref, 'rf-2');
});

test('planFrameBatches: 混合来源时仍保留原始下标，可还原顺序', () => {
  const targets = [
    { selector: '#top' },
    { ref: 'f2:rf-1' },
    { selector: '#also-top' },
    { selector: '#in-2', frameId: 2 },
  ];
  const batches = planFrameBatches(targets);
  const byId = Object.fromEntries(batches.map((b) => [b.frameId, b]));
  assert.deepEqual(byId[0].items.map((x) => x.at), [0, 2]);
  assert.deepEqual(byId[2].items.map((x) => x.at), [1, 3]);
  // 每个原始下标恰好出现一次
  const all = batches.flatMap((b) => b.items.map((x) => x.at)).sort((a, b) => a - b);
  assert.deepEqual(all, [0, 1, 2, 3]);
});

test('planFrameBatches: 保留断言与 styles 等业务字段', () => {
  const batches = planFrameBatches([
    { label: '提交', selector: '#s', styles: ['display'], expect: { text: 'ok' }, index: 1 },
  ]);
  const t = batches[0].items[0].target;
  assert.equal(t.label, '提交');
  assert.deepEqual(t.expect, { text: 'ok' });
  assert.deepEqual(t.styles, ['display']);
  assert.equal(t.index, 1);
});

test('planFrameBatches: 空输入与非法输入安全', () => {
  assert.deepEqual(planFrameBatches([]), []);
  assert.deepEqual(planFrameBatches(null), []);
  assert.deepEqual(planFrameBatches(undefined), []);
});

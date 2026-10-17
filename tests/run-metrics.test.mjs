// run-metrics 的纯函数单测：聚合与格式化必须可信，否则"用数据改进编排"会建立在错数字上。
import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeRunTrace, formatRunMetrics } from '../lib/assistant/run-metrics.js';

const ENTRIES = [
  { ts: 1, phase: 'start', intent: 'BROWSER', instruction: '打开页面' },
  { ts: 2, phase: 'turn-timing', iter: 0, prefillMs: 500, decodeMs: 200, totalMs: 800 },
  { ts: 3, phase: 'tool', name: 'get_page_snapshot', ok: true, ms: 50 },
  { ts: 4, phase: 'turn-timing', iter: 1, prefillMs: 100, decodeMs: 100, totalMs: 300 },
  { ts: 5, phase: 'tool', name: 'click_element', ok: false, ms: 10 },
  { ts: 6, phase: 'tool', name: 'expand_result', ok: true, ms: 5 },
  { ts: 7, phase: 'cache', iter: 1, hit: 900, miss: 100 },
  { ts: 8, phase: 'collapse', iter: 2, collapsed: 1 },
  { ts: 9, phase: 'complete', reason: 'final-answer', totalTokens: 1200 },
];

test('summarizeRunTrace：轮次/工具/缓存/耗时都能聚合出来', () => {
  const m = summarizeRunTrace(ENTRIES);
  assert.equal(m.rounds, 2);
  assert.equal(m.toolCalls, 3);
  assert.equal(m.failedTools, 1);
  assert.equal(m.expandResultRounds, 1);
  assert.deepEqual(m.byTool, { get_page_snapshot: 1, click_element: 1, expand_result: 1 });
  assert.deepEqual(m.cache, { hit: 900, miss: 100, ratio: 90 });
  assert.equal(m.totalMs, 1100);
  assert.equal(m.prefillMs, 600);
  assert.equal(m.decodeMs, 300);
  assert.equal(m.totalTokens, 1200);
  assert.equal(m.collapsed, 1);
  assert.equal(m.errors, 0);
});

test('summarizeRunTrace：空/坏输入安全', () => {
  const m = summarizeRunTrace(null);
  assert.equal(m.rounds, 0);
  assert.equal(m.toolCalls, 0);
  assert.equal(m.cache.ratio, null, '没有缓存记录时命中率应为 null 而不是 0%');
});

test('formatRunMetrics：能读出关键口径（命中率/工具分布/耗时）', () => {
  const text = formatRunMetrics(summarizeRunTrace(ENTRIES));
  assert.match(text, /轮次 2 \/ 工具调用 3（失败 1）/);
  assert.match(text, /前缀缓存命中率 90%/);
  assert.match(text, /click_element×1/);
  assert.match(text, /1\.1s/);
});

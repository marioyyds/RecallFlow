import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateMessagesTokens, collapseOldToolResults } from '../lib/assistant/context.js';

test('estimateTokens: CJK counts heavier than latin', () => {
  assert.ok(estimateTokens('你好世界') >= 4);
  assert.ok(estimateTokens('hello world') < 4);
  assert.equal(estimateTokens(''), 0);
});

test('estimateMessagesTokens sums content', () => {
  const n = estimateMessagesTokens([{ role: 'user', content: '你好' }, { role: 'assistant', content: 'hello world' }]);
  assert.ok(n > 0);
});

test('collapseOldToolResults keeps the last N full', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'tool', content: 'x'.repeat(1000) + i });
  const collapsed = collapseOldToolResults(msgs, 6, 300);
  assert.equal(collapsed, 4);
  assert.ok(msgs[9].content.length > 300);
  assert.ok(msgs[0].content.length < 400);
});

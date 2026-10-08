import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateMessagesTokens, collapseOldToolResults, normalizeHistory } from '../lib/assistant/context.js';

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

// 折叠会改写历史中部 → 从改写点起的前缀缓存全部失效。
// 因此「折叠过一次就不再变」是硬要求：否则同一批消息每轮都被重新拼接，前缀持续抖动。
test('collapseOldToolResults: 已折叠的消息不会被二次改写（前缀只失效一次）', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'tool', content: 'x'.repeat(1000) + i });
  assert.equal(collapseOldToolResults(msgs, 6, 300), 4);
  const before = msgs.map((m) => m.content);

  // 模拟下一轮：又追加两条工具结果，折叠窗口右移
  msgs.push({ role: 'tool', content: 'y'.repeat(1000) });
  msgs.push({ role: 'tool', content: 'z'.repeat(1000) });
  const changed = collapseOldToolResults(msgs, 6, 300);

  assert.equal(changed, 2, '只应折叠刚刚越出窗口的两条');
  for (let i = 0; i < 4; i++) {
    assert.equal(msgs[i].content, before[i], '第 ' + i + ' 条被二次改写 → 前缀会再次失效');
  }
});

test('collapseOldToolResults: 无可折叠内容时返回 0（重复调用不虚报）', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'tool', content: 'x'.repeat(1000) + i });
  collapseOldToolResults(msgs, 6, 300);
  assert.equal(collapseOldToolResults(msgs, 6, 300), 0, '第二次调用不应报告任何折叠');
});

test('collapseOldToolResults: 幂等 —— 连续调用后内容逐字节不变', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'tool', content: 'x'.repeat(1000) + i });
  collapseOldToolResults(msgs, 6, 300);
  const snapshot = JSON.stringify(msgs);
  collapseOldToolResults(msgs, 6, 300);
  collapseOldToolResults(msgs, 6, 300);
  assert.equal(JSON.stringify(msgs), snapshot);
});

// ---------------------------------------------------------------- normalizeHistory

test('normalizeHistory: 只保留有内容的 user/assistant', () => {
  const out = normalizeHistory([
    { role: 'tool', content: 'x' },
    { role: 'user', content: '   ' },
    { role: 'assistant' },
    { role: 'user', content: '有效' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, '有效');
});

test('normalizeHistory: 受 maxMessages 限制，保留最近的', () => {
  const hist = [
    { role: 'user', content: 'a'.repeat(400) },
    { role: 'assistant', content: 'b'.repeat(400) },
    { role: 'user', content: '最近问题' },
  ];
  const out = normalizeHistory(hist, { maxMessages: 2, maxChars: 3000, maxTokens: 1000 });
  assert.equal(out.length, 2);
  assert.equal(out[out.length - 1].content, '最近问题');
});

test('normalizeHistory: 单条按 maxChars 截断', () => {
  const out = normalizeHistory([{ role: 'user', content: 'x'.repeat(100) }], { maxChars: 10 });
  assert.equal(out[0].content.length, 10);
});

test('normalizeHistory: token 预算裁掉更早内容并给出提示', () => {
  const hist = [{ role: 'user', content: '甲'.repeat(50) }, { role: 'user', content: '乙' }];
  const out = normalizeHistory(hist, { maxMessages: 10, maxTokens: 10, noticeOnTruncation: true });
  assert.ok(out.some((m) => m.content.includes('更早的对话')), '裁剪时应有提示');
  assert.equal(out[out.length - 1].content, '乙');
});

test('normalizeHistory: assistant 附带工具执行摘要', () => {
  const out = normalizeHistory([{ role: 'assistant', content: '做完了', toolSummary: 'click_element：已点击' }]);
  assert.ok(out[0].content.includes('上一轮执行摘要'));
  assert.ok(out[0].content.includes('click_element'));
});

test('normalizeHistory: 非数组输入安全返回空', () => {
  assert.deepEqual(normalizeHistory(undefined), []);
  assert.deepEqual(normalizeHistory(null), []);
});


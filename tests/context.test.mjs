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
  assert.ok(msgs[9].content.length > 300, '最近 6 条保持完整');
  // 折叠后是「头 300 + 提示 + 尾 150」≈ 500 字符 —— 比原先的「只留头 300」长，
  // 这是刻意付出的代价：尾部常带结论，丢掉它比多花 200 字符贵得多。
  assert.ok(msgs[0].content.length < 700, '折叠结果仍应是有界的，实际 ' + msgs[0].content.length);
  assert.match(msgs[0].content, /【已折叠】/);
  assert.ok(msgs[0].content.endsWith('0'), '尾部应被保留（第 0 条的末尾是字符 0）');
});

test('折叠时保留的是**正文**的尾部，不是截断通知的碎片', () => {
  // 踩过的坑：正则只匹配 `id=res-N`，于是 body 的结尾落在通知内部（「…完整内容 」），
  // 正文真正的尾部被当成通知切掉了。正则必须匹配**整条通知**并锚定在末尾。
  const notice = '\n…（结果共 9999 字符，已截断；完整内容 id=res-7，可用 expand_result(id="res-7") 分段读取）';
  const msgs = [];
  for (let i = 0; i < 8; i++) msgs.push({ role: 'tool', content: 'H'.repeat(3000) + 'TAIL_END' + notice });
  collapseOldToolResults(msgs, 6, 300);
  assert.ok(msgs[0].content.endsWith('TAIL_END'), '结尾应是正文尾部，实际 …' + JSON.stringify(msgs[0].content.slice(-24)));
  assert.match(msgs[0].content, /id=res-7/);
});

test('折叠必须保住可恢复的 id —— 否则等于压缩掉了可恢复性', () => {
  // agent 对大结果会写成：正文…（完整内容 id=res-7，可用 expand_result(id="res-7") 分段读取）
  // id 在 3000 字之后，而旧实现无脑 slice(0, 300)，把 id 切掉了：
  // resultStore 里还留着全文，模型却再也拿不到 —— DSH 的 spill 特意保证「可恢复路径」。
  const body = 'A'.repeat(3000);
  const notice = '\n…（结果共 9999 字符，已截断；完整内容 id=res-7，可用 expand_result(id="res-7") 分段读取）';
  const msgs = [];
  for (let i = 0; i < 8; i++) msgs.push({ role: 'tool', content: body + notice });
  collapseOldToolResults(msgs, 6, 300);
  assert.match(msgs[0].content, /id=res-7/, '折叠后必须仍能看到 id');
  assert.match(msgs[0].content, /expand_result/, '并说明怎么取回');
});

test('折叠后不再变长（保住「折叠」这个性质）', () => {
  // 头尾阈值合计 300 + 150，再加 40 的余量：短于这个长度的内容不值得折叠。
  const msgs = [{ role: 'tool', content: 'x'.repeat(900) }];
  for (let i = 0; i < 6; i++) msgs.push({ role: 'tool', content: 'keep' });
  const before = msgs[0].content.length;
  collapseOldToolResults(msgs, 6, 300);
  assert.ok(msgs[0].content.length < before, '折叠应让内容变短：' + before + ' → ' + msgs[0].content.length);
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


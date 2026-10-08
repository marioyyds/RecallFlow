// 出站会话结构校验：这类错误的代价特别高 —— 服务端只回一个**空响应体的 400**，
// 报错里没有任何线索。所以这里既要断言"能查出来"，也要断言"修完就合法"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { diagnoseConversation, repairConversation, formatProblems } from '../lib/assistant/conversation-guard.js';
import { sanitizeToolPairing } from '../lib/assistant/agent.js';

const sys = (c) => ({ role: 'system', content: c });
const user = (c) => ({ role: 'user', content: c });
const asst = (text, calls) => ({
  role: 'assistant',
  content: text,
  ...(calls ? { tool_calls: calls.map((id) => ({ id, type: 'function', function: { name: 'f', arguments: '{}' } })) } : {}),
});
const tool = (id, content = 'ok') => ({ role: 'tool', tool_call_id: id, content });

const codes = (msgs) => diagnoseConversation(msgs).map((p) => p.code);

// ---------------------------------------------------------------- 合法基线

test('合法的会话不报任何问题', () => {
  const messages = [sys('s'), user('u'), asst('', ['a']), tool('a'), asst('done')];
  assert.deepEqual(diagnoseConversation(messages), []);
});

test('一轮多个 tool_call、结果齐全时合法', () => {
  const messages = [sys('s'), user('u'), asst('', ['a', 'b', 'c']), tool('a'), tool('b'), tool('c'), asst('done')];
  assert.deepEqual(diagnoseConversation(messages), []);
});

test('空数组与非数组输入安全', () => {
  assert.deepEqual(diagnoseConversation([]), []);
  assert.deepEqual(diagnoseConversation(null), []);
  assert.deepEqual(diagnoseConversation(undefined), []);
});

test('纯 assistant 文本轮（无 tool_calls）合法', () => {
  assert.deepEqual(diagnoseConversation([sys('s'), user('u'), asst('回答')]), []);
});

// ---------------------------------------------------------------- 真实故障复刻

test('复刻空 400 的根因：break 跳出循环后，同一轮剩下的 tool_call 没有结果', () => {
  // 模型一轮发了三个调用，其中 complete_task 触发「完成前校验未通过 → break 去注入反思」。
  // 修复前：a、b 有结果，c 没有 —— 下一次请求就是非法的。
  const messages = [sys('s'), user('u'), asst('', ['a', 'b', 'c']), tool('a'), tool('b')];
  const problems = diagnoseConversation(messages);
  assert.ok(problems.length > 0, '必须能查出漏了结果');
  assert.ok(problems.some((p) => p.code === 'unanswered-tool-calls'), JSON.stringify(problems));
  const last = problems[problems.length - 1];
  assert.match(last.detail, /第 2 条 assistant/, '要指出是哪一条 assistant 的问题：' + last.detail);
  assert.match(last.detail, /1 个 tool_call/, '要说明还差几个：' + last.detail);
});

test('补全剩余结果后即为合法（这就是根因修复的做法）', () => {
  const messages = [sys('s'), user('u'), asst('', ['a', 'b', 'c']), tool('a'), tool('b')];
  // fillRemainingToolResults(toolCalls, 2, reason) 做的事：
  messages.push(tool('c', '（本轮已转入反思，该调用未执行。）'));
  assert.deepEqual(diagnoseConversation(messages), []);
});

// ---------------------------------------------------------------- 各类结构错误

test('孤儿 tool 结果（前面没有等待答复的 tool_calls）', () => {
  const messages = [sys('s'), user('u'), tool('x')];
  assert.ok(codes(messages).includes('orphan-tool-result'));
});

test('tool 结果的 id 与任何未答复的 id 都不匹配', () => {
  const messages = [sys('s'), user('u'), asst('', ['a']), tool('zzz')];
  const got = codes(messages);
  assert.ok(got.includes('tool-result-id-mismatch'), got.join(','));
  // 且原本该答复的 a 到结尾仍未答复
  assert.ok(got.includes('unanswered-tool-calls'), got.join(','));
});

test('tool_calls 与 tool 结果之间插入了 user 消息', () => {
  const messages = [sys('s'), user('u'), asst('', ['a']), user('插队'), tool('a')];
  assert.ok(codes(messages).includes('interrupted-tool-pairing'));
});

test('tool_calls 未答复完就出现下一条 assistant 消息', () => {
  const messages = [sys('s'), user('u'), asst('', ['a']), asst('我先说下一句'), tool('a')];
  assert.ok(codes(messages).includes('unanswered-tool-calls'));
});

test('tool 消息缺 content（序列化后字段会消失，服务端要求必填）', () => {
  const messages = [sys('s'), user('u'), asst('', ['a']), { role: 'tool', tool_call_id: 'a' }];
  assert.ok(codes(messages).includes('missing-content'));
});

test('user / system 消息缺 content', () => {
  assert.ok(codes([{ role: 'system' }, user('u')]).includes('missing-content'));
  assert.ok(codes([sys('s'), { role: 'user' }]).includes('missing-content'));
});

test('assistant 的 tool_call id 为空', () => {
  const messages = [sys('s'), user('u'), asst('', ['']), tool('')];
  assert.ok(codes(messages).includes('empty-tool-call-id'));
});

test('消息不是对象', () => {
  assert.ok(codes([sys('s'), null, user('u')]).includes('not-an-object'));
});

test('formatProblems 把问题压成一行', () => {
  const text = formatProblems(diagnoseConversation([sys('s'), user('u'), tool('x')]));
  assert.match(text, /#2 orphan-tool-result/);
  assert.equal(formatProblems([]), '');
  assert.equal(formatProblems(null), '');
});

// ---------------------------------------------------------------- 修复充分性

const BROKEN_CASES = [
  ['漏结果', [sys('s'), user('u'), asst('', ['a', 'b', 'c']), tool('a'), tool('b')]],
  ['孤儿结果', [sys('s'), user('u'), tool('x')]],
  ['id 不匹配', [sys('s'), user('u'), asst('', ['a']), tool('zzz')]],
  ['配对被 user 打断', [sys('s'), user('u'), asst('', ['a']), user('插队'), tool('a')]],
  ['配对被下一条 assistant 打断', [sys('s'), user('u'), asst('', ['a']), asst('下一句'), tool('a')]],
  ['tool 结果缺 content', [sys('s'), user('u'), asst('', ['a']), { role: 'tool', tool_call_id: 'a' }]],
  ['tool_call id 为空', [sys('s'), user('u'), asst('', ['']), tool('')]],
  ['非对象消息', [sys('s'), null, user('u')]],
  ['user 缺 content', [sys('s'), { role: 'user' }]],
  ['多种问题叠加', [sys('s'), asst('', ['a']), user('插队'), tool('a'), tool('zzz'), asst('', ['b'])]],
];

test('repairConversation: 每一种结构错误都能修到合法（修复是充分的）', () => {
  for (const [label, messages] of BROKEN_CASES) {
    const repaired = repairConversation(messages);
    const left = diagnoseConversation(repaired);
    assert.deepEqual(left, [], label + ' 修复后仍不合法：' + JSON.stringify(left));
  }
});

test('repairConversation: 对已经合法的会话是恒等变换（内容等价）', () => {
  const messages = [sys('s'), user('u'), asst('', ['a', 'b']), tool('a'), tool('b'), asst('done')];
  assert.deepEqual(repairConversation(messages), messages);
});

test('repairConversation: 空输入安全', () => {
  assert.deepEqual(repairConversation(null), []);
  assert.deepEqual(repairConversation(undefined), []);
});

test('repairConversation: 丢弃配不齐的组，但保留它前后的合法内容', () => {
  const messages = [sys('s'), user('u'), asst('', ['a', 'b']), tool('a'), asst('后面的正文')];
  const repaired = repairConversation(messages);
  assert.deepEqual(diagnoseConversation(repaired), []);
  assert.equal(repaired[0].content, 's');
  assert.equal(repaired[1].content, 'u');
  assert.equal(repaired[repaired.length - 1].content, '后面的正文', '合法内容不应被牵连丢弃');
});

test('repairConversation: 比 sanitizeToolPairing 更强（后者修不好配对被打断）', () => {
  // 这条不是吹毛求疵：如果拿 sanitizeToolPairing 当兜底，就会"记完日志照样发非法请求"。
  const interrupted = [sys('s'), user('u'), asst('', ['a']), user('插队'), tool('a')];
  assert.ok(
    diagnoseConversation(sanitizeToolPairing(interrupted)).length > 0,
    '前置：sanitizeToolPairing 确实修不好这一种'
  );
  assert.deepEqual(diagnoseConversation(repairConversation(interrupted)), []);
});

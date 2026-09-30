// DSH 原生插件（方案 B）的测试。
//
// 重点在**纯映射**：它决定面板上出现什么，而事件形状全部来自 DSH 的类型声明
// （SessionEvent = { type, data }），所以这里的用例是照着真实结构写的。
import test from 'node:test';
import assert from 'node:assert/strict';

import { textFromBlocks, parseToolArguments, createMapper, SKIP_TOOL_PREFIX } from '../integrations/dsh-plugin-recallflow/session-map.js';
import { shortSessionId } from '../integrations/dsh-plugin-recallflow/index.js';
import { normalizeExternalEvent, isValidEvent } from '../integrations/opencode/recallflow-mcp/panel-events.js';

test('shortSessionId: 剥掉 session- 前缀，否则用户只看到 "session-" 等于没有区分信息', () => {
  assert.equal(shortSessionId('session-723c8b32-4ab3-489f-9f53-80958d29c5a9'), '723c8b32');
  assert.equal(shortSessionId('abc123'), 'abc123');
  assert.equal(shortSessionId(''), '');
  assert.equal(shortSessionId(null), '');
});

// ---------------------------------------------------------------- 文本提取

test('textFromBlocks: 只取 text 块，忽略 reasoning 与 tool-call', () => {
  const content = [
    { type: 'reasoning', text: '让我想想…' },
    { type: 'text', text: '页面有两个报错。' },
    { type: 'tool-call', id: 'c1', name: 'Bash' },
    { type: 'text', text: '第二个来自广告脚本。' },
  ];
  const out = textFromBlocks(content);
  assert.ok(out.includes('页面有两个报错。'), out);
  assert.ok(out.includes('第二个来自广告脚本。'), out);
  assert.ok(!out.includes('让我想想'), 'reasoning 是模型的思考，不是它说的话，不能显示给用户');
});

test('textFromBlocks: 空/纯工具调用/脏输入都返回空串（不该产生空气泡）', () => {
  assert.equal(textFromBlocks([]), '');
  assert.equal(textFromBlocks([{ type: 'tool-call', id: 'c1' }]), '');
  assert.equal(textFromBlocks([{ type: 'text', text: '   ' }]), '');
  assert.equal(textFromBlocks(null), '');
  assert.equal(textFromBlocks('nope'), '');
  assert.equal(textFromBlocks([null, 42, { type: 'text' }]), '');
});

// ---------------------------------------------------------------- 参数解析

test('parseToolArguments: JSON 字符串/对象/坏串都不丢信息', () => {
  assert.deepEqual(parseToolArguments('{"command":"ls"}'), { command: 'ls' });
  assert.deepEqual(parseToolArguments({ a: 1 }), { a: 1 });
  assert.deepEqual(parseToolArguments(''), {});
  assert.deepEqual(parseToolArguments(null), {});
  assert.deepEqual(parseToolArguments('不是 JSON'), { raw: '不是 JSON' }, '解析失败要原样保留，而不是丢掉');
  assert.deepEqual(parseToolArguments('"str"'), { value: 'str' });
});

// ---------------------------------------------------------------- 会话事件映射

test('map: assistant/message → 助手的话（这正是 hook 拿不到的那部分）', () => {
  const m = createMapper();
  const ev = m.map({
    type: 'assistant/message',
    data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '我查了控制台，有两个错误。' }] }, stream: [] },
  });
  assert.equal(ev.who, 'dsh');
  assert.equal(ev.level, 'info');
  assert.ok(ev.text.includes('两个错误'));
  assert.ok(isValidEvent(normalizeExternalEvent(ev)), '必须能通过桥接侧的校验');
});

test('map: 纯工具调用的 assistant 回合不产出事件', () => {
  const m = createMapper();
  assert.equal(m.map({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c' }] } } }), null);
});

test('map: user/message → who=user（不能显示成 agent 的话）', () => {
  const m = createMapper();
  const ev = m.map({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '帮我看下这个页面' }] } });
  assert.equal(ev.who, 'user');
  assert.equal(ev.text, '帮我看下这个页面');
});

test('map: tool/call → 工具事件，参数从 JSON 字符串解析', () => {
  const m = createMapper();
  const ev = m.map({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{"command":"git status"}' } });
  assert.equal(ev.kind, 'tool');
  assert.equal(ev.phase, 'start');
  assert.equal(ev.tool, 'Bash');
  assert.deepEqual(ev.args, { command: 'git status' });
});

test('map: 跳过 mcp__* 工具（已由 MCP 服务端上报，重复会让面板画两遍）', () => {
  const m = createMapper();
  assert.equal(m.map({ type: 'tool/call', data: { callId: 'c1', name: SKIP_TOOL_PREFIX + 'recallflow__read_console', arguments: '{}' } }), null);
  // 非 mcp 前缀不被误伤
  assert.ok(m.map({ type: 'tool/call', data: { callId: 'c2', name: 'mcpX', arguments: '{}' } }));
});

test('map: tool/result 只在失败时产出，且能靠 callId 找回工具名', () => {
  const m = createMapper();
  m.map({ type: 'tool/call', data: { callId: 'c9', name: 'Bash', arguments: '{}' } });
  // 成功：不产出（面板一次调用只画一行）
  assert.equal(m.map({ type: 'tool/result', data: { message: { toolCallId: 'c9', isError: false } } }), null);
  // 失败：产出一行错误，带工具名
  const fail = m.map({ type: 'tool/result', data: { message: { toolCallId: 'c9', isError: true }, error: { name: 'E', code: 'ENOENT', reason: '找不到文件' } } });
  assert.equal(fail.kind, 'tool');
  assert.equal(fail.phase, 'end');
  assert.equal(fail.ok, false);
  assert.equal(fail.tool, 'Bash');
  assert.equal(fail.error, '找不到文件');
});

test('map: 找不到对应 callId 的失败结果不产出（宁可不显示，也不显示错的工具名）', () => {
  const m = createMapper();
  assert.equal(m.map({ type: 'tool/result', data: { message: { toolCallId: 'unknown', isError: true } } }), null);
});

test('map: 不关心的会话事件类型一律返回 null', () => {
  const m = createMapper();
  for (const type of ['turn/start', 'turn/end', 'step/start', 'step/end', 'system/message', 'developer/message', 'assistant/attempt', 'request/header', 'request/context', 'hook/invoked', 'hook/result']) {
    assert.equal(m.map({ type, data: {} }), null, '应忽略 ' + type);
  }
  assert.equal(m.map(null), null);
  assert.equal(m.map({}), null);
});

test('map: 追踪的 callId 数量有上限（长会话不无限增长）', () => {
  const m = createMapper();
  for (let i = 0; i < 400; i++) m.map({ type: 'tool/call', data: { callId: 'c' + i, name: 'Bash', arguments: '{}' } });
  assert.ok(m.trackedCount() <= 200, '实际 ' + m.trackedCount());
  // 最近的仍然能对上
  const ok = m.map({ type: 'tool/result', data: { message: { toolCallId: 'c399', isError: true }, error: { reason: 'x' } } });
  assert.ok(ok && ok.tool === 'Bash');
});

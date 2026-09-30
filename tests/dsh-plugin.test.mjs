// DSH 原生插件（方案 B）的测试。
//
// 重点在**纯映射**：它决定面板上出现什么，而事件形状全部来自 DSH 的类型声明
// （SessionEvent = { type, data }），所以这里的用例是照着真实结构写的。
import test from 'node:test';
import assert from 'node:assert/strict';

import { textFromBlocks, parseToolArguments, createMapper, SKIP_TOOL_PREFIX, isInjectedUserMessage, buildPanelContextMessage, buildPanelContextPayload, PANEL_CONTEXT_MARKER, PANEL_CONTEXT_SOURCE_KIND } from '../integrations/dsh-plugin-recallflow/session-map.js';
import { shortSessionId } from '../integrations/dsh-plugin-recallflow/index.js';
import { normalizeExternalEvent, isValidEvent, sayEvent, MAX_SPEAK_TEXT, MAX_USER_TEXT } from '../integrations/opencode/recallflow-mcp/panel-events.js';

test('shortSessionId: 剥掉 session- 前缀，否则用户只看到 "session-" 等于没有区分信息', () => {
  assert.equal(shortSessionId('session-723c8b32-4ab3-489f-9f53-80958d29c5a9'), '723c8b32');
  assert.equal(shortSessionId('abc123'), 'abc123');
  assert.equal(shortSessionId(''), '');
  assert.equal(shortSessionId(null), '');
});

// -------------------------------------------- 系统注入的运行时上下文要被挡住
// 用户实测：面板上出现「👤 你在 DSH：Current runtime context. This snapshot s…」，
// 而他从没说过这句话 —— DSH 把系统注入的上下文也当成 user/message 投递了。

test('isInjectedUserMessage: source.kind=runtime-context 要挡住（依据 DSH 的 MessageSourceMap）', () => {
  assert.equal(
    isInjectedUserMessage({ source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '随便什么' }] }),
    true
  );
});

test('isInjectedUserMessage: 文本前缀兜底（形状变了也不至于漏）', () => {
  const mk = (t) => ({ content: [{ type: 'text', text: t }] });
  assert.equal(isInjectedUserMessage(mk('Current runtime context. This snapshot supersedes earlier…')), true);
  assert.equal(isInjectedUserMessage(mk('This snapshot supersedes earlier runtime-context snapshots.')), true);
});

test('isInjectedUserMessage: 用户真说的话绝不能被误判（拒绝名单的意义）', () => {
  const mk = (t, src) => ({ source: src, content: [{ type: 'text', text: t }] });
  assert.equal(isInjectedUserMessage(mk('你好')), false);
  // 来源是 user 时，即使文本很长也要放行
  assert.equal(isInjectedUserMessage(mk('很长的一段话'.repeat(500), { kind: 'user' })), false);
  // 形状不认识时宁可显示（漏判只是噪音，误判是吞掉用户的话）
  assert.equal(isInjectedUserMessage(mk('你好', { kind: 'unknown-future-kind' })), false);
});

test('mapper: 注入的运行时上下文不产出事件，真用户消息照常产出', () => {
  const m = createMapper();
  assert.equal(
    m.map({ type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context…' }] } }),
    null
  );
  const real = m.map({ type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } });
  assert.deepEqual(real, { text: '你好', who: 'user', level: 'info' });
});

// --------------------------------- 面板对话注入 DSH 上下文（Agent.inject 那一半）

test('buildPanelContextMessage: 双向都带、措辞是「同一个助手、另一个界面」、空输入给空串', () => {
  const msg = buildPanelContextMessage([
    { role: 'user', text: '这个页面为什么有报错' },
    { role: 'panel', text: '有两个错误。' },
  ]);
  assert.ok(msg.includes(PANEL_CONTEXT_MARKER), msg);
  assert.ok(msg.includes('用户：这个页面为什么有报错'), msg);
  // 面板那一侧的发言标成「我（面板界面）」—— 用户明确要求不要制造"两个 AI"的割裂感，
  // 而两个界面本来就在共享上下文，所以不再写成"另一个 agent 说的"。
  assert.ok(msg.includes('我（面板界面）：有两个错误。'), msg);
  assert.ok(msg.includes('同一个助手') || msg.includes('同一位助手'), msg);
  assert.ok(!msg.includes('另一个 agent'), '不应再有两个 agent 的措辞：' + msg);
  assert.equal(buildPanelContextMessage([]), '');
  assert.equal(buildPanelContextMessage(null), '');
  assert.equal(buildPanelContextMessage([{ role: 'user', text: '' }]), '');
});

test('buildPanelContextMessage: 只取最近 max 条，单条也限长（不能挤爆上下文预算）', () => {
  const turns = [];
  for (let i = 0; i < 60; i++) turns.push({ role: 'user', text: 'T' + i });
  const msg = buildPanelContextMessage(turns, { max: 3 });
  assert.ok(!msg.includes('T56'), '旧的应被丢掉');
  assert.ok(msg.includes('T57') && msg.includes('T58') && msg.includes('T59'), msg);
  const one = buildPanelContextMessage([{ role: 'panel', text: 'x'.repeat(5000) }], { perTurn: 100 });
  assert.ok(one.includes('…'), '超长单条应被截断');
  assert.ok(one.length < 600, '总长应受控，实际 ' + one.length);
});

// --------------------------- 注入载荷必须是**完整**消息（含 id 且冻结）

test('buildPanelContextPayload: 含 id、role、text 块、自定义 source.kind，且深度冻结', () => {
  const p = buildPanelContextPayload([{ role: 'user', text: '面板一句' }], 'id-1');
  assert.ok(p, '应产出载荷');
  // id 必填：inject(input) 直接 send → inbox.splice 原样入队，不会替你调 createMessage 铸 id。
  // 少了它会在下游抛错，再被插件的 catch 吞掉 —— 表现与"面板没对话"完全一样。
  assert.equal(p.id, 'id-1');
  assert.equal(p.role, 'user');
  assert.equal(p.content.length, 1);
  assert.equal(p.content[0].type, 'text');
  assert.equal(p.source.kind, PANEL_CONTEXT_SOURCE_KIND);
  // 对齐 createMessage 的 deepFreeze：DSH 的消息是不可变快照
  assert.ok(Object.isFrozen(p), '顶层应冻结');
  assert.ok(Object.isFrozen(p.content), 'content 应冻结');
  assert.ok(Object.isFrozen(p.content[0]), 'text 块应冻结');
  assert.ok(Object.isFrozen(p.source), 'source 应冻结');
});

test('buildPanelContextPayload: 没有可注入内容时返回 null（不产出空消息）', () => {
  assert.equal(buildPanelContextPayload([], 'id-2'), null);
  assert.equal(buildPanelContextPayload(null, 'id-3'), null);
  assert.equal(buildPanelContextPayload([{ role: 'user', text: '' }], 'id-4'), null);
});

test('buildPanelContextPayload: id 原样透传（铸 id 是调用方的职责，这里不做隐式生成）', () => {
  const a = buildPanelContextPayload([{ role: 'user', text: 'x' }], 'same');
  const b = buildPanelContextPayload([{ role: 'user', text: 'x' }], 'same');
  assert.equal(a.id, b.id, '同 id 传入应得到同 id（说明本函数不自行生成）');
  const c = buildPanelContextPayload([{ role: 'user', text: 'x' }], 'other');
  assert.notEqual(a.id, c.id);
});

test('注入源不会被回推回面板（否则面板与 DSH 之间形成回环）', () => {  const injected = { source: { kind: 'recallflow-panel' }, content: [{ type: 'text', text: buildPanelContextMessage([{ role: 'user', text: 'hi' }]) }] };
  assert.equal(isInjectedUserMessage(injected), true);
  const m = createMapper();
  assert.equal(m.map({ type: 'user/message', data: injected }), null, '注入的上下文不应再产出面板事件');
});

// ------------------------------------------- 助手的长回答不该被截成残句
// 用户实测：面板上助手的话在 400 字处被砍断。

test('sayEvent: 是按说话人分级的，助手比 400 宽、用户居中', () => {
  const long = '字'.repeat(3000);
  const dshEv = sayEvent(long, 'info', 1, 'dsh');
  const userEv = sayEvent(long, 'info', 1, 'user');
  assert.ok(dshEv.text.length > 1500, '助手回答应保留到 ' + MAX_SPEAK_TEXT + ' 附近，实际 ' + dshEv.text.length);
  assert.ok(userEv.text.length > 800, '用户自述应保留到 ' + MAX_USER_TEXT + ' 附近，实际 ' + userEv.text.length);
  assert.ok(dshEv.text.length > userEv.text.length, '助手额度应大于用户额度');
  // 仍然必须限长（面板是窄条，且存储有上限）
  assert.ok(dshEv.text.length <= MAX_SPEAK_TEXT + 1, '不得超上限');
  assert.ok(userEv.text.length <= MAX_USER_TEXT + 1, '不得超上限');
  assert.equal(sayEvent(null, 'info', 1, 'dsh').text, '');
});

test('sayEvent: 未知 who 归为 dsh（不能因为字段脏就丢内容）', () => {
  assert.equal(sayEvent('x', 'info', 1, 'bogus').who, 'dsh');
  assert.equal(sayEvent('x', 'info', 1, undefined).who, 'dsh');
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

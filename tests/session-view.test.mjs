// 「会话事件 → 面板条目」的纯逻辑测试。
//
// 为什么值得单独钉：这段判断决定面板上显示什么、以及会不会把同一句话显示两遍。
// 它原本会长在 lib/page/chat.js 里（DOM 代码，只能靠人眼在浏览器里验），
// 抽到 lib/shared/session-view.js 之后就能在这里钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyFrame, sessionEntryFromFrame, summarizeToolArgs, trimSessionEntries, SESSION_SOURCE } from '../lib/shared/session-view.js';

const frame = (event) => ({ kind: 'session-event', sessionId: 's1', event });

test('classifyFrame: 认 user/message、assistant/message 与工具调用，其余一律不进面板', () => {
  assert.equal(classifyFrame(frame({ type: 'user/message', role: 'user', text: 'hi' })).ok, true);
  assert.equal(classifyFrame(frame({ type: 'assistant/message', text: 'yo' })).ok, true);

  // 工具调用**要**画一行（"agent 正在做什么"）。真实事件类型是 tool/call ——
  // 这条本来写的是猜测的 'tool/start'，结果既没覆盖真实类型，也把"不画工具活动"
  // 当成了设计意图。实测依据：插件 /recallflow/status 的 lastEventType 长期是 tool/call，
  // 且用户手上的面板确实显示过 ⚙ 行。
  assert.equal(classifyFrame(frame({ type: 'tool/call', tool: 'page_screenshot' })).ok, true);
  // 工具**结果**：成功的不画（一次调用只占一行）；
  // **失败**的画一行 —— 那是"出错"信号，混在成功里会被忽略。
  assert.equal(classifyFrame(frame({ type: 'tool/result', tool: 'page_screenshot', text: 'ok' })).ok, false);
  assert.equal(classifyFrame(frame({ type: 'tool/result', tool: 'page_screenshot', failed: true })).ok, true);
  // 说"失败"但不知道是谁失败 → 画不出有信息量的一行，宁可不画
  assert.equal(classifyFrame(frame({ type: 'tool/result', failed: true })).ok, false);
  // 没有工具名的 tool/call 是坏的，别画一行空气泡
  assert.equal(classifyFrame(frame({ type: 'tool/call' })).ok, false);

  // inbox 变动、空文本都不该变成面板里的一行
  assert.equal(classifyFrame(frame({ type: 'agent/inbox/spliced' })).ok, false);
  assert.equal(classifyFrame(frame({ type: 'assistant/message', text: '   ' })).ok, false);
  // user/message 但来源不是用户（例如 runtime-context 注入）不该当成人说的话
  assert.equal(
    classifyFrame(frame({ type: 'user/message', role: 'user', sourceKind: 'runtime-context', text: '系统上下文' })).ok,
    false
  );
  assert.equal(classifyFrame(null).ok, false);
  assert.equal(classifyFrame({ kind: 'tool-call' }).ok, false);
});

test('系统注入的上下文有两层防御：source.kind 与文本开头（kind 缺失时靠第二层兜住）', () => {
  // 第一层：source.kind
  assert.equal(
    classifyFrame(frame({ type: 'user/message', role: 'user', sourceKind: 'runtime-context', text: '系统上下文' })).ok,
    false
  );
  // 第二层：**没有 sourceKind** 时，靠文本开头识别。
  // 这一条是这次补上的洞 —— 此前只有第一层，于是这种帧会被当成用户自己说的话，
  // 以「你：Current runtime context…」显示在面板上。
  assert.equal(
    classifyFrame(
      frame({ type: 'user/message', role: 'user', text: 'Current runtime context. This snapshot supersedes…' })
    ).ok,
    false,
    '缺 sourceKind 时必须靠文本前缀兜住'
  );
  assert.equal(
    classifyFrame(frame({ type: 'user/message', role: 'user', text: 'This snapshot supersedes anything earlier.' })).ok,
    false
  );
  // 用户真的这么说话（前缀不在开头）时不误伤
  assert.equal(
    classifyFrame(frame({ type: 'user/message', role: 'user', text: '帮我看看 Current runtime context 是什么意思' })).ok,
    true,
    '前缀只在开头才算注入，不能误伤正常提问'
  );
});

test('工具调用渲染成「⚙ 名字（k=v）」一行，参数只取最多两个短标量', () => {
  const d = sessionEntryFromFrame(
    frame({ type: 'tool/call', tool: 'page_screenshot', args: { label: '面板渲染检查', tabId: 1780111567, nested: { a: 1 } } }),
    []
  );
  assert.equal(d.action, 'append');
  assert.equal(d.who, 'dsh');
  assert.equal(d.line, '⚙ page_screenshot（label=面板渲染检查 tabId=1780111567）', '最多两个字段，对象字段跳过');
  assert.equal(d.echoText, '', '工具行不参与回声去重');

  // 参数为空 / 非对象 → 只留名字，不留空括号
  assert.equal(sessionEntryFromFrame(frame({ type: 'tool/call', tool: 'browser_read' }), []).line, '⚙ browser_read');
  assert.equal(sessionEntryFromFrame(frame({ type: 'tool/call', tool: 'browser_read', args: {} }), []).line, '⚙ browser_read');
  assert.equal(sessionEntryFromFrame(frame({ type: 'tool/call', tool: 'x', args: [1, 2] }), []).line, '⚙ x');
});

test('工具失败渲染成「✗ 调用 名字 失败：原因」一行（成功的结果不画）', () => {
  const d = sessionEntryFromFrame(frame({ type: 'tool/result', tool: 'verify_change', failed: true, error: '超时' }), []);
  assert.equal(d.action, 'append');
  assert.equal(d.who, 'dsh');
  assert.equal(d.line, '✗ 调用 verify_change 失败：超时');
  // 插件没给原因时也不能留空 —— 面板上要能看出"失败了但原因未提供"
  assert.equal(
    sessionEntryFromFrame(frame({ type: 'tool/result', tool: 'x', failed: true }), []).line,
    '✗ 调用 x 失败：未提供原因'
  );
  // 成功的结果整条跳过
  assert.equal(sessionEntryFromFrame(frame({ type: 'tool/result', tool: 'x', text: 'ok' }), []).action, 'skip');
});

test('trimSessionEntries: 工具行用更紧的上限，用户与助手的话优先保留', () => {
  const conv = [];
  for (let i = 0; i < 300; i++) conv.push({ role: 'external', kind: 'tool', content: '⚙ t' + i });
  conv.push({ role: 'user', content: '我说的话' });
  conv.push({ role: 'external', kind: 'assistant', content: '助手的回答' });

  const kept = trimSessionEntries(conv, { maxExternal: 200, maxTool: 60 });
  assert.equal(kept.filter((m) => m.kind === 'tool').length, 60, '工具行应被压到单独的上限');
  assert.ok(kept.some((m) => m.content === '我说的话'), '用户的话不能被工具行挤掉');
  assert.ok(kept.some((m) => m.content === '助手的回答'), '助手的回复不能被工具行挤掉');
  assert.ok(!kept.some((m) => m.content === '⚙ t0'), '删的应是最旧的工具行');
  assert.ok(kept.some((m) => m.content === '⚙ t299'), '最新的工具行要留下');
});

test('trimSessionEntries: 非工具的外部条目仍按总上限裁（保留最新的）', () => {
  const conv = [];
  for (let i = 0; i < 250; i++) conv.push({ role: 'external', kind: 'assistant', content: 'a' + i });
  const kept = trimSessionEntries(conv, { maxExternal: 200, maxTool: 60 });
  assert.equal(kept.length, 200);
  assert.equal(kept[kept.length - 1].content, 'a249', '保留最新的');
  assert.equal(kept[0].content, 'a50');
});

test('sessionEntryFromFrame 带上 kind（裁剪与渲染都要用它，不能靠字符串猜）', () => {
  assert.equal(sessionEntryFromFrame(frame({ type: 'tool/call', tool: 'x' }), []).kind, 'tool');
  assert.equal(sessionEntryFromFrame(frame({ type: 'tool/result', tool: 'x', failed: true }), []).kind, 'tool');
  assert.equal(sessionEntryFromFrame(frame({ type: 'user/message', role: 'user', text: 'hi' }), []).kind, 'user');
  assert.equal(sessionEntryFromFrame(frame({ type: 'assistant/message', text: 'yo' }), []).kind, 'assistant');
});

test('summarizeToolArgs: 长值截断、跳过多余字段（面板是窄条，一行不能变十行）', () => {
  assert.equal(summarizeToolArgs({ url: 'http://127.0.0.1:3080/'.repeat(10) }), '（url=' + 'http://127.0.0.1:3080/'.repeat(10).slice(0, 40) + '…）');
  assert.equal(summarizeToolArgs({ a: '1', b: '2', c: '3' }), '（a=1 b=2）', '第三个字段不再进入摘要');
  assert.equal(summarizeToolArgs({ ok: true, n: 3 }), '（ok=true n=3）');
  assert.equal(summarizeToolArgs({ obj: { x: 1 }, arr: [1] }), '', '对象/数组一律跳过');
  assert.equal(summarizeToolArgs(null), '');
  assert.equal(summarizeToolArgs('str'), '');
  assert.equal(summarizeToolArgs({ blank: '   ' }), '', '空白值不算一个字段');
});

test('用户消息渲染成「你：…」，助手消息不加前缀（角色可见、来源不可见）', () => {
  const u = sessionEntryFromFrame(frame({ type: 'user/message', role: 'user', text: '这个页面为什么有报错' }), []);
  assert.equal(u.action, 'append');
  assert.equal(u.who, 'user');
  assert.equal(u.line, '你：这个页面为什么有报错');

  const a = sessionEntryFromFrame(frame({ type: 'assistant/message', text: '有两个错误。' }), []);
  assert.equal(a.action, 'append');
  assert.equal(a.who, 'dsh');
  assert.equal(a.line, '有两个错误。', '助手的话就是"我"在说，不加前缀');
});

test('回声去重：面板自己发出去的用户输入从会话回来时，标记本地那条而不是再显示一遍', () => {
  const conversation = [
    { role: 'user', content: '帮我看下这个页面' },
    { role: 'external', source: 'dsh', who: 'dsh', content: '好的' },
  ];
  const d = sessionEntryFromFrame(
    frame({ type: 'user/message', role: 'user', sourceKind: 'user', text: '帮我看下这个页面' }),
    conversation
  );
  assert.equal(d.action, 'mark-local');
  assert.equal(d.index, 0, '应指向那条本地用户回合');
  // 幂等：已标记过的不再匹配（否则连续两条回声都命中同一条）
  conversation[0].echoedFromSession = true;
  assert.equal(
    sessionEntryFromFrame(frame({ type: 'user/message', role: 'user', text: '帮我看下这个页面' }), conversation).action,
    'append',
    '已标记过的本地回合不再吸收第二条回声'
  );
});

test('回声去重只往回看有限条，且不误伤内容不同的消息', () => {
  const conversation = [{ role: 'user', content: '很久以前说过的话' }];
  const d = sessionEntryFromFrame(
    frame({ type: 'user/message', role: 'user', text: '刚刚在面板里说的话' }),
    conversation
  );
  assert.equal(d.action, 'append', '内容不同不该被当成回声');
});

test('助手消息永远不去重（同一段话本来就该各说各的）', () => {
  const conversation = [{ role: 'user', content: '你好' }];
  const d = sessionEntryFromFrame(frame({ type: 'assistant/message', text: '你好' }), conversation);
  assert.equal(d.action, 'append');
  assert.equal(d.who, 'dsh');
});

test('回声去重优先用 rpcId 精确匹配（同一句话说两遍也能分清）', () => {
  // 场景：同一句话说了两遍，两遍都从会话回声回来。
  // 只靠文本匹配必然把两条回声都算到同一条本地回合上；rpcId 能分清。
  const conversation = [
    { role: 'user', content: '再读一遍', rpcId: 'r1' },
    { role: 'user', content: '再读一遍', rpcId: 'r2' },
  ];
  const first = sessionEntryFromFrame(
    frame({ type: 'user/message', role: 'user', sourceKind: 'user', rpcId: 'r2', text: '再读一遍' }),
    conversation
  );
  assert.equal(first.action, 'mark-local');
  assert.equal(first.index, 1, 'rpcId=r2 应指向第二条，而不是最近的同类文本');
  assert.equal(first.reason, 'rpcId 精确匹配');

  // 标记后，rpcId=r1 的回声应指向第一条
  conversation[1].echoedFromSession = true;
  const second = sessionEntryFromFrame(
    frame({ type: 'user/message', role: 'user', sourceKind: 'user', rpcId: 'r1', text: '再读一遍' }),
    conversation
  );
  assert.equal(second.action, 'mark-local');
  assert.equal(second.index, 0);
});

test('rpcId 对不上时退回文本匹配（rpcId 尚未回填的过渡态）', () => {
  const conversation = [{ role: 'user', content: '面板里说的话' }]; // 还没有 rpcId
  const d = sessionEntryFromFrame(
    frame({ type: 'user/message', role: 'user', sourceKind: 'user', rpcId: 'r9', text: '面板里说的话' }),
    conversation
  );
  assert.equal(d.action, 'mark-local', 'rpcId 对不上时应退回文本匹配，而不是重复显示');
  assert.equal(d.reason, '与本地用户回合同文，判为回声');
});

test('SESSION_SOURCE 是个稳定常量（面板用它区分"这条来自会话"）', () => {
  assert.equal(SESSION_SOURCE, 'session');
});

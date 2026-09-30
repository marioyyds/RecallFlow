// 「会话事件 → 面板条目」的纯逻辑测试。
//
// 为什么值得单独钉：这段判断决定面板上显示什么、以及会不会把同一句话显示两遍。
// 它原本会长在 lib/page/chat.js 里（DOM 代码，只能靠人眼在浏览器里验），
// 抽到 lib/shared/session-view.js 之后就能在这里钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyFrame, sessionEntryFromFrame, SESSION_SOURCE } from '../lib/shared/session-view.js';

const frame = (event) => ({ kind: 'session-event', sessionId: 's1', event });

test('classifyFrame: 只认 user/message 与 assistant/message，其余一律不进面板', () => {
  assert.equal(classifyFrame(frame({ type: 'user/message', role: 'user', text: 'hi' })).ok, true);
  assert.equal(classifyFrame(frame({ type: 'assistant/message', text: 'yo' })).ok, true);

  // 工具活动、inbox 变动、空文本都不该变成面板里的一行
  assert.equal(classifyFrame(frame({ type: 'tool/start', tool: 'pwsh' })).ok, false);
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

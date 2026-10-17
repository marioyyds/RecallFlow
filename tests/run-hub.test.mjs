import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RunStreamHub,
  applyRunEvent,
  createRunState,
  runStateToAssistantMessage,
} from '../lib/assistant/run-hub.js';

function state() {
  return createRunState({
    runId: 'run-1',
    sessionId: 'S-1',
    ownerTabId: 11,
    instruction: '搜索 jev',
    startedAt: 100,
  });
}

test('run state: 思考先于正文，正文开始会定稿思考段', () => {
  const s = state();
  applyRunEvent(s, { type: 'reasoning', text: '先看页面，' });
  applyRunEvent(s, { type: 'reasoning', text: '再决定动作。' });
  applyRunEvent(s, { type: 'chunk', text: '我开始了。' });
  assert.equal(s.reasoning, '');
  assert.deepEqual(s.parts[0], { type: 'thinking', text: '先看页面，再决定动作。' });
  assert.equal(s.narration, '我开始了。');
  assert.equal(s.content, '我开始了。');
});

test('run state: 工具步骤前的叙述会被固化，工具结果随后进入同一时间线', () => {
  const s = state();
  applyRunEvent(s, { type: 'chunk', text: '先搜索。' });
  applyRunEvent(s, { type: 'tool-call', callId: 'c1', name: 'click_element', args: { ref: 'e1' } });
  applyRunEvent(s, { type: 'tool-result', callId: 'c1', name: 'click_element', status: 'completed', result: '已点击' });
  assert.deepEqual(
    s.parts.map((p) => p.type),
    ['narration', 'tool-call', 'tool-result']
  );
  assert.equal(s.parts[0].text, '先搜索。');
  assert.equal(s.narration, '');
});

test('run state: 审批等待、计划、用量和状态事件都能反映到快照', () => {
  const s = state();
  applyRunEvent(s, { type: 'plan', plan: [{ text: '搜索', status: 'in_progress' }] });
  applyRunEvent(s, { type: 'agent-state', state: 'executing', step: 2, maxSteps: 6 });
  applyRunEvent(s, { type: 'usage', totalTokens: 123 });
  applyRunEvent(s, { type: 'tool-call', callId: 'c1', name: 'run_javascript', args: {}, requiresApproval: true });
  assert.equal(s.plan[0].text, '搜索');
  assert.deepEqual(s.progress, { state: 'executing', step: 2, max: 6 });
  assert.equal(s.tokens, 123);
  assert.equal(s.approval.name, 'run_javascript');
  const msg = runStateToAssistantMessage(s);
  assert.ok(msg.parts.some((p) => p.type === 'notice' && p.text.includes('等待发起标签页确认')));
});

test('run state: 错误与结束状态会保留已生成的思考/正文，不清空', () => {
  const s = state();
  applyRunEvent(s, { type: 'reasoning', text: '想法' });
  applyRunEvent(s, { type: 'chunk', text: '部分回答' });
  applyRunEvent(s, { type: 'error', error: '网络失败' });
  applyRunEvent(s, { type: 'end' });
  assert.equal(s.status, 'ended');
  assert.equal(s.error, '网络失败');
  assert.ok(s.content.includes('部分回答'));
});

test('run state: 只登记来源但正文没写 [n] 时不生成“参考来源”', () => {
  const s = state();
  applyRunEvent(s, {
    type: 'citations',
    citations: [{ id: 'c1', index: 1, title: '数据库索引', url: 'https://example.test/' }],
  });
  applyRunEvent(s, { type: 'chunk', text: '这是一段还没有引用编号的回答。' });
  const msg = runStateToAssistantMessage(s);
  assert.deepEqual(msg.citations, [], '未被正文引用的来源不得进入参考来源区');
});

test('run state: live 引用按正文首次出现顺序过滤并重编号', () => {
  const s = state();
  applyRunEvent(s, {
    type: 'citations',
    citations: [
      { id: 'c1', index: 1, title: '未引用来源' },
      { id: 'c2', index: 2, title: '实际来源' },
    ],
  });
  applyRunEvent(s, { type: 'chunk', text: '关键事实见 [2]。' });
  const msg = runStateToAssistantMessage(s);
  assert.equal(msg.citations.length, 1);
  assert.equal(msg.citations[0].title, '实际来源');
  assert.equal(msg.citations[0].index, 1);
  assert.match(msg.parts.find((p) => p.type === 'narration').text, /\[1\]/);
  assert.equal(msg.showCitations, false, '流式进行中不显示底部来源区');
  applyRunEvent(s, { type: 'end' });
  assert.equal(runStateToAssistantMessage(s).showCitations, true, '收尾后才显示参考来源');
});

test('run state: 校验通过提示是最后一条，不插在 complete_task 工具结果后面', () => {
  const s = state();
  applyRunEvent(s, { type: 'tool-result', callId: 'c1', name: 'complete_task', status: 'completed', result: '完成' });
  applyRunEvent(s, { type: 'verify', ok: true, reason: '证据一致' });
  applyRunEvent(s, { type: 'chunk', text: '最终回答' });
  applyRunEvent(s, { type: 'end' });
  const msg = runStateToAssistantMessage(s);
  const last = msg.parts[msg.parts.length - 1];
  assert.equal(last.type, 'notice');
  assert.equal(last.terminal, true);
  assert.match(last.text, /完成前校验通过/);
  assert.ok(msg.parts.findIndex((p) => p.type === 'narration') < msg.parts.length - 1);
});

test('run state: 待关闭辅助页会显示在跟随时间线里', () => {
  const s = state();
  applyRunEvent(s, { type: 'tabs-close-pending', tabIds: [42, 43] });
  const msg = runStateToAssistantMessage(s);
  assert.ok(
    msg.parts.some((p) => p.type === 'notice' && p.text.includes('最终回复保存后关闭 2 个辅助标签页')),
    '跟随页应能解释辅助页为何还没关闭'
  );
});

test('hub: 文本增量按 flushMs 合并广播，结构化事件先冲刷文本', () => {
  const deltas = [];
  const starts = [];
  let timer = null;
  const hub = new RunStreamHub({
    flushMs: 40,
    now: (() => {
      let t = 100;
      return () => ++t;
    })(),
    setTimer: (fn) => {
      timer = fn;
      return 1;
    },
    clearTimer: () => {
      timer = null;
    },
    onStart: (s) => starts.push(s),
    onDelta: (d) => deltas.push(d),
  });
  const started = hub.begin({ runId: 'run-a', sessionId: 'S-a', ownerTabId: 1, instruction: '做' });
  assert.equal(starts.length, 1);
  assert.equal(started.cursor, 0);

  hub.push('run-a', { type: 'chunk', text: '你' });
  hub.push('run-a', { type: 'chunk', text: '好' });
  assert.equal(deltas.length, 0, '文本应等待合并窗口');
  timer();
  assert.deepEqual(
    deltas.map((d) => [d.cursor, d.event.type, d.event.text]),
    [[1, 'chunk', '你好']]
  );

  hub.push('run-a', { type: 'tool-call', callId: 'c', name: 'inspect_element', args: { ref: 'e1' } });
  assert.deepEqual(
    deltas.map((d) => [d.cursor, d.event.type]),
    [
      [1, 'chunk'],
      [2, 'tool-call'],
    ]
  );
  assert.equal(hub.snapshot('run-a').parts[0].type, 'narration');
});

test('hub: 后加入者拿到完整快照，快照不会被外部修改', () => {
  const hub = new RunStreamHub({ flushMs: 0 });
  hub.begin({ runId: 'run-a', sessionId: 'S-a', ownerTabId: 1, instruction: '做' });
  hub.push('run-a', { type: 'reasoning', text: '思考' });
  hub.flush('run-a');
  hub.push('run-a', { type: 'chunk', text: '正文' });
  hub.flush('run-a');
  const snap = hub.findBySession('S-a');
  assert.ok(snap);
  assert.equal(snap.parts[0].type, 'thinking');
  assert.equal(snap.parts[0].text, '思考');
  assert.equal(snap.narration, '正文');
  snap.parts.push({ type: 'hacked' });
  assert.equal(hub.findBySession('S-a').parts.some((p) => p.type === 'hacked'), false);
});

test('hub: 取快照前先冲刷未广播文本，避免新订阅者收到重复增量', () => {
  const deltas = [];
  const hub = new RunStreamHub({ flushMs: 1000, onDelta: (d) => deltas.push(d) });
  hub.begin({ runId: 'run-a', sessionId: 'S-a', ownerTabId: 1 });
  hub.push('run-a', { type: 'reasoning', text: '思考' });
  const snap = hub.findBySession('S-a');
  assert.equal(snap.reasoning, '思考');
  assert.equal(snap.cursor, 1);
  assert.equal(deltas.length, 1);
  // 之后再调用 flush 不应再次广播已经进入 snapshot 的文本。
  hub.flush('run-a');
  assert.equal(deltas.length, 1);
});

test('hub: finish 冲刷尾量并广播结束快照', () => {
  const ends = [];
  const hub = new RunStreamHub({ flushMs: 1000, onEnd: (s) => ends.push(s) });
  hub.begin({ runId: 'run-a', sessionId: 'S-a', ownerTabId: 1 });
  hub.push('run-a', { type: 'chunk', text: '尾量' });
  const done = hub.finish('run-a', 'completed');
  assert.equal(done.narration, '尾量');
  assert.equal(done.status, 'completed');
  assert.equal(ends.length, 1);
});

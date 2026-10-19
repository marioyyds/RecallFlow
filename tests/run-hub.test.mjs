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

test('run hub: 同 runId 续跑保留刷新前的步骤，并把状态切回 running', () => {
  // 整页刷新会让旧端口断开，SW 先把 run finish('cancelled') 落盘；
  // 新面板随后用同一个 runId 续跑。若 begin 直接返回旧快照，状态会永远停在
  // cancelled，跟随页不再接收 delta，新面板也拿不到刷新前的工具步骤。
  const starts = [];
  const hub = new RunStreamHub({ flushMs: 0, onStart: (s) => starts.push(s) });
  hub.begin({ runId: 'run-r', sessionId: 'S-r', ownerTabId: 7, instruction: '整页刷新' });
  hub.push('run-r', { type: 'tool-call', callId: 'c1', name: 'get_page_snapshot', args: {} });
  hub.push('run-r', { type: 'tool-result', callId: 'c1', name: 'get_page_snapshot', status: 'completed', result: '快照' });
  hub.finish('run-r', 'cancelled');

  const resumed = hub.begin({ runId: 'run-r', sessionId: 'S-r', ownerTabId: 7, instruction: '整页刷新' });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.parts.length, 2, '刷新前的工具调用与结果必须还在');
  assert.equal(resumed.parts[0].name, 'get_page_snapshot');
  assert.equal(starts.length, 2, '续跑要重新广播 started，订阅者才知道 run 又活了');
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

test('run state: 登录拦截提示随 tool-result 进入快照与跟随页', () => {
  const s = state();
  applyRunEvent(s, {
    type: 'tool-result',
    callId: 'c-login',
    name: 'click_element',
    status: 'completed',
    result: '点击已派发',
    needsLogin: true,
    loginUrl: 'https://site.test/login?return=%2Fwork',
    authMessage: '操作被登录拦截：当前页面需要先登录后才能继续。',
    authChallenge: {
      required: true,
      reason: 'login-required',
      summary: '操作被登录拦截',
      message: '操作被登录拦截：当前页面需要先登录后才能继续。',
      loginUrl: 'https://site.test/login?return=%2Fwork',
    },
  });
  const part = s.parts.find((p) => p.type === 'tool-result');
  assert.equal(part.needsLogin, true);
  assert.equal(part.authChallenge.loginUrl, 'https://site.test/login?return=%2Fwork');
  const msg = runStateToAssistantMessage(s);
  const followed = msg.parts.find((p) => p.type === 'tool-result');
  assert.equal(followed.needsLogin, true, '跟随页必须拿到同一份登录提示状态');
  assert.equal(followed.authChallenge.reason, 'login-required');
});

test('run state: 支付/账号安全拦截随 tool-result 同步到跟随页', () => {
  const s = state();
  applyRunEvent(s, {
    type: 'tool-result',
    callId: 'c-pay',
    name: 'click_element',
    status: 'failed',
    result: '已阻止自动执行',
    needsUserAction: true,
    sensitiveAction: {
      blocked: true,
      category: 'payment-commit',
      userPrompt: '该操作会确认支付，请用户本人完成。',
    },
  });
  const part = runStateToAssistantMessage(s).parts.find((p) => p.type === 'tool-result');
  assert.equal(part.needsUserAction, true);
  assert.equal(part.sensitiveAction.category, 'payment-commit');
});

test('run state: 停止请求会进入「停止中」，结束事件再清掉停止标记', () => {
  const s = state();
  applyRunEvent(s, { type: 'stop-requested', byTabId: 22 });
  assert.equal(s.stopping, true);
  assert.equal(s.progress.state, 'stopping');
  assert.equal(s.status, 'running', '停止请求不是立即结束，run 还在收尾');

  applyRunEvent(s, { type: 'end' });
  assert.equal(s.stopping, false);
  assert.equal(s.status, 'ended');
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

test('hub: 定时器不能以 hub 作为 this 调用（浏览器里是 Illegal invocation）', () => {
  // 原生 window.setTimeout 要求 this=window；`this.setTimer(...)` 会把 this 绑到 hub。
  // 一旦抛错，第一次文本 flush 就停了，跟随页只能靠轮询快照 → 看起来“不流式”。
  let called = 0;
  const hub = new RunStreamHub({
    flushMs: 1,
    setTimer(cb, ms) {
      called += 1;
      assert.equal(this, undefined, 'setTimer 必须以普通函数调用，而不是 hub 的方法调用');
      return setTimeout(cb, ms);
    },
  });
  hub.begin({ runId: 'run-timer', sessionId: 'S-timer', ownerTabId: 1 });
  hub.push('run-timer', { type: 'chunk', text: 'x' });
  assert.equal(called, 1);
});

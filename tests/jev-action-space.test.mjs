import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JEV_MIN_ACTION_CONFIDENCE,
  JEV_HANDOFF_QUESTION,
  JEV_EXPECTED_PROGRESS_QUESTION,
  JEV_NEXT_ACTION_QUESTION,
  JEV_PAGE_READY_QUESTION,
  buildJevFastRequest,
  compareJevShadowAction,
  formatJevDecisionSummary,
  interpretJevFastDecision,
} from '../lib/application/agent/jev-action-space.ts';
import { JevFastController } from '../lib/application/agent/jev-controller.ts';
import { restoreJevLoopState } from '../lib/application/agent/jev-loop-state.ts';

function response(choice, confidence, probabilities = {}, signals = {}) {
  return {
    model: 'jev-1.14.0',
    answers: {
      [JEV_NEXT_ACTION_QUESTION]: {
        type: 'choice',
        choice,
        confidence,
        probabilities: Object.keys(probabilities).length
          ? probabilities
          : { [choice]: confidence, escalate: 1 - confidence },
      },
      [JEV_HANDOFF_QUESTION]: {
        type: 'noul',
        noul: signals.handoff ?? 0.1,
      },
      [JEV_EXPECTED_PROGRESS_QUESTION]: {
        type: 'noul',
        noul: signals.expectedProgress ?? 0.9,
      },
      [JEV_PAGE_READY_QUESTION]: {
        type: 'noul',
        noul: signals.pageReady ?? 0.9,
      },
    },
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

test('快思考暴露观察、滚动和升级动作，不直接生成内容', () => {
  const { request, actions } = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'research',
    instruction: '读取订单表并找出总额',
    pageUrl: 'https://example.com/orders',
    pageTitle: 'Orders',
    pageText: 'Order,Amount\nA,10',
    recentTools: ['get_page_snapshot'],
  });
  const question = request.questions[JEV_NEXT_ACTION_QUESTION];
  assert.equal(request.model, 'jev-latest');
  assert.equal(question.type, 'choice');
  assert.deepEqual(Object.keys(question.criteria).sort(), [
    'accessibility',
    'diagnostics',
    'escalate',
    'read_page',
    'read_table',
    'scroll_down',
    'snapshot',
  ]);
  assert.equal(request.questions[JEV_HANDOFF_QUESTION].type, 'noul');
  assert.equal(request.questions[JEV_EXPECTED_PROGRESS_QUESTION].type, 'noul');
  assert.equal(request.questions[JEV_PAGE_READY_QUESTION].type, 'noul');
  assert.equal('messages' in request, false);
  assert.equal(actions.read_table.toolName, 'read_table');
  assert.equal(actions.diagnostics.toolName, 'read_diagnostics');
});

test('高置信度只读建议转换为类型明确、参数受控的工具调用', () => {
  const { actions } = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'browsing',
    instruction: '读取订单表',
  });
  const decision = interpretJevFastDecision(
    response('read_table', JEV_MIN_ACTION_CONFIDENCE),
    actions
  );
  assert.deepEqual(decision, {
    kind: 'act',
    actionKey: 'read_table',
    toolName: 'read_table',
    args: {},
    description: actions.read_table.description,
    confidence: JEV_MIN_ACTION_CONFIDENCE,
    probabilities: {
      read_table: JEV_MIN_ACTION_CONFIDENCE,
      escalate: 1 - JEV_MIN_ACTION_CONFIDENCE,
    },
    signals: {
      handoff: 0.1,
      expectedProgress: 0.9,
      pageReady: 0.9,
    },
  });
});

test('中等 handoff 只风险门控动作，不再一票否决可靠的局部动作', () => {
  const { actions } = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'browsing',
    instruction: '读取订单表',
  });
  const readDecision = interpretJevFastDecision(
    response('read_table', 0.95, {}, { handoff: 0.63, expectedProgress: 0.66, pageReady: 0.65 }),
    actions
  );
  assert.equal(readDecision.kind, 'act', '只读动作在中等 handoff 下仍可安全执行');

  const dynamic = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '点击下一步',
    snapshot: {
      fingerprint: 'fp-ready',
      elements: [{ ref: 'rf-1', tag: 'button', label: '下一步', inViewport: true }],
    },
  });
  const clickDecision = interpretJevFastDecision(
    response('click_0', 0.95, {}, { handoff: 0.67, expectedProgress: 0.66, pageReady: 0.65 }),
    dynamic.actions
  );
  assert.equal(clickDecision.kind, 'act', '有进展且页面可靠的安全点击不应被 67% handoff 否决');

  assert.equal(
    interpretJevFastDecision(
      response('read_table', 0.95, {}, { handoff: 0.9, expectedProgress: 0.9, pageReady: 0.9 }),
      actions
    ).reason,
    'handoff-requested',
    '极高 handoff 仍然强制交给慢思考'
  );
  assert.equal(
    interpretJevFastDecision(
      response('read_table', 0.95, {}, { expectedProgress: 0.2 }),
      actions
    ).reason,
    'low-expected-progress'
  );

  assert.equal(
    interpretJevFastDecision(
      response('click_0', 0.95, {}, { pageReady: 0.2 }),
      dynamic.actions
    ).reason,
    'page-not-ready'
  );
  assert.equal(
    interpretJevFastDecision(
      response('click_0', 0.95, {}, { handoff: 0.67, expectedProgress: 0.4, pageReady: 0.55 }),
      dynamic.actions
    ).reason,
    'handoff-requested',
    '中等 handoff 下，进展或页面稳定度不足的点击仍要移交'
  );
});

test('低置信度、模型升级和未知动作都升级到慢思考', () => {
  const { actions } = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'browsing',
    instruction: '读取订单表',
  });
  assert.equal(
    interpretJevFastDecision(response('read_table', JEV_MIN_ACTION_CONFIDENCE - 0.01), actions).reason,
    'low-confidence'
  );
  assert.equal(
    interpretJevFastDecision(response('escalate', 0.99), actions).reason,
    'model-escalation'
  );
  assert.equal(
    interpretJevFastDecision(response('click_element', 0.99), actions).reason,
    'unknown-action'
  );
});

test('移交摘要保留候选动作与置信度，便于判断是动作错误还是全局策略过保守', () => {
  const { actions } = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'browsing',
    instruction: '读取订单表',
  });
  const decision = interpretJevFastDecision(
    response('read_table', 0.93, {}, { handoff: 0.9 }),
    actions
  );
  const text = formatJevDecisionSummary(false, decision, 123);
  assert.match(text, /移交慢思考：handoff-requested/);
  assert.match(text, /候选 read_table，93%/);
  assert.match(text, /123ms/);
});

test('影子模式比较 JEV 建议与慢思考首个动作', () => {
  const { actions } = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'browsing',
    instruction: '读取订单表',
  });
  const suggestion = interpretJevFastDecision(response('read_table', 0.9), actions);
  assert.equal(
    compareJevShadowAction(suggestion, ['read_table', 'complete_task']).agreed,
    true
  );
  assert.equal(
    compareJevShadowAction(suggestion, ['get_page_snapshot']).agreed,
    false
  );
  assert.equal(
    compareJevShadowAction({ kind: 'escalate', reason: 'model-escalation' }, [], '直接回答').agreed,
    true
  );
});

test('最新快照生成安全元素候选，并排除发布等高风险点击', () => {
  const { request, actions } = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '继续完善内容并预览',
    snapshot: {
      fingerprint: 'fp-1',
      elements: [
        { ref: 'rf-1', tag: 'button', role: 'button', label: '生成图片', inViewport: true },
        { ref: 'rf-2', tag: 'xhs-publish-btn', role: 'button', label: '发布', inViewport: true },
        { ref: 'rf-3', tag: 'div', label: '不可交互说明', inViewport: true },
      ],
      capabilities: { editables: { count: 1 } },
    },
  });
  const criteria = request.questions[JEV_NEXT_ACTION_QUESTION].criteria;
  assert.ok(criteria.click_0);
  assert.match(criteria.click_0, /生成图片/);
  assert.equal(actions.click_0.toolName, 'click_element');
  assert.equal(Object.values(actions).some((action) => action.description.includes('发布')), false);
});

function makeState(shadowMode) {
  return {
    settings: {
      jev: {
        enabled: true,
        shadowMode,
        baseUrl: 'https://api.typesafe.ai',
        apiKey: 'test',
        model: 'jev-latest',
        requestTimeoutMs: 1000,
        maxRetries: 0,
        schemaVersion: 'jev.recallflow.v1',
      },
    },
    intent: 'browser_task',
    instruction: '读取订单表',
    selectedText: '',
    detected: { sourceText: '读取订单表' },
    ctx: {
      pageUrl: 'https://example.com',
      pageTitle: 'Orders',
      page: 'Order,Amount',
      lastSnapshot: null,
      lastEvidence: '',
      lastReadFullText: '',
    },
    ranToolNames: [],
    failedToolNames: [],
    toolCallCount: 0,
    jevLoop: restoreJevLoopState(null),
    messages: [],
    totalTokens: 0,
    trace() {},
    emit() {},
  };
}

test('控制器在非影子模式只执行受控只读动作，并复用现有工具流水线', async () => {
  const state = makeState(false);
  const emitted = [];
  const diagnostics = [];
  state.emit = (event) => emitted.push(event);
  let processed = null;
  const pipeline = {
    process: async (step) => {
      processed = step;
      return { kind: 'continue', toolMs: 1 };
    },
  };
  const controller = new JevFastController(
    state,
    pipeline,
    new AbortController().signal,
    async () => response('read_table', 0.95),
    async (entry) => diagnostics.push(entry)
  );
  const outcome = await controller.runAvailable(0, async () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcome.kind, 'act');
  assert.equal(state.messages.length, 1);
  assert.equal(processed.toolCalls[0].name, 'read_table');
  assert.deepEqual(processed.toolCalls[0].args, {});
  assert.equal(processed.lane, 'fast');
  assert.equal(processed.assistantMessage.lane, 'fast');
  assert.equal(emitted[0]?.type, 'jev-decision');
  assert.match(emitted[0]?.message || '', /^⚡ 快思考：/);
  assert.match(emitted[0]?.message || '', /handoff \d+%/);
  assert.equal(diagnostics.at(-1)?.state, 'act');
  assert.equal(diagnostics.at(-1)?.tool, 'read_table');
  assert.equal(state.totalTokens, 12);
});

test('控制器在影子模式不执行工具', async () => {
  const state = makeState(true);
  const diagnostics = [];
  let called = false;
  const controller = new JevFastController(
    state,
    { process: async () => { called = true; return { kind: 'continue', toolMs: 0 }; } },
    new AbortController().signal,
    async () => response('read_table', 0.95),
    async (entry) => diagnostics.push(entry)
  );
  const outcome = await controller.runAvailable(0, async () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcome.kind, 'shadow');
  assert.equal(called, false);
  assert.equal(state.messages.length, 0);
  assert.equal(diagnostics.at(-1)?.state, 'shadow');
  assert.equal(diagnostics.at(-1)?.tool, 'read_table');
});

test('移交后同一页面状态进入冷却，快照或阶段变化才重新尝试', async () => {
  const state = makeState(false);
  let calls = 0;
  const controller = new JevFastController(
    state,
    { process: async () => ({ kind: 'continue', toolMs: 0 }) },
    new AbortController().signal,
    async () => {
      calls += 1;
      return response('escalate', 0.99);
    }
  );

  const first = await controller.runAvailable(0, async () => {});
  assert.equal(first.kind, 'skipped');
  assert.equal(calls, 1);
  assert.equal(state.jevLoop.attempts, 1);

  state.toolCallCount += 1;
  const cooldown = await controller.runAvailable(1, async () => {});
  assert.equal(cooldown.kind, 'skipped');
  assert.equal(calls, 1, '页面指纹和阶段都没变时不得重复询问同一个 handoff');
  assert.equal(state.jevLoop.attempts, 1);

  state.ctx.lastSnapshot = { fingerprint: 'fp-new', elements: [] };
  state.toolCallCount += 1;
  const changed = await controller.runAvailable(2, async () => {});
  assert.equal(changed.kind, 'skipped');
  assert.equal(calls, 2, '出现新页面快照后应允许重新判断');
  assert.equal(state.jevLoop.attempts, 2);
});

test('页面状态变化后允许新的快思考片段，单片段最多连续三步', async () => {
  const state = makeState(false);
  state.ctx.lastSnapshot = {
    fingerprint: 'fp-1',
    elements: [
      { ref: 'rf-1', tag: 'button', role: 'button', label: '下一步', inViewport: true },
    ],
  };
  let calls = 0;
  const pipeline = {
    process: async () => {
      state.toolCallCount += 1;
      state.ctx.lastEvidence = 'evidence-' + state.toolCallCount;
      return { kind: 'continue', toolMs: 1 };
    },
  };
  const controller = new JevFastController(
    state,
    pipeline,
    new AbortController().signal,
    async (_settings, request) => {
      calls += 1;
      const action = calls === 1 ? 'snapshot' : 'click_0';
      assert.ok(request.questions.next_action.criteria[action]);
      return response(action, 0.95);
    }
  );

  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  assert.equal(calls, 3, '三段应分别观察、点击、再观察，随后停止快路径');
  assert.equal(state.jevLoop.attempts, 3);
  assert.equal(state.jevLoop.fastActions, 2, '重复动作会被防抖拒绝，不产生第三个副作用');

  state.toolCallCount += 1;
  state.ctx.lastEvidence = 'slow-tool-evidence';
  controller.noteSlowTurn();
  assert.equal(state.jevLoop.consecutiveFastActions, 0);
});

test('快路径失败后允许一次不同动作恢复，恢复成功会清零失败连击', async () => {
  const state = makeState(false);
  let calls = 0;
  const pipeline = {
    process: async () => {
      state.toolCallCount += 1;
      if (state.toolCallCount === 1) {
        state.failedToolNames.push('read_table');
        return { kind: 'continue', toolMs: 1 };
      }
      state.ctx.lastEvidence = 'recovered';
      return { kind: 'continue', toolMs: 1 };
    },
  };
  const controller = new JevFastController(
    state,
    pipeline,
    new AbortController().signal,
    async () => response(calls++ === 0 ? 'read_table' : 'read_page', 0.95)
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  assert.equal(state.toolCallCount, 2);
  assert.equal(state.jevLoop.consecutiveFailures, 0);
});

test('连续两次工具失败后停止快路径并写入 handoff', async () => {
  const state = makeState(false);
  const emitted = [];
  state.emit = (event) => emitted.push(event);
  let calls = 0;
  const pipeline = {
    process: async () => {
      state.toolCallCount += 1;
      state.failedToolNames.push('failure-' + state.toolCallCount);
      return { kind: 'continue', toolMs: 1 };
    },
  };
  const controller = new JevFastController(
    state,
    pipeline,
    new AbortController().signal,
    async () => response(calls++ === 0 ? 'read_table' : 'read_page', 0.95)
  );
  await controller.runAvailable(0, async () => {});
  assert.equal(state.jevLoop.consecutiveFailures, 2);
  assert.match(String(state.messages.at(-1)?.content || ''), /tool-failure-limit/);
  assert.ok(emitted.some((event) => event.type === 'jev-handoff' && event.reason === 'tool-failure-limit'));
  assert.match(emitted.find((event) => event.type === 'jev-handoff')?.message || '', /^↪ 慢思考接管：/);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JEV_MIN_ACTION_CONFIDENCE,
  JEV_NEXT_ACTION_QUESTION,
  buildJevFastRequest,
  compareJevShadowAction,
  interpretJevFastDecision,
} from '../lib/application/agent/jev-action-space.ts';
import { JevFastController } from '../lib/application/agent/jev-controller.ts';
import { restoreJevLoopState } from '../lib/application/agent/jev-loop-state.ts';

function response(choice, confidence, probabilities = {}) {
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
    'escalate',
    'read_page',
    'read_table',
    'scroll_down',
    'snapshot',
  ]);
  assert.equal('messages' in request, false);
  assert.equal(actions.read_table.toolName, 'read_table');
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
  });
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
    async () => response('read_table', 0.95)
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  assert.equal(state.messages.length, 1);
  assert.equal(processed.toolCalls[0].name, 'read_table');
  assert.deepEqual(processed.toolCalls[0].args, {});
  assert.equal(state.totalTokens, 12);
});

test('控制器在影子模式不执行工具', async () => {
  const state = makeState(true);
  let called = false;
  const controller = new JevFastController(
    state,
    { process: async () => { called = true; return { kind: 'continue', toolMs: 0 }; } },
    new AbortController().signal,
    async () => response('read_table', 0.95)
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'shadow');
  assert.equal(called, false);
  assert.equal(state.messages.length, 0);
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

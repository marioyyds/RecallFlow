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

test('快思考只暴露两个只读动作和一个升级动作', () => {
  const request = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
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
    'escalate',
    'read_current_page',
    'read_table',
  ]);
  assert.equal('messages' in request, false);
});

test('高置信度只读建议转换为类型明确、参数受控的工具调用', () => {
  const decision = interpretJevFastDecision(response('read_table', JEV_MIN_ACTION_CONFIDENCE));
  assert.deepEqual(decision, {
    kind: 'act',
    toolName: 'read_table',
    args: {},
    confidence: JEV_MIN_ACTION_CONFIDENCE,
    probabilities: {
      read_table: JEV_MIN_ACTION_CONFIDENCE,
      escalate: 1 - JEV_MIN_ACTION_CONFIDENCE,
    },
  });
});

test('低置信度、模型升级和未知动作都升级到慢思考', () => {
  assert.equal(
    interpretJevFastDecision(response('read_table', JEV_MIN_ACTION_CONFIDENCE - 0.01)).reason,
    'low-confidence'
  );
  assert.equal(
    interpretJevFastDecision(response('escalate', 0.99)).reason,
    'model-escalation'
  );
  assert.equal(
    interpretJevFastDecision(response('click_element', 0.99)).reason,
    'unknown-action'
  );
});

test('影子模式比较 JEV 建议与慢思考首个动作', () => {
  const suggestion = interpretJevFastDecision(response('read_table', 0.9));
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
    ctx: { pageUrl: 'https://example.com', pageTitle: 'Orders', page: 'Order,Amount' },
    ranToolNames: [],
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
  const outcome = await controller.runOnce(0, async () => {});
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
  const outcome = await controller.runOnce(0, async () => {});
  assert.equal(outcome.kind, 'shadow');
  assert.equal(called, false);
  assert.equal(state.messages.length, 0);
});

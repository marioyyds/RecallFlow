import test from 'node:test';
import assert from 'node:assert/strict';

import { JEV_EDGE_QUESTION } from '../../lib/application/agent/jev-action-space.ts';
import { JevFastController, selectCandidatesByTier } from '../../lib/application/agent/jev-controller.ts';
import { normalizePlanNextAction } from '../../lib/application/agent/plan-contract.ts';
import { restoreJevLoopState } from '../../lib/application/agent/jev-loop-state.ts';
import { emptyTraceGraph } from '../../lib/application/agent/tracegraph-store.ts';

function snapshot(fingerprint = 'fp-1') {
  return {
    version: 2,
    url: 'https://gitcode.com/owner/repo/pull/compare',
    title: 'Create Pull Request',
    text: '创建 PR',
    fingerprint,
    capabilities: {},
    elements: [
      {
        tag: 'button',
        role: 'button',
        label: 'CreateButton',
        ref: 'rf-create',
        selector: '#create',
        valuePresent: true,
        inViewport: true,
      },
    ],
  };
}

function graphWithEdge(edgeOverrides = {}) {
  const state = snapshot();
  const graph = emptyTraceGraph('https://gitcode.com');
  graph.l0.states.push({
    id: 's-pr-form',
    name: 'PRFormPage',
    urlPattern: '/pull/compare',
    staticAtoms: ['button:button'],
    dynamicAtoms: [],
  });
  graph.l1.edges.push({
    id: 'e.create',
    from: 'PRFormPage',
    to: 'PRDetailPage',
    g: '创建 PR',
    action: {
      tool: 'click_element',
      argsTemplate: { selector: '#create' },
      risk: 'low',
    },
    slots: [],
    s: { semanticAnchor: { role: 'button', name: 'CreateButton' } },
    r: 'low',
    phiMinus: [
      { kind: 'url_pattern', expr: '/pull/compare', source: 'structured' },
      { kind: 'no_dialog', expr: 'dialog == null', source: 'structured' },
    ],
    phiPlus: { kind: 'diff_exists', expr: 'page_diff', source: 'structured' },
    provenance: {
      recordIds: ['r1'],
      verifiedAt: Date.now(),
      siteKey: 'https://gitcode.com',
      ttlMs: 1_800_000,
    },
    status: 'verified',
    ...edgeOverrides,
  });
  // Ensure the test's URL still maps to the declared state.
  graph.updatedAt = Date.now();
  return { graph, state };
}

function stateFor(shadowMode = false) {
  return {
    settings: {
      apiKey: 'chat',
      model: 'chat',
      baseUrl: 'https://example.test',
      jev: {
        enabled: true,
        shadowMode: false,
        baseUrl: 'https://jev.test',
        apiKey: 'jev',
        model: 'jev-latest',
        requestTimeoutMs: 1000,
        maxRetries: 0,
        maxAttemptsPerRun: 20,
        maxConsecutiveActions: 5,
        maxRepeatedActionsWithoutProgress: 3,
      },
      traceGraph: {
        enabled: true,
        mode: 'live',
        shadowMode,
        ttlMs: 1_800_000,
      },
    },
    intent: 'browser_task',
    instruction: '创建 PR',
    selectedText: '',
    detected: { sourceText: '创建 PR' },
    ctx: {
      pageUrl: 'https://gitcode.com/owner/repo/pull/compare',
      pageTitle: 'Create Pull Request',
      page: '创建 PR',
      lastSnapshot: snapshot(),
      lastEvidence: '',
      lastReadFullText: '',
      plan: [],
      planVersion: 1,
      traceGraphSlots: {},
    },
    ranToolNames: [],
    failedToolNames: [],
    toolCallCount: 0,
    jevLoop: restoreJevLoopState(null),
    messages: [],
    totalTokens: 0,
    traces: [],
    trace(entry) {
      this.traces.push(entry);
    },
    emit() {},
  };
}

function pipelineFor(state, { clickChangesPage = true } = {}) {
  return {
    async process(step) {
      for (const call of step.toolCalls) {
        state.toolCallCount += 1;
        state.ranToolNames.push(call.name);
        if (call.name === 'click_element' && clickChangesPage) {
          state.ctx.lastSnapshot = snapshot('fp-2');
        } else if (call.name === 'get_page_snapshot') {
          state.ctx.lastSnapshot = {
            ...(state.ctx.lastSnapshot || snapshot()),
            fingerprint: state.ctx.lastSnapshot?.fingerprint || 'fp-1',
          };
        }
      }
      return { kind: 'continue', toolMs: 1 };
    },
  };
}

function edgeResponse(edgeId, abstainProbability = 0.02) {
  const confidence = 1 - abstainProbability;
  return {
    model: 'jev',
    answers: {
      [JEV_EDGE_QUESTION]: {
        type: 'choice',
        choice: edgeId,
        confidence,
      },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function abstainResponse(confidence = 0.9) {
  return {
    model: 'jev',
    answers: {
      [JEV_EDGE_QUESTION]: { type: 'choice', choice: 'ABSTAIN', confidence },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function operationBlockedResponse(confidence = 0.9) {
  return {
    model: 'jev',
    answers: { operation: { type: 'choice', choice: 'BLOCKED', confidence } },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function operationClickResponse(request) {
  const targets = request && request.questions && request.questions.click_target;
  const key = targets ? Object.keys(targets.criteria)[0] : '1';
  return {
    model: 'jev',
    answers: {
      operation: { type: 'choice', choice: 'CLICK', confidence: 0.99 },
      click_target: { type: 'choice', choice: key, confidence: 0.99 },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

test('委托动作：慢模型写计划的那一轮就完成一次点击，不调 JEV', async () => {
  const state = stateFor(false);
  state.settings.jev.maxConsecutiveActions = 1; // 只跑这一步，避免后续回退再调 JEV
  state.ctx.plan = [{
    id: 'p1',
    text: '点创建按钮',
    status: 'in_progress',
    nextAction: { tool: 'click_element', name: 'CreateButton', note: '推进表单' },
  }];
  state.ctx.planVersion = 1;
  const graph = emptyTraceGraph('https://gitcode.com');
  const calls = [];
  let jevCalls = 0;
  const controller = new JevFastController(
    state,
    {
      async process(step) {
        calls.push(...step.toolCalls);
        return pipelineFor(state).process(step);
      },
    },
    new AbortController().signal,
    async () => {
      jevCalls += 1;
      return edgeResponse('e.create');
    },
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  assert.equal(jevCalls, 0, '委托动作不该再付一次 systemone');
  const click = calls.find((call) => call.name === 'click_element');
  assert.ok(click, '必须真的执行了点击');
  assert.deepEqual(click.args, { ref: 'rf-create' });
  assert.equal(state.ctx.plan[0].nextAction, undefined, '委托动作只消费一次');
  assert.ok(
    state.traces.some((entry) => entry.phase === 'delegate-action' && entry.decision === 'EXECUTE')
  );
});

test('委托动作目标不唯一时不动手，清空后交回慢思考', async () => {
  const state = stateFor(false);
  state.ctx.plan = [{
    id: 'p1',
    text: '点一个不存在的按钮',
    status: 'in_progress',
    nextAction: { tool: 'click_element', name: '不存在的按钮' },
  }];
  state.ctx.planVersion = 1;
  const graph = emptyTraceGraph('https://gitcode.com');
  const controller = new JevFastController(
    state,
    pipelineFor(state),
    new AbortController().signal,
    async () => operationBlockedResponse(),
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'skipped');
  // 委托被拒后回退到 operation；operation 判断 BLOCKED，才交回慢思考。
  assert.equal(outcome.reason, 'model-blocked');
  assert.equal(state.ranToolNames.includes('click_element'), false);
  assert.equal(state.ctx.plan[0].nextAction, undefined);
  assert.ok(
    state.traces.some((entry) => entry.phase === 'delegate-action' && entry.decision === 'REJECT')
  );
});

test('计划显式禁止快动作时，委托不执行但保留 nextAction', async () => {
  const state = stateFor(false);
  state.ctx.plan = [{
    id: 'p1',
    text: '只读，不许点击',
    status: 'in_progress',
    allowedOperations: [],
    nextAction: { tool: 'click_element', name: 'CreateButton' },
  }];
  state.ctx.planVersion = 1;
  const graph = emptyTraceGraph('https://gitcode.com');
  const calls = [];
  const controller = new JevFastController(
    state,
    pipelineFor(state),
    new AbortController().signal,
    async () => edgeResponse('e.create'),
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'skipped');
  assert.equal(calls.includes('click_element'), false);
  assert.ok(state.ctx.plan[0].nextAction, '未获授权时不消费委托');
  assert.ok(
    state.traces.some((entry) => entry.phase === 'delegate-action' && entry.reason === 'not-authorized')
  );
});

test('委托动作归一化：白名单、必需的锚点与按键', () => {
  assert.equal(normalizePlanNextAction({ tool: 'type_text', value: 'x' }), undefined);
  assert.equal(normalizePlanNextAction({ tool: 'click_element' }), undefined);
  assert.deepEqual(
    normalizePlanNextAction({ tool: 'click_element', name: '下一步', role: 'button' }),
    { tool: 'click_element', name: '下一步', role: 'button' }
  );
  assert.equal(normalizePlanNextAction({ tool: 'press_key', name: '标题' }), undefined, '缺 key');
  assert.deepEqual(
    normalizePlanNextAction({ tool: 'press_key', name: '标题', key: 'Enter' }),
    { tool: 'press_key', name: '标题', key: 'Enter' }
  );
  assert.equal(normalizePlanNextAction({ tool: 'open_tab' }), undefined, '缺 url');
});

test('open_tab 指向当前 URL 时不执行（no-op 导航）', async () => {
  const state = stateFor(false);
  const { graph } = graphWithEdge({
    id: 'e.same-url',
    g: 'open_tab 「/pull/compare」',
    action: { tool: 'open_tab', argsTemplate: {}, risk: 'low' },
    slots: [],
    s: { semanticAnchor: { kind: 'selector', urlPattern: '/pull/compare' } },
  });
  const calls = [];
  const controller = new JevFastController(
    state,
    {
      async process(step) {
        calls.push(...step.toolCalls);
        return pipelineFor(state).process(step);
      },
    },
    new AbortController().signal,
    async () => edgeResponse('e.same-url'),
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'skipped');
  assert.equal(calls.some((call) => call.name === 'open_tab'), false);
  const trace = state.traces.find((entry) => entry.phase === 'tracegraph-candidates');
  // open_tab 已经不进快路候选（导航是慢路）；它被算在 filteredSlowTools 里。
  assert.equal(trace.filteredSlowTools, 1);
});

test('提示/前置条件文案的边不进快路候选', async () => {
  const state = stateFor(false);
  const { graph } = graphWithEdge({
    id: 'e.hint',
    g: 'click_element 「填写标题才可自动保存」',
    s: { semanticAnchor: { role: 'button', name: '填写标题才可自动保存' } },
  });
  const calls = [];
  const controller = new JevFastController(
    state,
    {
      async process(step) {
        calls.push(...step.toolCalls);
        return pipelineFor(state).process(step);
      },
    },
    new AbortController().signal,
    async () => operationBlockedResponse(),
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'skipped');
  assert.equal(calls.some((call) => call.name === 'click_element'), false);
  const trace = state.traces.find((entry) => entry.phase === 'tracegraph-candidates');
  assert.equal(trace.filteredHintEdges, 1);
});

test('同一动作连续两次无页面变化后停止（no-progress）', async () => {
  const state = stateFor(false);
  state.settings.jev.maxConsecutiveActions = 1;
  const graph = emptyTraceGraph('https://gitcode.com');
  let jevCalls = 0;
  const controller = new JevFastController(
    state,
    pipelineFor(state, { clickChangesPage: false }),
    new AbortController().signal,
    async (_settings, request) => {
      jevCalls += 1;
      return operationClickResponse(request);
    },
    async () => {},
    async () => graph
  );
  const first = await controller.runAvailable(0, async () => {});
  assert.equal(first.kind, 'act');
  assert.equal(jevCalls, 1);

  // 不改变 fingerprint（pipelineFor 只推进计数），同一点击再来一次。
  state.settings.jev.maxConsecutiveActions = 5;
  state.toolCallCount = state.jevLoop.lastToolCallCount + 1;
  const second = await controller.runAvailable(1, async () => {});
  assert.equal(second.kind, 'skipped');
  assert.equal(second.reason, 'no-progress');
  assert.equal(jevCalls, 2);
});

test('委托名称是控件可见文字的前缀时仍能唯一定位', async () => {
  const state = stateFor(false);
  state.settings.jev.maxConsecutiveActions = 1;
  state.ctx.lastSnapshot.elements.push({
    tag: 'input',
    role: 'textbox',
    label: '请输入文章标题（5~100个字）',
    ref: 'rf-title',
    selector: '#title',
    inViewport: true,
  });
  state.ctx.plan = [{
    id: 'p1',
    text: '激活标题输入框',
    status: 'in_progress',
    nextAction: { tool: 'click_element', name: '请输入文章标题', note: '激活标题' },
  }];
  state.ctx.planVersion = 1;
  const graph = emptyTraceGraph('https://gitcode.com');
  const calls = [];
  const controller = new JevFastController(
    state,
    {
      async process(step) {
        calls.push(...step.toolCalls);
        return pipelineFor(state).process(step);
      },
    },
    new AbortController().signal,
    async () => {
      throw new Error('委托成功后不该再调 JEV');
    },
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  const click = calls.find((call) => call.name === 'click_element');
  assert.ok(click);
  assert.deepEqual(click.args, { ref: 'rf-title' });
  assert.ok(
    state.traces.some(
      (entry) => entry.phase === 'delegate-action' && entry.reason === 'name-prefix'
    )
  );
});

test('让位时把页面提示转告慢思考，而不是当成按钮', async () => {
  const state = stateFor(false);
  state.ctx.lastSnapshot.elements.push({
    tag: 'button',
    role: 'button',
    label: '填写标题才可自动保存',
    ref: 'rf-hint',
    selector: '#hint',
    inViewport: true,
  });
  const graph = emptyTraceGraph('https://gitcode.com');
  const controller = new JevFastController(
    state,
    pipelineFor(state),
    new AbortController().signal,
    async () => operationBlockedResponse(),
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'skipped');
  const note = state.messages.filter((message) => message.role === 'system').at(-1);
  assert.match(note.content, /页面提示「填写标题才可自动保存」/);
  assert.match(note.content, /前置条件/);
});

test('高风险语义边（发布/删除/支付）不进快路候选', async () => {
  const state = stateFor(false);
  const { graph } = graphWithEdge({
    id: 'e.publish',
    g: 'click_element 「发布文章」',
    action: { tool: 'click_element', argsTemplate: { selector: '#publish' }, risk: 'high' },
    slots: [],
    s: { semanticAnchor: { role: 'button', name: '发布文章' } },
    r: 'high',
  });
  const calls = [];
  const controller = new JevFastController(
    state,
    {
      async process(step) {
        calls.push(...step.toolCalls);
        return pipelineFor(state).process(step);
      },
    },
    new AbortController().signal,
    async () => operationBlockedResponse(),
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'skipped');
  assert.equal(calls.some((call) => call.name === 'click_element'), false);
  const trace = state.traces.find((entry) => entry.phase === 'tracegraph-candidates');
  assert.equal(trace.filteredRiskyEdges, 1, '发布边必须在候选阶段被摘掉');
});

test('同一状态有 full 页内动作时，open_tab 候选让位', async () => {
  const state = stateFor(false);
  const { graph } = graphWithEdge({ fromSignatures: ['PRFormPage#button:button#'] });
  const base = graph.l1.edges[0];
  graph.l1.edges.push({
    ...base,
    id: 'e.nav',
    g: 'open_tab 「/elsewhere」',
    action: { tool: 'open_tab', argsTemplate: { url: 'https://gitcode.com/elsewhere' }, risk: 'low' },
    slots: [],
    s: { semanticAnchor: { kind: 'selector', urlPattern: '/elsewhere' } },
    provenance: { ...base.provenance, recordIds: ['r-nav'] },
    fromSignatures: ['PRFormPage#button:button#'],
  });
  let request = null;
  const controller = new JevFastController(
    state,
    pipelineFor(state),
    new AbortController().signal,
    async (_settings, payload) => {
      if (!request) request = payload;
      return edgeResponse('e.create');
    },
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  const criteria = request.questions[JEV_EDGE_QUESTION].criteria;
  assert.deepEqual(Object.keys(criteria), ['e.create', 'ABSTAIN']);
  const trace = state.traces.find((entry) => entry.phase === 'tracegraph-candidates');
  assert.equal(trace.filteredSlowTools, 1);
});

test('open_tab 后页面未挂载时补一次观察（settle）', async () => {
  const state = stateFor(false);
  state.settings.jev.maxConsecutiveActions = 1;
  state.ctx.plan = [{
    id: 'p1',
    text: '打开新页',
    status: 'in_progress',
    nextAction: { tool: 'open_tab', url: 'https://gitcode.com/elsewhere' },
  }];
  state.ctx.planVersion = 1;
  const graph = emptyTraceGraph('https://gitcode.com');
  let opened = false;
  let observesAfterOpen = 0;
  const controller = new JevFastController(
    state,
    {
      async process(step) {
        for (const call of step.toolCalls) {
          state.toolCallCount += 1;
          state.ranToolNames.push(call.name);
          if (call.name === 'open_tab') {
            opened = true;
            // 新标签页还没挂载：快照为空。
            state.ctx.lastSnapshot = { ...snapshot(), elements: [], fingerprint: 'fp-blank' };
          } else if (call.name === 'get_page_snapshot' && opened) {
            observesAfterOpen += 1;
            if (observesAfterOpen >= 2) {
              state.ctx.lastSnapshot = snapshot('fp-loaded');
            }
          }
        }
        return { kind: 'continue', toolMs: 1 };
      },
    },
    new AbortController().signal,
    async () => {
      throw new Error('委托 open_tab 不该调用 JEV');
    },
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  assert.equal(observesAfterOpen, 2, '空快照后必须补拍一次');
  assert.ok(state.traces.some((entry) => entry.phase === 'tracegraph-settle'));
});

test('无候选边时回退到 operation：CLICK 直接执行，不交回慢思考', async () => {
  const state = stateFor(false);
  state.settings.jev.maxConsecutiveActions = 1;
  const graph = emptyTraceGraph('https://gitcode.com');
  const calls = [];
  let jevCalls = 0;
  const controller = new JevFastController(
    state,
    {
      async process(step) {
        calls.push(...step.toolCalls);
        return pipelineFor(state).process(step);
      },
    },
    new AbortController().signal,
    async (_settings, request) => {
      jevCalls += 1;
      return operationClickResponse(request);
    },
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  assert.equal(jevCalls, 1, '回退路径仍要一次 systemone');
  const click = calls.find((call) => call.name === 'click_element');
  assert.ok(click, '点击必须真的执行');
  assert.equal(state.ranToolNames.includes('click_element'), true);
  assert.ok(
    state.traces.some((entry) => entry.phase === 'jev' && entry.fallback === true),
    'trace 必须标明这是 operation 回退'
  );
});

test('operation 判 BLOCKED 时做路由冷却；只读回合不唤醒，动作后解除', async () => {
  const state = stateFor(false);
  const graph = emptyTraceGraph('https://gitcode.com');
  let jevCalls = 0;
  const controller = new JevFastController(
    state,
    pipelineFor(state),
    new AbortController().signal,
    async () => {
      jevCalls += 1;
      return operationBlockedResponse();
    },
    async () => {},
    async () => graph
  );
  const first = await controller.runAvailable(0, async () => {});
  assert.equal(first.reason, 'model-blocked');

  state.toolCallCount += 1;
  const cooled = await controller.runAvailable(1, async () => {});
  assert.equal(cooled.reason, 'route-cooldown');
  assert.equal(jevCalls, 1);

  // 指纹变了但慢思考只做了只读：不唤醒快路（否则每次读页面都白付一次 systemone）。
  state.ctx.lastSnapshot = snapshot('fp-2');
  state.toolCallCount += 1;
  state.ranToolNames.push('read_current_page');
  const readOnly = await controller.runAvailable(2, async () => {});
  assert.equal(readOnly.reason, 'no-page-change');
  assert.equal(jevCalls, 1);

  // 真正改变页面的动作之后才解除。
  state.toolCallCount += 1;
  state.ranToolNames.push('click_element');
  const changed = await controller.runAvailable(3, async () => {});
  assert.equal(changed.reason, 'model-blocked');
  assert.equal(jevCalls, 2, '慢思考动过页面才允许再试');
});

test('只读回合后若有委托，闸门放行并执行委托', async () => {
  const state = stateFor(false);
  state.settings.jev.maxConsecutiveActions = 1;
  const graph = emptyTraceGraph('https://gitcode.com');
  const calls = [];
  const controller = new JevFastController(
    state,
    {
      async process(step) {
        calls.push(...step.toolCalls);
        return pipelineFor(state).process(step);
      },
    },
    new AbortController().signal,
    async () => operationBlockedResponse(),
    async () => {},
    async () => graph
  );
  const first = await controller.runAvailable(0, async () => {});
  assert.equal(first.reason, 'model-blocked');

  // 慢思考只做了一次读，但同一轮写下了委托：闸门必须放行。
  state.toolCallCount += 1;
  state.ranToolNames.push('read_current_page');
  state.ctx.plan = [{
    id: 'p1',
    text: '点创建按钮',
    status: 'in_progress',
    nextAction: { tool: 'click_element', name: 'CreateButton' },
  }];
  state.ctx.planVersion = 1;
  const outcome = await controller.runAvailable(1, async () => {});
  assert.equal(outcome.kind, 'act');
  const click = calls.find((call) => call.name === 'click_element');
  assert.ok(click, '委托必须被执行');
  assert.deepEqual(click.args, { ref: 'rf-create' });
});

test('选不出时做路由冷却；指纹变化但只读时不唤醒，动作后解除', async () => {
  const state = stateFor(false);
  const { graph } = graphWithEdge();
  let jevCalls = 0;
  const controller = new JevFastController(
    state,
    pipelineFor(state),
    new AbortController().signal,
    async (_settings, request) => {
      jevCalls += 1;
      if (request.questions && request.questions[JEV_EDGE_QUESTION]) return abstainResponse();
      return operationBlockedResponse();
    },
    async () => {},
    async () => graph
  );
  const first = await controller.runAvailable(0, async () => {});
  assert.equal(first.reason, 'model-blocked', 'edge abstain 后回退 operation，也被拦');
  assert.equal(jevCalls, 2, '一次边决策 + 一次回退决策');

  state.toolCallCount += 1;
  const cooled = await controller.runAvailable(1, async () => {});
  assert.equal(cooled.reason, 'route-cooldown');
  assert.equal(jevCalls, 2, '同一视图不该重复付 systemone');

  state.ctx.lastSnapshot = snapshot('fp-2');
  state.toolCallCount += 1;
  state.ranToolNames.push('read_current_page');
  const readOnly = await controller.runAvailable(2, async () => {});
  assert.equal(readOnly.reason, 'no-page-change');
  assert.equal(jevCalls, 2);

  state.toolCallCount += 1;
  state.ranToolNames.push('click_element');
  const changed = await controller.runAvailable(3, async () => {});
  assert.equal(changed.reason, 'model-blocked');
  assert.equal(jevCalls, 4, '慢思考真正动了页面才允许再试，且每条路由各补一次');
});

test('edge abstain 时回退 operation 再决策一次（同一路由只补一次）', async () => {
  const state = stateFor(false);
  state.settings.jev.maxConsecutiveActions = 1;
  const { graph } = graphWithEdge();
  const calls = [];
  let jevCalls = 0;
  const controller = new JevFastController(
    state,
    {
      async process(step) {
        calls.push(...step.toolCalls);
        return pipelineFor(state).process(step);
      },
    },
    new AbortController().signal,
    async (_settings, request) => {
      jevCalls += 1;
      if (request.questions && request.questions[JEV_EDGE_QUESTION]) {
        return abstainResponse();
      }
      return operationClickResponse(request);
    },
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  assert.equal(jevCalls, 2, '先问边、再问 operation');
  const click = calls.find((call) => call.name === 'click_element');
  assert.ok(click, 'abstain 不该把可执行动作整轮丢给慢思考');
  assert.equal(click.args.ref, 'rf-create');
  assert.ok(state.traces.some((entry) => entry.phase === 'edge-fallback'));
});

test('计划步骤明确禁止快动作时，edge abstain 不回退 operation', async () => {
  const state = stateFor(false);
  state.ctx.plan = [{
    id: 'p1',
    text: '只读，不许操作页面',
    status: 'in_progress',
    allowedOperations: [],
  }];
  state.ctx.planVersion = 1;
  const { graph } = graphWithEdge();
  let jevCalls = 0;
  const controller = new JevFastController(
    state,
    pipelineFor(state),
    new AbortController().signal,
    async () => {
      jevCalls += 1;
      return abstainResponse();
    },
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'skipped');
  assert.equal(outcome.reason, 'edge-abstain');
  assert.equal(jevCalls, 1, '计划禁止快动作时不再多问一次');
});

test('同一视图同一原因的让位提示不重复塞进模型上下文', async () => {
  const state = stateFor(false);
  const graph = emptyTraceGraph('https://gitcode.com');
  const controller = new JevFastController(
    state,
    pipelineFor(state),
    new AbortController().signal,
    async () => edgeResponse('e.create'),
    async () => {},
    async () => graph
  );
  await controller.runAvailable(0, async () => {});
  state.toolCallCount += 1;
  state.ctx.lastSnapshot = snapshot('fp-2');
  state.ranToolNames.push('read_current_page');
  await controller.runAvailable(1, async () => {});
  const notes = state.messages.filter(
    (message) => message.role === 'system' && /非页面故障/.test(String(message.content || ''))
  );
  assert.equal(notes.length, 1, '只读回合被闸门挡住，不再重复塞提示');
  const handoffs = state.traces.filter((entry) => entry.phase === 'jev-handoff');
  assert.equal(handoffs.length, 1);
  assert.equal(
    state.traces.some((entry) => entry.phase === 'jev-skip' && entry.reason === 'no-page-change'),
    true,
    '闸门必须留下 trace'
  );
});

test('live TraceGraph：JEV 选边并 Grounding 后直接执行一个动作', async () => {
  const state = stateFor(false);
  const calls = [];
  const steps = [];
  const { graph } = graphWithEdge({
    action: {
      tool: 'click_element',
      argsTemplate: { selector: '#old-create' },
      risk: 'high',
    },
  });
  const controller = new JevFastController(
    state,
    {
      async process(step) {
        steps.push(step);
        calls.push(...step.toolCalls);
        return pipelineFor(state).process(step);
      },
    },
    new AbortController().signal,
    async () => edgeResponse('e.create'),
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  const clickCalls = calls.filter((call) => call.name === 'click_element');
  assert.equal(clickCalls.length, 1);
  assert.deepEqual(clickCalls[0].args, { ref: 'rf-create' });
  assert.equal(
    steps.some((step) =>
      step.skipApproval === true &&
      step.toolCalls.some((call) => call.name === 'click_element')
    ),
    true
  );
  assert.equal(state.ranToolNames.includes('click_element'), true);
  assert.deepEqual(state.jevLoop.executedEdges, ['e.create']);
  assert.equal(state.jevLoop.wrongWrites, 0);
});

test('TraceGraph shadow 只计数，不产生 GUI 动作', async () => {
  const state = stateFor(true);
  const { graph } = graphWithEdge();
  const controller = new JevFastController(
    state,
    pipelineFor(state),
    new AbortController().signal,
    async () => edgeResponse('e.create'),
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'skipped');
  assert.equal(outcome.reason, 'tracegraph-shadow');
  assert.equal(state.ranToolNames.includes('click_element'), false);
});

test('edge 执行后不再用 φ⁺ 反向否决已经完成的动作', async () => {
  const state = stateFor(false);
  state.settings.jev.maxConsecutiveActions = 1;
  const { graph } = graphWithEdge();
  const controller = new JevFastController(
    state,
    pipelineFor(state, { clickChangesPage: false }),
    new AbortController().signal,
    async () => edgeResponse('e.create'),
    async () => {},
    async () => graph
  );
  const first = await controller.runAvailable(0, async () => {});
  assert.equal(first.kind, 'act');
  assert.equal(state.jevLoop.wrongWrites, 0);
  assert.deepEqual(state.jevLoop.blockedEdgeIds, []);
  const clickCount = state.ranToolNames.filter((name) => name === 'click_element').length;
  assert.equal(clickCount, 1);
});

test('selectCandidatesByTier 只在有 full 时收起 name 档；没有 full 时一个都不剪', () => {
  const full = { match: { level: 'full' } };
  const stat = { match: { level: 'static' } };
  const name = { match: { level: 'name' } };
  assert.deepEqual(selectCandidatesByTier([full, stat, name]), [full]);
  assert.deepEqual(selectCandidatesByTier([stat, name]), [stat, name]);
  assert.deepEqual(selectCandidatesByTier([]), []);
});

test('存在 full 匹配时只把 full 档发给 JEV（name 档被收起）', async () => {
  const state = stateFor(false);
  const { graph } = graphWithEdge({ fromSignatures: ['PRFormPage#button:button#'] });
  const base = graph.l1.edges[0];
  graph.l1.edges.push({
    ...base,
    id: 'e.other',
    action: { tool: 'click_element', argsTemplate: { selector: '#other' }, risk: 'low' },
    s: { semanticAnchor: { role: 'button', name: 'Other' } },
    provenance: { ...base.provenance, recordIds: ['r2'] },
    fromSignatures: ['PRFormPage#button:button+input:text#'],
  });
  let request = null;
  const controller = new JevFastController(
    state,
    pipelineFor(state),
    new AbortController().signal,
    async (_settings, payload) => {
      if (!request) request = payload;
      return edgeResponse('e.create');
    },
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  const criteria = request.questions[JEV_EDGE_QUESTION].criteria;
  assert.deepEqual(Object.keys(criteria), ['e.create', 'ABSTAIN']);
});

test('目标在当前快照里不存在时，候选边在请求前就被过滤掉', async () => {
  const state = stateFor(false);
  const { graph } = graphWithEdge();
  const base = graph.l1.edges[0];
  graph.l1.edges.push({
    ...base,
    id: 'e.gone',
    action: { tool: 'click_element', argsTemplate: { selector: '#gone' }, risk: 'low' },
    s: { semanticAnchor: { role: 'button', name: 'MissingButton' } },
    provenance: { ...base.provenance, recordIds: ['r3'] },
  });
  let request = null;
  const controller = new JevFastController(
    state,
    pipelineFor(state),
    new AbortController().signal,
    async (_settings, payload) => {
      if (!request) request = payload;
      return edgeResponse('e.create');
    },
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  const criteria = request.questions[JEV_EDGE_QUESTION].criteria;
  assert.deepEqual(Object.keys(criteria), ['e.create', 'ABSTAIN']);
  const trace = state.traces.find((entry) => entry.phase === 'tracegraph-candidates');
  assert.equal(trace.filteredTargetMissing, 1);
});

test('页内候选目标都定位不到时不执行边动作；回退 operation 也交回', async () => {
  const state = stateFor(false);
  const { graph } = graphWithEdge({
    s: { semanticAnchor: { role: 'button', name: 'MissingButton' } },
  });
  let calls = 0;
  const controller = new JevFastController(
    state,
    pipelineFor(state),
    new AbortController().signal,
    async () => {
      calls += 1;
      return operationBlockedResponse();
    },
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(calls, 1, '预过滤清空边候选后，回退 operation 仍会问一次 JEV');
  assert.equal(outcome.kind, 'skipped');
  assert.equal(outcome.reason, 'model-blocked');
  assert.equal(state.ranToolNames.includes('click_element'), false);
  const trace = state.traces.find((entry) => entry.phase === 'tracegraph-candidates');
  assert.equal(trace.filteredTargetMissing, 1);
  // 让位提示不能写成“页面故障”，否则慢模型会把它读成“还没加载完”并重拍快照
  // （RF-XKJ4M7 实测）。它必须明确：非页面故障 + 不要等待/重读。
  const note = state.messages.filter((message) => message.role === 'system').at(-1);
  assert.match(note.content, /非页面故障/);
  assert.match(note.content, /不要因为这条提示而等待/);
  assert.doesNotMatch(note.content, /快路径已停止/);
});

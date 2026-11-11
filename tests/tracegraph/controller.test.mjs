import test from 'node:test';
import assert from 'node:assert/strict';

import { JEV_EDGE_QUESTION } from '../../lib/application/agent/jev-action-space.ts';
import { JevFastController, selectCandidatesByTier } from '../../lib/application/agent/jev-controller.ts';
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
      risk: 'high',
    },
    slots: [],
    s: { semanticAnchor: { role: 'button', name: 'CreateButton' } },
    r: 'high',
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

test('全部候选目标都定位不到时不调用 JEV，交回慢思考', async () => {
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
      return edgeResponse('e.create');
    },
    async () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(calls, 0);
  assert.equal(outcome.kind, 'skipped');
  assert.equal(outcome.reason, 'edge-target-missing');
  assert.equal(state.ranToolNames.includes('click_element'), false);
  // 让位提示不能写成“页面故障”，否则慢模型会把它读成“还没加载完”并重拍快照
  // （RF-XKJ4M7 实测）。它必须明确：非页面故障 + 不要等待/重读。
  const note = state.messages.filter((message) => message.role === 'system').at(-1);
  assert.match(note.content, /非页面故障/);
  assert.match(note.content, /不要因为这条提示而等待/);
  assert.doesNotMatch(note.content, /快路径已停止/);
});

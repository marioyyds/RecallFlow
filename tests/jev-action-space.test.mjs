import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JEV_CLICK_TARGET_QUESTION,
  JEV_MIN_ACTION_CONFIDENCE,
  JEV_MIN_CLICK_CONFIDENCE,
  JEV_MIN_READ_CONFIDENCE,
  JEV_MIN_WAIT_CONFIDENCE,
  JEV_OPERATION_QUESTION,
  buildJevFastRequest,
  compareJevShadowAction,
  formatJevDecisionSummary,
  interpretJevFastDecision,
} from '../lib/application/agent/jev-action-space.ts';
import { JevFastController } from '../lib/application/agent/jev-controller.ts';
import { parseJevSystemOneResponse } from '../lib/application/agent/jev-contract.ts';
import { restoreJevLoopState } from '../lib/application/agent/jev-loop-state.ts';

function pageSnapshot(overrides = {}) {
  return {
    version: 2,
    url: 'https://example.com/editor',
    title: 'Editor',
    text: '上传图文 文字配图 标题 正文',
    fingerprint: 'fp-1',
    scroll: { y: 0, height: 2000, viewport: 800 },
    capabilities: { editables: { count: 1, samples: [] } },
    elements: [
      {
        ref: 'rf-1',
        tag: 'button',
        role: 'button',
        label: '上传图文',
        inViewport: true,
      },
      {
        ref: 'rf-2',
        tag: 'input',
        role: 'textbox',
        type: 'text',
        label: '填写标题',
        placeholder: '填写标题会有更多赞哦',
        valuePresent: false,
        inViewport: true,
      },
      {
        ref: 'rf-3',
        tag: 'button',
        role: 'button',
        label: '发布',
        inViewport: true,
      },
      {
        ref: 'rf-4',
        tag: 'div',
        label: '不可交互说明',
        inViewport: true,
      },
    ],
    ...overrides,
  };
}

function choice(ids, selected, confidence = 0.95) {
  return {
    type: 'choice',
    choice: selected,
    confidence,
  };
}

function responseFor(bundle, operation, operationConfidence = 0.95) {
  const answers = {
    [JEV_OPERATION_QUESTION]: choice(
      Object.keys(bundle.operations),
      operation,
      operationConfidence
    ),
  };
  // 快路径只剩 CLICK 一个 target head；输入能力已经交给慢思考回合。
  for (const targets of Object.values(bundle.targets)) {
    answers[JEV_CLICK_TARGET_QUESTION] = choice(
      Object.keys(targets),
      Object.keys(targets)[0]
    );
  }
  return {
    model: 'jev-1.14.0',
    answers,
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

function bundleFromRequest(request) {
  const operations = Object.fromEntries(
    Object.keys(request.questions[JEV_OPERATION_QUESTION].criteria).map((key) => [key, {}])
  );
  const targets = {};
  if (request.questions[JEV_CLICK_TARGET_QUESTION]) {
    targets.CLICK = Object.fromEntries(
      Object.keys(request.questions[JEV_CLICK_TARGET_QUESTION].criteria).map((key) => [key, {}])
    );
  }
  
  return { operations, targets };
}

test('JEV 使用 operation 与 CLICK target head，不再询问 handoff 概率或输入能力', () => {
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '把内容填入标题',
    pageUrl: 'https://example.com/editor',
    pageTitle: 'Editor',
    pageText: '上传图文 文字配图 标题 正文',
    snapshot: pageSnapshot(),
  });
  assert.deepEqual(
    Object.keys(bundle.request.questions).sort(),
    [JEV_CLICK_TARGET_QUESTION, JEV_OPERATION_QUESTION].sort()
  );
  assert.equal('type_text_target' in bundle.request.questions, false);
  assert.equal('handoff_now' in bundle.request.questions, false);
  assert.equal('expected_progress' in bundle.request.questions, false);
  assert.equal('page_ready' in bundle.request.questions, false);
  assert.ok(bundle.operations.CLICK);
  assert.equal(bundle.operations.TYPE_TEXT, undefined, '快路径不再提供输入 operation');
  assert.ok(bundle.targets.CLICK);
  assert.equal(bundle.targets.TYPE_TEXT, undefined, '快路径不再有 type_text target head');
  assert.equal(
    Object.values(bundle.targets.CLICK).some((target) => target.ref === 'rf-2'),
    false,
    '文本输入框既不能进入 CLICK target head，也不再有自己的 target head'
  );
});

test('高风险发布按钮不会成为 CLICK 候选，输入框也不进入任何 target head', () => {
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '先上传图文，再填写标题',
    pageText: '上传图文 文字配图 标题 正文',
    snapshot: pageSnapshot(),
  });
  const clickTargets = Object.values(bundle.targets.CLICK);
  assert.equal(clickTargets.some((target) => target.label === '上传图文'), true);
  assert.equal(clickTargets.some((target) => target.label === '发布'), false);
  assert.equal(
    clickTargets.some((target) => target.label === '填写标题'),
    false,
    '输入框既不是 CLICK 候选，也没有自己的 target head'
  );
  assert.equal(bundle.targets.TYPE_TEXT, undefined);
});

test('高置信 CLICK 只消费 click_target', () => {
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '点击上传图文',
    pageText: '上传图文 文字配图 标题 正文',
    snapshot: pageSnapshot(),
  });
  const response = responseFor(bundle, 'CLICK', 0.97);
  const decision = interpretJevFastDecision(response, bundle);
  assert.equal(decision.kind, 'act');
  assert.equal(decision.operation, 'CLICK');
  assert.equal(decision.toolName, 'click_element');
  assert.equal(decision.target.label, '上传图文');
});

test('operation 与 CLICK target head 能通过 TypeSafe 响应校验', () => {
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '点击上传图文',
    snapshot: pageSnapshot(),
  });
  const parsed = parseJevSystemOneResponse(
    responseFor(bundle, 'CLICK'),
    bundle.request.questions
  );
  const decision = interpretJevFastDecision(parsed, bundle);
  assert.equal(decision.kind, 'act');
  assert.equal(decision.operation, 'CLICK');
  assert.equal(decision.target.label, '上传图文');
});

test('目标动作使用独立的 operation 分支下限，而非完整动作阈值', () => {
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '点击上传图文',
    pageText: '上传图文 文字配图 标题 正文',
    snapshot: pageSnapshot(),
  });
  const lowOperation = responseFor(
    bundle,
    'CLICK',
    0.8
  );
  const decision = interpretJevFastDecision(lowOperation, bundle);
  assert.equal(decision.kind, 'act');
  assert.equal(decision.operation, 'CLICK');
  assert.equal(decision.target.label, '上传图文');
  assert.equal(decision.targetConfidence, 0.95);
  assert.equal(decision.confidence, 0.95);

  const belowBranchFloor = responseFor(bundle, 'CLICK', 0.6);
  assert.equal(
    interpretJevFastDecision(belowBranchFloor, bundle).reason,
    'low-confidence'
  );

  const lowTarget = responseFor(bundle, 'CLICK', 0.99);
  lowTarget.answers[JEV_CLICK_TARGET_QUESTION] = choice(
    Object.keys(bundle.targets.CLICK),
    Object.keys(bundle.targets.CLICK)[0],
    JEV_MIN_CLICK_CONFIDENCE - 0.01
  );
  assert.equal(interpretJevFastDecision(lowTarget, bundle).reason, 'low-confidence');

  const bothLow = responseFor(bundle, 'CLICK', 0.2);
  bothLow.answers[JEV_CLICK_TARGET_QUESTION] = choice(
    Object.keys(bundle.targets.CLICK),
    Object.keys(bundle.targets.CLICK)[0],
    0.6
  );
  assert.equal(interpretJevFastDecision(bothLow, bundle).reason, 'low-confidence');

  const lowRead = responseFor(bundle, 'READ_PAGE', JEV_MIN_READ_CONFIDENCE - 0.01);
  assert.equal(interpretJevFastDecision(lowRead, bundle).reason, 'low-confidence');
});

test('候选数和各动作置信度使用设置覆盖值', () => {
  const elements = Array.from({ length: 12 }, (_, index) => ({
    ref: 'rf-' + index,
    tag: 'button',
    role: 'button',
    label: '操作 ' + index,
    inViewport: true,
  }));
  const custom = buildJevFastRequest(
    {
      model: 'jev-latest',
      maxElementCandidates: 5,
      minReadConfidence: 0.61,
      minActionConfidence: 0.63,
      minClickConfidence: 0.65,
      minWaitConfidence: 0.41,
      minTargetOperationConfidence: 0.55,
    },
    {
      intent: 'browser_task',
      phase: 'editor',
      instruction: '执行操作',
      snapshot: pageSnapshot({ elements, text: '操作' }),
    }
  );
  assert.equal(custom.elements.length <= 5, true);
  assert.equal(custom.operations.CLICK.minConfidence, 0.65);
  assert.equal(custom.operations.READ_PAGE.minConfidence, 0.61);
  assert.equal(custom.operations.WAIT.minConfidence, 0.41);
  assert.equal(custom.operations.CLICK.minBranchConfidence, 0.55);
  const noInput = buildJevFastRequest(
    {
      model: 'jev-latest',
      minActionConfidence: 0.63,
    },
    {
      intent: 'browser_task',
      phase: 'editor',
      instruction: '填写标题',
      snapshot: pageSnapshot(),
    }
  );
  assert.equal(noInput.operations.TYPE_TEXT, undefined);
  assert.equal(noInput.targets.TYPE_TEXT, undefined);
  assert.equal('type_text_target' in noInput.request.questions, false);
});

test('可编辑输入框既不出现在 elements 表，也不进入 CLICK target head', () => {
  const snapshot = pageSnapshot({
    elements: [
      {
        ref: 'rf-title',
        tag: 'input',
        role: 'textbox',
        type: 'text',
        label: '文章标题',
        valuePresent: false,
        inViewport: true,
      },
      {
        ref: 'rf-body',
        tag: 'div',
        role: 'textbox',
        label: '正文',
        selector: 'div.editor__inner:nth-of-type(1)',
        inViewport: true,
      },
      {
        ref: 'rf-upload',
        tag: 'button',
        role: 'button',
        label: '上传图文',
        inViewport: true,
      },
    ],
  });
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '先上传图文，再填写标题',
    snapshot,
  });
  assert.deepEqual(
    bundle.elements.map((row) => row.ref),
    ['rf-upload'],
    '输入框（含 contenteditable）不再是候选元素，只有可点击元素进表'
  );
  assert.deepEqual(
    bundle.elements[0].operations,
    ['CLICK'],
    '元素行不再提供 TYPE_TEXT'
  );
  const clickTargets = Object.values(bundle.targets.CLICK);
  assert.equal(clickTargets.length, 1);
  assert.equal(clickTargets[0].ref, 'rf-upload');
  assert.equal(
    clickTargets.some(
      (target) => target.ref === 'rf-title' || target.ref === 'rf-body'
    ),
    false
  );
  assert.equal(bundle.targets.TYPE_TEXT, undefined);
});

test('WAIT 使用独立低风险阈值，不再与读取共用同一门槛', () => {
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '等待编辑器加载',
    snapshot: pageSnapshot({ elements: [], text: '正在加载' }),
  });
  const wait = interpretJevFastDecision(
    responseFor(bundle, 'WAIT', JEV_MIN_WAIT_CONFIDENCE + 0.05),
    bundle
  );
  assert.equal(wait.kind, 'act');
  assert.equal(wait.operation, 'WAIT');

  const strict = buildJevFastRequest(
    { model: 'jev-latest', minWaitConfidence: 0.75 },
    {
      intent: 'browser_task',
      phase: 'editor',
      instruction: '等待编辑器加载',
      snapshot: pageSnapshot({ elements: [], text: '正在加载' }),
    }
  );
  assert.equal(
    interpretJevFastDecision(responseFor(strict, 'WAIT', 0.65), strict).reason,
    'low-confidence'
  );
});

test('DONE 和 BLOCKED 是显式 operation，不是额外 noul', () => {
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'verification',
    instruction: '确认发布成功',
    pageText: '发布成功',
    snapshot: pageSnapshot({ url: 'https://example.com/publish/success' }),
  });
  const done = interpretJevFastDecision(responseFor(bundle, 'DONE', 0.9), bundle);
  assert.equal(done.kind, 'done');
  const blocked = interpretJevFastDecision(responseFor(bundle, 'BLOCKED', 0.9), bundle);
  assert.equal(blocked.kind, 'blocked');
  assert.equal(blocked.reason, 'model-blocked');
});

test('PlanCard 将 JEV operation head 投影到当前子目标允许的动作', () => {
  const bundle = buildJevFastRequest(
    { model: 'jev-latest' },
    {
      intent: 'browser_task',
      phase: 'editor',
      instruction: '先读取页面，暂不点击或填写',
      pageText: '上传图文 表格 标题 正文',
      snapshot: pageSnapshot(),
      plan: [{
        id: 'read-only',
        text: '读取当前页面',
        status: 'in_progress',
        successPredicate: '获得页面正文',
        allowedOperations: ['READ_PAGE'],
        leaseActions: 2,
      }],
      planVersion: 7,
      leaseRemaining: 2,
    }
  );
  assert.deepEqual(
    Object.keys(bundle.operations).sort(),
    ['BLOCKED', 'DONE', 'READ_PAGE'].sort(),
    'DONE/BLOCKED 始终保留为安全出口，其它动作由 PlanCard 收紧'
  );
  assert.equal(bundle.targets.CLICK, undefined);
  assert.equal(bundle.targets.TYPE_TEXT, undefined);
  const state = bundle.request.state;
  assert.equal(state.task.plan.version, 7);
  assert.equal(state.task.plan.stepId, 'read-only');
  assert.deepEqual(state.task.plan.allowedOperations, ['READ_PAGE']);
  assert.equal(state.task.plan.leaseRemaining, 2);
});

test('移交摘要显示 operation、目标与置信度', () => {
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '点击上传图文',
    snapshot: pageSnapshot(),
  });
  const decision = interpretJevFastDecision(responseFor(bundle, 'CLICK', 0.97), bundle);
  const summary = formatJevDecisionSummary(false, decision, 123);
  assert.match(summary, /CLICK/);
  assert.match(summary, /上传图文/);
  assert.match(summary, /95%/);
  assert.match(summary, /123ms/);
});

test('影子比较使用选定 operation 对应的工具', () => {
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '点击上传图文',
    snapshot: pageSnapshot(),
  });
  const decision = interpretJevFastDecision(responseFor(bundle, 'CLICK'), bundle);
  assert.equal(compareJevShadowAction(decision, ['click_element']).agreed, true);
  assert.equal(compareJevShadowAction(decision, ['type_text']).agreed, false);
});

function makeState(shadowMode = false) {
  return {
    settings: {
      apiKey: 'chat-key',
      model: 'chat-model',
      baseUrl: 'https://api.example.com',
      requestTimeoutMs: 1000,
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
    instruction: '点击上传图文',
    selectedText: '',
    detected: { sourceText: '点击上传图文' },
    ctx: {
      pageUrl: 'https://example.com/editor',
      pageTitle: 'Editor',
      page: '上传图文 文字配图 标题 正文',
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

function fakePipeline(state, onTool = () => {}) {
  return {
    async process(step) {
      for (const call of step.toolCalls) {
        state.toolCallCount += 1;
        state.ranToolNames.push(call.name);
        onTool(call, state);
        if (call.name === 'get_page_snapshot') {
          const fingerprint = 'fp-' + state.toolCallCount;
          state.ctx.lastSnapshot = pageSnapshot({ fingerprint });
        }
      }
      return { kind: 'continue', toolMs: 1 };
    },
  };
}

test('控制器先原子观察，再让 JEV 执行一个 operation 并重新观察', async () => {
  const state = makeState(false);
  const calls = [];
  const diagnostics = [];
  state.emit = () => {};
  let turn = 0;
  const controller = new JevFastController(
    state,
    fakePipeline(state, (call) => calls.push(call.name)),
    new AbortController().signal,
    async (_settings, request) => {
      turn += 1;
      return turn === 1
        ? responseFor(bundleFromRequest(request), 'READ_PAGE')
        : responseFor(bundleFromRequest(request), 'BLOCKED');
    },
    async (entry) => diagnostics.push(entry)
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  assert.deepEqual(calls, [
    'get_page_snapshot',
    'read_current_page',
    'get_page_snapshot',
  ]);
  assert.equal(diagnostics.at(-1)?.state, 'handoff');
});

test('影子模式只观察和决策，不执行 JEV 动作', async () => {
  const state = makeState(true);
  const calls = [];
  const controller = new JevFastController(
    state,
    fakePipeline(state, (call) => calls.push(call.name)),
    new AbortController().signal,
    async (_settings, request) => {
      return responseFor(bundleFromRequest(request), 'CLICK');
    }
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'shadow');
  assert.deepEqual(calls, ['get_page_snapshot']);
});

test('连续动作上限由设置控制，内部快思考文案不进入聊天历史', async () => {
  const state = makeState(false);
  state.settings.jev.maxConsecutiveActions = 1;
  const calls = [];
  const controller = new JevFastController(
    state,
    fakePipeline(state, (call) => calls.push(call.name)),
    new AbortController().signal,
    async (_settings, request) => {
      return responseFor(bundleFromRequest(request), 'CLICK');
    }
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  assert.equal(outcome.decisions.length, 1);
  assert.equal(calls.filter((name) => name === 'click_element').length, 1);
  assert.equal(
    state.messages.some(
      (message) =>
        message.role === 'assistant' &&
        /JEV 快思考|重新观察页面/.test(String(message.content || ''))
    ),
    false
  );
});

test('同一动作在页面指纹变化后允许继续推进，不再第二次就移交', async () => {
  const state = makeState(false);
  state.settings.jev.maxConsecutiveActions = 3;
  const calls = [];
  const controller = new JevFastController(
    state,
    fakePipeline(state, (call) => calls.push(call.name)),
    new AbortController().signal,
    async (_settings, request) => {
      return responseFor(bundleFromRequest(request), 'CLICK');
    }
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  assert.equal(outcome.decisions.length, 3);
  assert.equal(calls.filter((name) => name === 'click_element').length, 3);
  assert.equal(state.jevLoop.lastOutcome, 'act');
});

test('同一动作无进展的重试次数来自设置', async () => {
  const state = makeState(false);
  state.settings.jev.maxConsecutiveActions = 6;
  state.settings.jev.maxRepeatedActionsWithoutProgress = 2;
  let clicks = 0;
  const fixedSnapshot = pageSnapshot({ fingerprint: 'fixed' });
  const pipeline = {
    async process(step) {
      for (const call of step.toolCalls) {
        state.toolCallCount += 1;
        state.ranToolNames.push(call.name);
        if (call.name === 'click_element') clicks += 1;
        if (call.name === 'get_page_snapshot') state.ctx.lastSnapshot = fixedSnapshot;
      }
      return { kind: 'continue', toolMs: 1 };
    },
  };
  const controller = new JevFastController(
    state,
    pipeline,
    new AbortController().signal,
    async (_settings, request) => {
      return responseFor(bundleFromRequest(request), 'CLICK');
    }
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  assert.equal(outcome.decisions.length, 2);
  assert.equal(clicks, 2);
  assert.equal(state.jevLoop.lastOutcome, 'repeated-action');
});

test('JEV 返回未被提供的 TYPE_TEXT 时移交慢思考，不执行任何写入', async () => {
  const state = makeState(false);
  const calls = [];
  const controller = new JevFastController(
    state,
    fakePipeline(state, (call) => calls.push(call)),
    new AbortController().signal,
    async (_settings, request) => {
      const bundle = bundleFromRequest(request);
      // bundle.operations 里没有 TYPE_TEXT —— 正好构成「模型返回了未被提供的 operation」。
      return responseFor(bundle, 'TYPE_TEXT');
    }
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'skipped');
  assert.equal(outcome.reason, 'invalid-answer');
  assert.equal(
    calls.some((call) => call.name === 'type_text'),
    false,
    '快路径不再执行任何输入：' + calls.map((call) => call.name).join(',')
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ['get_page_snapshot'],
    '只允许动作前的原子观察'
  );
  assert.equal(state.ranToolNames.includes('type_text'), false);
  assert.ok(
    (state.jevLoop.handoffReasons['invalid-answer'] || 0) >= 1,
    '移交原因必须记账：' + JSON.stringify(state.jevLoop.handoffReasons)
  );
});

test('edge 目标缺失时不执行动作；回退 operation 再决定', async () => {
  const state = makeState(false);
  state.settings.traceGraph = { enabled: true, mode: 'live', shadowMode: false };
  state.ctx.lastSnapshot = pageSnapshot({ fingerprint: 'fp-1' });
  // 锚点取自一个当前快照里不存在的控件（真实场景：写入型目标的 label 就是正文，
  // 写完就变，下次按 name 精确比对必然 0 命中）。
  const edge = {
    id: 'e.missing-target',
    identityVersion: 4,
    from: 'EditorPage',
    to: 'EditorPage',
    g: 'click_element「不存在的按钮」',
    action: { tool: 'click_element', argsTemplate: { selector: '#gone' }, risk: 'low' },
    slots: [],
    s: { semanticAnchor: { role: 'button', name: '不存在的按钮' } },
    r: 'low',
    phiMinus: [],
    phiPlus: { kind: 'url_pattern', expr: '/editor', source: 'structured' },
    provenance: { recordIds: ['r1'], verifiedAt: Date.now(), siteKey: 'example.com', ttlMs: 0 },
    status: 'verified',
  };
  const graph = {
    version: 2,
    siteKey: 'example.com',
    updatedAt: Date.now(),
    ttlMs: 0,
    l0: { states: [], operations: [] },
    l1: { edges: [edge] },
    records: [],
    patchLog: [],
  };
  const calls = [];
  let jevCalls = 0;
  const controller = new JevFastController(
    state,
    fakePipeline(state, (call) => calls.push(call.name)),
    new AbortController().signal,
    async () => {
      jevCalls += 1;
      return {
        model: 'jev-latest',
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: { operation: { type: 'choice', choice: 'BLOCKED', confidence: 0.9 } },
      };
    },
    () => {},
    async () => graph
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'skipped');
  // 边候选被目标预过滤清空后，回退 operation 判断 BLOCKED，才交回慢思考。
  assert.equal(outcome.reason, 'model-blocked');
  // 目标缺失可能只是瞬时收起（菜单/面板），所以**不封边**：本 run 内下一 cycle
  // 目标出现时还能再挑到它。
  assert.deepEqual(state.jevLoop.blockedEdgeIds, [], '预过滤失败不封边');
  assert.equal(state.jevLoop.handoffReasons['model-blocked'], 1);
  assert.ok(!calls.includes('click_element'), 'grounding 失败不得执行任何动作：' + calls.join(','));
  // 回到回退路径后仍会问一次 operation；这不掩盖“边候选 0 也能有快路”的事实。
  assert.equal(jevCalls, 1);
});

test('子目标动作租约限制连续快动作，计划版本更新后重新开租约', async () => {
  const state = makeState(false);
  state.settings.jev.maxConsecutiveActions = 5;
  state.ctx.plan = [{
    id: 'read-page',
    text: '读取当前页面',
    status: 'in_progress',
    allowedOperations: ['READ_PAGE'],
    leaseActions: 1,
  }];
  state.ctx.planVersion = 1;
  const calls = [];
  const controller = new JevFastController(
    state,
    fakePipeline(state, (call) => calls.push(call.name)),
    new AbortController().signal,
    async (_settings, request) => {
      return responseFor(bundleFromRequest(request), 'READ_PAGE');
    }
  );

  const first = await controller.runAvailable(0, async () => {});
  assert.equal(first.kind, 'act');
  assert.equal(first.decisions.length, 1);
  assert.equal(calls.filter((name) => name === 'read_current_page').length, 1);
  assert.equal(state.jevLoop.planActions, 1);

  const exhausted = await controller.runAvailable(1, async () => {});
  assert.equal(exhausted.kind, 'skipped');
  assert.equal(exhausted.reason, 'not-due');

  state.ctx.plan = [{
    id: 'read-next-page',
    text: '读取更新后的页面',
    status: 'in_progress',
    allowedOperations: ['READ_PAGE'],
    leaseActions: 1,
  }];
  state.ctx.planVersion = 2;
  const renewed = await controller.runAvailable(2, async () => {});
  assert.equal(renewed.kind, 'act');
  assert.equal(renewed.decisions.length, 1);
  assert.equal(calls.filter((name) => name === 'read_current_page').length, 2);
});

test('连续 WAIT 不受动态 DOM 指纹影响，达到阈值后立即移交慢思考', async () => {
  const state = makeState(false);
  state.settings.jev.maxRepeatedActionsWithoutProgress = 2;
  const calls = [];
  const controller = new JevFastController(
    state,
    fakePipeline(state, (call) => calls.push(call.name)),
    new AbortController().signal,
    async (_settings, request) => {
      return responseFor(bundleFromRequest(request), 'WAIT', 0.7);
    }
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  assert.equal(outcome.decisions.length, 2, 'WAIT 连续两次后不再继续等待');
  assert.equal(calls.filter((name) => name === 'get_page_snapshot').length, 3);
  assert.equal(state.jevLoop.waitStreak, 0);
  assert.match(
    state.messages.at(-1)?.content || '',
    /wait-limit[\s\S]*连续等待 2 次/,
    '移交消息必须说明连续等待次数'
  );
});

test('READ_PAGE 低置信时使用确定性只读回退，不立即占用慢模型轮次', async () => {
  const state = makeState(false);
  const calls = [];
  const decisions = [];
  state.emit = (event) => {
    if (event.type === 'jev-decision') decisions.push(event);
  };
  let turn = 0;
  const controller = new JevFastController(
    state,
    fakePipeline(state, (call) => calls.push(call.name)),
    new AbortController().signal,
    async (_settings, request) => {
      turn += 1;
      const bundle = bundleFromRequest(request);
      return turn === 1
        ? responseFor(bundle, 'READ_PAGE', 0.4)
        : responseFor(bundle, 'BLOCKED', 0.95);
    }
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(outcome.kind, 'act');
  assert.equal(outcome.decisions[0].operation, 'READ_PAGE');
  assert.equal(calls.includes('read_current_page'), true);
  assert.equal(decisions[0].readFallback, true);
  assert.match(decisions[0].message, /只读回退/);
  assert.match(outcome.decisions[0].description, /确定性回退/);
});

test('同一计划版本和 URL 的低置信 READ_PAGE 只回退一次', async () => {
  const state = makeState(false);
  const calls = [];
  const controller = new JevFastController(
    state,
    fakePipeline(state, (call) => calls.push(call.name)),
    new AbortController().signal,
    async (_settings, request) => {
      return responseFor(bundleFromRequest(request), 'READ_PAGE', 0.4);
    }
  );
  const first = await controller.runAvailable(0, async () => {});
  assert.equal(first.kind, 'act');
  assert.equal(first.decisions.length, 1);
  assert.equal(calls.filter((name) => name === 'read_current_page').length, 1);
  assert.match(state.messages.at(-1)?.content || '', /low-confidence/);
});

test('同一 blocked 路由冷却，页面变化后允许重新尝试', async () => {
  const state = makeState(false);
  let calls = 0;
  const controller = new JevFastController(
    state,
    fakePipeline(state),
    new AbortController().signal,
    async (_settings, request) => {
      calls += 1;
      return responseFor(bundleFromRequest(request), 'BLOCKED');
    }
  );
  await controller.runAvailable(0, async () => {});
  state.toolCallCount += 1;
  const cooled = await controller.runAvailable(1, async () => {});
  assert.equal(cooled.kind, 'skipped');
  assert.equal(calls, 1);
  state.ctx.pageUrl = 'https://example.com/next';
  state.toolCallCount += 1;
  await controller.runAvailable(2, async () => {});
  assert.equal(calls, 2);
});

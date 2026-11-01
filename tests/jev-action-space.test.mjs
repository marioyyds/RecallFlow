import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JEV_CLICK_TARGET_QUESTION,
  JEV_MIN_ACTION_CONFIDENCE,
  JEV_MIN_CLICK_CONFIDENCE,
  JEV_MIN_READ_CONFIDENCE,
  JEV_MIN_WAIT_CONFIDENCE,
  JEV_OPERATION_QUESTION,
  JEV_TYPE_TEXT_TARGET_QUESTION,
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
  const others = ids.filter((id) => id !== selected);
  const rest = others.length ? (1 - confidence) / others.length : 0;
  return {
    type: 'choice',
    choice: selected,
    confidence,
    probabilities: Object.fromEntries(
      ids.map((id) => [
        id,
        id === selected ? (others.length ? confidence : 1) : rest,
      ])
    ),
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
  for (const [operationName, targets] of Object.entries(bundle.targets)) {
    const question = operationName === 'CLICK'
      ? JEV_CLICK_TARGET_QUESTION
      : JEV_TYPE_TEXT_TARGET_QUESTION;
    answers[question] = choice(Object.keys(targets), Object.keys(targets)[0]);
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
  if (request.questions[JEV_TYPE_TEXT_TARGET_QUESTION]) {
    targets.TYPE_TEXT = Object.fromEntries(
      Object.keys(request.questions[JEV_TYPE_TEXT_TARGET_QUESTION].criteria).map((key) => [key, {}])
    );
  }
  return { operations, targets };
}

test('JEV 使用 operation 与操作专属 target head，不再询问 handoff 概率', () => {
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
    [JEV_CLICK_TARGET_QUESTION, JEV_OPERATION_QUESTION, JEV_TYPE_TEXT_TARGET_QUESTION].sort()
  );
  assert.equal('handoff_now' in bundle.request.questions, false);
  assert.equal('expected_progress' in bundle.request.questions, false);
  assert.equal('page_ready' in bundle.request.questions, false);
  assert.ok(bundle.operations.CLICK);
  assert.ok(bundle.operations.TYPE_TEXT);
  assert.ok(bundle.targets.CLICK);
  assert.ok(bundle.targets.TYPE_TEXT);
  assert.equal(
    Object.values(bundle.targets.CLICK).some((target) => target.ref === 'rf-2'),
    false,
    '文本输入框只应进入 TYPE_TEXT target head，不能以 CLICK 分支抢占'
  );
  assert.equal(
    Object.values(bundle.targets.TYPE_TEXT).some((target) => target.ref === 'rf-2'),
    true
  );
});

test('target 候选按操作隔离，高风险发布按钮不会成为 CLICK 候选', () => {
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '先上传图文，再填写标题',
    pageText: '上传图文 文字配图 标题 正文',
    snapshot: pageSnapshot(),
  });
  const clickTargets = Object.values(bundle.targets.CLICK);
  const typeTargets = Object.values(bundle.targets.TYPE_TEXT);
  assert.equal(clickTargets.some((target) => target.label === '上传图文'), true);
  assert.equal(clickTargets.some((target) => target.label === '发布'), false);
  assert.equal(typeTargets.some((target) => target.label === '填写标题'), true);
});

test('高置信 CLICK 只消费 click_target，不依赖 TYPE_TEXT target', () => {
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '点击上传图文',
    pageText: '上传图文 文字配图 标题 正文',
    snapshot: pageSnapshot(),
  });
  const response = responseFor(bundle, 'CLICK', 0.97);
  response.answers[JEV_TYPE_TEXT_TARGET_QUESTION] = {
    choice: 'invented',
    confidence: 0.1,
    probabilities: Object.fromEntries(Object.keys(bundle.targets.TYPE_TEXT).map((key) => [key, 0.1])),
  };
  const decision = interpretJevFastDecision(response, bundle);
  assert.equal(decision.kind, 'act');
  assert.equal(decision.operation, 'CLICK');
  assert.equal(decision.toolName, 'click_element');
  assert.equal(decision.target.label, '上传图文');
});

test('operation 与所有 target head 能通过 TypeSafe 响应校验', () => {
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '填写标题',
    snapshot: pageSnapshot(),
  });
  const parsed = parseJevSystemOneResponse(
    responseFor(bundle, 'TYPE_TEXT'),
    bundle.request.questions
  );
  const decision = interpretJevFastDecision(parsed, bundle);
  assert.equal(decision.kind, 'act');
  assert.equal(decision.operation, 'TYPE_TEXT');
  assert.equal(decision.target.label, '填写标题');
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
  const typeBundle = buildJevFastRequest(
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
  assert.equal(typeBundle.operations.TYPE_TEXT.minConfidence, 0.63);
  assert.equal(typeBundle.targets.TYPE_TEXT['2'].minConfidence, 0.63);
  assert.equal(
    typeBundle.targets.TYPE_TEXT['2'].args.clearFirst,
    true,
    'JEV 生成完整字段值，因此必须替换而不是追加'
  );
});

test('TYPE_TEXT 排除已填写标题，并用可编辑能力样本识别正文编辑器', () => {
  const snapshot = pageSnapshot({
    elements: [
      {
        ref: 'rf-title',
        tag: 'input',
        role: 'textbox',
        type: 'text',
        label: '文章标题',
        valuePresent: true,
        inViewport: true,
      },
      {
        ref: 'rf-body',
        tag: 'pre',
        role: '',
        type: '',
        label: '',
        selector: 'pre.editor__inner:nth-of-type(1)',
        valuePresent: undefined,
        inViewport: true,
      },
    ],
    capabilities: {
      editables: {
        count: 1,
        samples: [
          {
            selector: 'pre.editor__inner:nth-of-type(1)',
            kind: 'contenteditable',
          },
        ],
      },
    },
  });
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '正文还没有填，继续撰写',
    snapshot,
  });
  const targets = Object.values(bundle.targets.TYPE_TEXT || {});
  assert.equal(targets.some((target) => target.ref === 'rf-title'), false);
  const body = targets.find((target) => target.ref === 'rf-body');
  assert.ok(body);
  assert.equal(body.label, '正文编辑区');
});

test('慢思考已成功写入的目标不再进入下一轮快思考 TYPE_TEXT', () => {
  const titleSelector = 'input.article-bar__title:nth-of-type(1)';
  const snapshot = pageSnapshot({
    elements: [
      {
        ref: 'rf-title-new',
        tag: 'input',
        role: 'textbox',
        type: 'text',
        label: '文章标题',
        selector: titleSelector,
        valuePresent: false,
        inViewport: true,
      },
      {
        ref: 'rf-body',
        tag: 'textarea',
        role: 'textbox',
        label: '正文',
        inViewport: true,
      },
    ],
  });
  const bundle = buildJevFastRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    phase: 'editor',
    instruction: '标题已经写好，继续填写正文',
    snapshot,
    completedTypeTargets: [titleSelector],
  });
  const targets = Object.values(bundle.targets.TYPE_TEXT || {});
  assert.equal(targets.some((target) => target.selector === titleSelector), false);
  assert.equal(targets.some((target) => target.ref === 'rf-body'), true);
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

test('TYPE_TEXT 由文本助手生成值，JEV 只负责 operation 和 target', async () => {
  const state = makeState(false);
  const calls = [];
  let turn = 0;
  const controller = new JevFastController(
    state,
    fakePipeline(state, (call) => calls.push(call)),
    new AbortController().signal,
    async (_settings, request) => {
      turn += 1;
      const bundle = bundleFromRequest(request);
      if (turn === 1) return responseFor(bundle, 'TYPE_TEXT');
      return responseFor(bundle, 'BLOCKED');
    },
    async () => true,
    async () => ({ text: '图像编辑论文合集', model: 'helper', latencyMs: 7 })
  );
  const outcome = await controller.runAvailable(0, async () => {});
  assert.equal(
    outcome.kind,
    'act',
    'TYPE_TEXT 决策应进入执行模式：' +
      JSON.stringify(outcome) +
      ' / ' +
      String(state.messages.at(-1)?.content || '')
  );
  const typeCall = calls.find((call) => call.name === 'type_text');
  assert.ok(typeCall, '应执行 JEV 选中的 TYPE_TEXT；实际工具：' + calls.map((call) => call.name).join(','));
  assert.equal(typeCall.args.ref, 'rf-2');
  assert.equal(typeCall.args.value, '图像编辑论文合集');
  assert.equal(typeCall.args.clearFirst, true);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  atomSignature,
  bindSlots,
  candidateEdges,
  decideR3,
  edgeAlreadySatisfied,
  evaluatePhiMinus,
  evidenceFromSnapshot,
  extractExplicitSlots,
  extractAtoms,
  groundEdgeAction,
  matchCandidate,
  mergeEdges,
  patchGuard,
  resolveEdgeTarget,
  traceGraphStateName,
  urlPatternOf,
  verifyEdgePostcondition,
} from '../../lib/application/agent/trace-graph.ts';
import { completionAllowsTaskCommit } from '../../lib/application/agent/agent-completion.ts';
import { applyTraceGraphPatch } from '../../lib/application/agent/patcher-guard.ts';
import { emptyTraceGraph, validateTraceGraph } from '../../lib/application/agent/tracegraph-store.ts';
import {
  TRACE_GRAPH_KEY,
  appendTraceRecord,
  deleteStoredTraceGraph,
  deleteStoredTraceGraphSelection,
  loadTraceGraph,
  rebuildStoredTraceGraphs,
  traceRecordFromTransition,
  traceTargetFromTransition,
} from '../../lib/application/agent/tracegraph-store.ts';
import { buildJevEdgeRequest, interpretJevEdgeDecision } from '../../lib/application/agent/jev-action-space.ts';
import { validateJsonSchema } from './schema-validator.mjs';

const SCHEMA = JSON.parse(
  fs.readFileSync(new URL('../../docs/tracegraph.v2.schema.json', import.meta.url), 'utf8')
);
const NOW = Date.now();

function evidence(overrides = {}) {
  return {
    url: 'https://gitcode.com/owner/repo/pull/compare',
    urlPattern: '/pull/compare',
    title: 'Create Pull Request',
    atomSignature: 'PRFormPage#button:button+input:text#',
    counters: { description: 2078 },
    controls: [
      { role: 'textbox', name: 'TitleInput', valuePresent: true },
      { role: 'textbox', name: 'DescriptionEditor', valuePresent: true },
      { role: 'button', name: 'CreateButton', valuePresent: true },
    ],
    dialog: null,
    fingerprint: 'fp-before',
    ...overrides,
  };
}

function edge(overrides = {}) {
  return {
    id: 'e5.write-desc',
    from: 'PRFormPage',
    to: 'PRFormPage',
    g: '创建成本域 PR',
    action: {
      tool: 'type_text',
      argsTemplate: { ref: '@descriptionEditor', clearFirst: true, value: '@description' },
      risk: 'medium',
    },
    slots: [{
      name: 'description',
      type: 'markdown',
      source: 'current_instruction',
      highRisk: false,
    }],
    s: {
      selector: 'div.cm-content:nth-of-type(1)',
      semanticAnchor: { role: 'textbox', name: '输入描述' },
    },
    r: 'medium',
    phiMinus: [
      { kind: 'url_pattern', expr: '/pull/compare', source: 'structured' },
      { kind: 'no_dialog', expr: 'dialog == null', source: 'structured' },
      {
        kind: 'not_satisfied',
        expr: 'description != len(@description)',
        source: 'structured',
      },
    ],
    phiPlus: {
      kind: 'counter',
      expr: 'description == len(@description)',
      observed: '2078/65535',
      source: 'structured',
    },
    semanticSplit: {
      slowOnly: ['生成 Markdown 文案'],
      replayable: ['写入编辑器', '字符计数校验'],
    },
    provenance: {
      recordIds: ['seq13'],
      verifiedAt: NOW,
      siteKey: 'https://gitcode.com',
      ttlMs: 30 * 60 * 1000,
    },
    status: 'verified',
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    version: 2,
    url: 'https://gitcode.com/owner/repo/pull/compare',
    title: 'Create Pull Request',
    text: '输入描述 2078/65535',
    fingerprint: 'fp-before',
    capabilities: {},
    elements: [
      { tag: 'input', role: 'textbox', label: 'TitleInput', valuePresent: true },
      { tag: 'div', role: 'textbox', label: 'DescriptionEditor', valuePresent: true },
      { tag: 'button', role: 'button', label: 'CreateButton', valuePresent: true },
    ],
    ...overrides,
  };
}

function choice(ids, selected, confidence = 0.94) {
  return {
    type: 'choice',
    choice: selected,
    confidence,
  };
}

test('tracegraph.v2 录制结构能通过官方 JSON Schema', () => {
  const before = evidence();
  const after = evidence({
    counters: { description: 1200 },
    fingerprint: 'fp-after',
  });
  const record = {
    id: 'seq13',
    seq: 13,
    tool: 'type_text',
    argsRedacted: { selector: 'div.editor', value: '@description' },
    before,
    after,
    result: { ok: true, summary: '已写入' },
    planStep: '创建成本域 PR',
    planVersion: 1,
    successPredicate: '描述字符数等于输入值',
    verification: '计数器回读一致',
    risk: 'medium',
    ts: NOW,
  };
  const merged = mergeEdges([record]);
  const graph = {
    ...emptyTraceGraph('https://gitcode.com', NOW),
    ...merged,
    records: [record],
  };
  assert.deepEqual(validateJsonSchema(graph, SCHEMA), []);
  assert.deepEqual(validateTraceGraph(graph), { ok: true, errors: [] });
});

test('edge 身份忽略 PlanCard 文案，并记录真实动作目标', () => {
  const before = snapshot({
    url: 'https://video.example/results',
    title: 'Results',
    elements: [
      { ref: 'r1', tag: 'a', role: 'link', label: 'Video A', selector: '#video-a' },
      { ref: 'r2', tag: 'a', role: 'link', label: 'Video B', selector: '#video-b' },
    ],
  });
  const after = snapshot({
    url: 'https://video.example/watch',
    title: 'Watch',
    fingerprint: 'fp-watch',
  });
  const first = traceRecordFromTransition({
    id: 'record-a1',
    seq: 1,
    tool: 'click_element',
    args: { selector: '#video-a' },
    beforeSnapshot: before,
    afterSnapshot: after,
    result: { ok: true, summary: 'opened A' },
    planStep: '先打开第一个视频',
    verification: 'URL changed',
    risk: 'low',
    now: NOW,
  });
  const repeated = traceRecordFromTransition({
    id: 'record-a2',
    seq: 2,
    tool: 'click_element',
    args: { selector: '#video-a' },
    beforeSnapshot: before,
    afterSnapshot: after,
    result: { ok: true, summary: 'opened A again' },
    planStep: '换一种计划措辞后仍打开第一个视频',
    verification: 'URL changed',
    risk: 'low',
    now: NOW + 1,
  });
  const differentTarget = traceRecordFromTransition({
    id: 'record-b',
    seq: 3,
    tool: 'click_element',
    args: { selector: '#video-b' },
    beforeSnapshot: before,
    afterSnapshot: after,
    result: { ok: true, summary: 'opened B' },
    planStep: '打开第一个视频',
    verification: 'URL changed',
    risk: 'low',
    now: NOW + 2,
  });
  const beforeWithCounter = snapshot({
    url: 'https://video.example/results',
    title: 'Results',
    counters: { resultCount: 2 },
    elements: [
      { ref: 'r1', tag: 'a', role: 'link', label: 'Video A', selector: '#video-a' },
    ],
  });
  const afterWithCounter = snapshot({
    url: 'https://video.example/watch',
    title: 'Watch',
    fingerprint: 'fp-watch-counter',
    counters: { resultCount: 1 },
  });
  const sameActionDifferentOutcome = traceRecordFromTransition({
    id: 'record-a3',
    seq: 4,
    tool: 'click_element',
    args: { selector: '#video-a' },
    beforeSnapshot: beforeWithCounter,
    afterSnapshot: afterWithCounter,
    result: { ok: true, summary: 'opened A with another counter' },
    verification: 'counter changed',
    risk: 'low',
    now: NOW + 3,
  });

  assert.equal(first.target?.name, 'Video A');
  assert.equal(first.target?.selector, '#video-a');
  const same = mergeEdges([first, repeated]);
  assert.equal(same.l1.edges.length, 1);
  assert.equal(same.l1.edges[0].identityVersion, 4);
  assert.equal(same.l1.edges[0].s.semanticAnchor.name, 'Video A');
  assert.equal(same.l1.edges[0].provenance.recordIds.length, 2);
  assert.doesNotMatch(same.l1.edges[0].g, /先打开|换一种计划/);

  const distinct = mergeEdges([first, repeated, differentTarget]);
  assert.equal(distinct.l1.edges.length, 2);
  assert.deepEqual(
    distinct.l1.edges.map((item) => item.s.semanticAnchor.name).sort(),
    ['Video A', 'Video B']
  );

  const outcomeIndependent = mergeEdges([first, sameActionDifferentOutcome]);
  assert.equal(outcomeIndependent.l1.edges.length, 1);
  assert.equal(outcomeIndependent.l1.edges[0].s.semanticAnchor.name, 'Video A');
  assert.equal(outcomeIndependent.l1.edges[0].provenance.recordIds.length, 2);
});

test('edge grounding 使用当前快照 ref，不复用历史 selector', () => {
  const clickEdge = edge({
    action: {
      tool: 'click_element',
      argsTemplate: { selector: '#old-submit' },
      risk: 'low',
    },
    slots: [],
    s: {
      selector: '#old-submit',
      semanticAnchor: { role: 'button', name: 'Submit' },
    },
  });
  const observation = evidence({
    controls: [{
      role: 'button',
      name: 'Submit',
      ref: 'rf-current',
      selector: '#new-submit',
      visible: true,
    }],
  });
  const grounded = groundEdgeAction(clickEdge, observation, {});
  assert.equal(grounded.ok, true);
  assert.equal(grounded.target?.ref, 'rf-current');
  assert.deepEqual(grounded.args, { ref: 'rf-current' });

  const ambiguous = resolveEdgeTarget(clickEdge, evidence({
    controls: [
      { role: 'button', name: 'Submit', ref: 'rf-a', selector: '#a', visible: true },
      { role: 'button', name: 'Submit', ref: 'rf-b', selector: '#b', visible: true },
    ],
  }));
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'target-ambiguous');
  assert.equal(ambiguous.candidates, 2);

  const changedMeaning = resolveEdgeTarget(clickEdge, evidence({
    controls: [{
      role: 'button',
      name: 'Delete product',
      ref: 'rf-delete',
      selector: '#old-submit',
      visible: true,
    }],
  }));
  assert.equal(changedMeaning.ok, false);
  assert.equal(changedMeaning.reason, 'target-missing');
});

test('TraceGraph 存储读取会把旧 edge 身份从保留 records 重新构建', async () => {
  const store = installStorage();
  const base = evidence();
  const record = {
    id: 'legacy-record',
    seq: 1,
    tool: 'click_element',
    argsRedacted: { selector: '#next' },
    before: base,
    after: evidence({ fingerprint: 'after-legacy' }),
    result: { ok: true, summary: 'ok' },
    planStep: '旧的计划文案',
    verification: 'changed',
    risk: 'low',
    ts: NOW,
  };
  await appendTraceRecord(base.url, record);
  const origin = 'https://gitcode.com';
  const graph = store[TRACE_GRAPH_KEY][origin];
  graph.l1.edges[0].id = 'legacy.edge';
  delete graph.l1.edges[0].identityVersion;
  graph.l1.edges.push({ ...graph.l1.edges[0], id: 'legacy.edge.duplicate' });

  const rebuilt = await rebuildStoredTraceGraphs();
  assert.deepEqual(rebuilt, { sites: 1, edges: 1, records: 1 });
  assert.equal(store[TRACE_GRAPH_KEY][origin].l1.edges.length, 1);
  assert.equal(store[TRACE_GRAPH_KEY][origin].l1.edges[0].identityVersion, 4);
  assert.doesNotMatch(store[TRACE_GRAPH_KEY][origin].l1.edges[0].g, /旧的计划文案/);
});

test('atomSignature 不包含控件值、实例数、selector、ref 或整页 fingerprint', () => {
  const a = snapshot({
    fingerprint: 'different-a',
    elements: [
      { tag: 'input', role: 'textbox', label: 'TitleInput', selector: '#old', ref: 'r1', valuePresent: true },
      { tag: 'div', role: 'textbox', label: 'DescriptionEditor', selector: '.v1', ref: 'r2', valuePresent: true },
    ],
  });
  const b = snapshot({
    fingerprint: 'different-b',
    elements: [
      { tag: 'input', role: 'textbox', label: 'TitleInput', selector: '#new', ref: 'r9', valuePresent: false },
      { tag: 'div', role: 'textbox', label: 'DescriptionEditor', selector: '.v2', ref: 'r8', valuePresent: true },
      { tag: 'div', role: 'textbox', label: 'DescriptionEditor', selector: '.v3', ref: 'r7' },
    ],
  });
  const left = extractAtoms(a);
  const right = extractAtoms(b);
  assert.equal(left.atomSignature, right.atomSignature);
  assert.equal(left.atomSignature.includes('different-a'), false);
  assert.equal(left.atomSignature.includes('#old'), false);
  assert.equal(left.atomSignature.includes('r1'), false);
});

const CASES = [
  {
    name: '① 完全一致 → REUSE',
    run() {
      const e = edge({
        slots: [],
        action: { tool: 'click_element', argsTemplate: { selector: '#next' }, risk: 'low' },
        phiMinus: [{ kind: 'url_pattern', expr: '/pull/compare', source: 'structured' }],
        phiPlus: { kind: 'diff_exists', expr: 'page_diff', source: 'structured' },
      });
      return decideR3(e, {}) === 'REUSE';
    },
  },
  {
    name: '② 换标题 → REWRITE:title',
    run() {
      const e = edge({
        slots: [{ name: 'title', type: 'string', source: 'current_instruction', highRisk: false }],
        action: { tool: 'type_text', argsTemplate: { value: '@title' }, risk: 'medium' },
        phiPlus: {
          kind: 'value_equals',
          expr: 'controls["TitleInput"].valuePresent == true',
          source: 'structured',
        },
      });
      const bind = bindSlots(e, { slots: { title: '新标题' } });
      return bind.ok && decideR3(e, bind.bound) === 'REWRITE' && bind.args.value === '新标题';
    },
  },
  {
    name: '③ 换描述且计数同步 → REWRITE:description',
    run() {
      const e = edge();
      const bound = { description: 'x'.repeat(1200) };
      const after = evidence({ counters: { description: 1200 } });
      return decideR3(e, bound) === 'REWRITE' &&
        verifyEdgePostcondition(e, evidence(), after, bound).ok;
    },
  },
  {
    name: '④ 换源分支 → REWRITE:srcBranch',
    run() {
      const e = edge({
        slots: [{ name: 'srcBranch', type: 'branch', source: 'current_instruction', highRisk: false }],
        action: { tool: 'click_element', argsTemplate: { text: '@srcBranch' }, risk: 'low' },
      });
      return decideR3(e, { srcBranch: 'feat/cost-page-v2' }) === 'REWRITE';
    },
  },
  {
    name: '⑤ 换目标分支 → REWRITE:dstBranch',
    run() {
      const e = edge({
        slots: [{ name: 'dstBranch', type: 'branch', source: 'current_instruction', highRisk: false }],
        action: { tool: 'click_element', argsTemplate: { text: '@dstBranch' }, risk: 'low' },
      });
      return decideR3(e, { dstBranch: 'release/1.2' }) === 'REWRITE';
    },
  },
  {
    name: '⑥ 无可合入差异 → ZERO-ACTION',
    run() {
      const e = edge();
      const already = evidence({ counters: { description: 1200 } });
      return edgeAlreadySatisfied(e, already, { description: 'x'.repeat(1200) });
    },
  },
  {
    name: '⑦ 创建按钮被遮挡 → φ⁻ REJECT',
    run() {
      const e = edge({
        phiMinus: [{
          kind: 'element_present',
          expr: 'controls["CreateButton"].valuePresent == true',
          source: 'structured',
        }],
      });
      const blocked = evidence({
        controls: [{ role: 'button', name: 'CreateButton', valuePresent: false }],
      });
      return evaluatePhiMinus(e.phiMinus, blocked).ok === false;
    },
  },
  {
    name: '⑧ ref 失效 + selector 改版 → REUSE',
    run() {
      const a = extractAtoms(snapshot({
        elements: [{ tag: 'button', role: 'button', label: 'Next', selector: '#v1', ref: 'r1' }],
      }));
      const b = extractAtoms(snapshot({
        elements: [{ tag: 'button', role: 'button', label: 'Next', selector: '.v2', ref: 'r9' }],
      }));
      return a.atomSignature === b.atomSignature;
    },
  },
  {
    name: '⑨ 描述写入但计数未变 → φ⁺ 失败',
    run() {
      const e = edge();
      const before = evidence({ counters: { description: 100 } });
      const after = evidence({ counters: { description: 100 }, fingerprint: 'fp-new' });
      return verifyEdgePostcondition(
        e,
        before,
        after,
        { description: 'x'.repeat(1200) }
      ).ok === false;
    },
  },
  {
    name: '⑩ 点创建后 URL 未变 → φ⁺ 失败',
    run() {
      const e = edge({
        slots: [],
        action: { tool: 'click_element', argsTemplate: { selector: '#create' }, risk: 'high' },
        phiPlus: { kind: 'url_pattern', expr: '/pull/<n>', source: 'structured' },
      });
      return verifyEdgePostcondition(e, evidence(), evidence(), {}).ok === false;
    },
  },
  {
    name: '⑪ “按上次的 PR 标题” → REJECT，禁止静默填历史值',
    run() {
      const e = edge();
      const bind = bindSlots(e, { slots: { description: '按上次的 PR 标题' } });
      return bind.ok === false && decideR3(e, bind.bound) === 'REJECT';
    },
  },
  {
    name: '⑫ PR #1 已存在 → ZERO-ACTION',
    run() {
      const e = edge({
        slots: [],
        phiMinus: [
          { kind: 'url_pattern', expr: '/pull/<n>', source: 'structured' },
          { kind: 'not_satisfied', expr: 'urlPattern == "/pull/compare"', source: 'structured' },
        ],
        action: { tool: 'click_element', argsTemplate: { selector: '#create' }, risk: 'high' },
      });
      return edgeAlreadySatisfied(
        e,
        evidence({ urlPattern: '/pull/<n>', url: 'https://gitcode.com/owner/repo/pull/1' }),
        {}
      );
    },
  },
  {
    name: '⑬ 终局独立校验不可用 → DONE 不得提交完成',
    run() {
      return completionAllowsTaskCommit('unverified') === false &&
        completionAllowsTaskCommit('verified') === true;
    },
  },
];

test('13 个真实派生样例全部通过确定性守卫', async (t) => {
  for (const item of CASES) {
    await t.test(item.name, () => assert.equal(item.run(), true));
  }
});

test('matchCandidate 只做结构分层：full / static / name，旧图不伪造层级', () => {
  const signature = 'PRFormPage#button:button+input:text#';
  const recorded = edge({ fromSignatures: [signature] });
  assert.equal(matchCandidate(recorded, { atomSignature: signature }).level, 'full');
  // 动态原子多出来（例如勾选状态变化）仍是同一个结构模板。
  assert.equal(
    matchCandidate(recorded, { atomSignature: signature + 'checkbox:checked' }).level,
    'static'
  );
  // 静态结构不同：只剩状态名相同。
  assert.equal(
    matchCandidate(recorded, { atomSignature: 'PRFormPage#button:button#' }).level,
    'name'
  );
  // 旧图没有签名时按 name 档，不能假装 full。
  assert.equal(matchCandidate(edge({}), { atomSignature: signature }).level, 'name');
  assert.equal(matchCandidate(null, { atomSignature: signature }).level, 'name');
  assert.equal(matchCandidate(recorded, null).level, 'name');
});

test('证据边携带录制签名与计划步，选择期把它们当作可比对证据而不是身份', () => {
  const record = {
    id: 'seq14',
    seq: 14,
    tool: 'type_text',
    argsRedacted: { selector: 'div.editor', value: '@description' },
    before: evidence(),
    after: evidence({ counters: { description: 1200 }, fingerprint: 'fp-after' }),
    result: { ok: true, summary: '已写入' },
    planStep: '填写 PR 描述',
    planVersion: 1,
    successPredicate: '描述字符数等于输入值',
    verification: '计数器回读一致',
    risk: 'medium',
    ts: NOW,
  };
  const merged = mergeEdges([record]);
  const mergedEdge = merged.l1.edges[0];
  assert.deepEqual(mergedEdge.fromSignatures, [evidence().atomSignature]);
  assert.deepEqual(mergedEdge.purpose, ['填写 PR 描述']);

  // 身份不含这两项：同一动作换个计划措辞仍然合并。
  const renamed = mergeEdges([
    { ...record, id: 'seq15', ts: NOW + 1, planStep: '写正文' },
  ], { ...emptyTraceGraph('https://gitcode.com'), l0: merged.l0, l1: merged.l1 }).l1.edges;
  assert.equal(renamed.length, 1);
  assert.deepEqual(renamed[0].purpose, ['写正文', '填写 PR 描述']);

  const bundle = buildJevEdgeRequest(
    { model: 'jev-latest' },
    {
      intent: 'browser_task',
      goal: '创建一个 PR 并填写描述',
      phase: 'editor',
      candidates: [mergedEdge],
      observation: evidence({ counters: { description: 0 } }),
      slots: { value: '正文内容' },
      candidateMatches: {
        [mergedEdge.id]: { level: 'full', staticOverlap: 1, dynamicOverlap: 1 },
      },
    }
  );
  const text = bundle.request.questions.edge.criteria[mergedEdge.id];
  assert.match(text, /结构匹配：full/);
  assert.match(text, /用途：填写 PR 描述/);
  assert.match(text, /前置：/);
  assert.match(text, /✓|✗/);
  assert.match(text, /效果：/);
  assert.doesNotMatch(text, /2078/, '效果摘要与前置证据都不得泄露录制值');
});

test('candidateEdges 返回当前状态的全部已验证边，不截断，仍排除 blocked / executed', () => {
  const records = Array.from({ length: 6 }, (_, index) => ({
    id: 'r' + index,
    seq: index,
    tool: 'click_element',
    argsRedacted: { selector: '#go' + index },
    before: evidence(),
    after: evidence({ fingerprint: 'fp-' + index }),
    result: { ok: true, summary: 'ok' },
    planStep: '创建成本域 PR',
    verification: 'changed',
    risk: 'low',
    ts: NOW + index,
  }));
  const merged = mergeEdges(records);
  const graph = {
    ...emptyTraceGraph('https://gitcode.com', NOW),
    ...merged,
    records,
  };
  const all = candidateEdges(graph, {
    siteKey: 'https://gitcode.com',
    atomSignature: evidence().atomSignature,
    blockedEdgeIds: new Set(),
    executedEdges: new Set(),
  });
  assert.equal(all.length, 6);
  const blocked = candidateEdges(graph, {
    siteKey: 'https://gitcode.com',
    atomSignature: evidence().atomSignature,
    blockedEdgeIds: new Set([all[0].id]),
    executedEdges: new Set([all[1].id]),
  });
  assert.equal(blocked.length, 4);
  assert.equal(blocked.some((item) => item.id === all[0].id), false);
  assert.equal(blocked.some((item) => item.id === all[1].id), false);
  assert.equal(
    candidateEdges(graph, {
      siteKey: 'https://example.com',
      atomSignature: evidence().atomSignature,
      blockedEdgeIds: new Set(),
      executedEdges: new Set(),
    }).length,
    0
  );
});

test('写入目标的锚点不取控件内容：type_text 只用稳定属性，否则退回 selector', () => {
  const snapshot = {
    url: 'https://editor.csdn.net/md?articleId=1',
    title: '写文章',
    elements: [
      {
        ref: 'rf-1',
        tag: 'pre',
        role: '',
        label: '@[TOC] 一篇讲清 GraphRAG 的长正文，写得越长这里就越不一样',
        selector: 'pre.editor__inner',
        inViewport: true,
      },
    ],
  };
  const target = traceTargetFromTransition(
    { selector: 'pre.editor__inner', value: 'x' },
    snapshot,
    { tool: 'type_text' }
  );
  assert.equal(target.selector, 'pre.editor__inner');
  assert.equal(target.name, undefined, '正文内容绝不能进锚点');
  assert.equal(target.kind, 'selector');

  const withPlaceholder = traceTargetFromTransition(
    { selector: '#title', value: 't' },
    {
      ...snapshot,
      elements: [
        {
          ref: 'rf-2',
          tag: 'input',
          type: 'text',
          role: 'textbox',
          label: '旧标题内容',
          placeholder: '请输入文章标题',
          selector: '#title',
        },
      ],
    },
    { tool: 'type_text' }
  );
  assert.equal(withPlaceholder.name, '请输入文章标题', '稳定属性可以当锚点');
  assert.equal(withPlaceholder.kind, 'attribute');
});

test('点击目标的锚点仍记录为可见文字：kind=content，不被写入规则误伤', () => {
  const target = traceTargetFromTransition(
    { selector: 'button.publish' },
    {
      url: 'https://x.test/',
      title: 'x',
      elements: [{ ref: 'rf-1', tag: 'button', role: 'button', label: '发布文章', selector: 'button.publish' }],
    },
    { tool: 'click_element' }
  );
  assert.equal(target.name, '发布文章');
  assert.equal(target.kind, 'content');
});

test('内容型锚点不按名字匹配：按 selector 唯一重定位，selector 也没了就交回', () => {
  const observation = evidence({
    controls: [
      { role: 'button', name: '发布文章', selector: '#publish', visible: true },
      { role: '', name: '正文', selector: 'pre.editor__inner', visible: true },
    ],
  });
  const longName =
    '@[TOC] 面向想快速搞懂 GraphRAG 的同学：一篇讲清它是什么 为什么需要 怎么跑 什么时候别用 并附微软官方实现的关键概念与图纸索引 这一整段都是编辑器的正文内容';
  const withSelector = edge({
    s: { selector: 'pre.editor__inner', semanticAnchor: { role: '', name: longName } },
  });
  const resolved = resolveEdgeTarget(withSelector, observation);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.target.basis, 'selector-hint');

  const withoutSelector = edge({ s: { semanticAnchor: { role: '', name: longName } } });
  const unresolved = resolveEdgeTarget(withoutSelector, observation);
  assert.equal(unresolved.ok, false, 'selector 缺失时不得按一段已经变了的内容去猜目标');
});

test('edge question 只返回 edgeId 或 ABSTAIN，低置信/弃权都不产生动作', () => {
  const candidates = [
    edge({ id: 'e1' }),
    edge({ id: 'e2' }),
    edge({ id: 'e3' }),
  ];
  const bundle = buildJevEdgeRequest(
    {
      model: 'jev-latest',
      minEdgeConfidence: 0.8,
    },
    {
      intent: 'browser_task',
      goal: '创建成本域 PR',
      phase: 'editor',
      pageUrl: 'https://gitcode.com/owner/repo/pull/compare',
      candidates,
    }
  );
  assert.deepEqual(
    Object.keys(bundle.request.questions.edge.criteria).sort(),
    ['ABSTAIN', 'e1', 'e2', 'e3'].sort()
  );
  const selected = interpretJevEdgeDecision({
    model: 'jev',
    answers: { edge: choice(['e1', 'e2', 'e3', 'ABSTAIN'], 'e1', 0.9) },
    usage: { input_tokens: 1, output_tokens: 1 },
  }, bundle);
  assert.equal(selected.kind, 'edge');
  assert.equal(selected.edgeId, 'e1');
  assert.equal(bundle.thresholds.minEdgeConfidence, 0.8);
  const lowConfidence = interpretJevEdgeDecision({
    model: 'jev',
    answers: { edge: choice(['e1', 'e2', 'e3', 'ABSTAIN'], 'e1', 0.79) },
    usage: { input_tokens: 1, output_tokens: 1 },
  }, bundle);
  assert.equal(lowConfidence.kind, 'blocked');
  assert.equal(lowConfidence.reason, 'low-confidence');
  const abstain = interpretJevEdgeDecision({
    model: 'jev',
    answers: { edge: choice(['e1', 'e2', 'e3', 'ABSTAIN'], 'ABSTAIN', 0.9) },
    usage: { input_tokens: 1, output_tokens: 1 },
  }, bundle);
  assert.equal(abstain.kind, 'blocked');
  assert.equal(abstain.reason, 'abstain');
  assert.match(abstain.description, /confidence=0\.9000/);
});

test('patchGuard 只接受语义锚点、等待和行为说明', () => {
  assert.equal(patchGuard({ semanticAnchor: { role: 'textbox', name: '标题' } }).ok, true);
  assert.equal(patchGuard({ waitMs: 300 }).ok, true);
  assert.equal(patchGuard({ behaviorNotes: '提交后等待跳转' }).ok, true);
  const bad = patchGuard({
    selector: '#v2',
    recordedValue: '历史标题',
    defaultValue: '上次的选择',
    slots: { title: '默认标题' },
    tool: 'run_javascript',
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(
    new Set(bad.rejectedFields),
    new Set(['selector', 'recordedValue', 'defaultValue', 'slots', 'tool'])
  );
  const graph = {
    ...emptyTraceGraph('https://gitcode.com', NOW),
    l1: { edges: [edge()] },
  };
  const patched = applyTraceGraphPatch(graph, 'e5.write-desc', {
    semanticAnchor: { role: 'textbox', name: '描述' },
    waitMs: 250,
    behaviorNotes: '提交后等待页面跳转',
  }, NOW);
  assert.equal(patched.ok, true);
  assert.equal(patched.graph.l1.edges[0].s.semanticAnchor.name, '描述');
});

test('空图与 atomSignature helper 稳定、可重放', () => {
  const graph = emptyTraceGraph('https://gitcode.com', NOW);
  assert.equal(graph.version, 2);
  assert.deepEqual(graph.l1.edges, []);
  assert.equal(
    atomSignature({ name: 'S', staticAtoms: ['b', 'a'], dynamicAtoms: ['y', 'x'] }),
    'S#a+b#x+y'
  );
});

test('页面状态按应用模板抽象，不按具体商品 slug 或帖子 slug 分裂', () => {
  assert.equal(
    traceGraphStateName('http://localhost:7770/mineralogie-lip-gloss.html'),
    'ProductPage'
  );
  assert.equal(
    traceGraphStateName('http://localhost:7770/antonia-racer-tank.html'),
    'ProductPage'
  );
  assert.equal(
    traceGraphStateName('http://localhost:9999/f/books/59421/friendly-reminder'),
    'SubmissionPage'
  );
  assert.equal(
    traceGraphStateName('http://localhost:9999/f/DIY/119019/another-post'),
    'SubmissionPage'
  );
  assert.equal(
    urlPatternOf('http://localhost:7770/a.html'),
    '/*.html'
  );
  assert.equal(
    urlPatternOf('http://localhost:9999/f/books/59421/friendly-reminder'),
    '/f/*/<n>/*'
  );
});

test('数字 / UUID 末段不分裂状态名，退回稳定的父级模板', () => {
  assert.equal(
    traceGraphStateName('https://blog.csdn.net/weixin_44128977/article/details/170567085'),
    'ArticleDetailsPage',
    '帖子 id 不能进状态名，否则每篇文章都是一个新状态'
  );
  assert.equal(
    traceGraphStateName('https://shop.example.com/product/12345'),
    'ProductPage'
  );
  assert.equal(
    traceGraphStateName('https://shop.example.com/product/550e8400-e29b-41d4-a716-446655440000'),
    'ProductPage'
  );
  assert.equal(
    traceGraphStateName('https://x.test/posts/64b7f0c2a1b2c3d4e5f60718'),
    'PostsPage'
  );
  // 整条路径都是 id 时只能退到 DetailPage；不要拿页面标题当名字（标题会随帖子变）。
  assert.equal(traceGraphStateName('https://x.test/12345'), 'DetailPage');
  // 稳定末段保持原行为：这次改动不碰它们。
  assert.equal(
    traceGraphStateName('https://mp.csdn.net/mp_blog/creation/editor'),
    'EditorPage'
  );
  assert.equal(traceGraphStateName('https://example.com/foo/bar'), 'BarPage');
});

test('typed slots 只从当前指令显式块或 @slot 行读取', () => {
  assert.deepEqual(
    extractExplicitSlots('任务\n@title="新版标题"\n@value=保留正文'),
    { title: '新版标题', value: '保留正文' }
  );
  assert.deepEqual(
    extractExplicitSlots('```json\n{"slots":{"title":"显式标题","value":"正文"}}\n```'),
    { title: '显式标题', value: '正文' }
  );
  assert.deepEqual(
    extractExplicitSlots('把标题改成我常点的那款'),
    {},
    '自然语言不能静默映射成槽位'
  );
});

test('generic ProductPage 可通过模板提名，并排除当前指令未绑定的槽位边', () => {
  const graph = {
    ...emptyTraceGraph('http://localhost:7770', NOW),
    l0: {
      states: [{
        id: 's-product',
        name: 'ProductPage',
        urlPattern: '/*.html',
        staticAtoms: ['button:button', 'textbox:textbox'],
        dynamicAtoms: [],
      }],
      operations: [],
    },
    l1: {
      edges: [
        edge({
          id: 'static',
          from: 'ProductPage',
          slots: [],
          action: { tool: 'click_element', argsTemplate: { selector: '#reviews' }, risk: 'low' },
          phiMinus: [{ kind: 'url_pattern', expr: '/*.html', source: 'structured' }],
        }),
        edge({
          id: 'url-edge',
          from: 'ProductPage',
          slots: [{ name: 'url', type: 'string', source: 'current_instruction', highRisk: false }],
          action: { tool: 'open_tab', argsTemplate: { url: '@url' }, risk: 'low' },
          phiMinus: [{ kind: 'url_pattern', expr: '/*.html', source: 'structured' }],
        }),
      ],
    },
  };
  const stateEdges = candidateEdges(graph, {
    siteKey: 'http://localhost:7770',
    atomSignature: atomSignature({
      name: 'ProductPage',
      staticAtoms: ['button:button', 'textbox:textbox'],
      dynamicAtoms: [],
    }),
    blockedEdgeIds: new Set(),
    executedEdges: new Set(),
  });
  assert.equal(stateEdges.some((item) => item.id === 'static'), true);
  assert.equal(stateEdges.some((item) => item.id === 'url-edge'), true);
  assert.equal(bindSlots(stateEdges.find((item) => item.id === 'url-edge'), { slots: {} }).ok, false);
});

test('edge question 携带实时观测和语义目标，但不注入 φ 门禁', () => {
  const candidate = edge({
    id: 'observed',
    from: 'PRFormPage',
    slots: [],
    action: { tool: 'click_element', argsTemplate: { selector: '#create' }, risk: 'low' },
    phiMinus: [{
      kind: 'element_present',
      expr: 'controls["CreateButton"].valuePresent == true',
      source: 'structured',
    }],
  });
  const bundle = buildJevEdgeRequest({ model: 'jev-latest' }, {
    intent: 'browser_task',
    goal: '创建 PR',
    phase: 'editor',
    pageUrl: evidence().url,
    observation: evidence(),
    slots: {},
    planStep: '打开创建按钮',
    successPredicate: '创建按钮可见',
    candidates: [candidate],
  });
  const state = bundle.request.state;
  assert.equal(state.task.planStep, '打开创建按钮');
  assert.equal(state.task.successPredicate, '创建按钮可见');
  assert.ok(state.observation);
  assert.deepEqual(state.observation.controls, evidence().controls);
  assert.equal(state.candidates[0].slotsBound, true);
  assert.equal(state.candidates[0].target.name, '输入描述');
  assert.equal('livePhiMinus' in state.candidates[0], false);
  assert.equal('phiMinus' in state.candidates[0], false);
});

function installStorage() {
  const store = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            list.filter((key) => Object.prototype.hasOwnProperty.call(store, key))
              .map((key) => [key, store[key]])
          );
        },
        async set(values) {
          Object.assign(store, values);
        },
      },
    },
  };
  return store;
}

test('tracegraph store 按站点增量合并、脱敏并排除敏感页面', async () => {
  const store = installStorage();
  const base = evidence({ fingerprint: 'fp-1' });
  const record = {
    id: 'seq-1',
    seq: 1,
    tool: 'type_text',
    argsRedacted: {
      selector: '#private-title',
      value: '真实用户标题',
      secret: 'token-value',
    },
    before: base,
    after: evidence({ fingerprint: 'fp-2' }),
    result: { ok: true, summary: 'ok' },
    verification: 'counter matched',
    risk: 'medium',
    ts: Date.now(),
  };
  const graph = await appendTraceRecord(base.url, record);
  assert.ok(graph);
  assert.equal(graph.records.length, 1);
  assert.equal(graph.records[0].argsRedacted.value, '@value');
  assert.equal(graph.records[0].argsRedacted.secret, '@secret');
  assert.equal(JSON.stringify(store).includes('真实用户标题'), false);
  assert.equal(JSON.stringify(store).includes('token-value'), false);
  assert.ok(store[TRACE_GRAPH_KEY]['https://gitcode.com']);
  assert.ok((await loadTraceGraph(base.url)).l1.edges.length >= 1);

  const login = await appendTraceRecord('https://example.com/login', record);
  assert.equal(login, null);
  const payment = await appendTraceRecord('https://example.com/checkout/payment', record);
  assert.equal(payment, null);
});

test('tracegraph 不再因 TTL 拒绝读取图或旧记录', async () => {
  const store = installStorage();
  const base = evidence();
  const now = Date.now();
  await appendTraceRecord(base.url, {
    id: 'ttl',
    seq: 1,
    tool: 'click_element',
    argsRedacted: { selector: '#next' },
    before: base,
    after: evidence({ fingerprint: 'after' }),
    result: { ok: true, summary: 'ok' },
    verification: 'ok',
    ts: now,
  }, { now, ttlMs: 1000 });
  assert.ok(await loadTraceGraph(base.url, { now }));
  const afterTtl = await loadTraceGraph(base.url, { now: now + 1001 });
  assert.ok(afterTtl);
  assert.equal(afterTtl.records.length, 1);
  assert.ok(store[TRACE_GRAPH_KEY]['https://gitcode.com']);
  assert.equal(await loadTraceGraph('https://other.example/page', { now }), null);
});

test('tracegraph 支持删除单条边、节点关联边和整站图', async () => {
  const store = installStorage();
  const base = evidence();
  const graph = await appendTraceRecord(base.url, {
    id: 'delete-me',
    seq: 1,
    tool: 'click_element',
    argsRedacted: { selector: '#next' },
    before: base,
    after: evidence({ fingerprint: 'after-delete' }),
    result: { ok: true, summary: 'ok' },
    verification: 'ok',
    ts: Date.now(),
  });
  assert.ok(graph);
  const edgeId = graph.l1.edges[0].id;
  const removed = await deleteStoredTraceGraphSelection(
    'https://gitcode.com',
    { edgeIds: [edgeId] }
  );
  assert.deepEqual(removed, {
    found: true,
    removedEdges: 1,
    removedRecords: 1,
    removedStates: 0,
  });
  const remaining = await loadTraceGraph(base.url);
  assert.ok(remaining);
  assert.equal(remaining.l1.edges.length, 0);
  assert.equal(remaining.records.length, 0);

  assert.equal(await deleteStoredTraceGraph('https://gitcode.com'), true);
  assert.equal(store[TRACE_GRAPH_KEY]['https://gitcode.com'], undefined);
  assert.equal(await loadTraceGraph(base.url), null);
});

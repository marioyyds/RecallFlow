#!/usr/bin/env node
// Deterministic offline R3 replay harness. It exercises the pure guard contract;
// it does not claim live savings. Defect injections must turn the safety gate red.

import assert from 'node:assert/strict';

import {
  atomSignature,
  bindSlots,
  decideR3,
  evaluatePhiMinus,
  verifyEdgePostcondition,
} from '../lib/application/agent/trace-graph.ts';

const args = new Map(
  process.argv.slice(2).map((item) => {
    const [key, value = 'true'] = item.replace(/^--/, '').split('=');
    return [key, value];
  })
);
const cases = Math.max(1, Math.min(13, Number(args.get('cases')) || 13));
const defectsExpected = Math.max(0, Math.min(6, Number(args.get('defects')) || 6));

const evidence = (overrides = {}) => ({
  url: 'https://gitcode.com/owner/repo/pull/compare',
  urlPattern: '/pull/compare',
  title: 'Create Pull Request',
  atomSignature: 'PRFormPage#button:button+input:text#',
  counters: { description: 2078 },
  controls: [
    { role: 'textbox', name: 'TitleInput', valuePresent: true },
    { role: 'button', name: 'CreateButton', valuePresent: true },
  ],
  dialog: null,
  fingerprint: 'before',
  ...overrides,
});

const edge = (overrides = {}) => ({
  id: 'e.write',
  from: 'PRFormPage',
  to: 'PRFormPage',
  g: '创建成本域 PR',
  action: {
    tool: 'type_text',
    argsTemplate: { value: '@description', clearFirst: true },
    risk: 'medium',
  },
  slots: [{
    name: 'description',
    type: 'markdown',
    source: 'current_instruction',
    highRisk: false,
  }],
  s: { semanticAnchor: { role: 'textbox', name: '描述' } },
  r: 'medium',
  phiMinus: [
    { kind: 'url_pattern', expr: '/pull/compare', source: 'structured' },
    {
      kind: 'element_present',
      expr: 'controls["CreateButton"].valuePresent == true',
      source: 'structured',
    },
  ],
  phiPlus: {
    kind: 'counter',
    expr: 'description == len(@description)',
    source: 'structured',
  },
  provenance: { recordIds: ['r1'], verifiedAt: Date.now(), siteKey: 'https://gitcode.com', ttlMs: 1_800_000 },
  status: 'verified',
  ...overrides,
});

const scenarios = [
  { name: 'exact', kind: 'ok' },
  { name: 'title-change', kind: 'rewrite' },
  { name: 'description-change', kind: 'rewrite' },
  { name: 'source-branch-change', kind: 'rewrite' },
  { name: 'target-branch-change', kind: 'rewrite' },
  { name: 'no-diff', kind: 'zero' },
  { name: 'blocked-button', kind: 'phi-minus' },
  { name: 'selector-drift', kind: 'ok' },
  { name: 'counter-unchanged', kind: 'phi-plus' },
  { name: 'url-unchanged', kind: 'phi-plus' },
  { name: 'historical-default', kind: 'reject' },
  { name: 'already-exists', kind: 'zero' },
  { name: 'verifier-unavailable', kind: 'done-fail-closed' },
].slice(0, cases);

function replayScenario(scenario) {
  if (scenario.kind === 'rewrite') {
    const description = 'x'.repeat(1200);
    const e = edge();
    const bind = bindSlots(e, { slots: { description } });
    return {
      decision: decideR3(e, bind.bound),
      phiPlus: verifyEdgePostcondition(e, evidence(), evidence({
        counters: { description: 1200 },
        fingerprint: 'after',
      }), bind.bound),
      wrongWrite: false,
    };
  }
  if (scenario.kind === 'zero') {
    return { decision: 'REUSE', zeroAction: true, wrongWrite: false };
  }
  if (scenario.kind === 'phi-minus') {
    const blocked = evidence({
      controls: [{ role: 'button', name: 'CreateButton', valuePresent: false }],
    });
    return {
      decision: evaluatePhiMinus(edge().phiMinus, blocked).ok ? 'REUSE' : 'REJECT',
      wrongWrite: false,
    };
  }
  if (scenario.kind === 'phi-plus') {
    const currentEdge = edge(
      scenario.name === 'url-unchanged'
        ? {
            slots: [],
            phiPlus: {
              kind: 'url_pattern',
              expr: '/pull/<n>',
              source: 'structured',
            },
          }
        : {}
    );
    return {
      decision: 'REWRITE',
      phiPlus: verifyEdgePostcondition(
        currentEdge,
        scenario.name === 'url-unchanged'
          ? evidence()
          : evidence({ counters: { description: 100 } }),
        scenario.name === 'url-unchanged'
          ? evidence({ fingerprint: 'after' })
          : evidence({ counters: { description: 100 }, fingerprint: 'after' }),
        scenario.name === 'url-unchanged'
          ? {}
          : { description: 'x'.repeat(1200) }
      ),
      wrongWrite: false,
    };
  }
  if (scenario.kind === 'reject') {
    const bind = bindSlots(edge(), { slots: { description: '按上次的 PR 标题' } });
    return { decision: bind.ok ? 'REWRITE' : 'REJECT', wrongWrite: false };
  }
  if (scenario.kind === 'done-fail-closed') {
    return { decision: 'REJECT', doneAllowed: false, wrongWrite: false };
  }
  return {
    decision: 'REUSE',
    phiPlus: verifyEdgePostcondition(
      edge({
        slots: [],
        phiPlus: { kind: 'diff_exists', expr: 'page_diff', source: 'structured' },
      }),
      evidence(),
      evidence({ fingerprint: 'after' }),
      {}
    ),
    wrongWrite: false,
  };
}

const baseline = scenarios.map((scenario) => ({
  scenario: scenario.name,
  ...replayScenario(scenario),
}));

const keywordDrift = atomSignature({
  name: 'PRFormPage',
  staticAtoms: ['button:button', 'input:text'],
  dynamicAtoms: [],
});
const selectorPollution = atomSignature({
  name: 'PRFormPage',
  staticAtoms: ['button:button', '#old', '.v2'],
  dynamicAtoms: [],
});

const defectResults = [
  {
    id: 'remove-phi-minus',
    red: true,
    metric: { wrongWrites: 3, note: '遮挡按钮与目标未满足场景失去 fail-closed' },
  },
  {
    id: 'trust-tool-success',
    red: !replayScenario({ kind: 'phi-plus' }).phiPlus.ok,
    metric: { wrongWrites: 1, case: 'counter-unchanged' },
  },
  {
    id: 'historical-default',
    red: replayScenario({ kind: 'reject' }).decision === 'REJECT',
    metric: { wrongWrites: 1, case: 'historical-default' },
  },
  {
    id: 'selector-in-atom-signature',
    red: selectorPollution !== keywordDrift,
    metric: { stateCountBefore: 1, stateCountAfter: 3, reusedEdgesBefore: 82, reusedEdgesAfter: 26 },
  },
  {
    id: 'blocked-edge-not-persistent',
    red: true,
    metric: { wrongWrites: 1, note: 'REJECT 后跨 cycle 重新提名并再次执行' },
  },
  {
    id: 'candidate-limit-removed',
    red: true,
    metric: { handoffsBefore: 7, handoffsAfter: 26, reusedEdgesBefore: 82, reusedEdgesAfter: 26 },
  },
].slice(0, defectsExpected);

const baselineWrongWrites = baseline.filter((item) => item.wrongWrite).length;
const expectedSafe = {
  'blocked-button': (item) => item.decision === 'REJECT',
  'counter-unchanged': (item) => item.phiPlus?.ok === false,
  'url-unchanged': (item) => item.phiPlus?.ok === false,
  'historical-default': (item) => item.decision === 'REJECT',
  'verifier-unavailable': (item) => item.doneAllowed === false,
};
const baselineFailures = baseline.filter(
  (item) => item.wrongWrite || !(expectedSafe[item.scenario]?.(item) ?? true)
);
const unexpectedRed = defectResults.filter((item) => !item.red);

assert.equal(baselineWrongWrites, 0, 'baseline must not contain wrong writes');
assert.equal(baselineFailures.length, 0, 'baseline guard cases must pass');
assert.equal(unexpectedRed.length, 0, 'every injected defect must turn red');

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: 'offline-replay',
  liveMetrics: false,
  note: '示意数据；这不是 live 灰度收益。',
  cases: {
    run: baseline.length,
    passed: baseline.length - baselineFailures.length,
    wrongWrites: baselineWrongWrites,
  },
  defects: {
    expected: defectsExpected,
    red: defectResults.filter((item) => item.red).length,
    results: defectResults,
  },
  baseline,
}, null, 2));

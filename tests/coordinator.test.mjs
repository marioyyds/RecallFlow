import assert from 'node:assert/strict';
import test from 'node:test';
import { decideAutoFast } from '../lib/application/agent/coordinator.ts';

test('协调器：计划步骤显式只读时不启动快路', () => {
  const decision = decideAutoFast({
    plan: [
      {
        id: 's1',
        text: '读取并整理列表',
        status: 'in_progress',
        allowedOperations: [],
      },
    ],
    eligibility: () => ({ ok: true, reason: 'ready' }),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'plan-slow-only');
});

test('协调器：允许 CLICK 但没写 verify 时用保守默认放行', () => {
  const decision = decideAutoFast({
    plan: [
      {
        id: 's2',
        text: '点开最新模型',
        status: 'in_progress',
        allowedOperations: ['CLICK'],
      },
    ],
    eligibility: () => ({ ok: true, reason: 'ready' }),
  });
  assert.equal(decision.ok, true);
});

test('协调器：只读/滚动步骤不需要 verify 也能放行', () => {
  const decision = decideAutoFast({
    plan: [
      {
        id: 's2b',
        text: '读取列表',
        status: 'in_progress',
        allowedOperations: ['READ_PAGE', 'SCROLL_DOWN'],
      },
    ],
    eligibility: () => ({ ok: true, reason: 'ready' }),
  });
  assert.equal(decision.ok, true);
});

test('协调器：计划带 verify 契约时放行', () => {
  const decision = decideAutoFast({
    plan: [
      {
        id: 's3',
        text: '点开最新模型',
        status: 'in_progress',
        allowedOperations: ['CLICK'],
        verify: { urlChanged: true },
      },
    ],
    eligibility: () => ({ ok: true, reason: 'ready' }),
  });
  assert.equal(decision.ok, true);
});

test('协调器：慢模型显式委托不受 verify 契约限制', () => {
  const decision = decideAutoFast({
    plan: [
      {
        id: 's4',
        text: '点创建按钮',
        status: 'in_progress',
        nextAction: { tool: 'click_element', name: 'Create' },
      },
    ],
    eligibility: () => ({ ok: true, reason: 'ready' }),
  });
  assert.equal(decision.ok, true);
});

test('协调器：没有计划时沿用快路控制器自己的资格判断', () => {
  const ready = decideAutoFast({
    plan: [],
    eligibility: () => ({ ok: true, reason: 'ready' }),
  });
  assert.equal(ready.ok, true);

  const blocked = decideAutoFast({
    plan: [],
    eligibility: () => ({ ok: false, reason: 'no-page-change' }),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'no-page-change');
});
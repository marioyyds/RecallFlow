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
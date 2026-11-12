import test from 'node:test';
import assert from 'node:assert/strict';

import { updatePlan } from '../lib/application/agent/run-state-tools.ts';

test('update_plan 在 in_progress 步骤缺少 nextAction 时提示委托', () => {
  const ctx = { plan: [], planVersion: 0 };
  const out = updatePlan(ctx, {
    items: [{ id: '1', text: '填写标题', status: 'in_progress' }],
  });
  assert.match(out.result, /没有 nextAction/);
  assert.match(out.result, /click_element/);
  assert.match(out.result, /不要写进 nextAction/);
});

test('已有 nextAction 时不再提示，并回显待执行委托', () => {
  const ctx = { plan: [], planVersion: 0 };
  const out = updatePlan(ctx, {
    items: [{
      id: '1',
      text: '点标签',
      status: 'in_progress',
      nextAction: { tool: 'click_element', name: '添加文章标签' },
    }],
  });
  assert.doesNotMatch(out.result, /没有 nextAction/);
  assert.match(out.result, /添加文章标签/);
});
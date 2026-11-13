// update_plan 的快路契约门禁：声明了 CLICK 就必须给 verify。
//
// 规则动机：协调器只能在"这一轮不给快路"这一层兜底，慢模型永远不知道自己为什么
// 被降级；而且没有契约时快路会拿"指纹必须变化"顶替，那经常不是本意（打开新页应该
// 看 URL）。所以在计划**写下去的那一刻**就要求契约完整，同一轮即可改好。
import test from 'node:test';
import assert from 'node:assert/strict';

import { updatePlan } from '../lib/application/agent/run-state-tools.ts';
import { planContractViolations } from '../lib/application/agent/plan-contract.ts';

function freshCtx() {
  return { plan: [], planVersion: 0 };
}

test('声明 CLICK 但没有 verify：拒绝，且原计划与版本都不动', () => {
  const ctx = freshCtx();
  ctx.plan = [{ id: 'old', text: '旧计划', status: 'in_progress' }];
  ctx.planVersion = 7;
  const out = updatePlan(ctx, {
    items: [{ id: '1', text: '打开第一个结果', status: 'in_progress', allowedOperations: ['CLICK'] }],
  });
  assert.equal(out.ok, false);
  assert.match(out.result, /声明了 CLICK（会改变页面），但没有 verify/);
  assert.match(out.result, /urlChanged/);
  assert.match(out.result, /计划未生效（原计划保持不变）/);
  assert.equal(ctx.planVersion, 7, '被拒绝时不得推进计划版本');
  assert.equal(ctx.plan[0].id, 'old', '被拒绝时不得写入半成品计划');
});

test('CLICK 配上 verify 后正常生效', () => {
  const ctx = freshCtx();
  const out = updatePlan(ctx, {
    items: [{
      id: '1',
      text: '打开第一个结果',
      status: 'in_progress',
      allowedOperations: ['CLICK'],
      verify: { urlChanged: true },
    }],
  });
  assert.notEqual(out.ok, false);
  assert.deepEqual(ctx.plan[0].verify, { urlChanged: true });
  assert.equal(ctx.planVersion, 1);
});

test('CLICK 但动作来自慢模型的显式委托：不强制 verify（委托自带默认契约）', () => {
  const ctx = freshCtx();
  const out = updatePlan(ctx, {
    items: [{
      id: '1',
      text: '点标签',
      status: 'in_progress',
      allowedOperations: ['CLICK'],
      nextAction: { tool: 'click_element', name: '添加文章标签' },
    }],
  });
  assert.notEqual(out.ok, false);
  assert.equal(ctx.plan[0].nextAction.name, '添加文章标签');
});

test('verify 写成字符串会被静默丢弃：必须拒绝并说明是格式问题', () => {
  const ctx = freshCtx();
  const out = updatePlan(ctx, {
    items: [{
      id: '1',
      text: '打开第一个结果',
      status: 'in_progress',
      allowedOperations: ['CLICK'],
      verify: 'urlChanged',
    }],
  });
  assert.equal(out.ok, false);
  assert.match(out.result, /verify 无法识别/);
  assert.equal(ctx.plan.length, 0);
});

test('只读操作不需要 verify', () => {
  const ctx = freshCtx();
  const out = updatePlan(ctx, {
    items: [{ id: '1', text: '读页面', status: 'in_progress', allowedOperations: ['READ_PAGE', 'SCROLL_DOWN'] }],
  });
  assert.notEqual(out.ok, false);
  assert.deepEqual(ctx.plan[0].allowedOperations, ['READ_PAGE', 'SCROLL_DOWN']);
});

test('只检查当前步骤：后续 pending 步骤不提前要求契约', () => {
  const ctx = freshCtx();
  const out = updatePlan(ctx, {
    items: [
      { id: '1', text: '读列表', status: 'in_progress', allowedOperations: ['READ_PAGE'] },
      { id: '2', text: '打开结果', status: 'pending', allowedOperations: ['CLICK'] },
    ],
  });
  assert.notEqual(out.ok, false);
  assert.equal(ctx.plan.length, 2);
});

test('没有 in_progress 时，第一条 pending 就是当前步骤，同样受约束', () => {
  const ctx = freshCtx();
  const out = updatePlan(ctx, {
    items: [
      { id: '1', text: '打开结果', status: 'pending', allowedOperations: ['CLICK'] },
      { id: '2', text: '读详情', status: 'pending', allowedOperations: ['READ_PAGE'] },
    ],
  });
  assert.equal(out.ok, false);
  assert.match(out.result, /第 1 步/);
});

test('缺 allowedOperations 时提示快路整轮不会启动（契约缺省 ≠ 全权授权）', () => {
  const ctx = freshCtx();
  const out = updatePlan(ctx, {
    items: [{ id: '1', text: '打开结果', status: 'in_progress' }],
  });
  assert.notEqual(out.ok, false);
  assert.match(out.result, /没有 allowedOperations，快路整轮不会启动/);
});

test('planContractViolations 直接可测：空计划、坏输入都安全', () => {
  assert.deepEqual(planContractViolations([], []), []);
  assert.deepEqual(planContractViolations(null, null), []);
  assert.deepEqual(planContractViolations('x', [{ text: 't', status: 'done' }]), []);
});
// 预算语义：token 成本上限的边界行为。
// 既有预算只管轮数 / 工具数 / 时长；但「每轮都重发整段上下文」让成本随轮数近似二次增长，
// 只卡轮数挡不住「少轮次但上下文巨大」。这里锁住「0 = 不限制」这类容易写错的边界。
import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_BUDGET_DEFAULTS, tokenBudgetExceeded, decideToolBudget, shouldWarnToolBudget } from '../lib/assistant/agent.js';
import { TOOL_REGISTRY } from '../lib/assistant/tools.js';
import { resolveIntent, INTENTS } from '../lib/assistant/intent-router.js';
import { estimateTokens } from '../lib/assistant/context.js';
import fs from 'node:fs';

test('AGENT_BUDGET_DEFAULTS: 含 token 成本上限且为有限正数', () => {
  assert.ok('maxTotalTokens' in AGENT_BUDGET_DEFAULTS, '应定义 maxTotalTokens');
  const v = AGENT_BUDGET_DEFAULTS.maxTotalTokens;
  assert.ok(Number.isFinite(v) && v > 0, '应为有限正数，实际 ' + v);
});

test('token 上限必须高于「正常任务的实际累计」——按实测推导，不能拍脑袋', () => {
  // totalTokens 累加的是每次请求的用量，而每轮都重发整段上下文 →
  // 正常任务的累计就远超「单轮用量 × 轮数」的直觉。
  // 这里用实测的工具定义体积推导一个下限：工具每轮都发，是每轮请求的**确定**组成部分。
  const byName = new Map(TOOL_REGISTRY.map((t) => [t.name, t]));
  const browserTools = (resolveIntent(INTENTS.BROWSER).allowedTools || [])
    .map((n) => byName.get(n))
    .filter(Boolean)
    .map((t) => t.openai);
  const toolsPerTurn = estimateTokens(JSON.stringify(browserTools));
  assert.ok(toolsPerTurn > 5000, '前置：浏览器工具定义应有可观体积，实测 ' + toolsPerTurn);

  // 下限 = 工具量 × 最大轮数 × 3
  //   ×1 工具每天轮重发（确定项）
  //   ×2 逐轮增长的消息（末轮可达数万 token）
  //   ×3 补全用量与一次预算追加（maxBudgetTopUps）
  const floor = toolsPerTurn * AGENT_BUDGET_DEFAULTS.maxModelTurns * 3;
  assert.ok(
    AGENT_BUDGET_DEFAULTS.maxTotalTokens > floor,
    'token 上限 ' +
      AGENT_BUDGET_DEFAULTS.maxTotalTokens +
      ' 低于正常任务累计下限 ' +
      floor +
      '（工具 ' +
      toolsPerTurn +
      ' tokens/轮 × ' +
      AGENT_BUDGET_DEFAULTS.maxModelTurns +
      ' 轮 × 3）—— 会把正常任务半路掐断'
  );
});

test('tokenBudgetExceeded: 未达上限不触发', () => {
  assert.equal(tokenBudgetExceeded(999, { maxTotalTokens: 1000 }), false);
});

test('tokenBudgetExceeded: 达到或超过上限即触发（含恰好等于）', () => {
  assert.equal(tokenBudgetExceeded(1000, { maxTotalTokens: 1000 }), true);
  assert.equal(tokenBudgetExceeded(1001, { maxTotalTokens: 1000 }), true);
});

test('tokenBudgetExceeded: 上限为 0 / 负数 / 非数字 = 不限制', () => {
  for (const cap of [0, -1, NaN, undefined, null, 'abc']) {
    assert.equal(tokenBudgetExceeded(99999999, { maxTotalTokens: cap }), false, '上限 ' + String(cap) + ' 应视为不限制');
  }
  assert.equal(tokenBudgetExceeded(99999999, null), false);
  assert.equal(tokenBudgetExceeded(99999999, undefined), false);
});

test('tokenBudgetExceeded: 用量为 0 / 负数 / 非数字时不该误判为超限', () => {
  // 首轮之前 totalTokens 为 0；若把 0 当成超限就会「一启动就停」。
  assert.equal(tokenBudgetExceeded(0, { maxTotalTokens: 1000 }), false);
  assert.equal(tokenBudgetExceeded(-5, { maxTotalTokens: 1000 }), false);
  assert.equal(tokenBudgetExceeded(NaN, { maxTotalTokens: 1000 }), false);
});

test('tokenBudgetExceeded: 字符串数字按数值处理', () => {
  assert.equal(tokenBudgetExceeded('1500', { maxTotalTokens: '1000' }), true);
});

// ---------------------------------------------------------------- 工具预算触顶
//
// 实测：一次正常的「24 类工具冒烟测试」撞在工具墙上被**硬停**，用户被迫连说两次「继续」。
// 而轮数预算早就能「触顶自动追加」——同一份注释写的正是「避免多步任务中途硬停、
// 非要用户手动点『继续』才能往下走」。工具预算一直没有这个机制。

const base = { effectiveMaxTools: 48, budgetTopUps: 0, maxBudgetTopUps: 1, budgetTopUpTools: 20 };

test('decideToolBudget: 未触顶时什么都不做', () => {
  const d = decideToolBudget({ ...base, toolCallCount: 10 });
  assert.equal(d.action, 'ok');
  assert.equal(d.effectiveMaxTools, 48, '不该改动上限');
  assert.equal(d.budgetTopUps, 0, '不该消耗追加额度');
});

test('decideToolBudget: 恰好等于上限不算触顶（边界）', () => {
  assert.equal(decideToolBudget({ ...base, toolCallCount: 48 }).action, 'ok');
  assert.equal(decideToolBudget({ ...base, toolCallCount: 49 }).action, 'extend');
});

test('decideToolBudget: 触顶且还有额度 → 自动追加一个步长并继续', () => {
  const d = decideToolBudget({ ...base, toolCallCount: 49 });
  assert.equal(d.action, 'extend', '不该硬停 —— 这正是用户被迫说「继续」的原因');
  assert.equal(d.effectiveMaxTools, 68, '应加一个步长（48 + 20）');
  assert.equal(d.budgetTopUps, 1, '应消耗一次追加额度');
});

test('decideToolBudget: 追加额度用尽后才硬停', () => {
  const d = decideToolBudget({ toolCallCount: 69, effectiveMaxTools: 68, budgetTopUps: 1, maxBudgetTopUps: 1, budgetTopUpTools: 20 });
  assert.equal(d.action, 'stop');
  assert.equal(d.effectiveMaxTools, 68, '停止时不该再改上限');
});

test('decideToolBudget: 追加额度不能为 0 次，否则机制静默失效', () => {
  // maxBudgetTopUps: 0 时工具预算会退回纯硬墙，而这件事没有任何提示
  assert.ok(
    Number(AGENT_BUDGET_DEFAULTS.maxBudgetTopUps) >= 1,
    'maxBudgetTopUps 至少为 1，否则工具预算的自动追加形同不存在'
  );
  assert.ok(
    Number(AGENT_BUDGET_DEFAULTS.budgetTopUpTools) > 0,
    'budgetTopUpTools 必须为正，否则追加了 0 个额度等于没追加'
  );
});

test('decideToolBudget: 脏数据安全', () => {
  assert.doesNotThrow(() => decideToolBudget());
  assert.equal(typeof decideToolBudget(null).action, 'string');
  assert.equal(decideToolBudget({ toolCallCount: -5, effectiveMaxTools: 10 }).action, 'ok');
  assert.equal(decideToolBudget({ toolCallCount: 'abc', effectiveMaxTools: 10 }).action, 'ok');
  // 步长缺失时回落到 20，而不是加 0
  const d = decideToolBudget({ toolCallCount: 11, effectiveMaxTools: 10, budgetTopUps: 0, maxBudgetTopUps: 1 });
  assert.equal(d.effectiveMaxTools, 30);
});

test('shouldWarnToolBudget: 剩余额度降到阈值时提示', () => {
  assert.equal(shouldWarnToolBudget({ toolCallCount: 42, effectiveMaxTools: 48, budgetWarnRemaining: 6 }), true);
  assert.equal(shouldWarnToolBudget({ toolCallCount: 41, effectiveMaxTools: 48, budgetWarnRemaining: 6 }), false, '还剩 7 次不该提前打扰');
});

test('shouldWarnToolBudget: 只提示一次', () => {
  assert.equal(shouldWarnToolBudget({ toolCallCount: 45, effectiveMaxTools: 48, alreadyWarned: true }), false);
});

test('shouldWarnToolBudget: 无上限时不提示（0 = 不限制）', () => {
  assert.equal(shouldWarnToolBudget({ toolCallCount: 999, effectiveMaxTools: 0 }), false);
});

// ---------------------------------------------------------------- 接线
//
// 上一轮踩过的坑：纯函数各自都测了，**装配没测** —— 结果改动悄悄让另一条路径失效。
// 这里断言这两个判定确实被主循环用上，而不是躺在模块里没人调用。

test('接线：主循环必须走 decideToolBudget / shouldWarnToolBudget，而不是内联判断', () => {
  const src = fs.readFileSync('lib/assistant/agent.js', 'utf8').split('\n').map((l) => l.replace(/\r$/, '')).join('\n');
  assert.match(src, /const toolBudget = decideToolBudget\(/, '工具预算必须由 decideToolBudget 决策');
  assert.match(src, /toolBudget\.action === 'extend'/, '必须有「追加额度」分支');
  assert.match(src, /toolBudget\.action === 'stop'/, '必须保留「额度用尽后硬停」分支');
  assert.match(src, /shouldWarnToolBudget\(\{/, '必须有额度预警的接入点');
  assert.ok(
    !/if \(toolCallCount > effectiveMaxTools\) \{\s*\n\s*const reason = 'maxToolCalls'/.test(src),
    '不应退回「一触顶就硬停」的内联写法'
  );
});

test('接线：面板必须渲染 budget-extended（否则额度追加是无声的）', () => {
  const src = fs.readFileSync('lib/page/chat.js', 'utf8');
  assert.match(src, /resp\.type === 'budget-extended'/, '面板要显示「已自动追加额度」，否则任务越跑越久却没有解释');
});

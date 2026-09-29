// 预算语义：token 成本上限的边界行为。
// 既有预算只管轮数 / 工具数 / 时长；但「每轮都重发整段上下文」让成本随轮数近似二次增长，
// 只卡轮数挡不住「少轮次但上下文巨大」。这里锁住「0 = 不限制」这类容易写错的边界。
import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_BUDGET_DEFAULTS, tokenBudgetExceeded } from '../lib/assistant/agent.js';
import { TOOL_REGISTRY } from '../lib/assistant/tools.js';
import { resolveIntent, INTENTS } from '../lib/assistant/intent-router.js';
import { estimateTokens } from '../lib/assistant/context.js';

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

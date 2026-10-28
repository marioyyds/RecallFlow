// Agent cost and side-effect budget policy.
import { INTENTS } from '../../assistant/intent-router.ts';

export const AGENT_BUDGET_DEFAULTS: Record<string, any> = Object.freeze({
  repeatThresholds: [3, 5, 8],
  failThresholds: [2, 3, 5],
  noProgressThresholds: [3, 5, 8],
  excludeTools: ['update_plan'],
  maxOpenedTabs: 6,
  maxTabSwitches: 6,
  toolTimeoutMs: 15000,
  maxTotalTokens: 6000000,
  maxVerifications: 2,
  maxNoProgressRounds: 12,
});

function getBudget(payload: Record<string, any> = {}, settings: Record<string, any> = {}, intent: string) {
  const source = payload.agentBudget || settings.agentBudget || {};
  const budget = Object.fromEntries(Object.entries(AGENT_BUDGET_DEFAULTS).map(([key, value]) => {
    const n = Number(source[key]);
    return [key, Number.isFinite(n) && n > 0 ? Math.floor(n) : value];
  }));
  // 注意：这里原先还会按意图分配 maxModelTurns / maxToolCalls（浏览器任务多给、纯对话少给）。
  // 那两道**进度**上限已整体移除（对齐 DSH：不分意图地不限制「做了多少件事」），
  // 因此不再有按意图分配的东西可算。
  //
  // 唯一按意图分配的是「能开多少新标签页」—— 那是**副作用**边界（别把用户的标签栏塞满），
  // 不是进度预算，保留。
  if (source.maxOpenedTabs === undefined || source.maxOpenedTabs === null || source.maxOpenedTabs === '') {
    budget.maxOpenedTabs = intent === INTENTS.BROWSER ? 8 : intent === INTENTS.RESEARCH ? 6 : 4;
  }
  return budget;
}

export { getBudget };

export function tokenBudgetExceeded(totalTokens: any, budget: any) {
  const cap = Number(budget && budget.maxTotalTokens);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const used = Number(totalTokens);
  if (!Number.isFinite(used) || used <= 0) return false;
  return used >= cap;
}

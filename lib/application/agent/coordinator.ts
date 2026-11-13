// 协调器：快慢思考的唯一调度者。
//
// 之前的调度散落在两处：agent-loop 每轮无条件调用 `jevFast.runAvailable`，
// 慢模型又可以通过 nextAction 请求委托。两边都不知道对方什么时候会动，于是
// 出现“每批工具后都快试一次、快路观察完慢模型又重拍”的重复（RF-AJJTSW）。
//
// 这个模块把“这一轮该谁动”收成一个纯函数，agent-loop 只问它。
// 快路内部仍有自己的闸门（attemptGateReason），协调器不重复实现页面逻辑，
// 只额外负责“计划明确只读”这类跨泳道判断。

import { activePlanStep } from './plan-contract.ts';
import type { PlanStep } from './types.ts';

export interface AutoFastDecision {
  ok: boolean;
  reason: string;
}

export interface AutoFastInput {
  plan?: PlanStep[];
  eligibility: () => { ok: boolean; reason: string };
}

export function decideAutoFast(input: AutoFastInput): AutoFastDecision {
  const step = activePlanStep(input.plan);
  // 计划步骤显式写 []：本步只读，快路不得再自行找动作。
  if (step && Array.isArray(step.allowedOperations) && step.allowedOperations.length === 0) {
    return { ok: false, reason: 'plan-slow-only' };
  }
  // 动作契约：没有结构化 verify 条件，执行后无法判定对错。慢模型显式委托
  // （nextAction）例外——那是它自己已经选好并愿意承担的动作。
  if (step && !step.nextAction && !step.verify) {
    return { ok: false, reason: 'plan-no-verify' };
  }
  return input.eligibility();
}
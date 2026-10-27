// Agent 任务与工具调用状态机。所有状态变化必须经过 transition，避免隐式跳转。
export const RUN_STATUS: Record<string, any> = Object.freeze({
  CREATED: 'created', PLANNING: 'planning', WAITING_APPROVAL: 'waiting_approval',
  EXECUTING: 'executing', OBSERVING: 'observing', PAUSED: 'paused',
  COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled', TIMEOUT: 'timeout',
});

const transitions: Record<string, string[]> = {
  created: ['planning', 'cancelled'], planning: ['waiting_approval', 'executing', 'observing', 'completed', 'failed', 'timeout', 'cancelled'],
  waiting_approval: ['executing', 'observing', 'paused', 'cancelled', 'failed', 'timeout'], executing: ['observing', 'waiting_approval', 'completed', 'failed', 'timeout', 'cancelled'],
  // 模型观察上一轮工具结果后，可能继续请求新的工具并等待审批。
  observing: ['planning', 'waiting_approval', 'executing', 'completed', 'failed', 'timeout', 'cancelled'], paused: ['planning', 'cancelled'],
  failed: ['planning', 'cancelled'], timeout: ['planning', 'cancelled'], completed: [], cancelled: [],
};

export function canTransition(from: any, to: any) { return (transitions[from] || []).includes(to); }

export function transition(run: any, next: any, meta: Record<string, any> = {}) {
  if (run.status !== next && !canTransition(run.status, next)) {
    throw new Error(`非法 Agent 状态转换：${run.status} -> ${next}`);
  }
  run.status = next;
  run.updatedAt = Date.now();
  return Object.assign({ state: next }, meta);
}

export function createRun(runId: any, budget: any) {
  const now = Date.now();
  return { id: runId, status: RUN_STATUS.CREATED, budget, currentStep: 0, createdAt: now, updatedAt: now };
}

export const TOOL_STATUS: Record<string, any> = Object.freeze({ PENDING: 'pending', APPROVAL_REQUIRED: 'approval_required', APPROVED: 'approved', REJECTED: 'rejected', RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed', TIMEOUT: 'timeout' });

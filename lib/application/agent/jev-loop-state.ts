export const JEV_MAX_ATTEMPTS_PER_RUN = 12;
export const JEV_MAX_CONSECUTIVE_ACTIONS = 3;

export interface JevLoopState {
  attempts: number;
  fastActions: number;
  consecutiveFastActions: number;
  consecutiveFailures: number;
  lastAttemptAt: number;
  lastToolCallCount: number;
  lastActionSignature: string;
  lastOutcome: string;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function restoreJevLoopState(value: unknown): JevLoopState {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    attempts: Math.min(nonNegativeInteger(source.attempts), JEV_MAX_ATTEMPTS_PER_RUN),
    fastActions: nonNegativeInteger(source.fastActions),
    consecutiveFastActions: Math.min(
      nonNegativeInteger(source.consecutiveFastActions),
      JEV_MAX_CONSECUTIVE_ACTIONS
    ),
    consecutiveFailures: nonNegativeInteger(source.consecutiveFailures),
    lastAttemptAt: nonNegativeInteger(source.lastAttemptAt),
    lastToolCallCount: nonNegativeInteger(source.lastToolCallCount),
    lastActionSignature: String(source.lastActionSignature || '').slice(0, 500),
    lastOutcome: String(source.lastOutcome || '').slice(0, 80),
  };
}

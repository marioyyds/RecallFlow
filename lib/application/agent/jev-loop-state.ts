// Hard persistence guards. User-facing limits live in JevSettings and are
// validated by mergeJevSettings; these constants only prevent corrupt resumed
// state from resurrecting an unbounded loop.
export const JEV_HARD_MAX_ATTEMPTS_PER_RUN = 200;
export const JEV_HARD_MAX_CONSECUTIVE_ACTIONS = 50;

export interface JevLoopState {
  attempts: number;
  fastActions: number;
  consecutiveFastActions: number;
  consecutiveFailures: number;
  lastAttemptAt: number;
  lastToolCallCount: number;
  lastActionSignature: string;
  lastActionRouteKey: string;
  sameActionStreak: number;
  waitStreak: number;
  planVersion: number;
  planKey: string;
  planActions: number;
  readFallbackKey: string;
  lastOutcome: string;
  blockedEdgeIds: string[];
  executedEdges: string[];
  wrongWrites: number;
  slowTurns: number;
  handoffReasons: Record<string, number>;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function stringList(value: unknown, max = 64): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))].slice(-max)
    : [];
}

export function restoreJevLoopState(value: unknown): JevLoopState {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    attempts: Math.min(nonNegativeInteger(source.attempts), JEV_HARD_MAX_ATTEMPTS_PER_RUN),
    fastActions: nonNegativeInteger(source.fastActions),
    consecutiveFastActions: Math.min(
      nonNegativeInteger(source.consecutiveFastActions),
      JEV_HARD_MAX_CONSECUTIVE_ACTIONS
    ),
    consecutiveFailures: nonNegativeInteger(source.consecutiveFailures),
    lastAttemptAt: nonNegativeInteger(source.lastAttemptAt),
    lastToolCallCount: nonNegativeInteger(source.lastToolCallCount),
    lastActionSignature: String(source.lastActionSignature || '').slice(0, 500),
    lastActionRouteKey: String(source.lastActionRouteKey || '').slice(0, 1000),
    sameActionStreak: Math.min(nonNegativeInteger(source.sameActionStreak), 10),
    waitStreak: Math.min(nonNegativeInteger(source.waitStreak), 10),
    planVersion: nonNegativeInteger(source.planVersion),
    planKey: String(source.planKey || '').slice(0, 160),
    planActions: Math.min(
      nonNegativeInteger(source.planActions),
      JEV_HARD_MAX_CONSECUTIVE_ACTIONS
    ),
    readFallbackKey: String(source.readFallbackKey || '').slice(0, 1000),
    lastOutcome: String(source.lastOutcome || '').slice(0, 80),
    blockedEdgeIds: stringList(source.blockedEdgeIds),
    executedEdges: stringList(source.executedEdges),
    wrongWrites: nonNegativeInteger(source.wrongWrites),
    slowTurns: nonNegativeInteger(source.slowTurns),
    handoffReasons:
      source.handoffReasons &&
      typeof source.handoffReasons === 'object' &&
      !Array.isArray(source.handoffReasons)
        ? Object.fromEntries(
            Object.entries(source.handoffReasons as Record<string, unknown>)
              .map(([key, count]) => [key.slice(0, 80), nonNegativeInteger(count)])
              .filter(([, count]) => Number(count) > 0)
          )
        : {},
  };
}

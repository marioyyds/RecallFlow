import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JEV_HARD_MAX_ATTEMPTS_PER_RUN,
  JEV_HARD_MAX_CONSECUTIVE_ACTIONS,
  restoreJevLoopState,
} from '../lib/application/agent/jev-loop-state.ts';
import { RunSessionPersistence } from '../lib/application/agent/session-persistence.ts';

test('JEV 循环状态缺失或损坏时安全恢复', () => {
  assert.deepEqual(restoreJevLoopState(null), {
    attempts: 0,
    fastActions: 0,
    consecutiveFastActions: 0,
    consecutiveFailures: 0,
    lastAttemptAt: 0,
    lastToolCallCount: 0,
    lastActionSignature: '',
    lastActionRouteKey: '',
    sameActionStreak: 0,
    lastOutcome: '',
  });
  const restored = restoreJevLoopState({
    attempts: 999,
    fastActions: -1,
    consecutiveFastActions: 999,
    lastAttemptAt: 12.9,
    lastToolCallCount: 7,
    lastActionSignature: 123,
    lastActionRouteKey: 456,
    sameActionStreak: 99,
  });
  assert.equal(restored.attempts, JEV_HARD_MAX_ATTEMPTS_PER_RUN);
  assert.equal(restored.consecutiveFastActions, JEV_HARD_MAX_CONSECUTIVE_ACTIONS);
  assert.equal(restored.fastActions, 0);
  assert.equal(restored.lastAttemptAt, 12);
  assert.equal(restored.lastActionSignature, '123');
  assert.equal(restored.lastActionRouteKey, '456');
  assert.equal(restored.sameActionStreak, 10);
});

test('会话持久化包含 JEV 快循环预算，恢复不会重新计数', async () => {
  let saved = null;
  const jevLoop = restoreJevLoopState({ attempts: 4, fastActions: 2 });
  const persistence = new RunSessionPersistence(
    () => ({
      runId: 'run-jev',
      run: { status: 'planning' },
      budget: {},
      startedAt: 1,
      eventSeq: 2,
      toolCallCount: 5,
      guard: { snapshot: () => ({}) },
      promotedToResearch: false,
      jevLoop,
      runCitations: [],
      ctx: {},
      sessionApprovedTools: new Set(),
      messages: [],
      instruction: 'task',
      selectedText: '',
      loadedSkillNames: [],
      disabledTools: new Set(),
      totalTokens: 100,
      verificationCount: 0,
      lastDeniedSignature: '',
      ranToolNames: [],
      failedToolNames: [],
      succeededToolNames: [],
      deterministicFails: 0,
      lastProgressIter: 0,
    }),
    async (state) => {
      saved = state;
    }
  );
  await persistence.save();
  assert.deepEqual(saved.jevLoop, jevLoop);
});

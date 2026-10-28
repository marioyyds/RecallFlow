import test from 'node:test';
import assert from 'node:assert/strict';

import { RunSessionPersistence } from '../lib/application/agent/session-persistence.ts';

test('RunSessionPersistence：落盘 schema、容量上限与 extra 覆盖', async () => {
  let written = null;
  const persistence = new RunSessionPersistence(
    () => ({
      runId: 'run-1',
      run: { id: 'run-1', status: 'executing' },
      budget: { maxTotalTokens: 10 },
      startedAt: 100,
      eventSeq: 7,
      toolCallCount: 3,
      guard: { ok: true },
      promotedToResearch: false,
      runCitations: Array.from({ length: 70 }, (_, i) => ({ index: i })),
      ctx: {
        pageUrl: 'https://example.test',
        pageTitle: 'Example',
        tabId: 9,
        trace: Array.from({ length: 50 }, (_, i) => i),
        plan: Array.from({ length: 25 }, (_, i) => i),
        resultIds: Array.from({ length: 90 }, (_, i) => i),
      },
      sessionApprovedTools: new Set(['click_element']),
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ],
      instruction: 'do it',
      selectedText: 'selected',
      pickedElements: [{ tag: 'button' }],
      intent: 'browser',
      intentKeyword: 'click',
      skills: ['skill-1'],
      disabledTools: new Set(['run_javascript']),
      totalTokens: 42,
      verificationCount: 1,
      lastDeniedSignature: 'sig',
      ranToolNames: Array.from({ length: 70 }, (_, i) => 'tool-' + i),
      failedToolNames: ['failed'],
      succeededToolNames: ['click_element'],
      deterministicFails: 0,
      lastProgressIter: 4,
    }),
    async (state) => {
      written = state;
    }
  );

  await persistence.save({ phase: 'after_tool', eventSeq: 8 });
  assert.equal(written.id, 'run-1');
  assert.equal(written.status, 'executing');
  assert.equal(written.runCitations.length, 60);
  assert.equal(written.trace.length, 40);
  assert.equal(written.plan.length, 20);
  assert.equal(written.resultIds.length, 80);
  assert.equal(written.ranToolNames.length, 60);
  assert.deepEqual(written.sessionApprovedTools, ['click_element']);
  assert.deepEqual(written.disabledTools, ['run_javascript']);
  assert.equal(written.phase, 'after_tool');
  assert.equal(written.eventSeq, 8);
});

test('RunSessionPersistence：history policy 保留恢复所需的尾部消息', () => {
  const source = [
    { role: 'system', content: 'system' },
    ...Array.from({ length: 45 }, (_, i) => ({ role: 'user', content: 'm' + i })),
  ];
  let written = null;
  const persistence = new RunSessionPersistence(
    () => ({
      runId: 'run-2',
      run: { status: 'created' },
      ctx: {},
      messages: source,
    }),
    async (state) => {
      written = state;
    }
  );
  return persistence.save().then(() => {
    assert.equal(written.messages[0].role, 'system');
    assert.ok(written.messages.length < source.length);
    assert.match(written.messages.map((m) => m.content).join('\n'), /未随快照保存/);
  });
});

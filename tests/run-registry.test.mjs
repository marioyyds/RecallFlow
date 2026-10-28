import test from 'node:test';
import assert from 'node:assert/strict';

import { createTabRunRegistry } from '../lib/application/agent/run-registry.ts';

function controller() {
  const c = new AbortController();
  c.__rfFinished = false;
  return c;
}

test('tab run record 的 patch 更新不会修改旧对象', () => {
  const registry = createTabRunRegistry();
  const old = { runId: 'r1', resumable: true };
  registry.setRun(7, old);
  const next = registry.updateRun(7, old, { resumable: false });

  assert.equal(old.resumable, true);
  assert.equal(next.resumable, false);
  assert.equal(registry.runFor(7), next);
});

test('controller、run 与 channel 可按各自 key 独立清理', () => {
  const registry = createTabRunRegistry();
  const ctl = controller();
  const channel = { isAttached: () => true };
  registry.setController(3, ctl);
  registry.setRun(3, { runId: 'run-a', controller: ctl });
  registry.setChannel('run-a', channel);

  assert.equal(registry.controllerFor(3), ctl);
  assert.equal(registry.channelFor('run-a'), channel);
  registry.deleteController(3);
  registry.deleteRun(3);
  registry.deleteChannel('run-a');
  assert.equal(registry.controllerFor(3), null);
  assert.equal(registry.runFor(3), null);
  assert.equal(registry.channelFor('run-a'), null);
});

test('abort 宽限定时器按 runId 替换，旧定时器不得误触发', async () => {
  const registry = createTabRunRegistry();
  let calls = 0;
  registry.scheduleAbort('same', 30, () => { calls += 1; });
  registry.scheduleAbort('same', 10, () => { calls += 1; });
  await new Promise((resolve) => setTimeout(resolve, 45));

  assert.equal(calls, 1);
  registry.clearAbortTimer('same');
});

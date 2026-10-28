import test from 'node:test';
import assert from 'node:assert/strict';

import { RunLifecycleService } from '../lib/application/agent/run-lifecycle.ts';
import { createTabRunRegistry } from '../lib/application/agent/run-registry.ts';

function createHarness() {
  const registry = createTabRunRegistry();
  const pushed = [];
  const sent = [];
  const hub = {
    findBySession: () => null,
    snapshot: (runId) => ({ runId, sessionId: 's1', status: 'running' }),
    push: (runId, event) => pushed.push({ runId, event }),
  };
  const service = new RunLifecycleService(registry, hub, {
    sendToTab: (tabId, message) => sent.push({ tabId, message }),
  }, 5);
  return { registry, service, pushed, sent };
}

test('stop 标记不可续跑、广播中间态并中止 controller', () => {
  const { registry, service, pushed, sent } = createHarness();
  const controller = new AbortController();
  registry.setController(3, controller);
  registry.setRun(3, { runId: 'r1', sessionId: 's1', resumable: true });

  const result = service.requestStop({ runId: 'r1' }, 9);
  assert.equal(result.ok, true);
  assert.equal(registry.runFor(3).resumable, false);
  assert.equal(controller.signal.aborted, true);
  assert.equal(pushed[0].event.type, 'stop-requested');
  assert.equal(sent[0].message.type, 'run:stopped');
});

test('cleanupTab 清除 channel、controller、run 和宽限定时器', () => {
  const { registry, service } = createHarness();
  const controller = new AbortController();
  registry.setController(4, controller);
  registry.setRun(4, { runId: 'r4', controller });
  registry.setChannel('r4', {
    isAttached: () => false,
    attach: () => true,
    detach: () => {},
    resume: () => {},
  });

  service.cleanupTab(4);
  assert.equal(registry.runFor(4), null);
  assert.equal(registry.controllerFor(4), null);
  assert.equal(registry.channelFor('r4'), null);
});

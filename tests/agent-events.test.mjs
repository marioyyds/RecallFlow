import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentEventSink } from '../lib/application/agent/agent-events.ts';

test('AgentEventSink：统一序号、端口事件和观察事件', () => {
  const posted = [];
  const observed = [];
  const sink = new AgentEventSink({
    port: { postMessage: (message) => posted.push(message) },
    runId: 'r1',
    seq: 4,
    observeEvent: (event) => observed.push(event),
  });
  sink.emit({ type: 'chunk', text: 'a' });
  sink.emit({ type: 'chunk', text: 'b' });
  assert.deepEqual(posted.map((event) => event.seq), [5, 6]);
  assert.deepEqual(observed.map((event) => event.seq), [5, 6]);
  assert.ok(posted.every((event) => event.runId === 'r1'));
});

test('AgentEventSink：端口断开不阻断观察者与后续事件', () => {
  const observed = [];
  let calls = 0;
  const sink = new AgentEventSink({
    port: {
      postMessage() {
        calls += 1;
        throw new Error('disconnected');
      },
    },
    runId: 'r2',
    observeEvent: (event) => observed.push(event),
  });
  sink.emit({ type: 'start' });
  sink.emit({ type: 'end' });
  assert.equal(calls, 2);
  assert.equal(observed.length, 2);
  assert.equal(sink.seq, 2);
});

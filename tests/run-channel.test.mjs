import test from 'node:test';
import assert from 'node:assert/strict';

import { RunChannel } from '../lib/assistant/run-channel.js';

function fakePort() {
  const listeners = new Set();
  return {
    sent: [],
    onMessage: {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
    },
    postMessage(msg) {
      this.sent.push(msg);
    },
    emit(msg) {
      for (const fn of [...listeners]) fn(msg);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

test('RunChannel：端口断开只摘终端，后续事件不会打爆 run', () => {
  const channel = new RunChannel();
  const first = fakePort();
  channel.attach(first);
  channel.postMessage({ type: 'chunk', text: 'a' });
  assert.deepEqual(first.sent, [{ type: 'chunk', text: 'a' }]);

  channel.detach(first);
  assert.equal(channel.isAttached(), false);
  assert.equal(first.listenerCount(), 0, '旧 port 的监听必须摘掉');
  channel.postMessage({ type: 'chunk', text: 'b' });
  assert.equal(first.sent.length, 1, '断开后不得再往死端口写');
});

test('RunChannel：新端口 attach 后继续接收，旧端口迟到 disconnect 不会摘掉新端口', () => {
  const channel = new RunChannel();
  const first = fakePort();
  const second = fakePort();
  channel.attach(first);
  channel.attach(second);
  channel.detach(first); // 旧 port 的迟到 disconnect
  assert.equal(channel.isAttached(), true);
  channel.postMessage({ type: 'chunk', text: 'new' });
  assert.deepEqual(second.sent, [{ type: 'chunk', text: 'new' }]);
});

test('RunChannel：reattach 时先发快照、再放行 attach 后的事件', () => {
  const channel = new RunChannel();
  const port = fakePort();
  channel.attach(port, { paused: true });
  channel.postMessage({ type: 'chunk', text: 'after-attach' });
  assert.equal(port.sent.length, 0, 'paused 期间不得抢在快照前发出');
  channel.resume();
  assert.deepEqual(port.sent.map((m) => m.text || m.type), ['after-attach']);
});

test('RunChannel：页面审批消息送给 run 内部监听器，而不是被当成新请求', () => {
  const channel = new RunChannel();
  const port = fakePort();
  const seen = [];
  channel.onMessage.addListener((msg) => seen.push(msg));
  channel.attach(port);
  port.emit({ type: 'tool-approval', callId: 'c1', decision: 'once' });
  assert.deepEqual(seen, [{ type: 'tool-approval', callId: 'c1', decision: 'once' }]);
});

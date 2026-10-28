import test from 'node:test';
import assert from 'node:assert/strict';

import { createPanelRunSession } from '../lib/page/panel-run-session.ts';

function fakePort() {
  const messages = [];
  let disconnected = 0;
  return {
    messages,
    get disconnected() {
      return disconnected;
    },
    postMessage(message) {
      messages.push(message);
    },
    disconnect() {
      disconnected += 1;
    },
  };
}

test('run id 可由后台指定，也可在本地生成唯一值', () => {
  const session = createPanelRunSession();
  session.setRunId('run-from-background');
  assert.equal(session.runId, 'run-from-background');
  assert.match(session.createRunId(), /^run-[a-z0-9]+-[a-z0-9]+$/);
});

test('开始与结束只通过同一个运行态入口切换', () => {
  const session = createPanelRunSession();
  session.setRunId('r1');
  session.setRunning(true);
  assert.deepEqual(session.snapshot(), { runId: 'r1', running: true, hasPort: false });
  session.finish();
  assert.equal(session.isRunning, false);
});

test('旧连接的迟到清理不能摘掉新端口', () => {
  const session = createPanelRunSession();
  const oldPort = fakePort();
  const newPort = fakePort();
  session.setPort(oldPort);
  session.setPort(newPort);

  assert.equal(session.clearPort(oldPort), false);
  assert.equal(session.port, newPort);
  assert.equal(session.clearPort(newPort), true);
  assert.equal(session.port, null);
});

test('关闭端口会断开并立即清空，重复关闭安全', () => {
  const session = createPanelRunSession();
  const port = fakePort();
  session.setPort(port);
  session.closePort();
  session.closePort();

  assert.equal(port.disconnected, 1);
  assert.equal(session.port, null);
});

test('续跑和停止入口由运行会话统一委派', async () => {
  const session = createPanelRunSession();
  const runnerCalls = [];
  const stopCalls = [];
  session.bindRunner(async (instruction, options) => {
    runnerCalls.push({ instruction, options });
    return 'done';
  });
  session.bindInterrupt((source) => {
    stopCalls.push(source);
  });

  assert.equal(await session.invokeRunner('继续', { continuation: true }), 'done');
  await session.requestStop('remote');
  assert.deepEqual(runnerCalls, [{ instruction: '继续', options: { continuation: true } }]);
  assert.deepEqual(stopCalls, ['remote']);
});

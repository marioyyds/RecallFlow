import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeRuntimeAdapter } from '../lib/adapters/chrome/runtime.ts';

test('runtime adapter 把 callback 成功结果转为 Promise', async () => {
  const runtime = {
    lastError: null,
    sendMessage(message, callback) {
      callback({ ok: true, echoed: message.type });
    },
  };
  const port = createChromeRuntimeAdapter({ runtime });
  assert.deepEqual(await port.request({ type: 'ping' }), { ok: true, echoed: 'ping' });
});

test('runtime adapter 归一化 lastError 与同步异常', async () => {
  const withError = createChromeRuntimeAdapter({
    runtime: {
      lastError: { message: '后台不存在' },
      sendMessage(_message, callback) {
        callback(null);
      },
    },
  });
  assert.deepEqual(await withError.request({ type: 'x' }), { ok: false, error: '后台不存在' });

  const throws = createChromeRuntimeAdapter({
    runtime: {
      lastError: null,
      sendMessage() {
        throw new Error('context invalidated');
      },
    },
  });
  assert.deepEqual(await throws.request({ type: 'x' }), { ok: false, error: 'context invalidated' });
});

test('runtime adapter 对空响应给出明确失败', async () => {
  const port = createChromeRuntimeAdapter({
    runtime: {
      lastError: null,
      sendMessage(_message, callback) {
        callback(undefined);
      },
    },
  });
  assert.deepEqual(await port.request({ type: 'x' }), { ok: false, error: '扩展后台无响应' });
});

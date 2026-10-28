import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRunner } from '../lib/application/agent/runner.ts';

test('AgentRunner 以稳定参数边界委派运行实现', async () => {
  const calls = [];
  const runner = createAgentRunner(async (...args) => {
    calls.push(args);
  });
  const port = { postMessage() {}, onMessage: { addListener() {} } };
  const signal = new AbortController().signal;
  const payload = { question: 'test' };
  const settings = { model: 'm' };
  const book = {};
  const observe = () => {};

  await runner.run({ port, payload, settings, book, signal, tabId: 7, observeEvent: observe });
  assert.deepEqual(calls, [[port, payload, settings, book, signal, 7, observe]]);
});

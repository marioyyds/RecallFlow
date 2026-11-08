// 本地 OpenAI 兼容服务可以不需要 API Key；空密钥不能被误判成"模型未配置"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { callDeepSeek } from '../lib/application/agent/llm.ts';
import { streamAgentStep } from '../lib/application/agent/stream-step.ts';
import { shouldVerifyCompletion } from '../lib/application/agent/verification-policy.ts';
import { INTENTS } from '../lib/application/agent/intent-router.ts';
import { chatRequestHeaders, hasChatModelConfig } from '../lib/shared/settings.ts';

const LOCAL_SETTINGS = {
  apiKey: '',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3-coder',
  requestTimeoutMs: 5000,
};

const ORIGINAL_FETCH = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test('空 API Key 是合法的模型配置，请求头不包含空 Bearer', () => {
  assert.equal(hasChatModelConfig(LOCAL_SETTINGS), true);
  assert.equal(hasChatModelConfig({ ...LOCAL_SETTINGS, baseUrl: '' }), false);
  assert.equal(hasChatModelConfig({ ...LOCAL_SETTINGS, model: '  ' }), false);
  assert.deepEqual(chatRequestHeaders(LOCAL_SETTINGS), {
    'Content-Type': 'application/json',
  });
  assert.deepEqual(chatRequestHeaders({ ...LOCAL_SETTINGS, apiKey: '  secret  ' }), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer secret',
  });
});

test('无密钥的本地模型能走非流式调用', async () => {
  let capturedHeaders;
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = init.headers;
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: 'local ok' } }] };
      },
      async text() {
        return '';
      },
    };
  };

  const content = await callDeepSeek(LOCAL_SETTINGS, [{ role: 'user', content: 'hi' }]);
  assert.equal(content, 'local ok');
  assert.equal(Object.prototype.hasOwnProperty.call(capturedHeaders, 'Authorization'), false);
});

test('无密钥的本地模型能走 Agent 流式调用', async () => {
  let capturedHeaders;
  const line = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'stream ok' } }] }) + '\n';
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = init.headers;
    let sent = false;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: new TextEncoder().encode(line) };
            },
          };
        },
      },
    };
  };

  await streamAgentStep(null, LOCAL_SETTINGS, [], undefined, [], () => {});
  assert.equal(Object.prototype.hasOwnProperty.call(capturedHeaders, 'Authorization'), false);
});

test('无密钥但端点和模型已配置时，完成校验仍可用', () => {
  assert.equal(
    shouldVerifyCompletion(INTENTS.BROWSER, 1, { ...LOCAL_SETTINGS, verifierEnabled: true }),
    true
  );
  assert.equal(
    shouldVerifyCompletion(INTENTS.BROWSER, 1, { verifierEnabled: true, apiKey: '' }),
    false,
    '没有模型名与地址时仍应跳过校验'
  );
});

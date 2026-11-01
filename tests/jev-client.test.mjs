import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JevClientError,
  callJevSystemOne,
  jevModelsUrl,
  jevSystemOneUrl,
  listJevModels,
} from '../lib/application/agent/jev-client.ts';
import {
  JevProtocolError,
  parseJevSystemOneResponse,
} from '../lib/application/agent/jev-contract.ts';
import { JEV_SETTINGS_DEFAULTS } from '../lib/shared/settings.ts';

const settings = {
  ...JEV_SETTINGS_DEFAULTS,
  enabled: true,
  apiKey: 'test-secret',
  requestTimeoutMs: 1000,
  maxRetries: 1,
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('TypeSafe URL 使用固定 OpenAPI 路径且拒绝非本机 HTTP', () => {
  assert.equal(jevSystemOneUrl(settings), 'https://api.typesafe.ai/v1/systemone');
  assert.equal(jevModelsUrl(settings), 'https://api.typesafe.ai/v1/models');
  assert.equal(jevModelsUrl({ baseUrl: 'http://localhost:9000/' }), 'http://localhost:9000/v1/models');
  assert.throws(
    () => jevModelsUrl({ baseUrl: 'http://example.com' }),
    (error) => error instanceof JevClientError && error.code === 'CONFIG'
  );
});

test('System One 请求携带认证与结构化问题，并解析 choice 答案', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return response({
      model: 'jev-latest',
      answers: {
        next_action: {
          type: 'choice',
          choice: 'read_table',
          confidence: 0.91,
          probabilities: { read_table: 0.91, escalate: 0.09 },
        },
      },
      usage: { input_tokens: 42, output_tokens: 3 },
    });
  };
  const request = {
    model: 'jev-latest',
    state: { instruction: '读取订单表' },
    questions: {
      next_action: {
        type: 'choice',
        criteria: { read_table: '页面有明显表格', escalate: '需要慢思考' },
      },
    },
  };
  const result = await callJevSystemOne(settings, request, { fetchImpl });

  assert.equal(captured.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer test-secret');
  assert.deepEqual(JSON.parse(captured.init.body), request);
  assert.equal(result.answers.next_action.type, 'choice');
  assert.equal(result.answers.next_action.choice, 'read_table');
});

test('System One 对 5xx 做有限重试', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return response({ detail: 'temporary' }, 503);
    return response({
      model: 'jev-latest',
      answers: { should_escalate: { type: 'noul', noul: 0.2 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  const result = await callJevSystemOne(settings, {
    model: 'jev-latest',
    state: 'state',
    questions: { should_escalate: { type: 'noul' } },
  }, { fetchImpl });
  assert.equal(calls, 2);
  assert.equal(result.answers.should_escalate.noul, 0.2);
});

test('模型列表探测解析 TypeSafe 返回结构', async () => {
  const result = await listJevModels(settings, {
    fetchImpl: async () => response({
      models: [{ name: 'jev-latest', description: 'General', release_date: '2026-09-15' }],
    }),
  });
  assert.equal(result.models[0].name, 'jev-latest');
});

test('协议校验拒绝缺失、越界和类型不匹配的答案', () => {
  assert.throws(
    () => parseJevSystemOneResponse({
      model: 'jev-latest',
      answers: { action: { type: 'choice', choice: 'read_table', confidence: 1.2, probabilities: {} } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    JevProtocolError
  );
  assert.throws(
    () => parseJevSystemOneResponse({
      model: 'jev-latest',
      answers: {},
      usage: { input_tokens: 1, output_tokens: 1 },
    }, { action: { type: 'choice', criteria: { read_table: 'read' } } }),
    JevProtocolError
  );
  assert.throws(
    () => parseJevSystemOneResponse({
      model: 'jev-latest',
      answers: { action: { type: 'noul', noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }, { action: { type: 'choice', criteria: { read_table: 'read' } } }),
    JevProtocolError
  );
});

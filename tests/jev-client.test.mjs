import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JevClientError,
  callJevSystemOne,
  jevAuthorizationHeader,
  jevModelsUrl,
  jevSystemOneUrl,
  listJevModels,
  probeJevConnection,
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

test('JEV URL 兼容完整 systemone 与 compatible-mode 基础地址', () => {
  const endpoint =
    'https://llm-wxhrhq33nuvg2yw6.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone';
  assert.equal(jevSystemOneUrl({ baseUrl: endpoint }), endpoint);
  assert.equal(jevModelsUrl({ baseUrl: endpoint }),
    'https://llm-wxhrhq33nuvg2yw6.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models');
  assert.equal(
    jevSystemOneUrl({
      baseUrl: 'https://llm-wxhrhq33nuvg2yw6.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    }),
    endpoint
  );
  assert.equal(
    jevSystemOneUrl({
      baseUrl: 'https://llm-wxhrhq33nuvg2yw6.cn-beijing.maas.aliyuncs.com/compatible-mode',
    }),
    endpoint
  );
});

test('阿里云 MaaS 使用原始 Authorization，TypeSafe 保持 Bearer', () => {
  const endpoint =
    'https://llm-wxhrhq33nuvg2yw6.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone';
  assert.equal(
    jevAuthorizationHeader({ baseUrl: endpoint, apiKey: 'dashscope-secret' }),
    'dashscope-secret'
  );
  assert.equal(
    jevAuthorizationHeader({
      baseUrl: 'https://api.typesafe.ai',
      apiKey: 'typesafe-secret',
    }),
    'Bearer typesafe-secret'
  );
  assert.equal(
    jevAuthorizationHeader({ baseUrl: endpoint, apiKey: 'Bearer already-prefixed' }),
    'Bearer already-prefixed'
  );
});

test('阿里云 MaaS 完整 systemone 请求原样发送 state/questions 与原始 token', async () => {
  let captured;
  const endpoint =
    'https://llm-wxhrhq33nuvg2yw6.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone';
  const request = {
    model: 'decision-model-preview',
    state: {
      ticket_id: 'T-1001',
      content: '订单支付后超过 24 小时仍未到账',
    },
    questions: {
      department: {
        type: 'choice',
        instructions: '应该由哪个团队处理？',
        criteria: { billing: '支付、退款和账单问题', technical: '产品故障和集成问题' },
      },
      escalate: {
        type: 'noul',
        instructions: '是否需要立即通知值班人员？',
      },
      severity: {
        type: 'score',
        instructions: '这个问题有多严重？',
        criteria: ['轻微', '部分受影响', '核心不可用', '严重业务影响'],
      },
    },
  };
  const result = await callJevSystemOne({
    ...settings,
    baseUrl: endpoint,
    apiKey: 'dashscope-secret',
  }, request, {
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return response({
        model: 'decision-model-preview',
        answers: {
          department: {
            type: 'choice',
            choice: 'billing',
            confidence: 0.96,
          },
          escalate: { type: 'noul', noul: 0.91 },
          severity: {
            type: 'score',
            score: 2,
            confidence: 0.89,
            legend: { 0: '轻微', 1: '部分受影响', 2: '核心不可用', 3: '严重业务影响' },
            probabilities: { 0: 0.02, 1: 0.04, 2: 0.89, 3: 0.05 },
          },
        },
        usage: { input_tokens: 20, output_tokens: 5 },
      });
    },
  });
  assert.equal(captured.url, endpoint);
  assert.equal(captured.init.headers.Authorization, 'dashscope-secret');
  assert.deepEqual(JSON.parse(captured.init.body), request);
  assert.equal(result.answers.department.choice, 'billing');
  assert.equal(result.answers.escalate.noul, 0.91);
  assert.equal(result.answers.severity.score, 2);
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

test('451 区域限制给出独立错误码且不重试', async () => {
  let calls = 0;
  await assert.rejects(
    () => callJevSystemOne(settings, {
      model: 'jev-latest',
      state: 'state',
      questions: { ok: { type: 'noul' } },
    }, {
      fetchImpl: async () => {
        calls += 1;
        return response({ title: 'Typesafe is not available in your region.' }, 451);
      },
    }),
    (error) => error instanceof JevClientError && error.code === 'REGION_BLOCKED'
  );
  assert.equal(calls, 1);
});

test('模型列表探测解析 TypeSafe 返回结构', async () => {
  const result = await listJevModels(settings, {
    fetchImpl: async () => response({
      models: [{ name: 'jev-latest', description: 'General', release_date: '2026-09-15' }],
    }),
  });
  assert.equal(result.models[0].name, 'jev-latest');
});

test('模型列表兼容 OpenAI/MaaS 的 data[].id 结构', async () => {
  let authorization = '';
  const result = await listJevModels({
    ...settings,
    baseUrl:
      'https://llm-wxhrhq33nuvg2yw6.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone',
  }, {
    fetchImpl: async (_url, init) => {
      authorization = init.headers.Authorization;
      return response({
        object: 'list',
        data: [{ id: 'decision-model-preview', owned_by: 'aliyun' }],
      });
    },
  });
  assert.equal(authorization, 'test-secret');
  assert.equal(result.models[0].name, 'decision-model-preview');
});

test('专用 systemone 模型不在通用目录时，用最小探测确认实际可用', async () => {
  const calls = [];
  const endpoint =
    'https://llm-wxhrhq33nuvg2yw6.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone';
  const probe = await probeJevConnection({
    ...settings,
    baseUrl: endpoint,
    apiKey: 'dashscope-secret',
    model: 'decision-model-preview',
  }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, authorization: init.headers.Authorization });
      if (url.endsWith('/models')) {
        return response({
          object: 'list',
          data: [{ id: 'kimi-k3.1-pro' }, { id: 'qwen3.8-max' }],
        });
      }
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'decision-model-preview');
      assert.equal(body.questions.reachable.type, 'noul');
      return response({
        model: 'decision-model-preview',
        answers: { reachable: { type: 'noul', noul: 0.99 } },
        usage: { input_tokens: 4, output_tokens: 1 },
      });
    },
  });
  assert.equal(probe.modelListed, false);
  assert.equal(probe.systemOneVerified, true);
  assert.deepEqual(calls.map((item) => item.method), ['GET', 'POST']);
  assert.equal(calls[1].url, endpoint);
  assert.equal(calls[1].authorization, 'dashscope-secret');
});

test('目录已列出当前模型时连接探测不再额外调用 systemone', async () => {
  let calls = 0;
  const probe = await probeJevConnection({
    ...settings,
    model: 'qwen3.8-max',
  }, {
    fetchImpl: async () => {
      calls += 1;
      return response({
        object: 'list',
        data: [{ id: 'qwen3.8-max' }],
      });
    },
  });
  assert.equal(probe.modelListed, true);
  assert.equal(probe.systemOneVerified, false);
  assert.equal(calls, 1);
});

test('协议校验拒绝缺失、越界和类型不匹配的答案', () => {
  assert.throws(
    () => parseJevSystemOneResponse({
      model: 'jev-latest',
      answers: { action: { type: 'choice', choice: 'read_table', confidence: 1.2 } },
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

test('System One usage 兼容数字字符串、OpenAI 字段名与省略 usage', () => {
  const questions = { ok: { type: 'noul' } };
  const stringly = parseJevSystemOneResponse({
    model: 'decision-model-preview',
    answers: { ok: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: '12', output_tokens: '3' },
  }, questions);
  assert.deepEqual(stringly.usage, { input_tokens: 12, output_tokens: 3 });

  const openai = parseJevSystemOneResponse({
    model: 'decision-model-preview',
    answers: { ok: { type: 'noul', noul: 0.9 } },
    usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
  }, questions);
  assert.deepEqual(openai.usage, { input_tokens: 20, output_tokens: 4 });

  const missing = parseJevSystemOneResponse({
    model: 'decision-model-preview',
    answers: { ok: { type: 'noul', noul: 0.9 } },
  }, questions);
  assert.deepEqual(missing.usage, { input_tokens: 0, output_tokens: 0 });

  assert.throws(
    () => parseJevSystemOneResponse({
      model: 'decision-model-preview',
      answers: { ok: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: '12.5', output_tokens: 3 },
    }, questions),
    (error) =>
      error instanceof JevProtocolError &&
      error.message.includes('必须是非负整数')
  );
});

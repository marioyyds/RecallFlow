// streamAgentStep 的重试 / 超时 / 中断语义（用假 fetch 验证）。
// 这段逻辑涉及「何时可以重试」「停止能否立刻生效」，最容易在重构中退化。
import test from 'node:test';
import assert from 'node:assert/strict';

import { streamAgentStep } from '../lib/assistant/agent.js';

const SETTINGS = { baseUrl: 'https://api.example.com', model: 'm', apiKey: 'k', requestTimeoutMs: 5000 };
const ORIGINAL_FETCH = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// 构造一个 SSE 响应；opts.signal 用于模拟「中断会让读取失败」的真实行为。
function sseResponse(lines, opts = {}) {
  let i = 0;
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            const sig = opts.signal;
            return new Promise((resolve, reject) => {
              const fail = () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              };
              if (sig && sig.aborted) return fail();
              if (sig) sig.addEventListener('abort', fail, { once: true });
              if (i >= lines.length) return resolve({ done: true, value: undefined });
              resolve({ done: false, value: enc.encode(lines[i++] + '\n') });
            });
          },
        };
      },
    },
    async json() {
      return {};
    },
    async text() {
      return '';
    },
  };
}

function errorResponse(status, message) {
  return {
    ok: false,
    status,
    async json() {
      return { error: { message } };
    },
    async text() {
      return message;
    },
  };
}

const contentLines = (...texts) => [
  ...texts.map((t) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] })),
  'data: [DONE]',
];

// ---------------------------------------------------------------- 分阶段计时

test('streamAgentStep: 返回 ttfb / prefill / decode 分段计时', async () => {
  globalThis.fetch = async () => {
    // 模拟真实 SSE：响应头先到（这段是网络+排队），首 token 再晚一点到（这段才是 prefill）
    await new Promise((r) => setTimeout(r, 40));
    return sseResponse(contentLines('你好', '世界'));
  };
  const out = await streamAgentStep(null, SETTINGS, [], undefined, [], () => {});
  assert.ok(out.timing, '必须返回 timing —— 没有它就只能靠猜「慢在哪一段」');
  for (const k of ['ttfbMs', 'prefillMs', 'decodeMs', 'totalMs']) {
    assert.equal(typeof out.timing[k], 'number', k + ' 应为数字');
  }
  assert.ok(out.timing.ttfbMs >= 30, '到响应头的等待必须计入 ttfb，实际 ' + out.timing.ttfbMs);
  assert.ok(out.timing.totalMs >= out.timing.ttfbMs);
  assert.ok(out.timing.ttfbMs + out.timing.prefillMs + out.timing.decodeMs <= out.timing.totalMs + 5);
});

test('streamAgentStep: 只有工具调用的轮次也算出 prefill 分界点', async () => {
  globalThis.fetch = async () => {
    await new Promise((r) => setTimeout(r, 30));
    return sseResponse([
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'f', arguments: '{}' } }] } }] }),
      'data: [DONE]',
    ]);
  };
  const out = await streamAgentStep(null, SETTINGS, [], undefined, [], () => {});
  assert.equal(out.toolCalls.length, 1);
  assert.ok(out.timing.ttfbMs >= 20, '工具调用分片同样标志 prefill 结束');
});

// ---------------------------------------------------------------- 重试

test('streamAgentStep: 5xx 会重试，随后成功则正常返回', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) return errorResponse(500, 'server boom');
    return sseResponse(contentLines('ok'));
  };
  const out = await streamAgentStep(null, SETTINGS, [], undefined, [], () => {});
  assert.equal(calls, 3, 'MAX_RETRIES=2 → 最多 3 次请求');
  assert.equal(out.assistantMessage.content, 'ok');
  assert.equal(out.error, undefined);
});

test('streamAgentStep: 网络错误（无 status）会重试', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return sseResponse(contentLines('recovered'));
  };
  const out = await streamAgentStep(null, SETTINGS, [], undefined, [], () => {});
  assert.equal(calls, 2);
  assert.equal(out.assistantMessage.content, 'recovered');
});

test('streamAgentStep: 429 会重试', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return errorResponse(429, 'rate limited');
    return sseResponse(contentLines('ok'));
  };
  const out = await streamAgentStep(null, SETTINGS, [], undefined, [], () => {});
  assert.equal(calls, 2);
  assert.equal(out.assistantMessage.content, 'ok');
});

test('streamAgentStep: 4xx（非 429）不重试，直接返回错误详情', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return errorResponse(400, 'bad request');
  };
  const out = await streamAgentStep(null, SETTINGS, [], undefined, [], () => {});
  assert.equal(calls, 1, '400 不应重试');
  assert.ok(out.error.includes('400'), out.error);
  assert.ok(out.error.includes('bad request'), out.error);
});

// 400 一定是「请求本身有问题」，但服务端常常不给原因（实测会返回空响应体），
// 于是错误信息在冒号后面空着，完全没法定位。这里把「请求形状」补进错误信息 ——
// 只有角色序列与计数，不含任何消息内容，可以安全地显示给用户。
test('streamAgentStep: 400 且响应体为空时，错误信息带上请求形状', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    async json() {
      throw new Error('empty body');
    },
    async text() {
      return '';
    },
  });
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'r' },
  ];
  const tools = [{ type: 'function', function: { name: 'f' } }];
  const out = await streamAgentStep(null, SETTINGS, messages, undefined, tools, () => {});
  assert.ok(out.error.includes('请求形状'), out.error);
  assert.ok(out.error.includes('messages=4'), out.error);
  assert.ok(out.error.includes('system,user,asst(tc),tool'), '角色序列要能看出 tool 配对形态：' + out.error);
  assert.ok(out.error.includes('tools=1'), out.error);
  assert.ok(out.error.includes('tool_choice=auto'), out.error);
  assert.ok(!out.error.includes('"content"'), '只报形状，不报内容');
});

test('streamAgentStep: 非 400 的错误不附加请求形状（信息保持精简）', async () => {
  globalThis.fetch = async () => errorResponse(500, 'server boom');
  const out = await streamAgentStep(null, SETTINGS, [{ role: 'user', content: 'x' }], undefined, [], () => {});
  assert.ok(!out.error.includes('请求形状'), out.error);
});

test('streamAgentStep: 重试耗尽后返回最后一次的错误', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return errorResponse(503, 'unavailable');
  };
  const out = await streamAgentStep(null, SETTINGS, [], undefined, [], () => {});
  assert.equal(calls, 3);
  assert.ok(out.error.includes('503'), out.error);
});

// ---------------------------------------------------------------- 超时

test('streamAgentStep: 超时按 requestTimeoutMs 报告，而非硬编码 60 秒', async () => {
  globalThis.fetch = (url, opts) =>
    new Promise((resolve, reject) => {
      const sig = opts && opts.signal;
      const fail = () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (sig) sig.addEventListener('abort', fail, { once: true });
    });
  const out = await streamAgentStep(
    null,
    Object.assign({}, SETTINGS, { requestTimeoutMs: 120 }),
    [],
    undefined,
    [],
    () => {}
  );
  assert.ok(out.error.includes('超时'), out.error);
  assert.ok(!out.error.includes('60 秒'), '不应再出现硬编码的 60 秒：' + out.error);
});

// ---------------------------------------------------------------- 解析

test('streamAgentStep: content 流式转发并累积，usage 原样返回', async () => {
  const events = [];
  const lines = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '你' } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '好' } }] }),
    'data: ' + JSON.stringify({ usage: { total_tokens: 42, prompt_tokens: 10, completion_tokens: 5 } }),
    'data: [DONE]',
  ];
  globalThis.fetch = async () => sseResponse(lines);
  const out = await streamAgentStep(null, SETTINGS, [], undefined, [], (e) => events.push(e));
  assert.equal(out.assistantMessage.content, '你好');
  assert.equal(out.usage.total_tokens, 42);
  assert.equal(events.filter((e) => e.type === 'chunk').length, 2);
});

test('streamAgentStep: tool_calls 分片增量拼接成完整参数', async () => {
  const lines = [
    'data: ' +
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'click_element', arguments: '{"sel' } }] } },
        ],
      }),
    'data: ' +
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ector":"#a"}' } }] } }],
      }),
    'data: [DONE]',
  ];
  globalThis.fetch = async () => sseResponse(lines);
  const out = await streamAgentStep(null, SETTINGS, [], undefined, [], () => {});
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].name, 'click_element');
  assert.equal(out.toolCalls[0].id, 'c1');
  assert.deepEqual(out.toolCalls[0].args, { selector: '#a' });
  assert.equal(out.assistantMessage.tool_calls.length, 1);
});

test('streamAgentStep: 空工具集不附带 tools 字段（避免 API 400）', async () => {
  let seenBody = null;
  globalThis.fetch = async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return sseResponse(contentLines('ok'));
  };
  await streamAgentStep(null, SETTINGS, [], undefined, [], () => {});
  assert.equal(seenBody.tools, undefined);
  assert.equal(seenBody.tool_choice, undefined);
});

test('streamAgentStep: 有工具时附带 tools 与 tool_choice', async () => {
  let seenBody = null;
  globalThis.fetch = async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return sseResponse(contentLines('ok'));
  };
  const tools = [{ type: 'function', function: { name: 'x' } }];
  await streamAgentStep(null, SETTINGS, [], undefined, tools, () => {});
  assert.equal(seenBody.tools.length, 1);
  assert.equal(seenBody.tool_choice, 'auto');
});

test("streamAgentStep: toolChoice='none' 时仍然发出完整 tools（保住前缀缓存，只禁调用）", async () => {
  let seenBody = null;
  globalThis.fetch = async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return sseResponse(contentLines('ok'));
  };
  const tools = [{ type: 'function', function: { name: 'x' } }];
  await streamAgentStep(null, SETTINGS, [], undefined, tools, () => {}, 'none');
  // 收尾请求必须与前几轮逐字节一致才可能命中前缀缓存，所以 tools 照发不误
  assert.equal(seenBody.tools.length, 1, 'tools 必须照发，否则请求从 token 0 就变了');
  assert.equal(seenBody.tool_choice, 'none', '用 tool_choice 禁止调用，而不是删掉 tools');
});

// ---------------------------------------------------------------- 中断

test('streamAgentStep: 流式期间的「停止」能立刻中止，不必读完整个流', async () => {
  const ctrl = new AbortController();
  // 造一个很长的流：若中断无效，会一直读下去。
  const many = [];
  for (let i = 0; i < 500; i++) many.push('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }] }));
  many.push('data: [DONE]');
  globalThis.fetch = async (url, opts) => sseResponse(many, { signal: opts && opts.signal });

  let chunks = 0;
  await assert.rejects(
    () =>
      streamAgentStep(null, SETTINGS, [], ctrl.signal, [], (e) => {
        if (e.type === 'chunk') {
          chunks += 1;
          if (chunks === 1) ctrl.abort(); // 第一个分片后立刻停止
        }
      }),
    (e) => e && e.name === 'AbortError'
  );
  assert.equal(chunks, 1, '中断后不应继续产出分片');
});

// MCP 客户端行为门禁（TITA-12）。
//
// 每一条用例都对着一个真实的失败现场，而且**在旧实现上必须是红的**：
//   · 握手缺 notifications/initialized → 严格服务端列不出工具；
//   · 缓存键只按 url → 改了 token 5 分钟内不生效；
//   · 401/403 只报状态码 → 模型把它猜成「端口冲突 / 登录页 / 我没这个能力」；
//   · `_origName` 随工具一起发给 provider；
//   · 连接失败被 logError 吞掉 → 模型只能说「我没有 MCP」。
// 这里的 mock 全部走真实 fetch 接缝（替换 globalThis.fetch），不测私有函数。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectAgentTools,
  executeAnyTool,
  probeMcpServer,
  buildMcpStatusSection,
  mcpCacheKey,
  mcpToolPrefix,
} from '../lib/application/agent/mcp.ts';
import { detectIntent, resolveIntent } from '../lib/application/agent/intent-router.ts';

const REAL_FETCH = globalThis.fetch;

function jsonResponse(status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  const headers = Object.assign({ 'content-type': 'application/json' }, extraHeaders || {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name || '').toLowerCase();
        for (const k of Object.keys(headers)) if (k.toLowerCase() === key) return headers[k];
        return null;
      },
    },
    text: async () => payload,
    json: async () => body,
  };
}

/**
 * 一台可控的 MCP 服务器。
 * @param {Object} [opts]
 * @param {boolean} [opts.requireInitialized] - 收到 notifications/initialized 之前拒绝 tools/list
 * @param {number} [opts.authStatus] - 鉴权失败时返回的 HTTP 状态码
 * @param {string} [opts.acceptToken] - 只接受这个 Bearer Token
 */
function mockMcpServer(opts = {}) {
  const calls = [];
  let initialized = false;
  let sessionId = null;
  const tools = opts.tools || [
    { name: 'get_active_file', description: '读取当前打开的笔记', inputSchema: { type: 'object', properties: {} } },
  ];
  return {
    calls,
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      calls.push({ method: body.method, hasId: Object.prototype.hasOwnProperty.call(body, 'id') });
      if (opts.acceptToken && String(init.headers.Authorization || '') !== 'Bearer ' + opts.acceptToken) {
        return jsonResponse(opts.authStatus || 401, { error: 'unauthorized' });
      }
      if (body.method === 'initialize') {
        sessionId = 'sess-mock';
        return jsonResponse(200, { jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'mock' } } }, {
          'mcp-session-id': sessionId,
        });
      }
      if (body.method === 'notifications/initialized') {
        initialized = true;
        // 通知没有响应体：空 body 也不该被当成错误解析。
        return jsonResponse(202, {});
      }
      if (body.method === 'tools/list') {
        if (opts.requireInitialized !== false && !initialized) {
          return jsonResponse(200, { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'server not initialized' } });
        }
        return jsonResponse(200, { jsonrpc: '2.0', id: body.id, result: { tools } });
      }
      if (body.method === 'tools/call') {
        calls[calls.length - 1].toolName = body.params && body.params.name;
        return jsonResponse(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '笔记正文' }] } });
      }
      return jsonResponse(200, { jsonrpc: '2.0', id: body.id, result: {} });
    },
  };
}

/** 在用例内替换 fetch，结束后还原（避免污染其它用例）。 */
async function withServer(server, fn) {
  globalThis.fetch = (url, init) => server.fetch(url, init);
  try {
    return await fn();
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
}

test('mcp: 握手必须补发 notifications/initialized（严格服务端否则拒绝 tools/list）', async () => {
  const server = mockMcpServer({ requireInitialized: true });
  await withServer(server, async () => {
    const r = await collectAgentTools(
      { mcpServers: [{ id: 'obs', url: 'http://127.0.0.1:27123/mcp', headers: {} }] },
      { includeMcp: true }
    );
    const names = r.tools.map((t) => t.function && t.function.name);
    assert.ok(names.includes('mcp__obs__get_active_file'), names.join(','));
    const order = server.calls.map((c) => c.method);
    assert.ok(order.includes('notifications/initialized'), order.join(' → '));
    assert.ok(
      order.indexOf('notifications/initialized') < order.indexOf('tools/list'),
      '通知必须早于 tools/list：' + order.join(' → ')
    );
    // 通知没有 id，否则严格服务端会当成一次普通 RPC 请求。
    const notified = server.calls.find((c) => c.method === 'notifications/initialized');
    assert.equal(notified.hasId, false);
  });
});

test('mcp: 同一 url 换了 headers 必须重新握手（缓存键只含 url 时旧 token 会被一直复用）', async () => {
  const server = mockMcpServer({ requireInitialized: true, acceptToken: 'token-b', authStatus: 401 });
  const url = 'http://127.0.0.1:27123/mcp';
  await withServer(server, async () => {
    // 第一次用错 token：握手就该失败（而不是复用上一次成功的 client 假装连上）。
    const bad = await collectAgentTools({ mcpServers: [{ id: 'obs', url, headers: { Authorization: 'Bearer token-a' } }] }, {});
    assert.equal(bad.mcpStatus[0].ok, false);
    assert.equal(bad.mcpStatus[0].status, 401);
    // 换成正确 token：必须真的重新握手并拿到工具。
    server.calls.length = 0;
    const good = await collectAgentTools({ mcpServers: [{ id: 'obs', url, headers: { Authorization: 'Bearer token-b' } }] }, {});
    assert.equal(good.mcpStatus[0].ok, true, JSON.stringify(good.mcpStatus));
    assert.ok(
      server.calls.some((c) => c.method === 'initialize'),
      '换 headers 后必须重新 initialize：' + server.calls.map((c) => c.method).join(',')
    );
    const names = good.tools.map((t) => t.function.name);
    assert.ok(names.includes('mcp__obs__get_active_file'), names.join(','));
  });
});

test('mcp: 缓存键随 url / id / headers 变化', () => {
  const base = { id: 'obs', url: 'http://h/mcp', headers: { Authorization: 'Bearer a' } };
  assert.equal(mcpCacheKey(base), mcpCacheKey({ id: 'obs', url: 'http://h/mcp', headers: { Authorization: 'Bearer a' } }));
  assert.notEqual(mcpCacheKey(base), mcpCacheKey({ ...base, headers: { Authorization: 'Bearer b' } }));
  assert.notEqual(mcpCacheKey(base), mcpCacheKey({ ...base, id: 'other' }));
  assert.notEqual(mcpCacheKey(base), mcpCacheKey({ ...base, url: 'http://h2/mcp' }));
  // headers 顺序不同不影响键
  assert.equal(
    mcpCacheKey({ url: 'http://h/mcp', headers: { b: '2', a: '1' } }),
    mcpCacheKey({ url: 'http://h/mcp', headers: { a: '1', b: '2' } })
  );
});

test('mcp: 401/403 的失败原因要指出 Bearer Token，且绝不能拼出 /login', async () => {
  const server = mockMcpServer({ authStatus: 403, acceptToken: 'real' });
  await withServer(server, async () => {
    for (const status of [401, 403]) {
      const srv = mockMcpServer({ authStatus: status, acceptToken: 'real' });
      globalThis.fetch = (url, init) => srv.fetch(url, init);
      const r = await collectAgentTools(
        { mcpServers: [{ id: 'obs', url: 'http://127.0.0.1:27123/mcp', headers: { Authorization: 'Bearer wrong' } }] },
        {}
      );
      const st = r.mcpStatus[0];
      assert.equal(st.ok, false);
      assert.equal(st.status, status);
      assert.match(st.error, /Bearer Token|鉴权/);
      assert.ok(!st.error.includes('/login'), 'MCP 端点没有登录页：' + st.error);
      // token 本身不能出现在任何对外文案里
      assert.ok(!st.error.includes('real'), '失败文案不得回显服务端 token');
    }
  });
});

test('mcp: 发给 provider 的 tools 只含 schema 字段（_origName 只留在 mcpIndex）', async () => {
  const server = mockMcpServer({ requireInitialized: true });
  await withServer(server, async () => {
    const r = await collectAgentTools(
      { mcpServers: [{ id: 'obs', url: 'http://127.0.0.1:27123/mcp', headers: {} }] },
      {}
    );
    const mcpTool = r.tools.find((t) => t.function && t.function.name === 'mcp__obs__get_active_file');
    assert.ok(mcpTool);
    assert.deepEqual(Object.keys(mcpTool).sort(), ['function', 'type']);
    assert.deepEqual(Object.keys(mcpTool.function).sort(), ['description', 'name', 'parameters']);
    assert.ok(!('_origName' in mcpTool));
    // 原工具名仍然可用：分发时要用它去调服务端。
    assert.equal(r.mcpIndex.get('mcp__obs__get_active_file').origName, 'get_active_file');
  });
});

test('mcp: 分发时用 mcpIndex 里的原工具名调用服务端', async () => {
  const server = mockMcpServer({ requireInitialized: true });
  await withServer(server, async () => {
    const r = await collectAgentTools(
      { mcpServers: [{ id: 'obs', url: 'http://127.0.0.1:27123/mcp', headers: {} }] },
      {}
    );
    const out = await executeAnyTool('mcp__obs__get_active_file', {}, { mcpIndex: r.mcpIndex, mcpStatus: r.mcpStatus });
    assert.equal(out.result, '笔记正文');
    const call = server.calls.filter((c) => c.method === 'tools/call').pop();
    assert.equal(call.toolName, 'get_active_file');
  });
});

test('mcp: 连接失败不再被静默吞掉 —— collectAgentTools 返回每台服务器的状态', async () => {
  const server = mockMcpServer({ authStatus: 401, acceptToken: 'real' });
  await withServer(server, async () => {
    const r = await collectAgentTools(
      { mcpServers: [{ id: 'obs', url: 'http://127.0.0.1:27123/mcp', headers: { Authorization: 'Bearer x' } }] },
      {}
    );
    assert.equal(r.mcpStatus.length, 1);
    const st = r.mcpStatus[0];
    assert.deepEqual(Object.keys(st).sort(), ['error', 'ok', 'serverId', 'status', 'url']);
    assert.equal(st.serverId, 'obs');
    assert.equal(st.ok, false);
    assert.ok(st.error.length > 0);
    // 状态里不能带任何凭据
    assert.ok(!('headers' in st));
  });
});

test('mcp: 失败摘要要阻止模型说「我没有 MCP」', () => {
  const section = buildMcpStatusSection([
    { serverId: 'obs', url: 'http://127.0.0.1:27123/mcp', ok: false, status: 403, error: 'MCP initialize 失败（HTTP 403）：鉴权被拒绝。' },
  ]);
  assert.match(section, /已配置但本次连接失败/);
  assert.match(section, /不要说/);
  assert.match(section, /mcp__<serverId>__<工具名>/);
  const okSection = buildMcpStatusSection([
    { serverId: 'obs', url: 'http://127.0.0.1:27123/mcp', ok: true, toolCount: 17 },
  ]);
  assert.match(okSection, /已连接，提供 17 个工具/);
  assert.equal(buildMcpStatusSection([]), '');
});

test('mcp: 服务器连不上时，「未知 MCP 工具」要说出真实原因', async () => {
  const server = mockMcpServer({ authStatus: 401, acceptToken: 'real' });
  await withServer(server, async () => {
    const r = await collectAgentTools(
      { mcpServers: [{ id: 'obs', url: 'http://127.0.0.1:27123/mcp', headers: { Authorization: 'Bearer x' } }] },
      {}
    );
    const out = await executeAnyTool('mcp__obs__get_active_file', {}, { mcpIndex: r.mcpIndex, mcpStatus: r.mcpStatus });
    assert.match(String(out.result), /服务器「obs」本次连接失败/);
  });
});

test('mcp: 普通对话（CHAT）意图也要带上已配置的 MCP 工具', async () => {
  const detected = detectIntent('你有可用的mcp吗？');
  const info = resolveIntent(detected.intent);
  assert.equal(detected.includeMcp, true, 'CHAT 必须加载 MCP，否则模型只能回答"我没有 MCP"');
  assert.equal(info.includeMcp, true);
  const server = mockMcpServer({ requireInitialized: true });
  await withServer(server, async () => {
    // 完全按 agent.js 的调用方式收集（allowedTools + includeMcp 都来自意图定义）。
    const r = await collectAgentTools(
      { mcpServers: [{ id: 'obsidian', url: 'http://127.0.0.1:27123/mcp', headers: {} }] },
      { allowedTools: info.allowedTools, includeMcp: info.includeMcp }
    );
    const mcpNames = r.tools.map((t) => t.function.name).filter((n) => n.startsWith('mcp__'));
    assert.ok(mcpNames.includes('mcp__obsidian__get_active_file'), mcpNames.join(','));
  });
});

test('mcp: 「用 Obsidian 读一下当前笔记」这类指令也要加载 MCP', async () => {
  const detected = detectIntent('用 Obsidian 读一下当前笔记');
  const info = resolveIntent(detected.intent);
  assert.equal(detected.includeMcp, true);
  assert.equal(info.includeMcp, true);
  const server = mockMcpServer({ requireInitialized: true });
  await withServer(server, async () => {
    const r = await collectAgentTools(
      { mcpServers: [{ id: 'obsidian', url: 'http://127.0.0.1:27123/mcp', headers: {} }] },
      { allowedTools: info.allowedTools, includeMcp: info.includeMcp }
    );
    const mcpNames = r.tools.map((t) => t.function.name).filter((n) => n.startsWith('mcp__'));
    assert.ok(mcpNames.length > 0, mcpNames.join(','));
  });
});

test('mcp: BROWSER / KNOWLEDGE / RESEARCH 意图同样带 MCP', () => {
  for (const q of ['打开百度搜索今天的热搜', '我的收藏里有没有 nginx 的笔记', '帮我总结这篇论文']) {
    const detected = detectIntent(q);
    assert.equal(detected.includeMcp, true, q);
    assert.equal(resolveIntent(detected.intent).includeMcp, true, q);
  }
});

test('mcp: 带空格的 serverId 也要拼出 provider 接受的工具名', async () => {
  // 本机真实配置的 id 就是 "Obsidian MCP Server"：照原样拼进 name 会让整单 tools 被拒。
  assert.equal(mcpToolPrefix('Obsidian MCP Server'), 'mcp__Obsidian_MCP_Server__');
  const server = mockMcpServer({ requireInitialized: true });
  await withServer(server, async () => {
    const r = await collectAgentTools(
      { mcpServers: [{ id: 'Obsidian MCP Server', url: 'http://127.0.0.1:27123/mcp', headers: {} }] },
      {}
    );
    const names = r.tools.map((t) => t.function.name).filter((n) => n.startsWith('mcp__'));
    assert.ok(names.includes('mcp__Obsidian_MCP_Server__get_active_file'), names.join(','));
    for (const n of names) assert.match(n, /^mcp__[A-Za-z0-9_-]+$/, n);
    // 前缀换了，但分发到服务端的仍是原工具名。
    const out = await executeAnyTool('mcp__Obsidian_MCP_Server__get_active_file', {}, { mcpIndex: r.mcpIndex, mcpStatus: r.mcpStatus });
    assert.equal(out.result, '笔记正文');
    const call = server.calls.filter((c) => c.method === 'tools/call').pop();
    assert.equal(call.toolName, 'get_active_file');
  });
});

test('mcp: probeMcpServer 返回结果状态且不抛异常', async () => {
  const okServer = mockMcpServer({ requireInitialized: true });
  await withServer(okServer, async () => {
    const st = await probeMcpServer({ id: 'obs', url: 'http://h/mcp', headers: {} });
    assert.equal(st.ok, true);
    assert.equal(st.toolCount, 1);
    assert.equal(typeof st.ms, 'number');
  });
  const badServer = mockMcpServer({ authStatus: 403, acceptToken: 'real' });
  await withServer(badServer, async () => {
    const st = await probeMcpServer({ id: 'obs', url: 'http://h/mcp', headers: { Authorization: 'Bearer wrong' } });
    assert.equal(st.ok, false);
    assert.equal(st.status, 403);
    assert.match(st.error, /Bearer Token|鉴权/);
  });
  const empty = await probeMcpServer({ id: 'obs', url: '', headers: {} });
  assert.equal(empty.ok, false);
});

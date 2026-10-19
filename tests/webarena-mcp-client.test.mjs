// MCP HTTP 桥接客户端（integrations/webarena/mcp-client.mjs）的行为测试。
//
// 用一个**本地假桥接**起真实 HTTP 服务来测：协议事实（会话头、tools/call 的 JSON 文本、
// agent_task_status 的 running 语义）都在这一层，用桩函数替掉就没意义了。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { McpBridgeClient, BridgeError } from '../integrations/webarena/mcp-client.mjs';

function startFakeBridge() {
  const state = { statusCalls: 0, calls: [] };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ pid: 123, ws: true }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      if (msg.method === 'initialize') {
        res.setHeader('mcp-session-id', 'sess-1');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (msg.method === 'tools/list') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'agent_task' }] } }));
        return;
      }
      if (msg.method === 'tools/call') {
        state.calls.push(msg.params);
        const name = msg.params.name;
        let payload = { ok: true };
        if (name === 'open_tab') payload = { ok: true, tabId: 5 };
        else if (name === 'agent_task') payload = { ok: true, jobId: 'job-1' };
        else if (name === 'agent_task_status') {
          state.statusCalls += 1;
          payload =
            state.statusCalls < 2
              ? { running: true, state: 'running', seq: 1, events: [] }
              : { running: false, state: 'completed', seq: 2, events: [], result: '```json\n{"task_type":"retrieve","status":"SUCCESS","retrieved_data":["x"]}\n```' };
        }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

test('McpBridgeClient：health / connect / listTools', async () => {
  const { server, port } = await startFakeBridge();
  const client = new McpBridgeClient({ host: '127.0.0.1', port });
  try {
    const h = await client.health();
    assert.equal(h.ws, true);
    await client.connect();
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['agent_task']);
  } finally {
    server.close();
  }
});

test('McpBridgeClient：openTab / startAgentTask 传参与返回', async () => {
  const { server, port, state } = await startFakeBridge();
  const client = new McpBridgeClient({ host: '127.0.0.1', port });
  try {
    const opened = await client.openTab('http://localhost:7770/');
    assert.equal(opened.tabId, 5);
    const started = await client.startAgentTask({ instruction: 'x', allowRisk: ['read', 'page'], tabId: 5 });
    assert.equal(started.jobId, 'job-1');
    const task = state.calls.find((c) => c.name === 'agent_task');
    assert.deepEqual(task.arguments.allowRisk, ['read', 'page']);
    assert.equal(task.arguments.tabId, 5);
  } finally {
    server.close();
  }
});

test('McpBridgeClient：waitForJob 轮询到终态并拿到结果', async () => {
  const { server, port } = await startFakeBridge();
  const client = new McpBridgeClient({ host: '127.0.0.1', port });
  try {
    await client.connect();
    const fin = await client.waitForJob('job-1', { pollMs: 10, timeoutMs: 2000 });
    assert.equal(fin.running, false);
    assert.equal(fin.state, 'completed');
    assert.match(fin.result, /retrieved_data/);
  } finally {
    server.close();
  }
});

test('McpBridgeClient：waitForExtension 在 ws=true 时立即返回', async () => {
  const { server, port } = await startFakeBridge();
  const client = new McpBridgeClient({ host: '127.0.0.1', port });
  try {
    const h = await client.waitForExtension(1000, 20);
    assert.equal(h.ws, true);
  } finally {
    server.close();
  }
});

test('McpBridgeClient：服务不在时 health 返回 up:false，waitForExtension 抛错', async () => {
  const client = new McpBridgeClient({ host: '127.0.0.1', port: 1 });
  const h = await client.health(500);
  assert.equal(h.up, false);
  await assert.rejects(() => client.waitForExtension(300, 50), (e) => e instanceof BridgeError && e.code === 'NO_EXTENSION');
});

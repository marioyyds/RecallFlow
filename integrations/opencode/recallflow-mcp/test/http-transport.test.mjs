// MCP over Streamable HTTP 集成测试：真实启动 server 子进程并走完整 HTTP 握手。
// 覆盖多客户端会话隔离，以及两条安全边界（鉴权头 + Host 校验）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'index.js');
const TOKEN = 'test-token-abcdef123456';

// 必需的工具集合。刻意不硬编码总数：新增工具是正常演进，
// 但「必需工具缺失」必须被发现——因此校验集合而非计数。
const REQUIRED_TOOLS = [
  'browser_read',
  'evidence_get',
  'read_console',
  'read_network',
  'page_health',
  'verify_change',
  'recallflow_session',
  'get_element_source',
  'get_picked_element',
  'dev_session_get',
  'dev_session_set',
];

let child = null;
let httpPort = 0;
let stdioChild = null;
let stdioPort = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// 用 node:http 直接发请求：必须能自定义 Host 头才能验证 rebinding 防护。
function rawRequest(port, { method = 'POST', reqPath = '/mcp', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function mcpHeaders(extra = {}) {
  return Object.assign(
    {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer ' + TOKEN,
    },
    extra
  );
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

async function waitReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await rawRequest(port, { method: 'GET', reqPath: '/health', headers: {} });
      if (r.status === 200) return;
    } catch (e) {
      /* 尚未监听 */
    }
    if (Date.now() > deadline) throw new Error('服务器未在超时内就绪（port=' + port + '）');
    await new Promise((r) => setTimeout(r, 150));
  }
}

// 必须等子进程真正退出，否则会留下占端口的孤儿进程。
async function stopChild(c) {
  if (!c) return;
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    c.once('exit', done);
    try {
      c.kill();
    } catch (e) {
      done();
    }
    setTimeout(() => {
      try {
        c.kill('SIGKILL');
      } catch (e) {}
      done();
    }, 4000);
  });
}

async function openSession(port = httpPort) {
  const init = await rawRequest(port, { headers: mcpHeaders(), body: INIT });
  const sid = init.headers['mcp-session-id'];
  if (!sid) throw new Error('未取得会话 ID: ' + init.status + ' ' + init.body);
  // 通知类消息无 id，服务端不回 body
  await rawRequest(port, {
    headers: mcpHeaders({ 'mcp-session-id': sid }),
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  return sid;
}

test.before(async () => {
  httpPort = await freePort();
  child = spawn(process.execPath, [ENTRY, '--http'], {
    cwd: path.join(HERE, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { RECALLFLOW_MCP_PORT: String(httpPort), RECALLFLOW_BRIDGE_TOKEN: TOKEN }),
  });
  child.stderr.on('data', () => {});
  await waitReady(httpPort);

  // 另起一个 stdio 模式实例，用于验证 /mcp 在该模式下被关闭
  stdioPort = await freePort();
  stdioChild = spawn(process.execPath, [ENTRY], {
    cwd: path.join(HERE, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { RECALLFLOW_MCP_PORT: String(stdioPort), RECALLFLOW_BRIDGE_TOKEN: TOKEN }),
  });
  stdioChild.stderr.on('data', () => {});
  await waitReady(stdioPort);
});

test.after(async () => {
  const a = child;
  const b = stdioChild;
  child = null;
  stdioChild = null;
  await stopChild(a);
  await stopChild(b);
});

// ---------------------------------------------------------------- 安全边界

test('HTTP: 无鉴权头 → 401（防止任意网页调用）', async () => {
  const r = await rawRequest(httpPort, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: INIT,
  });
  assert.equal(r.status, 401, r.body);
});

test('HTTP: token 错误 → 401', async () => {
  const r = await rawRequest(httpPort, {
    headers: mcpHeaders({ Authorization: 'Bearer wrong-token' }),
    body: INIT,
  });
  assert.equal(r.status, 401, r.body);
});

test('HTTP: Host 非本机 → 403（DNS rebinding 防护）', async () => {
  const r = await rawRequest(httpPort, {
    headers: mcpHeaders({ Host: 'evil.example.com' }),
    body: INIT,
  });
  assert.equal(r.status, 403, r.body);
});

test('HTTP: 自定义头 X-RecallFlow-Token 同样可用', async () => {
  const r = await rawRequest(httpPort, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-RecallFlow-Token': TOKEN,
    },
    body: INIT,
  });
  assert.equal(r.status, 200, r.body);
});

// ---------------------------------------------------------------- 会话与工具

test('HTTP: initialize 建立会话并返回 mcp-session-id', async () => {
  const r = await rawRequest(httpPort, { headers: mcpHeaders(), body: INIT });
  assert.equal(r.status, 200, r.body);
  assert.ok(r.headers['mcp-session-id'], '应返回会话 ID');
  const msg = JSON.parse(r.body);
  assert.equal(msg.id, 1);
  assert.ok(msg.result && msg.result.serverInfo, r.body);
  assert.equal(msg.result.serverInfo.name, 'recallflow');
});

test('HTTP: 会话内 tools/list 包含全部必需工具', async () => {
  const sid = await openSession();
  const r = await rawRequest(httpPort, {
    headers: mcpHeaders({ 'mcp-session-id': sid }),
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  });
  assert.equal(r.status, 200, r.body);
  const names = (JSON.parse(r.body).result.tools || []).map((t) => t.name);
  assert.ok(
    names.length >= REQUIRED_TOOLS.length,
    '工具数应不少于必需集合，实际 ' + names.length + '：' + names.join(',')
  );
  for (const n of REQUIRED_TOOLS) {
    assert.ok(names.includes(n), '缺少工具 ' + n + '（实际：' + names.join(',') + '）');
  }
});

test('HTTP: 未知会话 ID → 用无状态模式把这次请求处理掉（客户端自愈，不因服务重启而永久失效）', async () => {
  // 背景（真实事故）：服务现在由浏览器 native host 自动拉起，而浏览器重启/服务崩溃后被重拉时，
  // 进程换了一个，长期运行的客户端（DSH / opencode）仍带着**上一个进程**的 mcp-session-id。
  // 规范建议这种请求回 404，但实测 SDK 客户端只把 404 当错误抛出、**不会重新 initialize**，
  // 结果是所有工具调用永久失效，用户只能重启客户端。所以服务端改为无状态处理
  // （见 index.js 的 handleStaleSession，附带读 SDK 源码得到的依据）。
  const r = await rawRequest(httpPort, {
    headers: mcpHeaders({ 'mcp-session-id': 'not-a-real-session' }),
    body: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
  });
  assert.equal(r.status, 200, r.body);
  const names = (JSON.parse(r.body).result.tools || []).map((t) => t.name);
  assert.ok(names.includes('browser_read'), '自愈请求必须真的拿到工具列表：' + r.body);
});

test('HTTP: 无状态自愈不分配新会话 id（否则客户端会误以为自己有会话）', async () => {
  const r = await rawRequest(httpPort, {
    headers: mcpHeaders({ 'mcp-session-id': 'stale-session-2' }),
    body: { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
  });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.headers['mcp-session-id'], undefined, '无状态模式不应返回会话 id');
});

test('HTTP: 未知会话的 GET（SSE 续流）无法无状态恢复 → 仍按规范 404', async () => {
  const r = await rawRequest(httpPort, {
    method: 'GET',
    headers: mcpHeaders({ 'mcp-session-id': 'not-a-real-session', Accept: 'text/event-stream' }),
  });
  assert.equal(r.status, 404, r.body);
});

test('HTTP: /health 带 pid（宿主据此判断端口上是不是自己启动的那个进程）', async () => {
  const r = await rawRequest(httpPort, { method: 'GET', reqPath: '/health', headers: {} });
  const j = JSON.parse(r.body);
  assert.ok(Number.isInteger(j.pid) && j.pid > 0, r.body);
});

test('HTTP: 多个并发会话各自独立工作（多 opencode 实例的关键性质）', async () => {
  const [a, b] = await Promise.all([openSession(), openSession()]);
  assert.notEqual(a, b, '不同客户端应拿到不同会话');
  const [ra, rb] = await Promise.all([
    rawRequest(httpPort, {
      headers: mcpHeaders({ 'mcp-session-id': a }),
      body: { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} },
    }),
    rawRequest(httpPort, {
      headers: mcpHeaders({ 'mcp-session-id': b }),
      body: { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} },
    }),
  ]);
  assert.equal(ra.status, 200, ra.body);
  assert.equal(rb.status, 200, rb.body);
  assert.ok(JSON.parse(ra.body).result.tools.length >= REQUIRED_TOOLS.length);
  assert.ok(JSON.parse(rb.body).result.tools.length >= REQUIRED_TOOLS.length);
});

test('HTTP: 会话之间不串台（旧会话在另一个会话建立后仍可用）', async () => {
  const first = await openSession();
  await openSession();
  const r = await rawRequest(httpPort, {
    headers: mcpHeaders({ 'mcp-session-id': first }),
    body: { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
  });
  assert.equal(r.status, 200, r.body);
});

// ---------------------------------------------------------------- 模式开关

test('stdio 模式下 /mcp 关闭 → 404（不影响原有用法）', async () => {
  const r = await rawRequest(stdioPort, {
    headers: mcpHeaders(),
    body: INIT,
  });
  assert.equal(r.status, 404, r.body);
});

test('两种模式下 /health 都免鉴权可探活（只读、无副作用）', async () => {
  for (const p of [httpPort, stdioPort]) {
    const r = await rawRequest(p, { method: 'GET', reqPath: '/health', headers: {} });
    assert.equal(r.status, 200, 'port=' + p);
    const j = JSON.parse(r.body);
    assert.equal(j.ok, true);
    assert.equal(typeof j.ws, 'boolean');
  }
});

// 桥接层「跨会话响应隔离」的端到端验证。
//
// 为什么需要这个测试：改动前，通道状态（queue / pending / seq）是**全局单份**，
// /poll 把整个队列交给第一个等待者，/result 接受任意 id。于是两个 MCP 客户端并发时，
// 一个客户端可能收到另一个的页面正文 —— 对前端调试而言，这等于把 file:line 归因
// 挂到错误的页面上，比报错更糟（错误结果看起来是对的）。
// 而原有的 http-transport 测试只有单客户端往返，永远发现不了这个问题。
//
// 做法：起真实 server（--http），建立**两个** MCP 会话，各自并发发起一次工具调用；
// 用一个「假扩展」连上 WebSocket 收活并回结果。若隔离生效，两个 job 必须携带
// **不同的** session 标记，且每个会话只能拿到自己的结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ws 是 CommonJS
import wsPkg from '../node_modules/ws/index.js';
const { WebSocket } = wsPkg;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'index.js');
const TOKEN = 'isolation-test-token-1234567890';

let child = null;
let port = 0;

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

function rawRequest(reqPort, { method = 'POST', reqPath = '/mcp', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: reqPort, method, path: reqPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function mcpHeaders(extra = {}) {
  return Object.assign(
    { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + TOKEN },
    extra
  );
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'iso-test', version: '1' } },
};

async function waitReady(p, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await rawRequest(p, { method: 'GET', reqPath: '/health', headers: {} });
      if (r.status === 200) return;
    } catch (e) {
      /* 尚未监听 */
    }
    if (Date.now() > deadline) throw new Error('服务器未在超时内就绪（port=' + p + '）');
    await new Promise((r) => setTimeout(r, 150));
  }
}

// 建立一个 MCP 会话，返回它的 sessionId。
async function openSession(p, name) {
  const init = await rawRequest(p, {
    headers: mcpHeaders(),
    body: Object.assign({}, INIT, { params: Object.assign({}, INIT.params, { clientInfo: { name, version: '1' } }) }),
  });
  const sid = init.headers['mcp-session-id'];
  if (!sid) throw new Error('未取得会话 ID: ' + init.status + ' ' + init.body);
  await rawRequest(p, {
    headers: mcpHeaders({ 'mcp-session-id': sid }),
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  return sid;
}

// 在指定会话里调用一个**会走到扩展**的工具（dev_session_get 需要扩展回结果）。
function callTool(p, sid, id, name, args) {
  return rawRequest(p, {
    headers: mcpHeaders({ 'mcp-session-id': sid }),
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } },
  });
}

// 解析 MCP 响应里的文本内容（enableJsonResponse 下是 JSON body）。
function textOf(resp) {
  try {
    const j = JSON.parse(resp.body);
    const content = (j && j.result && j.result.content) || [];
    return content.map((c) => c.text || '').join('\n');
  } catch (e) {
    return resp.body || '';
  }
}

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
    setTimeout(done, 3000);
  });
}

test.before(async () => {
  port = await freePort();
  child = spawn(process.execPath, [ENTRY, '--http'], {
    cwd: path.join(HERE, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { RECALLFLOW_MCP_PORT: String(port), RECALLFLOW_BRIDGE_TOKEN: TOKEN }),
  });
  child.stderr.on('data', (d) => {
    if (process.env.ISO_DEBUG) process.stderr.write('[server] ' + d.toString());
  });
  await waitReady(port);
});

test.after(async () => {
  const c = child;
  child = null;
  await stopChild(c);
});

test('两个 MCP 会话的请求携带不同 session 标记，且各自只拿到自己的结果', async () => {
  const sidA = await openSession(port, 'client-A');
  const sidB = await openSession(port, 'client-B');
  assert.notEqual(sidA, sidB, '两个会话必须有不同的 id');

  // 假扩展：收活并回结果。回结果时**原样回带 session**（与真实 relay.js 一致）。
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/?token=' + encodeURIComponent(TOKEN));
  const jobs = [];
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('假扩展未能连上 WS')), 5000);
    ws.on('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });

  const seen = new Promise((resolve) => {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }
      if (!msg || msg.method === undefined) return;
      jobs.push(msg);
      // 回一个 browser_read 形状的结果；正文里放进该 job 的 session，
      // 这样发起方最终在 text 里看到的是**自己的** session —— 串台时会看到对方的。
      ws.send(
        JSON.stringify({
          id: msg.id,
          session: msg.session,
          result: {
            url: (msg.params && msg.params.url) || '',
            title: 'iso',
            text: 'session=' + msg.session,
            quotes: [],
            fullChars: String('session=' + msg.session).length,
          },
        })
      );
      if (jobs.length >= 2) resolve();
    });
  });

  // **并发**发起两条：这是串台能发生的唯一条件（串行时队列里不会有两条）。
  // 必须选一个**真的经过扩展通道**的工具：dev_session_get 只读本机文件，
  // 根本不走 callExtension，用它测不出隔离（第一版就踩了这个坑）。
  // browser_read 会 callExtension('browser_read') 并原样返回扩展的结果。
  const [respA, respB] = await Promise.all([
    callTool(port, sidA, 101, 'browser_read', { url: 'https://example.com/a' }),
    callTool(port, sidB, 102, 'browser_read', { url: 'https://example.com/b' }),
  ]);
  await Promise.race([seen, new Promise((r) => setTimeout(r, 5000))]);

  assert.equal(
    jobs.length,
    2,
    '两条请求都应到达扩展，实际 ' + jobs.length + '\nA=' + respA.status + ' ' + respA.body + '\nB=' + respB.status + ' ' + respB.body
  );
  const sessions = jobs.map((j) => j.session);
  assert.ok(
    sessions[0] !== undefined && sessions[1] !== undefined,
    '每个 job 都必须携带 session 标记：' + JSON.stringify(sessions)
  );
  assert.notEqual(sessions[0], sessions[1], '两个会话的 job 必须标记为不同的 session（否则回程无法路由）');
  assert.deepEqual(
    sessions.slice().sort(),
    [sidA, sidB].sort(),
    'job 上的 session 必须等于发起它的 MCP 会话 id'
  );

  // 核心断言：每个会话拿到的回声必须**等于它自己的 session**，而不是对方的。
  const textA = textOf(respA);
  const textB = textOf(respB);
  assert.ok(textA.includes(sidA), 'A 必须拿到自己（' + sidA + '）的回声，实际：' + textA);
  assert.ok(textB.includes(sidB), 'B 必须拿到自己（' + sidB + '）的回声，实际：' + textB);
  assert.ok(!textA.includes(sidB), 'A 不得拿到 B 的结果（这就是串台）');
  assert.ok(!textB.includes(sidA), 'B 不得拿到 A 的结果（这就是串台）');

  try {
    ws.close();
  } catch (e) {}
});

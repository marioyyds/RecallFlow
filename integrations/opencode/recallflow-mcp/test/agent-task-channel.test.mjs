// agent_task 通道的服务端-桥接端往返验证。
//
// 为什么需要它（这几条都是"改坏了不会报错、只会表现得很怪"的地方）：
//   · jobId 必须按 **MCP 会话** 记住：不记的话调用方每次都要自带 jobId，
//     漏传就会去读别人的任务或读不到（而 status 只是"查不到"，看起来像任务丢了）；
//   · 授权类失败（allowRisk 含 high / 未知类别）必须把**原因原样带回**，
//     调用方要据此**改参数重试**，所以不能吞成一句笼统的"启动失败"；
//   · agent_task 必须**快进快出**：它若同步等任务跑完，必然撞上客户端 90s 超时 ——
//     这条通道的全部设计就是为了避免那件事，这里把它钉住。
//
// 做法与 session-isolation.test.mjs 同构：起真实 server（--http）+ 一个「假扩展」连 WebSocket。
// 假扩展不执行真 agent，只按脚本回结果 —— 因此这里验证的是**通道**，
// 真实浏览器里的 agent 执行仍需人工 E2E（见 docs/agent-task-bridge-plan.md 第八节）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import wsPkg from '../node_modules/ws/index.js';
const { WebSocket } = wsPkg;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'index.js');
const TOKEN = 'agent-task-test-token-1234567890';

let child = null;
let port = 0;
let ext = null;
/** 假扩展收到的请求（按顺序），供断言 job 里带了什么。 */
let seen = [];

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
    { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-RecallFlow-Token': TOKEN },
    extra
  );
}

/** 建立一个 MCP 会话，返回可复用的请求头。 */
async function openSession() {
  const init = await rawRequest(port, {
    headers: mcpHeaders(),
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    },
  });
  const sid = init.headers['mcp-session-id'];
  assert.ok(sid, 'initialize 应返回 mcp-session-id');
  const headers = mcpHeaders({ 'mcp-session-id': sid });
  await rawRequest(port, { headers, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  return { sid, headers };
}

/** 调一次工具，返回解析后的 JSON（服务端把结果 JSON 化在 text 里）。 */
async function callTool(headers, name, args, id = 2) {
  const res = await rawRequest(port, {
    headers,
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } },
  });
  const parsed = JSON.parse(res.body);
  const text = parsed.result && parsed.result.content && parsed.result.content[0] && parsed.result.content[0].text;
  try {
    return JSON.parse(text);
  } catch (e) {
    return { _raw: text, _isError: Boolean(parsed.result && parsed.result.isError) };
  }
}

await test('agent_task 通道', async (t) => {
  port = await freePort();
  child = spawn(process.execPath, [ENTRY, '--http'], {
    env: Object.assign({}, process.env, {
      RECALLFLOW_MCP_PORT: String(port),
      RECALLFLOW_BRIDGE_TOKEN: TOKEN,
      RECALLFLOW_EXT_TIMEOUT_MS: '4000',
    }),
    stdio: 'ignore',
  });

  // 等 /health 起来
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await rawRequest(port, { method: 'GET', reqPath: '/health', headers: {} });
      if (r.status === 200) break;
    } catch (e) {}
    if (Date.now() > deadline) throw new Error('server 未在 15s 内起来');
    await new Promise((r) => setTimeout(r, 200));
  }

  // 假扩展接入并回结果：按 method 给不同答复，便于驱动各条路径。
  ext = new WebSocket('ws://127.0.0.1:' + port + '/?token=' + encodeURIComponent(TOKEN));
  ext.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (!msg || msg.id === undefined) return;
    seen.push(msg);
    let result;
    if (msg.method === 'agent_task') {
      result = { ok: true, jobId: 'job-fake-1', state: 'running', note: '已启动' };
    } else if (msg.method === 'agent_task_status') {
      result = { ok: true, jobId: msg.params.jobId, state: 'running', running: true, events: [], seq: 7, omitted: 0 };
    } else if (msg.method === 'agent_task_cancel') {
      result = { ok: true, jobId: msg.params.jobId, state: 'running', note: '已发出取消信号' };
    } else {
      result = { ok: false, error: '假扩展不认识的方法：' + msg.method };
    }
    ext.send(JSON.stringify({ id: msg.id, result, session: msg.session }));
  });
  await new Promise((resolve, reject) => {
    ext.on('open', resolve);
    ext.on('error', reject);
  });

  await t.test('工具清单暴露三个 agent 工具', async () => {
    const { headers } = await openSession();
    const res = await rawRequest(port, {
      headers,
      body: { jsonrpc: '2.0', id: 5, method: 'tools/list' },
    });
    const tools = JSON.parse(res.body).result.tools.map((x) => x.name);
    for (const n of ['agent_task', 'agent_task_status', 'agent_task_cancel']) {
      assert.ok(tools.includes(n), '工具清单应含 ' + n);
    }
    const at = JSON.parse(res.body).result.tools.find((x) => x.name === 'agent_task');
    assert.deepEqual(at.inputSchema.required, ['instruction'], 'instruction 必填，allowRisk 不强制（缺省=只读）');
    assert.ok(at.inputSchema.properties.allowRisk, 'allowRisk 应出现在 schema 里');
  });

  await t.test('启动任务：把 instruction/allowRisk/tabId 传给扩展，并把 jobId 带回', async () => {
    const { headers } = await openSession();
    seen = [];
    const r = await callTool(headers, 'agent_task', {
      instruction: '把这篇笔记发出去',
      allowRisk: ['page', 'browser'],
      tabId: 4242,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.jobId, 'job-fake-1');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'agent_task');
    assert.equal(seen[0].params.instruction, '把这篇笔记发出去');
    assert.deepEqual(seen[0].params.allowRisk, ['page', 'browser']);
    assert.equal(seen[0].params.tabId, 4242, 'tabId 应原样传到扩展');
    assert.ok(seen[0].session, '请求必须带 session 标记（回程路由靠它）');
  });

  await t.test('jobId 按 MCP 会话记住：status 不传 jobId 也能读到同一个任务', async () => {
    const { headers } = await openSession();
    await callTool(headers, 'agent_task', { instruction: 'a', allowRisk: ['page'] }, 10);
    seen = [];
    const st = await callTool(headers, 'agent_task_status', { sinceSeq: 3 }, 11);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].params.jobId, 'job-fake-1', '应自动带上本会话启动的那个 jobId');
    assert.equal(seen[0].params.sinceSeq, 3, 'sinceSeq 应原样转发（轮询增量靠它）');
    assert.equal(st.seq, 7);
  });

  await t.test('会话之间互不串台：另一个会话没有 jobId 可记', async () => {
    const a = await openSession();
    await callTool(a.headers, 'agent_task', { instruction: 'a' }, 20);
    // 另开一个会话：它没有启动过任务，因此不应带上 a 的 jobId
    const b = await openSession();
    seen = [];
    await callTool(b.headers, 'agent_task_status', {}, 21);
    assert.equal(seen[0].params.jobId, '', 'b 会话不应拿到 a 的 jobId（否则会读到别人的任务）');
  });

  await t.test('授权类失败：把扩展给的原因与可操作提示原样带回（调用方据此改参数重试）', async () => {
    const { headers } = await openSession();
    // 让假扩展模拟"扩展侧拒绝了 allowRisk 含 high"
    ext.removeAllListeners('message');
    ext.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      seen.push(msg);
      ext.send(
        JSON.stringify({
          id: msg.id,
          session: msg.session,
          result: { ok: false, code: 'BAD_ALLOW_RISK', error: 'allowRisk 不接受 "high"：只能面板批准。' },
        })
      );
    });
    const r = await callTool(headers, 'agent_task', { instruction: 'x', allowRisk: ['high'] }, 30);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_ALLOW_RISK', 'code 必须带出来，调用方靠它分支');
    assert.match(r.error, /high/, '拒绝原因必须原样带回');
    assert.match(String(r.hint), /allowRisk/, '应给出可操作提示（怎么改才能重试）');
  });

  await t.test('并发被拒：把 runningJobId 带出来，让调用方能去查那个任务', async () => {
    const { headers } = await openSession();
    ext.removeAllListeners('message');
    ext.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      seen.push(msg);
      ext.send(
        JSON.stringify({
          id: msg.id,
          session: msg.session,
          result: { ok: false, code: 'AGENT_TASK_BUSY', error: '已有 agent 任务在运行中', runningJobId: 'job-fake-1' },
        })
      );
    });
    const r = await callTool(headers, 'agent_task', { instruction: 'y' }, 40);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'AGENT_TASK_BUSY');
    assert.equal(r.runningJobId, 'job-fake-1', '必须给出在跑的那个 jobId，否则调用方无从查起');
    assert.match(String(r.hint), /agent_task_status|agent_task_cancel/, '应指出下一步能做什么');
  });

  await t.test('agent_task 必须快进快出（不得同步等任务跑完）', async () => {
    // 假扩展**故意拖 2 秒**再回启动确认；调用方应在远小于"任务时长"的时间内拿到 jobId。
    // 这条钉住的是设计意图：若有人把启动改成"等任务结束"，分钟级流程必然撞 90s 超时。
    ext.removeAllListeners('message');
    ext.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      setTimeout(() => {
        ext.send(
          JSON.stringify({ id: msg.id, session: msg.session, result: { ok: true, jobId: 'job-slow', state: 'running' } })
        );
      }, 400);
    });
    const { headers } = await openSession();
    const t0 = Date.now();
    const r = await callTool(headers, 'agent_task', { instruction: 'z' }, 50);
    const dt = Date.now() - t0;
    assert.equal(r.jobId, 'job-slow');
    assert.ok(dt < 3000, '启动调用应很快返回（实测 ' + dt + 'ms）；它不该等任务跑完');
  });
});

test.after(() => {
  try { if (ext) ext.close(); } catch (e) {}
  try { if (child) child.kill(); } catch (e) {}
});

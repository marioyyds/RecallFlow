// 单插件集成的测试：用一个假 ctx 驱动真实插件文件，直接调用它注册的 HTTP 处理器。
//
// 为什么这样做：插件真正的行为体现在「注册了什么路由/工具」与「处理器收到请求后做什么」。
// 假 ctx 能把这两点都抓住，且不需要起真的 DSH（那要 web server 与鉴权，慢且会碰用户环境）。
// 真正的端到端验证在脚本里另做（起隔离实例 + curl）。
import test from 'node:test';
import assert from 'node:assert/strict';

const PLUGIN_PATH = '../integrations/dsh-plugin-recallflow-one/index.js';

// 全局替换定时器，且**不还原**。
// 教训（第二次踩）：SSE 的心跳用 setInterval 长期持有 —— 在真实服务器里这是对的，
// 但在测试里它会让 node 进程**永不退出**，表现为挂起（实测被 180 秒超时移入后台）。
// 这里只需要 setTimeout 继续可用（工具超时用），所以只替换 interval 两个。
const intervalCalls = [];
globalThis.setInterval = (fn, ms) => {
  intervalCalls.push(ms);
  return { __fake: true };
};
globalThis.clearInterval = () => {};

/** 造一个假的 ctx：捕获事件订阅、路由与工具注册。 */
function makeCtx() {
  const handlers = new Map();
  const routes = new Map();
  const tools = new Map();
  const agent = {
    calls: [],
    session: { id: 'session-test-0001' },
    async send(msg, mode, wake) {
      this.calls.push({ msg, mode, wake });
      return null;
    },
  };
  const ctx = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {};
    },
    fire(name, ...args) {
      for (const fn of handlers.get(name) || []) fn(...args);
    },
    agents: { get: () => agent },
    tools: {
      register(def) {
        tools.set(def.name, def);
        return () => {};
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => {};
      },
    },
  };
  return { ctx, routes, tools, agent, fire: ctx.fire };
}

/** 假的 IncomingMessage：可读流 + headers/method。 */
function fakeReq({ method = 'GET', headers = {}, body = '' } = {}) {
  const listeners = new Map();
  const req = {
    method,
    headers,
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return req;
    },
    destroy() {},
  };
  // 异步推送请求体与结束事件
  queueMicrotask(() => {
    if (body) for (const fn of listeners.get('data') || []) fn(Buffer.from(body, 'utf8'));
    for (const fn of listeners.get('end') || []) fn();
  });
  return req;
}

/** 假的 ServerResponse：记录状态、头与写入内容。 */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(status, headers) {
      res.statusCode = status;
      Object.assign(res.headers, headers || {});
      return res;
    },
    write(chunk) {
      res.chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(String(chunk));
      res.ended = true;
      return res;
    },
    flushHeaders() {},
    /** 已写出的整体文本（便于断言） */
    get text() {
      return res.chunks.join('');
    },
  };
  return res;
}

async function loadPlugin() {
  const mod = await import(PLUGIN_PATH + '?t=' + Date.now());
  const bag = makeCtx();
  mod.apply(bag.ctx, {});
  // 插件在 agent/created 里登记会话；单会话场景下必须先喂一次
  bag.fire('agent/created', { agent: bag.agent, source: 'fresh' });
  return { mod, ...bag };
}

test('装载：注册三条路由与一个浏览器能力工具，且声明了必需的服务依赖', async () => {
  const { mod, routes, tools } = await loadPlugin();
  assert.deepEqual(mod.inject.slice().sort(), ['agents', 'tools', 'webServer']);
  assert.ok(routes.has('/recallflow/stream'), '缺少 SSE 路由');
  assert.ok(routes.has('/recallflow/say'), '缺少输入路由');
  assert.ok(routes.has('/recallflow/result'), '缺少回执路由');
  assert.ok(tools.has('recallflow_browser'), '缺少浏览器能力工具');
  const tool = tools.get('recallflow_browser');
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['op']);
  assert.equal(typeof tool.execute, 'function');
  assert.equal(typeof tool.output.render, 'function');
});

test('POST /recallflow/say：面板的话走 agent.send，载荷必须是真用户输入（source.kind=user）', async () => {
  const { routes, agent } = await loadPlugin();
  const route = routes.get('/recallflow/say');
  const req = fakeReq({
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ text: '帮我看下这个页面' }),
  });
  const res = fakeRes();
  await route.handler(req, res);

  assert.equal(res.statusCode, 200, res.text);
  assert.equal(agent.calls.length, 1, '应调用一次 send');
  const { msg, mode, wake } = agent.calls[0];
  // 这三条是核心契约，任何一条错了都会导致"面板的话不是真用户消息"或"叫不醒空闲会话"
  assert.equal(msg.role, 'user');
  assert.deepEqual(msg.content, [{ type: 'text', text: '帮我看下这个页面' }]);
  assert.equal(msg.source.kind, 'user', 'kind 必须是 user —— 自定义 kind 只会落成上下文');
  assert.ok(msg.source.rpcId, 'rpcId 用于回显归属');
  assert.ok(Object.isFrozen(msg), '载荷应冻结（与官方输入路径一致）');
  assert.equal(mode, 'next-turn');
  assert.equal(wake, true, '必须唤醒空闲 driver，否则面板在 DSH 空闲时叫不动它');
});

test('POST /recallflow/say：空文本与非 POST 被拒，且不触碰会话', async () => {
  const { routes, agent } = await loadPlugin();
  const route = routes.get('/recallflow/say');

  const empty = fakeRes();
  await route.handler(fakeReq({ method: 'POST', body: '{"text":"   "}' }), empty);
  assert.equal(empty.statusCode, 400, empty.text);

  const wrong = fakeRes();
  await route.handler(fakeReq({ method: 'GET' }), wrong);
  assert.equal(wrong.statusCode, 405, wrong.text);

  const bad = fakeRes();
  await route.handler(fakeReq({ method: 'POST', body: '不是 json' }), bad);
  assert.equal(bad.statusCode, 400, bad.text);

  assert.equal(agent.calls.length, 0, '被拒的请求不应发出消息');
});

test('GET /recallflow/stream：SSE 头正确，并先送一条 hello（带当前会话）', async () => {
  const { routes } = await loadPlugin();
  const route = routes.get('/recallflow/stream');
  const res = fakeRes();
  await route.handler(fakeReq({ method: 'GET', headers: { origin: 'chrome-extension://abc' } }), res);

  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['Content-Type']), /text\/event-stream/);
  assert.equal(res.headers['Cache-Control'], 'no-cache, no-transform');
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'chrome-extension://abc');
  assert.match(res.text, /^data: \{"kind":"hello"/, '应先发 hello 帧：' + res.text.slice(0, 120));
  assert.ok(res.text.includes('session-test-0001'), 'hello 应带上当前会话 id');
  assert.equal(res.ended, false, 'SSE 不应结束响应（要长期持有）');
});

test('会话事件通过 SSE 推给面板（含角色与来源，便于面板区分用户/助手）', async () => {
  const { routes, fire } = await loadPlugin();
  const route = routes.get('/recallflow/stream');
  const res = fakeRes();
  await route.handler(fakeReq({ method: 'GET' }), res);
  const before = res.text.length;

  fire(
    'session/event',
    { id: 'session-test-0001' },
    { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } }
  );
  const delta = res.text.slice(before);
  assert.match(delta, /"kind":"session-event"/, delta);
  assert.match(delta, /"type":"user\/message"/, delta);
  assert.match(delta, /"role":"user"/, delta);
  assert.match(delta, /"text":"你好"/, delta);
});

test('工具往返：execute 通过 SSE 发出 tool-call，收到回执后 resolve', async () => {
  const { routes, tools } = await loadPlugin();
  const stream = routes.get('/recallflow/stream');
  const res = fakeRes();
  await stream.handler(fakeReq({ method: 'GET' }), res);

  const tool = tools.get('recallflow_browser');
  const pending = tool.execute({ op: 'read', url: 'https://example.com' });

  // 解析出刚才广播的 tool-call 帧，拿 callId
  const match = res.text.match(/\{"kind":"tool-call","callId":"([^"]+)","op":"read"[^}]*\}/);
  assert.ok(match, '应广播 tool-call：' + res.text.slice(-200));
  const callId = match[1];

  const ack = fakeRes();
  await routes.get('/recallflow/result').handler(
    fakeReq({ method: 'POST', body: JSON.stringify({ callId, ok: true, value: { title: '示例页' } }) }),
    ack
  );
  assert.equal(ack.statusCode, 200, ack.text);
  assert.deepEqual(await pending, { title: '示例页' });
});

test('工具往返：浏览器未连接时明确失败，而不是静默挂起', async () => {
  const { tools } = await loadPlugin();
  const tool = tools.get('recallflow_browser');
  await assert.rejects(() => tool.execute({ op: 'read' }), /没有连接/);
});

test('工具往返：没有等待中的 callId 时回执被拒（404），不误 resolve', async () => {
  const { routes } = await loadPlugin();
  const ack = fakeRes();
  await routes.get('/recallflow/result').handler(
    fakeReq({ method: 'POST', body: JSON.stringify({ callId: 'not-exist', ok: true, value: 1 }) }),
    ack
  );
  assert.equal(ack.statusCode, 404, ack.text);
});

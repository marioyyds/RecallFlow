// 单插件集成的测试：用一个假 ctx 驱动真实插件文件，直接调用它注册的 HTTP 处理器。
//
// 覆盖范围与边界（如实说明）：
//   · 这里覆盖的是**注册面**（注册了哪些路由/工具、声明了哪些服务依赖）与
//     **HTTP 处理器逻辑**（/recallflow/say 的取值、校验、载荷形状、错误码）。
//   · WebSocket 那条通道（升级、帧、工具往返）**不在这里覆盖** —— 它需要真实的
//     socket 与 DSH 的升级分发，因此由 scripts/verify-one-plugin-e2e.mjs 对着真实实例验证
//     （已经过了：WS 升级成功 + hello 帧）。
//   · 工具调用的"等回执"逻辑同理，端到端留给真实实例（届时由模型真的调用该工具）。

import test from 'node:test';
import assert from 'node:assert/strict';

const PLUGIN_PATH = '../integrations/dsh-plugin-recallflow-one/index.js';

// 全局替换定时器，且**不还原**。
// 教训（踩过两次）：常驻定时器（心跳/轮询）会让测试进程**永不退出**，表现为挂起。
// 这里只需要 setTimeout 继续可用（工具超时用），所以只替换 interval 两个。
const intervalCalls = [];
globalThis.setInterval = (fn, ms) => {
  intervalCalls.push(ms);
  return { __fake: true };
};
globalThis.clearInterval = () => {};

/** 造一个假的 ctx：捕获事件订阅、路由、升级路由与工具注册。 */
function makeCtx() {
  const handlers = new Map();
  const routes = new Map();
  const upgrades = new Map();
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
      registerUpgrade(route) {
        upgrades.set(route.path, route);
        return () => {};
      },
    },
  };
  return { ctx, routes, upgrades, tools, agent, fire: ctx.fire };
}

/**
 * projectEvent 的取文本位置 —— 这条测试是"面板看不见助手回复"那个 bug 的回归。
 *
 * 事实（从已删的旧插件 session-map.js 里找回来的，DSH 的会话事件形状）：
 *   user/message      → 文本在 data.content
 *   assistant/message → 文本在 data.message.content      ← 第一版漏了这一个
 *
 * 当时的表现很能藏：用户的话正常（回声+渲染）、工具活动正常（有 tool 字段），
 * 只有助手的**文字**不见了 —— 而 classifyFrame 要求 text 非空，于是静默跳过。
 * 因此这里两种都断言，防止"只认一种字段"的写法再次蒙对。
 *
 * 顺便钉住：reasoning 块不是用户可见的话，不能当回答显示（旧实现也刻意忽略它）。
 */
test('projectEvent：助手文本在 data.message.content，用户文本在 data.content（取错字段=回复看不见）', async () => {
  const mod = await import(PLUGIN_PATH + '?t=' + Date.now());
  const bag = makeCtx();
  mod.apply(bag.ctx, {});

  bag.fire(
    'session/event',
    { id: 's1' },
    {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '用户说的话' }] },
    }
  );
  bag.fire(
    'session/event',
    { id: 's1' },
    {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '助手的回答' }] } },
    }
  );
  bag.fire(
    'session/event',
    { id: 's1' },
    {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '内心独白' }] } },
    }
  );

  const res = fakeRes();
  await bag.routes.get('/recallflow/status').handler(fakeReq({ method: 'GET' }), res);
  const body = JSON.parse(res.text);
  const recent = body.recentEvents || [];
  const texts = recent.map((e) => e.text).filter(Boolean);

  assert.ok(texts.includes('用户说的话'), '用户文本应取到：' + JSON.stringify(recent));
  assert.ok(texts.includes('助手的回答'), '★ 助手文本必须取到（取错字段时这条会失败）：' + JSON.stringify(recent));
  assert.ok(!texts.includes('内心独白'), 'reasoning 不是用户可见的话，不能当回答显示');
});

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
  queueMicrotask(() => {
    if (body) for (const fn of listeners.get('data') || []) fn(Buffer.from(body, 'utf8'));
    for (const fn of listeners.get('end') || []) fn();
  });
  return req;
}

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

test('装载：注册输入路由 + WS 升级路由 + 浏览器能力工具，并声明必需的服务依赖', async () => {
  const { mod, routes, upgrades, tools } = await loadPlugin();
  assert.deepEqual(mod.inject.slice().sort(), ['agents', 'tools', 'webServer']);
  assert.ok(routes.has('/recallflow/say'), '缺少输入路由');
  assert.ok(upgrades.has('/recallflow/ws'), '缺少 WS 升级路由');
  assert.equal(typeof upgrades.get('/recallflow/ws').handler, 'function');
  assert.equal(routes.get('/recallflow/say').kind, 'exact');
  assert.ok(tools.has('recallflow_browser'), '缺少浏览器能力工具');
  const tool = tools.get('recallflow_browser');
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['method']);
  assert.equal(typeof tool.execute, 'function');
  assert.equal(typeof tool.output.render, 'function');
  // 输出必须能被渲染成模型可读内容
  const rendered = tool.output.render({}, { title: 'x' });
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /title/);
});

test('POST /recallflow/say：走 agent.send，载荷必须是真用户输入（source.kind=user）', async () => {
  const { routes, agent } = await loadPlugin();
  const res = fakeRes();
  await routes.get('/recallflow/say').handler(
    fakeReq({
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' },
      body: JSON.stringify({ text: '帮我看下这个页面' }),
    }),
    res
  );

  assert.equal(res.statusCode, 200, res.text);
  assert.equal(agent.calls.length, 1, '应调用一次 send');
  const { msg, mode, wake } = agent.calls[0];
  // 这三条是核心契约：错了就会导致"面板的话不是真用户消息"或"叫不醒空闲会话"
  assert.equal(msg.role, 'user');
  assert.deepEqual(msg.content, [{ type: 'text', text: '帮我看下这个页面' }]);
  assert.equal(msg.source.kind, 'user', 'kind 必须是 user —— 自定义 kind 只会落成上下文');
  assert.ok(msg.source.rpcId, 'rpcId 用于回显归属');
  assert.ok(Object.isFrozen(msg), '载荷应冻结（与官方输入路径一致）');
  assert.equal(mode, 'next-turn');
  assert.equal(wake, true, '必须唤醒空闲 driver，否则面板在 DSH 空闲时叫不动它');
});

test('POST /recallflow/say：空文本 / 非 POST / 非 JSON 都被拒，且不触碰会话', async () => {
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

test('GET /recallflow/status：把"连没连上、会话找没找到"变成可观测的', async () => {
  const { routes, agent } = await loadPlugin();
  assert.ok(routes.has('/recallflow/status'), '应有状态路由');
  const res = fakeRes();
  await routes.get('/recallflow/status').handler(fakeReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 200, res.text);
  const body = JSON.parse(res.text);
  assert.equal(body.ok, true);
  assert.equal(body.wsPath, '/recallflow/ws');
  assert.equal(body.sayPath, '/recallflow/say');
  assert.equal(body.wsReady, false, '还没人升级过 WS，应为 false');
  assert.equal(body.clients, 0, '没有浏览器侧连接');
  assert.equal(body.currentSessionId, 'session-test-0001', '应登记了 agent/created 送来的会话');
  assert.deepEqual(body.sessions, ['session-test-0001']);
  assert.equal(body.pendingTools, 0);
  assert.ok(agent, '会话对象存在（占位断言，避免 lint 误判未使用）');
});

test('POST /recallflow/say：没有活会话时明确报 503，而不是静默假装成功', async () => {
  const mod = await import(PLUGIN_PATH + '?t=' + Date.now());
  const bag = makeCtx();
  mod.apply(bag.ctx, {});
  // 故意不喂 agent/created
  const res = fakeRes();
  await bag.routes.get('/recallflow/say').handler(
    fakeReq({ method: 'POST', body: JSON.stringify({ text: 'hi' }) }),
    res
  );
  assert.equal(res.statusCode, 503, res.text);
  assert.match(res.text, /没有可用的会话/);
});

test('POST /recallflow/say：agent/created 没触发过时，从官方注册表 ctx.agents.list() 兜底', async () => {
  // 实测缺陷：DSH 启动时**恢复**的会话，其 agent 在插件加载之前就建好了，
  // 'agent/created' 不会再发 —— 于是路由通了、工具也注册上了，但发消息回"没有可用的会话"。
  // 我在旧插件里修过同一个问题，却没把教训带进新插件；这条用例把它钉住。
  const mod = await import(PLUGIN_PATH + '?t=' + Date.now());
  const handlers = new Map();
  const registryAgent = {
    calls: [],
    session: { id: 'session-restored-0001' },
    async send(msg, mode, wake) {
      this.calls.push({ msg, mode, wake });
      return null;
    },
  };
  const routes = new Map();
  const ctx = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {};
    },
    agents: { get: () => undefined, list: () => [registryAgent] }, // 注册表里有，但事件没来过
    tools: { register: () => () => {} },
    webServer: {
      register(r) {
        routes.set(r.path, r);
        return () => {};
      },
      registerUpgrade: () => () => {},
    },
  };
  mod.apply(ctx, {});
  const res = fakeRes();
  await routes.get('/recallflow/say').handler(
    fakeReq({ method: 'POST', body: JSON.stringify({ text: '从注册表找到的会话' }) }),
    res
  );
  assert.equal(res.statusCode, 200, '应能从注册表兜底成功，实际：' + res.text);
  assert.equal(registryAgent.calls.length, 1, '消息应送进注册表里的那个 agent');
  assert.equal(registryAgent.calls[0].msg.source.kind, 'user');
  assert.equal(registryAgent.calls[0].wake, true);
  assert.match(res.text, /session-restored-0001/, '响应里应带上真实会话 id：' + res.text);
});

test('CORS：本机与扩展来源放行，其它来源不回 ACAO（预检 204）', async () => {
  const { routes } = await loadPlugin();
  const route = routes.get('/recallflow/say');

  const ext = fakeRes();
  await route.handler(
    fakeReq({ method: 'OPTIONS', headers: { origin: 'chrome-extension://abc', 'access-control-request-method': 'POST' } }),
    ext
  );
  assert.equal(ext.statusCode, 204);
  assert.equal(ext.headers['Access-Control-Allow-Origin'], 'chrome-extension://abc');

  const local = fakeRes();
  await route.handler(fakeReq({ method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:3080' } }), local);
  assert.equal(local.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:3080');

  const evil = fakeRes();
  await route.handler(fakeReq({ method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), evil);
  assert.equal(evil.headers['Access-Control-Allow-Origin'], undefined, '任意网页不得读写本机');
});

test('工具：浏览器未连接时明确失败，而不是静默挂起', async () => {
  const { tools } = await loadPlugin();
  await assert.rejects(() => tools.get('recallflow_browser').execute({ op: 'read' }), /没有连接/);
});

test('工具往返探针：注册了入口、只允许清单内的方法、无连接时明确报 503', async () => {
  const { routes } = await loadPlugin();
  assert.ok(routes.has('/recallflow/probe-tool'), '应注册工具往返探针');

  // 非清单内的方法必须被拒 —— 这是一个**可从外部调用**的入口，
  // 不能让它变成任意能力通道（recallflow_browser 只能由模型调，而这个是给排查用的）。
  const bad = fakeRes();
  await routes.get('/recallflow/probe-tool').handler(
    fakeReq({ method: 'POST', body: JSON.stringify({ method: 'rm -rf' }) }),
    bad
  );
  assert.equal(bad.statusCode, 400, bad.text);
  assert.match(bad.text, /不允许的方法/);

  const wrong = fakeRes();
  await routes.get('/recallflow/probe-tool').handler(fakeReq({ method: 'GET' }), wrong);
  assert.equal(wrong.statusCode, 405, wrong.text);

  // 合法方法但没有浏览器连接 → 503 + 明确原因（不是挂起到超时）
  const noClient = fakeRes();
  await routes.get('/recallflow/probe-tool').handler(
    fakeReq({ method: 'POST', body: JSON.stringify({ method: 'page_health' }) }),
    noClient
  );
  assert.equal(noClient.statusCode, 503, noClient.text);
  assert.match(noClient.text, /没有连接/, noClient.text);
});

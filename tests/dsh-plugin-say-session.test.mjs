// 插件 /say 的**指定会话**行为：直接驱动真实的路由处理器（不 mock 业务代码）。
//
// 起因：面板将来要能"选择跟哪条 DSH 会话说话"（多会话）。而插件里 `pickSession(preferred)`
// 的语义是"**尽量找一个能用的会话**"——指定一个不存在的 id 时它会一路回退到"最近活跃的那条"。
// 那对选择器是**危险**行为：用户以为消息进了 A 对话、实际进了 B，而且没有任何报错。
// 消息进错对话比报错糟糕得多，所以显式指定 id 的路径必须是严格的 —— 这条测试钉住它。
//
// 做法：用最小 ctx 抓出插件注册的路由处理器，再喂一个"会发 data + end 事件"的假 req
// （因为插件的 readBody 读的是 req.on('data'/'end')）。这样测的是**真实代码路径**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const PLUGIN = path.resolve(import.meta.dirname, '../integrations/dsh-plugin-recallflow-one/index.js');
const SAY = '/recallflow/say';
const STATUS = '/recallflow/status';

/** 造一个假 agent：send 记下收到的消息，便于断言"消息到底进了哪条会话"。 */
function fakeAgent(id) {
  const sent = [];
  return {
    sent,
    session: { id },
    send: async (msg) => {
      sent.push(msg);
      return { ok: true };
    },
  };
}

/** 最小 ctx：抓住路由 + 工具，并给一个假的 agents 注册表（插件确实 inject 了 'agents'）。 */
function makeCtx(agentsById) {
  const routes = new Map();
  const tools = [];
  const ctx = {
    tools: { register: (d) => { tools.push(d.name); return () => {}; } },
    webServer: {
      register: (r) => { routes.set(r.path, r.handler); return () => {}; },
      registerUpgrade: () => () => {},
    },
    agents: {
      get: (id) => agentsById.get(id) || null,
      list: () => [...agentsById.values()],
    },
    on: () => {},
    effect: (f) => (typeof f === 'function' ? f() : undefined),
    logger: () => {},
  };
  return { ctx, routes, tools };
}

/** 直接调路由处理器，模仿真实 HTTP：req 发 data+end，res 收 status + body。 */
async function callRoute(handler, body) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { origin: 'http://example.test' };
  req.destroy = () => {};
  let status = 0;
  let payload = '';
  const res = {
    writeHead: (s) => { status = s; return res; },
    end: (d) => { if (d !== undefined) payload += String(d); },
    setHeader: () => {},
    getHeader: () => undefined,
  };
  const done = handler(req, res);
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
  req.emit('end');
  await done;
  let json = null;
  try { json = JSON.parse(payload); } catch {}
  return { status, json, raw: payload };
}

async function load(agentsById) {
  // 用带随机 query 的 URL 重新 import：避免模块缓存让多次装载互相串味
  const mod = await import(pathToFileURL(PLUGIN).href + '?case=' + Math.random());
  const { ctx, routes, tools } = makeCtx(agentsById);
  mod.apply(ctx, {});
  return { routes, tools };
}

test('插件装载后会注册 recallflow_browser 与 /say、/status 两条路由', async () => {
  const { routes, tools } = await load(new Map());
  assert.deepEqual(tools, ['recallflow_browser'], '应注册唯一的工具 recallflow_browser');
  assert.ok(routes.has(SAY), '应注册 /recallflow/say');
  assert.ok(routes.has(STATUS), '应注册 /recallflow/status');
});

test('/say 指定【不存在】的会话：必须 404 明确报错，绝不回退到别的会话（安全边界）', async () => {
  const a = fakeAgent('session-A');
  const { routes } = await load(new Map([['session-A', a]]));

  const r = await callRoute(routes.get(SAY), { text: '这条不该被发出去', sessionId: 'session-不存在' });

  assert.equal(r.status, 404, '指定不存在的会话必须是 404，而不是悄悄用别的会话（实际：' + r.status + ' ' + r.raw + '）');
  assert.match(String(r.json && r.json.error), /找不到指定的会话/, '应说清是哪个会话找不到');
  assert.match(String(r.json && r.json.error), /不会/, '应说清不会回退（否则调用方以为消息发出去了）');
  assert.equal(a.sent.length, 0, '**绝不能**把这条消息发给另一个会话 —— 这正是要防的：消息进错对话且无报错');
});

test('/say 指定【存在】的会话：消息确实进那条会话，并回传 rpcId', async () => {
  const a = fakeAgent('session-A');
  const b = fakeAgent('session-B');
  const { routes } = await load(new Map([['session-A', a], ['session-B', b]]));

  const r = await callRoute(routes.get(SAY), { text: '给 B 的话', sessionId: 'session-B' });

  assert.equal(r.status, 200, '指定存在的会话应当成功：' + r.raw);
  assert.ok(r.json && r.json.ok, 'ok 应为 true');
  assert.match(String(r.json.rpcId), /^recallflow-/, '应回传 rpcId（面板靠它对齐回声）');
  assert.equal(b.sent.length, 1, '消息应进 session-B');
  assert.equal(a.sent.length, 0, '消息不应进 session-A');
  const text = b.sent[0].content.map((c) => c.text).join('');
  assert.equal(text, '给 B 的话', '内容应原样送到');
  assert.equal(b.sent[0].source.kind, 'user', "source.kind 必须是 'user'（否则只会落成上下文，不是真用户消息）");
});

test('/say 不指定会话：沿用旧行为（不得因为新功能变成 404）', async () => {
  const a = fakeAgent('session-A');
  const { routes } = await load(new Map([['session-A', a]]));

  const r = await callRoute(routes.get(SAY), { text: '默认路径' });

  assert.notEqual(r.status, 404, '没指定会话时不该走严格路径（这是"不破坏现有用法"的底线）');
  assert.equal(r.status, 200, '有可用会话时应照旧成功：' + r.raw);
  assert.equal(a.sent.length, 1, '没指定时应发给默认会话');
});

test('/status 暴露每个已知会话的 lastAt，供面板做选择器', async () => {
  const a = fakeAgent('session-A');
  const { routes } = await load(new Map([['session-A', a]]));

  // 先触发一次 /say，让插件把会话登记进来
  await callRoute(routes.get(SAY), { text: '登记一下' });
  const s = await callRoute(routes.get(STATUS), undefined);

  assert.equal(s.status, 200, '/status 应可用');
  assert.ok(Array.isArray(s.json.sessionList), '应有 sessionList（原来只有 id 列表，选不出"哪条是刚在说的"）');
  const entry = s.json.sessionList.find((x) => x.id === 'session-A');
  assert.ok(entry, 'sessionList 里应包含 session-A，实际：' + JSON.stringify(s.json.sessionList));
  assert.ok(typeof entry.lastAt === 'number' && entry.lastAt > 0, 'lastAt 应是正数时间戳');
  assert.ok(Array.isArray(s.json.sessions) && s.json.sessions.includes('session-A'), '旧的 sessions id 列表必须保留（兼容）');
});

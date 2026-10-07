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
function makeCtx(agentsById, query) {
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
    // SessionQuery 桩。默认 undefined = 服务不可用 → 插件走安全分支（不报错、只是列不全）。
    // 用 get 而不是 inject，是因为插件就是这么写的：inject 失败会让整个插件不加载。
    get: (name) => (name === 'sessionQuery' ? query : undefined),
    effect: (f) => (typeof f === 'function' ? f() : undefined),
    logger: () => {},
  };
  return { ctx, routes, tools };
}

/** 直接调路由处理器，模仿真实 HTTP：req 发 data+end，res 收 status + body。 */
async function callRoute(handler, body, opts = {}) {
  const req = new EventEmitter();
  req.method = opts.method || 'POST';
  req.url = opts.url || '/';
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

async function load(agentsById, query) {
  // 用带随机 query 的 URL 重新 import：避免模块缓存让多次装载互相串味
  const mod = await import(pathToFileURL(PLUGIN).href + '?case=' + Math.random());
  const { ctx, routes, tools } = makeCtx(agentsById, query);
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

test('/status 的列表要**主动枚举注册表** —— 否则只有"说过话的那几条"', async () => {
  // 真实事故（用户报"有一个下拉，但点了没反应"）：sessions 只从会话事件与"发消息时的兜底"里填，
  // 而那个兜底只在找不到可用会话时才跑 → 只要有 1 条会话在说话，列表就永远只有那 1 条，
  // 选择器看起来"点了没反应"（其实只有一个真选项）。
  const a = fakeAgent('session-A');
  const b = fakeAgent('session-B');
  const c = fakeAgent('session-C');
  const { routes } = await load(new Map([['session-A', a], ['session-B', b], ['session-C', c]]));

  // **一次消息都不发、一个事件都不来**，直接问 /status
  const s = await callRoute(routes.get(STATUS), undefined);

  const ids = (s.json.sessionList || []).map((x) => x.id).sort();
  assert.deepEqual(
    ids,
    ['session-A', 'session-B', 'session-C'],
    '注册表里的三条都应出现在列表里（否则面板只能看到一个选项），实际：' + JSON.stringify(s.json.sessionList)
  );
  // 补登记进来的不能把"最近活动"刷成现在 —— 那会让排序变成瞎猜
  const discovered = s.json.sessionList.filter((x) => ['session-B', 'session-C'].includes(x.id));
  assert.ok(
    discovered.every((x) => x.lastAt === 0),
    '补登记的会话 lastAt 应为 0（没活动过就是没活动过），实际：' + JSON.stringify(discovered)
  );
});

test('SessionQuery：live / parentSession 要落进 sessionList，子会话**不能靠 id 形状判**', async () => {
  // 真机实测过的事实（2026-10-08）：17 条里有 4 条是子会话，其中一条**带 `session-` 前缀**
  // （session-c03c84c9…，parentSession = 当前会话）。所以判据必须是 DSH 给的
  // `SessionRecord.live` 与 `SessionHeader.parentSession` —— 看 id 长什么样会漏掉它。
  const parent = 'session-723c8b32-4ab3-489f-9f53-80958d29c5a9';
  const records = [
    { header: { id: parent }, live: true, persisted: true },
    {
      header: { id: 'session-c03c84c9-d915-4193-9296-7f234dfc7ce4', parentSession: parent },
      live: false,
      persisted: true,
    },
    {
      header: { id: '4bf8230e-2bdb-42b3-bfe3-268b254ca3dd', parentSession: parent },
      live: false,
      persisted: true,
    },
  ];
  const { routes } = await load(new Map(), { listSessions: async () => records });

  // refreshStoreSessions 是后台跑的（刻意不 await：statusSnapshot 是同步的）——
  // 所以第一次 /status 触发刷新，第二次就能读到。
  await callRoute(routes.get(STATUS), undefined);
  await new Promise((r) => setTimeout(r, 10));
  const s = await callRoute(routes.get(STATUS), undefined);

  const by = (id) => (s.json.sessionList || []).find((x) => x.id === id);
  assert.ok(by(parent), '父会话应在列表里');
  assert.equal(by(parent).live, true, 'live 要从 SessionRecord 带出来');
  const child = by('session-c03c84c9-d915-4193-9296-7f234dfc7ce4');
  assert.ok(child, '带 session- 前缀的子会话也要在列表里（它确实是一条会话）');
  assert.equal(child.live, false, 'live:false 要如实带出来 —— 界面靠它提示"发送前先打开"');
  assert.equal(
    child.parentSession,
    parent,
    'parentSession 要带出来：**带前缀的那条也是子会话**，光看 id 形状会漏掉它'
  );
  assert.equal(
    by('4bf8230e-2bdb-42b3-bfe3-268b254ca3dd').parentSession,
    parent,
    '裸 uuid 的子会话同样要有 parentSession'
  );
  assert.equal(s.json.sessionStore.queryAvailable, true, 'queryAvailable 应为 true');
  assert.equal(s.json.sessionStore.queryUsed, 'listSessions', 'queryUsed 应记下用了哪个方法');
  assert.equal(s.json.sessionStore.queryCount, 3, 'queryCount 应是记录条数');
  assert.equal(s.json.sessionStore.queryError, '', 'queryError 应为空');
});

test('只读会话历史路由：读出任意会话的事件，并投影成**面板那套** frame', async () => {
  // 这是目标 ② 的最小可用版本。依据是 readSession 的注释：
  //   *"@param sessionId - **live or persisted** session id to read"*（不要求会话活着）
  //   *"@returns cloned header and complete raw event log"*
  // 投影用的是面板渲染同一个 projectEvent，所以"形状能不能渲染成面板的行"由同一个函数回答。
  const parent = 'session-723c8b32-4ab3-489f-9f53-80958d29c5a9';
  const events = [
    { type: 'user/message', data: { text: '历史里的一句' } },
    { type: 'assistant/message', data: { text: '历史里的回复' } },
    { type: 'tool/call', data: { name: 'browser_read' } },
  ];
  let readWith = '';
  const { routes } = await load(new Map(), {
    listSessions: async () => [{ header: { id: parent }, live: true, persisted: true }],
    readSession: async (id) => {
      readWith = id;
      return { session: { id }, events };
    },
  });

  assert.ok(routes.has('/recallflow/session-log'), '应注册只读会话历史路由');
  const r = await callRoute(routes.get('/recallflow/session-log'), undefined, {
    method: 'GET',
    url: '/recallflow/session-log?sessionId=' + parent + '&limit=2',
  });

  assert.equal(r.status, 200, '应成功：' + r.raw);
  assert.equal(readWith, parent, '应把 sessionId 原样交给 readSession');
  assert.equal(r.json.total, 3, 'total 是日志总条数');
  assert.equal(r.json.count, 2, 'limit=2 应只投影最后两条');
  assert.ok(Array.isArray(r.json.frames) && r.json.frames.length === 2, 'frames 应是投影后的行');
  assert.ok(
    r.json.frames.every((f) => f && typeof f.type === 'string'),
    '每个 frame 至少要有 type —— 面板渲染要的就是这个形状'
  );
});

test('只读会话历史路由：缺 sessionId 时明确报错，不瞎猜一条', async () => {
  const { routes } = await load(new Map(), { readSession: async () => ({ events: [] }) });
  const r = await callRoute(routes.get('/recallflow/session-log'), undefined, {
    method: 'GET',
    url: '/recallflow/session-log',
  });
  assert.equal(r.status, 400, '缺 sessionId 应是 400：' + r.raw);
  assert.match(String(r.json.error), /sessionId/, '应说清缺什么');
});

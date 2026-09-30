/**
 * RecallFlow ↔ DSH 单插件集成（新架构的第一版）。
 *
 * 设计目标（用户原话）：
 *   「以 dsh 为主，recallflow 也可以对话，两者能够同步，但是确实应该是基于 dsh 的 session
 *     就行，根本不需存在着什么同步呢」
 *
 * 因此这里**没有同步**：只有一条会话。插件做三件事，全部在 DSH 进程内完成，
 * 不再需要任何外部中继进程：
 *
 *   1. GET  /recallflow/stream  → SSE：把这条会话的事件推给浏览器面板
 *   2. POST /recallflow/say     → 面板打的字变成**这条会话的真实用户消息**（能唤醒空闲会话）
 *   3. POST /recallflow/result  → 浏览器侧执行完工具后的回执
 *   4. ctx.tools.register       → 把浏览器能力直接注册成 DSH 工具（不需要 MCP 服务器）
 *
 * 依据（全部实测或读自类型声明，见 docs/one-session-plugin.md）：
 *   - `agent.send(message, 'next-turn', true)` 实测能：产生真 user/message + 唤醒空闲 driver + 开启新一轮
 *   - 载荷形状 `{id, role:'user', content:[{type:'text',text}], source:{kind:'user', rpcId}}`
 *     实测产生 `type=user/message, role=user, source.kind=user`
 *   - `webServer.register({kind,path,handler})` 的注释原文：
 *     "Owns the full response lifecycle (may hold the response open, e.g. SSE)"
 *   - `ctx.tools.register({name,description,parameters,output:{schema,render},execute})`
 *
 * 服务依赖：三个都必须声明，否则 Cordis 会在读取时报
 * "cannot get property … without inject"（实测过）。
 */

import { randomUUID } from 'node:crypto';

export const name = 'recallflow-one';
export const inject = ['agents', 'tools', 'webServer'];

const STREAM_PATH = '/recallflow/stream';
const SAY_PATH = '/recallflow/say';
const RESULT_PATH = '/recallflow/result';

/** SSE 心跳间隔：太短浪费，太长会被中间层掐断。 */
const HEARTBEAT_MS = 15000;
/** 工具调用等待浏览器回执的上限。 */
const TOOL_TIMEOUT_MS = 30000;
/** 只放行本机来源（与旧桥接同样的做法；不放行 * 以免任意网页读写本机）。 */
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const EXTENSION_ORIGIN = /^chrome-extension:\/\//;

function corsHeaders(origin) {
  if (!origin) return {};
  if (!LOCAL_ORIGIN.test(origin) && !EXTENSION_ORIGIN.test(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

function sendJson(res, status, body, origin) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && p.type === 'text' ? String(p.text || '') : ''))
    .join(' ')
    .trim();
}

export function apply(ctx, config = {}) {
  const log = (m) => {
    try {
      console.log('[recallflow-one] ' + m);
    } catch {}
  };

  // --- 会话选择 ---------------------------------------------------------------
  // 只有一条会话，所以插件要知道"面板说的是哪一条"。做法：跟踪最近有活动的会话
  // （用户正在用的那条）。不引入额外的选择 UI —— 简单优先。
  /** sessionId → { agent, lastAt } */
  const sessions = new Map();
  let currentSessionId = '';

  // --- SSE 客户端 -------------------------------------------------------------
  /** @type {Set<{res: import('node:http').ServerResponse, sessionId: string}>} */
  const clients = new Set();
  /** 正在等待浏览器回执的工具调用：callId → { resolve, timer } */
  const pendingTools = new Map();

  function broadcast(event) {
    const payload = 'data: ' + JSON.stringify(event) + '\n\n';
    for (const c of clients) {
      try {
        c.res.write(payload);
      } catch (e) {
        clients.delete(c);
      }
    }
  }

  /** 把一条会话事件投影成面板需要的最小信息（不做任何截断/改写）。 */
  function projectEvent(ev) {
    if (!ev || !ev.type) return null;
    const data = ev.data || {};
    const out = { type: String(ev.type) };
    if (data.role !== undefined) out.role = String(data.role);
    if (data.source && data.source.kind) out.sourceKind = String(data.source.kind);
    if (data.content) {
      const t = textOf(data.content);
      if (t) out.text = t;
    }
    // 工具事件：把工具名与参数带上，面板才画得出来
    if (data.tool) out.tool = String(data.tool);
    if (data.args !== undefined) out.args = data.args;
    if (ev.time !== undefined) out.time = ev.time;
    if (ev.seq !== undefined) out.seq = ev.seq;
    return out;
  }

  ctx.on('session/event', (session, ev) => {
    const sid = sessionIdOf(session);
    if (sid) {
      const entry = sessions.get(sid);
      if (entry) entry.lastAt = Date.now();
      currentSessionId = sid;
    }
    const projected = projectEvent(ev);
    if (projected) broadcast({ kind: 'session-event', sessionId: sid, event: projected });
  });

  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent;
    if (!agent) return;
    const sid = sessionIdOf(agent.session) || sessionIdOf(payload) || '';
    if (sid) {
      sessions.set(sid, { agent, lastAt: Date.now() });
      currentSessionId = sid;
      log('会话登记：' + sid);
      broadcast({ kind: 'session-registered', sessionId: sid });
    } else {
      // 拿不到 id 也要能用：按插入顺序保留 agent（单会话场景下只有一个）
      sessions.set('(agent-' + sessions.size + ')', { agent, lastAt: Date.now() });
      log('会话登记：拿不到 id，按序号登记');
    }
  });

  ctx.on('agent/disposed', (payload) => {
    const sid = sessionIdOf(payload && payload.agent && payload.agent.session);
    if (sid) sessions.delete(sid);
  });

  function sessionIdOf(session) {
    if (!session) return '';
    if (typeof session === 'string') return session;
    const id = session.id !== undefined ? session.id : session.sessionId;
    return id === undefined || id === null ? '' : String(id);
  }

  function pickSession(preferred) {
    if (preferred && sessions.has(preferred)) return sessions.get(preferred);
    if (currentSessionId && sessions.has(currentSessionId)) return sessions.get(currentSessionId);
    // 退路：最近有活动的那条
    let best = null;
    for (const entry of sessions.values()) {
      if (!best || (entry.lastAt || 0) > (best.lastAt || 0)) best = entry;
    }
    return best;
  }

  // --- 路由 1：SSE 事件流 -----------------------------------------------------
  ctx.webServer.register({
    kind: 'exact',
    path: STREAM_PATH,
    handler: (req, res) => {
      const origin = req.headers.origin;
      const allow = corsHeaders(origin);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, allow);
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '只支持 GET' }, origin);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...allow,
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const client = { res, sessionId: currentSessionId };
      clients.add(client);
      log('SSE 连接建立（当前 ' + clients.size + ' 个）');
      res.write('data: ' + JSON.stringify({ kind: 'hello', sessionId: currentSessionId, sessions: [...sessions.keys()] }) + '\n\n');

      const beat = setInterval(() => {
        try {
          res.write(': keepalive\n\n');
        } catch {
          /* 下面 close 会清理 */
        }
      }, HEARTBEAT_MS);

      const cleanup = () => {
        clearInterval(beat);
        clients.delete(client);
        log('SSE 连接断开（剩 ' + clients.size + ' 个）');
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
    },
  });

  // --- 路由 2：面板输入 → 真用户消息 ------------------------------------------
  ctx.webServer.register({
    kind: 'exact',
    path: SAY_PATH,
    handler: async (req, res) => {
      const origin = req.headers.origin;
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(origin));
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' }, origin);
        return;
      }
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (e) {
        sendJson(res, 400, { ok: false, error: '请求体不是 JSON：' + e.message }, origin);
        return;
      }
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) {
        sendJson(res, 400, { ok: false, error: '缺少 text' }, origin);
        return;
      }
      const picked = pickSession(body.sessionId);
      if (!picked || !picked.agent || typeof picked.agent.send !== 'function') {
        sendJson(res, 503, { ok: false, error: '没有可用的会话（DSH 里还没有活着的 agent？）' }, origin);
        return;
      }
      const rpcId = 'recallflow-' + randomUUID();
      const message = deepFreeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        // kind 必须是 'user'：这才是"真用户输入"的标记。实测用自定义 kind 只会落成上下文。
        source: { kind: 'user', rpcId },
      });
      try {
        // 实测：send(msg, 'next-turn', true) 同时做到 产生真 user/message + 唤醒空闲 driver + 开启新一轮。
        // inject 只能引导进行中的那一轮，不唤醒空闲会话，因此这里不用它。
        await picked.agent.send(message, 'next-turn', true);
        log('面板输入已送入会话：' + text.slice(0, 40));
        sendJson(res, 200, { ok: true, rpcId, sessionId: sessionIdOf(picked.agent.session) }, origin);
      } catch (err) {
        log('send 失败：' + String((err && err.message) || err));
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) }, origin);
      }
    },
  });

  // --- 路由 3：浏览器侧工具回执 -----------------------------------------------
  ctx.webServer.register({
    kind: 'exact',
    path: RESULT_PATH,
    handler: async (req, res) => {
      const origin = req.headers.origin;
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(origin));
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' }, origin);
        return;
      }
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (e) {
        sendJson(res, 400, { ok: false, error: '请求体不是 JSON：' + e.message }, origin);
        return;
      }
      const waiter = pendingTools.get(String(body.callId || ''));
      if (!waiter) {
        sendJson(res, 404, { ok: false, error: '没有等待中的工具调用：' + body.callId }, origin);
        return;
      }
      clearTimeout(waiter.timer);
      pendingTools.delete(String(body.callId));
      waiter.resolve(body.ok === false ? { error: body.error || '浏览器侧失败' } : body.value);
      sendJson(res, 200, { ok: true }, origin);
    },
  });

  /** 通过 SSE 让浏览器执行一次能力调用，并等回执。 */
  function callBrowser(op, payload) {
    const callId = 'call-' + randomUUID();
    if (!clients.size) {
      return Promise.reject(new Error('浏览器侧没有连接（扩展未打开或未连上 ' + STREAM_PATH + '）'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingTools.delete(callId);
        reject(new Error('浏览器侧超时（' + TOOL_TIMEOUT_MS + 'ms）：' + op));
      }, TOOL_TIMEOUT_MS);
      pendingTools.set(callId, { resolve, timer });
      broadcast({ kind: 'tool-call', callId, op, payload: payload === undefined ? null : payload });
    });
  }

  // --- 工具注册：一个通用入口（第一版），后续按需拆成具体工具 -------------------
  ctx.tools.register({
    name: 'recallflow_browser',
    description:
      '在用户当前打开的网页上执行一次操作（由浏览器扩展完成）。' +
      'op 取值：read（读正文）、console（读控制台）、network（读网络）、screenshot（截图）、' +
      'health（页面健康度）、eval（在页面里执行 JS）。' +
      '这是 RecallFlow 的页面能力，与 DSH 同处一条会话。',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['read', 'console', 'network', 'screenshot', 'health', 'eval'],
          description: '要执行的操作',
        },
        url: { type: 'string', description: 'read 用：要读的地址（默认当前页）' },
        code: { type: 'string', description: 'eval 用：要执行的 JS' },
        filter: { type: 'string', description: 'network 用：URL 子串过滤' },
        limit: { type: 'number', description: '条数上限' },
      },
      required: ['op'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    execute: async (args) => callBrowser(String(args && args.op), args),
  });

  log('已装载：' + [STREAM_PATH, SAY_PATH, RESULT_PATH].join(' / ') + ' + 工具 recallflow_browser');
}

/**
 * RecallFlow ↔ DSH 单插件集成。
 *
 * 设计目标（用户原话）：
 *   「以 dsh 为主，recallflow 也可以对话，两者能够同步，但是确实应该是基于 dsh 的 session
 *     就行，根本不需存在着什么同步呢」
 *
 * 所以这里**没有同步**：只有一条会话。整个集成只有一个进程（DSH 自己）、一个端口
 * （DSH 自己的 3080），不需要任何外部中继。
 *
 * 对外只有两件事：
 *   POST /recallflow/say   → 面板打的字变成**这条会话的真实用户消息**（能唤醒空闲会话）
 *   WS   /recallflow/ws    → 一条双向通道：会话事件 + 工具调用/回执
 *
 * 为什么是 WebSocket 而不是 SSE（我一度选了 SSE，后来推翻）：
 *   浏览器扩展的 MV3 service worker 空闲约 30 秒会被回收，而 `fetch` 流**不能**阻止回收；
 *   WebSocket 活动在 Chrome 里是明确的保活条件。工具调用必须**在面板关闭时也能用**，
 *   所以那条通道只能由 service worker 持有 —— SSE 在这里是错的。
 *   代价：要在 DSH 里实现 WS 握手。做法是借 DSH 自己依赖树里的 `ws`
 *   （实测：createRequire(process.argv[1]).resolve('ws') 能解析到，见下方 resolveWs）。
 *
 * 关键依据（均为实测或读自类型声明，详见 docs/one-session-plugin.md）：
 *   - agent.send(msg, 'next-turn', true)：实测能产生真 user/message + 唤醒空闲 driver + 开启新一轮
 *   - 载荷 source.kind 必须是 'user'：实测自定义 kind 只会落成模型侧上下文
 *   - webServer.register(route)：注释原文 "may hold the response open, e.g. SSE"
 *   - webServer.registerUpgrade(route)：handler 拿到 (req, socket, head)，**协议协商与 socket 归自己**
 *   - ctx.tools.register({name,description,parameters,output:{schema,render},execute})
 *   - inject 必须声明服务名，否则读取报 "cannot get property … without inject"
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const name = 'recallflow-one';
export const inject = ['agents', 'tools', 'webServer'];

const WS_PATH = '/recallflow/ws';
const SAY_PATH = '/recallflow/say';
const STATUS_PATH = '/recallflow/status';
const PROBE_TOOL_PATH = '/recallflow/probe-tool';

/** 工具调用等待浏览器回执的上限。 */
const TOOL_TIMEOUT_MS = 30000;
/** 只放行本机来源与扩展来源（不放行 * ，否则任意网页都能读本机）。 */
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

function sessionIdOf(session) {
  if (!session) return '';
  if (typeof session === 'string') return session;
  const id = session.id !== undefined ? session.id : session.sessionId;
  return id === undefined || id === null ? '' : String(id);
}

/**
 * 借 DSH 自己依赖树里的 `ws`。
 *
 * 为什么不直接 `import 'ws'`：插件是从本仓库链接进来的，Node 从**本仓库**往上找
 * 找不到 ws（实测 ERR_MODULE_NOT_FOUND）。而插件运行在 DSH 进程内，
 * 进程的 argv[1] 就是 DSH 的 bin —— 用 createRequire 从那里解析即可（实测成功）。
 * 先试普通 import（万一以后 ws 被装到插件旁边），再退到借 DSH 的。
 */
async function resolveWs(log) {
  const tried = [];
  try {
    const m = await import('ws');
    if (m && (m.WebSocketServer || (m.default && m.default.WebSocketServer))) {
      return m;
    }
    tried.push('import ws：拿到了模块但没有 WebSocketServer 导出');
  } catch (e) {
    tried.push('import ws：' + (e.code || e.message));
  }

  // 插件运行在 DSH 进程内，因此从进程自己的入口去解析它的依赖树。
  // 注意：不同启动方式下 argv[1] 可能不是 DSH 的 bin，所以把候选与失败原因都记下来。
  const anchors = [process.argv[1], process.argv[0], process.execPath].filter(Boolean);
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor);
      const p = req.resolve('ws');
      // Windows 上 import() **不接受裸绝对路径**（会报 ERR_UNSUPPORTED_ESM_URL_SCHEME），
      // 必须先转成 file:// URL。这个错误我第一次没发现，是因为早先的探针只做了 resolve、
      // 没有真的 import —— 是插件里的诊断日志把它打出来的。
      const m = await import(pathToFileURL(p).href);
      if (m && (m.WebSocketServer || (m.default && m.default.WebSocketServer))) {
        if (log) log('ws 解析成功（anchor=' + anchor + '）→ ' + p);
        return m;
      }
      tried.push('anchor ' + anchor + '：解析到 ' + p + ' 但没有 WebSocketServer');
    } catch (e) {
      tried.push('anchor ' + anchor + '：' + (e.code || e.message));
    }
  }

  if (log) {
    log('resolveWs 全部失败');
    log('  argv=' + JSON.stringify(process.argv.slice(0, 3)));
    log('  execPath=' + process.execPath);
    for (const t of tried) log('  · ' + t);
  }
  return null;
}

export function apply(ctx, config = {}) {
  const log = (m) => {
    try {
      console.log('[recallflow-one] ' + m);
    } catch {}
  };

  // --- 会话选择：只有一条会话，插件只需知道"面板说的是哪一条" -------------------
  /** sessionId → { agent, lastAt } */
  const sessions = new Map();
  let currentSessionId = '';

  // 会话事件的计数：分辨"事件没来"与"事件来了但处理失败"（见下方 session/event 处理的注释）
  const stats = {
    eventsSeen: 0,
    eventsBroadcast: 0,
    eventsDropped: 0,
    eventsErrors: 0,
    lastEventType: '',
    lastEventError: '',
    // 最近若干条**投影结果**（发给面板的原文）。
    // 为什么留这个：面板上"看不到助手的文字"这类问题，从外面只能靠猜 ——
    // 事件到底发了什么形状？text 取到了没有？留下投影原文就能直接看，
    // 而不是再去加一轮"先怀疑 A 再怀疑 B"的往返。
    recent: [],
  };
  const RECENT_MAX = 20;

  function pickSession(preferred) {
    if (preferred && sessions.has(preferred)) return sessions.get(preferred);
    if (currentSessionId && sessions.has(currentSessionId)) return sessions.get(currentSessionId);
    let best = null;
    for (const entry of sessions.values()) {
      if (!best || (entry.lastAt || 0) > (best.lastAt || 0)) best = entry;
    }
    if (best) return best;

    // 兜底：从官方注册表里找。
    //
    // 为什么必须有这一步（实测缺陷）：插件只通过 'agent/created' 认识 agent，
    // 而 **DSH 启动时恢复的会话，其 agent 在插件加载之前就已建好** —— 那个事件不会再发。
    // 表现就是：路由通了、工具也注册上了，但 POST /recallflow/say 回
    // "没有可用的会话"。我在旧插件里修过同一个问题，却没有把教训带进新插件。
    //
    // 两条路都试：先按 id 精确查（AgentRegistry.get(id) —— 类型声明里写明 id 是
    // "agent 与 session 共享的 id"，旧插件里实测能查到恢复的会话），
    // 再退回 list() 取最近的一条。
    try {
      const sid = currentSessionId || sessionIdOf(preferred);
      if (sid && ctx.agents && typeof ctx.agents.get === 'function') {
        const found = ctx.agents.get(sid);
        if (found) {
          sessions.set(sid, { agent: found, lastAt: Date.now() });
          log('从注册表按 id 补登记会话：' + sid);
          return sessions.get(sid);
        }
      }
      const list = ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : [];
      for (const agent of list) {
        const id = sessionIdOf(agent && agent.session);
        const key = id || '(registry-' + sessions.size + ')';
        sessions.set(key, { agent, lastAt: Date.now() });
        if (id && !currentSessionId) currentSessionId = id;
        log('从注册表 list() 补登记会话：' + key);
      }
      for (const entry of sessions.values()) {
        if (!best || (entry.lastAt || 0) > (best.lastAt || 0)) best = entry;
      }
    } catch (e) {
      log('读取注册表失败：' + String((e && e.message) || e));
    }
    return best;
  }

  /** 连接与登记状态：让"扩展有没有连上、会话有没有找到"可以从外部观测，不必靠日志。 */
  function statusSnapshot() {
    return {
      ok: true,
      wsPath: WS_PATH,
      sayPath: SAY_PATH,
      probeToolPath: PROBE_TOOL_PATH,
      wsReady: !!wss,
      clients: [...clients].filter((ws) => ws.readyState === 1).length,
      sessions: [...sessions.keys()],
      currentSessionId,
      pendingTools: pendingTools.size,
      // 会话事件的三项计数：用来分辨"事件没来"与"事件来了但处理失败"
      eventsSeen: stats.eventsSeen,
      eventsBroadcast: stats.eventsBroadcast,
      eventsDropped: stats.eventsDropped,
      eventsErrors: stats.eventsErrors,
      lastEventType: stats.lastEventType,
      lastEventError: stats.lastEventError,
      // 最近几条投影结果：用来回答"面板上为什么没有助手的话"
      recentEvents: stats.recent.slice(-10),
    };
  }

  // --- WebSocket 通道 ---------------------------------------------------------
  /** @type {Set<any>} */
  const clients = new Set();
  /** callId → { resolve, timer } */
  const pendingTools = new Map();
  let wss = null; // 懒建：第一次收到 upgrade 时才去解析 ws，避免 apply 变成异步

  function broadcast(obj) {
    const text = JSON.stringify(obj);
    for (const ws of clients) {
      try {
        if (ws.readyState === 1) ws.send(text);
      } catch {
        clients.delete(ws);
      }
    }
  }

  /** 会话事件投影成面板需要的最小信息（不改写、不截断）。 */
  function projectEvent(ev) {
    if (!ev || !ev.type) return null;
    const data = ev.data || {};
    const out = { type: String(ev.type) };
    if (data.role !== undefined) out.role = String(data.role);
    if (data.source && data.source.kind) out.sourceKind = String(data.source.kind);
    // rpcId：面板自己发出去的那句话，回声回来时带着同一个 id。
    // 面板靠它把"本地那条"与"回声那条"精确对齐，不必再靠文本猜。
    if (data.source && data.source.rpcId) out.rpcId = String(data.source.rpcId);
    // 文本在**哪个字段**按事件类型不同 —— 这是从已删的旧插件（session-map.js）里找回来的事实：
    //   user/message      → data.content
    //   assistant/message → data.message.content
    // 我第一版只读 data.content，于是 assistant/message 永远取不到 text，
    // classifyFrame 判"无文本"把它跳过 —— 表现就是**面板里看不见助手的回复**
    // （用户的话与工具活动都正常，所以这个 bug 很能藏）。
    // 教训：重写时把旧代码里"已验证的事实"一并丢掉，是这次真正的坑。
    const content =
      (Array.isArray(data.content) && data.content) ||
      (data.message && Array.isArray(data.message.content) && data.message.content) ||
      null;
    if (content) {
      const t = textOf(content);
      if (t) out.text = t;
    }
    if (data.tool) out.tool = String(data.tool);
    if (data.args !== undefined) out.args = data.args;
    if (ev.time !== undefined) out.time = ev.time;
    if (ev.seq !== undefined) out.seq = ev.seq;
    return out;
  }

  /** 处理浏览器侧发来的一条消息（抽出来是为了可单测，不需要真 WebSocket）。 */
  function handleClientMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'hello') {
      broadcast({ kind: 'hello', sessionId: currentSessionId, sessions: [...sessions.keys()] });
      return;
    }
    if (msg.kind === 'tool-result') {
      const waiter = pendingTools.get(String(msg.callId || ''));
      if (!waiter) return;
      clearTimeout(waiter.timer);
      pendingTools.delete(String(msg.callId));
      waiter.resolve(msg.ok === false ? { error: msg.error || '浏览器侧失败' } : msg.value);
      return;
    }
    if (msg.kind === 'ping') {
      // 扩展侧的心跳：回一条，保持双向可判活
      broadcast({ kind: 'pong' });
      return;
    }
    // 其余消息暂不处理（保持简单）
  }

  ctx.on('session/event', (session, ev) => {
    // 为什么这里要自己数、自己兜错：
    // 我用 watch-session-events.mjs 观察新通道时，12 秒内只收到 hello 与 pong、
    // **一条 session-event 都没有** —— 而当时我自己的回合正是活动的。
    // 那说明这个处理函数要么没被调用、要么中途抛错被外层吞掉（Cordis 的事件分发会吞）。
    // 光靠"外面看不到帧"无法区分这两种情况，所以这里把三件事都记下来并暴露到 /status：
    // 进来了多少条、广播出去多少条、抛错多少次（附带最后一次的事件类型与错误）。
    stats.eventsSeen++;
    stats.lastEventType = ev && ev.type ? String(ev.type) : '(无 type)';
    try {
      const sid = sessionIdOf(session);
      if (sid) {
        const entry = sessions.get(sid);
        if (entry) entry.lastAt = Date.now();
        currentSessionId = sid;
      }
      const projected = projectEvent(ev);
      if (projected) {
        broadcast({ kind: 'session-event', sessionId: sid, event: projected });
        stats.eventsBroadcast++;
        stats.recent.push(projected);
        if (stats.recent.length > RECENT_MAX) stats.recent.shift();
      } else {
        stats.eventsDropped++;
      }
    } catch (e) {
      stats.eventsErrors++;
      stats.lastEventError = String((e && e.message) || e);
      log('session/event 处理失败（不该发生，已计数）：' + stats.lastEventError);
    }
  });

  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent;
    if (!agent) return;
    const sid = sessionIdOf(agent.session);
    const key = sid || '(agent-' + sessions.size + ')';
    sessions.set(key, { agent, lastAt: Date.now() });
    if (sid) currentSessionId = sid;
    log('会话登记：' + key);
    broadcast({ kind: 'session-registered', sessionId: key });
  });

  ctx.on('agent/disposed', (payload) => {
    const sid = sessionIdOf(payload && payload.agent && payload.agent.session);
    if (sid) sessions.delete(sid);
  });

  // --- WS 路由（挂到 DSH 自己的服务上）---------------------------------------
  ctx.webServer.registerUpgrade({
    path: WS_PATH,
    handler: async (req, socket, head) => {
      const origin = req.headers && req.headers.origin;
      if (origin && !LOCAL_ORIGIN.test(origin) && !EXTENSION_ORIGIN.test(origin)) {
        log('拒绝非本机来源的 WS：' + origin);
        socket.destroy();
        return;
      }
      if (!wss) {
        const wsMod = await resolveWs(log);
        if (!wsMod) {
          log('✗ 解析不到 ws 模块，WS 通道不可用（工具与事件都推不出去）');
          socket.destroy();
          return;
        }
        const WS = wsMod.WebSocketServer || (wsMod.default && wsMod.default.WebSocketServer);
        wss = new WS({ noServer: true });
        log('ws 已就绪');
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        clients.add(ws);
        log('浏览器侧已连接（当前 ' + clients.size + ' 个）');
        try {
          ws.send(JSON.stringify({ kind: 'hello', sessionId: currentSessionId, sessions: [...sessions.keys()] }));
        } catch {}
        ws.on('message', (raw) => {
          let msg = null;
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return;
          }
          handleClientMessage(msg);
        });
        const bye = () => {
          clients.delete(ws);
          log('浏览器侧断开（剩 ' + clients.size + ' 个）');
        };
        ws.on('close', bye);
        ws.on('error', bye);
      });
    },
  });

  // --- 面板输入（一次性 POST，内容脚本用起来最简单）---------------------------
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
        // 实测：send(msg,'next-turn',true) 同时做到 产生真 user/message + 唤醒空闲 driver + 开启新一轮。
        // inject 只引导进行中的那一轮、不唤醒空闲会话，所以这里不用它。
        await picked.agent.send(message, 'next-turn', true);
        log('面板输入已送入会话：' + text.slice(0, 40));
        sendJson(res, 200, { ok: true, rpcId, sessionId: sessionIdOf(picked.agent.session) }, origin);
      } catch (err) {
        log('send 失败：' + String((err && err.message) || err));
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) }, origin);
      }
    },
  });

  // --- 状态路由：把"连没连上、会话找没找到"变成可观测的 -------------------------
  // 动机：排查时最费时间的不是修，而是不知道卡在哪一环。
  // 有了这条，外部一条 curl 就能回答：WS 有没有客户端、登记了哪些会话、有没有在等的工具调用。
  ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: (req, res) => {
      const origin = req.headers.origin;
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(origin));
        res.end();
        return;
      }
      sendJson(res, 200, statusSnapshot(), origin);
    },
  });

  // --- 工具往返探针：让"DSH ↔ 扩展 ↔ 页面"这条链路可被外部验证 ----------------
  // 动机：recallflow_browser 只能由模型调用。要确认这条路真的通，要么等模型调一次，
  // 要么有一个受控入口 —— 后者更可靠，也让排查不必依赖"模型有没有调"。
  // 只允许 BROWSER_METHODS 里的方法（都是读页面信息的那几个），不接受任意代码。
  ctx.webServer.register({
    kind: 'exact',
    path: PROBE_TOOL_PATH,
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
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (e) {
        sendJson(res, 400, { ok: false, error: '请求体不是 JSON：' + e.message }, origin);
        return;
      }
      const method = String(body.method || 'page_health');
      if (!BROWSER_METHODS.includes(method)) {
        sendJson(
          res,
          400,
          { ok: false, error: '不允许的方法：' + method + '（只允许 ' + BROWSER_METHODS.join('/') + '）' },
          origin
        );
        return;
      }
      try {
        const value = await callBrowser(method, body.params || {});
        sendJson(res, 200, { ok: true, method, value }, origin);
      } catch (err) {
        // 浏览器侧没连接时会走到这里 —— 明确报出来，而不是静默超时
        sendJson(res, 503, { ok: false, method, error: String((err && err.message) || err) }, origin);
      }
    },
  });

  /** 通过 WS 让浏览器执行一次能力调用，并等回执。 */
  function callBrowser(method, payload) {
    const callId = 'call-' + randomUUID();
    const live = [...clients].filter((ws) => ws.readyState === 1);
    if (!live.length) {
      return Promise.reject(new Error('浏览器侧没有连接（扩展未打开或未连上 ' + WS_PATH + '）'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingTools.delete(callId);
        reject(new Error('浏览器侧超时（' + TOOL_TIMEOUT_MS + 'ms）：' + method));
      }, TOOL_TIMEOUT_MS);
      pendingTools.set(callId, { resolve, timer });
      broadcast({ kind: 'tool-call', callId, method, payload: payload === undefined ? null : payload });
    });
  }

  /** 扩展侧 dispatch() 支持的方法名。列在这里是为了让模型知道能调什么，且不写死两份实现。 */
  const BROWSER_METHODS = [
    'browser_read',
    'read_console',
    'read_network',
    'get_element_source',
    'page_health',
    'verify_change',
    'get_picked_element',
    'screenshot_capture',
    'handoff_get',
    'handoff_list',
  ];

  // --- 工具注册：一个通用入口（第一版），后续按需拆成具体工具 -------------------
  ctx.tools.register({
    name: 'recallflow_browser',
    description:
      '在用户当前打开的网页上执行一次操作（由 RecallFlow 浏览器扩展完成，作用于当前活动标签页）。' +
      'method 取值：browser_read（读正文）/ read_console（读控制台）/ read_network（读网络）/' +
      'get_element_source（把元素对应到前端源码位置）/ page_health（页面健康度：新增报错与失败请求）/' +
      'verify_change（改动后核对元素状态与新问题）/ get_picked_element（用户在页面里拾取的元素）/' +
      'screenshot_capture（截图）/ handoff_get、handoff_list（读用户在面板里交接出来的会话）。' +
      '这是 RecallFlow 的页面能力，与 DSH 同处一条会话。',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: BROWSER_METHODS, description: '要执行的方法' },
        params: { type: 'object', additionalProperties: true, description: '该方法的参数（可选）' },
      },
      required: ['method'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    execute: async (args) => callBrowser(String(args && args.method), args && args.params),
  });

  log('已装载：' + [SAY_PATH, STATUS_PATH].join(' / ') + ' + WS ' + WS_PATH + ' + 工具 recallflow_browser');
}

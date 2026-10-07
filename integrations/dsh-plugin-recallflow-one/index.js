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
 *   - agent.send(msg, 'next-step', true)：实测能产生真 user/message + 唤醒空闲 driver + 开启新一轮
 *     （target 用 'next-step' 而非 'next-turn'：后者要等整轮结束、且轮次边界可能把它清掉 ——
 *      用户反馈"发了没反应"就是它。详见下方 /say 处的注释。）
 *   - 载荷 source.kind 必须是 'user'：实测自定义 kind 只会落成模型侧上下文
 *   - webServer.register(route)：注释原文 "may hold the response open, e.g. SSE"
 *   - webServer.registerUpgrade(route)：handler 拿到 (req, socket, head)，**协议协商与 socket 归自己**
 *   - ctx.tools.register({name,description,parameters,output:{schema,render},execute})
 *   - inject 必须声明服务名，否则读取报 "cannot get property … without inject"
 */

import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
// 结果加工与桥接**共用同一份**（lib/shared/tool-results.js）：
// 否则插件的 recallflow_browser 会返回未加工的原始 JSON —— 没有磁盘路径、没有 hint，
// 也就是删掉 DSH 的 MCP client 之后会静默失去「元素 → 源码文件」。
import { applyToolResult, cursorOverrideFrom, resolveTargets, toolCursorKey } from '../../lib/shared/tool-results.js';
// dev-session 也共用：桥接与插件必须读同一个文件，否则两边归一化不一致。
import { devCtx, readDevSession, writeDevSession } from '../../lib/shared/dev-session.js';
// 证据库同理：evidence_get 读的是同一份归档（插件本地就能答，不需要扩展参与）。
import { get as getEvidence, getByUrl as getEvidenceByUrl } from '../../lib/shared/evidence-store.js';

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

/**
 * tool/call 的 arguments 是 **JSON 字符串**（不是对象）—— 实测事实，见 DSH 自己的类型声明。
 * 解析失败就原样给出（不吞掉信息），与旧实现同样的取舍。
 */
function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : { value: v };
  } catch (e) {
    return { raw: s };
  }
}

function sessionIdOf(session) {  if (!session) return '';
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

  // 装载时记录**自身文件**的指纹。为什么需要：
  // 插件代码在 DSH 启动时载入，没有热重载 —— 于是"现在跑的是哪个版本"只能靠
  // 进程启动时间 vs 提交时间去**推断**（我就为此绕了好几轮）。有了这个，一条 curl 就能确定。
  // 刻意在装载时算一次（而不是每次 status 现算）：现算反映的是**磁盘现状**，
  // 而我们要回答的是"**已经载入**的是哪一版" —— 这两个在改了代码还没重启时**正好不同**。
  let build = null;
  try {
    const self = fileURLToPath(import.meta.url);
    const buf = fs.readFileSync(self);
    build = {
      file: self,
      bytes: buf.length,
      mtimeMs: Math.round(fs.statSync(self).mtimeMs),
      sha256_12: createHash('sha256').update(buf).digest('hex').slice(0, 12),
    };
  } catch (e) {
    build = { error: String((e && e.message) || e) };
  }

  // 会话事件的计数：分辨"事件没来"与"事件来了但处理失败"（见下方 session/event 处理的注释）
  const stats = {
    eventsSeen: 0,
    eventsBroadcast: 0,
    // 名字原来叫 eventsDropped —— 那是个**误导**：它不是"丢包"，而是
    // "投影不出可展示的信息"。主要来源是**成功的 tool/result**（面板只画失败的工具行，
    // 这是刻意的）以及少数不认识的帧类型。改名后不会再让人误以为在丢事件。
    eventsUnprojected: 0,
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

  /**
   * 面板要的会话清单：**先补登记官方注册表，再列**。
   *
   * 为什么必须补（2026-10-08 实测）：`sessions` 只从"收到的会话事件"和"发消息时的兜底"里填，
   * 而那个兜底**只在 `sessions` 里找不到可用会话时才跑** —— 于是只要已经有 1 条会话在说话，
   * 列表就永远只有那 1 条。面板的选择器因此看起来"点了没反应"（其实只有一个真选项）。
   * 插件 inject 了 `agents`、确实能枚举，所以这里主动补一次。
   */
  function listAllSessions() {
    try {
      const list = ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : [];
      for (const agent of list) {
        const id = sessionIdOf(agent && agent.session);
        if (!id) continue;
        const prev = sessions.get(id);
        if (!prev) {
          // 新发现的补进来，但 `lastAt` 给 0：**不能刷成"现在"** ——
          // 那是"最近活动"的真实依据，补登记把它刷掉会让排序变成瞎猜。
          sessions.set(id, { agent, lastAt: 0 });
        } else if (!prev.agent) {
          prev.agent = agent;
        }
      }
    } catch (e) {
      log('枚举注册表失败：' + String((e && e.message) || e));
    }
    return [...sessions.entries()].map(([id, e]) => ({ id, lastAt: e.lastAt || 0 }));
  }

  /**
   * 严格按 id 找会话：**找不到就返回 null，绝不回退到别的会话**。
   *
   * 为什么需要单独一个（2026-10-08 加）：`pickSession` 的语义是"尽量找一个能用的会话"——
   * 指定一个不存在的 id 时它会一路回退到"最近活跃的那条"。那对**面板选择会话**是危险行为：
   * 用户以为消息进了 A 对话、实际进了 B，而且**没有任何报错**。消息进错对话比报错糟糕得多。
   * 所以"显式指定 id"这条路必须用这个：先查已登记的，再查官方注册表，都没有就 null。
   */
  function findSessionStrict(id) {
    const want = String(id || '').trim();
    if (!want) return null;
    if (sessions.has(want)) return sessions.get(want);
    try {
      if (ctx.agents && typeof ctx.agents.get === 'function') {
        const found = ctx.agents.get(want);
        if (found) {
          sessions.set(want, { agent: found, lastAt: Date.now() });
          log('按 id 从注册表补登记会话：' + want);
          return sessions.get(want);
        }
      }
    } catch (e) {
      log('按 id 查注册表失败：' + String((e && e.message) || e));
    }
    return null;
  }

  /** 连接与登记状态：让"扩展有没有连上、会话有没有找到"可以从外部观测，不必靠日志。 */
  // 工具注册的结果（2026-10-08 加）：实测过一次「路由都活着、工具却从模型工具表里消失」——
  // 而 DSH 没有日志目录、扩展的 console 捕获也是空的，**没有任何窗口能看到原因**。
  // 注册失败不该静默，所以把结果暴露到 /recallflow/status 里。
  let toolRegistered = false;
  let toolError = '';

  function statusSnapshot() {
    return {
      ok: true,
      wsPath: WS_PATH,
      sayPath: SAY_PATH,
      probeToolPath: PROBE_TOOL_PATH,
      wsReady: !!wss,
      clients: [...clients].filter((ws) => ws.readyState === 1).length,
      sessions: [...sessions.keys()],
      // 每个已知会话的最近活动时间：面板的"选择会话"用它排序与显示
      // （原来只有 id 列表，选不出"哪条是刚才在说的那条"）。
      // 走 listAllSessions()：它会**主动枚举注册表**，否则列表永远只有"说过话的那几条"。
      sessionList: listAllSessions(),
      currentSessionId,
      pendingTools: pendingTools.size,
      // 会话事件的计数：用来分辨"事件没来"与"事件来了但处理失败"
      eventsSeen: stats.eventsSeen,
      eventsBroadcast: stats.eventsBroadcast,
      eventsUnprojected: stats.eventsUnprojected,
      eventsErrors: stats.eventsErrors,
      lastEventType: stats.lastEventType,
      lastEventError: stats.lastEventError,
      // 已载入代码的指纹：回答"现在跑的是哪个版本"，不用再比进程启动时间
      build,
      // 工具注册的结果：回答"为什么模型看不到 recallflow_browser"
      toolRegistered,
      toolError,
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
    // 工具调用的字段位置 —— 实测事实（DSH 自己的类型声明，旧实现 session-map.js 里写着）：
    //   'tool/call': { turn, step, callId, name, arguments }   ← 名字在 name，且 arguments 是 **JSON 字符串**
    //   'tool/result': { turn, step, message: ToolResultMessage, error? }
    // 我第一版读的是 data.tool / data.args —— **两个都不存在**，于是工具行永远画不出来
    // （面板上那些 ⚙ 行其实来自旧栈，不是这里）。这与"助手文本读错字段"是同一类错误：
    // 重写时凭形状猜字段名，而不是把旧代码里已验证的事实搬过来。
    if (data.name !== undefined) out.tool = String(data.name);
    else if (data.tool !== undefined) out.tool = String(data.tool); // 兼容另一种形状
    // 记住 callId → 名字，供后面的 tool/result 反查（结果事件只带 toolCallId）
    rememberCall(data.callId, out.tool);
    const rawArgs = data.arguments !== undefined ? data.arguments : data.args;
    if (rawArgs !== undefined) out.args = parseToolArgs(rawArgs);

    // 工具**结果**：只在失败时投影（成功不画 —— 面板里一次调用只占一行，这是旧实现的取舍）。
    // 失败判定与取名同样照抄旧实现的事实：
    //   const failed = Boolean(d.error) || msg.isError === true;
    //   const name = callNames.get(msg.toolCallId)      ← 名字要从前面的 tool/call 里记
    //   const reason = d.error.reason || d.error.code || d.error.name || '工具执行失败'
    if (out.type === 'tool/result') {
      const msg = data.message || {};
      const failed = Boolean(data.error) || msg.isError === true;
      if (!failed) return null;
      const name = callNames.get(msg.toolCallId) || out.tool || '';
      if (!name) return null; // 名字都不知道就画不出有信息量的一行
      out.tool = String(name);
      out.failed = true;
      const e = data.error || {};
      out.error = String(e.reason || e.code || e.name || '工具执行失败');
    }
    if (ev.time !== undefined) out.time = ev.time;
    if (ev.seq !== undefined) out.seq = ev.seq;
    return out;
  }

  /**
   * 记住 callId → 工具名，供 tool/result 反查（旧实现同样如此：结果事件只带 toolCallId）。
   * 上限 200 条，超了丢最旧的 —— 长会话里调用数远超这个数，不设上限就是内存泄漏。
   */
  const callNames = new Map();
  const MAX_TRACKED_CALLS = 200;
  function rememberCall(callId, name) {
    if (!callId || !name) return;
    callNames.set(String(callId), String(name));
    while (callNames.size > MAX_TRACKED_CALLS) {
      const oldest = callNames.keys().next().value;
      callNames.delete(oldest);
    }
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
        stats.eventsUnprojected++;
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
      // 显式指定会话时用**严格**查找：找不到就明确报错，绝不悄悄发给别的会话。
      // （`pickSession()` 是会回退的"尽力而为"版本，只适合"没指定"的情况。）
      const wanted = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      const picked = wanted ? findSessionStrict(wanted) : pickSession();
      if (wanted && !picked) {
        sendJson(
          res,
          404,
          {
            ok: false,
            error:
              '找不到指定的会话：' +
              wanted +
              '（当前已知会话：' +
              ([...sessions.keys()].join('、') || '无') +
              '）。为避免消息进错对话，这里**不会**回退到别的会话。',
          },
          origin
        );
        return;
      }
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
        // 实测：send(msg, <target>, true) 同时做到 产生真 user/message + 唤醒空闲 driver + 开启新一轮。
        // inject 只引导进行中的那一轮、不唤醒空闲会话，所以这里不用它。
        //
        // **target 用 'next-step' 而不是 'next-turn'** —— 2026-10-07 从用户反馈
        // （"recallflow 不能发消息"）查出来的：/say 返回 ok:true，但消息在会话里看不到。
        // 依据是 DSH 自己的类型声明（dsh-agent/lib/types/runtime-types.d.ts）：
        //   export type InboxTarget = 'next-turn' | 'next-step';
        //   send(message, target /* "the preferred next-turn or next-step inbox boundary" */, wakeup)
        //   还有一句关键的：cancel 之后 "…even when its **message is cleared before the driver claims** it"
        // 'next-turn' 要等到**整轮结束**才可能被取走；而这个会话连续跑目标轮时，
        // 消息会在轮次边界被清掉 —— 面板那边看起来就是"发了、没反应"。
        // 'next-step' 是**当前这一轮的下一个步骤**就取走。保留 send + wakeup：
        // 那条唤醒行为是我在隔离实例里实测过的。
        await picked.agent.send(message, 'next-step', true);
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
  /** 工具调用的增量游标（page_health / verify_change）：按标签页分组，本进程自己持有。 */
  const toolCursors = new Map();

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
    // ---- 只读档：第一批从面板本地助手接过来的能力 ----
    // 全部在 lib/assistant/tool-metadata.js 里标着 readOnly:true —— 只读，不改页面。
    // 放进 BROWSER_METHODS 是安全的：这个清单同时被 probe-tool 当白名单用，
    // 而"只读"正是那个白名单的语义（写操作如 dev_session_set 仍然排除在外）。
    'read_current_page', // 读当前标签页正文
    'get_page_snapshot', // 结构化页面快照（元素清单 + 内容指纹）
    'get_attribute', // 取元素属性
    'get_element_text', // 取元素文本
    'inspect_element', // 元素体检
    'extract_table', // 表格抽成结构化数据
    'wait_for_element', // 等元素出现（只等待，不改页面）
    'get_ax_snapshot', // 无障碍树快照
    'list_tabs', // 列出标签页
    'list_frames', // 列出框架
    'list_downloads', // 列出下载
    'take_screenshot', // 截图（与 screenshot_capture 同类的只读能力）
    'get_run_trace', // 读运行轨迹（诊断用）
    'web_search', // 网页搜索（readOnly，走网络）
    'search_knowledge_base', // 检索知识库
    'list_knowledge_base', // 列出知识库条目
    'get_entry', // 读单条知识库条目
    'list_macros', // 列出宏
    'list_userscripts', // 列出用户脚本
  ];

  /** 改页面档（第二档）：会**修改用户正在看的页面**。
   *
   * **审批策略**：DSH 这侧没有面板那样的批准弹窗，所以"批准"只能是**用户显式开的开关** ——
   * 这一档默认**拒绝**，除非 profile 里这个插件的 config 写了 `allowPageActions: true`：
   *
   *     - insert:
   *         - id: recallflow-one
   *           name: '…/integrations/dsh-plugin-recallflow-one/index.js'
   *           config: { allowPageActions: true }
   *
   * 这一档**刻意不放进 BROWSER_METHODS**：那个清单是 probe-tool 的白名单，
   * 于是"诊断探针永远不会触发改页面动作"成为一条可测试的性质（见 bridge-contract.test.mjs）。
   * 本清单必须与 lib/shared/bridge-methods.js 的 PAGE_ACTION_CONTENT_METHODS +
   * PAGE_ACTION_BACKGROUND_METHODS 一致（契约测试核对）。
   */
  const PAGE_ACTION_METHODS = [
    // route: content —— 对当前活动标签页动手
    'click_element', // 点元素
    'type_text', // 输入文本
    'press_key', // 按键
    'select_option', // 选下拉
    'check_box', // 勾选框
    'set_element_style', // 改元素样式
    'highlight_text', // 高亮页面里的关键句
    'outline_element', // 给元素描边
    'clear_page_overlays', // 清除上述标注/样式
    'scroll_page', // 滚动页面
    'undo_last_action', // 撤销上一次页面动作
    // route: background —— 自己决定对哪个标签页动手
    'click_at', // 按坐标点击
    'hover_element', // 悬停
    'drag_element', // 拖拽
    'handle_dialog', // 处理 alert/confirm
  ];

  /** 浏览器/网络档（第三档）：会开标签页、抓网页、装用户脚本 —— 但**不改用户数据**。
   * 开关：`config: { allowBrowserActions: true }`（默认拒绝）。 */
  const BROWSER_ACTION_METHODS = [
    'open_tab', // 新开标签页
    'switch_tab', // 切到某个标签页
    'fetch_webpage', // 抓取网页正文
    'search_userscripts', // 搜索用户脚本
  ];

  /** 危险档（第四档）：**写用户数据**或**执行代码**。
   * 开关：`config: { allowDangerousActions: true }`（默认拒绝）。
   *
   * `run_javascript` 是任意代码执行 —— 早先做探针时就刻意定了"不接受任意代码"，
   * 这是**继承下来的决定**。要开这一档，请当成一次明确的授权来对待。 */
  const DANGEROUS_METHODS = [
    'run_javascript', // 任意代码执行
    'run_userscript', // 执行用户脚本
    'add_entry', // 写知识库
    'remove_entry', // 删知识库条目
    'save_macro', // 存宏
    'upload_file', // 往页面上传文件
    'trust_site', // 把站点标记为可信
    'install_userscript', // 安装用户脚本
    'install_skill', // 安装技能
    'run_macro', // 执行宏
  ];

  /** 分档门禁表：审批逻辑集中一处，才审得清哪个开关管哪一档。
   *
   * DSH 这侧没有面板那样的批准弹窗，所以"批准"只能是用户在 profile 里**显式开的开关**。
   * 拒绝时**必须说清怎么开** —— 否则模型只会换参数反复重试，
   * 而多试几次里总有一次会真的点下去/写下去。
   */
  const TIER_GATES = [
    { list: PAGE_ACTION_METHODS, key: 'allowPageActions', what: '改页面档：会修改用户正在看的页面' },
    { list: BROWSER_ACTION_METHODS, key: 'allowBrowserActions', what: '浏览器/网络档：会开标签页、抓网页、装用户脚本' },
    { list: DANGEROUS_METHODS, key: 'allowDangerousActions', what: '危险档：会写用户数据或执行代码' },
  ];

  /** 插件**本地**就能答的方法：读的是本机共享文件（dev-session 与证据库），不需要扩展。
   *
   * 这三个原来只存在于桥接里，删除计划一度把 dev_session_* 与 evidence_get 记为
   * "没有对应物"。但它们的存储已经共享化了（lib/shared/dev-session.js、
   * evidence-store.js），插件读的是同一份文件 —— 所以能补上，且不需要浏览器。
   *
   * **不放进 BROWSER_METHODS**：那个清单被 probe-tool 当白名单用，而 dev_session_set 是写操作，
   * 不该从一个诊断入口触发。
   */
  const LOCAL_METHODS = ['dev_session_get', 'dev_session_set', 'evidence_get'];

  /** 工具接受的完整方法表 = 扩展侧只读档 + 改页面档 + 浏览器/网络档 + 危险档 + 本地。
   *
   * 受审批门禁的三档也在这里（所以模型**知道**它们存在、也能调用），但它们是否**被真正执行**
   * 由 config 开关决定 —— 清单管"存在"，开关管"允许"，两件事不能混。
   */
  const TOOL_METHODS = BROWSER_METHODS.concat(
    PAGE_ACTION_METHODS,
    BROWSER_ACTION_METHODS,
    DANGEROUS_METHODS,
    LOCAL_METHODS
  );

  // --- 工具注册：一个通用入口（第一版），后续按需拆成具体工具 -------------------
  // 包在 try/catch 里：这样注册失败时 apply 不会整个挂掉（路由已经注册好了，插件还有用），
  // 而且失败原因会进 /recallflow/status。**块内缩进刻意没动** —— 为一个 try 重排 100 行
  // 只会让 diff 无法阅读；JS 不在乎缩进，注释在这里说清楚就够了。
  try {
  ctx.tools.register({
    name: 'recallflow_browser',
    description:
      'RecallFlow 的入口：要么在用户当前打开的网页上执行一次操作（由浏览器扩展完成，作用于当前活动标签页），' +
      '要么读写本机的共享「开发会话」与证据归档（这三个不需要浏览器连接）。' +
      'method 取值：' +
      'browser_read（读正文，返回 fetchedAt/snapshotHash 可复核）/ read_console（读控制台）/' +
      'read_network（读网络）/ get_element_source（把元素对应到前端源码位置）/' +
      'page_health（页面健康度：自上次检查以来**新增**的报错与失败请求）/' +
      'verify_change（改动后核对元素状态与新问题）/ get_picked_element（用户在页面里拾取的元素）/' +
      'screenshot_capture（截图）/ handoff_get、handoff_list（读用户在面板里交接出来的会话）/ ' +
      'dev_session_get、dev_session_set（读/写 projectRoot 与 devUrl，以及 verify_change 的默认 targets）/ ' +
      'evidence_get（按 hash 或 url 取回已归档的页面证据）。' +
      // ---- 只读档（从面板本地助手接过来的第一批能力）----
      '只读档（都不修改页面，可以放心多调）：read_current_page（读当前标签页正文）/ ' +
      'get_page_snapshot（结构化页面快照：元素清单 + 内容指纹，适合据此选选择器）/ ' +
      'get_attribute、get_element_text、inspect_element（读元素属性/文本/体检）/ ' +
      'extract_table（表格抽成结构化数据）/ wait_for_element（等元素出现，只等待）/ ' +
      'get_ax_snapshot（无障碍树）/ list_tabs、list_frames、list_downloads（列标签页/框架/下载）/ ' +
      'take_screenshot（截图，与 screenshot_capture 同类）/ get_run_trace（读运行轨迹，诊断用）/ ' +
      'web_search（网页搜索）/ search_knowledge_base、list_knowledge_base、get_entry（知识库）/ ' +
      'list_macros、list_userscripts（列宏与用户脚本）。' +
      // ---- 受审批门禁的三档：暴露给模型（知道存在），但默认拒绝执行 ----
      '另有三个**默认关闭**的档位。它们都会"改变点什么"，而 DSH 这侧没有批准弹窗，' +
      '所以批准只能是用户显式设置的开关：' +
      '改页面档（allowPageActions：点击/输入/按键/下拉/勾选/滚动/高亮/描边/清除标注）、' +
      '浏览器与网络档（allowBrowserActions：开标签页/切标签页/抓网页/查用户脚本）、' +
      '危险档（allowDangerousActions：写或删知识库/存宏/上传文件/安装用户脚本与技能/执行 JS 与宏）。' +
      '调用这些方法会收到 refused 以及**怎么开启**的说明 —— ' +
      '**不要换参数反复重试**：那等于绕开用户的决定，而多试几次里总有一次会真的落下去。' +
      '这是 RecallFlow 的页面能力，与 DSH 同处一条会话。',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: TOOL_METHODS, description: '要执行的方法' },
        params: { type: 'object', additionalProperties: true, description: '该方法的参数（可选）' },
      },
      required: ['method'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    execute: async (args) => {
      const method = String((args && args.method) || '');
      const params = (args && args.params) || {};

      // 分档门禁：DSH 这侧没有面板那样的批准弹窗，所以"批准"只能是用户在 profile 里
      // 显式打开的开关。拒绝时要说清**怎么开**，否则模型只会换参数反复重试 ——
      // 那既浪费又危险（多试几次里总有一次会真的点下去/写下去）。
      for (const gate of TIER_GATES) {
        if (gate.list.includes(method) && config[gate.key] !== true) {
          return {
            refused: true,
            method,
            tier: gate.what,
            reason:
              '「' + method + '」属于' + gate.what + '，因此默认关闭。' +
              'DSH 这侧没有批准弹窗，所以批准 = 在这个插件的 profile 条目里显式开启：' +
              'config: { ' + gate.key + ': true }，然后重启 DSH。' +
              '只读档（读页面/元素/列表/搜索）不受影响，可以直接用。',
          };
        }
      }

      // 本地方法要在 callBrowser **之前**处理：它们读的是本机的共享文件，
      // 不需要浏览器连接 —— 否则会以"浏览器侧没有连接"失败（面板关着时尤其明显）。
      if (method === 'dev_session_get') return readDevSession();
      if (method === 'dev_session_set') return writeDevSession(params);
      if (method === 'evidence_get') {
        // 与桥接的 evidenceGet 逐字对齐：给 hash 按 hash 取，否则按 url 取最近一次。
        const rec = params.hash ? getEvidence(params.hash) : getEvidenceByUrl(params.url);
        return rec ? { found: true, snapshot: rec } : { found: false };
      }

      const raw = await callBrowser(method, params);

      // verify_change 的 targets 解析（本次调用优先，其次 dev-session）与桥接共用同一条规则。
      let targets = null;
      let targetsFromArgs = false;
      if (method === 'verify_change') {
        const resolved = resolveTargets(params.targets, readDevSession());
        if (resolved.error) return { ok: false, error: resolved.error };
        targets = resolved.targets;
        targetsFromArgs = resolved.fromArgs;
      }

      // 游标由**本进程**持有（语义是"自我上次检查以来"，与桥接各推进各的）。
      const key = toolCursorKey(raw);
      const override = cursorOverrideFrom(params);
      const { result } = applyToolResult(method, raw, devCtx(), {
        cursor: override === undefined ? toolCursors.get(key) || '' : override,
        onCursor: (c) => toolCursors.set(key, c),
        since: params.since,
        levels: params.levels,
        limit: params.limit,
        targets,
        targetsFromArgs,
        // browser_read 需要它来补 URL（扩展有时不回 url）
        fallbackUrl: params.url,
      });
      return result;
    },
  });
    toolRegistered = true;
  } catch (e) {
    toolError = String((e && e.message) || e);
    console.error('[recallflow] 工具注册失败（原因会出现在 /recallflow/status 的 toolError 里）：', e);
  }

  log('已装载：' + [SAY_PATH, STATUS_PATH, PROBE_TOOL_PATH].join(' / ') + ' + WS ' + WS_PATH + ' + 工具 recallflow_browser');
}

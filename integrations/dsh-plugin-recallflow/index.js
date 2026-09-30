// DSH 原生插件：把会话里的事（**含助手的成文回答**）同步到页面里的 RecallFlow 面板。
//
// 为什么必须是插件而不是 hook：DSH 的 Claude 风格 hook 载荷里没有助手文本
// （transcript_path 为空串、Stop 只有 stop_hook_active），见 integrations/dsh-hooks/README.md。
// 而会话事件里有 `assistant/message` —— 这是唯一干净的来源。
//
// 挂载点：Cordis 的 `session/event`（每个会话事件都会经过），
// 加上 `session/created` 以便在会话开始时给面板一句上下文。
//
// 与 hook 版本一样的三条取舍：
//   1. **绝不阻塞 DSH**：投递失败静默；本插件是"显示同步"的副作用，不该影响 agent 运行。
//   2. 跳过 mcp__* 工具（已由 MCP 服务端上报，避免面板画两遍）。
//   3. 只显示用户可见的文本（忽略 reasoning 块）。

import { createMapper, buildPanelContextPayload, isInjectedUserMessage, PANEL_CONTEXT_SOURCE_KIND } from './session-map.js';

/** 注入上下文时最多带面板的多少条回合（多了会挤占会话上下文预算）。 */
export const PANEL_CONTEXT_TURNS = 20;

/**
 * 铸一个消息 id。
 * DSH 用 `brandString(randomUUID())`（MessageId 在运行时就是字符串），
 * 我们只要保证唯一即可 —— 但**必须**有，见 session-map.js 里 buildPanelContextPayload 的说明。
 */
function newMessageId() {
  try {
    return 'recallflow-panel-' + crypto.randomUUID();
  } catch (e) {
    return 'recallflow-panel-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
  }
}

export const name = 'recallflow-panel-sync';
export const PLUGIN_VERSION = '0.1.0';

/** 允许在 config 里覆盖，便于测试与换端口。 */
export const DEFAULT_CONFIG = Object.freeze({
  port: 7801,
  token: 'recallflow-local-bridge-v1',
  timeoutMs: 2000,
  /** 只同步这些会话（空 = 全部）。会话 id 可从 session/created 拿到。 */
  sessionIds: Object.freeze([]),
});

// 注意：**不能** import `@deepseek-ai/schemastery` 来声明 Config ——
// 它只存在于 DSH 自己的 node_modules 里，而本插件位于用户仓库中，
// 从插件文件位置向上查找**解析不到**，反而会让装载失败。
// 因此这里不声明 Config；条目里的 config 由 apply(ctx, config) 自行容错读取
// （normalizeConfig 对缺字段/脏值都有默认值）。
/** 与 dsh-mcp-client 一致：本插件只订阅事件 + 按会话反查 agent，不注入其它 service。
 *  `agents` 是必须声明的依赖：Cordis 会等它就绪再调用 apply，
 *  否则访问 ctx.agents 会抛（未就绪的服务是抛错代理）。 */
export const inject = ['agents'];

function normalizeConfig(raw) {
  const c = Object.assign({}, DEFAULT_CONFIG, raw || {});
  c.port = Number.isFinite(Number(c.port)) ? Number(c.port) : DEFAULT_CONFIG.port;
  c.timeoutMs = Number.isFinite(Number(c.timeoutMs)) ? Number(c.timeoutMs) : DEFAULT_CONFIG.timeoutMs;
  c.sessionIds = Array.isArray(c.sessionIds) ? c.sessionIds.map(String) : [];
  return c;
}

/** 会话 id 的可能位置（不同版本字段名可能不同，全部兜住）。 */
function sessionIdOf(session) {
  return String((session && (session.id || (session.header && session.header.id))) || '');
}

/**
 * 给用户看短标识。
 * 真实 id 形如 `session-723c8b32-4ab3-...`：直接 slice(0,8) 只会得到 "session-"，
 * 等于没给任何区分信息 —— 所以先剥掉前缀。
 */
export function shortSessionId(id) {
  const s = String(id || '');
  const stripped = s.startsWith('session-') ? s.slice('session-'.length) : s;
  return stripped.slice(0, 8);
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const mapper = createMapper({ skipToolPrefix: config.skipToolPrefix });

  async function post(event) {
    try {
      await fetch('http://127.0.0.1:' + config.port + '/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RecallFlow-Token': config.token },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (e) {
      // 桥接没起来 / 面板没打开：静默。绝不让"显示同步"影响 DSH 运行。
    }
  }

  function wants(session) {
    if (!config.sessionIds.length) return true;
    return config.sessionIds.includes(sessionIdOf(session));
  }

  // **装载自报**：apply 一被调用就推一条。
  // 这是唯一能**直接**判定「插件是否真的被 loader 装载」的信号 ——
  // 否则只能靠"没收到事件"间接推断，而它无法区分
  // 「没装载」与「装载了但这次没产生会话事件」。
  void post({
    text: 'RecallFlow 同步插件已装载（v' + PLUGIN_VERSION + '，port ' + config.port + '）',
    who: 'dsh',
    level: 'info',
  });

  ctx.on('session/event', (session, event) => {
    try {
      if (!wants(session)) return;
      const mapped = mapper.map(event);
      if (mapped) void post(mapped);
      // 用户每次**真的说话**时补一次注入检查。两个可观测缺陷都由此修掉：
      //   1. DSH 启动时**恢复**的会话，其 agent 可能在插件订阅之前就建好了 ——
      //      只靠 agent/created 的话它永远拿不到注入（实测：用户当前会话注入 id 为 0，
      //      而同机隔离新建的会话有 1）。
      //   2. 此前"只在会话创建时注入一次"，会话中途面板有新内容也进不来。
      // 必须排除被注入的上下文自身（isInjectedUserMessage），否则它会触发自己，形成回环。
      if (event && event.type === 'user/message' && !isInjectedUserMessage(event.data)) {
        const agent = lookupAgent(session);
        if (agent) void injectPanelTurns(agent, session, '用户发言时').catch(() => {});
      }
    } catch (e) {
      // 映射出错也不能影响会话
    }
  });

  // 会话开始时给面板一句开场，让你知道"这个页面上看到的对话就是它"。
  ctx.on('session/created', (session) => {
    try {
      if (!wants(session)) return;
      const id = sessionIdOf(session);
      if (!id) return;
      void post({ text: 'DSH 会话已开始（' + shortSessionId(id) + '），以下同步它的对话与工具活动。', who: 'dsh', level: 'info' });
    } catch (e) {}
  });

  // 反向通道（面板 → DSH）：把面板最近的对话**注入**本会话的上下文。
  //
  // 用 DSH 官方的 `Agent.inject(message)`，而不是自己往会话里 append 事件：
  // 它的文档写明「不出动 driver，在最近的步边界被认领」，因此**不会打断运行中的循环**；
  // 自行注入会话事件则可能破坏 agent loop 的状态机，拿用户正在用的 DSH 冒险。
  //
  // 去重按**每会话**记录"已注入到哪一条（at）"：面板没新内容就不重复注入，
  // 多个会话也各自独立，不会互相抢走彼此的批次。
  const agentsByKey = new Map(); // 会话对象 或 会话 id → agent
  const injectedUpTo = new Map(); // 会话对象 或 会话 id → 已注入的最大 at

  function rememberAgent(agent, session) {
    // 同时按**对象身份**与**id**登记：我不确定 agent.session 在真实 DSH 里一定等于
    // session/event 收到的那一个对象，也可能拿不到 id。两个键都放，回查时都试。
    if (session) agentsByKey.set(session, agent);
    const sid = sessionIdOf(session);
    if (sid) agentsByKey.set(sid, agent);
  }

  function lookupAgent(session) {
    // 首选官方注册表。依据 dsh-agent 的类型声明：
    //   interface Context { agents: AgentRegistry }
    //   /** Look up a live agent. @param id - the shared agent/session id to look up. */
    //   get(id: SessionId): Agent | undefined;
    // 注意 "shared agent/session id" 这个说法 —— 因此拿 session id 就能取到 agent，
    // **完全不依赖 agent/created 是否触发过**。这正是「DSH 启动时恢复的会话拿不到注入」
    // 的根因：恢复的会话在插件订阅之前就已建好，那个事件不会再发。
    try {
      const sid = sessionIdOf(session);
      if (sid && ctx.agents && typeof ctx.agents.get === 'function') {
        const found = ctx.agents.get(sid);
        if (found) return found;
      }
    } catch (e) {
      /* 服务不可用就退回登记表 */
    }
    if (!session) return undefined;
    return agentsByKey.get(session) || agentsByKey.get(sessionIdOf(session));
  }

  function keyFor(session) {
    // **必须优先用稳定的 id**，不能用对象身份。
    //
    // 实测缺陷（用户连着说「你好」时暴露出来的）：注入了**同一批内容两次**，一字不差。
    // 根因是键不稳定：agent/created 传进来的是 agent.session，
    // session/event 传进来的是事件里的 session —— 同一个会话的**两个不同对象**。
    // 于是 injectedUpTo 里出现两条记录：一条被推进、另一条永远是 0，
    // 走另一条路径时就被判定为"从没注入过"，于是把整批内容又灌一遍。
    //
    // 用 id 作键之后两条路径共用同一条进度记录，重复注入消失。
    // （agentsByKey 仍然双键登记 —— 那只是"找 agent"的兜底，不影响进度去重。）
    return sessionIdOf(session) || '(no-id)';
  }

  async function injectPanelTurns(agent, session, reason) {
    if (!agent || typeof agent.inject !== 'function') return;
    if (!wants(session)) return;
    const key = keyFor(session);
    const res = await fetch(
      'http://127.0.0.1:' + config.port + '/panel-turns?limit=' + PANEL_CONTEXT_TURNS,
      { headers: { 'X-RecallFlow-Token': config.token }, signal: AbortSignal.timeout(config.timeoutMs) }
    );
    if (!res.ok) return;
    const data = await res.json();
    const all = (data && Array.isArray(data.turns) ? data.turns : []).filter(
      (t) => t && typeof t.text === 'string' && t.text
    );
    if (!all.length) return;
    const since = injectedUpTo.get(key) || 0;
    // 该会话此前从未注入过（since===0）时把当前的都算作新的；之后只取真正新增的。
    const fresh = since === 0 ? all : all.filter((t) => Number(t.at || 0) > since);
    if (!fresh.length) return;
    const injected = buildPanelContextPayload(fresh, newMessageId(), { max: PANEL_CONTEXT_TURNS });
    if (!injected) return;
    try {
      // 先推进进度再注入：即使 inject 抛错，也不该在下一轮把同一批重复推给它。
      injectedUpTo.set(key, all.reduce((m, t) => Math.max(m, Number(t.at || 0)), since));
      // 传**完整**消息（含 id）：inject 会原样放进 inbox，不替我们铸 id。见 session-map.js。
      agent.inject(injected);
      // 注入的**成败**变成面板上可见的一行：inject 是模型侧行为、界面看不见，
      // 而失败会被 catch 吞掉 —— 那样"注入没生效"与"面板本来没对话"外部无法区分。
      void post({
        text: '已将面板最近的 ' + fresh.length + ' 条对话注入本会话上下文（' + reason + '）。',
        who: 'dsh',
        level: 'info',
      });
    } catch (err) {
      void post({
        text: '⚠ 面板上下文注入失败（' + String((err && err.message) || err) + '）—— 面板对话未能进入本会话。',
        who: 'dsh',
        level: 'warn',
      });
    }
  }

  ctx.on('agent/created', (ev) => {
    void (async () => {
      try {
        const agent = ev && ev.agent;
        if (!agent || typeof agent.inject !== 'function') return;
        rememberAgent(agent, agent.session);
        await injectPanelTurns(agent, agent.session, '会话开始');
      } catch (e) {
        // 注入失败绝不影响会话创建
      }
    })();
  });

  // agent 离场时清掉登记与进度，避免长跑进程里 Map 无限增长。
  ctx.on('agent/disposed', (ev) => {
    try {
      const session = ev && ev.agent && ev.agent.session;
      if (session) {
        agentsByKey.delete(session);
        injectedUpTo.delete(session);
      }
      const sid = sessionIdOf(session);
      if (sid) {
        agentsByKey.delete(sid);
        injectedUpTo.delete(sid);
      }
    } catch (e) {}
  });
}

export default { name, apply, DEFAULT_CONFIG };

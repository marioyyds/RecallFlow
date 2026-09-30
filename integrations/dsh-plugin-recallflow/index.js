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

import { createMapper, buildPanelContextPayload, PANEL_CONTEXT_SOURCE_KIND } from './session-map.js';

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
/** 与 dsh-mcp-client 一致：本插件只订阅事件，不注入任何 service。 */
export const inject = [];

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

  // 反向通道（面板 → DSH）：会话创建时把面板最近的对话**注入**本会话的上下文，
  // 这样不需要用户或模型主动想起去调 panel_history。
  //
  // 用 DSH 官方的 `Agent.inject(message)`，而不是自己往会话里 append 事件：
  // 它的文档写明「不出动 driver，在最近的步边界被认领」，因此**不会打断运行中的循环**；
  // 自行注入会话事件则可能破坏 agent loop 的状态机，拿用户正在用的 DSH 冒险。
  // 只在创建时注入一次：行为可预期，且不会在会话中途改变上下文。
  ctx.on('agent/created', (ev) => {
    void (async () => {
      try {
        const agent = ev && ev.agent;
        if (!agent || typeof agent.inject !== 'function') return;
        if (!wants(agent.session)) return;
        const res = await fetch(
          'http://127.0.0.1:' + config.port + '/panel-turns?limit=' + PANEL_CONTEXT_TURNS,
          { headers: { 'X-RecallFlow-Token': config.token }, signal: AbortSignal.timeout(config.timeoutMs) }
        );
        if (!res.ok) return;
        const data = await res.json();
        // 变量名不能叫 payload：外层事件参数曾叫 payload，同作用域内再 const 同名会从作用域
        // 开头就遮蔽它，导致上面读 `ev` 之前先撞 TDZ（ReferenceError 被 catch 吞成静默）。
        const injected = buildPanelContextPayload(data && data.turns, newMessageId(), {
          max: PANEL_CONTEXT_TURNS,
        });
        if (!injected) return;
        // 把注入的**成败**变成面板上可见的一行。
        // 原因：inject 是模型侧行为，界面上看不见；而失败会被下面的 catch 吞掉 ——
        // 那样「注入没生效」与「面板本来没对话」在外部完全无法区分。
        // 这条诊断本身也走同一条桥接，因此它能否出现在面板上，
        // 顺带证明了正向链路此刻是通的。
        try {
          // 传**完整**消息（含 id）：inject 会原样放进 inbox，不替我们铸 id。见 session-map.js。
          agent.inject(injected);
          const n = (data && data.turns && data.turns.length) || 0;
          void post({ text: '已将面板最近的 ' + n + ' 条对话注入本会话上下文。', who: 'dsh', level: 'info' });
        } catch (err) {
          void post({
            text: '⚠ 面板上下文注入失败（' + String((err && err.message) || err) + '）—— 面板对话未能进入本会话。',
            who: 'dsh',
            level: 'warn',
          });
        }
      } catch (e) {
        // 注入失败绝不影响会话创建
      }
    })();
  });
}

export default { name, apply, DEFAULT_CONFIG };

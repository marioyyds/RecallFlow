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

import { createMapper } from './session-map.js';

export const name = 'recallflow-panel-sync';

/** 允许在 config 里覆盖，便于测试与换端口。 */
export const DEFAULT_CONFIG = Object.freeze({
  port: 7801,
  token: 'recallflow-local-bridge-v1',
  timeoutMs: 2000,
  /** 只同步这些会话（空 = 全部）。会话 id 可从 session/created 拿到。 */
  sessionIds: Object.freeze([]),
});

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
}

export default { name, apply, DEFAULT_CONFIG };

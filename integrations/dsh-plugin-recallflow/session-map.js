// DSH 会话事件 → RecallFlow 面板事件（纯映射，可直测）。
//
// 这是方案 B 的核心：**hook 拿不到助手的话，会话事件能拿到**。
// 依据（都来自 DSH 的类型声明，非猜测）：
//   dsh-session/lib/types/types.d.ts
//     SessionEvent = { type, data }            ← 载荷在 data
//     'assistant/message': { turn, step, message: AssistantMessage, stream, usage?, interrupted? }
//     'user/message': UserMessage             ← data 本身就是消息
//     'tool/call': { turn, step, callId, name, arguments }   ← arguments 是 JSON 字符串
//     'tool/result': { turn, step, message: ToolResultMessage, error? }
//   dsh-llm/lib/types/types.d.ts
//     TextBlock { type:'text', text }         ← 只取 text，忽略 reasoning / tool-call
//     ReasoningBlock { type:'reasoning', text }  ← **不是**用户可见的话，不能当回答显示
//   dsh-llm/lib/types/message.d.ts
//     MessageBase.content: readonly ContentBlock[]；ToolResultMessage.toolCallId

/** RecallFlow 自己的 MCP 工具已由 MCP 服务端以更细粒度上报，这里跳过以免面板画两遍。 */
export const SKIP_TOOL_PREFIX = 'mcp__';

/**
 * 从内容块里取**用户可见的文本**。
 * 刻意忽略 reasoning 块：那是模型的思考，不是它说的话，显示出来会误导用户。
 */
export function textFromBlocks(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type !== 'text') continue;
    if (typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
  }
  return parts.join('\n\n').trim();
}

/**
 * DSH 会把**系统注入的运行时上下文**也作为 `user/message` 投递
 * （实测文本以 "Current runtime context. This snapshot supersedes…" 开头）。
 * 不过滤的话，面板会把一大段系统文本显示成「👤 你在 DSH：…」—— 用户从没说过这句话。
 *
 * 判别依据来自 DSH 的类型声明（非猜测）：
 *   dsh-agent-loop/lib/types/runtime-context.d.ts
 *     MessageSourceMap 里注册了 'runtime-context': { kind: 'runtime-context' } & ContextFormed
 *
 * 刻意用**拒绝名单**而不是允许名单：漏判的代价是面板上多一段噪音，
 * 误判的代价是**吞掉用户真正说过的话** —— 后者严重得多。
 */
export const INJECTED_SOURCE_KINDS = Object.freeze(['runtime-context', 'recallflow-panel']);
const INJECTED_TEXT_PREFIXES = Object.freeze(['Current runtime context', 'This snapshot supersedes']);

export function isInjectedUserMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const src = msg.source;
  const kind = src && typeof src === 'object' ? String(src.kind || '') : '';
  if (kind && INJECTED_SOURCE_KINDS.includes(kind)) return true;
  const text = textFromBlocks(msg.content);
  // 没有任何用户可见文本的 user 消息没有显示价值（纯工具回填等）
  if (!text) return true;
  for (const p of INJECTED_TEXT_PREFIXES) {
    if (text.startsWith(p)) return true;
  }
  return false;
}

/** 面板上下文注入时用的 source.kind。同时也把它列进 INJECTED_SOURCE_KINDS —— 否则
 *  我们自己注入的这段上下文会被当成"用户说的话"再推回面板，形成回环。 */
export const PANEL_CONTEXT_SOURCE_KIND = 'recallflow-panel';
export const PANEL_CONTEXT_MARKER = '【浏览器 RecallFlow 面板最近的对话】';

function clip(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * 把面板的最近对话拼成一段**给模型看的上下文**（纯函数，可直测）。
 *
 * 用途：DSH 的 `Agent.inject(message)` 是官方给的注入口 —— 文档明确它
 * 「不出动 driver，在最近的步边界被认领」，因此不会打断运行中的循环。
 * 我们只在会话创建时注入一次，把"面板里刚聊过什么"带进新会话。
 *
 * 文本里刻意写明这是**另一个 agent** 的对话：面板助手与 DSH 里的 agent 是两个不同的
 * 实体，混为一谈会让模型把别人的结论当成自己的 —— 这一点必须写在上下文里，
 * 不能只写在工具描述里（模型未必会去调工具）。
 */
export function buildPanelContextMessage(turns, options = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const raw = Number(options.max);
  const max = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
  const perTurn = Number.isFinite(Number(options.perTurn)) && Number(options.perTurn) > 0 ? Math.floor(Number(options.perTurn)) : 400;
  const recent = list.filter((t) => t && typeof t.text === 'string' && t.text).slice(-max);
  if (!recent.length) return '';
  const lines = recent.map((t) => (t.role === 'user' ? '用户：' : '面板助手：') + clip(t.text, perTurn));
  return (
    PANEL_CONTEXT_MARKER + '\n' +
    lines.join('\n') + '\n' +
    '（说明：这是用户在浏览器页面上的 RecallFlow 面板里，与**另一个**助手 agent 的对话，' +
    '不是用户对你说的，也不是你说过的话。需要更多上下文时用 panel_history 工具读取。）'
  );
}

/**
 * 拼出**完整的**注入载荷（纯函数：id 由调用方传入，便于测试）。
 *
 * 为什么必须自己补齐 `id` 并冻结 —— 这不是形式主义，是读实现得出的结论：
 *   dsh-agent-loop/lib/index.js
 *     inject(input) { this.send(input, "next-step", false); }   // 原样透传
 *     send(message, target, wakeup) { … this.inbox.splice(…, [message]); }  // 原样入队
 * 即 `inject` **不会**帮你调用 `createMessage`。而：
 *   dsh-llm/lib/types/message.d.ts
 *     interface MessageBase { readonly id: MessageId; … }        // id 必填
 *     createMessage(input) { … id: brandString(randomUUID()) }   // 官方在此铸 id
 *     …并 structuredClone + deepFreeze
 * 所以只给 { role, content, source } 的话，消息**缺少稳定身份**，
 * 下游抛错后被本插件的 catch 吞掉 —— 表现与"面板本来没对话"完全一样，无法察觉。
 *
 * `MessageId = Branded<'MessageId'>` 在运行时就是字符串，因此这里铸一个唯一字符串即可。
 */
export function buildPanelContextPayload(turns, id, options = {}) {
  const text = buildPanelContextMessage(turns, options);
  if (!text) return null;
  return Object.freeze({
    id: String(id || ''),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: PANEL_CONTEXT_SOURCE_KIND }),
  });
}

/** tool/call 的 arguments 是 JSON 字符串；解析失败就原样给出（不吞掉信息）。 */ export function parseToolArguments(raw) {
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

/**
 * 建立有状态的映射器。
 * 需要状态的原因：`tool/result` 只带 `toolCallId`，工具名要从前面的 `tool/call` 里记。
 */
export function createMapper(options = {}) {
  const skipPrefix = options.skipToolPrefix === undefined ? SKIP_TOOL_PREFIX : options.skipToolPrefix;
  const callNames = new Map(); // callId → name
  const MAX_TRACKED = 200;

  function remember(callId, name) {
    if (!callId) return;
    callNames.set(callId, name);
    // 上限：长会话里 callId 会累积；面板只关心最近的调用
    while (callNames.size > MAX_TRACKED) {
      const oldest = callNames.keys().next().value;
      callNames.delete(oldest);
    }
  }

  return {
    /** @returns 面板事件（见 panel-events.js 的形状）或 null（本次没什么可显示的） */
    map(event) {
      const type = event && event.type;
      const d = (event && event.data) || {};

      if (type === 'assistant/message') {
        const text = textFromBlocks(d.message && d.message.content);
        if (!text) return null; // 纯工具调用的回合没有说话，不该产生一条空气泡
        return { text, who: 'dsh', level: 'info' };
      }

      if (type === 'user/message') {
        // 系统注入的运行时上下文也走 user/message（见 isInjectedUserMessage）——
        // 不过滤就会把一大段系统文本显示成「👤 你在 DSH：…」。
        if (isInjectedUserMessage(d)) return null;
        const text = textFromBlocks(d.content);
        if (!text) return null;
        return { text, who: 'user', level: 'info' };
      }

      if (type === 'tool/call') {
        const name = String(d.name || '');
        if (!name) return null;
        if (skipPrefix && name.startsWith(skipPrefix)) return null;
        remember(d.callId, name);
        return { kind: 'tool', phase: 'start', tool: name, args: parseToolArguments(d.arguments) };
      }

      if (type === 'tool/result') {
        const msg = d.message || {};
        const name = callNames.get(msg.toolCallId) || '';
        const failed = Boolean(d.error) || msg.isError === true;
        // 成功的结束不产出事件（面板一次调用只画一行）；失败才值得单独一行。
        if (!failed || !name) return null;
        const reason = (d.error && (d.error.reason || d.error.code || d.error.name)) || '工具执行失败';
        return { kind: 'tool', phase: 'end', tool: name, ok: false, ms: 0, error: String(reason) };
      }

      return null;
    },
    /** 供测试与诊断 */
    trackedCount() {
      return callNames.size;
    },
  };
}

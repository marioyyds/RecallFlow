// Durable agent history compression and provider-safe tool pairing.
import { CONTEXT_TUNING } from '../../assistant/context-tuning.ts';
import { formatTailKeptTruncationNotice } from '../../assistant/context.ts';

export const SESSION_MESSAGE_MAX_CHARS = CONTEXT_TUNING.sessionMessageMaxChars;
export const SESSION_MAX_TAIL_MESSAGES = CONTEXT_TUNING.sessionMaxTailMessages;

// 修正 tool 调用配对：OpenAI 兼容接口要求每个 tool 结果都有对应的 assistant.tool_calls，
// 且 assistant.tool_calls 的每个 id 都必须有结果。截断/中断可能破坏配对，
// 这里剔除「无 provider 的 tool 消息」与「结果不全的 assistant tool_calls 消息」。
export function sanitizeToolPairing(list: any) {
  const source = Array.isArray(list) ? list : [];
  const isCallAssistant = (m: any) => m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  let out = source;
  // 1) assistant 带 tool_calls，但并非每个 id 都有对应 tool 结果 → 整条去掉（否则请求非法）。
  let resultIds = new Set(out.filter((m) => m && m.role === 'tool' && m.tool_call_id).map((m) => m.tool_call_id));
  out = out.filter((m) => !isCallAssistant(m) || m.tool_calls.every((tc: any) => tc && resultIds.has(tc.id)));
  // 2) tool 结果没有对应的 assistant tool_calls（provider 被裁掉/剔除）→ 去掉孤儿结果。
  const providerIds = new Set();
  for (const m of out) if (isCallAssistant(m)) for (const tc of m.tool_calls) if (tc && tc.id) providerIds.add(tc.id);
  out = out.filter((m) => !(m && m.role === 'tool' && !providerIds.has(m.tool_call_id)));
  return out;
}

export function compactSessionMessages(messages: any) {
  const source = Array.isArray(messages) ? messages : [];
  const system = source.find((message) => message && message.role === 'system');
  const rest = source.filter((message) => message !== system);
  const tail = sanitizeToolPairing(rest.slice(-SESSION_MAX_TAIL_MESSAGES));
  const notices = [];
  // ① 整条消息被上限丢掉：补一条**可辨认的**说明，而不是让接手方以为对话就这么短。
  const droppedMessages = rest.length - Math.min(rest.length, SESSION_MAX_TAIL_MESSAGES);
  if (droppedMessages > 0) {
    notices.push({
      role: 'user',
      content:
        '⟨…更早的 ' + droppedMessages + ' 条消息未随快照保存（落盘上限 ' + SESSION_MAX_TAIL_MESSAGES +
        ' 条）；**这些消息取不回原文**，需要时请让用户重新说明上下文。⟩',
    });
  }
  const compacted = tail.map((message) => {
    const copy: any = { role: message.role };
    if (typeof message.content === 'string') {
      // ② 单条超长：留尾（结论通常在后面），并**前置**说明被截掉的是开头那段。
      copy.content =
        message.content.length > SESSION_MESSAGE_MAX_CHARS
          ? formatTailKeptTruncationNotice(message.content.length, SESSION_MESSAGE_MAX_CHARS) +
            message.content.slice(-SESSION_MESSAGE_MAX_CHARS)
          : message.content;
    } else if (message.content !== undefined) copy.content = message.content;
    if (Array.isArray(message.tool_calls)) copy.tool_calls = message.tool_calls.slice(-8);
    if (message.tool_call_id) copy.tool_call_id = message.tool_call_id;
    return copy;
  });
  return (system ? [system, ...notices, ...compacted] : [...notices, ...compacted]);
}


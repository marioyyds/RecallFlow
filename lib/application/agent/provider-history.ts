// Convert internal conversation records into provider-facing chat messages.
// Internal UI metadata (for example `lane`) must never be sent to a model.

export interface ProviderMessageSettings {
  model?: string;
  baseUrl?: string;
}

function systemContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
          return String((part as Record<string, unknown>).text);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  try {
    return JSON.stringify(content);
  } catch (e) {
    return '';
  }
}

/**
 * 将任意位置的 system 消息合并为唯一一条头部 system。
 *
 * OpenAI 的部分供应商（以及 vLLM 加载 Qwen 时使用的 chat template）只允许
 * system 出现在消息序列开头，甚至只接受一条。RecallFlow 内部为了保持历史
 * append-only，会在任务开始、计划注入、研究画像提升时分别追加 system；这些
 * 内部表示的语义合法，但不能原样交给严格 provider。
 *
 * 合并在“出站转换”阶段完成，不修改内部 messages：工具调用配对、恢复记录和
 * 请求前缀稳定性检查仍使用原来的消息序列。多条 system 按出现顺序用空行连接，
 * 不丢任何规则；非 system 消息的相对顺序保持不变。
 */
export function normalizeProviderMessages(messages: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(messages) ? messages : [];
  const systemParts: string[] = [];
  const rest: Array<Record<string, unknown>> = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const message = raw as Record<string, unknown>;
    if (String(message.role || '') === 'system') {
      const content = systemContentText(message.content);
      if (content) systemParts.push(content);
      continue;
    }
    rest.push(message);
  }
  if (!systemParts.length) return rest;
  return [{ role: 'system', content: systemParts.join('\n\n') }, ...rest];
}

/**
 * DeepSeek thinking models require every earlier assistant turn to include
 * `reasoning_content` whenever the request carries tools. Keep this detection
 * conservative so unrelated OpenAI-compatible providers do not receive an
 * unsupported field.
 */
export function modelRequiresReasoningReplay(settings: ProviderMessageSettings): boolean {
  const model = String(settings.model || '').trim().toLowerCase();
  return (
    /^deepseek-(flash|reasoner|v4)(?:$|[-.:])/.test(model) ||
    /(?:^|[-_/])deepseek-(?:flash|reasoner|v4)(?:$|[-.:])/.test(model)
  );
}

export function prepareProviderMessages(
  messages: unknown,
  settings: ProviderMessageSettings,
  carriesTools: boolean
): Array<Record<string, unknown>> {
  const replayReasoning = carriesTools && modelRequiresReasoningReplay(settings);
  return normalizeProviderMessages(messages)
    .map((raw) => {
      const message = raw;
      const role = String(message.role || '');
      if (role === 'assistant') {
        const clean: Record<string, unknown> = {
          role: 'assistant',
          content: message.content ?? '',
        };
        if (Array.isArray(message.tool_calls)) clean.tool_calls = message.tool_calls;
        if (typeof message.name === 'string' && message.name) clean.name = message.name;
        if (replayReasoning) {
          clean.reasoning_content =
            typeof message.reasoning_content === 'string'
              ? message.reasoning_content
              : '';
        }
        return clean;
      }
      if (role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: message.tool_call_id,
          content: message.content ?? '',
        };
      }
      const clean: Record<string, unknown> = {
        role,
        content: message.content ?? '',
      };
      if (typeof message.name === 'string' && message.name) clean.name = message.name;
      return clean;
    });
}

// Convert internal conversation records into provider-facing chat messages.
// Internal UI metadata (for example `lane`) must never be sent to a model.

export interface ProviderMessageSettings {
  model?: string;
  baseUrl?: string;
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
  const list = Array.isArray(messages) ? messages : [];
  const replayReasoning = carriesTools && modelRequiresReasoningReplay(settings);
  return list
    .filter((message) => message && typeof message === 'object' && !Array.isArray(message))
    .map((raw) => {
      const message = raw as Record<string, unknown>;
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

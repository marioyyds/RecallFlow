import type { AgentRunState } from './agent-run-state.ts';
import type { ToolBatchOutcome, ToolCallPipeline } from './tool-call-pipeline.ts';
import { callJevSystemOne } from './jev-client.ts';
import {
  buildJevFastRequest,
  compareJevShadowAction,
  interpretJevFastDecision,
  type JevFastDecision,
} from './jev-action-space.ts';
import type { JevSystemOneResponse } from './jev-contract.ts';
import { INTENTS } from './intent-router.ts';

export type JevFastRunResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'shadow'; decision: JevFastDecision; latencyMs: number }
  | { kind: 'act'; decision: JevFastDecision; latencyMs: number; toolOutcome: ToolBatchOutcome }
  | { kind: 'cancelled'; reason: string };

export class JevFastController {
  private readonly state: AgentRunState;
  private readonly pipeline: ToolCallPipeline;
  private readonly signal: AbortSignal;
  private readonly callSystemOne: typeof callJevSystemOne;

  constructor(
    state: AgentRunState,
    pipeline: ToolCallPipeline,
    signal: AbortSignal,
    callSystemOne: typeof callJevSystemOne = callJevSystemOne
  ) {
    this.state = state;
    this.pipeline = pipeline;
    this.signal = signal;
    this.callSystemOne = callSystemOne;
  }

  async runOnce(
    iter: number,
    persist: (extra: Record<string, unknown>) => Promise<unknown>
  ): Promise<JevFastRunResult> {
    const settings = this.state.settings.jev;
    if (!settings || settings.enabled !== true) {
      return { kind: 'skipped', reason: 'disabled' };
    }
    if (this.state.intent === INTENTS.CHAT) {
      return { kind: 'skipped', reason: 'chat-uses-slow-lane' };
    }
    if (!settings.apiKey || !settings.model || !settings.baseUrl) {
      return { kind: 'skipped', reason: 'incomplete-config' };
    }

    const request = buildJevFastRequest(settings, {
      intent: this.state.intent,
      instruction: this.state.detected.sourceText || this.state.instruction,
      selectedText: this.state.selectedText,
      pageUrl: this.state.ctx.pageUrl,
      pageTitle: this.state.ctx.pageTitle,
      pageText: this.state.ctx.page,
      recentTools: this.state.ranToolNames,
    });
    const startedAt = Date.now();
    let response: JevSystemOneResponse;
    try {
      response = await this.callSystemOne(settings, request, {
        signal: this.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.state.trace({ phase: 'jev', iter, status: 'error', reason });
      return { kind: 'skipped', reason: 'request-failed' };
    }
    const latencyMs = Date.now() - startedAt;
    const decision = interpretJevFastDecision(response);
    this.state.totalTokens += response.usage.input_tokens + response.usage.output_tokens;
    this.state.trace({
      phase: 'jev',
      iter,
      mode: settings.shadowMode ? 'shadow' : 'live',
      model: response.model,
      decision,
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    if (settings.shadowMode) {
      return { kind: 'shadow', decision, latencyMs };
    }
    if (decision.kind === 'escalate') {
      return { kind: 'skipped', reason: decision.reason };
    }

    const callId = 'jev-' + iter + '-' + Date.now().toString(36);
    const toolCall = {
      id: callId,
      name: decision.toolName,
      args: decision.args,
    };
    const assistantMessage = {
      role: 'assistant',
      content: 'JEV 快思考：先读取' + (decision.toolName === 'read_table' ? '页面表格' : '页面正文') + '。',
      tool_calls: [{
        id: callId,
        type: 'function',
        function: {
          name: decision.toolName,
          arguments: JSON.stringify(decision.args),
        },
      }],
    };
    this.state.messages.push(assistantMessage);
    const toolOutcome = await this.pipeline.process({
      assistantMessage,
      toolCalls: [toolCall],
    }, iter, persist);
    if (toolOutcome.kind === 'cancelled') {
      return { kind: 'cancelled', reason: toolOutcome.reason };
    }
    return { kind: 'act', decision, latencyMs, toolOutcome };
  }

  traceShadowComparison(decision: JevFastDecision, step: Record<string, any>): void {
    const comparison = compareJevShadowAction(
      decision,
      Array.isArray(step.toolCalls) ? step.toolCalls.map((call: any) => String(call.name || '')) : [],
      String(step.assistantMessage?.content || '')
    );
    this.state.trace({
      phase: 'jev-shadow-compare',
      decision,
      ...comparison,
    });
  }
}

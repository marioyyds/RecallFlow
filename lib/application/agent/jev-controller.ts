import type { AgentRunState } from './agent-run-state.ts';
import type { ToolBatchOutcome, ToolCallPipeline } from './tool-call-pipeline.ts';
import { callJevSystemOne } from './jev-client.ts';
import {
  buildJevFastRequest,
  compareJevShadowAction,
  deriveJevPhase,
  formatJevDecisionSummary,
  interpretJevFastDecision,
  type JevFastDecision,
} from './jev-action-space.ts';
import type { JevSystemOneResponse } from './jev-contract.ts';
import { INTENTS } from './intent-router.ts';
import {
  JEV_MAX_ATTEMPTS_PER_RUN,
  JEV_MAX_CONSECUTIVE_ACTIONS,
} from './jev-loop-state.ts';

export type JevFastRunResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'shadow'; decision: JevFastDecision; latencyMs: number }
  | {
      kind: 'act';
      decisions: JevFastDecision[];
      latencyMs: number;
      toolOutcomes: ToolBatchOutcome[];
    }
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

  private canAttempt(): boolean {
    const settings = this.state.settings.jev;
    if (!settings || settings.enabled !== true) return false;
    if (this.state.intent === INTENTS.CHAT) return false;
    if (!settings.apiKey || !settings.model || !settings.baseUrl) return false;
    const loop = this.state.jevLoop;
    if (loop.attempts >= JEV_MAX_ATTEMPTS_PER_RUN) return false;
    if (loop.consecutiveFastActions >= JEV_MAX_CONSECUTIVE_ACTIONS) return false;
    if (loop.consecutiveFailures >= 2) return false;
    if (loop.attempts > 0 && this.state.toolCallCount <= loop.lastToolCallCount) return false;
    return true;
  }

  async runAvailable(
    iter: number,
    persist: (extra: Record<string, unknown>) => Promise<unknown>
  ): Promise<JevFastRunResult> {
    if (!this.canAttempt()) {
      return { kind: 'skipped', reason: 'not-due' };
    }
    const decisions: JevFastDecision[] = [];
    const toolOutcomes: ToolBatchOutcome[] = [];
    let latencyMs = 0;
    for (let step = 0; step < JEV_MAX_CONSECUTIVE_ACTIONS; step += 1) {
      if (!this.canAttempt()) break;
      const result = await this.runOnce(iter, persist);
      if (result.kind === 'cancelled') return result;
      latencyMs += 'latencyMs' in result ? result.latencyMs : 0;
      if (result.kind === 'shadow') return result;
      if (result.kind !== 'act') break;
      decisions.push(...result.decisions);
      toolOutcomes.push(...result.toolOutcomes);
    }
    return decisions.length
      ? { kind: 'act', decisions, latencyMs, toolOutcomes }
      : { kind: 'skipped', reason: 'no-action' };
  }

  private async runOnce(
    iter: number,
    persist: (extra: Record<string, unknown>) => Promise<unknown>
  ): Promise<JevFastRunResult> {
    const settings = this.state.settings.jev;
    this.state.jevLoop.attempts += 1;
    this.state.jevLoop.lastAttemptAt = Date.now();
    this.state.jevLoop.lastToolCallCount = this.state.toolCallCount;
    const phase = deriveJevPhase(
      this.state.ctx.pageUrl,
      this.state.ctx.pageTitle,
      this.state.ctx.lastSnapshot
    );
    const request = buildJevFastRequest(settings, {
      intent: this.state.intent,
      phase,
      instruction: this.state.detected.sourceText || this.state.instruction,
      selectedText: this.state.selectedText,
      pageUrl: this.state.ctx.pageUrl,
      pageTitle: this.state.ctx.pageTitle,
      pageText: this.state.ctx.lastReadFullText || this.state.ctx.lastEvidence || this.state.ctx.page,
      snapshot: this.state.ctx.lastSnapshot,
      recentTools: this.state.ranToolNames,
    });
    const startedAt = Date.now();
    let response: JevSystemOneResponse;
    try {
      response = await this.callSystemOne(settings, request.request, {
        signal: this.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.state.jevLoop.lastOutcome = 'error';
      this.state.jevLoop.consecutiveFastActions = 0;
      this.state.trace({ phase: 'jev', iter, status: 'error', reason });
      this.appendHandoff(iter, 'request-failed', null, reason);
      await persist({ phase: 'jev_decision' }).catch(() => {});
      return { kind: 'skipped', reason: 'request-failed' };
    }
    const latencyMs = Date.now() - startedAt;
    const decision = interpretJevFastDecision(response, request.actions);
    this.state.totalTokens += response.usage.input_tokens + response.usage.output_tokens;
    this.state.jevLoop.lastOutcome = decision.kind;
    this.state.trace({
      phase: 'jev',
      iter,
      mode: settings.shadowMode ? 'shadow' : 'live',
      phaseName: phase,
      model: response.model,
      decision,
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });
    this.state.emit({
      type: 'jev-decision',
      mode: settings.shadowMode ? 'shadow' : 'live',
      phaseName: phase,
      decision,
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      message: formatJevDecisionSummary(settings.shadowMode, decision, latencyMs),
    });

    if (settings.shadowMode) {
      this.state.jevLoop.consecutiveFastActions = 0;
      await persist({ phase: 'jev_decision' }).catch(() => {});
      return { kind: 'shadow', decision, latencyMs };
    }
    if (decision.kind === 'escalate') {
      this.state.jevLoop.consecutiveFastActions = 0;
      this.appendHandoff(iter, decision.reason, decision);
      await persist({ phase: 'jev_decision' }).catch(() => {});
      return { kind: 'skipped', reason: decision.reason };
    }

    const signature = decision.toolName + ':' + JSON.stringify(decision.args);
    if (
      this.state.jevLoop.consecutiveFastActions > 0 &&
      signature === this.state.jevLoop.lastActionSignature
    ) {
      this.state.jevLoop.consecutiveFastActions = 0;
      this.state.jevLoop.lastOutcome = 'repeated-action';
      this.state.trace({
        phase: 'jev',
        iter,
        status: 'escalate',
        reason: 'repeated-action',
        decision,
      });
      this.appendHandoff(iter, 'repeated-action', decision);
      await persist({ phase: 'jev_decision' }).catch(() => {});
      return { kind: 'skipped', reason: 'repeated-action' };
    }

    const callId = 'jev-' + iter + '-' + Date.now().toString(36);
    const toolCall = {
      id: callId,
      name: decision.toolName,
      args: decision.args,
    };
    const assistantMessage = {
      role: 'assistant',
      lane: 'fast',
      content: 'JEV 快思考：' + decision.description,
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
    const failuresBefore = this.state.failedToolNames.length;
    const toolOutcome = await this.pipeline.process({
      assistantMessage,
      toolCalls: [toolCall],
      lane: 'fast',
    }, iter, persist);
    if (toolOutcome.kind === 'cancelled') {
      return { kind: 'cancelled', reason: toolOutcome.reason };
    }
    const toolFailed = this.state.failedToolNames.length > failuresBefore;
    this.state.jevLoop.fastActions += 1;
    this.state.jevLoop.consecutiveFastActions += 1;
    this.state.jevLoop.lastActionSignature = signature;
    this.state.jevLoop.consecutiveFailures = toolFailed
      ? this.state.jevLoop.consecutiveFailures + 1
      : 0;
    this.state.jevLoop.lastOutcome = toolFailed ? 'tool-failed' : 'act';
    if (this.state.jevLoop.consecutiveFailures >= 2) {
      this.appendHandoff(iter, 'tool-failure-limit', decision);
      await persist({ phase: 'jev_decision' }).catch(() => {});
      return { kind: 'skipped', reason: 'tool-failure-limit' };
    }
    return { kind: 'act', decisions: [decision], latencyMs, toolOutcomes: [toolOutcome] };
  }

  noteSlowTurn(): void {
    this.state.jevLoop.consecutiveFastActions = 0;
    this.state.jevLoop.consecutiveFailures = 0;
    this.state.jevLoop.lastActionSignature = '';
    this.state.jevLoop.lastOutcome = 'slow-handoff';
  }

  private appendHandoff(
    iter: number,
    reason: string,
    decision: JevFastDecision | null,
    detail = ''
  ): void {
    this.state.trace({
      phase: 'jev-handoff',
      iter,
      reason,
      decision,
      detail,
    });
    this.state.emit({
      type: 'jev-handoff',
      reason,
      detail,
      message: '↪ 慢思考接管：' + reason + (detail ? '（' + detail + '）' : ''),
    });
    const signals = decision && decision.kind === 'act' ? decision.signals : decision?.signals;
    const lines = [
      '【JEV 移交给慢思考】',
      '原因：' + reason,
      detail ? '详情：' + detail : '',
      '当前阶段：' + deriveJevPhase(
        this.state.ctx.pageUrl,
        this.state.ctx.pageTitle,
        this.state.ctx.lastSnapshot
      ),
      '最近工具：' + this.state.ranToolNames.slice(-8).join('、'),
      'JEV 信号：' + (signals
        ? 'handoff=' + signals.handoff.toFixed(3) +
          '，progress=' + signals.expectedProgress.toFixed(3) +
          '，pageReady=' + signals.pageReady.toFixed(3)
        : '无有效结构化决策'),
      this.state.ctx.lastEvidence
        ? '最近证据：' + String(this.state.ctx.lastEvidence).slice(0, 1200)
        : '',
      '请基于真实工具结果继续规划；不要假设 JEV 未执行的动作已经发生。',
    ].filter(Boolean);
    this.state.messages.push({ role: 'system', content: lines.join('\n') });
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

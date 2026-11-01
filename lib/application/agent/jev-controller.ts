import type { AgentRunState } from './agent-run-state.ts';
import type { ToolBatchOutcome, ToolCallPipeline } from './tool-call-pipeline.ts';
import { callJevSystemOne } from './jev-client.ts';
import {
  buildJevFastRequest,
  compareJevShadowAction,
  deriveJevPhase,
  formatJevDecisionSummary,
  interpretJevFastDecision,
  type JevFastAction,
  type JevFastDecision,
} from './jev-action-space.ts';
import type { JevSystemOneResponse } from './jev-contract.ts';
import { INTENTS } from './intent-router.ts';
import { JEV_SETTINGS_DEFAULTS } from '../../shared/settings.ts';
import {
  writeJevDiagnostic,
  type JevDiagnosticRecord,
} from './jev-diagnostics.ts';
import {
  generateJevFieldText,
  type JevTextFieldContext,
  type JevTextResult,
} from './jev-text-helper.ts';
import { modelRequiresReasoningReplay } from './provider-history.ts';

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

type TextHelper = (
  settings: AgentRunState['settings'],
  context: JevTextFieldContext,
  signal: AbortSignal
) => Promise<JevTextResult>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JevFastController {
  private readonly state: AgentRunState;
  private readonly pipeline: ToolCallPipeline;
  private readonly signal: AbortSignal;
  private readonly callSystemOne: typeof callJevSystemOne;
  private readonly writeDiagnostic: typeof writeJevDiagnostic;
  private readonly textHelper: TextHelper;
  private lastBlockedRoute = '';
  private toolSequence = 0;

  constructor(
    state: AgentRunState,
    pipeline: ToolCallPipeline,
    signal: AbortSignal,
    callSystemOne: typeof callJevSystemOne = callJevSystemOne,
    writeDiagnostic: typeof writeJevDiagnostic = writeJevDiagnostic,
    textHelper: TextHelper = generateJevFieldText
  ) {
    this.state = state;
    this.pipeline = pipeline;
    this.signal = signal;
    this.callSystemOne = callSystemOne;
    this.writeDiagnostic = writeDiagnostic;
    this.textHelper = textHelper;
  }

  private canAttempt(): boolean {
    const settings = this.state.settings.jev;
    if (!settings || settings.enabled !== true) return false;
    if (this.state.intent === INTENTS.CHAT) return false;
    if (!settings.apiKey || !settings.model || !settings.baseUrl) return false;
    const loop = this.state.jevLoop;
    const maxAttempts = Number(settings.maxAttemptsPerRun) > 0
      ? Math.floor(Number(settings.maxAttemptsPerRun))
      : JEV_SETTINGS_DEFAULTS.maxAttemptsPerRun;
    const maxActions = Number(settings.maxConsecutiveActions) > 0
      ? Math.floor(Number(settings.maxConsecutiveActions))
      : JEV_SETTINGS_DEFAULTS.maxConsecutiveActions;
    if (loop.attempts >= maxAttempts) return false;
    if (loop.consecutiveFastActions >= maxActions) return false;
    if (loop.consecutiveFailures >= 2) return false;
    if (loop.attempts > 0 && this.state.toolCallCount <= loop.lastToolCallCount) return false;
    if (this.lastBlockedRoute && this.currentRouteKey() === this.lastBlockedRoute) return false;
    return true;
  }

  private currentRouteKey(): string {
    const phase = deriveJevPhase(
      this.state.ctx.pageUrl,
      this.state.ctx.pageTitle,
      this.state.ctx.lastSnapshot
    );
    return [
      phase,
      String(this.state.ctx.pageUrl || ''),
      String(this.state.ctx.lastSnapshot?.fingerprint || ''),
    ].join('|');
  }

  async runAvailable(
    iter: number,
    persist: (extra: Record<string, unknown>) => Promise<unknown>
  ): Promise<JevFastRunResult> {
    if (!this.canAttempt()) return { kind: 'skipped', reason: 'not-due' };
    const failuresBeforeObservation = this.state.failedToolNames.length;
    const initial = await this.observePage(iter, persist);
    if (initial.kind === 'cancelled') return initial;
    if (
      initial.kind !== 'continue' ||
      this.state.failedToolNames.length > failuresBeforeObservation
    ) {
      this.appendBlocked(iter, 'observation-failed', '无法取得执行前的页面快照');
      return { kind: 'skipped', reason: 'observation-failed' };
    }

    const decisions: JevFastDecision[] = [];
    const toolOutcomes: ToolBatchOutcome[] = [];
    let latencyMs = 0;
    const maxActions = Number(this.state.settings.jev.maxConsecutiveActions) > 0
      ? Math.floor(Number(this.state.settings.jev.maxConsecutiveActions))
      : JEV_SETTINGS_DEFAULTS.maxConsecutiveActions;
    for (let step = 0; step < maxActions; step += 1) {
      if (!this.canAttempt()) break;
      const result = await this.runOnce(iter, persist);
      if (result.kind === 'cancelled') return result;
      latencyMs += result.latencyMs || 0;
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
  ): Promise<JevFastRunResult & { latencyMs?: number }> {
    const settings = this.state.settings.jev;
    this.state.jevLoop.attempts += 1;
    this.state.jevLoop.lastAttemptAt = Date.now();
    this.state.jevLoop.lastToolCallCount = this.state.toolCallCount;
    const phase = deriveJevPhase(
      this.state.ctx.pageUrl,
      this.state.ctx.pageTitle,
      this.state.ctx.lastSnapshot
    );
    const bundle = buildJevFastRequest(settings, {
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
    this.recordDiagnostic({
      state: 'deciding',
      mode: settings.shadowMode ? 'shadow' : 'live',
      outcome: 'awaiting-operation',
      phase,
    });
    const startedAt = Date.now();
    let response: JevSystemOneResponse;
    try {
      response = await this.callSystemOne(settings, bundle.request, { signal: this.signal });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.state.jevLoop.lastOutcome = 'error';
      this.state.jevLoop.consecutiveFastActions = 0;
      this.state.trace({ phase: 'jev', iter, status: 'error', reason });
      this.appendBlocked(iter, 'request-failed', reason);
      await persist({ phase: 'jev_decision' }).catch(() => {});
      return { kind: 'skipped', reason: 'request-failed', latencyMs: Date.now() - startedAt };
    }
    const latencyMs = Date.now() - startedAt;
    const decision = interpretJevFastDecision(response, bundle);
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
    this.recordDiagnostic({
      state: settings.shadowMode
        ? 'shadow'
        : decision.kind === 'act'
          ? 'act'
          : decision.kind === 'done'
            ? 'handoff'
            : 'handoff',
      mode: settings.shadowMode ? 'shadow' : 'live',
      outcome: decision.kind === 'act' ? decision.operation : decision.kind,
      reason: decision.kind === 'blocked' ? decision.reason : decision.kind === 'done' ? 'done-claim' : undefined,
      phase,
      tool: decision.kind === 'act' ? decision.toolName : undefined,
      latencyMs,
    });

    if (settings.shadowMode) {
      this.state.jevLoop.consecutiveFastActions = 0;
      await persist({ phase: 'jev_decision' }).catch(() => {});
      return { kind: 'shadow', decision, latencyMs };
    }
    if (decision.kind === 'done') {
      this.appendBlocked(iter, 'done-claim', 'JEV 判断任务已完成，必须由慢思考独立验证');
      return { kind: 'skipped', reason: 'done-claim', latencyMs };
    }
    if (decision.kind === 'blocked') {
      this.state.jevLoop.consecutiveFastActions = 0;
      this.appendBlocked(iter, decision.reason, decision.description);
      await persist({ phase: 'jev_decision' }).catch(() => {});
      return { kind: 'skipped', reason: decision.reason, latencyMs };
    }

    const signature = decision.operation + ':' + JSON.stringify(decision.args);
    if (
      this.state.jevLoop.consecutiveFastActions > 0 &&
      signature === this.state.jevLoop.lastActionSignature
    ) {
      this.state.jevLoop.consecutiveFastActions = 0;
      this.state.jevLoop.lastOutcome = 'repeated-action';
      this.appendBlocked(iter, 'repeated-action', 'JEV 连续选择了同一个动作');
      await persist({ phase: 'jev_decision' }).catch(() => {});
      return { kind: 'skipped', reason: 'repeated-action', latencyMs };
    }

    let action = decision;
    if (action.operation === 'WAIT') {
      await sleep(100);
      const failuresBeforeWaitObservation = this.state.failedToolNames.length;
      const observed = await this.observePage(iter, persist);
      if (observed.kind === 'cancelled') return observed;
      if (
        observed.kind !== 'continue' ||
        this.state.failedToolNames.length > failuresBeforeWaitObservation
      ) {
        this.appendBlocked(iter, 'observation-failed', '等待后无法重新观察页面');
        return { kind: 'skipped', reason: 'observation-failed', latencyMs };
      }
      this.noteFastAction(signature);
      return {
        kind: 'act',
        decisions: [decision],
        latencyMs,
        toolOutcomes: [observed],
      };
    }

    if (action.operation === 'TYPE_TEXT') {
      try {
        const generated = await this.textHelper(
          this.state.settings,
          this.textContext(action),
          this.signal
        );
        action = { ...action, args: { ...action.args, value: generated.text } };
        this.state.trace({
          phase: 'jev-text',
          iter,
          model: generated.model,
          latencyMs: generated.latencyMs,
          chars: generated.text.length,
          target: action.target?.label || '',
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.appendBlocked(iter, 'text-helper-failed', reason);
        await persist({ phase: 'jev_decision' }).catch(() => {});
        return { kind: 'skipped', reason: 'text-helper-failed', latencyMs };
      }
    }

    const failuresBefore = this.state.failedToolNames.length;
    const outcome = await this.processTool(iter, persist, action);
    if (outcome.kind === 'cancelled') return outcome;
    if (outcome.kind === 'complete') {
      return { kind: 'skipped', reason: 'complete-tool', latencyMs };
    }
    const failed = this.state.failedToolNames.length > failuresBefore;
    this.state.jevLoop.fastActions += 1;
    this.state.jevLoop.consecutiveFastActions += 1;
    this.state.jevLoop.lastActionSignature = signature;
    this.state.jevLoop.consecutiveFailures = failed
      ? this.state.jevLoop.consecutiveFailures + 1
      : 0;
    this.state.jevLoop.lastOutcome = failed ? 'tool-failed' : 'act';
    this.recordDiagnostic({
      state: 'act',
      mode: 'live',
      outcome: failed ? 'tool-failed' : action.operation,
      phase,
      tool: action.toolName,
      latencyMs,
      failed,
    });

    const failuresBeforePostObservation = this.state.failedToolNames.length;
    const observed = await this.observePage(iter, persist);
    if (observed.kind === 'cancelled') return observed;
    if (
      observed.kind !== 'continue' ||
      this.state.failedToolNames.length > failuresBeforePostObservation
    ) {
      this.appendBlocked(iter, 'observation-failed', '动作后无法重新观察页面');
      return { kind: 'skipped', reason: 'observation-failed', latencyMs };
    }
    if (this.state.jevLoop.consecutiveFailures >= 2) {
      this.appendBlocked(iter, 'tool-failure-limit', '快路径连续两次工具失败');
      await persist({ phase: 'jev_decision' }).catch(() => {});
      return { kind: 'skipped', reason: 'tool-failure-limit', latencyMs };
    }
    return {
      kind: 'act',
      decisions: [decision],
      latencyMs,
      toolOutcomes: [outcome, observed],
    };
  }

  private noteFastAction(signature: string): void {
    this.state.jevLoop.fastActions += 1;
    this.state.jevLoop.consecutiveFastActions += 1;
    this.state.jevLoop.lastActionSignature = signature;
    this.state.jevLoop.consecutiveFailures = 0;
    this.state.jevLoop.lastOutcome = 'act';
  }

  private textContext(action: JevFastAction): JevTextFieldContext {
    return {
      goal: this.state.detected.sourceText || this.state.instruction,
      field: {
        label: action.target?.label || '',
        role: action.target?.role || '',
        valuePresent: false,
      },
      page: {
        title: this.state.ctx.pageTitle,
        text: String(
          this.state.ctx.lastReadFullText ||
          this.state.ctx.lastEvidence ||
          this.state.ctx.page ||
          ''
        ).slice(0, 6000),
      },
      recentActions: this.state.ranToolNames.slice(-6),
    };
  }

  private async processTool(
    iter: number,
    persist: (extra: Record<string, unknown>) => Promise<unknown>,
    action: JevFastAction
  ): Promise<ToolBatchOutcome> {
    const callId = 'jev-' + iter + '-' + (++this.toolSequence);
    const toolCall = {
      id: callId,
      name: action.toolName,
      args: action.args,
    };
    const assistantMessage = {
      role: 'assistant',
      // 快路径的结构化决策已通过 lane + jev-decision 事件展示。
      // 不把内部编排文案写进聊天历史，否则慢模型会把“重新观察页面”当成用户要求复述。
      content: '',
      tool_calls: [{
        id: callId,
        type: 'function',
        function: {
          name: action.toolName,
          arguments: JSON.stringify(action.args),
        },
      }],
      ...(modelRequiresReasoningReplay(this.state.settings)
        ? { reasoning_content: '' }
        : {}),
    };
    this.state.messages.push(assistantMessage);
    return this.pipeline.process({
      assistantMessage,
      toolCalls: [toolCall],
      lane: 'fast',
    }, iter, persist);
  }

  private async observePage(
    iter: number,
    persist: (extra: Record<string, unknown>) => Promise<unknown>
  ): Promise<ToolBatchOutcome> {
    const callId = 'jev-observe-' + iter + '-' + (++this.toolSequence);
    const toolCall = {
      id: callId,
      name: 'get_page_snapshot',
      args: { maxText: 1200 },
    };
    const assistantMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: callId,
        type: 'function',
        function: {
          name: 'get_page_snapshot',
          arguments: JSON.stringify(toolCall.args),
        },
      }],
      ...(modelRequiresReasoningReplay(this.state.settings)
        ? { reasoning_content: '' }
        : {}),
    };
    this.state.messages.push(assistantMessage);
    return this.pipeline.process({
      assistantMessage,
      toolCalls: [toolCall],
      lane: 'fast',
    }, iter, persist);
  }

  noteSlowTurn(): void {
    this.state.jevLoop.consecutiveFastActions = 0;
    this.state.jevLoop.consecutiveFailures = 0;
    this.state.jevLoop.lastActionSignature = '';
    this.state.jevLoop.lastOutcome = 'slow-handoff';
  }

  private appendBlocked(
    iter: number,
    reason: string,
    detail = ''
  ): void {
    this.lastBlockedRoute = this.currentRouteKey();
    this.state.trace({
      phase: 'jev-handoff',
      iter,
      reason,
      detail,
    });
    this.state.emit({
      type: 'jev-handoff',
      reason,
      detail,
      message: '↪ 慢思考接管：' + reason + (detail ? '（' + detail + '）' : ''),
    });
    this.recordDiagnostic({
      state: 'handoff',
      mode: this.state.settings.jev?.shadowMode ? 'shadow' : 'live',
      outcome: 'handoff',
      reason,
      phase: deriveJevPhase(
        this.state.ctx.pageUrl,
        this.state.ctx.pageTitle,
        this.state.ctx.lastSnapshot
      ),
    });
    this.state.messages.push({
      role: 'system',
      content: [
        '【JEV 快路径已停止】',
        '原因：' + reason,
        detail ? '详情：' + detail : '',
        '请基于最近一次真实页面快照和工具结果继续规划；不要假设未执行的动作已经发生。',
      ].filter(Boolean).join('\n'),
    });
  }

  private recordDiagnostic(
    entry: Omit<JevDiagnosticRecord, 'updatedAt' | 'attempts'>
  ): void {
    Promise.resolve(this.writeDiagnostic({
      ...entry,
      attempts: this.state.jevLoop.attempts,
    })).catch(() => {});
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

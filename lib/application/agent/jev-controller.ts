import type { AgentRunState } from './agent-run-state.ts';
import type { ToolBatchOutcome, ToolCallPipeline } from './tool-call-pipeline.ts';
import { callJevSystemOne } from './jev-client.ts';
import {
  buildJevEdgeRequest,
  buildJevFastRequest,
  compareJevShadowAction,
  deriveJevPhase,
  formatJevDecisionSummary,
  interpretJevEdgeDecision,
  interpretJevFastDecision,
  type JevFastAction,
  type JevFastDecision,
} from './jev-action-space.ts';
import {
  bindSlots,
  candidateEdges,
  evidenceFromSnapshot,
  extractExplicitSlots,
  groundEdgeAction,
  matchCandidate,
} from './trace-graph.ts';
import { loadTraceGraph } from './tracegraph-store.ts';
import { REPLAYABLE_TOOLS } from './macros.ts';
import type { JevSystemOneResponse } from './jev-contract.ts';
import { INTENTS } from './intent-router.ts';
import { JEV_SETTINGS_DEFAULTS } from '../../shared/settings.ts';
import { activePlanStep, planStepKey } from './plan-contract.ts';
import {
  writeJevDiagnostic,
  type JevDiagnosticRecord,
} from './jev-diagnostics.ts';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 结构匹配层级的稳定排序：full 优先，其次 static，最后 name。
// 这只是把「结构离当前更近的边」排在前面，不做语义打分，也不截断。
const MATCH_LEVEL_RANK: Record<string, number> = { full: 0, static: 1, name: 2 };

/**
 * 结构分层裁剪：只有当存在 full 匹配时才只发 full。
 *
 * 依据 2026-11-12 的真实图（editor.csdn.net）：MdPage 名下 10 条边来自 16 个不同
 * 录制签名；按每个签名回放，12/16 恰好有 1 条 full，1 个有 3 条（同一结构下的
 * 并行动作），3 个 0 条。也就是说「有 full 就收起 name 档」把候选压到 1–3，而
 * 结构没见过的页面仍保留全部候选，不会凭空制造 no-candidates。
 *
 * 这是结构证据，不是语义匹配，也不构成执行授权：选哪条、是否执行仍由 JEV 决定。
 */
export function selectCandidatesByTier<T extends { match: { level: string } }>(items: T[]): T[] {
  const hasFull = items.some((item) => item.match.level === 'full');
  return hasFull ? items.filter((item) => item.match.level === 'full') : items;
}

export class JevFastController {
  private readonly state: AgentRunState;
  private readonly pipeline: ToolCallPipeline;
  private readonly signal: AbortSignal;
  private readonly callSystemOne: typeof callJevSystemOne;
  private readonly writeDiagnostic: typeof writeJevDiagnostic;
  private readonly loadGraph: typeof loadTraceGraph;
  private lastBlockedRoute = '';
  private toolSequence = 0;

  constructor(
    state: AgentRunState,
    pipeline: ToolCallPipeline,
    signal: AbortSignal,
    callSystemOne: typeof callJevSystemOne = callJevSystemOne,
    writeDiagnostic: typeof writeJevDiagnostic = writeJevDiagnostic,
    loadGraph: typeof loadTraceGraph = loadTraceGraph
  ) {
    this.state = state;
    this.pipeline = pipeline;
    this.signal = signal;
    this.callSystemOne = callSystemOne;
    this.writeDiagnostic = writeDiagnostic;
    this.loadGraph = loadGraph;
  }

  private syncPlanContract(): ReturnType<typeof activePlanStep> {
    const step = activePlanStep(this.state.ctx.plan);
    const version = Math.max(0, Math.floor(Number(this.state.ctx.planVersion) || 0));
    const key = planStepKey(step, version);
    const loop = this.state.jevLoop;
    if (loop.planKey !== key || loop.planVersion !== version) {
      loop.planKey = key;
      loop.planVersion = version;
      loop.planActions = 0;
      // A slow replan is a new execution attempt even when the same page stayed blocked.
      this.lastBlockedRoute = '';
      this.state.trace({
        phase: 'jev-plan',
        planVersion: version,
        stepId: String(step?.id || ''),
        leaseActions: Number(step?.leaseActions) || null,
        allowedOperations: Array.isArray(step?.allowedOperations)
          ? step.allowedOperations.slice()
          : null,
      });
    }
    return step;
  }

  private planLeaseRemaining(): number | null {
    const step = this.syncPlanContract();
    const lease = Number(step?.leaseActions);
    if (!Number.isFinite(lease) || lease < 1) return null;
    return Math.max(0, Math.floor(lease) - this.state.jevLoop.planActions);
  }

  private canAttempt(): boolean {
    const settings = this.state.settings.jev;
    if (!settings || settings.enabled !== true) return false;
    if (this.state.intent === INTENTS.CHAT) return false;
    if (!settings.apiKey || !settings.model || !settings.baseUrl) return false;
    const leaseRemaining = this.planLeaseRemaining();
    if (leaseRemaining === 0) return false;
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
    let skippedReason = 'no-action';
    const configuredMaxActions = Number(this.state.settings.jev.maxConsecutiveActions) > 0
      ? Math.floor(Number(this.state.settings.jev.maxConsecutiveActions))
      : JEV_SETTINGS_DEFAULTS.maxConsecutiveActions;
    const leaseRemaining = this.planLeaseRemaining();
    const maxActions = leaseRemaining === null
      ? configuredMaxActions
      : Math.min(configuredMaxActions, leaseRemaining);
    for (let step = 0; step < maxActions; step += 1) {
      if (!this.canAttempt()) break;
      const result = await this.runOnce(iter, persist);
      if (result.kind === 'cancelled') return result;
      latencyMs += result.latencyMs || 0;
      if (result.kind === 'shadow') return result;
      if (result.kind !== 'act') {
        skippedReason = result.reason;
        break;
      }
      decisions.push(...result.decisions);
      toolOutcomes.push(...result.toolOutcomes);
    }
    return decisions.length
      ? { kind: 'act', decisions, latencyMs, toolOutcomes }
      : { kind: 'skipped', reason: skippedReason };
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
    if (this.traceGraphActive()) {
      return this.runTraceGraphOnce(iter, persist, phase);
    }
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
      plan: this.state.ctx.plan,
      planVersion: this.state.ctx.planVersion,
      leaseRemaining: this.planLeaseRemaining(),
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
    let decision = interpretJevFastDecision(response, bundle);
    let readFallback = false;
    const readOperation = bundle.operations.READ_PAGE;
    const fallbackKey =
      Math.max(0, Math.floor(Number(this.state.ctx.planVersion) || 0)) +
      '|' +
      String(this.state.ctx.pageUrl || '');
    if (
      decision.kind === 'blocked' &&
      decision.reason === 'low-confidence' &&
      decision.operation === 'READ_PAGE' &&
      readOperation?.toolName === 'read_current_page' &&
      this.state.jevLoop.readFallbackKey !== fallbackKey
    ) {
      // A failed read classification is safe to resolve by reading. Do not spend
      // a full slow-model turn on an operation that cannot mutate the page.
      decision = {
        kind: 'act',
        operation: 'READ_PAGE',
        actionKey: 'READ_PAGE',
        toolName: readOperation.toolName,
        args: { ...(readOperation.args || {}) },
        description: 'READ_PAGE 置信度不足，使用只读确定性回退',
        confidence: decision.confidence || 0,
        operationConfidence: decision.confidence || 0,
        targetConfidence: null,
      };
      this.state.jevLoop.readFallbackKey = fallbackKey;
      readFallback = true;
    }
    this.state.totalTokens += response.usage.input_tokens + response.usage.output_tokens;
    this.state.jevLoop.lastOutcome = decision.kind;
    this.state.trace({
      phase: 'jev',
      iter,
      mode: settings.shadowMode ? 'shadow' : 'live',
      phaseName: phase,
      model: response.model,
      decision,
      readFallback,
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });
    this.state.emit({
      type: 'jev-decision',
      mode: settings.shadowMode ? 'shadow' : 'live',
      phaseName: phase,
      decision,
      readFallback,
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
      reason: readFallback
        ? 'low-confidence-read-fallback'
        : decision.kind === 'blocked'
          ? decision.reason
          : decision.kind === 'done'
            ? 'done-claim'
            : undefined,
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
      this.state.jevLoop.sameActionStreak = 0;
      this.state.jevLoop.waitStreak = 0;
      this.state.jevLoop.lastActionRouteKey = '';
      this.appendBlocked(iter, decision.reason, decision.description);
      await persist({ phase: 'jev_decision' }).catch(() => {});
      return { kind: 'skipped', reason: decision.reason, latencyMs };
    }

    // 输入值不再由快路径生成：TYPE_TEXT 已不在 operation 空间里，模型若仍返回它，
    // 上面的 blocked 分支会以 invalid-answer 交回慢思考，不执行任何写入。
    const action = decision;

    const signature = action.operation + ':' + JSON.stringify(action.args);
    const routeKey = this.currentRouteKey();
    const loop = this.state.jevLoop;
    const previousActionIsComparable =
      loop.lastActionRouteKey === routeKey &&
      signature === loop.lastActionSignature;
    const sameActionStreak = previousActionIsComparable
      ? loop.sameActionStreak
      : 0;
    const repeatedCount = action.operation === 'WAIT'
      ? loop.waitStreak
      : sameActionStreak;
    const configuredRepeatLimit = Number(
      this.state.settings.jev.maxRepeatedActionsWithoutProgress
    );
    const repeatLimit =
      Number.isFinite(configuredRepeatLimit) && configuredRepeatLimit >= 1
        ? Math.min(10, Math.floor(configuredRepeatLimit))
        : JEV_SETTINGS_DEFAULTS.maxRepeatedActionsWithoutProgress;
    if (repeatedCount >= repeatLimit) {
      loop.consecutiveFastActions = 0;
      loop.sameActionStreak = 0;
      loop.waitStreak = 0;
      loop.lastOutcome = action.operation === 'WAIT' ? 'wait-limit' : 'repeated-action';
      this.appendBlocked(
        iter,
        loop.lastOutcome,
        action.operation === 'WAIT'
          ? '连续等待 ' + repeatedCount + ' 次仍未确认目标状态'
          : '同一动作在当前页面状态下已连续尝试 ' +
              sameActionStreak +
              ' 次且无页面进展'
      );
      await persist({ phase: 'jev_decision' }).catch(() => {});
      return { kind: 'skipped', reason: 'repeated-action', latencyMs };
    }

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
      this.noteFastAction(
        signature,
        previousActionIsComparable ? sameActionStreak + 1 : 1,
        routeKey
      );
      return {
        kind: 'act',
        decisions: [decision],
        latencyMs,
        toolOutcomes: [observed],
      };
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
    this.state.jevLoop.planActions += 1;
    this.state.jevLoop.lastActionSignature = signature;
    this.state.jevLoop.sameActionStreak =
      previousActionIsComparable ? sameActionStreak + 1 : 1;
    this.state.jevLoop.waitStreak = 0;
    this.state.jevLoop.lastActionRouteKey = routeKey;
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
    // 动作可能已经导航或改变了页面。路由变化说明这一步产生了可观测进展，
    // 同一 action signature 的“无进展连击”必须清零，而不是因为动作相同就停。
    const postActionRouteKey = this.currentRouteKey();
    if (postActionRouteKey !== routeKey) {
      this.state.jevLoop.sameActionStreak = 0;
    }
    this.state.jevLoop.lastActionRouteKey = postActionRouteKey;
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

  private traceGraphActive(): boolean {
    const graph = this.state.settings.traceGraph;
    return graph?.enabled === true && graph.mode === 'live';
  }

  private traceEdgeHandoff(iter: number, reason: string, detail = ''): void {
    this.state.trace({
      phase: 'tracegraph-handoff',
      iter,
      reason,
      detail,
    });
    this.appendBlocked(iter, reason, detail);
  }

  private edgeConfidenceDetail(
    decision: Extract<
      ReturnType<typeof interpretJevEdgeDecision>,
      { kind: 'blocked' }
    >
  ): string {
    return [
      decision.description,
      'confidence=' + Number(decision.confidence || 0).toFixed(4),
    ].filter(Boolean).join('；');
  }

  private addBlockedEdge(edgeId: string): void {
    this.state.jevLoop.blockedEdgeIds = [
      ...new Set([...this.state.jevLoop.blockedEdgeIds, edgeId]),
    ].slice(-64);
    this.state.trace({
      phase: 'tracegraph-blocked-edge-hit',
      edgeId,
    });
  }

  private async runTraceGraphOnce(
    iter: number,
    persist: (extra: Record<string, unknown>) => Promise<unknown>,
    phase: string
  ): Promise<JevFastRunResult & { latencyMs?: number }> {
    const settings = this.state.settings;
    const graphSettings = settings.traceGraph;
    if (!graphSettings) return { kind: 'skipped', reason: 'tracegraph-disabled' };
    const graph = await this.loadGraph(this.state.ctx.pageUrl).catch(() => null);
    const before = evidenceFromSnapshot(this.state.ctx.lastSnapshot);
    const planStep = activePlanStep(this.state.ctx.plan);
    const graphSlots = {
      ...extractExplicitSlots(
        this.state.detected.sourceText || this.state.instruction
      ),
      ...extractExplicitSlots(planStep?.text),
      ...(this.state.ctx.traceGraphSlots || {}),
    };
    const stateName = before.atomSignature.split('#')[0];
    const blockedMatches = graph?.l1.edges.filter(
      (item) =>
        item.from === stateName &&
        this.state.jevLoop.blockedEdgeIds.includes(item.id)
    ) || [];
    for (const item of blockedMatches) {
      this.state.trace({
        phase: 'tracegraph-blocked-edge-hit',
        iter,
        edgeId: item.id,
      });
    }
    const stateEdges = graph
      ? candidateEdges(graph, {
          siteKey: graph.siteKey,
          atomSignature: before.atomSignature,
          blockedEdgeIds: new Set(this.state.jevLoop.blockedEdgeIds),
          executedEdges: new Set(this.state.jevLoop.executedEdges),
        })
      : [];
    const ranked = stateEdges
      .map((edge) => ({ edge, match: matchCandidate(edge, before) }))
      .sort(
        (a, b) =>
          MATCH_LEVEL_RANK[a.match.level] - MATCH_LEVEL_RANK[b.match.level] ||
          b.edge.provenance.verifiedAt - a.edge.provenance.verifiedAt
      );
    const bindable = ranked
      .map((item) => ({
        ...item,
        binding: bindSlots(item.edge, { slots: graphSlots }),
      }))
      .filter((item) => item.binding.ok);
    const tiered = selectCandidatesByTier(bindable);
    // Grounding 提前：目标在当前快照里定位不到时，这条边本来也会在 JEV 选定后
    // 立刻失败并封边。提前做只省掉一次 systemone 和一次 handoff 的理由，
    // 不改变判定权（是否执行仍由 JEV 决定），也不把置信度当授权。
    // 依据 2026-11-12 真实图：MdPage 的 10 条边按签名回放后，唯一目标可定位的
    // 候选数中位数是 2（最大 7），且 4 个未就绪签名的候选会被这一步清空。
    const groundedItems: Array<{
      edge: (typeof bindable)[number]['edge'];
      match: (typeof bindable)[number]['match'];
      binding: (typeof bindable)[number]['binding'];
      grounded: ReturnType<typeof groundEdgeAction>;
    }> = [];
    let filteredTargetMissing = 0;
    for (const item of tiered) {
      const grounded = groundEdgeAction(item.edge, before, item.binding.bound);
      if (grounded.ok && grounded.args) {
        groundedItems.push({ ...item, grounded });
        continue;
      }
      filteredTargetMissing += 1;
      this.state.trace({
        phase: 'tracegraph-grounding',
        iter,
        edgeId: item.edge.id,
        decision: 'REJECT',
        reason: grounded.reason || 'target-missing',
        candidates: grounded.candidates,
        prefilter: true,
      });
      // 刻意**不封边**：目标缺失可能是瞬时的（菜单收起、面板未展开），封边会让
      // 这条边在本 run 内永久失效。预过滤不花 systemone，下一 cycle 再挑一次即可。
    }
    const candidates = groundedItems.map((item) => item.edge);
    const candidateMatches = Object.fromEntries(
      groundedItems.map((item) => [item.edge.id, item.match])
    );
    const levelCounts = groundedItems.reduce(
      (acc, item) => {
        acc[item.match.level] = (acc[item.match.level] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
    this.state.trace({
      phase: 'tracegraph-candidates',
      iter,
      count: candidates.length,
      nominated: stateEdges.length,
      filteredUnbound: stateEdges.length - bindable.length,
      prunedByFull: bindable.length - tiered.length,
      filteredTargetMissing,
      levels: levelCounts,
      state: stateName || '',
    });
    this.state.emit({
      type: 'tracegraph-metrics',
      phase: 'candidates',
      count: candidates.length,
      nominated: stateEdges.length,
      filteredUnbound: stateEdges.length - bindable.length,
      prunedByFull: bindable.length - tiered.length,
      filteredTargetMissing,
      levels: levelCounts,
    });
    if (!candidates.length) {
      const reason = tiered.length ? 'edge-target-missing' : 'edge-no-candidates';
      this.traceEdgeHandoff(
        iter,
        reason,
        tiered.length
          ? '候选边的目标在当前快照里都无法唯一定位'
          : '当前状态没有可用的已验证证据边'
      );
      await persist({ phase: 'tracegraph_decision' }).catch(() => {});
      return { kind: 'skipped', reason };
    }

    const bundle = buildJevEdgeRequest(settings.jev, {
      intent: this.state.intent,
      goal: this.state.detected.sourceText || this.state.instruction,
      phase,
      pageUrl: this.state.ctx.pageUrl,
      pageTitle: this.state.ctx.pageTitle,
      candidates,
      candidateMatches,
      observation: before,
      slots: graphSlots,
      planStep: planStep?.text,
      successPredicate: planStep?.successPredicate,
    });
    const startedAt = Date.now();
    let response: JevSystemOneResponse;
    try {
      response = await this.callSystemOne(settings.jev, bundle.request, {
        signal: this.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.state.trace({
        phase: 'jev',
        iter,
        mode: 'live',
        head: 'edge',
        status: 'error',
        reason,
      });
      this.traceEdgeHandoff(iter, 'request-failed', reason);
      await persist({ phase: 'tracegraph_decision' }).catch(() => {});
      return { kind: 'skipped', reason: 'request-failed' };
    }
    const latencyMs = Date.now() - startedAt;
    this.state.totalTokens += response.usage.input_tokens + response.usage.output_tokens;
    const decision = interpretJevEdgeDecision(response, bundle);
    this.state.trace({
      phase: 'jev',
      iter,
      mode: graphSettings.shadowMode ? 'shadow' : 'live',
      head: 'edge',
      phaseName: phase,
      decision,
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });
    if (graphSettings.shadowMode) {
      await persist({ phase: 'tracegraph_decision' }).catch(() => {});
      return { kind: 'skipped', reason: 'tracegraph-shadow' };
    }
    if (decision.kind === 'blocked') {
      this.state.emit({
        type: 'tracegraph-metrics',
        phase: 'edge-decision',
        decision: 'BLOCKED',
        reason: decision.reason,
        confidence: decision.confidence || 0,
      });
      this.traceEdgeHandoff(
        iter,
        'edge-' + decision.reason,
        this.edgeConfidenceDetail(decision)
      );
      await persist({ phase: 'tracegraph_decision' }).catch(() => {});
      return { kind: 'skipped', reason: 'edge-' + decision.reason, latencyMs };
    }

    const chosen = groundedItems.find((item) => item.edge.id === decision.edgeId);
    this.state.emit({
      type: 'tracegraph-metrics',
      phase: 'edge-decision',
      decision: 'EDGE',
      edgeId: decision.edgeId,
      confidence: decision.confidence,
    });
    if (!chosen) {
      this.traceEdgeHandoff(iter, 'edge-unknown', decision.edgeId);
      return { kind: 'skipped', reason: 'edge-unknown', latencyMs };
    }
    const edge = chosen.edge;
    if (!REPLAYABLE_TOOLS.has(edge.action.tool)) {
      this.state.trace({
        phase: 'tracegraph-edge',
        iter,
        edgeId: edge.id,
        decision: 'REJECT',
        reason: 'tool-not-replayable',
      });
      this.traceEdgeHandoff(iter, 'edge-tool-rejected', edge.action.tool);
      return { kind: 'skipped', reason: 'edge-tool-rejected', latencyMs };
    }

    // 目标与槽位在 prefilter 阶段已按当前快照解析；这里直接用同一份结果，
    // 避免在请求与执行之间再解析一次（页面在等待响应期间可能已经变化）。
    this.state.trace({
      phase: 'tracegraph-grounding',
      iter,
      edgeId: edge.id,
      decision: 'GROUNDED',
      basis: chosen.grounded.target?.basis || '',
      target: chosen.grounded.target?.name || chosen.grounded.target?.role || '',
    });
    const action: JevFastAction = {
      kind: 'act',
      operation:
        edge.action.tool === 'type_text'
          ? 'TYPE_TEXT'
          : edge.action.tool === 'click_element'
            ? 'CLICK'
            : 'READ_PAGE',
      actionKey: edge.id,
      toolName: edge.action.tool as JevFastAction['toolName'],
      args: chosen.grounded.args || {},
      description: edge.g,
      confidence: decision.confidence,
      operationConfidence: decision.confidence,
      targetConfidence: null,
    };
    const failuresBefore = this.state.failedToolNames.length;
    const outcome = await this.processTool(iter, persist, action, {
      skipApproval: true,
    });
    if (outcome.kind === 'cancelled') return outcome;
    if (outcome.kind === 'complete') {
      this.state.jevLoop.executedEdges.push(edge.id);
      return { kind: 'skipped', reason: 'complete-tool', latencyMs };
    }
    if (this.state.failedToolNames.length > failuresBefore) {
      this.addBlockedEdge(edge.id);
      this.traceEdgeHandoff(iter, 'edge-tool-failed', edge.action.tool);
      return { kind: 'skipped', reason: 'edge-tool-failed', latencyMs };
    }
    const observed = await this.observePage(iter, persist);
    if (observed.kind === 'cancelled') return observed;

    this.state.jevLoop.executedEdges = [
      ...new Set([...this.state.jevLoop.executedEdges, edge.id]),
    ].slice(-64);
    this.state.jevLoop.fastActions += 1;
    this.state.jevLoop.consecutiveFastActions += 1;
    this.state.jevLoop.planActions += 1;
    this.state.jevLoop.lastOutcome = 'edge-act';
    return {
      kind: 'act',
      decisions: [action],
      latencyMs,
      toolOutcomes: [outcome, observed],
    };
  }

  private noteFastAction(
    signature: string,
    sameActionStreak: number,
    beforeRouteKey: string
  ): void {
    const postActionRouteKey = this.currentRouteKey();
    this.state.jevLoop.fastActions += 1;
    this.state.jevLoop.consecutiveFastActions += 1;
    this.state.jevLoop.planActions += 1;
    this.state.jevLoop.lastActionSignature = signature;
    this.state.jevLoop.sameActionStreak =
      postActionRouteKey === beforeRouteKey ? sameActionStreak : 0;
    this.state.jevLoop.waitStreak = signature.startsWith('WAIT:')
      ? this.state.jevLoop.waitStreak + 1
      : 0;
    this.state.jevLoop.lastActionRouteKey = postActionRouteKey;
    this.state.jevLoop.consecutiveFailures = 0;
    this.state.jevLoop.lastOutcome = 'act';
  }

  private async processTool(
    iter: number,
    persist: (extra: Record<string, unknown>) => Promise<unknown>,
    action: JevFastAction,
    options: { skipApproval?: boolean } = {}
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
      ...(options.skipApproval ? { skipApproval: true } : {}),
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
    this.state.jevLoop.lastActionRouteKey = '';
    this.state.jevLoop.sameActionStreak = 0;
    this.state.jevLoop.waitStreak = 0;
    this.state.jevLoop.lastOutcome = 'slow-handoff';
  }

  /**
 * 快路径让位给慢思考时，写给慢模型的解释。
 *
 * 为什么必须显式说明「不是页面故障」：2026-11-12 的真实会话 RF-XKJ4M7 里，
 * 模型把「【JEV 快路径已停止】…当前状态没有可用的已验证证据边」读成了
 * 「页面刚打开可能还在加载」，于是多拍一次快照、多写了 108–282 字推理。
 * 让位的原因绝大多数与页面无关（没录过、目标暂时收起、置信不足），
 * 用故障口吻描述会稳定地诱发一次无用观察。
 */
private handoffExplanation(reason: string): string {
  if (reason === 'edge-no-candidates') {
    return '本页 / 当前结构还没有可复用的历史动作（首次操作时属正常）';
  }
  if (reason === 'edge-target-missing') {
    return '候选动作的目标此刻不在页面上（可能收起了菜单或面板，属正常）';
  }
  if (reason === 'edge-abstain') return '快路径对候选动作没有把握，主动让位';
  if (reason === 'edge-low-confidence') return '候选动作的置信度不足，快路径主动让位';
  if (reason === 'edge-invalid-answer') return '决策服务返回了无效选项，快路径不冒险';
  if (reason === 'edge-unbound-slots') return '当前指令缺少该动作需要的显式参数值';
  if (reason === 'edge-tool-rejected') return '该动作不在可回放白名单内，快路径不执行';
  if (reason === 'edge-tool-failed') return '快路径执行的动作失败了';
  if (reason === 'edge-unknown') return '决策服务选中了未提名的动作';
  if (reason === 'request-failed') return '快路径的决策服务本次不可用';
  if (reason === 'observation-failed') return '未能取得执行前的页面快照';
  if (reason === 'model-blocked') return '快路径判断当前没有可安全推进的动作';
  return '快路径让位（' + reason + '）';
}

private appendBlocked(
    iter: number,
    reason: string,
    detail = ''
  ): void {
    this.lastBlockedRoute = this.currentRouteKey();
    this.state.jevLoop.handoffReasons[reason] =
      (this.state.jevLoop.handoffReasons[reason] || 0) + 1;
    this.state.trace({
      phase: 'jev-handoff',
      iter,
      reason,
      detail,
    });
    const explanation = this.handoffExplanation(reason);
    this.state.emit({
      type: 'jev-handoff',
      reason,
      detail,
      message:
        '↪ 慢思考接管：' + reason +
        (detail ? '（' + detail + '）' : '') +
        ' — ' + explanation,
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
        '【内部提示 · 非页面故障】快路径让位给慢思考：' + explanation + '。',
        detail ? '详情：' + detail : '',
        '请按当前计划与最近一次真实工具结果继续操作。',
        '不要因为这条提示而等待、重复读取页面或更换方案；也不要假设任何未执行的动作已经发生。',
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

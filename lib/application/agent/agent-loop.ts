import {
  collapseOldToolResults,
  estimateMessagesTokens,
  estimateTokens,
} from './context.ts';
import { CONTEXT_TUNING } from './context-tuning.ts';
import {
  diagnoseConversation,
  formatProblems,
  repairConversation,
} from './conversation-guard.ts';
import {
  diffSnapshots,
  formatPrefixReport,
  snapshotMessages,
} from './prefix-watch.ts';
import { RUN_STATUS } from './agent-state.ts';
import {
  evaluateLiveness,
} from './verification-policy.ts';
import { tokenBudgetExceeded } from './budget.ts';
import { streamAgentStep } from './stream-step.ts';
import { prepareAgentRun } from './agent-bootstrap.ts';
import { AgentRunState } from './agent-run-state.ts';
import { AgentRunFinalizer } from './agent-finalizer.ts';
import { CompletionCoordinator } from './agent-completion.ts';
import { ToolCallPipeline } from './tool-call-pipeline.ts';

const CONTEXT_COLLAPSE_TOKENS = CONTEXT_TUNING.collapseTokens;

/**
 * Agent orchestration only: model turns, budget/liveness gates, context
 * integrity, and delegation to tool/completion/finalization collaborators.
 */
export async function runAgentLoop(
  port: any,
  payload: any,
  settings: any,
  book: any,
  signal: AbortSignal,
  tabId: number | undefined,
  observeEvent: any
): Promise<void> {
  const prepared = await prepareAgentRun({
    port,
    payload,
    settings,
    book,
    signal,
    tabId,
    observeEvent,
  });
  const state = new AgentRunState(prepared, payload, settings);
  const finalizer = new AgentRunFinalizer(state, port, settings, signal);
  const toolPipeline = new ToolCallPipeline(state, port, signal);
  const completion = new CompletionCoordinator(state);
  const resumeIteration = state.resumeIteration;
  const persist = (extra: Record<string, any> = {}) =>
    finalizer.persist(extra);

  await persist({
    status: RUN_STATUS.CREATED,
    phase: 'created',
    nextIteration: resumeIteration,
  }).catch(() => {});

  for (let iter = resumeIteration; ; iter++) {
    if (tokenBudgetExceeded(state.totalTokens, state.budget)) {
      state.emitState(RUN_STATUS.TIMEOUT, { reason: 'maxTotalTokens' });
      state.trace({
        phase: 'timeout',
        reason: 'maxTotalTokens',
        toolCalls: state.toolCallCount,
        totalTokens: state.totalTokens,
      });
      state.emit({
        type: 'budget-exceeded',
        reason: 'maxTotalTokens',
        message:
          '本任务的累计 token 已达成本上限（约 ' +
          state.totalTokens +
          '），已停止。这与「做了多少事」无关 —— 它是花费兜底。',
        totalTokens: state.totalTokens,
      });
      await finalizer.timeout('maxTotalTokens', {
        totalTokens: state.totalTokens,
      });
      return;
    }

    const liveness = evaluateLiveness({
      iter,
      lastProgressIter: state.lastProgressIter,
      maxNoProgressRounds: state.budget.maxNoProgressRounds,
    });
    if (liveness.stalled) {
      state.emitState(RUN_STATUS.TIMEOUT, { reason: 'noProgress' });
      state.trace({
        phase: 'timeout',
        reason: 'noProgress',
        iter,
        noProgressRounds: liveness.noProgressRounds,
        toolCalls: state.toolCallCount,
      });
      state.emit({
        type: 'budget-exceeded',
        reason: 'noProgress',
        message:
          '连续 ' +
          liveness.noProgressRounds +
          ' 轮没有产生任何可观察进展，已停止。' +
          '这不是“做了多少事”的限制 —— 只要还在推进就不会触发；通常是卡在某个反复失败的动作上。',
      });
      await finalizer.timeout('noProgress');
      return;
    }

    state.run.currentStep = iter + 1;
    state.emitState(
      iter === resumeIteration
        ? RUN_STATUS.PLANNING
        : RUN_STATUS.OBSERVING
    );
    await persist({
      status: state.run.status,
      phase: 'model',
      nextIteration: iter,
    }).catch(() => {});

    const historyTokens = estimateMessagesTokens(state.messages);
    let collapsedNow = 0;
    if (historyTokens > CONTEXT_COLLAPSE_TOKENS) {
      collapsedNow = collapseOldToolResults(
        state.messages,
        CONTEXT_TUNING.collapseKeepFull,
        CONTEXT_TUNING.collapseHeadChars
      );
      if (collapsedNow) {
        console.log(
          '[RecallFlow] collapsed ' +
            collapsedNow +
            ' old tool results (iter=' +
            iter +
            ', ~' +
            historyTokens +
            ' tokens)'
        );
        state.trace({
          phase: 'collapse',
          iter,
          collapsed: collapsedNow,
          historyTokens,
        });
      }
    }

    let safeMessageLength = state.messages.length;
    const prefixSnapshot = snapshotMessages(state.messages);
    if (state.prevPrefixSnapshot) {
      const diff = diffSnapshots(
        state.prevPrefixSnapshot,
        prefixSnapshot
      );
      if (!diff.stable) {
        const hint = collapsedNow
          ? '（本次折叠所致，属预期的一次性改写）'
          : '';
        console.log('[RecallFlow] ' + formatPrefixReport(diff) + hint);
        state.trace({
          phase: 'prefix-change',
          divergeAt: diff.divergeAt,
          reason: diff.reason,
          prevLength: diff.prevLength,
          nextLength: diff.nextLength,
          expected: Boolean(collapsedNow),
        });
      }
    }
    state.prevPrefixSnapshot = prefixSnapshot;

    const conversationProblems = diagnoseConversation(state.messages);
    if (conversationProblems.length) {
      const repaired = repairConversation(state.messages);
      console.log(
        '[RecallFlow] 出站会话结构非法，已修复：' +
          formatProblems(conversationProblems) +
          '（' +
          state.messages.length +
          ' → ' +
          repaired.length +
          ' 条）'
      );
      state.trace({
        phase: 'conversation-repair',
        iter,
        problems: conversationProblems,
        before: state.messages.length,
        after: repaired.length,
      });
      state.messages.length = 0;
      for (const message of repaired) state.messages.push(message);
      safeMessageLength = Math.min(
        safeMessageLength,
        state.messages.length
      );
    }

    let step: any;
    try {
      step = await streamAgentStep(
        port,
        settings,
        state.messages,
        signal,
        state.tools,
        state.emit
      );
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        state.messages.length = safeMessageLength;
        const partial = error.partial || null;
        if (partial?.assistantMessage) {
          state.messages.push(partial.assistantMessage);
        }
        await persist({
          status: state.run.status,
          phase: 'interrupted',
          reason: 'port-disconnected',
          nextIteration: iter,
        }).catch(() => {});
        return;
      }
      const message = error?.message ? error.message : String(error);
      await finalizer.failed(message);
      return;
    }
    if (step.error) {
      await finalizer.failed(step.error);
      return;
    }

    state.messages.push(step.assistantMessage);
    recordUsage(state, step, iter);
    state.emit({ type: 'usage', totalTokens: state.totalTokens });

    if (step.toolCalls.length) {
      const outcome = await toolPipeline.process(step, iter, persist);
      if (outcome.kind === 'cancelled') {
        await finalizer.cancelled(outcome.reason, 'interrupted');
        return;
      }
      if (outcome.kind === 'complete') {
        await finalizer.completeTask(
          outcome.toolName,
          outcome.summary,
          outcome.assistantAlreadySpoke
        );
        return;
      }
      state.reportTurnTiming(iter, step, outcome.toolMs);
      continue;
    }

    const finalReflection = completion.reviewFinalAnswer(
      String(step.assistantMessage.content || '')
    );
    if (finalReflection) {
      state.messages.push({ role: 'user', content: finalReflection });
      state.reportTurnTiming(iter, step, 0);
      continue;
    }

    state.reportTurnTiming(iter, step, 0);
    await finalizer.completeFinalAnswer();
    return;
  }
}

function recordUsage(state: AgentRunState, step: any, iter: number): void {
  if (step.usage && (step.usage.total_tokens || step.usage.prompt_tokens)) {
    const usage = step.usage;
    const hit = Number(usage.prompt_cache_hit_tokens) || 0;
    const miss = Number(usage.prompt_cache_miss_tokens) || 0;
    const promptTokens = Number(usage.prompt_tokens) || hit + miss;
    if (promptTokens > 0 && (hit > 0 || miss > 0)) {
      const ratio = Math.round((hit / promptTokens) * 100);
      console.log(
        '[RecallFlow] cache iter=' +
          iter +
          ' hit=' +
          hit +
          ' miss=' +
          miss +
          ' (' +
          ratio +
          '%)'
      );
      state.trace({
        phase: 'cache',
        iter,
        hit,
        miss,
        promptTokens,
        ratio,
      });
    }
    state.totalTokens +=
      Number(usage.total_tokens) ||
      (Number(usage.prompt_tokens) || 0) +
        (Number(usage.completion_tokens) || 0);
    return;
  }
  state.totalTokens +=
    estimateMessagesTokens(state.messages) +
    estimateTokens(JSON.stringify(state.tools));
}

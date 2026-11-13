import { compactSnapshotSummary, getToolMetadata } from './tools.ts';
import {
  buildDeterministicReflection,
  checkCompletionClaim,
} from './claim-check.ts';
import {
  classifyTaskKind,
  classifyVerifyOutcome,
  resolveVerifyIntent,
  shouldVerifyCompletion,
  verifyEvidenceSignature,
} from './verification-policy.ts';
import { runCompletionVerification } from './agent-finalization.ts';
import {
  BARE_ANSWER_RETRY_PROMPT,
  FINAL_JSON_RETRY_PROMPT,
  shouldRetryBareFinalAnswer,
  shouldRetryFinalJson,
} from './final-json.ts';
import type { AgentRunState } from './agent-run-state.ts';

export type CompleteTaskDecision =
  | { kind: 'complete'; summary: string; toolName: string }
  | { kind: 'reflect'; reflection: string }
  | { kind: 'cancelled'; reason: string };

function changesState(metadata: any): boolean {
  if (!metadata) return true;
  return metadata.readOnly !== true && metadata.mutatesState !== false;
}

function evidenceText(state: AgentRunState): string {
  return [
    state.ctx.lastSnapshot ? compactSnapshotSummary(state.ctx.lastSnapshot) : '',
    state.ctx.lastEvidence || '',
  ].join('\n');
}

/**
 * `complete_task` 是终态写操作：独立校验不可用或已拒绝时不能由快路径的
 * `done` 信号替代。未触发校验的纯读取/对话任务不受这条限制。
 */
export function completionAllowsTaskCommit(
  verificationState: AgentRunState['ctx']['verificationState']
): boolean {
  return verificationState !== 'unverified' && verificationState !== 'rejected';
}

/** Applies deterministic and model-backed completion checks for complete_task. */
export class CompletionCoordinator {
  private readonly state: AgentRunState;

  constructor(state: AgentRunState) {
    this.state = state;
  }

  private finalJsonReflection(content: unknown, summary?: unknown): string | null {
    const state = this.state;
    if (
      !shouldRetryFinalJson({
        settings: state.settings,
        content,
        summary,
        alreadyRetried: state.finalFormatRetryUsed,
      })
    ) {
      return null;
    }
    state.finalFormatRetryUsed = true;
    state.emit({
      type: 'format-retry',
      reason: 'missing-final-json',
      ...(summary !== undefined ? { via: 'complete_task' } : {}),
    });
    state.trace({
      phase: 'format-retry',
      reason: 'missing-final-json',
      ...(summary !== undefined ? { via: 'complete_task' } : {}),
      toolCalls: state.toolCallCount,
      totalTokens: state.totalTokens,
    });
    return FINAL_JSON_RETRY_PROMPT;
  }

  private bareAnswerReflection(content: unknown, summary?: unknown): string | null {
    const state = this.state;
    if (
      !shouldRetryBareFinalAnswer({
        settings: state.settings,
        content,
        summary,
        alreadyRetried: state.finalFormatRetryUsed,
      })
    ) {
      return null;
    }
    state.finalFormatRetryUsed = true;
    state.emit({
      type: 'format-retry',
      reason: 'non-bare-final-answer',
      ...(summary !== undefined ? { via: 'complete_task' } : {}),
    });
    state.trace({
      phase: 'format-retry',
      reason: 'non-bare-final-answer',
      ...(summary !== undefined ? { via: 'complete_task' } : {}),
      toolCalls: state.toolCallCount,
      totalTokens: state.totalTokens,
    });
    return BARE_ANSWER_RETRY_PROMPT;
  }

  async reviewCompleteTask(result: any, signal: AbortSignal, iter: number): Promise<CompleteTaskDecision> {
    const state = this.state;
    const verifierOn = Boolean(this.state.settings?.verifierEnabled !== false);

    if (verifierOn && state.deterministicFails < Number(state.budget.maxVerifications || 0)) {
      const mutatingTools = [...new Set(state.ranToolNames)].filter((name) => {
        try {
          return changesState(getToolMetadata(name as string));
        } catch {
          return false;
        }
      });
      const precheck = checkCompletionClaim({
        claim: String(result?.result || ''),
        ranTools: [...new Set(state.ranToolNames)],
        mutatingRanTools: mutatingTools,
        failedTools: [...new Set(state.failedToolNames)],
        succeededTools: [...new Set(state.succeededToolNames)],
        evidenceText: evidenceText(state),
      });
      if (precheck.verdict === 'fail') {
        state.deterministicFails += 1;
        state.emit({
          type: 'verify',
          ok: false,
          deterministic: true,
          reason: precheck.reason,
          missing: precheck.reasons.map((reason: any) => reason.message).join('；'),
        });
        state.trace({
          phase: 'verify',
          ok: false,
          deterministic: true,
          codes: precheck.reasons.map((reason: any) => reason.code),
        });
        return { kind: 'reflect', reflection: buildDeterministicReflection(precheck) };
      }
    }

    if (
      shouldVerifyCompletion(
        resolveVerifyIntent(state.intent, state.promotedToResearch),
        state.toolCallCount,
        state.settings
      ) &&
      state.verificationCount < Number(state.budget.maxVerifications || 0)
    ) {
      const taskKind = classifyTaskKind(state.ranToolNames);
      const claim = String(result?.result || '');
      const signature = verifyEvidenceSignature(claim, state.ctx);

      if (state.lastDeniedSignature && signature === state.lastDeniedSignature) {
        state.verificationCount += 1;
        state.emit({
          type: 'verify',
          ok: null,
          advisory: true,
          reason: '页面证据与上次一致；这次校验只作提醒，不阻止交付。',
        });
        state.trace({ phase: 'verify', ok: null, advisory: true, repeated: true });
      } else {
        let verdict = null;
        let verifyError = null;
        try {
          verdict = await runCompletionVerification(
            state.settings,
            state.instruction,
            result,
            state.ctx,
            signal,
            taskKind
          );
        } catch (error) {
          verifyError = error;
        }
        const outcome = classifyVerifyOutcome(verdict, verifyError);
        if (outcome.kind === 'interrupt') {
          return { kind: 'cancelled', reason: 'aborted-during-verify' };
        }

        verdict = outcome.kind === 'verdict' ? outcome.verdict : null;
        if (!verdict) {
          state.ctx.verificationState = 'unverified';
          state.emit({
            type: 'verify',
            ok: null,
            inconclusive: true,
            advisory: true,
            verificationState: 'unverified',
            reason: '独立校验不可用（超时或调用失败）；仅作提醒，不影响交付。',
          });
          state.trace({
            phase: 'verify',
            ok: null,
            verificationState: 'unverified',
            reason: 'verifier-unavailable',
          });
        } else if (verdict.ok === false) {
          // 校验只提醒，不阻止交付：用户已经拿到答案，再让 Agent 重做一轮
          // 只会拖长轨迹、诱发重复 complete_task（RF-AJJTSW 实测）。
          state.ctx.verificationState = 'unverified';
          state.verificationCount += 1;
          state.lastDeniedSignature = signature;
          state.emit({
            type: 'verify',
            ok: false,
            advisory: true,
            reason: verdict.reason,
            missing: verdict.missing,
            suggestion: verdict.suggestion,
          });
          state.trace({
            phase: 'verify',
            ok: false,
            advisory: true,
            reason: verdict.reason,
            missing: verdict.missing,
          });
        } else {
          state.ctx.verificationState = 'verified';
          state.emit({ type: 'verify', ok: true, reason: verdict.reason });
          state.trace({ phase: 'verify', ok: true, reason: verdict.reason });
        }
      }
    }

    const retry = this.finalJsonReflection(
      this.latestAssistantContent(),
      String(result?.result || '任务已完成。')
    );
    if (retry) return { kind: 'reflect', reflection: retry };

    const bareRetry = this.bareAnswerReflection(
      this.latestAssistantContent(),
      String(result?.result || '任务已完成。')
    );
    if (bareRetry) return { kind: 'reflect', reflection: bareRetry };

    return {
      kind: 'complete',
      summary: String(result?.result || '任务已完成。'),
      toolName: 'complete_task',
    };
  }

  reviewFinalAnswer(content: string): string | null {
    const state = this.state;
    const claim = String(content || '');
    const formatRetry = this.finalJsonReflection(claim);
    if (formatRetry) return formatRetry;
    const bareRetry = this.bareAnswerReflection(claim);
    if (bareRetry) return bareRetry;
    if (
      !claim.trim() ||
      !shouldVerifyCompletion(
        resolveVerifyIntent(state.intent, state.promotedToResearch),
        state.toolCallCount,
        state.settings
      ) ||
      state.deterministicFails >= Number(state.budget.maxVerifications || 0)
    ) {
      return null;
    }

    const mutatingTools = [...new Set(state.ranToolNames)].filter((name) => {
      try {
        return changesState(getToolMetadata(name as string));
      } catch {
        return false;
      }
    });
    const precheck = checkCompletionClaim({
      claim,
      ranTools: [...new Set(state.ranToolNames)],
      mutatingRanTools: mutatingTools,
      failedTools: [...new Set(state.failedToolNames)],
      succeededTools: [...new Set(state.succeededToolNames)],
      evidenceText: evidenceText(state),
    });
    if (precheck.verdict !== 'fail') return null;

    state.deterministicFails += 1;
    state.emit({
      type: 'verify',
      ok: false,
      deterministic: true,
      source: 'final-answer',
      reason: precheck.reason,
      missing: precheck.reasons.map((reason: any) => reason.message).join('；'),
    });
    state.trace({
      phase: 'verify',
      ok: false,
      deterministic: true,
      source: 'final-answer',
      codes: precheck.reasons.map((reason: any) => reason.code),
    });
    return buildDeterministicReflection(precheck);
  }

  private latestAssistantContent(): string {
    for (let index = this.state.messages.length - 1; index >= 0; index -= 1) {
      const message = this.state.messages[index];
      if (message && message.role === 'assistant') {
        return String(message.content || '');
      }
    }
    return '';
  }
}

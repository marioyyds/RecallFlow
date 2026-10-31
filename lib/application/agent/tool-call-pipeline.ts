import { executeAnyTool } from './mcp.ts';
import {
  getToolMetadata,
  recordTraceStep,
  validateToolCall,
} from './tools.ts';
import { toolNeedsApproval } from './approval-policy.ts';
import { detectAuthChallenge, authChallengeNotice } from './auth-challenge.ts';
import { resolveCodeExecutionApproval } from '../../shared/settings.ts';
import { RUN_STATUS, TOOL_STATUS } from './agent-state.ts';
import { CONTEXT_TUNING } from './context-tuning.ts';
import {
  INTENTS,
  isToolAllowedForIntent,
  resolveIntent,
} from './intent-router.ts';
import { promoteToResearch } from './intent-policy.ts';
import { buildStuckReflection } from './verifier.ts';
import { EVIDENCE_READ_TOOLS, evidenceAfter } from './verification-policy.ts';
import { visionMessagesFor } from './vision.ts';
import { imageCapNote, shouldSendImage } from './vision.ts';
import { sanitizeLoneSurrogates, sliceSafe } from '../../shared/surrogates.ts';
import {
  appendMissingToolResults,
  describeToolFailure,
  formatTruncationNotice,
  summarizeToolArgs,
} from './agent-messages.ts';
import { resultProgressByChange, toolResultProgress } from './progress-policy.ts';
import {
  readLiveApprovalSettings,
  runParallelBatch,
  waitForToolApproval,
  withTimeout,
} from './tool-execution.ts';
import { CompletionCoordinator } from './agent-completion.ts';
import type { AgentRunState } from './agent-run-state.ts';
import {
  ensureDownloadObservation,
  shouldObserveDownloads,
} from './target-manager.ts';

const RESEARCH_TRIGGER_TOOLS = new Set([
  'fetch_webpage',
  'web_search',
  'open_tab',
  'switch_tab',
  'search_knowledge_base',
  'get_page_snapshot',
  'read_current_page',
  'click_element',
]);
const DOWNLOAD_TRIGGER_TOOLS = new Set(['click_element', 'click_at', 'press_key']);

export type ToolBatchOutcome =
  | { kind: 'continue'; toolMs: number }
  | {
      kind: 'complete';
      summary: string;
      toolName: string;
      assistantAlreadySpoke: boolean;
    }
  | { kind: 'cancelled'; reason: string };

/**
 * Executes one assistant tool-call batch and owns every follow-up message.
 * The terminal decision remains explicit so the loop can choose a finalizer.
 */
export class ToolCallPipeline {
  private readonly completion: CompletionCoordinator;
  private readonly state: AgentRunState;
  private readonly port: any;
  private readonly signal: AbortSignal;

  constructor(
    state: AgentRunState,
    port: any,
    signal: AbortSignal
  ) {
    this.state = state;
    this.port = port;
    this.signal = signal;
    this.completion = new CompletionCoordinator(state);
  }

  async process(
    step: any,
    iter: number,
    persist: (extra: Record<string, any>) => Promise<unknown>
  ): Promise<ToolBatchOutcome> {
    const state = this.state;
    const pendingReflections: string[] = [];
    const downloadTask = shouldObserveDownloads(
      state.detected.sourceText || state.instruction
    );
    if (
      downloadTask &&
      step.toolCalls.some((toolCall: any) => DOWNLOAD_TRIGGER_TOOLS.has(toolCall.name))
    ) {
      const observation = await ensureDownloadObservation(state.ctx.tabId).catch(
        (error) => ({ ok: false, result: String(error?.message || error) })
      );
      state.trace({
        phase: 'download-observer',
        trigger: 'before-click',
        tabId: state.ctx.tabId,
        ok: Boolean(observation.ok),
        result: String(observation.result || ''),
      });
      if (!observation.ok) {
        pendingReflections.push(
          '下载观测未能在点击前开启：' + observation.result +
            ' 可以继续完成用户请求，但不要声称已验证下载成功。'
        );
      }
    }
    let pendingResearchPromotion: (() => void) | null = null;
    let turnToolMs = 0;
    const callIds = step.toolCalls.map(
      (toolCall: any) =>
        toolCall.id ||
        'tool-' + iter + '-' + Math.random().toString(36).slice(2, 8)
    );
    const precomputed = await runParallelBatch(step.toolCalls, {
      enabled: state.settings.parallelToolCalls !== false,
      iter,
      callIds,
      disabledTools: state.disabledTools,
      settings: state.settings,
      ctx: state.ctx,
      sessionApprovedTools: state.sessionApprovedTools,
      isToolAllowed: (name: string) => this.isToolAllowed(name),
      budget: state.budget,
      signal: this.signal,
      emit: state.emit,
      emitState: state.emitState,
      trace: state.trace,
    });

    for (let toolIndex = 0; toolIndex < step.toolCalls.length; toolIndex += 1) {
      const toolCall = step.toolCalls[toolIndex];
      const sequence = state.beginToolCall();
      const metadata = getToolMetadata(toolCall.name);

      if (
        RESEARCH_TRIGGER_TOOLS.has(toolCall.name) &&
        state.intent === INTENTS.CHAT &&
        !state.promotedToResearch
      ) {
        state.promotedToResearch = true;
        pendingResearchPromotion = () =>
          promoteToResearch(
            state.messages,
            state.detected.sourceText || state.instruction,
            state.promptExtras
          );
        state.emit({
          type: 'intent-upgraded',
          intent: INTENTS.RESEARCH,
          label: resolveIntent(INTENTS.RESEARCH).label,
        });
      }

      const callId = callIds[toolIndex];
      const toolState = {
        callId,
        name: toolCall.name,
        status: TOOL_STATUS.PENDING,
      };
      let result: any;
      let authBeforeUrl = state.ctx.pageUrl;
      const validation = validateToolCall(toolCall.name, toolCall.args || {});
      if (!validation.ok) {
        result = { ok: false, result: validation.error };
        toolState.status = TOOL_STATUS.FAILED;
        state.emit({
          type: 'tool-result',
          callId,
          name: toolCall.name,
          status: 'failed',
          result: result.result,
        });
      }

      if (!result && state.disabledTools.has(toolCall.name)) {
        const blocked = this.disabledMessage(toolCall.name);
        state.emit({
          type: 'tool-result',
          callId,
          name: toolCall.name,
          status: 'failed',
          result: blocked,
        });
        state.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: blocked,
        });
        continue;
      }

      if (!result && !this.isToolAllowed(toolCall.name)) {
        const blocked = this.policyBlockedMessage(toolCall.name);
        toolState.status = TOOL_STATUS.FAILED;
        state.emit({
          type: 'tool-result',
          callId,
          name: toolCall.name,
          status: 'failed',
          result: blocked,
        });
        state.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: blocked,
        });
        continue;
      }

      let approvalSettings = state.settings;
      if (metadata.requiresApproval === true) {
        approvalSettings = await readLiveApprovalSettings(state.settings);
      }
      if (
        !result &&
        approvalSettings.toolApproval !== false &&
        toolNeedsApproval(toolCall.name, approvalSettings, state.ctx.pageUrl) &&
        !state.sessionApprovedTools.has(toolCall.name)
      ) {
        toolState.status = TOOL_STATUS.APPROVAL_REQUIRED;
        state.emitState(RUN_STATUS.WAITING_APPROVAL, {
          callId,
          tool: toolCall.name,
        });
        const allowSession =
          metadata.alwaysRequireApproval !== true ||
          resolveCodeExecutionApproval(approvalSettings) === 'session';
        const decision = await waitForToolApproval(
          this.port,
          callId,
          toolCall.name,
          toolCall.args,
          this.signal,
          state.runId,
          allowSession,
          state.emit
        );
        if (decision === 'session' && allowSession) {
          state.sessionApprovedTools.add(toolCall.name);
        }
        if (decision !== 'once' && decision !== 'session') {
          result = {
            ok: false,
            result:
              '用户未批准执行工具「' +
              toolCall.name +
              '」，请不要执行该操作；可说明原因或给出替代方案。',
          };
          toolState.status = TOOL_STATUS.REJECTED;
          state.emit({
            type: 'tool-result',
            callId,
            name: toolCall.name,
            status: 'rejected',
            result: result.result,
          });
          state.emitState(RUN_STATUS.OBSERVING, {
            callId,
            tool: toolCall.name,
            rejected: true,
          });
        }
      }

      if (!result) {
        const precomputedResult = precomputed.get(toolIndex);
        let toolMs = 0;
        if (precomputedResult) {
          result = precomputedResult.res;
          toolMs = precomputedResult.ms;
          authBeforeUrl = precomputedResult.beforeUrl || state.ctx.pageUrl;
        } else {
          toolState.status = TOOL_STATUS.RUNNING;
          state.emitState(RUN_STATUS.EXECUTING, {
            callId,
            tool: toolCall.name,
          });
          state.emit({
            type: 'tool-call',
            callId,
            name: toolCall.name,
            args: toolCall.args,
            requiresApproval: false,
            risk: metadata.risk,
          });
          const startedAt = Date.now();
          authBeforeUrl = state.ctx.pageUrl;
          try {
            result = await withTimeout(
              () => executeAnyTool(toolCall.name, toolCall.args, state.ctx),
              metadata.timeoutMs || state.budget.toolTimeoutMs,
              this.signal,
              toolCall.name
            );
          } catch (error) {
            result = {
              result: describeToolFailure(error, toolCall.name),
              ok: false,
            };
          }
          toolMs = Date.now() - startedAt;
        }
        toolState.status =
          result.ok === false ? TOOL_STATUS.FAILED : TOOL_STATUS.SUCCEEDED;
        this.applyAuthChallenge(toolCall.name, result, authBeforeUrl);
        state.recordToolOutcome(toolCall.name, result.ok !== false);
        turnToolMs += toolMs;
        state.trace({
          phase: 'tool',
          name: toolCall.name,
          args: summarizeToolArgs(toolCall.args),
          status: toolState.status,
          ms: toolMs,
          ok: result.ok !== false,
          code: result.code,
          resultLen: String(result.result || '').length,
        });
        state.emit({
          type: 'tool-result',
          callId,
          name: toolCall.name,
          status: result.ok === false ? 'failed' : 'completed',
          result: result.result,
          ...(result.authChallenge
            ? {
                needsLogin: true,
                loginUrl: result.authChallenge.loginUrl || '',
                authMessage: result.authChallenge.message || '',
                authChallenge: result.authChallenge,
              }
            : {}),
        });
        if (
          metadata.alwaysAvailable !== true &&
          result.blocked === true &&
          !state.disabledTools.has(toolCall.name)
        ) {
          state.disabledTools.add(toolCall.name);
          state.emit({
            type: 'tool-disabled',
            name: toolCall.name,
            reason: result.blockReason || '已达安全上限，禁止继续调用',
          });
        }
        this.applyPostExecuteEffects(toolCall);
      }

      this.applyCitations(result);
      await this.applyTabTarget(result);
      const rawResult = typeof result.result === 'string' ? result.result : '';
      if (rawResult.length > CONTEXT_TUNING.spillResultChars) {
        const resultId = 'res-' + sequence;
        try {
          state.ctx.resultStore.set(resultId, result.result);
        } catch {}
        try {
          state.ctx.resultIds.add(resultId);
        } catch {}
        result.result =
          sliceSafe(result.result, 0, CONTEXT_TUNING.spillInlineChars) +
          formatTruncationNotice(result.result.length, resultId);
      }
      this.sanitizeResult(toolCall.name, result);
      this.emitScreenshot(result);
      if (result.pageSnapshot) state.ctx.lastSnapshot = result.pageSnapshot;
      state.ctx.lastEvidence = evidenceAfter(
        state.ctx.lastEvidence,
        toolCall,
        result,
        summarizeToolArgs
      );
      if (EVIDENCE_READ_TOOLS.has(toolCall.name) && rawResult) {
        state.ctx.lastReadFullText = rawResult;
      }
      try {
        recordTraceStep(state.ctx, toolCall.name, toolCall.args, result);
      } catch {}
      state.messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result.result,
      });
      this.appendVisionMessage(result);

      const progress =
        toolResultProgress(result) ||
        resultProgressByChange(
          state.resultFingerprints,
          toolCall.name,
          result
        );
      if (progress) state.markProgress(iter);

      if (result.complete === true) {
        const decision = await this.completion.reviewCompleteTask(
          result,
          this.signal,
          iter
        );
        if (decision.kind === 'cancelled') return decision;
        if (decision.kind === 'complete') {
          return {
            ...decision,
            summary: decision.summary,
            assistantAlreadySpoke: Boolean(
              step.assistantMessage.content
            ),
          };
        }
        pendingReflections.push(decision.reflection);
        appendMissingToolResults(
          state.messages,
          step.toolCalls,
          toolIndex + 1,
          '（本轮已转入反思，该调用未纳入结果，请勿假设它已执行。）'
        );
        break;
      }

      const guardDecision = state.guard.observe({
        name: toolCall.name,
        args: toolCall.args,
        result,
        readOnly: metadata.readOnly === true,
        progress,
        validationFailed: !validation.ok,
        rejected: toolState.status === TOOL_STATUS.REJECTED,
      });
      if (guardDecision.level === 'reflect') {
        state.emit({
          type: 'stuck-warning',
          name: toolCall.name,
          message: guardDecision.message,
          repeated: guardDecision.repeated,
          noProgressStreak: guardDecision.noProgressStreak,
        });
        const attempt =
          (Number(state.stuckAttempts.get(toolCall.name)) || 0) + 1;
        pendingReflections.push(
          buildStuckReflection(guardDecision.message, {
            reason: guardDecision.reason,
            attempt,
          })
        );
        state.stuckAttempts.set(toolCall.name, attempt);
        state.trace({
          phase: 'reflect',
          reason: guardDecision.reason,
          tool: toolCall.name,
          repeated: guardDecision.repeated,
          failStreak: guardDecision.failStreak,
        });
      }
      await persist({
        status: state.run.status,
        phase: 'after_tool',
        nextIteration: iter + 1,
      }).catch(() => {});
    }

    if (pendingResearchPromotion) pendingResearchPromotion();
    for (const reflection of pendingReflections) {
      state.messages.push({ role: 'user', content: reflection });
    }
    return { kind: 'continue', toolMs: turnToolMs };
  }

  private disabledMessage(name: string): string {
    return (
      '工具「' +
      name +
      '」已在本任务中停用（连续失败或无进展），请改用其他方式完成目标。'
    );
  }

  private policyBlockedMessage(name: string): string {
    const effectiveIntent =
      this.state.intent === INTENTS.CHAT && this.state.promotedToResearch
        ? INTENTS.RESEARCH
        : this.state.intent;
    const label = resolveIntent(effectiveIntent).label;
    return (
      '工具「' + name + '」不属于当前「' + label + '」任务的执行权限。' +
      '请按当前用户请求改用已允许的工具；不要假设该操作已经执行。'
    );
  }

  private isToolAllowed(name: string): boolean {
    const state = this.state;
    const effectiveIntent =
      state.intent === INTENTS.CHAT && state.promotedToResearch
        ? INTENTS.RESEARCH
        : state.intent;
    const loadedTools: string[] = [];
    for (const skillName of state.loadedSkillNames) {
      const skill = state.allSkills.find(
        (candidate: any) =>
          candidate.name === skillName || candidate.id === skillName
      );
      for (const toolName of Array.isArray(skill?.tools) ? skill.tools : []) {
        loadedTools.push(String(toolName));
      }
    }
    return isToolAllowedForIntent(effectiveIntent, name, loadedTools);
  }

  private applyAuthChallenge(name: string, result: any, beforeUrl: string): void {
    const challenge =
      (result.authChallenge && result.authChallenge.required === true
        ? result.authChallenge
        : null) ||
      detectAuthChallenge({
        beforeUrl,
        afterUrl:
          (result.targetTab && result.targetTab.url) ||
          (result.pageSnapshot && result.pageSnapshot.url) ||
          this.state.ctx.pageUrl,
        snapshot: result.pageSnapshot,
        result: result.result,
        ok: result.ok !== false,
        statusCode: result.statusCode || result.httpStatus,
        toolName: name,
      });
    if (!challenge) return;
    result.needsLogin = true;
    result.authChallenge = challenge;
    this.state.ctx.lastAuthChallenge = challenge;
    if (
      typeof result.result === 'string' &&
      !result.result.includes('登录 / 授权入口：')
    ) {
      result.result += authChallengeNotice(challenge);
    }
  }

  private applyPostExecuteEffects(toolCall: any): void {
    const state = this.state;
    if (toolCall.name === 'update_plan') {
      state.emit({
        type: 'plan',
        plan: Array.isArray(state.ctx.plan)
          ? state.ctx.plan.map((item: any) => ({ ...item }))
          : [],
      });
    }
    if (toolCall.name !== 'load_skill') return;
    const loadedName = String(toolCall.args?.name || '').trim();
    const loaded = state.allSkills.find(
      (skill: any) =>
        skill.name === loadedName ||
        skill.title === loadedName ||
        skill.id === loadedName
    );
    if (!loaded) return;
    state.emit({
      type: 'skill',
      skills: [
        {
          name: loaded.name,
          title: loaded.title,
          description: loaded.description,
        },
      ],
    });
    if (!state.loadedSkillNames.includes(loaded.name)) {
      state.loadedSkillNames.push(loaded.name);
    }
    // 技能依赖的工具已经在稳定 capability surface 中下发；加载技能只影响执行期
    // 权限与提示正文，绝不再 push 到 state.tools（那会让请求前缀从 token 0 失配）。
  }

  private applyCitations(result: any): void {
    if (!result.citations) return;
    const citationMap = this.state.recordCitations(result.citations);
    const globalNumbers = Array.from(
      new Set(Object.values(citationMap).filter(Number.isInteger))
    );
    if (typeof result.result !== 'string') return;
    result.result = result.result.replace(
      /(^|\n)([ \t]*)\[(\d{1,2})\]/g,
      (match: string, lead: string, spacing: string, number: string) => {
        const globalIndex = citationMap[parseInt(number, 10)];
        return globalIndex ? lead + spacing + '[' + globalIndex + ']' : match;
      }
    );
    if (globalNumbers.length) {
      result.result +=
        '\n\n（以上内容已登记为参考来源 [' +
        globalNumbers.join(',') +
        ']，回答中引用本页内容时请使用该编号。）';
    }
  }

  private async applyTabTarget(result: any): Promise<void> {
    if (!Number.isInteger(Number(result.targetTabId))) return;
    const state = this.state;
    state.ctx.tabId = Number(result.targetTabId);
    if (result.targetTab) {
      state.ctx.pageUrl = result.targetTab.url || state.ctx.pageUrl;
      state.ctx.pageTitle = result.targetTab.title || state.ctx.pageTitle;
    }
    if (result.noop !== true && result.activated !== false) {
      state.emit({
        type: 'tab-switched',
        tabId: state.ctx.tabId,
        title: state.ctx.pageTitle,
        url: state.ctx.pageUrl,
      });
    }
    if (shouldObserveDownloads(state.detected.sourceText || state.instruction)) {
      const observation = await ensureDownloadObservation(state.ctx.tabId).catch(
        (error) => ({ ok: false, result: String(error?.message || error) })
      );
      state.trace({
        phase: 'download-observer',
        trigger: 'tab-bound',
        tabId: state.ctx.tabId,
        ok: Boolean(observation.ok),
        result: String(observation.result || ''),
      });
    }
  }

  private sanitizeResult(name: string, result: any): void {
    if (typeof result.result !== 'string' || !result.result) return;
    const clean = sanitizeLoneSurrogates(result.result);
    if (clean === result.result) return;
    console.log('[RecallFlow] 工具结果含孤立代理对，已就地清理：' + name);
    result.result = clean;
  }

  private emitScreenshot(result: any): void {
    if (!result?.screenshot?.dataUrl) return;
    this.state.emit({
      type: 'screenshot',
      id: result.screenshot.id,
      dataUrl: result.screenshot.dataUrl,
      label: result.screenshot.label,
      width: result.screenshot.width,
      height: result.screenshot.height,
      bytes: result.screenshot.bytes,
    });
  }

  private appendVisionMessage(result: any): void {
    if (!result?.screenshot?.dataUrl) return;
    const state = this.state;
    const sentImages = Number(state.ctx.visionSentImages) || 0;
    if (shouldSendImage(sentImages)) {
      for (const message of visionMessagesFor([result.screenshot], {
        budget: state.ctx.visionBudget,
      })) {
        state.messages.push(message);
      }
      state.ctx.visionSentImages = sentImages + 1;
    } else {
      state.messages.push({
        role: 'user',
        content: imageCapNote(
          sentImages,
          result.screenshot.label || result.screenshot.name || ''
        ),
      });
    }
  }
}

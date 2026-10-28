import { compactSessionMessages } from './history-policy.ts';

export type SessionWriter = (state: Record<string, any>) => Promise<unknown>;

export interface RunPersistenceState {
  runId: string;
  [key: string]: any;
}

function tail<T>(value: unknown, limit: number, copy = false): T[] {
  const list = Array.isArray(value) ? value : [];
  return (copy ? list.slice() : list).slice(-limit) as T[];
}

function head(value: unknown, limit: number): any[] {
  return (Array.isArray(value) ? value : []).slice(0, limit);
}

/**
 * Persistence boundary for resumable runs. It owns the durable schema and all
 * size limits; the agent loop only supplies its current authoritative facts.
 */
export class RunSessionPersistence {
  private readonly readState: () => RunPersistenceState;
  private readonly write: SessionWriter;

  constructor(readState: () => RunPersistenceState, write: SessionWriter) {
    this.readState = readState;
    this.write = write;
  }

  save(extra: Record<string, any> = {}): Promise<unknown> {
    const state = this.readState();
    const ctx = state.ctx || {};
    return this.write({
      id: state.runId,
      status: state.run.status,
      run: { ...state.run },
      budget: state.budget,
      startedAt: state.startedAt,
      eventSeq: state.eventSeq,
      toolCallCount: state.toolCallCount,
      guard: state.guard,
      promotedToResearch: state.promotedToResearch,
      runCitations: tail(state.runCitations, 60),
      failedUrls: tail(ctx.failedUrls, 80),
      browsingMode: ctx.browsingMode,
      agentWindowId: Number.isInteger(Number(ctx.agentWindowId)) ? Number(ctx.agentWindowId) : null,
      sessionApprovedTools: Array.from(state.sessionApprovedTools || []),
      messages: compactSessionMessages(state.messages),
      instruction: state.instruction,
      selectedText: state.selectedText,
      pickedElements: state.pickedElements,
      intent: state.intent,
      intentKeyword: state.intentKeyword,
      skills: state.skills,
      page: ctx.page,
      pageUrl: ctx.pageUrl,
      pageTitle: ctx.pageTitle,
      tabId: ctx.tabId,
      originalTabId: ctx.originalTabId,
      openedTabs: tail(ctx.openedTabs, Number.MAX_SAFE_INTEGER, true),
      openedTabCount: Number(ctx.openedTabCount || 0),
      tabSwitchCount: Number(ctx.tabSwitchCount || 0),
      disabledTools: Array.from(state.disabledTools || []),
      trace: tail(ctx.trace, 40),
      plan: head(ctx.plan, 20),
      totalTokens: state.totalTokens,
      verificationCount: state.verificationCount,
      lastDeniedSignature: state.lastDeniedSignature,
      ranToolNames: tail(state.ranToolNames, 60),
      failedToolNames: tail(state.failedToolNames, 60),
      succeededToolNames: tail(state.succeededToolNames, 60),
      deterministicFails: state.deterministicFails,
      lastProgressIter: state.lastProgressIter,
      resultIds: tail(Array.from(ctx.resultIds || []), 80),
      ...extra,
    });
  }
}

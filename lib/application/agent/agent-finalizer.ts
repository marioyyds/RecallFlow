import { RUN_STATUS } from './agent-state.ts';
import {
  closeAuxTabs,
  emitTabsClosePending,
  finalizeWithPartialInfo,
} from './agent-finalization.ts';
import type { AgentRunState } from './agent-run-state.ts';
import { RunSessionPersistence } from './session-persistence.ts';
import {
  removeAgentSession,
  saveAgentSession,
} from './session-store.ts';

/** Owns durable writes and the observable terminal event sequence. */
export class AgentRunFinalizer {
  private readonly persistence: RunSessionPersistence;
  private readonly state: AgentRunState;
  private readonly port: any;
  private readonly settings: any;
  private readonly signal: AbortSignal;

  constructor(
    state: AgentRunState,
    port: any,
    settings: any,
    signal: AbortSignal
  ) {
    this.state = state;
    this.port = port;
    this.settings = settings;
    this.signal = signal;
    this.persistence = new RunSessionPersistence(
      () => this.state.persistenceState(),
      (session) => saveAgentSession(session)
    );
  }

  persist(extra: Record<string, any> = {}): Promise<unknown> {
    return this.persistence.save(extra);
  }

  async completeTask(toolName: string, summary: string, assistantAlreadySpoke: boolean): Promise<void> {
    const state = this.state;
    if (!assistantAlreadySpoke) state.emit({ type: 'chunk', text: summary });
    const pendingTabs = await closeAuxTabs(state.ctx).catch(() => []);
    emitTabsClosePending(state.ctx, pendingTabs, state.emit);
    state.emitState(RUN_STATUS.COMPLETED, { tool: toolName });
    state.trace({
      phase: 'complete',
      reason: 'complete_task',
      tool: toolName,
      toolCalls: state.toolCallCount,
      totalTokens: state.totalTokens,
    });
    await this.persist({ status: RUN_STATUS.COMPLETED, reason: 'complete_task' }).catch(() => {});
    state.emit({ type: 'end' });
    await removeAgentSession(state.runId).catch(() => {});
  }

  async completeFinalAnswer(): Promise<void> {
    const state = this.state;
    state.emitState(RUN_STATUS.COMPLETED);
    state.trace({
      phase: 'complete',
      reason: 'final-answer',
      toolCalls: state.toolCallCount,
      totalTokens: state.totalTokens,
    });
    const pendingTabs = await closeAuxTabs(state.ctx).catch(() => []);
    emitTabsClosePending(state.ctx, pendingTabs, state.emit);
    await this.persist({ status: RUN_STATUS.COMPLETED }).catch(() => {});
    state.emit({ type: 'end' });
    await removeAgentSession(state.runId).catch(() => {});
  }

  async timeout(reason: string, extra: Record<string, any> = {}): Promise<void> {
    const state = this.state;
    await finalizeWithPartialInfo(
      this.port,
      this.settings,
      state.messages,
      this.signal,
      state.emit,
      state.tools
    );
    await this.persist({ status: RUN_STATUS.TIMEOUT, reason, ...extra }).catch(() => {});
    const pendingTabs = await closeAuxTabs(state.ctx).catch(() => []);
    emitTabsClosePending(state.ctx, pendingTabs, state.emit);
    state.emit({ type: 'end' });
  }

  /** Stop at an external wall-clock deadline without starting another model call. */
  async timeBudgetExceeded(): Promise<void> {
    const state = this.state;
    await this.persist({ status: RUN_STATUS.TIMEOUT, reason: 'timeBudget' }).catch(() => {});
    const pendingTabs = await closeAuxTabs(state.ctx).catch(() => []);
    emitTabsClosePending(state.ctx, pendingTabs, state.emit);
    state.emit({ type: 'end' });
  }

  async cancelled(reason: string, phase: string): Promise<void> {
    const state = this.state;
    await this.persist({ status: RUN_STATUS.CANCELLED, phase, reason }).catch(() => {});
    state.emitState(RUN_STATUS.CANCELLED, { reason });
    state.trace({ phase: 'interrupted', reason });
    const pendingTabs = await closeAuxTabs(state.ctx).catch(() => []);
    emitTabsClosePending(state.ctx, pendingTabs, state.emit);
    state.emit({ type: 'end' });
  }

  async failed(error: string): Promise<void> {
    const state = this.state;
    state.emitState(RUN_STATUS.FAILED, { error });
    state.trace({ phase: 'error', error });
    state.emit({ type: 'error', error });
    await this.persist({ status: RUN_STATUS.FAILED, error }).catch(() => {});
    const pendingTabs = await closeAuxTabs(state.ctx).catch(() => []);
    emitTabsClosePending(state.ctx, pendingTabs, state.emit);
    state.emit({ type: 'end' });
  }
}

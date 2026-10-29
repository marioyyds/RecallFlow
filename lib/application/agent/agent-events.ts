import { transition } from './agent-state.ts';
import { appendTrace } from './trace.ts';

export interface AgentEventPort {
  postMessage(message: unknown): void;
}

export type AgentTrace = (entry: Record<string, any>) => void;

/** Owns observable run events and trace sequencing. */
export class AgentEventSink {
  private currentSeq: number;
  private readonly port: AgentEventPort;
  private readonly runId: string;
  private readonly observeEvent?: (event: Record<string, any>) => void;

  constructor(options: {
    port: AgentEventPort;
    runId: string;
    seq?: number;
    observeEvent?: (event: Record<string, any>) => void;
  }) {
    this.port = options.port;
    this.runId = String(options.runId || '');
    this.currentSeq = Math.max(0, Number(options.seq) || 0);
    this.observeEvent = options.observeEvent;
  }

  get seq(): number {
    return this.currentSeq;
  }

  emit(event: Record<string, any>): void {
    const message = Object.assign(
      { runId: this.runId, seq: ++this.currentSeq, timestamp: Date.now() },
      event
    );
    try {
      this.port.postMessage(message);
    } catch {
      // The port can disappear while the session remains resumable.
    }
    try {
      if (typeof this.observeEvent === 'function') this.observeEvent(message);
    } catch {}
  }

  trace: AgentTrace = (entry) => {
    try {
      appendTrace(this.runId, entry).catch(() => {});
    } catch {}
  };

  emitState(run: any, next: any, meta: Record<string, any> = {}): void {
    const state = transition(run, next, meta);
    this.emit({ type: 'agent-state', ...state, step: run.currentStep, maxSteps: 0 });
  }

  reportTurnTiming(iter: number, step: any, toolMs: number): void {
    const timing = step && step.timing;
    if (!timing) return;
    const seconds = (ms: number) => Math.round(ms / 100) / 10 + 's';
    console.log(
      '[RecallFlow] turn=' + (iter + 1) +
      ' ttfb=' + seconds(timing.ttfbMs) +
      ' prefill=' + seconds(timing.prefillMs) +
      ' decode=' + seconds(timing.decodeMs) +
      ' tools=' + seconds(toolMs) +
      ' total=' + seconds(timing.totalMs + toolMs)
    );
    this.trace({
      phase: 'turn-timing',
      iter,
      ttfbMs: timing.ttfbMs,
      prefillMs: timing.prefillMs,
      decodeMs: timing.decodeMs,
      toolMs,
      totalMs: timing.totalMs + toolMs,
    });
  }
}

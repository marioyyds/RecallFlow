import type { PreparedAgentRun } from './agent-bootstrap.ts';
import type { RunPersistenceState } from './session-persistence.ts';

/**
 * The mutable state owned by one agent run.
 *
 * Bootstrap produces the initial values; the loop, tool pipeline, completion
 * coordinator, and finalizer mutate this single object. Keeping the ownership
 * here prevents counters and message arrays from drifting between closures.
 */
export class AgentRunState {
  readonly runId: string;
  readonly persisted: any;
  readonly canResume: boolean;
  readonly sessionApprovedTools: Set<string>;
  readonly instruction: string;
  readonly selectedText: string;
  readonly detected: any;
  readonly intent: string;
  readonly allSkills: any[];
  readonly loadedSkillNames: string[];
  readonly budget: any;
  readonly startedAt: number;
  readonly settings: any;
  readonly guard: any;
  readonly stuckAttempts: Map<string, number>;
  readonly resultFingerprints: Map<string, string>;
  readonly run: any;
  readonly ctx: any;
  readonly disabledTools: Set<string>;
  readonly tools: any[];
  readonly promptExtras: string;
  readonly messages: any[];
  readonly resumeIteration: number;
  readonly events: PreparedAgentRun['events'];
  readonly emit: PreparedAgentRun['emit'];
  readonly trace: PreparedAgentRun['trace'];
  readonly reportTurnTiming: PreparedAgentRun['reportTurnTiming'];
  readonly emitState: PreparedAgentRun['emitState'];
  readonly recordCitations: PreparedAgentRun['recordCitations'];
  readonly runCitations: any[];
  readonly ranToolNames: string[];
  readonly failedToolNames: string[];
  readonly succeededToolNames: string[];

  promotedToResearch: boolean;
  toolCallCount: number;
  totalTokens: number;
  verificationCount: number;
  finalFormatRetryUsed: boolean;
  lastDeniedSignature: string;
  deterministicFails: number;
  lastProgressIter: number;
  prevPrefixSnapshot: any;

  private readonly payload: any;

  constructor(prepared: PreparedAgentRun, payload: any, settings: any) {
    this.runId = prepared.runId;
    this.persisted = prepared.persisted;
    this.canResume = prepared.canResume;
    this.sessionApprovedTools = prepared.sessionApprovedTools;
    this.instruction = prepared.instruction;
    this.selectedText = prepared.selectedText;
    this.detected = prepared.detected;
    this.intent = prepared.intent;
    this.allSkills = prepared.allSkills;
    this.loadedSkillNames = prepared.loadedSkillNames;
    this.budget = prepared.budget;
    this.startedAt = prepared.startedAt;
    this.settings = settings;
    this.guard = prepared.guard;
    this.stuckAttempts = prepared.stuckAttempts;
    this.resultFingerprints = prepared.resultFingerprints;
    this.run = prepared.run;
    this.ctx = prepared.ctx;
    this.disabledTools = prepared.disabledTools;
    this.tools = prepared.tools;
    this.promptExtras = prepared.promptExtras;
    this.messages = prepared.messages;
    this.resumeIteration = prepared.resumeIteration;
    this.events = prepared.events;
    this.emit = prepared.emit;
    this.trace = prepared.trace;
    this.reportTurnTiming = prepared.reportTurnTiming;
    this.emitState = prepared.emitState;
    this.recordCitations = prepared.recordCitations;
    this.runCitations = prepared.runCitations;
    this.ranToolNames = prepared.ranToolNames;
    this.failedToolNames = prepared.failedToolNames;
    this.succeededToolNames = prepared.succeededToolNames;

    this.promotedToResearch = prepared.promotedToResearch;
    this.toolCallCount = prepared.toolCallCount;
    this.totalTokens = prepared.totalTokens;
    this.verificationCount = prepared.verificationCount;
    this.finalFormatRetryUsed = false;
    this.lastDeniedSignature = prepared.lastDeniedSignature;
    this.deterministicFails = prepared.deterministicFails;
    this.lastProgressIter = prepared.lastProgressIter;
    this.prevPrefixSnapshot = prepared.prevPrefixSnapshot;
    this.payload = payload;
  }

  beginToolCall(): number {
    this.toolCallCount += 1;
    return this.toolCallCount;
  }

  recordToolOutcome(name: string, ok: boolean): void {
    this.ranToolNames.push(name);
    (ok ? this.succeededToolNames : this.failedToolNames).push(name);
  }

  markProgress(iter: number): void {
    this.lastProgressIter = iter;
  }

  persistenceState(): RunPersistenceState {
    return {
      runId: this.runId,
      run: this.run,
      budget: this.budget,
      startedAt: this.startedAt,
      eventSeq: this.events.seq,
      toolCallCount: this.toolCallCount,
      guard: this.guard.snapshot(),
      promotedToResearch: this.promotedToResearch,
      runCitations: this.runCitations,
      ctx: this.ctx,
      sessionApprovedTools: this.sessionApprovedTools,
      messages: this.messages,
      instruction: this.instruction,
      selectedText: this.selectedText,
      pickedElements:
        (this.payload && this.payload.pickedElements) ||
        (this.canResume ? this.persisted.pickedElements : null) ||
        (this.payload && this.payload.pickedElement ? [this.payload.pickedElement] : []),
      intent: this.intent,
      intentKeyword: this.detected.keyword,
      skills: this.loadedSkillNames,
      disabledTools: this.disabledTools,
      totalTokens: this.totalTokens,
      verificationCount: this.verificationCount,
      lastDeniedSignature: this.lastDeniedSignature,
      ranToolNames: this.ranToolNames,
      failedToolNames: this.failedToolNames,
      succeededToolNames: this.succeededToolNames,
      deterministicFails: this.deterministicFails,
      lastProgressIter: this.lastProgressIter,
    };
  }
}

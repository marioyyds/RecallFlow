// Public agent facade. The implementation lives in focused collaborators so the
// entry point remains a stable dependency boundary for background/UI callers.
import { runAgentLoop } from './agent-loop.ts';

export async function runAgentStream(
  port: any,
  payload: any,
  settings: any,
  book: any,
  signal: AbortSignal,
  tabId: number | undefined,
  observeEvent: any
): Promise<void> {
  return runAgentLoop(
    port,
    payload,
    settings,
    book,
    signal,
    tabId,
    observeEvent
  );
}

export { buildPartialStep, streamAgentStep } from './stream-step.ts';
export { deadlineDecision, resolveAgentBudgetGuard } from './budget.ts';
export {
  FINAL_JSON_RETRY_PROMPT,
  findContractJson,
  hasFinalJsonBlock,
  shouldRetryFinalJson,
} from './final-json.ts';
export {
  readLiveApprovalSettings,
  runParallelBatch,
} from './tool-execution.ts';
export { toolNeedsApproval } from './approval-policy.ts';
export {
  describeToolFailure,
  formatTruncationNotice,
} from './agent-messages.ts';
export {
  resultProgressByChange,
  toolResultProgress,
} from './progress-policy.ts';

export {
  AGENT_BUDGET_DEFAULTS,
  compactSessionMessages,
  sanitizeToolPairing,
  SESSION_MAX_TAIL_MESSAGES,
  SESSION_MESSAGE_MAX_CHARS,
  tokenBudgetExceeded,
  promoteToResearch,
  EVIDENCE_READ_TOOLS,
  buildVerificationEvidence,
  classifyTaskKind,
  classifyVerifyOutcome,
  evaluateLiveness,
  evidenceAfter,
  resolveVerifyIntent,
  shouldVerifyCompletion,
  verifyEvidenceSignature,
} from './agent-contracts.ts';

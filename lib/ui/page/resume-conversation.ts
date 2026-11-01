export interface ResumeConversationResult {
  alreadyHasUser: boolean;
  changed: boolean;
  messages: any[];
}

function normalizedInstruction(instruction: unknown): string {
  return String(instruction || '').trim();
}

/**
 * Find the latest matching user turn. Resume must not require it to be the last
 * message: a previous page may already have persisted an interrupted assistant.
 */
export function latestInstructionUserIndex(messages: unknown, instruction: unknown): number {
  const list = Array.isArray(messages) ? messages : [];
  const wanted = normalizedInstruction(instruction);
  if (!wanted) return -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (
      message &&
      message.role === 'user' &&
      normalizedInstruction(message.content) === wanted
    ) {
      return index;
    }
  }
  return -1;
}

export function hasInstructionUserTurn(messages: unknown, instruction: unknown): boolean {
  return latestInstructionUserIndex(messages, instruction) >= 0;
}

/**
 * A resumable run snapshot supersedes any partial assistant tail persisted by
 * the previous document. Keeping both produces duplicate bubbles and makes the
 * live stream look out of sync with history.
 */
export function pruneResumableAssistantTail(
  messages: unknown,
  instruction: unknown
): ResumeConversationResult {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const userIndex = latestInstructionUserIndex(list, instruction);
  if (userIndex < 0) {
    return { alreadyHasUser: false, changed: false, messages: list };
  }
  const next = list.filter((message, index) => {
    if (index <= userIndex) return true;
    if (!message || message.role !== 'assistant') return true;
    return !(message.live === true || message.interrupted === true);
  });
  return {
    alreadyHasUser: true,
    changed: next.length !== list.length,
    messages: next,
  };
}

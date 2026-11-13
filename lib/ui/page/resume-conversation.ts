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
 *
 * 判定"半截"的三条（任一成立即删）：
 *   · `live === true` / `interrupted === true` —— 明确的进行中/中断标记；
 *   · **正文为空** —— 收尾入库的那条一定有 content（哪怕是错误文案），
 *     而没有 content 的 assistant 只可能是旧文档在跑的过程中落下的一份，
 *     它带着当时的 parts，会被当成"另一条回答"渲染出来（实测：跳转后续跑，
 *     正文里同时出现一条半截回答和一条完整回答）。
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
    const partial = message.live === true || message.interrupted === true;
    const emptyContent = !String(message.content == null ? '' : message.content).trim();
    return !(partial || emptyContent);
  });
  return {
    alreadyHasUser: true,
    changed: next.length !== list.length,
    messages: next,
  };
}

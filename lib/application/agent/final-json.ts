/**
 * Detect the explicit task result contract used by external evaluators.
 *
 * A data-only object is not enough: WebArena-compatible adapters also need a
 * task discriminator and a terminal status. The parser deliberately requires
 * both before treating an answer as complete.
 */
export type ContractJson = Record<string, unknown> & {
  status: string;
  task_type?: string;
  action?: string;
};

function isContractObject(value: unknown): value is ContractJson {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const type =
    typeof record.task_type === 'string'
      ? record.task_type.trim()
      : typeof record.action === 'string'
        ? record.action.trim()
        : '';
  return Boolean(type && typeof record.status === 'string' && record.status.trim());
}

function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Return the last parseable JSON object that satisfies the terminal contract. */
export function findContractJson(text: unknown): ContractJson | null {
  const source = String(text ?? '');
  const fences = [...source.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)];
  for (let index = fences.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(fences[index][1].trim());
      if (isContractObject(value)) return value;
    } catch {}
  }

  for (let end = source.lastIndexOf('}'); end >= 0; end = source.lastIndexOf('}', end - 1)) {
    let start = source.lastIndexOf('{', end);
    while (start >= 0) {
      if (matchBrace(source, start) === end) {
        try {
          const value = JSON.parse(source.slice(start, end + 1));
          if (isContractObject(value)) return value;
          break;
        } catch {
          break;
        }
      }
      start = source.lastIndexOf('{', start - 1);
    }
  }
  return null;
}

export function hasFinalJsonBlock(text: unknown): boolean {
  return Boolean(findContractJson(text));
}

/** A single formatting-only correction; it must never redo the task. */
export const FINAL_JSON_RETRY_PROMPT =
  '你刚才的最终答复里缺少任务要求的 ```json 终态块。' +
  '**不要重新执行任务，也不要新增任何事实或结论**；只把上面的结论按任务给定的字段与取值规则，' +
  '原样整理成一个 ```json 代码块放在答复最后。' +
  '保持结论里原有的粒度：名字/数字/句子等简单值不要包装成对象（除非任务明确要求对象）；' +
  '不要新增结论中没有的字段。' +
  '注意：必须是**可解析的 JSON**，且必须包含 task_type 与 status（缺少任一字段都不算终态）。' +
  '如果你已经有一组数据字段，请把它们放进 retrieved_data，并在外层补上 task_type 与 status；' +
  '不要只输出一个数据对象（例如只有 names/min/max）。';

export function shouldRetryFinalJson(input: {
  settings?: { requireFinalJsonBlock?: unknown } | null;
  content?: unknown;
  summary?: unknown;
  alreadyRetried?: boolean;
} = {}): boolean {
  if (input.settings?.requireFinalJsonBlock !== true || input.alreadyRetried) return false;
  if (hasFinalJsonBlock(input.content)) return false;
  if (input.summary !== undefined && hasFinalJsonBlock(input.summary)) return false;
  return true;
}

/** A single formatting-only correction for strict exact-match answer tasks. */
export const BARE_ANSWER_RETRY_PROMPT =
  '你刚才的最终答复里混入了说明文字，但任务的 exact_match 评分只接受答案值本身。' +
  '**不要重新执行任务，也不要新增、删除或改变任何事实与结论**；' +
  '只从上面的答复中保留已有的最终答案，原样输出答案值。' +
  '不要写解释、步骤、引号外层包装或“答案是”等前缀；如果答案包含多个条目，' +
  '保持任务要求的原始分隔方式。';

/**
 * Detect a likely non-bare exact-match answer. The retry is deliberately
 * formatting-only: the evaluator remains strict after the correction.
 */
export function shouldRetryBareFinalAnswer(input: {
  settings?: { requireBareFinalAnswer?: unknown } | null;
  content?: unknown;
  summary?: unknown;
  alreadyRetried?: boolean;
} = {}): boolean {
  if (input.settings?.requireBareFinalAnswer !== true || input.alreadyRetried) return false;
  const content = String(input.content ?? '').trim();
  const summary = String(input.summary ?? '').trim();
  const text = content || summary;
  if (!text) return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) return true;
  return /^(我|已|根据|完成|任务已完成|the\s+answer\s+is|answer\s*:|result\s*:|答案是)/i.test(text);
}

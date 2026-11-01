export interface CompletedTypeTarget {
  url: string;
  ref: string;
  selector: string;
  valueLength: number;
  at: number;
}

/**
 * 记录本轮已成功写入的字段目标。只保存定位标识和值长度，不保存字段正文。
 * JEV 的后续 target head 用这份账本排除已完成的快/慢路径写入。
 */
export function recordCompletedTypeTarget(
  ctx: any,
  toolName: string,
  args: Record<string, any>,
  result: any,
  pageUrl: string,
  now = Date.now()
): void {
  if (
    toolName !== 'type_text' ||
    result?.ok === false ||
    result?.matchesIntent === false
  ) {
    return;
  }
  const entry: CompletedTypeTarget = {
    url: String(pageUrl || ''),
    ref: String(args?.ref || ''),
    selector: String(result?.selector || args?.selector || ''),
    valueLength: String(args?.value || '').length,
    at: now,
  };
  const previous = Array.isArray(ctx?.completedTypeTargets)
    ? ctx.completedTypeTargets
    : [];
  ctx.completedTypeTargets = previous
    .filter(
      (item: CompletedTypeTarget) =>
        !(
          item &&
          item.url === entry.url &&
          ((entry.ref && item.ref === entry.ref) ||
            (entry.selector && item.selector === entry.selector))
        )
    )
    .concat(entry)
    .slice(-100);
}

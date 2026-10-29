// Model-facing tool failure and truncation messages.
/**
 * 工具异常 → 给模型看的说明（纯函数，便于直测）。
 *
 * 为什么要单独抽出来：原先调用点只写 `{ result: e.message, ok: false }`，
 * 于是超时只会显示「工具执行超时（15000ms）」—— 既没说清**超时不是干净失败**
 * （动作可能已经部分生效），也没给出下一步该做什么。模型很容易据此原样重试，
 * 而重试一个「可能已经做了」的写操作是危险的。
 */
export function describeToolFailure(e: any, toolName: string) {
  const name = String(toolName || '');
  if (e && e.name === 'AbortError') return '任务已取消。';
  if (e && e.rfToolTimeout === true) {
    const secs = Math.round((Number(e.timeoutMs) || 0) / 1000);
    return (
      '工具「' + name + '」执行超时（' + secs + ' 秒）。' +
      '**注意：超时只表示我们不再等它，不代表动作没有发生** —— 它可能已经部分生效。' +
      '请先重新读取页面确认当前状态（如 get_page_snapshot），再决定是重试、换做法还是就此停手；' +
      '不要在未确认的情况下原样重试。'
    );
  }
  // ⚠ 原写法在"错误对象没有 message"时落到 `String(e)` ⇒ 产出 `[object Object]`，
  // 这句废话会被当成工具结果喂给模型（补测试时实测到）。分三种情况显式处理，
  // 同时保留"直接抛字符串"这种非标准但仍然要能看懂的情形。
  let raw;
  if (e && typeof e.message === 'string' && e.message.trim()) raw = e.message;
  else if (typeof e === 'string' && e.trim()) raw = e;
  else raw = '未知错误（工具没有给出原因）';
  return '工具「' + name + '」执行失败：' + raw;
}

/**
 * 大结果被截断时追加的**通知**（模型据此知道"全文还在、可以取回"）。
 *
 * 为什么单独抽成函数：这条通知的格式**被另一个模块用正则解析**
 *（`context.js` 的 `ID_NOTICE_RE` 负责在历史折叠时把 id 抠出来重写一遍）。
 * 两边任何一处改了措辞，id 就会**静默消失** —— 症状只是"模型没去取全文"，
 * 看起来像它偷懒，实际是链接断了。抽成单一来源后，格式只有一个地方可改，
 * 而 `tests/expand-result.test.mjs` 用**真实的这条字符串**测那条链路。
 */
export function formatTruncationNotice(totalChars: any, id: any) {
  return (
    '\n…（结果共 ' + totalChars + ' 字符，已截断；完整内容 id=' + id +
    '，可用 expand_result(id="' + id + '") 分段读取）'
  );
}

export function summarizeToolArgs(args: unknown): string {
  try {
    const value = JSON.stringify(args || {});
    return value.length > 200 ? value.slice(0, 200) + '…' : value;
  } catch {
    return '';
  }
}

/**
 * 提前结束工具批次时，为尚未消费的 tool_call 补上合法结果。
 * 这是续跑协议的一部分：assistant.tool_calls 与 tool 消息必须保持一一配对。
 */
export function appendMissingToolResults(
  messages: Array<Record<string, any>>,
  toolCalls: unknown,
  fromIndex: number,
  reason: string
): void {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  for (let index = fromIndex; index < calls.length; index += 1) {
    messages.push({
      role: 'tool',
      tool_call_id: calls[index].id,
      content: reason,
    });
  }
}

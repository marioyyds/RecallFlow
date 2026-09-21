// 上下文与 token 管理：粗估 token、折叠较早的工具结果、控制发给模型的消息规模。
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

// 粗估 token：中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token。仅用于预算与告警。
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(CJK_RE) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

export function estimateMessagesTokens(messages) {
  let n = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (typeof m.content === 'string') n += estimateTokens(m.content);
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) n += estimateTokens(tc && tc.function && tc.function.arguments);
    }
    n += 4;
  }
  return n;
}

// 把「较早的工具结果」折叠成短摘要，只保留最近 keepFull 条完整内容。
// 长任务下防止上下文无限膨胀；需要时模型可重新读取页面。
export function collapseOldToolResults(messages, keepFull = 6, maxLen = 300) {
  const idx = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i].role === 'tool') idx.push(i);
  }
  const old = idx.slice(0, Math.max(0, idx.length - keepFull));
  let collapsed = 0;
  for (const i of old) {
    const m = messages[i];
    if (typeof m.content === 'string' && m.content.length > maxLen) {
      m.content = m.content.slice(0, maxLen) + '…（较早的工具结果已折叠，如需可重新读取）';
      collapsed += 1;
    }
  }
  return collapsed;
}

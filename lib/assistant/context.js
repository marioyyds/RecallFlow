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

// 历史裁剪：把前端传来的会话历史规范化为可喂给模型的消息。
// - 只保留 user / assistant 且有文本 content 的项；
// - 从最近往回累加，受 token 预算（maxTokens）与条数（maxMessages）双重限制；
// - 单条按 maxChars 截断；
// - assistant 若带 toolSummary（该轮执行轨迹摘要），附在内容后，让「继续」有据可依；
// - noticeOnTruncation 为真且确有更早历史被丢弃时，在开头补一条提示，避免模型误以为对话就此开始。
export function normalizeHistory(history, options = {}) {
  const maxMessages = Number.isFinite(options.maxMessages) ? options.maxMessages : 10;
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 3000;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 8000;
  const notice = options.noticeOnTruncation === true;
  const src = Array.isArray(history) ? history : [];
  const picked = [];
  let tokens = 0;
  for (let i = src.length - 1; i >= 0 && picked.length < maxMessages; i--) {
    const h = src[i];
    if (!h || (h.role !== 'user' && h.role !== 'assistant')) continue;
    if (typeof h.content !== 'string' || !h.content.trim()) continue;
    const t = estimateTokens(h.content);
    // 至少在预算内保留最近一条，避免 maxTokens 过小导致空历史。
    if (picked.length && tokens + t > maxTokens) {
      if (notice) picked.dropped = true;
      break;
    }
    picked.push(h);
    tokens += t;
  }
  picked.reverse();
  const out = picked.map((h) => {
    let content = h.content.slice(0, maxChars);
    if (h.role === 'assistant' && typeof h.toolSummary === 'string' && h.toolSummary.trim()) {
      content += '\n（上一轮执行摘要：' + h.toolSummary.slice(0, 400) + '）';
    }
    return { role: h.role, content };
  });
  if (notice && picked.dropped && out.length) {
    out.unshift({ role: 'user', content: '（更早的对话因长度已省略，以下为最近上下文。）' });
  }
  return out;
}

// 把「较早的工具结果」折叠成短摘要，只保留最近 keepFull 条完整内容。
// 长任务下防止上下文无限膨胀；需要时模型可重新读取页面。
//
// 前缀缓存注意：折叠是在**历史中部**改写消息，从改写点起的所有内容都会变成新前缀。
// 因此这里必须保证「折叠过一次就绝不再变」—— 否则同一批消息每轮都被重新拼接，
// 请求前缀会持续抖动。做法是：先算出结果，与原文完全相同就跳过（不计入计数、不赋值），
// 这样已折叠的消息在后续调用中既不会改动一个字节，也不会让 collapsed 虚报。
const COLLAPSE_SUFFIX = '…（较早的工具结果已折叠，如需可重新读取）';

export function collapseOldToolResults(messages, keepFull = 6, maxLen = 300) {
  const idx = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i].role === 'tool') idx.push(i);
  }
  const old = idx.slice(0, Math.max(0, idx.length - keepFull));
  let collapsed = 0;
  for (const i of old) {
    const m = messages[i];
    if (typeof m.content !== 'string' || m.content.length <= maxLen) continue;
    const next = m.content.slice(0, maxLen) + COLLAPSE_SUFFIX;
    if (next === m.content) continue; // 已经折叠过 → 保持原样，避免无谓的前缀抖动
    m.content = next;
    collapsed += 1;
  }
  return collapsed;
}

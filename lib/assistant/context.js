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
// 请求前缀会持续抖动。做法是：折叠时打一个标记，见到标记就一个字节都不动。
const COLLAPSE_MARK = '【已折叠】';

// 大结果被截断时，agent 会在正文后面追加一条「完整内容 id=res-N」的提示。
// 折叠**必须把它整条认出来并保住** —— 原先是无脑 slice(0, 300)，而 id 恰恰在 3000 字之后，
// 于是 resultStore 里明明还留着全文，模型却再也拿不到 id，等于**压缩掉了可恢复性**。
// 这正是 DSH 的 spill 策略特意保证的事：「可恢复的文本路径」。
//
// 注意必须匹配**整条通知**并锚定在末尾：只匹配 `id=res-N` 的话，body 的结尾会落在
// 通知内部（「…完整内容 」），正文真正的尾部就被当成通知切掉了（实测踩过）。
const ID_NOTICE_RE = /\n…（结果共[^）]*id=(res-[A-Za-z0-9_-]+)[^）]*）\s*$/;
// 兜底：末尾不是标准通知格式时，至少把 id 找出来保住。
const ID_ONLY_RE = /id=(res-[A-Za-z0-9_-]+)/;

/** 折叠一段工具结果：保留头 + 尾，并保住可恢复的 id。纯函数，便于直测。 */
export function buildCollapsed(content, headLen = 300, tailLen = 150) {
  const text = String(content);
  const noticeMatch = text.match(ID_NOTICE_RE);
  // 变量名刻意不叫 id：check-const-assign 的剥离器不认识正则字面量，
  // 上面那两个 /id=(res-…)/ 会被它当成代码，于是 `id=` 看着像对 const id 的赋值（实测误报）。
  const resultId = noticeMatch ? noticeMatch[1] : (text.match(ID_ONLY_RE) || [])[1] || '';
  const body = noticeMatch ? text.slice(0, noticeMatch.index) : text;
  // 头尾本来就够短 → 不值得折叠（保住「折叠后一定更短」这个性质）。
  if (body.length <= headLen + tailLen + 40) return text;
  const head = body.slice(0, headLen);
  const tail = body.slice(-tailLen);
  const notice =
    '\n' +
    COLLAPSE_MARK +
    '共 ' +
    body.length +
    ' 字符，此处保留开头与结尾' +
    (resultId ? '；**全文未丢失**，id=' + resultId + '，可用 expand_result(id="' + resultId + '") 分段取回' : '') +
    '\n';
  return head + notice + tail;
}

export function collapseOldToolResults(messages, keepFull = 6, maxLen = 300, tailLen = 150) {
  const idx = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i].role === 'tool') idx.push(i);
  }
  const old = idx.slice(0, Math.max(0, idx.length - keepFull));
  let collapsed = 0;
  for (const i of old) {
    const m = messages[i];
    if (typeof m.content !== 'string' || m.content.length <= maxLen) continue;
    // 已折叠 → 保持原样，避免无谓的前缀抖动（也保证幂等）。
    if (m.content.indexOf(COLLAPSE_MARK) !== -1) continue;
    const next = buildCollapsed(m.content, maxLen, tailLen);
    if (next === m.content || next.length >= m.content.length) continue;
    m.content = next;
    collapsed += 1;
  }
  return collapsed;
}

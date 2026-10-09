// 完成前校验的「证据选择」：从页面全文里挑出**结论所依据的片段**，而不是永远取开头。
//
// 为什么不能只 slice(0, N)：实测一次「提炼关键要点」任务，页面 10398 字，而校验方拿到的
// 是前 2500 字 —— 对日志/记录类页面，开头恰好是最没信息量的部分（工作区列表、导航、页头），
// 而结论依据的事实（提交哈希、测试数）散落在页面深处。校验方按「证据不足即判未达成」否决，
// agent 只好用 5 次调用重新取证。
//
// 关键前提：**完整原文一直在手边**（ctx.resultStore / 单独留存的读类结果全文），
// 所以这里做的是「按 claim 里的具体事实去定位片段」，而不是把窗口开大一点。
//
// 纯函数，无 chrome / DOM 依赖，可直接单测。

/** 证据总预算（字符）。含页头/页尾与命中片段。 */
export const EVIDENCE_BUDGET = 3600;

/** 每条命中片段在关键词两侧各取多少字符。 */
const SNIPPET_PAD = 130;

/** 页头 / 页尾各保留多少字符（让校验方看到页面的整体形状）。 */
const HEAD_CHARS = 420;
const TAIL_CHARS = 420;

/** 最多用多少个关键词去检索（claim 很长时避免检索爆炸）。 */
const MAX_TOKENS = 30;

/** 单个关键词最多取几处命中（同一事实重复出现时没必要全取）。 */
const MAX_HITS_PER_TOKEN = 2;

/** 出现次数超过这个数的词不算「有辨识度」，不用于检索。 */
const MAX_TOKEN_FREQUENCY = 20;

/** 太短的片段没有检索价值。 */
const MIN_TOKEN_LEN = 3;

const TOKEN_PATTERNS = [
  /[0-9a-f]{7,40}/gi, // 提交哈希
  /[A-Za-z_][A-Za-z0-9_.-]{5,}/g, // 标识符 / 文件名 / 函数名
  /\d{2,}(?:\.\d+)?/g, // 多位数字（单个数字噪声太大）
  /[\u4e00-\u9fff]{6,}/g, // 中文片段（模型引用原文时用得上）
];

/**
 * 从结论里抽出「有辨识度的具体事实」。
 *
 * 刻意只收**高精度**的串：提交哈希、标识符、多位数字、较长的中文片段。
 * 结论里的散文是转述，本来就不会与原文逐字相同，拿去检索只会白费。
 * 出现过于频繁的词（如页面里到处都是的通用词）也会被剔除 —— 它们定位不到任何东西。
 */
export function extractClaimTokens(claim) {
  const text = String(claim === undefined || claim === null ? '' : claim);
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const re of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const tok = m[0];
      if (tok.length < MIN_TOKEN_LEN) continue;
      const key = tok.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tok);
      if (out.length >= MAX_TOKENS * 4) break; // 先粗收，后面按频率筛
    }
  }
  return out.slice(0, MAX_TOKENS * 4);
}

/** 把若干字符区间合并成互不重叠的区间（间隔很近的也并起来，避免碎片化）。 */
function mergeRanges(ranges, gap = 40) {
  const list = ranges.slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r.start - last.end <= gap) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

/**
 * 选出送给校验方的证据文本。
 *
 * @param {{fullText?:string, fallback?:string, claim?:string, budget?:number}} input
 * @returns {{text:string, coverage:string, hitTokens:string[], missedTokens:string[]}}
 */
export function selectEvidence(input = {}) {
  const fullText = String(input.fullText === undefined || input.fullText === null ? '' : input.fullText);
  const fallback = String(input.fallback === undefined || input.fallback === null ? '' : input.fallback);
  const claim = String(input.claim === undefined || input.claim === null ? '' : input.claim);
  const budget = Math.max(400, Number(input.budget) || EVIDENCE_BUDGET);

  // 没有全文可检索时退回旧行为（截断的读类结果），但同样标注它是片段。
  if (!fullText) {
    const text = fallback.slice(0, budget);
    return {
      text,
      coverage: text
        ? '（证据为工具结果的**开头片段**，未做相关性抽取；未列出的部分不代表不存在）'
        : '',
      hitTokens: [],
      missedTokens: [],
    };
  }

  const tokens = extractClaimTokens(claim).filter((t) => {
    // 数一数出现频率：到处都是的词定位不到任何东西。
    // 注意**不能**把出现 0 次的词也滤掉 —— 它们正是要报告给校验方的
    // 「结论里提到、但正文里找不到」的事实，滤掉就永远进不了 missedTokens。
    let count = 0;
    let at = fullText.indexOf(t);
    while (at !== -1 && count <= MAX_TOKEN_FREQUENCY) {
      count += 1;
      at = fullText.indexOf(t, at + t.length);
    }
    return count <= MAX_TOKEN_FREQUENCY;
  });

  const hitTokens = [];
  const missedTokens = [];
  const ranges = [];
  for (const tok of tokens) {
    let at = fullText.indexOf(tok);
    let hits = 0;
    if (at === -1) {
      missedTokens.push(tok);
      continue;
    }
    hitTokens.push(tok);
    while (at !== -1 && hits < MAX_HITS_PER_TOKEN) {
      ranges.push({ start: Math.max(0, at - SNIPPET_PAD), end: Math.min(fullText.length, at + tok.length + SNIPPET_PAD) });
      hits += 1;
      at = fullText.indexOf(tok, at + tok.length);
    }
  }

  // 页头与页尾始终保留：它们给出页面的整体形状（是什么页面、到哪里结束）。
  const head = { start: 0, end: Math.min(fullText.length, HEAD_CHARS) };
  const tail = { start: Math.max(0, fullText.length - TAIL_CHARS), end: fullText.length };
  const merged = mergeRanges([head, ...ranges, tail]);

  const headRange = merged[0];
  const hasTail = merged.length > 1;
  const tailRange = hasTail ? merged[merged.length - 1] : null;
  const midRanges = merged.slice(1, hasTail ? merged.length - 1 : 1);

  const picked = [];
  let used = 0;
  const push = (start, text, truncated) => {
    if (!text) return;
    picked.push({ start, text, truncated });
    used += text.length;
  };

  // 1) 页头
  const headText = fullText.slice(headRange.start, headRange.end);
  push(headRange.start, headText.slice(0, budget), headText.length > budget);

  // 2) 页尾 —— **必须先占额度**。结论与最新状态常在末尾，若按位置顺序拼装，
  // 预算被前半段吃掉后页尾会被静默丢弃，恰好丢掉最该看的那一段。
  if (tailRange) {
    const tailText = fullText.slice(tailRange.start, tailRange.end);
    const room = budget - used;
    if (tailText.length <= room) {
      push(tailRange.start, tailText, false);
    } else if (room >= 80) {
      // 空间不够时保留尾部本身（末尾比开头更没有替代品）
      const cut = tailText.slice(tailText.length - room);
      push(tailRange.end - cut.length, cut, true);
    }
  }

  // 3) 中间命中片段，按出现顺序填剩余额度
  for (const r of midRanges) {
    const room = budget - used;
    if (room < 80) break;
    const piece = fullText.slice(r.start, r.end);
    if (piece.length <= room) push(r.start, piece, false);
    else push(r.start, piece.slice(0, room), true);
  }

  // 按位置排序，输出才是通顺的（片段本身可能因预算被截断）
  picked.sort((a, b) => a.start - b.start);
  const shown = picked.reduce((n, p) => n + p.text.length, 0);
  const body = picked
    .map((p, i) => {
      const lead = p.start > 0 ? '…' : '';
      if (p.truncated) return lead + p.text + '…（本段已截断）';
      // 只有「后面还有内容」时才加省略号：否则一段完整文本末尾凭空多个 …，
      // 读者会以为它被截断了。
      const reachesEnd = p.start + p.text.length >= fullText.length;
      const isLast = i === picked.length - 1;
      return lead + p.text + (isLast && reachesEnd ? '' : '…');
    })
    .join('\n');

  const ratio = Math.min(100, Math.round((shown / fullText.length) * 100));
  const coverage =
    '（以上 ' +
    shown +
    ' 字取自 ' +
    fullText.length +
    ' 字正文（约 ' +
    ratio +
    '%），按结论里出现的具体事实定位片段' +
    (missedTokens.length ? '；其中 ' + missedTokens.length + ' 个具体事实在正文中未找到' : '') +
    '。**未列出的部分不代表不存在**，因此不能仅凭「证据里没有 X」判定 X 是编造的。）';

  return { text: body, coverage, hitTokens, missedTokens };
}

// 上下文与 token 管理：粗估 token、折叠较早的工具结果、控制发给模型的消息规模。
//
// ⚠ 本模块**读**视觉开关：历史回放里那句"图片没传给模型"是模型可见文本，
// 开关打开后它就不再成立（本轮新增的截图确实进了上下文）⇒ 必须按开关二选一。
import { VISION_ENABLED } from '../shared/utils.ts';
// 截断一律走 sliceSafe：孤立代理会让请求体在服务端解析阶段被整单拒收（见该模块说明）。
import { sliceSafe } from '../shared/surrogates.ts';

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

/**
 * 把一条历史的 `content` 归一化成**文本**。
 *
 * ⚠ 旧实现在 `normalizeHistory` 里对非字符串 content 直接 `continue` ✗ ——
 * 数组形态（多模态：文本部件 + 图片部件）的**整轮历史会被静默丢弃**，
 * 而模型看到的只是"历史里没有这一轮"，**无从察觉** ✗
 * 这与本仓库反复强调的纪律相悖：丢东西必须说明。
 *
 * 现在的行为：
 *   · 文本部件 → 原样拼接；
 *   · 图片部件 → 占位为 `[图片]`，并在有图时补一句**如实说明**；
 *   · 其它形态 → 尽力转成字符串；实在取不到就返回空串（由调用方按"空内容"处理）。
 *
 * ⚠ 那句"如实说明"**随视觉开关二选一**（`visionEnabled`）：开关打开后，
 * "未把图片传给模型"就与事实相反了 ✗ ⇒ 开启侧必须说清**哪些图在上下文里、哪些不在**：
 *   · 历史回放只保留文字占位，**不会重传**这些历史图；
 *   · 只有**本次新增**的截图才随请求送进上下文。
 * 笼统改成"图片已传给模型"同样是假话 —— 这些历史图恰恰没传。
 * 关闭侧与改动前**逐字节相同**（纯重构 ⇒ 不需要测量 ✓）。
 *
 * @param {*} content 一条历史的 content（字符串 / 部件数组 / 其它）
 * @param {boolean} [visionEnabled] 覆盖开关（测试用；生产不传，取模块常量）
 */
export function flattenHistoryContent(content, visionEnabled) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content == null) return '';
    try {
      return typeof content === 'object' ? JSON.stringify(content) : String(content);
    } catch (e) {
      return '';
    }
  }
  const texts = [];
  let images = 0;
  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') { texts.push(part); continue; }
    const type = String(part.type || '');
    if (type === 'text' || typeof part.text === 'string') {
      if (part.text) texts.push(String(part.text));
      continue;
    }
    if (type === 'image_url' || type === 'image' || part.image_url) { images += 1; continue; }
    // 其它部件（音频/文件等）目前不支持：留一个可辨认的占位，而不是丢弃整条
    texts.push('[' + (type || '未知部件') + ']');
  }
  let text = texts.join('\n');
  if (images > 0) {
    // 视觉开关打开后，"未把图片传给模型"这句就与事实相反了（第 6 步打开开关时实测确认）✗
    // 所以改成**整句二选一**：
    //   · 关闭侧 = 改动前的原文，**逐字节相同**（纯重构 ⇒ 不需要测量 ✓）；
    //   · 开启侧必须精确到"哪些图在、哪些不在"：历史回放**不重传**图（只留占位），
    //     只有本次新增的截图才会随请求进上下文 —— 笼统说"图片已传给模型"同样是假话。
    // 门禁：tests/history-array-content.test.mjs 两臂都钉住；
    //       tests/vision-text-conditional.test.mjs 的源码级门禁把它算作**第四处**接线点。
    const enabled = typeof visionEnabled === 'boolean' ? visionEnabled : VISION_ENABLED;
    text += (text ? '\n' : '') +
      (enabled
        ? '（该消息含 ' + images + ' 张图片；历史回放**不会重传**这些图片，此处只保留文字占位 —— ' +
          '只有**本次新增**的截图才会随请求送进你的上下文。）'
        : '（该消息含 ' + images + ' 张图片；当前**未把图片传给模型**，仅保留此文字说明。）');
  }
  return text;
}

/** 单条历史消息的字符上限（`normalizeHistory` 的默认 `maxChars`）。 */
export const HISTORY_MAX_CHARS = 3000;
/** 上一轮执行摘要的上限。 */
export const HISTORY_SUMMARY_MAX_CHARS = 400;

/**
 * 单条历史被 `maxChars` 截断时追加的**通知**。
 *
 * 为什么必须单独成函数并被门禁钉住：`agent.js` 要**反着用它** ——
 * `buildInitialMessages` 会判断"历史里最后一条 user 消息是不是当前指令的截断副本"
 * （前端会把当前指令也放进 conversation，不去重就会在请求里出现两次）。
 * 原实现靠 `last.length === 3000` 这个**字面量**判断，一旦这里开始追加通知，
 * 那个判断就会静默失效 ⇒ 指令重复一次。所以两处必须共用同一份形态。
 */
export function formatHistoryTruncationNotice(totalChars, limitChars) {
  return (
    '\n⟨…本条历史已截断：原文共 ' + totalChars + ' 字符，此处只送入前 ' + limitChars +
    ' 字符；**被截掉的部分取不回原文**（历史消息不进暂存，无法用 expand_result 取回），' +
    '需要其细节时请让用户重新说明，或改用工具重新读取页面。⟩'
  );
}

/** 与 `formatHistoryTruncationNotice` 配套的整条匹配（锚定末尾）。 */
export const HISTORY_TRUNC_RE = /\n⟨…本条历史已截断：[\s\S]*⟩$/;

/**
 * "只保留末尾 N 字符"时的通知（**前置**在正文之前）。
 *
 * 与上面的区别只有一个方向：`normalizeHistory` 留头（说明追加在末尾），
 * 而落盘快照（`agent.js` 的 `compactSessionMessages`）留尾 —— 说明必须放在**前面**，
 * 否则读者看到的仍然是一段没有开头的文本。原文同样**没有**留存任何副本。
 */
export function formatTailKeptTruncationNotice(totalChars, limitChars) {
  return (
    '⟨…本条消息过长，只保留末尾：原文共 ' + totalChars + ' 字符，此处从第 ' +
    (totalChars - limitChars + 1) + ' 个字符起；**被截掉的前半段取不回原文**（落盘快照不保存它）⟩\n'
  );
}

/** 与 `formatTailKeptTruncationNotice` 配套的整条匹配（锚定开头）。 */
export const TAIL_TRUNC_RE = /^⟨…本条消息过长，只保留末尾：[\s\S]*?⟩\n/;

/** 去掉"只保留末尾"的通知，拿回真正被保存的正文。 */
export function stripTailKeptTruncationNotice(text) {
  return String(text === undefined || text === null ? '' : text).replace(TAIL_TRUNC_RE, '');
}

/** 去掉截断通知，拿回"真正被送入的内容"（agent.js 去重判据要用它）。 */
export function stripHistoryTruncationNotice(text) {
  return String(text === undefined || text === null ? '' : text).replace(HISTORY_TRUNC_RE, '');
}

/**
 * 归一化后的最后一条 user 消息，是不是**当前指令的副本**？
 *
 * 为什么要它：前端会把当前指令也塞进 `conversation`，`agent.js` 若不删掉历史里的那一份，
 * 指令会在请求里出现两次（模型会以为用户说了两遍）。判据原来写在 agent.js 里且**没有测试**：
 *
 *     last.length === 3000 && instr.startsWith(last)      // 旧写法
 *
 * 其中 `3000` 是 `maxChars` 的**字面量副本**，而"这条历史被截断"这件事恰恰会改变长度 ——
 * 本轮的 A5 收口给截断历史追加了说明 ⇒ 那个等式会静默失效（指令重复一次，没有任何报错）。
 * 现在两处共用同一形态：先剥掉通知，再拿 `HISTORY_MAX_CHARS` 比长度。
 */
export function isDuplicateInstruction(lastContent, instruction) {
  const instr = String(instruction === undefined || instruction === null ? '' : instruction).trim();
  if (!instr) return false;
  const last = stripHistoryTruncationNotice(lastContent).trim();
  if (!last) return false;
  return last === instr || (last.length >= HISTORY_MAX_CHARS && instr.startsWith(last));
}

// 历史裁剪：把前端传来的会话历史规范化为可喂给模型的消息。
// - 只保留 user / assistant 且有文本 content 的项；
// - 从最近往回累加，受 token 预算（maxTokens）与条数（maxMessages）双重限制；
// - 单条按 maxChars 截断，**并且必须说明"被截掉了多少"**（见 formatHistoryTruncationNotice）；
// - assistant 若带 toolSummary（该轮执行轨迹摘要），附在内容后，让「继续」有据可依；
//   ⚠ 摘要本身超长也会被截断并标注 —— 否则"执行摘要"看起来是完整的，而它其实是前半段；
// - noticeOnTruncation 为真且确有更早历史被丢弃时，在开头补一条提示，避免模型误以为对话就此开始；
//   ⚠ **两种上限（条数 / token）都算"丢弃"**：原实现只在 token 预算那条路上置位，
//   于是"条数上限裁掉更早的轮次"在任何配置下都**没有任何提示**（实测：20 条历史、maxMessages=3
//   ⇒ 只留 3 条、"更早的对话"提示出现 0 次）✗ 而生产调用方连 token 那条也没打开过
//   （见 agent.js 的 buildInitialMessages 与 shared/rag.js —— 现在两处都显式传 true）。
// - options.visionEnabled 只给测试用（覆盖视觉开关，决定"图片有没有传下去"那句文案的档位）；
//   生产不传 ⇒ 与 `VISION_ENABLED` 的实际取值一致。
export function normalizeHistory(history, options = {}) {
  const maxMessages = Number.isFinite(options.maxMessages) ? options.maxMessages : 10;
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : HISTORY_MAX_CHARS;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 8000;
  const notice = options.noticeOnTruncation === true;
  const src = Array.isArray(history) ? history : [];
  const picked = [];
  let tokens = 0;
  // 是否真的丢掉了"有内容"的更早历史。两种上限都置位 —— 少了任何一边，
  // 模型都会把"只剩这几轮"当成"对话本来就这么短"。
  let dropped = false;
  for (let i = src.length - 1; i >= 0; i--) {
    const h = src[i];
    if (!h || (h.role !== 'user' && h.role !== 'assistant')) continue;
    // ⚠ 不能因为 content 不是字符串就 `continue`（旧实现如此 ✗）：
    // 数组形态（多模态）的整轮历史会被**静默丢弃**，模型无从察觉。
    // 先归一化成文本，并按视觉开关如实说明"图有没有传下去"。
    // `options.visionEnabled` 只在测试里传；生产不传 ⇒ 由 `flattenHistoryContent` 取模块常量。
    const text = flattenHistoryContent(h.content, options.visionEnabled);
    if (!text.trim()) continue;
    // 条数上限：超出后**还有有内容的历史没被收进来** ⇒ 这是丢弃，必须置位。
    // （旧实现靠循环条件 `picked.length < maxMessages` 退出，这里根本没有置位点，
    //   于是无论 noticeOnTruncation 传什么都提示不出来 —— 实测 20 条 / maxMessages=3 ⇒ 0 次提示。）
    if (picked.length >= maxMessages) {
      dropped = true;
      break;
    }
    const t = estimateTokens(text);
    // 至少在预算内保留最近一条，避免 maxTokens 过小导致空历史。
    if (picked.length && tokens + t > maxTokens) {
      dropped = true;
      break;
    }
    picked.push(Object.assign({}, h, { content: text }));
    tokens += t;
  }
  picked.reverse();
  const out = picked.map((h) => {
    let content = sliceSafe(h.content, 0, maxChars);
    // 单条截断必须**如实标注**：原实现对超长内容直接 slice，一个字节的说明都没有 ⇒
    // 模型把它当完整原文（而它恰恰可能被用来回答"用户前面到底说了什么"）。
    // 这条路径没有 id 可给（历史消息不进 resultStore）⇒ 必须**明说取不回**。
    if (h.content.length > maxChars) content = content + formatHistoryTruncationNotice(h.content.length, maxChars);
    if (h.role === 'assistant' && typeof h.toolSummary === 'string' && h.toolSummary.trim()) {
      const summary = sliceSafe(h.toolSummary, 0, HISTORY_SUMMARY_MAX_CHARS);
      content +=
        '\n（上一轮执行摘要：' + summary +
        (h.toolSummary.length > HISTORY_SUMMARY_MAX_CHARS
          ? '⟨…摘要已截断，共 ' + h.toolSummary.length + ' 字符⟩'
          : '') +
        '）';
    }
    return { role: h.role, content };
  });
  if (notice && dropped && out.length) {
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
  // 折叠是历史中部的整段改写，一旦切裂代理对，坏内容会**永久留在历史里**
  // （每轮都带上 → 每轮都 400）。所以头尾两端都走 sliceSafe。
  const head = sliceSafe(body, 0, headLen);
  const tail = sliceSafe(body, -tailLen);
  const notice =
    '\n' +
    COLLAPSE_MARK +
    '共 ' +
    body.length +
    ' 字符，此处保留开头与结尾' +
    (resultId
      ? '；**全文未丢失**，id=' + resultId + '，可用 expand_result(id="' + resultId + '") 分段取回'
      :
        // ⚠ 没有 id 就**取不回中段**：只有被 agent 截断的大结果才会进 resultStore，
        // 快照 / 页面读取这类结果不进 ⇒ expand_result 找不到它。
        // 所以必须说清"这一段哪里去了、该怎么办"：模型看不到中段时，
        // 它会以为页面里就是没这些东西（实测踩过：日历格子的标签在 JSON 中段，
        // 折叠后就再也看不到，而模型并不知道自己被折叠了）✗
        '；**中段内容已省略且取不回原文**（快照/页面读取类结果不进暂存），' +
        '需要时请**重新调用**产生它的工具（可先用参数缩小范围，如 maxElements / maxText / 滚动到目标再读）') +
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

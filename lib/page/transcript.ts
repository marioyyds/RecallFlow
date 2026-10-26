// 对话记录导出：把面板的 parts 数据模型渲染成 markdown，用于「导出记录」按钮。
//
// 为什么不用 panelBody.textContent（最初的实现）：那样会掺入输入框 placeholder 与按钮
// 文字（「↶ 撤销 ⧉ 复制」），且用户与 AI 之间没有角色分隔，作为交给 AI 或贴进工单的记录
// 基本不可读。
//
// 为什么不做「全部叙述 → 全部工具」的分组（上一版实现）：那会丢掉**时序**。
// 面板里是 text → tool → text → tool 交错推进的，分组之后读起来像
// 「先一口气想完了所有话，再一口气把所有工具跑了一遍」——
// 「因为读到 X 才决定做 Y」这条因果链就断了，而这恰恰是记录要给人/AI 看的东西。
//
// 本模块是纯函数、不碰 DOM，因此可以直接在 node:test 里穷举各种 parts 形状。

// 导出/交接用的文本一律走 sliceSafe：这里流的全是页面原文与模型输出（星形平面字符很多），
// 按码元下标切会切裂代理对 —— 导出看起来只是多个"�"，但同一个字符串进了请求体
// 就会让服务端在解析阶段整单拒收（见 lib/shared/surrogates.js 的事故说明）。
import { sliceSafe } from '../shared/surrogates.js';

/** 进行中轮次的说明标记。放进 content 而不是另设字段 —— 交接包的 trimMessages 只保留 {role, content}。 */
/**
 * 面板的一「步」：叙述 / 正文 / 工具调用 / 工具结果 / 截图 / 提示。
 * 字段按 `type` 组合出现，这里全部写成可选；索引签名留给各轮按需附加的字段
 * （如 `resultTruncated` / `textTruncated` / `⟨…省略参数⟩`）。
 */
export interface TranscriptPart {
  type?: string;
  name?: string;
  text?: string;
  args?: unknown;
  result?: unknown;
  callId?: string;
  label?: string;
  width?: number;
  height?: number;
  bytes?: number;
  [key: string]: unknown;
}

/** 一条引用（ shaping 由 commands.js 采集后交给导出侧）。 */
export interface TranscriptCitation {
  index?: unknown;
  source?: unknown;
  id?: unknown;
  title?: string;
  url?: string;
  snippet?: string;
  snippetTruncated?: boolean;
}

/** 内存里的对话消息。 */
export interface TranscriptMessage {
  role?: string;
  content?: string;
  parts?: TranscriptPart[];
  plan?: unknown[];
  toolSummary?: string;
  selectedText?: string;
  pickedElements?: unknown[];
  citations?: TranscriptCitation[];
  failed?: boolean;
  partial?: boolean;
  interrupted?: boolean;
  /** 下面几个是**持久化时**补上的留痕字段（读回来才可能有） */
  partsOmitted?: number;
  partsTotal?: number;
  contentTruncated?: boolean;
  [key: string]: unknown;
}

/** serializeConversationMessages 的输出：白名单字段 + 每处截断的留痕。 */
export interface SerializedTranscriptMessage {
  role?: string;
  content?: string;
  contentTruncated?: boolean;
  toolSummary?: string;
  toolSummaryTruncated?: boolean;
  selectedText?: string;
  selectedTextTotal?: number;
  selectedTextTruncated?: boolean;
  pickedElements?: unknown[];
  pickedElementsTotal?: number;
  pickedElementsOmitted?: number;
  parts?: TranscriptPart[];
  partsTotal?: number;
  partsOmitted?: number;
  citations?: TranscriptCitation[];
  citationsTotal?: number;
  citationsOmitted?: number;
  plan?: unknown[];
  earlierMessagesOmitted?: number;
  messagesTotal?: number;
}

export const PARTIAL_TURN_NOTE = '（本段在导出时尚未结束：任务仍在进行中，以下是已发生的部分）';

/**
 * 异常收尾轮次的说明标记（断线重试耗尽 / 长时间无响应）。
 *
 * 为什么**不能**复用 `PARTIAL_TURN_NOTE`：那句写的是"任务仍在进行中"，
 * 而这些路径上任务**已经结束**了（不会再有后续输出）。照抄会是一句假话，
 * 而假话会被导出/交接原样交给下一个 AI。
 */
export const INTERRUPTED_TURN_NOTE = '（任务已中断：以下是中断前已发生的部分）';

/**
 * 把「异常收尾的这一轮」组装成一条助手消息。
 *
 * 为什么必须有它：断线重试耗尽与"45 秒无响应"这两条路原先**直接 endStream()**——
 * 而 endStream 会清空 pendingParts，于是屏幕上已经出现的思考 / 工具步骤 / 正文
 * **只存在于 DOM 里**，关掉面板再打开就全没了（数据从未入库）。
 * 这一条与 `buildFailedTurn`（'error' 事件那条路）是同一族：**失败/中断最需要留档**。
 *
 * 入参：`reasonText` 是给用户看的原因（如"任务被中断且后台未能恢复会话"），
 * `liveText` 是已经流出的正文。两者与说明标记一起进 content（交接包只保留 content）。
 */
export function buildInterruptedTurn(parts: unknown, liveText: unknown, reasonText: unknown): TranscriptMessage {
  const list = (Array.isArray(parts) ? parts : []).slice();
  const live = String(liveText === undefined || liveText === null ? '' : liveText).trim();
  const reason = String(reasonText === undefined || reasonText === null ? '' : reasonText).trim();
  const head = [reason, live].filter(Boolean).join('\n\n');
  return {
    role: 'assistant',
    content: (head ? head + '\n\n' : '') + INTERRUPTED_TURN_NOTE,
    parts: list,
    interrupted: true,
  };
}

/**
 * 把「正在进行中的这一轮」组装成一条助手消息。
 *
 * 为什么需要：助手条目只在 'end' 收尾时入库，于是任务进行中导出/交接时
 * conversation 里只有用户消息 —— 正在发生的叙述、工具步骤、已流出的答复全都不见。
 * 而「面板里正出问题、把现场交给外部 AI」恰恰是这个功能最典型的使用时刻。
 *
 * 叙述文本不拆成 narration part 而是放进 content：既避免与 parts 里已固化的叙述重复，
 * 也让导出侧的「结论段」拿到它。
 */
export function buildPartialTurn(parts: unknown, liveText: unknown): TranscriptMessage | null {
  const list = (Array.isArray(parts) ? parts : []).slice();
  const live = String(liveText === undefined || liveText === null ? '' : liveText).trim();
  if (!list.length && !live) return null;
  return {
    role: 'assistant',
    content: (live ? live + '\n\n' : '') + PARTIAL_TURN_NOTE,
    parts: list,
    partial: true,
  };
}

/**
 * 把「以错误结束的这一轮」组装成一条助手消息。
 *
 * 原实现只把错误写进 DOM（errEl.textContent），从不入库：于是「导出记录」与
 * 「会话交接」都看不到它，面板一刷新更是彻底消失 —— 而失败正是最需要交接的时刻。
 *
 * 错误文本只放 content、不额外塞一个 text part：塞进去的话导出侧会判定
 * 「这段文字已经内联展示过」而跳过「### 失败」标题，那个标题就永远不出现。
 * 面板侧由 renderConversation 对 m.failed 强制渲染 content 来保证可见。
 */
export function buildFailedTurn(parts: unknown, errorText: unknown, liveText: unknown): TranscriptMessage {
  const list = (Array.isArray(parts) ? parts : []).slice();
  const text = String(errorText === undefined || errorText === null ? '' : errorText).trim() || '任务失败（未提供错误信息）';
  // **已经流出的正文必须留下来。**
  // 原先这里只写错误文本，于是「跑到一半失败」会发生两件事：
  //   ① 屏幕上刚读完的那半截回答从记录里消失 —— 因为它只累积在 pendingNarration 里，
  //      要等 'end' 才被 push 进 parts，而失败根本走不到 'end'；
  //   ② 用户重开面板后，那一轮只剩一行红字，正文再也找不回来。
  // 这与 buildInterruptedTurn（断线那条路）是同一族问题，那里早就把 liveText 带上了，
  // 唯独失败这条路当时漏了 —— 而失败恰恰比中断更常见。
  const live = String(liveText === undefined || liveText === null ? '' : liveText).trim();
  return { role: 'assistant', content: live ? text + '\n\n' + live : text, parts: list, failed: true };
}

/**
 * 去掉模型自己在答复末尾写的「参考来源」小节。
 *
 * 实测导出里同一段来源连着出现两次：模型在答复末尾自己写了一份
 * （`### 参考来源` + 条目，标题后没有空行），导出器又按 m.citations 追加了一份
 * （标题后必带空行）。两份内容相同、格式不同，交给外部 AI 或贴进工单都很难看。
 *
 * 只删**末尾**那一段，且要求其后每一非空行都长得像来源条目（`- x` / `[n] x` / `1. x`），
 * 避免误删正文里讨论「参考来源」的段落。删空时保留原文，不为了去重把内容弄没。
 */
export function stripTrailingSources(text: unknown): string {
  const s = String(text === undefined || text === null ? '' : text);
  if (!s) return s;
  const lines = s.split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    // 模型写来源段的形式不止一种：`### 参考来源` / `**参考来源**` / `参考来源：` / 裸行。
    // 但要求**整行只有这个标题**，避免把正文里「参考来源如下：…」这类句子当成段首。
    if (/^(?:#{1,6}\s*)?(?:\*\*)?参考来源(?:\*\*)?\s*[:：]?\s*$/.test(lines[i].trim())) last = i;
  }
  if (last < 0) return s;
  const tail = lines.slice(last + 1).filter((l) => l.trim());
  if (!tail.length) return s;
  if (!tail.every((l) => /^[-*]\s|^\[\d+\]|^\d+[.、]\s/.test(l.trim()))) return s;
  const head = lines.slice(0, last).join('\n').trim();
  return head || s;
}

/**
 * 这段文字是否已经作为叙述/text 记录过 —— 用于让面板避免把同一段最终答复记录两次。
 *
 * 放在本模块（纯函数）而不是 chat.js：chat.js 是内容脚本，import 就会碰 DOM，
 * 没法直接单测，而这里恰恰是个不该出错、出错了也只是「导出里同一句话出现两遍」的
 * 静默问题。
 *
 * 原判定是「紧邻的最后一个 part 是 narration 且文字相同」，两种情况下都会失效：
 *   1) 本轮最后一步是工具调用（complete_task 本身就是工具）→ 最后一个 part 是 tool-result；
 *   2) 上一次收尾已经 push 过同内容的 text part → 类型不是 narration。
 * 两种都会把同一段最终答复记两遍，导出里连着显示两次（实测 RF-27A7CA 记录末尾）。
 *
 * 改为：从末尾向前扫，**跳过工具类 part**（它们夹在文字之间是正常的时序），
 * 按内容比较，且 narration 与 text 都算。只比较最近的一段文字 ——
 * 隔了别的文字之后再说一遍同一句话，那是有意重复，不该被吞掉。
 */
export function alreadyCommittedAsText(parts: unknown, text: unknown): boolean {
  const want = citationNeutralTextKey(collapseImmediateRepeatedText(text));
  if (!want) return false;
  const list: TranscriptPart[] = Array.isArray(parts) ? (parts as TranscriptPart[]) : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (!p) continue;
    if (p.type === 'tool-call' || p.type === 'tool-result' || p.type === 'screenshot') continue;
    if (p.type !== 'narration' && p.type !== 'text') continue;
    return citationNeutralTextKey(collapseImmediateRepeatedText(p.text)) === want;
  }
  return false;
}

/**
 * 去重用的文本指纹：空白归一 + 忽略引文编号，但保留引文标签。
 *
 * `[6]`、`[4]`、`[来源6]` 会分别变成 `[]`、`[]`、`[来源]`。会话里同一段正文
 * 经常在引文重编号前后各落一份；如果拿原始字符串比较，就会把同一段话误判成
 * 两段不同内容。这个指纹只用于判断“是否同一段文字”，不会改动展示内容。
 */
export function citationNeutralTextKey(text: unknown): string {
  return norm(text).replace(/[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g, (whole, inner) => {
    const label = String(inner).replace(/\s*\d+\s*$/, '').trim();
    return label ? '[' + label + ']' : '[]';
  });
}

/**
 * 折叠同一段长正文在**一个 text 字符串内部**连续出现两次的情况。
 *
 * 真实故障里两次输出只差引文号（`[6]` / `[4]`），所以不能直接做字符串相等。
 * 只接受长度 ≥200 且归一后完全一致的上下半段；标题或空行处作为候选切分点。
 * 保留后一份，因为它通常已经过最终引文重编号。
 */
export function collapseImmediateRepeatedText(text: unknown): string {
  const s = String(text == null ? '' : text);
  if (s.length < 400) return s;
  const candidates = [];
  const headingRe = /^#{1,6}\s/gm;
  let hm;
  while ((hm = headingRe.exec(s))) {
    if (hm.index > 0) candidates.push(hm.index);
  }
  const blocks = s.split(/\n{2,}/);
  if (blocks.length >= 2 && blocks.length <= 120) {
    let pos = 0;
    for (let i = 1; i < blocks.length; i++) {
      const before = blocks.slice(0, i).join('\n\n');
      const after = blocks.slice(i).join('\n\n');
      if (after.trim()) {
        const delta = s.indexOf(after.trim(), pos);
        if (delta > 0) candidates.push(delta);
      }
      pos += blocks[i - 1].length + 2;
    }
  }
  const seen = new Set();
  for (const at of candidates) {
    const idx = Number(at);
    if (!Number.isInteger(idx) || idx <= 0 || idx >= s.length || seen.has(idx)) continue;
    seen.add(idx);
    const left = s.slice(0, idx).trim();
    const right = s.slice(idx).trim();
    if (left.length < 200 || right.length < 200) continue;
    const ratio = left.length / right.length;
    if (ratio < 0.7 || ratio > 1.3) continue;
    const leftKey = citationNeutralTextKey(left);
    if (leftKey.length >= 200 && leftKey === citationNeutralTextKey(right)) return right;
  }
  return s;
}

/**
 * 折叠**相邻**的重复正文 part。
 *
 * 只处理中间没有工具/截图/提示隔开的文字段，并保留较新的那一份（它通常已经过了
 * 最终引文重编号）。短文本不去重，避免把有意的重复表达（“好”“继续”）吃掉。
 */
export function dedupeAdjacentTextParts(parts: unknown): TranscriptPart[] {
  const src: TranscriptPart[] = Array.isArray(parts) ? (parts as TranscriptPart[]) : [];
  const out: TranscriptPart[] = [];
  let lastTextKey = '';
  let lastTextIndex = -1;
  for (const part of src) {
    if (!part) continue;
    if ((part.type === 'narration' || part.type === 'text') && part.text) {
      const collapsedText = collapseImmediateRepeatedText(part.text);
      const normalizedPart = collapsedText === part.text ? part : Object.assign({}, part, { text: collapsedText });
      const key = citationNeutralTextKey(collapsedText);
      if (key.length >= 80 && key === lastTextKey) {
        out[lastTextIndex] = normalizedPart;
        continue;
      }
      out.push(normalizedPart);
      lastTextKey = key;
      lastTextIndex = out.length - 1;
      continue;
    }
    out.push(part);
    // 工具步骤、截图、notice 是真实时间线边界：隔开之后再次出现同一句话不能吞掉。
    lastTextKey = '';
    lastTextIndex = -1;
  }
  return out;
}

/**
 * 清理已落盘的旧会话：修复上线前产生的重复 parts / 重复 content 会在打开历史会话时
 * 自动收敛。返回新数组，不修改传入对象；后续正常 saveConversation 会写回干净版本。
 */
export function normalizeConversationDuplicates(messages: unknown): TranscriptMessage[] {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    if (!m || m.role !== 'assistant') return m;
    const content = collapseImmediateRepeatedText(m.content || '');
    const parts = Array.isArray(m.parts)
      ? dedupeAdjacentTextParts(m.parts)
      : m.parts;
    if (content === m.content && parts === m.parts) return m;
    return Object.assign({}, m, { content, parts });
  });
}

/** 结果文本压成单行并截断（用于工具结果这类散文；JSON 参数走 previewArgsJson，不能这么压）。 */
// ---------------------------------------------------------------- 对话持久化（纯函数）
//
// 为什么放在这里：对话存进 `chrome.storage.session`（每个标签页一个 key，
// 而配额是**所有标签页共享**的约 10MB）。此前只有"步数上限 30"、单步**完全没有上限** ——
// 一条 20KB 的页面快照乘 30 步就是 600KB，一个标签页几轮就能把配额吃掉。
//
// 两个上限的分工：
//   · **步数留得多**（30 → 200）："前一个 AI 试过什么"是排查的关键
//     （实测一次检索类会话约 60 步，原先 30 步一超就被丢掉）；
//   · **单步有界**：结果 / 参数 / 叙述各自截断。
// 另外把"丢了多少步"记成**显式事实**（partsTotal / partsOmitted）：
// 刷新后导出的记录必须能说明自己为什么不完整，而不是看起来像"当时就只做了这些"。
export const MAX_PARTS = 200;
export const MAX_PART_RESULT_CHARS = 2000;
export const MAX_PART_ARGS_CHARS = 400;
export const MAX_PART_TEXT_CHARS = 2000;
export const MAX_MESSAGE_CONTENT_CHARS = 20000;

/** 单步有界化（只裁长度，不改结构）。 */
function clipPart(p: TranscriptPart): TranscriptPart {
  const out = Object.assign({}, p);
  if (typeof out.result === 'string' && out.result.length > MAX_PART_RESULT_CHARS) {
    out.result = sliceSafe(out.result, 0, MAX_PART_RESULT_CHARS);
    out.resultTruncated = true;
  }
  if (typeof out.text === 'string' && out.text.length > MAX_PART_TEXT_CHARS) {
    out.text = sliceSafe(out.text, 0, MAX_PART_TEXT_CHARS);
    out.textTruncated = true;
  }
  if (out.args && typeof out.args === 'object') {
    let s = '';
    try {
      s = JSON.stringify(out.args);
    } catch (e) {
      s = '';
    }
    // ⚠ 键名也必须用**一眼可辨的元信息形态**，不能写成 `'…'`：
    // 后者看起来就是一个真实字段名，读者（人或 AI）分不清"这是参数"还是"这是说明" ✗
    //（同一个坑在 `lib/page/debug-hook.js:103` 已经踩过并修过；这里当时漏了，
    //  因为 tests/omit-mark.test.mjs 的 ⑤ 只扫了 debug-hook —— 现在两边都扫。）
    if (s.length > MAX_PART_ARGS_CHARS) {
      out.args = {};
      // 赋值走整对象替换：`out.args` 的类型是 unknown，不能对它做下标写。
      out.args = { [OMIT_ARGS_KEY]: '参数过长（' + s.length + ' 字符），已省略（原文未留存，取不回）' };
    }
  }
  return out;
}

/**
 * 一次导出最多带多少条**消息**（注意：与 `MAX_PARTS`（步数）是两个不同的量）。
 *
 * **(e-2) 决定：保持 20，不改** —— 理由与边界写在这里，避免以后凭感觉抬 ✓
 * · 两个量管的事不同：`MAX_PARTS = 200` 管**步数**（工具调用/思考段），本常量管**交付出去的消息条数**；
 *   一次长任务可以有 50+ 步、但交付侧只带最近 20 条消息 ⇒ 这是**交付口径的选择**，不是"记录丢了"✗
 * · **记录侧存的是全量**（② 会话容量那一项的工作：handoff 记录不裁剪、交付按需取 ✓），
 *   并且**每一处截断都留痕**（导出路径 5 处 + 单条 toolSummary/引用上限 ✓，见本节下面的常量）✓
 * · ⚠ 要抬这个数 = **模型可见内容变了** ⇒ 按仓库纪律必须**真模型 eval 实测**（基线见 docs/real-model-eval-log.md）
 *   并同步文档数字；**不许**为了"看起来更全"直接改 ✗
 */
export const MAX_MESSAGES = 20;
/** 单条消息里 toolSummary / 引用 的上限（超出必须**留痕**，见下）。 */
export const MAX_TOOL_SUMMARY_CHARS = 600;
export const MAX_CITATIONS = 20;
export const MAX_CITATION_SNIPPET_CHARS = 300;
export const MAX_SELECTED_TEXT_CHARS = 2000;

/**
 * 把内存里的对话整理成**可持久化**的形态（白名单式字段拷贝）。
 *
 * ⚠ 白名单的含义：新字段不加进来就**存不下来**，而症状是"当时看得见、刷新后没了"，
 * 很容易被误判成渲染问题。
 *
 * ⚠⚠ **每一处截断都必须留痕**（本仓库硬纪律：丢东西必须说明）。这一版之前有 5 处是**静默**的：
 * 消息条数（`slice(-20)`）、`toolSummary`、`pickedElements`、`citations`、引用 snippet
 * —— 其中**消息条数**那处最危险：下游（交接包的 `trailTotal`、导出记录）都在**这 20 条之内**统计，
 * 静默丢消息会让"会话真实步数"看起来像整个会话，其实只是最近一段 ✗
 * （`parts` 与 `content` 早就有 `partsOmitted` / `contentTruncated` 标记，这里补齐其余各处。）
 */
export function serializeConversationMessages(conversation: unknown): SerializedTranscriptMessage[] {
  const all: TranscriptMessage[] = Array.isArray(conversation) ? (conversation as TranscriptMessage[]) : [];
  const kept = all.slice(-MAX_MESSAGES);
  return kept.map((m, i) => {
    const copy: SerializedTranscriptMessage = { role: m.role };
    // 只在**第一条**留痕：它表示"这条之前还有 N 条没被导出"（取不回）
    if (i === 0 && all.length > kept.length) {
      copy.earlierMessagesOmitted = all.length - kept.length;
      copy.messagesTotal = all.length;
    }
    if (typeof m.content === 'string') {
      copy.content = sliceSafe(m.content, 0, MAX_MESSAGE_CONTENT_CHARS);
      if (m.content.length > MAX_MESSAGE_CONTENT_CHARS) copy.contentTruncated = true;
    }
    if (typeof m.toolSummary === 'string' && m.toolSummary) {
      copy.toolSummary = sliceSafe(m.toolSummary, 0, MAX_TOOL_SUMMARY_CHARS);
      if (m.toolSummary.length > MAX_TOOL_SUMMARY_CHARS) copy.toolSummaryTruncated = true;
    }
    if (typeof m.selectedText === 'string' && m.selectedText) {
      copy.selectedText = sliceSafe(m.selectedText, 0, MAX_SELECTED_TEXT_CHARS);
      if (m.selectedText.length > MAX_SELECTED_TEXT_CHARS) {
        copy.selectedTextTotal = m.selectedText.length;
        copy.selectedTextTruncated = true;
      }
    }
    if (Array.isArray(m.pickedElements) && m.pickedElements.length) {
      // ⚠ 这一句的**字面量形态**被门禁 `picked-in-message.test.mjs` 盯着
      //   （「持久化白名单里必须有 pickedElements」）⇒ 不改成变量、也不改门禁；
      //   要留痕就在下面用拷完的长度自己算 ✓
      copy.pickedElements = m.pickedElements.slice(0, 8);
      if (m.pickedElements.length > copy.pickedElements.length) {
        copy.pickedElementsTotal = m.pickedElements.length;
        copy.pickedElementsOmitted = m.pickedElements.length - copy.pickedElements.length;
      }
    }
    if (Array.isArray(m.parts)) {
      const partsAll = m.parts;
      const partsKept = partsAll.slice(-MAX_PARTS);
      copy.parts = partsKept.map(clipPart);
      if (partsAll.length > partsKept.length) {
        copy.partsTotal = partsAll.length;
        copy.partsOmitted = partsAll.length - partsKept.length;
      }
    }
    if (Array.isArray(m.citations)) {
      const keptCites = m.citations.slice(0, MAX_CITATIONS);
      copy.citations = keptCites.map((c): TranscriptCitation => {
        const snippet = String(c.snippet || '');
        const out: TranscriptCitation = {
          index: c.index, source: c.source, id: c.id, title: c.title, url: c.url,
          snippet: sliceSafe(snippet, 0, MAX_CITATION_SNIPPET_CHARS),
        };
        if (snippet.length > MAX_CITATION_SNIPPET_CHARS) out.snippetTruncated = true;
        return out;
      });
      if (m.citations.length > keptCites.length) {
        copy.citationsTotal = m.citations.length;
        copy.citationsOmitted = m.citations.length - keptCites.length;
      }
    }
    if (Array.isArray(m.plan)) copy.plan = m.plan;
    return copy;
  });
}

/**
 * 持久化到 IndexedDB 的完整副本：不做消息条数、正文、工具结果或引用裁剪。
 *
 * 模型上下文仍由 agent.js 的 normalizeHistory 单独限制；把“完整存档”和
 * “发给模型的窗口”分开，避免为了省 token 永久删除用户历史。
 */
export function serializeCompleteConversationMessages(conversation: unknown): TranscriptMessage[] {
  const src: TranscriptMessage[] = Array.isArray(conversation) ? (conversation as TranscriptMessage[]) : [];
  try {
    if (typeof structuredClone === 'function') return structuredClone(src);
  } catch (e) {}
  try {
    return JSON.parse(JSON.stringify(src));
  } catch (e) {
    return src.slice();
  }
}

function clipInline(text: unknown, max: number): string {
  const t = norm(text);
  if (!t) return '';
  return t.length > max ? sliceSafe(t, 0, max) + '…（共 ' + t.length + ' 字符，已截断）' : t;
}

/** 空白归一：只用于**比较**与散文压缩，绝不用于 JSON 参数（会破坏原文）。 */
function norm(text: unknown): string {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
}

/**
 * 生成**永远结构合法**的参数预览。
 *
 * 为什么不能直接 `JSON.stringify(args).slice(0, 240)`（上一版实现）：那样会切出
 * `{"texts":["甲","乙","丙` 这种半截 JSON —— 记录里看起来像数据坏了，
 * 而它只是被截断了。这里改成「先按结构缩短值，再序列化」：
/**
 * 省略说明的**统一形态**：`⟨…省略 N 项⟩`。
 *
 * 为什么不能沿用 `…共 N 项`（原先的写法）：它被作为**数组元素**塞进被序列化的参数里，
 * 于是记录里出现 `{"checkTexts":["甲","乙","丙","…共 6 项"]}` ——
 * 与真实数据**形态完全一样**，读者（人或 AI）会把它当成一个真的值 ✗
 *
 * 这不是假想：它就是本仓库一次真实误判的源头 —— 我看到导出的这一行，
 * 先判断成"模型把省略标记当参数传了"，再怀疑是 debug-hook 的锅，
 * **两次都错**：真正生成它的是本文件的 `previewArgsJson`（导出渲染器自己）。
 * 尖括号在页面数据里几乎不出现，一眼能看出是"元信息"。
 */
export const OMIT_MARK_START = '⟨…省略 ';
export const OMIT_MARK_END = ' 项⟩';
export function formatOmittedItems(n: number | string): string {
  return OMIT_MARK_START + n + OMIT_MARK_END;
}

/**
 * 整个 `args` 被替换成说明时用的**键名**（与 `⟨…省略 N 项⟩` 同一形态族）。
 *
 * 为什么键名也要是这个形态：键名是**元信息的位置**，写成 `'…'`（或任何普通词）
 * 就会与真实参数名同形 —— 读者无法区分"模型传了这个字段"和"渲染器说参数太长"。
 * 门禁：`tests/omit-mark.test.mjs` 的 ⑤ 同时扫本文件与 debug-hook.js。
 */
export const OMIT_ARGS_KEY = '⟨…省略参数⟩';

/**
 * 长字符串尾部加省略号，数组只留前几项并补一个省略标记元素，
 * 结果始终是完整、可解析的 JSON。
 *
 * 仍然超长时退化为「只列字段名」，同样保证合法。
 */
export function previewArgsJson(args: unknown, maxLen: number = 240): string {
  const shorten = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return v.length > 80 ? sliceSafe(v, 0, 80) + '…' : v;
    if (Array.isArray(v)) {
      const cap = 3;
      const head: unknown[] = v.slice(0, cap).map((x) => shorten(x, depth + 1));
      if (v.length > cap) head.push(formatOmittedItems(v.length));
      return head;
    }
    if (v && typeof v === 'object') {
      if (depth >= 3) return '…';
      const src = v as Record<string, unknown>;
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(src)) o[k] = shorten(src[k], depth + 1);
      return o;
    }
    return v;
  };
  try {
    const json = JSON.stringify(shorten(args || {}, 0));
    if (json && json.length <= maxLen) return json;
    const keys = Object.keys((args && typeof args === 'object' ? args : {}) as Record<string, unknown>);
    if (!keys.length) return '{}';
    // 同 clipPart：退化成"说明"时，键名必须是可辨的元信息形态（不能是 `'…'`）。
    const out: Record<string, string> = {};
    out[OMIT_ARGS_KEY] = '参数过长，字段：' + keys.slice(0, 8).join(', ') + '（其余未列出）';
    return JSON.stringify(out);
  } catch (e) {
    // 循环引用等异常输入：宁可少给信息，也不要让导出整个失败
    return '{…}';
  }
}

function toolLine(p: TranscriptPart, result: TranscriptPart | undefined, maxResultLen: number): string {
  const mark = !result ? '…' : result.status === 'completed' ? '✓' : result.status === 'failed' ? '✗' : '—';
  const args = previewArgsJson(p.args);
  const detail = clipInline(result ? result.result : '', maxResultLen);
  return '- `' + p.name + '` ' + args + ' → ' + mark + (detail ? ' ' + detail : '');
}

function screenshotLine(p: TranscriptPart): string {
  const bits = [];
  if (p.label) bits.push(String(p.label));
  if (p.width && p.height) bits.push(p.width + '×' + p.height);
  if (p.bytes) bits.push(Math.round(Number(p.bytes) / 1024) + 'KB');
  return '- （截图' + (bits.length ? '：' + bits.join(' · ') : '') + '）';
}

/**
 * @param input
 * @param input.title 页面标题
 * @param input.url 页面 URL
 * @param input.exportedAt 导出时间（已格式化）
 * @param [input.handoffId] 会话标识，形如 RF-XXXXXX
 * @param input.conversation 对话数据模型
 * @param [input.maxResultLen] 单条工具结果的截断长度
 * @returns markdown
 */
/** buildTranscript 的输入。 */
export interface TranscriptInput {
  title?: string;
  url?: string;
  exportedAt?: string;
  handoffId?: string;
  conversation?: TranscriptMessage[];
  maxResultLen?: number;
}

export function buildTranscript(input: TranscriptInput = {}): string {
  const { title, url, exportedAt, handoffId, conversation, maxResultLen = 500 } = input;
  const out = [];
  out.push('# RecallFlow 对话记录');
  out.push('');
  out.push('- 页面：' + (title || '(无标题)'));
  out.push('- URL：' + (url || ''));
  out.push('- 导出时间：' + (exportedAt || ''));
  if (handoffId) {
    // 不写具体工具名：它随集成而变（opencode 侧是 recallflow_session，DSH 侧是
    // recallflow_browser 的 handoff_get），写死哪一个都会让另一侧的读者以为自己看错了。
    out.push('- 会话标识：' + handoffId + '（若你具备 RecallFlow 会话读取能力，可用该标识取回更完整的上下文）');
  }
  out.push('');

  const list: TranscriptMessage[] = Array.isArray(conversation) ? conversation : [];
  if (!list.length) {
    out.push('（暂无对话）');
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  for (const m of list) {
    if (!m) continue;

    if (m.role === 'user') {
      out.push('## 用户');
      out.push('');
      out.push(String(m.content || ''));
      out.push('');
      continue;
    }

    out.push('## RecallFlow');
    out.push('');
    // 刷新后对话是从 chrome.storage.session 恢复的，而它有步数上限 ——
    // **必须在这里说明少了多少步**：否则记录看起来就像"当时只做了这些"，
    // 接手的人会把已经试过的路再试一遍（这正是我们放宽上限要解决的问题）。
    if (Number(m.partsOmitted) > 0) {
      out.push(
        '> ⚠ 更早的 **' + m.partsOmitted + ' 步**（该轮共 ' + (Number(m.partsTotal) || '?') +
          ' 步）因**会话存储上限**未保留，刷新后无法恢复 —— 下面的工具明细不是完整的。'
      );
      out.push('');
    }
    if (m.contentTruncated === true) {
      out.push('> ⚠ 本轮正文超过存储上限，已截断；完整原文只存在于当次页面会话中。');
      out.push('');
    }
    const parts = dedupeAdjacentTextParts(Array.isArray(m.parts) ? m.parts : []);
    // 工具结果先建索引：它总是跟在对应的 tool-call 之后，按下标顺序渲染时
    // 就能把两者合成一行，而不是多出一行「返回结果」。
    const results = new Map<unknown, TranscriptPart>();
    const callIds = new Set<unknown>();
    for (const p of parts) {
      if (!p) continue;
      if (p.type === 'tool-call') {
        if (p.callId) callIds.add(p.callId);
      } else if (p.type === 'tool-result' && p.callId && !results.has(p.callId)) {
        results.set(p.callId, p);
      }
    }

    let lastText = '';
    let lastToolText = '';
    // 去重的前提是「那段文字已经**完整**出现在上面」。工具行会按 maxResultLen 截断，
    // 所以拿工具结果做去重依据前必须确认它没被截断 —— 否则一段超过 maxResultLen 的
    // 最终答复会被叙述与结论两处同时挡掉，而工具行只剩前 maxResultLen 字：
    // 尾部整段丢失，且记录里完全看不出丢了东西。
    const fullyInline = (s: string) => Boolean(s) && s.length <= maxResultLen;
    // 工具行必须攒成**一个连续列表块**，块后再补一个空行。
    // 少了这个空行，紧跟其后的叙述会被 markdown 当成上一条列表项的延续
    // （lazy continuation），整段话被渲染进项目符号里 —— 这是实测踩到的。
    let pending: string[] = [];
    const flushTools = () => {
      if (!pending.length) return;
      out.push(...pending);
      out.push('');
      pending = [];
    };

    for (const p of parts) {
      if (!p) continue;
      // 叙述与工具**按原顺序**输出：这是本模块存在的理由，别改成分组
      if ((p.type === 'narration' || p.type === 'text') && p.text) {
        const t = String(p.text).trim();
        if (!t) continue;
        flushTools();
        // 面板在任务完成时会把这句作为叙述推给界面，而它的文本**就是**
        // complete_task 的返回结果 —— 同一段话会连着出现两次。这里按「与紧邻的
        // 工具结果逐字相同」精确去重，并要求工具行确实完整放下了它
        // （见 fullyInline：被截断时不能去重，否则那段文字就哪儿都没有了）。
        if (lastToolText && fullyInline(lastToolText) && norm(t) === lastToolText) continue;
        // 模型常自己在末尾写一份「参考来源」，导出器还会按 citations 追加一份 —— 去掉模型那份
        out.push(stripTrailingSources(t));
        out.push('');
        lastText = t;
        continue;
      }
      if (p.type === 'tool-call') {
        const r = results.get(p.callId);
        pending.push(toolLine(p, r, maxResultLen));
        if (r) lastToolText = norm(r.result);
        else lastToolText = '';
        continue;
      }
      if (p.type === 'tool-result') {
        // 没有配对 tool-call 的孤儿结果（理论上不该出现）：照样记录下来，别静默丢
        if (!p.callId || !callIds.has(p.callId)) {
          pending.push(toolLine({ name: p.name, args: {} }, p, maxResultLen));
          lastToolText = norm(p.result);
        }
        continue;
      }
      if (p.type === 'screenshot') {
        // 上一版完全忽略了截图，导致记录里少一步且步数对不上
        pending.push(screenshotLine(p));
        continue;
      }
    }
    flushTools();
    out.push('');

    // 结论：最终文本已经在上面**完整**出现过时不再重复。
    // 两个来源都要判：最后一段叙述（叙述从不截断），或最后一个工具结果 ——
    // 后者是 complete_task 的常见情形，但仅当工具行完整放下了它才算数。
    const content = String(m.content || '').trim();
    const contentKey = citationNeutralTextKey(content);
    const alreadyShownFull =
      Boolean(content) &&
      (contentKey === citationNeutralTextKey(lastText) ||
        (fullyInline(lastToolText) && contentKey === citationNeutralTextKey(lastToolText)));
    if (content && !alreadyShownFull) {
      // 进行中/失败/中断的一轮都不叫「结论」：前者尚未结束，后两者根本没有结论。
      // 这个区分对读记录的人（或外部 AI）很关键 —— 「这段是最终答案还是被打断了」。
      out.push(m.failed ? '### 失败' : m.partial ? '### 进行中' : m.interrupted ? '### 中断' : '### 结论');
      out.push('');
      out.push(stripTrailingSources(content));
      out.push('');
    }
    if (Array.isArray(m.citations) && m.citations.length) {
      out.push('### 参考来源');
      out.push('');
      for (const c of m.citations) {
        out.push('- [' + c.index + '] ' + (c.title || '') + (c.url ? ' — ' + c.url : ''));
      }
      out.push('');
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

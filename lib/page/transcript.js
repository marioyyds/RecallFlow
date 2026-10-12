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

/** 进行中轮次的说明标记。放进 content 而不是另设字段 —— 交接包的 trimMessages 只保留 {role, content}。 */
export const PARTIAL_TURN_NOTE = '（本段在导出时尚未结束：任务仍在进行中，以下是已发生的部分）';

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
export function buildPartialTurn(parts, liveText) {
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
export function buildFailedTurn(parts, errorText) {
  const list = (Array.isArray(parts) ? parts : []).slice();
  const text = String(errorText === undefined || errorText === null ? '' : errorText).trim() || '任务失败（未提供错误信息）';
  return { role: 'assistant', content: text, parts: list, failed: true };
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
export function stripTrailingSources(text) {
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
export function alreadyCommittedAsText(parts, text) {
  const want = norm(text);
  if (!want) return false;
  const list = Array.isArray(parts) ? parts : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (!p) continue;
    if (p.type === 'tool-call' || p.type === 'tool-result' || p.type === 'screenshot') continue;
    if (p.type !== 'narration' && p.type !== 'text') continue;
    return norm(p.text) === want;
  }
  return false;
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
function clipPart(p) {
  const out = Object.assign({}, p);
  if (typeof out.result === 'string' && out.result.length > MAX_PART_RESULT_CHARS) {
    out.result = out.result.slice(0, MAX_PART_RESULT_CHARS);
    out.resultTruncated = true;
  }
  if (typeof out.text === 'string' && out.text.length > MAX_PART_TEXT_CHARS) {
    out.text = out.text.slice(0, MAX_PART_TEXT_CHARS);
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
      out.args[OMIT_ARGS_KEY] = '参数过长（' + s.length + ' 字符），已省略（原文未留存，取不回）';
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
export function serializeConversationMessages(conversation) {
  const all = Array.isArray(conversation) ? conversation : [];
  const kept = all.slice(-MAX_MESSAGES);
  return kept.map((m, i) => {
    const copy = { role: m.role };
    // 只在**第一条**留痕：它表示"这条之前还有 N 条没被导出"（取不回）
    if (i === 0 && all.length > kept.length) {
      copy.earlierMessagesOmitted = all.length - kept.length;
      copy.messagesTotal = all.length;
    }
    if (typeof m.content === 'string') {
      copy.content = m.content.slice(0, MAX_MESSAGE_CONTENT_CHARS);
      if (m.content.length > MAX_MESSAGE_CONTENT_CHARS) copy.contentTruncated = true;
    }
    if (typeof m.toolSummary === 'string' && m.toolSummary) {
      copy.toolSummary = m.toolSummary.slice(0, MAX_TOOL_SUMMARY_CHARS);
      if (m.toolSummary.length > MAX_TOOL_SUMMARY_CHARS) copy.toolSummaryTruncated = true;
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
      copy.citations = keptCites.map((c) => {
        const snippet = String(c.snippet || '');
        const out = {
          index: c.index, source: c.source, id: c.id, title: c.title, url: c.url,
          snippet: snippet.slice(0, MAX_CITATION_SNIPPET_CHARS),
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

function clipInline(text, max) {
  const t = norm(text);
  if (!t) return '';
  return t.length > max ? t.slice(0, max) + '…（共 ' + t.length + ' 字符，已截断）' : t;
}

/** 空白归一：只用于**比较**与散文压缩，绝不用于 JSON 参数（会破坏原文）。 */
function norm(text) {
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
export function formatOmittedItems(n) {
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
export function previewArgsJson(args, maxLen = 240) {
  const shorten = (v, depth) => {
    if (typeof v === 'string') return v.length > 80 ? v.slice(0, 80) + '…' : v;
    if (Array.isArray(v)) {
      const cap = 3;
      const head = v.slice(0, cap).map((x) => shorten(x, depth + 1));
      if (v.length > cap) head.push(formatOmittedItems(v.length));
      return head;
    }
    if (v && typeof v === 'object') {
      if (depth >= 3) return '…';
      const o = {};
      for (const k of Object.keys(v)) o[k] = shorten(v[k], depth + 1);
      return o;
    }
    return v;
  };
  try {
    const json = JSON.stringify(shorten(args || {}, 0));
    if (json && json.length <= maxLen) return json;
    const keys = Object.keys(args || {});
    if (!keys.length) return '{}';
    // 同 clipPart：退化成"说明"时，键名必须是可辨的元信息形态（不能是 `'…'`）。
    const out = {};
    out[OMIT_ARGS_KEY] = '参数过长，字段：' + keys.slice(0, 8).join(', ') + '（其余未列出）';
    return JSON.stringify(out);
  } catch (e) {
    // 循环引用等异常输入：宁可少给信息，也不要让导出整个失败
    return '{…}';
  }
}

function toolLine(p, result, maxResultLen) {
  const mark = !result ? '…' : result.status === 'completed' ? '✓' : result.status === 'failed' ? '✗' : '—';
  const args = previewArgsJson(p.args);
  const detail = clipInline(result ? result.result : '', maxResultLen);
  return '- `' + p.name + '` ' + args + ' → ' + mark + (detail ? ' ' + detail : '');
}

function screenshotLine(p) {
  const bits = [];
  if (p.label) bits.push(String(p.label));
  if (p.width && p.height) bits.push(p.width + '×' + p.height);
  if (p.bytes) bits.push(Math.round(Number(p.bytes) / 1024) + 'KB');
  return '- （截图' + (bits.length ? '：' + bits.join(' · ') : '') + '）';
}

/**
 * @param {object} input
 * @param {string} input.title 页面标题
 * @param {string} input.url 页面 URL
 * @param {string} input.exportedAt 导出时间（已格式化）
 * @param {string} [input.handoffId] 会话标识，形如 RF-XXXXXX
 * @param {Array} input.conversation 对话数据模型
 * @param {number} [input.maxResultLen] 单条工具结果的截断长度
 * @returns {string} markdown
 */
export function buildTranscript(input = {}) {
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

  const list = Array.isArray(conversation) ? conversation : [];
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
    const parts = Array.isArray(m.parts) ? m.parts : [];
    // 工具结果先建索引：它总是跟在对应的 tool-call 之后，按下标顺序渲染时
    // 就能把两者合成一行，而不是多出一行「返回结果」。
    const results = new Map();
    const callIds = new Set();
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
    const fullyInline = (s) => Boolean(s) && s.length <= maxResultLen;
    // 工具行必须攒成**一个连续列表块**，块后再补一个空行。
    // 少了这个空行，紧跟其后的叙述会被 markdown 当成上一条列表项的延续
    // （lazy continuation），整段话被渲染进项目符号里 —— 这是实测踩到的。
    let pending = [];
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
    const alreadyShownFull =
      Boolean(content) && (content === lastText || (fullyInline(lastToolText) && norm(content) === lastToolText));
    if (content && !alreadyShownFull) {
      // 进行中/失败的一轮不叫「结论」：前者尚未结束，后者根本没有结论。
      // 这个区分对读记录的人（或外部 AI）很关键 —— 「这段是最终答案还是被打断了」。
      out.push(m.failed ? '### 失败' : m.partial ? '### 进行中' : '### 结论');
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

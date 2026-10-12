// 「交接包」（handoff）：把 RecallFlow 面板里的一次会话上下文打包成一个可复制的标识，
// 让外部编码 agent（opencode / DSH 等）凭标识经 MCP 取回完整上下文，接手解决前端问题。
//
// 为什么不是只给一段聊天记录：只有对话不足以定位前端问题。交接包必须**自包含**——
// 页面、对话、拾取元素、以及「复制那一刻」的控制台错误快照（之后再查可能已消失）。
//
// 本模块为纯函数（无 chrome / window 依赖）：内容脚本、后台 relay、node 单测三处共用。

// 标识前缀与字母表：刻意剔除易混字符 0/O/1/I/L，便于人工念读与抄写。
const ID_PREFIX = 'RF-';
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const ID_LENGTH = 6;
const ID_RE = /^RF-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

// 体积上限：交接包会经 chrome.storage 与 MCP 传输，必须封顶。
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 4000;
const MAX_PICKED = 10;
const MAX_CONSOLE = 30;
const MAX_STACK_CHARS = 1500;
const MAX_TEXT_CHARS = 300;
// 工具轨迹：外部 agent 接手时最需要知道「前一个 AI 已经查过什么」，
// 否则只能把同样的选择器再试一遍。只留最近若干步的「调用 → 一行结果」。
//
// ⚠ 24/300 对**复杂会话**明显不够：实测一次"检索动画"的会话有 **约 60 次工具调用**，
// 于是记录里只剩最近 24 步、每步结果 300 字符，接手方**看不到前面的探索**，
// 也就无法判断"哪些路已经试过了" —— 而这正是交接包存在的理由。
// 已放宽到 60/600。**字节预算仍是最终防线**（见 fitRecordToBudget 的逐级降级），
// 所以放宽基础上限不会撑爆存储；真正的取舍是"给接手方多少上下文"。
export const MAX_TOOL_TRAIL = 60;
const MAX_TRAIL_ARGS_CHARS = 200;
export const MAX_TRAIL_RESULT_CHARS = 600;
// 单条记录的字节预算。chrome.storage.local 默认约 10MB，而 30 条记录共享它；
// 仅靠「条数上限」挡不住单条超长（最坏 20×4000 字符），因此再加一道按字节的闸。
export const MAX_RECORD_BYTES = 160000;

/** 生成一个新的会话标识，形如 `RF-7K2M9X`。 */
export function newHandoffId() {
  let out = '';
  const len = ID_ALPHABET.length;
  try {
    const buf = new Uint8Array(ID_LENGTH);
    crypto.getRandomValues(buf);
    for (let i = 0; i < ID_LENGTH; i++) out += ID_ALPHABET[buf[i] % len];
  } catch (e) {
    for (let i = 0; i < ID_LENGTH; i++) out += ID_ALPHABET[Math.floor(Math.random() * len)];
  }
  return ID_PREFIX + out;
}

/**
 * 归一化用户/AI 给出的标识：去空白、转大写、接受省略前缀或含空格的写法。
 * 无法识别时返回空串（调用方据此报「标识无效」）。
 */
export function normalizeHandoffId(raw) {
  // 先剥掉所有空白与连字符：人工抄写/粘贴常见的变体都要能识别
  // （小写、省略前缀、空格代替连字符、分隔位置随意）。
  let s = String(raw === undefined || raw === null ? '' : raw)
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
  if (!s) return '';
  if (s.startsWith('RF')) s = s.slice(2);
  if (!/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(s)) return '';
  const out = ID_PREFIX + s;
  return ID_RE.test(out) ? out : '';
}

export function isHandoffId(raw) {
  return normalizeHandoffId(raw) !== '';
}

function clampText(v, max) {
  const s = String(v === undefined || v === null ? '' : v);
  return s.length > max ? s.slice(0, max) + '…（已截断）' : s;
}

/** 裁剪对话：只保留最近 limit 条，且逐条按字符数封顶，避免交接包无限膨胀。 */
export function trimMessages(messages, limit = MAX_MESSAGES, maxChars = MAX_MESSAGE_CHARS) {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .filter((m) => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant'))
    .slice(-limit)
    .map((m) => ({ role: m.role, content: clampText(m.content, maxChars) }));
}

function trimConsole(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list
    .filter((e) => e && (e.level === 'error' || e.level === 'warn'))
    .slice(-MAX_CONSOLE)
    .map((e) => ({
      level: String(e.level || ''),
      text: clampText(e.text, 1000),
      stack: clampText(e.stack, MAX_STACK_CHARS),
      at: Number(e.at) || 0,
    }));
}

function trimPicked(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.slice(0, MAX_PICKED).map((p) => {
    const src = (p && p.source) || {};
    return {
      selector: clampText(p && p.selector, 300),
      tag: clampText(p && p.tag, 40),
      text: clampText(p && p.text, MAX_TEXT_CHARS),
      locator: p && p.locator ? p.locator : undefined,
      source: src.file
        ? { file: clampText(src.file, 400), line: src.line, column: src.column, framework: src.framework, component: src.component }
        : undefined,
      inShadow: Boolean(p && p.inShadow),
    };
  });
}

/**
 * 从面板对话里提取「工具轨迹」：把 tool-call 与 tool-result 按 callId 配对成一行。
 * 必须在 trimMessages 之前提取 —— 后者只保留 {role, content}，会把 parts 丢掉，
 * 而那正是「前一个 AI 查过什么」的唯一来源。
 * @param {Array} messages 面板对话（含 assistant.parts）
 */
/**
 * 从消息里提取**全量步数**的工具轨迹（调用 → 一行结果）。
 *
 * ⚠ **"全量"只指步数，不指单步文本** —— 每一步的 `args` / `result` 仍会被裁到
 * `MAX_TRAIL_ARGS_CHARS`(200) / `MAX_TRAIL_RESULT_CHARS`(600)。**被裁的步会打上标记**
 * （`textClamped: true` + `argsChars` / `resultChars` 原始长度），
 * 并由 `countClampedSteps()` / `prepareHandoffTrail().textClamped` 汇总成**显式事实** ✓
 *
 * 为什么必须标记：这段注释上一版写的是"**完整的**…不做截断"，而实现一直在裁单步文本 ✗
 * ⇒ 接手方（下一个会话 / MCP 侧）会以为拿到的是完整原文，**看不到"这里被裁了"**。
 * 本仓库的硬纪律：**丢东西必须说明**（同 `trailOmitted`、快照的 `omittedBySize`）✓
 *
 * 与 `deriveToolTrail` 的分工：那个返回"交付用的最近 N 步"，这个返回全量步数。
 */
export function buildToolTrail(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (const m of list) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.parts)) continue;
    const results = new Map();
    for (const p of m.parts) {
      if (p && p.type === 'tool-result' && p.callId) results.set(p.callId, p);
    }
    for (const p of m.parts) {
      if (!p || p.type !== 'tool-call' || !p.name) continue;
      const r = results.get(p.callId);
      let rawArgs = '';
      try {
        rawArgs = JSON.stringify(p.args || {});
      } catch (e) {
        rawArgs = '';
      }
      const rawResult = r ? String(r.result === undefined || r.result === null ? '' : r.result) : '';
      const args = clampText(rawArgs, MAX_TRAIL_ARGS_CHARS);
      const result = clampText(rawResult, MAX_TRAIL_RESULT_CHARS);
      const item = {
        name: String(p.name),
        args,
        status: r ? String(r.status || '') : 'unknown',
        result,
      };
      // ★ 被裁就**留下痕迹**：接手方据此知道"这不是完整原文"，以及原本有多长
      if (args !== rawArgs || result !== rawResult) {
        item.textClamped = true;
        item.argsChars = rawArgs.length;
        item.resultChars = rawResult.length;
      }
      out.push(item);
    }
  }
  return out;
}

/**
 * 统计轨迹里**单步文本被裁**的步数（纯函数）。
 *
 * 与 `trailOmitted`（丢的是**整步**）是两个不同的量，**都要报**：
 * 只报"丢了几步"而不报"多少步的文本被裁"，接手方就会以为剩下的都是完整原文 ✗
 */
export function countClampedSteps(trail) {
  return (Array.isArray(trail) ? trail : []).filter((t) => t && t.textClamped === true).length;
}

/** 交付用的轨迹：只留最近 `limit` 步。 */
export function deriveToolTrail(messages, limit = MAX_TOOL_TRAIL) {
  return buildToolTrail(messages).slice(-limit);
}

// 全量轨迹有**自己的存储与预算**（单独的 storage key），不参与记录的 160KB 预算。
//
// 为什么必须分开：一次复杂会话的完整轨迹本身就能到 100KB+（实测 60 步已约 48KB，
// 极端情况几百步）。塞进记录会把**对话**与**拾取元素**一起挤掉，而这三样价值不同：
//   轨迹 → "别重复试过的路"；对话 → "用户到底要什么"；元素 → "该操作哪个节点"。
// 分开之后，"存全量"才真的成立：摘要照旧小，完整轨迹按需分段取。
export const MAX_TRAIL_FULL = 200;
export const MAX_FULL_TRAIL_BYTES = 400000;

/**
 * 把**原始全量**轨迹整理成三份东西，供记录与独立存储分别取用。
 *
 * 为什么要一个函数同时算出三者：它们必须**互相自洽**。
 * 若"记录里写省略了几步"和"独立 key 里到底存了几步"各算一遍，
 * 迟早会出现"记录说少了 10 步、实际能取回全部"或反过来的漂移 ✗
 *
 * @returns {{items: Array, total: number, omitted: number, textClamped: number, summary: Array}}
 *   items       存进独立 key 的**可检索**轨迹
 *   total       会话真实步数
 *   omitted     **真正丢失**的步数（超出全量预算，取不回来）
 *   textClamped **单步文本被裁**的步数（步还在、但 args/result 不是完整原文）—— 必须与 omitted 一起报，
 *               否则接手方会以为"没被 omitted 的步 = 完整原文" ✗（本仓库硬纪律：丢东西必须说明）
 *   summary     记录里随包交付的摘要（最近 MAX_TOOL_TRAIL 步）
 */
export function prepareHandoffTrail(rawTrail) {
  const full = Array.isArray(rawTrail) ? rawTrail : [];
  const fitted = fitFullTrailToBudget(full);
  return {
    items: fitted.items,
    total: full.length,
    omitted: fitted.omitted,
    textClamped: countClampedSteps(fitted.items),
    summary: fitted.items.slice(-MAX_TOOL_TRAIL),
  };
}
/**
 * 按字节预算裁**全量**轨迹：从**最旧**的一端裁，返回保留项与被丢弃的步数。
 *
 * 用折半收缩而不是"每步试一次"：逐步 slice 会做 O(n) 次整体序列化，
 * 几百步的记录上那是几百次 JSON.stringify —— 保存是用户点一下就要发生的事。
 */
export function fitFullTrailToBudget(trail, maxBytes = MAX_FULL_TRAIL_BYTES) {
  const src = Array.isArray(trail) ? trail : [];
  let kept = src.slice(-MAX_TRAIL_FULL);
  while (kept.length > 0 && handoffByteSize(kept) > maxBytes) {
    kept = kept.slice(Math.ceil(kept.length / 2));
  }
  return { items: kept, omitted: src.length - kept.length };
}

/** JSON 序列化后的 UTF-8 字节数（chrome.storage 的配额按字节计）。 */
export function handoffByteSize(value) {
  let s = '';
  try {
    s = JSON.stringify(value);
  } catch (e) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (s === undefined) return 0;
  try {
    return new TextEncoder().encode(s).length;
  } catch (e) {
    return s.length * 2; // 退化估算（UTF-16）
  }
}

/**
 * 按字节预算收缩交接包。逐级降级并标记 truncated，保证单条记录不会撑爆存储配额。
 * 顺序刻意「先砍最不关键的」：控制台堆栈 → 工具轨迹 → 对话条数 → 兜底只留最后一轮。
 * @returns {{record: Object, truncated: string, bytes: number}}
 */
export function fitRecordToBudget(record, maxBytes = MAX_RECORD_BYTES) {
  let out = record && typeof record === 'object' ? record : {};
  let bytes = handoffByteSize(out);
  if (bytes <= maxBytes) return { record: out, truncated: '', bytes };

  const attempt = (next, label) => {
    out = Object.assign({}, out, next, { truncated: label });
    bytes = handoffByteSize(out);
    return bytes <= maxBytes;
  };

  // 1) 去掉控制台堆栈（正文与 level 仍保留，定位问题通常够用）
  if (attempt({ consoleErrors: (out.consoleErrors || []).map((e) => Object.assign({}, e, { stack: '' })) }, 'console-stack')) {
    return { record: out, truncated: out.truncated, bytes };
  }
  // 2) 工具轨迹只留最近 10 步并压缩单步长度
  //
  // ⚠ 这里**不动** `trailOmitted`：摘要被砍 ≠ 数据丢失。
  // 完整轨迹存在独立的 key 里（见 prepareHandoffTrail 与 handoff-store），
  // 接手方看 `trailStored > toolTrail.length` 就知道"还有，去取"。
  // （上一版曾在这里把砍掉的步数计进 trailOmitted —— 那是当时"没有独立存储"下的正确做法；
  //   存储拆开之后它反而会谎报丢数据，故撤掉。）
  if (
    attempt(
      {
        toolTrail: (out.toolTrail || []).slice(-10).map((t) =>
          Object.assign({}, t, { args: String(t.args || '').slice(0, 80), result: String(t.result || '').slice(0, 120) })
        ),
      },
      'tool-trail'
    )
  ) {
    return { record: out, truncated: out.truncated, bytes };
  }
  // 3) 对话只留最近 6 条、单条 1200 字符
  if (
    attempt(
      { messages: (out.messages || []).slice(-6).map((m) => Object.assign({}, m, { content: String(m.content || '').slice(0, 1200) })) },
      'messages'
    )
  ) {
    return { record: out, truncated: out.truncated, bytes };
  }
  // 4) 兜底：只留最后一轮 + 少量拾取元素（同样不动 trailOmitted，理由见第 2 档）
  attempt(
    {
      messages: (out.messages || []).slice(-2).map((m) => Object.assign({}, m, { content: String(m.content || '').slice(0, 600) })),
      consoleErrors: [],
      pickedElements: (out.pickedElements || []).slice(0, 3),
      toolTrail: (out.toolTrail || []).slice(-3),
    },
    'last-turn'
  );
  return { record: out, truncated: out.truncated, bytes };
}

/**
 * 构造交接包记录。
 * @param {Object} input
 * @param {string} input.id - 会话标识（应先 normalize）
 * @param {string} [input.pageUrl]
 * @param {string} [input.pageTitle]
 * @param {Array} [input.messages] - 面板对话
 * @param {Array} [input.pickedElements]
 * @param {string} [input.selection] - 当前选中文本
 * @param {string} [input.lastError] - 面板里最后一次错误（如「请求失败」）
 * @param {Array} [input.consoleEntries] - 复制那一刻的控制台快照
 * @param {string} [input.note]
 * @param {number} [input.now]
 */
export function buildHandoffRecord(input = {}) {
  const id = normalizeHandoffId(input.id);
  if (!id) throw new Error('交接包需要合法的会话标识');
  const now = Number(input.now) || Date.now();
  const messages = trimMessages(input.messages);
  const consoleErrors = trimConsole(input.consoleEntries);
  const picked = trimPicked(input.pickedElements);
  // 工具轨迹必须在 trimMessages 之前从原始 messages 提取（后者会丢掉 parts）。
  // 摘要 / 总数 / 真正丢失的步数由**同一处**算出，保证三者自洽（见 prepareHandoffTrail）。
  const rawTrail = Array.isArray(input.toolTrail) ? input.toolTrail : buildToolTrail(input.messages);
  const prepared = prepareHandoffTrail(rawTrail);
  const toolTrail = prepared.summary;
  return {
    id,
    version: 1,
    createdAt: Number(input.createdAt) || now,
    updatedAt: now,
    pageUrl: clampText(input.pageUrl, 1000),
    pageTitle: clampText(input.pageTitle, 300),
    selection: clampText(input.selection, 1000),
    lastError: clampText(input.lastError, 1000),
    messageCount: messages.length,
    messages,
    toolTrail,
    // 四个数的语义要分清（接手方据此判断"我拿到的是不是完整的、缺的能不能取回"）：
    //   trailTotal        会话真实步数
    //   trailStored       可通过分段读取取回的**步数**
    //   trailOmitted      **真正取不回**的步数（超出全量预算）
    //   trailTextClamped  取回得到、但**单步文本被裁**的步数（args/result 不是完整原文）
    //                     ⚠ 少了它，接手方会把"没被 omitted"理解成"完整原文" ✗
    trailTotal: prepared.total,
    trailStored: prepared.items.length,
    trailOmitted: prepared.omitted,
    trailTextClamped: prepared.textClamped,
    pickedElements: picked,
    consoleErrors,
    note: clampText(input.note, 500),
  };
}

/**
 * 维护「最近标识」索引：新 id 置顶、去重、按上限截断。
 * 返回 { index, dropped } —— dropped 是需要连带删除存储的旧 id。
 */
export function updateHandoffIndex(index, id, now, keep = 30) {
  const list = Array.isArray(index) ? index : [];
  const at = Number(now) || Date.now();
  const rest = list.filter((e) => e && e.id && e.id !== id);
  // 先按时间倒序（最近在前）再截断：语义是「保留最近的 keep 个」。
  // 若只按数组位置盲截，一旦调用方传入的顺序不可靠（如旧在前），淘汰的就会是最近的那条。
  // sort 在现代 JS 中是稳定的，因此 at 相同的条目仍保持原有相对顺序。
  const merged = [{ id, at }].concat(rest).sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  const next = merged.slice(0, keep);
  const kept = new Set(next.map((e) => e.id));
  const dropped = list.filter((e) => e && e.id && !kept.has(e.id)).map((e) => e.id);
  return { index: next, dropped };
}

/**
 * 给剪贴板用的交接指令：带标识与页面，便于对方识别并取回会话。
 *
 * **刻意不写具体的工具名**。原先是「请调用 recallflow_session("RF-…") 取回该会话上下文」，
 * 那个名字只存在于 opencode 侧 MCP；DSH 侧的工具叫 recallflow_browser（method=handoff_get），
 * 而其它 AI 两个都没有。于是这段文本被粘到不具备该工具的 AI 那里时是**静默失效**的：
 * 对方无法执行，用户也不知道为什么没反应（实测粘给 DSH 就是如此）。
 *
 * 现在改为：说明「有会话读取工具就先取回」，并**给出没有能力时的退路**
 * （让用户改用面板的「导出记录」粘贴原文）—— 无论对方是哪种集成，指令都不会落空。
 */
export function formatHandoffPrompt(id, opts = {}) {
  const norm = normalizeHandoffId(id);
  if (!norm) return '';
  const title = String((opts && opts.pageTitle) || '').trim();
  const where = title ? '（页面：' + title.slice(0, 80) + '）' : '';
  return (
    '读取 RecallFlow 会话 ' +
    norm +
    where +
    '，然后帮我解决其中的前端问题。\n' +
    '若你有 RecallFlow 的会话读取工具，请先取回该会话上下文再动手；' +
    '若没有这个能力，请直接说明，我会改用面板的「导出记录」把内容粘贴给你。'
  );
}

export { ID_PREFIX, MAX_MESSAGES, MAX_CONSOLE, MAX_PICKED, MAX_MESSAGE_CHARS };
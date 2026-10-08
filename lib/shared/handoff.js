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
const MAX_TOOL_TRAIL = 24;
const MAX_TRAIL_ARGS_CHARS = 200;
const MAX_TRAIL_RESULT_CHARS = 300;
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
export function deriveToolTrail(messages) {
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
      let args = '';
      try {
        args = JSON.stringify(p.args || {});
      } catch (e) {
        args = '';
      }
      out.push({
        name: String(p.name),
        args: clampText(args, MAX_TRAIL_ARGS_CHARS),
        status: r ? String(r.status || '') : 'unknown',
        result: clampText(r ? r.result : '', MAX_TRAIL_RESULT_CHARS),
      });
    }
  }
  return out.slice(-MAX_TOOL_TRAIL);
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
  // 4) 兜底：只留最后一轮 + 少量拾取元素
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
  const toolTrail = Array.isArray(input.toolTrail) ? input.toolTrail.slice(-MAX_TOOL_TRAIL) : deriveToolTrail(input.messages);
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
 * 给剪贴板用的交接指令：带标识与页面。
 *
 * **不许让 AI 去调用不存在的东西**（2026-10-08 收口时改）。
 * 这里原来写"请调用 `recallflow_session("…")` 取回该会话上下文" ——
 * 那个方法在 `recallflow_browser` 的方法表里**不存在**，而 `RF-xxxxxx` 是面板本地登记号。
 * 后果：用户把这段贴给任何 AI，对方都会去找一个不存在的工具，然后卡住或瞎猜。
 * 交接包的价值在**正文**（对话 + 页面信息 + 拾取的元素 + 控制台快照），
 * 所以指令只说正文这一件事。
 */
export function formatHandoffPrompt(id, opts = {}) {
  const norm = normalizeHandoffId(id);
  if (!norm) return '';
  const title = String((opts && opts.pageTitle) || '').trim();
  const where = title ? '（页面：' + title.slice(0, 80) + '）' : '';
  return (
    '这是 RecallFlow 从浏览器导出的一段会话记录 ' +
    norm +
    where +
    '，完整上下文就在下面的正文里：请据此帮我解决其中的前端问题。'
  );
}

export { ID_PREFIX, MAX_MESSAGES, MAX_CONSOLE, MAX_PICKED, MAX_MESSAGE_CHARS };

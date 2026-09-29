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

/** 给剪贴板用的交接指令：带标识与页面，便于 agent 识别并自动调用 MCP 工具。 */
export function formatHandoffPrompt(id, opts = {}) {
  const norm = normalizeHandoffId(id);
  if (!norm) return '';
  const title = String((opts && opts.pageTitle) || '').trim();
  const where = title ? '（页面：' + title.slice(0, 80) + '）' : '';
  return (
    '读取 RecallFlow 会话 ' +
    norm +
    where +
    '：请调用 recallflow_session("' +
    norm +
    '") 取回该会话上下文，然后帮我解决其中的前端问题。'
  );
}

export { ID_PREFIX, MAX_MESSAGES, MAX_CONSOLE, MAX_PICKED, MAX_MESSAGE_CHARS };

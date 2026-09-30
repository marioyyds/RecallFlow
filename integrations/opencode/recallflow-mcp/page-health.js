// page_health 核心：把「页面运行时诊断」变成 agent 可增量消费的信号。
//
// 设计要点：
// 1. **不解析文本**：数据来自扩展的结构化 console/network 条目（含 at 时间戳与 stack），
//    避免重蹈「字符串耦合」——扩展改文案就会静默失效。
// 2. **游标而非时间戳单点**：同一毫秒可能产生多条记录（React 渲染循环很常见），
//    纯时间戳会漏或重。游标编码为 "<at>.<同毫秒内已见条数>"，可精确续读。
// 3. **去重计数**：同一个错误在每次渲染重复抛出，按「级别 + 文案 + 首个项目内帧」聚合，
//    返回 count —— agent 看一条就够了，不必被 27 条同类刷屏。
// 4. **只认项目自身代码**：Vite 会为依赖生成 /node_modules/.vite/deps/... 帧，
//    对「我的代码哪里错了」没有帮助，优先选非 node_modules 的帧。
// 5. 纯函数、无副作用，便于单测。

import { toDiskPath, rewriteSourceUrls } from '../../../lib/shared/dev-paths.js';

const DEFAULT_LEVELS = ['error', 'warn'];
const STACK_HINT_LINES = 3;
const STACK_HINT_MAX = 400;

/** 游标：`<at>.<同毫秒内已见条数>`；无记录时返回空串。 */
export function cursorFromEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return '';
  const last = list[list.length - 1];
  const at = Number(last && last.at) || 0;
  let n = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if ((Number(list[i] && list[i].at) || 0) === at) n += 1;
    else break;
  }
  return at + '.' + n;
}

/** 解析游标；非法输入返回 null（调用方按「从头读」处理）。 */
export function parseCursor(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s || s === 'all') return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  return { at: Number(m[1]), n: m[2] === undefined ? 0 : Number(m[2]) };
}

/**
 * 只保留游标之后的条目。
 * 对 at === cursor.at 的同毫秒组：跳过已见的前 n 条，其余视为新增。
 */
export function filterSinceCursor(entries, cursor) {
  const list = Array.isArray(entries) ? entries : [];
  if (!cursor) return list.slice();
  const out = [];
  let sameGroupSeen = 0;
  for (const e of list) {
    const at = Number(e && e.at) || 0;
    if (at > cursor.at) out.push(e);
    else if (at === cursor.at) {
      sameGroupSeen += 1;
      if (sameGroupSeen > cursor.n) out.push(e);
    }
  }
  return out;
}

/** 按时间起点过滤（epoch 毫秒或 ISO 串）；无法解析时不过滤。 */
export function filterSinceTime(entries, since) {
  const list = Array.isArray(entries) ? entries : [];
  const ms = toMs(since);
  if (!ms) return list.slice();
  return list.filter((e) => (Number(e && e.at) || 0) >= ms);
}

function toMs(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  // 纯数字串一律按 epoch 毫秒处理（含 0）。
  // 注意：绝不能落到 Date.parse('0') —— 它会被解析成公元 2000 年，
  // 从而把「不过滤」误变成「过滤掉几乎全部记录」。
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 0 ? n : 0;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 从调用栈中取出第一个「属于本项目」的源码位置。
 * 优先非 node_modules 帧；返回 { location, frame } 或 null。
 */
export function extractTopFrame(stack, ctx = {}) {
  const lines = String(stack || '').split('\n');
  const candidates = [];
  for (const line of lines) {
    const m = /https?:\/\/[^\s()'"，、]+/.exec(line);
    if (!m) continue;
    const disk = toDiskPath(m[0], ctx);
    if (!disk || disk === m[0]) continue;
    const fn = /at\s+([^\s(]+)\s*\(/.exec(line);
    candidates.push({ location: disk, frame: fn ? fn[1] : '' });
  }
  if (!candidates.length) return null;
  const own = candidates.find((c) => !/[\\/]node_modules[\\/]/.test(c.location));
  return own || candidates[0];
}

function stackHint(stack, ctx) {
  const text = rewriteSourceUrls(String(stack || ''), ctx);
  if (!text) return '';
  return text.split('\n').slice(0, STACK_HINT_LINES).join('\n').slice(0, STACK_HINT_MAX);
}

function normalizeLevels(levels) {
  const list = Array.isArray(levels) && levels.length ? levels : DEFAULT_LEVELS;
  return new Set(list.map((l) => String(l).toLowerCase()));
}

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(100, Math.floor(n));
}

/**
 * 汇总页面诊断。
 * @param {Object} input
 * @param {Array} input.consoleEntries - 扩展返回的原始 console 条目（{level,text,stack,at}）。
 * @param {Array} input.networkEntries - 扩展返回的原始网络条目（{url,method,status,ok,initiator,at}）。
 * @param {string} [input.cursor] - 上次返回的游标；空/`all` 表示从头读。
 * @param {string|number} [input.since] - 或按时间起点过滤。
 * @param {string[]} [input.levels] - 关注的级别，默认 ['error','warn']。
 * @param {number} [input.limit] - 每类返回上限，默认 20，最大 100。
 * @param {string} [input.projectRoot]
 * @param {string} [input.devUrl]
 */
export function summarizePageHealth(input = {}) {
  const {
    consoleEntries = [],
    networkEntries = [],
    cursor = '',
    since = '',
    levels,
    limit,
    projectRoot = '',
    devUrl = '',
  } = input;

  const ctx = { projectRoot, devUrl };
  const cur = parseCursor(cursor);
  const wanted = normalizeLevels(levels);
  const max = clampLimit(limit);

  // 先按游标/时间过滤（用未做级别过滤的集合推进游标，避免下次重复扫描）。
  const newConsoleAll = filterSinceTime(filterSinceCursor(consoleEntries, cur), since);
  const newNetworkAll = filterSinceTime(filterSinceCursor(networkEntries, cur), since);
  const nextCursor = cursorFromEntries(newConsoleAll.length ? newConsoleAll : newNetworkAll) || cursor;

  // ---- console 聚合 ----
  const groups = new Map();
  for (const e of newConsoleAll) {
    const level = String((e && e.level) || 'log').toLowerCase();
    if (!wanted.has(level)) continue;
    const message = String((e && e.text) || '');
    const frame = extractTopFrame(e && e.stack, ctx);
    const location = frame ? frame.location : '';
    const sig = level + '|' + message + '|' + location;
    let g = groups.get(sig);
    if (!g) {
      g = {
        level,
        message,
        location,
        frame: frame ? frame.frame : '',
        count: 0,
        firstAt: (e && e.at) || 0,
        lastAt: (e && e.at) || 0,
        stackHint: level === 'error' ? stackHint(e && e.stack, ctx) : '',
      };
      groups.set(sig, g);
    }
    g.count += 1;
    g.lastAt = (e && e.at) || g.lastAt;
  }

  const allGroups = Array.from(groups.values());
  const bySeverity = (a, b) => {
    if (a.level !== b.level) return a.level === 'error' ? -1 : 1;
    if (b.count !== a.count) return b.count - a.count;
    return b.lastAt - a.lastAt;
  };
  const errors = allGroups.filter((g) => g.level === 'error').sort(bySeverity).slice(0, max);
  const warnings = allGroups.filter((g) => g.level === 'warn').sort(bySeverity).slice(0, max);

  // ---- 失败请求聚合 ----
  const netGroups = new Map();
  for (const n of newNetworkAll) {
    const status = Number(n && n.status) || 0;
    // 失败形态有三种，必须都覆盖：
    //  1. fetch/XHR 拿到错误状态码（status >= 400）；
    //  2. XHR 连接失败（status=0、ok=false）；
    //  3. fetch 被 reject —— 此时条目只有 error，**没有 ok 也没有 status**
    //     （见 debug-hook.js 的 fetch 失败分支），漏掉它就会看不见「后端没起来」这类问题。
    const failed = (n && n.ok === false) || status >= 400 || Boolean(n && n.error);
    if (!failed) continue;
    const method = String((n && n.method) || 'GET');
    const url = String((n && n.url) || '');
    const frame = extractTopFrame(n && n.initiator, ctx);
    const sig = method + ' ' + url + ' ' + (status || 'ERR');
    let g = netGroups.get(sig);
    if (!g) {
      g = {
        method,
        url,
        status: status || 0,
        error: String((n && n.error) || ''),
        location: frame ? frame.location : '',
        count: 0,
        lastAt: (n && n.at) || 0,
      };
      netGroups.set(sig, g);
    }
    g.count += 1;
    g.lastAt = (n && n.at) || g.lastAt;
  }
  const failedRequests = Array.from(netGroups.values())
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, max);

  const totalErrorHits = errors.reduce((n, g) => n + g.count, 0);
  const totalWarnHits = warnings.reduce((n, g) => n + g.count, 0);
  let summary;
  if (errors.length || warnings.length || failedRequests.length) {
    const parts = [];
    if (errors.length) parts.push(errors.length + ' 类错误（共 ' + totalErrorHits + ' 次）');
    if (warnings.length) parts.push(warnings.length + ' 类警告（共 ' + totalWarnHits + ' 次）');
    if (failedRequests.length) parts.push(failedRequests.length + ' 类失败请求');
    summary = '自上次检查以来新增：' + parts.join('、') + '。';
  } else {
    summary = '自上次检查以来没有新的错误、警告或失败请求。';
  }

  return {
    cursorUsed: String(cursor || ''),
    cursor: nextCursor,
    summary,
    counts: {
      newConsole: newConsoleAll.length,
      newNetwork: newNetworkAll.length,
      errorGroups: errors.length,
      warningGroups: warnings.length,
      failedRequestGroups: failedRequests.length,
    },
    errors,
    warnings,
    failedRequests,
  };
}

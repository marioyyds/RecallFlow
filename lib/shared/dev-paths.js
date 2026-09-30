// 把「源码 URL」转换为磁盘路径，让编码 agent 能直接 read / edit。
//
// 背景：扩展侧 get_element_source / read_console 返回的是**开发服务器 URL**
// （如 http://localhost:5173/src/components/Button.tsx:42:7）—— 这是 Vite / webpack
// 在内存里服务的虚拟路径，不是磁盘路径，agent 无法直接使用。本模块用 dev-session 里的
// projectRoot + devUrl 把二者对齐。
//
// 设计原则（重要，勿改）：
// 1. 依据不足时**原样返回**，绝不猜测路径。
// 2. 通用 URL 重写（rewriteSourceUrls）必须同时满足「有 devUrl」+「同源」+「源码扩展名」，
//    否则会把 http://localhost:5173/api/cart 这类接口 URL 误改成磁盘路径 —— 那是假证据。
// 3. 纯函数、无副作用、只依赖 node 内置模块，便于单测（不需 chrome.*）。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 源码类扩展名：只有命中它们，才值得从 URL 反推磁盘路径。
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss|sass|less|styl|html?|json|mdx?|svg)$/i;

function stripQueryHash(s) {
  return String(s).split('#')[0].split('?')[0];
}

// Windows 盘符（C:\ / C:/）与 UNC（\\server\share）视为「已是磁盘绝对路径」。
// 注意：单独的 "/src/App.tsx" 不算 —— 那是开发服务器根相对路径，需拼 projectRoot。
function isAbsoluteFsPath(s) {
  return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s);
}

function toPosixSegments(p) {
  return String(p)
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.');
}

/**
 * 剥掉尾部的 ":行:列" 或 ":行"。
 * 必须足够保守：不能把 URL 的端口号当成行号。
 *   http://localhost:5173/src/A.tsx:42:7 → base=http://localhost:5173/src/A.tsx, loc=:42:7
 *   http://localhost:5173               → 端口不剥离（base 不以源码扩展名结尾）
 */
function peelLineColumn(s) {
  const two = /^(.*):(\d+):(\d+)$/.exec(s);
  if (two) return { base: two[1], loc: ':' + two[2] + ':' + two[3] };
  const one = /^(.*):(\d+)$/.exec(s);
  if (one && SOURCE_EXT_RE.test(stripQueryHash(one[1]))) {
    return { base: one[1], loc: ':' + one[2] };
  }
  return { base: s, loc: '' };
}

/**
 * 把 URL 风格路径拼到项目根上。
 * projectRoot 缺失时保留原样形态（不擅自去掉前导斜杠）。
 */
export function joinProjectPath(projectRoot, urlPath) {
  const raw = String(urlPath || '');
  const root = String(projectRoot || '').trim();
  if (isAbsoluteFsPath(raw)) return path.normalize(raw);
  const segs = toPosixSegments(raw);
  if (!segs.length) return '';
  if (!root) return raw.replace(/\\/g, '/');
  return path.join(root, ...segs);
}

/**
 * 把单个源码位置转换为磁盘路径；依据不足时原样返回。
 * 支持 http(s):// / file:// / webpack:// / 已是磁盘路径 / 根相对路径，可带 :行:列。
 * @param {string} raw - 原始源码位置。
 * @param {{projectRoot?: string, devUrl?: string}} ctx - 开发会话上下文。
 * @returns {string} 磁盘路径（含保留的行列后缀），或原值。
 */
export function toDiskPath(raw, ctx = {}) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^blob:|^data:/i.test(trimmed)) return '';

  const { base, loc } = peelLineColumn(trimmed);
  const projectRoot = ctx.projectRoot ? String(ctx.projectRoot) : '';

  // file:// 本身即绝对路径，直接归一化，不拼 projectRoot。
  if (/^file:\/\//i.test(base)) {
    try {
      return path.normalize(fileURLToPath(base)) + loc;
    } catch (e) {
      return trimmed;
    }
  }

  // http(s):// → 取 pathname（Vite 会加 ?t=… 缓存串，必须剥掉否则永不匹配）。
  if (/^https?:\/\//i.test(base)) {
    let pathname = '';
    try {
      pathname = decodeURIComponent(new URL(stripQueryHash(base)).pathname);
    } catch (e) {
      return trimmed;
    }
    const disk = joinProjectPath(projectRoot, pathname);
    return disk ? disk + loc : trimmed;
  }

  // webpack:// → 去掉 scheme 与可选 host，再按相对路径处理。
  if (/^webpack:\/\//i.test(base)) {
    const rel = stripQueryHash(base).replace(/^webpack:\/\/(?:[^/]*)\/?/i, '');
    const disk = joinProjectPath(projectRoot, rel);
    return disk ? disk + loc : trimmed;
  }

  // 其他 scheme（chrome-extension: 等）不处理，避免误判。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) return trimmed;

  // 已是磁盘路径，或开发服务器根相对路径（/src/App.tsx）。
  const disk = joinProjectPath(projectRoot, stripQueryHash(base));
  return disk ? disk + loc : trimmed;
}

/**
 * 结构化归一化元素源码位置（get_element_source 返回的 source 对象）。
 * 与「解析格式化文本」的做法不同：这里只按字段处理，不依赖任何展示文案，
 * 因此扩展侧改措辞不会导致归一化静默失效。
 * 无 projectRoot、或已经是磁盘绝对路径时原样返回副本（不猜测）。
 * @param {{file?:string,line?:number,column?:number,framework?:string,component?:string}} source
 * @param {{projectRoot?:string}} ctx
 * @returns {Object|null} 归一化后的副本；入参非法时返回 null
 */
export function normalizeElementSource(source, ctx = {}) {
  if (!source || typeof source !== 'object') return null;
  const file = source.file;
  if (typeof file !== 'string' || !file) return null;
  const copy = Object.assign({}, source);
  if (!ctx.projectRoot || isAbsoluteFsPath(file)) return copy;
  const disk = toDiskPath(file, ctx);
  if (!disk || disk === file) return copy;
  copy.file = disk;
  copy.originalFile = file; // 保留浏览器侧原值，便于核对
  return copy;
}

/**
 * 保守地把文本里**确属本项目源码**的 URL 重写为磁盘路径（用于 console / network 的调用栈）。
 *
 * 必须同时满足三个条件才重写，否则原样保留：
 *   1. 已配置 devUrl；
 *   2. URL 与 devUrl 同源；
 *   3. 路径以源码扩展名结尾。
 * 这样 http://localhost:5173/api/cart 这类接口 URL 不会被误改。
 */
export function rewriteSourceUrls(text, ctx = {}) {
  if (typeof text !== 'string' || !text) return text;
  if (!ctx.devUrl) return text;
  let origin = '';
  try {
    origin = new URL(ctx.devUrl).origin;
  } catch (e) {
    return text;
  }
  return text.replace(/https?:\/\/[^\s()'"，、]+/g, (full) => {
    const { base, loc } = peelLineColumn(full);
    let parsed;
    try {
      parsed = new URL(stripQueryHash(base));
    } catch (e) {
      return full;
    }
    if (parsed.origin !== origin) return full;
    const pathname = decodeURIComponent(parsed.pathname);
    if (!SOURCE_EXT_RE.test(pathname)) return full;
    const disk = joinProjectPath(ctx.projectRoot, pathname);
    if (!disk) return full;
    return disk + loc;
  });
}

/**
 * 结构化归一化 get_picked_element 的结果（该接口返回对象而非文本）。
 * 保留 originalFile，便于核对浏览器侧的原始值。
 */
export function normalizePickedElement(result, ctx = {}) {
  if (!result || typeof result !== 'object') return result;
  if (!ctx.projectRoot) return result;
  const fix = (p) => {
    if (!p || typeof p !== 'object' || !p.source || typeof p.source !== 'object') return p;
    const file = p.source.file;
    if (typeof file !== 'string' || !file || isAbsoluteFsPath(file)) return p;
    const disk = toDiskPath(file, ctx);
    if (!disk || disk === file) return p;
    return Object.assign({}, p, { source: Object.assign({}, p.source, { file: disk, originalFile: file }) });
  };
  const out = Object.assign({}, result);
  if (out.picked) out.picked = fix(out.picked);
  if (Array.isArray(out.list)) out.list = out.list.map(fix);
  return out;
}

/** dev-session 缺少必要字段时给出的可操作提示；字段齐全时返回空串。 */
export function normalizationHint(ctx = {}) {
  const missing = [];
  if (!ctx.projectRoot) missing.push('projectRoot');
  if (!ctx.devUrl) missing.push('devUrl');
  if (!missing.length) return '';
  return (
    '（提示：共享开发会话缺少 ' +
    missing.join(' / ') +
    '，源码位置未转换为磁盘路径。请先调用 dev_session_set 写入项目根与开发服务器地址。）'
  );
}

export { SOURCE_EXT_RE, peelLineColumn };

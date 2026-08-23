// 匹配规则：@match / @include 转 Chrome match pattern（用于动态注册），
// 并提供运行时 URL 匹配做二次校验（含 @exclude 与正则 include）。

// 把单个 @match/@include 规范化为 Chrome match pattern；无法转换返回 null。
export function normalizeMatchPattern(pattern) {
  let p = String(pattern || '').trim().replace(/\s+$/, '');
  if (!p) return null;
  if (p.length > 2 && p[0] === '/' && p[p.length - 1] === '/') return null; // 正则 include 无法用于注册
  if (!/^[a-z*]+:\/\//i.test(p)) p = '*://' + p;
  const m = p.match(/^(?:(\*|[a-z]+)):\/\/([^/]*)(\/.*)?$/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const host = m[2];
  const path = m[3] || '/*';
  if (!/^(\*|(\*\.)?[a-z0-9.-]+)$/i.test(host)) return null;
  if (!path.startsWith('/')) return null;
  if (path === '/') return scheme + '://' + host + '/*';
  return scheme + '://' + host + path;
}

/**
 * 由元信息生成可用于 chrome.scripting.registerContentScripts 的 matches 数组。
 * 同时返回无法注册（如正则 include）的条目，放入 warnings。
 */
export function buildMatchPatterns(metadata) {
  const patterns = [];
  const warnings = [];
  const sources = (metadata.match || []).concat(metadata.include || []);
  for (const p of sources) {
    const norm = normalizeMatchPattern(p);
    if (norm) {
      if (!patterns.includes(norm)) patterns.push(norm);
    } else if (p && p.length > 2 && p[0] === '/' && p[p.length - 1] === '/') {
      warnings.push('正则规则仅运行时生效（无法用于页面注入注册）：' + p);
    } else if (p) {
      warnings.push('无法识别的匹配规则：' + p);
    }
  }
  return { patterns, warnings };
}

function globToRegExp(pattern) {
  let re = '';
  for (const ch of pattern) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

function patternMatches(pattern, url) {
  const p = String(pattern || '').trim();
  if (!p) return false;
  if (p.length > 2 && p[0] === '/' && p[p.length - 1] === '/') {
    try {
      return new RegExp(p.slice(1, -1)).test(url);
    } catch (e) {
      return false;
    }
  }
  return globToRegExp(p).test(url);
}

/**
 * 运行时 URL 匹配：@exclude 优先于 @match/@include；无匹配规则时默认全站。
 * @param {Object} metadata - 解析后的元信息
 * @param {string} url
 */
export function urlMatches(metadata, url) {
  const u = String(url || '');
  if ((metadata.exclude || []).some((ex) => patternMatches(ex, u))) return false;
  const sources = (metadata.match || []).concat(metadata.include || []);
  if (!sources.length) return true;
  return sources.some((p) => patternMatches(p, u));
}

import { sliceSafe } from './surrogates.ts';

/**
 * 防抖函数
 * @param {Function} fn - 要执行的函数
 * @param {number} delay - 延迟毫秒数
 * @returns {Function} 防抖后的函数
 */
export function debounce(fn: (...args: any[]) => any, delay: number): (...args: any[]) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return function (this: unknown, ...args: any[]) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * 安全日志记录（避免空 catch 块）
 * @param {string} context - 上下文描述
 * @param {Error|*} error - 错误对象
 */
export function logError(context: string, error: unknown) {
  console.warn(`[BookmarkSorter] ${context}:`, error);
}

export function cleanTitle(title: string | null | undefined) {
  let t = (title || '').trim();
  t = t
    .replace(
      /[|\-–—]\s*(力扣（LeetCode）|力扣|LeetCode|牛客网|牛客|nowcoder|洛谷|Luogu|AcWing|Codeforces|AtCoder).*$/i,
      ''
    )
    .trim();
  return t;
}

export function parseTags(str: unknown) {
  return String(str || '')
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 知识库列表用的 Markdown 纯文本摘要。
 * 完整文档只在“阅读”视图中展示；列表只保留可扫读的一段文字。
 */
export function markdownExcerpt(text: unknown, maxChars = 160) {
  const limit = Math.max(20, Number(maxChars) || 160);
  let s = String(text || '');
  s = s.replace(/```[\s\S]*?```/g, ' [代码块] ');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, (match, alt) => alt || '[图片]');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+[.)]\s+/gm, '');
  s = s.replace(/[*_~]{1,3}/g, '');
  s = s.replace(/\|/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > limit ? sliceSafe(s, 0, limit).trimEnd() + '…' : s;
}

export function fmtTime(ts: unknown): string {
  if (!ts) return '';
  const d = new Date(ts as string | number | Date);
  const diff = Date.now() - Number(d.getTime());
  if (diff < 60 * 60 * 1000) return Math.max(1, Math.round(diff / 60000)) + ' 分钟前';
  if (diff < 24 * 60 * 60 * 1000) return Math.round(diff / 3600000) + ' 小时前';
  if (diff < 7 * 24 * 60 * 60 * 1000) return Math.round(diff / 86400000) + ' 天前';
  return d.toLocaleDateString('zh-CN');
}

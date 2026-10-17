// 通用分页纯函数：知识库列表与测试共用，避免把页码边界逻辑散在 DOM 代码里。

export function clampPage(page, totalPages) {
  const total = Math.max(1, Math.floor(Number(totalPages) || 1));
  const wanted = Math.floor(Number(page) || 1);
  return Math.min(total, Math.max(1, wanted));
}

export function pageSlice(items, page, pageSize) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  const pageCount = Math.max(1, Math.ceil(list.length / size));
  const current = clampPage(page, pageCount);
  const start = (current - 1) * size;
  return {
    items: list.slice(start, start + size),
    page: current,
    pageCount,
    total: list.length,
    start,
    end: Math.min(list.length, start + size),
  };
}

/** 返回适合直接渲染的页码序列；跳页处用 'ellipsis' 表示。 */
export function pageTokens(currentPage, totalPages) {
  const total = Math.max(1, Math.floor(Number(totalPages) || 1));
  const current = clampPage(currentPage, total);
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const wanted = new Set([1, total, current, current - 1, current + 1]);
  if (current <= 4) [2, 3, 4, 5].forEach((n) => wanted.add(n));
  if (current >= total - 3) [total - 4, total - 3, total - 2, total - 1].forEach((n) => wanted.add(n));
  const numbers = [...wanted].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out = [];
  for (const n of numbers) {
    if (out.length && typeof out[out.length - 1] === 'number' && n - out[out.length - 1] > 1) {
      out.push('ellipsis');
    }
    out.push(n);
  }
  return out;
}

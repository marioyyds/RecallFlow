// 表格的筛选/排序/计数/求和（纯逻辑，node 可测）。
//
// 为什么单独成文件而不是塞进 table.js：table.js 会进**内容脚本**产物（content.js），
// 而查询只由后台的 read_table 工具使用。放在一起会被整份打进每个页面加载的 bundle，
// 白白增加体积（build-content 的体积预算会因此变红）。

/**
 * 把单元格文本解析成数字（用于 sum / 数值比较）。
 * 处理货币符号、千分位、百分号与括号负数；解析失败返回 null。
 */
export function toTableNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value === undefined || value === null ? '' : value).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[,\s]/g, '').replace(/[$€£¥￥]/g, '');
  let percent = false;
  if (/%$/.test(s)) {
    percent = true;
    s = s.slice(0, -1);
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (percent) n = n / 100;
  return negative ? -n : n;
}

/** 在表头里找列。先精确（忽略大小写），再包含；找不到返回 -1。 */
export function findTableColumn(headers, name) {
  const list = Array.isArray(headers) ? headers : [];
  const want = String(name === undefined || name === null ? '' : name).trim().toLowerCase();
  if (!want) return -1;
  for (let i = 0; i < list.length; i++) {
    if (String(list[i] || '').trim().toLowerCase() === want) return i;
  }
  for (let i = 0; i < list.length; i++) {
    const h = String(list[i] || '').trim().toLowerCase();
    if (h && (h.includes(want) || want.includes(h))) return i;
  }
  return -1;
}

function cellMatches(cell, op, value) {
  const c = String(cell === undefined || cell === null ? '' : cell).trim();
  const v = String(value === undefined || value === null ? '' : value).trim();
  const cn = toTableNumber(c);
  const vn = toTableNumber(v);
  const bothNumeric = cn !== null && vn !== null;
  switch (String(op || 'eq')) {
    case 'eq':
      return bothNumeric ? cn === vn : c.toLowerCase() === v.toLowerCase();
    case 'neq':
      return bothNumeric ? cn !== vn : c.toLowerCase() !== v.toLowerCase();
    case 'contains':
      return c.toLowerCase().includes(v.toLowerCase());
    case 'gt':
      return bothNumeric && cn > vn;
    case 'gte':
      return bothNumeric && cn >= vn;
    case 'lt':
      return bothNumeric && cn < vn;
    case 'lte':
      return bothNumeric && cn <= vn;
    default:
      return false;
  }
}

/**
 * 对已展开的表格做筛选 / 排序 / 计数 / 求和。纯函数，node 可测。
 *
 * @param {{headers?:string[], rows?:string[][]}} table
 * @param {{where?:Array, sort?:{column:string,dir?:string}, sum?:string}} [options]
 * @returns {{ok:boolean, errors:string[], headers:string[], rows:string[][], count:number, totalRows:number, sum:number|null, sumColumn:string}}
 */
export function queryTableData(table, options = {}) {
  const headers = Array.isArray(table && table.headers) ? table.headers.slice() : [];
  const source = Array.isArray(table && table.rows) ? table.rows.slice() : [];
  const errors = [];
  let rows = source;

  const where = Array.isArray(options.where) ? options.where : [];
  for (const f of where) {
    if (!f || typeof f !== 'object') continue;
    const idx = findTableColumn(headers, f.column);
    if (idx < 0) {
      errors.push('找不到列「' + f.column + '」；可用列：' + headers.join(' / '));
      continue;
    }
    rows = rows.filter((row) => cellMatches(Array.isArray(row) ? row[idx] : '', f.op, f.value));
  }

  if (options.sort && options.sort.column) {
    const idx = findTableColumn(headers, options.sort.column);
    if (idx < 0) {
      errors.push('排序找不到列「' + options.sort.column + '」；可用列：' + headers.join(' / '));
    } else {
      const dir = String(options.sort.dir || 'asc').toLowerCase() === 'desc' ? -1 : 1;
      rows = rows.slice().sort((a, b) => {
        const av = Array.isArray(a) ? a[idx] : '';
        const bv = Array.isArray(b) ? b[idx] : '';
        const an = toTableNumber(av);
        const bn = toTableNumber(bv);
        if (an !== null && bn !== null) return (an - bn) * dir;
        return String(av || '').localeCompare(String(bv || '')) * dir;
      });
    }
  }

  let sum = null;
  const sumColumn = String(options.sum || '');
  if (sumColumn) {
    const idx = findTableColumn(headers, sumColumn);
    if (idx < 0) {
      errors.push('求和找不到列「' + sumColumn + '」；可用列：' + headers.join(' / '));
    } else {
      sum = rows.reduce((acc, row) => {
        const n = toTableNumber(Array.isArray(row) ? row[idx] : '');
        return n === null ? acc : acc + n;
      }, 0);
    }
  }

  return { ok: errors.length === 0, errors, headers, rows, count: rows.length, totalRows: source.length, sum, sumColumn };
}

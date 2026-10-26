// 表格结构化提取的纯逻辑（无 DOM 依赖，node 可测）。
//
// 为什么需要它：朴素做法（逐行 querySelectorAll('td').map(textContent)）在**有合并单元格**时
// 必然错位 —— rowspan/colspan 会让后续行的第 N 个 td 其实属于第 N+k 列，于是「列对不齐」，
// 下游按列取值全错。这里用标准的占位（occupancy）算法把表格还原成矩形网格。
//
// 被 commands.js（内容脚本采集 DOM 单元格）与 node 单测共用。

import { sliceSafe } from './surrogates.js';

/** 一个单元格的 DOM 侧描述（由 commands.js 采集，这里只消费）。 */
export interface TableCellInput {
  text?: string;
  colspan?: number;
  rowspan?: number;
  isHeader?: boolean;
}

/** `expandTableGrid` 的形状选项。 */
export interface ExpandTableGridOptions {
  /** 行数上限，默认 200。 */
  maxRows?: number;
  /** 列数上限，0 = 不限，默认 0。 */
  maxCols?: number;
  /** 合并单元格的延续格是否重复填入同一文本，默认 true。 */
  fillMerged?: boolean;
}

/** `expandTableGrid` 的结果：矩形网格（缺格已补空串）。 */
export interface TableGrid {
  headers: string[];
  rows: string[][];
  widths: number;
  headerRowCount: number;
  mergedCells: number;
}

/**
 * 把「按 DOM 顺序排列的单元格描述」展开成矩形网格。
 *
 * @param rows 每行一个单元格数组，按 DOM 顺序
 * @param [options]
 * @param [options.maxRows=200] 行数上限
 * @param [options.maxCols=0]   列数上限（0 = 不限）
 * @param [options.fillMerged=true]
 *   合并单元格的延续格是否重复填入同一文本。默认 true：下游（尤其模型）按列读取时
 *   不希望遇到空洞；设 false 可保留「这里是合并延续」的忠实形态（延续格为空串）。
 */
export function expandTableGrid(rows: readonly (readonly TableCellInput[])[], options: ExpandTableGridOptions = {}): TableGrid {
  const maxRows = Math.max(1, Number(options.maxRows) || 200);
  const maxCols = Math.max(0, Number(options.maxCols) || 0);
  const fillMerged = options.fillMerged !== false;
  const src = Array.isArray(rows) ? rows.slice(0, maxRows) : [];

  const grid: string[][] = [];
  const occupancy: boolean[][] = []; // occupancy[r][c] = true 表示该格已被上方 rowspan 占用
  const isOccupied = (r: number, c: number) => Boolean(occupancy[r] && occupancy[r][c]);
  const occupy = (r: number, c: number) => {
    if (!occupancy[r]) occupancy[r] = [];
    occupancy[r][c] = true;
  };

  let mergedCells = 0;
  let widths = 0;

  for (let r = 0; r < src.length; r++) {
    if (!grid[r]) grid[r] = [];
    const cells = Array.isArray(src[r]) ? src[r] : [];
    let c = 0;
    for (const cell of cells) {
      if (!cell || typeof cell !== 'object') continue;
      // 跳过被上方 rowspan 占用的列
      while (isOccupied(r, c)) c += 1;
      const colspan = Math.max(1, Number(cell.colspan) || 1);
      const rowspan = Math.max(1, Number(cell.rowspan) || 1);
      if (colspan > 1 || rowspan > 1) mergedCells += 1;
      const text = String(cell.text === undefined || cell.text === null ? '' : cell.text)
        .replace(/\s+/g, ' ')
        .trim();
      // 起始格写文本，其余按 fillMerged 决定
      grid[r][c] = text;
      for (let dc = 1; dc < colspan; dc++) grid[r][c + dc] = fillMerged ? text : '';
      for (let dr = 1; dr < rowspan; dr++) {
        // 目标行可能尚未创建（我们只在这行的循环里初始化 grid[r]），必须先补上。
        if (!grid[r + dr]) grid[r + dr] = [];
        for (let dc = 0; dc < colspan; dc++) {
          grid[r + dr][c + dc] = fillMerged ? text : '';
        }
      }
      // 标记后续行的占位（含起始列，使 while 循环能正确跳过）
      for (let dr = 1; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) occupy(r + dr, c + dc);
      }
      c += colspan;
      if (maxCols > 0 && c >= maxCols) break;
    }
    widths = Math.max(widths, grid[r].length);
  }

  if (maxCols > 0) widths = Math.min(widths, maxCols);

  // 统一成矩形：缺格补空串，超宽截断
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < widths; c++) {
      if (typeof row[c] !== 'string') row[c] = '';
    }
    grid[r] = row.slice(0, widths);
  }

  // 表头：开头连续「整行都是 th」的行。多级表头时取最后一行作为列名。
  let headerRowCount = 0;
  for (let r = 0; r < src.length; r++) {
    const cells = src[r];
    const allHeader = Array.isArray(cells) && cells.length > 0 && cells.every((cell) => cell && cell.isHeader);
    if (!allHeader) break;
    headerRowCount += 1;
  }
  const headers = headerRowCount > 0 ? grid[headerRowCount - 1].slice() : [];
  const body = grid.slice(headerRowCount);

  return { headers, rows: body, widths, headerRowCount, mergedCells };
}

/**
 * 渲染成紧凑文本（给模型读），按行列上限截断并标注。
 * @param table `expandTableGrid` 的输出（或手工构造的同形状对象）
 * @param [options]
 * @param [options.maxRows=40]
 * @param [options.maxCellChars=60]
 */
export function formatTableText(table: { headers?: string[]; rows?: string[][] }, options: { maxRows?: number; maxCellChars?: number } = {}): string {
  const maxRows = Math.max(1, Number(options.maxRows) || 40);
  const maxCellChars = Math.max(4, Number(options.maxCellChars) || 60);
  const headers = Array.isArray(table.headers) ? table.headers : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const cell = (v: unknown) => {
    const s = String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
    // ⚠ 必须用 sliceSafe，不能直接 slice：这里是**一次线上 400 事故的触发点**。
    // 论文/数学页面的 `𝑦 𝒜 𝐺 𝐽` 每个都是星形平面字符（2 个 UTF-16 码元），
    // 切点落在高位代理上会留下**孤立代理** → 请求体在服务端解析阶段被整单拒收，
    // 而且 400 不重试 ⇒ 整个 run 一次即死。详见 lib/shared/surrogates.js 的说明。
    // 上限语义不变（只可能少一个字符，不会超），只是不再切裂字符。
    return s.length > maxCellChars ? sliceSafe(s, 0, maxCellChars) + '…' : s;
  };
  const lines = [];
  if (headers.length) {
    lines.push('| ' + headers.map(cell).join(' | ') + ' |');
    lines.push('|' + headers.map(() => '---').join('|') + '|');
  }
  for (const row of rows.slice(0, maxRows)) {
    lines.push('| ' + (Array.isArray(row) ? row : []).map(cell).join(' | ') + ' |');
  }
  if (rows.length > maxRows) {
    lines.push('…（共 ' + rows.length + ' 行，仅显示前 ' + maxRows + ' 行）');
  }
  return lines.join('\n');
}

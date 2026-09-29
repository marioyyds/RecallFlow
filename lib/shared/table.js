// 表格结构化提取的纯逻辑（无 DOM 依赖，node 可测）。
//
// 为什么需要它：朴素做法（逐行 querySelectorAll('td').map(textContent)）在**有合并单元格**时
// 必然错位 —— rowspan/colspan 会让后续行的第 N 个 td 其实属于第 N+k 列，于是「列对不齐」，
// 下游按列取值全错。这里用标准的占位（occupancy）算法把表格还原成矩形网格。
//
// 被 commands.js（内容脚本采集 DOM 单元格）与 node 单测共用。

/**
 * 把「按 DOM 顺序排列的单元格描述」展开成矩形网格。
 *
 * @param {Array<Array<{text?:string, colspan?:number, rowspan?:number, isHeader?:boolean}>>} rows
 * @param {Object} [options]
 * @param {number} [options.maxRows=200] 行数上限
 * @param {number} [options.maxCols=0]   列数上限（0 = 不限）
 * @param {boolean} [options.fillMerged=true]
 *   合并单元格的延续格是否重复填入同一文本。默认 true：下游（尤其模型）按列读取时
 *   不希望遇到空洞；设 false 可保留「这里是合并延续」的忠实形态（延续格为空串）。
 * @returns {{headers:string[], rows:string[][], widths:number, headerRowCount:number, mergedCells:number}}
 */
export function expandTableGrid(rows, options = {}) {
  const maxRows = Math.max(1, Number(options.maxRows) || 200);
  const maxCols = Math.max(0, Number(options.maxCols) || 0);
  const fillMerged = options.fillMerged !== false;
  const src = Array.isArray(rows) ? rows.slice(0, maxRows) : [];

  const grid = [];
  const occupancy = []; // occupancy[r][c] = true 表示该格已被上方 rowspan 占用
  const isOccupied = (r, c) => Boolean(occupancy[r] && occupancy[r][c]);
  const occupy = (r, c) => {
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
 * @param {{headers:string[], rows:string[][]}} table
 * @param {Object} [options]
 * @param {number} [options.maxRows=40]
 * @param {number} [options.maxCellChars=60]
 */
export function formatTableText(table, options = {}) {
  const maxRows = Math.max(1, Number(options.maxRows) || 40);
  const maxCellChars = Math.max(4, Number(options.maxCellChars) || 60);
  const headers = Array.isArray(table && table.headers) ? table.headers : [];
  const rows = Array.isArray(table && table.rows) ? table.rows : [];
  const cell = (v) => {
    const s = String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
    return s.length > maxCellChars ? s.slice(0, maxCellChars) + '…' : s;
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

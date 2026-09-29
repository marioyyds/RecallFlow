// 表格结构化提取的纯逻辑：合并单元格展开、表头识别、文本渲染。
//
// 重点覆盖「朴素提取必然出错」的场景 —— rowspan/colspan 会让后续行的第 N 个 td
// 其实落在第 N+k 列，不还原成矩形网格就会整体错位。
import test from 'node:test';
import assert from 'node:assert/strict';

import { expandTableGrid, formatTableText } from '../lib/shared/table.js';

const cell = (text, extra) => Object.assign({ text }, extra || {});
const th = (text, extra) => Object.assign({ text, isHeader: true }, extra || {});

test('expandTableGrid: 普通表格（无合并）', () => {
  const out = expandTableGrid([
    [th('名称'), th('Tracking ID')],
    [cell('甲'), cell('T-1')],
    [cell('乙'), cell('T-2')],
  ]);
  assert.deepEqual(out.headers, ['名称', 'Tracking ID']);
  assert.deepEqual(out.rows, [
    ['甲', 'T-1'],
    ['乙', 'T-2'],
  ]);
  assert.equal(out.widths, 2);
  assert.equal(out.headerRowCount, 1);
  assert.equal(out.mergedCells, 0);
});

test('expandTableGrid: colspan 展开 —— 这是朴素提取会错位的第一种情况', () => {
  const out = expandTableGrid([
    [th('总览', { colspan: 2 })],
    [cell('a'), cell('b')],
  ]);
  // 默认把合并文本重复填入延续格，下游按列读不会遇到空洞
  assert.deepEqual(out.rows, [['a', 'b']]);
  assert.deepEqual(out.headers, ['总览', '总览']);
  assert.equal(out.mergedCells, 1);
});

test('expandTableGrid: rowspan 展开 —— 后续行必须跳过被占用的列', () => {
  const out = expandTableGrid([
    [cell('跨两行', { rowspan: 2 }), cell('上')],
    [cell('下')], // DOM 里这行只有一个 td，但它应落在第 2 列
  ]);
  assert.equal(out.widths, 2);
  assert.deepEqual(out.rows[0], ['跨两行', '上']);
  assert.deepEqual(out.rows[1], ['跨两行', '下'], '第二行的 td 必须补到第 2 列，而不是占据第 1 列');
});

test('expandTableGrid: rowspan 写到了「还没创建的行」也不应抛错', () => {
  // 回归用例：曾经直接在 grid[r+dr][c] 上赋值，而该行此时尚未初始化 → TypeError
  assert.doesNotThrow(() => {
    expandTableGrid([[cell('x', { rowspan: 3 })], [cell('y')], [cell('z')]]);
  });
  const out = expandTableGrid([[cell('x', { rowspan: 3 })], [cell('y')], [cell('z')]]);
  assert.equal(out.rows.length, 3);
  assert.equal(out.rows[2][0], 'x');
});

test('expandTableGrid: rowspan + colspan 组合', () => {
  const out = expandTableGrid([
    [cell('跨2行2列', { rowspan: 2, colspan: 2 }), cell('r1c3')],
    [cell('r2c3')],
    [cell('a'), cell('b'), cell('c')],
  ]);
  assert.equal(out.widths, 3);
  assert.deepEqual(out.rows[0], ['跨2行2列', '跨2行2列', 'r1c3']);
  assert.deepEqual(out.rows[1], ['跨2行2列', '跨2行2列', 'r2c3']);
  assert.deepEqual(out.rows[2], ['a', 'b', 'c']);
});

test('expandTableGrid: fillMerged=false 时延续格留空（忠实形态）', () => {
  const out = expandTableGrid([[cell('合并', { colspan: 3 })]], { fillMerged: false });
  assert.deepEqual(out.rows[0], ['合并', '', '']);
});

test('expandTableGrid: 多级表头取最后一行作为列名', () => {
  const out = expandTableGrid([
    [th('分组A', { colspan: 2 }), th('分组B')],
    [th('x'), th('y'), th('z')],
    [cell('1'), cell('2'), cell('3')],
  ]);
  assert.equal(out.headerRowCount, 2);
  assert.deepEqual(out.headers, ['x', 'y', 'z']);
  assert.deepEqual(out.rows, [['1', '2', '3']]);
});

test('expandTableGrid: 无 th 时没有表头，所有行都是数据', () => {
  const out = expandTableGrid([[cell('a'), cell('b')]]);
  assert.deepEqual(out.headers, []);
  assert.deepEqual(out.rows, [['a', 'b']]);
  assert.equal(out.headerRowCount, 0);
});

test('expandTableGrid: 参差不齐的行统一补齐成矩形', () => {
  const out = expandTableGrid([[cell('a'), cell('b'), cell('c')], [cell('d')]]);
  assert.equal(out.widths, 3);
  assert.deepEqual(out.rows[0], ['a', 'b', 'c']);
  assert.deepEqual(out.rows[1], ['d', '', ''], '缺格应补空串而不是 undefined');
});

test('expandTableGrid: 文本归一化（折叠空白、去首尾）', () => {
  const out = expandTableGrid([[cell('  a\n\t b  ')]]);
  assert.deepEqual(out.rows[0], ['a b']);
});

test('expandTableGrid: maxRows / maxCols 截断', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push([cell('r' + i), cell('x'), cell('y')]);
  const out = expandTableGrid(rows, { maxRows: 3, maxCols: 2 });
  assert.equal(out.rows.length, 3);
  assert.equal(out.widths, 2);
  assert.deepEqual(out.rows[0], ['r0', 'x']);
});

test('expandTableGrid: 脏数据安全（空/非数组/非法 span）', () => {
  assert.deepEqual(expandTableGrid(null).rows, []);
  assert.deepEqual(expandTableGrid([]).rows, []);
  const out = expandTableGrid([[null, cell('a', { colspan: 0, rowspan: -3 }), 'x']]);
  assert.equal(out.widths, 1);
  assert.deepEqual(out.rows[0], ['a'], 'colspan/rowspan 非法时按 1 处理，字符串单元格被忽略');
});

test('formatTableText: 输出 markdown 表格并带分隔行', () => {
  const text = formatTableText({ headers: ['a', 'b'], rows: [['1', '2']] });
  const lines = text.split('\n');
  assert.equal(lines[0], '| a | b |');
  assert.equal(lines[1], '|---|---|');
  assert.equal(lines[2], '| 1 | 2 |');
});

test('formatTableText: 超行数上限时标注总行数', () => {
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push(['r' + i]);
  const text = formatTableText({ headers: ['c'], rows }, { maxRows: 5 });
  assert.ok(text.includes('共 50 行'), text);
  assert.equal(text.split('\n').length, 1 + 1 + 5 + 1);
});

test('formatTableText: 长单元格截断、脏数据不抛错', () => {
  const text = formatTableText({ headers: ['c'], rows: [['x'.repeat(200)]] }, { maxCellChars: 10 });
  assert.ok(text.includes('x'.repeat(10) + '…'), text);
  assert.equal(formatTableText(null), '');
  assert.equal(formatTableText({ headers: [], rows: [] }), '');
});

test('expandTableGrid 与 formatTableText 端到端：合并表头 + 数据行', () => {
  const table = expandTableGrid([
    [th('名称'), th('Tracking ID', { colspan: 2 })],
    [cell('甲'), cell('T-1'), cell('K-1')],
  ]);
  const text = formatTableText(table);
  assert.ok(text.includes('| 名称 | Tracking ID | Tracking ID |'), text);
  assert.ok(text.includes('| 甲 | T-1 | K-1 |'), text);
});

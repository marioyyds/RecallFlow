// read_table 的纯逻辑：列定位、筛选、排序、计数、求和、分页解析。
//
// 这些是报表任务的承重部分：模型不应该从快照里手抄/手算；
// 工具必须在 node 里可确定性验证（DOM 那侧只负责把网格读出来）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findTableColumn,
  toTableNumber,
  queryTableData,
} from '../lib/shared/table-query.js';
import { parseGridPagination } from '../lib/shared/table.js';

const table = {
  headers: ['Order', 'Status', 'Grand Total', 'Date'],
  rows: [
    ['1', 'Complete', '$65.32', '2023-03-11'],
    ['2', 'Canceled', '$17.99', '2023-03-10'],
    ['3', 'Complete', '$762.18', '2023-02-27'],
    ['4', 'complete', '$185.32', '2023-02-09'],
  ],
};

test('toTableNumber：货币/千分位/百分号/括号负数', () => {
  assert.equal(toTableNumber('$1,234.50'), 1234.5);
  assert.equal(toTableNumber('20%'), 0.2);
  assert.equal(toTableNumber('(12.00)'), -12);
  assert.equal(toTableNumber('not a number'), null);
  assert.equal(toTableNumber(42), 42);
});

test('findTableColumn：精确优先，其次包含；找不到 -1', () => {
  assert.equal(findTableColumn(table.headers, 'Grand Total'), 2);
  assert.equal(findTableColumn(table.headers, 'total'), 2);
  assert.equal(findTableColumn(table.headers, 'Missing'), -1);
});

test('queryTableData：where 支持大小写不敏感与数值比较', () => {
  const q = queryTableData(table, { where: [{ column: 'Status', op: 'eq', value: 'complete' }] });
  assert.equal(q.ok, true);
  assert.equal(q.count, 3);
  assert.equal(q.totalRows, 4);
  const q2 = queryTableData(table, { where: [{ column: 'Grand Total', op: 'gt', value: 100 }] });
  assert.equal(q2.count, 2);
});

test('queryTableData：sort + sum + 只取匹配行', () => {
  const q = queryTableData(table, {
    where: [{ column: 'Status', op: 'eq', value: 'Complete' }],
    sort: { column: 'Grand Total', dir: 'desc' },
    sum: 'Grand Total',
  });
  assert.equal(q.ok, true);
  assert.equal(q.rows[0][0], '3');
  assert.ok(Math.abs(q.sum - 1012.82) < 0.001, '浮点求和允许 1e-3 误差，实际 ' + q.sum);
});

test('queryTableData：找不到列时显式报错（不静默返回空）', () => {
  const q = queryTableData(table, { where: [{ column: 'Nope', op: 'eq', value: 1 }] });
  assert.equal(q.ok, false);
  assert.match(q.errors[0], /找不到列/);
  assert.match(q.errors[0], /Order/);
});

test('parseGridPagination：Magento Items x to y of N', () => {
  const p = parseGridPagination('Items 1 to 20 of 345 total');
  assert.equal(p.total, 345);
  assert.equal(p.pageSize, 20);
  assert.equal(p.currentPage, 1);
  assert.equal(p.hasNext, true);
  assert.equal(p.totalPages, 18);
});

test('parseGridPagination：records found 与 Page x of y', () => {
  const p = parseGridPagination('345 records found. Page 2 of 18');
  assert.equal(p.total, 345);
  assert.equal(p.currentPage, 2);
  assert.equal(p.totalPages, 18);
  assert.equal(p.hasNext, true);
});

test('parseGridPagination：最后一页 hasNext=false', () => {
  const p = parseGridPagination('Items 341 to 345 of 345');
  assert.equal(p.total, 345);
  assert.equal(p.hasNext, false);
  assert.equal(p.totalPages, 69);
});

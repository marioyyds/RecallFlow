import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { clampPage, pageSlice, pageTokens } from '../lib/shared/pagination.js';

test('clampPage: 页码始终落在有效范围', () => {
  assert.equal(clampPage(0, 5), 1);
  assert.equal(clampPage(3, 5), 3);
  assert.equal(clampPage(9, 5), 5);
  assert.equal(clampPage('x', 0), 1);
});

test('pageSlice: 正确切页并返回页码信息', () => {
  const items = Array.from({ length: 25 }, (_, i) => i + 1);
  const p2 = pageSlice(items, 2, 12);
  assert.deepEqual(p2.items, [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  assert.equal(p2.pageCount, 3);
  assert.equal(p2.page, 2);
  assert.equal(p2.start, 12);
  assert.equal(p2.end, 24);
  const over = pageSlice(items, 99, 12);
  assert.equal(over.page, 3);
  assert.deepEqual(over.items, [25]);
});

test('pageTokens: 页数少时全列，页数多时用省略号收窄', () => {
  assert.deepEqual(pageTokens(1, 5), [1, 2, 3, 4, 5]);
  const mid = pageTokens(10, 20);
  assert.equal(mid[0], 1);
  assert.equal(mid[mid.length - 1], 20);
  assert.ok(mid.includes(9) && mid.includes(10) && mid.includes(11));
  assert.ok(mid.includes('ellipsis'));
});

test('知识库页面接入分页并按 12 条切页', () => {
  const manager = fs.readFileSync('entries/manager.js', 'utf8');
  const html = fs.readFileSync('manager.html', 'utf8');
  assert.match(html, /id="kb-pagination"/);
  assert.match(manager, /const KB_PAGE_SIZE = 12/);
  assert.match(manager, /pageSlice\(items, currentPage, KB_PAGE_SIZE\)/);
  assert.match(manager, /kb-page-btn/);
});

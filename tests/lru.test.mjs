// LRU 缓存：这里是「截图缓存无界增长」那个泄漏的修复件，
// 而淘汰策略写错是**静默**的 —— 容量看着对，实际退化成 FIFO，正在看的那张反而先被丢掉。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLruCache } from '../lib/shared/lru.js';

test('未超容量时正常读写', () => {
  const c = createLruCache(3);
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('b'), 2);
  assert.equal(c.size, 2);
  assert.equal(c.has('a'), true);
  assert.equal(c.get('missing'), undefined);
});

test('超出容量时淘汰最久未使用的', () => {
  const c = createLruCache(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  c.set('d', 4); // 挤掉 a（最久未使用）
  assert.equal(c.has('a'), false);
  assert.deepEqual(c.keys(), ['b', 'c', 'd']);
});

test('get 会刷新使用顺序（这正是它区别于 FIFO 的地方）', () => {
  const c = createLruCache(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  c.get('a'); // a 变成最近使用
  c.set('d', 4); // 该挤掉 b，而不是 a
  assert.equal(c.has('a'), true, 'a 刚被读过，不该被淘汰');
  assert.equal(c.has('b'), false, 'b 才是最久未使用的');
  assert.deepEqual(c.keys(), ['c', 'a', 'd']);
});

test('覆盖同一个 key 不会让它占两个位置，且算作最近使用', () => {
  const c = createLruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('a', 9); // 覆盖 + 刷新
  assert.equal(c.size, 2);
  c.set('c', 3); // 应挤掉 b
  assert.equal(c.get('a'), 9);
  assert.equal(c.has('b'), false);
  assert.equal(c.has('c'), true);
});

test('容量为 1 时只保留最后写入的一个', () => {
  const c = createLruCache(1);
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.size, 1);
  assert.equal(c.has('a'), false);
  assert.equal(c.get('b'), 2);
});

test('容量参数是脏数据时退化为 1，而不是变成无上限', () => {
  for (const bad of [0, -5, NaN, undefined, null, 'x']) {
    const c = createLruCache(bad);
    c.set('a', 1);
    c.set('b', 2);
    assert.equal(c.size, 1, '容量 ' + String(bad) + ' 时仍应有界');
  }
});

test('容量为小数时向下取整', () => {
  const c = createLruCache(2.9);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.size, 2);
  assert.equal(c.has('a'), false);
});

test('大量写入后大小恒定在容量上（无界增长已消除）', () => {
  const c = createLruCache(30);
  for (let i = 0; i < 5000; i++) c.set('shot-' + i, 'x'.repeat(100));
  assert.equal(c.size, 30, '写入 5000 次后仍应只有 30 条');
  assert.equal(c.has('shot-4999'), true, '最后写入的必须在');
  assert.equal(c.has('shot-0'), false);
});

test('delete / clear 可用', () => {
  const c = createLruCache(3);
  c.set('a', 1);
  assert.equal(c.delete('a'), true);
  assert.equal(c.delete('a'), false);
  assert.equal(c.size, 0);
  c.set('b', 2);
  c.clear();
  assert.equal(c.size, 0);
});

test('值可以是任意类型（含 undefined 语义的边界）', () => {
  const c = createLruCache(2);
  c.set('obj', { a: 1 });
  c.set('nil', null);
  assert.deepEqual(c.get('obj'), { a: 1 });
  assert.equal(c.get('nil'), null);
  assert.equal(c.has('nil'), true, '存 null 的 key 仍应存在');
});

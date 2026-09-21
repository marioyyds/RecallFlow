import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, cleanTitle, parseTags, normalizeUrl, detectPlatform, sortItems } from '../lib/shared/utils.js';

test('esc escapes html special chars', () => {
  assert.equal(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

test('cleanTitle strips platform suffix', () => {
  assert.equal(cleanTitle('两数之和 - 力扣（LeetCode）'), '两数之和');
});

test('parseTags splits on separators', () => {
  assert.deepEqual(parseTags('a, b，c d'), ['a', 'b', 'c', 'd']);
});

test('normalizeUrl drops hash', () => {
  assert.equal(normalizeUrl('https://x.com/p#h'), 'https://x.com/p');
});

test('detectPlatform matches known sites', () => {
  assert.equal(detectPlatform('https://leetcode.cn/problems/x').id, 'leetcode');
  assert.equal(detectPlatform('https://example.com').id, 'other');
});

test('sortItems defaults to updatedAt desc', () => {
  const list = [{ updatedAt: 1 }, { updatedAt: 3 }, { updatedAt: 2 }];
  assert.deepEqual(sortItems(list).map((x) => x.updatedAt), [3, 2, 1]);
});

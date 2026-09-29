import test from 'node:test';
import assert from 'node:assert/strict';
import { renumberCitations } from '../lib/page/markdown.js';

test('renumbers by body order and keeps only cited sources', () => {
  const cites = [
    { index: 5, title: 'A', url: 'u1' },
    { index: 7, title: 'B', url: 'u2' },
  ];
  const r = renumberCitations('见 [7] 和 [5]，还有 [7]', cites);
  assert.equal(r.text, '见 [1] 和 [2]，还有 [1]');
  assert.deepEqual(r.citations.map((c) => c.title), ['B', 'A']);
  assert.deepEqual(r.citations.map((c) => c.index), [1, 2]);
});

test('no body citations -> empty sources, not all sources', () => {
  const cites = [{ index: 1, title: 'A', url: 'u1' }];
  const r = renumberCitations('没有任何引用', cites);
  assert.deepEqual(r.citations, []);
  assert.equal(r.text, '没有任何引用');
});

test('unknown citation numbers are dropped, not mismapped to a source', () => {
  const cites = [{ index: 1, title: 'A', url: 'u1' }];
  const r = renumberCitations('见 [1] 和 [9]', cites);
  assert.equal(r.text, '见 [1] 和 [9]');
  assert.equal(r.citations.length, 1);
  assert.equal(r.citations[0].title, 'A');
});

test('full-width brackets are supported', () => {
  const cites = [{ index: 3, title: 'A', url: 'u1' }];
  const r = renumberCitations('参考［3］', cites);
  assert.equal(r.text, '参考[1]');
  assert.equal(r.citations.length, 1);
});

test('does not mutate the input citations', () => {
  const cites = [{ index: 2, title: 'A', url: 'u1' }];
  const snapshot = JSON.stringify(cites);
  renumberCitations('见 [2]', cites);
  assert.equal(JSON.stringify(cites), snapshot);
});

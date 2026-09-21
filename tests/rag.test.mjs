import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeQuery, buildRagContext, buildCitations, isKbOverviewQuery } from '../lib/shared/rag.js';

const book = {
  a: { id: 'a', title: 'K8s 部署指南', type: 'article', tags: ['k8s', '部署'], note: '使用 helm', updatedAt: 2 },
  b: { id: 'b', title: 'Nginx 配置', type: 'note', tags: ['nginx'], note: '反向代理', updatedAt: 1 },
};

test('tokenizeQuery splits tokens', () => {
  const t = tokenizeQuery('k8s 部署');
  assert.ok(t.includes('k8s'));
  assert.ok(t.length >= 1);
});

test('buildRagContext ranks title match first', () => {
  const r = buildRagContext(book, 'k8s', 5);
  assert.equal(r[0].id, 'a');
});

test('buildCitations maps index and source', () => {
  const c = buildCitations([book.a], false);
  assert.equal(c[0].index, 1);
  assert.equal(c[0].source, 'kb');
  assert.equal(c[0].url, '');
});

test('isKbOverviewQuery detects overview questions', () => {
  assert.equal(isKbOverviewQuery('知识库里有什么'), true);
  assert.equal(isKbOverviewQuery('打开百度'), false);
});

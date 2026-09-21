import test from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, extractKeyword, INTENTS } from '../lib/assistant/intent-router.js';

test('detects browser intent', () => {
  assert.equal(detectIntent('打开百度搜索今天的热搜').intent, INTENTS.BROWSER);
});

test('detects knowledge intent', () => {
  assert.equal(detectIntent('我的收藏里有没有 nginx 的笔记').intent, INTENTS.KNOWLEDGE);
});

test('continuation inherits previous user intent', () => {
  const d = detectIntent('继续', [{ role: 'user', content: '打开百度搜索热搜' }]);
  assert.equal(d.intent, INTENTS.BROWSER);
});

test('extractKeyword strips leading verbs', () => {
  const k = extractKeyword('打开百度搜索今天的热搜');
  assert.ok(!k.startsWith('打开'));
});

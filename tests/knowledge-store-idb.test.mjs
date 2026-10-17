// 知识库 IndexedDB 迁移的源码级门禁。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const store = fs.readFileSync('lib/shared/store.js', 'utf8');
const manager = fs.readFileSync('manager.js', 'utf8');
const popup = fs.readFileSync('popup.js', 'utf8');
const e2e = fs.readFileSync('tests/e2e/helpers.mjs', 'utf8');

test('知识库主存储是 IndexedDB，并拆分为 entries / documents / meta', () => {
  assert.match(store, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(store, /const DB_NAME = 'recallflow-knowledge'/);
  assert.match(store, /createObjectStore\(STORE_ENTRIES/);
  assert.match(store, /createObjectStore\(STORE_DOCUMENTS/);
  assert.match(store, /createObjectStore\(STORE_META/);
  assert.match(store, /notePreview/);
});

test('旧 chrome.storage 数据一次性迁移且保留备份', () => {
  assert.match(store, /MIGRATION_META_KEY = 'chrome-storage-v2'/);
  assert.match(store, /knowledgeBasePreIndexedDB/);
  assert.match(store, /chrome\.storage\.local\.remove\(\[STORAGE_KEY, LEGACY_STORAGE_KEY\]\)/);
});

test('知识库写操作使用单条事务并广播变更', () => {
  assert.match(store, /async function upsertItem/);
  assert.match(store, /async function updateStatus/);
  assert.match(store, /async function deleteItem/);
  assert.match(store, /subscribeKnowledgeChanges/);
  assert.match(manager, /subscribeKnowledgeChanges/);
  assert.match(popup, /subscribeKnowledgeChanges/);
});

test('E2E 直接读 IndexedDB，而不是旧 knowledgeBase key', () => {
  assert.match(e2e, /indexedDB\.open\('recallflow-knowledge', 1\)/);
  assert.match(e2e, /objectStore\('documents'\)/);
  assert.match(e2e, /knowledgeBasePreIndexedDB/);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { createKnowledgeRepository } from '../lib/application/knowledge/repository.ts';

function item(id, patch = {}) {
  return {
    id,
    type: 'note',
    title: id,
    url: '',
    platform: '',
    platformName: '',
    status: 2,
    note: '',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function cloneBook(book) {
  return Object.fromEntries(
    Object.entries(book).map(([id, value]) => [id, { ...value, tags: value.tags.slice() }])
  );
}

function fakeStore(initial = {}) {
  let book = cloneBook(initial);
  let getCalls = 0;
  const writes = [];
  const subscriptions = new Set();

  return {
    get getCalls() {
      return getCalls;
    },
    get writes() {
      return writes;
    },
    get book() {
      return cloneBook(book);
    },
    async getBook() {
      getCalls += 1;
      return cloneBook(book);
    },
    async setBook(next) {
      book = cloneBook(next);
      writes.push(cloneBook(next));
    },
    async upsertItem(input) {
      const id = String(input.id);
      const prev = book[id];
      const next = item(id, {
        ...prev,
        type: input.type || prev?.type || 'wrong',
        title: input.title || prev?.title || id,
        url: input.url || prev?.url || '',
        platform: input.platformId || prev?.platform || '',
        platformName: input.platformName || prev?.platformName || '',
        status: input.status ?? prev?.status ?? 2,
        note: typeof input.note === 'string' ? input.note : prev?.note || '',
        tags: Array.isArray(input.tags) ? input.tags.slice() : prev?.tags || [],
        createdAt: prev?.createdAt || 1,
        updatedAt: 2,
      });
      book = { ...book, [id]: next };
      return { ...next, tags: next.tags.slice() };
    },
    subscribeChanges(listener) {
      subscriptions.add(listener);
      return () => subscriptions.delete(listener);
    },
    emitChange() {
      for (const listener of subscriptions) listener();
    },
  };
}

test('Repository 加载一次并返回隔离快照', async () => {
  const store = fakeStore({ a: item('a') });
  const repository = createKnowledgeRepository(store);

  const first = await repository.load();
  await repository.load();
  assert.equal(store.getCalls, 1);
  assert.equal(first.a.title, 'a');

  first.a.title = '外部篡改';
  assert.equal(repository.get('a').title, 'a');
});

test('并发 update 串行落盘，不丢失前一字段', async () => {
  const store = fakeStore({ a: item('a') });
  const repository = createKnowledgeRepository(store);
  await repository.load();

  await Promise.all([
    repository.update('a', (current) => ({ ...current, title: '新标题' })),
    repository.update('a', (current) => ({ ...current, note: '新正文' })),
  ]);

  assert.equal(repository.get('a').title, '新标题');
  assert.equal(repository.get('a').note, '新正文');
  assert.equal(store.writes.length, 2);
});

test('upsert、remove 和订阅通知共享同一份缓存', async () => {
  const store = fakeStore();
  const repository = createKnowledgeRepository(store);
  const seen = [];
  repository.subscribe((book) => seen.push(Object.keys(book)));

  await repository.upsert({ id: 'b', title: 'B', tags: ['x'] });
  assert.equal(repository.get('b').title, 'B');
  assert.equal(await repository.remove('b'), true);
  assert.equal(repository.get('b'), undefined);
  assert.equal(seen.length >= 2, true);
});

test('replace 按完整快照删除，putMany 只合并不误删', async () => {
  const store = fakeStore({ a: item('a'), b: item('b') });
  const repository = createKnowledgeRepository(store);
  await repository.load();

  await repository.putMany([item('a', { title: 'A2' }), item('c')]);
  assert.deepEqual(Object.keys(repository.snapshot()).sort(), ['a', 'b', 'c']);
  assert.equal(repository.get('a').title, 'A2');

  await repository.replace({ c: item('c') });
  assert.deepEqual(Object.keys(repository.snapshot()), ['c']);
});

test('底层广播触发强制重载，dispose 后不再刷新', async () => {
  const store = fakeStore({ a: item('a') });
  const repository = createKnowledgeRepository(store);
  await repository.load();

  const changed = {
    ...store.book,
    a: item('a', { title: '外部修改' }),
  };
  await store.setBook(changed);
  store.emitChange();
  await repository.load();
  assert.equal(repository.get('a').title, '外部修改');

  repository.dispose();
  const calls = store.getCalls;
  store.emitChange();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getCalls, calls);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PanelSessionStore,
  PSESS_INDEX_KEY,
  PSESS_ACTIVE_KEY,
  panelSessionKey,
  panelSessionLockKey,
  deriveSessionTitle,
} from '../lib/shared/panel-sessions.js';

function memoryStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    data,
    async get(keys) {
      if (keys == null) return Object.assign({}, data);
      if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
        return out;
      }
      return Object.prototype.hasOwnProperty.call(data, keys) ? { [keys]: data[keys] } : {};
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}

function makeStore(extra) {
  let tick = 1_000;
  let seq = 0;
  const storage = memoryStorage((extra && extra.initial) || {});
  const store = new PanelSessionStore(
    Object.assign(
      {
        storage,
        now: () => ++tick,
        idFactory: () => 'S-test-' + ++seq,
        maxSessions: 20,
        lockTtlMs: 10_000,
      },
      (extra && extra.options) || {}
    )
  );
  return { store, storage };
}

test('deriveSessionTitle: 取第一条用户消息并压缩空白', () => {
  assert.equal(
    deriveSessionTitle([{ role: 'assistant', content: 'x' }, { role: 'user', content: '  搜索\n  jev  ' }]),
    '搜索 jev'
  );
  assert.equal(deriveSessionTitle([], '新会话'), '新会话');
  assert.ok(deriveSessionTitle([{ role: 'user', content: '长'.repeat(80) }]).length <= 42);
});

test('deriveSessionTitle: 长标题截断不切裂 emoji 代理对', () => {
  const title = deriveSessionTitle([{ role: 'user', content: '😀'.repeat(60) }]);
  assert.ok(title.endsWith('…'));
  assert.doesNotThrow(() => encodeURIComponent(title));
});

test('bootstrap: 无旧数据时创建一个空会话并设为当前', async () => {
  const { store, storage } = makeStore();
  const state = await store.bootstrap();
  assert.equal(state.sessions.length, 1);
  assert.equal(state.activeId, state.sessions[0].id);
  assert.equal(storage.data[PSESS_INDEX_KEY].seq, 1);
  assert.equal(storage.data[PSESS_ACTIVE_KEY].id, state.activeId);
  const got = await store.get(state.activeId);
  assert.deepEqual(got.session.messages, []);
});

test('bootstrap: 旧版按 tab 的对话迁成历史会话，最近一条成为当前', async () => {
  const { store, storage } = makeStore();
  const state = await store.bootstrap({
    legacyEntries: [
      {
        key: 'recallflow.conv.1',
        conversation: [{ role: 'user', content: '旧会话一' }],
        updatedAt: 100,
      },
      {
        key: 'recallflow.conv.2',
        conversation: [{ role: 'user', content: '旧会话二' }, { role: 'assistant', content: '答' }],
        updatedAt: 300,
      },
    ],
  });
  assert.equal(state.sessions.length, 2);
  assert.equal(state.migratedKeys.length, 2);
  assert.deepEqual(
    state.sessions.map((s) => s.title).sort(),
    ['旧会话一', '旧会话二']
  );
  assert.equal(state.sessions.find((s) => s.id === state.activeId).title, '旧会话二');
  assert.ok(storage.data[panelSessionKey(state.activeId)]);
});

test('save: 按 seq 拒绝旧标签页的过期写入，并返回最新正文', async () => {
  const { store } = makeStore();
  const boot = await store.bootstrap();
  const id = boot.activeId;
  const first = await store.save({
    id,
    baseSeq: 1,
    messages: [{ role: 'user', content: '第一次' }],
  });
  assert.equal(first.ok, true);
  const second = await store.save({
    id,
    baseSeq: first.session.seq,
    messages: [{ role: 'user', content: '第二次' }],
  });
  assert.equal(second.ok, true);
  const stale = await store.save({
    id,
    baseSeq: first.session.seq,
    messages: [{ role: 'user', content: '旧内容' }],
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(stale.session.messages[0].content, '第二次');
});

test('save: 同一标签页的连续队列写可以追平 seq；跨标签页仍会冲突', async () => {
  const { store } = makeStore();
  const boot = await store.bootstrap();
  const id = boot.activeId;
  const first = await store.save({
    id,
    tabId: 11,
    baseSeq: boot.seq,
    messages: [{ role: 'user', content: '第一句' }],
  });
  const second = await store.save({
    id,
    tabId: 11,
    baseSeq: boot.seq,
    messages: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '第二句' }],
  });
  assert.equal(second.ok, true);
  const staleOtherTab = await store.save({
    id,
    tabId: 12,
    baseSeq: first.session.seq,
    messages: [{ role: 'user', content: '别的标签页' }],
  });
  assert.equal(staleOtherTab.ok, false);
  assert.equal(staleOtherTab.conflict, true);
});

test('save: 自动标题跟随第一条用户消息，手动重命名后不再被覆盖', async () => {
  const { store } = makeStore();
  const boot = await store.bootstrap();
  const id = boot.activeId;
  const saved = await store.save({
    id,
    baseSeq: boot.seq,
    messages: [{ role: 'user', content: '搜索 jev' }],
  });
  assert.equal(saved.session.title, '搜索 jev');
  const renamed = await store.rename(id, 'GitHub 检索');
  assert.equal(renamed.session.title, 'GitHub 检索');
  const saved2 = await store.save({
    id,
    baseSeq: renamed.session.seq,
    messages: [
      { role: 'user', content: '搜索 jev' },
      { role: 'assistant', content: '完成' },
    ],
  });
  assert.equal(saved2.session.title, 'GitHub 检索');
});

test('create + activate: 新会话成为全局当前，旧会话仍可读取', async () => {
  const { store } = makeStore();
  const boot = await store.bootstrap();
  const oldId = boot.activeId;
  const created = await store.create({ title: '第二个' });
  assert.equal(created.activeId, created.session.id);
  const listed = await store.list();
  assert.equal(listed.activeId, created.session.id);
  assert.equal(listed.sessions.length, 2);
  const restored = await store.activate(oldId);
  assert.equal(restored.ok, true);
  assert.equal(restored.activeId, oldId);
});

test('remove: 删除当前会话后自动选择最近会话；删除最后一个会补一个空会话', async () => {
  const { store } = makeStore();
  const a = await store.bootstrap();
  const b = await store.create({ title: 'B' });
  const removedB = await store.remove(b.session.id);
  assert.equal(removedB.ok, true);
  assert.equal(removedB.activeId, a.activeId);
  const removedLast = await store.remove(a.activeId);
  assert.equal(removedLast.ok, true);
  assert.equal(removedLast.sessions.length, 1);
  assert.equal(removedLast.activeId, removedLast.sessions[0].id);
});

test('lock: 同一会话拒绝第二运行，过期后可重新获取，接管会记录原 owner', async () => {
  const { store } = makeStore();
  const boot = await store.bootstrap();
  const id = boot.activeId;
  const first = await store.lock({ id, runId: 'run-a', tabId: 1 });
  assert.equal(first.ok, true);
  const blocked = await store.lock({ id, runId: 'run-b', tabId: 2 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.locked, true);
  const takeover = await store.lock({ id, runId: 'run-b', tabId: 2, takeover: true });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.lock.previous.runId, 'run-a');
  assert.equal(takeover.lock.previous.tabId, 1);
  const wrongRelease = await store.unlock({ id, runId: 'run-a' });
  assert.equal(wrongRelease.ok, false);
  const released = await store.unlock({ id, runId: 'run-b' });
  assert.equal(released.ok, true);
});

test('releaseTabLocks: 标签页关闭后只释放它持有的锁', async () => {
  const { store } = makeStore();
  const a = await store.bootstrap();
  const b = await store.create({ title: 'B' });
  await store.lock({ id: a.activeId, runId: 'run-a', tabId: 7 });
  await store.lock({ id: b.session.id, runId: 'run-b', tabId: 8 });
  const released = await store.releaseTabLocks(7);
  assert.equal(released.released, 1);
  const other = await store.lock({ id: b.session.id, runId: 'run-c', tabId: 9 });
  assert.equal(other.locked, true, '另一个标签页的锁不应被误删');
  const first = await store.lock({ id: a.activeId, runId: 'run-d', tabId: 9 });
  assert.equal(first.ok, true);
});

test('lock: owner tab 已经关闭时，即使 onRemoved 还没清理也允许直接接手', async () => {
  const { store } = makeStore({
    options: {
      isTabAlive: async (tabId) => Number(tabId) !== 7,
    },
  });
  const boot = await store.bootstrap();
  await store.lock({ id: boot.activeId, runId: 'run-dead', tabId: 7 });
  const next = await store.lock({ id: boot.activeId, runId: 'run-new', tabId: 8 });
  assert.equal(next.ok, true);
  assert.equal(next.lock.previous, null, '死 tab 的锁不该被当成需要接管的活锁');
});

test('lock: TTL 到期后自动失效（标签页崩溃不会永久锁住会话）', async () => {
  let now = 1_000;
  const storage = memoryStorage();
  const store = new PanelSessionStore({
    storage,
    now: () => now,
    idFactory: (() => {
      let n = 0;
      return () => 'S-lock-' + ++n;
    })(),
    lockTtlMs: 5_000,
  });
  const boot = await store.bootstrap();
  await store.lock({ id: boot.activeId, runId: 'run-a', tabId: 1 });
  now += 5_001;
  const next = await store.lock({ id: boot.activeId, runId: 'run-b', tabId: 2 });
  assert.equal(next.ok, true);
});

test('prune: 超过上限时删除最旧会话正文，且不删当前会话', async () => {
  const { store, storage } = makeStore({ options: { maxSessions: 3 } });
  const boot = await store.bootstrap();
  const ids = [boot.activeId];
  for (let i = 0; i < 5; i++) {
    const created = await store.create({ title: '会话 ' + i, messages: [] });
    ids.push(created.session.id);
  }
  const state = await store.list();
  assert.equal(state.sessions.length, 3);
  const activeKey = panelSessionKey(state.activeId);
  assert.ok(storage.data[activeKey]);
  const removed = ids.filter((id) => !storage.data[panelSessionKey(id)]);
  assert.ok(removed.length >= 3, '最旧会话正文应被清理');
});

test('并发创建被串行化：不会因为同时读旧索引而丢会话', async () => {
  const { store } = makeStore();
  await store.bootstrap();
  await Promise.all([
    store.create({ title: 'A' }),
    store.create({ title: 'B' }),
    store.create({ title: 'C' }),
  ]);
  const state = await store.list();
  assert.equal(state.sessions.length, 4);
  assert.deepEqual(
    state.sessions.map((s) => s.title).sort(),
    ['A', 'B', 'C', '新会话']
  );
});

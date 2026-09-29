// session-store：分 key 存储、索引缓存、迁移与「读不回写」语义的守护测试。
// 关键性能性质：保存会话 A 不得写会话 B 的 key（此前每次 persist 都回写整张会话表）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  saveAgentSession,
  loadAgentSession,
  removeAgentSession,
  listAgentSessions,
  __resetSessionCache,
  SESSION_KEY,
  SESSION_PREFIX,
  INDEX_KEY,
  MAX_SESSIONS,
} from '../lib/assistant/session-store.js';

// 安装 chrome.storage.session 桩，支持 get(单个/数组/null) / set / remove，并统计读写。
function installStorage(initial = {}) {
  const store = { ...initial };
  const stats = { get: 0, set: 0, remove: 0, setKeys: [] };
  globalThis.chrome = {
    storage: {
      session: {
        async get(key) {
          stats.get += 1;
          if (key === null || key === undefined) return { ...store };
          if (Array.isArray(key)) {
            const o = {};
            for (const k of key) if (Object.prototype.hasOwnProperty.call(store, k)) o[k] = store[k];
            return o;
          }
          return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
        },
        async set(obj) {
          stats.set += 1;
          stats.setKeys.push(Object.keys(obj));
          Object.assign(store, obj);
        },
        async remove(key) {
          stats.remove += 1;
          if (Array.isArray(key)) for (const k of key) delete store[k];
          else delete store[key];
        },
      },
    },
  };
  __resetSessionCache();
  return { store, stats };
}

test('saveAgentSession + loadAgentSession: 往返保留字段', async () => {
  installStorage({});
  await saveAgentSession({ id: 'r1', status: 'planning', instruction: '打开页面', toolCallCount: 3 });
  const got = await loadAgentSession('r1');
  assert.equal(got.id, 'r1');
  assert.equal(got.status, 'planning');
  assert.equal(got.instruction, '打开页面');
  assert.equal(got.toolCallCount, 3);
  assert.ok(got.updatedAt > 0);
});

test('saveAgentSession: 会话写入独立 key，不触碰其它会话的 key', async () => {
  const { store, stats } = installStorage({
    [INDEX_KEY]: { b: { updatedAt: Date.now() } },
    [SESSION_PREFIX + 'b']: { id: 'b', status: 'created' },
  });
  await saveAgentSession({ id: 'a', status: 'created' });
  const lastSet = stats.setKeys[stats.setKeys.length - 1];
  assert.ok(lastSet.includes(SESSION_PREFIX + 'a'), JSON.stringify(lastSet));
  assert.ok(!lastSet.includes(SESSION_PREFIX + 'b'), '不应回写其它会话内容');
  assert.equal(store[SESSION_PREFIX + 'b'].id, 'b');
});

test('loadAgentSession: 无过期项时不回写存储（关键性能性质）', async () => {
  const { stats } = installStorage({
    [INDEX_KEY]: { s1: { updatedAt: Date.now() } },
    [SESSION_PREFIX + 's1']: { id: 's1', status: 'created' },
  });
  const got = await loadAgentSession('s1');
  assert.equal(got.id, 's1');
  assert.equal(stats.set, 0, '读路径不应写入');
});

test('loadAgentSession: 第二次读取命中缓存，不再访问存储', async () => {
  const { stats } = installStorage({
    [INDEX_KEY]: { s1: { updatedAt: Date.now() } },
    [SESSION_PREFIX + 's1']: { id: 's1', status: 'created' },
  });
  await loadAgentSession('s1');
  const before = stats.get;
  await loadAgentSession('s1');
  assert.equal(stats.get, before, '缓存命中不应再读存储');
});

test('saveAgentSession: 第二次保存复用索引缓存，不再重复读存储', async () => {
  const { stats } = installStorage({});
  await saveAgentSession({ id: 'a', status: 'created' });
  const getAfterFirst = stats.get;
  await saveAgentSession({ id: 'b', status: 'created' });
  assert.equal(stats.get, getAfterFirst, '只应在首次访问时读索引');
  assert.equal(stats.set, 2, '每次保存仍应写一次');
});

test('saveAgentSession: 同一 id 再次保存会更新而非新增', async () => {
  const { store, stats } = installStorage({});
  await saveAgentSession({ id: 'x', status: 'created', toolCallCount: 1 });
  await saveAgentSession({ id: 'x', status: 'observing', toolCallCount: 7 });
  const index = store[INDEX_KEY];
  assert.equal(Object.keys(index).length, 1);
  assert.equal(store[SESSION_PREFIX + 'x'].status, 'observing');
  assert.equal(store[SESSION_PREFIX + 'x'].toolCallCount, 7);
  assert.equal(stats.remove, 0, '更新同一会话不应删除任何 key');
});

test('prune: 超过上限时只保留最近 8 个会话', async () => {
  const initial = { [INDEX_KEY]: {} };
  for (let i = 0; i < 12; i++) {
    initial[INDEX_KEY]['s' + i] = { updatedAt: Date.now() - i * 1000 };
    initial[SESSION_PREFIX + 's' + i] = { id: 's' + i, status: 'created' };
  }
  installStorage(initial);
  const list = await listAgentSessions();
  assert.equal(list.length, MAX_SESSIONS);
  assert.ok(list.some((s) => s.id === 's0'));
  assert.ok(!list.some((s) => s.id === 's11'));
});

test('prune: 淘汰会话时清理其内容 key', async () => {
  const initial = { [INDEX_KEY]: {} };
  for (let i = 0; i < 12; i++) {
    initial[INDEX_KEY]['s' + i] = { updatedAt: Date.now() - i * 1000 };
    initial[SESSION_PREFIX + 's' + i] = { id: 's' + i, status: 'created' };
  }
  const { store } = installStorage(initial);
  await listAgentSessions();
  assert.ok(!store[SESSION_PREFIX + 's11'], '被淘汰会话的内容 key 应被删除');
  assert.ok(store[SESSION_PREFIX + 's0']);
});

test('removeAgentSession: 删除后读不到，且其余会话不受影响', async () => {
  const { stats } = installStorage({});
  await saveAgentSession({ id: 'keep', status: 'created' });
  await saveAgentSession({ id: 'drop', status: 'created' });
  stats.set = 0;
  await removeAgentSession('drop');
  assert.equal(stats.set, 1, '删除应写一次索引');
  assert.equal(await loadAgentSession('drop'), null);
  assert.equal((await loadAgentSession('keep')).id, 'keep');
});

test('removeAgentSession: 不存在的 id 不触发写入', async () => {
  const { stats } = installStorage({ [INDEX_KEY]: { s1: { updatedAt: Date.now() } } });
  await removeAgentSession('nope');
  assert.equal(stats.set, 0);
});

test('loadAgentSession: 空 id 直接返回 null 且不读存储', async () => {
  const { stats } = installStorage({});
  assert.equal(await loadAgentSession(''), null);
  assert.equal(await loadAgentSession(null), null);
  assert.equal(stats.get, 0);
});

test('saveAgentSession: 缺少 id 的会话被忽略', async () => {
  const { stats } = installStorage({});
  await saveAgentSession({ status: 'created' });
  await saveAgentSession(null);
  assert.equal(stats.set, 0);
  assert.equal(stats.get, 0);
});

test('迁移：旧整表拆到新 key 后可读，且旧 key 被删除', async () => {
  const { store } = installStorage({
    [SESSION_KEY]: {
      r1: { id: 'r1', status: 'planning', instruction: '打开页面', toolCallCount: 3, updatedAt: Date.now() },
    },
  });
  const got = await loadAgentSession('r1');
  assert.equal(got.instruction, '打开页面');
  assert.equal(got.toolCallCount, 3);
  assert.ok(store[SESSION_PREFIX + 'r1'], '应写入新 key');
  assert.equal(store[SESSION_KEY], undefined, '迁移后旧 key 应被删除');
});

test('迁移：幂等且不覆盖已有索引', async () => {
  const now = Date.now();
  const { store } = installStorage({
    [INDEX_KEY]: { a: { updatedAt: now } },
    [SESSION_PREFIX + 'a']: { id: 'a', status: 'created' },
    [SESSION_KEY]: { b: { id: 'b', status: 'created', updatedAt: now - 1000 } },
  });
  // 首次访问触发迁移（合并 legacy 的 b）
  assert.equal((await loadAgentSession('a')).id, 'a');
  assert.equal((await loadAgentSession('b')).id, 'b');
  assert.ok(store[SESSION_PREFIX + 'a'] && store[SESSION_PREFIX + 'b']);
  assert.equal(store[SESSION_KEY], undefined);
});

test('迁移：缺失 updatedAt 的旧会话也会被保留（不被误判过期）', async () => {
  installStorage({ [SESSION_KEY]: { old: { id: 'old', status: 'created' } } });
  const got = await loadAgentSession('old');
  assert.ok(got, '迁移时为缺失 updatedAt 的会话兜底，避免被当作过期删除');
  assert.equal(got.id, 'old');
});

test('存储不可用时安全降级（不抛错）', async () => {
  globalThis.chrome = undefined;
  __resetSessionCache();
  await saveAgentSession({ id: 'noarea', status: 'created' });
  const got = await loadAgentSession('noarea');
  assert.equal(got.id, 'noarea');
});

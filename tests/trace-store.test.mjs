// trace-store：分 key 存储 + 迁移。关键性质：追加轨迹只写当前 run 的 key。
import test from 'node:test';
import assert from 'node:assert/strict';

import { appendTrace, getTrace, listTraces, clearTrace, __resetTraceCache, TRACE_PREFIX, TRACE_INDEX_KEY, TRACE_KEY } from '../lib/assistant/trace.js';

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
  __resetTraceCache();
  return { store, stats };
}

test('appendTrace: 只写当前 run 的 key，不触碰其它 run', async () => {
  const { stats } = installStorage({
    [TRACE_INDEX_KEY]: { other: { updatedAt: Date.now() } },
    [TRACE_PREFIX + 'other']: { runId: 'other', entries: [], updatedAt: Date.now() },
  });
  await clearTrace(); // 重置模块内索引缓存，避免跨用例串扰（会清空上面的 other，符合预期）
  await appendTrace('r1', { kind: 'step' });
  const lastSet = stats.setKeys[stats.setKeys.length - 1];
  assert.ok(lastSet.includes(TRACE_PREFIX + 'r1'), JSON.stringify(lastSet));
  assert.ok(!lastSet.includes(TRACE_PREFIX + 'other'), '不应回写其它 run');
});

test('appendTrace + getTrace: 往返保留条目', async () => {
  installStorage({});
  await clearTrace();
  await appendTrace('r2', { kind: 'tool', name: 'click_element' });
  await appendTrace('r2', { kind: 'tool', name: 'type_text' });
  const rec = await getTrace('r2');
  assert.equal(rec.runId, 'r2');
  assert.equal(rec.entries.length, 2);
  assert.equal(rec.entries[1].name, 'type_text');
  assert.ok(rec.entries[1].ts > 0);
});

test('getTrace: 不存在的 run 返回 null', async () => {
  installStorage({});
  await clearTrace();
  assert.equal(await getTrace('nope'), null);
});

test('listTraces: 返回所有 run 并按最近排序', async () => {
  installStorage({});
  await clearTrace();
  await appendTrace('a', { kind: 'x' });
  await new Promise((r) => setTimeout(r, 5));
  await appendTrace('b', { kind: 'x' });
  const list = await listTraces();
  assert.equal(list.length, 2);
  assert.equal(list[0].runId, 'b');
});

test('clearTrace: 单个 run 与全部清除', async () => {
  installStorage({});
  await clearTrace();
  await appendTrace('a', { kind: 'x' });
  await appendTrace('b', { kind: 'x' });
  await clearTrace('a');
  assert.equal(await getTrace('a'), null);
  assert.ok(await getTrace('b'));
  await clearTrace();
  assert.equal((await listTraces()).length, 0);
});

test('迁移：旧整表拆到新 key 后可读，旧 key 删除', async () => {
  const now = Date.now();
  const { store } = installStorage({
    [TRACE_KEY]: { old: { runId: 'old', startedAt: now, entries: [{ ts: now, kind: 'legacy' }], updatedAt: now } },
  });
  await clearTrace('nothing'); // 触发 loadIndex → 迁移
  const rec = await getTrace('old');
  assert.ok(rec);
  assert.equal(rec.entries[0].kind, 'legacy');
  assert.ok(store[TRACE_PREFIX + 'old']);
  assert.equal(store[TRACE_KEY], undefined);
});

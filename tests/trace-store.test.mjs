// trace-store：分 key 存储 + 迁移 + 批量落盘。
// 关键性质：① 追加只写当前 run 的 key ② 写入被合并，但读取前一定会先落盘
// ③ 清除会同时丢弃待写队列，不会被一个晚到的 flush 复活。
import test from 'node:test';
import assert from 'node:assert/strict';

import { appendTrace, flushTraces, getTrace, listTraces, clearTrace, __resetTraceCache, TRACE_PREFIX, TRACE_INDEX_KEY, TRACE_KEY } from '../lib/assistant/trace.js';

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
  await flushTraces('r1'); // 写入被缓冲，落盘后才有 set 可查
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

// ---------------------------------------------------------------- 批量落盘（本次改动的核心）

test('批量落盘：40 条轨迹只产生个位数次写入（消除逐条 read-modify-write）', async () => {
  const { stats } = installStorage({});
  await clearTrace();
  const before = stats.set;
  for (let i = 0; i < 40; i++) await appendTrace('r', { kind: 'k', i });
  const writes = stats.set - before;
  assert.ok(writes <= 6, '40 条轨迹产生了 ' + writes + ' 次写入，批量没生效');
  assert.ok(writes >= 1, '总得写下去');
});

test('批量落盘：不丢条目，全部最终都能读到', async () => {
  installStorage({});
  await clearTrace();
  for (let i = 0; i < 40; i++) await appendTrace('r', { kind: 'k', i });
  const rec = await getTrace('r');
  assert.equal(rec.entries.length, 40);
  assert.deepEqual(rec.entries.map((e) => e.i), Array.from({ length: 40 }, (_, i) => i), '顺序必须保持');
});

test('getTrace 会先落盘：刚追加、还没到 flush 时机的条目也能读到', async () => {
  installStorage({});
  await clearTrace();
  await appendTrace('r', { kind: 'first' });
  await appendTrace('r', { kind: 'second' }); // 只有 2 条，不会触发阈值，定时器也还没到
  const rec = await getTrace('r');
  assert.equal(rec.entries.length, 2, '读取路径没有先落盘，会读到缺尾的轨迹');
  assert.equal(rec.entries[1].kind, 'second');
});

test('listTraces 会先落盘', async () => {
  installStorage({});
  await clearTrace();
  await appendTrace('r', { kind: 'x' });
  const list = await listTraces();
  assert.equal(list.length, 1);
  assert.equal(list[0].entries.length, 1);
});

test('攒够阈值立即落盘（不必等定时器）', async () => {
  const { stats } = installStorage({});
  await clearTrace();
  const before = stats.set;
  for (let i = 0; i < 8; i++) await appendTrace('r', { kind: 'k', i });
  assert.ok(stats.set > before, '达到阈值就应该写下去了');
});

test('静默窗口到点自动落盘', async () => {
  const { stats } = installStorage({});
  await clearTrace();
  await appendTrace('r', { kind: 'only-one' }); // 1 条，不到阈值
  const before = stats.set;
  await new Promise((r) => setTimeout(r, 400)); // 等过 FLUSH_DELAY_MS
  assert.ok(stats.set > before, '定时器没有把缓冲写下去');
  __resetTraceCache();
});

test('clearTrace 会丢弃待写队列：晚到的 flush 不能把清掉的轨迹复活', async () => {
  const { store } = installStorage({});
  await clearTrace();
  await appendTrace('r', { kind: 'x' }); // 仍在缓冲里
  await clearTrace('r');
  await flushTraces('r'); // 模拟那次晚到的 flush
  assert.equal(store[TRACE_PREFIX + 'r'], undefined, '被清掉的轨迹不该重新出现');
  assert.equal(await getTrace('r'), null);
});

test('clearTrace() 全部清除时同样丢弃所有待写队列', async () => {
  const { store } = installStorage({});
  await clearTrace();
  await appendTrace('a', { kind: 'x' });
  await appendTrace('b', { kind: 'x' });
  await clearTrace();
  await flushTraces();
  assert.equal(store[TRACE_PREFIX + 'a'], undefined);
  assert.equal(store[TRACE_PREFIX + 'b'], undefined);
});

test('__resetTraceCache 会清掉待写队列，避免跨用例漏进下一个 storage', async () => {
  const first = installStorage({});
  await clearTrace();
  await appendTrace('stale', { kind: 'x' }); // 只进缓冲
  // 换一个全新的 storage（模拟下一个用例），旧队列若还在就会漏写进来
  const second = installStorage({});
  await clearTrace();
  await flushTraces();
  assert.equal(second.store[TRACE_PREFIX + 'stale'], undefined, '上一个用例的待写条目漏进了新 storage');
  assert.equal(first.store[TRACE_PREFIX + 'stale'], undefined);
});

test('并发 flush 被串行化，不会互相覆盖丢条目', async () => {
  installStorage({});
  await clearTrace();
  for (let i = 0; i < 20; i++) await appendTrace('r', { kind: 'k', i });
  // 同时发两次 flush：没有串行化的话，后一次可能基于前一次写入之前的旧记录
  await Promise.all([flushTraces('r'), flushTraces('r')]);
  const rec = await getTrace('r');
  assert.equal(rec.entries.length, 20);
});

test('updatedAt 取最后一条条目的时间，而不是写入时刻（否则 listTraces 排序会并列）', async () => {
  installStorage({});
  await clearTrace();
  await appendTrace('a', { kind: 'x' });
  await new Promise((r) => setTimeout(r, 12));
  await appendTrace('b', { kind: 'x' });
  // 两条都在缓冲里，一次 flush 会同时写下；若用 Date.now() 作 updatedAt 就会并列
  await flushTraces();
  const list = await listTraces();
  assert.equal(list[0].runId, 'b', '最近追加的应排在最前，实际 ' + list.map((r) => r.runId).join(','));
  assert.ok(list[0].updatedAt > list[1].updatedAt, '两个 run 的 updatedAt 不应并列');
});

test('appendTrace 对空 runId 是安全的空操作', async () => {
  const { stats } = installStorage({});
  await clearTrace();
  const before = stats.set;
  await appendTrace('', { kind: 'x' });
  await appendTrace(null, { kind: 'x' });
  await flushTraces();
  assert.equal(stats.set, before);
});

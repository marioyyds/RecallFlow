// 结构化运行轨迹（run trace）：记录每个 run 的步骤、工具、耗时、token、错误，
// 存 chrome.storage.session（仅本地、不跨设备），用于排障与回放。
//
// 性能说明（重要）：此前所有 run 共用一个 key，每次 appendTrace 都要「读整表 + 写整表」，
// 与 Agent 的 session persist 叠加造成 I/O 放大。先改为「每 run 一个 key」+ 轻量索引，
// 追加时只写当前 run。
//
// 之后又发现第二层放大：**每一条**轨迹都仍然是一次「读 run + 写 run + 写索引」。
// 而一轮里至少有 cache / turn-timing 两条，加上每工具一条、验证、折叠等，
// 30 轮就是上百次 storage 往返 —— 而 storage 写入本身是跨进程的异步操作。
// 现在改为**内存累积 + 批量落盘**：攒够 FLUSH_EVERY 条或静默 FLUSH_DELAY_MS 后写一次，
// 读取路径（getTrace / listTraces）会先落盘再读，因此不会读到缺尾的轨迹。
//
// 已知取舍：service worker 若在延迟窗口内被回收，最多丢最后 FLUSH_EVERY-1 条轨迹。
// 这是刻意的 —— 轨迹是排障用的旁路数据，不值得为它把每条记录都同步写穿存储。
//
// key 结构：
//   recallflow.runTrace.v1.<runId>    单 run 轨迹 { runId, startedAt, entries, updatedAt }
//   recallflow.runTraceIndex.v1       { [runId]: { updatedAt } }
const TRACE_PREFIX = 'recallflow.runTrace.v1.';
const TRACE_INDEX_KEY = 'recallflow.runTraceIndex.v1';
const LEGACY_KEY = 'recallflow.runTraces.v1';
const KEY = LEGACY_KEY;

const MAX_RUNS = 8;
const MAX_ENTRIES = 300;
// 攒够这么多条就立刻落盘（不等定时器）—— 免得短任务永远等不到 flush
const FLUSH_EVERY = 8;
// 静默窗口：到点就把这些条目写一次
const FLUSH_DELAY_MS = 250;

function area() {
  if (typeof chrome === 'undefined' || !chrome.storage) return null;
  return chrome.storage.session || chrome.storage.local;
}

let indexCache = null; // { [runId]: { updatedAt } }

function pruneIndex(index, now = Date.now()) {
  const entries = Object.entries(index || {})
    .sort((a, b) => Number((b[1] && b[1].updatedAt) || 0) - Number((a[1] && a[1].updatedAt) || 0))
    .slice(0, MAX_RUNS);
  return Object.fromEntries(entries);
}

async function migrateLegacy(table) {
  const a = area();
  const merged = Object.assign({}, indexCache || {});
  const writes = {};
  for (const [runId, rec] of Object.entries(table || {})) {
    if (!runId || !rec || typeof rec !== 'object') continue;
    writes[TRACE_PREFIX + runId] = rec;
    if (!merged[runId]) merged[runId] = { updatedAt: Number(rec.updatedAt || rec.startedAt || Date.now()) };
  }
  indexCache = pruneIndex(merged);
  if (a && Object.keys(writes).length) {
    try { await a.set(Object.assign(writes, { [TRACE_INDEX_KEY]: indexCache })); } catch (e) {}
  }
  if (a) {
    try { await a.remove(LEGACY_KEY); } catch (e) {}
  }
}

async function loadIndex() {
  if (indexCache) return indexCache;
  const a = area();
  if (!a) {
    indexCache = {};
    return indexCache;
  }
  let idx = null;
  try { const d = await a.get(TRACE_INDEX_KEY); idx = d && d[TRACE_INDEX_KEY]; } catch (e) { idx = null; }
  if (idx && typeof idx === 'object') indexCache = idx;
  let legacy = null;
  try { const d = await a.get(LEGACY_KEY); legacy = d && d[LEGACY_KEY]; } catch (e) { legacy = null; }
  if (legacy && typeof legacy === 'object') await migrateLegacy(legacy);
  else if (!indexCache) indexCache = {};
  return indexCache;
}

async function readRun(runId) {
  const a = area();
  if (!a) return null;
  try {
    const d = await a.get(TRACE_PREFIX + runId);
    return d && d[TRACE_PREFIX + runId];
  } catch (e) {
    return null;
  }
}

async function writeRun(runId, rec) {
  const a = area();
  if (!a) return;
  try {
    await a.set({ [TRACE_PREFIX + runId]: rec, [TRACE_INDEX_KEY]: indexCache });
  } catch (e) {}
}

// ---- 批量落盘：待写条目 / 定时器 / 串行化链 ----
// 每个 run 各自一条链：两次 flush 并发时，后一次可能基于前一次写入**之前**读到的旧记录，
// 把中间那批条目覆盖掉。串行化是这里唯一的正确性要求。
const pendingEntries = new Map(); // runId -> entry[]
const flushTimers = new Map(); // runId -> timeout handle
const flushChains = new Map(); // runId -> Promise

function cancelPending(runId) {
  const t = flushTimers.get(runId);
  if (t) {
    try {
      clearTimeout(t);
    } catch (e) {}
    flushTimers.delete(runId);
  }
  pendingEntries.delete(runId);
}

function scheduleFlush(runId) {
  if (flushTimers.has(runId)) return;
  const handle = setTimeout(() => {
    flushTimers.delete(runId);
    // 定时器回调里不 await：这里没有调用方可以接住失败
    flushTraces(runId).catch(() => {});
  }, FLUSH_DELAY_MS);
  flushTimers.set(runId, handle);
}

/** 把某个 run 的待写条目真正写下去。取走缓冲后立刻清空，因此 flush 期间新到的条目落到下一批。 */
async function writePending(runId) {
  const entries = pendingEntries.get(runId);
  if (!entries || !entries.length) return;
  pendingEntries.set(runId, []);
  const rec = (await readRun(runId)) || { runId, startedAt: Date.now(), entries: [] };
  if (!Array.isArray(rec.entries)) rec.entries = [];
  for (const e of entries) rec.entries.push(e);
  if (rec.entries.length > MAX_ENTRIES) rec.entries = rec.entries.slice(-MAX_ENTRIES);
  // updatedAt 取**最后一条条目自己的 ts**，而不是写入时刻。
  // 批量落盘会让同一批里的多个 run（以及同一 run 的多条）拿到同一个 Date.now()，
  // 于是 listTraces 的「最近优先」排序会退化成并列 —— 用条目时间戳既更准确，
  // 也与「这条轨迹是什么时候产生的」语义一致。
  const newest = entries.reduce((mx, e) => Math.max(mx, Number(e && e.ts) || 0), 0);
  rec.updatedAt = Math.max(Number(rec.updatedAt) || 0, newest) || Date.now();
  indexCache = pruneIndex(Object.assign({}, indexCache, { [runId]: { updatedAt: rec.updatedAt } }));
  await writeRun(runId, rec);
}

/**
 * 立即把待写轨迹落盘。不传 runId 则处理所有 run。
 * 读取路径（getTrace / listTraces）会先调它，否则会读到缺了最后几条的轨迹。
 * @param {string} [runId]
 */
export async function flushTraces(runId) {
  await loadIndex();
  const ids = runId ? [runId] : Array.from(pendingEntries.keys());
  for (const id of ids) {
    const prev = flushChains.get(id) || Promise.resolve();
    const next = prev.then(() => writePending(id)).catch(() => {});
    flushChains.set(id, next);
    await next;
  }
}

// 追加一条轨迹事件。写入被缓冲，只写当前 run。
export async function appendTrace(runId, entry) {
  if (!runId) return;
  const buf = pendingEntries.get(runId) || [];
  buf.push(Object.assign({ ts: Date.now() }, entry));
  pendingEntries.set(runId, buf);
  if (buf.length >= FLUSH_EVERY) await flushTraces(runId);
  else scheduleFlush(runId);
}

export async function getTrace(runId) {
  if (!runId) return null;
  // 先落盘再读：否则刚发生的步骤（工具、错误、耗时）会缺席，
  // 而 get_run_trace 这个工具的用途恰恰是「看看刚刚发生了什么」。
  await flushTraces(runId);
  await loadIndex();
  if (!indexCache[runId]) return null;
  return readRun(runId);
}

export async function listTraces() {
  await flushTraces();
  await loadIndex();
  const ids = Object.keys(indexCache);
  if (!ids.length) return [];
  const out = [];
  for (const id of ids) {
    const rec = await readRun(id);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function clearTrace(runId) {
  await loadIndex();
  // 必须同时丢弃待写缓冲与定时器：否则清除之后，一个还在排队的 flush
  // 会把刚清掉的轨迹重新写回来。
  if (runId) cancelPending(runId);
  else for (const id of Array.from(pendingEntries.keys())) cancelPending(id);
  const a = area();
  if (runId) {
    delete indexCache[runId];
    if (a) { try { await a.remove(TRACE_PREFIX + runId); } catch (e) {} }
  } else {
    for (const id of Object.keys(indexCache)) {
      if (a) { try { await a.remove(TRACE_PREFIX + id); } catch (e) {} }
    }
    indexCache = {};
  }
  if (a) { try { await a.set({ [TRACE_INDEX_KEY]: indexCache }); } catch (e) {} }
}

export { KEY as TRACE_KEY, TRACE_PREFIX, TRACE_INDEX_KEY };

// 仅供测试/排障：清空内存索引缓存与待写队列，强制下次访问重新从存储读取。
// 必须一并清掉定时器与缓冲，否则上一个用例的待写条目会漏进下一个用例的 storage。
export function __resetTraceCache() {
  indexCache = null;
  for (const id of Array.from(pendingEntries.keys())) cancelPending(id);
  pendingEntries.clear();
  flushTimers.clear();
  flushChains.clear();
}

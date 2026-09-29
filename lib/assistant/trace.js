// 结构化运行轨迹（run trace）：记录每个 run 的步骤、工具、耗时、token、错误，
// 存 chrome.storage.session（仅本地、不跨设备），用于排障与回放。
//
// 性能说明（重要）：此前所有 run 共用一个 key，每次 appendTrace 都要「读整表 + 写整表」，
// 与 Agent 的 session persist 叠加造成 I/O 放大。现改为「每 run 一个 key」+ 轻量索引，
// 追加时只写当前 run。旧格式在首次访问时自动迁移。
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

// 追加一条轨迹事件。只写当前 run。
export async function appendTrace(runId, entry) {
  if (!runId) return;
  await loadIndex();
  const rec = (await readRun(runId)) || { runId, startedAt: Date.now(), entries: [] };
  if (!Array.isArray(rec.entries)) rec.entries = [];
  rec.entries.push(Object.assign({ ts: Date.now() }, entry));
  if (rec.entries.length > MAX_ENTRIES) rec.entries = rec.entries.slice(-MAX_ENTRIES);
  rec.updatedAt = Date.now();
  const nextIndex = pruneIndex(Object.assign({}, indexCache, { [runId]: { updatedAt: rec.updatedAt } }));
  indexCache = nextIndex;
  await writeRun(runId, rec);
}

export async function getTrace(runId) {
  if (!runId) return null;
  await loadIndex();
  if (!indexCache[runId]) return null;
  return readRun(runId);
}

export async function listTraces() {
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

// 仅供测试/排障：清空内存索引缓存，强制下次访问重新从存储读取。
export function __resetTraceCache() {
  indexCache = null;
}

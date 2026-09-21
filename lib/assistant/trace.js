// 结构化运行轨迹（run trace）：记录每个 run 的步骤、工具、耗时、token、错误，
// 存 chrome.storage.session（仅本地、不跨设备），用于排障与回放。
const KEY = 'recallflow.runTraces.v1';
const MAX_RUNS = 8;
const MAX_ENTRIES = 300;

function area() {
  if (typeof chrome === 'undefined' || !chrome.storage) return null;
  return chrome.storage.session || chrome.storage.local;
}

async function readAll() {
  const a = area();
  if (!a) return {};
  try {
    const d = await a.get(KEY);
    const m = d && d[KEY];
    return m && typeof m === 'object' ? m : {};
  } catch (e) {
    return {};
  }
}

async function writeAll(all) {
  const a = area();
  if (!a) return;
  try {
    await a.set({ [KEY]: all });
  } catch (e) {}
}

function prune(all) {
  const entries = Object.entries(all)
    .sort((a, b) => Number((b[1] && b[1].updatedAt) || 0) - Number((a[1] && a[1].updatedAt) || 0))
    .slice(0, MAX_RUNS);
  return Object.fromEntries(entries);
}

// 追加一条轨迹事件。
export async function appendTrace(runId, entry) {
  if (!runId) return;
  const all = await readAll();
  const rec = all[runId] || { runId, startedAt: Date.now(), entries: [] };
  rec.entries.push(Object.assign({ ts: Date.now() }, entry));
  if (rec.entries.length > MAX_ENTRIES) rec.entries = rec.entries.slice(-MAX_ENTRIES);
  rec.updatedAt = Date.now();
  all[runId] = rec;
  await writeAll(prune(all));
}

export async function getTrace(runId) {
  const all = await readAll();
  return (runId && all[runId]) || null;
}

export async function listTraces() {
  const all = await readAll();
  return Object.values(all).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function clearTrace(runId) {
  const all = await readAll();
  if (runId) delete all[runId];
  else for (const k of Object.keys(all)) delete all[k];
  await writeAll(all);
}

export { KEY as TRACE_KEY };

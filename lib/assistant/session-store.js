// Agent Session 持久化：优先使用 MV3 的 chrome.storage.session。
// 该区域不会同步到云端，适合保存恢复 Agent 所需的临时上下文。
//
// 性能说明（重要）：
// 1) Agent 主循环在**每次工具调用后**都会 persist 一次。此前所有会话共用一个 key，
//    每次 persist 都要 get + set 整张会话表（8 个会话，单会话最多 40 条 × 12KB），
//    长任务是严重的 I/O 放大。现在改为「每会话一个 key」：只写当前会话 + 一个轻量索引。
// 2) 首次读一次、之后只写：Service Worker 是这些数据的唯一写入者，索引与会话内容各缓存一份，
//    SW 被回收后缓存自然失效并重新从存储读取，不会出现缓存与存储不一致。
//
// key 结构：
//   recallflow.agentSession.v1.<id>    单会话内容
//   recallflow.agentSessionIndex.v1    { [id]: { updatedAt, status } } 轻量索引
// 旧格式（单个大 key）在首次访问时自动迁移，迁移成功后删除旧 key。

const SESSION_PREFIX = 'recallflow.agentSession.v1.';
const INDEX_KEY = 'recallflow.agentSessionIndex.v1';
// 旧格式：所有会话挤在一个 key 里（迁移后删除）。保留导出供测试与迁移识别。
const LEGACY_KEY = 'recallflow.agentSessions.v1';
const SESSION_KEY = LEGACY_KEY;

const MAX_SESSIONS = 8;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function storageArea() {
  if (typeof chrome === 'undefined' || !chrome.storage) return null;
  return chrome.storage.session || chrome.storage.local;
}

// 索引内存缓存；null 表示尚未从存储加载。会话内容缓存：id -> session。
let indexCache = null;
const bodyCache = new Map();

// 清理过期与会话数量上限；返回新索引对象，不修改入参。
function pruneIndex(index, now = Date.now()) {
  const entries = Object.entries(index || {})
    .filter(([, meta]) => meta && now - Number(meta.updatedAt || 0) < SESSION_TTL_MS)
    .sort((a, b) => Number((b[1] && b[1].updatedAt) || 0) - Number((a[1] && a[1].updatedAt) || 0))
    .slice(0, MAX_SESSIONS);
  return Object.fromEntries(entries);
}

async function writeIndex(index) {
  const area = storageArea();
  if (!area) return;
  try {
    await area.set({ [INDEX_KEY]: index });
  } catch (e) {}
}

// 删除索引中已不存在的会话内容 key（prune 后清理存储）。
async function dropBodiesNotInIndex(index) {
  const area = storageArea();
  if (!area || typeof area.get !== 'function' || typeof area.remove !== 'function') return;
  let all = null;
  try {
    all = await area.get(null);
  } catch (e) {
    return;
  }
  if (!all || typeof all !== 'object') return;
  const stale = Object.keys(all).filter((k) => k.startsWith(SESSION_PREFIX) && !index[k.slice(SESSION_PREFIX.length)]);
  for (const k of stale) {
    bodyCache.delete(k.slice(SESSION_PREFIX.length));
    try { await area.remove(k); } catch (e) {}
  }
}

// 迁移旧格式：把整表里的每个会话拆写到新 key，合并进索引，最后删除旧 key。
async function migrateLegacy(table) {
  const area = storageArea();
  const merged = Object.assign({}, indexCache || {});
  const writes = {};
  for (const [id, session] of Object.entries(table || {})) {
    if (!id || !session || typeof session !== 'object') continue;
    const updatedAt = Number(session.updatedAt || session.createdAt || Date.now());
    const body = Object.assign({}, session, { id: session.id || id, updatedAt });
    writes[SESSION_PREFIX + id] = body;
    bodyCache.set(id, body);
    if (!merged[id]) merged[id] = { updatedAt, status: session.status || '' };
  }
  indexCache = pruneIndex(merged);
  if (area && Object.keys(writes).length) {
    try { await area.set(Object.assign(writes, { [INDEX_KEY]: indexCache })); } catch (e) {}
  }
  if (area) {
    try { await area.remove(LEGACY_KEY); } catch (e) {}
  }
}

// 加载索引；首次访问时若发现旧格式则做一次迁移（幂等）。
async function loadIndex() {
  if (indexCache) return indexCache;
  const area = storageArea();
  if (!area) {
    indexCache = {};
    return indexCache;
  }
  let idx = null;
  try {
    const d = await area.get(INDEX_KEY);
    idx = d && d[INDEX_KEY];
  } catch (e) {
    idx = null;
  }
  if (idx && typeof idx === 'object') indexCache = idx;
  // 旧格式迁移：索引缺失或旧 key 仍存在时都尝试（迁移函数会合并，不丢新数据）。
  let legacy = null;
  try {
    const d = await area.get(LEGACY_KEY);
    legacy = d && d[LEGACY_KEY];
  } catch (e) {
    legacy = null;
  }
  if (legacy && typeof legacy === 'object') {
    await migrateLegacy(legacy);
  } else if (!indexCache) {
    indexCache = {};
  }
  return indexCache;
}

// 按索引裁剪，并清理被淘汰会话的内容 key。
async function applyPrune() {
  await loadIndex();
  const pruned = pruneIndex(indexCache);
  const changed = Object.keys(pruned).length !== Object.keys(indexCache).length;
  indexCache = pruned;
  if (changed) {
    await writeIndex(indexCache);
    await dropBodiesNotInIndex(indexCache);
  }
  return indexCache;
}

export async function saveAgentSession(session) {
  if (!session || !session.id) return;
  const area = storageArea();
  await loadIndex();
  const id = session.id;
  const updatedAt = Date.now();
  const body = Object.assign({}, session, { updatedAt });
  // 先按现有索引裁剪，再加入本次会话，保证不超过上限。
  const nextIndex = pruneIndex(Object.assign({}, indexCache, { [id]: { updatedAt, status: body.status || '' } }));
  const evicted = Object.keys(indexCache).some((k) => k !== id && !nextIndex[k]);
  indexCache = nextIndex;
  bodyCache.set(id, body);
  if (!area) return;
  try {
    await area.set({ [SESSION_PREFIX + id]: body, [INDEX_KEY]: indexCache });
  } catch (e) {}
  if (evicted) await dropBodiesNotInIndex(indexCache);
}

export async function loadAgentSession(id) {
  if (!id) return null;
  // 注意：读路径**不做**回写（此前每次读都要 set 一次，属无谓放大）。
  await applyPrune();
  if (!indexCache[id]) {
    bodyCache.delete(id);
    return null;
  }
  if (bodyCache.has(id)) return bodyCache.get(id);
  const area = storageArea();
  if (!area) return null;
  let body = null;
  try {
    const d = await area.get(SESSION_PREFIX + id);
    body = d && d[SESSION_PREFIX + id];
  } catch (e) {
    body = null;
  }
  if (body && typeof body === 'object') {
    bodyCache.set(id, body);
    return body;
  }
  return null;
}

export async function removeAgentSession(id) {
  if (!id) return;
  await loadIndex();
  if (!indexCache[id]) {
    bodyCache.delete(id);
    return;
  }
  delete indexCache[id];
  bodyCache.delete(id);
  indexCache = pruneIndex(indexCache);
  const area = storageArea();
  if (!area) return;
  try { await area.set({ [INDEX_KEY]: indexCache }); } catch (e) {}
  try { await area.remove(SESSION_PREFIX + id); } catch (e) {}
}

export async function listAgentSessions() {
  await applyPrune();
  const area = storageArea();
  if (!area) return Array.from(bodyCache.values());
  const ids = Object.keys(indexCache);
  if (!ids.length) return [];
  const keys = ids.map((id) => SESSION_PREFIX + id);
  let all = null;
  try { all = await area.get(keys); } catch (e) { all = null; }
  const out = [];
  for (const id of ids) {
    const k = SESSION_PREFIX + id;
    const body = bodyCache.get(id) || (all && all[k]);
    if (body && typeof body === 'object') {
      bodyCache.set(id, body);
      out.push(body);
    }
  }
  return out;
}

// 仅供测试/排障：清空内存缓存，强制下次访问重新从存储读取。
export function __resetSessionCache() {
  indexCache = null;
  bodyCache.clear();
}

export { SESSION_KEY, SESSION_PREFIX, INDEX_KEY, LEGACY_KEY, MAX_SESSIONS, SESSION_TTL_MS };

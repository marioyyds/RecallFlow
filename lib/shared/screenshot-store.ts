// 截图共享存储。
//
// 面板会话（PanelSessionStore）只保存截图的元数据（id / label / 尺寸 / 字节数），
// 图片本体按 id 单独落盘。这样：
//   · 会话正文不会被几百 KB 的 base64 撑大；
//   · 另一个标签页跟随同一会话、或切换到历史会话时，仍能按 id 取回图片；
//   · 图片有独立的保留上限，超过时只淘汰旧图，不破坏会话记录。
//
// 存储布局：
//   recallflow.shots.v1                   最近 MAX_SHOTS 张的归档（兼容旧版）
//   recallflow.shots.index.v1             截图 id -> { sessionId, createdAt, bytes }
//   recallflow.shots.item.v1.<shotId>     单张截图（含 dataUrl）
//
// 所有函数都注入 chromeApi，便于用假 storage 做单测。

export const SHOT_KEY = 'recallflow.shots.v1';
export const SHOT_INDEX_KEY = 'recallflow.shots.index.v1';
export const SHOT_ITEM_PREFIX = 'recallflow.shots.item.v1.';

/** 旧归档只保留最近几张（MCP 取回路径仍依赖它）。 */
export const MAX_SHOTS = 3;
/** 单个会话保留的截图数。 */
export const MAX_SHOTS_PER_SESSION = 20;
/** 全浏览器保留的截图总数（防止长期使用无限增长）。 */
export const MAX_SHOTS_TOTAL = 60;
/**
 * 单张截图允许落盘的最大字符数。
 *
 * 截图采集上限是 400,000 base64 字符（screenshot-tool 的 MAX_SHOT_B64），
 * 这里留出 data URL 前缀的余量，保证采集成功的图都能参与同步。
 */
export const MAX_SHOT_STORE_CHARS = 420000;

/** 一张截图的落盘形态（含 base64 dataUrl）。 */
export interface ScreenshotRecord {
  id: string;
  dataUrl?: string;
  label?: string;
  width?: number;
  height?: number;
  bytes?: number;
  sessionId?: string;
  createdAt?: number;
}

/** 索引项：只存元数据，图片本体按 id 单独落盘。 */
export interface ScreenshotIndexEntry {
  id: string;
  sessionId: string;
  createdAt: number;
  bytes: number;
}

/** 注入式 storage 形状：只要求用到的那三个方法，便于单测塞假实现。 */
export interface StorageAreaLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface ChromeApiLike {
  storage?: { local?: StorageAreaLike };
}

export function shotStorageKey(id: unknown): string {
  return SHOT_ITEM_PREFIX + String(id || '');
}

function localArea(chromeApi: ChromeApiLike | null | undefined): StorageAreaLike | null {
  return chromeApi && chromeApi.storage && chromeApi.storage.local ? chromeApi.storage.local : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 同一时刻可能有多个 Agent run 在截图；读改写索引必须串行，避免互相覆盖。
let writeTail: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeTail.then(fn, fn);
  writeTail = run.catch(() => {});
  return run;
}

function pruneIndex(index: Record<string, ScreenshotIndexEntry>): Record<string, ScreenshotIndexEntry> {
  const entries = Object.values(index)
    .filter((entry) => isRecord(entry) && entry.id)
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));

  // 先按会话保留最近的 MAX_SHOTS_PER_SESSION 张。
  const keep = new Set<string>();
  const bySession = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = String(entry.sessionId || '');
    if (!bySession.has(key)) bySession.set(key, []);
    (bySession.get(key) as typeof entries).push(entry);
  }
  for (const list of bySession.values()) {
    for (const entry of list.slice(-MAX_SHOTS_PER_SESSION)) keep.add(String(entry.id));
  }

  // 再按全局上限淘汰最旧的。
  const remaining = entries.filter((entry) => keep.has(String(entry.id)));
  const overflow = Math.max(0, remaining.length - MAX_SHOTS_TOTAL);
  for (let i = 0; i < overflow; i++) keep.delete(String(remaining[i].id));

  for (const id of Object.keys(index)) {
    if (!keep.has(String(id))) delete index[id];
  }
  return index;
}

/**
 * 落盘一张截图，并维护按会话/全局的保留上限。
 *
 * @param {object} chromeApi 注入 chrome
 * @param {object} shot { id, dataUrl, label?, width?, height?, bytes? }
 * @param {string} [sessionId] 所属面板会话；缺省时仍会落盘，只是无法按会话清理
 * @returns {Promise<boolean>} 是否真的写入成功
 */
export function saveScreenshot(
  chromeApi: ChromeApiLike | null | undefined,
  shot: ScreenshotRecord | null | undefined,
  sessionId = ''
): Promise<boolean> {
  const area = localArea(chromeApi);
  const id = String((shot && shot.id) || '');
  const dataUrl = String((shot && shot.dataUrl) || '');
  if (!area || !id || !dataUrl) return Promise.resolve(false);
  if (dataUrl.length > MAX_SHOT_STORE_CHARS) return Promise.resolve(false);

  return enqueueWrite(async () => {
    try {
      const cur = await area.get([SHOT_KEY, SHOT_INDEX_KEY]);
      const archive = (Array.isArray(cur && cur[SHOT_KEY]) ? (cur[SHOT_KEY] as ScreenshotRecord[]) : []);
      const index = (isRecord(cur && cur[SHOT_INDEX_KEY]) ? Object.assign({}, cur[SHOT_INDEX_KEY]) : {}) as Record<
        string,
        ScreenshotIndexEntry
      >;
      const record = Object.assign({}, shot, {
        id,
        sessionId: String(sessionId || (shot && shot.sessionId) || ''),
        createdAt: Number(shot && shot.createdAt) || Date.now(),
        bytes: Number(shot && shot.bytes) || Math.round((dataUrl.length * 3) / 4),
      });

      index[id] = {
        id,
        sessionId: record.sessionId,
        createdAt: record.createdAt,
        bytes: record.bytes,
      };
      pruneIndex(index);

      const nextArchive = archive
        .filter((entry) => entry && entry.id !== id)
        .concat([record])
        .slice(-MAX_SHOTS);
      await area.set({
        [SHOT_KEY]: nextArchive,
        [SHOT_INDEX_KEY]: index,
        [shotStorageKey(id)]: record,
      });

      const stale = Object.keys(cur && cur[SHOT_INDEX_KEY] || {})
        .filter((oldId) => !index[oldId])
        .map(shotStorageKey);
      if (stale.length && typeof area.remove === 'function') {
        try { await area.remove(stale); } catch (e) {}
      }
      return true;
    } catch (e) {
      return false;
    }
  });
}

/**
 * 按 id 取回截图。优先读独立 key；旧版只写 SHOT_KEY 的图也能回退取到。
 */
export async function loadScreenshot(
  chromeApi: ChromeApiLike | null | undefined,
  id: unknown
): Promise<ScreenshotRecord | null> {
  const area = localArea(chromeApi);
  const wanted = String(id || '');
  if (!area || !wanted) return null;
  const key = shotStorageKey(wanted);
  try {
    const cur = await area.get([key, SHOT_KEY]);
    const item = cur ? (cur[key] as ScreenshotRecord | undefined) : undefined;
    if (item && item.dataUrl) return item;
    const archive = (Array.isArray(cur && cur[SHOT_KEY]) ? (cur[SHOT_KEY] as ScreenshotRecord[]) : []);
    return archive.find((entry) => entry && String(entry.id) === wanted && entry.dataUrl) || null;
  } catch (e) {
    return null;
  }
}

/** 删除某个会话的所有截图（会话被用户删除时调用）。 */
export function removeSessionScreenshots(
  chromeApi: ChromeApiLike | null | undefined,
  sessionId: unknown
): Promise<boolean> {
  const area = localArea(chromeApi);
  const wanted = String(sessionId || '');
  if (!area || !wanted) return Promise.resolve(false);

  return enqueueWrite(async () => {
    try {
      const cur = await area.get([SHOT_INDEX_KEY, SHOT_KEY]);
      const index = (isRecord(cur && cur[SHOT_INDEX_KEY]) ? Object.assign({}, cur[SHOT_INDEX_KEY]) : {}) as Record<
        string,
        ScreenshotIndexEntry
      >;
      const ids = Object.keys(index).filter((id) => String((index[id] && index[id].sessionId) || '') === wanted);
      if (!ids.length) return true;
      for (const id of ids) delete index[id];
      const archive = (Array.isArray(cur && cur[SHOT_KEY]) ? (cur[SHOT_KEY] as ScreenshotRecord[]) : [])
        .filter((entry) => !entry || !ids.includes(String(entry.id)));
      await area.set({ [SHOT_INDEX_KEY]: index, [SHOT_KEY]: archive });
      if (typeof area.remove === 'function') await area.remove(ids.map(shotStorageKey));
      return true;
    } catch (e) {
      return false;
    }
  });
}

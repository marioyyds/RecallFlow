// 知识库存储：IndexedDB 主存储 + 从旧 chrome.storage.local 自动迁移。
//
// 数据分成两个 store：
//   · entries   —— 标题/标签/状态等元数据 + 纯文本摘要，列表与排序只读这一层
//   · documents —— Markdown 正文，阅读/编辑/知识库工具需要时才合并回来
// 旧接口 getBook/setBook 仍返回“整本书”，保证 RAG、助手工具和现有页面兼容。
import {
  STATUS,
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  DATA_VERSION_KEY,
  CURRENT_DATA_VERSION,
  OLD_STATUS_MIGRATION,
} from './constants.ts';
import { cleanTitle, markdownExcerpt } from './utils.ts';

const DB_NAME = 'recallflow-knowledge';
const DB_VERSION = 1;
const STORE_ENTRIES = 'entries';
const STORE_DOCUMENTS = 'documents';
const STORE_META = 'meta';
const MIGRATION_META_KEY = 'chrome-storage-v2';
const STORAGE_BACKUP_KEY = 'knowledgeBasePreIndexedDB';
const CHANGE_CHANNEL = 'recallflow-knowledge-change';

/**
 * 知识库条目（entries store 的 record）：列表/排序只读这一层，
 * 正文放在 documents store。字段全部来自用户输入或旧 storage 数据，
 * 因此入参侧一律按 unknown 收窄，落库前在这里定形。
 */
export interface KnowledgeItem {
  id: string;
  type: string;
  title: string;
  url: string;
  platform: string;
  platformName: string;
  status: number | string;
  note: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

/** 按条目 id 索引的知识库快照。 */
export type KnowledgeBook = Record<string, KnowledgeItem>;

let dbPromise: Promise<IDBDatabase> | null = null;
let migrationPromise: Promise<void> | null = null;

function requestResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
        const entries = db.createObjectStore(STORE_ENTRIES, { keyPath: 'id' });
        entries.createIndex('updatedAt', 'updatedAt');
        entries.createIndex('createdAt', 'createdAt');
        entries.createIndex('type', 'type');
        entries.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains(STORE_DOCUMENTS)) {
        db.createObjectStore(STORE_DOCUMENTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function normalizeBook(input: unknown): KnowledgeBook {
  const source = input && typeof input === 'object' ? (input as Record<string, any>) : {};
  const out: KnowledgeBook = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || key);
    if (!id) continue;
    const status = typeof raw.status === 'string'
      ? ((OLD_STATUS_MIGRATION as Record<string, number>)[String(raw.status)] || STATUS.IMPORTANT)
      : ([STATUS.GENERAL, STATUS.IMPORTANT, STATUS.FREQUENT].includes(raw.status) ? raw.status : STATUS.IMPORTANT);
    out[id] = {
      id,
      type: raw.type || 'wrong',
      title: cleanTitle(raw.title || '') || raw.title || raw.url || '未命名',
      url: raw.url || '',
      platform: raw.platform || '',
      platformName: raw.platformName || '',
      status,
      note: typeof raw.note === 'string' ? raw.note : '',
      tags: Array.isArray(raw.tags) ? raw.tags.slice() : [],
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  }
  return out;
}

function entryRecord(item: KnowledgeItem) {
  const note = String(item.note || '');
  return {
    id: item.id,
    type: item.type || 'wrong',
    title: item.title || '未命名',
    url: item.url || '',
    platform: item.platform || '',
    platformName: item.platformName || '',
    status: item.status,
    tags: Array.isArray(item.tags) ? item.tags.slice() : [],
    createdAt: Number(item.createdAt) || Date.now(),
    updatedAt: Number(item.updatedAt) || Date.now(),
    notePreview: markdownExcerpt(note, 180),
    noteChars: note.length,
  };
}

function documentRecord(item: KnowledgeItem) {
  return { id: item.id, markdown: String(item.note || '') };
}

type StoredEntry = {
  id: string;
  type: string;
  title: string;
  url: string;
  platform: string;
  platformName: string;
  status: number | string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  notePreview: string;
  noteChars: number;
};

function withNote(
  entry: StoredEntry | Record<string, any>,
  doc: { markdown?: unknown } | null | undefined
): KnowledgeItem {
  return Object.assign({}, entry, { note: String((doc && doc.markdown) || '') }) as KnowledgeItem;
}

async function readMigrationMeta(db: IDBDatabase) {
  try {
    const tx = db.transaction(STORE_META, 'readonly');
    return await requestResult(tx.objectStore(STORE_META).get(MIGRATION_META_KEY));
  } catch (e) {
    return null;
  }
}

async function migrateFromChromeStorage(): Promise<void> {
  const db = await openDb();
  if (await readMigrationMeta(db)) return;
  let stored: Record<string, any> = {};
  let book: Record<string, any> = {};
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      stored = (await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY, DATA_VERSION_KEY])) as Record<string, any>;
      book = stored[STORAGE_KEY];
      if (!book && stored[LEGACY_STORAGE_KEY]) {
        book = {};
        for (const [url, item] of Object.entries(stored[LEGACY_STORAGE_KEY] || {})) {
          book[url] = Object.assign({}, item, { id: url, type: 'wrong', tags: [] });
        }
      }
    }
  } catch (e) {
    stored = {};
  }
  const normalized = normalizeBook(book || {});
  const tx = db.transaction([STORE_ENTRIES, STORE_DOCUMENTS, STORE_META], 'readwrite');
  const entries = tx.objectStore(STORE_ENTRIES);
  const docs = tx.objectStore(STORE_DOCUMENTS);
  const existingKeys = await requestResult(entries.getAllKeys());
  const existing = new Set(existingKeys.map(String));
  for (const item of Object.values(normalized)) {
    // 多标签页可能同时触发迁移；已有记录不被旧快照覆盖。
    if (existing.has(String(item.id))) continue;
    entries.put(entryRecord(item));
    docs.put(documentRecord(item));
  }
  tx.objectStore(STORE_META).put({
    key: MIGRATION_META_KEY,
    done: true,
    migratedAt: Date.now(),
    schemaVersion: CURRENT_DATA_VERSION,
  });
  await transactionDone(tx);

  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      if (stored[STORAGE_KEY]) {
        await chrome.storage.local.set({ [STORAGE_BACKUP_KEY]: stored[STORAGE_KEY] });
      }
      await chrome.storage.local.remove([STORAGE_KEY, LEGACY_STORAGE_KEY]);
    }
  } catch (e) {}
}

async function ensureReady(): Promise<IDBDatabase> {
  if (!migrationPromise) migrationPromise = migrateFromChromeStorage();
  await migrationPromise;
  return openDb();
}

function notifyChange() {
  try {
    const channel = new BroadcastChannel(CHANGE_CHANNEL);
    channel.postMessage({ type: 'knowledge-changed', at: Date.now() });
    setTimeout(() => channel.close(), 0);
  } catch (e) {}
}

export function subscribeKnowledgeChanges(callback: (data: unknown) => void) {
  if (typeof callback !== 'function' || typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(CHANGE_CHANNEL);
  channel.onmessage = (event) => callback(event && event.data);
  return () => channel.close();
}

async function getBook(): Promise<KnowledgeBook> {
  const db = await ensureReady();
  const tx = db.transaction([STORE_ENTRIES, STORE_DOCUMENTS], 'readonly');
  const entryList = await requestResult(tx.objectStore(STORE_ENTRIES).getAll());
  const docList = await requestResult(tx.objectStore(STORE_DOCUMENTS).getAll());
  const docs = new Map<string, any>(docList.map((doc: any) => [String(doc.id), doc] as [string, any]));
  const book: KnowledgeBook = {};
  for (const entry of entryList) book[entry.id] = withNote(entry, docs.get(String(entry.id)));
  return book;
}

async function getRecentItems(limit: unknown = 5) {
  const db = await ensureReady();
  const max = Math.max(1, Number(limit) || 5);
  const tx = db.transaction(STORE_ENTRIES, 'readonly');
  const index = tx.objectStore(STORE_ENTRIES).index('updatedAt');
  const out: any[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = index.openCursor(null, 'prev');
    req.onerror = () => reject(req.error || new Error('IndexedDB cursor failed'));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= max) {
        resolve();
        return;
      }
      out.push(cursor.value);
      cursor.continue();
    };
  });
  return out;
}

async function getKnowledgeItem(id: unknown): Promise<KnowledgeItem | null> {
  const db = await ensureReady();
  const tx = db.transaction([STORE_ENTRIES, STORE_DOCUMENTS], 'readonly');
  const entry = await requestResult(tx.objectStore(STORE_ENTRIES).get(String(id)));
  if (!entry) return null;
  const doc = await requestResult(tx.objectStore(STORE_DOCUMENTS).get(String(id)));
  return withNote(entry, doc);
}

async function setBook(book: KnowledgeBook) {
  const db = await ensureReady();
  const normalized = normalizeBook(book || {});
  const tx = db.transaction([STORE_ENTRIES, STORE_DOCUMENTS], 'readwrite');
  const entries = tx.objectStore(STORE_ENTRIES);
  const docs = tx.objectStore(STORE_DOCUMENTS);
  const existingKeys = await requestResult(entries.getAllKeys());
  const wanted = new Set(Object.keys(normalized));
  for (const key of existingKeys) if (!wanted.has(String(key))) entries.delete(key);
  for (const item of Object.values(normalized)) {
    entries.put(entryRecord(item));
    docs.put(documentRecord(item));
  }
  await transactionDone(tx);
  notifyChange();
}

export interface KnowledgeUpsertInput {
  id: unknown;
  type?: unknown;
  title?: unknown;
  url?: unknown;
  platformId?: unknown;
  platformName?: unknown;
  status?: unknown;
  note?: unknown;
  tags?: unknown;
}

async function upsertItem({ id, type, title, url, platformId, platformName, status, note, tags }: KnowledgeUpsertInput): Promise<KnowledgeItem> {
  const db = await ensureReady();
  const key = String(id);
  const tx = db.transaction([STORE_ENTRIES, STORE_DOCUMENTS], 'readwrite');
  const entryStore = tx.objectStore(STORE_ENTRIES);
  const docStore = tx.objectStore(STORE_DOCUMENTS);
  const prevEntry = await requestResult(entryStore.get(key));
  const prevDoc = await requestResult(docStore.get(key));
  const now = Date.now();
  // ⚠ 这里的表达式与迁移前**逐字一致**，只在外面加类型断言（会被 esbuild 擦掉）：
  // 换成 String(...) 包装会改变非字符串入参的运行时结果，不属于「只加类型」的批次。
  const item: KnowledgeItem = {
    id: key,
    type: (type || (prevEntry && prevEntry.type) || 'wrong') as string,
    title: (cleanTitle((title || '') as string) || (prevEntry && prevEntry.title) || url || '未命名') as string,
    url: (url || (prevEntry && prevEntry.url) || '') as string,
    platform: (platformId || (prevEntry && prevEntry.platform) || '') as string,
    platformName: (platformName || (prevEntry && prevEntry.platformName) || '') as string,
    status: (status != null ? status : (prevEntry && prevEntry.status) || STATUS.IMPORTANT) as number | string,
    note: typeof note === 'string' ? note.trim() : String((prevDoc && prevDoc.markdown) || ''),
    tags: Array.isArray(tags) ? (tags as string[]) : ((prevEntry && prevEntry.tags) || []),
    createdAt: Number(prevEntry && prevEntry.createdAt) || now,
    updatedAt: now,
  };
  entryStore.put(entryRecord(item));
  docStore.put(documentRecord(item));
  await transactionDone(tx);
  notifyChange();
  return item;
}

async function updateStatus(id: unknown, status: unknown) {
  const db = await ensureReady();
  const tx = db.transaction(STORE_ENTRIES, 'readwrite');
  const store = tx.objectStore(STORE_ENTRIES);
  const entry = await requestResult(store.get(String(id)));
  if (entry) {
    entry.status = status;
    entry.updatedAt = Date.now();
    store.put(entry);
  }
  await transactionDone(tx);
  notifyChange();
}

async function deleteItem(id: unknown) {
  const db = await ensureReady();
  const tx = db.transaction([STORE_ENTRIES, STORE_DOCUMENTS], 'readwrite');
  tx.objectStore(STORE_ENTRIES).delete(String(id));
  tx.objectStore(STORE_DOCUMENTS).delete(String(id));
  await transactionDone(tx);
  notifyChange();
}

export {
  DB_NAME,
  STORAGE_BACKUP_KEY,
  getBook,
  getRecentItems,
  getKnowledgeItem,
  setBook,
  upsertItem,
  updateStatus,
  deleteItem,
};

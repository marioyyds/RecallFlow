// IndexedDB 的极简 key/value 适配层。
//
// PanelSessionStore 目前只需要 get/set/remove 三种能力。把 IndexedDB 包成同样的接口，
// 可以让持久化迁移不重写面板、Agent、测试的全部调用方；后续需要按 turn 分页时，
// 再在这个模块内部升级成规范化 object store，外部协议保持不变。

export interface KeyValueStoreOptions {
  dbName?: string;
  storeName?: string;
  version?: number;
  /** 测试可注入假的 IDBFactory；不传则用全局 indexedDB。 */
  indexedDB?: IDBFactory | null;
}

export interface KeyValueStore {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown> | null | undefined): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export function createIndexedDbKeyValueStore(options?: KeyValueStoreOptions | null): KeyValueStore {
  const opts = options || {};
  const dbName = String(opts.dbName || 'recallflow-history');
  const storeName = String(opts.storeName || 'kv');
  const version = Math.max(1, Number(opts.version) || 1);
  const factory = opts.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  let dbPromise: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (!factory) return Promise.reject(new Error('IndexedDB 不可用'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = factory.open(dbName, version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          try {
            db.close();
          } catch (e) {}
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('无法打开 IndexedDB'));
      req.onblocked = () => reject(new Error('IndexedDB 升级被其它标签页阻塞'));
    });
    return dbPromise;
  }

  async function get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    const db = await open();
    const tx = db.transaction(storeName, 'readonly');
    const done = transactionDone(tx);
    const store = tx.objectStore(storeName);
    let out: Record<string, unknown>;
    if (keys == null) {
      const [allKeys, allValues] = await Promise.all([
        requestResult(store.getAllKeys() as IDBRequest<IDBValidKey[]>),
        requestResult(store.getAll() as IDBRequest<unknown[]>),
      ]);
      out = {};
      for (let i = 0; i < allKeys.length; i++) out[String(allKeys[i])] = allValues[i];
    } else if (Array.isArray(keys)) {
      out = {};
      const values = await Promise.all(keys.map((key) => requestResult(store.get(String(key)))));
      keys.forEach((key, i) => {
        if (values[i] !== undefined) out[String(key)] = values[i];
      });
    } else {
      const value = await requestResult(store.get(String(keys)));
      out = value === undefined ? {} : { [String(keys)]: value };
    }
    await done;
    return out;
  }

  async function set(items: Record<string, unknown> | null | undefined): Promise<void> {
    const db = await open();
    const tx = db.transaction(storeName, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(storeName);
    for (const [key, value] of Object.entries(items || {})) store.put(value, String(key));
    await done;
  }

  async function remove(keys: string | string[]): Promise<void> {
    const db = await open();
    const tx = db.transaction(storeName, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(storeName);
    for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(String(key));
    await done;
  }

  return { get, set, remove };
}

import type { StorageDocument, StorageKeys, StoragePort } from '../../application/ports/storage.ts';

export interface ChromeStorageAreaLike {
  get(
    keys: StorageKeys,
    callback: (items: StorageDocument) => void
  ): void | Promise<StorageDocument>;
  set(items: StorageDocument, callback: () => void): void | Promise<void>;
  remove(keys: string | string[], callback: () => void): void | Promise<void>;
}

export interface ChromeStorageOnChangedLike {
  addListener(listener: (changes: StorageDocument, areaName?: string) => void): void;
  removeListener(listener: (changes: StorageDocument, areaName?: string) => void): void;
}

export interface ChromeStorageAdapterApi {
  runtime?: { lastError?: { message?: string } | null };
  storage?: { onChanged?: ChromeStorageOnChangedLike };
}

/** Promise adapter for chrome.storage.local / chrome.storage.session. */
export class ChromeStorageAdapter implements StoragePort {
  private readonly area: ChromeStorageAreaLike;
  private readonly api: ChromeStorageAdapterApi;
  private readonly areaName: string;

  constructor(area: ChromeStorageAreaLike, api: ChromeStorageAdapterApi = {}, areaName = 'local') {
    this.area = area;
    this.api = api;
    this.areaName = areaName;
  }

  get(keys: StorageKeys = null): Promise<StorageDocument> {
    return new Promise((resolve, reject) => {
      try {
        let settled = false;
        const finish = (items: StorageDocument) => {
          if (settled) return;
          settled = true;
          const error = this.api.runtime?.lastError;
          if (error) reject(new Error(error.message || '读取扩展存储失败'));
          else resolve(items || {});
        };
        const pending = this.area.get(keys, finish);
        // MV3 的 chrome.storage 同时支持 callback 与 Promise。测试桩和部分浏览器
        // 封装只返回 Promise；若不接这条分支，调用会永远等不到 callback。
        if (pending && typeof pending.then === 'function') {
          pending.then(finish, (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  set(items: StorageDocument): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          const error = this.api.runtime?.lastError;
          if (error) reject(new Error(error.message || '写入扩展存储失败'));
          else resolve();
        };
        const pending = this.area.set(items, finish);
        if (pending && typeof pending.then === 'function') {
          pending.then(finish, (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  remove(keys: string | string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          const error = this.api.runtime?.lastError;
          if (error) reject(new Error(error.message || '删除扩展存储失败'));
          else resolve();
        };
        const pending = this.area.remove(keys, finish);
        if (pending && typeof pending.then === 'function') {
          pending.then(finish, (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  /** 订阅本存储区的变化；返回幂等取消函数。 */
  onChanged(listener: (changes: StorageDocument) => void): () => void {
    const events = this.api.storage?.onChanged;
    if (!events || typeof listener !== 'function') return () => {};
    const wrapped = (changes: StorageDocument, areaName?: string) => {
      if (areaName && areaName !== this.areaName) return;
      listener(changes || {});
    };
    events.addListener(wrapped);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      events.removeListener(wrapped);
    };
  }
}

export function createChromeStorageAdapter(
  area: ChromeStorageAreaLike,
  api: ChromeStorageAdapterApi = typeof chrome !== 'undefined' ? chrome : {},
  areaName = 'local'
): StoragePort {
  return new ChromeStorageAdapter(area, api, areaName);
}

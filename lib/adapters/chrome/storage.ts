import type { StorageDocument, StorageKeys, StoragePort } from '../../application/ports/storage.ts';

export interface ChromeStorageAreaLike {
  get(
    keys: StorageKeys,
    callback: (items: StorageDocument) => void
  ): void;
  set(items: StorageDocument, callback: () => void): void;
  remove(keys: string | string[], callback: () => void): void;
}

export interface ChromeStorageAdapterApi {
  runtime?: { lastError?: { message?: string } | null };
}

/** Promise adapter for chrome.storage.local / chrome.storage.session. */
export class ChromeStorageAdapter implements StoragePort {
  private readonly area: ChromeStorageAreaLike;
  private readonly api: ChromeStorageAdapterApi;

  constructor(area: ChromeStorageAreaLike, api: ChromeStorageAdapterApi = {}) {
    this.area = area;
    this.api = api;
  }

  get(keys: StorageKeys = null): Promise<StorageDocument> {
    return new Promise((resolve, reject) => {
      try {
        this.area.get(keys, (items) => {
          const error = this.api.runtime?.lastError;
          if (error) reject(new Error(error.message || '读取扩展存储失败'));
          else resolve(items || {});
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  set(items: StorageDocument): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.area.set(items, () => {
          const error = this.api.runtime?.lastError;
          if (error) reject(new Error(error.message || '写入扩展存储失败'));
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  remove(keys: string | string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.area.remove(keys, () => {
          const error = this.api.runtime?.lastError;
          if (error) reject(new Error(error.message || '删除扩展存储失败'));
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }
}

export function createChromeStorageAdapter(
  area: ChromeStorageAreaLike,
  api: ChromeStorageAdapterApi = typeof chrome !== 'undefined' ? chrome : {}
): StoragePort {
  return new ChromeStorageAdapter(area, api);
}

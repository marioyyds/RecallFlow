export type StorageKeys = string | string[] | null;
export type StorageDocument = Record<string, unknown>;

/** Asynchronous key-value storage independent of Chrome or IndexedDB. */
export interface StoragePort {
  get(keys?: StorageKeys): Promise<StorageDocument>;
  set(items: StorageDocument): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

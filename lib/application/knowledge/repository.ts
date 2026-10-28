import {
  getBook,
  setBook,
  subscribeKnowledgeChanges,
  upsertItem,
  type KnowledgeBook,
  type KnowledgeItem,
  type KnowledgeUpsertInput,
} from '../../shared/store.ts';

type KnowledgeListener = (book: Readonly<KnowledgeBook>) => void;

/** Repository 对底层存储的最小依赖面，便于页面逻辑使用内存桩测试。 */
export interface KnowledgeRepositoryStore {
  getBook(): Promise<KnowledgeBook>;
  setBook(book: KnowledgeBook): Promise<void>;
  upsertItem(input: KnowledgeUpsertInput): Promise<KnowledgeItem>;
  subscribeChanges(listener: () => void): () => void;
}

export interface KnowledgeRepository {
  readonly size: number;
  load(force?: boolean): Promise<Readonly<KnowledgeBook>>;
  snapshot(): Readonly<KnowledgeBook>;
  get(id: unknown): Readonly<KnowledgeItem> | undefined;
  list(): KnowledgeItem[];
  replace(book: KnowledgeBook): Promise<Readonly<KnowledgeBook>>;
  update(
    id: unknown,
    updater: (item: Readonly<KnowledgeItem>) => KnowledgeItem
  ): Promise<Readonly<KnowledgeItem> | null>;
  put(item: KnowledgeItem): Promise<Readonly<KnowledgeItem>>;
  putMany(items: ReadonlyArray<KnowledgeItem>): Promise<Readonly<KnowledgeBook>>;
  upsert(input: KnowledgeUpsertInput): Promise<Readonly<KnowledgeItem>>;
  remove(id: unknown): Promise<boolean>;
  subscribe(listener: KnowledgeListener): () => void;
  dispose(): void;
}

const defaultStore: KnowledgeRepositoryStore = {
  getBook,
  setBook,
  upsertItem,
  subscribeChanges: (listener) => subscribeKnowledgeChanges(() => listener()),
};

function cloneItem(item: KnowledgeItem): KnowledgeItem {
  return { ...item, tags: Array.isArray(item.tags) ? item.tags.slice() : [] };
}

function cloneBook(book: Readonly<KnowledgeBook>): KnowledgeBook {
  const out: KnowledgeBook = {};
  for (const [id, item] of Object.entries(book)) out[id] = cloneItem(item);
  return out;
}

/**
 * 知识库页面共用的状态边界。
 *
 * 页面不再直接持有 bookCache，也不再自行 load/persist；Repository 负责：
 * - 单一缓存和加载去重；
 * - 写操作串行化，避免两个页面操作互相覆盖；
 * - 本地通知与 BroadcastChannel 外部变更的合并；
 * - 对消费者暴露只读快照。
 */
export class KnowledgeRepositoryImpl implements KnowledgeRepository {
  private readonly store: KnowledgeRepositoryStore;
  private readonly listeners = new Set<KnowledgeListener>();
  private readonly unsubscribeStore: () => void;
  private cache: KnowledgeBook = {};
  private loaded = false;
  private loadPromise: Promise<Readonly<KnowledgeBook>> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(store: KnowledgeRepositoryStore = defaultStore) {
    this.store = store;
    this.unsubscribeStore = store.subscribeChanges(() => {
      if (!this.disposed) void this.load(true).catch(() => {});
    });
  }

  get size(): number {
    return Object.keys(this.cache).length;
  }

  snapshot(): Readonly<KnowledgeBook> {
    return cloneBook(this.cache);
  }

  get(id: unknown): Readonly<KnowledgeItem> | undefined {
    const item = this.cache[String(id)];
    return item ? cloneItem(item) : undefined;
  }

  list(): KnowledgeItem[] {
    return Object.values(this.cache).map(cloneItem);
  }

  async load(force = false): Promise<Readonly<KnowledgeBook>> {
    if (this.loadPromise) return this.loadPromise;
    if (!force && this.loaded) return cloneBook(this.cache);

    this.loadPromise = (async () => {
      // 外部广播可能早于本地 write 完成；排在写入之后可避免旧快照覆盖新缓存。
      await this.writeChain;
      const book = await this.store.getBook();
      this.cache = book;
      this.loaded = true;
      this.notify();
      return cloneBook(this.cache);
    })().finally(() => {
      this.loadPromise = null;
    });

    return this.loadPromise;
  }

  async replace(book: KnowledgeBook): Promise<Readonly<KnowledgeBook>> {
    await this.load();
    return this.enqueueWrite(async () => {
      const next = cloneBook(book);
      await this.store.setBook(next);
      this.cache = next;
      this.loaded = true;
      this.notify();
      return cloneBook(this.cache);
    });
  }

  async update(
    id: unknown,
    updater: (item: Readonly<KnowledgeItem>) => KnowledgeItem
  ): Promise<Readonly<KnowledgeItem> | null> {
    await this.load();
    return this.enqueueWrite(async () => {
      const key = String(id);
      const current = this.cache[key];
      if (!current) return null;

      const updated = cloneItem(updater(cloneItem(current)));
      const next = { ...this.cache, [key]: updated };
      await this.store.setBook(next);
      this.cache = next;
      this.notify();
      return updated;
    });
  }

  async put(item: KnowledgeItem): Promise<Readonly<KnowledgeItem>> {
    const book = await this.putMany([item]);
    return book[String(item.id)] as Readonly<KnowledgeItem>;
  }

  async putMany(items: ReadonlyArray<KnowledgeItem>): Promise<Readonly<KnowledgeBook>> {
    await this.load();
    return this.enqueueWrite(async () => {
      const next = cloneBook(this.cache);
      for (const item of items) next[String(item.id)] = cloneItem(item);
      await this.store.setBook(next);
      this.cache = next;
      this.notify();
      return cloneBook(this.cache);
    });
  }

  async upsert(input: KnowledgeUpsertInput): Promise<Readonly<KnowledgeItem>> {
    await this.load();
    return this.enqueueWrite(async () => {
      const item = await this.store.upsertItem(input);
      this.cache = { ...this.cache, [String(item.id)]: item };
      this.notify();
      return cloneItem(item);
    });
  }

  async remove(id: unknown): Promise<boolean> {
    await this.load();
    return this.enqueueWrite(async () => {
      const key = String(id);
      if (!this.cache[key]) return false;
      const next = { ...this.cache };
      delete next[key];
      await this.store.setBook(next);
      this.cache = next;
      this.notify();
      return true;
    });
  }

  subscribe(listener: KnowledgeListener): () => void {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.unsubscribeStore();
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(cloneBook(this.cache));
      } catch (error) {
        console.warn('[KnowledgeRepository] listener failed:', error);
      }
    }
  }
}

export function createKnowledgeRepository(
  store: KnowledgeRepositoryStore = defaultStore
): KnowledgeRepository {
  return new KnowledgeRepositoryImpl(store);
}

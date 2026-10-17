// 面板会话仓库：整个浏览器共享一组对话，支持新建、切换、重命名、删除与运行锁。
//
// 存储分成四层，避免每次保存都重写所有对话：
//   index    -> 只放列表所需的摘要（标题、时间、条数、seq）
//   session  -> 每个会话一个 key，保存对话正文
//   active   -> 所有标签页共享的“当前会话”
//   lock     -> 同一会话同时只允许一个标签页运行 Agent
//
// 本模块不直接依赖 chrome.*，由调用方注入 storage，便于用假存储把并发、
// 迁移、锁过期这些“浏览器里很难稳定复现”的路径做成单测。

import { sliceSafe } from './surrogates.js';

export const PSESS_INDEX_KEY = 'recallflow.psess.index.v1';
export const PSESS_ACTIVE_KEY = 'recallflow.psess.active.v1';
export const PSESS_SESSION_PREFIX = 'recallflow.psess.v1.';
export const PSESS_LOCK_PREFIX = 'recallflow.psess.lock.v1.';
export const PSESS_MAX_SESSIONS = 20;
export const PSESS_LOCK_TTL_MS = 120_000;
export const PSESS_DEFAULT_TITLE = '新会话';

const MAX_TITLE_CHARS = 42;
const LEGACY_CONV_RE = /^recallflow\.conv\.(\d+)$/;

export function panelSessionKey(id) {
  return PSESS_SESSION_PREFIX + String(id || '');
}

export function panelSessionLockKey(id) {
  return PSESS_LOCK_PREFIX + String(id || '');
}

export function deriveSessionTitle(messages, fallback = PSESS_DEFAULT_TITLE) {
  const list = Array.isArray(messages) ? messages : [];
  const first = list.find((m) => m && m.role === 'user' && String(m.content || '').trim());
  const text = String((first && first.content) || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text.length > MAX_TITLE_CHARS ? sliceSafe(text, 0, MAX_TITLE_CHARS - 1) + '…' : text;
}

export function countConversationMessages(messages) {
  return Array.isArray(messages) ? messages.length : 0;
}

function normalizeOrigin(value) {
  const text = String(value || '').trim();
  return text.slice(0, 2048);
}

function summarize(session) {
  return {
    id: session.id,
    title: session.title || PSESS_DEFAULT_TITLE,
    createdAt: Number(session.createdAt) || 0,
    updatedAt: Number(session.updatedAt) || 0,
    messageCount: countConversationMessages(session.messages),
    seq: Number(session.seq) || 0,
    origin: String(session.origin || ''),
    handoffId: String(session.handoffId || ''),
    lastRunId: String(session.lastRunId || ''),
    writerTabId: session.writerTabId == null ? null : Number(session.writerTabId),
    titleAuto: session.titleAuto !== false,
  };
}

function sortSummaries(a, b) {
  return b.updatedAt - a.updatedAt || b.seq - a.seq;
}

/**
 * 面板会话仓库。
 *
 * storage 需实现 get(key|key[]|null) / set(object) / remove(key|key[])，
 * 全部返回 Promise（chrome.storage.session 原生就满足）。
 */
export class PanelSessionStore {
  constructor(options) {
    const opts = options || {};
    if (!opts.storage) throw new Error('PanelSessionStore requires storage');
    this.storage = opts.storage;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.maxSessions = Math.max(1, Number(opts.maxSessions) || PSESS_MAX_SESSIONS);
    this.lockTtlMs = Math.max(1000, Number(opts.lockTtlMs) || PSESS_LOCK_TTL_MS);
    // 锁的 owner tab 可能已经关闭，而 tabs.onRemoved 的异步清理尚未落地。
    // 浏览器侧注入真实 tab 查询；纯单测默认视为“仍在”。
    this.isTabAlive = typeof opts.isTabAlive === 'function' ? opts.isTabAlive : async () => true;
    this.idFactory =
      typeof opts.idFactory === 'function'
        ? opts.idFactory
        : () =>
            'S-' +
            this.now().toString(36) +
            '-' +
            Math.random().toString(36).slice(2, 9);
    // 单写者：Service Worker 里所有读改写都排在同一队列上，避免两个标签页同时
    // 创建/切换时把索引写回旧版本。
    this._tail = Promise.resolve();
  }

  _enqueue(fn) {
    const run = this._tail.then(fn, fn);
    this._tail = run.catch(() => {});
    return run;
  }

  async _readIndex() {
    const data = await this.storage.get(PSESS_INDEX_KEY);
    const raw = (data && data[PSESS_INDEX_KEY]) || {};
    const sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
    return {
      version: 1,
      seq: Math.max(0, Number(raw.seq) || 0),
      sessions,
    };
  }

  async _readActive() {
    const data = await this.storage.get(PSESS_ACTIVE_KEY);
    const active = (data && data[PSESS_ACTIVE_KEY]) || {};
    return { id: String(active.id || ''), seq: Number(active.seq) || 0, updatedAt: Number(active.updatedAt) || 0 };
  }

  async _readSession(id) {
    if (!id) return null;
    const key = panelSessionKey(id);
    const data = await this.storage.get(key);
    const session = data && data[key];
    if (!session || session.id !== id) return null;
    return session;
  }

  async _readLock(id, now) {
    if (!id) return null;
    const key = panelSessionLockKey(id);
    const data = await this.storage.get(key);
    const lock = data && data[key];
    if (!lock || !lock.runId) return null;
    if (Number(lock.at) + this.lockTtlMs <= now) return null;
    return lock;
  }

  async _writeIndex(index) {
    await this.storage.set({ [PSESS_INDEX_KEY]: index });
  }

  async _writeActive(id, seq, updatedAt) {
    await this.storage.set({ [PSESS_ACTIVE_KEY]: { id, seq, updatedAt } });
  }

  async _lockedIds(index, now) {
    const ids = Object.keys(index.sessions);
    if (!ids.length) return new Set();
    const keys = ids.map(panelSessionLockKey);
    const data = await this.storage.get(keys);
    const locked = new Set();
    for (const id of ids) {
      const lock = data && data[panelSessionLockKey(id)];
      if (lock && lock.runId && Number(lock.at) + this.lockTtlMs > now) locked.add(id);
    }
    return locked;
  }

  async _summaries(index, now) {
    const locked = await this._lockedIds(index, now);
    return Object.values(index.sessions)
      .map((s) => Object.assign(summarize(s), { locked: locked.has(s.id) }))
      .sort(sortSummaries);
  }

  async _state(index, active) {
    return {
      sessions: await this._summaries(index, this.now()),
      activeId: active.id || '',
      seq: index.seq,
    };
  }

  /**
   * 首次访问时建立索引；旧版按 tab 保存的 `recallflow.conv.<tabId>` 会迁移为历史会话。
   * legacyEntries: [{ key, conversation, updatedAt }]，由 Service Worker 从 storage 读出。
   */
  bootstrap(options) {
    const opts = options || {};
    return this._enqueue(async () => {
      let index = await this._readIndex();
      let active = await this._readActive();
      let migratedKeys = [];

      if (!Object.keys(index.sessions).length) {
        const legacy = (Array.isArray(opts.legacyEntries) ? opts.legacyEntries : [])
          .filter((e) => e && e.key && LEGACY_CONV_RE.test(String(e.key)) && Array.isArray(e.conversation))
          .sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0));
        for (const entry of legacy) {
          const now = Number(entry.updatedAt) || this.now();
          index.seq += 1;
          const session = this._newSession({
            title: deriveSessionTitle(entry.conversation),
            messages: entry.conversation,
            createdAt: now,
            updatedAt: now,
            origin: '',
            handoffId: '',
            seq: index.seq,
            titleAuto: true,
          });
          index.sessions[session.id] = summarize(session);
          await this.storage.set({ [panelSessionKey(session.id)]: session });
          migratedKeys.push(String(entry.key));
          active = { id: session.id, seq: session.seq, updatedAt: now };
        }
        if (!Object.keys(index.sessions).length) {
          const empty = await this._createInIndex(index, {});
          active = { id: empty.id, seq: empty.seq, updatedAt: empty.updatedAt };
        }
      }

      if (!active.id || !index.sessions[active.id]) {
        const newest = Object.values(index.sessions).sort(sortSummaries)[0];
        active = newest
          ? { id: newest.id, seq: newest.seq, updatedAt: newest.updatedAt }
          : { id: '', seq: 0, updatedAt: 0 };
      }

      await this._writeIndex(index);
      await this._writeActive(active.id, active.seq, active.updatedAt);
      await this._prune(index, active.id, migratedKeys);
      const state = await this._state(index, active);
      return Object.assign(state, { migratedKeys });
    });
  }

  list() {
    return this._enqueue(async () => {
      const index = await this._readIndex();
      const active = await this._readActive();
      return this._state(index, active);
    });
  }

  get(id) {
    return this._enqueue(async () => {
      const index = await this._readIndex();
      const active = await this._readActive();
      const wanted = String(id || active.id || '');
      const session = wanted ? await this._readSession(wanted) : null;
      return {
        session,
        activeId: active.id || '',
        sessions: await this._summaries(index, this.now()),
      };
    });
  }

  create(input) {
    const data = input || {};
    return this._enqueue(async () => {
      const index = await this._readIndex();
      const session = await this._createInIndex(index, data);
      const active = { id: session.id, seq: session.seq, updatedAt: session.updatedAt };
      await this._writeIndex(index);
      await this._writeActive(active.id, active.seq, active.updatedAt);
      await this._prune(index, active.id);
      return {
        ok: true,
        session,
        activeId: active.id,
        sessions: await this._summaries(index, this.now()),
      };
    });
  }

  save(input) {
    const data = input || {};
    return this._enqueue(async () => {
      const id = String(data.id || '');
      if (!id || !Array.isArray(data.messages)) {
        return { ok: false, error: '无效的会话保存请求' };
      }
      const index = await this._readIndex();
      const current = await this._readSession(id);
      if (!current || !index.sessions[id]) {
        return { ok: false, error: '会话不存在或已被删除', missing: true };
      }
      const baseSeq = Number(data.baseSeq);
      const writerTabId = data.tabId == null ? null : Number(data.tabId);
      const sameWriter = writerTabId != null && Number(current.writerTabId) === writerTabId;
      if (Number.isFinite(baseSeq) && baseSeq > 0 && Number(current.seq) > baseSeq && !sameWriter) {
        return {
          ok: false,
          conflict: true,
          session: current,
          activeId: (await this._readActive()).id,
          sessions: await this._summaries(index, this.now()),
        };
      }

      const now = this.now();
      const seq = index.seq + 1;
      const titleAuto = current.titleAuto !== false;
      const derived = deriveSessionTitle(data.messages, current.title || PSESS_DEFAULT_TITLE);
      const explicitTitle = typeof data.title === 'string' ? data.title.trim() : '';
      const next = Object.assign({}, current, {
        messages: data.messages,
        updatedAt: now,
        seq,
        title: explicitTitle || (titleAuto ? derived : current.title || PSESS_DEFAULT_TITLE),
        titleAuto: explicitTitle ? false : titleAuto,
        origin: data.origin != null ? normalizeOrigin(data.origin) : current.origin || '',
        handoffId: data.handoffId != null ? String(data.handoffId || '') : current.handoffId || '',
        lastRunId: data.lastRunId != null ? String(data.lastRunId || '') : current.lastRunId || '',
        writerTabId: writerTabId != null ? writerTabId : current.writerTabId,
      });
      index.seq = seq;
      index.sessions[id] = summarize(next);
      await this.storage.set({ [panelSessionKey(id)]: next });
      await this._writeIndex(index);
      return {
        ok: true,
        session: next,
        activeId: (await this._readActive()).id,
        sessions: await this._summaries(index, this.now()),
      };
    });
  }

  activate(id) {
    return this._enqueue(async () => {
      const wanted = String(id || '');
      const index = await this._readIndex();
      const session = await this._readSession(wanted);
      if (!session || !index.sessions[wanted]) return { ok: false, error: '会话不存在' };
      const active = { id: wanted, seq: session.seq, updatedAt: this.now() };
      await this._writeActive(active.id, active.seq, active.updatedAt);
      return {
        ok: true,
        session,
        activeId: active.id,
        sessions: await this._summaries(index, this.now()),
      };
    });
  }

  rename(id, title) {
    return this._enqueue(async () => {
      const wanted = String(id || '');
      const nextTitle = sliceSafe(String(title || '').replace(/\s+/g, ' ').trim(), 0, MAX_TITLE_CHARS);
      if (!wanted || !nextTitle) return { ok: false, error: '会话标题不能为空' };
      const index = await this._readIndex();
      const session = await this._readSession(wanted);
      if (!session || !index.sessions[wanted]) return { ok: false, error: '会话不存在' };
      const now = this.now();
      const seq = index.seq + 1;
      const next = Object.assign({}, session, { title: nextTitle, titleAuto: false, updatedAt: now, seq });
      index.seq = seq;
      index.sessions[wanted] = summarize(next);
      await this.storage.set({ [panelSessionKey(wanted)]: next });
      await this._writeIndex(index);
      const active = await this._readActive();
      if (active.id === wanted) await this._writeActive(wanted, seq, now);
      return {
        ok: true,
        session: next,
        activeId: active.id,
        sessions: await this._summaries(index, this.now()),
      };
    });
  }

  remove(id) {
    return this._enqueue(async () => {
      const wanted = String(id || '');
      const index = await this._readIndex();
      if (!index.sessions[wanted]) return { ok: false, error: '会话不存在' };
      const lock = await this._readLock(wanted, this.now());
      if (lock) return { ok: false, locked: true, lock, error: '该会话正在其他标签页运行' };

      delete index.sessions[wanted];
      index.seq += 1;
      await this.storage.remove([panelSessionKey(wanted), panelSessionLockKey(wanted)]);

      let active = await this._readActive();
      if (!active.id || active.id === wanted || !index.sessions[active.id]) {
        const newest = Object.values(index.sessions).sort(sortSummaries)[0];
        if (newest) {
          active = { id: newest.id, seq: newest.seq, updatedAt: this.now() };
        } else {
          const created = await this._createInIndex(index, {});
          active = { id: created.id, seq: created.seq, updatedAt: created.updatedAt };
        }
      }
      await this._writeIndex(index);
      await this._writeActive(active.id, active.seq, active.updatedAt);
      await this._prune(index, active.id);
      return {
        ok: true,
        deletedId: wanted,
        activeId: active.id,
        sessions: await this._summaries(index, this.now()),
      };
    });
  }

  lock(input) {
    const data = input || {};
    return this._enqueue(async () => {
      const id = String(data.id || '');
      const runId = String(data.runId || '');
      const tabId = data.tabId == null ? null : Number(data.tabId);
      if (!id || !runId) return { ok: false, error: '缺少会话或运行标识' };
      const index = await this._readIndex();
      if (!index.sessions[id]) return { ok: false, missing: true, error: '会话不存在' };
      const now = this.now();
      let current = await this._readLock(id, now);
      const sameOwner =
        current &&
        (current.runId === runId ||
          (tabId != null && current.tabId != null && Number(current.tabId) === tabId));
      if (current && !sameOwner && current.tabId != null) {
        let ownerAlive = true;
        try {
          ownerAlive = await this.isTabAlive(Number(current.tabId));
        } catch (e) {
          ownerAlive = true;
        }
        // owner 已关闭：把残留锁视为过期，下一次获取直接覆盖。
        if (!ownerAlive) current = null;
      }
      if (current && !sameOwner && !data.takeover) {
        return { ok: false, locked: true, lock: current, error: '该会话正在另一个标签页运行' };
      }
      const lock = {
        runId,
        tabId,
        at: now,
        previous: current && !sameOwner ? { runId: current.runId, tabId: current.tabId } : null,
      };
      await this.storage.set({ [panelSessionLockKey(id)]: lock });
      return { ok: true, lock, sessions: await this._summaries(index, now) };
    });
  }

  unlock(input) {
    const data = input || {};
    return this._enqueue(async () => {
      const id = String(data.id || '');
      const runId = String(data.runId || '');
      if (!id) return { ok: false, error: '缺少会话标识' };
      const current = await this._readLock(id, this.now());
      if (current && runId && current.runId !== runId) {
        return { ok: false, locked: true, lock: current, error: '运行锁已属于另一个任务' };
      }
      await this.storage.remove(panelSessionLockKey(id));
      return { ok: true };
    });
  }

  /** 标签页关闭时释放它持有的所有锁（崩溃/强关不应阻塞同浏览器的其它标签页）。 */
  releaseTabLocks(tabId) {
    return this._enqueue(async () => {
      const wanted = tabId == null ? null : Number(tabId);
      if (wanted == null) return { ok: true, released: 0 };
      const index = await this._readIndex();
      const ids = Object.keys(index.sessions);
      if (!ids.length) return { ok: true, released: 0 };
      const keys = ids.map(panelSessionLockKey);
      const data = await this.storage.get(keys);
      const mine = [];
      for (const id of ids) {
        const key = panelSessionLockKey(id);
        const lock = data && data[key];
        if (lock && Number(lock.tabId) === wanted) mine.push(key);
      }
      if (mine.length) await this.storage.remove(mine);
      return { ok: true, released: mine.length };
    });
  }

  async _createInIndex(index, input) {
    const now = this.now();
    index.seq += 1;
    const messages = Array.isArray(input.messages) ? input.messages : [];
    let id = String(this.idFactory());
    for (let tries = 0; (!id || Object.prototype.hasOwnProperty.call(index.sessions, id)) && tries < 100; tries++) {
      id = String(this.idFactory());
    }
    if (!id || Object.prototype.hasOwnProperty.call(index.sessions, id)) {
      id = 'S-' + now.toString(36) + '-' + index.seq.toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    }
    const session = this._newSession({
      id,
      title: String(input.title || '').trim() || deriveSessionTitle(messages),
      messages,
      createdAt: now,
      updatedAt: now,
      origin: input.origin,
      handoffId: input.handoffId,
      seq: index.seq,
      titleAuto: !String(input.title || '').trim(),
    });
    index.sessions[session.id] = summarize(session);
    await this.storage.set({ [panelSessionKey(session.id)]: session });
    return session;
  }

  _newSession(input) {
    return {
      id: String(input.id || this.idFactory()),
      title: String(input.title || '').trim() || deriveSessionTitle(input.messages),
      createdAt: Number(input.createdAt) || this.now(),
      updatedAt: Number(input.updatedAt) || this.now(),
      messages: Array.isArray(input.messages) ? input.messages : [],
      seq: Number(input.seq) || 0,
      origin: normalizeOrigin(input.origin),
      handoffId: String(input.handoffId || ''),
      lastRunId: '',
      writerTabId: input.writerTabId == null ? null : Number(input.writerTabId),
      titleAuto: input.titleAuto !== false,
    };
  }

  async _prune(index, activeId, extraProtectedKeys) {
    const ids = Object.keys(index.sessions);
    if (ids.length <= this.maxSessions) return;
    const protectedKeys = new Set(extraProtectedKeys || []);
    const candidates = Object.values(index.sessions)
      .filter((s) => s.id !== activeId)
      .sort((a, b) => a.updatedAt - b.updatedAt || a.seq - b.seq);
    const locked = await this._lockedIds(index, this.now());
    while (Object.keys(index.sessions).length > this.maxSessions) {
      const victim = candidates.shift();
      if (!victim || locked.has(victim.id)) break;
      delete index.sessions[victim.id];
      const key = panelSessionKey(victim.id);
      if (!protectedKeys.has(key)) await this.storage.remove([key, panelSessionLockKey(victim.id)]);
    }
    await this._writeIndex(index);
  }
}

// lib/shared/constants.ts
var STORAGE_KEY = "knowledgeBase";
var LEGACY_STORAGE_KEY = "wrongBook";
var DATA_VERSION_KEY = "knowledgeBaseDataVersion";
var CURRENT_DATA_VERSION = 2;
var STATUS = {
  GENERAL: 1,
  // 一般
  IMPORTANT: 2,
  // 重点
  FREQUENT: 3
  // 高频
};
var ITEM_TYPES = [
  { id: "wrong", name: "\u7B97\u6CD5\u9519\u9898", color: "#4a90d9" },
  { id: "article", name: "\u6280\u672F\u6587\u7AE0", color: "#27ae60" },
  { id: "ai", name: "AI\xB7Prompt", color: "#9b59b6" },
  { id: "note", name: "\u7B14\u8BB0\u60F3\u6CD5", color: "#e67e22" }
];
var STAR_LEVELS = {
  [STATUS.GENERAL]: { name: "\u4E00\u822C", color: "#f5b860" },
  [STATUS.IMPORTANT]: { name: "\u91CD\u70B9", color: "#f39c12" },
  [STATUS.FREQUENT]: { name: "\u9AD8\u9891", color: "#e74c3c" }
};
var OLD_STATUS_MIGRATION = {
  "to-review": 2,
  "redo": 1,
  "mastered": 3
};

// lib/shared/surrogates.ts
var isHigh = (c) => c >= 55296 && c <= 56319;
var isLow = (c) => c >= 56320 && c <= 57343;
function alignRange(text, start, end) {
  const s = String(text === void 0 || text === null ? "" : text);
  const len = s.length;
  const clamp = (v, fallback) => {
    if (v === void 0 || v === null) return fallback;
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return n < 0 ? Math.max(0, len + n) : Math.min(len, n);
  };
  let a = clamp(start, 0);
  let b = clamp(end, len);
  if (b < a) b = a;
  if (a > 0 && a < len && isLow(s.charCodeAt(a)) && isHigh(s.charCodeAt(a - 1))) a -= 1;
  if (b > 0 && b < len && isLow(s.charCodeAt(b)) && isHigh(s.charCodeAt(b - 1))) b -= 1;
  return { start: a, end: b };
}
function sliceSafe(text, start, end) {
  const s = String(text === void 0 || text === null ? "" : text);
  const { start: a, end: b } = alignRange(s, start, end);
  return s.slice(a, b);
}

// lib/shared/utils.ts
function debounce(fn, delay) {
  let timer = null;
  return function(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
function logError(context, error) {
  console.warn(`[BookmarkSorter] ${context}:`, error);
}
function typeInfo(id) {
  return ITEM_TYPES.find((t) => t.id === id) || ITEM_TYPES[0];
}
function starColor(n) {
  return (STAR_LEVELS[Number(n)] || STAR_LEVELS[2]).color;
}
function cleanTitle(title) {
  let t = (title || "").trim();
  t = t.replace(
    /[|\-–—]\s*(力扣（LeetCode）|力扣|LeetCode|牛客网|牛客|nowcoder|洛谷|Luogu|AcWing|Codeforces|AtCoder).*$/i,
    ""
  ).trim();
  return t;
}
function parseTags(str) {
  return String(str || "").split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean);
}
function markdownExcerpt(text, maxChars = 160) {
  const limit = Math.max(20, Number(maxChars) || 160);
  let s = String(text || "");
  s = s.replace(/```[\s\S]*?```/g, " [\u4EE3\u7801\u5757] ");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, (match, alt) => alt || "[\u56FE\u7247]");
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  s = s.replace(/^\s*\d+[.)]\s+/gm, "");
  s = s.replace(/[*_~]{1,3}/g, "");
  s = s.replace(/\|/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > limit ? sliceSafe(s, 0, limit).trimEnd() + "\u2026" : s;
}
function starBarHtml(n, interactive) {
  const level = Math.max(1, Math.min(3, Number(n) || 1));
  const group = interactive ? ' role="radiogroup" aria-label="\u91CD\u8981\u7A0B\u5EA6"' : "";
  let h = `<span class="star-bar${interactive ? " interactive" : ""}"${group}>`;
  for (let i = 1; i <= 3; i++) {
    const on = i <= level;
    const cell = interactive ? ` role="radio" aria-checked="${on}" aria-label="${i} \u661F" tabindex="${on ? 0 : -1}" data-star="${i}"` : ` data-star="${i}"`;
    h += `<span class="star-cell${on ? " on" : ""}" style="--star-level:${starColor(i)}"${cell}>\u2605</span>`;
  }
  h += "</span>";
  return h;
}
function bindStarKeyboard(root, onSelect) {
  root.addEventListener("keydown", (e) => {
    const cell = e.target?.closest('.star-cell[role="radio"]');
    if (!cell) return;
    const group = cell.parentElement;
    const cells = Array.from(group.querySelectorAll(".star-cell"));
    const max = cells.length - 1;
    let idx = cells.indexOf(cell);
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        idx = Math.min(max, idx + 1);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        idx = Math.max(0, idx - 1);
        break;
      case "Home":
        idx = 0;
        break;
      case "End":
        idx = max;
        break;
      case " ":
      case "Enter":
        e.preventDefault();
        onSelect(Number(cell.dataset.star), cell);
        return;
      default:
        return;
    }
    e.preventDefault();
    cells.forEach((c, i) => {
      const on = i <= idx;
      c.classList.toggle("on", on);
      c.tabIndex = i === idx ? 0 : -1;
      c.setAttribute("aria-checked", String(on));
    });
    cells[idx].focus();
    onSelect(idx + 1, cells[idx]);
  });
}
function levelNameHtml(n) {
  const st = STAR_LEVELS[Math.max(1, Math.min(3, Number(n) || 1))];
  return `<span class="level-name" style="color:${st.color}">${st.name}</span>`;
}
function typeBadgeHtml(type) {
  const t = typeInfo(type);
  return `<span class="type-badge" style="color:${t.color};background:${t.color}1A;border:1px solid ${t.color}40">${t.name}</span>`;
}
function tagsHtml(tags) {
  if (!Array.isArray(tags) || !tags.length) return "";
  return `<span class="tag-list">${tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join("")}</span>`;
}
var DEFAULT_STYLE_PROPS = Object.freeze([
  "font-size",
  "line-height",
  "color",
  "background-color",
  "width",
  "height",
  "display",
  "visibility",
  "opacity",
  "overflow-x",
  "position",
  "z-index"
]);
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const diff = Date.now() - Number(d.getTime());
  if (diff < 60 * 60 * 1e3) return Math.max(1, Math.round(diff / 6e4)) + " \u5206\u949F\u524D";
  if (diff < 24 * 60 * 60 * 1e3) return Math.round(diff / 36e5) + " \u5C0F\u65F6\u524D";
  if (diff < 7 * 24 * 60 * 60 * 1e3) return Math.round(diff / 864e5) + " \u5929\u524D";
  return d.toLocaleDateString("zh-CN");
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
var _toastTimer = null;
function showToast(msg, opts) {
  const o = opts || {};
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("data-rf-injected", "");
    document.body.appendChild(el);
  }
  el.textContent = msg;
  if (o.undoFn) {
    const btn = document.createElement("button");
    btn.textContent = "\u64A4\u9500";
    btn.addEventListener("click", () => {
      o.undoFn();
      el.classList.remove("show");
    });
    el.textContent = msg + " ";
    el.appendChild(btn);
  }
  el.classList.add("show");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), o.duration || 2e3);
}

// lib/domain/knowledge/query.ts
function sortItems(list, sortBy2) {
  const arr = list.slice();
  const status = (item) => {
    const value = Number(item.status);
    return Number.isFinite(value) ? value : 0;
  };
  switch (sortBy2) {
    case "created":
      arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      break;
    case "star-desc":
      arr.sort(
        (a, b) => status(b) - status(a) || (b.updatedAt || 0) - (a.updatedAt || 0)
      );
      break;
    case "star-asc":
      arr.sort(
        (a, b) => status(a) - status(b) || (b.updatedAt || 0) - (a.updatedAt || 0)
      );
      break;
    default:
      arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return arr;
}

// lib/shared/store.ts
var DB_NAME = "recallflow-knowledge";
var DB_VERSION = 1;
var STORE_ENTRIES = "entries";
var STORE_DOCUMENTS = "documents";
var STORE_META = "meta";
var MIGRATION_META_KEY = "chrome-storage-v2";
var STORAGE_BACKUP_KEY = "knowledgeBasePreIndexedDB";
var CHANGE_CHANNEL = "recallflow-knowledge-change";
var dbPromise = null;
var migrationPromise = null;
function requestResult(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
        const entries = db.createObjectStore(STORE_ENTRIES, { keyPath: "id" });
        entries.createIndex("updatedAt", "updatedAt");
        entries.createIndex("createdAt", "createdAt");
        entries.createIndex("type", "type");
        entries.createIndex("status", "status");
      }
      if (!db.objectStoreNames.contains(STORE_DOCUMENTS)) {
        db.createObjectStore(STORE_DOCUMENTS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
  return dbPromise;
}
function normalizeBook(input) {
  const source = input && typeof input === "object" ? input : {};
  const out = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || key);
    if (!id) continue;
    const status = typeof raw.status === "string" ? OLD_STATUS_MIGRATION[String(raw.status)] || STATUS.IMPORTANT : [STATUS.GENERAL, STATUS.IMPORTANT, STATUS.FREQUENT].includes(raw.status) ? raw.status : STATUS.IMPORTANT;
    out[id] = {
      id,
      type: raw.type || "wrong",
      title: cleanTitle(raw.title || "") || raw.title || raw.url || "\u672A\u547D\u540D",
      url: raw.url || "",
      platform: raw.platform || "",
      platformName: raw.platformName || "",
      status,
      note: typeof raw.note === "string" ? raw.note : "",
      tags: Array.isArray(raw.tags) ? raw.tags.slice() : [],
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now()
    };
  }
  return out;
}
function entryRecord(item) {
  const note = String(item.note || "");
  return {
    id: item.id,
    type: item.type || "wrong",
    title: item.title || "\u672A\u547D\u540D",
    url: item.url || "",
    platform: item.platform || "",
    platformName: item.platformName || "",
    status: item.status,
    tags: Array.isArray(item.tags) ? item.tags.slice() : [],
    createdAt: Number(item.createdAt) || Date.now(),
    updatedAt: Number(item.updatedAt) || Date.now(),
    notePreview: markdownExcerpt(note, 180),
    noteChars: note.length
  };
}
function documentRecord(item) {
  return { id: item.id, markdown: String(item.note || "") };
}
function withNote(entry, doc) {
  return Object.assign({}, entry, { note: String(doc && doc.markdown || "") });
}
async function readMigrationMeta(db) {
  try {
    const tx = db.transaction(STORE_META, "readonly");
    return await requestResult(tx.objectStore(STORE_META).get(MIGRATION_META_KEY));
  } catch (e) {
    return null;
  }
}
async function migrateFromChromeStorage() {
  const db = await openDb();
  if (await readMigrationMeta(db)) return;
  let stored = {};
  let book = {};
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      stored = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY, DATA_VERSION_KEY]);
      book = stored[STORAGE_KEY];
      if (!book && stored[LEGACY_STORAGE_KEY]) {
        book = {};
        for (const [url, item] of Object.entries(stored[LEGACY_STORAGE_KEY] || {})) {
          book[url] = Object.assign({}, item, { id: url, type: "wrong", tags: [] });
        }
      }
    }
  } catch (e) {
    stored = {};
  }
  const normalized = normalizeBook(book || {});
  const tx = db.transaction([STORE_ENTRIES, STORE_DOCUMENTS, STORE_META], "readwrite");
  const entries = tx.objectStore(STORE_ENTRIES);
  const docs = tx.objectStore(STORE_DOCUMENTS);
  const existingKeys = await requestResult(entries.getAllKeys());
  const existing = new Set(existingKeys.map(String));
  for (const item of Object.values(normalized)) {
    if (existing.has(String(item.id))) continue;
    entries.put(entryRecord(item));
    docs.put(documentRecord(item));
  }
  tx.objectStore(STORE_META).put({
    key: MIGRATION_META_KEY,
    done: true,
    migratedAt: Date.now(),
    schemaVersion: CURRENT_DATA_VERSION
  });
  await transactionDone(tx);
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      if (stored[STORAGE_KEY]) {
        await chrome.storage.local.set({ [STORAGE_BACKUP_KEY]: stored[STORAGE_KEY] });
      }
      await chrome.storage.local.remove([STORAGE_KEY, LEGACY_STORAGE_KEY]);
    }
  } catch (e) {
  }
}
async function ensureReady() {
  if (!migrationPromise) migrationPromise = migrateFromChromeStorage();
  await migrationPromise;
  return openDb();
}
function notifyChange() {
  try {
    const channel = new BroadcastChannel(CHANGE_CHANNEL);
    channel.postMessage({ type: "knowledge-changed", at: Date.now() });
    setTimeout(() => channel.close(), 0);
  } catch (e) {
  }
}
function subscribeKnowledgeChanges(callback) {
  if (typeof callback !== "function" || typeof BroadcastChannel === "undefined") return () => {
  };
  const channel = new BroadcastChannel(CHANGE_CHANNEL);
  channel.onmessage = (event) => callback(event && event.data);
  return () => channel.close();
}
async function getBook() {
  const db = await ensureReady();
  const tx = db.transaction([STORE_ENTRIES, STORE_DOCUMENTS], "readonly");
  const entryList = await requestResult(tx.objectStore(STORE_ENTRIES).getAll());
  const docList = await requestResult(tx.objectStore(STORE_DOCUMENTS).getAll());
  const docs = new Map(docList.map((doc) => [String(doc.id), doc]));
  const book = {};
  for (const entry of entryList) book[entry.id] = withNote(entry, docs.get(String(entry.id)));
  return book;
}
async function setBook(book) {
  const db = await ensureReady();
  const normalized = normalizeBook(book || {});
  const tx = db.transaction([STORE_ENTRIES, STORE_DOCUMENTS], "readwrite");
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
async function upsertItem({ id, type, title, url, platformId, platformName, status, note, tags }) {
  const db = await ensureReady();
  const key = String(id);
  const tx = db.transaction([STORE_ENTRIES, STORE_DOCUMENTS], "readwrite");
  const entryStore = tx.objectStore(STORE_ENTRIES);
  const docStore = tx.objectStore(STORE_DOCUMENTS);
  const prevEntry = await requestResult(entryStore.get(key));
  const prevDoc = await requestResult(docStore.get(key));
  const now = Date.now();
  const item = {
    id: key,
    type: type || prevEntry && prevEntry.type || "wrong",
    title: cleanTitle(title || "") || prevEntry && prevEntry.title || url || "\u672A\u547D\u540D",
    url: url || prevEntry && prevEntry.url || "",
    platform: platformId || prevEntry && prevEntry.platform || "",
    platformName: platformName || prevEntry && prevEntry.platformName || "",
    status: status != null ? status : prevEntry && prevEntry.status || STATUS.IMPORTANT,
    note: typeof note === "string" ? note.trim() : String(prevDoc && prevDoc.markdown || ""),
    tags: Array.isArray(tags) ? tags : prevEntry && prevEntry.tags || [],
    createdAt: Number(prevEntry && prevEntry.createdAt) || now,
    updatedAt: now
  };
  entryStore.put(entryRecord(item));
  docStore.put(documentRecord(item));
  await transactionDone(tx);
  notifyChange();
  return item;
}

// lib/application/knowledge/repository.ts
var defaultStore = {
  getBook,
  setBook,
  upsertItem,
  subscribeChanges: (listener) => subscribeKnowledgeChanges(() => listener())
};
function cloneItem(item) {
  return { ...item, tags: Array.isArray(item.tags) ? item.tags.slice() : [] };
}
function cloneBook(book) {
  const out = {};
  for (const [id, item] of Object.entries(book)) out[id] = cloneItem(item);
  return out;
}
var KnowledgeRepositoryImpl = class {
  store;
  listeners = /* @__PURE__ */ new Set();
  unsubscribeStore;
  cache = {};
  loaded = false;
  loadPromise = null;
  writeChain = Promise.resolve();
  disposed = false;
  constructor(store = defaultStore) {
    this.store = store;
    this.unsubscribeStore = store.subscribeChanges(() => {
      if (!this.disposed) void this.load(true).catch(() => {
      });
    });
  }
  get size() {
    return Object.keys(this.cache).length;
  }
  snapshot() {
    return cloneBook(this.cache);
  }
  get(id) {
    const item = this.cache[String(id)];
    return item ? cloneItem(item) : void 0;
  }
  list() {
    return Object.values(this.cache).map(cloneItem);
  }
  async load(force = false) {
    if (this.loadPromise) return this.loadPromise;
    if (!force && this.loaded) return cloneBook(this.cache);
    this.loadPromise = (async () => {
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
  async replace(book) {
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
  async update(id, updater) {
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
  async put(item) {
    const book = await this.putMany([item]);
    return book[String(item.id)];
  }
  async putMany(items) {
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
  async upsert(input) {
    await this.load();
    return this.enqueueWrite(async () => {
      const item = await this.store.upsertItem(input);
      this.cache = { ...this.cache, [String(item.id)]: item };
      this.notify();
      return cloneItem(item);
    });
  }
  async remove(id) {
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
  subscribe(listener) {
    if (typeof listener !== "function") return () => {
    };
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose() {
    this.disposed = true;
    this.listeners.clear();
    this.unsubscribeStore();
  }
  enqueueWrite(task) {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.then(
      () => void 0,
      () => void 0
    );
    return next;
  }
  notify() {
    for (const listener of this.listeners) {
      try {
        listener(cloneBook(this.cache));
      } catch (error) {
        console.warn("[KnowledgeRepository] listener failed:", error);
      }
    }
  }
};
function createKnowledgeRepository(store = defaultStore) {
  return new KnowledgeRepositoryImpl(store);
}

// lib/userscript/store.ts
var USERSCRIPTS_KEY = "recallflow.userscripts.v1";

// lib/page/markdown.ts
var HL_KEYWORDS = new Set(
  "function return if else for while do switch case break continue default new class extends super this const let var typeof instanceof in of try catch finally throw async await yield import export from as static get set null undefined true false void delete package private protected public interface type enum namespace module def elif lambda pass None True False and or not global raise with assert import print del class return if elif else".split(" ")
);
var HL_TYPES = new Set("String Number Boolean Array Object Function Promise Error Date RegExp Map Set Symbol BigInt Math JSON Console Node Buffer parseInt parseFloat isNaN isFinite JSON.stringify JSON.parse".split(" "));
function hlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function highlightCode(code) {
  const esc2 = hlEscape(code);
  const tokens = [];
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(\d+\.\d+|\d+\.?)\b|([A-Za-z_$][\w$]*)/g;
  let last = 0;
  let m;
  while (m = re.exec(esc2)) {
    if (m.index > last) tokens.push(esc2.slice(last, m.index));
    if (m[1]) tokens.push('<span class="tk-comment">' + m[1] + "</span>");
    else if (m[2]) tokens.push('<span class="tk-string">' + m[2] + "</span>");
    else if (m[3]) tokens.push('<span class="tk-number">' + m[3] + "</span>");
    else if (m[4]) {
      const w = m[4];
      if (HL_KEYWORDS.has(w)) tokens.push('<span class="tk-keyword">' + w + "</span>");
      else if (HL_TYPES.has(w)) tokens.push('<span class="tk-type">' + w + "</span>");
      else {
        const after = esc2.slice(m.index + w.length, m.index + w.length + 1);
        if (after === "(") tokens.push('<span class="tk-fn">' + w + "</span>");
        else tokens.push(w);
      }
    }
    last = m.index + m[0].length;
  }
  if (last < esc2.length) tokens.push(esc2.slice(last));
  return tokens.join("");
}
function sanitizeHref(raw) {
  const s = String(raw === void 0 || raw === null ? "" : raw).trim();
  if (!s) return "";
  const compact = s.replace(/[\u0000-\u0020\u007f]+/g, "");
  if (!compact) return "";
  if (/^(?:javascript|data|vbscript|file|blob):/i.test(compact)) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(compact) && !/^(?:https?|mailto|tel):/i.test(compact)) return "";
  return s;
}
function renderMarkdown(md, citations, streaming) {
  const lines = md.split("\n");
  let html = "";
  let inCode = false;
  let codeBuf = [];
  let codeLang = "";
  let listType = null;
  let tableBuf = null;
  const escInline = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const inline = (s) => {
    let r = escInline(s);
    r = r.replace(/`([^`]+)`/g, "<code>$1</code>");
    r = r.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    r = r.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, hrefRaw) => {
      const href = sanitizeHref(hrefRaw);
      if (!href) return text;
      return '<a href="' + href.replace(/"/g, "&quot;") + '" target="_blank" rel="noopener noreferrer">' + text + "</a>";
    });
    if (citations && citations.length) {
      r = r.replace(/[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g, (match, inner) => {
        const idx = extractCiteNum(inner);
        if (idx === null) return match;
        const c = citations[idx - 1];
        if (!c) return match;
        const short = c.title.length > 16 ? c.title.slice(0, 16) + "\u2026" : c.title;
        return '<button class="cite-badge" data-cite-id="' + escAttr(c.id || "") + '" data-cite-source="' + escAttr(c.source || "kb") + '" data-cite-url="' + escAttr(c.url || "") + '" data-cite-snippet="' + escAttr(c.snippet || "") + '" title="\u6253\u5F00\u8BC1\u636E\uFF1A' + escAttr(c.title) + '"><span class="cite-idx">[' + idx + "]</span>" + escAttr(short) + "</button>";
      });
    }
    return r;
  };
  const flushList = () => {
    if (listType) {
      html += "</" + listType + ">";
      listType = null;
    }
  };
  const isTableSep = (l) => /^\s*\|?[\s:\-|]+\|?\s*$/.test(l) && l.includes("-") && l.includes("|");
  const parseRow = (r) => {
    let t = r.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|")) t = t.slice(0, -1);
    return t.split("|").map((c) => c.trim());
  };
  const flushTable = () => {
    if (!tableBuf) return;
    const head = parseRow(tableBuf[0]);
    const rows = tableBuf.slice(2);
    html += '<div class="md-table-wrap"><table><thead><tr>' + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>" + rows.map((r) => "<tr>" + parseRow(r).map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
    tableBuf = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line.trim().startsWith("```")) {
      if (inCode) {
        html += '<div class="code-wrap"><div class="code-head"><span class="code-lang">' + (codeLang ? escAttr(codeLang) : "code") + '</span><button class="code-copy">\u590D\u5236</button></div><pre><code>' + highlightCode(codeBuf.join("\n")) + "</code></pre></div>";
        codeBuf = [];
        inCode = false;
        codeLang = "";
      } else {
        flushList();
        flushTable();
        inCode = true;
        codeLang = line.trim().slice(3).trim();
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (tableBuf) {
      if (line.trim() !== "" && line.includes("|")) {
        tableBuf.push(line);
        continue;
      }
      flushTable();
    } else if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushList();
      tableBuf = [line, lines[i + 1]];
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushList();
      flushTable();
      html += "<hr>";
      continue;
    }
    const mH = line.match(/^(#{1,4})\s+(.*)/);
    if (mH) {
      flushList();
      flushTable();
      const lv = mH[1].length;
      html += "<h" + lv + ">" + inline(mH[2]) + "</h" + lv + ">";
      continue;
    }
    const mUl = line.match(/^\s*[-*+]\s+(.*)/);
    if (mUl) {
      flushTable();
      if (listType !== "ul") {
        flushList();
        html += "<ul>";
        listType = "ul";
      }
      html += "<li>" + inline(mUl[1]) + "</li>";
      continue;
    }
    const mOl = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (mOl) {
      flushTable();
      if (listType !== "ol") {
        flushList();
        html += "<ol>";
        listType = "ol";
      }
      html += "<li>" + inline(mOl[1]) + "</li>";
      continue;
    }
    const mBq = line.match(/^\s*>\s?(.*)/);
    if (mBq) {
      flushList();
      flushTable();
      const buf = [mBq[1]];
      while (i + 1 < lines.length) {
        const m2 = lines[i + 1].replace(/\r$/, "").match(/^\s*>\s?(.*)/);
        if (!m2) break;
        buf.push(m2[1]);
        i++;
      }
      html += "<blockquote>" + buf.map(inline).join("<br>") + "</blockquote>";
      continue;
    }
    flushList();
    flushTable();
    if (line.trim() === "") {
      continue;
    }
    html += "<p>" + inline(line) + "</p>";
  }
  flushList();
  flushTable();
  if (streaming) {
    if (html.endsWith("</p>")) {
      html = html.slice(0, -4) + '<span class="stream-cursor"></span></p>';
    } else {
      html += '<p><span class="stream-cursor"></span></p>';
    }
  }
  return html || "<p>\uFF08\u65E0\u5185\u5BB9\uFF09</p>";
}
function extractCiteNum(inner) {
  const m = String(inner || "").match(/(\d{1,2})\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// lib/shared/pagination.ts
function clampPage(page, totalPages) {
  const total = Math.max(1, Math.floor(Number(totalPages) || 1));
  const wanted = Math.floor(Number(page) || 1);
  return Math.min(total, Math.max(1, wanted));
}
function pageSlice(items, page, pageSize) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  const pageCount = Math.max(1, Math.ceil(list.length / size));
  const current = clampPage(page, pageCount);
  const start = (current - 1) * size;
  return {
    items: list.slice(start, start + size),
    page: current,
    pageCount,
    total: list.length,
    start,
    end: Math.min(list.length, start + size)
  };
}
function pageTokens(currentPage2, totalPages) {
  const total = Math.max(1, Math.floor(Number(totalPages) || 1));
  const current = clampPage(currentPage2, total);
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const wanted = /* @__PURE__ */ new Set([1, total, current, current - 1, current + 1]);
  if (current <= 4) [2, 3, 4, 5].forEach((n) => wanted.add(n));
  if (current >= total - 3) [total - 4, total - 3, total - 2, total - 1].forEach((n) => wanted.add(n));
  const numbers = [...wanted].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out = [];
  for (const n of numbers) {
    const prev = out.length ? out[out.length - 1] : null;
    if (typeof prev === "number" && n - prev > 1) {
      out.push("ellipsis");
    }
    out.push(n);
  }
  return out;
}

// entries/manager.ts
var knowledge = createKnowledgeRepository();
var $ = (id) => document.getElementById(id);
var closestEl = (target, selector) => target ? target.closest(selector) : null;
var currentType = "all";
var currentTag = "all";
var currentStar = "all";
var sortBy = "updated";
var KB_PAGE_SIZE = 12;
var currentPage = 1;
var editingNoteId = null;
var selectedIds = /* @__PURE__ */ new Set();
var docItemId = "";
var docPreviousFocus = null;
var docKeyHandler = null;
function allTags() {
  const map = {};
  knowledge.list().forEach((it) => {
    (it.tags || []).forEach((t) => {
      if (t) map[t] = (map[t] || 0) + 1;
    });
  });
  return Object.keys(map).sort((a, b) => map[b] - map[a]);
}
function renderTypeTabs() {
  const el = $("type-tabs");
  const all = knowledge.list();
  let h = `<button class="type-tab${currentType === "all" ? " active" : ""}" data-type="all">\u5168\u90E8</button>`;
  ITEM_TYPES.forEach((t) => {
    const n = all.filter((i) => (i.type || "wrong") === t.id).length;
    h += `<button class="type-tab${currentType === t.id ? " active" : ""}" data-type="${t.id}" style="--t:${t.color}">${t.name} <span class="cnt">${n}</span></button>`;
  });
  el.innerHTML = h;
}
function renderTagFilter() {
  const tags = allTags();
  const el = $("tag-filter");
  if (!tags.length) {
    el.innerHTML = "";
    return;
  }
  let h = `<button class="tag-filter-chip${currentTag === "all" ? " active" : ""}" data-tag="all">\u5168\u90E8\u6807\u7B7E</button>`;
  tags.forEach((t) => {
    h += `<button class="tag-filter-chip${currentTag === t ? " active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`;
  });
  el.innerHTML = h;
}
function filtered() {
  let items = knowledge.list();
  if (currentType !== "all") {
    items = items.filter((i) => (i.type || "wrong") === currentType);
  }
  if (currentTag !== "all") {
    items = items.filter((i) => (i.tags || []).includes(currentTag));
  }
  if (currentStar !== "all") {
    items = items.filter((i) => String(i.status) === currentStar);
  }
  const q = $("search").value.trim().toLowerCase();
  if (q) {
    items = items.filter(
      (i) => (i.title + " " + (i.note || "") + " " + (i.tags || []).join(" ")).toLowerCase().includes(q)
    );
  }
  return sortItems(items, sortBy);
}
function renderBulkBar() {
  const bar = $("bulk-bar");
  if (selectedIds.size > 0) {
    bar.classList.remove("hidden");
    $("bulk-count").textContent = selectedIds.size + " \u9879\u5DF2\u9009";
    const items = filtered();
    const allSelected = items.length > 0 && items.every((it) => selectedIds.has(it.id));
    $("bulk-select-all-btn").textContent = allSelected ? "\u53D6\u6D88\u5168\u9009" : "\u5168\u9009";
  } else {
    bar.classList.add("hidden");
  }
}
function toggleSelect(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  renderBulkBar();
  document.querySelectorAll(".item-select").forEach((cb) => {
    const box = cb;
    box.checked = selectedIds.has(box.closest(".item").dataset.id);
  });
}
function itemHtml(it) {
  const editing = editingNoteId === it.id;
  const titleHtml = editing ? `<input id="title-editor" class="note-editor title-editor" value="${esc(it.title)}" placeholder="\u6807\u9898">` : it.url ? `<span class="item-title" data-open>${esc(it.title)}</span>` : `<span class="item-title" data-doc-open title="\u6253\u5F00 Markdown \u6587\u6863">${esc(it.title)}</span>`;
  const noteHtml = editing ? `<div class="doc-editor-wrap">
        <div class="doc-editor-hint">\u652F\u6301 Markdown \xB7 Ctrl/\u2318 + Enter \u4FDD\u5B58</div>
        <textarea id="note-editor" class="note-editor doc-editor" rows="8" placeholder="\u5199 Markdown \u6587\u6863\uFF0C\u652F\u6301\u6807\u9898\u3001\u5217\u8868\u3001\u8868\u683C\u3001\u4EE3\u7801\u5757\u548C\u94FE\u63A5\u2026">${esc(it.note || "")}</textarea>
      </div>` : it.note ? `<div class="item-note" data-note>${esc(markdownExcerpt(it.note, 180))}</div>` : "";
  const tagEditHtml = editing ? `<input id="tag-editor" class="note-editor" value="${esc((it.tags || []).join(", "))}" placeholder="\u6807\u7B7E\uFF0C\u9017\u53F7\u5206\u9694">` : tagsHtml(it.tags);
  const cbHtml = `<input type="checkbox" class="item-select" ${selectedIds.has(it.id) ? "checked" : ""}>`;
  return `<div class="item" data-id="${esc(it.id)}">
    <div class="item-head">
      ${cbHtml}
      ${typeBadgeHtml(it.type)}
      ${titleHtml}
      ${editing ? "" : `<span class="time">${fmtTime(it.updatedAt)}</span>`}
    </div>
    <div class="item-meta">
      ${starBarHtml(it.status, true)}
      ${levelNameHtml(it.status)}
      ${it.platformName ? `<span class="pf-name">${esc(it.platformName)}</span>` : ""}
    </div>
    <div class="note-row">${noteHtml}</div>
    <div class="tag-row">${tagEditHtml}</div>
    <div class="item-actions">
      ${editing ? `<button class="mini primary" data-act="save">\u2713 \u4FDD\u5B58</button><button class="mini" data-act="cancel">\u2715 \u53D6\u6D88</button>` : `<button class="mini" data-act="read">\u{1F4D6} \u9605\u8BFB</button><button class="mini" data-act="edit">\u270E \u7F16\u8F91</button><button class="mini danger" data-act="del">\u{1F5D1} \u5220\u9664</button>`}
    </div>
  </div>`;
}
function updateItemStar(itemEl, v) {
  const bar = itemEl.querySelector(".star-bar");
  if (bar) {
    bar.querySelectorAll(".star-cell").forEach((c, i) => {
      const on = i < v;
      c.classList.toggle("on", on);
      c.tabIndex = i === v - 1 ? 0 : -1;
      c.setAttribute("aria-checked", String(on));
    });
  }
  const lvl = itemEl.querySelector(".level-name");
  if (lvl) lvl.outerHTML = levelNameHtml(v);
}
function renderPagination(total, pageCount) {
  const nav = $("kb-pagination");
  if (!nav) return;
  const current = clampPage(currentPage, pageCount);
  currentPage = current;
  if (!total || pageCount <= 1) {
    nav.innerHTML = "";
    nav.hidden = true;
    return;
  }
  nav.hidden = false;
  const tokens = pageTokens(current, pageCount);
  nav.innerHTML = '<span class="kb-page-summary">\u7B2C ' + current + " / " + pageCount + " \u9875 \xB7 " + KB_PAGE_SIZE + ' \u6761/\u9875</span><button class="kb-page-btn" type="button" data-page="' + (current - 1) + '"' + (current === 1 ? " disabled" : "") + ">\u4E0A\u4E00\u9875</button>" + tokens.map((token) => {
    if (token === "ellipsis") return '<span class="kb-page-ellipsis" aria-hidden="true">\u2026</span>';
    return '<button class="kb-page-btn' + (token === current ? " active" : "") + '" type="button" data-page="' + token + '"' + (token === current ? ' aria-current="page"' : "") + ">" + token + "</button>";
  }).join("") + '<button class="kb-page-btn" type="button" data-page="' + (current + 1) + '"' + (current === pageCount ? " disabled" : "") + ">\u4E0B\u4E00\u9875</button>";
}
function render() {
  const listEl = $("list");
  const prevTop = listEl.scrollTop;
  const items = filtered();
  const paged = pageSlice(items, currentPage, KB_PAGE_SIZE);
  currentPage = paged.page;
  const emptyEl = $("empty");
  emptyEl.classList.toggle("hidden", items.length > 0);
  if (!items.length) {
    const hasAny = knowledge.size > 0;
    emptyEl.innerHTML = hasAny ? '<span class="empty-ico">\u{1F50D}</span><p>\u6CA1\u6709\u5339\u914D\u7684\u5185\u5BB9</p><p class="empty-hint">\u8BD5\u8BD5\u66F4\u6362\u7B5B\u9009\u6761\u4EF6\u6216\u641C\u7D22\u8BCD</p>' : '<span class="empty-ico">\u{1F4DA}</span><p>\u77E5\u8BC6\u5E93\u8FD8\u662F\u7A7A\u7684</p><p class="empty-hint">\u70B9\u51FB\u300C\u65B0\u5EFA\u7B14\u8BB0\u300D\u6216\u6536\u85CF\u7F51\u9875\u5F00\u59CB\u6536\u5F55</p>';
  }
  listEl.innerHTML = paged.items.map(itemHtml).join("");
  listEl.scrollTop = prevTop;
  renderTypeTabs();
  renderTagFilter();
  renderStats();
  renderBulkBar();
  renderActiveFilters();
  renderPagination(paged.total, paged.pageCount);
}
function renderActiveFilters() {
  const el = $("active-filter-list");
  const labels = [];
  if (currentType !== "all") labels.push("\u7C7B\u578B\uFF1A" + (ITEM_TYPES.find((t) => t.id === currentType)?.name || currentType));
  if (currentTag !== "all") labels.push("\u6807\u7B7E\uFF1A" + currentTag);
  if (currentStar !== "all") labels.push("\u661F\u7EA7\uFF1A" + currentStar);
  const q = $("search").value.trim();
  if (q) labels.push("\u641C\u7D22\uFF1A" + q);
  el.innerHTML = labels.length ? labels.map((x) => `<span class="active-filter-chip">${esc(x)}</span>`).join("") : '<span class="filter-empty">\u5168\u90E8\u5185\u5BB9</span>';
  const summary = $("advanced-filter-summary");
  if (summary) summary.textContent = labels.length ? labels.join(" \xB7 ") : "\u5168\u90E8\u5185\u5BB9";
  const details = $("advanced-filters");
  if (details && labels.length) details.open = true;
}
function renderStats() {
  const all = knowledge.list();
  $("st-total").textContent = String(all.length);
  [STATUS.GENERAL, STATUS.IMPORTANT, STATUS.FREQUENT].forEach((s) => {
    $("st-" + s).textContent = String(all.filter((i) => Number(i.status) === s).length);
  });
  document.querySelectorAll(".stars-lbl").forEach((el) => {
    const stars = Number(el.dataset.stars);
    el.innerHTML = starBarHtml(stars, false) + " " + (STAR_LEVELS[stars] || {}).name;
  });
  document.querySelectorAll(".stat-card").forEach((el) => {
    el.classList.toggle("active", el.dataset.s === currentStar);
  });
}
function genId() {
  return "note-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
}
async function saveEditingItem(id) {
  const titleInput = $("title-editor");
  const noteInput = $("note-editor");
  const tagsInput = $("tag-editor");
  if (!titleInput && !noteInput && !tagsInput) return;
  await knowledge.update(id, (item) => ({
    ...item,
    title: titleInput?.value.trim() || item.title,
    note: noteInput ? noteInput.value : item.note,
    tags: tagsInput ? parseTags(tagsInput.value) : item.tags,
    updatedAt: Date.now()
  }));
  editingNoteId = null;
  render();
}
async function createNote() {
  const id = genId();
  await knowledge.put({
    id,
    type: "note",
    title: "\u65B0\u7B14\u8BB0",
    url: "",
    platform: "",
    platformName: "",
    status: STATUS.IMPORTANT,
    note: "",
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  editingNoteId = id;
  currentPage = 1;
  render();
  const input = $("note-editor");
  if (input) input.focus();
}
function toast(msg, undoFn) {
  showToast(msg, { undoFn, duration: 4e3 });
}
function showConfirm(msg) {
  return new Promise((resolve) => {
    const overlay = $("confirm-overlay");
    const dialog = overlay.querySelector(".confirm-dialog");
    $("confirm-msg").textContent = msg;
    overlay.classList.remove("hidden");
    const prevFocus = document.activeElement;
    const yes = $("confirm-yes");
    const no = $("confirm-no");
    const cleanup = (result) => {
      overlay.classList.add("hidden");
      overlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      yes.removeEventListener("click", onYes);
      no.removeEventListener("click", onNo);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    const onBackdrop = (e) => {
      if (e.target === overlay) cleanup(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        cleanup(false);
        return;
      }
      if (e.key === "Tab") {
        const f = dialog.querySelectorAll("button:not([disabled])");
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    yes.addEventListener("click", onYes);
    no.addEventListener("click", onNo);
    overlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    yes.focus();
  });
}
function typeName(id) {
  return ITEM_TYPES.find((item) => item.id === id)?.name || id || "\u672A\u5206\u7C7B";
}
function closeDocument() {
  const overlay = $("doc-overlay");
  if (!overlay || overlay.classList.contains("hidden")) return;
  overlay.classList.add("hidden");
  document.body.classList.remove("modal-open");
  if (docKeyHandler) {
    document.removeEventListener("keydown", docKeyHandler, true);
    docKeyHandler = null;
  }
  $("doc-content").innerHTML = "";
  if (docPreviousFocus && docPreviousFocus.isConnected) {
    try {
      docPreviousFocus.focus();
    } catch (e) {
    }
  }
  docPreviousFocus = null;
  docItemId = "";
}
function openDocument(id) {
  const item = knowledge.get(id);
  if (!item) return;
  docItemId = id;
  docPreviousFocus = document.activeElement;
  $("doc-title").textContent = item.title || "\u672A\u547D\u540D\u6587\u6863";
  const tags = Array.isArray(item.tags) && item.tags.length ? " \xB7 " + item.tags.join(" / ") : "";
  $("doc-meta").textContent = typeName(item.type) + tags + " \xB7 " + fmtTime(item.updatedAt);
  $("doc-content").innerHTML = item.note && String(item.note).trim() ? renderMarkdown(String(item.note), null, false) : '<p class="doc-empty">\u8FD9\u7BC7\u5185\u5BB9\u8FD8\u6CA1\u6709\u6B63\u6587\u3002\u70B9\u51FB\u201C\u7F16\u8F91\u201D\u5F00\u59CB\u5199 Markdown\u3002</p>';
  const openBtn = $("doc-open");
  openBtn.disabled = !item.url;
  openBtn.title = item.url ? item.url : "\u8FD9\u6761\u5185\u5BB9\u6CA1\u6709\u539F\u6587\u94FE\u63A5";
  const overlay = $("doc-overlay");
  overlay.classList.remove("hidden");
  document.body.classList.add("modal-open");
  $("doc-close").focus();
  docKeyHandler = (e) => {
    if (!overlay.isConnected || overlay.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeDocument();
      return;
    }
    if (e.key !== "Tab") return;
    const dialog = overlay.querySelector(".doc-dialog");
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter((el) => el.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!dialog.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", docKeyHandler, true);
}
async function bulkDelete() {
  if (selectedIds.size === 0) return;
  const count = selectedIds.size;
  const ok = await showConfirm("\u786E\u5B9A\u5220\u9664 " + count + " \u9879\uFF1F");
  if (!ok) return;
  const backup = {};
  for (const id of selectedIds) {
    const item = knowledge.get(id);
    if (item) backup[id] = { ...item, tags: item.tags.slice() };
  }
  const next = { ...knowledge.snapshot() };
  for (const id of selectedIds) {
    delete next[id];
  }
  selectedIds.clear();
  await knowledge.replace(next);
  render();
  toast(count + " \u9879\u5DF2\u5220\u9664", async () => {
    await knowledge.putMany(Object.values(backup));
    render();
    toast("\u5DF2\u6062\u590D");
  });
}
$("type-tabs").addEventListener("click", (e) => {
  const btn = closestEl(e.target, ".type-tab");
  if (!btn) return;
  currentType = btn.dataset.type;
  currentPage = 1;
  render();
});
$("tag-filter").addEventListener("click", (e) => {
  const chip = closestEl(e.target, ".tag-filter-chip");
  if (!chip) return;
  currentTag = chip.dataset.tag;
  currentPage = 1;
  render();
});
document.querySelectorAll(".stat-card").forEach((el) => {
  el.addEventListener("click", () => {
    currentStar = el.dataset.s;
    currentPage = 1;
    render();
  });
});
$("search").addEventListener("input", debounce(() => {
  currentPage = 1;
  render();
}, 200));
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("search").focus();
  }
});
$("clear-filters").addEventListener("click", () => {
  currentType = "all";
  currentTag = "all";
  currentStar = "all";
  $("search").value = "";
  currentPage = 1;
  render();
});
$("sort-select").addEventListener("change", (e) => {
  sortBy = e.target.value;
  currentPage = 1;
  render();
});
$("add-note-btn").addEventListener("click", createNote);
$("kb-pagination").addEventListener("click", (e) => {
  const btn = closestEl(e.target, ".kb-page-btn");
  if (!btn || btn.disabled) return;
  const page = Number(btn.dataset.page);
  if (!Number.isFinite(page) || page < 1) return;
  currentPage = page;
  render();
  const list = $("list");
  if (list && list.scrollIntoView) list.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("doc-close").addEventListener("click", closeDocument);
$("doc-close-bottom").addEventListener("click", closeDocument);
$("doc-overlay").addEventListener("click", (e) => {
  if (e.target === $("doc-overlay")) closeDocument();
});
$("doc-open").addEventListener("click", () => {
  const item = knowledge.get(docItemId);
  if (item && item.url) chrome.tabs.create({ url: item.url });
});
$("doc-edit").addEventListener("click", () => {
  const id = docItemId;
  if (!id || !knowledge.get(id)) return;
  closeDocument();
  editingNoteId = id;
  render();
  const input = $("title-editor") || $("note-editor");
  if (input) input.focus();
});
$("doc-content").addEventListener("click", (e) => {
  const btn = closestEl(e.target, ".code-copy");
  if (!btn) return;
  const wrap = btn.closest(".code-wrap");
  const codeEl = wrap && wrap.querySelector("code");
  if (!codeEl) return;
  navigator.clipboard.writeText(codeEl.textContent || "").then(() => {
    btn.textContent = "\u5DF2\u590D\u5236";
    setTimeout(() => {
      btn.textContent = "\u590D\u5236";
    }, 1200);
  }).catch(() => {
  });
});
$("list").addEventListener("click", async (e) => {
  const itemEl = closestEl(e.target, ".item");
  if (!itemEl) return;
  const id = itemEl.dataset.id;
  const cb = closestEl(e.target, ".item-select");
  if (cb) {
    toggleSelect(id);
    return;
  }
  if (closestEl(e.target, ".item-note")) {
    editingNoteId = id;
    render();
    const input = $("note-editor");
    if (input) input.focus();
    return;
  }
  const starCell = closestEl(e.target, ".star-cell[data-star]");
  if (starCell) {
    const v = Number(starCell.dataset.star);
    if (!knowledge.get(id)) return;
    await knowledge.update(id, (item2) => ({ ...item2, status: v, updatedAt: Date.now() }));
    renderStats();
    updateItemStar(itemEl, v);
    return;
  }
  const act = closestEl(e.target, "[data-act]");
  if (act) {
    const a = act.dataset.act;
    if (a === "del") {
      const current = knowledge.get(id);
      if (!current) return;
      const backup = { ...current, tags: current.tags.slice() };
      const title = current.title || "\u6B64\u6761\u76EE";
      await knowledge.remove(id);
      if (editingNoteId === id) editingNoteId = null;
      render();
      toast("\u5DF2\u5220\u9664\u300C" + title + "\u300D", async () => {
        await knowledge.put(backup);
        render();
        toast("\u5DF2\u6062\u590D");
      });
    } else if (a === "read") {
      openDocument(id);
    } else if (a === "edit") {
      editingNoteId = id;
      render();
      const input = $("title-editor") || $("note-editor");
      if (input) input.focus();
    } else if (a === "save") {
      await saveEditingItem(id);
    } else if (a === "cancel") {
      editingNoteId = null;
      render();
    }
    return;
  }
  const item = knowledge.get(id);
  if (closestEl(e.target, ".item-title") && item) {
    if (item.url) chrome.tabs.create({ url: item.url });
    else if (item.note) openDocument(id);
  }
});
bindStarKeyboard($("list"), (v, cell) => {
  const itemEl = cell.closest(".item");
  if (!itemEl) return;
  const id = itemEl.dataset.id;
  if (!knowledge.get(id)) return;
  void knowledge.update(id, (item) => ({ ...item, status: v, updatedAt: Date.now() })).catch(() => toast("\u66F4\u65B0\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5"));
  renderStats();
  const lvl = itemEl.querySelector(".level-name");
  if (lvl) lvl.outerHTML = levelNameHtml(v);
});
$("list").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  if (e.target && e.target.tagName === "TEXTAREA" && !(e.ctrlKey || e.metaKey)) return;
  if (!editingNoteId) return;
  await saveEditingItem(editingNoteId);
});
$("export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(knowledge.snapshot(), null, 2)], {
    type: "application/json"
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "\u77E5\u8BC6\u5E93\u5907\u4EFD.json";
  a.click();
  URL.revokeObjectURL(a.href);
});
$("import-btn").addEventListener("click", () => {
  $("import-file").click();
});
function isValidImportItem(item) {
  if (!item || typeof item !== "object") return false;
  const candidate = item;
  if (typeof candidate.title !== "string" || !candidate.title.trim()) return false;
  const validTypes = ITEM_TYPES.map((t) => t.id);
  if (candidate.type && !validTypes.includes(candidate.type)) return false;
  if (candidate.status !== void 0 && ![STATUS.GENERAL, STATUS.IMPORTANT, STATUS.FREQUENT].includes(Number(candidate.status))) {
    return false;
  }
  if (candidate.tags && !Array.isArray(candidate.tags)) return false;
  if (candidate.url && typeof candidate.url !== "string") return false;
  return true;
}
$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      toast("\u65E0\u6548\u7684 JSON \u683C\u5F0F\uFF1A\u5E94\u4E3A\u5BF9\u8C61");
      return;
    }
    const imported = [];
    let skipped = 0;
    for (const [id, item] of Object.entries(data)) {
      if (isValidImportItem(item)) {
        const existing = knowledge.get(id);
        const now = Date.now();
        imported.push({
          id,
          type: item.type || existing?.type || "wrong",
          title: String(item.title || "").trim() || existing?.title || "\u672A\u547D\u540D",
          url: item.url || existing?.url || "",
          platform: item.platform || existing?.platform || "",
          platformName: item.platformName || existing?.platformName || "",
          status: item.status ?? existing?.status ?? STATUS.IMPORTANT,
          note: item.note ?? existing?.note ?? "",
          tags: item.tags ?? (existing ? existing.tags.slice() : []),
          createdAt: Number(item.createdAt) || existing?.createdAt || now,
          updatedAt: now
        });
      } else {
        skipped++;
        logError("Skipped invalid import item", { id, item });
      }
    }
    await knowledge.putMany(imported);
    const count = imported.length;
    render();
    toast(skipped > 0 ? `\u5DF2\u5BFC\u5165 ${count} \u9879\uFF0C\u8DF3\u8FC7 ${skipped} \u9879\u65E0\u6548\u6570\u636E` : `\u5DF2\u5BFC\u5165 ${count} \u9879`);
  } catch (err) {
    toast("\u5BFC\u5165\u5931\u8D25\uFF1A" + err.message);
    logError("Import failed", err);
  }
  e.target.value = "";
});
$("bulk-delete-btn").addEventListener("click", bulkDelete);
$("bulk-select-all-btn").addEventListener("click", () => {
  const items = filtered();
  const allSelected = items.length > 0 && items.every((it) => selectedIds.has(it.id));
  items.forEach((it) => {
    if (allSelected) selectedIds.delete(it.id);
    else selectedIds.add(it.id);
  });
  render();
});
$("bulk-cancel-btn").addEventListener("click", () => {
  selectedIds.clear();
  render();
});
document.addEventListener("keydown", (e) => {
  if (!$("confirm-overlay").classList.contains("hidden")) return;
  if ((e.ctrlKey || e.metaKey) && e.key === "k") {
    e.preventDefault();
    $("search").focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "a" && document.activeElement?.tagName !== "INPUT") {
    e.preventDefault();
    filtered().forEach((it) => selectedIds.add(it.id));
    render();
  }
  if (e.key === "Delete" && selectedIds.size > 0 && document.activeElement?.tagName !== "INPUT") {
    bulkDelete();
  }
  if (e.key === "Escape") {
    if (editingNoteId) {
      editingNoteId = null;
      render();
      return;
    }
    if (selectedIds.size > 0) {
      selectedIds.clear();
      render();
    }
  }
});
function focusItemFromHash() {
  const m = location.hash.match(/#focus=([^&]+)/);
  if (!m) return;
  const id = decodeURIComponent(m[1]);
  if (!knowledge.get(id)) {
    toast("\u672A\u627E\u5230\u8BE5\u6761\u76EE\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\uFF09");
    return;
  }
  currentType = "all";
  currentTag = "all";
  currentStar = "all";
  $("search").value = "";
  editingNoteId = null;
  const targetIndex = filtered().findIndex((item) => item.id === id);
  currentPage = targetIndex >= 0 ? Math.floor(targetIndex / KB_PAGE_SIZE) + 1 : 1;
  render();
  const el = document.querySelector('.item[data-id="' + CSS.escape(id) + '"]');
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash-highlight");
  setTimeout(() => el.classList.remove("flash-highlight"), 2600);
  if (history.replaceState) history.replaceState(null, "", location.pathname + location.search);
}
(async function init() {
  await knowledge.load();
  renderUserscriptBadge();
  render();
  focusItemFromHash();
  knowledge.subscribe(() => {
    if (editingNoteId) return;
    render();
  });
})();
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) knowledge.dispose();
});
async function renderUserscriptBadge() {
  const badge = $("us-count-badge");
  if (!badge) return;
  try {
    const data = await chrome.storage.local.get(USERSCRIPTS_KEY);
    const count = Object.keys(data[USERSCRIPTS_KEY] || {}).length;
    badge.textContent = String(count);
    badge.classList.toggle("hidden", count === 0);
  } catch (e) {
    badge.classList.add("hidden");
  }
}

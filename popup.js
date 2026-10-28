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
var PLATFORMS = [
  { id: "leetcode", name: "LeetCode", match: /leetcode\.cn|leetcode\.com/i },
  { id: "nowcoder", name: "\u725B\u5BA2\u7F51", match: /nowcoder\.com/i },
  { id: "luogu", name: "\u6D1B\u8C37", match: /luogu\.com\.cn|luogu\.org/i },
  { id: "acwing", name: "AcWing", match: /acwing\.com/i },
  { id: "codeforces", name: "Codeforces", match: /codeforces\.com/i },
  { id: "atcoder", name: "AtCoder", match: /atcoder\.jp/i }
];
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
function typeInfo(id) {
  return ITEM_TYPES.find((t) => t.id === id) || ITEM_TYPES[0];
}
function starColor(n) {
  return (STAR_LEVELS[Number(n)] || STAR_LEVELS[2]).color;
}
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.href;
  } catch (e) {
    return u;
  }
}
function detectPlatform(u) {
  for (const p of PLATFORMS) {
    if (p.match.test(u)) return { id: p.id, name: p.name };
  }
  return { id: "other", name: "\u5176\u4ED6\u5E73\u53F0" };
}
function detectType(url) {
  if (url && detectPlatform(url).id !== "other") return "wrong";
  return "article";
}
function isWebUrl(u) {
  return /^https?:/i.test(u);
}
function isFileUrl(u) {
  return /^file:\/\//i.test(String(u || ""));
}
function isOperableUrl(u) {
  return isWebUrl(u) || isFileUrl(u);
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
function sortItems(list, sortBy2) {
  const arr = list.slice();
  switch (sortBy2) {
    case "created":
      arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      break;
    case "star-desc":
      arr.sort(
        (a, b) => (b.status || 0) - (a.status || 0) || (b.updatedAt || 0) - (a.updatedAt || 0)
      );
      break;
    case "star-asc":
      arr.sort(
        (a, b) => (a.status || 0) - (b.status || 0) || (b.updatedAt || 0) - (a.updatedAt || 0)
      );
      break;
    default:
      arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return arr;
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
function platformColor(id) {
  return id === "other" ? "#95a5a6" : "#4a90d9";
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

// lib/userscript/store.ts
var USERSCRIPTS_KEY = "recallflow.userscripts.v1";

// entries/popup.ts
var bookCache = {};
var currentTab = null;
var currentUrl = null;
var currentTitle = null;
var platform;
var selectedType = "wrong";
var selectedStatus = STATUS.IMPORTANT;
var currentFilter = "all";
var sortBy = "updated";
var listQuery = "";
var ADD_COLLAPSED_KEY = "recallflow-popup-add-collapsed";
var POPUP_RECENT_LIMIT = 5;
var $ = (id) => document.getElementById(id);
var closest = (target, selector) => target ? target.closest(selector) : null;
function toast(msg, undoFn) {
  showToast(msg, { duration: 4e3, undoFn });
}
async function loadCache() {
  bookCache = await getBook();
}
async function persist() {
  await setBook(bookCache);
}
function renderTypePicker() {
  const el = document.querySelector("#add-panel .type-group");
  el.innerHTML = ITEM_TYPES.map(
    (t) => `<button class="type-btn${selectedType === t.id ? " active" : ""}" data-type="${t.id}" aria-pressed="${selectedType === t.id}" style="--t:${t.color}">${t.name}</button>`
  ).join("");
}
function syncStatusHighlight() {
  const barEl = document.querySelector("#add-panel .star-picker");
  if (!barEl) return;
  barEl.innerHTML = starBarHtml(selectedStatus, true);
  const nameEl = document.querySelector("#add-panel .star-picker-name");
  if (nameEl) nameEl.innerHTML = levelNameHtml(selectedStatus);
}
function renderList() {
  const listEl = $("list");
  const emptyEl = $("empty");
  let items = Object.values(bookCache);
  if (currentFilter !== "all") {
    items = items.filter((i) => (i.type || "wrong") === currentFilter);
  }
  const query = listQuery.trim().toLowerCase();
  const hasFilters = currentFilter !== "all" || Boolean(query);
  if (query) {
    items = items.filter((i) => `${i.title || ""} ${i.note || ""} ${(i.tags || []).join(" ")}`.toLowerCase().includes(query));
  }
  items = sortItems(items, sortBy);
  emptyEl.classList.toggle("hidden", items.length > 0);
  if (!items.length) {
    emptyEl.innerHTML = hasFilters ? '<span class="empty-ico">\u2315</span><p>\u6CA1\u6709\u5339\u914D\u7684\u5185\u5BB9</p><p class="empty-hint">\u8BD5\u8BD5\u66F4\u6362\u7B5B\u9009\u6761\u4EF6\u6216\u641C\u7D22\u8BCD</p>' : '<span class="empty-ico">\u{1F4DA}</span><p>\u8FD8\u6CA1\u6709\u5185\u5BB9</p><p class="empty-hint">\u6253\u5F00\u7F51\u9875\u540E\u70B9\u5DE5\u5177\u680F\u56FE\u6807\u5373\u53EF\u5FEB\u901F\u6536\u5F55</p>';
  }
  const total = Object.keys(bookCache).length;
  const shown = items.slice(0, POPUP_RECENT_LIMIT);
  listEl.innerHTML = shown.map(itemHtml).join("");
  $("total-badge").textContent = total + " \u6761";
  const visible = $("visible-count");
  if (visible) {
    visible.textContent = items.length ? hasFilters ? `\xB7 \u7B5B\u9009 ${items.length} \u6761\uFF0C\u663E\u793A\u524D ${shown.length} \u6761` : `\xB7 \u663E\u793A\u6700\u8FD1 ${shown.length} \u6761 / \u5171 ${total} \u6761` : "";
  }
  const viewAll = $("open-manager-all");
  if (viewAll) {
    viewAll.classList.toggle("hidden", total === 0);
    $("view-all-label").textContent = hasFilters ? "\u5728\u77E5\u8BC6\u5E93\u67E5\u770B\u7B5B\u9009\u7ED3\u679C" : "\u5728\u77E5\u8BC6\u5E93\u67E5\u770B\u5168\u90E8";
    $("all-items-count").textContent = String(hasFilters ? items.length : total);
    viewAll.title = hasFilters ? "\u6253\u5F00\u77E5\u8BC6\u5E93\u67E5\u770B\u5B8C\u6574\u7B5B\u9009\u7ED3\u679C" : "\u6253\u5F00\u77E5\u8BC6\u5E93\u67E5\u770B\u5168\u90E8\u5185\u5BB9";
  }
}
function itemHtml(it) {
  const type = it.type || "wrong";
  const urlLink = it.url ? `<span class="item-title" title="${esc(it.url)}">${esc(it.title)}</span>` : `<span class="item-title no-link">${esc(it.title)}</span>`;
  return `<div class="item" data-id="${esc(it.id)}">
    <div class="item-head">
      ${typeBadgeHtml(type)}
      ${urlLink}
      ${it.url ? '<button class="icon-btn open" title="\u6253\u5F00\u539F\u6587" aria-label="\u6253\u5F00\u539F\u6587">\u2197</button>' : ""}
      <button class="icon-btn del" title="\u5220\u9664" aria-label="\u5220\u9664\u6761\u76EE">\u2715</button>
    </div>
    ${it.note ? `<div class="item-note">${esc(markdownExcerpt(it.note, 120))}</div>` : ""}
    ${tagsHtml(it.tags)}
    <div class="item-meta">
      ${starBarHtml(it.status, true)}
      ${levelNameHtml(it.status)}
      ${it.platformName ? `<span class="platform-mini">${esc(it.platformName)}</span>` : ""}
      <span class="time">${fmtTime(it.updatedAt)}</span>
    </div>
  </div>`;
}
function isAllowedFileSchemeAccess() {
  return new Promise((resolve) => {
    try {
      if (!chrome.extension || typeof chrome.extension.isAllowedFileSchemeAccess !== "function") {
        resolve(true);
        return;
      }
      chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(allowed === true));
    } catch (e) {
      resolve(true);
    }
  });
}
async function init() {
  await loadCache();
  renderList();
  renderScriptsBadge();
  const shortcut = $("search-shortcut");
  if (shortcut) {
    const uaData = navigator.userAgentData;
    const uaPlatform = uaData && uaData.platform || navigator.platform || "";
    shortcut.textContent = /mac/i.test(uaPlatform) ? "\u2318 K" : "Ctrl K";
  }
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  const localFileBlocked = Boolean(t && t.url && isFileUrl(t.url) && !await isAllowedFileSchemeAccess());
  if (t && t.url && isOperableUrl(t.url) && !localFileBlocked) {
    currentTab = t;
    currentUrl = normalizeUrl(t.url);
    currentTitle = cleanTitle(t.title) || t.url;
    platform = detectPlatform(t.url);
    $("add-panel").classList.remove("hidden");
    $("page-unavailable").classList.add("hidden");
    selectedType = detectType(t.url);
    $("add-title").textContent = currentTitle;
    const pEl = $("add-platform");
    pEl.textContent = platform.name;
    pEl.style.background = platformColor(platform.id);
    pEl.classList.remove("hidden");
    if (bookCache[currentUrl]) {
      const rec = bookCache[currentUrl];
      $("add-exists").classList.remove("hidden");
      selectedType = rec.type || "wrong";
      selectedStatus = rec.status;
      $("tags-input").value = (rec.tags || []).join(", ");
      $("note-input").value = rec.note || "";
      $("add-btn").textContent = "\u66F4\u65B0";
    }
  } else {
    $("add-panel").classList.add("hidden");
    $("page-unavailable").classList.remove("hidden");
    const hint = $("unavailable-hint");
    if (hint) {
      hint.textContent = localFileBlocked ? "\u672C\u5730\u7F51\u9875\uFF1A\u8BF7\u5728\u6269\u5C55\u8BE6\u60C5\u91CC\u6253\u5F00\u300C\u5141\u8BB8\u8BBF\u95EE\u6587\u4EF6\u7F51\u5740\u300D" : "\u8BF7\u6253\u5F00\u666E\u901A\u7F51\u9875\u540E\u518D\u8BD5";
    }
  }
  renderTypePicker();
  syncStatusHighlight();
  try {
    setAddPanelCollapsed(localStorage.getItem(ADD_COLLAPSED_KEY) === "1", false);
  } catch (e) {
  }
}
async function renderScriptsBadge() {
  const badge = document.getElementById("scripts-badge");
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
$("add-btn").addEventListener("click", async () => {
  if (!currentUrl) return;
  const btn = $("add-btn");
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.textContent = "\u4FDD\u5B58\u4E2D\u2026";
  try {
    const tags = parseTags($("tags-input").value);
    await upsertItem({
      id: currentUrl,
      type: selectedType,
      title: currentTitle,
      url: currentUrl,
      platformId: platform.id,
      platformName: platform.name,
      status: selectedStatus,
      note: $("note-input").value,
      tags
    });
    await loadCache();
    $("add-exists").classList.remove("hidden");
    btn.textContent = "\u5DF2\u4FDD\u5B58 \u2713";
    renderList();
    toast("\u5DF2\u6536\u5F55\u5230\u77E5\u8BC6\u5E93");
    setTimeout(() => {
      if (btn.isConnected) btn.textContent = "\u66F4\u65B0";
    }, 1400);
  } catch (err) {
    btn.textContent = "\u4FDD\u5B58\u5931\u8D25\uFF0C\u91CD\u8BD5";
    toast("\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5");
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
});
["tags-input", "note-input"].forEach((id) => {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (id === "note-input" && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      $("add-btn").click();
    }
  });
});
document.querySelector("#add-panel .type-group").addEventListener("click", (e) => {
  const btn = closest(e.target, ".type-btn");
  if (!btn) return;
  selectedType = btn.dataset.type;
  renderTypePicker();
});
document.querySelector("#add-panel .star-picker").addEventListener("click", (e) => {
  const cell = closest(e.target, ".star-cell[data-star]");
  if (!cell) return;
  selectedStatus = Number(cell.dataset.star);
  syncStatusHighlight();
});
bindStarKeyboard(document, (v, cell) => {
  const picker = cell.closest("#add-panel .star-picker");
  if (picker) {
    selectedStatus = v;
    const nameEl = document.querySelector("#add-panel .star-picker-name");
    if (nameEl) nameEl.innerHTML = levelNameHtml(v);
    return;
  }
  const itemEl = cell.closest(".item");
  if (itemEl) {
    const id = itemEl.dataset.id;
    if (bookCache[id]) {
      bookCache[id].status = v;
      bookCache[id].updatedAt = Date.now();
      persist();
      const lvl = itemEl.querySelector(".level-name");
      if (lvl) lvl.outerHTML = levelNameHtml(v);
    }
  }
});
document.querySelectorAll(".filter-chip").forEach((c) => {
  c.addEventListener("click", () => {
    currentFilter = c.dataset.filter;
    document.querySelectorAll(".filter-chip").forEach((x) => {
      x.classList.toggle("active", x === c);
      x.setAttribute("aria-pressed", x === c ? "true" : "false");
    });
    renderList();
  });
});
$("sort-select").addEventListener("change", (e) => {
  sortBy = e.target.value;
  renderList();
});
$("list-search").addEventListener("input", debounce(() => {
  listQuery = $("list-search").value;
  renderList();
}, 200));
function setAddPanelCollapsed(collapsed, persist2 = true) {
  const addPanel = $("add-panel");
  const toggle = $("toggle-add-panel");
  addPanel.classList.toggle("is-collapsed", collapsed);
  toggle.textContent = collapsed ? "\u5C55\u5F00" : "\u6536\u8D77";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  if (persist2) {
    try {
      localStorage.setItem(ADD_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch (e) {
    }
  }
}
$("toggle-add-panel").addEventListener("click", () => {
  setAddPanelCollapsed(!$("add-panel").classList.contains("is-collapsed"));
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("list-search").focus();
  }
});
$("list").addEventListener("click", async (e) => {
  const itemEl = closest(e.target, ".item");
  if (!itemEl) return;
  const id = itemEl.dataset.id;
  if (closest(e.target, ".del")) {
    const removed = bookCache[id];
    delete bookCache[id];
    await persist();
    renderList();
    toast("\u5DF2\u5220\u9664", async () => {
      if (!removed) return;
      bookCache[id] = removed;
      await persist();
      renderList();
      toast("\u5DF2\u6062\u590D");
    });
    return;
  }
  if (closest(e.target, ".open") && bookCache[id] && bookCache[id].url) {
    chrome.tabs.create({ url: bookCache[id].url });
    return;
  }
  const starCell = closest(e.target, ".star-cell[data-star]");
  if (starCell) {
    const a = Number(starCell.dataset.star);
    const validStatuses = [STATUS.GENERAL, STATUS.IMPORTANT, STATUS.FREQUENT];
    if (bookCache[id] && validStatuses.includes(a)) {
      bookCache[id].status = a;
      bookCache[id].updatedAt = Date.now();
      await persist();
      const bar = itemEl.querySelector(".star-bar");
      if (bar) bar.querySelectorAll(".star-cell").forEach((c, i) => c.classList.toggle("on", i < a));
      const lvl = itemEl.querySelector(".level-name");
      if (lvl) lvl.outerHTML = levelNameHtml(a);
    }
    return;
  }
  if (closest(e.target, ".item-title") && bookCache[id] && bookCache[id].url) {
    chrome.tabs.create({ url: bookCache[id].url });
  }
});
var openManager = (e) => {
  e.preventDefault();
  const id = currentUrl && bookCache[currentUrl] ? currentUrl : null;
  const url = chrome.runtime.getURL("manager.html") + (id ? `#focus=${encodeURIComponent(id)}` : "");
  chrome.tabs.create({ url });
};
$("open-manager").addEventListener("click", openManager);
$("open-manager-top").addEventListener("click", openManager);
$("open-manager-all").addEventListener("click", openManager);
$("open-scripts").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("userscripts.html") });
});
var openSkillsBtn = $("open-skills");
if (openSkillsBtn) openSkillsBtn.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("skills.html") });
});
$("open-settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
$("open-assistant").addEventListener("click", async () => {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let tab = activeTab;
    if (!tab || !tab.url || !isOperableUrl(tab.url)) {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      tab = tabs.find((item) => item && item.url && isOperableUrl(item.url));
    }
    if (!tab || !tab.url || !isOperableUrl(tab.url)) {
      toast("\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u7F51\u9875");
      return;
    }
    chrome.runtime.sendMessage({ type: "panel:open-active", tabId: tab.id }, () => {
      if (chrome.runtime.lastError) toast("\u65E0\u6CD5\u6253\u5F00\u52A9\u624B\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5");
      else setTimeout(() => window.close(), 80);
    });
  } catch (e) {
    toast("\u65E0\u6CD5\u6253\u5F00\u52A9\u624B\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5");
  }
});
subscribeKnowledgeChanges(async () => {
  await loadCache();
  renderList();
});
init();

// lib/shared/constants.ts
var STATUS = {
  GENERAL: 1,
  // 一般
  IMPORTANT: 2,
  // 重点
  FREQUENT: 3
  // 高频
};
var STAR_LEVELS = {
  [STATUS.GENERAL]: { name: "\u4E00\u822C", color: "#f5b860" },
  [STATUS.IMPORTANT]: { name: "\u91CD\u70B9", color: "#f39c12" },
  [STATUS.FREQUENT]: { name: "\u9AD8\u9891", color: "#e74c3c" }
};

// lib/shared/utils.ts
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

// lib/userscript/settings.ts
var USERSCRIPT_SETTINGS_KEY = "recallflow.userscript.settings.v1";
var USERSCRIPT_SETTINGS_DEFAULTS = {
  // 允许 Agent 通过 install_userscript 自动安装脚本。
  agentCanInstall: true,
  // 打开脚本中心或扩展启动时，自动检查全部脚本更新。
  autoCheckUpdates: false,
  // 脚本未显式声明 @run-at 时的默认运行时机。
  defaultRunAt: "document-idle"
};
async function getUserscriptSettings() {
  const d = await chrome.storage.local.get(USERSCRIPT_SETTINGS_KEY);
  const saved = d[USERSCRIPT_SETTINGS_KEY] || {};
  return Object.assign({}, USERSCRIPT_SETTINGS_DEFAULTS, saved);
}

// entries/userscripts.js
var $ = (id) => document.getElementById(id);
var scriptsCache = [];
var currentFilter = "all";
var listQuery = "";
var pendingInstall = null;
var confirmResolve = null;
var updatingAll = false;
var lastFocus = null;
function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type, ...payload },
      (res) => resolve(res || { ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : "\u65E0\u54CD\u5E94" })
    );
  });
}
function toast(msg) {
  showToast(msg, { duration: 4e3 });
}
function switchView(view) {
  document.querySelectorAll(".us-tab").forEach((tab) => {
    const on = tab.dataset.view === view;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", String(on));
  });
  $("us-view-installed").classList.toggle("hidden", view !== "installed");
  $("us-view-discover").classList.toggle("hidden", view !== "discover");
  if (view === "discover") setTimeout(() => $("us-search-input").focus(), 60);
}
function scriptIconHtml(s) {
  const letter = String(s.name || "?").trim().charAt(0).toUpperCase() || "?";
  const icon = s.icon ? `background-image:url("${esc(s.icon)}")` : "";
  return `<span class="us-card-icon${icon ? " has-img" : ""}" style="${icon}" aria-hidden="true">${icon ? "" : esc(letter)}</span>`;
}
function matchesHtml(matches) {
  const list = matches || [];
  if (!list.length) return "";
  const shown = list.slice(0, 3);
  const more = list.slice(3);
  return `<div class="us-tags">${shown.map((m) => `<span class="us-tag">${esc(m)}</span>`).join("")}${more.length ? `<button class="us-tag us-tag-more" type="button" data-expand="1">\uFF0B${more.length} \u66F4\u591A</button>` : ""}</div>`;
}
function installedCardHtml(s) {
  const warns = s.warnings || [];
  return `
  <div class="us-card${s.enabled ? "" : " disabled"}" data-id="${esc(s.id)}">
    <div class="us-card-head">
      ${scriptIconHtml(s)}
      <div class="us-card-main">
        <div class="us-card-name-row">
          ${s.homepageURL ? `<a class="us-card-name" href="${esc(s.homepageURL)}" target="_blank" rel="noreferrer" title="\u6253\u5F00\u811A\u672C\u4E3B\u9875">${esc(s.name)}</a>` : `<span class="us-card-name">${esc(s.name)}</span>`}
          <span class="us-card-version">v${esc(s.version)}</span>
          ${s.author ? `<span class="us-card-author">by ${esc(s.author)}</span>` : ""}
        </div>
        ${s.description ? `<div class="us-card-desc">${esc(s.description)}</div>` : ""}
        ${matchesHtml(s.matches)}
        ${warns.length ? `<div class="us-warning">\u26A0 ${esc(warns.join("\n"))}</div>` : ""}
      </div>
      <label class="us-switch" title="${s.enabled ? "\u505C\u7528\u8BE5\u811A\u672C" : "\u542F\u7528\u8BE5\u811A\u672C"}">
        <input type="checkbox" data-act="toggle" ${s.enabled ? "checked" : ""} aria-label="${esc(s.enabled ? "\u505C\u7528" : "\u542F\u7528")} ${esc(s.name)}">
        <span class="us-switch-track" aria-hidden="true"></span>
      </label>
    </div>
    <div class="us-card-actions">
      <button class="mini primary" data-act="run" type="button" title="\u5728\u6700\u8FD1\u6D4F\u89C8\u7684\u7F51\u9875\u4E0A\u7ACB\u5373\u8FD0\u884C\uFF08\u4E0D\u8981\u6C42 URL \u5339\u914D\uFF09">\u25B6 \u8FD0\u884C</button>
      <button class="mini" data-act="update" type="button">\u21BB \u66F4\u65B0</button>
      <button class="mini" data-act="export" type="button">\u2B07 \u5BFC\u51FA</button>
      <details class="us-more">
        <summary class="mini" aria-label="\u66F4\u591A\u64CD\u4F5C">\u22EF</summary>
        <div class="us-more-panel">
          <button data-act="copy-url" type="button">\u590D\u5236\u5B89\u88C5\u94FE\u63A5</button>
          ${s.homepageURL ? '<button data-act="open-home" type="button">\u6253\u5F00\u811A\u672C\u4E3B\u9875</button>' : ""}
          <button data-act="uninstall" type="button" class="danger">\u5378\u8F7D\u811A\u672C</button>
        </div>
      </details>
    </div>
  </div>`;
}
function emptyStateHtml(scriptsLen, filtered) {
  if (!scriptsLen) {
    return {
      title: "\u8FD8\u6CA1\u6709\u5B89\u88C5\u811A\u672C",
      hint: "\u4ECE GreasyFork \u641C\u7D22\uFF0C\u6216\u7C98\u8D34 .user.js \u94FE\u63A5\u5B89\u88C5",
      cta: true
    };
  }
  if (filtered) {
    return {
      title: "\u6CA1\u6709\u5339\u914D\u7684\u811A\u672C",
      hint: "\u8BD5\u8BD5\u66F4\u6362\u7B5B\u9009\u6761\u4EF6\u6216\u5173\u952E\u8BCD",
      cta: false
    };
  }
  return { title: "\u8FD8\u6CA1\u6709\u811A\u672C", hint: "\u5B89\u88C5\u7684\u811A\u672C\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC", cta: true };
}
function renderInstalled() {
  const total = scriptsCache.length;
  const enabled = scriptsCache.filter((s) => s.enabled).length;
  $("us-stat-all").textContent = total;
  $("us-stat-enabled").textContent = enabled;
  $("us-stat-disabled").textContent = total - enabled;
  $("us-tab-installed-count").textContent = total;
  const navCount = $("us-nav-count");
  if (navCount) {
    navCount.textContent = total;
    navCount.classList.toggle("hidden", total === 0);
  }
  let list = scriptsCache;
  if (currentFilter === "enabled") list = list.filter((s) => s.enabled);
  if (currentFilter === "disabled") list = list.filter((s) => !s.enabled);
  const q = listQuery.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (s) => `${s.name} ${s.description || ""} ${s.author || ""} ${(s.matches || []).join(" ")}`.toLowerCase().includes(q)
    );
  }
  const filtered = list.length !== total;
  const empty = emptyStateHtml(total, filtered);
  $("us-empty").classList.toggle("hidden", list.length > 0);
  const emptyEl = $("us-empty");
  emptyEl.querySelector("p").textContent = empty.title;
  emptyEl.querySelector(".empty-hint").textContent = empty.hint;
  $("us-empty-discover").classList.toggle("hidden", !empty.cta);
  $("us-installed-list").innerHTML = list.map(installedCardHtml).join("");
}
async function refreshInstalled() {
  const res = await send("userscript:list");
  if (!res.ok) {
    toast(res.error || "\u52A0\u8F7D\u811A\u672C\u5217\u8868\u5931\u8D25");
    return;
  }
  scriptsCache = res.scripts || [];
  renderInstalled();
}
function findScript(id) {
  return scriptsCache.find((s) => s.id === id);
}
async function updateAll() {
  if (updatingAll) return;
  if (!scriptsCache.length) {
    toast("\u8FD8\u6CA1\u6709\u5DF2\u5B89\u88C5\u7684\u811A\u672C");
    return;
  }
  updatingAll = true;
  const btn = $("us-update-all-btn");
  const progress = $("us-update-progress");
  btn.disabled = true;
  progress.classList.remove("hidden");
  progress.innerHTML = '<span class="us-spinner" aria-hidden="true"></span><span>\u6B63\u5728\u68C0\u67E5\u66F4\u65B0\u2026</span>';
  try {
    const res = await send("userscript:updateAll");
    if (!res.ok) {
      toast(res.error || "\u68C0\u67E5\u66F4\u65B0\u5931\u8D25");
    } else if (res.total === 0) {
      toast("\u6CA1\u6709\u5DF2\u5B89\u88C5\u7684\u811A\u672C");
    } else {
      toast(`\u66F4\u65B0\u5B8C\u6210\uFF1A${res.updated} \u4E2A\u5DF2\u66F4\u65B0${res.failed ? `\uFF0C${res.failed} \u4E2A\u5931\u8D25` : ""}`);
      if (res.failed && res.errors && res.errors.length) {
        console.warn("[RecallFlow] \u66F4\u65B0\u5931\u8D25\uFF1A", res.errors);
      }
    }
  } finally {
    updatingAll = false;
    btn.disabled = false;
    progress.classList.add("hidden");
    await refreshInstalled();
  }
}
async function exportScript(id) {
  const s = findScript(id);
  if (!s || !s.code) {
    toast("\u8BE5\u811A\u672C\u6CA1\u6709\u53EF\u5BFC\u51FA\u7684\u4EE3\u7801");
    return;
  }
  const blob = new Blob([s.code], { type: "text/javascript;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = String(s.name || "script").replace(/[\\/:*?"<>|]/g, "_") + ".user.js";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast("\u5DF2\u5BFC\u51FA\u811A\u672C\u6587\u4EF6");
}
async function copyInstallUrl(id) {
  const s = findScript(id);
  if (!s) return;
  const url = s.sourceUrl || s.updateURL;
  if (!url) {
    toast("\u8BE5\u811A\u672C\u6CA1\u6709\u53EF\u590D\u5236\u7684\u5B89\u88C5\u94FE\u63A5");
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("\u5B89\u88C5\u94FE\u63A5\u5DF2\u590D\u5236");
  } catch (e) {
    toast("\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u590D\u5236");
  }
}
async function runSearch() {
  const q = $("us-search-input").value.trim();
  if (!q) return;
  const status = $("us-search-status");
  const listEl = $("us-search-list");
  $("us-results-title").textContent = `\u201C${q}\u201D \u7684\u641C\u7D22\u7ED3\u679C`;
  $("us-search-results").classList.remove("hidden");
  status.textContent = "\u641C\u7D22\u4E2D\u2026";
  listEl.innerHTML = "";
  const btn = $("us-search-btn");
  btn.disabled = true;
  try {
    const res = await send("userscript:search", { q });
    if (!res.ok) {
      status.textContent = "";
      toast(res.error || "\u641C\u7D22\u5931\u8D25");
      return;
    }
    const list = res.list || [];
    status.textContent = list.length ? `\u627E\u5230 ${list.length} \u4E2A\u811A\u672C` : "\u6CA1\u6709\u627E\u5230\u76F8\u5173\u811A\u672C\uFF0C\u8BD5\u8BD5\u5176\u4ED6\u5173\u952E\u8BCD";
    listEl.innerHTML = list.map(searchCardHtml).join("");
  } catch (e) {
    status.textContent = "";
    toast("\u641C\u7D22\u5931\u8D25\uFF1A" + e.message);
  } finally {
    btn.disabled = false;
  }
}
function searchCardHtml(it) {
  const updated = it.updatedAt ? new Date(it.updatedAt) : null;
  const updatedText = updated && !Number.isNaN(updated.getTime()) ? "\u66F4\u65B0\u4E8E " + updated.toLocaleDateString("zh-CN") : "";
  return `
  <div class="us-card">
    <div class="us-card-head">
      <span class="us-card-icon" aria-hidden="true">${esc(String(it.name).trim().charAt(0).toUpperCase() || "?")}</span>
      <div class="us-card-main">
        <div class="us-card-name-row">
          <span class="us-card-name">${esc(it.name)}</span>
          ${it.installs ? `<span class="us-card-version">${Number(it.installs).toLocaleString()} \u6B21\u5B89\u88C5</span>` : ""}
          ${updatedText ? `<span class="us-card-version">${esc(updatedText)}</span>` : ""}
        </div>
        ${it.description ? `<div class="us-card-desc">${esc(it.description)}</div>` : ""}
      </div>
    </div>
    <div class="us-card-actions">
      <button class="mini primary" data-url="${esc(it.codeUrl)}" type="button">\u5B89\u88C5</button>
      ${it.pageUrl ? `<a class="mini" href="${esc(it.pageUrl)}" target="_blank" rel="noreferrer">\u67E5\u770B\u8BE6\u60C5 \u2197</a>` : ""}
    </div>
  </div>`;
}
async function requestInstall(sourceUrl) {
  const res = await send("userscript:preview", { url: sourceUrl });
  if (!res.ok || !res.preview) {
    toast(res.error || "\u65E0\u6CD5\u89E3\u6790\u8BE5\u811A\u672C");
    return;
  }
  pendingInstall = { type: "url", source: sourceUrl };
  showPreview(res.preview);
}
async function requestInstallCode(code) {
  const res = await send("userscript:previewCode", { code });
  if (!res.ok || !res.preview) {
    toast(res.error || "\u65E0\u6CD5\u89E3\u6790\u8BE5\u811A\u672C");
    return;
  }
  pendingInstall = { type: "code", source: code };
  showPreview(res.preview);
}
function previewHtml(p) {
  const matches = p.matches || [];
  const grants = p.grants || [];
  const requires = p.requires || [];
  const warns = p.warnings || [];
  return `
    ${matches.length ? `<div class="us-preview-section">\u8BBF\u95EE\u7684\u7F51\u7AD9</div><div class="us-tags">${matches.map((m) => `<span class="us-tag">${esc(m)}</span>`).join("")}</div>` : ""}
    ${grants.length ? `<div class="us-preview-section">\u7533\u8BF7\u7684 GM API</div><div class="us-tags">${grants.map((g) => `<span class="us-tag">${esc(g)}</span>`).join("")}</div>` : ""}
    ${requires.length ? `<div class="us-preview-section">\u5916\u90E8\u4F9D\u8D56</div><div class="us-tags">${requires.map((r) => `<span class="us-tag">${esc(r)}</span>`).join("")}</div>` : ""}
    ${warns.length ? `<div class="us-warning">\u26A0 ${esc(warns.join("\n"))}</div>` : ""}
    <div class="us-preview-risk">\u811A\u672C\u53EF\u4EE5\u8BBF\u95EE\u5B83\u5339\u914D\u9875\u9762\u4E0A\u7684<b>\u6240\u6709\u5185\u5BB9</b>\uFF0C\u8BF7\u786E\u8BA4\u6765\u6E90\u53EF\u4FE1\u540E\u518D\u5B89\u88C5\u3002</div>`;
}
function showPreview(p) {
  const iconEl = $("us-preview-icon");
  iconEl.className = "us-card-icon" + (p.icon ? " has-img" : "");
  iconEl.style.backgroundImage = p.icon ? `url("${esc(p.icon)}")` : "";
  iconEl.textContent = p.icon ? "" : esc(String(p.name || "?").charAt(0).toUpperCase() || "?");
  $("us-preview-name").textContent = p.name + (p.version ? " \xB7 v" + p.version : "");
  $("us-preview-meta").textContent = [p.author, p.homepageURL].filter(Boolean).join(" \xB7 ");
  $("us-preview-body").innerHTML = previewHtml(p);
  lastFocus = document.activeElement;
  $("us-preview-overlay").classList.remove("hidden");
  $("us-preview-yes").focus();
}
function closePreview() {
  $("us-preview-overlay").classList.add("hidden");
  pendingInstall = null;
  if (lastFocus && lastFocus.focus) {
    lastFocus.focus();
    lastFocus = null;
  }
}
function openConfirm(message, yesText) {
  $("us-confirm-msg").textContent = message;
  $("us-confirm-yes").textContent = yesText || "\u786E\u8BA4";
  lastFocus = document.activeElement;
  $("us-confirm-overlay").classList.remove("hidden");
  $("us-confirm-yes").focus();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}
function closeConfirm(result) {
  $("us-confirm-overlay").classList.add("hidden");
  if (confirmResolve) {
    confirmResolve(result);
    confirmResolve = null;
  }
  if (lastFocus && lastFocus.focus) {
    lastFocus.focus();
    lastFocus = null;
  }
}
document.querySelectorAll(".us-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});
$("us-empty-discover").addEventListener("click", () => switchView("discover"));
document.querySelectorAll(".us-stat").forEach((stat) => {
  stat.addEventListener("click", () => {
    currentFilter = stat.dataset.filter;
    document.querySelectorAll(".us-stat").forEach((x) => {
      const on = x === stat;
      x.classList.toggle("active", on);
      x.setAttribute("aria-pressed", String(on));
    });
    renderInstalled();
  });
});
$("us-filter-input").addEventListener("input", (e) => {
  listQuery = e.target.value;
  renderInstalled();
});
$("us-installed-list").addEventListener("click", async (e) => {
  const card = e.target.closest(".us-card");
  if (!card) return;
  const id = card.dataset.id;
  const expandBtn = e.target.closest("[data-expand]");
  if (expandBtn) {
    const s = findScript(id);
    const tags = card.querySelector(".us-tags");
    if (s && tags) {
      tags.innerHTML = (s.matches || []).map((m) => `<span class="us-tag">${esc(m)}</span>`).join("");
    }
    return;
  }
  const act = e.target.closest("[data-act]");
  if (!act) return;
  const action = act.dataset.act;
  if (action === "update") {
    act.disabled = true;
    const res = await send("userscript:update", { id });
    act.disabled = false;
    toast(res.ok ? "\u5DF2\u66F4\u65B0\u5230\u6700\u65B0\u7248\u672C" : res.error || "\u66F4\u65B0\u5931\u8D25");
    refreshInstalled();
    return;
  }
  if (action === "run") {
    act.disabled = true;
    const res = await send("userscript:runOnTab", { id });
    act.disabled = false;
    if (res.ok) toast(res.result || "\u811A\u672C\u5DF2\u8FD0\u884C");
    else toast(res.error || "\u8FD0\u884C\u5931\u8D25");
    return;
  }
  if (action === "export") {
    exportScript(id);
    return;
  }
  if (action === "copy-url") {
    copyInstallUrl(id);
    card.querySelector(".us-more").removeAttribute("open");
    return;
  }
  if (action === "open-home") {
    const s = findScript(id);
    if (s && s.homepageURL) {
      card.querySelector(".us-more").removeAttribute("open");
      chrome.tabs.create({ url: s.homepageURL });
    }
    return;
  }
  if (action === "uninstall") {
    const s = findScript(id);
    card.querySelector(".us-more").removeAttribute("open");
    const ok = await openConfirm(`\u786E\u5B9A\u5378\u8F7D\u811A\u672C\u201C${s ? s.name : id}\u201D\uFF1F\u5378\u8F7D\u540E\u5176\u672C\u5730\u5B58\u50A8\u7684\u6570\u636E\u4E5F\u4F1A\u4E00\u5E76\u5220\u9664\u3002`, "\u5378\u8F7D");
    if (!ok) return;
    const res = await send("userscript:uninstall", { id });
    if (!res.ok) toast(res.error || "\u5378\u8F7D\u5931\u8D25");
    else toast("\u5DF2\u5378\u8F7D");
    refreshInstalled();
    return;
  }
});
$("us-installed-list").addEventListener("change", async (e) => {
  const input = e.target.closest('input[data-act="toggle"]');
  if (!input) return;
  const card = input.closest(".us-card");
  if (!card) return;
  const id = card.dataset.id;
  const res = await send("userscript:toggle", { id, enabled: input.checked });
  if (!res.ok) {
    toast(res.error || "\u5207\u6362\u5931\u8D25");
  } else {
    const s = findScript(id);
    if (s) s.enabled = input.checked;
  }
  renderInstalled();
});
$("us-update-all-btn").addEventListener("click", updateAll);
$("us-search-btn").addEventListener("click", runSearch);
$("us-search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});
$("us-url-install-btn").addEventListener("click", () => {
  const url = $("us-url-input").value.trim();
  if (!/^https?:\/\//i.test(url)) {
    toast("\u8BF7\u8F93\u5165\u6709\u6548\u7684\u811A\u672C\u94FE\u63A5");
    $("us-url-input").focus();
    return;
  }
  requestInstall(url);
});
$("us-code-install-btn").addEventListener("click", () => {
  const code = $("us-code-input").value.trim();
  if (!code) {
    toast("\u8BF7\u5148\u7C98\u8D34\u811A\u672C\u4EE3\u7801");
    $("us-code-input").focus();
    return;
  }
  requestInstallCode(code);
});
$("us-search-list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-url]");
  if (btn) requestInstall(btn.dataset.url);
});
$("us-preview-yes").addEventListener("click", async () => {
  const pending = pendingInstall;
  closePreview();
  if (!pending) return;
  const res = pending.type === "code" ? await send("userscript:installCode", { code: pending.source, label: "\u7C98\u8D34\u4EE3\u7801" }) : await send("userscript:install", { url: pending.source });
  if (res.ok) {
    toast("\u5DF2\u5B89\u88C5\uFF1A" + (res.script && res.script.name));
    switchView("installed");
  } else {
    toast(res.error || "\u5B89\u88C5\u5931\u8D25");
  }
  refreshInstalled();
});
$("us-preview-no").addEventListener("click", closePreview);
$("us-confirm-yes").addEventListener("click", () => closeConfirm(true));
$("us-confirm-no").addEventListener("click", () => closeConfirm(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("us-preview-overlay").classList.contains("hidden")) closePreview();
    if (!$("us-confirm-overlay").classList.contains("hidden")) closeConfirm(false);
    return;
  }
  if (e.key === "Tab") {
    const trap = (id) => {
      const ov = $(id);
      if (ov.classList.contains("hidden")) return;
      const f = ov.querySelectorAll(".confirm-dialog button:not([disabled])");
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
    };
    trap("us-preview-overlay");
    trap("us-confirm-overlay");
  }
});
document.querySelectorAll(".confirm-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      if (overlay.id === "us-preview-overlay") closePreview();
      else closeConfirm(false);
    }
  });
});
(async function init() {
  if (location.hash === "#discover") switchView("discover");
  await refreshInstalled();
  const settings = await getUserscriptSettings();
  if (settings.autoCheckUpdates && scriptsCache.length) updateAll();
})();

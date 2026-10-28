(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // lib/shared/constants.ts
  var HIGHLIGHT_MAX_TEXTS = 20;
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
  function logError(context, error) {
    console.warn(`[BookmarkSorter] ${context}:`, error);
  }
  function formatElementLocator(locator, selector, tag) {
    const l = locator || {};
    if (l.role) return "role=" + l.role + (l.name ? ' name="' + l.name + '"' : "");
    if (l.name) return 'name="' + l.name + '"';
    if (l.testid) return "testid=" + l.testid;
    return String(selector || tag || "");
  }
  function summarizePickedForMessage(picked) {
    if (!Array.isArray(picked)) return [];
    return picked.filter((p) => p && typeof p === "object").slice(0, 8).map((p) => {
      const src = p.source || {};
      return {
        tag: sliceSafe(String(p.tag || ""), 0, 40),
        label: sliceSafe(String(p.label || ""), 0, 60),
        loc: src.file ? sliceSafe(String(src.file), 0, 200) + (src.line ? ":" + src.line : "") : "",
        locator: sliceSafe(formatElementLocator(p.locator, p.selector, p.tag), 0, 200)
      };
    });
  }
  function formatPickedSummary(picks) {
    const list = Array.isArray(picks) ? picks.filter(Boolean) : [];
    if (!list.length) return "";
    return list.map(
      (p, i) => (list.length > 1 ? i + 1 + ". " : "") + (p.tag || "\u5143\u7D20") + (p.label ? "\u300C" + p.label + "\u300D" : "") + (p.loc ? " \u2192 " + p.loc : "")
    ).join("\uFF1B");
  }
  function pickedSummaryHtml(picks) {
    const list = Array.isArray(picks) ? picks.filter(Boolean) : [];
    if (!list.length) return "";
    const title = list.map((p) => p.locator).filter(Boolean).join(" / ");
    return '<span class="user-picks"' + (title ? ' title="' + esc(title) + '"' : "") + ">\u27E1 " + esc(formatPickedSummary(list)) + "</span>";
  }
  function selectedTextMessageHtml(selectedText) {
    const text = String(selectedText || "").trim();
    if (!text) return "";
    return '<span class="user-selection" title="' + esc(text) + '"><span class="user-selection-label">\u9875\u9762\u5F15\u7528</span><span class="user-selection-text">' + esc(text) + "</span></span>";
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
  function formatSelectOptions(items) {
    if (!Array.isArray(items) || !items.length) return "";
    return items.map((it, i) => {
      const parts = ["[" + (i + 1) + "]", 'value="' + String(it.value == null ? "" : it.value) + '"'];
      parts.push('\u6587\u5B57="' + String(it.label == null ? "" : it.label) + '"');
      if (it.selected) parts.push("\uFF08\u5F53\u524D\u9009\u4E2D\uFF09");
      if (it.disabled) parts.push("\uFF08\u7981\u7528\uFF09");
      return parts.join(" ");
    }).join("\n");
  }
  function formatInvalidControls(items) {
    if (!Array.isArray(items) || !items.length) return "";
    const lines = items.map(
      (it, i) => "[" + (i + 1) + "] " + it.selector + (it.name ? "\uFF08" + it.name + "\uFF09" : "") + " \u539F\u56E0\uFF1A" + ((it.reasons || []).join("+") || "\u672A\u77E5") + (it.message ? " \u2014\u2014 " + it.message : "")
    );
    return "\n\u26A0 \u8868\u5355\u672A\u901A\u8FC7\u6821\u9A8C\uFF08" + items.length + " \u4E2A\u5B57\u6BB5\uFF09\u2014\u2014 **\u63D0\u4EA4\u4F1A\u88AB\u6D4F\u89C8\u5668\u62E6\u4F4F\u3001\u9875\u9762\u4E0A\u4E0D\u4F1A\u6709\u4EFB\u4F55\u63D0\u793A**\uFF1A\n" + lines.join("\n");
  }
  function formatStylesSummary(items, total) {
    const list = Array.isArray(items) ? items : [];
    const n = typeof total === "number" && total > list.length ? total : list.length;
    const head = "\u8BA1\u7B97\u6837\u5F0F\uFF08\u547D\u4E2D " + n + " \u4E2A" + (n > list.length ? "\uFF0C\u5217\u51FA\u524D " + list.length + " \u4E2A" : "") + "\uFF09\uFF1A";
    if (!list.length) return head + "\uFF08\u65E0\uFF09";
    const lines = list.map((it) => {
      const s = it && it.styles || {};
      const pairs = Object.keys(s).map((k) => k + "=" + s[k]).join("  ");
      return "  " + (it && (it.selector || it.tag) || "?") + (it && it.visible === false ? "\uFF08\u4E0D\u53EF\u89C1\uFF09" : "") + "\uFF1A" + (pairs || "\uFF08\u65E0\uFF09");
    });
    return head + "\n" + lines.join("\n");
  }
  function formatInspectMatches(matches) {
    const list = Array.isArray(matches) ? matches.filter(Boolean) : [];
    if (!list.length) return "";
    return list.map((m) => {
      const bits = [m.selector || m.tag || "?"];
      bits.push(m.visible === false ? "\u4E0D\u53EF\u89C1" : "\u53EF\u89C1");
      if (m.size && (m.size.w || m.size.h)) bits.push(m.size.w + "\xD7" + m.size.h);
      if (typeof m.textLength === "number") bits.push("\u6587\u672C " + m.textLength + " \u5B57");
      if (m.shadowDepth) bits.push("shadow \u6DF1\u5EA6 " + m.shadowDepth);
      if (m.containsMainContent) bits.push("\u7591\u4F3C\u542B\u6B63\u6587");
      let s = "  - " + bits.join("\uFF5C");
      if (m.path) s += "\n    \u7956\u5148\u94FE\uFF1A" + m.path;
      return s;
    }).join("\n");
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function formatInspectSummary(input) {
    const o = input || {};
    const total = Math.max(0, Math.floor(Number(o.total) || 0));
    const listed = Math.max(0, Math.floor(Number(o.listed) || 0));
    const visible = Math.max(0, Math.floor(Number(o.visibleCount) || 0));
    const hidden = Math.max(0, listed - visible);
    const hiddenText = hidden ? "\uFF0C\u4E0D\u53EF\u89C1 " + hidden + " \u4E2A" : "";
    let s = "\u547D\u4E2D " + total + " \u4E2A\u5143\u7D20\u3002";
    if (o.truncated) {
      s += "\uFF08\u547D\u4E2D\u8FC7\u591A\uFF0C\u4EC5\u5217\u51FA\u524D " + listed + " \u4E2A\uFF09\u5217\u51FA\u90E8\u5206\u4E2D\u53EF\u89C1 " + visible + " \u4E2A" + hiddenText + "\u3002";
    } else {
      s += "\u53EF\u89C1 " + visible + " \u4E2A" + hiddenText + "\u3002";
    }
    const main = o.main;
    if (o.touchesMain && main && main.selector) {
      s += " \u547D\u4E2D\u9879\u5305\u542B\u7591\u4F3C\u6B63\u6587\u5BB9\u5668 " + main.selector + "\uFF08\u7EA6 " + main.textLength + " \u5B57\uFF09\u2014\u2014 \u9690\u85CF\u5E7F\u544A\u65F6\u4E0D\u8981\u8FDE\u5E26\u9690\u85CF\u5B83\u6216\u5176\u7956\u5148\u3002";
    }
    return s;
  }
  var SNAPSHOT_CHAR_BUDGET = 12e3;
  var SNAPSHOT_FIXED_ALLOWANCE = 600;
  function trimElementsToBudget(described, textLength, budget = SNAPSHOT_CHAR_BUDGET) {
    const list = Array.isArray(described) ? described : [];
    const limit = Math.max(0, Number(budget) || 0);
    const elements = [];
    let used = Math.max(0, Number(textLength) || 0) + SNAPSHOT_FIXED_ALLOWANCE;
    for (const d of list) {
      let size = 0;
      try {
        size = JSON.stringify(d).length + 1;
      } catch (e) {
        size = 0;
      }
      if (elements.length && used + size > limit) break;
      elements.push(d);
      used += size;
    }
    return { elements, omittedBySize: list.length - elements.length };
  }
  function formatHighlightResult(input) {
    const o = input || {};
    const num = (v) => Math.max(0, Math.floor(Number(v) || 0));
    const hit = num(o.hit);
    const attempted = num(o.attempted);
    const requested = Math.max(attempted, num(o.requested));
    const limit = num(o.limit);
    const misses = Array.isArray(o.misses) ? o.misses : [];
    const dropped = requested - attempted;
    let s = "\u5DF2\u9AD8\u4EAE " + hit + " / " + attempted + " \u5904\u5173\u952E\u4FE1\u606F";
    if (misses.length) {
      s += "\uFF1B\u672A\u627E\u5230 " + misses.length + " \u6761\uFF1A" + misses.map((m) => {
        const t = String(m == null ? "" : m);
        return sliceSafe(t, 0, 16) + (t.length > 16 ? "\u2026" : "");
      }).join("\u3001");
    }
    if (dropped > 0) {
      s += "\uFF1B\u672C\u6B21\u5171\u6536\u5230 " + requested + " \u6761\uFF0C\u8D85\u51FA\u5355\u6B21\u4E0A\u9650 " + limit + " \u6761\u7684 " + dropped + ' \u6761**\u672A\u5904\u7406**\uFF0C\u8BF7\u518D\u8C03\u7528\u4E00\u6B21 annotate({op:"highlight", texts:[\u2026]}) \u4F20\u5269\u4F59\u7247\u6BB5';
    }
    return s;
  }
  function composeProgressText(step, max, label) {
    const parts = [];
    const n = Number(step);
    const m = Number(max);
    if (Number.isFinite(n) && n > 0) {
      parts.push("\u7B2C " + Math.floor(n) + (Number.isFinite(m) && m > 0 ? " / " + Math.floor(m) : "") + " \u6B65");
    }
    const text = String(label === void 0 || label === null ? "" : label).trim();
    if (text) parts.push(text);
    return parts.length ? parts.join(" \xB7 ") : "\u6B63\u5728\u601D\u8003\u2026";
  }

  // lib/page/citation.ts
  var PAGE_TEXT_EXCLUDE = "script,style,noscript,iframe,svg,canvas,nav,header,footer,aside,form,button,input,select,textarea,[contenteditable],.ad,.ads,.advertisement,.banner,[class*=cookie],[id*=cookie],[class*=popup],[class*=modal],#__kb-ai-host,#toast,[data-rf-injected]";
  function closestComposed(el, selector) {
    let node = el;
    try {
      while (node && node.nodeType === 1) {
        if (node.matches && node.matches(selector)) return node;
        const parent = node.parentNode;
        if (parent && parent.nodeType === 11 && parent.host) node = parent.host;
        else node = parent;
      }
    } catch (e) {
      return null;
    }
    return null;
  }
  function isPageContentExcluded(el) {
    return Boolean(el && closestComposed(el, PAGE_TEXT_EXCLUDE));
  }
  var ELEMENT_COLLECT_EXCLUDE = "#__kb-ai-host,#toast,[data-rf-injected],script,style,noscript";
  function isElementCollectExcluded(el) {
    return Boolean(el && closestComposed(el, ELEMENT_COLLECT_EXCLUDE));
  }
  var citeHighlightRange = null;
  var citeHighlightEntered = false;
  function normalizeMatchChar(ch) {
    const FULL = {
      "\uFF0C": ",",
      "\u3001": ",",
      "\u3002": ".",
      "\uFF0E": ".",
      "\uFF08": "(",
      "\uFF09": ")",
      "\uFF3B": "[",
      "\uFF3D": "]",
      "\u3010": "[",
      "\u3011": "]",
      "\uFF1A": ":",
      "\uFF1B": ";",
      "\uFF1F": "?",
      "\uFF01": "!",
      "\u201C": '"',
      "\u201D": '"',
      "\u2018": "'",
      "\u2019": "'",
      "\uFF40": "`",
      "\uFF5E": "~",
      "\u2026": "...",
      "\u2014": "-",
      "\u2013": "-"
    };
    return FULL[ch] || ch;
  }
  function normalizeCitationText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").split("").map(normalizeMatchChar).join("").trim();
  }
  function isCitationTextNode(node) {
    const parent = node && node.parentElement;
    if (!parent || parent.closest(PAGE_TEXT_EXCLUDE)) return false;
    try {
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") return false;
    } catch (e) {
    }
    return true;
  }
  function clearCiteHighlight() {
    disposeOverlays("cite");
    citeHighlightRange = null;
    citeHighlightEntered = false;
  }
  function isPointerInCitationRange(event) {
    if (!citeHighlightRange) return false;
    try {
      return Array.prototype.some.call(
        citeHighlightRange.getClientRects(),
        (rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
      );
    } catch (e) {
      return false;
    }
  }
  function buildPageCharMap() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    const charNode = [];
    const charOffset = [];
    let text = "";
    while (n = walker.nextNode()) {
      if (!isCitationTextNode(n)) continue;
      const v = n.nodeValue || "";
      for (let i = 0; i < v.length; i++) {
        if (/\s/.test(v[i])) continue;
        text += normalizeMatchChar(v[i]);
        charNode.push(n);
        charOffset.push(i);
      }
    }
    return { text, charNode, charOffset };
  }
  function rangeFromCharMap(start, length, map) {
    if (length <= 0 || start + length > map.text.length) return null;
    const sNode = map.charNode[start];
    const sOff = map.charOffset[start];
    const eNode = map.charNode[start + length - 1];
    const eOff = map.charOffset[start + length - 1] + 1;
    const range = document.createRange();
    range.setStart(sNode, sOff);
    range.setEnd(eNode, eOff);
    return range;
  }
  var MIN_SNIPPET_LEN = 10;
  function findRangeBySubstr(map, snippet) {
    const q = normalizeCitationText(snippet).replace(/\s+/g, "");
    if (!q) return null;
    if (q.length < MIN_SNIPPET_LEN) {
      const at = map.text.indexOf(q);
      return at < 0 ? null : rangeFromCharMap(at, q.length, map);
    }
    const findAll = (needle) => {
      const indexes = [];
      let from = 0;
      while (needle.length >= MIN_SNIPPET_LEN) {
        const at = map.text.indexOf(needle, from);
        if (at < 0) break;
        indexes.push(at);
        from = at + 1;
      }
      return indexes;
    };
    if (q.length >= 120) {
      const prefix = q.slice(0, 120);
      const suffix = q.slice(-100);
      for (const start of findAll(prefix)) {
        const endStart = map.text.indexOf(suffix, start + prefix.length);
        if (endStart >= 0 && endStart - start <= q.length + 240) {
          return rangeFromCharMap(start, endStart + suffix.length - start, map);
        }
      }
    }
    const candidates = [q];
    if (q.length > 80) {
      candidates.push(q.slice(0, 80));
      candidates.push(q.slice(Math.floor(q.length / 2), Math.floor(q.length / 2) + 80));
      candidates.push(q.slice(-80));
    }
    for (const cand of candidates) {
      if (cand.length < MIN_SNIPPET_LEN) continue;
      const indexes = findAll(cand);
      if (indexes.length) return rangeFromCharMap(indexes[0], cand.length, map);
    }
    for (let len = Math.min(q.length, 80); len >= MIN_SNIPPET_LEN; len = Math.floor(len * 0.6)) {
      const sub = q.slice(0, len);
      const j = map.text.indexOf(sub);
      if (j >= 0) return rangeFromCharMap(j, sub.length, map);
    }
    const anchors = (q.match(/[\u4e00-\u9fa5A-Za-z0-9]{6,}/g) || []).sort((a, b) => b.length - a.length);
    for (const anchor of anchors.slice(0, 3)) {
      const j = map.text.indexOf(anchor);
      if (j >= 0) return rangeFromCharMap(j, anchor.length, map);
    }
    return null;
  }
  function makeOverlay(rect, color, outline2) {
    const d = document.createElement("div");
    const fill = outline2 ? "" : "background-color:" + normalizeFillColor(color) + ";";
    d.style.cssText = "position:fixed;left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" + rect.height + "px;" + (outline2 ? "border:2px solid " + color + ";background:transparent;" : fill) + "border-radius:2px;pointer-events:none;z-index:2147483646;";
    document.body.appendChild(d);
    return d;
  }
  function normalizeFillColor(color) {
    const fallback = overlayColor();
    const cap = 0.32;
    const floor = 0.12;
    let c = String(color || "").trim();
    let m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (m) {
      let hex = m[1];
      if (hex.length === 3) hex = hex.split("").map((ch) => ch + ch).join("");
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return "rgba(" + r + "," + g + "," + b + "," + Math.min(cap, Math.max(floor, a)) + ")";
    }
    m = c.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const parts = m[1].split(",").map((s) => s.trim());
      if (parts.length >= 3) {
        let a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
        if (!Number.isFinite(a)) a = 1;
        return "rgba(" + parts[0] + "," + parts[1] + "," + parts[2] + "," + Math.min(cap, Math.max(floor, a)) + ")";
      }
    }
    return fallback;
  }
  function overlayColor() {
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "rgba(255,196,0,.20)" : "rgba(255,196,0,.26)";
  }
  var liveOverlays = [];
  var repositionQueued = false;
  function rebuildOverlay(item) {
    const rects = item.buildRects();
    if (item.els && item.els.length === rects.length) {
      item.els.forEach((d, i) => {
        const r = rects[i];
        d.style.left = r.left + "px";
        d.style.top = r.top + "px";
        d.style.width = r.width + "px";
        d.style.height = r.height + "px";
      });
      return item.els;
    }
    if (item.els) item.els.forEach((d) => {
      if (d.parentNode) d.parentNode.removeChild(d);
    });
    item.els = rects.map((r) => makeOverlay(r, item.color, item.outline));
    return item.els;
  }
  function repositionAll() {
    for (const item of liveOverlays) {
      try {
        rebuildOverlay(item);
      } catch (e) {
      }
    }
  }
  function scheduleReposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        repositionQueued = false;
        repositionAll();
      });
    } else {
      repositionQueued = false;
      repositionAll();
    }
  }
  if (typeof window !== "undefined") {
    window.addEventListener("scroll", scheduleReposition, true);
    window.addEventListener("resize", scheduleReposition);
  }
  function overlayRange(range, color, owner) {
    const item = {
      color: color || overlayColor(),
      outline: false,
      owner: owner || "default",
      buildRects: () => {
        try {
          return Array.prototype.slice.call(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        } catch (e) {
          return [];
        }
      }
    };
    item.els = rebuildOverlay(item);
    liveOverlays.push(item);
    return item.els;
  }
  function overlayElement(el, color, outline2, owner) {
    const item = {
      color: color || overlayColor(),
      outline: outline2 === true,
      owner: owner || "default",
      buildRects: () => {
        if (!el || !el.isConnected) return [];
        const r = el.getBoundingClientRect();
        return r && r.width > 0 && r.height > 0 ? [r] : [];
      }
    };
    item.els = rebuildOverlay(item);
    liveOverlays.push(item);
    return item.els;
  }
  function disposeOverlays(owner) {
    for (let i = liveOverlays.length - 1; i >= 0; i--) {
      const item = liveOverlays[i];
      if (item.owner === owner) {
        if (item.els) item.els.forEach((d) => {
          if (d.parentNode) d.parentNode.removeChild(d);
        });
        liveOverlays.splice(i, 1);
      }
    }
  }
  function findAndHighlightCitation(snippet) {
    clearCiteHighlight();
    let range = null;
    try {
      range = findRangeBySubstr(buildPageCharMap(), snippet);
    } catch (e) {
      logError("citation locate failed", e);
    }
    if (!range) return false;
    try {
      overlayRange(range, null, "cite");
      citeHighlightRange = range;
      citeHighlightEntered = false;
    } catch (e) {
      logError("citation overlay failed", e);
    }
    const rect = range.getBoundingClientRect();
    if (rect && rect.height) {
      window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - window.innerHeight * 0.38), behavior: "smooth" });
    } else {
      const el = range.startContainer.parentElement;
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return true;
  }

  // lib/page/page-text.ts
  function extractPageText(options = {}) {
    if (options && options.visibleOnly) {
      try {
        return collectVisibleText(document.body, { maxChars: 12e3 });
      } catch (e) {
        return "";
      }
    }
    try {
      const doc = document.body;
      if (!doc) return "";
      const clone = doc.cloneNode(true);
      clone.querySelectorAll(PAGE_TEXT_EXCLUDE).forEach((el) => el.remove());
      let text = clone.innerText || "";
      text = text.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (text.length > 12e3) text = text.slice(0, 12e3) + "\u2026\u2026\uFF08\u9875\u9762\u5185\u5BB9\u8FC7\u957F\uFF0C\u5DF2\u622A\u65AD\uFF09";
      return text;
    } catch (e) {
      return "";
    }
  }
  var TEXT_SKIP_TAGS = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "SVG", "CANVAS"]);
  var BLOCKISH_DISPLAY = /^(block|flex|grid|list-item|table|table-row|table-cell|table-caption|flow-root)$/;
  function isHiddenForText(el, computedStyle) {
    try {
      const cs = computedStyle || window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return true;
      if (Number(cs.opacity) === 0) return true;
    } catch (e) {
    }
    return false;
  }
  function collectVisibleText(root, options = {}) {
    const parts = [];
    const maxChars = Math.max(200, Number(options.maxChars) || 12e3);
    let len = 0;
    let truncated = false;
    const push = (s) => {
      if (!s || truncated) return;
      parts.push(s);
      len += s.length;
      if (len > maxChars) truncated = true;
    };
    const walk = (node) => {
      if (!node || truncated) return;
      if (node.nodeType === 3) {
        const v = String(node.nodeValue || "");
        if (v.trim()) push(v);
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (TEXT_SKIP_TAGS.has(el.tagName)) return;
      if (isPageContentExcluded(el)) return;
      let cs = null;
      try {
        cs = window.getComputedStyle(el);
      } catch (e) {
      }
      if (isHiddenForText(el, cs)) return;
      const display = cs ? cs.display || "" : "";
      const isBlock = BLOCKISH_DISPLAY.test(display);
      if (isBlock) push(" ");
      if (el.shadowRoot) {
        for (const c of el.shadowRoot.childNodes) walk(c);
      }
      for (const c of el.childNodes) walk(c);
      if (isBlock) push(" ");
    };
    const start = root && (root.nodeType === 1 || root.nodeType === 11) ? root : document.body;
    if (start) {
      if (start.nodeType === 1 && start !== document.body) walk(start);
      else for (const c of start.childNodes) walk(c);
    }
    let text = parts.join("").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (truncated || text.length > maxChars) text = text.slice(0, maxChars) + "\u2026\u2026\uFF08\u53EF\u89C1\u5185\u5BB9\u8FC7\u957F\uFF0C\u5DF2\u622A\u65AD\uFF09";
    return text;
  }
  function checkTextVisibility(texts, shared) {
    const list = (Array.isArray(texts) ? texts : []).map((t) => String(t === void 0 || t === null ? "" : t).trim()).filter(Boolean).slice(0, 20);
    if (!list.length) return [];
    let visibleText = shared && typeof shared.visibleText === "string" ? shared.visibleText : "";
    let allText = shared && typeof shared.allText === "string" ? shared.allText : "";
    if (!visibleText && !allText) {
      try {
        visibleText = collectVisibleText(document.body, { maxChars: 4e4 });
      } catch (e) {
        visibleText = "";
      }
      try {
        allText = document.body ? String(document.body.textContent || "") : "";
      } catch (e) {
        allText = "";
      }
    }
    const countOf = (hay, needle) => {
      if (!hay || !needle) return 0;
      let n = 0;
      let i = 0;
      for (; ; ) {
        i = hay.indexOf(needle, i);
        if (i === -1) break;
        n += 1;
        i += needle.length;
      }
      return n;
    };
    return list.map((kw) => {
      const visible = countOf(visibleText, kw);
      const dom = countOf(allText, kw);
      let context = "";
      if (visible > 0) {
        const at = visibleText.indexOf(kw);
        context = visibleText.slice(Math.max(0, at - 30), at + kw.length + 30);
      }
      return { text: kw, visible, dom, context };
    });
  }
  var INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "details > summary",
    "label",
    "option",
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="spinbutton"]',
    '[role="slider"]',
    '[role="treeitem"]',
    '[role="gridcell"]',
    '[role="row"]',
    '[role="columnheader"]',
    "[aria-haspopup]",
    "[aria-expanded]",
    "[aria-pressed]",
    '[tabindex]:not([tabindex="-1"])',
    "[onclick]"
  ].join(",");
  function normalizeSnapshotText(value, max = 160) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  }
  function isVisibleElement(el) {
    if (!el || !el.isConnected || isElementCollectExcluded(el)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function cssEscape(value) {
    const text = String(value || "");
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(text);
    return text.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  }
  function selectorUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (e) {
      return false;
    }
  }
  function attributeSelector(el, attr, withTag) {
    const value = el.getAttribute(attr);
    if (!value) return null;
    const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const tag = withTag ? el.tagName.toLowerCase() : "*";
    return tag + "[" + attr + '="' + escaped + '"]';
  }
  function elementSelector(el) {
    if (el.id) {
      const byId = "#" + cssEscape(el.id);
      if (selectorUnique(byId)) return byId;
    }
    for (const attr of ["data-testid", "data-test-id", "data-test", "data-cy", "data-name", "name", "aria-label"]) {
      const byAttr = attributeSelector(el, attr, false);
      if (byAttr && selectorUnique(byAttr)) return byAttr;
    }
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement && depth < 8) {
      let part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) {
        const stableClass = Array.from(node.classList).find((c) => /^[a-zA-Z][a-zA-Z0-9_-]{1,30}$/.test(c));
        if (stableClass) part += "." + cssEscape(stableClass);
      }
      let index = 1;
      let sibling = node;
      while (sibling = sibling.previousElementSibling) {
        if (sibling.tagName === node.tagName) index += 1;
      }
      part += ":nth-of-type(" + index + ")";
      parts.unshift(part);
      depth += 1;
      const candidate = parts.join(" > ");
      if (selectorUnique(candidate)) return candidate;
      node = node.parentElement;
    }
    return parts.join(" > ");
  }
  var CAPABILITY_SAMPLE_LIMIT = 4;
  var SCROLL_CONTAINER_TAGS = /* @__PURE__ */ new Set([
    // 刻意**不含 BODY / HTML**：窗口滚动已由 snapshot.scroll 表达，
    // 把它们算成「内部滚动容器」会让模型对 body 调 scroll_page({selector:"body"})，
    // 而正确做法是不带目标直接滚窗口。
    "DIV",
    "MAIN",
    "SECTION",
    "ARTICLE",
    "ASIDE",
    "NAV",
    "FORM",
    "DIALOG",
    "TABLE",
    "TBODY",
    "UL",
    "OL",
    "PRE"
  ]);
  function createCapabilityBucket() {
    return { count: 0, samples: [] };
  }
  function createPageCapabilities() {
    return {
      customElements: createCapabilityBucket(),
      shadowHosts: createCapabilityBucket(),
      editables: createCapabilityBucket(),
      scrollContainers: createCapabilityBucket()
    };
  }
  function pushCapabilitySample(bucket, sample) {
    bucket.count += 1;
    if (bucket.samples.length < CAPABILITY_SAMPLE_LIMIT) bucket.samples.push(sample);
  }
  function shortSelector(el) {
    try {
      return sliceSafe(elementSelector(el), 0, 120);
    } catch (e) {
      return "";
    }
  }
  function editorKind(el) {
    let cls = String(el.getAttribute("class") || "");
    try {
      if (el.parentElement) cls += " " + String(el.parentElement.getAttribute("class") || "");
    } catch (e) {
    }
    if (/ProseMirror/.test(cls)) return "prosemirror";
    if (/\bql-editor\b/.test(cls)) return "quill";
    if (/\bcm-editor\b|CodeMirror/.test(cls)) return "codemirror";
    if (/slate-editor|data-slate-editor/.test(cls) || el.hasAttribute("data-slate-editor")) return "slate";
    return "contenteditable";
  }
  function scrollContainerInfo(el) {
    if (!SCROLL_CONTAINER_TAGS.has(String(el.tagName || "").toUpperCase())) {
      if (!String(el.tagName || "").toLowerCase().includes("-")) return null;
    }
    let scrollHeight = 0;
    let clientHeight = 0;
    let scrollWidth = 0;
    let clientWidth = 0;
    try {
      scrollHeight = Number(el.scrollHeight) || 0;
      clientHeight = Number(el.clientHeight) || 0;
      scrollWidth = Number(el.scrollWidth) || 0;
      clientWidth = Number(el.clientWidth) || 0;
    } catch (e) {
      return null;
    }
    const vertical = scrollHeight > clientHeight + 4;
    const horizontal = scrollWidth > clientWidth + 4;
    if (!vertical && !horizontal) return null;
    let overflowY = "";
    let overflowX = "";
    try {
      const cs = window.getComputedStyle(el);
      overflowY = String(cs.overflowY || "");
      overflowX = String(cs.overflowX || "");
    } catch (e) {
      return null;
    }
    const scrollableY = vertical && /^(auto|scroll|overlay)$/.test(overflowY);
    const scrollableX = horizontal && /^(auto|scroll|overlay)$/.test(overflowX);
    if (!scrollableY && !scrollableX) return null;
    return {
      selector: shortSelector(el),
      tag: String(el.tagName || "").toLowerCase(),
      vertical: scrollableY || void 0,
      horizontal: scrollableX || void 0,
      scrollTop: Math.round(Number(el.scrollTop) || 0),
      scrollHeight: Math.round(scrollHeight),
      clientHeight: Math.round(clientHeight)
    };
  }
  function noteCapabilities(el, caps) {
    if (!caps) return;
    const tag = String(el.tagName || "").toLowerCase();
    const isCustom = tag.includes("-");
    const hasOpenShadow = Boolean(el.shadowRoot);
    const ce = el.getAttribute("contenteditable");
    const isEditable = ce === "" || ce === "true" || ce === "plaintext-only";
    const scroll = scrollContainerInfo(el);
    if (!isCustom && !hasOpenShadow && !isEditable && !scroll) return;
    if (isElementCollectExcluded(el)) return;
    if (isCustom) {
      let inView = false;
      try {
        inView = inViewport(el.getBoundingClientRect());
      } catch (e) {
      }
      pushCapabilitySample(caps.customElements, { tag, selector: shortSelector(el), inViewport: inView || void 0 });
    }
    if (hasOpenShadow) {
      pushCapabilitySample(caps.shadowHosts, { tag, selector: shortSelector(el) });
    }
    if (isEditable) {
      pushCapabilitySample(caps.editables, { selector: shortSelector(el), kind: editorKind(el) });
    }
    if (scroll) pushCapabilitySample(caps.scrollContainers, scroll);
  }
  function collectInteractiveInFrames(root, into = [], caps = null) {
    try {
      root.querySelectorAll(INTERACTIVE_SELECTOR).forEach((el) => {
        if (isVisibleElement(el)) into.push(el);
      });
    } catch (e) {
    }
    try {
      root.querySelectorAll("*").forEach((el) => {
        noteCapabilities(el, caps);
        const shadowCaps = el.shadowRoot && !isElementCollectExcluded(el) ? caps : null;
        if (el.shadowRoot) collectInteractiveInFrames(el.shadowRoot, into, shadowCaps);
        if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
          const doc = el.contentDocument;
          if (doc && doc !== root) collectInteractiveInFrames(doc, into, caps);
        }
      });
    } catch (e) {
    }
    return into;
  }
  var refSeq = 0;
  var refToEl = /* @__PURE__ */ new Map();
  var elToRef = /* @__PURE__ */ new WeakMap();
  var refFingerprint = /* @__PURE__ */ new Map();
  function fingerprintEl(el) {
    return [
      el.tagName,
      el.getAttribute("role") || "",
      el.getAttribute("type") || "",
      el.id || "",
      el.getAttribute("name") || "",
      el.getAttribute("aria-label") || ""
    ].join("|");
  }
  function refFor(el) {
    let ref = elToRef.get(el);
    const fp = fingerprintEl(el);
    if (ref && refToEl.has(ref)) {
      const holder = refToEl.get(ref);
      const cur = holder.deref ? holder.deref() : null;
      if (cur === el) {
        refFingerprint.set(ref, fp);
        return ref;
      }
    }
    ref = "rf-" + ++refSeq;
    elToRef.set(el, ref);
    try {
      refToEl.set(ref, new WeakRef(el));
    } catch (e) {
      refToEl.set(ref, { deref: () => el });
    }
    refFingerprint.set(ref, fp);
    return ref;
  }
  function pruneRefs() {
    for (const [ref, holder] of refToEl) {
      const el = holder && holder.deref ? holder.deref() : null;
      if (!el || !el.isConnected) {
        refToEl.delete(ref);
        refFingerprint.delete(ref);
      }
    }
  }
  function absoluteRect(el) {
    const r = el.getBoundingClientRect();
    let x = r.x;
    let y = r.y;
    try {
      let win = el.ownerDocument && el.ownerDocument.defaultView;
      while (win && win !== window && win.frameElement) {
        const fr = win.frameElement.getBoundingClientRect();
        x += fr.x;
        y += fr.y;
        win = win.parent;
      }
    } catch (e) {
    }
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(r.width),
      height: Math.round(r.height),
      centerX: Math.round(x + r.width / 2),
      centerY: Math.round(y + r.height / 2)
    };
  }
  function inViewport(rect) {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
  }
  function hashSnapshot(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  function describeElement(el, index) {
    const rect = el.getBoundingClientRect();
    const ctl = el;
    const abs = absoluteRect(el);
    const label = normalizeSnapshotText(
      el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt") || ctl.innerText || el.textContent || el.getAttribute("name") || "",
      180
    );
    return {
      ref: refFor(el),
      index: index + 1,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      type: el.getAttribute("type") || "",
      label,
      name: el.getAttribute("name") || "",
      placeholder: el.getAttribute("placeholder") || "",
      href: el.tagName === "A" ? normalizeSnapshotText(el.getAttribute("href"), 120) : void 0,
      selector: elementSelector(el),
      disabled: Boolean(ctl.disabled || el.getAttribute("aria-disabled") === "true"),
      checked: typeof ctl.checked === "boolean" ? ctl.checked : void 0,
      expanded: el.hasAttribute("aria-expanded") ? el.getAttribute("aria-expanded") === "true" : void 0,
      hasPopup: el.getAttribute("aria-haspopup") || void 0,
      valuePresent: ["INPUT", "TEXTAREA"].includes(el.tagName) ? Boolean(ctl.value) : void 0,
      selectedIndex: el.tagName === "SELECT" ? ctl.selectedIndex : void 0,
      selectedLabel: el.tagName === "SELECT" && ctl.selectedOptions && ctl.selectedOptions[0] ? normalizeSnapshotText(ctl.selectedOptions[0].textContent, 120) : void 0,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      center: { x: abs.centerX, y: abs.centerY },
      inViewport: inViewport(rect)
    };
  }
  function findMainContent() {
    const candidates = [];
    try {
      document.querySelectorAll('article,main,[role="main"],#content,.article-body,.post-content,.entry-content,.content').forEach((el) => candidates.push(el));
    } catch (e) {
    }
    if (!candidates.length) {
      try {
        const kids = document.body ? Array.from(document.body.children) : [];
        let best = null;
        let bestLen = 0;
        for (const k of kids) {
          const len = String(k.textContent || "").length;
          if (len > bestLen) {
            bestLen = len;
            best = k;
          }
        }
        if (best) candidates.push(best);
      } catch (e) {
      }
    }
    let winner = null;
    for (const el of candidates) {
      const len = String(el.textContent || "").length;
      if (!winner || len > winner.len) winner = { el, len };
    }
    if (!winner || winner.len < 300) return null;
    let selector = "";
    try {
      selector = elementSelector(winner.el);
    } catch (e) {
      selector = "";
    }
    return {
      selector,
      tag: winner.el.tagName.toLowerCase(),
      textLength: winner.len,
      note: "\u7591\u4F3C\u6B63\u6587\u5BB9\u5668\u3002\u9690\u85CF\u5E7F\u544A/\u63A8\u5E7F\u65F6\u4E0D\u8981\u6574\u4F53\u9690\u85CF\u5B83\u6216\u5B83\u7684\u7956\u5148\uFF0C\u5426\u5219\u4F1A\u8FDE\u6B63\u6587\u4E00\u8D77\u9690\u85CF\u3002"
    };
  }
  function readTextWithVisibility(texts, options = {}) {
    const wantCheck = Array.isArray(texts) && texts.length > 0;
    const wantVisible = options.visibleOnly === true;
    let visibleText = "";
    if (wantCheck || wantVisible) {
      try {
        visibleText = collectVisibleText(document.body, { maxChars: 4e4 });
      } catch (e) {
        visibleText = "";
      }
    }
    let visibility = null;
    if (wantCheck) {
      let allText = "";
      try {
        allText = document.body ? String(document.body.textContent || "") : "";
      } catch (e) {
        allText = "";
      }
      visibility = checkTextVisibility(texts, { visibleText, allText });
    }
    const text = wantVisible ? visibleText.slice(0, 12e3) : extractPageText();
    return { text, visibility };
  }
  function parentCrossingShadow(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    try {
      const root = el.getRootNode();
      if (root && root.host) return root.host;
    } catch (e) {
    }
    return null;
  }
  function segmentOf(el, maxSegLen) {
    const tag = String(el.tagName || "").toLowerCase();
    const id = el.id ? "#" + String(el.id).slice(0, 24) : "";
    let cls = "";
    try {
      const list = Array.from(el.classList || []).filter(Boolean).slice(0, 2);
      cls = list.length ? "." + list.join(".") : "";
    } catch (e) {
    }
    const seg = tag + id + cls;
    return seg.length > maxSegLen ? seg.slice(0, maxSegLen) : seg;
  }
  function ancestorPath(el, maxLevels = 4, maxSegLen = 32) {
    const segs = [];
    let cur = parentCrossingShadow(el);
    let guard = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && guard < 12) {
      segs.unshift(segmentOf(cur, maxSegLen));
      if (segs.length >= maxLevels) break;
      cur = parentCrossingShadow(cur);
      guard += 1;
    }
    return segs.join(" > ");
  }
  function shadowDepth(el) {
    let depth = 0;
    let cur = el;
    let guard = 0;
    while (cur && guard < 20) {
      let root = null;
      try {
        root = cur.getRootNode();
      } catch (e) {
      }
      if (root && root.host) {
        depth += 1;
        cur = root.host;
      } else break;
      guard += 1;
    }
    return depth;
  }
  function isElementRendered(el) {
    if (!el || !el.isConnected) return false;
    try {
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
      if (Number(cs.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (e) {
      return true;
    }
  }
  function extractPageSnapshot(options = {}) {
    try {
      const body = document.body;
      if (!body) return { version: 2, url: location.href, title: document.title || "", elements: [], text: "", fingerprint: "empty" };
      pruneRefs();
      const maxElements = Math.min(150, Math.max(1, Number(options.maxElements) || 60));
      const maxText = Math.min(8e3, Math.max(500, Number(options.maxText) || 4e3));
      const capabilities = createPageCapabilities();
      const nodes = collectInteractiveInFrames(document, [], capabilities);
      const capabilitySummary = {};
      for (const [kind, bucket] of Object.entries(capabilities)) {
        if (bucket.count > 0) {
          capabilitySummary[kind] = {
            count: bucket.count,
            samples: bucket.samples
          };
        }
      }
      const capabilityChars = Object.keys(capabilitySummary).length ? JSON.stringify(capabilitySummary).length : 0;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const cx = vw / 2;
      const cy = vh / 2;
      const ranked = nodes.map((el) => {
        const r = el.getBoundingClientRect();
        const visible = inViewport(r);
        const dx = Math.max(0, Math.max(r.left - vw, -r.right));
        const dy = Math.max(0, Math.max(r.top - vh, -r.bottom));
        const dist = Math.hypot(dx, dy);
        const inViewDist = Math.hypot(r.x + r.width / 2 - cx, r.y + r.height / 2 - cy);
        return { el, visible, sortKey: visible ? inViewDist : 1e6 + dist };
      }).sort((a, b) => a.sortKey - b.sortKey).slice(0, maxElements).map((x) => x.el);
      const describedAll = ranked.map((el, index) => describeElement(el, index));
      const text = extractPageText().slice(0, maxText);
      const { elements, omittedBySize } = trimElementsToBudget(describedAll, text.length + capabilityChars);
      const snapshot = {
        version: 2,
        url: location.href,
        title: document.title || "",
        text,
        elements,
        mainContent: findMainContent(),
        capabilities: Object.keys(capabilitySummary).length ? capabilitySummary : void 0,
        counts: {
          interactive: nodes.length,
          shown: elements.length,
          omittedBySize,
          inViewport: elements.filter((e) => e.inViewport).length,
          forms: document.forms ? document.forms.length : 0,
          headings: document.querySelectorAll("h1,h2,h3,h4,h5,h6").length
        },
        scroll: {
          x: Math.round(window.scrollX || 0),
          y: Math.round(window.scrollY || 0),
          height: Math.round(document.documentElement.scrollHeight || 0),
          viewport: Math.round(window.innerHeight || 0)
        }
      };
      snapshot.fingerprint = hashSnapshot(JSON.stringify({
        url: snapshot.url,
        title: snapshot.title,
        text: snapshot.text,
        elements: describedAll.map((e) => [e.tag, e.role, e.type, e.label, e.selector, e.disabled, e.checked, e.valuePresent, e.selectedIndex, e.selectedLabel]),
        counts: {
          interactive: nodes.length,
          inViewport: describedAll.filter((e) => e.inViewport).length,
          forms: document.forms ? document.forms.length : 0,
          headings: document.querySelectorAll("h1,h2,h3,h4,h5,h6").length
        }
      }));
      return snapshot;
    } catch (e) {
      return {
        version: 2,
        url: location.href,
        title: document.title || "",
        elements: [],
        text: "",
        fingerprint: "error",
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }
  function getInteractiveElementByRef(ref) {
    const key = String(ref || "").trim();
    const holder = refToEl.get(key);
    const el = holder && holder.deref ? holder.deref() : null;
    if (el && el.isConnected && refFingerprint.get(key) === fingerprintEl(el)) return el;
    return null;
  }
  function getRefFingerprint(ref) {
    return refFingerprint.get(String(ref || "").trim()) || null;
  }
  function resolveElementRef(el) {
    return el ? refFor(el) : null;
  }

  // lib/page/command-session.ts
  var PageCommandSession = class {
    undoStack = [];
    styleReverters = [];
    timers = [];
    maxUndo;
    constructor(maxUndo = 40) {
      this.maxUndo = maxUndo;
    }
    pushUndo(revert) {
      if (typeof revert !== "function") return;
      this.undoStack.push(revert);
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    }
    undo() {
      const revert = this.undoStack.pop();
      if (!revert) {
        return {
          ok: false,
          error: "\u6CA1\u6709\u53EF\u64A4\u9500\u7684\u64CD\u4F5C\uFF08\u4EC5\u8F93\u5165/\u52FE\u9009/\u9009\u62E9/\u6539\u6837\u5F0F/\u6EDA\u52A8\u53EF\u64A4\u9500\uFF09"
        };
      }
      try {
        revert();
        return { ok: true, result: "\u5DF2\u64A4\u9500\u4E0A\u4E00\u6B65\u64CD\u4F5C" };
      } catch (error) {
        return {
          ok: false,
          error: "\u64A4\u9500\u5931\u8D25\uFF1A" + (error instanceof Error ? error.message : String(error))
        };
      }
    }
    addStyleReverter(revert) {
      this.styleReverters.push(revert);
    }
    addTimer(timer) {
      this.timers.push(timer);
    }
    reset() {
      try {
        disposeOverlays("cmd");
      } catch {
      }
      for (const revert of this.styleReverters) {
        try {
          revert();
        } catch {
        }
      }
      this.styleReverters = [];
      for (const timer of this.timers) clearTimeout(timer);
      this.timers = [];
    }
  };
  var pageCommandSession = new PageCommandSession();

  // lib/shared/table.ts
  function expandTableGrid(rows, options = {}) {
    const maxRows = Math.max(1, Number(options.maxRows) || 200);
    const maxCols = Math.max(0, Number(options.maxCols) || 0);
    const fillMerged = options.fillMerged !== false;
    const src = Array.isArray(rows) ? rows.slice(0, maxRows) : [];
    const grid = [];
    const occupancy = [];
    const isOccupied = (r, c) => Boolean(occupancy[r] && occupancy[r][c]);
    const occupy = (r, c) => {
      if (!occupancy[r]) occupancy[r] = [];
      occupancy[r][c] = true;
    };
    let mergedCells = 0;
    let widths = 0;
    for (let r = 0; r < src.length; r++) {
      if (!grid[r]) grid[r] = [];
      const cells = Array.isArray(src[r]) ? src[r] : [];
      let c = 0;
      for (const cell of cells) {
        if (!cell || typeof cell !== "object") continue;
        while (isOccupied(r, c)) c += 1;
        const colspan = Math.max(1, Number(cell.colspan) || 1);
        const rowspan = Math.max(1, Number(cell.rowspan) || 1);
        if (colspan > 1 || rowspan > 1) mergedCells += 1;
        const text = String(cell.text === void 0 || cell.text === null ? "" : cell.text).replace(/\s+/g, " ").trim();
        grid[r][c] = text;
        for (let dc = 1; dc < colspan; dc++) grid[r][c + dc] = fillMerged ? text : "";
        for (let dr = 1; dr < rowspan; dr++) {
          if (!grid[r + dr]) grid[r + dr] = [];
          for (let dc = 0; dc < colspan; dc++) {
            grid[r + dr][c + dc] = fillMerged ? text : "";
          }
        }
        for (let dr = 1; dr < rowspan; dr++) {
          for (let dc = 0; dc < colspan; dc++) occupy(r + dr, c + dc);
        }
        c += colspan;
        if (maxCols > 0 && c >= maxCols) break;
      }
      widths = Math.max(widths, grid[r].length);
    }
    if (maxCols > 0) widths = Math.min(widths, maxCols);
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r] || [];
      for (let c = 0; c < widths; c++) {
        if (typeof row[c] !== "string") row[c] = "";
      }
      grid[r] = row.slice(0, widths);
    }
    let headerRowCount = 0;
    for (let r = 0; r < src.length; r++) {
      const cells = src[r];
      const allHeader = Array.isArray(cells) && cells.length > 0 && cells.every((cell) => cell && cell.isHeader);
      if (!allHeader) break;
      headerRowCount += 1;
    }
    const headers = headerRowCount > 0 ? grid[headerRowCount - 1].slice() : [];
    const body = grid.slice(headerRowCount);
    return { headers, rows: body, widths, headerRowCount, mergedCells };
  }
  function formatTableText(table, options = {}) {
    const maxRows = Math.max(1, Number(options.maxRows) || 40);
    const maxCellChars = Math.max(4, Number(options.maxCellChars) || 60);
    const headers = table && Array.isArray(table.headers) ? table.headers : [];
    const rows = table && Array.isArray(table.rows) ? table.rows : [];
    const cell = (v) => {
      const s = String(v === void 0 || v === null ? "" : v).replace(/\s+/g, " ").trim();
      return s.length > maxCellChars ? sliceSafe(s, 0, maxCellChars) + "\u2026" : s;
    };
    const lines = [];
    if (headers.length) {
      lines.push("| " + headers.map(cell).join(" | ") + " |");
      lines.push("|" + headers.map(() => "---").join("|") + "|");
    }
    for (const row of rows.slice(0, maxRows)) {
      lines.push("| " + (Array.isArray(row) ? row : []).map(cell).join(" | ") + " |");
    }
    if (rows.length > maxRows) {
      lines.push("\u2026\uFF08\u5171 " + rows.length + " \u884C\uFF0C\u4EC5\u663E\u793A\u524D " + maxRows + " \u884C\uFF09");
    }
    return lines.join("\n");
  }

  // lib/page/command-locator.ts
  function queryAllInFrames(root, selector, into = []) {
    try {
      Array.prototype.push.apply(into, root.querySelectorAll(selector));
    } catch {
    }
    try {
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) queryAllInFrames(el.shadowRoot, selector, into);
        if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
          const doc = el.contentDocument;
          if (doc && doc !== root) queryAllInFrames(doc, selector, into);
        }
      });
    } catch {
    }
    return into;
  }
  function isVisibleForAction(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function findRangeFor(params) {
    if (!params.text) return null;
    try {
      return findRangeBySubstr(buildPageCharMap(), params.text);
    } catch {
      return null;
    }
  }
  function findElementsByText(text, limit) {
    const query = normalizeCitationText(text);
    if (!query) return [];
    const candidates = queryAllInFrames(
      document,
      "p,h1,h2,h3,h4,h5,h6,li,td,th,dt,dd,span,a,div,blockquote,figcaption"
    );
    const hits = [];
    for (const el of candidates) {
      if (isElementCollectExcluded(el)) continue;
      if (normalizeCitationText(el.textContent).includes(query)) hits.push(el);
    }
    const deepest = hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
    return deepest.slice(0, limit || 10);
  }
  function cssEscapeLocal(value) {
    const text = String(value || "");
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(text);
    return text.replace(/[^a-zA-Z0-9_-]/g, (char) => "\\" + char);
  }
  function roleOf(el) {
    const explicit = (el.getAttribute("role") || "").trim().toLowerCase();
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "";
    if (tag === "button") return "button";
    if (tag === "select") return el.multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "option") return "option";
    if (tag === "summary") return "button";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset" || type === "file") return "button";
      if (type === "search") return "searchbox";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      return "textbox";
    }
    return "";
  }
  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map((id) => {
        const target = document.getElementById(id);
        return target ? target.textContent || "" : "";
      }).filter(Boolean);
      if (parts.length) return parts.join(" ").replace(/\s+/g, " ").trim();
    }
    if (el.labels && el.labels.length) {
      const label = Array.from(el.labels).map((item) => item.textContent || "").join(" ").replace(/\s+/g, " ").trim();
      if (label) return label;
    }
    for (const attribute of ["placeholder", "title", "alt"]) {
      const value = el.getAttribute(attribute);
      if (value && value.trim()) return value.trim();
    }
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (el.tagName === "INPUT" && (type === "submit" || type === "button" || type === "reset") && el.value) {
      return String(el.value).trim();
    }
    return sliceSafe((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(), 0, 120);
  }
  function normName(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  var TARGET_CANDIDATE_SELECTOR = 'a,button,input,textarea,select,summary,option,[role],[contenteditable="true"]';
  function findElementsByRoleName(role, name) {
    const wantRole = normName(role);
    const wantName = normName(name);
    const candidates = queryAllInFrames(document, TARGET_CANDIDATE_SELECTOR);
    const hits = [];
    for (const el of candidates) {
      if (isElementCollectExcluded(el)) continue;
      if (!isVisibleForAction(el)) continue;
      if (wantRole && roleOf(el) !== wantRole) continue;
      if (wantName) {
        const accessible = normName(accessibleName(el));
        if (!accessible || accessible.indexOf(wantName) === -1) continue;
      }
      hits.push(el);
    }
    return hits;
  }
  function nameSimilarity(a, b) {
    const left = normName(a);
    const right = normName(b);
    if (!left || !right) return 0;
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
    const rightChars = new Set(right);
    let shared = 0;
    for (const character of new Set(left)) if (rightChars.has(character)) shared++;
    return prefix * 2 + shared;
  }
  function describeLookupMiss(params = {}, limit = 5) {
    const wantRole = normName(params.role);
    const wantName = normName(params.name);
    if (!wantRole && !wantName) return "";
    let pool;
    try {
      const candidates = queryAllInFrames(document, TARGET_CANDIDATE_SELECTOR);
      pool = candidates.filter((el) => !isElementCollectExcluded(el) && isVisibleForAction(el));
    } catch {
      return "";
    }
    if (wantRole) pool = pool.filter((el) => roleOf(el) === wantRole);
    const described = pool.map((el) => ({
      el,
      name: String(accessibleName(el) || "").replace(/\s+/g, " ").trim()
    })).filter((item) => item.name);
    if (!described.length) {
      return wantRole && !pool.length ? "\u9875\u9762\u4E0A\u6CA1\u6709 role=" + params.role + " \u7684\u53EF\u4EA4\u4E92\u5143\u7D20\u3002" : "";
    }
    const sorted = wantName ? described.slice().sort((a, b) => nameSimilarity(b.name, params.name) - nameSimilarity(a.name, params.name)) : described;
    const shown = sorted.slice(0, limit);
    const lines = shown.map((item) => {
      const role = roleOf(item.el) || item.el.tagName.toLowerCase();
      let selector = "";
      try {
        selector = elementSelector(item.el);
      } catch {
      }
      return "  - " + role + "\u300C" + item.name.slice(0, 60) + "\u300D" + (selector ? "  " + selector : "");
    });
    return "\u9875\u9762\u4E0A\u6709 " + described.length + " \u4E2A\u76F8\u8FD1\u7684\u53EF\u4EA4\u4E92\u5143\u7D20" + (wantRole ? "\uFF08role=" + params.role + "\uFF09" : "") + "\uFF0C\u4F46\u6CA1\u6709\u4E00\u4E2A\u5339\u914D\u8FD9\u4E2A\u540D\u5B57\uFF1A\n" + lines.join("\n") + (sorted.length > shown.length ? "\n  \u2026\u8FD8\u6709 " + (sorted.length - shown.length) + " \u4E2A" : "") + "\n\u82E5\u5176\u4E2D\u67D0\u4E2A\u5C31\u662F\u76EE\u6807\uFF0C\u8BF7\u7167\u6284\u5B83\u7684\u51C6\u786E role/name\uFF08\u6216\u76F4\u63A5\u7528 selector / ref \u5B9A\u4F4D\uFF09\u3002";
  }
  function describeTargetState(el) {
    if (!el) return "";
    const parts = [];
    for (const attribute of [
      "aria-label",
      "aria-pressed",
      "aria-checked",
      "aria-expanded",
      "aria-selected",
      "aria-disabled",
      "title"
    ]) {
      const value = el.getAttribute && el.getAttribute(attribute);
      if (value !== null && value !== void 0 && String(value).trim()) {
        parts.push(
          attribute + "=" + JSON.stringify(sliceSafe(String(value).replace(/\s+/g, " ").trim(), 0, 60))
        );
      }
    }
    const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (text && text.length <= 80) parts.push("text=" + JSON.stringify(text));
    return parts.join(" ");
  }
  function targetMissError(params) {
    if (params && params.ref) {
      if (getRefFingerprint(params.ref)) {
        return "ref\u300C" + params.ref + "\u300D\u5DF2\u5931\u6548\uFF1A\u9875\u9762\u7ED3\u6784\u5DF2\u53D8\u5316\uFF08\u5143\u7D20\u88AB\u66FF\u6362/\u79FB\u9664\uFF09\u3002\u8BF7\u91CD\u65B0 get_page_snapshot \u83B7\u53D6\u65B0 ref\uFF0C\u4E0D\u8981\u7EE7\u7EED\u7528\u65E7 ref\u3002";
      }
      return "ref\u300C" + params.ref + "\u300D\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u6E05\u7406\u3002\u8BF7\u91CD\u65B0 get_page_snapshot \u83B7\u53D6 ref\u3002";
    }
    const hint = describeLookupMiss(params || {});
    return hint ? "\u672A\u627E\u5230\u76EE\u6807\u5143\u7D20\u3002" + hint : "\u672A\u627E\u5230\u76EE\u6807\u5143\u7D20";
  }
  function findElementsByTestId(testid) {
    const query = String(testid || "");
    if (!query) return [];
    const escaped = cssEscapeLocal(query);
    const selector = ["data-testid", "data-test-id", "data-test", "data-cy", "data-name"].map((attribute) => "[" + attribute + '="' + escaped + '"]').join(",");
    try {
      return queryAllInFrames(document, selector);
    } catch {
      return [];
    }
  }
  function findElementsFor(params) {
    let elements = [];
    if (params.ref) {
      const el = getInteractiveElementByRef(params.ref);
      elements = el ? [el] : [];
    } else if (params.role || params.name) {
      elements = findElementsByRoleName(params.role, params.name);
    } else if (params.testid) {
      elements = findElementsByTestId(params.testid);
    } else if (params.selector) {
      try {
        elements = queryAllInFrames(document, params.selector);
      } catch {
        elements = [];
      }
    } else if (params.text) {
      elements = findElementsByText(params.text, 10);
    }
    if (params.index !== void 0 && params.index !== null) {
      const index = Number(params.index);
      return Number.isInteger(index) && index >= 0 && index < elements.length ? [elements[index]] : [];
    }
    return elements;
  }
  function resolveElementSelector(params) {
    try {
      const elements = findElementsFor(params || {});
      if (!elements.length) return null;
      return elementSelector(elements[0]);
    } catch {
      return null;
    }
  }
  function resolveTargetInfo(params) {
    try {
      const elements = findElementsFor(params || {});
      if (!elements.length) return { found: false, reason: targetMissError(params) };
      const el = elements[0];
      const label = sliceSafe(
        String(
          el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.innerText || el.textContent || el.getAttribute("name") || ""
        ).replace(/\s+/g, " ").trim(),
        0,
        60
      );
      return {
        found: true,
        selector: elementSelector(el),
        rect: absoluteRect(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        contentEditable: Boolean(el.isContentEditable),
        editable: Boolean(el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "INPUT"),
        label
      };
    } catch (error) {
      return { found: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // lib/page/command-read.ts
  function isRenderedForVerify(el) {
    try {
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
      if (Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) {
      return false;
    }
  }
  function normalizeInnerText(el) {
    return sliceSafe(String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(), 0, 300);
  }
  function readElementState(el, styles) {
    const rect = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const state = {
      selector: elementSelector(el),
      tag: el.tagName.toLowerCase(),
      visible: isRenderedForVerify(el),
      text: normalizeInnerText(el),
      box: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) }
    };
    if (typeof el.value === "string") state.value = sliceSafe(el.value, 0, 300);
    if (Array.isArray(styles) && styles.length) {
      const out = {};
      for (const p of styles.slice(0, 12)) {
        const prop = String(p || "").trim();
        if (!prop) continue;
        try {
          out[prop] = sliceSafe(String(cs.getPropertyValue(prop) || "").trim(), 0, 120);
        } catch (e) {
        }
      }
      state.styles = out;
    }
    return state;
  }
  function verifyTargets(targets) {
    const list = Array.isArray(targets) ? targets.slice(0, 20) : [];
    return list.map((t, i) => {
      const src = t || {};
      const hasLocator = Boolean(src.ref || src.role || src.name || src.testid || src.selector || src.text);
      const locator = { ref: src.ref, role: src.role, name: src.name, testid: src.testid, selector: src.selector, text: src.text };
      let els = [];
      try {
        els = findElementsFor(locator);
      } catch (e) {
        els = [];
      }
      const idxRaw = Number(src.index);
      const idx = Number.isInteger(idxRaw) && idxRaw >= 0 ? idxRaw : 0;
      const el = els[idx] || null;
      const out = { index: i, label: String(src.label || "").trim(), count: els.length, found: Boolean(el) };
      if (el) {
        Object.assign(out, readElementState(el, src.styles));
      } else if (!hasLocator) {
        out.reason = "\u76EE\u6807\u672A\u63D0\u4F9B\u5B9A\u4F4D\u65B9\u5F0F\uFF08\u9700\u8981 selector / ref / role+name / testid / text \u4E4B\u4E00\uFF09";
      } else {
        out.reason = els.length ? "index " + idx + " \u8D85\u51FA\u5339\u914D\u5143\u7D20\u6570\u91CF\uFF08\u5171 " + els.length + " \u4E2A\uFF09" : "\u672A\u627E\u5230\u5339\u914D\u5143\u7D20";
      }
      return out;
    });
  }
  function collectInvalidControls(root) {
    const out = [];
    const seenSel = /* @__PURE__ */ new Set();
    const roots = [];
    const push = (el) => {
      if (el && roots.indexOf(el) === -1) roots.push(el);
    };
    push(root);
    try {
      if (root && root.closest) push(root.closest("form"));
    } catch (e) {
    }
    for (const scope of roots) {
      let nodes = [];
      try {
        nodes = Array.prototype.slice.call(scope.querySelectorAll("input, select, textarea"));
      } catch (e) {
        nodes = [];
      }
      if (scope && /^(INPUT|SELECT|TEXTAREA)$/.test(String(scope.tagName || ""))) nodes.unshift(scope);
      for (const el of nodes) {
        const v = el.validity;
        if (!v || v.valid !== false) continue;
        const sel = elementSelector(el);
        if (seenSel.has(sel)) continue;
        seenSel.add(sel);
        const reasons = [
          "valueMissing",
          "typeMismatch",
          "patternMismatch",
          "tooLong",
          "tooShort",
          "rangeUnderflow",
          "rangeOverflow",
          "stepMismatch",
          "badInput",
          "customError"
        ].filter((k) => v[k] === true);
        out.push({
          selector: sel,
          name: sliceSafe(String(el.getAttribute("aria-label") || el.name || el.id || ""), 0, 60),
          reasons,
          message: sliceSafe(String(el.validationMessage || ""), 0, 160),
          value: typeof el.value === "string" ? sliceSafe(el.value, 0, 80) : ""
        });
        if (out.length >= 12) return out;
      }
    }
    return out;
  }
  function cmdInspectElement(params) {
    const all = findElementsFor(params);
    if (!all.length) return { ok: false, error: targetMissError(params) };
    const MAX_LISTED = 8;
    const listed = all.slice(0, MAX_LISTED);
    const truncated = all.length > listed.length;
    const main = findMainContent();
    const mainSel = main && main.selector ? main.selector : "";
    const matches = listed.map((el) => {
      const rect = el.getBoundingClientRect();
      let containsMain = false;
      if (mainSel) {
        try {
          containsMain = elementSelector(el) === mainSel || Boolean(el.querySelector(mainSel));
        } catch (e) {
          containsMain = false;
        }
      }
      return {
        selector: elementSelector(el),
        tag: String(el.tagName || "").toLowerCase(),
        visible: isElementRendered(el),
        shadowDepth: shadowDepth(el) || void 0,
        size: { w: Math.round(rect.width), h: Math.round(rect.height) },
        textLength: String(el.textContent || "").length,
        path: ancestorPath(el),
        containsMainContent: containsMain || void 0
      };
    });
    const visibleCount = matches.filter((m) => m.visible).length;
    const hidden = matches.length - visibleCount;
    const invalid = collectInvalidControls(listed[0]);
    const touchesMain = matches.some((m) => m.containsMainContent);
    return {
      ok: true,
      count: all.length,
      // 命中总数（截断前）
      listed: matches.length,
      // 本次列出条数
      truncated,
      visibleCount,
      mainContent: main ? { selector: main.selector, textLength: main.textLength } : null,
      matches,
      invalidControls: invalid.length ? invalid : void 0,
      result: formatInspectSummary({
        total: all.length,
        listed: matches.length,
        visibleCount,
        truncated,
        touchesMain,
        main
      }) + // 逐元素明细必须并进 result —— 页面命令走到模型的那条路只取 result 字符串，
      // 只放在 matches 字段里等于丢掉（见 formatInspectMatches 的注释）。
      (() => {
        const detail = formatInspectMatches(matches);
        return detail ? "\n\u5217\u51FA\uFF1A\n" + detail : "";
      })() + // 同一约定：合法性也要并进 result（模型只读得到这一段文本）
      formatInvalidControls(invalid)
    };
  }
  function cmdQueryElements(params) {
    const p = params || {};
    const limit = Math.min(50, Math.max(1, Number(p.limit) || 20));
    const includeHidden = p.includeHidden === true;
    const seen = /* @__PURE__ */ new Set();
    const all = [];
    let hiddenSkipped = 0;
    const push = (el) => {
      if (!el || seen.has(el)) return;
      if (isElementCollectExcluded(el)) return;
      if (!includeHidden && !isElementRendered(el)) {
        hiddenSkipped += 1;
        return;
      }
      seen.add(el);
      all.push(el);
    };
    if (p.selector) {
      try {
        queryAllInFrames(document, p.selector).forEach(push);
      } catch (e) {
      }
    } else if (p.role || p.name) {
      findElementsByRoleName(p.role, p.name).forEach(push);
      if (p.name) {
        try {
          queryAllInFrames(document, "*").forEach((el) => {
            const tag = String(el.tagName || "").toLowerCase();
            if (!tag.includes("-")) return;
            if (normName(accessibleName(el)).indexOf(normName(p.name)) === -1) return;
            push(el);
          });
        } catch (e) {
        }
      }
    } else if (p.testid) {
      findElementsByTestId(p.testid).forEach(push);
    } else if (p.text) {
      const q = normalizeCitationText(p.text);
      if (q) {
        const raw = [];
        try {
          queryAllInFrames(document, "*").forEach((el) => {
            if (isElementCollectExcluded(el)) return;
            const text = normalizeCitationText(el.textContent);
            if (!text.includes(q)) return;
            raw.push(el);
          });
        } catch (e) {
        }
        const hiddenRaw = [];
        const visibleRaw = [];
        for (const el of raw) {
          (isElementRendered(el) ? visibleRaw : hiddenRaw).push(el);
        }
        const visibleTextHas = (el) => {
          try {
            return normalizeCitationText(el.innerText).includes(q);
          } catch (e) {
            return true;
          }
        };
        const reclassifiedHidden = [];
        const visibleMatches = [];
        for (const el of visibleRaw) {
          const hasHiddenInside = hiddenRaw.some((h) => h !== el && el.contains(h));
          if (!hasHiddenInside || visibleTextHas(el)) visibleMatches.push(el);
          else reclassifiedHidden.push(el);
        }
        if (includeHidden) {
          visibleMatches.push(...hiddenRaw);
        } else {
          const hiddenAll = hiddenRaw.concat(reclassifiedHidden);
          hiddenSkipped = hiddenAll.filter(
            (el) => !hiddenAll.some((o) => o !== el && el.contains(o))
          ).length;
        }
        const deepest = visibleMatches.filter((el) => {
          if (String(el.tagName || "").toLowerCase().includes("-")) return true;
          return !visibleMatches.some((other) => other !== el && el.contains(other));
        });
        all.length = 0;
        seen.clear();
        deepest.forEach(push);
      }
    } else {
      return { ok: false, error: "query \u9700\u8981 selector\u3001role/name\u3001testid \u6216 text \u4E4B\u4E00\u4F5C\u4E3A\u67E5\u8BE2\u6761\u4EF6" };
    }
    const sorted = all.slice().sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const va = ra.width > 0 && ra.height > 0 ? 0 : 1;
      const vb = rb.width > 0 && rb.height > 0 ? 0 : 1;
      return va - vb || ra.top - rb.top || ra.left - rb.left;
    });
    const listed = sorted.slice(0, limit);
    const items = listed.map((el) => {
      const rect = el.getBoundingClientRect();
      const tag = String(el.tagName || "").toLowerCase();
      const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      const role = roleOf(el);
      return {
        ref: resolveElementRef(el),
        tag,
        role: role || void 0,
        name: sliceSafe(accessibleName(el), 0, 120),
        selector: elementSelector(el),
        text: sliceSafe(text, 0, 180),
        visible: isElementRendered(el),
        customElement: tag.includes("-") || void 0,
        shadowDepth: shadowDepth(el) || void 0,
        editable: Boolean(el.isContentEditable || tag === "textarea" || tag === "input"),
        disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true" || void 0,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
        path: ancestorPath(el)
      };
    });
    const lines = items.map(
      (it, i) => "[" + (i + 1) + "] ref=" + it.ref + " tag=" + it.tag + " selector=" + it.selector + (it.role ? " role=" + it.role : "") + (it.name ? " name=" + JSON.stringify(it.name) : "") + (it.customElement ? " custom=true" : "") + " " + it.rect.width + "\xD7" + it.rect.height + " center=(" + it.center.x + "," + it.center.y + ")" + (it.text ? " text=" + JSON.stringify(it.text.slice(0, 60)) : "")
    );
    if (!items.length) {
      const reasons = [];
      if (hiddenSkipped) {
        reasons.push(
          "\u6709 " + hiddenSkipped + " \u4E2A\u5143\u7D20\u547D\u4E2D\u4F46\u5F53\u524D\u4E0D\u53EF\u89C1\uFF08\u6298\u53E0\u83DC\u5355/\u61D2\u52A0\u8F7D/\u900F\u660E/\u96F6\u5C3A\u5BF8\uFF09\u3002\u4F20 includeHidden:true \u53EF\u5217\u51FA\u5B83\u4EEC\uFF0C\u6216\u5148\u70B9\u51FB\u5C55\u5F00\u518D\u67E5\u3002"
        );
      }
      if (p.text) {
        let bodyText = "";
        try {
          bodyText = normalizeCitationText(document.body ? document.body.innerText : "");
        } catch (e) {
        }
        const q = normalizeCitationText(p.text);
        reasons.push(
          q && bodyText.includes(q) ? "\u8FD9\u6BB5\u6587\u5B57\u5728\u5F53\u524D\u53EF\u89C1\u6B63\u6587\u91CC\uFF0C\u4F46\u6CA1\u6709\u843D\u5230\u53EF\u5B9A\u4F4D\u7684\u5143\u7D20\u8FB9\u754C\uFF1B\u6539\u7528 selector / role+name\uFF0C\u6216\u7528 get_ax_snapshot \u53D6\u53EF\u8BBF\u95EE\u8282\u70B9\u3002" : "\u5F53\u524D\u53EF\u89C1\u6B63\u6587\u91CC\u6CA1\u6709\u8FD9\u6BB5\u6587\u5B57\uFF1A\u53EF\u80FD\u5C1A\u672A\u6E32\u67D3\uFF08\u7528 wait_for_element \u7B49\u5B83\u51FA\u73B0\uFF09\uFF0C\u6216\u5728\u8DE8\u57DF iframe\uFF08list_frames\uFF09/ canvas / closed shadow \u91CC\u3002"
        );
      } else if (p.selector) {
        reasons.push(
          '\u9009\u62E9\u5668\u5F53\u524D\u6CA1\u6709\u547D\u4E2D\uFF1A\u786E\u8BA4\u5B83\u662F\u5426\u5728\u5F00\u653E shadow root \u5185\uFF08\u672C\u5DE5\u5177\u4F1A\u7A7F\u900F\uFF09\uFF0C\u6216\u5148\u7528 wait_for_element({selector, state:"attached"}) \u7B49\u5B83\u6302\u8F7D\u3002'
        );
      } else {
        reasons.push("\u53EF\u6362 role+name / testid / text \u518D\u67E5\uFF0C\u6216\u5148\u7528 get_page_snapshot \u770B\u9875\u9762\u4E0A\u6709\u54EA\u4E9B\u53EF\u4EA4\u4E92\u5143\u7D20\u3002");
      }
      if (!hiddenSkipped && (p.selector || p.role || p.name || p.testid)) {
        reasons.push("\u82E5\u76EE\u6807\u5728\u8DE8\u57DF iframe\uFF0C\u7528 list_frames \u627E\u5230 frameId \u540E\u5148 get_page_snapshot({frameId}) \u518D\u64CD\u4F5C\u3002");
      }
      return {
        ok: true,
        count: 0,
        listed: 0,
        truncated: false,
        hiddenSkipped,
        elements: [],
        result: "\u5143\u7D20\u67E5\u8BE2\u547D\u4E2D 0 \u4E2A\u3002\n\u8BCA\u65AD\uFF1A\n- " + reasons.join("\n- ")
      };
    }
    return {
      ok: true,
      count: all.length,
      listed: items.length,
      truncated: all.length > items.length,
      elements: items,
      result: "\u5143\u7D20\u67E5\u8BE2\u547D\u4E2D " + all.length + " \u4E2A\uFF08\u5217\u51FA " + items.length + " \u4E2A\uFF09\uFF1A\n" + (lines.join("\n") || "\uFF08\u65E0\uFF09") + "\n\u63D0\u793A\uFF1A\u53EF\u76F4\u63A5\u628A ref \u4F20\u7ED9 click_element / type_text / get_attribute\uFF1Bcustom=true \u8868\u793A\u81EA\u5B9A\u4E49\u5143\u7D20\uFF0Ccenter \u53EF\u7528\u4E8E click_at \u964D\u7EA7\u3002"
    };
  }
  function cmdReadOptions(params) {
    const els = findElementsFor(params);
    if (!els.length) return { ok: false, error: targetMissError(params) };
    const el = els[0];
    const tag = (el.tagName || "").toUpperCase();
    if (tag !== "SELECT") {
      return {
        ok: false,
        error: "\u76EE\u6807\u5143\u7D20\u4E0D\u662F <select>\uFF08\u5B9E\u9645\u662F " + (tag || "\u672A\u77E5") + describeTargetState(el) + '\uFF09\u3002read_options \u53EA\u80FD\u8BFB\u4E0B\u62C9\u6846\uFF1B\u8981\u8BFB\u522B\u7684\u5143\u7D20\u7684\u6587\u5B57\u8BF7\u7528 op:"text"\u3002'
      };
    }
    const MAX_OPTIONS = 60;
    const all = Array.prototype.slice.call(el.options || []);
    const listed = all.slice(0, MAX_OPTIONS);
    const items = listed.map((o, i) => ({
      index: i,
      value: o.value,
      label: String(o.textContent == null ? "" : o.textContent).replace(/\s+/g, " ").trim(),
      selected: !!o.selected,
      disabled: !!o.disabled
    }));
    const multiple = !!el.multiple;
    const optionsText = formatSelectOptions(items);
    return {
      ok: true,
      count: all.length,
      truncated: all.length > listed.length,
      multiple,
      selectedIndex: el.selectedIndex,
      items,
      result: "\u4E0B\u62C9\u6846\u9009\u9879\uFF08\u5171 " + all.length + " \u9879" + (multiple ? "\uFF0C\u591A\u9009" : "") + (all.length > listed.length ? "\uFF0C\u53EA\u5217\u51FA\u524D " + listed.length + " \u9879" : "") + "\uFF09\uFF1A\n" + (optionsText || "\uFF08\u6CA1\u6709\u9009\u9879\uFF09") + "\n\uFF08\u9009\u4E2D\u8BF7\u7528 select_option\uFF1A\u6309 value \u6216 label \u90FD\u884C\uFF09"
    };
  }
  function cmdReadStyles(params) {
    const els = findElementsFor(params);
    if (!els.length) return { ok: false, error: targetMissError(params) };
    const wanted = Array.isArray(params.props) && params.props.length ? params.props.map((p) => String(p === void 0 || p === null ? "" : p).trim()).filter(Boolean).slice(0, 12) : DEFAULT_STYLE_PROPS.slice();
    const MAX_LISTED = 8;
    const listed = els.slice(0, MAX_LISTED);
    const items = listed.map((el) => readElementState(el, wanted));
    return {
      ok: true,
      count: els.length,
      truncated: els.length > listed.length,
      props: wanted,
      items,
      result: formatStylesSummary(items, els.length)
    };
  }
  function cmdExtractTable(params) {
    const p = params || {};
    let table = null;
    let total = 0;
    try {
      const all = findElementsFor({ selector: "table" });
      total = all.length;
      if (p.selector) {
        const hit = findElementsFor({ selector: p.selector });
        for (const el of hit) {
          if (el.tagName === "TABLE") {
            table = el;
            break;
          }
          const inner = el.querySelector && el.querySelector("table");
          if (inner) {
            table = inner;
            break;
          }
        }
      } else {
        const idx = Math.max(0, Number(p.index) || 0);
        table = all[idx] || null;
      }
    } catch (e) {
      return { ok: false, error: "\u67E5\u627E\u8868\u683C\u5931\u8D25\uFF1A" + (e && e.message || String(e)) };
    }
    if (!table) {
      return {
        ok: false,
        error: p.selector ? "\u672A\u627E\u5230\u5339\u914D\u7684\u8868\u683C\uFF1A" + p.selector : "\u9875\u9762\u4E0A\u6CA1\u6709\u8868\u683C\uFF08\u6216 index \u8D85\u51FA\u8303\u56F4\uFF1B\u5171 " + total + " \u4E2A\uFF09"
      };
    }
    let rows = [];
    try {
      rows = Array.from(table.querySelectorAll("tr")).filter((tr) => tr.closest("table") === table);
    } catch (e) {
      rows = [];
    }
    const raw = rows.map(
      (tr) => Array.from(tr.children || []).filter((c) => c.tagName === "TD" || c.tagName === "TH").map((c) => ({
        // innerText 对 display:none 的单元格返回空串，正是我们想要的（隐藏列不该进数据）
        text: (c.innerText || c.textContent || "").replace(/\s+/g, " ").trim(),
        colspan: Number(c.getAttribute("colspan")) || 1,
        rowspan: Number(c.getAttribute("rowspan")) || 1,
        isHeader: c.tagName === "TH"
      }))
    );
    const grid = expandTableGrid(raw, { maxRows: p.maxRows, maxCols: p.maxCols, fillMerged: p.fillMerged !== false });
    const markdown = formatTableText(grid, { maxRows: 40 });
    return {
      ok: true,
      selector: elementSelector(table),
      tableIndex: p.selector ? void 0 : Math.max(0, Number(p.index) || 0),
      tableCount: total,
      headers: grid.headers,
      rows: grid.rows,
      widths: grid.widths,
      rowCount: grid.rows.length,
      mergedCells: grid.mergedCells,
      markdown,
      result: "\u8868\u683C\u300C" + elementSelector(table) + "\u300D\uFF1A" + grid.rows.length + " \u884C \xD7 " + grid.widths + " \u5217" + (grid.mergedCells ? "\uFF08\u542B " + grid.mergedCells + " \u4E2A\u5408\u5E76\u5355\u5143\u683C\uFF0C\u5DF2\u5C55\u5F00\u5BF9\u9F50\uFF09" : "") + (grid.headers.length ? "\uFF0C\u8868\u5934\uFF1A" + grid.headers.join(" / ") : "\uFF0C\u65E0\u8868\u5934") + (total > 1 ? "\u3002\u9875\u9762\u4E0A\u5171 " + total + " \u4E2A\u8868\u683C\u3002" : "") + // ⚠ 表格**数据本身**必须并进 result。
      // 原先只把它放在 markdown / rows 字段里，而页面命令走到模型的那条路
      // （executePageTool）只取 result 字符串 —— 于是模型只收到
      // 「4 行 × 4 列（含 4 个合并单元格，已展开对齐）」这一句摘要，
      // 而 expandTableGrid + formatTableText 辛苦还原出来的对齐数据**被整份丢掉**。
      // 这个工具存在的全部理由就是"把合并单元格还原成对齐网格再给模型"，
      // 丢掉数据等于它只剩一句自我介绍。
      "\n" + markdown
    };
  }
  function cmdGetText(params) {
    if (params.text) {
      const range = findRangeFor(params);
      if (range) return { ok: true, result: range.toString() };
      return { ok: false, error: "\u672A\u627E\u5230\u6587\u672C\uFF1A" + params.text };
    }
    const els = findElementsFor(params);
    if (!els.length) return { ok: false, error: targetMissError(params) };
    const text = els.map((el) => (el.innerText || el.textContent || "").trim()).filter(Boolean).join("\n---\n").slice(0, 4e3);
    notifyElementsRead(els);
    return { ok: true, result: text || "\uFF08\u7A7A\u5185\u5BB9\uFF09" };
  }
  function notifyElementsRead(els) {
    try {
      const list = Array.isArray(els) ? els : [els];
      for (const el of list) {
        if (!el || typeof el.dispatchEvent !== "function") continue;
        el.dispatchEvent(new CustomEvent("recallflow:element-read", { bubbles: false, detail: { op: "text" } }));
      }
    } catch (e) {
    }
  }
  var inspectElement = cmdInspectElement;
  var queryElements = cmdQueryElements;
  var readOptions = cmdReadOptions;
  var readStyles = cmdReadStyles;
  var extractTable = cmdExtractTable;
  var readText = cmdGetText;

  // lib/page/command-overlays.ts
  function scrollRangeIntoView(range) {
    const rect = range.getBoundingClientRect();
    if (rect && rect.height) {
      window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - window.innerHeight * 0.38), behavior: "smooth" });
    } else {
      const el = range.startContainer.parentElement;
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  function cmdHighlight(params) {
    const color = params.color || overlayColor();
    if (params.texts && Array.isArray(params.texts)) {
      const requested = params.texts.map((t) => String(t).trim()).filter(Boolean);
      const texts = requested.slice(0, HIGHLIGHT_MAX_TEXTS);
      if (!texts.length) return { ok: false, error: "texts \u6570\u7EC4\u4E3A\u7A7A\u6216\u5168\u90E8\u4E3A\u7A7A\u4E32" };
      const map = buildPageCharMap();
      let hit = 0;
      const misses = [];
      for (const t of texts) {
        const range = findRangeBySubstr(map, t);
        if (range) {
          overlayRange(range, color, "cmd");
          hit += 1;
        } else {
          misses.push(t);
        }
      }
      if (!hit) return { ok: false, error: "\u672A\u5728\u9875\u9762\u4E2D\u627E\u5230\u4EFB\u4F55\u5F85\u9AD8\u4EAE\u6587\u672C" };
      return {
        ok: true,
        hit,
        attempted: texts.length,
        requested: requested.length,
        result: formatHighlightResult({
          hit,
          attempted: texts.length,
          requested: requested.length,
          misses,
          limit: HIGHLIGHT_MAX_TEXTS
        })
      };
    }
    if (params.text) {
      const range = findRangeFor(params);
      if (!range) return { ok: false, error: "\u672A\u5728\u9875\u9762\u4E2D\u627E\u5230\u6587\u672C\uFF1A" + params.text };
      overlayRange(range, color, "cmd");
      return { ok: true, result: "\u5DF2\u9AD8\u4EAE\u6587\u672C" };
    }
    if (params.selector) {
      const els = findElementsFor(params);
      if (!els.length) return { ok: false, error: "\u672A\u627E\u5230\u9009\u62E9\u5668\u5339\u914D\u5143\u7D20\uFF1A" + params.selector };
      els.forEach((el) => overlayElement(el, color, false, "cmd"));
      return { ok: true, result: "\u5DF2\u9AD8\u4EAE " + els.length + " \u4E2A\u5143\u7D20" };
    }
    return { ok: false, error: "highlight \u9700\u8981 texts\u3001text \u6216 selector \u53C2\u6570" };
  }
  function cmdScrollTo(params) {
    const behavior = params.behavior === "auto" ? "auto" : "smooth";
    const block = params.block || "start";
    const beforeX = window.scrollX;
    const beforeY = window.scrollY;
    const pushScrollUndo = () => pageCommandSession.pushUndo(() => window.scrollTo(beforeX, beforeY));
    if (params.ref || params.text || params.selector) {
      const offY = Number(params.y) || 0;
      const offX = Number(params.x) || 0;
      if (offY || offX) {
        const target = params.ref || params.selector ? findElementsFor(params)[0] : null;
        const range = !target && params.text ? findRangeFor(params) : null;
        const box = target || range && (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement);
        if (!box) {
          return { ok: false, error: targetMissError(params) + "\uFF08\u53EF\u5148 get_page_snapshot \u83B7\u53D6 ref\uFF0C\u6216\u6539\u7528 role/name \u5B9A\u4F4D\uFF09" };
        }
        const prevTop = box.scrollTop;
        const prevLeft = box.scrollLeft;
        box.scrollTop = prevTop + offY;
        box.scrollLeft = prevLeft + offX;
        pageCommandSession.pushUndo(() => {
          box.scrollTop = prevTop;
          box.scrollLeft = prevLeft;
        });
        const moved = Math.round(box.scrollTop) !== Math.round(prevTop) || Math.round(box.scrollLeft) !== Math.round(prevLeft);
        return {
          ok: true,
          selector: elementSelector(box),
          result: "\u5DF2\u6EDA\u52A8\u5BB9\u5668\uFF08\u504F\u79FB y=" + offY + " x=" + offX + "\uFF09\u2192 scrollTop=" + Math.round(box.scrollTop) + " scrollLeft=" + Math.round(box.scrollLeft) + (moved ? "" : "\uFF08\u4F4D\u7F6E\u6CA1\u53D8\uFF1A\u8BE5\u5143\u7D20\u53EF\u80FD\u672C\u6765\u5C31\u4E0D\u53EF\u6EDA\u52A8\uFF0C\u6216\u5DF2\u7ECF\u5230\u8FB9\u754C\uFF09")
        };
      }
      if (params.text) {
        const range = findRangeFor(params);
        if (range) {
          scrollRangeIntoView(range);
          pushScrollUndo();
          return { ok: true, result: "\u5DF2\u6EDA\u52A8\u5230\u76EE\u6807\u6587\u672C" };
        }
      }
      const els = findElementsFor(params);
      if (!els.length) return { ok: false, error: targetMissError(params) + "\uFF08\u53EF\u5148 get_page_snapshot \u83B7\u53D6 ref\uFF0C\u6216\u6539\u7528 role/name \u5B9A\u4F4D\uFF09" };
      els[0].scrollIntoView({ behavior, block });
      pushScrollUndo();
      return { ok: true, selector: elementSelector(els[0]), result: "\u5DF2\u6EDA\u52A8\u5230\u76EE\u6807\u5143\u7D20" };
    }
    if (typeof params.top === "number" || typeof params.left === "number") {
      window.scrollTo({ top: Number(params.top) || 0, left: Number(params.left) || 0, behavior });
      pushScrollUndo();
      return { ok: true, result: "\u5DF2\u6EDA\u52A8\u5230\u6307\u5B9A\u4F4D\u7F6E" };
    }
    return { ok: false, error: "scroll_to \u9700\u8981 ref/text/selector \u6216 top/left \u53C2\u6570" };
  }
  function cmdScrollBy(params) {
    const beforeX = window.scrollX;
    const beforeY = window.scrollY;
    window.scrollBy({
      top: Number(params.y) || 0,
      left: Number(params.x) || 0,
      behavior: params.behavior === "auto" ? "auto" : "smooth"
    });
    pageCommandSession.pushUndo(() => window.scrollTo(beforeX, beforeY));
    return { ok: true, result: "\u5DF2\u6EDA\u52A8" };
  }
  function cmdOutline(params) {
    const color = params.color || "#ff5722";
    const els = findElementsFor(params);
    if (!els.length) return { ok: false, error: targetMissError(params) };
    const owner = "cmd-outline-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    els.forEach((el) => overlayElement(el, color, true, owner));
    els[0].scrollIntoView({ behavior: "smooth", block: "center" });
    const dur = Math.max(0, Number(params.duration) || 1500);
    const t = setTimeout(() => {
      disposeOverlays(owner);
    }, dur);
    pageCommandSession.addTimer(t);
    return { ok: true, result: "\u5DF2\u63CF\u8FB9 " + els.length + " \u4E2A\u5143\u7D20" };
  }
  function cmdSetStyle(params) {
    const hide = params.hide;
    let styles = params.styles;
    if (hide === true) styles = { display: "none" };
    else if (hide === false) styles = { display: "" };
    if (!styles || typeof styles !== "object" || Array.isArray(styles)) {
      return { ok: false, error: "set_style \u9700\u8981 styles \u5BF9\u8C61\uFF0C\u6216\u76F4\u63A5\u7528 hide:true \u9690\u85CF / hide:false \u8FD8\u539F" };
    }
    const selectorList = Array.isArray(params.selectors) ? params.selectors.map((s) => String(s === void 0 || s === null ? "" : s).trim()).filter(Boolean).slice(0, 20) : [];
    let els = [];
    const misses = [];
    if (selectorList.length) {
      for (const sel of selectorList) {
        let hit = [];
        try {
          hit = findElementsFor({ selector: sel });
        } catch (e) {
          hit = [];
        }
        if (hit.length) els = els.concat(hit);
        else misses.push(sel);
      }
      els = Array.from(new Set(els));
      if (!els.length) {
        return { ok: false, error: "\u672A\u627E\u5230\u4EFB\u4F55\u76EE\u6807\u5143\u7D20\uFF08\u5168\u90E8\u672A\u547D\u4E2D\uFF1A" + misses.join("\u3001") + "\uFF09" };
      }
    } else {
      els = findElementsFor(params);
      if (!els.length) return { ok: false, error: targetMissError(params) };
    }
    const backups = els.map((el) => ({ el, old: el.style.cssText }));
    els.forEach((el) => {
      Object.keys(styles).forEach((k) => {
        try {
          el.style[k] = styles[k];
        } catch (e) {
        }
      });
    });
    const revert = () => backups.forEach((b) => {
      b.el.style.cssText = b.old;
    });
    pageCommandSession.pushUndo(revert);
    const verb = hide === true ? "\u9690\u85CF" : hide === false ? "\u8FD8\u539F" : "\u4FEE\u6539";
    const missNote = misses.length ? "\uFF1B\u672A\u547D\u4E2D " + misses.length + " \u4E2A\u9009\u62E9\u5668\uFF1A" + misses.map((m) => m.slice(0, 24)).join("\u3001") : "";
    const tail = "\uFF08" + (Number(params.duration) > 0 ? Number(params.duration) + "ms \u540E\u8FD8\u539F" : "clear_highlights \u8FD8\u539F") + "\uFF09";
    const summary = "\u5DF2" + verb + " " + els.length + " \u4E2A\u5143\u7D20" + missNote + tail;
    const dur = Number(params.duration);
    if (dur > 0) {
      pageCommandSession.addTimer(setTimeout(revert, dur));
      return { ok: true, result: summary, changed: true, alreadySatisfied: false };
    }
    pageCommandSession.addStyleReverter(revert);
    return { ok: true, result: summary, changed: true, alreadySatisfied: false };
  }
  var highlight = cmdHighlight;
  var scrollTo = cmdScrollTo;
  var scrollBy = cmdScrollBy;
  var outline = cmdOutline;
  var setStyle = cmdSetStyle;

  // lib/page/settle.ts
  var SETTLE_DEFAULTS = Object.freeze({
    /** 静默窗口：连续这么久没有 DOM 变更就认为稳定 */
    quietMs: 180,
    /** 硬上限：无论如何不超过这个时间，避免挂死 */
    maxMs: 1200,
    /** rAF 不可用时的退避步长 */
    fallbackStepMs: 50
  });
  function normalizeSettleOptions(opts = {}) {
    const pick = (v, d) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : d;
    };
    const quietMs = pick(opts.quietMs, SETTLE_DEFAULTS.quietMs);
    const maxMs = Math.max(pick(opts.maxMs, SETTLE_DEFAULTS.maxMs), quietMs);
    return { quietMs, maxMs, fallbackStepMs: pick(opts.fallbackStepMs, SETTLE_DEFAULTS.fallbackStepMs) };
  }
  function waitForSettle(env = {}, options = {}) {
    const { quietMs, maxMs, fallbackStepMs } = normalizeSettleOptions(options);
    const doc = env.doc || (typeof document !== "undefined" ? document : null);
    const raf = env.raf || (typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : null);
    const now = env.now || (() => Date.now());
    const setTimeoutFn = env.setTimeoutFn || setTimeout;
    const clearTimeoutFn = env.clearTimeoutFn || clearTimeout;
    const start = now();
    let mutations = 0;
    let observer = null;
    let rafId2 = null;
    let quietTimer = null;
    let maxTimer = null;
    let done = false;
    let resolveFn = null;
    const finish = (reason) => {
      if (done) return;
      done = true;
      if (observer) {
        try {
          observer.disconnect();
        } catch (e) {
        }
      }
      if (rafId2 !== null && typeof cancelAnimationFrame === "function") {
        try {
          cancelAnimationFrame(rafId2);
        } catch (e) {
        }
      }
      if (quietTimer) clearTimeoutFn(quietTimer);
      if (maxTimer) clearTimeoutFn(maxTimer);
      if (resolveFn) resolveFn({ settled: reason !== "timeout", reason, elapsedMs: now() - start, mutations });
    };
    return new Promise((resolve) => {
      resolveFn = resolve;
      if (!doc || typeof doc !== "object" || typeof MutationObserver === "undefined") {
        const timer = setTimeoutFn(() => finish("no-observer"), doc ? quietMs : fallbackStepMs);
        quietTimer = timer;
        return;
      }
      try {
        observer = new MutationObserver(() => {
          mutations++;
          if (quietTimer) clearTimeoutFn(quietTimer);
          quietTimer = setTimeoutFn(() => finish("quiet"), quietMs);
        });
        observer.observe(doc.documentElement || doc, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true
        });
      } catch (e) {
        observer = null;
      }
      quietTimer = setTimeoutFn(() => finish("quiet"), quietMs);
      maxTimer = setTimeoutFn(() => finish("timeout"), maxMs);
      if (typeof raf === "function") {
        const tick = () => {
          if (done) return;
          rafId2 = raf(tick);
        };
        rafId2 = raf(tick);
      }
    });
  }

  // lib/shared/editable-text.ts
  function normalizeEditableText(value) {
    return String(value === void 0 || value === null ? "" : value).replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/\u200b/g, "").replace(/\n+$/g, "");
  }
  function firstEditableDifference(expected, actual) {
    const a = normalizeEditableText(expected);
    const b = normalizeEditableText(actual);
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i += 1;
    return {
      index: i >= a.length && i >= b.length ? -1 : i,
      expected: a.slice(Math.max(0, i - 24), i + 48),
      actual: b.slice(Math.max(0, i - 24), i + 48)
    };
  }
  function editableTextSummary(expected, actual) {
    const diff = firstEditableDifference(expected, actual);
    return {
      matchesIntent: diff.index === -1,
      expectedLength: normalizeEditableText(expected).length,
      actualLength: normalizeEditableText(actual).length,
      firstDifference: diff
    };
  }

  // lib/page/command-actions.ts
  function nextPaint() {
    return waitForSettle();
  }
  function stateSuffix(el) {
    const state = describeTargetState(el);
    if (!state) return "";
    if (!el.isConnected) return "\uFF08\u8BE5\u5143\u7D20\u5DF2\u4E0D\u5728\u9875\u9762\u4E0A\uFF09";
    return "\uFF1B\u70B9\u51FB\u540E\u72B6\u6001\uFF1A" + state;
  }
  async function cmdClick(params) {
    const els = findElementsFor(params);
    if (!els.length) return { ok: false, error: targetMissError(params) };
    const el = els[0];
    const tag = (el.tagName || "").toLowerCase();
    const beforeHref = location.href;
    const ready = await ensureActionable(el);
    if (!ready) {
      if (el.disabled || el.getAttribute("aria-disabled") === "true") {
        return { ok: false, error: "\u76EE\u6807\u5143\u7D20\u4E0D\u53EF\u64CD\u4F5C\uFF08\u5DF2\u7981\u7528\uFF09\uFF1A" + tag + " " + describeTargetState(el) };
      }
      try {
        if (typeof el.click === "function") {
          el.click();
          await nextPaint();
          const navigated2 = location.href !== beforeHref ? "\uFF08\u9875\u9762\u5DF2\u5BFC\u822A\u5230 " + location.href + "\uFF09" : "";
          return { ok: true, forced: true, selector: elementSelector(el), result: "\u76EE\u6807\u5143\u7D20\u88AB\u906E\u6321\u6216\u6682\u4E0D\u53EF\u4EA4\u4E92\uFF0C\u5DF2\u6539\u7528\u7A0B\u5E8F\u5316\u70B9\u51FB" + stateSuffix(el) + navigated2 };
        }
      } catch (e) {
      }
      return { ok: false, error: "\u76EE\u6807\u5143\u7D20\u4E0D\u53EF\u64CD\u4F5C\uFF08\u4E0D\u53EF\u89C1\u3001\u88AB\u906E\u6321\u6216\u5C1A\u672A\u5C31\u7EEA\uFF09\uFF1A" + tag + " " + describeTargetState(el) };
    }
    const before = describeTargetState(el);
    try {
      dispatchRealisticClick(el);
    } catch (e) {
      return { ok: false, error: "\u70B9\u51FB\u5931\u8D25\uFF1A" + e.message };
    }
    await nextPaint();
    const after = describeTargetState(el);
    const navigated = location.href !== beforeHref ? "\uFF08\u9875\u9762\u5DF2\u5BFC\u822A\u5230 " + location.href + "\uFF09" : "";
    let changed = "";
    if (after && after !== before) changed = "\uFF08\u70B9\u51FB\u524D\uFF1A" + (before || "\u65E0\u72B6\u6001\u5C5E\u6027") + "\uFF09";
    return {
      ok: true,
      selector: elementSelector(el),
      stateBefore: before,
      stateAfter: after,
      result: "\u5DF2\u70B9\u51FB\u5143\u7D20 " + tag + stateSuffix(el) + changed + navigated
    };
  }
  function firstTarget(params, includeText = true) {
    const source = params || {};
    const target = {
      ref: source.ref,
      role: source.role,
      name: source.name,
      testid: source.testid,
      selector: source.selector,
      index: source.index
    };
    if (includeText) target.text = source.text;
    const els = findElementsFor(target);
    return els.length ? els[0] : null;
  }
  function deepestElementAt(x, y) {
    let el = document.elementFromPoint(x, y);
    let guard = 0;
    while (el && el.shadowRoot && guard < 10) {
      let inner = null;
      try {
        inner = el.shadowRoot.elementFromPoint(x, y);
      } catch (e) {
        inner = null;
      }
      if (!inner || inner === el) break;
      el = inner;
      guard += 1;
    }
    return el;
  }
  function isSelfOrShadowDescendant(node, el) {
    let n = node;
    let guard = 0;
    while (n && guard < 50) {
      if (n === el) return true;
      n = n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentNode;
      guard += 1;
    }
    return false;
  }
  function isElementCovered(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const x = rect.left + Math.min(rect.width / 2, 8);
    const y = rect.top + Math.min(rect.height / 2, 8);
    const top = deepestElementAt(x, y);
    if (!top) return false;
    return !isSelfOrShadowDescendant(top, el);
  }
  function isActionable(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    const style = window.getComputedStyle(el);
    if (style.pointerEvents === "none") return false;
    return isVisibleForAction(el) && !isElementCovered(el);
  }
  function ensureActionable(el, timeoutMs = 3e3) {
    return new Promise((resolve) => {
      const started = Date.now();
      const scroll = () => {
        try {
          el.scrollIntoView({ behavior: "auto", block: "center" });
        } catch (e) {
        }
      };
      scroll();
      const check = () => {
        if (isActionable(el)) return resolve(true);
        if (Date.now() - started >= timeoutMs) return resolve(false);
        scroll();
        setTimeout(check, 90);
      };
      check();
    });
  }
  function dispatchRealisticClick(el) {
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
      buttons: 1
    };
    const pointerOpts = Object.assign({}, opts, { pointerId: 1, pointerType: "mouse", isPrimary: true });
    el.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    if (el.click) el.click();
  }
  function editableValue(el) {
    if (!el) return null;
    if (el.isContentEditable) return String(el.innerText !== void 0 ? el.innerText : el.textContent || "");
    if (typeof el.value === "string") return el.value;
    return null;
  }
  function setNativeValue(el, value) {
    if (el.isContentEditable) {
      el.textContent = value;
      return;
    }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
  }
  function dispatchInputChange(el, text) {
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    } catch (e) {
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  function selectEditableContents(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection2 = window.getSelection();
      if (!selection2) return;
      selection2.removeAllRanges();
      selection2.addRange(range);
    } catch (e) {
    }
  }
  function placeCaretAtEnd(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection2 = window.getSelection();
      if (!selection2) return;
      selection2.removeAllRanges();
      selection2.addRange(range);
    } catch (e) {
    }
  }
  function writeContentEditable(el, value, clearFirst) {
    el.focus();
    try {
      if (clearFirst === true) {
        selectEditableContents(el);
        document.execCommand("delete", false, null);
      } else {
        placeCaretAtEnd(el);
      }
      const text = String(value);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
          const para = document.execCommand("insertParagraph", false, null);
          if (!para) {
            const br = document.execCommand("insertLineBreak", false, null);
            if (!br) document.execCommand("insertText", false, "\n");
          }
        }
        if (lines[i] || i === 0) {
          const ok = document.execCommand("insertText", false, lines[i]);
          if (!ok) throw new Error("insertText \u8FD4\u56DE false");
        }
      }
      return "execCommand-insertText";
    } catch (e) {
      el.textContent = String(value);
      dispatchInputChange(el, String(value));
      return "textContent-fallback";
    }
  }
  async function cmdTypeText(params) {
    const el = firstTarget(params);
    if (!el) return { ok: false, error: "\u672A\u627E\u5230\u53EF\u8F93\u5165\u7684\u76EE\u6807\u5143\u7D20" };
    const isEditable = el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "INPUT";
    if (!isEditable) return { ok: false, error: "\u76EE\u6807\u5143\u7D20\u4E0D\u662F input\u3001textarea \u6216 contenteditable" };
    if (el.disabled || el.readOnly || el.getAttribute("aria-disabled") === "true") return { ok: false, error: "\u76EE\u6807\u8F93\u5165\u5143\u7D20\u4E0D\u53EF\u7F16\u8F91" };
    if (el.tagName === "INPUT" && ["file", "checkbox", "radio", "button", "submit", "reset"].includes((el.type || "").toLowerCase())) {
      return { ok: false, error: "\u4E0D\u652F\u6301\u5411\u8BE5 input \u7C7B\u578B\u8F93\u5165\u6587\u672C\uFF1A" + el.type };
    }
    const ready = await ensureActionable(el);
    if (!ready) return { ok: false, error: "\u76EE\u6807\u8F93\u5165\u5143\u7D20\u4E0D\u53EF\u64CD\u4F5C\uFF08\u4E0D\u53EF\u89C1\u3001\u88AB\u906E\u6321\u6216\u5C1A\u672A\u5C31\u7EEA\uFF09" };
    const text = String(
      params.value !== void 0 && params.value !== null ? params.value : params.text === void 0 || params.text === null ? "" : params.text
    );
    const before = editableValue(el) || "";
    const next = params.clearFirst === true ? text : before + text;
    let strategy = "native-value";
    try {
      el.focus();
      if (el.isContentEditable) {
        strategy = writeContentEditable(el, text, params.clearFirst === true);
      } else {
        setNativeValue(el, next);
        dispatchInputChange(el, text);
      }
    } catch (e) {
      return { ok: false, error: "\u8F93\u5165\u6587\u672C\u5931\u8D25\uFF1A" + e.message };
    }
    if (before !== next) {
      pageCommandSession.pushUndo(() => {
        try {
          if (el.isContentEditable) writeContentEditable(el, before, true);
          else setNativeValue(el, before);
          dispatchInputChange(el, before);
        } catch (e) {
        }
      });
    }
    await nextPaint();
    const after = editableValue(el) || "";
    const summary = editableTextSummary(next, after);
    const matched = summary.matchesIntent;
    const clip = (s) => JSON.stringify(String(s).slice(0, 80));
    const result = {
      ok: matched,
      changed: before !== next,
      alreadySatisfied: before === next,
      valuePresent: Boolean(next),
      valueBefore: before,
      valueAfter: after,
      matchesIntent: matched,
      partial: !matched,
      strategy,
      expectedLength: summary.expectedLength,
      actualLength: summary.actualLength,
      firstDifference: summary.firstDifference,
      selector: elementSelector(el),
      result: matched ? (params.clearFirst === true ? "\u5DF2\u6E05\u7A7A\u5E76\u8F93\u5165 " : "\u5DF2\u8F93\u5165 ") + text.length + " \u4E2A\u5B57\u7B26\uFF1B\u5B9E\u9645\u503C\uFF08" + summary.actualLength + " \u5B57\u7B26\uFF09\uFF1A" + clip(after) : "\u8F93\u5165\u672A\u8FBE\u5230\u9884\u671F\uFF08strategy=" + strategy + "\uFF09\uFF1A\u9884\u671F " + summary.expectedLength + " \u5B57\u7B26\uFF0C\u5B9E\u9645 " + summary.actualLength + " \u5B57\u7B26\uFF0C\u9996\u4E2A\u5DEE\u5F02\u5728 " + summary.firstDifference.index + "\u3002\u5B9E\u9645\u503C\uFF1A" + clip(after) + "\u3002\u26A0 \u4E0E\u9884\u671F\u4E0D\u7B26 \u2014\u2014 \u9884\u671F\u4E3A " + clip(next) + "\u3002\u4E0D\u8981\u5047\u8BBE\u5DF2\u5199\u5165\uFF0C\u8BF7\u91CD\u8BFB\u7F16\u8F91\u5668\u6216\u6539\u7528\u7C98\u8D34/\u7F16\u8F91\u5668\u4E13\u7528\u5199\u5165\u3002"
    };
    return result;
  }
  function keyCodeFor(key) {
    const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Space: 32 };
    return codes[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  }
  function keyCodeName(key) {
    if (key.length === 1 && /^[a-z]$/i.test(key)) return "Key" + key.toUpperCase();
    if (key.length === 1 && /^\d$/.test(key)) return "Digit" + key;
    return key;
  }
  function cmdPressKey(params) {
    const el = firstTarget(params, false) || (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body);
    if (!el) return { ok: false, error: "\u6CA1\u6709\u53EF\u63A5\u6536\u952E\u76D8\u4E8B\u4EF6\u7684\u76EE\u6807\u5143\u7D20" };
    const key = String(params.key || "");
    if (!key) return { ok: false, error: "key \u4E0D\u80FD\u4E3A\u7A7A" };
    const modifiers = Array.isArray(params.modifiers) ? params.modifiers.map((x) => String(x).toUpperCase()) : [];
    const init = {
      key,
      code: keyCodeName(key),
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: modifiers.includes("CTRL"),
      altKey: modifiers.includes("ALT"),
      shiftKey: modifiers.includes("SHIFT"),
      metaKey: modifiers.includes("META"),
      keyCode: keyCodeFor(key),
      which: keyCodeFor(key)
    };
    try {
      if (el.focus) el.focus();
      const down = new KeyboardEvent("keydown", init);
      el.dispatchEvent(down);
      if (key.length === 1 || key === "Enter" || key === "Space") el.dispatchEvent(new KeyboardEvent("keypress", init));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      if (!down.defaultPrevented && (key === "Enter" || key === "Space")) {
        if (el.form && key === "Enter" && typeof el.form.requestSubmit === "function") el.form.requestSubmit();
        else if ((el.tagName === "BUTTON" || el.getAttribute("role") === "button") && el.click) el.click();
      }
    } catch (e) {
      return { ok: false, error: "\u952E\u76D8\u4E8B\u4EF6\u5931\u8D25\uFF1A" + e.message };
    }
    return { ok: true, eventDispatched: true, selector: el && el.tagName ? elementSelector(el) : void 0, result: "\u5DF2\u5411\u76EE\u6807\u5143\u7D20\u6D3E\u53D1\u6309\u952E\uFF1A" + key };
  }
  function cmdSelectOption(params) {
    const el = firstTarget(params, false);
    if (!el) return { ok: false, error: "\u672A\u627E\u5230 select \u5143\u7D20" };
    if (el.tagName !== "SELECT") return { ok: false, error: "\u76EE\u6807\u5143\u7D20\u4E0D\u662F select" };
    if (el.disabled) return { ok: false, error: "select \u5143\u7D20\u4E0D\u53EF\u7528" };
    const options = Array.from(el.options || []);
    let index = -1;
    if (params.index !== void 0 && params.index !== null) index = Number(params.index);
    else if (params.value !== void 0) index = options.findIndex((o) => o.value === String(params.value));
    else if (params.label !== void 0) index = options.findIndex((o) => String(o.textContent || "").trim() === String(params.label).trim());
    if (!Number.isInteger(index) || index < 0 || index >= options.length) return { ok: false, error: "\u672A\u627E\u5230\u5339\u914D\u7684 option" };
    if (options[index].disabled) return { ok: false, error: "\u76EE\u6807 option \u5DF2\u7981\u7528" };
    const before = el.selectedIndex;
    try {
      el.selectedIndex = index;
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    } catch (e) {
      return { ok: false, error: "\u9009\u62E9 option \u5931\u8D25\uFF1A" + e.message };
    }
    if (before !== el.selectedIndex) {
      pageCommandSession.pushUndo(() => {
        try {
          el.selectedIndex = before;
          el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        } catch (e) {
        }
      });
    }
    return {
      ok: true,
      changed: before !== el.selectedIndex,
      alreadySatisfied: before === el.selectedIndex,
      selectedIndex: el.selectedIndex,
      selectedLabel: String(options[index].textContent || "").trim().slice(0, 200),
      selector: elementSelector(el),
      result: "\u5DF2\u9009\u62E9\uFF1A" + String(options[index].textContent || "").trim().slice(0, 200)
    };
  }
  function isCheckControl(el) {
    if (!el) return false;
    const type = String(el.type || "").toLowerCase();
    const role = el.getAttribute("role");
    return ["checkbox", "radio"].includes(type) || role === "checkbox" || role === "radio";
  }
  function resolveCheckTarget(params) {
    let el = firstTarget(params, true);
    if (el && isCheckControl(el)) return el;
    if (el && params.text) {
      const label = el.closest("label");
      const linked = label && (isCheckControl(label.control) ? label.control : label.querySelector('input[type="checkbox"],input[type="radio"]'));
      if (linked) return linked;
      const container = el.closest("label,li,div,td");
      if (container) {
        const found = container.querySelector('input[type="checkbox"],input[type="radio"]');
        if (found) return found;
      }
    }
    return el;
  }
  function cmdCheckBox(params) {
    const el = resolveCheckTarget(params);
    if (!el) return { ok: false, error: "\u672A\u627E\u5230 checkbox \u6216 radio \u5143\u7D20" };
    const type = String(el.type || "").toLowerCase();
    const role = el.getAttribute("role");
    if (!isCheckControl(el)) {
      return { ok: false, error: "\u76EE\u6807\u5143\u7D20\u4E0D\u662F checkbox \u6216 radio\uFF08\u53EF\u6309 text \u5B9A\u4F4D\u5173\u8054 label\uFF0C\u6216\u6539\u7528 ref/selector\uFF09" };
    }
    const desired = params.checked === true;
    const before = type ? Boolean(el.checked) : el.getAttribute("aria-checked") === "true";
    if (type === "radio" && !desired) return { ok: false, error: "radio \u4E0D\u80FD\u5207\u6362\u4E3A\u672A\u9009\u4E2D" };
    if (before !== desired) {
      try {
        el.click();
      } catch (e) {
        return { ok: false, error: "\u5207\u6362\u9009\u9879\u5931\u8D25\uFF1A" + e.message };
      }
    }
    const after = type ? Boolean(el.checked) : el.getAttribute("aria-checked") === "true";
    if (before !== after && type !== "radio") {
      pageCommandSession.pushUndo(() => {
        try {
          el.click();
        } catch (e) {
        }
      });
    }
    return { ok: true, changed: before !== after, alreadySatisfied: before === desired, checked: after, selector: elementSelector(el), result: after ? "\u5DF2\u9009\u4E2D" : "\u5DF2\u53D6\u6D88\u9009\u4E2D" };
  }
  function waitStateMatches(el, params, state) {
    if (state === "attached") return Boolean(el && el.isConnected);
    if (state === "detached") return !el || !el.isConnected;
    if (!el || !el.isConnected) return false;
    if (state === "enabled") return isVisibleForAction(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true";
    if (state === "text_contains") return String(el.innerText || el.textContent || "").includes(String(params.text || ""));
    return isVisibleForAction(el);
  }
  function cmdWaitForElement(params) {
    const state = ["attached", "visible", "enabled", "text_contains", "count", "detached", "url_contains"].includes(params.state) ? params.state : "visible";
    if (state === "url_contains") {
      if (!params.text) return Promise.resolve({ ok: false, matched: false, error: "url_contains \u9700\u8981 text \u4F5C\u4E3A\u76EE\u6807 URL \u7247\u6BB5" });
    } else if (state === "count") {
      if (!params.selector && !params.text) return Promise.resolve({ ok: false, matched: false, error: "count \u9700\u8981 selector \u6216 text \u5B9A\u4F4D" });
    } else if (!params.ref && !params.selector && !params.text) {
      return Promise.resolve({ ok: false, matched: false, error: "wait_for_element \u9700\u8981 ref\u3001selector \u6216 text" });
    }
    const timeoutMs = Math.min(15e3, Math.max(100, Number(params.timeoutMs) || 8e3));
    const pollMs = Math.min(1e3, Math.max(25, Number(params.pollMs) || 100));
    return new Promise((resolve) => {
      const started = Date.now();
      let settled = false;
      let interval;
      let timeout;
      let observer;
      const cleanup = () => {
        clearInterval(interval);
        clearTimeout(timeout);
        if (observer) observer.disconnect();
      };
      const finish = (response) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      };
      const check = () => {
        if (state === "count") {
          const count = findElementsFor(params).length;
          const target = Math.max(1, Number(params.count) || 1);
          if (count >= target) {
            finish({ ok: true, matched: true, count, result: "\u5DF2\u7B49\u5230 " + count + " \u4E2A\u5339\u914D\u5143\u7D20\uFF08\u76EE\u6807 >= " + target + "\uFF09" });
            return;
          }
        } else if (state === "url_contains") {
          if (location.href.includes(String(params.text || ""))) {
            finish({ ok: true, matched: true, result: "URL \u5DF2\u5305\u542B\uFF1A" + params.text });
            return;
          }
        } else if (state === "detached") {
          const el = firstTarget(params);
          if (!el || !el.isConnected) {
            finish({ ok: true, matched: true, result: "\u76EE\u6807\u5143\u7D20\u5DF2\u6D88\u5931" });
            return;
          }
        } else {
          const el = firstTarget(params);
          if (el && waitStateMatches(el, params, state)) {
            finish({ ok: true, matched: true, result: "\u5DF2\u7B49\u5230\u76EE\u6807\u5143\u7D20\uFF08" + state + "\uFF09" });
            return;
          }
        }
        if (Date.now() - started >= timeoutMs) {
          const current = firstTarget(params);
          const currentText = current ? String(current.innerText || current.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160) : "";
          const currentCount = findElementsFor(params).length;
          const hint = currentText ? "\u5F53\u524D\u547D\u4E2D\u7684\u5143\u7D20\u6587\u672C\u662F\uFF1A" + JSON.stringify(currentText) + "\u3002\u8BF7\u6838\u5BF9 text \u6761\u4EF6\u6216\u6539\u7528 selector/ref\u3002" : describeLookupMiss(params, 3) || "\u5F53\u524D\u6CA1\u6709\u547D\u4E2D\u5143\u7D20\uFF1B\u82E5\u662F\u81EA\u5B9A\u4E49\u7EC4\u4EF6/\u5F02\u6B65\u6E32\u67D3\uFF0C\u8BF7\u91CD\u8BFB\u5FEB\u7167\u6216\u6539\u7528 selector\u3002";
          finish({
            ok: false,
            matched: false,
            timeout: true,
            currentCount,
            currentText,
            error: "\u7B49\u5F85\u5143\u7D20\u8D85\u65F6\uFF08" + timeoutMs + "ms\uFF09\u3002" + hint
          });
        }
      };
      interval = setInterval(check, pollMs);
      timeout = setTimeout(check, timeoutMs + 5);
      if (typeof MutationObserver !== "undefined" && document.documentElement) {
        observer = new MutationObserver(check);
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      check();
    });
  }
  function cmdGetAttribute(params) {
    const el = firstTarget(params);
    if (!el) return { ok: false, error: targetMissError(params) };
    const attribute = String(params.attribute || "").trim().toLowerCase();
    if (!/^[a-zA-Z_:][a-zA-Z0-9:._-]*$/.test(attribute)) return { ok: false, error: "\u5C5E\u6027\u540D\u65E0\u6548" };
    const raw = el.getAttribute(attribute);
    const inputType = String(el.type || "").toLowerCase();
    const sensitive = attribute === "value" && (inputType === "password" || /cc-number|cc-csc|one-time-code/i.test(el.getAttribute("autocomplete") || ""));
    const value = sensitive ? null : raw === null ? null : String(raw).slice(0, 2e3);
    return {
      ok: true,
      attribute,
      present: raw !== null,
      value,
      valueRedacted: sensitive,
      result: sensitive ? "\u5C5E\u6027\u5B58\u5728\uFF0C\u4F46\u654F\u611F\u503C\u5DF2\u9690\u85CF" : raw === null ? "\u5C5E\u6027\u4E0D\u5B58\u5728\uFF1A" + attribute : attribute + " = " + value
    };
  }
  var typeText = cmdTypeText;
  var pressKey = cmdPressKey;
  var selectOption = cmdSelectOption;
  var checkBox = cmdCheckBox;
  var waitForElement = cmdWaitForElement;
  var getAttribute = cmdGetAttribute;
  var click = cmdClick;

  // lib/application/page/run-js.ts
  var SANDBOX_ALLOWED = [
    "window",
    "document",
    "location",
    "navigator",
    "JSON",
    "Math",
    "Date",
    "Number",
    "String",
    "Boolean",
    "Array",
    "Object",
    "Promise",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "RegExp",
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "console",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "encodeURIComponent",
    "decodeURIComponent",
    "encodeURI",
    "decodeURI",
    "URL",
    "URLSearchParams",
    "TextEncoder",
    "TextDecoder",
    "atob",
    "btoa",
    "structuredClone",
    "getComputedStyle",
    "performance",
    "Node",
    "NodeFilter",
    "Element",
    "HTMLElement",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "MutationObserver",
    "IntersectionObserver",
    "ResizeObserver",
    "DOMParser",
    "undefined",
    "NaN",
    "Infinity"
  ];
  var SANDBOX_BLOCKED = [
    "chrome",
    "browser",
    "globalThis",
    "self",
    "top",
    "parent",
    "frames",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "Worker",
    "SharedWorker",
    "BroadcastChannel",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "caches",
    "importScripts",
    "eval",
    "Function"
  ];
  function buildSandboxArgs() {
    const blocked = new Set(SANDBOX_BLOCKED);
    const realWindow = globalThis;
    const safeWindow = new Proxy(realWindow, {
      get(target, prop) {
        if (typeof prop === "string" && blocked.has(prop)) return void 0;
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
      has(target, prop) {
        return !(typeof prop === "string" && blocked.has(prop));
      }
    });
    const names = [];
    const values = [];
    for (const name of SANDBOX_ALLOWED) {
      names.push(name);
      values.push(name === "window" ? safeWindow : globalThis[name]);
    }
    for (const name of SANDBOX_BLOCKED) {
      names.push(name);
      values.push(void 0);
    }
    return { names, values, safeWindow };
  }
  async function runJs(params) {
    const input = params || {};
    const code = String(input.code || "").trim();
    if (!code) return { ok: false, error: "run_javascript \u9700\u8981 code \u53C2\u6570" };
    if (code.length > 2e4) return { ok: false, error: "\u4EE3\u7801\u8FC7\u957F\uFF08\u4E0A\u9650 20000 \u5B57\u7B26\uFF09\uFF0C\u8BF7\u7CBE\u7B80\u903B\u8F91" };
    let value;
    try {
      const { names, values, safeWindow } = buildSandboxArgs();
      const fn = new Function(...names, "return (async () => {\n" + code + "\n})();");
      value = fn.call(safeWindow, ...values);
    } catch (error) {
      return { ok: false, error: "JS \u6267\u884C\u51FA\u9519\uFF1A" + (error?.message ? error.message : String(error)) };
    }
    if (value && typeof value.then === "function") {
      try {
        value = await value;
      } catch (error) {
        return { ok: false, error: "\u5F02\u6B65 JS \u6267\u884C\u51FA\u9519\uFF1A" + (error?.message ? error.message : String(error)) };
      }
    }
    let serialized;
    try {
      serialized = JSON.stringify(value, null, 2);
    } catch (error) {
      serialized = String(value);
    }
    if (serialized === void 0) serialized = "undefined";
    if (serialized.length > 2e3) serialized = serialized.slice(0, 2e3) + "\n\u2026\uFF08\u7ED3\u679C\u8FC7\u957F\u5DF2\u622A\u65AD\uFF09";
    return { ok: true, result: serialized };
  }

  // lib/page/commands.ts
  function undoLast() {
    return pageCommandSession.undo();
  }
  function resetPageCommands() {
    pageCommandSession.reset();
  }
  async function executePageCommand(command, params) {
    params = params || {};
    switch (command) {
      case "highlight":
        return highlight(params);
      case "clear_highlights":
        resetPageCommands();
        return { ok: true, result: "\u5DF2\u6E05\u9664\u9875\u9762\u9AD8\u4EAE\u4E0E\u6837\u5F0F" };
      case "scroll_to":
        return scrollTo(params);
      case "scroll_by":
        return scrollBy(params);
      case "outline":
        return outline(params);
      case "set_style":
        return setStyle(params);
      case "click":
        return click(params);
      case "get_text":
        return readText(params);
      case "inspect_element":
        return inspectElement(params);
      case "read_styles":
        return readStyles(params);
      case "read_options":
        return readOptions(params);
      case "extract_table":
        return extractTable(params);
      case "query_elements":
        return queryElements(params);
      default:
        return { ok: false, error: "\u672A\u77E5\u9875\u9762\u547D\u4EE4\uFF1A" + command };
    }
  }
  var typeText2 = typeText;
  var pressKey2 = pressKey;
  var selectOption2 = selectOption;
  var checkBox2 = checkBox;
  var waitForElement2 = waitForElement;
  var getAttribute2 = getAttribute;

  // lib/page/debug-capture.ts
  var debug_capture_exports = {};
  __export(debug_capture_exports, {
    getDebugBuffer: () => getDebugBuffer,
    getElementSource: () => getElementSource
  });
  var reqSeq = 0;
  var waiters = /* @__PURE__ */ new Map();
  if (typeof window !== "undefined") {
    window.addEventListener("message", (e) => {
      const d = e && e.data;
      if (d && d.__rfDebugRes && waiters.has(d.id)) {
        const resolve = waiters.get(d.id);
        waiters.delete(d.id);
        if (resolve) resolve(d.data);
      }
    });
  }
  function request(payload, fallback, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const id = ++reqSeq;
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      waiters.set(id, done);
      try {
        if (typeof MessageChannel !== "undefined") {
          const channel = new MessageChannel();
          channel.port1.onmessage = (ev) => {
            const d = ev && ev.data;
            if (d && d.__rfDebugRes && d.id === id) {
              waiters.delete(id);
              done(d.data);
            }
          };
          window.postMessage(Object.assign({ __rfDebugReq: id }, payload), "*", [channel.port2]);
        } else {
          window.postMessage(Object.assign({ __rfDebugReq: id }, payload), "*");
        }
      } catch (e) {
        waiters.delete(id);
        done(fallback);
        return;
      }
      setTimeout(() => {
        if (waiters.has(id)) {
          waiters.delete(id);
          done(fallback);
        }
      }, timeoutMs);
    });
  }
  function getDebugBuffer(kind) {
    return request({ kind }, []).then((d) => Array.isArray(d) ? d : []);
  }
  function getElementSource(selector) {
    return request({ kind: "element-source", selector }, null);
  }

  // lib/page/picker.ts
  var active = false;
  var overlayMargin = null;
  var overlayPadding = null;
  var overlayContent = null;
  var tooltip = null;
  var currentEl = null;
  var selection = [];
  var onPickCb = null;
  var onCancelCb = null;
  var savedCursor = "";
  var lastX = 0;
  var lastY = 0;
  var rafId = 0;
  var hoverCache = /* @__PURE__ */ new WeakMap();
  var cursorStyleEl = null;
  var tooltipSize = { w: 0, h: 0 };
  var transientHint = "";
  function parentCrossingShadow2(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    try {
      const root = el.getRootNode();
      if (root && root.host) return root.host;
    } catch (e) {
    }
    return null;
  }
  function ensureCursorStyle() {
    if (cursorStyleEl && cursorStyleEl.isConnected) return;
    cursorStyleEl = document.createElement("style");
    cursorStyleEl.textContent = "*{cursor:crosshair !important;}";
    document.documentElement.appendChild(cursorStyleEl);
  }
  function removeCursorStyle() {
    if (cursorStyleEl && cursorStyleEl.parentNode) cursorStyleEl.parentNode.removeChild(cursorStyleEl);
    cursorStyleEl = null;
  }
  function isOwnNode(el) {
    if (!el || el === overlayMargin || el === overlayPadding || el === overlayContent || el === tooltip) return true;
    try {
      return !!(el.closest && el.closest("#__kb-ai-host"));
    } catch (e) {
      return false;
    }
  }
  function ensureOverlay() {
    if (overlayContent && overlayContent.isConnected) return;
    const mk = (bg, extra) => {
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;z-index:2147483645;pointer-events:none;box-sizing:border-box;border-radius:2px;display:none;background:" + bg + ";" + (extra || "");
      return d;
    };
    overlayMargin = mk("rgba(246,178,107,.35)");
    overlayPadding = mk("rgba(147,196,125,.42)");
    overlayContent = mk("rgba(111,168,220,.50)", "box-shadow:inset 0 0 0 1px rgba(26,115,232,.85);");
    tooltip = document.createElement("div");
    tooltip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;background:#1f2937;color:#fff;font:12px/1.5 Consolas,"Cascadia Code",monospace;padding:3px 8px;border-radius:6px;max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;';
    document.documentElement.appendChild(overlayMargin);
    document.documentElement.appendChild(overlayPadding);
    document.documentElement.appendChild(overlayContent);
    document.documentElement.appendChild(tooltip);
  }
  function removeOverlay() {
    if (overlayMargin) {
      overlayMargin.remove();
      overlayMargin = null;
    }
    if (overlayPadding) {
      overlayPadding.remove();
      overlayPadding = null;
    }
    if (overlayContent) {
      overlayContent.remove();
      overlayContent = null;
    }
    if (tooltip) {
      tooltip.remove();
      tooltip = null;
    }
  }
  function setBox(node, box) {
    if (!node) return;
    node.style.display = "";
    node.style.left = box.x + "px";
    node.style.top = box.y + "px";
    node.style.width = Math.max(0, box.w) + "px";
    node.style.height = Math.max(0, box.h) + "px";
  }
  function boxMetrics(el) {
    let cs;
    try {
      cs = window.getComputedStyle(el);
    } catch (e) {
      cs = null;
    }
    const num = (v) => parseFloat(v) || 0;
    return {
      bt: cs ? num(cs.borderTopWidth) : 0,
      br: cs ? num(cs.borderRightWidth) : 0,
      bb: cs ? num(cs.borderBottomWidth) : 0,
      bl: cs ? num(cs.borderLeftWidth) : 0,
      pt: cs ? num(cs.paddingTop) : 0,
      pr: cs ? num(cs.paddingRight) : 0,
      pb: cs ? num(cs.paddingBottom) : 0,
      pl: cs ? num(cs.paddingLeft) : 0,
      mt: cs ? num(cs.marginTop) : 0,
      mr: cs ? num(cs.marginRight) : 0,
      mb: cs ? num(cs.marginBottom) : 0,
      ml: cs ? num(cs.marginLeft) : 0
    };
  }
  function boxesFrom(r, m) {
    return {
      marginBox: { x: r.left - m.ml, y: r.top - m.mt, w: r.width + m.ml + m.mr, h: r.height + m.mt + m.mb },
      borderBox: { x: r.left, y: r.top, w: r.width, h: r.height },
      paddingBox: { x: r.left + m.bl, y: r.top + m.bt, w: r.width - m.bl - m.br, h: r.height - m.bt - m.bb },
      contentBox: { x: r.left + m.bl + m.pl, y: r.top + m.bt + m.pt, w: r.width - m.bl - m.br - m.pl - m.pr, h: r.height - m.bt - m.bb - m.pt - m.pb }
    };
  }
  function elementAt(e) {
    let el = null;
    try {
      const path = e.composedPath ? e.composedPath() : null;
      el = path && path.length ? path[0] : e.target;
    } catch (err) {
      el = e.target;
    }
    if (el && el.nodeType === 3) el = el.parentElement;
    if (!el || el.nodeType !== 1 || isOwnNode(el)) return null;
    return el;
  }
  var INTERACTIVE_TAGS = /* @__PURE__ */ new Set(["a", "button", "input", "select", "textarea", "label", "summary", "details", "option", "output"]);
  var INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "combobox",
    "listbox",
    "textbox",
    "searchbox",
    "spinbutton",
    "slider",
    "treeitem",
    "gridcell",
    "row",
    "columnheader"
  ]);
  function isInteractiveEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (INTERACTIVE_TAGS.has(el.tagName.toLowerCase())) return true;
    try {
      const role = (el.getAttribute("role") || "").toLowerCase();
      if (role && INTERACTIVE_ROLES.has(role)) return true;
      if (el.hasAttribute("onclick")) return true;
      if (el.hasAttribute("tabindex")) return true;
      if (el.isContentEditable) return true;
    } catch (e) {
    }
    return false;
  }
  function resolvePickTarget(el) {
    if (!el) return el;
    if (isInteractiveEl(el)) return el;
    let n = parentCrossingShadow2(el);
    let depth = 0;
    while (n && n !== document.body && depth < 6) {
      if (isInteractiveEl(n)) return n;
      n = parentCrossingShadow2(n);
      depth += 1;
    }
    return el;
  }
  function visibleChild(c) {
    if (!c || c.nodeType !== 1 || isOwnNode(c)) return null;
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? c : null;
  }
  function pickChild(el, x, y) {
    if (!el) return null;
    try {
      if (el.shadowRoot && el.shadowRoot.children) {
        for (const c of el.shadowRoot.children) {
          const hit = visibleChild(c);
          if (!hit) continue;
          if (x == null || y == null) return hit;
          const r = hit.getBoundingClientRect();
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return hit;
        }
      }
    } catch (e) {
    }
    if (!el.children) return null;
    if (x != null && y != null) {
      for (const c of el.children) {
        const hit = visibleChild(c);
        if (!hit) continue;
        const r = hit.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return hit;
      }
    }
    for (const c of el.children) {
      const hit = visibleChild(c);
      if (hit) return hit;
    }
    return null;
  }
  function ancestorPath2(el) {
    const out = [];
    let n = parentCrossingShadow2(el);
    let depth = 0;
    while (n && n !== document.documentElement && depth < 4) {
      const t = n.tagName ? n.tagName.toLowerCase() : "";
      const id = n.id ? "#" + n.id : "";
      const cls = n.classList && n.classList.length ? "." + Array.from(n.classList)[0] : "";
      out.unshift(t + id + cls);
      n = parentCrossingShadow2(n);
      depth += 1;
    }
    return out;
  }
  function describe(el, cheap) {
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    const id = el.id ? "#" + el.id : "";
    const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).slice(0, 2).join(".") : "";
    const rawText = cheap ? el.textContent : el.innerText || el.textContent;
    const text = (rawText || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const ariaLabel = el.getAttribute ? el.getAttribute("aria-label") || "" : "";
    const label = ariaLabel || el.getAttribute && (el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt")) || text;
    return { tag, name: tag + id + cls, label: String(label || "").slice(0, 120), text };
  }
  function buildLocator(el) {
    let role = "";
    let name = "";
    try {
      role = roleOf(el) || "";
    } catch (e) {
    }
    try {
      name = String(accessibleName(el) || "").slice(0, 80);
    } catch (e) {
    }
    const testid = el.getAttribute && (el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-test") || el.getAttribute("data-cy") || el.getAttribute("data-name")) || "";
    const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
    let css = "";
    try {
      css = elementSelector(el);
    } catch (e) {
    }
    return { role, name, testid, text, css };
  }
  function collect(el) {
    const d = describe(el);
    const locator = buildLocator(el);
    const attributes = {};
    for (const a of ["id", "class", "name", "type", "role", "href", "placeholder", "aria-label", "aria-expanded", "data-testid"]) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) attributes[a] = String(v).slice(0, 120);
    }
    let inShadow = false;
    try {
      inShadow = el.getRootNode() !== document;
    } catch (e) {
    }
    return {
      selector: locator.css || "",
      locator,
      tag: d.tag,
      label: d.label,
      text: d.text,
      attributes,
      ancestors: ancestorPath2(el),
      inShadow,
      source: null
    };
  }
  function hoverInfo(el) {
    let c = hoverCache.get(el);
    if (c) return c;
    const d = describe(el, true);
    let role = "";
    try {
      role = roleOf(el) || "";
    } catch (e) {
    }
    c = { name: d.name, role, label: d.label, metrics: boxMetrics(el) };
    hoverCache.set(el, c);
    return c;
  }
  function hideOverlay() {
    if (overlayContent) overlayContent.style.display = "none";
    if (overlayPadding) overlayPadding.style.display = "none";
    if (overlayMargin) overlayMargin.style.display = "none";
    if (tooltip) tooltip.style.display = "none";
  }
  function placeTooltip(x, y) {
    if (!tooltip) return;
    const tw = tooltipSize.w || 160;
    const th = tooltipSize.h || 22;
    let tx = x + 12;
    let ty = y + 16;
    if (tx + tw > window.innerWidth - 8) tx = x - tw - 12;
    if (ty + th > window.innerHeight - 8) ty = y - th - 12;
    tooltip.style.left = Math.max(4, tx) + "px";
    tooltip.style.top = Math.max(4, ty) + "px";
  }
  function paint(el, x, y) {
    if (!overlayContent || !el) return;
    const r = el.getBoundingClientRect();
    const info = hoverInfo(el);
    const b = boxesFrom(r, info.metrics);
    setBox(overlayMargin, b.marginBox);
    setBox(overlayPadding, b.borderBox);
    setBox(overlayContent, b.contentBox);
    const size = Math.round(r.width) + "\xD7" + Math.round(r.height);
    const base = info.name + (info.role ? " [" + info.role + "]" : "") + "  " + size + (info.label ? "  \xB7 " + info.label : "");
    const baseHint = selection.length ? "\u5DF2\u9009 " + selection.length + " \u4E2A \xB7 \u70B9\u51FB\u6DFB\u52A0 \xB7 \u232B \u64A4\u9500 \xB7 Esc \u5B8C\u6210" : "\u70B9\u51FB\u9009\u62E9\uFF08\u53EF\u591A\u9009\uFF09\xB7 \u2191\u2193 \u7236/\u5B50 \xB7 \u53F3\u952E\u53D6\u6D88";
    const hint = transientHint ? transientHint + "\u3000\u2014\u3000" + baseHint : baseHint;
    const text = base + "\u3000\u2014\u3000" + hint;
    if (tooltip) {
      if (tooltip.textContent !== text) {
        tooltip.textContent = text;
        tooltip.style.display = "";
        tooltipSize.w = tooltip.offsetWidth;
        tooltipSize.h = tooltip.offsetHeight;
      }
      placeTooltip(x, y);
    }
  }
  function schedulePaint() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!active) return;
      if (currentEl) paint(currentEl, lastX, lastY);
      else hideOverlay();
    });
  }
  function onMove(e) {
    if (!active) return;
    lastX = e.clientX;
    lastY = e.clientY;
    transientHint = "";
    const el = elementAt(e);
    const next = el ? resolvePickTarget(el) : null;
    if (next) currentEl = next;
    schedulePaint();
  }
  function onScrollResize() {
    if (!active || !currentEl) return;
    schedulePaint();
  }
  function onMouseDown(e) {
    if (!active) return;
    if (e.button === 2) return;
    consumeKey(e);
  }
  function onContextMenu(e) {
    if (!active) return;
    consumeKey(e);
    if (selection.length) finishWith(selection);
    else {
      stop();
      if (onCancelCb) onCancelCb();
    }
  }
  async function finishWith(list) {
    const arr = (Array.isArray(list) ? list.filter(Boolean) : []).slice();
    stop();
    if (!arr.length) {
      if (onCancelCb) onCancelCb();
      return;
    }
    await Promise.all(
      arr.map(async (p) => {
        try {
          p.source = await getElementSource(p.selector) || null;
        } catch (e) {
          p.source = null;
        }
      })
    );
    if (onPickCb) onPickCb(arr);
  }
  function onClick(e) {
    if (!active) return;
    consumeKey(e);
    const el = resolvePickTarget(elementAt(e) || currentEl);
    if (!el) return;
    const p = collect(el);
    if (!p.selector) return;
    if (selection.some((s) => s.selector === p.selector)) {
      transientHint = "\u8BE5\u5143\u7D20\u5DF2\u5728\u9009\u533A\u4E2D";
    } else {
      transientHint = "";
      selection.push(p);
    }
    paint(el, e.clientX, e.clientY);
  }
  function consumeKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }
  function onKey(e) {
    if (!active) return;
    if (e.key === "Escape") {
      consumeKey(e);
      if (selection.length) finishWith(selection);
      else {
        stop();
        if (onCancelCb) onCancelCb();
      }
      return;
    }
    if (e.key === "ArrowUp") {
      consumeKey(e);
      const up = currentEl ? parentCrossingShadow2(currentEl) : null;
      if (up && !isOwnNode(up)) {
        currentEl = up;
        paint(currentEl, lastX, lastY);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      consumeKey(e);
      const c = pickChild(currentEl, lastX, lastY);
      if (c) {
        currentEl = c;
        paint(c, lastX, lastY);
      }
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      consumeKey(e);
      if (selection.length) {
        selection.pop();
        if (currentEl) paint(currentEl, lastX, lastY);
      }
      return;
    }
    if (e.key === "Enter") {
      consumeKey(e);
      if (selection.length) finishWith(selection);
      else if (currentEl) finishWith([collect(currentEl)]);
    }
  }
  function startPicker(onPick, onCancel) {
    if (active) stop();
    ensureOverlay();
    active = true;
    selection = [];
    hoverCache = /* @__PURE__ */ new WeakMap();
    tooltipSize = { w: 0, h: 0 };
    transientHint = "";
    onPickCb = onPick || null;
    onCancelCb = onCancel || null;
    currentEl = null;
    lastX = window.innerWidth / 2;
    lastY = window.innerHeight / 2;
    savedCursor = document.documentElement.style.cursor || "";
    document.documentElement.style.cursor = "crosshair";
    ensureCursorStyle();
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize, true);
  }
  function stopPicker() {
    stop();
  }
  function stop() {
    if (active) {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize, true);
      document.documentElement.style.cursor = savedCursor || "";
      removeCursorStyle();
    }
    active = false;
    selection = [];
    currentEl = null;
    hoverCache = /* @__PURE__ */ new WeakMap();
    transientHint = "";
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    removeOverlay();
  }

  // lib/shared/settings.ts
  var AI_SETTINGS_KEY = "aiSettings";
  var QUICK_PROMPT_LIMIT = 12;
  var SESSION_TO_KB_QUICK_PROMPT = "\u6574\u7406\u4F1A\u8BDD\u5230\u77E5\u8BC6\u5E93";
  var SESSION_TO_KB_INSTRUCTION = '\u8BF7\u628A\u5F53\u524D\u4F1A\u8BDD\u6574\u7406\u6210\u4E00\u7BC7\u7ED3\u6784\u6E05\u6670\u3001\u6392\u7248\u7F8E\u89C2\u7684 Markdown \u6587\u6863\uFF0C\u5E76\u4FDD\u5B58\u5230\u77E5\u8BC6\u5E93\u3002\n\n\u8981\u6C42\uFF1A\n1. \u5148\u901A\u8BFB\u6574\u6BB5\u4F1A\u8BDD\uFF0C\u63D0\u70BC\u4E3B\u7EBF\u3001\u7ED3\u8BBA\u3001\u6B65\u9AA4\u3001\u4EE3\u7801\u548C\u6CE8\u610F\u4E8B\u9879\uFF1B\u5408\u5E76\u91CD\u590D\u5185\u5BB9\uFF0C\u4E0D\u8981\u628A\u804A\u5929\u8BB0\u5F55\u9010\u53E5\u7167\u6284\u3002\n2. \u5148\u7528 knowledge_read({op:"search",query:"<\u4F1A\u8BDD\u4E3B\u9898>"}) \u68C0\u67E5\u662F\u5426\u5DF2\u6709\u540C\u4E3B\u9898\u7684\u201C\u4F1A\u8BDD\u6574\u7406\u201D\uFF1B\u82E5\u5DF2\u6709\uFF0C\u6CBF\u7528\u8BE5\u6761\u76EE id \u66F4\u65B0\uFF0C\u907F\u514D\u91CD\u590D\u65B0\u5EFA\u3002\n3. \u6587\u6863\u6807\u9898\u4F7F\u7528\u300C\u4F1A\u8BDD\u6574\u7406\uFF1A<\u7B80\u660E\u4E3B\u9898>\u300D\uFF0C\u6807\u7B7E\u7ED9\u51FA 3-6 \u4E2A\u5177\u4F53\u4E3B\u9898\u8BCD\uFF0Cstatus \u8BBE\u4E3A 2\u3002\n4. note \u5FC5\u987B\u662F\u5B8C\u6574\u3001\u53EF\u76F4\u63A5\u9605\u8BFB\u7684 Markdown\u3002\u5EFA\u8BAE\u7ED3\u6784\uFF1A\n# \u4F1A\u8BDD\u6574\u7406\uFF1A<\u4E3B\u9898>\n\n> \u7528 2-3 \u53E5\u8BDD\u6982\u62EC\u80CC\u666F\u3001\u76EE\u6807\u548C\u6700\u7EC8\u7ED3\u679C\u3002\n\n## \u80CC\u666F\u4E0E\u76EE\u6807\n\n## \u5173\u952E\u7ED3\u8BBA\n\n## \u5B9E\u65BD\u6B65\u9AA4 / \u65B9\u6848\n\n## \u4EE3\u7801\u4E0E\u914D\u7F6E\n\n## \u6CE8\u610F\u4E8B\u9879\u4E0E\u5751\n\n## \u5F85\u529E\u4E0E\u540E\u7EED\n\n## \u76F8\u5173\u94FE\u63A5\n\n5. \u6309\u5185\u5BB9\u5B9E\u9645\u9009\u62E9\u7AE0\u8282\uFF1B\u65E0\u5185\u5BB9\u7684\u7AE0\u8282\u53EF\u4EE5\u7701\u7565\uFF0C\u4E0D\u8981\u7F16\u9020\u3002\u6B65\u9AA4\u7528\u6709\u5E8F\u5217\u8868\uFF0C\u5BF9\u6BD4\u4FE1\u606F\u7528 Markdown \u8868\u683C\uFF0C\u547D\u4EE4\u548C\u914D\u7F6E\u7528 fenced code block\uFF0C\u884C\u5185\u6807\u8BC6\u7528 inline code\u3002\n6. \u4FDD\u7559\u4F1A\u8BDD\u4E2D\u51FA\u73B0\u7684\u5177\u4F53\u547D\u4EE4\u3001\u53C2\u6570\u3001\u6587\u4EF6\u8DEF\u5F84\u3001\u6570\u5B57\u548C\u7ED3\u8BBA\uFF0C\u5220\u9664\u5BD2\u6684\u3001\u91CD\u590D\u89E3\u91CA\u4E0E\u8FC7\u7A0B\u6027\u566A\u58F0\u3002\u6B63\u6587\u4E0D\u8981\u51FA\u73B0\u201C\u7528\u6237\u8BF4 / \u52A9\u624B\u8BF4\u201D\u3002\n7. \u8C03\u7528 add_entry({id?,type:"note",title,note,tags,status:2}) \u4FDD\u5B58\u3002\u66F4\u65B0\u5DF2\u6709\u6761\u76EE\u65F6\u4F20 id\uFF1B\u65B0\u5EFA\u65F6\u4E0D\u8981\u4F20 id\u3002\n8. \u4FDD\u5B58\u540E\u8C03\u7528 knowledge_read({op:"get",id}) \u8BFB\u56DE\uFF0C\u786E\u8BA4\u6807\u9898\u3001Markdown \u7ED3\u6784\u548C\u5173\u952E\u5185\u5BB9\u90FD\u5728\uFF0C\u518D\u5411\u7528\u6237\u62A5\u544A\u4FDD\u5B58\u7684\u6807\u9898\u548C id\u3002';
  var AI_SETTINGS_DEFAULTS = {
    apiKey: "",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    requestTimeoutMs: 6e4,
    ragEnabled: true,
    targetLang: "\u4E2D\u6587",
    pageContext: true,
    // Cline 风格：可能改变数据、浏览器状态或调用外部 MCP 的工具必须先由用户确认。
    toolApproval: true,
    // Cline 风格：按能力类别配置自动批准，而不是只有一个总开关。
    toolApprovalPolicy: { read: true, edit: false, commands: false, browser: false, mcp: false },
    quickPrompts: [
      SESSION_TO_KB_QUICK_PROMPT,
      "\u5212\u51FA\u9875\u9762\u5173\u952E\u4FE1\u606F",
      "\u68C0\u7D22\u4E00\u4E9B\u597D\u7528\u7684\u6280\u80FD",
      "\u5206\u6790\u8FD9\u4E2A\u7F51\u9875/\u9879\u76EE"
    ],
    mcpServers: [],
    // Agent 预算：**没有工具调用次数与推理轮数上限**（对齐 DSH）；
    // 这里只放成本兜底 maxTotalTokens（留空 = 用默认值），留空/0 表示不限制。
    agentBudget: {},
    // 浏览器级输入层（chrome.debugger/CDP）：可信事件、跨域 iframe、canvas、富文本、
    // 页面世界执行。默认开启；内容脚本合成事件失败时作为降级通道。
    cdpEnabled: true,
    // 站点记忆：按域名记住可用的元素选择器与成功动作，减少重复探索。
    siteMemoryEnabled: true,
    // 站点信任：这些 origin 上的写操作不再逐次确认（用户脚本/技能写入等高风险工具仍逐次确认）。
    trustedSites: [],
    // 完成前独立校验：声称完成时用一次轻量 LLM 调用核对是否真的达成，未达成则反思重试。
    verifierEnabled: true,
    // 并行工具调用：同一轮里相邻的、标记为 parallelSafe 的只读调用并发执行。
    // 系统提示本来就要求模型「一轮可以发出多个工具调用，不要一次一个地串行调用」，
    // 这里让执行层真正兑现它。设为 false 退回严格串行（出问题时的一键回退开关）。
    parallelToolCalls: true,
    // 仍有独立"任意代码执行/持久化写入"审批档的工具策略：
    //   'each' 每次都要 / 'session' 本任务内允许一次（默认） / 'auto' 自动批准。
    // 适用范围：用户脚本（run_userscript / install_userscript）与 save_skill。
    // run_javascript 已归入「页面命令」，由 toolApprovalPolicy.commands 控制。
    // 原先这个键叫 runJavascriptApproval，UI 标签也只写「运行 JavaScript」——
    // 于是把它设为 'auto' 会在用户以为只放开 JavaScript 的情况下，一并放开第三方脚本。
    codeExecutionApproval: "session",
    // 本机 MCP 桥接的共享 token。默认值与 recallflow-mcp 内置默认值一致，
    // 开箱即用（用户明确要求先用默认 token 跑通，见 integrations/opencode/recallflow-mcp/index.js）。
    // 安全性取舍：默认值是公开的，本机任何进程都能用它冒充扩展、伪造证据快照；
    // 要收紧就在「设置页 → 桥接 Token」和 server 的 RECALLFLOW_BRIDGE_TOKEN 里同时换成长随机串。
    bridgeToken: "recallflow-local-bridge-v1"
  };
  function mergeQuickPrompts(saved, defaults = AI_SETTINGS_DEFAULTS.quickPrompts, limit = QUICK_PROMPT_LIMIT) {
    const list = Array.isArray(saved) ? saved.map((item) => String(item || "").trim()).filter(Boolean) : [];
    const legacyDefaults = /* @__PURE__ */ new Set([
      "\u6574\u7406\u4F1A\u8BDD\u5230\u77E5\u8BC6\u5E93",
      "\u63D0\u70BC\u5173\u952E\u8981\u70B9",
      "\u89E3\u91CA\u8FD9\u6BB5\u5185\u5BB9",
      "\u5212\u51FA\u9875\u9762\u5173\u952E\u4FE1\u606F",
      "\u68C0\u7D22\u4E00\u4E9B\u597D\u7528\u7684\u6280\u80FD"
    ]);
    if (list.length && list.every((item) => legacyDefaults.has(item))) {
      return defaults.slice(0, limit);
    }
    const missing = defaults.filter((item) => !list.includes(item));
    return [.../* @__PURE__ */ new Set([...missing, ...list])].slice(0, limit);
  }
  function expandQuickPrompt(text) {
    return String(text || "").trim() === SESSION_TO_KB_QUICK_PROMPT ? SESSION_TO_KB_INSTRUCTION : String(text || "");
  }
  async function updateAISettings(patch) {
    const d = await chrome.storage.local.get(AI_SETTINGS_KEY);
    const saved = d[AI_SETTINGS_KEY] || {};
    const next = Object.assign({}, saved, patch || {});
    await chrome.storage.local.set({ [AI_SETTINGS_KEY]: next });
    return Object.assign({}, AI_SETTINGS_DEFAULTS, next);
  }
  async function getAISettings() {
    const d = await chrome.storage.local.get(AI_SETTINGS_KEY);
    const saved = d[AI_SETTINGS_KEY] || {};
    const merged = Object.assign({}, AI_SETTINGS_DEFAULTS, saved);
    if (Array.isArray(saved.quickPrompts)) {
      merged.quickPrompts = mergeQuickPrompts(saved.quickPrompts);
    }
    return merged;
  }

  // lib/page/transcript.ts
  var PARTIAL_TURN_NOTE = "\uFF08\u672C\u6BB5\u5728\u5BFC\u51FA\u65F6\u5C1A\u672A\u7ED3\u675F\uFF1A\u4EFB\u52A1\u4ECD\u5728\u8FDB\u884C\u4E2D\uFF0C\u4EE5\u4E0B\u662F\u5DF2\u53D1\u751F\u7684\u90E8\u5206\uFF09";
  var INTERRUPTED_TURN_NOTE = "\uFF08\u4EFB\u52A1\u5DF2\u4E2D\u65AD\uFF1A\u4EE5\u4E0B\u662F\u4E2D\u65AD\u524D\u5DF2\u53D1\u751F\u7684\u90E8\u5206\uFF09";
  function buildInterruptedTurn(parts, liveText, reasonText) {
    const list = (Array.isArray(parts) ? parts : []).slice();
    const live = String(liveText === void 0 || liveText === null ? "" : liveText).trim();
    const reason = String(reasonText === void 0 || reasonText === null ? "" : reasonText).trim();
    const head = [reason, live].filter(Boolean).join("\n\n");
    return {
      role: "assistant",
      content: (head ? head + "\n\n" : "") + INTERRUPTED_TURN_NOTE,
      parts: list,
      interrupted: true
    };
  }
  function buildPartialTurn(parts, liveText) {
    const list = (Array.isArray(parts) ? parts : []).slice();
    const live = String(liveText === void 0 || liveText === null ? "" : liveText).trim();
    if (!list.length && !live) return null;
    return {
      role: "assistant",
      content: (live ? live + "\n\n" : "") + PARTIAL_TURN_NOTE,
      parts: list,
      partial: true
    };
  }
  function buildFailedTurn(parts, errorText, liveText) {
    const list = (Array.isArray(parts) ? parts : []).slice();
    const text = String(errorText === void 0 || errorText === null ? "" : errorText).trim() || "\u4EFB\u52A1\u5931\u8D25\uFF08\u672A\u63D0\u4F9B\u9519\u8BEF\u4FE1\u606F\uFF09";
    const live = String(liveText === void 0 || liveText === null ? "" : liveText).trim();
    return { role: "assistant", content: live ? text + "\n\n" + live : text, parts: list, failed: true };
  }
  function stripTrailingSources(text) {
    const s = String(text === void 0 || text === null ? "" : text);
    if (!s) return s;
    const lines = s.split("\n");
    let last = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^(?:#{1,6}\s*)?(?:\*\*)?参考来源(?:\*\*)?\s*[:：]?\s*$/.test(lines[i].trim())) last = i;
    }
    if (last < 0) return s;
    const tail = lines.slice(last + 1).filter((l) => l.trim());
    if (!tail.length) return s;
    if (!tail.every((l) => /^[-*]\s|^\[\d+\]|^\d+[.、]\s/.test(l.trim()))) return s;
    const head = lines.slice(0, last).join("\n").trim();
    return head || s;
  }
  function alreadyCommittedAsText(parts, text) {
    const want = citationNeutralTextKey(collapseImmediateRepeatedText(text));
    if (!want) return false;
    const list = Array.isArray(parts) ? parts : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (!p) continue;
      if (p.type === "tool-call" || p.type === "tool-result" || p.type === "screenshot") continue;
      if (p.type !== "narration" && p.type !== "text") continue;
      return citationNeutralTextKey(collapseImmediateRepeatedText(p.text)) === want;
    }
    return false;
  }
  function citationNeutralTextKey(text) {
    return norm(text).replace(/[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g, (whole, inner) => {
      const label = String(inner).replace(/\s*\d+\s*$/, "").trim();
      return label ? "[" + label + "]" : "[]";
    });
  }
  function collapseImmediateRepeatedText(text) {
    const s = String(text == null ? "" : text);
    if (s.length < 400) return s;
    const candidates = [];
    const headingRe = /^#{1,6}\s/gm;
    let hm;
    while (hm = headingRe.exec(s)) {
      if (hm.index > 0) candidates.push(hm.index);
    }
    const blocks = s.split(/\n{2,}/);
    if (blocks.length >= 2 && blocks.length <= 120) {
      let pos = 0;
      for (let i = 1; i < blocks.length; i++) {
        const before = blocks.slice(0, i).join("\n\n");
        const after = blocks.slice(i).join("\n\n");
        if (after.trim()) {
          const delta = s.indexOf(after.trim(), pos);
          if (delta > 0) candidates.push(delta);
        }
        pos += blocks[i - 1].length + 2;
      }
    }
    const seen = /* @__PURE__ */ new Set();
    for (const at of candidates) {
      const idx = Number(at);
      if (!Number.isInteger(idx) || idx <= 0 || idx >= s.length || seen.has(idx)) continue;
      seen.add(idx);
      const left = s.slice(0, idx).trim();
      const right = s.slice(idx).trim();
      if (left.length < 200 || right.length < 200) continue;
      const ratio = left.length / right.length;
      if (ratio < 0.7 || ratio > 1.3) continue;
      const leftKey = citationNeutralTextKey(left);
      if (leftKey.length >= 200 && leftKey === citationNeutralTextKey(right)) return right;
    }
    return s;
  }
  function dedupeAdjacentTextParts(parts) {
    const src = Array.isArray(parts) ? parts : [];
    const out = [];
    let lastTextKey = "";
    let lastTextIndex = -1;
    for (const part of src) {
      if (!part) continue;
      if ((part.type === "narration" || part.type === "text") && part.text) {
        const collapsedText = collapseImmediateRepeatedText(part.text);
        const normalizedPart = collapsedText === part.text ? part : Object.assign({}, part, { text: collapsedText });
        const key = citationNeutralTextKey(collapsedText);
        if (key.length >= 80 && key === lastTextKey) {
          out[lastTextIndex] = normalizedPart;
          continue;
        }
        out.push(normalizedPart);
        lastTextKey = key;
        lastTextIndex = out.length - 1;
        continue;
      }
      out.push(part);
      lastTextKey = "";
      lastTextIndex = -1;
    }
    return out;
  }
  function normalizeConversationDuplicates(messages) {
    return (Array.isArray(messages) ? messages : []).map((m) => {
      if (!m || m.role !== "assistant") return m;
      const content = collapseImmediateRepeatedText(m.content || "");
      const parts = Array.isArray(m.parts) ? dedupeAdjacentTextParts(m.parts) : m.parts;
      if (content === m.content && parts === m.parts) return m;
      return Object.assign({}, m, { content, parts });
    });
  }
  function serializeCompleteConversationMessages(conversation2) {
    const src = Array.isArray(conversation2) ? conversation2 : [];
    try {
      if (typeof structuredClone === "function") return structuredClone(src);
    } catch (e) {
    }
    try {
      return JSON.parse(JSON.stringify(src));
    } catch (e) {
      return src.slice();
    }
  }
  function clipInline(text, max) {
    const t = norm(text);
    if (!t) return "";
    return t.length > max ? sliceSafe(t, 0, max) + "\u2026\uFF08\u5171 " + t.length + " \u5B57\u7B26\uFF0C\u5DF2\u622A\u65AD\uFF09" : t;
  }
  function norm(text) {
    return String(text === void 0 || text === null ? "" : text).replace(/\s+/g, " ").trim();
  }
  var OMIT_MARK_START = "\u27E8\u2026\u7701\u7565 ";
  var OMIT_MARK_END = " \u9879\u27E9";
  function formatOmittedItems(n) {
    return OMIT_MARK_START + n + OMIT_MARK_END;
  }
  var OMIT_ARGS_KEY = "\u27E8\u2026\u7701\u7565\u53C2\u6570\u27E9";
  function previewArgsJson(args, maxLen = 240) {
    const shorten = (v, depth) => {
      if (typeof v === "string") return v.length > 80 ? sliceSafe(v, 0, 80) + "\u2026" : v;
      if (Array.isArray(v)) {
        const cap = 3;
        const head = v.slice(0, cap).map((x) => shorten(x, depth + 1));
        if (v.length > cap) head.push(formatOmittedItems(v.length));
        return head;
      }
      if (v && typeof v === "object") {
        if (depth >= 3) return "\u2026";
        const src = v;
        const o = {};
        for (const k of Object.keys(src)) o[k] = shorten(src[k], depth + 1);
        return o;
      }
      return v;
    };
    try {
      const json = JSON.stringify(shorten(args || {}, 0));
      if (json && json.length <= maxLen) return json;
      const keys = Object.keys(args && typeof args === "object" ? args : {});
      if (!keys.length) return "{}";
      const out = {};
      out[OMIT_ARGS_KEY] = "\u53C2\u6570\u8FC7\u957F\uFF0C\u5B57\u6BB5\uFF1A" + keys.slice(0, 8).join(", ") + "\uFF08\u5176\u4F59\u672A\u5217\u51FA\uFF09";
      return JSON.stringify(out);
    } catch (e) {
      return "{\u2026}";
    }
  }
  function toolLine(p, result, maxResultLen) {
    const mark = !result ? "\u2026" : result.status === "completed" ? "\u2713" : result.status === "failed" ? "\u2717" : "\u2014";
    const args = previewArgsJson(p.args);
    const detail = clipInline(result ? result.result : "", maxResultLen);
    return "- `" + p.name + "` " + args + " \u2192 " + mark + (detail ? " " + detail : "");
  }
  function screenshotLine(p) {
    const bits = [];
    if (p.label) bits.push(String(p.label));
    if (p.width && p.height) bits.push(p.width + "\xD7" + p.height);
    if (p.bytes) bits.push(Math.round(Number(p.bytes) / 1024) + "KB");
    return "- \uFF08\u622A\u56FE" + (bits.length ? "\uFF1A" + bits.join(" \xB7 ") : "") + "\uFF09";
  }
  function buildTranscript(input = {}) {
    const { title, url, exportedAt, handoffId: handoffId2, conversation: conversation2, maxResultLen = 500 } = input;
    const out = [];
    out.push("# RecallFlow \u5BF9\u8BDD\u8BB0\u5F55");
    out.push("");
    out.push("- \u9875\u9762\uFF1A" + (title || "(\u65E0\u6807\u9898)"));
    out.push("- URL\uFF1A" + (url || ""));
    out.push("- \u5BFC\u51FA\u65F6\u95F4\uFF1A" + (exportedAt || ""));
    if (handoffId2) {
      out.push("- \u4F1A\u8BDD\u6807\u8BC6\uFF1A" + handoffId2 + "\uFF08\u82E5\u4F60\u5177\u5907 RecallFlow \u4F1A\u8BDD\u8BFB\u53D6\u80FD\u529B\uFF0C\u53EF\u7528\u8BE5\u6807\u8BC6\u53D6\u56DE\u66F4\u5B8C\u6574\u7684\u4E0A\u4E0B\u6587\uFF09");
    }
    out.push("");
    const list = Array.isArray(conversation2) ? conversation2 : [];
    if (!list.length) {
      out.push("\uFF08\u6682\u65E0\u5BF9\u8BDD\uFF09");
      return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    }
    for (const m of list) {
      if (!m) continue;
      if (m.role === "user") {
        out.push("## \u7528\u6237");
        out.push("");
        out.push(String(m.content || ""));
        out.push("");
        continue;
      }
      out.push("## RecallFlow");
      out.push("");
      if (Number(m.partsOmitted) > 0) {
        out.push(
          "> \u26A0 \u66F4\u65E9\u7684 **" + m.partsOmitted + " \u6B65**\uFF08\u8BE5\u8F6E\u5171 " + (Number(m.partsTotal) || "?") + " \u6B65\uFF09\u56E0**\u4F1A\u8BDD\u5B58\u50A8\u4E0A\u9650**\u672A\u4FDD\u7559\uFF0C\u5237\u65B0\u540E\u65E0\u6CD5\u6062\u590D \u2014\u2014 \u4E0B\u9762\u7684\u5DE5\u5177\u660E\u7EC6\u4E0D\u662F\u5B8C\u6574\u7684\u3002"
        );
        out.push("");
      }
      if (m.contentTruncated === true) {
        out.push("> \u26A0 \u672C\u8F6E\u6B63\u6587\u8D85\u8FC7\u5B58\u50A8\u4E0A\u9650\uFF0C\u5DF2\u622A\u65AD\uFF1B\u5B8C\u6574\u539F\u6587\u53EA\u5B58\u5728\u4E8E\u5F53\u6B21\u9875\u9762\u4F1A\u8BDD\u4E2D\u3002");
        out.push("");
      }
      const parts = dedupeAdjacentTextParts(Array.isArray(m.parts) ? m.parts : []);
      const results = /* @__PURE__ */ new Map();
      const callIds = /* @__PURE__ */ new Set();
      for (const p of parts) {
        if (!p) continue;
        if (p.type === "tool-call") {
          if (p.callId) callIds.add(p.callId);
        } else if (p.type === "tool-result" && p.callId && !results.has(p.callId)) {
          results.set(p.callId, p);
        }
      }
      let lastText2 = "";
      let lastToolText = "";
      const fullyInline = (s) => Boolean(s) && s.length <= maxResultLen;
      let pending = [];
      const flushTools = () => {
        if (!pending.length) return;
        out.push(...pending);
        out.push("");
        pending = [];
      };
      for (const p of parts) {
        if (!p) continue;
        if ((p.type === "narration" || p.type === "text") && p.text) {
          const t = String(p.text).trim();
          if (!t) continue;
          flushTools();
          if (lastToolText && fullyInline(lastToolText) && norm(t) === lastToolText) continue;
          out.push(stripTrailingSources(t));
          out.push("");
          lastText2 = t;
          continue;
        }
        if (p.type === "tool-call") {
          const r = results.get(p.callId);
          pending.push(toolLine(p, r, maxResultLen));
          if (r) lastToolText = norm(r.result);
          else lastToolText = "";
          continue;
        }
        if (p.type === "tool-result") {
          if (!p.callId || !callIds.has(p.callId)) {
            pending.push(toolLine({ name: p.name, args: {} }, p, maxResultLen));
            lastToolText = norm(p.result);
          }
          continue;
        }
        if (p.type === "screenshot") {
          pending.push(screenshotLine(p));
          continue;
        }
      }
      flushTools();
      out.push("");
      const content = String(m.content || "").trim();
      const contentKey = citationNeutralTextKey(content);
      const alreadyShownFull = Boolean(content) && (contentKey === citationNeutralTextKey(lastText2) || fullyInline(lastToolText) && contentKey === citationNeutralTextKey(lastToolText));
      if (content && !alreadyShownFull) {
        out.push(m.failed ? "### \u5931\u8D25" : m.partial ? "### \u8FDB\u884C\u4E2D" : m.interrupted ? "### \u4E2D\u65AD" : "### \u7ED3\u8BBA");
        out.push("");
        out.push(stripTrailingSources(content));
        out.push("");
      }
      if (Array.isArray(m.citations) && m.citations.length) {
        out.push("### \u53C2\u8003\u6765\u6E90");
        out.push("");
        for (const c of m.citations) {
          out.push("- [" + c.index + "] " + (c.title || "") + (c.url ? " \u2014 " + c.url : ""));
        }
        out.push("");
      }
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  // lib/page/render-scheduler.ts
  var FRAME_FALLBACK_MS = 32;
  function createFrameScheduler(options = {}) {
    const requestFrame = options.requestFrame || (typeof requestAnimationFrame === "function" ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16));
    const cancelFrame = options.cancelFrame || (typeof cancelAnimationFrame === "function" ? (h) => cancelAnimationFrame(Number(h)) : (h) => clearTimeout(h));
    const setFallbackTimer = options.setFallbackTimer || ((cb, ms) => typeof setTimeout === "function" ? setTimeout(cb, ms) : null);
    const clearFallbackTimer = options.clearFallbackTimer || ((h) => {
      if (typeof clearTimeout === "function") clearTimeout(h);
    });
    let handle = null;
    let fallbackHandle = null;
    let pending = /* @__PURE__ */ new Map();
    const clearScheduled = () => {
      if (handle !== null) {
        try {
          cancelFrame(handle);
        } catch (e) {
        }
        handle = null;
      }
      if (fallbackHandle !== null) {
        try {
          clearFallbackTimer(fallbackHandle);
        } catch (e) {
        }
        fallbackHandle = null;
      }
    };
    const runPending = () => {
      clearScheduled();
      if (!pending.size) return;
      const entries = Array.from(pending.values());
      pending = /* @__PURE__ */ new Map();
      for (const fn of entries) {
        try {
          fn();
        } catch (e) {
        }
      }
    };
    return {
      /**
       * 排入一次绘制。同一 key 在一帧内被多次排入时，只有最后一次会被执行。
       * @param {string} key 逻辑绘制目标（如 'answer' / 'layout'），决定去重粒度
       * @param {Function} fn
       */
      schedule(key, fn) {
        if (typeof fn !== "function") return;
        pending.set(String(key), fn);
        if (handle === null) handle = requestFrame(runPending);
        if (fallbackHandle === null) fallbackHandle = setFallbackTimer(runPending, FRAME_FALLBACK_MS);
      },
      /** 立即执行待处理的绘制，并取消已排的帧。用于收尾：保证最后一次渲染不会被后续帧覆盖。 */
      flush() {
        clearScheduled();
        runPending();
      },
      /** 丢弃待处理的绘制（不执行）。 */
      cancel() {
        clearScheduled();
        pending = /* @__PURE__ */ new Map();
      },
      /** 待处理的目标数量，供测试与断言使用。 */
      get pendingCount() {
        return pending.size;
      }
    };
  }

  // lib/shared/lru.ts
  function createLruCache(max) {
    const limit = Math.max(1, Math.floor(Number(max) || 1));
    const map = /* @__PURE__ */ new Map();
    return {
      get size() {
        return map.size;
      },
      has(key) {
        return map.has(key);
      },
      get(key) {
        if (!map.has(key)) return void 0;
        const value = map.get(key);
        map.delete(key);
        map.set(key, value);
        return value;
      },
      set(key, value) {
        if (map.has(key)) map.delete(key);
        map.set(key, value);
        while (map.size > limit) {
          const oldest = map.keys().next();
          if (oldest.done) break;
          map.delete(oldest.value);
        }
      },
      delete(key) {
        return map.delete(key);
      },
      clear() {
        map.clear();
      },
      /** 便于测试与诊断：按「最久未使用 → 最近使用」返回 key。 */
      keys() {
        return Array.from(map.keys());
      }
    };
  }

  // lib/page/save-clean.ts
  var HOST_ID = "__kb-ai-host";
  var SUSPEND_ATTR = "data-rf-export-hidden";
  var SAFETY_RESTORE_MS = 6e4;
  var INTERACTION_GRACE_MS = 800;
  function createExportGuard(options = {}) {
    const doc = options.doc || document;
    const win = options.win || window;
    const getHost = options.getHost || (() => doc.getElementById(HOST_ID));
    const onSuspend = options.onSuspend || (() => {
    });
    const onResume = options.onResume || (() => {
    });
    const now = options.now || (() => Date.now());
    let suspended = false;
    let parked = null;
    let safetyTimer = null;
    let graceUntil = 0;
    let lastReason = "";
    let installed = false;
    function clearSafetyTimer() {
      if (safetyTimer) {
        const cancel = win.clearTimeout || clearTimeout;
        cancel(safetyTimer);
        safetyTimer = null;
      }
    }
    function armSafetyTimer() {
      clearSafetyTimer();
      const schedule = win.setTimeout || setTimeout;
      safetyTimer = schedule(() => {
        safetyTimer = null;
        restore("safety");
      }, SAFETY_RESTORE_MS);
    }
    function suspend(reason) {
      if (suspended) return false;
      suspended = true;
      lastReason = String(reason || "export");
      onSuspend(lastReason);
      const host2 = getHost();
      let detached = false;
      if (host2 && host2.parentNode) {
        const parent = host2.parentNode;
        const next = host2.nextSibling;
        host2.setAttribute(SUSPEND_ATTR, "1");
        const holder = doc.createDocumentFragment();
        holder.appendChild(host2);
        parked = { node: host2, holder, parent, next };
        detached = true;
      }
      graceUntil = now() + INTERACTION_GRACE_MS;
      armSafetyTimer();
      return detached;
    }
    function restore(reason) {
      if (!suspended) return false;
      clearSafetyTimer();
      const p = parked;
      parked = null;
      if (p && p.node) {
        try {
          p.node.removeAttribute(SUSPEND_ATTR);
          const parent = p.parent && p.parent.isConnected ? p.parent : doc.documentElement || doc.body;
          if (parent) {
            if (p.next && p.next.parentNode === parent) parent.insertBefore(p.node, p.next);
            else parent.appendChild(p.node);
          }
        } catch (e) {
        }
      }
      suspended = false;
      lastReason = "";
      onResume(String(reason || "export"));
      return true;
    }
    function isSuspended() {
      return suspended;
    }
    function onKeyDown(e) {
      if (!e || e.altKey) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = String(e.key || "").toLowerCase();
      if (key !== "s") return;
      suspend("save-shortcut");
    }
    function onBeforePrint() {
      suspend("print");
    }
    function onAfterPrint() {
      restore("print");
    }
    function onVisibilityChange() {
      if (doc.visibilityState === "hidden") return;
      restore("visibility");
    }
    function onFocus() {
      restore("focus");
    }
    function onInteract() {
      if (!suspended) return;
      if (now() < graceUntil) return;
      restore("interaction");
    }
    function install() {
      if (installed) return () => {
      };
      installed = true;
      doc.addEventListener("keydown", onKeyDown, true);
      win.addEventListener("beforeprint", onBeforePrint);
      win.addEventListener("afterprint", onAfterPrint);
      win.addEventListener("focus", onFocus);
      doc.addEventListener("visibilitychange", onVisibilityChange);
      doc.addEventListener("pointerdown", onInteract, true);
      doc.addEventListener("keydown", onInteract, true);
      return uninstall;
    }
    function uninstall() {
      if (!installed) return;
      installed = false;
      try {
        doc.removeEventListener("keydown", onKeyDown, true);
        win.removeEventListener("beforeprint", onBeforePrint);
        win.removeEventListener("afterprint", onAfterPrint);
        win.removeEventListener("focus", onFocus);
        doc.removeEventListener("visibilitychange", onVisibilityChange);
        doc.removeEventListener("pointerdown", onInteract, true);
        doc.removeEventListener("keydown", onInteract, true);
      } catch (e) {
      }
      restore("uninstall");
    }
    return { suspend, restore, isSuspended, install, uninstall };
  }

  // lib/shared/handoff.ts
  var ID_PREFIX = "RF-";
  var ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  var ID_LENGTH = 6;
  var ID_RE = /^RF-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
  var MAX_MESSAGES = 20;
  var MAX_MESSAGE_CHARS = 4e3;
  var MAX_PICKED = 10;
  var MAX_CONSOLE = 30;
  var MAX_STACK_CHARS = 1500;
  var MAX_TEXT_CHARS = 300;
  var MAX_TOOL_TRAIL = 60;
  var MAX_TRAIL_ARGS_CHARS = 200;
  var MAX_TRAIL_RESULT_CHARS = 600;
  function newHandoffId() {
    let out = "";
    const len = ID_ALPHABET.length;
    try {
      const buf = new Uint8Array(ID_LENGTH);
      crypto.getRandomValues(buf);
      for (let i = 0; i < ID_LENGTH; i++) out += ID_ALPHABET[buf[i] % len];
    } catch (e) {
      for (let i = 0; i < ID_LENGTH; i++) out += ID_ALPHABET[Math.floor(Math.random() * len)];
    }
    return ID_PREFIX + out;
  }
  function normalizeHandoffId(raw) {
    let s = String(raw === void 0 || raw === null ? "" : raw).trim().toUpperCase().replace(/[\s-]+/g, "");
    if (!s) return "";
    if (s.startsWith("RF")) s = s.slice(2);
    if (!/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(s)) return "";
    const out = ID_PREFIX + s;
    return ID_RE.test(out) ? out : "";
  }
  function clampText(v, max) {
    const s = String(v === void 0 || v === null ? "" : v);
    return s.length > max ? s.slice(0, max) + "\u2026\uFF08\u5DF2\u622A\u65AD\uFF09" : s;
  }
  function trimMessages(messages, limit = MAX_MESSAGES, maxChars = MAX_MESSAGE_CHARS) {
    const list = Array.isArray(messages) ? messages : [];
    return list.filter((m) => m && typeof m === "object" && (m.role === "user" || m.role === "assistant")).slice(-limit).map((m) => ({ role: m.role, content: clampText(m.content, maxChars) }));
  }
  function trimConsole(entries) {
    const list = Array.isArray(entries) ? entries : [];
    return list.filter((e) => e && (e.level === "error" || e.level === "warn")).slice(-MAX_CONSOLE).map((e) => ({
      level: String(e.level || ""),
      text: clampText(e.text, 1e3),
      stack: clampText(e.stack, MAX_STACK_CHARS),
      at: Number(e.at) || 0
    }));
  }
  function trimPicked(list) {
    const arr = Array.isArray(list) ? list : [];
    return arr.slice(0, MAX_PICKED).map((p) => {
      const src = p && p.source || {};
      return {
        selector: clampText(p && p.selector, 300),
        tag: clampText(p && p.tag, 40),
        text: clampText(p && p.text, MAX_TEXT_CHARS),
        locator: p && p.locator ? p.locator : void 0,
        source: src.file ? { file: clampText(src.file, 400), line: src.line, column: src.column, framework: src.framework, component: src.component } : void 0,
        inShadow: Boolean(p && p.inShadow)
      };
    });
  }
  function buildToolTrail(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const out = [];
    for (const m of list) {
      if (!m || m.role !== "assistant" || !Array.isArray(m.parts)) continue;
      const results = /* @__PURE__ */ new Map();
      for (const p of m.parts) {
        if (p && p.type === "tool-result" && p.callId) results.set(p.callId, p);
      }
      for (const p of m.parts) {
        if (!p || p.type !== "tool-call" || !p.name) continue;
        const r = results.get(p.callId);
        let rawArgs = "";
        try {
          rawArgs = JSON.stringify(p.args || {});
        } catch (e) {
          rawArgs = "";
        }
        const rawResult = r ? String(r.result === void 0 || r.result === null ? "" : r.result) : "";
        const args = clampText(rawArgs, MAX_TRAIL_ARGS_CHARS);
        const result = clampText(rawResult, MAX_TRAIL_RESULT_CHARS);
        const item = {
          name: String(p.name),
          args,
          status: r ? String(r.status || "") : "unknown",
          result
        };
        if (args !== rawArgs || result !== rawResult) {
          item.textClamped = true;
          item.argsChars = rawArgs.length;
          item.resultChars = rawResult.length;
        }
        out.push(item);
      }
    }
    return out;
  }
  function countClampedSteps(trail) {
    return (Array.isArray(trail) ? trail : []).filter((t) => t && t.textClamped === true).length;
  }
  var MAX_TRAIL_FULL = 200;
  var MAX_FULL_TRAIL_BYTES = 4e5;
  function prepareHandoffTrail(rawTrail) {
    const full = Array.isArray(rawTrail) ? rawTrail : [];
    const fitted = fitFullTrailToBudget(full);
    return {
      items: fitted.items,
      total: full.length,
      omitted: fitted.omitted,
      textClamped: countClampedSteps(fitted.items),
      summary: fitted.items.slice(-MAX_TOOL_TRAIL)
    };
  }
  function fitFullTrailToBudget(trail, maxBytes = MAX_FULL_TRAIL_BYTES) {
    const src = Array.isArray(trail) ? trail : [];
    let kept = src.slice(-MAX_TRAIL_FULL);
    while (kept.length > 0 && handoffByteSize(kept) > maxBytes) {
      kept = kept.slice(Math.ceil(kept.length / 2));
    }
    return { items: kept, omitted: src.length - kept.length };
  }
  function handoffByteSize(value) {
    let s = "";
    try {
      s = JSON.stringify(value);
    } catch (e) {
      return Number.MAX_SAFE_INTEGER;
    }
    if (s === void 0) return 0;
    try {
      return new TextEncoder().encode(s).length;
    } catch (e) {
      return s.length * 2;
    }
  }
  function buildHandoffRecord(input = {}) {
    const id = normalizeHandoffId(input.id);
    if (!id) throw new Error("\u4EA4\u63A5\u5305\u9700\u8981\u5408\u6CD5\u7684\u4F1A\u8BDD\u6807\u8BC6");
    const now = Number(input.now) || Date.now();
    const messages = trimMessages(input.messages);
    const consoleErrors = trimConsole(input.consoleEntries);
    const picked = trimPicked(input.pickedElements);
    const rawTrail = Array.isArray(input.toolTrail) ? input.toolTrail : buildToolTrail(input.messages);
    const prepared = prepareHandoffTrail(rawTrail);
    const toolTrail = prepared.summary;
    return {
      id,
      version: 1,
      createdAt: Number(input.createdAt) || now,
      updatedAt: now,
      pageUrl: clampText(input.pageUrl, 1e3),
      pageTitle: clampText(input.pageTitle, 300),
      selection: clampText(input.selection, 1e3),
      lastError: clampText(input.lastError, 1e3),
      messageCount: messages.length,
      messages,
      toolTrail,
      // 四个数的语义要分清（接手方据此判断"我拿到的是不是完整的、缺的能不能取回"）：
      //   trailTotal        会话真实步数
      //   trailStored       可通过分段读取取回的**步数**
      //   trailOmitted      **真正取不回**的步数（超出全量预算）
      //   trailTextClamped  取回得到、但**单步文本被裁**的步数（args/result 不是完整原文）
      //                     ⚠ 少了它，接手方会把"没被 omitted"理解成"完整原文" ✗
      trailTotal: prepared.total,
      trailStored: prepared.items.length,
      trailOmitted: prepared.omitted,
      trailTextClamped: prepared.textClamped,
      pickedElements: picked,
      consoleErrors,
      note: clampText(input.note, 500)
    };
  }
  function formatHandoffPrompt(id, opts = {}) {
    const norm2 = normalizeHandoffId(id);
    if (!norm2) return "";
    const title = String(opts && opts.pageTitle || "").trim();
    const where = title ? "\uFF08\u9875\u9762\uFF1A" + title.slice(0, 80) + "\uFF09" : "";
    return "\u8BFB\u53D6 RecallFlow \u4F1A\u8BDD " + norm2 + where + "\uFF0C\u7136\u540E\u5E2E\u6211\u89E3\u51B3\u5176\u4E2D\u7684\u524D\u7AEF\u95EE\u9898\u3002\n\u82E5\u4F60\u6709 RecallFlow \u7684\u4F1A\u8BDD\u8BFB\u53D6\u5DE5\u5177\uFF0C\u8BF7\u5148\u53D6\u56DE\u8BE5\u4F1A\u8BDD\u4E0A\u4E0B\u6587\u518D\u52A8\u624B\uFF1B\u82E5\u6CA1\u6709\u8FD9\u4E2A\u80FD\u529B\uFF0C\u8BF7\u76F4\u63A5\u8BF4\u660E\uFF0C\u6211\u4F1A\u6539\u7528\u9762\u677F\u7684\u300C\u5BFC\u51FA\u8BB0\u5F55\u300D\u628A\u5185\u5BB9\u7C98\u8D34\u7ED9\u4F60\u3002";
  }

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
  function planCitationOpen(url, currentHref, snippet) {
    const raw = String(url === void 0 || url === null ? "" : url).trim();
    if (!raw) return { action: "none" };
    let samePage = false;
    try {
      const u = new URL(raw, currentHref);
      const cur = new URL(currentHref);
      samePage = u.origin === cur.origin && u.pathname === cur.pathname;
    } catch (e) {
      samePage = false;
    }
    if (samePage) return { action: "highlight" };
    const safe = sanitizeHref(raw);
    if (!safe) {
      return { action: "deny", reason: "\u8BE5\u5F15\u7528\u7684\u94FE\u63A5\u534F\u8BAE\u4E0D\u88AB\u5141\u8BB8\uFF08\u4EC5\u652F\u6301 http/https\u3001mailto\u3001tel\uFF09\uFF0C\u5DF2\u963B\u6B62\u6253\u5F00\u3002" };
    }
    return { action: "open", target: attachSnippetParam(buildCitationDeepLink(safe, snippet), snippet) };
  }
  function parseSuggestionOptions(text) {
    const out = [];
    const blockMatch = String(text || "").match(/<options>([\s\S]*?)<\/options>/i);
    if (blockMatch) {
      try {
        const arr = JSON.parse(blockMatch[1].trim());
        if (Array.isArray(arr)) {
          arr.slice(0, 4).forEach((it) => {
            const label = String(it && it.label || "").trim();
            const desc = String(it && it.desc || "").trim();
            if (label) out.push({ label, desc });
          });
          if (out.length) return out;
        }
      } catch (e) {
      }
    }
    const match = String(text || "").match(/【可选操作】([\s\S]*)$/);
    const section = match ? match[1] : "";
    const re = /(?:^|\n)\s*(?:[-*]|\d+[.、])\s*【([^】\n]{1,12})】\s*([^\n]*)/g;
    let m;
    while ((m = re.exec(section)) && out.length < 4) {
      const label = m[1].trim();
      const desc = m[2].trim();
      if (label) out.push({ label, desc });
    }
    return out;
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
    const escAttr2 = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
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
          return '<button class="cite-badge" data-cite-id="' + escAttr2(c.id || "") + '" data-cite-source="' + escAttr2(c.source || "kb") + '" data-cite-url="' + escAttr2(c.url || "") + '" data-cite-snippet="' + escAttr2(c.snippet || "") + '" title="\u6253\u5F00\u8BC1\u636E\uFF1A' + escAttr2(c.title) + '"><span class="cite-idx">[' + idx + "]</span>" + escAttr2(short) + "</button>";
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
          html += '<div class="code-wrap"><div class="code-head"><span class="code-lang">' + (codeLang ? escAttr2(codeLang) : "code") + '</span><button class="code-copy">\u590D\u5236</button></div><pre><code>' + highlightCode(codeBuf.join("\n")) + "</code></pre></div>";
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
  function renumberCitations(text, citations) {
    const list = Array.isArray(citations) ? citations : [];
    const src = String(text || "");
    const collectRe = /[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g;
    const order = [];
    const seen = /* @__PURE__ */ new Set();
    let m;
    while (m = collectRe.exec(src)) {
      const n = extractCiteNum(m[1]);
      if (n === null || seen.has(n)) continue;
      seen.add(n);
      order.push(n);
    }
    const oldToNew = {};
    const cited = [];
    for (const old of order) {
      const found = list.find((c) => Number(c.index) === old);
      if (!found) continue;
      oldToNew[old] = cited.length + 1;
      cited.push(Object.assign({}, found, { index: cited.length + 1 }));
    }
    if (!cited.length) return { text: src, citations: [] };
    const replaceRe = /[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g;
    const newText = src.replace(replaceRe, (mm, inner) => {
      const old = extractCiteNum(inner);
      if (old === null) return mm;
      const label = inner.replace(/\s*\d+\s*$/, "");
      return oldToNew[old] !== void 0 ? "[" + label + oldToNew[old] + "]" : mm;
    });
    return { text: newText, citations: cited };
  }
  function renumberCitationsAcross(texts, citations) {
    const list = Array.isArray(citations) ? citations : [];
    const sources = Array.isArray(texts) ? texts : [texts];
    const order = [];
    const seen = /* @__PURE__ */ new Set();
    for (const t of sources) {
      const re = /[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g;
      let m;
      while (m = re.exec(String(t || ""))) {
        const n = extractCiteNum(m[1]);
        if (n === null || seen.has(n)) continue;
        seen.add(n);
        order.push(n);
      }
    }
    const oldToNew = {};
    const cited = [];
    for (const old of order) {
      const found = list.find((c) => Number(c.index) === old);
      if (!found) continue;
      oldToNew[old] = cited.length + 1;
      cited.push(Object.assign({}, found, { index: cited.length + 1 }));
    }
    const apply = (text) => {
      const src = String(text === void 0 || text === null ? "" : text);
      if (!cited.length) return src;
      return src.replace(/[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g, (mm, inner) => {
        const old = extractCiteNum(inner);
        if (old === null) return mm;
        const label = inner.replace(/\s*\d+\s*$/, "");
        return oldToNew[old] !== void 0 ? "[" + label + oldToNew[old] + "]" : mm;
      });
    };
    return { citations: cited, apply };
  }
  function encodeSnippet(snippet) {
    try {
      return btoa(unescape(encodeURIComponent(String(snippet || "")))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    } catch (e) {
      return "";
    }
  }
  function decodeSnippet(b64) {
    try {
      let s = String(b64 || "").replace(/-/g, "+").replace(/_/g, "/");
      while (s.length % 4) s += "=";
      const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      return decodeURIComponent(new TextDecoder().decode(bytes));
    } catch (e) {
      return "";
    }
  }
  function attachSnippetParam(url, snippet) {
    try {
      const clean = String(snippet || "").trim();
      const b64 = encodeSnippet(clean);
      if (!b64) return url;
      const hashIdx = url.indexOf("#");
      const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
      const hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
      const sep = base.indexOf("?") >= 0 ? "&" : "?";
      return base + sep + "kbSnippet=" + b64 + hash;
    } catch (e) {
      return url;
    }
  }
  function renderAnswer(text, citations, streaming) {
    const ren = renumberCitations(text, citations);
    return renderMarkdown(stripOptionsBlock(ren.text), ren.citations, streaming);
  }
  function buildCitationDeepLink(url, snippet) {
    try {
      let clean = String(snippet || "").replace(/^\[?\d*\]?\s*/, "").replace(/\s+/g, " ").replace(/…\s*$/g, "").replace(/（页面内容过长，已截断）\s*$/g, "").replace(/^网页正文（[^）]*）：\s*/, "").replace(/^当前页面正文：\s*/, "").trim();
      if (!clean.length) return url;
      const sBreak = clean.search(/[。！？.!?]/);
      const sliceStart = sBreak >= 0 && sBreak <= 50 ? sBreak + 1 : 0;
      const start = clean.slice(sliceStart, sliceStart + 60).trim();
      const suffix = clean.slice(sliceStart + 60, sliceStart + 90).trim();
      if (start.length < 10) return url;
      const enc = (s) => encodeURIComponent(s).replace(/-/g, "%2D");
      let frag = ":~:text=" + enc(start);
      if (suffix.length) frag += "-" + enc(suffix);
      return url + (url.indexOf("#") >= 0 ? "" : "#") + frag;
    } catch (e) {
      return url;
    }
  }
  function stripOptionsBlock(text) {
    return String(text || "").replace(/<options>[\s\S]*?(?:<\/options>|$)/gi, "").replace(/\n{3,}/g, "\n\n").trim();
  }
  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // lib/page/panel-css.ts
  var PANEL_CSS = `
    :host { all: initial; }
    /* \u5B58\u6863\u81EA\u6BC1\u95F8 \u2014\u2014 \u522B\u5220\u8FD9\u6761\u3002
       Edge/Chromium \u7684\u300C\u53E6\u5B58\u4E3A\u300D\u4F1A\u628A open shadow root \u4E00\u8D77\u5E8F\u5217\u5316\u6210\u58F0\u660E\u5F0F shadow DOM
       \uFF08\u5DF2\u5B9E\u6D4B\uFF1A\u4FDD\u5B58\u51FA\u6765\u7684\u526F\u672C\u91CC\u80FD\u770B\u5230 .fab \u4E0E\u56FE\u6807\u5F15\u7528\uFF09\uFF0C\u6240\u4EE5"\u53EA\u8981\u56FE\u6807\u5728 shadow \u91CC\u5C31\u5B89\u5168"\u662F\u9519\u7684\u3002
       \u5BBF\u4E3B\u6539\u7528\u81EA\u5B9A\u4E49\u5143\u7D20 rf-ai-host\uFF1A\u526F\u672C\u91CC\u6CA1\u6709\u6211\u4EEC\u7684\u811A\u672C\uFF0C\u5143\u7D20\u4E0D\u4F1A\u88AB\u5347\u7EA7\uFF0C
       \u4E8E\u662F\u8FD9\u6761 :not(:defined) \u547D\u4E2D\uFF0C\u6574\u5757 UI \u5728\u5B58\u6863\u91CC\u662F display:none \u2014\u2014 \u4E0D\u4F9D\u8D56
       "\u80FD\u4E0D\u80FD\u62E6\u4F4F\u4FDD\u5B58\u52A8\u4F5C"\uFF0C\u4E5F\u4E0D\u9700\u8981\u5077\u5077\u628A DOM \u6458\u6389\u3002
       \u5B9E\u6D4B\u4E09\u7EC4\u5BF9\u7167\uFF1Adiv + \u8BE5\u89C4\u5219 \u2192 \u4ECD\u7136\u663E\u793A\uFF1Brf-ai-host \u672A\u5B9A\u4E49 \u2192 0\xD70 \u9690\u85CF\uFF1B
       rf-ai-host \u5DF2\u5B9A\u4E49 \u2192 52\xD752 \u6B63\u5E38\u663E\u793A\u3002 */
    :host(:not(:defined)) { display: none !important; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
    .bubble {
      position: fixed; z-index: 2147483647;
      display: flex; align-items: center; gap: 6px;
      background: #4a90d9; color: #fff; border-radius: 20px;
      padding: 6px 12px; cursor: pointer; user-select: none;
      font-size: 13px; box-shadow: 0 4px 14px rgba(0,0,0,.25);
      transition: background .15s, transform .15s;
      animation: kb-pop .18s ease;
    }
    @keyframes kb-pop { from { transform: scale(.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    .bubble:hover { background: #3a7cc4; transform: translateY(-1px); }
    .bubble .dot { width: 6px; height: 6px; border-radius: 50%; background: #fff; animation: kb-blink 1.2s infinite; }
    @keyframes kb-blink { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
    .panel {
      position: fixed; z-index: 2147483647;
      width: 640px; height: auto; min-width: 280px; min-height: 320px;
      max-width: calc(100vw - 24px); max-height: calc(100vh - 24px);
      background: #fff; border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.28);
      display: flex; flex-direction: column; overflow: hidden;
      animation: kb-pop .18s ease;
      /* \u5DE6\u53F3\u8FB9\u7F18\u7559\u7ED9 resize \u624B\u67C4\u7684\u6293\u53D6\u5BBD\u5EA6\u3002
         \u624B\u67C4\u662F\u7EDD\u5BF9\u5B9A\u4F4D + z-index:5\uFF0C\u538B\u5728\u6B63\u6587\u4E4B\u4E0A\uFF1B\u800C\u6EDA\u52A8\u6761\u4E5F\u8D34\u5728\u5BB9\u5668\u53F3\u8FB9\u7F18\uFF0C
         \u4E24\u8005\u4F1A\u5B8C\u5168\u91CD\u53E0 \u2014\u2014 \u7ED3\u679C\u5C31\u662F\u6EDA\u52A8\u6761\u70B9\u4E0D\u52A8\u3001\u4E5F\u62D6\u4E0D\u52A8\uFF08mousedown \u88AB resize \u62A2\u8D70\uFF09\u3002
         \u6240\u4EE5\u6EDA\u52A8\u5BB9\u5668\u5FC5\u987B\u6309\u540C\u6837\u5BBD\u5EA6\u53F3\u7F29\uFF0C\u8BA9\u6EDA\u52A8\u6761\u843D\u5728\u624B\u67C4\u5DE6\u4FA7\u3002
         \u53D6\u503C\u540C\u65F6\u88AB .resize-handle.left/.right \u4E0E .p-body \u4F7F\u7528\uFF0C\u907F\u514D\u4E24\u5904\u5404\u5199\u4E00\u4E2A\u6570\u5B57\u540E\u6F02\u79FB\u3002 */
      --rf-edge: 10px;
    }
    .panel.docked { max-height: calc(100vh - 24px); }
    @media (max-width: 640px) { .panel.docked { max-height: calc(100vh - 24px); } }
    .resize-handle {
      position: absolute; right: 0; bottom: 0;
      width: 18px; height: 18px; cursor: nwse-resize;
      user-select: none; touch-action: none; z-index: 5;
    }
    .resize-handle.top-left { right:auto; bottom:auto; left:0; top:0; cursor:nwse-resize; }
    .resize-handle.top-left::after { right:auto; bottom:auto; left:4px; top:4px; border-right:0; border-bottom:0; border-left:2px solid #c0c4cc; border-top:2px solid #c0c4cc; border-radius:3px 0 0 0; }
    .resize-handle.top { left:18px; right:18px; top:0; bottom:auto; width:auto; height:10px; cursor:ns-resize; }
    .resize-handle.bottom { left:18px; right:18px; top:auto; bottom:0; width:auto; height:10px; cursor:ns-resize; }
    .resize-handle.left { left:0; top:18px; right:auto; bottom:18px; width:var(--rf-edge); height:auto; cursor:ew-resize; }
    .resize-handle.right { right:0; left:auto; top:18px; bottom:18px; width:var(--rf-edge); height:auto; cursor:ew-resize; }
    .resize-handle.top-right { left:auto; right:0; top:0; bottom:auto; cursor:nesw-resize; }
    .resize-handle.bottom-left { left:0; right:auto; top:auto; bottom:0; cursor:nesw-resize; }
    .resize-handle::after {
      content: ''; position: absolute; right: 4px; bottom: 4px;
      width: 9px; height: 9px;
      border-right: 2px solid #c0c4cc; border-bottom: 2px solid #c0c4cc;
      border-radius: 0 0 3px 0;
      transition: border-color .15s;
      opacity: 0;
    }
    .resize-handle:hover::after { border-color: transparent; }
    .panel.dark { background: #26292e; }
    .p-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #f5f6f8; border-bottom: 1px solid #e2e5ea; cursor: grab; }
    .p-head:active { cursor: grabbing; }
    .panel.dark .p-head { background: #2f3339; border-color: #3a3f46; }
    .p-head .logo { width: 20px; height: 20px; object-fit: contain; flex-shrink: 0; }
    .p-head .title { font-size: 14px; font-weight: 600; color: #333; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .panel.dark .p-head .title { color: #e3e5e8; }
    .p-head .usage { font-size: 11px; color: #98a0aa; margin-left: auto; margin-right: 6px; white-space: nowrap; }
    .p-head .close { border: none; background: none; color: #6b7280; font-size: 16px; cursor: pointer; line-height: 1; padding: 2px 4px; border-radius: 4px; min-width: 32px; min-height: 32px; }
    .p-head .close:hover { color: #e74c3c; background: rgba(0,0,0,.05); }
/* \u4EA4\u63A5\u6807\u8BC6\u82AF\u7247\uFF1A\u70B9\u4E00\u4E0B\u628A\u672C\u6B21\u4F1A\u8BDD\u6253\u5305\u5E76\u590D\u5236\u53EF\u76F4\u63A5\u7C98\u7ED9 AI \u7684\u6307\u4EE4 */
.p-head .handoff { border: 1px solid #d5d9e0; background: #fff; color: #55606e; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; cursor: pointer; padding: 2px 7px; border-radius: 999px; white-space: nowrap; margin-right: 4px; }
.p-head .handoff:hover { border-color: #4a90d9; color: #4a90d9; }
.p-head .handoff.copied { border-color: #27ae60; color: #27ae60; }
.panel.dark .p-head .handoff { background: #262a30; border-color: #3a3f46; color: #b6bcc6; }
.panel.dark .p-head .handoff:hover { border-color: #4a90d9; color: #4a90d9; }
    .p-head .session-btn { border: 1px solid #d5d9e0; background: #fff; color: #4d5968; font-size: 11px; cursor: pointer; padding: 3px 8px; border-radius: 999px; white-space: nowrap; max-width: 112px; overflow: hidden; text-overflow: ellipsis; }
    .p-head .session-btn:hover { border-color: #4a90d9; color: #4a90d9; }
    .panel.dark .p-head .session-btn { background: #262a30; border-color: #3a3f46; color: #c4cad3; }
    .session-menu { position: absolute; z-index: 30; top: 46px; right: 10px; width: min(340px, calc(100% - 20px)); max-height: min(470px, calc(100vh - 110px)); display: flex; flex-direction: column; background: #fff; border: 1px solid #dfe3e9; border-radius: 11px; box-shadow: 0 12px 34px rgba(22,34,51,.22); overflow: hidden; }
    .session-menu[hidden] { display: none; }
    .panel.dark .session-menu { background: #2a2e34; border-color: #444a53; box-shadow: 0 14px 38px rgba(0,0,0,.45); }
    .session-menu-head { display: flex; align-items: center; justify-content: space-between; padding: 9px 11px; font-size: 11px; font-weight: 600; letter-spacing: .04em; color: #7d8794; border-bottom: 1px solid #edf0f4; }
    .panel.dark .session-menu-head { color: #aab2bd; border-color: #3b4149; }
    .session-menu-close { border: none; background: none; color: #9aa3ae; cursor: pointer; font-size: 13px; padding: 2px 4px; border-radius: 4px; }
    .session-menu-close:hover { background: rgba(0,0,0,.05); color: #596574; }
    .session-list { overflow-y: auto; padding: 4px; min-height: 0; }
    .session-item { display: flex; align-items: stretch; border-radius: 8px; border: 1px solid transparent; }
    .session-item:hover { background: #f5f8fc; }
    .session-item.active { background: #eef5ff; border-color: #cfe3fb; }
    .session-item.running .session-title { color: #b45309; }
    .panel.dark .session-item:hover { background: #323840; }
    .panel.dark .session-item.active { background: #25364a; border-color: #36597f; }
    .session-main { flex: 1; min-width: 0; border: none; background: none; text-align: left; padding: 7px 6px 7px 9px; cursor: pointer; color: #374151; display: flex; flex-direction: column; gap: 2px; }
    .panel.dark .session-main { color: #e1e5eb; }
    .session-title { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 230px; }
    .session-meta { font-size: 11px; color: #66707d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .panel.dark .session-meta { color: #99a3af; }
    .session-actions { display: flex; align-items: center; gap: 1px; padding-right: 4px; opacity: .72; transition: opacity .12s; }
    .session-item:hover .session-actions, .session-item.active .session-actions, .session-item:focus-within .session-actions { opacity: 1; }
    .session-actions button { border: none; background: none; color: #66707d; cursor: pointer; width: 30px; height: 30px; border-radius: 6px; font-size: 13px; padding: 0; }
    .session-actions button:hover { background: rgba(74,144,217,.12); color: #2f74b8; }
    .session-actions button[data-session-action="delete"]:hover { background: rgba(231,76,60,.12); color: #c0392b; }
    .panel.dark .session-actions button { color: #aab2bc; }
    .session-empty { padding: 18px 10px; text-align: center; color: #98a0aa; font-size: 12px; }
    .session-new { border: none; border-top: 1px solid #edf0f4; background: #fafbfc; color: #397cc0; padding: 9px 12px; text-align: left; font-size: 12px; font-weight: 600; cursor: pointer; }
    .session-new:hover { background: #f0f6fd; }
    .panel.dark .session-new { background: #25292f; border-color: #3b4149; color: #72abe2; }
    .panel.dark .session-new:hover { background: #2f3944; }
    .session-dialog-backdrop { position: absolute; inset: 0; z-index: 60; background: rgba(26,32,40,.34); display: flex; align-items: center; justify-content: center; padding: 18px; }
    .session-dialog { width: min(390px, 100%); background: #fff; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,.3); padding: 16px; }
    .panel.dark .session-dialog { background: #2c3036; color: #e4e7ec; }
    .session-dialog-title { font-size: 14px; font-weight: 700; margin-bottom: 7px; }
    .session-dialog-message { font-size: 12px; line-height: 1.6; color: #66707d; margin-bottom: 11px; word-break: break-word; }
    .panel.dark .session-dialog-message { color: #b1b9c3; }
    .session-dialog-input { width: 100%; border: 1px solid #cfd5dd; border-radius: 7px; padding: 7px 9px; font-size: 13px; outline: none; margin-bottom: 13px; background: #fff; color: #333; }
    .session-dialog-input:focus { border-color: #4a90d9; box-shadow: 0 0 0 3px rgba(74,144,217,.14); }
    .panel.dark .session-dialog-input { background: #22262b; color: #e4e7ec; border-color: #49505a; }
    .session-dialog-actions { display: flex; justify-content: flex-end; gap: 7px; flex-wrap: wrap; }
    .session-dialog-actions button { border: 1px solid #d8dde4; background: #fff; color: #596575; border-radius: 7px; padding: 6px 11px; font-size: 12px; cursor: pointer; }
    .session-dialog-actions button:hover { border-color: #4a90d9; color: #3b79b8; }
    .session-dialog-actions .primary { background: #4a90d9; border-color: #4a90d9; color: #fff; }
    .session-dialog-actions .primary:hover { background: #3b80c7; color: #fff; }
    .session-dialog-actions .danger { background: #e74c3c; border-color: #e74c3c; color: #fff; }
    .session-dialog-actions .danger:hover { background: #cf3e2f; color: #fff; }
    .session-dialog-actions .session-dialog-extra { margin-right: auto; color: #397cc0; }
    .panel.dark .session-dialog-actions button { background: #343a42; border-color: #4a505a; color: #d9dee5; }
    .panel.dark .session-dialog-actions .primary { background: #4a90d9; border-color: #4a90d9; color: #fff; }
    .panel.dark .session-dialog-actions .danger { background: #d94b3e; border-color: #d94b3e; color: #fff; }
    .p-text {
      display: flex; align-items: flex-start; gap: 8px; min-height: 52px;
      margin: 0 0 7px; padding: 8px 8px 8px 10px; font-size: 12px; color: #777; line-height: 1.6;
      border-left: 2px solid #e2e5ea; user-select: none; flex-shrink: 0;
    }
    .p-text-quote {
      grid-area: quote;
      flex: 1 1 auto; min-width: 0; max-height: 48px; overflow: auto;
      white-space: pre-wrap; word-break: break-word;
    }
    .p-text-clear {
      grid-area: clear; align-self: start;
      flex: 0 0 auto; border: none; background: transparent; color: #8d98a5;
      width: 26px; height: 26px; border-radius: 5px; cursor: pointer;
      font: 14px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    }
    .p-text-clear:hover { color: #d14343; background: rgba(209,67,67,.1); }
    .panel.dark .p-text { color: #9aa0a8; border-color: #3a3f46; }
    .panel.dark .p-text-clear { color: #9aa0a8; }
    .panel.dark .p-text-clear:hover { color: #ff8a80; background: rgba(255,138,128,.1); }
    /* margin-right \u662F --rf-edge\uFF1A\u628A\u6EDA\u52A8\u6761\u63A8\u5230\u53F3\u4FA7 resize \u624B\u67C4\u7684\u5DE6\u8FB9\u3002
       \u5C11\u4E86\u8FD9\u4E00\u53E5\uFF0C\u624B\u67C4\uFF08\u7EDD\u5BF9\u5B9A\u4F4D + z-index:5\uFF09\u4F1A\u538B\u4F4F\u6EDA\u52A8\u6761\uFF0C\u6EDA\u52A8\u6761\u5C31\u70B9\u4E0D\u52A8\u3001\u62D6\u4E0D\u52A8\u3002 */
    .p-body { padding: 10px 12px; margin-right: var(--rf-edge); overflow-y: auto; flex: 1 1 auto; font-size: 13px; line-height: 1.7; color: #333; word-break: break-word; min-height: 0; scrollbar-width: thin; scrollbar-color: #d5d9e0 transparent; }
    .p-body:focus { outline: none; }
    .p-body::-webkit-scrollbar { width: 8px; }
    .p-body::-webkit-scrollbar-thumb { background: #d5d9e0; border-radius: 999px; }
    .p-body::-webkit-scrollbar-thumb:hover { background: #b8bec6; }
    .p-body::-webkit-scrollbar-track { background: transparent; }
    .panel.dark .p-body { color: #e3e5e8; scrollbar-color: #3a3f46 transparent; }
    .panel.dark .p-body::-webkit-scrollbar-thumb { background: #3a3f46; }
    .panel.dark .p-body::-webkit-scrollbar-thumb:hover { background: #4a5058; }
    .p-body.loading { color: #999; }
    .panel.dark .p-body.loading { color: #9aa0a8; }
    .p-body.error { color: #e74c3c; }
    .msg { margin-bottom: 14px; max-width: 100%; }
    .msg.user {
      background: linear-gradient(135deg, #4a90d9, #63a0e2); color: #fff;
      border-radius: 12px 12px 4px 12px;
      padding: 8px 14px; margin-left: auto; white-space: pre-wrap;
      width: fit-content;
      box-shadow: 0 2px 8px rgba(74,144,217,.22);
    }
    .msg.ai { background: transparent; padding: 0 2px; margin-right: 6px; }
    /* \u7528\u6237\u6C14\u6CE1\u91CC\u300C\u8FD9\u6761\u6D88\u606F\u5E26\u4E0A\u4E86\u54EA\u4E9B\u62FE\u53D6\u5143\u7D20\u300D\u90A3\u4E00\u884C\u3002
       \u5B83\u5FC5\u987B**\u7559\u5728\u6C14\u6CE1\u5185**\uFF1A\u90A3\u662F\u8FD9\u6761\u6D88\u606F\u7684\u4E0A\u4E0B\u6587\uFF0C\u4E0D\u662F\u63D0\u793A\u6761 \u2014\u2014
       \u653E\u5230\u6C14\u6CE1\u5916\u5C31\u53C8\u4F1A\u53D8\u6210"\u53D1\u9001\u540E\u6D88\u5931\u7684\u4E34\u65F6\u72B6\u6001"\u3002 */
    .user-picks { display: block; margin-top: 4px; font-size: 11.5px; line-height: 1.5; color: rgba(255,255,255,.82); word-break: break-all; }
    .user-selection {
      display: block; margin-top: 5px; padding-top: 5px;
      border-top: 1px solid rgba(255,255,255,.24);
      font-size: 11.5px; line-height: 1.5; color: rgba(255,255,255,.9);
    }
    .user-selection-label { display: block; margin-bottom: 1px; font-size: 10px; color: rgba(255,255,255,.68); }
    .user-selection-text {
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
      overflow: hidden; white-space: pre-wrap; word-break: break-word;
    }
    .msg.ai .typing { color: #999; }
    .panel.dark .msg.ai .typing { color: #9aa0a8; }
    .typing { display: inline-flex; gap: 4px; align-items: center; }
    .typing span { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: kb-bounce 1.2s infinite; }
    .typing span:nth-child(2) { animation-delay: .15s; }
    .typing span:nth-child(3) { animation-delay: .3s; }
    @keyframes kb-bounce { 0%,60%,100% { transform: translateY(0); opacity: .4; } 30% { transform: translateY(-4px); opacity: 1; } }
    /* ---- \u601D\u8003\u8BB0\u5F55\uFF08\u601D\u7EF4\u94FE\uFF09----
       \u53EA\u6709**\u63A8\u7406\u6A21\u578B**\u4F1A\u4EA7\u51FA\u5185\u5BB9\uFF08deepseek-reasoner\uFF09\uFF1Bdeepseek-chat \u4E0B\u8FD9\u4E00\u5757\u4E0D\u4F1A\u51FA\u73B0\uFF0C
       \u7528\u6237\u770B\u5230\u7684\u4ECD\u662F\u4E0A\u9762\u90A3\u4E09\u4E2A\u70B9 + FAB \u547C\u5438\u52A8\u753B\u3002
       \u5C55\u5F00/\u6536\u8D77\u7531 data-open \u63A7\u5236\uFF1B\u8FDB\u884C\u4E2D\u7684\u52A8\u753B\u53EA\u5728 data-state="running" \u65F6\u8DD1 \u2014\u2014
       \u9759\u6B62\u7684\u601D\u8003\u8BB0\u5F55\u4E0D\u8BE5\u7EE7\u7EED\u95EA\uFF0C\u5426\u5219\u7528\u6237\u4F1A\u8BEF\u4EE5\u4E3A\u8FD8\u5728\u751F\u6210\u3002 */
    .think-block { margin: 6px 0 8px; border-left: 2px solid rgba(74,144,217,.35); border-radius: 4px; background: rgba(74,144,217,.05); overflow: hidden; }
    .panel.dark .think-block { border-left-color: rgba(106,165,224,.45); background: rgba(106,165,224,.07); }
    .think-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 8px; background: none; border: 0; cursor: pointer; font: inherit; font-size: 12px; color: #6b7c8f; text-align: left; }
    .panel.dark .think-head { color: #9aa0a8; }
    .think-head:hover { color: #4a90d9; }
    .think-label { flex: 1 1 auto; }
    .think-caret { flex: 0 0 auto; font-size: 10px; transition: transform .15s ease; }
    .think-block[data-open="true"] .think-caret { transform: rotate(180deg); }
    .think-dots { display: inline-flex; flex: 0 0 auto; gap: 3px; align-items: center; }
    .think-dots span { width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: .45; }
    .think-block[data-state="running"] .think-dots span { opacity: 1; animation: kb-bounce 1.2s infinite; }
    .think-block[data-state="running"] .think-dots span:nth-child(2) { animation-delay: .15s; }
    .think-block[data-state="running"] .think-dots span:nth-child(3) { animation-delay: .3s; }
    /* \u8FDB\u884C\u4E2D\uFF1A\u6807\u7B7E\u8D70\u4E00\u904D\u626B\u5149\uFF0C\u957F\u601D\u7EF4\u94FE\u91CC\u6BD4\u4E09\u4E2A\u70B9\u66F4\u5BB9\u6613\u88AB\u6CE8\u610F\u5230\u3002
       \u26A0 \u5FC5\u987B\u7528 @supports \u5305\u4F4F\uFF1Abackground-clip:text \u4E0D\u751F\u6548\u65F6 -webkit-text-fill-color:transparent
       \u4F1A\u628A**\u6587\u5B57\u6574\u4E2A\u53D8\u6CA1**\uFF08\u53EA\u5269\u4E00\u6761\u770B\u4E0D\u89C1\u7684\u6E10\u53D8\uFF09\uFF0C\u8FD9\u662F\u5B81\u53EF\u4E0D\u52A8\u753B\u4E5F\u4E0D\u80FD\u5192\u7684\u9669\u3002 */
    @supports ((-webkit-background-clip: text) or (background-clip: text)) {
      .think-block[data-state="running"] .think-label {
        background: linear-gradient(90deg, currentColor 0%, #4a90d9 45%, currentColor 90%);
        background-size: 220% 100%;
        -webkit-background-clip: text; background-clip: text;
        -webkit-text-fill-color: transparent;
        animation: kb-shimmer 1.6s linear infinite;
      }
    }
    @keyframes kb-shimmer { from { background-position: 220% 0; } to { background-position: -220% 0; } }
    /* \u26A0 \u523B\u610F**\u4E0D\u8BBE** max-height / overflow\uFF1A
       \u601D\u8003\u8BB0\u5F55\u662F\u5BF9\u8BDD\u6D41\u91CC\u7684\u4E00\u6BB5\uFF0C\u5E94\u8BE5\u8DDF\u7740\u5BF9\u8BDD\u4E00\u8D77\u957F\u3001\u4E00\u8D77\u6EDA \u2014\u2014 \u7531\u9762\u677F\u81EA\u8EAB\u7684\u6EDA\u52A8\u6761\u8D1F\u8D23\u3002
       \u7ED9\u5B83\u52A0\u5185\u5C42\u6EDA\u52A8\u6761\u4F1A\u6709\u4E24\u4E2A\u95EE\u9898\uFF1A\u2460 \u6EDA\u8F6E\u505C\u5728\u5185\u5C42\u65F6\u6EDA\u4E0D\u52A8\u5916\u5C42\uFF0C\u64CD\u4F5C\u5F88\u522B\u626D\uFF1B
       \u2461 \u601D\u8003\u4E0E\u5B83\u524D\u540E\u7684\u53D9\u8FF0/\u5DE5\u5177\u6B65\u9AA4\u4E0D\u5728\u540C\u4E00\u4E2A\u6EDA\u52A8\u5750\u6807\u91CC\uFF0C\u770B\u4E0D\u51FA\u5BF9\u5E94\u5173\u7CFB\u3002 */
    .think-body { display: none; padding: 0 10px 8px; font-size: 12px; line-height: 1.6; color: #6b7c8f; white-space: pre-wrap; word-break: break-word; }
    .panel.dark .think-body { color: #9aa0a8; }
    .think-block[data-open="true"] .think-body { display: block; }
    .p-body h1, .p-body h2, .p-body h3, .p-body h4 { margin: 14px 0 8px; line-height: 1.4; font-weight: 700; }
    .p-body h1 { font-size: 17px; } .p-body h2 { font-size: 15.5px; } .p-body h3 { font-size: 14.5px; } .p-body h4 { font-size: 13.5px; }
    .msg.ai > :first-child { margin-top: 2px; }
    .msg.ai > :last-child { margin-bottom: 2px; }
    .p-body p { margin: 8px 0; padding: 0; background: none; border-radius: 0; }
    .p-body ul, .p-body ol { margin: 8px 0; padding-left: 22px; background: none; border-radius: 0; padding-top: 2px; padding-bottom: 2px; }
    .p-body li { margin: 4px 0; }
    .p-body li::marker { color: #4a90d9; }
    .panel.dark .p-body li::marker { color: #6aa5e0; }
    .p-body code { background: rgba(74,144,217,.1); color: #3a7cc4; border-radius: 4px; padding: 1px 6px; font-size: 12px; font-family: Consolas, "Cascadia Code", monospace; }
    .panel.dark .p-body code { background: rgba(110,168,254,.15); color: #9ecbff; }
    .code-wrap { position: relative; margin: 10px 0; border-radius: 10px; background: #171a21; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,.18); }
    .panel.dark .code-wrap { background: #14171d; border: 1px solid #2a2f38; }
    .code-head { display: flex; align-items: center; justify-content: space-between; padding: 5px 12px; background: #232833; }
    .panel.dark .code-head { background: #1d222b; }
    .code-lang { font-size: 11px; color: #8b949e; letter-spacing: .5px; text-transform: uppercase; user-select: none; font-family: Consolas, monospace; }
    .code-wrap pre { background: transparent; padding: 12px 14px; overflow-x: auto; margin: 0; }
    .code-wrap pre code { background: none; padding: 0; color: #d6dce5; font-size: 12px; line-height: 1.7; font-family: Consolas, "Cascadia Code", monospace; }
    .code-copy {
      border: none; background: none; color: #8b949e;
      border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer;
      font-family: inherit; transition: color .15s, background .15s; line-height: 1.6;
    }
    .code-copy:hover { color: #fff; background: rgba(255,255,255,.08); }
    .code-copy.copied { color: #4ade80; }
    .tk-comment { color: #8b949e; font-style: italic; }
    .tk-string { color: #a5d6ff; }
    .tk-number { color: #79c0ff; }
    .tk-keyword { color: #ff7b72; font-weight: 600; }
    .tk-type { color: #d2a8ff; }
    .tk-fn { color: #d2a8ff; }
    .p-body blockquote {
      background: var(--note-bg, #f2f4f7); border-left: 3px solid #4a90d9;
      padding: 8px 12px; color: #666; margin: 10px 0; border-radius: 0 8px 8px 0;
    }
    .panel.dark .p-body blockquote { background: #2a2e34; color: #b8bec6; }
    .p-body a { color: #4a90d9; text-decoration: none; }
    .p-body a:hover { text-decoration: underline; }
    .p-body strong { font-weight: 700; }
    .p-body hr { border: none; border-top: 1px solid var(--border, #e2e5ea); margin: 14px 0; }
    .panel.dark .p-body hr { border-color: #3a3f46; }
    .md-table-wrap { margin: 10px 0; overflow-x: auto; border: 1px solid var(--border, #d5d9e0); border-radius: 8px; }
    .p-body table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
    .p-body th, .p-body td { padding: 6px 12px; border-bottom: 1px solid var(--border, #e2e5ea); text-align: left; vertical-align: top; }
    .p-body th { background: #f2f4f7; font-weight: 600; }
    .p-body tbody tr:nth-child(even) { background: rgba(0,0,0,.025); }
    .p-body tr:last-child td { border-bottom: none; }
    .panel.dark .md-table-wrap { border-color: #3a3f46; }
    .panel.dark .p-body th { background: #2a2e34; }
    .panel.dark .p-body th, .panel.dark .p-body td { border-color: #3a3f46; }
    .panel.dark .p-body tbody tr:nth-child(even) { background: rgba(255,255,255,.03); }
    .stream-cursor { position: absolute; z-index: 1; width: 7px; height: 13px; margin-left: 3px; border-radius: 1.5px; background: #4a90d9; pointer-events: none; animation: kb-cursor .9s steps(2, start) infinite; }
    @keyframes kb-cursor { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
    .msg-actions { display: flex; gap: 2px; margin-top: 6px; opacity: 0; transition: opacity .15s; }
    .msg.ai:hover .msg-actions, .msg-actions:hover { opacity: 1; }
    .msg-actions button {
      border: none; background: none; color: #98a0aa; font-size: 11.5px; cursor: pointer;
      padding: 2px 8px; border-radius: 6px; font-family: inherit;
      display: inline-flex; align-items: center; gap: 4px; transition: all .15s;
    }
    .msg-actions button:hover { background: rgba(0,0,0,.06); color: #4a90d9; }
    .panel.dark .msg-actions button:hover { background: rgba(255,255,255,.08); color: #6aa5e0; }
    .stopped-note { margin-top: 6px; font-size: 11.5px; color: #98a0aa; user-select: none; }
    .p-foot { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid #e2e5ea; }
    .panel.dark .p-foot { border-color: #3a3f46; }
    .p-foot button { border: 1px solid #e2e5ea; background: #fff; color: #555; border-radius: 8px; padding: 6px 12px; min-height: 32px; font-size: 12px; cursor: pointer; transition: all .15s; }
    .panel.dark .p-foot button { background: #26292e; border-color: #3a3f46; color: #ccc; }
    .p-foot button:hover { border-color: #4a90d9; color: #4a90d9; }
    .p-foot .spacer { flex: 1; }
    .p-foot .copy-btn { margin-left: auto; }
    /* \u7B2C\u4E8C\u4E2A\u5BFC\u51FA\u6309\u94AE\uFF08\u5BFC\u51FA\u5B8C\u6574\uFF09\u7D27\u6328\u7740\u4E0A\u4E00\u4E2A\uFF1A\u4E24\u4E2A\u90FD\u5403 margin-left:auto \u7684\u8BDD\uFF0C
       \u81EA\u52A8\u5916\u8FB9\u8DDD\u4F1A\u5728\u5B83\u4EEC\u4E4B\u95F4\u4E5F\u6491\u5F00\u4E00\u6BB5\uFF0C\u9875\u811A\u53D8\u6210\u300Cclear \u2026\u2026 \u5BFC\u51FA\u8BB0\u5F55 \u2026\u2026 \u5BFC\u51FA\u5B8C\u6574 \u505C\u6B62\u300D\u3002 */
    .p-foot .copy-btn + .copy-btn { margin-left: 6px; }
    .p-foot .stop-btn { border-color: #e74c3c; color: #e74c3c; font-weight: 600; }
    .p-foot .stop-btn:hover { border-color: #e74c3c; color: #fff; background: #e74c3c; }
    .panel.dark .p-foot .stop-btn { border-color: #e74c3c; color: #e74c3c; }
    .panel.dark .p-foot .stop-btn:hover { color: #fff; background: #e74c3c; }
    .cmd-area { padding: 8px 12px; border-top: 1px solid #e2e5ea; flex-shrink: 0; }
    .cmd-box { display: flex; gap: 6px; align-items: stretch; }
    .panel.dark .cmd-area { border-color: #3a3f46; }
    .cmd-input {
      flex: 1; resize: none; border: 1px solid #e2e5ea; border-radius: 8px;
      padding: 6px 10px; font-size: 13px; font-family: inherit; outline: none;
      background: #fff; color: #333; min-height: 34px; max-height: 120px; line-height: 1.5;
    }
    .panel.dark .cmd-input { background: #26292e; border-color: #3a3f46; color: #e3e5e8; }
    .cmd-input:focus { border-color: #4a90d9; box-shadow: 0 0 0 3px rgba(74,144,217,.15); }
    .cmd-send {
      border: 1px solid #4a90d9; background: #4a90d9; color: #fff;
      border-radius: 8px; padding: 0 14px; font-size: 13px; cursor: pointer; font-family: inherit;
      transition: background .15s; flex-shrink: 0; min-height: 36px;
    }
    .cmd-send:hover { background: #3a7cc4; }
    .cmd-send:disabled { opacity: .5; cursor: not-allowed; }
    .quick-prompts { display: flex; gap: 6px; flex-wrap: wrap; align-items: flex-start; padding: 0 0 3px; margin: 0 0 7px; }
    .quick-prompt { flex: 0 1 auto; min-width: 0; max-width: 100%; border: 1px solid #c8d9ec; background: #f5f9fd; color: #3d6f9e; border-radius: 12px; padding: 5px 10px; min-height: 30px; font-size: 12px; line-height: 1.35; cursor: pointer; white-space: normal; overflow-wrap: anywhere; text-align: left; }
    .quick-prompt:hover { background: #e5f0fb; }
    .panel.dark .quick-prompt { background: #293746; border-color: #3d5570; color: #9bc5eb; }
    .pick-bar { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 7px; }
    .pick-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #3d6f9e; background: #eef5fd; border: 1px solid #c8d9ec; border-radius: 12px; padding: 3px 8px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .panel.dark .pick-chip { background: #293746; border-color: #3d5570; color: #9bc5eb; }
    .pick-chip .pick-clear { border: none; background: none; color: inherit; cursor: pointer; font-size: 12px; padding: 0 0 0 2px; font-family: inherit; }
    .pick-chip .pick-chip-text { overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
    .pick-chip .pick-copy { border: none; background: none; color: inherit; cursor: pointer; font-size: 12px; padding: 0 2px; font-family: inherit; opacity: .75; }
    .pick-chip .pick-copy:hover { opacity: 1; }
    .pick-clear-all { border: 1px solid #c8d9ec; background: #f5f9fd; color: #3d6f9e; border-radius: 12px; padding: 3px 8px; font-size: 11px; cursor: pointer; font-family: inherit; }
    .panel.dark .pick-clear-all { background: #293746; border-color: #3d5570; color: #9bc5eb; }
    .cmd-pick { display: inline-flex; align-items: center; justify-content: center; border: 1px solid #c8d9ec; background: #f5f9fd; color: #3d6f9e; border-radius: 8px; padding: 0 9px; min-width: 36px; min-height: 36px; font-size: 12px; cursor: pointer; flex-shrink: 0; font-family: inherit; white-space: nowrap; }
    .cmd-pick:hover { background: #e5f0fb; }
    .cmd-pick.active { background: #4a90d9; color: #fff; border-color: #4a90d9; }
    .panel.dark .cmd-pick { background: #293746; border-color: #3d5570; color: #9bc5eb; }
    .panel.dark .cmd-pick.active { background: #4a90d9; color: #fff; }
    .suggestion-options { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0 2px; }
    .suggestion-title { width: 100%; font-size: 11px; color: #6b7280; }
    .panel.dark .suggestion-title { color: #9aa7b5; }
    .suggestion-option { border: 1px solid #4a90d9; color: #4a90d9; background: none; border-radius: 12px; padding: 3px 10px; font-size: 11px; cursor: pointer; }
    .suggestion-option:hover { background: #e5f0fb; }
    .panel.dark .suggestion-option { background: #293746; border-color: #5b86b8; color: #9bc5eb; }
    .panel.dark .suggestion-option:hover { background: #34465c; }
    .fab {
      position: fixed; right: 16px; top: 38%; z-index: 2147483646;
      width: 52px; height: 52px; border: 1px solid rgba(255,255,255,.45); border-radius: 50%;
      background: linear-gradient(145deg, #5ba0e5 0%, #3d7fc4 100%);
      color: #fff; display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 700; letter-spacing: .4px; cursor: grab;
      box-shadow: 0 8px 22px rgba(45,105,165,.36), inset 0 1px 1px rgba(255,255,255,.35);
      /* \u26A0 right \u5FC5\u987B\u8FDB\u8FC7\u6E21\u5217\u8868\uFF1A\u6536\u8D77 / \u5C55\u5F00\u6ED1\u7684\u662F right\uFF08\u89C1\u4E0B\u9762 .fab.peek\uFF09\u3002
         \u6F0F\u4E86\u5B83\uFF0C\u60AC\u6D6E\u65F6\u6C14\u6CE1\u4F1A\u77AC\u95F4\u8DF3\u51FA\u6765 \u2014\u2014 \u90A3\u5C31\u662F\u9A8C\u6536\u6807\u51C6 2 \u91CC\u7684"\u65E0\u8DF3\u53D8"\u6CA1\u8FC7\u3002 */
      transition: right .22s ease, transform .18s ease, box-shadow .18s ease, filter .18s ease;
      user-select: none; touch-action: none;
    }
    .user-turn { width: fit-content; max-width: 96%; margin: 0 0 14px auto; }
    .user-turn .msg { margin-bottom: 3px; }
    .user-actions { display: flex; justify-content: flex-end; align-items: center; opacity: 0; transition: opacity .15s; }
    .user-turn:hover .user-actions, .user-actions:hover { opacity: 1; }
    .user-actions button { border: none; background: none; color: #98a0aa; font-size: 11.5px; cursor: pointer; padding: 2px 7px; border-radius: 6px; font-family: inherit; }
    .user-actions button:hover { background: rgba(0,0,0,.06); color: #4a90d9; }
    .panel.dark .user-actions button:hover { background: rgba(255,255,255,.08); color: #6aa5e0; }
    @media (hover: none) { .msg-actions, .user-actions { opacity: 1; } }
    .fab::before { content: ''; position: absolute; inset: 5px; border: 1px solid rgba(255,255,255,.2); border-radius: 50%; pointer-events: none; }
    .fab::after { content: ''; position: absolute; right: -2px; bottom: 2px; width: 10px; height: 10px; border-radius: 50%; background: #52d38a; border: 2px solid #fff; }
    .fab:hover { transform: translateY(-2px) scale(1.06); filter: saturate(1.08); box-shadow: 0 11px 26px rgba(45,105,165,.46), inset 0 1px 1px rgba(255,255,255,.4); }
    .fab:active { transform: translateY(0) scale(.97); }
    .fab.dragging { cursor: grabbing; transform: scale(.98); transition: none; }
    .fab:focus-visible { outline: 3px solid rgba(91,160,229,.45); outline-offset: 3px; }
    .fab img { width: 37px; height: 37px; object-fit: contain; position: relative; z-index: 1; }
    .fab.hidden { display: none; }
    .fab.thinking { animation: fab-pulse 1.2s ease-in-out infinite; }
    @keyframes fab-pulse { 0%,100% { box-shadow: 0 8px 22px rgba(45,105,165,.36), 0 0 0 0 rgba(82,211,138,.35); } 50% { box-shadow: 0 10px 26px rgba(45,105,165,.48), 0 0 0 7px rgba(82,211,138,0); } }
    /* TITA-36 \u6536\u8D77\u6001\uFF1A\u6574\u9897\u6C14\u6CE1\u5411\u53F3\u63A8\u51FA\u89C6\u53E3\uFF0C\u53EA\u7559 FAB_PEEK_VISIBLE(12px) \u5728\u89C6\u53E3\u91CC\u3002
       \u7B97\u672F\uFF1A\u5BBD\u5C4F 52 - 12 = 40\uFF1B\u7A84\u5C4F\uFF08\u4E0B\u9762\u90A3\u6761\u5A92\u4F53\u67E5\u8BE2\uFF0946 - 12 = 34\u3002
       \u6C14\u6CE1\u76F4\u5F84\u6539\u4E86\uFF0C\u8FD9\u4E24\u4E2A\u6570\u5FC5\u987B\u8DDF\u7740\u6539\uFF0C\u5426\u5219\u4E0D\u662F\u9732\u592A\u591A\u5C31\u662F\u9732\u4E0D\u7740\u3002 */
    .fab.peek { right: -40px; }
    @media (max-width: 600px) {
      .fab { right: 12px; width: 46px; height: 46px; font-size: 13px; }
      .fab.peek { right: -34px; }
    }
    @media (hover: none) {
      /* \u89E6\u5C4F\u6CA1\u6709"\u60AC\u6D6E"\u8FD9\u56DE\u4E8B\uFF1A\u6536\u8D77\u6001\u5524\u4E0D\u56DE\u6765\uFF0C\u53EA\u5269 12px \u7684\u70B9\u4E0D\u5230\u3002
         \u6CA1\u6709 hover \u80FD\u529B\u7684\u8BBE\u5907\u76F4\u63A5\u53D6\u6D88\u6536\u8D77\u3002 */
      .fab.peek { right: 16px; }
    }
    @media (hover: none) and (max-width: 600px) { .fab.peek { right: 12px; } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
    }
    .cite-badge {
      display: inline-flex; align-items: center; gap: 3px;
      background: #eaf3fc; color: #4a90d9; border: 1px solid #b8d4f0;
      border-radius: 10px; padding: 0 7px; margin: 0 2px;
      font-size: 11px; line-height: 1.7; cursor: pointer; user-select: none;
      vertical-align: baseline; transition: all .15s; font-family: inherit;
      max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cite-badge:hover { background: #4a90d9; color: #fff; border-color: #4a90d9; }
    .cite-badge .cite-idx { font-weight: 700; flex-shrink: 0; }
    .panel.dark .cite-badge { background: #2b3644; border-color: #3d5570; color: #7db4e8; }
    .panel.dark .cite-badge:hover { background: #4a90d9; border-color: #4a90d9; color: #fff; }
    .cite-sources {
      margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border, #d5d9e0);
      display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    }
    .cite-sources .cite-label { font-size: 11px; color: #999; margin-right: 2px; }
    .panel.dark .cite-sources { border-color: #3a3f46; }
    .panel.dark .cite-sources .cite-label { color: #8b949e; }
    .agent-steps { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 8px; }
    .agent-flow { position: relative; display: flex; flex-direction: column; gap: 4px; margin: 2px 0 8px; }
    .agent-plan { margin: 2px 0 8px; padding: 8px 10px; border: 1px solid #dbe6f3; border-radius: 10px; background: #f7faff; }
    .panel.dark .agent-plan { background: #232a33; border-color: #3a4654; }
    .agent-plan-title { font-size: 11px; font-weight: 700; color: #4a90d9; margin-bottom: 5px; }
    .agent-plan-item { font-size: 12px; line-height: 1.6; color: #6b7280; }
    .panel.dark .agent-plan-item { color: #9aa6b3; }
    .agent-plan-item.done { color: #16a34a; text-decoration: line-through; opacity: .8; }
    .agent-plan-item.in_progress { color: #2563eb; font-weight: 600; }
    .panel.dark .agent-plan-item.done { color: #4ade80; }
    .panel.dark .agent-plan-item.in_progress { color: #7db4e8; }
    /* \u6267\u884C\u8BA1\u5212\u6761\uFF1A\u4F4D\u4E8E**\u5E95\u90E8\u63A7\u4EF6\u533A\u7684\u7B2C\u4E00\u683C**\uFF08\u5FEB\u6377\u6307\u4EE4\u4E4B\u4E0A\u3001\u5BF9\u8BDD\u4E4B\u4E0B\uFF09\u3002
       \u4F4D\u7F6E\u8BD5\u8FC7\u56DB\u8F6E\u624D\u5BF9\uFF1A\u8D34\u52A9\u624B\u6D88\u606F\u5F00\u5934\u4F1A\u968F\u5BF9\u8BDD\u6EDA\u8D70\uFF1B\u8D34\u5BF9\u8BDD\u533A\u9876\u90E8\u4F1A\u538B\u4F4F\u5185\u5BB9
       \uFF08\u8BA1\u5212\u662F\u8FC7\u7A0B\u3001\u5BF9\u8BDD\u662F\u5185\u5BB9\uFF0C\u8FC7\u7A0B\u4E0D\u8BE5\u5360\u5185\u5BB9\u533A\u6700\u9876\u4E0A\u7684\u7248\u9762\uFF09\uFF1B\u7D27\u8D34\u8F93\u5165\u6846\u65F6
       \u4F1A\u548C\u5BA1\u6279 / \u5FEB\u6377\u6307\u4EE4 / \u81EA\u52A8\u6279\u51C6 / \u62FE\u53D6\u680F\u6324\u5728\u4E00\u8D77\uFF0C\u800C\u90A3\u4E00\u683C\u91CC\u53EA\u6709\u8F93\u5165\u6846\u5C5E\u4E8E\u300C\u8F93\u5165\u300D\u3002
       \u73B0\u5728\u5B83\u5728\u5BF9\u8BDD\u4E4B\u5916\u3001\u53C8\u548C\u7528\u6237\u64CD\u4F5C\u7684\u90A3\u4E00\u6574\u5757\u5728\u4E00\u8D77\u3002

       **\u523B\u610F\u4E0D\u8BBE max-height / overflow-y**\uFF1A\u9650\u9AD8\u52A0\u5185\u5C42\u6EDA\u52A8\u6761\u4F1A\u628A\u8BA1\u5212\u6761\u53D8\u6210\u4E00\u4E2A\u5C0F\u6EDA\u52A8\u6846\uFF0C
       \u65E2\u96BE\u770B\u53C8\u8981\u4E8C\u6B21\u6EDA\u52A8\u3002\u6B65\u9AA4\u8FC7\u591A\u6539\u4E3A\u300C\u6536\u6210\u4E00\u884C / \u70B9\u51FB\u5C55\u5F00\u5168\u90E8\u300D\u2014\u2014
       \u5C55\u5F00\u65F6\u4E0D\u8BBE\u9AD8\u5EA6\u4E0A\u9650\uFF0C\u56E0\u6B64\u4EFB\u4F55\u60C5\u51B5\u4E0B\u90FD\u4E0D\u4F1A\u51FA\u73B0\u5185\u5C42\u6EDA\u52A8\u6761\u3002 */
    .agent-plan-bar {
      margin: 0 0 8px;
      box-shadow: 0 1px 3px rgba(15, 40, 80, .06);
    }
    .agent-plan-bar .agent-plan-title { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
    .agent-plan-bar .agent-plan-title:hover { color: #2f6fb5; }
    .agent-plan-bar .agent-plan-title::before {
      content: ''; width: 6px; height: 6px; border-radius: 50%; background: #4a90d9; flex: none;
    }
    /* \u6536\u8D77\u6001\uFF1A\u4E00\u884C\u6807\u9898\uFF0C\u5217\u8868\u6574\u5757\u4E0D\u6E32\u67D3\u3002 */
    .agent-plan-bar.collapsed { padding: 6px 10px; }
    .agent-plan-bar.collapsed .agent-plan-title { margin-bottom: 0; }
    .agent-plan-bar.collapsed .agent-plan-items { display: none; }
    .agent-step {
      font-size: 11.5px; line-height: 1.5; color: #7a8694;
      background: rgba(74,144,217,.08); border-left: 2px solid #4a90d9;
      padding: 4px 8px; border-radius: 0 6px 6px 0; word-break: break-word;
    }
    .agent-step.verify-final { margin-top: 8px; }
    .panel.dark .agent-step { background: rgba(110,168,254,.12); color: #9aa6b3; }
    .agent-tool { font-weight: 600; color: #4a90d9; }
    .panel.dark .agent-tool { color: #7db4e8; }
    .agent-tool-arg { color: inherit; opacity: .85; }
    /* \u5DE5\u5177\u6B65\u9AA4\u53EF\u5C55\u5F00\uFF1Aargs \u4E0E result \u672C\u5C31\u5B58\u5728 parts \u91CC\u5374\u4ECE\u4E0D\u6E32\u67D3\uFF0C
       \u7528\u6237\u53EA\u80FD\u5F00 DevTools \u624D\u80FD\u77E5\u9053\u300C\u5B83\u5230\u5E95\u8BFB\u5230\u4E86\u4EC0\u4E48\u300D\u3002 */
    .agent-step > summary { cursor: pointer; list-style: none; display: flex; gap: 4px; align-items: baseline; outline: none; }
    .agent-step > summary::-webkit-details-marker { display: none; }
    .agent-step > summary::before { content: '\u25B8'; font-size: 9px; opacity: .7; flex-shrink: 0; }
    .agent-step[open] > summary::before { content: '\u25BE'; }
    .agent-step > summary:focus-visible { outline: 2px solid #4a90d9; outline-offset: 1px; border-radius: 4px; }
    .agent-step-detail { margin: 5px 0 1px; padding-top: 5px; border-top: 1px dashed rgba(0,0,0,.14); }
    .panel.dark .agent-step-detail { border-color: rgba(255,255,255,.14); }
    .agent-step-label { font-size: 10.5px; font-weight: 700; opacity: .75; margin: 3px 0 2px; }
    .agent-step-pre { margin: 0; padding: 5px 7px; border-radius: 6px; background: rgba(0,0,0,.05); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow: auto; }
    .panel.dark .agent-step-pre { background: rgba(0,0,0,.28); }
    .auth-challenge {
      margin: 5px 0 8px; padding: 8px 10px; border: 1px solid #f0c36d;
      border-left: 4px solid #d97706; border-radius: 7px; background: #fff8e6; color: #7c4a03;
      font-size: 12px; line-height: 1.55;
    }
    .auth-challenge-title { font-weight: 700; margin-bottom: 2px; }
    .auth-challenge-summary { word-break: break-word; }
    .auth-challenge-link {
      display: inline-flex; align-items: center; margin-top: 6px; padding: 3px 9px;
      border: 1px solid #c98a00; border-radius: 6px; background: #fff;
      color: #8a5a00; font-weight: 600; text-decoration: none;
    }
    .auth-challenge-link:hover { border-color: #a86f00; color: #6f4600; background: #fffdf7; }
    .auth-challenge-link:focus-visible { outline: 2px solid #4a90d9; outline-offset: 2px; }
    .panel.dark .auth-challenge {
      border-color: #7c5a18; border-left-color: #d97706; background: #3b321d; color: #f3d28b;
    }
    .panel.dark .auth-challenge-link { background: #262218; border-color: #9b731f; color: #f3cd75; }
    /* \u622A\u56FE\uFF1A\u7ED9\u7528\u6237\u7684\u53EF\u89C6\u8BC1\u636E\uFF08\u6A21\u578B\u770B\u4E0D\u5230\u56FE\uFF0C\u6240\u4EE5\u53EA\u4F5C\u5C55\u793A\uFF09 */
    .agent-shot { margin: 6px 0; }
    .agent-shot img { display: block; max-width: 100%; max-height: 190px; border: 1px solid #d7dde5; border-radius: 8px; cursor: zoom-in; background: #fff; }
    .panel.dark .agent-shot img { border-color: #3a3f46; }
    .agent-shot-cap { display: block; margin-top: 3px; font-size: 11px; color: #98a0aa; }
    .agent-shot.gone { font-size: 11.5px; color: #98a0aa; padding: 3px 6px; border: 1px dashed #d7dde5; border-radius: 6px; }
    .panel.dark .agent-shot.gone { border-color: #3a3f46; }
    .shot-lightbox { position: absolute; inset: 0; background: rgba(0,0,0,.82); z-index: 30; display: flex; align-items: center; justify-content: center; padding: 12px; cursor: zoom-out; }
    .shot-lightbox img { max-width: 100%; max-height: 100%; border-radius: 6px; }
    /* \u8FDB\u5EA6\u4E0E\u8017\u65F6\uFF1A\u957F\u4EFB\u52A1\u4E0D\u518D\u9ED1\u7BB1 */
    .p-progress { display: none; align-items: center; gap: 8px; padding: 5px 14px; font-size: 11.5px; color: #6b7280; background: #f7faff; border-bottom: 1px solid #e2e5ea; flex-shrink: 0; }
    .p-progress.on { display: flex; }
    .panel.dark .p-progress { background: #232a33; border-color: #3a3f46; color: #9aa6b3; }
    .p-progress .pp-dot { width: 6px; height: 6px; border-radius: 50%; background: #4a90d9; animation: kb-blink 1.2s infinite; flex-shrink: 0; }
    .p-progress .pp-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .p-progress .pp-time { font-variant-numeric: tabular-nums; opacity: .85; flex-shrink: 0; }
    /* \u4E3B\u9898\u5207\u6362 */
    .p-head .theme { border: 1px solid transparent; background: none; color: #98a0aa; cursor: pointer; font-size: 13px; line-height: 1; padding: 2px 5px; border-radius: 6px; font-family: inherit; transition: all .15s; }
    .p-head .theme:hover { background: rgba(0,0,0,.06); color: #4a90d9; }
    .panel.dark .p-head .theme:hover { background: rgba(255,255,255,.08); color: #6aa5e0; }
    /* \u9AD8\u98CE\u9669\u5DE5\u5177\u5BA1\u6279\uFF1A\u7ED9\u5B8C\u6574\u4EE3\u7801\u800C\u4E0D\u662F\u622A\u65AD\u5230 400 \u5B57\u7B26 */
    .tool-approval-code { margin: 4px 0 0; padding: 6px 8px; border-radius: 6px; background: rgba(0,0,0,.06); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow: auto; }
    .panel.dark .tool-approval-code { background: rgba(0,0,0,.3); }
    .tool-approval-label { font-size: 10.5px; font-weight: 700; opacity: .8; margin-top: 5px; }
    .agent-content { min-height: 1px; }
    .tool-approval { margin: 10px 0; padding: 12px; border: 1px solid #f0b35b; border-radius: 12px; background: #fffaf0; font-size: 12px; color: #5f461d; box-shadow: 0 3px 12px rgba(112,76,20,.08); }
    .tool-approval-title { display:flex; align-items:center; gap:7px; font-weight: 700; font-size: 13px; margin-bottom: 7px; color:#4b3514; }
    .tool-approval-title::before { content:'!'; display:grid; place-items:center; width:20px; height:20px; border-radius:50%; background:#f59e0b; color:#fff; font-size:12px; }
    .tool-approval-summary { margin-bottom: 9px; line-height:1.55; }
    .tool-approval-tool { display:inline-flex; padding:2px 7px; border-radius:5px; background:rgba(245,158,11,.14); font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11px; }
    .tool-approval-risk { display:inline-flex; margin-left:6px; padding:2px 7px; border-radius:999px; background:#fee2e2; color:#b91c1c; font-size:10px; font-weight:600; }
    .tool-approval-detail { margin:0 0 10px; padding:7px 8px; max-height:72px; overflow:auto; border:1px solid rgba(146,101,31,.18); border-radius:7px; background:rgba(255,255,255,.58); color:#765c32; font-size:11px; word-break:break-word; }
    .tool-approval-actions { display: flex; gap: 7px; flex-wrap:wrap; }
    .tool-approval button { min-height:32px; border: 1px solid transparent; border-radius: 7px; padding: 0 10px; cursor: pointer; font-size: 11px; font-weight:600; transition:filter .15s, transform .15s; }
    .tool-approval button:hover { filter:brightness(.96); transform:translateY(-1px); }
    .tool-approval button:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
    .tool-approve { color: #fff; background: #2563eb; }
    .tool-approve-session { color: #166534; background: #dcfce7; border-color:#86efac !important; }
    .tool-reject { color: #6b7280; background: transparent; border-color:#d1d5db !important; }
    .panel.dark .tool-approval { background: #2f291c; border-color: #866323; color: #efd59a; }
    .panel.dark .tool-approval-title { color:#f7dfaa; }
    .panel.dark .tool-approval-detail { background:rgba(0,0,0,.16); border-color:#5d4b2e; color:#d9bd82; }
    .panel.dark .tool-approve-session { color:#bbf7d0; background:#163b2a; border-color:#28734b !important; }
    .panel.dark .tool-reject { color:#c5cbd3; border-color:#59616d !important; }
    .approval-settings { position:relative; padding:8px 10px; border-bottom:1px solid var(--border,#d5d9e0); }
    .panel.approval-open { overflow:visible; }
    .approval-settings-toggle { width:100%; min-height:36px; text-align:left; color:#526079; background:transparent; border:0; font-size:12px; cursor:pointer; padding:6px 2px; }
    .approval-settings-toggle span { float:right; font-size:22px; line-height:12px; }
    .approval-settings-popover { position:absolute; left:10px; right:10px; bottom:42px; z-index:20; padding:10px; border:1px solid var(--border,#d5d9e0); border-radius:9px; background:var(--panel-bg,#fff); box-shadow:0 8px 24px rgba(0,0,0,.16); max-height:56vh; overflow:auto; }
    .approval-settings-caption { color:#888; font-size:10px; margin:6px 0 4px; }
    .approval-autopilot { display:block; padding:4px 2px 6px; font-size:12px; cursor:pointer; border-bottom:1px solid var(--border,#e2e5ea); }
    .panel.dark .approval-autopilot { border-color:#3a3f46; }
    .approval-group { margin:4px 0 2px; padding:0 0 0 8px; border-left:2px solid #e2e5ea; }
    .panel.dark .approval-group { border-color:#3a3f46; }
    .approval-group-title { font-size:10.5px; font-weight:700; letter-spacing:.3px; color:#6b7280; margin:6px 0 2px; text-transform:none; }
    .panel.dark .approval-group-title { color:#9aa0a8; }
    .approval-settings-popover label.approval-item { display:block; padding:4px 2px; font-size:12px; cursor:pointer; }
    .approval-settings-popover label.approval-item small { color:#9aa0a8; font-size:10.5px; margin-left:3px; }
    .approval-settings-popover input { accent-color:#4a90d9; margin-right:6px; }
    .approval-settings-popover select { margin-left:4px; font-size:12px; padding:2px 4px; border-radius:6px; border:1px solid #d5d9e0; background:#fff; color:inherit; font-family:inherit; }
    .panel.dark .approval-settings-popover select { background:#26292e; border-color:#3a3f46; color:#e3e5e8; }
    .panel.dark .approval-settings-toggle { color:#b6c0cc; }
    .panel.dark .approval-settings-popover { background:#26292e; border-color:#3a3f46; }
    @media (max-width: 480px) {
      .p-head { gap: 6px; padding: 8px 10px; }
      .p-head .logo { width: 18px; height: 18px; }
      .p-head .session-btn { max-width: 86px; min-height: 32px; }
      .p-foot { flex-wrap: wrap; }
      .p-foot .copy-btn { margin-left: 0; }
      .session-actions button { width: 36px; height: 36px; }
      .quick-prompt { min-height: 32px; }
    }
    /* \u6253\u5370 / \u5BFC\u51FA PDF\uFF1A\u6253\u5370\u8D70\u7684\u662F**\u6E32\u67D3**\uFF0Cshadow \u91CC\u7684\u60AC\u6D6E\u7403\u4E0E\u9762\u677F\u4F1A\u5B9E\u6253\u5B9E\u5370\u51FA\u6765\u3002
       \u8FD9\u6761\u89C4\u5219\u5199\u5728 shadow \u5185\u90E8\uFF0C\u56E0\u6B64\u4E0D\u9700\u8981\u5F80\u9875\u9762 light DOM \u91CC\u63D2\u4EFB\u4F55 <style> \u2014\u2014
       \u5BFC\u51FA\u4EA7\u7269\u91CC\u4E5F\u5C31\u4E0D\u4F1A\u591A\u51FA\u4E00\u4E2A"\u6269\u5C55\u7559\u4E0B\u7684\u6837\u5F0F\u6807\u7B7E"\u3002
       \u4E0E lib/page/save-clean.js \u7684 beforeprint \u6458\u9664\u4E92\u4E3A\u4FDD\u9669\uFF1A\u4EFB\u4E00\u6761\u751F\u6548\uFF0C\u7EB8\u9762\u4E0A\u90FD\u5E72\u51C0\u3002 */
    @media print {
      :host { display: none !important; visibility: hidden !important; }
    }
`;

  // lib/page/panel-layout.ts
  var PANEL_POS_KEY = "recallflow-panel-pos";
  var PANEL_SIZE_KEY = "recallflow-panel-size";
  var PANEL_MIN_WIDTH = 280;
  var PANEL_MIN_HEIGHT = 320;
  var PANEL_VIEWPORT_INSET = 24;
  var PANEL_LAYOUT_VERSION = 2;
  function isFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
  }
  function normalizeViewport(viewport) {
    const width = Number(viewport && viewport.width);
    const height = Number(viewport && viewport.height);
    return {
      width: Number.isFinite(width) ? width : 0,
      height: Number.isFinite(height) ? height : 0
    };
  }
  function clampPanelSize(size, viewport) {
    const { width: vw, height: vh } = normalizeViewport(viewport);
    const width = Number(size && size.width);
    const height = Number(size && size.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return {
      width: Math.max(1, Math.min(vw - PANEL_VIEWPORT_INSET, Math.max(PANEL_MIN_WIDTH, width))),
      height: Math.max(1, Math.min(vh - PANEL_VIEWPORT_INSET, Math.max(PANEL_MIN_HEIGHT, height)))
    };
  }
  function emptySnapshot() {
    return { width: null, height: null, left: null, top: null, docked: null, hasPos: false };
  }
  function readPanelLayout(storage) {
    if (!storage) return emptySnapshot();
    let pos = null;
    let size = null;
    try {
      pos = JSON.parse(storage.getItem(PANEL_POS_KEY) || "null");
    } catch (e) {
      pos = null;
    }
    try {
      size = JSON.parse(storage.getItem(PANEL_SIZE_KEY) || "null");
    } catch (e) {
      size = null;
    }
    const out = emptySnapshot();
    if (size && isFiniteNumber(Number(size.width)) && Number(size.width) > 0) out.width = Number(size.width);
    if (size && isFiniteNumber(Number(size.height)) && Number(size.height) > 0) out.height = Number(size.height);
    if (pos && isFiniteNumber(pos.left) && isFiniteNumber(pos.top)) {
      out.left = pos.left;
      out.top = pos.top;
      out.hasPos = true;
    }
    if (pos && typeof pos.docked === "boolean") out.docked = pos.docked;
    return out;
  }
  function writePanelLayout(storage, snapshot) {
    if (!storage) return null;
    const s = snapshot || {};
    const width = Number(s.width);
    const height = Number(s.height);
    const record = {
      width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
      height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
      left: s.manualPos === true && isFiniteNumber(s.left) ? Math.round(s.left) : null,
      top: s.manualPos === true && isFiniteNumber(s.top) ? Math.round(s.top) : null,
      docked: s.docked === true
    };
    try {
      if (s.writeSize !== false && record.width && record.height) {
        storage.setItem(
          PANEL_SIZE_KEY,
          JSON.stringify({ version: PANEL_LAYOUT_VERSION, width: record.width, height: record.height })
        );
      }
      storage.setItem(
        PANEL_POS_KEY,
        JSON.stringify({ version: PANEL_LAYOUT_VERSION, docked: record.docked, left: record.left, top: record.top })
      );
    } catch (e) {
      return null;
    }
    return record;
  }
  function resolvePanelPlacement(options) {
    const opts = options || {};
    const viewport = normalizeViewport(opts.viewport);
    const sizeWidth = Math.max(1, Number(opts.size && opts.size.width) || 0);
    const sizeHeight = Math.max(1, Number(opts.size && opts.size.height) || 0);
    const dockGap = Number.isFinite(Number(opts.dockGap)) ? Number(opts.dockGap) : 0;
    const layout = opts.layout || null;
    const savedDocked = layout && typeof layout.docked === "boolean" ? layout.docked : null;
    const docked = opts.docked == null ? savedDocked === true : opts.docked === true;
    if (layout && layout.hasPos && isFiniteNumber(layout.left) && isFiniteNumber(layout.top)) {
      return {
        docked,
        manualPos: true,
        left: Math.min(Math.max(0, viewport.width - sizeWidth), Math.max(0, layout.left)),
        top: Math.min(Math.max(0, viewport.height - sizeHeight), Math.max(0, layout.top)),
        right: null,
        bottom: null
      };
    }
    if (docked) {
      return {
        docked: true,
        manualPos: false,
        left: null,
        top: null,
        right: 0,
        // 底部留白是「大屏上移」的观感，视口太矮时它会把面板顶部顶出屏幕
        // （实测：1200×520 + 480 高面板 ⇒ top=-38）。越界时收窄留白，正常视口不变。
        bottom: Math.min(dockGap, Math.max(0, viewport.height - sizeHeight - 8))
      };
    }
    const pointX = Number(opts.point && opts.point.x);
    const pointY = Number(opts.point && opts.point.y);
    const x = Number.isFinite(pointX) ? pointX : 0;
    const y = Number.isFinite(pointY) ? pointY : 0;
    return {
      docked: false,
      manualPos: false,
      left: Math.min(Math.max(4, x), Math.max(4, viewport.width - sizeWidth - 4)),
      // 与旧实现一致：点太靠下时按「面板较高」预留，避免顶部被推出视口。
      top: Math.min(
        Math.max(4, y),
        Math.max(4, viewport.height - Math.min(sizeHeight, viewport.height - PANEL_VIEWPORT_INSET) - 4)
      ),
      right: null,
      bottom: null
    };
  }
  function clampPanelIntoView(rect, viewport) {
    const { width: vw, height: vh } = normalizeViewport(viewport);
    const r = rect || {};
    const width = Math.max(0, Number(r.width) || 0);
    const height = Math.max(0, Number(r.height) || 0);
    const left = Number(r.left);
    const top = Number(r.top);
    return {
      left: Math.min(Math.max(0, vw - width), Math.max(0, Number.isFinite(left) ? left : 0)),
      top: Math.min(Math.max(0, vh - height), Math.max(0, Number.isFinite(top) ? top : 0))
    };
  }

  // lib/assistant/run-hub.ts
  function endReasoning(state) {
    if (!state.reasoning) return;
    state.parts.push({ type: "thinking", text: state.reasoning });
    state.reasoning = "";
  }
  function flushNarration(state) {
    if (!state.narration) return;
    state.parts.push({ type: "narration", text: state.narration });
    state.narration = "";
  }
  function pushNotice(state, text, color) {
    const value = String(text || "").trim();
    if (!value) return;
    state.parts.push({ type: "notice", text: value, color: color || "" });
  }
  function pushStepNotice(state, text, color) {
    endReasoning(state);
    flushNarration(state);
    pushNotice(state, text, color);
  }
  function applyRunEvent(state, event) {
    if (!state || !event || typeof event !== "object") return state;
    switch (event.type) {
      case "citations":
        state.citations = Array.isArray(event.citations) ? event.citations.slice() : [];
        break;
      case "reasoning":
        if (event.text) state.reasoning += String(event.text);
        break;
      case "chunk":
        endReasoning(state);
        if (event.text) {
          const text = String(event.text);
          state.content += text;
          state.narration += text;
        }
        break;
      case "tool-call":
        endReasoning(state);
        flushNarration(state);
        state.parts.push({
          type: "tool-call",
          callId: String(event.callId || ""),
          name: String(event.name || ""),
          args: event.args && typeof event.args === "object" ? event.args : {},
          risk: String(event.risk || "unknown")
        });
        if (event.requiresApproval) {
          state.approval = {
            callId: String(event.callId || ""),
            name: String(event.name || ""),
            args: event.args && typeof event.args === "object" ? event.args : {},
            risk: String(event.risk || "unknown"),
            allowSession: event.allowSession !== false
          };
        }
        break;
      case "tool-result":
        endReasoning(state);
        flushNarration(state);
        state.parts.push({
          type: "tool-result",
          callId: String(event.callId || ""),
          name: String(event.name || ""),
          status: String(event.status || ""),
          result: String(event.result || ""),
          // 登录 / 权限提示必须跟着 tool-result 走：跟随页、刷新接管与历史回放
          // 都从同一个 parts 数组重建，不再各猜一份页面状态。
          ...event.needsLogin === true && event.authChallenge ? { needsLogin: true, authChallenge: event.authChallenge } : event.needsLogin === true ? {
            needsLogin: true,
            authChallenge: {
              required: true,
              reason: "login-required",
              summary: String(event.authMessage || "\u64CD\u4F5C\u88AB\u767B\u5F55 / \u6743\u9650\u62E6\u622A\u3002"),
              message: String(event.authMessage || "\u64CD\u4F5C\u88AB\u767B\u5F55 / \u6743\u9650\u62E6\u622A\u3002"),
              loginUrl: String(event.loginUrl || "")
            }
          } : {}
        });
        if (state.approval && state.approval.callId === String(event.callId || "")) state.approval = null;
        break;
      case "screenshot":
        endReasoning(state);
        flushNarration(state);
        state.parts.push({
          type: "screenshot",
          id: String(event.id || ""),
          label: String(event.label || ""),
          width: Number(event.width) || 0,
          height: Number(event.height) || 0,
          bytes: Number(event.bytes) || 0
        });
        break;
      case "stop-requested":
        state.stopping = true;
        state.progress.state = "stopping";
        break;
      case "agent-state":
        state.progress.state = String(event.state || event.status || "");
        if (Number.isFinite(Number(event.step)) && Number(event.step) > 0) state.progress.step = Number(event.step);
        if (Number.isFinite(Number(event.maxSteps)) && Number(event.maxSteps) > 0) state.progress.max = Number(event.maxSteps);
        break;
      case "usage":
        state.tokens = Number(event.totalTokens) || 0;
        break;
      case "plan":
        state.plan = Array.isArray(event.plan) ? event.plan.slice() : [];
        break;
      case "stuck-warning":
        pushStepNotice(state, "\u26A0 " + (event.message || "\u52A8\u4F5C\u6682\u672A\u4EA7\u751F\u53EF\u89C2\u5BDF\u8FDB\u5C55"), "#b45309");
        break;
      case "tool-disabled":
        pushStepNotice(state, "\u26D4 \u5DF2\u505C\u6B62\u4F7F\u7528\u5DE5\u5177\u300C" + (event.name || "") + "\u300D\uFF1A" + (event.reason || ""), "#6b7280");
        break;
      case "budget-exceeded":
        pushStepNotice(state, "\u23F9 " + (event.message || "Agent \u5DF2\u8FBE\u5230\u5B89\u5168\u4E0A\u9650\u5E76\u505C\u6B62"), "#b91c1c");
        break;
      case "tab-switched":
        pushStepNotice(state, "\u2197 \u5DF2\u5207\u6362\u6807\u7B7E\u9875\uFF1A" + (event.title || event.url || "tabId=" + event.tabId), "");
        break;
      case "tabs-closed":
        if (Array.isArray(event.tabIds) && event.tabIds.length) {
          pushStepNotice(state, "\u{1F5D1} \u4EFB\u52A1\u7ED3\u675F\uFF0C\u5DF2\u81EA\u52A8\u5173\u95ED " + event.tabIds.length + " \u4E2A\u672C\u6B21\u6253\u5F00\u7684\u6807\u7B7E\u9875", "#6b7280");
        }
        break;
      case "tabs-close-pending": {
        const count = Array.isArray(event.tabIds) ? event.tabIds.length : 0;
        if (count) {
          pushStepNotice(state, "\u{1F5C2} \u4EFB\u52A1\u7ED3\u675F\uFF0C\u5C06\u5728\u6700\u7EC8\u56DE\u590D\u4FDD\u5B58\u540E\u5173\u95ED " + count + " \u4E2A\u8F85\u52A9\u6807\u7B7E\u9875", "#6b7280");
        }
        break;
      }
      case "intent":
        pushStepNotice(state, "\u{1F9ED} \u610F\u56FE\u8BC6\u522B\uFF1A" + (event.label || event.intent || "\u666E\u901A\u5BF9\u8BDD"), "");
        break;
      case "intent-upgraded":
        pushStepNotice(state, "\u{1F504} \u5DF2\u5207\u6362\u4E3A" + (event.label || "\u8D44\u6599\u7814\u7A76") + "\u6A21\u5F0F\uFF0C\u53EF\u7528\u6D4F\u89C8\u5668/\u7F51\u7EDC\u5DE5\u5177\u7EE7\u7EED", "");
        break;
      case "verify": {
        if (event.ok) {
          state.terminalNotice = {
            type: "notice",
            text: "\u2713 \u5B8C\u6210\u524D\u6821\u9A8C\u901A\u8FC7" + (event.reason ? "\uFF1A" + event.reason : ""),
            color: "#16a34a"
          };
        } else if (event.inconclusive) {
          pushStepNotice(state, "\u2026 \u672A\u80FD\u5B8C\u6210\u6821\u9A8C\uFF1A" + (event.reason || "\u6821\u9A8C\u5668\u4E0D\u53EF\u7528") + "\uFF08\u5DF2\u653E\u884C\uFF09", "#6b7280");
        } else {
          pushStepNotice(
            state,
            "\u26A0 \u6821\u9A8C\u672A\u901A\u8FC7\uFF1A" + (event.reason || "\u76EE\u6807\u53EF\u80FD\u672A\u8FBE\u6210") + (event.missing ? "\uFF08\u8FD8\u5DEE\uFF1A" + event.missing + "\uFF09" : ""),
            "#b45309"
          );
        }
        break;
      }
      case "skill":
        if (Array.isArray(event.skills) && event.skills.length) {
          pushStepNotice(state, "\u{1F6E0} \u542F\u7528\u6280\u80FD\uFF1A" + event.skills.map((s) => s.title || s.name).join("\u3001"), "");
        }
        break;
      case "error":
        endReasoning(state);
        state.status = "error";
        state.error = String(event.error || "\u4EFB\u52A1\u5931\u8D25\uFF08\u672A\u63D0\u4F9B\u9519\u8BEF\u4FE1\u606F\uFF09");
        state.stopping = false;
        break;
      case "end":
        endReasoning(state);
        state.status = "ended";
        state.stopping = false;
        break;
      default:
        break;
    }
    return state;
  }
  function runStateToAssistantMessage(state) {
    if (!state) return null;
    let parts = (state.parts || []).map((p) => Object.assign({}, p));
    if (state.reasoning) parts.push({ type: "thinking", text: state.reasoning, live: true });
    if (state.narration) parts.push({ type: "narration", text: state.narration, live: true });
    if (state.error) parts.push({ type: "notice", text: state.error, color: "#e74c3c" });
    if (state.approval) {
      parts.push({
        type: "notice",
        text: "\u7B49\u5F85\u53D1\u8D77\u6807\u7B7E\u9875\u786E\u8BA4\u5DE5\u5177\u300C" + state.approval.name + "\u300D",
        color: "#b45309"
      });
    }
    if (state.terminalNotice) {
      parts.push(Object.assign({}, state.terminalNotice, { terminal: true }));
    }
    const bound = bindCitationsToText(parts, state.citations);
    return {
      role: "assistant",
      content: "",
      parts: bound.parts,
      plan: Array.isArray(state.plan) ? state.plan.slice() : [],
      citations: bound.citations,
      live: true,
      liveStatus: state.status,
      // 与发起页一致：流式过程中正文可以出现引用徽章，但底部“参考来源”只在收尾后显示。
      showCitations: state.status !== "running"
    };
  }
  function citeNumber(inner) {
    const m = String(inner || "").match(/(\d{1,2})\s*$/);
    return m ? Number(m[1]) : null;
  }
  function bindCitationsToText(parts, citations) {
    const list = Array.isArray(citations) ? citations : [];
    if (!list.length) return { parts, citations: [] };
    const collect2 = /[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g;
    const order = [];
    const seen = /* @__PURE__ */ new Set();
    for (const part of parts) {
      if (!part || part.type !== "narration" && part.type !== "text" || !part.text) continue;
      collect2.lastIndex = 0;
      let m;
      while (m = collect2.exec(String(part.text))) {
        const n = citeNumber(m[1]);
        if (n === null || seen.has(n)) continue;
        seen.add(n);
        order.push(n);
      }
    }
    const oldToNew = /* @__PURE__ */ new Map();
    const cited = [];
    for (const old of order) {
      const found = list.find((c) => Number(c && c.index) === old);
      if (!found) continue;
      oldToNew.set(old, cited.length + 1);
      cited.push(Object.assign({}, found, { index: cited.length + 1 }));
    }
    if (!cited.length) return { parts, citations: [] };
    const replace = (text) => {
      const src = String(text || "");
      return src.replace(/[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g, (whole, inner) => {
        const old = citeNumber(inner);
        if (old === null || !oldToNew.has(old)) return whole;
        const label = String(inner).replace(/\s*\d+\s*$/, "");
        return "[" + label + oldToNew.get(old) + "]";
      });
    };
    const nextParts = parts.map((p) => {
      if (!p || p.type !== "narration" && p.type !== "text" || !p.text) return p;
      return Object.assign({}, p, { text: replace(p.text) });
    });
    return { parts: nextParts, citations: cited };
  }

  // lib/shared/screenshot-store.ts
  var SHOT_KEY = "recallflow.shots.v1";
  var SHOT_ITEM_PREFIX = "recallflow.shots.item.v1.";
  function shotStorageKey(id) {
    return SHOT_ITEM_PREFIX + String(id || "");
  }
  function localArea(chromeApi) {
    return chromeApi && chromeApi.storage && chromeApi.storage.local ? chromeApi.storage.local : null;
  }
  var writeTail = Promise.resolve();
  async function loadScreenshot(chromeApi, id) {
    const area = localArea(chromeApi);
    const wanted = String(id || "");
    if (!area || !wanted) return null;
    const key = shotStorageKey(wanted);
    try {
      const cur = await area.get([key, SHOT_KEY]);
      const item = cur && cur[key];
      if (item && item.dataUrl) return item;
      const archive = Array.isArray(cur && cur[SHOT_KEY]) ? cur[SHOT_KEY] : [];
      return archive.find((entry) => entry && String(entry.id) === wanted && entry.dataUrl) || null;
    } catch (e) {
      return null;
    }
  }

  // lib/page/fab-position.ts
  var FAB_POSITION_KEY = "recallflow.fab-position.v1";
  var LEGACY_FAB_POSITION_KEY = "recallflow-fab-position";
  var FAB_EDGE_GAP = 8;
  var DEFAULT_FAB_RATIO = 0.38;
  var FAB_PEEK_VISIBLE = 12;
  var FAB_PEEK_CLASS = "peek";
  var FAB_PEEK_ZONE_PAD = 4;
  var FAB_SIZE = 52;
  var FAB_RIGHT_GAP = 16;
  var FAB_FALLBACK_HEIGHT_NARROW = 46;
  var FAB_FALLBACK_HEIGHT = 52;
  var NARROW_WIDTH = 600;
  function normalizeFabRatio(value) {
    if (value === null || value === void 0 || value === "") return null;
    const ratio = Number(value);
    return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : null;
  }
  function createFabController(deps = {}) {
    const getFab = typeof deps.getFab === "function" ? deps.getFab : () => null;
    const win = deps.win || { innerWidth: 1280, innerHeight: 800 };
    const storage = deps.storage || null;
    const localStore = deps.localStore || null;
    const now = typeof deps.now === "function" ? deps.now : () => Date.now();
    let ratio = DEFAULT_FAB_RATIO;
    function fabHeight() {
      const fab2 = getFab();
      const measured = fab2 ? fab2.offsetHeight : 0;
      return measured || (win.innerWidth <= NARROW_WIDTH ? FAB_FALLBACK_HEIGHT_NARROW : FAB_FALLBACK_HEIGHT);
    }
    function currentFabTop2() {
      const fab2 = getFab();
      if (!fab2) return FAB_EDGE_GAP;
      const styled = parseFloat(fab2.style.top);
      return Number.isFinite(styled) ? styled : fab2.getBoundingClientRect().top;
    }
    function clampFabTop2(top) {
      const height = fabHeight();
      const maxTop = Math.max(FAB_EDGE_GAP, win.innerHeight - height - FAB_EDGE_GAP);
      return Math.min(maxTop, Math.max(FAB_EDGE_GAP, Number(top) || 0));
    }
    function available() {
      const height = fabHeight();
      return Math.max(1, win.innerHeight - height - FAB_EDGE_GAP * 2);
    }
    function topFromRatio(r) {
      return clampFabTop2(FAB_EDGE_GAP + r * available());
    }
    function ratioFromTop(top) {
      return normalizeFabRatio((clampFabTop2(top) - FAB_EDGE_GAP) / available());
    }
    function applySaved() {
      const fab2 = getFab();
      if (!fab2) return;
      fab2.style.top = topFromRatio(ratio) + "px";
    }
    function legacyRatio() {
      if (!localStore) return null;
      try {
        const saved = JSON.parse(localStore.getItem(LEGACY_FAB_POSITION_KEY) || "null");
        if (!saved || typeof saved !== "object" || saved.ratio == null) return null;
        return normalizeFabRatio(saved.ratio);
      } catch (e) {
        return null;
      }
    }
    function clearLegacy() {
      if (!localStore) return;
      try {
        localStore.removeItem(LEGACY_FAB_POSITION_KEY);
      } catch (e) {
      }
    }
    function persist() {
      const fab2 = getFab();
      if (!fab2) return;
      const next = ratioFromTop(currentFabTop2());
      ratio = next == null ? DEFAULT_FAB_RATIO : next;
      if (!storage || !storage.local) return;
      try {
        const pending = storage.local.set({ [FAB_POSITION_KEY]: { ratio, updatedAt: now() } });
        if (pending && typeof pending.catch === "function") pending.catch(() => {
        });
      } catch (e) {
      }
      clearLegacy();
    }
    async function load() {
      if (storage && storage.local) {
        try {
          const stored = await storage.local.get(FAB_POSITION_KEY);
          const savedEntry = stored ? stored[FAB_POSITION_KEY] : void 0;
          let r = normalizeFabRatio(savedEntry && savedEntry.ratio);
          if (r == null) {
            const legacy = legacyRatio();
            if (legacy != null) {
              r = legacy;
              try {
                await storage.local.set({ [FAB_POSITION_KEY]: { ratio: r, updatedAt: now() } });
              } catch (e) {
              }
            }
          }
          if (r != null) ratio = r;
        } catch (e) {
        }
      } else {
        const legacy = legacyRatio();
        if (legacy != null) ratio = legacy;
      }
      clearLegacy();
      applySaved();
    }
    function moveBy(delta) {
      const fab2 = getFab();
      if (!fab2) return;
      fab2.style.top = clampFabTop2(currentFabTop2() + delta) + "px";
      persist();
    }
    return {
      fabHeight,
      currentFabTop: currentFabTop2,
      clampFabTop: clampFabTop2,
      available,
      topFromRatio,
      ratioFromTop,
      applySaved,
      persist,
      load,
      moveBy,
      legacyRatio,
      getRatio: () => ratio,
      setRatio: (r) => {
        const v = normalizeFabRatio(r);
        if (v != null) ratio = v;
        return ratio;
      }
    };
  }
  function resolveFabPeek(input) {
    const s = input || {};
    if (s.panelOpen === true) return false;
    return !(s.hovered === true || s.focused === true || s.dragging === true);
  }
  function isPointerInFabZone(input) {
    const s = input || {};
    const viewportWidth = Number(s.viewportWidth);
    const rect = s.rect;
    if (!Number.isFinite(viewportWidth) || !rect) return false;
    const pad = Number.isFinite(Number(s.pad)) ? Number(s.pad) : FAB_PEEK_ZONE_PAD;
    const x = Number(s.x);
    const y = Number(s.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const inVerticalBand = y >= rect.top - pad && y <= rect.bottom + pad;
    if (!inVerticalBand) return false;
    const inCollapsedStrip = x >= viewportWidth - FAB_PEEK_VISIBLE - pad && x <= viewportWidth + pad;
    const inExpandedBox = x >= viewportWidth - FAB_RIGHT_GAP - FAB_SIZE - pad && x <= viewportWidth - FAB_RIGHT_GAP + pad;
    return inCollapsedStrip || inExpandedBox;
  }
  function createFabPeekController(deps = {}) {
    const getFab = typeof deps.getFab === "function" ? deps.getFab : () => null;
    const viewportWidth = typeof deps.getViewportWidth === "function" ? deps.getViewportWidth : () => 1280;
    const applyPeek = typeof deps.applyPeek === "function" ? deps.applyPeek : (fab2, on) => fab2.classList.toggle(FAB_PEEK_CLASS, on);
    const state = { panelOpen: false, hovered: false, focused: false, dragging: false };
    let peeked = resolveFabPeek(state);
    function apply() {
      peeked = resolveFabPeek(state);
      const fab2 = getFab();
      if (fab2) applyPeek(fab2, peeked);
      return peeked;
    }
    function set(key, value) {
      const next = value === true;
      if (state[key] === next) return peeked;
      state[key] = next;
      return apply();
    }
    return {
      apply,
      isPeeked: () => peeked,
      getState: () => ({ ...state }),
      /**
       * 鼠标移动：只有**真的离开**气泡的地盘才收起。
       *
       * 不用 pointerleave：气泡向左滑出时会"自己离开鼠标"，那样要么抖要么卡住
       * （见 isPointerInFabZone 的注释）。所以收起的判据始终是坐标，不是边界事件。
       * ⚠ 悬浮态之外（绝大多数鼠标移动）这里只做一次布尔判断就返回，不读布局。
       */
      handlePointerMove: (x, y) => {
        if (!state.hovered) return peeked;
        const fab2 = getFab();
        if (!fab2) return peeked;
        if (isPointerInFabZone({ x, y, rect: fab2.getBoundingClientRect(), viewportWidth: viewportWidth() })) {
          return peeked;
        }
        return set("hovered", false);
      },
      setPanelOpen: (v) => {
        if (v === true) {
          state.hovered = false;
          state.focused = false;
        }
        return set("panelOpen", v);
      },
      setHovered: (v) => set("hovered", v),
      setFocused: (v) => set("focused", v),
      setDragging: (v) => set("dragging", v)
    };
  }

  // lib/application/panel/visibility.ts
  function asRecord(value) {
    return value && typeof value === "object" ? value : null;
  }
  function readUi(value) {
    const record = asRecord(value);
    if (!record) return null;
    const nextSeq = Number(record.seq);
    if (!Number.isFinite(nextSeq)) return null;
    return { seq: nextSeq, open: record.open === true };
  }
  var PanelVisibilityState = class {
    deps;
    seq = 0;
    open = false;
    suppressDepth = 0;
    initPromise = null;
    constructor(deps) {
      this.deps = deps;
    }
    get isOpen() {
      return this.open;
    }
    get canPublish() {
      return this.suppressDepth === 0;
    }
    get ready() {
      return this.initPromise;
    }
    snapshot() {
      return { seq: this.seq, open: this.open };
    }
    async publish(open, scope = "global") {
      this.open = open === true;
      if (!this.canPublish) return null;
      try {
        const response = await this.deps.send("panel:ui:set", {
          open: this.open,
          scope: scope === "membership" ? "membership" : "global"
        });
        this.acceptResponse(response);
        return response;
      } catch (error) {
        return null;
      }
    }
    async apply(ui) {
      const next = readUi(ui);
      if (!next || next.seq < this.seq) return false;
      this.seq = next.seq;
      this.open = next.open;
      if (this.open) {
        if (!this.deps.isMounted()) {
          await this.withSuppressed(() => this.deps.open());
        }
        await this.publish(true, "membership");
      } else {
        if (this.deps.isMounted()) {
          await this.withSuppressed(() => this.deps.close());
        }
        await this.publish(false, "membership");
      }
      return true;
    }
    syncOnInit() {
      if (this.initPromise) return this.initPromise;
      this.initPromise = (async () => {
        let response = null;
        try {
          response = await this.deps.send("panel:ui:get");
        } catch (error) {
          return;
        }
        const message = asRecord(response);
        if (!message || message.ok !== true) return;
        const next = readUi(message.ui);
        if (!next || next.seq < this.seq) return;
        this.seq = next.seq;
        this.open = next.open;
        if (this.open) await this.apply(message.ui);
      })();
      return this.initPromise;
    }
    async withSuppressed(task) {
      this.suppressDepth += 1;
      try {
        return await task();
      } finally {
        this.suppressDepth -= 1;
      }
    }
    acceptResponse(response) {
      const message = asRecord(response);
      if (!message || message.ok !== true) return;
      const next = readUi(message.ui);
      if (!next || next.seq < this.seq) return;
      this.seq = next.seq;
      this.open = next.open;
    }
  };
  function createPanelVisibilityController(deps) {
    return new PanelVisibilityState(deps);
  }

  // lib/application/panel/run-session.ts
  var PanelRunSessionState = class {
    running = false;
    currentRunId = "";
    currentPort = null;
    runner = null;
    interrupt = null;
    get isRunning() {
      return this.running;
    }
    get runId() {
      return this.currentRunId;
    }
    get port() {
      return this.currentPort;
    }
    get hasRunner() {
      return Boolean(this.runner);
    }
    createRunId() {
      return "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    }
    setRunId(runId) {
      this.currentRunId = String(runId || "");
    }
    setRunning(running) {
      this.running = running === true;
    }
    finish() {
      this.running = false;
    }
    setPort(port) {
      this.currentPort = port || null;
    }
    /** 只在 expected 仍是当前端口时清除，避免旧端口的迟到 disconnect 摘掉新连接。 */
    clearPort(expected = null) {
      if (expected && this.currentPort !== expected) return false;
      this.currentPort = null;
      return true;
    }
    closePort() {
      const activePort = this.currentPort;
      this.currentPort = null;
      if (!activePort) return;
      try {
        activePort.disconnect();
      } catch (error) {
      }
    }
    bindRunner(runner) {
      this.runner = typeof runner === "function" ? runner : null;
    }
    invokeRunner(instruction, options) {
      return this.runner ? this.runner(instruction, options) : null;
    }
    bindInterrupt(interrupt) {
      this.interrupt = typeof interrupt === "function" ? interrupt : null;
    }
    requestStop(source) {
      return this.interrupt ? this.interrupt(source) : void 0;
    }
    snapshot() {
      return {
        runId: this.currentRunId,
        running: this.running,
        hasPort: Boolean(this.currentPort)
      };
    }
  };
  function createPanelRunSession() {
    return new PanelRunSessionState();
  }

  // lib/application/panel/stream-state.ts
  var PanelStreamAccumulator = class {
    contentValue = "";
    narrationValue = "";
    previousNarrationValue = "";
    startedValue = false;
    partsValue = [];
    verifyPassValue = null;
    budgetStoppedValue = false;
    get content() {
      return this.contentValue;
    }
    get narration() {
      return this.narrationValue;
    }
    get previousNarration() {
      return this.previousNarrationValue;
    }
    get started() {
      return this.startedValue;
    }
    get parts() {
      return this.partsValue;
    }
    get verifyPass() {
      return this.verifyPassValue;
    }
    get budgetStopped() {
      return this.budgetStoppedValue;
    }
    get responseText() {
      return this.narrationValue || this.previousNarrationValue || this.contentValue;
    }
    reset() {
      this.contentValue = "";
      this.narrationValue = "";
      this.previousNarrationValue = "";
      this.startedValue = false;
      this.partsValue = [];
      this.verifyPassValue = null;
      this.budgetStoppedValue = false;
    }
    beginNew() {
      this.reset();
    }
    restore(snapshot) {
      const source = snapshot || {};
      this.contentValue = String(source.content || "");
      this.narrationValue = String(source.narration || "");
      this.partsValue = Array.isArray(source.parts) ? source.parts.map((part) => Object.assign({}, part)) : [];
      this.previousNarrationValue = "";
      this.startedValue = true;
      this.verifyPassValue = null;
      this.budgetStoppedValue = false;
    }
    appendChunk(text) {
      const piece = String(text || "");
      if (!piece) return;
      this.contentValue += piece;
      this.narrationValue += piece;
      this.startedValue = true;
    }
    appendPart(part) {
      if (!part) return;
      this.partsValue.push(part);
    }
    /** 定稿最后一条正文之前的叙述段；返回被定稿的文本，没有则返回 null。 */
    flushNarration() {
      const text = this.narrationValue;
      if (!text) return null;
      this.previousNarrationValue = text;
      this.partsValue.push({ type: "narration", text });
      this.narrationValue = "";
      return text;
    }
    setVerifyPass(part) {
      this.verifyPassValue = part || null;
    }
    commitVerifyPass() {
      if (!this.verifyPassValue) return;
      this.partsValue.push(this.verifyPassValue);
      this.verifyPassValue = null;
    }
    markBudgetStopped() {
      this.budgetStoppedValue = true;
    }
    hasPartial() {
      return Boolean(this.narrationValue.trim());
    }
  };
  function createPanelStreamState() {
    return new PanelStreamAccumulator();
  }

  // lib/application/ports/runtime.ts
  var UNAVAILABLE_RUNTIME_PORT = {
    async request() {
      return { ok: false, error: "\u6269\u5C55 Runtime \u5C1A\u672A\u6CE8\u5165" };
    }
  };

  // lib/ui/panel/approval-view.ts
  var APPROVAL_LONG_TEXT_FIELD = {
    run_javascript: "code",
    save_skill: "content"
  };
  function describeApprovalRequest(name, args, risk, allowSession) {
    const toolArgs = args && typeof args === "object" ? args : {};
    const longField = APPROVAL_LONG_TEXT_FIELD[name];
    const longText = longField ? String(toolArgs[longField] || "") : "";
    const shownArgs = name === "type_text" ? { ...toolArgs, value: "[\u8F93\u5165\u5185\u5BB9\u5DF2\u9690\u85CF]" } : longText ? { ...toolArgs, [longField]: "[\u5B8C\u6574\u5185\u5BB9\u89C1\u4E0B\u65B9]" } : toolArgs;
    return {
      riskLabel: risk === "high" ? "\u9AD8\u98CE\u9669" : risk === "medium" ? "\u9700\u786E\u8BA4" : "\u5916\u90E8\u64CD\u4F5C",
      argsJson: Object.keys(shownArgs).length ? JSON.stringify(shownArgs) : "",
      longText,
      longLabel: !longText ? "" : name === "save_skill" ? "\u5C06\u8981\u4FDD\u5B58\u7684\u6280\u80FD\u6B63\u6587\uFF08\u4F1A\u8FDB\u5165\u4ECA\u540E\u7684\u7CFB\u7EDF\u63D0\u793A\uFF09" : "\u5C06\u8981\u6267\u884C\u7684\u5B8C\u6574\u4EE3\u7801",
      showSession: allowSession !== false
    };
  }
  function renderApprovalPrompt(box, conn, callId, name, args, risk, allowSession, afterRender = () => {
  }) {
    if (!box || !conn) return false;
    const view = describeApprovalRequest(name, args, risk, allowSession);
    const codeBlock = view.longLabel ? '<div class="tool-approval-label">' + esc(view.longLabel) + '</div><pre class="tool-approval-code">' + esc(view.longText) + "</pre>" : "";
    const sessionBtn = view.showSession ? '<button class="tool-approve-session" aria-label="\u672C\u4EFB\u52A1\u5185\u5141\u8BB8\u6B64\u5DE5\u5177">\u672C\u4EFB\u52A1\u5185\u5141\u8BB8</button>' : "";
    box.innerHTML = '<div class="tool-approval-title">\u6267\u884C\u524D\u9700\u8981\u4F60\u7684\u786E\u8BA4</div><div class="tool-approval-summary">Agent \u8BF7\u6C42\u8C03\u7528 <span class="tool-approval-tool">' + esc(name) + '</span><span class="tool-approval-risk">' + esc(view.riskLabel) + "</span></div>" + (view.argsJson ? '<div class="tool-approval-detail">' + esc(view.argsJson) + "</div>" : "") + codeBlock + '<div class="tool-approval-actions"><button class="tool-approve" aria-label="\u4EC5\u5141\u8BB8\u672C\u6B21\u5DE5\u5177\u8C03\u7528">\u5141\u8BB8\u4E00\u6B21</button>' + sessionBtn + '<button class="tool-reject" aria-label="\u62D2\u7EDD\u5DE5\u5177\u8C03\u7528">\u62D2\u7EDD</button></div>';
    box.style.display = "";
    const decide = (decision) => {
      try {
        conn.postMessage({ type: "tool-approval", callId, decision });
      } catch (error) {
      }
      box.style.display = "none";
      box.innerHTML = "";
    };
    box.querySelector(".tool-approve").addEventListener("click", () => decide("once"));
    const sessionEl = box.querySelector(".tool-approve-session");
    if (sessionEl) sessionEl.addEventListener("click", () => decide("session"));
    box.querySelector(".tool-reject").addEventListener("click", () => decide("reject"));
    afterRender();
    return true;
  }

  // lib/ui/panel/tool-step-view.ts
  function clipDetail(text, max) {
    const value = String(text === void 0 || text === null ? "" : text);
    if (!value) return "";
    return value.length > max ? value.slice(0, max) + "\n\u2026\uFF08\u5171 " + value.length + " \u5B57\u7B26\uFF0C\u5DF2\u622A\u65AD\uFF09" : value;
  }
  function toolStepHtml(lead, name, hint, detailLabel, detail) {
    const head = '<span class="agent-tool">' + esc(lead) + esc(name) + "</span>" + (hint ? '<span class="agent-tool-arg">\uFF1A' + esc(hint) + "</span>" : "");
    if (!detail) return '<div class="agent-step">' + head + "</div>";
    return '<details class="agent-step"><summary>' + head + '</summary><div class="agent-step-detail">' + (detailLabel ? '<div class="agent-step-label">' + esc(detailLabel) + "</div>" : "") + '<pre class="agent-step-pre">' + esc(detail) + "</pre></div></details>";
  }
  function toolStepElement(lead, name, hint, detailLabel, detail) {
    const wrap = document.createElement("div");
    wrap.innerHTML = toolStepHtml(lead, name, hint, detailLabel, detail);
    return wrap.firstElementChild;
  }
  function safeAuthLink(value) {
    try {
      const url = new URL(String(value || ""));
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      url.username = "";
      url.password = "";
      return url.href;
    } catch (error) {
      return "";
    }
  }
  function authChallengeHtml(auth) {
    if (!auth || auth.required !== true) return "";
    const loginUrl = safeAuthLink(auth.loginUrl);
    const summary = String(auth.summary || auth.message || "\u64CD\u4F5C\u88AB\u767B\u5F55 / \u6743\u9650\u62E6\u622A\uFF0C\u8BF7\u767B\u5F55\u540E\u91CD\u8BD5\u3002");
    const reason = auth.reason === "permission-denied" ? "\u6743\u9650\u9650\u5236" : auth.reason === "mcp-token-required" ? "\u670D\u52A1\u7AEF\u70B9\u62D2\u7EDD\uFF08\u51ED\u636E\uFF09" : "\u767B\u5F55\u62E6\u622A";
    return '<div class="auth-challenge" role="alert" data-auth-reason="' + esc(auth.reason || "login-required") + '"><div class="auth-challenge-title">\u26A0 \u64CD\u4F5C\u88AB' + esc(reason) + '</div><div class="auth-challenge-summary">' + esc(summary) + "</div>" + (loginUrl ? '<a class="auth-challenge-link" href="' + esc(loginUrl) + '" target="_blank" rel="noopener noreferrer">\u6253\u5F00\u767B\u5F55\u9875</a>' : "") + "</div>";
  }
  function authChallengeElement(auth) {
    const html = authChallengeHtml(auth);
    if (!html) return null;
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    return wrap.firstElementChild;
  }

  // lib/page/chat.ts
  function isExtContextAlive() {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) return false;
      chrome.runtime.getManifest();
      return true;
    } catch (e) {
      return false;
    }
  }
  function extUrl(path) {
    try {
      return chrome.runtime.getURL(path);
    } catch (e) {
      return "";
    }
  }
  var extDeadWarned = false;
  function warnExtDead() {
    if (extDeadWarned) return;
    extDeadWarned = true;
    try {
      const d = document.createElement("div");
      d.textContent = "RecallFlow \u5DF2\u66F4\u65B0\uFF0C\u5F53\u524D\u9875\u9762\u52A9\u624B\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\u3002";
      d.style.cssText = "position:fixed;z-index:2147483647;left:50%;top:16px;transform:translateX(-50%);background:#e74c3c;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.3);font-family:inherit;";
      (document.body || document.documentElement).appendChild(d);
      setTimeout(() => {
        try {
          d.remove();
        } catch (e) {
        }
      }, 6e3);
    } catch (e) {
    }
  }
  var HOST_TAG = "rf-ai-host";
  function createHostElement() {
    try {
      const el = document.createElement(HOST_TAG);
      if (el && typeof el.matches === "function" && el.matches(":defined")) return el;
    } catch (e) {
    }
    return document.createElement("div");
  }
  var uiSuspended = false;
  var exportGuard = null;
  var host = null;
  var shadow = null;
  var bubble = null;
  var panel = null;
  var panelBody = null;
  var lastText = "";
  var lastResponse = "";
  var dragState = null;
  var resizeState = null;
  var pageText = "";
  var panelTextEl = null;
  var fab = null;
  var fabDragState = null;
  var fabSuppressClickUntil = 0;
  var lastShortcutToggleAt = 0;
  var conversation = [];
  var panelTitleEl = null;
  var panelSessionId = "";
  var panelSessionSeq = 0;
  var panelSessionList = [];
  var panelSessionActiveId = "";
  var panelSessionMenuEl = null;
  var panelSessionBtnEl = null;
  var panelSessionMenuOpen = false;
  var panelSessionSaveChain = Promise.resolve();
  var panelSessionSwitchInFlight = false;
  var deferredRemoteSessionId = "";
  var panelSessionLockHeld = false;
  var panelSessionLockRunId = "";
  var panelVisibility = createPanelVisibilityController({
    send: (type, payload) => sendPanelMessage(type, payload),
    isMounted: () => Boolean(panel),
    open: () => {
      ensureHost();
      lastText = "";
      pageText = pageContextEnabled ? extractPageText() : "";
      openPanel(0, 0, true, true);
    },
    close: () => removePanel({ publish: false })
  });
  var runSession = createPanelRunSession();
  var streamState = createPanelStreamState();
  var runtimePort = UNAVAILABLE_RUNTIME_PORT;
  var followedRunState = null;
  var followedRunId = "";
  var followedCursor = 0;
  var followedMessages = [];
  var followedLiveReady = false;
  var followedDom = null;
  var followRefreshTimer = null;
  var followStatusTimer = null;
  var stopBtn = null;
  var sendBtn = null;
  function computeRunControls(input) {
    const src = input || {};
    const followingRunning = Boolean(src.followed && src.followed.status === "running");
    const running = Boolean(src.streaming || followingRunning);
    const stopping = Boolean(followingRunning && src.followed.stopping);
    return {
      showStop: running,
      // 停止中必须**禁点**：否则用户连点几次，会把同一个中断请求反复发出去。
      stopDisabled: stopping,
      stopText: stopping ? "\u505C\u6B62\u4E2D\u2026" : "\u25A0 \u505C\u6B62",
      sendDisabled: running
    };
  }
  function updateRunControlState() {
    const control = computeRunControls({ streaming: runSession.isRunning, followed: followedRunState });
    if (stopBtn) {
      stopBtn.style.display = control.showStop ? "" : "none";
      stopBtn.disabled = control.stopDisabled;
      stopBtn.textContent = control.stopText;
    }
    if (sendBtn) sendBtn.disabled = control.sendDisabled;
  }
  var pendingAiMsg = null;
  var pendingContentEl = null;
  var flowEl = null;
  var typingEl = null;
  var thinkSeg = null;
  var thinkSegSeq = 0;
  var thinkExpandedManual = null;
  var planBar = null;
  var apiKeyBanner = null;
  var approvalSettingsEl = null;
  var approvalPopoverEl = null;
  var lastPlan = [];
  var planExpanded = null;
  var planWasAllDone = false;
  var streamRender = createFrameScheduler();
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      streamRender.flush();
      pinToBottom();
    });
  }
  var THEME_KEY = "recallflow-panel-theme";
  var themeBtn = null;
  function savedThemeOverride() {
    try {
      return localStorage.getItem(THEME_KEY) || "";
    } catch (e) {
      return "";
    }
  }
  function preferredTheme() {
    const saved = savedThemeOverride();
    if (saved === "dark" || saved === "light") return saved;
    try {
      return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (e) {
      return "light";
    }
  }
  function applyTheme() {
    if (!panel) return;
    const mode = preferredTheme();
    panel.classList.toggle("dark", mode === "dark");
    if (themeBtn) {
      const override = savedThemeOverride();
      const label = override ? "\u4E3B\u9898\uFF1A" + (mode === "dark" ? "\u6DF1\u8272" : "\u6D45\u8272") + "\uFF08\u70B9\u51FB\u5207\u6362\uFF09" : "\u4E3B\u9898\uFF1A\u8DDF\u968F\u7CFB\u7EDF\uFF08\u70B9\u51FB\u5207\u6362\uFF09";
      themeBtn.textContent = override ? mode === "dark" ? "\u{1F319}" : "\u2600\uFE0F" : "\u{1F317}";
      themeBtn.title = label;
      themeBtn.setAttribute("aria-label", label);
    }
  }
  function cycleTheme() {
    const cur = savedThemeOverride();
    const next = cur === "" ? "dark" : cur === "dark" ? "light" : "";
    try {
      if (next) localStorage.setItem(THEME_KEY, next);
      else localStorage.removeItem(THEME_KEY);
    } catch (e) {
    }
    applyTheme();
  }
  try {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onSys = () => {
      if (!savedThemeOverride()) applyTheme();
    };
    if (mq.addEventListener) mq.addEventListener("change", onSys);
    else if (mq.addListener) mq.addListener(onSys);
  } catch (e) {
  }
  var progressEl = null;
  var progressMsgEl = null;
  var progressTimeEl = null;
  var progressTimer = null;
  var runStartedAt = 0;
  var progressState = "";
  var progressStep = 0;
  var progressMax = 0;
  var panelKeyHandler = null;
  var STATE_LABELS = {
    created: "\u51C6\u5907\u4E2D",
    planning: "\u89C4\u5212\u6B65\u9AA4",
    waiting_approval: "\u7B49\u5F85\u4F60\u786E\u8BA4",
    executing: "\u6267\u884C\u52A8\u4F5C",
    observing: "\u67E5\u770B\u7ED3\u679C",
    stopping: "\u505C\u6B62\u4E2D",
    paused: "\u5DF2\u6682\u505C",
    completed: "\u5DF2\u5B8C\u6210",
    failed: "\u6267\u884C\u5931\u8D25",
    cancelled: "\u5DF2\u53D6\u6D88",
    timeout: "\u5DF2\u8FBE\u4E0A\u9650"
  };
  function stateLabel(status) {
    const key = String(status || "").toLowerCase();
    return STATE_LABELS[key] || "";
  }
  function renderProgress() {
    if (progressTimeEl) {
      progressTimeEl.textContent = runStartedAt ? "\u5DF2\u7528\u65F6 " + Math.round((Date.now() - runStartedAt) / 1e3) + "s" : "";
    }
    if (progressMsgEl) progressMsgEl.textContent = composeProgressText(progressStep, progressMax, progressState);
  }
  function startProgress() {
    runStartedAt = Date.now();
    progressState = "";
    progressStep = 0;
    progressMax = 0;
    if (progressEl) progressEl.classList.add("on");
    renderProgress();
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(renderProgress, 1e3);
  }
  function stopProgress() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    if (progressEl) progressEl.classList.remove("on");
    runStartedAt = 0;
    progressState = "";
    progressStep = 0;
    progressMax = 0;
  }
  var keepAliveTimer = null;
  var usageEl = null;
  function resetUsageChip() {
    if (usageEl) usageEl.textContent = "";
  }
  var handoffId = "";
  var conversationLoaded = false;
  var conversationLoadPromise = null;
  var handoffEl = null;
  var pickedElements = [];
  var pickUi = null;
  var picking = false;
  var currentCitations = null;
  var pageContextEnabled = true;
  var citeHighlightEntered2 = false;
  var fabCtl = createFabController({
    getFab: () => fab,
    win: window,
    storage: typeof chrome !== "undefined" ? chrome.storage : null,
    localStore: (() => {
      try {
        return localStorage;
      } catch (e) {
        return null;
      }
    })()
  });
  var fabPeek = createFabPeekController({
    getFab: () => fab,
    // ⚠ 必须是**布局视口**宽度（`documentElement.clientWidth`，不含滚动条）：
    // 气泡的 `right` 是相对布局视口算的，用 `innerWidth`（含滚动条）会让热区整体
    // 右偏一个滚动条宽度，页面一有滚动条就点不到最右边那条边。
    getViewportWidth: () => document.documentElement.clientWidth
  });
  function currentFabTop() {
    return fabCtl.currentFabTop();
  }
  function clampFabTop(top) {
    return fabCtl.clampFabTop(top);
  }
  function normalizeFabRatio2(value) {
    return normalizeFabRatio(value);
  }
  function applySavedFabPosition() {
    fabCtl.applySaved();
  }
  function persistFabPosition() {
    fabCtl.persist();
  }
  async function loadFabPosition() {
    await fabCtl.load();
  }
  function moveFabBy(delta) {
    fabCtl.moveBy(delta);
  }
  function togglePanelFromShortcut() {
    const now = Date.now();
    if (now - lastShortcutToggleAt < 250) return;
    lastShortcutToggleAt = now;
    togglePanel();
  }
  function ensureHost() {
    if (uiSuspended) return;
    if (host && !host.isConnected) resetDetachedHostState();
    if (host) return;
    if (!isExtContextAlive()) {
      warnExtDead();
      return;
    }
    try {
      const stale = document.getElementById(HOST_ID);
      if (stale) stale.remove();
    } catch (e) {
    }
    host = createHostElement();
    host.id = HOST_ID;
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.left = "0";
    host.style.top = "0";
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);
    fab = document.createElement("button");
    fab.className = "fab";
    const fabIcon = document.createElement("img");
    fabIcon.src = extUrl("docs/assets/recallflow-mark.svg");
    fabIcon.alt = "";
    fab.appendChild(fabIcon);
    fab.title = "RecallFlow\uFF08Alt+Shift+R \u6253\u5F00/\u5173\u95ED\uFF0C\u53EF\u4E0A\u4E0B\u62D6\u52A8\uFF09";
    fab.setAttribute("aria-label", "\u6253\u5F00 RecallFlow\uFF0C\u5FEB\u6377\u952E Alt+Shift+R");
    fab.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() < fabSuppressClickUntil) return;
      togglePanel();
    });
    fab.addEventListener("pointerenter", () => fabPeek.setHovered(true));
    fab.addEventListener("focus", () => fabPeek.setFocused(true));
    fab.addEventListener("blur", () => fabPeek.setFocused(false));
    fab.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      fabDragState = {
        pointerId: e.pointerId,
        startY: e.clientY,
        origTop: currentFabTop(),
        moved: false
      };
      fab.classList.add("dragging");
      fabPeek.setDragging(true);
      try {
        fab.setPointerCapture(e.pointerId);
      } catch (err) {
      }
      e.preventDefault();
      e.stopPropagation();
    });
    fab.addEventListener("pointermove", (e) => {
      if (!fabDragState || fabDragState.pointerId !== e.pointerId) return;
      const dy = e.clientY - fabDragState.startY;
      if (Math.abs(dy) > 3) fabDragState.moved = true;
      if (!fabDragState.moved) return;
      fab.style.top = clampFabTop(fabDragState.origTop + dy) + "px";
      e.preventDefault();
    });
    const finishFabDrag = (e) => {
      if (!fabDragState || fabDragState.pointerId !== e.pointerId) return;
      const moved = fabDragState.moved;
      fabDragState = null;
      fab.classList.remove("dragging");
      fabPeek.setDragging(false);
      try {
        fab.releasePointerCapture(e.pointerId);
      } catch (err) {
      }
      if (moved) {
        fabSuppressClickUntil = Date.now() + 350;
        persistFabPosition();
      }
    };
    fab.addEventListener("pointerup", finishFabDrag);
    fab.addEventListener("pointercancel", finishFabDrag);
    fab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      e.stopPropagation();
      moveFabBy(e.key === "ArrowUp" ? -16 : 16);
    });
    shadow.appendChild(fab);
    fabPeek.apply();
    applySavedFabPosition();
    loadFabPosition();
    document.documentElement.appendChild(host);
  }
  function resetDetachedHostState() {
    if (picking) {
      try {
        chrome.runtime.sendMessage({ type: "pick:cancel" });
      } catch (e) {
      }
      picking = false;
      if (pickUi) pickUi = null;
    }
    if (panelKeyHandler) {
      document.removeEventListener("keydown", panelKeyHandler, true);
      panelKeyHandler = null;
    }
    panel = null;
    panelBody = null;
    panelCmdInput = null;
    resetPanelFitCache();
    panelTextEl = null;
    panelTitleEl = null;
    planBar = null;
    stopBtn = null;
    sendBtn = null;
    bubble = null;
    host = null;
    shadow = null;
    fab = null;
    fabDragState = null;
  }
  function watchHostKeepalive() {
    setInterval(() => {
      try {
        if (uiSuspended) return;
        if (host && !host.isConnected) {
          ensureHost();
          if (panelVisibility.isOpen) {
            openPanel(0, 0, true, true);
            if (runSession.isRunning) restoreStreamingUI();
          }
        }
      } catch (e) {
      }
    }, 1e3);
  }
  function installExportGuard() {
    if (exportGuard) return exportGuard;
    exportGuard = createExportGuard({
      getHost: () => host,
      onSuspend: () => {
        uiSuspended = true;
      },
      onResume: () => {
        uiSuspended = false;
      }
    });
    exportGuard.install();
    return exportGuard;
  }
  function removeBubble() {
    if (bubble) {
      bubble.remove();
      bubble = null;
    }
  }
  function removeSelectionPreview() {
    if (panelTextEl) {
      panelTextEl.remove();
      panelTextEl = null;
    }
  }
  function syncPanelSelectionPreview() {
    if (!panel) return;
    const text = String(lastText || "").trim();
    if (!text) {
      removeSelectionPreview();
      return;
    }
    if (!panelTextEl || !panelTextEl.isConnected) {
      const bar = document.createElement("div");
      bar.className = "p-text";
      const quote2 = document.createElement("span");
      quote2.className = "p-text-quote";
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "p-text-clear";
      clear.textContent = "\u2715";
      clear.title = "\u79FB\u9664\u9875\u9762\u9009\u6587";
      clear.setAttribute("aria-label", "\u79FB\u9664\u9875\u9762\u9009\u6587");
      clear.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearSelectedText();
      });
      bar.appendChild(quote2);
      bar.appendChild(clear);
      const quickPrompts = panel.querySelector(".quick-prompts");
      if (quickPrompts && quickPrompts.parentNode) quickPrompts.parentNode.insertBefore(bar, quickPrompts);
      else panel.appendChild(bar);
      panelTextEl = bar;
    }
    const quote = panelTextEl.querySelector(".p-text-quote");
    if (quote) {
      quote.textContent = text.length > 200 ? text.slice(0, 200) + "\u2026" : text;
      quote.title = text;
    }
  }
  function clearSelectedText(options) {
    const opts = options || {};
    lastText = "";
    removeSelectionPreview();
    try {
      const selection2 = window.getSelection();
      if (selection2) selection2.removeAllRanges();
    } catch (e) {
    }
    if (opts.render !== false && panelBody && !runSession.isRunning && !conversation.length && !followedMessages.length) {
      renderConversation();
    }
    if (panel && opts.render !== false) fitPanelHeight();
  }
  function publishPanelUi(open, scope) {
    return panelVisibility.publish(open === true, scope === "membership" ? "membership" : "global");
  }
  function removePanel(options) {
    const hadPanel = Boolean(panel);
    if (picking) {
      try {
        chrome.runtime.sendMessage({ type: "pick:cancel" });
      } catch (e) {
      }
      picking = false;
      if (pickUi) pickUi.setActive(false);
    }
    if (!runSession.isRunning) closePort();
    if (panelKeyHandler) {
      document.removeEventListener("keydown", panelKeyHandler, true);
      panelKeyHandler = null;
    }
    shotLightboxOpen = false;
    clearCiteHighlight();
    if (panel) {
      persistPanelLayoutNow();
      panel.remove();
      panel = null;
      panelBody = null;
      panelCmdInput = null;
      resetPanelFitCache();
      panelTextEl = null;
      panelTitleEl = null;
      planBar = null;
      if (fab) fab.classList.remove("hidden");
      fabPeek.setPanelOpen(false);
    }
    if (hadPanel && !(options && options.publish === false)) publishPanelUi(false, "global");
    if (hadPanel && !(options && options.publish === false)) {
      resetFollowedRun();
      sendPanelMessage("panel:run:unsubscribe").catch(() => {
      });
    }
  }
  function closePort() {
    runSession.closePort();
  }
  function showBubble(x, y) {
    if (!shadow) return;
    removeBubble();
    removePanel({ publish: false });
    bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = '<span class="dot"></span><span>RecallFlow</span>';
    bubble.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    bubble.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPanel(x, y);
    });
    shadow.appendChild(bubble);
    const bubbleWidth = bubble.offsetWidth;
    const bubbleHeight = bubble.offsetHeight;
    const maxLeft = Math.max(4, window.innerWidth - bubbleWidth - 4);
    const maxTop = Math.max(4, window.innerHeight - bubbleHeight - 4);
    const left = Math.min(Math.max(4, x), maxLeft);
    const preferredTop = y - bubbleHeight - 8 > 4 ? y - bubbleHeight - 8 : y + 12;
    const top = Math.min(Math.max(4, preferredTop), maxTop);
    bubble.style.left = left + "px";
    bubble.style.top = top + "px";
  }
  function togglePanel() {
    if (panel) {
      removePanel();
    } else {
      ensureHost();
      lastText = "";
      pageText = pageContextEnabled ? extractPageText() : "";
      openPanel(0, 0, true);
    }
  }
  var BOTTOM_SCROLL_PX = 1e7;
  var CHROME_MEASURE_TTL_MS = 500;
  var chromeMeasure = null;
  var fitBodyClamped = false;
  var panelCmdInput = null;
  function resetPanelFitCache() {
    chromeMeasure = null;
    fitBodyClamped = false;
  }
  function fitChromeSignature() {
    let sig = panel.className + "#";
    sig += (panelCmdInput && panelCmdInput.isConnected ? String(panelCmdInput.value || "").length : "-") + "#";
    for (const child of panel.children) {
      if (child === panelBody || child.classList.contains("resize-handle")) continue;
      sig += child.tagName + "." + String(child.className || "") + ":" + String(child.hidden ? 1 : 0) + ":" + (child.style ? String(child.style.height || "") : "") + ":" + child.children.length + ":" + String(child.textContent || "").length + "|";
    }
    return sig;
  }
  function fitPanelHeight() {
    if (!panel || !panelBody) return;
    if (uiSuspended) return;
    const wasPinned = isPinnedForFollow();
    if (panel._manualSize) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const now = Date.now();
    const sig = fitChromeSignature();
    const reusable = chromeMeasure && chromeMeasure.sig === sig && chromeMeasure.vw === vw && chromeMeasure.vh === vh && now - chromeMeasure.measuredAt < CHROME_MEASURE_TTL_MS;
    if (reusable && fitBodyClamped) {
      chromeMeasure.usedAt = now;
      markSelfScroll();
      if (wasPinned) panelBody.scrollTop = BOTTOM_SCROLL_PX;
      return;
    }
    const dockGap = getDockGap();
    const topLimit = Math.max(12, Math.round(window.innerHeight * 0.1));
    let maxH = Math.max(320, window.innerHeight - dockGap - topLimit);
    const hardMaxH = Math.max(320, window.innerHeight - 24);
    panel.style.height = "auto";
    panelBody.style.height = "auto";
    panelBody.style.flex = "";
    panelBody.style.overflowY = "auto";
    let chromeH = 0;
    for (const child of panel.children) {
      if (child !== panelBody && !child.classList.contains("resize-handle")) chromeH += child.offsetHeight;
    }
    const MIN_BODY_H = 120;
    if (chromeH + MIN_BODY_H > maxH) maxH = Math.min(hardMaxH, chromeH + MIN_BODY_H);
    const bodyNatH = panelBody.scrollHeight;
    const bodyAvailableH = Math.max(MIN_BODY_H, maxH - chromeH);
    const bodyH = Math.min(bodyNatH, bodyAvailableH);
    fitBodyClamped = bodyNatH > bodyAvailableH;
    chromeMeasure = { sig, chromeH, vw, vh, measuredAt: now, usedAt: now };
    panelBody.style.flex = "none";
    panelBody.style.height = bodyH + "px";
    panelBody.style.overflowY = bodyNatH > bodyH ? "auto" : "hidden";
    const totalH = Math.min(maxH, Math.max(320, chromeH + bodyH));
    panel.style.height = totalH + "px";
    if (panel.classList.contains("docked") && !panel._manualPos) {
      panel.style.top = "auto";
      panel.style.bottom = Math.min(dockGap, Math.max(0, window.innerHeight - totalH - 8)) + "px";
    }
    markSelfScroll();
    if (wasPinned) panelBody.scrollTop = BOTTOM_SCROLL_PX;
  }
  function getDockGap() {
    return window.innerWidth <= 640 ? 12 : Math.min(520, Math.max(120, Math.round(window.innerHeight * 0.3)));
  }
  function pinToBottom() {
    if (!observerAutoScroll) return false;
    if (!panelBody || !panelBody.isConnected) return false;
    markSelfScroll();
    panelBody.scrollTop = BOTTOM_SCROLL_PX;
    return true;
  }
  var SELF_SCROLL_MUTE_MS = 300;
  var selfScrollMuteUntil = 0;
  function markSelfScroll() {
    selfScrollMuteUntil = Date.now() + SELF_SCROLL_MUTE_MS;
  }
  var USER_SCROLL_INTENT_MS = 900;
  var userScrollIntentUntil = 0;
  function markUserScrollIntent(up) {
    const now = Date.now();
    userScrollIntentUntil = now + USER_SCROLL_INTENT_MS;
    if (up === true) observerAutoScroll = false;
  }
  function isPinnedForFollow() {
    if (Date.now() < userScrollIntentUntil && observerAutoScroll === false) return false;
    if (!panelBody) return false;
    return !!observerAutoScroll || panelBody.scrollHeight - panelBody.scrollTop - panelBody.clientHeight < 40;
  }
  function msgActionsHtml(isLast) {
    return '<div class="msg-actions"><button class="act-copy" title="\u590D\u5236\u56DE\u7B54\u5185\u5BB9">\u29C9 \u590D\u5236</button>' + (isLast ? '<button class="act-regen" title="\u6309\u4E0A\u4E00\u6761\u6307\u4EE4\u91CD\u65B0\u751F\u6210">\u27F3 \u91CD\u65B0\u751F\u6210</button>' : "") + "</div>";
  }
  function argHint(args) {
    if (!args || typeof args !== "object") return "";
    if (typeof args.query === "string") return args.query;
    if (typeof args.id === "string") return args.id;
    if (typeof args.selector === "string") return args.selector;
    if (Array.isArray(args.selectors) && args.selectors.length) {
      const head = args.selectors.slice(0, 3).join("\u3001");
      return args.selectors.length > 3 ? head + " \u7B49 " + args.selectors.length + " \u4E2A" : head;
    }
    if (typeof args.text === "string") return args.text;
    if (typeof args.value === "string") return args.value;
    if (typeof args.urls === "object" && args.urls) return "";
    if (typeof args.url === "string") return args.url;
    if (typeof args.code === "string") return args.code.replace(/\s+/g, " ").slice(0, 60);
    const keys = Object.keys(args).filter((k) => args[k] !== void 0 && args[k] !== "");
    return keys.length ? keys.slice(0, 3).join("\u3001") : "";
  }
  var SHOT_CACHE_MAX = 30;
  var shotCache = createLruCache(SHOT_CACHE_MAX);
  var shotPending = /* @__PURE__ */ new Set();
  var shotMissing = /* @__PURE__ */ new Set();
  var shotLightboxOpen = false;
  function shotCapText(meta) {
    const m = meta || {};
    const parts = [];
    if (m.label) parts.push(String(m.label));
    if (m.width && m.height) parts.push(m.width + "\xD7" + m.height);
    if (m.bytes) parts.push(Math.round(Number(m.bytes) / 1024) + "KB");
    return parts.join(" \xB7 ");
  }
  function hydrateScreenshot(id) {
    const wanted = String(id || "");
    if (!wanted || shotCache.get(wanted) || shotPending.has(wanted) || shotMissing.has(wanted)) return;
    shotPending.add(wanted);
    loadScreenshot(typeof chrome !== "undefined" ? chrome : null, wanted).then((shot) => {
      if (shot && shot.dataUrl) shotCache.set(wanted, shot.dataUrl);
      else shotMissing.add(wanted);
    }).catch(() => shotMissing.add(wanted)).finally(() => {
      shotPending.delete(wanted);
      if (!runSession.isRunning && panelBody) {
        try {
          renderConversation();
          fitPanelHeight();
          pinToBottom();
        } catch (e) {
        }
      }
    });
  }
  function screenshotHtml(meta) {
    const m = meta || {};
    const id = String(m.id || "");
    const url = id ? shotCache.get(id) : "";
    if (!url) {
      const missing = id && shotMissing.has(id);
      if (id && !missing) hydrateScreenshot(id);
      return '<div class="agent-shot gone">\u{1F5BC} \u622A\u56FE' + (m.label ? "\uFF08" + escHtml(String(m.label)) + "\uFF09" : "") + "\uFF1A" + (!id ? "\u7F3A\u5C11\u622A\u56FE\u6807\u8BC6\uFF0C\u65E0\u6CD5\u4ECE\u5171\u4EAB\u5B58\u50A8\u6062\u590D" : missing ? "\u5171\u4EAB\u5B58\u6863\u5DF2\u8FC7\u671F\u6216\u5DF2\u88AB\u6E05\u7406" : "\u6B63\u5728\u4ECE\u5171\u4EAB\u4F1A\u8BDD\u52A0\u8F7D\u56FE\u7247\u2026") + "</div>";
    }
    return '<div class="agent-shot"><img src="' + escHtml(url) + '" alt="' + escHtml(String(m.label || "\u9875\u9762\u622A\u56FE")) + '" loading="lazy"><span class="agent-shot-cap">\u{1F5BC} ' + escHtml(shotCapText(m)) + " \xB7 \u70B9\u51FB\u653E\u5927</span></div>";
  }
  function screenshotElement(meta) {
    const wrap = document.createElement("div");
    wrap.innerHTML = screenshotHtml(meta);
    return wrap.firstElementChild;
  }
  function openShotLightbox(url) {
    if (!url || !panel) return;
    const box = document.createElement("div");
    box.className = "shot-lightbox";
    const img = document.createElement("img");
    img.src = url;
    box.appendChild(img);
    const close = () => {
      box.remove();
      shotLightboxOpen = false;
    };
    box.addEventListener("click", close);
    shotLightboxOpen = true;
    panel.appendChild(box);
  }
  function userActionsHtml(index) {
    return '<div class="user-actions"><button class="act-rewind" data-turn-index="' + index + '" title="\u64A4\u9500\u8FD9\u6761\u6307\u4EE4\u53CA\u5176\u540E\u7EED\u5BF9\u8BDD">\u21B6 \u64A4\u9500</button><button class="act-user-copy" title="\u590D\u5236\u8FD9\u6761\u6307\u4EE4">\u29C9 \u590D\u5236</button></div>';
  }
  var layoutTimer = null;
  function persistPanelLayoutThrottled() {
    if (layoutTimer || !panel) return;
    layoutTimer = setTimeout(() => {
      layoutTimer = null;
      persistPanelLayoutNow();
    }, 200);
  }
  function persistPanelLayoutNow(opts) {
    if (!panel) return;
    if (!panel.offsetWidth || !panel.offsetHeight) return;
    const r = panel.getBoundingClientRect();
    const docked = panel.classList.contains("docked");
    try {
      writePanelLayout(localStorage, {
        width: panel.offsetWidth,
        height: panel.offsetHeight,
        left: r.left,
        top: r.top,
        docked,
        // 浮动面板的 left/top 就是它的位置；停靠面板只有在用户拖动/拉伸过之后才算手动位置。
        manualPos: docked ? Boolean(panel._manualPos) : true,
        writeSize: !(opts && opts.size === false)
      });
    } catch (e) {
    }
  }
  function clampPanelToViewport() {
    if (!panel) return;
    if (!panel.offsetWidth || !panel.offsetHeight) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const docked = panel.classList.contains("docked");
    if (docked && !panel._manualPos) {
      const top = panel.getBoundingClientRect().top;
      if (top < 0) panel.style.bottom = Math.max(0, vh - panel.offsetHeight - 8) + "px";
      return;
    }
    if (!panel._manualPos) return;
    const r = panel.getBoundingClientRect();
    const next = clampPanelIntoView(
      { left: r.left, top: r.top, width: panel.offsetWidth, height: panel.offsetHeight },
      { width: vw, height: vh }
    );
    if (Math.round(next.left) !== Math.round(r.left)) panel.style.left = next.left + "px";
    if (Math.round(next.top) !== Math.round(r.top)) panel.style.top = next.top + "px";
  }
  function renderDecisionButtonsIfPresent() {
    if (!panelBody || !panel) return;
    if (panelBody.querySelector(".suggestion-options")) return;
    const last = conversation[conversation.length - 1];
    if (last && last.role === "assistant" && /<options>/i.test(String(last.content || ""))) {
      renderSuggestionButtons(panelBody, last.content, panel._sendFn || activeSendFn);
      fitPanelHeight();
    }
  }
  function thinkLabelText(done, len, truncated) {
    if (!done) return "\u601D\u8003\u4E2D\u2026";
    return "\u5DF2\u601D\u8003\uFF08" + len + " \u5B57" + (truncated ? "\uFF0C\u4FDD\u5B58\u65F6\u5DF2\u622A\u65AD" : "") + "\uFF09";
  }
  function refreshThinkHead(seg) {
    if (!seg || !seg.block) return;
    const label = seg.block.querySelector(".think-label");
    if (!label) return;
    const text = thinkLabelText(seg.done === true, String(seg.text || "").length, seg.truncated === true);
    if (label.textContent !== text) label.textContent = text;
  }
  function thinkBlockHtml(text, opts) {
    const o = opts || {};
    const body = String(text == null ? "" : text);
    return '<div class="think-block" data-state="' + (o.done === true ? "done" : "running") + '" data-open="' + (o.open === true ? "true" : "false") + '"><button type="button" class="think-head"><span class="think-dots"><span></span><span></span><span></span></span><span class="think-label">' + escHtml(thinkLabelText(o.done === true, body.length, o.truncated === true)) + '</span><span class="think-caret" aria-hidden="true">\u25BE</span></button><div class="think-body">' + escHtml(body) + "</div></div>";
  }
  function mountThinkSegment(seg, open) {
    if (!flowEl) return null;
    const frag = document.createRange().createContextualFragment(
      thinkBlockHtml(seg.text, { open, done: seg.done, truncated: seg.truncated })
    );
    const block = frag.firstElementChild;
    if (!block) return null;
    seg.block = block;
    seg.body = block.querySelector(".think-body");
    refreshThinkHead(seg);
    flowEl.appendChild(block);
    return block;
  }
  function renderCommittedParts(flow) {
    flowEl = flow;
    for (const p of streamState.parts) {
      if (p.type === "thinking" && p.text) {
        mountThinkSegment({ text: p.text, done: true, block: null, body: null });
      } else if (p.type === "narration" && p.text) {
        const d = document.createElement("div");
        d.className = "agent-content";
        d.innerHTML = renderAnswer(p.text, currentCitations, false);
        flow.appendChild(d);
      } else if (p.type === "tool-call") {
        flow.appendChild(
          toolStepElement("\u{1F527} ", p.name, argHint(p.args), "\u53C2\u6570", clipDetail(JSON.stringify(p.args || {}, null, 2), 2e3))
        );
      } else if (p.type === "tool-result") {
        flow.appendChild(
          toolStepElement(
            p.status === "completed" ? "\u2713 \u5DE5\u5177\u5DF2\u5B8C\u6210\uFF1A" : p.status === "failed" ? "\u2717 \u5DE5\u5177\u5931\u8D25\uFF1A" : "\u2014 \u5DE5\u5177\u672A\u6267\u884C\uFF1A",
            p.name,
            "",
            p.status === "failed" ? "\u9519\u8BEF\u4FE1\u606F" : "\u8FD4\u56DE\u7ED3\u679C",
            clipDetail(p.result, 4e3)
          )
        );
        const authEl = authChallengeElement(p.authChallenge);
        if (authEl) flow.appendChild(authEl);
      }
    }
  }
  function restoreStreamingUI() {
    if (!panelBody || !runSession.isRunning) return;
    if (pendingContentEl && pendingContentEl.isConnected) return;
    const aiMsg = document.createElement("div");
    aiMsg.className = "msg ai";
    const flow = document.createElement("div");
    flow.className = "agent-flow";
    aiMsg.appendChild(flow);
    renderCommittedParts(flow);
    const contentEl = document.createElement("div");
    contentEl.className = "agent-content";
    if (streamState.narration) {
      contentEl.innerHTML = renderAnswer(streamState.narration, currentCitations, false);
    } else {
      contentEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    }
    flow.appendChild(contentEl);
    if (streamState.narration) showStreamingAnswer(contentEl, streamState.narration, currentCitations);
    panelBody.appendChild(aiMsg);
    pendingAiMsg = aiMsg;
    pendingContentEl = contentEl;
    if (thinkSeg && thinkSeg.text) {
      thinkSeg.block = null;
      thinkSeg.body = null;
      mountThinkSegment(thinkSeg, thinkExpandedManual === true);
    }
    typingEl = streamState.narration ? null : contentEl;
    pendingAiMsg._raw = streamState.content;
    if (progressEl) {
      if (!runStartedAt) runStartedAt = Date.now();
      progressEl.classList.add("on");
      renderProgress();
      if (!progressTimer) progressTimer = setInterval(renderProgress, 1e3);
    }
    fitPanelHeight();
    pinToBottom();
  }
  function showCitationHint(text) {
    if (!panelBody) return;
    const hint = document.createElement("div");
    hint.style.cssText = "color:#b45309;font-size:11px;margin:4px 0;padding:4px 6px;background:rgba(180,83,9,.08);border-radius:4px;";
    hint.textContent = text;
    panelBody.appendChild(hint);
    fitPanelHeight();
    setTimeout(() => {
      if (hint.parentNode) hint.parentNode.removeChild(hint);
    }, 5e3);
  }
  function refreshApiKeyBanner() {
    if (!apiKeyBanner) return;
    getAISettings().then((s) => {
      if (!apiKeyBanner) return;
      const missing = !String(s && s.apiKey || "").trim();
      apiKeyBanner.style.display = missing ? "flex" : "none";
      fitPanelHeight();
    }).catch(() => {
    });
  }
  function closeApprovalPopover() {
    if (!approvalPopoverEl || approvalPopoverEl.hidden) return;
    approvalPopoverEl.hidden = true;
    if (panel) panel.classList.remove("approval-open");
    fitPanelHeight();
  }
  function renderApprovalPrompt2(box, conn, callId, name, args, risk, allowSession) {
    return renderApprovalPrompt(box, conn, callId, name, args, risk, allowSession, () => {
      fitPanelHeight();
      pinToBottom();
    });
  }
  var activeSendFn = null;
  function renderSuggestionButtons(container, text, sendFn) {
    const options = parseSuggestionOptions(text);
    if (!options.length) return;
    const wrap = document.createElement("div");
    wrap.className = "suggestion-options";
    const title = document.createElement("div");
    title.className = "suggestion-title";
    title.textContent = "\u53EF\u9009\u62E9\u7EE7\u7EED\u65B9\u5F0F\uFF1A";
    wrap.appendChild(title);
    options.forEach((opt) => {
      const b = document.createElement("button");
      b.className = "suggestion-option";
      b.textContent = opt.label;
      if (opt.desc) b.title = opt.desc;
      b.addEventListener("click", () => {
        if (runSession.isRunning) return;
        const fn = sendFn || activeSendFn;
        if (typeof fn === "function") {
          fn(opt.label + (opt.desc ? "\uFF1A" + opt.desc : ""), { continuation: true });
        }
      });
      wrap.appendChild(b);
    });
    container.appendChild(wrap);
  }
  function citeSourcesHtml(cites) {
    if (!cites || !cites.length) return "";
    return '<div class="cite-sources"><span class="cite-label">\u53C2\u8003\u6765\u6E90\uFF1A</span>' + cites.map(
      (c) => '<button class="cite-badge" data-cite-id="' + escAttr(c.id || "") + '" data-cite-source="' + escAttr(c.source || "kb") + '" data-cite-url="' + escAttr(c.url || "") + '" data-cite-snippet="' + escAttr(c.snippet || "") + '" title="\u6253\u5F00\u8BC1\u636E\uFF1A' + escAttr(c.title) + '"><span class="cite-idx">[' + c.index + "]</span>" + escAttr(c.title.length > 18 ? c.title.slice(0, 18) + "\u2026" : c.title) + "</button>"
    ).join("") + "</div>";
  }
  function escAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }
  var ANSWER_HTML_CACHE_MAX = 240;
  var answerHtmlCache = createLruCache(ANSWER_HTML_CACHE_MAX);
  function cachedAnswerHtml(text, citations) {
    const list = Array.isArray(citations) ? citations : [];
    const sig = list.map((c) => String(c.index) + "|" + String(c.title || "") + "|" + String(c.url || "")).join(",");
    const key = String(text) + "\0" + sig;
    const cached = answerHtmlCache.get(key);
    if (cached !== void 0) return cached;
    const html = renderAnswer(text, citations, false);
    answerHtmlCache.set(key, html);
    return html;
  }
  var streamingCursors = /* @__PURE__ */ new WeakMap();
  function makeContentEl(flow) {
    if (!flow) return null;
    const el = document.createElement("div");
    el.className = "agent-content";
    flow.appendChild(el);
    return el;
  }
  function renderRunError(flow, contentEl, errText, hasPartial) {
    const el = hasPartial || !contentEl ? makeContentEl(flow) : contentEl;
    if (!el) return null;
    removeStreamCursor(el);
    el.textContent = String(errText === void 0 || errText === null ? "" : errText);
    el.style.color = "#e74c3c";
    return el;
  }
  function buildOpenSettingsButton() {
    const go = document.createElement("button");
    go.textContent = "\u6253\u5F00\u8BBE\u7F6E";
    go.style.cssText = "margin-left:8px;border:1px solid #4a90d9;color:#4a90d9;background:none;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px;";
    go.addEventListener("click", () => {
      try {
        chrome.runtime.sendMessage({ type: "openOptions" });
      } catch (e) {
      }
    });
    return go;
  }
  function removeStreamCursor(host2) {
    const rec = host2 && streamingCursors.get(host2);
    if (!rec) return;
    if (rec.cursor && rec.cursor.parentNode) rec.cursor.parentNode.removeChild(rec.cursor);
    streamingCursors.delete(host2);
    cursorFlowCache.delete(host2);
  }
  var cursorFlowCache = /* @__PURE__ */ new WeakMap();
  function cursorContainingBlock(host2) {
    const cached = cursorFlowCache.get(host2);
    if (cached && cached.isConnected && cached.contains(host2)) return cached;
    let flow = host2 && host2.parentElement;
    while (flow && getComputedStyle(flow).position === "static") flow = flow.parentElement;
    if (flow) cursorFlowCache.set(host2, flow);
    return flow;
  }
  function lastNonNullTextNode(root) {
    if (!root) return null;
    const children = root.childNodes;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (!child) continue;
      if (child.nodeType === 3) {
        if (child.nodeValue && /\S/.test(child.nodeValue)) return child;
        continue;
      }
      if (child.nodeType === 1) {
        const found = lastNonNullTextNode(child);
        if (found) return found;
      }
    }
    return null;
  }
  function positionStreamCursor(host2, cursor) {
    const flow = cursorContainingBlock(host2);
    if (!flow || !cursor) return;
    let rect = null;
    try {
      const lastText2 = lastNonNullTextNode(host2);
      if (lastText2) {
        let end = lastText2.nodeValue.length;
        while (end > 0 && /\s/.test(lastText2.nodeValue.charAt(end - 1))) end -= 1;
        if (end > 0) {
          const range = document.createRange();
          range.setStart(lastText2, end - 1);
          range.setEnd(lastText2, end);
          rect = range.getBoundingClientRect();
        }
      }
    } catch (e) {
      rect = null;
    }
    const flowRect = flow.getBoundingClientRect();
    if (rect && (rect.width || rect.height)) {
      cursor.style.left = Math.max(0, rect.right - flowRect.left) + "px";
      cursor.style.top = Math.max(0, rect.top - flowRect.top) + "px";
    } else {
      const hostRect = host2.getBoundingClientRect();
      cursor.style.left = Math.max(0, hostRect.left - flowRect.left) + "px";
      cursor.style.top = Math.max(0, hostRect.bottom - flowRect.top - 13) + "px";
    }
  }
  var STREAM_PAINT_GAP_CAP_MS = 120;
  var lastStreamPaintAt = 0;
  var lastStreamPaintMs = 0;
  var streamPaintTimer = null;
  function cancelStreamPaintRetry() {
    if (streamPaintTimer) {
      clearTimeout(streamPaintTimer);
      streamPaintTimer = null;
    }
    lastStreamPaintAt = 0;
    lastStreamPaintMs = 0;
  }
  function throttleStreamPaint(paint2) {
    const now = Date.now();
    const gapMs = Math.min(STREAM_PAINT_GAP_CAP_MS, lastStreamPaintMs);
    if (!lastStreamPaintAt || now - lastStreamPaintAt >= gapMs) return false;
    if (!streamPaintTimer) {
      streamPaintTimer = setTimeout(
        () => {
          streamPaintTimer = null;
          streamRender.schedule("answer", paint2);
        },
        Math.max(1, gapMs - (now - lastStreamPaintAt))
      );
    }
    return true;
  }
  function noteStreamPaint(startedAt) {
    const ended = Date.now();
    lastStreamPaintMs = ended - startedAt;
    lastStreamPaintAt = ended;
  }
  function showStreamingAnswer(host2, text, citations) {
    if (!host2) return;
    host2.innerHTML = renderAnswer(text, citations, false);
    let rec = streamingCursors.get(host2);
    if (!rec || !rec.cursor || !rec.cursor.isConnected) {
      const cursor = document.createElement("span");
      cursor.className = "stream-cursor";
      cursor.setAttribute("aria-hidden", "true");
      cursor.dataset.streamCursor = "stable";
      const parent = host2.parentNode;
      if (!parent) return;
      parent.insertBefore(cursor, host2.nextSibling);
      rec = { cursor };
      streamingCursors.set(host2, rec);
    }
    rec.cursor.hidden = false;
    positionStreamCursor(host2, rec.cursor);
  }
  function partHtml(p, citations) {
    if (p.type === "tool-call") {
      return toolStepHtml("\u{1F527} ", p.name, argHint(p.args), "\u53C2\u6570", clipDetail(JSON.stringify(p.args || {}, null, 2), 2e3));
    }
    if (p.type === "tool-result") {
      const html = toolStepHtml(
        p.status === "completed" ? "\u2713 \u5DE5\u5177\u5DF2\u5B8C\u6210\uFF1A" : p.status === "failed" ? "\u2717 \u5DE5\u5177\u5931\u8D25\uFF1A" : "\u2014 \u5DE5\u5177\u672A\u6267\u884C\uFF1A",
        p.name,
        "",
        p.status === "failed" ? "\u9519\u8BEF\u4FE1\u606F" : "\u8FD4\u56DE\u7ED3\u679C",
        clipDetail(p.result, 4e3)
      );
      return html + authChallengeHtml(p.authChallenge);
    }
    if (p.type === "screenshot") return screenshotHtml(p);
    if (p.type === "thinking" && p.text) {
      return thinkBlockHtml(p.text, { done: p.live !== true, truncated: p.textTruncated === true });
    }
    if ((p.type === "narration" || p.type === "text") && p.text) {
      return '<div class="agent-content">' + cachedAnswerHtml(p.text, citations) + "</div>";
    }
    if (p.type === "notice" && p.text) {
      return '<div class="agent-step" style="color:' + escAttr(p.color || "#6b7280") + '">' + escHtml(p.text) + "</div>";
    }
    return "";
  }
  function assistantMessageHtml(m, index, viewLength) {
    const parts = Array.isArray(m.parts) ? m.parts : [];
    const terminalNotices = parts.filter((p) => p && p.type === "notice" && p.terminal === true && p.text);
    const flowHtml = parts.filter((p) => !(p && p.type === "notice" && p.terminal === true)).map((p) => partHtml(p, m.citations)).join("");
    const hasInlineText = parts.some((p) => p.type === "narration" || p.type === "text" && p.text);
    const rawContent = String(m.content || "");
    const contentHtml = hasInlineText && !m.failed && !m.interrupted ? "" : m.live && !rawContent ? "" : cachedAnswerHtml(rawContent, m.citations);
    const failedStyle = m.failed ? ' style="color:#e74c3c"' : m.interrupted ? ' style="color:#b45309"' : "";
    const typingHtml = m.live && !flowHtml && !contentHtml ? '<span class="typing"><span></span><span></span><span></span></span>' : "";
    const sourceHtml = !m.live || m.showCitations ? citeSourcesHtml(m.citations) : "";
    const terminalHtml = terminalNotices.map((p) => '<div class="agent-step verify-final" style="color:' + escAttr(p.color || "#16a34a") + '">' + escHtml(p.text) + "</div>").join("");
    return '<div class="msg ai"' + failedStyle + '><div class="agent-flow">' + flowHtml + "</div>" + contentHtml + typingHtml + sourceHtml + terminalHtml + (m.content && !m.live ? msgActionsHtml(index === viewLength - 1) : "") + "</div>";
  }
  function renderConversation() {
    if (!panelBody) return;
    followedLiveReady = false;
    followedDom = null;
    const view = followedMessages.length ? conversation.concat(followedMessages) : conversation;
    if (!view.length) {
      panelBody.className = "p-body";
      panelBody.innerHTML = '<div class="msg ai">' + (lastText ? "\u8F93\u5165\u6307\u4EE4\uFF0CAI \u5C06\u57FA\u4E8E\u9009\u4E2D\u6587\u672C\u6267\u884C\u3002" : "\u8F93\u5165\u6307\u4EE4\uFF0CAI \u5C06\u76F4\u63A5\u6267\u884C\uFF08\u53EF\u57FA\u4E8E\u77E5\u8BC6\u5E93\uFF09\u3002") + "</div>";
      renderPlan([]);
      return;
    }
    panelBody.className = "p-body";
    panelBody.innerHTML = view.map((m, index) => {
      if (m.role === "user") {
        return '<div class="user-turn"><div class="msg user">' + escHtml(m.content) + selectedTextMessageHtml(m.selectedText) + pickedSummaryHtml(m.pickedElements) + "</div>" + (m.live ? "" : userActionsHtml(index)) + "</div>";
      }
      return assistantMessageHtml(m, index, view.length);
    }).join("");
    const withPlan = [...view].reverse().find((m) => m && m.role === "assistant" && Array.isArray(m.plan) && m.plan.length);
    renderPlan(withPlan ? withPlan.plan : []);
    const aiEls = panelBody.querySelectorAll(".msg.ai");
    let aiIdx = 0;
    for (const m of view) {
      if (m.role === "user") continue;
      if (aiEls[aiIdx]) aiEls[aiIdx]._raw = m.content || "";
      aiIdx++;
    }
  }
  function rebuildFollowedMessages() {
    followedMessages = [];
    if (!followedRunState) return;
    const instruction = String(followedRunState.instruction || "").trim();
    const last = conversation.length ? conversation[conversation.length - 1] : null;
    const alreadyHasUser = last && last.role === "user" && String(last.content || "").trim() === instruction;
    if (instruction && !alreadyHasUser) {
      followedMessages.push({ role: "user", content: instruction, live: true });
    }
    const assistant = runStateToAssistantMessage(followedRunState);
    if (assistant) followedMessages.push(assistant);
  }
  function followedRunCommitted() {
    if (!followedRunState) return false;
    const instruction = String(followedRunState.instruction || "").trim();
    if (!instruction) return false;
    let userIndex = -1;
    for (let i = conversation.length - 1; i >= 0; i--) {
      if (conversation[i] && conversation[i].role === "user" && String(conversation[i].content || "").trim() === instruction) {
        userIndex = i;
        break;
      }
    }
    if (userIndex < 0) return false;
    return conversation.slice(userIndex + 1).some((m) => m && m.role === "assistant" && !m.live);
  }
  function followedPartElement(part, citations) {
    if (!part) return null;
    const wrap = document.createElement("div");
    wrap.innerHTML = partHtml(part, citations);
    return wrap.firstElementChild;
  }
  function ensureFollowedDom() {
    if (followedDom && followedDom.aiEl && followedDom.aiEl.isConnected && followedDom.aiEl.parentNode === panelBody) {
      return followedDom;
    }
    const instruction = String(followedRunState.instruction || "").trim();
    const last = conversation.length ? conversation[conversation.length - 1] : null;
    const alreadyHasUser = last && last.role === "user" && String(last.content || "").trim() === instruction;
    if (!conversation.length) panelBody.innerHTML = "";
    panelBody.querySelectorAll(".follow-live-user,.follow-live-ai").forEach((el) => el.remove());
    let userEl = null;
    if (instruction && !alreadyHasUser) {
      userEl = document.createElement("div");
      userEl.className = "user-turn follow-live-user";
      userEl.innerHTML = '<div class="msg user">' + escHtml(instruction) + "</div>";
      panelBody.appendChild(userEl);
    }
    const aiEl = document.createElement("div");
    aiEl.className = "msg ai follow-live-ai";
    const flowEl2 = document.createElement("div");
    flowEl2.className = "agent-flow";
    const committedEl = document.createElement("div");
    committedEl.className = "follow-committed";
    const liveEl = document.createElement("div");
    liveEl.className = "follow-live-tail";
    flowEl2.appendChild(committedEl);
    flowEl2.appendChild(liveEl);
    aiEl.appendChild(flowEl2);
    panelBody.appendChild(aiEl);
    followedDom = {
      userEl,
      aiEl,
      flowEl: flowEl2,
      committedEl,
      liveEl,
      renderedParts: 0,
      liveThink: null,
      liveTextEl: null,
      liveText: "",
      typingEl: null
    };
    return followedDom;
  }
  function renderFollowedLive() {
    if (!panelBody || !followedRunState) return;
    if (!followedLiveReady) {
      followedMessages = [];
      renderConversation();
      followedLiveReady = true;
      followedDom = null;
    }
    const dom = ensureFollowedDom();
    const assistant = runStateToAssistantMessage(followedRunState);
    if (!assistant) return;
    const parts = Array.isArray(assistant.parts) ? assistant.parts : [];
    const committedParts = parts.filter(
      (p) => !(p && p.type === "thinking" && p.live) && !(p && p.type === "narration" && p.live)
    );
    const liveThinking = parts.find((p) => p && p.type === "thinking" && p.live);
    const liveNarration = parts.find((p) => p && p.type === "narration" && p.live);
    for (let i = dom.renderedParts; i < committedParts.length; i++) {
      const part = committedParts[i];
      let el = null;
      if (part.type === "thinking" && dom.liveThink && part.text === dom.liveThink.text) {
        el = dom.liveThink.el;
        el.dataset.state = "done";
        const label = el.querySelector(".think-label");
        if (label) label.textContent = thinkLabelText(true, String(part.text || "").length, part.textTruncated === true);
        dom.liveThink = null;
      } else if ((part.type === "narration" || part.type === "text") && dom.liveTextEl && part.text === dom.liveText) {
        el = dom.liveTextEl;
        removeStreamCursor(el);
        dom.liveTextEl = null;
        dom.liveText = "";
      } else {
        el = followedPartElement(part, assistant.citations);
      }
      if (el) dom.committedEl.appendChild(el);
    }
    dom.renderedParts = committedParts.length;
    if (liveThinking && liveThinking.text) {
      if (!dom.liveThink) {
        const wrap = document.createElement("div");
        wrap.innerHTML = thinkBlockHtml(liveThinking.text, { done: false });
        const el = wrap.firstElementChild;
        if (el) {
          dom.liveEl.appendChild(el);
          dom.liveThink = { el, text: liveThinking.text };
        }
      } else {
        dom.liveThink.text = liveThinking.text;
        const body = dom.liveThink.el.querySelector(".think-body");
        if (body) body.textContent = liveThinking.text;
        const label = dom.liveThink.el.querySelector(".think-label");
        if (label) label.textContent = thinkLabelText(false, liveThinking.text.length, false);
      }
    } else if (dom.liveThink) {
      dom.liveThink.el.remove();
      dom.liveThink = null;
    }
    if (liveNarration && liveNarration.text) {
      if (!dom.liveTextEl) {
        dom.liveTextEl = document.createElement("div");
        dom.liveTextEl.className = "agent-content";
        dom.liveEl.appendChild(dom.liveTextEl);
      }
      if (dom.liveText !== liveNarration.text) {
        showStreamingAnswer(dom.liveTextEl, liveNarration.text, assistant.citations);
        dom.liveText = liveNarration.text;
      }
    } else if (dom.liveTextEl) {
      removeStreamCursor(dom.liveTextEl);
      dom.liveTextEl.remove();
      dom.liveTextEl = null;
      dom.liveText = "";
    }
    const hasLiveContent = Boolean(dom.liveThink || dom.liveTextEl);
    if (!hasLiveContent && !dom.typingEl) {
      dom.typingEl = document.createElement("div");
      dom.typingEl.className = "agent-content";
      dom.typingEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
      dom.liveEl.appendChild(dom.typingEl);
    } else if (hasLiveContent && dom.typingEl) {
      dom.typingEl.remove();
      dom.typingEl = null;
    }
    dom.aiEl._raw = assistant.content || "";
    renderPlan(Array.isArray(assistant.plan) ? assistant.plan : []);
    if (usageEl) usageEl.textContent = followedRunState.tokens ? "tokens " + followedRunState.tokens : "";
    fitPanelHeight();
    pinToBottom();
  }
  function renderFollowedRun() {
    if (!panelBody) return;
    streamRender.schedule("follow-live", () => {
      renderFollowedLive();
    });
    if (usageEl) usageEl.textContent = followedRunState && followedRunState.tokens ? "tokens " + followedRunState.tokens : "";
    if (followedRunState && followedRunState.status === "running") {
      if (progressEl) {
        progressEl.classList.add("on");
        runStartedAt = Number(followedRunState.startedAt) || Date.now();
        progressState = stateLabel(followedRunState.progress && followedRunState.progress.state) || "\u8DDF\u968F\u8FD0\u884C";
        progressStep = Number(followedRunState.progress && followedRunState.progress.step) || 0;
        progressMax = Number(followedRunState.progress && followedRunState.progress.max) || 0;
        if (!progressTimer) progressTimer = setInterval(renderProgress, 1e3);
        renderProgress();
      }
    }
    updateRunControlState();
    ensureFollowedRunWatch();
  }
  function ensureFollowedRunWatch() {
    if (followStatusTimer) return;
    followStatusTimer = setInterval(async () => {
      if (!followedRunState) {
        clearInterval(followStatusTimer);
        followStatusTimer = null;
        return;
      }
      if (followRefreshTimer) return;
      const sessionId = panelSessionId;
      const res = await sendPanelMessage("panel:run:subscribe", { sessionId });
      if (sessionId !== panelSessionId) return;
      if (res && res.ok && res.snapshot && res.snapshot.status === "running") {
        followedRunState = res.snapshot;
        followedRunId = res.snapshot.runId;
        followedCursor = Number(res.snapshot.cursor) || 0;
        rebuildFollowedMessages();
        renderFollowedRun();
        return;
      }
      scheduleFollowedRunRefresh();
    }, 1200);
  }
  function resetFollowedRun(options) {
    const opts = options || {};
    if (followRefreshTimer) {
      clearTimeout(followRefreshTimer);
      followRefreshTimer = null;
    }
    if (followStatusTimer) {
      clearInterval(followStatusTimer);
      followStatusTimer = null;
    }
    followedRunState = null;
    followedRunId = "";
    followedCursor = 0;
    followedMessages = [];
    followedLiveReady = false;
    followedDom = null;
    if (!runSession.isRunning) {
      stopProgress();
    }
    updateRunControlState();
    if (opts.render) {
      renderConversation();
      fitPanelHeight();
    }
  }
  function applyFollowedSnapshot(snapshot) {
    if (!snapshot || !snapshot.runId) {
      resetFollowedRun({ render: true });
      return;
    }
    if (snapshot.status !== "running") {
      scheduleFollowedRunRefresh();
      return;
    }
    followedRunState = snapshot;
    followedRunId = snapshot.runId;
    followedCursor = Number(snapshot.cursor) || 0;
    rebuildFollowedMessages();
    renderFollowedRun();
  }
  async function subscribePanelRun() {
    if (!panelSessionId) return;
    const sessionId = panelSessionId;
    const res = await sendPanelMessage("panel:run:subscribe", { sessionId });
    if (sessionId !== panelSessionId) return;
    if (!res || !res.ok || res.selfOwned) {
      resetFollowedRun({ render: Boolean(followedRunState) });
      return;
    }
    if (res.snapshot && res.snapshot.status === "running") applyFollowedSnapshot(res.snapshot);
    else if (res.snapshot) resetFollowedRun({ render: Boolean(followedRunState) });
    else if (followedRunState) resetFollowedRun({ render: true });
  }
  function scheduleFollowedRunRefresh() {
    if (followRefreshTimer) clearTimeout(followRefreshTimer);
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      const sessionId = panelSessionId;
      const got = await sendPanelMessage("panel:get", { id: sessionId });
      if (sessionId !== panelSessionId) return;
      const instruction = String(followedRunState && followedRunState.instruction ? followedRunState.instruction : "").trim();
      const messages = got && got.ok && got.session ? got.session.messages || [] : [];
      let userIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === "user" && String(messages[i].content || "").trim() === instruction) {
          userIndex = i;
          break;
        }
      }
      const hasCommittedTurn = userIndex >= 0 && messages.slice(userIndex + 1).some((m) => m && m.role === "assistant");
      if (got && got.ok && got.session && (Number(got.session.seq) > panelSessionSeq || hasCommittedTurn)) {
        resetFollowedRun();
        adoptPanelSession(got.session, { activeId: got.activeId || sessionId });
        subscribePanelRun().catch(() => {
        });
        return;
      }
      if (attempts < 6) {
        followRefreshTimer = setTimeout(tick, 300);
      } else {
        resetFollowedRun({ render: true });
      }
    };
    followRefreshTimer = setTimeout(tick, 250);
  }
  function handleRunStarted(msg) {
    if (!msg || String(msg.sessionId || "") !== panelSessionId) return;
    subscribePanelRun().catch(() => {
    });
  }
  function handleRunDelta(msg) {
    if (!msg || String(msg.sessionId || "") !== panelSessionId) return;
    if (!followedRunState || String(msg.runId || "") !== followedRunId) {
      subscribePanelRun().catch(() => {
      });
      return;
    }
    const cursor = Number(msg.cursor) || 0;
    if (cursor !== followedCursor + 1) {
      subscribePanelRun().catch(() => {
      });
      return;
    }
    followedCursor = cursor;
    applyRunEvent(followedRunState, msg.event);
    renderFollowedRun();
    if (msg.event && (msg.event.type === "end" || msg.event.type === "error")) {
      scheduleFollowedRunRefresh();
    }
  }
  function renderPlan(plan) {
    lastPlan = Array.isArray(plan) ? plan : [];
    if (!planBar) return;
    if (!lastPlan.length) {
      planBar.style.display = "none";
      planBar.innerHTML = "";
      planExpanded = null;
      return;
    }
    const total = lastPlan.length;
    const doneCount = lastPlan.filter((p) => p && p.status === "done").length;
    const allDone = total > 0 && doneCount === total;
    const current = lastPlan.find((p) => p && p.status === "in_progress") || lastPlan.find((p) => p && p.status !== "done");
    if (allDone !== planWasAllDone) planExpanded = null;
    planWasAllDone = allDone;
    const collapsed = planExpanded !== true;
    const items = lastPlan.map((p) => {
      const st = p.status === "done" ? "done" : p.status === "in_progress" ? "in_progress" : "pending";
      const mark = st === "done" ? "\u2713" : st === "in_progress" ? "\u25B6" : "\u25CB";
      return '<div class="agent-plan-item ' + st + '">' + mark + " " + escHtml(p.text || "") + "</div>";
    }).join("");
    const title = collapsed ? "\u6267\u884C\u8BA1\u5212 \xB7 " + doneCount + "/" + total + (allDone ? " \u6B65\u5DF2\u5B8C\u6210" : current ? " \xB7 \u25B6 " + String(current.text || "").slice(0, 40) : "") + "\uFF08\u70B9\u51FB\u5C55\u5F00\uFF09" : "\u6267\u884C\u8BA1\u5212 \xB7 " + doneCount + "/" + total + "\uFF08\u70B9\u51FB\u6536\u8D77\uFF09";
    planBar.classList.toggle("collapsed", collapsed);
    planBar.innerHTML = '<div class="agent-plan-title" role="button" tabindex="0" title="\u70B9\u51FB\u5C55\u5F00/\u6298\u53E0">' + escHtml(title) + '</div><div class="agent-plan-items">' + items + "</div>";
    planBar.style.display = "";
    fitPanelHeight();
    pinToBottom();
  }
  function summarizeToolParts(parts) {
    const done = (Array.isArray(parts) ? parts : []).filter((p) => p && p.type === "tool-result");
    if (!done.length) return "";
    return done.slice(-6).map((p) => p.name + (p.status === "failed" ? "\uFF08\u5931\u8D25\uFF09" : "") + "\uFF1A" + String(p.result || "").replace(/\s+/g, " ").trim().slice(0, 120)).join("\uFF1B");
  }
  function messagesForExport() {
    const list = Array.isArray(conversation) ? conversation.slice() : [];
    const partial = buildPartialTurn(streamState.parts, streamState.responseText);
    if (partial) list.push(partial);
    return list;
  }
  function buildTranscriptMarkdown(mode) {
    return buildTranscript({
      title: document.title || "(\u65E0\u6807\u9898)",
      url: location.href,
      exportedAt: (/* @__PURE__ */ new Date()).toLocaleString(),
      handoffId: handoffId || "",
      conversation: messagesForExport(),
      // ⚠ `maxResultLen` 是本模块**唯一**的裁剪点（用户与助手正文原样输出），
      // 所以给足上限就等于无损 —— 不要以为这里还有别的暗坑。
      ...mode === "full" ? { maxResultLen: 1e9 } : {}
    });
  }
  function serializeConversation() {
    return serializeCompleteConversationMessages(conversation);
  }
  function sendPanelMessage(type, payload) {
    if (!isExtContextAlive()) {
      return Promise.resolve({ ok: false, error: "\u6269\u5C55\u5DF2\u66F4\u65B0\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5" });
    }
    return runtimePort.request(Object.assign({ type }, payload || {}));
  }
  function sessionTimeText(ts) {
    const n = Number(ts) || 0;
    if (!n) return "";
    const d = new Date(n);
    const pad = (v) => String(v).padStart(2, "0");
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function applyPanelSessionSummaries(state) {
    if (!state) return;
    if (Array.isArray(state.sessions)) panelSessionList = state.sessions.slice();
    if (typeof state.activeId === "string") panelSessionActiveId = state.activeId;
    renderSessionButton();
    renderSessionMenu();
  }
  function mergePanelSessionSummary(session) {
    if (!session || !session.id) return;
    const summary = {
      id: session.id,
      title: session.title || "\u65B0\u4F1A\u8BDD",
      createdAt: Number(session.createdAt) || 0,
      updatedAt: Number(session.updatedAt) || 0,
      messageCount: Array.isArray(session.messages) ? session.messages.length : Number(session.messageCount) || 0,
      seq: Number(session.seq) || 0,
      origin: String(session.origin || ""),
      handoffId: String(session.handoffId || ""),
      lastRunId: String(session.lastRunId || ""),
      titleAuto: session.titleAuto !== false
    };
    const old = panelSessionList.find((s) => s.id === session.id);
    if (old) Object.assign(old, summary);
    else panelSessionList.push(summary);
    panelSessionList.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    renderSessionButton();
    renderSessionMenu();
  }
  function renderSessionButton() {
    if (!panelSessionBtnEl) return;
    const current = panelSessionList.find((s) => s.id === panelSessionId);
    const count = panelSessionList.length;
    panelSessionBtnEl.textContent = "\u{1F5C2} \u4F1A\u8BDD" + (count ? " " + count : "");
    if (panelTitleEl) {
      const titleText = current && current.title ? current.title : "RecallFlow";
      panelTitleEl.textContent = titleText;
      panelTitleEl.title = titleText;
    }
    const label = current ? "\u5F53\u524D\u4F1A\u8BDD\uFF1A" + current.title + "\uFF08" + count + " \u4E2A\u4F1A\u8BDD\uFF0C\u70B9\u51FB\u5207\u6362 / \u65B0\u5EFA\uFF09" : "\u4F1A\u8BDD\u5217\u8868\uFF08" + count + " \u4E2A\uFF0C\u70B9\u51FB\u5207\u6362 / \u65B0\u5EFA\uFF09";
    panelSessionBtnEl.title = label;
    panelSessionBtnEl.setAttribute("aria-label", label);
  }
  function closeSessionMenu() {
    panelSessionMenuOpen = false;
    if (panelSessionMenuEl) panelSessionMenuEl.hidden = true;
    if (panelSessionBtnEl) panelSessionBtnEl.setAttribute("aria-expanded", "false");
  }
  function renderSessionMenu() {
    if (!panelSessionMenuEl) return;
    panelSessionMenuEl.innerHTML = "";
    const head = document.createElement("div");
    head.className = "session-menu-head";
    const label = document.createElement("span");
    label.textContent = "\u6700\u8FD1\u4F1A\u8BDD";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "session-menu-close";
    close.textContent = "\u2715";
    close.title = "\u5173\u95ED";
    close.addEventListener("click", closeSessionMenu);
    head.appendChild(label);
    head.appendChild(close);
    panelSessionMenuEl.appendChild(head);
    const list = document.createElement("div");
    list.className = "session-list";
    if (!panelSessionList.length) {
      const empty = document.createElement("div");
      empty.className = "session-empty";
      empty.textContent = "\u8FD8\u6CA1\u6709\u4F1A\u8BDD";
      list.appendChild(empty);
    }
    for (const session of panelSessionList) {
      const item = document.createElement("div");
      item.className = "session-item";
      item.setAttribute("data-session-id", session.id);
      if (session.id === panelSessionId) item.classList.add("active");
      if (session.id === panelSessionActiveId) item.classList.add("shared-active");
      if (session.locked) item.classList.add("running");
      const main = document.createElement("button");
      main.type = "button";
      main.className = "session-main";
      main.setAttribute("data-session-action", "switch");
      main.setAttribute("data-session-id", session.id);
      main.title = session.title + "\n" + (session.origin || "") + "\n" + session.messageCount + " \u6761\u6D88\u606F \xB7 \u7EA6 " + (Number(session.tokenEstimate) || 0).toLocaleString() + " tokens";
      const title = document.createElement("span");
      title.className = "session-title";
      title.textContent = (session.locked ? "\u25CF " : "") + (session.title || "\u65B0\u4F1A\u8BDD");
      const meta = document.createElement("span");
      meta.className = "session-meta";
      meta.textContent = sessionTimeText(session.updatedAt) + " \xB7 " + (Number(session.messageCount) || 0) + " \u6761" + (session.id === panelSessionActiveId ? " \xB7 \u6D4F\u89C8\u5668\u5F53\u524D" : "") + (session.storageWarning ? " \xB7 \u8D85 1M tokens" : "");
      main.appendChild(title);
      main.appendChild(meta);
      item.appendChild(main);
      const actions = document.createElement("div");
      actions.className = "session-actions";
      const rename = document.createElement("button");
      rename.type = "button";
      rename.title = "\u91CD\u547D\u540D";
      rename.setAttribute("aria-label", "\u91CD\u547D\u540D\u4F1A\u8BDD");
      rename.textContent = "\u270E";
      rename.setAttribute("data-session-action", "rename");
      rename.setAttribute("data-session-id", session.id);
      const exportBtn = document.createElement("button");
      exportBtn.type = "button";
      exportBtn.title = "\u5BFC\u51FA\u8BE5\u4F1A\u8BDD\u4E3A Markdown";
      exportBtn.setAttribute("aria-label", "\u5BFC\u51FA\u4F1A\u8BDD");
      exportBtn.textContent = "\u2913";
      exportBtn.setAttribute("data-session-action", "export");
      exportBtn.setAttribute("data-session-id", session.id);
      const del = document.createElement("button");
      del.type = "button";
      del.title = "\u5220\u9664";
      del.setAttribute("aria-label", "\u5220\u9664\u4F1A\u8BDD");
      del.textContent = "\u{1F5D1}";
      del.setAttribute("data-session-action", "delete");
      del.setAttribute("data-session-id", session.id);
      actions.appendChild(rename);
      actions.appendChild(exportBtn);
      actions.appendChild(del);
      item.appendChild(actions);
      list.appendChild(item);
    }
    panelSessionMenuEl.appendChild(list);
    const foot = document.createElement("button");
    foot.type = "button";
    foot.className = "session-new";
    foot.textContent = "\uFF0B \u65B0\u5EFA\u4F1A\u8BDD";
    foot.addEventListener("click", () => {
      newPanelSession().catch(() => {
      });
    });
    panelSessionMenuEl.appendChild(foot);
  }
  async function refreshPanelSessionState() {
    const state = await sendPanelMessage("panel:state");
    if (state && state.ok) applyPanelSessionSummaries(state);
    return state;
  }
  function adoptPanelSession(session, options) {
    if (!session || !session.id) return false;
    const opts = options || {};
    if (panelSessionId !== session.id) resetUsageChip();
    panelSessionId = session.id;
    panelSessionSeq = Number(session.seq) || 0;
    if (opts.activeId) panelSessionActiveId = String(opts.activeId);
    conversation = normalizeConversationDuplicates(Array.isArray(session.messages) ? session.messages : []);
    handoffId = normalizeHandoffId(session.handoffId || "") || loadHandoffId() || newHandoffId();
    try {
      localStorage.setItem(HANDOFF_ID_KEY, handoffId);
    } catch (e) {
    }
    mergePanelSessionSummary(Object.assign({}, session, { messageCount: conversation.length, handoffId }));
    if (followedRunState) {
      if (followedRunCommitted()) resetFollowedRun();
      else rebuildFollowedMessages();
    }
    if (panelBody && !runSession.isRunning) {
      renderConversation();
      renderHandoffChip();
      fitPanelHeight();
      pinToBottom();
    }
    renderSessionButton();
    if (panel && !runSession.isRunning) subscribePanelRun().catch(() => {
    });
    return true;
  }
  function saveConversation(options) {
    const opts = options || {};
    const id = panelSessionId;
    if (!id) return Promise.resolve({ ok: false, skipped: true });
    const messages = serializeConversation();
    const baseSeq = panelSessionSeq;
    const runId = runSession.runId;
    const savedHandoffId = handoffId;
    panelSessionSaveChain = panelSessionSaveChain.catch(() => {
    }).then(async () => {
      const res = await sendPanelMessage("panel:save", {
        id,
        messages,
        baseSeq,
        allowShrink: opts.allowShrink === true,
        handoffId: savedHandoffId,
        lastRunId: runId,
        origin: location.href
      });
      if (res && res.ok && res.session) {
        if (id === panelSessionId) panelSessionSeq = Number(res.session.seq) || panelSessionSeq;
        mergePanelSessionSummary(res.session);
        if (Array.isArray(res.sessions)) panelSessionList = res.sessions.slice();
        renderSessionButton();
        renderSessionMenu();
      } else if (res && (res.conflict || res.stale) && res.session) {
        if (id === panelSessionId && !runSession.isRunning) {
          adoptPanelSession(res.session, { activeId: res.activeId });
          showCitationHint(
            res.stale ? "\u68C0\u6D4B\u5230\u65E7\u6807\u7B7E\u9875\u7684\u56DE\u5199\uFF0C\u5DF2\u4FDD\u7559\u66F4\u5B8C\u6574\u7684\u4F1A\u8BDD\u5185\u5BB9\u3002" : "\u8BE5\u4F1A\u8BDD\u5DF2\u5728\u5176\u4ED6\u6807\u7B7E\u9875\u66F4\u65B0\uFF0C\u5DF2\u4E3A\u4F60\u5237\u65B0\u5230\u6700\u65B0\u5185\u5BB9\u3002"
          );
        }
      }
      return res;
    });
    return panelSessionSaveChain;
  }
  async function loadConversation() {
    try {
      const state = await sendPanelMessage("panel:state");
      if (state && state.ok) applyPanelSessionSummaries(state);
      const target = state && state.activeId || panelSessionList[0] && panelSessionList[0].id || "";
      if (target) {
        const got = await sendPanelMessage("panel:get", { id: target });
        if (got && got.ok && got.session) {
          adoptPanelSession(got.session, { activeId: got.activeId || target });
          return;
        }
      }
      const created = await sendPanelMessage("panel:create", { handoffId: newHandoffId() });
      if (created && created.ok && created.session) {
        adoptPanelSession(created.session, { activeId: created.activeId });
      }
    } catch (e) {
    } finally {
      conversationLoaded = true;
    }
  }
  function showPanelDialog(config) {
    if (!panel) return;
    const options = config || {};
    const old = panel.querySelector(".session-dialog-backdrop");
    if (old) old.remove();
    const previousFocus = document.activeElement;
    const backdrop = document.createElement("div");
    backdrop.className = "session-dialog-backdrop";
    const box = document.createElement("div");
    box.className = "session-dialog";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const dialogId = "rf-panel-dialog-" + Date.now().toString(36);
    box.id = dialogId;
    box.setAttribute("aria-labelledby", dialogId + "-title");
    const title = document.createElement("div");
    title.className = "session-dialog-title";
    title.id = dialogId + "-title";
    title.textContent = options.title || "\u4F1A\u8BDD";
    const message = document.createElement("div");
    message.className = "session-dialog-message";
    message.textContent = options.message || "";
    box.appendChild(title);
    box.appendChild(message);
    let input = null;
    if (options.input) {
      input = document.createElement("input");
      input.className = "session-dialog-input";
      input.type = "text";
      input.maxLength = 60;
      input.value = String(options.value || "");
      input.placeholder = options.placeholder || "";
      box.appendChild(input);
    }
    const actions = document.createElement("div");
    actions.className = "session-dialog-actions";
    const extra = options.extraText ? (() => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "session-dialog-extra";
      b.textContent = options.extraText;
      b.addEventListener("click", () => {
        close();
        try {
          if (options.onExtra) options.onExtra();
        } catch (e) {
        }
      });
      return b;
    })() : null;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = options.cancelText || "\u53D6\u6D88";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = options.danger ? "danger" : "primary";
    ok.textContent = options.confirmText || "\u786E\u5B9A";
    const close = () => {
      document.removeEventListener("keydown", onDialogKey, true);
      try {
        backdrop.remove();
      } catch (e) {
      }
      if (previousFocus && previousFocus.isConnected) {
        try {
          previousFocus.focus();
        } catch (e) {
        }
      }
    };
    const onDialogKey = (e) => {
      if (!backdrop.isConnected) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = [...box.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((el) => el.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!box.contains(document.activeElement)) {
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
    cancel.addEventListener("click", close);
    const submit = async () => {
      const value = input ? input.value.trim() : "";
      if (input && !value) {
        input.focus();
        return;
      }
      ok.disabled = true;
      cancel.disabled = true;
      try {
        const keep = await options.onConfirm?.(value);
        if (keep !== false) close();
      } catch (e) {
        message.textContent = e && e.message ? e.message : String(e);
      } finally {
        ok.disabled = false;
        cancel.disabled = false;
      }
    };
    ok.addEventListener("click", () => void submit());
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      });
    }
    if (extra) actions.appendChild(extra);
    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(actions);
    backdrop.appendChild(box);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close();
    });
    panel.appendChild(backdrop);
    document.addEventListener("keydown", onDialogKey, true);
    setTimeout(() => {
      if (input) {
        input.focus();
        input.select();
      } else {
        ok.focus();
      }
    }, 0);
    return { close };
  }
  async function switchPanelSession(id, options) {
    const opts = options || {};
    const wanted = String(id || "");
    if (!wanted) return false;
    if (runSession.isRunning) {
      showCitationHint("\u5F53\u524D\u4EFB\u52A1\u8FD8\u5728\u8FD0\u884C\uFF0C\u7ED3\u675F\u540E\u624D\u80FD\u5207\u6362\u4F1A\u8BDD\u3002");
      return false;
    }
    if (wanted === panelSessionId && !opts.force) {
      closeSessionMenu();
      return true;
    }
    if (panelSessionSwitchInFlight) return false;
    panelSessionSwitchInFlight = true;
    try {
      let res;
      if (opts.activate === false) {
        res = await sendPanelMessage("panel:get", { id: wanted });
      } else {
        res = await sendPanelMessage("panel:activate", { id: wanted });
      }
      if (!res || !res.ok || !res.session) {
        showCitationHint(res && res.error || "\u5207\u6362\u4F1A\u8BDD\u5931\u8D25");
        return false;
      }
      adoptPanelSession(res.session, { activeId: res.activeId || wanted });
      if (Array.isArray(res.sessions)) panelSessionList = res.sessions.slice();
      renderSessionButton();
      renderSessionMenu();
      closeSessionMenu();
      return true;
    } finally {
      panelSessionSwitchInFlight = false;
      if (deferredRemoteSessionId && !runSession.isRunning && deferredRemoteSessionId !== panelSessionId) {
        const next = deferredRemoteSessionId;
        deferredRemoteSessionId = "";
        setTimeout(() => {
          switchPanelSession(next, { activate: false, force: true }).catch(() => {
          });
        }, 0);
      }
    }
  }
  async function newPanelSession() {
    if (runSession.isRunning) {
      showCitationHint("\u5F53\u524D\u4EFB\u52A1\u8FD8\u5728\u8FD0\u884C\uFF0C\u7ED3\u675F\u540E\u624D\u80FD\u65B0\u5EFA\u4F1A\u8BDD\u3002");
      return false;
    }
    closeSessionMenu();
    const res = await sendPanelMessage("panel:create", {
      handoffId: newHandoffId(),
      origin: location.href
    });
    if (!res || !res.ok || !res.session) {
      showCitationHint(res && res.error || "\u65B0\u5EFA\u4F1A\u8BDD\u5931\u8D25");
      return false;
    }
    adoptPanelSession(res.session, { activeId: res.activeId });
    if (Array.isArray(res.sessions)) panelSessionList = res.sessions.slice();
    renderSessionButton();
    renderSessionMenu();
    closeSessionMenu();
    if (panelBody) {
      renderConversation();
      fitPanelHeight();
      pinToBottom();
    }
    return true;
  }
  function renamePanelSession(id) {
    const session = panelSessionList.find((s) => s.id === id);
    if (!session) return;
    showPanelDialog({
      title: "\u91CD\u547D\u540D\u4F1A\u8BDD",
      message: "\u540D\u79F0\u53EA\u5F71\u54CD\u4F1A\u8BDD\u5217\u8868\uFF0C\u4E0D\u4F1A\u6539\u52A8\u5BF9\u8BDD\u5185\u5BB9\u3002",
      input: true,
      value: session.title,
      placeholder: "\u4F8B\u5982\uFF1AGitHub \u641C\u7D22\u8C03\u7814",
      confirmText: "\u4FDD\u5B58",
      onConfirm: async (title) => {
        const res = await sendPanelMessage("panel:rename", { id, title });
        if (!res || !res.ok) {
          showCitationHint(res && res.error || "\u91CD\u547D\u540D\u5931\u8D25");
          return false;
        }
        if (Array.isArray(res.sessions)) panelSessionList = res.sessions.slice();
        if (id === panelSessionId && res.session) {
          panelSessionSeq = Number(res.session.seq) || panelSessionSeq;
        }
        renderSessionButton();
        renderSessionMenu();
        return true;
      }
    });
  }
  function deletePanelSession(id) {
    const session = panelSessionList.find((s) => s.id === id);
    if (!session) return;
    showPanelDialog({
      title: "\u5220\u9664\u4F1A\u8BDD",
      message: "\u5C06\u6C38\u4E45\u5220\u9664\u300C" + session.title + "\u300D\u53CA\u5176\u4E2D\u7684 " + session.messageCount + " \u6761\u6D88\u606F\u3002",
      confirmText: "\u5220\u9664",
      danger: true,
      onConfirm: async () => {
        const res = await sendPanelMessage("panel:delete", { id });
        if (!res || !res.ok) {
          showCitationHint(res && res.error || "\u5220\u9664\u5931\u8D25");
          return false;
        }
        if (Array.isArray(res.sessions)) panelSessionList = res.sessions.slice();
        if (id === panelSessionId) {
          const nextId = res.activeId || res.sessions && res.sessions[0] && res.sessions[0].id;
          if (nextId) await switchPanelSession(nextId, { force: true });
        } else {
          panelSessionActiveId = res.activeId || panelSessionActiveId;
          renderSessionButton();
          renderSessionMenu();
        }
        return true;
      }
    });
  }
  async function exportPanelSession(id, btn) {
    const session = panelSessionList.find((s) => s.id === id);
    if (!session) return;
    const res = await sendPanelMessage("panel:get", { id });
    if (!res || !res.ok || !res.session) {
      showCitationHint(res && res.error || "\u8BFB\u53D6\u4F1A\u8BDD\u5931\u8D25");
      return;
    }
    let text = "";
    try {
      text = buildTranscript({
        title: res.session.title || document.title || "(\u65E0\u6807\u9898)",
        url: res.session.origin || location.href,
        exportedAt: (/* @__PURE__ */ new Date()).toLocaleString(),
        handoffId: res.session.handoffId || "",
        conversation: res.session.messages || []
      });
    } catch (e) {
    }
    if (!text) {
      showCitationHint("\u8BE5\u4F1A\u8BDD\u6682\u65E0\u53EF\u5BFC\u51FA\u7684\u5185\u5BB9\u3002");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const old = btn.textContent;
        btn.textContent = "\u2713";
        setTimeout(() => btn.textContent = old, 1200);
      } else {
        showCitationHint("\u5DF2\u590D\u5236\u4F1A\u8BDD\u8BB0\u5F55\uFF08" + text.length + " \u5B57\uFF09\u3002");
      }
    } catch (e) {
      showCitationHint("\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u526A\u8D34\u677F\u6743\u9650\u3002");
    }
  }
  async function acquirePanelSessionLock(runId, takeover) {
    if (!panelSessionId) return { ok: false, error: "\u4F1A\u8BDD\u5C1A\u672A\u5C31\u7EEA" };
    const res = await sendPanelMessage("panel:lock", {
      id: panelSessionId,
      runId,
      takeover: takeover === true
    });
    if (res && res.ok) {
      panelSessionLockHeld = true;
      panelSessionLockRunId = runId;
      if (Array.isArray(res.sessions)) {
        panelSessionList = res.sessions.slice();
        renderSessionMenu();
      }
    }
    return res || { ok: false, error: "\u8FD0\u884C\u9501\u83B7\u53D6\u5931\u8D25" };
  }
  function releasePanelSessionLock() {
    if (!panelSessionLockHeld || !panelSessionLockRunId) return Promise.resolve();
    const id = panelSessionId;
    const runId = panelSessionLockRunId;
    panelSessionLockHeld = false;
    panelSessionLockRunId = "";
    return sendPanelMessage("panel:unlock", { id, runId });
  }
  function renewPanelSessionLock() {
    if (!panelSessionLockHeld || !panelSessionLockRunId) return;
    sendPanelMessage("panel:lock", {
      id: panelSessionId,
      runId: panelSessionLockRunId,
      takeover: false
    }).then((res) => {
      if (res && res.locked && !res.ok) {
        panelSessionLockHeld = false;
        showCitationHint("\u8BE5\u4F1A\u8BDD\u5DF2\u5728\u53E6\u4E00\u4E2A\u6807\u7B7E\u9875\u63A5\u7BA1\uFF0C\u672C\u9875\u4EFB\u52A1\u5C06\u505C\u6B62\u3002");
        runSession.requestStop();
      }
    }).catch(() => {
    });
  }
  async function handleRemotePanelSessions(state) {
    if (!state) return;
    applyPanelSessionSummaries(state);
    const nextActive = String(state.activeId || "");
    if (!nextActive) return;
    if (runSession.isRunning || panelSessionSwitchInFlight) {
      if (nextActive !== panelSessionId) deferredRemoteSessionId = nextActive;
      return;
    }
    if (nextActive !== panelSessionId) {
      await switchPanelSession(nextActive, { activate: false, force: true });
      return;
    }
    const current = panelSessionList.find((s) => s.id === panelSessionId);
    if (current && Number(current.seq) > panelSessionSeq) {
      await switchPanelSession(panelSessionId, { activate: false, force: true });
    }
  }
  function whenConversationReady() {
    if (conversationLoaded) return Promise.resolve();
    if (conversationLoadPromise) return conversationLoadPromise.catch(() => {
    });
    return Promise.resolve();
  }
  var HANDOFF_ID_KEY = "recallflow-handoff-id";
  function loadHandoffId() {
    try {
      return normalizeHandoffId(localStorage.getItem(HANDOFF_ID_KEY) || "");
    } catch (e) {
      return "";
    }
  }
  function ensureHandoffId() {
    if (!handoffId) handoffId = loadHandoffId() || newHandoffId();
    return handoffId;
  }
  function renderHandoffChip() {
    if (!handoffEl) return;
    const id = ensureHandoffId();
    handoffEl.textContent = "\u29C9 " + id;
    handoffEl.title = "\u590D\u5236\u4EA4\u63A5\u6307\u4EE4\u7ED9 AI\uFF08\u4F1A\u8BDD\u6807\u8BC6 " + id + "\uFF09\uFF1AAI \u53EF\u636E\u6B64\u7ECF MCP \u8BFB\u53D6\u672C\u6B21\u4F1A\u8BDD\u4E0A\u4E0B\u6587";
  }
  async function snapshotHandoff() {
    if (!isExtContextAlive()) return false;
    const id = ensureHandoffId();
    await whenConversationReady();
    let consoleEntries = [];
    try {
      const dc = window.__rfDebugCapture;
      if (dc && typeof dc.getDebugBuffer === "function") {
        consoleEntries = await dc.getDebugBuffer("console");
      }
    } catch (e) {
    }
    let picked = Array.isArray(pickedElements) ? pickedElements : [];
    if (!picked.length) {
      try {
        const d = await new Promise((resolve) => {
          chrome.storage.local.get(["recallflow.lastPickedList"], (r) => resolve(r || {}));
        });
        picked = d && d["recallflow.lastPickedList"] || [];
      } catch (e) {
        picked = [];
      }
    }
    let record;
    let trailItems = [];
    try {
      record = buildHandoffRecord({
        id,
        pageUrl: location.href,
        pageTitle: document.title,
        // ⚠ 这一句**必须**保持对 `messagesForExport()` 的直接调用：门禁
        //   `export-completeness-wiring`（「两条路径都走 messagesForExport」）就盯它
        messages: messagesForExport(),
        pickedElements: picked,
        selection: lastText,
        consoleEntries
      });
      trailItems = prepareHandoffTrail(buildToolTrail(messagesForExport())).items;
    } catch (e) {
      return false;
    }
    return await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "handoff:save", record, trailItems }, (resp) => {
          resolve(!chrome.runtime.lastError && !(resp && resp.ok === false));
        });
      } catch (e) {
        resolve(false);
      }
    });
  }
  function openPanel(x, y, docked, restore) {
    if (!isExtContextAlive()) {
      warnExtDead();
      return;
    }
    removeBubble();
    removePanel({ publish: false });
    if (fab) fab.classList.add("hidden");
    fabPeek.setPanelOpen(true);
    const layout = readPanelLayout(localStorage);
    const dockedIntent = restore ? null : docked === true;
    panel = document.createElement("div");
    panel.className = "panel" + (preferredTheme() === "dark" ? " dark" : "");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-label", "RecallFlow \u6D4F\u89C8\u5668\u52A9\u624B");
    const savedSize = clampPanelSize(layout, { width: window.innerWidth, height: window.innerHeight });
    if (savedSize) {
      panel.style.width = savedSize.width + "px";
      panel.style.height = savedSize.height + "px";
      panel._manualSize = true;
    }
    const head = document.createElement("div");
    head.className = "p-head";
    const logo = document.createElement("img");
    logo.className = "logo";
    logo.src = extUrl("docs/assets/recallflow-mark.svg");
    logo.alt = "RecallFlow";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "RecallFlow";
    panelTitleEl = title;
    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "\u2715";
    close.setAttribute("aria-label", "\u5173\u95ED RecallFlow");
    close.addEventListener("click", () => removePanel());
    const usageChip = document.createElement("span");
    usageChip.className = "usage";
    usageEl = usageChip;
    panelSessionBtnEl = document.createElement("button");
    panelSessionBtnEl.type = "button";
    panelSessionBtnEl.className = "session-btn";
    panelSessionBtnEl.setAttribute("aria-haspopup", "true");
    panelSessionBtnEl.setAttribute("aria-expanded", "false");
    panelSessionBtnEl.setAttribute("aria-controls", "rf-session-menu");
    renderSessionButton();
    panelSessionMenuEl = document.createElement("div");
    panelSessionMenuEl.id = "rf-session-menu";
    panelSessionMenuEl.className = "session-menu";
    panelSessionMenuEl.hidden = true;
    panelSessionMenuEl.setAttribute("role", "menu");
    panelSessionBtnEl.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      panelSessionMenuOpen = !panelSessionMenuOpen;
      panelSessionMenuEl.hidden = !panelSessionMenuOpen;
      panelSessionBtnEl.setAttribute("aria-expanded", panelSessionMenuOpen ? "true" : "false");
      if (panelSessionMenuOpen) {
        renderSessionMenu();
        await refreshPanelSessionState();
        fitPanelHeight();
      }
    });
    panelSessionMenuEl.addEventListener("click", (e) => {
      const target = e.target.closest("[data-session-action]");
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      const id = target.getAttribute("data-session-id") || "";
      const action = target.getAttribute("data-session-action");
      if (action === "switch") switchPanelSession(id).catch(() => {
      });
      else if (action === "rename") renamePanelSession(id);
      else if (action === "delete") deletePanelSession(id);
      else if (action === "export") exportPanelSession(id, target).catch(() => {
      });
    });
    panel.appendChild(panelSessionMenuEl);
    const handoffBtn = document.createElement("button");
    handoffBtn.className = "handoff";
    handoffEl = handoffBtn;
    renderHandoffChip();
    handoffBtn.addEventListener("click", () => {
      const id = ensureHandoffId();
      const prompt = formatHandoffPrompt(id, { pageTitle: document.title });
      const copied = navigator.clipboard.writeText(prompt).then(
        () => true,
        () => false
      );
      const saved = snapshotHandoff();
      Promise.all([copied, saved]).then(([okCopy, okSave]) => {
        handoffBtn.textContent = okCopy ? okSave ? "\u2713 \u5DF2\u590D\u5236\u5E76\u4FDD\u5B58" : "\u26A0 \u5DF2\u590D\u5236\xB7\u672A\u4FDD\u5B58" : "\u26A0 \u590D\u5236\u5931\u8D25";
        handoffBtn.classList.toggle("copied", Boolean(okCopy && okSave));
        setTimeout(() => {
          handoffBtn.textContent = "\u29C9 " + id;
          handoffBtn.classList.remove("copied");
        }, 1800);
      });
    });
    themeBtn = document.createElement("button");
    themeBtn.className = "theme";
    themeBtn.addEventListener("click", cycleTheme);
    applyTheme();
    head.appendChild(logo);
    head.appendChild(title);
    head.appendChild(usageChip);
    head.appendChild(panelSessionBtnEl);
    head.appendChild(handoffBtn);
    head.appendChild(themeBtn);
    head.appendChild(close);
    panel.appendChild(head);
    shadow.addEventListener("mousedown", (e) => {
      if (panelSessionMenuOpen && !e.target.closest(".session-menu") && !e.target.closest(".session-btn")) {
        closeSessionMenu();
      }
    });
    progressEl = document.createElement("div");
    progressEl.className = "p-progress";
    const ppDot = document.createElement("span");
    ppDot.className = "pp-dot";
    progressMsgEl = document.createElement("span");
    progressMsgEl.className = "pp-msg";
    progressTimeEl = document.createElement("span");
    progressTimeEl.className = "pp-time";
    progressEl.appendChild(ppDot);
    progressEl.appendChild(progressMsgEl);
    progressEl.appendChild(progressTimeEl);
    panel.appendChild(progressEl);
    panelBody = document.createElement("div");
    resetPanelFitCache();
    panelBody.className = "p-body";
    panelBody.setAttribute("role", "log");
    panelBody.setAttribute("aria-live", "polite");
    panelBody.setAttribute("aria-atomic", "false");
    panelBody.setAttribute("aria-label", "\u5BF9\u8BDD\u5185\u5BB9");
    panelBody.setAttribute("tabindex", "0");
    observerAutoScroll = true;
    const pbEl = panelBody;
    pbEl.addEventListener("scroll", () => {
      if (!pbEl) return;
      const now = Date.now();
      const userDriven = now < userScrollIntentUntil;
      if (!userDriven && now < selfScrollMuteUntil) return;
      if (userDriven) userScrollIntentUntil = now + USER_SCROLL_INTENT_MS;
      observerAutoScroll = pbEl.scrollHeight - pbEl.scrollTop - pbEl.clientHeight < 40;
    });
    pbEl.addEventListener("wheel", (e) => {
      markUserScrollIntent(Number(e.deltaY) < 0);
    }, { passive: true });
    let touchStartY = null;
    pbEl.addEventListener("touchstart", (e) => {
      const t = e.touches && e.touches[0];
      touchStartY = t ? t.clientY : null;
      markUserScrollIntent(false);
    }, { passive: true });
    pbEl.addEventListener("touchmove", (e) => {
      const t = e.touches && e.touches[0];
      if (t && touchStartY != null) markUserScrollIntent(t.clientY > touchStartY);
    }, { passive: true });
    pbEl.addEventListener("mousedown", (e) => {
      if (e.target === pbEl) markUserScrollIntent(false);
    });
    pbEl.addEventListener("keydown", (e) => {
      if (["PageUp", "ArrowUp", "Home"].includes(e.key)) markUserScrollIntent(true);
      else if (["PageDown", "ArrowDown", "End", " "].includes(e.key)) markUserScrollIntent(false);
    });
    panelBody.addEventListener("click", (e) => {
      const thinkHead = e.target.closest(".think-head");
      if (thinkHead) {
        const block = thinkHead.closest(".think-block");
        if (block) {
          const wasPinned = isPinnedForFollow();
          const opening = block.dataset.open !== "true";
          block.dataset.open = opening ? "true" : "false";
          if (thinkSeg && thinkSeg.block === block) thinkExpandedManual = opening;
          if (wasPinned && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
        }
        return;
      }
      const rewind = e.target.closest(".act-rewind");
      if (rewind) {
        if (runSession.isRunning) return;
        const index = Number(rewind.getAttribute("data-turn-index"));
        if (Number.isInteger(index) && conversation[index] && conversation[index].role === "user") {
          const undone = conversation[index];
          conversation = conversation.slice(0, index);
          saveConversation({ allowShrink: true });
          renderConversation();
          fitPanelHeight();
          pinToBottom();
          if (undone && typeof undone.content === "string") {
            cmdInput.value = undone.content;
            cmdInput.style.height = "auto";
            cmdInput.style.height = Math.min(120, cmdInput.scrollHeight) + "px";
            cmdInput.focus();
          }
        }
        return;
      }
      const userCopy = e.target.closest(".act-user-copy");
      if (userCopy) {
        const turn = userCopy.closest(".user-turn");
        const msgEl = turn && turn.querySelector(".msg.user");
        if (msgEl) navigator.clipboard.writeText(msgEl.textContent || "").then(() => {
          userCopy.textContent = "\u2713 \u5DF2\u590D\u5236";
          setTimeout(() => userCopy.textContent = "\u29C9 \u590D\u5236", 1200);
        });
        return;
      }
      const actBtn = e.target.closest(".act-copy");
      if (actBtn) {
        const msgEl = actBtn.closest(".msg");
        const raw = msgEl && msgEl._raw;
        if (raw) {
          navigator.clipboard.writeText(raw).then(() => {
            actBtn.textContent = "\u2713 \u5DF2\u590D\u5236";
            setTimeout(() => actBtn.textContent = "\u29C9 \u590D\u5236", 1200);
          });
        }
        return;
      }
      const shotImg = e.target.closest(".agent-shot img");
      if (shotImg) {
        openShotLightbox(shotImg.getAttribute("src") || "");
        return;
      }
      const regen = e.target.closest(".act-regen");
      if (regen) {
        if (runSession.isRunning) return;
        let lastUser = -1;
        for (let i = conversation.length - 1; i >= 0; i--) {
          if (conversation[i] && conversation[i].role === "user") {
            lastUser = i;
            break;
          }
        }
        if (lastUser < 0) return;
        const instruction = String(conversation[lastUser].content || "");
        if (!instruction) return;
        conversation = conversation.slice(0, lastUser);
        saveConversation({ allowShrink: true });
        renderConversation();
        run(instruction);
        fitPanelHeight();
        return;
      }
      const btn = e.target.closest(".code-copy");
      if (btn) {
        const wrap = btn.closest(".code-wrap");
        const codeEl = wrap && wrap.querySelector("code");
        if (!codeEl) return;
        navigator.clipboard.writeText(codeEl.textContent || "").then(() => {
          btn.textContent = "\u5DF2\u590D\u5236";
          btn.classList.add("copied");
          setTimeout(() => {
            btn.textContent = "\u590D\u5236";
            btn.classList.remove("copied");
          }, 1200);
        });
        return;
      }
      const cite = e.target.closest(".cite-badge");
      if (cite) {
        const id = cite.getAttribute("data-cite-id");
        const url = cite.getAttribute("data-cite-url");
        const snippet = cite.getAttribute("data-cite-snippet") || "";
        const plan = planCitationOpen(url, location.href, snippet);
        if (plan.action === "highlight") {
          const found = findAndHighlightCitation(snippet) || (snippet.length > 80 ? findAndHighlightCitation(snippet.slice(0, 80)) : false) || (snippet.length > 200 ? findAndHighlightCitation(snippet.slice(0, 200)) : false);
          if (!found) showCitationHint("\u672A\u80FD\u5728\u5F53\u524D\u9875\u9762\u5B9A\u4F4D\u8BE5\u5F15\u7528\u7684\u8BC1\u636E\u6587\u672C\uFF08\u5185\u5BB9\u53EF\u80FD\u5DF2\u53D8\u5316\u6216\u5C1A\u672A\u52A0\u8F7D\uFF09\u3002");
        } else if (plan.action === "open") {
          window.open(plan.target, "_blank", "noopener");
        } else if (plan.action === "deny") {
          showCitationHint(plan.reason || "\u8BE5\u5F15\u7528\u7684\u94FE\u63A5\u4E0D\u88AB\u5141\u8BB8\u6253\u5F00\u3002");
        } else if (id) {
          try {
            chrome.runtime.sendMessage({ type: "openManager", focusId: id });
          } catch (e2) {
          }
        } else {
          showCitationHint("\u8BE5\u5F15\u7528\u6CA1\u6709\u53EF\u6253\u5F00\u7684\u94FE\u63A5\u3002");
        }
      }
    });
    const approvalSettings = document.createElement("div");
    approvalSettings.className = "approval-settings";
    approvalSettings.innerHTML = '<button class="approval-settings-toggle" type="button">\u81EA\u52A8\u6279\u51C6\uFF1A\u8BFB\u53D6 <span>\u203A</span></button><div class="approval-settings-popover" hidden><label class="approval-autopilot"><input data-autopilot type="checkbox"> <b>\u81EA\u52A8\u9A7E\u9A76\uFF08\u5168\u90E8\u81EA\u52A8\u6279\u51C6\uFF09</b></label><div class="approval-settings-caption">\u672A\u5F00\u542F\u65F6\uFF0C\u6309\u4E0B\u5217\u7C7B\u522B\u9010\u9879\u63A7\u5236\u662F\u5426\u514D\u786E\u8BA4\uFF1A</div><div class="approval-group"><div class="approval-group-title">\u8BFB\u53D6</div><label class="approval-item"><input data-policy="read" type="checkbox"> \u8BFB\u53D6\u5185\u5BB9 <small>\u641C\u7D22\u3001\u8BFB\u53D6\u9875\u9762\u3001\u5217\u51FA\u6807\u7B7E\u9875</small></label></div><div class="approval-group"><div class="approval-group-title">\u5199\u5165</div><label class="approval-item"><input data-policy="edit" type="checkbox"> \u7F16\u8F91\u77E5\u8BC6\u5E93 <small>\u65B0\u589E / \u4FEE\u6539 / \u5220\u9664\u6536\u85CF</small></label><label class="approval-item"><input data-policy="commands" type="checkbox"> \u9875\u9762\u547D\u4EE4 <small>\u70B9\u51FB\u3001\u8F93\u5165\u3001\u6EDA\u52A8\u3001\u9AD8\u4EAE\u3001\u8FD0\u884C JavaScript \u7B49</small></label></div><div class="approval-group"><div class="approval-group-title">\u5916\u90E8</div><label class="approval-item"><input data-policy="browser" type="checkbox"> \u6D4F\u89C8\u5668\u4E0E\u7F51\u7EDC <small>\u6253\u5F00\u6807\u7B7E\u9875\u3001\u6293\u53D6\u7F51\u9875</small></label><label class="approval-item"><input data-policy="mcp" type="checkbox"> MCP \u670D\u52A1\u5668 <small>\u8C03\u7528\u5916\u90E8\u5DE5\u5177</small></label></div></div>';
    approvalSettingsEl = approvalSettings;
    const autopilotEl = approvalSettings.querySelector("[data-autopilot]");
    autopilotEl.addEventListener("change", () => {
      const on = autopilotEl.checked;
      approvalSettings.querySelectorAll("[data-policy]").forEach((x2) => {
        x2.checked = on;
        x2.dispatchEvent(new Event("change"));
      });
    });
    const approvalToggle = approvalSettings.querySelector(".approval-settings-toggle");
    const approvalPopover = approvalSettings.querySelector(".approval-settings-popover");
    approvalPopoverEl = approvalPopover;
    panel.addEventListener("click", (e) => {
      if (!approvalSettings.contains(e.target)) closeApprovalPopover();
    });
    const refreshApprovalLabel = () => {
      const names = { read: "\u8BFB\u53D6", edit: "\u7F16\u8F91", commands: "\u547D\u4EE4", browser: "\u6D4F\u89C8\u5668", mcp: "MCP" };
      const on = [...approvalSettings.querySelectorAll("[data-policy]:checked")].map((x2) => names[x2.dataset.policy]);
      approvalToggle.innerHTML = "\u81EA\u52A8\u6279\u51C6\uFF1A" + (on.length ? on.join("\u3001") : "\u65E0") + " <span>\u203A</span>";
    };
    approvalToggle.addEventListener("click", () => {
      const opening = approvalPopover.hidden;
      approvalPopover.hidden = !opening;
      panel.classList.toggle("approval-open", opening);
      fitPanelHeight();
    });
    getAISettings().then((s) => {
      const p = s.toolApprovalPolicy || { read: true };
      approvalSettings.querySelectorAll("[data-policy]").forEach((x2) => {
        x2.checked = p[x2.dataset.policy] === true;
        x2.addEventListener("change", async () => {
          const policy = Object.fromEntries([...approvalSettings.querySelectorAll("[data-policy]")].map((y2) => [y2.dataset.policy, y2.checked]));
          try {
            await updateAISettings({ toolApprovalPolicy: policy });
          } catch (e) {
            warnExtDead();
          }
          autopilotEl.checked = ["read", "edit", "commands", "browser", "mcp"].every((k) => policy[k] === true);
          refreshApprovalLabel();
        });
      });
      autopilotEl.checked = ["read", "edit", "commands", "browser", "mcp"].every((k) => p[k] === true);
      refreshApprovalLabel();
    }).catch(() => {
    });
    apiKeyBanner = document.createElement("div");
    apiKeyBanner.className = "api-key-banner";
    apiKeyBanner.style.cssText = "display:none;margin:4px 0;padding:6px 8px;border:1px solid #f0c36d;background:#fff8e6;border-radius:6px;color:#8a5a00;font-size:12px;align-items:center;gap:8px;justify-content:space-between;";
    const apiKeyText = document.createElement("span");
    apiKeyText.textContent = "\u5C1A\u672A\u914D\u7F6E API Key\uFF0C\u914D\u7F6E\u540E\u624D\u80FD\u5F00\u59CB\u5BF9\u8BDD\u3002";
    const apiKeySettingsBtn = document.createElement("button");
    apiKeySettingsBtn.type = "button";
    apiKeySettingsBtn.className = "api-key-settings";
    apiKeySettingsBtn.textContent = "\u6253\u5F00\u8BBE\u7F6E";
    apiKeySettingsBtn.style.cssText = "border:1px solid #c98a00;color:#8a5a00;background:#fff;border-radius:5px;padding:2px 8px;cursor:pointer;font-size:12px;";
    apiKeySettingsBtn.addEventListener("click", () => {
      try {
        chrome.runtime.sendMessage({ type: "openOptions" });
      } catch (e) {
      }
    });
    apiKeyBanner.appendChild(apiKeyText);
    apiKeyBanner.appendChild(apiKeySettingsBtn);
    planBar = document.createElement("div");
    planBar.className = "agent-plan agent-plan-bar";
    planBar.style.display = "none";
    planBar.addEventListener("click", (e) => {
      if (!e.target || !e.target.closest || !e.target.closest(".agent-plan-title")) return;
      planExpanded = planBar.classList.contains("collapsed");
      renderPlan(lastPlan);
    });
    renderConversation();
    restoreStreamingUI();
    renderDecisionButtonsIfPresent();
    const cmdArea = document.createElement("div");
    cmdArea.className = "cmd-area";
    cmdArea.appendChild(planBar);
    const approvalArea = document.createElement("div");
    approvalArea.className = "tool-approval";
    approvalArea.style.display = "none";
    cmdArea.appendChild(approvalArea);
    const quickWrap = document.createElement("div");
    quickWrap.className = "quick-prompts";
    cmdArea.appendChild(quickWrap);
    cmdArea.appendChild(apiKeyBanner);
    cmdArea.appendChild(approvalSettings);
    refreshApiKeyBanner();
    const pickBar = document.createElement("div");
    pickBar.className = "pick-bar";
    pickBar.style.display = "none";
    cmdArea.appendChild(pickBar);
    const cmdWrap = document.createElement("div");
    cmdWrap.className = "cmd-box";
    const cmdInput = document.createElement("textarea");
    panelCmdInput = cmdInput;
    cmdInput.className = "cmd-input";
    cmdInput.rows = 1;
    cmdInput.placeholder = "\u8F93\u5165\u6307\u4EE4\u540E\u56DE\u8F66\uFF0C\u5982\uFF1A\u7FFB\u8BD1\u6210\u4E2D\u6587 / \u89E3\u91CA\u8FD9\u6BB5\u4EE3\u7801 / \u4F18\u5316\u5E76\u8865\u5168\u2026";
    sendBtn = document.createElement("button");
    sendBtn.className = "cmd-send";
    sendBtn.textContent = "\u53D1\u9001";
    sendBtn.disabled = runSession.isRunning;
    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "cmd-pick";
    pickBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/></svg>';
    pickBtn.title = "\u70B9\u51FB\u9009\u62E9\u9875\u9762\u5143\u7D20\uFF08\u53EF\u591A\u9009\uFF1B\u2191\u2193 \u9009\u7236/\u5B50\u5143\u7D20\uFF1BEsc \u5B8C\u6210\uFF09\uFF0C\u628A\u5B83\u548C\u5BF9\u5E94\u7684\u524D\u7AEF\u6E90\u7801\u4F4D\u7F6E\u4E00\u8D77\u53D1\u7ED9 AI";
    pickBtn.setAttribute("aria-label", "\u9009\u62E9\u9875\u9762\u5143\u7D20");
    cmdWrap.appendChild(cmdInput);
    cmdWrap.appendChild(pickBtn);
    cmdWrap.appendChild(sendBtn);
    cmdArea.appendChild(cmdWrap);
    const locatorText = (p) => formatElementLocator(p && p.locator, p && p.selector, p && p.tag);
    const renderPick = () => {
      pickBar.innerHTML = "";
      if (!pickedElements.length) {
        pickBar.style.display = "none";
        return;
      }
      pickBar.style.display = "";
      pickedElements.forEach((p, idx) => {
        const src = p.source || {};
        const loc = src.file ? src.file + (src.line ? ":" + src.line : "") : "";
        const chip = document.createElement("span");
        chip.className = "pick-chip";
        const txt = document.createElement("span");
        txt.className = "pick-chip-text";
        txt.textContent = (pickedElements.length > 1 ? idx + 1 + ". " : "") + (p.tag || "") + (p.label ? "\u300C" + p.label + "\u300D" : "") + (loc ? " \u2192 " + loc : "");
        txt.title = locatorText(p);
        const copy = document.createElement("button");
        copy.className = "pick-copy";
        copy.textContent = "\u29C9";
        copy.title = "\u590D\u5236\u5B9A\u4F4D\uFF1A" + locatorText(p);
        copy.addEventListener("click", () => {
          const text = locatorText(p);
          navigator.clipboard.writeText(text).then(
            () => {
              copy.textContent = "\u2713";
              setTimeout(() => copy.textContent = "\u29C9", 1e3);
            },
            () => {
            }
          );
        });
        const clear = document.createElement("button");
        clear.className = "pick-clear";
        clear.textContent = "\u2715";
        clear.title = "\u79FB\u9664\u8BE5\u5143\u7D20";
        clear.addEventListener("click", () => {
          pickedElements.splice(idx, 1);
          renderPick();
        });
        chip.appendChild(txt);
        chip.appendChild(copy);
        chip.appendChild(clear);
        pickBar.appendChild(chip);
      });
      if (pickedElements.length > 1) {
        const clearAll = document.createElement("button");
        clearAll.className = "pick-clear-all";
        clearAll.textContent = "\u6E05\u7A7A";
        clearAll.addEventListener("click", () => {
          pickedElements = [];
          renderPick();
        });
        pickBar.appendChild(clearAll);
      }
      fitPanelHeight();
    };
    pickUi = {
      setActive: (on) => {
        picking = !!on;
        pickBtn.classList.toggle("active", !!on);
      },
      onPicked: (list) => {
        pickedElements = Array.isArray(list) ? list : list ? [list] : [];
        renderPick();
        cmdInput.focus();
      }
    };
    pickBtn.addEventListener("click", () => {
      if (picking) {
        try {
          chrome.runtime.sendMessage({ type: "pick:cancel" });
        } catch (e) {
        }
        pickUi.setActive(false);
        return;
      }
      pickUi.setActive(true);
      try {
        chrome.runtime.sendMessage({ type: "pick:start" });
      } catch (e) {
        pickUi.setActive(false);
      }
    });
    renderPick();
    panel.appendChild(panelBody);
    panel.appendChild(cmdArea);
    syncPanelSelectionPreview();
    getAISettings().then((s) => {
      quickWrap.innerHTML = "";
      (s.quickPrompts || AI_SETTINGS_DEFAULTS.quickPrompts || []).slice(0, 12).forEach((prompt) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "quick-prompt";
        b.textContent = prompt;
        b.addEventListener("click", () => {
          if (runSession.isRunning) return;
          run(expandQuickPrompt(prompt));
        });
        quickWrap.appendChild(b);
      });
      fitPanelHeight();
    }).catch(() => {
    });
    const foot = document.createElement("div");
    foot.className = "p-foot";
    const clearBtn = document.createElement("button");
    clearBtn.className = "new-session-btn";
    clearBtn.textContent = "\uFF0B \u65B0\u5EFA\u4F1A\u8BDD";
    clearBtn.title = "\u4FDD\u7559\u5F53\u524D\u5BF9\u8BDD\u5E76\u5F00\u542F\u4E00\u4E2A\u65B0\u4F1A\u8BDD";
    clearBtn.addEventListener("click", () => newPanelSession().catch(() => {
    }));
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "\u5BFC\u51FA\u8BB0\u5F55";
    copyBtn.title = "\u5BFC\u51FA\u4E3A\u7ED3\u6784\u5316 markdown\uFF08\u542B\u89D2\u8272\u5206\u9694\u4E0E\u5DE5\u5177\u660E\u7EC6\uFF09\uFF0C\u53EF\u76F4\u63A5\u4EA4\u7ED9 AI \u6216\u8D34\u8FDB\u5DE5\u5355\uFF1B\u5355\u6761\u5DE5\u5177\u7ED3\u679C\u6309 500 \u5B57\u622A\u65AD\u4EE5\u4FBF\u7C98\u8D34";
    const copyFullBtn = document.createElement("button");
    copyFullBtn.className = "copy-btn";
    copyFullBtn.textContent = "\u5BFC\u51FA\u5B8C\u6574";
    copyFullBtn.title = "\u540C\u4E0A\uFF0C\u4F46**\u4E0D\u622A\u65AD**\u5DE5\u5177\u7ED3\u679C \u2014\u2014 \u9002\u5408\u7559\u6863\u3001\u6392\u67E5\u3001\u6216\u8BA9\u63A5\u624B\u7684 AI \u770B\u5230\u524D\u4E00\u4E2A AI \u8BD5\u8FC7\u7684\u5168\u90E8\u6B65\u9AA4";
    const exportTranscript = (btn, mode) => {
      const label = btn.textContent;
      const restore2 = () => setTimeout(() => btn.textContent = label, 1600);
      let text = "";
      try {
        text = buildTranscriptMarkdown(mode);
      } catch (e) {
        text = "";
      }
      if (!text) {
        btn.textContent = "\u6682\u65E0\u53EF\u5BFC\u51FA\u7684\u5BF9\u8BDD";
        restore2();
        return;
      }
      navigator.clipboard.writeText(text).then(
        () => {
          btn.textContent = "\u5DF2\u590D\u5236 " + text.length + " \u5B57";
          restore2();
        },
        () => {
          btn.textContent = "\u590D\u5236\u5931\u8D25";
          restore2();
        }
      );
    };
    copyBtn.addEventListener("click", () => exportTranscript(copyBtn, "brief"));
    copyFullBtn.addEventListener("click", () => exportTranscript(copyFullBtn, "full"));
    stopBtn = document.createElement("button");
    stopBtn.className = "stop-btn";
    stopBtn.textContent = "\u25A0 \u505C\u6B62";
    updateRunControlState();
    stopBtn.addEventListener("click", interrupt);
    foot.appendChild(clearBtn);
    foot.appendChild(copyBtn);
    foot.appendChild(copyFullBtn);
    foot.appendChild(stopBtn);
    panel.appendChild(foot);
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "resize-handle bottom-right";
    const startResize = (e, origin) => {
      e.preventDefault();
      e.stopPropagation();
      panel._manualSize = true;
      panel._manualPos = true;
      const r = panel.getBoundingClientRect();
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = r.left + "px";
      panel.style.top = r.top + "px";
      resizeState = {
        startX: e.clientX,
        startY: e.clientY,
        origWidth: panel.offsetWidth,
        origHeight: panel.offsetHeight,
        origin
      };
    };
    resizeHandle.addEventListener("mousedown", (e) => startResize(e, "bottom-right"));
    panel.appendChild(resizeHandle);
    ["top-left", "top", "top-right", "left", "right", "bottom-left", "bottom"].forEach((origin) => {
      const h = document.createElement("div");
      h.className = "resize-handle " + origin;
      h.addEventListener("mousedown", (e) => startResize(e, origin));
      panel.appendChild(h);
    });
    shadow.appendChild(panel);
    const placement = resolvePanelPlacement({
      layout,
      docked: dockedIntent,
      point: { x, y },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      size: { width: panel.offsetWidth, height: panel.offsetHeight },
      dockGap: getDockGap()
    });
    if (placement.docked) panel.classList.add("docked");
    else panel.classList.remove("docked");
    panel.style.right = placement.right == null ? "auto" : placement.right + "px";
    panel.style.bottom = placement.bottom == null ? "auto" : placement.bottom + "px";
    panel.style.left = placement.left == null ? "auto" : placement.left + "px";
    panel.style.top = placement.top == null ? "auto" : placement.top + "px";
    panel._manualPos = placement.manualPos;
    writePanelLayout(globalThis.localStorage, {
      docked: placement.docked,
      manualPos: placement.manualPos,
      left: placement.left,
      top: placement.top,
      width: panel.offsetWidth,
      height: panel.offsetHeight,
      writeSize: false
    });
    function endStream() {
      streamRender.cancel();
      cancelStreamPaintRetry();
      const endedRunId = runSession.runId;
      const endedSessionId = panelSessionId;
      runSession.finish();
      stopProgress();
      updateRunControlState();
      pendingAiMsg = null;
      pendingContentEl = null;
      flowEl = null;
      streamState.reset();
      typingEl = null;
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      panelSessionSaveChain.catch(() => null).then(async (saved) => {
        await releasePanelSessionLock();
        if (saved && saved.ok && endedRunId) {
          await sendPanelMessage("panel:run:committed", {
            runId: endedRunId,
            sessionId: endedSessionId
          }).catch(() => {
          });
        }
      }).catch(() => {
      }).finally(() => {
        if (!deferredRemoteSessionId || runSession.isRunning) return;
        const next = deferredRemoteSessionId;
        deferredRemoteSessionId = "";
        if (next !== panelSessionId) switchPanelSession(next, { activate: false, force: true }).catch(() => {
        });
      });
    }
    function removeTypingEl() {
      if (typingEl && typingEl.parentNode) {
        typingEl.parentNode.removeChild(typingEl);
        if (pendingContentEl === typingEl) pendingContentEl = null;
      }
      typingEl = null;
    }
    function ensureTextEl() {
      return makeContentEl(flowEl);
    }
    function pushReasoning(text) {
      const piece = String(text || "");
      if (!piece) return;
      if (!thinkSeg || thinkSeg.done) {
        thinkSeg = { id: ++thinkSegSeq, text: "", done: false, block: null, body: null };
        thinkExpandedManual = null;
        mountThinkSegment(thinkSeg);
      }
      const seg = thinkSeg;
      seg.text += piece;
      streamRender.schedule("reason-" + seg.id, () => {
        if (seg.body) seg.body.textContent = seg.text;
        refreshThinkHead(seg);
        pinToBottom();
      });
    }
    function finishReasoning() {
      const seg = thinkSeg;
      if (!seg || seg.done) return;
      seg.done = true;
      if (seg.block) {
        seg.block.dataset.state = "done";
        if (thinkExpandedManual === null) seg.block.dataset.open = "false";
      }
      refreshThinkHead(seg);
      streamRender.schedule("reason-" + seg.id, () => {
        if (seg.body) seg.body.textContent = seg.text;
        refreshThinkHead(seg);
        pinToBottom();
      });
      streamState.appendPart({ type: "thinking", text: seg.text });
      thinkSeg = null;
    }
    function resetReasoning() {
      thinkSeg = null;
      thinkExpandedManual = null;
    }
    function appendStep(step) {
      removeTypingEl();
      finishReasoning();
      if (streamState.narration) {
        const narration = streamState.flushNarration() || "";
        if (pendingContentEl) {
          removeStreamCursor(pendingContentEl);
          pendingContentEl.innerHTML = renderAnswer(narration, currentCitations, false);
        }
      }
      pendingContentEl = null;
      if (flowEl) flowEl.appendChild(step);
    }
    function appendNoticePart(text, color, className) {
      const value = String(text || "").trim();
      if (!value) return;
      const step = document.createElement("div");
      step.className = "agent-step" + (className ? " " + className : "");
      if (color) step.style.color = color;
      step.textContent = value;
      appendStep(step);
      streamState.appendPart({ type: "notice", text: value, color: color || "" });
    }
    function commitPendingVerifyPass() {
      streamState.commitVerifyPass();
    }
    async function stopFollowedRun() {
      if (!followedRunState || followedRunState.status !== "running" || followedRunState.stopping) return;
      const runId = followedRunId;
      followedRunState.stopping = true;
      updateRunControlState();
      const res = await sendPanelMessage("panel:run:stop", { sessionId: panelSessionId, runId });
      if (res && (res.ok || res.code === "already-stopping")) return;
      if (followedRunId === runId && followedRunState) {
        followedRunState.stopping = false;
        updateRunControlState();
      }
      showCitationHint(res && res.error || "\u505C\u6B62\u5931\u8D25\uFF1A\u4EFB\u52A1\u53EF\u80FD\u5DF2\u7ECF\u7ED3\u675F");
      scheduleFollowedRunRefresh();
    }
    async function interrupt(source) {
      if (!runSession.isRunning) {
        if (source === "remote") return;
        await stopFollowedRun();
        return;
      }
      const remote = source === "remote";
      finishReasoning();
      commitPendingVerifyPass();
      if (!remote) {
        try {
          if (activeConn) activeConn.postMessage({ type: "stop" });
        } catch (e) {
        }
      }
      const acc = streamState.content;
      closePort();
      if (pendingAiMsg && pendingAiMsg.parentNode) {
        lastResponse = streamState.responseText;
        if (acc) {
          if (pendingContentEl) {
            removeStreamCursor(pendingContentEl);
            pendingContentEl.innerHTML = renderAnswer(streamState.narration || lastResponse, currentCitations, false);
          }
          pendingAiMsg._raw = acc;
        } else if (!streamState.parts.length) {
          if (pendingContentEl) {
            removeStreamCursor(pendingContentEl);
            pendingContentEl.textContent = "\uFF08\u5DF2\u505C\u6B62\uFF09";
            pendingContentEl.style.color = "#999";
          }
        }
        if (lastResponse && !alreadyCommittedAsText(streamState.parts, lastResponse)) {
          streamState.appendPart({ type: "text", text: lastResponse });
        }
        if (acc || streamState.parts.length) {
          conversation.push({
            role: "assistant",
            content: acc,
            toolSummary: summarizeToolParts(streamState.parts),
            parts: streamState.parts.slice(),
            // 计划条的唯一来源就是消息里的 plan（renderConversation 取"最近一条带计划的助手消息"）：
            // 停止的这一轮若不记它，重开面板后计划条会回退到更早那一轮的状态。
            plan: lastPlan.slice()
          });
          saveConversation();
        }
        const note = document.createElement("div");
        note.className = "stopped-note";
        note.textContent = "\xB7 \u5DF2\u505C\u6B62\u751F\u6210";
        pendingAiMsg.appendChild(note);
        pendingAiMsg.insertAdjacentHTML("beforeend", msgActionsHtml(true));
      }
      endStream();
      fitPanelHeight();
      pinToBottom();
    }
    function commitInterruptedTurn(reasonText) {
      const last = conversation.length ? conversation[conversation.length - 1] : null;
      if (last && last.role === "assistant" && last.interrupted) return;
      commitPendingVerifyPass();
      const turn = buildInterruptedTurn(streamState.parts, streamState.responseText, reasonText);
      if (!turn.parts.length && !String(streamState.responseText || "").trim()) return;
      conversation.push(turn);
      saveConversation();
    }
    const MAX_PORT_RETRIES = 2;
    let portRetries = 0;
    let activeInstruction = "";
    let activeSelection = "";
    let lastRunOpts = null;
    let activeConn = null;
    let readyWaiter = null;
    function waitSessionReady(timeoutMs) {
      return new Promise((resolve) => {
        const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 4e3);
        const tick = () => {
          const activePort = runSession.port;
          if (!activePort || !runSession.isRunning) {
            resolve(false);
            return;
          }
          if (Date.now() > deadline) {
            resolve(false);
            return;
          }
          readyWaiter = (ok) => {
            if (ok) resolve(true);
            else setTimeout(tick, 250);
          };
          try {
            activePort.postMessage({ type: "session-ready", runId: runSession.runId });
          } catch (e) {
            resolve(false);
          }
        };
        tick();
      });
    }
    function sendAgentRequest() {
      if (!runSession.port || !activeConn) return;
      try {
        activeConn.postMessage({
          action: "agent",
          runId: runSession.runId,
          sessionId: panelSessionId,
          question: activeInstruction,
          text: activeSelection,
          page: pageText,
          pageUrl: location.href,
          pageTitle: document.title,
          history: conversation.slice(),
          ...portRetries > 0 || lastRunOpts && lastRunOpts.continuation ? { continuation: true } : {},
          ...pickedElements.length ? { pickedElements } : {}
        });
      } catch (e) {
        removeTypingEl();
        showCitationHint("\u4E0E\u6269\u5C55\u7684\u8FDE\u63A5\u5DF2\u65AD\u5F00\uFF08\u6269\u5C55\u53EF\u80FD\u521A\u88AB\u66F4\u65B0\uFF09\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\u3002");
        endStream();
      }
    }
    async function run(instruction, opts) {
      const runOptions = opts || {};
      runSession.setRunId(runOptions.presetRunId || runSession.createRunId());
      activeInstruction = String(instruction || "");
      activeSelection = String(lastText || "").trim();
      try {
        if (conversationLoadPromise) await conversationLoadPromise;
      } catch (e) {
      }
      if (!panelSessionId) {
        showCitationHint("\u4F1A\u8BDD\u5C1A\u672A\u6062\u590D\u5B8C\u6210\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
        endStream();
        return;
      }
      if (panelSessionActiveId && panelSessionActiveId !== panelSessionId) {
        const activated = await sendPanelMessage("panel:activate", { id: panelSessionId });
        if (activated && activated.ok) {
          panelSessionActiveId = panelSessionId;
          if (Array.isArray(activated.sessions)) panelSessionList = activated.sessions.slice();
          renderSessionButton();
          renderSessionMenu();
        }
      }
      const acquired = await acquirePanelSessionLock(runSession.runId, runOptions._lockTakeover === true);
      if (!acquired || !acquired.ok) {
        if (acquired && acquired.locked && !runOptions._lockConflictShown) {
          const owner = acquired.lock || {};
          showPanelDialog({
            title: "\u4F1A\u8BDD\u6B63\u5728\u53E6\u4E00\u4E2A\u6807\u7B7E\u9875\u8FD0\u884C",
            message: "\u8FD9\u4E2A\u4F1A\u8BDD\u5F53\u524D\u7531\u53E6\u4E00\u4E2A\u6807\u7B7E\u9875\u64CD\u4F5C" + (owner.tabId ? "\uFF08\u6807\u7B7E\u9875 " + owner.tabId + "\uFF09" : "") + "\u3002\u63A5\u7BA1\u4F1A\u505C\u6B62\u90A3\u4E00\u8FB9\u7684\u672C\u8F6E\u4EFB\u52A1\uFF0C\u7136\u540E\u5728\u672C\u9875\u7EE7\u7EED\u3002",
            confirmText: "\u63A5\u7BA1\u5E76\u8FD0\u884C",
            cancelText: "\u6539\u5929\u518D\u8BD5",
            extraText: "\u65B0\u5EFA\u4F1A\u8BDD",
            onExtra: () => {
              newPanelSession().then((ok) => {
                if (ok) run(instruction, Object.assign({}, runOptions, { _lockConflictShown: true }));
              }).catch(() => {
              });
            },
            onConfirm: () => {
              run(
                instruction,
                Object.assign({}, runOptions, { _lockTakeover: true, _lockConflictShown: true })
              ).catch(() => {
              });
              return true;
            }
          });
        } else {
          showCitationHint(acquired && acquired.error || "\u65E0\u6CD5\u83B7\u53D6\u4F1A\u8BDD\u8FD0\u884C\u6743\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
        }
        return;
      }
      closePort();
      lastRunOpts = runOptions;
      portRetries = 0;
      let respTimer = null;
      let respFailTimer = null;
      let respWarned = false;
      const clearRespTimers = () => {
        if (respTimer) {
          clearTimeout(respTimer);
          respTimer = null;
        }
        if (respFailTimer) {
          clearTimeout(respFailTimer);
          respFailTimer = null;
        }
      };
      lastResponse = "";
      const pickedForMessage = summarizePickedForMessage(pickedElements);
      const selectedForMessage = activeSelection;
      const skipUserTurn = Boolean(runOptions.skipUserTurn);
      if (!skipUserTurn) {
        conversation.push(
          Object.assign(
            { role: "user", content: instruction },
            selectedForMessage ? { selectedText: selectedForMessage } : {},
            pickedForMessage.length ? { pickedElements: pickedForMessage } : {}
          )
        );
        saveConversation();
        const userMsg = document.createElement("div");
        userMsg.className = "user-turn";
        userMsg.innerHTML = '<div class="msg user">' + escHtml(instruction) + selectedTextMessageHtml(selectedForMessage) + pickedSummaryHtml(pickedForMessage) + "</div>" + userActionsHtml(conversation.length - 1);
        panelBody.appendChild(userMsg);
        clearSelectedText({ render: false });
      }
      const aiMsg = document.createElement("div");
      aiMsg.className = "msg ai";
      flowEl = document.createElement("div");
      flowEl.className = "agent-flow";
      const contentEl = document.createElement("div");
      contentEl.className = "agent-content";
      contentEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
      flowEl.appendChild(contentEl);
      aiMsg.appendChild(flowEl);
      panelBody.appendChild(aiMsg);
      fitPanelHeight();
      pinToBottom();
      const resumeSnapshot = runOptions.resumeSnapshot && typeof runOptions.resumeSnapshot === "object" ? runOptions.resumeSnapshot : null;
      const applyResumeSnapshot = (snapshot, approvalConn) => {
        if (!snapshot || typeof snapshot !== "object") return;
        streamState.restore(snapshot);
        currentCitations = Array.isArray(snapshot.citations) ? snapshot.citations.slice() : null;
        const plan = Array.isArray(snapshot.plan) ? snapshot.plan.slice() : [];
        renderPlan(plan);
        lastPlan = plan;
        if (usageEl) usageEl.textContent = snapshot.tokens ? "tokens " + snapshot.tokens : "";
        flowEl.innerHTML = "";
        renderCommittedParts(flowEl);
        resetReasoning();
        if (snapshot.reasoning) {
          thinkSeg = { id: ++thinkSegSeq, text: String(snapshot.reasoning), done: false, block: null, body: null };
          mountThinkSegment(thinkSeg);
        }
        contentEl.innerHTML = streamState.narration ? renderAnswer(streamState.narration, currentCitations, false) : '<span class="typing"><span></span><span></span><span></span></span>';
        flowEl.appendChild(contentEl);
        if (streamState.narration) showStreamingAnswer(contentEl, streamState.narration, currentCitations);
        typingEl = streamState.narration ? null : contentEl;
        pendingAiMsg = aiMsg;
        pendingContentEl = contentEl;
        pendingAiMsg._raw = streamState.content;
        runStartedAt = Number(snapshot.startedAt) || runStartedAt || Date.now();
        const p = snapshot.progress || {};
        progressState = stateLabel(p.state) || "\u7EE7\u7EED\u8FD0\u884C";
        progressStep = Number(p.step) || 0;
        progressMax = Number(p.max) || 0;
        if (progressEl) progressEl.classList.add("on");
        renderProgress();
        updateRunControlState();
        if (snapshot.approval && approvalConn) {
          const approval = snapshot.approval;
          renderApprovalPrompt2(
            approvalArea,
            approvalConn,
            approval.callId,
            approval.name,
            approval.args,
            approval.risk,
            approval.allowSession
          );
        }
      };
      if (!resumeSnapshot) {
        streamState.beginNew();
        if (usageEl) usageEl.textContent = "";
        renderPlan([]);
        lastPlan = [];
        pendingAiMsg = aiMsg;
        pendingContentEl = contentEl;
        typingEl = contentEl;
        resetReasoning();
      }
      runSession.setRunning(true);
      startProgress();
      if (resumeSnapshot) applyResumeSnapshot(resumeSnapshot);
      updateRunControlState();
      if (!isExtContextAlive()) {
        showCitationHint("\u6269\u5C55\u5DF2\u66F4\u65B0\uFF0C\u5F53\u524D\u9875\u9762\u7684\u52A9\u624B\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\u3002");
        endStream();
        return;
      }
      let conn;
      try {
        conn = chrome.runtime.connect({ name: "ai-stream" });
        runSession.setPort(conn);
      } catch (e) {
        showCitationHint("\u6269\u5C55\u5DF2\u66F4\u65B0\uFF0C\u5F53\u524D\u9875\u9762\u7684\u52A9\u624B\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\u3002");
        endStream();
        return;
      }
      activeConn = conn;
      conn.onMessage.addListener((resp) => {
        if (resp.runId && resp.runId !== runSession.runId) return;
        clearRespTimers();
        if (resp.type === "reattached") {
          applyResumeSnapshot(resp.snapshot, conn);
          return;
        } else if (resp.type === "reattach-failed") {
          showCitationHint(resp.reason || "\u4EFB\u52A1\u5DF2\u7ED3\u675F\uFF0C\u6B63\u5728\u5237\u65B0\u4F1A\u8BDD\u3002");
          endStream();
          if (!adoptFinishedRunSnapshot(resp.snapshot)) loadConversation().catch(() => {
          });
          return;
        } else if (resp.type === "citations") {
          currentCitations = resp.citations || null;
        } else if (resp.type === "tool-call") {
          streamState.appendPart({ type: "tool-call", callId: resp.callId, name: resp.name, args: resp.args || {}, risk: resp.risk || "unknown" });
          appendStep(
            toolStepElement("\u{1F527} ", resp.name, argHint(resp.args), "\u53C2\u6570", clipDetail(JSON.stringify(resp.args || {}, null, 2), 2e3))
          );
          if (resp.requiresApproval) {
            renderApprovalPrompt2(approvalArea, conn, resp.callId, resp.name, resp.args, resp.risk, resp.allowSession);
          }
          fitPanelHeight();
          pinToBottom();
        } else if (resp.type === "tool-result") {
          const resultPart = {
            type: "tool-result",
            callId: resp.callId,
            name: resp.name,
            status: resp.status,
            result: resp.result || ""
          };
          if (resp.needsLogin === true) {
            resultPart.needsLogin = true;
            resultPart.authChallenge = resp.authChallenge && resp.authChallenge.required === true ? resp.authChallenge : {
              required: true,
              reason: "login-required",
              summary: String(resp.authMessage || "\u64CD\u4F5C\u88AB\u767B\u5F55 / \u6743\u9650\u62E6\u622A\uFF0C\u8BF7\u767B\u5F55\u540E\u91CD\u8BD5\u3002"),
              loginUrl: String(resp.loginUrl || "")
            };
          }
          streamState.appendPart(resultPart);
          appendStep(
            toolStepElement(
              resp.status === "completed" ? "\u2713 \u5DE5\u5177\u5DF2\u5B8C\u6210\uFF1A" : resp.status === "failed" ? "\u2717 \u5DE5\u5177\u5931\u8D25\uFF1A" : "\u2014 \u5DE5\u5177\u672A\u6267\u884C\uFF1A",
              resp.name,
              "",
              resp.status === "failed" ? "\u9519\u8BEF\u4FE1\u606F" : "\u8FD4\u56DE\u7ED3\u679C",
              clipDetail(resp.result, 4e3)
            )
          );
          const authEl = authChallengeElement(resultPart.authChallenge);
          if (authEl) appendStep(authEl);
          fitPanelHeight();
          pinToBottom();
        } else if (resp.type === "agent-state") {
          const st = resp.state || resp.status;
          const label = stateLabel(st);
          if (label) progressState = label;
          const step = Number(resp.step);
          if (Number.isFinite(step) && step > 0) progressStep = step;
          const max = Number(resp.maxSteps);
          if (Number.isFinite(max) && max > 0) progressMax = max;
          renderProgress();
        } else if (resp.type === "screenshot") {
          if (resp.id && resp.dataUrl) shotCache.set(resp.id, resp.dataUrl);
          streamState.appendPart({ type: "screenshot", id: resp.id, label: resp.label, width: resp.width, height: resp.height, bytes: resp.bytes });
          appendStep(screenshotElement(resp));
          fitPanelHeight();
          pinToBottom();
        } else if (resp.type === "stuck-warning") {
          appendNoticePart("\u26A0 " + (resp.message || "\u52A8\u4F5C\u6682\u672A\u4EA7\u751F\u53EF\u89C2\u5BDF\u8FDB\u5C55"), "#b45309");
          fitPanelHeight();
          pinToBottom();
        } else if (resp.type === "tool-disabled") {
          appendNoticePart("\u26D4 \u5DF2\u505C\u6B62\u4F7F\u7528\u5DE5\u5177\u300C" + (resp.name || "") + "\u300D\uFF1A" + (resp.reason || ""), "#6b7280");
          fitPanelHeight();
          pinToBottom();
        } else if (resp.type === "budget-exceeded") {
          streamState.markBudgetStopped();
          appendNoticePart("\u23F9 " + (resp.message || "Agent \u5DF2\u8FBE\u5230\u5B89\u5168\u4E0A\u9650\u5E76\u505C\u6B62"), "#b91c1c");
          fitPanelHeight();
          pinToBottom();
        } else if (resp.type === "tab-switched") {
          appendNoticePart("\u2197 \u5DF2\u5207\u6362\u6807\u7B7E\u9875\uFF1A" + (resp.title || resp.url || "tabId=" + resp.tabId));
          fitPanelHeight();
          pinToBottom();
        } else if (resp.type === "tabs-closed") {
          const count = Array.isArray(resp.tabIds) ? resp.tabIds.length : 0;
          if (count) {
            appendNoticePart("\u{1F5D1} \u4EFB\u52A1\u7ED3\u675F\uFF0C\u5DF2\u81EA\u52A8\u5173\u95ED " + count + " \u4E2A\u672C\u6B21\u6253\u5F00\u7684\u6807\u7B7E\u9875", "#6b7280");
            fitPanelHeight();
            pinToBottom();
          }
        } else if (resp.type === "tabs-close-pending") {
          const count = Array.isArray(resp.tabIds) ? resp.tabIds.length : 0;
          if (count) {
            appendNoticePart("\u{1F5C2} \u4EFB\u52A1\u7ED3\u675F\uFF0C\u5C06\u5728\u6700\u7EC8\u56DE\u590D\u4FDD\u5B58\u540E\u5173\u95ED " + count + " \u4E2A\u8F85\u52A9\u6807\u7B7E\u9875", "#6b7280");
            fitPanelHeight();
            pinToBottom();
          }
        } else if (resp.type === "intent") {
          appendNoticePart("\u{1F9ED} \u610F\u56FE\u8BC6\u522B\uFF1A" + (resp.label || resp.intent || "\u666E\u901A\u5BF9\u8BDD"));
          fitPanelHeight();
          pinToBottom();
        } else if (resp.type === "intent-upgraded") {
          appendNoticePart("\u{1F504} \u5DF2\u5207\u6362\u4E3A" + (resp.label || "\u8D44\u6599\u7814\u7A76") + "\u6A21\u5F0F\uFF0C\u53EF\u7528\u6D4F\u89C8\u5668/\u7F51\u7EDC\u5DE5\u5177\u7EE7\u7EED");
          fitPanelHeight();
          pinToBottom();
        } else if (resp.type === "verify") {
          let text = "";
          if (resp.ok) {
            text = "\u2713 \u5B8C\u6210\u524D\u6821\u9A8C\u901A\u8FC7" + (resp.reason ? "\uFF1A" + resp.reason : "");
          } else if (resp.inconclusive) {
            text = "\u2026 \u672A\u80FD\u5B8C\u6210\u6821\u9A8C\uFF1A" + (resp.reason || "\u6821\u9A8C\u5668\u4E0D\u53EF\u7528");
          } else if (resp.deterministic) {
            text = "\u26A0 \u5B8C\u6210\u524D\u68C0\u67E5\u672A\u901A\u8FC7\uFF08\u786E\u5B9A\u6027\u89C4\u5219\uFF0C\u672A\u6D88\u8017\u6A21\u578B\u8C03\u7528\uFF09\uFF1A" + (resp.reason || "\u58F0\u79F0\u4E0E\u5B9E\u9645\u52A8\u4F5C\u4E0D\u7B26");
          } else if (resp.repeated) {
            text = "\u26A0 \u6821\u9A8C\u672A\u901A\u8FC7\uFF08\u8BC1\u636E\u4E0E\u4E0A\u6B21\u5B8C\u5168\u76F8\u540C\uFF0C\u672A\u91CD\u590D\u8C03\u7528\u6A21\u578B\uFF09\uFF1A" + (resp.reason || "\u8BC1\u636E\u6CA1\u6709\u53D8\u5316");
          } else {
            text = "\u26A0 \u6821\u9A8C\u672A\u901A\u8FC7\uFF1A" + (resp.reason || "\u76EE\u6807\u53EF\u80FD\u672A\u8FBE\u6210") + (resp.missing ? "\uFF08\u8FD8\u5DEE\uFF1A" + resp.missing + "\uFF09" : "");
          }
          if (resp.ok === true) {
            streamState.setVerifyPass({ type: "notice", text, color: "#16a34a", terminal: true });
          } else {
            appendNoticePart(text, "#b45309");
            fitPanelHeight();
            pinToBottom();
          }
        } else if (resp.type === "usage") {
          if (usageEl) usageEl.textContent = "tokens " + (resp.totalTokens || 0);
        } else if (resp.type === "plan") {
          renderPlan(resp.plan);
        } else if (resp.type === "skill") {
          const skills = Array.isArray(resp.skills) ? resp.skills : [];
          if (skills.length) {
            appendNoticePart("\u{1F6E0} \u542F\u7528\u6280\u80FD\uFF1A" + skills.map((s) => s.title || s.name).join("\u3001"), "", "agent-skill");
            fitPanelHeight();
            pinToBottom();
          }
        } else if (resp.type === "reasoning") {
          removeTypingEl();
          pushReasoning(resp.text);
        } else if (resp.type === "chunk") {
          removeTypingEl();
          finishReasoning();
          streamState.appendChunk(resp.text);
          if (!pendingContentEl) {
            pendingContentEl = ensureTextEl();
            if (pendingContentEl) pendingContentEl.innerHTML = "";
          }
          streamRender.schedule("answer", () => {
            const paintPendingAnswer = () => {
              const startedAt = Date.now();
              if (pendingContentEl) showStreamingAnswer(pendingContentEl, streamState.narration, currentCitations);
              pendingAiMsg._raw = streamState.content;
              noteStreamPaint(startedAt);
            };
            if (throttleStreamPaint(paintPendingAnswer)) return;
            paintPendingAnswer();
          });
          streamRender.schedule("layout", () => {
            fitPanelHeight();
            pinToBottom();
          });
        } else if (resp.type === "end") {
          removeTypingEl();
          finishReasoning();
          streamRender.flush();
          lastResponse = collapseImmediateRepeatedText(streamState.responseText);
          if (lastResponse && !alreadyCommittedAsText(streamState.parts, lastResponse)) {
            streamState.appendPart({ type: "text", text: lastResponse });
          }
          const textParts = streamState.parts.filter((p) => (p.type === "narration" || p.type === "text") && p.text);
          const renumbered = renumberCitationsAcross(
            textParts.map((p) => p.text).concat([lastResponse]),
            currentCitations
          );
          const finalText = renumbered.apply(lastResponse);
          const finalCitations = renumbered.citations;
          if (!streamState.started) {
            const el = ensureTextEl();
            if (el) el.textContent = streamState.budgetStopped ? "\uFF08\u4EFB\u52A1\u5DF2\u505C\u6B62\uFF0C\u672A\u751F\u6210\u6700\u7EC8\u56DE\u590D\uFF09" : "\uFF08\u65E0\u8FD4\u56DE\u5185\u5BB9\uFF09";
          } else if (pendingContentEl) {
            removeStreamCursor(pendingContentEl);
            pendingContentEl.innerHTML = renderAnswer(lastResponse, currentCitations, false);
            pendingAiMsg._raw = streamState.content;
          }
          if (finalCitations.length) {
            const srcWrap = document.createElement("div");
            srcWrap.className = "cite-sources";
            srcWrap.innerHTML = '<span class="cite-label">\u53C2\u8003\u6765\u6E90\uFF1A</span>' + finalCitations.map((c) => {
              const t = c.title.length > 18 ? c.title.slice(0, 18) + "\u2026" : c.title;
              const idAttr = String(c.id || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
              const tAttr = String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
              const titleAttr = String(c.title).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
              const sourceAttr = String(c.source || "kb").replace(/"/g, "&quot;");
              const urlAttr = String(c.url || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
              const snippetAttr = String(c.snippet || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
              return '<button class="cite-badge" data-cite-id="' + idAttr + '" data-cite-source="' + sourceAttr + '" data-cite-url="' + urlAttr + '" data-cite-snippet="' + snippetAttr + '" title="\u6253\u5F00\u8BC1\u636E\uFF1A' + titleAttr + '"><span class="cite-idx">[' + c.index + "]</span>" + tAttr + "</button>";
            }).join("");
            pendingAiMsg.appendChild(srcWrap);
          }
          if (streamState.verifyPass) {
            const verifyEl = document.createElement("div");
            verifyEl.className = "agent-step verify-final";
            verifyEl.style.color = streamState.verifyPass.color || "#16a34a";
            verifyEl.textContent = streamState.verifyPass.text;
            pendingAiMsg.appendChild(verifyEl);
          }
          if (lastResponse) pendingAiMsg.insertAdjacentHTML("beforeend", msgActionsHtml(true));
          commitPendingVerifyPass();
          const finalParts = dedupeAdjacentTextParts(streamState.parts.map((p) => {
            if (p.type === "narration" || p.type === "text") {
              return p.text ? Object.assign({}, p, { text: renumbered.apply(collapseImmediateRepeatedText(p.text)) }) : p;
            }
            if (p.type === "tool-result" && typeof p.result === "string") {
              return Object.assign({}, p, { result: renumbered.apply(p.result) });
            }
            return p;
          }));
          conversation.push({ role: "assistant", content: finalText, citations: finalCitations, plan: lastPlan.slice(), toolSummary: summarizeToolParts(finalParts), parts: finalParts });
          saveConversation();
          if (!pendingAiMsg || !pendingAiMsg.isConnected) {
            try {
              renderConversation();
            } catch (e) {
            }
          } else {
            renderSuggestionButtons(pendingAiMsg, finalText, run);
          }
          fitPanelHeight();
          currentCitations = null;
          endStream();
          closePort();
        } else if (resp.type === "error") {
          removeTypingEl();
          const errText = String(resp.error || "\u4EFB\u52A1\u5931\u8D25\uFF08\u672A\u63D0\u4F9B\u9519\u8BEF\u4FE1\u606F\uFF09");
          const hasPartial = streamState.hasPartial();
          renderRunError(flowEl, pendingContentEl, errText, hasPartial);
          if (resp.needSetup) {
            refreshApiKeyBanner();
            const anchor = pendingAiMsg || flowEl;
            if (anchor) {
              anchor.appendChild(document.createElement("br"));
              anchor.appendChild(buildOpenSettingsButton());
            }
          }
          conversation.push(buildFailedTurn(streamState.parts, errText, streamState.responseText));
          saveConversation();
          endStream();
          closePort();
        }
      });
      conn.onDisconnect.addListener(() => {
        if (conn !== activeConn) return;
        runSession.clearPort(conn);
        if (!runSession.isRunning) return;
        if (portRetries >= MAX_PORT_RETRIES) {
          commitInterruptedTurn("\u4EFB\u52A1\u4E2D\u65AD\uFF1A\u4E0E\u6269\u5C55\u7684\u8FDE\u63A5\u53CD\u590D\u65AD\u5F00\uFF0C\u5DF2\u505C\u6B62\u91CD\u8FDE\u3002");
          endStream();
          return;
        }
        portRetries += 1;
        let nextPort;
        try {
          nextPort = chrome.runtime.connect({ name: "ai-stream" });
          runSession.setPort(nextPort);
        } catch (e) {
          endStream();
          return;
        }
        activeConn = nextPort;
        nextPort.onMessage.addListener((resp) => {
          if (resp.runId && resp.runId !== runSession.runId) return;
          if (resp.type === "session-ready") {
            if (readyWaiter) {
              const w = readyWaiter;
              readyWaiter = null;
              w(resp.ready === true);
            }
            return;
          }
          if (resp.type === "end" || resp.type === "error") runSession.finish();
        });
        (async () => {
          const ready = await waitSessionReady(6e3);
          if (!runSession.isRunning) return;
          if (!ready) {
            removeTypingEl();
            showCitationHint("\u4EFB\u52A1\u88AB\u4E2D\u65AD\u4E14\u540E\u53F0\u672A\u80FD\u6062\u590D\u4F1A\u8BDD\uFF0C\u8BF7\u91CD\u65B0\u53D1\u9001\u6307\u4EE4\u3002");
            commitInterruptedTurn("\u4EFB\u52A1\u4E2D\u65AD\uFF1A\u540E\u53F0\u672A\u80FD\u6062\u590D\u4F1A\u8BDD\uFF08\u6269\u5C55\u53EF\u80FD\u521A\u88AB\u66F4\u65B0\u6216\u56DE\u6536\uFF09\u3002");
            endStream();
            return;
          }
          sendAgentRequest();
        })();
      });
      clearInterval(keepAliveTimer);
      keepAliveTimer = setInterval(() => {
        try {
          conn.postMessage({ type: "keepalive" });
        } catch (e) {
        }
        renewPanelSessionLock();
      }, 2e4);
      if (runOptions.reattach) {
        conn.postMessage({ type: "reattach", runId: runSession.runId, sessionId: panelSessionId });
      } else {
        conn.postMessage({
          action: "agent",
          runId: runSession.runId,
          sessionId: panelSessionId,
          question: instruction,
          text: activeSelection,
          page: pageText,
          pageUrl: location.href,
          pageTitle: document.title,
          history: conversation.slice(),
          ...runOptions.continuation ? { continuation: true } : {},
          ...pickedElements.length ? { pickedElements } : {}
        });
      }
      if (pickedElements.length) {
        pickedElements = [];
        try {
          renderPick();
        } catch (e) {
        }
      }
      window.addEventListener("__RF_E2E__dropPort", () => {
        try {
          runSession.port?.postMessage({ type: "e2e-drop-port" });
        } catch (e) {
        }
        window.dispatchEvent(new CustomEvent("__RF_E2E__dropped"));
      });
      respTimer = setTimeout(() => {
        if (!runSession.isRunning || respWarned) return;
        respWarned = true;
        if (pendingContentEl) {
          const note = document.createElement("div");
          note.style.cssText = "color:#999;font-size:11px;margin-top:4px;";
          note.textContent = "\u23F3 \u6B63\u5728\u7B49\u5F85\u6A21\u578B\u54CD\u5E94\u2026\uFF08\u7F51\u7EDC\u8F83\u6162\u6216\u6A21\u578B\u7E41\u5FD9\uFF09";
          pendingContentEl.appendChild(note);
        }
      }, 15e3);
      respFailTimer = setTimeout(() => {
        if (!runSession.isRunning) return;
        const el = pendingContentEl || ensureTextEl();
        if (el) {
          removeStreamCursor(el);
          el.textContent = "\u672A\u6536\u5230\u6A21\u578B\u54CD\u5E94\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5\u6216 API \u914D\u7F6E\u540E\u91CD\u8BD5\u3002";
          el.style.color = "#e74c3c";
        }
        commitInterruptedTurn("\u4EFB\u52A1\u4E2D\u65AD\uFF1A45 \u79D2\u5185\u672A\u6536\u5230\u6A21\u578B\u54CD\u5E94\u3002");
        endStream();
        closePort();
      }, 45e3);
    }
    function send() {
      if (runSession.isRunning) return;
      const cmd = cmdInput.value.trim();
      if (!cmd) return;
      run(expandQuickPrompt(cmd));
      cmdInput.value = "";
      cmdInput.style.height = "auto";
      cmdInput.style.height = "34px";
      cmdInput.focus();
    }
    panel._sendFn = run;
    activeSendFn = run;
    sendBtn.addEventListener("click", send);
    cmdInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (picking) return;
        e.preventDefault();
        e.stopPropagation();
        removePanel();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        send();
      }
    });
    cmdInput.addEventListener("input", () => {
      cmdInput.style.height = "auto";
      cmdInput.style.height = Math.min(120, cmdInput.scrollHeight) + "px";
    });
    panelKeyHandler = (e) => {
      if (e.key !== "Escape") return;
      if (picking) return;
      if (panel && panel.querySelector(".session-dialog-backdrop")) return;
      if (panelSessionMenuOpen) {
        e.preventDefault();
        e.stopPropagation();
        closeSessionMenu();
        return;
      }
      if (approvalPopoverEl && !approvalPopoverEl.hidden) {
        e.preventDefault();
        e.stopPropagation();
        closeApprovalPopover();
        return;
      }
      if (shotLightboxOpen) return;
      if (approvalArea && approvalArea.style.display !== "none") return;
      e.preventDefault();
      e.stopPropagation();
      removePanel();
    };
    document.addEventListener("keydown", panelKeyHandler, true);
    cmdInput.focus();
    head.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragState = {
        startX: e.clientX,
        startY: e.clientY,
        origLeft: panel.getBoundingClientRect().left,
        origTop: panel.getBoundingClientRect().top
      };
      panel._manualPos = true;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = dragState.origLeft + "px";
      panel.style.top = dragState.origTop + "px";
      e.preventDefault();
    });
    fitPanelHeight();
    pinToBottom();
    runSession.bindRunner(run);
    runSession.bindInterrupt(interrupt);
    if (panelVisibility.canPublish) publishPanelUi(true, "global");
    subscribePanelRun().catch(() => {
    });
  }
  function refreshPanelForSelection() {
    if (!runSession.isRunning) closePort();
    lastResponse = "";
    syncPanelSelectionPreview();
    renderConversation();
    restoreStreamingUI();
  }
  var observerAutoScroll = true;
  function adoptFinishedRunSnapshot(snapshot) {
    if (!snapshot || snapshot.status === "running" || !Array.isArray(snapshot.parts)) return false;
    const instruction = String(snapshot.instruction || "").trim();
    if (!instruction) return false;
    let userIndex = -1;
    for (let i = conversation.length - 1; i >= 0; i--) {
      if (conversation[i] && conversation[i].role === "user" && String(conversation[i].content || "").trim() === instruction) {
        userIndex = i;
        break;
      }
    }
    if (userIndex >= 0 && conversation.slice(userIndex + 1).some((m) => m && m.role === "assistant" && !m.live)) {
      return false;
    }
    const msg = runStateToAssistantMessage(snapshot);
    if (!msg) return false;
    msg.live = false;
    msg.liveStatus = "completed";
    msg.showCitations = true;
    conversation.push(msg);
    saveConversation();
    if (panelBody && !runSession.isRunning) {
      renderConversation();
      fitPanelHeight();
      pinToBottom();
    }
    return true;
  }
  function maybeResumeRunAfterReload() {
    let attempts = 0;
    const MAX_ATTEMPTS = 12;
    const tick = () => {
      if (runSession.isRunning) return;
      attempts += 1;
      if (attempts > MAX_ATTEMPTS) return;
      let p = null;
      let handled = false;
      try {
        p = chrome.runtime.connect({ name: "ai-stream" });
        p.onMessage.addListener(async (resp) => {
          if (handled || !resp || resp.type !== "run-state") return;
          handled = true;
          try {
            p.disconnect();
          } catch (e) {
          }
          if (!resp.resumable && resp.finished && resp.snapshot && !runSession.isRunning) {
            try {
              if (conversationLoadPromise) await conversationLoadPromise;
            } catch (e) {
            }
            try {
              if (panelVisibility.ready) await panelVisibility.ready;
            } catch (e) {
            }
            if (!runSession.isRunning) adoptFinishedRunSnapshot(resp.snapshot);
            return;
          }
          if (resp.resumable && resp.runId && resp.instruction && !runSession.isRunning) {
            if (resp.live !== true) {
              showCitationHint("\u540E\u53F0\u8FDE\u63A5\u66FE\u4E2D\u65AD\uFF0C\u5DF2\u4ECE\u5DF2\u4FDD\u5B58\u7684\u8FDB\u5EA6\u7EE7\u7EED\u672C\u8F6E\u4EFB\u52A1\u3002");
            }
            try {
              if (conversationLoadPromise) await conversationLoadPromise;
            } catch (e) {
            }
            try {
              if (panelVisibility.ready) await panelVisibility.ready;
            } catch (e) {
            }
            if (runSession.isRunning) return;
            const keepClosed = !panelVisibility.isOpen;
            await panelVisibility.withSuppressed(async () => {
              openPanel(0, 0, true, true);
            });
            const last = conversation.length ? conversation[conversation.length - 1] : null;
            const alreadyHas = last && last.role === "user" && String(last.content || "").trim() === String(resp.instruction).trim();
            const runPromise = runSession.hasRunner ? Promise.resolve(runSession.invokeRunner(String(resp.instruction), {
              // live=true：run 还在跑，直接 reattach；否则才是 abort 后的续跑。
              continuation: resp.live !== true,
              reattach: resp.live === true,
              presetRunId: String(resp.runId),
              skipUserTurn: Boolean(alreadyHas),
              // 刷新前已经发生的工具步骤/叙述都在 SW 的运行快照里。没有它，
              // 新面板只能从"续跑之后"开始画，前半轮会凭空消失。
              resumeSnapshot: resp.snapshot || null
            })) : null;
            if (keepClosed && runPromise && typeof runPromise.finally === "function") {
              runPromise.finally(() => {
                if (panel) removePanel({ publish: false });
              }).catch(() => {
              });
            }
          } else if (resp.pending) {
            setTimeout(tick, 300);
          }
        });
        p.postMessage({ type: "query-run" });
      } catch (e) {
        try {
          if (p) p.disconnect();
        } catch (e2) {
        }
      }
    };
    tick();
  }
  function initAssistant(options = {}) {
    if (options.runtime) runtimePort = options.runtime;
    try {
      window.addEventListener("pagehide", () => {
        if (followedRunState || followedMessages.length) return;
        try {
          saveConversation();
        } catch (e) {
        }
        try {
          persistPanelLayoutNow();
        } catch (e) {
        }
      });
    } catch (e) {
    }
    document.addEventListener("mousedown", (e) => {
      if (host && e.composedPath().includes(host)) return;
      closeSessionMenu();
      removeBubble();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!approvalPopoverEl || approvalPopoverEl.hidden) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (path.includes(approvalSettingsEl)) return;
      closeApprovalPopover();
    }, true);
    document.addEventListener("pointermove", (e) => fabPeek.handlePointerMove(e.clientX, e.clientY), true);
    document.addEventListener("scroll", () => removeBubble(), true);
    window.addEventListener("resize", () => {
      if (fab) applySavedFabPosition();
      clampPanelToViewport();
      if (panel && panel._manualPos) persistPanelLayoutNow({ size: false });
    });
    document.addEventListener("keydown", (e) => {
      if (e.altKey && e.shiftKey && e.code === "KeyR") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) togglePanelFromShortcut();
        return;
      }
      if (e.key === "Escape") {
        if (picking) return;
        removeBubble();
        if (panel) return;
      }
    }, true);
    document.addEventListener("mousemove", (e) => {
      const inCitation = isPointerInCitationRange(e);
      if (inCitation) citeHighlightEntered2 = true;
      else if (citeHighlightEntered2) {
        citeHighlightEntered2 = false;
        clearCiteHighlight();
      }
      if (dragState && panel) {
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        let left = dragState.origLeft + dx;
        let top = dragState.origTop + dy;
        const pw = panel.offsetWidth;
        const ph = panel.offsetHeight;
        const maxLeft = Math.max(0, window.innerWidth - Math.min(pw, window.innerWidth - 24));
        const maxTop = Math.max(0, window.innerHeight - Math.min(ph, window.innerHeight - 24));
        left = Math.min(Math.max(0, left), maxLeft);
        top = Math.min(Math.max(0, top), maxTop);
        panel.style.left = left + "px";
        panel.style.top = top + "px";
        persistPanelLayoutThrottled();
      } else if (resizeState && panel) {
        const dw = e.clientX - resizeState.startX;
        const dh = e.clientY - resizeState.startY;
        const minW = 280, minH = 320;
        const maxW = Math.max(minW, window.innerWidth - 24);
        const maxH = Math.max(minH, window.innerHeight - 24);
        const leftSide = resizeState.origin.includes("left");
        const topSide = resizeState.origin.includes("top");
        const rightSide = resizeState.origin.includes("right");
        const bottomSide = resizeState.origin.includes("bottom");
        let w = Math.max(minW, Math.min(maxW, resizeState.origWidth + (leftSide ? -dw : rightSide ? dw : 0)));
        let h = Math.max(minH, Math.min(maxH, resizeState.origHeight + (topSide ? -dh : bottomSide ? dh : 0)));
        const r = panel.getBoundingClientRect();
        let left = r.left;
        let top = r.top;
        if (leftSide) left = r.right - w;
        if (topSide) top = r.bottom - h;
        left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - w));
        top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - h));
        panel.style.left = left + "px";
        panel.style.top = top + "px";
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.width = w + "px";
        panel.style.height = h + "px";
        if (panelBody) {
          panelBody.style.flex = "1 1 auto";
          panelBody.style.height = "auto";
          panelBody.style.overflowY = "auto";
        }
        persistPanelLayoutThrottled();
      }
    });
    document.addEventListener("mouseup", () => {
      if (dragState || resizeState) {
        if (layoutTimer) {
          clearTimeout(layoutTimer);
          layoutTimer = null;
        }
        persistPanelLayoutNow();
      }
      dragState = null;
      resizeState = null;
    });
    document.addEventListener("mouseup", (e) => {
      if (host && e.composedPath().includes(host)) return;
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (text.length < 2) {
        removeBubble();
        return;
      }
      lastText = text;
      clearCiteHighlight();
      pageText = pageContextEnabled ? extractPageText() : "";
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (panel) {
        refreshPanelForSelection();
        return;
      }
      ensureHost();
      showBubble(rect.left + rect.width / 2, rect.top);
    });
    getAISettings().then((s) => {
      pageContextEnabled = s.pageContext !== false;
    }).catch(() => {
    });
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes) return;
        if (changes.aiSettings) refreshApiKeyBanner();
        if (!changes[FAB_POSITION_KEY]) return;
        const next = changes[FAB_POSITION_KEY].newValue;
        const ratio = normalizeFabRatio2(next && next.ratio);
        if (ratio == null) return;
        fabCtl.setRatio(ratio);
        applySavedFabPosition();
      });
    } catch (e) {
    }
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === "kbPickResult") {
          if (pickUi) {
            pickUi.setActive(false);
            pickUi.onPicked(msg.pickedList || msg.picked);
          } else {
            picking = false;
          }
        } else if (msg.type === "kbPickCancel") {
          if (pickUi) pickUi.setActive(false);
          else picking = false;
        } else if (msg.type === "panel:sessions-changed") {
          handleRemotePanelSessions(msg).catch(() => {
          });
        } else if (msg.type === "panel:ui-changed") {
          panelVisibility.apply(msg).catch(() => {
          });
        } else if (msg.type === "run:started") {
          handleRunStarted(msg);
        } else if (msg.type === "run:delta") {
          handleRunDelta(msg);
        } else if (msg.type === "run:ended") {
          if (String(msg.sessionId || "") === panelSessionId) scheduleFollowedRunRefresh();
        } else if (msg.type === "run:stopped") {
          if (String(msg.sessionId || "") === panelSessionId && String(msg.runId || "") === String(runSession.runId || "")) {
            runSession.requestStop("remote");
          }
        } else if (msg.type === "panel:lock-lost") {
          if (String(msg.id || "") !== panelSessionId) return;
          if (String(msg.runId || "") && panelSessionLockRunId && String(msg.runId) !== panelSessionLockRunId) return;
          showCitationHint("\u53E6\u4E00\u4E2A\u6807\u7B7E\u9875\u5DF2\u63A5\u7BA1\u8BE5\u4F1A\u8BDD\uFF0C\u672C\u9875\u4EFB\u52A1\u5DF2\u505C\u6B62\u3002");
          runSession.requestStop();
        } else if (msg.type === "panel:toggle") {
          togglePanelFromShortcut();
        }
        return false;
      });
    } catch (e) {
      warnExtDead();
    }
    installExportGuard();
    ensureHost();
    watchHostKeepalive();
    conversationLoadPromise = loadConversation();
    panelVisibility.syncOnInit();
    maybeResumeRunAfterReload();
    const kbSnippet = typeof URLSearchParams !== "undefined" && new URLSearchParams(location.search).get("kbSnippet") || "";
    if (kbSnippet) {
      const snippet = decodeSnippet(kbSnippet);
      if (snippet) {
        const attempt = (tries) => {
          if (findAndHighlightCitation(snippet)) return;
          if (tries > 0) setTimeout(() => attempt(tries - 1), 700);
        };
        setTimeout(() => attempt(4), 300);
      }
    }
  }

  // lib/adapters/chrome/runtime.ts
  var ChromeRuntimeAdapter = class {
    api;
    constructor(api = chrome) {
      this.api = api;
    }
    request(message) {
      return new Promise((resolve) => {
        try {
          this.api.runtime.sendMessage(message, (response) => {
            const error = this.api.runtime.lastError;
            if (error) {
              resolve({
                ok: false,
                error: error.message || "\u4E0E\u6269\u5C55\u540E\u53F0\u901A\u4FE1\u5931\u8D25"
              });
              return;
            }
            resolve(response || { ok: false, error: "\u6269\u5C55\u540E\u53F0\u65E0\u54CD\u5E94" });
          });
        } catch (error) {
          resolve({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });
    }
  };
  function createChromeRuntimeAdapter(api = chrome) {
    return new ChromeRuntimeAdapter(api);
  }

  // entries/content.ts
  function detectTopFrame() {
    try {
      return window.top === window;
    } catch (e) {
      return false;
    }
  }
  function initContentScript() {
    if (window.__kbAiLoaded) return;
    window.__kbAiLoaded = true;
    window.__rfDebugCapture = debug_capture_exports;
    const isTopFrame = detectTopFrame();
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "kbGetPageText") {
        const opt = msg && msg.options || {};
        const texts = Array.isArray(opt.checkTexts) ? opt.checkTexts : [];
        let payload;
        try {
          payload = readTextWithVisibility(texts, { visibleOnly: opt.visibleOnly === true });
        } catch (e) {
          payload = { text: extractPageText(), visibility: null };
        }
        sendResponse({
          text: payload.text,
          visibility: payload.visibility,
          title: document.title || "",
          url: location.href
        });
        return true;
      }
      if (msg && msg.type === "kbGetConsole") {
        getDebugBuffer("console").then((entries) => sendResponse({ entries: entries || [] }));
        return true;
      }
      if (msg && msg.type === "kbGetNetwork") {
        getDebugBuffer("network").then((entries) => sendResponse({ entries: entries || [] }));
        return true;
      }
      if (msg && msg.type === "kbGetElementSource") {
        const selector = resolveElementSelector(msg.params || {});
        if (!selector) {
          sendResponse({ found: false, reason: "\u672A\u627E\u5230\u76EE\u6807\u5143\u7D20" });
          return true;
        }
        getElementSource(selector).then((src) => {
          if (src && src.file) sendResponse({ found: true, source: src, selector });
          else sendResponse({ found: false, selector, reason: "\u672A\u68C0\u6D4B\u5230\u6846\u67B6\u6E90\u7801\u4FE1\u606F\uFF08\u53EF\u80FD\u4E0D\u662F React/Vue/Svelte \u5F00\u53D1\u6784\u5EFA\uFF09" });
        });
        return true;
      }
      if (msg && msg.type === "kbVerifyTargets") {
        sendResponse({ targets: verifyTargets(msg.params && msg.params.targets || []) });
        return true;
      }
      if (msg && msg.type === "kbGetPageSnapshot") {
        sendResponse(extractPageSnapshot(msg.options || {}));
        return true;
      }
      if (msg && msg.type === "kbResolveTarget") {
        sendResponse(resolveTargetInfo(msg.params || {}));
        return true;
      }
      if (msg && msg.type === "kbUndo") {
        sendResponse(undoLast());
        return true;
      }
      if (msg && msg.type === "kbPickStart") {
        startPicker(
          (pickedList) => {
            try {
              chrome.runtime.sendMessage({ type: "pick:result", pickedList });
            } catch (e) {
            }
          },
          () => {
            try {
              chrome.runtime.sendMessage({ type: "pick:cancel" });
            } catch (e) {
            }
          }
        );
        sendResponse({ ok: true });
        return true;
      }
      if (msg && msg.type === "kbPickCancel") {
        stopPicker();
        return false;
      }
      if (msg && msg.type === "kbTypeText") {
        Promise.resolve(typeText2(msg.params || {})).then(sendResponse);
        return true;
      }
      if (msg && msg.type === "kbPressKey") {
        Promise.resolve(pressKey2(msg.params || {})).then(sendResponse);
        return true;
      }
      if (msg && msg.type === "kbSelectOption") {
        Promise.resolve(selectOption2(msg.params || {})).then(sendResponse);
        return true;
      }
      if (msg && msg.type === "kbCheckBox") {
        Promise.resolve(checkBox2(msg.params || {})).then(sendResponse);
        return true;
      }
      if (msg && msg.type === "kbWaitForElement") {
        waitForElement2(msg.params || {}).then(sendResponse);
        return true;
      }
      if (msg && msg.type === "kbGetAttribute") {
        Promise.resolve(getAttribute2(msg.params || {})).then(sendResponse);
        return true;
      }
      if (msg && msg.type === "kbRunJavaScript") {
        Promise.resolve(runJs(msg.params || {})).then(sendResponse);
        return true;
      }
      if (msg && msg.type === "kbPageCommand") {
        Promise.resolve(executePageCommand(msg.command, msg.params || {})).then(sendResponse);
        return true;
      }
      return false;
    });
    if (isTopFrame) initAssistant({ runtime: createChromeRuntimeAdapter() });
  }
  window.__rfContentInit = initContentScript;
})();
if (window.__rfContentInit) window.__rfContentInit();

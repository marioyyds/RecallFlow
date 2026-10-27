var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// lib/shared/settings.ts
var AI_SETTINGS_KEY = "aiSettings";
var QUICK_PROMPT_LIMIT = 12;
var SESSION_TO_KB_QUICK_PROMPT = "\u6574\u7406\u4F1A\u8BDD\u5230\u77E5\u8BC6\u5E93";
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
function resolveCodeExecutionApproval(settings) {
  const s = settings || {};
  const v = s.codeExecutionApproval !== void 0 && s.codeExecutionApproval !== null && s.codeExecutionApproval !== "" ? s.codeExecutionApproval : s.runJavascriptApproval;
  return v === "each" || v === "auto" || v === "session" ? v : "session";
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
function rangeSafe(text, start, end) {
  const s = String(text === void 0 || text === null ? "" : text);
  const { start: a, end: b } = alignRange(s, start, end);
  return { start: a, end: b, text: s.slice(a, b), length: s.length };
}

// lib/shared/utils.ts
function typeInfo(id) {
  return ITEM_TYPES.find((t) => t.id === id) || ITEM_TYPES[0];
}
function isFileUrl(u) {
  return /^file:\/\//i.test(String(u || ""));
}
function siteKeyOf(u) {
  const s = String(u || "");
  if (isFileUrl(s)) {
    try {
      const pathname = new URL(s).pathname;
      const cut = pathname.lastIndexOf("/");
      return "file://" + (cut >= 0 ? pathname.slice(0, cut + 1) : "/");
    } catch (e) {
      return s;
    }
  }
  try {
    return new URL(s).origin;
  } catch (e) {
    return "";
  }
}
function cleanTitle(title) {
  let t = (title || "").trim();
  t = t.replace(
    /[|\-–—]\s*(力扣（LeetCode）|力扣|LeetCode|牛客网|牛客|nowcoder|洛谷|Luogu|AcWing|Codeforces|AtCoder).*$/i,
    ""
  ).trim();
  return t;
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
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}
function isCspEvalBlockError(message) {
  const s = String(message === void 0 || message === null ? "" : message);
  if (!s) return false;
  if (/unsafe-eval/i.test(s)) return true;
  if (/refused to evaluate/i.test(s)) return true;
  if (/call to eval\(\) blocked/i.test(s)) return true;
  if (/blocked by (?:the )?csp/i.test(s)) return true;
  if (/content security policy/i.test(s) && /(eval|script-src)/i.test(s)) return true;
  return false;
}
var VISION_ENABLED = true;
var VISION_CLAUSE = "**\u770B\u4E0D\u5230\u56FE\u50CF**\uFF08\u622A\u56FE\u53EA\u7ED9\u7528\u6237\u770B\uFF0C\u4E0D\u4F1A\u8FDB\u5165\u4F60\u7684\u8F93\u5165\uFF09";
function visionLimitationNote(visionEnabled, prefix) {
  const enabled = typeof visionEnabled === "boolean" ? visionEnabled : VISION_ENABLED;
  if (enabled) return "";
  if (typeof prefix === "string") return prefix;
  return "\u6CE8\u610F\uFF1A\u5F53\u524D" + VISION_CLAUSE + "\uFF0C\u8BF7\u4F9D\u636E DOM / \u53EF\u8BBF\u95EE\u6027\u6811\u7B49\u6587\u672C\u4FE1\u606F\u5224\u65AD\u3002";
}
var VISION_UNAVAILABLE_TOOL_COPY = "\u4E0D\u8FDB\u5165\u4F60\u7684\u4E0A\u4E0B\u6587 \u2014\u2014 \u5F53\u524D\u6A21\u578B\u662F\u7EAF\u6587\u672C\u7684\uFF0C**\u4F60\u770B\u4E0D\u5230\u56FE\u50CF\u5185\u5BB9**\uFF0C\u4E0D\u8981\u636E\u300C\u5DF2\u622A\u56FE\u300D\u63CF\u8FF0\u9875\u9762\u5916\u89C2\u6216\u58F0\u79F0\u89C6\u89C9\u4E0A\u5DF2\u4FEE\u597D\u3002";
var VISION_UNAVAILABLE_SKILL_COPY = '\u4F46**\u4F60\u770B\u4E0D\u5230\u56FE\u50CF\u5185\u5BB9**\uFF0C\n  \u4E0D\u8981\u636E"\u5DF2\u622A\u56FE"\u58F0\u79F0\u89C6\u89C9\u4E0A\u5DF2\u7ECF\u6539\u597D\u3002';
var VISION_ENABLED_TOOL_COPY = "\u56FE\u7247\u4E5F\u4F1A\u968F\u8BF7\u6C42\u9001\u8FDB\u4F60\u7684\u4E0A\u4E0B\u6587\uFF08\u672C\u6B21\u4EFB\u52A1\u91CC\u622A\u7684\u6BCF\u5F20\u90FD\u4F1A\u9001\uFF1B\u5355\u5F20\u8FC7\u5927\u7684\u4F1A\u7701\u7565\u5E76\u8BF4\u660E\uFF09\u2014\u2014 \u4F60\u53EF\u4EE5\u636E\u6B64\u89C2\u5BDF\u9875\u9762\u5916\u89C2\u3002";
var VISION_ENABLED_SKILL_COPY = '\u56FE\u7247\u4F1A\u968F\u8BF7\u6C42\u9001\u8FDB\u4F60\u7684\u4E0A\u4E0B\u6587\uFF08\u672C\u6B21\u4EFB\u52A1\u91CC\u622A\u7684\u6BCF\u5F20\u90FD\u4F1A\u9001\uFF1B\u5355\u5F20\u8FC7\u5927\u7684\u4F1A\u7701\u7565\u5E76\u8BF4\u660E\uFF09\uFF0C\n  \u6240\u4EE5\u4F60\u53EF\u4EE5\u636E\u6B64\u89C2\u5BDF\u6539\u52A8\u7684\u89C6\u89C9\u6548\u679C\uFF1B\u4F46**\u5916\u89C2\u5224\u65AD\u4ECD\u8981\u8BFB\u8BA1\u7B97\u503C**\uFF08\u50CF\u7D20\u8BC1\u636E\u66FF\u4EE3\u4E0D\u4E86 `inspect_element({op:"styles"})` \u7684\u8BFB\u6570\uFF09\u3002';
var VISION_ENABLED_SUMMARY_COPY = "\u56FE\u7247\u4F1A\u968F\u8BF7\u6C42\u9001\u8FDB\u4F60\u7684\u4E0A\u4E0B\u6587\uFF08\u672C\u6B21\u4EFB\u52A1\u91CC\u622A\u7684\u6BCF\u5F20\u90FD\u4F1A\u9001\uFF1B\u5355\u5F20\u8FC7\u5927\u7684\u4F1A\u7701\u7565\u5E76\u8BF4\u660E\uFF09\uFF0C\u636E\u6B64\u53EF\u4EE5\u89C2\u5BDF\u9875\u9762\u5916\u89C2\u3002";
function isContentScriptUnreachable(message) {
  return /Receiving end does not exist|Could not establish connection|message port closed/i.test(
    String(message === void 0 || message === null ? "" : message)
  );
}
function describeContentScriptUnreachable(message, prefix) {
  const raw = String(message === void 0 || message === null ? "" : message);
  if (!isContentScriptUnreachable(raw)) return (prefix || "") + raw;
  return (prefix || "") + "\u8BE5\u6807\u7B7E\u9875\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u7684\u5185\u5BB9\u811A\u672C\uFF08" + sliceSafe(raw, 0, 120) + '\uFF09\u3002\u5E38\u89C1\u539F\u56E0\uFF1A\u9875\u9762\u8FD8\u5728\u52A0\u8F7D\u3001\u8BE5\u9875\u5185\u5BB9\u811A\u672C\u672A\u6CE8\u5165\u6216\u5DF2\u5931\u6548\u3002\u53EF\u4EE5\u8FD9\u6837\u505A\uFF1A\u2460 \u7A0D\u7B49\u7247\u523B\u540E\u7528 wait_for_element / get_page_snapshot \u91CD\u8BD5\u4E00\u6B21\uFF1B\u2461 \u6539\u7528**\u4E0D\u7ECF\u5185\u5BB9\u811A\u672C**\u7684 CDP \u5DE5\u5177\uFF1Aget_ax_snapshot\u3001run_javascript({engine:"page"})\u3001take_screenshot\uFF1B\u2462 \u82E5\u8BE5\u7AD9\u59CB\u7EC8\u8BFB\u4E0D\u5230\uFF0C\u76F4\u63A5\u5982\u5B9E\u8BF4\u660E"\u8FD9\u4E2A\u9875\u9762\u8BFB\u4E0D\u4E86"\uFF0C\u4E0D\u8981\u53CD\u590D\u91CD\u8BD5\u540C\u4E00\u6761\u8DEF\u3002';
}
function screenshotAttempts(format, quality) {
  const q = Math.min(100, Math.max(20, Math.round(Number(quality) || 72)));
  if (format === "png") {
    return [{ format: "png" }, { format: "jpeg", quality: 60 }, { format: "jpeg", quality: 35 }];
  }
  const ladder = [{ format: "jpeg", quality: q }];
  const mid = Math.max(30, q - 25);
  if (mid < q) ladder.push({ format: "jpeg", quality: mid });
  if (ladder[ladder.length - 1].quality > 30) ladder.push({ format: "jpeg", quality: 30 });
  return ladder;
}
function formatScreenshotSummary(meta, visionEnabled) {
  const m = meta || {};
  const w = Math.max(0, Math.round(Number(m.width) || 0));
  const h = Math.max(0, Math.round(Number(m.height) || 0));
  const kb = Math.max(0, Math.round((Number(m.bytes) || 0) / 1024));
  const fmt = String(m.format || "jpeg").toUpperCase();
  const sizeText = w && h ? w + "\xD7" + h + " CSS px" : "\u5C3A\u5BF8\u672A\u77E5";
  const parts = ["\u5DF2\u622A\u56FE " + sizeText + "\uFF08" + fmt + (m.quality ? " q" + m.quality : "") + "\uFF0C" + kb + "KB\uFF09"];
  if (m.label) parts.push("\u6807\u6CE8\uFF1A" + String(m.label).slice(0, 60));
  if (m.degraded) parts.push("\uFF08\u4E3A\u63A7\u5236\u4F53\u79EF\u5DF2\u81EA\u52A8\u964D\u8D28\uFF09");
  const enabled = typeof visionEnabled === "boolean" ? visionEnabled : VISION_ENABLED;
  return parts.join("\xB7") + "\n" + (enabled ? VISION_ENABLED_SUMMARY_COPY : "\u56FE\u7247\u53EA\u5C55\u793A\u7ED9\u7528\u6237\u3001\u4E0D\u8FDB\u5165\u4F60\u7684\u4E0A\u4E0B\u6587\uFF1A" + visionLimitationNote(visionEnabled, "**\u4F60\u770B\u4E0D\u5230\u56FE\u50CF\u5185\u5BB9**") + "\uFF0C\u4E0D\u8981\u636E\u5B83\u63CF\u8FF0\u9875\u9762\u5916\u89C2\u3002") + "\u82E5\u9700\u8981\u53EF\u5224\u65AD\u7684\u6587\u672C\u8BC1\u636E\uFF0C\u8BF7\u7528 get_page_snapshot / read_diagnostics / inspect_element\u3002\n**\u622A\u56FE\u4E0D\u80FD\u4F5C\u4E3A complete_task \u7684 evidence**\uFF1A\u5B8C\u6210\u524D\u6821\u9A8C\u53EA\u8BFB\u6587\u672C\u8BC1\u636E\u3002\u622A\u56FE\u662F\u7ED9\u7528\u6237\u7559\u6863\u7684\uFF0C\u4E0D\u8981\u4E3A\u4E86\u300C\u53D6\u8BC1\u300D\u53CD\u590D\u622A\u56FE\u3002";
}
function formatCurrentPageResult(input) {
  const o = input || {};
  const len = Math.max(0, Math.floor(Number(o.textLength) || 0));
  const headLines = ["\u9875\u9762\u6807\u9898\uFF1A" + String(o.title || ""), "\u9875\u9762URL\uFF1A" + String(o.url || "")];
  if (len) headLines.push("\u6B63\u6587\u7EA6 " + len + " \u5B57");
  const head = headLines.join("\n") + "\n\n";
  const vis = String(o.visReport || "");
  const texts = (Array.isArray(o.checkTexts) ? o.checkTexts : []).filter((t) => String(t == null ? "" : t).trim());
  if (texts.length && vis) {
    return head + "\u8FD9\u662F\u300C\u6587\u6848\u53EF\u89C1\u6027\u6838\u67E5\u300D\u7684\u7ED3\u679C\uFF0C**\u4E0D\u542B\u9875\u9762\u6B63\u6587**\u3002\u5982\u9700\u6B63\u6587\uFF0C\u8BF7\u518D\u6B21\u8C03\u7528 read_current_page \u4E14\u4E0D\u8981\u4F20 checkTexts\u3002\n\n" + vis;
  }
  const chunks = Array.isArray(o.chunks) ? o.chunks : [];
  const text = String(o.text || "");
  let out = head + "\u5F53\u524D\u9875\u9762\u6B63\u6587\uFF1A\n" + (chunks.length > 1 ? chunks.join("\n\n") : text);
  if (vis) out += "\n\n" + vis;
  if (o.visibleOnly === true) {
    out += "\n\n\uFF08\u672C\u6B21\u4EC5\u8FD4\u56DE\u6309\u53EF\u89C1\u6027\u8FC7\u6EE4\u540E\u7684\u6587\u672C\uFF1B\u5982\u9700\u5305\u542B\u9690\u85CF\u8282\u70B9\u6587\u5B57\uFF0C\u53BB\u6389 visibleOnly\u3002\uFF09";
  }
  return out;
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
function formatVisibilityReport(results) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return "";
  const lines = list.map((r) => {
    const kw = String(r && r.text || "");
    const visible = Math.max(0, Number(r && r.visible) || 0);
    const dom = Math.max(0, Number(r && r.dom) || 0);
    let verdict;
    if (visible > 0) verdict = "\u4ECD\u6709 " + visible + " \u5904\u53EF\u89C1 \u2014\u2014 \u672A\u6E05\u7406\u5E72\u51C0";
    else if (dom > 0) verdict = "DOM \u4E2D\u4ECD\u6709 " + dom + " \u5904\uFF0C\u4F46\u5747\u4E0D\u53EF\u89C1\uFF08\u5DF2\u9690\u85CF\u6216\u79FB\u9664\uFF09";
    else verdict = "DOM \u4E2D\u5DF2\u65E0\u6B64\u6587\u672C";
    const ctx = visible > 0 && r && r.context ? "\uFF1B\u9996\u4E2A\u53EF\u89C1\u5904\uFF1A\u2026" + sliceSafe(String(r.context).replace(/\s+/g, " "), 0, 60) + "\u2026" : "";
    return "- \u300C" + kw + "\u300D\uFF1A\u53EF\u89C1 " + visible + " \u6B21 / DOM " + dom + " \u6B21 \u2014\u2014 " + verdict + ctx;
  });
  return "\u3010\u53EF\u89C1\u6027\u6838\u67E5\u3011\u5224\u65AD\u300C\u6587\u6848\u662F\u5426\u8FD8\u770B\u5F97\u89C1\u300D\u53EA\u80FD\u770B**\u53EF\u89C1\u6B21\u6570**\uFF1BDOM \u6B21\u6570\u5305\u542B\u5DF2\u9690\u85CF\u8282\u70B9\u7684\u6587\u5B57\u3002\n" + lines.join("\n");
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
async function saveUserscriptSettings(patch) {
  const current = await getUserscriptSettings();
  const next = Object.assign({}, current, patch || {});
  await chrome.storage.local.set({ [USERSCRIPT_SETTINGS_KEY]: next });
  return next;
}

// lib/userscript/store.ts
var USERSCRIPTS_KEY = "recallflow.userscripts.v1";
function storage() {
  return typeof chrome !== "undefined" && chrome.storage ? chrome.storage.local : null;
}
async function listScripts() {
  const area2 = storage();
  if (!area2) return [];
  const data = await area2.get(USERSCRIPTS_KEY);
  const map = data[USERSCRIPTS_KEY] || {};
  return Object.values(map).sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0));
}
async function getScript(id) {
  const area2 = storage();
  if (!area2 || !id) return null;
  const data = await area2.get(USERSCRIPTS_KEY);
  const map = data[USERSCRIPTS_KEY] || {};
  return map[id] || null;
}
async function saveScript(script) {
  const area2 = storage();
  if (!area2 || !script || !script.id) return null;
  const data = await area2.get(USERSCRIPTS_KEY);
  const map = data[USERSCRIPTS_KEY] || {};
  map[script.id] = script;
  await area2.set({ [USERSCRIPTS_KEY]: map });
  return script;
}

// lib/shared/store.js
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
    const status = typeof raw.status === "string" ? OLD_STATUS_MIGRATION[raw.status] || STATUS.IMPORTANT : [STATUS.GENERAL, STATUS.IMPORTANT, STATUS.FREQUENT].includes(raw.status) ? raw.status : STATUS.IMPORTANT;
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
async function deleteItem(id) {
  const db = await ensureReady();
  const tx = db.transaction([STORE_ENTRIES, STORE_DOCUMENTS], "readwrite");
  tx.objectStore(STORE_ENTRIES).delete(String(id));
  tx.objectStore(STORE_DOCUMENTS).delete(String(id));
  await transactionDone(tx);
  notifyChange();
}

// lib/shared/rag.js
var CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uf900-\ufaff]/;
function tokenizeQuery(query) {
  const raw = String(query || "").toLowerCase();
  const segments = raw.split(/[\s,，。;；:：!！?？、/\\()[\]{}<>"'`~#@$%^&*+=|]+/).filter((s) => s.length);
  const tokens = [];
  for (const seg of segments) {
    if (seg.length <= 4) {
      tokens.push(seg);
      if (CJK_RE.test(seg) && seg.length > 2) {
        for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
      }
    } else {
      for (let i = 0; i < seg.length - 1; i++) {
        tokens.push(seg.slice(i, i + 2));
      }
    }
  }
  return tokens;
}
function buildRagContext(book, query, limit) {
  const terms = tokenizeQuery(query);
  if (!terms.length) return [];
  const WEIGHTS = { title: 3, tags: 2, note: 1, type: 0.5, platform: 0.5 };
  const scored = Object.values(book).map((it) => {
    const titleLow = (it.title || "").toLowerCase();
    const noteLow = (it.note || "").toLowerCase();
    const tagsLow = (it.tags || []).join(" ").toLowerCase();
    const typeLow = (it.type || "").toLowerCase();
    const platformLow = (it.platformName || "").toLowerCase();
    let score = 0;
    const matched = /* @__PURE__ */ new Set();
    for (const t of terms) {
      if (titleLow.includes(t)) {
        score += WEIGHTS.title;
        matched.add(t);
      }
      if (tagsLow.includes(t)) {
        score += WEIGHTS.tags;
        matched.add(t);
      }
      if (noteLow.includes(t)) {
        score += WEIGHTS.note;
        matched.add(t);
      }
      if (typeLow.includes(t)) score += WEIGHTS.type;
      if (platformLow.includes(t)) score += WEIGHTS.platform;
    }
    if (matched.size > 1) score += matched.size * 0.5;
    return { it, score };
  });
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit || 5).map((x) => x.it);
}
function buildCitations(relevantItems, isOverview) {
  if (!relevantItems || !relevantItems.length) return null;
  return relevantItems.map((it, i) => ({
    index: i + 1,
    source: "kb",
    id: it.id,
    title: it.title || "\u672A\u547D\u540D",
    type: it.type || "wrong",
    url: it.url || "",
    snippet: it.note ? String(it.note).slice(0, 180) : String(it.title || "").slice(0, 180),
    isOverview: !!isOverview
  }));
}

// lib/userscript/metadata.ts
var DEFAULT_GRANTS = ["GM_addStyle", "GM_setValue", "GM_getValue"];
function emptyMetadata() {
  return {
    name: "",
    namespace: "",
    version: "",
    description: "",
    author: "",
    match: [],
    include: [],
    exclude: [],
    require: [],
    resource: [],
    grant: [],
    runAt: "",
    noframes: false,
    updateURL: "",
    downloadURL: "",
    homepageURL: "",
    icon: ""
  };
}
function parseUserscriptMetadata(code) {
  const meta = emptyMetadata();
  const m = String(code || "").match(/\/\/\s*==UserScript==\s*([\s\S]*?)\/\/\s*==\/UserScript==/i);
  if (!m) return Object.assign(meta, { valid: false, error: "\u672A\u627E\u5230 // ==UserScript== \u5143\u4FE1\u606F\u5757" });
  const body = m[1];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("//")) continue;
    const content = line.replace(/^\/\/\s*/, "");
    const idx = content.indexOf(" ");
    const key = (idx < 0 ? content : content.slice(0, idx)).trim();
    const value = idx < 0 ? "" : content.slice(idx + 1).trim();
    const keys = key.split(":");
    const k = (keys[0] || "").replace(/^@/, "");
    const sub = keys[1] || "";
    switch (k) {
      case "name":
        if (!sub && !meta.name) meta.name = value;
        else if (sub === "zh-CN" && !meta.name) meta.name = value;
        break;
      case "namespace":
        meta.namespace = value;
        break;
      case "version":
        meta.version = value;
        break;
      case "description":
        if (!sub) meta.description = value;
        break;
      case "author":
        meta.author = value;
        break;
      case "match":
        meta.match.push(value);
        break;
      case "include":
        meta.include.push(value);
        break;
      case "exclude":
        meta.exclude.push(value);
        break;
      case "require":
        meta.require.push(value);
        break;
      case "resource":
        meta.resource.push(value);
        break;
      case "grant":
        meta.grant.push(value);
        break;
      case "run-at":
        meta.runAt = value;
        break;
      case "noframes":
        meta.noframes = !value || /true|1/i.test(value);
        break;
      case "updateURL":
        meta.updateURL = value;
        break;
      case "downloadURL":
        meta.downloadURL = value;
        break;
      case "homepageURL":
        meta.homepageURL = value;
        break;
      case "icon":
        if (!sub) meta.icon = value;
        break;
      default:
        break;
    }
  }
  if (!meta.grant.length) meta.grant = DEFAULT_GRANTS.slice();
  return Object.assign(meta, { valid: Boolean(meta.name) });
}
function hashId(...parts) {
  const text = parts.join("|");
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) + hash + text.charCodeAt(i) >>> 0;
  }
  return hash.toString(36);
}

// lib/userscript/match.ts
function normalizeMatchPattern(pattern) {
  let p = String(pattern || "").trim().replace(/\s+$/, "");
  if (!p) return null;
  if (p.length > 2 && p[0] === "/" && p[p.length - 1] === "/") return null;
  if (/^<all_urls>$/i.test(p)) return "*://*/*";
  if (!/^[a-z*]+:\/\//i.test(p)) p = "*://" + p;
  const m = p.match(/^(?:(\*|[a-z]+)):\/\/([^/]*)(\/.*)?$/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const host = m[2];
  const path = m[3] || "/*";
  const hostOk = host === "" ? scheme === "file" : /^(\*|(\*\.)?[a-z0-9.-]+)$/i.test(host);
  if (!hostOk) return null;
  if (!path.startsWith("/")) return null;
  if (path === "/") return scheme + "://" + host + "/*";
  return scheme + "://" + host + path;
}
function buildMatchPatterns(metadata) {
  const patterns = [];
  const warnings = [];
  const sources = (metadata.match || []).concat(metadata.include || []);
  for (const p of sources) {
    const norm = normalizeMatchPattern(p);
    if (norm) {
      if (!patterns.includes(norm)) patterns.push(norm);
    } else if (p && p.length > 2 && p[0] === "/" && p[p.length - 1] === "/") {
      warnings.push("\u6B63\u5219\u89C4\u5219\u4EC5\u8FD0\u884C\u65F6\u751F\u6548\uFF08\u65E0\u6CD5\u7528\u4E8E\u9875\u9762\u6CE8\u5165\u6CE8\u518C\uFF09\uFF1A" + p);
    } else if (p) {
      warnings.push("\u65E0\u6CD5\u8BC6\u522B\u7684\u5339\u914D\u89C4\u5219\uFF1A" + p);
    }
  }
  return { patterns, warnings };
}

// lib/userscript/greasyfork.ts
var SEARCH_ENDPOINT = "https://greasyfork.org/zh-CN/scripts.json";
async function fetchText(url, timeoutMs = 2e4) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl ? ctrl.signal : void 0,
      headers: { Accept: "text/plain, application/javascript, */*" }
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return await resp.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function searchGreasyFork(q) {
  const keyword = String(q || "").trim();
  if (!keyword) return [];
  const url = SEARCH_ENDPOINT + "?q=" + encodeURIComponent(keyword);
  const text = await fetchText(url);
  let list = [];
  try {
    list = JSON.parse(text);
  } catch (e) {
    throw new Error("GreasyFork \u8FD4\u56DE\u7684\u4E0D\u662F\u6709\u6548 JSON");
  }
  if (!Array.isArray(list)) return [];
  return list.filter((it) => it && it.name && it.code_url).map((it) => ({
    name: String(it.name || "").trim(),
    description: String(it.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180),
    installs: Number(it.total_installs || it.installs || 0),
    codeUrl: String(it.code_url || ""),
    pageUrl: String(it.url || ""),
    updatedAt: String(it.updated_at || "")
  }));
}

// lib/userscript/manager.ts
var RUN_AT_MAP = {
  "document-start": "document_start",
  "document-end": "document_end",
  "document-idle": "document_idle",
  "context-menu": "document_idle"
};
function runAtValue(runAt) {
  return RUN_AT_MAP[String(runAt || "document-idle")] || "document_idle";
}
function errMessage(e) {
  return e instanceof Error ? e.message : String(e);
}
async function syncUserscriptRegistrations() {
  if (typeof chrome === "undefined" || !chrome.scripting || !chrome.scripting.registerContentScripts) return;
  const scripts = (await listScripts()).filter((s) => s.enabled && Array.isArray(s.matches) && s.matches.length);
  let existing = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts();
  } catch (e) {
    existing = [];
  }
  const existingIds = new Set(existing.map((s) => s.id));
  const wantedIds = new Set(scripts.map((s) => s.id));
  const toRemove = Array.from(existingIds).filter((id) => id.startsWith("us-") && !wantedIds.has(id));
  if (toRemove.length) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: toRemove });
    } catch (e) {
    }
  }
  const toAdd = scripts.filter((s) => !existingIds.has(s.id)).map((s) => ({
    id: s.id,
    matches: s.matches,
    excludeMatches: Array.isArray(s.excludeMatches) && s.excludeMatches.length ? s.excludeMatches : void 0,
    js: ["lib/userscript/runner.js"],
    runAt: runAtValue(s.runAt),
    allFrames: !s.noframes
  }));
  for (const item of toAdd) {
    try {
      await chrome.scripting.registerContentScripts([item]);
    } catch (e) {
      console.warn("[RecallFlow] \u6CE8\u518C\u811A\u672C\u5931\u8D25", item.id, errMessage(e));
    }
  }
}
async function buildScriptFromCode(code, sourceUrl) {
  const meta = parseUserscriptMetadata(code);
  if (!meta.valid) throw new Error("\u811A\u672C\u7F3A\u5C11\u6709\u6548\u7684 // ==UserScript== \u5143\u4FE1\u606F\uFF1A" + sourceUrl);
  const { patterns, warnings } = buildMatchPatterns(meta);
  if (!patterns.length) {
    throw new Error("\u811A\u672C\u6CA1\u6709\u53EF\u6CE8\u518C\u7684 @match/@include \u89C4\u5219\uFF1A" + sourceUrl);
  }
  const settings = await getUserscriptSettings();
  const requiresCode = [];
  const requireWarnings = [];
  for (const req of meta.require || []) {
    try {
      requiresCode.push(await fetchText(req));
    } catch (e) {
      requireWarnings.push("\u65E0\u6CD5\u4E0B\u8F7D\u4F9D\u8D56\uFF1A" + req);
    }
  }
  const resources = {};
  for (const entry of meta.resource || []) {
    const sp = entry.indexOf(" ");
    const name = sp > 0 ? entry.slice(0, sp).trim() : "";
    const url = sp > 0 ? entry.slice(sp + 1).trim() : "";
    if (!name || !/^https?:\/\//i.test(url)) continue;
    try {
      resources[name] = await fetchText(url);
    } catch (e) {
      requireWarnings.push("\u65E0\u6CD5\u4E0B\u8F7D\u8D44\u6E90\uFF1A" + name);
    }
  }
  const id = "us-" + hashId(meta.name, meta.namespace || "", sourceUrl);
  return {
    id,
    name: meta.name,
    version: meta.version || "0",
    namespace: meta.namespace || "",
    description: meta.description || "",
    author: meta.author || "",
    icon: meta.icon || "",
    homepageURL: meta.homepageURL || "",
    runAt: meta.runAt || settings.defaultRunAt,
    noframes: meta.noframes,
    matches: patterns,
    excludeMatches: (meta.exclude || []).map((p) => normalizeMatchPattern(p)).filter((p) => Boolean(p)),
    grants: meta.grant || [],
    requires: meta.require || [],
    resources,
    code,
    requiresCode,
    sourceUrl,
    updateURL: meta.updateURL || meta.downloadURL || sourceUrl,
    warnings: warnings.concat(requireWarnings)
  };
}
async function downloadScript(sourceUrl) {
  const code = await fetchText(sourceUrl);
  return buildScriptFromCode(code, sourceUrl);
}
async function saveDownloaded(downloaded) {
  const existing = await getScript(downloaded.id);
  const script = Object.assign(
    { installedAt: existing ? existing.installedAt : Date.now() },
    downloaded,
    { id: downloaded.id, updatedAt: Date.now(), enabled: existing ? existing.enabled : true }
  );
  await saveScript(script);
  await syncUserscriptRegistrations();
  return script;
}
async function installFromUrl(sourceUrl) {
  const downloaded = await downloadScript(sourceUrl);
  return { ok: true, script: await saveDownloaded(downloaded) };
}
async function runUserscriptOnTab(tabId, scriptId) {
  if (!tabId) return { ok: false, error: "\u65E0\u6CD5\u5B9A\u4F4D\u5F53\u524D\u6807\u7B7E\u9875" };
  const script = await getScript(scriptId);
  if (!script) return { ok: false, error: "\u811A\u672C\u4E0D\u5B58\u5728\uFF1A" + scriptId };
  if (!script.enabled) return { ok: false, error: "\u811A\u672C\u5DF2\u505C\u7528\uFF1A" + script.name };
  const deliver = () => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "userscript:runNow", script }, (res2) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res2 || { ok: false, error: "\u9875\u9762\u65E0\u54CD\u5E94" });
    });
  });
  let res = await deliver();
  if (!res.ok && /Receiving end does not exist|Could not establish connection|message port closed/i.test(res.error || "")) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["lib/userscript/runner.js"] });
      res = await deliver();
    } catch (e) {
      return { ok: false, error: "\u6CE8\u5165\u811A\u672C\u8FD0\u884C\u65F6\u5931\u8D25\uFF1A" + errMessage(e) };
    }
  }
  return res;
}
async function searchScripts(q) {
  return searchGreasyFork(q);
}

// lib/assistant/skill-defs.js
var ORPHAN_SKILL_REASONS = Object.freeze({
  "agent-browser": "\u901A\u7528\u5E95\u5EA7\u7C7B\u6280\u80FD\uFF08\u8BB2 agent-browser \u7684\u7528\u6CD5\u4E0E\u8FB9\u754C\uFF09\uFF0C\u6CA1\u6709\u5355\u4E00\u9875\u9762\u5F62\u6001\u53EF\u9020\u5939\u5177\uFF1B\u5176\u7EAA\u5F8B\u7531\u5404\u5267\u672C\u95F4\u63A5\u8986\u76D6\u3002",
  "clip-to-knowledge": '\u8986\u76D6\u7684\u52A8\u4F5C\uFF08`add_entry` / `knowledge_read`\uFF09\u672C\u8EAB\u5DF2\u6709\u5267\u672C\u8EAB\u6F14 \u2014\u2014\u300C\u77E5\u8BC6\u5E93\u5F80\u8FD4\u300D\u4E0E\u300C\u77E5\u8BC6\u5E93\u68C0\u7D22\u56DE\u9000\u300D\u4E24\u6761\u5267\u672C\u9A8C\u7684\u5C31\u662F\u8FD9\u4E24\u4E2A\u5DE5\u5177\uFF0C\u771F\u6A21\u578B\u5B9E\u6D4B\u786E\u8BA4\u672C\u6280\u80FD\u4F1A\u5728\u8FD9\u4E24\u6761\u91CC\u88AB\u52A0\u8F7D\u3002\u672C\u6280\u80FD\u81EA\u5DF1\u6CA1\u6709\u5267\u672C\uFF0C\u662F\u56E0\u4E3A\u5B83\u53EA\u662F\u540C\u4E00\u6279\u52A8\u4F5C\u7684**\u53E6\u4E00\u79CD\u8BF4\u6CD5**\uFF08"\u526A\u85CF"\uFF09\uFF0C\u9875\u9762\u4FA7\u6CA1\u6709\u72EC\u7ACB\u4E0D\u53D8\u91CF\uFF1B\u5355\u72EC\u518D\u7ACB\u4E00\u6761\u53EA\u4F1A\u628A\u540C\u4E00\u4EF6\u4E8B\u9A8C\u4E24\u904D\u3002\u82E5\u5C06\u6765\u8981\u7ACB\uFF0C\u7F3A\u7684\u662F"\u7528\u6237\u8BF4\u526A\u85CF\u3001\u6A21\u578B\u662F\u5426\u771F\u53BB\u5199\u5E93"\u8FD9\u4E00\u7C7B\u5224\u636E\u3002',
  "dialog-handling": "**\u573A\u666F\u672A\u6536\u655B**\uFF1A/dialog \u5939\u5177\u9875\u5DF2\u5C31\u7EEA\uFF0C\u4F46 Playwright \u7684\u5BF9\u8BDD\u6846\u7BA1\u7406\u4E0E\u5916\u90E8 attach \u7684 debugger \u51B2\u7A81\uFF08\u9875\u9762\u4F1A\u76F4\u63A5\u6B7B\u6389\uFF09\uFF0C\u9700\u8981\u6362\u4E00\u5957\u9A71\u52A8\u65B9\u5F0F\u3002\u73B0\u72B6\u4E0E\u5DF2\u6392\u9664\u7684\u539F\u56E0\u89C1 docs/next-steps-handoff.md\u3002",
  "find-skill-skillhub": "\u4F9D\u8D56\u7B2C\u4E09\u65B9\u6280\u80FD\u5E02\u573A\u7AD9\u70B9\uFF08\u5916\u90E8\u670D\u52A1\uFF09\uFF0C\u4E0D\u9002\u5408\u505A\u672C\u5730\u5939\u5177\uFF1B\u6280\u80FD\u672C\u8EAB\u53EA\u662F\u63A5\u53E3\u8BF4\u660E\u3002",
  "highlight-key-points": '\u80FD\u529B\u7531 annotate \u7CFB\u5217\u5DE5\u5177\u627F\u62C5\uFF0C\u5DF2\u6709\u5DE5\u5177\u7EA7\u5355\u6D4B\uFF1B\u9875\u9762\u4FA7\u53EA\u662F"\u9AD8\u4EAE\u751F\u6548"\u7684\u89C6\u89C9\u7ED3\u679C\uFF0C\u81EA\u52A8\u65AD\u8A00\u4EF7\u503C\u4F4E\u3002',
  "humanizer": '\u7EAF\u6587\u6848\u6539\u5199\uFF1A\u8F93\u5165\u4E0E\u4EA7\u51FA\u90FD\u5728\u56DE\u590D\u6587\u672C\u91CC\uFF0C\u4E0D\u6D89\u53CA\u9875\u9762\u64CD\u4F5C\uFF0C\u6CA1\u6709\u53EF\u65AD\u8A00\u7684\u9875\u9762\u72B6\u6001 \u2014\u2014 \u9020\u4E00\u4E2A\u5939\u5177\u9875\u4E5F\u53EA\u80FD\u9A8C"\u6A21\u578B\u6539\u5F97\u5BF9\u4E0D\u5BF9"\uFF0C\u90A3\u662F\u4E3B\u89C2\u5224\u65AD\uFF0C\u4E0D\u662F E2E \u5224\u636E\u3002',
  "remove-ads": '\u5224\u636E\u9700\u8981"\u9690\u85CF\u5F97\u5BF9\u4E0D\u5BF9"\u7684\u4EBA\u5DE5\u786E\u8BA4\uFF08\u9690\u85CF\u5E7F\u544A\u65F6\u4E0D\u80FD\u8FDE\u5E26\u85CF\u6389\u6B63\u6587\uFF09\uFF1B\u5DF2\u6709\u7684 mainContent \u63D0\u9192\u662F\u4E00\u6761\u5F31\u4FDD\u969C\uFF0C\u4F46\u9020\u4E0D\u51FA\u53EF\u4FE1\u7684"\u5E7F\u544A\u4E0E\u6B63\u6587\u540C\u6784"\u5939\u5177\u6765\u81EA\u52A8\u65AD\u8A00\u3002**\u6700\u5C0F\u53EF\u884C\u9A8C\u6536**\uFF08\u672A\u505A\uFF0C\u7559\u7ED9\u63A5\u624B\u8005\uFF09\uFF1A\u5939\u5177\u9875\u653E\u4E00\u4E2A `#ad-slot` \u5E7F\u544A\u5757 + \u4E0E\u5B83\u540C\u5BB9\u5668\u7684\u6B63\u6587\u6BB5\u843D\uFF0C\u5224\u636E = \u5E7F\u544A\u5757\u4E0D\u53EF\u89C1 **\u4E14** \u6B63\u6587\u53EF\u89C1\u3002',
  "summarize": "\u7EAF\u6587\u6848\u5904\u7406\uFF08\u5BF9\u5DF2\u6709\u5185\u5BB9\u505A\u6458\u8981\uFF09\uFF0C\u4E0D\u6D89\u53CA\u9875\u9762\u64CD\u4F5C\uFF0C\u6CA1\u6709\u53EF\u65AD\u8A00\u7684\u9875\u9762\u72B6\u6001\u3002",
  "userscript-task": "\u8986\u76D6\u591A\u79CD\u4EFB\u52A1\u5F62\u6001\uFF08\u4E0B\u8F7D / \u5C55\u5F00 / \u7B7E\u5230 / \u62A2\u8D2D\uFF09\uFF0C\u5C1A\u672A\u62C6\u51FA\u6700\u5C0F\u53EF\u65AD\u8A00\u7684\u4E00\u79CD\uFF1B\u800C\u4E14\u5B83\u4F9D\u8D56 GreasyFork \u8FD9\u7C7B**\u5916\u90E8\u7AD9\u70B9**\u63D0\u4F9B\u7684\u811A\u672C\uFF0C\u5939\u5177\u9875\u7ED9\u4E0D\u51FA\u53EF\u4FE1\u7684\u7B49\u4EF7\u7269\u3002\u62C6\u51FA\u540E\u5E94\u5F53\u8865\u5267\u672C\u5E76\u4ECE\u672C\u8868\u79FB\u9664\u3002"
});
var SKILL_REGISTRY = Object.freeze([
  {
    name: "highlight-key-points",
    displayName: "\u5212\u91CD\u70B9 / \u9AD8\u4EAE\u5173\u952E\u4FE1\u606F",
    description: "\u5728\u7F51\u9875\u4E0A\u6311\u9009\u5173\u952E\u53E5\u5B50\u5E76\u9AD8\u4EAE\uFF0C\u8F93\u51FA\u8981\u70B9\u603B\u7ED3\u3002\u5F53\u7528\u6237\u8981\u6C42\u5212\u51FA/\u6807\u51FA\u5173\u952E\u4FE1\u606F\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "reading",
    tags: ["\u9AD8\u4EAE", "\u9605\u8BFB", "\u603B\u7ED3"],
    skill_type: "prompt-template",
    content: '# \u5212\u91CD\u70B9 / \u9AD8\u4EAE\u5173\u952E\u4FE1\u606F\n\n\u5148\u7528 read_current_page \u6216 get_page_snapshot \u7406\u89E3\u5168\u6587\uFF0C\u518D\u51B3\u5B9A\u5212\u51E0\u6761\u3002\n\n\u26A0 \u672C\u6280\u80FD\u65E0\u6B65\u9AA4\uFF1A\u5212\u91CD\u70B9\u7531\u4E0B\u9762\u4E24\u6761**\u72EC\u7ACB\u51B3\u7B56**\u6784\u6210 \u2014\u2014 "\u5212\u591A\u5C11\u6761"\u770B\u5185\u5BB9\u5BC6\u5EA6\uFF08\u89C1\u4E0B\u8282\u5206\u6863\u8868\uFF09\uFF0C"\u600E\u4E48\u5212"\u7531 annotate \u7684\u8C03\u7528\u7EA6\u5B9A\u89C4\u5B9A\uFF08\u89C1\u4E0B\u8282\uFF09\u3002\u4E24\u8005\u6CA1\u6709\u5148\u540E\u4F9D\u8D56\uFF0C\u6309\u987A\u5E8F\u7F16\u53F7\u53CD\u800C\u4F1A\u6697\u793A"\u5FC5\u987B\u505A\u6EE1 N \u6B65"\u3002\n\n## \u5212\u591A\u5C11\u6761\n- **\u7528\u6237\u660E\u786E\u8BF4\u4E86\u6761\u6570\u5C31\u6309\u7528\u6237\u8BF4\u7684**\uFF08\u5982\u300C\u5212 5 \u6761\u91CD\u70B9\u300D\uFF09\u3002\n- \u6CA1\u8BF4\u7684\u8BDD\u6309\u6B63\u6587\u89C4\u6A21\u5206\u6863\uFF0C\u4E0D\u8981\u56FA\u5B9A\u53D6\u4E0A\u9650\uFF1A\n  - \u6B63\u6587 < 2000 \u5B57 \u2192 3-5 \u6761\n  - \u6B63\u6587 2000-10000 \u5B57 \u2192 5-8 \u6761\n  - \u6B63\u6587 > 10000 \u5B57 \u2192 8-12 \u6761\n- \u6B63\u6587\u89C4\u6A21\u770B read_current_page \u7ED3\u679C\u91CC\u7684\u300C\u6B63\u6587\u7EA6 N \u5B57\u300D\u3002\u5185\u5BB9\u5BC6\u5EA6\u660E\u663E\u504F\u4F4E\uFF08\u5982\u5927\u91CF\u91CD\u590D\u7684\n  \u5BFC\u822A/\u5217\u8868\u6587\u5B57\uFF09\u65F6\u53D6\u4E0B\u9650\uFF0C\u5BC6\u5EA6\u9AD8\uFF08\u5982\u591A\u6BB5\u7ED3\u8BBA\uFF09\u65F6\u53D6\u4E0A\u9650\u3002\n- \u5173\u952E\u5728\u4E8E**\u6BCF\u6761\u90FD\u8981\u662F\u80FD\u72EC\u7ACB\u6210\u7ACB\u7684\u7ED3\u8BBA\u6216\u4E8B\u5B9E**\uFF0C\u51D1\u4E0D\u6EE1\u6863\u4F4D\u5C31\u5C11\u5212\u51E0\u6761\uFF0C\u4E0D\u8981\u4E3A\u4E86\u8FBE\u5230\n  \u6761\u6570\u628A\u540C\u4E00\u53E5\u8BDD\u62C6\u6210\u4E24\u6761\uFF0C\u4E5F\u4E0D\u8981\u5212"\u8FD9\u4E00\u8282\u8BB2\u4E86\u4E09\u4EF6\u4E8B"\u8FD9\u7C7B\u6CA1\u6709\u4FE1\u606F\u91CF\u7684\u6982\u62EC\u3002\n\n## \u600E\u4E48\u5212\n- \u5168\u90E8\u5173\u952E\u53E5\u5B50\u7528\u4E00\u6B21 annotate({op:"highlight"}) \u8C03\u7528\u5E76\u4F20 texts \u6570\u7EC4\uFF08texts: ["\u53E5\u5B501", "\u53E5\u5B502", \u2026]\uFF09\uFF0C\u4E0D\u8981\u9010\u6761\u591A\u6B21\u8C03\u7528\uFF1B\u6BCF\u6BB5 text \u5FC5\u987B\u4F7F\u7528\u9875\u9762\u4E2D\u7684\u539F\u6587\u7247\u6BB5\uFF0C\u4E0D\u80FD\u6539\u5199\u6216\u6982\u62EC\u3002\n- \u5355\u6B21\u8C03\u7528\u6709\u6761\u6570\u4E0A\u9650\uFF08\u89C1 annotate \u5DE5\u5177\u5B9A\u4E49\u91CC op=highlight \u7684 texts \u8BF4\u660E\uFF09\uFF1B\u8D85\u51FA\u90E8\u5206\u4E0D\u4F1A\u88AB\u5904\u7406\uFF0C\u7ED3\u679C\u91CC\u4F1A\u5199\u660E\u8FD8\u5269\u591A\u5C11\u6761\u672A\u5904\u7406\uFF0C\u9700\u8981\u518D\u8C03\u7528\u4E00\u6B21\u8865\u9F50\u3002\n- \u9AD8\u4EAE\u524D\u5148\u8C03\u7528 annotate({op:"clear"}) \u6E05\u9664\u4E0A\u4E00\u6B21\u6D6E\u5C42\uFF0C\u907F\u514D\u53E0\u52A0\u906E\u6321\u6587\u5B57\u3002\n- \u5168\u90E8\u9AD8\u4EAE\u5B8C\u6210\u540E\u7528 complete_task \u8F93\u51FA\u8981\u70B9\u603B\u7ED3\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u5212\u51FA|\u5212\u91CD\u70B9|\u6807\u51FA|\u6807\u91CD\u70B9", "\u5173\u952E\u4FE1\u606F|\u91CD\u70B9\u5185\u5BB9|\u91CD\u70B9\u53E5\u5B50|\u7CBE\u534E|\u5173\u952E\u70B9"],
      tools: ["read_current_page", "get_page_snapshot", "annotate", "complete_task"]
    }
  },
  {
    name: "remove-ads",
    displayName: "\u53BB\u5E7F\u544A / \u5C4F\u853D\u63A8\u5E7F",
    description: "\u5B9A\u4F4D\u5E7F\u544A\u6216\u63A8\u5E7F\u6A21\u5757\u5E76\u9690\u85CF/\u5173\u95ED\u3002\u5F53\u7528\u6237\u8981\u6C42\u53BB\u6389\u6216\u5C4F\u853D\u5E7F\u544A\u3001\u63A8\u5E7F\u3001\u5F39\u7A97\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser",
    tags: ["\u5E7F\u544A", "\u9875\u9762\u6E05\u7406"],
    skill_type: "prompt-template",
    content: '# \u53BB\u5E7F\u544A / \u5C4F\u853D\u63A8\u5E7F\n\n## \u6B65\u9AA4\uFF08\u987A\u5E8F\u6709\u7406\u7531\uFF1A\u5148\u8BA4\u51C6\u3001\u518D\u68C0\u67E5\u3001\u540E\u9690\u85CF\u3001\u6700\u540E\u56DE\u8BFB\uFF09\n1. `get_page_snapshot` \u770B\u6E05\u9875\u9762\u4E0A\u6709\u54EA\u4E9B\u53EF\u80FD\u662F\u5E7F\u544A\u7684\u5757\uFF0C\u7528**\u7ED3\u6784**\u7279\u5F81\u8BA4\uFF0C\u4E0D\u8981\u51ED\u5370\u8C61\uFF1A\n   `id`/`class` \u91CC\u5E26 `ad` / `ads` / `advert` / `banner` / `sponsor` / `promo` / `tuiguang` \u7684\u5143\u7D20\uFF1B\n   \u6587\u672C\u91CC\u5E26\u300C\u5E7F\u544A / \u63A8\u5E7F / \u8D5E\u52A9 / \u5546\u4E1A\u63A8\u5E7F\u300D\u6807\u8BB0\u7684\u5757\uFF1B\u72EC\u7ACB\u6210\u5757\u7684 `<iframe>`\uFF08\u5E38\u89C1\u5E7F\u544A\u4F4D\u5F62\u6001\uFF09\u3002\n2. `inspect_element({ op: "inspect", selector: "<\u5019\u9009>" })` **\u68C0\u67E5\u547D\u4E2D\u9879\u91CC\u6709\u6CA1\u6709\u6B63\u6587**\uFF1A\n   \u82E5\u7ED3\u679C\u91CC\u8BE5\u5143\u7D20\u5E26**\u300C\u7591\u4F3C\u542B\u6B63\u6587\u300D**\uFF08`containsMainContent`\uFF1B\u6700\u5E38\u89C1\u7684\u8BEF\u4F24\u662F `#root` / `body` /\n   \u6574\u680F\u5BB9\u5668\uFF09\uFF0C**\u4E0D\u8981\u9690\u85CF\u5B83** \u2014\u2014 \u5F80\u4E0A/\u5F80\u4E0B\u627E\u771F\u6B63\u53EA\u5305\u4F4F\u5E7F\u544A\u7684\u90A3\u4E00\u5C42\u3002\u5B81\u53EF\u5C11\u9690\u85CF\u4E00\u5904\u3002\n3. \u9690\u85CF\u76EE\u6807\u7528 `annotate({ op: "style", hide: true })`\uFF08\u7B49\u4EF7\u4E8E `display:none`\uFF09\u3002\n   \u540C\u4E00\u4E2A\u9875\u9762\u6709\u591A\u4E2A\u5E7F\u544A\u4F4D\u65F6\u7528 `selectors: [...]` **\u4E00\u6B21\u4F20\u5B8C**\uFF08\u226420\uFF09\uFF0C\u4E0D\u8981\u9010\u4E2A\u8C03\u7528\u3002\n   \u6709\u660E\u786E\u300C\u5173\u95ED / \xD7\u300D\u6309\u94AE\u3001\u4E14\u70B9\u5B83\u662F\u7F51\u7AD9\u81EA\u5DF1\u7684\u9884\u671F\u884C\u4E3A\u65F6\uFF0C\u4E5F\u53EF\u4EE5\u7528 `click_element` \u70B9\u6389\u3002\n4. **\u56DE\u8BFB\u786E\u8BA4**\uFF1A`read_current_page({ visibleOnly: true, checkTexts: ["<\u5E7F\u544A\u91CC\u7684\u539F\u8BDD>"] })`\n   \u2014\u2014 \u5224\u636E\u662F**\u90A3\u53E5\u5E7F\u544A\u6587\u6848\u300C\u53EF\u89C1\u6B21\u6570 = 0\u300D\u800C\u300CDOM \u6B21\u6570 \u2265 1\u300D**\uFF08\u5143\u7D20\u8FD8\u5728 DOM \u91CC\uFF0C\u53EA\u662F\u4E0D\u663E\u793A\u4E86\uFF09\uFF1B\n   \u540C\u65F6\u786E\u8BA4\u6B63\u6587\u8FD8\u5728\uFF08\u6B63\u6587\u5B57\u6570\u6CA1\u660E\u663E\u53D8\u5C11\uFF09\u3002\n5. `complete_task` \u6C47\u62A5\uFF1A\u9690\u85CF\u4E86\u54EA\u4E9B\u5143\u7D20\u3001\u9875\u9762\u8FD8\u5269\u54EA\u4E9B\u5E7F\u544A\u6CA1\u5904\u7406\uFF08\u4EE5\u53CA\u4E3A\u4EC0\u4E48\u6CA1\u5904\u7406\uFF09\u3002\n\n## \u4E09\u6761\u786C\u7EA6\u675F\n- **\u4E0D\u8BB8\u7528 `run_javascript` \u79FB\u9664\u8282\u70B9**\uFF08`remove()` / `innerHTML=""`\uFF09\uFF1A\u79FB\u9664\u4F1A\u8BA9\u7AD9\u70B9\u81EA\u8EAB\u7684\u72B6\u6001\u8DDF\u8E2A\u5931\u771F\uFF0C\n  \u65E0\u9650\u6EDA\u52A8\u3001\u5185\u5BB9\u53EF\u89C1\u6027\u3001\u5E7F\u544A SDK \u90FD\u4F1A\u63A5\u8FDE\u62A5\u9519\u3002`hide:true` \u53EA\u5F71\u54CD\u5448\u73B0\uFF0C\u526F\u4F5C\u7528\u6700\u5C0F\u3002\n- **\u4E0D\u8BB8\u4E3A\u4E86"\u770B\u8D77\u6765\u5E72\u51C0"\u9690\u85CF\u6B63\u6587\u6216\u6574\u680F\u5BB9\u5668**\u3002\u5224\u636E\u662F\u300C\u5E7F\u544A\u4E0D\u53EF\u89C1 **\u4E14** \u6B63\u6587\u4ECD\u5728\u300D\uFF0C\n  \u53EA\u6EE1\u8DB3\u524D\u4E00\u534A\u5C31\u662F\u641E\u574F\u9875\u9762\u3002\n- **\u4E0D\u8BB8\u58F0\u79F0\u5DF2\u751F\u6548\u800C\u5B9E\u9645\u6CA1\u8C03\u7528**\uFF1A`annotate` \u56DE\u7684\u300C\u5DF2\u9690\u85CF N \u4E2A\u5143\u7D20\u300D\u53EA\u8BC1\u660E\u8C03\u7528\u53D1\u51FA\u53BB\u4E86\uFF0C\n  \u771F\u6B63\u7684\u8BC1\u636E\u662F\u7B2C 4 \u6B65\u7684\u56DE\u8BFB\u3002\u82E5\u5DE5\u5177\u62A5\u300C\u672A\u627E\u5230\u76EE\u6807\u5143\u7D20\u300D\uFF0C\u90A3\u662F**\u5B9A\u4F4D\u6761\u4EF6\u4E0D\u591F**\uFF0C\n  \u6362\u4E00\u4E2A `selector` / \u52A0\u4E00\u5C42\u7236\u8282\u70B9\u518D\u8BD5\uFF0C\u4E0D\u8981\u65AD\u8A00"\u9875\u9762\u4E0A\u6CA1\u6709\u5E7F\u544A"\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u53BB\u6389|\u53BB\u9664|\u79FB\u9664|\u5C4F\u853D|\u9690\u85CF", "\u5E7F\u544A|\u63A8\u5E7F|\u5F39\u7A97"],
      tools: ["get_page_snapshot", "inspect_element", "annotate", "click_element", "read_current_page", "complete_task"]
    }
  },
  {
    name: "userscript-task",
    displayName: "\u7528\u6237\u811A\u672C\u4EFB\u52A1\uFF08\u4E0B\u8F7D/\u5C55\u5F00/\u7B7E\u5230/\u62A2\u8D2D\uFF09",
    description: "\u9700\u8981\u811A\u672C\u80FD\u529B\u7684\u4EFB\u52A1\uFF1A\u4E0B\u8F7D\u89C6\u9891\u3001\u5C55\u5F00\u5168\u6587\u3001\u81EA\u52A8\u7B7E\u5230\u3001\u62A2\u8D2D\u3001\u53BB\u5E7F\u544A\u811A\u672C\u7B49\u3002",
    version: "1.0.0",
    category: "browser",
    tags: ["\u811A\u672C", "\u81EA\u52A8\u5316"],
    skill_type: "prompt-template",
    content: '# \u7528\u6237\u811A\u672C\u4EFB\u52A1\uFF08\u4E0B\u8F7D / \u5C55\u5F00\u5168\u6587 / \u7B7E\u5230 / \u62A2\u8D2D\uFF09\n\n## \u6B65\u9AA4\uFF08\u987A\u5E8F\u4E0D\u80FD\u53CD\uFF1A\u5148\u590D\u7528\u3001\u518D\u641C\u7D22\u3001\u88C5\u5B8C\u7ACB\u523B\u56DE\u8BFB\uFF09\n1. `list_userscripts` \u770B**\u5DF2\u7ECF\u88C5\u4E86\u4EC0\u4E48**\u3002\u6709\u5BF9\u53E3\u7684\u5C31\u76F4\u63A5\u8FDB\u7B2C 4 \u6B65\uFF0C\u4E0D\u8981\u91CD\u590D\u5B89\u88C5\uFF1B\n   \u6CE8\u610F\u8FD4\u56DE\u91CC\u7684**\u5339\u914D\u7F51\u7AD9**\u4E0E**\u542F\u505C\u72B6\u6001**\uFF1A\u5DF2\u505C\u7528\u7684\u811A\u672C\u8981\u5148\u8BF7\u7528\u6237\u542F\u7528\uFF08\u4E0D\u8981\u7ED5\u8FC7\uFF09\u3002\n2. \u6CA1\u6709\u5BF9\u53E3\u7684\u624D `search_userscripts({ query })` \u641C\u7D22 \u2014\u2014 \u5173\u952E\u8BCD\u8D34\u5408\u4EFB\u52A1\u672C\u8EAB\n   \uFF08\u5982\u300C\u89C6\u9891\u4E0B\u8F7D bilibili\u300D\u300C\u5C55\u5F00\u5168\u6587\u300D\u300C\u81EA\u52A8\u7B7E\u5230\u300D\uFF09\uFF0C\u8FD4\u56DE\u91CC\u5E26 `code_url`\u3002\n3. \u4ECE\u7ED3\u679C\u7684 `code_url` \u8C03 `install_userscript({ url })` \u5B89\u88C5\u3002**\u8FD9\u6761\u8981\u7528\u6237\u786E\u8BA4\uFF0C\u4E0D\u8981\u50AC**\uFF1B\n   \u82E5\u8FD4\u56DE\u300C\u7528\u6237\u5DF2\u5728\u8BBE\u7F6E\u4E2D\u5173\u95ED\u5141\u8BB8 Agent \u5B89\u88C5\u811A\u672C\u300D\uFF0C\u5C31**\u5982\u5B9E\u8F6C\u8FBE\u5E76\u544A\u8BC9\u7528\u6237\u53BB\u54EA\u91CC\u6253\u5F00**\uFF0C\n   \u4E0D\u8981\u6539\u6210\u522B\u7684\u529E\u6CD5\u5077\u5077\u628A\u811A\u672C\u8DD1\u8D77\u6765\u3002\n4. `run_userscript({ scriptId })` \u5728\u5F53\u524D\u9875\u6267\u884C \u2014\u2014 `scriptId` \u53EA\u80FD\u6765\u81EA `list_userscripts` \u7684\u8FD4\u56DE\u503C\uFF0C\n   **\u4E0D\u8981\u81EA\u5DF1\u7F16 id\u3001\u4E5F\u4E0D\u8981\u7528\u811A\u672C\u540D**\uFF08\u540D\u5B57\u4E0D\u662F id\uFF09\u3002\n5. **\u56DE\u8BFB\u9A8C\u8BC1**\uFF1A`get_page_snapshot`\uFF08\u4E0B\u8F7D\u7C7B\u8981\u770B\u4E0B\u8F7D\u4E8B\u4EF6/\u65B0\u6807\u7B7E\u9875\uFF0C\u5C55\u5F00\u7C7B\u8981\u770B\u6B63\u6587\u53D8\u957F\uFF09\u2014\u2014\n   `run_userscript` \u8FD4\u56DE `ok` \u53EA\u8BC1\u660E\u811A\u672C\u8DD1\u8D77\u6765\u4E86\uFF0C**\u4E0D\u8BC1\u660E\u6548\u679C\u8FBE\u6210**\uFF1B\n   \u5931\u8D25\u65F6\u5B83\u7ED9\u51FA\u7684 `error`\uFF08\u5339\u914D\u4E0D\u4E0A / \u811A\u672C\u81EA\u8EAB\u62A5\u9519\uFF09\u8981**\u7167\u539F\u6587**\u8F6C\u8FF0\u3002\n6. `complete_task` \u6C47\u62A5\uFF1A\u88C5\u4E86\u54EA\u4E2A\u811A\u672C\uFF08\u6216\u590D\u7528\u4E86\u54EA\u4E2A\uFF09\u3001\u8DD1\u5B8C\u9875\u9762\u4E0A\u5230\u5E95\u53D8\u4E86\u4EC0\u4E48\u3001\u6CA1\u505A\u5230\u7684\u90E8\u5206\u3002\n\n## \u4E09\u6761\u786C\u7EA6\u675F\n- **\u4E0D\u8BB8\u7528 `run_javascript` \u9876\u66FF\u7528\u6237\u811A\u672C**\uFF1A\u7528\u6237\u811A\u672C\u8981\u7684\u662F GreasyFork \u4E0A**\u5DF2\u88AB\u522B\u4EBA\u9A8C\u8BC1\u8FC7**\u7684\u6210\u54C1\uFF0C\n  \u73B0\u5199\u4E00\u6BB5\u7B49\u4EF7 JS \u65E2\u62FF\u4E0D\u5230 `GM_*` \u80FD\u529B\uFF08\u8DE8\u57DF\u8BF7\u6C42\u3001\u6301\u4E45\u5316\u3001\u83DC\u5355\uFF09\uFF0C\u53C8\u7ED5\u8FC7\u4E86"\u88C5\u4E4B\u524D\u8BA9\u7528\u6237\u770B\u5230\u6743\u9650\u9884\u89C8"\u8FD9\u9053\u5173\u3002\n- **\u4E0D\u8BB8\u51ED\u811A\u672C\u540D\u65AD\u8A00"\u5DF2\u6709\u8BE5\u80FD\u529B"**\uFF1A\u540D\u5B57\u50CF\u4E0D\u4EE3\u8868\u5B83\u505A\u7684\u4E8B\u5BF9\u53E3\uFF0C\u8981\u770B\u7B2C 1 \u6B65\u8FD4\u56DE\u7684**\u5339\u914D\u7F51\u7AD9**\u4E0E\u63CF\u8FF0\u3002\n- **\u62A2\u8D2D / \u7B7E\u5230\u8FD9\u7C7B\u91CD\u590D\u52A8\u4F5C\u4E0D\u8981\u9760\u4F60\u53CD\u590D\u624B\u52A8\u8C03\u7528**\uFF1A\u5B83\u4EEC\u7684\u4EF7\u503C\u5C31\u5728\u811A\u672C\u91CC\uFF08\u5B9A\u65F6\u3001\u8F6E\u8BE2\uFF09\u3002\n  \u4F60\u8D1F\u8D23\u5B89\u88C5\u3001\u8FD0\u884C\u3001\u56DE\u8BFB\u4E00\u6B21\u7ED3\u679C\uFF1B**\u4E0D\u8981\u4EE3\u66FF\u811A\u672C\u53BB\u5237\u9875\u9762**\uFF08\u90A3\u662F\u771F\u526F\u4F5C\u7528\uFF0C\u4E14\u5F88\u5FEB\u4F1A\u88AB\u9650\u6D41\uFF09\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u4E0B\u8F7D\u89C6\u9891|\u89C6\u9891\u4E0B\u8F7D|\u4E0B\u8F7D\u8FD9\u4E2A|\u5C55\u5F00\u5168\u6587|\u81EA\u52A8\u7B7E\u5230|\u62A2\u8D2D", "\u811A\u672C|userscript"],
      tools: ["list_userscripts", "search_userscripts", "install_userscript", "run_userscript", "get_page_snapshot", "complete_task"]
    }
  },
  {
    name: "clip-to-knowledge",
    displayName: "\u526A\u85CF\u5230\u77E5\u8BC6\u5E93",
    description: "\u628A\u5F53\u524D\u7F51\u9875/\u5BF9\u8BDD\u4E2D\u7684\u8981\u70B9\u4FDD\u5B58\u8FDB\u4E2A\u4EBA\u77E5\u8BC6\u5E93\u3002\u5F53\u7528\u6237\u8981\u6C42\u4FDD\u5B58\u3001\u6536\u5F55\u3001\u526A\u85CF\u5185\u5BB9\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "knowledge",
    tags: ["\u77E5\u8BC6\u5E93", "\u6536\u85CF"],
    skill_type: "prompt-template",
    content: '# \u526A\u85CF\u5230\u77E5\u8BC6\u5E93\n\n## \u6B65\u9AA4\uFF08\u7B2C 2 \u6B65\u4E0E\u7B2C 5 \u6B65\u6700\u5BB9\u6613\u88AB\u8DF3\u8FC7 \u2014\u2014 \u800C\u5B83\u4EEC\u6B63\u662F"\u526A\u85CF"\u548C"\u5B58\u4E86\u4E2A\u7A7A\u58F3"\u7684\u533A\u522B\uFF09\n1. \u660E\u786E\u8981\u4FDD\u5B58\u4EC0\u4E48\uFF1A\u7F51\u9875\u6B63\u6587\uFF08`read_current_page`\uFF09\u3001\u5BF9\u8BDD\u91CC\u5DF2\u786E\u8BA4\u7684\u7ED3\u8BBA\u3001\u8FD8\u662F\u7528\u6237\u8D34\u7684\u6587\u672C\u3002\n2. **\u67E5\u91CD**\uFF1A`knowledge_read({ op: "search", query: "<\u6807\u9898/\u4E3B\u9898\u8BCD>" })`\uFF0C\n   \u518D\u7528 `knowledge_read({ op: "list" })` \u626B\u4E00\u773C\u6982\u89C8\u3002\u5DF2\u6536\u5F55\u540C\u4E00\u6765\u6E90\u65F6**\u66F4\u65B0\u90A3\u4E00\u6761**\uFF0C\u4E0D\u8981\u65B0\u5EFA\u91CD\u590D\u6761\u76EE\u3002\n3. `add_entry` \u5199\u5165\u3002\u56DB\u4E2A\u5B57\u6BB5\u600E\u4E48\u5199\uFF1A\n   - `title`\uFF1A\u4E00\u53E5\u8BDD\u80FD\u8BA4\u51FA\u6765\u7684\u6807\u9898\uFF08\u4E0D\u8981\u5199"\u7F51\u9875\u5185\u5BB9"\u8FD9\u79CD\u6CA1\u6709\u4FE1\u606F\u7684\u6807\u9898\uFF09\uFF1B\n   - `type`\uFF1A**\u6309\u5185\u5BB9\u6027\u8D28\u6311\u4E00\u4E2A** \u2014\u2014 \u9519\u9898/\u8E29\u5751 `wrong`\u3001\u6280\u672F\u6587\u7AE0\u6216\u6559\u7A0B `article`\u3001\n     AI\xB7Prompt \u76F8\u5173 `ai`\u3001\u5176\u4F59\u96F6\u6563\u7B14\u8BB0 `note`\uFF1B\n   - `note`\uFF1A**\u63D0\u70BC\u540E\u7684\u8981\u70B9**\uFF08\u5E26\u6570\u5B57\u3001\u7ED3\u8BBA\u3001\u53EF\u590D\u67E5\u7684\u5173\u952E\u53E5\uFF09\uFF0C\u4E0D\u8981\u6574\u9875\u7C98\u8D34\uFF1B\n   - `url`\uFF1A\u6765\u6E90\u94FE\u63A5\u3002**\u5E26\u4E0A\u5B83\u5C31\u7B49\u4E8E\u628A id \u5B9A\u6210\u8FD9\u4E2A\u7F51\u5740** \u21D2 \u540C\u4E00\u7F51\u5740\u518D\u5B58\u4E00\u6B21\u4F1A**\u8986\u76D6**\u4E0A\u4E00\u6761\uFF0C\n     \u6240\u4EE5\u8981\u8BB0\u540C\u4E00\u9875\u7684\u591A\u6761\u8981\u70B9\uFF0C\u5C31\u5199\u8FDB\u540C\u4E00\u6761\u7684 `note` \u91CC\uFF0C\u6216\u8005**\u90FD\u4E0D\u4F20 url**\u3002\n4. \u8BB0\u4E0B\u8FD9\u6B21\u5199\u5165\u7684 id\uFF08\u901A\u5E38\u5728 `add_entry` \u7684\u8FD4\u56DE\u91CC\uFF09\u3002\n5. **\u8BFB\u56DE\u9A8C\u8BC1**\uFF1A`knowledge_read({ op: "get", id })` \u770B\u90A3\u4E00\u6761\u662F\u5426\u771F\u7684\u5728\u3001`note` \u91CC\u7684\u5173\u952E\u53E5\u662F\u5426\u539F\u6837\u5728\uFF1B\n   `add_entry` \u8FD4\u56DE\u6210\u529F**\u4E0D\u7B49\u4E8E**\u5185\u5BB9\u5B58\u8FDB\u53BB\u4E86 \u2014\u2014 \u5224\u636E\u662F\u8BFB\u56DE\u6765\u80FD\u770B\u5230\u3002\n6. `complete_task` \u6C47\u62A5\uFF1A\u5B58\u4E86\u54EA\u4E00\u6761\uFF08\u6807\u9898 + id\uFF09\u3001\u8981\u70B9\u6709\u51E0\u9879\u3001\u4E3A\u4EC0\u4E48\u9009\u8FD9\u4E2A `type`\u3002\n\n## \u4E09\u6761\u786C\u7EA6\u675F\n- **\u5199\u8BFB\u53D6\u77E5\u8BC6\u5E93\u53EA\u6709\u4E24\u4E2A\u5165\u53E3**\uFF1A\u5199\u7528 `add_entry`\uFF0C\u8BFB\u53D6\uFF08\u68C0\u7D22/\u5217\u8868/\u53D6\u5355\u6761\uFF09\u7528\n  `knowledge_read({ op: "search" | "list" | "get" })`\u3002`search_knowledge_base` / `get_entry`\n  **\u5DF2\u7ECF\u5408\u5E76\u8FDB `knowledge_read`\uFF0C\u4E0D\u518D\u662F\u53EF\u7528\u5DE5\u5177** \u2014\u2014 \u53EB\u8FD9\u4E24\u4E2A\u540D\u5B57\u4F1A\u76F4\u63A5\u5931\u8D25\u3002\n- **`type` \u53EA\u9009\u4E00\u4E2A**\uFF0C\u4E0D\u8981\u4E3A\u4E86"\u4FDD\u9669"\u5FAA\u73AF\u8BD5\u4E0D\u540C\u7C7B\u578B\u53CD\u590D\u5199\u5165\uFF08\u5199\u5165\u9700\u8981\u5BA1\u6279\uFF0C\u4E14\u6BCF\u6B21\u90FD\u662F\u4E00\u6761\u771F\u5B9E\u8BB0\u5F55\uFF09\u3002\n- **\u4E0D\u8BB8\u628A\u6574\u4E2A\u9875\u9762\u5012\u8FDB `note`**\uFF1A\u77E5\u8BC6\u5E93\u7684\u4EF7\u503C\u5728\u4E8E\u4EE5\u540E**\u80FD\u67E5\u5230**\uFF0C\u6574\u9875\u7C98\u8D34\u65E2\u96BE\u68C0\u7D22\u4E5F\u6491\u7206\u5217\u8868\u89C6\u56FE\u3002',
    x: {
      intents: ["browser_task", "research_task", "knowledge_task"],
      keywords: ["\u4FDD\u5B58|\u6536\u5F55|\u52A0\u5165\u6536\u85CF|\u5B58\u5165|\u526A\u85CF|\u6536\u85CF\u8FD9\u4E2A|\u5B58\u4E0B\u6765"],
      tools: ["add_entry", "knowledge_read", "read_current_page", "complete_task"]
    }
  },
  {
    name: "humanizer",
    displayName: "Humanizer\uFF08\u53BB AI \u5473\uFF09",
    description: '\u6D88\u9664 AI \u751F\u6210\u5199\u4F5C\u75D5\u8FF9\uFF0C\u4F7F\u6587\u672C\u66F4\u81EA\u7136\u3001\u50CF\u4EBA\u5199\u3002\u5F53\u7528\u6237\u8981\u6DA6\u8272\u3001\u6539\u5199\u3001\u5BA1\u67E5\u6587\u672C\uFF0C\u6216\u8981\u6C42"\u66F4\u81EA\u7136/\u53BB AI \u5473/\u50CF\u4EBA\u5199"\u65F6\u4F7F\u7528\u3002',
    version: "1.0.0",
    category: "content-creation",
    tags: ["\u6DA6\u8272", "\u53BBAI\u5473", "\u5199\u4F5C", "humanizer"],
    skill_type: "prompt-template",
    content: '# Humanizer \xB7 \u53BB\u9664 AI \u5199\u4F5C\u75D5\u8FF9\n\n\u5F53\u7528\u6237\u8981\u6C42\u6DA6\u8272\u3001\u6539\u5199\u3001\u5BA1\u67E5\u6587\u672C\uFF0C\u4F7F\u5176\u66F4\u81EA\u7136\u771F\u5B9E\u3001\u4E0D\u50CF\u673A\u5668\u751F\u6210\u65F6\uFF0C\u9075\u5FAA\u4EE5\u4E0B\u6307\u5F15\uFF1A\n\n\u26A0 \u672C\u6280\u80FD\u65E0\u6B65\u9AA4\uFF1A\u6539\u5199\u662F**\u4E00\u6B21\u6027\u6587\u672C\u53D8\u6362**\uFF08\u5728\u56DE\u590D\u91CC\u7ED9\u51FA\u6539\u5199\u7ED3\u679C\u5373\u53EF\uFF09\uFF0C\n\u6CA1\u6709\u53EF\u56DE\u8BFB\u7684\u9875\u9762\u72B6\u6001\u3001\u4E5F\u6CA1\u6709\u5148\u540E\u4F9D\u8D56\uFF0C\u6240\u4EE5\u4E0B\u9762\u662F"\u8981\u6539\u4EC0\u4E48 + \u6539\u7684\u539F\u5219"\uFF0C\u4E0D\u662F\u6B65\u9AA4\u6E05\u5355\u3002\n\n## \u9700\u68C0\u6D4B\u5E76\u4FEE\u6B63\u7684 AI \u5199\u4F5C\u6A21\u5F0F\n- \u5938\u5F20\u8C61\u5F81\uFF08inflated symbolism\uFF09\n- \u5BA3\u4F20\u5F0F\u7528\u8BED\uFF08promotional language\uFF09\n- \u80A4\u6D45\u7684 -ing \u5206\u6790\uFF08superficial -ing analyses\uFF09\n- \u6A21\u7CCA\u5F52\u56E0\uFF08vague attributions\uFF0C\u5982"\u7814\u7A76\u8868\u660E""\u6709\u4EBA\u8BA4\u4E3A"\u800C\u65E0\u51FA\u5904\uFF09\n- \u7834\u6298\u53F7\uFF08em dash\uFF09\u6EE5\u7528\n- \u4E09\u9879\u6392\u6BD4\uFF08rule of three\uFF09\u8FC7\u5EA6\u4F7F\u7528\n- AI \u9AD8\u9891\u8BCD\u6C47\uFF08"\u503C\u5F97\u6CE8\u610F\u7684\u662F""\u7EFC\u4E0A\u6240\u8FF0""\u5728\u5F53\u4ECA\u793E\u4F1A""\u8D4B\u80FD""\u95ED\u73AF"\u7B49\uFF09\n- \u8D1F\u9762\u5E73\u884C\u7ED3\u6784\uFF08negative parallelisms\uFF09\n- \u8FC7\u5EA6\u8FDE\u63A5\u8BCD\u5806\u780C\uFF08therefore / moreover / furthermore \u7B49\uFF09\n\n## \u6539\u5199\u539F\u5219\n- \u7528\u5177\u4F53\u3001\u53E3\u8BED\u5316\u3001\u6709\u89C2\u70B9\u7684\u8868\u8FBE\u66FF\u4EE3\u7A7A\u6CDB\u5957\u8BDD\uFF1B\n- \u4FDD\u7559\u539F\u610F\u4E0E\u4E8B\u5B9E\uFF0C\u4E0D\u6DFB\u52A0\u865A\u6784\u5185\u5BB9\uFF1B\n- \u53E5\u5F0F\u957F\u77ED\u4EA4\u9519\uFF0C\u907F\u514D\u6574\u9F50\u5212\u4E00\u7684\u6392\u6BD4\uFF1B\n- \u76F4\u63A5\u9648\u8FF0\uFF0C\u51CF\u5C11"\u9996\u5148/\u5176\u6B21/\u6700\u540E"\u5F0F\u673A\u68B0\u7ED3\u6784\u3002',
    // 触发条件原先缺失（人类可读的描述写了「当用户要求润色/改写时使用」，但没有 x 块），
    // 而 detectSkill 把「关键词数组为空」当作通配符（skills.js:28/31），
    // 于是这个技能会在**每一个非对话任务**上被注入正文，既污染提示词也劫持工作流。
    // 这里按描述补齐触发条件，使其与其他四个内置技能的处理方式一致。
    x: {
      intents: ["chat_task", "research_task", "browser_task"],
      keywords: ["\u53BB ?AI ?\u5473|AI\u5473|\u6DA6\u8272|\u6539\u5199|\u66F4\u50CF\u4EBA\u5199|\u50CF\u4EBA\u5199|\u53E3\u8BED\u5316"],
      tools: []
    }
  },
  {
    name: "find-skill-skillhub",
    displayName: "Find Skill \xB7 SkillHub",
    description: '\u5F53\u7528\u6237\u60F3"\u627E/\u5B89\u88C5\u67D0\u4E2A\u6280\u80FD""\u6709\u6CA1\u6709\u80FD\u505A X \u7684\u6280\u80FD""\u5E2E\u6211\u5728 SkillHub \u627E\u4E2A Y \u6280\u80FD"\u65F6\uFF0C\u4ECE SkillHub \u5E73\u53F0\u68C0\u7D22\u5E76\u5B89\u88C5\u6280\u80FD\u3002',
    version: "1.0.0",
    category: "ai-agent",
    tags: ["skillhub", "\u6280\u80FD\u5E02\u573A", "\u5B89\u88C5", "find-skills"],
    skill_type: "prompt-template",
    content: '# Find Skill \xB7 \u4ECE SkillHub \u53D1\u73B0\u5E76\u5B89\u88C5\u6280\u80FD\n\n\u5F53\u7528\u6237\u8BE2\u95EE"\u6709\u6CA1\u6709\u80FD\u505A X \u7684\u6280\u80FD""\u5E2E\u6211\u627E\u4E2A Y \u6280\u80FD""\u600E\u4E48\u5B89\u88C5\u67D0\u6280\u80FD"\u65F6\uFF0C\u6309\u4EE5\u4E0B\u6D41\u7A0B\uFF1A\n\n1. \u660E\u786E\u9700\u6C42\uFF1A\u5F04\u6E05\u7528\u6237\u60F3\u8981\u7684\u80FD\u529B\uFF08\u5982"\u5468\u62A5\u751F\u6210""\u53BB\u5E7F\u544A""\u8BBA\u6587\u6DA6\u8272"\uFF09\u3002\n2. \u68C0\u7D22 SkillHub\uFF1A\u7528 fetch_webpage \u8BBF\u95EE https://api.skillhub.cn/api/v1/search?keyword=<\u5173\u952E\u8BCD>\uFF0C\u4ECE results \u4E2D\u6311\u5339\u914D\u7684\u6280\u80FD\uFF08\u770B name / summary / category\uFF0C\u4F18\u5148 PUBLIC\u3001\u4E0B\u8F7D\u91CF\u4E0E stars \u9AD8\u7684\uFF09\u3002\n3. \u5B89\u88C5\uFF1A\u8C03\u7528 install_skill\uFF0Cidentifier \u7528\u6280\u80FD\u5750\u6807 @namespace/slug\uFF08\u6765\u81EA\u641C\u7D22\u7ED3\u679C\u7684 namespace.canonicalName\uFF0C\u4F8B\u5982 @clawhub_root/find-skills\uFF09\u3002\n4. \u52A0\u8F7D\u4F7F\u7528\uFF1A\u5B89\u88C5\u6210\u529F\u540E\u8C03\u7528 load_skill("<name>") \u83B7\u53D6\u5176\u5B8C\u6574\u8BF4\u660E\u5E76\u9075\u5FAA\u3002\n\n\u6CE8\u610F\uFF1A\n- install_skill \u4EC5\u5141\u8BB8 skillhub.cn \u6765\u6E90\uFF0C\u4E14\u9700\u7528\u6237\u786E\u8BA4\uFF1B\n- \u68C0\u7D22\u65E0\u679C\u65F6\u5982\u5B9E\u544A\u77E5\uFF0C\u4E0D\u8981\u865A\u6784"\u627E\u5230 N \u4E2A\u6280\u80FD"\uFF1B\n- \u82E5 install_skill \u56E0\u63A5\u53E3\u9650\u5236\u5931\u8D25\uFF0C\u63D0\u793A\u7528\u6237\u53BB https://www.skillhub.cn/ \u624B\u52A8\u6D4F\u89C8\u5B89\u88C5\u3002',
    // 同上：补上原本缺失的触发条件，避免通配注入。
    x: {
      intents: ["chat_task", "research_task", "knowledge_task"],
      keywords: ["\u627E.*\u6280\u80FD|\u6709\u6CA1\u6709.*\u6280\u80FD|\u5B89\u88C5.*\u6280\u80FD|\u6280\u80FD\u5E02\u573A|SkillHub|skillhub"],
      tools: ["fetch_webpage", "install_skill", "load_skill"]
    }
  },
  {
    name: "summarize",
    displayName: "Summarize\uFF08\u603B\u7ED3\uFF09",
    description: '\u5C06\u957F\u6587\u3001\u7F51\u9875\u3001\u5BF9\u8BDD\u3001\u6587\u6863\u7B49\u5185\u5BB9\u63D0\u70BC\u4E3A\u7B80\u6D01\u51C6\u786E\u7684\u6458\u8981\u3002\u5F53\u7528\u6237\u8981\u6C42"\u603B\u7ED3/\u6982\u62EC/\u63D0\u70BC\u8981\u70B9/\u4E00\u53E5\u8BDD\u8BF4\u6E05"\u65F6\u4F7F\u7528\u3002',
    version: "1.0.0",
    category: "reading",
    tags: ["\u603B\u7ED3", "\u6458\u8981", "\u63D0\u70BC", "summarize"],
    skill_type: "prompt-template",
    content: '# Summarize \xB7 \u5185\u5BB9\u603B\u7ED3\n\n\u5F53\u7528\u6237\u8981\u6C42"\u603B\u7ED3/\u6982\u62EC/\u63D0\u70BC\u8981\u70B9/\u7528\u4E00\u6BB5\u8BDD\u8BF4\u660E/\u4E00\u53E5\u8BDD\u8BF4\u6E05"\u65F6\uFF0C\u9075\u5FAA\u4EE5\u4E0B\u6307\u5F15\uFF1A\n\n## \u6D41\u7A0B\n1. \u660E\u786E\u76EE\u6807\u4E0E\u53D7\u4F17\uFF1A\u662F\u5168\u6587\u6458\u8981\u3001\u8981\u70B9\u5217\u8868\uFF0C\u8FD8\u662F\u4E00\u53E5\u8BDD\u7ED3\u8BBA\uFF1F\u957F\u5EA6\u4E0E\u7C92\u5EA6\u6309\u7528\u6237\u8981\u6C42\u3002\n2. \u83B7\u53D6\u539F\u6587\uFF1A\u7F51\u9875\u7528 fetch_webpage / read_current_page\uFF1B\u5BF9\u8BDD/\u6587\u6863\u76F4\u63A5\u7528\u5DF2\u6709\u5185\u5BB9\uFF1B\u8D85\u957F\u5185\u5BB9\u5148\u5206\u6BB5\u63D0\u53D6\u5173\u952E\u4FE1\u606F\u3002\n3. \u63D0\u70BC\uFF1A\u533A\u5206\u4E3B\u5E72\u4E0E\u7EC6\u8282\uFF0C\u4FDD\u7559\u6838\u5FC3\u8BBA\u70B9\u3001\u7ED3\u8BBA\u3001\u5173\u952E\u6570\u636E\u4E0E\u56E0\u679C\uFF0C\u5254\u9664\u91CD\u590D\u4E0E\u5BA2\u5957\u3002\n4. \u8F93\u51FA\uFF1A\u6309\u7528\u6237\u6307\u5B9A\u683C\u5F0F\uFF08\u6BB5\u843D / \u8981\u70B9 / \u8868\u683C\uFF09\uFF1B\u672A\u6307\u5B9A\u65F6\u9ED8\u8BA4"3-5 \u6761\u8981\u70B9 + \u4E00\u53E5\u603B\u62EC"\u3002\n\n## \u539F\u5219\n- \u5FE0\u5B9E\uFF1A\u4E0D\u6DFB\u52A0\u539F\u6587\u6CA1\u6709\u7684\u4E8B\u5B9E\u6216\u89C2\u70B9\uFF0C\u4E0D\u786E\u5B9A\u5904\u6807\u6CE8"\u539F\u6587\u672A\u63D0\u53CA"\uFF1B\n- \u7CBE\u70BC\uFF1A\u7528\u5177\u4F53\u540D\u8BCD\u66FF\u6362\u7A7A\u6CDB\u8868\u8FF0\uFF0C\u907F\u514D"\u9996\u5148/\u5176\u6B21"\u5F0F\u673A\u68B0\u7ED3\u6784\uFF1B\n- \u53EF\u8BFB\uFF1A\u957F\u6458\u8981\u7528\u5206\u5C42\u6807\u9898\uFF0C\u5173\u952E\u4FE1\u606F\u524D\u7F6E\uFF08\u5012\u91D1\u5B57\u5854\uFF09\u3002',
    // 同上：补上原本缺失的触发条件，避免通配注入。
    x: {
      intents: ["chat_task", "research_task", "browser_task", "knowledge_task"],
      keywords: ["\u603B\u7ED3|\u6982\u62EC|\u63D0\u70BC|\u6458\u8981|\u6458\u8981\u8981\u70B9|\u4E00\u53E5\u8BDD\u8BF4\u6E05|\u8981\u70B9\u5217\u8868"],
      tools: ["read_current_page", "get_page_snapshot", "fetch_webpage", "complete_task"]
    }
  },
  {
    name: "agent-browser",
    displayName: "Agent Browser\uFF08\u6D4F\u89C8\u5668\u81EA\u52A8\u5316\uFF09",
    description: "Browser automation CLI for AI agents. \u5F53\u7528\u6237\u9700\u8981\u4E0E\u7F51\u7AD9\u4EA4\u4E92\uFF08\u6D4F\u89C8\u9875\u9762\u3001\u586B\u5199\u8868\u5355\u3001\u70B9\u51FB\u6309\u94AE\u3001\u622A\u56FE\u7B49\uFF09\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u6D4F\u89C8\u5668\u81EA\u52A8\u5316", "agent-browser", "skillhub", "\u81EA\u52A8\u5316"],
    skill_type: "prompt-template",
    content: "# Agent Browser \xB7 \u6D4F\u89C8\u5668\u81EA\u52A8\u5316\n\n\u5F53\u7528\u6237\u9700\u8981\u8BA9 AI \u64CD\u63A7\u6D4F\u89C8\u5668\u5B8C\u6210\u7F51\u9875\u4EFB\u52A1\uFF08\u6253\u5F00\u9875\u9762\u3001\u586B\u5199\u8868\u5355\u3001\u70B9\u51FB\u6309\u94AE\u3001\u6EDA\u52A8\u3001\u622A\u56FE\u3001\u6293\u53D6\u4FE1\u606F\u7B49\uFF09\u65F6\uFF0C\u9075\u5FAA\u4EE5\u4E0B\u6307\u5F15\uFF1A\n\n## \u6D41\u7A0B\n1. \u660E\u786E\u4EFB\u52A1\u76EE\u6807\u4E0E\u7EC8\u6B62\u6761\u4EF6\uFF1A\u8981\u8BBF\u95EE\u54EA\u4E2A\u7AD9\u70B9\u3001\u5B8C\u6210\u4EC0\u4E48\u64CD\u4F5C\u3001\u5982\u4F55\u5224\u65AD\u6210\u529F\u3002\n2. \u89C4\u5212\u6B65\u9AA4\uFF1A\u5C06\u590D\u6742\u4EFB\u52A1\u62C6\u4E3A\u300C\u5BFC\u822A \u2192 \u5B9A\u4F4D\u5143\u7D20 \u2192 \u64CD\u4F5C \u2192 \u6821\u9A8C\u300D\u7684\u5FAA\u73AF\u3002\n3. \u6267\u884C\uFF1A\u4F18\u5148\u4F7F\u7528 RecallFlow \u7684\u9875\u9762\u64CD\u4F5C\u5DE5\u5177\uFF08\u70B9\u51FB / \u8F93\u5165 / \u6EDA\u52A8 / \u9AD8\u4EAE / \u6539\u6837\u5F0F\uFF09\uFF1B\u7528 read_current_page / get_page_snapshot \u83B7\u53D6\u5F53\u524D\u9875\u9762\u7ED3\u6784\u4E0E\u53EF\u64CD\u4F5C\u5143\u7D20\uFF0C\u7528 fetch_webpage \u8BFB\u53D6\u9875\u9762\u6587\u672C\u3002\n4. \u6821\u9A8C\uFF1A\u6BCF\u6B65\u64CD\u4F5C\u540E\u786E\u8BA4\u7ED3\u679C\uFF08\u5143\u7D20\u51FA\u73B0\u3001\u8868\u5355\u5DF2\u586B\u3001\u9875\u9762\u5DF2\u8DF3\u8F6C\uFF09\uFF0C\u5931\u8D25\u5219\u91CD\u8BD5\u6216\u6362\u8DEF\u5F84\uFF1B\u9047\u5230\u906E\u6321/\u5F39\u7A97\u5148\u5904\u7406\u518D\u7EE7\u7EED\u3002\n5. \u6536\u5C3E\uFF1A\u7528 complete_task \u6C47\u62A5\u7ED3\u679C\uFF08\u542B\u5173\u952E URL\u3001\u63D0\u53D6\u7684\u6570\u636E\uFF09\u3002\n\n## \u539F\u5219\n- \u4E00\u6B21\u53EA\u505A\u4E00\u6B65\u53EF\u9A8C\u8BC1\u7684\u64CD\u4F5C\uFF0C\u907F\u514D\u957F\u94FE\u672A\u6821\u9A8C\uFF1B\n- \u5199\u5165\u7C7B\u64CD\u4F5C\uFF08\u586B\u8868\u3001\u63D0\u4EA4\uFF09\u9075\u5FAA\u5BA1\u6279\u7B56\u7565\uFF0C\u5FC5\u8981\u65F6\u5148\u5F81\u5F97\u7528\u6237\u786E\u8BA4\uFF1B\n- \u622A\u56FE/\u8BFB\u53D6\u4EC5\u7528\u4E8E\u7406\u89E3\u9875\u9762\uFF0C\u4E0D\u6CC4\u9732\u654F\u611F\u4FE1\u606F\u3002"
  },
  {
    name: "search-within-site",
    displayName: "\u7AD9\u5185\u68C0\u7D22\uFF08\u641C\u7D22 + \u7ED3\u6784\u5316\u53D6\u56DE\u7ED3\u679C\uFF09",
    description: "\u5728\u7AD9\u70B9\u81EA\u5DF1\u7684\u641C\u7D22\u6846\u91CC\u68C0\u7D22\uFF0C\u5E76\u628A\u7ED3\u679C\u6761\u76EE\u7ED3\u6784\u5316\u53D6\u56DE\u3002\u5F53\u7528\u6237\u8981\u6C42\u300C\u5728\u67D0\u4E2A\u7F51\u7AD9/\u7AD9\u5185\u641C\u4E00\u4E0B\u2026\u300D\u300C\u628A\u8FD9\u4E2A\u7AD9\u7684\u7ED3\u679C\u5217\u51FA\u6765\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser",
    tags: ["\u68C0\u7D22", "\u641C\u7D22", "\u7ED3\u679C\u5217\u8868", "\u586B\u8868"],
    skill_type: "prompt-template",
    // 下面这段内容里的每一条都来自 tests/e2e/golden.spec.mjs 的
    // 「站内检索」端到端用例（playbook id = site-search）：它不是凭空写的技法，
    // 而是那条剧本**实际验证过**的路径。工具集也必须与剧本一致 —— 由
    // tests/skill-playbook-contract.test.mjs 机检，漂移会红灯。
    content: '# \u7AD9\u5185\u68C0\u7D22\n\n## \u6B65\u9AA4\uFF08\u987A\u5E8F\u6709\u7406\u7531\uFF0C\u4E0D\u8981\u8DF3\uFF09\n1. `get_page_snapshot` \u770B\u9875\u9762\uFF0C\u627E\u5230\u641C\u7D22\u8F93\u5165\u6846\u4E0E\u63D0\u4EA4\u6309\u94AE\uFF1B\n2. `type_text` \u586B\u67E5\u8BE2\u8BCD \u2014\u2014 **`value` \u662F\u8981\u8F93\u5165\u7684\u5185\u5BB9\u3001`text` \u662F\u5B9A\u4F4D\u7528\u7684\u6587\u672C\u7247\u6BB5**\uFF0C\u4E24\u8005\u8BED\u4E49\u4E0D\u540C\uFF0C\u522B\u6DF7\u7528\uFF1B\n3. `click_element` \u70B9\u641C\u7D22\u6309\u94AE\uFF1B\n4. **\u7B49\u7ED3\u679C\u6E32\u67D3\u51FA\u6765**\u518D\u8BFB \u2014\u2014 \u7528 `wait_for_element({ selector, state: "visible" })` \u7B49**\u7ED3\u679C\u6761\u76EE**\u51FA\u73B0\n   \uFF08\u522B\u7B49\u5BB9\u5668\uFF1A\u5BB9\u5668\u4E00\u5F00\u59CB\u5C31\u5728\uFF0C\u7B49\u5B83\u7B49\u4E8E\u6CA1\u7B49\uFF09\uFF0C\u7136\u540E `inspect_element({op:"text"})` \u53D6**\u7ED3\u679C\u5217\u8868\u5BB9\u5668**\u7684\u6587\u672C\uFF0C\n   \u4E0D\u8981\u628A\u6574\u9875\u5012\u56DE\u6765\uFF1B\n5. \u6C47\u603B\u65F6\u7ED9\u51FA\u6761\u76EE\u6807\u9898\u4E0E\u5173\u952E\u5B57\u6BB5\uFF08\u4EF7\u683C/\u65F6\u95F4/\u8BC4\u5206\u7B49\uFF09\uFF0C\u5E76\u8BF4\u660E\u5171\u53D6\u5230\u51E0\u6761\u3002\n\n## \u56DB\u4E2A\u5BB9\u6613\u8E29\u7684\u70B9\n- **\u7ED3\u679C\u5217\u8868\u662F\u5F02\u6B65\u6E32\u67D3\u7684\u3002** \u70B9\u51FB\u540E\u4E0D\u8981\u7ACB\u523B\u8BFB\u5217\u8868\uFF0C\u5426\u5219\u62FF\u5230\u7A7A\u7ED3\u679C\u5E76\u628A"\u6CA1\u641C\u5230"\u5F53\u6210\u4E8B\u5B9E\u3002\n  \u8FD9\u6761\u4E0D\u662F\u7406\u8BBA\uFF1A\u672C\u4ED3\u5E93\u7684\u68C0\u7D22\u5267\u672C\u81EA\u5DF1\u5C31\u6F0F\u8FC7\u4E00\u6B21\uFF0C\u6210\u4E86**5 \u6B21\u91CC\u5931\u8D25 1 \u6B21**\u7684\u95F4\u6B47\u6027\u7528\u4F8B \u2014\u2014\n  \u800C\u5931\u8D25\u4FE1\u606F\u53EA\u663E\u793A"\u7ED3\u679C\u91CC\u6CA1\u6709\u67D0\u6761\u76EE"\uFF0C\u5B8C\u5168\u6307\u4E0D\u5230"\u8BFB\u65E9\u4E86"\u3002\n- **\u8BED\u4E49\u5B9A\u4F4D\u8981\u6C42\u9875\u9762\u89C4\u8303\u53EF\u8BBF\u95EE\u3002** `role`+`name` \u53EA\u5728\u5143\u7D20\u771F\u7684\u66B4\u9732\u4E86 role/aria-label \u65F6\u624D\u547D\u4E2D\uFF1B\n  \u9047\u5230\u8001\u9875\u9762/\u81EA\u7814\u7EC4\u4EF6\u65F6\u56DE\u9000 `selector` \u6216 `text`\u3002\u547D\u4E2D\u5931\u8D25\u65F6\u5148\u6000\u7591"\u5B9A\u4F4D\u6761\u4EF6\u4E0D\u591F"\uFF0C\n  \u800C\u4E0D\u662F\u5148\u65AD\u8A00"\u9875\u9762\u4E0A\u6CA1\u6709\u8FD9\u4E2A\u8F93\u5165\u6846"\u3002\n- **\u5E7F\u544A\u6761\u76EE\u548C\u771F\u5B9E\u7ED3\u679C\u8981\u5206\u5F00\u5224\u65AD\u3002** \u68C0\u7D22\u9636\u6BB5\u5148\u628A\u5E26 "\u5E7F\u544A/\u63A8\u5E7F/\u8D5E\u52A9" \u6807\u8BB0\u7684\u6761\u76EE\u7167\u539F\u6837\u53D6\u56DE\uFF0C\n  \u4E0D\u8981\u6084\u6084\u4E22\u6389 \u2014\u2014 \u4E22\u4E0D\u4E22\u662F\u7528\u6237\u7684\u9009\u62E9\uFF0C\u4E0D\u662F\u68C0\u7D22\u8FD9\u4E00\u5C42\u7684\u51B3\u5B9A\u3002\n- **\u522B\u628A\u6574\u9875\u6587\u672C\u4E22\u7ED9\u81EA\u5DF1\u5F53"\u7ED3\u679C"\u3002** \u7ED3\u6784\u5316\u5B57\u6BB5\uFF08\u6807\u9898/\u4EF7\u683C\uFF09\u624D\u662F\u53EF\u6838\u5BF9\u7684\u4EA4\u4ED8\u7269\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u7AD9\u5185\u641C|\u7AD9\u5185\u68C0\u7D22|\u641C\u4E00\u4E0B|\u641C\u7D22|\u68C0\u7D22", "\u7ED3\u679C|\u5217\u8868|\u6761\u76EE|\u524D\u51E0\u6761"],
      tools: ["get_page_snapshot", "type_text", "click_element", "wait_for_element", "inspect_element", "complete_task"],
      // 与能力剧本的对应关系（契约门禁据此核对 x.tools 是否覆盖剧本实际用到的工具）
      playbook: "site-search"
    }
  },
  {
    name: "checkout-form",
    displayName: "\u4E0B\u5355 / \u591A\u6B65\u8868\u5355\uFF08\u9009\u5546\u54C1 \u2192 \u586B\u5199 \u2192 \u52FE\u9009\u786E\u8BA4 \u2192 \u63D0\u4EA4\uFF09",
    description: "\u5728\u7F51\u9875\u4E0A\u5B8C\u6210\u4E00\u6B21\u591A\u6B65\u8868\u5355\u63D0\u4EA4\uFF08\u4E0B\u5355\u3001\u9884\u7EA6\u3001\u62A5\u540D\u3001\u95EE\u5377\uFF09\u3002\u5F53\u7528\u6237\u8981\u6C42\u300C\u5E2E\u6211\u4E0B\u5355/\u9884\u7EA6/\u62A5\u540D/\u586B\u4E00\u4E0B\u8FD9\u4E2A\u8868\u5355\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser",
    tags: ["\u4E0B\u5355", "\u8868\u5355", "\u591A\u6B65", "\u63D0\u4EA4"],
    skill_type: "prompt-template",
    // 与 search-within-site 同样：内容里的每一条都来自 tests/e2e/golden.spec.mjs
    // 的「点单」端到端用例（playbook id = checkout-form）实际验证过的路径。
    content: '# \u4E0B\u5355 / \u591A\u6B65\u8868\u5355\n\n## \u987A\u5E8F\uFF08\u5148\u586B\u9F50\u3001\u518D\u63D0\u4EA4\uFF0C\u4E0D\u8981\u8FB9\u586B\u8FB9\u63D0\u4EA4\uFF09\n1. `get_page_snapshot` \u770B\u6E05\u6709\u54EA\u51E0\u9879\u5FC5\u586B\u3001\u5404\u662F\u4EC0\u4E48\u63A7\u4EF6\uFF1B\n2. \u4E0B\u62C9\u6846\u7528 `select_option`\uFF08\u6309 `selector` + `label`/`value`\uFF09\uFF1B\n3. \u6587\u672C\u9879\u7528 `type_text`\uFF08`role`+`name` \u5B9A\u4F4D\uFF0C**`value` \u662F\u8981\u8F93\u5165\u7684\u5185\u5BB9**\uFF09\uFF1B\n4. \u52FE\u9009\u6846\u7528 `check_box`\uFF08`role`+`name` \u5B9A\u4F4D\uFF0C\u5FC5\u987B\u5E26 `checked`\uFF09\uFF1B\n5. \u5168\u90E8\u586B\u9F50\u540E\u518D `click_element` \u63D0\u4EA4\uFF1B\n6. **\u8BFB\u56DE\u7ED3\u679C**\uFF08`inspect_element` \u53D6\u7ED3\u679C\u533A\u57DF\uFF09\u540E\u624D\u7B97\u5B8C\u6210\u3002\n\n## \u56DB\u4E2A\u5BB9\u6613\u8E29\u7684\u70B9\n- **\u300C\u70B9\u4E86\u63D0\u4EA4\u300D\u4E0D\u7B49\u4E8E\u300C\u63D0\u4EA4\u6210\u529F\u300D\u3002** \u8868\u5355\u6709\u4E1A\u52A1\u6821\u9A8C\uFF1A\u7F3A\u5FC5\u586B\u9879\u65F6\u9875\u9762\u53EA\u4F1A\u56DE\u4E00\u53E5\u63D0\u793A\u3001\n  \u9875\u9762\u72B6\u6001\u6BEB\u65E0\u53D8\u5316\u3002**\u53EA\u6709\u8BFB\u56DE\u7ED3\u679C**\u624D\u80FD\u533A\u5206"\u4E0B\u5355\u4E86"\u548C"\u70B9\u4E86\u4E00\u4E0B"\u3002\n- **\u786E\u8BA4/\u540C\u610F\u7C7B\u52FE\u9009\u5E38\u5E38\u662F\u627F\u91CD\u4EF6\u3002** \u4E0D\u52FE\u9009\uFF0C\u63D0\u4EA4\u4F1A\u9759\u9ED8\u5931\u8D25\u6216\u53EA\u56DE\u4E00\u53E5\u63D0\u793A\u3002\n  \u522B\u8DF3\u8FC7\u5B83\uFF0C\u4E5F\u522B\u4EE5\u4E3A\u5B83\u53EA\u662F\u88C5\u9970\u3002\n- **\u5931\u8D25\u63D0\u793A\u8981\u7167\u5B9E\u8BFB\u51FA\u6765\uFF0C\u522B\u539F\u6837\u91CD\u8BD5\u3002** \u9875\u9762\u56DE\u300C\u8BF7\u8865\u5168\u4FE1\u606F\u300D\u65F6\uFF0C\u5E94\u6307\u51FA**\u5DEE\u54EA\u4E00\u9879**\uFF0C\n  \u800C\u4E0D\u662F\u628A\u540C\u4E00\u4E2A\u63D0\u4EA4\u52A8\u4F5C\u518D\u70B9\u4E00\u6B21 \u2014\u2014 \u771F\u5B9E\u7AD9\u70B9\u8FD9\u4E48\u505A\u901A\u5E38\u4F1A\u88AB\u9650\u6D41\u6216\u89E6\u53D1\u98CE\u63A7\u3002\n- **\u5B9A\u4F4D\u65B9\u5F0F\u6309\u5DE5\u5177\u800C\u5F02\u3002** `select_option` \u7684 schema \u53EA\u63A5\u53D7 `ref`/`selector`\uFF1B\n  \u6587\u672C\u6846\u4E0E\u52FE\u9009\u6846\u652F\u6301 `role`+`name`\u3002\u7528\u9519\u5B9A\u4F4D\u65B9\u5F0F\u4F1A\u5F97\u5230\u300C\u672A\u627E\u5230\u5143\u7D20\u300D\uFF0C\n  \u800C\u90A3\u662F**\u5B9A\u4F4D\u6761\u4EF6\u4E0D\u591F**\uFF0C\u4E0D\u4EE3\u8868\u9875\u9762\u4E0A\u6CA1\u6709\u8FD9\u4E2A\u63A7\u4EF6\u3002\n\n## \u63D0\u4EA4\u524D\u5FC5\u987B\u8BA9\u7528\u6237\u786E\u8BA4\n\u4E0B\u5355/\u9884\u7EA6\u8FD9\u7C7B**\u6709\u526F\u4F5C\u7528\u7684\u5199\u64CD\u4F5C**\uFF0C\u6309\u5BA1\u6279\u7B56\u7565\u6267\u884C\uFF1B\u6D89\u53CA\u91D1\u989D\u3001\u5730\u5740\u3001\u65F6\u95F4\u7B49\u5173\u952E\u4FE1\u606F\u65F6\uFF0C\n\u628A\u5373\u5C06\u63D0\u4EA4\u7684\u5185\u5BB9\u590D\u8FF0\u4E00\u904D\u518D\u63D0\u4EA4\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u4E0B\u5355|\u8D2D\u4E70|\u4E70|\u9884\u7EA6|\u62A5\u540D|\u7ED3\u8D26|\u7ED3\u7B97", "\u8868\u5355|\u586B\u5199|\u63D0\u4EA4|\u6536\u8D27"],
      tools: ["get_page_snapshot", "select_option", "type_text", "check_box", "click_element", "inspect_element", "complete_task"],
      playbook: "checkout-form"
    }
  },
  {
    name: "readability-fix",
    displayName: "\u53EF\u8BFB\u6027\u7F8E\u5316\uFF08\u628A\u96BE\u8BFB\u7684\u9875\u9762\u8C03\u6210\u6613\u8BFB\uFF09",
    description: "\u8C03\u6574\u9875\u9762\u7684\u6B63\u6587\u6392\u7248\u4E0E\u5BB9\u5668\u5BBD\u5EA6\uFF0C\u8BA9\u5B83\u66F4\u597D\u8BFB\uFF08\u5B57\u53F7\u3001\u884C\u9AD8\u3001\u5BF9\u6BD4\u5EA6\u3001\u884C\u5BBD\uFF09\u3002\u5F53\u7528\u6237\u8981\u6C42\u300C\u8FD9\u9875\u9762\u770B\u7740\u7D2F/\u592A\u6324/\u5B57\u592A\u5C0F/\u5E2E\u6211\u7F8E\u5316\u4E00\u4E0B\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser",
    tags: ["\u7F8E\u5316", "\u53EF\u8BFB\u6027", "\u6837\u5F0F", "\u6392\u7248"],
    skill_type: "prompt-template",
    content: '# \u53EF\u8BFB\u6027\u7F8E\u5316\n\n## \u6B65\u9AA4\uFF08\u4E09\u4E2A\u91CF\u90FD\u8981\u5904\u7406\uFF0C**\u4E0D\u8981\u53EA\u6539\u524D\u4E24\u4E2A\u5C31\u6536\u5C3E**\uFF09\n1. `get_page_snapshot` \u770B\u6E05\u7ED3\u6784\uFF0C\u627E\u5230\u5305\u4F4F\u6B63\u6587\u7684\u90A3\u4E00\u5C42\u5BB9\u5668\uFF08\u5E38\u662F `.wrap` / `.article` / `.content`\uFF0C\n   **\u901A\u5E38\u4E0D\u662F body**\uFF09\uFF1B\n2. `inspect_element({ op: "styles" })` \u8BFB**\u6539\u52A8\u524D**\u7684\u5B57\u53F7/\u884C\u9AD8/\u5BF9\u6BD4\u5EA6\uFF0C\u4F5C\u4E3A\u5BF9\u7167\uFF1B\n3. **\u6539\u6392\u7248**\uFF1A`annotate({ op: "style", selector: "body", styles: { fontSize: "17px", lineHeight: "1.7", color: "#1a1a1a", background: "#ffffff" } })`\uFF1B\n4. **\u6539\u884C\u5BBD / \u4FEE\u6A2A\u5411\u6EA2\u51FA \u2014\u2014 \u5FC5\u987B\u5355\u72EC\u505A\u8FD9\u4E00\u6B65**\uFF1A\n   `annotate({ op: "style", selector: "<\u4E0A\u9762\u627E\u5230\u7684\u5BBD\u5BB9\u5668>", styles: { width: "auto", maxWidth: "760px" } })`\uFF1B\n5. `inspect_element({ op: "styles" })` \u8BFB\u56DE**\u6539\u52A8\u540E**\u7684\u503C\uFF0C\u9010\u9879\u786E\u8BA4\u771F\u7684\u751F\u6548\uFF1B\n6. \u6C47\u62A5\u6539\u4E86\u54EA\u4E9B\u5C5E\u6027\u3001\u524D\u540E\u503C\u5404\u662F\u591A\u5C11\u3002\n\n## \u4E3A\u4EC0\u4E48\u7B2C 4 \u6B65\u5FC5\u987B\u5355\u72EC\u5217\u51FA\u6765\n\u771F\u6A21\u578B\u5B9E\u6D4B\uFF082026-01\uFF0Cdeepseek \u7CFB\u5217\uFF09**\u53EA\u505A\u4E86\u7B2C 3 \u6B65\u5C31\u6536\u5C3E**\uFF1A\u5B57\u53F7\u3001\u884C\u9AD8\u3001\u5BF9\u6BD4\u5EA6\u5168\u90E8\u8FBE\u6807\uFF0C\n\u4F46**\u6A2A\u5411\u6EA2\u51FA\u539F\u5C01\u4E0D\u52A8** \u2014\u2014 \u56E0\u4E3A\u5BBD\u5EA6\u95EE\u9898\u4E0D\u5728\u6B63\u6587\u6392\u7248\u91CC\uFF0C\u6539 body \u7684\u5B57\u53F7\u4E0D\u4F1A\u5F71\u54CD\u4E00\u4E2A\u56FA\u5B9A 1500px \u7684\u5BB9\u5668\u3002\n\u7ED3\u679C\u9875\u9762"\u770B\u8D77\u6765\u597D\u4E86\u4E00\u70B9"\uFF0C\u7528\u6237\u4ECD\u8981\u5DE6\u53F3\u62D6\u52A8\u624D\u80FD\u8BFB\u5B8C\u4E00\u884C\u3002\n**\u5224\u636E\u662F\uFF1A\u6A2A\u5411\u6EDA\u52A8\u6D88\u5931**\uFF08`document.documentElement.scrollWidth` \u4E0D\u518D\u5927\u4E8E\u89C6\u53E3\u5BBD\u5EA6\uFF09\uFF0C\n\u800C\u4E0D\u662F"\u6211\u6539\u8FC7\u6837\u5F0F\u4E86"\u3002\u627E\u4E0D\u5230\u662F\u54EA\u4E2A\u5BB9\u5668\u5BBD\uFF0C\u5C31\u9010\u4E2A\u67E5 `inspect_element({ op: "styles", props: ["width","overflow-x"] })`\uFF0C\n\u6BD4\u731C\u5FEB\u3002\n\n## \u4E09\u4E2A\u771F\u6B63\u5F71\u54CD\u53EF\u8BFB\u6027\u7684\u91CF\n1. **\u5B57\u53F7**\uFF1A\u6B63\u6587 \u226516px\uFF08\u672C\u4ED3\u5E93\u7684\u9A8C\u6536\u503C\u53D6 17px\uFF09\uFF1B\n2. **\u884C\u9AD8**\uFF1A\u884C\u9AD8\u6BD4 \u22651.6\uFF08\u884C\u8D34\u592A\u8FD1\u4F1A\u4E32\u884C\uFF09\uFF1B\n3. **\u884C\u5BBD**\uFF1A\u4E00\u884C 60\u201380 \u5B57\u7B26\u3002\u5BB9\u5668\u56FA\u5B9A\u8D85\u5BBD\u4F1A\u9020\u6210**\u6A2A\u5411\u6EA2\u51FA**\uFF0C\n   \u6539\u6CD5\u662F\u628A\u56FA\u5B9A `width` \u6362\u6210 `auto` + `maxWidth`\uFF08\u7EA6 720\u2013800px\uFF09\uFF0C\u800C\u4E0D\u662F\u7F29\u5C0F\u5B57\u53F7\u3002\n\n## \u5BF9\u6BD4\u5EA6\u8981\u6309\u300C\u6709\u6548\u80CC\u666F\u300D\u7B97\n\u5143\u7D20\u81EA\u8EAB\u7684 `background-color` \u9ED8\u8BA4\u662F **transparent**\u3002\u76F4\u63A5\u7528\u5143\u7D20\u80CC\u666F\u7B97\u5BF9\u6BD4\u5EA6\uFF0C\n\u900F\u660E\u4F1A\u88AB\u5F53\u6210\u9ED1\u8272\uFF0C\u4E8E\u662F\u6DF1\u8272\u6587\u5B57\u7B97\u51FA\u6765\u63A5\u8FD1 1:1 \u2014\u2014 **\u6539\u597D\u4E86\u5374\u5224\u6210\u6CA1\u6539\u597D**\u3002\n\u6B63\u786E\u505A\u6CD5\u662F**\u5411\u4E0A\u627E\u7B2C\u4E00\u4E2A\u4E0D\u900F\u660E\u80CC\u666F**\uFF08\u901A\u5E38\u662F `body`\uFF09\u3002\n\n## \u600E\u4E48\u6539\u3001\u600E\u4E48\u9A8C\n- \u6539\u6837\u5F0F\u7528 `annotate({ op: "style", selector, styles })`\uFF0C`styles` \u662F**\u6241\u5E73** CSS \u5C5E\u6027\uFF1B\n  \u591A\u5904\u540C\u7C7B\u4E00\u8D77\u6539\u5C31\u7528 `selectors` \u6570\u7EC4\u4E00\u6B21\u4F20\uFF08\u226420 \u4E2A\uFF09\uFF0C\u4E0D\u8981\u5FAA\u73AF\u8C03\u7528\u3002\n- **\u6539\u5B8C\u5FC5\u987B\u8BFB\u56DE\u8BA1\u7B97\u540E\u7684\u503C**\u624D\u7B97\u9A8C\u8BC1\u8FC7\uFF1A`inspect_element({ op: "styles", selector, props })`\u3002\n  \u5DE5\u5177\u56DE\u7684\u300C\u5DF2\u4FEE\u6539 N \u4E2A\u5143\u7D20\u300D\u8BC1\u660E\u7684\u662F"\u8C03\u7528\u53D1\u51FA\u53BB\u4E86"\uFF0C\u4E0D\u662F"\u6837\u5F0F\u771F\u7684\u751F\u6548\u4E86"\n  \u2014\u2014 \u53D6\u503C\u53EF\u80FD\u975E\u6CD5\u88AB\u5FFD\u7565\uFF0C\u4E5F\u53EF\u80FD\u88AB\u522B\u5904\u7684 `!important` \u8986\u76D6\u3002\n  `props` \u7528\u8FDE\u5B57\u7B26\u5199\u6CD5\uFF08`font-size` / `max-width`\uFF09\uFF0C\u4E0D\u4F20\u5219\u8BFB\u4E00\u7EC4\u5E38\u7528\u5C5E\u6027\u3002\n- **\u4E0D\u8981\u7528 `run_javascript` \u8BFB\u6837\u5F0F**\uFF1A\u5B83\u53D7\u300C\u9875\u9762\u547D\u4EE4\u300D\u5BA1\u6279\u7EA6\u675F\uFF0C\u800C\u4E14\u8981\u5F00 CDP \u624D\u80FD\u8DD1\n  \uFF08\u6C99\u7BB1\u4F9D\u8D56 eval\uFF0C\u800C MV3 \u6269\u5C55\u81EA\u8EAB\u7684 CSP \u4E0D\u5141\u8BB8 eval\uFF0C\u4E0E\u9875\u9762\u65E0\u5173\uFF09\u3002\n  `inspect_element({ op: "styles" })` \u662F\u53EA\u8BFB\u7684\u3001\u4E0D\u9700\u8981\u6279\u51C6\u3002\n- \u9700\u8981\u7ED9\u7528\u6237\u53EF\u89C6\u8BC1\u636E\u65F6\u7528 `take_screenshot`\uFF0C' + // 禁用 / 启用文案的单一来源在 utils.js。**整句**二选一：
    // 关闭分支自带句内换行，**空行**统一在这里补 ⇒ 关闭时与改动前逐字节相同 ✓
    (VISION_ENABLED ? VISION_ENABLED_SKILL_COPY : VISION_UNAVAILABLE_SKILL_COPY) + '\n\n## \u7EDD\u4E0D\u5141\u8BB8\u7684"\u8FBE\u6807"\u65B9\u5F0F\n\u628A\u6B63\u6587 `display:none`\u3001\u6216\u5220\u6389\u5185\u5BB9\uFF0C\u90FD\u80FD\u8BA9"\u5BF9\u6BD4\u5EA6""\u4E0D\u6EA2\u51FA"\u7ACB\u523B\u8FBE\u6807\u3002\n**\u90A3\u662F\u641E\u574F\uFF0C\u4E0D\u662F\u7F8E\u5316\u3002** \u6539\u5B8C\u5FC5\u987B\u786E\u8BA4\u5185\u5BB9\u4ECD\u5728\u3001\u5B57\u6570\u6CA1\u5C11\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u7F8E\u5316|\u597D\u770B|\u6392\u7248|\u5B57\u592A\u5C0F|\u592A\u6324|\u8BFB\u8D77\u6765|\u53EF\u8BFB\u6027", "\u6837\u5F0F|\u884C\u9AD8|\u5B57\u53F7|\u5BF9\u6BD4\u5EA6|\u5BBD\u5EA6"],
      tools: ["get_page_snapshot", "annotate", "inspect_element", "take_screenshot", "complete_task"],
      playbook: "readability-fix"
    }
  },
  {
    name: "debug-console-error",
    displayName: "\u6392\u67E5\u300C\u70B9\u4E86\u6CA1\u53CD\u5E94\u300D\uFF08\u5148\u590D\u73B0\uFF0C\u518D\u8BFB\u8FD0\u884C\u671F\u4E8B\u5B9E\uFF09",
    description: "\u9875\u9762\u4E0A\u7684\u4EA4\u4E92\u6CA1\u6709\u751F\u6548\u3001\u6309\u94AE\u70B9\u4E86\u6CA1\u53CD\u5E94\u3001\u7ED3\u679C\u6CA1\u51FA\u6765\u65F6\uFF0C\u5B9A\u4F4D\u771F\u5B9E\u539F\u56E0\u3002\u5F53\u7528\u6237\u8BF4\u300C\u70B9\u4E86\u6CA1\u53CD\u5E94 / \u6309\u94AE\u4E0D\u7BA1\u7528 / \u600E\u4E48\u6CA1\u751F\u6548 / \u5E2E\u6211\u770B\u770B\u4E3A\u4EC0\u4E48\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u6392\u67E5", "debug", "\u63A7\u5236\u53F0\u62A5\u9519", "\u590D\u73B0"],
    skill_type: "prompt-template",
    content: '# \u6392\u67E5\uFF1A\u70B9\u4E86\u6CA1\u53CD\u5E94\n\n## \u6700\u5173\u952E\u7684\u4E00\u6761\uFF1A**\u5148\u590D\u73B0\uFF0C\u518D\u8BFB\u8BCA\u65AD**\n\u987A\u5E8F\u53CD\u4E86\u4F1A\u5F97\u5230\u4E00\u6761**\u7A7A\u8BCA\u65AD**\uFF0C\u7136\u540E\u6781\u6613\u5F97\u51FA"\u9875\u9762\u6CA1\u95EE\u9898"\u7684\u9519\u8BEF\u7ED3\u8BBA \u2014\u2014\n\u56E0\u4E3A\u9519\u8BEF\u5F80\u5F80\u53EA\u5728\u4EA4\u4E92\u53D1\u751F\u7684\u90A3\u4E00\u523B\u624D\u4EA7\u751F\uFF0C\u52A0\u8F7D\u5B8C\u7684\u9875\u9762\u770B\u8D77\u6765\u4E00\u5207\u6B63\u5E38\u3002\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u627E\u5230\u89E6\u53D1\u4EA4\u4E92\u7684\u5143\u7D20\uFF08\u672C\u4F8B\u662F\u6309\u94AE\uFF09\uFF1B\n2. `click_element`\uFF08\u6216\u5BF9\u5E94\u7684\u8F93\u5165/\u9009\u62E9\u52A8\u4F5C\uFF09**\u628A\u95EE\u9898\u590D\u73B0\u51FA\u6765**\uFF1B\n3. `read_diagnostics({ kind: "console", level: "error" })` \u8BFB**\u8FD0\u884C\u671F\u4E8B\u5B9E**\uFF1B\n4. `inspect_element({ op: "text" })` \u786E\u8BA4\u75C7\u72B6\uFF08\u7ED3\u679C\u533A\u786E\u5B9E\u662F\u7A7A\u7684\uFF0C\u800C\u4E0D\u662F\u4F60\u6CA1\u627E\u5230\uFF09\uFF1B\n5. \u6C47\u62A5**\u8BC1\u636E + \u63A8\u65AD**\uFF0C\u5E76\u660E\u786E\u533A\u5206\u4E24\u8005\u3002\n\n## \u56DB\u6761\u7EAA\u5F8B\n- **\u62A5\u9519\u6587\u6848\u8981\u7167\u539F\u6587\u5F15\u7528**\uFF0C\u4E0D\u8981\u8F6C\u8FF0\u6210"\u597D\u50CF\u6709\u4E2A\u9519\u8BEF"\u3002\n  \u300CTypeError: Cannot read properties of undefined (reading \'total\')\u300D\u662F\u8BC1\u636E\uFF0C\n  "\u53EF\u80FD\u662F\u6570\u636E\u6CA1\u53D6\u5230"\u662F\u4F60\u7684\u63A8\u65AD \u2014\u2014 \u4E24\u8005\u4E0D\u80FD\u6DF7\u4E3A\u4E00\u8C08\u3002\n- **\u4E0D\u8981\u5728\u6CA1\u6709\u8BCA\u65AD\u8BC1\u636E\u65F6\u5C31\u4E0B\u7ED3\u8BBA**\u3002\u8BFB\u4E86\u8BCA\u65AD\u53D1\u73B0\u662F\u7A7A\u7684\uFF0C\u5C31\u8BF4"\u590D\u73B0\u4E86\u4F46\u63A7\u5236\u53F0\u6CA1\u6709\u62A5\u9519"\uFF0C\n  \u7136\u540E\u6362\u522B\u7684\u65B9\u5411\uFF08\u7F51\u7EDC\u8BF7\u6C42\uFF1F\u6837\u5F0F\uFF1F\u5143\u7D20\u6839\u672C\u6CA1\u7ED1\u4E0A\u4E8B\u4EF6\uFF1F\uFF09\uFF0C\u4E0D\u8981\u7F16\u539F\u56E0\u3002\n- **\u53EA\u8BFB\u8BCA\u65AD\u4E0D\u9700\u8981\u5BA1\u6279**\uFF0C\u76F4\u63A5\u8BFB\uFF1B\u4F46\u8981**\u5148\u590D\u73B0**\u624D\u6709\u5185\u5BB9\u53EF\u8BFB\u3002\n- **\u533A\u5206"\u6CA1\u53CD\u5E94"\u7684\u51E0\u79CD\u53EF\u80FD**\uFF1A\u629B\u5F02\u5E38\uFF08\u770B console\uFF09/ \u8BF7\u6C42\u5931\u8D25\uFF08`kind:"network"`\uFF09/ \n  \u5143\u7D20\u88AB\u906E\u6321\u6216\u7981\u7528\uFF08\u770B fast snapshot \u4E0E `get_attribute`\uFF09/ \u4E8B\u4EF6\u538B\u6839\u6CA1\u7ED1\u4E0A\uFF08\u70B9\u51FB\u540E\u65E0\u4EFB\u4F55\u53D8\u5316\uFF09\u3002\n\n## \u4E0D\u8981\u505A\u7684\u4E8B\n- \u4E0D\u8981\u4E3A\u4E86"\u8BA9\u7528\u6237\u770B\u5230\u6709\u53D8\u5316"\u800C\u53BB\u6539\u9875\u9762\u6216\u6CE8\u5165\u4EE3\u7801 \u2014\u2014 \u6392\u67E5\u9636\u6BB5\u7684\u9996\u8981\u76EE\u6807\u662F**\u627E\u5230\u539F\u56E0**\uFF0C\u4E0D\u662F\u8BA9\u5B83\u770B\u8D77\u6765\u597D\u4E86\u3002\n- \u4E0D\u8981\u58F0\u79F0"\u5DF2\u4FEE\u590D"\uFF0C\u9664\u975E\u771F\u7684\u6539\u4E86\u4EE3\u7801/\u6837\u5F0F\u5E76**\u9A8C\u8BC1\u8FC7**\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u6CA1\u53CD\u5E94|\u4E0D\u7BA1\u7528|\u6CA1\u751F\u6548|\u6CA1\u51FA\u6765|\u4E3A\u4EC0\u4E48|\u6392\u67E5|debug", "\u62A5\u9519|\u9519\u8BEF|\u63A7\u5236\u53F0|\u5F02\u5E38"],
      tools: ["get_page_snapshot", "click_element", "read_diagnostics", "inspect_element", "get_attribute", "complete_task"],
      playbook: "debug-console-error"
    }
  },
  {
    name: "dismiss-overlay",
    displayName: "\u88AB\u5F39\u7A97/\u906E\u7F69\u6321\u4F4F\uFF08\u5148\u5904\u7406\u5E72\u6270\uFF0C\u518D\u5E72\u6D3B\uFF09",
    description: "\u9875\u9762\u88AB\u5F39\u7A97\u3001Cookie \u540C\u610F\u6846\u3001\u5F15\u5BFC\u8499\u5C42\u6216\u906E\u7F69\u6321\u4F4F\uFF0C\u5BFC\u81F4\u70B9\u51FB/\u8F93\u5165\u4E0D\u751F\u6548\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u88AB\u5F39\u7A97\u6321\u4F4F\u4E86 / \u5173\u6389\u8FD9\u4E2A\u5E7F\u544A / \u70B9\u4E0D\u4E86\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser",
    tags: ["\u5F39\u7A97", "\u906E\u7F69", "\u906E\u6321", "\u5E72\u6270"],
    skill_type: "prompt-template",
    // 与真模型实测相关：本技能第一次写出来时**没有编号步骤清单**，
    // 真模型（deepseek 系列）因此漏掉关键一步。教训：这类"有前提步骤"的任务
    // 必须给编号清单，模型才会逐步做完。
    content: '# \u88AB\u5F39\u7A97 / \u906E\u7F69\u6321\u4F4F\n\n## \u6B65\u9AA4\uFF08**\u987A\u5E8F\u5373\u80FD\u529B**\uFF0C\u4E0D\u8981\u5148\u53BB\u70B9\u88AB\u6321\u4F4F\u7684\u4E1C\u897F\uFF09\n1. `get_page_snapshot` \u770B\u6E05\u9875\u9762\u4E0A\u6709\u4EC0\u4E48 \u2014\u2014 \u627E\u4E00\u4E2A**\u76D6\u4F4F\u6B63\u6587\u7684\u5168\u5C4F\u5C42**\n   \uFF08\u901A\u5E38 `position: fixed` + \u9AD8 `z-index`\uFF0C\u91CC\u9762\u5F80\u5F80\u6709\u300C\u63A5\u53D7 / \u5173\u95ED / \xD7\u300D\u6309\u94AE\uFF09\uFF1B\n2. **\u5148\u628A\u5E72\u6270\u5173\u6389**\uFF1A`click_element` \u70B9\u90A3\u4E2A\u5173\u95ED/\u63A5\u53D7\u6309\u94AE\uFF08\u7528 `role`+`name` \u5B9A\u4F4D\u6700\u7A33\uFF09\uFF1B\n3. \u786E\u8BA4\u5B83\u771F\u7684\u6D88\u5931\u4E86\uFF08\u518D\u53D6\u4E00\u6B21\u5FEB\u7167\uFF0C\u6216 `inspect_element({ op: "inspect" })` \u770B\u90A3\u4E2A\u5C42\u8FD8\u5728\u4E0D\u5728\uFF09\uFF1B\n4. **\u7136\u540E**\u624D\u505A\u6B63\u4E8B\uFF1A\u8F93\u5165\u3001\u70B9\u51FB\u3001\u8BFB\u53D6\u7ED3\u679C\uFF1B\n5. \u6C47\u62A5\u65F6\u8BF4\u660E"\u5148\u5173\u6389\u4E86\u4EC0\u4E48"\uFF0C\u8BA9\u7528\u6237\u77E5\u9053\u4F60\u7684\u52A8\u4F5C\u987A\u5E8F\u3002\n\n## \u4E3A\u4EC0\u4E48\u4E0D\u80FD\u8DF3\u8FC7\u7B2C 2 \u6B65\n\u906E\u7F69\u662F `position: fixed; inset: 0` \u7684\u5168\u5C4F\u5C42\u65F6\uFF0C**\u8F93\u5165\u6846\u548C\u6309\u94AE\u90FD\u5728\u5B83\u4E0B\u9762**\u3002\n\u6B64\u65F6\u70B9\u51FB/\u8F93\u5165\u4F1A\u88AB\u5224\u5B9A\u4E3A**\u88AB\u906E\u6321**\u5E76\u5931\u8D25 \u2014\u2014 \u6240\u4EE5"\u5148\u5173\u6389\u5B83"\u4E0D\u662F\u591A\u6B64\u4E00\u4E3E\uFF0C\u662F\u524D\u63D0\u3002\n\u5982\u679C\u4F60\u5148\u8BD5\u4E86\u88AB\u6321\u4F4F\u7684\u76EE\u6807\uFF0C\u770B\u5230"\u88AB\u906E\u6321"\u8FD9\u7C7B\u53CD\u9988\uFF0C**\u4E0D\u8981\u53CD\u590D\u91CD\u8BD5\u540C\u4E00\u4E2A\u52A8\u4F5C**\uFF0C\n\u4E5F\u4E0D\u8981\u6539\u7528 `run_javascript` \u786C\u70B9\uFF08\u90A3\u4F1A\u5F15\u53D1\u5BA1\u6279\u4E14\u7ED5\u8FC7\u906E\u6321\u5224\u65AD\uFF09\u2014\u2014\n\u5148\u56DE\u5934\u628A\u90A3\u4E2A\u906E\u7F69\u5173\u6389\u3002\n\n## \u51E0\u79CD\u5E38\u89C1\u5E72\u6270\u7684\u8BC6\u522B\n- **Cookie / \u9690\u79C1\u540C\u610F**\uFF1A\u5E95\u90E8\u6216\u5C45\u4E2D\u7684\u6A2A\u6761/\u5BF9\u8BDD\u6846\uFF0C\u6309\u94AE\u5E38\u53EB\u300C\u63A5\u53D7\u300D\u300C\u540C\u610F\u300D\u300C\u6211\u77E5\u9053\u4E86\u300D\uFF1B\n- **\u6D3B\u52A8\u5F39\u7A97**\uFF1A\u5C45\u4E2D\u5361\u7247\uFF0C\u53F3\u4E0A\u89D2\u901A\u5E38\u6709\u4E2A `\xD7`\uFF08\u53EF\u80FD\u6CA1\u6709\u53EF\u8BBF\u95EE\u540D\uFF0C\u7528 `selector` \u6216 `text` \u5B9A\u4F4D\uFF09\uFF1B\n- **\u5F15\u5BFC\u8499\u5C42**\uFF1A\u534A\u900F\u660E\u5C42 + \u9AD8\u4EAE\u67D0\u4E2A\u533A\u57DF\uFF0C\u6309\u94AE\u5E38\u662F\u300C\u4E0B\u4E00\u6B65\u300D\u300C\u8DF3\u8FC7\u300D\uFF1B\n- **\u767B\u5F55\u5899**\uFF1A\u8FD9\u7C7B**\u4E0D\u8981**\u5C1D\u8BD5\u7ED5\u8FC7 \u2014\u2014 \u5982\u5B9E\u544A\u8BC9\u7528\u6237\u9700\u8981\u767B\u5F55\u3002\n\n## \u5224\u636E\n\u5B8C\u6210\u7684\u6807\u51C6\u662F**\u6B63\u4E8B\u505A\u6210\u4E86**\uFF0C\u800C\u4E0D\u662F"\u6211\u70B9\u4E86\u4E2A\u5173\u95ED\u6309\u94AE"\u3002\n\u5173\u6389\u906E\u7F69\u540E\u4E00\u5B9A\u8981\u7EE7\u7EED\u505A\u5B8C\u7528\u6237\u7684\u539F\u59CB\u8BF7\u6C42\uFF0C\u522B\u505C\u5728"\u5DF2\u5173\u95ED\u5F39\u7A97"\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u5F39\u7A97|\u906E\u6321|\u906E\u7F69|\u6321\u4F4F|\u8499\u5C42|\u5E7F\u544A\u6846", "\u5173\u95ED|\u5173\u6389|\u63A5\u53D7|Cookie|\u540C\u610F"],
      tools: ["get_page_snapshot", "click_element", "type_text", "inspect_element", "complete_task"],
      playbook: "dismiss-overlay"
    }
  },
  {
    name: "recover-from-rejection",
    displayName: "\u88AB\u62D2\u540E\u81EA\u9002\u5E94\uFF08\u8BFB\u61C2\u539F\u56E0\u3001\u8865\u9F50\u3001\u518D\u8BD5\uFF09",
    description: "\u63D0\u4EA4/\u64CD\u4F5C\u88AB\u4E1A\u52A1\u89C4\u5219\u62D2\u7EDD\uFF0C\u9700\u8981\u8BFB\u61C2\u539F\u56E0\u5E76\u4FEE\u6B63\u540E\u91CD\u8BD5\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u7684\u4EFB\u52A1\u7B2C\u4E00\u6B21\u6CA1\u6210\u529F\u3001\u9875\u9762\u56DE\u4E86\u300C\u5FC5\u586B / \u9700\u8981 XX / \u683C\u5F0F\u4E0D\u5BF9 / \u8BF7\u5148\u9009\u62E9\u300D\u8FD9\u7C7B\u63D0\u793A\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser",
    tags: ["\u5931\u8D25\u6062\u590D", "\u81EA\u9002\u5E94", "\u6821\u9A8C", "\u91CD\u8BD5"],
    skill_type: "prompt-template",
    content: '# \u88AB\u62D2\u4E4B\u540E\u600E\u4E48\u529E\uFF08\u81EA\u9002\u5E94\uFF0C\u800C\u4E0D\u662F\u91CD\u8BD5\uFF09\n\n## \u6B65\u9AA4\n1. \u6309\u7528\u6237\u7ED9\u7684\u4FE1\u606F**\u5148\u505A\u5B8C**\u80FD\u505A\u7684\u90E8\u5206\uFF08\u9009\u5546\u54C1 / \u586B\u6570\u91CF / \u586B\u5730\u5740\uFF09\uFF1B\n2. \u6267\u884C\u63D0\u4EA4\uFF1B\n3. **\u8BFB\u9875\u9762\u53CD\u9988**\uFF1A`inspect_element({ op: "text" })` \u8BFB\u63D0\u793A\u533A\u57DF\uFF08\u6216\u770B\u5DE5\u5177\u8FD4\u56DE\u7684"\u52A8\u4F5C\u540E\u72B6\u6001"\uFF09\uFF0C\n   \u5F04\u6E05**\u5230\u5E95\u5DEE\u4EC0\u4E48**\uFF1B\n4. \u6709\u65F6\u88AB\u62D2\u4F1A**\u8BA9\u65B0\u7684\u5B57\u6BB5\u51FA\u73B0**\uFF08\u6E10\u8FDB\u5F0F\u6821\u9A8C\uFF09\uFF1A\u5148\u91CD\u65B0 `get_page_snapshot`\uFF0C\n   \u770B\u770B\u662F\u4E0D\u662F\u591A\u4E86\u4E00\u4E2A\u4E4B\u524D\u4E0D\u5B58\u5728\u7684\u8F93\u5165\u9879\uFF1B\n5. \u6309\u63D0\u793A**\u8865\u4E0A**\uFF08\u63D0\u793A\u91CC\u82E5\u7ED9\u4E86\u53EF\u7528\u503C\uFF0C\u5C31\u7528\u90A3\u4E2A\u503C\uFF09\uFF1B\n6. \u91CD\u65B0\u63D0\u4EA4\uFF0C\u5E76\u5728\u5B8C\u6210\u540E\u8BF4\u660E"\u7B2C\u4E00\u6B21\u4E3A\u4EC0\u4E48\u88AB\u62D2\u3001\u4F60\u8865\u4E86\u4EC0\u4E48"\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u7EDD\u4E0D\u76F2\u76EE\u91CD\u8BD5\u3002** \u540C\u4E00\u4E2A\u52A8\u4F5C\u539F\u5730\u91CD\u8BD5\u53EA\u4F1A\u649E\u540C\u4E00\u5835\u5899\uFF0C\u8FD8\u53EF\u80FD\u89E6\u53D1\u98CE\u63A7\u3002\n  \u91CD\u8BD5\u524D\u5FC5\u987B\u80FD\u8BF4\u51FA"\u8FD9\u6B21\u548C\u4E0A\u6B21\u6709\u4EC0\u4E48\u4E0D\u540C"\u3002\n- **\u5148\u8BFB\u539F\u56E0\u518D\u52A8\u624B\u3002** \u9875\u9762\u7684\u63D0\u793A\u662F\u552F\u4E00\u53EF\u4FE1\u7684\u4FE1\u606F\u6765\u6E90\uFF1B\u4E0D\u8981\u51ED\u731C\u6D4B\u53BB\u6539\u7528\u6237\u7ED9\u7684\u503C\n  \uFF08\u6BD4\u5982\u7528\u6237\u8BF4\u6570\u91CF 1\uFF0C\u5C31\u4E0D\u8981\u81EA\u4F5C\u4E3B\u5F20\u6539\u6210 2\uFF09\u3002\n- **\u6709\u4E9B\u62D2\u7EDD\u4E0D\u8BE5\u7531\u4F60\u89E3\u51B3\u3002** \u5982\u679C\u63D0\u793A\u662F\u300C\u9700\u8981\u767B\u5F55\u300D\u300C\u9700\u8981\u5B9E\u540D\u300D\u300C\u5E93\u5B58\u4E0D\u8DB3\u300D\uFF0C\n  \u90A3\u662F\u7528\u6237\u624D\u80FD\u5904\u7406\u7684\u4E8B \u2014\u2014 \u5982\u5B9E\u8BF4\u660E\uFF0C\u4E0D\u8981\u5C1D\u8BD5\u7ED5\u8FC7\u3002\n\n## \u4E3A\u4EC0\u4E48\u8981\u7279\u522B\u7559\u610F"\u65B0\u51FA\u73B0\u7684\u5B57\u6BB5"\n\u771F\u5B9E\u7AD9\u70B9\u5E38\u7528**\u6E10\u8FDB\u5F0F\u6821\u9A8C**\uFF1A\u4F60\u4E0D\u63D0\u4EA4\uFF0C\u5B83\u5C31\u4E0D\u544A\u8BC9\u4F60\u8FD8\u7F3A\u4EC0\u4E48\uFF1B\n\u4E00\u63D0\u4EA4\uFF0C\u624D\u591A\u51FA\u4E00\u4E2A"\u9080\u8BF7\u7801 / \u9A8C\u8BC1\u7801 / \u914D\u9001\u65F6\u6BB5"\u4E4B\u7C7B\u7684\u5FC5\u586B\u9879\u3002\n\u8FD9\u7C7B\u5B57\u6BB5\u5728\u7B2C\u4E00\u6B21\u63D0\u4EA4\u524D**\u6839\u672C\u4E0D\u5728\u9875\u9762\u4E0A**\uFF0C\u6240\u4EE5"\u518D\u53D6\u4E00\u6B21\u5FEB\u7167"\u4E0D\u662F\u6D6A\u8D39\uFF0C\u662F\u5FC5\u8981\u52A8\u4F5C\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u88AB\u62D2|\u62D2\u7EDD|\u5931\u8D25|\u6CA1\u6210\u529F|\u91CD\u8BD5|\u8FD8\u662F\u4E0D\u884C", "\u5FC5\u586B|\u9700\u8981|\u6821\u9A8C|\u63D0\u793A|\u683C\u5F0F"],
      tools: ["get_page_snapshot", "select_option", "type_text", "click_element", "inspect_element", "complete_task"],
      playbook: "recover-from-rejection"
    }
  },
  {
    name: "extract-merged-table",
    displayName: "\u8868\u683C\u63D0\u53D6\uFF08\u542B\u5408\u5E76\u5355\u5143\u683C\uFF0C\u6309\u5217\u5BF9\u9F50\uFF09",
    description: "\u628A\u7F51\u9875\u4E0A\u7684\u8868\u683C\u63D0\u53D6\u6210\u89C4\u6574\u6570\u636E\u3002\u5F53\u7528\u6237\u8981\u6C42\u300C\u628A\u8868\u683C\u6574\u7406\u51FA\u6765 / \u63D0\u53D6\u8FD9\u5F20\u8868 / \u8F6C\u6210\u8868\u683C\u300D\u65F6\u4F7F\u7528\uFF0C\u5C24\u5176\u662F\u8868\u683C\u91CC\u6709\u5408\u5E76\u5355\u5143\u683C\uFF08\u8DE8\u884C\u8DE8\u5217\uFF09\u65F6\u3002",
    version: "1.0.0",
    category: "browser",
    tags: ["\u8868\u683C", "\u63D0\u53D6", "\u5408\u5E76\u5355\u5143\u683C", "\u6570\u636E"],
    skill_type: "prompt-template",
    content: '# \u8868\u683C\u63D0\u53D6\uFF08\u5408\u5E76\u5355\u5143\u683C\u8981\u6309\u5217\u5BF9\u9F50\uFF09\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u770B\u6E05\u9875\u9762\u4E0A\u6709\u51E0\u5F20\u8868\u3001\u8981\u7684\u662F\u54EA\u4E00\u5F20\uFF1B\n2. **\u7528 `inspect_element({ op: "table", selector })` \u53D6\u6570\u636E** \u2014\u2014 \u4E0D\u8981\u81EA\u5DF1\u9010\u884C\u8BFB\u5355\u5143\u683C\uFF1B\n3. \u6838\u5BF9\u8FD4\u56DE\u7684**\u5217\u6570**\u4E0E\u8868\u5934\uFF1A\u5408\u5E76\u5355\u5143\u683C\u5C55\u5F00\u540E\u5217\u6570\u5E94\u4E0E\u8868\u5934\u4E00\u81F4\uFF1B\n4. \u56DE\u7B54\u65F6\u7ED9\u51FA\u89C4\u6574\u7684\u8868\u683C\uFF08\u6216\u6309\u7528\u6237\u8981\u7684\u5B57\u6BB5\u5217\u51FA\uFF09\uFF0C\u5E76\u8BF4\u660E\u5171\u51E0\u884C\u51E0\u5217\u3002\n\n## \u4E3A\u4EC0\u4E48\u7EDD\u5BF9\u4E0D\u80FD"\u9010\u884C\u8BFB\u5355\u5143\u683C"\n\u6709\u5408\u5E76\u5355\u5143\u683C\u65F6\uFF0C`rowspan` \u4F1A\u8BA9**\u540E\u7EED\u884C\u5728 DOM \u91CC\u5C11\u4E00\u4E2A td**\u3002\n\u4E8E\u662F"\u7B2C N \u4E2A td \u5C31\u662F\u7B2C N \u5217"\u8FD9\u4E2A\u5047\u8BBE\u4E0D\u6210\u7ACB \u2014\u2014 \u5178\u578B\u75C7\u72B6\u662F**\u6574\u5F20\u8868\u5DE6\u79FB\u4E00\u683C**\uFF1A\n\u300C\u533A\u57DF\u300D\u5217\u7684\u503C\u6D88\u5931\u4E86\uFF0C\u800C\u300C\u5546\u54C1\u300D\u5217\u7684\u503C\u8DD1\u5230\u4E86\u300C\u533A\u57DF\u300D\u5217\u4E0A\uFF0C\u4E4B\u540E\u6BCF\u4E00\u5217\u90FD\u9519\u4F4D\u3002\n`op: "table"` \u4F1A\u7528\u5360\u4F4D\u7B97\u6CD5\u628A\u8868\u683C\u8FD8\u539F\u6210\u77E9\u5F62\u7F51\u683C\uFF0C\u8FD9\u662F\u5B83\u5B58\u5728\u7684**\u552F\u4E00\u7406\u7531**\u3002\n\u540C\u7406**\u4E0D\u8981\u7528 `run_javascript` \u9010\u884C\u53D6 `td` \u6587\u672C** \u2014\u2014 \u9047\u5230\u5408\u5E76\u5355\u5143\u683C\u5FC5\u7136\u5217\u9519\u4F4D\u3002\n\n## \u4E24\u4E2A\u53C2\u6570\n- `fillMerged`\uFF08\u9ED8\u8BA4 `true`\uFF09\uFF1A\u5408\u5E76\u5355\u5143\u683C\u7684**\u5EF6\u7EED\u683C**\u662F\u5426\u91CD\u590D\u586B\u5165\u540C\u4E00\u6587\u672C\u3002\n  \u9ED8\u8BA4 true \u66F4\u9002\u5408\u6309\u5217\u8BFB\u53D6\uFF08\u4E0D\u4F1A\u9047\u5230\u7A7A\u6D1E\uFF09\uFF1B\u8BBE `false` \u53EF\u4FDD\u7559"\u8FD9\u91CC\u662F\u5408\u5E76\u5EF6\u7EED"\u7684\u5FE0\u5B9E\u5F62\u6001\u3002\n- `maxRows` / `maxCols`\uFF1A\u884C/\u5217\u4E0A\u9650\uFF0C\u8868\u683C\u5F88\u5927\u65F6\u7528\u6765\u907F\u514D\u7206\u4E0A\u4E0B\u6587\u3002\n\n## \u5224\u636E\n\u63D0\u53D6\u6210\u529F != "\u5DE5\u5177\u8FD4\u56DE\u4E86 ok"\uFF0C\u800C\u662F\uFF1A**\u8868\u5934\u5217\u6570\u4E0E\u6570\u636E\u5217\u6570\u4E00\u81F4**\uFF0C\n\u4E14**\u6BCF\u4E2A\u5408\u5E76\u5355\u5143\u683C\u7684\u503C\u51FA\u73B0\u5728\u5B83\u8986\u76D6\u7684\u6BCF\u4E00\u884C\u4E0A**\uFF08\u4F8B\u5982\u8DE8\u4E24\u884C\u7684\u300C\u534E\u4E1C\u300D\u5728\u4E24\u884C\u91CC\u90FD\u6709\uFF09\u3002\n\u5982\u679C\u53D1\u73B0\u67D0\u4E00\u884C\u6BD4\u8868\u5934\u5C11\u4E00\u683C\uFF0C\u8BF4\u660E\u5BF9\u9F50\u5931\u8D25 \u2014\u2014 \u5E94\u5982\u5B9E\u62A5\u544A\uFF0C\u800C\u4E0D\u662F\u628A\u90A3\u884C\u731C\u7740\u8865\u9F50\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u8868\u683C|\u8868|\u6570\u636E\u8868|\u5217\u8868\u6570\u636E", "\u63D0\u53D6|\u6574\u7406|\u5BFC\u51FA|\u8F6C\u6210"],
      tools: ["get_page_snapshot", "inspect_element", "complete_task"],
      playbook: "extract-merged-table"
    }
  },
  {
    name: "operate-in-cross-origin-iframe",
    displayName: "\u8DE8\u57DF iframe \u5185\u64CD\u4F5C\uFF08\u5148\u8BFB\u5408\u5E76\u5FEB\u7167\uFF0C\u518D\u6309\u590D\u5408 ref \u8DEF\u7531\uFF09",
    description: "\u8981\u64CD\u4F5C\u7684\u5185\u5BB9\u5728\u9875\u9762\u91CC\u7684 iframe / \u5185\u5D4C\u6846\u67B6\u4E2D\uFF08\u5C24\u5176\u662F\u4E0D\u540C\u6E90\u7684\uFF09\uFF0C\u9876\u5C42\u9875\u9762\u8BFB\u4E0D\u5230\u5B83\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u5728\u4E0B\u9762\u7684\u6846\u91CC\u64CD\u4F5C / \u5185\u5D4C\u7684\u68C0\u7D22\u91CC\u641C / \u90A3\u5757\u533A\u57DF\u70B9\u4E0D\u4E86\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser",
    tags: ["iframe", "\u8DE8\u57DF", "\u5185\u5D4C\u6846\u67B6", "\u590D\u5408 ref"],
    skill_type: "prompt-template",
    content: '# \u8DE8\u57DF iframe \u5185\u7684\u64CD\u4F5C\n\n## \u4E24\u6761\u90FD\u53EF\u884C\u7684\u8BFB\u6CD5\uFF08\u9009\u4E00\u6761\u8D70\uFF0C\u522B\u6DF7\u7740\u8BD5\uFF09\n\n**\u8DEF\u5F84 A\uFF1A\u4E00\u6B21\u8BFB\u5168\u90E8\u6846\u67B6**\n`get_page_snapshot({ includeFrames: true })` \u2014\u2014 \u5408\u5E76\u5FEB\u7167\u91CC\u4F1A\u51FA\u73B0\u6846\u67B6\u5185\u5143\u7D20\uFF0C\n\u5B83\u4EEC\u7684 ref \u5E26 `f<frameId>:` \u524D\u7F00\u3002\n\n**\u8DEF\u5F84 B\uFF1A\u5148\u679A\u4E3E\u518D\u9010\u6846\u67B6\u8BFB**\uFF08\u771F\u6A21\u578B\u5B9E\u6D4B\u66F4\u5E38\u7528\uFF09\n`list_frames` \u62FF\u5230\u5404\u6846\u67B6\u7684 frameId \u4E0E URL\uFF0C\u518D `get_page_snapshot({ frameId: N })` \u9010\u4E2A\u770B\u3002\n\u60F3\u77E5\u9053"\u9875\u9762\u91CC\u6709\u51E0\u4E2A\u6846\u67B6\u3001\u54EA\u4E2A\u662F\u8DE8\u57DF\u7684"\u65F6\uFF0C\u8FD9\u6761\u66F4\u76F4\u63A5\u3002\n\n## \u6B65\u9AA4\n1. \u7528\u4E0A\u9762\u4EFB\u4E00\u6761\u8BFB\u6CD5\u627E\u5230\u76EE\u6807\u6846\u67B6\u5185\u7684\u5143\u7D20\uFF1B\n2. \u7528**\u5E26 `f<frameId>:` \u524D\u7F00\u7684 ref**\uFF08\u5982 `f5:rf-4`\uFF09\u7167\u5E38\u8C03\u7528\n   `type_text` / `select_option` / `click_element` \u2014\u2014 \u524D\u7F00\u5C31\u662F\u5B83\u6240\u5728\u7684\u6846\u67B6\uFF0C\n   **\u4E0D\u9700\u8981\u81EA\u5DF1\u7B97 frameId**\uFF1B\n3. \u8BFB\u56DE\u6846\u67B6\u5185\u7684\u7ED3\u679C\u65F6\u7528**\u663E\u5F0F frameId**\uFF1A\n   `inspect_element({ op: "text", frameId: 5, selector: "#fres" })`\uFF1B\n4. \u6C47\u62A5\u65F6\u8BF4\u660E"\u64CD\u4F5C\u53D1\u751F\u5728\u4E00\u4E2A\u5185\u5D4C\u6846\u67B6\u91CC\uFF0C\u662F\u8DE8\u57DF\u7684"\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u522B\u5728\u9876\u5C42\u7528 selector \u786C\u627E\u6846\u67B6\u91CC\u7684\u5143\u7D20**\u3002\u4E0D\u540C\u6E90\u65F6\u9876\u5C42 DOM \u91CC**\u6839\u672C\u4E0D\u5B58\u5728**\u90A3\u4E9B\u8282\u70B9\uFF0C\n  \u53EA\u4F1A\u5F97\u5230"\u672A\u627E\u5230\u5143\u7D20"\uFF0C\u800C\u90A3\u4E0D\u662F"\u5143\u7D20\u4E0D\u5B58\u5728"\uFF0C\u662F**\u627E\u9519\u4E86\u6846\u67B6**\u3002\n- **\u522B\u7528 `run_javascript` \u53BB\u8BBF\u95EE `iframe.contentDocument`**\u3002\u8DE8\u57DF\u65F6\u5B83\u5FC5\u7136\u662F `null`\n  \uFF08\u6D4F\u89C8\u5668\u540C\u6E90\u7B56\u7565\uFF09\uFF0C\u800C\u4E14\u4F1A\u767D\u82B1\u4E00\u6B21\u5BA1\u6279\u3002\n- **\u6846\u67B6\u5185\u5143\u7D20\u4E5F\u53EF\u80FD\u9700\u8981\u7B49**\u3002\u82E5\u662F\u5F02\u6B65\u6E32\u67D3\uFF0C\u5148\u7528 `wait_for_element`\uFF08\u540C\u6837\u652F\u6301 frameId\uFF09\uFF0C\n  \u522B\u7ACB\u523B\u65AD\u8A00"\u6846\u67B6\u91CC\u6CA1\u6709"\u3002\n\n## \u600E\u4E48\u5224\u65AD\u54EA\u4E2A\u6846\u67B6\u662F\u8DE8\u57DF\u7684\n`list_frames` \u4F1A\u7ED9\u51FA\u5404\u6846\u67B6\u7684 URL\uFF1B**\u6E90\uFF08\u534F\u8BAE+\u57DF\u540D+\u7AEF\u53E3\uFF09\u4E0E\u9876\u5C42\u4E0D\u540C\u5C31\u662F\u8DE8\u57DF**\u3002\n\u540C\u6E90\u6846\u67B6\u867D\u7136\u53EF\u4EE5\u76F4\u63A5\u4ECE\u9876\u5C42\u8BFB\u5230\uFF0C\u4F46\u7EDF\u4E00\u8D70\u590D\u5408 ref \u66F4\u7701\u4E8B\u3001\u4E5F\u66F4\u4E0D\u5BB9\u6613\u51FA\u9519\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["iframe|\u5185\u5D4C|\u8DE8\u57DF|\u6846\u67B6\u91CC|\u4E0B\u9762\u7684\u6846", "\u6846\u67B6|\u5D4C\u5165|\u533A\u57DF"],
      tools: ["get_page_snapshot", "list_frames", "type_text", "select_option", "click_element", "inspect_element", "wait_for_element", "complete_task"],
      playbook: "operate-in-cross-origin-iframe"
    }
  },
  {
    name: "new-tab-takeover",
    displayName: "\u65B0\u6807\u7B7E\u9875\u63A5\u7BA1\uFF08\u70B9\u51FB\u540E\u6362\u9875\u7EE7\u7EED\u5E72\u6D3B\uFF09",
    description: '\u70B9\u51FB\u540E\u5185\u5BB9\u5728\u65B0\u6807\u7B7E\u9875\u91CC\u6253\u5F00\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u70B9\u5F00\u770B\u770B / \u6253\u5F00\u8BE6\u60C5 / \u4F1A\u5728\u65B0\u6807\u7B7E\u9875\u6253\u5F00\u300D\u65F6\u4F7F\u7528\uFF0C\u5C24\u5176\u662F\u70B9\u51FB\u540E\u5F53\u524D\u9875\u4F3C\u4E4E"\u6CA1\u6709\u90A3\u4E2A\u5143\u7D20"\u7684\u60C5\u51B5\u3002',
    version: "1.0.0",
    category: "browser",
    tags: ["\u65B0\u6807\u7B7E\u9875", "\u63A5\u7BA1", "\u6362\u9875", "\u8FDE\u7EED\u6027"],
    skill_type: "prompt-template",
    content: '# \u70B9\u51FB\u540E\u5F00\u4E86\u65B0\u6807\u7B7E\u9875\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u770B\u6E05\u5F53\u524D\u9875\uFF0C\u627E\u5230\u90A3\u4E2A\u4F1A\u6253\u5F00\u65B0\u9875\u7684\u94FE\u63A5/\u6309\u94AE\uFF1B\n2. \u7167\u5E38 `click_element` \u2014\u2014 **\u4E0D\u9700\u8981**\u4E8B\u5148\u505A\u4EC0\u4E48\u7279\u6B8A\u51C6\u5907\uFF1B\n3. **\u8BFB\u70B9\u51FB\u7ED3\u679C**\uFF1A\u82E5\u91CC\u9762\u5199\u7740\u300C\u68C0\u6D4B\u5230\u65B0\u6807\u7B7E\u9875\u5E76\u5DF2\u81EA\u52A8\u7ED1\u5B9A\u300D\uFF0C\u8BF4\u660E\n   **\u5F53\u524D\u64CD\u4F5C\u76EE\u6807\u5DF2\u7ECF\u6362\u6210\u65B0\u9875\u4E86**\uFF0C\u540E\u9762\u7684\u8BFB\u53D6/\u64CD\u4F5C\u90FD\u4F1A\u843D\u5728\u65B0\u9875\u4E0A\uFF1B\n4. \u7EE7\u7EED\u5728\u65B0\u9875\u4E0A\u5E72\u6D3B\uFF08\u8BFB\u53D6\u5185\u5BB9\u3001\u7EE7\u7EED\u70B9\u51FB\u2026\uFF09\uFF0C**\u4E0D\u8981**\u56DE\u5934\u53BB\u539F\u9875\u627E\u521A\u624D\u8981\u770B\u7684\u4E1C\u897F\u3002\n   \u8BFB\u56DE\u5185\u5BB9\u6700\u7B80\u5355\u7684\u505A\u6CD5\u5C31\u662F `read_current_page` \u6216 `get_page_snapshot` \u2014\u2014\n   \u5B83\u4EEC\u8BFB\u7684\u662F**\u5F53\u524D\u5DF2\u7ED1\u5B9A\u7684\u6807\u7B7E\u9875**\uFF0C\u7ED1\u5B9A\u53D1\u751F\u5728\u70B9\u51FB\u90A3\u4E00\u523B\uFF0C\u6240\u4EE5\u4F60\u4E0D\u7528\u505A\u4EFB\u4F55\u989D\u5916\u5904\u7406\uFF1B\n5. \u6C47\u62A5\u65F6\u8BF4\u660E"\u5185\u5BB9\u5728\u65B0\u6807\u7B7E\u9875\u91CC\uFF0C\u5DF2\u5207\u8FC7\u53BB\u8BFB\u4E86"\u3002\n\n## \u6700\u5BB9\u6613\u72AF\u7684\u9519\uFF1A\u56DE\u539F\u9875\u627E\n\u70B9\u51FB\u4E4B\u540E\u5982\u679C\u62FF\u5230\u300C\u672A\u627E\u5230\u5143\u7D20\u300D\uFF0C**\u5148\u6000\u7591"\u9875\u9762\u5DF2\u7ECF\u6362\u4E86"**\uFF0C\u800C\u4E0D\u662F"\u8FD9\u4E2A\u5143\u7D20\u4E0D\u5B58\u5728"\u3002\n\u5178\u578B\u573A\u666F\uFF1A\u70B9"\u67E5\u770B\u8BE6\u60C5"\u2192 \u8BE6\u60C5\u5728\u65B0\u9875 \u2192 \u4F60\u4ECD\u5728\u539F\u9875\u627E\u8BE6\u60C5\u6B63\u6587 \u2192 \u5FC5\u7136\u627E\u4E0D\u5230\uFF0C\n\u7136\u540E\u53EF\u80FD\u5F97\u51FA"\u8BE6\u60C5\u9875\u6253\u4E0D\u5F00"\u7684\u9519\u8BEF\u7ED3\u8BBA\u3002\n\u5224\u65AD\u4F9D\u636E\u5C31\u662F\u70B9\u51FB\u7ED3\u679C\u91CC\u90A3\u53E5\u300C\u5DF2\u81EA\u52A8\u7ED1\u5B9A\u300D\u4EE5\u53CA\u5B83\u9644\u5E26\u7684**\u65B0\u9875\u5FEB\u7167\u6458\u8981**\u3002\n\n## \u4E09\u4E2A\u6CE8\u610F\u70B9\n- **\u4E0D\u9700\u8981\u624B\u52A8\u5207\u9875**\uFF1A\u68C0\u6D4B\u5230\u65B0\u6807\u7B7E\u9875\u65F6\u4F1A\u81EA\u52A8\u7ED1\u5B9A\u3002\u53EA\u6709\u5728**\u6CA1\u6709**\u81EA\u52A8\u7ED1\u5B9A\u7684\u63D0\u793A\u3001\n  \u800C\u4F60\u786E\u8BA4\u786E\u5B9E\u5F00\u4E86\u65B0\u9875\u65F6\uFF0C\u624D\u8003\u8651\u7528 `switch_tab` \u4E4B\u7C7B\u7684\u663E\u5F0F\u624B\u6BB5\u3002\n- **\u65B0\u9875\u53EF\u80FD\u8FD8\u6CA1\u5C31\u7EEA**\uFF1A\u82E5\u65B0\u9875\u5185\u5BB9\u811A\u672C\u5C1A\u672A\u52A0\u8F7D\uFF0C\u7ED3\u679C\u91CC\u4F1A\u63D0\u793A\uFF1B\n  \u7A0D\u540E\u518D\u53D6\u4E00\u6B21\u5FEB\u7167\uFF0C\u6216\u7528 `wait_for_element` \u7B49\u76EE\u6807\u5143\u7D20\u51FA\u73B0\u3002\n- **\u522B\u628A"\u6253\u5F00\u4E86\u65B0\u9875"\u5F53\u6210"\u4EFB\u52A1\u5B8C\u6210"**\uFF1A\u7528\u6237\u7684\u8BF7\u6C42\u901A\u5E38\u662F"\u628A\u8BE6\u60C5\u544A\u8BC9\u6211"\uFF0C\n  \u6240\u4EE5\u5FC5\u987B\u5728\u65B0\u9875\u4E0A\u628A\u5185\u5BB9\u8BFB\u56DE\u6765\uFF0C\u800C\u4E0D\u662F\u505C\u5728"\u5DF2\u70B9\u51FB"\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u65B0\u6807\u7B7E\u9875|\u65B0\u7A97\u53E3|\u6253\u5F00\u8BE6\u60C5|\u67E5\u770B\u8BE6\u60C5|\u94FE\u63A5\u6253\u5F00", "\u63A5\u7BA1|\u5207\u6362|\u6362\u9875"],
      tools: ["get_page_snapshot", "read_current_page", "click_element", "inspect_element", "wait_for_element", "complete_task"],
      playbook: "new-tab-takeover"
    }
  },
  {
    name: "paginate-async",
    displayName: "\u5206\u9875 + \u5F02\u6B65\u52A0\u8F7D\uFF08\u8DE8\u9875\u627E\u5230\u76EE\u6807\uFF0C\u5E76\u7B49\u5B83\u771F\u7684\u6E32\u67D3\u51FA\u6765\uFF09",
    description: '\u76EE\u6807\u4E0D\u5728\u5F53\u524D\u9875\u3001\u9700\u8981\u7FFB\u9875\u6216\u6EDA\u52A8\u52A0\u8F7D\u624D\u80FD\u627E\u5230\u65F6\u4F7F\u7528\uFF1B\u4E5F\u7528\u4E8E"\u7FFB\u9875/\u52A0\u8F7D\u540E\u5185\u5BB9\u8FC7\u4E00\u4F1A\u513F\u624D\u51FA\u73B0"\u7684\u60C5\u51B5\u3002\u5F53\u7528\u6237\u8BF4\u300C\u7FFB\u9875\u627E / \u7B2C\u51E0\u9875 / \u52A0\u8F7D\u66F4\u591A / \u627E\u904D\u6574\u4E2A\u5217\u8868\u300D\u65F6\u4F7F\u7528\u3002',
    version: "1.0.0",
    category: "browser",
    tags: ["\u5206\u9875", "\u5F02\u6B65", "\u52A0\u8F7D\u66F4\u591A", "\u8DE8\u9875"],
    skill_type: "prompt-template",
    content: '# \u5206\u9875 / \u5F02\u6B65\u52A0\u8F7D\uFF1A\u8DE8\u9875\u627E\u76EE\u6807\n\n## \u4E24\u4E2A\u96BE\u70B9\uFF0C\u5FC5\u987B\u5206\u522B\u5BF9\u4ED8\n1. **\u8DE8\u9875**\uFF1A\u76EE\u6807\u4E0D\u5728\u5F53\u524D\u9875 \u2014\u2014 \u4E0D\u7FFB\u9875\u5C31\u6C38\u8FDC\u627E\u4E0D\u5230\u3002\n   \u800C"\u8FD9\u4E00\u9875\u6CA1\u6709"\u4E0E"\u6574\u7AD9\u6CA1\u6709"**\u662F\u4E24\u4EF6\u4E8B**\uFF0C\u524D\u8005\u4E0D\u80FD\u5F53\u4F5C\u7ED3\u8BBA\u3002\n2. **\u5F02\u6B65**\uFF1A\u70B9\u300C\u4E0B\u4E00\u9875\u300D\u6216\u300C\u52A0\u8F7D\u66F4\u591A\u300D\u4E4B\u540E\uFF0C\u5217\u8868\u5E38\u5E38**\u5148\u6E05\u7A7A\u3001\u8FC7\u4E00\u4F1A\u513F\u624D\u586B**\u3002\n   \u4E8E\u662F"\u70B9\u5B8C\u7ACB\u523B\u8BFB"\u4F1A\u62FF\u5230**\u7A7A\u5217\u8868** \u2014\u2014 \u800C\u7A7A\u5217\u8868\u6781\u5BB9\u6613\u88AB\u8BEF\u8BFB\u6210"\u8FD9\u9875\u6CA1\u5185\u5BB9"\u3002\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` / `inspect_element({ op: "text" })` \u8BFB\u5F53\u524D\u9875\uFF0C\u786E\u8BA4\u76EE\u6807\u5728\u4E0D\u5728\u8FD9\u91CC\uFF1B\n2. \u4E0D\u5728\u5C31\u7FFB\u9875\uFF1A`click_element` \u70B9\u300C\u4E0B\u4E00\u9875 / \u52A0\u8F7D\u66F4\u591A\u300D\uFF08\u6216\u7528\u5206\u9875\u63A7\u4EF6\u7684\u9875\u7801\uFF09\uFF1B\n3. **\u7FFB\u9875\u540E\u4E0D\u8981\u7ACB\u523B\u8BFB** \u2014\u2014 \u5148 `wait_for_element`\uFF1A\n   - \u77E5\u9053\u76EE\u6807\u6587\u672C\u7528 `{ state: "text_contains", text: "\u76EE\u6807\u6587\u672C" }`\uFF08**\u6700\u7A33\uFF0C\u4F18\u5148\u7528\u5B83**\uFF09\uFF1B\n   - \u53EA\u77E5\u9053\u6761\u6570\u7528 `{ state: "count", count: 5 }`\uFF1B\n   - \u26A0 **\u9009\u62E9\u5668\u8981\u7528\u4F60\u5B9E\u9645\u5728\u5FEB\u7167\u91CC\u770B\u5230\u7684\u90A3\u4E2A**\uFF0C\u4E0D\u8981\u731C\u6807\u7B7E\u540D\u3002\n     \u771F\u6A21\u578B\u5B9E\u6D4B\u8E29\u8FC7\uFF1A\u5217\u8868\u9879\u662F `div.item[role=listitem]`\uFF0C\u5B83\u5374\u5199\u4E86 `selector: "li"` \u2014\u2014\n     \u6761\u4EF6\u6C38\u8FDC\u4E0D\u6210\u7ACB\uFF0C\u767D\u767D\u7B49\u6EE1\u8D85\u65F6\u624D\u7EE7\u7EED\uFF08\u7ED3\u679C\u5BF9\uFF0C\u4F46\u6162\uFF09\u3002\n     \u4E0D\u786E\u5B9A\u9009\u62E9\u5668\u65F6\uFF0C\u76F4\u63A5\u7528 `text_contains` \u66F4\u7701\u4E8B\u3002\n   - \u81F3\u5C11\u7B49\u5230\u300C\u4E0A\u4E00\u9875\u6CA1\u6709\u3001\u8FD9\u4E00\u9875\u5E94\u8BE5\u6709\u300D\u7684\u67D0\u4E2A\u6807\u8BB0\u51FA\u73B0\u3002\n4. \u8BFB\u56DE\u8FD9\u4E00\u9875\uFF0C\u5224\u65AD\u76EE\u6807\u662F\u5426\u51FA\u73B0\uFF1B\u51FA\u73B0\u5373\u505C\uFF0C**\u4E0D\u8981\u591A\u7FFB**\uFF1B\n5. \u7FFB\u5230\u6700\u540E\u4E00\u9875\u4ECD\u6CA1\u6709\uFF0C\u624D\u80FD\u8BF4"\u6574\u4E2A\u5217\u8868\u91CC\u6CA1\u6709"\uFF0C\u5E76\u8BF4\u660E**\u4F60\u7FFB\u4E86\u51E0\u9875**\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u4E0D\u8981\u628A\u7A7A\u5217\u8868\u5F53\u7ED3\u8BBA\u3002** \u8BFB\u5230 0 \u6761\u65F6\u5148\u5206\u6E05\u662F"\u52A0\u8F7D\u4E2D"\u8FD8\u662F"\u771F\u7684\u7A7A"\u2014\u2014\n  \u524D\u8005\u8981\u7B49\uFF0C\u540E\u8005\u624D\u662F\u4FE1\u606F\u3002\n- **\u4E0D\u8981\u591A\u7FFB\u3002** \u627E\u5230\u5C31\u505C\uFF1B\u591A\u7FFB\u4F1A\u6539\u53D8\u9875\u9762\u72B6\u6001\uFF0C\u53EF\u80FD\u8BA9\u540E\u7EED\u5224\u65AD\u5931\u51C6\u3002\n- **\u7ED3\u8BBA\u91CC\u5E26\u4E0A\u7FFB\u9875\u8303\u56F4**\uFF08"\u7FFB\u5B8C 3 \u9875\u5171 15 \u6761\uFF0C\u6CA1\u6709\u5339\u914D"\uFF09\uFF0C\n  \u8FD9\u6837\u7528\u6237\u80FD\u5224\u65AD\u662F"\u786E\u5B9E\u6CA1\u6709"\u8FD8\u662F"\u4F60\u6CA1\u7FFB\u5230\u5E95"\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u7FFB\u9875|\u5206\u9875|\u4E0B\u4E00\u9875|\u52A0\u8F7D\u66F4\u591A|\u7FFB\u5230|\u7B2C\u51E0\u9875", "\u5217\u8868|\u627E|\u627E\u5230|\u904D\u5386"],
      tools: ["get_page_snapshot", "inspect_element", "click_element", "wait_for_element", "complete_task"],
      playbook: "paginate-async"
    }
  },
  {
    name: "pierce-shadow-dom",
    displayName: "\u7EC4\u4EF6\u5185\u64CD\u4F5C\uFF08\u7A7F\u900F Shadow DOM\uFF09",
    description: "\u76EE\u6807\u5143\u7D20\u5728\u81EA\u5B9A\u4E49\u7EC4\u4EF6 / Web Component \u7684 shadow DOM \u91CC\uFF0C\u7528\u666E\u901A\u9009\u62E9\u5668\u627E\u4E0D\u5230\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u5728\u7EC4\u4EF6\u91CC / \u90A3\u4E2A\u5C0F\u7EC4\u4EF6\u91CC / \u9009\u62E9\u5668\u627E\u4E0D\u5230\u4F46\u9875\u9762\u4E0A\u660E\u660E\u6709\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser",
    tags: ["Shadow DOM", "\u7EC4\u4EF6", "Web Component", "\u7A7F\u900F"],
    skill_type: "prompt-template",
    content: '# \u76EE\u6807\u5728 Shadow DOM \u91CC\uFF08\u81EA\u5B9A\u4E49\u7EC4\u4EF6\u5185\uFF09\n\n## \u5148\u8BA4\u6E05\u75C7\u72B6\n`document.querySelector(sel)` \u627E\u4E0D\u5230\u67D0\u4E2A"\u9875\u9762\u4E0A\u660E\u660E\u770B\u5F97\u89C1"\u7684\u5143\u7D20\u65F6\uFF0C\n**\u7B2C\u4E00\u5ACC\u7591\u662F\u5B83\u5728 shadow root \u91CC** \u2014\u2014 \u800C\u4E0D\u662F"\u9875\u9762\u6CA1\u6709\u8FD9\u4E2A\u5143\u7D20"\u3002\n\u7528\u539F\u751F\u67E5\u8BE2\u770B\u9876\u5C42 DOM \u6811\uFF0Cshadow \u5185\u90E8\u7684\u4E1C\u897F**\u4E00\u4E2A\u90FD\u770B\u4E0D\u5230**\uFF08\u8FD4\u56DE null\uFF09\uFF0C\n\u4E8E\u662F\u5F88\u5BB9\u6613\u5F97\u51FA"\u6CA1\u6709\u8FD9\u4E2A\u5143\u7D20"\u7684\u9519\u8BEF\u7ED3\u8BBA\u3002\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u2014\u2014 RecallFlow \u7684\u5FEB\u7167**\u4F1A\u7A7F\u900F\u5F00\u653E shadow root**\uFF0C\n   \u7EC4\u4EF6\u5185\u7684\u53EF\u4EA4\u4E92\u5143\u7D20\u4F1A\u51FA\u73B0\u5728\u5143\u7D20\u5217\u8868\u91CC\uFF08\u8FD8\u53EF\u80FD\u6807\u51FA shadow \u6DF1\u5EA6\uFF09\uFF1B\n2. \u4F18\u5148\u7528 `role` + `name` \u5B9A\u4F4D\uFF08\u7EC4\u4EF6\u5185\u90E8\u7684\u6309\u94AE/\u8F93\u5165\u6846\u901A\u5E38\u6709\u53EF\u8BBF\u95EE\u540D\uFF09\uFF0C\n   \u6216\u76F4\u63A5\u7528\u5FEB\u7167\u7ED9\u51FA\u7684 `ref`\uFF1B\n3. \u7528 `selector` \u4E5F\u53EF\u4EE5\uFF1A**RecallFlow \u7684\u9009\u62E9\u5668\u67E5\u8BE2\u672C\u8EAB\u4F1A\u9012\u5F52\u7A7F\u900F\u5F00\u653E shadow root**\uFF0C\n   \u5305\u62EC**\u591A\u5C42\u5D4C\u5957**\uFF08shadow \u91CC\u5957 shadow\uFF09\u3002\u6240\u4EE5 `#q` \u8FD9\u79CD\u7EC4\u4EF6\u5185\u7684 id \u76F4\u63A5\u5199\u5C31\u884C\uFF1B\n4. \u7167\u5E38 `type_text` / `click_element` / `inspect_element({ op: "text" })`\uFF1B\n5. \u82E5\u786E\u5B9E\u8BFB\u4E0D\u5230\uFF0C\u518D\u8003\u8651 closed shadow root\uFF08\u89C1\u4E0B\uFF09\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u522B\u7528 `run_javascript` \u81EA\u5DF1\u5199 `shadowRoot.querySelector` \u9012\u5F52**\u3002\n  \u5DE5\u5177\u5185\u7F6E\u7684\u67E5\u8BE2\u5DF2\u7ECF\u7A7F\u900F\u4E86\uFF0C\u81EA\u5DF1\u5199\u4E00\u904D\u65E2\u767D\u82B1\u4E00\u6B21\u5BA1\u6279\uFF0C\u53C8\u5BB9\u6613\u6F0F\u6389\u5D4C\u5957\u5C42\u3002\n- **\u522B\u56E0\u4E3A `querySelector` \u8FD4\u56DE null \u5C31\u65AD\u8A00"\u9875\u9762\u4E0A\u6CA1\u6709"**\u3002\u90A3\u4E2A null \u53EA\u8BF4\u660E\n  "\u9876\u5C42 DOM \u91CC\u6CA1\u6709"\uFF0C\u4E0D\u8BF4\u660E"\u9875\u9762\u4E0A\u6CA1\u6709"\u3002\n- **closed shadow root \u8BFB\u4E0D\u5230**\uFF1A`attachShadow({mode:"closed"})` \u7684\u7EC4\u4EF6\uFF0C\n  \u5916\u90E8\u62FF\u4E0D\u5230 `shadowRoot`\uFF0C\u5DE5\u5177\u4E5F\u7A7F\u900F\u4E0D\u4E86\u3002\u8FD9\u65F6\u5E94**\u5982\u5B9E\u8BF4\u660E**\uFF0C\n  \u5E76\u5EFA\u8BAE\u6539\u7528\u53EF\u8BBF\u95EE\u6027\u6811\uFF08`get_ax_snapshot`\uFF09\u6216\u5750\u6807\u70B9\u51FB\uFF0C\u800C\u4E0D\u662F\u786C\u8BD5\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u7EC4\u4EF6|shadow|\u5F71\u5B50|\u81EA\u5B9A\u4E49\u5143\u7D20|web component", "\u627E\u4E0D\u5230|\u8BFB\u4E0D\u5230|\u9009\u62E9\u5668"],
      tools: ["get_page_snapshot", "type_text", "click_element", "inspect_element", "get_ax_snapshot", "complete_task"],
      playbook: "pierce-shadow-dom"
    }
  },
  {
    name: "cdp-drag-slider",
    displayName: "\u62D6\u62FD\uFF08\u6ED1\u5757 / \u81EA\u5B9A\u4E49\u6392\u5E8F\u7B49\u9F20\u6807\u4E8B\u4EF6\u578B\u63A7\u4EF6\uFF09",
    description: "\u9700\u8981\u4E00\u4E2A\u5143\u7D20\u62D6\u5230\u53E6\u4E00\u4E2A\u4F4D\u7F6E\u65F6\u4F7F\u7528\uFF1A\u6ED1\u5757\u3001\u97F3\u91CF\u6761\u3001\u81EA\u5B9A\u4E49\u6392\u5E8F\u3001\u753B\u5E03\u4E0A\u7684\u62D6\u52A8\u7B49\u3002\u5F53\u7528\u6237\u8BF4\u300C\u62D6\u5230 / \u62C9\u5230 / \u8C03\u5230\u67D0\u4E2A\u523B\u5EA6\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u62D6\u62FD", "\u6ED1\u5757", "CDP", "\u53EF\u4FE1\u8F93\u5165"],
    skill_type: "prompt-template",
    content: '# \u62D6\u62FD\uFF08\u6ED1\u5757 / \u81EA\u5B9A\u4E49\u6392\u5E8F\uFF09\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u627E\u5230**\u8D77\u70B9**\u4E0E**\u7EC8\u70B9**\u4E24\u4E2A\u5143\u7D20\uFF1B\n2. **\u7EC8\u70B9\u5FC5\u987B\u9009"\u8868\u793A\u76EE\u6807\u4F4D\u7F6E"\u7684\u90A3\u4E2A\u5143\u7D20**\uFF08\u523B\u5EA6\u3001\u76EE\u6807\u5361\u7247\u3001\u76EE\u6807\u5355\u5143\u683C\uFF09\uFF0C\n   **\u4E0D\u8981\u9009\u5BB9\u5668** \u2014\u2014 \u62D6\u5230\u5BB9\u5668\u4E0A\u843D\u70B9\u662F\u5B83\u7684**\u4E2D\u5FC3**\uFF0C\u901A\u5E38\u4E0D\u662F\u4F60\u8981\u7684\u4F4D\u7F6E\u3002\n   \u771F\u6A21\u578B\u5B9E\u6D4B\u8E29\u8FC7\uFF1A\u76EE\u6807\u662F"\u62D6\u5230 80 \u523B\u5EA6"\uFF0C\u5B83\u5374\u62D6\u5230\u4E86 `#track`\uFF08\u8F68\u9053\u4E2D\u5FC3 = 50%\uFF09\uFF0C\n   \u4E8E\u662F\u6CA1\u5230\u4F4D\uFF0C\u53EA\u80FD\u53CD\u590D\u6539\u8DEF\u7EBF\uFF1B\n3. `drag_element({ fromSelector, toSelector })` \u2014\u2014 \u8D77\u70B9\u7528 `from*`\u3001\u7EC8\u70B9\u7528 `to*`\uFF1B\n4. **\u8BFB\u56DE\u7ED3\u679C\u503C**\u518D\u6C47\u62A5\uFF1A\u62D6\u62FD\u5DE5\u5177\u53EA\u80FD\u56DE\u62A5"\u5DF2\u4ECE (x,y) \u62D6\u62FD\u5230 (x,y)"\uFF0C\n   \u90A3\u8BF4\u660E\u7684\u662F**\u6D3E\u53D1\u6210\u529F**\uFF0C\u4E0D\u7B49\u4E8E"\u503C\u771F\u7684\u53D8\u4E86"\u3002\u7528 `inspect_element({ op: "values" })`\n   \u6216\u8BFB\u90A3\u4E2A\u663E\u793A\u7ED3\u679C\u7684\u5143\u7D20\u6765\u786E\u8BA4\u3002\n\n## \u4E09\u4E2A\u5FC5\u987B\u77E5\u9053\u7684\u9650\u5236\n- **\u4E24\u7AEF\u53EA\u652F\u6301 `ref` / `selector` / `text`\uFF0C\u6CA1\u6709 role+name\u3002**\n  \u8FD9\u4E0E\u5176\u4ED6\u5DE5\u5177\u4E0D\u540C \u2014\u2014 \u7528 `fromRole`/`toRole` \u4F20\u8FDB\u53BB\u4E0D\u4F1A\u88AB\u8BC6\u522B\uFF0C\u4F1A\u5F97\u5230"\u672A\u627E\u5230\u5143\u7D20"\u3002\n  \u6240\u4EE5\u5148\u53D6\u5FEB\u7167\u62FF `ref`\uFF0C\u6216\u7528 CSS \u9009\u62E9\u5668\u3002\n- **\u9700\u8981 CDP \u8F93\u5165\u5C42**\uFF1A\u62D6\u62FD\u7ECF `chrome.debugger` \u6D3E\u53D1**\u771F\u5B9E\u9F20\u6807\u4E8B\u4EF6**\uFF0C\n  \u672A\u5F00\u542F CDP \u65F6\u4F1A\u76F4\u63A5\u62A5"\u62D6\u62FD\u9700\u8981 CDP \u8F93\u5165\u5C42\uFF08\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u5F00\u542F\uFF09"\u3002\n- **\u5B83\u6D3E\u53D1\u7684\u662F\u9F20\u6807\u4E8B\u4EF6\uFF0C\u4E0D\u662F HTML5 \u62D6\u653E\u4E8B\u4EF6\u3002**\n  \u7528 `draggable="true"` + `dragstart/drop` \u5B9E\u73B0\u7684\u63A7\u4EF6**\u4E0D\u4F1A\u54CD\u5E94**\uFF0C\n  \u8868\u73B0\u662F"\u62D6\u4E86\u4F46\u4EC0\u4E48\u90FD\u6CA1\u53D1\u751F"\u3002\u8FD9\u4E0D\u662F\u5DE5\u5177\u574F\u4E86 \u2014\u2014 \u8FD9\u7C7B\u63A7\u4EF6\u9700\u8981\u7684\u662F\u62D6\u653E\u4E8B\u4EF6\uFF0C\n  \u76EE\u524D\u6CA1\u6709\u5BF9\u5E94\u5DE5\u5177\uFF0C\u5E94**\u5982\u5B9E\u8BF4\u660E**\uFF0C\u5E76\u5EFA\u8BAE\u6539\u7528\u952E\u76D8\uFF08\u65B9\u5411\u952E\uFF09\u6216\u76F4\u63A5\u5728\u8F93\u5165\u6846\u91CC\u8BBE\u503C\u3002\n\n## \u5224\u636E\n\u5B8C\u6210\u7684\u6807\u51C6\u662F**\u76EE\u6807\u72B6\u6001\u771F\u7684\u53D8\u4E86**\uFF08\u503C/\u987A\u5E8F\u53D8\u4E86\u4E14\u8BFB\u5F97\u5230\uFF09\uFF0C\u800C\u4E0D\u662F"\u6211\u8C03\u7528\u8FC7\u62D6\u62FD"\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u62D6\u62FD|\u62D6\u5230|\u62D6\u52A8|\u62C9\u5230|\u6ED1\u5757|\u6392\u5E8F", "\u523B\u5EA6|\u4F4D\u7F6E|\u79FB\u52A8"],
      tools: ["get_page_snapshot", "drag_element", "inspect_element", "click_element", "complete_task"],
      playbook: "cdp-drag-slider"
    }
  },
  {
    name: "canvas-coordinate-click",
    displayName: "canvas / \u753B\u5E03\u4E0A\u7684\u6309\u94AE\uFF08\u6309\u5750\u6807\u70B9\u51FB\uFF09",
    description: "\u8981\u70B9\u7684\u4E1C\u897F\u753B\u5728 canvas \u4E0A\u3001DOM \u91CC\u6CA1\u6709\u5BF9\u5E94\u5143\u7D20\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u753B\u5E03\u4E0A\u90A3\u4E2A\u6309\u94AE / \u56FE\u4E0A\u7684\u6309\u94AE / \u70B9\u4E0D\u5230\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["canvas", "\u53EF\u8BBF\u95EE\u6027\u6811", "\u5750\u6807\u70B9\u51FB", "CDP"],
    skill_type: "prompt-template",
    content: '# canvas \u4E0A\u7684\u6309\u94AE\uFF1A\u53EA\u80FD\u6309\u5750\u6807\u70B9\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u5148\u770B\u6709\u6CA1\u6709\u53EF\u7528\u7684 DOM \u5143\u7D20\uFF08**\u5F88\u591A"\u753B\u5E03"\u5176\u5B9E\u53EA\u662F\u5957\u4E86 canvas \u7684\u666E\u901A DOM**\uFF0C\n   \u80FD\u7528 role+name \u5C31\u522B\u6309\u5750\u6807\uFF09\uFF1B\n2. \u786E\u8BA4\u786E\u5B9E\u6CA1\u6709\u53EF\u70B9\u4E2D\u7684 DOM \u5143\u7D20\u540E\uFF0C\u7528 `get_ax_snapshot` \u8BFB**\u53EF\u8BBF\u95EE\u6027\u6811**\uFF1A\n   \u5B83\u7ED9\u51FA\u4EA4\u4E92\u8282\u70B9\u7684 role\u3001\u540D\u79F0\u4E0E**\u89C6\u53E3\u5750\u6807**\uFF1B\n3. \u7528 `click_at({ x, y })` \u6309\u5750\u6807\u6D3E\u53D1**\u771F\u5B9E\u9F20\u6807\u70B9\u51FB**\uFF1B\n4. \u8BFB\u56DE\u9875\u9762\u72B6\u6001\u786E\u8BA4\u771F\u7684\u70B9\u4E2D\u4E86\uFF08\u800C\u4E0D\u662F"\u6D3E\u53D1\u4E86\u5C31\u7B97\u5B8C\u6210"\uFF09\u3002\n\n## \u4E3A\u4EC0\u4E48 DOM \u8DEF\u7EBF\u5728\u8FD9\u7C7B\u9875\u9762\u4E0A\u662F\u6B7B\u8DEF\n\u9875\u9762\u5E38\u5E38\u4E3A\u53EF\u8BBF\u95EE\u6027\u653E\u4E00\u5C42**\u540C\u540D\u540C\u4F4D\u7684\u8986\u76D6\u5143\u7D20**\uFF0C\u4F46\u90A3\u5C42\u662F `pointer-events:none` \u2014\u2014\n\u547D\u4E2D\u6D4B\u8BD5\u4F1A**\u7A7F\u8FC7\u5B83**\u843D\u5230 canvas \u4E0A\u3002\u4E8E\u662F\uFF1A\n- \u906E\u6321\u5224\u5B9A\u4F1A\u8BA4\u4E3A\u5B83"\u88AB canvas \u76D6\u4F4F"\uFF1B\n- `click_element` \u9000\u5316\u6210**\u7A0B\u5E8F\u5316 click**\uFF0C\u800C\u7A0B\u5E8F\u5316 click \u6D3E\u53D1\u5728\u8986\u76D6\u5143\u7D20\u81EA\u8EAB\u3001\n  **\u4E0D\u4F1A\u5192\u6CE1\u5230 canvas**\uFF08\u4E24\u8005\u662F\u5144\u5F1F\u8282\u70B9\uFF09\uFF1B\n- \u7ED3\u679C\u662F**\u4EC0\u4E48\u90FD\u6CA1\u53D1\u751F**\uFF0C\u5DE5\u5177\u8FD8\u53EA\u4F1A\u56DE\u62A5"\u5DF2\u6D3E\u53D1\uFF0C\u4F46\u9875\u9762\u5FEB\u7167\u6682\u672A\u89C2\u5BDF\u5230\u53D8\u5316" \u2014\u2014\n  \u8FD9\u53E5\u8BDD\u5F88\u5BB9\u6613\u88AB\u5F53\u6210"\u70B9\u4E86\u4F46\u9875\u9762\u6CA1\u53CD\u5E94"\uFF0C\u800C\u4E0D\u662F"\u8FD9\u6761\u8DEF\u6839\u672C\u8D70\u4E0D\u901A"\u3002\n**\u5224\u636E\u662F\u9875\u9762\u72B6\u6001\u771F\u7684\u53D8\u4E86**\uFF08\u6BD4\u5982\u51FA\u73B0\u4E86"\u5DF2\u70B9\u51FB\uFF1AX"\uFF09\uFF0C\u4E0D\u662F"\u6211\u8C03\u7528\u8FC7\u70B9\u51FB"\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u5148\u8BD5 DOM\uFF0C\u518D\u9000\u5750\u6807**\uFF1A\u5750\u6807\u70B9\u51FB\u66F4\u8106\uFF08\u5206\u8FA8\u7387\u3001\u7F29\u653E\u3001\u6EDA\u52A8\u90FD\u4F1A\u5F71\u54CD\uFF09\uFF0C\u80FD\u5B9A\u4F4D\u5230\u5143\u7D20\u5C31\u522B\u7528\u5750\u6807\u3002\n- **\u5750\u6807\u5FC5\u987B\u6765\u81EA `get_ax_snapshot`**\uFF08\u6216\u5FEB\u7167\u91CC\u7ED9\u51FA\u7684\u4F4D\u7F6E\uFF09\uFF0C\u4E0D\u8981\u51ED\u611F\u89C9\u4F30\u3002\n- **\u9700\u8981 CDP**\uFF1A`click_at` \u4E0E `get_ax_snapshot` \u90FD\u8D70 `chrome.debugger`\uFF0C\n  \u672A\u5F00\u542F\u65F6\u4F1A\u76F4\u63A5\u62A5"\u9700\u8981 CDP"\uFF0C\u90A3\u4E0D\u662F\u9875\u9762\u95EE\u9898\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u753B\u5E03|canvas|\u56FE\u4E0A|\u56FE\u8868\u91CC", "\u70B9\u4E0D\u5230|\u6309\u5750\u6807|\u53EF\u8BBF\u95EE\u6027"],
      tools: ["get_page_snapshot", "get_ax_snapshot", "click_at", "click_element", "inspect_element", "complete_task"],
      playbook: "canvas-coordinate-click"
    }
  },
  {
    name: "macro-save-replay",
    displayName: "\u5B8F\uFF1A\u628A\u5DF2\u9A8C\u8BC1\u7684\u591A\u6B65\u64CD\u4F5C\u5B58\u4E0B\u6765\uFF0C\u4E4B\u540E\u96F6 token \u56DE\u653E",
    description: "\u540C\u4E00\u5957\u591A\u6B65\u64CD\u4F5C\u8981\u91CD\u590D\u505A\u3001\u6216\u7528\u6237\u8981\u6C42\u300C\u5B58\u6210\u5B8F / \u4E0B\u6B21\u76F4\u63A5\u7528 / \u4E00\u952E\u91CD\u590D\u300D\u65F6\u4F7F\u7528\u3002\u628A\u4E00\u6B21\u6210\u529F\u7684\u6D41\u7A0B\u56FA\u5316\u4E3A\u5B8F\uFF0C\u4E4B\u540E\u56DE\u653E\u4E0D\u518D\u6D88\u8017\u63A8\u7406\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u5B8F", "\u56DE\u653E", "\u96F6 token", "\u590D\u7528"],
    skill_type: "prompt-template",
    content: '# \u5B8F\uFF1A\u628A\u505A\u8FC7\u7684\u6D41\u7A0B\u56FA\u5316\u4E0B\u6765\n\n## \u6B65\u9AA4\n1. **\u5148\u628A\u6D41\u7A0B\u5B8C\u6574\u505A\u4E00\u904D**\uFF08\u70B9\u54EA\u91CC\u3001\u586B\u4EC0\u4E48\u3001\u9009\u4EC0\u4E48\uFF09\u2014\u2014 \u5B8F\u8BB0\u5F55\u7684\u662F**\u4F60\u8FD9\u6B21\u5B9E\u9645\u505A\u8FC7\u7684\u52A8\u4F5C**\uFF0C\n   \u6CA1\u505A\u8FC7\u5C31\u5B58\u4E0D\u51FA\u4E1C\u897F\uFF1B\n2. `macro({ op: "save", name: "\u81EA\u5DF1\u8D77\u4E2A\u597D\u8BB0\u7684\u540D" })` \u4FDD\u5B58\uFF1B\n   \u8FD4\u56DE\u503C\u4F1A\u5199\u660E\u5B58\u4E86\u51E0\u6B65\uFF0C**\u7167\u8FD9\u4E2A\u6B65\u6570\u6838\u5BF9**\u662F\u5426\u628A\u8BE5\u8BB0\u7684\u8BB0\u5168\u4E86\uFF1B\n   **\u672C\u8F6E\u6CA1\u505A\u8FC7\u4E5F\u80FD\u5B58**\uFF1A\u540C\u4E00\u7AD9\u70B9**\u4E0A\u4E00\u8F6E**\uFF0830 \u5206\u949F\u5185\uFF09\u7684\u53EF\u91CD\u653E\u8F68\u8FF9\u4F1A\u88AB\u6682\u5B58\uFF0C\n   \u6B64\u65F6\u8FD4\u56DE\u503C\u4F1A\u6807\u660E"\u6765\u6E90\u662F\u4E0A\u4E00\u8F6E"\u2014\u2014 \u90A3\u5C31\u5FC5\u987B\u628A**\u6765\u6E90\u4E0E\u6B65\u6570**\u5982\u5B9E\u544A\u8BC9\u7528\u6237\uFF0C\n   \u5E76\u5EFA\u8BAE\u5148\u6838\u5BF9\uFF08`macro({op:"list"})`\uFF09\u6216\u8BD5\u8DD1\u4E00\u6B21\uFF0C\u4E0D\u8981\u5F53\u6210\u81EA\u5DF1\u521A\u5F55\u7684\uFF1B\n3. \u9700\u8981\u65F6 `macro({ op: "run", name: "..." })` \u56DE\u653E\uFF1B\n4. \u8BB0\u4E0D\u6E05\u540D\u5B57\u5C31 `macro({ op: "list" })` \u2014\u2014 **\u56DE\u653E\u65F6 name \u5FC5\u987B\u7167\u6284 list \u7ED9\u51FA\u7684\u503C**\uFF0C\n   \u4E0D\u8981\u81EA\u5DF1\u62FC\u6216\u5199\u63CF\u8FF0\uFF1B\n5. \u56DE\u653E\u540E**\u786E\u8BA4\u9875\u9762\u72B6\u6001\u771F\u7684\u53D8\u4E86**\uFF08\u8BA1\u6570\u3001\u5217\u8868\u3001\u72B6\u6001\u6587\u672C\uFF09\uFF0C\u4E0D\u8981\u53EA\u770B"\u56DE\u653E\u6210\u529F"\u3002\n\n## \u56DB\u4E2A\u5FC5\u987B\u77E5\u9053\u7684\u8FB9\u754C\n- **\u5B8F\u6309\u7AD9\u70B9\u5B58**\uFF1A\u6362\u57DF\u540D\u5C31\u627E\u4E0D\u5230\u540C\u4E00\u4E2A\u5B8F\u3002\n- **\u53EA\u8BB0\u5F55\u767D\u540D\u5355\u5185\u7684\u5DE5\u5177**\uFF08\u70B9\u51FB / \u8F93\u5165 / \u6309\u952E / \u9009\u62E9 / \u52FE\u9009 / \u6EDA\u52A8 / \u7B49\u5F85 / \u5F00\u9875\uFF09\u3002\n  `run_javascript`\u3001\u622A\u56FE\u3001\u8BFB\u53D6\u7C7B\u5DE5\u5177**\u90FD\u4E0D\u4F1A\u8FDB\u5B8F** \u2014\u2014 \u6240\u4EE5"\u8BFB\u4E00\u4E0B\u518D\u636E\u6B64\u5224\u65AD"\u8FD9\u79CD\u6D41\u7A0B\n  \u5B58\u4E0D\u8FDB\u5B8F\uFF0C\u5B8F\u53EA\u9002\u5408**\u786E\u5B9A\u7684\u91CD\u590D\u52A8\u4F5C\u5E8F\u5217**\u3002\n- **\u56DE\u653E\u4E0D\u63A5\u53D7\u53C2\u6570**\uFF1A\u5B8F\u6BCF\u4E00\u6B65\u90FD\u7528**\u5F53\u65F6\u8BB0\u5F55\u7684\u53C2\u6570**\u91CD\u653E\u3002\n  \u8981\u6362\u5173\u952E\u8BCD/\u6570\u91CF\u4E4B\u7C7B\u7684\u8F93\u5165\uFF0C\u4E0D\u80FD\u9760\u56DE\u653E\u540C\u4E00\u4E2A\u5B8F \u2014\u2014\n  \u5E94\u91CD\u65B0\u505A\u4E00\u904D\u518D\u4FDD\u5B58\u4E00\u4E2A\u65B0\u5B8F\uFF08\u4E0D\u540C\u540D\u5B57\uFF09\uFF0C\u6216\u76F4\u63A5\u7528\u666E\u901A\u5DE5\u5177\u505A\u90A3\u4E00\u6B65\u3002\n- **\u56DE\u653E\u7684\u662F"\u52A8\u4F5C"\uFF0C\u4E0D\u662F"\u72B6\u6001"** \u2014\u2014 \u6240\u4EE5\u8F93\u5165\u7C7B\u6B65\u9AA4\u8981**\u5E42\u7B49**\uFF1A\n  `type_text` \u4E0D\u5E26 `clearFirst` \u65F6\u9ED8\u8BA4\u662F**\u8FFD\u52A0**\uFF0C\u56DE\u653E\u4F1A\u5728\u5DF2\u6709\u5185\u5BB9\u540E\u9762\u518D\u63A5\u4E00\u6BB5\u3002\n  \u5B9E\u6D4B\uFF1A\u4E00\u6B21\u300C\u586B \u5496\u5561\u300D+ \u56DE\u653E\u4E00\u6B21\uFF0C\u5B57\u6BB5\u53D8\u6210\u300C\u5496\u5561\u5496\u5561\u300D\u3002\n  **\u8981\u5B58\u8FDB\u5B8F\u7684\u8F93\u5165\u6B65\u9AA4\u8BF7\u5E26 `clearFirst: true`**\uFF08\u8BB0\u5F55\u65F6\u624D\u4F1A\u628A\u6E05\u7A7A\u610F\u56FE\u4E00\u8D77\u5B58\u4E0B\u6765\uFF09\uFF0C\n  \u8FD9\u6837\u56DE\u653E\u4E24\u6B21\u7684\u7ED3\u679C\u624D\u4E00\u81F4\u3002\n- **\u4FDD\u5B58\u9700\u8981\u5BA1\u6279**\uFF08\u5B83\u662F\u5199\u64CD\u4F5C\uFF09\uFF0C\u56DE\u653E\u4E5F\u8981\u8FC7\u6267\u884C\u671F\u767D\u540D\u5355 \u2014\u2014\n  \u82E5\u5B8F\u91CC\u542B\u4E0D\u5141\u8BB8\u56DE\u653E\u7684\u5DE5\u5177\uFF0C\u56DE\u653E\u4F1A**\u5728\u90A3\u4E00\u683C\u91CC\u505C\u4E0B\u5E76\u544A\u8BC9\u4F60\u539F\u56E0**\u3002\n\n## \u6C89\u6DC0\u6210\u5B8F\uFF0C\u8FD8\u662F\u6280\u80FD\uFF1F\n- **\u5B8F**\uFF1A\u8981\u91CD\u590D\u7684\u662F**\u786E\u5B9A\u7684\u52A8\u4F5C\u5E8F\u5217**\u3001\u53C2\u6570\u4E0D\u53D8 \u2192 `macro({op:"save"})`\uFF0C\u56DE\u653E\u4E0D\u82B1\u63A8\u7406\u3002\n- **\u6280\u80FD**\uFF1A\u8981\u6C89\u6DC0\u7684\u662F**\u505A\u6CD5\u4E0E\u5224\u65AD**\uFF08\u9002\u7528\u573A\u666F\u3001\u8FB9\u754C\u3001\u5751\u3001\u5B8C\u6210\u5224\u636E\uFF09\u2192 `save_skill(...)` \u5199\u6210 SKILL.md\u3002\n  \u7528\u6237\u8BF4\u300C\u6C89\u6DC0\u4E3A\u6280\u80FD / \u8BB0\u4F4F\u8FD9\u4E2A\u6D41\u7A0B\u7684\u505A\u6CD5\u300D\u65F6\u7528 `save_skill`\uFF0C**\u4E0D\u8981\u62FF\u5B8F\u53BB\u9876**\uFF1A\n  \u5B8F\u5B58\u7684\u662F\u52A8\u4F5C\uFF08\u6362\u4E2A\u9875\u9762\u5C31\u5931\u6548\uFF09\uFF0C\u5B58\u4E0D\u4E0B\u7ECF\u9A8C\uFF1B\u53CD\u8FC7\u6765\uFF0C\u53EA\u6709\u52A8\u4F5C\u7684\u6D41\u7A0B\u5199\u6210\u6280\u80FD\u4E5F\u6CA1\u7528\u3002\n\n## \u4EC0\u4E48\u65F6\u5019\u503C\u5F97\u5B58\u5B8F\n\u540C\u4E00\u5957\u52A8\u4F5C**\u8981\u91CD\u590D\u505A**\u3001\u4E14**\u53C2\u6570\u4E0D\u53D8**\u65F6\u624D\u503C\u5F97\u3002\n\u4E00\u6B21\u6027\u7684\u64CD\u4F5C\u5B58\u6210\u5B8F\u53EA\u662F\u591A\u4E00\u6B65\uFF1B\u53C2\u6570\u6BCF\u6B21\u90FD\u4E0D\u540C\u7684\u6D41\u7A0B\uFF0C\u5B8F\u4E5F\u5E2E\u4E0D\u4E0A\u5FD9\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u5B58\u6210\u5B8F|\u5B8F|\u56DE\u653E|\u4E00\u952E\u91CD\u590D|\u4E0B\u6B21\u76F4\u63A5\u7528", "\u91CD\u590D|\u56FA\u5316|\u590D\u7528"],
      tools: ["macro", "get_page_snapshot", "type_text", "select_option", "click_element", "inspect_element", "complete_task"],
      playbook: "macro-save-replay"
    }
  },
  {
    name: "upload-file",
    displayName: '\u6587\u4EF6\u4E0A\u4F20\uFF08\u5DE5\u5177\u53EA\u8BF4"\u672A\u89C2\u6D4B"\uFF0C\u5FC5\u987B\u8BFB\u56DE\uFF09',
    description: "\u8981\u628A\u672C\u5730\u6587\u4EF6\u8BBE\u7F6E\u5230\u9875\u9762\u7684 file input \u4E0A\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u4E0A\u4F20\u8FD9\u4E2A\u6587\u4EF6 / \u628A\u8FD9\u4E2A\u6587\u4EF6\u4F20\u4E0A\u53BB / \u4E0A\u4F20\u9644\u4EF6\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u4E0A\u4F20", "\u6587\u4EF6", "file input", "CDP"],
    skill_type: "prompt-template",
    content: '# \u6587\u4EF6\u4E0A\u4F20\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u627E\u5230 `<input type="file">`\uFF08\u901A\u5E38\u6709\u300C\u9009\u62E9\u6587\u4EF6 / \u4E0A\u4F20\u300D\u4E4B\u7C7B\u7684\u53EF\u8BBF\u95EE\u540D\uFF09\uFF1B\n2. `upload_file({ selector, files: ["/\u7EDD\u5BF9/\u8DEF\u5F84"] })` \u2014\u2014 **files \u5FC5\u987B\u662F\u672C\u5730\u7EDD\u5BF9\u8DEF\u5F84**\uFF1B\n3. **\u8BFB\u56DE\u786E\u8BA4**\uFF08\u8FD9\u4E00\u6B65\u4E0D\u80FD\u7701\uFF0C\u7406\u7531\u89C1\u4E0B\uFF09\uFF1A\u8BFB\u9875\u9762\u4E0A\u663E\u793A\u6587\u4EF6\u540D\u7684\u5143\u7D20\uFF0C\n   \u6216\u786E\u8BA4\u72B6\u6001\u53D8\u6210\u4E86\u300C\u5DF2\u9009\u62E9 / \u5DF2\u63D0\u4EA4\u300D\uFF1B\n4. \u82E5\u9875\u9762\u8FD8\u9700\u8981\u70B9\u300C\u63D0\u4EA4 / \u4E0A\u4F20\u300D\u6309\u94AE\uFF0C\u518D\u70B9\u4E00\u6B21\u5E76\u518D\u6B21\u8BFB\u56DE\u3002\n\n## \u4E3A\u4EC0\u4E48"\u8FD4\u56DE ok"\u4E0D\u7B49\u4E8E"\u4F20\u4E0A\u53BB\u4E86"\n`upload_file` **\u6709\u610F\u5982\u5B9E\u62A5\u544A**\uFF1A\u5B83\u8FD4\u56DE `hadEffect:false`\uFF0C\u9A8C\u8BC1\u8BF4\u660E\u662F\n\u300C\u5DF2\u5411\u6587\u4EF6\u8F93\u5165\u6846\u8BBE\u7F6E\u6587\u4EF6\uFF08\u672A\u505A\u9875\u9762\u53D8\u5316\u89C2\u6D4B\uFF09\u300D\u2014\u2014\n\u56E0\u4E3A\u628A\u6587\u4EF6\u585E\u8FDB file input \u672C\u8EAB**\u4E0D\u4EA7\u751F\u53EF\u89C2\u5BDF\u7684\u9875\u9762\u53D8\u5316**\uFF08\u6587\u4EF6\u540D\u53EF\u80FD\u53EA\u51FA\u73B0\u5728 `input.value` \u91CC\uFF09\u3002\n\u8FD9\u662F**\u8BDA\u5B9E**\u800C\u4E0D\u662F\u5931\u8D25\uFF1A\u5B83\u6CA1\u6709\u8C0E\u62A5"\u9875\u9762\u53D8\u4E86"\u3002\n\u6240\u4EE5\u5224\u636E\u5FC5\u987B\u843D\u5728**\u9875\u9762\u72B6\u6001**\u4E0A\uFF08\u6587\u4EF6\u540D\u663E\u793A\u51FA\u6765\u4E86\u3001\u63D0\u4EA4\u6309\u94AE\u771F\u7684\u751F\u6548\u4E86\uFF09\uFF0C\n\u800C\u4E0D\u662F\u4E0A\u4F20\u5DE5\u5177\u8FD4\u56DE\u4E86\u4EC0\u4E48\u3002\n\n## \u4E09\u4E2A\u6CE8\u610F\u70B9\n- **\u9700\u8981 CDP**\uFF08\u8D70 `chrome.debugger` \u7684 `DOM.setFileInputFiles`\uFF09\uFF0C\u672A\u5F00\u542F\u4F1A\u76F4\u63A5\u62A5"\u9700\u8981 CDP"\u3002\n- **\u8DEF\u5F84\u5FC5\u987B\u662F\u672C\u673A\u5B58\u5728\u7684\u7EDD\u5BF9\u8DEF\u5F84**\u3002\u7528\u6237\u6CA1\u8BF4\u6E05\u8DEF\u5F84\u65F6\u5E94\u5F53**\u95EE\u6E05\u695A**\uFF0C\n  \u4E0D\u8981\u731C\u4E00\u4E2A\u8DEF\u5F84\u53BB\u8BD5 \u2014\u2014 \u731C\u9519\u53EA\u4F1A\u5F97\u5230"\u6587\u4EF6\u4E0D\u5B58\u5728"\u3002\n- **\u522B\u7528 `run_javascript` \u53BB\u4F2A\u9020 File \u5BF9\u8C61**\uFF1A\u90A3\u6837\u8BBE\u8FDB\u53BB\u7684 `files` \u5728\u771F\u5B9E\u63D0\u4EA4\u65F6\u662F\u65E0\u6548\u7684\n  \uFF08\u9875\u9762\u80FD\u8BFB\u5230\u3001\u4F46\u6CA1\u6709\u771F\u5B9E\u6587\u4EF6\u5185\u5BB9\uFF09\uFF0C\u800C\u4E14\u767D\u82B1\u4E00\u6B21\u9AD8\u5371\u5BA1\u6279\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u4E0A\u4F20|\u4E0A\u4F20\u6587\u4EF6|\u4E0A\u4F20\u9644\u4EF6|\u4F20\u4E0A\u53BB", "\u6587\u4EF6|\u9644\u4EF6|file"],
      tools: ["get_page_snapshot", "upload_file", "click_element", "inspect_element", "complete_task"],
      playbook: "upload-file"
    }
  },
  {
    name: "knowledge-save-retrieve",
    displayName: "\u77E5\u8BC6\u5E93\uFF1A\u5B58\u8FDB\u53BB\u8981\u80FD\u539F\u6837\u53D6\u56DE\u6765\uFF08\u540C\u4E00\u4E2A\u7F51\u5740\u4F1A\u4E92\u76F8\u8986\u76D6\uFF09",
    description: "\u8981\u628A\u4FE1\u606F\u8BB0\u8FDB\u77E5\u8BC6\u5E93\u3001\u6216\u4ECE\u77E5\u8BC6\u5E93\u68C0\u7D22/\u6838\u5BF9\u5DF2\u6709\u6761\u76EE\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u8BB0\u5230\u77E5\u8BC6\u5E93 / \u5B58\u8D77\u6765 / \u4ECE\u77E5\u8BC6\u5E93\u627E\u4E00\u4E0B / \u4E4B\u524D\u8BB0\u8FC7\u4EC0\u4E48\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "knowledge",
    tags: ["\u77E5\u8BC6\u5E93", "\u4FDD\u5B58", "\u68C0\u7D22", "\u5F80\u8FD4\u6838\u5BF9"],
    skill_type: "prompt-template",
    content: '# \u77E5\u8BC6\u5E93\u8BFB\u5199\n\n## \u6B65\u9AA4\n1. \u5148\u628A\u8981\u8BB0\u7684\u5185\u5BB9**\u770B\u51C6**\uFF08\u8BFB\u9875\u9762 / \u8BFB\u7528\u6237\u7ED9\u7684\u6750\u6599\uFF09\uFF1B\n2. `add_entry({ type, title, note, tags?, status?, url? })` \u2014\u2014 `type` \u4E0E `title` \u5FC5\u586B\uFF1B\n3. **\u8BFB\u56DE\u6765\u6838\u5BF9**\uFF1A`knowledge_read({ op: "get", id })` \u770B\u5355\u6761\uFF0C\n   \u6216 `op:"search"`\uFF08\u8981 query\uFF09/ `op:"list"`\uFF08\u53EF\u6309 type \u7B5B\uFF09\uFF1B\n4. \u786E\u8BA4\u53D6\u56DE\u6765\u7684\u5185\u5BB9\u4E0E\u8981\u8BB0\u7684\u4E00\u81F4\uFF0C\u518D\u5411\u7528\u6237\u6C47\u62A5\u3002\n\n## \u26A0 \u6700\u5927\u7684\u4E00\u4E2A\u5751\uFF1A**\u4F20\u4E86 url \u5C31\u7528 url \u5F53 id**\n`add_entry` \u7684 id \u662F `url || \u81EA\u52A8\u751F\u6210`\u3002\u4E5F\u5C31\u662F\u8BF4\uFF1A\n**\u540C\u4E00\u4E2A\u7F51\u5740\u53EA\u80FD\u6709\u4E00\u6761** \u2014\u2014 \u5BF9\u540C\u4E00\u9875\u518D\u5B58\u4E00\u6B21\u4F1A**\u8986\u76D6**\u4E0A\u4E00\u6761\uFF08\u8FD9\u662F\u8BBE\u8BA1\u4E0A\u7684\u53BB\u91CD\uFF09\uFF0C\n\u800C\u4E14\u6BCF\u6B21\u90FD\u8FD4\u56DE"\u5DF2\u4FDD\u5B58"\u3002\u6240\u4EE5\uFF1A\n- \u60F3\u8BB0\u540C\u4E00\u9875\u7684**\u591A\u6761**\u8981\u70B9\uFF1A\u653E\u8FDB**\u4E00\u6761**\u7684 `note` \u91CC\uFF0C\n  \u6216\u8005**\u90FD\u4E0D\u4F20 url**\uFF08\u5404\u81EA\u62FF\u5230\u4E00\u4E2A\u751F\u6210 id\uFF09\uFF1B\n- **\u5343\u4E07\u522B**"\u5206\u4E09\u6761\u5B58\u3001\u90FD\u5E26\u4E0A\u540C\u4E00\u4E2A\u7F51\u5740" \u2014\u2014 \u9759\u9ED8\u53EA\u5269\u6700\u540E\u4E00\u6761\u3002\n- \u5DF2\u5B58\u7684\u6761\u76EE\u88AB\u8986\u76D6\u540E**\u65E0\u6CD5\u6062\u590D**\uFF0C\u522B\u7528\u8BD5\u9519\u7684\u65B9\u5F0F\u53CD\u590D\u5B58\u3002\n\n## \u5176\u5B83\u6CE8\u610F\u70B9\n- `op:"get"` \u8981\u7684\u662F **id\uFF08\u901A\u5E38\u5C31\u662F url\uFF09**\uFF0C\u4E0D\u662F\u6807\u9898\uFF1B\n  \u4E0D\u786E\u5B9A id \u65F6\u5148 `op:"list"` \u770B\u6709\u54EA\u4E9B\u6761\u76EE\u3002\n- `op:"search"` \u662F**\u76F8\u4F3C\u5EA6\u68C0\u7D22**\uFF08\u8D70 RAG\uFF09\uFF0C\u4E0D\u662F\u7CBE\u786E\u5B50\u4E32\u5339\u914D\uFF1A\n  **\u68C0\u7D22\u4E0D\u5230\u4E0D\u7B49\u4E8E\u6CA1\u5B58\u8FDB\u53BB** \u2014\u2014 \u6362\u4E2A\u8BF4\u6CD5\u518D\u68C0\u7D22\uFF0C\u6216\u76F4\u63A5\u7528 `op:"list"` / `op:"get"` \u786E\u8BA4\u3002\n- **\u5199\u5165\u9700\u8981\u5BA1\u6279**\uFF08`add_entry` \u662F\u5199\u64CD\u4F5C\uFF09\uFF0C\u5220\u9664\u66F4\u662F\u4E0D\u53EF\u9006\uFF08`remove_entry`\uFF09\u3002\n- "\u5B58\u8FDB\u53BB\u4E86"\u7684\u5224\u636E\u662F**\u8BFB\u56DE\u6765\u80FD\u770B\u5230**\uFF0C\u4E0D\u662F `add_entry` \u8FD4\u56DE\u4E86\u6210\u529F\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u77E5\u8BC6\u5E93|\u8BB0\u5230|\u5B58\u8D77\u6765|\u7B14\u8BB0|\u6536\u85CF\u5230\u77E5\u8BC6\u5E93", "\u68C0\u7D22|\u6838\u5BF9|\u4E4B\u524D\u8BB0\u8FC7"],
      tools: ["add_entry", "knowledge_read", "remove_entry", "get_page_snapshot", "inspect_element", "complete_task"],
      playbook: "knowledge-save-retrieve"
    }
  },
  {
    name: "knowledge-search-fallback",
    displayName: "\u77E5\u8BC6\u5E93\u68C0\u7D22\u67E5\u4E0D\u5230\u65F6\uFF08\u67E5\u4E0D\u5230 \u2260 \u6CA1\u6709\uFF09",
    description: '\u5728\u77E5\u8BC6\u5E93\u91CC\u68C0\u7D22\u5374\u6CA1\u547D\u4E2D\u3001\u9700\u8981\u5224\u65AD"\u5230\u5E95\u6709\u6CA1\u6709\u8FD9\u6761\u8BB0\u5F55"\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u77E5\u8BC6\u5E93\u91CC\u6709\u6CA1\u6709\u2026 / \u5E2E\u6211\u627E\u627E\u4E4B\u524D\u8BB0\u7684\u2026\u300D\u800C\u68C0\u7D22\u843D\u7A7A\u65F6\u4F7F\u7528\u3002',
    version: "1.0.0",
    category: "knowledge",
    tags: ["\u77E5\u8BC6\u5E93", "\u68C0\u7D22", "\u53EC\u56DE", "\u56DE\u9000"],
    skill_type: "prompt-template",
    content: '# \u68C0\u7D22\u843D\u7A7A \u2260 \u77E5\u8BC6\u5E93\u91CC\u6CA1\u6709\n\n## \u5148\u8BA4\u6E05\u68C0\u7D22\u662F\u600E\u4E48\u5DE5\u4F5C\u7684\n\u77E5\u8BC6\u5E93\u68C0\u7D22\u662F**\u7EAF\u5B57\u7B26\u5339\u914D**\uFF08\u6309\u6807\u9898/\u6807\u7B7E/\u5907\u6CE8\u52A0\u6743\u6253\u5206\uFF09\uFF0C**\u4E0D\u61C2\u540C\u4E49\u8BCD**\uFF1A\n- \u7B14\u8BB0\u91CC\u5199\u300C\u9996\u5C4F\u7D22\u5F15\u9884\u70ED\u300D\uFF0C\u4F60\u67E5\u300C\u9884\u70ED\u300D**\u80FD**\u547D\u4E2D\uFF1B\n- \u4F46\u4F60\u67E5\u300C\u5361\u987F\u300D\u300C\u9875\u9762\u6253\u5F00\u5F88\u6162\u300D\u2014\u2014\u4E0E\u300C\u9884\u70ED / \u8D85\u65F6\u300D\u5728**\u5B57\u7B26\u5C42\u9762\u6BEB\u65E0\u4EA4\u96C6**\uFF0C\n  **\u5FC5\u7136\u843D\u7A7A**\uFF0C\u54EA\u6015\u90A3\u6761\u8BB0\u5F55\u8BB2\u7684\u5C31\u662F\u8FD9\u4EF6\u4E8B\u3002\n\n\u6240\u4EE5\u300C\u672A\u68C0\u7D22\u5230\u76F8\u5173\u77E5\u8BC6\u5E93\u6761\u76EE\u300D\u8FD9\u53E5\u8BDD\u53EA\u8BF4\u660E**\u8FD9\u6B21\u67E5\u8BE2\u7684\u8BCD\u9762\u6CA1\u5BF9\u4E0A**\uFF0C\n**\u4E0D\u8BF4\u660E\u77E5\u8BC6\u5E93\u91CC\u6CA1\u6709**\u3002\u7EDD\u4E0D\u80FD\u636E\u6B64\u56DE\u7B54\u7528\u6237"\u6CA1\u6709\u76F8\u5173\u8BB0\u5F55"\u3002\n\n## \u843D\u7A7A\u4E4B\u540E\u600E\u4E48\u529E\uFF08\u6309\u987A\u5E8F\u8BD5\uFF09\n1. **\u6362\u8BCD\u518D\u67E5**\uFF1A\u7528\u7B14\u8BB0\u91CC**\u53EF\u80FD\u51FA\u73B0\u7684\u539F\u8BDD**\u53BB\u67E5\uFF08\u6280\u672F\u540D\u8BCD\u3001\u4E13\u6709\u540D\u8BCD\u6BD4\u53E3\u8BED\u5F62\u5BB9\u66F4\u5BB9\u6613\u547D\u4E2D\uFF09\uFF1B\n2. `knowledge_read({ op: "list" })`\uFF1A\u628A\u672C\u7AD9\u5DF2\u5B58\u6761\u76EE**\u5217\u51FA\u6765**\u2014\u2014\n   \u6807\u9898/\u7C7B\u578B/\u6807\u7B7E\u8DB3\u4EE5\u8BA9\u4F60\u5224\u65AD"\u6709\u6CA1\u6709\u76F8\u5173\u7684"\uFF1B\u8FD9\u4E00\u6B65\u6700\u53EF\u9760\uFF0C\u522B\u8DF3\u8FC7\uFF1B\n3. `knowledge_read({ op: "get", id })`\uFF1A\u77E5\u9053 id\uFF08**\u901A\u5E38\u5C31\u662F url**\uFF09\u65F6\u76F4\u63A5\u8BFB\u90A3\u4E00\u6761\uFF1B\n   \u5982\u679C\u662F\u4F60**\u672C\u6B21\u521A\u5B58\u8FDB\u53BB\u7684**\uFF0Cid \u5C31\u5728 `add_entry` \u7684\u8FD4\u56DE\u91CC\uFF0C\u76F4\u63A5\u7528\uFF0C\u4E0D\u7528\u778E\u731C\u3002\n\n## \u6C47\u62A5\u7EAA\u5F8B\n- \u627E\u5230\u4E86\u5C31\u8BF4\u6E05**\u4F9D\u636E**\uFF08\u8BFB\u4E86\u54EA\u4E00\u6761\u3001\u5185\u5BB9\u662F\u4EC0\u4E48\uFF09\uFF1B\n- \u786E\u5B9E\u6CA1\u6709\uFF08\u5217\u51FA\u6765\u4E5F\u6CA1\u6709\u76F8\u5173\u7684\uFF09\u624D\u80FD\u8BF4"\u6CA1\u6709"\uFF0C\u5E76\u8BF4\u660E\u4F60**\u67E5\u8FC7\u54EA\u4E9B\u8BCD\u3001\u5217\u8FC7\u5217\u8868**\uFF1B\n- \u522B\u628A"\u68C0\u7D22\u843D\u7A7A"\u76F4\u63A5\u590D\u8FF0\u6210"\u77E5\u8BC6\u5E93\u91CC\u6CA1\u6709" \u2014\u2014 \u90A3\u662F**\u4E24\u56DE\u4E8B**\uFF0C\n  \u800C\u4E14\u662F\u628A\u7528\u6237\u81EA\u5DF1\u5B58\u7684\u4E1C\u897F\u8BF4\u6CA1\u4E86\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u77E5\u8BC6\u5E93|\u6709\u6CA1\u6709|\u627E\u627E|\u4E4B\u524D\u8BB0\u7684|\u67E5\u4E0D\u5230", "\u68C0\u7D22|\u843D\u7A7A|\u6CA1\u6709\u76F8\u5173"],
      tools: ["knowledge_read", "add_entry", "get_page_snapshot", "inspect_element", "complete_task"],
      playbook: "knowledge-search-fallback"
    }
  },
  {
    name: "cross-tab-handoff",
    displayName: "\u8DE8\u6807\u7B7E\u9875\u642C\u8FD0\uFF08\u5728 A \u9875\u8BFB\u5230\u7684\u4E1C\u897F\u586B\u8FDB\u65B0\u5F00\u7684 B \u9875\uFF09",
    description: "\u8981\u628A\u4E00\u4E2A\u9875\u9762\u4E0A\u7684\u4FE1\u606F\u586B\u5230\u53E6\u4E00\u4E2A\u6807\u7B7E\u9875\u91CC\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u5728\u65B0\u6253\u5F00\u7684\u9875\u9762\u91CC\u586B\u4E0A / \u628A\u8FD9\u9875\u7684\u9A8C\u8BC1\u7801\u586B\u5230\u90A3\u8FB9 / \u4E24\u4E2A\u6807\u7B7E\u9875\u4E4B\u95F4\u5012\u4E00\u4E0B\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u591A\u6807\u7B7E\u9875", "\u5207\u6362", "\u642C\u8FD0", "\u9A8C\u8BC1\u7801"],
    skill_type: "prompt-template",
    content: '# \u8DE8\u6807\u7B7E\u9875\u642C\u8FD0\n\n## \u6838\u5FC3\u7EAA\u5F8B\uFF1A**\u5148\u628A\u8981\u642C\u7684\u4E1C\u897F\u8BFB\u5230\u624B\uFF0C\u518D\u5207\u9875**\n\u5207\u8FC7\u53BB\u4E4B\u540E\uFF0C\u6765\u6E90\u9875\u7684\u6B63\u6587\u5C31\u4E0D\u5728\u4F60\u773C\u524D\u4E86\uFF08\u540E\u7EED\u8BFB\u53D6\u90FD\u843D\u5728\u65B0\u9875\u4E0A\uFF09\u3002\n\u6240\u4EE5\u987A\u5E8F\u5FC5\u987B\u662F\uFF1A\n1. \u5728\u6765\u6E90\u9875**\u8BFB\u5230\u5E76\u8BB0\u4F4F**\u8981\u642C\u7684\u503C\uFF08\u9A8C\u8BC1\u7801 / \u8BA2\u5355\u53F7 / \u94FE\u63A5 / \u4E00\u6BB5\u6B63\u6587\uFF09\uFF1B\n2. \u6253\u5F00\u6216\u5207\u5230\u76EE\u6807\u9875\uFF08\u70B9\u94FE\u63A5\u3001`open_tab({ url })`\u3001\u6216 `switch_tab({ tabId })`\uFF09\uFF1B\n3. \u5728\u76EE\u6807\u9875\u586B\u3001\u70B9\uFF1B\n4. **\u8BFB\u56DE\u76EE\u6807\u9875\u7684\u56DE\u6267**\u518D\u6C47\u62A5\u3002\n\n## \u26A0 \u6700\u5927\u7684\u98CE\u9669\uFF1A\u300C\u6211\u73B0\u5728\u5728\u54EA\u4E2A\u6807\u7B7E\u9875\u300D\u662F**\u9690\u5F0F\u7684**\n\u843D\u9519\u6807\u7B7E\u9875**\u4E0D\u4F1A\u62A5\u9519** \u2014\u2014 \u5DE5\u5177\u7167\u6837\u8FD4\u56DE\u6210\u529F\u3002\u5178\u578B\u7FFB\u8F66\uFF1A\n- \u6765\u6E90\u9875\u4E0A\u4E5F\u6709\u4E2A\u8F93\u5165\u6846\uFF08\u5F88\u5E38\u89C1\uFF1A\u5907\u6CE8\u3001\u641C\u7D22\u6846\uFF09\uFF0C\u4F60\u6CA1\u771F\u6B63\u5207\u9875\u5C31\u5F80\u91CC\u6253\u5B57\uFF0C\n  \u5B57\u8FDB\u4E86\u6765\u6E90\u9875\u7684\u90A3\u4E2A\u6846\uFF0C**\u76EE\u6807\u9875\u4EC0\u4E48\u90FD\u6CA1\u6536\u5230**\uFF1B\n- \u4EE5\u4E3A\u70B9\u4E86\u94FE\u63A5\u5C31\u5207\u8FC7\u53BB\u4E86\uFF0C\u5176\u5B9E\u7ED1\u5B9A\u6CA1\u53D1\u751F\uFF0C\u540E\u7EED\u64CD\u4F5C\u8FD8\u5728\u65E7\u9875\u4E0A\u3002\n\n**\u600E\u4E48\u786E\u8BA4\u81EA\u5DF1\u5728\u54EA\u4E00\u9875**\uFF1A\n- `list_tabs` \u770B\u5F53\u524D\u7A97\u53E3\u6709\u54EA\u4E9B\u9875\uFF1B`switch_tab({ tabId })` \u663E\u5F0F\u5207\uFF08tabId \u6765\u81EA `list_tabs` / `open_tab`\uFF09\uFF1B\n- \u70B9\u94FE\u63A5\u540E**\u7ED3\u679C\u91CC\u82E5\u5199\u7740\u300C\u5DF2\u81EA\u52A8\u7ED1\u5B9A tabId=N\u300D**\uFF0C\u8BF4\u660E\u540E\u7EED\u64CD\u4F5C\u5DF2\u7ECF\u843D\u5728\u65B0\u9875\u4E0A\u4E86\uFF1B\n- \u5FC3\u91CC\u6CA1\u5E95\u5C31**\u8BFB\u4E00\u6B21\u5F53\u524D\u9875**\uFF08`read_current_page` / `get_page_snapshot`\uFF09\uFF0C\n  \u770B\u770B\u5230\u5E95\u662F\u54EA\u4E00\u9875\u7684\u6807\u9898\u548C\u5185\u5BB9 \u2014\u2014 \u8FD9\u6BD4\u731C\u4FBF\u5B9C\u5F97\u591A\u3002\n\n## \u5224\u636E\n\u5B8C\u6210\u7684\u6807\u51C6\u662F**\u76EE\u6807\u9875\u771F\u7684\u6536\u5230\u4E86**\uFF08\u56DE\u6267\u91CC\u80FD\u770B\u5230\u90A3\u4E2A\u503C\uFF09\uFF0C\n**\u5E76\u4E14\u6765\u6E90\u9875\u6CA1\u6709\u88AB\u8BEF\u6539**\u3002\u53EA\u770B\u5230"\u586B\u597D\u4E86"\u4E0D\u7B97 \u2014\u2014 \u5F97\u770B\u662F\u54EA\u4E00\u9875\u7684\u56DE\u6267\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u65B0\u6253\u5F00\u7684\u9875\u9762|\u8DE8\u6807\u7B7E\u9875|\u4E24\u4E2A\u6807\u7B7E\u9875|\u586B\u5230\u90A3\u8FB9|\u5207\u6807\u7B7E\u9875", "\u9A8C\u8BC1\u7801|\u642C\u8FD0|\u5012\u4E00\u4E0B"],
      tools: ["get_page_snapshot", "read_current_page", "list_tabs", "switch_tab", "open_tab", "type_text", "click_element", "inspect_element", "complete_task"],
      playbook: "cross-tab-handoff"
    }
  },
  {
    name: "virtual-list-scroll",
    displayName: "\u865A\u62DF\u5217\u8868 / \u957F\u5217\u8868\uFF08DOM \u91CC\u6CA1\u6709 \u2260 \u9875\u9762\u4E0A\u6CA1\u6709\uFF09",
    description: "\u9875\u9762\u5217\u8868\u5F88\u957F\u3001\u53EA\u6E32\u67D3\u53EF\u89C1\u7684\u51E0\u884C\uFF08\u865A\u62DF\u6EDA\u52A8 / \u65E0\u9650\u5217\u8868\uFF09\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u7B2C N \u6761 / \u5F80\u4E0B\u7FFB\u5F88\u591A\u6761 / \u5217\u8868\u91CC\u6709\u4E00\u6761\u300D\u800C\u5FEB\u7167\u91CC\u770B\u4E0D\u5230\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u865A\u62DF\u5217\u8868", "\u6EDA\u52A8", "\u957F\u5217\u8868", "\u56DE\u6536\u6E32\u67D3"],
    skill_type: "prompt-template",
    content: '# \u865A\u62DF\u5217\u8868 / \u957F\u5217\u8868\n\n## \u5148\u8BA4\u6E05\u75C7\u72B6\uFF1A**DOM \u91CC\u53EA\u6709\u53EF\u89C1\u7684\u51E0\u884C**\n\u865A\u62DF\u6EDA\u52A8\u4F1A\u628A\u6EDA\u51FA\u89C6\u53E3\u7684\u884C**\u56DE\u6536\u6389**\u3002\u6240\u4EE5\uFF1A\n- `get_page_snapshot` \u91CC\u53EA\u6709\u5F53\u524D\u7A97\u53E3\u90A3\u51E0\u884C\uFF1B\n- \u6570 DOM \u8282\u70B9\u4F1A\u5F97\u5230"\u53EA\u6709 5 \u6761"\u8FD9\u79CD**\u9519\u8BEF\u7ED3\u8BBA**\uFF08\u5217\u8868\u5176\u5B9E\u6709 100 \u6761\uFF09\uFF1B\n- **\u770B\u4E0D\u5230\u76EE\u6807\u884C\uFF0C\u4E0D\u7B49\u4E8E\u9875\u9762\u4E0A\u6CA1\u6709\u8FD9\u4E00\u6761\u3002** \u7EDD\u4E0D\u80FD\u636E\u6B64\u56DE\u7B54\u7528\u6237"\u6CA1\u6709\u627E\u5230"\u3002\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u770B**\u5F53\u524D\u7A97\u53E3**\u662F\u54EA\u51E0\u6761\uFF08\u8BB0\u4E0B\u7B2C\u4E00/\u6700\u540E\u4E00\u6761\u7684\u7F16\u53F7\uFF0C\u7528\u6765\u4F30\u7B97\u8DE8\u5EA6\uFF09\uFF1B\n2. **\u6EDA\u5BB9\u5668\u81EA\u5DF1**\uFF1A`scroll_page({ selector: "#list", y: 3480 })` \u2014\u2014\n   \u7ED9\u4E86 `ref/selector` \u53C8\u6709 `y` \u65F6\uFF0C\u6EDA\u7684\u662F**\u90A3\u4E2A\u5143\u7D20\u81EA\u8EAB**\uFF08\u6B63\u6570\u5411\u4E0B\uFF09\uFF0C\n   \u8FD9 \u6B63\u662F\u5185\u90E8\u53EF\u6EDA\u52A8\u5BB9\u5668\uFF08\u865A\u62DF\u5217\u8868\u3001\u5E26 overflow \u7684\u9762\u677F\uFF09\u8981\u7684\u6EDA\u6CD5\uFF1B\n   - **\u5BB9\u5668\u4E00\u822C\u5C31\u5728\u5FEB\u7167\u91CC**\uFF1A\u90A3\u4E2A\u5E26 `role="list"` / \u53EF\u8BBF\u95EE\u540D\u3001\u91CC\u9762\u6B63\u597D\u88C5\u7740\u53EF\u89C1\u51E0\u884C\u7684\u533A\u57DF\u3002\n     **\u522B\u7528 `run_javascript` \u53BB\u63A2\u6D4B"\u54EA\u4E2A\u5143\u7D20\u80FD\u6EDA"** \u2014\u2014 \u5B83\u5F52\u5165\u300C\u9875\u9762\u547D\u4EE4\u300D\u5BA1\u6279\uFF0C\u4F1A\u767D\u82B1\u4E00\u6B21\u786E\u8BA4\n     \uFF08\u5B9E\u6D4B\uFF1A\u771F\u6A21\u578B\u5148\u5199\u4E86\u4E24\u6B21 JS \u627E\u5BB9\u5668\uFF0C\u624D\u7528\u4E0A `scroll_page`\uFF09\uFF1B\n   - \u4E0D\u77E5\u9053\u786E\u5207\u50CF\u7D20\u65F6\uFF0C\u53EF\u4EE5\u7528**\u884C\u9AD8 \xD7 \u76EE\u6807\u5E8F\u53F7**\u4F30\u7B97\uFF08\u5982 40px \xD7 87 \u2248 3480\uFF09\uFF1B\n   - \u4E5F\u53EF\u4EE5\u53EA\u5F80\u524D\u63A8\u4E00\u5C0F\u6BB5\uFF08`y` \u7ED9\u4E2A\u51E0\u767E\u50CF\u7D20\uFF09\u5206\u51E0\u6B21\u903C\u8FD1\uFF0C**\u6EDA\u8FC7\u5934\u5C31\u7528\u8D1F\u7684 `y` \u56DE\u9000**\uFF1B\n3. **\u6EDA\u5B8C\u5FC5\u987B\u91CD\u65B0\u8BFB**\uFF1A`get_page_snapshot` \u518D\u53D6\u4E00\u6B21\uFF0C\u786E\u8BA4\u76EE\u6807\u884C\u771F\u7684\u8FDB\u4E86\u7A97\u53E3 \u2014\u2014\n   **\u6EDA\u52A8\u524D\u7684 ref \u5168\u90E8\u5931\u6548**\uFF08\u884C\u662F\u56DE\u6536\u91CD\u5EFA\u7684\uFF0C\u540C\u4E00\u4E2A ref \u53EF\u80FD\u6307\u5411\u53E6\u4E00\u6761\u5185\u5BB9\uFF09\uFF1B\n4. \u5B9A\u4F4D\u5230\u76EE\u6807\u540E\u7167\u5E38\u7528 `click_element` / `inspect_element`\u3002\n\n## \u4E09\u4E2A\u5BB9\u6613\u8E29\u7684\u70B9\n- **\u522B\u53EA\u6EDA\u7A97\u53E3**\uFF1A\u4E0D\u5E26\u76EE\u6807\u65F6 `y` \u662F\u6EDA**\u7A97\u53E3**\u7684\uFF08`window.scrollBy`\uFF09\u3002\n  \u5217\u8868\u5728\u4E00\u4E2A\u5185\u90E8\u5BB9\u5668\u91CC\u65F6\uFF0C\u6EDA\u7A97\u53E3**\u4E00\u70B9\u7528\u90FD\u6CA1\u6709** \u2014\u2014 \u73B0\u8C61\u662F"\u6EDA\u4E86\u4F46\u5217\u8868\u6CA1\u52A8"\uFF0C\n  \u5F88\u5BB9\u6613\u88AB\u8BEF\u8BFB\u6210"\u6EDA\u52A8\u5DE5\u5177\u574F\u4E86"\u3002\n- **\u522B\u7528\u65E7\u7684 ref**\uFF1A\u6EDA\u52A8\u540E\u884C\u4F1A\u88AB\u66FF\u6362\uFF0C\u4E4B\u524D\u62FF\u5230\u7684 ref \u4E0D\u518D\u5BF9\u5E94\u540C\u4E00\u6761\u3002\n- **\u522B\u7528 `run_javascript` \u53BB\u8BBE `scrollTop`**\uFF1A\u73B0\u5728\u4E00\u7B49\u516C\u6C11\u5C31\u80FD\u6EDA\u5BB9\u5668\uFF0C\n  \u81EA\u5DF1\u5199\u65E2\u591A\u82B1\u4E00\u6B21\u9AD8\u5371\u5BA1\u6279\uFF0C\u53C8\u7ED5\u8FC7\u4E86\u5DE5\u5177\u7684\u6EDA\u52A8\u7ED3\u679C\u56DE\u62A5\uFF08\u6EDA\u52A8\u5230\u54EA\u4E86\u3001\u6709\u6CA1\u6709\u5230\u8FB9\u754C\uFF09\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u865A\u62DF\u5217\u8868|\u957F\u5217\u8868|\u65E0\u9650\u5217\u8868|\u865A\u62DF\u6EDA\u52A8|\u7B2C \\d+ \u6761|\u5217\u8868\u91CC", "\u6EDA|\u7FFB|\u627E\u4E0D\u5230"],
      tools: ["get_page_snapshot", "scroll_page", "click_element", "inspect_element", "wait_for_element", "complete_task"],
      playbook: "virtual-list-scroll"
    }
  },
  {
    name: "infinite-scroll-hover-preview",
    displayName: "\u65E0\u9650\u6EDA\u52A8 + hover \u9884\u89C8\uFF08\u6EDA\u5230\u5E95\u624D\u52A0\u8F7D\uFF0C\u9884\u89C8\u53EA\u5728\u60AC\u505C\u540E\u51FA\u73B0\uFF09",
    description: "\u4FE1\u606F\u6D41/\u52A8\u6001\u5217\u8868\u9700\u8981\u4E0D\u65AD\u5411\u4E0B\u6EDA\u52A8\u624D\u4F1A\u52A0\u8F7D\u66F4\u591A\uFF0C\u6216\u67D0\u6761\u4FE1\u606F\u8981\u9F20\u6807\u79FB\u4E0A\u53BB\u624D\u770B\u5F97\u5230\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u5F80\u4E0B\u7FFB\u66F4\u591A\u300D\u300C\u4E00\u76F4\u52A0\u8F7D\u300D\u300C\u60AC\u505C\u770B\u9884\u89C8/\u8BA2\u5355\u53F7\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u65E0\u9650\u6EDA\u52A8", "\u61D2\u52A0\u8F7D", "\u60AC\u505C\u9884\u89C8", "hover"],
    skill_type: "prompt-template",
    content: '# \u65E0\u9650\u6EDA\u52A8 + hover \u9884\u89C8\n\n## \u4E24\u4E2A\u75C7\u72B6\n- **\u6EDA\u4E0D\u5230\u5C31\u770B\u4E0D\u5230**\uFF1A\u5185\u5BB9\u662F\u6309\u6279**\u5F02\u6B65\u8FFD\u52A0**\u7684\uFF0C\u4E00\u5F00\u59CB\u5FEB\u7167\u91CC\u53EA\u6709\u7B2C\u4E00\u6279 \u2014\u2014\n  \u300C\u5FEB\u7167\u91CC\u6CA1\u6709\u76EE\u6807\u300D**\u4E0D\u7B49\u4E8E**\u300C\u9875\u9762\u4E0A\u6CA1\u6709\u8FD9\u6761\u300D\uFF1B\n- **\u60AC\u505C\u624D\u6709**\uFF1A\u9884\u89C8/\u63D0\u793A\u6587\u672C\u53EF\u80FD\u538B\u6839\u4E0D\u5728\u9875\u9762\u91CC\uFF08\u9F20\u6807\u79FB\u4E0A\u53BB\u624D\u53BB\u53D6\u3001\u624D\u6E32\u67D3\uFF09\uFF0C\n  \u800C\u4E14**\u9F20\u6807\u4E00\u79FB\u5F00\u5C31\u6CA1\u4E86**\u3002\n\n## \u6B65\u9AA4\n1. \u5148 `get_page_snapshot` \u770B**\u5DF2\u7ECF\u52A0\u8F7D\u4E86\u4EC0\u4E48**\uFF08\u8BB0\u4E0B\u5F53\u524D\u6761\u6570/\u72B6\u6001\u884C\uFF0C\u7528\u5B83\u5224\u65AD\u6709\u6CA1\u6709\u65B0\u7684\u4E00\u6279\u8FDB\u6765\uFF09\uFF1B\n2. **\u522B\u628A\u300C\u52A0\u8F7D\u66F4\u591A\u300D\u6309\u94AE\u5F53\u6210\u63A8\u8FDB\u624B\u6BB5**\uFF1A\u8FD9\u7C7B\u9875\u9762\u4E0A\u5B83\u7ECF\u5E38\u662F\u5931\u6548\u7684\uFF08\u4E5F\u53EF\u80FD\u53CD\u8FC7\u6765 \u2014\u2014 \u53EA\u6709\u6309\u94AE\u6709\u6548\uFF09\u3002\n   \u70B9\u4E00\u6B21\u770B\u5B83\u600E\u4E48\u8BF4\uFF1B\u5B83\u82E5\u8BF4\u300C\u8BF7\u5728\u5E95\u90E8\u7EE7\u7EED\u6EDA\u52A8\u300D\uFF0C\u5C31\u6539\u8D70\u6EDA\u52A8\uFF0C**\u8BD5\u51FA\u65E0\u6548\u5C31\u522B\u53CD\u590D\u70B9**\uFF1B\n3. **\u6EDA\u5230\u5E95\u89E6\u53D1\u52A0\u8F7D**\uFF1A`scroll_page({ y: 2000 })` \u2014\u2014 \u4E0D\u5E26\u76EE\u6807\u65F6 `y` \u6EDA\u7684\u662F**\u7A97\u53E3**\uFF0C\n   \u7ED9\u4E00\u4E2A\u8FDC\u5927\u4E8E\u9875\u9762\u9AD8\u5EA6\u7684\u503C\u6700\u7701\u4E8B\uFF08\u4F1A\u88AB\u81EA\u52A8\u9650\u5236\u5230\u5E95\u90E8\uFF09\uFF1B\n4. **\u6EDA\u4E00\u6B21\u53EA\u52A0\u8F7D\u4E00\u6279**\uFF0C\u6240\u4EE5\u8282\u594F\u5FC5\u987B\u662F\u300C\u6EDA\u52A8 \u2192 \u7B49\u65B0\u5185\u5BB9 \u2192 \u518D\u6EDA\u300D\uFF1A\n   - \u7B49\u65B0\u5185\u5BB9\u6302\u4E0A DOM\uFF1A`wait_for_element({ selector: "<\u65B0\u6279\u7684\u7B2C\u4E00\u6761>", state: "attached" })`\uFF1B\n   - \u26A0 \u8FFD\u52A0\u4E4B\u540E\u9875\u9762\u53D8\u9AD8\uFF0C**\u5F53\u524D\u4F4D\u7F6E\u4E0D\u518D\u662F\u5E95\u90E8**\uFF0C\u800C\u4E14**\u4E0D\u4F1A\u518D\u89E6\u53D1 scroll \u4E8B\u4EF6** \u2014\u2014\n     \u6240\u4EE5\u5FC5\u987B**\u518D\u6EDA\u4E00\u6B21**\u3002\u5C11\u4E86\u8FD9\u4E00\u6B65\u4F1A\u8BEF\u5224\u6210\u300C\u6EDA\u4E0D\u52A8\u4E86 / \u5DF2\u7ECF\u5230\u5E95\u300D\uFF1B\n5. **\u8BFB\u5230\u300C\u5DF2\u5230\u5E95\u300D\u8FD9\u7C7B\u505C\u6B62\u4FE1\u53F7\u624D\u505C**\uFF1A\u5230\u5E95\u4E4B\u540E\u9875\u9762\u4F1A\u7ED9\u51FA\u660E\u786E\u6807\u8BB0\uFF08\u300C\u5DF2\u5230\u5E95 / \u6CA1\u6709\u66F4\u591A\u300D\uFF09\u3002\n   \u6EDA\u5B8C\u4E00\u6279\u5C31\u8BFB\u4E00\u6B21\u5FEB\u7167\u786E\u8BA4\u5B83\u51FA\u6CA1\u51FA\u73B0\uFF1A**\u51FA\u73B0\u4E86\u624D\u505C**\uFF0C\u6CA1\u51FA\u73B0\u5C31\u56DE\u5230\u7B2C 3 \u6B65\u3002\n   \u26A0 \u7EDD\u4E0D\u56E0\u4E3A\u300C\u6EDA\u4E86\u51E0\u6B21\u90FD\u770B\u4E0D\u5230\u76EE\u6807\u300D\u5C31\u5BA3\u5E03\u300C\u9875\u9762\u4E0A\u6CA1\u6709\u8FD9\u6761\u300D\u2014\u2014\u90A3\u4E0D\u662F\u7ED3\u8BBA\uFF0C\u53EA\u662F\u8FD8\u6CA1\u52A0\u8F7D\u5230\uFF1B\n6. **\u60AC\u505C\u524D\u5148\u786E\u8BA4\u76EE\u6807\u5728\u89C6\u53E3\u91CC**\uFF08\u5FEB\u7167\u91CC\u6BCF\u4E2A\u5143\u7D20\u90FD\u5E26 `rect` / `inViewport`\uFF09\u3002\u4E0D\u5728\u5C31\u5148\u6EDA\u8FC7\u53BB\uFF1A\n   `scroll_page({ selector: "\u2026", behavior: "auto" })` \u2014\u2014\n   \xB7 CDP \u7684\u9F20\u6807\u5750\u6807\u662F**\u89C6\u53E3\u5750\u6807**\uFF0C\u9F20\u6807\u79FB\u4E0D\u5230\u89C6\u53E3\u5916\u7684\u4E1C\u897F\u4E0A\uFF1B\n   \xB7 \u7528 `behavior: "auto"`\uFF08\u7ACB\u5373\u5B8C\u6210\uFF09\u800C\u4E0D\u662F\u9ED8\u8BA4\u7684\u5E73\u6ED1\u6EDA\u52A8\uFF0C\u800C\u4E14**\u6EDA\u5B8C\u5148\u8BFB\u4E00\u6B21\u9875\u9762\u518D hover**\uFF1A\n     \u9875\u9762\u8FD8\u5728\u6EDA\u52A8\u65F6 hover \u7528\u7684\u662F**\u65E7\u5750\u6807**\uFF1B\u66F4\u9EBB\u70E6\u7684\u662F\u6D4F\u89C8\u5668\u5728\u6EDA\u52A8\u4E4B\u540E\u4F1A\u6309**\u771F\u5B9E\u5149\u6807\u4F4D\u7F6E**\n     \u91CD\u7B97\u4E00\u6B21 hover \u72B6\u6001\uFF0C\u521A hover \u4E0A\u7684\u5143\u7D20\u53EF\u80FD\u7ACB\u523B\u88AB"\u632A\u8D70"\uFF1B\n7. **\u7528\u771F\u4E8B\u4EF6\u60AC\u505C**\uFF1A`hover_element({ text: "\u76EE\u6807\u6587\u672C" })`\uFF08\u7ECF CDP \u6D3E\u53D1**\u53EF\u4FE1**\u9F20\u6807\u4E8B\u4EF6\uFF09\u3002\n   \u81EA\u5DF1\u9020\u4E8B\u4EF6\uFF08`dispatchEvent`\uFF09**\u6CA1\u6709\u7528**\uFF1A\u9875\u9762\u5904\u7406 hover \u65F6\u5F80\u5F80\u53EA\u8BA4\u53EF\u4FE1\u4E8B\u4EF6\uFF1B\n8. **\u60AC\u505C\u4E4B\u540E\u7D27\u63A5\u7740\u8BFB\u56DE**\uFF08\u8FD9\u4E24\u6B65\u4E4B\u95F4\u4E0D\u8981\u63D2\u5165\u522B\u7684\u52A8\u4F5C\uFF09\uFF1A\n   - \u7B49\u9884\u89C8\u586B\u5145\uFF1A`wait_for_element({ selector: "#<\u9884\u89C8\u8282\u70B9>", state: "text_contains", text: "\u2026" })`\n     \u2014\u2014 \u9884\u89C8\u5E38\u5E38\u662F\u4E00\u6B21**\u5F02\u6B65\u53D6\u6570**\uFF0Chover \u5B8C\u7ACB\u523B\u8BFB\u4F1A\u8BFB\u5230\u7A7A\uFF1B\n   - \u8BFB\uFF1A`inspect_element({ op: "text", selector: "#<\u9884\u89C8\u8282\u70B9>" })`\uFF0C\u6216\u91CD\u65B0 `get_page_snapshot` \u8BFB\u6B63\u6587\u3002\n     \u9884\u89C8\u6587\u672C\u901A\u5E38\u5728**\u5B50\u8282\u70B9 / popover** \u91CC\uFF0C\u4E0D\u5728\u88AB\u60AC\u505C\u7684\u90A3\u4E2A\u5143\u7D20\u81EA\u5DF1\u7684\u6587\u672C\u91CC\u3002\n\n## \u56DB\u6761\u7EAA\u5F8B\n- **popover \u662F"\u5F53\u4E0B"\u7684\uFF0C\u522B\u53EA\u4F9D\u8D56\u5B83**\uFF1A\u9F20\u6807\u4E00\u79FB\u5F00\u5B83\u5C31\u7A7A\u4E86\uFF0C\u800C\u771F\u5B9E\u5149\u6807\u968F\u65F6\u53EF\u80FD\u52A8\n  \uFF08\u54EA\u6015\u4F60\u4EC0\u4E48\u90FD\u6CA1\u505A\uFF09\u3002\u9875\u9762\u82E5\u53E6\u6709\u4E00\u5904"\u6700\u8FD1\u67E5\u770B"/\u8BE6\u60C5\u8BB0\u5F55\uFF0C**\u4F18\u5148\u8BFB\u90A3\u4E00\u5904** \u2014\u2014 \u5B83\u66F4\u8010\u4E45\uFF1B\n  \u8981\u8BFB popover\uFF0C\u5C31\u5728 hover \u4E4B\u540E**\u7D27\u63A5\u7740**\u8BFB\uFF08\u4E2D\u95F4\u522B\u70B9\u51FB\u3001\u522B hover \u522B\u7684\u5143\u7D20\uFF09\u3002\n- **hover \u6CA1\u8BFB\u5230 \u2260 \u9875\u9762\u4E0A\u6CA1\u6709**\uFF1A\u5148\u6000\u7591"\u9F20\u6807\u88AB\u632A\u8D70\u4E86 / \u9884\u89C8\u8FD8\u6CA1\u586B\u5145"\uFF0C**\u518D hover \u4E00\u6B21**\u6216\u7B49\u4E00\u4E0B\uFF0C\n  \u800C\u4E0D\u662F\u76F4\u63A5\u56DE\u7B54"\u9875\u9762\u4E0A\u6CA1\u6709\u8BA2\u5355\u53F7"\uFF1B\n- **\u522B\u7528 `run_javascript` \u53BB\u8BBE `scrollTop` \u6216\u53D6\u9884\u89C8**\uFF1A\u6EDA\u52A8\u6709\u4E00\u7B49\u516C\u6C11\uFF08`scroll_page`\uFF09\uFF0C\n  \u800C\u53D6\u9884\u89C8\u7ED5\u5F00\u4F1A**\u8DF3\u8FC7 hover \u672C\u8EAB**\uFF08\u5185\u5BB9\u6839\u672C\u6CA1\u751F\u6210\uFF09\uFF0C\u8FD8\u767D\u82B1\u4E00\u6B21\u9AD8\u5371\u5BA1\u6279\uFF1B\n- **\u505C\u6B62\u9760\u4FE1\u53F7\uFF0C\u4E0D\u9760\u6B21\u6570**\uFF1A\u53EA\u51ED\u300C\u6EDA\u4E86 N \u6B21\u300D\u505C\u4E0B\uFF0C\u8981\u4E48\u505C\u65E9\u4E86\uFF08\u6F0F\u5185\u5BB9\uFF09\u3001\u8981\u4E48\u505C\u4E0D\u4E0B\u6765\uFF08\u4E00\u76F4\u91CD\u6EDA\uFF09\u3002\n',
    x: {
      intents: ["browser_task"],
      keywords: ["\u4FE1\u606F\u6D41|\u65E0\u9650\u6EDA\u52A8|\u81EA\u52A8\u52A0\u8F7D|\u6EDA\u5230\u5E95|\u5DF2\u5230\u5E95|\u5F80\u4E0B\u6EDA|\u4E00\u76F4\u52A0\u8F7D", "\u60AC\u505C|hover|\u9F20\u6807\u79FB\u4E0A\u53BB|\u9884\u89C8|\u63D0\u793A\u6587\u672C"],
      tools: [
        "get_page_snapshot",
        "click_element",
        "scroll_page",
        "wait_for_element",
        "hover_element",
        "inspect_element",
        "complete_task"
      ],
      playbook: "infinite-scroll-hover-preview"
    }
  },
  {
    name: "html5-drag-drop",
    displayName: "HTML5 \u539F\u751F\u62D6\u653E\uFF08\u300C\u770B\u8D77\u6765\u62D6\u8FC7\u53BB\u4E86\u300D\u4E0D\u7B49\u4E8E\u9875\u9762\u6536\u5230\u4E86\uFF09",
    description: "\u628A\u5361\u7247 / \u6587\u4EF6 / \u5217\u8868\u9879**\u62D6\u5230**\u53E6\u4E00\u4E2A\u533A\u57DF\uFF08\u539F\u751F dragstart / dragover / drop\uFF09\u65F6\u4F7F\u7528\uFF1A\u5B83**\u4E0D\u8D70\u9F20\u6807\u4E8B\u4EF6**\uFF0C\u843D\u70B9\u5FC5\u987B\u5728 `dragover` \u91CC\u653E\u884C\uFF0Cpayload \u53EA\u80FD\u5728 `drop` \u91CC\u8BFB \u2014\u2014 \u90FD\u8981\u5148\u628A\u8FD9\u51E0\u4EF6\u4E8B\u505A\u5BF9\uFF0C\u518D\u4ECE**\u9875\u9762\u72B6\u6001**\u786E\u8BA4\u771F\u7684\u6536\u4E0B\u4E86\u3002\u5F53\u7528\u6237\u8BF4\u300C\u62D6\u8FC7\u53BB\u300D\u300C\u62D6\u5230\u8FD9\u4E2A\u533A\u57DF\u300D\u300C\u628A\u8FD9\u5F20\u5361\u653E\u5230\u90A3\u91CC\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u62D6\u653E", "drag", "drop", "DataTransfer"],
    skill_type: "prompt-template",
    content: '# HTML5 \u62D6\u653E\uFF1A\u8BA9\u9875\u9762**\u771F\u7684\u6536\u5230**\n\n## \u4E09\u4E2A\u75C7\u72B6\n- **\u62D6\u4E86\u6CA1\u53CD\u5E94**\uFF1A\u539F\u751F\u62D6\u653E**\u4E0D\u8D70\u9F20\u6807\u4E8B\u4EF6** \u2014\u2014 \u5408\u6210 `mousedown/mousemove/mouseup` **\u4E0D\u4F1A**\u89E6\u53D1 `dragstart/drop` \u2717\n- **drop \u88AB\u541E\u6389**\uFF1A\u843D\u70B9\u53EA\u6709\u5728 `dragover` \u91CC `preventDefault()` \u8FC7\uFF0C\u6D4F\u89C8\u5668\u624D\u5141\u8BB8 `drop` \u2717\n- **\u8BFB\u4E0D\u5230 payload**\uFF1A`DataTransfer.getData` **\u53EA\u80FD\u5728 `drop` \u91CC\u8BFB**\uFF1B\u5728 `dragover` \u91CC\u8BFB\u662F\u7A7A\u4E32 \u2717\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u770B\u6E05**\u53EF\u62D6\u7684\u5361\u7247**\u4E0E**\u843D\u70B9\u533A\u57DF**\uFF08\u54EA\u4E9B\u533A\u57DF\u771F\u7684\u63A5\u53D7\u8FD9\u6B21\u62D6\u653E\u3001\u6709\u6CA1\u6709"\u770B\u7740\u80FD\u62D6\u5176\u5B9E\u62D6\u4E0D\u52A8"\u7684\uFF09\uFF1B\n2. \u7528**\u771F\u7684\u62D6\u653E\u4E8B\u4EF6**\u9A71\u52A8\uFF1A\u6784\u9020 `DataTransfer`\uFF0C\u6D3E\u53D1 `dragstart` \u2192 `dragover`\uFF08**\u8BB0\u5F97 `preventDefault()`**\uFF09\u2192 `drop`\uFF1B\n3. payload \u7528 `setData` \u653E\u8FDB\u53BB\uFF0C\u5E76\u4E14**\u5728 `drop` \u91CC**\u7528 `getData` \u8BFB\u56DE\u6765 \u2713\n4. \u8BFB\u56DE**\u9875\u9762\u72B6\u6001**\uFF1A\u843D\u70B9\u662F\u5426\u771F\u7684**\u6536\u4E0B**\u4E86\u90A3\u4EFD payload\uFF08\u4E0D\u662F"\u533A\u57DF\u8FD8\u5728"\uFF09\u3001\u6709\u6CA1\u6709**\u653E\u9519\u533A\u57DF / \u7A7A\u8BFB**\u7684\u8BA1\u6570\uFF1B\n5. \u7ED3\u8BBA\u53EA\u4F9D\u636E\u7B2C 4 \u6B65\u8BFB\u56DE\u7684\u72B6\u6001\uFF1B"\u6211\u62D6\u8FC7\u53BB\u4E86"**\u4E0D\u7B49\u4E8E**"\u9875\u9762\u6536\u5230\u4E86"\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u522B\u7528\u9F20\u6807\u4E8B\u4EF6\u6A21\u62DF\u62D6\u653E**\uFF1A\u5408\u6210\u9F20\u6807\u4E8B\u4EF6\u4E0D\u89E6\u53D1\u539F\u751F\u62D6\u653E \u2717\uFF1B\n- **\u843D\u70B9\u8981\u653E\u884C**\uFF1A\u5FD8\u4E86 `preventDefault` \u21D2 `drop` \u6839\u672C\u4E0D\u4F1A\u53D1\u751F \u2717\uFF1B\n- **\u653E\u9519 / \u7A7A\u8BFB\u8981\u5982\u5B9E\u8BF4**\uFF1Apayload \u4E3A\u7A7A\u6216\u843D\u9519\u533A\u57DF\u65F6\u62A5\u544A\u4E8B\u5B9E\uFF0C\u4E0D\u8981\u8BF4"\u5DF2\u62D6\u597D"\u3002\n',
    x: {
      intents: ["browser_task"],
      keywords: ["\u62D6\u653E|\u62D6\u62FD|drag|drop|\u62D6\u8FC7\u53BB", "DataTransfer|\u843D\u70B9|\u6536\u4EF6\u533A"],
      tools: ["get_page_snapshot", "click_element", "run_javascript", "inspect_element", "complete_task"],
      playbook: "html5-drag-drop"
    }
  },
  {
    name: "rich-text-structure",
    displayName: "\u5BCC\u6587\u672C\u7F16\u8F91\uFF08\u7ED3\u6784\u8981\u771F\u7684\u6539\u4E0A\uFF0C\u4E0D\u80FD\u53EA\u770B\u7EAF\u6587\u672C\uFF09",
    description: "\u5728 contenteditable / \u5BCC\u6587\u672C\u7F16\u8F91\u5668\u91CC\u6539\u683C\u5F0F\u6216\u6B63\u6587\u65F6\u4F7F\u7528\uFF1A\u5DE5\u5177\u680F\u6309\u94AE\u53EA\u4F5C\u7528\u4E8E**\u9009\u533A**\u3001\u76F4\u63A5\u6539 DOM \u6216\u6D3E\u53D1\u5408\u6210\u4E8B\u4EF6**\u4E0D\u7B97\u8F93\u5165**\u3001\u9690\u85CF\u5B57\u6BB5**\u53EA\u5728\u5931\u7126\u65F6\u540C\u6B65** \u2014\u2014 \u90FD\u8981\u5148\u628A\u52A8\u4F5C\u505A\u5BF9\uFF0C\u518D\u4ECE**\u7ED3\u6784**\u8BFB\u56DE\u9A8C\u8BC1\u3002\u5F53\u7528\u6237\u8BF4\u300C\u628A\u8FD9\u6BB5\u52A0\u7C97\u300D\u300C\u53D8\u6210\u5217\u8868\u300D\u300C\u5728\u5BCC\u6587\u672C\u91CC\u6539\u300D\u300C\u7F16\u8F91\u5668\u91CC\u5199\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u5BCC\u6587\u672C", "contenteditable", "\u7ED3\u6784", "\u9009\u533A"],
    skill_type: "prompt-template",
    content: '# \u5BCC\u6587\u672C\u7F16\u8F91\uFF1A\u7ED3\u6784\u8981\u771F\u7684\u6539\u4E0A\n\n## \u4E09\u4E2A\u75C7\u72B6\n- **\u70B9\u4E86\u6CA1\u53CD\u5E94**\uFF1A\u5DE5\u5177\u680F\u6309\u94AE\u4F5C\u7528\u4E8E**\u9009\u533A**\uFF1B\u6CA1\u9009\u4E2D\u5C31\u70B9\uFF0C\u9875\u9762\u4EC0\u4E48\u90FD\u4E0D\u4F1A\u505A\uFF0C\u8FD8\u53EF\u80FD\u53EA\u8BB0\u4E00\u6B21"\u7A7A\u64CD\u4F5C" \u2717\n- **\u770B\u7740\u6709\u5B57\u5176\u5B9E\u662F\u5047\u7684**\uFF1A\u76F4\u63A5\u6539 DOM / \u6D3E\u53D1\u5408\u6210\u4E8B\u4EF6**\u4E0D\u7B97\u8F93\u5165** \u21D2 \u9875\u9762\u72B6\u6001\u4E0E\u9690\u85CF\u5B57\u6BB5\u90FD\u4E0D\u66F4\u65B0 \u2717\n- **\u8BFB\u5230\u65E7\u503C**\uFF1A\u9690\u85CF\u5B57\u6BB5**\u53EA\u5728\u5931\u7126\u65F6**\u540C\u6B65\uFF1B\u6CA1\u5931\u7126\u5C31\u8BFB\uFF0C\u62FF\u5230\u7684\u662F\u6539\u4E4B\u524D\u7684\u5185\u5BB9 \u2717\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u770B\u6E05**\u53EF\u7F16\u8F91\u533A**\uFF08`contenteditable`\uFF09\u4E0E\u5DE5\u5177\u680F\uFF0C\u5206\u6E05\u54EA\u4E9B\u6309\u94AE\u4F5C\u7528\u4E8E**\u9009\u533A**\uFF1B\n2. **\u5148\u9009\u4E2D**\u76EE\u6807\u6587\u5B57\uFF08\u9009\u533A\u662F\u627F\u91CD\u4EF6\uFF09\uFF0C\u518D\u70B9\u300C\u52A0\u7C97 / \u5217\u8868 / \u94FE\u63A5\u300D\u8FD9\u7C7B**\u7ED3\u6784\u6027**\u6309\u94AE\uFF1B\n3. \u6253\u5B57\u8981\u7528**\u53EF\u4FE1\u8F93\u5165**\uFF08CDP \u952E\u5165\uFF09\uFF1B\u7EAF\u5408\u6210\u4E8B\u4EF6\u4F1A\u88AB\u9875\u9762\u62D2\uFF1B\n4. \u6539\u5B8C**\u8BA9\u7F16\u8F91\u533A\u5931\u7126**\uFF08\u70B9\u9875\u9762\u522B\u5904\uFF09\u518D\u8BFB\u9690\u85CF\u5B57\u6BB5/\u72B6\u6001\uFF0C\u5426\u5219\u8BFB\u5230\u7684\u662F**\u65E7\u503C**\uFF1B\n5. **\u4ECE\u7ED3\u6784\u53D6\u8BC1**\uFF1A\u8BFB\u56DE HTML \u7ED3\u6784\u6216\u9875\u9762\u72B6\u6001\u91CC\u7684**\u7ED3\u6784\u8BA1\u6570**\uFF08\u7C97\u4F53 / \u5217\u8868\u9879 / \u94FE\u63A5\u6570\uFF09\u2014\u2014 \u53EA\u770B `innerText` \u4E0D\u591F\uFF1A\u7EAF\u6587\u672C\u4E00\u6837\u800C\u7ED3\u6784\u4E22\u4E86\uFF0C\u5C31\u662F\u6CA1\u6539\u4E0A\uFF1B\n6. \u7ED3\u8BBA\u53EA\u4F9D\u636E\u7B2C 5 \u6B65\u8BFB\u56DE\u7684\u7ED3\u6784\uFF0C\u5E76\u8BF4\u660E"\u70B9\u4E86\u51E0\u6B21\u6309\u94AE"**\u4E0D\u7B49\u4E8E**"\u7ED3\u6784\u771F\u7684\u6539\u4E86"\u3002\n\n## \u26A0 \u5230\u70B9\u5C31\u6536\uFF08**\u522B\u8FC7\u5EA6\u6838\u9A8C**\uFF09\n\u7B2C 5 \u6B65\u8BFB\u56DE**\u4E00\u6B21**\u7ED3\u6784\u8BA1\u6570\u5C31\u591F\u4E86 \u2014\u2014 \u53CD\u590D\u7528 `inspect_element({op:"styles"})`\u3001\u53CD\u590D\u8BFB\u540C\u4E00\u4E2A\u8282\u70B9\uFF0C\n**\u4E0D\u4F1A\u8BA9\u7ED3\u8BBA\u66F4\u51C6**\uFF0C\u53EA\u4F1A\u628A\u6D41\u7A0B\u62D6\u957F\uFF08\u771F\u6A21\u578B\u5B9E\u6D4B\uFF1A\u540C\u4E00\u4EF6\u4E8B\u505A\u5230 50\u201380 \u6B21\u5DE5\u5177\u8C03\u7528\uFF0C\u53CD\u800C\u662F"\u8DD1\u4E0D\u5B8C"\u7684\u4E3B\u56E0 \u2717\uFF09\u2713\n\u6536\u624B\u5224\u636E\uFF08\u6EE1\u8DB3\u5C31\u4E0B\u7ED3\u8BBA\uFF09\uFF1A**\u7ED3\u6784\u8BA1\u6570\u5BF9\u5F97\u4E0A\u4F60\u505A\u7684\u52A8\u4F5C** + **\u6CA1\u6709\u62A5\u9519** \u21D2 \u76F4\u63A5\u6C47\u62A5 \u2713\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u9009\u533A\u662F\u627F\u91CD\u4EF6**\uFF1A\u6CA1\u6709\u9009\u533A\u5C31\u6CA1\u6709\u683C\u5F0F\u53EF\u6539\uFF0C\u5148\u9009\u518D\u70B9\uFF1B\n- **\u522B\u53EA\u770B\u7EAF\u6587\u672C**\uFF1A`innerText` \u76F8\u540C\u4E5F\u53EF\u80FD\u662F\u7ED3\u6784\u4E22\u4E86\uFF08\u53CD\u8FC7\u6765\u4E5F\u4E00\u6837\uFF09\uFF1B\n- **\u4E22\u4E1C\u897F\u8981\u8BF4\u660E**\uFF1A\u7ED3\u6784\u6CA1\u53D8 / \u8F93\u5165\u88AB\u62D2\u65F6\u5982\u5B9E\u62A5\u544A\uFF0C\u4E0D\u8981\u8BF4"\u5DF2\u6539\u597D"\u3002\n',
    x: {
      intents: ["browser_task"],
      keywords: ["\u5BCC\u6587\u672C|\u7F16\u8F91\u5668|contenteditable|\u52A0\u7C97|\u5217\u8868|\u683C\u5F0F", "\u9009\u4E2D|\u9009\u533A|\u5931\u7126|blur"],
      tools: ["get_page_snapshot", "click_element", "type_text", "press_key", "run_javascript", "inspect_element", "complete_task"],
      playbook: "rich-text-structure"
    }
  },
  {
    name: "video-playback-verify",
    displayName: "\u89C6\u9891\u64AD\u653E\u5668\u72B6\u6001\uFF08\u300C\u770B\u8D77\u6765\u5728\u64AD\u300D\u4E0D\u7B49\u4E8E\u771F\u7684\u5728\u64AD\uFF09",
    description: "\u9700\u8981\u5224\u65AD\u9875\u9762\u4E0A\u7684\u97F3\u89C6\u9891**\u5230\u5E95\u5728\u4E0D\u5728\u64AD**\u65F6\u4F7F\u7528\uFF1A\u786E\u8BA4\u662F\u5426\u771F\u7684\u5728\u64AD\u3001\u64AD\u5230\u54EA\u4E86\u3001\u6709\u6CA1\u6709\u5361\u987F\u3001\u662F\u64AD\u5B8C\u4E86\u8FD8\u662F\u505C\u4F4F\u4E86\u3002\u5F53\u7528\u6237\u8BF4\u300C\u89C6\u9891\u5728\u64AD\u5417\u300D\u300C\u786E\u8BA4\u4E00\u4E0B\u64AD\u653E\u72B6\u6001\u300D\u300C\u5B83\u5230\u5E95\u64AD\u6CA1\u64AD\u300D\u300C\u64AD\u653E\u5230\u54EA\u4E86\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u89C6\u9891", "\u64AD\u653E\u72B6\u6001", "\u7F13\u51B2", "\u5E27\u8BA1\u6570", "\u8FF7\u60D1\u63A7\u4EF6"],
    skill_type: "prompt-template",
    content: '# \u5224\u65AD\u89C6\u9891/\u97F3\u9891\u300C\u5230\u5E95\u5728\u4E0D\u5728\u64AD\u300D\n\n## \u75C7\u72B6\uFF08\u4E09\u4E2A\u90FD\u5C5E\u4E8E"\u770B\u8D77\u6765\u5728\u64AD"\uFF09\n- **\u9875\u9762\u4E0A\u5199\u7740\u300C\u6B63\u5728\u64AD\u653E\u300D\uFF0C\u800C\u5B83\u5176\u5B9E\u6CA1\u5728\u64AD**\uFF1A\u72B6\u6001\u680F\u3001\u64AD\u653E\u6309\u94AE\u7684\u56FE\u6807\u3001\u8FDB\u5EA6\u6761\u6587\u6848\u90FD\u53EF\u80FD\u662F\n  **\u52A0\u8F7D\u90A3\u4E00\u523B\u5199\u6B7B**\u7684\uFF08\u70C2\u5B9E\u73B0\u5F88\u5E38\u89C1\uFF09\uFF0C\u5B83\u4EEC**\u4E0D\u968F\u771F\u5B9E\u72B6\u6001\u5237\u65B0**\u3002\n- **`paused === false` \u4E5F\u4E0D\u7B49\u4E8E"\u771F\u5728\u64AD"**\uFF1A\u5B83\u53EA\u8BF4\u660E**\u8FD9\u4E00\u523B**\u6CA1\u6709\u6682\u505C \u2014\u2014\n  \u7F13\u51B2\u5361\u4F4F\u3001\u5DF2\u7ECF\u64AD\u5230\u6700\u540E\u3001\u53EA\u662F\u52A0\u8F7D\u4E86\u9996\u5E27\uFF0C\u90FD\u53EF\u80FD\u8BA9\u67D0\u4E00\u77AC\u95F4\u7684\u8BFB\u6570\u9A97\u4EBA\u3002\n- **\u9875\u9762\u4E0A\u6709\u770B\u8D77\u6765\u80FD\u64AD\u7684\u4E1C\u897F**\uFF1A\u88C5\u9970\u6027\u7684\u5927\u64AD\u653E\u952E\u3001\u5047\u8FDB\u5EA6\u6761\uFF08\u7EAF CSS \u586B\u5145\uFF09\u3002\n  \u70B9\u5B83\u4EEC**\u4E0D\u4F1A**\u6539\u53D8\u771F\u5B9E\u64AD\u653E\u72B6\u6001\uFF0C\u4F46\u9875\u9762\u4E0A\u4F1A\u663E\u5F97"\u52A8\u4E86"\u3002\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u770B\u9875\u9762\u7ED3\u6784\uFF1A**\u5148\u5206\u6E05\u54EA\u4E00\u4E2A\u63A7\u4EF6\u662F\u771F\u7684** \u2014\u2014\n   \u771F\u63A7\u4EF6\u901A\u5E38\u4E0E `<video>`/`<audio>` \u5173\u8054\uFF08\u5B83\u5728\u5FEB\u7167\u91CC\u5C31\u662F\u4E2A\u64AD\u653E/\u6682\u505C\u6309\u94AE\uFF09\uFF0C\n   \u88C5\u9970\u6027\u63A7\u4EF6\u5F80\u5F80\u53EA\u6709\u6F02\u4EAE\u7684\u56FE\u6807\u4E0E\u6587\u6848\uFF1B\u5148\u628A"\u9875\u9762\u81EA\u5DF1\u5199\u7684\u72B6\u6001\u6587\u672C"\u8BB0\u4E0B\u6765\uFF08**\u5B83\u53EA\u662F\u7EBF\u7D22\uFF0C\u4E0D\u662F\u8BC1\u636E**\uFF09\uFF1B\n2. **\u522B\u6025\u7740\u4E0B\u7ED3\u8BBA**\uFF1A\u5148\u627E\u9875\u9762\u4E0A\u6709\u6CA1\u6709\u300C\u64AD\u653E\u8BE6\u60C5 / \u8C03\u8BD5\u4FE1\u606F / \u72B6\u6001\u9762\u677F\u300D\u8FD9\u7C7B**\u989D\u5916\u52A8\u4F5C\u624D\u80FD\u6253\u5F00**\u7684\u533A\u5757\n   \uFF08`click_element` \u6253\u5F00\u5B83\uFF0C\u6216 `inspect_element({op:"text", selector:"#<\u72B6\u6001\u8282\u70B9>"})` \u8BFB\u5B83\uFF09\u2014\u2014\n   **\u771F\u5B9E\u6570\u503C\u901A\u5E38\u53EA\u5728\u90A3\u91CC**\uFF1B\n3. **\u5148"\u9A71\u52A8"\u64AD\u653E\u5668\uFF0C\u518D\u8C08\u7ED3\u8BBA** \u2014\u2014 \u53EA\u8BFB\u67D0\u4E00\u523B\u7684\u6570\u503C**\u62FF\u4E0D\u5230**\u300C\u5361\u987F / \u64AD\u5B8C\u300D\u7684\u8BC1\u636E\uFF0C\u5B83\u4EEC\u5FC5\u987B\u88AB**\u5236\u9020\u51FA\u6765**\uFF08\u505A\u6CA1\u505A\u8FC7\uFF0C\u9875\u9762\u81EA\u5DF1\u4F1A\u8BB0\u5728\u5E27\u6570 / \u4F4D\u7F6E / \u4E8B\u4EF6\u5E8F\u5217 / \u7F13\u51B2\u6B21\u6570\u4E0A\uFF09\uFF1A\n   \xB7 **\u8BA9\u5B83\u771F\u7684\u64AD\u8D77\u6765**\uFF1A`click_element` \u6309\u771F\u64AD\u653E\u63A7\u4EF6\uFF08selector \u6216 role+name \u7CBE\u786E\u5B9A\u4F4D\uFF09\uFF0C     \u7136\u540E `wait_for_element` \u7B49**\u771F\u5B9E\u64AD\u653E\u7684\u75D5\u8FF9**\uFF08"\u5DF2\u89E3\u7801\u5E27\u6570"\u53D8\u5927 / \u64AD\u653E\u4F4D\u7F6E\u63A8\u8FDB\uFF09\u3002\n     \u26A0 **\u4E0D\u8981**\u7528 `attached`/`visible` \u5F53"\u5728\u64AD"\u7684\u8BC1\u636E\uFF1A\u5143\u7D20\u4E00\u76F4\u5728\uFF0C\u90A3\u662F\u6700\u5F31\u7684\u4FE1\u53F7\uFF1B\n   \xB7 **\u6309\u4E00\u6B21\u300C\u6682\u505C\u300D**\uFF1A\u53EA\u6709\u6682\u505C\u8FC7\uFF0C\u624D\u5206\u5F97\u5F00"\u5728\u64AD"\u4E0E"\u505C\u4F4F"\uFF08\u6682\u505C\u540E\u4F4D\u7F6E\u5E94\u505C\u4F4F\uFF09\uFF1B\n   \xB7 **\u70B9\u300C\u8DF3\u5230\u672B\u5C3E / \u5FEB\u8FDB\u300D**\uFF1Aseek \u5230**\u672A\u7F13\u51B2\u533A\u95F4**\u624D\u4F1A\u771F\u7684\u89E6\u53D1\u4E00\u6B21**\u4E2D\u9014\u7F13\u51B2**\uFF08`waiting`\uFF09\uFF1B\n   \xB7 **\u8BA9\u5B83\u64AD\u5230\u7ED3\u5C3E**\uFF1A\u6CE8\u610F**\u4E24\u4E2A\u64AD\u653E\u5668\u5206\u5DE5\u4E0D\u540C** \u2014\u2014 \u300C\u8DF3\u5230\u672B\u5C3E\u300D\u90A3\u4E00\u4E0B\u662F\u7ED9**\u526F\u672C**\u5236\u9020\u4E2D\u9014\u7F13\u51B2\u7684\uFF08\u89C1\u4E0A\u4E00\u6761\uFF09\uFF0C**\u4E0D\u662F**\u8BA9\u4E3B\u64AD\u653E\u5668\u63D0\u524D\u6536\u5C3E\uFF1B**\u4E3B\u64AD\u653E\u5668**\u6309\u64AD\u653E\u4E4B\u540E**\u4E0D\u8981\u518D\u6682\u505C\u5B83**\uFF0C\u8BA9\u5B83**\u81EA\u7136\u64AD\u5230\u7247\u5C3E**\uFF08\u8FD9\u7C7B\u6F14\u793A\u7D20\u6750\u5F80\u5F80\u53EA\u6709\u51E0\u79D2\uFF09\uFF0C\u7136\u540E\u56DE\u8BFB**\u4E8B\u4EF6\u5E8F\u5217**\uFF1A**\u6CA1\u6709 `ended` \u5C31\u4E0D\u80FD\u4E0B"\u64AD\u5B8C\u4E86"\u7684\u7ED3\u8BBA** \u2014\u2014 \u90A3\u591A\u534A\u662F"\u4F60\u8BFB\u65E9\u4E86"\uFF0C\u6B64\u65F6\u5E94\u5F53**\u7B49\u4E00\u4F1A\u513F\u518D\u8BFB\u4E00\u6B21**\uFF08\u800C\u4E0D\u662F\u6539\u53E3\u8BF4\u64AD\u5B8C\u4E86\uFF09\uFF1B\n   \u26A0 \u8FD9\u56DB\u4EF6\u4E8B**\u53EA\u6709\u505A\u4E86\u624D\u4F1A\u7559\u4E0B\u75D5\u8FF9**\uFF0C"\u8BFB"\u662F\u8BFB\u4E0D\u51FA\u6765\u7684 \u2014\u2014 \u5C11\u505A\u4E00\u4EF6\uFF0C   "\u5361\u4F4F / \u64AD\u5B8C / \u505C\u4F4F"\u91CC\u5C31\u4F1A\u6709\u4E00\u6001**\u6839\u672C\u65E0\u4ECE\u5224\u65AD**\uFF1B\n4. **\u8BFB\u771F\u5B9E\u6570\u503C**\uFF1A`inspect_element({op:"text"})` \u8BFB\u90A3\u4E2A\u72B6\u6001\u8282\u70B9\uFF0C\u628A\n   **\u64AD\u653E\u4F4D\u7F6E**\uFF08\u771F\u7684\u63A8\u8FDB\u8FC7\u5417\uFF09\u3001**\u5DF2\u89E3\u7801\u5E27\u6570 / \u5E27\u8BA1\u6570**\uFF08\u771F\u7684\u51FA\u8FC7\u753B\u9762\u5417\uFF09\u3001\n   **\u7F13\u51B2/\u7B49\u5F85\u6B21\u6570**\uFF08\u6709\u6CA1\u6709\u5361\u987F\uFF09\u3001**\u4E8B\u4EF6\u5E8F\u5217**\uFF08play / waiting / playing / ended\uFF09\u90FD\u53D6\u56DE\u6765\uFF1B\n5. **\u533A\u5206\u4E09\u6001**\uFF1A\u6B63\u5728\u64AD = \u4F4D\u7F6E\u5728\u63A8\u8FDB\u4E14\u6CA1\u6709\u7B49\u5F85\uFF1B\u5361\u4F4F = \u4F4D\u7F6E\u505C\u4F4F\u4E14**\u7B49\u5F85\u6B21\u6570\u5728\u6DA8**\uFF1B\n   \u5DF2\u64AD\u5B8C = \u4F4D\u7F6E\u5230\u4E86\u672B\u5C3E\uFF08\u2248 \u603B\u65F6\u957F\uFF09\u4E14\u4E8B\u4EF6\u5E8F\u5217\u91CC\u6709 `ended`\u3002\n   \u53EA\u51ED\u67D0\u4E00\u77AC\u95F4\u7684 `paused` \u4F1A\u628A"\u5361\u4F4F"\u548C"\u64AD\u5B8C"\u770B\u53CD\uFF1B\n6. \u5F97\u51FA\u7ED3\u8BBA\u65F6**\u53EA\u7528\u4E0A\u9762\u90A3\u4E9B\u6570\u503C**\uFF0C\u5E76\u987A\u624B\u8BF4\u660E"\u9875\u9762\u90A3\u53E5\u6B63\u5728\u64AD\u653E\u662F\u5047\u7684/\u771F\u7684"\u3002\n\n## \u56DB\u6761\u7EAA\u5F8B\n- **\u4E0D\u4FE1\u9875\u9762\u5199\u7684\u72B6\u6001\u6587\u6848**\uFF1A\u72B6\u6001\u680F/\u8FDB\u5EA6\u6761\u6587\u6848\u53EF\u80FD\u662F\u5199\u6B7B\u7684\uFF1B\u8981\u5B83\u7ED9\u51FA\u6570\u503C\u518D\u4FE1\u3002\n- **`paused` \u4E0D\u662F\u8BC1\u636E\uFF0C\u5E27/\u4F4D\u7F6E\u63A8\u8FDB\u624D\u662F**\uFF1A`paused=false` + \u4F4D\u7F6E\u4E0D\u52A8 = \u6B63\u5728\u7F13\u51B2\u5361\u4F4F\u3002\n- **\u522B\u70B9\u90A3\u4E2A\u6700\u663E\u773C\u7684\u64AD\u653E\u952E\u5C31\u7B97\u5B8C**\uFF1A\u5148\u786E\u8BA4\u5B83\u662F\u771F\u7684\uFF08\u4E0E\u5A92\u4F53\u5173\u8054\uFF09\u8FD8\u662F\u88C5\u9970\u6027\u7684\uFF1B\n  \u70B9\u8FC7\u88C5\u9970\u6027\u63A7\u4EF6\u540E\u8981**\u56DE\u8BFB\u771F\u5B9E\u72B6\u6001**\uFF0C\u786E\u8BA4\u5B83\u6CA1\u63A8\u52A8\u4EFB\u4F55\u4E1C\u897F\u3002\n- **\u522B\u7528 `run_javascript` \u53BB\u8BFB `video.currentTime`**\uFF1A\u8BFB\u7C7B\u5DE5\u5177\u80FD\u62FF\u5230\u9875\u9762\u5DF2\u7ECF\u5199\u51FA\u6765\u7684\u72B6\u6001\uFF1B\n  \u786E\u5B9E\u9700\u8981\u65F6\u624D\u7528\uFF0C\u800C\u4E14\u90A3\u6761\u8DEF\u8981\u5F00 CDP\u3001\u6BCF\u6B21\u8FD8\u8981\u6253\u65AD\u7528\u6237\u5BA1\u6279\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u89C6\u9891\u5728\u64AD|\u5728\u4E0D\u5728\u64AD|\u64AD\u653E\u72B6\u6001|\u64AD\u653E\u5668|\u97F3\u9891|\u89C6\u9891|\u64AD\u5B8C|\u5361\u987F|\u7F13\u51B2", "\u786E\u8BA4.*\u64AD\u653E|\u64AD\u5230\u54EA|\u8FDB\u5EA6"],
      tools: ["get_page_snapshot", "click_element", "inspect_element", "wait_for_element", "complete_task"],
      playbook: "video-playback-verify"
    }
  },
  {
    name: "multi-candidate-convergence",
    displayName: "\u591A\u5019\u9009\u6536\u655B\uFF08\u591A\u5BB6\u91CC\u6311\u4E00\u5BB6\uFF1A\u9010\u6761\u6838\u5BF9\u7EA6\u675F + \u5173\u952E\u5C5E\u6027\u8981\u91CD\u8BFB\uFF09",
    description: "\u4ECE\u591A\u4E2A\u5019\u9009\u91CC\u6311\u4E00\u4E2A\u5E76\u63D0\u4EA4\u65F6\u4F7F\u7528\uFF1A\u6BD4\u4EF7 / \u9009\u822A\u73ED / \u9009\u623F / \u9009\u5957\u9910\uFF0C\u5019\u9009\u5404\u81EA\u7684\u5C5E\u6027\u8981\u9010\u6761\u6838\u5BF9\u624D\u5206\u5F97\u51FA\u9AD8\u4E0B\uFF0C\u6216\u67D0\u4E2A\u5C5E\u6027\u4F1A\u8FC7\u671F\u3001\u53EA\u8BFB\u4E00\u6B21\u53EF\u80FD\u4E0D\u6210\u7ACB\u3002\u5F53\u7528\u6237\u8BF4\u300C\u6BD4\u4EF7\u300D\u300C\u4ECE\u8FD9\u51E0\u5BB6\u91CC\u6311\u300D\u300C\u6311\u4E00\u5BB6\u6700\u5408\u9002\u7684\uFF0C\u8981\u6EE1\u8DB3\u8FD9\u51E0\u4E2A\u6761\u4EF6\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u6BD4\u4EF7", "\u591A\u5019\u9009", "\u7EA6\u675F\u6838\u5BF9", "\u8BE6\u60C5", "\u91CD\u8BFB"],
    skill_type: "prompt-template",
    content: '# \u591A\u5019\u9009\u6536\u655B\uFF1A\u9010\u6761\u6838\u5BF9\u7EA6\u675F\uFF0C\u5173\u952E\u5C5E\u6027\u8981\u91CD\u8BFB\n\n## \u4E09\u4E2A\u75C7\u72B6\uFF08\u90FD\u5C5E\u4E8E"\u770B\u8D77\u6765\u90FD\u884C"\uFF09\n- **\u7B2C\u4E00\u4E2A\u5C5E\u6027\u4E0D\u8DB3\u4EE5\u51B3\u65AD**\uFF1A\u5217\u8868\u4E0A\u6700\u663E\u773C\u7684\u90A3\u4E00\u5217\uFF08\u6807\u4EF7 / \u65F6\u957F / \u8BC4\u5206\uFF09\u6700\u5360\u6CE8\u610F\u529B\uFF0C  \u800C**\u6700\u4F4E\u7684\u90A3\u4E2A\u5F80\u5F80\u8FDD\u53CD\u540E\u9762\u7684\u67D0\u6761\u7EA6\u675F**\u3002\u53EA\u770B\u5B83\u5C31\u9009\uFF0C\u5FC5\u7136\u9519\u3002\n- **\u51B3\u5B9A\u6027\u5C5E\u6027\u4E0D\u5728\u5217\u8868\u91CC**\uFF1A\u5B83\u5728**\u5C55\u5F00\u8BE6\u60C5 / \u5207\u5230\u53E6\u4E00\u4E2A tab / \u70B9\u5F00\u884C\u5185\u9762\u677F**\u4E4B\u540E\u624D\u51FA\u73B0\u3002\n  \u6240\u4EE5"\u5217\u8868\u91CC\u6CA1\u770B\u5230"**\u4E0D\u7B49\u4E8E**"\u8FD9\u4E2A\u5C5E\u6027\u4E0D\u5B58\u5728"\u3002\n- **\u8BFB\u5230\u7684\u503C\u4F1A\u8FC7\u671F**\uFF1A\u5E93\u5B58\u3001\u62A5\u4EF7\u3001\u4F59\u91CF\u8FD9\u7C7B\u5C5E\u6027\u4F1A**\u5728\u9875\u9762\u505C\u7559\u540E\u53D8\u5316**\uFF0C  \u65E9\u5148\u8BFB\u5230\u7684\u503C\u53EF\u80FD\u5DF2\u7ECF\u4E0D\u6210\u7ACB\uFF1B\u9875\u9762\u82E5\u5199\u4E86"\u6BCF N \u79D2\u5237\u65B0 / \u5B9E\u65F6\u62A5\u4EF7 / \u7F13\u5B58"\uFF0C  \u90A3\u5B83\u5C31\u662F\u5728\u63D0\u9192\u4F60\uFF1A**\u7B2C\u4E00\u6B21\u8BFB\u5230\u7684\u5F80\u5F80\u662F\u7F13\u5B58\u503C\uFF0C\u51B3\u5B9A\u524D\u5FC5\u987B\u518D\u8BFB\u4E00\u6B21**\u3002\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u770B**\u6709\u51E0\u4E2A\u5019\u9009**\uFF08\u8BB0\u4F4F\u6709\u51E0\u4E2A\uFF0C\u540E\u9762\u8981**\u9010\u4E2A**\u5904\u7406\uFF09\uFF0C\u5E76\u628A\u7528\u6237\u7ED9\u7684**\u6BCF\u4E00\u6761**\u7EA6\u675F\u9010\u6761\u5217\u51FA\u6765 \u2014\u2014 \u542B\u90A3\u6761**\u4E0D\u663E\u773C**\u7684\uFF08\u5982\u300C\u8981\u80FD\u9000\u300D\uFF09\uFF1B\n2. **\u9010\u4E2A**\u7FFB\u5019\u9009\u7684\u8BE6\u60C5\uFF1A`click_element` \u70B9\u5F00\u300C\u67E5\u770B\u8BE6\u60C5\u300D\u8FD9\u7C7B\u6309\u94AE\uFF0C\u518D\u7528 `inspect_element({op:"text", selector:"#<\u5C5E\u6027\u8282\u70B9>"})` \u628A**\u6BCF\u4E00\u6761\u7EA6\u675F\u5BF9\u5E94\u7684\u5C5E\u6027\u90FD\u8BFB\u51FA\u6765**\u3002**\u4E0D\u8981\u53EA\u8BFB\u7B2C\u4E00\u540D** \u2014\u2014 \u7EA6\u675F\u662F**\u9010\u6761\u8FC7\u6EE4**\uFF0C\u4E0D\u662F\u6392\u5E8F\u53D6\u7B2C\u4E00\uFF0C\u53EA\u770B\u7B2C\u4E00\u540D\u5FC5\u7136\u6F0F\u6389\u540E\u9762\u7684\u7EA6\u675F\uFF1B\n3. \u26A0 **\u5148\u8BFB\u4E00\u6B21**\uFF1A\u7528 `inspect_element({op:"text", selector:"#<\u5C5E\u6027\u8282\u70B9>"})` \u628A\u5173\u952E\u5C5E\u6027\u8BFB\u51FA\u6765\u3002\u9875\u9762\u82E5\u5199\u4E86\u300C\u5B9E\u65F6 / \u6BCF N \u79D2\u5237\u65B0 / \u7F13\u5B58\u62A5\u4EF7\u300D\uFF0C\u8FD9\u4E00\u6B21\u8BFB\u5230\u7684**\u5C31\u662F\u7F13\u5B58\u503C**\uFF08\u9875\u9762\u6B63\u662F\u4ECE**\u7B2C\u4E00\u6B21\u8BFB**\u8D77\u624D\u5F00\u59CB\u91CD\u65B0\u8BE2\u4EF7\uFF09\uFF1B\n4. **\u7B49\u9875\u9762\u7ED9\u51FA\u5237\u65B0\u8BF4\u660E**\uFF1A`wait_for_element({selector:"#<\u5237\u65B0\u8BF4\u660E\u8282\u70B9>", state:"text_contains", text:"<\u5237\u65B0\u540E\u7684\u5B57\u6837>"})`\u3002\u26A0 **\u300C\u8BFB\u5230\u8FC7\u8FD9\u4E2A\u5143\u7D20\u300D\u4E0D\u7B97\u5237\u65B0\u8FC7** \u2014\u2014 \u8981\u7B49\u5B83\u7684**\u6587\u672C**\u53D8\u6210\u5237\u65B0\u540E\u7684\u6837\u5B50\uFF1B\u7528 `attached` / `visible` \u4F1A\u5728\u300C\u8FD8\u6CA1\u5237\u65B0\u300D\u65F6\u5C31\u7ACB\u523B\u6EE1\u8DB3\uFF08\u90A3\u662F\u66F4\u5F31\u7684\u4FE1\u53F7\uFF09\uFF1B\n5. **\u518D\u8BFB\u4E00\u6B21**\uFF08\u540C\u4E00\u4E2A\u5C5E\u6027\u8282\u70B9\uFF09\uFF0C\u62FF\u5230**\u5B9E\u65F6\u503C**\uFF1B\u53EA\u6709**\u91CD\u8BFB\u540E\u7684\u503C**\u624D\u7B97\u6570\uFF0C\u7528\u7F13\u5B58\u503C\u505A\u7684\u5224\u65AD\u53EF\u80FD\u6574\u4F53\u7FFB\u8F6C\u3002\u7528\u91CD\u8BFB\u540E\u7684\u503C\u9010\u6761\u8FC7\u6EE4\uFF1A\u53EA\u6709**\u540C\u65F6**\u6EE1\u8DB3\u5168\u90E8\u7EA6\u675F\u7684\u5019\u9009\u624D\u7B97\u8FC7\u5173\u3002\u8FC7\u6EE4\u5B8C\u8FD8\u6709\u591A\u4E2A\u7684\u8BDD\uFF0C\u518D\u6309\u7528\u6237\u7ED9\u7684\u90A3\u6761\u4E3B\u6307\u6807\u6311\uFF08\u300C\u603B\u4EF7\u6700\u4F4E\u300D\u8FD9\u7C7B\uFF09\uFF1B\n6. \u9009\u4E2D\u5B83\uFF08\u70B9\u300C\u9009\u62E9\u6B64\u9879\u300D/ \u5355\u9009\uFF09\uFF0C\u518D\u70B9\u300C\u63D0\u4EA4 / \u786E\u8BA4\u300D\uFF1B\n7. **\u8BFB\u56DE\u56DE\u6267**\uFF1A`inspect_element({op:"text", selector:"#status"})` \u786E\u8BA4\u63D0\u4EA4\u88AB**\u670D\u52A1\u7AEF**\u63A5\u53D7\u3001\u800C\u4E14\u56DE\u6267\u91CC\u7684\u7F16\u53F7\u4E0E\u91D1\u989D\u5C31\u662F\u4F60\u8981\u7684\u90A3\u4E00\u4E2A\u3002\n\n## \u56DB\u6761\u7EAA\u5F8B\n- **\u300C\u603B\u4EF7 / \u5230\u624B\u4EF7 / \u5B9E\u4ED8\u300D\u8FD9\u7C7B\u53E3\u5F84\u4F18\u5148\u4E8E\u6807\u4EF7**\uFF1A\u8FD0\u8D39\u3001\u5B9A\u91D1\u3001\u624B\u7EED\u8D39\u5E38\u5E38\u4E0D\u5728\u5217\u8868\u6700\u663E\u773C\u90A3\u4E00\u5217\u91CC\u3002\n- **\u522B\u7528\u300C\u7B2C\u4E00\u4E2A\u5C5E\u6027\u6700\u4F18\u300D\u5F53\u7ED3\u8BBA**\uFF1A\u5148\u6309\u5168\u90E8\u7EA6\u675F\u8FC7\u6EE4\uFF0C\u518D\u5728**\u5E78\u5B58\u8005**\u91CC\u6392\u5E8F\u3002\n- **\u522B\u628A\u300C\u9875\u9762\u4E0A\u663E\u793A\u6210\u529F\u300D\u5F53\u63D0\u4EA4\u6210\u529F**\uFF1A\u63D0\u4EA4\u7ED3\u679C\u8981\u4EE5\u56DE\u6267\u91CC\u7684**\u7F16\u53F7 / \u91D1\u989D**\u4E3A\u51C6\uFF1B  \u56DE\u6267\u91CC\u4E0D\u662F\u4F60\u8981\u7684\u90A3\u4E00\u4E2A\uFF0C\u5C31\u662F\u5931\u8D25\u4E86\u3002\n- **\u91CD\u8BFB\u4E0D\u662F\u91CD\u590D\u52B3\u52A8**\uFF1A\u8BFB\u8FC7\u7684\u503C\u53EF\u80FD\u5DF2\u7ECF\u8FC7\u671F\u3002\u9875\u9762\u7ED9\u4E86\u5237\u65B0\u4FE1\u53F7\u65F6\uFF0C**\u7B49\u4FE1\u53F7 + \u91CD\u8BFB**\uFF0C  \u5426\u5219\u4F60\u4F1A\u5728\u4E00\u4E2A\u300C\u5DF2\u7ECF\u4E0D\u5B58\u5728\u300D\u7684\u72B6\u6001\u4E0A\u505A\u51B3\u5B9A\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u6BD4\u4EF7|\u4ECE\u8FD9\u51E0\u5BB6|\u6311\u4E00\u5BB6|\u591A\u9009\u4E00|\u9009\u54EA\u4E2A\u66F4|\u6700\u5408\u9002\u7684\u90A3\u5BB6", "\u603B\u4EF7|\u5230\u624B\u4EF7|\u542B\u8FD0\u8D39|\u8BE6\u60C5|\u9010\u6761|\u7EA6\u675F|\u91CD\u8BFB|\u5B9E\u65F6"],
      tools: ["get_page_snapshot", "click_element", "inspect_element", "wait_for_element", "complete_task"],
      playbook: "multi-candidate-convergence"
    }
  },
  {
    name: "cascade-select",
    displayName: "\u7EA7\u8054\u4E0B\u62C9\u6846\uFF08\u9009\u4E86\u7236\u9879\uFF0C\u5B50\u9879\u5F02\u6B65\u586B\u5145\uFF09",
    description: "\u4E24\u4E2A\u4E0B\u62C9\u6846\u6709\u4F9D\u8D56\u5173\u7CFB\u65F6\u4F7F\u7528\uFF1A\u9009\u4E86\u7701\u4EFD\u624D\u51FA\u57CE\u5E02\u3001\u9009\u4E86\u5206\u7C7B\u624D\u51FA\u5B50\u7C7B\u3002\u5F53\u7528\u6237\u8BF4\u300C\u9009\u6210 X / Y\u300D\u300C\u5148\u9009\u2026\u518D\u9009\u2026\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u4E0B\u62C9\u6846", "\u7EA7\u8054", "\u8868\u5355", "\u5F02\u6B65\u9009\u9879"],
    skill_type: "prompt-template",
    content: '# \u7EA7\u8054\u4E0B\u62C9\u6846\n\n## \u75C7\u72B6\u4E0E\u6210\u56E0\n\u9009\u4E86\u7236\u9879\uFF08\u7701\u4EFD/\u5206\u7C7B\uFF09\u4E4B\u540E\uFF0C\u5B50\u9879\uFF08\u57CE\u5E02/\u5B50\u7C7B\uFF09\u7684\u9009\u9879\u662F**\u5F02\u6B65\u586B\u8FDB\u6765**\u7684\uFF08\u771F\u5B9E\u7AD9\u70B9\u662F\u8BF7\u6C42\u56DE\u6765\u624D\u6709\uFF09\u3002\n\u4E8E\u662F"\u9009\u5B8C\u7236\u9879\u7ACB\u523B\u9009\u5B50\u9879"\u4F1A\u5931\u8D25\uFF0C\u5DE5\u5177\u4F1A\u8BF4\u300C\u672A\u627E\u5230\u5339\u914D\u7684 option\u300D\u2014\u2014\n**\u8FD9\u53E5\u8BDD\u6781\u6613\u88AB\u8BFB\u6210"\u9875\u9762\u4E0A\u6CA1\u6709\u8FD9\u4E2A\u57CE\u5E02"**\uFF0C\u800C\u771F\u76F8\u53EA\u662F"\u8FD8\u6CA1\u586B\u8FDB\u6765"\u3002\n\u66F4\u9690\u853D\u7684\u662F\uFF1A\u586B\u5145\u671F\u95F4\u5B50\u4E0B\u62C9\u6846**\u5F80\u5F80\u8FD8\u662F `disabled`**\uFF0C\u6240\u4EE5**\u5149\u7B49"\u9009\u9879\u51FA\u73B0"\u4E0D\u591F\uFF0C\u8981\u7B49\u5230\u80FD\u7528**\u3002\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u770B\u6E05\u4E24\u4E2A\u6846\u7684\u4F9D\u8D56\u5173\u7CFB\uFF08\u5B50\u6846\u5E38\u5E26 "\u8BF7\u5148\u9009\u2026" \u6216 disabled\uFF09\uFF1B\n2. `select_option` \u9009\u7236\u9879\uFF1B\n3. **\u7B49\u5B50\u9879\u5C31\u7EEA**\uFF08\u4E24\u79CD\u90FD\u884C\uFF0C\u6309\u9875\u9762\u60C5\u51B5\u6311\uFF09\uFF1A\n   - **\u7B49\u5B50\u6846\u81EA\u5DF1\u53D8\u53EF\u7528**\uFF1A`wait_for_element({ ref, state: "enabled" })` \u2014\u2014\n     \u6700\u7701\u4E8B\uFF1A\u5B50\u6846\u4E00\u53EF\u7528\u5C31\u8BF4\u660E\u9009\u9879\u4E5F\u586B\u597D\u4E86\uFF08\u771F\u6A21\u578B eval \u5B9E\u6D4B\u8D70\u7684\u5C31\u662F\u8FD9\u6761\uFF09\uFF1B\n   - **\u7B49\u67D0\u4E2A\u9009\u9879\u51FA\u73B0**\uFF1A`wait_for_element({ selector: "#city option[value=\\"hz\\"]", state: "attached" })`\n     - \u26A0 \u7528 **`attached`**\uFF08\u6302\u5728 DOM \u4E0A\uFF09\u800C\u4E0D\u662F `visible`\uFF1A\n       `<option>` \u5728**\u95ED\u5408\u7684** `<select>` \u91CC**\u6CA1\u6709\u5E03\u5C40\u76D2\u5B50**\uFF0C\u7B49 `visible` \u4F1A\u4E00\u76F4\u7B49\u4E0D\u5230\uFF1B\n4. `select_option` \u9009\u5B50\u9879 \u2014\u2014 \u7528 `label`\uFF08\u663E\u793A\u6587\u672C\uFF09\u6216 `value` \u90FD\u884C\uFF0C\u4F46**\u5FC5\u987B\u7B49\u5B83\u5B58\u5728\u4E4B\u540E**\uFF1B\n5. \u63D0\u4EA4\u540E**\u8BFB\u56DE**\u9875\u9762\u72B6\u6001\uFF0C\u786E\u8BA4\u4E24\u4E2A\u6846\u7684\u503C\u90FD\u5BF9\u4E86\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **"\u672A\u627E\u5230\u5339\u914D\u7684 option" \u2260 \u9875\u9762\u4E0A\u6CA1\u6709\u8FD9\u4E2A\u9009\u9879**\uFF1A\u5148\u6000\u7591"\u8FD8\u6CA1\u586B\u8FDB\u6765"\uFF0C\u7B49\u4E00\u4E0B\u518D\u8BD5\u3002\n- **\u522B\u7528 `run_javascript` \u53BB\u5FF5 options \u6216\u76F4\u63A5\u8BBE value**\uFF1A`inspect_element` \u8BFB\u53D6\u7C7B\u5DE5\u5177\u8DB3\u591F\u770B\u6E05\u72B6\u6001\uFF0C\n  \u800C\u7ED5\u8FC7 select \u76F4\u63A5\u6539\u503C**\u4E0D\u4F1A\u89E6\u53D1\u9875\u9762\u7684 change \u903B\u8F91**\uFF08\u5B50\u9879\u5C31\u6C38\u8FDC\u4E0D\u4F1A\u586B\uFF09\u3002\n- **\u63D0\u4EA4\u524D\u786E\u8BA4\u4E24\u4E2A\u6846\u7684\u503C**\uFF08\u8BFB\u56DE\u9875\u9762\u56DE\u6267\uFF09\uFF0C\u4E0D\u8981\u53EA\u770B"\u6211\u8C03\u7528\u8FC7 select_option"\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u7EA7\u8054|\u5148\u9009.*\u518D\u9009|\u9009\u4E86.*\u624D|\u4E0B\u62C9\u6846|\u914D\u9001\u8303\u56F4|\u7701\u4EFD|\u57CE\u5E02", "\u9009\u6210|\u9009\u62E9"],
      tools: ["get_page_snapshot", "select_option", "wait_for_element", "click_element", "inspect_element", "complete_task"],
      playbook: "cascade-select"
    }
  },
  {
    name: "read-select-options",
    displayName: '\u8BFB\u4E0B\u62C9\u6846\u9009\u9879\uFF08"\u9009\u6700\u4FBF\u5B9C/\u6700\u5408\u9002"\u4E4B\u524D\u5148\u770B\u6709\u54EA\u4E9B\uFF09',
    description: "\u9700\u8981\u6309\u5C5E\u6027\u6311\u9009\u9879\u65F6\u4F7F\u7528\uFF1A\u6700\u4FBF\u5B9C\u3001\u6700\u5FEB\u3001\u6700\u5927\u3001\u6700\u65B0\u90A3\u4E00\u4E2A\u3002\u5F53\u7528\u6237\u8BF4\u300C\u9009\u6700\u2026\u7684\u90A3\u4E2A\u300D\u800C\u6CA1\u70B9\u540D\u5177\u4F53\u9009\u9879\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u4E0B\u62C9\u6846", "\u9009\u9879", "\u6BD4\u8F83", "\u53EA\u8BFB"],
    skill_type: "prompt-template",
    content: '# \u6309\u5C5E\u6027\u6311\u9009\u9879\uFF1A\u5148\u8BFB\uFF0C\u518D\u9009\n\n## \u4E3A\u4EC0\u4E48\u5FC5\u987B"\u5148\u8BFB"\n**\u95ED\u5408\u7684 `<select>` \u91CC\uFF0C`<option>` \u7684\u6587\u6848\u4E0D\u5728\u9875\u9762\u6B63\u6587\u91CC** \u2014\u2014\n\u9009\u9879\u6CA1\u6709\u5E03\u5C40\u76D2\u5B50\uFF0C\u6B63\u6587\u62BD\u53D6\u6309"\u4E0D\u53EF\u89C1"\u8DF3\u8FC7\u3002\u4E8E\u662F\uFF1A\n- `get_page_snapshot` \u7684\u6B63\u6587\u91CC\u53EA\u6709\u300C\u914D\u9001\u65B9\u5F0F\u300D\u8FD9\u79CD label\uFF0C**\u770B\u4E0D\u5230 \xA58 / \xA522 / \xA55**\uFF1B\n- \u4EF7\u683C\u3001\u89C4\u683C\u3001\u65F6\u957F\u5F80\u5F80**\u53EA\u5199\u5728\u9009\u9879\u6587\u6848\u91CC**\uFF1B\n- `get_attribute` \u4E5F\u5E2E\u4E0D\u4E0A\uFF1A\u5B83\u8BFB\u7684\u662F**\u5C5E\u6027**\uFF08disabled/href/data-*\uFF09\uFF0C\u8BFB\u4E0D\u4E86 `outerHTML`\u3002\n\n\u6240\u4EE5"\u9009\u6700\u4FBF\u5B9C\u7684\u90A3\u4E2A"\u8FD9\u7C7B\u4EFB\u52A1\uFF0C**\u4E0D\u628A\u9009\u9879\u5217\u51FA\u6765\u5C31\u65E0\u4ECE\u6BD4\u8F83**\uFF0C\u53EA\u80FD\u9760\u731C \u2014\u2014 \u800C\u731C\u9519\u662F\u9759\u9ED8\u7684\n\uFF08\u9875\u9762\u7167\u6837\u63A5\u53D7\u4F60\u9009\u7684\u4EFB\u4F55\u4E00\u9879\uFF09\u3002\n\n## \u6B65\u9AA4\n1. `inspect_element({ op: "options", selector: "#ship" })` \u2014\u2014 \u8BFB\u51FA\u9009\u9879\u6E05\u5355\uFF1A\n   \u6BCF\u9879\u7ED9\u51FA `value`\u3001\u663E\u793A\u6587\u5B57\uFF0C\u5E76\u6807\u51FA**\u5F53\u524D\u9009\u4E2D**\u4E0E**\u7981\u7528**\uFF1B\n2. \u6309\u7528\u6237\u7684\u6761\u4EF6\u6BD4\u8F83\uFF08\u4EF7\u683C/\u65F6\u957F/\u89C4\u683C\u901A\u5E38\u5C31\u5728**\u663E\u793A\u6587\u5B57**\u91CC\uFF09\uFF1B\n3. `select_option` \u9009\u4E2D\u5B83 \u2014\u2014 \u7528 `value` \u6216 `label` \u90FD\u884C\uFF08`label` \u8981**\u6574\u6BB5\u7167\u6284**\uFF09\uFF1B\n4. \u9700\u8981\u63D0\u4EA4\u5C31\u518D\u70B9\u6309\u94AE\uFF0C\u5E76**\u8BFB\u56DE\u9875\u9762\u56DE\u6267**\u786E\u8BA4\u9009\u4E2D\u7684\u786E\u5B9E\u662F\u90A3\u4E00\u9879\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u522B\u7528 `run_javascript` \u53BB\u5FF5\u9009\u9879**\uFF1A`inspect_element({op:"options"})` \u5C31\u662F\u5E72\u8FD9\u4E2A\u7684\uFF0C\n  \u800C\u4E14\u5B83\u662F**\u53EA\u8BFB**\u7684\uFF08\u4E0D\u6253\u65AD\u7528\u6237\u3001\u4E0D\u53D7\u9875\u9762 CSP \u9650\u5236\uFF09\u3002\u5B9E\u6D4B\u5728\u6CA1\u6709\u5B83\u4E4B\u524D\uFF0C\n  \u6A21\u578B\u53EA\u80FD\u5199\u4E00\u6BB5 JS \u53BB `Array.from(s.options)` \u2014\u2014 \u767D\u82B1\u4E00\u6B21\u9AD8\u5371\u5BA1\u6279\u3002\n- **\u522B\u731C value\u3001\u522B\u731C\u987A\u5E8F**\uFF1A\u9009\u9879\u987A\u5E8F\u4E0E value \u547D\u540D\u662F\u9875\u9762\u8BF4\u4E86\u7B97\uFF08`eco` \u672A\u5FC5\u6392\u7B2C\u4E00\uFF0C\n  \u4E5F\u53EF\u80FD\u53EB `saver`/`p3`\uFF09\u3002\u5148\u8BFB\u518D\u9009\u3002\n- **\u6CE8\u610F"\u7981\u7528"\u4E0E"\u5F53\u524D\u9009\u4E2D"\u4E24\u4E2A\u6807\u8BB0**\uFF1A\u7981\u7528\u7684\u9009\u4E86\u4E5F\u6CA1\u7528\uFF1B\u5DF2\u7ECF\u662F\u5F53\u524D\u503C\u7684\u4E0D\u7528\u91CD\u590D\u9009\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u6700\u4FBF\u5B9C|\u6700\u4FBF\u5B9C\u7684\u90A3\u4E2A|\u6700\u5212\u7B97|\u6700\u5FEB|\u6700\u5408\u9002|\u6700.*\u7684\u90A3\u4E2A", "\u9009.*\u54EA\u4E2A|\u914D\u9001\u65B9\u5F0F|\u9009\u9879"],
      tools: ["get_page_snapshot", "inspect_element", "select_option", "click_element", "complete_task"],
      playbook: "read-select-options"
    }
  },
  {
    name: "page-world-js",
    displayName: "\u8BFB\u9875\u9762 JS \u72B6\u6001 / \u4E25\u683C CSP \u9875\u9762\uFF08\u6C99\u7BB1\u88AB\u62D2\u4F1A\u81EA\u52A8\u6539\u7528\u9875\u9762\u4E3B\u4E16\u754C\uFF09",
    description: "\u8981\u8BFB\u9875\u9762\u81EA\u5DF1\u7684 JS \u53D8\u91CF\u3001\u6216\u8C03\u7528\u9875\u9762\u66B4\u9732\u7684\u51FD\u6570\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300CJS \u91CC\u7684\u771F\u5B9E\u503C / \u9875\u9762\u72B6\u6001 / \u63A7\u5236\u53F0\u91CC\u90A3\u4E2A\u53D8\u91CF\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u9875\u9762\u4E3B\u4E16\u754C", "CSP", "JS \u72B6\u6001", "run_javascript"],
    skill_type: "prompt-template",
    content: '# \u8BFB\u9875\u9762\u7684 JS \u72B6\u6001\uFF08\u800C\u4E0D\u662F DOM\uFF09\n\n## \u4EC0\u4E48\u65F6\u5019\u9700\u8981\u5B83\nDOM \u4E0A\u663E\u793A\u7684\u4E1C\u897F**\u672A\u5FC5\u662F\u771F\u5B9E\u72B6\u6001**\uFF08\u9648\u65E7\u6E32\u67D3\u3001\u53EA\u6E32\u67D3\u4E86\u4E00\u90E8\u5206\u3001\u683C\u5F0F\u5316\u8FC7\uFF09\u3002\n\u771F\u5B9E\u503C\u5E38\u5E38\u53EA\u5728\u9875\u9762\u7684 JS \u91CC\uFF1A`window.__appState`\u3001\u6846\u67B6\u7684 store\u3001\u9875\u9762\u66B4\u9732\u7684\u51FD\u6570\u3002\n\u5178\u578B\u7684\u7528\u6237\u63D0\u6CD5\uFF1A\u300C\u9875\u9762\u663E\u793A\u7684\u548C\u5B9E\u9645\u5BF9\u4E0D\u4E0A\u300D\u300C\u63A7\u5236\u53F0\u91CC\u90A3\u4E2A\u53D8\u91CF\u662F\u591A\u5C11\u300D\u3002\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u5148\u770B DOM \u2014\u2014 \u4F46\u8981\u610F\u8BC6\u5230**DOM \u53EF\u80FD\u662F\u9648\u65E7\u503C**\uFF1B\n2. `run_javascript({ code: "window.__appState && window.__appState.total" })` \u2014\u2014\n   **\u8FD9\u6761\u5DE5\u5177\u9700\u8981\u5F00\u542F CDP**\uFF08\u89C1\u4E0B\uFF09\uFF1B\u6CA1\u5F00 CDP \u65F6\u4F1A\u76F4\u63A5\u5931\u8D25\u5E76\u63D0\u793A\u4F60\u5F00\u542F\uFF0C\u4E0D\u7528\u53CD\u590D\u91CD\u8BD5\uFF1B\n3. \u9700\u8981**\u9875\u9762\u81EA\u5DF1\u7684\u53D8\u91CF\u6216\u51FD\u6570**\u65F6\uFF0C\u8D70\u9875\u9762\u4E3B\u4E16\u754C\uFF1A\n   - \u26A0 \u9ED8\u8BA4\u7684"\u53D7\u9650\u6C99\u7BB1"\u5176\u5B9E**\u5728\u4EFB\u4F55\u9875\u9762\u4E0A\u90FD\u8DD1\u4E0D\u8D77\u6765**\uFF1A\u6C99\u7BB1\u7528 `new Function`\uFF0C\n     \u800C **MV3 \u6269\u5C55\u81EA\u8EAB\u7684 CSP \u4E0D\u5141\u8BB8 eval** \u2014\u2014 \u8FD9\u4E0E\u9875\u9762\u65E0\u5173\n     \uFF08\u5B9E\u6D4B\u5728\u6CA1\u6709\u4EFB\u4F55 CSP \u7684\u9875\u9762\u4E0A\u540C\u6837\u88AB\u62D2\uFF09\u3002\u6240\u4EE5\u5DE5\u5177\u603B\u662F\u81EA\u52A8\u6539\u7528\u9875\u9762\u4E3B\u4E16\u754C\uFF1B\n   - \u6C99\u7BB1\u8FD8\u8DD1\u5728**\u9694\u79BB\u4E16\u754C**\u91CC\uFF0C**\u770B\u4E0D\u5230\u9875\u9762\u7684 JS \u53D8\u91CF**\uFF08DOM \u5171\u4EAB\u3001\u9875\u9762\u5168\u5C40\u4E0D\u5171\u4EAB\uFF09\uFF0C\n     \u6240\u4EE5\u8BFB\u9875\u9762\u72B6\u6001\u65F6**\u663E\u5F0F**\u7ED9 `engine:"page"` \u66F4\u76F4\u63A5\u3002\n4. \u8C03\u9875\u9762\u51FD\u6570\u540C\u7406\uFF1A`run_javascript({ code: "window.reportTotals(); return window.__checked" })`\uFF1B\n5. **\u8BFB\u56DE\u786E\u8BA4**\uFF1A\u628A\u7ED3\u679C\u4E0E DOM \u4E0A\u7684\u663E\u793A\u5BF9\u7167\uFF0C\u5DEE\u5F02\u672C\u8EAB\u5C31\u662F\u7ED3\u8BBA\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u533A\u5206"DOM \u91CC\u6CA1\u6709"\u4E0E"JS \u91CC\u6CA1\u6709"**\uFF1A\u4E0D\u8981\u56E0\u4E3A DOM \u4E0A\u627E\u4E0D\u5230\u5C31\u65AD\u8A00"\u9875\u9762\u4E0A\u6CA1\u6709\u8FD9\u4E2A\u6570\u636E"\u3002\n- **\u9700\u8981 CDP**\uFF1A\u9875\u9762\u4E3B\u4E16\u754C\u6267\u884C\u8D70 `chrome.debugger`\u3002\u6CA1\u5F00 CDP \u65F6\u5DE5\u5177\u4F1A**\u660E\u786E\u544A\u8BC9\u4F60**\n  \uFF08\u300C\u6539\u7528\u9875\u9762\u4E3B\u4E16\u754C\u9700\u8981 CDP\u300D\uFF09\u2014\u2014 \u8FD9\u65F6\u5E94\u5F53**\u5982\u5B9E\u8BF4\u660E\u505A\u4E0D\u5230\u3001\u5E76\u5EFA\u8BAE\u5F00\u542F CDP**\uFF0C\n  \u4E0D\u8981\u7ED5\u4E00\u5708\u53BB\u731C\u3001\u66F4\u4E0D\u8981\u5047\u88C5\u8BFB\u5230\u4E86\u3002\n- **\u522B\u62FF DOM \u5F53\u771F\u76F8**\uFF1A\u7528\u6237\u95EE"\u771F\u5B9E\u503C"\u65F6\uFF0CDOM \u4E0A\u7684\u6570\u5B57\u6070\u6070\u53EF\u80FD\u662F\u9519\u7684\u90A3\u4E2A\u3002',
    x: {
      intents: ["browser_task"],
      tools: ["get_page_snapshot", "run_javascript", "inspect_element", "complete_task"],
      keywords: ["JS \u72B6\u6001|\u9875\u9762\u72B6\u6001|\u63A7\u5236\u53F0|window\\.|\u771F\u5B9E\u503C|\u6838\u5BF9\u603B\u4EF7|\u53D8\u91CF\u91CC"],
      playbook: "csp-page-world-js"
    }
  },
  {
    name: "undo-last-action",
    displayName: "\u64A4\u9500\u4E0A\u4E00\u6B65\uFF08\u53EA\u56DE\u9000\u6700\u540E\u4E00\u6B21\u53EF\u64A4\u9500\u52A8\u4F5C\uFF09",
    description: "\u9700\u8981\u64A4\u56DE\u521A\u624D\u7684\u6539\u52A8\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u64A4\u9500 / \u64A4\u56DE / \u6539\u56DE\u6765 / \u521A\u624D\u90A3\u6B65\u4E0D\u7B97\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u64A4\u9500", "\u56DE\u9000", "\u8BEF\u64CD\u4F5C", "\u6062\u590D"],
    skill_type: "prompt-template",
    content: '# \u64A4\u9500\uFF1A\u80FD\u64A4\u56DE\u4EC0\u4E48\u3001\u64A4\u4E0D\u56DE\u4E86\u4EC0\u4E48\n\n## \u26A0 \u5148\u8BA4\u6E05\u8FB9\u754C\uFF1A**\u70B9\u51FB\u4E0E\u5BFC\u822A\u4E0D\u53EF\u64A4\u9500**\n\u64A4\u9500\u6808\u53EA\u8BB0\u5F55**\u53EF\u9006\u7684\u6539\u52A8**\uFF1A\u8F93\u5165\u6587\u672C / \u52FE\u9009 / \u9009\u62E9\u4E0B\u62C9 / \u6539\u6837\u5F0F / \u6EDA\u52A8\u3002\n**\u70B9\u51FB\u6309\u94AE\u3001\u8DF3\u8F6C\u9875\u9762\u90FD\u4E0D\u8FDB\u6808**\u3002\u6240\u4EE5\uFF1A\n- \u300C\u70B9\u4E86\u4FDD\u5B58 \u2192 \u8BF4\u64A4\u9500\u300D**\u4E0D\u4F1A\u64A4\u6389\u90A3\u6B21\u4FDD\u5B58**\uFF08\u5B83\u64A4\u7684\u662F\u4FDD\u5B58**\u4E4B\u524D**\u6700\u540E\u4E00\u6B21\u53EF\u9006\u6539\u52A8\uFF09\uFF1B\n- \u70B9\u4E86\u63D0\u4EA4/\u4E0B\u5355\u8FD9\u7C7B**\u6709\u526F\u4F5C\u7528**\u7684\u52A8\u4F5C\uFF0C\u64A4\u9500**\u6551\u4E0D\u56DE\u6765** \u2014\u2014 \u8981\u5982\u5B9E\u8BF4\u660E\u3002\n\n## \u6B65\u9AA4\n1. \u5148\u60F3\u6E05\u695A"\u7528\u6237\u8981\u64A4\u7684\u662F\u54EA\u4E00\u6B65"\uFF0C\u4EE5\u53CA\u5B83**\u662F\u5426\u53EF\u64A4\u9500**\uFF08\u4E0A\u4E00\u6761\uFF09\uFF1B\n2. `undo_last_action` \u2014\u2014 \u6BCF\u6B21\u53EA\u5F39**\u4E00\u683C**\uFF08\u6700\u540E\u4E00\u6B21\u53EF\u9006\u52A8\u4F5C\uFF09\u3002\u8981\u591A\u64A4\u51E0\u6B65\u5C31\u591A\u8C03\u51E0\u6B21\uFF1B\n3. **\u8BFB\u56DE\u9875\u9762\u786E\u8BA4\u64A4\u6389\u4E86\u4EC0\u4E48**\uFF1A\u5DE5\u5177\u7684\u8FD4\u56DE\u53EA\u8BF4\u300C\u5DF2\u64A4\u9500\u4E0A\u4E00\u6B65\u64CD\u4F5C\u300D\uFF0C\n   **\u4E0D\u544A\u8BC9\u4F60\u64A4\u7684\u662F\u54EA\u4E00\u683C**\u3002\u6240\u4EE5\u5FC5\u987B\u56DE\u8BFB\u76F8\u5173\u5B57\u6BB5\uFF08`inspect_element({op:"text"})`\n   \u8BFB\u72B6\u6001\u6587\u6848\u3001\u6216\u5FEB\u7167\u91CC\u7684\u503C\uFF09\uFF0C\u628A"\u64A4\u540E\u7684\u5B9E\u9645\u72B6\u6001"\u4F5C\u4E3A\u4F9D\u636E\uFF1B\n4. \u6C47\u62A5\u65F6\u8BF4\u6E05**\u54EA\u4E9B\u88AB\u64A4\u4E86\u3001\u54EA\u4E9B\u6CA1\u6709**\uFF08\u5C24\u5176\u662F"\u90A3\u6B21\u70B9\u51FB/\u63D0\u4EA4\u64A4\u4E0D\u56DE\u6765"\uFF09\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u522B\u628A"\u8C03\u7528\u4E86\u64A4\u9500"\u5F53\u6210"\u64A4\u6210\u529F\u4E86"**\uFF1A\u8BFB\u56DE\u624D\u7B97\u6570\uFF08\u8FD9\u6761\u548C\u5176\u5B83\u52A8\u4F5C\u4E00\u6837\uFF09\u3002\n- **\u64A4\u9500\u6808\u4F1A\u7D2F\u8BA1**\uFF1A\u8FDE\u70B9\u4E24\u6B21\u64A4\u9500\u4F1A\u8FDE\u64A4\u4E24\u6B65 \u2014\u2014 \u53EA\u60F3\u64A4\u4E00\u6B65\u5C31\u522B\u591A\u70B9\u3002\n- **\u9875\u9762\u5BFC\u822A\u4F1A\u6E05\u7A7A\u64A4\u9500\u6808**\uFF08\u5185\u5BB9\u811A\u672C\u91CD\u8F7D\uFF09\uFF0C\u8DF3\u8F6C\u8FC7\u4E4B\u540E\u5C31\u522B\u6307\u671B\u8FD8\u80FD\u64A4\u56DE\u53BB\u3002',
    x: {
      intents: ["browser_task"],
      tools: ["undo_last_action", "inspect_element", "get_page_snapshot", "type_text", "check_box", "select_option", "click_element", "complete_task"],
      keywords: ["\u64A4\u9500|\u64A4\u56DE|\u6539\u56DE\u6765|\u521A\u624D\u90A3\u6B65|\u56DE\u9000"],
      playbook: "undo-last-action"
    }
  },
  {
    name: "form-validation",
    displayName: "\u63D0\u4EA4\u6CA1\u53CD\u5E94\uFF1AHTML5 \u539F\u751F\u6821\u9A8C\u9759\u9ED8\u62E6\u4F4F\uFF08\u9875\u9762\u4E0A\u4EC0\u4E48\u90FD\u4E0D\u8BF4\uFF09",
    description: "\u8868\u5355\u70B9\u63D0\u4EA4\u6CA1\u53CD\u5E94\u3001\u9875\u9762\u4E0A\u53C8\u6CA1\u6709\u4EFB\u4F55\u63D0\u793A\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u63D0\u4EA4\u4E0D\u4E86 / \u70B9\u4E86\u6CA1\u53CD\u5E94 / \u8868\u5355\u586B\u5B8C\u4E86\u4F46\u6CA1\u63D0\u4EA4\u4E0A\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u8868\u5355", "\u6821\u9A8C", "\u9759\u9ED8\u5931\u8D25", "HTML5"],
    skill_type: "prompt-template",
    content: '# \u63D0\u4EA4\u6CA1\u53CD\u5E94\uFF1F\u5148\u6000\u7591 HTML5 \u539F\u751F\u6821\u9A8C\n\n## \u75C7\u72B6\u4E0E\u6210\u56E0\n\u70B9\u4E86\u63D0\u4EA4**\u4EC0\u4E48\u90FD\u6CA1\u53D1\u751F**\uFF1A\u9875\u9762\u4E0D\u53D8\u3001\u6CA1\u6709\u9519\u8BEF\u6587\u6848\u3001\u63A7\u5236\u53F0\u4E5F\u6CA1\u62A5\u9519\u3002\n\u6700\u5E38\u89C1\u7684\u539F\u56E0\u662F**\u6D4F\u89C8\u5668\u81EA\u5DF1\u7684\u8868\u5355\u6821\u9A8C**\u628A `submit` \u62E6\u4F4F\u4E86 \u2014\u2014\n\u5B83\u53EA\u5728**\u81EA\u5DF1\u7684\u539F\u751F\u6C14\u6CE1**\u91CC\u63D0\u793A\uFF0C\u90A3\u4E1C\u897F**\u8BFB\u4E0D\u5230**\uFF08\u4E0D\u5728 DOM \u91CC\uFF09\uFF0C\n\u6240\u4EE5\u4ECE\u9875\u9762\u72B6\u6001\u770B\u5C31\u662F"\u6309\u94AE\u597D\u50CF\u574F\u4E86"\u3002\n\n## \u6B65\u9AA4\n1. `inspect_element({ op: "inspect", selector: "<\u8868\u5355>" })` \u2014\u2014\n   \u8FD4\u56DE\u91CC\u4F1A\u5217\u51FA**\u6CA1\u901A\u8FC7\u6821\u9A8C\u7684\u5B57\u6BB5\u3001\u539F\u56E0\u4E0E\u6D4F\u89C8\u5668\u7ED9\u7684\u539F\u6587\u63D0\u793A**\uFF1B\n   - **\u67E5\u8C01\u90FD\u53EF\u4EE5**\uFF1A\u8868\u5355\u672C\u8EAB\u3001\u91CC\u9762\u4EFB\u610F\u4E00\u4E2A\u5B57\u6BB5\u3001\u751A\u81F3**\u4F60\u521A\u70B9\u7684\u90A3\u4E2A\u63D0\u4EA4\u6309\u94AE** \u2014\u2014\n     \u53EA\u8981\u5B83\u5728 `<form>` \u91CC\uFF0C\u5C31\u4F1A\u628A**\u8BE5\u8868\u5355**\u672A\u901A\u8FC7\u7684\u5B57\u6BB5\u4E00\u5E76\u62A5\u51FA\u6765\n     \uFF08\u6821\u9A8C\u7684\u4F5C\u7528\u57DF\u672C\u6765\u5C31\u662F\u8868\u5355\uFF1B\u5B9E\u6D4B\u6A21\u578B\u53EA\u770B\u6309\u94AE\u3001\u7ED3\u679C\u4E00\u65E0\u6240\u83B7\uFF09\uFF1B\n2. \u6309\u539F\u56E0\u6539\u503C\uFF08\u4F8B\uFF1A`patternMismatch` \u2192 \u4E0D\u7B26\u5408\u5B57\u6BB5\u8981\u6C42\u7684\u683C\u5F0F\uFF1B\n   `typeMismatch` \u2192 \u6BD4\u5982\u90AE\u7BB1\u5C11\u4E2A `@`\uFF1B`valueMissing` \u2192 \u5FC5\u586B\u6CA1\u586B\uFF09\uFF1B\n3. \u518D\u63D0\u4EA4\uFF0C\u5E76**\u8BFB\u56DE\u786E\u8BA4**\uFF08\u9875\u9762\u4E0A\u51FA\u73B0\u6210\u529F\u56DE\u6267\u624D\u7B97\u6570\uFF09\uFF1B\n4. \u82E5\u786E\u5B9E\u6CA1\u6709"\u672A\u901A\u8FC7\u6821\u9A8C"\u7684\u5B57\u6BB5\uFF0C\u518D\u53BB\u770B\u63A7\u5236\u53F0/\u7F51\u7EDC\u3002\n\n## \u56DB\u4E2A\u8981\u70B9\n- **\u539F\u56E0\u540D\u6BD4\u63D0\u793A\u8BED\u53EF\u9760**\uFF1A\u8FD4\u56DE\u91CC\u7ED9\u7684\u662F `patternMismatch` / `typeMismatch` \u8FD9\u7C7B\n  **\u4E0E\u8BED\u8A00\u65E0\u5173**\u7684\u7EA6\u675F\u540D\uFF1B`validationMessage` \u90A3\u6BB5\u539F\u6587\u4F1A\u968F**\u6D4F\u89C8\u5668\u8BED\u8A00**\u53D8\uFF08\u4E2D/\u82F1/\u65E5\uFF09\uFF0C\n  \u522B\u62FF\u5B83\u5F53\u4F9D\u636E\u53BB\u6BD4\u5BF9\u3002\n- **\u522B\u7528 `run_javascript` \u81EA\u5DF1\u626B `:invalid`**\uFF1A`inspect_element` \u5DF2\u7ECF\u628A\u8FD9\u4EF6\u4E8B\u505A\u5B8C\u4E86\uFF0C\n  \u81EA\u5DF1\u5199\u4E00\u6BB5\u9664\u4E86\u591A\u82B1\u4E00\u6B21\u9AD8\u5371\u5BA1\u6279\u6CA1\u6709\u522B\u7684\u6536\u76CA\u3002\n- **\u522B\u628A"\u6CA1\u53CD\u5E94"\u5F53\u6210"\u6309\u94AE\u574F\u4E86"**\uFF1A\u5148\u6309\u4E0A\u9762\u8BFB\u4E00\u6B21\uFF0C\u518D\u51B3\u5B9A\u8981\u4E0D\u8981\u6362\u5B9A\u4F4D\u6216\u6362\u5DE5\u5177\u3002\n- \u26A0 **`minlength` \u62E6\u4E0D\u4F4F\u4F60\u5199\u8FDB\u53BB\u7684\u503C**\uFF1A\u6309\u89C4\u8303"\u592A\u77ED"\u9700\u8981\u7528\u6237\u8F93\u5165\u4EA7\u751F\u7684\u810F\u503C\u6807\u8BB0\uFF0C\n  \u800C\u5DE5\u5177\u662F\u7A0B\u5E8F\u5316\u5199\u503C\u7684 \u2014\u2014 \u6240\u4EE5\u4E00\u4E2A**\u53EA**\u7528 `minlength` \u7684\u8868\u5355\uFF0C\u811A\u672C\u5199\u77ED\u503C\u4E5F\u80FD\u63D0\u4EA4\u8FC7\u53BB\u3002\n  \u8FD9\u65E2\u662F"\u522B\u6307\u671B\u5B83\u62E6\u4F4F\u4F60"\uFF0C\u4E5F\u662F"\u7528\u6237\u624B\u52A8\u586B\u65F6\u5B83\u7167\u6837\u4F1A\u62E6"\uFF08\u522B\u628A\u5B83\u5F53\u6210\u4E0D\u5B58\u5728\uFF09\u3002',
    x: {
      intents: ["browser_task"],
      tools: ["inspect_element", "type_text", "check_box", "select_option", "click_element", "get_page_snapshot", "read_diagnostics", "complete_task"],
      keywords: ["\u63D0\u4EA4\u4E0D\u4E86|\u63D0\u4EA4\u6CA1\u53CD\u5E94|\u70B9\u4E86\u6CA1\u53CD\u5E94|\u62A5\u540D\u8868|\u8868\u5355|\u6821\u9A8C|\u586B\u5F97\u4E0D\u5BF9|\u586B\u597D.*\u63D0\u4EA4|\u6539\u6210\u80FD\u901A\u8FC7"],
      playbook: "form-validation"
    }
  },
  {
    name: "paywall-boundary",
    // ⚠ 口径（明确到这个技能的**目标**是什么）：找**合法免费可看**的那一份内容
    //（免费集 / 试看窗口 / 官方免费入口 / 限时免费），并**如实判定能不能看**。
    // 它**不是**"攻破付费墙"的技能：解析播放地址、盗播站、伪造会员、绕过鉴权一律不在范围内
    //（正文「四条纪律」里写死，并由 tests/skill-playbook-contract.test.mjs 的文案口径门禁盯着）。
    displayName: "\u7528\u6237\u8981\u514D\u8D39\u7684 \u2192 \u5C31**\u53BB\u627E**\u80FD\u770B\u7684\u90A3\u4E00\u4EFD\uFF08\u300C\u80FD\u6253\u5F00\u300D\u4E0D\u7B49\u4E8E\u300C\u80FD\u770B\u300D\uFF09",
    description: '\u7528\u6237\u8BF4\u60F3\u514D\u8D39\u770B\u67D0\u96C6\u5267\u96C6/\u89C6\u9891\u3001\u6CA1\u4F1A\u5458\u3001\u95EE\u300C\u80FD\u514D\u8D39\u770B\u5417\u300D\u300C\u54EA\u51E0\u96C6\u514D\u8D39\u300D\u65F6\u4F7F\u7528\u3002**\u4EFB\u52A1\u5C31\u662F\u53BB\u627E**\uFF1A\u628A**\u5408\u6CD5\u514D\u8D39**\u80FD\u770B\u7684\u90A3\u4E9B\u6765\u6E90\u627E\u51FA\u6765\u4EA4\u7ED9\u4ED6\uFF08\u514D\u8D39\u96C6\u3001\u8BD5\u770B\u7A97\u53E3\u3001\u5B98\u65B9\u514D\u8D39\u5165\u53E3\u3001\u9650\u65F6\u514D\u8D39\uFF09\uFF0C\u5E76\u5E26\u4E0A"\u5230\u5E95\u80FD\u4E0D\u80FD\u770B"\u7684\u8BC1\u636E \u2014\u2014 \u522B\u7EA0\u7ED3"\u8FD9\u4E2A\u8981\u4E0D\u8981\u94B1"\uFF0C\u4E5F\u522B\u6559\u80B2\u7528\u6237\uFF0C\u53BB\u627E\u5C31\u5BF9\u4E86\uFF1B\u786E\u5B9E\u4E00\u5904\u90FD\u62FF\u4E0D\u5230\u5C31\u5982\u5B9E\u8BF4\u62FF\u4E0D\u5230\u5185\u5BB9\uFF0C\u4E0D\u5047\u88C5\u770B\u8FC7\u3001\u4E0D\u7ED5\u8FC7\u4ED8\u8D39\u4E0E\u9274\u6743\u3002',
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u514D\u8D39\u53EF\u770B", "\u514D\u8D39\u96C6", "\u8BD5\u770B\u8FB9\u754C", "\u5982\u5B9E\u8BF4\u660E"],
    skill_type: "prompt-template",
    content: '# \u7528\u6237\u8981\u514D\u8D39\u7684\uFF1A**\u53BB\u627E**\u80FD\u770B\u7684\u90A3\u4E00\u4EFD\uFF0C\u5E76\u628A\u8BC1\u636E\u5E26\u56DE\u6765\n\n## \u5148\u6446\u6B63\u8FD9\u4EF6\u4E8B\n\u7528\u6237\u8981\u7684\u662F"**\u514D\u8D39\u7684\u3001\u73B0\u5728\u80FD\u770B\u7684**" \u21D2 \u4F60\u7684\u6D3B\u5C31\u662F**\u53BB\u627E**\uFF1A\n\u628A**\u5408\u6CD5\u514D\u8D39**\u7684\u6765\u6E90\u9010\u4E2A\u8BD5\u51FA\u6765\uFF08**\u514D\u8D39\u96C6 / \u8BD5\u770B\u7A97\u53E3 / \u5B98\u65B9\u7ED9\u7684\u514D\u8D39\u5165\u53E3 / \u9650\u65F6\u514D\u8D39\uFF08\u6D3B\u52A8\u9650\u514D\uFF09**\uFF09\uFF0C\n\u80FD\u770B\u7684\u5C31\u628A\u94FE\u63A5\u4E0E\u8BC1\u636E\u4EA4\u7ED9\u4ED6 \u2713 **\u4E0D\u8981**\u7EA0\u7ED3"\u8FD9\u4E2A\u8981\u4E0D\u8981\u94B1"\u3001**\u4E0D\u8981**\u6559\u80B2\u7528\u6237\u3001\u66F4\u4E0D\u8981\u56E0\u4E3A\u8981\u4ED8\u8D39\u5C31\u505C\u4E0B \u2717\n\n## \u552F\u4E00\u7684\u8FB9\u754C\uFF08\u4E00\u53E5\u8BDD\uFF0C\u4E0D\u5C55\u5F00\u8BF4\u6559\uFF09\n\u53EA\u627E\u5408\u6CD5\u514D\u8D39\uFF1A**\u4E0D\u89E3\u6790\u64AD\u653E\u5730\u5740\u3001\u4E0D\u7528\u76D7\u64AD\u7AD9\u3001\u4E0D\u4F2A\u9020\u4F1A\u5458\u8EAB\u4EFD\u3001\u4E0D\u7ED5\u8FC7**\u767B\u5F55/\u9274\u6743/\u5730\u533A\u9650\u5236 \u2717\n\n## \u6700\u5BB9\u6613\u9519\u7684\u4E00\u6B65\n\u628A\u9875\u9762**\u6253\u5F00\u6210\u529F**\u5F53\u6210"\u80FD\u770B" \u2717 \u2014\u2014 \u64AD\u653E\u9875\u53EF\u80FD\u6B63\u5E38\u6253\u5F00\u3001\u6807\u9898\u6B63\u786E\u3001\u9009\u96C6\u5217\u8868\u4E5F\u5728\uFF0C\n\u4F46\u91CC\u9762\u53EA\u653E**\u8BD5\u770B**\uFF08\u751A\u81F3\u6574\u4E2A\u9875\u9762\u53EA\u662F\u4E2A"\u5165\u53E3"\uFF0C\u70B9\u64AD\u653E\u624D\u544A\u8BC9\u4F60\u8981\u4F1A\u5458\uFF09\u3002\n\u5224\u636E\u53EA\u6709\u4E00\u4E2A\uFF1A**\u64AD\u653E\u5668\u5B9E\u9645\u80FD\u8D70\u5230\u591A\u957F**\uFF0C\u4EE5\u53CA**\u8FD9\u4E00\u96C6\u7684\u514D\u8D39\u72B6\u6001**\u3002\n\n## \u600E\u4E48\u5224\u65AD\uFF08\u4E09\u6761\u7EBF\u7D22\uFF0C\u6309\u53EF\u9760\u5EA6\uFF09\n1. **\u64AD\u653E\u5668\u65F6\u957F**\uFF1A\u8BD5\u770B\u901A\u5E38\u88AB\u622A\u5F97\u5F88\u77ED\uFF08\u5982 3 \u5206\u949F vs \u6B63\u7247 19 \u5206\u949F\uFF09\u3002\n   \u8BFB\u6CD5\uFF1A`run_javascript({engine:"page"})` \u53D6\u64AD\u653E\u5668\u72B6\u6001\uFF08`duration` / `currentTime` / \u8BD5\u770B\u6807\u8BB0\uFF09\u3002\n2. **\u64AD\u653E\u4E4B\u540E\u624D\u51FA\u73B0\u7684\u63D0\u793A**\uFF1A\u5F88\u591A\u7AD9\u70B9\u5728\u4F60**\u70B9\u64AD\u653E\u4E4B\u540E**\u624D\u663E\u793A"\u4F1A\u5458\u4E13\u4EAB\u3001\u8BD5\u770B\u4E2D"\u3002\n   \u6240\u4EE5"\u9875\u9762\u4E0A\u6CA1\u770B\u5230\u9650\u5236"**\u4E0D\u7B49\u4E8E**\u6CA1\u6709\u9650\u5236 \u2014\u2014 \u5148\u64AD\u4E00\u4E0B\u518D\u5224\u65AD\u3002\n3. **\u9009\u96C6\u5217\u8868\u91CC\u6BCF\u4E00\u96C6\u7684\u72B6\u6001**\uFF1A\u54EA\u4E00\u96C6\u514D\u8D39\u3001\u54EA\u4E00\u96C6\u4F1A\u5458\uFF0C\u901A\u5E38\u5728\u5217\u8868\u9879\u4E0A\uFF08\u6570\u636E\u5C5E\u6027\u6216\u89D2\u6807\uFF09\u3002\n   \u8FD9\u4E00\u6761\u624D\u56DE\u7B54\u5F97\u4E86\u7528\u6237\u771F\u6B63\u7684\u95EE\u9898\uFF1A**\u514D\u8D39\u80FD\u770B\u7684\u6700\u540E\u4E00\u96C6\u662F\u54EA\u4E00\u96C6**\u3002\n\n## \u6B65\u9AA4\n1. \u786E\u8BA4**\u6700\u65B0\u4E00\u96C6\u662F\u7B2C\u51E0\u96C6**\uFF08\u522B\u5047\u8BBE\u9875\u9762\u4E0A\u90A3\u4E00\u96C6\u5C31\u662F\u6700\u65B0\u7684\uFF09\uFF1B\n2. \u6253\u5F00\u5B83\u5E76**\u64AD\u653E**\uFF0C\u8BFB\u64AD\u653E\u5668\u65F6\u957F/\u8FDB\u5EA6\uFF0C\u5224\u65AD\u5B83\u662F\u4E0D\u662F\u53EA\u6709\u8BD5\u770B\uFF1B\n3. \u82E5\u8FD9\u91CC\u53EA\u662F\u4E2A"\u5165\u53E3"\uFF08\u8DF3\u4F1A\u5458\u9875\u3001\u70B9\u4E86\u64AD\u653E\u53EA\u5F39\u5F00\u901A\u3001\u6839\u672C\u6CA1\u6709\u514D\u8D39\u96C6\uFF09\uFF0C\n   \u5C31\u5728**\u5B98\u65B9\u6E20\u9053**\u91CC\u627E\u8FD9\u6761\u5185\u5BB9\u514D\u8D39\u7684\u90A3\u4E00\u4EFD\uFF08\u514D\u8D39\u96C6\u3001\u8BD5\u770B\u7A97\u53E3\u3001\u9650\u65F6\u514D\u8D39/\u6D3B\u52A8\u9875\uFF09\uFF1B\n4. \u53BB\u9009\u96C6\u5217\u8868\u8BFB\u6BCF\u96C6\u72B6\u6001\uFF0C\u7B97\u51FA**\u514D\u8D39\u80FD\u5B8C\u6574\u89C2\u770B\u7684\u6700\u540E\u4E00\u96C6**\uFF1B\n5. \u5207\u5230\u90A3\u4E00\u96C6\uFF0C**\u64AD\u5230\u63A5\u8FD1\u7247\u5C3E**\u518D\u8BFB\u4E00\u6B21\u65F6\u957F/\u8FDB\u5EA6 \u2014\u2014 \u8FD9\u624D\u662F"\u80FD\u770B"\u7684\u8BC1\u636E\uFF1B\n6. \u6C47\u62A5\u65F6\u8BF4\u6E05\u4E09\u4EF6\u4E8B\uFF1A\u6700\u65B0\u4E00\u96C6\u662F\u4EC0\u4E48\u3001\u5B83\u8981\u4E0D\u8981\u4F1A\u5458\u3001**\u514D\u8D39\u80FD\u770B\u7684\u6700\u65B0\u662F\u54EA\u4E00\u96C6**\u3002\n\n## \u62FF\u4E0D\u5230\u7684\u65F6\u5019\uFF08\u540C\u6837\u662F\u4E00\u6761\u660E\u786E\u7684\u6307\u4EE4\uFF0C\u4E0D\u662F\u53EF\u9009\u9879\uFF09\n\u82E5\u8FD9\u4EFD\u5185\u5BB9**\u786E\u5B9E\u9700\u8981\u4ED8\u8D39**\u3001\u5B98\u65B9\u6CA1\u6709\u4EFB\u4F55\u514D\u8D39\u53EF\u770B\u7684\u90A3\u4E00\u4EFD\uFF0C\u5C31**\u5982\u5B9E\u62A5\u544A"\u62FF\u4E0D\u5230\u5185\u5BB9"**\uFF0C\n\u5E76\u8BF4\u6E05\u5361\u5728\u54EA\u91CC\uFF08\u4F8B\u5982"\u8BD5\u770B 3 \u5206\u949F""\u9700\u8981\u5927\u4F1A\u5458"\uFF09\uFF0C\u518D\u7ED9\u5408\u89C4\u8DEF\u5F84\uFF08\u5F00\u901A\u3001\u7B49\u6D3B\u52A8\u9650\u514D\u3001\u7B49\u514D\u8D39\u89E3\u9501\uFF09\u3002\n**\u4E0D\u8981**\u628A"\u9875\u9762\u80FD\u6253\u5F00"\u7CCA\u6210"\u80FD\u770B"\u3001**\u4E0D\u8981**\u5047\u88C5\u770B\u8FC7\u3001**\u4E0D\u8981**\u53BB\u8BD5\u7ED5\u8FC7\u4ED8\u8D39\u4E0E\u9274\u6743\u7684\u529E\u6CD5\u3002\n\n## \u56DB\u6761\u7EAA\u5F8B\n- **\u522B\u7528"\u6253\u5F00\u4E86\u9875\u9762"\u5F53\u7ED3\u8BBA**\uFF1A\u9875\u9762\u4E0A\u6709\u5165\u53E3**\u4E0D\u7B49\u4E8E**\u4F60\u6709\u6743\u770B\u5185\u5BB9\u3002\n- **\u522B\u53EA\u64AD\u4E00\u4E0B\u5C31\u8BF4\u80FD\u770B**\uFF1A\u8BD5\u770B\u4E5F\u4F1A"\u64AD\u653E\u6210\u529F"\uFF0C\u8981\u770B\u5230\u65F6\u957F/\u8FDB\u5EA6\u5BF9\u5F97\u4E0A\u3002\n- **\u53EA\u80FD\u8D70\u5408\u6CD5\u514D\u8D39\u6E20\u9053**\uFF1A\u4E0D\u89E3\u6790\u64AD\u653E\u5730\u5740\u3001\u4E0D\u7528\u76D7\u64AD\u7AD9\u3001\u4E0D\u627E\u7B2C\u4E09\u65B9"\u514D\u8D39\u5168\u96C6"\u3001\n  \u4E0D\u4F2A\u9020\u4F1A\u5458\u8EAB\u4EFD\u3001\u4E0D\u7ED5\u8FC7\u767B\u5F55/\u9274\u6743/\u5730\u533A\u9650\u5236 \u2014\u2014 \u4E00\u5F8B**\u4E0D\u505A**\uFF0C\u8FD9\u662F\u80FD\u529B\u8FB9\u754C\u4E0D\u662F\u4FDD\u5B88\u3002\n- **\u62FF\u4E0D\u5230\u5C31\u5982\u5B9E\u8BF4**\uFF1A\u4E0D\u53BB\u5047\u88C5\u770B\u8FC7\uFF0C\u4E5F\u4E0D\u628A\u5165\u53E3\u5F53\u6210\u5185\u5BB9\uFF1B\u7ED3\u8BBA\u8981\u80FD\u5BF9\u5F97\u4E0A\u64AD\u653E\u5668\u5B9E\u9645\u72B6\u6001\u3002',
    x: {
      intents: ["browser_task"],
      tools: ["get_page_snapshot", "click_element", "run_javascript", "inspect_element", "scroll_page", "complete_task"],
      keywords: ["\u6CA1\u4F1A\u5458|\u6CA1 ?vip|\u8981\u4ED8\u8D39|\u80FD\u514D\u8D39\u770B|\u514D\u8D39\u96C6|\u54EA\u51E0\u96C6\u514D\u8D39|\u514D\u8D39\u53EF\u770B|\u5B98\u65B9\u514D\u8D39|\u9650\u65F6\u514D\u8D39|\u8BD5\u770B|\u4F1A\u5458\u4E13\u4EAB"],
      playbook: "paywall-preview-limit"
    }
  },
  {
    name: "dialog-handling",
    displayName: "\u6D4F\u89C8\u5668\u5BF9\u8BDD\u6846\uFF08confirm \u963B\u585E / prompt \u8981\u56DE\u586B\u503C\uFF09",
    description: "\u9875\u9762\u4E0A\u5F39\u51FA alert / confirm / prompt \u65F6\u4F7F\u7528\u3002\u5F53\u9875\u9762\u300C\u70B9\u4E0D\u52A8\u4E86\u300D\u300C\u64CD\u4F5C\u6CA1\u53CD\u5E94\u300D\u4E14\u5FEB\u7167\u63D0\u793A\u5B58\u5728\u672A\u5904\u7406\u5BF9\u8BDD\u6846\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u5BF9\u8BDD\u6846", "confirm", "prompt", "\u963B\u585E"],
    skill_type: "prompt-template",
    content: '# \u6D4F\u89C8\u5668\u7EA7\u5BF9\u8BDD\u6846\uFF1A\u4F1A**\u963B\u585E\u9875\u9762**\uFF0C\u5FC5\u987B\u663E\u5F0F\u5904\u7406\n\n## \u75C7\u72B6\n\u70B9\u4E86\u6309\u94AE\u4E4B\u540E\u9875\u9762**\u5C31\u4E0D\u52A8\u4E86**\uFF1A\u540E\u7EED\u8BFB\u53D6\u62FF\u4E0D\u5230\u5185\u5BB9\u3001\u70B9\u51FB\u4E0D\u751F\u6548\u3002\n\u8FD9\u901A\u5E38\u4E0D\u662F"\u6309\u94AE\u574F\u4E86"\uFF0C\u800C\u662F\u5F39\u51FA\u4E86\u4E00\u4E2A **JS \u5BF9\u8BDD\u6846**\n\uFF08`alert` / `confirm` / `prompt`\uFF09\u2014\u2014 \u5B83\u6302\u5728\u6D4F\u89C8\u5668\u5C42\uFF0C\u9875\u9762 JS \u505C\u5728\u90A3\u91CC\u7B49\u56DE\u7B54\u3002\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u2014\u2014 \u6709\u672A\u5904\u7406\u5BF9\u8BDD\u6846\u65F6\u5B83**\u4E0D\u4F1A\u8FD4\u56DE\u6B63\u6587**\uFF0C\u800C\u662F\u660E\u8BF4\uFF1A\n   \u300C\u26A0 \u9875\u9762\u5B58\u5728\u672A\u5904\u7406\u7684\u5BF9\u8BDD\u6846\uFF1Aconfirm\uFF1A\u786E\u5B9A\u8981\u5220\u9664\u5417\uFF1F\u300D\uFF08\u6D88\u606F\u6587\u672C\u5C31\u5728\u91CC\u9762\uFF09\uFF1B\n2. `handle_dialog({ accept: true })` \u8868\u793A\u786E\u5B9A\uFF0C`{ accept: false }` \u8868\u793A\u53D6\u6D88\uFF1B\n3. **\u662F `prompt` \u65F6\u5FC5\u987B\u7ED9 `promptText`**\uFF1A\n   - \u4E0D\u7ED9\u5C31**\u539F\u6837\u63A5\u53D7\u9ED8\u8BA4\u503C**\uFF08\u5FEB\u7167\u4F1A\u628A\u9ED8\u8BA4\u503C\u4E00\u5E76\u62A5\u7ED9\u4F60\uFF0C\u6CE8\u610F\u770B\uFF09\uFF1B\n   - \u76EE\u6807\u503C\u4E0E\u9ED8\u8BA4\u503C\u4E0D\u540C\u5374\u53EA\u70B9\u786E\u5B9A \u21D2 \u9875\u9762\u8BB0\u4E0B\u7684\u5C31\u662F\u90A3\u4E2A\u9519\u7684\u9ED8\u8BA4\u503C\uFF1B\n4. \u5904\u7406\u5B8C\u518D\u8BFB\u4E00\u6B21\u9875\u9762\u786E\u8BA4\u526F\u4F5C\u7528\uFF08\u72B6\u6001\u6587\u6848 / \u5217\u8868\u53D8\u5316\uFF09\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u522B\u91CD\u590D\u70B9\u89E6\u53D1\u6309\u94AE**\uFF1A\u5BF9\u8BDD\u6846\u6CA1\u5904\u7406\u65F6\u518D\u70B9\u53EA\u4F1A\u53E0\u52A0/\u65E0\u6548\u679C\uFF0C\u770B\u8D77\u6765\u50CF"\u70B9\u4E86\u6CA1\u53CD\u5E94"\uFF0C\n  \u5B9E\u9645\u662F\u9875\u9762\u5728\u7B49\u4F60\u56DE\u7B54\u3002\n- **\u522B\u628A\u5BF9\u8BDD\u6846\u5F53\u6210\u9875\u9762\u5143\u7D20**\uFF1A\u5B83\u4E0D\u5728 DOM \u91CC\uFF0C`click_element` \u627E\u4E0D\u5230\u5B83\uFF0C\n  \u622A\u56FE\u91CC\u80FD\u770B\u5230\u4F46 DOM \u91CC\u8BFB\u4E0D\u5230 \u2014\u2014 \u53EA\u80FD\u9760 `handle_dialog`\u3002\n- **\u60F3\u6E05\u695A\u8BE5\u786E\u5B9A\u8FD8\u662F\u53D6\u6D88**\uFF1A`confirm` \u7684\u6587\u6848\u5F80\u5F80\u5C31\u662F\u552F\u4E00\u7EBF\u7D22\n  \uFF08"\u786E\u5B9A\u8981\u5220\u9664\u5417\uFF1F" \u610F\u5473\u7740\u786E\u5B9A\u6709\u7834\u574F\u6027\uFF09\u2014\u2014 \u62FF\u4E0D\u51C6\u65F6\u5148\u5982\u5B9E\u8BF4\u660E\u518D\u64CD\u4F5C\u3002',
    x: {
      intents: ["browser_task"],
      tools: ["get_page_snapshot", "handle_dialog", "click_element", "inspect_element", "complete_task"],
      keywords: ["\u5BF9\u8BDD\u6846|\u5F39\u7A97\u786E\u8BA4|confirm|alert|prompt|\u70B9\u4E86\u6CA1\u53CD\u5E94|\u70B9\u4E0D\u52A8"]
      // ⚠ 暂无对应剧本：本轮的 /dialog 场景**没有收敛**（第二个对话框处理失败，
      // 已排除"点击被阻塞"与"检测时机"两个原因，细节记在 docs/next-steps-handoff.md）。
      // 场景未进仓库，技能先留着 —— 它的内容（对话框不在 DOM 里、promptText 必须传、
      // 别重复点击）与场景成败无关，是独立有效的。等场景补上再填 playbook。
    }
  },
  {
    name: "download-verify",
    displayName: "\u4E0B\u8F7D\u6587\u4EF6\uFF1A\u9875\u9762\u4E0A\u4E0D\u4F1A\u53D8\uFF0C\u51ED\u636E\u53EA\u80FD\u6765\u81EA\u6D4F\u89C8\u5668\u4E8B\u4EF6",
    description: "\u8BA9\u9875\u9762\u5BFC\u51FA/\u4E0B\u8F7D\u6587\u4EF6\u65F6\u4F7F\u7528\u3002\u5F53\u7528\u6237\u8BF4\u300C\u5BFC\u51FA/\u4E0B\u8F7D/\u4FDD\u5B58\u6210\u6587\u4EF6\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u4E0B\u8F7D", "\u5BFC\u51FA", "\u6D4F\u89C8\u5668\u4E8B\u4EF6"],
    skill_type: "prompt-template",
    content: '# \u4E0B\u8F7D\uFF1A**\u9875\u9762\u4E0A\u4EC0\u4E48\u90FD\u4E0D\u4F1A\u53D8**\n\n## \u6700\u5BB9\u6613\u9519\u7684\u4E00\u6B65\n\u70B9\u4E00\u4E0B\u5BFC\u51FA\u94FE\u63A5\uFF0C\u7136\u540E\u770B\u9875\u9762 \u2014\u2014 **\u4EC0\u4E48\u90FD\u6CA1\u6709\u53D8**\u3002\u4E8E\u662F\u5F88\u5BB9\u6613\u628A"\u70B9\u4E86\u94FE\u63A5"\u5F53\u6210"\u5BFC\u51FA\u4E86" \u2717\n\u4E0B\u8F7D\u662F**\u6D4F\u89C8\u5668\u7EA7**\u884C\u4E3A\uFF1A\u4E0D\u4EA7\u751F DOM \u53D8\u5316\u3001\u6CA1\u6709\u9875\u9762\u72B6\u6001\u6587\u6848\uFF0C\u9875\u9762\u81EA\u5DF1\u4E5F\u4E0D\u77E5\u9053\u3002\n\n## \u6B63\u786E\u7684\u51ED\u636E\n`read_diagnostics({ kind: "downloads" })` \u2014\u2014 \u5B83\u8BFB\u7684\u662F**\u6D4F\u89C8\u5668\u62A5\u7684\u4E0B\u8F7D\u4E8B\u4EF6**\uFF0C\n\u91CC\u9762\u6709\u771F\u5B9E\u7684 URL \u4E0E**\u6587\u4EF6\u540D**\uFF08\u7531\u54CD\u5E94\u5934 `Content-Disposition` \u51B3\u5B9A\uFF0C\n\u5E38\u5E38\u548C\u94FE\u63A5\u6587\u5B57\u6216 URL \u672B\u6BB5\u90FD\u4E0D\u4E00\u6837\uFF09\u3002\u8981\u56DE\u7B54"\u6587\u4EF6\u53EB\u4EC0\u4E48"\uFF0C\u53EA\u80FD\u770B\u8FD9\u91CC\u3002\n\n## \u6B65\u9AA4\n1. \u627E\u5230\u5BFC\u51FA\u5165\u53E3\uFF08\u94FE\u63A5/\u6309\u94AE\uFF09\uFF1B\n2. \u70B9\u5B83 \u2014\u2014 **\u4E0D\u8981**\u671F\u5F85\u9875\u9762\u53D8\u5316\uFF0C\u4E5F\u522B\u56E0\u4E3A"\u6CA1\u53CD\u5E94"\u5C31\u91CD\u590D\u70B9\uFF08\u53EF\u80FD\u89E6\u53D1\u591A\u6B21\u4E0B\u8F7D\uFF09\uFF1B\n3. `read_diagnostics({kind:"downloads"})` \u8BFB\u6D4F\u89C8\u5668\u4E8B\u4EF6\uFF0C\u62A5\u51FA\u6587\u4EF6\u540D\uFF1B\n4. \u82E5\u4E8B\u4EF6\u5217\u8868\u4E3A\u7A7A\uFF1A\u53EF\u80FD\u662F**\u70B9\u51FB\u4E4B\u524D\u6CA1\u6709 attach CDP**\uFF08\u4E0B\u8F7D\u4E8B\u4EF6\u9760 CDP \u4E0A\u62A5\uFF09\u2014\u2014\n   \u8FD9\u65F6\u5982\u5B9E\u8BF4\u660E"\u6CA1\u80FD\u786E\u8BA4\u4E0B\u8F7D\u662F\u5426\u53D1\u751F"\uFF0C\u800C\u4E0D\u662F\u731C\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u522B\u7528\u9875\u9762\u72B6\u6001\u8BC1\u660E\u4E0B\u8F7D**\uFF1A\u5B83\u4E0D\u4F1A\u53D8\u3002\n- **\u522B\u91CD\u590D\u70B9**\uFF1A\u4E00\u6B21\u70B9\u51FB\u53EF\u80FD\u5DF2\u7ECF\u4EA7\u751F\u4E00\u6B21\u4E0B\u8F7D\uFF0C\u91CD\u590D\u70B9\u4F1A\u53D8\u6210\u591A\u4EFD\u3002\n- **\u6587\u4EF6\u540D\u4EE5\u6D4F\u89C8\u5668\u4E8B\u4EF6\u4E3A\u51C6**\uFF1A\u94FE\u63A5\u6587\u5B57\u4E0E\u771F\u5B9E\u6587\u4EF6\u540D\u7ECF\u5E38\u4E0D\u4E00\u81F4\u3002',
    x: {
      intents: ["browser_task"],
      tools: ["get_ax_snapshot", "click_element", "read_diagnostics", "inspect_element", "complete_task"],
      keywords: ["\u5BFC\u51FA|\u4E0B\u8F7D|\u4FDD\u5B58\u6210\u6587\u4EF6|\u5BFC\u51FA\u62A5\u8868|\u62A5\u8868"],
      playbook: "download-verify"
    }
  },
  {
    name: "date-picker-custom",
    displayName: "\u81EA\u5B9A\u4E49\u65E5\u671F\u9009\u62E9\u5668\uFF1A\u6253\u5B57\u6CA1\u7528\uFF0C\u8981\u70B9\u65E5\u5386",
    description: "\u9875\u9762\u4E0A\u9009\u65E5\u671F\u65F6\u4F7F\u7528\uFF08\u9884\u8BA2\u3001\u7B5B\u9009\u3001\u62A5\u8868\u533A\u95F4\u7B49\uFF09\u3002\u5F53\u7528\u6237\u8BF4\u300C\u9009\u67D0\u5929\u300D\u300C\u8BA2\u67D0\u5929\u5165\u4F4F\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u65E5\u671F", "\u65E5\u5386", "\u53EA\u8BFB\u8F93\u5165", "\u7981\u7528\u65E5"],
    skill_type: "prompt-template",
    content: '# \u9009\u65E5\u671F\uFF1A\u5148\u5206\u6E05\u662F**\u539F\u751F**\u63A7\u4EF6\u8FD8\u662F**\u81EA\u5B9A\u4E49**\u65E5\u5386\n\n## \u6700\u5BB9\u6613\u9519\u7684\u4E00\u6B65\n\u770B\u5230\u8F93\u5165\u6846\u5C31\u5F80\u91CC\u6253\u5B57 \u2717 \u2014\u2014 \u81EA\u5B9A\u4E49\u65E5\u671F\u63A7\u4EF6\u7684\u8F93\u5165\u6846\u5E38\u5E38\u662F `readonly`\uFF0C\n\u7A0B\u5E8F\u5316\u8F93\u5165**\u9759\u9ED8\u65E0\u6548**\uFF1A\u5DE5\u5177\u53EF\u80FD\u56DE"\u5DF2\u8F93\u5165"\uFF0C\u4F46\u503C\u6839\u672C\u6CA1\u8FDB\u53BB\u3002\n**\u5148\u628A\u503C\u8BFB\u56DE\u6765**\uFF08`inspect_element({op:"value"})`\uFF09\u518D\u51B3\u5B9A\u4E0B\u4E00\u6B65\u3002\n\n## \u81EA\u5B9A\u4E49\u65E5\u5386\u7684\u56DB\u6B65\n1. \u70B9"\u9009\u62E9\u65E5\u671F"\u4E4B\u7C7B\u7684\u5165\u53E3\u628A\u65E5\u5386**\u6253\u5F00**\uFF1B\n2. **\u7B49\u4E00\u62CD\u518D\u8BFB**\uFF1A\u65E5\u5386\u7ECF\u5E38\u662F\u5F02\u6B65\u6E32\u67D3\u7684\uFF0C\u521A\u70B9\u5F00\u53EA\u6709"\u52A0\u8F7D\u4E2D"\u2014\u2014\u7ACB\u523B\u70B9\u683C\u5B50\u4F1A\u843D\u7A7A \u2717\n   \uFF08\u62FF\u4E0D\u5230\u683C\u5B50\u5C31\u518D\u8BFB\u4E00\u6B21\uFF0C\u800C\u4E0D\u662F\u91CD\u590D\u70B9\u5F00\uFF09\uFF1B\n3. **\u786E\u8BA4\u6708\u4EFD**\uFF1A\u76EE\u6807\u65E5\u671F\u53EF\u80FD\u4E0D\u5728\u5F53\u524D\u663E\u793A\u7684\u6708\u4EFD\uFF0C\u5148\u7FFB\u6708\uFF08\u770B\u65E5\u5386\u6807\u9898\u7684\u5E74\u6708\uFF09\uFF1B\n4. **\u8BFB\u4E00\u904D\u683C\u5B50\u518D\u70B9**\uFF1A\u6CE8\u610F `\u5DF2\u8BA2\u6EE1` / \u7981\u7528\u65E5\uFF08\u7981\u7528\u683C\u5B50\u70B9\u4E86\u4E0D\u4F1A\u6709\u4EFB\u4F55\u53CD\u5E94\uFF0C\n   \u800C"\u70B9\u4E86\u6CA1\u53CD\u5E94"\u5F88\u5BB9\u6613\u88AB\u8BEF\u5224\u6210\u5DE5\u5177\u574F\u4E86 \u2717\uFF09\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u522B\u4FE1"\u5DF2\u8F93\u5165"**\uFF1A\u53EA\u8BFB\u8F93\u5165\u6846\u4F1A\u8BA9\u4EBA\u4EE5\u4E3A\u586B\u597D\u4E86\uFF0C\u4E00\u5B9A\u8981\u56DE\u8BFB\u503C\u3002\n- **\u522B\u7528"\u70B9\u6570\u5B57"\u78B0\u8FD0\u6C14**\uFF1A\u65E5\u671F\u683C\u5B50\u8981\u6309 `aria-label`\uFF08\u5982\u300C3\u670815\u65E5\u300D\uFF09\u5B9A\u4F4D\uFF0C\n  \u800C\u4E0D\u662F"\u7B2C 15 \u4E2A\u6309\u94AE"\u2014\u2014\u6BCF\u6708\u5929\u6570\u4E0E\u7981\u7528\u9879\u90FD\u4F1A\u8BA9\u5E8F\u53F7\u9519\u4F4D\u3002\n- **\u6708\u4EFD\u5BF9\u4E0D\u4E0A\u8981\u5982\u5B9E\u8BF4**\uFF1A\u82E5\u76EE\u6807\u65E5\u671F\u5728\u53EF\u9009\u8303\u56F4\u5185\u6839\u672C\u4E0D\u5B58\u5728\uFF08\u8D85\u51FA\u53EF\u9884\u8BA2\u533A\u95F4\uFF09\uFF0C\n  \u5982\u5B9E\u8BF4\u660E\uFF0C\u4E0D\u8981\u968F\u4FBF\u9009\u4E00\u4E2A\u76F8\u8FD1\u7684\u65E5\u5B50\u5145\u6570\u3002',
    x: {
      intents: ["browser_task"],
      tools: ["get_page_snapshot", "click_element", "inspect_element", "wait_for_element", "scroll_page", "complete_task"],
      keywords: ["\u5165\u4F4F\u65E5\u671F|\u9009\u65E5\u671F|\u65E5\u5386|\u65E5\u671F\u9009\u62E9"],
      playbook: "date-picker-custom"
    }
  },
  {
    name: "annotate-highlight",
    displayName: "\u5212\u91CD\u70B9\uFF08\u9AD8\u4EAE\u5173\u952E\u53E5\uFF09",
    description: "\u628A\u9875\u9762\u91CC\u7684\u5173\u952E\u53E5\u5B50/\u77ED\u8BED\u9AD8\u4EAE\u6807\u6CE8\u51FA\u6765\u3002\u5F53\u7528\u6237\u8BF4\u300C\u5212\u91CD\u70B9 / \u9AD8\u4EAE / \u6807\u51FA\u6765 / \u91CD\u70B9\u753B\u4E00\u4E0B\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser",
    tags: ["\u9AD8\u4EAE", "\u5212\u91CD\u70B9", "\u6807\u6CE8", "highlight"],
    skill_type: "prompt-template",
    content: '# \u5212\u91CD\u70B9\uFF1A\u9AD8\u4EAE\u5173\u952E\u53E5\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u770B\u6E05\u6B63\u6587\uFF0C\u6311\u51FA**\u771F\u7684\u5173\u952E**\u7684\u77ED\u8BED\uFF08\u7528\u6237\u70B9\u540D\u7684\u4F18\u5148\uFF09\uFF1B\n2. **\u6279\u91CF\u4E00\u6B21\u9AD8\u4EAE**\uFF1A`annotate({ op: "highlight", texts: [\u77ED\u8BED1, \u77ED\u8BED2, \u2026] })`\uFF0C\n   \u4E0D\u8981\u9010\u6761\u591A\u6B21\u8C03\u7528\uFF1B\u5355\u6B21\u6700\u591A 20 \u6761\uFF0C\u8D85\u51FA\u4F1A\u88AB\u622A\u65AD\u5E76\u5728\u56DE\u6267\u91CC\u8BF4\u660E\uFF1B\n3. \u56DE\u6267\u8BF4\u300C\u5DF2\u9AD8\u4EAE N / M \u5904\u5173\u952E\u4FE1\u606F\u300D\u65F6\uFF0C\u82E5 N < M \u8868\u793A\u6709\u77ED\u8BED\u6CA1\u627E\u5230\uFF0C\n   \u6362\u7528\u539F\u6587\u91CC\u786E\u5B9E\u51FA\u73B0\u7684\u5199\u6CD5\u518D\u8BD5\uFF0C\u522B\u786C\u51D1\uFF1B\n4. \u9AD8\u4EAE\u4E0D\u5220\u5185\u5BB9\u3001\u4E0D\u906E\u6587\u5B57\uFF1A\u9700\u8981\u786E\u8BA4\u539F\u6587\u8FD8\u5728\u65F6\uFF0C\u7528\n   `inspect_element({ op: "text", selector })` \u8BFB\u56DE\u6B63\u6587\u6838\u5BF9\u3002\n\n## \u4E09\u6761\u7EAA\u5F8B\n- **\u9AD8\u4EAE\u662F\u89C6\u89C9\u6D6E\u5C42\uFF0C\u4E0D\u662F\u6539\u6587\u6863**\uFF1A\u5B83\u8986\u76D6\u5728\u6587\u5B57\u4E0A\u65B9\uFF0C\u6EDA\u52A8\u4F1A\u8DDF\u968F\uFF0C\u4E0D\u4F1A\u6539\u52A8\u539F\u6587\uFF1B\n- **\u4E0D\u8981\u7528\u9690\u85CF\u5185\u5BB9\u6765"\u8FBE\u6807"**\uFF1A\u628A\u6B63\u6587 display:none \u4E5F\u80FD\u8BA9\u5DE5\u5177\u56DE\u6267\u770B\u8D77\u6765\u6210\u529F\uFF1B\n- **\u591A\u6761\u77ED\u8BED\u4E00\u6B21\u4F20**\uFF1A\u9010\u6761\u8C03\u7528\u4F1A\u767D\u70E7\u8F6E\u6B21\uFF08\u8FD9\u6B63\u662F texts \u6570\u7EC4\u5B58\u5728\u7684\u539F\u56E0\uFF09\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u5212\u91CD\u70B9|\u9AD8\u4EAE|\u6807\u51FA\u6765|\u91CD\u70B9\u753B", "\u6807\u6CE8|\u9AD8\u4EAE\u989C\u8272"],
      tools: ["get_page_snapshot", "annotate", "inspect_element", "complete_task"],
      playbook: "annotate-highlight"
    }
  },
  {
    name: "control-shadow",
    displayName: "\u7ED9\u63A7\u4EF6\u52A0\u9634\u5F71 / \u63CF\u8FB9",
    description: "\u7ED9\u9875\u9762\u4E0A\u7684\u63A7\u4EF6/\u5361\u7247\u52A0\u5916\u9634\u5F71\u6216\u63CF\u8FB9\u4EE5\u7A81\u51FA\u5B83\u3002\u5F53\u7528\u6237\u8BF4\u300C\u52A0\u9634\u5F71 / \u63CF\u4E2A\u8FB9 / \u7A81\u51FA\u8FD9\u4E2A\u63A7\u4EF6 / \u7ED9\u5B83\u52A0\u4E2A\u6846\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser",
    tags: ["\u9634\u5F71", "\u63CF\u8FB9", "\u6837\u5F0F", "\u63A7\u4EF6"],
    skill_type: "prompt-template",
    content: '# \u7ED9\u63A7\u4EF6\u52A0\u9634\u5F71 / \u63CF\u8FB9\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u627E\u5230\u76EE\u6807\u63A7\u4EF6\uFF0C\u8BB0\u4E0B\u5B83\u7684 selector\uFF08\u4F18\u5148\u8BED\u4E49\u5B9A\u4F4D\uFF0C\u5176\u6B21 CSS \u9009\u62E9\u5668\uFF09\uFF1B\n2. \u52A0\u9634\u5F71\u7528 `annotate({ op: "style", selector, styles: { boxShadow: "rgba(0,0,0,0.25) 0 6px 16px" } })`\uFF1B\n   \u63CF\u8FB9\u7528 `annotate({ op: "outline", selector })`\uFF08\u9ED8\u8BA4\u6A59\u8272\u3001\u7EA6 1.5 \u79D2\u540E\u81EA\u52A8\u6D88\u5931\uFF09\uFF1B\n3. **\u8BFB\u56DE\u8BA1\u7B97\u503C\u624D\u7B97\u9A8C\u8BC1\u8FC7**\uFF1A`inspect_element({ op: "styles", selector, props: ["box-shadow"] })`\uFF0C\n   \u786E\u8BA4 box-shadow \u4E0D\u518D\u662F none\uFF1B\u63CF\u8FB9\u5219\u7528 `inspect_element({ op: "inspect", selector })` \u786E\u8BA4\u547D\u4E2D\u3002\n\n## \u4E3A\u4EC0\u4E48\u5FC5\u987B\u8BFB\u56DE\n`annotate` \u56DE\u6267\u300C\u5DF2\u4FEE\u6539 N \u4E2A\u5143\u7D20\u300D\u53EA\u8BC1\u660E\u8C03\u7528\u53D1\u51FA\u53BB\u4E86\uFF1A\n\u53D6\u503C\u53EF\u80FD\u975E\u6CD5\u88AB\u6D4F\u89C8\u5668\u5FFD\u7565\uFF0C\u4E5F\u53EF\u80FD\u88AB\u9875\u9762\u7684 !important \u8986\u76D6 \u2014\u2014 \u56DE\u6267\u770B\u4E0D\u51FA\u8FD9\u4E9B\u3002\n\u6240\u4EE5\u5224\u636E\u662F**\u8BA1\u7B97\u540E\u7684\u6837\u5F0F\u503C**\uFF0C\u4E0D\u662F\u56DE\u6267\u6587\u6848\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u52A0\u9634\u5F71|\u9634\u5F71|box-shadow", "\u63CF\u8FB9|\u63CF\u4E2A\u8FB9|\u52A0\u4E2A\u6846|\u7A81\u51FA"],
      tools: ["get_page_snapshot", "annotate", "inspect_element", "complete_task"],
      playbook: "control-shadow"
    }
  },
  {
    name: "web-research",
    displayName: "\u68C0\u7D22\u8C03\u7814\u5E76\u628A\u8981\u70B9\u6C89\u6DC0\u8FDB\u77E5\u8BC6\u5E93",
    description: "\u5728\u4E00\u4E2A\u9875\u9762/\u7AD9\u70B9\u4E0A\u505A\u8C03\u7814\uFF1A\u627E\u7ED3\u679C\u3001\u6253\u5F00\u8BE6\u60C5\u3001\u8BFB\u5173\u952E\u4E8B\u5B9E\uFF0C\u5E76\u628A\u8981\u70B9\u5B58\u8FDB\u77E5\u8BC6\u5E93\u3002\u5F53\u7528\u6237\u8BF4\u300C\u8C03\u7814 / \u67E5\u4E00\u4E0B / \u7814\u7A76\u4E00\u4E0B / \u5E2E\u6211\u6574\u7406\u6210\u8D44\u6599\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "research",
    tags: ["\u8C03\u7814", "\u68C0\u7D22", "\u77E5\u8BC6\u5E93", "\u6C89\u6DC0"],
    skill_type: "prompt-template",
    content: '# \u68C0\u7D22\u8C03\u7814\uFF1A\u627E \u2192 \u8BFB \u2192 \u6C89\u6DC0\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u770B\u6E05\u7ED3\u679C\u5217\u8868\uFF0C\u786E\u5B9A\u8981\u6253\u5F00\u54EA\u51E0\u6761\uFF08\u7528\u6237\u70B9\u540D\u7684\u4F18\u5148\uFF09\uFF1B\n2. `click_element` \u6253\u5F00\u8BE6\u60C5 \u2014\u2014 \u8BE6\u60C5\u5F80\u5F80\u662F**\u70B9\u51FB\u540E\u5F02\u6B65\u6E32\u67D3**\u7684\uFF0C\n   \u70B9\u5B8C\u5148\u7528 `wait_for_element` \u7B49\u6807\u9898/\u6B63\u6587\u51FA\u73B0\uFF0C\u518D `inspect_element({ op: "text" })` \u8BFB\uFF1B\n3. \u628A**\u5173\u952E\u4E8B\u5B9E**\uFF08\u4E0D\u662F\u6574\u6BB5\u539F\u6587\uFF09\u5199\u8FDB `add_entry({ type: "note", title, note })`\uFF1B\n   \u540C\u4E00\u9875\u7684\u591A\u6761\u8981\u70B9\u653E\u8FDB**\u4E00\u6761** note\uFF08\u4F20 url \u4F1A\u6309 url \u53BB\u91CD\u3001\u4E92\u76F8\u8986\u76D6\uFF09\uFF1B\n4. `knowledge_read({ op: "get", id })` \u8BFB\u56DE\u786E\u8BA4\u771F\u7684\u5B58\u8FDB\u53BB\u4E86\uFF0C\u518D\u5411\u7528\u6237\u6C47\u62A5\u3002\n\n## \u4E24\u6761\u7EAA\u5F8B\n- **\u522B\u5728\u8BE6\u60C5\u6CA1\u6E32\u67D3\u65F6\u5C31\u8BFB**\uFF1A\u8BFB\u5230\u7A7A\u5217\u8868\u4E0D\u8981\u4EE5\u4E3A"\u6CA1\u6709\u8BE6\u60C5"\uFF0C\u5148\u7B49\u4E00\u7B49\u518D\u8BFB\uFF1B\n- **"\u8C03\u7814\u5B8C\u6210"\u7684\u5224\u636E\u662F\u6210\u679C\u6C89\u6DC0\u4E86**\uFF08\u77E5\u8BC6\u5E93\u80FD\u8BFB\u56DE\uFF09\uFF0C\u4E0D\u662F"\u6211\u6253\u5F00\u8FC7\u90A3\u4E2A\u9875\u9762"\u3002',
    x: {
      intents: ["browser_task", "research"],
      keywords: ["\u8C03\u7814|\u67E5\u4E00\u4E0B|\u7814\u7A76\u4E00\u4E0B|\u6574\u7406\u6210\u8D44\u6599", "\u68C0\u7D22|\u6C89\u6DC0|\u5B58\u8FDB\u77E5\u8BC6\u5E93"],
      tools: ["get_page_snapshot", "click_element", "wait_for_element", "inspect_element", "add_entry", "knowledge_read", "complete_task"],
      playbook: "web-research"
    }
  },
  {
    name: "site-assistant",
    displayName: "\u7AD9\u70B9 AI \u52A9\u624B\uFF1A\u8BFB\u9875\u9762\u3001\u6539\u72B6\u6001\u3001\u518D\u56DE\u8BDD",
    description: "\u626E\u6F14\u67D0\u4E2A\u7AD9\u5185\u540E\u53F0/\u9875\u9762\u7684\u52A9\u624B\uFF0C\u6309\u7528\u6237\u610F\u56FE\u8BFB\u9875\u9762\u72B6\u6001\u3001\u505A\u5BF9\u5E94\u64CD\u4F5C\uFF0C\u518D\u57FA\u4E8E\u53D8\u5316\u540E\u7684\u72B6\u6001\u56DE\u8BDD\u3002\u5F53\u7528\u6237\u8BF4\u300C\u5E2E\u6211\u5728\u8FD9\u4E2A\u540E\u53F0 / \u4F60\u662F\u8FD9\u4E2A\u7F51\u7AD9\u7684\u52A9\u624B / \u5E2E\u6211\u628A\u8FD9\u6761\u2026\u300D\u65F6\u4F7F\u7528\u3002",
    version: "1.0.0",
    category: "browser-automation",
    tags: ["\u52A9\u624B", "\u540E\u53F0", "\u591A\u8F6E", "\u9875\u9762\u64CD\u4F5C"],
    skill_type: "prompt-template",
    content: '# \u7AD9\u70B9\u52A9\u624B\uFF1A\u8BFB \u2192 \u6539 \u2192 \u8BFB\u56DE \u2192 \u56DE\u8BDD\n\n## \u6B65\u9AA4\n1. `get_page_snapshot` \u8BFB\u6E05\u73B0\u72B6\uFF1A\u6709\u51E0\u6761\u3001\u5404\u662F\u4EC0\u4E48\u72B6\u6001\u3001\u76EE\u6807\u5728\u54EA\uFF1B\n2. **\u53EA\u6539\u7528\u6237\u8981\u6C42\u7684\u90A3\u4E00\u6761**\uFF0C\u7528\u8BED\u4E49\u5B9A\u4F4D\uFF08role+name \u6216\u6587\u672C\uFF09\uFF0C\u522B\u51ED\u5E8F\u53F7\u4E71\u731C\uFF1B\n3. \u6539\u5B8C `inspect_element({ op: "text" })` \u8BFB\u56DE**\u53D8\u5316\u540E\u7684\u72B6\u6001**\uFF0C\u4F5C\u4E3A\u56DE\u8BDD\u4F9D\u636E\uFF1B\n4. \u57FA\u4E8E\u8BFB\u56DE\u7684\u72B6\u6001\u56DE\u7B54\u7528\u6237\uFF0C\u660E\u786E\u8BF4\u51FA\u6539\u4E86\u4EC0\u4E48\u3001\u5176\u5B83\u6761\u76EE\u662F\u5426\u88AB\u5F71\u54CD\u3002\n\n## \u4E24\u6761\u7EAA\u5F8B\n- **\u522B\u5728\u6CA1\u8BFB\u56DE\u72B6\u6001\u524D\u5C31\u65AD\u8A00\u6210\u529F**\uFF1A\u5DE5\u5177\u56DE\u6267"\u5DF2\u70B9\u51FB"\u4E0D\u7B49\u4E8E\u4E1A\u52A1\u72B6\u6001\u771F\u7684\u53D8\u4E86\uFF1B\n- **\u53EA\u52A8\u76EE\u6807**\uFF1A\u591A\u6761\u76EE\u9875\u9762\u91CC\u8BEF\u6539\u4E00\u6761\uFF0C\u6BD4\u4E0D\u505A\u66F4\u7CDF \u2014\u2014 \u5148\u8BFB\u6E05\u518D\u52A8\u624B\u3002',
    x: {
      intents: ["browser_task"],
      keywords: ["\u5BA2\u670D|\u52A9\u624B|\u540E\u53F0|\u5E2E\u6211\u628A\u8FD9\u6761|\u6807\u8BB0\u4E3A"],
      tools: ["get_page_snapshot", "click_element", "inspect_element", "complete_task"],
      playbook: "site-assistant"
    }
  }
]);

// lib/assistant/skill-md.js
function compileKeywords(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item instanceof RegExp) {
      out.push(item);
      continue;
    }
    const src = String(item || "").trim();
    if (!src) continue;
    const group = src.split("|").map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    if (group) out.push(new RegExp(group));
  }
  return out;
}
function parseScalar(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (s === "" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
function parseSkillMd(text) {
  const str = String(text || "");
  const m = str.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) {
    return { data: {}, body: str.trim() };
  }
  const fm = m[1];
  const body = m[2].replace(/\s+$/, "");
  const data = {};
  let curKey = null;
  for (const line of fm.split(/\r?\n/)) {
    if (/^\s*-\s+/.test(line) && curKey) {
      const val = parseScalar(line.replace(/^\s*-\s+/, ""));
      if (!Array.isArray(data[curKey])) data[curKey] = [];
      data[curKey].push(val);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (kv) {
      curKey = kv[1];
      const v = kv[2].trim();
      data[curKey] = v === "" ? [] : parseScalar(v);
    }
  }
  return { data, body };
}
function mdToSkill(text) {
  const { data, body } = parseSkillMd(text);
  const x = {
    intents: Array.isArray(data["x-recallflow-intents"]) ? data["x-recallflow-intents"] : [],
    keywords: Array.isArray(data["x-recallflow-keywords"]) ? data["x-recallflow-keywords"] : [],
    tools: Array.isArray(data["x-recallflow-tools"]) ? data["x-recallflow-tools"] : []
  };
  return {
    name: typeof (data.name || data.slug) === "string" ? String(data.name || data.slug) : "",
    displayName: typeof data["x-recallflow-display-name"] === "string" ? data["x-recallflow-display-name"] : "",
    description: typeof (data.description || data.summary) === "string" ? String(data.description || data.summary) : "",
    version: typeof data.version === "string" ? data.version : "1.0.0",
    category: typeof data.category === "string" ? data.category : "",
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    skill_type: typeof data.skill_type === "string" ? data.skill_type : "prompt-template",
    content: body,
    x
  };
}
function toRuntimeSkill(skill, builtin = false) {
  const x = skill.x || {};
  const keywordStrings = Array.isArray(x.keywords) ? x.keywords.map(String) : [];
  return {
    id: skill.name || "custom-" + Date.now().toString(36),
    name: skill.name || "",
    title: skill.displayName || skill.name || "\u672A\u547D\u540D\u6280\u80FD",
    description: skill.description || "",
    version: skill.version || "1.0.0",
    category: skill.category || "",
    tags: Array.isArray(skill.tags) ? skill.tags : [],
    skill_type: skill.skill_type || "prompt-template",
    content: skill.content || "",
    match: {
      intents: Array.isArray(x.intents) ? x.intents : [],
      keywords: compileKeywords(keywordStrings),
      keywordStrings
    },
    tools: Array.isArray(x.tools) ? x.tools : [],
    builtin: !!builtin
  };
}

// lib/assistant/skill-store.js
var STORAGE_KEY2 = "recallflow.skills";
function compileAll(list, builtin) {
  return list.map((s) => toRuntimeSkill(s, builtin));
}
function getDefaultSkills() {
  return compileAll(SKILL_REGISTRY, true);
}
async function getUserSkills() {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY2);
    const list = r && r[STORAGE_KEY2] || [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}
async function getMergedSkills() {
  const defaults = getDefaultSkills();
  const user = compileAll(await getUserSkills(), false);
  const names = new Set(defaults.map((s) => s.name));
  return defaults.concat(user.filter((s) => !names.has(s.name)));
}
function toStorageShape(skill) {
  const x = skill.x || {};
  return {
    name: skill.name,
    displayName: skill.displayName || "",
    description: skill.description || "",
    version: skill.version || "1.0.0",
    category: skill.category || "",
    tags: Array.isArray(skill.tags) ? skill.tags : [],
    skill_type: skill.skill_type || "prompt-template",
    content: skill.content || "",
    x: {
      intents: Array.isArray(x.intents) ? x.intents : [],
      keywords: Array.isArray(x.keywords) ? x.keywords : [],
      tools: Array.isArray(x.tools) ? x.tools : []
    }
  };
}
async function saveUserSkills(list) {
  await chrome.storage.local.set({ [STORAGE_KEY2]: list.map(toStorageShape) });
}
function genId() {
  return "custom-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
async function addUserSkill(skill) {
  const list = await getUserSkills();
  const item = toStorageShape({ ...skill, name: skill.name || genId() });
  list.push(item);
  await saveUserSkills(list);
  return item;
}
async function updateUserSkill(id, patch) {
  const list = await getUserSkills();
  const idx = list.findIndex((s) => s.name === id);
  if (idx < 0) return null;
  list[idx] = toStorageShape({ ...list[idx], ...patch, name: list[idx].name });
  await saveUserSkills(list);
  return list[idx];
}

// lib/backend/cdp.js
var cdp_exports = {};
__export(cdp_exports, {
  DEFAULT_CDP_TIMEOUT_MS: () => DEFAULT_CDP_TIMEOUT_MS,
  attach: () => attach,
  clickAt: () => clickAt,
  command: () => command,
  detach: () => detach,
  detachAll: () => detachAll,
  drag: () => drag,
  evaluate: () => evaluate,
  evaluateInFrame: () => evaluateInFrame,
  getBoxModel: () => getBoxModel,
  getFrameTree: () => getFrameTree,
  getFullAxTree: () => getFullAxTree,
  handleJavaScriptDialog: () => handleJavaScriptDialog,
  insertText: () => insertText,
  isCdpAvailable: () => isCdpAvailable,
  moveTo: () => moveTo,
  pressKey: () => pressKey,
  rectForSelector: () => rectForSelector,
  resolveFrameClickPoint: () => resolveFrameClickPoint,
  screenshot: () => screenshot,
  uploadFile: () => uploadFile
});
var PROTOCOL_VERSION = "1.3";
var attached = /* @__PURE__ */ new Map();
function isCdpAvailable() {
  return typeof chrome !== "undefined" && !!chrome.debugger && !!chrome.debugger.sendCommand;
}
if (isCdpAvailable() && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId != null) attached.delete(source.tabId);
  });
}
async function attach(tabId, opts = {}) {
  if (!isCdpAvailable()) throw new Error("\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301 chrome.debugger\uFF08\u9700\u8981 Chromium \u5185\u6838\u6D4F\u89C8\u5668\uFF09");
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("\u65E0\u6548\u7684 tabId\uFF1A" + tabId);
  if (attached.has(id)) return attached.get(id);
  const task = withTimeout(
    new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId: id }, PROTOCOL_VERSION, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || "\u65E0\u6CD5\u9644\u52A0\u8C03\u8BD5\u5668"));
          return;
        }
        resolve();
      });
    }),
    opts.timeoutMs,
    () => "CDP \u9644\u52A0\u8C03\u8BD5\u5668\u672A\u54CD\u5E94"
  );
  attached.set(id, task);
  try {
    await task;
    sendRaw(id, "Page.enable").catch(() => {
    });
    return task;
  } catch (e) {
    attached.delete(id);
    throw e;
  }
}
async function detach(tabId, timeoutMs) {
  const id = Number(tabId);
  if (!attached.has(id)) return;
  attached.delete(id);
  if (!isCdpAvailable()) return;
  await withTimeout(
    new Promise((resolve) => {
      try {
        chrome.debugger.detach({ tabId: id }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch (e) {
        resolve();
      }
    }),
    timeoutMs,
    () => "CDP \u89E3\u9664\u9644\u52A0\uFF08detach\uFF09\u672A\u54CD\u5E94"
  ).catch(() => {
  });
}
function detachAll() {
  for (const id of Array.from(attached.keys())) detach(id).catch(() => {
  });
}
function sendRaw(tabId, method, params, timeoutMs) {
  return withTimeout(
    new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, params || {}, (result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message || "CDP " + method + " \u5931\u8D25"));
        else resolve(result);
      });
    }),
    timeoutMs,
    () => "CDP \u547D\u4EE4 " + method + " \u672A\u54CD\u5E94"
  );
}
var DEFAULT_CDP_TIMEOUT_MS = 8e3;
function withTimeout(promise, ms, describe) {
  const limit = Number(ms) > 0 ? Number(ms) : DEFAULT_CDP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(describe() + "\uFF08" + limit + "ms \u672A\u54CD\u5E94\uFF09")), limit);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
async function command(tabId, method, params, opts = {}) {
  await attach(tabId, opts);
  try {
    return await sendRaw(tabId, method, params, opts.timeoutMs);
  } catch (e) {
    throw new Error(method + "\uFF1A" + (e && e.message ? e.message : String(e)));
  }
}
function modifiersMask(modifiers) {
  const list = Array.isArray(modifiers) ? modifiers.map((m) => String(m).toUpperCase()) : [];
  let mask = 0;
  if (list.includes("ALT")) mask |= 1;
  if (list.includes("CTRL") || list.includes("CONTROL")) mask |= 2;
  if (list.includes("META") || list.includes("CMD") || list.includes("COMMAND")) mask |= 4;
  if (list.includes("SHIFT")) mask |= 8;
  return mask;
}
var KEY_DEFS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " }
};
function charKeyDef(ch) {
  const upper = ch.toUpperCase();
  let code = ch;
  if (/[A-Z]/.test(upper)) code = "Key" + upper;
  else if (/[0-9]/.test(ch)) code = "Digit" + ch;
  return { key: ch, code, keyCode: upper.charCodeAt(0), text: ch };
}
function keyInfo(key, mask) {
  const def = KEY_DEFS[key] || (/^.$/.test(key) ? charKeyDef(key) : { key, code: key, keyCode: 0 });
  const info = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers: mask
  };
  if (def.text) info.text = def.text;
  return info;
}
async function clickAt(tabId, x, y, options = {}) {
  const button = options.button || "left";
  const buttons = button === "right" ? 2 : button === "middle" ? 4 : 1;
  const common = { x: Math.round(x), y: Math.round(y), button, modifiers: modifiersMask(options.modifiers) };
  await command(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: common.x, y: common.y, buttons: 0, modifiers: common.modifiers });
  if (options.clickCount === 2) {
    await command(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...common, clickCount: 1, buttons });
    await command(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...common, clickCount: 1, buttons: 0 });
  }
  await command(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...common, clickCount: options.clickCount || 1, buttons });
  await command(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...common, clickCount: options.clickCount || 1, buttons: 0 });
  return { ok: true };
}
async function moveTo(tabId, x, y, options = {}) {
  await command(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: Math.round(x),
    y: Math.round(y),
    buttons: 0,
    modifiers: modifiersMask(options.modifiers)
  });
  return { ok: true };
}
async function drag(tabId, x1, y1, x2, y2) {
  await command(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1), y: Math.round(y1), buttons: 0 });
  await command(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(x1 + (x2 - x1) * i / steps);
    const y = Math.round(y1 + (y2 - y1) * i / steps);
    await command(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  }
  await command(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 });
  return { ok: true };
}
async function insertText(tabId, text) {
  await command(tabId, "Input.insertText", { text: String(text == null ? "" : text) });
  return { ok: true };
}
async function pressKey(tabId, key, modifiers) {
  const mask = modifiersMask(modifiers);
  const info = keyInfo(key, mask);
  await command(tabId, "Input.dispatchKeyEvent", Object.assign({ type: "keyDown" }, info));
  await command(tabId, "Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, info));
  return { ok: true };
}
async function screenshot(tabId, options = {}) {
  const r = await command(
    tabId,
    "Page.captureScreenshot",
    {
      format: options.format || "png",
      quality: options.quality,
      captureBeyondViewport: options.fullPage === true
    },
    { timeoutMs: options.timeoutMs }
  );
  return r && r.data || "";
}
async function getFullAxTree(tabId) {
  await command(tabId, "Accessibility.enable");
  const r = await command(tabId, "Accessibility.getFullAXTree");
  return r && r.nodes || [];
}
async function getBoxModel(tabId, backendNodeId) {
  const r = await command(tabId, "DOM.getBoxModel", { backendNodeId });
  return r && r.model || null;
}
async function evaluate(tabId, expression, options = {}) {
  const r = await command(tabId, "Runtime.evaluate", {
    expression: String(expression),
    awaitPromise: options.awaitPromise !== false,
    returnByValue: options.returnByValue !== false,
    userGesture: options.userGesture === true
  });
  if (r && r.exceptionDetails) {
    const desc = r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || "\u9875\u9762\u6267\u884C\u5F02\u5E38";
    throw new Error(desc);
  }
  return r && r.result ? r.result.value : void 0;
}
async function evaluateInFrame(tabId, frameId, expression, options = {}) {
  const fid = Number(frameId);
  if (!Number.isInteger(fid) || fid <= 0) return evaluate(tabId, expression, options);
  await command(tabId, "Page.enable");
  const world = await command(tabId, "Page.createIsolatedWorld", { frameId: fid, worldName: "recallflow" });
  const contextId = world && world.executionContextId;
  if (!contextId) throw new Error("\u65E0\u6CD5\u5728\u76EE\u6807\u6846\u67B6\u521B\u5EFA\u6267\u884C\u4E0A\u4E0B\u6587\uFF08frameId=" + fid + "\uFF09");
  const r = await command(tabId, "Runtime.evaluate", {
    expression: String(expression),
    contextId,
    awaitPromise: options.awaitPromise !== false,
    returnByValue: options.returnByValue !== false,
    userGesture: options.userGesture === true
  });
  if (r && r.exceptionDetails) {
    const desc = r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || "\u9875\u9762\u6267\u884C\u5F02\u5E38";
    throw new Error(desc);
  }
  return r && r.result ? r.result.value : void 0;
}
async function rectForSelector(tabId, selector) {
  const expr = "(() => { const el = document.querySelector(" + JSON.stringify(String(selector || "")) + "); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, centerX: r.x + r.width / 2, centerY: r.y + r.height / 2 }; })()";
  return evaluate(tabId, expr);
}
async function uploadFile(tabId, selector, files) {
  await command(tabId, "DOM.enable");
  const doc = await command(tabId, "DOM.getDocument", { depth: -1, pierce: true });
  const rootId = doc && doc.root && doc.root.nodeId;
  const q = await command(tabId, "DOM.querySelector", { nodeId: rootId, selector: String(selector || "") });
  if (!q || !q.nodeId) throw new Error("\u672A\u627E\u5230 file input\uFF1A" + selector);
  await command(tabId, "DOM.setFileInputFiles", { files: Array.isArray(files) ? files : [files], nodeId: q.nodeId });
  return { ok: true };
}
async function getFrameTree(tabId) {
  const r = await command(tabId, "Page.getFrameTree");
  return r && r.frameTree || null;
}
async function frameParentMap(tabId) {
  const tree = await getFrameTree(tabId);
  const map = /* @__PURE__ */ new Map();
  const walk = (node) => {
    if (!node || !node.frame) return;
    map.set(node.frame.id, node.frame.parentId || null);
    for (const c of node.childFrames || []) walk(c);
  };
  walk(tree);
  return map;
}
async function frameOffset(tabId, frameId, parentMap) {
  let fid = frameId;
  let x = 0;
  let y = 0;
  let guard = 0;
  while (fid && parentMap.get(fid)) {
    try {
      const owner = await command(tabId, "DOM.getFrameOwner", { frameId: fid });
      if (owner && owner.backendNodeId) {
        const box = await command(tabId, "DOM.getBoxModel", { backendNodeId: owner.backendNodeId });
        const q = box && box.content;
        if (q && q.length >= 8) {
          x += Math.min(q[0], q[2], q[4], q[6]);
          y += Math.min(q[1], q[3], q[5], q[7]);
        }
      }
    } catch (e) {
    }
    fid = parentMap.get(fid);
    if (++guard > 30) break;
  }
  return { x, y };
}
async function elementBoxCenter(tabId, frameId, selector) {
  await command(tabId, "DOM.enable");
  await command(tabId, "Page.enable");
  const world = await command(tabId, "Page.createIsolatedWorld", { frameId: Number(frameId), worldName: "recallflow" });
  const contextId = world && world.executionContextId;
  if (!contextId) return null;
  const ev = await command(tabId, "Runtime.evaluate", {
    expression: "document.querySelector(" + JSON.stringify(String(selector || "")) + ")",
    contextId,
    returnByValue: false
  });
  const objId = ev && ev.result && ev.result.objectId;
  if (!objId) return null;
  const node = await command(tabId, "DOM.requestNode", { objectId: objId });
  const nodeId = node && node.nodeId;
  if (!nodeId) return null;
  const box = await command(tabId, "DOM.getBoxModel", { nodeId });
  const q = box && box.content;
  if (!q || q.length < 8) return null;
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}
async function pointHitsIframe(tabId, x, y) {
  const expr = "(() => { const el = document.elementFromPoint(" + Math.round(x) + "," + Math.round(y) + '); return !!el && (el.tagName === "IFRAME" || !!el.closest("iframe")); })()';
  return evaluate(tabId, expr).catch(() => false);
}
async function resolveFrameClickPoint(tabId, frameId, selector, fallbackCenter) {
  const fid = Number(frameId);
  if (!Number.isInteger(fid) || fid <= 0) return fallbackCenter || null;
  const parentMap = await frameParentMap(tabId).catch(() => /* @__PURE__ */ new Map());
  try {
    const c = await elementBoxCenter(tabId, fid, selector);
    if (c && await pointHitsIframe(tabId, c.x, c.y)) return c;
  } catch (e) {
  }
  if (fallbackCenter && Number.isFinite(fallbackCenter.x) && Number.isFinite(fallbackCenter.y)) {
    try {
      const off = await frameOffset(tabId, fid, parentMap);
      const c = { x: off.x + fallbackCenter.x, y: off.y + fallbackCenter.y };
      if (await pointHitsIframe(tabId, c.x, c.y)) return c;
    } catch (e) {
    }
  }
  return null;
}
async function handleJavaScriptDialog(tabId, accept, promptText) {
  await command(tabId, "Page.handleJavaScriptDialog", {
    accept: accept !== false,
    ...typeof promptText === "string" ? { promptText } : {}
  });
  return { ok: true };
}

// lib/assistant/site-memory.js
var KEY = "recallflow.siteMemory.v1";
var MAX_PER_ORIGIN = 60;
var MAX_ORIGINS = 50;
function originOf(url) {
  return siteKeyOf(url);
}
async function readAll() {
  try {
    const d = await chrome.storage.local.get(KEY);
    const m = d && d[KEY];
    return m && typeof m === "object" ? m : {};
  } catch (e) {
    return {};
  }
}
async function writeAll(all) {
  try {
    await chrome.storage.local.set({ [KEY]: all });
  } catch (e) {
  }
}
function normalizeKey(label, role, tag) {
  const l = String(label || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40);
  if (!l) return "";
  return (role || tag || "el") + "::" + l;
}
function latestTs(site) {
  let ts = 0;
  for (const v of Object.values(site || {})) ts = Math.max(ts, Number(v && v.updatedAt) || 0);
  return ts;
}
async function rememberElement(url, info) {
  const origin = originOf(url);
  if (!origin || !info || !info.selector) return;
  const key = normalizeKey(info.label, info.role, info.tag);
  if (!key) return;
  const all = await readAll();
  const site = all[origin] || {};
  const prev = site[key];
  site[key] = {
    selector: String(info.selector).slice(0, 300),
    label: String(info.label || "").slice(0, 60),
    role: info.role || "",
    tag: info.tag || "",
    hits: (Number(prev && prev.hits) || 0) + 1,
    updatedAt: Date.now()
  };
  const trimmed = Object.entries(site).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, MAX_PER_ORIGIN);
  all[origin] = Object.fromEntries(trimmed);
  const origins = Object.entries(all).sort((a, b) => latestTs(b[1]) - latestTs(a[1])).slice(0, MAX_ORIGINS);
  await writeAll(Object.fromEntries(origins));
}

// lib/assistant/macro-store.js
var KEY2 = "recallflow.macros.v1";
var MAX_PER_ORIGIN2 = 20;
var MAX_ORIGINS2 = 50;
var MAX_STEPS = 40;
function originOf2(url) {
  return siteKeyOf(url);
}
async function readAll2() {
  try {
    const d = await chrome.storage.local.get(KEY2);
    const m = d && d[KEY2];
    return m && typeof m === "object" ? m : {};
  } catch (e) {
    return {};
  }
}
async function writeAll2(all) {
  try {
    await chrome.storage.local.set({ [KEY2]: all });
  } catch (e) {
  }
}
function latestTs2(site) {
  let ts = 0;
  for (const v of Object.values(site || {})) ts = Math.max(ts, Number(v && v.updatedAt) || 0);
  return ts;
}
function normalizeName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, 40);
}
function sanitizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.filter((s) => s && typeof s.tool === "string" && s.args && typeof s.args === "object").slice(0, MAX_STEPS).map((s) => ({ tool: s.tool, args: s.args }));
}
async function saveMacro(url, macro) {
  const origin = originOf2(url);
  if (!origin) return null;
  const name = normalizeName(macro && macro.name);
  if (!name) return null;
  const steps = sanitizeSteps(macro && macro.steps);
  if (!steps.length) return null;
  const all = await readAll2();
  const site = all[origin] || {};
  const prev = site[name];
  site[name] = {
    name,
    description: String(macro && macro.description || "").slice(0, 200),
    steps,
    hits: Number(prev && prev.hits) || 0,
    createdAt: prev && prev.createdAt || Date.now(),
    updatedAt: Date.now()
  };
  const trimmed = Object.entries(site).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, MAX_PER_ORIGIN2);
  all[origin] = Object.fromEntries(trimmed);
  const origins = Object.entries(all).sort((a, b) => latestTs2(b[1]) - latestTs2(a[1])).slice(0, MAX_ORIGINS2);
  await writeAll2(Object.fromEntries(origins));
  return site[name];
}
async function listMacros(url) {
  const origin = originOf2(url);
  if (!origin) return [];
  const all = await readAll2();
  const site = all[origin];
  if (!site) return [];
  return Object.values(site).sort(
    (a, b) => (b.hits || 0) - (a.hits || 0) || String(a.name || "").localeCompare(String(b.name || ""))
  );
}
async function getMacro(url, name) {
  const origin = originOf2(url);
  if (!origin) return null;
  const all = await readAll2();
  const site = all[origin];
  if (!site) return null;
  return site[normalizeName(name)] || null;
}
async function bumpMacroHits(url, name) {
  const origin = originOf2(url);
  if (!origin) return;
  const all = await readAll2();
  const site = all[origin];
  if (!site || !site[normalizeName(name)]) return;
  site[normalizeName(name)].hits = (Number(site[normalizeName(name)].hits) || 0) + 1;
  site[normalizeName(name)].updatedAt = Date.now();
  await writeAll2(all);
}
var LAST_TRACE_KEY = "recallflow.lastTrace.v1";
var LAST_TRACE_TTL_MS = 30 * 60 * 1e3;
async function readLastTraces() {
  try {
    const d = await chrome.storage.local.get(LAST_TRACE_KEY);
    const m = d && d[LAST_TRACE_KEY];
    return m && typeof m === "object" ? m : {};
  } catch (e) {
    return {};
  }
}
async function recallTrace(url, opts = {}) {
  const origin = originOf2(url);
  if (!origin) return null;
  const maxAgeMs = Number.isFinite(Number(opts.maxAgeMs)) ? Number(opts.maxAgeMs) : LAST_TRACE_TTL_MS;
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const all = await readLastTraces();
  const rec = all[origin];
  if (!rec || !Array.isArray(rec.steps) || !rec.steps.length) return null;
  const ageMs = Math.max(0, now - Number(rec.updatedAt || 0));
  if (ageMs >= maxAgeMs) return null;
  return { steps: rec.steps, updatedAt: Number(rec.updatedAt) || 0, ageMs, dropped: Number(rec.dropped) || 0 };
}

// lib/assistant/target-manager.js
var state = /* @__PURE__ */ new Map();
function bucket(tabId) {
  const id = Number(tabId);
  let rec = state.get(id);
  if (!rec) {
    rec = { dialogs: [], downloads: [], fileChoosers: [] };
    state.set(id, rec);
  }
  return rec;
}
function getPendingDialogs(tabId) {
  return bucket(tabId).dialogs;
}
function clearDialogs(tabId) {
  bucket(tabId).dialogs = [];
}
function getDownloads(tabId) {
  return bucket(tabId).downloads;
}
async function handleDialog(tabId, accept, promptText) {
  await handleJavaScriptDialog(tabId, accept !== false, promptText);
  clearDialogs(tabId);
  return { ok: true };
}

// lib/assistant/trace.js
var TRACE_PREFIX = "recallflow.runTrace.v1.";
var TRACE_INDEX_KEY = "recallflow.runTraceIndex.v1";
var LEGACY_KEY = "recallflow.runTraces.v1";
var MAX_RUNS = 8;
var MAX_ENTRIES = 300;
function area() {
  if (typeof chrome === "undefined" || !chrome.storage) return null;
  return chrome.storage.session || chrome.storage.local;
}
var indexCache = null;
function pruneIndex(index, now = Date.now()) {
  const entries = Object.entries(index || {}).sort((a, b) => Number(b[1] && b[1].updatedAt || 0) - Number(a[1] && a[1].updatedAt || 0)).slice(0, MAX_RUNS);
  return Object.fromEntries(entries);
}
async function migrateLegacy(table) {
  const a = area();
  const merged = Object.assign({}, indexCache || {});
  const writes = {};
  for (const [runId, rec] of Object.entries(table || {})) {
    if (!runId || !rec || typeof rec !== "object") continue;
    writes[TRACE_PREFIX + runId] = rec;
    if (!merged[runId]) merged[runId] = { updatedAt: Number(rec.updatedAt || rec.startedAt || Date.now()) };
  }
  indexCache = pruneIndex(merged);
  if (a && Object.keys(writes).length) {
    try {
      await a.set(Object.assign(writes, { [TRACE_INDEX_KEY]: indexCache }));
    } catch (e) {
    }
  }
  if (a) {
    try {
      await a.remove(LEGACY_KEY);
    } catch (e) {
    }
  }
}
async function loadIndex() {
  if (indexCache) return indexCache;
  const a = area();
  if (!a) {
    indexCache = {};
    return indexCache;
  }
  let idx = null;
  try {
    const d = await a.get(TRACE_INDEX_KEY);
    idx = d && d[TRACE_INDEX_KEY];
  } catch (e) {
    idx = null;
  }
  if (idx && typeof idx === "object") indexCache = idx;
  let legacy = null;
  try {
    const d = await a.get(LEGACY_KEY);
    legacy = d && d[LEGACY_KEY];
  } catch (e) {
    legacy = null;
  }
  if (legacy && typeof legacy === "object") await migrateLegacy(legacy);
  else if (!indexCache) indexCache = {};
  return indexCache;
}
async function readRun(runId) {
  const a = area();
  if (!a) return null;
  try {
    const d = await a.get(TRACE_PREFIX + runId);
    return d && d[TRACE_PREFIX + runId];
  } catch (e) {
    return null;
  }
}
async function writeRun(runId, rec) {
  const a = area();
  if (!a) return;
  try {
    await a.set({ [TRACE_PREFIX + runId]: rec, [TRACE_INDEX_KEY]: indexCache });
  } catch (e) {
  }
}
var pendingEntries = /* @__PURE__ */ new Map();
var flushChains = /* @__PURE__ */ new Map();
async function writePending(runId) {
  const entries = pendingEntries.get(runId);
  if (!entries || !entries.length) return;
  pendingEntries.set(runId, []);
  const rec = await readRun(runId) || { runId, startedAt: Date.now(), entries: [] };
  if (!Array.isArray(rec.entries)) rec.entries = [];
  for (const e of entries) rec.entries.push(e);
  if (rec.entries.length > MAX_ENTRIES) rec.entries = rec.entries.slice(-MAX_ENTRIES);
  const newest = entries.reduce((mx, e) => Math.max(mx, Number(e && e.ts) || 0), 0);
  rec.updatedAt = Math.max(Number(rec.updatedAt) || 0, newest) || Date.now();
  indexCache = pruneIndex(Object.assign({}, indexCache, { [runId]: { updatedAt: rec.updatedAt } }));
  await writeRun(runId, rec);
}
async function flushTraces(runId) {
  await loadIndex();
  const ids = runId ? [runId] : Array.from(pendingEntries.keys());
  for (const id of ids) {
    const prev = flushChains.get(id) || Promise.resolve();
    const next = prev.then(() => writePending(id)).catch(() => {
    });
    flushChains.set(id, next);
    await next;
  }
}
async function getTrace(runId) {
  if (!runId) return null;
  await flushTraces(runId);
  await loadIndex();
  if (!indexCache[runId]) return null;
  return readRun(runId);
}
async function listTraces() {
  await flushTraces();
  await loadIndex();
  const ids = Object.keys(indexCache);
  if (!ids.length) return [];
  const out = [];
  for (const id of ids) {
    const rec = await readRun(id);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// lib/assistant/tool-schemas.js
var HIGHLIGHT_MAX_TEXTS = 20;
var TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "knowledge_read",
      description: "\u8BFB\u53D6\u7528\u6237\u7684\u4E2A\u4EBA\u77E5\u8BC6\u5E93\uFF08\u7B97\u6CD5\u9519\u9898\u3001\u6280\u672F\u6587\u7AE0\u3001AI\xB7Prompt\u3001\u7B14\u8BB0\uFF09\u3002\u6309 op \u9009\u62E9\u8BFB\u6CD5\uFF1Asearch \u2014\u2014 \u6309\u5173\u952E\u8BCD/\u95EE\u9898\u68C0\u7D22\u76F8\u5173\u6761\u76EE\uFF08\u7528\u6237\u95EE\u5230\u77E5\u8BC6\u5E93\u5185\u5BB9\u3001\u6216\u9700\u8981\u5148\u67E5\u8D44\u6599\u65F6\u7528\uFF09\uFF1Blist \u2014\u2014 \u5217\u51FA\u6761\u76EE\u6982\u89C8\uFF0C\u53EF\u6309\u7C7B\u578B\u7B5B\u9009\uFF08\u300C\u77E5\u8BC6\u5E93\u91CC\u6709\u4EC0\u4E48\u300D\u300C\u5217\u51FA\u5168\u90E8\u7B14\u8BB0\u300D\u7528\uFF09\uFF1Bget \u2014\u2014 \u6309 id \u53D6\u5355\u6761\u5B8C\u6574\u5185\u5BB9\uFF08\u6807\u9898\u3001\u5907\u6CE8\u3001\u6807\u7B7E\u3001\u94FE\u63A5\u3001\u661F\u7EA7\uFF09\u3002**\u5199\u5165\u4E0E\u5220\u9664\u4E0D\u5728\u8FD9\u91CC**\uFF1A\u65B0\u589E/\u66F4\u65B0\u7528 add_entry\uFF0C\u5220\u9664\u7528 remove_entry\u3002",
      parameters: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["search", "list", "get"],
            description: "\u8BFB\u6CD5\uFF1Asearch \u6309\u5173\u952E\u8BCD\u68C0\u7D22 / list \u5217\u51FA\u6982\u89C8 / get \u6309 id \u53D6\u5355\u6761"
          },
          query: { type: "string", description: "op=search \u65F6\u5FC5\u586B\uFF1A\u68C0\u7D22\u5173\u952E\u8BCD\u6216\u81EA\u7136\u8BED\u8A00\u95EE\u9898" },
          id: { type: "string", description: "op=get \u65F6\u5FC5\u586B\uFF1A\u6761\u76EE id\uFF08\u901A\u5E38\u662F\u5176 URL\uFF09" },
          type: { type: "string", enum: ["wrong", "article", "ai", "note", ""], description: "op=list \u65F6\u53EF\u9009\uFF1A\u6309\u7C7B\u578B\u7B5B\u9009\uFF0C\u7559\u7A7A\u8868\u793A\u5168\u90E8" },
          limit: { type: "integer", description: "op=search \u9ED8\u8BA4 5\uFF1Bop=list \u9ED8\u8BA4 20" }
        },
        required: ["op"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_entry",
      description: "\u5411\u77E5\u8BC6\u5E93\u65B0\u589E\u6216\u66F4\u65B0\u4E00\u6761\u6761\u76EE\u3002\u53EF\u7528\u4E8E\u628A\u5BF9\u8BDD\u4E2D\u786E\u8BA4\u7684\u77E5\u8BC6\u70B9\u3001\u603B\u7ED3\u3001\u94FE\u63A5\u7B49\u4FDD\u5B58\u4E0B\u6765\u3002",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "\u66F4\u65B0\u5DF2\u6709\u6761\u76EE\u65F6\u4F20\u6761\u76EE id\uFF1B\u65B0\u5EFA\u6761\u76EE\u7559\u7A7A" },
          type: { type: "string", enum: ["wrong", "article", "ai", "note"], description: "\u6761\u76EE\u7C7B\u578B" },
          title: { type: "string", description: "\u6807\u9898" },
          url: { type: "string", description: "\u76F8\u5173\u94FE\u63A5\uFF08\u53EF\u9009\uFF0C\u65E0\u5219\u7559\u7A7A\uFF09" },
          status: { type: "integer", enum: [1, 2, 3], description: "\u661F\u7EA7 1\u4E00\u822C / 2\u91CD\u70B9 / 3\u9AD8\u9891" },
          note: { type: "string", description: "\u5907\u6CE8\u6216\u5185\u5BB9" },
          tags: { type: "array", items: { type: "string" }, description: "\u6807\u7B7E\u5217\u8868" }
        },
        required: ["type", "title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remove_entry",
      description: "\u4ECE\u77E5\u8BC6\u5E93\u5220\u9664\u4E00\u6761\u6761\u76EE\u3002",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "\u6761\u76EE id" } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_current_page",
      description: "\u8BFB\u53D6\u5F53\u524D\u7F51\u9875\u6B63\u6587\uFF08\u53BB\u811A\u672C/\u6837\u5F0F/\u5BFC\u822A\u540E\u7684\u7EAF\u6587\u672C\uFF09\uFF0C\u7528\u4E8E\u57FA\u4E8E\u300C\u6B63\u5728\u6D4F\u89C8\u7684\u9875\u9762\u300D\u56DE\u7B54\u6216\u63D0\u53D6\u4FE1\u606F\u3002\u9ED8\u8BA4\u8FD4\u56DE**\u542B\u9690\u85CF\u8282\u70B9\u6587\u5B57**\u7684\u6587\u672C\uFF1B\u8981\u5224\u65AD\u67D0\u6BB5\u6587\u6848\u662F\u5426\u8FD8\u770B\u5F97\u89C1\uFF08\u5982\u786E\u8BA4\u5E7F\u544A\u5DF2\u6E05\u9664\uFF09\uFF0C\u4F20 visibleOnly:true\uFF0C\u5E76\u7528 checkTexts \u6838\u67E5\u5173\u952E\u8BCD \u2014\u2014 \u5B83\u5206\u522B\u7ED9\u51FA\u300C\u53EF\u89C1\u6B21\u6570\u300D\u4E0E\u300CDOM \u6B21\u6570\u300D\u3002",
      parameters: {
        type: "object",
        properties: {
          visibleOnly: {
            type: "boolean",
            description: "\u53EA\u8FD4\u56DE\u6309\u53EF\u89C1\u6027\u8FC7\u6EE4\u540E\u7684\u6587\u672C\uFF08\u6392\u9664 display:none / visibility:hidden / opacity:0 \u7684\u5185\u5BB9\uFF0C\u5E76\u7A7F\u900F\u5F00\u653E shadow root\uFF09\u3002\u9ED8\u8BA4 false\u3002"
          },
          checkTexts: {
            type: "array",
            items: { type: "string" },
            description: "\u8981\u6838\u67E5\u53EF\u89C1\u6027\u7684\u5173\u952E\u8BCD\uFF08\u6700\u591A 20 \u4E2A\uFF09\u3002\u8FD4\u56DE\u6BCF\u4E2A\u8BCD\u7684\u300C\u53EF\u89C1\u6B21\u6570 / DOM \u6B21\u6570\u300D\uFF1A\u53EF\u89C1 0 \u6B21\u800C DOM \u6B21\u6570 > 0\uFF0C\u8BF4\u660E\u5B83\u4ECD\u5728 DOM \u91CC\u4F46\u5DF2\u4E0D\u53EF\u89C1\u3002\u5224\u65AD\u300C\u5E7F\u544A\u662F\u5426\u6E05\u5E72\u51C0\u300D\u5E94\u5F53\u7528\u8FD9\u4E2A\uFF0C\u800C\u4E0D\u662F\u770B\u6B63\u6587\u91CC\u8FD8\u6709\u6CA1\u6709\u8FD9\u4E2A\u8BCD\u3002"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_page_snapshot",
      description: "\u8BFB\u53D6\u5F53\u524D\u7F51\u9875\u7684\u7ED3\u6784\u5316 DOM \u5FEB\u7167\uFF1AURL\u3001\u6807\u9898\u3001\u6B63\u6587\u6458\u8981\u3001\u53EF\u4EA4\u4E92\u5143\u7D20\u4E0E\u6EDA\u52A8\u72B6\u6001\u3002\u89C6\u53E3\u5185\u5143\u7D20\u4F18\u5148\u8FD4\u56DE\uFF1B\u6BCF\u4E2A\u5143\u7D20\u5E26\u7A33\u5B9A ref\u3001selector \u4E0E\u89C6\u53E3\u5750\u6807 center\uFF08\u5408\u6210\u70B9\u51FB\u65E0\u6548\u65F6\u53EF\u7528 click_at \u6309\u5750\u6807\u70B9\u51FB\uFF09\u3002\u9875\u9762\u64CD\u4F5C\u524D\u540E\u53EF\u7528\u5B83\u5224\u65AD\u52A8\u4F5C\u662F\u5426\u751F\u6548\u3002",
      parameters: {
        type: "object",
        properties: {
          maxElements: { type: "integer", description: "\u6700\u591A\u8FD4\u56DE\u591A\u5C11\u4E2A\u53EF\u4EA4\u4E92\u5143\u7D20\uFF0C\u9ED8\u8BA4 60\uFF0C\u6700\u5927 120" },
          maxText: { type: "integer", description: "\u6B63\u6587\u6458\u8981\u6700\u5927\u5B57\u7B26\u6570\uFF0C\u9ED8\u8BA4 4000\uFF0C\u6700\u5927 8000" },
          frameId: { type: "integer", description: "\u53EA\u8BFB\u53D6\u6307\u5B9A iframe \u7684\u5FEB\u7167\uFF08frameId \u6765\u81EA list_frames\uFF09\uFF1B\u5143\u7D20 ref \u4F1A\u81EA\u52A8\u5E26 f<frameId>: \u524D\u7F00" },
          includeFrames: { type: "boolean", description: "\u662F\u5426\u5408\u5E76\u6240\u6709\u5B50\u6846\u67B6\uFF08\u542B\u8DE8\u57DF iframe\uFF09\u7684\u53EF\u4EA4\u4E92\u5143\u7D20\uFF0C\u9ED8\u8BA4 false" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_frames",
      description: '\u5217\u51FA\u5F53\u524D\u9875\u9762\u5185\u7684\u6240\u6709\u6846\u67B6\uFF08\u542B\u8DE8\u57DF iframe\uFF09\u53CA\u5176 frameId / URL / \u6807\u9898\uFF0C\u7528\u4E8E\u5B9A\u4F4D\u9700\u8981\u64CD\u4F5C\u7684 iframe\u3002\u6CE8\u610F\u9002\u7528\u8FB9\u754C\uFF1A\u5982\u679C\u5143\u7D20\u300C\u67E5\u4E0D\u5230\u300D\u662F\u56E0\u4E3A\u5B83\u5728 **Shadow DOM**\uFF08\u5F88\u591A\u7AD9\u70B9\u7684\u5E7F\u544A\u5361\u3001\u63A8\u8350\u4F4D\u90FD\u662F Web Component\uFF09\uFF0C\u90A3\u4E0D\u662F frame \u95EE\u9898\uFF0C\u7528\u8FD9\u4E2A\u65B9\u6CD5\u6CA1\u6709\u5E2E\u52A9 \u2014\u2014 \u76F4\u63A5\u6539\u7528 annotate({op:"style"}) / inspect_element({op:"text"})\uFF08\u5B83\u4EEC\u4F1A\u7A7F\u900F\u5F00\u653E shadow root\uFF09\u3002',
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "undo_last_action",
      description: "\u64A4\u9500\u4E0A\u4E00\u6B65\u9875\u9762\u64CD\u4F5C\u3002\u4EC5\u8F93\u5165 / \u52FE\u9009 / \u9009\u62E9 / \u6539\u6837\u5F0F / \u6EDA\u52A8\u53EF\u64A4\u9500\uFF1B\u70B9\u51FB\u4E0E\u5BFC\u822A\u4E0D\u53EF\u64A4\u9500\u3002",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "macro",
      description: "\u628A\u5DF2\u9A8C\u8BC1\u7684\u591A\u6B65\u64CD\u4F5C\u56FA\u5316\u4E3A\u53EF\u590D\u7528\u7684\u300C\u5B8F\u300D\uFF08\u6309\u5F53\u524D\u7AD9\u70B9\uFF09\uFF0C\u96F6 token \u56DE\u653E\u3002\u6309 op \u9009\u62E9\u505A\u4EC0\u4E48\uFF1Asave \u2014\u2014 \u628A**\u5F53\u524D\u4EFB\u52A1\u4E2D\u5DF2\u6210\u529F\u6267\u884C**\u7684\u53EF\u91CD\u653E\u52A8\u4F5C\u4FDD\u5B58\u4E3A\u5B8F\uFF08\u9002\u5408\u7528\u6237\u8BF4\u300C\u8BB0\u4F4F\u8FD9\u4E2A\u6D41\u7A0B\u300D\u300C\u4EE5\u540E\u90FD\u8FD9\u4E48\u505A\u300D\uFF09\uFF1Blist \u2014\u2014 \u5217\u51FA\u672C\u7AD9\u70B9\u5DF2\u4FDD\u5B58\u7684\u5B8F\uFF1Brun \u2014\u2014 \u56DE\u653E\u67D0\u4E2A\u5B8F\uFF08\u6309\u4FDD\u5B58\u7684\u52A8\u4F5C\u5E8F\u5217\u9010\u6B65\u6267\u884C\uFF0C\u4E0D\u518D\u9010\u6761\u8D70\u6A21\u578B\uFF1B\u67D0\u6B65\u5931\u8D25\u4F1A\u505C\u5728\u8BE5\u6B65\u5E76\u62A5\u544A\uFF09\u3002op=save \u9700\u8981 name\uFF08\u81EA\u5DF1\u8D77\u4E00\u4E2A\u6613\u8BB0\u7684\u540D\u5B57\uFF0C\u56DE\u653E\u65F6\u8981\u7167\u6284\u5B83\uFF09\uFF1Bop=run \u9700\u8981 name \u4E14\u5FC5\u987B\u662F list \u7ED9\u51FA\u7684\u51C6\u786E\u503C\u3002",
      parameters: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["save", "list", "run"],
            description: "\u8981\u505A\u54EA\u79CD\u5B8F\u64CD\u4F5C\uFF1Asave \u4FDD\u5B58\u5F53\u524D\u6D41\u7A0B / list \u5217\u51FA\u5DF2\u4FDD\u5B58\u7684\u5B8F / run \u56DE\u653E\u67D0\u4E2A\u5B8F"
          },
          name: {
            type: "string",
            description: "op=save \u65F6\u662F**\u8981\u8D77\u7684\u5B8F\u540D**\uFF08\u5982\u300C\u767B\u5F55\u5E76\u7B7E\u5230\u300D\uFF1B\u4E0D\u8981\u7528\u300C\u6D41\u7A0B1\u300D\u8FD9\u7C7B\u65E0\u4FE1\u606F\u91CF\u7684\u540D\u5B57\uFF09\uFF1Bop=run \u65F6\u662F**\u8981\u56DE\u653E\u7684\u5B8F\u540D**\uFF08\u7167\u6284 list \u8F93\u51FA\u7684 name \u503C\uFF0C\u4E0D\u662F\u63CF\u8FF0\uFF09\u3002"
          },
          description: { type: "string", description: "op=save \u65F6\u53EF\u9009\uFF1A\u4E00\u53E5\u8BDD\u8BF4\u660E\u8BE5\u6D41\u7A0B" }
        },
        required: ["op"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "trust_site",
      description: "\u628A\u5F53\u524D\u7AD9\u70B9\u52A0\u5165\u4FE1\u4EFB\u5217\u8868\uFF1A\u8BE5\u7AD9\u70B9\u7684\u5199\u64CD\u4F5C\uFF08\u70B9\u51FB / \u8F93\u5165 / \u6539\u6837\u5F0F\u7B49\uFF09\u4E0D\u518D\u9010\u6B21\u786E\u8BA4\u3002\u4EC5\u5728\u7528\u6237\u660E\u786E\u8981\u6C42\u300C\u4FE1\u4EFB\u8FD9\u4E2A\u7F51\u7AD9 / \u4EE5\u540E\u522B\u518D\u95EE\u6211\u300D\u65F6\u4F7F\u7528\u3002",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "update_plan",
      description: "\u7EF4\u62A4\u5F53\u524D\u4EFB\u52A1\u7684\u6267\u884C\u8BA1\u5212\uFF08\u5B50\u76EE\u6807\u6E05\u5355\uFF09\u3002\u591A\u6B65\u4EFB\u52A1\u5F00\u59CB\u65F6\u5148\u5217\u51FA\u8BA1\u5212\uFF0C\u4E4B\u540E\u6BCF\u5B8C\u6210\u4E00\u6B65\u5C31\u66F4\u65B0\u72B6\u6001\u3002\u65E2\u8BA9\u7528\u6237\u770B\u5230\u8FDB\u5EA6\uFF0C\u4E5F\u5E2E\u52A9\u4F60\u81EA\u5DF1\u4E0D\u8DD1\u4E22\u76EE\u6807\u3002\u6BCF\u6B21\u4F20\u5165\u5B8C\u6574\u5217\u8868\uFF08\u6574\u4F53\u66FF\u6362\uFF0C\u4E0D\u662F\u589E\u91CF\uFF09\u3002",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "\u5B8C\u6574\u7684\u8BA1\u5212\u5217\u8868",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "\u6309\u6587\u672C\u7247\u6BB5\u5B9A\u4F4D" },
                status: { type: "string", enum: ["pending", "in_progress", "done"], description: "\u72B6\u6001\uFF0C\u9ED8\u8BA4 pending" }
              },
              required: ["text"]
            }
          }
        },
        required: ["items"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "handle_dialog",
      description: "\u5904\u7406\u5F53\u524D\u9875\u9762\u7684 JavaScript \u5BF9\u8BDD\u6846\uFF08alert / confirm / prompt\uFF09\u3002\u8FD9\u7C7B\u5BF9\u8BDD\u6846\u4F1A\u963B\u585E\u9875\u9762\u4E0E\u540E\u7EED\u64CD\u4F5C\uFF1B\u82E5 get_page_snapshot \u63D0\u793A\u6709\u672A\u5904\u7406\u5BF9\u8BDD\u6846\uFF0C\u5E94\u5148\u8C03\u7528\u672C\u5DE5\u5177\uFF0C**\u4E0D\u8981\u91CD\u590D\u70B9\u51FB**\u89E6\u53D1\u5B83\u7684\u6309\u94AE\uFF08\u53EA\u4F1A\u8BA9\u5BF9\u8BDD\u6846\u53E0\u52A0\uFF09\u3002",
      parameters: {
        type: "object",
        properties: {
          accept: { type: "boolean", description: "true=\u786E\u5B9A/\u63A5\u53D7\uFF0Cfalse=\u53D6\u6D88\uFF0C\u9ED8\u8BA4 true" },
          promptText: {
            type: "string",
            description: "prompt \u5BF9\u8BDD\u6846\u8981\u586B\u5165\u7684\u6587\u672C\u3002**\u4E0D\u4F20\u5C31\u539F\u6837\u63A5\u53D7\u9ED8\u8BA4\u503C** \u2014\u2014 \u76EE\u6807\u503C\u4E0E\u9ED8\u8BA4\u503C\u4E0D\u540C\u65F6\u5FC5\u987B\u663E\u5F0F\u4F20\u5B83\u3002"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_run_trace",
      description: "\u8BFB\u53D6\u7ED3\u6784\u5316\u8FD0\u884C\u8F68\u8FF9\uFF08\u6BCF\u6B65\u7684\u5DE5\u5177\u3001\u53C2\u6570\u3001\u72B6\u6001\u3001\u8017\u65F6\u3001token\uFF09\uFF0C\u7528\u4E8E\u6392\u969C\u4E0E\u590D\u76D8\u3002\u4E0D\u4F20 runId \u65F6\u8FD4\u56DE\u6700\u8FD1\u4E00\u6B21\u8FD0\u884C\u3002",
      parameters: {
        type: "object",
        properties: { runId: { type: "string", description: "\u8FD0\u884C id\uFF08\u53EF\u9009\uFF09" } }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "expand_result",
      description: "\u5206\u6BB5\u8BFB\u53D6\u88AB\u622A\u65AD\u7684\u5DE5\u5177\u7ED3\u679C\u5168\u6587\uFF08\u5927\u7ED3\u679C\u53EA\u56DE\u4F20\u4E86\u5F00\u5934\uFF0C\u4F1A\u7ED9\u51FA\u4E00\u4E2A id\uFF09\u3002\u7528 offset/limit \u7FFB\u9875\u67E5\u770B\u5B8C\u6574\u5185\u5BB9\u3002",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "\u5DE5\u5177\u7ED3\u679C id\uFF08\u622A\u65AD\u63D0\u793A\u91CC\u7ED9\u51FA\u7684 id\uFF09" },
          offset: { type: "integer", description: "\u8D77\u59CB\u5B57\u7B26\u504F\u79FB\uFF0C\u9ED8\u8BA4 0" },
          limit: { type: "integer", description: "\u8BFB\u53D6\u957F\u5EA6\uFF0C\u9ED8\u8BA4 2000\uFF0C\u6700\u5927 4000" }
        },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_diagnostics",
      description: "\u8BFB\u53D6\u5F53\u524D\u9875\u9762\u7684\u8FD0\u884C\u671F\u4E8B\u5B9E\uFF0C\u7528\u4E8E\u524D\u7AEF\u8C03\u8BD5\u3002\u6309 kind \u9009\u62E9\u8BFB\u4EC0\u4E48\uFF1Aconsole \u2014\u2014 \u6700\u8FD1\u7684 console \u8F93\u51FA\uFF08error/warn/log/info\uFF09\u4E0E\u672A\u6355\u83B7\u5F02\u5E38\uFF1Bnetwork \u2014\u2014 \u6700\u8FD1\u7684\u7F51\u7EDC\u8BF7\u6C42\uFF08fetch/XHR \u7684 URL\u3001\u65B9\u6CD5\u3001\u72B6\u6001\u7801\u3001\u8017\u65F6\u3001\u9519\u8BEF\u3001\u53D1\u8D77\u4F4D\u7F6E\uFF09\uFF1Bdownloads \u2014\u2014 \u672C\u4EFB\u52A1\u4E2D\u9875\u9762\u89E6\u53D1\u7684\u4E0B\u8F7D\uFF08\u6587\u4EF6\u540D + URL\uFF09\u3002kind \u5FC5\u586B\uFF1A\u4E0D\u8981\u9760\u731C\uFF0C\u60F3\u770B\u54EA\u4E00\u7C7B\u5C31\u4F20\u54EA\u4E00\u7C7B\u3002",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["console", "network", "downloads"],
            description: "\u8981\u8BFB\u53D6\u7684\u4E8B\u5B9E\u7C7B\u522B\uFF1Aconsole / network / downloads"
          },
          level: { type: "string", description: "kind=console \u65F6\u751F\u6548\uFF1A\u8FC7\u6EE4\u7EA7\u522B error / warn / log / info\uFF1B\u4E0D\u586B\u8FD4\u56DE\u5168\u90E8" },
          filter: { type: "string", description: "kind=network \u65F6\u751F\u6548\uFF1A\u6309 URL \u5B50\u4E32\u8FC7\u6EE4" },
          limit: { type: "integer", description: "kind=console/network \u65F6\u751F\u6548\uFF1A\u8FD4\u56DE\u6761\u6570\u4E0A\u9650\uFF0C\u9ED8\u8BA4 50\uFF0C\u6700\u5927 200" }
        },
        required: ["kind"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_element_source",
      description: "\u628A\u4E00\u4E2A DOM \u5143\u7D20\u89E3\u6790\u5230\u5B83\u7684\u6846\u67B6\u6E90\u7801\u4F4D\u7F6E\uFF08React / Vue / Svelte \u5F00\u53D1\u6784\u5EFA\uFF09\uFF1A\u8FD4\u56DE file/line/column \u4E0E\u7EC4\u4EF6\u540D\u3002\u7528\u4E8E\u628A\u9875\u9762\u4E0A\u7684\u5143\u7D20\u5BF9\u5E94\u5230\u5177\u4F53\u6E90\u7801\u6587\u4EF6\uFF0C\u4F9B\u4FEE\u590D\u4EE3\u7801\u3002",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "\u5FEB\u7167\u4E2D\u7684\u5143\u7D20\u5F15\u7528\uFF08\u5982 rf-3\uFF09\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8" },
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7A7F\u900F\u5F00\u653E shadow root" },
          text: { type: "string", description: "\u6309\u6587\u672C\u7247\u6BB5\u5B9A\u4F4D" },
          index: { type: "integer", description: "\u547D\u4E2D\u7B2C\u51E0\u4E2A\uFF08\u4ECE 0 \u5F00\u59CB\uFF09" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "\u5411\u5F53\u524D\u7F51\u9875\u7684 input\u3001textarea \u6216 contenteditable \u5143\u7D20\u8F93\u5165\u6587\u672C\u3002\u4F18\u5148\u4F7F\u7528 DOM \u5FEB\u7167\u4E2D\u7684 ref\uFF1B\u9ED8\u8BA4\u8FFD\u52A0\u6587\u672C\uFF0CclearFirst=true \u65F6\u5148\u6E05\u7A7A\u3002**value \u662F\u8981\u8F93\u5165\u7684\u6587\u672C\uFF0Ctext \u662F\u7528\u4E8E\u5B9A\u4F4D\u5143\u7D20\u7684\u6587\u672C\u7247\u6BB5\uFF08find by text\uFF09\uFF0C\u4E24\u8005\u8BED\u4E49\u4E0D\u540C\uFF0C\u4E0D\u8981\u6DF7\u7528\u3002** \u8F93\u5165\u540E\u56DE\u8BFB\uFF1B\u5BCC\u6587\u672C/\u591A\u884C\u81EA\u52A8\u964D\u7EA7\uFF1B\u4E0D\u4E00\u81F4\u65F6 ok:false\uFF08partial:true\uFF09\uFF0C\u4E0D\u8981\u5047\u8BBE\u5DF2\u5199\u5165\u3002",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string", description: "\u8981\u8F93\u5165\u7684\u6587\u672C\u5185\u5BB9\uFF08\u8D1F\u8F7D\uFF09\u3002\u4F20\u7A7A\u5B57\u7B26\u4E32\u8868\u793A\u53EA\u6E05\u7A7A\u3001\u4E0D\u8F93\u5165\u65B0\u5185\u5BB9\uFF08\u9700\u914D\u5408 clearFirst=true\uFF09\u3002" },
          ref: { type: "string", description: "\u5FEB\u7167\u4E2D\u7684\u5143\u7D20\u5F15\u7528\uFF08\u5982 rf-3\uFF09\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8" },
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7A7F\u900F\u5F00\u653E shadow root" },
          text: { type: "string", description: "\u6309\u6587\u672C\u7247\u6BB5\u5B9A\u4F4D\u76EE\u6807\u5143\u7D20\uFF08\u4E0D\u662F\u8F93\u5165\u5185\u5BB9\uFF09" },
          clearFirst: { type: "boolean", description: "\u662F\u5426\u5148\u6E05\u7A7A\u539F\u5185\u5BB9\uFF0C\u9ED8\u8BA4 false" },
          role: { type: "string", description: "ARIA role\uFF08\u5982 button/link\uFF09\uFF0C\u914D\u5408 name \u66F4\u7A33" },
          name: { type: "string", description: "\u53EF\u8BBF\u95EE\u540D\uFF08\u6309\u94AE\u6587\u5B57 / aria-label\uFF09\uFF0C\u914D\u5408 role" },
          testid: { type: "string", description: "data-testid / data-test-id / data-cy \u7B49\u6D4B\u8BD5\u5C5E\u6027\u503C" },
          index: { type: "integer", description: "\u547D\u4E2D\u7B2C\u51E0\u4E2A\uFF08\u4ECE 0 \u5F00\u59CB\uFF09" }
        },
        required: ["value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "press_key",
      description: "\u5411\u5F53\u524D\u7F51\u9875\u5143\u7D20\u6216\u5F53\u524D\u7126\u70B9\u6D3E\u53D1\u952E\u76D8\u6309\u952E\uFF0C\u4F8B\u5982 Enter\u3001Tab\u3001Escape \u6216 Ctrl+A\u3002",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "\u5FEB\u7167\u4E2D\u7684\u5143\u7D20\u5F15\u7528\uFF08\u5982 rf-3\uFF09\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8" },
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7A7F\u900F\u5F00\u653E shadow root" },
          key: { type: "string", description: "\u6309\u952E\u540D\u79F0\u6216\u5355\u5B57\u7B26\uFF0C\u5982 Enter\u3001Tab\u3001a" },
          modifiers: { type: "array", items: { type: "string", enum: ["CTRL", "ALT", "SHIFT", "META"] }, description: "\u4FEE\u9970\u952E\u5217\u8868" },
          role: { type: "string", description: "ARIA role\uFF08\u5982 button/link\uFF09\uFF0C\u914D\u5408 name \u66F4\u7A33" },
          name: { type: "string", description: "\u53EF\u8BBF\u95EE\u540D\uFF08\u6309\u94AE\u6587\u5B57 / aria-label\uFF09\uFF0C\u914D\u5408 role" },
          testid: { type: "string", description: "data-testid / data-test-id / data-cy \u7B49\u6D4B\u8BD5\u5C5E\u6027\u503C" },
          index: { type: "integer", description: "\u547D\u4E2D\u7B2C\u51E0\u4E2A\uFF08\u4ECE 0 \u5F00\u59CB\uFF09" }
        },
        required: ["key"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "select_option",
      description: "\u64CD\u4F5C select \u4E0B\u62C9\u6846\u3002\u53EF\u6309 option \u7684 value\u3001label \u6216 index \u9009\u62E9\u3002",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "\u5FEB\u7167\u4E2D\u7684\u5143\u7D20\u5F15\u7528\uFF08\u5982 rf-3\uFF09\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8" },
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7A7F\u900F\u5F00\u653E shadow root" },
          value: { type: "string", description: "option.value" },
          label: { type: "string", description: "option \u663E\u793A\u6587\u672C" },
          index: { type: "integer", description: "\u547D\u4E2D\u7B2C\u51E0\u4E2A\uFF08\u4ECE 0 \u5F00\u59CB\uFF09" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_box",
      description: "\u52FE\u9009\u6216\u53D6\u6D88 checkbox\uFF1Bradio \u53EA\u80FD\u5207\u6362\u4E3A checked=true\u3002\u53EF\u7528 ref/selector \u5B9A\u4F4D\u5143\u7D20\uFF0C\u6216\u7528 text \u6309\u5173\u8054\u7684 label \u6587\u672C\u5B9A\u4F4D\u3002",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "\u5FEB\u7167\u4E2D\u7684\u5143\u7D20\u5F15\u7528\uFF08\u5982 rf-3\uFF09\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8" },
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7A7F\u900F\u5F00\u653E shadow root" },
          text: { type: "string", description: "\u6309\u6587\u672C\u7247\u6BB5\u5B9A\u4F4D" },
          checked: { type: "boolean", description: "\u76EE\u6807\u72B6\u6001" },
          role: { type: "string", description: "ARIA role\uFF08\u5982 button/link\uFF09\uFF0C\u914D\u5408 name \u66F4\u7A33" },
          name: { type: "string", description: "\u53EF\u8BBF\u95EE\u540D\uFF08\u6309\u94AE\u6587\u5B57 / aria-label\uFF09\uFF0C\u914D\u5408 role" },
          testid: { type: "string", description: "data-testid / data-test-id / data-cy \u7B49\u6D4B\u8BD5\u5C5E\u6027\u503C" },
          index: { type: "integer", description: "\u547D\u4E2D\u7B2C\u51E0\u4E2A\uFF08\u4ECE 0 \u5F00\u59CB\uFF09" }
        },
        required: ["checked"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "wait_for_element",
      description: "\u7B49\u5F85\u9875\u9762\u5143\u7D20\u6EE1\u8DB3\u6761\u4EF6\uFF0C\u9002\u5408\u5F02\u6B65\u6E32\u67D3\u3001\u7FFB\u9875\u52A0\u8F7D\u548C\u9875\u9762\u8DF3\u8F6C\u3002state \u652F\u6301 attached(\u6302\u8F7D)\u3001visible(\u53EF\u89C1)\u3001enabled(\u53EF\u7528)\u3001text_contains(\u5305\u542B\u6587\u672C)\u3001count(\u5339\u914D\u6570\u91CF\u8FBE\u5230 count)\u3001detached(\u5143\u7D20\u6D88\u5931)\u3001url_contains(URL \u5305\u542B text)\u3002",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "\u5FEB\u7167\u4E2D\u7684\u5143\u7D20\u5F15\u7528\uFF08\u5982 rf-3\uFF09\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8" },
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7A7F\u900F\u5F00\u653E shadow root" },
          text: { type: "string", description: "\u6309\u6587\u672C\u7247\u6BB5\u5B9A\u4F4D" },
          state: {
            type: "string",
            enum: ["attached", "visible", "enabled", "text_contains", "count", "detached", "url_contains"],
            description: "\u7B49\u5F85\u6761\u4EF6\uFF0C\u9ED8\u8BA4 visible"
          },
          count: { type: "integer", description: "state=count \u65F6\u7684\u76EE\u6807\u5339\u914D\u6570\u91CF\uFF0C\u9ED8\u8BA4 1" },
          timeoutMs: { type: "integer", description: "\u6700\u957F\u7B49\u5F85\u65F6\u95F4\uFF0C\u9ED8\u8BA4 8000\uFF0C\u6700\u5927 15000" },
          pollMs: { type: "integer", description: "\u8F6E\u8BE2\u95F4\u9694\uFF0C\u9ED8\u8BA4 100" },
          role: { type: "string", description: "ARIA role\uFF08\u5982 button/link\uFF09\uFF0C\u914D\u5408 name \u66F4\u7A33" },
          name: { type: "string", description: "\u53EF\u8BBF\u95EE\u540D\uFF08\u6309\u94AE\u6587\u5B57 / aria-label\uFF09\uFF0C\u914D\u5408 role" },
          testid: { type: "string", description: "data-testid / data-test-id / data-cy \u7B49\u6D4B\u8BD5\u5C5E\u6027\u503C" },
          index: { type: "integer", description: "\u547D\u4E2D\u7B2C\u51E0\u4E2A\uFF08\u4ECE 0 \u5F00\u59CB\uFF09" },
          frameId: { type: "integer", description: "\u5728\u6307\u5B9A iframe\uFF08\u542B\u8DE8\u57DF\uFF09\u4E2D\u7B49\u5F85\uFF1BframeId \u6765\u81EA list_frames\uFF0C\u9ED8\u8BA4\u4E3B\u6846\u67B6" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_attribute",
      description: "\u8BFB\u53D6\u9875\u9762\u5143\u7D20\u7684 HTML \u5C5E\u6027\uFF0C\u4F8B\u5982 disabled\u3001aria-expanded\u3001href\u3001data-state\u3002\u5BC6\u7801\u5B57\u6BB5\u4E0D\u4F1A\u8FD4\u56DE\u5B9E\u9645\u503C\u3002",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "\u5FEB\u7167\u4E2D\u7684\u5143\u7D20\u5F15\u7528\uFF08\u5982 rf-3\uFF09\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8" },
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7A7F\u900F\u5F00\u653E shadow root" },
          text: { type: "string", description: "\u6309\u6587\u672C\u7247\u6BB5\u5B9A\u4F4D" },
          attribute: { type: "string", description: "\u5C5E\u6027\u540D\uFF0C\u5982 aria-expanded\u3001href\u3001disabled" },
          role: { type: "string", description: "ARIA role\uFF08\u5982 button/link\uFF09\uFF0C\u914D\u5408 name \u66F4\u7A33" },
          name: { type: "string", description: "\u53EF\u8BBF\u95EE\u540D\uFF08\u6309\u94AE\u6587\u5B57 / aria-label\uFF09\uFF0C\u914D\u5408 role" },
          testid: { type: "string", description: "data-testid / data-test-id / data-cy \u7B49\u6D4B\u8BD5\u5C5E\u6027\u503C" },
          index: { type: "integer", description: "\u547D\u4E2D\u7B2C\u51E0\u4E2A\uFF08\u4ECE 0 \u5F00\u59CB\uFF09" }
        },
        required: ["attribute"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_tabs",
      description: "\u5217\u51FA\u5F53\u524D\u6D4F\u89C8\u5668\u7A97\u53E3\u5DF2\u6253\u5F00\u7684\u6807\u7B7E\u9875\uFF08\u6807\u9898\u4E0E URL\uFF09\uFF0C\u7528\u4E8E\u5B9A\u4F4D\u7528\u6237\u6B63\u5728\u770B\u7684\u8D44\u6599\u3002",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "switch_tab",
      description: "\u5207\u6362\u5F53\u524D Agent \u540E\u7EED\u64CD\u4F5C\u8981\u63A7\u5236\u7684\u6807\u7B7E\u9875\u3002\u4F18\u5148\u5728\u5F53\u524D\u9875\u5B8C\u6210\uFF1B\u53EA\u6709\u7F3A\u6570\u636E\u65F6\u624D\u5207\u6362\u3002\u4E0D\u8981\u4E3A\u9A8C\u8BC1/\u5BF9\u6BD4\u53CD\u590D A\u2192B\u2192A\uFF1B\u5207\u6362\u5230\u5F53\u524D\u5DF2\u7ED1\u5B9A\u9875\u662F no-op\uFF0C\u8FBE\u5230\u672C\u4EFB\u52A1\u4E0A\u9650\u540E\u4F1A\u88AB\u62D2\u7EDD\u3002",
      parameters: {
        type: "object",
        properties: {
          tabId: { type: "integer", description: "\u76EE\u6807\u6807\u7B7E\u9875 ID" }
        },
        required: ["tabId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_tab",
      description: "\u6253\u5F00\u4E00\u4E2A URL \u5E76\u81EA\u52A8\u628A\u540E\u7EED DOM \u64CD\u4F5C\u7ED1\u5B9A\u5230\u8BE5\u6807\u7B7E\u9875\u3002\u9ED8\u8BA4\u590D\u7528\u5DF2\u6253\u5F00\u7684\u540C URL \u6807\u7B7E\u9875\uFF0C\u5DF2\u5728\u524D\u53F0\u7684\u590D\u7528\u9875\u4E0D\u4F1A\u518D\u6B21\u6FC0\u6D3B\u3002\u4F18\u5148\u7559\u5728\u5F53\u524D\u9875\uFF1B\u4E0D\u8981\u4E3A\u9A8C\u8BC1/\u5BF9\u6BD4\u53CD\u590D\u5F00\u9875\u6216\u6765\u56DE\u5207\u6362\uFF0C\u53EA\u6709 newTab=true \u65F6\u624D\u5F3A\u5236\u65B0\u5EFA\u3002",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "\u8981\u6253\u5F00\u7684\u94FE\u63A5" },
          newTab: { type: "boolean", description: "\u662F\u5426\u5F3A\u5236\u65B0\u5EFA\u6807\u7B7E\u9875\uFF0C\u9ED8\u8BA4 false\uFF08\u4F18\u5148\u590D\u7528\u5DF2\u6253\u5F00\u7684\u540C URL \u6807\u7B7E\u9875\uFF0C\u907F\u514D\u8D8A\u5F00\u8D8A\u591A\uFF09" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fetch_webpage",
      description: "\u6293\u53D6\u5E76\u63D0\u53D6\u4EFB\u610F\u516C\u5F00\u7F51\u9875\u7684\u6B63\u6587\u6587\u672C\uFF08\u7B80\u6613\u722C\u866B\uFF09\u3002\u7528\u4E8E\u83B7\u53D6\u77E5\u8BC6\u5E93\u6216\u5F53\u524D\u9875\u4E4B\u5916\u7684\u5916\u90E8\u8D44\u6599\u3002\u6CE8\u610F\uFF1A\u76EE\u6807\u7AD9\u70B9\u9700\u5728\u63D2\u4EF6 host_permissions \u4E2D\u6388\u6743\u3002",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "\u76EE\u6807\u7F51\u9875 URL" } },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "\u5728\u7F51\u7EDC\u4E0A\u641C\u7D22\u5173\u952E\u8BCD\u5E76\u8FD4\u56DE\u7ED3\u679C\u5217\u8868\uFF08\u6807\u9898 + \u94FE\u63A5 + \u6458\u8981\uFF09\u3002\u7528\u4E8E\u627E\u5B98\u65B9\u6587\u6863\u3001\u6700\u65B0\u8D44\u6599\u3001\u6B63\u786E\u7684\u6765\u6E90 URL \u7B49\uFF1B\u627E\u5230\u76EE\u6807\u540E\u518D\u7528 fetch_webpage \u6216 open_tab \u8BFB\u53D6\u5185\u5BB9\uFF0C\u4E0D\u8981\u51ED\u7A7A\u731C\u6D4B URL\u3002",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "\u641C\u7D22\u5173\u952E\u8BCD" },
          maxResults: { type: "integer", description: "\u8FD4\u56DE\u6761\u6570\u4E0A\u9650\uFF0C\u9ED8\u8BA4 6\uFF0C\u6700\u591A 10" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "click_element",
      description: "\u70B9\u51FB\u9875\u9762\u5143\u7D20\u3002\u4F1A\u5148\u6EDA\u52A8\u5230\u76EE\u6807\u3001\u7B49\u5F85\u5176\u53EF\u89C1\u53EF\u7528\u5E76\u68C0\u6D4B\u906E\u6321\uFF0C\u518D\u6D3E\u53D1\u5B8C\u6574\u7684\u6307\u9488/\u9F20\u6807\u4E8B\u4EF6\u5E8F\u5217\u3002\u652F\u6301 DOM \u5FEB\u7167 ref\u3001CSS selector\u3001\u6587\u672C text \u5B9A\u4F4D\uFF0C\u91CD\u590D\u7ED3\u6784\u7528 index \u9009\u62E9\u7B2C N \u4E2A\u3002",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "\u5FEB\u7167\u4E2D\u7684\u5143\u7D20\u5F15\u7528\uFF08\u5982 rf-3\uFF09\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8" },
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7A7F\u900F\u5F00\u653E shadow root" },
          text: { type: "string", description: "\u6309\u6587\u672C\u7247\u6BB5\u5B9A\u4F4D" },
          role: { type: "string", description: "ARIA role\uFF08\u5982 button/link\uFF09\uFF0C\u914D\u5408 name \u66F4\u7A33" },
          name: { type: "string", description: "\u53EF\u8BBF\u95EE\u540D\uFF08\u6309\u94AE\u6587\u5B57 / aria-label\uFF09\uFF0C\u914D\u5408 role" },
          testid: { type: "string", description: "data-testid / data-test-id / data-cy \u7B49\u6D4B\u8BD5\u5C5E\u6027\u503C" },
          index: { type: "integer", description: "\u547D\u4E2D\u7B2C\u51E0\u4E2A\uFF08\u4ECE 0 \u5F00\u59CB\uFF09" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "inspect_element",
      description: "\u4FA6\u67E5\u5143\u7D20\uFF08\u53EA\u8BFB\uFF09\u3002op\uFF1Ainspect \u7ED3\u6784 / text \u6587\u672C / styles \u8BA1\u7B97\u6837\u5F0F / table \u8868\u683C / options \u4E0B\u62C9\u9009\u9879 / query \u5019\u9009\u67E5\u8BE2\u3002inspect \u8FD4\u56DE count\uFF08\u771F\u5B9E\u547D\u4E2D\u6570\uFF0Cmatches \u6700\u591A 8 \u6761\uFF09\u3001visibleCount\u3001selector/visible/shadowDepth/\u5C3A\u5BF8/\u7956\u5148\u94FE\uFF1Bcount \u4E3A\u51C6\uFF0C\u4E0D\u8981\u7528 matches.length\u3002query \u6309 selector/text/role+name/testid \u8FD4\u56DE\u5019\u9009\u7684 ref/rect/center/role/name/customElement/shadowDepth\uFF1Bref \u53EF\u76F4\u63A5\u7528\u4E8E\u540E\u7EED\u52A8\u4F5C\uFF0C\u66FF\u4EE3\u63A2\u7D22\u6027 run_javascript\u3002styles \u7528\u4E8E\u9A8C\u8BC1\u6837\u5F0F\u771F\u7684\u751F\u6548\uFF08!important/\u975E\u6CD5\u503C\u4F1A\u8BA9\u201C\u5DF2\u4FEE\u6539\u201D\u5047\u6210\u529F\uFF09\u3002table \u4F1A\u6B63\u786E\u5C55\u5F00 rowspan/colspan\uFF1B\u9009\u9879\u6E05\u5355\u7528 options\u3002",
      parameters: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["inspect", "text", "table", "styles", "options", "query"],
            description: "\u770B\u4EC0\u4E48\uFF1Ainspect \u7ED3\u6784 / text \u6587\u672C / styles \u8BA1\u7B97\u6837\u5F0F / table \u8868\u683C / options \u4E0B\u62C9\u6846 / query \u7ED3\u6784\u5316\u5019\u9009\u67E5\u8BE2"
          },
          // --- 定位（三种 op 通用）---
          ref: { type: "string", description: "\u5FEB\u7167\u4E2D\u7684\u5143\u7D20\u5F15\u7528\uFF08\u5982 rf-3\uFF09\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8" },
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7A7F\u900F\u5F00\u653E shadow root" },
          text: { type: "string", description: "\u6309\u6587\u672C\u7247\u6BB5\u5B9A\u4F4D\uFF08\u6CE8\u610F\uFF1A\u5B83\u662F**\u5B9A\u4F4D**\u7528\u7684\uFF0C\u4E0D\u662F op=text \u7684\u5F00\u5173\uFF09" },
          role: { type: "string", description: "ARIA role\uFF08\u5982 button/link\uFF09\uFF0C\u914D\u5408 name \u66F4\u7A33" },
          name: { type: "string", description: "\u53EF\u8BBF\u95EE\u540D\uFF08\u6309\u94AE\u6587\u5B57 / aria-label\uFF09\uFF0C\u914D\u5408 role" },
          testid: { type: "string", description: "data-testid / data-test-id / data-cy \u7B49\u6D4B\u8BD5\u5C5E\u6027\u503C" },
          index: { type: "integer", description: "\u547D\u4E2D\u7B2C\u51E0\u4E2A\uFF08\u4ECE 0 \u5F00\u59CB\uFF09\uFF1Bop=table \u6709\u591A\u4E2A\u8868\u683C\u65F6\u7528 index \u53D6\u7B2C N \u4E2A" },
          frameId: { type: "integer", description: "\u5728\u6307\u5B9A iframe\uFF08\u542B\u8DE8\u57DF\uFF09\u4E2D\u67E5\u8BE2\uFF1BframeId \u6765\u81EA list_frames\uFF0C\u9ED8\u8BA4\u4E3B\u6846\u67B6" },
          // --- 仅 op=table ---
          maxRows: { type: "integer", description: "op=table\uFF1A\u6700\u591A\u63D0\u53D6\u591A\u5C11\u884C\uFF0C\u9ED8\u8BA4 200" },
          maxCols: { type: "integer", description: "op=table\uFF1A\u6700\u591A\u63D0\u53D6\u591A\u5C11\u5217\uFF0C\u9ED8\u8BA4\u4E0D\u9650" },
          fillMerged: {
            type: "boolean",
            description: "op=table\uFF1A\u5408\u5E76\u5355\u5143\u683C\u7684\u5EF6\u7EED\u683C\u662F\u5426\u91CD\u590D\u586B\u5165\u540C\u4E00\u6587\u672C\uFF08\u9ED8\u8BA4 true\uFF0C\u4FBF\u4E8E\u6309\u5217\u8BFB\u53D6\uFF09\u3002\u8BBE false \u53EF\u4FDD\u7559\u300C\u6B64\u5904\u662F\u5408\u5E76\u5EF6\u7EED\u300D\u7684\u5FE0\u5B9E\u5F62\u6001\uFF08\u5EF6\u7EED\u683C\u4E3A\u7A7A\uFF09\u3002"
          },
          limit: { type: "integer", description: "op=query\uFF1A\u6700\u591A\u8FD4\u56DE\u591A\u5C11\u4E2A\u5019\u9009\uFF0C\u9ED8\u8BA4 20\uFF0C\u4E0A\u9650 50" },
          includeHidden: { type: "boolean", description: "op=query\uFF1A\u662F\u5426\u5305\u542B\u4E0D\u53EF\u89C1\u5143\u7D20\uFF0C\u9ED8\u8BA4 false" },
          // --- 仅 op=styles ---
          props: {
            type: "array",
            items: { type: "string" },
            description: "op=styles\uFF1A\u8981\u8BFB\u53D6\u7684 CSS \u5C5E\u6027\u540D\uFF08\u7528\u8FDE\u5B57\u7B26\u5199\u6CD5\uFF0C\u5982 font-size / line-height / max-width\uFF09\uFF0C\u6700\u591A 12 \u4E2A\u3002\u4E0D\u4F20\u5219\u8BFB\u4E00\u7EC4\u5E38\u7528\u5C5E\u6027\uFF1Afont-size / line-height / color / background-color / width / height / display / visibility / opacity / overflow-x / position / z-index\u3002"
          }
        },
        required: ["op"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "take_screenshot",
      description: "\u7ED9\u5F53\u524D\u9875\u9762\u622A\u56FE\uFF08\u53EA\u8BFB\uFF0C\u9700 CDP\uFF09\u3002" + // 视觉能力开关（单一来源 `VISION_ENABLED`）：**整句**二选一 ——
      // 关闭时那段与**引入开关之前逐字节相同**（纯重构 ⇒ 不需要测量 ✓）；
      // 打开时换成如实且不矛盾的启用分支 ✓
      // ⚠ 只条件化"你看不到图像"那半句是不够的：前半句「只展示给用户与留档」会与
      // 「同时也会送进你的上下文」自相矛盾 ✗（第 7 步审校实测复现）
      (VISION_ENABLED ? VISION_ENABLED_TOOL_COPY : "\u56FE\u7247**\u53EA\u5C55\u793A\u7ED9\u7528\u6237\u4E0E\u7559\u6863**\uFF0C" + VISION_UNAVAILABLE_TOOL_COPY) + "\u5B83\u7684\u4EF7\u503C\u662F\u7ED9\u7528\u6237\u53EF\u89C6\u8BC1\u636E\uFF08\u5982\u300C\u4FEE\u6539\u524D/\u540E\u300D\u5404\u62CD\u4E00\u5F20\uFF09\u3002\u9700\u8981\u53EF\u5224\u65AD\u7684\u6587\u672C\u8BC1\u636E\u8BF7\u7528 get_page_snapshot / inspect_element / read_diagnostics\u3002",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "\u8FD9\u5F20\u56FE\u7684\u7528\u9014\u8BF4\u660E\uFF0C\u5982\u300C\u4FEE\u6539\u524D\u300D\u300C\u4FEE\u6539\u540E\u300D\uFF0C\u4F1A\u663E\u793A\u5728\u56FE\u7247\u4E0B\u65B9" },
          fullPage: { type: "boolean", description: "\u662F\u5426\u6574\u9875\u622A\u56FE\uFF08\u9ED8\u8BA4 false \u53EA\u622A\u5F53\u524D\u89C6\u53E3\uFF1B\u6574\u9875\u53EF\u80FD\u5F88\u5927\u5E76\u89E6\u53D1\u81EA\u52A8\u964D\u8D28\uFF09" },
          format: { type: "string", enum: ["jpeg", "png"], description: "\u9ED8\u8BA4 jpeg\uFF08\u4F53\u79EF\u5C0F\uFF09\uFF1B\u9700\u8981\u65E0\u635F\u7EC6\u8282\u7528 png\uFF08\u8D85\u9650\u4F1A\u81EA\u52A8\u9000\u4E3A jpeg\uFF09" },
          quality: { type: "integer", description: "jpeg \u8D28\u91CF 20-100\uFF0C\u9ED8\u8BA4 72\u3002\u4F53\u79EF\u8D85\u9650\u65F6\u4F1A\u81EA\u52A8\u9010\u7EA7\u964D\u8D28\u91CD\u62CD" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "annotate",
      description: "\u5728\u9875\u9762\u4E0A\u505A\u89C6\u89C9\u6807\u6CE8\uFF08\u9AD8\u4EAE / \u63CF\u8FB9 / \u6539\u6837\u5F0F\u6216\u9690\u85CF / \u6E05\u9664\uFF09\uFF0C**\u90FD\u4E0D\u6539\u52A8\u9875\u9762 DOM**\uFF08\u753B\u5728\u72EC\u7ACB\u6D6E\u5C42\u4E0A\uFF09\u3002\u6309 op \u9009\u62E9\uFF1Ahighlight \u2014\u2014 \u9AD8\u4EAE\u6587\u672C\u7247\u6BB5\uFF1B\u9700\u8981\u9AD8\u4EAE\u591A\u5904\u65F6**\u4E00\u6B21\u8C03\u7528\u4F20 texts \u6570\u7EC4**\uFF0C\u4E0D\u8981\u9010\u6761\u591A\u6B21\u8C03\u7528\uFF08\u5355\u6B21\u6700\u591A " + HIGHLIGHT_MAX_TEXTS + " \u6761\uFF0C\u8D85\u51FA\u90E8\u5206\u4E0D\u4F1A\u88AB\u5904\u7406\uFF0C\u7ED3\u679C\u91CC\u4F1A\u660E\u786E\u544A\u77E5\u8FD8\u5269\u591A\u5C11\u6761\uFF09\uFF1Boutline \u2014\u2014 \u7528\u8FB9\u6846\u63CF\u8FB9\u6807\u6CE8\u76EE\u6807\u5143\u7D20\uFF0C\u4FBF\u4E8E\u5411\u7528\u6237\u6307\u51FA\u4F4D\u7F6E\uFF1Bstyle \u2014\u2014 \u4FEE\u6539\u5143\u7D20\u6837\u5F0F\uFF08\u5B57\u53F7/\u52A0\u7C97/\u989C\u8272/\u80CC\u666F\uFF09\u6216\u9690\u85CF\uFF08hide:true\uFF09\uFF1Bstyles \u7528\u9A7C\u5CF0 CSS \u5C5E\u6027\uFF1Bclear \u2014\u2014 \u6E05\u9664\u9875\u9762\u4E0A\u7684\u9AD8\u4EAE\u3001\u63CF\u8FB9\u548C\u4E34\u65F6\u6837\u5F0F\u3002\u5B9A\u4F4D\u652F\u6301 ref / role+name / testid / selector / text\uFF0C**\u7A7F\u900F\u5F00\u653E shadow root \u4E0E\u540C\u6E90 iframe**\uFF08\u9690\u85CF shadow \u5185\u7EC4\u4EF6\u5982 MSN \u7684 cs-card \u9760\u5B83\uFF0C\u522B\u624B\u5199 querySelectorAll\uFF09\u3002**\u6279\u91CF\u9690\u85CF\u7528 op=style + selectors \u6570\u7EC4\u4E00\u6B21\u4F20\u5B8C**\uFF08\u226420\uFF09\uFF0C\u4E0D\u8981\u9010\u4E2A\u8C03\u7528\u3002**\u9690\u85CF\u5E7F\u544A\u7528 op=style + hide:true\uFF0C\u800C\u4E0D\u662F\u5728 run_javascript \u91CC remove \u8282\u70B9** \u2014\u2014 \u79FB\u9664\u4F1A\u8BA9\u7AD9\u70B9\u81EA\u8EAB\u7684\u72B6\u6001\u8DDF\u8E2A\u5931\u51C6\uFF08\u65E0\u9650\u6EDA\u52A8\u3001\u5185\u5BB9\u53EF\u89C1\u6027\u3001\u5E7F\u544A SDK \u63A5\u8FDE\u62A5\u9519\uFF09\uFF0Cdisplay:none \u53EA\u5F71\u54CD\u5448\u73B0\u3002",
      parameters: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["highlight", "outline", "style", "clear"],
            description: "\u505A\u54EA\u79CD\u6807\u6CE8\uFF1Ahighlight \u9AD8\u4EAE\u6587\u672C / outline \u63CF\u8FB9\u5143\u7D20 / style \u6539\u6837\u5F0F\u6216\u9690\u85CF / clear \u6E05\u9664\u5168\u90E8\u6807\u6CE8"
          },
          // --- 定位（op=clear 之外都可用）---
          ref: { type: "string", description: "\u5FEB\u7167\u4E2D\u7684\u5143\u7D20\u5F15\u7528\uFF08\u5982 rf-3\uFF09\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8" },
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7A7F\u900F\u5F00\u653E shadow root" },
          selectors: {
            type: "array",
            items: { type: "string" },
            description: "op=style \u7684\u6279\u91CF\u6A21\u5F0F\uFF1A\u4E00\u6B21\u4F20\u5165\u591A\u4E2A CSS \u9009\u62E9\u5668\uFF08\u6700\u591A 20 \u4E2A\uFF09\uFF0C\u8FD4\u56DE\u805A\u5408\u7ED3\u679C\uFF08\u5DF2\u5904\u7406 N \u4E2A\u5143\u7D20\uFF1B\u672A\u547D\u4E2D\u7684\u9009\u62E9\u5668\u4F1A\u5217\u51FA\uFF09\u3002\u9690\u85CF\u591A\u4E2A\u5E7F\u544A\u4F4D\u65F6\u7528\u5B83\uFF0C\u907F\u514D\u9010\u6761\u8C03\u7528\u3002"
          },
          text: { type: "string", description: "\u6309\u6587\u672C\u7247\u6BB5\u5B9A\u4F4D" },
          role: { type: "string", description: "ARIA role\uFF08\u5982 button/link\uFF09\uFF0C\u914D\u5408 name \u66F4\u7A33" },
          name: { type: "string", description: "\u53EF\u8BBF\u95EE\u540D\uFF08\u6309\u94AE\u6587\u5B57 / aria-label\uFF09\uFF0C\u914D\u5408 role" },
          testid: { type: "string", description: "data-testid / data-test-id / data-cy \u7B49\u6D4B\u8BD5\u5C5E\u6027\u503C" },
          index: { type: "integer", description: "\u547D\u4E2D\u7B2C\u51E0\u4E2A\uFF08\u4ECE 0 \u5F00\u59CB\uFF09" },
          // --- 仅 op=highlight ---
          texts: {
            type: "array",
            items: { type: "string" },
            maxItems: HIGHLIGHT_MAX_TEXTS,
            description: "op=highlight\uFF1A\u8981\u9AD8\u4EAE\u7684\u591A\u4E2A\u6587\u672C\u7247\u6BB5\uFF08\u4E0E text/selector \u4E09\u9009\u4E00\uFF0C\u63A8\u8350\u6279\u91CF\uFF09\u3002\u6700\u591A " + HIGHLIGHT_MAX_TEXTS + " \u6761\uFF0C\u8D85\u51FA\u4F1A\u88AB\u622A\u65AD\u5E76\u544A\u77E5\u3002"
          },
          // --- 仅 op=style ---
          hide: {
            type: "boolean",
            description: 'op=style\uFF1Atrue = \u8BBE\u4E3A display:none \u9690\u85CF\uFF1Bfalse = \u8FD8\u539F display\u3002\u7B49\u4EF7\u4E8E styles:{"display":"none"}\uFF0C\u4F46\u66F4\u4E0D\u6613\u5199\u9519\u3002\u4E0E styles \u4E8C\u9009\u4E00\u5373\u53EF\u3002'
          },
          styles: { type: "object", description: 'op=style\uFF1A\u8981\u5E94\u7528\u7684\u6837\u5F0F\u5BF9\u8C61\uFF0C\u5982 {"fontSize":"36px","fontWeight":"bold","color":"#e60000"}\u3002\u4E0E hide \u4E8C\u9009\u4E00\u3002' },
          // --- 颜色 / 时长（不同 op 含义不同，已逐个写明）---
          color: {
            type: "string",
            description: "op=outline \u65F6\u662F**\u63CF\u8FB9\u989C\u8272**\uFF08\u9ED8\u8BA4 #ff5722\uFF09\uFF1Bop=highlight \u65F6\u662F**\u9AD8\u4EAE\u989C\u8272**\uFF0C\u5EFA\u8BAE rgba \u534A\u900F\u660E\uFF08\u5B9E\u8272\u4F1A\u81EA\u52A8\u8F6C\u4F4E\u900F\u660E\u5EA6\uFF0C\u907F\u514D\u76D6\u4F4F\u6587\u5B57\uFF09\u3002"
          },
          duration: {
            type: "integer",
            description: "\u4E34\u65F6\u6548\u679C\u6301\u7EED\u65F6\u957F(ms)\uFF1Aop=outline \u9ED8\u8BA4 1500\uFF1Bop=style \u4E0D\u586B\u5219\u4FDD\u7559\uFF08\u53EF\u7528 op=clear \u8FD8\u539F\uFF09\u3002"
          }
        },
        required: ["op"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scroll_page",
      description: "\u6EDA\u52A8\u9875\u9762\uFF0C\u652F\u6301\u4E09\u79CD\u65B9\u5F0F\uFF08\u4F18\u5148\u7EA7\u4ECE\u9AD8\u5230\u4F4E\uFF09\uFF1A\u6309\u76EE\u6807\u5B9A\u4F4D\uFF08ref/selector/text\uFF09\u6EDA\u52A8\u5230\u8BE5\u5904\u3001\u6309\u7EDD\u5BF9\u5750\u6807\uFF08top/left\uFF09\u3001\u6309\u504F\u79FB\uFF08y/x\uFF09\u3002",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "\u5FEB\u7167\u4E2D\u7684\u5143\u7D20\u5F15\u7528\uFF08\u5982 rf-3\uFF09\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8" },
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7A7F\u900F\u5F00\u653E shadow root" },
          text: { type: "string", description: "\u6309\u6587\u672C\u7247\u6BB5\u5B9A\u4F4D" },
          role: { type: "string", description: "ARIA role\uFF08\u5982 button/link\uFF09\uFF0C\u914D\u5408 name \u66F4\u7A33" },
          name: { type: "string", description: "\u53EF\u8BBF\u95EE\u540D\uFF08\u6309\u94AE\u6587\u5B57 / aria-label\uFF09\uFF0C\u914D\u5408 role" },
          testid: { type: "string", description: "data-testid / data-test-id / data-cy \u7B49\u6D4B\u8BD5\u5C5E\u6027\u503C" },
          index: { type: "integer", description: "\u547D\u4E2D\u7B2C\u51E0\u4E2A\uFF08\u4ECE 0 \u5F00\u59CB\uFF09" },
          top: { type: "number", description: "\u76EE\u6807\u7EB5\u5750\u6807(px)\uFF0C\u4E0E left \u914D\u5408\u6309\u7EDD\u5BF9\u5750\u6807\u6EDA\u52A8" },
          left: { type: "number", description: "\u76EE\u6807\u6A2A\u5750\u6807(px)\uFF0C\u4E0E top \u914D\u5408\u6309\u7EDD\u5BF9\u5750\u6807\u6EDA\u52A8" },
          y: { type: "number", description: "\u7EB5\u5411\u504F\u79FB(px)\uFF0C\u6B63\u6570\u5411\u4E0B\uFF1B\u4E0E ref/selector/text \u540C\u7528\u65F6\u6EDA\u8BE5\u5143\u7D20\u81EA\u8EAB\uFF0C\u5426\u5219\u6EDA\u7A97\u53E3" },
          x: { type: "number", description: "\u6A2A\u5411\u504F\u79FB(px)\uFF0C\u6B63\u6570\u5411\u53F3\uFF1B\u4E0E ref/selector/text \u540C\u7528\u65F6\u6EDA\u8BE5\u5143\u7D20\u81EA\u8EAB\uFF0C\u5426\u5219\u6EDA\u7A97\u53E3" },
          behavior: { type: "string", enum: ["auto", "smooth"], description: "\u6EDA\u52A8\u884C\u4E3A\uFF0C\u9ED8\u8BA4 smooth" },
          block: { type: "string", enum: ["start", "center", "end"], description: "\u6309\u76EE\u6807\u6EDA\u52A8\u65F6\u7684\u5BF9\u9F50\u65B9\u5F0F\uFF0C\u9ED8\u8BA4 start" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_javascript",
      description: '\u5728\u9875\u9762\u6267\u884C JS\uFF08\u9003\u751F\u8231\uFF09\uFF1A\u4EC5\u5F53\u5185\u7F6E\u5DE5\u5177\u65E0\u6CD5\u8868\u8FBE\u65F6\u624D\u7528\uFF0C\u5982\u6279\u91CF\u53D6\u503C\u3001\u8BFB\u6D4B\u91CF\u503C\u3001\u590D\u6742\u7EC4\u4EF6\u64CD\u4F5C\u3002**\u666E\u901A document.querySelectorAll \u7A7F\u4E0D\u8FC7 shadow \u8FB9\u754C**\uFF1A\u627E\u5143\u7D20/rect \u7528 inspect_element({op:"query"})\uFF0C\u67E5\u6587\u672C/\u6539\u6837\u5F0F\u7528 inspect_element({op:"text"}) / annotate({op:"style"})\uFF0C\u5426\u5219\u5BB9\u6613\u53CD\u590D\u8C03\u7528\u5374\u603B\u5DEE\u4E00\u70B9\u3002\u53D7\u9650\u4F5C\u7528\u57DF\uFF1A\u65E0 chrome.*\u3001\u6269\u5C55\u5B58\u50A8\u3001fetch/XHR\u3002\u6C99\u7BB1\u4F9D\u8D56 eval\uFF0C\u800C **MV3 \u6269\u5C55\u81EA\u8EAB\u7684 CSP \u4E0D\u5141\u8BB8**\uFF08\u4E0E\u9875\u9762\u65E0\u5173\uFF0C\u4EFB\u4F55\u9875\u9762\u90FD\u4E00\u6837\uFF09\uFF0C\u6545\u603B\u662F\u6539\u7528\u9875\u9762\u4E3B\u4E16\u754C \u2014\u2014 **\u9700\u8981\u5F00\u542F CDP**\u3002\u4EE3\u7801\u4F53\u7528 return \u8FD4\u56DE\uFF08\u53EF\u4E3A Promise\uFF09\uFF0C\u7ED3\u679C\u81EA\u52A8\u5E8F\u5217\u5316\u5E76\u622A\u65AD\uFF1B\u5BA1\u6279\u5F52\u5165\u300C\u9875\u9762\u547D\u4EE4\u300D\u7C7B\u522B\uFF08\u9ED8\u8BA4\u9700\u786E\u8BA4\uFF0C\u53EF\u5728\u81EA\u52A8\u6279\u51C6\u91CC\u653E\u5F00\uFF09\u3002\u82E5\u5F80\u9875\u9762\u6CE8\u5165\u4E86\u8C03\u8BD5\u8282\u70B9\uFF0C\u8BF7\u52A0 data-rf-injected \u5C5E\u6027\uFF08\u9875\u9762\u6587\u672C\u63D0\u53D6\u4F1A\u6392\u9664\u5B83\uFF0C\u907F\u514D\u6C61\u67D3\u8BC1\u636E\uFF09\u3002',
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "\u8981\u6267\u884C\u7684 JS \u4EE3\u7801\uFF08\u51FD\u6570\u4F53\uFF0C\u6700\u540E\u7528 return \u8FD4\u56DE\u7ED3\u679C\uFF09" },
          engine: {
            type: "string",
            enum: ["sandbox", "page"],
            description: "sandbox\uFF08\u9ED8\u8BA4\uFF09\uFF1A\u53D7\u9650\u4F5C\u7528\u57DF\uFF0C\u65E0 chrome.*\uFF0C\u4F46\u4F9D\u8D56 eval \u800C MV3 \u6269\u5C55 CSP \u4E0D\u5141\u8BB8\uFF08\u4E0E\u9875\u9762\u65E0\u5173\uFF09\uFF0C\u5B9E\u9645\u603B\u662F\u81EA\u52A8\u843D\u5230 page\uFF1Bpage\uFF1A\u9875\u9762\u4E3B\u4E16\u754C\uFF0C**\u9700 CDP**\uFF0C\u53EF\u8BFB\u9875\u9762\u81EA\u8EAB JS \u72B6\u6001\u3001\u4E0D\u53D7\u9875\u9762 CSP \u9650\u5236\u3002"
          },
          frameId: { type: "integer", description: "\u5728\u6307\u5B9A iframe\uFF08\u542B\u8DE8\u57DF\uFF09\u4E2D\u6267\u884C\uFF1BframeId \u6765\u81EA list_frames\uFF0C\u9ED8\u8BA4\u4E3B\u6846\u67B6" }
        },
        required: ["code"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "click_at",
      description: "\u6309\u89C6\u53E3\u5750\u6807 (x,y) \u7528 CDP \u6D3E\u53D1\u53EF\u4FE1\u9F20\u6807\u70B9\u51FB\u3002\u7528\u4E8E\u5408\u6210\u70B9\u51FB\u65E0\u6548\u7684\u987D\u56FA\u7AD9\u70B9\uFF0C\u6216 canvas/\u865A\u62DF\u5217\u8868/\u53EF\u8BBF\u95EE\u6027\u6811\u5FEB\u7167\u7ED9\u51FA\u7684\u5750\u6807\u3002",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "\u89C6\u53E3\u6A2A\u5750\u6807(px)" },
          y: { type: "number", description: "\u89C6\u53E3\u7EB5\u5750\u6807(px)" },
          double: { type: "boolean", description: "\u662F\u5426\u53CC\u51FB\uFF0C\u9ED8\u8BA4 false" },
          button: { type: "string", enum: ["left", "right", "middle"], description: "\u9F20\u6807\u6309\u952E\uFF0C\u9ED8\u8BA4 left" }
        },
        required: ["x", "y"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "hover_element",
      description: "\u628A\u9F20\u6807\u60AC\u505C\u5230\u5143\u7D20\u4E0A\uFF08CDP \u53EF\u4FE1\u79FB\u52A8\uFF09\uFF0C\u7528\u4E8E\u89E6\u53D1 hover \u624D\u51FA\u73B0\u7684\u83DC\u5355/\u63D0\u793A\u3002\u53EF\u7528 ref/selector/text \u5B9A\u4F4D\u3002",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "\u5FEB\u7167\u4E2D\u7684\u5143\u7D20\u5F15\u7528\uFF08\u5982 rf-3\uFF09\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8" },
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7A7F\u900F\u5F00\u653E shadow root" },
          text: { type: "string", description: "\u6309\u6587\u672C\u7247\u6BB5\u5B9A\u4F4D" },
          role: { type: "string", description: "ARIA role\uFF08\u5982 button/link\uFF09\uFF0C\u914D\u5408 name \u66F4\u7A33" },
          name: { type: "string", description: "\u53EF\u8BBF\u95EE\u540D\uFF08\u6309\u94AE\u6587\u5B57 / aria-label\uFF09\uFF0C\u914D\u5408 role" },
          testid: { type: "string", description: "data-testid / data-test-id / data-cy \u7B49\u6D4B\u8BD5\u5C5E\u6027\u503C" },
          index: { type: "integer", description: "\u547D\u4E2D\u7B2C\u51E0\u4E2A\uFF08\u4ECE 0 \u5F00\u59CB\uFF09" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "drag_element",
      description: "\u628A\u4E00\u4E2A\u5143\u7D20\u62D6\u62FD\u5230\u53E6\u4E00\u4E2A\u4F4D\u7F6E\uFF08CDP \u53EF\u4FE1\u62D6\u62FD\u5E8F\u5217\uFF09\u3002\u8D77\u70B9\u7528 from*\uFF0C\u7EC8\u70B9\u7528 to*\uFF08ref/selector/text \u4E09\u9009\u4E00\uFF09\u3002",
      parameters: {
        type: "object",
        properties: {
          fromRef: { type: "string", description: "\u8D77\u70B9\u5143\u7D20\u5F15\u7528" },
          fromSelector: { type: "string", description: "\u8D77\u70B9 CSS \u9009\u62E9\u5668" },
          fromText: { type: "string", description: "\u8D77\u70B9\u6587\u672C\u7247\u6BB5" },
          toRef: { type: "string", description: "\u7EC8\u70B9\u5143\u7D20\u5F15\u7528" },
          toSelector: { type: "string", description: "\u7EC8\u70B9 CSS \u9009\u62E9\u5668" },
          toText: { type: "string", description: "\u7EC8\u70B9\u6587\u672C\u7247\u6BB5" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "upload_file",
      description: "\u5411\u9875\u9762 file input \u8BBE\u7F6E\u672C\u5730\u6587\u4EF6\uFF08CDP\uFF09\u3002files \u4E3A\u672C\u5730\u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84\u6570\u7EC4\u3002\u9700\u7528\u6237\u6279\u51C6\u3002",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "\u5FEB\u7167\u4E2D\u7684\u5143\u7D20\u5F15\u7528\uFF08\u5982 rf-3\uFF09\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8" },
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7A7F\u900F\u5F00\u653E shadow root" },
          text: { type: "string", description: "\u6309\u6587\u672C\u7247\u6BB5\u5B9A\u4F4D" },
          files: { type: "array", items: { type: "string" }, description: "\u672C\u5730\u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84\u6570\u7EC4" }
        },
        required: ["files"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_ax_snapshot",
      description: "\u901A\u8FC7 CDP \u8BFB\u53D6\u9875\u9762\u7684\u53EF\u8BBF\u95EE\u6027\u6811\uFF08\u4EA4\u4E92\u8282\u70B9 role + \u540D\u79F0 + \u89C6\u53E3\u5750\u6807\uFF09\u3002\u9002\u5408 canvas\u3001\u865A\u62DF\u5217\u8868\u3001\u590D\u6742\u7EC4\u4EF6\u7B49 DOM \u6587\u672C\u5FEB\u7167\u770B\u4E0D\u6E05\u7684\u573A\u666F\uFF1B\u914D\u5408 click_at \u6309\u5750\u6807\u70B9\u51FB\u3002",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: "\u8FD4\u56DE\u8282\u70B9\u6570\u4E0A\u9650\uFF0C\u9ED8\u8BA4 60\uFF0C\u6700\u5927 120" } }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_userscripts",
      description: "\u5217\u51FA\u5DF2\u5B89\u88C5\u7684\u7528\u6237\u811A\u672C\uFF08\u540D\u79F0\u3001\u7248\u672C\u3001\u542F\u505C\u72B6\u6001\u3001\u5339\u914D\u7F51\u7AD9\uFF09\uFF0C\u7528\u4E8E\u5224\u65AD\u80FD\u5426\u590D\u7528\u811A\u672C\u80FD\u529B\u3002",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "search_userscripts",
      description: "\u5728 GreasyFork \u641C\u7D22\u7528\u6237\u811A\u672C\uFF0C\u7528\u4E8E\u5BFB\u627E\u53EF\u5B8C\u6210\u5F53\u524D\u9700\u6C42\uFF08\u4E0B\u8F7D\u3001\u5C55\u5F00\u5168\u6587\u3001\u53BB\u5E7F\u544A\u3001\u81EA\u52A8\u7B7E\u5230\u7B49\uFF09\u7684\u73B0\u6210\u811A\u672C\u3002",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "\u641C\u7D22\u5173\u952E\u8BCD\uFF0C\u5982 \u89C6\u9891\u4E0B\u8F7D bilibili\u3001\u5C55\u5F00\u5168\u6587\u3001\u53BB\u5E7F\u544A" } },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "install_userscript",
      description: "\u5B89\u88C5\u4E00\u4E2A\u7528\u6237\u811A\u672C\uFF08\u9700\u7528\u6237\u786E\u8BA4\uFF09\u3002url \u6765\u81EA search_userscripts \u7ED3\u679C\u7684 code_url \u6216\u7528\u6237\u63D0\u4F9B\u7684 .user.js \u94FE\u63A5\u3002",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "\u811A\u672C code_url \u6216 .user.js \u94FE\u63A5" } },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_userscript",
      description: "\u8BA9\u4E00\u4E2A\u5DF2\u5B89\u88C5\u7684\u7528\u6237\u811A\u672C\u5728\u5F53\u524D\u9875\u9762\u7ACB\u5373\u8FD0\u884C\uFF08\u4E0D\u8981\u6C42 URL \u5339\u914D\uFF09\uFF0C\u7528\u4E8E\u6309\u9700\u6267\u884C\u811A\u672C\u80FD\u529B\u3002scriptId \u6765\u81EA list_userscripts\u3002",
      parameters: {
        type: "object",
        properties: { scriptId: { type: "string", description: "\u5DF2\u5B89\u88C5\u811A\u672C\u7684 id\uFF08list_userscripts \u8FD4\u56DE\uFF09" } },
        required: ["scriptId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "\u58F0\u660E\u5F53\u524D\u7528\u6237\u4EFB\u52A1\u5DF2\u5B8C\u6210\u5E76\u7ED9\u51FA\u7B80\u77ED\u603B\u7ED3\u3002\u5F53\u76EE\u6807\u9875\u9762\u5DF2\u6253\u5F00\u3001\u5185\u5BB9\u5DF2\u7ED9\u51FA\u6216\u64CD\u4F5C\u5DF2\u5B8C\u6210\u540E\uFF0C\u7ACB\u5373\u8C03\u7528\u672C\u5DE5\u5177\u7ED3\u675F\u4EFB\u52A1\uFF1B\u4E0D\u8981\u5728\u5B8C\u6210\u540E\u7EE7\u7EED\u8C03\u7528\u5176\u4ED6\u5DE5\u5177\u3002",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "\u4E00\u53E5\u8BDD\u603B\u7ED3\u5B8C\u6210\u7ED3\u679C\uFF0C\u4F8B\u5982\u300C\u5DF2\u6253\u5F00\u300A\u51E1\u4EBA\u4FEE\u4ED9\u4F20\u300B\u8BE6\u60C5\u9875\u300D" },
          evidence: { type: "string", description: "\u53EF\u9009\uFF1A\u5B8C\u6210\u8BC1\u636E\uFF0C\u4F8B\u5982\u9875\u9762\u6807\u9898\u3001URL \u6216\u5173\u952E\u5185\u5BB9" }
        },
        required: ["summary"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description: "\u6309\u9700\u52A0\u8F7D\u4E00\u4E2A\u5DF2\u5B89\u88C5\u6280\u80FD\uFF08\u4E13\u5BB6\u624B\u518C\uFF09\u7684\u5B8C\u6574\u4F7F\u7528\u8BF4\u660E\u3002\u73AF\u5883\u5185\u7F6E\u82E5\u5E72\u6280\u80FD\uFF0C\u6BCF\u4E2A\u6280\u80FD\u6709\u552F\u4E00 name \u4E0E\u7528\u9014\u3002\u5F53\u4F60\u5224\u65AD\u7528\u6237\u4EFB\u52A1\u9002\u5408\u4F7F\u7528\u67D0\u4E2A\u6280\u80FD\u65F6\uFF0C\u5148\u8C03\u7528\u672C\u5DE5\u5177\u83B7\u53D6\u5176\u8BE6\u7EC6\u6307\u5BFC\uFF0C\u518D\u4E25\u683C\u9075\u5FAA\uFF1B\u4E0D\u8981\u51ED\u7A7A\u81C6\u6D4B\u6280\u80FD\u5185\u5BB9\u3002\u82E5\u4E0D\u786E\u5B9A\u53EF\u7528\u6280\u80FD\uFF0C\u67E5\u770B\u7CFB\u7EDF\u63D0\u793A\u4E2D\u7684\u6280\u80FD\u76EE\u5F55\u3002\u82E5\u6240\u9700\u6280\u80FD\u4E0D\u5728\u76EE\u5F55\u4E2D\uFF0C\u53EF\u5148\u8C03\u7528 install_skill \u4ECE SkillHub \u5B89\u88C5\u3002",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "\u8981\u52A0\u8F7D\u7684**\u6280\u80FD\u540D**\uFF08\u4E0D\u662F\u9875\u9762\u5143\u7D20\uFF09\u3002\u53D6\u503C\u5FC5\u987B\u662F\u7CFB\u7EDF\u63D0\u793A\u300C\u6280\u80FD\u76EE\u5F55\u300D\u91CC\u5217\u51FA\u7684\u6280\u80FD\u540D\uFF0C\u6216 SkillHub \u4E0A\u7684\u6280\u80FD\u6807\u8BC6\uFF1B\u4E0D\u786E\u5B9A\u65F6\u5148\u770B\u76EE\u5F55\uFF0C\u4E0D\u8981\u81C6\u6D4B\u3002" }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "install_skill",
      description: "\u4ECE SkillHub \u5E73\u53F0\u5B89\u88C5\u4E00\u4E2A\u6280\u80FD\u5230\u672C\u5730\uFF08\u4E0B\u8F7D\u5176 SKILL.md \u5E76\u4FDD\u5B58\uFF09\u3002\u5F53\u4F60\u5224\u65AD\u5B8C\u6210\u4EFB\u52A1\u9700\u8981\u67D0\u4E2A\u5C1A\u672A\u5B89\u88C5\u7684\u6280\u80FD\u65F6\uFF0C\u53EF\u5148\u7528\u672C\u5DE5\u5177\u5B89\u88C5\uFF0C\u518D\u8C03\u7528 load_skill \u52A0\u8F7D\u4F7F\u7528\u3002\u53C2\u6570\u4E3A\u6280\u80FD\u5750\u6807 @namespace/slug \u6216\u6280\u80FD\u9875 URL\u3002\u5B89\u88C5\u9700\u7528\u6237\u786E\u8BA4\uFF1B\u51FA\u4E8E\u5B89\u5168\uFF0C\u4EC5\u5141\u8BB8 skillhub.cn \u6765\u6E90\u3002",
      parameters: {
        type: "object",
        properties: {
          identifier: { type: "string", description: "\u6280\u80FD\u5750\u6807\uFF0C\u5982 @namespace/slug\uFF0C\u6216\u6280\u80FD\u8BE6\u60C5\u9875 URL\uFF08https://skillhub.cn/skills/namespace/slug\uFF09" }
        },
        required: ["identifier"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_skill",
      description: '\u628A\u4E00\u6BB5**\u53EF\u590D\u7528**\u7684\u505A\u6CD5\u6C89\u6DC0\u4E3A\u81EA\u5B9A\u4E49\u6280\u80FD\uFF08SKILL.md\uFF09\u4FDD\u5B58\u5230\u672C\u5730\u3002\u7528\u6237\u8BF4\u300C\u6C89\u6DC0\u4E3A\u6280\u80FD / \u8BB0\u4F4F\u8FD9\u4E2A\u505A\u6CD5\u300D\u4E14\u4F60\u5DF2\u6478\u6E05\u505A\u6CD5\u65F6\u4F7F\u7528\u3002\u6B63\u6587\u5199"\u4EE5\u540E\u600E\u4E48\u505A"\uFF08\u573A\u666F/\u6B65\u9AA4/\u8FB9\u754C/\u5B8C\u6210\u5224\u636E\uFF09\uFF0C\u4E0D\u8981\u590D\u8FF0\u672C\u6B21\u4EFB\u52A1\u65E5\u5FD7 \u2014\u2014 \u5B83\u4F1A\u8FDB\u5165\u4ECA\u540E\u7684\u7CFB\u7EDF\u63D0\u793A\u3002\u4FDD\u5B58\u9700\u7528\u6237\u786E\u8BA4\u3002',
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "\u6280\u80FD\u6807\u8BC6\uFF0Ckebab-case\uFF08\u5C0F\u5199\u5B57\u6BCD/\u6570\u5B57/-\uFF09\uFF0C\u5982 publish-xhs-note\uFF1B\u4E0E\u5185\u7F6E\u6280\u80FD\u91CD\u540D\u4F1A\u88AB\u62D2\u7EDD" },
          content: { type: "string", description: "\u6280\u80FD\u6B63\u6587\uFF08Markdown\uFF09\uFF1A\u4EE5\u540E\u600E\u4E48\u505A\uFF08\u573A\u666F/\u6B65\u9AA4/\u8FB9\u754C/\u5B8C\u6210\u5224\u636E\uFF09\uFF0C\u81F3\u5C11\u51E0\u5341\u5B57" },
          description: { type: "string", description: "\u4E00\u53E5\u8BDD\u8BF4\u660E\u4F55\u65F6\u4F7F\u7528\uFF08\u8FDB\u6280\u80FD\u76EE\u5F55\uFF0C\u6A21\u578B\u636E\u6B64\u51B3\u5B9A\u662F\u5426\u52A0\u8F7D\uFF09" },
          displayName: { type: "string", description: "\u663E\u793A\u540D\uFF08\u7ED9\u7528\u6237\u770B\uFF09\uFF0C\u5982\u300C\u53D1\u5E03\u5C0F\u7EA2\u4E66\u56FE\u6587\u7B14\u8BB0\u300D" },
          keywords: { type: "array", items: { type: "string" }, description: "\u89E6\u53D1\u5173\u952E\u8BCD\uFF08\u53EF\u9009\uFF09" },
          intents: { type: "array", items: { type: "string", enum: ["browser_task", "knowledge_task", "research_task", "chat_task"] }, description: "\u9002\u7528\u610F\u56FE\uFF08\u53EF\u9009\uFF09" },
          tools: { type: "array", items: { type: "string" }, description: "\u4F9D\u8D56\u5DE5\u5177\u540D\uFF08\u53EF\u9009\uFF0C\u987B\u771F\u5B9E\u5B58\u5728\uFF1B\u5199\u9519\u7684\u8FD0\u884C\u65F6\u4F1A\u88AB\u5FFD\u7565\uFF0C\u4FDD\u5B58\u7ED3\u679C\u4F1A\u544A\u8B66\uFF09" }
        },
        required: ["name", "content"]
      }
    }
  }
];

// lib/assistant/tool-metadata.js
var TOOL_METADATA = {
  // C-4 合并第 4 档：只读三件套（search/list/get）→ knowledge_read({ op })。
  // 三者权限完全一致（read/readOnly/parallelSafe），因此合并**不改变任何权限语义**。
  // 写（add_entry）与删（remove_entry）**刻意保持独立** —— 见 lib/assistant/knowledge.js 文件头。
  knowledge_read: { risk: "read", readOnly: true, parallelSafe: true, route: "background" },
  read_current_page: { risk: "read", readOnly: true, parallelSafe: true, route: "content" },
  get_page_snapshot: { risk: "read", readOnly: true, parallelSafe: true, route: "content" },
  // C-4 合并：原 read_console / read_network / list_downloads → read_diagnostics(kind)。
  // 三者原本都是 read/readOnly/parallelSafe，权限无差异，因此合并**不改变任何权限语义**。
  // route 取 'content'（console/network 走内容脚本；downloads 的实现本身在后台，不受 route 影响）。
  read_diagnostics: { risk: "read", readOnly: true, parallelSafe: true, route: "content" },
  get_element_source: { risk: "read", readOnly: true, parallelSafe: true, route: "content" },
  type_text: { risk: "page", requiresApproval: true, route: "content" },
  press_key: { risk: "page", requiresApproval: true, route: "content" },
  select_option: { risk: "page", requiresApproval: true, route: "content" },
  check_box: { risk: "page", requiresApproval: true, route: "content" },
  wait_for_element: { risk: "read", readOnly: true, parallelSafe: true, route: "content" },
  get_attribute: { risk: "read", readOnly: true, parallelSafe: true, route: "content" },
  list_tabs: { risk: "read", readOnly: true, parallelSafe: true, route: "background" },
  switch_tab: { risk: "browser", requiresApproval: true, route: "background" },
  add_entry: { risk: "write", requiresApproval: true, route: "background" },
  remove_entry: { risk: "destructive", requiresApproval: true, route: "background" },
  open_tab: { risk: "browser", requiresApproval: true, route: "background" },
  // fetch_webpage **不标 readOnly**：本仓库里 readOnly 是一个复合承诺 ——
  // 「不改变状态」**且**「不需要审批」（registry.test.mjs 明确守住了这条不变量：
  // 只读工具要求审批 = 用户被无意义弹窗打断）。抓网页不改变任何状态，但它要联网、要花用户的钱，
  // 必须保留审批。所以这里用**单独的** mutatesState 表达「不改状态」这件事。
  //
  // 为什么需要这个字段：完成校验要按任务性质选判据（agent.js 的 classifyTaskKind）。
  // 漏掉它，「查资料并总结」会被当成页面写操作去问「页面按要求变了吗」——
  // 研究类任务在长页面上永远答不出这个问题，于是被判未达成、白烧几轮校验。
  fetch_webpage: { risk: "network", mutatesState: false, requiresApproval: true, parallelSafe: true, route: "background", timeoutMs: 2e4 },
  web_search: { risk: "network", readOnly: true, requiresApproval: false, parallelSafe: true, route: "background", timeoutMs: 2e4 },
  click_element: { risk: "page", requiresApproval: true, route: "content" },
  // C-4 合并第 1 档：highlight_text / outline_element / set_element_style / clear_page_overlays
  // → annotate({ op })。四者风险完全相同（page + 逐次审批），因此是**纯粹的收敛**，
  // 不存在"取最高"的歧义 —— 也因此它是这一轮里风险最低的一档。
  // 四个 op 共用同一条执行路径（executePageTool → 内容脚本 highlight/outline/set_style/clear_highlights）。
  annotate: { risk: "page", requiresApproval: true, route: "content" },
  // C-4 合并第 2 档：get_element_text / inspect_element / extract_table → inspect_element({ op })。
  // 三者权限完全一致（read/readOnly/parallelSafe），且原本就共用同一条执行路径。
  // ⚠ 本档**没有**并入 get_attribute 与 get_element_source：它们走各自不同的执行路径
  //（独立消息 / 源码映射链路），且后者被 MCP 的「页面元素 → 源码文件」闭环直接使用。
  inspect_element: { risk: "read", readOnly: true, parallelSafe: true, route: "content" },
  // 截图刻意不标记：它重、会向 UI 推图，且同批截图没有实际收益
  take_screenshot: { risk: "read", readOnly: true, route: "background" },
  scroll_page: { risk: "page", requiresApproval: true, route: "content" },
  // run_javascript 与普通页面命令同级：由「页面命令」类别统一控制审批。
  // 它仍会修改页面，但不再单独占用一个"代码执行"审批档；需要更严时可关闭「页面命令」自动批准。
  run_javascript: { risk: "page", requiresApproval: true, route: "content" },
  click_at: { risk: "page", requiresApproval: true, route: "background" },
  hover_element: { risk: "page", requiresApproval: true, route: "background" },
  drag_element: { risk: "page", requiresApproval: true, route: "background" },
  upload_file: { risk: "destructive", requiresApproval: true, route: "background" },
  get_ax_snapshot: { risk: "read", readOnly: true, parallelSafe: true, route: "background" },
  list_frames: { risk: "read", readOnly: true, parallelSafe: true, route: "background" },
  undo_last_action: { risk: "page", requiresApproval: true, route: "content" },
  // C-4 合并第 5 档：save_macro + list_macros + run_macro → macro({ op })。
  // **risk 取三者最高**：save_macro 是 write+审批、list_macros 是 read、run_macro 是 page+审批
  // → 合并后必须继承 write + 逐次审批（tests/tool-merge-plan.test.mjs 会自动算出并断言）。
  // 另有两条**按 op 分别保留**的防线（见 lib/assistant/macros.js 文件头注释）：
  //   · op=save 的写审批；· op=run 的执行期 REPLAYABLE_TOOLS 白名单（有真实提权先例）。
  macro: { risk: "write", readOnly: false, requiresApproval: true, route: "background" },
  trust_site: { risk: "write", requiresApproval: true, route: "background" },
  // 循环内有专门分支 / 依赖同轮前序结果 —— 见文件头 a) 与「专门分支」说明，故意不标记
  update_plan: { risk: "read", readOnly: true, alwaysAvailable: true, route: "background" },
  expand_result: { risk: "read", readOnly: true, alwaysAvailable: true, route: "background" },
  handle_dialog: { risk: "page", requiresApproval: true, route: "background" },
  get_run_trace: { risk: "read", readOnly: true, alwaysAvailable: true, route: "background" },
  list_userscripts: { risk: "read", readOnly: true, parallelSafe: true, route: "background" },
  search_userscripts: { risk: "network", requiresApproval: true, route: "background" },
  install_userscript: { risk: "high", requiresApproval: true, alwaysRequireApproval: true, route: "background" },
  run_userscript: { risk: "high", requiresApproval: true, alwaysRequireApproval: true, route: "content" },
  complete_task: { risk: "read", readOnly: true, route: "background" },
  load_skill: { risk: "read", readOnly: true, alwaysAvailable: true, route: "background" },
  install_skill: { risk: "external", readOnly: false, alwaysAvailable: true, requiresApproval: true, route: "background" },
  // save_skill：把一段做法写成**会进入今后系统提示**的技能正文 —— 这是一条**持久化**的注入面，
  // 比单次 run_javascript 的影响更长远（那一轮结束就没了，这个会一直留在技能目录里）。
  // 因此取最严的一档：high + alwaysRequireApproval
  //   · 不受"站点信任"影响（toolNeedsApproval 会先看 alwaysRequireApproval）；
  //   · 不参与 toolApprovalPolicy 的类别自动批准（"编辑知识库"勾上也拦得住它）。
  // ⚠ 残余风险如实记录：用户在设置里把「用户脚本 / 技能写入审批」设为 auto 时，这一档同样不再弹窗
  //   （与用户脚本共用一个开关，这是既有设计）；面板里会显示「本任务内允许」按钮，
  //   用户点它即表示接受本轮后续的 save_skill。
  // alwaysAvailable：跨意图常驻。**这是必需的**：实测会话 RF-FY6PUP 里「沉淀为技能」
  //   被意图路由判成 knowledge_task，而知识库意图只带 6 个工具 —— 若不在常驻集合里，
  //   用户在这类意图下永远看不到这个能力。
  save_skill: { risk: "high", readOnly: false, alwaysAvailable: true, requiresApproval: true, alwaysRequireApproval: true, route: "background" }
};

// lib/shared/content-script-bridge.js
var INJECT_COOLDOWN_MS = 2e3;
var lastInjectAt = /* @__PURE__ */ new Map();
function normalizeFrameId(frameId) {
  const fid = Number(frameId);
  return Number.isInteger(fid) && fid >= 0 ? fid : 0;
}
function sendOnce(chromeApi, tabId, message, frameId) {
  return new Promise((resolve, reject) => {
    const callback = (response) => {
      if (chromeApi.runtime.lastError) {
        reject(new Error(chromeApi.runtime.lastError.message));
        return;
      }
      resolve(response);
    };
    chromeApi.tabs.sendMessage(tabId, message, { frameId: normalizeFrameId(frameId) }, callback);
  });
}
async function injectContentScript(chromeApi, tabId, frameId) {
  if (!chromeApi || !chromeApi.scripting || typeof chromeApi.scripting.executeScript !== "function") {
    return false;
  }
  const key = String(tabId) + ":" + normalizeFrameId(frameId);
  const now = Date.now();
  if (now - Number(lastInjectAt.get(key) || 0) < INJECT_COOLDOWN_MS) return false;
  lastInjectAt.set(key, now);
  try {
    await chromeApi.scripting.executeScript({
      target: { tabId: Number(tabId), frameIds: [normalizeFrameId(frameId)] },
      files: ["content.js"]
    });
    return true;
  } catch (e) {
    return false;
  }
}
async function sendTabMessageWithInjection(chromeApi, tabId, message, frameId) {
  try {
    return await sendOnce(chromeApi, tabId, message, frameId);
  } catch (e) {
    if (!isContentScriptUnreachable(e && e.message)) throw e;
    const injected = await injectContentScript(chromeApi, tabId, frameId);
    if (!injected) throw e;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return await sendOnce(chromeApi, tabId, message, frameId);
  }
}

// lib/assistant/net-parse.js
function stripHtmlTags(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&ensp;/g, " ").replace(/&emsp;/g, " ").replace(/&middot;/g, "\xB7").replace(/&mdash;/g, "\u2014").replace(/&ndash;/g, "\u2013").replace(/&#(\d+);/g, (_, n) => {
    try {
      return String.fromCodePoint(Number(n));
    } catch (e) {
      return "";
    }
  }).replace(/&#x([0-9a-f]+);/gi, (_, n) => {
    try {
      return String.fromCodePoint(parseInt(n, 16));
    } catch (e) {
      return "";
    }
  }).replace(/\s+/g, " ").trim();
}
function extractHtmlTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtmlTags(m[1]).slice(0, 120) : "";
}
function resolveSearchUrl(href, engine) {
  try {
    if (engine === "ddg") {
      const u = new URL(href, "https://duckduckgo.com");
      const target = u.searchParams.get("uddg");
      if (target && /^https?:\/\//i.test(target)) return target;
    } else if (engine === "bing") {
      const u = new URL(href, "https://www.bing.com");
      const enc = u.searchParams.get("u");
      if (enc) {
        let b64 = enc.replace(/-/g, "+").replace(/_/g, "/");
        while (b64.length % 4) b64 += "=";
        const decoded = Buffer.from(b64, "base64").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
    const abs = new URL(href, engine === "ddg" ? "https://duckduckgo.com" : "https://www.bing.com");
    return /^https?:\/\//i.test(abs.href) ? abs.href : "";
  } catch (e) {
    return "";
  }
}
function parseSearchResults(html, engine) {
  const out = [];
  const src = String(html || "");
  if (engine === "bing") {
    const blocks = src.split(/<li class="b_algo"/i).slice(1);
    for (const b of blocks) {
      const am = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!am) continue;
      const url = resolveSearchUrl(am[1], engine);
      const title = stripHtmlTags(am[2]);
      const sm = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const snippet = sm ? stripHtmlTags(sm[1]).slice(0, 300) : "";
      if (url && title) out.push({ title, url, snippet });
    }
    return out;
  }
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
  let m;
  while (m = re.exec(src)) {
    const url = resolveSearchUrl(m[1], engine);
    const title = stripHtmlTags(m[2]);
    const snippet = m[3] ? stripHtmlTags(m[3]).slice(0, 300) : "";
    if (url && title) out.push({ title, url, snippet });
  }
  return out;
}
function isAbortLikeError(e) {
  if (!e) return false;
  if (e.name === "AbortError") return true;
  return /signal is aborted|user aborted|operation was aborted|aborted without reason/i.test(String(e.message || ""));
}
function describeFetchError(e, url, timeoutMs) {
  const u = String(url || "");
  if (isAbortLikeError(e)) {
    const secs = Math.round((Number(timeoutMs) || 15e3) / 1e3);
    return "\u6293\u53D6\u8D85\u65F6\uFF08" + secs + " \u79D2\u5185\u6CA1\u6709\u54CD\u5E94\uFF09\uFF1A" + u + "\u3002**\u8FD9\u4E0D\u662F\u9875\u9762\u672C\u8EAB\u7684\u95EE\u9898**\uFF08\u4E0D\u662F SPA\u3001\u4E5F\u4E0D\u662F\u8DE8\u57DF\uFF09\u2014\u2014 \u6211\u4EEC\u6CA1\u62FF\u5230\u4EFB\u4F55\u5185\u5BB9\uFF0C\u56E0\u6B64\u65E0\u4ECE\u5224\u65AD\u9875\u9762\u7C7B\u578B\u3002\u53EF\u6539\u7528 open_tab \u6253\u5F00\u8BE5\u9875\u3001\u518D\u7528 read_current_page \u8BFB\u53D6\u6E32\u67D3\u540E\u7684\u5185\u5BB9\uFF08\u6D4F\u89C8\u5668\u81EA\u5DF1\u52A0\u8F7D\u4E0D\u53D7\u8FD9\u4E2A\u8D85\u65F6\u9650\u5236\uFF09\uFF0C\u6216\u6362\u7528\u5176\u5B83\u6765\u6E90\u3002\u540C\u4E00 URL \u7A0D\u540E\u4ECD\u53EF\u91CD\u8BD5\u3002";
  }
  const raw = e && e.message ? e.message : e === void 0 || e === null ? "\u672A\u77E5\u9519\u8BEF" : String(e);
  return "\u6293\u53D6\u7F51\u9875\u5931\u8D25\uFF1A" + raw + "\u3002\u8BF7\u6539\u7528 open_tab \u6253\u5F00\u8BFB\u53D6\uFF0C\u6216\u6362\u7528\u5176\u5B83\u6765\u6E90\uFF1B\u4E0D\u8981\u53CD\u590D\u91CD\u8BD5\u8BE5 URL\u3002\uFF08\u82E5\u4E3A\u76EE\u6807\u7AD9\u8DE8\u57DF\uFF0C\u8BF7\u5C06\u5176\u57DF\u540D\u52A0\u5165 manifest.json \u7684 host_permissions\uFF1B\u6216\u6539\u7528 MCP fetch \u670D\u52A1\u5668\u4EE5\u7A81\u7834\u6D4F\u89C8\u5668\u8DE8\u57DF\u9650\u5236\uFF09";
}
function citationTitleFor(pageTitle, url) {
  const t = stripHtmlTags(String(pageTitle || "").trim());
  if (t) return t;
  const u = String(url || "");
  try {
    const parsed = new URL(u);
    const last = decodeURIComponent(parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean).pop() || "");
    return last || parsed.hostname || u || "\uFF08\u65E0\u6807\u9898\u9875\u9762\uFF09";
  } catch (e) {
    return u || "\uFF08\u65E0\u6807\u9898\u9875\u9762\uFF09";
  }
}
async function readBounded(body, maxBytes) {
  const chunks = [];
  let total = 0;
  const reader = body.getReader();
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || !value.byteLength) continue;
    total += value.byteLength;
    chunks.push(value);
    if (total >= maxBytes) {
      try {
        await reader.cancel();
      } catch (e) {
      }
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    if (off >= out.length) break;
    const slice = c.subarray(0, out.length - off);
    out.set(slice, off);
    off += slice.byteLength;
  }
  return out;
}
function decodeBuffer(buf, contentType) {
  const charset = ((contentType || "").match(/charset=([\w-]+)/i) || [])[1];
  try {
    return new TextDecoder((charset || "utf-8").trim().toLowerCase());
  } catch (e) {
    return new TextDecoder("utf-8");
  }
}
async function searchWeb(query, maxResults = 6) {
  const q = encodeURIComponent(query);
  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };
  const engines = [
    { name: "bing", url: "https://www.bing.com/search?q=" + q + "&setlang=zh-hans", timeout: 7e3 },
    { name: "ddg", url: "https://html.duckduckgo.com/html/?q=" + q, timeout: 6e3 }
  ];
  for (const engine of engines) {
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), engine.timeout) : null;
      const resp = await fetch(engine.url, { method: "GET", redirect: "follow", headers, signal: ctrl ? ctrl.signal : void 0 });
      if (timer) clearTimeout(timer);
      if (!resp.ok) continue;
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      const buf = await readBounded(resp.body, 1.5 * 1024 * 1024);
      const raw = decodeBuffer(buf, ct).decode(buf);
      const results = parseSearchResults(raw, engine.name);
      if (results.length) return results.slice(0, maxResults);
    } catch (e) {
    }
  }
  return [];
}

// lib/assistant/page-action-verify.js
function buildActionVerification(observed, reason) {
  const text = String(reason || "");
  if (observed === "changed") return { executed: true, verified: true, changed: true, reason: text };
  if (observed === "unchanged") return { executed: true, verified: true, changed: false, reason: text };
  return { executed: true, verified: false, changed: false, reason: text };
}
function observedChange(before, after) {
  if (!after || typeof after.fingerprint !== "string") return "unobservable";
  if (!before || typeof before.fingerprint !== "string") return "unobservable";
  return before.fingerprint === after.fingerprint ? "unchanged" : "changed";
}
function snapshotChanged(before, after, command2) {
  if (!before || !after) return false;
  if (before.url !== after.url) return true;
  if (before.fingerprint && after.fingerprint && before.fingerprint !== after.fingerprint) return true;
  if ((command2 === "scroll_to" || command2 === "scroll_by") && before.scroll && after.scroll && (before.scroll.x !== after.scroll.x || before.scroll.y !== after.scroll.y)) {
    return true;
  }
  return false;
}
function verifyPageAction(command2, before, after, response) {
  const executed = Boolean(response && response.ok !== false);
  const urlChanged = Boolean(before && after && before.url !== after.url);
  const contentChanged = Boolean(before && after && before.fingerprint !== after.fingerprint);
  const scrollChanged = Boolean(before && after && before.scroll && after.scroll && (before.scroll.x !== after.scroll.x || before.scroll.y !== after.scroll.y));
  const visualOnly = ["highlight", "outline", "set_style", "clear_highlights"].includes(command2);
  const responseChanged = Boolean(response && (response.changed || response.hadEffect));
  const responseSatisfied = Boolean(response && response.alreadySatisfied);
  const eventOnly = command2 === "press_key";
  const changed = urlChanged || contentChanged || scrollChanged || responseChanged;
  let reason = executed ? "\u52A8\u4F5C\u5DF2\u6267\u884C" : "\u9875\u9762\u547D\u4EE4\u8FD4\u56DE\u5931\u8D25";
  if (command2 === "click" && executed && !changed) reason = "\u70B9\u51FB\u5DF2\u6D3E\u53D1\uFF0C\u4F46\u9875\u9762\u5FEB\u7167\u6682\u672A\u89C2\u5BDF\u5230\u53D8\u5316";
  if (command2.indexOf("scroll") === 0 && executed && !scrollChanged) reason = "\u6EDA\u52A8\u5DF2\u6D3E\u53D1\uFF0C\u4F46\u6EDA\u52A8\u4F4D\u7F6E\u672A\u53D8\u5316";
  if (visualOnly && executed) reason = "\u89C6\u89C9\u6807\u6CE8\u52A8\u4F5C\u5DF2\u6267\u884C\uFF1B\u6807\u6CE8\u5C42\u4E0D\u8BA1\u5165\u5185\u5BB9\u6307\u7EB9";
  if (command2 === "type_text" && executed && responseSatisfied) reason = "\u76EE\u6807\u8F93\u5165\u5DF2\u5904\u4E8E\u8981\u6C42\u72B6\u6001";
  else if (command2 === "type_text" && executed && !changed) reason = "\u8F93\u5165\u4E8B\u4EF6\u5DF2\u6D3E\u53D1\uFF0C\u4F46\u5FEB\u7167\u672A\u89C2\u5BDF\u5230\u503C\u72B6\u6001\u53D8\u5316";
  if (command2 === "press_key" && executed) reason = "\u952E\u76D8\u4E8B\u4EF6\u5DF2\u6D3E\u53D1";
  return {
    executed,
    verified: executed && (changed || responseSatisfied || visualOnly || eventOnly || command2 === "get_text"),
    changed,
    urlChanged,
    contentChanged,
    scrollChanged,
    reason
  };
}

// lib/assistant/target-frame.js
function parseRef(ref) {
  const m = String(ref || "").match(/^f(\d+):(.*)$/);
  if (m) return { frameId: Number(m[1]), ref: m[2] };
  return { frameId: null, ref: String(ref || "") };
}
function frameIdFromArgs(args) {
  if (!args) return null;
  if (args.frameId !== void 0 && args.frameId !== null && args.frameId !== "" && Number.isInteger(Number(args.frameId)) && Number(args.frameId) >= 0) {
    return Number(args.frameId);
  }
  return parseRef(args.ref).frameId;
}
function localTargetArgs(args) {
  const out = Object.assign({}, args || {});
  const p = parseRef(out.ref);
  if (p.frameId != null) out.ref = p.ref;
  delete out.frameId;
  return out;
}

// lib/assistant/tool-results.js
function summarizeCdpError(e) {
  const msg = e && e.message ? e.message : String(e);
  return msg.replace(/^[A-Za-z.]+：/, "");
}
function toolError(code, message, extra) {
  return Object.assign({ ok: false, code, result: message }, extra || {});
}
function compactSnapshotSummary(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return "";
  const title = String(snapshot.title || "");
  const url = String(snapshot.url || "");
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements.slice(0, 8).map((e) => {
    const label = e.label || e.placeholder || "";
    return e.ref + (label ? "\uFF1A" + sliceSafe(String(label), 0, 24) : "");
  }).join("\uFF1B") : "";
  const text = sliceSafe(String(snapshot.text || "").replace(/\s+/g, " ").trim(), 0, 300);
  return ["\u9875\u9762\u6807\u9898\uFF1A" + title, "\u9875\u9762URL\uFF1A" + url, elements ? "\u5173\u952E\u5143\u7D20\uFF1A" + elements : "", text ? "\u6B63\u6587\u6458\u8981\uFF08\u6309 textContent \u62BD\u53D6\uFF0C\u542B\u5DF2\u9690\u85CF\u8282\u70B9\u6587\u5B57\uFF0C\u4E0D\u80FD\u7528\u4E8E\u5224\u65AD\u53EF\u89C1\u6027\uFF09\uFF1A" + text : ""].filter(Boolean).join("\n");
}

// lib/assistant/diagnostics.js
async function readConsole(sendTabMessage2, tabId, args) {
  if (!tabId) return { ok: false, result: "\u65E0\u6CD5\u5B9A\u4F4D\u5F53\u524D\u6807\u7B7E\u9875\uFF08\u53EF\u80FD\u4E0D\u5728\u524D\u53F0\u9875\u9762\uFF09\u3002" };
  try {
    const res = await sendTabMessage2(tabId, { type: "kbGetConsole" });
    let entries = res && res.entries || [];
    if (args.level) entries = entries.filter((e) => e.level === args.level);
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
    entries = entries.slice(-limit);
    if (!entries.length) return { ok: true, result: "\u6682\u65E0 console \u8BB0\u5F55\u3002" };
    const text = entries.map((e) => "[" + e.level + "] " + e.text + (e.stack ? "\n" + e.stack : "")).join("\n");
    return { ok: true, result: "\u6700\u8FD1 console \u8BB0\u5F55\uFF08" + entries.length + " \u6761\uFF09\uFF1A\n" + text };
  } catch (e) {
    return { ok: false, result: "\u8BFB\u53D6 console \u5931\u8D25\uFF1A" + e.message };
  }
}
async function readNetwork(sendTabMessage2, tabId, args) {
  if (!tabId) return { ok: false, result: "\u65E0\u6CD5\u5B9A\u4F4D\u5F53\u524D\u6807\u7B7E\u9875\uFF08\u53EF\u80FD\u4E0D\u5728\u524D\u53F0\u9875\u9762\uFF09\u3002" };
  try {
    const res = await sendTabMessage2(tabId, { type: "kbGetNetwork" });
    let entries = res && res.entries || [];
    if (args.filter) {
      const f = String(args.filter);
      entries = entries.filter((e) => String(e.url || "").includes(f));
    }
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
    entries = entries.slice(-limit);
    if (!entries.length) return { ok: true, result: "\u6682\u65E0\u7F51\u7EDC\u8BF7\u6C42\u8BB0\u5F55\u3002" };
    const text = entries.map((e) => {
      const head = (e.method || "GET") + " " + (e.error ? "ERR" : e.status || "") + " " + e.url + (e.ms != null ? " (" + e.ms + "ms)" : "") + (e.error ? " \u2014 " + e.error : "");
      const init = e.initiator ? e.initiator.split("\n").slice(0, 2).join(" ") : "";
      return head + (init ? "\n  \u53D1\u8D77\u4E8E: " + init : "");
    }).join("\n");
    return { ok: true, result: "\u6700\u8FD1\u7F51\u7EDC\u8BF7\u6C42\uFF08" + entries.length + " \u6761\uFF09\uFF1A\n" + text };
  } catch (e) {
    return { ok: false, result: "\u8BFB\u53D6\u7F51\u7EDC\u8BF7\u6C42\u5931\u8D25\uFF1A" + e.message };
  }
}
function listDownloads(getDownloads2, tabId) {
  const list = getDownloads2(tabId);
  if (!list.length) return { ok: true, result: "\u672C\u4EFB\u52A1\u6682\u672A\u6355\u83B7\u5230\u4E0B\u8F7D\u3002" };
  return {
    ok: true,
    result: "\u6355\u83B7\u5230\u7684\u4E0B\u8F7D\uFF1A\n" + list.map((d, i) => "[" + (i + 1) + "] " + (d.suggestedFilename || "") + " \u2190 " + d.url).join("\n")
  };
}
var DIAGNOSTIC_KINDS = ["console", "network", "downloads"];
async function readDiagnostics(deps, args) {
  const kind = String(args && args.kind || "").trim();
  if (!kind) {
    return { ok: false, result: "read_diagnostics \u9700\u8981 kind \u53C2\u6570\uFF0C\u53D6\u503C\uFF1A" + DIAGNOSTIC_KINDS.join(" / ") + "\u3002" };
  }
  if (kind === "console") return await readConsole(deps.sendTabMessage, deps.tabId, args);
  if (kind === "network") return await readNetwork(deps.sendTabMessage, deps.tabId, args);
  if (kind === "downloads") return listDownloads(deps.getDownloads, deps.tabId);
  return { ok: false, result: "\u672A\u77E5\u7684 kind\u300C" + kind + "\u300D\uFF0C\u53D6\u503C\uFF1A" + DIAGNOSTIC_KINDS.join(" / ") + "\u3002" };
}

// lib/assistant/macros.js
var REPLAYABLE_TOOLS = /* @__PURE__ */ new Set([
  "click_element",
  "type_text",
  "press_key",
  "select_option",
  "check_box",
  "scroll_page",
  "wait_for_element",
  "open_tab"
]);
async function macroSave(deps, args) {
  const name = String(args && args.name || "").trim();
  if (!name) return { ok: false, result: 'macro(op="save") \u9700\u8981 name\u3002' };
  let trace = Array.isArray(deps.trace) ? deps.trace : [];
  let fromPreviousRun = false;
  let previousAgeMs = 0;
  let previousDropped = 0;
  if (!trace.length && typeof deps.recallTrace === "function") {
    const last = await Promise.resolve().then(() => deps.recallTrace(deps.pageUrl)).catch(() => null);
    if (last && Array.isArray(last.steps) && last.steps.length) {
      trace = last.steps;
      fromPreviousRun = true;
      previousAgeMs = Number(last.ageMs) || 0;
      previousDropped = Number(last.dropped) || 0;
    }
  }
  const beforeFilter = trace.length;
  trace = trace.filter((s) => s && typeof s.tool === "string" && s.args && typeof s.args === "object" && REPLAYABLE_TOOLS.has(s.tool));
  const skipped = beforeFilter - trace.length;
  if (!trace.length) {
    return {
      ok: false,
      result: (skipped > 0 ? "\u8FD9\u4E00\u6279\u8F68\u8FF9\u91CC\u6709 " + skipped + " \u6B65\u90FD\u4E0D\u5728\u53EF\u56DE\u653E\u767D\u540D\u5355\u5185\uFF08\u5DF2\u5254\u9664\uFF09\uFF0C\u6CA1\u6709\u53EF\u4FDD\u5B58\u7684\u6B65\u9AA4\u3002\n" : "\u672C\u8F6E\u4EFB\u52A1\u6CA1\u6709\u53EF\u4FDD\u5B58\u7684\u53EF\u91CD\u653E\u52A8\u4F5C\uFF0C\u672C\u7AD9\u70B9\u4E5F\u6CA1\u6709\u6700\u8FD1\u53EF\u6C89\u6DC0\u7684\u8F68\u8FF9\u3002\n") + "\u53EA\u6709\u8FD9\u4E9B\u5DE5\u5177\u4F1A\u88AB\u8BB0\u5F55\uFF1A" + Array.from(REPLAYABLE_TOOLS).join("\u3001") + '\uFF08\u4E14\u9700\u8981\u62FF\u5230\u7A33\u5B9A\u7684 selector\uFF09\uFF1B`click_at`\uFF08\u5750\u6807\u70B9\u51FB\uFF09\u4E0E `run_javascript` **\u4E0D\u8FDB\u5B8F**\u3002\n\u8981\u6C89\u6DC0\u6210\u5B8F\uFF1A\u8BF7\u7528\u4E0A\u9762\u8FD9\u4E9B\u5DE5\u5177\u628A\u6D41\u7A0B\u5B8C\u6574\u505A\u4E00\u904D\uFF0C**\u505A\u5B8C\u7ACB\u523B** macro({op:"save", name:"\u2026"})\u3002'
    };
  }
  const saved = await deps.saveMacro(deps.pageUrl, { name, description: args && args.description, steps: trace });
  if (!saved) return { ok: false, result: "\u4FDD\u5B58\u5B8F\u5931\u8D25\uFF08\u7F3A\u5C11\u540D\u79F0\u6216\u6B65\u9AA4\uFF09\u3002" };
  const source = fromPreviousRun ? "\u26A0 \u8FD9 " + saved.steps.length + " \u6B65\u6765\u81EA**\u4E0A\u4E00\u8F6E\u4EFB\u52A1**\u5728\u672C\u7AD9\u70B9\u7684\u8F68\u8FF9\uFF08\u7EA6 " + Math.max(1, Math.round(previousAgeMs / 6e4)) + " \u5206\u949F\u524D\uFF09\uFF0C\u4E0D\u662F\u672C\u8F6E\u3002" + (previousDropped > 0 ? "\u53E6\u6709 " + previousDropped + " \u6B65\u56E0\u8D85\u957F\u672A\u7EB3\u5165\u3002" : "") + '\u56DE\u653E\u524D\u8BF7\u5148\u6838\u5BF9\u6B65\u9AA4\u662F\u5426\u7B26\u5408\u9884\u671F\uFF08macro({op:"list"})\uFF0C\u6216\u5148\u8BD5\u8DD1\u4E00\u6B21\uFF09\u3002' : "";
  const droppedNote = skipped > 0 ? "\uFF08\u53E6\u6709 " + skipped + " \u6B65\u4E0D\u5728\u53EF\u56DE\u653E\u767D\u540D\u5355\u5185\uFF0C\u5DF2\u5254\u9664\uFF09" : "";
  return {
    ok: true,
    result: "\u5DF2\u4FDD\u5B58\u5B8F\u300C" + saved.name + "\u300D\uFF08" + saved.steps.length + " \u6B65\uFF09\u3002" + droppedNote + source + '\u4EE5\u540E\u53EF\u7528 macro({op:"run", name:"' + saved.name + '"}) \u56DE\u653E\u3002'
  };
}
async function macroList(deps) {
  const macros = await deps.listMacros(deps.pageUrl);
  if (!macros.length) return { ok: true, result: "\u5F53\u524D\u7AD9\u70B9\u8FD8\u6CA1\u6709\u4FDD\u5B58\u7684\u5B8F\u3002" };
  const text = macros.map((m, i) => "[" + (i + 1) + '] name="' + m.name + '"' + (m.description ? " \u2014 " + m.description : "") + "\uFF08" + m.steps.length + " \u6B65\uFF09").join("\n");
  return { ok: true, result: "\u5F53\u524D\u7AD9\u70B9\u5DF2\u4FDD\u5B58\u7684\u5B8F\uFF08\u56DE\u653E\u65F6\u8BF7\u7167\u6284 name \u7684\u503C\uFF09\uFF1A\n" + text };
}
async function macroRun(deps, args) {
  const name = String(args && args.name || "").trim();
  if (!name) return { ok: false, result: 'macro(op="run") \u9700\u8981 name\u3002' };
  const macro = await deps.getMacro(deps.pageUrl, name);
  if (!macro) {
    let names = [];
    try {
      names = (await deps.listMacros(deps.pageUrl)).map((m) => m.name);
    } catch (e) {
    }
    return {
      ok: false,
      result: "\u672A\u627E\u5230\u5B8F\u300C" + name + "\u300D\u3002" + (names.length ? "\u672C\u7AD9\u53EF\u7528\u7684\u5B8F\u540D\u5982\u4E0B\uFF0C\u8BF7\u7167\u6284 name \u7684\u503C\uFF08\u4E0D\u662F\u63CF\u8FF0\uFF09\uFF1A\n" + names.map((n) => "  - " + n).join("\n") : "\u672C\u7AD9\u8FD8\u6CA1\u6709\u4FDD\u5B58\u7684\u5B8F\u3002")
    };
  }
  const steps = Array.isArray(macro.steps) ? macro.steps : [];
  if (!steps.length) return { ok: false, result: "\u5B8F\u300C" + name + "\u300D\u6CA1\u6709\u6B65\u9AA4\u3002" };
  const ctx = deps.ctx;
  const log = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!REPLAYABLE_TOOLS.has(s && s.tool)) {
      const toolName = String(s && s.tool || "");
      return {
        ok: false,
        result: "\u5B8F\u300C" + name + "\u300D\u7684\u7B2C " + (i + 1) + " \u6B65\u8C03\u7528\u4E86\u4E0D\u5141\u8BB8\u56DE\u653E\u7684\u5DE5\u5177\u300C" + toolName + "\u300D\uFF0C\u5DF2\u505C\u6B62\u3002\n\u53EA\u6709\u8FD9\u4E9B\u5DE5\u5177\u53EF\u4EE5\u88AB\u5B8F\u56DE\u653E\uFF1A" + Array.from(REPLAYABLE_TOOLS).join("\u3001") + "\u3002\n\u82E5\u786E\u5B9E\u9700\u8981\u8BE5\u64CD\u4F5C\uFF0C\u8BF7\u6539\u7528\u5BF9\u5E94\u7684\u5185\u7F6E\u5DE5\u5177\u5355\u72EC\u6267\u884C\uFF08\u9AD8\u98CE\u9669\u5DE5\u5177\u4ECD\u9700\u9010\u6B21\u5BA1\u6279\uFF09\u3002"
      };
    }
    const stepValidation = deps.validateToolCall(s.tool, s.args || {});
    if (!stepValidation.ok) {
      return {
        ok: false,
        result: "\u5B8F\u300C" + name + "\u300D\u7684\u7B2C " + (i + 1) + " \u6B65\u53C2\u6570\u975E\u6CD5\uFF1A" + stepValidation.error
      };
    }
    let r;
    try {
      r = await deps.executeTool(s.tool, s.args, ctx);
    } catch (e) {
      r = { ok: false, result: e && e.message ? e.message : String(e) };
    }
    const failed = r && r.ok === false;
    log.push("[" + (i + 1) + "/" + steps.length + "] " + s.tool + (failed ? " \u2717 " + String(r.result || "").slice(0, 120) : " \u2713"));
    if (r && Number.isInteger(Number(r.targetTabId))) {
      ctx.tabId = Number(r.targetTabId);
      if (r.targetTab) {
        ctx.pageUrl = r.targetTab.url || ctx.pageUrl;
        ctx.pageTitle = r.targetTab.title || ctx.pageTitle;
      }
    }
    if (failed) return { ok: false, result: "\u5B8F\u300C" + name + "\u300D\u5728\u7B2C " + (i + 1) + " \u6B65\u5931\u8D25\uFF0C\u5DF2\u505C\u6B62\uFF1A\n" + log.join("\n") };
  }
  await deps.bumpMacroHits(deps.pageUrl, name).catch(() => {
  });
  return { ok: true, result: "\u5DF2\u56DE\u653E\u5B8F\u300C" + name + "\u300D\uFF08" + steps.length + " \u6B65\uFF09\uFF1A\n" + log.join("\n") };
}
var MACRO_OPS = ["save", "list", "run"];
async function macroTool(deps, args) {
  const op = String(args && args.op || "").trim();
  if (!op) return { ok: false, result: "macro \u9700\u8981 op \u53C2\u6570\uFF0C\u53D6\u503C\uFF1A" + MACRO_OPS.join(" / ") + "\u3002" };
  if (op === "save") return await macroSave(deps, args);
  if (op === "list") return await macroList(deps);
  if (op === "run") return await macroRun(deps, args);
  return { ok: false, result: "\u672A\u77E5\u7684 op\u300C" + op + "\u300D\uFF0C\u53D6\u503C\uFF1A" + MACRO_OPS.join(" / ") + "\u3002" };
}

// lib/assistant/knowledge.js
var KNOWLEDGE_READ_OPS = ["search", "list", "get"];
function knowledgeRead(deps, args) {
  const op = String(args && args.op || "").trim();
  if (!op) {
    return { ok: false, result: "knowledge_read \u9700\u8981 op \u53C2\u6570\uFF0C\u53D6\u503C\uFF1A" + KNOWLEDGE_READ_OPS.join(" / ") + "\u3002" };
  }
  if (op === "search") return knowledgeSearch(deps, args);
  if (op === "list") return knowledgeList(deps, args);
  if (op === "get") return knowledgeGet(deps, args);
  return { ok: false, result: "\u672A\u77E5\u7684 op\u300C" + op + "\u300D\uFF0C\u53D6\u503C\uFF1A" + KNOWLEDGE_READ_OPS.join(" / ") + "\u3002" };
}
function knowledgeSearch(deps, args) {
  const limit = Number(args.limit) || 5;
  const relevant = deps.buildRagContext(deps.book, args.query || "", limit);
  if (!relevant.length) return { result: "\u672A\u68C0\u7D22\u5230\u76F8\u5173\u77E5\u8BC6\u5E93\u6761\u76EE\u3002" };
  const citations = deps.buildCitations(relevant, false);
  const text = relevant.map(
    (it, i) => `[${i + 1}] id="${it.id}" \u6807\u9898\uFF1A${it.title}\uFF5C\u7C7B\u578B\uFF1A${deps.typeInfo(it.type).name}${it.note ? "\uFF5C\u5185\u5BB9\uFF1A" + it.note : ""}${it.url ? "\uFF5C\u94FE\u63A5\uFF1A" + it.url : ""}`
  ).join("\n");
  return { result: "\u68C0\u7D22\u5230\u7684\u77E5\u8BC6\u5E93\u6761\u76EE\uFF1A\n" + text, citations };
}
function knowledgeList(deps, args) {
  let items = Object.values(deps.book);
  if (args.type) items = items.filter((it) => it.type === args.type);
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const limit = Number(args.limit) || 20;
  const shown = items.slice(0, limit);
  const text = shown.map(
    (it, i) => `[${i + 1}] id="${it.id}" \u6807\u9898\uFF1A${it.title}\uFF5C\u7C7B\u578B\uFF1A${deps.typeInfo(it.type).name}${it.tags && it.tags.length ? "\uFF5C\u6807\u7B7E\uFF1A" + it.tags.join("\u3001") : ""}`
  ).join("\n");
  return {
    result: `\u77E5\u8BC6\u5E93\u5171 ${items.length} \u6761\uFF0C\u4EE5\u4E0B\u5217\u51FA ${shown.length} \u6761\uFF1A
` + (text || "\uFF08\u7A7A\uFF09"),
    citations: deps.buildCitations(shown, true)
  };
}
function knowledgeGet(deps, args) {
  const it = deps.book[args.id];
  if (!it) return { result: "\u672A\u627E\u5230\u8BE5\u6761\u76EE\uFF08id: " + args.id + "\uFF09\u3002" };
  const star = (deps.starLevels[it.status] || {}).name || it.status || "\u672A\u8BBE\u7F6E";
  return {
    result: `\u6807\u9898\uFF1A${it.title}
\u7C7B\u578B\uFF1A${deps.typeInfo(it.type).name}
\u661F\u7EA7\uFF1A${star}
\u6807\u7B7E\uFF1A${(it.tags || []).join("\u3001") || "\u65E0"}
\u5907\u6CE8\uFF1A${it.note || "\u65E0"}
\u94FE\u63A5\uFF1A${it.url || "\u65E0"}`
  };
}

// lib/assistant/tab-tools.js
var DEFAULT_MAX_TAB_SWITCHES = 6;
function tabSwitchBudget(ctx) {
  const used = Math.max(0, Number(ctx && ctx.tabSwitchCount) || 0);
  const max = Math.max(1, Number(ctx && ctx.maxTabSwitches) || DEFAULT_MAX_TAB_SWITCHES);
  return { used, max, exhausted: used >= max };
}
function countTabSwitch(ctx) {
  if (!ctx) return;
  ctx.tabSwitchCount = Math.max(0, Number(ctx.tabSwitchCount) || 0) + 1;
}
function tabSwitchLimitMessage(used, max) {
  return "\u672C\u4EFB\u52A1\u5DF2\u5207\u6362\u6807\u7B7E\u9875 " + used + " \u6B21\uFF08\u4E0A\u9650 " + max + "\uFF09\uFF0C\u4E3A\u51CF\u5C11\u5BF9\u7528\u6237\u7684\u6253\u6270\uFF0C\u4E0D\u518D\u7EE7\u7EED\u5207\u6362\u3002\u8BF7\u7559\u5728\u5F53\u524D\u9875\u5B8C\u6210\uFF1B\u9700\u8981\u53E6\u4E00\u9875\u7684\u6570\u636E\u65F6\uFF0C\u4F18\u5148\u4F7F\u7528\u5DF2\u8BFB\u5230\u7684\u5FEB\u7167/\u5DE5\u5177\u7ED3\u679C\u6216 fetch_webpage\uFF0C\u4E0D\u8981\u6765\u56DE\u5207\u6362\u3002";
}
async function listTabs(deps) {
  try {
    const tabs = await deps.chrome.tabs.query({ currentWindow: true });
    const visibleTabs = tabs.filter((t) => t.url);
    const tabInfo = visibleTabs.map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      title: t.title || "",
      url: t.url || "",
      active: Boolean(t.active)
    }));
    const text = visibleTabs.filter((t) => t.url).map((t, i) => `[${i + 1}] tabId=${t.id} ${t.active ? "\uFF08\u5F53\u524D\uFF09" : ""} ${t.title || ""}\uFF5C${t.url}`).join("\n");
    return { ok: true, tabs: tabInfo, result: "\u5F53\u524D\u7A97\u53E3\u6807\u7B7E\u9875\uFF1A\n" + (text || "\uFF08\u65E0\uFF09") };
  } catch (e) {
    return { ok: false, result: "\u5217\u51FA\u6807\u7B7E\u9875\u5931\u8D25\uFF1A" + e.message };
  }
}
async function switchTab(deps, args) {
  const tabId = Number(args && args.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) return { ok: false, result: "tabId \u5FC5\u987B\u662F\u6709\u6548\u7684\u6807\u7B7E\u9875 ID" };
  const currentId = Number(deps.ctx && deps.ctx.tabId);
  if (Number.isInteger(currentId) && currentId === tabId) {
    return {
      ok: true,
      noop: true,
      activated: false,
      targetTabId: tabId,
      result: "\u5F53\u524D\u5DF2\u7ECF\u7ED1\u5B9A\u8BE5\u6807\u7B7E\u9875\uFF08tabId=" + tabId + "\uFF09\uFF0C\u65E0\u9700\u91CD\u590D switch_tab\uFF1B\u8BF7\u76F4\u63A5\u5728\u5F53\u524D\u9875\u5B8C\u6210\u64CD\u4F5C\u3002"
    };
  }
  const budget = tabSwitchBudget(deps.ctx);
  try {
    const target = await deps.chrome.tabs.get(tabId);
    if (!target || !target.id) return { ok: false, result: "\u672A\u627E\u5230\u6807\u7B7E\u9875\uFF1A" + tabId };
    const activated = target.active !== true;
    if (activated) {
      if (budget.exhausted) {
        return {
          ok: false,
          blocked: true,
          result: tabSwitchLimitMessage(budget.used, budget.max)
        };
      }
      await deps.chrome.tabs.update(tabId, { active: true });
      countTabSwitch(deps.ctx);
    }
    const snapshot = await deps.waitForTabReady(tabId, 5e3);
    const current = await deps.chrome.tabs.get(tabId).catch(() => target);
    const targetTab = {
      tabId,
      windowId: current.windowId || target.windowId,
      title: current.title || target.title || "",
      url: current.url || target.url || "",
      ready: Boolean(snapshot)
    };
    deps.bindSessionTab(tabId);
    return {
      ok: true,
      activated,
      targetTabId: tabId,
      targetTab,
      pageSnapshot: snapshot,
      result: (activated ? "\u5DF2\u5207\u6362\u5230\u6807\u7B7E\u9875 " : "\u5DF2\u7ED1\u5B9A\u6807\u7B7E\u9875 ") + "tabId=" + tabId + "\uFF1A" + (target.title || target.url || "") + (snapshot ? "\uFF08\u9875\u9762\u5DF2\u5C31\u7EEA\uFF09" : "\uFF08\u5185\u5BB9\u811A\u672C\u5C1A\u672A\u5C31\u7EEA\uFF09") + (activated ? "\n\u540E\u7EED\u8BF7\u7559\u5728\u8BE5\u9875\u5B8C\u6210\u64CD\u4F5C\uFF0C\u4E0D\u8981\u4E3A\u9A8C\u8BC1/\u5BF9\u6BD4\u53CD\u590D\u5207\u56DE\u3002" : "\n\u8BE5\u9875\u5DF2\u5728\u540E\u53F0/\u524D\u53F0\u5C31\u7EEA\uFF0C\u65E0\u9700\u518D\u6B21\u5207\u6362\u3002")
    };
  } catch (e) {
    return { ok: false, result: "\u5207\u6362\u6807\u7B7E\u9875\u5931\u8D25\uFF1A" + e.message };
  }
}
async function openTab(deps, args) {
  const ctx = deps.ctx;
  try {
    const url = String(args && args.url || "");
    if (/^file:\/\//i.test(url)) {
      return {
        ok: false,
        result: "open_tab \u4E0D\u652F\u6301\u672C\u5730\u6587\u4EF6\u8DEF\u5F84\uFF08\u907F\u514D agent \u63A2\u6D4B\u672C\u673A\u78C1\u76D8\uFF09\u3002\u8BF7\u8BA9\u7528\u6237\u81EA\u5DF1\u5728\u6D4F\u89C8\u5668\u91CC\u6253\u5F00\u8BE5\u6587\u4EF6\uFF0C\u6253\u5F00\u540E\u518D\u7528 read_current_page / switch_tab \u8BFB\u53D6\u5B83\u3002"
      };
    }
    if (!/^https?:\/\//i.test(url)) return { ok: false, result: "open_tab \u4EC5\u652F\u6301 http/https \u94FE\u63A5\uFF1A" + url };
    const forceNew = args.newTab === true;
    const isolated = ctx.browsingMode === "isolated";
    if (!forceNew) {
      const existing = await deps.chrome.tabs.query({ url }).catch(() => []);
      const hit = Array.isArray(existing) && existing.find((t2) => t2.id && /^https?:/i.test(t2.url || ""));
      if (hit) {
        const alreadyActive = Number(ctx.tabId) === Number(hit.id) && hit.active !== false;
        const budget2 = tabSwitchBudget(ctx);
        let activated = false;
        let switchSuppressed = false;
        if (!isolated && !alreadyActive) {
          if (budget2.exhausted) {
            switchSuppressed = true;
          } else {
            await deps.chrome.tabs.update(hit.id, { active: true });
            countTabSwitch(ctx);
            activated = true;
          }
        }
        const snapshot2 = await deps.waitForTabReady(hit.id, 5e3);
        const current2 = await deps.chrome.tabs.get(hit.id).catch(() => hit);
        const targetTab2 = {
          tabId: hit.id,
          windowId: current2.windowId || hit.windowId,
          title: current2.title || hit.title || "",
          url: current2.url || hit.url || url,
          ready: Boolean(snapshot2)
        };
        deps.bindSessionTab(hit.id);
        return {
          ok: true,
          reused: true,
          activated,
          targetTabId: hit.id,
          targetTab: targetTab2,
          pageSnapshot: snapshot2,
          result: "\u5DF2\u590D\u7528\u5DF2\u6253\u5F00\u7684\u6807\u7B7E\u9875 tabId=" + hit.id + "\uFF1A" + targetTab2.url + (snapshot2 ? "\uFF08\u9875\u9762\u5DF2\u5C31\u7EEA\uFF09" : "\uFF08\u5185\u5BB9\u811A\u672C\u5C1A\u672A\u5C31\u7EEA\uFF09") + (alreadyActive ? "\n\u8BE5\u9875\u5DF2\u662F\u5F53\u524D\u5DE5\u4F5C\u9875\uFF0C\u65E0\u9700\u518D\u5207\u6362\u3002" : activated ? "\n\u8BF7\u7559\u5728\u8BE5\u9875\u5B8C\u6210\u64CD\u4F5C\uFF0C\u4E0D\u8981\u4E3A\u9A8C\u8BC1/\u5BF9\u6BD4\u53CD\u590D\u5207\u56DE\u3002" : switchSuppressed ? "\n" + tabSwitchLimitMessage(budget2.used, budget2.max) + "\u5DF2\u7ED1\u5B9A\u76EE\u6807\u9875\u4F46\u672A\u5207\u5230\u524D\u53F0\uFF0C\u540E\u7EED\u53EF\u76F4\u63A5\u8BFB\u53D6/\u64CD\u4F5C\u3002" : "")
        };
      }
    }
    const openedCount = Number(ctx.openedTabCount || 0);
    if (openedCount >= Number(ctx.maxOpenedTabs || 5)) {
      const summary = await deps.listOpenedTabsSummary(ctx).catch(() => "");
      return {
        ok: false,
        blocked: true,
        result: "\u672C\u4EFB\u52A1\u5DF2\u65B0\u5EFA " + openedCount + " \u4E2A\u6807\u7B7E\u9875\uFF0C\u8FBE\u5230\u4E0A\u9650\uFF08" + (ctx.maxOpenedTabs || 5) + "\uFF09\uFF0C\u7981\u6B62\u7EE7\u7EED\u65B0\u5EFA\u3002" + (summary ? "\n\u5F53\u524D\u5DF2\u6253\u5F00\u7684\u6807\u7B7E\u9875\uFF1A\n" + summary : "") + "\u8BF7\u6539\u7528 switch_tab \u590D\u7528\u4E0A\u9762\u7684\u6807\u7B7E\u9875\uFF08tabId\uFF09\uFF0C\u6216\u6539\u7528 fetch_webpage \u76F4\u63A5\u6293\u53D6\u5185\u5BB9\uFF1B\u4E0D\u8981\u518D\u8C03\u7528 open_tab\u3002"
      };
    }
    const budget = tabSwitchBudget(ctx);
    const openActive = !isolated && !budget.exhausted;
    const t = isolated ? await deps.chrome.tabs.create({ url, windowId: await deps.ensureAgentWindow(ctx), active: false }) : await deps.chrome.tabs.create({ url, active: openActive });
    if (!t || !t.id) return { ok: false, result: "\u6253\u5F00\u6807\u7B7E\u9875\u5931\u8D25\uFF1A\u6D4F\u89C8\u5668\u672A\u8FD4\u56DE tabId" };
    if (openActive) countTabSwitch(ctx);
    ctx.openedTabCount = openedCount + 1;
    deps.trackOpenedTab(ctx, t.id);
    const snapshot = await deps.waitForTabReady(t.id, 8e3);
    deps.bindSessionTab(t.id);
    const current = await deps.chrome.tabs.get(t.id).catch(() => t);
    const targetTab = {
      tabId: t.id,
      windowId: current.windowId || t.windowId,
      title: current.title || t.title || "",
      url: current.url || t.url || args && args.url || "",
      ready: Boolean(snapshot)
    };
    return {
      ok: true,
      activated: openActive,
      targetTabId: t.id,
      targetTab,
      pageSnapshot: snapshot,
      result: (openActive ? "\u5DF2\u5728\u65B0\u6807\u7B7E\u9875\u6253\u5F00\u5E76\u7ED1\u5B9A\uFF1A" : "\u5DF2\u5728\u65B0\u6807\u7B7E\u9875\uFF08\u540E\u53F0\uFF09\u6253\u5F00\u5E76\u7ED1\u5B9A\uFF1A") + "tabId=" + t.id + " " + (t.url || args && args.url) + (snapshot ? "\uFF08\u9875\u9762\u5DF2\u5C31\u7EEA\uFF09" : "\uFF08\u5185\u5BB9\u811A\u672C\u5C1A\u672A\u5C31\u7EEA\uFF09") + (!openActive && !isolated ? "\n" + tabSwitchLimitMessage(budget.used, budget.max) : "")
    };
  } catch (e) {
    return { ok: false, result: "\u6253\u5F00\u6807\u7B7E\u9875\u5931\u8D25\uFF1A" + e.message };
  }
}
async function handleTabTool(name, args, deps) {
  if (name === "list_tabs") return await listTabs(deps);
  if (name === "switch_tab") return await switchTab(deps, args);
  if (name === "open_tab") return await openTab(deps, args);
  return null;
}

// lib/assistant/run-metrics.js
var num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
function summarizeRunTrace(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const tools = list.filter((e) => e && e.phase === "tool");
  const turns = list.filter((e) => e && e.phase === "turn-timing");
  const cache = list.filter((e) => e && e.phase === "cache");
  const complete = list.find((e) => e && e.phase === "complete") || {};
  const byTool = {};
  for (const t of tools) byTool[t.name] = (byTool[t.name] || 0) + 1;
  const hit = cache.reduce((n, e) => n + num(e.hit), 0);
  const miss = cache.reduce((n, e) => n + num(e.miss), 0);
  const totalMs = turns.reduce((n, e) => n + num(e.totalMs), 0);
  return {
    rounds: turns.length,
    toolCalls: tools.length,
    failedTools: tools.filter((t) => t.ok === false).length,
    expandResultRounds: tools.filter((t) => t.name === "expand_result").length,
    byTool,
    cache: { hit, miss, ratio: hit + miss > 0 ? Math.round(hit / (hit + miss) * 100) : null },
    totalMs: Math.round(totalMs),
    prefillMs: Math.round(turns.reduce((n, e) => n + num(e.prefillMs), 0)),
    decodeMs: Math.round(turns.reduce((n, e) => n + num(e.decodeMs), 0)),
    totalTokens: num(complete.totalTokens),
    errors: list.filter((e) => e && e.phase === "error").length,
    timeouts: list.filter((e) => e && e.phase === "timeout").length,
    collapsed: list.filter((e) => e && e.phase === "collapse").length,
    repaired: list.filter((e) => e && e.phase === "conversation-repair").length
  };
}
function formatRunMetrics(m) {
  const sec = (ms) => (Math.round(ms / 100) / 10).toFixed(1) + "s";
  const lines = [
    "\u6307\u6807\u6458\u8981\uFF1A",
    "\u8F6E\u6B21 " + m.rounds + " / \u5DE5\u5177\u8C03\u7528 " + m.toolCalls + "\uFF08\u5931\u8D25 " + m.failedTools + "\uFF09",
    "\u5C55\u5F00\u5927\u7ED3\u679C " + m.expandResultRounds + " \u6B21 / \u5386\u53F2\u6298\u53E0 " + m.collapsed + " / \u7ED3\u6784\u4FEE\u590D " + m.repaired,
    "\u8017\u65F6 " + sec(m.totalMs) + "\uFF08prefill " + sec(m.prefillMs) + " / decode " + sec(m.decodeMs) + "\uFF09",
    "\u7D2F\u8BA1 token " + m.totalTokens + (m.cache.ratio == null ? "" : " / \u524D\u7F00\u7F13\u5B58\u547D\u4E2D\u7387 " + m.cache.ratio + "%")
  ];
  const by = Object.entries(m.byTool || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + "\xD7" + n);
  if (by.length) lines.push("\u6309\u5DE5\u5177\uFF1A" + by.join("\u3001"));
  return lines.join("\n");
}

// lib/assistant/run-state-tools.js
function updatePlan(ctx, args) {
  const raw = Array.isArray(args && args.items) ? args.items : [];
  const plan = raw.filter((it) => it && typeof it.text === "string" && it.text.trim()).slice(0, 20).map((it) => ({
    text: sliceSafe(String(it.text).trim(), 0, 120),
    status: ["pending", "in_progress", "done"].includes(it.status) ? it.status : "pending"
  }));
  ctx.plan = plan;
  const text = plan.map((p, i) => (p.status === "done" ? "\u2713" : p.status === "in_progress" ? "\u25B6" : "\u25CB") + " " + (i + 1) + ". " + p.text).join("\n");
  return { result: "\u8BA1\u5212\u5DF2\u66F4\u65B0\uFF08" + plan.length + " \u6B65\uFF09\uFF1A\n" + (text || "\uFF08\u7A7A\u8BA1\u5212\uFF09") };
}
function expandResult(ctx, args) {
  const id = String(args && args.id || "").trim();
  const store = ctx && ctx.resultStore;
  const text = store && typeof store.get === "function" ? store.get(id) : null;
  if (!text) {
    const known = ctx && ctx.resultIds && typeof ctx.resultIds.has === "function" && ctx.resultIds.has(id);
    return {
      ok: false,
      result: "\u672A\u627E\u5230\u7ED3\u679C id=" + id + (known ? "\uFF1A\u8BE5\u7ED3\u679C\u5C5E\u4E8E**\u4E0A\u4E00\u8F6E\u8FD0\u884C**\uFF0C\u5185\u5BB9\u5DF2\u91CA\u653E\uFF08\u5927\u7ED3\u679C\u6682\u5B58\u4E0D\u8DE8\u6062\u590D\u4FDD\u7559\uFF09\u3002\u8BF7\u91CD\u65B0\u6267\u884C\u5BF9\u5E94\u5DE5\u5177\u8BFB\u53D6\u5F53\u524D\u5185\u5BB9\u3002" : "\uFF1A\u8BF7\u786E\u8BA4 id \u662F\u5426\u6B63\u786E\uFF08\u5F62\u5982 res-12\uFF09\u3002\u5927\u7ED3\u679C\u6682\u5B58\u53EA\u5728\u672C\u6B21\u8FD0\u884C\u5185\u6709\u6548\uFF0C\u91CD\u65B0\u8BFB\u53D6\u9875\u9762\u65F6\u4F1A\u751F\u6210\u65B0\u7684 id\u3002")
    };
  }
  const offset = Math.max(0, Number(args.offset) || 0);
  const limit = Math.min(4e3, Math.max(200, Number(args.limit) || 2e3));
  const piece = rangeSafe(text, offset, offset + limit);
  return {
    ok: true,
    result: "\u7ED3\u679C " + id + " [" + piece.start + "," + piece.end + ") / \u5171 " + piece.length + " \u5B57\u7B26\uFF1A\n" + piece.text
  };
}
async function getRunTrace(deps, args) {
  const rec = args && args.runId ? await deps.getTrace(String(args.runId)) : (await deps.listTraces())[0];
  if (!rec) return { ok: true, result: "\u6682\u65E0\u8FD0\u884C\u8F68\u8FF9\u3002" };
  const lines = (rec.entries || []).map((e) => {
    const t = new Date(e.ts).toLocaleTimeString("zh-CN");
    if (e.phase === "tool") return t + " [tool] " + e.name + " " + (e.ok ? "\u2713" : "\u2717") + " " + (e.ms || 0) + "ms " + (e.args || "");
    if (e.phase === "start") return t + " [start] intent=" + e.intent + " " + (e.instruction || "");
    if (e.phase === "complete") return t + " [complete] " + (e.reason || "") + " tokens=" + (e.totalTokens || 0);
    if (e.phase === "timeout") return t + " [timeout] " + (e.reason || "");
    if (e.phase === "error") return t + " [error] " + (e.error || "");
    return t + " [" + e.phase + "]";
  });
  const summary = formatRunMetrics(summarizeRunTrace(rec.entries));
  return { ok: true, result: "\u8FD0\u884C\u8F68\u8FF9 " + rec.runId + "\uFF08" + lines.length + " \u6761\uFF09\uFF1A\n" + lines.join("\n") + "\n\n" + summary };
}
async function handleRunStateTool(name, args, deps) {
  if (name === "update_plan") return updatePlan(deps.ctx, args);
  if (name === "expand_result") return expandResult(deps.ctx, args);
  if (name === "get_run_trace") return await getRunTrace(deps, args);
  return null;
}

// lib/assistant/permission-tools.js
async function trustSite(deps) {
  const ctx = deps.ctx;
  const origin = siteKeyOf(ctx.pageUrl);
  if (!origin) return { ok: false, result: "\u65E0\u6CD5\u786E\u5B9A\u5F53\u524D\u7AD9\u70B9\u3002" };
  const list = Array.isArray(ctx.settings.trustedSites) ? ctx.settings.trustedSites.slice() : [];
  if (!list.includes(origin)) list.push(origin);
  ctx.settings.trustedSites = list;
  try {
    await deps.chrome.storage.local.set({ aiSettings: Object.assign({}, ctx.settings, { trustedSites: list }) });
  } catch (e) {
  }
  return {
    ok: true,
    result: "\u5DF2\u4FE1\u4EFB\u7AD9\u70B9 " + origin + "\uFF1A\u6B64\u7AD9\u70B9\u7684\u5199\u64CD\u4F5C\u5C06\u4E0D\u518D\u9010\u6B21\u786E\u8BA4\uFF08\u7528\u6237\u811A\u672C / \u6280\u80FD\u5199\u5165\u7B49\u9AD8\u98CE\u9669\u5DE5\u5177\u4ECD\u6BCF\u6B21\u786E\u8BA4\uFF09\u3002"
  };
}
async function handleDialogTool(deps, args) {
  const ctx = deps.ctx;
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: "\u5904\u7406\u5BF9\u8BDD\u6846\u9700\u8981 CDP\uFF08\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u5F00\u542F\uFF09\u3002" };
  try {
    await deps.handleDialog(ctx.tabId, args.accept !== false, args.promptText);
    return { ok: true, result: (args.accept !== false ? "\u5DF2\u63A5\u53D7" : "\u5DF2\u53D6\u6D88") + "\u9875\u9762\u5BF9\u8BDD\u6846\u3002" };
  } catch (e) {
    return { ok: false, result: "\u5904\u7406\u5BF9\u8BDD\u6846\u5931\u8D25\uFF1A" + deps.summarizeCdpError(e) };
  }
}
async function handlePermissionTool(name, args, deps) {
  if (name === "trust_site") return await trustSite(deps);
  if (name === "handle_dialog") return await handleDialogTool(deps, args);
  return null;
}

// lib/shared/screenshot-store.ts
var SHOT_KEY = "recallflow.shots.v1";
var SHOT_INDEX_KEY = "recallflow.shots.index.v1";
var SHOT_ITEM_PREFIX = "recallflow.shots.item.v1.";
var MAX_SHOTS = 3;
var MAX_SHOTS_PER_SESSION = 20;
var MAX_SHOTS_TOTAL = 60;
var MAX_SHOT_STORE_CHARS = 42e4;
function shotStorageKey(id) {
  return SHOT_ITEM_PREFIX + String(id || "");
}
function localArea(chromeApi) {
  return chromeApi && chromeApi.storage && chromeApi.storage.local ? chromeApi.storage.local : null;
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
var writeTail = Promise.resolve();
function enqueueWrite(fn) {
  const run = writeTail.then(fn, fn);
  writeTail = run.catch(() => {
  });
  return run;
}
function pruneIndex2(index) {
  const entries = Object.values(index).filter((entry) => isRecord(entry) && entry.id).sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  const keep = /* @__PURE__ */ new Set();
  const bySession = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const key = String(entry.sessionId || "");
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(entry);
  }
  for (const list of bySession.values()) {
    for (const entry of list.slice(-MAX_SHOTS_PER_SESSION)) keep.add(String(entry.id));
  }
  const remaining = entries.filter((entry) => keep.has(String(entry.id)));
  const overflow = Math.max(0, remaining.length - MAX_SHOTS_TOTAL);
  for (let i = 0; i < overflow; i++) keep.delete(String(remaining[i].id));
  for (const id of Object.keys(index)) {
    if (!keep.has(String(id))) delete index[id];
  }
  return index;
}
function saveScreenshot(chromeApi, shot, sessionId = "") {
  const area2 = localArea(chromeApi);
  const id = String(shot && shot.id || "");
  const dataUrl = String(shot && shot.dataUrl || "");
  if (!area2 || !id || !dataUrl) return Promise.resolve(false);
  if (dataUrl.length > MAX_SHOT_STORE_CHARS) return Promise.resolve(false);
  return enqueueWrite(async () => {
    try {
      const cur = await area2.get([SHOT_KEY, SHOT_INDEX_KEY]);
      const archive = Array.isArray(cur && cur[SHOT_KEY]) ? cur[SHOT_KEY] : [];
      const index = isRecord(cur && cur[SHOT_INDEX_KEY]) ? Object.assign({}, cur[SHOT_INDEX_KEY]) : {};
      const record = Object.assign({}, shot, {
        id,
        sessionId: String(sessionId || shot && shot.sessionId || ""),
        createdAt: Number(shot && shot.createdAt) || Date.now(),
        bytes: Number(shot && shot.bytes) || Math.round(dataUrl.length * 3 / 4)
      });
      index[id] = {
        id,
        sessionId: record.sessionId,
        createdAt: record.createdAt,
        bytes: record.bytes
      };
      pruneIndex2(index);
      const nextArchive = archive.filter((entry) => entry && entry.id !== id).concat([record]).slice(-MAX_SHOTS);
      await area2.set({
        [SHOT_KEY]: nextArchive,
        [SHOT_INDEX_KEY]: index,
        [shotStorageKey(id)]: record
      });
      const stale = Object.keys(cur && cur[SHOT_INDEX_KEY] || {}).filter((oldId) => !index[oldId]).map(shotStorageKey);
      if (stale.length && typeof area2.remove === "function") {
        try {
          await area2.remove(stale);
        } catch (e) {
        }
      }
      return true;
    } catch (e) {
      return false;
    }
  });
}

// lib/assistant/screenshot-tool.js
var MAX_SHOT_B64 = 4e5;
var DEFAULT_SCREENSHOT_BUDGET_MS = 12e3;
async function captureWithLadder(deps) {
  const ladder = Array.isArray(deps.ladder) && deps.ladder.length ? deps.ladder : [{ format: "jpeg", quality: 72 }];
  const budgetMs = Number(deps.budgetMs) > 0 ? Number(deps.budgetMs) : DEFAULT_SCREENSHOT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  let data = "";
  let used = ladder[0];
  let usedIndex = 0;
  let timedOut = false;
  for (let i = 0; i < ladder.length; i++) {
    const remain = deadline - Date.now();
    if (remain <= 0) {
      timedOut = true;
      break;
    }
    const step = ladder[i];
    try {
      data = await deps.cdp.screenshot(deps.tabId, {
        format: step.format,
        quality: step.quality,
        fullPage: deps.fullPage === true,
        timeoutMs: remain
      });
    } catch (e) {
      data = "";
      if (/未响应|超时/.test(String(e && e.message || ""))) timedOut = true;
    }
    used = step;
    usedIndex = i;
    if (data && data.length <= MAX_SHOT_B64) break;
  }
  return { data, used, usedIndex, degraded: usedIndex > 0, timedOut, deadline };
}
async function takeScreenshot(deps) {
  const ctx = deps.ctx;
  const args = deps.args || {};
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: "\u622A\u56FE\u9700\u8981 CDP\uFF1A\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u5F00\u542F\u300C\u6D4F\u89C8\u5668\u7EA7\u8F93\u5165\u5C42\uFF08CDP\uFF09\u300D\u3002" };
  if (!ctx.tabId) return { ok: false, result: "\u65E0\u6CD5\u5B9A\u4F4D\u5F53\u524D\u6807\u7B7E\u9875\uFF08\u53EF\u80FD\u4E0D\u5728\u524D\u53F0\u9875\u9762\uFF09\u3002" };
  const wantPng = args.format === "png";
  const ladder = deps.screenshotAttempts(wantPng ? "png" : "jpeg", args.quality);
  const budgetMs = Number(deps.screenshotBudgetMs) > 0 ? Number(deps.screenshotBudgetMs) : DEFAULT_SCREENSHOT_BUDGET_MS;
  const shot = await captureWithLadder({ cdp: deps.cdp, tabId: ctx.tabId, ladder, budgetMs, fullPage: args.fullPage === true });
  const data = shot.data;
  const used = shot.used;
  const usedIndex = shot.usedIndex;
  const timedOut = shot.timedOut;
  if (!data) {
    return {
      ok: false,
      result: timedOut ? "\u622A\u56FE\u8D85\u65F6\uFF1ACDP \u672A\u5728 " + budgetMs + "ms \u9884\u7B97\u5185\u54CD\u5E94\uFF08\u9875\u9762\u8FC7\u91CD\u6216\u8C03\u8BD5\u5668\u88AB\u5360\u7528\uFF09\u3002\u53EF\u5148\u6EDA\u52A8\u5230\u76EE\u6807\u533A\u57DF\u518D\u622A\uFF0C\u6216\u6539\u7528 get_page_snapshot / get_ax_snapshot \u53D6\u7ED3\u6784\u5316\u4FE1\u606F\u3002" : "\u622A\u56FE\u5931\u8D25\uFF1ACDP \u65E0\u6CD5\u9644\u52A0\u5230\u8BE5\u6807\u7B7E\u9875\uFF08\u53EF\u80FD\u88AB\u5176\u5B83\u8C03\u8BD5\u5DE5\u5177\u5360\u7528\uFF09\u3002"
    };
  }
  let width = 0;
  let height = 0;
  try {
    const remainForMetrics = Math.max(400, shot.deadline - Date.now());
    const m = await deps.cdp.command(ctx.tabId, "Page.getLayoutMetrics", {}, { timeoutMs: remainForMetrics });
    const box = args.fullPage === true ? m.cssContentSize || m.contentSize : m.cssVisualViewport || m.visualViewport;
    if (box) {
      width = Math.round(box.clientWidth || box.width || 0);
      height = Math.round(box.clientHeight || box.height || 0);
    }
  } catch (e) {
  }
  const bytes = Math.round(data.length * 3 / 4);
  const id = "shot-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  const mime = used.format === "png" ? "png" : "jpeg";
  const label = String(args.label || "").slice(0, 60);
  const stored = await deps.saveScreenshot(
    deps.chrome,
    { id, label, dataUrl: "data:image/" + mime + ";base64," + data, width, height, bytes },
    ctx.sessionId
  );
  return {
    ok: true,
    readOnly: true,
    // 给面板渲染用：base64 在这里，但 agent.js 只把它转成事件，绝不写入模型消息。
    screenshot: { id, dataUrl: "data:image/" + mime + ";base64," + data, label, width, height, bytes, archived: stored },
    result: deps.formatScreenshotSummary({
      width,
      height,
      format: used.format,
      quality: used.quality,
      bytes,
      label,
      degraded: usedIndex > 0
    }) + (stored ? "\uFF08\u56FE\u7247\u5DF2\u5F52\u6863\uFF0C\u53EF\u7ECF MCP \u53D6\u56DE\uFF09" : "")
  };
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

// lib/assistant/page-input-tools.js
async function readEditableValue(deps, tabId, selector, isSubframe, frameId) {
  const sel = JSON.stringify(String(selector || ""));
  const expr = "(() => { /* rf-read-editable */ const el = document.querySelector(" + sel + '); if (!el) return null; if (el.isContentEditable) return String(el.innerText !== undefined ? el.innerText : el.textContent || ""); return typeof el.value === "string" ? el.value : null; })()';
  try {
    return isSubframe ? await deps.cdp.evaluateInFrame(tabId, frameId, expr) : await deps.cdp.evaluate(tabId, expr);
  } catch (e) {
    return null;
  }
}
async function typeText(deps, args) {
  let res;
  try {
    res = await deps.executeContentAction(deps.ctx.tabId, "type_text", { type: "kbTypeText", params: args }, { delayMs: 80 });
  } catch (e) {
    res = { ok: false, result: "\u8F93\u5165\u6587\u672C\u5931\u8D25\uFF1A" + e.message };
  }
  if (res && res.ok !== false && res.matchesIntent !== false && res.partial !== true) return res;
  const typeFrame = deps.frameIdFromArgs(args);
  if (!deps.cdpAllowed(deps.ctx)) return res;
  const target = await deps.resolveTarget(deps.ctx.tabId, args);
  if (!target) return res;
  const isSubframe = typeFrame != null && typeFrame !== 0;
  try {
    const sel = JSON.stringify(target.selector);
    const focusExpr = "(() => { const el = document.querySelector(" + sel + '); if (!el) return false; el.focus(); if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = window.getSelection(); if (s) { s.removeAllRanges(); s.addRange(r); } } else if (typeof el.setSelectionRange === "function" && typeof el.value === "string") el.setSelectionRange(el.value.length, el.value.length); return true; })()';
    if (isSubframe) await deps.cdp.evaluateInFrame(deps.ctx.tabId, typeFrame, focusExpr);
    else await deps.cdp.evaluate(deps.ctx.tabId, focusExpr);
    const text = String(args.value == null ? "" : args.value);
    const beforeValue = await readEditableValue(deps, deps.ctx.tabId, target.selector, isSubframe, typeFrame);
    const expected = args.clearFirst === true ? text : String(beforeValue == null ? "" : beforeValue) + text;
    if (args.clearFirst === true) await deps.cdp.pressKey(deps.ctx.tabId, "a", ["CTRL"]);
    let strategy = "cdp-insertText";
    if (target.contentEditable && text.includes("\n")) {
      strategy = "cdp-line-by-line";
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await deps.cdp.pressKey(deps.ctx.tabId, "Enter");
        if (lines[i] || i === 0) await deps.cdp.insertText(deps.ctx.tabId, lines[i]);
      }
    } else {
      await deps.cdp.insertText(deps.ctx.tabId, text);
    }
    const actualValue = await readEditableValue(deps, deps.ctx.tabId, target.selector, isSubframe, typeFrame);
    const summary = editableTextSummary(expected, actualValue == null ? "" : actualValue);
    const verified = actualValue !== null && actualValue !== void 0 && summary.matchesIntent;
    if (verified) deps.rememberTarget(deps.ctx, target);
    const before = deps.ctx.lastSnapshot || null;
    const after = await deps.getPageSnapshot(deps.ctx.tabId, { maxElements: 40, maxText: 1e3, frameId: isSubframe ? typeFrame : void 0 }).catch(() => null);
    const result = {
      ok: verified,
      partial: !verified,
      hadEffect: deps.observedChange(before, after) === "changed",
      cdp: true,
      strategy,
      matchesIntent: verified,
      expectedLength: summary.expectedLength,
      actualLength: summary.actualLength,
      firstDifference: summary.firstDifference,
      pageSnapshot: after,
      verification: deps.buildActionVerification(
        deps.observedChange(before, after),
        verified ? "\u5DF2\u7528 CDP \u53EF\u4FE1\u8F93\u5165\uFF0C\u5E76\u56DE\u8BFB\u786E\u8BA4" : "CDP \u5DF2\u8F93\u5165\uFF0C\u4F46\u56DE\u8BFB\u503C\u4E0E\u9884\u671F\u4E0D\u4E00\u81F4"
      ),
      result: verified ? "\u5DF2\u7528 CDP \u53EF\u4FE1\u8F93\u5165 " + text.length + " \u4E2A\u5B57\u7B26\uFF08" + strategy + "\uFF0C\u5DF2\u56DE\u8BFB\u786E\u8BA4\uFF09" + (after ? "\n" + deps.compactSnapshotSummary(after) : "") : "CDP \u8F93\u5165\u672A\u8FBE\u5230\u9884\u671F\uFF08" + strategy + "\uFF09\uFF1A\u9884\u671F " + summary.expectedLength + " \u5B57\u7B26\uFF0C\u5B9E\u9645 " + (actualValue == null ? "\u65E0\u6CD5\u56DE\u8BFB" : summary.actualLength + " \u5B57\u7B26") + (summary.firstDifference.index >= 0 ? "\uFF0C\u9996\u4E2A\u5DEE\u5F02\u5728 " + summary.firstDifference.index : "") + "\u3002\u5B9E\u9645\u503C\uFF1A" + JSON.stringify(String(actualValue == null ? "" : actualValue).slice(0, 120)) + "\u3002\u4E0D\u8981\u5047\u8BBE\u5DF2\u5199\u5165\uFF0C\u8BF7\u6539\u7528\u7C98\u8D34/\u7F16\u8F91\u5668\u4E13\u7528\u5199\u5165\u6216\u68C0\u67E5\u76EE\u6807\u662F\u5426\u88AB\u9875\u9762\u63A5\u7BA1\u3002" + (after ? "\n" + deps.compactSnapshotSummary(after) : "")
    };
    if (result.verification) {
      result.verification.verified = verified && result.verification.verified;
    }
    return result;
  } catch (e) {
    return res || { ok: false, result: "CDP \u8F93\u5165\u5931\u8D25\uFF1A" + deps.summarizeCdpError(e) };
  }
}
async function pressKey2(deps, args) {
  let res;
  try {
    res = await deps.executeContentAction(deps.ctx.tabId, "press_key", { type: "kbPressKey", params: args }, { delayMs: 120 });
  } catch (e) {
    res = { ok: false, result: "\u6D3E\u53D1\u952E\u76D8\u4E8B\u4EF6\u5931\u8D25\uFF1A" + e.message };
  }
  if (res && res.ok !== false) return res;
  if (!deps.cdpAllowed(deps.ctx)) return res;
  try {
    await deps.cdp.pressKey(deps.ctx.tabId, String(args.key || ""), args.modifiers);
    const before = deps.ctx.lastSnapshot || null;
    const after = await deps.getPageSnapshot(deps.ctx.tabId, { maxElements: 40, maxText: 1e3 }).catch(() => null);
    return {
      ok: true,
      hadEffect: deps.observedChange(before, after) === "changed",
      cdp: true,
      pageSnapshot: after,
      verification: deps.buildActionVerification(deps.observedChange(before, after), "\u5DF2\u7528 CDP \u6D3E\u53D1\u6309\u952E"),
      result: "\u5DF2\u7528 CDP \u6D3E\u53D1\u6309\u952E\uFF1A" + args.key + (after ? "\n" + deps.compactSnapshotSummary(after) : "")
    };
  } catch (e) {
    return res || { ok: false, result: "CDP \u6309\u952E\u5931\u8D25\uFF1A" + deps.summarizeCdpError(e) };
  }
}
var THIN_PAGE_COMMANDS = Object.freeze({
  select_option: { message: "kbSelectOption", label: "\u9009\u62E9\u4E0B\u62C9\u9879", opts: { delayMs: 100 } },
  check_box: { message: "kbCheckBox", label: "\u5207\u6362\u590D\u9009\u6846", opts: { delayMs: 100 } },
  wait_for_element: { message: "kbWaitForElement", label: "\u7B49\u5F85\u5143\u7D20", opts: { verify: false } },
  get_attribute: { message: "kbGetAttribute", label: "\u8BFB\u53D6\u5C5E\u6027", opts: { verify: false } }
});
async function thinPageCommand(deps, name, args) {
  const spec = THIN_PAGE_COMMANDS[name];
  if (!spec) return null;
  try {
    return await deps.executeContentAction(deps.ctx.tabId, name, { type: spec.message, params: args }, spec.opts);
  } catch (e) {
    return { ok: false, result: spec.label + "\u5931\u8D25\uFF1A" + e.message };
  }
}
async function handlePageInputTool(name, args, deps) {
  if (name === "type_text") return await typeText(deps, args);
  if (name === "press_key") return await pressKey2(deps, args);
  return await thinPageCommand(deps, name, args);
}

// lib/assistant/auth-challenge.js
var AUTH_PATH_RE = /(?:^|\/)(?:login|log-in|signin|sign-in|sign_in|passport|sso|auth)(?:\/|$)/i;
var MCP_PATH_RE = /(?:^|\/)mcp(?:\/|$)/i;
var MCP_HINT_RE = /(mcp[-_ ]?session|mcp\s*(?:server|服务器|端点)|jsonrpc|streamable\s*http)/i;
var LOGIN_COPY_RE = /(请先登录|需要登录|必须登录|未登录|尚未登录|登录后(?:继续|重试|查看|访问|使用)|登录以继续|去登录|立即登录|扫码登录|sign\s*in\s+to\s+continue|log\s*in\s+to\s+continue|please\s+(?:sign\s*in|log\s*in)|login\s+required|authentication\s+required)/i;
var DENY_COPY_RE = /(无权限|没有权限|权限不足|无权访问|访问受限|拒绝访问|禁止访问|permission\s+denied|access\s+denied|not\s+authori[sz]ed|forbidden|unauthorized|http\s*(?:401|403)|状态码\s*(?:401|403))/i;
var LOGIN_AFFORDANCE_RE = /(登录|登入|去登录|立即登录|登录后继续|sign\s*in|log\s*in)/i;
var NO_EFFECT_RE = /(未产生|没有产生|暂未观察|无变化|没有变化|unchanged|no\s+observable)/i;
var MUTATING_TOOLS = /* @__PURE__ */ new Set([
  "open_tab",
  "switch_tab",
  "fetch_webpage",
  "click_element",
  "click_at",
  "type_text",
  "press_key",
  "select_option",
  "check_box",
  "hover_element",
  "drag_element",
  "upload_file",
  "scroll_page",
  "annotate",
  "run_javascript"
]);
function asHttpUrl(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const base = baseUrl ? String(baseUrl) : void 0;
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.username = "";
    u.password = "";
    return u.href;
  } catch (e) {
    return "";
  }
}
function withoutHash(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch (e) {
    return String(url || "");
  }
}
function isAuthUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return AUTH_PATH_RE.test(decodeURIComponent(u.pathname || ""));
  } catch (e) {
    return false;
  }
}
function isMcpEndpoint(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return MCP_PATH_RE.test(decodeURIComponent(u.pathname || ""));
  } catch (e) {
    return false;
  }
}
function snapshotHaystack(snapshot) {
  const s = snapshot && typeof snapshot === "object" ? snapshot : {};
  const elements = Array.isArray(s.elements) ? s.elements : [];
  const elementText = elements.slice(0, 120).map((e) => [e && e.label, e && e.placeholder, e && e.name, e && e.href].filter(Boolean).join(" ")).join("\n");
  return [s.title, s.text, elementText].filter(Boolean).join("\n").slice(0, 16e3);
}
function findLoginLink(snapshot, baseUrl) {
  const s = snapshot && typeof snapshot === "object" ? snapshot : {};
  const elements = Array.isArray(s.elements) ? s.elements : [];
  let best = null;
  for (const e of elements) {
    if (!e || typeof e !== "object" || !e.href) continue;
    const label = String(e.label || e.placeholder || e.name || "").trim();
    const hrefText = String(e.href || "").trim();
    if (!LOGIN_AFFORDANCE_RE.test(label) && !isAuthUrl(asHttpUrl(hrefText, baseUrl))) continue;
    const url = asHttpUrl(hrefText, baseUrl || s.url);
    if (!url) continue;
    let score = 0;
    if (LOGIN_AFFORDANCE_RE.test(label)) score += 4;
    if (isAuthUrl(url)) score += 6;
    if (String(e.tag || "").toLowerCase() === "a" || String(e.role || "").toLowerCase() === "link") score += 1;
    if (!best || score > best.score) {
      best = { url, label: label || "\u767B\u5F55\u9875", score };
    }
  }
  return best ? { url: best.url, label: best.label } : null;
}
function fallbackLoginUrl(currentUrl) {
  try {
    const u = new URL(currentUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.origin + "/login";
  } catch (e) {
    return "";
  }
}
function detectAuthChallenge(input) {
  const data = input && typeof input === "object" ? input : {};
  const snapshot = data.snapshot && typeof data.snapshot === "object" ? data.snapshot : null;
  const beforeUrl = asHttpUrl(data.beforeUrl);
  const currentUrl = asHttpUrl(data.afterUrl) || asHttpUrl(snapshot && snapshot.url) || beforeUrl;
  const resultText = String(data.result || "").slice(0, 12e3);
  const pageText = snapshotHaystack(snapshot);
  const haystack = [pageText, resultText].filter(Boolean).join("\n");
  const ok = data.ok !== false;
  const statusCode = Number(data.statusCode) || 0;
  const toolName = String(data.toolName || "");
  const authPath = isAuthUrl(currentUrl);
  const beforeAuthPath = isAuthUrl(beforeUrl);
  const navigatedToAuth = authPath && (!beforeUrl || !beforeAuthPath && withoutHash(beforeUrl) !== withoutHash(currentUrl));
  const loginCopy = LOGIN_COPY_RE.test(haystack);
  const denyCopy = DENY_COPY_RE.test(haystack);
  const resultHasAuth = !ok && (LOGIN_COPY_RE.test(resultText) || DENY_COPY_RE.test(resultText));
  const statusHasAuth = statusCode === 401 || statusCode === 403;
  const link = findLoginLink(snapshot, currentUrl || beforeUrl);
  const pageTitleLooksLikeLogin = /(登录|登陆|登入|sign\s*in|log\s*in)/i.test(
    String(snapshot && snapshot.title || "")
  );
  const wallDetected = navigatedToAuth || resultHasAuth || statusHasAuth || !ok && (loginCopy || denyCopy) || MUTATING_TOOLS.has(toolName) && loginCopy && Boolean(link) || MUTATING_TOOLS.has(toolName) && pageTitleLooksLikeLogin && loginCopy && Boolean(link) || loginCopy && Boolean(link) && NO_EFFECT_RE.test(resultText);
  if (!wallDetected) return null;
  const mcpEndpoint = isMcpEndpoint(currentUrl) || isMcpEndpoint(beforeUrl) || statusHasAuth && MCP_HINT_RE.test(haystack);
  const bareApiDenied = statusHasAuth && !snapshot && !resultText.trim();
  if (mcpEndpoint || bareApiDenied) {
    const summary2 = mcpEndpoint ? "\u8FD9\u662F MCP \u670D\u52A1\u7AEF\u70B9\uFF08\u4E0D\u662F\u7F51\u9875\uFF09\uFF1A401/403 \u901A\u5E38\u662F\u7F3A\u5C11\u6216\u9519\u8BEF\u7684 Bearer Token\u3002" : "\u8BE5\u5730\u5740\u8FD4\u56DE 401/403 \u4E14\u6CA1\u6709\u53EF\u6253\u5F00\u7684\u7F51\u9875\u767B\u5F55\u9875\uFF1A\u8FD9\u662F\u670D\u52A1\u7AEF\u70B9\uFF0C\u901A\u5E38\u662F\u51ED\u636E\u7F3A\u5931\u6216\u9519\u8BEF\u3002";
    const message2 = mcpEndpoint ? summary2 + " \u8BF7\u76F4\u63A5\u7528\u5DF2\u914D\u7F6E\u7684 MCP \u5DE5\u5177\uFF08\u5DE5\u5177\u540D\u5F62\u5982 `mcp__<serverId>__<\u5DE5\u5177\u540D>`\uFF09\u8C03\u7528\u8BE5\u80FD\u529B\uFF1B\u82E5\u5DE5\u5177\u6CA1\u52A0\u8F7D\uFF0C\u5230\u8BBE\u7F6E\u9875\u300CMCP \u670D\u52A1\u5668\u300D\u68C0\u67E5\u8FD9\u53F0\u670D\u52A1\u5668\u7684\u5730\u5740\u4E0E Authorization\uFF08Bearer Token\uFF09\u3002\u4E0D\u8981\u7528 fetch_webpage \u53CD\u590D\u8BBF\u95EE\u8BE5\u5730\u5740 \u2014\u2014 \u5B83\u53EA\u4F1A\u518D\u62FF\u5230\u4E00\u6B21 401/403\u3002" : summary2 + " \u8BF7\u5728\u8BBE\u7F6E\u9875/\u8BF7\u6C42\u5934\u91CC\u4FEE\u6B63\u51ED\u636E\u540E\u91CD\u8BD5\uFF0C\u4E0D\u8981\u7528 fetch_webpage \u53CD\u590D\u8BBF\u95EE\u8BE5\u5730\u5740\u3002";
    return {
      required: true,
      reason: "mcp-token-required",
      summary: summary2,
      message: message2,
      currentUrl,
      loginUrl: "",
      loginUrlSource: "",
      linkLabel: "",
      endpointDenied: true
    };
  }
  const permissionDenied = denyCopy || statusCode === 403 || /(无权限|没有权限|权限不足|permission\s+denied|access\s+denied|forbidden)/i.test(resultText);
  const reason = permissionDenied ? "permission-denied" : "login-required";
  const summary = permissionDenied ? "\u64CD\u4F5C\u88AB\u6743\u9650\u9650\u5236\uFF1A\u5F53\u524D\u767B\u5F55\u72B6\u6001\u6216\u8D26\u53F7\u6743\u9650\u4E0D\u8DB3\uFF0C\u9700\u8981\u767B\u5F55 / \u6388\u6743\u540E\u91CD\u8BD5\u3002" : "\u64CD\u4F5C\u88AB\u767B\u5F55\u62E6\u622A\uFF1A\u5F53\u524D\u9875\u9762\u9700\u8981\u5148\u767B\u5F55\u540E\u624D\u80FD\u7EE7\u7EED\u3002";
  let loginUrl = "";
  let loginUrlSource = "";
  if (authPath) {
    loginUrl = currentUrl;
    loginUrlSource = "current-page";
  } else if (link && link.url) {
    loginUrl = link.url;
    loginUrlSource = "page-link";
  } else {
    loginUrl = fallbackLoginUrl(currentUrl || beforeUrl);
    loginUrlSource = loginUrl ? "site-fallback" : "";
  }
  const message = loginUrl ? summary + " \u767B\u5F55 / \u6388\u6743\u5165\u53E3\uFF1A" + loginUrl : summary;
  return {
    required: true,
    reason,
    summary,
    message,
    currentUrl,
    loginUrl,
    loginUrlSource,
    linkLabel: link && link.label || (authPath ? "\u5F53\u524D\u767B\u5F55\u9875" : "\u767B\u5F55\u9875")
  };
}
function authChallengeNotice(challenge) {
  if (!challenge || challenge.required !== true) return "";
  if (!challenge.loginUrl) {
    return "\n\n\u26A0 " + challenge.message + "\n\u8BF7\u628A\u4E0A\u9762\u7684\u539F\u56E0\u5982\u5B9E\u544A\u8BC9\u7528\u6237\uFF0C\u5E76\u7B49\u5F85\u7528\u6237\u4FEE\u6B63\u914D\u7F6E\u540E\u91CD\u8BD5\u3002\u5728\u7528\u6237\u5904\u7406\u4E4B\u524D\uFF0C\u4E0D\u8981\u7EE7\u7EED\u731C\u6D4B\u5730\u5740\u3001\u53CD\u590D\u91CD\u8BD5\u540C\u4E00 URL\uFF0C\u4E5F\u4E0D\u8981\u6539\u7528\u5176\u5B83\u5DE5\u5177\u786C\u95EF\u3002";
  }
  return "\n\n\u26A0 " + challenge.message + "\n\u8BF7\u5148\u628A\u4E0A\u9762\u7684\u767B\u5F55 / \u6388\u6743\u5165\u53E3\u544A\u8BC9\u7528\u6237\uFF0C\u5E76\u7B49\u5F85\u7528\u6237\u5B8C\u6210\u767B\u5F55\u3002\u5728\u7528\u6237\u660E\u786E\u8868\u793A\u5DF2\u767B\u5F55\u524D\uFF0C\u4E0D\u8981\u53CD\u590D\u70B9\u51FB\u3001\u731C\u6D4B\u5176\u5B83\u5730\u5740\uFF0C\u4E5F\u4E0D\u8981\u5728\u6807\u7B7E\u9875\u4E4B\u95F4\u6765\u56DE\u5207\u6362\u3002";
}

// lib/assistant/fetch-tools.js
async function fetchWebpage(deps, args) {
  const ctx = deps.ctx;
  ctx.failedUrls = Array.isArray(ctx.failedUrls) ? ctx.failedUrls : [];
  const u = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, result: "\u4EC5\u652F\u6301 http/https \u94FE\u63A5\uFF1A" + u };
  const norm = u.replace(/\/+$/, "");
  if (ctx.failedUrls.includes(norm)) {
    return {
      ok: false,
      result: "\u8BE5 URL \u6B64\u524D\u5DF2\u6293\u53D6\u5931\u8D25\uFF08" + u + "\uFF09\uFF0C\u8BF7\u52FF\u91CD\u8BD5\u3002\u8BF7\u6539\u7528 open_tab \u6253\u5F00\u8BE5\u9875\u8BFB\u53D6\u6E32\u67D3\u540E\u5185\u5BB9\uFF0C\u6216\u6362\u7528\u5176\u5B83\u6765\u6E90\uFF1B\u82E5\u65E0\u6CD5\u6253\u5F00\uFF0C\u76F4\u63A5\u57FA\u4E8E\u5DF2\u6709\u4FE1\u606F\u603B\u7ED3\u5E76\u7ED3\u675F\uFF0C\u4E0D\u8981\u7EE7\u7EED\u731C\u6D4B URL\u3002"
    };
  }
  let timer = null;
  try {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    timer = ctrl ? setTimeout(() => ctrl.abort(), 15e3) : null;
    const resp = await deps.fetchImpl(u, { method: "GET", redirect: "follow", signal: ctrl ? ctrl.signal : void 0 });
    if (timer) clearTimeout(timer);
    if (!resp.ok) {
      const auth2 = detectAuthChallenge({
        beforeUrl: u,
        afterUrl: resp.url || u,
        result: "\u6293\u53D6\u5931\u8D25 (" + resp.status + ")\uFF1A" + u,
        ok: false,
        statusCode: resp.status,
        toolName: "fetch_webpage"
      });
      if (auth2) {
        return {
          ok: false,
          needsLogin: true,
          authChallenge: auth2,
          result: "\u6293\u53D6\u5931\u8D25 (" + resp.status + ")\uFF1A" + u + authChallengeNotice(auth2)
        };
      }
      ctx.failedUrls.push(norm);
      return { ok: false, result: "\u6293\u53D6\u5931\u8D25 (" + resp.status + ")\uFF1A" + u + "\u3002\u8BF7\u6539\u7528 open_tab \u6253\u5F00\u8BE5\u9875\uFF0C\u6216\u6362\u7528\u5176\u5B83\u6765\u6E90\uFF1B\u4E0D\u8981\u53CD\u590D\u91CD\u8BD5\u8BE5 URL\u3002" };
    }
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (ct && !/^(text\/html|text\/plain|application\/xml|application\/xhtml|\+xml)/.test(ct) && !ct.includes("json")) {
      ctx.failedUrls.push(norm);
      return { ok: false, result: "\u8BE5\u5730\u5740\u8FD4\u56DE\u975E\u6587\u672C\u5185\u5BB9\uFF08" + ct + "\uFF09\uFF1A" + u + "\u3002\u82E5\u9700\u8BE5\u8D44\u6E90\u8BF7\u6539\u7528 open_tab \u67E5\u770B\uFF0C\u5426\u5219\u6362\u7528\u5176\u5B83\u6765\u6E90\u3002" };
    }
    const maxBytes = 1.5 * 1024 * 1024;
    const buf = await deps.readBounded(resp.body, maxBytes);
    const decoder = deps.decodeBuffer(buf, ct);
    const raw = decoder.decode(buf);
    const truncated = buf.byteLength >= maxBytes;
    const fullText = deps.stripHtml(raw);
    const trimmedText = fullText.trim();
    if (!trimmedText) {
      ctx.failedUrls.push(norm);
      return { ok: false, result: "\u8BE5\u9875\u9762\u6B63\u6587\u4E3A\u7A7A\uFF08" + u + "\uFF09\u3002\u8BF7\u6539\u7528 open_tab \u6253\u5F00\u8BFB\u53D6\u6E32\u67D3\u540E\u5185\u5BB9\uFF0C\u6216\u6362\u7528\u5176\u5B83\u6765\u6E90\u3002" };
    }
    const likelySpa = trimmedText.length < 150 && /<script[\s>]/i.test(raw);
    const text = fullText.slice(0, 8e3);
    const finalUrl = resp.url || u;
    const auth = detectAuthChallenge({
      beforeUrl: u,
      afterUrl: finalUrl,
      snapshot: {
        url: finalUrl,
        title: deps.extractHtmlTitle(raw) || "",
        text: fullText.slice(0, 6e3),
        elements: []
      },
      result: trimmedText.slice(0, 4e3),
      ok: true,
      toolName: "fetch_webpage"
    });
    if (auth) {
      return {
        ok: false,
        needsLogin: true,
        authChallenge: auth,
        result: "\u6293\u53D6\u88AB\u767B\u5F55 / \u6743\u9650\u9875\u62E6\u622A\uFF1A" + finalUrl + authChallengeNotice(auth)
      };
    }
    const usable = !likelySpa && trimmedText.length >= 200;
    return {
      result: "\u7F51\u9875\u6B63\u6587\uFF08" + finalUrl + "\uFF09\uFF1A\n" + text + (truncated ? "\n\uFF08\u5185\u5BB9\u8FC7\u5927\u5DF2\u622A\u65AD\uFF09" : "") + (likelySpa ? "\n\n\u26A0 \u9875\u9762\u6B63\u6587\u63D0\u53D6\u8FC7\u5C11\uFF0C\u7591\u4F3C\u524D\u7AEF JS \u6E32\u67D3\uFF08SPA\uFF09\u9875\u9762\uFF0C\u6E90\u7801\u91CC\u53EA\u6709\u811A\u672C\u58F3\u3002\u8BF7\u6539\u7528 open_tab \u6253\u5F00\u8BE5\u9875\uFF0C\u518D\u7528 get_page_snapshot / read_current_page \u8BFB\u53D6\u6E32\u67D3\u540E\u7684\u771F\u5B9E\u5185\u5BB9\uFF1B\u7981\u6B62\u7EE7\u7EED\u7528 fetch_webpage \u731C\u6D4B\u5176\u5B83 URL\u3002\u82E5\u65E0\u6CD5\u6253\u5F00\uFF0C\u8BF7\u76F4\u63A5\u57FA\u4E8E\u5DF2\u6709\u4FE1\u606F\u603B\u7ED3\u5E76\u7ED3\u675F\u3002" : "") + (!usable ? "\n\uFF08\u8BE5\u6B21\u6293\u53D6\u5185\u5BB9\u4E0D\u8DB3\u4EE5\u4F5C\u4E3A\u53C2\u8003\u6765\u6E90\uFF0C\u4E0D\u4F5C\u4E3A\u6765\u6E90\u7F16\u53F7\u767B\u8BB0\u3002\uFF09" : ""),
      ...usable ? { citations: [{ index: 1, source: "web", title: deps.extractHtmlTitle(raw) || finalUrl, url: finalUrl, snippet: text.slice(0, 180) }] } : {}
    };
  } catch (e) {
    if (!deps.isAbortLikeError(e)) ctx.failedUrls.push(norm);
    return { ok: false, result: deps.describeFetchError(e, u, 15e3) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function webSearch(deps, args) {
  const q = String(args.query || "").trim();
  if (!q) return { ok: false, result: "\u8BF7\u63D0\u4F9B\u641C\u7D22\u5173\u952E\u8BCD query\u3002" };
  const maxResults = Math.min(10, Math.max(1, Number(args.maxResults) || 6));
  try {
    const results = await deps.searchWeb(q, maxResults);
    if (!results.length) return { ok: false, result: "\u672A\u641C\u7D22\u5230\u7ED3\u679C\uFF0C\u53EF\u5C1D\u8BD5\u6362\u5173\u952E\u8BCD\uFF0C\u6216 open_tab \u6253\u5F00\u5DF2\u77E5\u7AD9\u70B9\u3002" };
    const lines = results.map(
      (r, i) => "[" + (i + 1) + "] " + r.title + "\n    \u94FE\u63A5\uFF1A" + r.url + (r.snippet ? "\n    \u6458\u8981\uFF1A" + r.snippet : "")
    );
    return {
      result: "\u641C\u7D22\u7ED3\u679C\uFF08" + q + "\uFF09\uFF1A\n" + lines.join("\n\n") + "\n\n\uFF08\u4EE5\u4E0A\u4E3A\u641C\u7D22\u7ED3\u679C\u5019\u9009\uFF0C\u4E0D\u5C5E\u4E8E\u53C2\u8003\u6765\u6E90\uFF1B\u5982\u9700\u5F15\u7528\u8BF7\u5148 open_tab / fetch_webpage \u8BFB\u53D6\u76EE\u6807\u9875\u9762\uFF0C\u8BFB\u53D6\u540E\u7684\u9875\u9762\u4F1A\u767B\u8BB0\u4E3A\u53C2\u8003\u6765\u6E90\u7F16\u53F7\u3002\uFF09"
    };
  } catch (e) {
    return { ok: false, result: "\u7F51\u7EDC\u641C\u7D22\u5931\u8D25\uFF1A" + e.message };
  }
}
async function handleFetchTool(name, args, deps) {
  if (name === "fetch_webpage") return await fetchWebpage(deps, args);
  if (name === "web_search") return await webSearch(deps, args);
  return null;
}

// lib/assistant/cdp-input-tools.js
async function clickElement(deps, args) {
  const ctx = deps.ctx;
  const contentRes = await deps.executePageTool(ctx.tabId, "click", args, ctx);
  const target = await deps.resolveTarget(ctx.tabId, args);
  if (target && contentRes && contentRes.ok !== false) deps.rememberTarget(ctx, target);
  const clickFrame = deps.frameIdFromArgs(args);
  if (!contentRes || contentRes.ok !== false || !deps.cdpAllowed(ctx) || !target) return contentRes;
  try {
    let point = { x: target.rect.centerX, y: target.rect.centerY };
    if (clickFrame != null && clickFrame !== 0) {
      const resolved = await deps.cdp.resolveFrameClickPoint(ctx.tabId, clickFrame, target.selector, point).catch(() => null);
      if (!resolved) return contentRes;
      point = resolved;
    }
    await deps.cdp.clickAt(ctx.tabId, point.x, point.y);
    const before = ctx.lastSnapshot || null;
    const after = await deps.getPageSnapshot(ctx.tabId, {
      maxElements: 40,
      maxText: 1200,
      frameId: clickFrame != null && clickFrame !== 0 ? clickFrame : void 0
    }).catch(() => null);
    return {
      ok: true,
      hadEffect: deps.observedChange(before, after) === "changed",
      cdp: true,
      pageSnapshot: after,
      verification: deps.buildActionVerification(deps.observedChange(before, after), "\u5DF2\u7528 CDP \u6D3E\u53D1\u53EF\u4FE1\u70B9\u51FB"),
      result: "\u5185\u5BB9\u811A\u672C\u70B9\u51FB\u5931\u8D25\uFF08" + String(contentRes.result || "").replace(/\s+/g, " ").slice(0, 80) + "\uFF09\uFF0C\u5DF2\u6539\u7528 CDP \u53EF\u4FE1\u70B9\u51FB\uFF08\u5750\u6807 " + Math.round(point.x) + "," + Math.round(point.y) + "\uFF09" + (after ? "\n" + deps.compactSnapshotSummary(after) : "")
    };
  } catch (e) {
    return contentRes;
  }
}
async function clickAt2(deps, args) {
  const ctx = deps.ctx;
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, result: "click_at \u9700\u8981\u6570\u503C\u5750\u6807 x\u3001y\u3002" };
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: "click_at \u9700\u8981 CDP \u8F93\u5165\u5C42\uFF08\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u5F00\u542F\u300C\u6D4F\u89C8\u5668\u7EA7\u8F93\u5165\u300D\uFF0C\u4E14\u9700 Chromium \u5185\u6838\u6D4F\u89C8\u5668\uFF09\u3002" };
  try {
    await deps.cdp.clickAt(ctx.tabId, x, y, { button: args.button || "left", clickCount: args.double ? 2 : 1 });
    const before = ctx.lastSnapshot || null;
    const after = await deps.getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
    return {
      ok: true,
      hadEffect: deps.observedChange(before, after) === "changed",
      cdp: true,
      pageSnapshot: after,
      verification: deps.buildActionVerification(deps.observedChange(before, after), "CDP \u5750\u6807\u70B9\u51FB\u5DF2\u6D3E\u53D1"),
      result: "\u5DF2\u5728\u5750\u6807 (" + x + "," + y + ") \u70B9\u51FB" + (after ? "\n" + deps.compactSnapshotSummary(after) : "")
    };
  } catch (e) {
    return { ok: false, result: "CDP \u70B9\u51FB\u5931\u8D25\uFF1A" + deps.summarizeCdpError(e) };
  }
}
async function hoverElement(deps, args) {
  const ctx = deps.ctx;
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: "\u60AC\u505C\u9700\u8981 CDP \u8F93\u5165\u5C42\uFF08\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u5F00\u542F\uFF09\u3002" };
  const target = await deps.resolveTarget(ctx.tabId, args);
  if (!target) return { ok: false, result: "\u672A\u627E\u5230\u76EE\u6807\u5143\u7D20\u3002" };
  try {
    await deps.cdp.moveTo(ctx.tabId, target.rect.centerX, target.rect.centerY);
    deps.rememberTarget(ctx, target);
    const before = ctx.lastSnapshot || null;
    const after = await deps.getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
    return {
      ok: true,
      // 悬停常常**不产生任何 DOM 变更**（只改 CSS :hover 伪类），因此这里必须如实报
      // 「是否观测到变化」，而不是无条件声称 changed:true —— 否则卡死检测会永远认为在推进。
      hadEffect: deps.observedChange(before, after) === "changed",
      cdp: true,
      pageSnapshot: after,
      verification: deps.buildActionVerification(deps.observedChange(before, after), "CDP \u60AC\u505C\u5DF2\u6D3E\u53D1\uFF08\u4F2A\u7C7B\u53D8\u5316\u53EF\u80FD\u4E0D\u4EA7\u751F DOM \u53D8\u66F4\uFF09"),
      result: "\u5DF2\u60AC\u505C\u5230\u5143\u7D20\uFF08\u5750\u6807 " + target.rect.centerX + "," + target.rect.centerY + "\uFF09" + (after ? "\n" + deps.compactSnapshotSummary(after) : "")
    };
  } catch (e) {
    return { ok: false, result: "\u60AC\u505C\u5931\u8D25\uFF1A" + deps.summarizeCdpError(e) };
  }
}
async function dragElement(deps, args) {
  const ctx = deps.ctx;
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: "\u62D6\u62FD\u9700\u8981 CDP \u8F93\u5165\u5C42\uFF08\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u5F00\u542F\uFF09\u3002" };
  const from = await deps.resolveTarget(ctx.tabId, { ref: args.fromRef, selector: args.fromSelector, text: args.fromText });
  const to = await deps.resolveTarget(ctx.tabId, { ref: args.toRef, selector: args.toSelector, text: args.toText });
  if (!from || !to) return { ok: false, result: "\u62D6\u62FD\u9700\u8981\u80FD\u540C\u65F6\u5B9A\u4F4D\u8D77\u70B9\u4E0E\u7EC8\u70B9\uFF08fromRef/fromSelector/fromText \u4E0E toRef/toSelector/toText\uFF09\u3002" };
  try {
    await deps.cdp.drag(ctx.tabId, from.rect.centerX, from.rect.centerY, to.rect.centerX, to.rect.centerY);
    const before = ctx.lastSnapshot || null;
    const after = await deps.getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
    return {
      ok: true,
      hadEffect: deps.observedChange(before, after) === "changed",
      cdp: true,
      pageSnapshot: after,
      verification: deps.buildActionVerification(deps.observedChange(before, after), "CDP \u62D6\u62FD\u5DF2\u6D3E\u53D1"),
      result: "\u5DF2\u4ECE (" + from.rect.centerX + "," + from.rect.centerY + ") \u62D6\u62FD\u5230 (" + to.rect.centerX + "," + to.rect.centerY + ")" + (after ? "\n" + deps.compactSnapshotSummary(after) : "")
    };
  } catch (e) {
    return { ok: false, result: "\u62D6\u62FD\u5931\u8D25\uFF1A" + deps.summarizeCdpError(e) };
  }
}
async function uploadFile2(deps, args) {
  const ctx = deps.ctx;
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: "\u6587\u4EF6\u4E0A\u4F20\u9700\u8981 CDP\uFF08\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u5F00\u542F\uFF09\u3002" };
  const files = Array.isArray(args.files) ? args.files.filter(Boolean) : args.files ? [args.files] : [];
  if (!files.length) return { ok: false, result: "upload_file \u9700\u8981 files\uFF08\u672C\u5730\u6587\u4EF6\u7684\u7EDD\u5BF9\u8DEF\u5F84\u6570\u7EC4\uFF09\u3002" };
  const target = await deps.resolveTarget(ctx.tabId, args);
  if (!target) return { ok: false, result: "\u672A\u627E\u5230 file input \u5143\u7D20\u3002" };
  try {
    await deps.cdp.uploadFile(ctx.tabId, target.selector, files);
    return {
      ok: true,
      hadEffect: false,
      cdp: true,
      verification: deps.buildActionVerification("unobservable", "\u5DF2\u5411\u6587\u4EF6\u8F93\u5165\u6846\u8BBE\u7F6E\u6587\u4EF6\uFF08\u672A\u505A\u9875\u9762\u53D8\u5316\u89C2\u6D4B\uFF09"),
      result: "\u5DF2\u5411\u6587\u4EF6\u8F93\u5165\u6846\u8BBE\u7F6E " + files.length + " \u4E2A\u6587\u4EF6\uFF1A" + files.join("\u3001")
    };
  } catch (e) {
    return { ok: false, result: "\u6587\u4EF6\u4E0A\u4F20\u5931\u8D25\uFF1A" + deps.summarizeCdpError(e) };
  }
}
async function handleCdpInputTool(name, args, deps) {
  if (name === "click_element") return await clickElement(deps, args);
  if (name === "click_at") return await clickAt2(deps, args);
  if (name === "hover_element") return await hoverElement(deps, args);
  if (name === "drag_element") return await dragElement(deps, args);
  if (name === "upload_file") return await uploadFile2(deps, args);
  return null;
}

// lib/assistant/page-read-tools.js
async function listFramesRaw(deps, tabId) {
  try {
    const results = await deps.chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({ href: location.href, title: document.title || "", isTop: window.top === window })
    });
    return (results || []).map((r) => Object.assign({ frameId: r.frameId }, r.result || {}));
  } catch (e) {
    return [];
  }
}
function prefixFrameRefs(snapshot, frameId) {
  if (!snapshot || !Number.isInteger(Number(frameId)) || Number(frameId) === 0) return snapshot;
  const fid = Number(frameId);
  const elements = (snapshot.elements || []).map((e) => Object.assign({}, e, { ref: "f" + fid + ":" + e.ref, frameId: fid }));
  return Object.assign({}, snapshot, { elements, frameId: fid });
}
var CAPABILITY_SAMPLE_LIMIT = 4;
function isCrossOriginFrame(topUrl, frameUrl) {
  try {
    return new URL(String(frameUrl)).origin !== new URL(String(topUrl)).origin;
  } catch (e) {
    return true;
  }
}
function mergeFrameCapabilities(top, perFrame) {
  const out = {};
  for (const kind of ["customElements", "shadowHosts", "editables", "scrollContainers"]) {
    const topBucket = top && top[kind];
    let count = topBucket ? Number(topBucket.count) || 0 : 0;
    const topSamples = topBucket && Array.isArray(topBucket.samples) ? topBucket.samples.slice(0, 2) : [];
    const childSamples = [];
    for (const frame of Array.isArray(perFrame) ? perFrame : []) {
      const bucket2 = frame && frame.capabilities && frame.capabilities[kind];
      if (!bucket2) continue;
      count += Number(bucket2.count) || 0;
      if (!Array.isArray(bucket2.samples) || !bucket2.samples.length) continue;
      childSamples.push(Object.assign({}, bucket2.samples[0], { frameId: frame.frameId }));
    }
    const samples = topSamples.length ? topSamples.concat(childSamples).slice(0, CAPABILITY_SAMPLE_LIMIT) : childSamples.slice(0, CAPABILITY_SAMPLE_LIMIT);
    if (count > 0) out[kind] = { count, samples };
  }
  return Object.keys(out).length ? out : void 0;
}
function formatCapabilityHint(capabilities) {
  if (!capabilities || typeof capabilities !== "object") return "";
  const lines = [];
  let hasFrameSample = false;
  const scopeOf = (sample) => {
    if (!sample || sample.frameId == null) return "";
    hasFrameSample = true;
    return "frame " + sample.frameId + " \xB7 ";
  };
  const pickSample = (bucket2) => {
    const list = bucket2 && Array.isArray(bucket2.samples) ? bucket2.samples : [];
    return list.find((s) => s && s.frameId != null) || list[0] || null;
  };
  const custom = capabilities.customElements;
  if (custom && custom.count) {
    const list = Array.isArray(custom.samples) ? custom.samples : [];
    const picked = list.slice(0, 1);
    const frameSample = list.find((s) => s && s.frameId != null);
    if (frameSample && picked.indexOf(frameSample) === -1) picked.push(frameSample);
    else if (list[1]) picked.push(list[1]);
    const sel = picked.map((s) => scopeOf(s) + (s && s.tag || s && s.selector || "")).filter(Boolean).join("\u3001");
    lines.push(
      "\u81EA\u5B9A\u4E49\u5143\u7D20 " + custom.count + " \u4E2A" + (sel ? "\uFF08\u5982 " + sel + "\uFF09" : "") + '\uFF1A\u6309 selector/text \u7528 inspect_element({op:"query"}) \u5B9A\u4F4D\uFF0C\u8FD4\u56DE\u7684 ref/rect \u53EF\u76F4\u63A5\u7528\u4E8E\u52A8\u4F5C\u3002'
    );
  }
  const shadow = capabilities.shadowHosts;
  if (shadow && shadow.count) {
    const sample = pickSample(shadow);
    const sel = scopeOf(sample) + (sample && sample.tag || sample && sample.selector || "");
    lines.push(
      "\u5F00\u653E shadow root " + shadow.count + " \u5904" + (sel ? "\uFF08\u5BBF\u4E3B " + sel + "\uFF09" : "") + "\uFF1A\u5FEB\u7167\u4E0E inspect_element \u5DF2\u7A7F\u900F\uFF0C\u4E0D\u8981\u7528 document.querySelectorAll \u81EA\u5DF1\u9012\u5F52\u3002"
    );
  }
  const editables = capabilities.editables;
  if (editables && editables.count) {
    const sample = pickSample(editables);
    lines.push(
      "\u53EF\u7F16\u8F91\u533A " + editables.count + " \u4E2A" + (sample ? "\uFF08" + scopeOf(sample) + (sample.kind || "contenteditable") + "\uFF1A" + sample.selector + "\uFF09" : "") + "\uFF1A\u7528 type_text \u5199\u5165\uFF08\u4F1A\u6309\u5B9E\u9645\u6587\u672C\u56DE\u8BFB\uFF09\uFF0C\u4E0D\u8981\u76F4\u63A5\u6539 textContent\u3002"
    );
  }
  const scrolls = capabilities.scrollContainers;
  if (scrolls && scrolls.count) {
    const sample = pickSample(scrolls);
    const inFrame = sample && sample.frameId != null;
    lines.push(
      "\u5185\u90E8\u6EDA\u52A8\u5BB9\u5668 " + scrolls.count + " \u4E2A" + (sample ? "\uFF08\u5982 " + scopeOf(sample) + sample.selector + "\uFF09" : "") + "\uFF1A" + (inFrame ? "\u5148 get_page_snapshot({frameId:" + sample.frameId + "}) \u62FF\u8BE5\u5BB9\u5668\u7684 ref\uFF0C\u518D\u7528 scroll_page({ref, y:600})" : '\u7528 scroll_page({selector:"\u2026", y:600}) \u76F4\u63A5\u6EDA\u5B83') + "\uFF0C\u4E0D\u8981\u4E3A\u6B64\u8C03\u7528 run_javascript\u3002"
    );
  }
  if (hasFrameSample) {
    lines.push("\u5E26 frame N \u7684\u6761\u76EE\u5728 iframe \u5185\uFF1A\u5148 get_page_snapshot({frameId:N}) \u62FF\u8BE5\u6846\u67B6\u7684 ref\uFF0C\u540E\u7EED\u52A8\u4F5C\u76F4\u63A5\u4F20 ref\uFF08\u4F1A\u81EA\u52A8\u8DEF\u7531\u5230\u5BF9\u5E94\u6846\u67B6\uFF09\u3002");
  }
  return lines.length ? "\n\u26A0 \u9875\u9762\u80FD\u529B\uFF1A\n- " + lines.join("\n- ") : "";
}
async function readCurrentPage(deps, args) {
  const ctx = deps.ctx;
  const tabId = ctx.tabId;
  if (!tabId) return { ok: false, result: "\u65E0\u6CD5\u5B9A\u4F4D\u5F53\u524D\u6807\u7B7E\u9875\uFF08\u53EF\u80FD\u4E0D\u5728\u524D\u53F0\u9875\u9762\uFF09\u3002" };
  try {
    const pageResponse = await deps.sendTabMessage(tabId, {
      type: "kbGetPageText",
      options: {
        visibleOnly: args.visibleOnly === true,
        checkTexts: Array.isArray(args.checkTexts) ? args.checkTexts : void 0
      }
    });
    const pr = pageResponse || {};
    const text = pr.text ? pr.text : "";
    const visReport = deps.formatVisibilityReport(pr.visibility);
    const checkTexts = Array.isArray(args.checkTexts) ? args.checkTexts : [];
    if (checkTexts.filter((t) => String(t == null ? "" : t).trim()).length && visReport) {
      return {
        ok: true,
        result: deps.formatCurrentPageResult({ title: pr.title, url: pr.url || ctx.pageUrl, textLength: text.length, visReport, checkTexts, visibleOnly: args.visibleOnly === true })
      };
    }
    if (!text) return { result: "\u672A\u80FD\u8BFB\u53D6\u9875\u9762\u6B63\u6587\uFF08\u5185\u5BB9\u811A\u672C\u672A\u6CE8\u5165\u6216\u9875\u9762\u4E0D\u652F\u6301\uFF09\u3002" };
    const chunks = deps.splitIntoChunks(text, 1200, 8);
    const result = deps.formatCurrentPageResult({
      title: pr.title,
      url: pr.url || ctx.pageUrl,
      text,
      textLength: text.length,
      chunks,
      visReport,
      visibleOnly: args.visibleOnly === true
    });
    const is404 = /(404|page not found|not found|页面不存在|无法访问)/i.test(String(pageResponse.title || ""));
    const urlForTitle = String(pageResponse.url || ctx.pageUrl || "");
    const citations = is404 ? [] : chunks.map((c, i) => ({
      index: i + 1,
      source: "page",
      title: deps.citationTitleFor(pageResponse.title, urlForTitle),
      url: urlForTitle,
      snippet: c
    }));
    return { result, citations };
  } catch (e) {
    return { ok: false, result: describeContentScriptUnreachable(e.message, "\u8BFB\u53D6\u9875\u9762\u5931\u8D25\uFF1A") };
  }
}
async function getPageSnapshotTool(deps, args) {
  const ctx = deps.ctx;
  const tabId = ctx.tabId;
  if (!tabId) return { ok: false, result: "\u65E0\u6CD5\u5B9A\u4F4D\u5F53\u524D\u6807\u7B7E\u9875\uFF08\u53EF\u80FD\u4E0D\u5728\u524D\u53F0\u9875\u9762\uFF09\u3002" };
  if (deps.cdpAllowed(ctx)) {
    const dialogs = deps.getPendingDialogs(tabId);
    if (dialogs.length) {
      const hasPrompt = dialogs.some((d) => d && d.type === "prompt");
      return {
        ok: true,
        hadEffect: false,
        snapshot: null,
        result: "\u26A0 \u9875\u9762\u5B58\u5728\u672A\u5904\u7406\u7684\u5BF9\u8BDD\u6846\uFF1A" + dialogs.map((d) => {
          const base = d.type + "\uFF1A" + d.message;
          return d.type === "prompt" && d.defaultPrompt !== void 0 && d.defaultPrompt !== "" ? base + '\uFF08\u9ED8\u8BA4\u503C\uFF1A"' + d.defaultPrompt + '"\uFF09' : base;
        }).join("\uFF1B") + "\n\u8BF7\u5148\u8C03\u7528 handle_dialog \u5904\u7406\uFF0C\u5426\u5219\u9875\u9762\u88AB\u963B\u585E\uFF08\u5728\u5BF9\u8BDD\u6846\u88AB\u5904\u7406\u4E4B\u524D\uFF0C\u5176\u5B83\u64CD\u4F5C\u90FD\u4E0D\u4F1A\u751F\u6548\uFF0C**\u4E0D\u8981\u91CD\u590D\u70B9\u51FB**\uFF09\u3002" + (hasPrompt ? '\n\u8FD9\u662F prompt\uFF1A`handle_dialog({accept:true, promptText:"\u8981\u586B\u5165\u7684\u6587\u672C"})` \u2014\u2014 **\u4E0D\u4F20 promptText \u5C31\u4F1A\u539F\u6837\u63A5\u53D7\u4E0A\u9762\u7684\u9ED8\u8BA4\u503C**\uFF0C\u8BF7\u5148\u786E\u8BA4\u90A3\u662F\u4E0D\u662F\u4F60\u8981\u7684\u3002' : "\n`handle_dialog({accept:true})` \u8868\u793A\u786E\u5B9A\uFF0C`{accept:false}` \u8868\u793A\u53D6\u6D88\u3002")
      };
    }
  }
  try {
    const explicitFrame = args.frameId !== void 0 && args.frameId !== null && args.frameId !== "";
    if (explicitFrame) {
      const fid = Number(args.frameId);
      const snapshot2 = await deps.getPageSnapshot(tabId, { maxElements: args.maxElements, maxText: args.maxText, frameId: fid });
      if (!snapshot2) return { ok: false, result: "\u672A\u80FD\u8BFB\u53D6\u8BE5\u6846\u67B6\u7684 DOM \u5FEB\u7167\uFF08frameId=" + fid + "\uFF0C\u53EF\u80FD\u65E0\u5185\u5BB9\u811A\u672C\uFF09\u3002" };
      const tagged = prefixFrameRefs(snapshot2, fid);
      return { ok: true, hadEffect: false, snapshot: tagged, result: "\u6846\u67B6 " + fid + " \u7684 DOM \u5FEB\u7167\uFF1A\n" + JSON.stringify(tagged) };
    }
    const snapshot = await deps.getPageSnapshot(tabId, args);
    if (!snapshot) return { ok: false, result: "\u672A\u80FD\u8BFB\u53D6 DOM \u5FEB\u7167\uFF08\u5185\u5BB9\u811A\u672C\u672A\u6CE8\u5165\u6216\u9875\u9762\u4E0D\u652F\u6301\uFF09\u3002" };
    const capHint = formatCapabilityHint(snapshot.capabilities);
    const mainHint = snapshot.mainContent && snapshot.mainContent.selector ? "\n\u26A0 \u7591\u4F3C\u6B63\u6587\u5BB9\u5668\uFF1A" + snapshot.mainContent.selector + "\uFF08\u7EA6 " + snapshot.mainContent.textLength + " \u5B57\uFF09\u2014\u2014 \u9690\u85CF\u5E7F\u544A/\u63A8\u5E7F\u65F6\u4E0D\u8981\u6574\u4F53\u9690\u85CF\u5B83\u6216\u5176\u7956\u5148\u3002" : "";
    const omittedBySize = Number(snapshot.counts && snapshot.counts.omittedBySize || 0);
    const omitHint = omittedBySize > 0 ? "\n\u26A0 \u53E6\u6709 " + omittedBySize + ' \u4E2A\u53EF\u4EA4\u4E92\u5143\u7D20\u56E0**\u5FEB\u7167\u4F53\u79EF\u9884\u7B97**\u672A\u5217\u51FA\uFF08elements \u6309"\u79BB\u89C6\u53E3\u4E2D\u5FC3\u8FDC\u8FD1"\u6392\u5E8F\uFF0C\u89C6\u53E3\u5916\u7684\u6392\u5728\u540E\u9762\u3001\u5148\u88AB\u88C1\uFF09\u3002\u9700\u8981\u5B83\u4EEC\u65F6\uFF1A\u5148\u7528 scroll_page \u628A\u5B83\u6EDA\u8FDB\u89C6\u53E3\u518D\u8BFB\u4E00\u6B21\uFF0C\u6216\u76F4\u63A5\u6309 selector / role+name \u64CD\u4F5C\uFF08\u4E0D\u5FC5\u5148"\u770B\u5230"\uFF09\u3002' : "";
    if (args.includeFrames === true) {
      const maxElements = Math.min(150, Math.max(1, Number(args.maxElements) || 60));
      let elements = (snapshot.elements || []).slice();
      const frames = await listFramesRaw(deps, tabId);
      const childFrames = frames.filter((f) => Number(f.frameId) !== 0);
      const readFrameIds = [];
      const failedFrameIds = [];
      const perFrameCapabilities = [];
      for (const f of childFrames) {
        if (elements.length >= maxElements) break;
        const s = await deps.getPageSnapshot(tabId, { maxElements: Math.max(1, maxElements - elements.length), maxText: 0, frameId: f.frameId }).catch(() => null);
        if (s) readFrameIds.push(Number(f.frameId));
        else failedFrameIds.push(Number(f.frameId));
        if (s && s.capabilities && isCrossOriginFrame(snapshot.url, f.href)) {
          perFrameCapabilities.push({ frameId: Number(f.frameId), capabilities: s.capabilities });
        }
        if (s && Array.isArray(s.elements) && s.elements.length) {
          elements = elements.concat(prefixFrameRefs(s, f.frameId).elements);
        }
      }
      const capped = elements.slice(0, maxElements);
      const mergedCapabilities = mergeFrameCapabilities(snapshot.capabilities, perFrameCapabilities);
      const capabilityChars = mergedCapabilities ? JSON.stringify(mergedCapabilities).length : 0;
      const trimmed = deps.trimElementsToBudget(capped, String(snapshot.text || "").length + capabilityChars);
      const merged = Object.assign({}, snapshot, {
        elements: trimmed.elements,
        capabilities: mergedCapabilities || void 0,
        counts: Object.assign({}, snapshot.counts, {
          shown: trimmed.elements.length,
          omittedBySize: (snapshot.counts && snapshot.counts.omittedBySize ? snapshot.counts.omittedBySize : 0) + trimmed.omittedBySize
        }),
        frames: frames.map((f) => ({ frameId: f.frameId, url: f.href, title: f.title, isTop: !!f.isTop })),
        frameRead: {
          read: readFrameIds,
          failed: failedFrameIds,
          total: childFrames.length
        }
      });
      const frameWarning = failedFrameIds.length ? "\n\u26A0 " + childFrames.length + " \u4E2A\u5B50\u6846\u67B6\u4E2D\u6709 " + failedFrameIds.length + " \u4E2A\u672A\u80FD\u8BFB\u53D6\uFF08frameId=" + failedFrameIds.join("\u3001") + '\uFF09\uFF1A\u8BE5\u6846\u67B6\u6CA1\u6709\u53EF\u7528\u7684\u5185\u5BB9\u811A\u672C\uFF0C\u4E14\u8865\u6CE8\u5165\u4E5F\u5931\u8D25\u3002\u53EF\u4EE5\u76F4\u63A5\u64CD\u4F5C\u9876\u5C42\u9875\u9762\u91CC\u7684 iframe \u5143\u7D20\uFF0C\u6216\u6539\u7528 run_javascript({engine:"page"}) / get_ax_snapshot\u3002' : "";
      return {
        ok: true,
        hadEffect: false,
        snapshot: merged,
        result: "\u5F53\u524D\u9875\u9762 DOM \u5FEB\u7167\uFF08\u5DF2\u5408\u5E76 " + readFrameIds.length + " \u4E2A\u5B50\u6846\u67B6\uFF09\uFF1A\n" + JSON.stringify(merged) + "\n\u63D0\u793A\uFF1A\u5E26 f<frameId>: \u524D\u7F00\u7684 ref \u5C5E\u4E8E\u5BF9\u5E94 iframe\uFF0C\u52A8\u4F5C\u65F6\u76F4\u63A5\u539F\u6837\u4F20\u56DE ref \u5373\u53EF\u3002" + formatCapabilityHint(merged.capabilities) + frameWarning + mainHint + omitHint
      };
    }
    return {
      ok: true,
      hadEffect: false,
      snapshot,
      result: "\u5F53\u524D\u9875\u9762 DOM \u5FEB\u7167\uFF1A\n" + JSON.stringify(snapshot) + capHint + mainHint + omitHint
    };
  } catch (e) {
    return { ok: false, result: describeContentScriptUnreachable(e.message, "\u8BFB\u53D6 DOM \u5FEB\u7167\u5931\u8D25\uFF1A") };
  }
}
async function listFrames(deps) {
  const tabId = deps.ctx.tabId;
  if (!tabId) return { ok: false, result: "\u65E0\u6CD5\u5B9A\u4F4D\u5F53\u524D\u6807\u7B7E\u9875\uFF08\u53EF\u80FD\u4E0D\u5728\u524D\u53F0\u9875\u9762\uFF09\u3002" };
  const frames = await listFramesRaw(deps, tabId);
  if (!frames.length) return { ok: false, result: "\u672A\u83B7\u53D6\u5230\u9875\u9762\u6846\u67B6\u4FE1\u606F\uFF08\u53EF\u80FD\u65E0\u5185\u5BB9\u811A\u672C\u6743\u9650\uFF09\u3002" };
  const text = frames.map((f) => (f.isTop ? "[\u9876\u5C42 frameId=0] " : "[frameId=" + f.frameId + "] ") + (f.title || "") + "\uFF5C" + f.href).join("\n");
  return {
    ok: true,
    frames,
    result: "\u9875\u9762\u6846\u67B6\uFF08\u542B\u8DE8\u57DF iframe\uFF0C\u5171 " + frames.length + " \u4E2A\uFF09\uFF1A\n" + text + "\n\u7528\u6CD5\uFF1A\u7528 get_page_snapshot \u7684 frameId \u53C2\u6570\u8BFB\u53D6\u67D0\u6846\u67B6\uFF1B\u6216\u5728 get_page_snapshot \u91CC\u4F20 includeFrames:true \u4E00\u6B21\u6027\u5408\u5E76\u6240\u6709\u6846\u67B6\u7684\u5143\u7D20\uFF08ref \u4F1A\u81EA\u52A8\u5E26 f<frameId>: \u524D\u7F00\uFF09\u3002"
  };
}
async function handlePageReadTool(name, args, deps) {
  if (name === "read_current_page") return await readCurrentPage(deps, args);
  if (name === "get_page_snapshot") return await getPageSnapshotTool(deps, args);
  if (name === "list_frames") return await listFrames(deps);
  return null;
}

// lib/assistant/userscript-tools.js
async function listUserscriptsTool(deps) {
  const scripts = await deps.listUserscripts();
  const text = scripts.length ? scripts.map(
    (s, i) => `[${i + 1}] ${s.name} v${s.version}${s.enabled ? "" : "\uFF08\u5DF2\u505C\u7528\uFF09"}
id\uFF1A${s.id}
\u5339\u914D\uFF1A${(s.matches || []).join("\u3001")}
\u63CF\u8FF0\uFF1A${s.description || "\u65E0"}`
  ).join("\n\n") : "\u5C1A\u672A\u5B89\u88C5\u4EFB\u4F55\u7528\u6237\u811A\u672C\u3002";
  return { ok: true, result: "\u5DF2\u5B89\u88C5\u7684\u7528\u6237\u811A\u672C\uFF1A\n" + text };
}
async function searchUserscripts(deps, args) {
  const list = await deps.searchScripts(args.query);
  return {
    ok: true,
    result: list.length ? "GreasyFork \u641C\u7D22\u7ED3\u679C\uFF1A\n" + list.map((it, i) => `[${i + 1}] ${it.name}\uFF08\u5B89\u88C5 ${it.installs}\uFF09
${it.description}
code_url\uFF1A${it.codeUrl}`).join("\n\n") : "\u672A\u627E\u5230\u76F8\u5173\u811A\u672C"
  };
}
async function installUserscript(deps, args) {
  const usSettings = await deps.getUserscriptSettings();
  if (!usSettings.agentCanInstall) {
    return { ok: false, result: "\u7528\u6237\u5DF2\u5728\u8BBE\u7F6E\u4E2D\u5173\u95ED\u201C\u5141\u8BB8 Agent \u5B89\u88C5\u811A\u672C\u201D\uFF0C\u8BF7\u6253\u5F00\u8BBE\u7F6E\u9875\u5F00\u542F\u540E\u518D\u8BD5\u3002" };
  }
  const r = await deps.installFromUrl(args.url);
  return {
    ok: true,
    result: "\u5DF2\u5B89\u88C5\u7528\u6237\u811A\u672C\uFF1A" + r.script.name + " v" + r.script.version + "\n\u5339\u914D\uFF1A" + (r.script.matches || []).join("\u3001") + (r.script.warnings && r.script.warnings.length ? "\n\u8B66\u544A\uFF1A" + r.script.warnings.join("\uFF1B") : "")
  };
}
async function runUserscript(deps, args) {
  const r = await deps.runUserscriptOnTab(deps.ctx.tabId, args.scriptId);
  return r.ok ? { ok: true, result: r.result } : { ok: false, result: r.error };
}
async function handleUserscriptTool(name, args, deps) {
  if (name === "list_userscripts") return await listUserscriptsTool(deps);
  if (name === "search_userscripts") return await searchUserscripts(deps, args);
  if (name === "install_userscript") return await installUserscript(deps, args);
  if (name === "run_userscript") return await runUserscript(deps, args);
  return null;
}

// lib/assistant/skill-tools.js
var COMMON_OPERATING_DISCIPLINE = [
  "## \u901A\u7528\u64CD\u4F5C\u7EAA\u5F8B\uFF08\u6240\u6709\u6280\u80FD\u5171\u7528\uFF0C\u52A1\u5FC5\u9075\u5B88\uFF09",
  "",
  "1. **\u5148\u770B\u6E05\u518D\u52A8\u624B**\uFF1A\u7528 `get_page_snapshot` \u786E\u8BA4\u9875\u9762\u4E0A\u5230\u5E95\u6709\u4EC0\u4E48\uFF0C\u4E0D\u8981\u51ED\u6280\u80FD\u6587\u6848\u91CC\u7684\u5047\u8BBE\u53BB\u70B9\u3002",
  "2. **\u4E00\u6B21\u53EA\u6539\u4E00\u4E2A\u53D8\u91CF**\uFF1A\u6539\u5B8C\u7ACB\u523B**\u56DE\u8BFB\u786E\u8BA4**\uFF08`inspect_element` \u8BFB\u503C/\u6837\u5F0F\uFF0C\u6216\u91CD\u65B0\u5FEB\u7167\uFF09\uFF0C",
  '   \u4E0D\u8981\u5047\u8BBE"\u70B9\u4E86\u5C31\u4E00\u5B9A\u751F\u6548"\u2014\u2014 \u5F88\u591A\u63A7\u4EF6\u7684\u70B9\u51FB\u662F\u5F02\u6B65\u7684\uFF0C\u6216\u6839\u672C\u6CA1\u751F\u6548\u3002',
  "3. **\u5173\u952E\u52A8\u4F5C\u540E\u590D\u6838**\uFF1A\u63D0\u4EA4/\u5220\u9664/\u8DF3\u8F6C\u8FD9\u7C7B\u4E0D\u53EF\u9006\u52A8\u4F5C\u4E4B\u540E\uFF0C\u91CD\u65B0\u8BFB\u4E00\u6B21\u9875\u9762\u72B6\u6001\u518D\u5F80\u4E0B\u8D70\u3002",
  "4. **\u5931\u8D25\u8981\u6362\u7B56\u7565\uFF0C\u4E0D\u8981\u91CD\u8BD5\u540C\u4E00\u6761\u8C03\u7528**\uFF1A\u540C\u4E00\u6761\u8DEF\u8FDE\u7EED\u5931\u8D25\u4E24\u6B21\uFF0C\u5C31\u6362\u4E00\u6761\uFF08\u6362\u9009\u62E9\u5668\u3001\u6362\u5B9A\u4F4D\u65B9\u5F0F\u3001",
  "   \u5148\u6EDA\u52A8/\u5148\u7B49\u5F85\uFF09\uFF1B\u4E0A\u4E0B\u6587\u91CC\u901A\u5E38\u5DF2\u7ECF\u5199\u660E\u4E86\u5931\u8D25\u539F\u56E0\uFF0C\u5148\u8BFB\u5B83\u3002",
  "5. **\u6536\u5C3E\u5FC5\u987B\u8C03 `complete_task`**\uFF1A\u5982\u5B9E\u8BF4\u660E**\u505A\u5230\u4E86\u4EC0\u4E48\u3001\u6CA1\u505A\u5230\u4EC0\u4E48\u3001\u4E3A\u4EC0\u4E48** \u2014\u2014",
  '   \u505A\u4E0D\u5230\u5C31\u8BF4\u505A\u4E0D\u5230\uFF0C\u4E0D\u8981\u7528"\u5DF2\u5C1D\u8BD5""\u5E94\u8BE5\u53EF\u4EE5"\u8FD9\u7C7B\u8BDD\u7CCA\u8FC7\u53BB\u3002',
  "6. **\u4E0D\u786E\u5B9A\u5C31\u8BF4\u4E0D\u786E\u5B9A**\uFF1A\u5B81\u53EF\u5C11\u505A\u4E00\u6B65\u518D\u95EE\uFF0C\u4E5F\u4E0D\u8981\u7F16\u9020\u9875\u9762\u5185\u5BB9\u6216\u64CD\u4F5C\u7ED3\u679C\u3002"
].join("\n");
async function loadSkill(deps, args) {
  const name = String(args && args.name || "").trim();
  if (!name) return { ok: false, result: "\u7F3A\u5C11\u6280\u80FD name \u53C2\u6570\u3002" };
  const all = await deps.getMergedSkills();
  const skill = all.find((s) => s.name === name || s.title === name || s.id === name);
  if (!skill) return { ok: false, result: "\u672A\u627E\u5230\u540D\u4E3A\u300C" + name + "\u300D\u7684\u6280\u80FD\u3002\u53EF\u7528\u6280\u80FD\u89C1\u7CFB\u7EDF\u63D0\u793A\u4E2D\u7684\u6280\u80FD\u76EE\u5F55\u3002" };
  const parts = ["# \u6280\u80FD\uFF1A" + (skill.title || skill.name)];
  if (skill.description) parts.push("\u7528\u9014\uFF1A" + skill.description);
  if (Array.isArray(skill.tags) && skill.tags.length) parts.push("\u6807\u7B7E\uFF1A" + skill.tags.join("\u3001"));
  if (skill.content) parts.push(skill.content);
  const toolWarnings = deps.validateSkillTools(skill);
  if (toolWarnings.length) {
    parts.push(
      "\u26A0 \u6CE8\u610F\uFF1A\u8BE5\u6280\u80FD\u58F0\u660E\u7684\u4F9D\u8D56\u5DE5\u5177\u5B58\u5728\u95EE\u9898\uFF0CAgent \u65E0\u6CD5\u8C03\u7528\uFF0C\u8BF7\u5230\u6280\u80FD\u9875\u66F4\u65B0\u4F9D\u8D56\u5DE5\u5177\u5217\u8868\uFF1A\n" + toolWarnings.map((w) => "- " + w).join("\n")
    );
  }
  return { result: parts.join("\n\n") };
}
async function installSkill(deps, args) {
  const identifier = String(args && (args.identifier || args.url) || "").trim();
  if (!identifier) return { ok: false, result: "\u7F3A\u5C11\u6280\u80FD identifier \u53C2\u6570\u3002" };
  return await deps.installSkillFromSkillHub(identifier);
}
var SKILL_TYPES = ["prompt-template", "mcp-server", "api-tool", "agent"];
var SKILL_INTENTS = ["browser_task", "knowledge_task", "research_task", "chat_task"];
var MIN_SKILL_CONTENT = 40;
var MAX_SKILL_CONTENT = 2e4;
function normalizeSkillName(input) {
  return String(input == null ? "" : input).trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-{2,}/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 64).replace(/-+$/, "");
}
function toStringList(value, limit) {
  const arr = Array.isArray(value) ? value : typeof value === "string" && value.trim() ? value.split(/[,\n]/) : [];
  return arr.map((x) => String(x == null ? "" : x).trim()).filter(Boolean).slice(0, limit);
}
async function saveSkill(deps, args) {
  const a = args || {};
  const name = normalizeSkillName(a.name);
  if (!name) {
    return {
      ok: false,
      result: "\u7F3A\u5C11\u6280\u80FD name\uFF0C\u6216\u5B83\u5F52\u4E00\u5316\u540E\u4E3A\u7A7A\uFF08name \u9700\u4E3A kebab-case\uFF1A\u5C0F\u5199\u5B57\u6BCD/\u6570\u5B57\uFF0C\u7528 - \u5206\u9694\uFF0C\u5982 publish-xhs-note\uFF09\u3002"
    };
  }
  const content = String(a.content || "").trim();
  if (content.length < MIN_SKILL_CONTENT) {
    return {
      ok: false,
      result: "\u6280\u80FD\u6B63\u6587\u592A\u77ED\uFF08" + content.length + " \u5B57\u7B26\uFF0C\u81F3\u5C11 " + MIN_SKILL_CONTENT + '\uFF09\u3002\u6B63\u6587\u8981\u5199"\u4EE5\u540E\u600E\u4E48\u505A"\uFF1A\u9002\u7528\u573A\u666F / \u6B65\u9AA4 / \u8FB9\u754C\u4E0E\u5751 / \u5B8C\u6210\u5224\u636E \u2014\u2014 \u53EA\u590D\u8FF0"\u8FD9\u6B21\u505A\u4E86\u4EC0\u4E48"\u4E0B\u6B21\u7528\u4E0D\u4E0A\u3002'
    };
  }
  if (content.length > MAX_SKILL_CONTENT) {
    return {
      ok: false,
      result: "\u6280\u80FD\u6B63\u6587\u8FC7\u957F\uFF08" + content.length + " > " + MAX_SKILL_CONTENT + " \u5B57\u7B26\uFF09\u3002\u8BF7\u53EA\u7559\u53EF\u590D\u7528\u7684\u8981\u70B9\u3002"
    };
  }
  const builtins = (typeof deps.getDefaultSkills === "function" ? deps.getDefaultSkills() : []) || [];
  if (builtins.some((s) => s && s.name === name)) {
    return {
      ok: false,
      result: "\u300C" + name + "\u300D\u4E0E**\u5185\u7F6E\u6280\u80FD**\u91CD\u540D\uFF1A\u5185\u7F6E\u4F18\u5148\uFF0C\u540C\u540D\u81EA\u5B9A\u4E49\u6280\u80FD\u4F1A\u88AB\u9759\u9ED8\u5FFD\u7565\uFF08\u4FDD\u5B58\u4E86\u4E5F\u4E0D\u751F\u6548\uFF09\u3002\u8BF7\u6362\u4E00\u4E2A name\uFF0C\u4F8B\u5982 " + name + "-custom\u3002"
    };
  }
  const skillType = SKILL_TYPES.includes(String(a.skill_type || "")) ? String(a.skill_type) : "prompt-template";
  const payload = {
    name,
    displayName: String(a.displayName || "").trim().slice(0, 80),
    description: String(a.description || "").trim().slice(0, 300),
    version: String(a.version || "1.0.0").trim() || "1.0.0",
    category: String(a.category || "").trim().slice(0, 40),
    tags: toStringList(a.tags, 8),
    skill_type: skillType,
    content,
    x: {
      intents: toStringList(a.intents, 4).filter((i) => SKILL_INTENTS.includes(i)),
      keywords: toStringList(a.keywords, 12),
      tools: toStringList(a.tools, 24)
    }
  };
  const existing = await deps.getUserSkills() || [];
  const isUpdate = existing.some((s) => s && s.name === name);
  let saved = null;
  try {
    saved = isUpdate ? await deps.updateUserSkill(name, payload) : await deps.addUserSkill(payload);
  } catch (e) {
    return {
      ok: false,
      result: "\u4FDD\u5B58\u6280\u80FD\u5931\u8D25\uFF1A" + (e && e.message || String(e)) + "\uFF08\u672C\u5730\u5B58\u50A8\u53EF\u80FD\u5DF2\u6EE1\u6216\u4E0D\u53EF\u7528\uFF0C\u53EF\u5728\u6280\u80FD\u9875\u786E\u8BA4\uFF09\u3002"
    };
  }
  if (!saved) return { ok: false, result: "\u4FDD\u5B58\u6280\u80FD\u5931\u8D25\uFF1A" + name + " \u672A\u80FD\u5199\u5165\u672C\u5730\u5B58\u50A8\uFF08\u6280\u80FD\u9875\u53EF\u786E\u8BA4\u5F53\u524D\u5217\u8868\uFF09\u3002" };
  const warnings = typeof deps.validateSkillTools === "function" ? deps.validateSkillTools(payload) : [];
  return {
    result: (isUpdate ? "\u5DF2\u66F4\u65B0\u6280\u80FD" : "\u5DF2\u4FDD\u5B58\u6280\u80FD") + "\u300C" + (saved.displayName || saved.name) + "\u300D\uFF08name=" + saved.name + "\uFF0C\u6B63\u6587 " + content.length + ' \u5B57\u7B26\uFF09\u3002\u5B83\u5DF2\u8FDB\u5165\u6280\u80FD\u76EE\u5F55\uFF0C\u4ECA\u540E\u53EF\u7528 load_skill("' + saved.name + '") \u52A0\u8F7D\u3002\n\u26A0 \u8BF7\u5230\u6269\u5C55\u7684\u300C\u6280\u80FD\u300D\u9875\u6838\u5BF9\u6B63\u6587\u4E0E\u89E6\u53D1\u6761\u4EF6\uFF1A\u5B83\u4F1A\u8FDB\u5165\u4ECA\u540E\u7684\u7CFB\u7EDF\u63D0\u793A\uFF0C\u5199\u9519\u4F1A\u6301\u7EED\u8BEF\u5BFC\u540E\u7EED\u4EFB\u52A1\u3002' + (warnings.length ? "\n\u4F9D\u8D56\u5DE5\u5177\u6709\u95EE\u9898\uFF08\u8FD0\u884C\u65F6\u4F1A\u88AB\u5FFD\u7565\uFF09\uFF1A\n" + warnings.map((w) => "- " + w).join("\n") : "")
  };
}
async function handleSkillTool(name, args, deps) {
  if (name === "load_skill") return await loadSkill(deps, args);
  if (name === "install_skill") return await installSkill(deps, args);
  if (name === "save_skill") return await saveSkill(deps, args);
  return null;
}

// lib/assistant/code-access-tools.js
var pageWorldPreferred = /* @__PURE__ */ new Set();
function tabKey(ctx) {
  return ctx && ctx.tabId != null ? String(ctx.tabId) : "";
}
async function runJavascript(deps, args) {
  const ctx = deps.ctx;
  if (args.engine === "page" || args.pageWorld === true) {
    return await deps.evaluateInPageWorld(ctx, args);
  }
  const key = tabKey(ctx);
  if (key && pageWorldPreferred.has(key) && deps.cdpAllowed(ctx)) {
    const direct = await deps.evaluateInPageWorld(ctx, args);
    if (direct && direct.ok) {
      return Object.assign({}, direct, {
        result: "\uFF08\u672C\u9875\u5DF2\u786E\u8BA4\u6C99\u7BB1\u4E0D\u53EF\u7528\uFF0C\u76F4\u63A5\u8D70\u9875\u9762\u4E3B\u4E16\u754C\u6267\u884C\uFF09\n" + (direct.result || "")
      });
    }
    return direct;
  }
  try {
    const r = await deps.executeContentAction(ctx.tabId, "run_javascript", { type: "kbRunJavaScript", params: args }, { delayMs: 80 });
    if (r && r.ok === false) {
      const msg = String(r && (r.error || r.result) || "");
      if (deps.isCspEvalBlockError(msg)) {
        if (key) pageWorldPreferred.add(key);
        if (!deps.cdpAllowed(ctx)) {
          return {
            ok: false,
            result: (
              // ⚠ 归因必须准确：**这不是页面造成的**。
              // 沙箱用 `new Function`，而 MV3 扩展自身的 CSP 不允许 eval ——
              // 实测在**完全没有 CSP** 的页面上同样被拒（原始错误里那条 directive 是扩展的，
              // 不是页面的）。此前文案写成"页面未放行 unsafe-eval"，会把用户与模型引向
              // "换个页面试试"这个错误方向 ✗
              "run_javascript \u9700\u8981\u9875\u9762\u4E3B\u4E16\u754C\u6267\u884C\uFF08CDP\uFF09\uFF0C\u5F53\u524D\u672A\u5F00\u542F\u3002\u539F\u56E0\uFF1A\u9ED8\u8BA4\u7684\u53D7\u9650\u6C99\u7BB1\u7528 `new Function` \u5B9E\u73B0\uFF0C\u800C **MV3 \u6269\u5C55\u81EA\u8EAB\u7684 CSP \u4E0D\u5141\u8BB8 eval** \u2014\u2014 \u8FD9\u4E0E\u9875\u9762\u65E0\u5173\uFF08\u5728\u6CA1\u6709\u4EFB\u4F55 CSP \u7684\u9875\u9762\u4E0A\u540C\u6837\u88AB\u62D2\uFF09\u3002\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u5F00\u542F\u300C\u6D4F\u89C8\u5668\u7EA7\u8F93\u5165\u5C42\uFF08CDP\uFF09\u300D\u540E\u91CD\u8BD5\u3002\u539F\u59CB\u9519\u8BEF\uFF1A" + msg.slice(0, 200)
            )
          };
        }
        const retry = await deps.evaluateInPageWorld(ctx, args);
        if (retry && retry.ok) {
          return Object.assign({}, retry, {
            result: "\uFF08\u6C99\u7BB1\u9700\u8981 eval\uFF0C\u800C MV3 \u6269\u5C55\u81EA\u8EAB\u7684 CSP \u4E0D\u5141\u8BB8 \u2014\u2014 \u5DF2\u81EA\u52A8\u6539\u7528\u9875\u9762\u4E3B\u4E16\u754C\u6267\u884C\uFF09\n" + (retry.result || "")
          });
        }
        return {
          ok: false,
          result: "\u6C99\u7BB1\u9700\u8981 eval\uFF08MV3 \u6269\u5C55\u81EA\u8EAB\u7684 CSP \u4E0D\u5141\u8BB8\uFF0C\u4E0E\u9875\u9762\u65E0\u5173\uFF09\uFF1B\u6539\u7528\u9875\u9762\u4E3B\u4E16\u754C\u540C\u6837\u5931\u8D25\uFF1A" + (retry && retry.result || "\u672A\u77E5\u9519\u8BEF")
        };
      }
      return r;
    }
    if (r && r.verification) {
      r.verification.reason = "JS \u5DF2\u6267\u884C\uFF0C\u8FD4\u56DE\u7ED3\u679C\u89C1\u4E0A";
    }
    return r;
  } catch (e) {
    return { ok: false, result: describeContentScriptUnreachable(e.message, "\u6267\u884C JS \u5931\u8D25\uFF1A") };
  }
}
var INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "gridcell"
]);
async function collectAssistantPanelNodeIds(cdp, tabId) {
  if (!cdp || typeof cdp.command !== "function") return /* @__PURE__ */ new Set();
  try {
    const doc = await cdp.command(tabId, "DOM.getDocument", { depth: 0 });
    const rootId = doc && doc.root && doc.root.nodeId;
    if (!rootId) return /* @__PURE__ */ new Set();
    const hit = await cdp.command(tabId, "DOM.querySelector", { nodeId: rootId, selector: "#__kb-ai-host" });
    if (!hit || !hit.nodeId) return /* @__PURE__ */ new Set();
    const desc = await cdp.command(tabId, "DOM.describeNode", { nodeId: hit.nodeId, depth: -1, pierce: true });
    const ids = /* @__PURE__ */ new Set();
    const walk = (node) => {
      if (!node) return;
      if (node.backendNodeId) ids.add(node.backendNodeId);
      for (const child of node.children || []) walk(child);
      for (const child of node.shadowRoots || []) walk(child);
      if (node.contentDocument) walk(node.contentDocument);
    };
    walk(desc && desc.node);
    return ids;
  } catch (e) {
    return /* @__PURE__ */ new Set();
  }
}
async function getAxSnapshot(deps, args) {
  const ctx = deps.ctx;
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: "\u53EF\u8BBF\u95EE\u6027\u6811\u5FEB\u7167\u9700\u8981 CDP\uFF08\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u5F00\u542F\uFF09\u3002" };
  try {
    const [nodes, excluded] = await Promise.all([
      deps.cdp.getFullAxTree(ctx.tabId),
      collectAssistantPanelNodeIds(deps.cdp, ctx.tabId)
    ]);
    const limit = Math.min(120, Math.max(1, Number(args.limit) || 60));
    const picked = [];
    for (const n of nodes) {
      if (!n || n.ignored) continue;
      if (n.backendDOMNodeId && excluded.has(n.backendDOMNodeId)) continue;
      const role = n.role && n.role.value;
      if (!role || !INTERACTIVE_ROLES.has(role)) continue;
      const name = String(n.name && n.name.value || "").slice(0, 120);
      picked.push({ role, name, locator: { role, name }, backendDOMNodeId: n.backendDOMNodeId });
      if (picked.length >= limit) break;
    }
    const withBox = [];
    for (const p of picked) {
      if (!p.backendDOMNodeId) {
        withBox.push(p);
        continue;
      }
      try {
        const box = await deps.cdp.getBoxModel(ctx.tabId, p.backendDOMNodeId);
        const q = box && box.content;
        if (q && q.length >= 8) {
          const cx = Math.round((q[0] + q[2] + q[4] + q[6]) / 4);
          const cy = Math.round((q[1] + q[3] + q[5] + q[7]) / 4);
          withBox.push(Object.assign({}, p, { x: cx, y: cy }));
        } else {
          withBox.push(p);
        }
      } catch (e) {
        withBox.push(p);
      }
    }
    const lines = withBox.map((p, i) => "[" + (i + 1) + "] " + p.role + "\u300C" + p.name + "\u300D" + (p.x != null ? " \u5750\u6807(" + p.x + "," + p.y + ")" : ""));
    return {
      ok: true,
      ax: withBox,
      result: "\u53EF\u8BBF\u95EE\u6027\u6811\uFF08\u4EA4\u4E92\u8282\u70B9 " + withBox.length + " \u4E2A\uFF0C\u542B role/\u540D\u79F0/\u5750\u6807\uFF09\uFF1A\n" + (lines.join("\n") || "\uFF08\u65E0\uFF09") + '\n\u7528\u6CD5\uFF1A\u4F18\u5148\u7528 role+name \u5B9A\u4F4D\uFF08\u5982 click_element({role:"button",name:"\u767B\u5F55"})\uFF09\uFF0C\u6BD4\u5750\u6807\u66F4\u7A33\uFF1Bcanvas/\u865A\u62DF\u5217\u8868\u7B49\u65E0 DOM \u573A\u666F\u518D\u7528\u5750\u6807 click_at\u3002'
    };
  } catch (e) {
    return { ok: false, result: "\u8BFB\u53D6\u53EF\u8BBF\u95EE\u6027\u6811\u5931\u8D25\uFF1A" + deps.summarizeCdpError(e) };
  }
}
async function handleCodeAccessTool(name, args, deps) {
  if (name === "run_javascript") return await runJavascript(deps, args);
  if (name === "get_ax_snapshot") return await getAxSnapshot(deps, args);
  return null;
}

// lib/assistant/page-command-tools.js
var ANNOTATE_OPS = Object.freeze({
  highlight: "highlight",
  outline: "outline",
  style: "set_style",
  clear: "clear_highlights"
});
var INSPECT_OPS = Object.freeze({
  text: "get_text",
  inspect: "inspect_element",
  table: "extract_table",
  // 读**计算后的**样式。补这一档的原因见 commands.js 的 cmdReadStyles：
  // 在此之前"验证样式改没改成功"只能借道 run_javascript，
  // 而它归入「页面命令」审批（默认仍会打断用户）且要开 CDP 才能执行（沙箱依赖 eval，MV3 CSP 不允许）。
  styles: "read_styles",
  // 读 `<select>` 的**选项清单**。与 styles 同一类缺口：
  // 闭合的 `<select>` 里 `<option>` 没有布局盒子，正文抽取按"不可见"跳过 ——
  // 所以 `get_page_snapshot` 的正文里**看不到选项**（价格/规格常常只写在选项里），
  // 而 `get_attribute` 只读属性、读不了 `outerHTML`。
  // 实测（真模型探针）：任务"选最便宜的那个"时，模型只能先写一段 run_javascript
  // 去 `Array.from(s.options).map(...)` —— 白花一次高危审批，且 CSP 严的页面还会直接失败。
  options: "read_options",
  // 结构化候选查询：返回 ref / rect / role / name / customElement / shadowDepth。
  // 用于替代“找 custom element、读 rect、查 shadow”的探索性 run_javascript。
  query: "query_elements"
});
async function annotate(deps, args) {
  const ctx = deps.ctx;
  const op = String(args.op || "").trim();
  const cmd = ANNOTATE_OPS[op];
  if (!cmd) {
    return deps.toolError("BAD_ARGS", "annotate \u9700\u8981 op \u53C2\u6570\uFF0C\u53D6\u503C\uFF1A" + Object.keys(ANNOTATE_OPS).join(" / ") + "\u3002");
  }
  const rest = Object.assign({}, args);
  delete rest.op;
  if (op === "clear") return await deps.executePageTool(ctx.tabId, cmd, {}, ctx);
  return await deps.executePageTool(ctx.tabId, cmd, rest, ctx);
}
async function inspectElement(deps, args) {
  const op = String(args.op || "").trim();
  const cmd = INSPECT_OPS[op];
  if (!cmd) {
    return deps.toolError("BAD_ARGS", "inspect_element \u9700\u8981 op \u53C2\u6570\uFF0C\u53D6\u503C\uFF1A" + Object.keys(INSPECT_OPS).join(" / ") + "\u3002");
  }
  const rest = Object.assign({}, args);
  delete rest.op;
  return await deps.executePageTool(deps.ctx.tabId, cmd, rest, deps.ctx);
}
async function scrollPage(deps, args) {
  const params = args || {};
  const hasTarget = Boolean(params.ref || params.selector || params.text);
  const hasCoords = typeof params.top === "number" || typeof params.left === "number";
  return await deps.executePageTool(deps.ctx.tabId, hasTarget || hasCoords ? "scroll_to" : "scroll_by", params, deps.ctx);
}
async function getElementSource(deps, args) {
  const tabId = deps.ctx.tabId;
  if (!tabId) return { ok: false, result: "\u65E0\u6CD5\u5B9A\u4F4D\u5F53\u524D\u6807\u7B7E\u9875\uFF08\u53EF\u80FD\u4E0D\u5728\u524D\u53F0\u9875\u9762\uFF09\u3002" };
  try {
    const res = await deps.sendTabMessage(tabId, { type: "kbGetElementSource", params: args });
    if (!res || !res.found) return { ok: false, result: res && res.reason || "\u672A\u627E\u5230\u5143\u7D20\u6216\u6846\u67B6\u6E90\u7801\u4FE1\u606F\u3002" };
    const s = res.source || {};
    const loc = String(s.file || "") + (s.line ? ":" + s.line + (s.column ? ":" + s.column : "") : "");
    const extra = s.framework ? "\uFF08" + s.framework + (s.component ? " \xB7 " + s.component : "") + "\uFF09" : "";
    return { ok: true, result: "\u5143\u7D20\u6E90\u7801\u4F4D\u7F6E\uFF1A" + loc + extra + (res.selector ? "\n\u9009\u62E9\u5668\uFF1A" + res.selector : "") };
  } catch (e) {
    return { ok: false, result: "\u89E3\u6790\u5143\u7D20\u6E90\u7801\u5931\u8D25\uFF1A" + e.message };
  }
}
async function undoLastAction(deps, args) {
  return await deps.executeContentAction(deps.ctx.tabId, "undo_last_action", { type: "kbUndo", params: args }, { verify: false });
}
async function handlePageCommandTool(name, args, deps) {
  if (name === "annotate") return await annotate(deps, args);
  if (name === "inspect_element") return await inspectElement(deps, args);
  if (name === "scroll_page") return await scrollPage(deps, args);
  if (name === "get_element_source") return await getElementSource(deps, args);
  if (name === "undo_last_action") return await undoLastAction(deps, args);
  return null;
}

// lib/assistant/knowledge-store-tools.js
async function knowledgeReadTool(deps, args) {
  return deps.knowledgeRead(
    { book: deps.ctx.book, buildRagContext: deps.buildRagContext, buildCitations: deps.buildCitations, typeInfo: deps.typeInfo, starLevels: deps.STAR_LEVELS },
    args
  );
}
async function addEntry(deps, args) {
  const ctx = deps.ctx;
  const id = args.id || args.url || "kb:" + Date.now() + ":" + Math.random().toString(36).slice(2, 8);
  const created = await deps.upsertItem({
    id,
    type: args.type || "note",
    title: args.title || "\u672A\u547D\u540D",
    url: args.url || "",
    status: args.status || deps.STATUS.IMPORTANT,
    note: args.note || "",
    tags: Array.isArray(args.tags) ? args.tags : []
  });
  ctx.book = await deps.getBook();
  return { result: `\u5DF2\u4FDD\u5B58\u6761\u76EE\uFF1A\u6807\u9898\u300C${created.title}\u300D(id: ${created.id})\u3002`, savedId: created.id };
}
async function removeEntry(deps, args) {
  const ctx = deps.ctx;
  if (!ctx.book[args.id]) return { result: "\u672A\u627E\u5230\u8BE5\u6761\u76EE\uFF0C\u65E0\u9700\u5220\u9664\u3002" };
  await deps.deleteItem(args.id);
  ctx.book = await deps.getBook();
  return { result: "\u5DF2\u5220\u9664\u6761\u76EE (id: " + args.id + ")\u3002" };
}
async function handleKnowledgeStoreTool(name, args, deps) {
  if (name === "knowledge_read") return await knowledgeReadTool(deps, args);
  if (name === "add_entry") return await addEntry(deps, args);
  if (name === "remove_entry") return await removeEntry(deps, args);
  return null;
}

// lib/assistant/tools.js
var TOOL_REGISTRY = Object.freeze(
  TOOL_SCHEMAS.map((tool) => {
    const name = tool.function.name;
    const metadata = TOOL_METADATA[name] || { risk: "unknown", requiresApproval: true, route: "background" };
    return Object.freeze({
      name,
      description: tool.function.description,
      inputSchema: tool.function.parameters,
      risk: metadata.risk,
      requiresApproval: metadata.requiresApproval === true,
      readOnly: metadata.readOnly === true,
      // 「不改动状态」的独立声明：readOnly 在本仓库还隐含「不需要审批」，
      // 而 fetch_webpage 这类要联网读、必须审批的工具无法用 readOnly 表达。
      // readOnly 的工具天然不改状态，因此两者在这里合流成一个字段。
      mutatesState: metadata.readOnly === true ? false : metadata.mutatesState !== false,
      // ⚠ parallelSafe 原先在这里被漏掉了，而它是 agent.js 里唯一的并发判定依据
      // （isParallelSafe: name => getToolMetadata(name).parallelSafe === true）。
      // 于是 14 个声明了 parallelSafe 的工具全被判为不可并发 ⇒ 并行分组恒为空。
      parallelSafe: metadata.parallelSafe === true,
      alwaysAvailable: metadata.alwaysAvailable === true,
      alwaysRequireApproval: metadata.alwaysRequireApproval === true,
      route: metadata.route || "background",
      timeoutMs: Number(metadata.timeoutMs) > 0 ? Number(metadata.timeoutMs) : 0,
      openai: tool
    });
  })
);
var TOOL_BY_NAME = new Map(TOOL_REGISTRY.map((tool) => [tool.name, tool]));
var BUILTIN_TOOLS = TOOL_REGISTRY.map((tool) => tool.openai);
function getToolDefinition(name) {
  return TOOL_BY_NAME.get(name) || null;
}
var TOOL_RENAME_MAP = Object.freeze({
  scroll_to_element: "scroll_page",
  search_knowledge_base: "knowledge_read",
  list_knowledge_base: "knowledge_read",
  get_entry: "knowledge_read"
});
function validateSkillTools(skill) {
  if (!skill) return [];
  const declared = Array.isArray(skill.tools) ? skill.tools : skill.x && Array.isArray(skill.x.tools) ? skill.x.tools : [];
  const existing = new Set(TOOL_REGISTRY.map((t) => t.name));
  const warnings = [];
  for (const tn of declared) {
    if (typeof tn !== "string" || !tn) continue;
    if (existing.has(tn)) continue;
    const renamed = TOOL_RENAME_MAP[tn];
    warnings.push(renamed ? "\u300C" + tn + "\u300D\u5DF2\u66F4\u540D\u4E3A\u300C" + renamed + "\u300D" : "\u300C" + tn + "\u300D\u4E0D\u662F\u53EF\u7528\u5DE5\u5177");
  }
  return warnings;
}
var EMPTY_STRING_ALLOWED = /* @__PURE__ */ new Set(["type_text.value"]);
function validateToolCall(name, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "\u5DE5\u5177\u53C2\u6570\u5FC5\u987B\u662F JSON \u5BF9\u8C61\u3002" };
  }
  const definition = getToolDefinition(name);
  if (!definition) {
    if (typeof name === "string" && name.indexOf("mcp__") === 0) return { ok: true };
    return { ok: false, error: "\u672A\u77E5\u5DE5\u5177\uFF1A" + name };
  }
  const required = definition.inputSchema && Array.isArray(definition.inputSchema.required) ? definition.inputSchema.required : [];
  const missing = required.filter((key) => {
    const v = args[key];
    if (v === void 0 || v === null) return true;
    if (v === "") return !EMPTY_STRING_ALLOWED.has(name + "." + key);
    return false;
  });
  return missing.length ? { ok: false, error: "\u5DE5\u5177\u300C" + name + "\u300D\u7F3A\u5C11\u5FC5\u586B\u53C2\u6570\uFF1A" + missing.join("\u3001") } : { ok: true };
}
function sendTabMessage(tabId, message, frameId) {
  return sendTabMessageWithInjection(chrome, tabId, message, frameId);
}
function cdpAllowed(ctx) {
  return Boolean(ctx && ctx.settings && ctx.settings.cdpEnabled !== false && isCdpAvailable());
}
function buildPageWorldExpression(code) {
  return "(async () => {\n" + String(code === void 0 || code === null ? "" : code) + "\n})()";
}
async function evaluateInPageWorld(ctx, args) {
  if (!cdpAllowed(ctx)) return { ok: false, result: "\u9875\u9762\u4E16\u754C\u6267\u884C\u9700\u8981 CDP\uFF08\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u5F00\u542F\uFF09\u3002" };
  try {
    const jsFrame = frameIdFromArgs(args);
    const expr = buildPageWorldExpression(args && args.code);
    const value = jsFrame != null && jsFrame !== 0 ? await evaluateInFrame(ctx.tabId, jsFrame, expr) : await evaluate(ctx.tabId, expr);
    let serialized;
    try {
      serialized = JSON.stringify(value, null, 2);
    } catch (e) {
      serialized = String(value);
    }
    if (serialized === void 0) serialized = "undefined";
    if (serialized.length > 2e3) serialized = sliceSafe(serialized, 0, 2e3) + "\n\u2026\uFF08\u7ED3\u679C\u8FC7\u957F\u5DF2\u622A\u65AD\uFF09";
    return { ok: true, cdp: true, result: serialized };
  } catch (e) {
    return { ok: false, result: "\u9875\u9762\u4E16\u754C\u6267\u884C\u5931\u8D25\uFF1A" + summarizeCdpError(e) };
  }
}
async function resolveTarget(tabId, params) {
  if (!tabId) return null;
  const frameId = frameIdFromArgs(params);
  try {
    const res = await sendTabMessage(tabId, { type: "kbResolveTarget", params: localTargetArgs(params) }, frameId);
    return res && res.found && res.rect ? res : null;
  } catch (e) {
    return null;
  }
}
function rememberTarget(ctx, target) {
  if (!ctx || !ctx.settings || ctx.settings.siteMemoryEnabled === false) return;
  if (!target || !target.selector) return;
  rememberElement(ctx.pageUrl, target).catch(() => {
  });
}
function trackOpenedTab(ctx, tabId) {
  if (!ctx || !Number.isInteger(Number(tabId))) return;
  if (!Array.isArray(ctx.openedTabs)) ctx.openedTabs = [];
  if (!ctx.openedTabs.includes(tabId)) ctx.openedTabs.push(tabId);
}
async function ensureAgentWindow(ctx) {
  if (Number.isInteger(ctx.agentWindowId)) {
    try {
      await chrome.windows.get(ctx.agentWindowId);
      return ctx.agentWindowId;
    } catch (e) {
      ctx.agentWindowId = null;
    }
  }
  const win = await chrome.windows.create({ url: "about:blank", state: "minimized", focused: false });
  ctx.agentWindowId = win.id;
  return win.id;
}
async function listOpenedTabsSummary(ctx) {
  const ids = (Array.isArray(ctx.openedTabs) ? ctx.openedTabs : []).filter((id) => Number.isInteger(Number(id)));
  if (!ids.length) return "";
  const lines = [];
  for (const id of ids) {
    const t = await chrome.tabs.get(id).catch(() => null);
    if (t && t.id && t.url) lines.push("tabId=" + t.id + " " + (t.title || "") + "\uFF5C" + t.url);
  }
  return lines.join("\n");
}
async function bindSessionTab(tabId) {
  if (!Number.isInteger(Number(tabId))) return;
  try {
    await chrome.storage.local.set({ kbSessionTab: { tabId: Number(tabId), ts: Date.now() } });
  } catch (e) {
  }
}
async function getPageSnapshot(tabId, options = {}) {
  if (!tabId) return null;
  const snapshot = await sendTabMessage(tabId, { type: "kbGetPageSnapshot", options }, options.frameId);
  return snapshot && snapshot.version ? snapshot : null;
}
async function waitForTabReady(tabId, timeoutMs = 8e3) {
  const deadline = Date.now() + Math.min(12e3, Math.max(500, timeoutMs));
  while (Date.now() < deadline) {
    const snapshot = await getPageSnapshot(tabId, { maxElements: 30, maxText: 800 }).catch(() => null);
    if (snapshot) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}
async function executeContentAction(tabId, action, message, options = {}) {
  if (!tabId) return toolError("NO_TARGET", "\u65E0\u6CD5\u5B9A\u4F4D\u5F53\u524D\u6807\u7B7E\u9875\uFF08\u53EF\u80FD\u4E0D\u5728\u524D\u53F0\u9875\u9762\uFF09\u3002");
  const frameId = options.frameId != null ? options.frameId : frameIdFromArgs(message && message.params);
  const msg = Object.assign({}, message, { params: localTargetArgs(message && message.params) });
  const shouldVerify = options.verify !== false;
  const before = shouldVerify ? await getPageSnapshot(tabId, { maxElements: 50, maxText: 1600, frameId }).catch(() => null) : null;
  const response = await sendTabMessage(tabId, msg, frameId);
  if (!response) return toolError("PAGE_UNREACHABLE", "\u9875\u9762\u5185\u5BB9\u811A\u672C\u65E0\u54CD\u5E94\u6216\u5C1A\u672A\u6CE8\u5165\u3002");
  if (response.ok === false) return toolError("PAGE_ACTION_FAILED", response.error || response.result || "\u9875\u9762\u52A8\u4F5C\u5931\u8D25\uFF1A" + action);
  if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  let after = shouldVerify ? await getPageSnapshot(tabId, { maxElements: 50, maxText: 1600, frameId }).catch(() => null) : null;
  if (shouldVerify && !after && before) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && tab.url) after = { version: 1, url: tab.url, title: tab.title || "", fingerprint: "navigation:" + tab.url, scroll: null };
  }
  const verification = shouldVerify ? verifyPageAction(action, before, after, response) : (
    // 未做观测就不声称已验证（原实现写 verified:true + changed:false，语义矛盾）。
    buildActionVerification("unobservable", "\u672A\u505A\u9875\u9762\u53D8\u5316\u89C2\u6D4B")
  );
  return {
    ...response,
    ok: true,
    hadEffect: Boolean(verification.changed),
    result: (response.result || "\u5DF2\u6267\u884C\u9875\u9762\u52A8\u4F5C\uFF1A" + action) + (shouldVerify ? "\n\u9A8C\u8BC1\uFF1A" + verification.reason : ""),
    verification,
    pageSnapshot: after
  };
}
async function executePageTool(tabId, command2, args, ctx) {
  if (!tabId) return toolError("NO_TARGET", "\u65E0\u6CD5\u5B9A\u4F4D\u5F53\u524D\u6807\u7B7E\u9875\uFF08\u53EF\u80FD\u4E0D\u5728\u524D\u53F0\u9875\u9762\uFF09\u3002");
  try {
    const frameId = frameIdFromArgs(args);
    const localArgs = localTargetArgs(args);
    const shouldVerify = ["click", "scroll_to", "scroll_by", "set_style"].includes(command2);
    const beforeTabs = command2 === "click" ? await chrome.tabs.query({ currentWindow: true }).catch(() => null) : null;
    const before = shouldVerify ? await getPageSnapshot(tabId, { maxElements: 40, maxText: 1200, frameId }).catch(() => null) : null;
    const res = await sendTabMessage(tabId, { type: "kbPageCommand", command: command2, params: localArgs }, frameId);
    if (!res) return toolError("PAGE_UNREACHABLE", "\u9875\u9762\u547D\u4EE4\u65E0\u54CD\u5E94\uFF08\u5185\u5BB9\u811A\u672C\u672A\u6CE8\u5165\u6216\u9875\u9762\u4E0D\u652F\u6301\uFF09\u3002");
    if (res.ok === false) return toolError("PAGE_COMMAND_FAILED", "\u9875\u9762\u547D\u4EE4\u300C" + command2 + "\u300D\u5931\u8D25\uFF1A" + (res.error || "\u672A\u77E5\u9519\u8BEF"));
    const polling = shouldVerify && (command2 === "click" || command2 === "scroll_to" || command2 === "scroll_by");
    let after = null;
    if (polling) {
      const deadline = Date.now() + (command2 === "click" ? 4500 : 1800);
      let nullStreak = 0;
      while (Date.now() < deadline) {
        if (command2 === "click" && beforeTabs && Array.isArray(beforeTabs)) {
          const existingIds = new Set(beforeTabs.map((t) => t.id));
          const nowTabs = await chrome.tabs.query({ currentWindow: true }).catch(() => []);
          const newTab = nowTabs.find((t) => t.id && !existingIds.has(t.id));
          if (newTab && newTab.id) {
            const snap2 = await waitForTabReady(newTab.id, 7e3);
            const current = await chrome.tabs.get(newTab.id).catch(() => newTab);
            const targetTab = {
              tabId: newTab.id,
              windowId: current.windowId || newTab.windowId,
              title: current.title || newTab.title || "",
              url: current.url || newTab.url || "",
              ready: Boolean(snap2)
            };
            ctx.tabId = newTab.id;
            ctx.pageUrl = targetTab.url || ctx.pageUrl;
            ctx.pageTitle = targetTab.title || ctx.pageTitle;
            ctx.openedTabCount = Number(ctx.openedTabCount || 0) + 1;
            trackOpenedTab(ctx, newTab.id);
            bindSessionTab(newTab.id);
            return {
              ok: true,
              hadEffect: true,
              targetTabId: newTab.id,
              targetTab,
              pageSnapshot: snap2,
              // 同下面主返回：`selector` 必须转发（宏记录要靠它定位目标）
              selector: res && res.selector || "",
              result: "\u70B9\u51FB\u5DF2\u6D3E\u53D1\uFF0C\u68C0\u6D4B\u5230\u65B0\u6807\u7B7E\u9875\u5E76\u5DF2\u81EA\u52A8\u7ED1\u5B9A\uFF1AtabId=" + newTab.id + " " + targetTab.url + (snap2 ? "\n" + compactSnapshotSummary(snap2) + "\n\uFF08\u9875\u9762\u5DF2\u5C31\u7EEA\uFF0C\u53EF\u76F4\u63A5\u636E\u6B64\u5224\u65AD\u4EFB\u52A1\u662F\u5426\u5B8C\u6210\uFF09" : "\uFF08\u5185\u5BB9\u811A\u672C\u5C1A\u672A\u5C31\u7EEA\uFF09")
            };
          }
        }
        const snap = await getPageSnapshot(tabId, { maxElements: 40, maxText: 1200, frameId }).catch(() => null);
        if (snap) {
          nullStreak = 0;
          after = snap;
          if (snapshotChanged(before, snap, command2)) break;
        } else {
          nullStreak += 1;
          if (nullStreak >= 3) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 220));
      }
    } else if (shouldVerify) {
      await new Promise((resolve) => setTimeout(resolve, 160));
      after = await getPageSnapshot(tabId, { maxElements: 40, maxText: 1200, frameId }).catch(() => null);
    }
    if (shouldVerify && !after && before) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && tab.url) after = { version: 1, url: tab.url, title: tab.title || "", fingerprint: "navigation:" + tab.url, scroll: null };
    }
    const verification = shouldVerify ? verifyPageAction(command2, before, after, res) : buildActionVerification(
      "unobservable",
      "\u8BFB\u53D6\u7C7B\u547D\u4EE4\u65E0\u9700\u9875\u9762\u53D8\u5316\u9A8C\u8BC1"
    );
    if (after && after.url) {
      ctx.pageUrl = after.url || ctx.pageUrl;
      ctx.pageTitle = after.title || ctx.pageTitle;
    }
    return {
      ok: true,
      hadEffect: Boolean(verification.changed),
      // ⚠ `selector` 必须转发出去 —— 它是**宏记录的定位依据**：
      // `recordTraceStep`（tools.js 上部）在没有 `res.selector` 时**整步都不记录**，
      // 而这里原先是"重建对象"，把内容脚本返回的 `selector` 丢掉了。
      // 后果：`click_element` 的动作**永远进不了宏**，于是宏回放只能重放输入/选择、
      // 不能重放点击 —— 而点击恰恰是宏最主要的动作（实测：宏里只有 2 步，
      // 回放后页面计数停在 1，什么都没发生）。
      // 注意 `type_text` / `select_option` 走的是各自的 handler（透传内容脚本结果），
      // 所以只有走本函数的这一族（click / scroll / set_style / 等）受影响 ——
      // 这种"同一类操作里一半好一半坏"的不一致最难从现象反推。
      selector: res && res.selector || "",
      result: (res.result || "\u5DF2\u6267\u884C\u9875\u9762\u547D\u4EE4\uFF1A" + command2) + "\n\u9A8C\u8BC1\uFF1A" + verification.reason + (command2 === "click" && after ? "\n" + compactSnapshotSummary(after) : ""),
      verification,
      pageSnapshot: after
    };
  } catch (e) {
    return { ok: false, result: "\u9875\u9762\u547D\u4EE4\u6267\u884C\u5931\u8D25\uFF1A" + e.message };
  }
}
async function fetchRealSkillMd(apiBase, slug, ns, signal) {
  try {
    const fileUrl = apiBase + "/skills/" + encodeURIComponent(slug) + "/file?path=SKILL.md" + (ns ? "&namespace=" + encodeURIComponent(ns) : "");
    const fileResp = await fetch(fileUrl, { headers: { Accept: "text/plain, */*" }, signal });
    if (!fileResp.ok) return null;
    const rawMd = await fileResp.text();
    if (!rawMd || !rawMd.trim()) return null;
    if (!/^---\s*\r?\n/.test(rawMd) && !/^\s*name\s*:/.test(rawMd)) return null;
    const parsed = mdToSkill(rawMd);
    if (!parsed || !parsed.name) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}
async function installSkillFromSkillHub(identifier) {
  const raw = String(identifier || "").trim();
  if (!raw) return { ok: false, result: "\u7F3A\u5C11\u6280\u80FD identifier \u53C2\u6570\uFF08\u5E94\u4E3A @namespace/slug \u6216\u6280\u80FD\u9875 URL \u6216\u5173\u952E\u8BCD\uFF09\u3002" };
  let ns = null;
  let slug = null;
  let keyword = raw;
  const at = raw.match(/^@?([\w.-]+)\/([\w.-]+)$/);
  if (at) {
    ns = at[1];
    slug = at[2];
    keyword = slug;
  } else {
    try {
      const u = new URL(raw);
      if (!/(^|\.)skillhub\.cn$/i.test(u.hostname)) {
        return { ok: false, result: "\u51FA\u4E8E\u5B89\u5168\u9650\u5236\uFF0C\u4EC5\u5141\u8BB8\u4ECE skillhub.cn \u5B89\u88C5\u6280\u80FD\u3002" };
      }
      const m = u.pathname.match(/\/skills\/([^/]+)\/([^/?#]+)/) || u.pathname.match(/\/([^/]+)\/([^/?#]+?)(?:\.html)?$/);
      if (m) {
        ns = decodeURIComponent(m[1]);
        slug = decodeURIComponent(m[2]);
        keyword = slug;
      }
    } catch (e) {
    }
  }
  const apiBase = "https://api.skillhub.cn/api/v1";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15e3);
  try {
    const searchUrl = apiBase + "/search?keyword=" + encodeURIComponent(keyword);
    const searchResp = await fetch(searchUrl, { headers: { Accept: "application/json" }, signal: ctrl.signal });
    if (!searchResp.ok) {
      return { ok: false, result: "SkillHub \u68C0\u7D22\u63A5\u53E3\u8FD4\u56DE " + searchResp.status + "\uFF08\u8BE5\u63A5\u53E3\u53EF\u80FD\u9700\u767B\u5F55\u6216\u5DF2\u8C03\u6574\uFF09\u3002" };
    }
    const searchJson = await searchResp.json();
    const results = Array.isArray(searchJson.results) ? searchJson.results : Array.isArray(searchJson) ? searchJson : [];
    let hit = null;
    if (slug) hit = results.find((r) => r.slug === slug || r.namespace && r.namespace.publicSlug === slug);
    if (!hit && ns) {
      hit = results.find((r) => r.namespace && (r.namespace.handle === ns || r.namespace.canonicalName === "@" + ns + "/" + (slug || "")));
    }
    if (!hit) hit = results[0];
    if (!hit) return { ok: false, result: "SkillHub \u672A\u68C0\u7D22\u5230\u5339\u914D\u300C" + keyword + "\u300D\u7684\u6280\u80FD\u3002" };
    const name = hit.slug || hit.name;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name || "")) {
      return { ok: false, result: "\u6280\u80FD\u540D\uFF08slug\uFF09\u5FC5\u987B\u662F kebab-case\uFF0C\u5B9E\u9645\u4E3A\uFF1A" + name };
    }
    if (!ns && hit.namespace && hit.namespace.handle) ns = hit.namespace.handle;
    const existing = await getUserSkills();
    const alreadyInstalled = existing.some((s) => s.name === name);
    let skill = await fetchRealSkillMd(apiBase, name, ns, ctrl.signal);
    let generative = false;
    if (!skill) {
      generative = true;
      const summary = (hit.summary || hit.description || hit.description_zh || "").toString();
      const description = sliceSafe((hit.description_zh || hit.description || summary || "").toString(), 0, 300);
      skill = {
        name,
        displayName: hit.displayName || hit.name,
        description,
        version: hit.version || "1.0.0",
        category: hit.category || "",
        tags: Array.isArray(hit.tags) ? hit.tags : [],
        skill_type: "prompt-template",
        content: "# " + (hit.displayName || hit.name) + "\uFF08SkillHub \u5B89\u88C5\uFF09\n\n\u6765\u6E90\uFF1ASkillHub\uFF08" + (hit.namespace ? hit.namespace.canonicalName : "") + "\uFF09\n\u4E3B\u9875\uFF1A" + (hit.homepage || "") + "\n\n\u7528\u9014\uFF1A" + summary + "\n\n\u8BF4\u660E\uFF1A\u672C\u6280\u80FD\u7531 RecallFlow \u57FA\u4E8E SkillHub \u68C0\u7D22\u5143\u6570\u636E\u81EA\u52A8\u5B89\u88C5\uFF0C\u5185\u5BB9\u4E3A\u6458\u8981\u800C\u975E\u4E0A\u6E38\u9010\u5B57 SKILL.md\u3002\u5982\u9700\u5B8C\u6574\u64CD\u4F5C\u6307\u5F15\uFF0C\u8BF7\u8BBF\u95EE\u4E0A\u8FF0\u4E3B\u9875\uFF0C\u6216\u5728\u8BE5\u9875\u9762\u590D\u5236 SKILL.md \u540E\u7528\u300C\u5BFC\u5165\u300D\u529F\u80FD\u5B89\u88C5\u3002"
      };
    } else {
      skill.displayName = skill.displayName || hit.displayName || hit.name;
      if (!skill.category) skill.category = hit.category || "";
      if (!skill.tags || !skill.tags.length) skill.tags = Array.isArray(hit.tags) ? hit.tags : [];
      if (!skill.description) skill.description = (hit.description_zh || hit.description || hit.summary || "").toString();
      skill.version = skill.version || hit.version || "1.0.0";
      skill.name = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name || "") ? skill.name : name;
    }
    const saved = alreadyInstalled ? await updateUserSkill(name, skill) || await addUserSkill(skill) : await addUserSkill(skill);
    const prefix = alreadyInstalled ? "\u5DF2\u91CD\u65B0\u5B89\u88C5\uFF08\u66F4\u65B0\uFF09\u6280\u80FD" : "\u5DF2\u5B89\u88C5\u6280\u80FD";
    if (generative) {
      return {
        result: prefix + "\u300C" + (saved.displayName || saved.name) + "\u300D\uFF08name=" + saved.name + "\uFF0C\u7248\u672C " + (saved.version || "1.0.0") + '\uFF09\u3002\u6CE8\u610F\uFF1ASkillHub \u672A\u8FD4\u56DE\u9010\u5B57\u6B63\u6587\uFF0C\u5185\u5BB9\u4E3A\u81EA\u52A8\u751F\u6210\u7684\u6458\u8981\uFF1B\u53EF\u8C03\u7528 load_skill("' + saved.name + '") \u4F7F\u7528\uFF0C\u6216\u5230\u6280\u80FD\u4E3B\u9875\u7528\u300C\u5BFC\u5165\u300D\u83B7\u53D6\u5B8C\u6574\u7248\u3002'
      };
    }
    return {
      result: prefix + "\u300C" + (saved.displayName || saved.name) + "\u300D\u7684\u5B8C\u6574\u6B63\u6587\uFF08name=" + saved.name + "\uFF0C\u7248\u672C " + (saved.version || "1.0.0") + '\uFF0C\u6765\u81EA SkillHub \u539F\u6587\uFF09\u3002\u53EF\u8C03\u7528 load_skill("' + saved.name + '") \u4F7F\u7528\u3002'
    };
  } catch (e) {
    if (isAbortLikeError(e)) {
      return {
        ok: false,
        result: "SkillHub \u8BF7\u6C42\u8D85\u65F6\uFF0815 \u79D2\u5185\u6CA1\u6709\u54CD\u5E94\uFF09\u3002\u8FD9\u901A\u5E38\u662F\u7F51\u7EDC\u6216 SkillHub \u670D\u52A1\u6162\uFF0C**\u4E0D\u662F\u8FD9\u6761\u6280\u80FD\u672C\u8EAB\u6709\u95EE\u9898**\uFF1B\u7A0D\u540E\u53EF\u4EE5\u91CD\u8BD5\uFF0C\u6216\u6539\u7528 load_skill \u52A0\u8F7D\u5DF2\u5B89\u88C5\u7684\u6280\u80FD\u3002"
      };
    }
    return { ok: false, result: "\u5B89\u88C5\u5931\u8D25\uFF1A" + (e && e.message ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
  }
}
var TOOL_HANDLERS = /* @__PURE__ */ new Map();
function registerHandlers(names, run) {
  for (const n of names) {
    if (TOOL_HANDLERS.has(n)) {
      throw new Error("\u5DE5\u5177\u91CD\u590D\u6CE8\u518C\uFF1A" + n + "\uFF08\u540C\u4E00\u5DE5\u5177\u540D\u6709\u4E24\u4E2A handler\uFF0C\u5206\u6D3E\u6709\u6B67\u4E49\uFF09");
    }
    TOOL_HANDLERS.set(n, run);
  }
}
registerHandlers(["knowledge_read", "add_entry", "remove_entry"], (name, args, ctx) => handleKnowledgeStoreTool(name, args, {
  ctx,
  knowledgeRead,
  upsertItem,
  deleteItem,
  getBook,
  buildRagContext,
  buildCitations,
  typeInfo,
  STAR_LEVELS,
  STATUS
}));
registerHandlers(["read_current_page", "get_page_snapshot", "list_frames"], (name, args, ctx) => handlePageReadTool(name, args, {
  ctx,
  chrome,
  cdpAllowed,
  sendTabMessage,
  getPageSnapshot,
  getPendingDialogs,
  trimElementsToBudget,
  formatVisibilityReport,
  formatCurrentPageResult,
  splitIntoChunks,
  citationTitleFor
}));
registerHandlers(["read_diagnostics"], (name, args, ctx) => readDiagnostics({ sendTabMessage, tabId: ctx.tabId, getDownloads }, args));
registerHandlers(["type_text", "press_key", "select_option", "check_box", "wait_for_element", "get_attribute"], (name, args, ctx) => handlePageInputTool(name, args, {
  ctx,
  cdp: cdp_exports,
  cdpAllowed,
  executeContentAction,
  frameIdFromArgs,
  resolveTarget,
  rememberTarget,
  getPageSnapshot,
  observedChange,
  buildActionVerification,
  compactSnapshotSummary,
  summarizeCdpError
}));
registerHandlers(["list_tabs", "switch_tab", "open_tab"], (name, args, ctx) => handleTabTool(name, args, {
  chrome,
  ctx,
  waitForTabReady,
  bindSessionTab,
  listOpenedTabsSummary,
  trackOpenedTab,
  ensureAgentWindow
}));
registerHandlers(["fetch_webpage", "web_search"], (name, args, ctx) => handleFetchTool(name, args, {
  ctx,
  // 原生 fetch 是 WebIDL 方法，this 必须是全局对象。作为 deps.fetchImpl(...) 调用时
  // this 会变成 deps，Chrome 会抛 "Illegal invocation"（实测于 MV3 Service Worker）。
  fetchImpl: fetch.bind(globalThis),
  readBounded,
  decodeBuffer,
  stripHtml,
  extractHtmlTitle,
  searchWeb,
  isAbortLikeError,
  describeFetchError
}));
registerHandlers(["click_element", "click_at", "hover_element", "drag_element", "upload_file"], (name, args, ctx) => handleCdpInputTool(name, args, {
  ctx,
  cdp: cdp_exports,
  cdpAllowed,
  executePageTool,
  frameIdFromArgs,
  resolveTarget,
  rememberTarget,
  getPageSnapshot,
  observedChange,
  buildActionVerification,
  compactSnapshotSummary,
  summarizeCdpError
}));
registerHandlers(["annotate", "inspect_element", "scroll_page", "get_element_source", "undo_last_action"], (name, args, ctx) => handlePageCommandTool(name, args, { ctx, toolError, executePageTool, executeContentAction, sendTabMessage }));
registerHandlers(["take_screenshot"], (name, args, ctx) => takeScreenshot({
  ctx,
  args,
  cdp: cdp_exports,
  cdpAllowed,
  screenshotAttempts,
  saveScreenshot,
  // 归档函数现在需要注入 chrome（它已随截图族移到 ./screenshot-tool.js）。
  // 漏传的后果是**静默不落盘**：返回仍 ok:true，但图片永远取不回来。
  chrome,
  formatScreenshotSummary
}));
registerHandlers(["run_javascript", "get_ax_snapshot"], (name, args, ctx) => handleCodeAccessTool(name, args, { ctx, cdp: cdp_exports, cdpAllowed, executeContentAction, evaluateInPageWorld, isCspEvalBlockError, summarizeCdpError }));
registerHandlers(["list_userscripts", "search_userscripts", "install_userscript", "run_userscript"], (name, args, ctx) => handleUserscriptTool(name, args, {
  ctx,
  listUserscripts: listScripts,
  searchScripts,
  installFromUrl,
  runUserscriptOnTab,
  getUserscriptSettings
}));
registerHandlers(["load_skill", "install_skill", "save_skill"], (name, args, ctx) => handleSkillTool(name, args, {
  getMergedSkills,
  getDefaultSkills,
  getUserSkills,
  addUserSkill,
  updateUserSkill,
  validateSkillTools,
  installSkillFromSkillHub
}));
registerHandlers(["macro"], (name, args, ctx) => macroTool(
  {
    pageUrl: ctx.pageUrl,
    trace: ctx.trace,
    ctx,
    saveMacro,
    recallTrace,
    listMacros,
    getMacro,
    bumpMacroHits,
    executeTool,
    validateToolCall
  },
  args
));
registerHandlers(["trust_site", "handle_dialog"], (name, args, ctx) => handlePermissionTool(name, args, { ctx, chrome, cdpAllowed, handleDialog, summarizeCdpError }));
registerHandlers(["update_plan", "expand_result", "get_run_trace"], (name, args, ctx) => handleRunStateTool(name, args, { ctx, getTrace, listTraces }));
registerHandlers(["complete_task"], (name, args) => ({
  result: "\u4EFB\u52A1\u5DF2\u5B8C\u6210\uFF1A" + String(args.summary || "\u4EFB\u52A1\u5B8C\u6210\u3002") + (args.evidence ? "\n\u8BC1\u636E\uFF1A" + String(args.evidence) : ""),
  complete: true
}));
async function executeTool(name, args, ctx) {
  args = args || {};
  const run = TOOL_HANDLERS.get(name);
  if (!run) return { ok: false, result: "\u672A\u77E5\u5DE5\u5177\uFF1A" + name };
  return await run(name, args, ctx);
}
function decodeNumericEntity(code) {
  if (!Number.isFinite(code) || code < 0 || code > 1114111) return "\uFFFD";
  if (code >= 55296 && code <= 57343) return "\uFFFD";
  try {
    return String.fromCodePoint(code);
  } catch (e) {
    return "\uFFFD";
  }
}
function splitIntoChunks(text, size, max) {
  const s = String(text || "").trim();
  if (!s) return [];
  const paras = s.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return [sliceSafe(s, 0, size)];
  const chunks = [];
  let buf = "";
  const push = (str) => {
    const t = str.replace(/\n+/g, " ").replace(/[ \t]{2,}/g, " ").trim();
    if (!t || chunks.length >= max) return;
    if (t.length > size * 1.5) {
      const parts = t.match(new RegExp(".{1," + size + "}", "g")) || [t];
      for (const pt of parts) {
        if (chunks.length >= max) break;
        chunks.push(pt.trim());
      }
    } else {
      chunks.push(t);
    }
  };
  for (const p of paras) {
    const candidate = buf ? buf + "\n\n" + p : p;
    if (buf && candidate.length > size) {
      push(buf);
      buf = p;
      if (chunks.length >= max) break;
    } else {
      buf = candidate;
    }
  }
  push(buf);
  return chunks.slice(0, max);
}
function stripHtml(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<head[\s\S]*?<\/head>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  s = s.replace(/<\/?(?:br|p|div|li|tr|h[1-6]|section|article)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&apos;/gi, "'").replace(/&#(\d+);/g, (m, n) => decodeNumericEntity(parseInt(n, 10))).replace(/&#x([0-9a-f]+);/gi, (m, n) => decodeNumericEntity(parseInt(n, 16))).replace(/&[a-z]+;/gi, " ");
  s = s.replace(/[ \t]+/g, " ").replace(/[ \r]+/g, "").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// lib/assistant/mcp.js
var MCP_PROTOCOL_VERSION = "2024-11-05";
var MCP_TTL = 5 * 60 * 1e3;
var MCP_STATUS_STORAGE_KEY = "recallflow.mcpLastStatus";
function describeHttpFailure(method, status, body) {
  const detail = String(body || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (status === 401 || status === 403) {
    return "MCP " + method + " \u5931\u8D25\uFF08HTTP " + status + "\uFF09\uFF1A\u9274\u6743\u88AB\u62D2\u7EDD\uFF08\u8BE5\u670D\u52A1\u5668\u8981\u6C42\u9274\u6743\uFF09\u3002\u8BF7\u68C0\u67E5\u8BBE\u7F6E\u9875\u300CMCP \u670D\u52A1\u5668\u300D\u91CC\u8FD9\u53F0\u670D\u52A1\u5668\u7684 Authorization\uFF08Bearer Token\uFF09\u662F\u5426\u586B\u5199\u3001\u662F\u5426\u4E0E\u670D\u52A1\u7AEF\u4E00\u81F4" + (detail ? "\uFF1B\u670D\u52A1\u7AEF\u54CD\u5E94\uFF1A" + detail : "");
  }
  return "MCP " + method + " \u5931\u8D25\uFF08HTTP " + status + "\uFF09" + (detail ? "\uFF1A" + detail : "");
}
function failWithStatus(message, status) {
  const err = new Error(message);
  if (status) err.status = status;
  return err;
}
var McpClient = class {
  constructor(server) {
    this.url = server.url;
    this.headers = server.headers || {};
    this.sessionId = null;
  }
  _buildHeaders() {
    const headers = Object.assign(
      {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream"
      },
      this.headers
    );
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }
  async _rpc(method, params, id) {
    const resp = await fetch(this.url, {
      method: "POST",
      headers: this._buildHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id: id || 1 })
    });
    const sid = resp.headers && resp.headers.get && resp.headers.get("Mcp-Session-Id");
    if (sid) this.sessionId = sid;
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw failWithStatus(describeHttpFailure(method, resp.status, txt), resp.status);
    }
    const ct = resp.headers && resp.headers.get && resp.headers.get("content-type") || "";
    let data;
    if (ct.includes("text/event-stream")) {
      data = parseSseResult(await resp.text());
    } else {
      data = await resp.json();
    }
    if (data && data.error) throw new Error("MCP \u9519\u8BEF\uFF1A" + JSON.stringify(data.error));
    return data ? data.result : null;
  }
  /**
   * 单向通知（notifications/*）：**没有 id、也不应有响应体**。
   * 按普通 RPC 去解析 result 会在空 body / 204 上抛错，所以单独走这条路；
   * 失败只做尽力而为（少数服务器对通知返回 405），真正的连通性由随后的 tools/list 证明。
   */
  async _notify(method, params) {
    try {
      const resp = await fetch(this.url, {
        method: "POST",
        headers: this._buildHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", method, params: params || {} })
      });
      const sid = resp.headers && resp.headers.get && resp.headers.get("Mcp-Session-Id");
      if (sid) this.sessionId = sid;
      return resp.ok;
    } catch (e) {
      return false;
    }
  }
  async initialize() {
    return this._rpc(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "RecallFlow", version: "3.0.0" }
      },
      1
    );
  }
  // Streamable HTTP 要求 initialize 之后客户端补发 notifications/initialized 才算握手完成；
  // 严格的服务端在收到它之前会拒绝 tools/list（TITA-11：这就是「连上了却列不出工具」的一类成因）。
  async notifyInitialized() {
    return this._notify("notifications/initialized", {});
  }
  async listTools() {
    const r = await this._rpc("tools/list", {}, 2);
    return r && r.tools || [];
  }
  async callTool(name, args) {
    const r = await this._rpc("tools/call", { name, arguments: args || {} }, 3);
    if (!r || !Array.isArray(r.content)) return "\uFF08\u7A7A\u7ED3\u679C\uFF09";
    return r.content.map((c) => c.type === "text" ? c.text : JSON.stringify(c)).join("\n");
  }
};
function parseSseResult(text) {
  const lines = String(text).split("\n");
  let last = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const d = t.slice(5).trim();
    if (!d || d === "[DONE]") continue;
    try {
      const j = JSON.parse(d);
      last = j;
    } catch (e) {
    }
  }
  return last;
}
async function probeMcpServer(server) {
  const started = Date.now();
  const s = server && typeof server === "object" ? server : {};
  const base = { serverId: s.id || "", url: s.url || "" };
  try {
    if (!s.url) return Object.assign(base, { ok: false, error: "\u672A\u914D\u7F6E\u670D\u52A1\u5668\u5730\u5740\uFF08url \u4E3A\u7A7A\uFF09", ts: Date.now() });
    const client = new McpClient(s);
    await client.initialize();
    await client.notifyInitialized();
    const list = await client.listTools();
    return Object.assign(base, { ok: true, toolCount: list.length, ms: Date.now() - started, ts: Date.now() });
  } catch (e) {
    return Object.assign(base, {
      ok: false,
      status: e && e.status ? e.status : void 0,
      error: String(e && e.message || e),
      ms: Date.now() - started,
      ts: Date.now()
    });
  }
}

// entries/options.js
var $ = (id) => document.getElementById(id);
var settingsDirty = false;
var settingsLoading = true;
async function load() {
  const s = await getAISettings();
  $("api-key").value = s.apiKey;
  $("model").value = s.model;
  $("base-url").value = s.baseUrl;
  $("rag-enabled").checked = !!s.ragEnabled;
  $("target-lang").value = s.targetLang;
  $("page-context").checked = s.pageContext !== false;
  $("cdp-enabled").checked = s.cdpEnabled !== false;
  $("site-memory").checked = s.siteMemoryEnabled !== false;
  $("verifier-enabled").checked = s.verifierEnabled !== false;
  $("trusted-sites").value = (s.trustedSites || []).join("\n");
  $("tool-approval").checked = s.toolApproval !== false;
  const policy = Object.assign({ read: true, edit: false, commands: false, browser: false, mcp: false }, s.toolApprovalPolicy || {});
  ["read", "edit", "commands", "browser", "mcp"].forEach((k) => {
    $("approval-" + k).checked = !!policy[k];
  });
  $("approval-notify").checked = s.toolApprovalNotify !== false;
  $("code-exec-approval").value = resolveCodeExecutionApproval(s);
  $("bridge-token").value = s.bridgeToken || "";
  syncApprovalPreset();
  const budget = s.agentBudget || {};
  $("budget-tokens").value = Number.isInteger(Number(budget.maxTotalTokens)) && Number(budget.maxTotalTokens) > 0 ? String(budget.maxTotalTokens) : "";
  $("quick-prompts").value = (s.quickPrompts || AI_SETTINGS_DEFAULTS.quickPrompts).join("\n");
  await loadMcpStatus();
  renderMcp(s.mcpServers || []);
  const us = await getUserscriptSettings();
  $("us-agent-install").checked = us.agentCanInstall !== false;
  $("us-auto-update").checked = !!us.autoCheckUpdates;
  $("us-run-at").value = us.defaultRunAt || "document-idle";
  renderUserscriptSummary();
  settingsLoading = false;
  setDirty(false);
  initSettingsNav();
}
async function renderUserscriptSummary() {
  const meta = $("us-summary-meta");
  const navCount = $("us-nav-count");
  if (!meta && !navCount) return;
  try {
    const data = await chrome.storage.local.get(USERSCRIPTS_KEY);
    const map = data[USERSCRIPTS_KEY] || {};
    const list = Object.values(map);
    const enabled = list.filter((s) => s.enabled).length;
    if (meta) meta.textContent = `\u5DF2\u5B89\u88C5 ${list.length} \u4E2A \xB7 \u542F\u7528 ${enabled} \u4E2A \xB7 \u505C\u7528 ${list.length - enabled} \u4E2A`;
    if (navCount) {
      navCount.textContent = list.length;
      navCount.classList.toggle("hidden", list.length === 0);
    }
  } catch (e) {
    if (meta) meta.textContent = "\u5DF2\u5B89\u88C5 0 \u4E2A \xB7 \u542F\u7528 0 \u4E2A";
  }
}
var mcpLastStatus = /* @__PURE__ */ new Map();
function mcpKeyOf(s) {
  return s && (s.url || "") + "|" + (s.id || "") || "";
}
async function loadMcpStatus() {
  try {
    const data = await chrome.storage.local.get(MCP_STATUS_STORAGE_KEY);
    const rec = data && data[MCP_STATUS_STORAGE_KEY];
    mcpLastStatus = new Map((rec && rec.servers || []).map((st) => [mcpKeyOf(st), st]));
  } catch (e) {
    mcpLastStatus = /* @__PURE__ */ new Map();
  }
}
async function saveMcpStatus(st) {
  try {
    const data = await chrome.storage.local.get(MCP_STATUS_STORAGE_KEY);
    const rec = data && data[MCP_STATUS_STORAGE_KEY] || { ts: 0, servers: [] };
    const servers = (rec && rec.servers || []).filter((x) => mcpKeyOf(x) !== mcpKeyOf(st));
    servers.push(st);
    await chrome.storage.local.set({ [MCP_STATUS_STORAGE_KEY]: { ts: Date.now(), servers } });
  } catch (e) {
  }
}
function setMcpStatusEl(el, st) {
  if (!st) {
    el.className = "mcp-status";
    el.textContent = "\u5C1A\u672A\u8FDE\u63A5\u8FC7\uFF08\u70B9\u300C\u6D4B\u8BD5\u300D\uFF0C\u6216\u8DD1\u4E00\u6B21\u5BF9\u8BDD\u540E\u8FD9\u91CC\u4F1A\u663E\u793A\u7ED3\u679C\uFF09";
    return;
  }
  if (st.ok) {
    el.className = "mcp-status ok";
    el.textContent = "\u2713 \u5DF2\u8FDE\u63A5\uFF1A" + st.toolCount + " \u4E2A\u5DE5\u5177" + (st.ms ? "\uFF08" + st.ms + "ms\uFF09" : "");
    return;
  }
  el.className = "mcp-status bad";
  el.textContent = "\u2717 \u8FDE\u63A5\u5931\u8D25" + (st.status ? "\uFF08HTTP " + st.status + "\uFF09" : "") + "\uFF1A" + (st.error || "\u672A\u77E5\u539F\u56E0") + "\u3002\u8BF7\u68C0\u67E5\u5730\u5740\u662F\u5426\u53EF\u8FBE\uFF0C\u4EE5\u53CA Bearer Token \u662F\u5426\u4E0E\u670D\u52A1\u7AEF\u4E00\u81F4\uFF1BMCP \u7AEF\u70B9\u7528\u6D4F\u89C8\u5668\u6253\u5F00\u53EA\u4F1A\u5F97\u5230 401/403\uFF0C\u5B83\u4E0D\u662F\u767B\u5F55\u9875\u3002";
}
function renderMcp(list) {
  const box = $("mcp-list");
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<p class="mcp-empty">\u5C1A\u672A\u914D\u7F6E MCP \u670D\u52A1\u5668</p>';
    return;
  }
  list.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "mcp-row";
    row.innerHTML = '<input class="mcp-id" placeholder="\u6807\u8BC6(\u82F1\u6587)" value="' + esc(s.id || "") + '"><input class="mcp-url" placeholder="https://host/mcp" value="' + esc(s.url || "") + '"><input class="mcp-token" placeholder="Bearer Token(\u53EF\u9009)" value="' + esc((s.headers && s.headers.Authorization || "").replace(/^Bearer\s*/i, "")) + '"><button class="mcp-test icon-btn" type="button" title="\u6D4B\u8BD5\u8FD9\u53F0\u670D\u52A1\u5668\u80FD\u5426\u8FDE\u901A">\u6D4B\u8BD5</button><button class="mcp-del icon-btn" title="\u5220\u9664">\u2715</button>';
    const statusEl = document.createElement("div");
    setMcpStatusEl(statusEl, mcpLastStatus.get(mcpKeyOf(s)));
    row.appendChild(statusEl);
    row.querySelector(".mcp-del").addEventListener("click", () => {
      list.splice(i, 1);
      renderMcp(list);
      markDirty();
    });
    row.querySelector(".mcp-test").addEventListener("click", async () => {
      const cfg = { id: row.querySelector(".mcp-id").value.trim(), url: row.querySelector(".mcp-url").value.trim() };
      const token = row.querySelector(".mcp-token").value.trim();
      if (token) cfg.headers = { Authorization: "Bearer " + token };
      statusEl.className = "mcp-status";
      statusEl.textContent = "\u8FDE\u63A5\u4E2D\u2026";
      const st = await probeMcpServer(cfg);
      mcpLastStatus.set(mcpKeyOf(cfg), st);
      setMcpStatusEl(statusEl, st);
      await saveMcpStatus(st);
    });
    box.appendChild(row);
  });
}
function toast(msg, ok) {
  const st = $("status");
  st.textContent = msg;
  st.className = "status" + (ok ? " ok" : "");
  clearTimeout(st._t);
  st._t = setTimeout(() => {
    st.textContent = "";
    st.className = "status";
  }, 1800);
}
function setDirty(dirty) {
  settingsDirty = Boolean(dirty);
  const state2 = $("save-state");
  if (!state2) return;
  state2.textContent = settingsDirty ? "\u6709\u672A\u4FDD\u5B58\u4FEE\u6539" : "\u5DF2\u4FDD\u5B58";
  state2.classList.toggle("dirty", settingsDirty);
}
function markDirty() {
  if (settingsLoading) return;
  setDirty(true);
}
function collectSettings() {
  return {
    apiKey: $("api-key").value.trim(),
    model: $("model").value.trim() || AI_SETTINGS_DEFAULTS.model,
    baseUrl: $("base-url").value.trim().replace(/\/+$/, "") || AI_SETTINGS_DEFAULTS.baseUrl,
    ragEnabled: $("rag-enabled").checked,
    targetLang: $("target-lang").value.trim() || AI_SETTINGS_DEFAULTS.targetLang,
    pageContext: $("page-context").checked,
    cdpEnabled: $("cdp-enabled").checked,
    siteMemoryEnabled: $("site-memory").checked,
    verifierEnabled: $("verifier-enabled").checked,
    trustedSites: $("trusted-sites").value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
    toolApproval: $("tool-approval").checked,
    toolApprovalPolicy: Object.fromEntries(["read", "edit", "commands", "browser", "mcp"].map((k) => [k, $("approval-" + k).checked])),
    toolApprovalNotify: $("approval-notify").checked,
    codeExecutionApproval: $("code-exec-approval").value || "session",
    bridgeToken: $("bridge-token").value.trim(),
    quickPrompts: $("quick-prompts").value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 12),
    mcpServers: collectMcp(),
    agentBudget: {
      ...Number.isInteger(Number($("budget-tokens").value)) && Number($("budget-tokens").value) > 0 ? { maxTotalTokens: Math.floor(Number($("budget-tokens").value)) } : {}
    }
  };
}
async function saveSettings() {
  const settings = collectSettings();
  await chrome.storage.local.set({ [AI_SETTINGS_KEY]: settings });
  await saveUserscriptSettings({
    agentCanInstall: $("us-agent-install").checked,
    autoCheckUpdates: $("us-auto-update").checked,
    defaultRunAt: $("us-run-at").value || "document-idle"
  });
  setDirty(false);
  toast("\u2713 \u5DF2\u4FDD\u5B58", true);
}
$("save-btn").addEventListener("click", () => {
  saveSettings().catch((err) => toast("\u4FDD\u5B58\u5931\u8D25\uFF1A" + (err && err.message ? err.message : "\u672A\u77E5\u9519\u8BEF")));
});
document.querySelector(".settings-content").addEventListener("input", markDirty);
document.querySelector(".settings-content").addEventListener("change", markDirty);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveSettings().catch((err) => toast("\u4FDD\u5B58\u5931\u8D25\uFF1A" + (err && err.message ? err.message : "\u672A\u77E5\u9519\u8BEF")));
  }
});
window.addEventListener("beforeunload", (e) => {
  if (!settingsDirty) return;
  e.preventDefault();
  e.returnValue = "";
});
$("toggle-key").addEventListener("click", () => {
  const el = $("api-key");
  el.type = el.type === "password" ? "text" : "password";
  $("toggle-key").textContent = el.type === "password" ? "\u{1F441}" : "\u{1F648}";
  $("toggle-key").setAttribute("aria-label", el.type === "password" ? "\u663E\u793A API Key" : "\u9690\u85CF API Key");
  $("toggle-key").setAttribute("aria-pressed", el.type === "text" ? "true" : "false");
});
function collectMcp() {
  const rows = document.querySelectorAll("#mcp-list .mcp-row");
  const out = [];
  rows.forEach((r) => {
    const id = r.querySelector(".mcp-id").value.trim();
    const url = r.querySelector(".mcp-url").value.trim();
    const token = r.querySelector(".mcp-token").value.trim();
    if (!id || !url) return;
    const srv = { id, url };
    if (token) srv.headers = { Authorization: "Bearer " + token };
    out.push(srv);
  });
  return out;
}
$("mcp-add").addEventListener("click", () => {
  const list = collectMcp();
  list.push({ id: "", url: "", headers: {} });
  renderMcp(list);
  markDirty();
});
function syncApprovalPreset() {
  const keys = ["read", "edit", "commands", "browser", "mcp"];
  const values = keys.map((k) => $("approval-" + k).checked);
  $("approval-preset").value = values.every(Boolean) ? "all" : values[0] && values.slice(1).every((v) => !v) ? "safe" : "custom";
}
$("approval-preset").addEventListener("change", (e) => {
  if (e.target.value === "safe" || e.target.value === "all") {
    const on = e.target.value === "all";
    ["read", "edit", "commands", "browser", "mcp"].forEach((k) => {
      $("approval-" + k).checked = on || k === "read";
    });
  }
});
document.querySelectorAll(".approval-list input").forEach((el) => el.addEventListener("change", syncApprovalPreset));
$("test-connection").addEventListener("click", async () => {
  const status = $("connection-status");
  const apiKey = $("api-key").value.trim();
  const baseUrl = $("base-url").value.trim().replace(/\/+$/, "") || AI_SETTINGS_DEFAULTS.baseUrl;
  status.className = "connection-status";
  if (!apiKey) {
    status.textContent = "\u8BF7\u5148\u586B\u5199 API Key";
    status.classList.add("error");
    $("api-key").focus();
    return;
  }
  status.textContent = "\u6B63\u5728\u6D4B\u8BD5\u2026";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8e3);
  try {
    const res = await fetch(baseUrl + "/models", {
      headers: { Authorization: "Bearer " + apiKey },
      signal: controller.signal
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    status.textContent = "\u8FDE\u63A5\u6210\u529F";
    status.classList.add("ok");
  } catch (err) {
    status.textContent = err && err.name === "AbortError" ? "\u8FDE\u63A5\u8D85\u65F6" : "\u8FDE\u63A5\u5931\u8D25\uFF1A" + (err && err.message ? err.message : "\u672A\u77E5\u9519\u8BEF");
    status.classList.add("error");
  } finally {
    clearTimeout(timer);
  }
});
function initSettingsNav() {
  const links = [...document.querySelectorAll(".settings-sidebar a")];
  const sections = links.map((link) => ({ link, section: document.querySelector(link.getAttribute("href")) })).filter((item) => item.section);
  if (!sections.length || typeof IntersectionObserver !== "function") return;
  if (links[0]) links[0].classList.add("active");
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (!visible.length) return;
      const current = sections.find((item) => item.section === visible[0].target);
      if (!current) return;
      links.forEach((link) => link.classList.toggle("active", link === current.link));
    },
    { rootMargin: "-140px 0px -60% 0px", threshold: [0, 1] }
  );
  sections.forEach((item) => observer.observe(item.section));
}
load();

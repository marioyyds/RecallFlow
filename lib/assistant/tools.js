// 工具定义（OpenAI / DeepSeek function-calling 格式）与内置工具执行
// 后台以工具调用循环（agent loop）驱动：模型决定调用哪些工具，
// 后台执行真实操作（检索/增删知识库），再把结果喂回模型，直到产出最终回复。
import { STATUS, STAR_LEVELS } from '../shared/constants.js';
import { typeInfo, formatVisibilityReport, isCspEvalBlockError, screenshotAttempts, formatScreenshotSummary } from '../shared/utils.js';
import { getBook, upsertItem, deleteItem } from '../shared/store.js';
import { buildRagContext, buildCitations } from '../shared/rag.js';
import { listScripts as listUserscripts, searchScripts, installFromUrl, runUserscriptOnTab } from '../userscript/manager.js';
import { getUserscriptSettings } from '../userscript/settings.js';
import { getMergedSkills, addUserSkill, getUserSkills } from './skill-store.js';
import { mdToSkill } from './skill-md.js';
// 发消息给标签页时的"可重试"判断（内容脚本按 document_idle 注入，存在真实竞态）
import { retryTabMessage } from '../shared/tab-messaging.js';
import * as cdp from '../backend/cdp.js';
import { rememberElement } from './site-memory.js';
import { saveMacro, listMacros, getMacro, bumpMacroHits } from './macro-store.js';
import { handleDialog, getPendingDialogs, getDownloads } from './target-manager.js';
import { getTrace, listTraces } from './trace.js';
import { TOOL_SCHEMAS } from './tool-schemas.js';
import { TOOL_METADATA } from './tool-metadata.js';

export const TOOL_REGISTRY = Object.freeze(
  TOOL_SCHEMAS.map((tool) => {
    const name = tool.function.name;
    const metadata = TOOL_METADATA[name] || { risk: 'unknown', requiresApproval: true, route: 'background' };
    return Object.freeze({
      name,
      description: tool.function.description,
      inputSchema: tool.function.parameters,
      risk: metadata.risk,
      requiresApproval: metadata.requiresApproval === true,
      readOnly: metadata.readOnly === true,
      alwaysAvailable: metadata.alwaysAvailable === true,
      alwaysRequireApproval: metadata.alwaysRequireApproval === true,
      route: metadata.route || 'background',
      timeoutMs: Number(metadata.timeoutMs) > 0 ? Number(metadata.timeoutMs) : 0,
      openai: tool,
    });
  })
);

const TOOL_BY_NAME = new Map(TOOL_REGISTRY.map((tool) => [tool.name, tool]));
export const BUILTIN_TOOLS = TOOL_REGISTRY.map((tool) => tool.openai);

export function getToolDefinition(name) {
  return TOOL_BY_NAME.get(name) || null;
}

// 已知的工具重命名（旧名 → 新名）：用于在加载自定义技能时提示用户更新依赖工具列表。
export const TOOL_RENAME_MAP = Object.freeze({ scroll_to_element: 'scroll_page' });

// 校验技能声明的依赖工具是否全部存在；返回警告列表（含旧名→新名的迁移提示）。
export function validateSkillTools(skill) {
  if (!skill) return [];
  const declared = Array.isArray(skill.tools)
    ? skill.tools
    : skill.x && Array.isArray(skill.x.tools)
      ? skill.x.tools
      : [];
  const existing = new Set(TOOL_REGISTRY.map((t) => t.name));
  const warnings = [];
  for (const tn of declared) {
    if (typeof tn !== 'string' || !tn) continue;
    if (existing.has(tn)) continue;
    const renamed = TOOL_RENAME_MAP[tn];
    warnings.push(renamed ? '「' + tn + '」已更名为「' + renamed + '」' : '「' + tn + '」不是可用工具');
  }
  return warnings;
}

export function getToolMetadata(name) {
  if (typeof name === 'string' && name.indexOf('mcp__') === 0) {
    return { risk: 'external', requiresApproval: true };
  }
  const definition = getToolDefinition(name);
  return definition
    ? {
        risk: definition.risk,
        requiresApproval: definition.requiresApproval,
        readOnly: definition.readOnly,
        route: definition.route,
        alwaysAvailable: definition.alwaysAvailable === true,
        alwaysRequireApproval: definition.alwaysRequireApproval === true,
        timeoutMs: Number(definition.timeoutMs) > 0 ? Number(definition.timeoutMs) : 0,
      }
    : { risk: 'unknown', requiresApproval: true, readOnly: false, route: 'background' };
}

/**
 * 对模型返回的工具参数做最小结构校验。完整 JSON Schema 校验留给后续，
 * 这里先保证未知工具、非对象参数和 required 字段不会直接进入执行器。
 */
export function validateToolCall(name, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: '工具参数必须是 JSON 对象。' };
  }
  const definition = getToolDefinition(name);
  if (!definition) {
    if (typeof name === 'string' && name.indexOf('mcp__') === 0) return { ok: true };
    return { ok: false, error: '未知工具：' + name };
  }
  const required = definition.inputSchema && Array.isArray(definition.inputSchema.required)
    ? definition.inputSchema.required
    : [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  return missing.length
    ? { ok: false, error: '工具「' + name + '」缺少必填参数：' + missing.join('、') }
    : { ok: true };
}

// 向指定标签页（可选指定 frameId，用于跨域 iframe）发送消息。
//
// **对"内容脚本还没注入"这种情况自动重试**（用户实测的真实 bug）：
// content_scripts 的注入时机是 document_idle，而 browser_read 会先 open_tab 再立刻读 ——
// 内容脚本还没在听时报 "Receiving end does not exist"，原来只发一次就失败，
// 于是 browser_read 稳定失败（重试两次都一样），而它把这个错误当**正文**返回，
// 看起来像"页面内容就是这句话"。可重试判断是纯函数（lib/shared/tab-messaging.js），有单测。
function sendTabMessage(tabId, message, frameId) {
  const attempt = () =>
    new Promise((resolve, reject) => {
      const callback = (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      };
      // 默认发往顶层框架（frameId=0）；否则无 frameId 时消息会广播到所有框架，
      // 响应可能来自子框架，导致顶层快照/命令错乱。
      const fid = Number(frameId);
      const options = { frameId: Number.isInteger(fid) && fid >= 0 ? fid : 0 };
      chrome.tabs.sendMessage(tabId, message, options, callback);
    });
  // 循环与"哪些错误该重试"都在 lib/shared/tab-messaging.js 里，且有单测。
  return retryTabMessage(attempt, { tabId });
}

// 结构化页面诊断数据（console / network 原始条目，不做文本化）。
// 供本机 MCP 的 page_health 使用：它需要 at 时间戳与 stack 原样，
// 而 read_console / read_network 会拍平为文本并丢掉时间戳，无法做增量游标。
export async function collectPageDiagnostics(tabId) {
  const out = { console: [], network: [] };
  if (!tabId) return out;
  try {
    const c = await sendTabMessage(tabId, { type: 'kbGetConsole' });
    out.console = (c && c.entries) || [];
  } catch (e) {
    out.consoleError = e.message;
  }
  try {
    const n = await sendTabMessage(tabId, { type: 'kbGetNetwork' });
    out.network = (n && n.entries) || [];
  } catch (e) {
    out.networkError = e.message;
  }
  return out;
}

// 结构化读取元素的框架源码位置（供 MCP 的 get_element_source 使用）。
// 返回原始 source 对象而非格式化文本 —— 此前 MCP 只能拿到「元素源码位置：…」字符串，
// 必须按文案反解，扩展一改措辞就会静默失效（字符串耦合）。
export async function collectElementSource(tabId, params) {
  if (!tabId) return { found: false, reason: '无法定位标签页' };
  try {
    const res = await sendTabMessage(tabId, { type: 'kbGetElementSource', params: params || {} });
    if (!res || !res.found) {
      return {
        found: false,
        selector: (res && res.selector) || '',
        reason: (res && res.reason) || '未找到元素或框架源码信息。',
      };
    }
    const s = res.source || {};
    const loc = String(s.file || '') + (s.line ? ':' + s.line + (s.column ? ':' + s.column : '') : '');
    const extra = s.framework ? '（' + s.framework + (s.component ? ' · ' + s.component : '') + '）' : '';
    // 兼容字段 text：旧版 MCP server 只认 { text }。同时给出结构化 source 与同样的文本，
    // 使「扩展已更新、server 尚未重启」的窗口期不会把该工具打断（曾因此短暂失效）。
    const text = '元素源码位置：' + loc + extra + (res.selector ? '\n选择器：' + res.selector : '');
    return { found: true, source: s, selector: res.selector || '', text };
  } catch (e) {
    return { found: false, reason: e.message };
  }
}

// 把目标列表按所属框架分组，并给出每批要发给该框架的**本地**参数。
// ref 可带 f<frameId>: 前缀（get_page_snapshot 的 includeFrames 产出），也可显式传 frameId。
// 为什么必须分组：跨源 iframe 的 DOM 无法从顶层读取（queryAllInFrames 会跳过），
// 只能把消息投递到对应框架、由该框架自己的内容脚本解析。
export function planFrameBatches(targets) {
  const list = Array.isArray(targets) ? targets : [];
  const groups = new Map();
  list.forEach((t, i) => {
    const frameId = frameIdFromArgs(t) || 0;
    if (!groups.has(frameId)) groups.set(frameId, []);
    groups.get(frameId).push({ at: i, target: localTargetArgs(t) });
  });
  return Array.from(groups.entries()).map(([frameId, items]) => ({ frameId, items }));
}

// 结构化读取一批目标元素的渲染态（供 MCP 的 verify_change 做断言）。
// 与 collectPageDiagnostics 一样返回结构化数据，不走会被拍平丢信息的文本通路。
export async function verifyPageTargets(tabId, targets) {
  const list = Array.isArray(targets) ? targets : [];
  if (!tabId) return { found: false, targets: [], reason: '无法定位标签页' };
  const slots = new Array(list.length).fill(null);
  const batches = planFrameBatches(list);
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await sendTabMessage(
          tabId,
          { type: 'kbVerifyTargets', params: { targets: batch.items.map((x) => x.target) } },
          batch.frameId
        );
        const states = (res && res.targets) || [];
        batch.items.forEach((x, k) => {
          slots[x.at] = states[k] || { found: false, count: 0, reason: '该框架未返回结果' };
        });
      } catch (e) {
        batch.items.forEach((x) => {
          slots[x.at] = { found: false, count: 0, reason: '框架 ' + batch.frameId + ' 读取失败：' + e.message };
        });
      }
    })
  );
  return {
    found: true,
    targets: slots.map((s) => s || { found: false, count: 0, reason: '未取得结果' }),
  };
}

// 跨域 iframe 的 ref 采用「f<frameId>:<localRef>」前缀，后台据此把动作路由到对应框架。
// 顶层框架的 ref 不带前缀（frameId=0 亦可显式传 frameId 参数）。
function parseRef(ref) {
  const m = String(ref || '').match(/^f(\d+):(.*)$/);
  if (m) return { frameId: Number(m[1]), ref: m[2] };
  return { frameId: null, ref: String(ref || '') };
}

function frameIdFromArgs(args) {
  if (!args) return null;
  if (args.frameId !== undefined && args.frameId !== null && args.frameId !== '' && Number.isInteger(Number(args.frameId)) && Number(args.frameId) >= 0) {
    return Number(args.frameId);
  }
  return parseRef(args.ref).frameId;
}

// 去掉 ref 的 frame 前缀，得到发给目标框架内容脚本的本地参数。
function localTargetArgs(args) {
  const out = Object.assign({}, args || {});
  const p = parseRef(out.ref);
  if (p.frameId != null) out.ref = p.ref;
  delete out.frameId;
  return out;
}

// CDP（chrome.debugger）是否可用于本次任务。
function cdpAllowed(ctx) {
  return Boolean(ctx && ctx.settings && ctx.settings.cdpEnabled !== false && cdp.isCdpAvailable());
}

// ---- 截图归档 ----
// 图片只给用户看与留档，**绝不写入模型消息**（当前模型为纯文本，塞 base64 只会白烧巨量 token）。
const SHOT_KEY = 'recallflow.shots.v1';
const MAX_SHOTS = 3;
const MAX_SHOT_B64 = 400000; // 单张 base64 上限，超过就降质重拍
const MAX_SHOT_STORE_CHARS = 300000; // 超过则不落盘（仍可在面板里展示）

async function saveScreenshot(shot) {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return false;
    if (String(shot.dataUrl || '').length > MAX_SHOT_STORE_CHARS) return false;
    const cur = await chrome.storage.local.get(SHOT_KEY);
    const list = Array.isArray(cur && cur[SHOT_KEY]) ? cur[SHOT_KEY] : [];
    const next = list.filter((x) => x && x.id !== shot.id).concat([shot]).slice(-MAX_SHOTS);
    await chrome.storage.local.set({ [SHOT_KEY]: next });
    return true;
  } catch (e) {
    return false;
  }
}

// 在页面主世界执行 JS（经 CDP）。CDP 的 Runtime.evaluate 不受页面 CSP 约束，
// 因此它既是 engine:'page' 的实现，也是「沙箱被 CSP 阻止」时的兜底路径。
async function evaluateInPageWorld(ctx, args) {
  if (!cdpAllowed(ctx)) return { ok: false, result: '页面世界执行需要 CDP（请在设置中开启）。' };
  try {
    const jsFrame = frameIdFromArgs(args);
    const expr = '(() => {\n' + String((args && args.code) || '') + '\n})()';
    const value =
      jsFrame != null && jsFrame !== 0
        ? await cdp.evaluateInFrame(ctx.tabId, jsFrame, expr)
        : await cdp.evaluate(ctx.tabId, expr);
    let serialized;
    try {
      serialized = JSON.stringify(value, null, 2);
    } catch (e) {
      serialized = String(value);
    }
    if (serialized === undefined) serialized = 'undefined';
    if (serialized.length > 2000) serialized = serialized.slice(0, 2000) + '\n…（结果过长已截断）';
    return { ok: true, cdp: true, result: serialized };
  } catch (e) {
    return { ok: false, result: '页面世界执行失败：' + summarizeCdpError(e) };
  }
}

// 枚举标签页内的所有框架（含跨域 iframe），返回 [{frameId, href, title, isTop}]。
async function listFramesRaw(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({ href: location.href, title: document.title || '', isTop: window.top === window }),
    });
    return (results || []).map((r) => Object.assign({ frameId: r.frameId }, r.result || {}));
  } catch (e) {
    return [];
  }
}

// 给某框架快照的元素 ref 加 f<frameId>: 前缀，使跨框架 ref 全局唯一、可路由。
function prefixFrameRefs(snapshot, frameId) {
  if (!snapshot || !Number.isInteger(Number(frameId)) || Number(frameId) === 0) return snapshot;
  const fid = Number(frameId);
  const elements = (snapshot.elements || []).map((e) => Object.assign({}, e, { ref: 'f' + fid + ':' + e.ref, frameId: fid }));
  return Object.assign({}, snapshot, { elements, frameId: fid });
}

// 解析目标元素为「唯一选择器 + 绝对视口坐标」，供 CDP 按坐标做可信输入。
async function resolveTarget(tabId, params) {
  if (!tabId) return null;
  const frameId = frameIdFromArgs(params);
  try {
    const res = await sendTabMessage(tabId, { type: 'kbResolveTarget', params: localTargetArgs(params) }, frameId);
    return res && res.found && res.rect ? res : null;
  } catch (e) {
    return null;
  }
}

function summarizeCdpError(e) {
  const msg = e && e.message ? e.message : String(e);
  return msg.replace(/^[A-Za-z.]+：/, '');
}

// 结构化工具错误：统一带 code，便于调用方（与 trace）按类型处理。
function toolError(code, message, extra) {
  return Object.assign({ ok: false, code, result: message }, extra || {});
}

// 把成功定位的元素记入站点记忆（供后续任务直接复用选择器）。
function rememberTarget(ctx, target) {
  if (!ctx || !ctx.settings || ctx.settings.siteMemoryEnabled === false) return;
  if (!target || !target.selector) return;
  rememberElement(ctx.pageUrl, target).catch(() => {});
}

// 可重放的动作（会进入宏轨迹）；用响应里的稳定 selector 替代易失的 ref。
const REPLAYABLE_TOOLS = new Set([
  'click_element', 'type_text', 'press_key', 'select_option', 'check_box',
  'scroll_page', 'wait_for_element', 'open_tab',
]);

export function recordTraceStep(ctx, name, args, res) {
  if (!ctx || !Array.isArray(ctx.trace)) return;
  if (!REPLAYABLE_TOOLS.has(name)) return;
  if (!res || res.ok === false) return;
  const a = args || {};
  let step = null;
  if (name === 'open_tab') {
    if (a.url) step = { tool: name, args: Object.assign({ url: a.url }, a.newTab ? { newTab: true } : {}) };
  } else {
    const selector = res.selector;
    if (!selector) return;
    if (name === 'type_text') step = { tool: name, args: Object.assign({ selector, text: a.text }, a.clearFirst ? { clearFirst: true } : {}) };
    else if (name === 'click_element') step = { tool: name, args: { selector } };
    else if (name === 'press_key') step = { tool: name, args: Object.assign({ selector, key: a.key }, a.modifiers ? { modifiers: a.modifiers } : {}) };
    else if (name === 'check_box') step = { tool: name, args: { selector, checked: a.checked } };
    else if (name === 'select_option') {
      const sa = { selector };
      if (a.value !== undefined) sa.value = a.value;
      if (a.label !== undefined) sa.label = a.label;
      if (a.index !== undefined) sa.index = a.index;
      step = { tool: name, args: sa };
    } else if (name === 'scroll_page') step = { tool: name, args: { selector } };
    else if (name === 'wait_for_element') step = { tool: name, args: Object.assign({ selector, state: a.state || 'visible' }, a.text ? { text: a.text } : {}) };
  }
  if (step) ctx.trace.push(step);
}

// 记录 Agent 本次任务新打开/接管过的标签页，供任务结束后清理（保留最后使用的 tab）。
function trackOpenedTab(ctx, tabId) {
  if (!ctx || !Number.isInteger(Number(tabId))) return;
  if (!Array.isArray(ctx.openedTabs)) ctx.openedTabs = [];
  if (!ctx.openedTabs.includes(tabId)) ctx.openedTabs.push(tabId);
}

// 隔离浏览：研究/知识库/对话类任务在专用 Agent 窗口（最小化）里打开标签页，
// 与用户主窗口完全隔离，不抢焦点、不弄乱用户标签。首次打开时创建一次并复用。
async function ensureAgentWindow(ctx) {
  if (Number.isInteger(ctx.agentWindowId)) {
    try {
      await chrome.windows.get(ctx.agentWindowId);
      return ctx.agentWindowId;
    } catch (e) {
      ctx.agentWindowId = null;
    }
  }
  const win = await chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false });
  ctx.agentWindowId = win.id;
  return win.id;
}

// 任务结束时关闭 Agent 隔离窗口。
export async function closeAgentWindow(ctx) {
  if (ctx && Number.isInteger(ctx.agentWindowId)) {
    try {
      await chrome.windows.remove(ctx.agentWindowId);
    } catch (e) {}
    ctx.agentWindowId = null;
  }
}

// 生成本任务已打开标签页的摘要（tabId + 标题 + URL），供预算触顶时引导模型复用。
async function listOpenedTabsSummary(ctx) {
  const ids = (Array.isArray(ctx.openedTabs) ? ctx.openedTabs : []).filter((id) => Number.isInteger(Number(id)));
  if (!ids.length) return '';
  const lines = [];
  for (const id of ids) {
    const t = await chrome.tabs.get(id).catch(() => null);
    if (t && t.id && t.url) lines.push('tabId=' + t.id + ' ' + (t.title || '') + '｜' + t.url);
  }
  return lines.join('\n');
}

// 记录 Agent 当前绑定的标签页（仅本任务上下文内使用，不做跨 tab 会话同步）。
async function bindSessionTab(tabId) {
  if (!Number.isInteger(Number(tabId))) return;
  try {
    await chrome.storage.local.set({ kbSessionTab: { tabId: Number(tabId), ts: Date.now() } });
  } catch (e) {}
}

async function getPageSnapshot(tabId, options = {}) {
  if (!tabId) return null;
  const snapshot = await sendTabMessage(tabId, { type: 'kbGetPageSnapshot', options }, options.frameId);
  return snapshot && snapshot.version ? snapshot : null;
}

async function waitForTabReady(tabId, timeoutMs = 8000) {
  const deadline = Date.now() + Math.min(12000, Math.max(500, timeoutMs));
  while (Date.now() < deadline) {
    const snapshot = await getPageSnapshot(tabId, { maxElements: 30, maxText: 800 }).catch(() => null);
    if (snapshot) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

function verifyPageAction(command, before, after, response) {
  const executed = Boolean(response && response.ok !== false);
  const urlChanged = Boolean(before && after && before.url !== after.url);
  const contentChanged = Boolean(before && after && before.fingerprint !== after.fingerprint);
  const scrollChanged = Boolean(before && after && before.scroll && after.scroll &&
    (before.scroll.x !== after.scroll.x || before.scroll.y !== after.scroll.y));
  const visualOnly = ['highlight', 'outline', 'set_style', 'clear_highlights'].includes(command);
  const responseChanged = Boolean(response && (response.changed || response.hadEffect));
  const responseSatisfied = Boolean(response && response.alreadySatisfied);
  const eventOnly = command === 'press_key';
  const changed = urlChanged || contentChanged || scrollChanged || responseChanged;
  let reason = executed ? '动作已执行' : '页面命令返回失败';
  if (command === 'click' && executed && !changed) reason = '点击已派发，但页面快照暂未观察到变化';
  if (command.indexOf('scroll') === 0 && executed && !scrollChanged) reason = '滚动已派发，但滚动位置未变化';
  if (visualOnly && executed) reason = '视觉标注动作已执行；标注层不计入内容指纹';
  if (command === 'type_text' && executed && responseSatisfied) reason = '目标输入已处于要求状态';
  else if (command === 'type_text' && executed && !changed) reason = '输入事件已派发，但快照未观察到值状态变化';
  if (command === 'press_key' && executed) reason = '键盘事件已派发';
  return {
    executed,
    verified: executed && (changed || responseSatisfied || visualOnly || eventOnly || command === 'get_text'),
    changed,
    urlChanged,
    contentChanged,
    scrollChanged,
    reason,
  };
}

// 把 DOM 快照压缩成给模型看的短摘要：标题、URL、关键元素、正文开头。
export function compactSnapshotSummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const title = String(snapshot.title || '');
  const url = String(snapshot.url || '');
  const elements = Array.isArray(snapshot.elements)
    ? snapshot.elements
        .slice(0, 8)
        .map((e) => {
          const label = e.label || e.placeholder || '';
          return e.ref + (label ? '：' + String(label).slice(0, 24) : '');
        })
        .join('；')
    : '';
  const text = String(snapshot.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return ['页面标题：' + title, '页面URL：' + url, elements ? '关键元素：' + elements : '', text ? '正文摘要（按 textContent 抽取，含已隐藏节点文字，不能用于判断可见性）：' + text : '']
    .filter(Boolean)
    .join('\n');
}

async function executeContentAction(tabId, action, message, options = {}) {
  if (!tabId) return toolError('NO_TARGET', '无法定位当前标签页（可能不在前台页面）。');
  const frameId = options.frameId != null ? options.frameId : frameIdFromArgs(message && message.params);
  const msg = Object.assign({}, message, { params: localTargetArgs(message && message.params) });
  const shouldVerify = options.verify !== false;
  const before = shouldVerify ? await getPageSnapshot(tabId, { maxElements: 50, maxText: 1600, frameId }).catch(() => null) : null;
  const response = await sendTabMessage(tabId, msg, frameId);
  if (!response) return toolError('PAGE_UNREACHABLE', '页面内容脚本无响应或尚未注入。');
  if (response.ok === false) return toolError('PAGE_ACTION_FAILED', response.error || response.result || ('页面动作失败：' + action));
  if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  let after = shouldVerify ? await getPageSnapshot(tabId, { maxElements: 50, maxText: 1600, frameId }).catch(() => null) : null;
  if (shouldVerify && !after && before) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && tab.url) after = { version: 1, url: tab.url, title: tab.title || '', fingerprint: 'navigation:' + tab.url, scroll: null };
  }
  const verification = shouldVerify
    ? verifyPageAction(action, before, after, response)
    : { executed: true, verified: true, changed: false, reason: '读取类工具无需页面变化验证' };
  return {
    ...response,
    ok: true,
    hadEffect: Boolean(verification.changed),
    result: (response.result || ('已执行页面动作：' + action)) + (shouldVerify ? '\n验证：' + verification.reason : ''),
    verification,
    pageSnapshot: after,
  };
}

// 独立页面工具 → 底层页面命令的映射（拆分后每个工具只负责一个动作）。
function pageToolCommand(name) {
  const map = {
    click_element: 'click',
    set_element_style: 'set_style',
    highlight_text: 'highlight',
    outline_element: 'outline',
    get_element_text: 'get_text',
    clear_page_overlays: 'clear_highlights',
  };
  return map[name] || name;
}

// 前后快照是否发生可观察变化（URL / 内容指纹 / 滚动位置）。
function snapshotChanged(before, after, command) {
  if (!before || !after) return false;
  if (before.url !== after.url) return true;
  if (before.fingerprint && after.fingerprint && before.fingerprint !== after.fingerprint) return true;
  if (
    (command === 'scroll_to' || command === 'scroll_by') &&
    before.scroll && after.scroll &&
    (before.scroll.x !== after.scroll.x || before.scroll.y !== after.scroll.y)
  ) {
    return true;
  }
  return false;
}

// 统一执行页面动作：动作前后快照验证、点击后新标签页自动发现与绑定、返回紧凑页面摘要。
async function executePageTool(tabId, command, args, ctx) {
  if (!tabId) return toolError('NO_TARGET', '无法定位当前标签页（可能不在前台页面）。');
  try {
    const frameId = frameIdFromArgs(args);
    const localArgs = localTargetArgs(args);
    const shouldVerify = ['click', 'scroll_to', 'scroll_by', 'set_style'].includes(command);
    // 点击前记录现有标签页，点击后用于检测 target="_blank" 新建的标签页并自动绑定。
    const beforeTabs = command === 'click' ? await chrome.tabs.query({ currentWindow: true }).catch(() => null) : null;
    const before = shouldVerify ? await getPageSnapshot(tabId, { maxElements: 40, maxText: 1200, frameId }).catch(() => null) : null;
    const res = await sendTabMessage(tabId, { type: 'kbPageCommand', command, params: localArgs }, frameId);
    if (!res) return toolError('PAGE_UNREACHABLE', '页面命令无响应（内容脚本未注入或页面不支持）。');
    if (res.ok === false) return toolError('PAGE_COMMAND_FAILED', '页面命令「' + command + '」失败：' + (res.error || '未知错误'));
    // 点击/滚动等动作轮询等待页面变化（SPA 异步渲染可能超过 320ms），
    // 同时检测点击 target="_blank" 新建的标签页并自动绑定。
    const polling = shouldVerify && (command === 'click' || command === 'scroll_to' || command === 'scroll_by');
    let after = null;
    if (polling) {
      const deadline = Date.now() + (command === 'click' ? 4500 : 1800);
      let nullStreak = 0;
      while (Date.now() < deadline) {
        if (command === 'click' && beforeTabs && Array.isArray(beforeTabs)) {
          const existingIds = new Set(beforeTabs.map((t) => t.id));
          const nowTabs = await chrome.tabs.query({ currentWindow: true }).catch(() => []);
          const newTab = nowTabs.find((t) => t.id && !existingIds.has(t.id));
          if (newTab && newTab.id) {
            const snap = await waitForTabReady(newTab.id, 7000);
            const current = await chrome.tabs.get(newTab.id).catch(() => newTab);
            const targetTab = {
              tabId: newTab.id,
              windowId: current.windowId || newTab.windowId,
              title: current.title || newTab.title || '',
              url: current.url || newTab.url || '',
              ready: Boolean(snap),
            };
            ctx.tabId = newTab.id;
            ctx.pageUrl = targetTab.url || ctx.pageUrl;
            ctx.pageTitle = targetTab.title || ctx.pageTitle;
            ctx.openedTabCount = Number(ctx.openedTabCount || 0) + 1;
            trackOpenedTab(ctx, newTab.id);
            // 新标签页接管后，同步该页的弹窗开关状态，避免对话窗口“消失”或状态不一致。
            bindSessionTab(newTab.id);
            return {
              ok: true,
              hadEffect: true,
              targetTabId: newTab.id,
              targetTab,
              pageSnapshot: snap,
              result:
                '点击已派发，检测到新标签页并已自动绑定：tabId=' + newTab.id + ' ' + targetTab.url +
                (snap ? '\n' + compactSnapshotSummary(snap) + '\n（页面已就绪，可直接据此判断任务是否完成）' : '（内容脚本尚未就绪）'),
            };
          }
        }
        const snap = await getPageSnapshot(tabId, { maxElements: 40, maxText: 1200, frameId }).catch(() => null);
        if (snap) {
          nullStreak = 0;
          after = snap;
          if (snapshotChanged(before, snap, command)) break;
        } else {
          nullStreak += 1;
          if (nullStreak >= 3) break; // 内容脚本已卸载（正在导航），改用 Tab URL 兜底
        }
        await new Promise((resolve) => setTimeout(resolve, 220));
      }
    } else if (shouldVerify) {
      await new Promise((resolve) => setTimeout(resolve, 160));
      after = await getPageSnapshot(tabId, { maxElements: 40, maxText: 1200, frameId }).catch(() => null);
    }
    // 点击触发导航时，旧内容脚本可能已卸载；此时至少用 Tab URL 判断导航是否发生。
    if (shouldVerify && !after && before) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && tab.url) after = { version: 1, url: tab.url, title: tab.title || '', fingerprint: 'navigation:' + tab.url, scroll: null };
    }
    const verification = shouldVerify
      ? verifyPageAction(command, before, after, res)
      : { executed: true, verified: true, changed: false, reason: '读取类/视觉类命令无需内容验证' };
    if (after && after.url) {
      ctx.pageUrl = after.url || ctx.pageUrl;
      ctx.pageTitle = after.title || ctx.pageTitle;
    }
    return {
      ok: true,
      hadEffect: Boolean(verification.changed),
      result:
        (res.result || '已执行页面命令：' + command) +
        '\n验证：' + verification.reason +
        (command === 'click' && after ? '\n' + compactSnapshotSummary(after) : ''),
      verification,
      pageSnapshot: after,
    };
  } catch (e) {
    return { ok: false, result: '页面命令执行失败：' + e.message };
  }
}

/**
 * 执行单个工具调用
 * @param {string} name - 工具名
 * @param {Object} args - 参数
 * @param {Object} ctx - 运行上下文 { book, settings, page }
 * @returns {Promise<{result: string, citations?: Array, savedId?: string}>}
 */
// 从 SkillHub 下载技能 SKILL.md 并安装到本地（进阶版 A 的"自动获取"闭环）。
// 仅允许 skillhub.cn 来源；下载后做 name(kebab-case) 校验，避免非法/注入内容入库。
// 从 SkillHub 安装技能（进阶版 A 的"自动获取"闭环）。
// 注意：SkillHub 公开接口中 /api/v1/search 仅做检索；逐字 SKILL.md 正文走 /api/v1/skills/{slug}/file?path=SKILL.md&namespace={ns}
// （匿名可 200/302 拿到正文），但部分技能（团队命名空间需鉴权或接口波动）可能取不到，此时降级为基于元数据的生成式安装。
// 优先拉取 SkillHub 上的真实 SKILL.md 正文；不可用时降级为基于元数据的生成式安装。
async function fetchRealSkillMd(apiBase, slug, ns, signal) {
  try {
    const fileUrl =
      apiBase + '/skills/' + encodeURIComponent(slug) + '/file?path=SKILL.md' + (ns ? '&namespace=' + encodeURIComponent(ns) : '');
    const fileResp = await fetch(fileUrl, { headers: { Accept: 'text/plain, */*' }, signal });
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
  const raw = String(identifier || '').trim();
  if (!raw) return { ok: false, result: '缺少技能 identifier 参数（应为 @namespace/slug 或技能页 URL 或关键词）。' };
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
        return { ok: false, result: '出于安全限制，仅允许从 skillhub.cn 安装技能。' };
      }
      const m = u.pathname.match(/\/skills\/([^/]+)\/([^/?#]+)/) || u.pathname.match(/\/([^/]+)\/([^/?#]+?)(?:\.html)?$/);
      if (m) {
        ns = decodeURIComponent(m[1]);
        slug = decodeURIComponent(m[2]);
        keyword = slug;
      }
    } catch (e) {
      /* 当关键词处理 */
    }
  }
  const apiBase = 'https://api.skillhub.cn/api/v1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const searchUrl = apiBase + '/search?keyword=' + encodeURIComponent(keyword);
    const searchResp = await fetch(searchUrl, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!searchResp.ok) {
      return { ok: false, result: 'SkillHub 检索接口返回 ' + searchResp.status + '（该接口可能需登录或已调整）。' };
    }
    const searchJson = await searchResp.json();
    const results = Array.isArray(searchJson.results)
      ? searchJson.results
      : Array.isArray(searchJson)
        ? searchJson
        : [];
    let hit = null;
    if (slug) hit = results.find((r) => r.slug === slug || (r.namespace && r.namespace.publicSlug === slug));
    if (!hit && ns) {
      hit = results.find((r) => r.namespace && (r.namespace.handle === ns || r.namespace.canonicalName === '@' + ns + '/' + (slug || '')));
    }
    if (!hit) hit = results[0];
    if (!hit) return { ok: false, result: 'SkillHub 未检索到匹配「' + keyword + '」的技能。' };
    const name = hit.slug || hit.name;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name || '')) {
      return { ok: false, result: '技能名（slug）必须是 kebab-case，实际为：' + name };
    }
    if (!ns && hit.namespace && hit.namespace.handle) ns = hit.namespace.handle;
    const existing = await getUserSkills();
    const alreadyInstalled = existing.some((s) => s.name === name);
    // 优先拉取 SkillHub 上的真实 SKILL.md 正文；失败则降级为基于元数据的生成式安装。
    let skill = await fetchRealSkillMd(apiBase, name, ns, ctrl.signal);
    let generative = false;
    if (!skill) {
      generative = true;
      const summary = (hit.summary || hit.description || hit.description_zh || '').toString();
      const description = (hit.description_zh || hit.description || summary || '').toString().slice(0, 300);
      skill = {
        name,
        displayName: hit.displayName || hit.name,
        description,
        version: hit.version || '1.0.0',
        category: hit.category || '',
        tags: Array.isArray(hit.tags) ? hit.tags : [],
        skill_type: 'prompt-template',
        content:
          '# ' + (hit.displayName || hit.name) + '（SkillHub 安装）\n\n' +
          '来源：SkillHub（' + (hit.namespace ? hit.namespace.canonicalName : '') + '）\n' +
          '主页：' + (hit.homepage || '') + '\n\n' +
          '用途：' + summary + '\n\n' +
          '说明：本技能由 RecallFlow 基于 SkillHub 检索元数据自动安装，内容为摘要而非上游逐字 SKILL.md。' +
          '如需完整操作指引，请访问上述主页，或在该页面复制 SKILL.md 后用「导入」功能安装。',
      };
    } else {
      // 用检索元数据补全 SKILL.md 中可能缺失的展示字段
      skill.displayName = skill.displayName || hit.displayName || hit.name;
      if (!skill.category) skill.category = hit.category || '';
      if (!skill.tags || !skill.tags.length) skill.tags = Array.isArray(hit.tags) ? hit.tags : [];
      if (!skill.description) skill.description = (hit.description_zh || hit.description || hit.summary || '').toString();
      skill.version = skill.version || hit.version || '1.0.0';
      skill.name = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name || '') ? skill.name : name;
    }
    const saved = alreadyInstalled ? (await updateUserSkill(name, skill)) || (await addUserSkill(skill)) : await addUserSkill(skill);
    const prefix = alreadyInstalled ? '已重新安装（更新）技能' : '已安装技能';
    if (generative) {
      return {
        result:
          prefix + '「' + (saved.displayName || saved.name) + '」（name=' + saved.name +
          '，版本 ' + (saved.version || '1.0.0') + '）。注意：SkillHub 未返回逐字正文，内容为自动生成的摘要；' +
          '可调用 load_skill("' + saved.name + '") 使用，或到技能主页用「导入」获取完整版。',
      };
    }
    return {
      result:
        prefix + '「' + (saved.displayName || saved.name) + '」的完整正文（name=' + saved.name +
        '，版本 ' + (saved.version || '1.0.0') + '，来自 SkillHub 原文）。可调用 load_skill("' + saved.name + '") 使用。',
    };
  } catch (e) {
    return { ok: false, result: '安装失败：' + (e && e.message ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

export async function executeTool(name, args, ctx) {
  args = args || {};
  switch (name) {
    case 'search_knowledge_base': {
      const limit = Number(args.limit) || 5;
      const relevant = buildRagContext(ctx.book, args.query || '', limit);
      if (!relevant.length) return { result: '未检索到相关知识库条目。' };
      const citations = buildCitations(relevant, false);
      const text = relevant
        .map(
          (it, i) =>
            `[${i + 1}] 标题：${it.title}｜类型：${typeInfo(it.type).name}` +
            `${it.note ? '｜内容：' + it.note : ''}${it.url ? '｜链接：' + it.url : ''}`
        )
        .join('\n');
      return { result: '检索到的知识库条目：\n' + text, citations };
    }
    case 'list_knowledge_base': {
      let items = Object.values(ctx.book);
      if (args.type) items = items.filter((it) => it.type === args.type);
      items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const limit = Number(args.limit) || 20;
      const shown = items.slice(0, limit);
      const text = shown
        .map(
          (it, i) =>
            `[${i + 1}] 标题：${it.title}｜类型：${typeInfo(it.type).name}` +
            `${it.tags && it.tags.length ? '｜标签：' + it.tags.join('、') : ''}`
        )
        .join('\n');
      return { result: `知识库共 ${items.length} 条，以下列出 ${shown.length} 条：\n` + (text || '（空）'), citations: buildCitations(shown, true) };
    }
    case 'get_entry': {
      const it = ctx.book[args.id];
      if (!it) return { result: '未找到该条目（id: ' + args.id + '）。' };
      return {
        result:
          `标题：${it.title}\n类型：${typeInfo(it.type).name}\n` +
          `星级：${(STAR_LEVELS[it.status] || {}).name || it.status}\n` +
          `标签：${(it.tags || []).join('、') || '无'}\n备注：${it.note || '无'}\n链接：${it.url || '无'}`,
      };
    }
    case 'add_entry': {
      const id = args.url || 'kb:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
      const created = await upsertItem({
        id,
        type: args.type || 'note',
        title: args.title || '未命名',
        url: args.url || '',
        status: args.status || STATUS.IMPORTANT,
        note: args.note || '',
        tags: Array.isArray(args.tags) ? args.tags : [],
      });
      ctx.book = await getBook();
      return { result: `已保存条目：标题「${created.title}」(id: ${created.id})。`, savedId: created.id };
    }
    case 'remove_entry': {
      if (!ctx.book[args.id]) return { result: '未找到该条目，无需删除。' };
      await deleteItem(args.id);
      ctx.book = await getBook();
      return { result: '已删除条目 (id: ' + args.id + ')。' };
    }
    case 'read_current_page': {
      const tabId = ctx.tabId;
      if (!tabId) return { result: '无法定位当前标签页（可能不在前台页面）。' };
      try {
        const pageResponse = await sendTabMessage(tabId, {
          type: 'kbGetPageText',
          options: {
            visibleOnly: args.visibleOnly === true,
            checkTexts: Array.isArray(args.checkTexts) ? args.checkTexts : undefined,
          },
        });
        const text = pageResponse && pageResponse.text ? pageResponse.text : '';
        if (!text) return { result: '未能读取页面正文（内容脚本未注入或页面不支持）。' };
        // 带上标题与 URL，让模型一眼看到“Page Not Found / 404”等状态，避免继续猜路径。
        const head = '页面标题：' + (pageResponse.title || '') + '\n页面URL：' + (pageResponse.url || ctx.pageUrl || '') + '\n\n';
        const chunks = splitIntoChunks(text, 1200, 8);
        // 正文不再带 [n] 分块编号（避免与全局参考来源编号冲突）；来源编号由 Agent 层
        // 在登记引用后统一追加「参考来源 [X]」锚点，模型据此引用即可保证链接正确。
        let result = head + '当前页面正文：\n' + (chunks.length > 1 ? chunks.join('\n\n') : text);
        // 可见性核查：把「可见次数 / DOM 次数」直接写进工具结果，
        // 这样它就成为完成前校验可用的证据（否则校验器只能凭关键词是否出现来猜）。
        const visReport = formatVisibilityReport(pageResponse.visibility);
        if (visReport) result += '\n\n' + visReport;
        if (args.visibleOnly === true) {
          result += '\n\n（本次仅返回按可见性过滤后的文本；如需包含隐藏节点文字，去掉 visibleOnly。）';
        }
        // 404 / 无内容页面不作为参考来源登记，避免模型真正引用的内容被推到高序号。
        const is404 = /(404|page not found|not found|页面不存在|无法访问)/i.test(String(pageResponse.title || ''));
        const citations = is404
          ? []
          : chunks.map((c, i) => ({
              index: i + 1,
              source: 'page',
              title: (pageResponse.title || c.replace(/\s+/g, ' ').trim().slice(0, 40)),
              url: pageResponse.url || ctx.pageUrl || '',
              snippet: c,
            }));
        return { result, citations };
      } catch (e) {
        return { result: '读取页面失败：' + e.message };
      }
    }
    case 'get_page_snapshot': {
      const tabId = ctx.tabId;
      if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
      // 页面被 JS 对话框阻塞时，快照读不到有效内容，先提示处理对话框。
      if (cdpAllowed(ctx)) {
        const dialogs = getPendingDialogs(tabId);
        if (dialogs.length) {
          return {
            ok: true,
            hadEffect: false,
            snapshot: null,
            result:
              '⚠ 页面存在未处理的对话框：' + dialogs.map((d) => d.type + '：' + d.message).join('；') +
              '\n请先调用 handle_dialog 处理（accept=true 确定 / false 取消），否则页面被阻塞。',
          };
        }
      }
      try {
        const explicitFrame = args.frameId !== undefined && args.frameId !== null && args.frameId !== '';
        // 指定 frameId：只读该框架（跨域 iframe 内容也能读，内容脚本已注入所有框架）。
        if (explicitFrame) {
          const fid = Number(args.frameId);
          const snapshot = await getPageSnapshot(tabId, { maxElements: args.maxElements, maxText: args.maxText, frameId: fid });
          if (!snapshot) return { ok: false, result: '未能读取该框架的 DOM 快照（frameId=' + fid + '，可能无内容脚本）。' };
          const tagged = prefixFrameRefs(snapshot, fid);
          return { ok: true, hadEffect: false, snapshot: tagged, result: '框架 ' + fid + ' 的 DOM 快照：\n' + JSON.stringify(tagged) };
        }
        const snapshot = await getPageSnapshot(tabId, args);
        if (!snapshot) return { ok: false, result: '未能读取 DOM 快照（内容脚本未注入或页面不支持）。' };
        // 正文容器提醒：隐藏广告/推广时若连带隐藏它（或它的祖先），会把文章正文一起藏起来。
        const mainHint =
          snapshot.mainContent && snapshot.mainContent.selector
            ? '\n⚠ 疑似正文容器：' +
              snapshot.mainContent.selector +
              '（约 ' +
              snapshot.mainContent.textLength +
              ' 字）—— 隐藏广告/推广时不要整体隐藏它或其祖先。'
            : '';
        // includeFrames：合并所有子框架（含跨域 iframe）的可交互元素，ref 带 f<frameId>: 前缀。
        if (args.includeFrames === true) {
          const maxElements = Math.min(150, Math.max(1, Number(args.maxElements) || 60));
          let elements = (snapshot.elements || []).slice();
          const frames = await listFramesRaw(tabId);
          const childFrames = frames.filter((f) => Number(f.frameId) !== 0);
          for (const f of childFrames) {
            if (elements.length >= maxElements) break;
            const s = await getPageSnapshot(tabId, { maxElements: Math.max(1, maxElements - elements.length), maxText: 0, frameId: f.frameId }).catch(() => null);
            if (s && Array.isArray(s.elements) && s.elements.length) {
              elements = elements.concat(prefixFrameRefs(s, f.frameId).elements);
            }
          }
          const merged = Object.assign({}, snapshot, {
            elements: elements.slice(0, maxElements),
            frames: frames.map((f) => ({ frameId: f.frameId, url: f.href, title: f.title, isTop: !!f.isTop })),
          });
          return {
            ok: true,
            hadEffect: false,
            snapshot: merged,
            result:
              '当前页面 DOM 快照（已合并 ' + childFrames.length + ' 个子框架）：\n' + JSON.stringify(merged) +
              '\n提示：带 f<frameId>: 前缀的 ref 属于对应 iframe，动作时直接原样传回 ref 即可。' + mainHint,
          };
        }
        return {
          ok: true,
          hadEffect: false,
          snapshot,
          result: '当前页面 DOM 快照：\n' + JSON.stringify(snapshot) + mainHint,
        };
      } catch (e) {
        return { ok: false, result: '读取 DOM 快照失败：' + e.message };
      }
    }
    case 'list_frames': {
      const tabId = ctx.tabId;
      if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
      const frames = await listFramesRaw(tabId);
      if (!frames.length) return { ok: false, result: '未获取到页面框架信息（可能无内容脚本权限）。' };
      const text = frames
        .map((f) => (f.isTop ? '[顶层 frameId=0] ' : '[frameId=' + f.frameId + '] ') + (f.title || '') + '｜' + f.href)
        .join('\n');
      return {
        ok: true,
        frames,
        result:
          '页面框架（含跨域 iframe，共 ' + frames.length + ' 个）：\n' + text +
          '\n用法：用 get_page_snapshot 的 frameId 参数读取某框架；或在 get_page_snapshot 里传 includeFrames:true 一次性合并所有框架的元素（ref 会自动带 f<frameId>: 前缀）。',
      };
    }
    case 'read_console': {
      const tabId = ctx.tabId;
      if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
      try {
        const res = await sendTabMessage(tabId, { type: 'kbGetConsole' });
        let entries = (res && res.entries) || [];
        if (args.level) entries = entries.filter((e) => e.level === args.level);
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
        entries = entries.slice(-limit);
        if (!entries.length) return { ok: true, result: '暂无 console 记录。' };
        const text = entries.map((e) => '[' + e.level + '] ' + e.text + (e.stack ? '\n' + e.stack : '')).join('\n');
        return { ok: true, result: '最近 console 记录（' + entries.length + ' 条）：\n' + text };
      } catch (e) {
        return { ok: false, result: '读取 console 失败：' + e.message };
      }
    }
    case 'read_network': {
      const tabId = ctx.tabId;
      if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
      try {
        const res = await sendTabMessage(tabId, { type: 'kbGetNetwork' });
        let entries = (res && res.entries) || [];
        if (args.filter) {
          const f = String(args.filter);
          entries = entries.filter((e) => String(e.url || '').includes(f));
        }
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
        entries = entries.slice(-limit);
        if (!entries.length) return { ok: true, result: '暂无网络请求记录。' };
        const text = entries
          .map((e) => {
            const head = (e.method || 'GET') + ' ' + (e.error ? 'ERR' : (e.status || '')) + ' ' + e.url + (e.ms != null ? ' (' + e.ms + 'ms)' : '') + (e.error ? ' — ' + e.error : '');
            const init = e.initiator ? e.initiator.split('\n').slice(0, 2).join(' ') : '';
            return head + (init ? '\n  发起于: ' + init : '');
          })
          .join('\n');
        return { ok: true, result: '最近网络请求（' + entries.length + ' 条）：\n' + text };
      } catch (e) {
        return { ok: false, result: '读取网络请求失败：' + e.message };
      }
    }
    case 'get_element_source': {
      const tabId = ctx.tabId;
      if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
      try {
        const res = await sendTabMessage(tabId, { type: 'kbGetElementSource', params: args });
        if (!res || !res.found) return { ok: false, result: (res && res.reason) || '未找到元素或框架源码信息。' };
        const s = res.source || {};
        const loc = String(s.file || '') + (s.line ? ':' + s.line + (s.column ? ':' + s.column : '') : '');
        const extra = (s.framework ? '（' + s.framework + (s.component ? ' · ' + s.component : '') + '）' : '');
        return { ok: true, result: '元素源码位置：' + loc + extra + (res.selector ? '\n选择器：' + res.selector : '') };
      } catch (e) {
        return { ok: false, result: '解析元素源码失败：' + e.message };
      }
    }
    case 'type_text': {
      let res;
      try {
        res = await executeContentAction(ctx.tabId, 'type_text', { type: 'kbTypeText', params: args }, { delayMs: 80 });
      } catch (e) {
        res = { ok: false, result: '输入文本失败：' + e.message };
      }
      if (res && res.ok !== false) return res;
      // 合成输入失败 → 用 CDP 可信输入兜底（对受控组件/富文本编辑器更可靠）。
      // 子框架用 evaluateInFrame 聚焦该框架内的元素，insertText 会作用于当前焦点。
      const typeFrame = frameIdFromArgs(args);
      if (!cdpAllowed(ctx)) return res;
      const target = await resolveTarget(ctx.tabId, args);
      if (!target) return res;
      const isSubframe = typeFrame != null && typeFrame !== 0;
      try {
        const sel = JSON.stringify(target.selector);
        const focusExpr =
          '(() => { const el = document.querySelector(' + sel + '); if (!el) return false; el.focus();' +
          ' if (typeof el.setSelectionRange === "function" && typeof el.value === "string") el.setSelectionRange(el.value.length, el.value.length); return true; })()';
        if (isSubframe) await cdp.evaluateInFrame(ctx.tabId, typeFrame, focusExpr);
        else await cdp.evaluate(ctx.tabId, focusExpr);
        if (args.clearFirst === true) await cdp.pressKey(ctx.tabId, 'a', ['CTRL']);
        await cdp.insertText(ctx.tabId, String(args.text == null ? '' : args.text));
        rememberTarget(ctx, target);
        const after = await getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1000, frameId: isSubframe ? typeFrame : undefined }).catch(() => null);
        return {
          ok: true,
          hadEffect: true,
          cdp: true,
          pageSnapshot: after,
          verification: { executed: true, verified: true, changed: true, reason: '已用 CDP 可信输入' },
          result: '已用 CDP 可信输入 ' + String(args.text || '').length + ' 个字符' + (after ? '\n' + compactSnapshotSummary(after) : ''),
        };
      } catch (e) {
        return res || { ok: false, result: 'CDP 输入失败：' + summarizeCdpError(e) };
      }
    }
    case 'press_key': {
      let res;
      try {
        res = await executeContentAction(ctx.tabId, 'press_key', { type: 'kbPressKey', params: args }, { delayMs: 120 });
      } catch (e) {
        res = { ok: false, result: '派发键盘事件失败：' + e.message };
      }
      if (res && res.ok !== false) return res;
      if (!cdpAllowed(ctx)) return res;
      try {
        await cdp.pressKey(ctx.tabId, String(args.key || ''), args.modifiers);
        const after = await getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1000 }).catch(() => null);
        return {
          ok: true,
          hadEffect: true,
          cdp: true,
          pageSnapshot: after,
          verification: { executed: true, verified: true, changed: true, reason: '已用 CDP 派发按键' },
          result: '已用 CDP 派发按键：' + args.key + (after ? '\n' + compactSnapshotSummary(after) : ''),
        };
      } catch (e) {
        return res || { ok: false, result: 'CDP 按键失败：' + summarizeCdpError(e) };
      }
    }
    case 'select_option': {
      try {
        return await executeContentAction(ctx.tabId, 'select_option', { type: 'kbSelectOption', params: args }, { delayMs: 100 });
      } catch (e) {
        return { ok: false, result: '选择下拉项失败：' + e.message };
      }
    }
    case 'check_box': {
      try {
        return await executeContentAction(ctx.tabId, 'check_box', { type: 'kbCheckBox', params: args }, { delayMs: 100 });
      } catch (e) {
        return { ok: false, result: '切换复选框失败：' + e.message };
      }
    }
    case 'wait_for_element': {
      try {
        return await executeContentAction(ctx.tabId, 'wait_for_element', { type: 'kbWaitForElement', params: args }, { verify: false });
      } catch (e) {
        return { ok: false, result: '等待元素失败：' + e.message };
      }
    }
    case 'get_attribute': {
      try {
        return await executeContentAction(ctx.tabId, 'get_attribute', { type: 'kbGetAttribute', params: args }, { verify: false });
      } catch (e) {
        return { ok: false, result: '读取属性失败：' + e.message };
      }
    }
    case 'list_tabs': {
      try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const visibleTabs = tabs.filter((t) => t.url);
        const tabInfo = visibleTabs.map((t) => ({
          tabId: t.id,
          windowId: t.windowId,
          title: t.title || '',
          url: t.url || '',
          active: Boolean(t.active),
        }));
        const text = visibleTabs
          .filter((t) => t.url)
          .map((t, i) => `[${i + 1}] tabId=${t.id} ${t.active ? '（当前）' : ''} ${t.title || ''}｜${t.url}`)
          .join('\n');
        return { ok: true, tabs: tabInfo, result: '当前窗口标签页：\n' + (text || '（无）') };
      } catch (e) {
        return { ok: false, result: '列出标签页失败：' + e.message };
      }
    }
    case 'switch_tab': {
      const tabId = Number(args.tabId);
      if (!Number.isInteger(tabId) || tabId <= 0) return { ok: false, result: 'tabId 必须是有效的标签页 ID' };
      try {
        const target = await chrome.tabs.get(tabId);
        if (!target || !target.id) return { ok: false, result: '未找到标签页：' + tabId };
        await chrome.tabs.update(tabId, { active: true });
        const snapshot = await waitForTabReady(tabId, 5000);
        const current = await chrome.tabs.get(tabId).catch(() => target);
        const targetTab = {
          tabId,
          windowId: current.windowId || target.windowId,
          title: current.title || target.title || '',
          url: current.url || target.url || '',
          ready: Boolean(snapshot),
        };
        // 同步该标签页的弹窗开关状态，跟随 Agent 当前绑定 tab。
        bindSessionTab(tabId);
        return {
          ok: true,
          targetTabId: tabId,
          targetTab,
          pageSnapshot: snapshot,
          result: '已切换到标签页 tabId=' + tabId + '：' + (target.title || target.url || '') + (snapshot ? '（页面已就绪）' : '（内容脚本尚未就绪）'),
        };
      } catch (e) {
        return { ok: false, result: '切换标签页失败：' + e.message };
      }
    }
    case 'open_tab': {
      try {
        const url = String(args.url || '');
        if (!/^https?:\/\//i.test(url)) return { ok: false, result: 'open_tab 仅支持 http/https 链接：' + url };
        const forceNew = args.newTab === true;
        // 隔离模式（研究/知识库/对话）：不激活标签、不抢用户前台视图，静默复用/读取。
        const isolated = ctx.browsingMode === 'isolated';
        // 默认复用已打开的同 URL 标签页（去重，避免 tab 越开越多）。
        if (!forceNew) {
          const existing = await chrome.tabs.query({ url }).catch(() => []);
          const hit = Array.isArray(existing) && existing.find((t) => t.id && /^https?:/i.test(t.url || ''));
          if (hit) {
            if (!isolated) await chrome.tabs.update(hit.id, { active: true });
            const snapshot = await waitForTabReady(hit.id, 5000);
            const current = await chrome.tabs.get(hit.id).catch(() => hit);
            const targetTab = {
              tabId: hit.id,
              windowId: current.windowId || hit.windowId,
              title: current.title || hit.title || '',
              url: current.url || hit.url || url,
              ready: Boolean(snapshot),
            };
            bindSessionTab(hit.id);
            return {
              ok: true,
              reused: true,
              targetTabId: hit.id,
              targetTab,
              pageSnapshot: snapshot,
              // 诊断：复用路径"取了第一个匹配的标签页"，而它可能是**隔离窗口里那个陈旧/不可达的**
              // （用户实测：browser_read 稳定报 Receiving end does not exist，而当前活动页
              //   的内容脚本明明是通的）。把候选数量、以及最终选中标签页的状态一起带出来，
              // 重载后用一次真实调用就能判定是不是这个原因。
              diag: {
                candidates: Array.isArray(existing) ? existing.length : 0,
                chosen: {
                  tabId: hit.id,
                  windowId: targetTab.windowId,
                  status: String((current && current.status) || ''),
                  discarded: Boolean(current && current.discarded),
                  url: String((current && current.url) || hit.url || ''),
                },
                ready: Boolean(snapshot),
              },
              result: '已复用已打开的标签页 tabId=' + hit.id + '：' + targetTab.url + (snapshot ? '（页面已就绪）' : '（内容脚本尚未就绪）'),
            };
          }
        }
        // 标签页预算：按「累计新建数」限制（而非当前存活数，避免中途清理导致反复重开）。
        // 达到上限时软拒绝：给出已打开标签页清单，引导模型复用/抓取，而不是硬失败后反复重试。
        const openedCount = Number(ctx.openedTabCount || 0);
        if (openedCount >= Number(ctx.maxOpenedTabs || 5)) {
          const summary = await listOpenedTabsSummary(ctx).catch(() => '');
          return {
            ok: false,
            blocked: true,
            result:
              '本任务已新建 ' + openedCount + ' 个标签页，达到上限（' + (ctx.maxOpenedTabs || 5) + '），禁止继续新建。' +
              (summary ? '\n当前已打开的标签页：\n' + summary : '') +
              '请改用 switch_tab 复用上面的标签页（tabId），或改用 fetch_webpage 直接抓取内容；不要再调用 open_tab。',
          };
        }
        const t = isolated
          ? await chrome.tabs.create({ url, windowId: await ensureAgentWindow(ctx), active: false })
          : await chrome.tabs.create({ url });
        if (!t || !t.id) return { ok: false, result: '打开标签页失败：浏览器未返回 tabId' };
        ctx.openedTabCount = openedCount + 1;
        trackOpenedTab(ctx, t.id);
        const snapshot = await waitForTabReady(t.id, 8000);
        bindSessionTab(t.id);
        const current = await chrome.tabs.get(t.id).catch(() => t);
        const targetTab = {
          tabId: t.id,
          windowId: current.windowId || t.windowId,
          title: current.title || t.title || '',
          url: (current.url || t.url || args.url || ''),
          ready: Boolean(snapshot),
        };
        return {
          ok: true,
          targetTabId: t.id,
          targetTab,
          pageSnapshot: snapshot,
          // 诊断：新建路径用的是**隔离窗口**，而 ensureAgentWindow 把它建成 `state:'minimized'`。
          // 最小化窗口里的标签页可能一直不执行内容脚本 —— 那样 open_tab 的 8 秒等待必然白等，
          // 随后 read_current_page 就报 Receiving end does not exist。带出窗口状态便于判定。
          diag: {
            windowId: targetTab.windowId,
            windowState: await chrome.windows
              .get(targetTab.windowId)
              .then((w) => String((w && w.state) || ''))
              .catch(() => ''),
            status: String((current && current.status) || ''),
            discarded: Boolean(current && current.discarded),
            ready: Boolean(snapshot),
          },
          result: '已在新标签页打开并绑定：tabId=' + t.id + ' ' + (t.url || args.url) + (snapshot ? '（页面已就绪）' : '（内容脚本尚未就绪）'),
        };
      } catch (e) {
        return { ok: false, result: '打开标签页失败：' + e.message };
      }
    }
    case 'fetch_webpage': {
      // 失败要如实上报 ok:false（触发失败摘除机制，避免反复重试空耗预算）；
      // 失败 URL 记入 ctx.failedUrls，同一 URL 重试时直接拒绝。
      ctx.failedUrls = Array.isArray(ctx.failedUrls) ? ctx.failedUrls : [];
      const u = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(u)) return { ok: false, result: '仅支持 http/https 链接：' + u };
      const norm = u.replace(/\/+$/, '');
      if (ctx.failedUrls.includes(norm)) {
        return {
          ok: false,
          result:
            '该 URL 此前已抓取失败（' + u + '），请勿重试。请改用 open_tab 打开该页读取渲染后内容，或换用其它来源；' +
            '若无法打开，直接基于已有信息总结并结束，不要继续猜测 URL。',
        };
      }
      try {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
        const resp = await fetch(u, { method: 'GET', redirect: 'follow', signal: ctrl ? ctrl.signal : undefined });
        if (timer) clearTimeout(timer);
        if (!resp.ok) {
          ctx.failedUrls.push(norm);
          return { ok: false, result: '抓取失败 (' + resp.status + ')：' + u + '。请改用 open_tab 打开该页，或换用其它来源；不要反复重试该 URL。' };
        }
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (ct && !/^(text\/html|text\/plain|application\/xml|application\/xhtml|\+xml)/.test(ct) && !ct.includes('json')) {
          ctx.failedUrls.push(norm);
          return { ok: false, result: '该地址返回非文本内容（' + ct + '）：' + u + '。若需该资源请改用 open_tab 查看，否则换用其它来源。' };
        }
        const maxBytes = 1.5 * 1024 * 1024;
        const buf = await readBounded(resp.body, maxBytes);
        const decoder = decodeBuffer(ct);
        const raw = decoder.decode(buf);
        const truncated = buf.byteLength >= maxBytes;
        const fullText = stripHtml(raw);
        const trimmedText = fullText.trim();
        if (!trimmedText) {
          ctx.failedUrls.push(norm);
          return { ok: false, result: '该页面正文为空（' + u + '）。请改用 open_tab 打开读取渲染后内容，或换用其它来源。' };
        }
        // 检测「前端 JS 渲染（SPA）」：正文提取过少且源码里以脚本壳为主 → 引导改用 open_tab 读取渲染后内容。
        const likelySpa = trimmedText.length < 150 && /<script[\s>]/i.test(raw);
        const text = fullText.slice(0, 8000);
        const finalUrl = resp.url || u;
        // 只有拿到「实质性正文」才登记为参考来源；SPA 骨架/过短内容不产生引用，
        // 避免没用的抓取占掉来源编号（导致模型真正引用的内容从 [3] 之类的高序号开始）。
        const usable = !likelySpa && trimmedText.length >= 200;
        return {
          result:
            '网页正文（' + finalUrl + '）：\n' + text +
            (truncated ? '\n（内容过大已截断）' : '') +
            (likelySpa
              ? '\n\n⚠ 页面正文提取过少，疑似前端 JS 渲染（SPA）页面，源码里只有脚本壳。' +
                '请改用 open_tab 打开该页，再用 get_page_snapshot / read_current_page 读取渲染后的真实内容；' +
                '禁止继续用 fetch_webpage 猜测其它 URL。若无法打开，请直接基于已有信息总结并结束。'
              : '') +
            (!usable ? '\n（该次抓取内容不足以作为参考来源，不作为来源编号登记。）' : ''),
          ...(usable
            ? { citations: [{ index: 1, source: 'web', title: extractHtmlTitle(raw) || finalUrl, url: finalUrl, snippet: text.slice(0, 180) }] }
            : {}),
        };
      } catch (e) {
        ctx.failedUrls.push(norm);
        return {
          ok: false,
          result:
            '抓取网页失败：' + e.message + '。请改用 open_tab 打开读取，或换用其它来源；不要反复重试该 URL。' +
            '（若为目标站跨域，请将其域名加入 manifest.json 的 host_permissions；或改用 MCP fetch 服务器以突破浏览器跨域限制）',
        };
      }
    }
    case 'web_search': {
      const q = String(args.query || '').trim();
      if (!q) return { ok: false, result: '请提供搜索关键词 query。' };
      const maxResults = Math.min(10, Math.max(1, Number(args.maxResults) || 6));
      try {
        const results = await searchWeb(q, maxResults);
        if (!results.length) return { ok: false, result: '未搜索到结果，可尝试换关键词，或 open_tab 打开已知站点。' };
        const lines = results.map(
          (r, i) => '[' + (i + 1) + '] ' + r.title + '\n    链接：' + r.url + (r.snippet ? '\n    摘要：' + r.snippet : '')
        );
        // 搜索结果只是「候选入口」，不作为可点击的参考来源（避免来源区被搜索快照刷屏、
        // 也避免占用全局引用编号）。真正被 fetch / read 过的页面才会进入参考来源。
        return {
          result:
            '搜索结果（' + q + '）：\n' + lines.join('\n\n') +
            '\n\n（以上为搜索结果候选，不属于参考来源；如需引用请先 open_tab / fetch_webpage 读取目标页面，读取后的页面会登记为参考来源编号。）',
        };
      } catch (e) {
        return { ok: false, result: '网络搜索失败：' + e.message };
      }
    }
    case 'click_element': {
      const contentRes = await executePageTool(ctx.tabId, 'click', args, ctx);
      const target = await resolveTarget(ctx.tabId, args);
      if (target && contentRes && contentRes.ok !== false) rememberTarget(ctx, target);
      // 合成点击失败（未找到/不可操作）时，用 CDP 可信点击兜底；
      // 成功但无观察变化时不自动重试，避免对已生效的动作二次触发（可用 click_at 强制）。
      // 子框架（frameId≠0）需把框架内坐标换算为顶层坐标（resolveFrameClickPoint），
      // 换算不可靠时退回内容脚本结果，绝不在错误坐标上点击。
      const clickFrame = frameIdFromArgs(args);
      if (!contentRes || contentRes.ok !== false || !cdpAllowed(ctx) || !target) return contentRes;
      try {
        let point = { x: target.rect.centerX, y: target.rect.centerY };
        if (clickFrame != null && clickFrame !== 0) {
          const resolved = await cdp.resolveFrameClickPoint(ctx.tabId, clickFrame, target.selector, point).catch(() => null);
          if (!resolved) return contentRes;
          point = resolved;
        }
        await cdp.clickAt(ctx.tabId, point.x, point.y);
        const after = await getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200, frameId: clickFrame != null && clickFrame !== 0 ? clickFrame : undefined }).catch(() => null);
        return {
          ok: true,
          hadEffect: true,
          cdp: true,
          pageSnapshot: after,
          verification: { executed: true, verified: true, changed: true, reason: '已用 CDP 派发可信点击' },
          result:
            '内容脚本点击失败（' + String(contentRes.result || '').replace(/\s+/g, ' ').slice(0, 80) + '），已改用 CDP 可信点击（坐标 ' +
            Math.round(point.x) + ',' + Math.round(point.y) + '）' +
            (after ? '\n' + compactSnapshotSummary(after) : ''),
        };
      } catch (e) {
        return contentRes;
      }
    }
    case 'click_at': {
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, result: 'click_at 需要数值坐标 x、y。' };
      if (!cdpAllowed(ctx)) return { ok: false, result: 'click_at 需要 CDP 输入层（请在设置中开启「浏览器级输入」，且需 Chromium 内核浏览器）。' };
      try {
        await cdp.clickAt(ctx.tabId, x, y, { button: args.button || 'left', clickCount: args.double ? 2 : 1 });
        const after = await getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
        return {
          ok: true,
          hadEffect: true,
          cdp: true,
          pageSnapshot: after,
          verification: { executed: true, verified: true, changed: true, reason: 'CDP 坐标点击已派发' },
          result: '已在坐标 (' + x + ',' + y + ') 点击' + (after ? '\n' + compactSnapshotSummary(after) : ''),
        };
      } catch (e) {
        return { ok: false, result: 'CDP 点击失败：' + summarizeCdpError(e) };
      }
    }
    case 'hover_element': {
      if (!cdpAllowed(ctx)) return { ok: false, result: '悬停需要 CDP 输入层（请在设置中开启）。' };
      const target = await resolveTarget(ctx.tabId, args);
      if (!target) return { ok: false, result: '未找到目标元素。' };
      try {
        await cdp.moveTo(ctx.tabId, target.rect.centerX, target.rect.centerY);
        rememberTarget(ctx, target);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const after = await getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
        return {
          ok: true,
          hadEffect: true,
          cdp: true,
          pageSnapshot: after,
          verification: { executed: true, verified: true, changed: true, reason: 'CDP 悬停已派发' },
          result: '已悬停到元素（坐标 ' + target.rect.centerX + ',' + target.rect.centerY + '）' + (after ? '\n' + compactSnapshotSummary(after) : ''),
        };
      } catch (e) {
        return { ok: false, result: '悬停失败：' + summarizeCdpError(e) };
      }
    }
    case 'drag_element': {
      if (!cdpAllowed(ctx)) return { ok: false, result: '拖拽需要 CDP 输入层（请在设置中开启）。' };
      const from = await resolveTarget(ctx.tabId, { ref: args.fromRef, selector: args.fromSelector, text: args.fromText });
      const to = await resolveTarget(ctx.tabId, { ref: args.toRef, selector: args.toSelector, text: args.toText });
      if (!from || !to) return { ok: false, result: '拖拽需要能同时定位起点与终点（fromRef/fromSelector/fromText 与 toRef/toSelector/toText）。' };
      try {
        await cdp.drag(ctx.tabId, from.rect.centerX, from.rect.centerY, to.rect.centerX, to.rect.centerY);
        const after = await getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
        return {
          ok: true,
          hadEffect: true,
          cdp: true,
          pageSnapshot: after,
          verification: { executed: true, verified: true, changed: true, reason: 'CDP 拖拽已派发' },
          result: '已从 (' + from.rect.centerX + ',' + from.rect.centerY + ') 拖拽到 (' + to.rect.centerX + ',' + to.rect.centerY + ')' + (after ? '\n' + compactSnapshotSummary(after) : ''),
        };
      } catch (e) {
        return { ok: false, result: '拖拽失败：' + summarizeCdpError(e) };
      }
    }
    case 'upload_file': {
      if (!cdpAllowed(ctx)) return { ok: false, result: '文件上传需要 CDP（请在设置中开启）。' };
      const files = Array.isArray(args.files) ? args.files.filter(Boolean) : args.files ? [args.files] : [];
      if (!files.length) return { ok: false, result: 'upload_file 需要 files（本地文件的绝对路径数组）。' };
      const target = await resolveTarget(ctx.tabId, args);
      if (!target) return { ok: false, result: '未找到 file input 元素。' };
      try {
        await cdp.uploadFile(ctx.tabId, target.selector, files);
        return { ok: true, hadEffect: true, cdp: true, result: '已向文件输入框设置 ' + files.length + ' 个文件：' + files.join('、') };
      } catch (e) {
        return { ok: false, result: '文件上传失败：' + summarizeCdpError(e) };
      }
    }
    case 'get_ax_snapshot': {
      if (!cdpAllowed(ctx)) return { ok: false, result: '可访问性树快照需要 CDP（请在设置中开启）。' };
      try {
        const nodes = await cdp.getFullAxTree(ctx.tabId);
        const INTERACTIVE_ROLES = new Set([
          'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
          'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider',
          'spinbutton', 'treeitem', 'gridcell',
        ]);
        const limit = Math.min(120, Math.max(1, Number(args.limit) || 60));
        const picked = [];
        for (const n of nodes) {
          if (!n || n.ignored) continue;
          const role = n.role && n.role.value;
          if (!role || !INTERACTIVE_ROLES.has(role)) continue;
          const name = String((n.name && n.name.value) || '').slice(0, 120);
          picked.push({ role, name, locator: { role, name }, backendDOMNodeId: n.backendDOMNodeId });
          if (picked.length >= limit) break;
        }
        const withBox = [];
        for (const p of picked) {
          if (!p.backendDOMNodeId) { withBox.push(p); continue; }
          try {
            const box = await cdp.getBoxModel(ctx.tabId, p.backendDOMNodeId);
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
        const lines = withBox.map((p, i) => '[' + (i + 1) + '] ' + p.role + '「' + p.name + '」' + (p.x != null ? ' 坐标(' + p.x + ',' + p.y + ')' : ''));
        return {
          ok: true,
          ax: withBox,
          result:
            '可访问性树（交互节点 ' + withBox.length + ' 个，含 role/名称/坐标）：\n' + (lines.join('\n') || '（无）') +
            '\n用法：优先用 role+name 定位（如 click_element({role:"button",name:"登录"})），比坐标更稳；canvas/虚拟列表等无 DOM 场景再用坐标 click_at。',
        };
      } catch (e) {
        return { ok: false, result: '读取可访问性树失败：' + summarizeCdpError(e) };
      }
    }
    case 'set_element_style':
    case 'highlight_text':
    case 'outline_element':
    case 'get_element_text':
    case 'inspect_element':
    case 'extract_table':
    case 'clear_page_overlays':
      return await executePageTool(ctx.tabId, pageToolCommand(name), args, ctx);
    case 'take_screenshot': {
      // 截图走 CDP，不经内容脚本。图片体积只能靠 format/quality 控制
      // （Page.captureScreenshot 不支持缩放），因此按阶梯逐级降质重拍。
      if (!cdpAllowed(ctx)) return { ok: false, result: '截图需要 CDP：请在设置中开启「浏览器级输入层（CDP）」。' };
      if (!ctx.tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
      const wantPng = args && args.format === 'png';
      const ladder = screenshotAttempts(wantPng ? 'png' : 'jpeg', args && args.quality);
      let data = '';
      let used = ladder[0];
      let usedIndex = 0;
      for (let i = 0; i < ladder.length; i++) {
        const step = ladder[i];
        try {
          data = await cdp.screenshot(ctx.tabId, {
            format: step.format,
            quality: step.quality,
            fullPage: args && args.fullPage === true,
          });
        } catch (e) {
          data = '';
        }
        used = step;
        usedIndex = i;
        if (data && data.length <= MAX_SHOT_B64) break;
      }
      if (!data) return { ok: false, result: '截图失败：CDP 无法附加到该标签页（可能被其它调试工具占用）。' };
      // 尺寸取 CSS 视口 / 内容尺寸：CDP 不返回位图尺寸，而位图还受 DPR 影响，
      // 因此如实标注单位，不假装是像素尺寸。
      let width = 0;
      let height = 0;
      try {
        const m = await cdp.command(ctx.tabId, 'Page.getLayoutMetrics');
        const box = args && args.fullPage === true ? (m.cssContentSize || m.contentSize) : (m.cssVisualViewport || m.visualViewport);
        if (box) {
          width = Math.round(box.clientWidth || box.width || 0);
          height = Math.round(box.clientHeight || box.height || 0);
        }
      } catch (e) {}
      const bytes = Math.round((data.length * 3) / 4);
      const id = 'shot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      const mime = used.format === 'png' ? 'png' : 'jpeg';
      const label = String((args && args.label) || '').slice(0, 60);
      const stored = await saveScreenshot({ id, label, dataUrl: 'data:image/' + mime + ';base64,' + data, width, height, bytes });
      return {
        ok: true,
        readOnly: true,
        // 给面板渲染用：base64 在这里，但 agent.js 只把它转成事件，绝不写入模型消息。
        screenshot: { id, dataUrl: 'data:image/' + mime + ';base64,' + data, label, width, height, bytes, archived: stored },
        result: formatScreenshotSummary({
          width,
          height,
          format: used.format,
          quality: used.quality,
          bytes,
          label,
          degraded: usedIndex > 0,
        }) + (stored ? '（图片已归档，可经 MCP 取回）' : ''),
      };
    }
    case 'scroll_page': {
      // 合并自 scroll_to_element / scroll_page：有目标或坐标走按目标滚动，否则按偏移。
      const params = args || {};
      const hasTarget = Boolean(params.ref || params.selector || params.text);
      const hasCoords = typeof params.top === 'number' || typeof params.left === 'number';
      return await executePageTool(ctx.tabId, hasTarget || hasCoords ? 'scroll_to' : 'scroll_by', params, ctx);
    }
    case 'run_javascript': {
      // engine='page'：用 CDP Runtime.evaluate 在页面主世界执行（可访问页面自身 JS 状态，
      // 且不受页面 CSP 限制）；默认走内容脚本受限沙箱（无 chrome.*）。
      if (args.engine === 'page' || args.pageWorld === true) {
        return await evaluateInPageWorld(ctx, args);
      }
      try {
        const r = await executeContentAction(ctx.tabId, 'run_javascript', { type: 'kbRunJavaScript', params: args }, { delayMs: 80 });
        if (r && r.ok === false) {
          // 沙箱用 new Function 实现，而**内容脚本里的 eval 类构造同样受页面 CSP 约束** ——
          // 页面只要没放行 unsafe-eval 就会被拒。这里自动改用页面主世界重试：
          // 同一段代码、同一次审批，模型不必多花一轮，也不会再弹一次审批。
          const msg = String((r && (r.error || r.result)) || '');
          if (isCspEvalBlockError(msg)) {
            if (!cdpAllowed(ctx)) {
              return {
                ok: false,
                result:
                  '沙箱执行被页面 CSP 阻止（页面未放行 unsafe-eval）。改用页面主世界需要 CDP：请在设置中开启「浏览器级输入层（CDP）」后重试。原始错误：' +
                  msg.slice(0, 200),
              };
            }
            const retry = await evaluateInPageWorld(ctx, args);
            if (retry && retry.ok) {
              return Object.assign({}, retry, {
                result: '（沙箱被页面 CSP 阻止，已自动改用页面主世界执行）\n' + (retry.result || ''),
              });
            }
            return {
              ok: false,
              result: '沙箱被页面 CSP 阻止；改用页面主世界同样失败：' + ((retry && retry.result) || '未知错误'),
            };
          }
          return r;
        }
        if (r && r.verification) {
          // JS 可能只读取不改页面，快照验证不一定有变化，此时以返回结果为准。
          r.verification.reason = 'JS 已执行，返回结果见上';
        }
        return r;
      } catch (e) {
        return { ok: false, result: '执行 JS 失败：' + e.message };
      }
    }
    case 'list_userscripts': {
      const scripts = await listUserscripts();
      const text = scripts.length
        ? scripts
            .map(
              (s, i) =>
                `[${i + 1}] ${s.name} v${s.version}${s.enabled ? '' : '（已停用）'}\n` +
                `id：${s.id}\n匹配：${(s.matches || []).join('、')}\n描述：${s.description || '无'}`
            )
            .join('\n\n')
        : '尚未安装任何用户脚本。';
      return { ok: true, result: '已安装的用户脚本：\n' + text };
    }
    case 'search_userscripts': {
      const list = await searchScripts(args.query);
      return {
        ok: true,
        result: list.length
          ? 'GreasyFork 搜索结果：\n' +
            list
              .map((it, i) => `[${i + 1}] ${it.name}（安装 ${it.installs}）\n${it.description}\ncode_url：${it.codeUrl}`)
              .join('\n\n')
          : '未找到相关脚本',
      };
    }
    case 'install_userscript': {
      const usSettings = await getUserscriptSettings();
      if (!usSettings.agentCanInstall) {
        return { ok: false, result: '用户已在设置中关闭“允许 Agent 安装脚本”，请打开设置页开启后再试。' };
      }
      const r = await installFromUrl(args.url);
      return {
        ok: true,
        result:
          '已安装用户脚本：' + r.script.name + ' v' + r.script.version +
          '\n匹配：' + (r.script.matches || []).join('、') +
          (r.script.warnings && r.script.warnings.length ? '\n警告：' + r.script.warnings.join('；') : ''),
      };
    }
    case 'run_userscript': {
      const r = await runUserscriptOnTab(ctx.tabId, args.scriptId);
      return r.ok ? { ok: true, result: r.result } : { ok: false, result: r.error };
    }
    case 'complete_task': {
      const summary = String(args.summary || '任务完成。');
      const evidence = args.evidence ? String(args.evidence) : '';
      return { result: '任务已完成：' + summary + (evidence ? '\n证据：' + evidence : ''), complete: true };
    }
    case 'load_skill': {
      // 进阶版 A：按需把技能的完整使用说明返回给模型（不预先注入，省 token、由模型自选）。
      const name = String((args && args.name) || '').trim();
      if (!name) return { ok: false, result: '缺少技能 name 参数。' };
      const all = await getMergedSkills();
      const skill = all.find((s) => s.name === name || s.title === name || s.id === name);
      if (!skill) return { ok: false, result: '未找到名为「' + name + '」的技能。可用技能见系统提示中的技能目录。' };
      const parts = ['# 技能：' + (skill.title || skill.name)];
      if (skill.description) parts.push('用途：' + skill.description);
      if (Array.isArray(skill.tags) && skill.tags.length) parts.push('标签：' + skill.tags.join('、'));
      if (skill.content) parts.push(skill.content);
      const toolWarnings = validateSkillTools(skill);
      if (toolWarnings.length) {
        parts.push(
          '⚠ 注意：该技能声明的依赖工具存在问题，Agent 无法调用，请到技能页更新依赖工具列表：\n' +
            toolWarnings.map((w) => '- ' + w).join('\n')
        );
      }
      return { result: parts.join('\n\n') };
    }
    case 'install_skill': {
      const identifier = String((args && (args.identifier || args.url)) || '').trim();
      if (!identifier) return { ok: false, result: '缺少技能 identifier 参数。' };
      return await installSkillFromSkillHub(identifier);
    }
    case 'undo_last_action': {
      return await executeContentAction(ctx.tabId, 'undo_last_action', { type: 'kbUndo', params: args }, { verify: false });
    }
    case 'save_macro': {
      const name = String((args && args.name) || '').trim();
      if (!name) return { ok: false, result: 'save_macro 需要 name。' };
      const trace = Array.isArray(ctx.trace) ? ctx.trace : [];
      if (!trace.length) {
        return { ok: false, result: '当前任务没有可保存的可重放动作（仅点击/输入/按键/勾选/选择/滚动/等待/开页会被记录）。' };
      }
      const saved = await saveMacro(ctx.pageUrl, { name, description: args && args.description, steps: trace });
      if (!saved) return { ok: false, result: '保存宏失败（缺少名称或步骤）。' };
      return {
        ok: true,
        result: '已保存宏「' + saved.name + '」（' + saved.steps.length + ' 步）。以后可直接调用 run_macro("' + saved.name + '") 回放。',
      };
    }
    case 'list_macros': {
      const macros = await listMacros(ctx.pageUrl);
      if (!macros.length) return { ok: true, result: '当前站点还没有保存的宏。' };
      const text = macros
        .map((m, i) => '[' + (i + 1) + '] ' + m.name + (m.description ? '：' + m.description : '') + '（' + m.steps.length + ' 步）')
        .join('\n');
      return { ok: true, result: '当前站点已保存的宏：\n' + text };
    }
    case 'run_macro': {
      const name = String((args && args.name) || '').trim();
      if (!name) return { ok: false, result: 'run_macro 需要 name。' };
      const macro = await getMacro(ctx.pageUrl, name);
      if (!macro) return { ok: false, result: '未找到宏「' + name + '」（可用 list_macros 查看）。' };
      const steps = Array.isArray(macro.steps) ? macro.steps : [];
      if (!steps.length) return { ok: false, result: '宏「' + name + '」没有步骤。' };
      const log = [];
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        let r;
        try {
          r = await executeTool(s.tool, s.args, ctx);
        } catch (e) {
          r = { ok: false, result: e && e.message ? e.message : String(e) };
        }
        const failed = r && r.ok === false;
        log.push('[' + (i + 1) + '/' + steps.length + '] ' + s.tool + (failed ? ' ✗ ' + String(r.result || '').slice(0, 120) : ' ✓'));
        if (r && Number.isInteger(Number(r.targetTabId))) {
          ctx.tabId = Number(r.targetTabId);
          if (r.targetTab) {
            ctx.pageUrl = r.targetTab.url || ctx.pageUrl;
            ctx.pageTitle = r.targetTab.title || ctx.pageTitle;
          }
        }
        if (failed) return { ok: false, result: '宏「' + name + '」在第 ' + (i + 1) + ' 步失败，已停止：\n' + log.join('\n') };
      }
      await bumpMacroHits(ctx.pageUrl, name).catch(() => {});
      return { ok: true, result: '已回放宏「' + name + '」（' + steps.length + ' 步）：\n' + log.join('\n') };
    }
    case 'trust_site': {
      let origin = '';
      try {
        origin = new URL(ctx.pageUrl || '').origin;
      } catch (e) {}
      if (!origin) return { ok: false, result: '无法确定当前站点。' };
      const list = Array.isArray(ctx.settings.trustedSites) ? ctx.settings.trustedSites.slice() : [];
      if (!list.includes(origin)) list.push(origin);
      ctx.settings.trustedSites = list;
      try {
        await chrome.storage.local.set({ aiSettings: Object.assign({}, ctx.settings, { trustedSites: list }) });
      } catch (e) {}
      return {
        ok: true,
        result: '已信任站点 ' + origin + '：此站点的写操作将不再逐次确认（run_javascript 等高风险工具仍每次确认）。',
      };
    }
    case 'update_plan': {
      const raw = Array.isArray(args.items) ? args.items : [];
      const plan = raw
        .filter((it) => it && typeof it.text === 'string' && it.text.trim())
        .slice(0, 20)
        .map((it) => ({
          text: String(it.text).trim().slice(0, 120),
          status: ['pending', 'in_progress', 'done'].includes(it.status) ? it.status : 'pending',
        }));
      ctx.plan = plan;
      const text = plan
        .map((p, i) => (p.status === 'done' ? '✓' : p.status === 'in_progress' ? '▶' : '○') + ' ' + (i + 1) + '. ' + p.text)
        .join('\n');
      return { result: '计划已更新（' + plan.length + ' 步）：\n' + (text || '（空计划）') };
    }
    case 'expand_result': {
      const id = String((args && args.id) || '').trim();
      const store = ctx && ctx.resultStore;
      const text = store && typeof store.get === 'function' ? store.get(id) : null;
      if (!text) {
        // 结果只存在于本次运行的暂存里；跨「继续」恢复后旧 id 的内容已释放。
        // 明确说明这一点，避免模型以为是自己记错了 id 而反复重试。
        const known = ctx && ctx.resultIds && typeof ctx.resultIds.has === 'function' && ctx.resultIds.has(id);
        return {
          ok: false,
          result:
            '未找到结果 id=' +
            id +
            (known
              ? '：该结果属于**上一轮运行**，内容已释放（大结果暂存不跨恢复保留）。请重新执行对应工具读取当前内容。'
              : '：请确认 id 是否正确（形如 res-12）。大结果暂存只在本次运行内有效，重新读取页面时会生成新的 id。'),
        };
      }
      const offset = Math.max(0, Number(args.offset) || 0);
      const limit = Math.min(4000, Math.max(200, Number(args.limit) || 2000));
      const slice = String(text).slice(offset, offset + limit);
      return {
        ok: true,
        result: '结果 ' + id + ' [' + offset + ',' + (offset + slice.length) + ') / 共 ' + String(text).length + ' 字符：\n' + slice,
      };
    }
    case 'handle_dialog': {
      if (!cdpAllowed(ctx)) return { ok: false, result: '处理对话框需要 CDP（请在设置中开启）。' };
      try {
        await handleDialog(ctx.tabId, args.accept !== false, args.promptText);
        return { ok: true, result: (args.accept !== false ? '已接受' : '已取消') + '页面对话框。' };
      } catch (e) {
        return { ok: false, result: '处理对话框失败：' + summarizeCdpError(e) };
      }
    }
    case 'list_downloads': {
      const list = getDownloads(ctx.tabId);
      if (!list.length) return { ok: true, result: '本任务暂未捕获到下载。' };
      return {
        ok: true,
        result: '捕获到的下载：\n' + list.map((d, i) => '[' + (i + 1) + '] ' + (d.suggestedFilename || '') + ' ← ' + d.url).join('\n'),
      };
    }
    case 'get_run_trace': {
      const rec = args.runId ? await getTrace(String(args.runId)) : (await listTraces())[0];
      if (!rec) return { ok: true, result: '暂无运行轨迹。' };
      const lines = (rec.entries || []).map((e) => {
        const t = new Date(e.ts).toLocaleTimeString('zh-CN');
        if (e.phase === 'tool') return t + ' [tool] ' + e.name + ' ' + (e.ok ? '✓' : '✗') + ' ' + (e.ms || 0) + 'ms ' + (e.args || '');
        if (e.phase === 'start') return t + ' [start] intent=' + e.intent + ' ' + (e.instruction || '');
        if (e.phase === 'complete') return t + ' [complete] ' + (e.reason || '') + ' tokens=' + (e.totalTokens || 0);
        if (e.phase === 'timeout') return t + ' [timeout] ' + (e.reason || '');
        if (e.phase === 'error') return t + ' [error] ' + (e.error || '');
        return t + ' [' + e.phase + ']';
      });
      return { ok: true, result: '运行轨迹 ' + rec.runId + '（' + lines.length + ' 条）：\n' + lines.join('\n') };
    }
    default:
      return { result: '未知工具：' + name };
  }
}

export function parseToolArgs(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return {};
  }
}

// 限制读取体积，避免大页面撑爆内存（最多 maxBytes，超出即截断并 cancel）
// ---- web_search：DuckDuckGo / Bing 结果解析（无需 API Key，host_permissions 已含 <all_urls>）----
function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ').replace(/&emsp;/g, ' ').replace(/&middot;/g, '·').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch (e) { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ''; } })
    .replace(/\s+/g, ' ')
    .trim();
}

// 从 HTML 源码里提取 <title> 文本（去标签、解实体、限长）。
function extractHtmlTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]).slice(0, 120) : '';
}

// 还原搜索引擎重定向链接为真实 URL（DuckDuckGo uddg 参数 / Bing u=base64url）。
function resolveSearchUrl(href, engine) {
  try {
    if (engine === 'ddg') {
      const u = new URL(href, 'https://duckduckgo.com');
      const target = u.searchParams.get('uddg');
      if (target && /^https?:\/\//i.test(target)) return target;
    } else if (engine === 'bing') {
      const u = new URL(href, 'https://www.bing.com');
      const enc = u.searchParams.get('u');
      if (enc) {
        let b64 = enc.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const decoded = decodeURIComponent(new TextDecoder().decode(bytes));
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
  } catch (e) {}
  return href;
}

function parseSearchResults(html, engine) {
  const out = [];
  const maxLen = 10;
  if (engine === 'ddg') {
    const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < maxLen) {
      const snip = html.slice(m.index, m.index + 3000).match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      out.push({
        title: stripTags(m[2]).slice(0, 120),
        url: resolveSearchUrl(m[1], 'ddg'),
        snippet: (snip ? stripTags(snip[1]) : '').slice(0, 200),
      });
    }
  } else if (engine === 'bing') {
    const re = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < maxLen) {
      const block = m[1];
      const a = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (a) {
        out.push({
          title: stripTags(a[2]).slice(0, 120),
          url: resolveSearchUrl(a[1], 'bing'),
          snippet: (p ? stripTags(p[1]) : '').slice(0, 200),
        });
      }
    }
  }
  return out;
}

async function searchWeb(query, maxResults = 6) {
  const q = encodeURIComponent(query);
  // 注意：本工具会被 withTimeout(toolTimeoutMs=15s) 包裹，各引擎超时必须加起来 < 15s。
  // Bing 优先（实测可用），DuckDuckGo 兜底；都带浏览器 UA，避免被当作无头请求拦截。
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
  const engines = [
    { name: 'bing', url: 'https://www.bing.com/search?q=' + q + '&setlang=zh-hans', timeout: 7000 },
    { name: 'ddg', url: 'https://html.duckduckgo.com/html/?q=' + q, timeout: 6000 },
  ];
  for (const engine of engines) {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), engine.timeout) : null;
      const resp = await fetch(engine.url, { method: 'GET', redirect: 'follow', headers, signal: ctrl ? ctrl.signal : undefined });
      if (timer) clearTimeout(timer);
      if (!resp.ok) continue;
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const buf = await readBounded(resp.body, 1.5 * 1024 * 1024);
      const raw = decodeBuffer(ct).decode(buf);
      const results = parseSearchResults(raw, engine.name);
      if (results.length) return results.slice(0, maxResults);
    } catch (e) {
      // 尝试下一个引擎
    }
  }
  return [];
}

async function readBounded(body, maxBytes) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      total = maxBytes;
      try {
        await reader.cancel();
      } catch (e) {}
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function decodeBuffer(buf, contentType) {
  const charset = ((contentType || '').match(/charset=([\w-]+)/i) || [])[1];
  try {
    return new TextDecoder((charset || 'utf-8').trim().toLowerCase());
  } catch (e) {
    return new TextDecoder('utf-8');
  }
}

export function splitIntoChunks(text, size, max) {
  const s = String(text || '').trim();
  if (!s) return [];
  const paras = s.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return [s.slice(0, size)];

  const chunks = [];
  let buf = '';
  const push = (str) => {
    const t = str.replace(/\n+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    if (!t || chunks.length >= max) return;
    if (t.length > size * 1.5) {
      const parts = t.match(new RegExp('.{1,' + size + '}', 'g')) || [t];
      for (const pt of parts) {
        if (chunks.length >= max) break;
        chunks.push(pt.trim());
      }
    } else {
      chunks.push(t);
    }
  };

  for (const p of paras) {
    const candidate = buf ? buf + '\n\n' + p : p;
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

export function stripHtml(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  // 块级标签转为换行，保留段落结构
  s = s.replace(/<(br|p|div|li|tr|h[1-6]|section|article)[\s\/>]/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  // 常见 HTML 实体
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, ' ');
  s = s.replace(/[ \t]+/g, ' ').replace(/[ \r]+/g, '').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

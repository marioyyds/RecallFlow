// 工具定义（OpenAI / DeepSeek function-calling 格式）与内置工具执行
// 后台以工具调用循环（agent loop）驱动：模型决定调用哪些工具，
// 后台执行真实操作（检索/增删知识库），再把结果喂回模型，直到产出最终回复。
import { STATUS, STAR_LEVELS } from '../shared/constants.js';
import { typeInfo, formatVisibilityReport, formatCurrentPageResult, trimElementsToBudget, isCspEvalBlockError, screenshotAttempts, formatScreenshotSummary } from '../shared/utils.js';
import { getBook, upsertItem, deleteItem } from '../shared/store.js';
import { buildRagContext, buildCitations } from '../shared/rag.js';
import { listScripts as listUserscripts, searchScripts, installFromUrl, runUserscriptOnTab } from '../userscript/manager.js';
import { getUserscriptSettings } from '../userscript/settings.js';
import { getMergedSkills, addUserSkill, updateUserSkill, getUserSkills, getDefaultSkills } from './skill-store.js';
import { mdToSkill } from './skill-md.js';
import * as cdp from '../backend/cdp.js';
// 截断/切片一律走 sliceSafe：切裂代理对（星形平面字符）会让请求体在服务端解析阶段被整单拒收。
import { sliceSafe } from '../shared/surrogates.js';
import { rememberElement } from './site-memory.js';
import { saveMacro, listMacros, getMacro, bumpMacroHits, rememberTrace, recallTrace } from './macro-store.js';
import { handleDialog, getPendingDialogs, getDownloads } from './target-manager.js';
import { getTrace, listTraces } from './trace.js';
import { TOOL_SCHEMAS } from './tool-schemas.js';
import { TOOL_METADATA } from './tool-metadata.js';
import { sendTabMessageWithInjection } from '../shared/content-script-bridge.js';
import { stripHtmlTags as stripTags, extractHtmlTitle, readBounded, decodeBuffer, searchWeb, isAbortLikeError, describeFetchError, citationTitleFor } from './net-parse.js';
// 页面动作的验证字段：从本模块抽出后在这里再导出（见文件的 export {...} from）。
import { buildActionVerification, observedChange, verifyPageAction, snapshotChanged } from './page-action-verify.js';
// 这三个也随 net-parse 搬出，再导出以保持既有导入路径可用。
export { isAbortLikeError, describeFetchError, citationTitleFor };
// 跨域框架的 ref 解析与分批：同上，再导出以保持既有导入路径（tests/frame-routing.test.mjs 用它）。
import { parseRef, frameIdFromArgs, localTargetArgs, planFrameBatches } from './target-frame.js';
export { planFrameBatches };
// 工具结果装配与摘要：同上，再导出以保持既有导入路径
//（tests/extension-collectors.test.mjs 等使用 compactSnapshotSummary）。
import { summarizeCdpError, toolError, compactSnapshotSummary } from './tool-results.js';
export { compactSnapshotSummary };
// C-4 合并：诊断三件套收敛为 read_diagnostics(kind)。
import { readDiagnostics } from './diagnostics.js';
// C-4 合并：宏三件套收敛为 macro(op)。REPLAYABLE_TOOLS 的唯一来源也在这里。
import { macroTool, REPLAYABLE_TOOLS } from './macros.js';
// C-4 合并：知识库只读三件套收敛为 knowledge_read(op)（写/删保持独立，理由见该文件头）。
import { knowledgeRead } from './knowledge.js';
// C-1 拆分：标签页族（list_tabs / switch_tab / open_tab）移到独立模块，闭包依赖改为显式注入。
import { handleTabTool } from './tab-tools.js';
// C-1 拆分：运行状态族（update_plan / expand_result / get_run_trace）。
import { handleRunStateTool } from './run-state-tools.js';
// C-1 拆分：权限/会话状态族（trust_site / handle_dialog）—— 它们改的是"放行规则与待决状态"。
import { handlePermissionTool } from './permission-tools.js';
// C-1 拆分：截图单工具族（唯一走 CDP 的重型读操作）。
import { takeScreenshot, saveScreenshot } from './screenshot-tool.js';
// C-1 拆分：页面输入命令族（type_text / press_key / select_option / check_box / wait_for_element / get_attribute）。
import { handlePageInputTool } from './page-input-tools.js';
// C-1 拆分：联网抓取与搜索族（fetch_webpage / web_search）—— 与 ./net-parse.js 是邻居。
import { handleFetchTool } from './fetch-tools.js';
// C-1 拆分：CDP 输入族（click_element / click_at / hover_element / drag_element / upload_file）。
import { handleCdpInputTool } from './cdp-input-tools.js';
// C-1 拆分：页面读取族（read_current_page / get_page_snapshot / list_frames）—— Agent 的"眼睛"。
import { handlePageReadTool } from './page-read-tools.js';
// C-1 拆分：用户脚本族（list / search / install / run）—— 安装受用户设置约束。
import { handleUserscriptTool } from './userscript-tools.js';
// C-1 拆分：技能族（load_skill / install_skill）。
import { handleSkillTool } from './skill-tools.js';
// C-1 拆分：页面内代码与结构访问族（run_javascript / get_ax_snapshot）。
import { handleCodeAccessTool } from './code-access-tools.js';
// C-1 拆分：页面命令（内容脚本）族（annotate / inspect_element / scroll_page / get_element_source / undo_last_action）。
import { handlePageCommandTool } from './page-command-tools.js';
// C-1 拆分：知识库存储族（knowledge_read / add_entry / remove_entry）。
import { handleKnowledgeStoreTool } from './knowledge-store-tools.js';

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
//
// 知识库那三件套是**合并**而非单纯改名（`search_knowledge_base` / `list_knowledge_base` / `get_entry`
// → `knowledge_read({op})`，见 lib/assistant/knowledge.js 的搬运说明）。合并后旧名照样会被
// `validateSkillTools` 判为"不是可用工具"，警告里给不出迁移方向 —— 而内置技能里就曾有一份
// 写着旧名的文案（`clip-to-knowledge`，已修）⇒ 把它也收进本表，警告才能指向真正的入口。
export const TOOL_RENAME_MAP = Object.freeze({
  scroll_to_element: 'scroll_page',
  search_knowledge_base: 'knowledge_read',
  list_knowledge_base: 'knowledge_read',
  get_entry: 'knowledge_read',
});

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
// `required` 检查把空字符串也算作「缺失」（`args[key] === ''`），这对大多数参数合理，
// 但会误伤「空字符串本身就是合法取值」的字段：type_text 传 value:'' 正是
// 「清空输入框」这一合法意图（配合 clearFirst:true）。
// 这里显式列举允许空字符串的 (工具, 字段) 组合，而不是放宽全局规则 ——
// 全局放宽会让别的工具的必填校验悄悄失效。
const EMPTY_STRING_ALLOWED = new Set(['type_text.value']);

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
  const missing = required.filter((key) => {
    const v = args[key];
    if (v === undefined || v === null) return true;
    // 空字符串：默认视为缺失，除非该字段被显式允许为空。
    if (v === '') return !EMPTY_STRING_ALLOWED.has(name + '.' + key);
    return false;
  });
  return missing.length
    ? { ok: false, error: '工具「' + name + '」缺少必填参数：' + missing.join('、') }
    : { ok: true };
}

// 页面动作的「验证字段」装配（纯函数，便于直测）。
//
// 为什么需要它：CDP 路径原先**硬编码** `hadEffect:true, verified:true, changed:true`，
// 而同一条返回里又可能带一个 changed:false 的 verification（自相矛盾）。
// 这些字段不是给人看的装饰 —— agent.js 的 toolResultProgress / 卡死检测 / 完成校验
// 都靠它们判断「这一步有没有产生可观察进展」。谎报 true 会让卡死检测永远认为在推进。
//
// 语义对齐（与 executePageTool 的既有契约一致）：
//   executed  动作已派发（不表示产生了页面变化）
//   changed   是否观测到页面变化
//   verified  这个结论是否被真实观测支持过
//
// `observed` 三态：
//   'changed'     观测到前后指纹不同 → changed:true
//   'unchanged'   观测到前后指纹相同 → changed:false（诚实报告"没变化"）
//   'unobservable' 无法观测（如 hover 只改 CSS 伪类，不产生 DOM 变更）→ verified:false
// 页面动作的验证字段装配已移到 ./page-action-verify.js（见该文件的抽取说明）。
// 这里**再导出**，让既有的 `import { ... } from './tools.js'` 无需改动；
// 新代码建议直接从 page-action-verify.js 导入。
export { buildActionVerification, observedChange, verifyPageAction, snapshotChanged } from './page-action-verify.js';

// 向指定标签页（可选指定 frameId，用于跨域 iframe）发送消息。
function sendTabMessage(tabId, message, frameId) {
  // 默认发往顶层框架（frameId=0）；否则无 frameId 时消息会广播到所有框架，
  // 响应可能来自子框架，导致顶层快照/命令错乱。
  // 目标框架没有内容脚本时，桥接层会补注入 content.js 并重试一次。
  return sendTabMessageWithInjection(chrome, tabId, message, frameId);
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

// planFrameBatches 已移到 ./target-frame.js（并在文件顶部再导出）。

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

// parseRef / frameIdFromArgs / localTargetArgs 已移到 ./target-frame.js（并在文件顶部再导出）。

// CDP（chrome.debugger）是否可用于本次任务。
function cdpAllowed(ctx) {
  return Boolean(ctx && ctx.settings && ctx.settings.cdpEnabled !== false && cdp.isCdpAvailable());
}

// ---- 截图归档 ----
// 已随截图族一起移到 ./screenshot-tool.js（含 SHOT_KEY / MAX_SHOTS / MAX_SHOT_B64 /
// MAX_SHOT_STORE_CHARS 与 saveScreenshot）。**不要在这里再留一份上限常量** ——
// 两份真值会漂移，而漂移的表现是"某张图莫名没归档"。

// 在页面主世界执行 JS（经 CDP）。CDP 的 Runtime.evaluate 不受页面 CSP 约束，
// 因此它既是 engine:'page' 的实现，也是「沙箱被 CSP 阻止」时的兜底路径。
/**
 * 页面主世界表达式：始终包进 async IIFE。
 *
 * `Runtime.evaluate` 支持 awaitPromise，但表达式本身必须返回 Promise。
 * 以前的同步 IIFE 让 `await` 直接变成语法错误（实测小红书会话）。
 * 同时保留 `return` 语义：用户代码里的 return 返回给 async IIFE。
 */
export function buildPageWorldExpression(code) {
  return '(async () => {\n' + String(code === undefined || code === null ? '' : code) + '\n})()';
}

async function evaluateInPageWorld(ctx, args) {
  if (!cdpAllowed(ctx)) return { ok: false, result: '页面世界执行需要 CDP（请在设置中开启）。' };
  try {
    const jsFrame = frameIdFromArgs(args);
    const expr = buildPageWorldExpression(args && args.code);
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
    // run_javascript 的返回值是**页面里的原始 JSON**，星形平面字符（数学/表情）密度可以很高，
    // 直接 slice 会把代理对切裂（见 surrogates.js 的事故说明）。
    if (serialized.length > 2000) serialized = sliceSafe(serialized, 0, 2000) + '\n…（结果过长已截断）';
    return { ok: true, cdp: true, result: serialized };
  } catch (e) {
    return { ok: false, result: '页面世界执行失败：' + summarizeCdpError(e) };
  }
}

// listFramesRaw 与 prefixFrameRefs 已随页面读取族移到 ./page-read-tools.js。

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

// summarizeCdpError 已移到 ./tool-results.js（并在文件顶部再导出）。

// toolError 已移到 ./tool-results.js（并在文件顶部再导出）。

// 把成功定位的元素记入站点记忆（供后续任务直接复用选择器）。
function rememberTarget(ctx, target) {
  if (!ctx || !ctx.settings || ctx.settings.siteMemoryEnabled === false) return;
  if (!target || !target.selector) return;
  rememberElement(ctx.pageUrl, target).catch(() => {});
}

// 可重放的动作（会进入宏轨迹）；用响应里的稳定 selector 替代易失的 ref。
// 定义在 ./macros.js（**唯一来源**）：记录时（recordTraceStep）与回放时（macro op=run）
// 必须用同一份白名单 —— 两处各写一份就会漂移，而漂移的后果是回放能执行记录时不允许的工具。

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
    if (name === 'type_text') {
      // 记录时写入规范化后的形状：selector（定位）+ value（负载）。
      // `a.text` 只作为旧记录的兼容回退 —— 新记录的 a.text 是定位用的文本片段，
      // 若把它当负载写进宏，回放时会输入错误的字符串。
      const payload = a.value !== undefined ? a.value : (a.text !== undefined ? a.text : '');
      step = { tool: name, args: Object.assign({ selector, value: payload }, a.clearFirst ? { clearFirst: true } : {}) };
    }
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
  if (step) {
    ctx.trace.push(step);
    // 顺手把本轮的**可重放轨迹**按站点暂存一份：宏的沉淀动作常常发生在**下一轮**
    //（实测 RF-FY6PUP：「沉淀为技能」是在发布流程跑完的下一轮才说的），
    // 而 ctx.trace 只活在本次运行里。写入时机与代价见 macro-store.js 的说明。
    rememberTrace(ctx.pageUrl, ctx.trace).catch(() => {});
  }
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

// verifyPageAction 已移到 ./page-action-verify.js（并在文件顶部再导出）。


// compactSnapshotSummary 已移到 ./tool-results.js（并在文件顶部再导出）。

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
    : // 未做观测就不声称已验证（原实现写 verified:true + changed:false，语义矛盾）。
      buildActionVerification('unobservable', '未做页面变化观测');
  return {
    ...response,
    ok: true,
    hadEffect: Boolean(verification.changed),
    result: (response.result || ('已执行页面动作：' + action)) + (shouldVerify ? '\n验证：' + verification.reason : ''),
    verification,
    pageSnapshot: after,
  };
}

// ANNOTATE_OPS 已移到 ./page-command-tools.js（唯一来源）。

// INSPECT_OPS 已移到 ./page-command-tools.js（唯一来源）。

// 独立页面工具 → 底层页面命令的映射（拆分后每个工具只负责一个动作）。
function pageToolCommand(name) {
  const map = {
    click_element: 'click',
  };
  return map[name] || name;
}

// snapshotChanged 已移到 ./page-action-verify.js（并在文件顶部再导出）。


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
              // 同下面主返回：`selector` 必须转发（宏记录要靠它定位目标）
              selector: (res && res.selector) || '',
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
    // 视觉标注类命令（highlight / outline / clear_highlights）刻意**不做前后快照验证**：
    // 它们的效果是往独立的浮层宿主里加节点，而页面指纹明确排除了标注层
    //（否则「同一个动作前后指纹不同只因省略了几个」会造成假变化）。
    // 因此这里如实标注 verified:false —— 原实现写 verified:true + changed:false，
    // 等于声称「已验证」而实际什么都没验证，与 B-1 正在修的那类谎言同源。
    const verification = shouldVerify
      ? verifyPageAction(command, before, after, res)
      : buildActionVerification(
          'unobservable',
          '读取类命令无需页面变化验证'
        );
    // 视觉标注的「做了几处 / 找到了几处」在 res 里（hit / attempted / requested / misses）。
    // 它只被拼进 result 文本 —— 模型的可见信息在文本里，因此这里不再另造结构化字段
    //（造了也没有消费者，见 docs/tool-design.md §6 的 data 约定）。
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
      selector: (res && res.selector) || '',
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
      const description = sliceSafe((hit.description_zh || hit.description || summary || '').toString(), 0, 300);
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
    // 超时要与真正的安装失败分开说：前者是网络/服务慢，重试可能就成了；
    // 后者是技能本身或数据的问题。原先一律说「安装失败：<原始 abort 文案>」，
    // 模型会以为技能有问题而放弃 —— 实测（会话 RF-V6T7C5）就是这么被报成缺陷的。
    if (isAbortLikeError(e)) {
      return {
        ok: false,
        result:
          'SkillHub 请求超时（15 秒内没有响应）。这通常是网络或 SkillHub 服务慢，**不是这条技能本身有问题**；' +
          '稍后可以重试，或改用 load_skill 加载已安装的技能。',
      };
    }
    return { ok: false, result: '安装失败：' + (e && e.message ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

// isAbortLikeError / describeFetchError / citationTitleFor 已移到 ./net-parse.js（并在文件顶部再导出）。

// ---- 工具分派注册表（C-1 的终点）----
//
// 为什么是注册表而不是 switch：switch 有三类错误能**悄悄**溜过去，
// 而本轮收尾时这三类**全都真实发生过**（一次脚本化的批量搬运把它们同时引入）：
//   1. **漏写 case**：工具在 TOOL_REGISTRY 里存在，但 switch 里没有分支 → 静默落到 default「未知工具」；
//      实测 `expand_result` / `get_run_trace` 就漏了 case（靠 handleRunStateTool 按 name 兜住才没爆）。
//   2. **重复 case**：后一个分支永远覆盖前一个 → 同一工具名有两个实现，谁生效看不出来。
//   3. **漏写 return**：调用了 handler 但结果被丢弃、继续往下执行 →
//      实测 `complete_task` 会掉进 `load_skill` 去装技能。
//
// 注册表把这三类变成**不可能**：
//   · 重名 → **模块加载时直接抛错**（不是运行到那一步才发现）；
//   · 漏分支 → tests/final-families.test.mjs 断言「注册表 == TOOL_REGISTRY」；
//   · 漏 return → handler 是**被 return 调用**的，没有"调用了却没返回"的写法。
const TOOL_HANDLERS = new Map();

/**
 * 注册一族工具。
 *
 * 重名是**编程错误**，没有合理回退可退 —— 与其在运行时静默走错分支，不如加载时立刻炸出来。
 */
function registerHandlers(names, run) {
  for (const n of names) {
    if (TOOL_HANDLERS.has(n)) {
      throw new Error('工具重复注册：' + n + '（同一工具名有两个 handler，分派有歧义）');
    }
    TOOL_HANDLERS.set(n, run);
  }
}

// —— 知识库存储族（只读 / 写 / 删是三类权限，刻意各自独立，见 ./knowledge-store-tools.js 头注释）
registerHandlers(['knowledge_read', 'add_entry', 'remove_entry'], (name, args, ctx) =>
  handleKnowledgeStoreTool(name, args, {
    ctx,
    knowledgeRead,
    upsertItem,
    deleteItem,
    getBook,
    buildRagContext,
    buildCitations,
    typeInfo,
    STAR_LEVELS,
    STATUS,
  }));

// —— 页面读取族（Agent 的"眼睛"）
registerHandlers(['read_current_page', 'get_page_snapshot', 'list_frames'], (name, args, ctx) =>
  handlePageReadTool(name, args, {
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
    citationTitleFor,
  }));

// —— 诊断（C-4 第 3 档合并：read_console / read_network / list_downloads → read_diagnostics）
registerHandlers(['read_diagnostics'], (name, args, ctx) =>
  readDiagnostics({ sendTabMessage, tabId: ctx.tabId, getDownloads }, args));

// —— 页面输入命令族
registerHandlers(['type_text', 'press_key', 'select_option', 'check_box', 'wait_for_element', 'get_attribute'], (name, args, ctx) =>
  handlePageInputTool(name, args, {
    ctx,
    cdp,
    cdpAllowed,
    executeContentAction,
    frameIdFromArgs,
    resolveTarget,
    rememberTarget,
    getPageSnapshot,
    observedChange,
    buildActionVerification,
    compactSnapshotSummary,
    summarizeCdpError,
  }));

// —— 标签页族
registerHandlers(['list_tabs', 'switch_tab', 'open_tab'], (name, args, ctx) =>
  handleTabTool(name, args, {
    chrome,
    ctx,
    waitForTabReady,
    bindSessionTab,
    listOpenedTabsSummary,
    trackOpenedTab,
    ensureAgentWindow,
  }));

// —— 联网抓取与搜索族
registerHandlers(['fetch_webpage', 'web_search'], (name, args, ctx) =>
  handleFetchTool(name, args, {
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
    describeFetchError,
  }));

// —— CDP 输入族
// ⚠ click_element 的"只在内容脚本**报错**时升级 CDP"是**有意保留**的决定，见 ./cdp-input-tools.js 头注释。
registerHandlers(['click_element', 'click_at', 'hover_element', 'drag_element', 'upload_file'], (name, args, ctx) =>
  handleCdpInputTool(name, args, {
    ctx,
    cdp,
    cdpAllowed,
    executePageTool,
    frameIdFromArgs,
    resolveTarget,
    rememberTarget,
    getPageSnapshot,
    observedChange,
    buildActionVerification,
    compactSnapshotSummary,
    summarizeCdpError,
  }));

// —— 页面命令（内容脚本）族
// 注意：同属一族 ≠ 可以合并成一个工具。面向模型的边界由 C-4 判据决定
//（执行路径 + 权限类别），见 ./page-command-tools.js 头注释。
registerHandlers(['annotate', 'inspect_element', 'scroll_page', 'get_element_source', 'undo_last_action'], (name, args, ctx) =>
  handlePageCommandTool(name, args, { ctx, toolError, executePageTool, executeContentAction, sendTabMessage }));

// —— 截图（单工具族）
registerHandlers(['take_screenshot'], (name, args, ctx) =>
  takeScreenshot({
    ctx,
    args,
    cdp,
    cdpAllowed,
    screenshotAttempts,
    saveScreenshot,
    // 归档函数现在需要注入 chrome（它已随截图族移到 ./screenshot-tool.js）。
    // 漏传的后果是**静默不落盘**：返回仍 ok:true，但图片永远取不回来。
    chrome,
    formatScreenshotSummary,
  }));

// —— 页面内代码与结构访问族
registerHandlers(['run_javascript', 'get_ax_snapshot'], (name, args, ctx) =>
  handleCodeAccessTool(name, args, { ctx, cdp, cdpAllowed, executeContentAction, evaluateInPageWorld, isCspEvalBlockError, summarizeCdpError }));

// —— 用户脚本族（安装受用户设置约束）
registerHandlers(['list_userscripts', 'search_userscripts', 'install_userscript', 'run_userscript'], (name, args, ctx) =>
  handleUserscriptTool(name, args, {
    ctx,
    listUserscripts,
    searchScripts,
    installFromUrl,
    runUserscriptOnTab,
    getUserscriptSettings,
  }));

// —— 技能族
// save_skill 是**写**操作（它写的正文会进入今后的系统提示）⇒ 自己的审批闸门，
// 因此它是独立工具，而不是并入 `skill({op})` —— 见 docs/tool-merge-plan.md 第 6 档的结论：
// `toolNeedsApproval(name, settings, pageUrl)` 拿不到 args，按 op 分级审批在当前架构下表达不了。
registerHandlers(['load_skill', 'install_skill', 'save_skill'], (name, args, ctx) =>
  handleSkillTool(name, args, {
    getMergedSkills,
    getDefaultSkills,
    getUserSkills,
    addUserSkill,
    updateUserSkill,
    validateSkillTools,
    installSkillFromSkillHub,
  }));

// —— 宏（C-4 第 5 档合并）
// **op=run 的执行期白名单与 op=save 的审批必须分别保留**（见 ./macros.js 文件头注释）。
registerHandlers(['macro'], (name, args, ctx) =>
  macroTool(
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
      validateToolCall,
    },
    args
  ));

// —— 权限 / 会话状态族（改的是"放行规则与待决状态"，不是页面）
registerHandlers(['trust_site', 'handle_dialog'], (name, args, ctx) =>
  handlePermissionTool(name, args, { ctx, chrome, cdpAllowed, handleDialog, summarizeCdpError }));

// —— 运行状态族
// 三个工具名都要**显式列出**：只写 update_plan 也能跑（handleRunStateTool 会按 name 分派），
// 但那样注册表就不等于 TOOL_REGISTRY，门禁无法核对。
registerHandlers(['update_plan', 'expand_result', 'get_run_trace'], (name, args, ctx) =>
  handleRunStateTool(name, args, { ctx, getTrace, listTraces }));

// —— 完成信号
// agent.js 识别返回里的 complete:true 来结束本轮。单独注册，避免被误并入别的族。
registerHandlers(['complete_task'], (name, args) => ({
  result: '任务已完成：' + String(args.summary || '任务完成。') + (args.evidence ? '\n证据：' + String(args.evidence) : ''),
  complete: true,
}));

/**
 * 执行一个工具调用。
 *
 * 这里只做三件事：补齐 args、查表、交给该族的 handler。**没有任何工具逻辑**。
 */
export async function executeTool(name, args, ctx) {
  args = args || {};
  const run = TOOL_HANDLERS.get(name);
  // 未知工具同样要 `ok:false`：它是**失败**，不是"调用成功但内容是这样"。
  // 漏掉它会让下游（失败摘除 / 卡死检测 / 完成校验 / 模型自我纠错）以为这次调用是好的。
  if (!run) return { ok: false, result: '未知工具：' + name };
  return await run(name, args, ctx);
}

/**
 * 注册表里实际可用的工具名。
 *
 * 供门禁核对「分派注册表 == TOOL_REGISTRY」—— 两边必须严格相等：
 * 注册表多一个、少一个，都意味着某个工具调用会静默走错或落到「未知工具」。
 */
export function registeredToolNames() {
  return [...TOOL_HANDLERS.keys()];
}

export function parseToolArgs(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return {};
  }
}

// ---- web_search：DuckDuckGo / Bing 结果解析（无需 API Key，host_permissions 已含 <all_urls>）----
// web_search 的结果解析、正文抓取与解码已移到 ./net-parse.js（见该文件的搬运说明）：
// stripHtmlTags / extractHtmlTitle / resolveSearchUrl / parseSearchResults / readBounded /
// decodeBuffer / searchWeb。

/**
 * HTML 数字实体 → 字符。
 *
 * 用 fromCodePoint 而不是 fromCharCode：后者只认 16 位，`&#x1D466;`（𝑦）这类
 * 星形平面码点会被截成**孤立代理**直接写进正文 —— 与"按下标切片切裂代理对"
 * 是同一类问题的两个来源（都会让请求体在服务端解析阶段被整单拒收）。
 * 非法码点（NaN、负数、超过 0x10FFFF、落在代理区）一律给 U+FFFD：
 * 宁可显示"这里有个表示不出来的字符"，也不要产生半个字符。
 */
function decodeNumericEntity(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '\uFFFD';
  if (code >= 0xd800 && code <= 0xdfff) return '\uFFFD';
  try {
    return String.fromCodePoint(code);
  } catch (e) {
    return '\uFFFD';
  }
}

export function splitIntoChunks(text, size, max) {
  const s = String(text || '').trim();
  if (!s) return [];
  const paras = s.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return [sliceSafe(s, 0, size)];

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
  // 块级标签**整段**替换为换行。
  //
  // 这里踩过一个影响所有抓取的坑：原写法 `/<(br|p|div|li|…)[\s\/>]/` 只吃掉标签的**开头**，
  // 于是 `<div style="…">` 变成换行 + `style="…">`，**属性全部留成了「正文」**；
  // 而下一行的 `/<[^>]+>/g` 已经匹配不到（`<` 被吃掉了）。
  // 实测后果：抓 GitHub 页面得到 `style="min-height:101vh"> data-component="Stack"class="…"`
  // 这样的属性汤，却因为字符数够多而被当成抓取**成功**上报（`✓`）—— 失败是静默的。
  // 真实网站几乎没有不带属性的块级标签，所以这条必须吃掉整个标签。
  s = s.replace(/<\/?(?:br|p|div|li|tr|h[1-6]|section|article)\b[^>]*>/gi, '\n');
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
    // 数字实体必须用 fromCodePoint：`&#x1D466;`（𝑦）是星形平面码点，
    // fromCharCode 只吃 16 位，会把它截成**孤立代理**直接写进正文
    //（和"按下标切片切裂代理对"是同一类问题的第二个来源，见 surrogates.js）。
    .replace(/&#(\d+);/g, (m, n) => decodeNumericEntity(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => decodeNumericEntity(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, ' ');
  s = s.replace(/[ \t]+/g, ' ').replace(/[ \r]+/g, '').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

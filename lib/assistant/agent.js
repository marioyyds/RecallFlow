// Agent 编排：流式对话 + 工具审批 + 工具调用循环
import { getToolMetadata, parseToolArgs, validateToolCall, TOOL_REGISTRY, closeAgentWindow, recordTraceStep, compactSnapshotSummary } from './tools.js';
import { collectAgentTools, executeAnyTool } from './mcp.js';
import { isRetryableError } from './llm.js';
import { createRun, transition, RUN_STATUS, TOOL_STATUS } from './agent-state.js';
import { loadAgentSession, saveAgentSession, removeAgentSession } from './session-store.js';
import { createToolGuard } from './tool-guard.js';
import { detectIntent, resolveIntent, resolveIntentForAgent, buildSystemPrompt, INTENT_TURN_DEFAULTS, INTENTS } from './intent-router.js';
import { getMergedSkills } from './skills.js';
import { detachAll as detachAllCdp } from '../backend/cdp.js';
import { getSiteHints } from './site-memory.js';
import { listMacros } from './macro-store.js';
import { collapseOldToolResults, estimateMessagesTokens, estimateTokens, normalizeHistory } from './context.js';
import { appendTrace } from './trace.js';
import { verifyCompletion, buildVerificationReflection, buildStuckReflection } from './verifier.js';
import { checkCompletionClaim, buildDeterministicReflection } from './claim-check.js';

export const AGENT_BUDGET_DEFAULTS = Object.freeze({
  // 预算对齐 opencode：默认是「高上限兜底」而非「正常态硬墙」。
  // 正常结束靠 complete_task / 最终回答 / 用户中断，卡死靠 stuck detector，
  // 预算只在真正失控时兜底，避免正常的多步任务（尤其浏览器研究）半路被掐断。
  maxModelTurns: 30,
  maxToolCalls: 40,
  // 同一工具（按名称+参数指纹）重复调用上限；只读观察工具放宽。
  maxSameToolCalls: 4,
  readOnlySameToolCalls: 8,
  // 同一工具连续失败达到该次数即摘除；只读工具放宽。
  toolFailStreak: 2,
  readOnlyFailStreak: 3,
  maxOpenedTabs: 6,
  stuckWindow: 8,
  stuckWarnThreshold: 3,
  stuckStopThreshold: 5,
  maxDurationMs: 180000,
  toolTimeoutMs: 15000,
  // token 总量上限（成本维度）。既有预算只管轮数/工具数/时长 —— 但「每轮都重发整段上下文」
  // 意味着成本随轮数近似二次增长，只卡轮数挡不住「少轮次但上下文巨大」的失控。
  // 取值沿用本文件的「高上限兜底而非正常态硬墙」原则：30 轮 × 数万 token 通常远低于此，
  // 只有真正的失控才会撞上。设为 0 表示不限制。
  // token 总量上限（成本维度）。注意 totalTokens 累加的是**每次请求的用量**，而每轮都要
  // 重发整段上下文，因此它本就超线性增长 —— 不能用「单轮用量」来估上限。
  // 按实测推导（estimateTokens：CJK 1 token/字）：browser_task 每轮光工具定义约 8.3k tokens，
  // 30 轮 ≈ 25 万；加上逐轮增长的消息与补全，一个跑满 30 轮的任务约 75 万，
  // 加上一次预算追加（40 轮）约 110 万。兜底取 6M ≈ 正常峰值的 5 倍：
  // 只有真正的失控才会撞上，正常任务不会被半路掐断。
  // 设为 0 表示不限制。
  maxTotalTokens: 6000000,
  // 完成前最多触发几次「独立校验未通过 → 反思重试」。
  maxVerifications: 2,
  // 按工具名的**累计**调用上限（与参数无关）。指纹去重只能发现「完全相同的调用」，
  // 而逃生舱类工具换个选择器就换个指纹 —— run_javascript 曾出现单次任务调用 40+ 次、
  // 把预算吞掉的情况。命中后只摘除该工具并注入反思（软着陆），不会掐断整个任务。
  maxCallsPerTool: { run_javascript: 15 },
  // 触顶自动追加：撞到轮数上限时自动再给一次额度，避免多步任务中途硬停、
  // 非要用户手动点「继续」才能往下走。设为 0 则退回旧的「触底收尾」行为。
  maxBudgetTopUps: 1,
  budgetTopUpTurns: 10,
});

// 预算弹性：即使意图被归为普通对话，一旦实际调用到「研究/网络类」工具，
// 就把预算放宽到资料研究级，避免「工具刚用起来就触顶」。只加不减，对已达标意图无影响。
const RESEARCH_TRIGGER_TOOLS = new Set([
  'fetch_webpage',
  'web_search',
  'open_tab',
  'switch_tab',
  'search_knowledge_base',
  'get_page_snapshot',
  'read_current_page',
  'click_element',
]);
const ESCALATED_BUDGET = Object.freeze({ maxToolCalls: 48, maxModelTurns: 32 });

// 运行时自纠：当普通对话（CHAT）任务实际调用到研究/网络类工具时，
// 把任务画像就地提升为「资料研究」——补齐全套浏览器/网络工具，并把系统提示规则
// 切换成 RESEARCH 的（含 complete_task 收尾），而不是只放宽预算。
// 导出以便单测：画像提升时必须保留追加的系统提示段，这一点很容易在重构中被破坏。
export function promoteToResearch(tools, messages, instruction, allSkills, promptExtras) {
  const researchInfo = resolveIntent(INTENTS.RESEARCH);
  for (const name of researchInfo.allowedTools) {
    if (tools.some((t) => t.function && t.function.name === name)) continue;
    const def = TOOL_REGISTRY.find((t) => t.name === name);
    if (def) tools.push(def.openai);
  }
  const names = tools.map((t) => t.function && t.function.name).filter(Boolean);
  const newPrompt = buildSystemPrompt(INTENTS.RESEARCH, instruction, names, allSkills);
  // 必须带上附加段（站点记忆 / 宏目录）：它们追加在基础系统提示之后，
  // 只按 buildSystemPrompt 重建会把它们静默丢掉 —— 而浏览器任务最需要它们。
  const content = promptExtras ? newPrompt + promptExtras : newPrompt;
  if (messages[0] && messages[0].role === 'system') messages[0] = { role: 'system', content };
}

function getBudget(payload = {}, settings = {}, intent) {
  const source = payload.agentBudget || settings.agentBudget || {};
  const budget = Object.fromEntries(Object.entries(AGENT_BUDGET_DEFAULTS).map(([key, value]) => {
    const n = Number(source[key]);
    return [key, Number.isFinite(n) && n > 0 ? Math.floor(n) : value];
  }));
  // 未显式配置推理轮数时，按意图给出更合理的预算：浏览器任务多给，纯对话少给。
  if (source.maxModelTurns === undefined || source.maxModelTurns === null || source.maxModelTurns === '') {
    budget.maxModelTurns = INTENT_TURN_DEFAULTS[intent] || AGENT_BUDGET_DEFAULTS.maxModelTurns;
  }
  // 未显式配置时，按意图动态分配工具调用与开新页预算，避免浏览器任务过早触顶。
  if (source.maxToolCalls === undefined || source.maxToolCalls === null || source.maxToolCalls === '') {
    budget.maxToolCalls = intent === INTENTS.BROWSER ? 60 : intent === INTENTS.RESEARCH ? 50 : intent === INTENTS.KNOWLEDGE ? 24 : 16;
  }
  if (source.maxOpenedTabs === undefined || source.maxOpenedTabs === null || source.maxOpenedTabs === '') {
    budget.maxOpenedTabs = intent === INTENTS.BROWSER ? 8 : intent === INTENTS.RESEARCH ? 6 : 4;
  }
  return budget;
}

/**
 * 是否已达到 token 成本上限（纯函数，便于直测边界语义）。
 * 0 / 负数 / 非数字表示不限制 —— 沿用「高上限兜底而非正常态硬墙」的既有原则。
 */
export function tokenBudgetExceeded(totalTokens, budget) {
  const cap = Number(budget && budget.maxTotalTokens);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const used = Number(totalTokens);
  if (!Number.isFinite(used) || used <= 0) return false;
  return used >= cap;
}

// 修正 tool 调用配对：OpenAI 兼容接口要求每个 tool 结果都有对应的 assistant.tool_calls，
// 且 assistant.tool_calls 的每个 id 都必须有结果。截断/中断可能破坏配对，
// 这里剔除「无 provider 的 tool 消息」与「结果不全的 assistant tool_calls 消息」。
export function sanitizeToolPairing(list) {
  const source = Array.isArray(list) ? list : [];
  const isCallAssistant = (m) => m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  let out = source;
  // 1) assistant 带 tool_calls，但并非每个 id 都有对应 tool 结果 → 整条去掉（否则请求非法）。
  let resultIds = new Set(out.filter((m) => m && m.role === 'tool' && m.tool_call_id).map((m) => m.tool_call_id));
  out = out.filter((m) => !isCallAssistant(m) || m.tool_calls.every((tc) => tc && resultIds.has(tc.id)));
  // 2) tool 结果没有对应的 assistant tool_calls（provider 被裁掉/剔除）→ 去掉孤儿结果。
  const providerIds = new Set();
  for (const m of out) if (isCallAssistant(m)) for (const tc of m.tool_calls) if (tc && tc.id) providerIds.add(tc.id);
  out = out.filter((m) => !(m && m.role === 'tool' && !providerIds.has(m.tool_call_id)));
  return out;
}

export function compactSessionMessages(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const system = source.find((message) => message && message.role === 'system');
  const tail = sanitizeToolPairing(source.filter((message) => message !== system).slice(-39));
  return (system ? [system, ...tail] : tail).map((message) => {
    const copy = { role: message.role };
    if (typeof message.content === 'string') copy.content = message.content.slice(-12000);
    else if (message.content !== undefined) copy.content = message.content;
    if (Array.isArray(message.tool_calls)) copy.tool_calls = message.tool_calls.slice(-8);
    if (message.tool_call_id) copy.tool_call_id = message.tool_call_id;
    return copy;
  });
}

function buildInitialMessages(instruction, selectedText, page, pageUrl, history, emit, systemPrompt, pickedElements) {
  const messages = [{ role: 'system', content: systemPrompt || '你是一个具备工具调用能力的浏览器 AI 助手（RecallFlow）。' }];
  let normalized = normalizeHistory(history, { maxMessages: 10, maxChars: 3000, maxTokens: 8000 });
  // 前端发送完整 conversation（含刚 push 的当前指令），去掉与当前指令重复的尾部 user 消息，
  // 避免指令在历史与本次输入里各出现一次。
  const instr = String(instruction || '').trim();
  if (instr && normalized.length && normalized[normalized.length - 1].role === 'user') {
    const last = normalized[normalized.length - 1].content.trim();
    if (last === instr || (last.length === 3000 && instr.startsWith(last))) normalized = normalized.slice(0, -1);
  }
  for (const h of normalized) {
    messages.push({ role: h.role, content: h.content });
  }
  const userParts = [];
  const picks = Array.isArray(pickedElements) ? pickedElements.filter(Boolean) : [];
  if (picks.length) {
    const blocks = picks.map((p, i) => {
      const src = p.source || {};
      const loc = src.file
        ? src.file + (src.line ? ':' + src.line + (src.column ? ':' + src.column : '') : '') + (src.framework ? '（' + src.framework + (src.component ? ' · ' + src.component : '') + '）' : '')
        : '';
      const l = p.locator || {};
      const head = picks.length > 1 ? '选取的元素 ' + (i + 1) + '（请针对它回答/操作）：' : '用户在页面上选取的元素（请针对它回答/操作）：';
      const lines = [head];
      if (l.role || l.name) lines.push('- 语义定位：' + (l.role ? 'role=' + l.role : '') + (l.name ? (l.role ? ' ' : '') + 'name="' + l.name + '"' : ''));
      if (l.testid) lines.push('- testid：' + l.testid);
      if (p.selector) lines.push('- CSS 选择器：' + p.selector);
      if (p.tag) lines.push('- 标签：' + p.tag);
      if (p.text) lines.push('- 文本：' + String(p.text).slice(0, 120));
      if (Array.isArray(p.ancestors) && p.ancestors.length) lines.push('- 祖先链：' + p.ancestors.join(' > '));
      if (p.inShadow) lines.push('- 位于 Shadow DOM 内');
      lines.push(loc ? '- 前端源码位置：' + loc : '- 未检测到框架源码位置（可能为生产构建）');
      return lines.join('\n');
    });
    userParts.push(blocks.join('\n\n'));
  }
  if (selectedText) userParts.push('选中的文本：\n' + selectedText);
  // 当前页面只作为背景上下文，不生成带编号的引用——否则会占掉全局引用编号
  // （导致外部文档的引用从 [5] 之类的高序号开始）。真正可点击的「参考来源」只统计
  // Agent 实际 fetch / read 过的页面。
  if (page) {
    userParts.push('当前页面内容（作为背景上下文，不属于待引用来源）：\n' + page);
  }
  if (instruction) userParts.push('用户指令 / 问题：\n' + instruction);
  if (!userParts.length) userParts.push('（无输入）');
  messages.push({ role: 'user', content: userParts.join('\n\n') });
  return { messages, pageCitations: [] };
}

function withTimeout(task, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(value); } };
    const onAbort = () => finish(reject, new DOMException('任务已取消', 'AbortError'));
    const timer = setTimeout(() => finish(reject, new Error('工具执行超时（' + timeoutMs + 'ms）')), timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(task).then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}

// 只放行纯读取类工具。其余工具可能写入本地数据、改变浏览器状态、访问外部服务，
// 按 Cline 的交互模式交由前端取得用户明确批准后再执行。
export function toolNeedsApproval(name, settings = {}, pageUrl = '') {
  const meta = getToolMetadata(name);
  if (meta.requiresApproval !== true) return false;
  // 高风险工具（如 run_javascript）：默认进入审批流程；用户可在设置中选择「本任务内允许」或「自动批准」。
  // 注意：'session' 仍需弹一次审批，之后由会话级放行（sessionApprovedTools）跳过；'auto' 完全不弹。
  if (meta.alwaysRequireApproval === true) {
    const mode = settings.runJavascriptApproval || 'session';
    return mode !== 'auto';
  }
  // 站点信任：已信任站点的写操作不再逐次确认。
  if (pageUrl) {
    try {
      const origin = new URL(pageUrl).origin;
      const trusted = Array.isArray(settings.trustedSites) ? settings.trustedSites : [];
      if (origin && trusted.includes(origin)) return false;
    } catch (e) {}
  }
  const p = settings.toolApprovalPolicy || {};
  // risk → 审批类别的完整映射（见 docs/tool-design.md §9）。
  // 说明：16 个页面写操作工具标的是 risk:'page'，此前没有对应分支、全部落到默认的
  // 'commands'（正是 UI 里的「页面命令」类别），行为正确但完全依赖默认值兜底，
  // 后续调整默认值或新增风险等级时会静默错配。这里显式化。
  let category = 'commands';
  if (meta.risk === 'external') category = 'mcp';
  else if (meta.risk === 'browser' || meta.risk === 'network') category = 'browser';
  else if (meta.risk === 'write' || meta.risk === 'destructive') category = 'edit';
  else if (meta.risk === 'page') category = 'commands';
  return p[category] !== true;
}

// 工具结果是否产生“可观察进展”：新标签页绑定、页面内容/URL 变化、等待匹配成功等。
// 有进展时应重置重复工具计数，避免“新页面后的第一次快照”被误判为重复调用。
function toolResultProgress(res) {
  if (!res || typeof res !== 'object') return false;
  if (Number.isInteger(Number(res.targetTabId))) return true;
  if (res.hadEffect === true || res.matched === true || res.satisfied === true) return true;
  const v = res.verification;
  if (v && (v.changed || v.urlChanged || v.contentChanged || v.responseSatisfied)) return true;
  return false;
}

// 结果指纹变化：只读/网络工具有实质新产出（内容长度或首尾片段变化）也算进展，
// 修复 web_search / search_knowledge_base / read_current_page 等「字段不匹配」被误判无进展的问题。
// 仅在执行成功时参与，失败重试（错误文案各异）不误判为进展。
function resultProgressByChange(store, name, res) {
  if (!res || res.ok === false) return false;
  const text = typeof res.result === 'string' ? res.result : '';
  if (!text) return false;
  const fp =
    (Number.isInteger(Number(res.targetTabId)) ? Number(res.targetTabId) : '') +
    '|' + (res.url || '') + '|' + (res.title || '') + '|' + text.length +
    '|' + text.slice(0, 200) + text.slice(-200);
  const prev = store.get(name);
  store.set(name, fp);
  return prev !== undefined && prev !== fp;
}

// 是否需要「完成前独立校验」：仅对会操作页面的浏览器/研究类任务、且确实调用过工具时启用。
function shouldVerifyCompletion(intent, toolCallCount, settings) {
  if (!settings || settings.verifierEnabled === false) return false;
  if (!settings.apiKey) return false;
  if (!toolCallCount) return false;
  return intent === INTENTS.BROWSER || intent === INTENTS.RESEARCH;
}

// 用最近页面证据做一次独立校验，判断目标是否真的达成。
async function runCompletionVerification(settings, instruction, res, ctx, signal) {
  const evidenceParts = [];
  if (ctx.lastSnapshot) evidenceParts.push(compactSnapshotSummary(ctx.lastSnapshot));
  if (ctx.lastEvidence) evidenceParts.push(String(ctx.lastEvidence).slice(0, 2500));
  return verifyCompletion(
    settings,
    {
      instruction,
      claim: String((res && res.result) || ''),
      evidence: evidenceParts.join('\n'),
      pageUrl: ctx.pageUrl,
      pageTitle: ctx.pageTitle,
    },
    signal
  );
}

// 任务结束时清理 Agent 打开/接管的多余标签页：保留最后使用的 tab 与用户原本的 tab，
// 关闭其余本任务新开的中间页（搜索页、中转页等），避免 tab 越开越多。
async function closeAuxTabs(ctx) {
  // 任务结束释放 CDP 调试会话（无论是否开过标签页），隐藏「正在调试」提示条。
  try { detachAllCdp(); } catch (e) {}
  if (!ctx || !Array.isArray(ctx.openedTabs) || !ctx.openedTabs.length) return [];
  const keep = new Set();
  if (Number.isInteger(Number(ctx.tabId))) keep.add(Number(ctx.tabId));
  if (Number.isInteger(Number(ctx.originalTabId))) keep.add(Number(ctx.originalTabId));
  const toClose = ctx.openedTabs.filter((id) => Number.isInteger(Number(id)) && !keep.has(Number(id)));
  if (toClose.length) {
    try {
      await chrome.tabs.remove(toClose);
    } catch (e) {}
    ctx.openedTabs = ctx.openedTabs.filter((id) => !toClose.includes(id));
  }
  // 隔离浏览的专用 Agent 窗口一并关闭，不留残余窗口/标签。
  await closeAgentWindow(ctx).catch(() => {});
  return toClose;
}

// 触底收尾：预算 / 超时 / 卡死触顶时，不再干巴巴报错，而是让模型基于已经拿到的
// 工具结果生成一份尽可能完整、诚实的最终回复（已完成哪些步骤、得到什么、还差什么、接下来怎么做）。
// 用空工具集调用模型，避免继续触发工具；失败时退回一句简短说明。
async function finalizeWithPartialInfo(port, settings, messages, signal, emit) {
  const finalMessages = (Array.isArray(messages) ? messages : []).concat([
    {
      role: 'user',
      content:
        '（系统提示：本任务的工具调用已触发安全上限，无法继续执行更多操作。）' +
        '请基于上面你已经获得的信息，给出一份「决策建议」而不是简单总结，按以下结构输出：\n' +
        '1) 当前进展：已完成哪些步骤、得到什么结果；\n' +
        '2) 卡点：哪一步没完成、为什么（预算用尽 / 某步失败 / 等待超时）；\n' +
        '3) 结尾一句引导：告诉用户直接回复做法名即可继续。\n' +
        '正文之后，必须在最后单独输出一个「程序可读」的 JSON 选项块（非常重要，必须严格遵守）：' +
        '整块以 <options> 开头、以 </options> 结尾，中间是合法 JSON 数组，不要掺任何其他文字。' +
        '每个元素含 label 与 desc：label 是简短做法名（不超过 8 个汉字，例如“继续当前方案”“改用抓取”“手动接管”），' +
        'desc 用一句话说明该做法、预期结果与需要用户做什么。必须输出 2~3 个选项。示例：\n' +
        '<options>\n' +
        '[{"label":"继续当前方案","desc":"需要你批准更多调用额度，预计再 2 步完成"},' +
        '{"label":"改用抓取","desc":"用 fetch_webpage 直接抓取内容，无需新开页"},' +
        '{"label":"手动接管","desc":"你先手动打开页面，再回复继续"}]' +
        '\n</options>\n' +
        '不要声称执行过实际没有执行的操作。',
    },
  ]);
  try {
    const step = await withTimeout(
      () => streamAgentStep(port, settings, finalMessages, signal, [], emit),
      25000
    );
    if (step && step.error) throw new Error(step.error);
    // streamAgentStep 已把内容实时流式输出到前端，这里无需重复 emit。
    return true;
  } catch (e) {
    if (e && e.name === 'AbortError') return false;
    emit({ type: 'chunk', text: '\n\n（无法生成补充回答，任务已在安全上限处停止。）' });
    return false;
  }
}

function waitForToolApproval(port, callId, name, args, signal, runId, allowSession) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (approved) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(approved);
    };
    const onMessage = (message) => {
      if (message && message.type === 'tool-approval' && message.callId === callId) {
        finish(message.decision || (message.approved === true ? 'once' : 'reject'));
      }
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), 60000);
    port.onMessage.addListener(onMessage);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      port.postMessage({ type: 'tool-call', runId, callId, name, args, requiresApproval: true, risk: getToolMetadata(name).risk, allowSession: allowSession !== false });
    } catch (e) {
      finish(false);
    }
  });
}

/**
 * 以流式方式调用一次 Agent 步骤，解析 SSE 中的 content 与 tool_calls。
 * content 实时转发给前端，让“我来帮你打开…/正在搜索…”这类过程叙述
 * 与工具步骤交错呈现，而不是最后一次性吐出；若任务提前停止，
 * 前端会显示停止提示，避免把未完成的叙述误当成最终结果。
 * @returns {Promise<{assistantMessage, toolCalls, error?}>}
 */
// 导出以便单测：重试 / 中断 / 超时语义较难在集成环境覆盖，这里用假 fetch 直接验证。
export async function streamAgentStep(port, settings, messages, signal, tools, emit) {
  const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = { model: settings.model, messages, temperature: 0.3, stream: true, stream_options: { include_usage: true } };
  // 仅在确有可用工具时附带 tools / tool_choice，避免空数组触发 API 400 而中断回答。
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  console.log('[RecallFlow] LLM fetch start:', settings.model, 'msgs=' + messages.length);
  // 请求超时只覆盖「首字节到达前」的等待；模型挂起时给出明确错误而不是无限转圈。
  // 尊重用户在设置里的 requestTimeoutMs —— 原先硬编码 60s，使该配置对 Agent 路径完全无效。
  const timeoutMs = Number(settings.requestTimeoutMs) > 0 ? Number(settings.requestTimeoutMs) : 60000;
  const timeoutCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const abortFromOutside = () => { if (timeoutCtrl) timeoutCtrl.abort(); };
  const cleanup = () => {
    if (signal && timeoutCtrl) signal.removeEventListener('abort', abortFromOutside);
  };
  // 关键：abort 监听必须覆盖**整个**请求生命周期（含流式读取）。
  // 原先在 fetch 返回后就摘掉监听，导致用户点「停止」无法中断已开始的流，只能等它自己读完。
  if (signal && timeoutCtrl) {
    if (signal.aborted) timeoutCtrl.abort();
    else signal.addEventListener('abort', abortFromOutside);
  }

  const MAX_RETRIES = 2;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let resp;
  try {
    // 重试仅覆盖「尚未向界面输出任何内容」的阶段，因此不会造成重复输出。
    for (let attempt = 0; ; attempt++) {
      let timedOut = false;
      const timer = timeoutCtrl ? setTimeout(() => { timedOut = true; timeoutCtrl.abort(); }, timeoutMs) : null;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + settings.apiKey,
          },
          body: JSON.stringify(body),
          signal: timeoutCtrl ? timeoutCtrl.signal : signal,
        });
        if (timer) clearTimeout(timer);
        console.log('[RecallFlow] LLM fetch done:', resp.status);
      } catch (e) {
        if (timer) clearTimeout(timer);
        if (timedOut) {
          cleanup();
          return { error: '模型请求超时（' + Math.round(timeoutMs / 1000) + ' 秒），请检查网络连接或 API 服务后重试。' };
        }
        if (e && e.name === 'AbortError') throw e; // 外部中断（用户停止）交给上层按中断处理
        if (attempt < MAX_RETRIES && isRetryableError(e)) {
          console.log('[RecallFlow] LLM fetch retry ' + (attempt + 1) + ':', e && e.message);
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        throw e;
      }
      if (resp.ok) break;

      // 服务端错误：先取详情，再按可重试性（429 / 5xx / 网络错误）决定是否重试。
      let detail = '';
      try {
        const j = await resp.json();
        detail = j.error && j.error.message ? j.error.message : JSON.stringify(j);
      } catch (e) {
        detail = await resp.text().catch(() => '');
      }
      const err = new Error('DeepSeek 请求失败 (' + resp.status + '): ' + detail);
      err.status = resp.status;
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        console.log('[RecallFlow] LLM retry after status ' + resp.status + ' (attempt ' + (attempt + 1) + ')');
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      cleanup();
      return { error: err.message };
    }
  } catch (e) {
    cleanup();
    throw e;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentAcc = '';
  let usage = null;
  const toolAcc = [];

  const ensureTool = (i) => {
    while (toolAcc.length <= i) toolAcc.push({ index: toolAcc.length, id: '', name: '', args: '' });
    return toolAcc[i];
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch (e) {
        continue;
      }
      if (json.usage) usage = json.usage;
      const choice = json.choices && json.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) {
        contentAcc += delta.content;
        (emit || ((event) => port.postMessage(event)))({ type: 'chunk', text: delta.content });
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const t = ensureTool(tc.index || 0);
          if (tc.id) t.id = tc.id;
          if (tc.function) {
            if (tc.function.name) t.name = tc.function.name;
            if (tc.function.arguments) t.args += tc.function.arguments;
          }
        }
      }
    }
  }

  const toolCalls = toolAcc
    .filter((t) => t.name || t.id)
    .map((t) => ({ id: t.id, name: t.name, args: parseToolArgs(t.args) }));

  const assistantMessage = { role: 'assistant', content: contentAcc };
  if (toolCalls.length) {
    assistantMessage.tool_calls = toolCalls.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    }));
  }
  cleanup(); // 流已结束，摘掉中断监听（流式期间刻意保留，以保证「停止」能立即生效）
  return { assistantMessage, toolCalls, usage };
}

/**
 * Agent 主循环：流式对话 + 工具调用。
 * 模型返回 tool_calls 时执行真实工具（检索/增删知识库）并把结果喂回，
 * 直到模型给出最终文本回复（流式推送）或达到最大步数。
 */
export async function runAgentStream(port, payload, settings, book, signal, tabId) {
  const runId = payload.runId || 'run-' + Date.now().toString(36);
  const persisted = await loadAgentSession(runId).catch(() => null);
  const canResume = persisted && persisted.status !== RUN_STATUS.COMPLETED && persisted.status !== RUN_STATUS.FAILED && persisted.status !== RUN_STATUS.CANCELLED && persisted.status !== RUN_STATUS.TIMEOUT;
  const sessionApprovedTools = new Set(canResume ? (persisted.sessionApprovedTools || []) : []);
  let eventSeq = canResume ? Number(persisted.eventSeq || 0) : 0;

  const emit = (event) => {
    const message = Object.assign({ runId, seq: ++eventSeq, timestamp: Date.now() }, event);
    try { port.postMessage(message); } catch (e) { /* 端口断开时保留 Session，等待同 runId 恢复 */ }
  };
  // 结构化运行轨迹（排障用，异步落盘，不阻塞主流程）。
  const trace = (entry) => {
    try { appendTrace(runId, entry).catch(() => {}); } catch (e) {}
  };
  const summarizeArgs = (a) => {
    try {
      const s = JSON.stringify(a || {});
      return s.length > 200 ? s.slice(0, 200) + '…' : s;
    } catch (e) {
      return '';
    }
  };
  const instruction = canResume ? (persisted.instruction || '') : (payload.question || payload.command || payload.text || '');
  const selectedText = canResume ? (persisted.selectedText || '') : (payload.text || '');
  const detected = canResume && persisted.intent
    ? { intent: persisted.intent, confidence: 'medium', keyword: persisted.intentKeyword || '', reason: '已恢复上次任务意图', sourceText: instruction }
    : await resolveIntentForAgent(
        instruction,
        Array.isArray(payload.history) ? payload.history : [],
        settings,
        { forceContinuation: payload.continuation === true },
        signal
      );
  const intent = detected.intent;
  const intentInfo = resolveIntent(intent);
  const allSkills = await getMergedSkills();
  // 进阶版 A：技能不再预先注入正文，而是把全部技能做成「目录」交给模型自选；
  // 模型判断相关时通过常驻工具 load_skill 按需加载完整说明，加载后再把该技能声明的工具并入白名单。
  const loadedSkillNames = canResume && Array.isArray(persisted.skills) ? persisted.skills.slice() : [];
  const budget = canResume ? persisted.budget : getBudget(payload, settings, intent);
  // 生效预算：随「是否实际用到研究类工具」动态提升（只增不减）；恢复时沿用已提升的值。
  let effectiveMaxTools = canResume ? Math.max(budget.maxToolCalls, Number(persisted.effectiveMaxTools) || 0) : budget.maxToolCalls;
  let effectiveModelTurns = canResume ? Math.max(budget.maxModelTurns, Number(persisted.effectiveModelTurns) || 0) : budget.maxModelTurns;
  // 已自动追加过几次轮数额度（防止无限追加把预算闸门彻底架空）。
  let budgetTopUps = canResume ? Number(persisted.budgetTopUps || 0) : 0;
  // CHAT 任务是否已就地提升为 RESEARCH 画像（工具 + 系统提示 + complete_task 收尾）。
  let promotedToResearch = canResume && persisted.promotedToResearch === true;
  const startedAt = canResume ? Number(persisted.startedAt || Date.now()) : Date.now();
  let toolCallCount = canResume ? Number(persisted.toolCallCount || 0) : 0;
  // 累计 token 用量（有 API usage 时用真实值，否则粗估）。
  let totalTokens = canResume ? Number(persisted.totalTokens || 0) : 0;
  // 已完成「校验未通过 → 反思重试」的次数（受 budget.maxVerifications 限制）。
  let verificationCount = canResume ? Number(persisted.verificationCount || 0) : 0;
  // 本任务调用过 / 失败过的工具名：供「完成前确定性断言」判断
  // 「声称做了修改，但没有任何写类工具被调用」这类确定性矛盾。
  const ranToolNames = canResume && Array.isArray(persisted.ranToolNames) ? persisted.ranToolNames.slice() : [];
  const failedToolNames = canResume && Array.isArray(persisted.failedToolNames) ? persisted.failedToolNames.slice() : [];
  // 确定性断言判定「未通过」的累计次数（每次判定后注入反思继续，因此需要可变）。
  // 注意必须是 let：它会在第 1097 行 += 1 —— 曾经写成 const，导致
  // 「完成断言判定失败」这条分支一走到就抛 Assignment to constant variable，
  // 整个 agent run 直接崩掉。node --check 抓不到（语法合法），单测也覆盖不到这条深层分支。
  let deterministicFails = canResume ? Number(persisted.deterministicFails || 0) : 0;
  // 全任务累计引用：每次工具返回 citations 都并入并按全局顺序重编号（按 url 去重），
  // 前端据此把正文 [n] 与底部「参考来源」全部渲染成可点击链接，而不是只剩最后一次工具的引用。
  const runCitations = canResume && Array.isArray(persisted.runCitations) ? persisted.runCitations.map((c) => Object.assign({}, c)) : [];
  // 统一工具守卫：重复调用 / 连续失败 / 无进展的单一判定与分级动作（软着陆）。
  const guard = createToolGuard(budget);
  if (canResume) guard.restore(persisted.guard);
  // 每工具最近一次结果指纹，用于把「有实质新产出」判定为进展。
  const resultFingerprints = new Map();
  const run = canResume ? Object.assign(createRun(runId, budget), persisted.run || {}, { id: runId, budget }) : createRun(runId, budget);
  // 恢复时把状态重新置于 created，保证状态机从合法入口继续发事件。
  if (canResume) run.status = RUN_STATUS.CREATED;
  const emitState = (next, meta = {}) => {
    const state = transition(run, next, meta);
    emit({ type: 'agent-state', ...state, step: run.currentStep, maxSteps: effectiveModelTurns });
  };
  // 把一组引用并入全任务累计列表、全局重编号，推送完整列表给前端，
  // 并返回「本组引用的局部编号 → 全局编号」映射，供把工具结果文本里的 [n] 重编号为全局编号。
  // 按 URL 去重（同一页面的一次读取会生成多个分块引用，只保留一个「来源」），避免参考来源爆出几十条。
  const recordCitations = (citations) => {
    const map = {};
    if (!Array.isArray(citations)) return map;
    for (const c of citations) {
      if (!c || typeof c !== 'object') continue;
      const u = String(c.url || '').trim();
      // 有 URL 时按 URL 去重；无 URL 时才退化为标题+片段。
      const existing = u
        ? runCitations.find((x) => String(x.url || '').trim() === u)
        : runCitations.find((x) => (String(x.title || '') + '|' + String(x.snippet || '').slice(0, 40)) === (String(c.title || '') + '|' + String(c.snippet || '').slice(0, 40)));
      let gIndex;
      if (existing) {
        gIndex = existing.index;
      } else {
        runCitations.push(Object.assign({}, c, { index: runCitations.length + 1 }));
        gIndex = runCitations.length;
      }
      if (Number.isInteger(Number(c.index))) map[Number(c.index)] = Number(gIndex);
    }
    if (runCitations.length) emit({ type: 'citations', citations: runCitations.map((c) => Object.assign({}, c)) });
    return map;
  };
  emitState(RUN_STATUS.CREATED, { budget, resumed: Boolean(canResume) });
  emit({
    type: 'intent',
    intent,
    label: intentInfo.label,
    confidence: detected.confidence,
    keyword: detected.keyword,
    reason: detected.reason,
  });
  const ctx = {
    book,
    settings,
    page: canResume ? (persisted.page || '') : (payload.page || ''),
    pageUrl: canResume ? (persisted.pageUrl || '') : (payload.pageUrl || ''),
    pageTitle: canResume ? (persisted.pageTitle || '') : (payload.pageTitle || ''),
    tabId: tabId || (canResume ? persisted.tabId : undefined),
    originalTabId: canResume ? (persisted.originalTabId || tabId) : tabId,
    openedTabs: canResume && Array.isArray(persisted.openedTabs) ? persisted.openedTabs.slice() : [],
    openedTabCount: canResume ? Number(persisted.openedTabCount || 0) : 0,
    maxOpenedTabs: budget.maxOpenedTabs,
    // 记录已抓取失败的 URL，fetch_webpage 对同一 URL 重试时直接拒绝，避免反复猜 URL 空耗预算。
    failedUrls: canResume && Array.isArray(persisted.failedUrls) ? persisted.failedUrls.slice() : [],
    // 浏览隔离：浏览器操作类任务与用户共享窗口；研究/知识库/对话类任务用专用 Agent 窗口。
    browsingMode: intent === INTENTS.BROWSER ? 'shared' : 'isolated',
    agentWindowId: canResume && Number.isInteger(Number(persisted.agentWindowId)) ? Number(persisted.agentWindowId) : null,
    // 本任务的可重放动作轨迹（供 save_macro 保存为宏）。
    trace: canResume && Array.isArray(persisted.trace) ? persisted.trace.slice() : [],
    // 本任务的执行计划（子目标清单，由 update_plan 维护）。
    plan: canResume && Array.isArray(persisted.plan) ? persisted.plan.map((p) => Object.assign({}, p)) : [],
    // 大工具结果的暂存（超出阈值时截断消息、把全文放这里，供 expand_result 读取）。
    // 内容不跨恢复保留，但 id 会（resultIds）—— 这样恢复后能明确告知「该结果属于上一轮运行」，
    // 而不是让模型以为记错了 id、反复重试。
    resultStore: new Map(),
    resultIds: new Set(canResume && Array.isArray(persisted.resultIds) ? persisted.resultIds : []),
    // 最近一次页面证据（供完成前校验使用）。
    lastSnapshot: null,
    lastEvidence: '',
  };
  trace({
    phase: 'start',
    intent,
    resumed: Boolean(canResume),
    instruction: String(instruction || '').slice(0, 200),
    pageUrl: ctx.pageUrl,
    budget: { maxToolCalls: budget.maxToolCalls, maxModelTurns: budget.maxModelTurns },
  });
  const allowedTools = intentInfo.allowedTools;
  const disabledTools = new Set(canResume && Array.isArray(persisted.disabledTools) ? persisted.disabledTools : []);
  const collected = await collectAgentTools(settings, {
    allowedTools,
    includeMcp: intentInfo.includeMcp,
  });
  // MCP 工具索引随运行上下文传递（不再用模块级全局态，避免并发运行互相清空）。
  ctx.mcpIndex = collected.mcpIndex;
  let tools = collected.tools.filter((t) => t && t.function && !disabledTools.has(t.function.name));
  // 恢复时把已加载技能声明过的工具重新并入可用集合
  if (canResume) {
    for (const n of loadedSkillNames) {
      const sk = allSkills.find((s) => s.name === n || s.id === n);
      for (const tn of (sk && sk.tools) || []) {
        const def = TOOL_REGISTRY.find((t) => t.name === tn);
        if (def && !tools.some((t) => t.function && t.function.name === tn)) tools.push(def.openai);
      }
    }
  }
  const basePrompt = buildSystemPrompt(
    intent,
    detected.sourceText || instruction,
    tools.map((t) => t.function && t.function.name),
    allSkills
  );
  // 「附加段」单独累积：CHAT→RESEARCH 画像提升时只重建基础系统提示，
  // 若不把附加段一并带上，站点记忆与宏目录会在最需要它们的时候被静默丢掉。
  let promptExtras = '';
  // 站点记忆：把本网站曾成功用过的元素选择器提示给模型，减少重复探索。
  if (settings.siteMemoryEnabled !== false && ctx.pageUrl) {
    const hints = await getSiteHints(ctx.pageUrl, 12).catch(() => []);
    if (hints.length) {
      promptExtras +=
        '\n\n【本站点记忆】以下是本网站曾成功定位过的元素（优先直接使用 selector，避免重复探索；若选择器已失效则重新快照）：\n' +
        hints.map((h) => '- ' + (h.role || h.tag || '元素') + '「' + h.label + '」→ ' + h.selector).join('\n');
    }
  }
  // 宏目录：把当前站点已保存的流程提示给模型，用户要求执行已知流程时用 run_macro 一键回放。
  if (ctx.pageUrl) {
    const macros = await listMacros(ctx.pageUrl).catch(() => []);
    if (macros.length) {
      promptExtras +=
        '\n\n【本站点已保存的宏】用户要求执行这些流程时，优先用 run_macro("名称") 一键回放，不要重新逐步操作：\n' +
        macros.map((m) => '- ' + m.name + (m.description ? '：' + m.description : '') + '（' + m.steps.length + ' 步）').join('\n');
    }
  }
  let systemPrompt = basePrompt + promptExtras;
  let messages;
  if (canResume && Array.isArray(persisted.messages)) {
    // 恢复时丢弃上一轮注入的计划消息，避免重复；计划由 ctx.plan 重新注入。
    messages = sanitizeToolPairing(persisted.messages.filter(
      (m) => !(m && m.role === 'system' && typeof m.content === 'string' && m.content.indexOf('【当前计划】') === 0)
    ));
  } else {
    const pickedList = canResume
      ? persisted.pickedElements || (persisted.pickedElement ? [persisted.pickedElement] : [])
      : payload.pickedElements || (payload.pickedElement ? [payload.pickedElement] : []);
    const built = buildInitialMessages(instruction, selectedText, ctx.page, ctx.pageUrl, payload.history, emit, systemPrompt, pickedList);
    messages = built.messages;
  }
  // 计划消息：以独立 system 消息插在系统提示之后，每轮刷新（不污染基础系统提示）。
  let planMessage = null;
  const syncPlanMessage = () => {
    if (planMessage) {
      const i = messages.indexOf(planMessage);
      if (i >= 0) messages.splice(i, 1);
      planMessage = null;
    }
    if (ctx.plan && ctx.plan.length) {
      const text = ctx.plan
        .map((p, i) => (p.status === 'done' ? '✓' : p.status === 'in_progress' ? '▶' : '○') + ' ' + (i + 1) + '. ' + p.text)
        .join('\n');
      planMessage = { role: 'system', content: '【当前计划】\n' + text + '\n（每完成一步用 update_plan 更新状态。）' };
      messages.splice(1, 0, planMessage);
    }
  };
  const resumeIteration = canResume
    ? Math.max(0, Number.isFinite(Number(persisted.nextIteration)) ? Number(persisted.nextIteration) : Math.max(0, Number(run.currentStep || 1) - 1))
    : 0;

  const persist = async (extra = {}) => {
    await saveAgentSession({
      id: runId,
      status: run.status,
      run: { ...run },
      budget,
      startedAt,
      eventSeq,
      toolCallCount,
      guard: guard.snapshot(),
      effectiveMaxTools,
      effectiveModelTurns,
      promotedToResearch,
      runCitations: runCitations.slice(-60),
      failedUrls: Array.isArray(ctx.failedUrls) ? ctx.failedUrls.slice(-80) : [],
      browsingMode: ctx.browsingMode,
      agentWindowId: Number.isInteger(Number(ctx.agentWindowId)) ? Number(ctx.agentWindowId) : null,
      sessionApprovedTools: Array.from(sessionApprovedTools),
      messages: compactSessionMessages(messages),
      instruction,
      selectedText,
      pickedElements:
        (payload && payload.pickedElements) ||
        (canResume ? persisted.pickedElements : null) ||
        (payload && payload.pickedElement ? [payload.pickedElement] : []),
      intent,
      intentKeyword: detected.keyword,
      skills: loadedSkillNames,
      page: ctx.page,
      pageUrl: ctx.pageUrl,
      pageTitle: ctx.pageTitle,
      tabId: ctx.tabId,
      originalTabId: ctx.originalTabId,
      openedTabs: Array.isArray(ctx.openedTabs) ? ctx.openedTabs.slice() : [],
      openedTabCount: Number(ctx.openedTabCount || 0),
      disabledTools: Array.from(disabledTools),
      trace: Array.isArray(ctx.trace) ? ctx.trace.slice(-40) : [],
      plan: Array.isArray(ctx.plan) ? ctx.plan.slice(0, 20) : [],
      totalTokens,
      verificationCount,
      ranToolNames: ranToolNames.slice(-60),
      failedToolNames: failedToolNames.slice(-60),
      deterministicFails,
      resultIds: Array.from(ctx.resultIds || []).slice(-80),
      budgetTopUps,
      ...extra,
    });
  };
  await persist({ status: RUN_STATUS.CREATED, phase: 'created', nextIteration: resumeIteration }).catch(() => {});

  for (let iter = resumeIteration; iter < effectiveModelTurns; iter++) {
    // 成本上限：只卡轮数挡不住「少轮次但上下文巨大」的失控（每轮都重发整段上下文）。
    if (tokenBudgetExceeded(totalTokens, budget)) {
      emitState(RUN_STATUS.TIMEOUT, { reason: 'maxTotalTokens' });
      trace({ phase: 'timeout', reason: 'maxTotalTokens', toolCalls: toolCallCount, totalTokens });
      emit({
        type: 'budget-exceeded',
        reason: 'maxTotalTokens',
        message: '任务累计 token 已达成本上限（约 ' + totalTokens + '），已停止。',
        totalTokens,
      });
      await finalizeWithPartialInfo(port, settings, messages, signal, emit);
      await persist({ status: RUN_STATUS.TIMEOUT, reason: 'maxTotalTokens', totalTokens }).catch(() => {});
      await closeAuxTabs(ctx).catch(() => {});
      emit({ type: 'end' });
      return;
    }
    if (Date.now() - startedAt >= budget.maxDurationMs) {
      emitState(RUN_STATUS.TIMEOUT, { reason: 'maxDurationMs' });
      trace({ phase: 'timeout', reason: 'maxDurationMs', toolCalls: toolCallCount, totalTokens });
      emit({ type: 'budget-exceeded', reason: 'maxDurationMs', message: '任务执行超过安全时限，已停止。' });
      await finalizeWithPartialInfo(port, settings, messages, signal, emit);
      await persist({ status: RUN_STATUS.TIMEOUT, reason: 'maxDurationMs' }).catch(() => {});
      await closeAuxTabs(ctx).catch(() => {});
      emit({ type: 'end' });
      return;
    }
    run.currentStep = iter + 1;
    // 新任务和恢复任务的第一轮都从 planning 重新建立合法状态链。
    emitState(iter === resumeIteration ? RUN_STATUS.PLANNING : RUN_STATUS.OBSERVING);
    await persist({ status: run.status, phase: 'model', nextIteration: iter }).catch(() => {});
    // 折叠较早的工具结果，控制上下文规模；再注入/刷新计划消息。
    // **只在总量超过阈值时压缩一次**：每轮都改写会话中部的消息会让请求前缀发生变化，
    // 从而破坏服务端的前缀缓存、每轮都要重算一大段 —— 这是「同样的模型却更慢」的隐蔽原因。
    // 一次压缩会砍掉大量字符，因此接下来若干轮都不会再触发，前缀保持稳定、缓存得以命中。
    let historyChars = 0;
    for (const m of messages) {
      if (typeof m.content === 'string') historyChars += m.content.length;
      else if (m.content) historyChars += 200;
    }
    if (historyChars > 60000) collapseOldToolResults(messages, 6, 300);
    syncPlanMessage();
    const safeMessageLength = messages.length;
    let step;
    try {
      step = await streamAgentStep(port, settings, messages, signal, tools, emit);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        // 端口断开不等于任务失败：保留最近一个完整 tool turn，允许同 runId 恢复。
        messages.length = safeMessageLength;
        await persist({ status: run.status, phase: 'interrupted', reason: 'port-disconnected', nextIteration: iter }).catch(() => {});
        return;
      }
      const error = e && e.message ? e.message : String(e);
      emitState(RUN_STATUS.FAILED, { error });
      trace({ phase: 'error', error });
      emit({ type: 'error', error });
      await persist({ status: RUN_STATUS.FAILED, error }).catch(() => {});
      try { detachAllCdp(); } catch (err) {}
      return;
    }
    if (step.error) {
      emitState(RUN_STATUS.FAILED, { error: step.error });
      trace({ phase: 'error', error: step.error });
      emit({ type: 'error', error: step.error });
      await persist({ status: RUN_STATUS.FAILED, error: step.error }).catch(() => {});
      try { detachAllCdp(); } catch (err) {}
      return;
    }
    messages.push(step.assistantMessage);
    // token 用量：优先用 API 返回的 usage，缺失时按消息粗估。
    if (step.usage && (step.usage.total_tokens || step.usage.prompt_tokens)) {
      // 累加本任务总消耗。usage 是「本次请求」的量，直接赋值会退化成只剩最后一次
      // 请求的用量、系统性低估（此前即为此 bug）。
      const u = step.usage;
      const delta =
        Number(u.total_tokens) || (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0);
      totalTokens += delta;
    } else {
      // fallback 估算：消息 + **工具定义**。
      // 必须把工具也算进去 —— 它每轮都随请求发出（实测浏览器任务约 8.3k tokens/轮），
      // 而 estimateMessagesTokens 只看 messages，会系统性少算，
      // 进而让 maxTotalTokens 这道成本闸门在实际已超支时仍不触发。
      totalTokens += estimateMessagesTokens(messages) + estimateTokens(JSON.stringify(tools));
    }
    emit({ type: 'usage', totalTokens });

    if (step.toolCalls.length) {
      // 本轮要注入的反思消息（须在所有 tool 结果之后统一追加，保持 tool_call/tool_result 配对）。
      const pendingReflections = [];
      for (const tc of step.toolCalls) {
        toolCallCount += 1;
        const metadata = getToolMetadata(tc.name);
        // 预算弹性 + 画像自纠：实际用到研究/网络类工具 → 放宽生效预算（只增不减），
        // 且若起点是「普通对话」，就地提升为「资料研究」画像（工具集 + 系统提示 + 收尾规则）。
        if (RESEARCH_TRIGGER_TOOLS.has(tc.name)) {
          effectiveMaxTools = Math.max(effectiveMaxTools, ESCALATED_BUDGET.maxToolCalls);
          effectiveModelTurns = Math.max(effectiveModelTurns, ESCALATED_BUDGET.maxModelTurns);
          if (intent === INTENTS.CHAT && !promotedToResearch) {
            promotedToResearch = true;
            promoteToResearch(tools, messages, detected.sourceText || instruction, allSkills, promptExtras);
            emit({ type: 'intent-upgraded', intent: INTENTS.RESEARCH, label: resolveIntent(INTENTS.RESEARCH).label });
          }
        }
        // 全局工具预算：唯一的硬闸（触顶即触底收尾）；重复/连续失败改为执行后由 guard 软着陆。
        if (toolCallCount > effectiveMaxTools) {
          const reason = 'maxToolCalls';
          messages.length = safeMessageLength;
          emitState(RUN_STATUS.TIMEOUT, { reason });
          trace({ phase: 'timeout', reason, toolCalls: toolCallCount, totalTokens });
          emit({ type: 'budget-exceeded', reason, message: '工具调用达到安全上限，已停止。' });
          await finalizeWithPartialInfo(port, settings, messages, signal, emit);
          await persist({ status: RUN_STATUS.TIMEOUT, reason }).catch(() => {});
          await closeAuxTabs(ctx).catch(() => {});
          emit({ type: 'end' });
          return;
        }
        const callId = tc.id || 'tool-' + iter + '-' + Math.random().toString(36).slice(2, 8);
        const toolState = { callId, name: tc.name, status: TOOL_STATUS.PENDING };
        let res;
        const validation = validateToolCall(tc.name, tc.args || {});
        if (!validation.ok) {
          res = { ok: false, result: validation.error };
          toolState.status = TOOL_STATUS.FAILED;
          emit({ type: 'tool-result', callId, name: tc.name, status: 'failed', result: res.result });
        }
        if (settings.toolApproval !== false && toolNeedsApproval(tc.name, settings, ctx.pageUrl) && !sessionApprovedTools.has(tc.name)) {
          if (res) {
            // 参数不合法时不应再弹审批框。
          } else {
          toolState.status = TOOL_STATUS.APPROVAL_REQUIRED;
          emitState(RUN_STATUS.WAITING_APPROVAL, { callId, tool: tc.name });
          // 高风险工具（如 run_javascript）默认不允许“会话级放行”；当设置 runJavascriptApproval='session' 时允许。
          const allowSession =
            metadata.alwaysRequireApproval !== true ||
            (settings.runJavascriptApproval || 'session') === 'session';
          const decision = await waitForToolApproval(port, callId, tc.name, tc.args, signal, runId, allowSession);
          if (decision === 'session' && allowSession) {
            sessionApprovedTools.add(tc.name);
          }
          if (decision !== 'once' && decision !== 'session') {
            res = { ok: false, result: '用户未批准执行工具「' + tc.name + '」，请不要执行该操作；可说明原因或给出替代方案。' };
            toolState.status = TOOL_STATUS.REJECTED;
            emit({ type: 'tool-result', callId, name: tc.name, status: 'rejected', result: res.result });
            emitState(RUN_STATUS.OBSERVING, { callId, tool: tc.name, rejected: true });
          }
          }
        }
        if (!res) {
          toolState.status = TOOL_STATUS.RUNNING;
          emitState(RUN_STATUS.EXECUTING, { callId, tool: tc.name });
          emit({ type: 'tool-call', callId, name: tc.name, args: tc.args, requiresApproval: false, risk: getToolMetadata(tc.name).risk });
          const toolStartedAt = Date.now();
          try {
            res = await withTimeout(() => executeAnyTool(tc.name, tc.args, ctx), metadata.timeoutMs || budget.toolTimeoutMs, signal);
          } catch (e) {
            res = { result: e.name === 'AbortError' ? '任务已取消。' : e.message, ok: false };
          }
          toolState.status = res.ok === false ? TOOL_STATUS.FAILED : TOOL_STATUS.SUCCEEDED;
          // 记账：供「完成前确定性断言」判断声称与实际动作是否相符。
          ranToolNames.push(tc.name);
          if (res.ok === false) failedToolNames.push(tc.name);
          trace({ phase: 'tool', name: tc.name, args: summarizeArgs(tc.args), status: toolState.status, ms: Date.now() - toolStartedAt, ok: res.ok !== false, code: res.code, resultLen: String(res.result || '').length });
          emit({ type: 'tool-result', callId, name: tc.name, status: res.ok === false ? 'failed' : 'completed', result: res.result });
          // 资源型工具触顶（如 open_tab 预算用尽，res.blocked=true）→ 立即摘除，禁止模型下轮再试。
          // 连续失败 / 重复调用 / 无进展统一交给 guard，在其后分级软着陆。
          // 常驻工具（load_skill 等 alwaysAvailable）不参与摘除，避免破坏技能系统。
          if (metadata.alwaysAvailable !== true && res && res.blocked === true && !disabledTools.has(tc.name)) {
            disabledTools.add(tc.name);
            tools = tools.filter((t) => !(t.function && t.function.name === tc.name));
            emit({ type: 'tool-disabled', name: tc.name, reason: res.blockReason || '已达安全上限，禁止继续调用' });
          }
          // 计划更新：刷新计划消息并通知前端渲染进度。
          if (tc.name === 'update_plan') {
            syncPlanMessage();
            emit({ type: 'plan', plan: Array.isArray(ctx.plan) ? ctx.plan.map((p) => Object.assign({}, p)) : [] });
          }
          // 进阶版 A：模型调用 load_skill 时，记录已加载技能、通知前端，并把该技能声明的工具并入白名单。
          if (tc.name === 'load_skill') {
            const loadedName = String((tc.args && tc.args.name) || '').trim();
            const loaded = allSkills.find((s) => s.name === loadedName || s.title === loadedName || s.id === loadedName);
            if (loaded) {
              emit({ type: 'skill', skills: [{ name: loaded.name, title: loaded.title, description: loaded.description }] });
              if (!loadedSkillNames.includes(loaded.name)) loadedSkillNames.push(loaded.name);
              for (const tn of Array.isArray(loaded.tools) ? loaded.tools : []) {
                const def = TOOL_REGISTRY.find((t) => t.name === tn);
                if (def && !tools.some((t) => t.function && t.function.name === tn)) tools.push(def.openai);
              }
            }
          }
        }
        if (res.citations) {
          const citationMap = recordCitations(res.citations);
          const globalNums = Array.from(new Set(Object.values(citationMap).filter((v) => Number.isInteger(v))));
          if (typeof res.result === 'string') {
            // 把工具结果文本里的局部 [n] 重编号为全局编号，并明确告知模型这段内容
            // 已登记为哪个参考来源编号——模型据此引用 [X]，正文链接才会指向正确的来源。
            // 只改写「行首的 [n]」（知识库工具产出的引用标记），避免误改页面正文里的方括号数字。
            res.result = res.result.replace(/(^|\n)([ \t]*)\[(\d{1,2})\]/g, (m, lead, sp, num) => {
              const g = citationMap[parseInt(num, 10)];
              return g ? lead + sp + '[' + g + ']' : m;
            });
            if (globalNums.length) {
              res.result += '\n\n（以上内容已登记为参考来源 [' + globalNums.join(',') + ']，回答中引用本页内容时请使用该编号。）';
            }
          }
        }
        if (res && Number.isInteger(Number(res.targetTabId))) {
          ctx.tabId = Number(res.targetTabId);
          if (res.targetTab) {
            ctx.pageUrl = res.targetTab.url || ctx.pageUrl;
            ctx.pageTitle = res.targetTab.title || ctx.pageTitle;
          }
          emit({ type: 'tab-switched', tabId: ctx.tabId, title: ctx.pageTitle, url: ctx.pageUrl });
        }
        // 大结果截断：全文暂存到 ctx.resultStore，消息里只留开头 + id，供 expand_result 读取。
        // 阈值刻意放宽（6000 / 内联 3000）：截断太早会把「本来一次读得完」的结果变成
        // 一次额外的 expand_result 往返，而每一轮往返都是一次完整的模型请求。
        if (typeof res.result === 'string' && res.result.length > 6000) {
          const rid = 'res-' + toolCallCount;
          try { ctx.resultStore.set(rid, res.result); } catch (e) {}
          try { ctx.resultIds.add(rid); } catch (e) {}
          res.result = res.result.slice(0, 3000) + '\n…（结果共 ' + res.result.length + ' 字符，已截断；完整内容 id=' + rid + '，可用 expand_result(id="' + rid + '") 分段读取）';
        }
        // 截图：只推给前端渲染（给用户看），**不写入 messages** ——
        // 当前模型是纯文本的，base64 进上下文只会白烧 token。
        if (res && res.screenshot && res.screenshot.dataUrl) {
          emit({
            type: 'screenshot',
            id: res.screenshot.id,
            dataUrl: res.screenshot.dataUrl,
            label: res.screenshot.label,
            width: res.screenshot.width,
            height: res.screenshot.height,
            bytes: res.screenshot.bytes,
          });
        }
        // 记录最近页面证据（供完成前独立校验使用）。
        if (res && res.pageSnapshot) ctx.lastSnapshot = res.pageSnapshot;
        if (res && typeof res.result === 'string' && ['read_current_page', 'get_page_snapshot', 'get_element_text', 'get_ax_snapshot'].includes(tc.name)) {
          ctx.lastEvidence = res.result.slice(0, 3000);
        }
        // 记录可重放的成功动作，供 save_macro 保存为宏。
        try { recordTraceStep(ctx, tc.name, tc.args, res); } catch (e) {}
        messages.push({ role: 'tool', tool_call_id: tc.id, content: res.result });
        const progress = toolResultProgress(res) || resultProgressByChange(resultFingerprints, tc.name, res);
        // complete_task 是终止性工具：任务完成后立即结束，不再继续调用其他工具。
        if (res && res.complete === true) {
          // 完成前检查分两层：
          //  ① 确定性断言（零成本）：只抓「声称与实际不符」这类可确定判定的矛盾。命中即直接反思，
          //     省掉一次 LLM 调用 —— 只在「本来就要重试」的情况下省，不削弱护栏。
          //  ② LLM 独立校验：判断「页面是否真的变了」，这一步必须看证据，规则无法替代。
          const verifierOn = Boolean(settings && settings.verifierEnabled !== false);
          if (verifierOn && verificationCount < Number(budget.maxVerifications || 0)) {
            const evidenceForCheck = [ctx.lastSnapshot ? compactSnapshotSummary(ctx.lastSnapshot) : '', ctx.lastEvidence || ''].join('\n');
            const mutatingRun = [...new Set(ranToolNames)].filter((nm) => {
              try {
                return getToolMetadata(nm).readOnly !== true;
              } catch (e) {
                return false;
              }
            });
            const precheck = checkCompletionClaim({
              claim: String((res && res.result) || ''),
              ranTools: [...new Set(ranToolNames)],
              mutatingRanTools: mutatingRun,
              failedTools: [...new Set(failedToolNames)],
              evidenceText: evidenceForCheck,
            });
            if (precheck.verdict === 'fail') {
              deterministicFails += 1;
              verificationCount += 1;
              emit({
                type: 'verify',
                ok: false,
                deterministic: true,
                reason: precheck.reason,
                missing: precheck.reasons.map((r) => r.message).join('；'),
              });
              trace({ phase: 'verify', ok: false, deterministic: true, codes: precheck.reasons.map((r) => r.code) });
              pendingReflections.push(buildDeterministicReflection(precheck));
              break;
            }
          }
          // 完成前独立校验：校验认为未达成时注入反思继续，而不是草草收尾（受 maxVerifications 限制）。
          if (shouldVerifyCompletion(intent, toolCallCount, settings) && verificationCount < Number(budget.maxVerifications || 0)) {
            const verdict = await runCompletionVerification(settings, instruction, res, ctx, signal).catch(() => null);
            if (!verdict) {
              // 校验器不可用（超时 / 报错 / 无 API Key）时按「通过」放行，
              // 但必须让前端看得见 —— 否则这道安全网静默失效，用户无从察觉。
              emit({ type: 'verify', ok: null, reason: '校验器未能给出结论（超时或调用失败），已按通过放行。' });
              trace({ phase: 'verify', ok: null, reason: 'verifier-unavailable' });
            } else if (verdict.ok === false) {
              verificationCount += 1;
              emit({ type: 'verify', ok: false, reason: verdict.reason, missing: verdict.missing, suggestion: verdict.suggestion });
              trace({ phase: 'verify', ok: false, reason: verdict.reason, missing: verdict.missing });
              pendingReflections.push(buildVerificationReflection(verdict));
              break; // 跳出工具循环，注入反思后继续下一轮
            } else {
              emit({ type: 'verify', ok: true, reason: verdict.reason });
              trace({ phase: 'verify', ok: true, reason: verdict.reason });
            }
          }
          const summary = String(res.result || '任务已完成。');
          // 模型已在本轮实时输出完成叙述时，不再重复输出 complete_task 的总结，
          // 避免“任务完成。任务已完成：…”式的重复；纯工具轮（无文本）才补充总结。
          if (!step.assistantMessage.content) emit({ type: 'chunk', text: summary });
          const closedTabs = await closeAuxTabs(ctx).catch(() => []);
          if (closedTabs && closedTabs.length) emit({ type: 'tabs-closed', tabIds: closedTabs });
          emitState(RUN_STATUS.COMPLETED, { tool: tc.name });
          trace({ phase: 'complete', reason: 'complete_task', tool: tc.name, toolCalls: toolCallCount, totalTokens });
          await persist({ status: RUN_STATUS.COMPLETED, reason: 'complete_task' }).catch(() => {});
          emit({ type: 'end' });
          await removeAgentSession(runId).catch(() => {});
          return;
        }
        // 统一守卫判定：ok / reflect / disable（软着陆：摘工具+反思继续）/ stop（触底收尾）。
        const decision = guard.observe({
          name: tc.name,
          args: tc.args,
          result: res,
          readOnly: metadata.readOnly === true,
          progress,
          validationFailed: !validation.ok,
          rejected: toolState.status === TOOL_STATUS.REJECTED,
        });
        if (decision.level === 'disable') {
          if (metadata.alwaysAvailable !== true && !disabledTools.has(tc.name)) {
            disabledTools.add(tc.name);
            tools = tools.filter((t) => !(t.function && t.function.name === tc.name));
            emit({ type: 'tool-disabled', name: tc.name, reason: decision.message || decision.reason });
          }
          pendingReflections.push(buildStuckReflection(decision.message));
          trace({ phase: 'tool-disabled', reason: decision.reason, tool: tc.name, repeated: decision.repeated, failStreak: decision.failStreak });
        } else if (decision.level === 'reflect') {
          emit({ type: 'stuck-warning', name: tc.name, message: decision.message, repeated: decision.repeated, noProgressStreak: decision.noProgressStreak });
          // 卡住时注入反思，促使模型换一种做法而不是重复。
          pendingReflections.push(buildStuckReflection(decision.message));
          trace({ phase: 'reflect', reason: 'guard-warn', tool: tc.name });
        } else if (decision.level === 'stop') {
          emitState(RUN_STATUS.TIMEOUT, { reason: 'stuck', tool: tc.name });
          trace({ phase: 'timeout', reason: 'stuck', tool: tc.name, toolCalls: toolCallCount, totalTokens });
          emit({ type: 'budget-exceeded', reason: 'stuck', message: decision.message });
          await finalizeWithPartialInfo(port, settings, messages, signal, emit);
          await persist({ status: RUN_STATUS.TIMEOUT, reason: 'stuck', stuck: decision }).catch(() => {});
          await closeAuxTabs(ctx).catch(() => {});
          emit({ type: 'end' });
          return;
        }
        // 只在 assistant tool_call 已配套 tool_result 后保存，避免恢复时出现悬空 tool_call。
        await persist({ status: run.status, phase: 'after_tool', nextIteration: iter + 1 }).catch(() => {});
      }
      // 统一注入本轮反思（须在所有 tool 结果之后，保持 tool_call/tool_result 配对）。
      for (const r of pendingReflections) messages.push({ role: 'user', content: r });
      // 触顶自动追加：本轮确实推进了工具（说明任务在进行中，不是空转），
      // 而下一轮就会撞到轮数上限 → 自动追加一次额度，避免中途硬停。
      // 上限由 maxBudgetTopUps 控制，避免把预算闸门架空。
      if (
        iter + 1 >= effectiveModelTurns &&
        budgetTopUps < Number(budget.maxBudgetTopUps || 0) &&
        toolCallCount > 0
      ) {
        budgetTopUps += 1;
        effectiveModelTurns += Math.max(1, Number(budget.budgetTopUpTurns) || 10);
        emit({
          type: 'budget-extended',
          reason: 'maxModelTurns',
          totalTurns: effectiveModelTurns,
          remainingTopUps: Math.max(0, Number(budget.maxBudgetTopUps || 0) - budgetTopUps),
        });
        trace({ phase: 'budget-extended', effectiveModelTurns, topUps: budgetTopUps, toolCalls: toolCallCount });
      }
      continue;
    }

    emitState(RUN_STATUS.COMPLETED);
    trace({ phase: 'complete', reason: 'final-answer', toolCalls: toolCallCount, totalTokens });
    const closedTabs = await closeAuxTabs(ctx).catch(() => []);
    if (closedTabs && closedTabs.length) emit({ type: 'tabs-closed', tabIds: closedTabs });
    await persist({ status: RUN_STATUS.COMPLETED }).catch(() => {});
    emit({ type: 'end' });
    await removeAgentSession(runId).catch(() => {});
    return;
  }

  emitState(RUN_STATUS.TIMEOUT, { reason: 'maxModelTurns' });
  trace({ phase: 'timeout', reason: 'maxModelTurns', toolCalls: toolCallCount, totalTokens });
  emit({ type: 'budget-exceeded', reason: 'maxModelTurns', message: '已达到最大推理轮数，任务已安全停止。' });
  await finalizeWithPartialInfo(port, settings, messages, signal, emit);
  await persist({ status: RUN_STATUS.TIMEOUT, reason: 'maxModelTurns' }).catch(() => {});
  await closeAuxTabs(ctx).catch(() => {});
  emit({ type: 'end' });
}

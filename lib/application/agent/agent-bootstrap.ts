// Agent run bootstrap: restore durable state and assemble the initial working set.
import { getBudget } from './budget.ts';
import { AgentEventSink } from './agent-events.ts';
import { createRun, RUN_STATUS } from './agent-state.ts';
import { createToolGuard } from './tool-guard.ts';
import {
  buildSystemPrompt,
  INTENTS,
  resolveIntent,
  resolveIntentForAgent,
} from './intent-router.ts';
import { getMergedSkills } from './skills.ts';
import { collectAgentTools, buildMcpStatusSection, persistMcpStatus } from './mcp.ts';
import { createAgentRunContext } from './run-context.ts';
import { loadAgentSession } from './session-store.ts';
import { getSiteHints } from './site-memory.ts';
import { listMacros } from './macro-store.ts';
import { TOOL_REGISTRY } from './tools.ts';
import {
  isDuplicateInstruction,
  normalizeHistory,
  HISTORY_MAX_CHARS,
} from './context.ts';
import { sanitizeToolPairing } from './history-policy.ts';
import { buildInitialMessagesPure } from './initial-messages.ts';
import { formatElementLocator } from '../../shared/format/picked.ts';

function buildInitialMessages(instruction: string, selectedText: any, page: any, pageUrl: any, history: any, emit: any, systemPrompt: any, pickedElements: any) {
  let normalized = normalizeHistory(history, {
    maxMessages: 10,
    maxChars: HISTORY_MAX_CHARS,
    maxTokens: 8000,
    noticeOnTruncation: true,
  });
  const instr = String(instruction || '').trim();
  if (normalized.length && normalized[normalized.length - 1].role === 'user') {
    if (isDuplicateInstruction(normalized[normalized.length - 1].content, instr)) {
      normalized = normalized.slice(0, -1);
    }
  }
  const picks = Array.isArray(pickedElements) ? pickedElements.filter(Boolean) : [];
  const pickedBlocks = picks.map((p: any, i: number) => {
    const src = p.source || {};
    const loc = src.file
      ? src.file + (src.line ? ':' + src.line + (src.column ? ':' + src.column : '') : '') + (src.framework ? '（' + src.framework + (src.component ? ' · ' + src.component : '') + '）' : '')
      : '';
    const locator = p.locator || {};
    const head = picks.length > 1 ? '选取的元素 ' + (i + 1) + '（请针对它回答/操作）：' : '用户在页面上选取的元素（请针对它回答/操作）：';
    const lines = [head];
    if (locator.role || locator.name) lines.push('- 语义定位：' + formatElementLocator(locator, undefined, undefined));
    if (locator.testid) lines.push('- testid：' + locator.testid);
    if (p.selector) lines.push('- CSS 选择器：' + p.selector);
    if (p.tag) lines.push('- 标签：' + p.tag);
    if (p.text) lines.push('- 文本：' + String(p.text).slice(0, 120));
    if (Array.isArray(p.ancestors) && p.ancestors.length) lines.push('- 祖先链：' + p.ancestors.join(' > '));
    if (p.inShadow) lines.push('- 位于 Shadow DOM 内');
    lines.push(loc ? '- 前端源码位置：' + loc : '- 未检测到框架源码位置（可能为生产构建）');
    return lines.join('\n');
  });
  return {
    messages: buildInitialMessagesPure({
      systemPrompt,
      history: normalized,
      instruction: instr,
      selectedText,
      page,
      pickedBlocks,
    }),
    pageCitations: [],
  };
}

export interface PreparedAgentRun {
  runId: string;
  persisted: any;
  canResume: boolean;
  sessionApprovedTools: Set<string>;
  instruction: string;
  selectedText: string;
  detected: any;
  intent: string;
  allSkills: any[];
  loadedSkillNames: string[];
  budget: any;
  promotedToResearch: boolean;
  startedAt: number;
  toolCallCount: number;
  totalTokens: number;
  verificationCount: number;
  lastDeniedSignature: string;
  ranToolNames: string[];
  failedToolNames: string[];
  succeededToolNames: string[];
  deterministicFails: number;
  lastProgressIter: number;
  runCitations: any[];
  guard: any;
  stuckAttempts: Map<string, number>;
  resultFingerprints: Map<string, string>;
  run: any;
  ctx: any;
  disabledTools: Set<string>;
  tools: any[];
  promptExtras: string;
  messages: any[];
  resumeIteration: number;
  prevPrefixSnapshot: any;
  emit(event: any): void;
  trace(entry: Record<string, any>): void;
  reportTurnTiming(iter: number, step: any, toolMs: number): void;
  emitState(next: any, meta?: Record<string, any>): void;
  events: AgentEventSink;
  recordCitations(citations: any): Record<string, any>;
}

export async function prepareAgentRun(options: {
  port: any;
  payload: any;
  settings: any;
  book: any;
  signal: AbortSignal;
  tabId: number | undefined;
  observeEvent: any;
}): Promise<PreparedAgentRun> {
  const { port, payload, settings, book, signal, tabId, observeEvent } = options;
  const runId = payload.runId || 'run-' + Date.now().toString(36);
  const persisted = await loadAgentSession(runId).catch(() => null);
  const canResume = persisted && persisted.status !== RUN_STATUS.COMPLETED && persisted.status !== RUN_STATUS.FAILED && persisted.status !== RUN_STATUS.CANCELLED && persisted.status !== RUN_STATUS.TIMEOUT;
  const sessionApprovedTools = new Set<string>(canResume ? (persisted.sessionApprovedTools || []) : []);
  const events = new AgentEventSink({
    port,
    runId,
    seq: canResume ? Number(persisted.eventSeq || 0) : 0,
    observeEvent,
  });
  const emit = events.emit.bind(events) as (event: any) => void;
  const trace = events.trace;
  const reportTurnTiming = events.reportTurnTiming.bind(events);
  const summarizeArgs = (a: any) => {
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
  // CHAT 任务是否已就地提升为 RESEARCH 画像（工具 + 系统提示 + complete_task 收尾）。
  let promotedToResearch = canResume && persisted.promotedToResearch === true;
  const startedAt = canResume ? Number(persisted.startedAt || Date.now()) : Date.now();
  let toolCallCount = canResume ? Number(persisted.toolCallCount || 0) : 0;
  // 累计 token 用量（有 API usage 时用真实值，否则粗估）。
  let totalTokens = canResume ? Number(persisted.totalTokens || 0) : 0;
  // 已完成「校验未通过 → 反思重试」的次数（受 budget.maxVerifications 限制）。
  let verificationCount = canResume ? Number(persisted.verificationCount || 0) : 0;
  // 上一次被否决时的「证据签名」（claim + 动作回执 + 页面指纹）。
  //
  // 用途：识别"同一份证据被重复送审"。被否决后模型最省力的反应是把总结换个说法再提交，
  // 而页面一个字节都没变 —— 同样的输入会得到同样的否决，用户看到的就是"反复校验"，
  // 每次还要付一次 25 秒的等待。签名相同就**不再调用模型**，直接给一条把话挑明的反思。
  // 必须随 run 持久化：恢复后若清空，同一份证据会被重新送审两次。
  let lastDeniedSignature = canResume ? String(persisted.lastDeniedSignature || '') : '';
  // 本任务调用过 / 失败过的工具名：供「完成前确定性断言」判断
  // 「声称做了修改，但没有任何写类工具被调用」这类确定性矛盾。
  const ranToolNames = canResume && Array.isArray(persisted.ranToolNames) ? persisted.ranToolNames.slice() : [];
  const failedToolNames = canResume && Array.isArray(persisted.failedToolNames) ? persisted.failedToolNames.slice() : [];
  // 「失败过」与「成功过」分开记：claim-check 的规则 2 只有靠这两个名单的**差集**
  // 才能分清「一次都没成」和「失败后重试成功」（详见 claim-check.js 里的说明）。
  const succeededToolNames = canResume && Array.isArray(persisted.succeededToolNames) ? persisted.succeededToolNames.slice() : [];
  // 确定性断言判定「未通过」的累计次数（每次判定后注入反思继续，因此需要可变）。
  // 注意必须是 let：它会在第 1097 行 += 1 —— 曾经写成 const，导致
  // 「完成断言判定失败」这条分支一走到就抛 Assignment to constant variable，
  // 整个 agent run 直接崩掉。node --check 抓不到（语法合法），单测也覆盖不到这条深层分支。
  let deterministicFails = canResume ? Number(persisted.deterministicFails || 0) : 0;
  // 最近一次「有可观察进展」的迭代下标，存活看门狗据此判断是否已卡死。
  // 恢复运行必须沿用持久化的值：否则恢复后基准被重置为 0，
  // 一个早就卡住的任务会被当成"刚开始"，看门狗形同虚设。
  let lastProgressIter = canResume && Number.isFinite(Number(persisted.lastProgressIter))
    ? Number(persisted.lastProgressIter)
    : 0;
  // 全任务累计引用：每次工具返回 citations 都并入并按全局顺序重编号（按 url 去重），
  // 前端据此把正文 [n] 与底部「参考来源」全部渲染成可点击链接，而不是只剩最后一次工具的引用。
  const runCitations = canResume && Array.isArray(persisted.runCitations) ? persisted.runCitations.map((c: any) => Object.assign({}, c)) : [];
  // 统一工具守卫：重复调用 / 连续失败 / 无进展的单一判定，**只提醒、不否决**（见 tool-guard.js）。
  const guard = createToolGuard(budget);
  // 每个工具被提醒过几次。必须**跨轮累计**（放在主循环外），
  // 否则"第 3 次提醒要给出收尾出口"这条梯度永远走不到 —— 按轮重置的话每轮都是第 1 次。
  const stuckAttempts = new Map();
  if (canResume) guard.restore(persisted.guard);
  // 每工具最近一次结果指纹，用于把「有实质新产出」判定为进展。
  const resultFingerprints = new Map();
  const run = canResume ? Object.assign(createRun(runId, budget), persisted.run || {}, { id: runId, budget }) : createRun(runId, budget);
  // 恢复时把状态重新置于 created，保证状态机从合法入口继续发事件。
  if (canResume) run.status = RUN_STATUS.CREATED;
  const emitState = (next: any, meta: Record<string, any> = {}) => {
    // 总步数未知（没有轮数上限）—— 传 0，面板据此省略进度分母。
    events.emitState(run, next, meta);
  };
  // 把一组引用并入全任务累计列表、全局重编号，推送完整列表给前端，
  // 并返回「本组引用的局部编号 → 全局编号」映射，供把工具结果文本里的 [n] 重编号为全局编号。
  // 按 URL 去重（同一页面的一次读取会生成多个分块引用，只保留一个「来源」），避免参考来源爆出几十条。
  const recordCitations = (citations: any) => {
    const map: Record<string, any> = {};
    if (!Array.isArray(citations)) return map;
    for (const c of citations) {
      if (!c || typeof c !== 'object') continue;
      const u = String(c.url || '').trim();
      // 有 URL 时按 URL 去重；无 URL 时才退化为标题+片段。
      const existing = u
        ? runCitations.find((x: any) => String(x.url || '').trim() === u)
        : runCitations.find((x: any) => (String(x.title || '') + '|' + String(x.snippet || '').slice(0, 40)) === (String(c.title || '') + '|' + String(c.snippet || '').slice(0, 40)));
      let gIndex;
      if (existing) {
        gIndex = existing.index;
      } else {
        runCitations.push(Object.assign({}, c, { index: runCitations.length + 1 }));
        gIndex = runCitations.length;
      }
      if (Number.isInteger(Number(c.index))) map[Number(c.index)] = Number(gIndex);
    }
    if (runCitations.length) emit({ type: 'citations', citations: runCitations.map((c: any) => Object.assign({}, c)) });
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
  const ctx = createAgentRunContext({
    book,
    settings,
    budget,
    browserMode: intent === INTENTS.BROWSER,
    canResume,
    tabId,
    payload,
    persisted,
  });
  trace({
    phase: 'start',
    intent,
    resumed: Boolean(canResume),
    instruction: String(instruction || '').slice(0, 200),
    pageUrl: ctx.pageUrl,
    budget: { maxTotalTokens: budget.maxTotalTokens, toolTimeoutMs: budget.toolTimeoutMs },
  });
  const allowedTools = intentInfo.allowedTools;
  const disabledTools = new Set<string>(
    canResume && Array.isArray(persisted.disabledTools) ? persisted.disabledTools : []
  );
  const collected = await collectAgentTools(settings, {
    allowedTools,
    includeMcp: intentInfo.includeMcp,
  });
  // MCP 工具索引随运行上下文传递（不再用模块级全局态，避免并发运行互相清空）。
  ctx.mcpIndex = collected.mcpIndex;
  // 每台服务器的连接结果也随运行上下文传递：工具调用失败时能说清「哪台连不上、为什么」，
  // 而不是笼统的「未知 MCP 工具」。同时异步落一份到 storage 供设置页展示最近一次结果。
  ctx.mcpStatus = collected.mcpStatus || [];
  persistMcpStatus(ctx.mcpStatus);
  let tools = collected.tools.filter((t) => t && t.function && !disabledTools.has(t.function.name));
  // 恢复时把已加载技能声明过的工具重新并入可用集合
  if (canResume) {
    for (const n of loadedSkillNames) {
      const sk = allSkills.find((s: any) => s.name === n || s.id === n);
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
  // MCP 服务器状态：告诉模型「配了哪些服务器、工具名前缀是什么、哪台连不上」。
  // 缺了这一段，工具列表里没有 MCP 工具时模型只会看到自己没有这类工具，
  // 于是把「服务器连不上」如实说成「我没有 MCP」——用户看到的就是「配置没生效」。
  const mcpSection = buildMcpStatusSection(ctx.mcpStatus);
  if (mcpSection) promptExtras += '\n\n' + mcpSection;
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
      (m: any) => !(m && m.role === 'system' && typeof m.content === 'string' && m.content.indexOf('【当前计划】') === 0)
    ));
  } else {
    const pickedList = canResume
      ? persisted.pickedElements || (persisted.pickedElement ? [persisted.pickedElement] : [])
      : payload.pickedElements || (payload.pickedElement ? [payload.pickedElement] : []);
    const built = buildInitialMessages(instruction, selectedText, ctx.page, ctx.pageUrl, payload.history, emit, systemPrompt, pickedList);
    messages = built.messages;
  }
  // 计划消息：以独立 system 消息插在系统提示之后，**整个 run 只注入一次**。
  //
  // 为什么不再每轮刷新：这条消息插在索引 1（系统提示之后、历史之前），一旦改写，
  // 从索引 1 开始的所有内容 —— 包括整段历史对话 —— 都变成新的请求前缀，
  // 服务端的前缀缓存全部失效，等于每完成一个子步骤就把整段历史重新 prefill 一遍。
  //
  // 计划更新本来就已经通过 update_plan 的**工具结果**回到模型（见 tools.js），
  // 那是 append-only 的，天然只影响新增部分。这里的注入只为「首轮 / 恢复运行」
  // 提供初始计划，注入之后不再改动。
  const injectPlanMessage = () => {
    if (!ctx.plan || !ctx.plan.length) return;
    const text = ctx.plan
      .map((p: any, i: any) => (p.status === 'done' ? '✓' : p.status === 'in_progress' ? '▶' : '○') + ' ' + (i + 1) + '. ' + p.text)
      .join('\n');
    messages.splice(1, 0, {
      role: 'system',
      content: '【当前计划】\n' + text + '\n（每完成一步用 update_plan 更新状态。）',
    });
  };
  injectPlanMessage();
  const resumeIteration = canResume
    ? Math.max(0, Number.isFinite(Number(persisted.nextIteration)) ? Number(persisted.nextIteration) : Math.max(0, Number(run.currentStep || 1) - 1))
    : 0;
  // 上一次出站请求的消息快照。每轮发出前与当前 messages 逐条比对：
  // 前缀必须是 append-only，否则从分叉点起的前缀缓存全部失效。
  // 这是静态门禁（scripts/check-prefix-stability.mjs）的运行时兜底 ——
  // 门禁做词法检查，看不到「循环内调用了一个内部会改写历史的函数」这种形态。
  let prevPrefixSnapshot = null;


  return {
    runId, persisted, canResume, sessionApprovedTools,
    instruction, selectedText, detected, intent, allSkills, loadedSkillNames,
    budget, promotedToResearch, startedAt, toolCallCount, totalTokens,
    verificationCount, lastDeniedSignature, ranToolNames, failedToolNames,
    succeededToolNames, deterministicFails, lastProgressIter, runCitations,
    guard, stuckAttempts, resultFingerprints, run, ctx, disabledTools, tools,
    promptExtras, messages, resumeIteration, prevPrefixSnapshot,
    emit, trace, reportTurnTiming, emitState, events, recordCitations,
  };
}

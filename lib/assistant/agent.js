// Agent 编排：流式对话 + 工具审批 + 工具调用循环
import { getToolMetadata, parseToolArgs, splitIntoChunks, validateToolCall, TOOL_REGISTRY } from './tools.js';
import { collectAgentTools, executeAnyTool } from './mcp.js';
import { createRun, transition, RUN_STATUS, TOOL_STATUS } from './agent-state.js';
import { loadAgentSession, saveAgentSession, removeAgentSession } from './session-store.js';
import { createStuckDetector } from './stuck-detector.js';
import { detectIntent, resolveIntent, buildSystemPrompt, INTENT_TURN_DEFAULTS, INTENTS } from './intent-router.js';
import { getMergedSkills } from './skills.js';

export const AGENT_BUDGET_DEFAULTS = Object.freeze({
  maxModelTurns: 10,
  maxToolCalls: 16,
  maxSameToolCalls: 3,
  maxOpenedTabs: 5,
  stuckWindow: 8,
  stuckWarnThreshold: 3,
  stuckStopThreshold: 5,
  maxDurationMs: 90000,
  toolTimeoutMs: 15000,
});

// 连续失败摘除阈值：非只读工具连续执行失败达到该次数，就从可用工具集移除，避免失败重试循环空耗工具调用数。
const TOOL_FAIL_STREAK_LIMIT = 2;

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
    budget.maxToolCalls = intent === INTENTS.BROWSER ? 22 : intent === INTENTS.RESEARCH ? 16 : intent === INTENTS.KNOWLEDGE ? 12 : 6;
  }
  if (source.maxOpenedTabs === undefined || source.maxOpenedTabs === null || source.maxOpenedTabs === '') {
    budget.maxOpenedTabs = intent === INTENTS.BROWSER ? 6 : intent === INTENTS.RESEARCH ? 4 : 3;
  }
  return budget;
}

function compactSessionMessages(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const system = source.find((message) => message && message.role === 'system');
  const tail = source.filter((message) => message !== system).slice(-39);
  while (tail[0] && tail[0].role === 'tool') tail.shift();
  return (system ? [system, ...tail] : tail).map((message) => {
    const copy = { role: message.role };
    if (typeof message.content === 'string') copy.content = message.content.slice(-12000);
    else if (message.content !== undefined) copy.content = message.content;
    if (Array.isArray(message.tool_calls)) copy.tool_calls = message.tool_calls.slice(-8);
    if (message.tool_call_id) copy.tool_call_id = message.tool_call_id;
    return copy;
  });
}

function buildInitialMessages(instruction, selectedText, page, pageUrl, history, emit, systemPrompt) {
  const messages = [{ role: 'system', content: systemPrompt || AGENT_SYSTEM_PROMPT }];
  for (const h of Array.isArray(history) ? history.slice(-10) : []) {
    if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') {
      messages.push({ role: h.role, content: h.content.slice(0, 3000) });
    }
  }
  const userParts = [];
  if (selectedText) userParts.push('选中的文本：\n' + selectedText);
  const pageCitations = [];
  if (page) {
    splitIntoChunks(page, 1000, 6).forEach((c, i) => {
      pageCitations.push({
        index: i + 1,
        source: 'page',
        title: c.replace(/\s+/g, ' ').trim().slice(0, 40),
        url: pageUrl || '',
        snippet: c,
      });
    });
    if (pageCitations.length) {
      emit({ type: 'citations', citations: pageCitations });
      userParts.push(
        '当前页面内容（引用具体内容时请用 [n] 标注对应块）：\n' +
          pageCitations.map((c) => '[' + c.index + '] ' + c.snippet).join('\n\n')
      );
    } else {
      userParts.push('当前页面内容（作为背景上下文）：\n' + page);
    }
  }
  if (instruction) userParts.push('用户指令 / 问题：\n' + instruction);
  if (!userParts.length) userParts.push('（无输入）');
  messages.push({ role: 'user', content: userParts.join('\n\n') });
  return messages;
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
export function toolNeedsApproval(name, settings = {}) {
  const meta = getToolMetadata(name);
  if (meta.requiresApproval !== true) return false;
  // 高风险工具（如 run_javascript）永远走逐次审批，不允许“按类别自动批准”放行。
  if (meta.alwaysRequireApproval === true) return true;
  const p = settings.toolApprovalPolicy || {};
  let category = 'commands';
  if (meta.risk === 'external') category = 'mcp';
  else if (meta.risk === 'browser' || meta.risk === 'network') category = 'browser';
  else if (meta.risk === 'write' || meta.risk === 'destructive') category = 'edit';
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

// 任务结束时清理 Agent 打开/接管的多余标签页：保留最后使用的 tab 与用户原本的 tab，
// 关闭其余本任务新开的中间页（搜索页、中转页等），避免 tab 越开越多。
async function closeAuxTabs(ctx) {
  if (!ctx || !Array.isArray(ctx.openedTabs) || !ctx.openedTabs.length) return [];
  const keep = new Set();
  if (Number.isInteger(Number(ctx.tabId))) keep.add(Number(ctx.tabId));
  if (Number.isInteger(Number(ctx.originalTabId))) keep.add(Number(ctx.originalTabId));
  const toClose = ctx.openedTabs.filter((id) => Number.isInteger(Number(id)) && !keep.has(Number(id)));
  if (!toClose.length) return [];
  try {
    await chrome.tabs.remove(toClose);
  } catch (e) {}
  ctx.openedTabs = ctx.openedTabs.filter((id) => !toClose.includes(id));
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

function waitForToolApproval(port, callId, name, args, signal, runId) {
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
      port.postMessage({ type: 'tool-call', runId, callId, name, args, requiresApproval: true, risk: getToolMetadata(name).risk });
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
async function streamAgentStep(port, settings, messages, signal, tools, emit) {
  const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = { model: settings.model, messages, temperature: 0.3, stream: true };
  // 仅在确有可用工具时附带 tools / tool_choice，避免空数组触发 API 400 而中断回答。
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  console.log('[RecallFlow] LLM fetch start:', settings.model, 'msgs=' + messages.length);
  // 60 秒超时：模型请求挂起时给出明确错误，而不是无限转圈。外部 signal（用户停止）仍按中断处理。
  const timeoutCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timedOut = false;
  const timer = timeoutCtrl ? setTimeout(() => { timedOut = true; timeoutCtrl.abort(); }, 60000) : null;
  const abortFromOutside = () => { if (timeoutCtrl) timeoutCtrl.abort(); };
  if (signal && timeoutCtrl) {
    if (signal.aborted) timeoutCtrl.abort();
    else signal.addEventListener('abort', abortFromOutside, { once: true });
  }
  let resp;
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
    console.log('[RecallFlow] LLM fetch done:', resp.status);
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (signal && timeoutCtrl) signal.removeEventListener('abort', abortFromOutside);
    if (timedOut) {
      return { error: '模型请求超时（60 秒），请检查网络连接或 API 服务后重试。' };
    }
    throw e; // 外部 abort（用户停止）交给上层按中断处理
  }
  if (timer) clearTimeout(timer);
  if (signal && timeoutCtrl) signal.removeEventListener('abort', abortFromOutside);

  if (!resp.ok) {
    let detail = '';
    try {
      const j = await resp.json();
      detail = j.error && j.error.message ? j.error.message : JSON.stringify(j);
    } catch (e) {
      detail = await resp.text();
    }
    return { error: 'DeepSeek 请求失败 (' + resp.status + '): ' + detail };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentAcc = '';
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
  return { assistantMessage, toolCalls };
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
  const instruction = canResume ? (persisted.instruction || '') : (payload.question || payload.command || payload.text || '');
  const selectedText = canResume ? (persisted.selectedText || '') : (payload.text || '');
  const detected = canResume && persisted.intent
    ? { intent: persisted.intent, confidence: 'medium', keyword: persisted.intentKeyword || '', reason: '已恢复上次任务意图' }
    : detectIntent(instruction, Array.isArray(payload.history) ? payload.history : [], { forceContinuation: payload.continuation === true });
  const intent = detected.intent;
  const intentInfo = resolveIntent(intent);
  const allSkills = await getMergedSkills();
  // 进阶版 A：技能不再预先注入正文，而是把全部技能做成「目录」交给模型自选；
  // 模型判断相关时通过常驻工具 load_skill 按需加载完整说明，加载后再把该技能声明的工具并入白名单。
  const loadedSkillNames = canResume && Array.isArray(persisted.skills) ? persisted.skills.slice() : [];
  const budget = canResume ? persisted.budget : getBudget(payload, settings, intent);
  const startedAt = canResume ? Number(persisted.startedAt || Date.now()) : Date.now();
  let toolCallCount = canResume ? Number(persisted.toolCallCount || 0) : 0;
  const toolFingerprints = new Map(canResume ? (persisted.toolFingerprints || []) : []);
  const toolFailStreak = new Map(canResume ? (persisted.toolFailStreak || []) : []);
  const run = canResume ? Object.assign(createRun(runId, budget), persisted.run || {}, { id: runId, budget }) : createRun(runId, budget);
  // 恢复时把状态重新置于 created，保证状态机从合法入口继续发事件。
  if (canResume) run.status = RUN_STATUS.CREATED;
  const emitState = (next, meta = {}) => {
    const state = transition(run, next, meta);
    emit({ type: 'agent-state', ...state, step: run.currentStep, maxSteps: budget.maxModelTurns });
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
  };
  const allowedTools = intentInfo.allowedTools;
  const disabledTools = new Set(canResume && Array.isArray(persisted.disabledTools) ? persisted.disabledTools : []);
  let tools = (await collectAgentTools(settings, {
    allowedTools,
    includeMcp: intentInfo.includeMcp,
  })).filter((t) => t && t.function && !disabledTools.has(t.function.name));
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
  const systemPrompt = buildSystemPrompt(
    intent,
    detected.sourceText || instruction,
    tools.map((t) => t.function && t.function.name),
    allSkills
  );
  const messages = canResume && Array.isArray(persisted.messages)
    ? persisted.messages
    : buildInitialMessages(instruction, selectedText, ctx.page, ctx.pageUrl, payload.history, emit, systemPrompt);
  const stuckDetector = createStuckDetector(budget);
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
      toolFingerprints: Array.from(toolFingerprints.entries()).slice(-80),
      toolFailStreak: Array.from(toolFailStreak.entries()).slice(-40),
      sessionApprovedTools: Array.from(sessionApprovedTools),
      messages: compactSessionMessages(messages),
      instruction,
      selectedText,
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
      ...extra,
    });
  };
  await persist({ status: RUN_STATUS.CREATED, phase: 'created', nextIteration: resumeIteration }).catch(() => {});

  for (let iter = resumeIteration; iter < budget.maxModelTurns; iter++) {
    if (Date.now() - startedAt >= budget.maxDurationMs) {
      emitState(RUN_STATUS.TIMEOUT, { reason: 'maxDurationMs' });
      emit({ type: 'budget-exceeded', reason: 'maxDurationMs', message: '任务执行超过安全时限，已停止。' });
      await finalizeWithPartialInfo(port, settings, messages, signal, emit);
      await persist({ status: RUN_STATUS.TIMEOUT, reason: 'maxDurationMs' }).catch(() => {});
      emit({ type: 'end' });
      return;
    }
    run.currentStep = iter + 1;
    // 新任务和恢复任务的第一轮都从 planning 重新建立合法状态链。
    emitState(iter === resumeIteration ? RUN_STATUS.PLANNING : RUN_STATUS.OBSERVING);
    await persist({ status: run.status, phase: 'model', nextIteration: iter }).catch(() => {});
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
      emit({ type: 'error', error });
      await persist({ status: RUN_STATUS.FAILED, error }).catch(() => {});
      return;
    }
    if (step.error) {
      emitState(RUN_STATUS.FAILED, { error: step.error });
      emit({ type: 'error', error: step.error });
      await persist({ status: RUN_STATUS.FAILED, error: step.error }).catch(() => {});
      return;
    }
    messages.push(step.assistantMessage);

    if (step.toolCalls.length) {
      for (const tc of step.toolCalls) {
        toolCallCount += 1;
        const metadata = getToolMetadata(tc.name);
        const fingerprint = tc.name + ':' + JSON.stringify(tc.args || {});
        const repeated = (toolFingerprints.get(fingerprint) || 0) + 1;
        toolFingerprints.set(fingerprint, repeated);
        // 只读观察工具（get_page_snapshot 等）在正常流程中会多次调用，
        // 同一工具限制只对变更类工具严格生效；只读工具交给 stuck detector 判定。
        const sameToolLimit = metadata.readOnly === true ? Math.max(5, budget.maxSameToolCalls) : budget.maxSameToolCalls;
        if (toolCallCount > budget.maxToolCalls || repeated > sameToolLimit) {
          const reason = repeated > sameToolLimit ? 'maxSameToolCalls' : 'maxToolCalls';
          messages.length = safeMessageLength;
          emitState(RUN_STATUS.TIMEOUT, { reason });
          emit({ type: 'budget-exceeded', reason, message: '工具调用达到安全上限，已停止。' });
          await finalizeWithPartialInfo(port, settings, messages, signal, emit);
          await persist({ status: RUN_STATUS.TIMEOUT, reason }).catch(() => {});
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
        if (settings.toolApproval !== false && toolNeedsApproval(tc.name, settings) && !sessionApprovedTools.has(tc.name)) {
          if (res) {
            // 参数不合法时不应再弹审批框。
          } else {
          toolState.status = TOOL_STATUS.APPROVAL_REQUIRED;
          emitState(RUN_STATUS.WAITING_APPROVAL, { callId, tool: tc.name });
          const decision = await waitForToolApproval(port, callId, tc.name, tc.args, signal, runId);
          // 高风险工具（alwaysRequireApproval，如 run_javascript）不支持“本次会话允许”，
          // 即使前端发了 session，也降级为仅本次通过，下次仍要逐次确认。
          if (decision === 'session' && getToolMetadata(tc.name).alwaysRequireApproval !== true) {
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
          try {
            res = await withTimeout(() => executeAnyTool(tc.name, tc.args, ctx), budget.toolTimeoutMs, signal);
          } catch (e) {
            res = { result: e.name === 'AbortError' ? '任务已取消。' : e.message, ok: false };
          }
          toolState.status = res.ok === false ? TOOL_STATUS.FAILED : TOOL_STATUS.SUCCEEDED;
          emit({ type: 'tool-result', callId, name: tc.name, status: 'completed', result: res.result });
          // 工具摘除机制（保证工具调用次数不过度浪费）：
          // 1) 资源型工具触顶（如 open_tab 预算用尽，res.blocked=true）→ 立即从工具集移除，禁止模型下轮再试；
          // 2) 非只读工具连续执行失败达到阈值 → 移除该工具，避免「失败→换参数重试→再失败」循环空耗预算。
          // 常驻工具（load_skill 等 alwaysAvailable）不参与摘除，避免破坏技能系统。
          if (metadata.alwaysAvailable !== true) {
            if (res && res.blocked === true) {
              if (!disabledTools.has(tc.name)) {
                disabledTools.add(tc.name);
                tools = tools.filter((t) => !(t.function && t.function.name === tc.name));
                emit({ type: 'tool-disabled', name: tc.name, reason: res.blockReason || '已达安全上限，禁止继续调用' });
              }
            } else if (metadata.readOnly !== true && res && res.ok === false && toolState.status === TOOL_STATUS.FAILED) {
              const streak = (toolFailStreak.get(tc.name) || 0) + 1;
              toolFailStreak.set(tc.name, streak);
              if (streak >= TOOL_FAIL_STREAK_LIMIT && !disabledTools.has(tc.name)) {
                disabledTools.add(tc.name);
                tools = tools.filter((t) => !(t.function && t.function.name === tc.name));
                emit({ type: 'tool-disabled', name: tc.name, reason: '连续 ' + streak + ' 次执行失败，已停止重试' });
              }
            } else {
              toolFailStreak.delete(tc.name);
            }
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
          emit({ type: 'citations', citations: res.citations });
        }
        if (res && Number.isInteger(Number(res.targetTabId))) {
          ctx.tabId = Number(res.targetTabId);
          if (res.targetTab) {
            ctx.pageUrl = res.targetTab.url || ctx.pageUrl;
            ctx.pageTitle = res.targetTab.title || ctx.pageTitle;
          }
          emit({ type: 'tab-switched', tabId: ctx.tabId, title: ctx.pageTitle, url: ctx.pageUrl });
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: res.result });
        const progress = toolResultProgress(res);
        if (progress) toolFingerprints.clear();
        // complete_task 是终止性工具：任务完成后立即结束，不再继续调用其他工具。
        if (res && res.complete === true) {
          const summary = String(res.result || '任务已完成。');
          // 模型已在本轮实时输出完成叙述时，不再重复输出 complete_task 的总结，
          // 避免“任务完成。任务已完成：…”式的重复；纯工具轮（无文本）才补充总结。
          if (!step.assistantMessage.content) emit({ type: 'chunk', text: summary });
          const closedTabs = await closeAuxTabs(ctx).catch(() => []);
          if (closedTabs && closedTabs.length) emit({ type: 'tabs-closed', tabIds: closedTabs });
          emitState(RUN_STATUS.COMPLETED, { tool: tc.name });
          await persist({ status: RUN_STATUS.COMPLETED, reason: 'complete_task' }).catch(() => {});
          emit({ type: 'end' });
          await removeAgentSession(runId).catch(() => {});
          return;
        }
        if (toolState.status !== TOOL_STATUS.REJECTED && validation.ok) {
          const guard = stuckDetector.observe({
            name: tc.name,
            args: tc.args,
            result: res,
            readOnly: metadata.readOnly === true,
            progress,
          });
          if (guard.level === 'warn') {
            emit({ type: 'stuck-warning', name: tc.name, message: guard.message, repeated: guard.repeated, noProgressStreak: guard.noProgressStreak });
          }
          if (guard.level === 'stop') {
            emitState(RUN_STATUS.TIMEOUT, { reason: 'stuck', tool: tc.name });
            emit({ type: 'budget-exceeded', reason: 'stuck', message: guard.message });
            await finalizeWithPartialInfo(port, settings, messages, signal, emit);
            await persist({ status: RUN_STATUS.TIMEOUT, reason: 'stuck', stuck: guard }).catch(() => {});
            emit({ type: 'end' });
            return;
          }
        }
        // 只在 assistant tool_call 已配套 tool_result 后保存，避免恢复时出现悬空 tool_call。
        await persist({ status: run.status, phase: 'after_tool', nextIteration: iter + 1 }).catch(() => {});
      }
      continue;
    }

    emitState(RUN_STATUS.COMPLETED);
    const closedTabs = await closeAuxTabs(ctx).catch(() => []);
    if (closedTabs && closedTabs.length) emit({ type: 'tabs-closed', tabIds: closedTabs });
    await persist({ status: RUN_STATUS.COMPLETED }).catch(() => {});
    emit({ type: 'end' });
    await removeAgentSession(runId).catch(() => {});
    return;
  }

  emitState(RUN_STATUS.TIMEOUT, { reason: 'maxModelTurns' });
  emit({ type: 'budget-exceeded', reason: 'maxModelTurns', message: '已达到最大推理轮数，任务已安全停止。' });
  await finalizeWithPartialInfo(port, settings, messages, signal, emit);
  await persist({ status: RUN_STATUS.TIMEOUT, reason: 'maxModelTurns' }).catch(() => {});
  emit({ type: 'end' });
}

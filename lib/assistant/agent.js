// Agent 编排：流式对话 + 工具审批 + 工具调用循环
import { getToolMetadata, parseToolArgs, validateToolCall, TOOL_REGISTRY, closeAgentWindow, recordTraceStep, compactSnapshotSummary } from './tools.js';
import { getAISettings } from '../shared/settings.js';
import { collectAgentTools, executeAnyTool } from './mcp.js';
import { isRetryableError } from './llm.js';
import { createRun, transition, RUN_STATUS, TOOL_STATUS } from './agent-state.js';
import { loadAgentSession, saveAgentSession, removeAgentSession } from './session-store.js';
import { createToolGuard } from './tool-guard.js';
import { detectIntent, resolveIntent, resolveIntentForAgent, buildSystemPrompt, INTENTS } from './intent-router.js';
import { getMergedSkills } from './skills.js';
import { detachAll as detachAllCdp } from '../backend/cdp.js';
import { getSiteHints } from './site-memory.js';
import { listMacros } from './macro-store.js';
import { collapseOldToolResults, estimateMessagesTokens, estimateTokens, normalizeHistory, isDuplicateInstruction, formatTailKeptTruncationNotice, HISTORY_MAX_CHARS } from './context.js';
import { snapshotMessages, diffSnapshots, formatPrefixReport } from './prefix-watch.js';
import { planParallelGroups } from './parallel-tools.js';
import { diagnoseConversation, repairConversation, formatProblems } from './conversation-guard.js';
import { appendTrace } from './trace.js';
import { verifyCompletion, buildVerificationReflection, buildStuckReflection } from './verifier.js';
import { checkCompletionClaim, buildDeterministicReflection } from './claim-check.js';
import { selectEvidence } from './evidence.js';
import { resolveCodeExecutionApproval } from '../shared/settings.js';
// 定位串的唯一实现（原先这里与 chat.js 各写一份，且其中一份有 bug —— 见该函数注释）。
import { formatElementLocator } from '../shared/utils.js';
import { buildInitialMessagesPure } from './initial-messages.js';
import { visionMessagesFor } from './vision.js';
// ⚠ 分两行导入：`vision-wiring.test.mjs` 会**钉住上面那一行的原文**
//（`import { visionMessagesFor } from './vision.js'`）—— 把新名字并进同一行会让那条门禁红 ✗。
// 按本仓库纪律：**改实现去符合门禁**，而不是放宽门禁 ✓
import { shouldSendImage, imageCapNote } from './vision.js';
// 出站消毒（孤立代理对）：所有请求的唯一出口都在本函数，兜底放这里。
import { sanitizeLoneSurrogates, sanitizeMessages, sliceSafe } from '../shared/surrogates.js';

export const AGENT_BUDGET_DEFAULTS = Object.freeze({
  // **没有轮数上限、没有工具数上限、没有任务时长上限**（对齐 DSH：dsh-agent-loop 里
  // 既没有 maxTurns 也没有 maxToolCalls，唯一的限制常量是并发度）。
  // 结束条件只有：complete_task / 模型给出最终回答 / 用户中断 / 成本兜底 maxTotalTokens。
  //
  // 原先的三道进度墙（maxModelTurns=30、maxToolCalls=40、maxDurationMs=180s）已移除：
  // 它们惩罚的是「任务确实很长」而不是「任务失控」。实测一次正常的「24 类工具冒烟测试」
  // 被工具墙硬停，用户被迫连说两次「继续」—— 每次「继续」都要重新建立上下文，更贵。
  //
  // 守卫侧的阈值：**只提醒、不否决**（详见 tool-guard.js）。
  repeatThresholds: [3, 5, 8],
  failThresholds: [2, 3, 5],
  noProgressThresholds: [3, 5, 8],
  excludeTools: ['update_plan'],
  maxOpenedTabs: 6,
  // 单个工具调用的超时（对齐 DSH 的 tool-call-timeout-policy：限制单点而非整体）。
  toolTimeoutMs: 15000,
  // 唯一保留的总量限制，而且是**成本**维度而非进度维度。
  // 保留它的理由：DSH 敢完全不设上限，是因为它有一整套替代品（压缩 / 溢出到可恢复路径 /
  // 委派给 subagent），且有用户在旁边随时打断；RecallFlow 的面板在后台跑，缺这个外部止损器。
  // 注意 totalTokens 累加的是**每次请求的用量**，而每轮都重发整段上下文，因此它超线性增长 ——
  // 不能用「单轮用量」估上限。按实测推导（CJK 1 token/字）：browser_task 每轮光工具定义约
  // 8.3k tokens；取 6M ≈ 正常峰值（数十万）的十几倍，只有真正的失控才会撞上。
  // 设为 0 表示不限制。
  maxTotalTokens: 6000000,
  // 完成前最多触发几次「独立校验未通过 → 反思重试」。
  maxVerifications: 2,
  // **唯一的存活兜底**：连续多少轮没有产生任何可观察进展就收尾。
  //
  // 为什么必须有它：移除三道进度墙之后，结束条件只剩 complete_task / 最终回答 /
  // 用户中断 / 6M token 成本闸门。守卫按设计只提醒不否决（tool-guard.js），
  // 于是一个陷入循环的 run 只能靠把 600 万 token 烧完才停 —— 而面板在后台跑，
  // 用户看不到也拦不住。这是「不设进度墙」的哲学里唯一没被搬过来的配套件。
  //
  // 与 DSH 的差别：DSH 不设上限是因为旁边有人随时能打断，且有压缩/溢出/委派等替代品；
  // 这里的定位是**外部止损器**，不是进度墙 —— 它有进展就永远不触发。
  maxNoProgressRounds: 12,
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
// 历史折叠阈值，按**token 估算**而不是字符数。
// 原先用 historyChars > 60000：中英文密度差约 4 倍，同样 6 万字符，
// 英文约 1.5 万 token 尚可接受，中文却接近 6 万 token —— 阈值对中文任务形同虚设。
const CONTEXT_COLLAPSE_TOKENS = 16000;

// 运行时自纠：当普通对话（CHAT）任务实际调用到研究/网络类工具时，
// 把任务画像就地提升为「资料研究」——补齐全套浏览器/网络工具，并把系统提示规则
// 切换成 RESEARCH 的（含 complete_task 收尾），而不是只放宽预算。
// 导出以便单测：画像提升时必须保留追加的系统提示段，这一点很容易在重构中被破坏。
export function promoteToResearch(tools, messages, instruction, allSkills, promptExtras) {
  const researchInfo = resolveIntent(INTENTS.RESEARCH);
  // 缓存代价：往 tools 里追加会让请求前缀在追加点之后重新计算。
  // 这一步没法省 —— 研究类工具不在 CHAT 的 schema 里，模型根本调用不了它们。
  // 之所以可以接受：由 !promotedToResearch 守卫，整个 run 最多发生一次；
  // 另一条路（CHAT 起手就带上全部研究工具）会让每一轮都多背几 k token，更亏。
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
  // 追加到末尾，**不覆写 messages[0]**。
  // messages[0] 是整段请求前缀的起点，改写它会让此前累积的全部前缀缓存失效、
  // 整段历史都要重新 prefill。追加是 append-only 的，只影响新增部分。
  // DeepSeek 的 Chat Completion 接口明确支持在对话中间插入 system 消息；
  // 位置更靠近当前轮，对模型行为的约束力也不弱于放在开头。
  // 调用方须保证此时 messages 末尾没有待配对的 tool_calls（否则 tool 结果会被隔开、请求非法）。
  messages.push({ role: 'system', content });
  return content;
}

function getBudget(payload = {}, settings = {}, intent) {
  const source = payload.agentBudget || settings.agentBudget || {};
  const budget = Object.fromEntries(Object.entries(AGENT_BUDGET_DEFAULTS).map(([key, value]) => {
    const n = Number(source[key]);
    return [key, Number.isFinite(n) && n > 0 ? Math.floor(n) : value];
  }));
  // 注意：这里原先还会按意图分配 maxModelTurns / maxToolCalls（浏览器任务多给、纯对话少给）。
  // 那两道**进度**上限已整体移除（对齐 DSH：不分意图地不限制「做了多少件事」），
  // 因此不再有按意图分配的东西可算。
  //
  // 唯一按意图分配的是「能开多少新标签页」—— 那是**副作用**边界（别把用户的标签栏塞满），
  // 不是进度预算，保留。
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

// 落盘快照的两条上限。**必须显式说明"少了什么"**：
// 这份快照在「继续上一次运行」时会被**原样恢复成发给模型的 messages**
//（见下方 canResume 分支），所以它里面的静默截断 = 模型看到一段没有开头的文本，
// 却以为那就是全部对话。原先两处都是静默的（content 静默 slice、超出 39 条静默丢弃）。
export const SESSION_MESSAGE_MAX_CHARS = 12000;
export const SESSION_MAX_TAIL_MESSAGES = 39;

export function compactSessionMessages(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const system = source.find((message) => message && message.role === 'system');
  const rest = source.filter((message) => message !== system);
  const tail = sanitizeToolPairing(rest.slice(-SESSION_MAX_TAIL_MESSAGES));
  const notices = [];
  // ① 整条消息被上限丢掉：补一条**可辨认的**说明，而不是让接手方以为对话就这么短。
  const droppedMessages = rest.length - Math.min(rest.length, SESSION_MAX_TAIL_MESSAGES);
  if (droppedMessages > 0) {
    notices.push({
      role: 'user',
      content:
        '⟨…更早的 ' + droppedMessages + ' 条消息未随快照保存（落盘上限 ' + SESSION_MAX_TAIL_MESSAGES +
        ' 条）；**这些消息取不回原文**，需要时请让用户重新说明上下文。⟩',
    });
  }
  const compacted = tail.map((message) => {
    const copy = { role: message.role };
    if (typeof message.content === 'string') {
      // ② 单条超长：留尾（结论通常在后面），并**前置**说明被截掉的是开头那段。
      copy.content =
        message.content.length > SESSION_MESSAGE_MAX_CHARS
          ? formatTailKeptTruncationNotice(message.content.length, SESSION_MESSAGE_MAX_CHARS) +
            message.content.slice(-SESSION_MESSAGE_MAX_CHARS)
          : message.content;
    } else if (message.content !== undefined) copy.content = message.content;
    if (Array.isArray(message.tool_calls)) copy.tool_calls = message.tool_calls.slice(-8);
    if (message.tool_call_id) copy.tool_call_id = message.tool_call_id;
    return copy;
  });
  return (system ? [system, ...notices, ...compacted] : [...notices, ...compacted]);
}

function buildInitialMessages(instruction, selectedText, page, pageUrl, history, emit, systemPrompt, pickedElements) {
  // 历史归一化与「去掉与当前指令重复的尾部 user 消息」留在原处（它依赖 normalizeHistory）。
  // ⚠ noticeOnTruncation **必须**传 true：不传时"更早的对话被裁掉"对模型完全不可见
  //（它会把"只剩最近几轮"当成"对话本来就这么短"）。历史上这个开关只被测试用过，
  // 生产两处调用（这里与 shared/rag.js）都没打开 ⇒ 提示一次也没出现过（实测 20 条 / maxMessages=3 ⇒ 0 次）。
  let normalized = normalizeHistory(history, {
    maxMessages: 10,
    maxChars: HISTORY_MAX_CHARS,
    maxTokens: 8000,
    noticeOnTruncation: true,
  });
  // 前端发送完整 conversation（含刚 push 的当前指令），去掉与当前指令重复的尾部 user 消息，
  // 避免指令在历史与本次输入里各出现一次。
  const instr = String(instruction || '').trim();
  if (normalized.length && normalized[normalized.length - 1].role === 'user') {
    // ⚠ 判据不能再用 `last.length === 3000` 这个**字面量**：
    // 本条历史一旦被截断，normalizeHistory 会在后面追加一条通知（长度、内容都变了），
    // 于是那个等式静默失效 ⇒ 当前指令在请求里出现两次（历史一条 + 本次输入一条）。
    // 现在两者共用 context.js 的同一形态（有单测，见 tests/context.test.mjs）。
    if (isDuplicateInstruction(normalized[normalized.length - 1].content, instr)) {
      normalized = normalized.slice(0, -1);
    }
  }

  // 选取元素的元数据块（格式化留在这里，装配交给纯函数）。
  const picks = Array.isArray(pickedElements) ? pickedElements.filter(Boolean) : [];
  const pickedBlocks = picks.map((p, i) => {
    const src = p.source || {};
    const loc = src.file
      ? src.file + (src.line ? ':' + src.line + (src.column ? ':' + src.column : '') : '') + (src.framework ? '（' + src.framework + (src.component ? ' · ' + src.component : '') + '）' : '')
      : '';
    const l = p.locator || {};
    const head = picks.length > 1 ? '选取的元素 ' + (i + 1) + '（请针对它回答/操作）：' : '用户在页面上选取的元素（请针对它回答/操作）：';
    const lines = [head];
    // 语义定位串走共用实现（本处的输出与原先**逐字一致**，只是不再各写一份）。
    if (l.role || l.name) lines.push('- 语义定位：' + formatElementLocator(l));
    if (l.testid) lines.push('- testid：' + l.testid);
    if (p.selector) lines.push('- CSS 选择器：' + p.selector);
    if (p.tag) lines.push('- 标签：' + p.tag);
    if (p.text) lines.push('- 文本：' + String(p.text).slice(0, 120));
    if (Array.isArray(p.ancestors) && p.ancestors.length) lines.push('- 祖先链：' + p.ancestors.join(' > '));
    if (p.inShadow) lines.push('- 位于 Shadow DOM 内');
    lines.push(loc ? '- 前端源码位置：' + loc : '- 未检测到框架源码位置（可能为生产构建）');
    return lines.join('\n');
  });

  // 装配交给纯函数：不可信内容（页面正文 / 选中文本 / 元素元数据）用显式定界符封闭，
  // 用户指令放在最后并单独标注。原实现把页面与指令拼在同一条消息里、中间只隔一个换行，
  // 结构上无法区分，注入全靠一句软规则兜着。
  const messages = buildInitialMessagesPure({
    systemPrompt,
    history: normalized,
    instruction: instr,
    selectedText,
    page,
    pickedBlocks,
  });
  return { messages, pageCitations: [] };
}

function withTimeout(task, timeoutMs, signal, toolName) {
  return new Promise((resolve, reject) => {
    let settled = false;
    // timer 先声明为 null：原先 `finish` 里直接引用后面才 `const` 的 timer，
    // 一旦有任何路径在 setTimeout 之前调用 finish，就会撞上 TDZ 抛 ReferenceError。
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new DOMException('任务已取消', 'AbortError'));
    timer = setTimeout(() => {
      const err = new Error('工具执行超时');
      // 打上标记，让调用方能把它与「工具自己抛的错」区分开 ——
      // 两者的含义完全不同：超时意味着**后果未知**，不是干净失败。
      err.rfToolTimeout = true;
      err.timeoutMs = timeoutMs;
      err.toolName = String(toolName || '');
      finish(reject, err);
    }, timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(task).then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}

/**
 * 工具异常 → 给模型看的说明（纯函数，便于直测）。
 *
 * 为什么要单独抽出来：原先调用点只写 `{ result: e.message, ok: false }`，
 * 于是超时只会显示「工具执行超时（15000ms）」—— 既没说清**超时不是干净失败**
 * （动作可能已经部分生效），也没给出下一步该做什么。模型很容易据此原样重试，
 * 而重试一个「可能已经做了」的写操作是危险的。
 */
export function describeToolFailure(e, toolName) {
  const name = String(toolName || '');
  if (e && e.name === 'AbortError') return '任务已取消。';
  if (e && e.rfToolTimeout === true) {
    const secs = Math.round((Number(e.timeoutMs) || 0) / 1000);
    return (
      '工具「' + name + '」执行超时（' + secs + ' 秒）。' +
      '**注意：超时只表示我们不再等它，不代表动作没有发生** —— 它可能已经部分生效。' +
      '请先重新读取页面确认当前状态（如 get_page_snapshot），再决定是重试、换做法还是就此停手；' +
      '不要在未确认的情况下原样重试。'
    );
  }
  const raw =
    e && e.message
      ? e.message
      : e === undefined || e === null
        ? '未知错误（工具没有给出原因）'
        : String(e);
  return '工具「' + name + '」执行失败：' + raw;
}

/**
 * 大结果被截断时追加的**通知**（模型据此知道"全文还在、可以取回"）。
 *
 * 为什么单独抽成函数：这条通知的格式**被另一个模块用正则解析**
 *（`context.js` 的 `ID_NOTICE_RE` 负责在历史折叠时把 id 抠出来重写一遍）。
 * 两边任何一处改了措辞，id 就会**静默消失** —— 症状只是"模型没去取全文"，
 * 看起来像它偷懒，实际是链接断了。抽成单一来源后，格式只有一个地方可改，
 * 而 `tests/expand-result.test.mjs` 用**真实的这条字符串**测那条链路。
 */
export function formatTruncationNotice(totalChars, id) {
  return (
    '\n…（结果共 ' + totalChars + ' 字符，已截断；完整内容 id=' + id +
    '，可用 expand_result(id="' + id + '") 分段读取）'
  );
}

/**
 * 现读「审批相关」的设置，覆盖运行开始时那份快照里的对应字段。
 *
 * 为什么必须有它：`settings` 是**本次运行开始时**读的一份快照（background.js 在
 * `runAgentStream` 之前 `getAISettings()` 一次），而审批开关就在面板输入框上方，
 * 用户**对话进行中随时会改**。只读快照的后果是两个方向的错：
 *   · 关掉之后还在弹 ——「我明明开了自动批准，它还是一个一个问」（用户实测报的就是这个）；
 *   · 打开之后不再问 —— 更糟：快照说"无需审批"，于是一次本该确认的写操作**直接执行**。
 * 所以每次决策都现读，而不是每次运行读一次。
 *
 * 只现读审批用到的四个字段，**不动工具 schema** —— schema 是请求前缀的一部分，
 * 中途改动会让整段前缀缓存失效（见 disabledTools 那段的说明），而审批与 schema 无关。
 *
 * 读失败时**沿用快照**：宁可多确认一次，也不能因为"读设置失败"而放行写操作（fail-closed）。
 */
export async function readLiveApprovalSettings(base, loader) {
  const get = typeof loader === 'function' ? loader : getAISettings;
  const snapshot = base && typeof base === 'object' ? base : {};
  try {
    const s = (await get()) || {};
    return Object.assign({}, snapshot, {
      toolApproval: s.toolApproval,
      toolApprovalPolicy: s.toolApprovalPolicy || {},
      trustedSites: Array.isArray(s.trustedSites) ? s.trustedSites : [],
      codeExecutionApproval: s.codeExecutionApproval,
    });
  } catch (e) {
    return snapshot;
  }
}

// 只放行纯读取类工具。其余工具可能写入本地数据、改变浏览器状态、访问外部服务，
// 按 Cline 的交互模式交由前端取得用户明确批准后再执行。
// ⚠ 传入的 `settings` 必须已经过 readLiveApprovalSettings 现读（见该函数的说明）。
export function toolNeedsApproval(name, settings = {}, pageUrl = '') {
  const meta = getToolMetadata(name);
  if (meta.requiresApproval !== true) return false;
  // 「任意代码执行」类工具（run_javascript / run_userscript / install_userscript）：
  // 默认进入审批流程；用户可在设置中选择「本任务内允许」或「自动批准」。
  // 注意：'session' 仍需弹一次审批，之后由会话级放行（sessionApprovedTools）跳过；'auto' 完全不弹。
  // 这一档**不参与** toolApprovalPolicy 的类别自动批准，也不受站点信任影响。
  if (meta.alwaysRequireApproval === true) {
    return resolveCodeExecutionApproval(settings) !== 'auto';
  }
  // 站点信任：已信任站点的写操作不再逐次确认。
  if (pageUrl) {
    try {
      const origin = new URL(pageUrl).origin;
      const trusted = Array.isArray(settings.trustedSites) ? settings.trustedSites : [];
      if (origin && trusted.includes(origin)) return false;
    } catch (e) {}
  }
  // 有意**不**做的一件事：不因为「本次提示里含不可信页面内容」就强制所有写操作逐次审批。
  //
  // 理由：那会让两处用户显式设置（trustedSites 站点信任、toolApprovalPolicy 类别自动批准）
  // 被一条不可见的规则悄悄推翻 —— 用户在设置里勾了"信任这个站点"，却因为当前页面碰巧
  // 含某段文字而反复弹窗，且他无从知道原因。**不可预测的审批比没有审批更糟**：
  // 用户会学会无脑点"同意"，而真正的风险时刻就混在这些弹窗里被点掉了。
  //
  // 注入的防线应当放在**结构**上（见 lib/assistant/initial-messages.js：数据用定界符封闭、
  // 指令带随机校验标记），而不是在审批环节无差别加闸。若将来要做上下文相关加闸，
  // 前提是同时给出**可见的理由**（面板里说明"本任务含不可信页面内容"），
  // 让用户能理解为什么这次不同 —— 那是一次独立的产品决定。
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

/**
 * 存活看门狗（纯函数，便于直测边界语义）。
 *
 * 判定「本任务是否已经不再产生任何可观察进展」。它与 token 成本闸门是**互补**的：
 * 成本闸门管"花了多少钱"，它管"是不是卡住了" —— 一个卡住的任务可能几轮就烧掉大量 token，
 * 也可能因为每轮都很小而烧得慢却永远不回结果。
 *
 * 语义：
 *   - 尚未有过任何进展（lastProgressIter 为 null）时，以起点为基准，不会一开工就判定卡死；
 *   - 只要有过进展就重置基准，**正常的长任务永远不会触发**（这是它不构成"进度墙"的关键）；
 *   - maxNoProgressRounds 为 0/负数/非数字表示不启用（沿用本仓库"高上限兜底、非正常态硬墙"的原则）。
 *
 * @param {Object} input
 * @param {number} input.iter 当前迭代下标（从 0 起）
 * @param {number|null} input.lastProgressIter 最近一次有进展的迭代下标
 * @param {number} input.maxNoProgressRounds 允许的无进展轮数上限
 * @returns {{stalled:boolean, reason:string, noProgressRounds:number}}
 */
export function evaluateLiveness(input = {}) {
  const iter = Number(input.iter);
  const cap = Number(input.maxNoProgressRounds);
  const base = Number.isFinite(Number(input.lastProgressIter)) ? Number(input.lastProgressIter) : 0;
  const safeIter = Number.isFinite(iter) && iter > 0 ? iter : 0;
  const noProgressRounds = Math.max(0, safeIter - base);
  if (!Number.isFinite(cap) || cap <= 0) return { stalled: false, reason: '', noProgressRounds };
  if (noProgressRounds >= cap) return { stalled: true, reason: 'noProgress', noProgressRounds };
  return { stalled: false, reason: '', noProgressRounds };
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

// 完成前校验的证据来源。
//
// 读类工具给的是「页面现在长什么样」；有副作用的动作给的是「刚刚发生了什么」。
// 原实现只采集 4 个读类工具的结果，于是「划出关键信息」这类任务里，校验器拿到的
// 要么是空证据、要么是动作**之前**读到的页面 —— 它只能判未达成，进而把 agent 逼去
// 用 run_javascript 手工做 DOM 取证（实测撞满每工具上限，complete_task 被否决两次）。
const EVIDENCE_READ_TOOLS = new Set([
  'read_current_page',
  'get_page_snapshot',
  // inspect_element 是 C-4 合并后的元素检查入口（原 get_element_text / inspect_element / extract_table 三者）。
  // 名单里必须保留它，否则「划出关键信息」这类任务的完成校验会重新丢掉文本证据。
  'inspect_element',
  'get_ax_snapshot',
  // expand_result 也必须算：它读出的正是「模型实际看到的内容」。
  // 原先不在名单里，于是模型展开了长文的后半段，完成校验却对此一无所知 ——
  // 证据和模型看到的东西对不上，这是长页面任务被误否的直接原因之一。
  'expand_result',
]);

// 导出以便单测：证据采集规则直接决定完成前校验能否通过，
// 而它出错的症状（校验器永远判未达成 → agent 手工取证）离代码很远。
export function evidenceAfter(prev, tc, res, summarizeArgs) {
  const text = res && typeof res.result === 'string' ? res.result : '';
  if (!text) return prev;
  // 证据文本同样来自页面原文 —— 按码元下标切会切裂代理对（见 surrogates.js 的事故说明）。
  if (EVIDENCE_READ_TOOLS.has(tc.name)) return sliceSafe(text, 0, 3000);
  let metadata = null;
  try {
    metadata = getToolMetadata(tc.name);
  } catch (e) {
    metadata = null;
  }
  // 只读动作（截图等）不改变页面，不能当作「做了事」的证据
  if (metadata && metadata.readOnly === true) return prev;
  // 有副作用的动作：把回执本身作为证据。失败也要记 —— 「最后一步失败了」
  // 对校验器同样是关键信息，隐瞒它只会换来一次被否决的 complete_task。
  return (
    '【最近一次页面动作】' + tc.name + (res.ok === false ? '（执行失败）' : '（已执行成功）') + '\n' +
    '参数：' + summarizeArgs(tc.args) + '\n' +
    '返回：' + text.slice(0, 2000) +
    '\n（备注：若同时提供了页面快照，那份快照是在本动作之前采集的。）'
  );
}

// 是否需要「完成前独立校验」：仅对会操作页面的浏览器/研究类任务、且确实调用过工具时启用。
//
// 导出是为了直接测这条**成本策略**（原先是模块内私有、零覆盖）：
// 它决定"什么时候多花一次模型调用"，答错的代价是**每次收尾都白花一次调用**，
// 或者反过来该校验时不校验。
export function shouldVerifyCompletion(intent, toolCallCount, settings) {
  if (!settings || settings.verifierEnabled === false) return false;
  if (!settings.apiKey) return false;
  if (!toolCallCount) return false;
  return intent === INTENTS.BROWSER || intent === INTENTS.RESEARCH;
}

// 动作回执在证据里的上限。回执本身很短（工具名 + 参数 + 返回值摘要），
// 给它留固定额度是为了不挤占页面片段的预算。
const EVIDENCE_RECEIPT_CHARS = 1800;

/**
 * 组装送给完成校验的证据。
 *
 * **两份都要给，缺一不可**（这是修过一次的回归）：
 * - `ctx.lastEvidence` 是「最近一次动作的回执」，回答**刚刚做了什么**
 *   （如「【最近一次页面动作】annotate({op:"highlight"})（已执行成功）… 返回：已高亮 12 / 12 处关键信息」）；
 * - `selectEvidence` 抽出的页面片段回答**结论与页面是否一致**。
 *
 * 曾经改成只用页面片段（把 lastEvidence 当作「没有全文时的退路」），
 * 结果有副作用的动作回执被整个挤掉 —— 校验方看不到「刚做了什么」，
 * 于是怀疑高亮是否真的存在，agent 又花十几次调用自证。
 * 纯函数，导出以便直接测「两者同时在场」这条装配性质。
 */
export function buildVerificationEvidence(ctx, claim) {
  const parts = [];
  if (ctx.lastSnapshot) parts.push(compactSnapshotSummary(ctx.lastSnapshot));
  const receipt = String(ctx.lastEvidence || '').slice(0, EVIDENCE_RECEIPT_CHARS);
  if (receipt) parts.push('【最近一次动作的回执】\n' + receipt);
  const picked = selectEvidence({
    fullText: ctx.lastReadFullText,
    fallback: ctx.lastEvidence,
    claim: String(claim || ''),
  });
  if (picked.text) parts.push('【页面相关片段】\n' + picked.text);
  if (picked.coverage) parts.push(picked.coverage);
  return parts.join('\n\n');
}

// 用最近页面证据做一次独立校验，判断目标是否真的达成。
//
// 证据不能只给「页面前 N 个字」：长页面上结论依据的事实往往在深处，校验方找不到就按
// 「证据不足」否决，把 agent 逼去做无谓的重新取证。这里改为按结论里的具体事实定位片段
// （selectEvidence），并显式告诉校验方「这是片段、不是全文」以及本次任务的性质。
async function runCompletionVerification(settings, instruction, res, ctx, signal, taskKind) {
  return verifyCompletion(
    settings,
    {
      instruction,
      claim: String((res && res.result) || ''),
      evidence: buildVerificationEvidence(ctx, String((res && res.result) || '')),
      pageUrl: ctx.pageUrl,
      pageTitle: ctx.pageTitle,
      taskKind: taskKind || 'mutation',
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
async function finalizeWithPartialInfo(port, settings, messages, signal, emit, tools) {
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
  // 收尾请求是**最后一道关口**，必须自己校验一次结构：
  // 它绕过了主循环里的出站校验（那是挂在 streamAgentStep 调用点上的），
  // 而调用它的路径恰恰都是"半途中断"——卡住检测 stop、工具预算触顶、时长/成本超限。
  // 这些时刻 messages 很可能停在「assistant 声明了 N 个 tool_call，只答复了前 k 个」，
  // 直接发出去就是一个空响应体的 400，用户连收尾建议都拿不到。
  const problems = diagnoseConversation(finalMessages);
  if (problems.length) {
    const repaired = repairConversation(finalMessages);
    console.log('[RecallFlow] 收尾请求的会话结构非法，已修复：' + formatProblems(problems) + '（' + finalMessages.length + ' → ' + repaired.length + ' 条）');
    finalMessages.length = 0;
    for (const m of repaired) finalMessages.push(m);
    emit({ type: 'verify', ok: null, reason: '收尾请求的历史结构与工具调用配对不一致，已自动修正后重试。' });
  }
  try {
    // 关键：照样把当前 tools 数组发出去，只用 tool_choice='none' 禁止继续调工具。
    // 传空数组会让请求从 token 0 就与前面各轮不同（工具定义是前缀的一部分），
    // 于是本次要重新 prefill 整段历史 —— 而这是整个 run 里最长的一次请求。
    const callFinalize = (withTools) =>
      withTimeout(
        () => streamAgentStep(port, settings, finalMessages, signal, withTools ? tools || [] : [], emit, withTools ? 'none' : undefined),
        25000
      );
    let step = await callFinalize(true);
    // 兜底：「带 tools 但 tool_choice=none」是官方文档写明支持的组合，但不同 API 世代
    // 未必一致。一旦它被 400 拒绝，用户就彻底拿不到收尾建议了 ——
    // 前缀缓存是优化，能拿到结论才是功能，所以这里退回改动前的写法重试一次。
    if (step && step.error && /\b400\b/.test(String(step.error))) {
      console.log('[RecallFlow] finalize 带 tools 被拒（400），退回无 tools 重试');
      emit({ type: 'verify', ok: null, reason: '收尾请求带工具定义被服务端拒绝，已退回无工具模式重试。' });
      step = await callFinalize(false);
    }
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
/**
 * 把「流式过程中已累积的内容」组装成一个**结构合法**的 assistant 消息（纯函数，便于直测）。
 *
 * 用途：中断（用户停止 / 端口断开 / worker 被回收）时，把这一轮模型已经产出的东西
 * 保留下来供恢复使用。原先中断会把它们全部丢弃，于是若中断发生在"正在生成"的瞬间，
 * 就没有任何可续跑的状态 —— 恢复只能从头开始。
 *
 * 为什么必须校验：tool_calls 的 arguments 是**流式分片累积**的，中断时很可能只有半截 JSON。
 * 半截 JSON 直接塞进历史会让下一次请求非法（服务端只回一个空 400），比丢掉更糟。
 * 因此：解析失败的分片一律丢弃，只保留能解析完整的调用；并按 OpenAI 要求补齐 id。
 *
 * @returns {{assistantMessage: object}|null} 无内容时返回 null（没什么可保留的）
 */
export function buildPartialStep(contentAcc, toolAcc) {
  const content = String(contentAcc || '');
  const raw = Array.isArray(toolAcc) ? toolAcc : [];
  const toolCalls = [];
  for (const t of raw) {
    if (!t || !t.name) continue;
    let args;
    try {
      args = t.args ? JSON.parse(t.args) : {};
    } catch (e) {
      // 半截 JSON：丢弃这个调用（保留它会让下一次请求非法）
      continue;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    toolCalls.push({
      id: t.id || 'partial-' + toolCalls.length,
      type: 'function',
      function: { name: String(t.name), arguments: JSON.stringify(args) },
    });
  }
  if (!content && !toolCalls.length) return null;
  const assistantMessage = { role: 'assistant', content };
  if (toolCalls.length) assistantMessage.tool_calls = toolCalls;
  return { assistantMessage };
}

/**
 * 读取失败响应的说明文字。
 *
 * ⚠ 顺序很重要：**先 text() 再尝试 JSON.parse**，绝不能反着来。
 * 实测（2026-10-16 的线上 400）：服务端对「请求体解析失败」回的是**纯文本**，
 * 先 `resp.json()` 会抛错 —— 而那时响应体**已经被读走**，紧接着的 `resp.text()`
 * 抛 "Body is unusable: Body has already been read"，被 `.catch(() => '')` 吞掉。
 * 结果错误信息在冒号后面空着，看起来像"服务端什么都没说"，把排查引向"结构非法"的
 * 方向（而真正的原因就写在被丢掉的那句话里）。
 *
 * @returns {Promise<{detail:string, parsed:boolean}>} parsed = 响应体是不是 JSON
 */
async function readErrorDetail(resp) {
  let raw = '';
  try {
    raw = await resp.text();
  } catch (e) {
    raw = '';
  }
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return { detail: '', parsed: false };
  try {
    const j = JSON.parse(text);
    const msg = j && j.error && j.error.message ? j.error.message : JSON.stringify(j);
    return { detail: String(msg), parsed: true };
  } catch (e) {
    return { detail: text, parsed: false };
  }
}

/**
 * 这个 400 是不是「请求体在解析阶段就被拒」。
 *
 * 特征：状态 400 + 响应体**不是 JSON**（服务端连结构化错误都没来得及给）。
 * 为什么要单独认这一类：它的**默认推断方向是错的**（人看到 400 先怀疑"结构非法"，
 * 而实测的根因是**内容里有服务端解析不了的字符**：切裂的代理对）。
 * 认出来之后只在报错里补一句"这是解析阶段拒的、字段路径在哪、本机消毒结果如何"，
 * 不重试 —— 发送前的出站消毒已经跑过了，重发同一份内容没有意义。
 */
function isBodyParseRejection(status, parsed, detail) {
  if (status !== 400 || parsed) return false;
  return /parse the request body|invalid ?json|unexpected (?:end of|token|character)|hex escape|surrogate/i.test(
    String(detail || '')
  );
}

export async function streamAgentStep(port, settings, messages, signal, tools, emit, toolChoice) {
  const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = { model: settings.model, messages, temperature: 0.3, stream: true, stream_options: { include_usage: true } };
  // 出站消毒（**所有模型请求都从这里走**，所以兜底放在这一处最省）。
  //
  // 为什么必须兜：内容里只要有一个孤立代理（切裂的代理对），服务端在**解析请求体**阶段
  // 就会整单拒收 400，而且 400 不重试 ⇒ 整个 run 一次即死；坏内容还留在历史里，
  // 续跑必然再炸。实测就是表格单元格按 60 个 UTF-16 码元截断切裂了论文里的 𝑦/𝒜（见
  // lib/shared/surrogates.js 的完整事故说明）。切片点已全部改成 sliceSafe，这里是第二道：
  // 页面回给我们的文本（run_javascript 的返回值、innerText 切片）我们控制不了。
  //
  // 就地改历史（而不是只改这次请求）：坏内容留在历史里等于每轮都再炸一次。
  // 代价是历史中部被改写会让前缀缓存从改写点起失效 —— 但只在真发现孤立代理时发生，
  // 那种情况下"缓存失效"远好于"整轮报废"。
  const cleaned = sanitizeMessages(messages);
  if (cleaned.count) {
    console.log('[RecallFlow] 出站前清理非法 Unicode（孤立代理对）：' + cleaned.count + ' 处');
    if (typeof emit === 'function') {
      emit({ type: 'verify', ok: null, reason: '请求体里发现非法字符（孤立代理对），已自动清理后继续（共 ' + cleaned.count + ' 处）。' });
    }
  }
  // 仅在确有可用工具时附带 tools / tool_choice，避免空数组触发 API 400 而中断回答。
  // toolChoice 用来区分「正常推理（auto）」与「收尾成文（none）」：
  // 收尾那次请求必须带着**同一份** tools 才能复用前面所有轮的请求前缀缓存，
  // 靠 tool_choice: 'none' 来禁止它继续调工具（官方：none 表示模型不会调用任何 tool）。
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
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
  // 计时起点必须在 fetch **之前**：SSE 是「响应头先到、token 后到」，
  // 只从拿到响应头开始算，会把网络往返和排队时间整个漏掉（实测会算成 1ms）。
  let requestStartAt = Date.now();
  try {
    // 重试仅覆盖「尚未向界面输出任何内容」的阶段，因此不会造成重复输出。
    for (let attempt = 0; ; attempt++) {
      let timedOut = false;
      const timer = timeoutCtrl ? setTimeout(() => { timedOut = true; timeoutCtrl.abort(); }, timeoutMs) : null;
      requestStartAt = Date.now();
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

      // 服务端错误：先取详情（**先 text 再 JSON.parse**，理由见 readErrorDetail），
      // 再按可重试性（429 / 5xx / 网络错误）决定是否重试。
      const info = await readErrorDetail(resp);
      let detail = info.detail;
      const bodyParseRejected = isBodyParseRejection(resp.status, info.parsed, info.detail);
      // 400 一定是「请求本身有问题」。这里补上本次请求的**形状**（只有角色序列与计数，
      // 不含任何消息内容）作为兜底：真有"结构非法"时，形状是唯一能一眼看出的线索。
      //
      // ⚠ 2026-10-16 更正：曾经把"冒号后空白"当成"服务端不给原因"的证据，
      // 并据此认定这是**结构**问题。实际上服务端一直给了原因（纯文本），
      // 是旧写法先 json() 再 text() 把响应体读废了（见 readErrorDetail）。
      // 形状仍然有用，但**不再当成"服务端没说"的推断依据**。
      if (resp.status === 400) {
        const roles = (Array.isArray(messages) ? messages : [])
          .map((m) => {
            if (!m || !m.role) return '?';
            return m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length ? 'asst(tc)' : m.role;
          })
          .join(',');
        detail +=
          (detail ? ' ' : '') +
          '[请求形状：model=' + body.model +
          ' messages=' + (Array.isArray(messages) ? messages.length : 0) +
          ' roles=' + roles.slice(-400) +
          ' tools=' + ((body.tools && body.tools.length) || 0) +
          ' tool_choice=' + (body.tool_choice || '-') +
          ' stream=' + body.stream + ']';
        // 「解析阶段被拒」单独说一句，是因为它的**默认推断方向是错的**：
        // 这类 400 最常见的原因不是"结构非法"，而是**内容里有服务端解析不了的字符**
        //（实测：被切裂的代理对 —— 见 lib/shared/surrogates.js）。而本次发送前刚刚
        // 做过一次出站消毒，所以这里能顺带告诉排查者"历史里还有没有这种字符"，
        // 省掉"再猜一轮结构"的返工。
        if (bodyParseRejected) {
          detail +=
            '（服务端在【解析请求体】阶段就拒绝了，上面那句原话里的字段路径就是出错位置；' +
            (cleaned.count
              ? '本次发送前已清理 ' + cleaned.count + ' 处孤立代理，仍被拒 ⇒ 原因在别处。'
              : '本次发送前未发现孤立代理 ⇒ 原因在别处，请按字段路径排查。') +
            '）';
        }
      }
      const err = new Error('DeepSeek 请求失败 (' + resp.status + '): ' + detail);
      err.status = resp.status;
      err.bodyParseRejected = bodyParseRejected;
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
  // 思维链累积（只有推理模型会发 delta.reasoning_content，如 deepseek-reasoner）。
  //
  // ⚠ **它只用于展示，绝不写回 messages。** 两个理由，任一条都足够：
  //   ① 前缀缓存：把思维链塞进 assistant 消息会改写请求前缀，历史全部重新 prefill；
  //   ② 协议：reasoning_content 不是可回传字段，回传会被 API 拒绝或忽略。
  // 因此这里只累积 + emit 给面板，assistantMessage 里**不带**它。
  let reasoningAcc = '';
  const toolAcc = [];
  // 分阶段计时：一次模型请求可以拆成三段 ——
  //   ① 到响应头（网络往返 + 服务端排队）  ② 响应头到首个 token（服务端 prefill）  ③ 首 token 到流结束（decode）
  // 缓存只影响 ②；③ 只受模型档位与输出长度影响；① 与两者都无关。
  // 混在一起看就永远说不清"慢"到底慢在哪一段 —— 这是本次排查里最缺的一层数据。
  const headersAt = Date.now();
  const streamStartAt = headersAt;
  let firstTokenAt = 0;

  const ensureTool = (i) => {
    while (toolAcc.length <= i) toolAcc.push({ index: toolAcc.length, id: '', name: '', args: '' });
    return toolAcc[i];
  };

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      // 读取过程中被中断（用户停止 / 端口断开 / worker 被回收）。
      // **必须把已经收到的内容附在错误上**：否则这一轮模型已经生成的东西全部丢失，
      // 恢复时只能退回上一个完整 tool turn —— 若中断发生在"正在等首个响应/正在生成"
      // 的瞬间，那一步就完全没有可续跑的状态，恢复等于从头再来（实测就是这个后果）。
      if (e && (e.name === 'AbortError' || signal?.aborted)) {
        const partialErr = new DOMException('任务已取消', 'AbortError');
        partialErr.partial = buildPartialStep(contentAcc, toolAcc);
        cleanup();
        throw partialErr;
      }
      cleanup();
      throw e;
    }
    const { done, value } = chunk;
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
      // 首个可见增量即 prefill 结束 / decode 开始的分界点。
      // **思维链也算首个增量**：推理模型会先吐一大段 reasoning_content 才开始正文，
      // 若不计入，这段等待会被错算进 prefillMs，让「慢在哪一段」的判断失真。
      if (!firstTokenAt && (delta.content || delta.reasoning_content || delta.tool_calls || choice.finish_reason)) {
        firstTokenAt = Date.now();
      }
      // 思维链：单独发一类事件（type: 'reasoning'），与正文 chunk 分开。
      // 分开的理由：面板要把它渲染成**默认折叠的思考记录**（用户点开才看全文）；
      // 若混进 chunk，面板就再也分不出哪段是思考、哪段是回答。
      if (delta.reasoning_content) {
        reasoningAcc += delta.reasoning_content;
        (emit || ((event) => port.postMessage(event)))({ type: 'reasoning', text: delta.reasoning_content });
      }
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
  const streamEndAt = Date.now();
  const timing = {
    ttfbMs: headersAt - requestStartAt,
    prefillMs: (firstTokenAt || streamEndAt) - headersAt,
    decodeMs: firstTokenAt ? streamEndAt - firstTokenAt : 0,
    totalMs: streamEndAt - requestStartAt,
  };
  return { assistantMessage, toolCalls, usage, timing, reasoning: reasoningAcc };
}

/**
 * 并行预执行：把相邻的、可并发的工具调用成组跑掉，返回 原下标 -> { res, ms }。
 *
 * 只做「执行」这一件事：不碰 messages、不做任何后处理，因此调用方的串行循环
 * 可以完全不知道并发发生过 —— 所有顺序敏感的逻辑（tool 结果入栈顺序、
 * ctx 改写、guard 判定、complete_task 的提前返回）都留在原处，一行没动。
 *
 * 这是本仓库里第一处 Promise.all：在此之前，系统提示承诺的
 * 「一轮可以发出多个工具调用，不要一次一个地串行调用」从未被执行层兑现。
 */
async function runParallelBatch(toolCalls, o) {
  const precomputed = new Map();
  if (!o.enabled) return precomputed;
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const limit = Math.max(0, Math.min(calls.length, Number(o.remaining) || 0));
  if (limit < 2) return precomputed;

  // 并行预执行**同样必须现读审批设置**，而且比串行路径更要紧：
  // 它决定"这个调用能不能先跑掉"。若沿用运行开始时的快照，而用户中途把某个类别
  // 改回「需要确认」，这里会以为无需审批而**直接把写操作执行掉** —— 那是漏批，
  // 比"多弹一次确认"严重得多。现读一次、这一轮里共用。
  o.approvalSettings = await readLiveApprovalSettings(o.settings);

  const groups = planParallelGroups(calls.slice(0, limit), {
    isParallelSafe: (name) => getToolMetadata(name).parallelSafe === true,
    shouldSkip: (name, args) => {
      // 三条安全边界：停用 / 参数非法 / 需要审批，任一命中就退回串行路径。
      // 判定条件与下面循环里的完全一致，避免"预执行了但循环会拒绝"的空转。
      if (o.disabledTools.has(name)) return true;
      if (!validateToolCall(name, args).ok) return true;
      return (
        o.approvalSettings.toolApproval !== false &&
        toolNeedsApproval(name, o.approvalSettings, o.ctx.pageUrl) &&
        !o.sessionApprovedTools.has(name)
      );
    },
  });
  if (!groups.length) return precomputed;

  for (const group of groups) {
    // 先把整组「开始执行」事件发出去：UI 应当同时看到这几个调用在执行中，
    // 而不是等它们全跑完才一起冒出来。callId 与循环里复用同一份。
    for (const i of group) {
      const tc = calls[i];
      o.emit({
        type: 'tool-call',
        callId: o.callIds[i],
        name: tc.name,
        args: tc.args,
        requiresApproval: false,
        risk: getToolMetadata(tc.name).risk,
      });
    }
    o.emitState(RUN_STATUS.EXECUTING);
    const toolsInGroup = group.map((i) => calls[i].name);
    o.trace({ phase: 'parallel-batch', iter: o.iter, size: group.length, tools: toolsInGroup });
    const wallStart = Date.now();

    const settled = await Promise.all(
      group.map(async (i) => {
        const tc = calls[i];
        const metadata = getToolMetadata(tc.name);
        const t0 = Date.now();
        try {
          const res = await withTimeout(
            () => executeAnyTool(tc.name, tc.args, o.ctx),
            metadata.timeoutMs || o.budget.toolTimeoutMs,
            o.signal
          );
          return { index: i, res, ms: Date.now() - t0 };
        } catch (e) {
          // 单个工具失败不能拖垮整组（串行路径同样是 catch 后继续）。
          return { index: i, res: { result: e && e.name === 'AbortError' ? '任务已取消。' : e.message, ok: false }, ms: Date.now() - t0 };
        }
      })
    );
    for (const item of settled) precomputed.set(item.index, item);
    o.trace({ phase: 'parallel-batch-done', iter: o.iter, size: group.length, wallMs: Date.now() - wallStart, tools: toolsInGroup });
  }
  return precomputed;
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
  // 每轮耗时汇总：把一次模型往返拆成 prefill（到首个 token）与 decode（首 token 到流结束），
  // 再单独列出工具执行。缓存只影响 prefill，decode 只受模型档位与输出长度影响，
  // 工具执行与两者都无关 —— 混在一起看就永远说不清"慢"在哪一段。
  const reportTurnTiming = (iter, step, toolMs) => {
    const t = step && step.timing;
    if (!t) return;
    const sec = (ms) => Math.round(ms / 100) / 10 + 's';
    console.log(
      '[RecallFlow] turn=' + (iter + 1) +
      ' ttfb=' + sec(t.ttfbMs) +
      ' prefill=' + sec(t.prefillMs) +
      ' decode=' + sec(t.decodeMs) +
      ' tools=' + sec(toolMs) +
      ' total=' + sec(t.totalMs + toolMs)
    );
    trace({ phase: 'turn-timing', iter, ttfbMs: t.ttfbMs, prefillMs: t.prefillMs, decodeMs: t.decodeMs, toolMs, totalMs: t.totalMs + toolMs });
  };
  const summarizeArgs = (a) => {
    try {
      const s = JSON.stringify(a || {});
      return s.length > 200 ? s.slice(0, 200) + '…' : s;
    } catch (e) {
      return '';
    }
  };
  // 本轮 assistant 消息里的 tool_calls 与后续 tool 消息必须一一对应。
  // 提前跳出工具循环时（完成前校验未通过 → 注入反思继续下一轮），若不给剩余的
  // tool_call 补上结果，下一次请求就会带着「有调用、无结果」的 assistant 消息发出去，
  // 服务端只回一个**空的 400** —— 从报错里完全看不出原因。
  const fillRemainingToolResults = (toolCalls, fromIndex, reason) => {
    const list = Array.isArray(toolCalls) ? toolCalls : [];
    for (let k = fromIndex; k < list.length; k++) {
      messages.push({ role: 'tool', tool_call_id: list[k].id, content: reason });
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
  // 本任务调用过 / 失败过的工具名：供「完成前确定性断言」判断
  // 「声称做了修改，但没有任何写类工具被调用」这类确定性矛盾。
  const ranToolNames = canResume && Array.isArray(persisted.ranToolNames) ? persisted.ranToolNames.slice() : [];
  const failedToolNames = canResume && Array.isArray(persisted.failedToolNames) ? persisted.failedToolNames.slice() : [];
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
  const runCitations = canResume && Array.isArray(persisted.runCitations) ? persisted.runCitations.map((c) => Object.assign({}, c)) : [];
  // 统一工具守卫：重复调用 / 连续失败 / 无进展的单一判定，**只提醒、不否决**（见 tool-guard.js）。
  const guard = createToolGuard(budget);
  if (canResume) guard.restore(persisted.guard);
  // 每工具最近一次结果指纹，用于把「有实质新产出」判定为进展。
  const resultFingerprints = new Map();
  const run = canResume ? Object.assign(createRun(runId, budget), persisted.run || {}, { id: runId, budget }) : createRun(runId, budget);
  // 恢复时把状态重新置于 created，保证状态机从合法入口继续发事件。
  if (canResume) run.status = RUN_STATUS.CREATED;
  const emitState = (next, meta = {}) => {
    const state = transition(run, next, meta);
    // 总步数未知（没有轮数上限）—— 传 0，面板据此省略进度分母。
    emit({ type: 'agent-state', ...state, step: run.currentStep, maxSteps: 0 });
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
    // 最近一次读类工具的**全文**（截断之前的原始结果）。
    // 完成前校验不能只给页面前 N 个字：实测一次「提炼关键要点」任务页面 10398 字，
    // 而结论依据的提交哈希散落在深处，校验方在前 2500 字里找不到就否决了。
    // 有了全文，selectEvidence 才能按结论里的具体事实去定位片段。
    lastReadFullText: '',
  };
  trace({
    phase: 'start',
    intent,
    resumed: Boolean(canResume),
    instruction: String(instruction || '').slice(0, 200),
    pageUrl: ctx.pageUrl,
    budget: { maxTotalTokens: budget.maxTotalTokens, toolTimeoutMs: budget.toolTimeoutMs },
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
      .map((p, i) => (p.status === 'done' ? '✓' : p.status === 'in_progress' ? '▶' : '○') + ' ' + (i + 1) + '. ' + p.text)
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
      lastProgressIter,
      resultIds: Array.from(ctx.resultIds || []).slice(-80),
      ...extra,
    });
  };
  await persist({ status: RUN_STATUS.CREATED, phase: 'created', nextIteration: resumeIteration }).catch(() => {});

  // 循环**不设轮数与工具数上限**（对齐 DSH：`dsh-agent-loop` 里搜不到 maxTurns / maxToolCalls，
  // 唯一的限制常量是并发度）。结束条件只有四个：complete_task、模型给出最终回答、
  // 用户中断、以及唯一的成本兜底 maxTotalTokens。
  //
  // 原先还有三道**进度**墙：maxModelTurns=30、maxToolCalls=40/48/60、maxDurationMs=180s。
  // 它们惩罚的是「任务确实很长」而不是「任务失控」—— 实测一次正常的「24 类工具冒烟测试」
  // 就被工具墙硬停，用户被迫连说两次「继续」，而每次「继续」都要重新建立上下文。
  for (let iter = resumeIteration; ; iter++) {
    // 唯一保留的兜底，而且是**成本**维度而非进度维度。
    // 保留它的理由：DSH 敢完全不设上限，是因为它有一整套替代品（压缩 / 溢出 / 委派）
    // 且有用户在旁边随时打断；RecallFlow 的面板在后台跑，缺这个外部止损器。
    if (tokenBudgetExceeded(totalTokens, budget)) {
      emitState(RUN_STATUS.TIMEOUT, { reason: 'maxTotalTokens' });
      trace({ phase: 'timeout', reason: 'maxTotalTokens', toolCalls: toolCallCount, totalTokens });
      emit({
        type: 'budget-exceeded',
        reason: 'maxTotalTokens',
        message: '本任务的累计 token 已达成本上限（约 ' + totalTokens + '），已停止。这与「做了多少事」无关 —— 它是花费兜底。',
        totalTokens,
      });
      await finalizeWithPartialInfo(port, settings, messages, signal, emit, tools);
      await persist({ status: RUN_STATUS.TIMEOUT, reason: 'maxTotalTokens', totalTokens }).catch(() => {});
      await closeAuxTabs(ctx).catch(() => {});
      emit({ type: 'end' });
      return;
    }
    // 存活看门狗：唯一能终止"卡住的 run"的东西。
    // 与上面的成本闸门互补 —— 成本闸门管花了多少钱，它管是不是已经完全不动了。
    // 只要有过进展就会重置基准（见下面 progress 分支），因此正常长任务永不触发。
    const liveness = evaluateLiveness({
      iter,
      lastProgressIter,
      maxNoProgressRounds: budget.maxNoProgressRounds,
    });
    if (liveness.stalled) {
      emitState(RUN_STATUS.TIMEOUT, { reason: 'noProgress' });
      trace({ phase: 'timeout', reason: 'noProgress', iter, noProgressRounds: liveness.noProgressRounds, toolCalls: toolCallCount });
      emit({
        type: 'budget-exceeded',
        reason: 'noProgress',
        message:
          '连续 ' + liveness.noProgressRounds + ' 轮没有产生任何可观察进展，已停止。' +
          '这不是"做了多少事"的限制 —— 只要还在推进就不会触发；通常是卡在某个反复失败的动作上。',
      });
      await finalizeWithPartialInfo(port, settings, messages, signal, emit, tools);
      await persist({ status: RUN_STATUS.TIMEOUT, reason: 'noProgress' }).catch(() => {});
      await closeAuxTabs(ctx).catch(() => {});
      emit({ type: 'end' });
      return;
    }
    run.currentStep = iter + 1;
    // 新任务和恢复任务的第一轮都从 planning 重新建立合法状态链。
    emitState(iter === resumeIteration ? RUN_STATUS.PLANNING : RUN_STATUS.OBSERVING);
    await persist({ status: run.status, phase: 'model', nextIteration: iter }).catch(() => {});
    // 折叠较早的工具结果，控制上下文规模（计划消息已在循环外一次性注入，这里不再动）。
    // **只在总量超过阈值时压缩一次**：每轮都改写会话中部的消息会让请求前缀发生变化，
    // 从而破坏服务端的前缀缓存、每轮都要重算一大段 —— 这是「同样的模型却更慢」的隐蔽原因。
    // 一次压缩会砍掉大量字符，因此接下来若干轮都不会再触发，前缀保持稳定、缓存得以命中。
    const historyTokens = estimateMessagesTokens(messages);
    let collapsedNow = 0;
    if (historyTokens > CONTEXT_COLLAPSE_TOKENS) {
      collapsedNow = collapseOldToolResults(messages, 6, 300);
      // 折叠是此刻唯一允许的历史中部改写；记日志让「什么时候发生过折叠」不再不可见。
      if (collapsedNow) {
        console.log('[RecallFlow] collapsed ' + collapsedNow + ' old tool results (iter=' + iter + ', ~' + historyTokens + ' tokens)');
        trace({ phase: 'collapse', iter, collapsed: collapsedNow, historyTokens });
      }
    }
    // 回滚点：出站结构校验可能已经删掉了一些消息，所以这里必须是 let（见下面的修复分支）。
    let safeMessageLength = messages.length;
    // 本轮工具执行累计耗时（用于轮末汇总；审批等待不计入 —— 那是用户时间）。
    let turnToolMs = 0;    // 出站前缀哨兵：与上一轮实际发出的消息逐条比对。命中缓存的前提是从 token 0
    // 起逐字节相同，所以任何「不是纯追加」的差异都要在这里留下痕迹，
    // 否则整类问题只能靠肉眼读代码发现（这次就是这么找出来的）。
    const prefixSnapshot = snapshotMessages(messages);
    if (prevPrefixSnapshot) {
      const diff = diffSnapshots(prevPrefixSnapshot, prefixSnapshot);
      if (!diff.stable) {
        // 折叠是本轮刚发生的、已知且有意的一次中部改写；标注出来，
        // 免得把正常折叠误读成又冒出一个新的破坏点。
        const hint = collapsedNow ? '（本次折叠所致，属预期的一次性改写）' : '';
        console.log('[RecallFlow] ' + formatPrefixReport(diff) + hint);
        trace({ phase: 'prefix-change', divergeAt: diff.divergeAt, reason: diff.reason, prevLength: diff.prevLength, nextLength: diff.nextLength, expected: Boolean(collapsedNow) });
      }
    }
    prevPrefixSnapshot = prefixSnapshot;
    // 出站会话结构校验（第二层防护）。上面已经修掉了「提前 break 导致漏结果」这个根因，
    // 但这类结构错误的代价太高：服务端只回一个**空响应体的 400**，报错里没有任何线索，
    // 只能人肉读代码（这次就是这么找出来的）。所以每次出站前自检一次，把问题在本地
    // 变成一句指名道姓的日志；真有结构错误时用既有的 sanitizeToolPairing 就地修复，
    // 宁可少一轮上下文也不要再出现看不懂的 400。
    const convProblems = diagnoseConversation(messages);
    if (convProblems.length) {
      const repaired = repairConversation(messages);
      console.log(
        '[RecallFlow] 出站会话结构非法，已修复：' + formatProblems(convProblems) +
        '（' + messages.length + ' → ' + repaired.length + ' 条）'
      );
      trace({ phase: 'conversation-repair', iter, problems: convProblems, before: messages.length, after: repaired.length });
      // 就地替换以保持数组标识不变（循环内外多处闭包与回滚都依赖同一个数组对象），
      // 同时收紧回滚点：否则后续 `messages.length = safeMessageLength` 会把数组撑出空槽。
      messages.length = 0;
      for (const m of repaired) messages.push(m);
      safeMessageLength = Math.min(safeMessageLength, messages.length);
    }
    let step;
    try {
      step = await streamAgentStep(port, settings, messages, signal, tools, emit);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        // 端口断开不等于任务失败：保留最近一个完整 tool turn，允许同 runId 恢复。
        messages.length = safeMessageLength;
        // 但**只回滚到上一个完整 turn 是不够的**：若中断发生在"正在生成"的瞬间，
        // 回滚后没有任何可续跑的状态，恢复等于从头再来（实测：等到生成中再断线就无法恢复）。
        // 因此把本轮已产出的部分内容补回到历史里 —— 它是结构合法的 assistant 消息
        //（半截 tool_calls 已在 buildPartialStep 里剔除），恢复时模型能看到自己已经做了什么。
        const partial = e.partial || null;
        if (partial && partial.assistantMessage) {
          messages.push(partial.assistantMessage);
        }
        await persist({
          status: run.status,
          phase: 'interrupted',
          reason: 'port-disconnected',
          nextIteration: iter,
        }).catch(() => {});
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
      // 前缀缓存可观测性：DeepSeek 在 usage 里返回命中/未命中 token 数。
      // 这两个字段是判断「前缀是否被破坏」的唯一直接证据，之前被完全丢弃，
      // 导致缓存问题只能靠猜。命中率长期贴着 0 才说明前缀真的在每轮变化。
      const hit = Number(u.prompt_cache_hit_tokens) || 0;
      const miss = Number(u.prompt_cache_miss_tokens) || 0;
      const promptTokens = Number(u.prompt_tokens) || hit + miss;
      if (promptTokens > 0 && (hit > 0 || miss > 0)) {
        const ratio = Math.round((hit / promptTokens) * 100);
        console.log('[RecallFlow] cache iter=' + iter + ' hit=' + hit + ' miss=' + miss + ' (' + ratio + '%)');
        trace({ phase: 'cache', iter, hit, miss, promptTokens, ratio });
      }
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
      // 画像提升产生的 system 消息同样必须延后：此刻 messages 末尾是带 tool_calls 的
      // assistant 消息，直接追加 system 会把 tool 结果与它的 tool_calls 隔开，请求非法。
      let pendingResearchPromotion = null;
      // 每个调用的 callId 提前算好：并行预执行阶段要先用同一个 callId 把「开始执行」
      // 事件发出去，循环里再复用。否则 UI 会因为两处各自生成随机 callId 而出现重复条目。
      const callIds = step.toolCalls.map((tc) => tc.id || 'tool-' + iter + '-' + Math.random().toString(36).slice(2, 8));
      // 并行预执行：把相邻的、可并发的只读调用成组跑掉，结果按**原下标**存好，
      // 交给下面的串行循环统一做后处理。循环体本身一行没改 ——
      // 所有状态改写（ctx.tabId / resultStore / lastSnapshot…）、事件顺序、
      // tool_call 与 tool_result 的配对入栈，仍然严格串行且保持原顺序。
      const precomputed = await runParallelBatch(step.toolCalls, {
        enabled: settings.parallelToolCalls !== false,
        iter,
        callIds,
        disabledTools,
        settings,
        ctx,
        sessionApprovedTools,
        budget,
        signal,
        emit,
        emitState,
        trace,
      });
      for (let tcIndex = 0; tcIndex < step.toolCalls.length; tcIndex++) {
        const tc = step.toolCalls[tcIndex];
        toolCallCount += 1;
        const metadata = getToolMetadata(tc.name);
        // 预算弹性 + 画像自纠：实际用到研究/网络类工具 → 放宽生效预算（只增不减），
        // 且若起点是「普通对话」，就地提升为「资料研究」画像（工具集 + 系统提示 + 收尾规则）。
        if (RESEARCH_TRIGGER_TOOLS.has(tc.name)) {
          if (intent === INTENTS.CHAT && !promotedToResearch) {
            promotedToResearch = true;
            pendingResearchPromotion = () =>
              promoteToResearch(tools, messages, detected.sourceText || instruction, allSkills, promptExtras);
            emit({ type: 'intent-upgraded', intent: INTENTS.RESEARCH, label: resolveIntent(INTENTS.RESEARCH).label });
          }
        }
        // 这里原先有两道**进度**闸门：全局工具数上限（撞上先追加额度、用尽即硬停）
        // 与「额度即将用尽」的预警。两者都已移除 —— 工具调用次数不再是结束条件，
        // 唯一的兜底是循环开头的 maxTotalTokens（成本维度），守卫侧的重复/失败/无进展
        // 改为纯建议（tool-guard.js）。对齐 DSH：不限制「做了多少件事」。
        const callId = callIds[tcIndex];
        const toolState = { callId, name: tc.name, status: TOOL_STATUS.PENDING };
        let res;
        const validation = validateToolCall(tc.name, tc.args || {});
        if (!validation.ok) {
          res = { ok: false, result: validation.error };
          toolState.status = TOOL_STATUS.FAILED;
          emit({ type: 'tool-result', callId, name: tc.name, status: 'failed', result: res.result });
        }
        // 已停用工具的执行层拒绝。
        // 停用不再通过「从 tools 数组里摘掉」实现 —— 工具定义是请求前缀的一部分
        // （约 8.3k tokens/轮），中途改动会让整段前缀缓存失效。改为在这里显式拒绝：
        // 效果同样是「模型下轮无法再用它」，但前缀保持稳定。下一次运行初始化时
        // 才会真正从 schema 里过滤掉（见 disabledTools 的初始化处）。
        //
        // 这里直接 continue，故意不进入守卫的 observe：这些拒绝不是「模型在错误方向上
        // 努力」，而是服务端主动收回的能力。若计入 noProgressStreak，连续几次重试就会
        // 撞到 stop 阈值，把本来还能继续的任务误杀 —— 那正是摘除 schema 时不存在的问题。
        if (!res && disabledTools.has(tc.name)) {
          const blockedMsg = '工具「' + tc.name + '」已在本任务中停用（连续失败或无进展），请改用其他方式完成目标。';
          emit({ type: 'tool-result', callId, name: tc.name, status: 'failed', result: blockedMsg });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: blockedMsg });
          continue;
        }
        // 审批设置**每次决策现读**：用户可能在对话进行中把自动批准打开
        //（面板的「自动驾驶（全部自动批准）」就在输入框上方）。只读运行开始时的快照，
        // 会让"打开了也没用"——本轮剩下的写操作仍会一个个弹确认。
        // 只在**这个工具本身可能需要审批**时才多一次存储往返，纯读取类工具不受影响。
        let approvalSettings = settings;
        if (metadata.requiresApproval === true) {
          approvalSettings = await readLiveApprovalSettings(settings);
        }
        if (approvalSettings.toolApproval !== false && toolNeedsApproval(tc.name, approvalSettings, ctx.pageUrl) && !sessionApprovedTools.has(tc.name)) {
          if (res) {
            // 参数不合法时不应再弹审批框。
          } else {
          toolState.status = TOOL_STATUS.APPROVAL_REQUIRED;
          emitState(RUN_STATUS.WAITING_APPROVAL, { callId, tool: tc.name });
          // 代码执行类工具（run_javascript / run_userscript / install_userscript）
          // 默认不允许"会话级放行"；仅当 codeExecutionApproval='session' 时允许勾选。
          const allowSession =
            metadata.alwaysRequireApproval !== true ||
            resolveCodeExecutionApproval(approvalSettings) === 'session';
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
          const pre = precomputed.get(tcIndex);
          let toolMs = 0;
          if (pre) {
            // 该调用已在并行批次里执行完毕，且「开始执行」事件当时就发出去了。
            // 这里只取结果 —— 绝不重复执行，也不重复派发 tool-call 事件。
            res = pre.res;
            toolMs = pre.ms;
          } else {
            toolState.status = TOOL_STATUS.RUNNING;
            emitState(RUN_STATUS.EXECUTING, { callId, tool: tc.name });
            emit({ type: 'tool-call', callId, name: tc.name, args: tc.args, requiresApproval: false, risk: metadata.risk });
            const toolStartedAt = Date.now();
            try {
              res = await withTimeout(() => executeAnyTool(tc.name, tc.args, ctx), metadata.timeoutMs || budget.toolTimeoutMs, signal, tc.name);
            } catch (e) {
              res = { result: describeToolFailure(e, tc.name), ok: false };
            }
            toolMs = Date.now() - toolStartedAt;
          }
          toolState.status = res.ok === false ? TOOL_STATUS.FAILED : TOOL_STATUS.SUCCEEDED;
          // 记账：供「完成前确定性断言」判断声称与实际动作是否相符。
          ranToolNames.push(tc.name);
          if (res.ok === false) failedToolNames.push(tc.name);
          turnToolMs += toolMs;
          trace({ phase: 'tool', name: tc.name, args: summarizeArgs(tc.args), status: toolState.status, ms: toolMs, ok: res.ok !== false, code: res.code, resultLen: String(res.result || '').length });
          emit({ type: 'tool-result', callId, name: tc.name, status: res.ok === false ? 'failed' : 'completed', result: res.result });
          // 资源型工具触顶（如 open_tab 预算用尽，res.blocked=true）→ 立即摘除，禁止模型下轮再试。
          // 连续失败 / 重复调用 / 无进展统一交给 guard，在其后分级软着陆。
          // 常驻工具（load_skill 等 alwaysAvailable）不参与摘除，避免破坏技能系统。
          if (metadata.alwaysAvailable !== true && res && res.blocked === true && !disabledTools.has(tc.name)) {
            disabledTools.add(tc.name);
            // 不从 tools 数组里摘除：那会改写请求前缀、废掉整段缓存。
            // 停用由上面的执行层检查兜住，schema 到下一次运行才真正收缩。
            emit({ type: 'tool-disabled', name: tc.name, reason: res.blockReason || '已达安全上限，禁止继续调用' });
          }
          // 计划更新：只通知前端渲染进度。
          // 不再改写计划消息 —— 计划全文已经由 update_plan 的工具结果回到模型（见 tools.js），
          // 那是 append-only 的；在这里改写索引 1 会让整段历史的前缀缓存全部失效。
          if (tc.name === 'update_plan') {
            emit({ type: 'plan', plan: Array.isArray(ctx.plan) ? ctx.plan.map((p) => Object.assign({}, p)) : [] });
          }
          // 进阶版 A：模型调用 load_skill 时，记录已加载技能、通知前端，并把该技能声明的工具并入白名单。
          //
          // 缓存代价：往 tools 里追加会让请求前缀在追加点之后重新计算，是没法避免的
          // —— 技能声明的工具不在 schema 里，模型根本调用不了。所以这里只做两件事控制损失：
          // ① 已存在的工具不重复追加；② load_skill 本身是 alwaysAvailable 工具，不会被摘除，
          // 因此一个 run 里 tools 只在「第一次加载某个技能」时跳变一次。
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
        const rawResult = typeof res.result === 'string' ? res.result : '';
        if (rawResult.length > 6000) {
          const rid = 'res-' + toolCallCount;
          try { ctx.resultStore.set(rid, res.result); } catch (e) {}
          try { ctx.resultIds.add(rid); } catch (e) {}
          // sliceSafe：论文/数学页面里 𝑦 𝒜 𝐺 各占 2 个码元，按码元切会切裂代理对，
          // 半个字符进历史 = 之后每一次请求都被服务端在解析阶段整单拒收（见 surrogates.js）。
          res.result = sliceSafe(res.result, 0, 3000) + formatTruncationNotice(res.result.length, rid);
        }
        // 内容消毒：这段文本**马上要进历史**，而它可能原封不动来自页面
        //（run_javascript 的返回值、innerText 切片 —— 我们控制不了页面给什么）。
        // 放在这里而不是只在请求前兜底：请求前兜底只能就地改历史，会改写请求前缀、
        // 废掉前缀缓存（见 check-prefix-stability 的纪律）；这里改的是**新内容**，append-only 不受影响。
        if (typeof res.result === 'string' && res.result) {
          const clean = sanitizeLoneSurrogates(res.result);
          if (clean !== res.result) {
            console.log('[RecallFlow] 工具结果含孤立代理对，已就地清理：' + tc.name);
            res.result = clean;
          }
        }
        // 截图：推给前端渲染（给用户看）。**base64 不写进 tool 消息** ——
        // 工具消息只能是文本，塞 base64 只会白烧 token；图由下面追加的 user 消息承载。
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
        ctx.lastEvidence = evidenceAfter(ctx.lastEvidence, tc, res, summarizeArgs);
        // 读类工具的全文单独留一份（rawResult 是截断前的原文）。
        // 完成校验据此按结论里的具体事实定位片段，而不是只能看页面前 2500 字。
        if (EVIDENCE_READ_TOOLS.has(tc.name) && rawResult) ctx.lastReadFullText = rawResult;
        // 记录可重放的成功动作，供 save_macro 保存为宏。
        try { recordTraceStep(ctx, tc.name, tc.args, res); } catch (e) {}
        messages.push({ role: 'tool', tool_call_id: tc.id, content: res.result });
        // 视觉（多模态）接线：截图**不能**放进 tool 消息（工具消息只能是文本 ✗），
        // 所以作为**追加的 user 消息**送进上下文。
        //
        // ⚠ 第 6 步已把 `VISION_ENABLED` 打开 ⇒ 这段**现在真的会产出图片消息**，
        // 也就是"模型可见内容变了"⇒ 必须测量（已做定向测量，见 docs/real-model-eval-log.md）。
        // `ctx.visionBudget` **没有任何地方赋值**（恒 undefined）⇒ 实际用的是
        // `vision.js` 的 `DEFAULT_VISION_BUDGET`（不可配置，见那里的说明）。
        if (res && res.screenshot && res.screenshot.dataUrl) {
          // **任务级成本上界**：`ctx.visionBudget`（按 token）至今**无人赋值** ⇒ 恒 undefined，
          // 唯一兜得住的是**按张数**的上界（见 vision.js 的 `MAX_IMAGES_PER_TASK`）。
          // 到上界时**不静默丢**：改推一条**纯文字说明**（说清"从第几张起不再送图"）✓
          const sentImages = Number(ctx.visionSentImages) || 0;
          if (shouldSendImage(sentImages)) {
            for (const vm of visionMessagesFor([res.screenshot], { budget: ctx.visionBudget })) messages.push(vm);
            ctx.visionSentImages = sentImages + 1;
          } else {
            messages.push({
              role: 'user',
              content: imageCapNote(sentImages, res.screenshot.label || res.screenshot.name || ''),
            });
          }
        }
        const progress = toolResultProgress(res) || resultProgressByChange(resultFingerprints, tc.name, res);
        // 有可观察进展就重置存活看门狗的基准（这正是它不构成"进度墙"的原因：
        // 只要还在推进，无进展轮数永远回不到上限）。
        if (progress) lastProgressIter = iter;
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
              // 跳出前把本轮剩下的 tool_call 补上结果，否则下一轮请求结构非法（空 400）
              fillRemainingToolResults(step.toolCalls, tcIndex + 1, '（本轮已转入反思，该调用未纳入结果，请勿假设它已执行。）');
              break;
            }
          }
          // 完成前独立校验：校验认为未达成时注入反思继续，而不是草草收尾（受 maxVerifications 限制）。
          if (shouldVerifyCompletion(intent, toolCallCount, settings) && verificationCount < Number(budget.maxVerifications || 0)) {
            // 任务性质决定判据：「页面按要求变了吗」与「结论与页面矛盾吗」是两个不同的问题。
            // 纯阅读/提炼类任务没有状态变化可验证，若仍套用「证据能否证明达成」的问法，
            // 长页面上必然被判未达成（证据永远是片段）。
            const readOnlyRun = [...new Set(ranToolNames)].every((nm) => {
              try {
                return getToolMetadata(nm).readOnly === true;
              } catch (e) {
                return false;
              }
            });
            const taskKind = readOnlyRun ? 'read' : 'mutation';
            const verdict = await runCompletionVerification(settings, instruction, res, ctx, signal, taskKind).catch(() => null);
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
              // 同上：跳出前补全本轮剩余的 tool_call 结果
              fillRemainingToolResults(step.toolCalls, tcIndex + 1, '（本轮已转入反思，该调用未纳入结果，请勿假设它已执行。）');
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
        // 统一守卫判定：**只有 ok / reflect 两种**（见 tool-guard.js）。
        // 命中任何阈值都只注入建议，调用已经在上面执行完毕、结果也照常记录 ——
        // 守卫不再摘除工具、不再终止任务，把「这次重复是空转还是幂等轮询」留给模型判断。
        const decision = guard.observe({
          name: tc.name,
          args: tc.args,
          result: res,
          readOnly: metadata.readOnly === true,
          progress,
          validationFailed: !validation.ok,
          rejected: toolState.status === TOOL_STATUS.REJECTED,
        });
        if (decision.level === 'reflect') {
          emit({ type: 'stuck-warning', name: tc.name, message: decision.message, repeated: decision.repeated, noProgressStreak: decision.noProgressStreak });
          pendingReflections.push(buildStuckReflection(decision.message));
          trace({ phase: 'reflect', reason: decision.reason, tool: tc.name, repeated: decision.repeated, failStreak: decision.failStreak });
        }
        // 只在 assistant tool_call 已配套 tool_result 后保存，避免恢复时出现悬空 tool_call。
        await persist({ status: run.status, phase: 'after_tool', nextIteration: iter + 1 }).catch(() => {});
      }
      // 画像提升的 system 消息 + 本轮反思，统一在所有 tool 结果之后追加
      // （保持 tool_call/tool_result 配对，且都是 append-only，不动已有前缀）。
      if (pendingResearchPromotion) pendingResearchPromotion();
      for (const r of pendingReflections) messages.push({ role: 'user', content: r });
      reportTurnTiming(iter, step, turnToolMs);
      continue;
    }

    reportTurnTiming(iter, step, 0);
    emitState(RUN_STATUS.COMPLETED);
    trace({ phase: 'complete', reason: 'final-answer', toolCalls: toolCallCount, totalTokens });
    const closedTabs = await closeAuxTabs(ctx).catch(() => []);
    if (closedTabs && closedTabs.length) emit({ type: 'tabs-closed', tabIds: closedTabs });
    await persist({ status: RUN_STATUS.COMPLETED }).catch(() => {});
    emit({ type: 'end' });
    await removeAgentSession(runId).catch(() => {});
    return;
  }

  // 循环没有轮数上限，因此正常只可能从上面的 return 出去；
  // 走到这里说明循环条件被外力打破（理论上不可达），按 completed 收尾而不是报"达到最大轮数"。
  emitState(RUN_STATUS.COMPLETED);
  emit({ type: 'end' });
}

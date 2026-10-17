// AI 设置：默认值、读取（与存储层解耦，content script 只依赖本模块）

export const AI_SETTINGS_KEY = 'aiSettings';
export const QUICK_PROMPT_LIMIT = 12;
export const SESSION_TO_KB_QUICK_PROMPT = '整理会话到知识库';
export const SESSION_TO_KB_INSTRUCTION =
  '请把当前会话整理成一篇结构清晰、排版美观的 Markdown 文档，并保存到知识库。\n\n' +
  '要求：\n' +
  '1. 先通读整段会话，提炼主线、结论、步骤、代码和注意事项；合并重复内容，不要把聊天记录逐句照抄。\n' +
  '2. 先用 knowledge_read({op:"search",query:"<会话主题>"}) 检查是否已有同主题的“会话整理”；若已有，沿用该条目 id 更新，避免重复新建。\n' +
  '3. 文档标题使用「会话整理：<简明主题>」，标签给出 3-6 个具体主题词，status 设为 2。\n' +
  '4. note 必须是完整、可直接阅读的 Markdown。建议结构：\n' +
  '# 会话整理：<主题>\n\n' +
  '> 用 2-3 句话概括背景、目标和最终结果。\n\n' +
  '## 背景与目标\n\n' +
  '## 关键结论\n\n' +
  '## 实施步骤 / 方案\n\n' +
  '## 代码与配置\n\n' +
  '## 注意事项与坑\n\n' +
  '## 待办与后续\n\n' +
  '## 相关链接\n\n' +
  '5. 按内容实际选择章节；无内容的章节可以省略，不要编造。步骤用有序列表，对比信息用 Markdown 表格，命令和配置用 fenced code block，行内标识用 inline code。\n' +
  '6. 保留会话中出现的具体命令、参数、文件路径、数字和结论，删除寒暄、重复解释与过程性噪声。正文不要出现“用户说 / 助手说”。\n' +
  '7. 调用 add_entry({id?,type:"note",title,note,tags,status:2}) 保存。更新已有条目时传 id；新建时不要传 id。\n' +
  '8. 保存后调用 knowledge_read({op:"get",id}) 读回，确认标题、Markdown 结构和关键内容都在，再向用户报告保存的标题和 id。';

export const AI_SETTINGS_DEFAULTS = {
  apiKey: '',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  requestTimeoutMs: 60000,
  ragEnabled: true,
  targetLang: '中文',
  pageContext: true,
  // Cline 风格：可能改变数据、浏览器状态或调用外部 MCP 的工具必须先由用户确认。
  toolApproval: true,
  // Cline 风格：按能力类别配置自动批准，而不是只有一个总开关。
  toolApprovalPolicy: { read: true, edit: false, commands: false, browser: false, mcp: false },
  quickPrompts: [
    SESSION_TO_KB_QUICK_PROMPT,
    '划出页面关键信息',
    '检索一些好用的技能',
    '分析这个网页/项目',
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
  // 站点信任：这些 origin 上的写操作不再逐次确认（run_javascript 等高风险工具仍逐次确认）。
  trustedSites: [],
  // 完成前独立校验：声称完成时用一次轻量 LLM 调用核对是否真的达成，未达成则反思重试。
  verifierEnabled: true,
  // 并行工具调用：同一轮里相邻的、标记为 parallelSafe 的只读调用并发执行。
  // 系统提示本来就要求模型「一轮可以发出多个工具调用，不要一次一个地串行调用」，
  // 这里让执行层真正兑现它。设为 false 退回严格串行（出问题时的一键回退开关）。
  parallelToolCalls: true,
  // 「任意代码执行」类工具的审批策略：
  //   'each' 每次都要 / 'session' 本任务内允许一次（默认） / 'auto' 自动批准。
  // 适用范围**不止 run_javascript**：用户脚本（run_userscript / install_userscript）执行的是
  // 第三方代码，且会从远程自动更新，与 run_javascript 同属 high + alwaysRequireApproval。
  // 原先这个键叫 runJavascriptApproval，UI 标签也只写「运行 JavaScript」——
  // 于是把它设为 'auto' 会在用户以为只放开 JavaScript 的情况下，一并放开第三方脚本。
  codeExecutionApproval: 'session',
  // 本机 MCP 桥接的共享 token。默认值与 recallflow-mcp 内置默认值一致，
  // 开箱即用（用户明确要求先用默认 token 跑通，见 integrations/opencode/recallflow-mcp/index.js）。
  // 安全性取舍：默认值是公开的，本机任何进程都能用它冒充扩展、伪造证据快照；
  // 要收紧就在「设置页 → 桥接 Token」和 server 的 RECALLFLOW_BRIDGE_TOKEN 里同时换成长随机串。
  bridgeToken: 'recallflow-local-bridge-v1',
};

/** 已有用户补齐新增默认项；新增项优先，确保 12 条已满时也不会被静默挤掉。 */
export function mergeQuickPrompts(saved, defaults = AI_SETTINGS_DEFAULTS.quickPrompts, limit = QUICK_PROMPT_LIMIT) {
  const list = Array.isArray(saved)
    ? saved.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const legacyDefaults = new Set([
    '整理会话到知识库',
    '提炼关键要点',
    '解释这段内容',
    '划出页面关键信息',
    '检索一些好用的技能',
  ]);
  // 旧版本没有自定义过快捷语句时，升级后直接采用新的默认列表，
  // 不要把已被移除的旧默认项重新带回来。
  if (list.length && list.every((item) => legacyDefaults.has(item))) {
    return defaults.slice(0, limit);
  }
  const missing = defaults.filter((item) => !list.includes(item));
  return [...new Set([...missing, ...list])].slice(0, limit);
}

/** 快捷指令只显示短标签；发送时展开为完整任务规范。 */
export function expandQuickPrompt(text) {
  return String(text || '').trim() === SESSION_TO_KB_QUICK_PROMPT
    ? SESSION_TO_KB_INSTRUCTION
    : String(text || '');
}

/**
 * 解析「任意代码执行」的审批模式，兼容旧设置键名。
 *
 * 为什么要有这层：新键 codeExecutionApproval 是权威；旧用户的存储里只有
 * runJavascriptApproval。若不回退，老用户升级后设置会被静默重置为默认值 ——
 * 而对一个审批开关来说，「静默变回默认」比「读到一个旧值」更危险。
 */
export function resolveCodeExecutionApproval(settings) {
  const s = settings || {};
  const v = s.codeExecutionApproval !== undefined && s.codeExecutionApproval !== null && s.codeExecutionApproval !== ''
    ? s.codeExecutionApproval
    : s.runJavascriptApproval;
  return v === 'each' || v === 'auto' || v === 'session' ? v : 'session';
}

/**
 * 局部更新设置：**现读基底 → 合并 → 写回**，只覆盖传入的字段。
 *
 * 为什么必须现读基底：面板此前是「打开面板时读到的 `s`」当基底做 `{...s, 改动}`，
 * 而 `chrome.storage.local.set({ aiSettings })` 是**整对象替换** ——
 * 于是保存一个开关会把其它字段一起回写成**那一刻的旧值**。
 * 真实后果：用户在设置页改了模型，再在面板上勾一下自动批准，模型就被悄悄改回去了；
 * 两个标签页各开一个面板时更明显（互相覆盖对方的改动）。
 *
 * 合并的基底是**存储里的原值**（不是与默认值合并后的结果）——
 * 这样不会把一堆默认值顺便写进存储，保持"存储里只放用户真正设过的东西"。
 */
export async function updateAISettings(patch) {
  const d = await chrome.storage.local.get(AI_SETTINGS_KEY);
  const saved = d[AI_SETTINGS_KEY] || {};
  const next = Object.assign({}, saved, patch || {});
  await chrome.storage.local.set({ [AI_SETTINGS_KEY]: next });
  return Object.assign({}, AI_SETTINGS_DEFAULTS, next);
}

export async function getAISettings() {
  const d = await chrome.storage.local.get(AI_SETTINGS_KEY);
  const saved = d[AI_SETTINGS_KEY] || {};
  const merged = Object.assign({}, AI_SETTINGS_DEFAULTS, saved);
  // 新版本新增的默认快捷指令会合并进已有用户设置：保留用户自定义项与顺序，去重后补齐新增项。
  if (Array.isArray(saved.quickPrompts)) {
    merged.quickPrompts = mergeQuickPrompts(saved.quickPrompts);
  }
  return merged;
}

// AI 设置：默认值、读取（与存储层解耦，content script 只依赖本模块）

export const AI_SETTINGS_KEY = 'aiSettings';

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
  quickPrompts: ['提炼关键要点', '解释这段内容', '划出页面关键信息', '检索一些好用的技能'],
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
  // run_javascript 的审批策略：'each' 每次都要 / 'session' 本任务内允许一次 / 'auto' 自动批准。
  runJavascriptApproval: 'session',
};

export async function getAISettings() {
  const d = await chrome.storage.local.get(AI_SETTINGS_KEY);
  const saved = d[AI_SETTINGS_KEY] || {};
  const merged = Object.assign({}, AI_SETTINGS_DEFAULTS, saved);
  // 新版本新增的默认快捷指令会合并进已有用户设置：保留用户自定义项与顺序，去重后补齐新增项。
  if (Array.isArray(saved.quickPrompts)) {
    const list = saved.quickPrompts.slice();
    for (const prompt of AI_SETTINGS_DEFAULTS.quickPrompts) {
      if (!list.includes(prompt)) list.push(prompt);
    }
    merged.quickPrompts = list.slice(0, 12);
  }
  return merged;
}

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
  // 「任意代码执行」类工具的审批策略：
  //   'each' 每次都要 / 'session' 本任务内允许一次（默认） / 'auto' 自动批准。
  // 适用范围**不止 run_javascript**：用户脚本（run_userscript / install_userscript）执行的是
  // 第三方代码，且会从远程自动更新，与 run_javascript 同属 high + alwaysRequireApproval。
  // 原先这个键叫 runJavascriptApproval，UI 标签也只写「运行 JavaScript」——
  // 于是把它设为 'auto' 会在用户以为只放开 JavaScript 的情况下，一并放开第三方脚本。
  codeExecutionApproval: 'session',
  // 本机 MCP 桥接的共享 token。**刻意不给默认值**：此前它与 server 侧共用常量
  // 'recallflow-local-bridge-v1' 并被 README 公开，等于把密钥提交进仓库 ——
  // 任何本机进程都能冒充扩展、伪造证据快照。
  // 留空 = 不连接桥接（扩展其余功能不受影响）。需与 server 的
  // RECALLFLOW_BRIDGE_TOKEN 环境变量完全一致。
  bridgeToken: '',
};

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
    const list = saved.quickPrompts.slice();
    for (const prompt of AI_SETTINGS_DEFAULTS.quickPrompts) {
      if (!list.includes(prompt)) list.push(prompt);
    }
    merged.quickPrompts = list.slice(0, 12);
  }
  return merged;
}

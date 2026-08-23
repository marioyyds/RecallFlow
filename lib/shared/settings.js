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

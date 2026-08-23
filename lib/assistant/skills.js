// Skill 机制：把高频、跨意图的「专项任务流」从意图规则中抽离，
// 形成可复用、可触发的「专家手册」。命中后向 system prompt 注入专项规则/步骤，
// 并可按需补充工具与预算——让意图路由保持粗粒度（做什么），skill 负责细粒度（怎么做）。
//
// 与内置工具 / MCP 的分工：
//   - 内置工具（TOOL_REGISTRY）：「能做什么」，出厂固定能力
//   - MCP（mcp.js）：「外接什么」，远程扩展能力
//   - Skill（本文件）：「该怎么做」，专家工作流，纯提示层、不改工具签名
//
// SKILL_REGISTRY 的纯数据定义在 skill-defs.js（无工具依赖，前端页面也可直接引用）。
// 运行时技能 = 内置（skill-defs）+ 用户自定义（skill-store），通过 getMergedSkills 读取合并列表。
import { SKILL_REGISTRY } from './skill-defs.js';
import { getMergedSkills } from './skill-store.js';

export { SKILL_REGISTRY, getMergedSkills };

// 按指令与意图匹配 skill：intent 命中为可选约束，关键词命中必选（未配置关键词则仅看意图）。
// 改为 async：从持久化的「内置 + 自定义」合并列表中匹配，支持用户新增/编辑的技能。
const INTENT_CHAT = 'chat_task';

export async function detectSkill(instruction = '', intent = null) {
  const registry = await getMergedSkills();
  const text = String(instruction || '');
  const hits = [];
  for (const skill of registry) {
    const m = skill.match || {};
    const intentOk = !Array.isArray(m.intents) || m.intents.length === 0 || (intent && m.intents.includes(intent));
    const kwOk = !Array.isArray(m.keywords) || m.keywords.length === 0 || m.keywords.some((re) => re.test(text));
    // 普通对话意图下，抑制「未声明关键词」的任意匹配技能，避免劫持纯对话：
    // 否则模型会被诱导去调用工具 / 偏离"直接回答"，且无工具时还易触发空 tools 数组问题。
    if (intent === INTENT_CHAT && (!Array.isArray(m.keywords) || m.keywords.length === 0)) continue;
    if (intentOk && kwOk) hits.push(skill);
  }
  return hits;
}

// 把全部技能渲染为「技能目录」注入 system prompt：仅列 name + 用途，不注入正文。
// 模型判断相关时再通过常驻工具 load_skill 按需加载完整说明（进阶版 A）。
export function buildSkillCatalog(skills = []) {
  const list = Array.isArray(skills) ? skills : [];
  if (!list.length) return '';
  const items = list.map((s) => {
    const name = s.name || '';
    const desc = s.description || (s.content ? String(s.content).replace(/\s+/g, ' ').trim().slice(0, 80) : '');
    return '- ' + name + (desc ? '：' + desc : '');
  });
  return [
    '可用技能（专家手册）：',
    items.join('\n'),
    '当你判断当前任务适合使用其中某个技能时，调用 load_skill(name) 加载其完整使用说明，并严格遵循其指导；不要臆测技能内容，必须先 load_skill 获取。',
  ].join('\n');
}

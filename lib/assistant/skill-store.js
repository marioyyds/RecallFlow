// 技能持久化：内置技能来自 skill-defs.js（只读），用户自定义技能存于 chrome.storage.local。
// 数据采用 SkillHub 标准 SKILL.md 形态（frontmatter 字段 + content 正文），
// RecallFlow 专有触发条件放在 x.recallflow-* 扩展字段。
// 运行时「合并列表」= 内置(编译为运行结构) + 自定义(编译为运行结构)。
import { SKILL_REGISTRY as DEFAULT_SKILLS } from './skill-defs.js';
import { toRuntimeSkill } from './skill-md.js';

const STORAGE_KEY = 'recallflow.skills';
const PAGE_SIZE = 6;

// 把内置/自定义的标准技能对象编译为运行结构（含编译后的正则关键词）。
function compileAll(list, builtin) {
  return list.map((s) => toRuntimeSkill(s, builtin));
}

export function getDefaultSkills() {
  return compileAll(DEFAULT_SKILLS, true);
}

// 返回用户自定义技能的原始标准对象（未编译，便于编辑/展示）。
export async function getUserSkills() {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY);
    const list = (r && r[STORAGE_KEY]) || [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

export async function getMergedSkills() {
  const defaults = getDefaultSkills();
  const user = compileAll(await getUserSkills(), false);
  const names = new Set(defaults.map((s) => s.name));
  // 内置优先：忽略与内置同名的用户自定义技能，避免重复出现在目录/触发中。
  return defaults.concat(user.filter((s) => !names.has(s.name)));
}

// 存储时只保存标准形状（不含编译后的 RegExp），保持与 SKILL.md 一致、可序列化。
function toStorageShape(skill) {
  const x = skill.x || {};
  return {
    name: skill.name,
    displayName: skill.displayName || '',
    description: skill.description || '',
    version: skill.version || '1.0.0',
    category: skill.category || '',
    tags: Array.isArray(skill.tags) ? skill.tags : [],
    skill_type: skill.skill_type || 'prompt-template',
    content: skill.content || '',
    x: {
      intents: Array.isArray(x.intents) ? x.intents : [],
      keywords: Array.isArray(x.keywords) ? x.keywords : [],
      tools: Array.isArray(x.tools) ? x.tools : [],
    },
  };
}

async function saveUserSkills(list) {
  await chrome.storage.local.set({ [STORAGE_KEY]: list.map(toStorageShape) });
}

function genId() {
  return 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export async function addUserSkill(skill) {
  const list = await getUserSkills();
  const item = toStorageShape({ ...skill, name: skill.name || genId() });
  list.push(item);
  await saveUserSkills(list);
  return item;
}

export async function updateUserSkill(id, patch) {
  const list = await getUserSkills();
  const idx = list.findIndex((s) => s.name === id);
  if (idx < 0) return null;
  list[idx] = toStorageShape({ ...list[idx], ...patch, name: list[idx].name });
  await saveUserSkills(list);
  return list[idx];
}

export async function removeUserSkill(id) {
  const list = await getUserSkills();
  const next = list.filter((s) => s.name !== id);
  await saveUserSkills(next);
  return next;
}

export { PAGE_SIZE };

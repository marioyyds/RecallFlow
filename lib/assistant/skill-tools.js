// 技能加载族（load_skill / install_skill / 以及 SkillHub 安装链路）—— C-1 拆出的第 10 族。
//
// 为什么这两者算一族：都围绕"技能"这一对象 —— 一个按需加载使用说明，一个从 SkillHub 安装。
//
// **搬运原则：不重写行为。** 实现从 tools.js 原样搬来，闭包依赖改为显式注入。
//
// ⚠ 两条**有意保留**的语义：
//   1. `load_skill` 的**按需加载**设计：技能正文不预先注入系统提示（省 token），
//      由模型判断相关时再取。所以这里返回的是"完整使用说明"，不是摘要。
//   2. `load_skill` 找不到技能时要说清"可用技能见系统提示中的技能目录" ——
//      否则模型会反复换名字试（实测空耗）。查到技能后还要跑 `validateSkillTools`：
//      技能声明的依赖工具若不存在，必须**明确告知去技能页修**，而不是让模型反复调用失败。

/** load_skill：按需返回某技能的完整使用说明。 */
export async function loadSkill(deps, args) {
  // 进阶版 A：按需把技能的完整使用说明返回给模型（不预先注入，省 token、由模型自选）。
  const name = String((args && args.name) || '').trim();
  if (!name) return { ok: false, result: '缺少技能 name 参数。' };
  const all = await deps.getMergedSkills();
  const skill = all.find((s) => s.name === name || s.title === name || s.id === name);
  if (!skill) return { ok: false, result: '未找到名为「' + name + '」的技能。可用技能见系统提示中的技能目录。' };
  const parts = ['# 技能：' + (skill.title || skill.name)];
  if (skill.description) parts.push('用途：' + skill.description);
  if (Array.isArray(skill.tags) && skill.tags.length) parts.push('标签：' + skill.tags.join('、'));
  if (skill.content) parts.push(skill.content);
  const toolWarnings = deps.validateSkillTools(skill);
  if (toolWarnings.length) {
    parts.push(
      '⚠ 注意：该技能声明的依赖工具存在问题，Agent 无法调用，请到技能页更新依赖工具列表：\n' +
        toolWarnings.map((w) => '- ' + w).join('\n')
    );
  }
  return { result: parts.join('\n\n') };
}

/** install_skill：从 SkillHub 安装技能。 */
export async function installSkill(deps, args) {
  const identifier = String((args && (args.identifier || args.url)) || '').trim();
  if (!identifier) return { ok: false, result: '缺少技能 identifier 参数。' };
  return await deps.installSkillFromSkillHub(identifier);
}

/** 该族处理哪些工具名。 */
export const SKILL_TOOLS = new Set(['load_skill', 'install_skill']);

/** 统一入口。返回 null 表示"不属于本族"。 */
export async function handleSkillTool(name, args, deps) {
  if (name === 'load_skill') return await loadSkill(deps, args);
  if (name === 'install_skill') return await installSkill(deps, args);
  return null;
}

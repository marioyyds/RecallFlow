import type { Caught } from './errors.ts';
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

/**
 * **通用操作纪律（底座）**：所有技能共用的一段，由 `load_skill` 统一附加。
 *
 * ## 为什么要抽这一段
 *
 * 实测统计（见 `docs/skills-overview.md` 的"重复的通用纪律"一节）：
 * `complete_task` 被 **33** 个技能声明、`get_page_snapshot` **31** 个、`inspect_element` **28** 个 ——
 * 也就是说"先看清再动手、改完回读确认、收尾如实汇报"这套纪律，在 36 份技能文案里各写了一遍 ✗
 * 重复带来的不是更可靠，而是**更容易漂移**：改一处忘了另一处，模型拿到的指导就不一致。
 *
 * 抽成底座后语义**只在这里定义一次**，每个技能一加载就能拿到；
 * 各技能正文里那些重复段落可以在后续轮次里逐步删掉（不必一次改 33 处 ✗）。
 *
 * ## 为什么放在 load_skill 而不是系统提示里
 *
 * 系统提示要常驻，而底座只在"真的用了某个技能"时才有意义 ——
 * 放这里既不占常驻 token，又保证模型无论加载哪个技能都能看到同一份纪律。
 */
export const COMMON_OPERATING_DISCIPLINE = [
  '## 通用操作纪律（所有技能共用，务必遵守）',
  '',
  '1. **先看清再动手**：用 `get_page_snapshot` 确认页面上到底有什么，不要凭技能文案里的假设去点。',
  '2. **一次只改一个变量**：改完立刻**回读确认**（`inspect_element` 读值/样式，或重新快照），',
  '   不要假设"点了就一定生效"—— 很多控件的点击是异步的，或根本没生效。',
  '3. **关键动作后复核**：提交/删除/跳转这类不可逆动作之后，重新读一次页面状态再往下走。',
  '4. **失败要换策略，不要重试同一条调用**：同一条路连续失败两次，就换一条（换选择器、换定位方式、',
  '   先滚动/先等待）；上下文里通常已经写明了失败原因，先读它。',
  '5. **收尾必须调 `complete_task`**：如实说明**做到了什么、没做到什么、为什么** ——',
  '   做不到就说做不到，不要用"已尝试""应该可以"这类话糊过去。',
  '6. **不确定就说不确定**：宁可少做一步再问，也不要编造页面内容或操作结果。',
].join('\n');

/** load_skill：按需返回某技能的完整使用说明。 */
export async function loadSkill(deps: any, args: Record<string, unknown>) {
  // 进阶版 A：按需把技能的完整使用说明返回给模型（不预先注入，省 token、由模型自选）。
  const name = String((args && args.name) || '').trim();
  if (!name) return { ok: false, result: '缺少技能 name 参数。' };
  const all = await deps.getMergedSkills();
  const skill = all.find((s: any) => s.name === name || s.title === name || s.id === name);
  if (!skill) return { ok: false, result: '未找到名为「' + name + '」的技能。可用技能见系统提示中的技能目录。' };
  const parts = ['# 技能：' + (skill.title || skill.name)];
  if (skill.description) parts.push('用途：' + skill.description);
  if (Array.isArray(skill.tags) && skill.tags.length) parts.push('标签：' + skill.tags.join('、'));
  if (skill.content) parts.push(skill.content);
  // ⛔ **不要**把通用纪律底座拼进技能返回里 —— 实测它会造成退化（第 26 轮）。
  //
  // 实验（同一个场景、同一个模型、真模型 eval，见 docs/regression-red-flag.md）：
  //   · **注入底座**：7 次里 3 次通过（≈43%）✗
  //   · **不注入**（本文件当前状态）：4 次里 4 次通过，加上加底座之前的 1 次共 **5/5** ✓
  // ⇒ 每次 load_skill 都追加约 600 字符的通用纪律，**稀释了技能正文**，
  //   模型更容易"更早收手"（这正是典型的"好心加了提示、结果变差"）。
  //
  // 更别说它还有个结构性问题：**每次加载技能都会重复拼一遍**（同一轮加载两个技能就出现两次），
  // 既费 token 又把重复当成强调。
  //
  // 若将来想再试，**必须先测量**（同场景至少各 6 次，比较通过率），
  // 并把结果写进 docs/regression-red-flag.md —— 门禁里也写明了这一点。
  const toolWarnings = deps.validateSkillTools(skill);
  if (toolWarnings.length) {
    parts.push(
      '⚠ 注意：该技能声明的依赖工具存在问题，Agent 无法调用，请到技能页更新依赖工具列表：\n' +
        toolWarnings.map((w: any) => '- ' + w).join('\n')
    );
  }
  return { result: parts.join('\n\n') };
}

/** install_skill：从 SkillHub 安装技能。 */
export async function installSkill(deps: any, args: Record<string, unknown>) {
  const identifier = String((args && (args.identifier || args.url)) || '').trim();
  if (!identifier) return { ok: false, result: '缺少技能 identifier 参数。' };
  return await deps.installSkillFromSkillHub(identifier);
}

// ---------------------------------------------------------------------------
// save_skill：把一段**可复用**的做法沉淀成自定义技能（SKILL.md 形态，存 chrome.storage.local）。
//
// ## 为什么需要它（这是一个真实的能力缺口，不是锦上添花）
//
// 会话 RF-FY6PUP：用户在小红书发布流程跑通后说「沉淀为技能」，
// 而当时技能族**只有 load_skill（读）和 install_skill（从 SkillHub 装）** ——
// 没有任何工具能写一份技能，于是模型只能把它降级成 `macro({op:"save"})` 去做，
// 最后两头落空。用户看到的现象就是「不能保存 skill 和宏」。
//
// ## 为什么必须是独立工具、且审批最严
//
// 1. 它写的是**会进入今后系统提示的指令**（技能正文由 load_skill 取回、并可能被当作专家手册遵循），
//    也就是说这是一条**持久化**的注入面 —— 单次 run_javascript 的影响只在一轮里，这个不是。
//    因此 risk:'high' + `alwaysRequireApproval`：**不受**站点信任、也不受"类别自动批准"影响
//    （见 lib/assistant/approval-policy.js 与 lib/assistant/tool-metadata.js）。
// 2. 不能并入 `skill({op:"save"})`：审批函数拿不到 args，无法按 op 分级
//    （docs/tool-merge-plan.md 第 6 档的结论）。
//
// ## 两条"静默失败"防线
//
// · **与内置技能重名必须拒绝**：`getMergedSkills()` 里内置优先，同名自定义技能会被
//   **静默忽略** ⇒ "保存成功"与"技能不生效"同时成立，是最坏的一种失败。
// · **依赖工具名写错要当场说**：错了工具在运行时会被忽略（见 validateSkillTools），
//   必须在保存结果里就报出来，而不是让用户下次用到才发现。
// ---------------------------------------------------------------------------

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_TYPES = ['prompt-template', 'mcp-server', 'api-tool', 'agent'];
export const SKILL_INTENTS = ['browser_task', 'knowledge_task', 'research_task', 'chat_task'];
/** 正文长度边界：太短写不清"以后怎么做"，太长则每次加载都稀释上下文（技能是按需取回的，但仍要克制）。 */
export const MIN_SKILL_CONTENT = 40;
export const MAX_SKILL_CONTENT = 20000;

/** 把用户/模型给的技能名归一化成 kebab-case（中文等无法转换的字符一律剔除）。 */
export function normalizeSkillName(input: any) {
  return String(input == null ? '' : input)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

function toStringList(value: any, limit: any) {
  const arr = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? value.split(/[,\n]/)
      : [];
  return arr
    .map((x) => String(x == null ? '' : x).trim())
    .filter(Boolean)
    .slice(0, limit);
}

/** save_skill：新增或覆盖一个自定义技能。 */
export async function saveSkill(deps: any, args: Record<string, unknown>) {
  const a = args || {};
  const name = normalizeSkillName(a.name);
  if (!name) {
    return {
      ok: false,
      result:
        '缺少技能 name，或它归一化后为空（name 需为 kebab-case：小写字母/数字，用 - 分隔，如 publish-xhs-note）。',
    };
  }
  // normalizeSkillName 的输出**按构造**就是合法 kebab-case（转小写 → 剔除非法字符 →
  // 折叠连字符 → 去掉首尾连字符），因此这里不再重复一次正则校验（那是永远为真的死代码）。
  const content = String(a.content || '').trim();
  if (content.length < MIN_SKILL_CONTENT) {
    return {
      ok: false,
      result:
        '技能正文太短（' + content.length + ' 字符，至少 ' + MIN_SKILL_CONTENT + '）。' +
        '正文要写"以后怎么做"：适用场景 / 步骤 / 边界与坑 / 完成判据 —— 只复述"这次做了什么"下次用不上。',
    };
  }
  if (content.length > MAX_SKILL_CONTENT) {
    return {
      ok: false,
      result: '技能正文过长（' + content.length + ' > ' + MAX_SKILL_CONTENT + ' 字符）。请只留可复用的要点。',
    };
  }
  const builtins = (typeof deps.getDefaultSkills === 'function' ? deps.getDefaultSkills() : []) || [];
  if (builtins.some((s: any) => s && s.name === name)) {
    return {
      ok: false,
      result:
        '「' + name + '」与**内置技能**重名：内置优先，同名自定义技能会被静默忽略（保存了也不生效）。' +
        '请换一个 name，例如 ' + name + '-custom。',
    };
  }
  const skillType = SKILL_TYPES.includes(String(a.skill_type || '')) ? String(a.skill_type) : 'prompt-template';
  const payload = {
    name,
    displayName: String(a.displayName || '').trim().slice(0, 80),
    description: String(a.description || '').trim().slice(0, 300),
    version: String(a.version || '1.0.0').trim() || '1.0.0',
    category: String(a.category || '').trim().slice(0, 40),
    tags: toStringList(a.tags, 8),
    skill_type: skillType,
    content,
    x: {
      intents: toStringList(a.intents, 4).filter((i) => SKILL_INTENTS.includes(i)),
      keywords: toStringList(a.keywords, 12),
      tools: toStringList(a.tools, 24),
    },
  };
  const existing = (await deps.getUserSkills()) || [];
  const isUpdate = existing.some((s: any) => s && s.name === name);
  let saved = null;
  try {
    saved = isUpdate ? await deps.updateUserSkill(name, payload) : await deps.addUserSkill(payload);
  } catch (e) {
    return {
      ok: false,
      result: '保存技能失败：' + ((e && (e as Caught).message) || String(e)) + '（本地存储可能已满或不可用，可在技能页确认）。',
    };
  }
  // updateUserSkill 对不存在的名字返回 null；若真发生，如实报错而不是假报成功。
  if (!saved) return { ok: false, result: '保存技能失败：' + name + ' 未能写入本地存储（技能页可确认当前列表）。' };
  const warnings = typeof deps.validateSkillTools === 'function' ? deps.validateSkillTools(payload) : [];
  return {
    result:
      (isUpdate ? '已更新技能' : '已保存技能') + '「' + (saved.displayName || saved.name) + '」（name=' + saved.name +
      '，正文 ' + content.length + ' 字符）。它已进入技能目录，今后可用 load_skill("' + saved.name + '") 加载。\n' +
      '⚠ 请到扩展的「技能」页核对正文与触发条件：它会进入今后的系统提示，写错会持续误导后续任务。' +
      (warnings.length ? '\n依赖工具有问题（运行时会被忽略）：\n' + warnings.map((w: any) => '- ' + w).join('\n') : ''),
  };
}

/** 该族处理哪些工具名。 */
export const SKILL_TOOLS = new Set(['load_skill', 'install_skill', 'save_skill']);

/** 统一入口。返回 null 表示"不属于本族"。 */
export async function handleSkillTool(name: string, args: Record<string, unknown>, deps: any) {
  if (name === 'load_skill') return await loadSkill(deps, args);
  if (name === 'install_skill') return await installSkill(deps, args);
  if (name === 'save_skill') return await saveSkill(deps, args);
  return null;
}

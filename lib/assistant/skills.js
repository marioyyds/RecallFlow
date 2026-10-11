// Skill 机制：把高频、跨意图的「专项任务流」从意图规则中抽离，形成可复用的「专家手册」。
// 让意图路由保持粗粒度（做什么），skill 负责细粒度（怎么做）。
//
// ⚠ **注入方式（2026-10 复核后的现状）**：system prompt 里**只放一行 `name：description`
// 的目录**，正文**不预先注入**；模型读目录后自己判断要不要 `load_skill(name)` 取回正文。
// 曾经还有一条"按关键词正则命中就注入正文"的路（`detectSkill()`），因**生产里没有调用方**
// 已删除 —— 原因、删后的匹配方式、以及"将来要接回必须测量"都写在下面的长注释里。
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

// ⛔ **已删除 `detectSkill()`（2026-10，目标 ⑤「技能归纳」这一轮）：运行时不做关键词匹配。**
//
// ## 为什么删
//
// 它按 `x.keywords` / `x.intents` 对**整条用户指令**跑正则，命中就把技能正文注入 system prompt。
// 但**生产代码里从头到尾没有调用方**：全仓 grep（`lib/`、`scripts/`、`integrations/`、
// `background.js`、`content.js` 产物，含字符串形式的动态引用）只找到它自己的定义与
// `tests/silent-failure-regressions.test.mjs` 里的调用 —— 也就是说那条「技能触发条件缺失」
// 门禁**测的是一条永远不在生产里跑的路**，给人"触发条件被守住了"的错觉 ✗
// 本仓库最忌"假装通过"，所以删掉这条路，而不是留着它继续演。
//
// ## 删掉之后，"技能匹配"靠什么
//
// 靠**模型读 description 自己选**（唯一的生产路径）：
//   1. `buildSkillCatalog()`（本文件）把每个技能渲染成**一行** `- name：description` 注入 system prompt；
//   2. 模型判断当前任务适合某个技能时，调用常驻工具 `load_skill(name)` 取回正文（`skill-tools.js`）；
//   3. 正文只在**模型主动加载**后才进入上下文 —— 没有正则、没有"命中即注入"。
// ⇒ 运行时"技能 ↔ 场景"的对应比清单上松得多：真模型实测里 **30 条剧本有 10 条一个技能都没加载
//    也照样通过**，还有少数场景加载的是"不是自己那条"技能（`docs/real-model-eval-log.md`）。
//    ⇒ **孤儿技能 ≠ 没被用**（`clip-to-knowledge` 会被知识库那两条剧本加载）。
//
// ## `x.keywords` / `x.intents` 为什么还留着
//
// 它们仍有**非运行时**的消费者，删不得：
//   · `skill-md.js` 把 `x-recallflow-keywords` 序列化进 SKILL.md / 反序列化回来（SkillHub 格式往返）；
//   · `skill-store.js` 读写用户自定义技能的 `match.intents`；
//   · `skills-page.js` 把"触发意图 / 触发关键词"显示在技能编辑页上。
//   ⇒ 删掉的只是"**用关键词做运行时匹配**"这条没人走的路，不是这套元数据本身。
//
// ## 将来要接回运行时怎么办
//
// 那是**行为改动**（模型可见内容变了 ⇒ 正确率可能变），必须按 `docs/regression-red-flag.md`
// 的纪律先测量再上：至少同场景多次真模型 eval 比较通过率，并把结果写进
// `docs/real-model-eval-log.md`。**不要**因为"看起来能省 token"就直接接回去
// （通用纪律底座的教训：注入后通过率 5/5 → 3/7）。

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

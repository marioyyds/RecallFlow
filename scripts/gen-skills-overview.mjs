// 生成 `docs/skills-overview.md`：把**技能清单与剧本归属**从产物里推导出来，不手写。
//
// 为什么需要它（目标 ⑤ 的一部分）：
//   · 技能已经涨到 36 个，而它们与 27 个能力剧本的对应关系只散落在源码里
//     （`playbook: '<id>'` 字段），人和门禁都不容易一眼看全；
//   · 更要紧的是**孤儿技能**（有技能、没有对应剧本）：它们没有真浏览器验收，
//     属于"文案写了但没人验过"的部分 —— 这份清单把它们**单独列出来**，
//     免得它们悄悄堆在那里，看起来像"已覆盖"✗
//
// 与 `gen-capability-inventory.mjs` 同源：都用源码扫描（技能定义里有浏览器侧依赖，不导入）。
// 手写的清单必然腐烂；这份由门禁（tests/skills-overview.test.mjs）每次重算比对。
//
// 用法：node scripts/gen-skills-overview.mjs
import fs from 'node:fs';
import path from 'node:path';
import { PLAYBOOKS } from '../tests/e2e/fixtures/playbooks.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * 解析 `ORPHAN_SKILL_REASONS` 的条目（从 skill-defs.js 里读，避免复制粘贴导致两边漂移）。
 *
 * ⚠ 这里**必须**把"多行字符串拼接"拼起来：理由是中文长句，源码里普遍写成
 *   `'第一段' +` / `'第二段'` 这种跨行拼接。原来的正则只认 `'...',\n` 的单行形态，
 *   遇到拼接就把 `' + '` 当内容留在正文里 —— 门禁（比对生成物）发现不了这种
 *   "解析出来的文本本身就是垃圾"，但**读者**会看到 `' + '` 这种源码碎片 ✗
 * 所以：从每个 `key:` 开始，把紧随其后的所有单引号字面量依次拼接，遇到下一个 key 或表尾即停。
 */
export function parseOrphanReasonEntries(src) {
  const text = String(src || '');
  const at = text.indexOf('export const ORPHAN_SKILL_REASONS');
  if (at < 0) return [];
  const end = text.indexOf('});', at);
  const body = text.slice(at, end < 0 ? undefined : end);
  const entries = [];
  for (const hit of body.matchAll(/'([a-z0-9-]+)':/g)) {
    const literals = [];
    let i = hit.index + hit[0].length;
    for (;;) {
      while (i < body.length && /[\s+]/.test(body[i])) i++; // 跨行 + 号
      if (body[i] !== "'") break;
      i++;
      let buf = '';
      while (i < body.length) {
        const ch = body[i];
        if (ch === '\\') {
          buf += body[i + 1] === undefined ? '' : body[i + 1];
          i += 2;
          continue;
        }
        if (ch === "'") {
          i++;
          break;
        }
        buf += ch;
        i++;
      }
      literals.push(buf);
      // 字面量之后若紧接着下一个 key，说明本条目结束
      let j = i;
      while (j < body.length && /[\s+]/.test(body[j])) j++;
      if (/^'[a-z0-9-]+':/.test(body.slice(j))) break;
    }
    entries.push({ name: hit[1], reason: literals.join('').replace(/\s+/g, ' ').trim() });
  }
  return entries;
}

/** 孤儿技能的原因表（key → 已拼好的理由文本）。 */
const ORPHAN_REASONS = (() => {
  const out = {};
  for (const e of parseOrphanReasonEntries(read('lib/application/agent/skill-defs.ts'))) out[e.name] = e.reason;
  return out;
})();

export function buildSkillsOverview() {
  const src = read('lib/application/agent/skill-defs.ts');
  // 技能块：以 `name: '...'` 起，到下一个 `name: '...'` 之前（够用且不脆）
  const blocks = [];
  const re = /\n\s{4}name:\s*'([a-z0-9-]+)'/g;
  let m;
  const starts = [];
  while ((m = re.exec(src)) !== null) starts.push({ name: m[1], at: m.index });
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : src.length;
    blocks.push({ name: starts[i].name, body: src.slice(starts[i].at, end) });
  }

  const pick = (body, key) => {
    const mm = new RegExp(key + ":\\s*'([^']*)'").exec(body);
    return mm ? mm[1] : '';
  };

  const skills = blocks.map((b) => {
    const playbook = (/: {[\s\S]*?playbook:\s*'([a-z0-9-]+)'/.exec(b.body) || [])[1] ||
      (/playbook:\s*'([a-z0-9-]+)'/.exec(b.body) || [])[1] || '';
    // 孤儿技能的原因来自 `ORPHAN_SKILL_REASONS`（集中声明，便于复核与"只减不增"）。
    // 也兼容在技能块里就地写 `// 无剧本：<原因>`。
    const inline = (/\/\/\s*无剧本：\s*(.+)/.exec(b.body) || [])[1] || '';
    const reason = (inline || ORPHAN_REASONS[b.name] || '').trim();
    return {
      name: b.name,
      displayName: pick(b.body, 'displayName'),
      category: pick(b.body, 'category'),
      playbook,
      reason,
    };
  });

  const playbookIds = Object.keys(PLAYBOOKS);
  const withPlaybook = skills.filter((s) => s.playbook && playbookIds.includes(s.playbook));
  const orphans = skills.filter((s) => !(s.playbook && playbookIds.includes(s.playbook)));

  // 各技能声明的工具 → 统计"同一条纪律被重复写了多少次"。
  //
  // 为什么要量化：目标 ⑤ 要求抽「通用操作纪律」底座消除重复，而"重复"必须有**数字**才谈得上消除，
  // 否则只会凭印象改 ✗ 这里直接从产物数出来（每个技能的 `tools: [...]`），
  // 于是"要不要抽底座、抽哪几条"变成可复核的判断，而不是感觉。
  const toolCounts = new Map();
  for (const b of blocks) {
    const mm = /tools:\s*\[([^\]]*)\]/.exec(b.body);
    if (!mm) continue;
    const names = (mm[1].match(/'([a-z0-9_]+)'/g) || []).map((x) => x.replace(/'/g, ''));
    for (const n of new Set(names)) toolCounts.set(n, (toolCounts.get(n) || 0) + 1);
  }
  const ranking = Array.from(toolCounts.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  const duplicated = ranking.filter((r) => r.count >= 3);

  // 文案体量（近似）：把该技能 `content:` 之后的**字符串字面量**长度累加。
  //
  // 为什么要量：目标 ⑤ 要求"薄技能充实或合并"，而没有数字就只能凭印象挑 ✗
  // 近似口径写在文档里（只数单引号/双引号字面量，不含模板拼接与转义展开），避免读者误当成精确值。
  for (const s of skills) {
    const b = blocks.find((x) => x.name === s.name);
    const at = b ? b.body.indexOf('content:') : -1;
    if (at < 0) { s.contentChars = 0; continue; }
    const tail = b.body.slice(at);
    let sum = 0;
    for (const m of tail.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
      sum += (m[1] !== undefined ? m[1] : m[2] || '').length;
    }
    s.contentChars = sum;
  }
  const thin = skills
    .filter((s) => s.contentChars > 0 && s.contentChars < 400)
    .sort((a, b) => a.contentChars - b.contentChars);

  const lines = [];
  lines.push('# 技能清单（自动生成，勿手改）');
  lines.push('');
  lines.push('本文件由 `node scripts/gen-skills-overview.mjs` 从 `lib/application/agent/skill-defs.ts` 与');
  lines.push('`tests/e2e/fixtures/playbooks.mjs` 推导得出，并由 `tests/skills-overview.test.mjs` 门禁');
  lines.push('比对"产物变了而本文件没跟上"。**不要手写这份清单** —— 手写的必然腐烂。');
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('| --- | --- |');
  lines.push('| 技能总数 | **' + skills.length + '** |');
  lines.push('| 有剧本归属（真浏览器验收覆盖） | **' + withPlaybook.length + '** |');
  lines.push('| **孤儿技能**（无验收覆盖） | **' + orphans.length + '** |');
  lines.push('| 能力剧本总数 | **' + playbookIds.length + '** |');
  lines.push('');
  // ---- 固定说明段（不是数出来的，是**实测事实** + 结构性事实；数字全部来自
  //      docs/real-model-eval-log.md，不许在这里编新数字）----
  lines.push('## 运行时到底怎么"选技能"（2026-10 复核，与清单无关）');
  lines.push('');
  lines.push('这一节是**手工维护的固定说明**（不是从源码数出来的），因为它讲的是运行时的真实行为，');
  lines.push('而清单只能数出"有哪些技能、对应哪条剧本"。');
  lines.push('');
  lines.push('1. **生产只给模型一行 `name：description`。** `buildSkillCatalog()`（`lib/application/agent/skills.ts`）');
  lines.push('   把每个技能渲染成 `- name：用途`，随 system prompt 一起发出；**正文不预先注入**。');
  lines.push('   模型判断当前任务适合某个技能时，才调用常驻工具 `load_skill(name)` 取回正文（`lib/application/agent/skill-tools.ts`）。');
  lines.push('2. **运行时不做关键词匹配。** 曾经有一条"按 `x.keywords` 正则命中就注入正文"的路');
  lines.push('   （`skills.js` 的 `detectSkill()`），它**在生产代码里没有任何调用方**，已于目标 ⑤ 删除。');
  lines.push('   `x.keywords` / `x.intents` 仍保留，但只用于 **SkillHub 格式往返**（`skill-md.js`）与技能编辑页展示');
  lines.push('   （`skills-page.js`）—— 与"选哪个技能"无关。');
  lines.push('3. **因此"技能 ↔ 场景"在运行时比清单上松得多**（真模型实测，`docs/real-model-eval-log.md` 的');
  lines.push('   「技能 ↔ 场景在运行时比清单上松得多」一节）；其中最要紧的两条：');
  lines.push('   · **有 10 条场景一个技能都没加载，照样通过** —— 清单上的"有内置技能"是**资产层面**的对应，');
  lines.push('     不等于"运行时模型会用它"✗；');
  lines.push('   · 少数场景加载的是**不是自己那条**技能（如 `form-validation` 那次加载了 `checkout-form`），');
  lines.push('     也照样通过；');
  lines.push('   · **孤儿 ≠ 没被用**：`clip-to-knowledge` 没有自己的剧本，却被「知识库往返」与');
  lines.push('     「知识库检索回退」两条剧本**实际加载过**。');
  lines.push('4. **所以"孤儿技能"说的是验收覆盖，不是使用价值**：它意味着"没有夹具页 + 真浏览器判据"，');
  lines.push('   意味着**改它的文案没法用现有 eval 测量**（这正是孤儿的代价）。');
  lines.push('5. **文案的可执行性有一条静态门禁**（`tests/skill-content-structure.test.mjs`）：');
  lines.push('   每个技能的正文要么有**连续编号、从 1 开始**的步骤清单，要么**显式声明**"本技能无步骤：<原因>"。');
  lines.push('   依据是本仓库最贵的一课：**散文式的关键步骤会被模型跳过**（`readability-fix` 最早漏掉"改行宽"）。');
  lines.push('   ⚠ 这道门禁**只**保证"结构上做得出来"，**不**保证"模型真的照做" —— 后者只有真模型 eval 能回答。');
  lines.push('');
  lines.push('## 有剧本归属的技能（每一项都有夹具页 + E2E 判据）');
  lines.push('');
  lines.push('| 技能 | 展示名 | 分类 | 对应剧本 |');
  lines.push('| --- | --- | --- | --- |');
  for (const s of withPlaybook.slice().sort((a, b) => a.playbook.localeCompare(b.playbook))) {
    lines.push('| `' + s.name + '` | ' + (s.displayName || '—') + ' | ' + (s.category || '—') + ' | `' + s.playbook + '` |');
  }
  lines.push('');
  lines.push('## 重复的通用纪律（抽「底座」的依据，数出来的不是感觉）');
  lines.push('');
  lines.push('每个技能都要自带一遍"先快照、后操作、收尾 complete_task"这类纪律，');
  lines.push('于是同一条纪律在多个技能里重复。下表统计**被至少 3 个技能声明**的工具 ——');
  lines.push('数字越大，越说明它该被抽成公共底座（而不是在 36 份文案里各写一遍）。');
  lines.push('');
  lines.push('| 工具 | 声明它的技能数 |');
  lines.push('| --- | --- |');
  for (const r of duplicated) lines.push('| `' + r.tool + '` | ' + r.count + ' |');
  lines.push('');
  lines.push('（全部工具的出现次数见下方明细；`tools` 为空或未声明的技能不参与统计。）');
  lines.push('');
  lines.push('<details><summary>全部工具的出现次数</summary>');
  lines.push('');
  lines.push('| 工具 | 技能数 |');
  lines.push('| --- | --- |');
  for (const r of ranking) lines.push('| `' + r.tool + '` | ' + r.count + ' |');
  lines.push('');
  lines.push('</details>');
  lines.push('');
  lines.push('## 薄技能（文案偏短，可能讲不清"怎么做"）');
  lines.push('');
  lines.push('口径：`content` 里**字符串字面量**的字符数累加（近似值，不含转义展开），');
  lines.push('这里列出 **< 400 字符**的。目标 ⑤ 要求"薄技能充实或合并" —— 没有数字就只能凭印象挑 ✗');
  lines.push('');
  if (!thin.length) {
    lines.push('（当前没有 < 400 字符的技能）');
  } else {
    lines.push('| 技能 | 文案字符数 | 展示名 |');
    lines.push('| --- | --- | --- |');
    for (const s of thin) lines.push('| `' + s.name + '` | ' + s.contentChars + ' | ' + (s.displayName || '—') + ' |');
  }
  lines.push('');
  lines.push('## ⚠ 孤儿技能（**没有**真浏览器验收 —— 文案写了，但没人验过）');
  lines.push('');
  lines.push('这些技能只在"模型读到文案"这一层有效，**没有**夹具页与 E2E 判据。');
  lines.push('要么给它们补一个能力剧本，要么在技能定义里写一行 `// 无剧本：<原因>` 显式声明。');
  lines.push('');
  lines.push('⚠ **孤儿 ≠ 没被用**（真模型实测）：`clip-to-knowledge` 就在这里，却被「知识库往返」与');
  lines.push('「知识库检索回退」两条剧本实际加载过。孤儿状态说明的是**没有自己的验收覆盖**，');
  lines.push('也就是**改它的文案没法用现有 eval 测量** —— 不是"这个技能没人会用"。');
  lines.push('每条理由都由 `tests/skill-content-structure.test.mjs` 门禁核对：**必须是够用的理由**，');
  lines.push('写"待补""暂无"这类空话会被判红。');
  lines.push('');
  if (!orphans.length) {
    lines.push('（当前没有孤儿技能）');
  } else {
    lines.push('| 技能 | 展示名 | 分类 | 为什么没有剧本 |');
    lines.push('| --- | --- | --- | --- |');
    for (const s of orphans.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push('| `' + s.name + '` | ' + (s.displayName || '—') + ' | ' + (s.category || '—') + ' | ' + (s.reason || '**（未声明）**') + ' |');
    }
  }
  lines.push('');
  return { skills, withPlaybook, orphans, playbookIds, ranking, duplicated, text: lines.join('\n') + '\n' };
}

const OUT = 'docs/skills-overview.md';
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('gen-skills-overview.mjs')) {
  const { text, orphans } = buildSkillsOverview();
  fs.writeFileSync(path.join(ROOT, OUT), text);
  console.log('已生成 ' + OUT + '；孤儿技能 ' + orphans.length + ' 个');
}

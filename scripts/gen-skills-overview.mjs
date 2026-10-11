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

/** 孤儿技能的原因表（从 skill-defs.js 里读，避免复制粘贴导致两边漂移）。 */
const ORPHAN_REASONS = (() => {
  const src = read('lib/assistant/skill-defs.js');
  const at = src.indexOf('export const ORPHAN_SKILL_REASONS');
  if (at < 0) return {};
  const end = src.indexOf('});', at);
  const body = src.slice(at, end);
  const out = {};
  for (const m of body.matchAll(/'([a-z0-9-]+)':\s*\n?\s*'([\s\S]*?)',\n/g)) {
    out[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  }
  return out;
})();

export function buildSkillsOverview() {
  const src = read('lib/assistant/skill-defs.js');
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

  const lines = [];
  lines.push('# 技能清单（自动生成，勿手改）');
  lines.push('');
  lines.push('本文件由 `node scripts/gen-skills-overview.mjs` 从 `lib/assistant/skill-defs.js` 与');
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
  lines.push('## ⚠ 孤儿技能（**没有**真浏览器验收 —— 文案写了，但没人验过）');
  lines.push('');
  lines.push('这些技能只在"模型读到文案"这一层有效，**没有**夹具页与 E2E 判据。');
  lines.push('要么给它们补一个能力剧本，要么在技能定义里写一行 `// 无剧本：<原因>` 显式声明。');
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

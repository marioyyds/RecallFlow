// 生成 `docs/capability-inventory.md`：把 **24 个能力剧本 × 三层形状** 从产物里**推导**出来，
// 不手写。手写的清单必然腐烂；这里的清单由门禁（tests/capability-inventory.test.mjs）
// 每次 `npm test` 重算比对 —— 产物变了而清单没跟上，就会红。
//
// 用法：node scripts/gen-capability-inventory.mjs
import fs from 'node:fs';
import path from 'node:path';
import { PLAYBOOKS } from '../tests/e2e/fixtures/playbooks.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 每个剧本的四层锚点：夹具页 / 剧本 / E2E / 技能。 */
export function buildInventory() {
  const server = read('tests/e2e/fixtures/server.mjs');
  const spec = read('tests/e2e/golden.spec.mjs');
  const skillDefs = read('lib/application/agent/skill-defs.ts');

  // 技能声明的 playbook 归属（`playbook: '<id>'`）
  const skillFor = {};
  for (const m of skillDefs.matchAll(/playbook:\s*'([a-z0-9-]+)'/g)) skillFor[m[1]] = true;
  // 技能的 name（用于展示；按 playbook 归属反查）
  const skillNames = new Map();
  for (const m of skillDefs.matchAll(/name:\s*'([a-z0-9-]+)'[\s\S]{0,6000}?playbook:\s*'([a-z0-9-]+)'/g)) {
    if (!skillNames.has(m[2])) skillNames.set(m[2], m[1]);
  }

  const rows = [];
  for (const pb of Object.values(PLAYBOOKS)) {
    const url = (pb.eval && pb.eval.url) || '';
    // 夹具路由：server.mjs 里必须有 startsWith('<url>') 的分支
    const routeWired = url ? server.includes("startsWith('" + url + "')") : false;
    // E2E：spec 里必须引用它的指令。合法形式**有三种**（与 e2e-hygiene 的
    // 「指令必须逐字一致」门禁保持一致）：
    //   ① 字面量原文；
    //   ② `PLAYBOOKS['<id>'].eval.instruction`（单一来源）；
    //   ③ `resolveInstruction('<id>')`（需要替换占位符时，如 {{UPLOAD_FILE}}）。
    // ⚠ 第一版我只认了 ①②，于是本清单算出「E2E 已引用 22/24」而门禁报错 ——
    // 是**我的检查不全**，不是那两条剧本缺 E2E。清单门禁当场把这件事抓了出来。
    const ins = (pb.eval && pb.eval.instruction) || '';
    const inSpec =
      (ins && spec.includes(ins)) ||
      spec.includes("PLAYBOOKS['" + pb.id + "'].eval.instruction") ||
      spec.includes('PLAYBOOKS["' + pb.id + '"].eval.instruction') ||
      spec.includes("resolveInstruction('" + pb.id + "')") ||
      spec.includes('resolveInstruction("' + pb.id + '")');
    const pageChecks = ((pb.eval && pb.eval.pageChecks) || []).length;
    const payload = ((pb.eval && pb.eval.mustSeeInToolResults) || []).length;
    const outcome = (pb.eval && pb.eval.outcome) || (pageChecks ? 'page' : '');
    rows.push({
      id: pb.id,
      trigger: pb.trigger || '',
      url,
      routeWired,
      tools: (pb.tools || []).length,
      skill: skillNames.get(pb.id) || (skillFor[pb.id] ? '（同名）' : ''),
      inSpec,
      pageChecks,
      payload,
      outcome,
    });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function renderInventory(rows) {
  const yes = (b) => (b ? '✓' : '✗');
  const lines = [
    '# 能力剧本清单（自动生成，请勿手改）',
    '',
    '由 `scripts/gen-capability-inventory.mjs` 从产物推导；`npm test` 里的',
    '`tests/capability-inventory.test.mjs` 每次重算比对 —— 产物变了而本文件没跟上就会红。',
    '',
    '三层形状 = **夹具页**（造出该类真正的难点）+ **剧本**（`tools` 作契约锚点）+',
    '**真浏览器 E2E**（断言页面状态 **AND** 模型实际收到了什么）+ **内置技能**。',
    '「结果所在」列说明该剧本的判据落在哪里：`page`（页面状态）/ `storage`（扩展存储，如知识库）——',
    '**空的页面判据必须显式声明理由**，否则门禁不放过。',
    '',
    '| 剧本 | 触发词 | 夹具页 | 工具 | 技能 | E2E | 页面判据 | 回执判据 | 结果所在 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    lines.push(
      '| `' + r.id + '` | ' + r.trigger + ' | `' + r.url + '` ' + yes(r.routeWired) +
        ' | ' + r.tools + ' | ' + (r.skill ? '`' + r.skill + '`' : '—') +
        ' | ' + yes(r.inSpec) + ' | ' + r.pageChecks + ' | ' + r.payload +
        ' | ' + r.outcome + ' |'
    );
  }
  const total = rows.length;
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  lines.push('');
  lines.push(
    '**合计**：' + total + ' 个剧本；页面判据 ' + sum('pageChecks') + ' 条、回执判据 ' + sum('payload') +
      ' 条；夹具路由已接线 ' + rows.filter((r) => r.routeWired).length + '/' + total +
      '；E2E 已引用 ' + rows.filter((r) => r.inSpec).length + '/' + total +
      '；有内置技能 ' + rows.filter((r) => r.skill).length + '/' + total + '。'
  );
  return lines.join('\n') + '\n';
}

const isMain = process.argv[1] && process.argv[1].endsWith('gen-capability-inventory.mjs');
if (isMain) {
  const out = path.join(ROOT, 'docs', 'capability-inventory.md');
  fs.writeFileSync(out, renderInventory(buildInventory()));
  console.log('已生成 ' + path.relative(ROOT, out));
}

// `docs/skills-overview.md` 的门禁：清单必须与产物一致，**孤儿技能**必须被显式列出。
//
// 为什么值得一道门禁（目标 ⑤ 的一部分）：
//   · 技能已涨到 36 个，与 27 个能力剧本的对应关系散落在源码里 —— 手写的清单必然腐烂 ✗
//   · 更要紧的是**孤儿技能**（有技能、没有剧本）：它们没有真浏览器验收，
//     属于"文案写了、没人验过"的部分。若清单里不单独列出来，它们会看起来像"已覆盖" ✗
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildSkillsOverview } from '../scripts/gen-skills-overview.mjs';

const DOC = 'docs/skills-overview.md';

test('清单必须与产物一致（改了技能或剧本就重跑生成脚本）', () => {
  const { text } = buildSkillsOverview();
  const onDisk = fs.readFileSync(DOC, 'utf8');
  assert.equal(
    onDisk,
    text,
    'docs/skills-overview.md 与产物不一致 —— 请运行 `node scripts/gen-skills-overview.mjs`'
  );
});

test('总览数字要能对上（技能数 / 有归属 / 孤儿 / 剧本数）', () => {
  const { text, skills, withPlaybook, orphans, playbookIds } = buildSkillsOverview();
  assert.ok(skills.length > 0, '应当扫到技能');
  assert.ok(text.includes('| 技能总数 | **' + skills.length + '** |'));
  assert.ok(text.includes('| 有剧本归属（真浏览器验收覆盖） | **' + withPlaybook.length + '** |'));
  assert.ok(text.includes('| **孤儿技能**（无验收覆盖） | **' + orphans.length + '** |'));
  assert.ok(text.includes('| 能力剧本总数 | **' + playbookIds.length + '** |'));
});

test('每个孤儿技能都必须在"孤儿"一节里点名（不许悄悄混进已覆盖那批）', () => {
  const { text, orphans } = buildSkillsOverview();
  assert.ok(orphans.length > 0, '当前确实存在孤儿技能；若哪天为 0，请同步本用例');
  const orphanSection = text.slice(text.indexOf('## ⚠ 孤儿技能'));
  for (const o of orphans) {
    assert.ok(orphanSection.includes('`' + o.name + '`'), '孤儿技能 ' + o.name + ' 必须在孤儿一节里出现');
  }
  // 反向：有归属的不该出现在孤儿一节
  const { withPlaybook } = buildSkillsOverview();
  for (const s of withPlaybook) {
    assert.ok(!orphanSection.includes('`' + s.name + '`'), '有剧本归属的技能 ' + s.name + ' 不该被列为孤儿');
  }
});

test('没有声明原因时显式显示"（未声明）"，而不是留空（留空等于默认它没问题）', () => {
  const { text, orphans } = buildSkillsOverview();
  const undeclared = orphans.filter((o) => !o.reason);
  if (undeclared.length) {
    assert.ok(text.includes('**（未声明）**'), '未声明原因的必须显眼地标出来');
  }
});

test('这条门禁本身有牙齿：文档被手改一个字就该被判为不一致', () => {
  const { text } = buildSkillsOverview();
  const tampered = text.replace('技能总数', '技能总数量');
  assert.notEqual(tampered, text, '篡改后与产物不同 —— 上面第一条断言就会红');
  const onDisk = fs.readFileSync(DOC, 'utf8');
  assert.equal(onDisk, text, '磁盘上的必须是生成结果，不是手改版');
});

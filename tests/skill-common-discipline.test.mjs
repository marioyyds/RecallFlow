// 「通用操作纪律」底座：**实测有害，已停用** —— 这道门禁钉住这个决定，防止有人不加测量又加回来。
//
// ## 背景
//
// 第 20 轮统计发现同一套纪律在 36 份技能文案里重复（`complete_task`×33、`get_page_snapshot`×31、
// `inspect_element`×28），于是第 23 轮把纪律抽成 `COMMON_OPERATING_DISCIPLINE`，
// 由 `load_skill` **每次加载技能时统一附加** —— 看起来是很自然的"消重"✗
//
// ## 实测结果（真模型 eval，同一场景/同一模型，付费墙那条）
//
// | 配置 | 通过 / 次数 | 通过率 |
// | --- | --- | --- |
// | **注入底座** | 3 / 7 | ≈43% ✗ |
// | **不注入** | 4 / 4（另加加底座之前的 1 次，共 5/5）| **100%** ✓ |
//
// ⇒ **每次 load_skill 追加约 600 字符的通用纪律，稀释了技能正文，造成真实退化** ✗
//
// ## 因此本门禁断言的是"**不要**注入"，而不是"要注入"
//
// 这条约束的方向与直觉相反，所以更要写死 + 写清原因：**没有测量就不要加提示** ✗
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { loadSkill, COMMON_OPERATING_DISCIPLINE } from '../lib/assistant/skill-tools.js';

const SRC = fs.readFileSync('lib/assistant/skill-tools.js', 'utf8');

const mkDeps = (skill) => ({
  getMergedSkills: async () => [skill],
  validateSkillTools: () => [],
});

test('**不得**把通用纪律底座拼进 load_skill 的返回里（实测造成退化）', async () => {
  const r = await loadSkill(mkDeps({ name: 'x', title: 't', description: 'd', content: '正文标记AAA' }), { name: 't' });
  const text = String(r.result);
  assert.ok(text.includes('正文标记AAA'), '技能正文必须在');
  assert.ok(!text.includes('通用操作纪律'), '底座**不该**出现（实测注入后通过率从 5/5 掉到 3/7）');
});

test('注入语句必须保持停用状态（哪怕只是被取消注释）', () => {
  const live = SRC.split('\n').filter((l) => !l.trim().startsWith('//'));
  assert.ok(
    !live.some((l) => l.includes('parts.push(COMMON_OPERATING_DISCIPLINE)')),
    '有人把注入放回来了 —— 请先按 docs/regression-red-flag.md 重新测量通过率'
  );
});

test('底座常量本身留着，并带上"为什么停用"的说明（免得下一个人重新发明）', () => {
  assert.ok(COMMON_OPERATING_DISCIPLINE.length > 200, '常量还在（内容本身是对的，问题在"每次注入"）');
  assert.match(SRC, /不要\*\*把通用纪律底座拼进技能返回里|实测它会造成退化/, '源码里要写明停用原因');
  assert.match(SRC, /3 \/ 7|3 次通过|≈43%/, '要带上实测数字，否则后人无从判断');
});

test('这条门禁本身有牙齿：把注入放回去就该红', () => {
  const guilty = (src) => {
    const live = src.split('\n').filter((l) => !l.trim().startsWith('//'));
    return live.some((l) => l.includes('parts.push(COMMON_OPERATING_DISCIPLINE)'));
  };
  assert.equal(guilty('  parts.push(COMMON_OPERATING_DISCIPLINE);'), true, '活的注入要被抓');
  assert.equal(guilty('  // parts.push(COMMON_OPERATING_DISCIPLINE);'), false, '注释掉的不算');
  assert.equal(guilty(SRC), false, '当前实现不该被抓');
});

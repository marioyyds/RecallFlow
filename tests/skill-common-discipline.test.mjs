// 「通用操作纪律」底座：所有技能共用一段，只在 load_skill 里定义一次。
//
// ## 为什么值得一道门禁
//
// 实测（`docs/skills-overview.md` 的"重复的通用纪律"）：`complete_task` 被 33 个技能声明、
// `get_page_snapshot` 31 个、`inspect_element` 28 个 —— 同一套纪律在 36 份文案里各写一遍 ✗
// 重复不会让它更可靠，只会更容易**漂移**（改一处忘另一处）。
//
// 抽成底座后，这里钉住三件事：
//   ① 底座**定义存在且是唯一来源**；
//   ② 每个技能加载时都会带上它（不是"某些技能才有"）；
//   ③ 底座必须包含那几条被反复重复的纪律（否则抽出来的东西没意义）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { loadSkill, COMMON_OPERATING_DISCIPLINE } from '../lib/assistant/skill-tools.js';

const mkDeps = (skill) => ({
  getMergedSkills: async () => [skill],
  validateSkillTools: () => [],
});

test('底座存在，且包含被反复重复的那几条纪律', () => {
  assert.ok(COMMON_OPERATING_DISCIPLINE.length > 200, '底座不能是空的摆设');
  assert.match(COMMON_OPERATING_DISCIPLINE, /get_page_snapshot/, '要包含"先看清再动手"');
  assert.match(COMMON_OPERATING_DISCIPLINE, /inspect_element|回读/, '要包含"改完回读确认"');
  assert.match(COMMON_OPERATING_DISCIPLINE, /complete_task/, '要包含"收尾如实汇报"');
  assert.match(COMMON_OPERATING_DISCIPLINE, /不要重试同一条调用|换策略/, '要包含"失败要换策略"');
  assert.match(COMMON_OPERATING_DISCIPLINE, /不确定/, '要包含"不确定就说不确定"');
});

test('**每个**技能加载时都会带上底座（不是部分技能才有）', async () => {
  for (const name of ['随便一个技能', '另一个']) {
    const r = await loadSkill(mkDeps({ name: 'x', title: name, description: 'd', content: '正文' }), { name });
    assert.ok(String(r.result).includes('通用操作纪律'), name + ' 没带上底座');
    assert.ok(String(r.result).includes('正文'), '技能正文也还要在');
  }
});

test('底座放在技能正文**之后**（末尾更被重视，也便于日后从正文里删掉重复段落）', async () => {
  const r = await loadSkill(mkDeps({ name: 'x', title: 't', description: 'd', content: '正文标记AAA' }), { name: 't' });
  const text = String(r.result);
  assert.ok(text.indexOf('正文标记AAA') < text.indexOf('通用操作纪律'), '底座应排在正文之后');
});

test('找不到技能时**不**塞底座（否则每条错误信息都变长，且与纪律无关）', async () => {
  const r = await loadSkill({ getMergedSkills: async () => [], validateSkillTools: () => [] }, { name: '不存在' });
  assert.equal(r.ok, false);
  assert.ok(!String(r.result).includes('通用操作纪律'), '失败信息里不该出现底座');
});

test('唯一来源：底座只在 skill-tools.js 里定义一次（别处不许再抄一份）', () => {
  const src = fs.readFileSync('lib/assistant/skill-tools.js', 'utf8');
  assert.equal(src.split('export const COMMON_OPERATING_DISCIPLINE').length - 1, 1, '只能定义一次');
  // 只数**标题行**（`## 通用操作纪律`）：文件顶部的说明注释里也会提到这个名字，那是文档不是第二份底本
  assert.equal(src.split('## 通用操作纪律').length - 1, 1, '底座正文只应出现一次');
});

test('这条门禁本身有牙齿：把底座从装配里去掉就该红', () => {
  const guilty = (s) => !s.includes('parts.push(COMMON_OPERATING_DISCIPLINE)');
  assert.equal(guilty('const parts = []; return { result: parts.join() };'), true, '没装配就要被抓');
  const real = fs.readFileSync('lib/assistant/skill-tools.js', 'utf8');
  assert.equal(guilty(real), false, '当前实现不该被抓');
});

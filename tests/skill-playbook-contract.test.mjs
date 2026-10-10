// **技能 ↔ 能力剧本**的契约门禁。
//
// ## 它解决什么
//
// 技能（lib/assistant/skill-defs.js）里写着 `x.tools`，意思是"教模型用这几个工具"。
// 能力剧本（tests/e2e/fixtures/playbooks.mjs）里的 `tools` 是"真正做到这件事**实际**需要哪几个"
// —— 而它由真浏览器 E2E 验证（golden.spec.mjs 的对应场景）。
//
// 两者一旦不一致，技能就在教模型用一套做不到这件事的工具。
// 后果不是报错，而是"模型照做了但没成功"：它会换参数乱试、或干脆告诉用户做不到。
//
// 这条门禁**不**假装 E2E 验证了技能文案对模型有没有用（那需要真模型 eval，见
// docs/e2e-testing-guide.md 的第三层），它只保证**技能承诺的工具集覆盖真正需要的能力**。
//
// ## 为什么这条值得存在
//
// 本轮就是靠它这类对照发现了一个真缺陷：`type_text` 的 schema 声明了
// role/name/testid/index/text 五个定位参数，而页面命令 `firstTarget` 只转发 ref/selector ——
// 于是"按说明填输入框"永远失败，报的还是「未找到可输入的目标元素」（听起来像页面没这个框）。
// 技能的 `x.tools` 单看没问题（名字都对、都存在），**只有把它和"实际能做成什么"对照才会暴露**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { SKILL_REGISTRY } from '../lib/assistant/skill-defs.js';
import { TOOL_REGISTRY } from '../lib/assistant/tools.js';
import { PLAYBOOKS, playbookTools } from './e2e/fixtures/playbooks.mjs';

const skillWithPlaybook = (id) => SKILL_REGISTRY.find((s) => s.x && s.x.playbook === id);

test('每个能力剧本都要有对应的技能，且技能声明的工具**覆盖**剧本实际用到的工具', () => {
  const toolNames = new Set(TOOL_REGISTRY.map((t) => t.name));
  const problems = [];

  for (const id of Object.keys(PLAYBOOKS)) {
    const skill = skillWithPlaybook(id);
    if (!skill) {
      problems.push('剧本 ' + id + ' 没有对应的技能（x.playbook = ' + id + '）');
      continue;
    }
    const declared = (skill.x && skill.x.tools) || [];
    for (const needed of playbookTools(id)) {
      if (!declared.includes(needed)) {
        problems.push('技能 ' + skill.name + ' 缺少剧本 ' + id + ' 需要的工具：' + needed);
      }
    }
    // 声明的工具必须真实存在（与 tools.js 的 validateSkillTools 同一判据，这里再钉一次，
    // 因为本测试是本仓库**唯一**把技能与"实际能力"对起来的地方）
    for (const d of declared) {
      if (!toolNames.has(d)) problems.push('技能 ' + skill.name + ' 声明的工具不存在：' + d);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n  '));
});

test('每个能力剧本本身必须自洽（有触发词、有工具、有成功判据）', () => {
  for (const [id, pb] of Object.entries(PLAYBOOKS)) {
    assert.equal(pb.id, id, '剧本的 id 字段应与键一致：' + id);
    assert.ok(pb.trigger && pb.trigger.length >= 2, id + ' 缺少触发词（E2E 靠它选剧本）');
    assert.ok(Array.isArray(pb.tools) && pb.tools.length, id + ' 必须声明用到的工具');
    assert.ok(pb.success && pb.success.length > 10, id + ' 必须写清成功判据（真模型 eval 要用）');
  }
});

test('触发词不得与其它剧本冲突（否则 E2E 会选错剧本）', () => {
  // 夹具按 userText.includes(trigger) 分派，顺序在前者优先 —— 触发词互相包含就会静默走错。
  const triggers = Object.values(PLAYBOOKS).map((p) => p.trigger);
  for (let i = 0; i < triggers.length; i++) {
    for (let j = 0; j < triggers.length; j++) {
      if (i === j) continue;
      assert.ok(
        !triggers[i].includes(triggers[j]),
        '触发词「' + triggers[i] + '」包含「' + triggers[j] + '」，剧本分派会有歧义'
      );
    }
  }
});

test('技能与剧本的关联方式被固定下来（改了这里就要同步文档）', () => {
  // 关联靠技能上的 x.playbook = 剧本 id。这条断言把这个约定写死，
  // 免得将来有人用别的字段（如 x.capability）另起一套，门禁就悄悄失效了。
  const withPlaybook = SKILL_REGISTRY.filter((s) => s.x && s.x.playbook);
  assert.ok(withPlaybook.length >= 1, '应至少有一个技能声明了 x.playbook');
  const ids = new Set(Object.keys(PLAYBOOKS));
  for (const s of withPlaybook) {
    assert.ok(ids.has(s.x.playbook), s.name + ' 的 x.playbook 指向了不存在的剧本：' + s.x.playbook);
  }
});

test('每个能力剧本的**自身指令必须含自己的触发词**（否则剧本永远不会被选中）', () => {
  // 实测踩到：`paginate-async` 的触发词是「翻页」，而它自己的 eval 指令写的是
  // 「分了好几页…帮我翻到…」—— **不含「翻页」**。于是夹具按触发词分派时选不中它，
  // 跑的是兜底剧本，表现成"agent 什么都没做、页码停在 1"，而错误信息完全指向别处。
  // 这条断言把"剧本自己都调不起来"变成静态红灯。
  const bad = Object.values(PLAYBOOKS).filter((p) => p.eval && !String(p.eval.instruction).includes(p.trigger));
  assert.deepEqual(
    bad.map((p) => p.id + '（触发词「' + p.trigger + '」不在指令里）'),
    []
  );
});

test('E2E 里用的指令必须与剧本声明的指令**逐字一致**（否则触发词分派会对不上）', () => {
  // 指令存在两处（剧本的 eval.instruction 与 golden.spec.mjs 的 sendInstruction 字面量），
  // 它们一旦漂移，就会出现"E2E 跑的是一套、eval 跑的是另一套"这种最难查的不一致。
  // 这里要求 spec 里**原样出现**剧本声明的指令。
  const spec = fs.readFileSync('tests/e2e/golden.spec.mjs', 'utf8');
  const missing = Object.values(PLAYBOOKS)
    .filter((p) => p.eval && p.eval.instruction)
    .filter((p) => !spec.includes(p.eval.instruction))
    .map((p) => p.id);
  assert.deepEqual(
    missing,
    [],
    '这些剧本的指令没有原样出现在 golden.spec.mjs 里（两处漂移会让 E2E 与 eval 跑的不是同一件事）：' + missing.join(', ')
  );
});

test('这条契约门禁本身有牙齿：缺一个工具必须被判定为不合格', () => {
  // 用内联样例验证判定逻辑，避免"永远通过"。
  const declared = ['get_page_snapshot', 'type_text', 'click_element'];
  const needed = playbookTools('site-search');
  const missing = needed.filter((t) => !declared.includes(t));
  assert.deepEqual(missing, ['inspect_element'], '缺 inspect_element 时应被发现，实际：' + JSON.stringify(missing));
});

test('技能文件里写的技法必须与剧本一致（防止技能教一套、E2E 验另一套）', () => {
  // 站内检索技能的内容里，四条步骤应对应剧本的四个工具。
  const skill = skillWithPlaybook('site-search');
  const content = String(skill.content || '');
  for (const t of ['get_page_snapshot', 'type_text', 'click_element', 'inspect_element']) {
    assert.ok(content.includes(t), '技能内容里应出现 `' + t + '`（与剧本步骤对应）');
  }
  // 本轮实测出来的三个坑必须写在技能里，否则下一个模型还会踩。
  assert.match(content, /异步渲染/, '必须提醒"结果列表是异步渲染的"');
  assert.match(content, /value.*是要输入|`value` 是要输入/, '必须说清 value 与 text 的语义区别');
  assert.match(content, /广告/, '必须说清广告条目与真实结果的分工');
  assert.match(fs.readFileSync('lib/assistant/skill-defs.js', 'utf8'), /不是先断言"页面上没有这个输入框"/,
    '必须提醒"定位失败先怀疑定位条件，而不是断言页面没有这个元素"（本轮真实踩到）');
});

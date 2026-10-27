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

import { SKILL_REGISTRY } from '../lib/assistant/skill-defs.ts';
import { TOOL_REGISTRY } from '../lib/assistant/tools.ts';
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
  // 这里要求 spec 里的指令**来自剧本**，三种形态任一即可：
  //   1. 原样字面量；
  //   2. `resolveInstruction('<id>')` —— 含运行时占位符（如上传文件的本地绝对路径）时**必须**用它；
  //   3. `PLAYBOOKS['<id>'].eval.instruction` —— 直接引用，漂移在结构上不可能。
  // 三种都保证"E2E 与 eval 跑的是同一条指令"，比只认字面量更强。
  const spec = fs.readFileSync('tests/e2e/golden.spec.mjs', 'utf8');
  const refs = (id, instruction) => [
    instruction,
    "resolveInstruction('" + id + "')",
    "PLAYBOOKS['" + id + "'].eval.instruction",
  ];
  const missing = Object.values(PLAYBOOKS)
    .filter((p) => p.eval && p.eval.instruction)
    .filter((p) => !refs(p.id, p.eval.instruction).some((s) => spec.includes(s)))
    .map((p) => p.id);
  assert.deepEqual(
    missing,
    [],
    '这些剧本的指令在 golden.spec.mjs 里找不到出处（字面量 / resolveInstruction / PLAYBOOKS 引用都没有）——' +
      '两处漂移会让 E2E 与 eval 跑的不是同一件事：' +
      missing.join(', ')
  );
});

// 「动作计数」的精确相等 = 路径断言。
//
// 这个坑本会话犯了**两次**：拖拽那轮把 `__dragEnds === 1` 误当结果判据（模型改了路线就被判失败），
// 排查那轮又是 `__clicks === 1`（真模型点了两次复现，结果完全成立却被判失败）。
// 所以把规则显式化：**动作计数器不许写精确相等**，除非能说清"这个次数本身就是结果"。
const EXACT_COUNT_ALLOWED = {
  'macro-save-replay: window.__runs === 2':
    '次数本身就是结果：放宽成 >= 2 就无法区分"回放生效"与"手动做了两次、根本没回放"',
};
// 只盯"动作计数"这一类的变量名；`__page`/`__renderedCount` 这类**状态**量不受限。
const ACTION_COUNTER = /__(clicks|submits|nextClicks|portalClicks|compSubmits|runs|dragEnds)\b[^,)]*===\s*(\d+)/;

test('剧本不许对「动作计数」写精确相等（那是路径断言，会把"路线不同"误判成"能力不行"）', () => {
  const offenders = [];
  for (const [id, pb] of Object.entries(PLAYBOOKS)) {
    for (const c of (pb.eval && pb.eval.pageChecks) || []) {
      const m = ACTION_COUNTER.exec(String(c.expr));
      if (!m) continue;
      // ⚠ `=== 0` 是**允许**的，而且是**有意义的**：它断言的是"这件事**没有**发生过"
      //（如"来源页没有被误提交"）。这与"恰好发生 N 次"完全不同 —— 后者才是路径约束。
      // 本门禁起初漏了这个豁免，结果把一条合法的"必须为 0"判成了违规。
      if (Number(m[2]) === 0) continue;
      const key = id + ': ' + c.expr;
      if (EXACT_COUNT_ALLOWED[key]) continue;
      offenders.push(key);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些判据对动作计数用了精确相等 —— 判据要盯**结果**（状态是否达成），' +
      '路径只要求"确实发生过"（`>= N`），或者"根本没发生"（`=== 0`）。' +
      '若这个次数本身就是结果，请加进 EXACT_COUNT_ALLOWED 并写明理由：\n  ' +
      offenders.join('\n  ')
  );
});

test('这条门禁本身有牙齿：`=== N（N≥1）` 要被认出，`=== 0` 与 `>= N` 不该被误伤', () => {
  const hit = (expr) => {
    const m = ACTION_COUNTER.exec(expr);
    return m && Number(m[2]) !== 0 ? 1 : 0;
  };
  assert.equal(hit('window.__clicks === 1'), 1, '恰好一次是路径断言');
  assert.equal(hit('window.__runs === 2'), 1, '恰好两次同理');
  assert.equal(hit('window.__submits === 0'), 0, '「没有发生过」是合法且有意义的结果判据');
  assert.equal(hit('window.__clicks >= 1'), 0, '>= 不是精确相等');
  assert.equal(hit('window.__page === 3'), 0, '页码是状态量，不受限');
});

test('这条门禁本身有牙齿：动作计数的精确相等必须被认出，状态量则不受影响', () => {
  const bad = { expr: 'window.__clicks === 1' };
  assert.ok(ACTION_COUNTER.test(bad.expr), '动作计数的精确相等应被认出');
  assert.ok(ACTION_COUNTER.test('window.__dragEnds === 1'), '拖拽计数同理');
  assert.ok(ACTION_COUNTER.test('window.__compSubmits === 1'), '组件内提交计数同理');
  // 状态量不该被误伤
  assert.ok(!ACTION_COUNTER.test('window.__page === 3'), '页码是状态，不是动作计数');
  assert.ok(!ACTION_COUNTER.test('window.__renderedCount === 5'), '渲染条数是状态');
  // 放宽后的写法不该被认作违规
  assert.ok(!ACTION_COUNTER.test('window.__clicks >= 1'), '>= 不是精确相等');
});

test('EXACT_COUNT_ALLOWED 里的每一条都必须真的出现在剧本里（防止清单腐化成死配置）', () => {
  const exprs = new Set();
  for (const [id, pb] of Object.entries(PLAYBOOKS)) {
    for (const c of (pb.eval && pb.eval.pageChecks) || []) exprs.add(id + ': ' + c.expr);
  }
  const dead = Object.keys(EXACT_COUNT_ALLOWED).filter((k) => !exprs.has(k));
  assert.deepEqual(dead, [], '允许清单里有已经不存在（或已改写）的条目，请删掉：' + dead.join(', '));
});

test('夹具分派：一条指令命中多个触发词时，必须先检查**更长**的那个（否则静默跑错剧本）', () => {
  // 分派是 `userText.includes(trigger)` 的**顺序**匹配。于是当某条指令同时含两个触发词时，
  // 谁在前谁赢 —— 而"谁在前"是源码里的书写顺序，与触发词长短无关，出了问题完全看不出来。
  // 本会话实例：新剧本的指令里既有「知识库」（旧剧本的触发词）又有「打开很慢」（自己的），
  // 若把新块写在旧块后面，就会静默跑成旧剧本。
  const src = fs.readFileSync('tests/e2e/fixtures/server.mjs', 'utf8');
  const order = new Map();
  for (const m of src.matchAll(/userText\.includes\(PLAYBOOKS\['([a-z0-9-]+)'\]\.trigger\)/g)) {
    if (!order.has(m[1])) order.set(m[1], m.index);
  }
  // ① 每个剧本都要有分派块（新剧本忘了接线 = 那条 E2E 永远跑不到）
  const unwired = Object.keys(PLAYBOOKS).filter((id) => !order.has(id));
  assert.deepEqual(unwired, [], '这些剧本没有在 server.mjs 里接线分派：' + unwired.join(', '));

  // ② 指令命中多个触发词时，更长（更具体）的必须先检查
  const problems = [];
  for (const [id, pb] of Object.entries(PLAYBOOKS)) {
    const ins = pb.eval && pb.eval.instruction;
    if (!ins) continue;
    const hits = Object.values(PLAYBOOKS).filter((p) => ins.includes(p.trigger));
    if (hits.length <= 1) continue;
    const longest = hits.slice().sort((a, b) => b.trigger.length - a.trigger.length)[0];
    const firstChecked = hits.slice().sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity))[0];
    if (firstChecked.id !== longest.id) {
      problems.push(
        id + ' 的指令同时命中 [' + hits.map((h) => h.trigger).join('、') + ']，但分派先检查「' + firstChecked.trigger + '」（更具体的是「' + longest.trigger + '」）'
      );
    }
  }
  assert.deepEqual(problems, [], '分派顺序会让这些指令跑错剧本：\n  ' + problems.join('\n  '));
});

test('这条契约门禁本身有牙齿：缺一个工具必须被判定为不合格', () => {
  // 用内联样例验证判定逻辑，避免"永远通过"。
  //
  // ⚠ 期望值**不要写死具体工具名**：剧本加一个工具（本轮就加了 `wait_for_element`）时，
  // 写死的期望会变成**假失败** —— 门禁本身"坏了"却看起来像是覆盖关系坏了。
  // 改成验证**判定逻辑的性质**：缺的能被发现、补齐后不再缺、齐全时不报缺。
  const declared = ['get_page_snapshot', 'type_text', 'click_element'];
  const needed = playbookTools('site-search');
  const missing = needed.filter((t) => !declared.includes(t));
  assert.ok(missing.length > 0, '这个样例必须真的缺东西，否则测不出"能发现缺失"');
  assert.ok(missing.includes('inspect_element'), '缺 inspect_element 时应被发现，实际：' + JSON.stringify(missing));

  // 补齐之后不该再报缺（证明判定真的在看覆盖关系）
  const completed = declared.concat(missing);
  assert.deepEqual(needed.filter((t) => !completed.includes(t)), [], '补齐后不该再有缺失');

  // 反向：声明本来就齐全时，一条都不该报
  assert.deepEqual(needed.filter((t) => !needed.includes(t)), [], '声明齐全时不应报缺');
});

test('技能文件里写的技法必须与剧本一致（防止技能教一套、E2E 验另一套）', () => {
  // 站内检索技能的内容里，四条步骤应对应剧本的四个工具。
  const skill = skillWithPlaybook('site-search');
  const content = String(skill.content || '');
  for (const t of ['get_page_snapshot', 'type_text', 'click_element', 'wait_for_element', 'inspect_element']) {
    assert.ok(content.includes(t), '技能内容里应出现 `' + t + '`（与剧本步骤对应）');
  }
  // 本轮实测出来的三个坑必须写在技能里，否则下一个模型还会踩。
  assert.match(content, /异步渲染/, '必须提醒"结果列表是异步渲染的"');
  assert.match(content, /value.*是要输入|`value` 是要输入/, '必须说清 value 与 text 的语义区别');
  assert.match(content, /广告/, '必须说清广告条目与真实结果的分工');
  assert.match(fs.readFileSync('lib/assistant/skill-defs.ts', 'utf8'), /不是先断言"页面上没有这个输入框"/,
    '必须提醒"定位失败先怀疑定位条件，而不是断言页面没有这个元素"（本轮真实踩到）');
});

test('付费墙技能的**口径**是「找合法免费可看的那一份」，不是「绕过付费 / 鉴权」', () => {
  // 用户原话：「这条技能我需要免费的，可以绕开 vip」；澄清后的口径是：
  // **只把技能名/描述改清楚** —— 它是「找免费内容」，不是「攻破付费墙」。
  // 能力不变，也不加任何"绕过鉴权"的做法。
  //
  // 这条门禁钉的是**文案口径**三件事：
  //   ① 合法免费的那一份有哪些（免费集 / 试看窗口 / 官方免费入口 / 限时免费）；
  //   ② 「能打开」不等于「能看」，必须**如实判定能不能看**；
  //   ③ 确实要付费时如实报告"拿不到内容"、**不假装看过**、**不绕过付费与鉴权**。
  // 它**不**声称测过"模型照做没有" —— 那只有真模型 eval 能回答（docs/real-model-eval-log.md）。
  //
  // 判定写成局部纯函数并顺手验一次**反向样张**：否则"文案里有没有这些词"很容易退化成恒真断言
  //（本仓库对"没牙齿的断言"有专门纪律，见 scripts/mutation-check.mjs 的开头）。
  const judge = (text) => {
    const t = String(text || '');
    const missing = [];
    const freeRoutes = ['免费集', '试看窗口', '官方', '限时免费'].filter((k) => !t.includes(k));
    if (freeRoutes.length) missing.push('没写清「合法免费的那一份」（缺：' + freeRoutes.join('、') + '）');
    const refusals = ['不解析播放地址', '不用盗播站', '不伪造会员身份', '不绕过'].filter((k) => !t.includes(k));
    if (refusals.length) missing.push('没写清「不绕过付费/鉴权」（缺：' + refusals.join('、') + '）');
    if (!t.includes('能打开')) missing.push('没点明「能打开」不等于「能看」');
    // ⚠ 用户口径（明确要求过）：这条技能**不是**"纠结要不要钱"，而是"用户要免费的 ⇒ **去找**" ✓
    if (!t.includes('去找')) missing.push('没写"去找"（用户要免费的 ⇒ 任务就是去找合法免费能看的来源）');
    if (!/如实/.test(t)) missing.push('没写"如实"报告');
    if (!t.includes('拿不到')) missing.push('没写"确实要付费就如实说拿不到内容"');
    if (!t.includes('假装看过')) missing.push('没写"不假装看过"');
    return { ok: missing.length === 0, missing };
  };

  const skill = skillWithPlaybook('paywall-preview-limit');
  assert.ok(skill, 'paywall-preview-limit 应有对应技能');
  // 模型可见的三处都算口径：目录里发出去的是 `name：description`，正文由 load_skill 取回。
  const surface = [skill.displayName, skill.description, String(skill.content || '')].join('\n');
  const r = judge(surface);
  assert.deepEqual(r.missing, [], '这条技能的口径没写清楚：\n  ' + r.missing.join('\n  '));

  // 反向样张 ①：写成"绕过"的样子必须被判不合格
  assert.ok(
    !judge('# 绕过 VIP\n1. 找解析脚本抓取付费内容\n2. 用盗播站看全集\n').ok,
    '"绕过付费/鉴权"的文案必须被判不合格'
  );
  // 反向样张 ②：把口径写回"能打开就算能看"的糊弄版也必须不合格
  assert.ok(!judge('打开页面就算能看了。').ok, '"能打开就算能看"的糊弄口径必须被判不合格');
});

// 技能文案的**结构性**门禁（目标 ⑤ 的"加牙齿"部分）。
//
// ## 为什么需要它
//
// 本仓库最贵的一课（`docs/real-model-eval-log.md` + `docs/skills-overview.md` 的说明段）：
// **散文式的关键步骤会被模型跳过**。`readability-fix` 最早就是一堆"要改字号/行高/对比度"的
// 自然段，真模型实测**只改了字号就收尾**，横向溢出原封不动 —— 直到把"改行宽"写成
// **编号第 4 步**并单列说明，它才被稳定执行。
// ⇒ "有没有编号步骤清单"不是文风问题，是**可执行性**问题，所以它值得一道门禁。
//
// ## 这道门禁管什么 / 不管什么
//
// 管：每个内置技能要么有**连续编号、从 1 开始**的步骤清单（≥2 项，缩进相同的一段），
//     要么**显式声明**"本技能无步骤：<原因>"（原因 ≥6 字）。两条都不满足 ⇒ 红。
// 不管：文案好不好用、模型会不会照做 —— 那是真模型 eval（`scripts/eval-real-model.mjs`）的事，
//     静态门禁假装验了它才是真正的"假装通过"✗
//
// ## 已有的门禁有没有覆盖它？（复用而非重复造）
//
// - `tests/skills-overview.test.mjs`：管**清单与产物一致** + 孤儿被点名，**不管**正文结构；
// - `tests/skill-playbook-contract.test.mjs`：管 `x.tools ⊇ 剧本 tools`，**不管**正文结构；
// - `tests/skill-common-discipline.test.mjs`：管"**不要**注入通用底座"，它是**反方向**的约束。
// ⇒ 正文结构这一条此前无人盯，故新增本文件（并与 `tests/skills-overview.test.mjs` 的
//   孤儿计算复用同一来源 `buildSkillsOverview()`，避免两处口径漂移）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { SKILL_REGISTRY, ORPHAN_SKILL_REASONS } from '../lib/assistant/skill-defs.js';
import { TOOL_REGISTRY } from '../lib/assistant/tools.js';
import { buildSkillsOverview, parseOrphanReasonEntries } from '../scripts/gen-skills-overview.mjs';
import fs from 'node:fs';

// ---------------- 判定逻辑（纯函数，便于"构造坏源码"验证牙齿） ----------------

/** 编号行：`  3. xxx` / `3、xxx` / `3) xxx`（编号后允许空格，但必须有内容，避免把 "1." 当步骤）。 */
const NUM_LINE = /^[ \t]*(\d+)[.、)][ \t]*\S/;
// 显式声明的标记：`本技能无步骤：<原因>`（原因至少 6 个字，避免用一句空话消掉门禁）。
//
// ⚠⚠ **这一行是本文件里唯一一处标记原文**，其余地方一律用 `MARKER` 常量拼出来。
// 原因是血泪：最初我把标记原文写进了断言消息与测试样例里，于是一扫到标记就认为
// "技能声明了无步骤" —— 门禁把自己的测试代码当成了被检查对象，好文案全被判红 ✗
// （两个坑叠在一起：`\s` 在 JS 里含换行，所以 `/…\s*[:：]\s*(\S[^\n]*)/` 能跨过 `\n\n`
//   一直吞到后面某个"原因"字符串上。）若把这些拼接还原成字面量，本门禁会立刻假红。
const MARKER = '本技能' + '无步骤';
// ⚠ 标记与冒号之后只允许**同行**内容（`[ \t]*` 而不是 `\s*`）：JS 的 `\s` 含换行，
// 用 `\s*` 会把下一行当成"原因"，于是 `标记：`＋换行＋随便一句都能冒充声明 ✗
const NO_STEP_DECL = new RegExp(MARKER + '[ \\t]*[:：][ \\t]*([^\\n]*)');
/** 一个够用的"无步骤"声明：标记 + 原因（≥6 字，且不能是空话）。 */
export function explicitNoStep(content) {
  const m = NO_STEP_DECL.exec(String(content || ''));
  if (!m) return '';
  return String(m[1]).trim();
}

/** 正文里是否有"连续编号、从 1 开始、缩进一致"的步骤清单（≥2 项）。 */
export function hasStepList(content) {
  const lines = String(content || '').split('\n');
  const runs = [];
  let cur = null;
  for (const l of lines) {
    const m = NUM_LINE.exec(l);
    if (!m) {
      // ⚠ 这里必须用 `[ \t]` 而**不是** `\s`：JS 的 `\s` 含换行，`/^\s+\S/` 对任意非空字符串
      // 的字面量（含换行）几乎恒为真 ⇒ 所有行都被当成"续行"跳过，清单恒判为不存在。
      // 本轮实测踩过：`1、…\n2、…` 被判成没有清单，而 `1. …` 反而通过（只差一个字符）。
      const isIndentedContinuation = /^[ \t]+\S/.test(l);
      // 空行与续行不打断清单；顶格的普通正文/标题才表示这段清单结束
      // （否则"1. / 一大段说明 / 2."会被连成假清单）。
      if (l.trim() === '' || isIndentedContinuation) continue;
      if (cur) runs.push(cur);
      cur = null;
      continue;
    }
    const indent = m[1].length;
    // ⚠ 取的是 `m[1]`：本正则**只有编号这一个捕获组**（缩进用 `[ \t]*` 不吃成组）。
    // 最初写成了 `m[2]` ⇒ 每项都是 `NaN` ⇒ 清单恒判为不存在（NaN 与任何数都不相等），
    // 而且症状是"所有技能都散文式"，看起来像文案问题而不是门禁自己的 bug ✗
    const n = Number(m[1]);
    if (cur && cur.indent === indent) cur.items.push(n);
    else {
      if (cur) runs.push(cur);
      cur = { indent, items: [n] };
    }
  }
  if (cur) runs.push(cur);
  // 一段合格清单：从 1 开始、逐项 +1、至少 2 项
  return runs.some((r) => r.items.length >= 2 && r.items.every((n, i) => n === i + 1));
}

/** 技能的步骤清单判定：返回 { ok, how }。 */
export function checkStepDiscipline(content) {
  const reason = explicitNoStep(content);
  if (reason.length >= 6) return { ok: true, how: 'declared' };
  if (hasStepList(content)) return { ok: true, how: 'list' };
  return { ok: false, how: 'none' };
}

/** 孤儿理由判定：必须有声明、理由够长、且不是空话。 */
const BANNED_REASONS = ['待补', '暂无', '以后再说', '未声明', 'todo', 'TBD'];
export function checkOrphanReason(reason) {
  const r = String(reason || '').trim();
  if (!r) return { ok: false, why: '没有声明理由' };
  if (r.length < 30) return { ok: false, why: '理由太短（' + r.length + ' < 30 字）：' + r };
  const hit = BANNED_REASONS.find((b) => r.toLowerCase().includes(b.toLowerCase()));
  if (hit) return { ok: false, why: '理由里出现空话「' + hit + '」：' + r };
  return { ok: true, why: '' };
}

// ---------------- 门禁 ①：每个技能都要有编号步骤清单或"无步骤"声明 ----------------

test('每个内置技能的正文都要有编号步骤清单，或显式声明"本技能无步骤：<原因>"', () => {
  const problems = [];
  for (const s of SKILL_REGISTRY) {
    if (checkStepDiscipline(s.content).ok) continue;
    problems.push(
      s.name + '（' + String(s.content || '').length + ' 字符）：既没有 ≥2 项的连续编号步骤清单，' +
        '也没有声明「' + MARKER + '：<原因>」'
    );
  }
  assert.deepEqual(
    problems,
    [],
    '这些技能的正文是散文式的 —— 实测表明关键步骤会被模型跳过（readability-fix 漏掉"改行宽"）。' +
      '要么写成编号步骤清单，要么显式声明无步骤并写明原因：\n  ' + problems.join('\n  ')
  );
});

test('没有"无步骤"声明的技能，必须真的数得出步骤（声明与正文不许两张皮）', () => {
  // 反向：声明了"无步骤"的技能，正文里不该再出现编号步骤清单 —— 否则声明是假的。
  const liars = SKILL_REGISTRY.filter((s) => explicitNoStep(s.content).length >= 6 && hasStepList(s.content))
    .map((s) => s.name);
  assert.deepEqual(liars, [], '这些技能声明"无步骤"，正文里却有编号步骤清单：' + liars.join(', '));
});

test('这条门禁本身有牙齿：散文式、编号跳号、只有一步、空话声明都必须判不合格', () => {
  const prose = '# 某技能\n\n先看页面，然后改样式，最后汇报。\n再看一眼确认一下就好了。';
  assert.equal(checkStepDiscipline(prose).ok, false, '纯散文必须被判不合格');

  const bulletsOnly = '# 某技能\n\n- 先看页面\n- 再改样式\n- 最后汇报';
  assert.equal(checkStepDiscipline(bulletsOnly).ok, false, '只有项目符号不算步骤清单');

  const gap = '# 某技能\n\n1. 第一步\n2. 第二步\n4. 第四步（跳过了 3）\n';
  assert.equal(checkStepDiscipline(gap).ok, false, '编号跳号（缺 3）必须被判不合格');

  const single = '# 某技能\n\n1. 只有一步\n';
  assert.equal(checkStepDiscipline(single).ok, false, '只有一步不算清单（≥2 项）');

  const startsAtTwo = '# 某技能\n\n2. 从二开始\n3. 第三步\n';
  assert.equal(checkStepDiscipline(startsAtTwo).ok, false, '必须从 1 开始');

  const emptyDecl = '# 某技能\n\n' + MARKER + '：待补\n先看页面，然后改样式。\n';
  assert.equal(checkStepDiscipline(emptyDecl).ok, false, '空话声明（原因 <6 字）不算声明');

  // 正面：真有清单 / 真有声明，都必须过（免得门禁把好文案也判红）
  assert.equal(checkStepDiscipline('# 某技能\n\n1. 拿快照\n2. 改样式\n3. 回读确认\n').ok, true);
  assert.equal(checkStepDiscipline('# 某技能\n\n' + MARKER + '：这是纯文本改写，没有页面状态。\n').ok, true);
  assert.equal(checkStepDiscipline('# 某技能\n\n1、顿号也认\n2、第二步\n').ok, true, '顿号（后跟空格）要认');
  assert.equal(checkStepDiscipline('# 某技能\n\n1) 圆括号也认\n2) 第二步\n').ok, true, '圆括号要认');
  // 换行必须换出结果：声明与"原因"分处两行不算声明（这正是 `\s` 含换行会误判的形状）。
  assert.equal(checkStepDiscipline('# 某技能\n\n' + MARKER + '：\n这只是没有原因的四个字\n').ok, false);
});

// ---------------- 门禁 ②：孤儿技能必须显式声明"够用"的理由 ----------------

test('每个孤儿技能都必须在 ORPHAN_SKILL_REASONS 里显式声明理由，且理由不能是空话', () => {
  const { orphans } = buildSkillsOverview();
  assert.ok(orphans.length > 0, '当前确实存在孤儿技能；若哪天为 0，请同步本用例');
  const problems = [];
  for (const o of orphans) {
    const r = checkOrphanReason(ORPHAN_SKILL_REASONS[o.name]);
    if (!r.ok) problems.push(o.name + '：' + r.why);
  }
  assert.deepEqual(
    problems,
    [],
    '孤儿技能（有技能、没有剧本 ⇒ 没有夹具页与真浏览器判据）必须给出**够用**的理由。' +
      '注意：孤儿状态是**如实**的，不许为了消掉它而硬说"有剧本"：\n  ' + problems.join('\n  ')
  );
});

test('理由表不许腐化：表里不能有已经不是孤儿的条目（防止"只增不减"）', () => {
  const { orphans } = buildSkillsOverview();
  const names = new Set(orphans.map((o) => o.name));
  const stale = Object.keys(ORPHAN_SKILL_REASONS).filter((n) => !names.has(n));
  assert.deepEqual(
    stale,
    [],
    '这些技能已经有剧本归属（或已被删除），应当从 ORPHAN_SKILL_REASONS 里删掉：' + stale.join(', ')
  );
});

test('这条门禁本身有牙齿：去掉理由、写空话、写太短，都必须判不合格', () => {
  // 情形 1：整个条目被删掉（模拟"忘了声明"）
  assert.equal(checkOrphanReason(undefined).ok, false, '缺理由必须被判不合格');
  // 情形 2：留个占位符（最典型的"假装声明了"）
  assert.equal(checkOrphanReason('待补').ok, false, '空话必须被判不合格');
  // 情形 3：凑字数但没信息
  assert.equal(checkOrphanReason('暂时没有剧本，以后再说吧。').ok, false, '太短必须被判不合格');
  assert.equal(checkOrphanReason('TBD').ok, false, '英文占位符同样不合格');
  // 正面：现在这份真实理由必须过
  assert.equal(checkOrphanReason(ORPHAN_SKILL_REASONS['remove-ads']).ok, true, '现有理由必须仍然合格');
  assert.equal(checkOrphanReason(ORPHAN_SKILL_REASONS['userscript-task']).ok, true, '现有理由必须仍然合格');
});

// ---------------- 门禁 ③：技能声明的依赖工具必须真实存在 ----------------
//
// 抓到过一处真实缺陷（目标 ⑤ 顺手修的）：`clip-to-knowledge` 的 `x.tools` 里写着
// `search_knowledge_base` / `get_entry` —— 它们在"知识库只读三件套合并"（C-4）之后
// **已经不存在**（合并成 `knowledge_read({op})`）。后果不是报错，而是模型加载该技能时
// 收到一句「该技能声明的依赖工具存在问题，Agent 无法调用，请到技能页更新依赖工具列表」，
// 然后**放弃本来正确的做法**。真模型实测里这条技能恰好会被知识库那两条剧本加载 ⇒ 影响真实。
//
// ⚠ 与 `tests/skill-playbook-contract.test.mjs` 的分工：那条只核对**有剧本**的技能
// （`x.playbook` 存在者）且方向是 "tools ⊇ 剧本 tools"；**孤儿技能完全不在它的扫查范围内**。
// 本用例覆盖全部内置技能，且方向是"声明的每个工具都真的存在"。
test('每个内置技能声明的工具都必须真实存在（含没有剧本的孤儿技能）', () => {
  const existing = new Set(TOOL_REGISTRY.map((t) => t.name));
  const problems = [];
  for (const s of SKILL_REGISTRY) {
    const declared = (s.x && Array.isArray(s.x.tools) && s.x.tools) || [];
    for (const t of declared) {
      if (!existing.has(t)) problems.push(s.name + ' 声明了不存在的工具：' + t);
    }
  }
  assert.deepEqual(
    problems,
    [],
    '技能会教模型去调用这些工具，而它们不在注册表里 —— 模型只会拿到一句"依赖工具存在问题"：\n  ' +
      problems.join('\n  ')
  );
});

// ---------------- 门禁 ④：生成物里的理由文本不许混进源码碎片 ----------------
//
// 抓到的第二处真实缺陷（本轮）：生成脚本原来是单行正则 `'key': '...',\n`，
// 而中文长理由在源码里是**跨行拼接**（`'第一段' +` / `'第二段'`）。于是生成出来的清单里
// 直接印着 `' + '` 这种源码碎片 —— **门禁比对的是"生成物 vs 生成物"，发现不了它** ✗
// （比对逻辑没错：两边的垃圾是一样的。）所以必须**直接断言理由文本里没有源码碎片**。
test('生成物里的孤儿理由不得混进源码拼接碎片（`+` / 未闭合引号）', () => {
  const src = fs.readFileSync(new URL('../lib/assistant/skill-defs.js', import.meta.url), 'utf8');
  const parsed = parseOrphanReasonEntries(src);
  const problems = [];
  for (const e of parsed) {
    if (!e.reason) problems.push(e.name + '：解析出空理由');
    if (/' \+ '|\\n'|^'|'$/.test(e.reason)) problems.push(e.name + '：理由里有源码碎片：' + e.reason.slice(0, 60));
  }
  assert.equal(parsed.length, Object.keys(ORPHAN_SKILL_REASONS).length, '解析条数必须等于理由表条数');
  assert.deepEqual(problems, [], '生成脚本没能把"跨行拼接的字符串"拼起来：\n  ' + problems.join('\n  '));
  // 且生成物里也不能出现碎片（端到端再钉一次）
  const { text } = buildSkillsOverview();
  assert.ok(!text.includes("' + '"), 'docs/skills-overview.md 的孤儿一节里出现了源码拼接碎片');
});

test('这条门禁本身有牙齿：跨行拼接必须被拼成一个句子，碎片化的源码必须被抓到', () => {
  const fake = [
    'export const ORPHAN_SKILL_REASONS = Object.freeze({',
    "  'a-skill':",
    "    '第一段理由，讲清楚为什么没有剧本，够长够具体。' +",
    "    '第二段补充，说明缺口的现状。',",
    "  'b-skill': '这也很长的一段理由，足够过长度下限了，但它有问题：' + '这里拼接了。',",
    '});',
  ].join('\n');
  const parsed = parseOrphanReasonEntries(fake);
  assert.equal(parsed.length, 2, '两个条目都要被解析出来');
  assert.equal(
    parsed[0].reason,
    '第一段理由，讲清楚为什么没有剧本，够长够具体。第二段补充，说明缺口的现状。',
    '跨行拼接必须拼成一句（旧实现会留下 "\' + \'"）'
  );
  assert.equal(parsed[1].reason, '这也很长的一段理由，足够过长度下限了，但它有问题：这里拼接了。');
  // 少了表尾也必须能解析（不能因为截断就静默返回空）
  assert.equal(parseOrphanReasonEntries('export const ORPHAN_SKILL_REASONS = Object.freeze({').length, 0);
  assert.deepEqual(parseOrphanReasonEntries('没有任何理由表'), []);
});

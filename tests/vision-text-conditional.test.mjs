// 视觉开关的**文案条件化**验收（docs/remaining-work.md「二、① 多模态」第 5 步）。
//
// ## 这组断言在证什么
//
// 第 5 步只做一件事：把既有的那句"你看不到图像"**原样包起来**
//（`VISION_ENABLED ? '' : 原文`）。因此 `VISION_ENABLED = false` 时，产出必须与改动前
// **逐字节相同** ⇒ 属于**纯重构**，按 docs/regression-red-flag.md 的纪律**不需要**跑真模型 eval ✓
//
// 反过来说：一旦有人顺手改了措辞（哪怕只少一个换行），这里就必须红 ——
// 因为那时它已经不再是纯重构，而是"改了模型能看到的内容"，得补对照测量 ✗
// 所以下面把**改动前的原文**直接当基准写进用例（取自 git HEAD，逐字节核对过）。
//
// ## 为什么还要"源码级门禁"
//
// 行为断言管不住"只改一处、漏改另一处"：漏掉的那处在开关打开后会说反话
//（"你看不到图" + 一张真图就在上下文里）✗ 所以三处都必须**引用**开关，不许各自硬编码。
//
// ## 已知遗留（留给第 6 步，本文件**刻意不钉**）
//
// 开关**打开**时，`formatScreenshotSummary` 会拼出「…不进入你的上下文：，不要据它描述页面外观。」
// —— 冒号后直接跟逗号，读起来别扭。这属于"开启侧的新文案"，第 6 步打开开关时本来就要
// 按 regression-red-flag 做对照测量，届时一并定稿；现在钉死反而会拦住那次改动。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { VISION_ENABLED, VISION_CLAUSE, visionLimitationNote, formatScreenshotSummary } from '../lib/shared/utils.js';
import { TOOL_SCHEMAS } from '../lib/assistant/tool-schemas.js';
import { SKILL_REGISTRY } from '../lib/assistant/skill-defs.js';

const read = (p) => fs.readFileSync(p, 'utf8');
const screenshotDesc = () => TOOL_SCHEMAS.find((t) => t.function.name === 'take_screenshot').function.description;
const readabilityFix = () => SKILL_REGISTRY.find((s) => s.name === 'readability-fix').content;
const META = { width: 1280, height: 720, format: 'jpeg', quality: 72, bytes: 145408 };

// ---------------- 改动前的原文（git HEAD，逐字节） ----------------
// ① take_screenshot 的工具说明（整条，188 字符）
const BASELINE_TOOL_DESC =
  '给当前页面截图（只读，需 CDP）。图片**只展示给用户与留档**，不进入你的上下文 —— 当前模型是纯文本的，**你看不到图像内容**，不要据「已截图」描述页面外观或声称视觉上已修好。它的价值是给用户可视证据（如「修改前/后」各拍一张）。需要可判断的文本证据请用 get_page_snapshot / inspect_element / read_diagnostics。';
// ② readability-fix 技能正文里那一段（含**结尾的空行** —— 那正是最容易丢的字节）
const BASELINE_SKILL_FRAGMENT =
  '- 需要给用户可视证据时用 `take_screenshot`，但**你看不到图像内容**，\n  不要据"已截图"声称视觉上已经改好。\n\n## 绝不允许的"达标"方式\n';
// ③ 截图结果摘要（整条，220 字符）
const BASELINE_SCREENSHOT_SUMMARY =
  '已截图 1280×720 CSS px（JPEG q72，142KB）\n图片只展示给用户、不进入你的上下文：**你看不到图像内容**，不要据它描述页面外观。若需要可判断的文本证据，请用 get_page_snapshot / read_diagnostics / inspect_element。\n**截图不能作为 complete_task 的 evidence**：完成前校验只读文本证据。截图是给用户留档的，不要为了「取证」反复截图。';
// ④ visionLimitationNote 的默认整句（这一处在改动前就已经是条件化的，见用例 ④）
const BASELINE_NOTE_SENTENCE =
  '注意：当前**看不到图像**（截图只给用户看，不会进入你的输入），请依据 DOM / 可访问性树等文本信息判断。';

test('前提：开关当前是**关闭**的（下面所有"逐字节相同"的断言都以此为前提）', () => {
  assert.equal(VISION_ENABLED, false, '打开它属于第 6 步：必须同时做完传输/文案/预算/门禁并跑 eval');
});

test('① take_screenshot 工具说明：关闭时与改动前逐字节相同', () => {
  assert.equal(screenshotDesc(), BASELINE_TOOL_DESC);
});

test('② readability-fix 技能正文：关闭时与改动前逐字节相同（含段落空行）', () => {
  const content = readabilityFix();
  assert.ok(content.includes(BASELINE_SKILL_FRAGMENT), '技能正文里那一段必须仍是原文（含结尾的 \\n\\n）');
  assert.ok(
    !content.includes('已经改好。\n## 绝不允许'),
    '少一个换行也是"改了模型能看到的内容" ✗（本次改动中真实发生过一次）'
  );
});

test('③ formatScreenshotSummary：关闭时与改动前逐字节相同，且禁用语不重复拼接', () => {
  const summary = formatScreenshotSummary(META);
  assert.equal(summary, BASELINE_SCREENSHOT_SUMMARY);
  assert.equal(
    (summary.match(/你看不到图像内容/g) || []).length,
    1,
    '重复拼接会让模型连着读到两遍同一句 ✗（本次改动中真实发生过一次）'
  );
  // 另一条 meta 只钉住那句的关键标点（整条基准见 ③ 的 META）
  assert.ok(formatScreenshotSummary(null).includes('：**你看不到图像内容**，不要据它描述页面外观。'));
});

test('④ visionLimitationNote 的默认整句：改动前**就已经**是条件化的 ⇒ 这里只钉现状', () => {
  // 依据：HEAD 版里它已经是 `if (enabled) return ''`（见 git show HEAD:lib/shared/utils.js）——
  // 本次第 5 步没有、也不需要改它的**行为**，只把它的文案抽成了 `VISION_CLAUSE` 一处。
  // 钉住原文与两档开关，防止有人顺手把整句也重写一遍（那就不再是纯重构）。
  assert.equal(visionLimitationNote(false), BASELINE_NOTE_SENTENCE);
  assert.equal(visionLimitationNote(true), '');
  assert.equal(VISION_CLAUSE, '**看不到图像**（截图只给用户看，不会进入你的输入）');
});

test('⑤ 不算一处：panel-css.js 里那句是样式表**注释**，不面向模型 ⇒ 刻意不条件化', () => {
  // 它与模型输入无关（只决定面板怎么显示截图），所以没有引用开关的义务；
  // 但若哪天它变成会发给模型的文本，这个用例会红，逼人重新评估 ✓
  const css = read('lib/page/panel-css.js');
  const line = css.split('\n').find((l) => l.includes('模型看不到图'));
  assert.ok(line, '锚点失效（这句被删或被改写）：请同步本用例');
  assert.match(line.trim(), /^\/\*.*\*\/$/, '它必须仍然只是一条 CSS 注释');
});

// ---------------- 源码级门禁 ----------------
// 三处接线点：必须在**自己那段代码里**引用开关 —— "import 了但没用"不算。
const SITES = [
  {
    name: 'take_screenshot 工具说明',
    file: 'lib/assistant/tool-schemas.js',
    from: "name: 'take_screenshot'",
    to: 'parameters:',
  },
  {
    name: 'readability-fix 技能正文',
    file: 'lib/assistant/skill-defs.js',
    from: '- 需要给用户可视证据时用',
    to: '## 绝不允许的',
  },
  {
    name: 'formatScreenshotSummary',
    file: 'lib/shared/utils.js',
    from: 'export function formatScreenshotSummary',
    to: '\n}',
  },
];

/** 取出一段代码（锚点找不到时返回 null，避免门禁静默退化成"永远通过"✗）。 */
function regionOf(source, from, to) {
  const a = source.indexOf(from);
  if (a < 0) return null;
  const b = source.indexOf(to, a + from.length);
  if (b < 0) return null;
  return source.slice(a, b);
}

/** 门禁的判据本身：这段代码是否**真的经由开关**决定文案。抽成函数才测得出它有没有牙齿。 */
function isSwitchDriven(region) {
  return /VISION_ENABLED|visionEnabled/.test(region);
}

test('源码级门禁：三处都必须引用 VISION_ENABLED，不许各自硬编码', () => {
  for (const site of SITES) {
    const region = regionOf(read(site.file), site.from, site.to);
    assert.ok(region, '锚点失效（' + site.file + '）：请同步更新本用例的 from/to');
    assert.ok(isSwitchDriven(region), site.name + ' 没有引用开关 ⇒ 开关打开后它仍会说"看不到图" ✗');
  }
});

test('这条门禁**有牙齿**：硬编码同一句文案的假源码必须被判为不合格', () => {
  const guilty = [
    "name: 'take_screenshot', description: '图片**只展示给用户与留档**，不进入你的上下文 —— 当前模型是纯文本的，**你看不到图像内容**，不要据「已截图」描述页面外观。', parameters: {",
    '- 需要给用户可视证据时用 `take_screenshot`，但**你看不到图像内容**，\n  不要据"已截图"声称视觉上已经改好。\n\n## 绝不允许的',
    "export function formatScreenshotSummary(meta) { return '图片只展示给用户、不进入你的上下文：**你看不到图像内容**，不要据它描述页面外观。'; }",
  ];
  for (const src of guilty) {
    assert.ok(src.includes('你看不到图像内容'), '夹具前提：它确实写着那句禁用文案');
    assert.equal(isSwitchDriven(src), false, '硬编码版必须被判为不合格');
  }
  // 反向：真源码必须判合格（否则门禁恒假，等于没有）
  for (const site of SITES) {
    assert.ok(isSwitchDriven(regionOf(read(site.file), site.from, site.to)), site.name + ' 应当判为合格');
  }
});

test('单一来源：禁用文案只在 utils.js 定义一份，工具 / 技能只 import（不许再抄一份）', () => {
  const utils = read('lib/shared/utils.js');
  assert.equal(utils.split('export const VISION_UNAVAILABLE_TOOL_COPY').length - 1, 1, '工具文案只能定义一次');
  assert.equal(utils.split('export const VISION_UNAVAILABLE_SKILL_COPY').length - 1, 1, '技能文案只能定义一次');

  const importRe = (sym) => new RegExp("import\\s*\\{[^}]*" + sym + "[^}]*\\}\\s*from\\s*'\\.\\./shared/utils\\.js'");
  assert.match(read('lib/assistant/tool-schemas.js'), importRe('VISION_UNAVAILABLE_TOOL_COPY'));
  assert.match(read('lib/assistant/skill-defs.js'), importRe('VISION_UNAVAILABLE_SKILL_COPY'));

  // 有牙齿：自带字面量的假源码不该被这条判为合格
  const guilty = "const VISION_UNAVAILABLE_TOOL_COPY = '不进入你的上下文 —— 当前模型是纯文本的…';";
  assert.doesNotMatch(guilty, importRe('VISION_UNAVAILABLE_TOOL_COPY'));
});

// ---------------- 开启侧：那句必须真的消失 ----------------
/**
 * 把源码里的开关**真的改成 true** 再载入 —— 用来验证"开启后那句确实消失"。
 *
 * 为什么要这么麻烦：`VISION_ENABLED` 是模块级 const，import 进来就固定了 ⇒ 直接 import
 * 只看得到关闭态，开启侧断言会退化成"其实还是关闭"而**静默通过** ✗
 * data: URL 让 Node 把改写后的源码当模块执行，且不落盘 ✓ 锚点失效时抛错，不静默。
 */
async function loadWithVisionOn(file) {
  const patched = read('lib/shared/utils.js')
    .replace('export const VISION_ENABLED = false;', 'export const VISION_ENABLED = true;')
    .replace("from './constants.js'", "from '" + pathToFileURL(path.resolve('lib/shared/constants.js')).href + "'");
  assert.ok(patched.includes('export const VISION_ENABLED = true;'), '改写锚点失效（开关定义变了？）');
  const utilsUrl = 'data:text/javascript;base64,' + Buffer.from(patched, 'utf8').toString('base64');
  if (file === 'lib/shared/utils.js') return import(utilsUrl);
  const src = read(file);
  const rewritten = src.replace("from '../shared/utils.js'", "from '" + utilsUrl + "'");
  assert.notEqual(rewritten, src, '改写锚点失效：' + file + ' 不再从 ../shared/utils.js 取开关');
  return import('data:text/javascript;base64,' + Buffer.from(rewritten, 'utf8').toString('base64'));
}

test('开关打开后：三处都不再说"看不到图像"，且技能段落的空行仍在', async () => {
  const onUtils = await loadWithVisionOn('lib/shared/utils.js');
  const onSchemas = await loadWithVisionOn('lib/assistant/tool-schemas.js');
  const onSkills = await loadWithVisionOn('lib/assistant/skill-defs.js');

  const desc = onSchemas.TOOL_SCHEMAS.find((t) => t.function.name === 'take_screenshot').function.description;
  const skill = onSkills.SKILL_REGISTRY.find((s) => s.name === 'readability-fix').content;
  const summary = onUtils.formatScreenshotSummary(META);

  assert.ok(!desc.includes('看不到图像'), '开启后工具说明不得再说"看不到图像"');
  assert.ok(!desc.includes('当前模型是纯文本的'), '开启后不得再说"当前模型是纯文本的"');
  assert.ok(!skill.includes('看不到图像内容'), '开启后技能不得再说"看不到图像内容"');
  assert.ok(!summary.includes('看不到图像'), '开启后截图摘要不得再说"看不到图像"');
  // 关闭侧的原文在开启侧必须**不出现**（否则等于开关没接上）
  assert.ok(!desc.includes(BASELINE_TOOL_DESC), '开启后旧说明整条都该走了');
  assert.ok(!skill.includes(BASELINE_SKILL_FRAGMENT), '开启后旧技能文案整段都该走了');
  // 空行是两档共用的排版，别只在一档里对
  assert.ok(skill.includes('截图也会进入你的上下文。\n\n## 绝不允许的'), '开启侧也要保持段落空行');
});

// 视觉开关的**文案条件化**验收（docs/remaining-work.md「二、① 多模态」第 5、6 步）。
//
// ## 这组断言在证什么
//
// 做法是把既有的那句"你看不到图像"**原样包起来**（`VISION_ENABLED ? 启用分支 : 原文`）。
// 因此**关闭臂**的产出必须与改动前**逐字节相同** ⇒ 关闭侧属于**纯重构**，
// 按 docs/regression-red-flag.md 的纪律不需要测量 ✓（开启侧是模型可见内容的变化 ⇒ 必须测量）
//
// 反过来说：一旦有人顺手改了措辞（哪怕只少一个换行），这里就必须红 ——
// 所以下面把**改动前的原文**直接当基准写进用例（取自 git HEAD，逐字节核对过）。
//
// ## 关闭臂怎么拿到（第 6 步之后：常量已经是 true）
//
// 直接 import 只能看到**开启侧**（模块级 const 固定了）⇒ 关闭臂必须靠 data: URL
// **把源码里的开关真的改成 false 再载入**（`loadWithVision(false, file)`），不落盘 ✓
// 两臂因此都被钉住：关闭臂钉"逐字节原文"，开启臂钉"不再有反话、且如实" ✓
//
// ## 为什么还要"源码级门禁"
//
// 行为断言管不住"只改一处、漏改另一处"：漏掉的那处在开关打开后会说反话
//（"你看不到图" + 一张真图就在上下文里）✗ 所以四处都必须**引用**开关，不许各自硬编码。
// ⚠ 第 6 步正是靠这条扫描 + 两臂渲染比对找出**第四处**的：
//   `context.js` 的 `flattenHistoryContent`（历史回放占位说明）——
//   它属于"开关翻转**不会**改到、但打开后会变成假话"的那一类，
//   只有把两臂**渲染出来逐条比对**才看得见（见本轮报告里的审计脚本输出）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  VISION_ENABLED,
  VISION_CLAUSE,
  visionLimitationNote,
  formatScreenshotSummary,
  VISION_ENABLED_TOOL_COPY,
  VISION_ENABLED_SKILL_COPY,
  VISION_ENABLED_SUMMARY_COPY,
} from '../lib/shared/utils.ts';
import { TOOL_SCHEMAS } from '../lib/assistant/tool-schemas.ts';
import { SKILL_REGISTRY } from '../lib/assistant/skill-defs.ts';
import { flattenHistoryContent } from '../lib/assistant/context.ts';
import { sourcePath } from './source-path.mjs';

const read = (p) => fs.readFileSync(sourcePath(p), 'utf8');
const screenshotDesc = () => TOOL_SCHEMAS.find((t) => t.function.name === 'take_screenshot').function.description;
const readabilityFix = () => SKILL_REGISTRY.find((s) => s.name === 'readability-fix').content;
const descOf = (mod) => mod.TOOL_SCHEMAS.find((t) => t.function.name === 'take_screenshot').function.description;
const skillOf = (mod) => mod.SKILL_REGISTRY.find((s) => s.name === 'readability-fix').content;
const META = { width: 1280, height: 720, format: 'jpeg', quality: 72, bytes: 145408 };
const HISTORY_WITH_IMAGE = [
  { type: 'text', text: '这个按钮在哪？' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
];

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
// ⑤ 历史回放占位说明的**关闭侧原文**（第 6 步新增的第 4 处接线点；关闭时逐字节保留）
const BASELINE_HISTORY_NOTE = '（该消息含 1 张图片；当前**未把图片传给模型**，仅保留此文字说明。）';

test('前提：开关是布尔的**打开**态（第 6 步已完成），且关闭臂仍可被载入', async () => {
  assert.equal(typeof VISION_ENABLED, 'boolean');
  assert.equal(VISION_ENABLED, true, '第 6 步已打开；若关回去，必须同步两臂文案门禁与文档');
  // 关闭臂靠改写源码载入 —— 锚点失效会在这里就抛错（不静默）
  const off = await loadWithVision(false, 'lib/shared/utils.js');
  assert.equal(off.VISION_ENABLED, false, '关闭臂必须真的被改成 false 再载入');
  const on = await loadWithVision(true, 'lib/shared/utils.js');
  assert.equal(on.VISION_ENABLED, true);
});

test('① take_screenshot 工具说明：关闭臂与改动前逐字节相同（且两臂不同）', async () => {
  const off = await loadWithVision(false, 'lib/assistant/tool-schemas.ts');
  assert.equal(descOf(off), BASELINE_TOOL_DESC);
  const on = await loadWithVision(true, 'lib/assistant/tool-schemas.ts');
  assert.notEqual(descOf(on), BASELINE_TOOL_DESC, '开启臂必须真的换了整句（否则开关没接上）');
  // 生产（真 import）落在**开启**那一档 ⇒ 顺手确认它和开启臂一致
  assert.equal(screenshotDesc(), descOf(on), '真模块必须等于开启臂');
});

test('② readability-fix 技能正文：关闭臂与改动前逐字节相同（含段落空行）', async () => {
  const off = await loadWithVision(false, 'lib/assistant/skill-defs.ts');
  const content = skillOf(off);
  assert.ok(content.includes(BASELINE_SKILL_FRAGMENT), '技能正文里那一段必须仍是原文（含结尾的 \\n\\n）');
  assert.ok(
    !content.includes('已经改好。\n## 绝不允许'),
    '少一个换行也是"改了模型能看到的内容" ✗（本次改动中真实发生过一次）'
  );
  const on = await loadWithVision(true, 'lib/assistant/skill-defs.ts');
  assert.ok(!skillOf(on).includes(BASELINE_SKILL_FRAGMENT), '开启臂必须整段替换掉');
});

test('③ formatScreenshotSummary：关闭臂与改动前逐字节相同，且禁用语不重复拼接', async () => {
  const off = await loadWithVision(false, 'lib/shared/utils.js');
  const summary = off.formatScreenshotSummary(META);
  assert.equal(summary, BASELINE_SCREENSHOT_SUMMARY);
  assert.equal(
    (summary.match(/你看不到图像内容/g) || []).length,
    1,
    '重复拼接会让模型连着读到两遍同一句 ✗（本次改动中真实发生过一次）'
  );
  // 另一条 meta 只钉住那句的关键标点（整条基准见 ③ 的 META）
  assert.ok(off.formatScreenshotSummary(null).includes('：**你看不到图像内容**，不要据它描述页面外观。'));
});

test('⑧ 历史回放占位说明：**第四处**接线点 —— 关闭臂逐字节原文，开启臂如实且不笼统', () => {
  // 关闭臂（显式 override）：与改动前逐字节相同
  assert.equal(flattenHistoryContent(HISTORY_WITH_IMAGE, false), '这个按钮在哪？\n' + BASELINE_HISTORY_NOTE);
  // 开启臂：不得再说"未把图片传给模型"（与事实相反 ✗），也不能笼统说"图片已传给模型"
  const on = flattenHistoryContent(HISTORY_WITH_IMAGE, true);
  assert.ok(!on.includes('未把图片传给模型'), '开启后不得再说图片没传给模型（与事实相反 ✗）');
  assert.ok(!on.includes('图片已传给模型'), '也不能笼统说"图片已传给模型" —— 这些历史图恰恰没传');
  assert.match(on, /不会重传/, '必须说清历史回放**不重传**');
  assert.match(on, /只有\*\*本次新增\*\*的截图才会随请求送进你的上下文/, '必须说清哪一类图在上下文里');
  // 生产（真 import，常量 = true）必须落在开启臂
  assert.equal(flattenHistoryContent(HISTORY_WITH_IMAGE), on, '真模块（常量 true）必须等于开启臂');
  assert.notEqual(flattenHistoryContent(HISTORY_WITH_IMAGE, false), on, '两臂必须不同');
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
  const css = read('lib/page/panel-css.ts');
  const line = css.split('\n').find((l) => l.includes('模型看不到图'));
  assert.ok(line, '锚点失效（这句被删或被改写）：请同步本用例');
  assert.match(line.trim(), /^\/\*.*\*\/$/, '它必须仍然只是一条 CSS 注释');
});

// ---------------- 源码级门禁 ----------------
// **四处**接线点：必须在**自己那段代码里**引用开关 —— "import 了但没用"不算。
const SITES = [
  {
    name: 'take_screenshot 工具说明',
    file: 'lib/assistant/tool-schemas.ts',
    from: "name: 'take_screenshot'",
    to: 'parameters:',
  },
  {
    name: 'readability-fix 技能正文',
    file: 'lib/assistant/skill-defs.ts',
    from: '- 需要给用户可视证据时用',
    to: '## 绝不允许的',
  },
  {
    name: 'formatScreenshotSummary',
    file: 'lib/shared/utils.js',
    from: 'export function formatScreenshotSummary',
    to: '\n}',
  },
  {
    // ⚠ 第 4 处（第 6 步找出）：它**不**随开关翻转而改变输出（因为原先根本没读开关），
    // 所以"两臂渲染比对"不会把它列为差异 —— 只有**逐条读模型可见文本**才发现它打开后会变成假话。
    name: '历史回放占位说明（flattenHistoryContent）',
    file: 'lib/assistant/context.ts',
    from: 'export function flattenHistoryContent',
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

test('源码级门禁：**四处**都必须引用 VISION_ENABLED，不许各自硬编码', () => {
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
    // 第 4 处的硬编码版：就是它在 HEAD 里的样子（开关打开后会变成假话 ✗）
    "export function flattenHistoryContent(content) { return text + '（该消息含 ' + images + ' 张图片；当前**未把图片传给模型**，仅保留此文字说明。）'; }",
  ];
  for (const src of guilty) {
    assert.ok(/你看不到图像内容|未把图片传给模型/.test(src), '夹具前提：它确实写着那句禁用文案');
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

  // 迁移期：specifier 可能是 `.js` 或 `.ts`（同一模块改名后 import 侧跟着改），两种都认。
  const importRe = (sym) => new RegExp("import\\s*\\{[^}]*" + sym + "[^}]*\\}\\s*from\\s*'\\.\\./shared/utils\\.(?:js|ts)'");
  assert.match(read('lib/assistant/tool-schemas.ts'), importRe('VISION_UNAVAILABLE_TOOL_COPY'));
  assert.match(read('lib/assistant/skill-defs.ts'), importRe('VISION_UNAVAILABLE_SKILL_COPY'));

  // 有牙齿：自带字面量的假源码不该被这条判为合格
  const guilty = "const VISION_UNAVAILABLE_TOOL_COPY = '不进入你的上下文 —— 当前模型是纯文本的…';";
  assert.doesNotMatch(guilty, importRe('VISION_UNAVAILABLE_TOOL_COPY'));
});

// ---------------- 开启侧：那句必须真的消失 ----------------
/** 以**绝对路径** import（data: URL 模块里的相对 specifier 不解析 ⇒ 必须给 file:// 或 data: URL）。 */
const ABS = (rel) => pathToFileURL(path.resolve(rel)).href;

/** readability-fix 技能正文里那一段（含结尾空行 —— 那正是最容易丢的字节）。 */
function skillFragmentOf(content) {
  const a = content.indexOf('- 需要给用户可视证据时用');
  const b = content.indexOf('## 绝不允许的', a);
  if (a < 0 || b < 0) throw new Error('技能段落锚点失效');
  return content.slice(a, b + '## 绝不允许的'.length);
}

/**
 * 把源码里的开关**真的改成 `enabled`** 再载入 —— 两臂都靠它拿到（第 6 步之后常量是 true）。
 *
 * 为什么要这么麻烦：`VISION_ENABLED` 是模块级 const，import 进来就固定了 ⇒
 * 直接 import 只看得到**一档**（当初是关闭、现在是开启），另一臂的断言会退化成
 * "其实还是这一档"而**静默通过** ✗
 *
 * ⚠ 迁移期（TITA-78）从 `data:` URL 改成了**临时 `.ts` 文件**：
 * Node 的 type stripping 按**扩展名**决定要不要擦类型，`data:text/javascript` 没有扩展名
 * ⇒ 改写后的源码里只要有一句类型标注就 `SyntaxError: Unexpected token 'export'`
 * （Batch 2 把 utils 改成 .ts 后，这条门禁就是这样从"绿"变成"加载期崩溃"的）。
 * 落成 `.ts` 文件后，Node 照常擦类型，门禁继续验的是**行为**而不是语法。
 * 逐次新建文件同时保留了原来 `data:` URL 的另一个性质：每个臂各自独立、不受模块缓存影响。
 *
 * @param {boolean} enabled 想要的臂
 * @param {string} file 要载入的模块（相对仓库根）
 */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-vision-arm-'));
let tmpSeq = 0;
/** 把源码写成临时 `.ts` 并返回它的 file: URL（不要用 data: URL，见上）。 */
function writeArm(src) {
  tmpSeq += 1;
  const file = path.join(TMP_DIR, 'arm-' + tmpSeq + '.ts');
  fs.writeFileSync(file, src, 'utf8');
  return pathToFileURL(file).href;
}

async function loadWithVision(enabled, file) {
  const anchor = /export const VISION_ENABLED = (?:true|false);/;
  assert.match(read('lib/shared/utils.js'), anchor, '开关定义锚点失效（`export const VISION_ENABLED = <bool>;`）');
  const patched = read('lib/shared/utils.js')
    .replace(anchor, 'export const VISION_ENABLED = ' + (enabled ? 'true' : 'false') + ';')
    // 临时文件在 `os.tmpdir()` 下，相对依赖**解析不了** ⇒
    // 同目录的每个相对依赖都要换成绝对 file: URL。
    // 原先只硬编码了 './constants.js'：utils.js 一有新依赖（2026-10-16 加了 './surrogates.js'），
    // 这条门禁就会以"解析失败"的形式炸掉 —— 那是**门禁脆**，不是被测代码错。
    .replace(/from '\.\/([A-Za-z0-9_.\-]+)'/g, (m, f) => "from '" + ABS('lib/shared/' + f) + "'");
  assert.doesNotMatch(patched, /from '\.\//, '改写后不许再残留相对 import（临时目录里解析不了它）');
  assert.ok(
    patched.includes('export const VISION_ENABLED = ' + (enabled ? 'true' : 'false') + ';'),
    '改写锚点失效（开关定义变了？）'
  );
  const utilsUrl = writeArm(patched);
  if (file === 'lib/shared/utils.js') return import(utilsUrl);
  const src = read(file);
  const rewritten = src.replace("from '../shared/utils.ts'", "from '" + utilsUrl + "'");
  assert.notEqual(rewritten, src, '改写锚点失效：' + file + ' 不再从 ../shared/utils.js 取开关');
  return import(writeArm(rewritten));
}

test('开关打开后：四处都不再说"看不到图像"，且技能段落的空行仍在', async () => {
  const onUtils = await loadWithVision(true, 'lib/shared/utils.js');
  const onSchemas = await loadWithVision(true, 'lib/assistant/tool-schemas.ts');
  const onSkills = await loadWithVision(true, 'lib/assistant/skill-defs.ts');

  const desc = descOf(onSchemas);
  const skill = skillOf(onSkills);
  const summary = onUtils.formatScreenshotSummary(META);

  assert.ok(!desc.includes('看不到图像'), '开启后工具说明不得再说"看不到图像"');
  assert.ok(!desc.includes('当前模型是纯文本的'), '开启后不得再说"当前模型是纯文本的"');
  assert.ok(!skill.includes('看不到图像内容'), '开启后技能不得再说"看不到图像内容"');
  assert.ok(!summary.includes('看不到图像'), '开启后截图摘要不得再说"看不到图像"');
  assert.ok(!summary.includes('不进入你的上下文'), '开启后截图摘要不得再说"不进入你的上下文"（与事实相反 ✗）');
  // 第 4 处：历史回放占位也要走开启档
  const hist = flattenHistoryContent(HISTORY_WITH_IMAGE, true);
  assert.ok(!hist.includes('未把图片传给模型'), '开启后历史占位不得再说"未把图片传给模型"');
  assert.ok(!hist.includes(BASELINE_HISTORY_NOTE), '开启后旧的历史占位整句都该走了');
  assert.ok(hist.includes('不会重传'), '开启后必须点明历史图不重传');
  // 关闭侧的原文在开启侧必须**不出现**（否则等于开关没接上）
  assert.ok(!desc.includes(BASELINE_TOOL_DESC), '开启后旧说明整条都该走了');
  assert.ok(!skill.includes(BASELINE_SKILL_FRAGMENT), '开启后旧技能文案整段都该走了');
  assert.ok(!summary.includes(BASELINE_SCREENSHOT_SUMMARY), '开启后旧摘要整条都该走了');
  // 空行是两档共用的排版，别只在一档里对
  assert.ok(skill.includes('的读数）。\n\n## 绝不允许的'), '开启侧也要保持段落空行');
});

test('⑥ 开启分支的文案常数：单一来源、如实、且不含任何"看不到"式反话', () => {
  const utils = read('lib/shared/utils.js');
  for (const sym of ['VISION_ENABLED_TOOL_COPY', 'VISION_ENABLED_SKILL_COPY', 'VISION_ENABLED_SUMMARY_COPY']) {
    assert.equal(utils.split('export const ' + sym).length - 1, 1, sym + ' 只能定义一次');
  }
  // 三条都必须是**如实的**：说图会进上下文 + 说清"哪些会送、哪些会被省略并说明"
  //
  // ⚠ 第 6 步人读时发现原稿承诺了接线**没做**的事：「只送**预算内**的最近几张，超出的会省略并说明」——
  //    而 `agent.js` 每张截图各调用一次 `visionMessagesFor([...])` ⇒ `maxImages: 2` 永远不是约束
  //    （实测 5 次各传 1 张 ⇒ 5 张全进上下文、0 次省略说明）。所以文案改成了如实说法，
  //    并用下面这条 `doesNotMatch` 让它**不能再被改回去** ✓
  for (const [name, s] of [
    ['tool', VISION_ENABLED_TOOL_COPY],
    ['skill', VISION_ENABLED_SKILL_COPY],
    ['summary', VISION_ENABLED_SUMMARY_COPY],
  ]) {
    assert.ok(s.length > 20, name + ' 启用分支太短，等于什么都没说');
    assert.match(s, /送进你的上下文/, name + ' 必须如实说明图会进上下文');
    assert.match(s, /都会送/, name + ' 必须如实说明"本次任务里截的每张都会送"');
    assert.match(s, /单张过大的会省略并说明/, name + ' 必须如实说明"单张过大的会被省略并说明"');
    assert.doesNotMatch(s, /看不到图像|不进入你的上下文|纯文本/, name + ' 不得再出现"看不到"式反话');
    assert.doesNotMatch(s, /只展示给用户/, name + ' 不得再说"只展示给用户"（与"会进上下文"矛盾 ✗）');
    // ⚠ 反话之二：**不许**承诺按张数封顶 —— 接线没做这件事（`maxImages` 在真实调用形状下不生效）
    assert.doesNotMatch(s, /预算内/, name + ' 不得承诺"只送预算内的最近几张"（接线没有按张数封顶 ✗）');
    assert.doesNotMatch(s, /超出的会省略/, name + ' 不得承诺"超出的会省略"（超出张数这件事根本不会被发现 ✗）');
  }
  // ③ 里那条与开关**无关**的 evidence 规则必须两档共用 —— 不能被条件化掉
  for (const arm of [formatScreenshotSummary(META, false), formatScreenshotSummary(META, true)]) {
    assert.ok(arm.includes('**截图不能作为 complete_task 的 evidence**'), '两臂都必须保留 evidence 规则');
  }
});

test('⑦ 开启分支的实际渲染：不复现第 7 步审校发现的那两类坏话（整句二选一）', async () => {
  const onUtils = await loadWithVision(true, 'lib/shared/utils.js');
  const onSchemas = await loadWithVision(true, 'lib/assistant/tool-schemas.ts');
  const onSkills = await loadWithVision(true, 'lib/assistant/skill-defs.ts');
  const desc = descOf(onSchemas);
  const skill = skillFragmentOf(skillOf(onSkills));
  const summary = onUtils.formatScreenshotSummary(META);
  // ① 缺陷一：坏标点「：，」
  assert.ok(!summary.includes('：，'), '坏标点：冒号后直接跟逗号（第 5 步的拼接残留 ✗）');
  // ② 缺陷二：自相矛盾 —— 同一句里既"只展示给用户"又说"送进你的上下文"
  for (const [name, s] of [['工具说明', desc], ['技能段', skill], ['截图摘要', summary]]) {
    assert.ok(!(s.includes('只展示给用户') && s.includes('送进你的上下文')), name + ' 自相矛盾 ✗');
  }
  // ③ 与开关无关的两条：evidence 规则仍在；「文本证据优先」的指导仍在
  for (const [name, s] of [['截图摘要', summary], ['工具说明', desc]]) {
    assert.ok(s.includes('截图不能作为 complete_task 的 evidence') || s.includes('文本证据优先') || s.includes('需要可判断的文本证据'),
      name + ' 开启侧也必须保留"文本证据优先 / 截图不是 evidence"的指导');
  }
  // ④ 第 4 处（历史回放占位）：开启侧同样不许出现"坏标点"式的拼接残留
  const hist = flattenHistoryContent(HISTORY_WITH_IMAGE, true);
  assert.ok(!hist.includes('）\n（'), '历史占位不许出现重复拼接的空括号段落');
  assert.equal((hist.match(/该消息含 1 张图片/g) || []).length, 1, '这句话不许被拼两遍');
});

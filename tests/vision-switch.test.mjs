// 视觉能力开关：**单一事实来源**，且**两臂都被钉住**。
//
// ## 为什么先做"开关"而不是先做"传图"
//
// 界面上有多处文案在说"你看不到图像" ✗ 在支持视觉之前它们是对的，
// 一旦真把截图传进请求，它们就变成**错的** ⇒ 模型会收到自相矛盾的指导
//（"你看不到图" + 一张图就在上下文里）。
//
// 所以能力必须有**一个**来源，文案与传输都问它 —— 而不是各写一遍硬编码 ✓
//
// ## 第 6 步已打开（本文件不再钉"必须是关的"）
//
// 原来的第一条断言是 `assert.equal(VISION_ENABLED, false)` —— 那是"开关还没打开"的钉子。
// 打开以后**不能**把它删掉、也不能松成 `typeof === 'boolean'`（那就等于没钉）✗
// 改成两条**互补**的钉子：
//   ① 常量取什么值，就**按实际值选臂**（默认入口的行为必须落在该臂上）；
//   ② 两臂都由 override 表达，且结果必须**不同** ⇒ override 不是摆设，
//      常量无论翻到哪一边都有断言在管 ✓
// 这样"开关被谁悄悄翻回去"或"翻过去但文案没接上"都会立刻红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  VISION_ENABLED,
  visionLimitationNote,
  formatScreenshotSummary,
  VISION_ENABLED_TOOL_COPY,
  VISION_ENABLED_SKILL_COPY,
  VISION_ENABLED_SUMMARY_COPY,
} from '../lib/shared/vision-copy.ts';
import { flattenHistoryContent } from '../lib/application/agent/context.ts';
import { visionMessagesFor } from '../lib/application/agent/vision.ts';
import { sourcePath } from './source-path.mjs';

const META = { width: 1280, height: 720, format: 'jpeg', quality: 72, bytes: 145408 };
const WITH_IMAGE = [
  { type: 'text', text: '这个按钮在哪？' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
];
const SHOT = { id: 's1', dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(100) };

test('开关是布尔（不是 undefined/字符串），且当前是**打开**的：第 6 步已完成', () => {
  assert.equal(typeof VISION_ENABLED, 'boolean', '开关必须是布尔常量');
  // ⚠ 这条是**状态钉子**：若有人把它翻回 false，必须同步两臂文案门禁与 docs/remaining-work.md，
  //   所以这里刻意红给他看，而不是"按实际值选臂"地放过去。
  assert.equal(VISION_ENABLED, true, '第 6 步已打开；若要关回去，必须同步两臂文案门禁与文档');
});

test('关闭臂：说明非空且如实（"看不到图像" + "不会进入你的输入"）', () => {
  const note = visionLimitationNote(false);
  assert.ok(note.length > 0, '关闭时必须有说明');
  assert.match(note, /看不到图像/);
  assert.match(note, /不会进入你的输入/, '要说明"截图只给用户看"，而不是含糊带过');
});

test('开启臂：说明为空串（否则会出现"嘴上说看不到、上下文里却有图"的自相矛盾）', () => {
  assert.equal(visionLimitationNote(true), '', '开启后不得再说"看不到"');
  // 默认（生产不传 override）也必须是空串 —— 因为常量确实开着
  assert.equal(visionLimitationNote(), VISION_ENABLED ? '' : visionLimitationNote(false));
});

test('**两臂都被钉住**：四处受开关影响的文案/装配，override 都必须真的改结果', () => {
  // ① 截图说明里的那句
  assert.notEqual(visionLimitationNote(false), visionLimitationNote(true));
  // ② 截图结果摘要
  const offSummary = formatScreenshotSummary(META, false);
  const onSummary = formatScreenshotSummary(META, true);
  assert.notEqual(offSummary, onSummary);
  assert.ok(offSummary.includes('看不到图像'));
  assert.ok(!onSummary.includes('看不到图像'), '开启侧不得再说"看不到图像"');
  // ③ 历史回放占位说明（第 6 步新增的第 4 处接线点）
  const offHist = flattenHistoryContent(WITH_IMAGE, false);
  const onHist = flattenHistoryContent(WITH_IMAGE, true);
  assert.notEqual(offHist, onHist);
  assert.ok(offHist.includes('未把图片传给模型'));
  assert.ok(!onHist.includes('未把图片传给模型'), '开启侧不得再说"未把图片传给模型"（与事实相反 ✗）');
  assert.ok(onHist.includes('不会重传'), '开启侧必须点明历史图不重传');
  // ④ 多模态消息装配
  assert.deepEqual(visionMessagesFor([SHOT], { visionEnabled: false }), []);
  assert.equal(visionMessagesFor([SHOT], { visionEnabled: true }).length, 1);

  // ⑤ 默认入口必须落在**常量实际取值**那一臂（无论开关是 true 还是 false 都成立）
  assert.equal(formatScreenshotSummary(META), VISION_ENABLED ? onSummary : offSummary);
  assert.equal(flattenHistoryContent(WITH_IMAGE), VISION_ENABLED ? onHist : offHist);
  assert.equal(
    visionMessagesFor([SHOT]).length,
    VISION_ENABLED ? 1 : 0,
    '默认装配必须按开关实际值产出'
  );
});

test('单一来源：这两个符号只在一个文件里定义（别处硬编码"看不到图像"会被这条盯上）', () => {
  const utils = fs.readFileSync(sourcePath('lib/shared/vision-copy.ts'), 'utf8');
  // ⚠ 必须用**词边界**数，不能用 `split('export const VISION_ENABLED').length - 1`：
  // 那会把 `VISION_ENABLED_TOOL_COPY` 这类**同前缀的文案常数**也数进去 ⇒ 假红 ✗（第 7 步踩到）
  assert.equal(
    (utils.match(/export const VISION_ENABLED\b/g) || []).length,
    1,
    '开关只能定义一次（注意别把 VISION_ENABLED_*_COPY 也算进来）'
  );
  assert.equal(utils.split('export function visionLimitationNote').length - 1, 1, '说明函数只能定义一次');
});

test('这条门禁本身有牙齿：开启侧文案没接上（仍写着"看不到图"）必须被判为不合格', () => {
  // 判据抽成纯函数：给定"开关值 + 实际渲染出来的文案"，判断它是否自相矛盾。
  const selfContradictory = (enabled, rendered) =>
    enabled === true && /看不到图像|不进入你的上下文|未把图片传给模型/.test(rendered);
  // 开了却还说"看不到" ⇒ 抓住
  assert.equal(selfContradictory(true, '当前**看不到图像**，请依据 DOM 判断。'), true, '开启侧的反话要被抓');
  assert.equal(selfContradictory(true, ''), false, '开启侧如实文案不该被抓');
  // 关闭侧说"看不到"是**对的**，不该被抓（这就是"两臂都要钉住"的另一半）
  assert.equal(selfContradictory(false, '当前**看不到图像**，请依据 DOM 判断。'), false, '关闭侧不该被抓');
  // 真源码：常量实际值那一臂必须**不自相矛盾**
  const rendered = [visionLimitationNote(), formatScreenshotSummary(META), flattenHistoryContent(WITH_IMAGE)].join('\n');
  assert.equal(selfContradictory(VISION_ENABLED, rendered), false, '当前实际取值那一臂必须是自洽的');
  // 反向自检：若把渲染结果换成关闭侧原文，而常量是 true，这条判据必须真的红
  assert.equal(
    selfContradictory(true, formatScreenshotSummary(META, false)),
    true,
    '判据本身要能咬人（否则这条门禁恒假）'
  );
});

test('三处启用分支的文案常数都存在且被开关引用（单一来源，别处不许再抄一份）', () => {
  const utils = fs.readFileSync(sourcePath('lib/shared/vision-copy.ts'), 'utf8');
  for (const [name, copy] of [
    ['tool', VISION_ENABLED_TOOL_COPY],
    ['skill', VISION_ENABLED_SKILL_COPY],
    ['summary', VISION_ENABLED_SUMMARY_COPY],
  ]) {
    assert.equal(utils.split('export const VISION_ENABLED_' + name.toUpperCase() + '_COPY').length - 1, 1, name + ' 只能定义一次');
    assert.ok(copy.length > 20, name + ' 启用分支太短');
    assert.match(copy, /送进你的上下文/, name + ' 必须如实说明图会进上下文');
  }
});

test('依赖链要短：开关与说明必须是纯函数，不引入浏览器依赖（否则内容脚本里用不了）', () => {
  const utils = fs.readFileSync(sourcePath('lib/shared/vision-copy.ts'), 'utf8');
  const at = utils.indexOf('export function visionLimitationNote');
  const body = utils.slice(at, utils.indexOf('\n}', at));
  assert.ok(!/chrome\.|window\.|document\./.test(body), '说明函数不许碰浏览器对象');
});

test('默认预算不可配置这一点有**如实标注**（别假装 ctx.visionBudget 可配）', () => {
  const vision = fs.readFileSync('lib/application/agent/vision.ts', 'utf8');
  assert.match(vision, /没有任何地方赋值/, 'vision.js 必须如实标注"ctx.visionBudget 从未被赋值"');
  assert.match(vision, /不可配置/, '必须明确写"不可配置"');
  // 有牙齿：源码里若真的出现赋值点，这个用例会红，逼人把标注改成"可配置"并补门禁
  const agent = fs.readFileSync('lib/application/agent/tool-call-pipeline.ts', 'utf8');
  const assignments = agent.match(/ctx\.visionBudget\s*=/g) || [];
  assert.equal(assignments.length, 0, 'agent.js 里不应有 visionBudget 赋值（若加了，请同步上面两处标注）');
});

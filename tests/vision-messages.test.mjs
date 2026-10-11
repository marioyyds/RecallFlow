// 视觉消息装配：**开关关闭时一律不产出** —— 这是"今天行为不变"的可验证依据。
//
// 起因见 docs/remaining-work.md 的 ①：工具消息只能放文本 ✗ ⇒ 图必须走**追加的 user 消息** ✓
// 且**实测**约 578 token/图（1280×720；随尺寸变化）⇒ 必须有预算，超出时**如实说明省了什么** ✓
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  visionMessagesFor,
  selectScreenshotsForVision,
  buildScreenshotMessage,
  estimateVisionTokens,
  TOKENS_PER_IMAGE,
  DEFAULT_VISION_BUDGET,
} from '../lib/assistant/vision.js';
import { VISION_ENABLED } from '../lib/shared/utils.js';

const shot = (id, chars = 100) => ({
  id,
  dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(chars),
});

test('**开关关闭时一律返回空数组**（今天的行为与引入之前完全一致）', () => {
  assert.equal(VISION_ENABLED, false, '前置：开关当前是关的');
  assert.deepEqual(visionMessagesFor([shot('s1')]), [], '关着就不许产出任何多模态消息');
  assert.deepEqual(visionMessagesFor([shot('s1')], { visionEnabled: false }), []);
});

test('开关打开时才产出，且是**追加的 user 消息**（不是 tool 消息）', () => {
  const msgs = visionMessagesFor([shot('s1')], { visionEnabled: true });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user', '必须是 user 消息 —— 工具消息只能放文本');
  assert.ok(Array.isArray(msgs[0].content), '内容必须是部件数组');
  assert.equal(msgs[0].content[0].type, 'text');
  assert.equal(msgs[0].content[1].type, 'image_url');
  assert.ok(String(msgs[0].content[1].image_url.url).startsWith('data:image/jpeg;base64,'));
});

test('图片部件里**不许**出现裸 base64（必须包在 data URL 里）', () => {
  const msgs = visionMessagesFor([shot('s1')], { visionEnabled: true });
  const url = msgs[0].content[1].image_url.url;
  assert.ok(url.includes('base64,'), 'data URL 形态');
  assert.ok(url.length > 100, '应当是完整 data URL 而不是被截断的片断');
});

test('预算：超过张数上限时**从最近往回挑**，并如实说明省了几张', () => {
  const { picked, skippedCount, note } = selectScreenshotsForVision(
    [shot('old'), shot('mid'), shot('new')],
    { maxImages: 2, maxBase64Chars: 1e9 }
  );
  assert.deepEqual(picked.map((s) => s.id), ['mid', 'new'], '越新的越相关');
  assert.equal(skippedCount, 1);
  assert.match(note, /另有 1 张截图/, '丢东西必须说明');
  assert.match(note, /未送入模型/);
});

test('预算：单张过大时跳过它，并计入"省了"的说明', () => {
  const { picked, skippedCount, note } = selectScreenshotsForVision(
    [shot('huge', 50), shot('fine', 10)],
    { maxImages: 2, maxBase64Chars: 20 }
  );
  assert.deepEqual(picked.map((s) => s.id), ['fine']);
  assert.equal(skippedCount, 1);
  assert.match(note, /另有 1 张截图/);
});

test('没有超出预算时不写说明（免得每次都塞一句废话）', () => {
  const { note, skippedCount } = selectScreenshotsForVision([shot('a')], { maxImages: 2, maxBase64Chars: 1e9 });
  assert.equal(skippedCount, 0);
  assert.equal(note, '');
});

test('token 记账：按**实测上界**估算（第 8 步实测：1280×720 ≈ 578 ⇒ 取 600）', () => {
  // 为什么钉住具体数字：它是"预算里还能塞几张"的依据，改小会让判断偏乐观（无声失准）。
  // 实测表见 lib/assistant/vision.js 的 TOKENS_PER_IMAGE 注释。
  assert.equal(TOKENS_PER_IMAGE, 600, '实测 578（1280×720）⇒ 取 600 作上界');
  assert.equal(estimateVisionTokens(3), 1800);
  assert.equal(estimateVisionTokens(0), 0);
});

test('脏输入不抛异常，也不产出非法消息', () => {
  assert.equal(buildScreenshotMessage([]), null);
  assert.equal(buildScreenshotMessage(null), null);
  assert.deepEqual(visionMessagesFor(null, { visionEnabled: true }), [], '没有截图就不该产出消息');
  assert.deepEqual(
    visionMessagesFor([{ id: 'x' }], { visionEnabled: true }),
    [],
    '没有 dataUrl 的项要被忽略（否则会产出空图 URL）'
  );
});

test('默认预算有界（防止有人把它设成"不限张数"）', () => {
  assert.ok(DEFAULT_VISION_BUDGET.maxImages > 0 && DEFAULT_VISION_BUDGET.maxImages <= 4, '默认张数要有界');
  assert.ok(DEFAULT_VISION_BUDGET.maxBase64Chars > 0 && DEFAULT_VISION_BUDGET.maxBase64Chars <= 4e6, '单片体积要有界');
});

// ---------------- 第 7 步的**纯单元**对照门禁 ----------------
//
// 为什么单靠 E2E 不够：E2E 要么真截图、要么跳过，**慢且依赖浏览器**；
// 而"开关两臂的返回值"这件事本身是纯函数性质 ⇒ 用 `options.visionEnabled` override
// 在两臂各断言一次，毫秒级、且**永不跳过** ✓
//
// ⚠ 刻意**不临时改常量**：`VISION_ENABLED` 是模块级 const，改它要么改源码（会让别的用例读到中间态）、
// 要么靠 data: URL 重载（重）；override 参数就是为这件事存在的 ——
// 它同时钉住"override 真的能覆盖常量"（否则这两条会**静默退化成**只测常量当前值 ✗）。
test('纯单元门禁：两臂各断言一次（用 override，不改常量）', () => {
  assert.equal(VISION_ENABLED, false, '前置：常量仍是关闭（下面两臂都靠 override）');

  // 关闭臂：空数组 —— 且**不依赖常量当前值**（显式传 false）
  const off = visionMessagesFor([shot('s1'), shot('s2')], { visionEnabled: false });
  assert.deepEqual(off, [], 'visionEnabled:false 必须返回 []（今天的行为）');

  // 开启臂：必须产出**含 image_url 的消息**
  const on = visionMessagesFor([shot('s1')], { visionEnabled: true });
  assert.equal(on.length, 1, 'visionEnabled:true 必须产出 1 条消息');
  assert.equal(on[0].role, 'user');
  assert.ok(
    (on[0].content || []).some((p) => p && p.type === 'image_url'),
    '必须含 image_url 部件'
  );

  // 反向自检：override 不是"摆设" —— 两臂结果必须**不同**
  assert.notDeepEqual(off, on, '两臂结果相同 ⇒ override 没生效，这条门禁会恒真 ✗');
  // 常量在整个用例里没被动过（否则上面的前置断言会红）
  assert.equal(VISION_ENABLED, false, '后置：常量仍未被改');
});

// ---------------- 与 E2E 门禁的**接线检查** ----------------
//
// E2E 那条（请求体里有没有 image_url）必须**按常量实际值选臂**，否则开关一打开它就会红着，
// 而最省事的修法是删断言 ✗。这里用源码级门禁把"它必须引用常量"钉住 ——
// 但**不**要求它出现在某个具体文件里之外的东西（避免门禁自己变成维护负担）。
test('E2E 对照门禁存在、且按常量实际值选臂（不是写死"今天没有图"）', () => {
  const p = 'tests/e2e/vision-switch.spec.mjs';
  assert.ok(fs.existsSync(p), '缺少 E2E 对照门禁：' + p);
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /import\s*\{[^}]*VISION_ENABLED[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/shared\/utils\.js'/, '必须 import VISION_ENABLED');
  assert.match(src, /test\.skip\(VISION_ENABLED !== false/, '关闭臂要按常量选臂');
  assert.match(src, /test\.skip\(VISION_ENABLED !== true/, '开启臂要按常量选臂');
  assert.match(src, /image_url/, '必须断言 image_url 的存在/形态');
  // 有牙齿：把"写死"的假源码判为不合格
  const guilty = "test('关闭臂：请求里没有图', async () => { expect(count()).toBe(0); });";
  assert.ok(!/test\.skip\(VISION_ENABLED/.test(guilty), '写死一臂的假源码不该被这条判为合格');
});

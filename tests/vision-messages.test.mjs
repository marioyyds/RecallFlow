// 视觉消息装配：**两臂都由开关决定**（`VISION_ENABLED` 第 6 步已打开 ⇒ 默认臂现在会产出图）。
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
} from '../lib/assistant/vision.ts';
import { VISION_ENABLED } from '../lib/shared/utils.ts';

const shot = (id, chars = 100) => ({
  id,
  dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(chars),
});

test('默认臂按开关**实际取值**选（不写死"关着"）：关闭为空数组，打开就必须产出', () => {
  const dflt = visionMessagesFor([shot('s1')]);
  if (VISION_ENABLED) {
    assert.equal(dflt.length, 1, '开关打开时默认必须产出 1 条多模态消息');
    assert.ok(
      (dflt[0].content || []).some((p) => p && p.type === 'image_url'),
      '打开时默认必须含 image_url'
    );
  } else {
    assert.deepEqual(dflt, [], '关着就不许产出任何多模态消息');
  }
  // 两臂都由 override 表达（与常量当前值无关）
  assert.deepEqual(visionMessagesFor([shot('s1')], { visionEnabled: false }), []);
  assert.equal(visionMessagesFor([shot('s1')], { visionEnabled: true }).length, 1);
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

test('**丢东西必须说明**：全都被跳过时仍要产出一条纯文本说明（不许静默丢图）', () => {
  // 原先这条路会走 `buildScreenshotMessage([]) === null` ⇒ 连说明一起丢掉：
  // 模型既拿不到图、也不知道"图被省略了"，只会以为截图没发生 ✗
  const only = [{ id: 'huge', dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(50) }];
  const msgs = visionMessagesFor(only, { visionEnabled: true, budget: { maxImages: 2, maxBase64Chars: 20 } });
  assert.equal(msgs.length, 1, '全被跳过时也必须有一条消息（说明），不是 0 条');
  assert.equal(msgs[0].role, 'user');
  assert.ok(Array.isArray(msgs[0].content));
  assert.equal(msgs[0].content.length, 1, '没有图可送 ⇒ 只能是纯文本，不许产出 image_url');
  assert.equal(msgs[0].content[0].type, 'text');
  assert.match(msgs[0].content[0].text, /没有送入你的上下文/);
  assert.match(msgs[0].content[0].text, /另有 1 张截图/);
  // 有图可送时，说明跟着图走（不额外多一条消息）
  const ok = visionMessagesFor([shot('fine', 10)], { visionEnabled: true, budget: { maxImages: 2, maxBase64Chars: 20 } });
  assert.equal(ok.length, 1);
  assert.ok(ok[0].content.some((p) => p && p.type === 'image_url'));
  // 关着的时候**一律**空数组（包括"全被跳过"这条路）
  assert.deepEqual(visionMessagesFor(only, { visionEnabled: false, budget: { maxBase64Chars: 20 } }), []);
});

test('⚠ 如实记账：张数上限在**真实接线形状**下不生效（防止有人再写"只送预算内的最近几张"）', () => {
  // agent.js 是每张截图各调用一次（数组里永远只有 1 张）⇒ maxImages 永远不是约束。
  // 这条用例把这个事实钉住：一旦有人真去接了任务级上限，它会红，逼人同步开启侧文案 ✓
  let images = 0;
  let omissionNotes = 0;
  for (let i = 1; i <= 5; i++) {
    for (const m of visionMessagesFor([shot('s' + i, 1000)], { visionEnabled: true })) {
      for (const p of m.content || []) if (p && p.type === 'image_url') images += 1;
      const t = (m.content || []).find((p) => p && p.type === 'text');
      if (t && /未送入模型/.test(String(t.text))) omissionNotes += 1;
    }
  }
  assert.equal(images, 5, '当前形状下 5 张截图会全部进上下文（没有张数封顶）—— 若改成封顶，请同步文案');
  assert.equal(omissionNotes, 0, '当前形状下不会产生"张数超出"的说明 —— 若改成封顶，请同步文案');
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
  // ⚠ 这里**不再**断言"常量必须是关的"（第 6 步已打开）——
  // 改断言的是"两臂都能被表达"，这样常量翻到哪一边这条门禁都有效 ✓
  assert.equal(typeof VISION_ENABLED, 'boolean', '前置：常量是布尔（下面两臂都靠 override）');

  // 关闭臂：空数组 —— 且**不依赖常量当前值**（显式传 false）
  const off = visionMessagesFor([shot('s1'), shot('s2')], { visionEnabled: false });
  assert.deepEqual(off, [], 'visionEnabled:false 必须返回 []');

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
  // 默认入口（生产不传 override）必须等于**常量实际值**那一臂
  assert.deepEqual(visionMessagesFor([shot('s1')]), VISION_ENABLED ? on : off, '默认按开关实际值选臂');
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
  // 迁移期：specifier 可能是 `.js`（E2E 侧还没跟着改）或 `.ts`，两种都认。
  assert.match(src, /import\s*\{[^}]*VISION_ENABLED[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/shared\/utils\.(?:js|ts)'/, '必须 import VISION_ENABLED');
  assert.match(src, /test\.skip\(VISION_ENABLED !== false/, '关闭臂要按常量选臂');
  assert.match(src, /test\.skip\(VISION_ENABLED !== true/, '开启臂要按常量选臂');
  assert.match(src, /image_url/, '必须断言 image_url 的存在/形态');
  // 有牙齿：把"写死"的假源码判为不合格
  const guilty = "test('关闭臂：请求里没有图', async () => { expect(count()).toBe(0); });";
  assert.ok(!/test\.skip\(VISION_ENABLED/.test(guilty), '写死一臂的假源码不该被这条判为合格');
});

// ── 任务级截图上限（(e) 成本上界）──────────────────────────────────────────
// 为什么要有这条：视觉打开后每张图约 600 token 进上下文，而 take_screenshot 模型可以反复调用 ⇒
// 没有上界时一次任务能把上下文塞满图 ✗。ctx.visionBudget（按 token）**无人赋值** ⇒
// 唯一兜得住的就是这个**按张数**的上界；到上界后必须**留痕**（纯文字说明），不许静默丢 ✗
test('任务级截图上限：到上界后不再送图，但必须**留痕**（纯文字说明）', async () => {
  const { MAX_IMAGES_PER_TASK, shouldSendImage, imageCapNote } = await import('../lib/assistant/vision.ts');
  assert.equal(MAX_IMAGES_PER_TASK, 3, '上界默认值（改了要同步说明与文档）');
  for (const n of [0, 1, 2]) assert.equal(shouldSendImage(n), true, '第 ' + (n + 1) + ' 张应当送');
  for (const n of [3, 4, 99]) assert.equal(shouldSendImage(n), false, '第 ' + (n + 1) + ' 张超出上界，不该送');

  const note = imageCapNote(3, '页面截图');
  assert.ok(/不再送出图像/.test(note), '说明里必须讲清这一张不送图');
  assert.ok(/达到上限 3 张/.test(note), '说明里要有张数');
  assert.ok(/页面截图/.test(note), '说明里要带上标签（能对上号）');
  assert.ok(!/看不到/.test(note), '别说看不到图 —— 开关是开的，那句话与事实矛盾 ✗');

  // 反向样张：上界 0 / 负数 ⇒ 全部不送，但说明仍然出现（否则计数很容易退化成恒真断言）
  assert.equal(shouldSendImage(0, 0), false, '上界 0 时第一张也不送');
  assert.equal(shouldSendImage(0, -1), false, '负数上界按不送处理');
  assert.ok(imageCapNote(0, '', 0).length > 10, '上界 0 时仍然要给出说明（不静默丢）');
});

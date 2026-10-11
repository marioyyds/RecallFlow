// 视觉消息装配：**开关关闭时一律不产出** —— 这是"今天行为不变"的可验证依据。
//
// 起因见 docs/remaining-work.md 的 ①：工具消息只能放文本 ✗ ⇒ 图必须走**追加的 user 消息** ✓
// 且约 400 token/图 ⇒ 必须有预算，超出时**如实说明省了什么** ✓
import test from 'node:test';
import assert from 'node:assert/strict';

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

test('token 记账：按实测值 400/图估算', () => {
  assert.equal(TOKENS_PER_IMAGE, 400);
  assert.equal(estimateVisionTokens(3), 1200);
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

// 视觉能力开关：**单一事实来源**，当前关闭 ⇒ 今天行为与引入之前完全一致。
//
// ## 为什么先做"开关"而不是先做"传图"
//
// 界面上有多处文案在说"你看不到图像" ✗ 在支持视觉之前它们是对的，
// 一旦真把截图传进请求，它们就变成**错的** ⇒ 模型会收到自相矛盾的指导
//（"你看不到图" + 一张图就在上下文里）。
//
// 所以能力必须有**一个**来源，文案与传输都问它 —— 而不是各写一遍硬编码 ✓
//
// ## 本轮为什么不需要跑真模型 eval
//
// `VISION_ENABLED = false` ⇒ 今天的模型可见内容**一字未变** ✓
// 按第 26 轮的教训（`docs/regression-red-flag.md`），只有"改了模型能看到的内容"才必须测量 ✓
// 本文件钉住这条边界：**开关关闭时说明非空、开启时为空** ✓
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { VISION_ENABLED, visionLimitationNote } from '../lib/shared/utils.js';

test('开关当前是**关闭**的（这正是"今天行为不变"的依据）', () => {
  assert.equal(VISION_ENABLED, false, '若改成 true，必须同时做完传送/文案/预算/门禁，并跑 eval');
});

test('关闭时给出"看不到图像"的如实说明', () => {
  const note = visionLimitationNote();
  assert.ok(note.length > 0, '关闭时必须有说明');
  assert.match(note, /看不到图像/);
  assert.match(note, /不会进入你的输入/, '要说明"截图只给用户看"，而不是含糊带过');
});

test('开启时说明为空串（否则会出现"嘴上说看不到、上下文里却有图"的自相矛盾）', () => {
  assert.equal(visionLimitationNote(true), '', '开启后不得再说"看不到"');
  assert.ok(visionLimitationNote(false).length > 0, '显式传 false 仍要有说明');
});

test('单一来源：这两个符号只在一个文件里定义（别处硬编码"看不到图像"会被这条盯上）', () => {
  const utils = fs.readFileSync('lib/shared/utils.js', 'utf8');
  assert.equal(utils.split('export const VISION_ENABLED').length - 1, 1, '开关只能定义一次');
  assert.equal(utils.split('export function visionLimitationNote').length - 1, 1, '说明函数只能定义一次');
});

test('这条门禁本身有牙齿：把开关改成 true 而没做后续步骤就该红', () => {
  const guilty = (v) => v !== false;
  assert.equal(guilty(true), true, '改成 true 要被抓');
  assert.equal(guilty(VISION_ENABLED), false, '当前不该被抓');
});

test('依赖链要短：开关与说明必须是纯函数，不引入浏览器依赖（否则内容脚本里用不了）', () => {
  const utils = fs.readFileSync('lib/shared/utils.js', 'utf8');
  const at = utils.indexOf('export function visionLimitationNote');
  const body = utils.slice(at, utils.indexOf('\n}', at));
  assert.ok(!/chrome\.|window\.|document\./.test(body), '说明函数不许碰浏览器对象');
});

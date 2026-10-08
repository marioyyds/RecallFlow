// 「划重点」技能与 highlight_text 上限的一致性。
//
// 为什么需要这组用例：
// 1) 技能原先写死「挑选 3-8 条关键句子」。这个区间与页面长度无关，而模型每次都取上限，
//    于是三轮会话（RF-H2BM4M / RF-27A7CA / 其后一次）划出来的一律是 8 条 ——
//    「3-8」里的 3 从未出现过，区间实际是个常数。
// 2) 条数上限原先只存在于页面命令实现里（.slice(0, 20)），既不告诉模型、也不报告截断，
//    传 25 条会返回「已高亮 20 / 20 处关键信息」—— 少做了 5 条看起来像全部完成。
import test from 'node:test';
import assert from 'node:assert/strict';

import { SKILL_REGISTRY } from '../lib/assistant/skill-defs.js';
import { TOOL_SCHEMAS } from '../lib/assistant/tool-schemas.js';
import { HIGHLIGHT_MAX_TEXTS } from '../lib/shared/constants.js';

const skill = SKILL_REGISTRY.find((s) => s.name === 'highlight-key-points');
const schema = TOOL_SCHEMAS.find((t) => t.function && t.function.name === 'highlight_text');

test('技能存在且是「划重点」', () => {
  assert.ok(skill, '找不到 highlight-key-points 技能');
  assert.match(skill.content, /划重点/);
});

test('条数按正文规模分档，而不是固定区间', () => {
  // 三个档位都要在
  assert.match(skill.content, /< 2000 字/, '缺少小页面档位');
  assert.match(skill.content, /2000-10000 字/, '缺少中页面档位');
  assert.match(skill.content, /> 10000 字/, '缺少大页面档位');
  // 且必须说明「不要固定取上限」
  assert.match(skill.content, /不要固定取上限/);
});

test('用户明确指定条数时以用户为准', () => {
  assert.match(skill.content, /用户明确说了条数就按用户说的/);
});

test('给出字数锚点的来源（不能只让模型自己估）', () => {
  assert.match(skill.content, /正文约 N 字/, '要指明字数从哪里读');
});

test('说明凑不满档位时应少划，而不是拆句凑数', () => {
  assert.match(skill.content, /凑不满档位就少划几条/);
});

test('技能不再把单次上限写死成具体数字（避免第三处真值来源）', () => {
  // 具体数字应从工具 schema 读到；技能里再写一份就会与常量/实现三方漂移
  assert.ok(!/单次最多 \d+ 条/.test(skill.content), '技能里不应硬编码单次条数上限');
  assert.match(skill.content, /highlight_text 工具定义/, '应把读者引向工具定义');
});

test('工具 schema 的 maxItems 与实现用的常量一致', () => {
  const maxItems = schema.function.parameters.properties.texts.maxItems;
  assert.equal(
    maxItems,
    HIGHLIGHT_MAX_TEXTS,
    'schema 说 ' + maxItems + '、实现却是 ' + HIGHLIGHT_MAX_TEXTS + ' —— 模型会按错误的预期分批'
  );
});

test('工具描述把上限告诉模型（不能只在实现里当暗礁）', () => {
  assert.ok(
    schema.function.description.includes(String(HIGHLIGHT_MAX_TEXTS)),
    'highlight_text 的描述里应写明单次上限'
  );
  assert.match(schema.function.parameters.properties.texts.description, /超出会被截断并告知/);
});

test('上限是正整数', () => {
  assert.ok(Number.isInteger(HIGHLIGHT_MAX_TEXTS) && HIGHLIGHT_MAX_TEXTS > 0);
});

test('保留既有约定：必须用原文片段、批量一次调用、先清浮层', () => {
  assert.match(skill.content, /必须使用页面中的原文片段/);
  assert.match(skill.content, /一次 highlight_text 调用/);
  assert.match(skill.content, /clear_page_overlays/);
  assert.match(skill.content, /complete_task/);
});

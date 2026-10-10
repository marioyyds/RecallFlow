// annotate({ op }) 的合并边界与分派（C-4 第 1 档）。
//
// 为什么值得单独测：`op` 由**模型**填，而四个 op 会落到**四个不同的页面命令**。
// 分派写错（例如 op=style 落进 highlight）会让模型以为"样式改好了"而实际什么都没改 ——
// 静默错误，且这一档的工具全都**有副作用**（改页面呈现），代价比读类工具更高。
//
// 本档是 C-4 里"最纯粹"的一次合并：四个工具风险完全一致、执行路径完全一致，
// 因此不存在"取最高"或"路径不同"的歧义。这里把这条性质也钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { TOOL_REGISTRY } from '../lib/assistant/tools.js';

const byName = Object.fromEntries(TOOL_REGISTRY.map((t) => [t.name, t]));

test('annotate 的 op 枚举与四个原工具一一对应', () => {
  const op = byName.annotate.inputSchema.properties.op;
  assert.deepEqual(op.enum, ['highlight', 'outline', 'style', 'clear']);
  assert.deepEqual(byName.annotate.inputSchema.required, ['op'], 'op 必填（缺了会静默走错分支）');
});

test('分派表必须与 lib/page/commands.js 的命令名一致（否则得到"页面命令无响应"）', async () => {
  const cli = fs.readFileSync(new URL('../lib/page/commands.js', import.meta.url), 'utf8');
  for (const cmd of ['highlight', 'outline', 'set_style', 'clear_highlights']) {
    assert.match(cli, new RegExp("case '" + cmd + "'"), '内容脚本应支持命令 ' + cmd);
  }
  // 直接断言**真实的分派表对象**，而不是在源码里做字符串切片 ——
  // C-1 拆分把 ANNOTATE_OPS 搬进 ./page-command-tools.js 时，
  // 基于切片的老写法会静默切到空串（失败原因指向错误的地方）。
  const { ANNOTATE_OPS } = await import('../lib/assistant/page-command-tools.js');
  assert.deepEqual(ANNOTATE_OPS, { highlight: 'highlight', outline: 'outline', style: 'set_style', clear: 'clear_highlights' });
});

test('四个被合并的工具名不得再出现在注册表里', () => {
  for (const gone of ['highlight_text', 'outline_element', 'set_element_style', 'clear_page_overlays']) {
    assert.ok(!byName[gone], gone + ' 应已并入 annotate');
  }
});

test('权限必须与合并前完全一致（page + 逐次审批）', () => {
  // 这一档是"纯粹收敛"：四个原工具都是 page + requiresApproval。
  // 合并若把权限放宽（丢掉审批），就等于把四个改页面的动作变成免确认；
  // 若收紧成 alwaysRequireApproval，则每次高亮都要单独批准。
  assert.equal(byName.annotate.risk, 'page');
  assert.equal(byName.annotate.requiresApproval, true);
  assert.ok(!byName.annotate.alwaysRequireApproval, '不应升级为逐次审批（会与合并前不一致）');
  assert.equal(byName.annotate.readOnly, false, '它会改页面呈现，绝不是只读');
});

test('op=highlight 的上限必须仍在 schema 里告诉模型（不能只在实现里当暗礁）', () => {
  const texts = byName.annotate.inputSchema.properties.texts;
  assert.ok(texts, 'annotate 应保留 texts 参数（op=highlight 用）');
  assert.ok(Number.isInteger(texts.maxItems) && texts.maxItems > 0, 'texts 必须声明 maxItems');
  assert.match(byName.annotate.description, new RegExp(String(texts.maxItems)), '描述里要写明单次上限');
});

test('模型可见文案里不得再出现已消失的工具名', () => {
  // 这些字符串会直接进模型上下文：写旧名会让它去调用一个不存在的工具。
  const files = [
    '../lib/shared/utils.js',
    '../lib/assistant/tool-schemas.js',
    '../lib/assistant/intent-router.js',
    '../lib/assistant/skill-defs.js',
  ];
  const offenders = [];
  for (const rel of files) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    // 只看代码/字符串里的裸名字，忽略注释里的历史说明
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const gone of ['highlight_text', 'outline_element', 'set_element_style', 'clear_page_overlays']) {
      if (new RegExp("'" + gone + "'").test(code) || new RegExp('"' + gone + '"').test(code)) {
        offenders.push(rel + ' → ' + gone);
      }
    }
  }
  assert.deepEqual(offenders, [], '模型可见文案里仍有旧工具名：\n  ' + offenders.join('\n  '));
});

test('划重点技能的工具清单必须是 annotate（否则技能会引导模型调用不存在的工具）', () => {
  const src = fs.readFileSync(new URL('../lib/assistant/skill-defs.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("name: 'highlight-key-points'"), src.indexOf("name: 'remove-ads'"));
  assert.match(block, /'annotate'/, '划重点技能应声明 annotate');
  assert.ok(!/'highlight_text'/.test(block), '不得再声明 highlight_text');
  // 去广告技能同理（原 set_element_style + clear_page_overlays → annotate）
  const ads = src.slice(src.indexOf("name: 'remove-ads'"));
  assert.match(ads.slice(0, 900), /'annotate'/, '去广告技能应声明 annotate');
});

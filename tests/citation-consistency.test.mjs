// 「证据引用」的一致性：要求标 [n] 的地方，必须真的有编号可标。
//
// ## 实测缺陷（会话 RF-V6T7C5 的截图）
//
// 那张工具结果表里，12 行中有 9 行末尾挂着 `[页面]`（内联代码样式），
// 而知识库那几行是 `[1]`–`[4]` 的可点击引用徽章。两种东西长得像、性质完全不同：
// `[页面]` 点了没反应。
//
// 根因是**提示与设计自相矛盾**：
//   · 系统提示（intent-router 规则 3 / rag.js 面板提示）要求
//     「凡是依据知识库、**当前页面**或第三方网页证据的句子，都必须用 [n] 标注来源编号」；
//   · 而 agent.js 里当前页面**刻意不编号**（「否则会占掉全局引用编号」），
//     真正可点击的来源只统计 fetch / read 过的页面。
// 模型被要求给「当前页面」标一个不存在的编号，于是自己编了一个标签 —— `[页面]`。
//
// 而 extractCiteNum('页面') 抽不出数字 → renumberCitations 跳过（不重编号、不生成来源），
// renderAnswer 也跳过（不渲染徽章）。于是它变成一段**看着像引用、点了却没反应的死文本**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { extractCiteNum, renumberCitations } from '../lib/page/markdown.js';

const read = (p) => fs.readFileSync(p, 'utf8');

// ---------------------------------------------------------------- 数字抽取的边界

test('extractCiteNum: 只认「以数字结尾」的括号内容', () => {
  assert.equal(extractCiteNum('1'), 1);
  assert.equal(extractCiteNum('K8s文档2'), 2, '带前缀标签也算引用');
  assert.equal(extractCiteNum('页面'), null, '「页面」不该被当成引用编号');
  assert.equal(extractCiteNum('本页'), null);
  assert.equal(extractCiteNum('当前页面'), null);
  assert.equal(extractCiteNum(''), null);
});

test('非数字标签不会被重编号，也不会生成来源（它就是死文本）', () => {
  const cites = [{ index: 1, source: 'kb', title: 'K0023 魔导服务器' }];
  const out = renumberCitations('看这个 [页面] 和这条 [1]。', cites);
  assert.ok(out.text.includes('[页面]'), '原样保留 —— 这正说明它成了死文本');
  assert.equal(out.citations.length, 1, '不该为它生成来源');
  assert.equal(out.citations[0].index, 1);
});

// ---------------------------------------------------------------- 提示层：不许要求给当前页面编号

const DEMANDING = [
  { file: 'lib/assistant/intent-router.js', label: 'agent 规则 3' },
  { file: 'lib/shared/rag.js', label: '面板直答提示' },
];

test('提示不得要求「为当前页面标 [n]」——那是它没有的东西', () => {
  for (const { file, label } of DEMANDING) {
    const src = read(file);
    // 找出所有要求标 [n] 的句子，逐句检查有没有把「当前页面 / 页面」列进待引用来源。
    const demandLines = src
      .split('\n')
      .filter((l) => /\[n\]/.test(l))
      .filter((l) => /必须|都|须/.test(l));
    for (const line of demandLines) {
      assert.ok(
        !/知识库[、,]\s*当前页面|知识库[、,]\s*页面|依据页面[、,]\s*知识库/.test(line),
        label + ' 仍把「当前页面」列进待引用来源 —— 模型只能自造标签：\n' + line.trim()
      );
    }
  }
});

test('提示必须明说「当前页面不编号」，并禁止自造非数字标签', () => {
  // 注意：这里一律用 assert.ok(re.test(src), 短消息) —— 对大文件用 assert.match
  // 会在失败时把**整个文件**打进输出（实测刷了一整屏，反而不容易看出哪里错）。
  for (const { file, label } of DEMANDING) {
    const src = read(file);
    assert.ok(/当前页面不参与编号|页面内容属于当前上下文/.test(src), label + ' 应说明当前页面不编号');
    assert.ok(/\[页面\]/.test(src), label + ' 应点名禁止 [页面] 这类自造标签');
    assert.ok(/抽不出编号|没有数字/.test(src), label + ' 应说明为什么不能用非数字标签');
  }
});

test('知识库条目的 [n] 要求必须保留（那是真有编号的）', () => {
  const rag = read('lib/shared/rag.js');
  assert.ok(
    /引用具体条目时使用 \[n\]|\[n\] 格式标注来源编号/.test(rag),
    '知识库条目确实有编号，提示仍应要求标注'
  );
});

// ---------------------------------------------------------------- 渲染层：死文本不能装成可点引用

test('渲染层：非数字方括号不会变成可点击的引用徽章', () => {
  const src = read('lib/page/markdown.js');
  // renderAnswer 里的替换必须在 idx === null 时原样返回，否则 [页面] 会挂上
  // data-cite-* 变成"点了可能打开别的东西"的假引用。
  assert.ok(
    /const idx = extractCiteNum\(inner\);\s*\n\s*if \(idx === null\) return match;/.test(src),
    '非数字内容必须原样返回'
  );
});

test('渲染层：编号对不上来源时也原样返回（不许错配到别的来源）', () => {
  const src = read('lib/page/markdown.js');
  assert.ok(/if \(!c\) return match;/.test(src), '编号超出参考来源区时必须原样返回，不能错配');
});

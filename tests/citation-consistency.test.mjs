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

import { extractCiteNum, renumberCitations, renumberCitationsAcross } from '../lib/page/markdown.js';

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

// ---------------------------------------------------------------- 跨段一致（「参考来源还是不对」的根因）
//
// 一条助手消息往往由多段文字组成（若干 narration + 最终答复），而渲染时**每一段都按位置
// 对齐同一份 citations**（renderAnswer 用 citations[idx-1]）。原先只对「等于最终答复的
// 那一段」重编号，其余段落里的 [n] 仍是全局编号 —— 一旦压缩后的来源列表与全局编号不同，
// 那些 [n] 就指到错误的来源。症状就是：参考来源列的东西与正文说的不是一回事。

const CITES = [
  { index: 1, title: '源A（正文从未引用）' },
  { index: 2, title: '源B' },
  { index: 3, title: '源C' },
];

test('跨段重编号：两段文字必须映射到同一张表（旧实现只重编号其中一段）', () => {
  const narration = '先说 B：见 [2]。';
  const finalText = '结论：又是 B [2]，还有 C [3]。';
  const r = renumberCitationsAcross([narration, finalText], CITES);

  assert.equal(r.citations.length, 2, '只应列出被引用的两个来源');
  assert.deepEqual(r.citations.map((c) => c.title), ['源B', '源C']);
  // 按位置对齐：两段里的 [1] 都必须等于来源表第 1 条。
  assert.ok(r.apply(narration).includes('[1]'), r.apply(narration));
  assert.ok(r.apply(finalText).includes('[1]') && r.apply(finalText).includes('[2]'), r.apply(finalText));
  for (const text of [r.apply(narration), r.apply(finalText)]) {
    const nums = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    for (const n of nums) {
      assert.ok(n >= 1 && n <= r.citations.length, '编号 ' + n + ' 超出来源表范围：' + text);
    }
  }
});

test('回归：旧写法会让 narration 指错来源（这正是被报的 bug）', () => {
  const narration = '先说 B：见 [2]。';
  const finalText = '结论：又是 B [2]，还有 C [3]。';
  const old = renumberCitations(finalText, CITES); // 旧路径：只重编号最终答复
  // narration 没被重编号，仍是全局的 [2]；而渲染时按位置取 old.citations[2-1] —— 那是「源C」。
  assert.ok(narration.includes('[2]'), '前提：narration 保持全局编号');
  assert.equal(old.citations[1].title, '源C', '位置对齐后 narration 的 [2] 会指向 源C，而它想说的是 源B');
  // 新路径下不再有这种错位。
  const now = renumberCitationsAcross([narration, finalText], CITES);
  assert.ok(now.apply(narration).includes('[1]'), '重编号后 narration 的 [2] 应变成 [1]');
  assert.equal(now.citations[0].title, '源B', '位置 1 必须是 源B');
});

test('跨段重编号：首次出现顺序跨段累计（顺序决定编号）', () => {
  const r = renumberCitationsAcross(['先提 C [3]', '再提 B [2]'], CITES);
  assert.deepEqual(r.citations.map((c) => c.title), ['源C', '源B'], '按跨段首次出现顺序编号');
  assert.ok(r.apply('先提 C [3]').includes('[1]'));
  assert.ok(r.apply('再提 B [2]').includes('[2]'));
});

test('跨段重编号：无人引用时来源表为空，文本原样返回', () => {
  const r = renumberCitationsAcross(['没有任何引用', '[页面] 也不算'], CITES);
  assert.equal(r.citations.length, 0);
  assert.equal(r.apply('没有任何引用'), '没有任何引用');
  assert.equal(r.apply('[页面] 也不算'), '[页面] 也不算', '非数字标签不该被改写');
});

test('跨段重编号：不可解析的编号原样保留，不硬凑', () => {
  const r = renumberCitationsAcross(['存在 [9]，但来源表里没有'], CITES);
  assert.equal(r.citations.length, 0);
  assert.equal(r.apply('存在 [9]，但来源表里没有'), '存在 [9]，但来源表里没有');
});

test('跨段重编号：不改动传入的 citations（流式每 chunk 都会重编号，改动会破坏幂等）', () => {
  const input = CITES.map((c) => Object.assign({}, c));
  const before = JSON.stringify(input);
  const r = renumberCitationsAcross(['引 [2]'], input);
  assert.equal(JSON.stringify(input), before, '传入数组不得被改写');
  assert.notEqual(r.citations, input);
});

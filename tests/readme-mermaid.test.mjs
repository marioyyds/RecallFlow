// README 里 mermaid 图的结构门禁。
//
// 为什么需要：图写错时 GitHub 不会报错，而是**把整段 mermaid 源码当普通代码块显示出来** ——
// 读者看到的是几十行 DSL，而不是图。最常见也最容易犯的错就是加了 subgraph 或 alt
// 却忘了配对的 end。
//
// 这里只做无需依赖的结构检查。真正「能否渲染」已用本地 mermaid（v11）+ 无头 Chrome
// 实测过一轮（5/5 通过），但那需要临时安装 mermaid，不适合放进常规测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
const blocks = [...src.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);

const SUPPORTED_HEAD = /^(flowchart\s+(TB|TD|BT|LR|RL)|graph\s+(TB|TD|BT|LR|RL)|sequenceDiagram|stateDiagram-v2)$/;
// 会引入一个需要 end 收尾的块的关键字
const BLOCK_OPENERS = /^(subgraph|alt|opt|loop|par|rect|critical|break)\b/;

test('README 至少包含一个 mermaid 图', () => {
  assert.ok(blocks.length >= 1, 'README 里没有 mermaid 图');
});

test('每个 mermaid 块的首行是受支持的图类型', () => {
  blocks.forEach((b, i) => {
    // 首个非空且**非指令**的行才是图类型声明（%%{init}%% 等指令可以出现在最前面）
    const head =
      b
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('%%'))[0] || '';
    assert.match(head, SUPPORTED_HEAD, '第 ' + (i + 1) + ' 个图的首行不是受支持的图类型：' + head);
  });
});

test('需要 end 收尾的块都配平（subgraph / alt / opt / loop / par / rect / critical / break）', () => {
  blocks.forEach((b, i) => {
    const lines = b.split('\n').map((l) => l.trim());
    const openers = lines.filter((l) => BLOCK_OPENERS.test(l)).length;
    const enders = lines.filter((l) => l === 'end').length;
    assert.equal(
      openers,
      enders,
      '第 ' + (i + 1) + ' 个图有 ' + openers + ' 个需要 end 的块，但只有 ' + enders + ' 个 end —— ' +
        'GitHub 会因此把整段源码当普通代码块显示'
    );
  });
});

test('引号成对（标签里的引号不成对会让解析器提前结束）', () => {
  blocks.forEach((b, i) => {
    const quotes = (b.match(/"/g) || []).length;
    assert.equal(quotes % 2, 0, '第 ' + (i + 1) + ' 个图的引号数为奇数（' + quotes + '）');
  });
});

test('不含制表符与 CR（mermaid 对这两者敏感）', () => {
  blocks.forEach((b, i) => {
    assert.ok(!b.includes('\t'), '第 ' + (i + 1) + ' 个图含制表符');
    assert.ok(!b.includes('\r'), '第 ' + (i + 1) + ' 个图含 CR');
  });
});

test('%%{init}%% 指令里的 JSON 必须可解析（写错会让整张图渲染失败）', () => {
  const blocks = [...src.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  let seen = 0;
  blocks.forEach((b, i) => {
    const m = /^%%\{init:\s*([\s\S]*?)\}%%\s*$/m.exec(b);
    if (!m) return;
    seen += 1;
    assert.doesNotThrow(
      () => JSON.parse(m[1]),
      '第 ' + (i + 1) + ' 个图的 init 指令不是合法 JSON：' + m[1]
    );
  });
  assert.ok(seen >= 1, '没有任何图使用 init 指令，这条断言会变成恒真');
});

test('init 指令只调布局与排版，不写死配色', () => {
  // GitHub 会跟随用户主题（明/暗）渲染 mermaid。一旦写死 fill / stroke 之类的颜色，
  // 暗色主题下就会出现浅底浅字。这里把这条约定钉住。
  const blocks = [...src.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  const COLOR_KEYS = /"(fill|stroke|background|primaryColor|mainBkg|nodeBorder|lineColor|textColor|clusterBkg)"\s*:/;
  blocks.forEach((b, i) => {
    const m = /^%%\{init:\s*([\s\S]*?)\}%%\s*$/m.exec(b);
    if (!m) return;
    assert.ok(
      !COLOR_KEYS.test(m[1]),
      '第 ' + (i + 1) + ' 个图的 init 指令写死了配色，暗色主题下会不可读：' + m[1]
    );
  });
});

test('不使用 classDef / style 写死颜色（同上）', () => {
  const blocks = [...src.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  blocks.forEach((b, i) => {
    const bad = /(classDef\s+\w+[^\n]*\b(fill|stroke)\s*:\s*#|style\s+\w+\s+[^\n]*\b(fill|stroke)\s*:\s*#)/.exec(b);
    assert.equal(bad, null, '第 ' + (i + 1) + ' 个图写死了颜色：' + (bad && bad[0]));
  });
});

test('节点标签的括号在行内闭合（未闭合会截断节点定义）', () => {
  const blocks = [...src.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  blocks.forEach((b, i) => {
    for (const line of b.split('\n')) {
      const t = line.trim();
      if (!t || BLOCK_OPENERS.test(t) || t === 'end' || t.startsWith('%%')) continue;
      // 节点定义行应当在一行内闭合：左右括号数量一致
      const open = (t.match(/[\[\(\{]/g) || []).length;
      const close = (t.match(/[\]\)\}]/g) || []).length;
      assert.equal(open, close, '第 ' + (i + 1) + ' 个图里有未闭合的节点标签：' + t);
    }
  });
});

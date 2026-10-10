// 静态检查门禁：把「只能在运行时炸」的一类 bug 提前拦住。
//
// 起因是一个真实崩溃：agent.js 里 `const deterministicFails` 却在后面 `+= 1`，
// 于是「完成断言判定失败」这条分支一走到就抛 Assignment to constant variable，
// 整个 agent run 直接挂掉。要命的是：
//   - node --check 抓不到（语法完全合法）
//   - 400 项单测也抓不到（那条分支需要真实 agent 运行 + 特定失败场景）
// 也就是说，这类 bug 之前**没有任何一层能发现它**。这里补上那一层。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findConstAssignments } from '../scripts/check-const-assign.mjs';

test('不存在「对 const 声明重新赋值」的代码（运行时必崩且其他层抓不到）', () => {
  const { findings, scanned } = findConstAssignments();
  assert.ok(scanned > 20, '前置：应扫描到足够多的文件，实际 ' + scanned);
  const detail = findings.map((f) => f.file + ':' + f.line + '  ' + f.name + '（声明于第 ' + f.declLine + ' 行）').join('\n  ');
  assert.deepEqual(findings, [], '发现对 const 的赋值，运行时必抛 Assignment to constant variable：\n  ' + detail);
});

test('扫描范围覆盖根目录文件与 .mjs（原先只有 lib/ 与 .js，靠运气才抓到那个崩溃）', () => {
  // 原先 ROOTS=['lib','integrations/opencode/recallflow-mcp'] 且只收 .js：
  // background.js / popup.js 以及**所有 .mjs**（含门禁脚本自身）都是盲区。
  // 这里把「覆盖面」本身钉住 —— 否则将来有人把范围改回去，不会有人发现。
  const { files, scanned } = findConstAssignments();
  assert.ok(scanned > 100, '应扫描整个仓库（含根目录与 tests/scripts），实际 ' + scanned);
  for (const expected of ['background.js', 'popup.js']) {
    assert.ok(files.includes(expected), '根目录文件应被扫描：' + expected);
  }
  // content.js 现在是 scripts/build-content.mjs 的**构建产物**，源码在 entries/content.js。
  // 检查产物等于检查生成器，因此源码必须被扫描、产物必须被跳过（否则 3721 处假阳性）。
  assert.ok(files.includes('entries/content.js'), '内容脚本源码应被扫描');
  assert.ok(!files.includes('content.js'), '构建产物不应被扫描（会产生大量假阳性）');
  assert.ok(files.some((f) => f.endsWith('.mjs')), '应扫描 .mjs 文件（门禁脚本与测试都是 .mjs）');
  assert.ok(files.some((f) => f.startsWith('scripts/')), '应扫描 scripts/');
  assert.ok(!files.some((f) => f.includes('node_modules')), '不应扫描 node_modules');
});

test('解构声明被正确识别（否则会同时产生漏报与误报）', () => {
  // 实测：`let [sw]` 与另一作用域的 `const sw` 曾被合并成「const 被赋值」而误报。
  const dir = mkdtempSync(join(tmpdir(), 'rf-const-'));
  try {
    // 正例：const 被赋值 → 必须报出
    writeFileSync(join(dir, 'positive.mjs'), 'const x = 1;\nfunction f(){ x += 1; }\n');
    // 反例：let 同名 → 不报
    writeFileSync(join(dir, 'let-ok.js'), 'let y = 1;\ny = 2;\n');
    // 反例：解构 const 未被赋值 → 不报
    writeFileSync(join(dir, 'destructure-ok.js'), 'const { a } = o;\nconst [b] = arr;\nconsole.log(a, b);\n');
    const { findings } = findConstAssignments([dir]);
    assert.deepEqual(
      findings.map((f) => f.name),
      ['x'],
      '只应报出真正被赋值的 const，实际：' + JSON.stringify(findings.map((f) => f.name))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('正则字面量里出现 `名字=` 不能被当成对 const 的赋值（实测误报）', () => {
  // 起因：写测试时 `const id = …` 加上断言里的正则 `/id="([^"]+)"/` ——
  // 剥离器不识别正则字面量，于是 `id=` 被读成对 const id 的赋值。
  // 文件头当时给的规避办法是"别把局部变量命名为正则里出现的短名字"（把约束推给使用者）。
  const dir = mkdtempSync(join(tmpdir(), 'rf-const-re-'));
  try {
    // 反例①：声明在正则之前（赋值符在正则里）
    writeFileSync(join(dir, 're-before.mjs'), 'const id = 1;\nconst RE = /id="([^"]+)"/;\nconsole.log(id, RE);\n');
    // 反例②：正则前面是 return（关键字后可以跟正则）
    writeFileSync(
      join(dir, 're-after-return.mjs'),
      'const id = 2;\nfunction f(s){ return /id=(\\d+)/.test(s); }\nconsole.log(id, f);\n'
    );
    // 反例③：正则前是等号（`const re = /x=1/`）
    writeFileSync(join(dir, 're-after-eq.mjs'), 'const kv = 3;\nconst re2 = /kv=3/;\nconsole.log(kv, re2);\n');
    const { findings } = findConstAssignments([dir]);
    assert.deepEqual(
      findings.map((f) => f.name),
      [],
      '正则字面量里的 `名字=` 不该被当成赋值，实际误报：' + JSON.stringify(findings.map((f) => f.name))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('识别正则不能把除号误判成正则（否则会吃掉整行，造成假阴性）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-const-div-'));
  try {
    // 除号后面仍有真正的 const 赋值 —— 必须被抓到（若把 `/` 误判成正则，这一行会被整段吃掉）
    writeFileSync(
      join(dir, 'division.mjs'),
      'const total = 10 / 2;\nconst n = 1;\nfunction g(){ n = total / 5; }\n'
    );
    // 真正的赋值（普通情形）也必须照旧抓到
    writeFileSync(join(dir, 'plain.mjs'), 'const m = 0;\nm += 1;\n');
    const { findings } = findConstAssignments([dir]);
    assert.deepEqual(
      findings.map((f) => f.name).sort(),
      ['m', 'n'],
      '除号不该吃掉后面的代码，实际：' + JSON.stringify(findings.map((f) => f.name))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

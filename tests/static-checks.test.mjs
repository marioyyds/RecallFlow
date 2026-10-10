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

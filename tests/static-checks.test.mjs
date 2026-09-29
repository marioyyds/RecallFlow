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

import { findConstAssignments } from '../scripts/check-const-assign.mjs';

test('不存在「对 const 声明重新赋值」的代码（运行时必崩且其他层抓不到）', () => {
  const { findings, scanned } = findConstAssignments();
  assert.ok(scanned > 20, '前置：应扫描到足够多的文件，实际 ' + scanned);
  const detail = findings.map((f) => f.file + ':' + f.line + '  ' + f.name + '（声明于第 ' + f.declLine + ' 行）').join('\n  ');
  assert.deepEqual(findings, [], '发现对 const 的赋值，运行时必抛 Assignment to constant variable：\n  ' + detail);
});

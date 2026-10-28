// TS 迁移期：两道静态门禁对 .ts / 类型标注的兼容性自检。
//
// 动机（TITA-70 预研报告 §3）：迁移开始后，这两道门禁的失效形态**不是变红**，
// 而是**悄悄少覆盖甚至假阳性** ——
//   · check-const-assign：EXTENSIONS 不含 .ts ⇒ 改名后整段失去覆盖（静默，报告里唯一标红的 R1）；
//     声明正则不认 `:` ⇒ 带类型标注的 const 赋值 0/4 检出。
//   · check-prefix-stability：锚点正则不认类型标注 ⇒ 主循环「找不到」而报 R0，
//     计划函数失配又让合法的 splice 被判成 R3 越界。
// 这类失效的共同点是**没有任何一层会告诉你它失效了**，所以只能靠合成样本钉住。
//
// 每条用例都必须能在「改造前的实现」上变红 —— 本文件用**命名空间 import**，
// 这样在旧实现里（少了 pickTarget 等导出）是**用例失败**而不是模块链接崩溃
// （L-30：N=0 的崩溃不算门禁生效）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findConstAssignments } from '../scripts/check-const-assign.mjs';
import * as prefixGate from '../scripts/check-prefix-stability.mjs';

/** 建临时目录，跑完即删。 */
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rf-ts-gate-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const names = (findings) => findings.map((f) => f.name);

// ── check-const-assign ────────────────────────────────────────────────────────

test('.ts 文件必须进入「对 const 赋值」的扫描集（旧实现里 EXTENSIONS 没有 .ts，整段静默失效）', () => {
  withTmp((dir) => {
    // 纯 JS 语法即可 —— 这条只验「后缀有没有被纳入」，与下一条的正则无关。
    writeFileSync(join(dir, 'counter.ts'), 'const total = 1;\ntotal += 1;\n');
    const { findings, scanned } = findConstAssignments([dir]);
    assert.ok(scanned > 0, '前置：扫描集里应至少有那一个文件，实际 ' + scanned);
    assert.deepEqual(names(findings), ['total'], '改名成 .ts 后必须仍然被扫描，否则门禁静默失效');
  });
});

test('带类型标注的 const 赋值必须被抓到（旧正则 0/4 检出）', () => {
  withTmp((dir) => {
    writeFileSync(join(dir, 'a.js'), 'const total: number = 1;\ntotal += 1;\n');
    writeFileSync(join(dir, 'b.js'), 'const opts: Opts = {};\nopts = null;\n');
    writeFileSync(join(dir, 'c.js'), 'const arr: Array<Map<string, number>> = [];\narr = [];\n');
    writeFileSync(join(dir, 'd.js'), 'const fn: (a: string) => boolean = (a) => true;\nfn = null;\n');
    const { findings } = findConstAssignments([dir]);
    assert.deepEqual(
      names(findings).sort(),
      ['arr', 'fn', 'opts', 'total'],
      '4 个带类型标注的样本应全部检出，实际：' + JSON.stringify(names(findings))
    );
  });
});

test('干净 TS 语法不产生误报（迁移期不能因为加了类型就到处假阳性）', () => {
  withTmp((dir) => {
    writeFileSync(
      join(dir, 'clean.ts'),
      [
        'interface Row { a: number; b?: string }',
        'type Id = string | number;',
        'type Keys = keyof Row;',
        'type Nullable<T> = { [K in keyof T]?: T[K] };',
        'type Cond<T> = T extends string ? "s" : "n";',
        'abstract class Base { abstract go(): void; }',
        'const tpl = `x${1}` as const;',
        'const el = document.body!;',
        'function pick<T extends object>(x: T): T { return x satisfies T; }',
        'export { Row, Id, Keys, Nullable, Cond, Base, tpl, el, pick };',
      ].join('\n')
    );
    const { findings } = findConstAssignments([dir]);
    assert.deepEqual(names(findings), [], 'TS 语法不该被当成赋值，实际误报：' + JSON.stringify(names(findings)));
  });
});

// ── check-prefix-stability ────────────────────────────────────────────────────

// 一份「已迁移到 TS」的 agent 主循环：只加类型标注，行为与现状完全一致
// （计划消息一次性注入 + 循环内只 append）。它必须**通过**检查。
const TYPED_AGENT = [
  'async function run(): Promise<void> {',
  '  let messages: Array<{ role: string; content?: string }> = [];',
  '  const injectPlanMessage: () => void = () => { messages.splice(1, 0, { role: "system" }); };',
  '  injectPlanMessage();',
  '  for (let iter: number = resumeIteration; iter < effectiveModelTurns; iter++) {',
  '    messages.push({ role: "assistant", content: "legit append" });',
  '  }',
  '}',
  '',
].join('\n');

test('加了类型标注的主循环与计划函数必须仍能通过（旧正则会报 R0「未找到主循环」）', () => {
  withTmp((dir) => {
    const file = join(dir, 'agent.ts');
    writeFileSync(file, TYPED_AGENT);
    const { findings } = prefixGate.findPrefixMutations(file);
    const detail = findings.map((f) => f.line + ' [' + f.rule + '] ' + f.text).join('\n  ');
    assert.deepEqual(findings, [], '类型标注不该让这道门禁失效或误报：\n  ' + detail);
  });
});

test('循环内 splice / 循环内再次注入计划，加了类型标注也必须照样被抓（门禁仍有牙齿）', () => {
  withTmp((dir) => {
    const file = join(dir, 'agent.ts');
    writeFileSync(
      file,
      [
        'async function run(): Promise<void> {',
        '  let messages: Array<{ role: string }> = [];',
        '  const injectPlanMessage: () => void = () => { messages.splice(1, 0, { role: "system" }); };',
        '  injectPlanMessage();',
        '  for (let iter: number = resumeIteration; iter < 3; iter++) {',
        '    messages.splice(1, 0, { role: "system", content: "plan" });',
        '    injectPlanMessage();',
        '    messages[0] = { role: "system" };',
        '  }',
        '}',
        '',
      ].join('\n')
    );
    const { findings } = prefixGate.findPrefixMutations(file);
    const rules = new Set(findings.map((f) => f.rule));
    for (const rule of ['R1', 'R3', 'R4']) {
      assert.ok(rules.has(rule), '规则 ' + rule + ' 未命中；实际命中：' + [...rules].join(','));
    }
  });
});

test('TARGET 按存在性二选一：.ts 优先，都不在时回落到 .js（改名后不至于直接 ENOENT）', () => {
  assert.equal(typeof prefixGate.pickTarget, 'function', '缺少 pickTarget 导出（旧实现会在这里失败）');
  const candidates = prefixGate.TARGET_CANDIDATES;
  assert.deepEqual(candidates, ['lib/application/agent/agent.ts', 'lib/application/agent/agent.js']);
  assert.equal(
    prefixGate.pickTarget((f) => f.endsWith('.ts')),
    'lib/application/agent/agent.ts',
    '改名后应自动选中 .ts'
  );
  assert.equal(
    prefixGate.pickTarget((f) => f === 'lib/application/agent/agent.js'),
    'lib/application/agent/agent.js',
    '只有 .js 时选中 .js'
  );
  assert.equal(
    prefixGate.pickTarget(() => false),
    'lib/application/agent/agent.js',
    '两个都不在时回落，且回落后仍指向真实文件名（随后会由 R0 报「目标文件不存在」）'
  );
});

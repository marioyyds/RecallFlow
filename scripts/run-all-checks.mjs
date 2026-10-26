// 统一测试入口：把「单测 + 三道静态门禁」串成一条命令。
//
// 为什么需要它：仓库里最强的三样东西（变异测试、前缀稳定性门禁、const 赋值门禁）
// 此前**没有任何入口能一起跑**——mutation-check.mjs 连 npm script 都没有，
// 于是它处于「写好了但永远不会被运行」的状态，而实测它确实已经静默失效
// （锚点因 CRLF 与重构失配，却没人发现）。
// 门禁只要不被强制运行，就等于不存在。
//
// 用法：node scripts/run-all-checks.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STEPS = [
  {
    name: '单元测试（含 MCP）',
    cmd: process.execPath,
    // `--import ./scripts/ts-resolve-reg.mjs`：TS 迁移期挂上 resolve hook，
    // 让 importer 里仍写 `.js` 的 specifier 能解析到已改名的 `.ts`（详见该文件头注释）。
    // 没有它，「A 把文件改成 .ts、B 还没改 import 后缀」的中间态会直接
    // ERR_MODULE_NOT_FOUND —— 而那正是两个 Dev 并行迁移时的常态。
    // 放在 `--test` 前面：node --test 会为每个测试文件起子进程，
    // 实测 execArgv（含 --import）会传下去（2026-10-26 用临时样本验证过）。
    // ⚠ 迁移期脚手架：Batch 5 收口（全部 specifier 改成真实后缀）时连同
    //   scripts/ts-resolve.mjs / ts-resolve-reg.mjs 一起删掉这一项。
    args: [
      '--import',
      './scripts/ts-resolve-reg.mjs',
      '--test',
      'tests/*.test.mjs',
      'integrations/opencode/recallflow-mcp/test/*.test.mjs',
    ],
  },
  // ▼ `tsc --noEmit` 门禁**刻意不在这里**：当前仓库 0 个 .ts 文件，纳入就是一条
  // 永远为绿的假闸（门禁不运行等于不存在，运行了却永远绿更坏 —— 会让人以为有网接着）。
  // 纳入门禁的时点：Batch 1 首批 .ts 落地的**同一提交**，且必须先在坏样本上证明它会红。
  // 到时在这里补：{ name: '门禁：TypeScript 类型检查', cmd: process.execPath,
  //                 args: ['node_modules/typescript/bin/tsc', '--noEmit'] }
  { name: '门禁：对 const 赋值', cmd: process.execPath, args: ['scripts/check-const-assign.mjs'] },
  { name: '门禁：请求前缀稳定性', cmd: process.execPath, args: ['scripts/check-prefix-stability.mjs'] },
  { name: '门禁：变异测试（断言是否真有牙齿）', cmd: process.execPath, args: ['scripts/mutation-check.mjs'] },
  // 刷新测试数快照：必须放在单元测试**之后**，因为刚加/删的用例会改变总数。
  // 这样「文档里的数字」永远由实测产出，而不是靠人记得改。
  { name: '刷新测试数快照（写 tests/.test-count.json）', cmd: process.execPath, args: ['scripts/test-count.mjs', '--write'] },
];

const results = [];
for (const step of STEPS) {
  process.stdout.write('\n=== ' + step.name + ' ===\n');
  // node --test 的 glob 需要由 shell 展开，但这里用 spawnSync 不经过 shell，
  // 因此把 glob 作为字面量传给 node（Node 22+ 的 --test 自带 glob 展开）。
  const r = spawnSync(step.cmd, step.args, { cwd: ROOT, stdio: 'inherit' });
  const ok = r.status === 0;
  results.push({ name: step.name, ok, status: r.status });
}

console.log('\n================ 汇总 ================');
for (const r of results) {
  console.log((r.ok ? '  ✔ ' : '  ✘ ') + r.name + (r.ok ? '' : '  (exit=' + r.status + ')'));
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? '\n' + failed.length + ' 项未通过' : '\n全部通过');
process.exit(failed.length ? 1 : 0);

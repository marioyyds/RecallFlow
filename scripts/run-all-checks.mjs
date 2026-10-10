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
    args: ['--test', 'tests/*.test.mjs', 'integrations/opencode/recallflow-mcp/test/*.test.mjs'],
  },
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

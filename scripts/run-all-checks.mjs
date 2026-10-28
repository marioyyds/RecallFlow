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
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 跑前/跑后行尾快照的落点：放系统临时目录，不污染仓库（也不受 .gitignore 影响）。
const EOL_SNAPSHOT = path.join(os.tmpdir(), 'rf-worktree-eol-run.json');

const STEPS = [
  // 工作树行尾基线：**必须第一步**。它把「跑之前就脏的检出」记下来，最后一步再比一次，
  // 只报新增项 —— 否则 CRLF 检出的整文件差异会被算到门禁头上（TITA-90 的误归因）。
  { name: '门禁：工作树行尾基线（跑前快照）', cmd: process.execPath, args: ['scripts/check-worktree-eol.mjs', '--snapshot', EOL_SNAPSHOT] },
  {
    name: '单元测试（含 MCP）',
    cmd: process.execPath,
    // Batch 6 收口后全仓 specifier 都是真实后缀（`.ts` / `.mjs`），Node 直接解析即可，
    // 不再需要迁移期的 `--import ./scripts/ts-resolve-reg.mjs` resolve hook。
    args: [
      '--test',
      'tests/*.test.mjs',
      'integrations/opencode/recallflow-mcp/test/*.test.mjs',
    ],
  },
  // `tsc --noEmit`：Batch 1a（TITA-74）首批 .ts 落地时，与它们**同一提交**进 STEPS。
  // 在此之前它是一条永远为绿的假闸，故刻意不挂；现在 include 里已有 12 个 .ts。
  // 进 STEPS 前已在坏样本上验证过它会红（见 TITA-74 交付评论 §5）。
  { name: '门禁：TypeScript 类型检查', cmd: process.execPath, args: ['node_modules/typescript/bin/tsc', '--noEmit'] },
  { name: '门禁：对 const 赋值', cmd: process.execPath, args: ['scripts/check-const-assign.mjs'] },
  // TS 迁移期间 `.js` → `.ts` 是逐个改名的：同名双存会让 tests/source-path.mjs
  // 静默读到旧副本（判据与背景见该脚本头注释，TITA-78 返工 N1）。
  { name: '门禁：迁移目录同名 .js/.ts 双存', cmd: process.execPath, args: ['scripts/check-ts-duplicates.mjs'] },
  { name: '门禁：请求前缀稳定性', cmd: process.execPath, args: ['scripts/check-prefix-stability.mjs'] },
  { name: '门禁：变异测试（断言是否真有牙齿）', cmd: process.execPath, args: ['scripts/mutation-check.mjs'] },
  // 刷新测试数快照：必须放在单元测试**之后**，因为刚加/删的用例会改变总数。
  // 这样「文档里的数字」永远由实测产出，而不是靠人记得改。
  { name: '刷新测试数快照（写 tests/.test-count.json）', cmd: process.execPath, args: ['scripts/test-count.mjs', '--write'] },
  // 工作树行尾复核：跑完必须**没有新增**行尾差异 / 新增改动。
  // 这条替代了「靠人记得跑前跑后各看一眼 git status」的旧做法（TITA-90 必修项）。
  { name: '门禁：工作树行尾复核（跑完不许改脏）', cmd: process.execPath, args: ['scripts/check-worktree-eol.mjs', '--compare', EOL_SNAPSHOT] },
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

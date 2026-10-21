// eval 结果的基线对比。
//
// 为什么需要它：真模型 eval 不进 CI、结果非确定，唯一长期价值是**趋势**。
// 但此前结果只存在于人工维护的 markdown 里，没法自动比 ——
// "这次改技能文案把某条判据改坏了"只能靠人翻表发现。
//
// 用法：
//   node scripts/eval-compare.mjs                       # 把最新结果存为基线
//   node scripts/eval-compare.mjs --check               # 与基线对比，出现回归则退出码 1
//
// ⚠ 判「回归」的口径刻意保守：
//   · 只有**上一轮通过、这一轮失败**才算回归；
//   · 上一轮就失败的用例不计入（真模型 eval 本来就有噪声，把历史失败再报一次只会淹没信号）；
//   · 新增/删除的用例只提示，不算回归。
// 这样它才可能真的被用起来 —— 一个每次都红的门禁会被第一时间删掉。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LATEST = path.join(ROOT, 'test-results', 'eval-results.json');
const BASELINE = path.join(ROOT, 'test-results', 'eval-baseline.json');

const argv = process.argv.slice(2);
const check = argv.includes('--check');

/** 从 Playwright 的 json reporter 输出里抽出「用例标题 -> 是否通过」的扁平表。 */
export function flatten(report) {
  const out = new Map();
  // ⚠ 子节点必须用**拼接后的** title 作为前缀，不能用上一层传进来的 prefix ——
  // 第一版就是写错了这个，结果所有 key 都丢掉套件前缀，
  // 不同文件里同名用例会互相覆盖（表现为"用例数变少了"）。
  const walk = (node, prefix) => {
    const title = prefix ? prefix + ' > ' + node.title : String(node.title || '');
    for (const child of node.suites || []) walk(child, title);
    for (const spec of node.specs || []) {
      const name = title ? title + ' > ' + spec.title : String(spec.title || '');
      const tests = spec.tests || [];
      // 判"通过"的三个条件缺一不可：有测试结果、每个结果都 passed、且没被跳过。
      // 少了"有结果"这条，一条**根本没跑**的用例会被记成绿 —— 那正是最危险的假信号。
      const ok =
        tests.length > 0 &&
        tests.every((t) => t.status !== 'skipped' && (t.results || []).length > 0 && (t.results || []).every((r) => r.status === 'passed'));
      out.set(name, ok);
    }
  };
  for (const s of report.suites || []) walk(s, '');
  return out;
}

// 只在被直接执行时跑 CLI 部分 —— 否则 `flatten` 被测试 import 时会因为
// "找不到结果文件"直接 process.exit(2)，测试进程一起死掉。
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isCli) {
  // 作为模块被 import：只导出 flatten，不做任何 I/O。
} else if (!fs.existsSync(LATEST)) {
  console.error('找不到最新结果 ' + path.relative(ROOT, LATEST) + '。请先跑一次 eval（node scripts/eval-real-model.mjs）。');
  process.exit(2);
} else {
  runCli();
}

function runCli() {

const latest = flatten(JSON.parse(fs.readFileSync(LATEST, 'utf8')));

if (!check) {
  fs.writeFileSync(BASELINE, JSON.stringify({ savedAt: new Date().toISOString(), cases: [...latest] }, null, 2));
  console.log('已存为基线（' + latest.size + ' 条）：' + path.relative(ROOT, BASELINE));
  for (const [name, ok] of latest) console.log('  ' + (ok ? '✓' : '✗') + ' ' + name);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error('没有基线。先跑 node scripts/eval-compare.mjs 存一份。');
  process.exit(2);
}

const base = new Map(JSON.parse(fs.readFileSync(BASELINE, 'utf8')).cases);
const regressions = [];
const recoveries = [];
const added = [];
const removed = [];

for (const [name, ok] of latest) {
  if (!base.has(name)) {
    added.push(name);
    continue;
  }
  if (base.get(name) === true && ok === false) regressions.push(name);
  if (base.get(name) === false && ok === true) recoveries.push(name);
}
for (const name of base.keys()) if (!latest.has(name)) removed.push(name);

console.log('基线 ' + base.size + ' 条 / 本轮 ' + latest.size + ' 条');
console.log('回归（上轮过、这轮挂）: ' + (regressions.length ? '\n  ✗ ' + regressions.join('\n  ✗ ') : '无'));
if (recoveries.length) console.log('恢复（上轮挂、这轮过）: \n  ✓ ' + recoveries.join('\n  ✓ '));
if (added.length) console.log('新增用例: ' + added.length + ' 条（不计入回归）');
if (removed.length) console.log('移除用例: ' + removed.length + ' 条（不计入回归）');

process.exit(regressions.length ? 1 : 0);
}

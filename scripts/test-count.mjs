// 「测试数量」的唯一事实来源：生成 + 校验，取代散落在文档里的手写数字。
//
// 背景（本仓库反复出现的问题）：同一个数字在三份文档里各不相同，且**三个都不对**：
//   README.md 写 562 项；docs/agent-engineering-review.md 写 382 项 / 23 个文件；
//   docs/recallflow-dsh-keypoints.md 写 526→533 项。
// 手写数字必然腐烂，而且读者无法判断该信哪个。
//
// 设计（踩过的坑）：**不要**让单测去调用「跑一遍全部测试」来取数 ——
// 那是自我引用：测试进程里再 spawn 一次整套测试，输出会被嵌套/截断，
// 解析结果是 null（实测）。因此拆成两步：
//   ① `--write`：跑一遍测试，把结果写进 tests/.test-count.json（由 run-all-checks 调用）
//   ② 单测只读那个快照并与 README 比对，不 spawn 任何东西
//
// 用法：
//   node scripts/test-count.mjs           # 打印当前实测
//   node scripts/test-count.mjs --write    # 实测并写入快照
//   node scripts/test-count.mjs --json     # 机器可读
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = path.join(ROOT, 'tests', '.test-count.json');

const GLOBS = ['tests/*.test.mjs', 'integrations/opencode/recallflow-mcp/test/*.test.mjs'];

/** 数测试文件个数（spawnSync 不做 glob 展开，因此自己在 node 侧数）。 */
function countTestFiles() {
  const files = [];
  for (const pattern of GLOBS) {
    const dir = path.join(ROOT, path.dirname(pattern));
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.test.mjs')) files.push(f);
    }
  }
  return files.length;
}

/** 运行测试并解析 node:test 的汇总行。仅在 --write / 默认模式调用。 */
export function collectTestCount() {
  const r = spawnSync(process.execPath, ['--test', ...GLOBS], { cwd: ROOT, encoding: 'utf8' });
  const out = String(r.stdout || '') + String(r.stderr || '');
  // 汇总行格式随 node 版本与 reporter 而变：
  //   spec reporter（默认）：`ℹ tests 807`  / tap reporter：`# tests 807`
  const pick = (key) => {
    const m = new RegExp('^[\\s\\u2139#]*' + key + '\\s+(\\d+)\\s*$', 'm').exec(out);
    return m ? Number(m[1]) : null;
  };
  const tests = pick('tests');
  if (tests === null) {
    process.stderr.write('[test-count] 未能解析测试汇总行（node 版本或 reporter 输出格式变了）。\n');
  }
  return { tests, pass: pick('pass'), fail: pick('fail'), files: countTestFiles() };
}

/**
 * 把测试文件分成「行为测试」与「静态门禁」两类。
 *
 * 为什么必须分：评审实测 136 个测试文件里有 69 个（51%）用 readFileSync 读源码做正则，
 * 其中 32 个**完全不 import 任何 lib 模块**。它们确实抓到过"静默失效"（有价值），
 * 但把它们与真跑代码的行为测试混成一个总数，"1670 项"会给一种它给不了的信心 ——
 * 一个读源码的正则断言和一个真并发执行的集成断言，在这一个数字里是等权的。
 *
 * 判定口径（刻意保守，宁可少算静态也不要冤枉行为测试）：
 *   静态 = 读了源码 **且** 没有 import 任何 lib/入口模块；
 *   其余一律算行为测试。
 */
export function classifyTestFiles() {
  const dirs = [
    path.join(ROOT, 'tests'),
    path.join(ROOT, 'integrations', 'opencode', 'recallflow-mcp', 'test'),
  ];
  const importsProduct = /['"`][^'"`]*\.\.\/(lib|background\.js|content\.js|popup\.js|options\.js|manager\.js)/;
  const staticFiles = [];
  const behaviorFiles = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.test.mjs')) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const readsSource = /readFileSync/.test(src);
      if (readsSource && !importsProduct.test(src)) staticFiles.push(f);
      else behaviorFiles.push(f);
    }
  }
  return { behavior: behaviorFiles.length, static: staticFiles.length, staticFiles };
}

/** 读取已提交的快照（单测用；不 spawn 任何进程）。 */
export function readSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  } catch (e) {
    return null;
  }
}

function main() {
  if (process.argv.includes('--write')) {
    const info = collectTestCount();
    const kinds = classifyTestFiles();
    const payload = Object.assign({}, info, {
      files: { total: kinds.behavior + kinds.static, behavior: kinds.behavior, static: kinds.static },
    });
    fs.writeFileSync(SNAPSHOT, JSON.stringify(payload, null, 2) + '\n');
    console.log(
      '已写入 ' + path.relative(ROOT, SNAPSHOT) + '：' + info.tests + ' 项 / ' +
        payload.files.total + ' 个文件（行为 ' + kinds.behavior + ' + 静态门禁 ' + kinds.static + '）'
    );
    return;
  }
  const info = collectTestCount();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(info, null, 2) + '\n');
    return;
  }
  console.log('测试用例：' + info.tests + '（通过 ' + info.pass + '，失败 ' + info.fail + '）');
  console.log('测试文件：' + info.files);
  console.log('\n提示：文档中的测试数量应引用本脚本输出，不要手写 —— 手写数字必然腐烂。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}

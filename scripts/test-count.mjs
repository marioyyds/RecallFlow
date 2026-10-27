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

/**
 * 同两个目录里**任何测试后缀**（.test.mjs / .test.ts / .test.mts …）的文件数。
 *
 * 存在的唯一理由是给 `files.total` 当对照：TS 迁移期一旦有人把测试文件改成 `.test.ts`，
 * 上面的 `countTestFiles()`（只认 `.test.mjs`）会**少算一个**，而所有棘轮都是「只许减不许增」，
 * 于是门禁变弱却不吭声（预研报告 §3.4 的 R2）。两个数字对不上就说明有文件从统计里消失了。
 */
export function countTestFilesAnyExt() {
  const files = [];
  for (const pattern of GLOBS) {
    const dir = path.join(ROOT, path.dirname(pattern));
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/\.test\.[cm]?[jt]s$/.test(f)) files.push(f);
    }
  }
  return files.length;
}

/** 运行测试并解析 node:test 的汇总行。仅在 --write / 默认模式调用。 */
export function collectTestCount() {
  // ⚠ 迁移期必须带上 TS resolve hook，口径与 run-all-checks.mjs 完全一致：
  // importer 里仍写 `.js` 的 specifier 要能解析到已改名的 `.ts`。
  // Batch 1b（TITA-75）之后 lib/page 的 chat / commands / picker 与 entries/content 都已是 `.ts`，
  // 但仍有 `lib/shared/*`、`lib/assistant/*` 等存量 `.js` 被 `.ts` 侧引用，hook 继续需要。
  // 少了 `--import`，这 68 条依赖 chat.js 的用例会 ERR_MODULE_NOT_FOUND —— 那是**环境性**失败，
  // 却会被当成真实失败写进快照（TITA-74 实测：tests 1929 / pass 1861 / fail 68）。
  // Batch 5 收口（全部 specifier 改真实后缀 + 删掉 ts-resolve*）时，连同这里一起清掉。
  const r = spawnSync(
    process.execPath,
    ['--import', './scripts/ts-resolve-reg.mjs', '--test', ...GLOBS],
    { cwd: ROOT, encoding: 'utf8' }
  );
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
    // 自检（L-22 口径）：files.total 必须等于实际测试文件数，且不许有文件「换了个后缀就消失」。
    // 这里的两个数字来自**两套独立枚举**（只认 .test.mjs 的 / 任何测试后缀的），
    // 对不上就拒绝写快照 —— 否则一个改名的测试文件会让棘轮静默变松。
    const anyExt = countTestFilesAnyExt();
    if (payload.files.total !== anyExt) {
      process.stderr.write(
        '[test-count] files.total（' + payload.files.total + '）与实际测试文件数（' + anyExt +
          '）不一致：有文件不在统计口径内（多半是被改成了 .test.ts 之类的其他后缀）。\n' +
          '  修法：把它的后缀纳入 scripts/test-count.mjs 的枚举，而不是忽略这个报错。\n'
      );
      process.exit(1);
    }
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

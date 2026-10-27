// 覆盖率基线：把 node --test 的覆盖率表解析成**机器可读**的 JSON。
//
// ⚠⚠ 一个必须先说清楚的测量陷阱（**不要拿这份数字当精确覆盖率看**）：
//   node --test --experimental-test-coverage 在"多个测试文件加载同一模块"时，
//   跨进程的覆盖率合并**行为不可靠**，实测到的现象互相矛盾：
//     · 两文件串行：cdp-behavior 单跑 58.41% / cdp-timeout 单跑 44.09%；
//       `--test-concurrency=1 behavior timeout` ⇒ 44.09%；**反序 ⇒ 58.41%**
//       ⇒ 表现为 last-writer-wins（不是并集）；
//     · 全量并发：同一条命令两次跑能跑出两个数；
//     · 但 assistant/agent.js 全量报 41.76%，而"逐文件取最大值"只有 27.26%
//       ⇒ 又不符合 last-wins（否则全量值应等于某个单文件值）。
//   结论：这三个数字**没有一个是可信的真值**。
//
// 因此这里的定位是**趋势与体检**，不是精确度量：
//   · 最可靠的信号是"哪些模块**完全没被加载**"（显示为 null，如 page/chat.js）——
//     这个不受合并行为影响，是真零；
//   · `--focus <file>` 逐个跑引用该模块的测试文件并取最大值，给出的是**保守下界**；
//   · 不要拿这些数字去写"覆盖率从 X 提升到了 Y"。
//
// 为什么需要它：仓库此前完全没有覆盖率采集，于是"哪些代码没人测"只能靠 grep 猜。
// 有了这份 JSON，"这轮补测到底提升没有"才是一个可以回答的问题，而不是一句感觉。
//
// 用法：
//   node scripts/coverage-baseline.mjs                 # 全量，写 test-results/coverage-summary.json
//   node scripts/coverage-baseline.mjs --focus lib/backend/cdp.ts
//   node scripts/coverage-baseline.mjs --print           # 只打印高风险模块，不写文件
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'test-results');
const OUT_FILE = path.join(OUT_DIR, 'coverage-summary.json');

const argv = process.argv.slice(2);
const printOnly = argv.includes('--print');
const focusIdx = argv.indexOf('--focus');
const focus = focusIdx >= 0 ? argv[focusIdx + 1] : null;

// 覆盖率表的行形如：  #   agent.js    |  42.16 |   61.40 |    6.54 | 1-2 5-9
// 目录行形如：        #  assistant
const ROW = /^\s*#\s+([A-Za-z0-9_.-]+\.js)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|?/;

function run(files) {
  const r = spawnSync(
    process.execPath,
    // ⚠ 不能加 --test-reporter=dot：实测 dot reporter 下 node **不打印覆盖率表**
    // （覆盖率表只在默认 reporter 下输出）。曾因此解析出 0 个文件还"成功"写了基线 JSON ——
    // 所以下面对空结果显式报错，不允许静默产出一份空基线。
    ['--test', '--experimental-test-coverage', ...(files || ['tests/*.test.mjs'])],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return (r.stdout || '') + (r.stderr || '');
}

/** 找出引用了某个模块（按路径片段匹配）的测试文件。 */
export function testFilesReferencing(fragment) {
  const dir = path.join(ROOT, 'tests');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs'))
    .filter((f) => readFileSync(path.join(dir, f), 'utf8').includes(fragment))
    .map((f) => 'tests/' + f);
}

/**
 * 逐文件跑、按模块取**最大值**，逼近真实并集。
 * 见文件头的陷阱说明：一次性跑全部文件时，同一模块的覆盖率会被最后跑完的那个文件覆盖。
 */
export function collectFocused(files) {
  const best = new Map();
  for (const f of files) {
    for (const row of parseRows(run([f]))) {
      const prev = best.get(row.file);
      if (!prev || row.lines > prev.lines) best.set(row.file, row);
    }
  }
  return [...best.values()].sort((a, b) => a.lines - b.lines);
}

const rows = [];
let currentDir = '';
function parseRows(output) {
  const out = [];
  let dir = '';
  for (const line of output.split('\n')) {
    const dirMatch = line.match(/^\s*#\s+([A-Za-z0-9_.-]+)\s*(?:\|\s*(?:\|\s*)*)?$/);
    if (dirMatch && !dirMatch[1].endsWith('.js')) {
      dir = dirMatch[1] === 'tests' ? '' : dirMatch[1];
      continue;
    }
    const m = line.match(ROW);
    if (!m) continue;
    const [, file, lines, branch, funcs] = m;
    if (dir === 'tests') continue;
    out.push({
      file: dir ? dir + '/' + file : file,
      lines: Number(lines),
      branch: Number(branch),
      funcs: Number(funcs),
    });
  }
  return out;
}
rows.push(...parseRows(run()));

if (!rows.length) {
  // 空基线比没有基线更危险：它会让"覆盖率在涨"变成一个永远无法证伪的错觉。
  console.error('覆盖率表解析出 0 行 —— 不写基线文件。请检查 node 的覆盖率输出格式是否变了。');
  process.exit(1);
}

const libRows = rows
  .filter((r) => !r.file.startsWith('node_modules'))
  .sort((a, b) => a.lines - b.lines);

// 高风险模块：评审里点名的、以及任何覆盖率低于 30% 的 lib 文件。
const HIGH_RISK = [
  'page/chat.js',
  'page/commands.js',
  'backend/cdp.ts',
  'assistant/agent.ts',
  'assistant/skill-defs.ts',
  'assistant/tools.ts',
  'shared/utils.js',
];

const report = {
  generatedAt: new Date().toISOString(),
  total: libRows.length,
  averageLines: libRows.length
    ? Number((libRows.reduce((s, r) => s + r.lines, 0) / libRows.length).toFixed(2))
    : 0,
  below30: libRows.filter((r) => r.lines < 30).map((r) => r.file),
  highRisk: HIGH_RISK.map((f) => {
    const hit = libRows.find((r) => r.file.endsWith(f));
    return { file: f, lines: hit ? hit.lines : null, branch: hit ? hit.branch : null };
  }),
  all: libRows,
};

if (printOnly) {
  console.log('平均行覆盖率: ' + report.averageLines + '%  （' + report.total + ' 个文件）');
  console.log('⚠ 这是**下界采样**（node 在同一模块被多个测试文件加载时不是取并集，见文件头）；');
  console.log('  要看某个模块的真实覆盖，用 --focus <file>。\n');
  console.log('高风险模块:');
  for (const h of report.highRisk) {
    console.log('  ' + (h.lines === null ? '未出现在覆盖率报告中（意味着零覆盖）' : h.lines + '%').padEnd(28) + h.file);
  }
  console.log('\n覆盖率 < 30% 的文件（' + report.below30.length + ' 个）:');
  for (const f of report.below30.slice(0, 25)) console.log('  ' + f);
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
  console.log('已写入 ' + path.relative(ROOT, OUT_FILE));
  console.log('平均行覆盖率 ' + report.averageLines + '% / ' + report.total + ' 个文件');
  if (focus) {
    // 逐文件跑并取最大值：一次性跑全部时同一模块会被最后跑完的文件覆盖（见文件头）。
    const files = testFilesReferencing(focus);
    console.log('\n--focus ' + focus + '：引用它的测试文件 ' + files.length + ' 个');
    if (!files.length) {
      console.log('零覆盖：没有任何测试文件引用它');
    } else {
      const best = collectFocused(files);
      const hit = best.find((r) => r.file.endsWith(focus));
      console.log(
        focus + ': ' + (hit ? hit.lines + '% 行 / ' + hit.branch + '% 分支（逐个文件取最大值）' : '零覆盖（未出现在报告中）')
      );
    }
  }
  console.log('高风险模块:');
  for (const h of report.highRisk) console.log('  ' + String(h.lines ?? 'null').padStart(6) + '%  ' + h.file);
}

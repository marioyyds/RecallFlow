// 覆盖率基线：把 node --test 的覆盖率表解析成**机器可读**的 JSON。
//
// 为什么需要它：仓库此前完全没有覆盖率采集，于是"哪些代码没人测"只能靠 grep 猜。
// 有了这份 JSON，"这轮补测到底提升没有"才是一个可以回答的问题，而不是一句感觉。
//
// 用法：
//   node scripts/coverage-baseline.mjs                 # 全量，写 test-results/coverage-summary.json
//   node scripts/coverage-baseline.mjs --focus lib/backend/cdp.js
//   node scripts/coverage-baseline.mjs --print           # 只打印高风险模块，不写文件
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
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

function run() {
  const r = spawnSync(
    process.execPath,
    // ⚠ 不能加 --test-reporter=dot：实测 dot reporter 下 node **不打印覆盖率表**
    // （覆盖率表只在默认 reporter 下输出）。曾因此解析出 0 个文件还"成功"写了基线 JSON ——
    // 所以下面对空结果显式报错，不允许静默产出一份空基线。
    ['--test', '--experimental-test-coverage', 'tests/*.test.mjs'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return (r.stdout || '') + (r.stderr || '');
}

const rows = [];
let currentDir = '';
for (const line of run().split('\n')) {
  // 目录行有两种形态：`#  assistant`（无管道）与 `#  assistant  |   |   |  `（带空管道）。
  // 必须两种都认 —— 只认第一种时目录名永远解析不出来，于是所有文件都被记成裸文件名，
  // 高风险模块匹配（assistant/agent.js）全部落空，报告会**假装**它们不存在。
  const dirMatch = line.match(/^\s*#\s+([A-Za-z0-9_.-]+)\s*(?:\|\s*(?:\|\s*)*)?$/);
  if (dirMatch && !dirMatch[1].endsWith('.js')) {
    currentDir = dirMatch[1] === 'tests' ? '' : dirMatch[1];
    continue;
  }
  const m = line.match(ROW);
  if (!m) continue;
  const [, file, lines, branch, funcs] = m;
  // 跳过测试自身与第三方
  if (currentDir === 'tests') continue;
  rows.push({
    file: currentDir ? currentDir + '/' + file : file,
    lines: Number(lines),
    branch: Number(branch),
    funcs: Number(funcs),
  });
}

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
  'backend/cdp.js',
  'assistant/agent.js',
  'assistant/skill-defs.js',
  'assistant/tools.js',
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
  console.log('平均行覆盖率: ' + report.averageLines + '%  （' + report.total + ' 个文件）\n');
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
    const hit = libRows.find((r) => r.file.endsWith(focus));
    console.log(focus + ': ' + (hit ? hit.lines + '% 行 / ' + hit.branch + '% 分支' : '零覆盖（未出现在报告中）'));
  }
  console.log('高风险模块:');
  for (const h of report.highRisk) console.log('  ' + String(h.lines ?? 'null').padStart(6) + '%  ' + h.file);
}

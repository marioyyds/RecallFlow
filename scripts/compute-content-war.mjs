// 计算 content.js 的**传递**模块闭包，用于收窄 manifest 的 web_accessible_resources。
//
// 背景：manifest 目前把 `lib/**/*.js` 全部暴露给每一个 http/https 源。原因是
// content.js 是 classic 脚本，必须用动态 import(chrome.runtime.getURL(...)) 加载 ES 模块，
// 而这些文件必须出现在 WAR 里。问题在于这个 glob 连同 50 个模块（含 run_javascript 的
// 黑名单实现）一起公开给了任意网页 —— 既是信息泄露，也是绕过地图。
//
// 正确做法：只暴露真正被 content.js 传递引用到的文件。手工枚举易错，因此用脚本推导。
//
// 用法：node scripts/compute-content-war.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 抽取一个源文件里的静态 import/export-from 与动态 import(...) 的路径字符串。
// 只认字符串字面量（本仓库的动态 import 都写死为 'lib/...' 或 chrome.runtime.getURL('lib/...')），
// 因此是保守推导：宁可多算，不可漏算。
function extractSpecs(src) {
  const specs = new Set();
  // 静态：import ... from 'x' / export ... from 'x'
  for (const m of src.matchAll(/\b(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  // 副作用导入：import 'x'
  for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  // 动态：import('x') 与 chrome.runtime.getURL('x')
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  for (const m of src.matchAll(/chrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  return [...specs];
}

// 把 import 说明符解析为仓库内的相对路径；外部依赖（无 ./ ../ 且无 lib/ 前缀）忽略。
function resolveSpec(spec, fromFile) {
  if (spec.startsWith('.')) {
    const p = path.resolve(path.dirname(fromFile), spec);
    return fs.existsSync(p) ? p : null;
  }
  // chrome.runtime.getURL('lib/page/x.js') 这类是相对仓库根的路径
  const p = path.resolve(ROOT, spec);
  return fs.existsSync(p) ? p : null;
}

function closure(entries) {
  const seen = new Set();
  const queue = entries.map((e) => path.resolve(ROOT, e));
  const external = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!fs.existsSync(file)) {
      console.error('警告：引用了不存在的文件 ' + path.relative(ROOT, file));
      continue;
    }
    const src = fs.readFileSync(file, 'utf8');
    for (const spec of extractSpecs(src)) {
      if (!spec.startsWith('.') && !spec.startsWith('lib/')) {
        external.add(spec);
        continue;
      }
      const resolved = resolveSpec(spec, file);
      if (resolved) queue.push(resolved);
      else console.error('警告：无法解析 "' + spec + '"（来自 ' + path.relative(ROOT, file) + '）');
    }
  }
  return { seen, external };
}

// content.js 的静态入口清单：它动态 import 的 4 个模块 + 顶层才加载的 chat.js。
// MAIN-world 的 debug-hook.js 由 manifest 的 content_scripts 直接注入，**不需要** WAR。
export const WAR_ENTRIES = [
  'lib/application/page/page-text.js',
  'lib/ui/page/commands.js',
  'lib/ui/page/picker.js',
  'lib/ui/page/debug-capture.js',
  'lib/ui/page/chat.js',
];

/** 返回 content.js 传递闭包的仓库相对路径（POSIX 分隔符，已排序）。 */
export function computeContentClosure(entries = WAR_ENTRIES) {
  const { seen } = closure(entries);
  return [...seen].map((f) => path.relative(ROOT, f).split(path.sep).join('/')).sort();
}

// CLI：仅在直接执行时输出（被测试 import 时不产生副作用）。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { external } = closure(WAR_ENTRIES);
  const rel = computeContentClosure();
  console.log('content.js 传递闭包共 ' + rel.length + ' 个文件：');
  for (const f of rel) console.log('  ' + f);
  if (external.size) {
    console.log('\n外部（非仓库内）说明符：' + [...external].sort().join(', '));
  }
}

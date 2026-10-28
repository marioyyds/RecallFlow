// 「同名 .js + .ts 双存」门禁（TITA-78 返工，评审 N1）。
//
// 为什么需要它：迁移期同一个模块会逐个从 `.js` 改名成 `.ts`，而两套解析规则并不一致：
//   · 迁移期的 `scripts/ts-resolve.mjs`（Batch 6 已回收）曾把 specifier 的 `.js` 优先解析成 `.ts`；
//   · `tests/source-path.mjs` 的规则是「先按写的那样找，找不到再试另一个后缀」。
// 一旦同名 `.js` 与 `.ts` 同时存在，`source-path` 就可能静默读到**旧副本** ——
// 门禁看到的是过期内容却照样绿。这与 L-30 同族：读错文件比直接报错更难发现。
//
// 判据：迁移目录（`lib/`、`entries/`）内，同一目录下同名 `.js` 与 `.ts` 并存即红。
//
// **唯一例外（TITA-86）**：`lib/page/debug-hook` 是 manifest 按路径注入的 MAIN world 脚本，
// 浏览器只认 `.js`，而源码必须叫 `.ts` —— 于是源码与产物**只能**同名同居。
// 这里按 `scripts/build-entries.mjs` 的 `ENTRIES.out`（构建清单的单一来源）放行，
// 不手抄路径；放行的语义是「.js 是产物、.ts 是源码」，因此**源码级门禁必须显式读 .ts**
// （tests/omit-mark 与 tests/page-debug-hook 已改成读 .ts，见 TITA-86 交付评论）。
//
// 用法：node scripts/check-ts-duplicates.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES } from './build-entries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 迁移范围：这两棵树里的模块正在 `.js` → `.ts` 逐个改名。 */
export const MIGRATION_DIRS = ['lib', 'entries'];

/** 构建产物（相对仓库根）。产物与源码同名是声明过的关系，不算歧义双存。 */
export const BUILT_OUTPUTS = new Set(ENTRIES.map((e) => e.out));

function walk(dirAbs, relDir, out) {
  const byBase = new Map();
  for (const e of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const rel = relDir ? relDir + '/' + e.name : e.name;
    if (e.isDirectory()) {
      walk(path.join(dirAbs, e.name), rel, out);
      continue;
    }
    const m = /^(.+)\.(js|ts)$/.exec(e.name);
    if (!m) continue;
    const pair = byBase.get(m[1]) || {};
    pair[m[2]] = rel;
    byBase.set(m[1], pair);
  }
  for (const [base, pair] of byBase) {
    if (pair.js && pair.ts && !BUILT_OUTPUTS.has(pair.js)) out.push({ base, js: pair.js, ts: pair.ts });
  }
}

/**
 * 找迁移目录里的同名双存。
 * @param {string} [root] 仓库根（测试用临时目录覆盖）
 * @returns {Array<{base:string, js:string, ts:string}>} 相对仓库根的路径
 */
export function findDuplicateTsJs(root = ROOT) {
  const findings = [];
  for (const dir of MIGRATION_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    walk(abs, dir, findings);
  }
  return findings;
}

function main() {
  const findings = findDuplicateTsJs();
  if (!findings.length) {
    console.log('迁移目录（' + MIGRATION_DIRS.map((d) => d + '/').join('、') + '）内没有同名 .js + .ts 双存。');
    return;
  }
  console.error('发现同名 .js + .ts 双存（迁移期必须只保留一个真实文件）：');
  for (const f of findings) console.error('  ' + f.js + '  ⇄  ' + f.ts);
  console.error('\n同名双存会让 tests/source-path.mjs 静默读到旧副本（它先找入参写的那个后缀）。');
  console.error('删掉旧副本，只保留改名后的那一个；产物请换目录或换文件名，别与源码同名同居。');
  process.exit(1);
}

// 只有作为入口直接跑时才执行 CLI：测试要 import 判据函数。
if (process.argv[1] && /check-ts-duplicates\.mjs$/.test(process.argv[1])) {
  main();
}

// 「同名 .js + .ts 双存」门禁（TITA-78 返工，评审 N1）。
//
// 为什么需要它：迁移期同一个模块会逐个从 `.js` 改名成 `.ts`，而两套解析规则并不一致：
//   · `scripts/ts-resolve.mjs`（Node 跑测试时）把 specifier 的 `.js` 优先解析成 `.ts`；
//   · `tests/source-path.mjs` 的规则是「先按写的那样找，找不到再试另一个后缀」。
// 一旦同名 `.js` 与 `.ts` 同时存在，`source-path` 就可能静默读到**旧副本** ——
// 门禁看到的是过期内容却照样绿。这与 L-30 同族：读错文件比直接报错更难发现。
//
// 判据：迁移目录（`lib/`、`entries/`）内，同一目录下同名 `.js` 与 `.ts` 并存即红。
// 不做路径豁免：真有「产物与源码同名同居」的需求，说明目录布局本身有歧义，应当改布局。
//
// 用法：node scripts/check-ts-duplicates.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 迁移范围：这两棵树里的模块正在 `.js` → `.ts` 逐个改名。 */
export const MIGRATION_DIRS = ['lib', 'entries'];

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
    if (pair.js && pair.ts) out.push({ base, js: pair.js, ts: pair.ts });
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

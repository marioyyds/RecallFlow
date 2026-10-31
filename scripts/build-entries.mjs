// 浏览器入口构建：把「浏览器按文件名直接加载」的入口打成自包含产物。
//
// 为什么需要它（这是 TS 迁移 Batch 2 的前置条件）：
//   Chromium 没有 type stripping，`.ts` 到浏览器就是语法错误（真 MV3 复核见
//   `scripts/verify-mv3-ts-load.mjs`：content script 静默不执行 / service worker
//   不注册 / getURL 动态 import reject 三种形态）。而 `background.js`、`popup.js` 等
//   六个入口被 manifest 与 HTML 按**文件名**引用，它们 import 的每个模块浏览器都要自己去取
//   —— 只要其中一个是 `.ts`，整条链就断。
//   打成一个文件后，运行时不再解析任何模块路径 ⇒ 入口图里的模块可以自由改成 `.ts`。
//
// 产物 = 仓库里的 `background.js` / `popup.js` / `options.js` / `manager.js` /
// `skills-page.js` / `userscripts.js` / `lib/userscript/runner.js`。
// **源码在 `entries/`**，与 `content.js`（源码 `entries/content.ts`）同一模式：
// 产物不是源码，别直接改产物 —— `--check` 会红。
//
// 用法：
//   node scripts/build-entries.mjs            # 构建并写盘
//   node scripts/build-entries.mjs --check     # 只验证产物是否与源码一致（CI 用）
//
// ⚠ 与本文件配套的两条约定：
//   1. 新增/迁移入口图里的模块后，必须重建产物 + 重建 content.js，然后跑 E2E
//      （单元测试读的是 `entries/**` 源码，测不到「产物没重建」这件事）。
//   2. 入口产物**不接受 git 文本合并**（与 content.js 同一条规则：合并冲突时重跑构建）。
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 入口清单。`format` 由**加载方式**决定，不是偏好：
 *   - `esm`：manifest 的 `background.type = "module"`，以及 5 个 HTML 的 `<script type="module">`。
 *   - `iife`：`chrome.scripting.executeScript({files:[...]})` 注入的是 **classic 脚本**，
 *     产物里出现 `import`/`export` 会直接 "Cannot use import statement outside a module"。
 *
 * `budget` 是逐入口的体积棘轮（字节，实测值向上取整留余量）。它防的是
 * 「误引入大依赖」与「重复内联同一份大模块」，不是精确预算。
 */
// TS 迁移 Batch 5（TITA-86）：源码全部改成 `.ts`（`entries/*.js` 已不存在）。
// `debug-hook` 是同一模式的第 8 个入口：manifest 的 content_scripts 按**路径**注入
// `lib/page/debug-hook.js`，而浏览器不认 `.ts` —— 所以它也必须走构建，
// 源码在 `lib/adapters/page/debug-hook.ts`，产物仍是 manifest 里写的那个文件名（manifest 零改动）。
export const ENTRIES = [
  // Background 增加 RunLifecycleService（停止、abort 宽限、标签页统一清理）。
  // Popup 增加 ChromeTabsAdapter；两者均为小型自包含状态/Port 适配，无新依赖。
  // 892 KB：agent 拆分为 run state、tool pipeline、completion coordinator 与
  // finalizer 后，保留了清晰的对象边界与可读产物；新增约 12 KB 自包含代码，
  // 合并 bridge agent job、WebArena 预算判定与安全守卫后实测 887 KB。未引入
  // 新依赖；预算是防误引入依赖的棘轮，不是要求压扁职责边界。
  // 2026-10-31: download observation (Page/Browser events, session persistence,
  // task-start setup) and progressive snapshot wiring measured 901KB; raise to
  // 902KB explicitly. No new dependency.
  { src: 'entries/background.ts', out: 'background.js', format: 'esm', budget: 902 * 1024 },
  { src: 'entries/popup.ts', out: 'popup.js', format: 'esm', budget: 38 * 1024 },
  // 536 KB：同步合并后的工具、桥接与评测设置说明，实测 530 KB。
  { src: 'entries/options.ts', out: 'options.js', format: 'esm', budget: 536 * 1024 },
  // 58 KB：manager 与 popup 共用 KnowledgeRepository（缓存、串行写入、外部变更订阅）。
  // 共享状态边界增加了约 3.5 KB 自包含产物；未引入新依赖。
  { src: 'entries/manager.ts', out: 'manager.js', format: 'esm', budget: 58 * 1024 },
  // 532 KB：新增 query-report-table 技能并同步工具清单，实测 525 KB。
  { src: 'entries/skills-page.ts', out: 'skills-page.js', format: 'esm', budget: 532 * 1024 },
  { src: 'entries/userscripts.ts', out: 'userscripts.js', format: 'esm', budget: 27 * 1024 },
  // 两个产物不在仓库根的：`lib/userscript/manager.js:237` 与 `module-references`
  // 的豁免清单都按这两个字面路径找它们。
  { src: 'entries/userscript-runner.ts', out: 'lib/userscript/runner.js', format: 'iife', budget: 11 * 1024 },
  { src: 'lib/adapters/page/debug-hook.ts', out: 'lib/page/debug-hook.js', format: 'iife', budget: 13 * 1024 },
];

export async function buildEntry(entry) {
  const result = await build({
    entryPoints: [path.join(ROOT, entry.src)],
    outfile: path.join(ROOT, entry.out),
    bundle: true,
    format: entry.format,
    platform: 'browser',
    target: ['chrome110'],
    // 与 content.js 一致：不压缩。这些产物要能被人读（排查「扩展为什么在这台机器上不起作用」
    // 时，压缩过的 bundle 等于没有）。体积由 budget 这条棘轮盯着。
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    write: false,
    metafile: true,
  });
  const text = String((result.outputFiles && result.outputFiles[0] && result.outputFiles[0].text) || '');
  return {
    entry,
    text,
    bytes: lfByteLength(text),
    moduleCount: Object.keys(result.metafile.inputs || {}).length,
  };
}

/**
 * 产物的「内容字节数」：先把行尾归一到 LF，再按 UTF-8 计字节。
 *
 * 体积预算必须用它，而不是 `fs.statSync(产物).size`：`core.autocrlf=true` 的检出
 * 会把每个 `\n` 变成 `\r\n`，盘上体积凭空变大（L-19 同族），而预算棘轮盯的是内容。
 * 内存产物本来就是 LF，所以这个函数对「构建结果」与「归一后的盘上内容」给出同一个数。
 * @param {string} text
 * @returns {number}
 */
export function lfByteLength(text) {
  const lf = String(text === undefined || text === null ? '' : text).replace(/\r\n/g, '\n');
  return Buffer.byteLength(lf, 'utf8');
}

/**
 * 产物规格检查（纯函数，便于直测）。返回问题列表，空数组 = 通过。
 *
 * 关键是**自包含性**：如果产物里还留着 `from './lib/x.js'` 或 `import(...)`，
 * 说明那条依赖没被内联 —— 浏览器仍会按路径去取文件，迁移到 `.ts` 照样断，
 * 而脚本会「构建成功」并给出一份看起来正常的产物。
 *
 * @param {string} text 产物全文
 * @param {{format: string, bytes: number, budget: number}} spec
 */
export function checkEntryArtifact(text, spec) {
  const src = String(text === undefined || text === null ? '' : text);
  const problems = [];
  // 残留的相对 import/export：无论哪种 format 都说明模块没被全部内联。
  if (/(?:^|\n)\s*(?:import|export)\b[^\n]*?from\s*['"]\.{1,2}\//.test(src) || /\bimport\s*\(\s*['"]\.{1,2}\//.test(src)) {
    problems.push({ code: 'unresolved-relative-import' });
  }
  // iife 产物里出现任何 import/export 语句，浏览器按 classic 脚本执行会直接语法错误。
  if (spec.format === 'iife' && /(?:^|\n)\s*(?:import|export)[\s{*]/.test(src)) {
    problems.push({ code: 'esm-syntax-in-iife' });
  }
  // 运行时还要按路径取模块（getURL 动态 import）—— 打包的意义就是消掉它。
  if (/\bimport\s*\(/.test(src)) problems.push({ code: 'residual-dynamic-import' });
  if (spec.bytes > spec.budget) problems.push({ code: 'too-large', bytes: spec.bytes, budget: spec.budget });
  return problems;
}

/**
 * 比较盘上产物与「现在源码打出来的产物」。相同返回 null，不同返回首个差异行。
 * 行尾先归一到 LF：`core.autocrlf=true` 的检出会把产物转成 CRLF，
 * 那是与内容无关的差异（L-19），不能算「产物过期」。
 */
export function compareEntry(diskText, builtText) {
  const norm = (v) => String(v === undefined || v === null ? '' : v).replace(/\r\n/g, '\n');
  const a = norm(diskText);
  const b = norm(builtText);
  if (a === b) return null;
  const al = a.split('\n');
  const bl = b.split('\n');
  const max = Math.max(al.length, bl.length);
  let i = 0;
  while (i < max && al[i] === bl[i]) i += 1;
  return { line: i + 1, diskLines: al.length, builtLines: bl.length };
}

/**
 * 构建全部入口（内存产物，不写盘）。供 CLI 与新鲜度门禁复用。
 * @returns {Promise<Array<{entry: object, text: string, bytes: number, moduleCount: number}>>}
 */
export async function buildAll() {
  const out = [];
  for (const entry of ENTRIES) out.push(await buildEntry(entry));
  return out;
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  let failed = 0;
  console.log('| 入口 | 源码 | 模块数 | 产物 | 预算 | 结果 |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const entry of ENTRIES) {
    const built = await buildEntry(entry);
    const problems = checkEntryArtifact(built.text, {
      format: entry.format,
      bytes: built.bytes,
      budget: entry.budget,
    });

    let status = 'ok';
    if (problems.length) {
      status = problems.map((p) => p.code).join(',');
    } else if (checkOnly) {
      const outAbs = path.join(ROOT, entry.out);
      const disk = fs.existsSync(outAbs) ? fs.readFileSync(outAbs, 'utf8') : null;
      const diff = disk === null ? { line: 0 } : compareEntry(disk, built.text);
      if (disk === null) status = 'MISSING';
      else if (diff) status = 'STALE(line ' + diff.line + ')';
      else status = 'fresh';
    } else {
      fs.writeFileSync(path.join(ROOT, entry.out), built.text);
    }

    if (status !== 'ok' && status !== 'fresh') failed += 1;
    console.log(
      `| \`${entry.out}\` | \`${entry.src}\` | ${built.moduleCount} | ${Math.round(built.bytes / 1024)} KB | ${Math.round(entry.budget / 1024)} KB | ${status} |`
    );

    for (const p of problems) {
      if (p.code === 'too-large') {
        console.error(
          `${entry.out} 产物 ${p.bytes} 字节超过预算 ${p.budget}。\n` +
            '  先确认没有误引入大依赖；确实必要的话在同一处上调 budget 并写清原因 —— 别靠压缩换绿。'
        );
      } else if (p.code === 'residual-dynamic-import' || p.code === 'unresolved-relative-import') {
        console.error(
          `${entry.out} 里仍有未内联的模块引用（${p.code}）。\n` +
            '  说明依赖链上有 esbuild 解析不了的写法（典型：`import(chrome.runtime.getURL("..."))`，\n' +
            '  esbuild 无法静态解析 getURL 里的路径）。改成静态 import 后再构建。'
        );
      } else if (p.code === 'esm-syntax-in-iife') {
        console.error(`${entry.out} 是 classic 脚本（executeScript 注入），产物里不能出现 import/export。`);
      }
    }
  }

  if (checkOnly) {
    if (failed) {
      console.error(
        '\n有 ' + failed + ' 个入口产物未通过检查。\n' +
          '  源码是 entries/**，产物是仓库根的那几个 .js —— 改了源码就要重跑 `node scripts/build-entries.mjs`。'
      );
      process.exit(1);
    }
    console.log('\n全部入口产物与源码一致。');
    return;
  }
  if (failed) process.exit(1);
  console.log('\n已写入 ' + ENTRIES.length + ' 个入口产物。');
}

// 只有作为入口直接跑时才执行 CLI：测试要 import 上面的纯函数。
if (process.argv[1] && /build-entries\.mjs$/.test(process.argv[1])) {
  main();
}

// 内容脚本打包：把 content.js 的传递依赖图打成**单个文件**。
//
// 为什么要打包（三个问题一次解决）：
//   1. **源码披露**：MV3 内容脚本不能用静态 ESM，因此 content.js 只能
//      `import(chrome.runtime.getURL('lib/...'))`，而这些文件必须写进
//      web_accessible_resources —— 于是任何网页都能枚举并读取扩展源码
//      （含 run_javascript 的黑名单实现，等于公开了绕过地图）。
//      打包后 content.js 自包含，WAR 可以**整条删掉**。
//   2. **模块瀑布**：现在每页要动态拉 ~16 个模块，每个再拉自己的静态依赖；
//      单文件后只有一次加载。
//   3. **原子产物**：不再有"扩展更新到一半、新旧模块混用"的窗口。
//
// 用法：
//   node scripts/build-content.mjs            # 构建并写入仓库根的 content.js
//   node scripts/build-content.mjs --check     # 只验证能构建，不写产物（CI 用）
//
// 注意：**本脚本目前不参与 manifest**（content.js 仍走动态 import）。
// 原因是切换到打包产物需要同时改 manifest.json 的 content_scripts，
// 并重新验证"页面注入 → 面板 → 工具调用"全链路（E2E 已能覆盖，见 tests/e2e）。
// 这里先把构建能力与产物规格固定下来，让那一步是一次小改动而不是探索。
//
// ⚠ **产物是提交进仓库的文件**：改了 `lib/page/**` 或 `lib/shared/**` 之后必须重跑本脚本，
// 否则 E2E 加载的是旧产物 —— 它测的就不再是你刚改的代码，而且**不会报错**。
// 新鲜度由 tests/content-bundle-freshness.test.mjs 守（它直接比字节）。
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 产物直接落在仓库根的 content.js：manifest 只需加载它，
// 且它是自包含的（不再需要 web_accessible_resources）。
const OUT_FILE = path.join(ROOT, 'content.js');

/**
 * 体积预算（字节）。
 *
 * 打包的意义之一是把体积变得**可见**：超过这个量级通常意味着误引入了大依赖
 * （例如把整个 markdown 渲染器或某个 polyfill 打进了内容脚本）。
 *
 * 这不是「随便定的上限」，而是一条**棘轮**：现在 420KB。
 * 2026-10 上调原因：read_table 需要在内容脚本里做「自动选主表 + 分页文本解析」
 * （parseGridPagination）；筛选/求和的查询逻辑已拆到 lib/shared/table-query.js（后台专用），
 * 不随内容脚本下发。实测 418KB，故从 416KB 上调到 420KB。
 * 真需要涨的话，请在同一处上调并写清原因 —— 但先确认不是误引入。
 * 它现在由 npm test 守（tests/content-bundle-freshness.test.mjs），不再是
 * 「跑一下脚本才可能看到」的提示：此前它 exit 1 却**照样写盘**，
 * 于是体积早就超了、却没有任何门禁红过。
 */
export const SIZE_BUDGET_BYTES = 420 * 1024;

/**
 * 产物规格检查（纯函数，便于直测）。返回问题列表，空数组 = 通过。
 * @param {string} text 产物全文
 * @param {number} bytes 产物体积
 */
export function checkBundle(text, bytes) {
  const src = String(text === undefined || text === null ? '' : text);
  const size = Number(bytes) || 0;
  const problems = [];
  // **关键一条：确认它真的自包含了。**
  // 如果不检查这一条，脚本会给出一个**假的通过** —— 实测第一次运行就是：
  // esbuild 只打进 content.js 本身（1 个模块、5KB），因为它的依赖写法是
  //   import(chrome.runtime.getURL('lib/page/xxx.js'))
  // esbuild 无法静态解析 getURL(...) 里的路径，于是把这些动态 import **原样留着**。
  // 那样打出来的产物仍然依赖 WAR，等于什么都没解决，却会让人以为"打包完成了"。
  //
  // 只检查**动态 import**：`chrome.runtime.getURL(` 本身仍可能出现，
  // 用于取扩展内的静态资源（如面板 logo 的 docs/assets/*.svg）——那是合法的，
  // 也是 manifest 的 web_accessible_resources 仍保留那一条的原因。
  // 真正致命的是"运行时再去 import 一个模块"：打包后那些模块不再作为独立文件存在，
  // 该 import 会失败 —— 而且往往是**静默**失败（被 catch 吞掉），
  // 例如交接包里的控制台错误快照会悄悄变空。
  if (/\bimport\s*\(/.test(src)) problems.push({ code: 'dynamic-import' });
  if (size > SIZE_BUDGET_BYTES) problems.push({ code: 'too-large', bytes: size, budget: SIZE_BUDGET_BYTES });
  return problems;
}

/**
 * 比较「盘上的产物」与「现在源码打出来的产物」。相同返回 null，不同返回第一处差异所在行。
 *
 * 行尾统一成 LF 再比：git 的 autocrlf 会让签出后的文件变成 CRLF，
 * 那是**和内容无关**的差异 —— 若把它算成"产物过期"，这条门禁会在 Windows 上永远红。
 */
export function compareBundle(diskText, builtText) {
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
 * 跑一次构建。
 * @param {{write?: boolean}} [opts] write=false 时只返回内存产物（CI / 新鲜度检查用）
 * @returns {Promise<{text: string, bytes: number, moduleCount: number}>}
 */
export async function buildContentBundle(opts = {}) {
  const write = opts.write !== false;
  // 一律 `write: false` + 自己写盘：这样两种模式都能拿到 text，
  // 规格检查（自包含性 / 体积）可以用**同一份**内容判断，不必区分"产物在哪"。
  const result = await build({
    entryPoints: [path.join(ROOT, 'entries', 'content.js')],
    outfile: OUT_FILE,
    bundle: true,
    format: 'iife',
    // 内容脚本运行在页面上下文的隔离世界里，MV3 下没有模块加载器 ——
    // iife 是唯一能直接被 manifest 当普通脚本注入的形态。
    platform: 'browser',
    target: ['chrome110'],
    // 入口把 initContentScript 挂到 window.__rfContentInit（见 entries/content.js），
    // 这里在产物末尾调用它。这一步不能省：忘了它，产物会"加载成功但什么都不做"
    //（面板不出现、消息无响应），而且不会报错 —— 正是本项目反复出现的那类静默失效。
    footer: { js: 'if (window.__rfContentInit) window.__rfContentInit();' },
    // 不压缩：这个产物要给人看（排查"扩展为什么在这页面失效"时能读）。
    // 体积由 SIZE_BUDGET_BYTES 这条棘轮盯着，不靠压缩来换取"看起来没超"。
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    write: false,
    metafile: true,
  });
  const text = String((result.outputFiles && result.outputFiles[0] && result.outputFiles[0].text) || '');
  if (write) fs.writeFileSync(OUT_FILE, text);
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    moduleCount: Object.keys(result.metafile.inputs || {}).length,
  };
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const bundle = await buildContentBundle({ write: !checkOnly });
  console.log('输入模块：' + bundle.moduleCount + ' 个');
  console.log('产物大小：' + Math.round(bundle.bytes / 1024) + ' KB');

  const problems = checkBundle(bundle.text, bundle.bytes);
  for (const p of problems) {
    if (p.code === 'dynamic-import') {
      console.error(
        '\n这不是一个可用的打包产物：其中仍残留 动态 import(。\n' +
          '  原因：content.js 用 `import(chrome.runtime.getURL("lib/..."))` 加载依赖，\n' +
          '  esbuild 无法解析 getURL(...) 里的路径，于是这些动态 import 被原样保留 ——\n' +
          '  产物仍然依赖 web_accessible_resources，等于没有解决任何问题。\n\n' +
          '  要让打包真正生效，需要先把这些动态 import 改成**静态 import**\n' +
          '  （顶层 `import { x } from "./lib/page/xxx.js"`），让 esbuild 能顺着解析。\n' +
          '  那一步会改动内容脚本的加载方式，必须配合 E2E 重新验证。\n' +
          '  在此之前，本脚本的存在价值是：把"产物规格"与"还差什么"固定下来，\n' +
          '  而不是让下一个人以为打包已经做好了。'
      );
      process.exit(2);
    }
    if (p.code === 'too-large') {
      console.error(
        '产物 ' + Math.round(p.bytes / 1024) + ' KB 超过预算 ' + Math.round(p.budget / 1024) + ' KB。\n' +
          '  先确认没有误引入大依赖（SIZE_BUDGET_BYTES 上方有说明）；确实必要的话，\n' +
          '  在同一处上调预算并写清原因 —— 但别为了变绿去压缩代码。'
      );
      process.exit(1);
    }
  }
  console.log('自包含性检查通过：产物中已无运行时动态 import（模块已全部内联）。');
}

// 只有被直接调用时才跑 CLI：tests/content-bundle-freshness.test.mjs 要 import 上面那些纯函数，
// 若 import 就执行构建，测试会莫名其妙地写盘。
if (process.argv[1] && /build-content\.mjs$/.test(process.argv[1])) {
  main();
}

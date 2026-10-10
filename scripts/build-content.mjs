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
//   node scripts/build-content.mjs            # 构建到 dist/
//   node scripts/build-content.mjs --check     # 只验证能构建，不写产物（CI 用）
//
// 注意：**本脚本目前不参与 manifest**（content.js 仍走动态 import）。
// 原因是切换到打包产物需要同时改 manifest.json 的 content_scripts，
// 并重新验证"页面注入 → 面板 → 工具调用"全链路（E2E 已能覆盖，见 tests/e2e）。
// 这里先把构建能力与产物规格固定下来，让那一步是一次小改动而不是探索。
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'dist');
// 产物直接落在仓库根的 content.js：manifest 只需加载它，
// 且它是自包含的（不再需要 web_accessible_resources）。
const OUT_FILE = path.join(ROOT, 'content.js');

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
  // 体积不是瓶颈（单文件 < 200KB），可读性更重要。
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  write: !process.argv.includes('--check'),
  metafile: true,
});

const outputs = Object.keys(result.metafile.outputs || {});
const bytes = outputs.length ? result.metafile.outputs[outputs[0]].bytes : 0;
const inputs = Object.keys(result.metafile.inputs || {});
console.log('输入模块：' + inputs.length + ' 个');
console.log('产物大小：' + Math.round(bytes / 1024) + ' KB');

// **关键一步：确认它真的自包含了。**
// 如果不检查这一条，脚本会给出一个**假的通过** —— 实测第一次运行就是：
// esbuild 只打进 content.js 本身（1 个模块、5KB），因为它的依赖写法是
//   import(chrome.runtime.getURL('lib/page/xxx.js'))
// esbuild 无法静态解析 getURL(...) 里的路径，于是把这些动态 import **原样留着**。
// 那样打出来的产物仍然依赖 WAR，等于什么都没解决，却会让人以为"打包完成了"。
const src = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
if (!fs.existsSync(OUT_FILE) && !process.argv.includes('--check')) {
  console.error('未生成产物，无法校验自包含性。');
  process.exit(2);
}
// --check 模式下产物不写盘，改用 esbuild 的内存产物判断
const code = process.argv.includes('--check') ? String(result.outputFiles?.[0]?.text || '') : src;
// 只检查**动态 import**：`chrome.runtime.getURL(` 本身仍可能出现，
// 用于取扩展内的静态资源（如面板 logo 的 docs/assets/*.svg）——那是合法的，
// 也是 manifest 的 web_accessible_resources 仍保留那一条的原因。
// 真正致命的是"运行时再去 import 一个模块"：打包后那些模块不再作为独立文件存在，
// 该 import 会失败 —— 而且往往是**静默**失败（被 catch 吞掉），
// 例如交接包里的控制台错误快照会悄悄变空。
const leftover = [];
if (/\bimport\s*\(/.test(code)) leftover.push('动态 import(');

if (leftover.length) {
  console.error(
    '\n这不是一个可用的打包产物：其中仍残留 ' + leftover.join(' / ') + '。\n' +
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

console.log('自包含性检查通过：产物中已无运行时动态 import（模块已全部内联）。');
if (bytes > 400 * 1024) {
  // 打包的意义之一是把体积变得**可见**。超过这个量级通常意味着误引入了大依赖。
  console.error('产物超过 400KB，请检查是否引入了不该进内容脚本的依赖。');
  process.exit(1);
}

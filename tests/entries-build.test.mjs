// 浏览器入口产物的**新鲜度与规格**门禁（TITA-78，TS 迁移 Batch 2）。
//
// 背景：`background.js` / `popup.js` / `options.js` / `manager.js` / `skills-page.js` /
// `userscripts.js` / `lib/userscript/runner.js` 现在都是 `scripts/build-entries.mjs` 的
// **构建产物**，源码在 `entries/`。这与 `content.js`（源码 `entries/content.ts`）同一模式，
// 因此守住的问题也同型：
//   ① 改了 `entries/**` 或入口图里的 `lib/**` 却没重建 → 浏览器加载的是旧代码，
//      而单元测试读的是源码，**不会有人红**；E2E 会对着旧产物全绿。
//   ② 产物里残留未内联的模块引用 → 迁移到 `.ts` 照样断，但脚本「构建成功」。
//   ③ 体积棘轮松到失去意义 → 下一次无声膨胀不会被抓住。
//
// 这三条都只能在「构建一次再比」的模式下测，所以本文件直接复用
// `scripts/build-entries.mjs` 导出的纯函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENTRIES, buildAll, checkEntryArtifact, compareEntry } from '../scripts/build-entries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 全部入口构建一次（esbuild 单入口约 0.1~0.6 秒，别每条用例都跑）。
let cached = null;
function built() {
  if (!cached) cached = buildAll();
  return cached;
}

test('每个入口产物都与源码一致（改了 entries/** 或入口图里的 lib/** 就必须重建）', async () => {
  const results = await built();
  for (const r of results) {
    const outAbs = path.join(ROOT, r.entry.out);
    const disk = fs.readFileSync(outAbs, 'utf8');
    assert.ok(r.text.length > 200, r.entry.out + ' 的内存产物太小，构建本身不正常：' + r.text.length);
    assert.ok(disk.length > 200, r.entry.out + ' 的盘上产物太小，可能被清空了：' + disk.length);
    const diff = compareEntry(disk, r.text);
    assert.equal(
      diff,
      null,
      r.entry.out +
        ' 已过期（第一处差异在第 ' +
        (diff && diff.line) +
        ' 行；盘上 ' +
        (diff && diff.diskLines) +
        ' 行 / 应为 ' +
        (diff && diff.builtLines) +
        ' 行）。\n' +
        '  源码是 ' +
        r.entry.src +
        ' —— 改了它（或它 import 的模块）就要重跑 `node scripts/build-entries.mjs`。\n' +
        '  浏览器加载的是产物，不重建就等于在测/跑旧代码。'
    );
    // 规格：自包含 + 体积在预算内。放在同一条用例里，避免为同一份产物再构建一遍。
    assert.deepEqual(
      checkEntryArtifact(r.text, { format: r.entry.format, bytes: r.bytes, budget: r.entry.budget }),
      [],
      r.entry.out + ' 产物规格不合格（见 scripts/build-entries.mjs 的说明）'
    );
  }
});

test('入口清单完整：manifest 与 HTML 引用的每个文件名都有产物（且格式由加载方式决定）', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const outs = new Map(ENTRIES.map((e) => [e.out, e]));

  // service worker 必须是 module（manifest 的 type=module），产物走 esm。
  const sw = manifest.background.service_worker;
  assert.ok(outs.has(sw), 'manifest 的 service_worker 没有对应入口产物：' + sw);
  assert.equal(outs.get(sw).format, 'esm', 'MV3 的 module service worker 只能是 ESM 产物');

  // executeScript 注入的是 classic 脚本 —— 产物里出现 import/export 会直接语法错误。
  const runnerOut = outs.get('lib/userscript/runner.js');
  assert.ok(runnerOut, 'executeScript 注入的 runner 必须有入口产物');
  assert.equal(runnerOut.format, 'iife', 'executeScript 注入的是 classic 脚本，只能 iife');

  // 5 个 HTML 的 <script type="module" src="..."> 都要有产物。
  for (const [html, expected] of [
    ['popup.html', 'popup.js'],
    ['options.html', 'options.js'],
    ['manager.html', 'manager.js'],
    ['skills.html', 'skills-page.js'],
    ['userscripts.html', 'userscripts.js'],
  ]) {
    const src = fs.readFileSync(path.join(ROOT, html), 'utf8');
    assert.ok(src.includes('src="' + expected + '"'), html + ' 引用的入口脚本变了：' + expected);
    assert.ok(outs.has(expected), html + ' 引用的入口没有对应产物：' + expected);
  }

  // 产物路径必须与入口清单里的 out 字面一致，否则下面的新鲜度检查会静默跳过某个入口。
  for (const e of ENTRIES) {
    assert.ok(fs.existsSync(path.join(ROOT, e.src)), '入口源码不存在：' + e.src);
    assert.ok(fs.existsSync(path.join(ROOT, e.out)), '入口产物不存在（先跑 node scripts/build-entries.mjs）：' + e.out);
  }
});

test('规格判据本身有牙：残留模块引用 / iife 里出现 ESM 语法 / 超预算都要被点出来', () => {
  const spec = (over) => Object.assign({ format: 'esm', bytes: 100, budget: 1024 }, over);
  assert.deepEqual(checkEntryArtifact('var a = 1;\n', spec()), []);

  assert.deepEqual(
    checkEntryArtifact("var a = 1;\nimport { x } from './lib/a.js';\n", spec()).map((p) => p.code),
    ['unresolved-relative-import'],
    '相对 import 没被内联 ⇒ 浏览器仍按路径取文件，.ts 迁移照样断'
  );
  assert.deepEqual(
    checkEntryArtifact('var a = 1;\nvar b = import("./lib/a.js");\n', spec())
      .map((p) => p.code)
      .sort(),
    ['residual-dynamic-import', 'unresolved-relative-import'],
    '运行时动态 import 说明依赖没内联（esbuild 解析不了 getURL(...) 这类写法）'
  );
  assert.deepEqual(
    checkEntryArtifact('export const a = 1;\n', spec({ format: 'iife' })).map((p) => p.code),
    ['esm-syntax-in-iife'],
    'classic 脚本里出现 export 会直接 "Cannot use import statement outside a module"'
  );
  assert.deepEqual(
    checkEntryArtifact('var a = 1;', spec({ bytes: 2048 })).map((p) => p.code),
    ['too-large']
  );
  // 多条同时不满足时都要报，不能只报第一条就返回
  assert.deepEqual(
    checkEntryArtifact("import { x } from './a.js';\nvar b = import('./c.js');", spec({ bytes: 2048 }))
      .map((p) => p.code)
      .sort(),
    ['residual-dynamic-import', 'too-large', 'unresolved-relative-import']
  );
});

test('比较器本身有牙：真有差异时必须指出第一处不同在第几行，行尾差异不算', () => {
  assert.equal(compareEntry('a\nb\nc', 'a\nb\nc'), null);
  assert.deepEqual(compareEntry('a\nb\nc', 'a\nX\nc'), { line: 2, diskLines: 3, builtLines: 3 });
  // core.autocrlf=true 的检出会把产物转成 CRLF —— 与内容无关，不能算过期（L-19）
  assert.equal(compareEntry('a\r\nb', 'a\nb'), null, '行尾差异不能被当成内容差异');
  assert.deepEqual(compareEntry('a\nb', 'a\nb\nc'), { line: 3, diskLines: 2, builtLines: 3 });
});

test('每个入口产物离体积预算都足够近（松到 3 倍就失去意义了）', () => {
  for (const e of ENTRIES) {
    const bytes = fs.statSync(path.join(ROOT, e.out)).size;
    // 磁盘字节数是 CRLF 检出下的值，只用来判「预算有没有松得离谱」这个上界方向；
    // 精确比较用 checkEntryArtifact（它比的是内存产物的 LF 字节）。
    assert.ok(bytes <= e.budget, e.out + ' 实际 ' + bytes + ' > 预算 ' + e.budget + '：确认不是误引入大依赖');
    assert.ok(
      e.budget - bytes < 16 * 1024,
      e.out + ' 的预算离实际太远（差 ' + Math.round((e.budget - bytes) / 1024) + ' KB）：收紧到实际之上 16KB 以内'
    );
  }
});

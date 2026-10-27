// 「这个模块到底有没有被测试碰过」—— 用**静态 import 图**回答，而不是靠人记得。
//
// 起因（评审的头号发现）：`lib/page/chat.ts` 有 4900 行、12 个测试文件「提到」它，
// 却没有一个真的 import 过 —— 全是 `readFileSync` + 正则。于是 fab 位置那个 bug
// 能一路活到线上：断言源码里有 `clampFabTop(...)` 这句话，无法证明它被调用过。
//
// 这件事靠自觉守不住：新加一个模块、忘了写测试，没有任何东西会红。
// 所以这里把「测试能到达的模块集合」变成可计算的事实，并**双向**钉住：
//   ① 出现了测试到不了的新模块 → 要么补测试，要么加进 ALLOWED 并写明为什么不能；
//   ② ALLOWED 里的条目后来被测试覆盖了 → 必须从清单里删掉（否则清单会腐烂成垃圾桶）。
//
// 注意这里**只做静态可达性**，不做「跑了多少行」：它能回答的是
// 「有没有测试引用过它」，不是「覆盖率多少」。后者靠 coverage-baseline.mjs（口径不可靠，
// 见该脚本说明）。两者都不该被当成另一个的替代品。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** 测试到不了、但有正当理由的模块。**新增条目必须写明"为什么不可能被测到"**。 */
const ALLOWED = {
  // MAIN world 的裸脚本：由 manifest 的 content_scripts[].js 注入，**不是 ES 模块**（没有 export、
  // 也不能 import）。它的正确性由 tests/omit-mark.test.mjs（读源码比对形态）与 E2E 保证。
  'lib/page/debug-hook.js': 'MAIN world 裸脚本，由 manifest 注入，不是 ES 模块',
  // 同上，用 chrome.scripting.executeScript 以**路径**注入（见 lib/userscript/manager.js）。
  'lib/userscript/runner.js': '由 executeScript 以路径注入的裸脚本，不是 ES 模块',
  // 这两个只经 entries/content.ts 静态导入（内容脚本打包入口），页面侧行为由 E2E 覆盖。
  'lib/page/picker.ts': '内容脚本侧，仅经 entries/content.ts 导入；行为由 E2E 的拾取用例覆盖',
  'lib/page/debug-capture.ts': '内容脚本侧，仅经 entries/content.ts 导入；行为由 E2E 覆盖',
  // service worker 入口 background.js 才 import 它，而测试从不 import 入口（会真起 chrome API）。
  'lib/shared/idb-kv.js': '只被 background.js 导入；入口不能 import（会摸真 chrome API）',
};

const IMPORT_RE = /(?:from\s*|import\(\s*|require\(\s*)['"]([^'"]+)['"]/g;

/** 剥离 `?case=1` / `#x` —— `import('../lib/page/chat.ts?case=' + n)` 是为了绕开模块缓存，
 *  解析时必须把 query 去掉，否则这个**最关键的**模块会被判成"没人引用"（实测踩过：
 *  第一次跑就漏了 chat.js，而它正是这条门禁要防的那个）。 */
export function stripQuery(spec) {
  return String(spec).split('?')[0].split('#')[0];
}

/** 相对路径 specifier → 真实文件（含 .js / .mjs / index.js 三种省略写法）。 */
/** 迁移期的后缀互换：`importer 写 .js、文件已是 .ts` 由 scripts/ts-resolve.mjs 兜住，
 *  静态分析这里也得认，否则「改名」会被误判成「没人引用它」/「它是死代码」。
 *  Batch 5 收口（所有 specifier 都写真实后缀）后可删掉 swapExt。 */
function swapExt(file) {
  return file.replace(/\.(js|mjs|ts|mts)$/, (ext) =>
    ext === '.js' ? '.ts' : ext === '.mjs' ? '.mts' : ext === '.ts' ? '.js' : '.mjs');
}

function resolveImport(fromFile, spec) {
  const s = stripQuery(spec);
  if (!s.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), s);
  for (const cand of [base, base + '.js', base + '.mjs', swapExt(base), path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch (e) {
      /* 不存在就试下一个 */
    }
  }
  return null;
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    // ⚠ `.ts` 必须进扫描集：改名后如果它继续只认 .js，被迁的模块会从 LIB_FILES 里
    // 消失 —— 于是「每个 lib 模块都要被测试碰过」这条对它们静默失效（与 §3.4 同源的病）。
    else if (/\.(js|mjs|ts|mts)$/.test(p)) out.push(path.resolve(p));
  }
  return out;
}

/** 从 roots 出发，沿静态 import / 动态 import(字面量) / require 做可达性 BFS。 */
function reachableFrom(roots) {
  const seen = new Set();
  const queue = roots.map((r) => path.resolve(ROOT, r));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let src = '';
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue; // 入口文件不存在（可选入口）直接跳过
    }
    for (const m of src.matchAll(IMPORT_RE)) {
      const next = resolveImport(file, m[1]);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

const LIB_FILES = walk(path.join(ROOT, 'lib')).map(rel);
// roots 必须是**文件**（不是目录）：BFS 里读不到目录内容，静默跳过会让所有模块
// 都变成"测试碰不到"（第一版就是这么错的，红了 88 条）。
const FROM_TESTS = reachableFrom(walk(path.join(ROOT, 'tests')).map(rel));
const reachableByTests = (libRel) => FROM_TESTS.has(path.join(ROOT, libRel));

test('分析器有牙齿：query 不影响解析，非相对 specifier 不瞎认', () => {
  // 这条不是仪式：`import('../lib/page/chat.ts?case=' + n)` 里的 query 如果没被剥掉，
  // 解析会失败，于是"chat.js 被测试引用"这个事实会被判成 false —— 门禁从此看不见
  // 它最该看的那个文件（我第一版就是这么错的）。
  assert.equal(stripQuery('../lib/page/chat.ts?case=3'), '../lib/page/chat.ts');
  const fake = path.join(ROOT, 'tests', 'chat-panel-smoke.test.mjs');
  assert.equal(rel(resolveImport(fake, '../lib/page/chat.ts?case=1')), 'lib/page/chat.ts');
  // 裸包名（node:fs / @playwright/test）不该被当成文件去解析。
  assert.equal(resolveImport(fake, 'node:fs'), null);
  assert.equal(resolveImport(fake, '@playwright/test'), null);
});

test('每个 lib 模块要么被测试静态引用，要么在 ALLOWED 里写明理由（双向）', () => {
  const unreferenced = LIB_FILES.filter((f) => !reachableByTests(f));
  // ① 不在清单里的"测试碰不到"模块 —— 这就是 chat.js 当初的形状，必须在此刻就红。
  assert.deepEqual(
    unreferenced.filter((f) => !(f in ALLOWED)),
    [],
    '这些模块没有任何测试引用过（连 import 都没有，更谈不上行为断言）。\n' +
      '  补一个真 import 的测试；确实测不到的，加进本文件的 ALLOWED 并写明原因：\n  ' +
      unreferenced.filter((f) => !(f in ALLOWED)).join('\n  ')
  );
  // ② 清单里已经不需要豁免的条目 —— 留着会让清单慢慢变成"谁都能塞"的垃圾桶。
  assert.deepEqual(
    Object.keys(ALLOWED).filter((f) => reachableByTests(f)),
    [],
    '这些模块已经有测试引用了，请从 ALLOWED 里删掉（清单只进不出就会腐烂）'
  );
  // ③ 清单条目必须真的还在（改名/删除后要同步），否则它会永远"静默通过"。
  const missing = Object.keys(ALLOWED).filter((f) => !fs.existsSync(path.join(ROOT, f)));
  assert.deepEqual(missing, [], 'ALLOWED 里有已经不存在的文件，请同步清理');
  // ④ 每条豁免都要有理由 —— 空理由等于没有豁免审查。
  for (const [f, why] of Object.entries(ALLOWED)) {
    assert.ok(String(why).trim().length >= 8, f + ' 的豁免理由太短，写清"为什么不可能被测到"');
  }
});

test('被豁免的模块必须真的被**生产代码**用到（否则它是死代码，不是"没有单测的代码"）', () => {
  // 区分这两件事很重要：一个模块"没有单测"可以接受（清单里写理由），
  // 但"连产品都不 import 它"就是死代码 —— 那该删，不该进清单。
  // 这里检查的是**路径字面量**：裸脚本靠 `files: ['lib/userscript/runner.js']`
  // 或 manifest 的 content_scripts[].js 注入，不会出现在 import 语句里。
  const sources = [
    ...walk(path.join(ROOT, 'lib')),
    ...walk(path.join(ROOT, 'entries')),
    ...['background.js', 'manager.js', 'options.js', 'popup.js', 'skills-page.js', 'userscripts.js'].map((f) =>
      path.join(ROOT, f)
    ),
    path.join(ROOT, 'manifest.json'),
  ];
  const haystack = sources
    .filter((f) => fs.existsSync(f))
    .map((f) => {
      try {
        return fs.readFileSync(f, 'utf8');
      } catch (e) {
        return '';
      }
    })
    .join('\n');
  // 同一个原因的另一处：产品代码里的 specifier 可能还写着 .js，而文件已是 .ts。
  // 两种后缀任一出现就算「被用到」，否则改名会把活模块误判成死代码。
  const dead = Object.keys(ALLOWED).filter((f) => !haystack.includes(f) && !haystack.includes(swapExt(f)));
  assert.deepEqual(dead, [], '这些被豁免的模块在产品代码里也找不到任何引用：是死代码，请删除或接回去');
});

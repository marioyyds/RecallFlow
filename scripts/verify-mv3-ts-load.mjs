#!/usr/bin/env node
// 真 MV3 扩展上下文复验：浏览器能不能加载 `.ts` 文件？
//
// 背景：docs/typescript-migration-plan.md §4.1 只验证了「本地 HTTP + Chromium 里 .ts 是语法错误」
// 这一层，**没在真 MV3 扩展里复验**（当时用 --load-extension 的探测脚本算不出扩展 ID，
// 页面拿到 ERR_BLOCKED_BY_CLIENT）。本脚本用与 tests/e2e/helpers.mjs 相同的
// `launchPersistentContext({ args: ['--load-extension=<root>'] })` 补齐这条证据。
//
// 为什么要 MV3 这一层：V8 是同一个，结论本应相同；但 MV3 有三条**按文件名取文件**的加载路径
// （manifest 直列 / executeScript files / getURL 动态 import），失败形态不同 —— 是
// 「service worker 根本不注册」「content script 静默不执行」「promise reject」，而不是页面报错。
// 三种形态决定了迁移策略要不要引入构建步骤，所以必须分别测到。
//
// 做法：每个场景把仓库根**复制**一份到临时目录（排除 node_modules/.git/测试/站点），
// 只改一处，然后 `--load-extension` 加载。控制组与实验组只差那处改动。
// 不修改工作树，可反复跑：`node scripts/verify-mv3-ts-load.mjs`
//
// 判定：脚本断言「.ts 确实加载失败」这一预期。若哪天 .ts 意外可用（Chrome 上了 type stripping），
// 脚本会以 exit 1 + 醒目提示退出，提醒重新评估策略 —— 那时策略可以简化，但必须有人显式知道。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'tests', 'integrations', 'site', 'repro', 'docs']);
const KEEP_DOCS = ['assets/icon-16.png', 'assets/icon-32.png', 'assets/icon-48.png', 'assets/icon-128.png',
  'assets/recallflow-mark.svg'];

function copyExtension(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(REPO_ROOT)) {
    if (SKIP_DIRS.has(name) || name === 'docs') continue;
    fs.cpSync(path.join(REPO_ROOT, name), path.join(dest, name), { recursive: true });
  }
  for (const rel of KEEP_DOCS) {
    const src = path.join(REPO_ROOT, 'docs', rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.join(dest, 'docs', 'assets'), { recursive: true });
    fs.copyFileSync(src, path.join(dest, 'docs', rel));
  }
}

function readManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
}
function writeManifest(root, m) {
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
}

/** 起一个最小页面服务：content script 需要真实的 http(s) 页面才会注入。 */
function startPageServer() {
  const html = '<!doctype html><meta charset="utf-8"><title>mv3 ts probe</title><body><h1>probe</h1></body>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function launch(root) {
  return chromium.launchPersistentContext('', {
    headless: false, // 技术约束：headless 下 MV3 service worker 不注册（见 tests/e2e/helpers.mjs）
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run'],
  });
}

/** 等 service worker；拿不到就返回 null（= 没注册）。 */
async function waitForSW(context, timeoutMs = 8000) {
  const [early] = context.serviceWorkers();
  if (early) return early;
  try {
    return await context.waitForEvent('serviceworker', { timeout: timeoutMs });
  } catch {
    return null;
  }
}

async function readAttr(page, name, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = await page.evaluate((n) => document.documentElement.getAttribute(n), name);
    if (v && v !== 'pending') return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  return await page.evaluate((n) => document.documentElement.getAttribute(n), name);
}

// ── 场景定义 ────────────────────────────────────────────────────────────────
// 每个场景返回 { name, expect, run(baseDir) -> { observed, detail } }

/**
 * 在 background.js 末尾追加一行「SW 已求值完成」的 storage 标记。
 * 背景是 SW 的模块图求值成功才会执行到这里；任何一个 import 解析/解析失败，这行都到不了。
 */
function appendSwMarker(root) {
  const bg = path.join(root, 'background.js');
  fs.appendFileSync(bg, "\nchrome.storage.local.set({ swProbe: 'booted' });\n");
}

/** content script：读上面的标记并落到 DOM 属性上（content script 与页面共享 DOM，不共享 window）。 */
function probeContentReadsSwMarker(root) {
  fs.writeFileSync(
    path.join(root, 'probe-sw.js'),
    [
      "document.documentElement.setAttribute('data-sw-probe', 'pending');",
      '(function poll(n) {',
      "  chrome.storage.local.get('swProbe').then((r) => {",
      '    if (r && r.swProbe) {',
      "      document.documentElement.setAttribute('data-sw-probe', String(r.swProbe));",
      '      return;',
      '    }',
      "    if (n <= 0) { document.documentElement.setAttribute('data-sw-probe', 'unset'); return; }",
      '    setTimeout(() => poll(n - 1), 250);',
      '  }, () => {',
      "    if (n <= 0) { document.documentElement.setAttribute('data-sw-probe', 'storage-error'); return; }",
      '    setTimeout(() => poll(n - 1), 250);',
      '  });',
      '})(40);',
      '',
    ].join('\n')
  );
  const m = readManifest(root);
  m.content_scripts = [{ matches: ['http://*/*'], js: ['probe-sw.js'], run_at: 'document_idle' }];
  writeManifest(root, m);
}

const TS_PROBE_SW = [
  '// 纯 TS 语法：浏览器按 JS 解析必然 SyntaxError，TS 解析正常。',
  'export const probeValue: number = 1;',
  'export function probe(x: string): string { return x; }',
  '',
].join('\n');

const TS_PROBE_CLASSIC = [
  '// 经典 content script（非 module）里的 TS 类型标注。',
  "document.documentElement.setAttribute('data-ts-probe', 'ran');",
  'var probeNumber: number = 1;',
  'if (probeNumber < 0) document.documentElement.setAttribute(\'data-ts-probe\', \'impossible\');',
  '',
].join('\n');

const JS_PROBE_CLASSIC = [
  '// 与 TS 探针逐行等价，只是去掉类型标注。',
  "document.documentElement.setAttribute('data-ts-probe', 'ran');",
  'var probeNumber = 1;',
  'if (probeNumber < 0) document.documentElement.setAttribute(\'data-ts-probe\', \'impossible\');',
  '',
].join('\n');

const scenarios = [
  {
    id: 'A 控制组：manifest 直列 .js content script',
    expect: 'ran',
    prepare(root) {
      fs.writeFileSync(path.join(root, 'probe-classic.js'), JS_PROBE_CLASSIC);
      const m = readManifest(root);
      m.content_scripts = [{ matches: ['http://*/*'], js: ['probe-classic.js'], run_at: 'document_idle' }];
      writeManifest(root, m);
    },
    async observe(page) {
      return readAttr(page, 'data-ts-probe', 5000);
    },
  },
  {
    id: 'B manifest 直列 .ts content script（同内容，带类型标注）',
    expect: 'unset',
    prepare(root) {
      fs.writeFileSync(path.join(root, 'probe-classic.ts'), TS_PROBE_CLASSIC);
      const m = readManifest(root);
      m.content_scripts = [{ matches: ['http://*/*'], js: ['probe-classic.ts'], run_at: 'document_idle' }];
      writeManifest(root, m);
    },
    async observe(page) {
      // 期望：脚本根本没执行（parse 失败），属性不存在
      await page.waitForTimeout(2500);
      return (await page.evaluate(() => document.documentElement.getAttribute('data-ts-probe'))) ?? 'unset';
    },
  },
  {
    // 控制组：background.js 尾部追加一行 storage 标记，证明「SW 模块图求值成功」是可观测的。
    // 单看 `context.serviceWorkers()` 不够 —— 实测 SW 事件会先于模块求值失败触发，
    // 所以「有没有 worker 对象」不能代表「后台真的跑起来了」。
    id: 'C0 控制组：background.js + storage 启动标记（不涉 .ts）',
    expect: 'booted',
    prepare(root) {
      appendSwMarker(root);
      probeContentReadsSwMarker(root);
    },
    async observe(page) {
      return readAttr(page, 'data-sw-probe', 10000);
    },
  },
  {
    id: 'C service worker `import` 一个 .ts 模块',
    expect: 'unset',
    prepare(root) {
      appendSwMarker(root);
      probeContentReadsSwMarker(root);
      fs.writeFileSync(path.join(root, 'lib', 'shared', 'ts-probe.ts'), TS_PROBE_SW);
      const bg = path.join(root, 'background.js');
      fs.writeFileSync(bg, "import './lib/shared/ts-probe.ts';\n" + fs.readFileSync(bg, 'utf8'));
    },
    async observe(page) {
      return readAttr(page, 'data-sw-probe', 15000);
    },
  },
  {
    id: 'D manifest 的 service_worker 直接指向 .ts',
    expect: 'no-sw',
    prepare(root) {
      fs.writeFileSync(path.join(root, 'background.ts'), fs.readFileSync(path.join(root, 'background.js'), 'utf8'));
      const m = readManifest(root);
      m.background = { service_worker: 'background.ts', type: 'module' };
      writeManifest(root, m);
    },
    async observe(_page, ctx) {
      const sw = await waitForSW(ctx, 8000);
      return sw ? 'sw-registered' : 'no-sw';
    },
  },
  {
    id: 'E getURL + 动态 import 一个 .ts（userscript runner 的加载方式）',
    expect: 'err:*',
    prepare(root) {
      fs.writeFileSync(path.join(root, 'probe-dynamic.ts'), TS_PROBE_SW);
      fs.writeFileSync(path.join(root, 'probe-dynamic.js'), 'export const probeValue = 1;\n');
      fs.writeFileSync(
        path.join(root, 'probe-import.js'),
        [
          "document.documentElement.setAttribute('data-dyn-probe', 'pending');",
          "const url = chrome.runtime.getURL('probe-dynamic.ts');",
          'import(url)',
          "  .then(() => document.documentElement.setAttribute('data-dyn-probe', 'ok:' + url))",
          "  .catch((e) => document.documentElement.setAttribute('data-dyn-probe', 'err:' + (e && e.message)));",
          '',
        ].join('\n')
      );
      const m = readManifest(root);
      m.content_scripts = [{ matches: ['http://*/*'], js: ['probe-import.js'], run_at: 'document_idle' }];
      m.web_accessible_resources = [
        { resources: ['probe-dynamic.ts', 'probe-dynamic.js'], matches: ['http://*/*'] },
      ];
      writeManifest(root, m);
    },
    async observe(page) {
      return readAttr(page, 'data-dyn-probe', 8000);
    },
  },
];

function matches(expect, observed) {
  if (expect === 'err:*') return String(observed).startsWith('err:');
  return expect === observed;
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3-ts-probe-'));
  const { server, port } = await startPageServer();
  const pageUrl = `http://127.0.0.1:${port}/`;
  const rows = [];

  for (const sc of scenarios) {
    const dir = path.join(tmpRoot, sc.id.slice(0, 1));
    copyExtension(dir);
    sc.prepare(dir);

    let observed = 'launch-failed';
    let context;
    try {
      context = await launch(dir);
      const page = await context.newPage();
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
      observed = await sc.observe(page, context);
    } catch (e) {
      observed = 'launch-failed: ' + (e && e.message);
    } finally {
      await context?.close().catch(() => {});
    }
    rows.push({ id: sc.id, expect: sc.expect, observed: String(observed), ok: matches(sc.expect, String(observed)) });
    console.log(`${rows.at(-1).ok ? 'PASS' : 'FAIL'}  ${sc.id}\n      期望 ${sc.expect} / 实测 ${observed}`);
  }

  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log('\n| 场景 | 期望 | 实测 | 结论 |\n| --- | --- | --- | --- |');
  for (const r of rows) console.log(`| ${r.id} | \`${r.expect}\` | \`${r.observed}\` | ${r.ok ? '符合' : '**不符**'} |`);

  const failed = rows.filter((r) => !r.ok);
  if (failed.length) {
    console.error(
      '\n有 ' + failed.length + ' 个场景不符合「浏览器不能加载 .ts」的预期。' +
        '\n若实测是「.ts 可用」，说明 Chrome 已支持 type stripping —— 迁移策略可以简化，' +
        '请把这个结果显式写进 issue，不要默默改断言。'
    );
    process.exitCode = 1;
    return;
  }
  console.log('\n结论：真 MV3 扩展里 .ts 三条加载路径都失败（content script 静默不执行 / service worker 不注册 / 动态 import reject）。');
}

main();

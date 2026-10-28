// 五个扩展内页面（popup / options / manager / skills / userscripts）的**运行时**冒烟门禁。
//
// 为什么需要它（TITA-86 实测教训）：TS 迁移 Batch 5 把 7 个 `entries/*.js` 改成 `.ts` 后，
// `entries/skills-page.ts` 里的 `const $ = (id) => $(id)` 自递归（一次批量替换把 helper
// 自己的 `document.getElementById` 也替换掉了）**通过了 tsc、通过了全部 170 个单测**——
// 因为那些门禁读的是源码文本，没有一条真的把页面跑起来。直到写这个脚本才发现
// `skills.html` 一加载就 RangeError: Maximum call stack size exceeded。
//
// 判据：每个页面在真实 MV3 扩展里加载后
//   ① 没有 pageerror / console.error；
//   ② 该页面的关键节点真的存在（例如 skills 页的列表容器、options 的 API Key 输入框）。
// 不做交互断言 —— 交互由 tests/e2e/*.spec.mjs 覆盖；这里只回答「页面能不能活过首屏」。
//
// 用法：node scripts/verify-extension-pages.mjs
// 需要：真实 Chromium（headless:false 是 MV3 扩展的技术约束，见 tests/e2e/helpers.mjs）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension, closeExtension } from '../tests/e2e/helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PAGES = [
  { file: 'popup.html', name: '弹窗', selectors: ['#add-panel', '#list', '#search-shortcut'] },
  { file: 'options.html', name: '设置页', selectors: ['#api-key', '#model', '.settings-sidebar'] },
  { file: 'manager.html', name: '管理页', selectors: ['#type-tabs', '#list', '#kb-pagination'] },
  { file: 'skills.html', name: '技能页', selectors: ['#skill-list', '#skill-search', '#new-skill-btn'] },
  { file: 'userscripts.html', name: '脚本中心', selectors: ['#us-installed-list', '#us-search-input'] },
];

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push('console.error: ' + msg.text());
  });
  return errors;
}

async function main() {
  const context = await launchExtension({ startServers: false });
  let failed = 0;
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    console.log('扩展 ID：' + extId + '（根目录 ' + ROOT + '）');

    for (const spec of PAGES) {
      const page = await context.newPage();
      const errors = collectErrors(page);
      let status = 'ok';
      try {
        const resp = await page.goto('chrome-extension://' + extId + '/' + spec.file, { waitUntil: 'load' });
        if (!resp || !resp.ok()) status = 'LOAD(' + (resp && resp.status()) + ')';
        await page.waitForTimeout(400);
        for (const sel of spec.selectors) {
          const count = await page.locator(sel).count();
          if (!count) {
            status = 'MISSING(' + sel + ')';
            break;
          }
        }
      } catch (e) {
        status = 'THROW(' + (e && e.message ? e.message : String(e)) + ')';
      }
      if (errors.length) status = 'ERRORS';
      if (status !== 'ok') failed += 1;
      console.log('  ' + (status === 'ok' ? '✔' : '✘') + ' ' + spec.file + '（' + spec.name + '）  ' + status);
      for (const err of errors.slice(0, 5)) console.log('      ' + err.slice(0, 300));
      await page.close();
    }
  } finally {
    await closeExtension(context, { stopServers: false });
  }

  if (failed) {
    console.error('\n有 ' + failed + ' 个扩展内页面没通过首屏冒烟 —— 这是**运行时**门禁，');
    console.error('静态门禁（读源码文本/类型检查）看不到这类失败。');
    process.exit(1);
  }
  console.log('\n五个扩展内页面首屏全部通过（无 pageerror / console.error，关键节点都在）。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

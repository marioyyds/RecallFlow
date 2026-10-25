// 真实浏览器验收：FAB（悬浮气泡）在面板关闭时收起到右缘、悬浮时整颗滑出。
//
// 为什么留一个独立脚本而不是只写单测：
//   tests/fab-peek.test.mjs 跑在 DOM 桩上，桩里没有真实布局 —— 它证明了"状态机切对了 class"，
//   但证明不了真实 Chromium 里那个 class 真的让气泡只露出 12px、以及过渡是真的在跑。
//   「贴右缘」和「平滑」这两件事只能靠 `getBoundingClientRect()` 量出来。
//
// 覆盖：
//   A 冷启动：面板关着 ⇒ 气泡贴右缘，视口里只剩很小一条，且确实还在视口内（能悬浮到）
//   B 悬浮：气泡整颗滑进视口（右缘回到 right:16px 的位置）
//   C 移开：回到收起态
//   D 点气泡：面板照常打开；面板开着时气泡保持"完整显示"（不收起）
//   E 关掉面板：回到收起态
//
// 用法：node repro/fab-peek.mjs        （需要已安装 Playwright 的 Chromium）
// 退出码：0 全过；1 有失败；2 环境缺依赖。
import { launchExtension, closeExtension, openFixturePage } from '../tests/e2e/helpers.mjs';

// 与 lib/page/panel-css.js 里的 `.fab` / `.fab.peek` 保持一致（改了那边，这边要跟着改）。
const FAB_SIZE = 52;
const FAB_RIGHT = 16;
const PEEK_VISIBLE = 12;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
}

function near(a, b, tol = 1.5) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
}

/** 读气泡矩形（穿透 shadow root）。 */
async function fabRect(page) {
  return await page.evaluate(() => {
    const host = document.getElementById('__kb-ai-host');
    const fab = host && host.shadowRoot ? host.shadowRoot.querySelector('.fab') : null;
    if (!fab) return null;
    const r = fab.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      width: r.width,
      height: r.height,
      peeked: fab.classList.contains('peek'),
      hidden: fab.classList.contains('hidden'),
      transition: getComputedStyle(fab).transitionProperty,
    };
  });
}

/**
 * 等矩形收敛后再断言。
 *
 * 气泡是靠 CSS transition 滑的（220ms），读得太早会读到动画中间态 ——
 * 那会把「已经修好」误判成失败，也会把「没修」误判成通过。
 * ① 先等一个大于过渡时长的时间（动画至少跑完了）；
 * ② 再连续两次采样一致，挡住过渡之外的抖动。
 */
async function settled(page, timeout = 2500) {
  await page.waitForTimeout(360);
  const deadline = Date.now() + timeout;
  let prev = null;
  while (Date.now() < deadline) {
    const r = await fabRect(page);
    const key = r ? JSON.stringify(r) : 'null';
    if (r && prev === key) return r;
    prev = key;
    await page.waitForTimeout(120);
  }
  return await fabRect(page);
}

let context;
try {
  context = await launchExtension();
} catch (e) {
  console.error('无法启动浏览器/扩展：' + (e && e.message));
  process.exit(2);
}

try {
  const page = await openFixturePage(context);
  const vp = page.viewportSize();

  // ---- A 冷启动：收起态 ------------------------------------------------
  // ⚠ 全脚本都用**布局视口**宽度（`documentElement.clientWidth`，不含滚动条）：
  // 气泡的 `right` 相对它计算，而 `page.viewportSize()` 给的是含滚动条的
  // `innerWidth`。混用会让点击点偏出一个滚动条宽度 —— 在有滚动条的页面上，
  // Playwright 会把落点夹到 innerWidth，正好压在滚动条上，于是"点不到气泡"。
  const layoutWidth = await page.evaluate(() => document.documentElement.clientWidth);

  const a = await settled(page);
  check('A1 冷启动气泡处于收起态（class=peek）', a && a.peeked === true, a && JSON.stringify(a));
  // 收起态：气泡被整体推到右缘之外 ⇒ 右缘越界，但没越出整颗直径（还露着一条）
  check('A2 气泡大部分隐入视口右缘之外', a && a.right > layoutWidth && a.right < layoutWidth + FAB_SIZE,
    'fab.right=' + (a && a.right) + ' 布局视口宽=' + layoutWidth);
  // 露出宽度 = 直径 − 越出布局视口右缘的那一段
  const visible = a ? a.width - (a.right - layoutWidth) : null;
  check('A3 只露出很小一条（明显小于气泡直径）', visible != null && visible > 0 && visible < FAB_SIZE / 2,
    '露出≈' + visible + 'px / 直径 ' + FAB_SIZE + 'px');

  // ---- B 悬浮：整颗滑出 ----------------------------------------------
  const targetX = layoutWidth - visible / 2;
  const targetY = a.top + a.height / 2;
  await page.mouse.move(targetX, targetY);
  const b = await settled(page);
  check('B1 悬浮后气泡不再收起', b && b.peeked === false, b && JSON.stringify(b));
  check('B2 悬浮后气泡完整落在视口内', b && b.right <= layoutWidth + 0.5 && b.left >= 0,
    'left=' + (b && b.left) + ' right=' + (b && b.right) + ' 布局视口宽=' + layoutWidth);
  check('B3 悬浮后回到 right:16px 的标准位', b && near(layoutWidth - b.right, FAB_RIGHT, 1.5),
    '距右缘 ' + (b && (layoutWidth - b.right)) + 'px');

  // ---- C 移开：回到收起 ----------------------------------------------
  await page.mouse.move(Math.max(4, vp.width / 2), Math.max(4, vp.height - 40));
  const c = await settled(page);
  check('C1 移开后回到收起态', c && c.peeked === true, c && JSON.stringify(c));

  // ---- D 点气泡：面板照常打开 -----------------------------------------
  // 先碰到露出条 ⇒ 整颗滑出；再按**滑出后**的中心点下去（否则会点到气泡之外，
  // 收不到 click —— 这正是 tests/e2e/helpers.mjs 的 clickFab 在做的事）。
  await page.mouse.move(targetX, targetY);
  const h = await settled(page);
  await page.mouse.move(h.left + h.width / 2, h.top + h.height / 2);
  await settled(page);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForFunction(() => {
    const host = document.getElementById('__kb-ai-host');
    return Boolean(host && host.shadowRoot && host.shadowRoot.querySelector('.panel'));
  }, null, { timeout: 5000 });
  const inputVisible = await page.locator('#__kb-ai-host .cmd-input').isVisible().catch(() => false);
  const d = await settled(page);
  check('D1 点气泡仍能打开对话面板', inputVisible === true, 'cmd-input visible=' + inputVisible);
  check('D2 面板打开期间气泡保持完整显示（不收起）', d && d.peeked === false, d && JSON.stringify(d));
  check('D3 面板打开时气泡照旧 hidden（既有行为不变）', d && d.hidden === true);

  // ---- E 关掉面板：回到收起 -------------------------------------------
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const host = document.getElementById('__kb-ai-host');
    return !(host && host.shadowRoot && host.shadowRoot.querySelector('.panel'));
  }, null, { timeout: 5000 });
  await page.mouse.move(Math.max(4, vp.width / 2), Math.max(4, vp.height - 40));
  const e = await settled(page);
  check('E1 面板关掉后回到收起态', e && e.peeked === true, e && JSON.stringify(e));
  check('E2 收起态过渡里带着 right（滑，不是跳）', e && /right/.test(String(e.transition || '')),
    'transition-property=' + (e && e.transition));

  await page.close();
} finally {
  await closeExtension(context);
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.name).join('、'));
  process.exit(1);
}

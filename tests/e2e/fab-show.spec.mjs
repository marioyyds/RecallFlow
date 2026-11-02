// 悬浮球找回 + 嵌入态跟随：两条只能在真浏览器里成立的事实。
//
//   ① 弹窗点「悬浮球」后**不许**出现「无法显示悬浮球，请刷新页面后重试」——
//      修复前它每次都会出现，而球其实已经回来了（内容脚本不接 sendResponse，
//      发送端拿到 "The message port closed before a response was received"）。
//      补注入自愈（孤儿内容脚本）在单测 tests/tab-broadcast.test.mjs 里钉住：
//      这里没法构造那个状态 —— chrome.runtime.reload() 之后 Playwright 的
//      service worker 不再回来，扩展页面也一起失效。
//   ② 嵌入态是**跟随**的：整页跳转、新标签页、跨标签页切换都保持同一形态，
//      页面右侧让出的边距也跟着来回。
//
// 断言方式刻意选"用户看得见的结果"（toast 文案、球的 DOM、body 的 marginRight），
// 而不是内部返回值 —— 这个 bug 的全部危害就在用户看到的那句话上。
import { test, expect } from '@playwright/test';
import { launchExtension, closeExtension, configureSettings, openFixturePage, openPanel, PANEL } from './helpers.mjs';

const FAB = PANEL + ' .fab';
const MENU = PANEL + ' .fab-menu';
const TOAST = '#toast';

let context;

test.beforeAll(async () => {
  context = await launchExtension();
  await configureSettings(context);
});

test.afterAll(async () => {
  await closeExtension(context);
});

/** popup 以**标签页**形式打开（Playwright 拿不到真实 action popup）。 */
async function openPopup(context) {
  const [sw] = context.serviceWorkers();
  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  return page;
}

/** 右键悬浮球 → 「隐藏悬浮球」（面板必须关着，否则球是 hidden 态）。 */
async function hideFab(page) {
  const fab = page.locator(FAB);
  await expect(fab).toHaveCount(1);
  await fab.click({ button: 'right' });
  await page.locator(MENU).waitFor({ state: 'visible' });
  await page.locator(MENU + ' button').nth(1).click();
  await expect(fab).toHaveCount(0);
}

test('弹窗「悬浮球」：成功时必须是「已显示」，且球真的回来', async () => {
  const page = await openFixturePage(context, '/form');
  try {
    await hideFab(page);
    const popup = await openPopup(context);
    await page.bringToFront();
    // popup 以标签页存在时，活动标签页是扩展页 —— 这正是代码里那条回退分支的场景。
    await popup.bringToFront();
    await popup.locator('#show-fab').click();
    await expect(popup.locator(TOAST)).toContainText('悬浮球已显示');
    await expect(popup.locator(TOAST)).not.toContainText('请刷新页面');
    // 用户视角的最终事实：球回到被操作的那一页上。
    await expect(page.locator(FAB)).toHaveCount(1);
  } finally {
    await page.close();
  }
});

test('嵌入态跟着页面走：整页跳转、新标签页、跨标签页开关都保持同一形态', async () => {
  const a = await openFixturePage(context, '/');
  const b = await openFixturePage(context, '/coord');
  try {
    // ① 在 A 上开面板并切成嵌入态。
    await a.locator(FAB).click();
    await expect(a.locator(PANEL + ' .panel')).toBeVisible();
    await a.locator(PANEL + ' .p-head .mode-btn').click();
    await expect(a.locator(PANEL + ' .panel')).toHaveClass(/embedded/);
    const embeddedMargin = async (page) => parseInt(await page.evaluate(() => getComputedStyle(document.body).marginRight), 10);
    expect(await embeddedMargin(a)).toBeGreaterThan(100);

    // ② 另一标签页 B **不用点**就有面板，而且直接是嵌入态
    //   （面板开合是全局状态，广播会把 B 的面板一并打开；布局存档带着 mode/ratio）。
    await expect(b.locator(PANEL + ' .panel')).toHaveClass(/embedded/, { timeout: 10_000 });
    expect(await embeddedMargin(b)).toBeGreaterThan(100);

    // ③ A 整页跳转（不是 SPA）：内容脚本重新注入，仍按全局状态恢复嵌入态。
    await a.goto('http://127.0.0.1:7802/form');
    await expect(a.locator(PANEL + ' .panel')).toHaveClass(/embedded/, { timeout: 10_000 });
    expect(await embeddedMargin(a)).toBeGreaterThan(100);

    // ④ B 切回浮层：A 也必须跟着变回浮层（跨标签页同步，页面右缩要还回去）。
    await b.locator(PANEL + ' .p-head .mode-btn').click();
    await expect(b.locator(PANEL + ' .panel')).not.toHaveClass(/embedded/);
    await expect(a.locator(PANEL + ' .panel')).not.toHaveClass(/embedded/, { timeout: 10_000 });
    expect(await embeddedMargin(a)).toBeLessThan(100);

    // ⑤ A 再切嵌入：B 也回到嵌入态 —— 双向跟随，不是单向广播。
    await a.locator(PANEL + ' .p-head .mode-btn').click();
    await expect(a.locator(PANEL + ' .panel')).toHaveClass(/embedded/);
    await expect(b.locator(PANEL + ' .panel')).toHaveClass(/embedded/, { timeout: 10_000 });
    expect(await embeddedMargin(b)).toBeGreaterThan(100);
  } finally {
    await a.close();
    await b.close();
  }
});
// 「新页面自动嵌入」：用户在任一页把面板切成嵌入态之后，此后每个新页面/新标签页 reload
// 都应当**不用点悬浮球**就自带嵌入层（m00997 的要求）。这里的顺序刻意是「关掉 → 再开新页」：
// 关面板只关当前页，换页仍然自动拉起 —— 否则这条用例只是在重复既有全局开合状态。
test('新页面自动嵌入：选过嵌入态后，新标签页 / 整页跳转 / reload 都自带嵌入层', async () => {
  const a = await openFixturePage(context, '/');
  try {
    await openPanel(a);
    const panel = a.locator(PANEL + ' .panel');
    await expect(panel).toBeVisible();
    if (!/embedded/.test((await panel.getAttribute('class')) || '')) {
      await a.locator(PANEL + ' .p-head .mode-btn').click();
      await expect(panel).toHaveClass(/embedded/);
    }
    // 关上：这一页不要面板了。
    await a.locator(PANEL + ' .p-head .close').click();
    await expect(panel).toHaveCount(0);

    const margin = (page) => page.evaluate(() => parseInt(getComputedStyle(document.body).marginRight, 10));
    const b = await openFixturePage(context, '/coord');
    try {
      // 新标签页：自动嵌入，页面右缩。
      await expect(b.locator(PANEL + ' .panel')).toHaveClass(/embedded/, { timeout: 10_000 });
      expect(await margin(b)).toBeGreaterThan(100);
      // 整页跳转：内容脚本重注入后仍自动嵌入。
      await b.goto('http://127.0.0.1:7802/form');
      await expect(b.locator(PANEL + ' .panel')).toHaveClass(/embedded/, { timeout: 10_000 });
      expect(await margin(b)).toBeGreaterThan(100);
      // reload：同一标签页重载仍自动嵌入。
      await b.reload();
      await expect(b.locator(PANEL + ' .panel')).toHaveClass(/embedded/, { timeout: 10_000 });
      expect(await margin(b)).toBeGreaterThan(100);
    } finally {
      await b.close();
    }
  } finally {
    await a.close();
  }
});

// 用户实测缺陷：模型流式输出时，向上滚动会被下一次增量强制拉回底部。
//
// 根因在 `.p-body` 的 scroll 监听器：它用 `selfScrollMuteUntil` 屏蔽"布局变化造成的
// scroll 事件"，但流式期间 `fitPanelHeight()` 每来一段内容就刷新这个屏蔽窗口 ——
// 用户的真实滚轮事件也被一起吞掉，`observerAutoScroll` 始终保持 true，
// 下一次 `pinToBottom()` 就把视图拽回底部。
//
// 这条用例必须用**真实滚轮**，不能直接写 scrollTop：
// 直接赋值不会产生"用户意图"信号，正好绕开要测的缺陷。
import { test, expect } from '@playwright/test';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  sendInstruction,
  createFreshPanelSession,
  panelText,
  PANEL,
} from './helpers.mjs';

let context;

test.beforeAll(async () => {
  context = await launchExtension();
});

test.beforeEach(async () => {
  await createFreshPanelSession(context);
});

test.afterAll(async () => {
  await closeExtension(context);
});

function gap(page) {
  return page.locator(PANEL + ' .p-body').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

test('流式输出中用户上滚：不被后续增量拉回底部', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  await sendInstruction(page, '验证流式上滚');

  const body = page.locator(PANEL + ' .p-body');
  // 先等内容真的溢出，否则"上滚"没有可滚空间。
  await expect
    .poll(() => body.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 20_000 })
    .toBeGreaterThan(160);

  await body.hover();
  await page.mouse.wheel(0, -600);
  // 用户滚上去之后，视图必须离开底部。
  await expect.poll(() => gap(page), { timeout: 5_000 }).toBeGreaterThan(80);
  const topAfterWheel = await body.evaluate((el) => el.scrollTop);

  // 继续接收新的流式增量：缺陷会把 observerAutoScroll 留在 true，
  // 下一次 pinToBottom 会把 gap 打回 0。
  await page.waitForTimeout(1200);
  expect(await gap(page), '流式增量不得把上滚的用户拽回底部').toBeGreaterThan(80);
  const topLater = await body.evaluate((el) => el.scrollTop);
  expect(topLater, '滚动位置不应跳到底部').toBeLessThanOrEqual(topAfterWheel + 30);

  await page.waitForTimeout(1200);
  expect(await gap(page), '持续流式期间也必须保持用户选择的滚动位置').toBeGreaterThan(80);

  await page.close();
});

test('跟随页在 owner 流式期间必须持续增长（不是只出终稿）', async () => {
  await configureSettings(context);
  const a = await openFixturePage(context);
  await sendInstruction(a, '验证流式上滚');
  await a.waitForTimeout(600);

  const b = await openFixturePage(context);
  await expect(b.locator(PANEL + ' .panel')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => String(await panelText(b, '.p-body') || '').length, { timeout: 5_000 })
    .toBeGreaterThan(20);
  const len1 = String(await panelText(b, '.p-body') || '').length;
  const samples = [len1];
  for (let i = 0; i < 5; i++) {
    await b.waitForTimeout(250);
    samples.push(String(await panelText(b, '.p-body') || '').length);
  }
  const len2 = String(await panelText(b, '.p-body') || '').length;
  expect(len2, '跟随页正文应在流式期间继续增长').toBeGreaterThan(len1 + 20);
  expect(new Set(samples).size, '跟随页应在多个时间点持续更新，而不是一次性刷出').toBeGreaterThan(2);

  await a.close();
  await b.close();
});

// 面板浮在视频等页面上时，输入框里的按键不能被页面的全局快捷键当成页面输入。
import { test, expect } from '@playwright/test';
import { launchExtension, closeExtension, openFixturePage, openPanel, PANEL } from './helpers.mjs';

let context;

test.beforeAll(async () => {
  context = await launchExtension();
});

test.afterAll(async () => {
  await closeExtension(context);
});

test('面板输入空格不会触发页面视频快捷键，面板外快捷键仍正常', async () => {
  const page = await openFixturePage(context, '/video');
  await page.evaluate(() => {
    window.__rfPageSpaceEvents = [];
    for (const type of ['keydown', 'keypress', 'keyup']) {
      document.addEventListener(type, (event) => {
        if (event.code === 'Space' || event.key === ' ') window.__rfPageSpaceEvents.push(type);
      });
    }
  });

  await openPanel(page);
  const input = page.locator(PANEL + ' .cmd-input');
  await input.click();
  await input.pressSequentially('play video');
  await expect(input).toHaveValue('play video');
  expect(await page.evaluate(() => window.__rfPageSpaceEvents)).toEqual([]);

  // 焦点离开面板后，页面自己的全局快捷键必须照常工作；修复不能把页面键盘整体吞掉。
  await page.locator('#fake-play').focus();
  await page.keyboard.press('Space');
  await expect
    .poll(() => page.evaluate(() => window.__rfPageSpaceEvents.length))
    .toBeGreaterThan(0);
});

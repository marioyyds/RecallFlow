// 未配置 API Key 时，面板一打开就要给出提示与可点击的设置入口，
// 不能等用户发完指令才在错误气泡里看到。
import { test, expect } from '@playwright/test';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  openPanel,
  createFreshPanelSession,
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

test('未配置 API Key：打开面板即提示，并提供打开设置的入口', async () => {
  await configureSettings(context, { apiKey: '' });
  const page = await openFixturePage(context);
  await openPanel(page);

  const banner = page.locator(PANEL + ' .api-key-banner');
  await expect(banner).toBeVisible({ timeout: 5_000 });
  await expect(banner).toContainText('尚未配置 API Key');
  const settingsBtn = page.locator(PANEL + ' .api-key-settings');
  await expect(settingsBtn).toBeVisible();

  await settingsBtn.click();
  await expect
    .poll(() => context.pages().some((p) => /options\.html/.test(p.url())), { timeout: 5_000 })
    .toBe(true);
  for (const p of context.pages()) {
    if (/options\.html/.test(p.url())) await p.close().catch(() => {});
  }
  await page.close();
});

test('自动批准浮层：点击面板外或面板其它区域都关闭', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  await openPanel(page);

  const popover = page.locator(PANEL + ' .approval-settings-popover');
  const toggle = page.locator(PANEL + ' .approval-settings-toggle');
  await toggle.click();
  await expect(popover).toBeVisible();
  await expect(page.locator(PANEL + ' .approval-runjs')).toHaveCount(0);
  await expect(popover).not.toContainText('用户脚本 / 技能写入审批');
  await page.mouse.click(5, 5); // 面板外
  await expect(popover).toBeHidden();

  await toggle.click();
  await expect(popover).toBeVisible();
  // 点面板底部（面板内、浮层外）。浮层向上展开，会盖住对话区/头部；
  // 底部页脚在浮层下方，才是真正的"面板其它区域"。
  await page.locator(PANEL + ' .p-foot').click();
  await expect(popover).toBeHidden();
  await page.close();
});

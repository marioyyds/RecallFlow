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

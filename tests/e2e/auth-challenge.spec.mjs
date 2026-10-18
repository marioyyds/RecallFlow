import { test, expect } from '@playwright/test';
import { toolResultsText, resetLlmRequests } from './fixtures/server.mjs';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  createFreshPanelSession,
  sendInstruction,
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

test('登录拦截：面板显示可点击登录入口，模型也收到“不要继续尝试”的提示', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/auth-gate');
  resetLlmRequests();

  await sendInstruction(page, '验证登录拦截');

  const alert = page.locator(PANEL + ' .auth-challenge');
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await expect(alert).toContainText('操作被登录拦截');
  const link = alert.locator('.auth-challenge-link');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'http://127.0.0.1:7802/login?return=/auth-gate');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);

  // 关键不是 UI 上有一行字，而是模型收到了可执行的停止条件与真实链接。
  await expect
    .poll(() => toolResultsText(), { timeout: 10_000 })
    .toContain('登录 / 授权入口：http://127.0.0.1:7802/login?return=/auth-gate');
  expect(toolResultsText()).toContain('不要反复点击');

  // 链接必须真的能打开对应登录页，而不是一个只用于展示的假地址。
  const [loginPage] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await loginPage.waitForLoadState('domcontentloaded');
  expect(loginPage.url()).toContain('/login?return=/auth-gate');
  await expect(loginPage.locator('h1')).toHaveText('账号登录');

  await loginPage.close();
  await page.close();
});

import { test, expect } from '@playwright/test';
import { getLlmRequests, toolResultsText, resetLlmRequests } from './fixtures/server.mjs';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  createFreshPanelSession,
  sendInstruction,
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

test('支付安全：即使全部自动批准，Agent 也不能点击支付按钮', async () => {
  await configureSettings(context, {
    toolApprovalPolicy: { read: true, edit: true, commands: true, browser: true, mcp: true },
  });
  const page = await openFixturePage(context, '/secure-payment');
  resetLlmRequests();
  await sendInstruction(page, '验证安全支付拦截');

  const callout = page.locator(PANEL + ' .sensitive-action');
  await expect(callout).toBeVisible({ timeout: 30_000 });
  await expect(callout).toContainText('支付');
  await expect(callout).toHaveAttribute('data-sensitive-category', 'payment-commit');
  await expect.poll(() => page.evaluate(() => window.__payClicks), { timeout: 5_000 }).toBe(0);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__payClicks), '支付按钮绝不能被自动点击').toBe(0);
  await expect.poll(() => panelText(page, '.p-body'), { timeout: 5_000 }).toContain('Agent 不会自动执行');
  await page.close();
});

test('账号安全：密码输入框在写入前就被硬拦截', async () => {
  await configureSettings(context, {
    toolApprovalPolicy: { read: true, edit: true, commands: true, browser: true, mcp: true },
  });
  const page = await openFixturePage(context, '/secure-account');
  resetLlmRequests();
  await sendInstruction(page, '验证密码输入拦截');

  const callout = page.locator(PANEL + ' .sensitive-action');
  await expect(callout).toBeVisible({ timeout: 30_000 });
  await expect(callout).toContainText('密码');
  await expect(callout).toHaveAttribute('data-sensitive-category', 'account-credentials');
  await expect(page.locator('#password')).toHaveValue('');
  await expect.poll(() => panelText(page, '.p-body'), { timeout: 5_000 }).toContain('Agent 不会代为填写');
  expect(toolResultsText()).not.toContain('RF_SECRET_PASSWORD_888');
  await page.close();
});

test('隐私最小化：页面、输入值、URL token 与 console 哨兵都不得进入 LLM 请求', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/privacy-leak');
  resetLlmRequests();
  await sendInstruction(page, '验证敏感数据脱敏');

  await expect
    .poll(() => panelText(page, '.p-body'), { timeout: 30_000 })
    .toContain('敏感内容已按安全策略隐藏');

  const sentinels = [
    'RF_TEXT_TOKEN_9876',
    'RF_PAGE_PASSWORD_42',
    'RF_QUERY_TOKEN_777',
    'RF_INPUT_PASSWORD_314',
    'RF_CONSOLE_BEARER_555',
  ];
  const requestText = JSON.stringify(getLlmRequests());
  const resultsText = toolResultsText();
  for (const secret of sentinels) {
    expect(requestText, 'LLM 请求泄露：' + secret).not.toContain(secret);
    expect(resultsText, '模型收到的工具结果泄露：' + secret).not.toContain(secret);
  }
  expect(resultsText).toContain('已隐藏');
  await page.close();
});

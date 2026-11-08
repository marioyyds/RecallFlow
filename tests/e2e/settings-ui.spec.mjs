// API Key 可选：本地 OpenAI 兼容服务留空时，面板不能误报"尚未配置"。
import { test, expect } from '@playwright/test';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  openPanel,
  createFreshPanelSession,
  readAiSettings,
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

test('API Key 留空：本地模型仍可直接使用，不显示缺密钥提示', async () => {
  await configureSettings(context, { apiKey: '' });
  const page = await openFixturePage(context);
  await openPanel(page);

  const banner = page.locator(PANEL + ' .api-key-banner');
  await expect(banner).toBeHidden();
  await expect(page.locator(PANEL + ' .cmd-input')).toBeEnabled();
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

test('远程 JEV 配置可保存并在重新打开设置页后恢复', async () => {
  await configureSettings(context);
  const sw = context.serviceWorkers()[0];
  const optionsUrl = await sw.evaluate(() => chrome.runtime.getURL('options.html'));
  const page = await context.newPage();
  await page.goto(optionsUrl);

  await expect(page.locator('#jev-schema-version')).toHaveValue('jev.recallflow.v1');
  await page.locator('#jev-enabled').check();
  await page.locator('#jev-shadow-mode').uncheck();
  await page.locator('#jev-base-url').fill('https://example.com/');
  await page.locator('#jev-api-key').fill('jev-secret');
  await page.locator('#jev-model').fill('jev-action-v1');
  await page.locator('#jev-timeout').fill('8000');
  await page.locator('#jev-retries').fill('2');
  await page.locator('#jev-schema-version').fill('jev.recallflow.v2');
  await page.route('https://example.com/v1/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [
          { name: 'jev-action-v1', description: 'test', release_date: '2026-11-01' },
        ],
      }),
    });
  });
  await page.locator('#test-jev').click();
  await expect(page.locator('#jev-status')).toContainText('连接成功，模型可用');
  await page.locator('#save-btn').click();
  await expect(page.locator('#status')).toContainText('已保存');

  const saved = await readAiSettings(context);
  expect(saved.jev).toEqual({
    enabled: true,
    shadowMode: false,
    baseUrl: 'https://example.com',
    apiKey: 'jev-secret',
    model: 'jev-action-v1',
    requestTimeoutMs: 8000,
    maxRetries: 2,
    schemaVersion: 'jev.recallflow.v2',
  });

  await page.reload();
  await expect(page.locator('#jev-enabled')).toBeChecked();
  await expect(page.locator('#jev-shadow-mode')).not.toBeChecked();
  await expect(page.locator('#jev-base-url')).toHaveValue('https://example.com');
  await expect(page.locator('#jev-api-key')).toHaveValue('jev-secret');
  await expect(page.locator('#jev-model')).toHaveValue('jev-action-v1');
  await expect(page.locator('#jev-timeout')).toHaveValue('8000');
  await expect(page.locator('#jev-retries')).toHaveValue('2');
  await expect(page.locator('#jev-schema-version')).toHaveValue('jev.recallflow.v2');
  await page.close();
});

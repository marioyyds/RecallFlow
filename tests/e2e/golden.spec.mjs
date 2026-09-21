// 端到端「黄金任务」测试：真实 Chromium + 加载扩展 + 模拟 LLM（fixtures/server.mjs）。
// 覆盖：意图路由 → 工具调用（role+name 定位）→ 页面动作 → 收尾。
// 前置：npm i && npx playwright install chromium；扩展需在“开发人员模式”下可加载。
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServers, stopServers } from './fixtures/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..', '..');

let context;
let extensionId;

test.beforeAll(async () => {
  await startServers();
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run'],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  stopServers();
});

async function configure(settings) {
  const sw = context.serviceWorkers()[0];
  await sw.evaluate(async (s) => {
    await chrome.storage.local.set({ aiSettings: s });
  }, settings);
}

function baseSettings(overrides) {
  return Object.assign(
    {
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:7804',
      model: 'mock',
      ragEnabled: false,
      pageContext: true,
      toolApproval: true,
      toolApprovalPolicy: { read: true, edit: true, commands: true, browser: true, mcp: true },
      cdpEnabled: false,
      quickPrompts: [],
      agentBudget: {},
    },
    overrides || {}
  );
}

test('golden: 用 role+name 定位并点击页面按钮', async () => {
  await configure(baseSettings());
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:7802/');

  // 打开助手面板（FAB 在 open shadow DOM 内，Playwright CSS 会穿透）
  await page.locator('#__kb-ai-host .fab').click();
  await page.locator('#__kb-ai-host .cmd-input').fill('点击提交按钮');
  await page.locator('#__kb-ai-host .cmd-send').click();

  // 断言页面按钮确实被点击（模拟 LLM 会返回 click_element({role:'button',name:'提交'})）
  await expect.poll(() => page.evaluate(() => window.__clicked), { timeout: 30_000 }).toBe(true);
  await page.close();
});

test('golden: 跨域 iframe 内点击（frame 路由 + f<frameId>: 前缀 ref）', async () => {
  await configure(baseSettings());
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:7802/');

  await page.locator('#__kb-ai-host .fab').click();
  await page.locator('#__kb-ai-host .cmd-input').fill('点击框架里的按钮');
  await page.locator('#__kb-ai-host .cmd-send').click();

  // 模拟 LLM 先 includeFrames 读快照，再按 f<frameId>: 前缀 ref 点击；断言跨域 iframe 内被点击。
  await expect
    .poll(
      async () => {
        const frame = page.frames().find((f) => f.url().includes('7803'));
        if (!frame) return false;
        return frame.evaluate(() => window.__frameClicked === true).catch(() => false);
      },
      { timeout: 40_000 }
    )
    .toBe(true);

  await page.close();
});

import { defineConfig } from '@playwright/test';

// E2E 需要真实 Chromium（加载扩展 + chrome.debugger）。安装：npm i && npx playwright install chromium
// 运行：node scripts/run-e2e.mjs（或 npx playwright test -c tests/e2e/playwright.config.mjs）
//
// **为什么必须是 headless:false**：实测在 Playwright 1.64 + Chromium 里用
// `headless: true` 启动持久化上下文时，MV3 扩展的 service worker **根本不会注册**
//（`context.serviceWorkers()` 为空、等待 serviceworker 事件超时）。扩展起不来，
// 这套测试就无从谈起 —— 因此这不是"忘了开 headless"，而是当前技术约束。
// 想在 CI 跑，需要一台虚拟显示（Linux 上 xvfb-run），而不是把这里改成 true。
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
});

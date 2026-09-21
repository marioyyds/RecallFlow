import { defineConfig } from '@playwright/test';

// E2E 需要真实 Chromium（加载扩展 + chrome.debugger）。安装：npm i && npx playwright install chromium
// 运行：npm run test:e2e
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
});

import { defineConfig } from '@playwright/test';

// 真实站点实验室：与 tests/e2e 同一个技术约束 —— 必须 headless:false（MV3 扩展的
// service worker 在 headless 下不注册）。**不进 CI**：真实站点随时会改版，断言会碎。
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
});

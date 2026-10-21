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
  // 真实站点：网络抖动、登录态过期、页面改版都可能让首次失败，这里重试是必要的。
  // 本地同样不重试 —— live 用例靠 E2E_LIVE=1 显式开启，跑的人就是要看真实结果。
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
});

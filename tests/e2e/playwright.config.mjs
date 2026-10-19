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
  // 重试只在 CI 上开：真实浏览器 + 真实扩展 + 模拟 LLM 的组合里，偶发的
  // 时序抖动（service worker 首次唤醒、CDP 附加竞态）是**已知且可接受**的，
  // 让 CI 红一次再绿一次比让人去猜 flaky 便宜。
  // 本地**刻意不重试**：本地跑就是要看见第一次失败，重试会把真 bug 藏起来 ——
  // 这正是"门禁只在被强制运行时才存在"之外的另一条纪律：失败必须可见。
  retries: process.env.CI ? 2 : 0,
  // 失败时保留 trace 与截图：定位流式/时序问题时比复跑猜状态快得多。
  // 不默认录屏，避免每个用例都增加 I/O 和体积。
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  reporter: [['list']],
});

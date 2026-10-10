// 断线恢复的端到端验证（**独立文件**，因为它需要夹具进入"挂起"模式）。
//
// 为什么单独一份：这条测试要求模拟 LLM **第一次**调用时挂起不结束，
// 从而确定地构造出"流已开始、尚未结束"的可中断窗口。
// 而其它黄金任务需要流正常结束 —— 混在同一个文件里会让"第一次调用"的归属
// 取决于执行顺序，测试就会时好时坏（实测踩过）。
// 由 scripts/run-e2e.mjs 分两阶段运行，各自设置对应的环境变量。
//
// 被验证的行为：端口断开（等价于 MV3 worker 被回收）后，面板用**同一个 runId** 重连，
// 后台接着把任务跑完。断言两条：
//   ① 任务最终完成（按钮被点击）—— 若重连不发生，端口一断这条永远不成立；
//   ② 后台**跑了不止一次** —— 区分"重连接着跑"与"第一次自己就跑完了"。
//      少了这条，测试会在"根本没断成功"的情况下假通过（这正是前几轮发生的事）。
import { test, expect } from '@playwright/test';
import { launchExtension, closeExtension, configureSettings, openFixturePage, openPanel, PANEL } from './helpers.mjs';

let context;

test.beforeAll(async () => {
  context = await launchExtension();
});

test.afterAll(async () => {
  await closeExtension(context);
});

test('golden: 端口断开后自动重连并接着跑完', async () => {
  await configureSettings(context);
  const sw = context.serviceWorkers()[0];
  const logs = [];
  sw.on('console', (m) => logs.push(m.text()));

  const page = await openFixturePage(context);
  await openPanel(page);
  await page.locator(PANEL + ' .cmd-input').fill('点击提交按钮');

  // 注册跨世界事件回执（面板在隔离世界，page.evaluate 看不到它的全局对象）
  await page.evaluate(() => {
    window.__rfE2EDropped = false;
    window.addEventListener('__RF_E2E__dropped', () => { window.__rfE2EDropped = true; });
  });

  await page.locator(PANEL + ' .cmd-send').click();

  // 等后台真的开始跑（用它自己的日志，而不是猜 DOM）
  await expect.poll(() => logs.some((t) => t.includes('agent run start')), { timeout: 20_000 }).toBe(true);
  // 夹具已把这次流挂起 → 此刻必定处于"流已开始、尚未结束"，断线必然落在生成中
  await page.waitForTimeout(500);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('__RF_E2E__dropPort')));
  expect(await page.evaluate(() => window.__rfE2EDropped === true), '面板应收到跨世界事件并断开端口').toBe(true);

  // ① 任务最终完成
  await expect.poll(() => page.evaluate(() => window.__clicked), { timeout: 30_000 }).toBe(true);
  // ② 后台跑了不止一次（证明是重连接着跑，而不是第一次就自己跑完了）
  await expect
    .poll(() => logs.filter((t) => t.includes('agent run start')).length, { timeout: 15_000 })
    .toBeGreaterThan(1);

  await page.close();
});

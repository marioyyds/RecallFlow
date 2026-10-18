// 刷新接管的两个时序边界：
//   ① 刷新发生在**后台工具执行中**（工具在 SW 里跑，不依赖旧页面 port）；
//   ② run 恰好在**新页面加载完成之前**结束（旧页面已销毁，没人做 UI 收尾）。
//
// 两个都比"LLM 正在流式输出"更难：前者没有持续的事件流可以顺带重连，
// 后者必须靠 finished snapshot 把最终回答补回新面板。
import { test, expect } from '@playwright/test';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  sendInstruction,
  createFreshPanelSession,
  panelText,
  PANEL,
} from './helpers.mjs';
import { finalizedRunCount } from './fixtures/server.mjs';

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

async function resetStats() {
  const sw = context.serviceWorkers()[0];
  await sw.evaluate(() => {
    globalThis.__rfDebugStats = true;
    if (globalThis.__rfRunStats) Object.assign(globalThis.__rfRunStats, { starts: 0, reattaches: 0, aborts: 0 });
  });
  return sw;
}

async function safePanelText(page) {
  // 导航窗口里 page.evaluate 可能撞上 "Execution context was destroyed"。
  try {
    return await panelText(page, '.p-body');
  } catch (e) {
    return '';
  }
}

test('刷新发生在后台工具执行中：run 不断，工具结果回到新面板', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  const sw = await resetStats();
  await sendInstruction(page, '验证工具执行中刷新');

  // 工具调用事件在真正执行前就发出了；看到 fetch_webpage 说明它正在 SW 里等待慢响应。
  await expect.poll(() => safePanelText(page), { timeout: 10_000 }).toContain('fetch_webpage');
  await page.reload();

  await expect.poll(() => finalizedRunCount(), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => safePanelText(page), { timeout: 15_000 }).toContain('慢响应完成，任务继续');
  const stats = await sw.evaluate(() => Object.assign({}, globalThis.__rfRunStats));
  expect(stats.starts, '刷新不应启动第二个 run').toBe(1);
  expect(stats.reattaches, '工具执行中刷新也必须 reattach').toBeGreaterThanOrEqual(1);
  expect(stats.aborts, '工具执行中刷新不得 abort run').toBe(0);
  await page.close();
});

test('run 在新页面加载完成前结束：最终回复仍要补回面板', async () => {
  await configureSettings(context);
  // 这个页面用一个延迟 1.5s 的图片拖慢 load，制造"旧页面已死、新面板还没起来"的窗口。
  const page = await openFixturePage(context, '/slow-reload');
  const sw = await resetStats();
  await sendInstruction(page, '验证刷新窗口完成');

  // 夹具会点击 #reload 并导航到 ?slow=1；先等导航真的开始，再等最终回复在新文档里出现。
  await expect(page).toHaveURL(/slow=1/, { timeout: 10_000 });
  await expect.poll(() => finalizedRunCount(), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => safePanelText(page), { timeout: 20_000 }).toContain('刷新窗口完成，最终回复已恢复');
  await expect(page.locator(PANEL + ' .msg.user')).toHaveCount(1);
  await expect(
    page.locator(PANEL + ' .agent-content').filter({ hasText: '刷新窗口完成，最终回复已恢复' })
  ).toHaveCount(1);

  const stats = await sw.evaluate(() => Object.assign({}, globalThis.__rfRunStats));
  expect(stats.starts, '窗口内完成也不应启动第二个 run').toBe(1);
  expect(stats.aborts, '窗口内完成不得 abort run').toBe(0);
  // 这条用例刻意让新页面晚 6s 才返回，run 应该已经在窗口内结束；
  // 若这里变成 reattach，说明测试没造出"完成窗口"，覆盖就退化了。
  expect(stats.reattaches, '本用例应走 finished snapshot 兜底，而不是 reattach').toBe(0);
  await page.close();
});

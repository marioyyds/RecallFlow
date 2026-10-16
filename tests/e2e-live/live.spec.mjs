// 真实站点实验室（T1）：真 Chromium + 装扩展 + 脚本化模型，但页面是**真实站点**。
//
// 与 tests/e2e/golden.spec.mjs 的区别只有一点：goto 的是真实 URL，而不是夹具页。
// 它验证的是定位器 / 时序 / 登录态在真实 DOM 上的成色，不花真钱（模型决定是脚本化的）。
//
// **默认不跑**：真实站点随时会变，断不了就碎。用 E2E_LIVE=1 显式打开：
//   E2E_LIVE=1 node scripts/run-e2e-live.mjs
import { test, expect } from '@playwright/test';
import { LIVE_SITES } from './sites.mjs';
import { launchExtension, closeExtension, configureSettings, sendInstruction, readKnowledgeBase, resetKnowledgeBase } from '../e2e/helpers.mjs';
import { resetLlmRequests, finalizedRunCount } from '../e2e/fixtures/server.mjs';

const LIVE = /^(1|true|yes)$/i.test(String(process.env.E2E_LIVE || ''));
const FLAKY = /^(1|true|yes)$/i.test(String(process.env.E2E_LIVE_FLAKY || ''));
test.skip(!LIVE, '真实站点实验室默认不跑：E2E_LIVE=1 node scripts/run-e2e-live.mjs');

let context;

test.beforeAll(async () => {
  context = await launchExtension();
});

test.afterAll(async () => {
  await closeExtension(context);
});

for (const site of LIVE_SITES) {
  test(`live: ${site.name}`, async () => {
    test.skip(site.flaky && !FLAKY, '该站点已知会被安全验证/反爬拦截（见 sites.mjs 的 flaky 说明），需 E2E_LIVE_FLAKY=1 才跑');
    await configureSettings(context);
    await resetKnowledgeBase(context);

    const page = await context.newPage();
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    resetLlmRequests();
    await sendInstruction(page, site.instruction);

    // 先断言**这一轮真的正常跑完**：否则一个 stalled 的 run（页面判据恰好已满足）
    // 会被静默放过去 —— GitHub 仓库页"卡在第一次快照"就是这种形态。
    //
    // 例外：全页跳转（表单提交）会中断本轮 run（已知产品缺口，见 sites.mjs 的
    // navigationInterruptsRun），这类站点以页面判据为准，不再要求 mock 收到 finalText。
    if (!site.navigationInterruptsRun) {
      await expect
        .poll(() => finalizedRunCount(), { timeout: 90_000, message: '本轮 run 应在超时前正常结束（mock 未收到 finalText）' })
        .toBeGreaterThan(0);
    }

    // 页面判据：站点自己的数据，不是「工具返回 ok」。
    for (const c of site.checks) {
      // 真实站点会重定向/慢加载：evaluate 可能撞上"执行上下文已销毁"，这里吞掉并重试。
      await expect.poll(() => page.evaluate(c.expr).catch(() => false), { timeout: 90_000, message: c.label }).toBe(true);
    }

    // 知识库判据（可选）：调研成果真的沉淀进扩展侧存储。
    if (site.knowledge) {
      await expect
        .poll(
          async () => {
            const book = await readKnowledgeBase(context);
            return Object.values(book).some(
              (it) => it.title === site.knowledge.title && String(it.note || '').includes(site.knowledge.noteIncludes)
            );
          },
          { timeout: 40_000, message: '知识库应写入「' + site.knowledge.title + '」' }
        )
        .toBe(true);
    }

    await page.close();
  });
}

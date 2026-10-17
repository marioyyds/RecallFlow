// 真模型 eval（第三层，**真实站点版**）：让真实模型在真实站点上自己决定用哪些工具。
//
// 与 real-model.eval.mjs 的区别只有一点：goto 的是真实 URL（tests/e2e-live/sites.mjs），
// 判据用同一份 sites.mjs 的 checks / knowledge —— 所以"脚本下能过、真模型下不能过"
// 仍然能归因到"能力问题 vs 文案问题"。
//
// 跑法：E2E_EVAL_LIVE=1 RECALLFLOW_EVAL_API_KEY=sk-xxx node scripts/eval-real-model-live.mjs
// 纪律与 real-model.eval.mjs 相同：不进 CI、不追绿、失败先看工具轨迹。
import { test, expect } from '@playwright/test';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  sendInstruction,
  readKnowledgeBase,
  resetKnowledgeBase,
  PANEL,
} from '../e2e/helpers.mjs';
import { LIVE_SITES } from '../e2e-live/sites.mjs';
import { getLlmRequests, resetLlmRequests } from '../e2e/fixtures/server.mjs';

const LIVE = /^(1|true|yes)$/i.test(String(process.env.E2E_EVAL_LIVE || ''));
const FLAKY = /^(1|true|yes)$/i.test(String(process.env.E2E_LIVE_FLAKY || ''));
const SITE_FILTER = String(process.env.E2E_LIVE_SITE || '').trim();
test.skip(!LIVE, '真实站点真模型 eval 需要 E2E_EVAL_LIVE=1（见 scripts/eval-real-model-live.mjs）');

let context;
test.beforeAll(async () => {
  if (!/^(1|true|yes)$/i.test(String(process.env.E2E_LLM_REAL || ''))) {
    throw new Error('未开启真模型模式：请用 node scripts/eval-real-model-live.mjs 运行');
  }
  context = await launchExtension();
});
test.afterAll(async () => { await closeExtension(context); });

// 与 real-model.eval.mjs 同一套：先等开始、再等结束，避免"还没开始就判分"。
async function waitForRunToFinish(page) {
  const stop = page.locator(PANEL + ' .stop-btn');
  await stop.waitFor({ state: 'visible', timeout: 30_000 });
  await stop.waitFor({ state: 'hidden', timeout: 420_000 });
}

// 与 real-model.eval.mjs 同一套：按 tool_call id 去重后打印轨迹。
function printTrace(title) {
  const reqs = getLlmRequests();
  const seen = new Set();
  const calls = [];
  for (const r of reqs) {
    for (const m of r.messages || []) {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      for (const tc of m.tool_calls) {
        const id = (tc && tc.id) || (tc.function && tc.function.name) + '|' + String((tc.function && tc.function.arguments) || '');
        if (seen.has(id)) continue;
        seen.add(id);
        calls.push((tc.function && tc.function.name) + '(' + String((tc.function && tc.function.arguments) || '').slice(0, 110) + ')');
      }
    }
  }
  console.log('\n===== ' + title + ' =====');
  console.log('LLM 请求次数：' + reqs.length + '；模型发起的工具调用（去重）' + calls.length + ' 次');
  calls.forEach((c, i) => console.log('  ' + (i + 1) + '. ' + c));
}

for (const site of LIVE_SITES) {
  test('eval-live(真模型): ' + site.name, async () => {
    test.skip(site.flaky && !FLAKY, 'flaky 站点默认跳过（E2E_LIVE_FLAKY=1 才跑）');
    test.skip(Boolean(SITE_FILTER) && site.id !== SITE_FILTER, 'E2E_LIVE_SITE=' + SITE_FILTER + ' 只跑指定站点');
    await configureSettings(context);
    await resetKnowledgeBase(context);
    const page = await context.newPage();
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    resetLlmRequests();
    await sendInstruction(page, site.instruction);

    // 真模型可能索要 alwaysRequireApproval 工具，点掉并计数（与 real-model.eval.mjs 同口径）。
    let approvals = 0;
    let running = true;
    const approveLoop = (async () => {
      while (running) {
        const btn = page.locator(PANEL + ' .tool-approve');
        try {
          if ((await btn.count()) > 0 && (await btn.first().isVisible())) {
            approvals += 1;
            await btn.first().click({ timeout: 2000 });
            await btn.first().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
          }
        } catch (e) { /* 竞态，忽略 */ }
        await page.waitForTimeout(300);
      }
    })();

    let finished = true;
    try {
      await waitForRunToFinish(page);
    } catch (e) {
      finished = false;
    }
    running = false;
    await approveLoop;
    printTrace(site.name);
    console.log('审批按钮点击次数（上界）：' + approvals);
    expect(finished, '这一轮没有跑完（超时）。先看上面的工具轨迹。').toBe(true);

    // 页面判据：站点自己的数据（与脚本化 live spec 同一套表达式）。
    const GRACE_MS = 8000;
    const results = [];
    for (const c of site.checks) {
      let ok = false;
      const started = Date.now();
      for (;;) {
        ok = await page.evaluate((expr) => {
          try { return Boolean(new Function('return (' + expr + ')')()); } catch (e) { return false; }
        }, c.expr);
        if (ok || Date.now() - started >= GRACE_MS) break;
        await page.waitForTimeout(250);
      }
      results.push({ label: c.label, ok });
    }
    const failed = results.filter((r) => !r.ok);
    console.log('判据：\n' + results.map((r) => (r.ok ? '  ✓ ' : '  ✗ ') + r.label).join('\n'));
    expect(failed.map((f) => f.label), '页面状态判据未通过 —— 先看上面的工具轨迹。').toEqual([]);

    if (site.knowledge) {
      const book = await readKnowledgeBase(context);
      const hit = Object.values(book).some((it) => it.title === site.knowledge.title && String(it.note || '').includes(site.knowledge.noteIncludes));
      console.log('知识库：' + (hit ? '  ✓ ' : '  ✗ ') + site.knowledge.title);
      expect(hit, '知识库未写入「' + site.knowledge.title + '」').toBe(true);
    }

    await page.close();
  });
}

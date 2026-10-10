// 真模型 eval（第三层）：让**真实模型自己决定**用哪些工具，看它能不能完成能力剧本。
//
// ## 它回答什么、不回答什么
//
//   常规 E2E（tests/e2e/）     → 能力成不成立（脚本替模型做决定）
//   **本文件**                → 技能文案对真模型有没有用（模型自己做决定）
//
// 两者用**同一套夹具服务、同一套页面判据**，只换掉"谁在做决定"。
// 这是刻意的：否则"脚本下能过、真模型下不能过"就无法归因是能力问题还是文案问题。
//
// ## 纪律（很重要）
//
//   · **不进 CI**：需要真 key（花钱），且结果非确定。
//   · **不追绿**：一次没过不等于坏，一次过了也不等于好。要看的是**趋势**与**失败时的工具轨迹**。
//   · **失败必须先看轨迹再改文案**：模型可能绕了远路但做成了（文案不够省），
//     也可能压根没找到页面能力（能力/提示问题）——这两者的修法完全不同。
import { test, expect } from '@playwright/test';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  sendInstruction,
  PANEL,
} from '../e2e/helpers.mjs';
import { evalPlaybooks } from '../e2e/fixtures/playbooks.mjs';
import { getLlmRequests, lastToolResultsText } from '../e2e/fixtures/server.mjs';

let context;

test.beforeAll(async () => {
  // 夹具已在 E2E_LLM_REAL=1 时代理到真实端点（见 fixtures/server.mjs）。
  if (!/^(1|true|yes)$/i.test(String(process.env.E2E_LLM_REAL || ''))) {
    throw new Error('未开启真模型模式：请用 node scripts/eval-real-model.mjs 运行，而不是直接跑 playwright');
  }
  context = await launchExtension();
});

test.afterAll(async () => {
  await closeExtension(context);
});

/** 把模型的工具轨迹打印出来 —— 失败时**先看它**，再决定改什么。 */
function printTrace(title) {
  const reqs = getLlmRequests();
  const calls = [];
  for (const r of reqs) {
    for (const m of r.messages || []) {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      for (const tc of m.tool_calls) {
        calls.push((tc.function && tc.function.name) + '(' + String((tc.function && tc.function.arguments) || '').slice(0, 90) + ')');
      }
    }
  }
  console.log('\n===== ' + title + ' =====');
  console.log('LLM 请求次数：' + reqs.length + '；工具调用 ' + calls.length + ' 次');
  calls.forEach((c, i) => console.log('  ' + (i + 1) + '. ' + c));
}

for (const pb of evalPlaybooks()) {
  const ev = pb.eval;
  test('eval(真模型): ' + pb.title, async () => {
    await configureSettings(context, { model: 'eval' });
    const page = await openFixturePage(context, ev.url);
    await sendInstruction(page, ev.instruction);

    // 等这一轮真的结束（面板不再有「正在等待/生成」的指示），再判分。
    // 不用固定 sleep：真模型耗时从几秒到几十秒不等。
    await expect
      .poll(
        async () =>
          page.evaluate((sel) => {
            const host = document.querySelector(sel);
            const root = host && host.shadowRoot ? host.shadowRoot : document;
            // 面板在跑的时候停止按钮可见；跑完会收起。
            const stop = root.querySelector('.cmd-stop');
            return !stop || stop.style.display === 'none' || getComputedStyle(stop).display === 'none';
          }, PANEL),
        { timeout: 170_000 }
      )
      .toBe(true);

    printTrace(pb.title);

    // ① 页面判据（与脚本化 E2E 同一套表达式）
    const results = [];
    for (const c of ev.pageChecks) {
      const ok = await page.evaluate((expr) => {
        try {
          // eslint-disable-next-line no-new-func
          return Boolean(new Function('return (' + expr + ')')());
        } catch (e) {
          return false;
        }
      }, c.expr);
      results.push({ label: c.label, ok });
    }

    // ② "数据有没有交到模型手上"（与脚本化 E2E 同一条判据）
    const seen = lastToolResultsText();
    const missed = ev.mustSeeInToolResults.filter((s) => !seen.includes(s));

    const failed = results.filter((r) => !r.ok);
    const lines = results.map((r) => (r.ok ? '  ✓ ' : '  ✗ ') + r.label);
    if (missed.length) lines.push('  ✗ 工具结果里缺少：' + missed.join('、'));
    console.log('判据：\n' + lines.join('\n'));

    // 逐条断言，报错信息里带上"该看什么"，而不是只说 expect 失败
    expect(
      failed.map((f) => f.label),
      '页面状态判据未通过 —— 先看上面的工具轨迹：模型是**没找到页面能力**，还是**绕了远路但没做成**？'
    ).toEqual([]);
    expect(
      missed,
      '工具结果里没有这些数据 —— 说明模型没把结果读回来（而不是它答错了）'
    ).toEqual([]);

    await page.close();
  });
}

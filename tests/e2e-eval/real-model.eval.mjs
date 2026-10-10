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
import { getLlmRequests, toolResultsText, resetLlmRequests } from '../e2e/fixtures/server.mjs';

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

/** 等一轮真的跑完。
 *
 *  ⚠ 必须**先等它开始，再等它结束**。曾经只判断"`.stop-btn` 不可见"就当作跑完 ——
 *  而它在跑之前本来就是隐藏的，于是 poll 立刻返回 true，**在任务还没开始时就判分**，
 *  结论完全是噪声。这个坑很隐蔽：用例会"通过"，但通过的原因与能力无关。
 *
 *  顺带修了一个更基础的错误：原写法查的是 `.cmd-stop`，而面板里真正的停止按钮是
 *  `.stop-btn`（`cmd-stop` 根本不存在）—— 也就是恒定命中"跑完了"。
 */
async function waitForRunToFinish(page) {
  const stop = page.locator(PANEL + ' .stop-btn');
  await stop.waitFor({ state: 'visible', timeout: 30_000 });
  await stop.waitFor({ state: 'hidden', timeout: 170_000 });
}

/** 把模型的工具轨迹打印出来 —— 失败时**先看它**，再决定改什么。
 *
 *  ⚠ 必须按 tool_call id **去重**：多轮工具调用里，每个后续请求都会带上此前的全部历史，
 *  于是同一个调用会在多个请求里重复出现。不去重就会把 4 次调用报成 10 次，
 *  让模型看起来比实际浪费得多 —— 而"看轨迹判断它是否绕路"正是这一层的核心用途，
 *  数字必须先可信。
 *  顺带修了一个更基础的问题：原写法在**没有任何工具调用**时会打印 0，
 *  但"0 次调用却完成了任务"与"根本没跑"是两件事，所以同时打印请求数与去重后的调用数。
 */
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
  return calls;
}

/** 打印**最后一次请求**里的全部工具结果。
 *
 *  为什么是"最后一次请求"而不是逐请求打印：每个后续请求都会带上此前的全部历史，
 *  逐请求打印会把同一条结果重复输出十几遍。最后一次请求里的 tool 消息 = 整轮的完整结果集。
 *  为什么必须打印它：只看"模型调用了什么"无法判断失败原因 ——
 *  工具可能返回了错误（选择器没命中 / 定位失败 / 参数非法），而轨迹上看不出来。
 */
function printToolResults(limit = 240) {
  const reqs = getLlmRequests();
  const last = reqs[reqs.length - 1];
  if (!last) return;
  const tools = (last.messages || []).filter((m) => m.role === 'tool');
  console.log('工具结果（共 ' + tools.length + ' 条，各截断到 ' + limit + ' 字）：');
  tools.forEach((m, i) => {
    console.log('  [' + (i + 1) + '] ' + String(m.content || '').replace(/\s+/g, ' ').slice(0, limit));
  });
}

for (const pb of evalPlaybooks()) {
  const ev = pb.eval;
  test('eval(真模型): ' + pb.title, async () => {
    const model = process.env.RECALLFLOW_EVAL_MODEL || 'deepseek-chat';
    await configureSettings(context, { model });
    const page = await openFixturePage(context, ev.url);
    resetLlmRequests();
    await sendInstruction(page, ev.instruction);

    // 真模型可能选到 alwaysRequireApproval 的工具（run_javascript / run_userscript /
    // install_userscript）—— 那三个**任何审批策略都不放行**，必须点掉，否则整轮卡死到超时。
    // 这里把它点掉并**记下次数**：模型是否频繁索要高危工具，本身就是有价值的观察。
    let approvals = 0;
    let running = true;
    const approveLoop = (async () => {
      while (running) {
        const btn = page.locator(PANEL + ' .tool-approve');
        try {
          if ((await btn.count()) > 0 && (await btn.first().isVisible())) {
            approvals += 1;
            await btn.first().click({ timeout: 2000 });
          }
        } catch (e) {
          /* 按钮消失/被替换都是正常竞态，忽略 */
        }
        await page.waitForTimeout(400);
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

    printTrace(pb.title);
    printToolResults();
    console.log('自动批准的审批次数：' + approvals + (approvals ? '（模型索要了高危工具）' : ''));
    expect(finished, '这一轮没有跑完（超时）。先看上面的工具轨迹：是卡在某个工具上，还是模型绕圈？').toBe(true);

    // ① 页面判据（与脚本化 E2E 同一套表达式）
    const results = [];
    for (const c of ev.pageChecks) {
      const ok = await page.evaluate((expr) => {
        try {
          return Boolean(new Function('return (' + expr + ')')());
        } catch (e) {
          return false;
        }
      }, c.expr);
      results.push({ label: c.label, ok });
    }

    // ② "数据有没有交到模型手上"（与脚本化 E2E 同一条判据）
    const seen = toolResultsText();
    const missed = ev.mustSeeInToolResults.filter((s) => !seen.includes(s));

    const failed = results.filter((r) => !r.ok);
    const lines = results.map((r) => (r.ok ? '  ✓ ' : '  ✗ ') + r.label);
    if (missed.length) lines.push('  ✗ 工具结果里缺少：' + missed.join('、'));
    console.log('判据：\n' + lines.join('\n'));

    expect(
      failed.map((f) => f.label),
      '页面状态判据未通过 —— 先看上面的工具轨迹：模型是**没找到页面能力**，还是**绕了远路但没做成**？'
    ).toEqual([]);
    expect(missed, '工具结果里没有这些数据 —— 说明模型没把结果读回来（而不是它答错了）').toEqual([]);

    await page.close();
  });
}

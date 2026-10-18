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
  resolveInstruction,
  panelText,
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
  // ⚠ 上限从 170s 提到 280s：第五轮实测 `multi-candidate-convergence` 曾因"等刷新"绕圈
  //   在 2.9m 处被**原来的上限**掐掉（不是模型做不完，而是它被掐在收尾前）。
  //   配套地，夹具把"等刷新"的代价从 2000ms 降到 700ms（见 server.mjs 的 REFRESH_MS）。
  // ⚠ 上限从 170s 提到 280s，再提到 **420s**：
  //   ① 第五轮实测 `multi-candidate-convergence` 曾因"等刷新"绕圈在 2.9m 被**原来的上限**掐掉；
  //   ② 富文本实测：模型在 180s（当时的测试超时）处已跑 **53 次**工具调用，
  //      提到 360s 后又出现"**跑了 55 次仍未收尾**、被 280s 的**运行上限**掐掉" ⇒ 读数不可信 ✗
  //   ⇒ 运行上限与测试超时**必须配套**（测试超时 = 运行上限 + 起停余量，见 playwright.config.mjs 的 540s）。
  //   ⚠ 再往上就要问"模型是不是在绕圈"了：420s / 50+ 次调用已经很宽 ✓
  await stop.waitFor({ state: 'hidden', timeout: 420_000 });
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
  // 把**完成校验器**的调用单独数出来（它和 Agent 走同一个 callDeepSeek，靠系统提示词区分）。
  // 为什么值得打印：校验器的成本策略（`shouldVerifyCompletion`）决定"什么时候多花一次调用"，
  // 而"它到底占多少"此前只能靠猜 —— 实测两个剧本分别是 1/6 与 2/18（约 11%~17%），
  // 早先"失败恢复那一轮成本主要来自校验器"的说法**与数据不符**，已更正。
  // 打出来之后，将来它一旦失控会立刻看得见。
  const verifierCalls = reqs.filter((r) => {
    const sys = String(((r.messages || []).find((m) => m.role === 'system') || {}).content || '');
    return sys.includes('任务校验器');
  }).length;
  console.log(
    'LLM 请求次数：' + reqs.length + '（其中完成校验器 ' + verifierCalls + ' 次）' +
      '；模型发起的工具调用（去重）' + calls.length + ' 次'
  );
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

function toolNamesInOrder() {
  const seen = new Set();
  const out = [];
  for (const req of getLlmRequests()) {
    for (const message of req.messages || []) {
      for (const tc of message.tool_calls || []) {
        if (!tc || !tc.function || seen.has(tc.id)) continue;
        seen.add(tc.id);
        out.push(tc.function.name);
      }
    }
  }
  return out;
}

for (const pb of evalPlaybooks()) {
  const ev = pb.eval;
  test('eval(真模型): ' + pb.title, async () => {
    const model = process.env.RECALLFLOW_EVAL_MODEL || 'deepseek-chat';
    // 剧本可以声明**设置前提**（如 `cdp: true`：拖拽经 CDP 派发真实鼠标事件）。
    // 不照做的话会得到与能力无关的失败（"拖拽需要 CDP 输入层"），
    // 而那种失败最容易被误读成"模型不会拖拽"。
    await configureSettings(context, Object.assign({ model }, ev.cdp ? { cdpEnabled: true } : {}));
    const page = await openFixturePage(context, ev.url);
    resetLlmRequests();
    // 指令统一经 resolveInstruction 解析：含运行时占位符的剧本（如上传文件的本地绝对路径）
    // 才拿得到真实值；不含占位符的原样返回。E2E 走同一个入口，
    // 于是两层跑的**始终是同一条指令**。
    await sendInstruction(page, resolveInstruction(pb.id));

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
            // ⚠ 点完必须**等它消失**再继续数：审批条从点击到移除有一小段时间，
            // 不等待就会在下一轮轮询里把**同一次审批**再数一遍。
            // 实测这个重复计数把 22 次工具调用报成了"34 次审批"，
            // 而"模型索要了几次高危工具"本身是有效观察 —— 数字必须可信。
            await btn.first().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
          }
        } catch (e) {
          /* 按钮消失/被替换都是正常竞态，忽略 */
        }
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

    printTrace(pb.title);
    printToolResults();
    // ⚠ 说清这个数字的口径：它是**审批按钮的点击次数**，不是"模型索要了几次审批"。
    // 审批条上同时有「允许一次」与「本任务内允许」两个按钮，且排队时它会连续出现，
    // 因此点击次数是**上界**、可能明显大于提示次数（实测：22 次工具调用报出过 34/35 次）。
    // 早期报告里引用过这个数字，按上界理解；要精确统计应从面板的审批事件里数，那是另一件事。
    console.log('审批按钮点击次数（上界，非精确提示次数）：' + approvals);
    expect(finished, '这一轮没有跑完（超时）。先看上面的工具轨迹：是卡在某个工具上，还是模型绕圈？').toBe(true);

    // ① 页面判据（与脚本化 E2E 同一套表达式）
    //
    // ⚠ **给"有尾延迟"的状态一个宽限期（8s）**：只读一次会把"还没到"误判成"做不到" ✗。
    //   实测（`<video>` 场景）：模型确实按了真播放键（`__decoded > 0` ✓）、也打开了播放详情 ✓，
    //   但 2 秒素材在它**收尾时往往还没播完** ⇒ `ended` 次次读成"没有" ✗ —— 那是**时序**，不是能力 ✓。
    //   判据问的是"最终状态"，不是"模型收尾那一瞬间的状态"，所以这里轮询到宽限期结束 ✓
    const GRACE_MS = 8000;
    const results = [];
    for (const c of ev.pageChecks) {
      let ok = false;
      const started = Date.now();
      for (;;) {
        ok = await page.evaluate((expr) => {
          try {
            return Boolean(new Function('return (' + expr + ')')());
          } catch (e) {
            return false;
          }
        }, c.expr);
        if (ok || Date.now() - started >= GRACE_MS) break;
        await page.waitForTimeout(250);
      }
      results.push({ label: c.label, ok });
    }

    // ② "数据有没有交到模型手上"（与脚本化 E2E 同一条判据）
    //
    // ⚠ 条目可以是**数组** = "**任一命中即可**"（`anyOf`）：
    //   起因是 `form-validation` —— 判据原来只认浏览器自己的校验报文（`表单未通过校验`），
    //   而模型用 `get_attribute(pattern/minlength/required)` **自己推出约束并改对**、
    //   4 条页面判据全过 ⇒ 那是**第一手 DOM 证据**（不是臆测、不是转述）。
    //   按本仓库"判据盯**数据到没到模型手上**、不盯它从哪一行读的"这条原则，
    //   允许"浏览器报文 **或** 约束属性值"任一到手 ✓（页面判据**不变严也不放宽**）
    const seen = toolResultsText();
    const missed = (ev.mustSeeInToolResults || [])
      .map((s) => (Array.isArray(s) ? s : [s]))
      .filter((alts) => !alts.some((one) => seen.includes(one)))
      .map((alts) => (alts.length > 1 ? alts.join(' 或 ') : alts[0]));

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

test('eval(真模型): 自定义元素优先用结构化查询，不借道 run_javascript', async () => {
  const model = process.env.RECALLFLOW_EVAL_MODEL || 'deepseek-chat';
  await configureSettings(context, { model });
  const page = await openFixturePage(context, '/custom');
  resetLlmRequests();
  await sendInstruction(
    page,
    '找到页面上的“发布笔记”按钮，告诉我它的中心坐标，并确认它是不是自定义元素。不要写 JavaScript。'
  );
  await waitForRunToFinish(page);
  printTrace('custom-query');
  const names = toolNamesInOrder();
  expect(names).toContain('inspect_element');
  expect(names, '普通 DOM 查询不应借道 run_javascript').not.toContain('run_javascript');
  await expect.poll(() => panelText(page, '.p-body'), { timeout: 10_000 }).toMatch(/坐标|自定义/);
  await page.close();
});

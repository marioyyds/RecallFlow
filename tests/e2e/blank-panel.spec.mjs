// 面板「白闪 / 白屏」复现与回归门禁。
//
// 背景（用户实测多次）：流式输出过程中，面板会闪，并且助手那段正在输出的正文会**变白**。
// 上一轮改动（73c6ae1）把"内容没变就不重建"、"建块幂等"、"不往脱离文档的节点里画"
// 都补齐了，但用户反馈**仍然存在**白屏 —— 说明还有一条没找到的路径。
//
// 这条 spec 的职责不是"再断言一次结果"，而是**把现象变成可观测的时间线**：
// 在流式窗口内每 30ms 采样一次面板正文（可见字数、消息节点数、最后一段正文的字符数、
// 滚动位置、面板高度），跑完再算"最长连续看不见任何字"的时长，并打印时间线。
// 只要有一条路径让正文归零超过 400ms，这里就会红，并给出它前后的采样点。
//
// 覆盖的干扰（每一种都对应一条曾在真实使用中出现过的路径）：
//   ① 纯流式（对照）；
//   ② 流式中在页面上选中文字（mouseup → refreshPanelForSelection）；
//   ③ 流式中关掉面板再打开（removePanel → openPanel + restoreStreamingUI）；
//   ④ 流式中整页跳转（新文档 + 自动续跑/跟随）。
import { test, expect } from '@playwright/test';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  openPanel,
  sendInstruction,
  createFreshPanelSession,
  waitForRunEnd,
  PANEL,
} from './helpers.mjs';

// 夹具里这条指令 = 80 段正文、每段间隔 80ms（约 6.4 秒的流式窗口）。
const STREAM_INSTRUCTION = '验证流式上滚';
const SAMPLE_MS = 30;
const BLANK_BUDGET_MS = 400;

let context;

test.beforeAll(async () => {
  context = await launchExtension();
});

test.afterAll(async () => {
  await closeExtension(context);
});

test.beforeEach(async () => {
  await createFreshPanelSession(context);
});

/**
 * 在页面里装一个采样器（装在页面世界，直接读扩展宿主的 open shadow root）。
 *
 * 采样字段刻意都用"用户能不能看见字"这个判据：
 *  - `visibleChars`：**落在 .p-body 可视矩形内**的正文元素字数之和（白屏的直接度量）；
 *  - `bodyText`：正文容器的总字数（>0 但 visibleChars=0 ⇒ 内容在，但被滚走/裁掉了）；
 *  - `lastText`：对话流最后一段正文的字数（>0 说明模型确实输出过东西）；
 *  - `contentEls`：对话流里的正文块数量（重建会把它们换掉）。
 */
async function installProbe(page) {
  // ⚠ 面板在 shadow root 里：必须让 Playwright 的 locator 穿透，而不是在页面里做原生查询
  //   （`tests/e2e-hygiene.test.mjs` 有门禁：spec 里出现原生 document 查询即红）。
  //   传进来的是**宿主元素**：它跨面板重建仍然有效，每次采样再从它身上取 `.p-body`。
  await page.locator(PANEL).evaluate((host, sampleMs) => {
    const samples = [];
    const t0 = performance.now();
    window.__rfSamples = samples;
    if (window.__rfProbeTimer) clearInterval(window.__rfProbeTimer);
    window.__rfProbeTimer = setInterval(() => {
      const rootNode = host.shadowRoot;
      const body = rootNode ? rootNode.querySelector('.p-body') : null;
      if (!body || !body.isConnected) {
        samples.push({ t: Math.round(performance.now() - t0), gone: true });
        return;
      }
      const bodyRect = body.getBoundingClientRect();
      // 用户能看见的"字"不只是正文段落：思考记录的折叠条、工具步骤条同样是内容。
      // 只数 .agent-content 会把"思考阶段只有折叠条"误判成白屏（实测踩到）。
      let visibleChars = 0;
      for (const el of Array.from(body.querySelectorAll('.agent-content, .think-head, .agent-step'))) {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.bottom > bodyRect.top + 1 && r.top < bodyRect.bottom - 1) {
          visibleChars += String(el.textContent || '').trim().length;
        }
      }
      const flows = body.querySelectorAll('.agent-flow');
      const lastFlow = flows.length ? flows[flows.length - 1] : null;
      const contents = lastFlow ? Array.from(lastFlow.querySelectorAll('.agent-content')) : [];
      const last = contents.length ? contents[contents.length - 1] : null;
      const panelEl = rootNode ? rootNode.querySelector('.panel') : null;
      const aiBlocks = Array.from(body.querySelectorAll('.msg.ai')).map((el) =>
        String(el.textContent || '').trim().length
      );
      samples.push({
        t: Math.round(performance.now() - t0),
        gone: false,
        visibleChars,
        bodyText: String(body.textContent || '').trim().length,
        turnNodes: body.querySelectorAll('.user-turn, .msg').length,
        aiBlocks,
        flows: flows.length,
        contentEls: contents.length,
        lastText: last ? String(last.textContent || '').trim().length : -1,
        bodyH: Math.round(bodyRect.height),
        scrollTop: Math.round(body.scrollTop),
        scrollH: body.scrollHeight,
        overflowY: getComputedStyle(body).overflowY,
        panelH: panelEl ? Math.round(panelEl.getBoundingClientRect().height) : -1,
      });
    }, sampleMs);
  }, SAMPLE_MS);
}

async function readProbe(page) {
  return await page.evaluate(() => {
    if (window.__rfProbeTimer) clearInterval(window.__rfProbeTimer);
    window.__rfProbeTimer = null;
    return Array.isArray(window.__rfSamples) ? window.__rfSamples.slice() : [];
  });
}

/**
 * 正文骨架：每个顶层节点的 tag.class + 文本长度，以及每条 ai 消息里的 flow 数与正文块数。
 *
 * 为什么要这个：多了/少了一条 `.msg.ai`（例如流式块被挂了两份、或恢复时留下一个空块）
 * 在"总字数"上是看不出来的 —— 而它恰恰会让置底停在一个空块上，看起来就是白屏。
 */
async function dumpStructure(page) {
  return await page.locator(PANEL).evaluate((host) => {
    const rootNode = host.shadowRoot;
    const body = rootNode ? rootNode.querySelector('.p-body') : null;
    if (!body) return { body: null };
    return {
      body: Array.from(body.children).map((el) => {
        const flows = Array.from(el.querySelectorAll('.agent-flow'));
        return {
          tag: el.tagName.toLowerCase() + '.' + String(el.className || ''),
          dataset: Object.assign({}, el.dataset),
          html: String(el.outerHTML || '').slice(0, 420),
          text: String(el.textContent || '').trim().length,
          flows: flows.map((f) => ({
            contents: Array.from(f.querySelectorAll('.agent-content')).map((c) =>
              String(c.textContent || '').trim().length
            ),
            steps: f.querySelectorAll('.agent-step').length,
            think: f.querySelectorAll('.think-block').length,
            typing: f.querySelectorAll('.typing').length,
          })),
        };
      }),
    };
  });
}

/** 把时间线压成"最长连续不可见"等几个标量，并保留出事的那几帧。 */
function analyze(samples) {
  // 判定只从"回答真的开始了"那一刻算起：起跑前的空面板天生没有字，不是缺陷。
  // 判据只看 `lastText > 0`（对话流里最后一段正文真的有了字）——**不能**看"有 ai 块"：
  // 空对话占位本身就是一个 `.msg.ai`（22 字），会让起跑前那段空窗被误判成白屏。
  const startedAt = (() => {
    for (const s of samples) {
      if (!s.gone && s.lastText > 0) return s.t;
    }
    return 0;
  })();
  const runs = { blank: [], bodyZero: [], hiddenAnswer: [], gone: [] };
  const open = { blank: null, bodyZero: null, hiddenAnswer: null, gone: null };
  const push = (kind, sample) => {
    if (open[kind] === null) open[kind] = sample;
  };
  for (const s of samples) {
    if (s.t < Math.max(200, startedAt)) continue; // 起跑的瞬间正文天生是空的，不参与判定
    if (s.gone) {
      push('gone', s);
      closeAllExceptGone();
      continue;
    }
    closeRun('gone', s);
    if (s.visibleChars === 0) push('blank', s);
    else closeRun('blank', s);
    if (s.bodyText === 0) push('bodyZero', s);
    else closeRun('bodyZero', s);
    if (s.lastText > 0 && s.visibleChars === 0) push('hiddenAnswer', s);
    else closeRun('hiddenAnswer', s);
  }
  const last = samples[samples.length - 1] || null;
  for (const kind of Object.keys(open)) {
    if (open[kind] !== null && last) runs[kind].push({ from: open[kind], to: last });
  }
  const longest = (list) =>
    list.reduce((max, w) => Math.max(max, w.to.t - w.from.t), 0);
  return {
    count: samples.length,
    longestBlankMs: longest(runs.blank),
    longestBodyZeroMs: longest(runs.bodyZero),
    longestHiddenAnswerMs: longest(runs.hiddenAnswer),
    longestGoneMs: longest(runs.gone),
    worst: runs.blank.slice().sort((a, b) => (b.to.t - b.from.t) - (a.to.t - a.from.t)).slice(0, 3),
    hidden: runs.hiddenAnswer.slice().sort((a, b) => (b.to.t - b.from.t) - (a.to.t - a.from.t)).slice(0, 3),
    gone: runs.gone.slice(0, 3),
    last,
  };

  function closeRun(kind, sample) {
    if (open[kind] !== null) {
      runs[kind].push({ from: open[kind], to: sample });
      open[kind] = null;
    }
  }
  function closeAllExceptGone() {
    for (const kind of ['blank', 'bodyZero', 'hiddenAnswer']) {
      if (open[kind] !== null) {
        runs[kind].push({ from: open[kind], to: open[kind] });
        open[kind] = null;
      }
    }
  }
}

function report(label, samples, warnings) {
  const a = analyze(samples);
  // 「多了一条 ai 消息 / 有一条块停止增长」是白屏的隐形来源（置底会停在空块上）。
  // 起跑前那一对（占位 + 打字块）不算 —— 只看 1.2s 之后的**新增**块。
  const dupEvents = [];
  let prevCount = -1;
  for (const s of samples) {
    if (s.gone || !Array.isArray(s.aiBlocks)) continue;
    if (s.t < 1200) {
      prevCount = s.aiBlocks.length;
      continue;
    }
    if (prevCount >= 0 && s.aiBlocks.length > prevCount && dupEvents.length < 5) {
      dupEvents.push({ at: s.t, from: prevCount, aiBlocks: s.aiBlocks });
    }
    prevCount = s.aiBlocks.length;
  }
  const lines = [
    `[blank-panel] ${label}: 采样 ${a.count} 次`,
    `  最长"看不见任何正文": ${a.longestBlankMs}ms`,
    `  最长"正文容器完全为空": ${a.longestBodyZeroMs}ms`,
    `  最长"有正文但不在可视区": ${a.longestHiddenAnswerMs}ms`,
    `  最长"面板整个不在": ${a.longestGoneMs}ms`,
    `  疑似重复 ai 消息: ${dupEvents.length ? JSON.stringify(dupEvents) : '无'}`,
    `  末帧: ${JSON.stringify(a.last)}`,
  ];
  for (const w of a.worst) lines.push(`  白屏窗口 ${w.from.t}ms → ${w.to.t}ms 起点 ${JSON.stringify(w.from)}`);
  for (const w of a.hidden) lines.push(`  正文在但看不见 ${w.from.t}ms → ${w.to.t}ms 起点 ${JSON.stringify(w.from)}`);
  for (const w of a.gone) lines.push(`  面板消失 ${w.from.t}ms 起`);
  if (warnings.length) {
    lines.push('  面板日志（按发生顺序，最多 40 行）:');
    for (const w of warnings.slice(0, 40)) lines.push('    · ' + w);
  }
  console.log(lines.join('\n'));
  return a;
}

function collectWarnings(page, sink) {
  page.on('console', (msg) => {
    const text = msg.text() || '';
    if (text.includes('[RecallFlow]')) sink.push(text.replace(/\s+/g, ' ').slice(0, 220));
  });
}

test('① 对照：纯流式期间正文不得连续消失', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  const warnings = [];
  collectWarnings(page, warnings);
  await installProbe(page);
  await sendInstruction(page, STREAM_INSTRUCTION);
  await waitForRunEnd(page);
  const samples = await readProbe(page);
  const a = report('① 纯流式', samples, warnings);
  expect(a.longestBlankMs, '流式期间不该出现这么久的空白').toBeLessThanOrEqual(BLANK_BUDGET_MS);
  expect(a.last.visibleChars, '跑完后正文必须还看得见').toBeGreaterThan(0);
  await page.close();
});

test('② 流式中在页面上选中文字（mouseup → 刷新选文预览）', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  const warnings = [];
  collectWarnings(page, warnings);
  await installProbe(page);
  await sendInstruction(page, STREAM_INSTRUCTION);
  await expect
    .poll(() => page.locator(PANEL + ' .p-body').evaluate((el) => el.innerText.trim().length), { timeout: 25_000 })
    .toBeGreaterThan(30);
  // 选中正文 + 派发一次真实 mouseup：这正是用户"划词"时发生的事。
  // 判据用"选文预览真的出现在输入区上方"，而不是睡固定时长。
  for (let i = 0; i < 3; i++) {
    // 用 locator 取元素（spec 里不做原生查询），再在元素上做选择 + 派发 mouseup。
    await page.locator('h1, main p, body').first().evaluate((target) => {
      if (!target) return;
      const doc = target.ownerDocument;
      const range = doc.createRange();
      range.selectNodeContents(target);
      const sel = doc.defaultView.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    });
    await expect(page.locator(PANEL + ' .p-text-quote')).toBeVisible({ timeout: 10_000 });
  }
  await waitForRunEnd(page);
  const samples = await readProbe(page);
  const a = report('② 流式中划词', samples, warnings);
  expect(a.longestBlankMs, '划词不该把正在输出的正文刷成白屏').toBeLessThanOrEqual(BLANK_BUDGET_MS);
  expect(a.last.visibleChars, '跑完后正文必须还看得见').toBeGreaterThan(0);
  await page.close();
});

test('③ 流式中关掉面板再打开', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  const warnings = [];
  collectWarnings(page, warnings);
  await installProbe(page);
  await sendInstruction(page, STREAM_INSTRUCTION);
  await expect
    .poll(() => page.locator(PANEL + ' .p-body').evaluate((el) => el.innerText.trim().length), { timeout: 25_000 })
    .toBeGreaterThan(30);
  await page.keyboard.press('Escape');
  // 等"面板真的消失"，而不是睡固定时长（Esc 是同步移除的，这里等它落地即可）。
  await expect(page.locator(PANEL + ' .panel')).toHaveCount(0);
  await openPanel(page);
  await waitForRunEnd(page);
  const samples = await readProbe(page);
  const a = report('③ 关闭再打开', samples, warnings);
  console.log('[blank-panel] ③ 结构: ' + JSON.stringify(await dumpStructure(page)));
  expect(a.longestBlankMs, '重开面板后正文不该长时间空白').toBeLessThanOrEqual(BLANK_BUDGET_MS);
  expect(a.last.visibleChars, '重开面板并跑完后正文必须还看得见').toBeGreaterThan(0);
  await page.close();
});

test('④ 流式中整页跳转（新文档 + 自动续跑/跟随）', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  const warnings = [];
  collectWarnings(page, warnings);
  await installProbe(page);
  await sendInstruction(page, STREAM_INSTRUCTION);
  await expect
    .poll(() => page.locator(PANEL + ' .p-body').evaluate((el) => el.innerText.trim().length), { timeout: 25_000 })
    .toBeGreaterThan(30);
  // 跳到一个新文档：内容脚本重注入、面板自动重开、run 由 SW 跟随。
  await page.goto(new URL('/coord', page.url()).href);
  // 判据：新文档里面板已重开并画出了内容（自动重开由 syncPanelUiOnInit / 续跑驱动）。
  await expect
    .poll(() => page.locator(PANEL + ' .p-body').evaluate((el) => el.innerText.trim().length), { timeout: 25_000 })
    .toBeGreaterThan(30);
  await installProbe(page);
  await waitForRunEnd(page);
  const samples = await readProbe(page);
  const a = report('④ 流式中整页跳转', samples, warnings);
  console.log('[blank-panel] ④ 结构: ' + JSON.stringify(await dumpStructure(page)));
  expect(a.longestBlankMs, '跳转后面板不该长时间白屏').toBeLessThanOrEqual(BLANK_BUDGET_MS);
  expect(a.last.visibleChars, '跳转后跑完，正文必须还看得见').toBeGreaterThan(0);
  await page.close();
});

test('⑤ 思考流（思维链先到、正文后到，中间有 4 秒空窗）', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  const warnings = [];
  collectWarnings(page, warnings);
  await installProbe(page);
  // 夹具里含「思考」的指令会先吐思维链、压住 4 秒，再补正文与第二段思考。
  await sendInstruction(page, '验证思考记录的折叠与穿插');
  // 等"思考块真的出现"—— 这就是用户看到的"思考进行中"那个窗口。
  await expect.poll(() => page.locator(PANEL + ' .think-block').count(), { timeout: 25_000 }).toBeGreaterThan(0);
  const thinkOnly = await page.locator(PANEL + ' .p-body').innerText();
  await waitForRunEnd(page);
  const samples = await readProbe(page);
  const a = report('⑤ 思考流（思考窗口内可见字 ' + thinkOnly.trim().length + '）', samples, warnings);
  expect(a.longestBlankMs, '思考阶段不该把面板清成白色').toBeLessThanOrEqual(BLANK_BUDGET_MS);
  expect(a.last.visibleChars, '思考流跑完后正文必须看得见').toBeGreaterThan(0);
  await page.close();
});

test('⑥ 多步工具（每步之间叙述与步骤交替）', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  const warnings = [];
  collectWarnings(page, warnings);
  await installProbe(page);
  // 夹具里的站内检索剧本：4 轮工具调用（看页面 → 填搜索框 → 点搜索 → 读结果）+ 收尾正文。
  await sendInstruction(page, '在这个页面的站内搜索里搜「咖啡」，然后把前三条结果的标题和价格告诉我。');
  await waitForRunEnd(page, 90_000);
  const samples = await readProbe(page);
  const a = report('⑥ 多步工具', samples, warnings);
  console.log('[blank-panel] ⑥ 结构: ' + JSON.stringify(await dumpStructure(page)));
  expect(a.longestBlankMs, '多步工具期间不该白屏').toBeLessThanOrEqual(BLANK_BUDGET_MS);
  expect(a.last.visibleChars, '跑完后正文必须看得见').toBeGreaterThan(0);
  await page.close();
});

test('⑧ 另一个标签页跟随（面板在跟随页里看别人跑）', async () => {
  await configureSettings(context);
  // 跟随页：先把面板打开（此时是空会话），run 起来之后它只读跟随。
  const follower = await openFixturePage(context);
  await openPanel(follower);
  const owner = await openFixturePage(context);
  await openPanel(owner);
  const warnings = [];
  collectWarnings(follower, warnings);
  await installProbe(follower);
  await sendInstruction(owner, STREAM_INSTRUCTION);
  // 跟随页拿到最后一段（第 80 段）说明整轮已经流完；再等收尾/落盘换过来。
  await expect
    .poll(
      () => follower.locator(PANEL + ' .p-body').evaluate((el) => String(el.innerText || '').includes('第 80 段')),
      { timeout: 40_000 }
    )
    .toBe(true);
  // 跟随页看到"重新生成"操作栏 ⇒ 这一轮已经收尾并换成落盘消息（不必睡固定时长）。
  await expect
    .poll(() => follower.locator(PANEL + ' .msg-actions').count(), { timeout: 40_000 })
    .toBeGreaterThan(0);
  const samples = await readProbe(follower);
  const a = report('⑧ 另一标签页跟随', samples, warnings);
  console.log('[blank-panel] ⑧ 结构: ' + JSON.stringify(await dumpStructure(follower)));
  expect(a.longestBlankMs, '跟随页不该长时间白屏').toBeLessThanOrEqual(BLANK_BUDGET_MS);
  expect(a.last.visibleChars, '跟随页在收尾后必须还看得见正文').toBeGreaterThan(0);
  await follower.close();
  await owner.close();
});

test('⑦ 小视口（面板停靠、正文只剩一百多像素高）', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  await page.setViewportSize({ width: 900, height: 520 });
  const warnings = [];
  collectWarnings(page, warnings);
  await installProbe(page);
  await sendInstruction(page, STREAM_INSTRUCTION);
  await waitForRunEnd(page);
  const samples = await readProbe(page);
  const a = report('⑦ 小视口', samples, warnings);
  console.log('[blank-panel] ⑦ 结构: ' + JSON.stringify(await dumpStructure(page)));
  expect(a.longestBlankMs, '小视口下也不该白屏').toBeLessThanOrEqual(BLANK_BUDGET_MS);
  expect(a.last.visibleChars, '跑完后正文必须看得见').toBeGreaterThan(0);
  await page.close();
});
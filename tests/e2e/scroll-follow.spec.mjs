// 面板滚动跟随的两条用户实测缺陷（复现 + 回归）。
//
// 用户反馈原文：
//   ① 关掉会话再打开，对话应该到最后一条
//   ② 对话进行中切到其它 tab，流式也没有到最底下
//
// 两条都先量**事实**（贴底偏差 = scrollHeight - scrollTop - clientHeight）再下结论。
// 各自的根因与修法见对应用例的注释（都写清了"为什么原来那条路不成立"）。
import { test, expect } from '@playwright/test';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  sendInstruction,
  createFreshPanelSession,
  clickFab,
  PANEL,
} from './helpers.mjs';

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

/** 贴底偏差（px）。0 = 正好在最底下；越大越靠上。 */
function gap(page) {
  return page.locator(PANEL + ' .p-body').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

/**
 * 等这一轮真的收尾。
 *
 * ⚠ **只等进度条收起是不够的（实测踩到，会让本文件的前置断言假红）**：
 *   进度条在 `endStream()`/`stopProgress()` 时就停了，而那一轮的最后一次渲染与置底
 *   发生在**它之后**。只等进度条 ⇒ 读到的是"流还没收尾"的中间态，
 *   "关闭前本来就在底部"这条前置会以 576px 的偏差失败（看起来像产品缺陷，其实是用例的竞态）。
 *   所以这里再等两件事：停止按钮隐藏（流真的结束）+ 视图真的贴底。
 */
async function waitDone(page) {
  await expect
    .poll(() => page.locator(PANEL + ' .p-progress').evaluate((el) => getComputedStyle(el).display !== 'none'), {
      timeout: 60_000,
    })
    .toBe(false);
  await expect
    .poll(() => page.locator(PANEL + ' .stop-btn').evaluate((el) => getComputedStyle(el).display !== 'none'), {
      timeout: 60_000,
    })
    .toBe(false);
  // 再等视图真的稳定贴底：收尾的最后一次渲染与置底发生在停止按钮隐藏**之后**，
  // 不等它就会读到中间态（实测：前置断言曾以 576px 的偏差假红）。
  await expect.poll(() => gap(page), { timeout: 60_000 }).toBeLessThan(40);
}

/** 面板已开着时再发一条（不能再走 sendInstruction：`.fab` 此时是 hidden，点击会等到超时）。 */
async function sendAgain(page, text) {
  await page.locator(PANEL + ' .cmd-input').fill(text);
  await page.locator(PANEL + ' .cmd-send').click();
  await waitDone(page);
}

// ---------------------------------------------------------------------------
// ① 关掉会话再打开：必须停在最后一条
//
// 根因（真浏览器插桩定位）：`openPanel` 里 `renderConversation()` / `fitPanelHeight()` /
// 置底原先都跑在 `panel.appendChild(panelBody)` **之前** —— 那时元素不在渲染树里，
// `scrollHeight` 与 `clientHeight` **恒为 0**，`scrollTop = 0` 是空操作且**不报错**。
// 实测（修复前）：重开后 scrollTop=0、scrollHeight=780、clientHeight=226（偏差 554px），
// 而手动置底能到 553 ⇒ 证明"没执行"而不是"被抹掉"。
//
// ⚠ 断言必须用一个**真的溢出**的长度：只溢出一屏零头（几十像素）时，
//   这种缺陷与"像素取整误差"分不开，读数不足以判定。
// ---------------------------------------------------------------------------
test('① 关掉会话再打开：视图停在最后一条（而不是顶部）', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);

  await sendInstruction(page, '说说你的思考');
  await waitDone(page);
  // 堆到足够长，让"贴底"与"停在顶部"在读数上分得开。
  await sendAgain(page, '说说你的思考');
  await sendAgain(page, '说说你的思考');

  const before = await page.locator(PANEL + ' .p-body').evaluate((el) => ({
    h: el.scrollHeight,
    c: el.clientHeight,
  }));
  // 前置条件：内容真的溢出，否则本用例恒真（假绿）。
  expect(before.h - before.c, '前置：对话必须真的溢出容器，否则这条断言测不到东西').toBeGreaterThan(200);
  expect(await gap(page), '关闭前本来就在底部').toBeLessThan(40);

  // ⚠ 断言 `.panel` 消失，**不是** `#__kb-ai-host` —— 后者是 shadow **宿主**，
  //   `removePanel()` 只摘掉里面的 .panel，宿主一直在（写错会误判成"没关掉"）。
  await page.locator(PANEL + ' .close').click();
  await expect(page.locator(PANEL + ' .panel')).toHaveCount(0);

  await clickFab(page);
  await expect(page.locator(PANEL + ' .p-body')).toBeVisible();

  const after = await page.locator(PANEL + ' .p-body').evaluate((el) => ({
    h: el.scrollHeight,
    t: Math.round(el.scrollTop),
    c: el.clientHeight,
  }));
  console.log('[① 重开后]', JSON.stringify(after));
  // 前置仍然成立：重开后内容照样溢出（否则"贴底"无从谈起）。
  expect(after.h - after.c, '前置：重开后仍然溢出').toBeGreaterThan(200);
  expect(await gap(page), '重开面板后视图必须停在最后一条').toBeLessThan(40);

  await page.close();
});

// ---------------------------------------------------------------------------
// ② 切到别的 tab：回到本页时必须已经贴底
//
// ⚠ **这条用例的能力边界（诚实记录，别把它当成"测过隐藏标签页"）**：
//   真实隐藏标签页里浏览器会暂停 rAF，而本 harness **造不出**隐藏标签页 ——
//   Playwright 是以 `--disable-backgrounding-occluded-windows` / `--disable-renderer-backgrounding`
//   启动的（刻意禁用后台节流），实测 `context.newPage()` + `bringToFront()` 之后
//   原页面的 `document.visibilityState` 仍然是 `visible`、rAF 也没停。
//   ⇒ 隐藏标签页那条时序由**两个可测的替身**钉住：
//     · `tests/render-scheduler.test.mjs`：rAF 不来时兜底定时器必须把这一批渲染跑掉；
//     · 本用例：`visibilitychange → visible` 时必须把"视图在底部"变成事实，
//       而不是干等下一帧。
//   两者合起来覆盖"隐藏期间挂起、回来时必须贴底"这条不变量。
// ---------------------------------------------------------------------------
test('② 回到标签页（visibilitychange→visible）时补渲染并贴底', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);

  await sendInstruction(page, '说说你的思考');
  await waitDone(page);

  // 构造"离开期间内容变长了、而视图还停在原处"：这正是隐藏标签页里发生的事
  // （渲染与置底都被 rAF 挂起，回到本页时内容已经比离开时长）。
  // ⚠ **不能**用 `panelBody.scrollTop = 0` 来造这个状态：那会触发 .p-body 自己的
  //   scroll 监听器，把 `observerAutoScroll` 置成 false —— 等于在测试里亲手关掉
  //   正要验证的那个开关（实测踩过：诊断日志显示 `oas=false`，于是置底被守卫正确地跳过，
  //   红灯落在测试自己造的假象上）。
  await page.locator(PANEL + ' .p-body').evaluate((el) => {
    const filler = document.createElement('div');
    filler.style.height = '400px';
    filler.textContent = '离开期间到达的内容';
    el.appendChild(filler);
  });
  expect(await gap(page), '前置：内容变长后视图已不在底部').toBeGreaterThan(40);

  // `document.visibilityState` 被 Playwright 的启动开关钉成 visible、改不动；
  // 而处理链路只认"事件 + 读到的状态是 visible" ⇒ 直接派发事件即可驱动它。
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  await expect.poll(() => gap(page), { timeout: 10_000 }).toBeLessThan(40);

  await page.close();
});

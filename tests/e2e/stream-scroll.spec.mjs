// 用户实测缺陷：模型流式输出时，向上滚动会被下一次增量强制拉回底部。
//
// 根因在 `.p-body` 的 scroll 监听器：它用 `selfScrollMuteUntil` 屏蔽"布局变化造成的
// scroll 事件"，但流式期间 `fitPanelHeight()` 每来一段内容就刷新这个屏蔽窗口 ——
// 用户的真实滚轮事件也被一起吞掉，`observerAutoScroll` 始终保持 true，
// 下一次 `pinToBottom()` 就把视图拽回底部。
//
// 这条用例必须用**真实滚轮**，不能直接写 scrollTop：
// 直接赋值不会产生"用户意图"信号，正好绕开要测的缺陷。
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

function gap(page) {
  return page.locator(PANEL + ' .p-body').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

test('流式输出中用户上滚：不被后续增量拉回底部', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  await sendInstruction(page, '验证流式上滚');

  const body = page.locator(PANEL + ' .p-body');
  // 先等内容真的溢出，否则"上滚"没有可滚空间。
  await expect
    .poll(() => body.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 20_000 })
    .toBeGreaterThan(160);

  await body.hover();
  await page.mouse.wheel(0, -600);
  // 用户滚上去之后，视图必须离开底部。
  await expect.poll(() => gap(page), { timeout: 5_000 }).toBeGreaterThan(80);
  const topAfterWheel = await body.evaluate((el) => el.scrollTop);

  // 继续接收新的流式增量：缺陷会把 observerAutoScroll 留在 true，
  // 下一次 pinToBottom 会把 gap 打回 0。
  //
  // ⚠ 这里原先是两次 waitForTimeout(1200)。改成**等到"确实又来了一批增量"**再断言：
  // 睡固定时长在慢机器上可能还没等到增量就断言（于是测了个寂寞），
  // 在快机器上又白等（比需要的更久）。判据不变，等待方式从"猜时间"改成"等事件"。
  const heightBefore = await body.evaluate((el) => el.scrollHeight);
  await expect
    .poll(() => body.evaluate((el) => el.scrollHeight), { timeout: 15_000 })
    .toBeGreaterThan(heightBefore);
  expect(await gap(page), '流式增量不得把上滚的用户拽回底部').toBeGreaterThan(80);
  const topLater = await body.evaluate((el) => el.scrollTop);
  expect(topLater, '滚动位置不应跳到底部').toBeLessThanOrEqual(topAfterWheel + 30);

  await expect
    .poll(() => body.evaluate((el) => el.scrollHeight), { timeout: 15_000 })
    .toBeGreaterThan(heightBefore + 1);
  expect(await gap(page), '持续流式期间也必须保持用户选择的滚动位置').toBeGreaterThan(80);

  await page.close();
});

test('跟随页在 owner 流式期间必须持续增长（不是只出终稿）', async () => {
  await configureSettings(context);
  const a = await openFixturePage(context);
  await sendInstruction(a, '验证流式上滚');
  // 原先 sleep 600ms 再开跟随页，赌的是"这时 owner 已经流起来了"。
  // 改成等到 owner 真的有正文 —— 否则这条用例测的是"跟随页比 owner 晚多少"，
  // 而这个"多少"在不同机器上完全不一样。
  await expect
    .poll(async () => String(await panelText(a, '.p-body') || '').length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  const b = await openFixturePage(context);
  await expect(b.locator(PANEL + ' .panel')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => String(await panelText(b, '.p-body') || '').length, { timeout: 5_000 })
    .toBeGreaterThan(20);
  const len1 = String(await panelText(b, '.p-body') || '').length;
  // 原先固定睡 250ms × 5 次来采样。判据是"多个时间点都在变"，等待方式不该是猜时长：
  // 流得快时白等，流得慢时样本全一样（于是断言在慢机器上假红）。
  // 改成 poll 采样 —— 间隔由框架控制，条件一成立就停。
  const seen = new Set([len1]);
  await expect
    .poll(
      async () => {
        seen.add(String(await panelText(b, '.p-body') || '').length);
        return seen.size;
      },
      { timeout: 8_000, message: '跟随页应在多个时间点持续更新，而不是一次性刷出' }
    )
    .toBeGreaterThan(2);
  const len2 = String(await panelText(b, '.p-body') || '').length;
  expect(len2, '跟随页正文应在流式期间继续增长').toBeGreaterThan(len1 + 20);

  await a.close();
  await b.close();
});

test('同步面板的流式游标在连续增量之间保持同一个 DOM 节点', async () => {
  await configureSettings(context);
  const a = await openFixturePage(context);
  await sendInstruction(a, '验证流式上滚');
  // 同上：等 owner 真的开始出正文，而不是睡固定时长赌它已经开始了。
  await expect
    .poll(async () => String(await panelText(a, '.p-body') || '').length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  const b = await openFixturePage(context);
  await expect(b.locator(PANEL + ' .panel')).toBeVisible({ timeout: 15_000 });
  const cursor = b.locator(PANEL + ' .stream-cursor');
  await expect(cursor).toHaveCount(1, { timeout: 5_000 });
  await cursor.evaluate((el) => {
    el.__rfStableCursorProbe = 'same-node';
  });
  const textBefore = String(await panelText(b, '.p-body') || '').length;
  const cursorBefore = await cursor.evaluate((el) => ({
    left: el.style.left,
    top: el.style.top,
    animations: el.getAnimations().length,
  }));

  // 原先 sleep 900ms 后断言"又收到新正文"。改成**等正文长度真的变化**（有上界）：
  // 睡 900ms 在慢机器上可能还没到、在快机器上又多等 —— 两种都是在赌。
  await expect
    .poll(async () => String(await panelText(b, '.p-body') || '').length, { timeout: 15_000 })
    .toBeGreaterThan(textBefore);
  const textAfter = String(await panelText(b, '.p-body') || '').length;
  expect(textAfter, '标记之后必须仍收到新的正文增量').toBeGreaterThan(textBefore);
  const probes = await b.locator(PANEL + ' .stream-cursor').evaluateAll((els) =>
    els.map((el) => ({
      marker: el.__rfStableCursorProbe || '',
      left: el.style.left,
      top: el.style.top,
      animations: el.getAnimations().length,
    }))
  );
  expect(probes.length, '同步面板同一时刻只能有一个流式游标').toBe(1);
  expect(probes[0].marker, '正文重绘不得销毁并重建游标节点').toBe('same-node');
  expect(probes[0].animations, '游标动画应持续存在，而不是每批增量重新创建').toBeGreaterThan(0);
  expect(cursorBefore.animations).toBeGreaterThan(0);

  await a.close();
  await b.close();
});

test('同步窗口刚连上、还没有正文时不显示「（无内容）」', async () => {
  await configureSettings(context);
  const a = await openFixturePage(context);
  await sendInstruction(a, '验证同步初始空态');
  // 等 owner 的会话真的建立起来（用户消息已呈现），而不是睡 300ms 赌它好了。
  await expect(a.locator(PANEL + ' .msg.user')).toBeVisible({ timeout: 10_000 });

  const b = await openFixturePage(context);
  await expect(b.locator(PANEL + ' .panel')).toBeVisible({ timeout: 15_000 });
  await expect(b.locator(PANEL + ' .msg.user')).toBeVisible({ timeout: 5_000 });
  // 夹具刻意让第一段正文晚 2.5s 到达；此时同步窗口显示的应是等待态，
  // 而不是把空字符串交给 Markdown 渲染成「（无内容）」。
  expect(await panelText(b, '.p-body')).not.toContain('（无内容）');
  await expect.poll(() => panelText(b, '.p-body'), { timeout: 10_000 }).toContain('初始空态之后的第一段正文');

  await a.close();
  await b.close();
});

test('对话区可聚焦：PageUp 能滚动正在流式输出的内容', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  await sendInstruction(page, '验证流式上滚');
  const body = page.locator(PANEL + ' .p-body');
  await expect
    .poll(() => body.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 20_000 })
    .toBeGreaterThan(160);
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const before = await body.evaluate((el) => el.scrollTop);
  await body.focus();
  await page.keyboard.press('PageUp');
  await expect.poll(() => body.evaluate((el) => el.scrollTop), { timeout: 3_000 }).toBeLessThan(before);
  await page.close();
});

// 全浏览器统一面板布局：不同 origin 必须读取同一份扩展存储布局。
import { test, expect } from '@playwright/test';
import {
  PANEL,
  closeExtension,
  configureSettings,
  launchExtension,
  openFixturePage,
  openPanel,
} from './helpers.mjs';

const LAYOUT_KEY = 'recallflow.panel.layout.v1';
let context;

test.beforeAll(async () => {
  context = await launchExtension();
  await configureSettings(context);
});

test.afterAll(async () => {
  await closeExtension(context);
});

async function clearLayout() {
  const [sw] = context.serviceWorkers();
  await sw.evaluate(async (key) => {
    await chrome.storage.local.remove(key);
  }, LAYOUT_KEY);
}

async function readLayout() {
  const [sw] = context.serviceWorkers();
  return await sw.evaluate(async (key) => {
    const data = await chrome.storage.local.get(key);
    return data[key] || null;
  }, LAYOUT_KEY);
}

async function panelRect(page) {
  return await page.locator(PANEL + ' .panel').evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
}

async function drag(page, dx, dy) {
  const head = page.locator(PANEL + ' .p-head');
  const box = await head.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 60 + dx, box.y + 12 + dy, { steps: 8 });
  await page.mouse.up();
}

async function resize(page, dx, dy) {
  const handle = page.locator(PANEL + ' .resize-handle.bottom-right');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

test('面板位置和尺寸跨 origin 使用同一份扩展存储布局', async () => {
  await clearLayout();
  const first = await openFixturePage(context, '/');
  await first.evaluate(() => {
    localStorage.removeItem('recallflow-panel-pos');
    localStorage.removeItem('recallflow-panel-size');
  });
  await openPanel(first);

  await drag(first, 120, 60);
  await resize(first, 80, 60);
  await expect.poll(() => readLayout()).toEqual(
    expect.objectContaining({
      version: 2,
      // 拖过之后必须是自由浮动：`docked` 留着的话存档记的是右/下边锚定间距，
      // 换页或改窗口尺寸会把面板又贴回右缘（就是「拖了却拖不走」）。
      docked: false,
      left: expect.any(Number),
      top: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    })
  );
  const before = await panelRect(first);

  await first.locator(PANEL + ' .close').click();
  await expect(first.locator(PANEL + ' .panel')).toHaveCount(0);
  await expect
    .poll(async () => (await first.evaluate(() => {
      return {
        pos: localStorage.getItem('recallflow-panel-pos'),
        size: localStorage.getItem('recallflow-panel-size'),
      };
    })))
    .toEqual({ pos: null, size: null });

  // localhost 与 127.0.0.1 是不同 origin；旧实现的两份 localStorage 互不相通。
  const second = await openFixturePage(context, '/?origin=localhost');
  await second.goto('http://localhost:7802/?origin=localhost');
  await openPanel(second);
  await expect.poll(async () => {
    const rect = await panelRect(second);
    return Math.abs(rect.left - before.left) <= 1 &&
      Math.abs(rect.top - before.top) <= 1 &&
      Math.abs(rect.width - before.width) <= 1 &&
      Math.abs(rect.height - before.height) <= 1;
  }).toBe(true);

  await first.close();
  await second.close();
});

test('两个标签页实时同步布局，关闭任一标签页不会用旧布局覆盖新值', async () => {
  await clearLayout();
  const first = await openFixturePage(context, '/');
  await openPanel(first);
  const second = await openFixturePage(context, '/?second=1');
  await openPanel(second);
  await expect(second.locator(PANEL + ' .panel')).toBeVisible();

  await drag(first, 90, 50);
  await resize(first, 70, 55);
  const edited = await panelRect(first);

  // 已打开的另一标签页必须在不关闭/重开的情况下实时跟上。
  await expect.poll(async () => {
    const rect = await panelRect(second);
    return Math.abs(rect.left - edited.left) <= 1 &&
      Math.abs(rect.top - edited.top) <= 1 &&
      Math.abs(rect.width - edited.width) <= 1 &&
      Math.abs(rect.height - edited.height) <= 1;
  }).toBe(true);
  const savedBeforeClose = await readLayout();

  // 从一个布局未变化的面板关闭；全局关闭会让所有标签页一起关闭，
  // 但关闭动作本身不得回写各标签页的旧尺寸。
  await second.locator(PANEL + ' .close').click();
  await expect(first.locator(PANEL + ' .panel')).toHaveCount(0);
  await expect(second.locator(PANEL + ' .panel')).toHaveCount(0);
  expect(await readLayout()).toEqual(savedBeforeClose);

  await openPanel(first);
  await expect.poll(async () => {
    const rect = await panelRect(first);
    return Math.abs(rect.left - edited.left) <= 1 &&
      Math.abs(rect.top - edited.top) <= 1 &&
      Math.abs(rect.width - edited.width) <= 1 &&
      Math.abs(rect.height - edited.height) <= 1;
  }).toBe(true);

  await first.close();
  await second.close();
});

// ---- 可调节性：抓手必须看得见，嵌入列的宽度必须真能拖 ----
//
// 用户反馈原话：「浮层和嵌入都有一个问题就是不好调节整个 recallflow 窗口框的大小，
// 且嵌入框的对话窗口明显太小了，还不能调节」。
// 前一半是可见性问题（八个手柄一直在，但抓手 opacity:0，看着像不能拖）；
// 后一半是宽度上限太紧（0.6 → 1280 视口最多 768px）。

test('四角抓手默认可见，hover 时更明显', async () => {
  await clearLayout();
  const page = await openFixturePage(context, '/');
  await openPanel(page);
  const opacity = await page.locator(PANEL + ' .resize-handle.bottom-right').evaluate((el) => {
    const idle = Number(getComputedStyle(el, '::after').opacity);
    return idle;
  });
  expect(opacity).toBeGreaterThan(0.2);
  await page.locator(PANEL + ' .resize-handle.bottom-right').hover();
  await expect
    .poll(async () =>
      Number(
        await page
          .locator(PANEL + ' .resize-handle.bottom-right')
          .evaluate((el) => getComputedStyle(el, '::after').opacity)
      )
    )
    .toBeGreaterThan(opacity);
  await page.close();
});

test('嵌入列能拖宽，页面右边距跟着变，比例写进布局存档', async () => {
  await clearLayout();
  const page = await openFixturePage(context, '/notes');
  await openPanel(page);
  await page.locator(PANEL + ' .p-head .mode-btn').click();
  await expect(page.locator(PANEL + ' .panel')).toHaveClass(/embedded/);
  // 宽度切换有 .16s 过渡：等「宽度与页面右边距对齐且稳定」再量，
  // 否则量到的是过渡中的中间值（过渡只改宽度，边距是立即写的）。
  await expect.poll(async () => {
    const rect = await panelRect(page);
    const margin = await page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.body).marginRight) || 0));
    return Math.abs(margin - rect.width) <= 1 && rect.width > 300;
  }).toBe(true);
  const before = await panelRect(page);
  const marginBefore = await page.evaluate(() => document.body.style.marginRight);
  expect(marginBefore).toBe(before.width + 'px');

  // 拖嵌入列唯一的左缘抓手：往左 -220px 就是把对话区加宽 220px。
  const handle = page.locator(PANEL + ' .resize-handle.left');
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 5 - 220, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect.poll(async () => (await panelRect(page)).width).toBeGreaterThan(before.width + 150);
  const after = await panelRect(page);
  // 页面必须继续让位：右边距与面板宽度同值（否则面板会盖住正文）。
  await expect.poll(() => page.evaluate(() => document.body.style.marginRight)).toBe(after.width + 'px');
  // 比例落进布局存档，换页/新标签页才有同样的宽度。
  await expect.poll(async () => {
    const layout = await readLayout();
    return layout && layout.mode === 'embedded' ? Math.round(layout.ratio * page.viewportSize().width) : null;
  }).toBe(after.width);
  // 宽度上限已放宽：384 → 604 左右，远超旧上限 0.6×1280=768 之外？这里只要求「能拉宽」，
  // 上限本身由 tests/panel-layout-state.test.mjs 的常量断言守住。
  await page.close();
});

test('嵌入态窄栏里快捷提示保持单行（不白吃对话区高度）', async () => {
  await clearLayout();
  const page = await openFixturePage(context, '/notes');
  await openPanel(page);
  await page.locator(PANEL + ' .p-head .mode-btn').click();
  await expect(page.locator(PANEL + ' .panel')).toHaveClass(/embedded/);
  const rowHeight = await page.locator(PANEL + ' .quick-prompts').evaluate((el) => Math.round(el.getBoundingClientRect().height));
  // 单个按钮 30px + 3px padding：折成两行就是 ~63px 以上。
  expect(rowHeight).toBeLessThan(40);
  const bodyHeight = await page.locator(PANEL + ' .p-body').evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(bodyHeight).toBeGreaterThan(420);
  await page.close();
});

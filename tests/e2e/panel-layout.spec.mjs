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

// API Key 可选：本地 OpenAI 兼容服务留空时，面板不能误报"尚未配置"。
import { test, expect } from '@playwright/test';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  openPanel,
  createFreshPanelSession,
  readAiSettings,
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

test('API Key 留空：本地模型仍可直接使用，不显示缺密钥提示', async () => {
  await configureSettings(context, { apiKey: '' });
  const page = await openFixturePage(context);
  await openPanel(page);

  const banner = page.locator(PANEL + ' .api-key-banner');
  await expect(banner).toBeHidden();
  await expect(page.locator(PANEL + ' .cmd-input')).toBeEnabled();
  await page.close();
});

test('自动批准浮层：点击面板外或面板其它区域都关闭', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  await openPanel(page);

  const popover = page.locator(PANEL + ' .approval-settings-popover');
  const toggle = page.locator(PANEL + ' .approval-settings-toggle');
  await toggle.click();
  await expect(popover).toBeVisible();
  await expect(page.locator(PANEL + ' .approval-runjs')).toHaveCount(0);
  await expect(popover).not.toContainText('用户脚本 / 技能写入审批');
  await page.mouse.click(5, 5); // 面板外
  await expect(popover).toBeHidden();

  await toggle.click();
  await expect(popover).toBeVisible();
  // 点面板底部（面板内、浮层外）。浮层向上展开，会盖住对话区/头部；
  // 底部页脚在浮层下方，才是真正的"面板其它区域"。
  await page.locator(PANEL + ' .p-foot').click();
  await expect(popover).toBeHidden();
  await page.close();
});

test('远程 JEV 配置可保存并在重新打开设置页后恢复', async () => {
  await configureSettings(context);
  const sw = context.serviceWorkers()[0];
  const optionsUrl = await sw.evaluate(() => chrome.runtime.getURL('options.html'));
  const page = await context.newPage();
  await page.goto(optionsUrl);

  await expect(page.locator('#jev-schema-version')).toHaveValue('jev.recallflow.v1');
  await expect(page.locator('#jev-min-edge-confidence')).toHaveValue('0.8');
  await expect(page.locator('#jev-min-read')).toHaveCount(0);
  await expect(page.locator('#jev-min-action')).toHaveCount(0);
  await expect(page.locator('#jev-min-click')).toHaveCount(0);
  await expect(page.locator('#jev-min-wait')).toHaveCount(0);
  await expect(page.locator('#jev-min-target-operation')).toHaveCount(0);
  await page.locator('#jev-enabled').check();
  await page.locator('#jev-shadow-mode').uncheck();
  await page.locator('#jev-base-url').fill('https://example.com/');
  await page.locator('#jev-api-key').fill('jev-secret');
  await page.locator('#jev-model').fill('jev-action-v1');
  await page.locator('#jev-timeout').fill('8000');
  await page.locator('#jev-retries').fill('2');
  await page.locator('#jev-min-edge-confidence').fill('0.84');
  await page.locator('#jev-schema-version').fill('jev.recallflow.v2');
  await page.route('https://example.com/v1/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [
          { name: 'jev-action-v1', description: 'test', release_date: '2026-11-01' },
        ],
      }),
    });
  });
  await page.locator('#test-jev').click();
  await expect(page.locator('#jev-status')).toContainText('连接成功，模型可用');
  await page.locator('#save-btn').click();
  await expect(page.locator('#status')).toContainText('已保存');

  const saved = await readAiSettings(context);
  expect(saved.jev).toMatchObject({
    enabled: true,
    shadowMode: false,
    baseUrl: 'https://example.com',
    apiKey: 'jev-secret',
    model: 'jev-action-v1',
    requestTimeoutMs: 8000,
    maxRetries: 2,
    minEdgeConfidence: 0.84,
    schemaVersion: 'jev.recallflow.v2',
  });

  await page.reload();
  await expect(page.locator('#jev-enabled')).toBeChecked();
  await expect(page.locator('#jev-shadow-mode')).not.toBeChecked();
  await expect(page.locator('#jev-base-url')).toHaveValue('https://example.com');
  await expect(page.locator('#jev-api-key')).toHaveValue('jev-secret');
  await expect(page.locator('#jev-model')).toHaveValue('jev-action-v1');
  await expect(page.locator('#jev-timeout')).toHaveValue('8000');
  await expect(page.locator('#jev-retries')).toHaveValue('2');
  await expect(page.locator('#jev-min-edge-confidence')).toHaveValue('0.84');
  await expect(page.locator('#jev-schema-version')).toHaveValue('jev.recallflow.v2');
  await page.close();
});

test('TraceGraph 可视化按站点展示状态、边和节点详情', async () => {
  await configureSettings(context);
  const sw = context.serviceWorkers()[0];
  const now = Date.now();
  await sw.evaluate(async ({ key, graph }) => {
    await chrome.storage.local.set({ [key]: { 'https://example.com': graph } });
  }, {
    key: 'recallflow.tracegraph.v2',
    graph: {
      version: 2,
      siteKey: 'https://example.com',
      updatedAt: now,
      ttlMs: 30 * 60 * 1000,
      l0: {
        states: [
          {
            id: 's.product',
            name: 'ProductPage',
            urlPattern: '/*.html',
            staticAtoms: ['button', 'input:text'],
            dynamicAtoms: [],
          },
          {
            id: 's.cart',
            name: 'CartPage',
            urlPattern: '/checkout/cart',
            staticAtoms: ['button', 'table'],
            dynamicAtoms: [],
          },
        ],
        operations: [],
      },
      l1: {
        edges: [
          {
            id: 'e.add-to-cart',
            from: 'ProductPage',
            to: 'CartPage',
            g: '点击 Add to Cart 加入购物车',
            action: {
              tool: 'click_element',
              argsTemplate: { selector: '#product-addtocart-button' },
              risk: 'low',
            },
            slots: [],
            s: { semanticAnchor: { role: 'button', name: 'Add to Cart' } },
            r: 'low',
            phiMinus: [{
              kind: 'url_pattern',
              expr: '/*.html',
              source: 'structured',
            }],
            phiPlus: {
              kind: 'url_pattern',
              expr: '/checkout/cart',
              source: 'structured',
            },
            provenance: {
              recordIds: ['r.1'],
              verifiedAt: now,
              siteKey: 'https://example.com',
              ttlMs: 30 * 60 * 1000,
            },
            status: 'verified',
          },
          {
            id: 'e.add-to-cart-alternate',
            from: 'ProductPage',
            to: 'CartPage',
            g: '从推荐区加入购物车',
            action: {
              tool: 'click_element',
              argsTemplate: { selector: '#add-to-cart-alt' },
              risk: 'low',
            },
            slots: [],
            s: { semanticAnchor: { role: 'button', name: 'Buy Now' } },
            r: 'low',
            phiMinus: [{
              kind: 'url_pattern',
              expr: '/*.html',
              source: 'structured',
            }],
            phiPlus: {
              kind: 'url_pattern',
              expr: '/checkout/cart',
              source: 'structured',
            },
            provenance: {
              recordIds: ['r.2'],
              verifiedAt: now,
              siteKey: 'https://example.com',
              ttlMs: 30 * 60 * 1000,
            },
            status: 'verified',
          },
        ],
      },
      records: [{
        id: 'r.1',
        seq: 1,
        tool: 'click_element',
        argsRedacted: { selector: '#product-addtocart-button' },
        before: {
          url: 'https://example.com/product.html',
          urlPattern: '/*.html',
          title: 'Product',
          atomSignature: 'ProductPage#button+input:text#',
          counters: {},
          controls: [],
          dialog: null,
        },
        after: {
          url: 'https://example.com/checkout/cart',
          urlPattern: '/checkout/cart',
          title: 'Cart',
          atomSignature: 'CartPage#button+table#',
          counters: {},
          controls: [],
          dialog: null,
        },
        target: {
          role: 'button',
          name: 'Add to Cart',
          selector: '#product-addtocart-button',
        },
        result: { ok: true, summary: '已加入购物车' },
        verification: 'URL 已变化',
        risk: 'low',
        ts: now,
      }, {
        id: 'r.2',
        seq: 2,
        tool: 'click_element',
        argsRedacted: { selector: '#add-to-cart-alt' },
        before: {
          url: 'https://example.com/product.html',
          urlPattern: '/*.html',
          title: 'Product',
          atomSignature: 'ProductPage#button+input:text#',
          counters: {},
          controls: [],
          dialog: null,
        },
        after: {
          url: 'https://example.com/checkout/cart',
          urlPattern: '/checkout/cart',
          title: 'Cart',
          atomSignature: 'CartPage#button+table#',
          counters: {},
          controls: [],
          dialog: null,
        },
        target: {
          role: 'button',
          name: 'Buy Now',
          selector: '#add-to-cart-alt',
        },
        result: { ok: true, summary: '已从推荐区加入购物车' },
        verification: 'URL 已变化',
        risk: 'low',
        ts: now + 1,
      }],
      patchLog: [],
    },
  });

  const optionsUrl = await sw.evaluate(() => chrome.runtime.getURL('options.html'));
  const page = await context.newPage();
  await page.goto(optionsUrl);
  await expect(page.locator('#tracegraph-site-select')).toHaveValue('https://example.com');
  await expect(page.locator('#tracegraph-view-summary')).toContainText('2 个状态');
  await expect(page.locator('#tracegraph-view-summary')).not.toContainText('TTL');
  await expect(page.locator('#tracegraph-canvas svg')).toHaveCount(0);
  await expect(page.locator('#tracegraph-canvas canvas.tracegraph-interactive-canvas')).toBeVisible();
  await expect(page.locator('#tracegraph-canvas')).toHaveAttribute('data-node-count', '2');
  await expect(page.locator('#tracegraph-canvas')).toHaveAttribute('data-edge-count', '2');
  await page.locator('#tracegraph-detail .tracegraph-quick-node', {
    hasText: 'ProductPage',
  }).click();
  await expect(page.locator('#tracegraph-detail')).toContainText('ProductPage');
  await expect(page.locator('#tracegraph-detail')).toContainText('click_element');
  await expect(page.locator('#tracegraph-detail')).toContainText('#product-addtocart-button');
  await expect(page.locator('#tracegraph-expand')).toBeEnabled();
  await page.locator('#tracegraph-expand').click();
  await expect(page.locator('#tracegraph-dialog')).toBeVisible();
  await expect(page.locator('#tracegraph-dialog-canvas')).toHaveAttribute('data-node-count', '2');
  await expect(page.locator('#tracegraph-dialog-canvas')).toHaveAttribute('data-edge-count', '2');
  const centered = await page.locator('#tracegraph-dialog-canvas').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return {
      scale: Number(canvas.dataset.zoom),
      width: rect.width,
      height: rect.height,
      contentWidth: Number(canvas.dataset.viewBoxWidth) * Number(canvas.dataset.zoom),
    };
  });
  expect(centered.scale).toBeGreaterThan(0);
  expect(centered.width).toBeGreaterThan(300);
  expect(centered.contentWidth).toBeLessThanOrEqual(centered.width);
  const zoomBefore = await page.locator('#tracegraph-zoom-level').textContent();
  await page.locator('#tracegraph-zoom-in').click();
  await expect(page.locator('#tracegraph-zoom-level')).not.toHaveText(zoomBefore || '');
  const beforeDrag = await page.locator('#tracegraph-dialog-canvas').evaluate((canvas) => [
    canvas.dataset.canvasX,
    canvas.dataset.canvasY,
  ]);
  const canvasBox = await page.locator('#tracegraph-dialog-canvas').boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.mouse.move(canvasBox.x + 30, canvasBox.y + 30);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 90, canvasBox.y + 75, { steps: 4 });
  await page.mouse.up();
  const afterDrag = await page.locator('#tracegraph-dialog-canvas').evaluate((canvas) => [
    canvas.dataset.canvasX,
    canvas.dataset.canvasY,
  ]);
  expect(afterDrag).not.toEqual(beforeDrag);
  await page.locator('#tracegraph-zoom-reset').click();
  await page.locator('#tracegraph-dialog-detail .tracegraph-quick-node', {
    hasText: 'CartPage',
  }).click();
  await expect(page.locator('#tracegraph-dialog-detail')).toContainText('ProductPage → CartPage');
  await page.locator('#tracegraph-dialog-close').click();
  await expect(page.locator('#tracegraph-dialog')).toBeHidden();
  const desktopOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(desktopOverflow).toBe(false);

  await page.setViewportSize({ width: 420, height: 900 });
  await expect(page.locator('#tracegraph-canvas canvas.tracegraph-interactive-canvas')).toBeVisible();
  const mobileColumns = await page.locator('.tracegraph-explorer > .tracegraph-frame').evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns
  );
  expect(mobileColumns.split(' ')).toHaveLength(1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#tracegraph-delete-site').click();
  await expect(page.locator('#tracegraph-view-summary')).toContainText('本地还没有可展示的 TraceGraph');
  const storedAfterDelete = await sw.evaluate(async (key) => {
    const value = await chrome.storage.local.get(key);
    return value[key] || {};
  }, 'recallflow.tracegraph.v2');
  expect(Object.keys(storedAfterDelete)).toHaveLength(0);
  await page.close();
});

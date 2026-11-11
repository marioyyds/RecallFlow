import { test, expect } from '@playwright/test';

import {
  PANEL,
  closeExtension,
  configureSettings,
  createFreshPanelSession,
  launchExtension,
  openFixturePage,
  sendInstruction,
  waitForRunEnd,
} from './helpers.mjs';

const API_KEY = String(process.env.TYPESAFE_API_KEY || '');

function remoteJev(overrides = {}) {
  return {
    enabled: true,
    shadowMode: false,
    baseUrl: String(process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/+$/, ''),
    apiKey: API_KEY,
    model: String(process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest'),
    requestTimeoutMs: 20_000,
    maxRetries: 1,
    schemaVersion: 'jev.recallflow.v1',
    maxAttemptsPerRun: 8,
    maxConsecutiveActions: 4,
    maxRepeatedActionsWithoutProgress: 2,
    maxElementCandidates: 40,
    minReadConfidence: 0.6,
    minActionConfidence: 0.8,
    minClickConfidence: 0.86,
    minWaitConfidence: 0.5,
    minTargetOperationConfidence: 0.75,
    ...overrides,
  };
}

async function latestJevTrace(context) {
  const [sw] = context.serviceWorkers();
  if (!sw) return [];
  const traces = await sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith('recallflow.runTrace.v1.'))
      .map(([, value]) => value)
      .filter(Boolean)
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  });
  return Array.isArray(traces[0]?.entries)
    ? traces[0].entries.filter((entry) => entry && entry.phase === 'jev')
    : [];
}

test.describe('JEV remote live browser examples', () => {
  test.skip(!API_KEY, '设置 TYPESAFE_API_KEY 后才运行真实远程 JEV 用例');

  let context;

  test.beforeAll(async () => {
    context = await launchExtension();
    await configureSettings(context, {
      cdpEnabled: true,
      jev: remoteJev(),
    });
  });

  test.afterAll(async () => {
    await closeExtension(context);
  });

  test.beforeEach(async () => {
    await createFreshPanelSession(context);
  });

  test('明显按钮：远程 JEV 能直接完成 CLICK', async () => {
    const page = await openFixturePage(context, '/jev-click');
    await sendInstruction(page, 'JEV安全继续');
    await waitForRunEnd(page, 90_000);
    await expect.poll(() => page.evaluate(() => window.__clicked), { timeout: 20_000 }).toBe(true);
    const decisions = await latestJevTrace(context);
    expect(decisions.length).toBeGreaterThan(0);
  });

  test('单输入框：JEV 不再提供 TYPE_TEXT，改由慢思考回合写入且不重复', async () => {
    const page = await openFixturePage(context);
    await sendInstruction(page, '在搜索框输入 hello-jev-live');
    await waitForRunEnd(page, 90_000);
    await expect(page.locator(PANEL + ' .msg.ai')).not.toHaveCount(0);
    // 页面状态：值确实写进了输入框，且只出现一次（不是追加两遍）。
    await expect
      .poll(
        async () => {
          const value = await page.locator('#q').inputValue();
          return value.split('hello-jev-live').length - 1;
        },
        { timeout: 20_000 }
      )
      .toBe(1);
    // 模型侧：这一轮的 JEV 决策里从未执行过 TYPE_TEXT（输入已交给慢思考）。
    const decisions = await latestJevTrace(context);
    expect(decisions.length).toBeGreaterThan(0);
    expect(
      decisions.map((entry) => String(entry.decision && entry.decision.operation ? entry.decision.operation : ''))
    ).not.toContain('TYPE_TEXT');
  });

  test('异步搜索：JEV/慢思考协同完成输入、点击和等待', async () => {
    const page = await openFixturePage(context, '/search');
    await sendInstruction(page, '在这个页面的站内搜索里搜「咖啡」');
    await waitForRunEnd(page, 90_000);
    await expect.poll(() => page.evaluate(() => window.__searched), { timeout: 20_000 }).toBeGreaterThan(0);
    const decisions = await latestJevTrace(context);
    expect(decisions.length).toBeGreaterThan(0);
  });

  test('多步表单：JEV 不抢高风险提交，慢思考能接续完成', async () => {
    const page = await openFixturePage(context, '/checkout');
    await sendInstruction(
      page,
      '帮我在这家店下单：商品选「埃塞俄比亚 耶加雪菲」，数量 2，收货地址填「上海市浦东新区 1 号」，勾选确认后提交订单。'
    );
    await waitForRunEnd(page, 120_000);
    await expect.poll(() => page.evaluate(() => window.__submits), { timeout: 20_000 }).toBeGreaterThan(0);
    const decisions = await latestJevTrace(context);
    expect(decisions.length).toBeGreaterThan(0);
  });
});

// 真正的持久化验收：关闭整个浏览器上下文，再用同一用户数据目录重启。
// 页面刷新只能证明 storage.session 可用，不能证明历史跨浏览器重启保留。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  openPanel,
  readActivePanelSession,
  PANEL,
} from './helpers.mjs';

let profileDir;
let context;

test.beforeAll(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recallflow-idb-'));
});

test.afterAll(() => {
  try {
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (e) {}
});

test('IndexedDB：关闭并重启浏览器后，完整会话仍在', async () => {
  context = await launchExtension({ userDataDir: profileDir });
  await configureSettings(context);
  const first = await openFixturePage(context);
  await openPanel(first);
  await first.locator(PANEL + ' .new-session-btn').click();
  await first.locator(PANEL + ' .cmd-input').fill('点击提交按钮');
  await first.locator(PANEL + ' .cmd-send').click();

  await expect
    .poll(async () => {
      const state = await readActivePanelSession(context);
      const messages = (state.session && state.session.messages) || [];
      return messages.some((m) => m.role === 'user' && m.content === '点击提交按钮') &&
        messages.some((m) => m.role === 'assistant')
        ? 1
        : 0;
    }, { timeout: 20_000 })
    .toBe(1);
  await closeExtension(context, { stopServers: false });
  context = null;

  // 同一 userDataDir 重新启动：storage.session 会被清空，IndexedDB 应保留。
  context = await launchExtension({ userDataDir: profileDir, startServers: false });
  const second = await openFixturePage(context);
  await openPanel(second);
  await expect(second.locator(PANEL + ' .user-turn', { hasText: '点击提交按钮' })).toHaveCount(1, {
    timeout: 15_000,
  });
  const restored = await readActivePanelSession(context);
  const messages = (restored.session && restored.session.messages) || [];
  expect(messages.some((m) => m.role === 'user' && m.content === '点击提交按钮')).toBe(true);
  expect(messages.length).toBeGreaterThanOrEqual(2);

  await closeExtension(context);
  context = null;
});

test('迁移：旧 storage.session 会话首次打开后进入 IndexedDB', async () => {
  const legacyProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'recallflow-legacy-'));
  let legacyContext;
  try {
    legacyContext = await launchExtension({ userDataDir: legacyProfile });
    const [sw] = legacyContext.serviceWorkers();
    await sw.evaluate(async () => {
      const id = 'S-legacy-test';
      const session = {
        id,
        title: '旧会话迁移验证',
        createdAt: 1,
        updatedAt: 2,
        seq: 1,
        messages: [
          { role: 'user', content: '迁移前的旧消息' },
          { role: 'assistant', content: '迁移前的旧回答' },
        ],
        origin: 'http://127.0.0.1:7802/',
        handoffId: 'RF-LEGACY',
        lastRunId: '',
        titleAuto: false,
      };
      const summary = {
        id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        seq: 1,
        messageCount: 2,
        origin: session.origin,
        handoffId: session.handoffId,
        lastRunId: '',
        titleAuto: false,
      };
      await chrome.storage.session.set({
        'recallflow.psess.index.v1': { version: 1, seq: 1, sessions: { [id]: summary } },
        ['recallflow.psess.v1.' + id]: session,
        'recallflow.psess.active.v1': { id, seq: 1, updatedAt: 2 },
      });
    });

    const page = await openFixturePage(legacyContext);
    await openPanel(page);
    await expect(page.locator(PANEL + ' .user-turn', { hasText: '迁移前的旧消息' })).toHaveCount(1, {
      timeout: 10_000,
    });
    const state = await readActivePanelSession(legacyContext);
    expect(state.session && state.session.messages.length).toBe(2);
    const oldStillInSession = await sw.evaluate(async () => {
      const d = await chrome.storage.session.get('recallflow.psess.index.v1');
      return Boolean(d && d['recallflow.psess.index.v1']);
    });
    expect(oldStillInSession, '迁移完成后旧 session key 应删除').toBe(false);

    await closeExtension(legacyContext);
    legacyContext = null;
  } finally {
    if (legacyContext) await closeExtension(legacyContext).catch(() => {});
    try {
      fs.rmSync(legacyProfile, { recursive: true, force: true });
    } catch (e) {}
  }
});

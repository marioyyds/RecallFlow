// 全浏览器会话：新建、切换历史、跨标签页同步、运行锁冲突。
import { test, expect } from '@playwright/test';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  openPanel,
  readActivePanelSession,
  panelText,
  PANEL,
} from './helpers.mjs';

let context;

test.beforeAll(async () => {
  context = await launchExtension();
});

test.afterAll(async () => {
  await closeExtension(context);
});

async function startNewSession(page) {
  await openPanel(page);
  const btn = page.locator(PANEL + ' .new-session-btn');
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(page.locator(PANEL + ' .user-turn')).toHaveCount(0);
}

async function send(page, text) {
  await page.locator(PANEL + ' .cmd-input').fill(text);
  await page.locator(PANEL + ' .cmd-send').click();
}

async function waitRunSaved(text) {
  await expect
    .poll(
      async () => {
        const state = await readActivePanelSession(context);
        const messages = (state.session && state.session.messages) || [];
        return (
          messages.some((m) => m.role === 'user' && String(m.content || '') === text) &&
          messages.some((m) => m.role === 'assistant')
        );
      },
      { timeout: 20_000 }
    )
    .toBe(true);
}

test('会话：新建后保留旧历史，切回能恢复完整对话', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  await startNewSession(page);
  await send(page, '点击提交按钮');
  await waitRunSaved('点击提交按钮');
  const first = await readActivePanelSession(context);
  const firstId = first.active.id;
  expect(first.session.messages.some((m) => m.role === 'user')).toBe(true);

  await page.locator(PANEL + ' .new-session-btn').click();
  await expect(page.locator(PANEL + ' .user-turn')).toHaveCount(0);
  const second = await readActivePanelSession(context);
  expect(second.active.id).not.toBe(firstId);
  expect(second.index.sessions[firstId]).toBeTruthy();

  await page.locator(PANEL + ' .session-btn').click();
  const oldItem = page.locator(PANEL + ' .session-item', { hasText: '点击提交按钮' });
  await expect(oldItem).toBeVisible();
  await oldItem.locator('.session-main').click();
  await expect(page.locator(PANEL + ' .user-turn', { hasText: '点击提交按钮' })).toHaveCount(1);
  await expect(page.locator(PANEL + ' .p-body')).toContainText('点击提交按钮');
  await page.close();
});

test('跨标签页：同一 active 会话自动加载；新建会话会同步到空闲标签页', async () => {
  await configureSettings(context);
  const a = await openFixturePage(context);
  await startNewSession(a);
  await send(a, '点击提交按钮');
  await waitRunSaved('点击提交按钮');

  const b = await openFixturePage(context);
  await openPanel(b);
  await expect(b.locator(PANEL + ' .user-turn', { hasText: '点击提交按钮' })).toHaveCount(1, {
    timeout: 15_000,
  });

  await b.locator(PANEL + ' .new-session-btn').click();
  // B 新建成为全局 active；A 空闲时应自动切到同一个新会话（旧历史仍在列表里）。
  await expect(a.locator(PANEL + ' .user-turn')).toHaveCount(0, { timeout: 15_000 });
  const state = await readActivePanelSession(context);
  expect(Object.keys(state.index.sessions || {}).length).toBeGreaterThanOrEqual(3);
  await a.close();
  await b.close();
});

test('运行锁：跟随页在另一端运行时保持只读，不能重复发起', async () => {
  await configureSettings(context);
  const a = await openFixturePage(context);
  await startNewSession(a);
  await send(a, '点击提交按钮');
  await expect(a.locator(PANEL + ' .cmd-send')).toBeDisabled({ timeout: 10_000 });

  const b = await openFixturePage(context);
  await openPanel(b);
  await expect(b.locator(PANEL + ' .user-turn', { hasText: '点击提交按钮' })).toHaveCount(1, {
    timeout: 15_000,
  });
  // 跟随页实时显示同一流，但不允许在 owner 运行期间重复发起。
  await expect(b.locator(PANEL + ' .cmd-send')).toBeDisabled({ timeout: 10_000 });
  await expect(b.locator(PANEL + ' .p-body')).toContainText('点击提交按钮');

  await a.close();
  await b.close();
});

test('面板开合：打开、关闭都会同步到其他标签页，新页面继承当前状态', async () => {
  await configureSettings(context);
  const a = await openFixturePage(context);
  await openPanel(a);
  await expect(a.locator(PANEL + ' .panel')).toBeVisible();

  // 新标签页加载时直接继承“已打开”，无需再点 FAB。
  const b = await openFixturePage(context);
  await expect(b.locator(PANEL + ' .panel')).toBeVisible({ timeout: 15_000 });

  // A 显式关闭 → B 同步关闭。
  await a.locator(PANEL + ' .close').click();
  await expect(a.locator(PANEL + ' .panel')).toHaveCount(0);
  await expect(b.locator(PANEL + ' .panel')).toHaveCount(0, { timeout: 15_000 });

  // 反向：B 打开 → A 同步打开。
  await openPanel(b);
  await expect(b.locator(PANEL + ' .panel')).toBeVisible();
  await expect(a.locator(PANEL + ' .panel')).toBeVisible({ timeout: 15_000 });

  // B 再关闭 → A 同步关闭。
  await b.locator(PANEL + ' .close').click();
  await expect(a.locator(PANEL + ' .panel')).toHaveCount(0, { timeout: 15_000 });

  await a.close();
  await b.close();
});

test('流式跟随：另一标签页中途加入也能看到思考与正文逐步出现', async () => {
  await configureSettings(context);
  const a = await openFixturePage(context);
  await startNewSession(a);
  await send(a, '说说你的思考');
  await expect(a.locator(PANEL + ' .think-block')).toHaveCount(1, { timeout: 10_000 });

  // 新页会自动继承已打开的面板，并订阅当前 active run。
  const b = await openFixturePage(context);
  await expect(b.locator(PANEL + ' .panel')).toBeVisible({ timeout: 15_000 });
  await expect(b.locator(PANEL + ' .user-turn', { hasText: '说说你的思考' })).toHaveCount(1, {
    timeout: 10_000,
  });
  await expect(b.locator(PANEL + ' .think-block')).toContainText('先确认页面结构', {
    timeout: 4_000,
  });
  // 4 秒的流中间窗口内，正文还没到：证明 B 跟随的是增量，而不是任务结束后的一次性快照。
  expect(await panelText(b, '.p-body')).not.toContain('我想好了');

  // 跟随页整页刷新后重新订阅，靠 snapshot 接回当前 run（而不是等最终落盘）。
  await b.reload();
  await expect(b.locator(PANEL + ' .panel')).toBeVisible({ timeout: 15_000 });
  await expect(b.locator(PANEL + ' .user-turn', { hasText: '说说你的思考' })).toHaveCount(1, {
    timeout: 10_000,
  });

  // 后续正文也继续同步，而不是停在加入时的快照。
  await expect.poll(() => panelText(b, '.p-body'), { timeout: 15_000 }).toContain('我想好了');
  await expect.poll(() => panelText(b, '.p-body'), { timeout: 10_000 }).toContain('补充一句');
  // 结束后跟随页恢复为可输入，并收到正式落盘后的消息。
  await expect(b.locator(PANEL + ' .cmd-send')).toBeEnabled({ timeout: 10_000 });

  await a.close();
  await b.close();
});

test('流式跟随：后加入页面能看到已经发生的工具步骤与后续结果', async () => {
  await configureSettings(context);
  const a = await openFixturePage(context);
  await startNewSession(a);
  await send(a, '点击提交按钮');
  await expect(a.locator(PANEL + ' .agent-step')).not.toHaveCount(0, { timeout: 10_000 });

  const b = await openFixturePage(context);
  await expect(b.locator(PANEL + ' .panel')).toBeVisible({ timeout: 15_000 });
  await expect(b.locator(PANEL + ' .agent-step', { hasText: 'click_element' }).first()).toBeVisible({
    timeout: 10_000,
  });
  await expect
    .poll(() => panelText(b, '.p-body'), { timeout: 15_000 })
    .toMatch(/已点击|完成|提交/);
  await a.close();
  await b.close();
});

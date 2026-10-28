// 标题栏 token chip（`span.usage`）在会话切换时的重置行为。
//
// 背景（TITA-52）：点「＋ 新建会话」后，全新的空会话标题栏仍显示上一个会话的
// `tokens 257768`。chip 只在「新一轮开始」（`chat.js` 的 `run()`）里被清空，
// 而新建 / 切换 / 删除回退这三条路径都只换 `panelSessionId`，不碰 chip。
//
// 这里不复刻线上环境，而是用最小 DOM + 内存版后台真跑一遍 chat.js：
// 先让跟随运行把 chip 写成 `tokens 257768`（复现残留的前提），再走三条 UI 路径，
// 断言 chip 被清空。第四条是反向保护：删**别的**会话不能把当前会话的 token 也清掉
// —— 防止把修复写成「会话列表一变就清空」。
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.mjs';
import { installChrome, restoreChrome } from './helpers/chrome-stub.mjs';
import { createChromeRuntimeAdapter } from '../lib/adapters/chrome/runtime.ts';

let seq = 0;

const TOKENS = 257768;

/** 内存版后台：只实现面板会话相关的几条消息，行为固定、可断言。 */
function createBackend(sessionIds) {
  const sessions = new Map();
  const make = (id, title) => ({
    id,
    title,
    seq: 1,
    messages: [],
    messageCount: 0,
    tokenEstimate: 0,
    updatedAt: Date.now(),
    origin: 'https://example.test/page',
    handoffId: 'handoff-' + id,
  });
  for (const id of sessionIds) sessions.set(id, make(id, '会话 ' + id));
  const list = () => [...sessions.values()];
  const backend = {
    sessions,
    created: 0,
    // 只有 `followedId` 上的运行是「跟随中」的：chip 由它的快照写入。
    followedId: sessionIds[0],
    send(msg, cb) {
      let res;
      switch (msg && msg.type) {
        case 'panel:state':
          res = { ok: true, sessions: list(), activeId: sessionIds[0] };
          break;
        case 'panel:get':
          res = sessions.has(msg.id)
            ? { ok: true, session: sessions.get(msg.id), activeId: msg.id }
            : { ok: false, error: '会话不存在' };
          break;
        case 'panel:create': {
          const id = 'new-' + (backend.created += 1);
          const s = make(id, '新会话');
          sessions.set(id, s);
          res = { ok: true, session: s, sessions: list(), activeId: id };
          break;
        }
        case 'panel:activate':
          res = sessions.has(msg.id)
            ? { ok: true, session: sessions.get(msg.id), sessions: list(), activeId: msg.id }
            : { ok: false, error: '会话不存在' };
          break;
        case 'panel:delete':
          sessions.delete(msg.id);
          res = { ok: true, sessions: list(), activeId: list()[0] ? list()[0].id : '' };
          break;
        case 'panel:run:subscribe':
          // `selfOwned` = 这个页面自己就在跑，没有可跟随的远端运行。
          res =
            msg.sessionId === backend.followedId
              ? {
                  ok: true,
                  snapshot: {
                    runId: 'run-1',
                    status: 'running',
                    tokens: TOKENS,
                    cursor: 0,
                    startedAt: Date.now(),
                    instruction: '上一轮的指令',
                    messages: [],
                  },
                }
              : { ok: true, selfOwned: true };
          break;
        default:
          res = { ok: true };
      }
      cb(res);
    },
  };
  return backend;
}

async function boot(backend) {
  const dom = installDomStub();
  const prevChrome = installChrome();
  globalThis.chrome.runtime.sendMessage = (msg, cb) => backend.send(msg, cb);
  const mod = await import('../lib/ui/page/chat.ts?case=' + (seq += 1));
  mod.initAssistant({ runtime: createChromeRuntimeAdapter() });
  const shadow = () => {
    const host = dom.document.documentElement.querySelector('#__kb-ai-host');
    return host ? host.shadowRoot : null;
  };
  const panel = () => {
    const s = shadow();
    return s ? s.querySelector('.panel') : null;
  };
  const chip = () => {
    const p = panel();
    return p ? p.querySelector('.usage') : null;
  };
  const open = () =>
    dom.document.emit('keydown', { altKey: true, shiftKey: true, code: 'KeyR', key: 'R', repeat: false });
  const openMenu = () => {
    const p = panel();
    if (!p) return null;
    const btn = p.querySelector('.session-btn');
    btn.click();
    return p.querySelector('.session-menu');
  };
  return {
    dom,
    panel,
    chip,
    open,
    openMenu,
    async close() {
      // 先把还在飞的异步续体排空（典型：会话菜单打开后 `await refreshPanelSessionState()`
      // 会在下一个微任务里 renderSessionMenu）。不排空的话它们会在 dom.restore() 之后
      // 撞上 "document is not defined"，变成 "asynchronous activity after the test ended"。
      await settle(2);
      // 再按真实关闭路径（标题栏 ✕）走一遍：它会 resetFollowedRun → stopProgress，
      // 把 1s 的进度定时器和跟随轮询都清掉。
      try {
        const btn = panel() && panel().querySelector('.close');
        if (btn) btn.click();
      } catch (e) {}
      await settle(2);
      dom.restore();
      restoreChrome(prevChrome);
    },
  };
}

/** 等到 predicate 为真（避免用固定 sleep 让用例变慢／变脆）。 */
async function waitFor(predicate, label, timeoutMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('等待超时：' + label);
}

/** 同上但不断言：给「应该发生却没发生」的场景，让真正的断言去报错（错误信息更好读）。 */
async function waitUntil(predicate, timeoutMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

/** 让异步流程（确认框 → panel:delete → 重渲染）跑完：等几轮宏任务。 */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 5));
}

/** 开面板并等到 chip 被跟随运行的快照写成 `tokens 257768`（残留的前提条件）。 */
async function bootWithResidualTokens(sessionIds = ['s1', 's2']) {
  const backend = createBackend(sessionIds);
  const app = await boot(backend);
  app.open();
  await waitFor(app.panel, '面板应打开');
  await waitFor(
    () => app.chip() && app.chip().textContent === 'tokens ' + TOKENS,
    '跟随运行的快照应把 token 写进标题栏 chip（否则后面的"清空"断言没有意义）'
  );
  return { app, backend };
}

test('前置：跟随运行会把 token 写进标题栏 chip（残留的前提）', async () => {
  const { app } = await bootWithResidualTokens();
  try {
    assert.equal(app.chip().textContent, 'tokens ' + TOKENS);
  } finally {
    await app.close();
  }
});

test('＋ 新建会话后，标题栏 token chip 必须清空', async () => {
  const { app } = await bootWithResidualTokens();
  try {
    const menu = app.openMenu();
    const foot = menu.querySelector('.session-new');
    assert.ok(foot, '会话菜单底部必须有「＋ 新建会话」');
    foot.click();
    await waitUntil(() => app.chip().textContent === '');
    assert.equal(app.chip().textContent, '', '新建的会话是空的，标题栏不能残留上一个会话的 token');
  } finally {
    await app.close();
  }
});

test('切换到另一个会话后，标题栏 token chip 必须清空', async () => {
  const { app } = await bootWithResidualTokens();
  try {
    const menu = app.openMenu();
    const target = menu.querySelector('[data-session-action="switch"][data-session-id="s2"]');
    assert.ok(target, '会话菜单里应能切到 s2');
    menu.emit('click', { target });
    await waitUntil(() => app.chip().textContent === '');
    assert.equal(app.chip().textContent, '', '切过去的会话没有在跑，标题栏不能残留上一个会话的 token');
  } finally {
    await app.close();
  }
});

test('删除当前会话回退到另一个会话后，标题栏 token chip 必须清空', async () => {
  const { app } = await bootWithResidualTokens();
  try {
    const menu = app.openMenu();
    const del = menu.querySelector('[data-session-action="delete"][data-session-id="s1"]');
    assert.ok(del, '会话菜单里应能删除当前会话 s1');
    menu.emit('click', { target: del });
    const ok = await waitFor(() => app.panel().querySelector('.session-dialog-actions button.danger'), '应弹出删除确认框');
    ok.click();
    await waitUntil(() => app.chip().textContent === '');
    assert.equal(app.chip().textContent, '', '删掉当前会话后回退到的会话，标题栏不能残留被删会话的 token');
    // 确认真的回退到了 s2，而不是「chip 因为别的偶然原因空了」。
    const again = app.openMenu();
    assert.equal(
      again.querySelector('.session-item.active').getAttribute('data-session-id'),
      's2',
      '删除后应回退并激活 s2'
    );
  } finally {
    await app.close();
  }
});

test('反例保护：删除「别的」会话不得清掉当前会话正在显示的 token', async () => {
  const { app } = await bootWithResidualTokens();
  try {
    const menu = app.openMenu();
    const del = menu.querySelector('[data-session-action="delete"][data-session-id="s2"]');
    assert.ok(del, '会话菜单里应能删除 s2');
    menu.emit('click', { target: del });
    const ok = await waitFor(() => app.panel().querySelector('.session-dialog-actions button.danger'), '应弹出删除确认框');
    ok.click();
    // 删除走的是 async（确认框 → panel:delete → 重渲染），给几轮事件循环让它跑完。
    await settle();
    const again = app.openMenu();
    assert.equal(again.querySelector('[data-session-id="s2"]'), null, 's2 应真的被删掉了（否则这条用例是空的）');
    assert.equal(app.chip().textContent, 'tokens ' + TOKENS, '当前会话的 token 必须保留');
  } finally {
    await app.close();
  }
});

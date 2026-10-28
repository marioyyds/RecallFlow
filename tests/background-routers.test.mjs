import test from 'node:test';
import assert from 'node:assert/strict';

import { PanelMessageRouter } from '../lib/application/background/panel-router.ts';
import { AutomationMessageRouter } from '../lib/application/background/automation-router.ts';
import { handleAiStreamConnection } from '../lib/application/background/ai-stream-router.ts';

test('PanelMessageRouter：open-active 使用显式 tabId 并广播全局 UI', async () => {
  const ui = { open: true, seq: 1 };
  const broadcasts = [];
  const router = new PanelMessageRouter({
    store: {
      async setUi() {
        return { ui, changed: true };
      },
      async getUi() {
        return ui;
      },
    },
    async ensureSessions() {},
    broadcastSessions() {},
    broadcastUi(value, source) {
      broadcasts.push([value, source]);
    },
    sendToTab() {},
    async removeScreenshots() {},
  });

  const response = await router.handle({ type: 'panel:open-active', tabId: 42 }, { tabId: 7 });
  assert.deepEqual(response, { ok: true, ui });
  assert.deepEqual(broadcasts, [[ui, null]]);
  assert.equal(router.matches({ type: 'panel:save', id: 's1' }), true);
  assert.equal(router.matches({ type: 'run:delta' }), false);
});

test('AutomationMessageRouter：页面命令和用户脚本分别走注入的端口', async () => {
  const sent = [];
  const router = new AutomationMessageRouter({
    async queryTabs() {
      return [{ id: 3, url: 'https://example.test', active: true }];
    },
    async requestTab(tabId, message) {
      return { ok: true, tabId, command: message.command };
    },
    sendToTab(tabId, message) {
      sent.push([tabId, message]);
    },
    async createTab() {},
    async setLocal() {},
    async notify() {},
    isOperableUrl: () => true,
    userscripts: {
      async list() {
        return [{ id: 'script-1' }];
      },
      install: async () => ({ ok: true }),
      preview: async () => ({ ok: true }),
      installCode: async () => ({ ok: true }),
      previewCode: async () => ({ ok: true }),
      update: async () => ({ ok: true }),
      updateAll: async () => ({}),
      setEnabled: async () => ({ ok: true }),
      uninstall: async () => ({ ok: true }),
      search: async () => [],
      runOnTab: async () => ({ ok: true }),
      xhr: async () => ({ ok: true }),
    },
  });

  assert.deepEqual(await router.handle({ type: 'userscript:list' }, { tabId: 1, url: '' }), {
    ok: true,
    scripts: [{ id: 'script-1' }],
  });
  assert.deepEqual(await router.handle({ type: 'pageCommand', command: 'read_current_page' }, { tabId: 1, url: '' }), {
    ok: true,
    tabId: 3,
    command: 'read_current_page',
  });
  assert.deepEqual(await router.handle({ type: 'pick:start' }, { tabId: 3, url: '' }), { ok: true });
  assert.deepEqual(sent, [[3, { type: 'kbPickStart' }]]);
});

test('AiStreamRouter：忽略非 ai-stream 端口', () => {
  assert.equal(
    handleAiStreamConnection({ name: 'not-ai-stream' }, {}),
    undefined
  );
});

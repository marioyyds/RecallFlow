import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkspaceMessageRouter } from '../lib/application/background/workspace-router.ts';

test('WorkspaceMessageRouter：旧对话按来源 tab 隔离', async () => {
  const store = new Map();
  const storage = {
    async get(keys) {
      const list = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => store.has(key)).map((key) => [key, store.get(key)]));
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) store.set(key, value);
    },
  };
  const router = new WorkspaceMessageRouter({
    openOptions() {},
    openManager() {},
    sessionStorage: storage,
    async saveHandoff() {
      return { ok: true };
    },
    async getHandoff() {
      return { ok: true };
    },
    async listHandoffs() {
      return { ok: true, list: [] };
    },
  });

  assert.deepEqual(
    await router.handle({ type: 'conv:save', conversation: [{ role: 'user', content: 'hi' }] }, { tabId: 4 }),
    { ok: true }
  );
  assert.deepEqual(await router.handle({ type: 'conv:get' }, { tabId: 4 }), {
    conversation: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(await router.handle({ type: 'conv:get' }, { tabId: 5 }), { conversation: [] });
});

test('WorkspaceMessageRouter：扩展页面与 handoff 路由', async () => {
  const calls = [];
  const router = new WorkspaceMessageRouter({
    openOptions() {
      calls.push(['options']);
    },
    openManager(focusId) {
      calls.push(['manager', focusId]);
    },
    sessionStorage: {
      async get() {
        return {};
      },
      async set() {},
    },
    async saveHandoff(record, options) {
      return { ok: true, record, options };
    },
    async getHandoff(id, options) {
      return { ok: true, id, options };
    },
    async listHandoffs(limit) {
      return { ok: true, limit };
    },
  });

  await router.handle({ type: 'openOptions' }, { tabId: null });
  await router.handle({ type: 'openManager', focusId: 'x' }, { tabId: null });
  assert.deepEqual(calls, [['options'], ['manager', 'x']]);
  assert.deepEqual(await router.handle({ type: 'handoff:list', limit: 3 }, { tabId: null }), {
    ok: true,
    limit: 3,
  });
  assert.equal(router.matches({ type: 'ai' }), false);
});

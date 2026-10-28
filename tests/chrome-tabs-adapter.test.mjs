import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeTabsAdapter } from '../lib/adapters/chrome/tabs.ts';

test('Tabs adapter 将查询与打开操作转为 Promise', async () => {
  const opened = [];
  const tabs = createChromeTabsAdapter({
    runtime: { lastError: null },
    tabs: {
      query(_query, callback) {
        callback([{ id: 1, url: 'https://a.test' }]);
      },
      create(properties, callback) {
        opened.push(properties.url);
        callback?.({ id: 2, url: properties.url });
      },
    },
  });
  assert.deepEqual(await tabs.query({ active: true }), [{ id: 1, url: 'https://a.test' }]);
  assert.equal(await tabs.open('https://b.test'), 2);
  assert.deepEqual(opened, ['https://b.test']);
});

test('Tabs adapter 把 runtime 错误归一化为安全结果', async () => {
  const tabs = createChromeTabsAdapter({
    runtime: { lastError: { message: 'failed' } },
    tabs: {
      query(_query, callback) {
        callback([{ id: 1 }]);
      },
      create(_properties, callback) {
        callback?.({ id: 2 });
      },
    },
  });
  assert.deepEqual(await tabs.query({}), []);
  assert.equal(await tabs.open('https://x.test'), undefined);
});

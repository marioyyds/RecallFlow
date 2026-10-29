import test from 'node:test';
import assert from 'node:assert/strict';

import { ChromeStorageAdapter } from '../lib/adapters/chrome/storage.ts';

function area() {
  const calls = [];
  return {
    calls,
    asyncImpl(items, callback) {
      calls.push(['get', items]);
      callback({ alpha: 1 });
    },
    setImpl(items, callback) {
      calls.push(['set', items]);
      callback();
    },
    removeImpl(keys, callback) {
      calls.push(['remove', keys]);
      callback();
    },
  };
}

test('ChromeStorageAdapter：读写删除都转换为 Promise', async () => {
  const fake = area();
  const adapter = new ChromeStorageAdapter(
    {
      get: (...args) => fake.asyncImpl(...args),
      set: (...args) => fake.setImpl(...args),
      remove: (...args) => fake.removeImpl(...args),
    },
    { runtime: { lastError: null } }
  );

  assert.deepEqual(await adapter.get(['alpha']), { alpha: 1 });
  await adapter.set({ beta: 2 });
  await adapter.remove(['beta']);
  assert.deepEqual(fake.calls, [
    ['get', ['alpha']],
    ['set', { beta: 2 }],
    ['remove', ['beta']],
  ]);
});

test('ChromeStorageAdapter：Chrome lastError 转化为 rejection', async () => {
  const error = { runtime: { lastError: { message: 'quota exceeded' } } };
  const adapter = new ChromeStorageAdapter(
    {
      get(keys, callback) {
        callback({});
      },
      set(items, callback) {
        callback();
      },
      remove(keys, callback) {
        callback();
      },
    },
    error
  );

  await assert.rejects(() => adapter.get('alpha'), /quota exceeded/);
  await assert.rejects(() => adapter.set({ alpha: 1 }), /quota exceeded/);
  await assert.rejects(() => adapter.remove('alpha'), /quota exceeded/);
});

test('ChromeStorageAdapter：兼容只返回 Promise 的 MV3 存储实现', async () => {
  const adapter = new ChromeStorageAdapter(
    {
      async get() {
        return { alpha: 1 };
      },
      async set() {},
      async remove() {},
    },
    { runtime: { lastError: null } }
  );

  assert.deepEqual(await adapter.get('alpha'), { alpha: 1 });
  await adapter.set({ beta: 2 });
  await adapter.remove('beta');
});

test('ChromeStorageAdapter：onChanged 只转发对应存储区，并可取消订阅', () => {
  let listener = null;
  const events = {
    addListener(fn) { listener = fn; },
    removeListener(fn) { if (listener === fn) listener = null; },
  };
  const adapter = new ChromeStorageAdapter(
    { get(_keys, cb) { cb({}); }, set(_items, cb) { cb(); }, remove(_keys, cb) { cb(); } },
    { runtime: { lastError: null }, storage: { onChanged: events } },
    'local'
  );
  const seen = [];
  const unsubscribe = adapter.onChanged((changes) => seen.push(changes));

  listener({ alpha: { newValue: 1 } }, 'session');
  listener({ alpha: { newValue: 2 } }, 'local');
  assert.deepEqual(seen, [{ alpha: { newValue: 2 } }]);

  unsubscribe();
  assert.equal(listener, null);
});

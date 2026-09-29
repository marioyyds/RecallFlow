// 交接包存储层：读写、createdAt 保留、容量淘汰与清理、错误路径。
import test from 'node:test';
import assert from 'node:assert/strict';

import { saveHandoff, getHandoff, listHandoffs, KEY_PREFIX, INDEX_KEY, MAX_RECORDS } from '../lib/shared/handoff-store.js';

// 安装 chrome.storage.local 桩（行为对齐真实 API：get 接受字符串或数组）。
function installStorage() {
  const store = {};
  const stats = { get: 0, set: 0, remove: 0 };
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          stats.get += 1;
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
          return out;
        },
        async set(obj) {
          stats.set += 1;
          Object.assign(store, obj);
        },
        async remove(keys) {
          stats.remove += 1;
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete store[k];
        },
      },
    },
  };
  return { store, stats };
}

const AL = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
// 生成合法且互不相同的标识（6 位 base31 编码）
function idFor(n) {
  let s = '';
  let x = n;
  for (let i = 0; i < 6; i++) {
    s = AL[x % AL.length] + s;
    x = Math.floor(x / AL.length);
  }
  return 'RF-' + s;
}

test.beforeEach(() => {
  installStorage();
});

test.after(() => {
  globalThis.chrome = undefined;
});

test('saveHandoff + getHandoff: 往返保留全部字段', async () => {
  const saved = await saveHandoff({
    id: 'rf-7k2m9x',
    pageUrl: 'http://localhost:5173/cart',
    pageTitle: '购物车',
    messages: [{ role: 'user', content: '提交没反应' }],
    pickedElements: [{ selector: '#submit', source: { file: 'src/S.tsx', line: 42 } }],
    consoleEntries: [{ level: 'error', text: 'boom', at: 5 }],
    now: 1000,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.id, 'RF-7K2M9X');

  const got = await getHandoff('RF-7K2M9X');
  assert.equal(got.ok, true);
  assert.equal(got.record.pageTitle, '购物车');
  assert.equal(got.record.messages[0].content, '提交没反应');
  assert.equal(got.record.consoleErrors.length, 1);
  assert.equal(got.record.createdAt, 1000);
});

test('getHandoff: 标识也接受小写与省略前缀的写法', async () => {
  await saveHandoff({ id: 'RF-7K2M9X', now: 1 });
  assert.equal((await getHandoff('rf-7k2m9x')).ok, true);
  assert.equal((await getHandoff('7K2M9X')).ok, true);
});

test('getHandoff: 非法标识给出可读错误，不产生 notFound 混淆', async () => {
  const r = await getHandoff('not-an-id');
  assert.equal(r.ok, false);
  assert.equal(r.notFound, undefined);
  assert.ok(r.error.includes('标识无效'), r.error);
  assert.ok(r.error.includes('RF-7K2M9X'), r.error);
});

test('getHandoff: 未找到时说明可能原因（含保留上限）', async () => {
  const r = await getHandoff('RF-7K2M9X');
  assert.equal(r.ok, false);
  assert.equal(r.notFound, true);
  assert.ok(r.error.includes('RF-7K2M9X'), r.error);
  assert.ok(r.error.includes(String(MAX_RECORDS)), r.error);
});

test('saveHandoff: 非法 id 返回错误而不是抛异常', async () => {
  const r = await saveHandoff({ id: 'bad', messages: [] });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('合法'), r.error);
});

test('saveHandoff: 同一会话重复保存时保留首次 createdAt', async () => {
  await saveHandoff({ id: 'RF-7K2M9X', now: 1000 });
  const second = await saveHandoff({ id: 'RF-7K2M9X', now: 5000 });
  assert.equal(second.ok, true);
  const got = await getHandoff('RF-7K2M9X');
  assert.equal(got.record.createdAt, 1000, 'createdAt 应保持首次值');
  assert.equal(got.record.updatedAt, 5000, 'updatedAt 应更新');
});

test('saveHandoff: 超出上限时淘汰最旧记录并删除其存储键', async () => {
  const { store } = installStorage();
  const total = MAX_RECORDS + 3;
  for (let i = 0; i < total; i++) {
    const r = await saveHandoff({ id: idFor(i), now: 1000 + i });
    assert.equal(r.ok, true);
  }
  const index = store[INDEX_KEY];
  assert.equal(index.length, MAX_RECORDS);
  // 最新在前
  assert.equal(index[0].id, idFor(total - 1));
  // 最旧的三个键应已从存储中删除
  for (let i = 0; i < 3; i++) {
    assert.equal(store[KEY_PREFIX + idFor(i)], undefined, '应删除 ' + idFor(i));
  }
  // 最新的仍可读
  assert.equal((await getHandoff(idFor(total - 1))).ok, true);
});

test('listHandoffs: 按最近优先返回标识与时间', async () => {
  await saveHandoff({ id: idFor(1), now: 100 });
  await saveHandoff({ id: idFor(2), now: 200 });
  const r = await listHandoffs(10);
  assert.equal(r.ok, true);
  assert.equal(r.list.length, 2);
  assert.equal(r.list[0].id, idFor(2));
  assert.equal(r.list[0].at, 200);
});

test('listHandoffs: 无记录时返回空列表而非报错', async () => {
  const r = await listHandoffs();
  assert.equal(r.ok, true);
  assert.deepEqual(r.list, []);
});

test('存储不可用时三个接口都安全降级', async () => {
  globalThis.chrome = undefined;
  const s = await saveHandoff({ id: 'RF-7K2M9X' });
  assert.equal(s.ok, false);
  assert.ok(s.error.includes('存储不可用'), s.error);
  const g = await getHandoff('RF-7K2M9X');
  assert.equal(g.ok, false);
  const l = await listHandoffs();
  assert.equal(l.ok, false);
  assert.deepEqual(l.list, []);
});

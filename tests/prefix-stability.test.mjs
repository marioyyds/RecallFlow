// 请求前缀稳定性契约：
//
// 站点记忆与宏目录会被拼进**系统提示**，而系统提示是整段请求前缀的起点。
// 只要这段文本逐字节不变，DeepSeek 的前缀缓存就能命中；一旦顺序抖动，
// 缓存从 token 0 开始全部失效，整段历史都要重新 prefill。
//
// 这两个列表原先都用 updatedAt 做次级排序键 —— 命中数相同的条目会随使用悄悄换位，
// 前缀因此永远不稳定。这里用「updatedAt 与目标顺序刻意相反」的数据把回归钉死：
// 若有人把次级键改回时间戳，这些用例立刻失败。
import test from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'https://example.com';
const URL_A = ORIGIN + '/page';

const SITE_KEY = 'recallflow.siteMemory.v1';
const MACRO_KEY = 'recallflow.macros.v1';

// chrome.storage.local 桩：直接暴露底层 store，便于精确构造 updatedAt。
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
        return out;
      },
      async set(obj) {
        Object.assign(store, obj);
      },
    },
  },
};

const { getSiteHints } = await import('../lib/assistant/site-memory.js');
const { listMacros } = await import('../lib/assistant/macro-store.js');

const siteEntry = (selector, hits, updatedAt) => ({
  selector,
  label: selector,
  role: 'button',
  tag: 'button',
  hits,
  updatedAt,
});

const macroEntry = (name, hits, updatedAt) => ({
  name,
  description: '',
  steps: [{ tool: 'click_element', args: { selector: '#x' } }],
  hits,
  createdAt: 1,
  updatedAt,
});

test('getSiteHints: 命中数相同时按 selector 字典序，不受 updatedAt 影响', async () => {
  store[SITE_KEY] = {
    [ORIGIN]: {
      k1: siteEntry('#z', 1, 300),
      k2: siteEntry('#a', 1, 100),
      k3: siteEntry('#m', 1, 200),
    },
  };
  const hints = await getSiteHints(URL_A, 12);
  assert.deepEqual(
    hints.map((h) => h.selector),
    ['#a', '#m', '#z'],
    '次级键必须是稳定键；按 updatedAt 倒序会得到 #z,#m,#a'
  );
});

test('getSiteHints: 命中数仍然是主排序键', async () => {
  store[SITE_KEY] = {
    [ORIGIN]: {
      k1: siteEntry('#z', 5, 100),
      k2: siteEntry('#a', 1, 300),
    },
  };
  const hints = await getSiteHints(URL_A, 12);
  assert.deepEqual(hints.map((h) => h.selector), ['#z', '#a']);
});

test('getSiteHints: 重复读取结果逐字节一致（缓存可命中的前提）', async () => {
  store[SITE_KEY] = {
    [ORIGIN]: {
      k1: siteEntry('#z', 2, 300),
      k2: siteEntry('#a', 2, 100),
      k3: siteEntry('#m', 2, 200),
    },
  };
  const first = JSON.stringify(await getSiteHints(URL_A, 12));
  const second = JSON.stringify(await getSiteHints(URL_A, 12));
  assert.equal(first, second);
});

test('listMacros: 命中数相同时按 name 字典序，不受 updatedAt 影响', async () => {
  store[MACRO_KEY] = {
    [ORIGIN]: {
      b: macroEntry('beta', 0, 300),
      a: macroEntry('alpha', 0, 100),
      g: macroEntry('gamma', 0, 200),
    },
  };
  const macros = await listMacros(URL_A);
  assert.deepEqual(
    macros.map((m) => m.name),
    ['alpha', 'beta', 'gamma'],
    '次级键必须是稳定键；按 updatedAt 倒序会得到 beta,gamma,alpha'
  );
});

test('listMacros: 命中数仍然是主排序键', async () => {
  store[MACRO_KEY] = {
    [ORIGIN]: {
      b: macroEntry('beta', 7, 100),
      a: macroEntry('alpha', 1, 300),
    },
  };
  const macros = await listMacros(URL_A);
  assert.deepEqual(macros.map((m) => m.name), ['beta', 'alpha']);
});

test('listMacros: 重复读取结果逐字节一致（缓存可命中的前提）', async () => {
  store[MACRO_KEY] = {
    [ORIGIN]: {
      b: macroEntry('beta', 3, 300),
      a: macroEntry('alpha', 3, 100),
    },
  };
  const first = JSON.stringify(await listMacros(URL_A));
  const second = JSON.stringify(await listMacros(URL_A));
  assert.equal(first, second);
});

// 统一的 `chrome.*` 测试替身。
//
// ## 为什么要有它
//
// 此前 12 个测试文件各自造 `chrome.*`，其中 `chrome.storage.local` 的内存实现
// **至少被重写了 4 次**（session-store / trace-store / handoff-store / extension-collectors）。
// 每一次重写的行为细节（get 传 null 还是数组、set 是否合并、remove 的数组形态、
// 异步时序、事件通知）都可能不一致 ⇒ **同一份业务代码在不同测试里表现出不同的假行为**，
// 而这类差异恰好是最难排查的一类假绿/假红。
//
// 这里只做一件事：把「内存版 chrome」做成一份，行为写死并可被断言。
//
// ## 刻意不做的事
//
//   · **不做**通用 mock 框架（不引入 jest.fn 式的调用记录魔法）—— 需要观察调用时，
//     用下面的 `calls` 数组或自己传 overrides，比隐式全局记录更难误用；
//   · **不做**自动安装/卸载（不碰 globalThis 的隐式副作用）—— 由调用方显式
//     `installChrome()` / `restoreChrome()`，避免测试之间的隐式耦合。
//
// 用法：
//   import { createChromeStub, installChrome, restoreChrome } from './helpers/chrome-stub.mjs';
//   const prev = installChrome({ tabs: [{ id: 1, url: 'https://a/' }] });
//   // ... 测试 ...
//   restoreChrome(prev);

/** 内存版 storage area：行为对齐 MV3 的 get/set/remove 语义。 */
function createStorageArea(initial = {}, stats) {
  const store = { ...initial };
  return {
    // 仅供断言用：直接窥视当前内容，避免测试里再写一遍 get(null)。
    _dump: () => ({ ...store }),
    async get(key) {
      stats.get += 1;
      if (key === null || key === undefined) return { ...store };
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
        return out;
      }
      if (typeof key === 'object') {
        // MV3 允许 get({a: 1}) —— 第二个值是缺省值
        const out = {};
        for (const [k, dflt] of Object.entries(key)) {
          out[k] = Object.prototype.hasOwnProperty.call(store, k) ? store[k] : dflt;
        }
        return out;
      }
      return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
    },
    async set(obj) {
      stats.set += 1;
      stats.setKeys.push(Object.keys(obj));
      Object.assign(store, obj);
    },
    async remove(key) {
      stats.remove += 1;
      if (Array.isArray(key)) for (const k of key) delete store[k];
      else delete store[key];
    },
    async clear() {
      stats.remove += 1;
      for (const k of Object.keys(store)) delete store[k];
    },
  };
}

/**
 * 造一个内存版 chrome。
 * @param {Object} [opts]
 * @param {Array}  [opts.tabs]     初始标签页
 * @param {Object} [opts.local]    storage.local 初值
 * @param {Object} [opts.session]  storage.session 初值
 * @param {Object} [opts.overrides] 覆盖任意字段（例如 debugger / scripting）
 */
export function createChromeStub(opts = {}) {
  const tabs = (opts.tabs || [{ id: 1, url: 'https://example.com/', title: 'Example', active: true, windowId: 1 }]).map(
    (t, i) => ({ id: t.id ?? i + 1, windowId: 1, active: i === 0, ...t })
  );
  const stats = { get: 0, set: 0, remove: 0, setKeys: [], tabsQuery: 0, tabsGet: 0, tabsUpdate: 0, tabsCreate: 0, tabsRemove: 0 };
  const listeners = new Map();
  let nextTabId = Math.max(0, ...tabs.map((t) => t.id)) + 1;

  const local = createStorageArea(opts.local || {}, stats);
  const session = createStorageArea(opts.session || {}, stats);

  const chrome = {
    // 供断言：读写次数 / 被写过的键 / 当前标签页列表
    _stats: stats,
    _tabs: tabs,
    runtime: {
      lastError: null,
      id: 'test-extension-id',
      getURL: (p) => 'chrome-extension://test-extension-id/' + String(p || '').replace(/^\//, ''),
      // ⚠ 必须有 getManifest：页面侧 chat.js 的 isExtContextAlive() 除了看 runtime.id，
      // 还会**真的调一次** getManifest() 确认扩展上下文活着（旧内容脚本失效时这一步会抛）。
      // 缺了它，用本桩加载页面代码的测试会一路走进"扩展已失效"分支：
      // ensureHost() 直接 return，整套 UI 一个节点都不建，而测试看不出原因。
      getManifest: () => ({ manifest_version: 3, name: 'RecallFlow', version: '0.0.0-test' }),
      sendMessage: async () => undefined,
      // onMessage 要真的记住监听器：内容脚本的功能大半从这条通道进来
      //（panel:toggle / run:* / kbPickResult）。写成空壳的话，任何消息驱动的行为都没法测。
      onMessage: {
        _listeners: [],
        addListener(fn) { if (typeof fn === 'function') this._listeners.push(fn); },
        removeListener(fn) {
          const i = this._listeners.indexOf(fn);
          if (i >= 0) this._listeners.splice(i, 1);
        },
      },
      onInstalled: { addListener() {}, removeListener() {} },
    },
    storage: {
      local,
      session,
      sync: createStorageArea(opts.sync || {}, stats),
      onChanged: { addListener() {}, removeListener() {} },
    },
    tabs: {
      async query() {
        stats.tabsQuery += 1;
        return tabs.map((t) => ({ ...t }));
      },
      async get(id) {
        stats.tabsGet += 1;
        const hit = tabs.find((t) => t.id === Number(id));
        if (!hit) throw new Error('No tab with id: ' + id);
        return { ...hit };
      },
      async update(id, props) {
        stats.tabsUpdate += 1;
        const hit = tabs.find((t) => t.id === Number(id));
        if (!hit) throw new Error('No tab with id: ' + id);
        Object.assign(hit, props);
        return { ...hit };
      },
      async create(props) {
        stats.tabsCreate += 1;
        const t = { id: nextTabId++, windowId: 1, active: false, url: 'about:blank', title: '', ...props };
        tabs.push(t);
        return { ...t };
      },
      async remove(id) {
        stats.tabsRemove += 1;
        const i = tabs.findIndex((t) => t.id === Number(id));
        if (i >= 0) tabs.splice(i, 1);
      },
      sendMessage: async () => undefined,
      onRemoved: { addListener() {}, removeListener() {} },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    windows: {
      async get(id) {
        return { id: Number(id) || 1, focused: true, state: 'normal' };
      },
      async create(props) {
        return { id: 999, focused: false, state: 'minimized', ...props };
      },
      async remove() {},
      async update() {},
    },
    scripting: {
      async executeScript() {
        return [{ result: undefined }];
      },
      async insertCSS() {},
    },
    debugger: {
      async attach() {},
      async detach() {},
      async sendCommand() {
        return {};
      },
      onEvent: {
        addListener(fn) {
          const arr = listeners.get('debuggerEvent') || [];
          arr.push(fn);
          listeners.set('debuggerEvent', arr);
        },
        removeListener() {},
      },
    },
    notifications: { async create() {}, async clear() {} },
    alarms: { async create() {}, async clear() {} },
    contextMenus: { async create() {}, async removeAll() {} },
  };

  /** 测试用：把一条消息投给所有 onMessage 监听器（模拟后台 → 内容脚本）。 */
  chrome._emitMessage = (msg, sender) => {
    const out = [];
    for (const fn of chrome.runtime.onMessage._listeners.slice()) out.push(fn(msg, sender || {}));
    return out;
  };

  return Object.assign(chrome, opts.overrides || {});
}

/** 装到 globalThis，返回先前的 globalThis.chrome 以便还原。 */
export function installChrome(opts = {}) {
  const prev = globalThis.chrome;
  globalThis.chrome = createChromeStub(opts);
  return prev;
}

/** 配合 installChrome 的返回值还原（undefined 也要能还原，不能留下脏全局）。 */
export function restoreChrome(prev) {
  if (prev === undefined) delete globalThis.chrome;
  else globalThis.chrome = prev;
}

/**
 * 一次性用完即还原的包装：避免每个测试都写 try/finally。
 * @param {Object} opts
 * @param {(chrome: Object) => Promise<void>|void} fn
 */
export async function withChrome(opts, fn) {
  const prev = installChrome(opts);
  try {
    return await fn(globalThis.chrome);
  } finally {
    restoreChrome(prev);
  }
}

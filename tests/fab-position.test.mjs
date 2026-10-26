// FAB（悬浮气泡）位置逻辑的**行为**测试。
//
// ## 为什么重写这个
//
// `tests/fab-drag.test.mjs` 原本是 16 条 `assert.match(chatSource, /regex/)` ——
// 它只能证明"源码里有这行字"，证明不了"拖拽后气泡真的没被拖到屏幕外"。
// 那种断言改一行格式就红、改坏行为却不红，是最典型的一类假信心。
//
// 之所以能重写，是因为这段逻辑从 chat.js 抽到了 `lib/page/fab-position.ts`，
// 依赖改为**显式注入**（fab / window / storage / localStorage 都由外部给）。
// 于是它第一次可以在 node 里被真正执行 —— 这里用的全是假对象，不引入 jsdom。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFabController,
  normalizeFabRatio,
  FAB_EDGE_GAP,
  DEFAULT_FAB_RATIO,
  FAB_POSITION_KEY,
  LEGACY_FAB_POSITION_KEY,
} from '../lib/page/fab-position.ts';

/** 造一个可观察的假气泡元素。 */
function fakeFab(opts = {}) {
  return {
    offsetHeight: opts.offsetHeight || 0,
    style: { top: opts.top || '' },
    rectTop: opts.rectTop || 0,
    getBoundingClientRect() {
      return { top: this.rectTop };
    },
  };
}

/** 造一个内存版 storage.local。 */
function fakeStorage(initial = {}) {
  const store = { ...initial };
  const writes = [];
  return {
    writes,
    local: {
      async get(key) {
        if (key == null) return { ...store };
        return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
      },
      async set(obj) {
        writes.push(obj);
        Object.assign(store, obj);
      },
    },
  };
}

function fakeLocalStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    removeItem: (k) => map.delete(k),
    setItem: (k, v) => map.set(k, v),
    _has: (k) => map.has(k),
  };
}

function setup(opts = {}) {
  const fab = opts.fab === null ? null : fakeFab(opts.fab);
  const storage = fakeStorage(opts.stored || {});
  const localStore = fakeLocalStorage(opts.legacy || {});
  const ctl = createFabController({
    getFab: () => fab,
    win: { innerWidth: opts.innerWidth || 1280, innerHeight: opts.innerHeight || 800 },
    storage,
    localStore,
    now: () => 1700000000000,
  });
  return { fab, storage, localStore, ctl };
}

test('normalizeFabRatio：夹到 [0,1]，非数字给 null（让调用方决定回落）', () => {
  assert.equal(normalizeFabRatio(0.5), 0.5);
  assert.equal(normalizeFabRatio(-3), 0, '负数应夹到 0');
  assert.equal(normalizeFabRatio(9), 1, '大于 1 应夹到 1');
  assert.equal(normalizeFabRatio('abc'), null, '非数字必须返回 null，而不是 NaN 传播下去');
  assert.equal(normalizeFabRatio(null), null);
  assert.equal(normalizeFabRatio(undefined), null);
});

test('气泡高度：量不到时按窗口宽度回落（窄屏更小）', () => {
  assert.equal(setup({ fab: { offsetHeight: 60 } }).ctl.fabHeight(), 60, '能量到就用实测值');
  assert.equal(setup({ fab: { offsetHeight: 0 }, innerWidth: 1280 }).ctl.fabHeight(), 52);
  assert.equal(setup({ fab: { offsetHeight: 0 }, innerWidth: 600 }).ctl.fabHeight(), 46, '窄屏气泡更小');
  assert.equal(setup({ fab: null }).ctl.fabHeight(), 52, '没有元素也不该抛');
});

test('clampFabTop：永远不越界（上不越过留白、下不超出屏幕）', () => {
  const { ctl } = setup({ fab: { offsetHeight: 52 }, innerHeight: 800 });
  assert.equal(ctl.clampFabTop(-9999), FAB_EDGE_GAP, '负无穷也要夹到上留白');
  assert.equal(ctl.clampFabTop(99999), 800 - 52 - FAB_EDGE_GAP, '超出屏幕要夹到底部留白');
  assert.equal(ctl.clampFabTop(400), 400, '范围内的值原样返回');
  // 窗口极矮时不能出现 maxTop < min 的反转（那会让气泡跑到屏幕上方之外）
  const tiny = setup({ fab: { offsetHeight: 52 }, innerHeight: 60 }).ctl;
  assert.ok(tiny.clampFabTop(-50) >= FAB_EDGE_GAP, '窗口再矮也不能小于上留白');
  assert.ok(tiny.clampFabTop(99999) >= FAB_EDGE_GAP, '窗口再矮也不能算出负数 top');
});

test('拖拽到屏幕外会被夹回，且持久化的是归一化比例而不是像素', async () => {
  const { fab, storage, ctl } = setup({ fab: { offsetHeight: 52, top: '400px' }, innerHeight: 800 });
  fab.style.top = ctl.clampFabTop(99999) + 'px';
  ctl.persist();
  assert.ok(Number.parseFloat(fab.style.top) <= 800 - 52 - FAB_EDGE_GAP, '不该停在屏幕外');
  const saved = storage.writes[storage.writes.length - 1][FAB_POSITION_KEY];
  assert.ok(saved.ratio <= 1 && saved.ratio >= 0, '存的是 [0,1] 的比例：' + saved.ratio);
  assert.equal(saved.updatedAt, 1700000000000, 'updatedAt 应来自注入的时钟（便于测试确定性）');
});

test('比例与像素往返一致（换窗口高度后位置按比例重算）', () => {
  const { ctl } = setup({ fab: { offsetHeight: 52 }, innerHeight: 800 });
  ctl.setRatio(0.5);
  const top = ctl.topFromRatio(0.5);
  assert.equal(ctl.ratioFromTop(top), 0.5, 'top → ratio 应回到同一个值（误差内）');
  // 底部比例 1 必须真的贴到底部留白处
  assert.equal(ctl.topFromRatio(1), 800 - 52 - FAB_EDGE_GAP);
  assert.equal(ctl.topFromRatio(0), FAB_EDGE_GAP);
});

test('load：从扩展存储读回已存的比例', async () => {
  const { fab, ctl } = setup({
    fab: { offsetHeight: 52 },
    innerHeight: 800,
    stored: { [FAB_POSITION_KEY]: { ratio: 0.75 } },
  });
  await ctl.load();
  assert.equal(ctl.getRatio(), 0.75);
  assert.ok(Number.parseFloat(fab.style.top) > FAB_EDGE_GAP, '读到比例后应立刻应用到元素上');
});

test('load：旧版 localStorage 位置迁移一次，并把旧键删掉', async () => {
  const { storage, localStore, ctl } = setup({
    fab: { offsetHeight: 52 },
    legacy: { [LEGACY_FAB_POSITION_KEY]: JSON.stringify({ ratio: 0.2 }) },
  });
  await ctl.load();
  assert.equal(ctl.getRatio(), 0.2, '旧位置必须被继承，否则用户会觉得"升级后气泡跑了"');
  const migrated = storage.writes.some((w) => w[FAB_POSITION_KEY] && w[FAB_POSITION_KEY].ratio === 0.2);
  assert.ok(migrated, '迁移时应写回扩展存储，下次就不用再读旧的了');
  assert.equal(localStore._has(LEGACY_FAB_POSITION_KEY), false, '迁移后必须清掉旧键（避免两套真相）');
});

test('load：旧值是垃圾时不污染当前位置', async () => {
  const { ctl } = setup({
    fab: { offsetHeight: 52 },
    legacy: { [LEGACY_FAB_POSITION_KEY]: 'not-json{' },
  });
  await ctl.load();
  assert.equal(ctl.getRatio(), DEFAULT_FAB_RATIO, '解析失败应回落到默认比例而不是抛错');
});

test('方向键微调：每次 16px，连续上调不会越过顶部', () => {
  const { fab, ctl } = setup({ fab: { offsetHeight: 52, top: '100px' }, innerHeight: 800 });
  ctl.moveBy(-16);
  assert.equal(Number.parseFloat(fab.style.top), 84);
  for (let i = 0; i < 50; i++) ctl.moveBy(-16);
  assert.equal(Number.parseFloat(fab.style.top), FAB_EDGE_GAP, '一直上调应停在顶部留白，不能跑出屏幕');
});

test('没有气泡元素时所有操作都不抛（扩展在页面里可能还没挂载）', async () => {
  const { ctl } = setup({ fab: null });
  ctl.applySaved();
  ctl.persist();
  ctl.moveBy(10);
  await ctl.load();
  assert.ok(true, '走到这里说明没有抛 —— 这类"静默崩掉"会让整个面板起不来');
});

test('没有 storage 时也不抛（内容脚本在非扩展上下文里被加载过）', async () => {
  const fab = fakeFab({ offsetHeight: 52, top: '400px' });
  const ctl = createFabController({
    getFab: () => fab,
    win: { innerWidth: 1280, innerHeight: 800 },
    storage: null,
    localStore: null,
  });
  await ctl.load();
  assert.equal(ctl.getRatio(), DEFAULT_FAB_RATIO, '没有任何存储时应保持默认比例');
  // persist 在没有 storage 时只更新内存比例，不得抛 —— 注意它会按**当前 top** 重算，
  // 所以这里断言的是"没抛"而不是"比例仍是默认"。
  ctl.persist();
  assert.ok(ctl.getRatio() >= 0 && ctl.getRatio() <= 1);
});

test('窗口缩放后按同一比例重算位置（resize 时气泡不"跳"）', () => {
  const { fab, ctl } = setup({ fab: { offsetHeight: 52 }, innerHeight: 800 });
  ctl.setRatio(1);
  ctl.applySaved();
  const tallTop = Number.parseFloat(fab.style.top);
  // 换个更矮的窗口，比例不变 ⇒ 应重新贴到新的底部留白处
  const ctl2 = createFabController({
    getFab: () => fab,
    win: { innerWidth: 1280, innerHeight: 400 },
    storage: null,
    localStore: null,
  });
  ctl2.setRatio(1);
  ctl2.applySaved();
  const shortTop = Number.parseFloat(fab.style.top);
  assert.ok(shortTop < tallTop, '窗口变矮后底部位置应随之上移');
  assert.equal(shortTop, 400 - 52 - FAB_EDGE_GAP);
});

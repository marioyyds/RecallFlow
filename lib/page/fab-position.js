// 悬浮气泡（FAB）的位置逻辑 —— 从 chat.js 里抽出来的**可测**部分。
//
// ## 为什么要抽
//
// `lib/page/chat.js` 有 4975 行，且**只导出一个 `initAssistant`**，其余全是模块私有
// 并直接读 `window` / `fab` / `localStorage` / `chrome.storage`。结果是它**零测试覆盖** ——
// 不是没人想测，而是结构上没法测：`tests/fab-drag.test.mjs` 只能退化成
// 16 条 `assert.match(chatSource, /regex/)`，一个字符都没真正执行。
//
// 抽出来的判据（对齐仓库 C-1 的做法）：**把闭包依赖改成显式注入**。
// 注入之后，这段逻辑在 node 里用假的 window / storage / localStorage 就能跑起来，
// 于是"位置会不会被夹到屏幕外""旧位置会不会迁移"这类问题第一次可以被真断言回答。
//
// ⚠ 本模块属于内容脚本依赖树 —— 改它之后**必须**跑 `node scripts/build-content.mjs`，
// 否则 manifest 加载的仍是旧产物（产物 content.js 是提交进仓库的）。

export const FAB_POSITION_KEY = 'recallflow.fab-position.v1';
export const LEGACY_FAB_POSITION_KEY = 'recallflow-fab-position';
export const FAB_EDGE_GAP = 8;
export const DEFAULT_FAB_RATIO = 0.38;
/** 窄屏时气泡更小（与 panel-css 里的尺寸对应），无法测量时的回落值。 */
export const FAB_FALLBACK_HEIGHT_NARROW = 46;
export const FAB_FALLBACK_HEIGHT = 52;
const NARROW_WIDTH = 600;

/**
 * 归一化到 [0,1]；非数字返回 null（调用方据此决定是否回落默认值）。
 *
 * ⚠ null / undefined / '' 必须**显式**拦掉：`Number(null)` 与 `Number('')` 都是 0，
 * 会让它返回一个合法的 0 —— 于是"存的 ratio 是空"被当成"比例 0"，
 * 气泡会直接跳到屏幕最顶端。那是数据缺失，不是用户想要贴顶。
 */
export function normalizeFabRatio(value) {
  if (value === null || value === undefined || value === '') return null;
  const ratio = Number(value);
  return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : null;
}

/**
 * 造一个 FAB 位置控制器。
 *
 * @param {Object} deps
 * @param {() => Element|null} deps.getFab 取当前气泡元素（可能为 null）
 * @param {{innerWidth:number, innerHeight:number}} deps.win
 * @param {Object} [deps.storage] chrome.storage（可为 undefined，此时不持久化）
 * @param {Object} [deps.localStore] localStorage（可为 undefined）
 * @param {() => number} [deps.now]
 */
export function createFabController(deps = {}) {
  const getFab = typeof deps.getFab === 'function' ? deps.getFab : () => null;
  const win = deps.win || { innerWidth: 1280, innerHeight: 800 };
  const storage = deps.storage || null;
  const localStore = deps.localStore || null;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  let ratio = DEFAULT_FAB_RATIO;

  function fabHeight() {
    const fab = getFab();
    const measured = fab ? fab.offsetHeight : 0;
    return measured || (win.innerWidth <= NARROW_WIDTH ? FAB_FALLBACK_HEIGHT_NARROW : FAB_FALLBACK_HEIGHT);
  }

  function currentFabTop() {
    const fab = getFab();
    if (!fab) return FAB_EDGE_GAP;
    const styled = parseFloat(fab.style.top);
    return Number.isFinite(styled) ? styled : fab.getBoundingClientRect().top;
  }

  function clampFabTop(top) {
    const height = fabHeight();
    const maxTop = Math.max(FAB_EDGE_GAP, win.innerHeight - height - FAB_EDGE_GAP);
    return Math.min(maxTop, Math.max(FAB_EDGE_GAP, Number(top) || 0));
  }

  /** 可用行程：窗口高度减去气泡高度再减去上下留白，至少 1（避免除零）。 */
  function available() {
    const height = fabHeight();
    return Math.max(1, win.innerHeight - height - FAB_EDGE_GAP * 2);
  }

  function topFromRatio(r) {
    return clampFabTop(FAB_EDGE_GAP + r * available());
  }

  function ratioFromTop(top) {
    return normalizeFabRatio((clampFabTop(top) - FAB_EDGE_GAP) / available());
  }

  function applySaved() {
    const fab = getFab();
    if (!fab) return;
    fab.style.top = topFromRatio(ratio) + 'px';
  }

  /** 旧版本把位置存在页面级 localStorage 里，读一次并迁移到扩展存储。 */
  function legacyRatio() {
    if (!localStore) return null;
    try {
      const saved = JSON.parse(localStore.getItem(LEGACY_FAB_POSITION_KEY) || 'null');
      if (!saved || typeof saved !== 'object' || saved.ratio == null) return null;
      return normalizeFabRatio(saved.ratio);
    } catch (e) {
      return null;
    }
  }

  function clearLegacy() {
    if (!localStore) return;
    try {
      localStore.removeItem(LEGACY_FAB_POSITION_KEY);
    } catch (e) {}
  }

  function persist() {
    const fab = getFab();
    if (!fab) return;
    const next = ratioFromTop(currentFabTop());
    ratio = next == null ? DEFAULT_FAB_RATIO : next;
    if (!storage || !storage.local) return;
    try {
      const pending = storage.local.set({ [FAB_POSITION_KEY]: { ratio, updatedAt: now() } });
      if (pending && pending.catch) pending.catch(() => {});
    } catch (e) {}
    clearLegacy();
  }

  async function load() {
    if (storage && storage.local) {
      try {
        const stored = await storage.local.get(FAB_POSITION_KEY);
        let r = normalizeFabRatio(stored && stored[FAB_POSITION_KEY] && stored[FAB_POSITION_KEY].ratio);
        if (r == null) {
          const legacy = legacyRatio();
          if (legacy != null) {
            r = legacy;
            try {
              await storage.local.set({ [FAB_POSITION_KEY]: { ratio: r, updatedAt: now() } });
            } catch (e) {}
          }
        }
        if (r != null) ratio = r;
      } catch (e) {}
    } else {
      const legacy = legacyRatio();
      if (legacy != null) ratio = legacy;
    }
    clearLegacy();
    applySaved();
  }

  function moveBy(delta) {
    const fab = getFab();
    if (!fab) return;
    fab.style.top = clampFabTop(currentFabTop() + delta) + 'px';
    persist();
  }

  return {
    fabHeight,
    currentFabTop,
    clampFabTop,
    available,
    topFromRatio,
    ratioFromTop,
    applySaved,
    persist,
    load,
    moveBy,
    legacyRatio,
    getRatio: () => ratio,
    setRatio: (r) => {
      const v = normalizeFabRatio(r);
      if (v != null) ratio = v;
      return ratio;
    },
  };
}

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
/**
 * 面板关闭（默认态）时气泡留在视口里的宽度（px）。
 *
 * 取值判据：够宽让鼠标能碰到（≥10px 才好悬浮），又**明显小于**气泡直径
 *（宽屏 52 / 窄屏 46），否则"收起"就名不副实。收起后的 `right` 由
 * panel-css.js 里的 `.fab.peek` 给（52-12=40、46-12=34），两处必须一起改。
 */
export const FAB_PEEK_VISIBLE = 12;
/** 收起态打在气泡上的 class；样式（含过渡）全在 panel-css.js，这里只管状态。 */
export const FAB_PEEK_CLASS = 'peek';
/** 悬浮热区的宽容度（px）：鼠标压在露出条边缘时不必像素级精确。 */
export const FAB_PEEK_ZONE_PAD = 4;
/** 气泡直径与「距视口右缘」的 JS 镜像 —— 与 panel-css.js 里的 `.fab` 必须一致。 */
export const FAB_SIZE = 52;
export const FAB_RIGHT_GAP = 16;
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

// ---------------------------------------------------------------- 收起 / 展开
//
// TITA-36：面板关闭时（默认态）气泡贴到视口右缘、只露出一条边；鼠标悬浮、
// 键盘聚焦或正在拖拽时整颗滑出来。
//
// ## 为什么它必须是**视图态**，不能落盘（L-11）
//
// 气泡的上下位置确实要持久化（`ratio`，见上面），但"收不收起"是**此刻**的事：
// 它只取决于鼠标在哪、面板开没开，跟上次关掉时长什么样无关。一旦写进存档，
// 就会出现「上次悬浮着关的页面，下次打开气泡整颗露在外面」—— 而且它一定会和
// 面板的 `docked` 语义抢同一块存档，那是 TITA-9 第 2 轮被退回的同一个病。
// 所以这里**只**切 class：不写 localStorage、不写 chrome.storage、不进存档结构。

/**
 * 收起 / 展开的判定（纯函数，便于直测）。
 *
 * 只有「面板关着 + 没悬浮 + 没聚焦 + 没在拖」才收起。面板开着时不收起：
 * 面板打开期间气泡本来就 `hidden`（见 chat.js 的 openPanel），留一个半收起的
 * 状态只会让"面板关掉那一刻"闪一下 —— 那是个纯视觉噪声。
 *
 * @param {{panelOpen?: boolean, hovered?: boolean, focused?: boolean, dragging?: boolean}} [input]
 */
export function resolveFabPeek(input) {
  const s = input || {};
  if (s.panelOpen === true) return false;
  return !(s.hovered === true || s.focused === true || s.dragging === true);
}

/**
 * 鼠标是否还压在「这颗气泡的地盘」里。
 *
 * ⚠ 它存在的唯一理由：气泡是从视口外**向左**滑出来的。鼠标停在露出的那条边上时，
 *   气泡一展开就从鼠标底下挪走了，浏览器会**立刻**派发一次 pointerleave；
 *   如果据此收起，气泡又滑回鼠标底下 ⇒ 再派发 pointerenter ⇒ 来回抖
 *  （repro/fab-peek.mjs 可复现）。而且错过这一次之后，浏览器已经认为
 *   鼠标不在气泡上了 —— **不会再有第二次 leave**，于是要么抖、要么卡住。
 *
 *   所以收起**不能靠 pointerleave**，而要靠「鼠标当前坐标是否还在地盘里」：
 *   地盘 = 「收起态露出的那条边」∪「展开态的整颗」，两段都只依赖常量与**纵向**几何
 *  （横向的收起位移不参与）⇒ 不随 peek 变化 ⇒ 不会自激振荡；
 *   而 ∪ 里超出露出宽度的那一截只在**已经展开**时才可达，
 *   不会产生"鼠标还没碰到就弹出来"的幽灵热区。
 *
 * @param {{x: number, y: number, rect: {top: number, bottom: number}, viewportWidth: number, pad?: number}} input
 */
export function isPointerInFabZone(input) {
  const s = input || {};
  const viewportWidth = Number(s.viewportWidth);
  const rect = s.rect;
  if (!Number.isFinite(viewportWidth) || !rect) return false;
  const pad = Number.isFinite(Number(s.pad)) ? Number(s.pad) : FAB_PEEK_ZONE_PAD;
  const x = Number(s.x);
  const y = Number(s.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const inVerticalBand = y >= rect.top - pad && y <= rect.bottom + pad;
  if (!inVerticalBand) return false;
  // 收起态露出的那条边：贴着视口右缘，宽 FAB_PEEK_VISIBLE。
  const inCollapsedStrip = x >= viewportWidth - FAB_PEEK_VISIBLE - pad && x <= viewportWidth + pad;
  // 展开态的整颗：右缘在距视口右缘 FAB_RIGHT_GAP 处，直径 FAB_SIZE。
  const inExpandedBox = x >= viewportWidth - FAB_RIGHT_GAP - FAB_SIZE - pad && x <= viewportWidth - FAB_RIGHT_GAP + pad;
  return inCollapsedStrip || inExpandedBox;
}

/**
 * 造一个收起 / 展开控制器：记账 + 应用，不碰任何存储。
 *
 * @param {Object} deps
 * @param {() => Element|null} deps.getFab
 * @param {() => number} [deps.getViewportWidth] 布局视口宽度（不含滚动条），默认 1280
 * @param {(fab: Element, peeked: boolean) => void} [deps.applyPeek] 默认是切 class
 */
export function createFabPeekController(deps = {}) {
  const getFab = typeof deps.getFab === 'function' ? deps.getFab : () => null;
  const viewportWidth = typeof deps.getViewportWidth === 'function' ? deps.getViewportWidth : () => 1280;
  const applyPeek =
    typeof deps.applyPeek === 'function' ? deps.applyPeek : (fab, on) => fab.classList.toggle(FAB_PEEK_CLASS, on);
  const state = { panelOpen: false, hovered: false, focused: false, dragging: false };
  let peeked = resolveFabPeek(state);

  /** 按当前状态重算并写到元素上。返回是否处于收起态。 */
  function apply() {
    peeked = resolveFabPeek(state);
    const fab = getFab();
    if (fab) applyPeek(fab, peeked);
    return peeked;
  }

  function set(key, value) {
    const next = value === true;
    if (state[key] === next) return peeked;
    state[key] = next;
    return apply();
  }

  return {
    apply,
    isPeeked: () => peeked,
    getState: () => ({ ...state }),
    /**
     * 鼠标移动：只有**真的离开**气泡的地盘才收起。
     *
     * 不用 pointerleave：气泡向左滑出时会"自己离开鼠标"，那样要么抖要么卡住
     * （见 isPointerInFabZone 的注释）。所以收起的判据始终是坐标，不是边界事件。
     * ⚠ 悬浮态之外（绝大多数鼠标移动）这里只做一次布尔判断就返回，不读布局。
     */
    handlePointerMove: (x, y) => {
      if (!state.hovered) return peeked;
      const fab = getFab();
      if (!fab) return peeked;
      if (isPointerInFabZone({ x, y, rect: fab.getBoundingClientRect(), viewportWidth: viewportWidth() })) {
        return peeked;
      }
      return set('hovered', false);
    },
    setPanelOpen: (v) => {
      // 面板一开气泡就 hidden（chat.js 的 openPanel），"悬浮 / 聚焦 / 拖拽"三个
      // 信号都不可能再更新 —— 必须就地清空，否则关掉面板后会卡在"整颗显示"。
      if (v === true) {
        state.hovered = false;
        state.focused = false;
      }
      return set('panelOpen', v);
    },
    setHovered: (v) => set('hovered', v),
    setFocused: (v) => set('focused', v),
    setDragging: (v) => set('dragging', v),
  };
}

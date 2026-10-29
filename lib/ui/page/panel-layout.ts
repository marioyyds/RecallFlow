// 面板布局的「存档 / 读档 / 摆放」纯逻辑。
//
// 为什么把它从 chat.js 抽出来：这段判据原先散在三个地方，而且**三处口径互不一致** ——
//   · `removePanel()`：只有 `panel._manualPos || style.top !== 'auto'` 时才写位置；
//     默认停靠面板的 `top` 恰好就是 `auto`，于是「打开→关闭」这条路径**根本不写**。
//   · `openPanel()`：只有 `docked` 分支读已保存位置；划词气泡走的 `openPanel(x, y)`
//     完全按鼠标点摆放，不读存档。
//   · `persistPanelLayoutNow()`：只记录裸 `left/top`，没有「是否停靠 / 是否手动定位」，
//     于是读回来时无法区分「用户摆的位置」和「CSS 停靠默认位置」。
// 三处各自看都"说得通"，合起来就是用户看到的「关掉再开，位置变了」。
//
// 抽成纯函数（storage / viewport / 尺寸全部显式注入）以后，node:test 能直接跑
// 存档格式与摆放规则，而不是再对着源码做正则断言。
//
// 网页级旧存档协议（v2，只用于迁移）：
//   `recallflow-panel-pos`  = { version: 2, docked: boolean, left: number|null, top: number|null }
//   `recallflow-panel-size` = { version: 2, width: number, height: number }
// 全浏览器统一布局（v2，运行时的权威来源）：
//   `recallflow.panel.layout.v1` =
//     { version: 2, docked: boolean, left: number|null, top: number|null,
//       width: number|null, height: number|null }
// 扩展存储不按网页 origin 隔离，也不会被网站自己的 localStorage 清理影响。
// `left/top` 为 null 表示「自动停靠」——位置由 CSS 的 bottom/right 决定，会随视口变化；
// 有值表示用户手动摆放过的像素位置。这样两种状态都能精确还原，不再靠 `top:auto` 猜。
// 旧版（v1，只有裸 `{left, top}`）读档时按「手动位置」兼容，`docked` 留 null 由打开路径决定。

export const PANEL_POS_KEY = 'recallflow-panel-pos';
export const PANEL_SIZE_KEY = 'recallflow-panel-size';
export const PANEL_LAYOUT_STORAGE_KEY = 'recallflow.panel.layout.v1';
export const PANEL_MIN_WIDTH = 280;
export const PANEL_MIN_HEIGHT = 320;
// 与 CSS 的 `max-width: calc(100vw - 24px)` / `max-height: calc(100vh - 24px)` 同一个口径。
export const PANEL_VIEWPORT_INSET = 24;
export const PANEL_LAYOUT_VERSION = 2;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 视口尺寸。测试里注入，浏览器里由 caller 从 window 取。 */
export interface Viewport {
  width?: number;
  height?: number;
}

function normalizeViewport(viewport: Viewport | null | undefined): { width: number; height: number } {
  const width = Number(viewport && viewport.width);
  const height = Number(viewport && viewport.height);
  return {
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
  };
}

/** 尺寸夹取：不低于 280×320，不超过视口（与旧实现同一套数字）。无法解析返回 null。 */
export function clampPanelSize(size: { width?: number; height?: number } | null | undefined, viewport: Viewport | null | undefined): { width: number; height: number } | null {
  const { width: vw, height: vh } = normalizeViewport(viewport);
  const width = Number(size && size.width);
  const height = Number(size && size.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return {
    width: Math.max(1, Math.min(vw - PANEL_VIEWPORT_INSET, Math.max(PANEL_MIN_WIDTH, width))),
    height: Math.max(1, Math.min(vh - PANEL_VIEWPORT_INSET, Math.max(PANEL_MIN_HEIGHT, height))),
  };
}

/**
 * 读回上次关闭时的布局。
 * 容错：任何一段 JSON 坏掉都只丢那一段，不抛；不认识的字段忽略。
 */
export interface PanelLayoutSnapshot {
  width: number | null;
  height: number | null;
  left: number | null;
  top: number | null;
  docked: boolean | null;
  hasPos: boolean;
}

/** 最简 storage 接口：只需要 getItem/setItem（localStorage 与测试桩都满足）。 */
export interface LayoutStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 面板布局异步存储端口。扩展存储与测试内存实现都满足这个最小接口。 */
export interface PanelLayoutStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** 读档的初始形态：四个字段都还没值。抽成函数是为了让返回类型一次说清，
 *  不必给一个模块级 const 补标注（本批的口径是「先给导出签名加类型」）。 */
function emptySnapshot(): PanelLayoutSnapshot {
  return { width: null, height: null, left: null, top: null, docked: null, hasPos: false };
}

function snapshotFromParts(pos: any, size: any): PanelLayoutSnapshot {
  const out = emptySnapshot();
  if (size && isFiniteNumber(Number(size.width)) && Number(size.width) > 0) out.width = Number(size.width);
  if (size && isFiniteNumber(Number(size.height)) && Number(size.height) > 0) out.height = Number(size.height);
  if (pos && isFiniteNumber(pos.left) && isFiniteNumber(pos.top)) {
    out.left = pos.left;
    out.top = pos.top;
    out.hasPos = true;
  }
  if (pos && typeof pos.docked === 'boolean') out.docked = pos.docked;
  return out;
}

function snapshotHasLayout(snapshot: PanelLayoutSnapshot): boolean {
  return (
    snapshot.hasPos ||
    snapshot.width != null ||
    snapshot.height != null ||
    snapshot.docked != null
  );
}

export function readPanelLayout(storage: LayoutStorageLike | null | undefined): PanelLayoutSnapshot {
  if (!storage) return emptySnapshot();
  let pos = null;
  let size = null;
  try {
    pos = JSON.parse(storage.getItem(PANEL_POS_KEY) || 'null');
  } catch (e) {
    pos = null;
  }
  try {
    size = JSON.parse(storage.getItem(PANEL_SIZE_KEY) || 'null');
  } catch (e) {
    size = null;
  }
  return snapshotFromParts(pos, size);
}

/** 解析扩展存储里的统一布局记录；损坏或旧形状返回空快照。 */
export function readGlobalPanelLayout(value: unknown): PanelLayoutSnapshot {
  if (!value || typeof value !== 'object') return emptySnapshot();
  return snapshotFromParts(value, value);
}

/**
 * 写回布局。`manualPos` 为真才记录 left/top；否则记 null（= 自动停靠）。
 * `docked` 必须如实记录，否则重开时无法还原停靠/浮动态。
 * `writeSize === false` 时只更新位置（打开瞬间的自动高度不该被当成用户尺寸存下来）。
 * @returns 实际写下的记录；写失败返回 null
 */
export function writePanelLayout(
  storage: LayoutStorageLike | null | undefined,
  snapshot: {
    width?: number;
    height?: number;
    left?: number;
    top?: number;
    docked?: boolean;
    manualPos?: boolean;
    writeSize?: boolean;
  } | null
): { width: number | null; height: number | null; left: number | null; top: number | null; docked: boolean } | null {
  if (!storage) return null;
  const s = snapshot || {};
  const width = Number(s.width);
  const height = Number(s.height);
  const record = {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    left: s.manualPos === true && isFiniteNumber(s.left) ? Math.round(s.left) : null,
    top: s.manualPos === true && isFiniteNumber(s.top) ? Math.round(s.top) : null,
    docked: s.docked === true,
  };
  try {
    if (s.writeSize !== false && record.width && record.height) {
      storage.setItem(
        PANEL_SIZE_KEY,
        JSON.stringify({ version: PANEL_LAYOUT_VERSION, width: record.width, height: record.height })
      );
    }
    storage.setItem(
      PANEL_POS_KEY,
      JSON.stringify({ version: PANEL_LAYOUT_VERSION, docked: record.docked, left: record.left, top: record.top })
    );
  } catch (e) {
    return null;
  }
  return record;
}

function globalPanelLayoutRecord(snapshot: {
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  docked?: boolean;
  manualPos?: boolean;
} | null) {
  const s = snapshot || {};
  const width = Number(s.width);
  const height = Number(s.height);
  return {
    version: PANEL_LAYOUT_VERSION,
    docked: s.docked === true,
    left: s.manualPos === true && isFiniteNumber(s.left) ? Math.round(s.left) : null,
    top: s.manualPos === true && isFiniteNumber(s.top) ? Math.round(s.top) : null,
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
  };
}

/**
 * 读取全浏览器统一布局。
 *
 * `legacyStorage` 是当前网页的 localStorage：只有扩展存储里还没有布局时才读取并迁移。
 * 迁移后，网页自己的 localStorage 清理、同域多标签页和无痕/跨站页面都不会再影响布局。
 */
export async function loadGlobalPanelLayout(
  storage: PanelLayoutStorage | null | undefined,
  legacyStorage?: LayoutStorageLike | null
): Promise<PanelLayoutSnapshot> {
  if (!storage) return readPanelLayout(legacyStorage);
  let data: Record<string, unknown> = {};
  try {
    data = await storage.get(PANEL_LAYOUT_STORAGE_KEY);
  } catch (e) {
    // 扩展存储偶发不可用时，至少保留当前页的旧布局，不要把面板直接重置。
    return readPanelLayout(legacyStorage);
  }
  const current = readGlobalPanelLayout(data && data[PANEL_LAYOUT_STORAGE_KEY]);
  if (snapshotHasLayout(current)) return current;

  const legacy = readPanelLayout(legacyStorage);
  if (!snapshotHasLayout(legacy)) return emptySnapshot();
  const record = globalPanelLayoutRecord({
    width: legacy.width == null ? undefined : legacy.width,
    height: legacy.height == null ? undefined : legacy.height,
    left: legacy.left == null ? undefined : legacy.left,
    top: legacy.top == null ? undefined : legacy.top,
    docked: legacy.docked === true,
    manualPos: legacy.hasPos,
  });
  try {
    await storage.set({ [PANEL_LAYOUT_STORAGE_KEY]: record });
  } catch (e) {
    // 迁移写入失败仍可用旧布局开启本次面板；下一次打开会再尝试。
  }
  return legacy;
}

/**
 * 写入全浏览器统一布局。
 *
 * `writeSize=false` 用于打开面板时只更新位置：先合入扩展存储里已有的用户尺寸，
 * 避免把刚算出的自动高度固化成用户尺寸。
 */
export async function saveGlobalPanelLayout(
  storage: PanelLayoutStorage | null | undefined,
  snapshot: {
    width?: number;
    height?: number;
    left?: number;
    top?: number;
    docked?: boolean;
    manualPos?: boolean;
    writeSize?: boolean;
  } | null
): Promise<ReturnType<typeof readGlobalPanelLayout> | null> {
  if (!storage) return null;
  let current = emptySnapshot();
  try {
    const data = await storage.get(PANEL_LAYOUT_STORAGE_KEY);
    current = readGlobalPanelLayout(data && data[PANEL_LAYOUT_STORAGE_KEY]);
  } catch (e) {
    return null;
  }
  const s = snapshot || {};
  const writeSize = s.writeSize !== false;
  const record = globalPanelLayoutRecord({
    ...s,
    width: writeSize ? s.width : current.width == null ? undefined : current.width,
    height: writeSize ? s.height : current.height == null ? undefined : current.height,
  });
  try {
    await storage.set({ [PANEL_LAYOUT_STORAGE_KEY]: record });
  } catch (e) {
    return null;
  }
  return readGlobalPanelLayout(record);
}

/**
 * 决定重开时面板摆在哪。
 *
 * 优先级：**存档里有手动位置 → 用它**（两条打开路径一视同仁，这是修复的核心）；
 * 否则按打开路径的意图摆放。
 *
 * 「停靠还是浮动」由**调用方意图**决定，不由存档决定（评审退回项）：FAB / `Alt+Shift+R`
 * 一律打开停靠面板、划词气泡一律打开浮动面板，存档只负责把位置与尺寸还回来。
 * 否则「上次是气泡关的」会让 FAB 之后再也不停靠，等于把停靠模式悄悄改掉。
 * 只有 `docked == null`（自动恢复：SPA 保活重挂 / 跨标签页同步 / run 恢复）才沿用存档，
 * 因为那条路径要的正是「还原关闭前的样子」。
 *
 * @param options
 * @returns 摆放结果：四条边里只有一对有值（left/top 手动位置，或 right/bottom 停靠）
 */
/** 摆放结果。left/top 与 right/bottom 互斥：前者是手动像素位置，后者是 CSS 侧停靠。 */
export interface PanelPlacement {
  docked: boolean;
  manualPos: boolean;
  left: number | null;
  top: number | null;
  right: number | null;
  bottom: number | null;
}

export function resolvePanelPlacement(options: {
  layout?: PanelLayoutSnapshot | null;
  docked?: boolean | null;
  point?: { x?: number; y?: number };
  viewport?: Viewport | null;
  size?: { width?: number; height?: number } | null;
  dockGap?: number;
} | null): PanelPlacement {
  const opts = options || {};
  const viewport = normalizeViewport(opts.viewport);
  const sizeWidth = Math.max(1, Number(opts.size && opts.size.width) || 0);
  const sizeHeight = Math.max(1, Number(opts.size && opts.size.height) || 0);
  const dockGap = Number.isFinite(Number(opts.dockGap)) ? Number(opts.dockGap) : 0;
  const layout = opts.layout || null;
  const savedDocked = layout && typeof layout.docked === 'boolean' ? layout.docked : null;
  const docked = opts.docked == null ? savedDocked === true : opts.docked === true;

  if (layout && layout.hasPos && isFiniteNumber(layout.left) && isFiniteNumber(layout.top)) {
    return {
      docked,
      manualPos: true,
      left: Math.min(Math.max(0, viewport.width - sizeWidth), Math.max(0, layout.left)),
      top: Math.min(Math.max(0, viewport.height - sizeHeight), Math.max(0, layout.top)),
      right: null,
      bottom: null,
    };
  }
  if (docked) {
    return {
      docked: true,
      manualPos: false,
      left: null,
      top: null,
      right: 0,
      // 底部留白是「大屏上移」的观感，视口太矮时它会把面板顶部顶出屏幕
      // （实测：1200×520 + 480 高面板 ⇒ top=-38）。越界时收窄留白，正常视口不变。
      bottom: Math.min(dockGap, Math.max(0, viewport.height - sizeHeight - 8)),
    };
  }
  const pointX = Number(opts.point && opts.point.x);
  const pointY = Number(opts.point && opts.point.y);
  const x = Number.isFinite(pointX) ? pointX : 0;
  const y = Number.isFinite(pointY) ? pointY : 0;
  return {
    docked: false,
    manualPos: false,
    left: Math.min(Math.max(4, x), Math.max(4, viewport.width - sizeWidth - 4)),
    // 与旧实现一致：点太靠下时按「面板较高」预留，避免顶部被推出视口。
    top: Math.min(
      Math.max(4, y),
      Math.max(4, viewport.height - Math.min(sizeHeight, viewport.height - PANEL_VIEWPORT_INSET) - 4)
    ),
    right: null,
    bottom: null,
  };
}

/** 把矩形夹回可视区（只动 left/top）。窗口变小后重开、或开着时被缩窗口都走这里。 */
export function clampPanelIntoView(rect: { width?: number; height?: number; left?: number; top?: number } | null | undefined, viewport: Viewport | null | undefined): { left: number; top: number } {
  const { width: vw, height: vh } = normalizeViewport(viewport);
  const r = rect || {};
  const width = Math.max(0, Number(r.width) || 0);
  const height = Math.max(0, Number(r.height) || 0);
  const left = Number(r.left);
  const top = Number(r.top);
  return {
    left: Math.min(Math.max(0, vw - width), Math.max(0, Number.isFinite(left) ? left : 0)),
    top: Math.min(Math.max(0, vh - height), Math.max(0, Number.isFinite(top) ? top : 0)),
  };
}

// 面板布局存档协议的纯单元测试（lib/page/panel-layout.ts）。
//
// 为什么要单独测这层：以前「位置没保存」不是某一行的错，而是**三处判据口径不一致** ——
// 关闭时只有 `_manualPos` 才写、打开时只有停靠分支才读、气泡路径完全不读。
// 把口径收敛成「一份带 docked / manualPos 的存档 + 一条摆放规则」之后，
// 这里的每条用例就是那份口径的**定义**；tests/panel-position.test.mjs 只负责证明
// chat.js 真的调用了它。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PANEL_POS_KEY,
  PANEL_SIZE_KEY,
  PANEL_LAYOUT_VERSION,
  PANEL_MIN_WIDTH,
  PANEL_MIN_HEIGHT,
  clampPanelSize,
  clampPanelIntoView,
  readPanelLayout,
  writePanelLayout,
  resolvePanelPlacement,
} from '../lib/page/panel-layout.ts';

function memoryStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
    _json: (k) => JSON.parse(map.get(k)),
  };
}

test('writePanelLayout：手动位置记像素，停靠自动位置记 null（两者都能精确还原）', () => {
  const manual = memoryStorage();
  writePanelLayout(manual, { width: 420, height: 500, left: 300.4, top: 140.6, docked: false, manualPos: true });
  assert.deepEqual(manual._json(PANEL_POS_KEY), { version: PANEL_LAYOUT_VERSION, docked: false, left: 300, top: 141 });
  assert.deepEqual(manual._json(PANEL_SIZE_KEY), { version: PANEL_LAYOUT_VERSION, width: 420, height: 500 });

  const docked = memoryStorage();
  writePanelLayout(docked, { width: 400, height: 480, left: 900, top: 12, docked: true, manualPos: false });
  // 停靠且未拖动：位置交给 CSS（bottom/right），必须记 null 而不是把当时的像素写死。
  assert.deepEqual(docked._json(PANEL_POS_KEY), { version: PANEL_LAYOUT_VERSION, docked: true, left: null, top: null });
});

test('writePanelLayout：writeSize=false 只更新位置，不把自动高度当用户尺寸存下来', () => {
  const s = memoryStorage({ [PANEL_SIZE_KEY]: JSON.stringify({ width: 380, height: 460 }) });
  writePanelLayout(s, { width: 380, height: 999, left: 10, top: 20, docked: false, manualPos: true, writeSize: false });
  assert.deepEqual(s._json(PANEL_SIZE_KEY), { width: 380, height: 460 });
  assert.equal(s._json(PANEL_POS_KEY).left, 10);
});

test('readPanelLayout：容错 —— 坏 JSON / 半截字段只丢那一段，不抛', () => {
  const broken = memoryStorage({ [PANEL_POS_KEY]: '{not json', [PANEL_SIZE_KEY]: '{"width":"x"}' });
  assert.deepEqual(readPanelLayout(broken), { width: null, height: null, left: null, top: null, docked: null, hasPos: false });
  assert.equal(readPanelLayout(null).hasPos, false);

  const partial = memoryStorage({ [PANEL_POS_KEY]: JSON.stringify({ left: 50, top: 60 }) });
  const got = readPanelLayout(partial);
  assert.equal(got.hasPos, true);
  assert.equal(got.docked, null, '旧版存档没有 docked，交给打开路径决定');
});

test('readPanelLayout：读回 writePanelLayout 写的内容（往返一致）', () => {
  const s = memoryStorage();
  writePanelLayout(s, { width: 410, height: 520, left: 120, top: 90, docked: false, manualPos: true });
  assert.deepEqual(readPanelLayout(s), { width: 410, height: 520, left: 120, top: 90, docked: false, hasPos: true });
});

test('resolvePanelPlacement：有存档位置时，所有打开路径都以存档为准', () => {
  const layout = { hasPos: true, left: 300, top: 140, docked: false };
  const viewport = { width: 1200, height: 800 };
  const size = { width: 400, height: 480 };
  // 划词气泡路径（point 在别处、docked 意图为 false）
  const viaBubble = resolvePanelPlacement({ layout, docked: false, point: { x: 640, y: 220 }, viewport, size, dockGap: 160 });
  assert.deepEqual(viaBubble, { docked: false, manualPos: true, left: 300, top: 140, right: null, bottom: null });
  // 快捷键 / FAB 路径（调用方要求停靠）：位置照旧恢复，但**模式听调用方**的
  // （评审退回项：存档里的 docked 不得盖住意图，否则「上次是气泡关的」之后 FAB 再也不停靠）
  const viaShortcut = resolvePanelPlacement({ layout, docked: true, viewport, size, dockGap: 160 });
  assert.deepEqual(viaShortcut, { docked: true, manualPos: true, left: 300, top: 140, right: null, bottom: null });
});

test('resolvePanelPlacement：停靠自动位置按视口底部摆放；自动恢复（restore）沿用存档停靠态', () => {
  const layout = { hasPos: false, docked: true };
  const viewport = { width: 1200, height: 800 };
  const size = { width: 400, height: 480 };
  // 自动恢复路径（SPA 保活重挂 / 跨标签页同步 / run 恢复）没有「用户意图」，沿用存档
  const restored = resolvePanelPlacement({ layout, docked: null, viewport, size, dockGap: 180 });
  assert.deepEqual(restored, { docked: true, manualPos: false, left: null, top: null, right: 0, bottom: 180 });
  // 划词气泡是「用户意图：浮动」，存档里的停靠态不覆盖它
  const viaBubble = resolvePanelPlacement({ layout, docked: false, point: { x: 500, y: 300 }, viewport, size, dockGap: 180 });
  assert.deepEqual(viaBubble, { docked: false, manualPos: false, left: 500, top: 300, right: null, bottom: null });
});

test('resolvePanelPlacement：评审退回项 —— 存档 docked:false 时按快捷键打开仍是停靠，只恢复位置', () => {
  const layout = { hasPos: true, left: 300, top: 140, docked: false };
  const placement = resolvePanelPlacement({
    layout,
    docked: true,
    viewport: { width: 1200, height: 800 },
    size: { width: 400, height: 480 },
    dockGap: 160,
  });
  assert.equal(placement.docked, true, '调用方要停靠就必须停靠');
  assert.equal(placement.left, 300, '位置仍要恢复');
  assert.equal(placement.top, 140);
});

test('resolvePanelPlacement：完全没有存档时按调用方意图（停靠 / 鼠标点）', () => {
  const viewport = { width: 1200, height: 800 };
  const size = { width: 400, height: 480 };
  assert.deepEqual(resolvePanelPlacement({ docked: true, viewport, size, dockGap: 100 }), {
    docked: true, manualPos: false, left: null, top: null, right: 0, bottom: 100,
  });
  assert.deepEqual(resolvePanelPlacement({ docked: false, point: { x: 500, y: 300 }, viewport, size }), {
    docked: false, manualPos: false, left: 500, top: 300, right: null, bottom: null,
  });
});

test('resolvePanelPlacement：视口变小后重开 —— 存档位置被夹回可视区，不会跑到屏幕外', () => {
  const layout = { hasPos: true, left: 1500, top: 900, docked: false };
  const placement = resolvePanelPlacement({
    layout,
    viewport: { width: 1000, height: 600 },
    size: { width: 400, height: 480 },
  });
  assert.equal(placement.left, 600);
  assert.equal(placement.top, 120);
});

test('clampPanelIntoView：开着时缩窗口也被夹回（只动 left/top）', () => {
  assert.deepEqual(clampPanelIntoView({ left: 900, top: 700, width: 400, height: 480 }, { width: 800, height: 600 }), {
    left: 400,
    top: 120,
  });
  assert.deepEqual(clampPanelIntoView({ left: 10, top: 20, width: 400, height: 480 }, { width: 800, height: 600 }), {
    left: 10,
    top: 20,
  });
});

test('resolvePanelPlacement：视口很矮时收窄停靠留白，顶部不能被顶出屏幕', () => {
  const placement = resolvePanelPlacement({
    layout: { hasPos: false, docked: true },
    viewport: { width: 1200, height: 520 },
    size: { width: 400, height: 402 },
    dockGap: 156,
  });
  // 520 - 402 - 8 = 110 < 156 ⇒ 留白收窄到 110，top = 520-110-402 = 8 ≥ 0
  assert.equal(placement.bottom, 110);
  assert.equal(placement.docked, true);
});

test('clampPanelSize：不低于 280×320，也不超过视口减 24', () => {
  const viewport = { width: 1200, height: 800 };
  assert.deepEqual(clampPanelSize({ width: 100, height: 100 }, viewport), { width: PANEL_MIN_WIDTH, height: PANEL_MIN_HEIGHT });
  assert.deepEqual(clampPanelSize({ width: 5000, height: 5000 }, viewport), { width: 1176, height: 776 });
  assert.equal(clampPanelSize({ width: 0, height: 400 }, viewport), null);
  assert.equal(clampPanelSize(null, viewport), null);
});

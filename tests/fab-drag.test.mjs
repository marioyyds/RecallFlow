import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PANEL_CSS } from '../lib/page/panel-css.js';

const chat = fs.readFileSync('lib/page/chat.js', 'utf8');

test('RecallFlow 气泡支持纵向拖动，并保存归一化位置', () => {
  assert.match(chat, /recallflow-fab-position/);
  assert.match(chat, /fab\.addEventListener\('pointerdown'/);
  assert.match(chat, /fab\.addEventListener\('pointermove'/);
  assert.match(chat, /fab\.addEventListener\('pointerup'/);
  assert.match(chat, /clampFabTop\(fabDragState\.origTop \+ dy\)/);
  assert.match(chat, /localStorage\.setItem\(FAB_POSITION_KEY/);
  assert.match(chat, /applySavedFabPosition\(\)/);
  assert.match(chat, /saved\.ratio == null\) return null/, '未保存过位置时必须回到默认 38%，不能被 Number(null)=0 吸到顶部');
});

test('拖动不会误触打开面板，并支持方向键微调', () => {
  assert.match(chat, /fabSuppressClickUntil/);
  assert.match(chat, /e\.key === 'ArrowUp' \? -16 : 16/);
  assert.match(chat, /fab\.classList\.add\('dragging'\)/);
});

test('气泡拖动样式禁止触屏滚动抢占并显示抓取光标', () => {
  const fab = /\.fab\s*\{([^}]*)\}/.exec(PANEL_CSS);
  assert.ok(fab);
  assert.match(fab[1], /cursor:\s*grab/);
  assert.match(fab[1], /touch-action:\s*none/);
  assert.match(PANEL_CSS, /\.fab\.dragging\s*\{[^}]*cursor:\s*grabbing/s);
});

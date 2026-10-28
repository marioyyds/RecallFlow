import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PANEL_CSS } from '../lib/ui/page/panel-css.ts';

const chat = fs.readFileSync('lib/ui/page/chat.ts', 'utf8');

test('RecallFlow 气泡支持纵向拖动，并保存归一化位置', () => {
  // ⚠ 这里只钉**接线**（事件是否还挂着、是否还走夹取与持久化）。
  // 真正的**行为**（夹取边界、比例归一化、旧位置迁移）已搬到
  // tests/fab-position.test.mjs 去**真跑** —— 那段逻辑抽成独立模块后才测得动，
  // 此前只能靠下面这种正则，它改一行格式就红、改坏行为却不红。
  assert.match(chat, /fab\.addEventListener\('pointerdown'/);
  assert.match(chat, /fab\.addEventListener\('pointermove'/);
  assert.match(chat, /fab\.addEventListener\('pointerup'/);
  assert.match(chat, /clampFabTop\(fabDragState\.origTop \+ dy\)/);
  assert.match(chat, /chrome\.storage\.onChanged\.addListener/);
  // 持久化与迁移的实现已随模块搬走，这里改为钉住"聊天面板确实委托给了它"。
  assert.match(chat, /from '\.\/fab-position\.(js|ts)'/, 'chat.js 应委托给 fab-position.js');
  assert.match(chat, /createFabController\(\{/, '应创建带依赖注入的控制器');
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

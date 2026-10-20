// 快捷键的**注册与转发**（manifest ↔ background）用源码断言；
// 内容脚本那一侧（收到 panel:toggle / 按 Alt+Shift+R 之后真的开面板）已改为
// tests/chat-panel-smoke.test.mjs 里的**真 import + 真 DOM** 断言 —— 断言源码里有
// `togglePanelFromShortcut()` 这句话，无法证明它真的被调用过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const background = fs.readFileSync('background.js', 'utf8');

test('扩展注册 Alt+Shift+R 打开/关闭对话面板', () => {
  assert.deepEqual(manifest.commands['toggle-panel'].suggested_key, { default: 'Alt+Shift+R' });
  assert.match(manifest.commands['toggle-panel'].description, /打开或关闭/);
});

test('后台把快捷键转发给当前网页的顶层内容脚本', () => {
  assert.match(background, /chrome\.commands\.onCommand\.addListener/);
  assert.match(background, /command !== 'toggle-panel'/);
  assert.match(background, /chrome\.tabs\.query\(\{ active: true, currentWindow: true \}/);
  assert.match(background, /\{ type: 'panel:toggle' \}/);
  assert.match(background, /\{ frameId: 0 \}/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const background = fs.readFileSync('background.js', 'utf8');
const chat = fs.readFileSync('lib/page/chat.js', 'utf8');

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

test('内容脚本收到 panel:toggle 后调用面板开关，并在气泡提示中展示快捷键', () => {
  assert.match(chat, /msg\.type === 'panel:toggle'[\s\S]{0,80}togglePanelFromShortcut\(\)/);
  assert.match(chat, /e\.altKey && e\.shiftKey && e\.code === 'KeyR'/);
  assert.match(chat, /lastShortcutToggleAt/);
  assert.match(chat, /Alt\+Shift\+R 打开\/关闭/);
});

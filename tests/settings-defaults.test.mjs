import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { AI_SETTINGS_DEFAULTS } from '../lib/shared/settings.ts';

test('默认模型是 deepseek-flash', () => {
  assert.equal(AI_SETTINGS_DEFAULTS.model, 'deepseek-flash');
});

test('设置页的模型输入与候选列表包含 deepseek-flash', () => {
  const html = fs.readFileSync('options.html', 'utf8');
  assert.match(html, /placeholder="deepseek-flash"/);
  assert.match(html, /<option value="deepseek-flash">/);
});

test('设置页说明 run_javascript 已归入页面命令审批', () => {
  const html = fs.readFileSync('options.html', 'utf8');
  assert.match(html, /run_javascript 已归入「执行页面命令」/);
  assert.match(html, /用户脚本 \/ 技能写入审批/);
});

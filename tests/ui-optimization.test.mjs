// UI 优化的源码级回归门禁。
//
// 这些约束单独看都只是几行 CSS / 事件处理，但一旦被改回去，症状通常是
// “某些输入法用户会误发送”“关弹窗把面板一起关掉”“设置改完没提示”——
// 单元测试很难自然覆盖，因此把关键接线固定下来。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PANEL_CSS } from '../lib/page/panel-css.js';

const chat = fs.readFileSync('lib/page/chat.js', 'utf8');
const optionsHtml = fs.readFileSync('options.html', 'utf8');
const optionsCss = fs.readFileSync('options.css', 'utf8');
const skills = fs.readFileSync('skills-page.js', 'utf8');
const skillsHtml = fs.readFileSync('skills.html', 'utf8');
const popup = fs.readFileSync('popup.js', 'utf8');
const background = fs.readFileSync('background.js', 'utf8');
const managerHtml = fs.readFileSync('manager.html', 'utf8');

test('对话输入框：输入法组词阶段的 Enter 不得发送消息', () => {
  assert.match(chat, /e\.isComposing \|\| e\.keyCode === 229/, '缺少 IME 组词保护');
});

test('快捷语句常驻且横向滚动，不被隐藏或改成空状态专用', () => {
  const block = /\.quick-prompts\s*\{([^}]*)\}/.exec(PANEL_CSS);
  assert.ok(block, '缺少 .quick-prompts 样式');
  assert.match(block[1], /flex-wrap:\s*nowrap/, '快捷语句应保持单行常驻');
  assert.match(block[1], /overflow-x:\s*auto/, '快捷语句应在空间不足时横向滚动');
  assert.ok(!/quickWrap\.style\.display\s*=\s*'none'/.test(chat), '快捷语句不应按状态隐藏');
});

test('面板弹窗：Esc 只关闭最上层，并有焦点陷阱与焦点恢复', () => {
  const dialog = chat.slice(chat.indexOf('function showPanelDialog'), chat.indexOf('async function switchPanelSession'));
  assert.match(dialog, /aria-labelledby/, '弹窗缺少可访问名称');
  assert.match(dialog, /onDialogKey/, '弹窗缺少键盘处理');
  assert.match(dialog, /e\.key === 'Escape'/, '弹窗应处理 Escape');
  assert.match(dialog, /document\.activeElement/, '弹窗应处理 Tab 焦点循环');
  assert.match(dialog, /previousFocus\.focus/, '关闭后应恢复焦点');
  assert.match(chat, /if \(panel && panel\.querySelector\('\.session-dialog-backdrop'\)\) return;/, '面板级 Esc 应先让位给弹窗');
  assert.match(chat, /if \(panel\) return;\s*\n\s*\}\s*\n\s*\}, true\);/, '初始化阶段的 Esc 监听不得抢在面板级处理器前关闭面板');
});

test('设置页：保留保存按钮逻辑，同时提供 sticky 保存栏、脏状态和 Ctrl/Cmd+S', () => {
  assert.match(optionsHtml, /id="save-state"/);
  assert.match(optionsCss, /\.actions\s*\{[^}]*position:\s*sticky/s);
  assert.match(optionsCss, /\.save-state\.dirty/);
  assert.match(fs.readFileSync('options.js', 'utf8'), /ctrlKey \|\| e\.metaKey/);
  assert.ok(!/\*\*只有 deepseek-reasoner/.test(optionsHtml), '设置说明不应把 Markdown 星号原样显示');
});

test('设置页：新增页面内导航，但不移动权限设置逻辑', () => {
  assert.match(optionsHtml, /class="settings-sidebar"/);
  assert.match(optionsHtml, /id="settings-behavior"/);
  assert.match(optionsHtml, /id="approval-preset"/, '权限设置必须保留');
});

test('技能页：有搜索、来源/分类筛选，卡片正文按需展开', () => {
  assert.match(skillsHtml, /id="skill-search"/);
  assert.match(skillsHtml, /id="skill-kind-filters"/);
  assert.match(skillsHtml, /id="skill-category-filter"/);
  assert.match(skills, /function filteredSkills\(\)/);
  assert.match(skills, /<details class="skill-details">/);
  assert.match(skills, /function openOverlay\(/, '技能弹窗应统一焦点管理');
  assert.match(skills, /e\.key === 'Escape'/, '技能弹窗应支持 Escape');
});

test('Popup：助手入口使用显式网页 tabId，避免 popup 关闭时删掉面板成员', () => {
  assert.match(popup, /panel:open-active/);
  assert.match(background, /msg\.type === 'panel:open-active'/);
  assert.match(background, /const requestedTabId = Number\(msg\.tabId\)/);
  assert.match(background, /broadcastPanelUi\(result\.ui, null\)/);
});

test('知识库：高级筛选默认收起，不抢占首屏内容', () => {
  assert.match(managerHtml, /<details class="advanced-filters"/);
  assert.ok(!/<details class="advanced-filters"[^>]*\sopen/.test(managerHtml), '高级筛选应默认收起');
});

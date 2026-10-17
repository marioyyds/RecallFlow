import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_SETTINGS_DEFAULTS,
  SESSION_TO_KB_QUICK_PROMPT,
  SESSION_TO_KB_INSTRUCTION,
  mergeQuickPrompts,
  expandQuickPrompt,
} from '../lib/shared/settings.js';

test('默认快捷语句顺序符合产品配置', () => {
  assert.deepEqual(AI_SETTINGS_DEFAULTS.quickPrompts, [
    SESSION_TO_KB_QUICK_PROMPT,
    '划出页面关键信息',
    '检索一些好用的技能',
    '分析这个网页/项目',
  ]);
});

test('旧默认快捷语句升级后直接切换为新默认列表', () => {
  const oldDefaults = [
    '整理会话到知识库',
    '提炼关键要点',
    '解释这段内容',
    '划出页面关键信息',
    '检索一些好用的技能',
  ];
  assert.deepEqual(mergeQuickPrompts(oldDefaults), AI_SETTINGS_DEFAULTS.quickPrompts);
});

test('已有用户即使在 12 条满额时也会补上新增默认项', () => {
  const custom = Array.from({ length: 12 }, (_, i) => '自定义 ' + (i + 1));
  const merged = mergeQuickPrompts(custom);
  assert.equal(merged.length, 12);
  assert.equal(merged[0], SESSION_TO_KB_QUICK_PROMPT);
});

test('快捷标签发送时展开为完整 Markdown 文档规范', () => {
  const out = expandQuickPrompt(SESSION_TO_KB_QUICK_PROMPT);
  assert.equal(out, SESSION_TO_KB_INSTRUCTION);
  assert.match(out, /Markdown/);
  assert.match(out, /# 会话整理/);
  assert.match(out, /## 关键结论/);
  assert.match(out, /add_entry/);
  assert.match(out, /knowledge_read/);
  assert.match(out, /不要.*聊天记录逐句照抄/s);
});

test('普通快捷语句不被改写', () => {
  assert.equal(expandQuickPrompt('提炼关键要点'), '提炼关键要点');
  assert.equal(expandQuickPrompt(''), '');
});

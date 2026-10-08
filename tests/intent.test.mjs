import test from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, extractKeyword, INTENTS, buildSystemPrompt } from '../lib/assistant/intent-router.js';

test('detects browser intent', () => {
  assert.equal(detectIntent('打开百度搜索今天的热搜').intent, INTENTS.BROWSER);
});

test('detects knowledge intent', () => {
  assert.equal(detectIntent('我的收藏里有没有 nginx 的笔记').intent, INTENTS.KNOWLEDGE);
});

test('continuation inherits previous user intent', () => {
  const d = detectIntent('继续', [{ role: 'user', content: '打开百度搜索热搜' }]);
  assert.equal(d.intent, INTENTS.BROWSER);
});

test('extractKeyword strips leading verbs', () => {
  const k = extractKeyword('打开百度搜索今天的热搜');
  assert.ok(!k.startsWith('打开'));
});

// 实测会话里 agent 为了把一句话带进视口，对一个正文段落调用了 click_element ——
// 点击是对用户页面的真实副作用，而项目本就有 scroll_page。这条规则把它钉住。
test('系统提示明确禁止用 click_element 代替滚动', () => {
  const p = buildSystemPrompt(INTENTS.BROWSER, '把某段话滚进视口', ['scroll_page', 'click_element', 'run_javascript'], []);
  assert.match(p, /不要用 click_element 代替滚动/);
  assert.match(p, /scroll_page/);
});

test('系统提示说明滚动无效时该查内部滚动容器', () => {
  const p = buildSystemPrompt(INTENTS.BROWSER, '滚动页面', ['scroll_page', 'run_javascript'], []);
  assert.match(p, /位置未变化/, '要说明 scroll_page 报「位置未变化」意味着什么');
  assert.match(p, /scrollTop/, '要给出内部容器 scrollTop 的做法');
});

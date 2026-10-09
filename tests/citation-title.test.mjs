// 参考来源的标题：无标题页面**不能拿正文开头冒充标题**。
//
// 实测（会话 RF-EGPWWF，导出的「参考来源」区）：
//
//   - [5] <p align="center"> <img src="./docs/asse — https://raw.githubusercontent.com/…/README.md
//
// 根因是 `tools.js` 里那句 `title: (pageResponse.title || 正文前 40 字)`：
// `raw.githubusercontent.com` 返回 text/plain，没有 `<title>`，于是「标题」成了
// Markdown 原文的第一行截断。那既不是标题也不是摘要 —— 用户看不出这条来源是什么。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { citationTitleFor } from '../lib/assistant/tools.js';

const RAW = 'https://raw.githubusercontent.com/marioyyds/RecallFlow/master/README.md';

test('无标题页面：回落到 URL 尾段，而不是正文', () => {
  assert.equal(citationTitleFor('', RAW), 'README.md');
  assert.equal(citationTitleFor(undefined, RAW), 'README.md');
  assert.equal(citationTitleFor('   ', RAW), 'README.md');
});

test('回归：那次的正文形态绝不能出现在标题里', () => {
  // 正文首行就是这段 HTML，旧实现截 40 字当标题。
  const body = '<p align="center"> <img src="./docs/assets/recallflow-github-logo.svg" alt="RecallFlow logo" width="480">';
  const title = citationTitleFor('', RAW);
  assert.ok(!title.includes('<p'), title);
  assert.ok(!title.includes('align='), title);
  assert.ok(!title.includes(body.slice(0, 12)), '标题不该是正文片段：' + title);
});

test('有标题时用标题（不能被回落逻辑顶掉）', () => {
  assert.equal(citationTitleFor('RecallFlow README', RAW), 'RecallFlow README');
  assert.equal(citationTitleFor('  CSDN_专业开发者社区  ', 'https://www.csdn.net/'), 'CSDN_专业开发者社区');
});

test('标题里的标记要被剥掉（页面标题也可能是脏的）', () => {
  assert.ok(!citationTitleFor('<b>粗体标题</b>', RAW).includes('<b'));
});

test('URL 尾段回落的边界', () => {
  assert.equal(citationTitleFor('', 'https://www.csdn.net/'), 'www.csdn.net', '只有域名时用域名');
  assert.equal(citationTitleFor('', 'https://example.com/a/b/c.html'), 'c.html', '取最后一段路径');
  assert.equal(citationTitleFor('', ''), '（无标题页面）', '连 URL 都没有才用占位');
  assert.equal(citationTitleFor('', 'not a url'), 'not a url', '解析不了就原样用');
});

// ---------------------------------------------------------------- 接线

test('接线：引用标题必须走 citationTitleFor，不得再回落到正文', () => {
  const src = fs.readFileSync('lib/assistant/tools.js', 'utf8');
  assert.ok(/title: citationTitleFor\(pageResponse\.title, urlForTitle\)/.test(src), '应统一走纯函数');
  assert.ok(
    !/title: \(pageResponse\.title \|\| c\.replace/.test(src),
    '旧的「标题回落到正文前 40 字」应已消失 —— 那正是参考来源不可读的原因'
  );
});

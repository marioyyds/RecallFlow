// 知识库 Markdown 文档视图的接线门禁。
//
// 判据重点不是「有没有一个渲染函数」，而是四件事同时成立：
//   ① 管理器复用现有的安全 Markdown 渲染器（不另写一套 HTML 拼接）；
//   ② 文档正文通过该渲染器写入阅读视图；
//   ③ note 编辑是多行 textarea，且 Ctrl/Cmd+Enter 才保存；
//   ④ Popup 的快速收录也能写多行 Markdown。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const managerHtml = fs.readFileSync('manager.html', 'utf8');
const managerJs = fs.readFileSync('entries/manager.ts', 'utf8');
const managerCss = fs.readFileSync('manager.css', 'utf8');
const popupHtml = fs.readFileSync('popup.html', 'utf8');
const popupJs = fs.readFileSync('entries/popup.ts', 'utf8');

test('知识库复用安全 Markdown 渲染器', () => {
  // 迁移期：specifier 可能是 `.js` 或 `.ts`，两种都认（同模块改名后 import 侧跟着改）。
  assert.match(managerJs, /import \{ renderMarkdown \} from '\.\.\/lib\/ui\/page\/markdown\.(?:js|ts)'/);
  assert.match(managerJs, /renderMarkdown\(String\(item\.note\), null, false\)/);
});

test('知识库有可关闭、可编辑的文档阅读视图', () => {
  assert.match(managerHtml, /id="doc-overlay"/);
  assert.match(managerHtml, /id="doc-content"/);
  assert.match(managerHtml, /id="doc-edit"/);
  assert.match(managerJs, /function openDocument\(/);
  assert.match(managerJs, /function closeDocument\(/);
  assert.match(managerJs, /e\.key === 'Escape'/);
  assert.match(managerJs, /data-act="read"/);
});

test('知识库正文编辑是多行 Markdown textarea，不会被 Enter 提前保存', () => {
  assert.match(managerJs, /<textarea id="note-editor" class="note-editor doc-editor"/);
  // TITA-86：TS 迁移后 e.target 不再是 any，必须先窄化成 Element 才能读 tagName ——
  // 断言跟着锚到**新的等价形态**（同一处判断、同样的两个条件），不是放宽成「出现过 TEXTAREA」。
  assert.match(managerJs, /\(e\.target as Element\)\.tagName === 'TEXTAREA' && !\(e\.ctrlKey \|\| e\.metaKey\)/);
  assert.match(managerCss, /\.markdown-body\s*\{[^}]*overflow:\s*auto/s);
  assert.match(managerCss, /\.markdown-body h1/);
});

test('Popup 快速收录支持多行 Markdown，Enter 换行、Ctrl/Cmd+Enter 保存', () => {
  assert.match(popupHtml, /<textarea id="note-input"[^>]*rows="3"/s);
  assert.match(popupJs, /id === 'note-input' && !\(e\.ctrlKey \|\| e\.metaKey\)/);
});

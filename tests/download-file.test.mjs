import test from 'node:test';
import assert from 'node:assert/strict';

import { markdownDownloadFilename } from '../lib/ui/page/download-file.ts';

test('markdownDownloadFilename: 使用会话标题并清理跨平台非法字符', () => {
  assert.equal(
    markdownDownloadFilename('  A/B: C*D? E"F<G>H|I\\J  '),
    'A-B- C-D- E-F-G-H-I-J.md'
  );
  assert.equal(markdownDownloadFilename('标题.'), '标题.md');
});

test('markdownDownloadFilename: 空标题有兜底，Windows 保留名不会被直接使用', () => {
  assert.equal(markdownDownloadFilename('   '), 'RecallFlow 会话.md');
  assert.equal(markdownDownloadFilename('CON'), '_CON.md');
  assert.equal(markdownDownloadFilename('lpt1.txt'), '_lpt1.txt.md');
});

test('markdownDownloadFilename: 长标题按 code point 截断且不切裂 emoji', () => {
  const filename = markdownDownloadFilename('😀'.repeat(100));
  assert.equal(Array.from(filename).length, 83);
  assert.ok(filename.endsWith('😀.md'));
});

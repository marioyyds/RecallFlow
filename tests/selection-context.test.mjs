import test from 'node:test';
import assert from 'node:assert/strict';

import { selectedTextMessageHtml } from '../lib/shared/utils.js';
import {
  serializeConversationMessages,
  MAX_SELECTED_TEXT_CHARS,
} from '../lib/page/transcript.js';

test('选文 HTML 转义页面内容，空文本不生成节点', () => {
  assert.equal(selectedTextMessageHtml(''), '');
  assert.equal(selectedTextMessageHtml(null), '');
  const html = selectedTextMessageHtml('<img src=x onerror="alert(1)">');
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /class="user-selection"/);
  assert.match(html, /页面引用/);
});

test('导出白名单保留 selectedText，并对超长选文留痕', () => {
  const long = '字'.repeat(MAX_SELECTED_TEXT_CHARS + 5);
  const [record] = serializeConversationMessages([{ role: 'user', content: '解释', selectedText: long }]);
  assert.equal(record.selectedText.length, MAX_SELECTED_TEXT_CHARS);
  assert.equal(record.selectedTextTotal, long.length);
  assert.equal(record.selectedTextTruncated, true);
});

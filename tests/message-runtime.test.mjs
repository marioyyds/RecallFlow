import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatElapsedDuration,
  msgActionsHtml,
} from '../lib/ui/panel/conversation-format.ts';
import { serializeConversationMessages } from '../lib/ui/page/transcript.ts';

test('助手耗时格式紧凑且可读', () => {
  assert.equal(formatElapsedDuration(0), '0s');
  assert.equal(formatElapsedDuration(9_250), '9.3s');
  assert.equal(formatElapsedDuration(12_400), '12s');
  assert.equal(formatElapsedDuration(65_000), '1m05s');
  assert.equal(formatElapsedDuration(-1), '');
  assert.equal(formatElapsedDuration('bad'), '');
});

test('耗时信息位于复制与重新生成按钮下方', () => {
  const html = msgActionsHtml(true, 12_400, 65_000);
  const copy = html.indexOf('⧉ 复制');
  const regen = html.indexOf('⟳ 重新生成');
  const runtime = html.indexOf('msg-runtime');
  assert.ok(copy > -1);
  assert.ok(regen > copy);
  assert.ok(runtime > regen);
  assert.match(html, /本次用时 12s/);
  assert.match(html, /会话累计 1m05s/);
});

test('非最后一条不显示重新生成，但不丢耗时', () => {
  const html = msgActionsHtml(false, 2_000, 9_000);
  assert.doesNotMatch(html, /重新生成/);
  assert.match(html, /本次用时 2s · 会话累计 9s/);
});

test('会话持久化白名单保留每轮耗时', () => {
  const [message] = serializeConversationMessages([
    { role: 'assistant', content: '回答', elapsedMs: 12_345 },
  ]);
  assert.equal(message.elapsedMs, 12_345);
});

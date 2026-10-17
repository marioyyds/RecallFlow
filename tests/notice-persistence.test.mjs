// 跨标签页/重开面板时，完成前校验等“过程提示”不能只活在发起页 DOM 里。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { serializeConversationMessages } from '../lib/page/transcript.js';

const CHAT = fs.readFileSync(new URL('../lib/page/chat.js', import.meta.url), 'utf8');

test('verify 步骤必须同时显示并写入 assistant parts', () => {
  assert.match(
    CHAT,
    /function appendNoticePart\([\s\S]{0,700}?pendingParts\.push\(\{ type: 'notice'/,
    '过程提示必须进入 pendingParts，否则落盘后消失'
  );
  const at = CHAT.indexOf("resp.type === 'verify'");
  assert.ok(at > 0);
  const block = CHAT.slice(at, at + 1600);
  assert.match(block, /appendNoticePart\(/, 'verify 分支必须走统一的显示+入库入口');
});

test('notice part 会随会话序列化保留，重开/跟随最终态仍可重建', () => {
  const [rec] = serializeConversationMessages([
    {
      role: 'assistant',
      content: '',
      parts: [{ type: 'notice', text: '✓ 完成前校验通过：证据一致', color: '#16a34a' }],
    },
  ]);
  assert.equal(rec.parts[0].type, 'notice');
  assert.equal(rec.parts[0].text, '✓ 完成前校验通过：证据一致');
});

test('跟随 live 消息必须尊重 showCitations，运行中不提前渲染来源区', () => {
  assert.match(
    CHAT,
    /const sourceHtml = !m\.live \|\| m\.showCitations \? citeSourcesHtml\(m\.citations\) : ''/,
    'live 运行中必须跳过 citeSourcesHtml，与发起页的收尾时机一致'
  );
});

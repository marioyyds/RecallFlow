// 跨标签页/重开面板时，完成前校验等“过程提示”不能只活在发起页 DOM 里。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { serializeConversationMessages } from '../lib/page/transcript.ts';

const CHAT = fs.readFileSync(new URL('../lib/page/chat.js', import.meta.url), 'utf8');

test('verify 通过提示延迟到最终回答之后，失败提示仍立即持久化', () => {
  assert.match(
    CHAT,
    /function appendNoticePart\([\s\S]{0,700}?pendingParts\.push\(\{ type: 'notice'/,
    '过程提示必须进入 pendingParts，否则落盘后消失'
  );
  const at = CHAT.indexOf("resp.type === 'verify'");
  assert.ok(at > 0);
  const block = CHAT.slice(at, at + 1600);
  assert.match(block, /pendingVerifyPass = \{ type: 'notice'/, '校验通过提示应先暂存，不能立刻插进工具时间线');
  assert.match(block, /terminal: true/, '校验通过提示必须标记为收尾提示');
  assert.match(block, /appendNoticePart\(text, '#b45309'\)/, '未通过/未知结果仍应立即显示');
});

test('收尾校验提示渲染在正文与参考来源之后', () => {
  assert.match(CHAT, /const terminalNotices = parts\.filter\(/, '重开面板时要识别收尾提示');
  assert.match(CHAT, /sourceHtml \+\s*terminalHtml/s, '收尾提示应排在参考来源之后');
  assert.match(CHAT, /textContent = pendingVerifyPass\.text/, '发起页结束时应把校验通过提示放到消息末尾');
});

test('notice part 会随会话序列化保留，重开/跟随最终态仍可重建', () => {
  const [rec] = serializeConversationMessages([
    {
      role: 'assistant',
      content: '',
      parts: [{ type: 'notice', text: '✓ 完成前校验通过：证据一致', color: '#16a34a', terminal: true }],
    },
  ]);
  assert.equal(rec.parts[0].type, 'notice');
  assert.equal(rec.parts[0].text, '✓ 完成前校验通过：证据一致');
  assert.equal(rec.parts[0].terminal, true);
});

test('跟随 live 消息必须尊重 showCitations，运行中不提前渲染来源区', () => {
  assert.match(
    CHAT,
    /const sourceHtml = !m\.live \|\| m\.showCitations \? citeSourcesHtml\(m\.citations\) : ''/,
    'live 运行中必须跳过 citeSourcesHtml，与发起页的收尾时机一致'
  );
});

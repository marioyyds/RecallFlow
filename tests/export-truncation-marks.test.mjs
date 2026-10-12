// 导出/持久化序列化的**每一处截断都必须留痕**（本仓库硬纪律：丢东西必须说明）。
//
// 起因（② 会话容量收口）：`serializeConversationMessages` 里曾有 **5 处静默截断** ——
// 消息条数（`slice(-20)`）、`toolSummary`、`pickedElements`、`citations`、引用 snippet。
// 其中**消息条数**那处最危险：下游（交接包的 `trailTotal`、导出记录）都在**这 20 条之内**统计，
// 静默丢消息会让"会话真实步数"看起来像整个会话，其实只是最近一段 ✗
import test from 'node:test';
import assert from 'node:assert/strict';

import { serializeConversationMessages } from '../lib/page/transcript.js';

test('导出序列化：消息条数被截断时**必须留痕**（否则下游计数看起来像整个会话）', () => {
  const conv = [];
  for (let i = 0; i < 25; i++) conv.push({ role: 'user', content: 'm' + i });
  const out = serializeConversationMessages(conv);
  assert.equal(out.length, 20, '一次导出最多 20 条');
  assert.equal(out[0].earlierMessagesOmitted, 5, '第一条上必须写明"更早的 5 条没被导出"');
  assert.equal(out[0].messagesTotal, 25, '并给出真实总条数');
  assert.equal(out[0].content, 'm5', '保留的是**最近** 20 条（从 m5 开始）');
  assert.equal(out[1].earlierMessagesOmitted, undefined, '痕迹只挂在第一条上，不重复');
  // 不超上限时**不该**多出字段（免得每次都塞一句废话）
  const short = serializeConversationMessages([{ role: 'user', content: 'x' }]);
  assert.equal(short[0].earlierMessagesOmitted, undefined);
  assert.equal(short[0].messagesTotal, undefined);
});

test('导出序列化：toolSummary / pickedElements / citations / snippet 被裁都要留痕', () => {
  const longSummary = 'S'.repeat(900);
  const picks = [];
  for (let i = 0; i < 10; i++) picks.push({ tag: 'button', label: 'b' + i, selector: '#b' + i });
  const cites = [];
  for (let i = 0; i < 25; i++) {
    cites.push({ index: i, source: 'web', id: 'c' + i, title: 't' + i, url: 'https://x/' + i, snippet: 'p'.repeat(400) });
  }
  const [rec] = serializeConversationMessages([
    { role: 'assistant', content: 'ok', toolSummary: longSummary, pickedElements: picks, citations: cites },
  ]);
  assert.equal(rec.toolSummary.length, 600, 'toolSummary 仍按 600 裁');
  assert.equal(rec.toolSummaryTruncated, true, '被裁就必须留痕');
  assert.equal(rec.pickedElements.length, 8, '拾取元素仍按 8 裁');
  assert.equal(rec.pickedElementsTotal, 10, '要给出真实条数');
  assert.equal(rec.pickedElementsOmitted, 2, '并给出丢了几条');
  assert.equal(rec.citations.length, 20, '引用仍按 20 裁');
  assert.equal(rec.citationsTotal, 25, '要给出真实条数');
  assert.equal(rec.citationsOmitted, 5, '并给出丢了几条');
  assert.equal(rec.citations[0].snippet.length, 300, 'snippet 仍按 300 裁');
  assert.equal(rec.citations[0].snippetTruncated, true, 'snippet 被裁也要留痕');
  // 未超限时不留废话字段
  const [clean] = serializeConversationMessages([
    { role: 'assistant', content: 'ok', toolSummary: 'short', pickedElements: [{ tag: 'a' }], citations: [{ index: 0, snippet: 's' }] },
  ]);
  assert.equal(clean.toolSummaryTruncated, undefined);
  assert.equal(clean.pickedElementsOmitted, undefined);
  assert.equal(clean.citationsOmitted, undefined);
  assert.equal(clean.citations[0].snippetTruncated, undefined);
});

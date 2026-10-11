// 历史归一化：**数组形态的 content 不许被静默丢弃**。
//
// ## 起因（真缺陷，位置：context.js 的 normalizeHistory）
//
// 旧实现只有一句 `if (typeof h.content !== 'string' || !h.content.trim()) continue;` ✗
// 于是一条 `content` 为**数组**的消息（多模态：文本部件 + 图片部件）会**整轮消失**：
// 模型看到的只是"历史里没有这一轮"，**完全无从察觉** ✗
//
// 这与本仓库反复强调的纪律相悖：**丢东西必须说明** ✓
// （同一条纪律在别处已经落地：handoff 的 `trailOmitted`、快照的 `omittedBySize`、
//   对话持久化的 `partsOmitted` —— 只有这里还留着无声丢弃 ✗）
import test from 'node:test';
import assert from 'node:assert/strict';

import { flattenHistoryContent, normalizeHistory } from '../lib/assistant/context.js';

test('字符串原样通过', () => {
  assert.equal(flattenHistoryContent('你好'), '你好');
});

test('文本部件被保留（不许整条丢掉）', () => {
  const c = [{ type: 'text', text: '帮我看看这张图' }];
  assert.equal(flattenHistoryContent(c), '帮我看看这张图');
});

test('图片部件 → 占位 + **如实说明图片没传给模型**', () => {
  const c = [
    { type: 'text', text: '这个按钮在哪？' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
  ];
  const out = flattenHistoryContent(c);
  assert.ok(out.includes('这个按钮在哪？'), '文本部分必须留着');
  assert.match(out, /该消息含 1 张图片/, '要说明有几张图');
  assert.match(out, /未把图片传给模型/, '要如实说明图片没被传下去（不许假装看到了）');
  assert.ok(!out.includes('base64'), '不许把图片数据塞进文本里（那会白烧 token）');
});

test('只有图片、没有文本时也不返回空（否则这条又会被当空内容丢掉）', () => {
  const out = flattenHistoryContent([{ type: 'image_url', image_url: { url: 'x' } }]);
  assert.ok(out.trim().length > 0, '必须有可读内容');
  assert.match(out, /1 张图片/);
});

test('未知部件留可辨认占位，而不是丢弃整条', () => {
  const out = flattenHistoryContent([{ type: 'input_audio', audio: {} }, { type: 'text', text: 'hi' }]);
  assert.ok(out.includes('hi'));
  assert.ok(out.includes('input_audio'), '未知部件要留痕');
});

test('**端到端**：数组 content 的消息必须出现在 normalizeHistory 的结果里', () => {
  const history = [
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: [{ type: 'text', text: '我看了截图' }, { type: 'image_url', image_url: { url: 'x' } }] },
    { role: 'user', content: '继续' },
  ];
  const out = normalizeHistory(history, { maxMessages: 10, maxChars: 3000, maxTokens: 8000 });
  // 返回形状兼容两种：当前实现返回**数组**；写成兼容形式，免得因形状变化而误红
  const msgs = Array.isArray(out) ? out : (out && out.messages) || [];
  const texts = msgs.map((m) => String(m.content));
  assert.ok(texts.some((t) => t.includes('我看了截图')), '数组 content 那轮不许消失 ✗');
  assert.ok(texts.some((t) => t.includes('未把图片传给模型')), '并且要带上如实说明');
  assert.equal(msgs.length, 3, '三条都应在');
});

test('牙齿：旧的"非字符串就跳过"实现会漏掉那一轮（说明本门禁真的在盯它）', () => {
  const legacy = (h) => typeof h.content === 'string' && h.content.trim();
  const arrMsg = { role: 'assistant', content: [{ type: 'text', text: '我看了截图' }] };
  assert.ok(!legacy(arrMsg), '旧实现确实会跳过 —— 这就是被修掉的缺陷');
  assert.ok(flattenHistoryContent(arrMsg.content).includes('我看了截图'), '新实现会保留');
});

test('多种空/脏输入不抛异常，且不产生"看起来有内容"的假象', () => {
  for (const bad of [null, undefined, '', [], { a: 1 }, [null, undefined]]) {
    const out = flattenHistoryContent(bad);
    assert.equal(typeof out, 'string');
  }
  assert.equal(flattenHistoryContent('').trim(), '');
  assert.equal(flattenHistoryContent([]).trim(), '');
});

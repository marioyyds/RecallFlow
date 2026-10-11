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
//
// ## 第 6 步（打开视觉开关）之后：那句"如实说明"必须**两臂都在**
//
// 开关打开后，"当前**未把图片传给模型**"就与事实相反了 ✗（追加的 user 消息里确实带着图）。
// 所以那句话现在是**整句二选一**：
//   · 关闭侧 = 改动前原文（逐字节相同 ⇒ 纯重构）；
//   · 开启侧 = 说清"历史回放**不重传**图（只留占位）、只有**本次新增**的截图才进上下文"。
// ⚠ 这里**不写死某一臂**：两臂都用显式 override 钉住，另外再断言"默认（生产）走的是
// `VISION_ENABLED` 实际取值那一臂" —— 这样无论常量是 true 还是 false，两条断言都有效 ✓
import test from 'node:test';
import assert from 'node:assert/strict';

import { flattenHistoryContent, normalizeHistory } from '../lib/assistant/context.js';
import { VISION_ENABLED } from '../lib/shared/utils.js';

// 两臂各自的**原文**（改动前 vs 开启后），写在用例里当基准。
const OFF_NOTE = '（该消息含 1 张图片；当前**未把图片传给模型**，仅保留此文字说明。）';
const ON_NOTE =
  '（该消息含 1 张图片；历史回放**不会重传**这些图片，此处只保留文字占位 —— ' +
  '只有**本次新增**的截图才会随请求送进你的上下文。）';
const withImage = (text) => [
  { type: 'text', text },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
];

test('字符串原样通过', () => {
  assert.equal(flattenHistoryContent('你好'), '你好');
});

test('文本部件被保留（不许整条丢掉）', () => {
  const c = [{ type: 'text', text: '帮我看看这张图' }];
  assert.equal(flattenHistoryContent(c), '帮我看看这张图');
});

test('图片部件 → 占位 + **如实说明**：两臂文案各自钉住，且默认按开关实际值选臂', () => {
  const c = withImage('这个按钮在哪？');

  // ---- 关闭臂（显式 override，不依赖常量当前值）----
  const off = flattenHistoryContent(c, false);
  assert.ok(off.includes('这个按钮在哪？'), '文本部分必须留着');
  assert.match(off, /该消息含 1 张图片/, '要说明有几张图');
  assert.ok(off.includes(OFF_NOTE), '关闭侧必须仍是**改动前那句原文**（逐字节）');
  assert.ok(!off.includes('base64'), '不许把图片数据塞进文本里（那会白烧 token）');

  // ---- 开启臂（显式 override）----
  const on = flattenHistoryContent(c, true);
  assert.ok(on.includes('这个按钮在哪？'), '文本部分必须留着');
  assert.match(on, /该消息含 1 张图片/, '要说明有几张图');
  assert.ok(on.includes(ON_NOTE), '开启侧必须说清"历史不重传、只有新增的才进上下文"');
  assert.ok(!on.includes('未把图片传给模型'), '开启后不得再说"图片没传给模型"（与事实相反 ✗）');
  assert.ok(!on.includes('base64'), '开启侧同样不许塞 base64');
  // 开启侧**不能**笼统说"图片已传给模型"：这些历史图恰恰没传
  assert.match(on, /不会重传/, '必须点明历史图**不重传**，而不是笼统说"图片已传给模型"');

  // 反自检：两臂必须真的不同（否则 override 是摆设，这条门禁会恒真 ✗）
  assert.notEqual(off, on, '两臂相同 ⇒ override 没生效');

  // 默认（生产不传 override）必须走 `VISION_ENABLED` 的**实际取值**那一臂
  const dflt = flattenHistoryContent(c);
  assert.equal(dflt, VISION_ENABLED ? on : off, '默认必须按开关实际值选臂');
});

test('只有图片、没有文本时也不返回空（否则这条又会被当空内容丢掉）', () => {
  const only = [{ type: 'image_url', image_url: { url: 'x' } }];
  for (const enabled of [false, true]) {
    const out = flattenHistoryContent(only, enabled);
    assert.ok(out.trim().length > 0, '必须有可读内容（enabled=' + enabled + '）');
    assert.match(out, /1 张图片/);
  }
  // 默认臂同样按常量取值
  assert.equal(flattenHistoryContent(only), VISION_ENABLED ? ON_NOTE : OFF_NOTE);
});

test('未知部件留可辨认占位，而不是丢弃整条', () => {
  const out = flattenHistoryContent([{ type: 'input_audio', audio: {} }, { type: 'text', text: 'hi' }]);
  assert.ok(out.includes('hi'));
  assert.ok(out.includes('input_audio'), '未知部件要留痕');
});

test('**端到端**：数组 content 的消息必须出现在 normalizeHistory 的结果里（两臂都钉）', () => {
  const history = [
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: [{ type: 'text', text: '我看了截图' }, { type: 'image_url', image_url: { url: 'x' } }] },
    { role: 'user', content: '继续' },
  ];
  const opts = (visionEnabled) => ({ maxMessages: 10, maxChars: 3000, maxTokens: 8000, visionEnabled });
  // 返回形状兼容两种：当前实现返回**数组**；写成兼容形式，免得因形状变化而误红
  const msgsOf = (out) => (Array.isArray(out) ? out : (out && out.messages) || []);

  const off = msgsOf(normalizeHistory(history, opts(false)));
  const on = msgsOf(normalizeHistory(history, opts(true)));

  for (const [arm, msgs, note] of [['关闭', off, OFF_NOTE], ['开启', on, ON_NOTE]]) {
    const texts = msgs.map((m) => String(m.content));
    assert.ok(texts.some((t) => t.includes('我看了截图')), arm + '臂：数组 content 那轮不许消失 ✗');
    assert.ok(texts.some((t) => t.includes(note)), arm + '臂：要带上该臂的如实说明');
    assert.equal(msgs.length, 3, arm + '臂：三条都应在');
  }
  // 开启臂**不得**再出现"未把图片传给模型"
  assert.ok(
    !on.some((m) => String(m.content).includes('未把图片传给模型')),
    '开启臂不得再说图片没传给模型 ✗'
  );

  // 默认（生产）必须按常量实际值选臂
  const dflt = msgsOf(normalizeHistory(history, { maxMessages: 10, maxChars: 3000, maxTokens: 8000 }));
  assert.deepEqual(dflt, VISION_ENABLED ? on : off, '默认必须按开关实际值选臂');
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

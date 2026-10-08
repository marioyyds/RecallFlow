// 交接包纯逻辑：标识生成/归一化、载荷裁剪、索引维护、交接指令。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  newHandoffId,
  normalizeHandoffId,
  isHandoffId,
  trimMessages,
  buildHandoffRecord,
  updateHandoffIndex,
  formatHandoffPrompt,
  deriveToolTrail,
  handoffByteSize,
  fitRecordToBudget,
} from '../lib/shared/handoff.js';

const BODY_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

test('newHandoffId: 形如 RF-XXXXXX 且剔除易混字符', () => {
  for (let i = 0; i < 200; i++) {
    const id = newHandoffId();
    assert.ok(id.startsWith('RF-'), id);
    const body = id.slice(3);
    assert.ok(BODY_RE.test(body), '含非法字符: ' + id);
    // 易混字符不得出现
    assert.ok(!/[01OIL]/.test(body), '含易混字符: ' + id);
  }
});

test('newHandoffId: 200 次采样应基本不重复', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(newHandoffId());
  assert.ok(seen.size >= 198, '重复过多: ' + seen.size);
});

test('normalizeHandoffId: 接受小写、省略前缀、含空格的写法', () => {
  assert.equal(normalizeHandoffId('RF-7K2M9X'), 'RF-7K2M9X');
  assert.equal(normalizeHandoffId('rf-7k2m9x'), 'RF-7K2M9X');
  assert.equal(normalizeHandoffId('7K2M9X'), 'RF-7K2M9X');
  assert.equal(normalizeHandoffId(' RF-7K2M9X '), 'RF-7K2M9X');
  assert.equal(normalizeHandoffId('RF 7K2 M9X'), 'RF-7K2M9X');
});

test('normalizeHandoffId: 非法输入返回空串（含易混字符也拒收）', () => {
  assert.equal(normalizeHandoffId(''), '');
  assert.equal(normalizeHandoffId(null), '');
  assert.equal(normalizeHandoffId(undefined), '');
  assert.equal(normalizeHandoffId('RF-ABC'), '');
  assert.equal(normalizeHandoffId('RF-0K2M9X'), ''); // 含 0（易混，不在字母表内）
  assert.equal(normalizeHandoffId('hello world'), '');
  assert.equal(normalizeHandoffId('RF-7K2M9X-EXTRA'), '');
});

test('isHandoffId: 判定与 normalize 一致', () => {
  assert.equal(isHandoffId('RF-7K2M9X'), true);
  assert.equal(isHandoffId('nope'), false);
});

test('trimMessages: 只保留 user/assistant，取最近 N 条，逐条截断', () => {
  const msgs = [];
  for (let i = 0; i < 30; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
  msgs.push({ role: 'system', content: '不该出现' });
  msgs.push({ role: 'tool', content: '不该出现' });
  const out = trimMessages(msgs, 20, 100);
  assert.equal(out.length, 20);
  assert.ok(!out.some((m) => m.role === 'system' || m.role === 'tool'));
  // 取的是最后 20 条对话（含新追加的 system/tool 之前那批）
  assert.equal(out[out.length - 1].content, 'm29');

  const long = trimMessages([{ role: 'user', content: 'x'.repeat(5000) }], 20, 100);
  assert.ok(long[0].content.length < 200);
  assert.ok(long[0].content.endsWith('（已截断）'));
});

test('trimMessages: 脏数据不抛错', () => {
  assert.deepEqual(trimMessages(null), []);
  assert.deepEqual(trimMessages([null, 1, 'x', {}]), []);
});

test('buildHandoffRecord: 生成自包含记录并做体积封顶', () => {
  const rec = buildHandoffRecord({
    id: 'rf-7k2m9x',
    pageUrl: 'http://localhost:5173/cart',
    pageTitle: '购物车',
    messages: [{ role: 'user', content: '提交没反应' }],
    pickedElements: [{ selector: '#submit', tag: 'button', text: '提交', source: { file: 'src/S.tsx', line: 42 } }],
    selection: '选中的文字',
    lastError: 'Agent 运行出错：xxx',
    consoleEntries: [
      { level: 'log', text: '忽略我' },
      { level: 'error', text: 'boom', stack: 'Error: boom', at: 123 },
      { level: 'warn', text: 'warn', at: 124 },
    ],
    now: 999,
  });
  assert.equal(rec.id, 'RF-7K2M9X');
  assert.equal(rec.version, 1);
  assert.equal(rec.updatedAt, 999);
  assert.equal(rec.createdAt, 999);
  assert.equal(rec.pageTitle, '购物车');
  assert.equal(rec.messageCount, 1);
  assert.equal(rec.messages.length, 1);
  assert.equal(rec.pickedElements[0].source.line, 42);
  // log 级别不进入交接包
  assert.equal(rec.consoleErrors.length, 2);
  assert.deepEqual(rec.consoleErrors.map((e) => e.level), ['error', 'warn']);
});

test('buildHandoffRecord: 保留 createdAt（续写场景）', () => {
  const rec = buildHandoffRecord({ id: 'RF-7K2M9X', createdAt: 111, now: 222 });
  assert.equal(rec.createdAt, 111);
  assert.equal(rec.updatedAt, 222);
});

test('buildHandoffRecord: 非法标识抛错（调用方需处理）', () => {
  assert.throws(() => buildHandoffRecord({ id: 'bad' }), /合法/);
  assert.throws(() => buildHandoffRecord({}), /合法/);
});

test('updateHandoffIndex: 置顶去重、按上限截断并给出待删列表', () => {
  const { index, dropped } = updateHandoffIndex([], 'RF-AAAAAA', 1, 3);
  assert.deepEqual(index, [{ id: 'RF-AAAAAA', at: 1 }]);
  assert.deepEqual(dropped, []);

  const again = updateHandoffIndex(index, 'RF-AAAAAA', 5, 3);
  assert.deepEqual(again.index, [{ id: 'RF-AAAAAA', at: 5 }], '同 id 应更新而非重复');

  let cur = [];
  for (const id of ['RF-AAAAAA', 'RF-BBBBBB', 'RF-CCCCCC', 'RF-DDDDDD']) {
    const r = updateHandoffIndex(cur, id, 1, 3);
    cur = r.index;
  }
  assert.equal(cur.length, 3);
  assert.equal(cur[0].id, 'RF-DDDDDD');
  // 最旧的应被淘汰
  assert.ok(!cur.some((e) => e.id === 'RF-AAAAAA'));
});

test('updateHandoffIndex: 超出上限时报告被丢弃的 id', () => {
  const cur = [{ id: 'RF-AAAAAA', at: 1 }, { id: 'RF-BBBBBB', at: 2 }, { id: 'RF-CCCCCC', at: 3 }];
  const { index, dropped } = updateHandoffIndex(cur, 'RF-DDDDDD', 4, 3);
  assert.equal(index.length, 3);
  assert.deepEqual(dropped, ['RF-AAAAAA']);
});

test('updateHandoffIndex: 脏输入安全', () => {
  const r = updateHandoffIndex(null, 'RF-7K2M9X', 1, 5);
  assert.equal(r.index.length, 1);
  assert.deepEqual(r.dropped, []);
});

test('formatHandoffPrompt: 带标识与页面，但**不许指挥 AI 调用不存在的方法**', () => {
  const p = formatHandoffPrompt('rf-7k2m9x', { pageTitle: '购物车' });
  assert.ok(p.includes('RF-7K2M9X'), p);
  assert.ok(p.includes('购物车'), p);
  // 2026-10-08 收口：这条断言原来写的是 `p.includes('recallflow_session')` ——
  // 它把一句**假话**钉成了契约：那个方法在 `recallflow_browser` 的方法表里根本不存在，
  // 而 RF-xxxxxx 只是面板本地登记号。用户把这段贴给任何 AI，对方都会去找一个不存在的工具。
  // 现在反向钉住：**不得**出现工具名，也**不得**出现"调用 recallflow_*"这种指挥。
  assert.ok(!/recallflow_session/.test(p), '不得让 AI 去调用不存在的 recallflow_session：' + p);
  assert.ok(!/调用\s*recallflow/i.test(p), '不得出现"调用 recallflow_*"这类指挥：' + p);
  // 改后的指令必须说清真相：上下文就在正文里（交接包的价值在正文，不在一个 id）
  assert.ok(/正文/.test(p), '应说明完整上下文就在正文里：' + p);
  // 无页面标题时不出现空的括号
  const p2 = formatHandoffPrompt('RF-7K2M9X');
  assert.ok(!p2.includes('（）'), p2);
  assert.equal(formatHandoffPrompt('bad'), '');
});

// ---------------------------------------------------------------- 工具轨迹
// 交接包此前只留 {role, content}，把 parts（工具调用/结果）丢掉了 ——
// 外部 agent 接手时看不到「前一个 AI 已经查过什么」，只能把同样的选择器再试一遍。

test('deriveToolTrail: 把 tool-call 与 tool-result 按 callId 配对成一行', () => {
  const trail = deriveToolTrail([
    {
      role: 'assistant',
      content: '看完了',
      parts: [
        { type: 'narration', text: '先扫一遍' },
        { type: 'tool-call', callId: 'c1', name: 'get_page_snapshot', args: { maxElements: 60 } },
        { type: 'tool-result', callId: 'c1', name: 'get_page_snapshot', status: 'completed', result: '快照：…' },
        { type: 'tool-call', callId: 'c2', name: 'set_element_style', args: { hide: true, selectors: ['.ad'] } },
        { type: 'tool-result', callId: 'c2', name: 'set_element_style', status: 'completed', result: '已隐藏 2 个元素' },
      ],
    },
  ]);
  assert.equal(trail.length, 2);
  assert.equal(trail[0].name, 'get_page_snapshot');
  assert.equal(trail[0].status, 'completed');
  assert.ok(trail[0].args.includes('maxElements'), trail[0].args);
  assert.equal(trail[1].name, 'set_element_style');
  assert.ok(trail[1].result.includes('已隐藏'), trail[1].result);
});

test('deriveToolTrail: 无结果的调用标记为 unknown（而不是假装成功）', () => {
  const trail = deriveToolTrail([
    { role: 'assistant', parts: [{ type: 'tool-call', callId: 'c1', name: 'run_javascript', args: {} }] },
  ]);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].status, 'unknown');
  assert.equal(trail[0].result, '');
});

test('deriveToolTrail: 丢 user、容错脏数据、只留最近 N 步', () => {
  const parts = [];
  for (let i = 0; i < 40; i++) {
    parts.push({ type: 'tool-call', callId: 'c' + i, name: 'tool' + i, args: {} });
    parts.push({ type: 'tool-result', callId: 'c' + i, status: 'completed', result: 'r' + i });
  }
  const trail = deriveToolTrail([{ role: 'user', content: 'hi', parts }, null, { role: 'assistant' }, { role: 'assistant', parts }]);
  assert.equal(trail.length, 24, '应只保留最近 24 步');
  assert.equal(trail[trail.length - 1].name, 'tool39');
});

test('buildHandoffRecord: 工具轨迹进入交接包（此前 parts 被 trimMessages 丢掉）', () => {
  const rec = buildHandoffRecord({
    id: 'RF-7K2M9X',
    messages: [
      { role: 'user', content: '去掉广告' },
      {
        role: 'assistant',
        content: '好了',
        parts: [
          { type: 'tool-call', callId: 'c1', name: 'set_element_style', args: { hide: true } },
          { type: 'tool-result', callId: 'c1', status: 'completed', result: '已隐藏 14 个元素' },
        ],
      },
    ],
  });
  assert.ok(Array.isArray(rec.toolTrail), 'record 应含 toolTrail');
  assert.equal(rec.toolTrail.length, 1);
  assert.equal(rec.toolTrail[0].name, 'set_element_style');
  // messages 仍只承载 {role, content}，轨迹是独立字段
  assert.deepEqual(Object.keys(rec.messages[1]).sort(), ['content', 'role']);
});

test('buildHandoffRecord: 显式传入 toolTrail 时优先使用', () => {
  const rec = buildHandoffRecord({
    id: 'RF-7K2M9X',
    messages: [],
    toolTrail: [{ name: 'x', args: '{}', status: 'completed', result: 'ok' }],
  });
  assert.equal(rec.toolTrail.length, 1);
  assert.equal(rec.toolTrail[0].name, 'x');
});

// ---------------------------------------------------------------- 字节预算
// 条数上限（30 条）挡不住单条超长：最坏 20×4000 字符，而 chrome.storage.local
// 默认约 10MB 由所有记录共享。

test('handoffByteSize: 按 UTF-8 字节计（中文 3 字节）', () => {
  assert.equal(handoffByteSize({}), 2); // "{}"
  assert.equal(handoffByteSize('中'), 5); // '"中"' = 1 + 3 + 1
  assert.equal(handoffByteSize('ab'), 4); // '"ab"' = 4
});

test('handoffByteSize: 不可序列化值返回极大值（触发收缩而非静默通过）', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(handoffByteSize(cyclic), Number.MAX_SAFE_INTEGER);
});

test('fitRecordToBudget: 未超预算时原样返回', () => {
  const rec = { id: 'RF-7K2M9X', messages: [{ role: 'user', content: 'hi' }] };
  const out = fitRecordToBudget(rec, 100000);
  assert.equal(out.record, rec);
  assert.equal(out.truncated, '');
});

test('fitRecordToBudget: 超预算时收缩到预算内，并保留关键字段', () => {
  const big = 'x'.repeat(50000);
  const rec = {
    id: 'RF-7K2M9X',
    pageUrl: 'https://example.com',
    messages: [{ role: 'user', content: big }, { role: 'assistant', content: big }],
    consoleErrors: [{ level: 'error', text: 'boom', stack: big }],
    toolTrail: [{ name: 'a', args: big, status: 'completed', result: big }],
    pickedElements: [{ selector: '#a' }],
  };
  const out = fitRecordToBudget(rec, 20000);
  assert.ok(out.bytes <= 20000, '收缩后应满足预算，实际 ' + out.bytes);
  assert.ok(out.truncated, '应标记 truncated');
  assert.equal(out.record.id, 'RF-7K2M9X');
  assert.equal(out.record.pageUrl, 'https://example.com');
});

test('fitRecordToBudget: 第一级只砍控制台堆栈，保留正文与工具轨迹', () => {
  // 堆栈本身必须超过预算，否则第一级不会被触发（记录本来就合规）。
  const big = 'y'.repeat(50000);
  const rec = {
    id: 'RF-7K2M9X',
    messages: [{ role: 'user', content: 'hi' }],
    consoleErrors: [{ level: 'error', text: 'boom', stack: big }],
    toolTrail: [{ name: 'a', args: '{}', status: 'completed', result: 'ok' }],
  };
  assert.ok(handoffByteSize(rec) > 40000, '前置条件：记录应超预算');
  const out = fitRecordToBudget(rec, 40000);
  assert.equal(out.truncated, 'console-stack');
  assert.equal(out.record.consoleErrors[0].stack, '');
  assert.equal(out.record.consoleErrors[0].text, 'boom', '错误正文应保留');
  assert.equal(out.record.toolTrail.length, 1, '工具轨迹此时不应被动');
});

test('fitRecordToBudget: 脏数据安全', () => {
  const out = fitRecordToBudget(null, 100);
  assert.ok(out.record && typeof out.record === 'object');
  const out2 = fitRecordToBudget({ id: 'RF-7K2M9X' }, 10);
  assert.ok(out2.bytes > 0);
});

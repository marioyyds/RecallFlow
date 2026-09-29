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

test('formatHandoffPrompt: 指令含标识与工具名，便于 agent 自动调用', () => {
  const p = formatHandoffPrompt('rf-7k2m9x', { pageTitle: '购物车' });
  assert.ok(p.includes('RF-7K2M9X'), p);
  assert.ok(p.includes('recallflow_session'), p);
  assert.ok(p.includes('购物车'), p);
  // 无页面标题时不出现空的括号
  const p2 = formatHandoffPrompt('RF-7K2M9X');
  assert.ok(!p2.includes('（）'), p2);
  assert.equal(formatHandoffPrompt('bad'), '');
});

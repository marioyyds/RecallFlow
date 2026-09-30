// 会话绑定的纯逻辑测试。
//
// 这一层值得测的原因：它决定「这个会话在讨论哪个页面、从哪一刻算起」，
// 而这个判断错了会静默发生（面板继续讨论一个你早就离开的页面），
// 所以边界情况必须钉死：脏存储、URL 比较规则、截断要如实计数。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BINDING_KEY_PREFIX,
  SNAPSHOT_MAX,
  SNAPSHOT_ENTRY_MAX,
  BINDING_BACKENDS,
  snapshotBuffer,
  trimSnapshotEntry,
  createBinding,
  normalizeBinding,
  isValidBinding,
  normalizeUrlForCompare,
  bindingUrlChanged,
  describeBinding,
  describeElapsed,
  summarizeSnapshot,
  endBinding,
  bindingKey,
} from '../lib/shared/session-binding.js';

// ---------------------------------------------------------------- 快照

test('snapshotBuffer: 取末尾 N 条，并如实记录丢了多少', () => {
  const entries = Array.from({ length: 120 }, (_, i) => ({ text: 'e' + i, at: i }));
  const s = snapshotBuffer(entries, 50);
  assert.equal(s.total, 120);
  assert.equal(s.kept, 50);
  assert.equal(s.dropped, 70);
  assert.equal(s.entries[0].text, 'e70', '应保留最新的那一端');
  assert.equal(s.entries[49].text, 'e119');
});

test('snapshotBuffer: 不足上限时不丢数据，dropped 为 0', () => {
  const s = snapshotBuffer([{ text: 'a' }, { text: 'b' }], 50);
  assert.equal(s.total, 2);
  assert.equal(s.kept, 2);
  assert.equal(s.dropped, 0);
});

test('snapshotBuffer: 脏输入不抛错', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    const s = snapshotBuffer(bad);
    assert.equal(s.total, 0);
    assert.deepEqual(s.entries, []);
  }
  // max 为 0 / 负数 / 非数字
  assert.equal(snapshotBuffer([{ a: 1 }], 0).kept, 0);
  assert.equal(snapshotBuffer([{ a: 1 }], -5).kept, 0);
  assert.equal(snapshotBuffer([{ a: 1 }], NaN).kept, 1, '非数字应退回默认上限');
});

test('snapshotBuffer: 默认上限就是 SNAPSHOT_MAX', () => {
  const entries = Array.from({ length: SNAPSHOT_MAX + 10 }, (_, i) => ({ at: i }));
  assert.equal(snapshotBuffer(entries).kept, SNAPSHOT_MAX);
});

test('trimSnapshotEntry: 长文本被截断且带标记，其余字段结构不变', () => {
  const long = 'x'.repeat(SNAPSHOT_ENTRY_MAX + 100);
  const out = trimSnapshotEntry({ text: long, status: 200, at: 5, nested: { a: 1 } });
  assert.equal(out.status, 200);
  assert.equal(out.at, 5);
  assert.deepEqual(out.nested, { a: 1 });
  assert.ok(out.text.length < long.length);
  assert.ok(out.text.endsWith('…（已截断）'), '截断必须可见，不能静默少数据');
});

test('trimSnapshotEntry: 短文本与非字符串原样保留', () => {
  const out = trimSnapshotEntry({ text: '短', status: 0, ok: false, ms: 12.5 });
  assert.equal(out.text, '短');
  assert.equal(out.status, 0);
  assert.equal(out.ok, false);
  assert.equal(out.ms, 12.5);
  assert.equal(trimSnapshotEntry(null), null);
  assert.equal(trimSnapshotEntry('str'), 'str');
});

// ---------------------------------------------------------------- 建立绑定

test('createBinding: 结构完整，后端默认 local', () => {
  const b = createBinding({
    id: 'sb-1',
    tabId: 7,
    url: 'https://a.test/p',
    title: '标题',
    now: 1000,
    console: [{ text: 'c1' }],
    network: [{ url: 'u1' }, { url: 'u2' }],
  });
  assert.equal(b.id, 'sb-1');
  assert.equal(b.tabId, 7);
  assert.equal(b.backend, 'local');
  assert.equal(b.startedAt, 1000);
  assert.equal(b.startUrl, 'https://a.test/p');
  assert.equal(b.console.kept, 1);
  assert.equal(b.network.kept, 2);
  assert.equal(b.endedAt, null);
  assert.ok(isValidBinding(b));
});

test('createBinding: 未知后端退回 local（v1 不启用 dsh，但不让脏值进存储）', () => {
  assert.equal(createBinding({ id: 'x', now: 1, backend: 'dsh' }).backend, 'dsh', 'dsh 是已知后端，予以保留');
  assert.equal(createBinding({ id: 'x', now: 1, backend: 'nonsense' }).backend, 'local');
  assert.equal(createBinding({ id: 'x', now: 1 }).backend, BINDING_BACKENDS[0]);
});

test('createBinding: 脏输入不抛错', () => {
  const b = createBinding();
  assert.ok(b.id, '应生成 id');
  assert.equal(b.backend, 'local');
  assert.deepEqual(b.console.entries, []);
  assert.equal(createBinding({ tabId: 'not-a-number' }).tabId, null);
});

// ---------------------------------------------------------------- 存储回读

test('normalizeBinding: 拒绝不认识的结构，避免渲染半个记录', () => {
  for (const bad of [null, undefined, 'x', 42, {}, { id: 'a' }, { startedAt: 1 }, { id: 'a', startedAt: 'nope' }]) {
    assert.equal(normalizeBinding(bad), null, '应拒绝：' + JSON.stringify(bad));
  }
});

test('normalizeBinding: 规整字段并补全缺失的快照结构', () => {
  const b = normalizeBinding({ id: 'a', startedAt: 5, tabId: '9', backend: 'weird', console: 'bad' });
  assert.equal(b.tabId, 9);
  assert.equal(b.backend, 'local');
  assert.deepEqual(b.console, { total: 0, kept: 0, dropped: 0, entries: [] });
  assert.deepEqual(b.network.entries, []);
  assert.equal(b.endedAt, null);
});

test('isValidBinding: 已结束的绑定不算有效（面板应显示"重新启动"）', () => {
  const b = createBinding({ id: 'a', now: 1 });
  assert.equal(isValidBinding(b), true);
  assert.equal(isValidBinding(endBinding(b, '用户结束', 2)), false);
});

test('endBinding: 返回新记录，不改入参', () => {
  const b = createBinding({ id: 'a', now: 1 });
  const snapshot = JSON.stringify(b);
  const e = endBinding(b, '页面已变化', 99);
  assert.equal(JSON.stringify(b), snapshot, '入参必须保持不变');
  assert.equal(e.endedAt, 99);
  assert.equal(e.endReason, '页面已变化');
  assert.equal(e.startUrl, b.startUrl, '起点信息保留以便回看');
  assert.equal(endBinding(null, 'x', 1), null);
});

// ---------------------------------------------------------------- URL 比较（漂移判定）

test('normalizeUrlForCompare: 去 hash、去尾斜杠；保留查询串', () => {
  assert.equal(normalizeUrlForCompare('https://a.test/p/'), 'https://a.test/p');
  assert.equal(normalizeUrlForCompare('https://a.test/p#sec'), 'https://a.test/p');
  assert.equal(normalizeUrlForCompare('https://a.test/p?id=1'), 'https://a.test/p?id=1');
  assert.equal(normalizeUrlForCompare(''), '');
  assert.equal(normalizeUrlForCompare(null), '');
});

test('bindingUrlChanged: 同页不同 hash 不算漂移，换页算', () => {
  const b = createBinding({ id: 'a', now: 1, url: 'https://a.test/p' });
  assert.equal(bindingUrlChanged(b, 'https://a.test/p#x'), false, '锚点跳转不是换页');
  assert.equal(bindingUrlChanged(b, 'https://a.test/p/'), false, '尾斜杠差异不是换页');
  assert.equal(bindingUrlChanged(b, 'https://a.test/p?q=1'), true, '查询串变化视为不同页面状态');
  assert.equal(bindingUrlChanged(b, 'https://a.test/other'), true);
});

test('bindingUrlChanged: 记录无效或 URL 缺失时不误报漂移', () => {
  assert.equal(bindingUrlChanged(null, 'https://a.test'), false);
  assert.equal(bindingUrlChanged(createBinding({ id: 'a', now: 1, url: '' }), 'https://a.test'), false);
  assert.equal(bindingUrlChanged(createBinding({ id: 'a', now: 1, url: 'https://a.test' }), ''), false);
  const ended = endBinding(createBinding({ id: 'a', now: 1, url: 'https://a.test' }), 'x', 2);
  assert.equal(bindingUrlChanged(ended, 'https://b.test'), false, '已结束的绑定不再谈漂移');
});

// ---------------------------------------------------------------- 状态文案

test('describeBinding: 未绑定时给出「启动」，并说明它做什么', () => {
  const d = describeBinding(null, 'https://a.test');
  assert.equal(d.state, 'none');
  assert.ok(d.text.includes('启动'));
  assert.ok(d.title.length > 10, '提示应解释绑定的含义');
});

test('describeBinding: 正常绑定显示时长与起点快照摘要', () => {
  const b = createBinding({ id: 'a', tabId: 1, now: 0, url: 'https://a.test/p', title: 'T', console: [{ text: 'c' }], network: [] });
  const d = describeBinding(b, 'https://a.test/p', { now: 125000 });
  assert.equal(d.state, 'ok');
  assert.ok(d.text.includes('已绑定'));
  assert.ok(d.text.includes('2 分钟'), '实际文案：' + d.text);
  assert.ok(d.title.includes('T'));
  assert.ok(d.title.includes('local'), '提示里应写明后端');
});

test('describeBinding: 页面漂移时给出警告而不是静默继续', () => {
  const b = createBinding({ id: 'a', tabId: 1, now: 0, url: 'https://a.test/p' });
  const d = describeBinding(b, 'https://a.test/other', { now: 1000 });
  assert.equal(d.state, 'drifted');
  assert.ok(d.text.includes('变化'));
  assert.ok(d.title.includes('https://a.test/p'), '提示里应说明原本是哪个页面');
});

test('describeBinding: 已结束的绑定提示可重新启动', () => {
  const b = endBinding(createBinding({ id: 'a', now: 0, url: 'https://a.test/p' }), '用户结束', 5);
  const d = describeBinding(b, 'https://a.test/p', { now: 10 });
  assert.equal(d.state, 'ended');
  assert.ok(d.text.includes('重新启动'));
});

test('describeBinding: 无 now 时不显示时长，也不显示负时长', () => {
  const b = createBinding({ id: 'a', now: 100, url: 'https://a.test/p' });
  assert.equal(describeElapsed(100, 0), '');
  assert.equal(describeElapsed(100, 50), '', '时钟回拨不应产生负数时长');
  assert.equal(describeElapsed(0, 30000), '30 秒');
  assert.equal(describeElapsed(0, 3600000 * 3), '3 小时');
});

test('summarizeSnapshot: 如实显示出被截断的条数', () => {
  const b = createBinding({
    id: 'a',
    now: 1,
    console: Array.from({ length: 120 }, (_, i) => ({ at: i })),
    network: [{ at: 1 }],
  });
  const s = summarizeSnapshot(b);
  assert.ok(s.includes('console 50 条（截断 70）'), '实际：' + s);
  assert.ok(s.includes('network 1 条'));
  assert.ok(!s.includes('network 1 条（截断'), '没截断就不该标截断');
  assert.equal(summarizeSnapshot(null), '（无）');
});

// ---------------------------------------------------------------- 键

test('bindingKey: 按 tab 隔离，延续既有存储约定', () => {
  assert.equal(bindingKey(7), BINDING_KEY_PREFIX + '7');
  assert.equal(bindingKey(7), 'recallflow.binding.7');
  assert.notEqual(bindingKey(1), bindingKey(2));
});

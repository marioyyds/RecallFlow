// 请求前缀哨兵（运行时）：
//  - 它必须能认出「历史中部被改写」，这是静态门禁的盲区
//  - 它必须不误报纯追加 —— 否则每轮都会刷屏，等于没有
//  - 指纹必须覆盖请求体里真正被序列化的**全部**字段，而不是挑几个
import test from 'node:test';
import assert from 'node:assert/strict';

import { fingerprintMessage, snapshotMessages, diffSnapshots, formatPrefixReport } from '../lib/assistant/prefix-watch.js';

const sys = (c) => ({ role: 'system', content: c });
const user = (c) => ({ role: 'user', content: c });
const asst = (c) => ({ role: 'assistant', content: c });
const tool = (id, c) => ({ role: 'tool', tool_call_id: id, content: c });

// ---------------------------------------------------------------- 指纹

test('fingerprintMessage: 键序不影响指纹（否则会误报）', () => {
  assert.equal(fingerprintMessage({ role: 'user', content: 'a' }), fingerprintMessage({ content: 'a', role: 'user' }));
});

test('fingerprintMessage: 任意可枚举属性的变化都会改变指纹', () => {
  // 请求体是 JSON.stringify(messages)，挂一个额外属性同样会改变发出的字节。
  // 手写字段列表的指纹会漏掉这种情况 —— 而那正是「将来某天悄悄坏掉」的形态。
  const a = { role: 'assistant', content: 'x' };
  const b = { role: 'assistant', content: 'x', reasoning_content: 'thinking...' };
  assert.notEqual(fingerprintMessage(a), fingerprintMessage(b));
});

test('fingerprintMessage: tool_calls 内容参与指纹', () => {
  const mk = (args) => ({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 't1', type: 'function', function: { name: 'click_element', arguments: args } }],
  });
  assert.notEqual(fingerprintMessage(mk('{"a":1}')), fingerprintMessage(mk('{"a":2}')));
  assert.equal(fingerprintMessage(mk('{"a":1}')), fingerprintMessage(mk('{"a":1}')));
});

// ---------------------------------------------------------------- 判定

test('diffSnapshots: 纯追加判定为 stable', () => {
  const t1 = [sys('s'), user('u'), asst('a1')];
  const t2 = [...t1, tool('t1', 'ok'), asst('a2')];
  const d = diffSnapshots(snapshotMessages(t1), snapshotMessages(t2));
  assert.equal(d.stable, true);
  assert.equal(d.reason, 'appended');
  assert.equal(d.nextLength - d.prevLength, 2);
});

test('diffSnapshots: 计划消息在索引 1 被改写 → 精确指出第 1 条', () => {
  const t1 = [sys('s'), sys('【当前计划】○ 1. 打开'), user('u'), asst('a1')];
  const t2 = [sys('s'), sys('【当前计划】✓ 1. 打开'), user('u'), asst('a1'), tool('t1', 'ok')];
  const d = diffSnapshots(snapshotMessages(t1), snapshotMessages(t2));
  assert.equal(d.stable, false);
  assert.equal(d.divergeAt, 1);
  assert.equal(d.reason, 'rewritten');
  assert.match(d.detail, /msg#1/);
  assert.match(d.detail, /当前计划/);
});

test('diffSnapshots: messages[0] 被改写 → 精确指出第 0 条（整段前缀失效）', () => {
  const t1 = [sys('CHAT 画像'), user('u'), asst('a1')];
  const t2 = [sys('RESEARCH 画像'), user('u'), asst('a1')];
  const d = diffSnapshots(snapshotMessages(t1), snapshotMessages(t2));
  assert.equal(d.stable, false);
  assert.equal(d.divergeAt, 0);
});

test('diffSnapshots: 工具结果被折叠 → 在折叠点报 rewritten', () => {
  const long = 'x'.repeat(3000);
  const t1 = [sys('s'), user('u'), asst('a1'), tool('t1', long), tool('t2', long)];
  const t2 = [sys('s'), user('u'), asst('a1'), tool('t1', 'x'.repeat(300) + '…（折叠）'), tool('t2', long)];
  const d = diffSnapshots(snapshotMessages(t1), snapshotMessages(t2));
  assert.equal(d.stable, false);
  assert.equal(d.divergeAt, 3);
  assert.equal(d.reason, 'rewritten');
});

test('diffSnapshots: 中间插入消息 → 报 inserted', () => {
  const t1 = [sys('s'), user('u'), asst('a1')];
  const t2 = [sys('s'), sys('新插入的画像'), user('u'), asst('a1')];
  const d = diffSnapshots(snapshotMessages(t1), snapshotMessages(t2));
  assert.equal(d.stable, false);
  assert.equal(d.divergeAt, 1);
  assert.equal(d.reason, 'inserted', '插入与改写应能区分开');
});

test('diffSnapshots: 回滚（消息数减少）→ 报 truncated', () => {
  const t1 = [sys('s'), user('u'), asst('a1'), tool('t1', 'ok')];
  const t2 = [sys('s'), user('u'), asst('a1')];
  const d = diffSnapshots(snapshotMessages(t1), snapshotMessages(t2));
  assert.equal(d.stable, false);
  assert.equal(d.reason, 'truncated');
  assert.equal(d.divergeAt, 3);
});

test('diffSnapshots: 首轮没有上一份快照时视为 stable（哨兵不误报）', () => {
  const d = diffSnapshots(snapshotMessages([]), snapshotMessages([sys('s'), user('u')]));
  assert.equal(d.stable, true);
  assert.equal(d.reason, 'appended');
  assert.equal(d.prevLength, 0);
});

test('diffSnapshots: 空输入安全', () => {
  assert.equal(diffSnapshots(null, null).stable, true);
  assert.equal(diffSnapshots(undefined, []).stable, true);
});

// ---------------------------------------------------------------- 日志

test('formatPrefixReport: 稳定时给增量，不稳定时给形态与定位', () => {
  const stable = diffSnapshots(snapshotMessages([sys('s')]), snapshotMessages([sys('s'), user('u')]));
  assert.match(formatPrefixReport(stable), /append-only/);
  assert.match(formatPrefixReport(stable), /\+1/);

  const broken = diffSnapshots(snapshotMessages([sys('s'), sys('旧计划')]), snapshotMessages([sys('s'), sys('新计划')]));
  const text = formatPrefixReport(broken);
  assert.match(text, /rewritten/);
  assert.match(text, /msg#1/);
});

// ---------------------------------------------------------------- 闭环：模拟「循环内调用了一个内部改写的函数」

test('哨兵能抓住静态门禁看不见的形态：循环内调用内部改写的函数', () => {
  // 复刻 syncPlanMessage：改写发生在闭包里（门禁看循环内只有一次函数调用，无从判断），
  // 触发在循环内。静态门禁抓不到，运行时快照抓得到。
  let plan = { text: '○ 1. 打开', done: false };
  const syncPlanMessage = (messages) => {
    const i = messages.findIndex((m) => m.role === 'system' && m.content.startsWith('【当前计划】'));
    if (i >= 0) messages.splice(i, 1);
    messages.splice(1, 0, sys('【当前计划】' + plan.text));
  };

  const messages = [sys('s'), user('u')];
  syncPlanMessage(messages); // 首轮注入
  let prev = snapshotMessages(messages);

  // 第 1 轮
  messages.push(asst('a1'));
  plan = { text: '✓ 1. 打开', done: true };
  syncPlanMessage(messages); // ← 循环内的调用，改写了索引 1
  const d = diffSnapshots(prev, snapshotMessages(messages));

  assert.equal(d.stable, false, '哨兵必须发现这次中部改写');
  assert.equal(d.divergeAt, 1);
  assert.equal(d.reason, 'rewritten');
});

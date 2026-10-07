// 面板「选择跟哪条 DSH 会话说话」的纯逻辑。
//
// 这个功能的两个危险点都在这里被钉住：
//   ① 过滤错了 → 用户以为消息串到别的对话了；
//   ② 选项显示错了 → 用户以为发给了 A，实际发给了 B（而这种错**不会报错**）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chosenStillExists,
  describeSessionChoice,
  shouldRenderSessionFrame,
  shortSessionId,
  sortSessionChoices,
} from '../lib/shared/session-choice.js';

const A = 'session-723c8b32-4ab3-489f-9f53-80958d29c5a9';
const B = 'session-11111111-2222-3333-4444-555555555555';

test('没选会话时全部渲染（旧行为，绝不能变）', () => {
  const frame = { sessionId: A };
  assert.equal(shouldRenderSessionFrame(frame, ''), true);
  assert.equal(shouldRenderSessionFrame(frame, undefined), true);
  assert.equal(shouldRenderSessionFrame(frame, '   '), true);
});

test('选了会话时只渲染那条（别的会话的消息不许混进来）', () => {
  assert.equal(shouldRenderSessionFrame({ sessionId: A }, A), true);
  assert.equal(shouldRenderSessionFrame({ sessionId: B }, A), false, '切到 A 之后不能还显示 B 的消息');
});

test('帧里没有 sessionId 时不隐藏（宁可多显示，也不要让人以为消息丢了）', () => {
  assert.equal(shouldRenderSessionFrame({}, A), true);
  assert.equal(shouldRenderSessionFrame({ sessionId: '' }, A), true);
  assert.equal(shouldRenderSessionFrame(null, A), true);
});

test('选项按最近活动排序，带 isCurrent 标记，脏数据被滤掉', () => {
  const list = [
    { id: A, lastAt: 100 },
    { id: B, lastAt: 300 },
    { id: '', lastAt: 999 },
    { lastAt: 123 },
  ];
  const sorted = sortSessionChoices(list, A);
  assert.deepEqual(sorted.map((x) => x.id), [B, A], '最近活动的在前，空 id 被滤掉');
  assert.equal(sorted.find((x) => x.id === A).isCurrent, true, '当前会话要被标出来');
  assert.equal(sorted.find((x) => x.id === B).isCurrent, false);
});

test('同分时保持原顺序（稳定），没有 lastAt 的沉底', () => {
  const sorted = sortSessionChoices([
    { id: 'a', lastAt: 0 },
    { id: 'b', lastAt: 5 },
    { id: 'c', lastAt: 5 },
    { id: 'd' },
  ]);
  assert.deepEqual(sorted.map((x) => x.id), ['b', 'c', 'a', 'd']);
});

test('文案把"未指定"与"指定了某条"分得很清楚（防"以为发给了 A"）', () => {
  assert.match(describeSessionChoice('', A), /未指定|最近活跃/, '没选时要说明是跟随最近活跃');
  const d = describeSessionChoice(A, A);
  assert.match(d, /指定/);
  const other = describeSessionChoice(B, A);
  assert.match(other, /指定/);
  assert.notEqual(other, d, '指定 B 与指定 A 的文案必须不同，否则看不出区别');
});

test('短标签足够区分（id 太长，界面上放不下整串）', () => {
  const s = shortSessionId(A);
  assert.ok(s.length < A.length, '应当被截短');
  assert.match(s, /c5a9$/, '尾部要保留 —— 同一前缀的 session id 只能靠尾部区分');
  assert.equal(shortSessionId(''), '');
  assert.equal(shortSessionId(undefined), '');
});

test('选中的会话不在列表里时要能被发现（界面得说清，而不是装作没事）', () => {
  assert.equal(chosenStillExists('', [{ id: A }]), true, '没选时永远算"没问题"');
  assert.equal(chosenStillExists(A, [{ id: A }, { id: B }]), true);
  assert.equal(chosenStillExists(B, [{ id: A }]), false, '不在列表里必须能看出来');
  assert.equal(chosenStillExists(A, null), false);
});

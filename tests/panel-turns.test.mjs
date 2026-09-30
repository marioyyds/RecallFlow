// 面板对话增量上报规则（见 lib/shared/panel-turns.js 顶部注释里的真实缺陷）。
//
// 这个 bug 的特殊之处：它**只在反向同步里表现为"看不到用户的话"**，
// 而正向、面板自身、单测全都正常 —— 所以规则必须用测试钉死。
import test from 'node:test';
import assert from 'node:assert/strict';

import { newSpeakTurns, countSpeakTurns, recentSpeakTurns, isSpeakTurn, SPEAK_ROLES, MAX_TURNS_PER_PUSH } from '../lib/shared/panel-turns.js';

const u = (t) => ({ role: 'user', content: t });
const a = (t) => ({ role: 'assistant', content: t });
const ext = (t) => ({ role: 'external', content: t });

test('isSpeakTurn: 只认 user/assistant 且有内容', () => {
  assert.equal(isSpeakTurn(u('x')), true);
  assert.equal(isSpeakTurn(a('x')), true);
  // external 是 DSH 自己推来的，回推会形成回环 —— 必须排除
  assert.equal(isSpeakTurn(ext('x')), false);
  assert.equal(isSpeakTurn({ role: 'user', content: '' }), false);
  assert.equal(isSpeakTurn({ role: 'user' }), false);
  assert.equal(isSpeakTurn(null), false);
  assert.deepEqual(SPEAK_ROLES, ['user', 'assistant']);
});

test('核心缺陷回归：用户回合不会因为"保存时最新一条已是助手"而被跳过', () => {
  // 复现真实时序：先 push 用户（未保存），后 push 助手，最后才保存一次。
  const conversation = [u('面板里用户问的话'), a('面板 AI 的回答')];
  const first = newSpeakTurns(conversation, 0);
  assert.equal(first.turns.length, 2, '两条都必须上报，实际 ' + first.turns.length);
  assert.equal(first.turns[0].content, '面板里用户问的话', '用户回合不能丢');
  assert.equal(first.turns[1].content, '面板 AI 的回答');
  assert.equal(first.pushed, 2);
});

test('不会重复上报：第二次调用返回空', () => {
  const conversation = [u('一'), a('二')];
  const first = newSpeakTurns(conversation, 0);
  const second = newSpeakTurns(conversation, first.pushed);
  assert.deepEqual(second.turns, []);
  assert.equal(second.pushed, first.pushed);
});

test('跨 splice 不错位：删掉中间的 external 条目后仍只推新增的', () => {
  // 真实场景：会话里会 splice 掉过期的 external（MAX_EXTERNAL_TURNS），下标会挪动。
  const conversation = [u('A'), ext('外部1'), a('B')];
  const first = newSpeakTurns(conversation, 0);
  assert.equal(first.pushed, 2);
  // 模拟：external 被裁掉 + 新增一轮对话
  const after = [u('A'), a('B'), u('C'), ext('外部2'), a('D')];
  const second = newSpeakTurns(after, first.pushed);
  assert.deepEqual(second.turns.map((t) => t.content), ['C', 'D'], '只应推新增的 C、D');
});

test('单次上限：积压很多时分批推，不一次灌爆', () => {
  const conversation = [];
  for (let i = 0; i < 30; i++) conversation.push(u('T' + i));
  const first = newSpeakTurns(conversation, 0);
  assert.equal(first.turns.length, MAX_TURNS_PER_PUSH);
  assert.equal(first.turns[0].content, 'T0', '应从最老的未推项开始（不丢历史）');
  const second = newSpeakTurns(conversation, first.pushed);
  assert.equal(second.turns[0].content, 'T' + MAX_TURNS_PER_PUSH);
});

test('历史被换掉（speak 变少）时计数回退，不会从此再不推送', () => {
  const many = [u('1'), a('2'), u('3'), a('4')];
  // 载入了一个更短的会话（切 tab / 清空后重建）：计数大于实际
  const few = [u('新的')];
  const r = newSpeakTurns(few, 4);
  assert.equal(r.turns.length, 1, '回退后必须仍能推送，否则该 tab 永久静默');
  assert.equal(r.turns[0].content, '新的');
  assert.equal(r.pushed, 1);
});

test('countSpeakTurns: 用于载入历史后初始化计数（避免把旧内容重推一遍）', () => {
  assert.equal(countSpeakTurns([u('1'), ext('e'), a('2')]), 2);
  assert.equal(countSpeakTurns([]), 0);
  assert.equal(countSpeakTurns(null), 0);
});

test('recentSpeakTurns: 取**最近**若干条（与 newSpeakTurns 方向相反）', () => {
  const c = [];
  for (let i = 0; i < 20; i++) c.push(u('T' + i));
  assert.deepEqual(recentSpeakTurns(c, 3).map((x) => x.content), ['T17', 'T18', 'T19'], '应取最近的，而不是最老的');
  assert.equal(recentSpeakTurns([], 3).length, 0);
  assert.equal(recentSpeakTurns(null, 3).length, 0);
  // 非法上限退回默认，而不是返回空 —— 返回空会让「载入既有历史也该同步」这件事静默失效
  assert.ok(recentSpeakTurns(c, 0).length > 0, '非法上限应退回默认');
  // 只认 user/assistant
  assert.deepEqual(recentSpeakTurns([u('a'), ext('e'), a('b')], 5).map((x) => x.content), ['a', 'b']);
});

test('载入历史与增量上报配合：不会把同一条推两遍', () => {
  // 真实时序：页面载入 → 同步最近若干条（计数设为当前总数）→ 用户又聊一轮 → 增量只推新的
  const loaded = [u('旧1'), a('旧2')];
  assert.deepEqual(recentSpeakTurns(loaded, 6).map((m) => m.content), ['旧1', '旧2']);
  const pushed = countSpeakTurns(loaded);
  const after = loaded.concat([u('新3')]);
  assert.deepEqual(newSpeakTurns(after, pushed).turns.map((m) => m.content), ['新3'], '增量不该重复推载入过的');
});

test('脏输入不炸：非数组、负数计数、非法上限都退回默认', () => {
  assert.deepEqual(newSpeakTurns(null, 0).turns, []);
  assert.deepEqual(newSpeakTurns('x', 0).turns, []);
  assert.equal(newSpeakTurns([u('a')], -5).pushed, 1);
  assert.equal(newSpeakTurns([u('a')], 0, 0).turns.length, 1, '非法上限应退回默认而不是 0');
});

// 面板事件的纯逻辑测试（事件成形决定用户实际看到什么）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_KINDS,
  MAX_EVENT_TEXT,
  MAX_SPEAK_TEXT,
  MAX_ARG_CHARS,
  oneLine,
  summarizeToolArgs,
  toolStartEvent,
  toolEndEvent,
  sayEvent,
  isValidEvent,
  trimEventQueue,
} from '../integrations/opencode/recallflow-mcp/panel-events.js';

test('oneLine: 折叠空白、限长、脏输入不抛错', () => {
  assert.equal(oneLine('a\n\n  b\tc'), 'a b c');
  assert.equal(oneLine(null), '');
  assert.equal(oneLine(undefined), '');
  assert.equal(oneLine(42), '42');
  assert.equal(oneLine({ a: 1 }), '{"a":1}');
  // 循环引用走 catch 分支
  const cyc = {};
  cyc.self = cyc;
  assert.equal(typeof oneLine(cyc), 'string');
  const long = 'x'.repeat(MAX_EVENT_TEXT + 50);
  assert.ok(oneLine(long).length <= MAX_EVENT_TEXT + 1);
  assert.ok(oneLine(long).endsWith('…'));
  assert.equal(oneLine('abc', 0), 'abc', '非正数上限退回默认');
});

test('oneLine: Error 要显示内容，而不是 JSON 化的空对象', () => {
  // JSON.stringify(new Error('boom')) === '{}' —— 失败事件最需要错误内容，
  // 直接 JSON 化会让用户看到 '{}'，等于什么都没说。
  assert.equal(oneLine(new Error('boom')), 'Error: boom');
  assert.equal(oneLine(new TypeError('bad')), 'TypeError: bad');
  // 无 message 的 Error 也不能变成 '{}'
  assert.ok(oneLine(new Error()).startsWith('Error'));
});

test('summarizeToolArgs: 优先挑能说明「在干什么」的字段，最多 3 个', () => {
  const s = summarizeToolArgs({ url: 'https://a.test/p', maxChars: 999, selector: '#x', ref: 'rf-3', text: 'hi' });
  assert.ok(s.includes('url='), s);
  assert.ok(s.includes('selector='), s);
  assert.ok(s.includes('ref='), s);
  assert.ok(!s.includes('maxChars='), '未入白名单的字段不应优先出现：' + s);
  assert.ok(s.split(' ').length <= 3, '最多 3 个字段：' + s);
});

test('summarizeToolArgs: 未命中白名单时退化为前几个键，且不超长', () => {
  const s = summarizeToolArgs({ alpha: 'a', beta: 'b', gamma: 'c', delta: 'd' });
  assert.ok(s.includes('alpha=') && s.includes('beta=') && s.includes('gamma='), s);
  assert.ok(!s.includes('delta='), s);
  const long = summarizeToolArgs({ url: 'x'.repeat(500) });
  assert.ok(long.length <= MAX_ARG_CHARS + 1, '总长应受 MAX_ARG_CHARS 约束：' + long.length);
});

test('summarizeToolArgs: 空/脏输入返回空串（不显示无意义的 args 行）', () => {
  assert.equal(summarizeToolArgs(null), '');
  assert.equal(summarizeToolArgs(undefined), '');
  assert.equal(summarizeToolArgs({}), '');
  assert.equal(summarizeToolArgs({ url: '' }), '');
});

test('toolStartEvent / toolEndEvent: 结构正确且可校验', () => {
  const s = toolStartEvent('read_console', { filter: 'x' }, 1000);
  assert.equal(s.kind, 'tool');
  assert.equal(s.phase, 'start');
  assert.equal(s.tool, 'read_console');
  assert.equal(s.at, 1000);
  assert.ok(isValidEvent(s));

  const e = toolEndEvent('read_console', true, 123.7, '', 2000);
  assert.equal(e.phase, 'end');
  assert.equal(e.ok, true);
  assert.equal(e.ms, 124, '耗时四舍五入');
  assert.ok(isValidEvent(e));

  const f = toolEndEvent('read_console', false, -5, new Error('boom'), 3000);
  assert.equal(f.ok, false);
  assert.equal(f.ms, 0, '负耗时钳到 0');
  assert.equal(f.error, 'Error: boom');
  assert.ok(isValidEvent(f));
});

test('sayEvent: 限长并规范 level', () => {
  const s = sayEvent('  你好\n世界  ', 'warn', 5);
  assert.equal(s.kind, 'say');
  assert.equal(s.text, '你好 世界');
  assert.equal(s.level, 'warn');
  assert.equal(sayEvent('x', 'nonsense').level, 'info');
  assert.ok(isValidEvent(s));
  // 上限按说话人分级（专项用例在 dsh-plugin.test.mjs）：
  // 这里只钉住"仍然必须限长"这条不变式，并明确旧的 400 一刀切已经不再是行为。
  const long = sayEvent('y'.repeat(5000));
  assert.ok(long.text.length <= MAX_SPEAK_TEXT + 1, '不得超过助手上限');
  assert.ok(long.text.length > MAX_EVENT_TEXT, '不应再被旧的 400 一刀切截断');
});

test('isValidEvent: 拒绝不成形的事件（投递前最后一道校验）', () => {
  for (const bad of [null, undefined, 'x', 42, {}, { kind: 'unknown' }, { kind: 'say' }, { kind: 'say', text: '' }, { kind: 'tool' }, { kind: 'tool', tool: '' }]) {
    assert.equal(isValidEvent(bad), false, '应拒绝：' + JSON.stringify(bad));
  }
  assert.deepEqual(EVENT_KINDS, ['tool', 'say']);
});

test('trimEventQueue: 只保留最近 max 条，且不改入参', () => {
  const list = Array.from({ length: 300 }, (_, i) => ({ i }));
  const trimmed = trimEventQueue(list, 200);
  assert.equal(trimmed.length, 200);
  assert.equal(trimmed[0].i, 100, '丢最老的');
  assert.equal(trimmed[199].i, 299, '留最新的');
  assert.equal(list.length, 300, '入参不变');
  // 边界
  assert.deepEqual(trimEventQueue([1, 2], 5), [1, 2]);
  assert.deepEqual(trimEventQueue(null), []);
  assert.equal(trimEventQueue(list, 0).length, 200, '非正数退回默认上限');
});

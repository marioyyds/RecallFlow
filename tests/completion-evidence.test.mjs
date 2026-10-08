// 完成前校验的证据采集。
//
// 这是「一个 4 步任务跑了 30 多次工具调用」的根因所在：证据只从 4 个读类工具采集，
// 于是「划出关键信息」这类**由动作本身产生结果**的任务，校验器拿到的要么是空证据、
// 要么是动作之前读到的页面，只能判未达成 —— 进而把 agent 逼去手工做 DOM 取证。
//
// 这些用例把采集规则钉住，避免它再退回「只认读类工具」。
import test from 'node:test';
import assert from 'node:assert/strict';

import { evidenceAfter } from '../lib/assistant/agent.js';

const args = (a) => JSON.stringify(a || {});

test('读类工具：结果直接作为证据', () => {
  const out = evidenceAfter('', { name: 'read_current_page', args: {} }, { ok: true, result: '页面正文…' }, args);
  assert.equal(out, '页面正文…');
});

test('有副作用的动作：回执本身成为证据（这正是原实现漏掉的一类）', () => {
  const out = evidenceAfter(
    '旧证据',
    { name: 'highlight_text', args: { texts: ['甲', '乙'] } },
    { ok: true, result: '已高亮 2 / 2 处关键信息' },
    args
  );
  assert.match(out, /【最近一次页面动作】highlight_text/);
  assert.match(out, /已执行成功/);
  assert.match(out, /已高亮 2 \/ 2 处关键信息/, '动作的返回值必须出现在证据里');
  assert.match(out, /"texts"/, '参数要一并给出，校验器才能判断动作是否对得上目标');
  assert.ok(!out.includes('旧证据'), '最近一次动作应取代更早的证据');
});

test('动作失败也要如实记录（隐瞒只会换来一次被否决的 complete_task）', () => {
  const out = evidenceAfter('', { name: 'highlight_text', args: {} }, { ok: false, result: '未找到任何待高亮文本' }, args);
  assert.match(out, /执行失败/);
  assert.match(out, /未找到任何待高亮文本/);
});

test('只读动作不改页面，不能当作「做了事」的证据', () => {
  const prev = '之前的证据';
  const shot = evidenceAfter(prev, { name: 'take_screenshot', args: {} }, { ok: true, result: '已截图 1280×800' }, args);
  assert.equal(shot, prev, '截图不改变页面，不应顶掉既有证据');
});

test('clear_page_overlays 这类页面动作同样进证据', () => {
  const out = evidenceAfter('', { name: 'clear_page_overlays', args: {} }, { ok: true, result: '已清除页面高亮与样式' }, args);
  assert.match(out, /clear_page_overlays/);
});

test('结果为空时保持原有证据不变', () => {
  assert.equal(evidenceAfter('旧', { name: 'click_element', args: {} }, { ok: true }, args), '旧');
  assert.equal(evidenceAfter('旧', { name: 'click_element', args: {} }, null, args), '旧');
  assert.equal(evidenceAfter('旧', { name: 'click_element', args: {} }, { ok: true, result: '' }, args), '旧');
});

test('超长结果被截断，不会把证据撑爆', () => {
  const long = 'x'.repeat(5000);
  const read = evidenceAfter('', { name: 'read_current_page', args: {} }, { ok: true, result: long }, args);
  assert.ok(read.length <= 3000, '读类证据上限 3000，实际 ' + read.length);
  const act = evidenceAfter('', { name: 'set_element_style', args: {} }, { ok: true, result: long }, args);
  assert.ok(act.length < 2500, '动作回执应更短，实际 ' + act.length);
});

test('未知工具名不抛错（getToolMetadata 对未登记工具会降级）', () => {
  assert.doesNotThrow(() => evidenceAfter('', { name: '不存在的工具', args: {} }, { ok: true, result: 'r' }, args));
});

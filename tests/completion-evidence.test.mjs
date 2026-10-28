// 完成前校验的证据采集。
//
// 这是「一个 4 步任务跑了 30 多次工具调用」的根因所在：证据只从 4 个读类工具采集，
// 于是「划出关键信息」这类**由动作本身产生结果**的任务，校验器拿到的要么是空证据、
// 要么是动作之前读到的页面，只能判未达成 —— 进而把 agent 逼去手工做 DOM 取证。
//
// 这些用例把采集规则钉住，避免它再退回「只认读类工具」。
import test from 'node:test';
import assert from 'node:assert/strict';

import { evidenceAfter, classifyTaskKind } from '../lib/application/agent/agent.ts';

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

test('fetch_webpage：内容进证据 —— 即便它已经是只读工具', () => {
  // 这条盯的是一个**组合失效**：抓网页本身不改页面，所以它被标了 readOnly；
  // 而「只读动作不记回执」的早返回会因此把它的内容整个丢掉。
  // 研究类任务的结论全建立在这份内容上，丢了就等于让校验器凭空判断。
  const out = evidenceAfter('', { name: 'fetch_webpage', args: { url: 'https://example.com' } }, { ok: true, result: '正文：今天有 3 条公告' }, args);
  assert.match(out, /今天有 3 条公告/, '抓到的正文必须是证据，而不是被 readOnly 那次早返回吞掉');
});

test('classifyTaskKind：纯读取的任务判 read（研究类任务的关键分叉）', () => {
  // web_search + fetch_webpage + complete_task —— 这就是一次典型的「查资料并总结」。
  // 只要其中任何一个漏标 readOnly，整个 run 就会被问成「页面按要求变了吗」。
  assert.equal(classifyTaskKind(['web_search', 'fetch_webpage', 'complete_task']), 'read');
  assert.equal(classifyTaskKind(['read_current_page', 'get_page_snapshot']), 'read');
});

test('classifyTaskKind：只要有一步改了页面就判 mutation', () => {
  assert.equal(classifyTaskKind(['read_current_page', 'click_element']), 'mutation');
  assert.equal(classifyTaskKind(['fetch_webpage', 'annotate']), 'mutation');
});

test('classifyTaskKind：未知工具（MCP）按 mutation 处理 —— 不知道它会改什么就不能当成只读', () => {
  assert.equal(classifyTaskKind(['mcp__notion__create_page']), 'mutation');
  // 混在只读工具里也一样：一个不确定的成员就足以让「纯读取」不成立
  assert.equal(classifyTaskKind(['read_current_page', 'mcp__foo__bar']), 'mutation');
});

test('classifyTaskKind：没调过工具时退回 mutation（宁可多要一次证据）', () => {
  assert.equal(classifyTaskKind([]), 'mutation');
  assert.equal(classifyTaskKind(null), 'mutation');
});

test('classifyTaskKind：重复的工具名不影响判定（真实调用链里同名会出现很多次）', () => {
  assert.equal(classifyTaskKind(['fetch_webpage', 'fetch_webpage', 'web_search']), 'read');
  assert.equal(classifyTaskKind(['click_element', 'click_element']), 'mutation');
});

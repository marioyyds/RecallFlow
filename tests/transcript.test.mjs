// 对话记录导出（markdown）：这类格式问题的特点是"看代码都对、导出后才发现不对"，
// 所以用数据驱动的用例把它钉住。两个真实缺陷各有一组回归测试：
//   ① 上一版把 parts 拆成「全部叙述」+「全部工具」两组输出，时序被抹平 ——
//      读起来像"先一口气想完了所有话，再一口气把所有工具跑了一遍"，因果链断了
//   ② 参数预览是 JSON.stringify(...).slice(0, 240)，会切出半截 JSON ——
//      记录里看起来像数据坏了，其实只是被截断
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTranscript, previewArgsJson } from '../lib/page/transcript.js';

const wrap = (conversation, extra = {}) =>
  buildTranscript({ title: 'T', url: 'https://e.test/', exportedAt: '2026-01-01 00:00:00', conversation, ...extra });

const pos = (haystack, needle) => {
  const i = haystack.indexOf(needle);
  assert.notEqual(i, -1, '导出结果里应包含「' + needle + '」，实际：\n' + haystack);
  return i;
};

// ---------------------------------------------------------------- ① 时序

test('叙述与工具按原顺序交错输出（本模块存在的理由）', () => {
  const text = wrap([
    {
      role: 'assistant',
      content: '收尾',
      parts: [
        { type: 'narration', text: '第一段叙述' },
        { type: 'tool-call', callId: 'a', name: 'load_skill', args: { name: 'x' } },
        { type: 'tool-result', callId: 'a', name: 'load_skill', status: 'completed', result: '技能正文' },
        { type: 'narration', text: '第二段叙述' },
        { type: 'tool-call', callId: 'b', name: 'clear_page_overlays', args: {} },
        { type: 'tool-result', callId: 'b', name: 'clear_page_overlays', status: 'completed', result: '已清除' },
        { type: 'narration', text: '第三段叙述' },
      ],
    },
  ]);

  assert.ok(pos(text, '第一段叙述') < pos(text, '`load_skill`'), '第一段叙述必须在 load_skill 之前');
  assert.ok(pos(text, '`load_skill`') < pos(text, '第二段叙述'), 'load_skill 必须在第二段叙述之前');
  assert.ok(pos(text, '第二段叙述') < pos(text, '`clear_page_overlays`'), '第二段叙述必须在清除浮层之前');
  assert.ok(pos(text, '`clear_page_overlays`') < pos(text, '第三段叙述'), '清除浮层必须在第三段叙述之前');
});

test('不再输出「全部叙述 + 工具执行汇总」的分组结构', () => {
  const text = wrap([
    {
      role: 'assistant',
      content: '收尾',
      parts: [
        { type: 'narration', text: '叙述' },
        { type: 'tool-call', callId: 'a', name: 'x', args: {} },
        { type: 'tool-result', callId: 'a', name: 'x', status: 'completed', result: 'r' },
      ],
    },
  ]);
  assert.ok(!text.includes('### 工具执行'), '分组小节会把时序抹平，应已移除：\n' + text);
});

// markdown 的 lazy continuation：列表项后面紧跟一行普通文本（中间没有空行）时，
// 那一行会被并进上一条列表项，整段叙述被渲染进项目符号里。实测踩到过。
test('工具行块与后续叙述之间必须留空行（否则叙述会被并进列表项）', () => {
  const text = wrap([
    {
      role: 'assistant',
      content: '收尾',
      parts: [
        { type: 'tool-call', callId: 'a', name: 'x', args: {} },
        { type: 'tool-result', callId: 'a', name: 'x', status: 'completed', result: 'r' },
        { type: 'narration', text: '工具之后的叙述' },
      ],
    },
  ]);
  assert.ok(/- `x` \{\} → ✓ r\n\n工具之后的叙述/.test(text), '列表块后应有空行：\n' + JSON.stringify(text));
});

test('连续多个工具行之间不插空行（保持一个紧凑列表）', () => {
  const text = wrap([
    {
      role: 'assistant',
      parts: [
        { type: 'tool-call', callId: 'a', name: 't1', args: {} },
        { type: 'tool-result', callId: 'a', name: 't1', status: 'completed', result: 'r1' },
        { type: 'tool-call', callId: 'b', name: 't2', args: {} },
        { type: 'tool-result', callId: 'b', name: 't2', status: 'completed', result: 'r2' },
      ],
    },
  ]);
  assert.ok(/- `t1` \{\} → ✓ r1\n- `t2` \{\} → ✓ r2/.test(text), text);
});

test('complete_task 的完成语不会重复出现（面板把它同时作为叙述与工具结果推送）', () => {
  const summary = '任务已完成：已在 CSDN 首页高亮 7 处关键信息，并给出要点总结\n证据：highlight_text 返回「已高亮 7 / 7 处关键信息」';
  const text = wrap([
    {
      role: 'assistant',
      content: summary,
      parts: [
        { type: 'narration', text: '现在一次性高亮关键句。' },
        { type: 'tool-call', callId: 'c', name: 'highlight_text', args: { texts: ['甲'] } },
        { type: 'tool-result', callId: 'c', name: 'highlight_text', status: 'completed', result: '已高亮 1 / 1 处关键信息' },
        { type: 'tool-call', callId: 'd', name: 'complete_task', args: { summary: 's' } },
        { type: 'tool-result', callId: 'd', name: 'complete_task', status: 'completed', result: summary },
        // 面板随后把这句作为叙述推给界面 —— 文本与上面的工具结果逐字相同
        { type: 'narration', text: summary },
      ],
    },
  ]);
  const occurrences = text.split('证据：highlight_text 返回').length - 1;
  assert.equal(occurrences, 1, '完成语应只出现一次，实际 ' + occurrences + ' 次：\n' + text);
});

test('叙述与工具结果只是碰巧相似时不会被误删', () => {
  const text = wrap([
    {
      role: 'assistant',
      content: '收尾',
      parts: [
        { type: 'tool-call', callId: 'a', name: 'x', args: {} },
        { type: 'tool-result', callId: 'a', name: 'x', status: 'completed', result: '已清除页面高亮与样式' },
        { type: 'narration', text: '已清除页面高亮与样式的叠加问题' },
      ],
    },
  ]);
  assert.ok(text.includes('已清除页面高亮与样式的叠加问题'), '不同文本的叙述不能被去重掉：\n' + text);
});

test('复刻用户贴出的那条记录：叙述与工具必须交错，而不是叙述全在前', () => {
  // 取用户实际导出记录的形状：4 段叙述 + 4 个工具调用
  const mk = (id, name, args, result) => [
    { type: 'tool-call', callId: id, name, args },
    { type: 'tool-result', callId: id, name, status: 'completed', result },
  ];
  const text = wrap([
    {
      role: 'assistant',
      content: '任务已完成：已在 CSDN 首页高亮 7 处关键信息',
      parts: [
        { type: 'narration', text: '我先加载「划重点」技能手册' },
        ...mk('a', 'load_skill', { name: 'highlight-key-points' }, '# 技能：划重点'),
        { type: 'narration', text: '页面是 CSDN 首页长文流。我先清除上一轮浮层' },
        ...mk('b', 'clear_page_overlays', {}, '已清除页面高亮与样式'),
        { type: 'narration', text: '现在一次性高亮关键句' },
        ...mk('c', 'highlight_text', { texts: ['句子一', '句子二', '句子三', '句子四'] }, '已高亮 4 / 4 处关键信息'),
        ...mk('d', 'complete_task', { summary: '已完成', evidence: '证据' }, '任务已完成'),
      ],
    },
  ]);

  const order = [
    '我先加载',
    '`load_skill`',
    '页面是 CSDN',
    '`clear_page_overlays`',
    '现在一次性高亮',
    '`highlight_text`',
    '`complete_task`',
  ].map((s) => pos(text, s));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i - 1] < order[i], '第 ' + i + ' 项顺序不对：\n' + text);
  }
});

// ---------------------------------------------------------------- ② 参数 JSON

test('previewArgsJson: 任何输入都产出**可解析**的 JSON（上一版会切出半截）', () => {
  const cases = [
    { texts: Array.from({ length: 7 }, (_, i) => '这是第 ' + (i + 1) + ' 条相当长的关键句'.repeat(6)) },
    { query: 'x'.repeat(500) },
    { nested: { a: { b: { c: { d: ['1'.repeat(200)] } } } } },
    { selectors: Array.from({ length: 40 }, (_, i) => '#sel-' + i) },
    { n: 1, b: true, z: null, arr: [] },
    {},
  ];
  for (const args of cases) {
    const json = previewArgsJson(args);
    assert.doesNotThrow(() => JSON.parse(json), '不是合法 JSON：' + json);
    assert.ok(json.length <= 240 + 40, '预算失控：' + json.length + ' ' + json);
  }
});

test('previewArgsJson: 超长参数退化为字段名列表，仍然是合法 JSON', () => {
  const args = { a: 'x'.repeat(200), b: 'y'.repeat(200), c: 'z'.repeat(200) };
  const json = previewArgsJson(args);
  const parsed = JSON.parse(json);
  assert.equal(typeof parsed, 'object');
});

test('previewArgsJson: 数组超长时补「共 N 项」标记，而不是截掉', () => {
  const json = previewArgsJson({ texts: ['甲', '乙', '丙', '丁', '戊'] });
  assert.ok(json.includes('共 5 项'), json);
  const parsed = JSON.parse(json);
  assert.equal(parsed.texts.length, 4, '前 3 项 + 1 个标记元素');
  assert.deepEqual(parsed.texts.slice(0, 3), ['甲', '乙', '丙']);
});

test('previewArgsJson: 不吞掉字符串内部的空白（旧实现会破坏原文）', () => {
  // highlight_text 的约定是「必须使用页面中的原文片段」，记录里更不能被改写
  const original = '第一行\n第二行  两个空格';
  const parsed = JSON.parse(previewArgsJson({ texts: [original] }));
  assert.equal(parsed.texts[0], original);
});

test('previewArgsJson: 循环引用等脏输入不抛异常', () => {
  const a = { name: 'x' };
  a.self = a;
  assert.doesNotThrow(() => previewArgsJson(a));
  assert.equal(previewArgsJson(null), '{}');
  assert.equal(previewArgsJson(undefined), '{}');
});

test('工具行里内联的参数是可解析 JSON（回归：曾输出 {"texts":["甲","乙"…）', () => {
  const text = wrap([
    {
      role: 'assistant',
      parts: [
        { type: 'narration', text: '高亮' },
        { type: 'tool-call', callId: 'a', name: 'highlight_text', args: { texts: ['甲'.repeat(60), '乙'] } },
        { type: 'tool-result', callId: 'a', name: 'highlight_text', status: 'completed', result: 'ok' },
      ],
    },
  ]);
  const line = text.split('\n').find((l) => l.startsWith('- `highlight_text`'));
  assert.ok(line, '应有 highlight_text 的工具行：\n' + text);
  const json = line.slice(line.indexOf('` ') + 2, line.lastIndexOf(' → '));
  assert.doesNotThrow(() => JSON.parse(json), '工具行里的参数必须是完整 JSON：' + json);
});

// ---------------------------------------------------------------- 其它形状

test('工具结果过长时截断并如实报出总长度', () => {
  const text = wrap([
    {
      role: 'assistant',
      parts: [
        { type: 'tool-call', callId: 'a', name: 'read_current_page', args: {} },
        { type: 'tool-result', callId: 'a', name: 'read_current_page', status: 'completed', result: 'x'.repeat(900) },
      ],
    },
  ]);
  assert.ok(text.includes('已截断'), text);
  assert.ok(text.includes('共 900 字符'), text);
});

test('截图步骤会被记录（旧实现完全忽略，导致步数与实际不符）', () => {
  const text = wrap([
    {
      role: 'assistant',
      parts: [
        { type: 'tool-call', callId: 'a', name: 'take_screenshot', args: {} },
        { type: 'tool-result', callId: 'a', name: 'take_screenshot', status: 'completed', result: '已截图' },
        { type: 'screenshot', label: '首屏', width: 1280, height: 800, bytes: 240000 },
      ],
    },
  ]);
  assert.ok(text.includes('截图'), text);
  assert.ok(text.includes('1280×800'), text);
});

test('没有配对 tool-call 的孤儿结果也会被记录，而不是静默丢弃', () => {
  const text = wrap([
    { role: 'assistant', parts: [{ type: 'tool-result', callId: 'zzz', name: 'ghost', status: 'failed', result: '出错了' }] },
  ]);
  assert.ok(text.includes('ghost'), text);
  assert.ok(text.includes('✗'), text);
});

test('工具状态标记：失败 ✗ / 未执行 — / 无结果 …', () => {
  const text = wrap([
    {
      role: 'assistant',
      parts: [
        { type: 'tool-call', callId: 'a', name: 't1', args: {} },
        { type: 'tool-result', callId: 'a', name: 't1', status: 'failed', result: 'boom' },
        { type: 'tool-call', callId: 'b', name: 't2', args: {} },
        { type: 'tool-result', callId: 'b', name: 't2', status: 'rejected', result: '未批准' },
        { type: 'tool-call', callId: 'c', name: 't3', args: {} },
      ],
    },
  ]);
  assert.match(text, /- `t1` \{\} → ✗ boom/);
  assert.match(text, /- `t2` \{\} → — 未批准/);
  assert.match(text, /- `t3` \{\} → …/);
});

test('结论：最后一段叙述就是最终文本时不重复', () => {
  const dup = wrap([{ role: 'assistant', content: '最终答复', parts: [{ type: 'narration', text: '最终答复' }] }]);
  assert.ok(!dup.includes('### 结论'), dup);

  const diff = wrap([{ role: 'assistant', content: '最终答复', parts: [{ type: 'narration', text: '过程中的话' }] }]);
  assert.ok(diff.includes('### 结论'), diff);
  assert.ok(diff.includes('最终答复'), diff);
});

test('用户消息与参考来源', () => {
  const text = wrap([
    { role: 'user', content: '划出页面关键信息' },
    {
      role: 'assistant',
      content: '好的',
      parts: [{ type: 'narration', text: '好的' }],
      citations: [{ index: 1, title: '来源A', url: 'https://a.test/' }],
    },
  ]);
  assert.ok(pos(text, '## 用户') < pos(text, '划出页面关键信息'));
  assert.ok(pos(text, '## RecallFlow') < pos(text, '### 参考来源'));
  assert.ok(text.includes('- [1] 来源A — https://a.test/'));
});

test('会话标识出现在头部，便于 AI 取回上下文', () => {
  const text = wrap([{ role: 'user', content: 'x' }], { handoffId: 'RF-E2F7ZH' });
  assert.ok(text.includes('recallflow_session("RF-E2F7ZH")'), text);
  const without = wrap([{ role: 'user', content: 'x' }]);
  assert.ok(!without.includes('会话标识'), without);
});

test('空对话给出明确提示而不是空文档', () => {
  assert.ok(wrap([]).includes('（暂无对话）'));
  assert.ok(wrap(null).includes('（暂无对话）'));
});

test('脏数据安全：null part / 非对象 part / 缺字段', () => {
  const text = wrap([
    null,
    { role: 'assistant' },
    { role: 'assistant', parts: [null, 42, {}, { type: 'narration' }, { type: 'tool-call' }] },
    { role: 'user' },
  ]);
  assert.equal(typeof text, 'string');
  assert.ok(text.startsWith('# RecallFlow 对话记录'));
});

test('输出不以多余空行开头或结尾', () => {
  const text = wrap([{ role: 'user', content: 'x' }]);
  assert.ok(text.startsWith('# RecallFlow'), JSON.stringify(text.slice(0, 20)));
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.endsWith('\n\n'), '结尾不应有多余空行');
  assert.ok(!/\n{3,}/.test(text), '不应出现连续 3 个换行');
});

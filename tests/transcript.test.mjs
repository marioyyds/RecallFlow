// 对话记录导出（markdown）：这类格式问题的特点是"看代码都对、导出后才发现不对"，
// 所以用数据驱动的用例把它钉住。两个真实缺陷各有一组回归测试：
//   ① 上一版把 parts 拆成「全部叙述」+「全部工具」两组输出，时序被抹平 ——
//      读起来像"先一口气想完了所有话，再一口气把所有工具跑了一遍"，因果链断了
//   ② 参数预览是 JSON.stringify(...).slice(0, 240)，会切出半截 JSON ——
//      记录里看起来像数据坏了，其实只是被截断
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTranscript, previewArgsJson, alreadyCommittedAsText, buildPartialTurn, buildFailedTurn, buildInterruptedTurn, stripTrailingSources, serializeConversationMessages, MAX_PARTS, MAX_PART_RESULT_CHARS, MAX_MESSAGE_CONTENT_CHARS, PARTIAL_TURN_NOTE } from '../lib/page/transcript.js';

const wrap = (conversation, extra = {}) =>
  buildTranscript({ title: 'T', url: 'https://e.test/', exportedAt: '2026-01-01 00:00:00', conversation, ...extra });

const pos = (haystack, needle) => {
  const i = haystack.indexOf(needle);
  assert.notEqual(i, -1, '导出结果里应包含「' + needle + '」，实际：\n' + haystack);
  return i;
};

// ---------------------------------------------------------------- 导出两档（精简 / 完整）
//
// 起因（用户反馈）：复杂会话导出的记录里"读不到完整信息" —— 默认档把单条工具结果截到 500 字。
// 但粘贴给另一个 AI 时截断是有意义的（上下文成本真实存在），所以做成**两档**而不是直接放开：
//   brief（默认）→ 单条 500 字，适合粘贴
//   full         → 不截断，适合留档 / 排查 / 让接手的 AI 看到前一个 AI 试过的全部步骤
// `maxResultLen` 是本模块**唯一**的裁剪点（用户与助手正文原样输出），所以 full 是真无损。

test('导出两档：brief 截断工具结果，full 不截断（同一段对话，长度必须不同）', () => {
  const long = 'X'.repeat(3000);
  const conv = [
    { role: 'user', content: '跑一下' },
    {
      role: 'assistant',
      parts: [
        { type: 'tool-call', callId: 'a', name: 'run_javascript', args: {} },
        { type: 'tool-result', callId: 'a', status: 'completed', result: long },
      ],
    },
  ];
  const brief = wrap(conv);
  const full = wrap(conv, { maxResultLen: 1e9 });
  assert.ok(brief.includes('已截断'), 'brief 档应当出现截断标记');
  assert.ok(!full.includes('已截断'), 'full 档**不该**有截断标记：它就是为无损存在的');
  assert.ok(brief.includes(long.slice(0, 400)), 'brief 保留开头');
  assert.ok(!brief.includes(long), 'brief 不该包含全量');
  assert.ok(full.includes(long), 'full 必须包含**完整**结果');
  assert.ok(full.length > brief.length, 'full 一定更长（否则两档没区别，等于没做）');
});

test('导出两档：正文（用户与助手）在两档里都必须完整 —— 截断只能影响工具结果', () => {
  // 这条是防"顺手也把正文截了"：正文是记录的核心，任何一档都不该动它。
  const body = '要点'.repeat(2000);
  const conv = [
    { role: 'user', content: '问我' },
    { role: 'assistant', content: body },
  ];
  for (const extra of [{}, { maxResultLen: 1e9 }]) {
    const out = wrap(conv, extra);
    assert.ok(out.includes(body), '正文必须原样出现（maxResultLen=' + (extra.maxResultLen || '默认') + '）');
  }
});

test('这条门禁本身有牙齿：若两档用同一个上限，上面的"必须不同"会失败', () => {
  const long = 'Y'.repeat(3000);
  const conv = [
    { role: 'assistant', parts: [{ type: 'tool-call', callId: 'a', name: 't', args: {} }, { type: 'tool-result', callId: 'a', status: 'completed', result: long }] },
  ];
  const same = wrap(conv); // 模拟"两档都走默认"
  assert.equal(same.includes(long), false, '默认档不含全量 —— 若两档同参，full 也就拿不到全量（用例会红）');
});

// ---------------------------------------------------------------- 对话持久化（刷新后还剩什么）
//
// 对话存进 chrome.storage.session（每标签页一个 key，**配额所有标签页共享**约 10MB）。
// 上一版有两个毛病：只有"步数上限 30"、而**单步完全没有上限** ——
// 一条 20KB 的快照乘 30 步就是 600KB。改成"步数留得多、单步有界"。

test('持久化：步数留得多（200），单步各自有界（不再只限条数）', () => {
  const big = 'R'.repeat(50000);
  const parts = [];
  for (let i = 0; i < 260; i++) {
    parts.push({ type: 'tool-call', callId: 'c' + i, name: 't', args: { pad: 'a'.repeat(3000) } });
    parts.push({ type: 'tool-result', callId: 'c' + i, status: 'completed', result: big });
  }
  const [rec] = serializeConversationMessages([{ role: 'assistant', content: 'x', parts }]);
  assert.equal(rec.parts.length, MAX_PARTS, '保留步数应等于上限（原先只有 30）');
  // 用 parts.length 而不是自己再算一遍（每轮推 2 个 part，手算最容易错 —— 本用例第一版就错在这）
  assert.equal(rec.partsTotal, parts.length);
  assert.equal(rec.partsOmitted, parts.length - MAX_PARTS, '丢了多少步必须写明');
  // 单步有界：否则"步数变多"会把配额吃掉
  for (const p of rec.parts) {
    if (typeof p.result === 'string') assert.ok(p.result.length <= MAX_PART_RESULT_CHARS, '单步结果必须有界');
    if (p.args && typeof p.args === 'object') {
      assert.ok(JSON.stringify(p.args).length < 500, '单步参数必须有界');
    }
  }
  // 总量必须远小于"步数 × 原始单步"，否则这次放宽等于没做配额约束
  const bytes = JSON.stringify(rec).length;
  assert.ok(bytes < 200 * 4000, '整轮持久化体积应有界，实际 ' + bytes);
});

test('实测场景：一次约 60 步的会话必须被**完整**持久化（原先 30 步上限要丢一半）', () => {
  // 用户报的就是这个：一次"检索动画"的会话约 60 次工具调用，
  // 刷新后只剩 30 步以内 —— 导出再"完整"也取不回被持久化层丢掉的部分。
  const parts = [];
  for (let i = 0; i < 60; i++) {
    parts.push({ type: 'tool-call', callId: 'c' + i, name: 'tool' + i, args: { i } });
    parts.push({ type: 'tool-result', callId: 'c' + i, status: 'completed', result: 'r' + i });
  }
  const [rec] = serializeConversationMessages([{ role: 'assistant', parts }]);
  assert.equal(rec.partsOmitted, undefined, '60 轮会话不该丢任何一步');
  assert.equal(rec.parts.length, parts.length, '一步不少');
  assert.equal(rec.parts[0].name, 'tool0', '而且是从最早那步开始的（不是只剩尾巴）');
});

test('持久化：没超上限时不写"省略"字段（免得读者以为丢过东西）', () => {
  const [rec] = serializeConversationMessages([
    { role: 'assistant', parts: [{ type: 'tool-call', callId: 'a', name: 't', args: {} }, { type: 'tool-result', callId: 'a', status: 'completed', result: 'ok' }] },
  ]);
  assert.equal(rec.partsOmitted, undefined, '没丢就不能写 partsOmitted');
  assert.equal(rec.partsTotal, undefined);
  assert.equal(rec.contentTruncated, undefined);
});

test('持久化：正文上限放宽（4000 → 20000），超限时标明"已截断"', () => {
  const long = 'A'.repeat(15000);
  const [ok] = serializeConversationMessages([{ role: 'assistant', content: long }]);
  assert.equal(ok.content.length, 15000, '原先 4000 字就被砍，现在应完整保留');
  assert.equal(ok.contentTruncated, undefined);
  const [cut] = serializeConversationMessages([{ role: 'assistant', content: 'B'.repeat(MAX_MESSAGE_CONTENT_CHARS + 10) }]);
  assert.equal(cut.content.length, MAX_MESSAGE_CONTENT_CHARS);
  assert.equal(cut.contentTruncated, true, '截断必须留下显式标记');
});

test('导出里必须**说明**少了多少步（否则记录看起来像"当时只做了这些"）', () => {
  const conv = [
    {
      role: 'assistant',
      partsTotal: 260,
      partsOmitted: 60,
      parts: [{ type: 'tool-call', callId: 'a', name: 't', args: {} }, { type: 'tool-result', callId: 'a', status: 'completed', result: 'ok' }],
    },
  ];
  const out = wrap(conv);
  assert.match(out, /更早的 \*\*60 步\*\*/, '要写出丢了多少步');
  assert.match(out, /共 260 步/, '要写出该轮总步数');
  assert.match(out, /无法恢复/, '要说明这是**不可恢复**的（不能让人以为还取得到）');
  // 没丢的时候不该出现这段提示
  const clean = wrap([{ role: 'assistant', parts: [{ type: 'tool-call', callId: 'a', name: 't', args: {} }, { type: 'tool-result', callId: 'a', status: 'completed', result: 'ok' }] }]);
  assert.ok(!clean.includes('未保留'), '没丢就不该有这句');
});

test('导出里也要说明正文被截断（正文截断与工具截断是两件事）', () => {
  const out = wrap([{ role: 'assistant', content: '答', contentTruncated: true }]);
  assert.match(out, /正文超过存储上限/);
  assert.match(out, /只存在于当次页面会话中/, '要指明可恢复性：原文已不可取回');
  const clean = wrap([{ role: 'assistant', content: '答' }]);
  assert.ok(!clean.includes('正文超过存储上限'));
});

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

// 去重的前提是「那段文字已经**完整**出现在上面」。工具行会按 maxResultLen 截断，
// 所以拿它当去重依据时，一段超长的最终答复会被叙述与结论两处同时挡掉，
// 而工具行只留了前 500 字 —— 尾部整段丢失，且记录里看不出丢了东西。
test('超长最终答复必须完整出现在记录里（不能因为工具行截断而被去重掉）', () => {
  const tail = '【这段尾部是关键】';
  const long = '任务已完成：' + '很长的结论内容。'.repeat(80) + tail;
  assert.ok(long.length > 500, '前置：必须超过 maxResultLen');

  // 情形一：面板同时把它作为叙述推了一次
  const withNarration = wrap([
    {
      role: 'assistant',
      content: long,
      parts: [
        { type: 'narration', text: '过程中的话' },
        { type: 'tool-call', callId: 'd', name: 'complete_task', args: { summary: 's' } },
        { type: 'tool-result', callId: 'd', name: 'complete_task', status: 'completed', result: long },
        { type: 'narration', text: long },
      ],
    },
  ]);
  assert.ok(withNarration.includes(tail), '尾部丢失了：\n' + withNarration);

  // 情形二：没有完成叙述，只能靠「### 结论」补全文
  const withoutNarration = wrap([
    {
      role: 'assistant',
      content: long,
      parts: [
        { type: 'narration', text: '过程中的话' },
        { type: 'tool-call', callId: 'd', name: 'complete_task', args: { summary: 's' } },
        { type: 'tool-result', callId: 'd', name: 'complete_task', status: 'completed', result: long },
      ],
    },
  ]);
  assert.ok(withoutNarration.includes('### 结论'), '工具行放不下全文时必须给出结论小节：\n' + withoutNarration);
  assert.ok(withoutNarration.includes(tail), '尾部丢失了：\n' + withoutNarration);
});

test('超长最终答复只出现一次（补全文不等于重复）', () => {
  const long = '任务已完成：' + '内容。'.repeat(200);
  const text = wrap([
    {
      role: 'assistant',
      content: long,
      parts: [
        { type: 'narration', text: long },
        { type: 'tool-call', callId: 'd', name: 'complete_task', args: {} },
        { type: 'tool-result', callId: 'd', name: 'complete_task', status: 'completed', result: long },
      ],
    },
  ]);
  // 完整长度的那一份只能有一处：要么是叙述，要么是结论
  const fullOnes = text.split('\n').filter((l) => l.trim() === long.trim()).length;
  assert.equal(fullOnes, 1, '全文应恰好出现一次，实际 ' + fullOnes + ' 次');
  assert.ok(!text.includes('### 结论'), '叙述已经带出全文时，结论不该再重复一遍：\n' + text);
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

test('previewArgsJson: 数组超长时补**可辨的**省略标记，而不是截掉', () => {
  const json = previewArgsJson({ texts: ['甲', '乙', '丙', '丁', '戊'] });
  // 形态必须是 `⟨…省略 N 项⟩`：旧写法 `…共 N 项` 与真实元素同形，
  // 读者会把它当成一个真的值（本仓库真被这个误导过一次，见 tests/omit-mark.test.mjs）
  assert.ok(json.includes('⟨…省略 5 项⟩'), json);
  assert.ok(!json.includes('…共 5 项'), '不该再用与数据同形的旧标记');
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
  assert.ok(text.includes('RF-E2F7ZH'), text);
  // 不写死工具名：opencode 侧是 recallflow_session，DSH 侧是 recallflow_browser 的 handoff_get
  assert.ok(!text.includes('recallflow_session'), '导出头部不该点名某一侧的工具');
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

// ---------------------------------------------------------------- 最终答复去重
//
// 实测缺陷（RF-27A7CA）：导出记录末尾同一句话连着出现两遍。
// 原判定是「紧邻的最后一个 part 是 narration 且文字相同」，两种情况下都会失效 ——
// 本轮最后一步是工具调用（complete_task 就是工具）时，最后一个是 tool-result；
// 上一次收尾已 push 过同内容的 text part 时，类型不是 narration。

test('已作为 narration 固化过：判定为重复', () => {
  const parts = [{ type: 'narration', text: '已完成。' }];
  assert.equal(alreadyCommittedAsText(parts, '已完成。'), true);
});

test('已作为 text 固化过：同样判定为重复（这正是漏掉的一类）', () => {
  const parts = [{ type: 'text', text: '已完成。' }];
  assert.equal(alreadyCommittedAsText(parts, '已完成。'), true, '类型是 text 时原实现会漏判 → 记录两遍');
});

test('中间夹着工具 part 时仍能识别（本轮最后一步是工具调用）', () => {
  const parts = [
    { type: 'narration', text: '已确认页面内容。' },
    { type: 'tool-call', callId: 'c1', name: 'complete_task' },
    { type: 'tool-result', callId: 'c1', name: 'complete_task', result: '任务已完成' },
  ];
  assert.equal(alreadyCommittedAsText(parts, '已确认页面内容。'), true, '工具类 part 夹在中间不应影响判定');
});

test('截图 part 也要跳过', () => {
  const parts = [
    { type: 'narration', text: '已完成。' },
    { type: 'screenshot', id: 's1' },
  ];
  assert.equal(alreadyCommittedAsText(parts, '已完成。'), true);
});

test('内容不同则不算重复', () => {
  assert.equal(alreadyCommittedAsText([{ type: 'narration', text: '甲' }], '乙'), false);
});

test('隔了另一段文字之后再说一遍同一句话，是有意重复，不该被吞掉', () => {
  const parts = [
    { type: 'narration', text: '甲' },
    { type: 'text', text: '乙' },
  ];
  assert.equal(alreadyCommittedAsText(parts, '甲'), false, '只比较最近的一段文字');
});

test('空白差异不影响判定', () => {
  assert.equal(alreadyCommittedAsText([{ type: 'narration', text: '  已完成。  ' }], '已完成。'), true, '首尾空白被归一');
  assert.equal(alreadyCommittedAsText([{ type: 'narration', text: '已完成。\r\n' }], '已完成。'), true, '换行被归一');
  // 内部空白只压成一个空格、不会凭空消失（norm 的语义）——不把「已 完成」当成「已完成」
  assert.equal(alreadyCommittedAsText([{ type: 'narration', text: '已 完成。' }], '已完成。'), false);
});

test('空候选与空 parts 安全', () => {
  assert.equal(alreadyCommittedAsText([{ type: 'narration', text: '甲' }], ''), false);
  assert.equal(alreadyCommittedAsText([{ type: 'narration', text: '甲' }], '   '), false);
  assert.equal(alreadyCommittedAsText([], '甲'), false);
  assert.equal(alreadyCommittedAsText(null, '甲'), false);
  assert.equal(alreadyCommittedAsText([null, undefined, {}], '甲'), false);
});

test('只看文字类 part，工具 part 单独存在时不算重复', () => {
  assert.equal(alreadyCommittedAsText([{ type: 'tool-result', result: '已完成。' }], '已完成。'), false);
});

// ---------------------------------------------------------------- 进行中 / 失败的一轮
//
// 实测缺陷：助手条目只在 'end' 收尾时入库，于是任务进行中导出/交接只能拿到用户消息；
// 错误更是只写进 DOM、从不入库，面板一刷新就没了。

test('buildPartialTurn: 把进行中的叙述与工具轨迹一起带上', () => {
  const parts = [{ type: 'tool-result', callId: 'c1', name: 'read_current_page', status: 'completed', result: '页面正文' }];
  const m = buildPartialTurn(parts, '正在挑选关键句');
  assert.equal(m.role, 'assistant');
  assert.equal(m.partial, true);
  assert.match(m.content, /正在挑选关键句/);
  assert.match(m.content, /尚未结束/, '必须说明这一段还没结束，否则外部 AI 会当它读成完整答复');
  assert.equal(m.parts.length, 1, '进行中的工具轨迹不能丢 —— 交接包里最值钱的就是「它试过什么」');
});

test('buildPartialTurn: 标记放在 content 里（交接包的 trimMessages 只保留 role/content）', () => {
  const m = buildPartialTurn([], '半句话');
  assert.ok(m.content.includes(PARTIAL_TURN_NOTE), '标记必须在 content 中，否则交接包里会消失');
});

test('buildPartialTurn: 没有任何内容时返回 null（不产生空消息）', () => {
  assert.equal(buildPartialTurn([], ''), null);
  assert.equal(buildPartialTurn(null, null), null);
  assert.equal(buildPartialTurn([], '   '), null);
});

test('buildPartialTurn: parts 是副本，不污染面板状态', () => {
  const parts = [{ type: 'tool-result', callId: 'c1', name: 'x', result: 'y' }];
  buildPartialTurn(parts, '文本');
  assert.equal(parts.length, 1, '不应修改传入数组');
});

test('buildFailedTurn: 错误文本进 content，并标记 failed', () => {
  const m = buildFailedTurn([{ type: 'narration', text: '我先读取页面' }], '任务失败：请求超时');
  assert.equal(m.role, 'assistant');
  assert.equal(m.failed, true);
  assert.equal(m.content, '任务失败：请求超时');
  assert.equal(m.parts.length, 1, '失败前的工具/叙述必须保留');
});

test('buildFailedTurn: 错误只放 content，不额外塞 text part', () => {
  // 塞进去的话导出侧会判定「已内联展示过」而跳过「### 失败」标题
  const m = buildFailedTurn([], '出错了');
  assert.equal(m.parts.length, 0);
  assert.ok(!m.parts.some((p) => p.type === 'text'), '不应额外插入 text part');
});

test('buildFailedTurn: 没有错误信息时也要有可读文本', () => {
  assert.match(buildFailedTurn([], '').content, /任务失败/);
  assert.match(buildFailedTurn([], null).content, /任务失败/);
});

test('导出：进行中的一轮用「### 进行中」而不是「### 结论」', () => {
  const text = wrap([{ role: 'user', content: '划出关键信息' }, buildPartialTurn([], '正在挑选关键句')]);
  assert.match(text, /### 进行中/);
  assert.ok(!text.includes('### 结论'), '尚未结束的一轮不该叫结论');
  assert.match(text, /尚未结束/);
});

test('导出：失败的一轮用「### 失败」，且保留失败前的叙述与工具行', () => {
  const text = wrap([
    { role: 'user', content: '划出关键信息' },
    buildFailedTurn(
      [
        { type: 'narration', text: '我先读取页面' },
        { type: 'tool-result', callId: 'c1', name: 'highlight_text', status: 'failed', result: '未找到文本' },
      ],
      '任务失败：请求超时'
    ),
  ]);
  assert.match(text, /### 失败/);
  assert.match(text, /任务失败：请求超时/);
  assert.match(text, /我先读取页面/, '失败前的叙述必须保留');
  assert.match(text, /highlight_text/, '失败前的工具轨迹必须保留');
});

test('导出：正常收尾的一轮仍然是「### 结论」（不误伤）', () => {
  const text = wrap([{ role: 'user', content: '问' }, { role: 'assistant', content: '答', parts: [] }]);
  assert.match(text, /### 结论/);});

// ---------------------------------------------------------------- 参考来源去重
//
// 实测导出末尾连着出现两段「参考来源」：模型自己在答复末尾写了一份，导出器又按
// citations 追加了一份。两份内容相同、格式不同（模型那份标题后没有空行）。

test('stripTrailingSources: 去掉模型自己写的末尾来源段', () => {
  const s = stripTrailingSources('结论正文。\n\n### 参考来源\n- [1] 标题 — http://x/');
  assert.equal(s, '结论正文。');
});

test('stripTrailingSources: 保留正文，只删末尾那一段', () => {
  const s = stripTrailingSources('正文提到参考来源这个概念。\n\n还有别的内容。\n\n## 参考来源\n- [1] a\n- [2] b');
  assert.match(s, /正文提到参考来源这个概念/);
  assert.match(s, /还有别的内容/);
  assert.ok(!s.includes('- [1] a'), '末尾来源列表应被去掉');
});

test('stripTrailingSources: 正文里讨论「参考来源」但不带来源列表时不误删', () => {
  const t = '### 参考来源\n这一节我打算讲讲来源是怎么登记的，还没有写列表。';
  assert.equal(stripTrailingSources(t), t, '标题后不是来源条目列表，不能删');
});

test('stripTrailingSources: 通篇只有来源列表时保留（不为了去重把内容清空）', () => {
  const t = '### 参考来源\n- [1] a';
  assert.equal(stripTrailingSources(t), t);
});

test('stripTrailingSources: 支持编号列表与 [n] 开头两种来源写法', () => {
  assert.equal(stripTrailingSources('正文\n\n参考来源\n1. 甲\n2. 乙'), '正文');
  assert.equal(stripTrailingSources('正文\n\n### 参考来源\n[1] 甲'), '正文');
});

test('stripTrailingSources: 标题的几种写法都认（# 标题 / 加粗 / 冒号 / 裸行）', () => {
  for (const head of ['### 参考来源', '**参考来源**', '参考来源：', '参考来源']) {
    assert.equal(stripTrailingSources('正文\n\n' + head + '\n- [1] 甲'), '正文', '未识别：' + head);
  }
});

test('stripTrailingSources: 标题后混进非来源行时不删（避免误伤正文）', () => {
  const t = '正文\n\n### 参考来源\n- [1] 甲\n这一段是解释文字，不是来源条目。';
  assert.equal(stripTrailingSources(t), t);
});

test('stripTrailingSources: 空输入与脏数据安全', () => {
  assert.equal(stripTrailingSources(''), '');
  assert.equal(stripTrailingSources(null), '');
  assert.equal(typeof stripTrailingSources(undefined), 'string');
});

test('导出：模型自带来源段时不与导出器追加的那份重复', () => {
  const text = wrap([
    { role: 'user', content: '问' },
    {
      role: 'assistant',
      content: '答复正文。\n\n### 参考来源\n- [1] 模型自己写的',
      citations: [{ index: 1, title: '页面', url: 'http://x/' }],
      parts: [],
    },
  ]);
  const count = (text.match(/### 参考来源/g) || []).length;
  assert.equal(count, 1, '参考来源只应出现一次，实际 ' + count + ' 次');
  assert.ok(!text.includes('模型自己写的'), '模型那份应被去掉，保留导出器统一格式的那份');
  assert.match(text, /\[1\] 页面 — http:\/\/x\//, '导出器那份要在');
});

// ---------------------------------------------------------------- 异常收尾（中断）
//
// 起因：断线重试耗尽 / 后台未能恢复会话 / 45 秒无响应这三条路原先**直接 endStream()**，
// 而 endStream 会清空 pendingParts ⇒ 屏幕上已经出现的思考与工具步骤**只在 DOM 里**，
// 关掉面板再打开就全没了（数据从未进过 conversation）。
// 用 `buildPartialTurn` 会让导出写「任务仍在进行中」—— 而这时任务**已经结束**，那是假话，
// 因此单独有 buildInterruptedTurn 与「### 中断」。

test('buildInterruptedTurn: 原因 + 已流出正文一起进 content，并标记 interrupted', () => {
  const m = buildInterruptedTurn([{ type: 'thinking', text: '先确认页面结构' }], '我想好了：', '任务中断：连接反复断开');
  assert.equal(m.role, 'assistant');
  assert.equal(m.interrupted, true);
  assert.ok(!m.partial, '中断不是"进行中"：两者在导出里必须能分开');
  assert.match(m.content, /^任务中断：连接反复断开/);
  assert.match(m.content, /我想好了：/);
  assert.match(m.content, /已中断/);
  assert.equal(m.parts.length, 1, '中断前的思考/步骤必须保留');
});

test('buildInterruptedTurn: 说明文案不得声称"任务仍在进行中"（那是假话）', () => {
  const m = buildInterruptedTurn([], '半截正文', '');
  assert.ok(!/仍在进行中/.test(m.content), '任务已经结束了：' + m.content);
  assert.match(m.content, /已中断/);
});

test('buildInterruptedTurn: 四项入参都可以缺（只要有可读文本）', () => {
  const m = buildInterruptedTurn(null, null, null);
  assert.equal(m.parts.length, 0);
  assert.match(m.content, /已中断/, '没有正文也要给一句可读说明');
  assert.equal(buildInterruptedTurn([{ type: 'thinking', text: 'x' }], '', '').parts.length, 1);
});

test('buildInterruptedTurn: 不改动传入数组（面板还会继续用它）', () => {
  const parts = [{ type: 'thinking', text: 'a' }];
  buildInterruptedTurn(parts, 'b', 'c');
  assert.equal(parts.length, 1);
});

test('导出：中断的一轮用「### 中断」，且保留中断前的思考与工具行', () => {
  const text = wrap([
    { role: 'user', content: '跑一下' },
    buildInterruptedTurn(
      [
        { type: 'thinking', text: '先确认页面结构' },
        { type: 'tool-result', callId: 'c1', name: 'get_page_snapshot', status: 'completed', result: '{"ok":true}' },
      ],
      '我想好了',
      '任务中断：连接反复断开'
    ),
  ]);
  assert.match(text, /### 中断/);
  assert.ok(!text.includes('### 结论'), '被打断的一轮不该叫结论');
  assert.match(text, /任务中断：连接反复断开/);
  assert.match(text, /get_page_snapshot/, '中断前的工具轨迹必须保留');
});

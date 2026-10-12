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
  deriveToolTrail,
  buildToolTrail,
  countClampedSteps,
  prepareHandoffTrail,
  MAX_TOOL_TRAIL,
  MAX_TRAIL_FULL,
  handoffByteSize,
  fitRecordToBudget,
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

test('formatHandoffPrompt: 指令含标识与页面，便于对方识别', () => {
  const p = formatHandoffPrompt('rf-7k2m9x', { pageTitle: '购物车' });
  assert.ok(p.includes('RF-7K2M9X'), p);
  assert.ok(p.includes('购物车'), p);
  // 无页面标题时不出现空的括号
  const p2 = formatHandoffPrompt('RF-7K2M9X');
  assert.ok(!p2.includes('（）'), p2);
  assert.equal(formatHandoffPrompt('bad'), '');
});

test('formatHandoffPrompt: 不得写死具体工具名（它随集成而变）', () => {
  // 原先是「请调用 recallflow_session("RF-…")」——那是 opencode 侧 MCP 的名字；
  // DSH 侧叫 recallflow_browser（method=handoff_get），其它 AI 两个都没有。
  // 写死任何一个，粘到不具备该工具的 AI 那里就是静默失效（实测粘给 DSH 正是如此）。
  const p = formatHandoffPrompt('RF-7K2M9X', { pageTitle: '购物车' });
  assert.ok(!p.includes('recallflow_session'), '不该点名 opencode 侧的工具：' + p);
  assert.ok(!p.includes('recallflow_browser'), '也不该点名 DSH 侧的工具');
  assert.ok(!/MCP/i.test(p), '连 MCP 这个概念都不该出现 —— 对方未必有');
});

test('formatHandoffPrompt: 必须给出「没有该能力」时的退路', () => {
  const p = formatHandoffPrompt('RF-7K2M9X', { pageTitle: '购物车' });
  assert.ok(/若没有/.test(p), '要说清没有能力时怎么办：' + p);
  assert.ok(p.includes('导出记录'), '退路是让用户改用面板的「导出记录」');
});

// ---------------------------------------------------------------- 工具轨迹
// 交接包此前只留 {role, content}，把 parts（工具调用/结果）丢掉了 ——
// 外部 agent 接手时看不到「前一个 AI 已经查过什么」，只能把同样的选择器再试一遍。

test('deriveToolTrail: 把 tool-call 与 tool-result 按 callId 配对成一行', () => {
  const trail = deriveToolTrail([
    {
      role: 'assistant',
      content: '看完了',
      parts: [
        { type: 'narration', text: '先扫一遍' },
        { type: 'tool-call', callId: 'c1', name: 'get_page_snapshot', args: { maxElements: 60 } },
        { type: 'tool-result', callId: 'c1', name: 'get_page_snapshot', status: 'completed', result: '快照：…' },
        { type: 'tool-call', callId: 'c2', name: 'set_element_style', args: { hide: true, selectors: ['.ad'] } },
        { type: 'tool-result', callId: 'c2', name: 'set_element_style', status: 'completed', result: '已隐藏 2 个元素' },
      ],
    },
  ]);
  assert.equal(trail.length, 2);
  assert.equal(trail[0].name, 'get_page_snapshot');
  assert.equal(trail[0].status, 'completed');
  assert.ok(trail[0].args.includes('maxElements'), trail[0].args);
  assert.equal(trail[1].name, 'set_element_style');
  assert.ok(trail[1].result.includes('已隐藏'), trail[1].result);
});

test('deriveToolTrail: 无结果的调用标记为 unknown（而不是假装成功）', () => {
  const trail = deriveToolTrail([
    { role: 'assistant', parts: [{ type: 'tool-call', callId: 'c1', name: 'run_javascript', args: {} }] },
  ]);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].status, 'unknown');
  assert.equal(trail[0].result, '');
});

test('deriveToolTrail: 丢 user、容错脏数据、只留最近 N 步', () => {
  const parts = [];
  for (let i = 0; i < 140; i++) {
    parts.push({ type: 'tool-call', callId: 'c' + i, name: 'tool' + i, args: {} });
    parts.push({ type: 'tool-result', callId: 'c' + i, status: 'completed', result: 'r' + i });
  }
  const messages = [{ role: 'user', content: 'hi', parts }, null, { role: 'assistant' }, { role: 'assistant', parts }];
  const trail = deriveToolTrail(messages);
  // 断言**上限本身**而不是字面量：写死 24 会在上限调整时变成一条与行为无关的红灯
  assert.equal(trail.length, MAX_TOOL_TRAIL, '应只保留最近 ' + MAX_TOOL_TRAIL + ' 步');
  assert.equal(trail[trail.length - 1].name, 'tool139', '保留的必须是**最近**的几步');
  assert.equal(trail[0].name, 'tool' + (140 - MAX_TOOL_TRAIL));
});

test('buildToolTrail：**步数**全量不截断，但**单步文本会被裁**且必须留下痕迹（省略计数的依据）', () => {
  const parts = [];
  for (let i = 0; i < 140; i++) {
    parts.push({ type: 'tool-call', callId: 'c' + i, name: 'tool' + i, args: {} });
    parts.push({ type: 'tool-result', callId: 'c' + i, status: 'completed', result: 'r' + i });
  }
  const all = buildToolTrail([{ role: 'assistant', parts }]);
  assert.equal(all.length, 140, 'buildToolTrail 是"全量步数"那份，不能自己丢步');
  // ⚠ 上一版的标题写的是"返回全量**且不截断**" —— 而实现一直在裁单步文本 ✗
  //   于是"被裁"这件事既没进数据也没进说明，接手方会以为拿到的是完整原文。
  //   下面两条把"必须留下痕迹"钉住（行为级：真跑，不看源码字符串）。
  assert.equal(all[0].textClamped, undefined, '短文本不该被标成"被裁"');
  assert.equal(countClampedSteps(all), 0, '这批数据没有任何一步该被标为被裁');

  const longParts = [
    { type: 'tool-call', callId: 'x', name: 'run_javascript', args: { code: 'y'.repeat(500) } },
    { type: 'tool-result', callId: 'x', status: 'completed', result: 'z'.repeat(2000) },
  ];
  const one = buildToolTrail([{ role: 'assistant', parts: longParts }]);
  assert.equal(one[0].textClamped, true, '文本被裁的步必须**留下痕迹**（否则接手方以为它是完整原文）');
  assert.ok(one[0].resultChars > one[0].result.length, '要能看出"原文比取回的长"');
  assert.equal(countClampedSteps(one), 1, '被裁步数要能汇总');
  // 汇总必须**同时**出现在 prepareHandoffTrail 的返回里（交付侧据此说明）
  assert.equal(prepareHandoffTrail(one).textClamped, 1, 'prepareHandoffTrail 要把"被裁步数"一起报出来');
});

// 起因（用户反馈）：一次"检索动画"的会话有约 60 次工具调用，而记录只留最近 24 步、
// 每步结果 300 字符 —— 接手方看不到前面的探索，也就判断不了"哪些路已经试过了"。
//
// 现在的三个数**语义要分清**（上一轮只有 trailTotal/trailOmitted，那时还没有独立存储）：
//   trailTotal   会话真实步数
//   trailStored  可通过分段读取**取回**的步数
//   trailOmitted **真正取不回**的步数（超出全量预算）
// 接手方据此判断"我拿到的是不是完整的、缺的能不能取回"。
test('轨迹的三个数必须自洽：total = stored + omitted，且摘要不超过 stored', () => {
  const parts = [];
  for (let i = 0; i < 140; i++) {
    parts.push({ type: 'tool-call', callId: 'c' + i, name: 'tool' + i, args: {} });
    parts.push({ type: 'tool-result', callId: 'c' + i, status: 'completed', result: 'r' + i });
  }
  const rec = buildHandoffRecord({ id: 'RF-7K2M9X', messages: [{ role: 'assistant', parts }] });
  assert.equal(rec.trailTotal, 140, '要记下轨迹**总数**');
  assert.equal(rec.trailStored, 140, '140 步未超全量上限，应当**全部可检索**');
  assert.equal(rec.trailOmitted, 0, '没丢东西就不能说丢了');
  assert.equal(rec.toolTrail.length, MAX_TOOL_TRAIL, '随包交付的只是摘要');
  // 这才是"还有更多"的信号：接手方看 stored > 摘要长度 就知道该去取
  assert.ok(rec.trailStored > rec.toolTrail.length, '摘要小于可检索步数 → 接手方应知道还有更早的探索');
  // 不变量
  assert.equal(rec.trailTotal, rec.trailStored + rec.trailOmitted);
  // 没超上限时不能虚报
  const small = buildHandoffRecord({
    id: 'RF-7K2M9X',
    messages: [{ role: 'assistant', parts: [{ type: 'tool-call', callId: 'a', name: 'x', args: {} }, { type: 'tool-result', callId: 'a', status: 'completed', result: 'ok' }] }],
  });
  assert.equal(small.trailTotal, 1);
  assert.equal(small.trailStored, 1);
  assert.equal(small.trailOmitted, 0);
  assert.equal(small.toolTrail.length, 1, '摘要不超过可检索步数');
});

test('超出**全量**上限的部分才算"真正取不回"，并被如实计入 omitted', () => {
  const parts = [];
  const n = MAX_TRAIL_FULL + 35;
  for (let i = 0; i < n; i++) {
    parts.push({ type: 'tool-call', callId: 'c' + i, name: 'tool' + i, args: {} });
    parts.push({ type: 'tool-result', callId: 'c' + i, status: 'completed', result: 'r' + i });
  }
  const rec = buildHandoffRecord({ id: 'RF-7K2M9X', messages: [{ role: 'assistant', parts }] });
  assert.equal(rec.trailTotal, n);
  assert.equal(rec.trailStored, MAX_TRAIL_FULL, '可检索部分受全量上限约束');
  assert.equal(rec.trailOmitted, n - MAX_TRAIL_FULL, '取不回的部分必须写明');
  assert.equal(rec.trailTotal, rec.trailStored + rec.trailOmitted, '不变量');
});

test('prepareHandoffTrail：三者同源（记录与独立存储各取所需，不会各算一遍而漂移）', () => {
  const raw = Array.from({ length: 5 }, (_, i) => ({ name: 't' + i, args: '', status: 'completed', result: 'r' }));
  const p = prepareHandoffTrail(raw);
  assert.equal(p.total, 5);
  assert.equal(p.items.length, 5);
  assert.equal(p.omitted, 0);
  assert.equal(p.summary.length, 5, '不足摘要上限时摘要=全部');
  assert.deepEqual(p.summary, p.items.slice(-MAX_TOOL_TRAIL));
});

test('**降级**只影响随包摘要，不得谎报"数据丢了"', () => {
  // 造一条确实超预算的记录，逼 fitRecordToBudget 走到「工具轨迹只留 10 步」那一档
  const parts = [];
  for (let i = 0; i < 60; i++) {
    parts.push({ type: 'tool-call', callId: 'c' + i, name: 'tool' + i, args: { pad: 'y'.repeat(200) } });
    parts.push({ type: 'tool-result', callId: 'c' + i, status: 'completed', result: 'r'.repeat(600) });
  }
  const rec = buildHandoffRecord({ id: 'RF-7K2M9X', messages: [{ role: 'assistant', parts }] });
  const out = fitRecordToBudget(rec, 6000);
  assert.ok(out.truncated, '小预算下应当被降级（否则这条用例没验到东西）');
  // 摘要被砍了 ✓ 但可检索性没变 ✓ 所以 omitted 不能变 ✗
  assert.equal(
    out.record.trailOmitted,
    rec.trailOmitted,
    '降级砍的是**随包摘要**，完整轨迹仍在独立 key 里可取回 —— 报成"丢了"就是谎报'
  );
  assert.equal(out.record.trailStored, rec.trailStored, '可检索步数不因降级而改变');
  assert.ok(out.record.toolTrail.length <= rec.toolTrail.length, '摘要确实变小了');
  // 牙齿：一个"降级时顺手把 omitted 加上去"的实现必须被判不合格（上一版就是这样，存储拆开后成了错）
  const naive = Object.assign({}, out.record, { trailOmitted: rec.trailOmitted + (rec.toolTrail.length - out.record.toolTrail.length) });
  assert.notEqual(naive.trailOmitted, rec.trailOmitted, '朴素写法会多报丢失，应被这条断言识别');
});

test('buildHandoffRecord: 工具轨迹进入交接包（此前 parts 被 trimMessages 丢掉）', () => {
  const rec = buildHandoffRecord({
    id: 'RF-7K2M9X',
    messages: [
      { role: 'user', content: '去掉广告' },
      {
        role: 'assistant',
        content: '好了',
        parts: [
          { type: 'tool-call', callId: 'c1', name: 'set_element_style', args: { hide: true } },
          { type: 'tool-result', callId: 'c1', status: 'completed', result: '已隐藏 14 个元素' },
        ],
      },
    ],
  });
  assert.ok(Array.isArray(rec.toolTrail), 'record 应含 toolTrail');
  assert.equal(rec.toolTrail.length, 1);
  assert.equal(rec.toolTrail[0].name, 'set_element_style');
  // messages 仍只承载 {role, content}，轨迹是独立字段
  assert.deepEqual(Object.keys(rec.messages[1]).sort(), ['content', 'role']);
});

test('buildHandoffRecord: 显式传入 toolTrail 时优先使用', () => {
  const rec = buildHandoffRecord({
    id: 'RF-7K2M9X',
    messages: [],
    toolTrail: [{ name: 'x', args: '{}', status: 'completed', result: 'ok' }],
  });
  assert.equal(rec.toolTrail.length, 1);
  assert.equal(rec.toolTrail[0].name, 'x');
});

// ---------------------------------------------------------------- 字节预算
// 条数上限（30 条）挡不住单条超长：最坏 20×4000 字符，而 chrome.storage.local
// 默认约 10MB 由所有记录共享。

test('handoffByteSize: 按 UTF-8 字节计（中文 3 字节）', () => {
  assert.equal(handoffByteSize({}), 2); // "{}"
  assert.equal(handoffByteSize('中'), 5); // '"中"' = 1 + 3 + 1
  assert.equal(handoffByteSize('ab'), 4); // '"ab"' = 4
});

test('handoffByteSize: 不可序列化值返回极大值（触发收缩而非静默通过）', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(handoffByteSize(cyclic), Number.MAX_SAFE_INTEGER);
});

test('fitRecordToBudget: 未超预算时原样返回', () => {
  const rec = { id: 'RF-7K2M9X', messages: [{ role: 'user', content: 'hi' }] };
  const out = fitRecordToBudget(rec, 100000);
  assert.equal(out.record, rec);
  assert.equal(out.truncated, '');
});

test('fitRecordToBudget: 超预算时收缩到预算内，并保留关键字段', () => {
  const big = 'x'.repeat(50000);
  const rec = {
    id: 'RF-7K2M9X',
    pageUrl: 'https://example.com',
    messages: [{ role: 'user', content: big }, { role: 'assistant', content: big }],
    consoleErrors: [{ level: 'error', text: 'boom', stack: big }],
    toolTrail: [{ name: 'a', args: big, status: 'completed', result: big }],
    pickedElements: [{ selector: '#a' }],
  };
  const out = fitRecordToBudget(rec, 20000);
  assert.ok(out.bytes <= 20000, '收缩后应满足预算，实际 ' + out.bytes);
  assert.ok(out.truncated, '应标记 truncated');
  assert.equal(out.record.id, 'RF-7K2M9X');
  assert.equal(out.record.pageUrl, 'https://example.com');
});

test('fitRecordToBudget: 第一级只砍控制台堆栈，保留正文与工具轨迹', () => {
  // 堆栈本身必须超过预算，否则第一级不会被触发（记录本来就合规）。
  const big = 'y'.repeat(50000);
  const rec = {
    id: 'RF-7K2M9X',
    messages: [{ role: 'user', content: 'hi' }],
    consoleErrors: [{ level: 'error', text: 'boom', stack: big }],
    toolTrail: [{ name: 'a', args: '{}', status: 'completed', result: 'ok' }],
  };
  assert.ok(handoffByteSize(rec) > 40000, '前置条件：记录应超预算');
  const out = fitRecordToBudget(rec, 40000);
  assert.equal(out.truncated, 'console-stack');
  assert.equal(out.record.consoleErrors[0].stack, '');
  assert.equal(out.record.consoleErrors[0].text, 'boom', '错误正文应保留');
  assert.equal(out.record.toolTrail.length, 1, '工具轨迹此时不应被动');
});

test('fitRecordToBudget: 脏数据安全', () => {
  const out = fitRecordToBudget(null, 100);
  assert.ok(out.record && typeof out.record === 'object');
  const out2 = fitRecordToBudget({ id: 'RF-7K2M9X' }, 10);
  assert.ok(out2.bytes > 0);
});

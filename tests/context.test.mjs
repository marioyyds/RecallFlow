import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { estimateTokens, estimateMessagesTokens, collapseOldToolResults, normalizeHistory, formatHistoryTruncationNotice, stripHistoryTruncationNotice, isDuplicateInstruction, HISTORY_MAX_CHARS } from '../lib/application/agent/context.ts';

test('estimateTokens: CJK counts heavier than latin', () => {
  assert.ok(estimateTokens('你好世界') >= 4);
  assert.ok(estimateTokens('hello world') < 4);
  assert.equal(estimateTokens(''), 0);
});

test('estimateMessagesTokens sums content', () => {
  const n = estimateMessagesTokens([{ role: 'user', content: '你好' }, { role: 'assistant', content: 'hello world' }]);
  assert.ok(n > 0);
});

test('collapseOldToolResults keeps the last N full', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'tool', content: 'x'.repeat(1000) + i });
  const collapsed = collapseOldToolResults(msgs, 6, 300);
  assert.equal(collapsed, 4);
  assert.ok(msgs[9].content.length > 300, '最近 6 条保持完整');
  // 折叠后是「头 300 + 提示 + 尾 150」≈ 500 字符 —— 比原先的「只留头 300」长，
  // 这是刻意付出的代价：尾部常带结论，丢掉它比多花 200 字符贵得多。
  assert.ok(msgs[0].content.length < 700, '折叠结果仍应是有界的，实际 ' + msgs[0].content.length);
  assert.match(msgs[0].content, /【已折叠】/);
  assert.ok(msgs[0].content.endsWith('0'), '尾部应被保留（第 0 条的末尾是字符 0）');
});

test('折叠时保留的是**正文**的尾部，不是截断通知的碎片', () => {
  // 踩过的坑：正则只匹配 `id=res-N`，于是 body 的结尾落在通知内部（「…完整内容 」），
  // 正文真正的尾部被当成通知切掉了。正则必须匹配**整条通知**并锚定在末尾。
  const notice = '\n…（结果共 9999 字符，已截断；完整内容 id=res-7，可用 expand_result(id="res-7") 分段读取）';
  const msgs = [];
  for (let i = 0; i < 8; i++) msgs.push({ role: 'tool', content: 'H'.repeat(3000) + 'TAIL_END' + notice });
  collapseOldToolResults(msgs, 6, 300);
  assert.ok(msgs[0].content.endsWith('TAIL_END'), '结尾应是正文尾部，实际 …' + JSON.stringify(msgs[0].content.slice(-24)));
  assert.match(msgs[0].content, /id=res-7/);
});

test('折叠必须保住可恢复的 id —— 否则等于压缩掉了可恢复性', () => {
  // agent 对大结果会写成：正文…（完整内容 id=res-7，可用 expand_result(id="res-7") 分段读取）
  // id 在 3000 字之后，而旧实现无脑 slice(0, 300)，把 id 切掉了：
  // resultStore 里还留着全文，模型却再也拿不到 —— DSH 的 spill 特意保证「可恢复路径」。
  const body = 'A'.repeat(3000);
  const notice = '\n…（结果共 9999 字符，已截断；完整内容 id=res-7，可用 expand_result(id="res-7") 分段读取）';
  const msgs = [];
  for (let i = 0; i < 8; i++) msgs.push({ role: 'tool', content: body + notice });
  collapseOldToolResults(msgs, 6, 300);
  assert.match(msgs[0].content, /id=res-7/, '折叠后必须仍能看到 id');
  assert.match(msgs[0].content, /expand_result/, '并说明怎么取回');
});

test('折叠后不再变长（保住「折叠」这个性质）', () => {
  // 头尾阈值合计 300 + 150，再加 40 的余量：短于这个长度的内容不值得折叠。
  const msgs = [{ role: 'tool', content: 'x'.repeat(900) }];
  for (let i = 0; i < 6; i++) msgs.push({ role: 'tool', content: 'keep' });
  const before = msgs[0].content.length;
  collapseOldToolResults(msgs, 6, 300);
  assert.ok(msgs[0].content.length < before, '折叠应让内容变短：' + before + ' → ' + msgs[0].content.length);
});

test('临界长度：折叠反而会变长时必须原样不动（否则等于凭空制造一次前缀失效）', () => {
  // 头 300 + 尾 150 + 通知文案（约 110 字）≈ 560。也就是说 490～560 字这段区间里，
  // "折叠"的结果比原文**更长** —— 这条路径一旦失守，每轮都会白白改写一次历史中部，
  // 服务端前缀缓存从头失效，而上下文一点没变小。
  const content = 'x'.repeat(520);
  const msgs = [{ role: 'tool', content }];
  for (let i = 0; i < 6; i++) msgs.push({ role: 'tool', content: 'keep' });
  assert.equal(collapseOldToolResults(msgs, 6, 300), 0, '临界长度不应被折叠');
  assert.equal(msgs[0].content, content, '内容必须逐字节不变');
});

// 折叠会改写历史中部 → 从改写点起的前缀缓存全部失效。
// 因此「折叠过一次就不再变」是硬要求：否则同一批消息每轮都被重新拼接，前缀持续抖动。
test('collapseOldToolResults: 已折叠的消息不会被二次改写（前缀只失效一次）', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'tool', content: 'x'.repeat(1000) + i });
  assert.equal(collapseOldToolResults(msgs, 6, 300), 4);
  const before = msgs.map((m) => m.content);

  // 模拟下一轮：又追加两条工具结果，折叠窗口右移
  msgs.push({ role: 'tool', content: 'y'.repeat(1000) });
  msgs.push({ role: 'tool', content: 'z'.repeat(1000) });
  const changed = collapseOldToolResults(msgs, 6, 300);

  assert.equal(changed, 2, '只应折叠刚刚越出窗口的两条');
  for (let i = 0; i < 4; i++) {
    assert.equal(msgs[i].content, before[i], '第 ' + i + ' 条被二次改写 → 前缀会再次失效');
  }
});

test('collapseOldToolResults: 无可折叠内容时返回 0（重复调用不虚报）', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'tool', content: 'x'.repeat(1000) + i });
  collapseOldToolResults(msgs, 6, 300);
  assert.equal(collapseOldToolResults(msgs, 6, 300), 0, '第二次调用不应报告任何折叠');
});

test('collapseOldToolResults: 幂等 —— 连续调用后内容逐字节不变', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'tool', content: 'x'.repeat(1000) + i });
  collapseOldToolResults(msgs, 6, 300);
  const snapshot = JSON.stringify(msgs);
  collapseOldToolResults(msgs, 6, 300);
  collapseOldToolResults(msgs, 6, 300);
  assert.equal(JSON.stringify(msgs), snapshot);
});

// ---------------------------------------------------------------- normalizeHistory

test('normalizeHistory: 只保留有内容的 user/assistant', () => {
  const out = normalizeHistory([
    { role: 'tool', content: 'x' },
    { role: 'user', content: '   ' },
    { role: 'assistant' },
    { role: 'user', content: '有效' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, '有效');
});

test('normalizeHistory: 受 maxMessages 限制，保留最近的', () => {
  const hist = [
    { role: 'user', content: 'a'.repeat(400) },
    { role: 'assistant', content: 'b'.repeat(400) },
    { role: 'user', content: '最近问题' },
  ];
  const out = normalizeHistory(hist, { maxMessages: 2, maxChars: 3000, maxTokens: 1000 });
  assert.equal(out.length, 2);
  assert.equal(out[out.length - 1].content, '最近问题');
});

// ⚠ 这条用例**被改写过**（旧版本断言 `out[0].content.length === 10`，即"静默截断"本身）：
// 旧断言把**缺陷**当契约钉住了 —— 单条历史被 slice 到 10 个字符，而模型看到的是一段
// 没有任何说明的前缀，它会把这半句当成用户原话 ✗
// 现在的断言更严：既要截断，也要**标注**，且未超长时**一个字都不多**（正常路径不受影响）。
test('normalizeHistory: 单条按 maxChars 截断，且截断必须说明（不许静默 slice）', () => {
  const out = normalizeHistory([{ role: 'user', content: 'x'.repeat(100) }], { maxChars: 10 });
  assert.equal(out[0].content.slice(0, 10), 'x'.repeat(10), '送入的应当是前 10 个字符');
  assert.match(out[0].content, /本条历史已截断/, '截断必须标注：否则模型把前半段当完整原文');
  assert.match(out[0].content, /取不回原文/, '这条路径没有 id 可给 ⇒ 必须明说取不回（A5 判据）');
  assert.match(out[0].content, /共 100 字符/, '要给出原文长度，便于判断值不值得追');
  // 正常路径逐字节不变：未超长时不得多出任何标记
  const short = normalizeHistory([{ role: 'user', content: 'x'.repeat(10) }], { maxChars: 10 });
  assert.equal(short[0].content, 'x'.repeat(10));
});

test('normalizeHistory: 上一轮执行摘要超长也要标注（否则摘要看起来是完整的）', () => {
  const out = normalizeHistory([{ role: 'assistant', content: 'ok', toolSummary: 'T'.repeat(900) }]);
  assert.match(out[0].content, /上一轮执行摘要/);
  assert.match(out[0].content, /摘要已截断，共 900 字符/, '摘要被截断必须标注');
});

// ⚠ 「更早的历史被丢掉」必须能被说明 —— 而且**两种上限都要算丢弃**。
// 旧实现只在 token 预算那条路上置位：`for (…; picked.length < maxMessages; …)`
// 让"条数上限"这条路上连置位点都没有 ⇒ 实测 20 条历史、maxMessages=3、开关打开，
// 提示出现 **0 次**，模型把"只剩 3 轮"当成"对话本来就这么短"✗
test('normalizeHistory: 条数上限裁掉更早历史时，开关打开就必须给出提示', () => {
  const hist = [];
  for (let i = 0; i < 20; i++) hist.push({ role: 'user', content: 'm' + i });
  const on = normalizeHistory(hist, { maxMessages: 3, maxTokens: 8000, noticeOnTruncation: true });
  assert.equal(on.length, 4, '3 条历史 + 1 条提示');
  assert.match(on[0].content, /更早的对话/, '条目被裁掉必须有提示：' + JSON.stringify(on.map((m) => m.content)));
  assert.deepEqual(on.slice(1).map((m) => m.content), ['m17', 'm18', 'm19']);
  // 牙齿：旧行为（只在 token 那条路置位）在这个形状下给不出提示 ——
  // 上面的断言若换成"没有提示也算通过"，这条用例就抓不到它。
  const off = normalizeHistory(hist, { maxMessages: 3, maxTokens: 8000 });
  assert.equal(off.some((m) => /更早的对话/.test(m.content)), false, '开关关闭时不加提示（显式 opt-in 仍保留）');
});

test('normalizeHistory: 生产调用方必须打开"裁剪要说"的开关（源码级门禁）', () => {
  // 光有开关没用：这个 flag 曾经**只有测试传过**，生产两处调用都没打开
  // ⇒ 提示在生产里一次也没出现过。这里直接把两处调用点钉住。
  const agentSrc = fs.readFileSync('lib/application/agent/agent.ts', 'utf8');
  const ragSrc = fs.readFileSync('lib/shared/rag.ts', 'utf8');
  assert.match(agentSrc, /normalizeHistory\(history, \{[\s\S]{0,200}?noticeOnTruncation: true/, 'agent.js 必须显式打开');
  assert.match(ragSrc, /normalizeHistory\(payload\.history, \{[\s\S]{0,200}?noticeOnTruncation: true/, 'rag.js 必须显式打开');
});

test('stripHistoryTruncationNotice: 剥掉通知能拿回正文（agent.js 去重判据依赖它）', () => {
  const notice = formatHistoryTruncationNotice(9000, 3000);
  assert.equal(stripHistoryTruncationNotice('正文' + notice), '正文');
  assert.equal(stripHistoryTruncationNotice('没有通知的正文'), '没有通知的正文');
  assert.equal(stripHistoryTruncationNotice(null), '');
  // 牙齒：通知在**中间**（不是末尾）时不许被剥掉 —— 否则会误判成"历史就是这段"
  assert.equal(stripHistoryTruncationNotice('前' + notice + '后'), '前' + notice + '后');
});

// 这条判据原先写在 agent.js 里、**没有任何测试**（只有一条 E2E 间接覆盖），
// 而它有一个字面量副本 `last.length === 3000`。A5 收口给截断历史追加说明时，
// 那个副本会静默失效（症状：用户指令在请求里出现两次）。抽成纯函数 + 在这里钉住。
test('isDuplicateInstruction: 未截断的重复指令要被认出并丢掉', () => {
  assert.equal(isDuplicateInstruction('帮我看看这个按钮', '帮我看看这个按钮'), true);
  assert.equal(isDuplicateInstruction('别的历史', '帮我看看这个按钮'), false);
  assert.equal(isDuplicateInstruction('  ', '帮我看看这个按钮'), false, '空历史不是重复');
  assert.equal(isDuplicateInstruction('帮我看看这个按钮', ''), false, '没有当前指令时不该丢历史');
});

test('isDuplicateInstruction: **被截断的**副本同样要认出（剥掉通知再比）', () => {
  const instr = 'x'.repeat(4000); // 这条指令比 maxChars 长 ⇒ 历史里那份是它的截断副本
  const out = normalizeHistory([{ role: 'user', content: instr }], { maxChars: HISTORY_MAX_CHARS, maxTokens: 8000 });
  const lastContent = out[out.length - 1].content;
  assert.ok(lastContent.length > HISTORY_MAX_CHARS, '前置：历史那条真的被截断并带了说明');
  assert.equal(isDuplicateInstruction(lastContent, instr), true, '截断副本也算重复 —— 否则指令会出现两次');

  // 牙齿：旧写法（拿**原始** content 与字面量 3000 比）在同样的输入下判不出来。
  const legacy = (lastRaw, instruction) => instruction.startsWith(lastRaw) && lastRaw.length === 3000;
  assert.equal(legacy(lastContent, instr), false, '旧写法确实认不出（长度已不是 3000）—— 这就是本条要防的静默失效');
});

test('normalizeHistory: token 预算裁掉更早内容并给出提示', () => {
  const hist = [{ role: 'user', content: '甲'.repeat(50) }, { role: 'user', content: '乙' }];
  const out = normalizeHistory(hist, { maxMessages: 10, maxTokens: 10, noticeOnTruncation: true });
  assert.ok(out.some((m) => m.content.includes('更早的对话')), '裁剪时应有提示');
  assert.equal(out[out.length - 1].content, '乙');
});

test('normalizeHistory: assistant 附带工具执行摘要', () => {
  const out = normalizeHistory([{ role: 'assistant', content: '做完了', toolSummary: 'click_element：已点击' }]);
  assert.ok(out[0].content.includes('上一轮执行摘要'));
  assert.ok(out[0].content.includes('click_element'));
});

test('normalizeHistory: 非数组输入安全返回空', () => {
  assert.deepEqual(normalizeHistory(undefined), []);
  assert.deepEqual(normalizeHistory(null), []);
});


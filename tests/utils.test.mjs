import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, cleanTitle, parseTags, normalizeUrl, detectPlatform, sortItems, formatVisibilityReport, isCspEvalBlockError, composeProgressText, screenshotAttempts, formatScreenshotSummary, formatInspectSummary, formatCurrentPageResult, trimElementsToBudget, formatHighlightResult, SNAPSHOT_CHAR_BUDGET } from '../lib/shared/utils.js';

test('esc escapes html special chars', () => {
  assert.equal(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

test('cleanTitle strips platform suffix', () => {
  assert.equal(cleanTitle('两数之和 - 力扣（LeetCode）'), '两数之和');
});

test('parseTags splits on separators', () => {
  assert.deepEqual(parseTags('a, b，c d'), ['a', 'b', 'c', 'd']);
});

test('normalizeUrl drops hash', () => {
  assert.equal(normalizeUrl('https://x.com/p#h'), 'https://x.com/p');
});

test('detectPlatform matches known sites', () => {
  assert.equal(detectPlatform('https://leetcode.cn/problems/x').id, 'leetcode');
  assert.equal(detectPlatform('https://example.com').id, 'other');
});

test('sortItems defaults to updatedAt desc', () => {
  const list = [{ updatedAt: 1 }, { updatedAt: 3 }, { updatedAt: 2 }];
  assert.deepEqual(sortItems(list).map((x) => x.updatedAt), [3, 2, 1]);
});

// ---------------------------------------------------------------- 可见性核查报告

test('formatVisibilityReport: 可见 0 而 DOM > 0 判为「已隐藏」而不是「没清干净」', () => {
  // 这是修复校验误判的核心语义：文本仍在 DOM 里但不可见，应当算通过。
  const out = formatVisibilityReport([{ text: '广告', visible: 0, dom: 4 }]);
  assert.ok(out.includes('可见 0 次'), out);
  assert.ok(out.includes('DOM 4 次'), out);
  assert.ok(out.includes('均不可见'), out);
  assert.ok(!out.includes('未清理干净'), out);
});

test('formatVisibilityReport: 可见 > 0 明确判为未清理干净，并给出首个可见处', () => {
  const out = formatVisibilityReport([{ text: '赞助内容', visible: 2, dom: 5, context: '正文里的赞助内容片段' }]);
  assert.ok(out.includes('仍有 2 处可见'), out);
  assert.ok(out.includes('未清理干净'), out);
  assert.ok(out.includes('正文里的赞助内容片段'), out);
});

test('formatVisibilityReport: DOM 中也没有时给出第三种结论', () => {
  const out = formatVisibilityReport([{ text: '推广', visible: 0, dom: 0 }]);
  assert.ok(out.includes('已无此文本'), out);
});

test('formatVisibilityReport: 报告头部声明「只能看可见次数」', () => {
  const out = formatVisibilityReport([{ text: 'x', visible: 0, dom: 1 }]);
  assert.ok(out.includes('可见性核查'), out);
  assert.ok(out.includes('只能看'), out);
});

test('formatVisibilityReport: 空输入与脏数据安全', () => {
  assert.equal(formatVisibilityReport([]), '');
  assert.equal(formatVisibilityReport(null), '');
  const out = formatVisibilityReport([null, { text: 'y' }]);
  assert.ok(out.includes('「y」'), out);
  assert.ok(out.includes('可见 0 次'), out);
});

// ---------------------------------------------------------------- CSP / eval 阻止识别

test('isCspEvalBlockError: 识别 Chrome 的典型 CSP 拒绝信息', () => {
  assert.equal(
    isCspEvalBlockError(
      "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\"."
    ),
    true
  );
  assert.equal(isCspEvalBlockError('EvalError: call to eval() blocked by CSP'), true);
  assert.equal(isCspEvalBlockError('Content Security Policy: eval blocked'), true);
  assert.equal(isCspEvalBlockError('blocked by CSP'), true);
});

test('isCspEvalBlockError: 普通 JS 错误不应误判（否则会无谓地改用页面主世界）', () => {
  assert.equal(isCspEvalBlockError('ReferenceError: foo is not defined'), false);
  assert.equal(isCspEvalBlockError('TypeError: Cannot read properties of null'), false);
  assert.equal(isCspEvalBlockError('JS 执行出错：Unexpected token }'), false);
  assert.equal(isCspEvalBlockError(''), false);
  assert.equal(isCspEvalBlockError(null), false);
  assert.equal(isCspEvalBlockError(undefined), false);
});

test('isCspEvalBlockError: 只提 CSP 但与 eval 无关时不算（避免误触发兜底）', () => {
  assert.equal(isCspEvalBlockError('Content Security Policy: refused to load image'), false);
});

// ---------------------------------------------------------------- 进度条文案

test('composeProgressText: 步数 + 状态标签', () => {
  assert.equal(composeProgressText(3, 32, '查看结果'), '第 3 / 32 步 · 查看结果');
});

test('composeProgressText: 无状态标签时只显示步数', () => {
  assert.equal(composeProgressText(3, 32, ''), '第 3 / 32 步');
});

test('composeProgressText: 未开始且无标签时显示「正在思考…」', () => {
  assert.equal(composeProgressText(0, 0, ''), '正在思考…');
  assert.equal(composeProgressText(0, 32, '准备中'), '准备中');
});

test('composeProgressText: **绝不累积** —— 连续调用只反映最后一次', () => {
  // 回归用例：曾经的实现把上一帧文案当兜底值拼进来，
  // 导致「第 4/32 步 · 第 3/32 步 · 第 3/32 步 · …」这样的累积串。
  const seq = [
    [1, 22, '规划步骤'],
    [1, 22, '执行动作'],
    [2, 22, '查看结果'],
    [3, 32, '规划步骤'],
    [4, 32, '已完成'],
  ];
  let out = '';
  for (const [s, m, l] of seq) out = composeProgressText(s, m, l);
  assert.equal(out, '第 4 / 32 步 · 已完成');
  assert.equal(out.split('·').length, 2, '只应有两段：步数 + 状态');
  assert.ok(!out.includes('第 3'), out);
});

test('composeProgressText: 总步数未知时省略分母', () => {
  assert.equal(composeProgressText(2, 0, '执行动作'), '第 2 步 · 执行动作');
});

test('composeProgressText: 脏数据安全', () => {
  assert.equal(composeProgressText(NaN, NaN, null), '正在思考…');
  assert.equal(composeProgressText(-1, -5, undefined), '正在思考…');
  assert.equal(composeProgressText(1.7, 9.9, '  '), '第 1 / 9 步');
});

// ---------------------------------------------------------------- 截图

test('screenshotAttempts: jpeg 阶梯逐级降质且有限', () => {
  const a = screenshotAttempts('jpeg', 72);
  assert.equal(a.length, 3);
  assert.deepEqual(a[0], { format: 'jpeg', quality: 72 });
  assert.equal(a[2].quality, 30);
  // 质量必须单调不增，否则「降质重试」没有意义
  assert.ok(a[0].quality >= a[1].quality && a[1].quality >= a[2].quality, JSON.stringify(a));
});

test('screenshotAttempts: quality 已很低时不重复无效档位', () => {
  const a = screenshotAttempts('jpeg', 35);
  const qualities = a.map((x) => x.quality);
  assert.deepEqual(qualities, [...new Set(qualities)], '不应出现重复档位：' + JSON.stringify(qualities));
  assert.ok(a.length <= 3);
});

test('screenshotAttempts: png 请求超限时会退到 jpeg', () => {
  const a = screenshotAttempts('png', 72);
  assert.equal(a[0].format, 'png');
  assert.ok(a.slice(1).every((x) => x.format === 'jpeg'), '后续档位应退为 jpeg');
});

test('screenshotAttempts: 越界/脏 quality 被夹紧', () => {
  assert.equal(screenshotAttempts('jpeg', 999)[0].quality, 100);
  assert.equal(screenshotAttempts('jpeg', -5)[0].quality, 20);
  assert.equal(screenshotAttempts('jpeg', 'abc')[0].quality, 72);
});

test('formatScreenshotSummary: 必须以「看不到图像」明确警示模型', () => {
  const s = formatScreenshotSummary({ width: 1280, height: 720, format: 'jpeg', quality: 72, bytes: 145408 });
  assert.ok(s.includes('1280×720'), s);
  assert.ok(s.includes('JPEG'), s);
  assert.ok(s.includes('q72'), s);
  assert.ok(s.includes('142KB'), s);
  // 这两点最关键：防止模型凭「已截图」编造页面外观描述
  assert.ok(s.includes('看不到图像'), s);
  assert.ok(s.includes('get_page_snapshot'), s);
});

test('formatScreenshotSummary: 标注与降质提示', () => {
  const s = formatScreenshotSummary({ width: 100, height: 50, format: 'jpeg', bytes: 2048, label: '修改后', degraded: true });
  assert.ok(s.includes('修改后'), s);
  assert.ok(s.includes('自动降质'), s);
});

test('formatScreenshotSummary: 尺寸缺失与脏数据安全', () => {
  const s = formatScreenshotSummary({ format: 'png', bytes: 0 });
  assert.ok(s.includes('尺寸未知'), s);
  assert.equal(typeof formatScreenshotSummary(null), 'string');
});

test('formatScreenshotSummary: 必须声明截图不能作为 complete_task 的证据', () => {
  // 实测会话里 agent 为了「取证」连拍 4 张截图，而完成前校验只读文本证据 ——
  // 那些截图对达成判定毫无帮助，纯属浪费。
  const s = formatScreenshotSummary({ width: 1280, height: 720, format: 'jpeg', bytes: 1024 });
  assert.match(s, /不能作为 complete_task 的 evidence/);
});

// ---------------------------------------------------------------- inspect_element 摘要
//
// 原实现先 slice(0, 8) 再把 matches.length 当命中数报出去 → 任何命中 ≥8 个元素的
// 选择器都恒返回「命中 8 个元素」。调用方无法区分「正好 8」与「至少 8」，
// 一个截断上限就这样被当成了答案。

test('formatInspectSummary: 截断时必须报**命中总数**，并说明只列出了一部分', () => {
  const s = formatInspectSummary({ total: 36, listed: 8, visibleCount: 8, truncated: true });
  assert.match(s, /命中 36 个元素/, '必须报真实命中数：' + s);
  assert.match(s, /仅列出前 8 个/);
  assert.ok(!/^命中 8 个元素/.test(s), '绝不能把截断上限当成命中数');
});

test('formatInspectSummary: 未截断时给出确定的数量', () => {
  const s = formatInspectSummary({ total: 3, listed: 3, visibleCount: 2, truncated: false });
  assert.match(s, /命中 3 个元素/);
  assert.match(s, /可见 2 个，不可见 1 个/);
  assert.ok(!s.includes('仅列出'), '未截断就不该出现截断文案');
});

test('formatInspectSummary: 截断时可见性结论限定在列出的部分内', () => {
  // 否则「可见 8 个」会被读成「全部 36 个里有 8 个可见」
  const s = formatInspectSummary({ total: 36, listed: 8, visibleCount: 5, truncated: true });
  assert.match(s, /列出部分中可见 5 个/);
});

test('formatInspectSummary: 正文容器提醒只在命中项确实触到它时出现', () => {
  const main = { selector: '#root', textLength: 12103 };
  const withMain = formatInspectSummary({ total: 1, listed: 1, visibleCount: 1, truncated: false, touchesMain: true, main });
  assert.match(withMain, /疑似正文容器 #root/);
  const without = formatInspectSummary({ total: 8, listed: 8, visibleCount: 8, truncated: false, touchesMain: false, main });
  assert.match(without, /命中 8 个元素/);
  assert.ok(!without.includes('正文容器'), '无关查询不该收到正文容器提醒：' + without);
});

test('formatInspectSummary: 脏数据安全', () => {
  assert.equal(typeof formatInspectSummary(null), 'string');
  assert.equal(typeof formatInspectSummary({ total: 'x', listed: -5, visibleCount: NaN }), 'string');
  assert.doesNotThrow(() => formatInspectSummary({ total: 1, listed: 1, touchesMain: true, main: null }));
});

// ---------------------------------------------------------------- read_current_page 结果

test('formatCurrentPageResult: 传了 checkTexts 就只回核查结论，不回正文', () => {
  const body = '正文'.repeat(4000);
  const s = formatCurrentPageResult({
    title: 'T',
    url: 'http://x/',
    text: body,
    chunks: [body],
    visReport: '【可见性核查】\n- 「广告」：可见 0 次 / DOM 0 次 —— DOM 中已无此文本',
    checkTexts: ['广告'],
  });
  assert.match(s, /可见性核查/);
  assert.ok(!s.includes(body), '核查模式必须省略页面正文');
  assert.ok(s.length < 500, '结果应当很短，实际 ' + s.length);
  assert.match(s, /如需正文/);
});

test('formatCurrentPageResult: 空白的 checkTexts 不算核查模式', () => {
  const s = formatCurrentPageResult({ title: 'T', url: 'u', text: '页面正文', chunks: ['页面正文'], visReport: '报告', checkTexts: ['  ', ''] });
  assert.match(s, /当前页面正文/);
  assert.match(s, /页面正文/);
});

test('formatCurrentPageResult: 不传 checkTexts 时行为与原来一致（含 visibleOnly 说明与核查报告）', () => {
  const s = formatCurrentPageResult({
    title: 'T',
    url: 'u',
    text: '正文',
    chunks: ['正文'],
    visReport: '报告',
    visibleOnly: true,
  });
  assert.match(s, /页面标题：T/);
  assert.match(s, /当前页面正文：\n正文/);
  assert.match(s, /报告/);
  assert.match(s, /去掉 visibleOnly/);
});

test('formatCurrentPageResult: 有核查报告但正文为空时仍可返回核查结论', () => {
  const s = formatCurrentPageResult({ title: 'T', url: 'u', text: '', visReport: '报告', checkTexts: ['甲'] });
  assert.match(s, /报告/);
});

// ---------------------------------------------------------------- 快照体积预算
//
// 实测缺陷：maxText 只约束 text 字段，elements 是另算的。maxText:8000 + maxElements:40
// 产出了 27428 字符的结果 —— 调用方无法预估体积，只能靠 expand_result 翻 4 次页。

/** 造一个接近线上最坏情况的元素描述（长 label + 长 nth-of-type 选择器）。 */
const fatElement = (i) => ({
  ref: 'rf-' + i,
  index: i,
  tag: 'summary',
  role: '',
  type: '',
  label: 'x'.repeat(180),
  selector:
    'div.panel:nth-of-type(1) > div.p-body:nth-of-type(3) > div.msg:nth-of-type(3) > div.agent-flow:nth-of-type(1) > details.agent-step:nth-of-type(2) > summary:nth-of-type(1)',
  rect: { x: 1021, y: 481, width: 545, height: 17 },
  center: { x: 1294, y: 489 },
  inViewport: true,
});

test('trimElementsToBudget: 体积不足预算时一个都不裁', () => {
  const list = [fatElement(1), fatElement(2)];
  const r = trimElementsToBudget(list, 100);
  assert.equal(r.elements.length, 2);
  assert.equal(r.omittedBySize, 0);
});

test('trimElementsToBudget: 超出预算时裁掉尾部并如实报告省略数', () => {
  const list = Array.from({ length: 40 }, (_, i) => fatElement(i + 1));
  const r = trimElementsToBudget(list, 8000);
  assert.ok(r.elements.length < 40, '应当被裁剪');
  assert.equal(r.elements.length + r.omittedBySize, 40, '保留数 + 省略数 = 总数');
  assert.equal(r.elements[0].index, 1, '保留的是前缀（视口优先排序），顺序不能乱');
});

test('trimElementsToBudget: 裁剪后的总体积落在预算内（这正是修复目标）', () => {
  const list = Array.from({ length: 40 }, (_, i) => fatElement(i + 1));
  const textLen = 8000;
  const r = trimElementsToBudget(list, textLen);
  const body = textLen + r.elements.reduce((a, e) => a + JSON.stringify(e).length + 1, 0);
  assert.ok(body <= SNAPSHOT_CHAR_BUDGET + 600, '含固定字段预留仍应受控，实际 ' + body);
  // 修复前同样的输入约 27k
  assert.ok(body < 15000, '实际 ' + body);
});

test('trimElementsToBudget: 单个元素就超预算时仍保留一个（不清空结果）', () => {
  const huge = { label: 'y'.repeat(20000) };
  const r = trimElementsToBudget([huge], 8000);
  assert.equal(r.elements.length, 1);
  assert.equal(r.omittedBySize, 0);
});

test('trimElementsToBudget: 预算随 text 变长而收紧（两者共享同一预算）', () => {
  const list = Array.from({ length: 40 }, (_, i) => fatElement(i + 1));
  const small = trimElementsToBudget(list, 500).elements.length;
  const large = trimElementsToBudget(list, 8000).elements.length;
  assert.ok(large < small, '正文越长，能放下的元素越少：' + large + ' vs ' + small);
});

test('trimElementsToBudget: 脏数据与循环引用安全', () => {
  assert.deepEqual(trimElementsToBudget(null, 0).elements, []);
  assert.deepEqual(trimElementsToBudget('not-an-array', 0).elements, []);
  assert.equal(trimElementsToBudget([{}], -100).elements.length, 1);
  const cyc = {};
  cyc.self = cyc;
  assert.doesNotThrow(() => trimElementsToBudget([cyc], 0));
});

// ---------------------------------------------------------------- 高亮结果文案
//
// 实测缺陷：实现里 .slice(0, 20) 之后再报 texts.length，于是传 25 条会返回
// 「已高亮 20 / 20 处关键信息」——「少做了 5 条」看起来像「全部完成」。

test('formatHighlightResult: 正常情况只报命中数', () => {
  const s = formatHighlightResult({ hit: 8, attempted: 8, requested: 8, limit: 20 });
  assert.equal(s, '已高亮 8 / 8 处关键信息');
});

test('formatHighlightResult: 未找到的条目要列出来', () => {
  const s = formatHighlightResult({ hit: 1, attempted: 2, requested: 2, misses: ['推送完成 ✓'], limit: 20 });
  assert.match(s, /已高亮 1 \/ 2 处/);
  assert.match(s, /未找到 1 条：推送完成 ✓/);
});

test('formatHighlightResult: 超上限时必须写明还剩多少条**未处理**', () => {
  const s = formatHighlightResult({ hit: 20, attempted: 20, requested: 25, limit: 20 });
  assert.match(s, /未处理/);
  assert.match(s, /共收到 25 条/);
  assert.match(s, /5 条/, '必须给出未处理的条数：' + s);
  assert.match(s, /再调用一次 highlight_text/);
  // 关键：这句话绝不能被读成「25 条全做完了」
  assert.ok(!/^已高亮 25/.test(s));
});

test('formatHighlightResult: 未超上限时不得出现「未处理」字样', () => {
  const s = formatHighlightResult({ hit: 3, attempted: 3, requested: 3, limit: 20 });
  assert.ok(!s.includes('未处理'), s);
  assert.ok(!s.includes('超出单次上限'), s);
});

test('formatHighlightResult: 脏数据安全', () => {
  assert.equal(typeof formatHighlightResult(null), 'string');
  assert.equal(typeof formatHighlightResult({ hit: 'x', attempted: -5, requested: NaN, misses: null }), 'string');
});

test('formatCurrentPageResult: 报出正文字数（技能分档要用的锚点）', () => {
  const s = formatCurrentPageResult({ title: 'T', url: 'u', text: '正文', textLength: 7243, chunks: ['正文'] });
  assert.match(s, /正文约 7243 字/, '缺少字数锚点，技能无法按规模分档');
});

test('formatCurrentPageResult: 字数未知时不编造', () => {
  const s = formatCurrentPageResult({ title: 'T', url: 'u', text: '正文', chunks: ['正文'] });
  assert.ok(!/正文约/.test(s), s);
});

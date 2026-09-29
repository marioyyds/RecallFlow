import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, cleanTitle, parseTags, normalizeUrl, detectPlatform, sortItems, formatVisibilityReport, isCspEvalBlockError, composeProgressText, screenshotAttempts, formatScreenshotSummary } from '../lib/shared/utils.js';

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

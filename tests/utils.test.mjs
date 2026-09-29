import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, cleanTitle, parseTags, normalizeUrl, detectPlatform, sortItems, formatVisibilityReport, isCspEvalBlockError, composeProgressText } from '../lib/shared/utils.js';

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

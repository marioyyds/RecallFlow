// tool-results.js：工具结果装配与摘要（纯函数）。
//
// 这组函数决定**模型与调用方看到什么**：错误 code、失败文案、以及页面快照被压缩成的几行摘要。
// 其中 `compactSnapshotSummary` 此前**完全没有测试** —— 而它是模型判断"页面长什么样"的依据。
// 抽成模块的目的就是让它能被直接钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeCdpError, toolError, compactSnapshotSummary } from '../lib/application/agent/tool-results.ts';

test('toolError：统一带 ok:false 与 code，并并入 extra 诊断字段', () => {
  const e = toolError('NO_TARGET', '找不到目标', { selector: '#a' });
  assert.equal(e.ok, false);
  assert.equal(e.code, 'NO_TARGET');
  assert.equal(e.result, '找不到目标');
  assert.equal(e.selector, '#a', 'extra 里的诊断字段要带出去');
});

test('toolError：extra 必须被复制，不得就地改写调用方对象', () => {
  // 调用方常复用同一个字面量；就地改写会造成难查的串扰（同名 code 却带着别处的 selector）。
  const extra = { selector: '#a' };
  const e = toolError('X', 'msg', extra);
  e.selector = '#changed';
  assert.equal(extra.selector, '#a', '不得改写传入的 extra');
});

test('toolError：不传 extra 也要能用', () => {
  const e = toolError('X', 'msg');
  assert.deepEqual(e, { ok: false, code: 'X', result: 'msg' });
});

test('summarizeCdpError：剥掉 CDP 域前缀，保留真正的原因', () => {
  // 前缀（Page.captureScreenshot：）对使用者没有信息量，留着会淹掉原因。
  assert.equal(summarizeCdpError(new Error('Page.captureScreenshot：目标已关闭')), '目标已关闭');
  assert.equal(summarizeCdpError({ message: 'Input.dispatchMouseEvent：超时' }), '超时');
  assert.equal(summarizeCdpError(new Error('普通错误')), '普通错误');
  assert.equal(summarizeCdpError('字符串错误'), '字符串错误');
  // 不得因空值抛
  assert.doesNotThrow(() => summarizeCdpError(null));
});

test('compactSnapshotSummary：空/非法输入返回空串，不抛', () => {
  assert.equal(compactSnapshotSummary(null), '');
  assert.equal(compactSnapshotSummary(undefined), '');
  assert.equal(compactSnapshotSummary('不是对象'), '');
  assert.equal(compactSnapshotSummary(42), '');
});

test('compactSnapshotSummary：标题与 URL 始终输出', () => {
  const out = compactSnapshotSummary({ title: '标题', url: 'https://a.test/' });
  assert.match(out, /页面标题：标题/);
  assert.match(out, /页面URL：https:\/\/a\.test\//);
});

test('compactSnapshotSummary：正文那段必须保留「不能用于判断可见性」的警告', () => {
  // 这是本函数最重要的一句话：正文按 textContent 抽取，**包含已隐藏节点的文字**。
  // 若把警告删掉/简化，模型会据此断言"该元素可见"，而真实页面上它可能 display:none ——
  // 这类误判会直接变成错误结论。
  const out = compactSnapshotSummary({ title: 't', url: 'u', text: '一些正文' });
  assert.match(out, /正文摘要/);
  assert.match(out, /不能用于判断可见性/, '警告文案不得丢失');
});

test('compactSnapshotSummary：正文被压缩并限长（不把整页塞给模型）', () => {
  const long = 'x'.repeat(1000);
  const out = compactSnapshotSummary({ title: 't', url: 'u', text: long });
  const bodyLine = out.split('\n').find((l) => l.includes('正文摘要'));
  // 前缀 + 300 字上限
  assert.ok(bodyLine.length < 400, '正文应限长到 300 字左右，实际 ' + bodyLine.length);
  assert.match(bodyLine, /x{100}x/, '正文内容应保留');
});

test('compactSnapshotSummary：多个空白（含换行）折叠成单空格', () => {
  const out = compactSnapshotSummary({ title: 't', url: 'u', text: 'a\n\n   b\t\tc' });
  assert.match(out, /a b c/);
});

test('compactSnapshotSummary：关键元素最多 8 个，且带 ref 与标签', () => {
  const elements = Array.from({ length: 12 }, (_, i) => ({ ref: 'rf-' + i, label: '标签' + i }));
  const out = compactSnapshotSummary({ title: 't', url: 'u', elements });
  const line = out.split('\n').find((l) => l.includes('关键元素'));
  assert.match(line, /rf-0：标签0/);
  assert.match(line, /rf-7：标签7/, '第 8 个应包含');
  assert.ok(!line.includes('rf-8'), '第 9 个起应被截掉，避免刷屏');
});

test('compactSnapshotSummary：元素无 label 时回落到 placeholder，都没有则只留 ref', () => {
  const out = compactSnapshotSummary({
    title: 't', url: 'u',
    elements: [{ ref: 'rf-1', placeholder: '请输入' }, { ref: 'rf-2' }],
  });
  assert.match(out, /rf-1：请输入/);
  assert.match(out, /rf-2(?!：)/, '无标签时不应出现冒号后缀');
});

test('compactSnapshotSummary：长标签被截到 24 字（避免单个元素占满摘要）', () => {
  const out = compactSnapshotSummary({ title: 't', url: 'u', elements: [{ ref: 'rf-1', label: 'L'.repeat(100) }] });
  const line = out.split('\n').find((l) => l.includes('关键元素'));
  assert.ok(line.length < 60, '标签应被截断，实际行长度 ' + line.length);
});

// 页面命令的**载荷投递**门禁：`result` 必须自带模型需要的数据。
//
// ## 起因（一个真实缺陷，本轮做"表格提取"时发现）
//
// 页面命令走到模型的那条路是 `executePageTool`，它拼给模型的文本**只取 `res.result` 一个字符串**：
//
//     result: (res.result || '已执行页面命令：' + command) + '\n验证：' + verification.reason
//
// 这正是 `docs/tool-design.md §6` 的约定：「result：给模型的描述」。
//
// 但有两个命令把**真正的载荷**放在了别的字段里：
//   · `cmdExtractTable` —— 还原好的对齐网格在 `markdown` / `rows` 字段，`result` 只有一句
//     「4 行 × 4 列（含 4 个合并单元格，已展开对齐）」；
//   · `cmdInspectElement` —— 逐元素的 selector / 祖先链 / 尺寸在 `matches` 字段，
//     `result` 只有 `formatInspectSummary` 的**计数**。
//
// 于是模型**只看到摘要**：表格数据整份丢掉；而"排查广告位藏在哪、该隐藏哪一层"必须知道
// selector 与祖先链 —— 等于把该工具的主要用途废掉了。桥接侧（relay.js:217）同样只取
// `res.result`，所以那些字段**对任何消费者都不可见**，是纯粹的死数据。
//
// 修法就是让 `result` 自带载荷（表格把 markdown 拼进去，inspect 把逐元素明细拼进去）。
// 这条门禁盯住"别再退回摘要"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { formatInspectMatches } from '../lib/shared/utils.js';

const cmdSrc = fs.readFileSync('lib/page/commands.js', 'utf8');
const toolsSrc = fs.readFileSync('lib/assistant/tools.js', 'utf8');

/** 取一个顶层函数的源码体（到下一个顶层 function 为止）。 */
function fnBody(src, name) {
  const re = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm');
  const m = re.exec(src);
  if (!m) return '';
  const rest = src.slice(m.index + m[0].length);
  const next = /^(?:async\s+)?function\s+\w+\s*\(/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

// ---------------------------------------------------------------- 投递机制本身

test('投递给模型的文本只来自 res.result（这是"载荷必须进 result"的前提）', () => {
  // 这条断言把"为什么上面那些约束成立"钉住：只要这个前提变了，
  // 下面几条基于 result 的断言就该重新审视，而不是继续默默通过。
  const body = fnBody(toolsSrc, 'executePageTool');
  assert.match(body, /res\.result/, 'executePageTool 应从 res.result 取文本');
  assert.ok(
    !/res\.(markdown|rows|matches|headers)\b/.test(body),
    'executePageTool 目前**不**读 markdown/rows/matches 等旁路字段 —— 所以那些字段必须并进 result'
  );
});

// ---------------------------------------------------------------- 各命令

test('cmdExtractTable：表格数据必须并进 result（否则模型只收到一句摘要）', () => {
  const body = fnBody(cmdSrc, 'cmdExtractTable');
  assert.ok(body, '应能找到 cmdExtractTable');
  assert.match(body, /formatTableText\(/, '应调用 formatTableText 渲染网格');
  // result 里必须真的拼上 markdown（允许空白差异）
  assert.match(body, /'\\n'\s*\+\s*markdown/, 'result 必须拼上 markdown 正文，而不是只给摘要');
});

test('cmdInspectElement：逐元素明细必须并进 result', () => {
  const body = fnBody(cmdSrc, 'cmdInspectElement');
  assert.ok(body, '应能找到 cmdInspectElement');
  assert.match(body, /formatInspectMatches\(/, 'result 必须拼上逐元素明细（selector / 祖先链 / 尺寸）');
});

test('cmdReadStyles：样式值必须并进 result（同一约定）', () => {
  const body = fnBody(cmdSrc, 'cmdReadStyles');
  assert.ok(body, '应能找到 cmdReadStyles');
  assert.match(body, /formatStylesSummary\(/, 'result 必须带上计算后的样式值');
});

// ---------------------------------------------------------------- 纯函数行为

test('formatInspectMatches：给出模型定位所需的信息（selector + 祖先链 + 可见性）', () => {
  const text = formatInspectMatches([
    {
      selector: '#ad-1',
      tag: 'div',
      visible: true,
      size: { w: 300, h: 250 },
      textLength: 12,
      path: 'body > div#app > aside.ads',
      containsMainContent: true,
    },
    { selector: '.banner', tag: 'div', visible: false, size: { w: 0, h: 0 }, textLength: 0, path: 'body > .banner' },
  ]);
  assert.ok(text.includes('#ad-1'), '应含 selector');
  assert.ok(text.includes('祖先链：body > div#app > aside.ads'), '应含祖先链（"该隐藏哪一层"靠它）');
  assert.ok(text.includes('300×250'), '应含尺寸');
  assert.ok(text.includes('文本 12 字'), '应含文本长度');
  assert.ok(text.includes('疑似含正文'), '触到正文容器要标注（别连带隐藏）');
  assert.ok(text.includes('不可见'), '不可见元素要标注');
});

test('formatInspectMatches：空输入返回空串；缺字段不抛', () => {
  assert.equal(formatInspectMatches([]), '');
  assert.equal(formatInspectMatches(null), '');
  const t = formatInspectMatches([{ selector: '.x' }]);
  assert.ok(t.includes('.x'), '缺字段时至少输出 selector');
  assert.ok(!t.includes('祖先链'), '没有 path 就不该凭空写祖先链');
});

test('这条门禁本身有牙齿：只给摘要、把载荷留在旁路字段必须被判为不合格', () => {
  const re = /'\\n'\s*\+\s*markdown/;
  // 修复前的形态：网格算出来了，但只放在旁路字段里，result 只有一句摘要
  const bad = "const markdown = formatTableText(grid, {});\nreturn { ok: true, markdown, result: '表格：4 行 × 4 列' };";
  assert.ok(!re.test(bad), '只给摘要（载荷在旁路字段）必须被判为不合格');
  // 修复后的形态：同一份 markdown 也被拼进 result，成为**唯一**给模型的文本来源
  const good = "const markdown = formatTableText(grid, {});\nreturn { ok: true, markdown, result: '表格：4 行 × 4 列' + '\\n' + markdown };";
  assert.ok(re.test(good), '把载荷并进 result 应通过');

  // inspect 那一侧同理：必须出现 formatInspectMatches 调用
  assert.ok(!/formatInspectMatches\(/.test(bad), '旧形态不含该调用');
  assert.ok(/formatInspectMatches\(/.test('result: summary + formatInspectMatches(matches)'), '新形态含该调用');
});

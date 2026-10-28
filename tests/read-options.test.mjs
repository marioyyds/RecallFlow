// `inspect_element({ op:"options" })`：读 `<select>` 的选项清单。
//
// ## 起因（真模型探针实测，不是推测）
//
// 任务「选最便宜的那个配送方式」下，模型**只能先写一段 JS**：
//
//     run_javascript({ code:"const s=document.querySelector('#ship');
//                            return Array.from(s.options).map(o=>({value:o.value,label:o.textContent.trim()}));" })
//
// 因为闭合的 `<select>` 里 `<option>` **没有布局盒子**，正文抽取按"不可见"跳过 ——
// `get_page_snapshot` 的正文里**看不到选项文案**（而价格/规格常常只写在选项里）；
// 而 `get_attribute` 只读**属性**，读不了 `outerHTML`。
// 代价是一次 `alwaysRequireApproval` 的高危审批（CSP 严的页面还会直接失败）。
//
// 这与之前补 `op:"styles"` 是同一类缺口：**只读的事就该有只读的工具做**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { formatSelectOptions } from '../lib/shared/format/page-results.ts';
import { INSPECT_OPS } from '../lib/application/agent/page-command-tools.ts';

const cmdSrc = fs.readFileSync('lib/application/page/commands/read.ts', 'utf8');
const schemaSrc = fs.readFileSync('lib/application/agent/tool-schemas.ts', 'utf8');

/** 取一个顶层函数的源码体（到下一个顶层 function 为止）。 */
function fnBody(src, name) {
  const re = new RegExp('^(?:export\\s+)?(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm');
  const m = re.exec(src);
  if (!m) return '';
  const rest = src.slice(m.index + m[0].length);
  const next = /^(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

test('INSPECT_OPS 把 options 映射到 read_options', () => {
  assert.equal(INSPECT_OPS.options, 'read_options');
  // 其余几档不能被这次改动挤掉
  assert.deepEqual(Object.keys(INSPECT_OPS).sort(), ['inspect', 'options', 'query', 'styles', 'table', 'text']);
});

test('schema 的 op 枚举必须包含 options（否则模型根本传不进来）', () => {
  const m = /enum: \[([^\]]*)\][\s\S]{0,200}?看什么：/.exec(schemaSrc);
  assert.ok(m, '应能找到 inspect_element 的 op 枚举（enum 后面紧跟"看什么："那段说明）');
  assert.ok(m[1].includes("'options'"), 'op 枚举里要有 options');
});

test('formatSelectOptions：value / 文字 / 当前选中 / 禁用 都要给出来', () => {
  const text = formatSelectOptions([
    { value: '', label: '请选择', selected: true, disabled: false },
    { value: 'std', label: '标准配送 · ¥8 · 3-5 天', selected: false, disabled: false },
    { value: 'eco', label: '经济配送 · ¥5 · 7 天', selected: false, disabled: true },
  ]);
  assert.match(text, /value="std"/);
  assert.match(text, /文字="标准配送 · ¥8 · 3-5 天"/, '显示文本要原样给出（价格就写在这里）');
  assert.match(text, /（当前选中）/, '要标出当前选中项');
  assert.match(text, /（禁用）/, '禁用的选项要标出来 —— 否则模型会去选一个选不了的');
  // 顺序必须与 DOM 一致：index 是 select_option({index}) 的依据
  assert.ok(text.indexOf('请选择') < text.indexOf('标准配送'), '顺序要按 DOM 顺序');
});

test('formatSelectOptions：空输入返回空串；缺字段不抛', () => {
  assert.equal(formatSelectOptions([]), '');
  assert.equal(formatSelectOptions(null), '');
  assert.doesNotThrow(() => formatSelectOptions([{ value: null, label: null }]));
  assert.match(formatSelectOptions([{ value: null, label: null }]), /value=""/);
});

test('cmdReadOptions：文本必须并进 result（否则模型只看到一句"共 N 项"）', () => {
  const body = fnBody(cmdSrc, 'cmdReadOptions');
  assert.ok(body, '应能找到 cmdReadOptions');
  // 载荷投递规则（docs/tool-design.md §6）：executePageTool 只把 res.result 交给模型
  assert.match(body, /const optionsText = formatSelectOptions\(items\)/, '要先算出选项文本');
  const resultAt = body.indexOf('result:');
  assert.ok(resultAt > -1, '要有 result 字段');
  assert.ok(
    body.slice(resultAt).includes('optionsText'),
    'result 里必须用上那份文本 —— 只报"共 N 项"就是载荷没投递'
  );
  assert.match(body, /\bitems,/, '结构化 items 也要随返回值给出（需要精确取值时用它）');
});

test('cmdReadOptions：目标不是 select 时要**说清它是什么**，而不是只报"不是 select"', () => {
  const body = fnBody(cmdSrc, 'cmdReadOptions');
  assert.match(body, /SELECT/, '要判断标签名');
  assert.match(body, /describeTargetState\(el\)/, '要带上实际元素的状态，模型才知道该换哪个目标');
  assert.match(body, /op:"text"/, '要指个明路：读别的元素文字用 op:"text"');
});

test('这条门禁本身有牙齿：把载荷留在旁路字段必须被判为不合格', () => {
  // 修复前的形态（假如有人这么写）：只给摘要，items 放在旁路
  const bad = "return { ok: true, count: all.length, items, result: '下拉框共 ' + all.length + ' 项' };";
  assert.ok(!/formatSelectOptions\(items\)[\s\S]{0,80}result|result:[\s\S]{0,200}formatSelectOptions\(items\)/.test(bad), '只给摘要应判不合格');
  const good = "return { ok: true, items, result: '共 N 项：\\n' + formatSelectOptions(items) };";
  assert.match(good, /result:[\s\S]{0,200}formatSelectOptions\(items\)/, '并进 result 应通过');
});

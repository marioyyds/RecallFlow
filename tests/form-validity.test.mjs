// `inspect_element({op:"inspect"})` 必须报出**没通过 HTML5 校验**的表单字段。
//
// ## 起因（真模型探针实测）
//
// 页面靠 HTML5 原生校验拦住提交时，**页面上什么都不说**：
// 浏览器只在**自己的原生气泡**里提示（工具读不到），DOM 里既没有错误文案、状态也不变。
// 实测模型为此换了 **8 次调用**四处找原因（read_current_page ×2 / read_diagnostics /
// inspect_element ×2 / get_ax_snapshot / get_page_snapshot），
// 还**借道 run_javascript 自己扫 DOM**（一次高危审批）才勉强猜出来。
//
// 而它最早、最自然的那个动作就是 `inspect_element({op:"inspect", selector:"body"})` ——
// 只要那一步能回答，后面全都不必发生。所以这一档补在 **inspect** 上（不是新开 op：
// 那样要动枚举、指纹、三处映射门禁与 prompt 预算，而模型本来就会调 inspect）。
//
// ## 另一个真坑（在夹具上实测出来的）
//
// **`minlength` 对程序化填值不生效**：按规范 `tooShort` 需要用户输入产生的"脏值标记"，
// 而工具是 `setNativeValue` + 派发 input 事件写值的，不会让它变脏。
// 实测：`pattern` / `required` 空值 / `type=email` 都照常生效，只有 `minlength` 不生效 ——
// 所以一个只用 `minlength` 的表单**拦不住 agent**，拿它做夹具则**什么都没验**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { formatInvalidControls } from '../lib/shared/utils.ts';

const cmdSrc = fs.readFileSync('lib/page/command-read.ts', 'utf8');

/** 取一个顶层函数的源码体（到下一个顶层 function 为止）。 */
function fnBody(src, name) {
  const re = new RegExp('^(?:export\\s+)?(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm');
  const m = re.exec(src);
  if (!m) return '';
  const rest = src.slice(m.index + m[0].length);
  const next = /^(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/m.test(rest) ? rest.search(/^(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/m) : -1;
  return next > 0 ? rest.slice(0, next) : rest;
}

test('formatInvalidControls：给出定位、字段名、**与语言无关的约束名**、以及原文提示', () => {
  const text = formatInvalidControls([
    { selector: '#name', name: '姓名', reasons: ['patternMismatch'], message: 'Please match the requested format.', value: '李' },
    { selector: '#email', name: '邮箱', reasons: ['typeMismatch'], message: "Please include an '@'…", value: 'lilei#example.com' },
  ]);
  assert.match(text, /#name/, '要给定位用的 selector');
  assert.match(text, /姓名/, '要给字段名');
  assert.match(text, /patternMismatch/);
  assert.match(text, /typeMismatch/);
  // 必须点明"提交会被拦住、页面上没有提示"——否则模型仍会把"没反应"当成故障
  assert.match(text, /提交会被浏览器拦住/, '要解释为什么页面上看不到反应');
  assert.match(text, /表单未通过校验/, '要有明确结论');
});

test('formatInvalidControls：全部通过时返回空串（不给每次 inspect 都塞一段废话）', () => {
  assert.equal(formatInvalidControls([]), '');
  assert.equal(formatInvalidControls(null), '');
  assert.equal(formatInvalidControls(undefined), '');
});

test('collectInvalidControls：约束名必须来自 validity 的固定键集，且带上原生提示', () => {
  const body = fnBody(cmdSrc, 'collectInvalidControls');
  assert.ok(body, '应能找到 collectInvalidControls');
  // 语言无关的键：这些是 spec 定的，不随浏览器语言变
  for (const k of ['valueMissing', 'typeMismatch', 'patternMismatch', 'tooShort', 'rangeUnderflow', 'customError']) {
    assert.match(body, new RegExp(k), '约束集里应包含 ' + k);
  }
  assert.match(body, /validationMessage/, '要一并给出浏览器原文提示（给人看）');
  assert.match(body, /querySelectorAll\('input, select, textarea'\)/, '要能查容器**内部**的字段，而不只是匹配元素本身');
});

test('inspect 的结果里必须**并进 result**（载荷投递约定：模型只读得到 result 文本）', () => {
  const body = fnBody(cmdSrc, 'cmdInspectElement');
  assert.match(body, /formatInvalidControls\(invalid\)/, '要调用格式化函数');
  const resultAt = body.indexOf('result:');
  assert.ok(resultAt > -1, '要有 result 字段');
  assert.ok(body.slice(resultAt).includes('formatInvalidControls'), 'result 里必须用上它 —— 否则等于没给');
  assert.match(body, /invalidControls:/, '结构化字段也要随返回值给出');
});

test('这条门禁本身有牙齿：把载荷留在旁路字段必须被判为不合格', () => {
  const bad = "return { ok: true, invalidControls: invalid, result: '已列出元素' };";
  assert.ok(!/result:[\s\S]{0,200}formatInvalidControls/.test(bad), '只放旁路字段应判不合格');
  const good = "return { ok: true, invalidControls: invalid, result: '列出：…' + formatInvalidControls(invalid) };";
  assert.match(good, /result:[\s\S]{0,200}formatInvalidControls/, '并进 result 应通过');
});

// verify-change 单元测试：断言语义与失败信息。
// 断言语义最容易写错，尤其「元素不存在」与「count:0」的区别，这里逐条钉死。
//
// **state 的形状是核对过的**（不是编的）：checkTarget 读
//   found / count / text / value / box / styles / selector / tag / visible
// 而真实产出方（lib/page/commands.js 的 readElementState）给的是
//   { selector, tag, visible, text, box:{x,y,w,h}, value?, styles? }
// 加上调用方补的 found / count。两边的字段名逐个对过，一致。
// （教训：tests/tool-results.test.mjs 里我曾给 get_picked_element 编过一个形状，
//   那条测试能过却什么都没钉住。所以这类"输入从哪来"要落成注释。）
import test from 'node:test';
import assert from 'node:assert/strict';

import { checkTarget, evaluateTargets, normalizeText } from '../lib/shared/verify-change.js';

const found = (over = {}) =>
  Object.assign({ found: true, count: 1, visible: true, text: '提交', box: { x: 0, y: 0, w: 100, h: 40 } }, over);
const missing = (over = {}) => Object.assign({ found: false, count: 0, visible: false, text: '' }, over);

test('normalizeText: 折叠空白并去首尾', () => {
  assert.equal(normalizeText('  a   b \n c '), 'a b c');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
});

test('checkTarget: 未提供 expect 时默认断言元素存在', () => {
  const ok = checkTarget({ selector: '#a' }, found());
  assert.equal(ok.pass, true);
  assert.equal(ok.checks.length, 1);
  assert.equal(ok.checks[0].name, 'present');

  const bad = checkTarget({ selector: '#a' }, missing());
  assert.equal(bad.pass, false);
  assert.ok(bad.reason.includes('未找到元素'), bad.reason);
  // 失败信息必须给出替代路径（docs/tool-design.md 的规范）
  assert.ok(bad.reason.includes('get_element_source'), bad.reason);
});

test('checkTarget: absent:true 等价于 present:false', () => {
  const ok = checkTarget({ selector: '.gone', expect: { absent: true } }, missing());
  assert.equal(ok.pass, true);
  assert.equal(ok.checks[0].name, 'present');
  assert.equal(ok.checks[0].expected, false);

  const bad = checkTarget({ selector: '.gone', expect: { absent: true } }, found());
  assert.equal(bad.pass, false);
});

test('checkTarget: count:0 在元素不存在时必须通过（关键反例）', () => {
  // 「断言元素已消失」是最常见的误判点：不能因为 found=false 就判失败。
  const out = checkTarget({ selector: '.loading', expect: { count: 0 } }, missing());
  assert.equal(out.pass, true);
  assert.equal(out.checks.length, 1);
  assert.equal(out.checks[0].name, 'count');
  assert.equal(out.checks[0].actual, 0);
});

test('checkTarget: count 支持精确值与区间', () => {
  assert.equal(checkTarget({ selector: 'li', expect: { count: 3 } }, found({ count: 3 })).pass, true);
  assert.equal(checkTarget({ selector: 'li', expect: { count: 3 } }, found({ count: 4 })).pass, false);
  assert.equal(checkTarget({ selector: 'li', expect: { count: { min: 2, max: 3 } } }, found({ count: 2 })).pass, true);
  assert.equal(checkTarget({ selector: 'li', expect: { count: { min: 2, max: 3 } } }, found({ count: 4 })).pass, false);
  assert.equal(checkTarget({ selector: 'li', expect: { count: { max: 5 } } }, found({ count: 1 })).pass, true);
});

test('checkTarget: text 做空白归一化后的包含匹配', () => {
  const out = checkTarget({ selector: '#a', expect: { text: '已 提交' } }, found({ text: '  已   提交  ' }));
  assert.equal(out.pass, true, JSON.stringify(out.checks));
});

test('checkTarget: text 不匹配时返回期望与实际值', () => {
  const out = checkTarget({ selector: '#submit', expect: { text: '已提交' } }, found({ text: '提交' }));
  assert.equal(out.pass, false);
  assert.ok(out.reason.includes('已提交'), out.reason);
  assert.ok(out.reason.includes('提交'), out.reason);
  assert.ok(out.reason.includes('#submit'), out.reason);
});

test('checkTarget: textEquals 是精确匹配', () => {
  assert.equal(checkTarget({ selector: '#a', expect: { textEquals: '提交' } }, found({ text: ' 提交 ' })).pass, true);
  assert.equal(checkTarget({ selector: '#a', expect: { textEquals: '提交' } }, found({ text: '已提交' })).pass, false);
});

test('checkTarget: 元素不存在但断言了 text，必须失败并说明元素不存在', () => {
  const out = checkTarget({ selector: '#a', expect: { text: 'x' } }, missing());
  assert.equal(out.pass, false);
  const textCheck = out.checks.find((c) => c.name === 'text');
  assert.equal(textCheck.actual, '元素不存在');
  assert.equal(textCheck.ok, false);
});

test('checkTarget: visible 断言', () => {
  assert.equal(checkTarget({ selector: '#a', expect: { visible: true } }, found({ visible: true })).pass, true);
  assert.equal(checkTarget({ selector: '#a', expect: { visible: true } }, found({ visible: false })).pass, false);
  assert.equal(checkTarget({ selector: '#a', expect: { visible: false } }, found({ visible: false })).pass, true);
});

test('checkTarget: value 断言针对输入框', () => {
  assert.equal(checkTarget({ selector: 'input', expect: { value: 'abc' } }, found({ value: 'xabcx' })).pass, true);
  assert.equal(checkTarget({ selector: 'input', expect: { value: 'abc' } }, found({ value: 'xyz' })).pass, false);
  // 无 value 字段时按空串处理，不崩溃
  assert.equal(checkTarget({ selector: 'input', expect: { value: '' } }, found()).pass, true);
});

test('checkTarget: minWidth / minHeight 基于盒模型', () => {
  assert.equal(checkTarget({ selector: '#a', expect: { minWidth: 90 } }, found({ box: { w: 100, h: 40 } })).pass, true);
  assert.equal(checkTarget({ selector: '#a', expect: { minWidth: 120 } }, found({ box: { w: 100, h: 40 } })).pass, false);
  assert.equal(checkTarget({ selector: '#a', expect: { minHeight: 30 } }, found({ box: { w: 100, h: 40 } })).pass, true);
  assert.equal(checkTarget({ selector: '#a', expect: { minHeight: 50 } }, found({ box: { w: 100, h: 40 } })).pass, false);
});

test('checkTarget: styles 断言逐属性包含匹配', () => {
  const state = found({ styles: { display: 'none', color: 'rgb(255, 0, 0)' } });
  assert.equal(checkTarget({ selector: '#a', expect: { styles: { display: 'none' } } }, state).pass, true);
  assert.equal(checkTarget({ selector: '#a', expect: { styles: { color: 'rgb(255, 0, 0)' } } }, state).pass, true);
  const bad = checkTarget({ selector: '#a', expect: { styles: { display: 'block' } } }, state);
  assert.equal(bad.pass, false);
  assert.equal(bad.checks[0].name, 'style:display');
});

test('checkTarget: 多条断言全通过才算通过', () => {
  const state = found({ text: '已提交', visible: true, count: 1 });
  const ok = checkTarget({ selector: '#a', expect: { present: true, visible: true, count: 1, text: '已提交' } }, state);
  assert.equal(ok.pass, true);
  assert.equal(ok.checks.length, 4);
  const bad = checkTarget({ selector: '#a', expect: { visible: true, text: '未提交' } }, state);
  assert.equal(bad.pass, false);
});

test('checkTarget: label 缺省时回退为定位描述', () => {
  assert.equal(checkTarget({ selector: '#a' }, found()).label, '选择器 #a');
  assert.equal(checkTarget({ role: 'button', name: '登录' }, found()).label, 'role=button name=登录');
  assert.equal(checkTarget({ testid: 'x' }, found()).label, 'testid x');
  assert.equal(checkTarget({ label: '提交按钮', selector: '#a' }, found()).label, '提交按钮');
  assert.equal(checkTarget({}, found()).label, '未提供定位方式');
});

test('checkTarget: 观测值原样回传，便于人工核对', () => {
  const state = found({ selector: 'button#s', tag: 'button', text: '提交', value: 'v', styles: { display: 'block' } });
  const out = checkTarget({ selector: '#s' }, state);
  assert.equal(out.observed.selector, 'button#s');
  assert.equal(out.observed.tag, 'button');
  assert.equal(out.observed.text, '提交');
  assert.equal(out.observed.value, 'v');
  assert.deepEqual(out.observed.styles, { display: 'block' });
});

test('evaluateTargets: 汇总通过数与失败数', () => {
  const targets = [
    { selector: '#a', expect: { text: 'ok' } },
    { selector: '#b', expect: { text: 'nope' } },
    { selector: '#c', expect: { count: 0 } },
  ];
  const states = [found({ text: 'ok' }), found({ text: 'other' }), missing()];
  const out = evaluateTargets(targets, states);
  assert.equal(out.results.length, 3);
  assert.equal(out.passed, 2);
  assert.equal(out.failed, 1);
  assert.ok(out.summary.includes('2 / 3'), out.summary);
});

test('evaluateTargets: 目标多于观测值时按未找到处理，不越界', () => {
  const out = evaluateTargets([{ selector: '#a' }, { selector: '#b' }], [found()]);
  assert.equal(out.results.length, 2);
  assert.equal(out.passed, 1);
  assert.equal(out.failed, 1);
});

test('evaluateTargets: 空目标给出可操作提示', () => {
  const out = evaluateTargets([], []);
  assert.equal(out.passed, 0);
  assert.equal(out.failed, 0);
  assert.ok(out.summary.includes('dev_session_set'), out.summary);
});

test('evaluateTargets: 全部通过时的文案', () => {
  const out = evaluateTargets([{ selector: '#a' }], [found()]);
  assert.equal(out.failed, 0);
  assert.ok(out.summary.includes('全部 1 个目标验证通过'), out.summary);
});

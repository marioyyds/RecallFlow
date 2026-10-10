// 定位参数的门禁：**schema 承诺的定位方式，页面命令必须真的用上**。
//
// 起因是一个真缺陷（本轮实测）：
//   `type_text` 的 schema 声明了 role / name / testid / index / text 五个定位参数，
//   而页面命令走 `firstTarget(params, false)` —— 那个函数只转发 ref 与 selector，
//   把五个语义定位符**全部丢掉**。
// 后果不是报错，而是**误导**：模型按说明写了 `type_text({role:'textbox', name:'站内搜索'})`，
// 收到的是「未找到可输入的目标元素」——读起来像"页面上没有这个输入框"，
// 实际是**根本没按这个条件去找**。模型于是换参数乱试或直接告诉用户做不到。
//
// 同一类问题还有第二个面：`cmdClick` 直接传 `findElementsFor(params)`，所以
// "点按钮能用语义定位、填输入框不能" —— 同一个页面里行为不一致，很难从现象反推原因。
//
// 这条门禁钉两件事：① firstTarget 转发全部定位符；② 谁丢弃了 text 必须是显式白名单。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CMD_SRC = 'lib/page/commands.js';
const SCHEMA_SRC = 'lib/assistant/tool-schemas.js';

const cmdSrc = fs.readFileSync(CMD_SRC, 'utf8');

/** 取一个函数的源码体（到下一个顶层 function 为止）。 */
function fnBody(src, name) {
  const re = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm');
  const m = re.exec(src);
  if (!m) return '';
  const rest = src.slice(m.index + m[0].length);
  const next = /^(?:async\s+)?function\s+\w+\s*\(/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

test('firstTarget 必须转发全部语义定位符（本轮修的真缺陷）', () => {
  const body = fnBody(cmdSrc, 'firstTarget');
  assert.ok(body, '应能找到 firstTarget');
  // 这六个字段是 findElementsFor 支持的全集（少一个就有一类"按说明写却找不到元素"）
  for (const field of ['ref', 'role', 'name', 'testid', 'selector', 'index']) {
    assert.match(
      body,
      new RegExp('source\\.' + field + '\\b'),
      'firstTarget 必须转发 ' + field + ' —— 否则 schema 里声明的这种定位方式会静默失效'
    );
  }
});

test('丢弃 text 定位的命令必须在白名单里，且理由成立', () => {
  // 白名单理由：这两个工具的 schema **不**把 text 声明为定位符，
  // 因此不转发 text 不会造成"承诺了却做不到"。
  // 若将来给它们的 schema 加了 text 定位符，这条断言会失败，提醒同步。
  const KNOWN_DROP_TEXT = new Map([
    ['cmdPressKey', 'press_key'],
    ['cmdSelectOption', 'select_option'],
  ]);

  const callers = [...cmdSrc.matchAll(/firstTarget\(params,\s*false\)/g)].map((m) => {
    // 找到该调用点所属的 cmd 函数
    const before = cmdSrc.slice(0, m.index);
    const fns = [...before.matchAll(/^(?:async\s+)?function\s+(cmd\w+)\s*\(/gm)];
    return fns.length ? fns[fns.length - 1][1] : '?';
  });
  assert.ok(callers.length > 0, '应能找到丢弃 text 的调用点（为 0 说明正则失效，门禁会空转通过）');

  const unexpected = callers.filter((c) => !KNOWN_DROP_TEXT.has(c));
  assert.deepEqual(
    unexpected,
    [],
    '这些命令丢弃了 text 定位却不在白名单里：' + unexpected.join(', ') +
      '\n若它们对应的工具 schema 声明了 text 作为定位符，那就是"承诺了却做不到"的缺陷。'
  );

  // 白名单里的工具，其 schema 确实不该声明 text 定位符 —— 否则白名单理由不成立
  const schemaSrc = fs.readFileSync(SCHEMA_SRC, 'utf8');
  const propsOf = (tool) => {
    const at = schemaSrc.indexOf("name: '" + tool + "'");
    if (at < 0) return '';
    const seg = schemaSrc.slice(at, at + 3000);
    const p = seg.indexOf('properties:');
    if (p < 0) return '';
    // ⚠ 必须在 `required:` 处截断：不截断的话会把**下一个工具**的 properties 一起吞进来，
    // 于是"下一个工具有 text 定位符"会被误算到本工具头上（实测踩过一次）。
    const end = seg.indexOf('required:', p);
    return seg.slice(p, end < 0 ? p + 1200 : end);
  };
  for (const [cmd, tool] of KNOWN_DROP_TEXT) {
    const props = propsOf(tool);
    assert.ok(props, '应能找到 ' + tool + ' 的 properties');
    assert.ok(!/\btext:\s*\{/.test(props), cmd + ' 的白名单理由不成立：' + tool + ' 的 schema 声明了 text 定位符');
  }
});

test('定位解析只有两个入口，不允许再出现第三个"重新拼参数"的地方', () => {
  // 本次缺陷的形态就是"另建了一个只含部分字段的 target 对象"。
  // 页面命令解析目标应当只有两条路：直接 findElementsFor(params)，或经 firstTarget 转发。
  const stripped = [...cmdSrc.matchAll(/const\s+target\s*=\s*\{/g)];
  assert.equal(
    stripped.length,
    1,
    'commands.js 里只应有一处构造 target 对象（就是 firstTarget 内部）；多出来的地方很可能又在丢字段'
  );
});

test('这条门禁本身有牙齿：漏掉一个定位符必须被发现', () => {
  // 用内联样例验证判定逻辑。
  const good = 'const target = { ref: source.ref, role: source.role, name: source.name, testid: source.testid, selector: source.selector, index: source.index };';
  const bad = 'const target = { ref: source.ref, selector: source.selector };';
  const hasAll = (s) => ['ref', 'role', 'name', 'testid', 'selector', 'index'].every((f) => new RegExp('source\\.' + f + '\\b').test(s));
  assert.equal(hasAll(good), true, '完整转发应通过');
  assert.equal(hasAll(bad), false, '只转发 ref/selector 必须被判为不合格（这正是修复前的形态）');
});

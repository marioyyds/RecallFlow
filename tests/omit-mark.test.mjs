// A4：省略说明必须是**一眼可辨的元信息**，不能长得像数据。
//
// ## 真实的误判经过（这条用例的由来）
//
// 用户会话的导出里有这样一行：
//
//     read_current_page {"checkTexts":["第193话","第194话","第195话","…共 6 项"]}
//
// 我先判断成"**模型把省略标记当成参数传了**"✗ 后来又怀疑是 `debug-hook.js` 的参数缩写 ✗
// **两次都错**：真正生成它的是**导出渲染器自己** —— `previewArgsJson` 把过长数组截断后，
// 把 `…共 N 项` 作为一个**数组元素**塞了进去。模型从头到尾没传过这个标记。
//
// 教训有两条：
//   · 元信息不能与内容**同形**（这条用例的主角）；
//   · 诊断时别急着归因给"模型乱来"—— 渲染层自己也会造出看起来像数据的东西。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { previewArgsJson, formatOmittedItems, OMIT_MARK_START, OMIT_MARK_END, OMIT_ARGS_KEY, serializeConversationMessages } from '../lib/ui/page/transcript.ts';

const debugHookSrc = fs.readFileSync('lib/adapters/page/debug-hook.ts', 'utf8');
const transcriptSrc = fs.readFileSync('lib/ui/page/transcript.ts', 'utf8');

test('① 省略标记用可辨形态，且**不**长得像普通数组元素', () => {
  const mark = formatOmittedItems(6);
  assert.equal(mark, '⟨…省略 6 项⟩');
  assert.ok(mark.startsWith(OMIT_MARK_START) && mark.endsWith(OMIT_MARK_END));
  assert.ok(!/^\.\.\.共|^…共/.test(mark), '不能再用"像数据的"旧形态');
});

test('② previewArgsJson：截断后的参数仍是**合法 JSON**，且省略标记可辨', () => {
  const args = { checkTexts: ['第193话', '第194话', '第195话', '第196话', '第197话', '第198话'] };
  const out = previewArgsJson(args, 400);
  const parsed = JSON.parse(out); // 必须仍可解析（这是本函数存在的理由）
  const arr = parsed.checkTexts;
  assert.ok(Array.isArray(arr));
  assert.equal(arr[arr.length - 1], '⟨…省略 6 项⟩', '末尾那个应当是**可辨的**省略标记');
  // 反例形态：旧的写法看起来就是一个真实元素
  assert.ok(!arr.includes('…共 6 项'), '不该再出现与数据同形的旧标记');
});

test('③ 这条门禁本身有牙齿：旧形态会被抓（说明用例真的在盯形态）', () => {
  // 直接构造旧实现会产出的那一行
  const legacy = JSON.stringify({ checkTexts: ['甲', '乙', '丙', '…共 6 项'] });
  const arr = JSON.parse(legacy).checkTexts;
  assert.ok(arr.includes('…共 6 项'), '旧形态确实存在于数组里、与真实元素同形 —— 这就是要修的问题');
  assert.ok(
    !arr.some((x) => typeof x === 'string' && x.startsWith(OMIT_MARK_START)),
    '旧实现里没有可辨标记 → 上面的断言若换成"必须有可辨标记"就会红'
  );
});

test('④ debug-hook（MAIN world 裸脚本，不能 import）必须用**同一形态**——两处一致有门禁', () => {
  // 它插入的是被序列化的**控制台数据**：数组里 push 一项、对象里加一个键，
  // 同样必须一眼看出是元信息。
  assert.match(debugHookSrc, /⟨…省略 ' \+ v\.length \+ ' 项⟩/, '数组省略标记要用可辨形态');
  assert.match(debugHookSrc, /⟨…省略字段⟩/, '对象省略键也要用可辨形态');
  assert.ok(!/arr\.push\('…共 ' \+ v\.length/.test(debugHookSrc), '不该残留旧形态');
  // 同源：两处的标记起始串必须一致（跨文件一致性门禁）
  assert.match(transcriptSrc, /OMIT_MARK_START = '⟨…省略 '/, 'transcript.js 是形态的权威定义');
  assert.ok(debugHookSrc.includes('⟨…省略 '), 'debug-hook 必须用同一字面量');
});

test('⑤ 省略标记不会被误当成字段名（**两个**渲染器都要扫）', () => {
  // 旧写法 `out['…'] = '共 N 个字段'` 里，键名 `…` 看起来像一个真实字段名
  assert.ok(!/out\['…'\]\s*=/.test(debugHookSrc), 'debug-hook 不该再用 `…` 当键名');
  // ⚠ 上面这条以前**只扫了 debug-hook**：同一个坑在本文件（导出渲染器）里还留着 ——
  // clipPart 把整个 args 换成 `{ '…': '参数过长（945 字符），已省略' }`，
  // 键名与真实参数名同形；previewArgsJson 退化时也一样。收口时才发现（漏扫 = 门禁没牙齿）。
  assert.ok(!/\{\s*'…':/.test(transcriptSrc), 'transcript.js 不该再用 `…` 当键名');
  assert.match(transcriptSrc, /OMIT_ARGS_KEY/, '退化说明要共用统一的元信息键名常量');
});

test('⑥ 参数太长被整段替换时，键名必须是**可辨的元信息**，且要说清原文取不回', () => {
  // 行为面：走真实的序列化入口（clipPart 那条路）
  const args = { a: 'z'.repeat(600), b: 'y'.repeat(600) };
  const ser = serializeConversationMessages([{ role: 'assistant', parts: [{ type: 'tool-call', name: 'read_current_page', args }] }]);
  const parsed = JSON.parse(JSON.stringify(ser[0].parts[0].args));
  const keys = Object.keys(parsed);
  assert.equal(keys.length, 1, '应当只剩一条说明，实际：' + JSON.stringify(parsed));
  assert.equal(keys[0], OMIT_ARGS_KEY, '键名要用统一常量，不能是 `…`');
  assert.ok(keys[0].startsWith('⟨'), '键名要落在一眼可辨的元信息形态族里');
  assert.match(String(parsed[keys[0]]), /取不回/, '原文没有留存 ⇒ 必须明说取不回（A5 判据）');

  // 行为面：previewArgsJson 的"退化为字段名列表"那条路
  const long = { a: 'x'.repeat(200), b: 'y'.repeat(200), c: 'z'.repeat(200) };
  const degraded = JSON.parse(previewArgsJson(long));
  assert.deepEqual(Object.keys(degraded), [OMIT_ARGS_KEY], '退化时同样是可辨的元信息键名：' + JSON.stringify(degraded));

  // 牙齿：旧形态（键名 `…`）确实会被上面的判据抓住
  const legacy = JSON.parse(JSON.stringify({ '…': '参数过长（945 字符），已省略' }));
  assert.ok(!Object.keys(legacy)[0].startsWith('⟨'), '旧形态的键名 `…` 不满足"可辨" —— 这就是被修掉的缺陷');
});

test('⑦ 正常参数不受影响：键名与内容逐字节保留', () => {
  const args = { texts: ['甲', '乙'], query: '两个空格  也要保留' };
  const ser = serializeConversationMessages([{ role: 'assistant', parts: [{ type: 'tool-call', name: 'x', args }] }]);
  assert.deepEqual(JSON.parse(JSON.stringify(ser[0].parts[0].args)), args, '未超长时一个字节都不许改');
});

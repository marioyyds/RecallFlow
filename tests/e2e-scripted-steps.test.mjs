// 门禁：脚本化剧本（tests/e2e/fixtures/server.mjs 里的 `toolStep(...)`）调的工具与 op
// 必须是**真实存在**的。
//
// 来历（这条门禁就是为它建的）：
//   第 9 轮写「自定义日期选择器」剧本时，最后一步写成
//   `inspect_element({ op: 'value', selector: '#checkin' })` —— 而 `INSPECT_OPS`
//   只有 text / inspect / table / styles / options，**没有 `value`**。
//   于是那一步每次运行都拿到 `BAD_ARGS`（面板上是一个红叉「工具失败」），
//   可那条用例没有任何断言盯着这一步 ⇒ **它一直在失败却没人发现**，
//   直到录 README 的 GIF 时才在画面里看见那个红叉。
//
// 为什么必须做成**源码级**门禁，而不是"再加一条 E2E 断言"：
//   · 这里要防的是一整**类**错误 —— 剧本里写了不存在的工具名或不存在的 op；
//   · 单个用例只能盯住它自己那一步，新写的剧本照样能再犯（这次就是这个情形）；
//   · 而"工具名 / op 有没有"这件事**不需要浏览器**就能判定：它是源码与真实注册表的比对，
//     放在单测里每次 run-all-checks 都会跑，比"再写一条断言"更早、更广。
//
// 覆盖范围与**不覆盖范围**（写清楚，免得被当成万能门禁）：
//   ✓ 工具名是否真实存在（TOOL_SCHEMAS 声明侧 + 注册表分派侧都要有）；
//   ✓ 参数里带 `op:` 时，该 op 是否在该工具**真实的 op 列表**里；
//   ✓ 反自欺：扫描器不许漏调用（对账 `toolStep(` 出现次数）；带 op 的工具必须都被扫到；
//   ✗ 不管参数里的 selector/role/name 是否真能命中页面（那要跑真浏览器，属于 E2E 的事）；
//   ✗ 不管剧本的**顺序/语义**对不对（那是 tests/skill-playbook-contract.test.mjs 的事）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_REGISTRY, registeredToolNames } from '../lib/application/agent/tools.ts';
import { ANNOTATE_OPS, INSPECT_OPS } from '../lib/application/agent/page-command-tools.ts';
import { MACRO_OPS } from '../lib/application/agent/macros.ts';
import { KNOWLEDGE_READ_OPS } from '../lib/application/agent/knowledge.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTED_SOURCE = path.join(HERE, 'e2e', 'fixtures', 'server.mjs');

/**
 * 「带 op 的工具 → 它的真实 op 列表」。
 *
 * **单一来源**：全部从真实模块 import，不在这里另抄一份字符串
 *（抄一份就等于给自己造了个会漂移的第二事实源 —— 门禁会跟着一起错）。
 * 新增一个带 op 的工具时这里必须补一行；漏补会被下面
 * 「带了 op 但没登记 op 列表」那条判为不合格（而不是被静默放过）。
 */
export const OPS_BY_TOOL = Object.freeze({
  annotate: Object.keys(ANNOTATE_OPS),
  inspect_element: Object.keys(INSPECT_OPS),
  macro: [...MACRO_OPS],
  knowledge_read: [...KNOWLEDGE_READ_OPS],
});

/**
 * 要扫描的调用形式：`(callee, 工具名, 参数)` 的位置。
 *
 * `step` 是夹具里的一处**局部包装**
 *（`const step = (n, name, args) => { toolStep(res, name, args); }`，多候选收敛那条剧本用它），
 * 它最终还是走 `toolStep` —— 不把它一起扫，那条剧本的 7 次调用就成了**门禁盲区**。
 */
const CALL_FORMS = Object.freeze([
  { callee: 'toolStep', nameArg: 1, argsArg: 2 },
  { callee: 'step', nameArg: 1, argsArg: 2 },
]);

// ------------------------------------------------------------------ 源码扫描
//
// 为什么不用正则一把梭：剧本里的对象参数**经常跨行**
//（如 `add_entry`、`annotate({op:'style', styles:{...}})`），而正则匹配不了"括号配对"，
// 匹配失败的后果是**静默漏检** —— 正好是这类门禁最不该有的失效方式。
// 所以这里做一遍最小词法扫描：跳过字符串与注释，按括号配对切出每一次调用。

/** 找到 `src[openIdx]`（必须是 ( { [ 之一）对应的闭合括号下标；找不到返回 -1。 */
function matchBracket(src, openIdx) {
  const open = src[openIdx];
  const close = { '(': ')', '{': '}', '[': ']' }[open];
  if (!close) return -1;
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === ch) break;
        i += 1;
      }
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 在**顶层**（不在任何括号/字符串/注释里）按逗号切分。 */
function splitTopLevel(src) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? src.length : nl;
      cur += src.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      cur += src.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) break;
        j += 1;
      }
      cur += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** 取字符串字面量的内容；不是字面量返回 null（=> 门禁会如实说"核对不了"）。 */
function literalOf(text) {
  const m = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*$/.exec(String(text === undefined ? '' : text));
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

/** 在对象字面量的**顶层**找 `op:`，返回 { opPresent, op }。 */
function findTopLevelOp(objText) {
  const t = String(objText || '').trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return { opPresent: false, op: null };
  for (const part of splitTopLevel(t.slice(1, -1))) {
    const m = /^\s*op\s*:\s*([\s\S]+)$/.exec(part);
    if (m) return { opPresent: true, op: literalOf(m[1]) };
  }
  return { opPresent: false, op: null };
}

/** 切出源码里所有剧本步骤调用（含工具名不是字面量的定义/包装体，它们会被单独记账）。 */
export function extractScriptedStepCalls(source) {
  const calls = [];
  for (const form of CALL_FORMS) {
    // 词法边界：`toolStep(` 里也含 `step(`，不加这个负向后顾会重复计数。
    const re = new RegExp('(?<![A-Za-z0-9_$])' + form.callee + '\\(', 'g');
    let m;
    while ((m = re.exec(source)) !== null) {
      const openParen = m.index + form.callee.length;
      const close = matchBracket(source, openParen);
      const line = source.slice(0, m.index).split('\n').length;
      if (close < 0) {
        calls.push({ line, callee: form.callee, name: null, opPresent: false, op: null, raw: '', parseError: '括号不配对' });
        continue;
      }
      const args = splitTopLevel(source.slice(openParen + 1, close));
      calls.push({
        line,
        callee: form.callee,
        name: literalOf(args[form.nameArg]),
        ...findTopLevelOp(args[form.argsArg]),
        raw: source.slice(m.index, close + 1),
        parseError: null,
      });
    }
  }
  return calls.sort((a, b) => a.line - b.line);
}

/**
 * 逐条判定；返回问题列表（空数组 = 合格）。
 *
 * 导出它是为了让"带牙齿"的用例拿**同一份判定逻辑**去喂假源码 ——
 * 若各写一份，牙齿就咬在自己另外造的一套规则上了。
 */
export function findScriptedStepProblems(source) {
  const declared = new Set(TOOL_REGISTRY.map((t) => t.name));
  const dispatched = new Set(registeredToolNames());
  const problems = [];
  for (const call of extractScriptedStepCalls(source)) {
    if (call.parseError) {
      problems.push(`第 ${call.line} 行：${call.callee} 调用无法解析（${call.parseError}）`);
      continue;
    }
    // 工具名不是字面量 ⇒ 是定义/包装体，不计入剧本步骤（由反自欺用例单独记账）。
    if (!call.name) continue;
    if (!declared.has(call.name)) {
      problems.push(`第 ${call.line} 行：工具 '${call.name}' 不在 TOOL_SCHEMAS 声明的工具里`);
    } else if (!dispatched.has(call.name)) {
      problems.push(`第 ${call.line} 行：工具 '${call.name}' 声明了但注册表里没有处理函数（调用会落到"未知工具"）`);
    }
    if (!call.opPresent) continue;
    const allowed = OPS_BY_TOOL[call.name];
    if (!allowed) {
      problems.push(
        `第 ${call.line} 行：'${call.name}' 带了 op: 但本门禁没登记它的 op 列表 —— ` +
          '请把真实 op 列表接进 OPS_BY_TOOL（不要为了过门禁而删掉这条检查）'
      );
      continue;
    }
    if (call.op === null) {
      problems.push(`第 ${call.line} 行：'${call.name}' 的 op 不是字符串字面量，门禁无法核对`);
      continue;
    }
    if (!allowed.includes(call.op)) {
      problems.push(
        `第 ${call.line} 行：'${call.name}' 的 op '${call.op}' 不存在（合法取值：${allowed.join(' / ')}）`
      );
    }
  }
  return problems;
}

// 统一成 LF 再比对：Windows 检出时 Git 会把工作区写成 CRLF，而下面几条"带牙齿"
// 用例用 `\n` 做字面替换。不归一化的话，同一份代码在分支间切换后就会假红
//（实测：合并到 master 后 `git switch` 触发 CRLF 转换，替换全部失效）。
const REAL_SOURCE = fs.readFileSync(SCRIPTED_SOURCE, 'utf8').replace(/\r\n/g, '\n');

// ------------------------------------------------------------------ 用例

test('剧本源码：每一步的工具名与 op 都在真实注册表 / 真实 op 列表里', () => {
  const problems = findScriptedStepProblems(REAL_SOURCE);
  assert.deepEqual(
    problems,
    [],
    '脚本化剧本里有不存在的工具或 op（第 9 轮 inspect_element({op:"value"}) 就是这一类）：\n  ' +
      problems.join('\n  ')
  );
});

test('反自欺：扫描器没有漏掉任何一次调用，且四种带 op 的工具都被扫到', () => {
  // 源码级门禁最经典的失效方式是"正则/扫描什么都没匹配上 ⇒ 问题列表恒空 ⇒ 永远绿"，
  // 那比没有门禁更糟（它会让人以为已经管住了）。这条用例专门钉死这一点。
  const calls = extractScriptedStepCalls(REAL_SOURCE);

  // ① 对账：源码里 `toolStep(` 的字面出现次数 == 扫描到的 toolStep 调用数。
  //    将来谁在注释里写一句 `toolStep(` 也会让这条红 —— 那时来看一眼即可（失败即提示）。
  const rawOccurrences = (REAL_SOURCE.match(/toolStep\(/g) || []).length;
  const scanned = calls.filter((c) => c.callee === 'toolStep').length;
  assert.equal(scanned, rawOccurrences, '有 toolStep 调用没被扫描到（扫描器漏了，门禁会静默放行）');

  // ② 工具名不是字面量的，只允许是这两处**定义/包装体**：
  //    `function toolStep(res, name, args)` 与 `const step = (n,name,args) => { toolStep(res, name, args); }`。
  //    数量一变就红：要么改成字面量，要么在这里写明为什么新的那处核对不了（不许静默放过）。
  const unchecked = calls.filter((c) => !c.name && !c.parseError);
  assert.equal(
    unchecked.length,
    2,
    '出现了新的"工具名不是字面量"的调用，门禁核对不了它：' +
      JSON.stringify(unchecked.map((c) => ({ line: c.line, raw: c.raw.slice(0, 60) })))
  );
  for (const c of unchecked) {
    assert.match(c.raw, /^toolStep\(res, name, args\)/, '预期只有 toolStep 的定义/包装体，实际是：' + c.raw.slice(0, 80));
  }

  // ③ 覆盖量：剧本步骤得有这么多条（数量骤降说明夹具被改坏/被截断）。
  const checked = calls.filter((c) => c.name);
  assert.ok(checked.length >= 150, '被核对的剧本步骤太少（实测 ' + checked.length + '），夹具是不是被改坏了？');

  // ④ 每个登记了 op 列表的工具都必须真的被扫到，否则那条分支形同虚设。
  const opTools = new Set(checked.filter((c) => c.opPresent).map((c) => c.name));
  for (const name of Object.keys(OPS_BY_TOOL)) {
    assert.ok(opTools.has(name), `没有扫到任何 '${name}' 的 op 调用 —— 该分支的核对形同虚设`);
  }
});

test('带牙齿：不存在的 op 会被抓出来（拿真实源码改一处实测，不是只写注释）', () => {
  // 把「日期选择器」那步的合法 op 换成第 9 轮那个不存在的 'value'。
  // ⚠ `#status` 在别的剧本里也出现，所以要用锚点定位到**这一处**，不能取第一处就改。
  const anchor = "name: '3月15日' }); return; }";
  const target = "inspect_element', { op: 'text', selector: '#status' }";
  const anchorAt = REAL_SOURCE.indexOf(anchor);
  assert.ok(anchorAt > 0, '真实源码里找不到日期选择器的点击步骤（改过就同步更新本用例的样本）');
  const at = REAL_SOURCE.indexOf(target, anchorAt);
  assert.ok(at > anchorAt, '日期选择器那步现在不长这样了（改过就同步更新本用例的样本）');
  const fake =
    REAL_SOURCE.slice(0, at) +
    "inspect_element', { op: 'value', selector: '#status' }" +
    REAL_SOURCE.slice(at + target.length);
  assert.notEqual(fake, REAL_SOURCE, '替换没生效 ⇒ 这条用例会变成空转，必须修');

  const problems = findScriptedStepProblems(fake);
  assert.equal(problems.length, 1, '应当且只应当抓到 1 个问题，实际：' + JSON.stringify(problems));
  assert.match(problems[0], /'value' 不存在/);
  assert.match(problems[0], /inspect_element/);
  assert.match(problems[0], /text \/ inspect \/ table \/ styles \/ options/);
});

test('带牙齿：不存在的工具名会被抓出来', () => {
  const fake = REAL_SOURCE.replace(
    "toolStep(res, 'click_element', { selector: '#apply' })",
    "toolStep(res, 'click_elemen', { selector: '#apply' })"
  );
  assert.notEqual(fake, REAL_SOURCE, '替换没生效 ⇒ 空转，必须修');
  const problems = findScriptedStepProblems(fake);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'click_elemen' 不在 TOOL_SCHEMAS 声明的工具里/);
});

test('带牙齿：跨行对象参数里的 op 也扫得到（防止"只认单行"的假门禁）', () => {
  const fake = REAL_SOURCE.replace(
    "toolStep(res, 'annotate', {\n          op: 'style',",
    "toolStep(res, 'annotate', {\n          op: 'stylish',"
  );
  assert.notEqual(fake, REAL_SOURCE, '替换没生效 ⇒ 跨行样本变了，必须同步更新');
  const problems = findScriptedStepProblems(fake);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'annotate' 的 op 'stylish' 不存在/);
});

test('带牙齿：局部包装 step(...) 的调用也在门禁里（不是只盯 toolStep）', () => {
  const fake = REAL_SOURCE.replace(
    "step(19, 'inspect_element', { op: 'text', selector: '#total-p105' })",
    "step(19, 'inspect_element', { op: 'value', selector: '#total-p105' })"
  );
  assert.notEqual(fake, REAL_SOURCE, '替换没生效 ⇒ 多候选收敛那条剧本的包装调用变了，必须同步更新');
  const problems = findScriptedStepProblems(fake);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'inspect_element' 的 op 'value' 不存在/);
});

test('带牙齿：带 op 但没登记 op 列表的工具会被点名（而不是静默放过）', () => {
  const fake = REAL_SOURCE + "\n// probe\ntoolStep(res, 'take_screenshot', { op: 'nope' });\n";
  const problems = findScriptedStepProblems(fake);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /没登记它的 op 列表/);
});

test('OPS_BY_TOOL 与真实模块同源（防止门禁自己抄了一份会漂移的列表）', () => {
  assert.deepEqual(OPS_BY_TOOL.inspect_element, Object.keys(INSPECT_OPS));
  assert.deepEqual(OPS_BY_TOOL.annotate, Object.keys(ANNOTATE_OPS));
  assert.deepEqual(OPS_BY_TOOL.macro, [...MACRO_OPS]);
  assert.deepEqual(OPS_BY_TOOL.knowledge_read, [...KNOWLEDGE_READ_OPS]);
});

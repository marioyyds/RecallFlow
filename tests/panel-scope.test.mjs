// 面板脚本的**作用域门禁**：模块顶层的函数不得调用定义在其它函数内部的函数。
//
// 为什么需要它：这一条抓到过一个真实缺陷 —— 把 `mountThinkSegment` 写在 `openPanel`
// 内部，却在模块级的 `restoreStreamingUI` 里调用。后果是「流式中关闭面板再打开」
// 这条路一走到就 `ReferenceError`（面板恢复直接抛错）。
//
// 它为什么能躲过当时所有检查：
//   · 接线门禁是**源码正则**，只看得到"有没有调用"，看不到"能不能调用"；
//   · E2E 从没在**流式中**重开过面板，那条分支压根没被执行；
//   · `node --check` 只做语法检查，不做作用域解析（这在 JS 里要运行到那一行才会报）。
//
// 这正是本仓库反复出现的形态："看着都对、其实没接上"。所以补一道静态门禁 ——
// 它不完美（只查函数声明之间的调用），但对这个具体的坑是确定性的。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = 'lib/page/chat.js';
// 只认「行首的空格/制表符」——**不能用 \s**：它会把换行也吃掉，
// 于是 `^\s+function X` 能从上一行开始匹配到行首无缩进的 X，误报成"被缩进"。
const FN_RE = /^([ \t]*)(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+([A-Za-z0-9_$]+)/;

/** 收集所有函数声明：行号、缩进、名字。 */
function collectFns(lines) {
  const fns = [];
  lines.forEach((l, i) => {
    const m = l.match(FN_RE);
    if (m) fns.push({ line: i + 1, indent: m[1].length, name: m[2] });
  });
  return fns;
}

/** 函数的外层作用域链（由内到外）。 */
function ownerChain(fns, fn) {
  const chain = [];
  let cur = fn.indent;
  for (let i = fns.indexOf(fn) - 1; i >= 0; i--) {
    if (fns[i].indent < cur) {
      chain.push(fns[i]);
      cur = fns[i].indent;
      if (cur === 0) break;
    }
  }
  return chain;
}

/** 函数体的源码范围（到下一个缩进 <= 自身的函数声明前）。 */
function bodyOf(lines, fns, fn) {
  const next = fns.find((x) => x.line > fn.line && x.indent <= fn.indent);
  return lines.slice(fn.line - 1, (next ? next.line : lines.length + 1) - 1).join('\n');
}

test('面板脚本：函数只能调用自己作用域链上的函数', () => {
  const lines = fs.readFileSync(SRC, 'utf8').split('\n');
  const fns = collectFns(lines);
  assert.ok(fns.length > 10, '应能解析出函数列表（为 0 说明解析规则失效，门禁会空转通过）');

  const chainOf = new Map(fns.map((f) => [f, ownerChain(fns, f)]));
  const offenders = [];
  for (const f of fns) {
    const body = bodyOf(lines, fns, f);
    for (const g of fns) {
      if (g.line === f.line) continue;
      // 模块顶层函数对谁可见？—— 只有同为顶层（或它自己内层）的。
      // 一般规则：g 对 f 可见 ⟺ g 在 f 内部，或 g 与 f 有公共祖先且 g 不在更深的旁支里。
      // 这里只判定确定性的那一类非法：g 在 f **之外**的某个函数内部。
      const gChain = chainOf.get(g);
      const fChain = chainOf.get(f);
      const gInsideF = gChain.includes(f);
      // g 的第一个（最内层）祖先
      const gOwner = gChain[0];
      // g 是顶层，或 g 在 f 内部 → 可见
      if (!gOwner || gInsideF) continue;
      // g 在 f 内层的某个兄弟里？→ 只有当那个兄弟也在 f 内部时才可见
      const ownerInsideF = fChain.length === 0 ? false : gChain.includes(f);
      if (ownerInsideF) continue;
      // 若 f 与 g 同在某个祖先内部，且 g 的祖先不是 f 的后代 → 可见性取决于 g 的祖先是否在 f 内部
      const gOwnerInFChain = fChain.includes(gOwner);
      if (gOwnerInFChain) continue;
      // 到这里：g 定义在某个 f 看不到的地方
      if (new RegExp('\\b' + g.name + '[ \t]*\\(').test(body)) {
        offenders.push(
          f.name + '（缩进 ' + f.indent + '）调用了 ' + g.name + '（在 ' + gOwner.name + ' 内，缩进 ' + g.indent + '）'
        );
      }
    }
  }
  assert.deepEqual(offenders, [], '存在跨作用域调用，运行到那一行会 ReferenceError：\n  ' + offenders.join('\n  '));
});

test('这条作用域门禁本身有牙齿：闭包外的函数被顶层调用时必须被发现', () => {
  const sample = [
    'function outer() {',   // 1 顶层
    '  function inner() {}', // 2 内层
    '  inner();',            // 3 合法：outer 能看到自己的 inner
    '}',
    'function sibling() {',  // 5 顶层
    '  inner();',            // 6 非法：sibling 看不到 outer 的 inner
    '}',
  ].join('\n');
  const lines = sample.split('\n');
  const fns = collectFns(lines);
  const chainOf = new Map(fns.map((f) => [f, ownerChain(fns, f)]));
  const inner = fns.find((f) => f.name === 'inner');
  const outer = fns.find((f) => f.name === 'outer');
  const sibling = fns.find((f) => f.name === 'sibling');
  assert.equal(inner.indent, 2, 'inner 应是内层函数');
  assert.deepEqual(chainOf.get(inner).map((x) => x.name), ['outer'], 'inner 的作用域链应含 outer');
  assert.deepEqual(chainOf.get(outer), [], 'outer 是顶层');
  assert.deepEqual(chainOf.get(sibling), [], 'sibling 是顶层');
  // inner 在 outer 内 → outer 可见；不在 sibling 内 → sibling 不可见
  assert.ok(chainOf.get(inner).includes(outer), 'outer 应能看到 inner');
  assert.ok(!chainOf.get(inner).includes(sibling), 'sibling 不应能"看到" inner');
});

test('思考记录的挂载函数必须在模块顶层（restoreStreamingUI 要用）', () => {
  // 把上面那条真实缺陷钉成具体断言：不怕回归。
  const src = fs.readFileSync(SRC, 'utf8');
  for (const name of ['mountThinkSegment', 'refreshThinkHead']) {
    assert.match(src, new RegExp('^function ' + name + '\\b', 'm'), name + ' 必须是模块顶层函数（行首无缩进）');
    assert.ok(
      !new RegExp('^[ \\t]+function ' + name + '\\b', 'm').test(src),
      name + ' 不得被缩进（缩进即在 openPanel 内部 → 模块级调用会 ReferenceError）'
    );
  }
  // restoreStreamingUI 里确实重新挂载了思考记录（否则恢复这条路径会丢记录）
  const at = src.indexOf('function restoreStreamingUI(');
  assert.ok(at > 0, '应能找到 restoreStreamingUI');
  const body = src.slice(at, at + 3000);
  assert.match(body, /mountThinkSegment\(/, '恢复路径应重新挂载思考记录');
});

// ---------------------------------------------------------------- 变量作用域（与函数作用域分开管）
//
// 上面那条只管**函数**。真实踩到的坑是**变量**：模块级的 restoreStreamingUI() 里写了
// `sendBtn.disabled = ...`，而 `sendBtn` 当时是 openPanel 内的 `const` ⇒ ReferenceError
// ⇒ 面板**半构建**（连 .p-body 都没有，用户看到的是"面板打开了但什么都没有"）。
// 所有静态门禁都看不到它，只有真浏览器里"流式输出中途重开面板"才暴露
//（本轮就是靠新加的 E2E 抓到的）。这条把该类错误变成加载即红。

test('面板脚本：模块级代码不得引用只在 openPanel 内声明的局部变量', () => {
  const lines = fs.readFileSync(SRC, 'utf8').split('\n');
  const fns = collectFns(lines);
  const open = fns.find((f) => f.name === 'openPanel');
  assert.ok(open, '应能找到 openPanel');
  const startIdx = open.line - 1;
  const bodyLines = bodyOf(lines, fns, open).split('\n');
  const endIdx = startIdx + bodyLines.length - 1;

  // ① openPanel 内声明的"元素类"局部变量（最典型的跨作用域误用形态）
  const openLocal = new Set();
  for (const l of bodyLines) {
    const m = l.match(/^[ \t]+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.createElement\(/);
    if (m) openLocal.add(m[1]);
  }
  assert.ok(openLocal.size >= 3, '前置：应识别出若干局部元素变量，实际 ' + openLocal.size);

  // ② 只保留**全文件仅此一处声明**的名字。
  //   为什么必须收紧：泛用名（head / title / text / b / copy…）在同一文件里被声明多次，
  //   逐一按"名字出现"比对会满屏假阳性（第一版实测就是这样红的 ✗）。而"仅此一处声明"
  //   的名字，任何其它出现都**必然是对同一个变量的引用** —— 正是本轮踩到的 `sendBtn` 形态。
  //   这条规则同时免掉了"模块级也声明过"的情况（那会让声明数 ≥ 2）。
  const declCount = new Map();
  for (const l of lines) {
    const m = l.match(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/);
    if (m) declCount.set(m[1], (declCount.get(m[1]) || 0) + 1);
  }
  const risky = [...openLocal].filter((n) => declCount.get(n) === 1);
  assert.ok(risky.length > 0, '前置：应至少留下一个有风险的局部名（否则本门禁空转）');

  // ③ openPanel **之外**（模块级代码）不得出现这些名字
  //    边界规则（要精确，否则会被字符串骗）：名字必须是**独立标识符** ——
  //    前面不能是 `-` 或引号（`'act-copy'` 里的 copy 不是变量）、后面不能跟 `-`/词字符。
  //    第一版用 `\bcopy\b` 就被 `class="act-copy"` 判红了（实测）。
  const outside = lines.filter((_, i) => i < startIdx || i > endIdx);
  const offenders = [];
  for (const n of risky) {
    const re = new RegExp('(^|[^\\w\'"-])' + n + '(?![\\w-])');
    for (const l of outside) {
      if (re.test(l)) offenders.push(n + ' 出现于：' + l.trim().slice(0, 70));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '模块级代码引用了 openPanel 内的局部变量（运行到就是 ReferenceError，面板会半构建）：\n  ' +
      offenders.join('\n  ')
  );
});

test('这条变量作用域门禁本身有牙齿：把局部变量搬去模块级函数用必须被发现', () => {
  const sample = [
    'let shared = null;',                       // 1 模块级共享变量（声明数 2 → 不在风险集里）
    'function topLevel() {',                    // 2 模块级函数
    '  localBtn.disabled = true;',              // 3 非法：localBtn 在 openPanel 内
    '  shared = 1;',                            // 4 合法
    '}',
    'function openPanel() {',                   // 6
    '  const localBtn = document.createElement("button");',  // 7 声明仅此一处
    '  localBtn.disabled = false;',             // 8 合法（在自己作用域内）
    '}',
  ];
  const lines = sample;
  const fns = collectFns(lines);
  const open = fns.find((f) => f.name === 'openPanel');
  const startIdx = open.line - 1;
  const bodyLines = bodyOf(lines, fns, open).split('\n');
  const endIdx = startIdx + bodyLines.length - 1;
  const openLocal = new Set();
  for (const l of bodyLines) {
    const m = l.match(/^[ \t]+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.createElement\(/);
    if (m) openLocal.add(m[1]);
  }
  const declCount = new Map();
  for (const l of lines) {
    const m = l.match(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/);
    if (m) declCount.set(m[1], (declCount.get(m[1]) || 0) + 1);
  }
  const risky = [...openLocal].filter((n) => declCount.get(n) === 1);
  assert.deepEqual(risky, ['localBtn'], '应把 localBtn 判为"仅此一处声明、且在 openPanel 内"');
  const outside = lines.filter((_, i) => i < startIdx || i > endIdx);
  const hits = outside.filter((l) => /(^|[^\w'"-])localBtn(?![-\w])/.test(l));
  assert.equal(hits.length, 1, '模块级那处使用必须被计为违规');
  assert.ok(!/\bshared\b/.test(hits.join('\n')), 'shared 声明了两次（模块级 + 赋值），不该被这条规则抓');
  // 反向样张：字符串里的同名片段不得被当成引用（第一版被 `class="act-copy"` 判红过）
  assert.ok(
    !/(^|[^\w'"-])localBtn(?![-\w])/.test('  return \'<div class="x-localBtn-y"></div>\';'),
    'CSS 类名里的片段不算变量引用'
  );
});

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

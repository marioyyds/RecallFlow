// 变异测试：验证 tests/page-debug-hook.test.mjs 的断言真的能抓住行为退化。
//
// 为什么需要它：本轮就实测出两条「恒真断言」——vm 沙箱里栈帧不带文件名，
// 导致「initiator 不含自身帧」永远通过；`var f = function(){}` 的名字推断
// 又让「具名」断言对某种写法失效。**没有牙齿的测试比没有测试更糟，它制造虚假信心。**
//
// 安全性：变异施加在**临时副本**上，源文件只读不改（中途被打断也不会留下变异版本）。
// 用法：node scripts/mutation-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FILE = 'lib/page/debug-hook.js';
// 统一行尾再做锚点匹配。
// 为什么：本文件是 CRLF，而锚点里的 `\n` 永远匹配不到 `...;\r\n` —— 于是那条变异
// 长期处于「锚点未找到」状态，静默失效（实测）。变异脚本本身失效比测试失效更隐蔽：
// 它输出的是「脚本需随源码更新」，很容易被当成脚本事、而不是「这道闸根本没在工作」。
const original = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');

const MUTATIONS = [
  {
    name: '把 fetch 包装内联成匿名函数（页面栈里会显示成 window.fetch）',
    from: '    window.fetch = rfFetchHook;',
    to: '    window.fetch = function (input, init) { return rfFetchHook.apply(this, arguments); };',
    expectFail: 'fetch 包装函数是具名的',
  },
  {
    name: '去掉「跳过自身帧」（恢复 initiator 被自己帧挤占的缺陷）',
    // 锚点曾写死为 `lines[0].indexOf('lib/page/debug-hook.js') >= 0`，
    // 但该实现后来改用 SELF 正则（覆盖 file:// 与不同打包路径下的扩展帧），
    // 于是锚点失配、这条变异静默失效。锚点必须随源码更新 —— 失配时脚本会报错而非静默跳过。
    from: '      while (lines.length && SELF.test(lines[0])) lines.shift();\n',
    to: '',
    expectFail: '捕获的 initiator 不含本文件自身的帧',
  },
  {
    name: '恢复往 XHR 实例挂 __rfNet（给页面对象留可见痕迹）',
    from: '        xhrState.set(this, { method: method, url: url, start: 0 });',
    to: '        this.__rfNet = { method: method, url: url, start: 0 };',
    expectFail: 'XHR 钩子不往页面实例上挂任何属性',
  },
  {
    name: '去掉派生链上的 catch（会让页面控制台出现未处理拒绝）',
    from: "        ).catch(function () {});",
    to: '        );',
    expectFail: '钩子不制造未处理拒绝',
  },
  {
    name: '把 this 从 window 改回调用方 this（恢复对非严格模式的隐含依赖）',
    from: '      var p = origFetch.apply(window, arguments);',
    to: '      var p = origFetch.apply(this, arguments);',
    expectFail: 'this 为 undefined 时仍以 window 调用原始 fetch',
  },
];

const tmpFiles = [];
let allGood = true;
for (const m of MUTATIONS) {
  if (!original.includes(m.from)) {
    console.log('  ✗ 变异锚点未找到（脚本需随源码更新）：' + m.name);
    allGood = false;
    continue;
  }
  const tmp = path.join(os.tmpdir(), 'rf-debug-hook-mut-' + Math.random().toString(36).slice(2) + '.js');
  tmpFiles.push(tmp);
  fs.writeFileSync(tmp, original.replace(m.from, m.to), 'utf8');

  let output = '';
  try {
    // ⚠ **必须显式指定报告器**：Node 的默认报告器会随"是不是 TTY"变化
    //（本地终端是 `spec`，输出 `✖ 用例名`；CI 里没有 TTY ⇒ 默认变成 TAP，输出 `not ok 1 - 用例名`）。
    // 这里曾经只按 `✖ ` 前缀解析 ✗ ⇒ 在 CI 里**一条都匹配不到**，
    // 于是 5 条变异全被误判成"没被抓住"✗（本地却全绿，极难发现）。
    // 固定成 tap + 同时认两种形态，才能让本地与 CI 判定一致。
    output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/page-debug-hook.test.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, RF_DEBUG_HOOK_SRC: tmp },
    });
  } catch (e) {
    output = String((e && e.stdout) || '') + String((e && e.stderr) || '');
  }
  const lines = output.split('\n');
  const failed = lines
    // 认两种：TAP 的 `not ok N - 名字`，以及 spec 的 `✖ 名字`（保留旧形态以防有人改回报告器）
    .map((l) => {
      const tap = /^\s*not ok\s+\d+\s*-\s*(.+?)\s*$/.exec(l);
      if (tap) return tap[1];
      const spec = /^\s*✖\s+(.+?)\s*$/.exec(l);
      return spec ? spec[1] : null;
    })
    .filter(Boolean);
  // ⚠ 一条测试结果都解析不出来时，**必须显式报错**：
  // 否则"报告器换了 / 测试文件加载失败"会被静默当成"断言没牙齿"✗
  //（这正是 CI 那次红报的误导来源 —— 报的是断言弱，其实是解析器对不上）
  const sawAnyResult = lines.some((l) => /^\s*(ok|not ok)\s+\d+/.test(l) || /^\s*✔\s+/.test(l) || /^\s*✖\s+/.test(l));
  if (!sawAnyResult) {
    console.log('  ✗ 测试结果**无法解析**（报告器形态变了？测试文件没跑起来？）：' + m.name);
    console.log('      原始输出前 300 字：' + output.slice(0, 300).replace(/\n/g, ' ⏎ '));
    allGood = false;
    continue;
  }
  const caught = failed.some((f) => f.includes(m.expectFail));
  console.log('  ' + (caught ? '✓' : '✗') + ' ' + m.name);
  console.log('      预期变红: ' + m.expectFail);
  console.log('      实际变红: ' + (failed.length ? failed.map((f) => f.split(' (')[0]).join(' | ') : '（无）'));
  if (!caught) allGood = false;
}

for (const f of tmpFiles) {
  try {
    fs.unlinkSync(f);
  } catch (e) {}
}
console.log(
  '\n  ' + (fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n') === original ? '源文件未被改动 ✓' : '✗ 源文件被改动了！')
);
console.log(allGood ? '变异测试通过：每条断言都能抓住对应的行为退化' : '有变异未被抓住 —— 对应断言形同虚设');
process.exit(allGood ? 0 : 1);

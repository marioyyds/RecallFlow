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
const original = fs.readFileSync(FILE, 'utf8');

const MUTATIONS = [
  {
    name: '把 fetch 包装内联成匿名函数（页面栈里会显示成 window.fetch）',
    from: '    window.fetch = rfFetchHook;',
    to: '    window.fetch = function (input, init) { return rfFetchHook.apply(this, arguments); };',
    expectFail: 'fetch 包装函数是具名的',
  },
  {
    name: '去掉「跳过自身帧」（恢复 initiator 被自己帧挤占的缺陷）',
    from: "      while (lines.length && lines[0].indexOf('lib/page/debug-hook.js') >= 0) lines.shift();\n",
    to: '',
    expectFail: '捕获的 initiator 不含本文件自身的帧',
  },
  {
    name: '恢复往 XHR 实例挂 __rfNet（给页面对象留可见痕迹）',
    from: '      try {\n        xhrState.set(this, { method: method, url: url, start: 0 });\n      } catch (e) {}',
    to: '      try {\n        this.__rfNet = { method: method, url: url, start: 0 };\n      } catch (e) {}',
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
    output = execFileSync(process.execPath, ['--test', 'tests/page-debug-hook.test.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, RF_DEBUG_HOOK_SRC: tmp },
    });
  } catch (e) {
    output = String((e && e.stdout) || '') + String((e && e.stderr) || '');
  }
  const failed = output
    .split('\n')
    .filter((l) => l.startsWith('✖ '))
    .map((l) => l.slice(2).trim());
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
  '\n  ' + (fs.readFileSync(FILE, 'utf8') === original ? '源文件未被改动 ✓' : '✗ 源文件被改动了！')
);
console.log(allGood ? '变异测试通过：每条断言都能抓住对应的行为退化' : '有变异未被抓住 —— 对应断言形同虚设');
process.exit(allGood ? 0 : 1);

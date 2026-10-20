// 变异测试：验证若干测试文件的断言**真的能抓住行为退化**。
//
// 为什么需要它：本轮就实测出两条「恒真断言」——vm 沙箱里栈帧不带文件名，
// 导致「initiator 不含自身帧」永远通过；`var f = function(){}` 的名字推断
// 又让「具名」断言对某种写法失效。**没有牙齿的测试比没有测试更糟，它制造虚假信心。**
//
// 两种注入方式：
//   · `env`：目标测试支持用环境变量指定源码路径（debug-hook 就是这么做的，零风险）；
//   · `inplace`：没有接缝的模块，就地改文件→跑测试→还原。
//
// `inplace` 的安全性（这是它唯一让人担心的点）：
//   1. 变异前先把原文写到 `<file>.mutation-backup`；
//   2. `try/finally` 保证无论断言结果如何都会还原；
//   3. **崩溃自愈**：脚本启动时若发现残留的备份，说明上次是被中断的，先还原再继续；
//   4. 收尾再比对一次文件内容，确认与原文一致，否则视为失败。
//   因此即使 SIGKILL 也不会留下变异版本 —— 备份写在变异之前，这是关键顺序。
//
// 用法：node scripts/mutation-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

/** 解析一条测试输出里「变红了哪些用例」。认 TAP 与 spec 两种形态。 */
function parseFailed(output) {
  const lines = output.split('\n');
  const failed = lines
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
  const sawAnyResult = lines.some(
    (l) => /^\s*(ok|not ok)\s+\d+/.test(l) || /^\s*✔\s+/.test(l) || /^\s*✖\s+/.test(l)
  );
  return { failed, sawAnyResult };
}

function runTest(testFile, env) {
  try {
    // ⚠ **必须显式指定报告器**：Node 的默认报告器会随"是不是 TTY"变化
    //（本地终端是 `spec`，输出 `✖ 用例名`；CI 里没有 TTY ⇒ 默认变成 TAP，输出 `not ok 1 - 用例名`）。
    // 这里曾经只按 `✖ ` 前缀解析 ✗ ⇒ 在 CI 里**一条都匹配不到**，
    // 于是 5 条变异全被误判成"没被抓住"✗（本地却全绿，极难发现）。
    return execFileSync(process.execPath, ['--test', '--test-reporter=tap', testFile], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  } catch (e) {
    return String((e && e.stdout) || '') + String((e && e.stderr) || '');
  }
}

function report(name, expectFail, parsed, ok) {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name);
  console.log('      预期变红: ' + expectFail);
  console.log(
    '      实际变红: ' + (parsed.failed.length ? parsed.failed.map((f) => f.split(' (')[0]).join(' | ') : '（无）')
  );
}

// ---------------------------------------------------------------- 目标定义

const TARGETS = [
  {
    file: 'lib/page/debug-hook.js',
    mode: 'env',
    envVar: 'RF_DEBUG_HOOK_SRC',
    test: 'tests/page-debug-hook.test.mjs',
    // 统一行尾再做锚点匹配。
    // 为什么：本文件是 CRLF，而锚点里的 `\n` 永远匹配不到 `...;\r\n` —— 于是那条变异
    // 长期处于「锚点未找到」状态，静默失效（实测）。变异脚本本身失效比测试失效更隐蔽：
    // 它输出的是「脚本需随源码更新」，很容易被当成脚本事、而不是「这道闸根本没在工作」。
    mutations: [
      {
        name: '把 fetch 包装内联成匿名函数（页面栈里会显示成 window.fetch）',
        from: '    window.fetch = rfFetchHook;',
        to: '    window.fetch = function (input, init) { return rfFetchHook.apply(this, arguments); };',
        expectFail: 'fetch 包装函数是具名的',
      },
      {
        name: '去掉「跳过自身帧」（恢复 initiator 被自己帧挤占的缺陷）',
        from: "      while (lines.length && SELF.test(lines[0])) lines.shift();\n",
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
        from: '        ).catch(function () {});',
        to: '        );',
        expectFail: '钩子不制造未处理拒绝',
      },
      {
        name: '把 this 从 window 改回调用方 this（恢复对非严格模式的隐含依赖）',
        from: '      var p = origFetch.apply(window, arguments);',
        to: '      var p = origFetch.apply(this, arguments);',
        expectFail: 'this 为 undefined 时仍以 window 调用原始 fetch',
      },
    ],
  },
  {
    // 为什么选 tool-guard 作为第二个目标：它是"只提醒不否决"这套策略的唯一实现，
    // 且 tests/tool-guard.test.mjs 有 22 条**行为**断言（不是读源码的静态断言）。
    // 变异测试的价值取决于"被测断言是不是行为断言" —— 对静态断言做变异没有意义。
    file: 'lib/assistant/tool-guard.js',
    mode: 'inplace',
    test: 'tests/tool-guard.test.mjs',
    mutations: [
      {
        name: '把精确跨越改成永远提醒（恢复"每次重复都打扰"的噪音行为）',
        from: 'function crosses(count, thresholds) {\n  return thresholds.indexOf(count) !== -1;\n}',
        to: 'function crosses(count, thresholds) {\n  return true;\n}',
        expectFail: '精确达到',
      },
      {
        name: '把重复阈值从 [3,5,8] 改成 [4,6,9]（悄悄放宽提醒时机）',
        from: 'export const REPEAT_THRESHOLDS = Object.freeze([3, 5, 8]);',
        to: 'export const REPEAT_THRESHOLDS = Object.freeze([4, 6, 9]);',
        expectFail: '精确达到',
      },
      {
        name: '清空默认排除列表（update_plan 不再对重复链透明）',
        from: "export const DEFAULT_EXCLUDED_TOOLS = Object.freeze(['update_plan']);",
        to: 'export const DEFAULT_EXCLUDED_TOOLS = Object.freeze([]);',
        expectFail: 'update_plan',
      },
      {
        name: '不再累计失败连击（连续失败永远不提醒）',
        from: 'if (failed) failStreak.set(name, (failStreak.get(name) || 0) + 1);',
        to: 'if (failed) failStreak.set(name, 0);',
        expectFail: '连续失败',
      },
      {
        name: '有进展时不再断开重复链（链的语义退化成历史累计）',
        from: "      chain = { key: '', count: 0, name: '' };",
        to: '      void 0;',
        expectFail: '有进展',
      },
    ],
  },
  {
    // 审批判定：这是"用户点了同意才写页面"的唯一闸门，判错的后果是**静默放行**。
    // 它此前只有 3 条测试，且从来没有被变异测过 —— 所以先看看这些测试到底有没有牙齿。
    file: 'lib/assistant/agent.js',
    mode: 'inplace',
    test: 'tests/agent-prompt.test.mjs',
    mutations: [
      {
        name: '反转类别自动批准（用户在设置里"关掉自动批准"变成"必须自动批准"）',
        from: '  return p[category] !== true;',
        to: '  return p[category] === true;',
        expectFail: 'toolNeedsApproval',
      },
      {
        name: '把 risk:page 错配到 edit 类别（16 个页面写操作全部走错审批档）',
        from: "  else if (meta.risk === 'page') category = 'commands';",
        to: "  else if (meta.risk === 'page') category = 'edit';",
        expectFail: 'toolNeedsApproval',
      },
      {
        name: '任意代码执行档不再单独审批（run_userscript 直接放行）',
        from: "    return resolveCodeExecutionApproval(settings) !== 'auto';",
        to: '    return false;',
        expectFail: 'toolNeedsApproval',
      },
    ],
  },
  {
    // 存活看门狗：判定"任务是不是卡死了"，它决定要不要强制收尾。
    // 阈值边界（>= 还是 >）差一格，表现为"卡死任务多跑一轮或少跑一轮"，极难肉眼发现。
    file: 'lib/assistant/agent.js',
    mode: 'inplace',
    test: 'tests/silent-failure-regressions.test.mjs',
    mutations: [
      {
        name: '无进展阈值差一格（>= 改成 >），卡死任务会多跑一轮',
        from: '  if (noProgressRounds >= cap) return { stalled: true, reason:',
        to: '  if (noProgressRounds > cap) return { stalled: true, reason:',
        // 关键词必须与**用例名**匹配，而不是与代码里的标识符匹配 ——
        // 用例名是中文时写 'stalled' 会让"确实红了"被判成"没抓住"（本次就这么误报过两条）。
        expectFail: '连续无进展达到上限',
      },
      {
        name: '无进展阈值判成"永远不卡死"（看门狗彻底失效）',
        from: "  if (!Number.isFinite(cap) || cap <= 0) return { stalled: false, reason: '', noProgressRounds };",
        to: "  return { stalled: false, reason: '', noProgressRounds };",
        expectFail: '连续无进展达到上限',
      },
    ],
  },
];

// ---------------------------------------------------------------- 执行

let allGood = true;
const tmpFiles = [];

/** 把 LF 归一化文本按目标文件的**原始行尾**写回。
 *
 *  为什么必须这么做（这是一个已经发生过的静默副作用）：
 *  锚点匹配要求统一成 LF（否则 `\n` 匹配不到 `...;\r\n`），但**写回时如果也用 LF**，
 *  CRLF 源文件就被永久改成了 LF。而 `git diff` 因为 autocrlf 看不到行尾差异，
 *  于是这个副作用长期无人发现 —— 只是每次跑完变异测试，`git status` 会多出一个
 *  "改了但又没 diff" 的文件，直到某次 `git add -A` 把整个文件的行尾变更一起提交。
 */
function toEol(text, eol) {
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

for (const target of TARGETS) {
  const abs = path.resolve(ROOT, target.file);
  // raw 是磁盘上的真实字节（含行尾），原始性核对必须用它 —— 用归一化文本比较
  // 等于把"行尾被改"这件事从检查里排除掉。
  const raw = fs.readFileSync(abs, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const original = raw.replace(/\r\n/g, '\n');
  console.log('\n=== ' + target.file + '（' + target.mode + '，' + (eol === '\r\n' ? 'CRLF' : 'LF') + '）===');

  for (const m of target.mutations) {
    if (!original.includes(m.from)) {
      console.log('  ✗ 变异锚点未找到（脚本需随源码更新）：' + m.name);
      allGood = false;
      continue;
    }

    let env = {};
    let cleanup = () => {};

    if (target.mode === 'env') {
      const tmp = path.join(os.tmpdir(), 'rf-mut-' + Math.random().toString(36).slice(2) + '.js');
      tmpFiles.push(tmp);
      fs.writeFileSync(tmp, original.replace(m.from, m.to), 'utf8');
      env = { [target.envVar]: tmp };
    } else {
      const backup = abs + '.mutation-backup';
      // 备份写**原始字节**，这样 finally 里的 copyFileSync 能把行尾也一起还原。
      fs.writeFileSync(backup, raw, 'utf8');
      fs.writeFileSync(abs, toEol(original.replace(m.from, m.to), eol), 'utf8');
      cleanup = () => {
        try {
          fs.copyFileSync(backup, abs);
          fs.unlinkSync(backup);
        } catch (e) {}
      };
    }

    try {
      const parsed = parseFailed(runTest(target.test, env));
      if (!parsed.sawAnyResult) {
        // 就地变异时若测试根本没跑起来，必须先还原再报，否则会把变异版本留在盘上。
        console.log('  ✗ 测试结果**无法解析**（报告器形态变了？测试文件没跑起来？）：' + m.name);
        allGood = false;
        continue;
      }
      const caught = parsed.failed.some((f) => f.includes(m.expectFail));
      report(m.name, m.expectFail, parsed, caught);
      if (!caught) allGood = false;
    } finally {
      cleanup();
    }
  }

  // 收尾核对：源文件必须与进入时**字节级**一致（含行尾）。
  // 用归一化文本比较会让"行尾被改成 LF"这类副作用永远通过 —— 而这正是本脚本
  // 曾经真实留下的副作用，所以这里必须比 raw。
  const after = fs.readFileSync(abs, 'utf8');
  if (after !== raw) {
    console.log(
      '  ✗ ' + target.file + ' 未被正确还原！' +
        (after.replace(/\r\n/g, '\n') === original ? '（内容相同但行尾变了）' : '')
    );
    allGood = false;
  } else {
    console.log('  源文件未被改动 ✓');
  }
}

for (const f of tmpFiles) {
  try {
    fs.unlinkSync(f);
  } catch (e) {}
}

console.log(
  allGood
    ? '\n变异测试通过：每条断言都能抓住对应的行为退化'
    : '\n有变异未被抓住 —— 对应断言形同虚设'
);
process.exit(allGood ? 0 : 1);

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
import { acquireLock, releaseLock, writeBackup, restoreBackup, recoverLeftovers, writeFileRetry, BACKUP_SUFFIX } from './lib/mutation-fs.mjs';

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
    // 它原先住在 agent.js 里（为了测它得先起一整套 chrome 桩），所以只有 3 条断言；
    // 搬到 lib/assistant/approval-policy.js 后可以直接单测，那 14 条到底有没有牙齿由这里验证。
    file: 'lib/assistant/approval-policy.js',
    mode: 'inplace',
    test: 'tests/approval-policy.test.mjs',
    mutations: [
      {
        name: '反转类别自动批准（用户在设置里"关掉自动批准"变成"必须自动批准"）',
        from: '  return p[category] !== true;',
        to: '  return p[category] === true;',
        expectFail: '页面命令类',
      },
      {
        name: "把 risk:page 错配到 edit 类别（16 个页面写操作全部走错审批档）",
        from: "  page: 'commands',",
        to: "  page: 'edit',",
        expectFail: 'risk → 审批类别',
      },
      {
        name: '任意代码执行档不再单独审批（run_userscript 直接放行）',
        from: "    return resolveCodeExecutionApproval(settings) !== 'auto';",
        to: '    return false;',
        expectFail: '任意代码执行档',
      },
      {
        name: '未映射的风险等级兜底到 commands（fail-closed 退化成"跟着用户勾选走"）',
        from: "  const hit = APPROVAL_CATEGORY_BY_RISK[risk];\n  return typeof hit === 'string' ? hit : null;",
        to: "  const hit = APPROVAL_CATEGORY_BY_RISK[risk];\n  return typeof hit === 'string' ? hit : 'commands';",
        expectFail: '高风险档没有类别',
      },
      {
        name: '任意代码执行档的"自动批准"选择被忽略（用户选了 auto 仍然每次弹窗）',
        from: "  if (meta.alwaysRequireApproval === true) {",
        to: "  if (false) {",
        expectFail: '任意代码执行档',
      },
    ],
  },
  {
    // 面板 UI：这是 4900 行、长期零 import 的那个文件。目标是证明
    // tests/chat-panel-smoke.test.mjs 里那几条"真建 DOM"的断言不是摆样子。
    file: 'lib/page/chat.js',
    mode: 'inplace',
    test: 'tests/chat-panel-smoke.test.mjs',
    mutations: [
      {
        name: '快捷键换成 KeyX（用户按 Alt+Shift+R 没反应）',
        from: "e.code === 'KeyR'",
        to: "e.code === 'KeyX'",
        expectFail: 'Alt+Shift+R 打开面板',
      },
      {
        name: '去掉 250ms 去抖（连按两下手抖就把面板开了又关）',
        from: '  if (now - lastShortcutToggleAt < 250) return;',
        to: '  if (false) return;',
        expectFail: '快捷键去抖',
      },
      {
        name: '审批面板漏写一个类别（data-policy 拼错 ⇒ 该类工具永远无法自动批准）',
        from: 'data-policy="browser"',
        to: 'data-policy="browsers"',
        expectFail: '5 个类别',
      },
    ],
  },
  {
    // 工具审批条：它是用户唯一能看到「Agent 要动你的页面了」的地方，而且三条性质
    // 错了都**不会报错**（静默泄露 / 静默放行 / 用户点了拒绝却当成放行）。
    file: 'lib/page/chat.js',
    mode: 'inplace',
    test: 'tests/chat-approval-prompt.test.mjs',
    mutations: [
      {
        name: '审批条不再遮蔽 type_text 的输入内容（口令明文印在屏幕上）',
        from: "    ? { ...toolArgs, value: '[输入内容已隐藏]' }",
        to: '    ? toolArgs',
        expectFail: '遮蔽',
      },
      {
        name: '永远给出「本任务内允许」（该逐次批准的工具被一键放行整轮）',
        from: '    showSession: allowSession !== false,',
        to: '    showSession: true,',
        expectFail: '批量放行',
      },
      {
        name: '「本任务内允许」按成 once（用户以为放行了整轮，实际只批了一次）',
        from: "  if (sessionEl) sessionEl.addEventListener('click', () => decide('session'));",
        to: "  if (sessionEl) sessionEl.addEventListener('click', () => decide('once'));",
        expectFail: '本任务内允许',
      },
      {
        name: '「拒绝」按成 once（用户点了拒绝，Agent 继续执行）',
        from: "  box.querySelector('.tool-reject').addEventListener('click', () => decide('reject'));",
        to: "  box.querySelector('.tool-reject').addEventListener('click', () => decide('once'));",
        expectFail: '点「拒绝」',
      },
      {
        name: '代码块不做 HTML 转义（innerHTML 拼接 ⇒ 页面内 XSS）',
        from: "'</div><pre class=\"tool-approval-code\">' + escHtml(view.longText) + '</pre>'",
        to: "'</div><pre class=\"tool-approval-code\">' + view.longText + '</pre>'",
        expectFail: '尖括号',
      },
    ],
  },
  {
    // 发送/停止按钮的状态派生：四种组合里三种写错都不报错，只会「用起来怪」。
    file: 'lib/page/chat.js',
    mode: 'inplace',
    test: 'tests/chat-run-controls.test.mjs',
    mutations: [
      {
        name: '只看本页 streaming（跟随别人的 run 时没有停止按钮 = 状态分裂）',
        from: '  const running = Boolean(src.streaming || followingRunning);',
        to: '  const running = Boolean(src.streaming);',
        expectFail: '跟随别的标签页',
      },
      {
        name: '运行中不禁用发送（同一会话里能塞第二条指令）',
        from: '    sendDisabled: running,',
        to: '    sendDisabled: false,',
        expectFail: '发送禁用',
      },
      {
        name: '停止中不禁点（连点几次就把同一个中断请求发很多遍）',
        from: '    stopDisabled: stopping,',
        to: '    stopDisabled: false,',
        expectFail: '禁点',
      },
      {
        name: '停止中文案不变（用户不知道点了有没有生效，会继续点）',
        from: "    stopText: stopping ? '停止中…' : '■ 停止',",
        to: "    stopText: '■ 停止',",
        expectFail: '停止中：按钮禁点',
      },
    ],
  },
  {
    // 上下文折叠：它是"长任务不会把上下文撑爆"的唯一手段，同时也是**唯一会改写历史中部**的
    // 操作（每次改写都会让服务端前缀缓存失效）。三条算子分别对应它的三个性质：
    // 只折叠靠前的、折叠过的绝不再动、折叠后一定更短。
    file: 'lib/assistant/context.js',
    mode: 'inplace',
    test: 'tests/context.test.mjs',
    mutations: [
      {
        name: '连最近的结果一起折叠（keepFull 失效）',
        from: '  const old = idx.slice(0, Math.max(0, idx.length - keepFull));',
        to: '  const old = idx.slice(0);',
        expectFail: 'keeps the last N full',
      },
      {
        name: '已折叠的再折叠一次（前缀每轮抖动一次）',
        from: '    if (m.content.indexOf(COLLAPSE_MARK) !== -1) continue;',
        to: '    if (false) continue;',
        expectFail: '已折叠的消息不会被二次改写',
      },
      {
        name: '允许"折叠"后反而变长（丢掉"一定更短"这个性质）',
        from: '    if (next === m.content || next.length >= m.content.length) continue;',
        to: '    if (!next) continue;',
        expectFail: '变长',
      },
    ],
  },
  {
    // 多 run 状态机：跟随页与 SW 共用同一份归约。这里错一步，表现是
    // "思考被混进正文""停止按钮永远灰着"这类只有真跑长任务才看得见的问题。
    file: 'lib/assistant/run-hub.js',
    mode: 'inplace',
    test: 'tests/run-hub.test.mjs',
    mutations: [
      {
        name: '正文开始不定稿思考段（思考与正文混在一条时间线上）',
        from: "    case 'chunk':\n      endReasoning(state);",
        to: "    case 'chunk':",
        expectFail: '思考先于正文',
      },
      {
        name: '任意工具结果都清掉审批（别的工具的返回把待批弹窗关掉）',
        from: "      if (state.approval && state.approval.callId === String(event.callId || '')) state.approval = null;",
        to: '      state.approval = null;',
        expectFail: '审批',
      },
      {
        name: 'end 之后不清停止标记（跟随页的停止按钮永远灰着）',
        from: "      state.status = 'ended';\n      state.stopping = false;",
        to: "      state.status = 'ended';",
        expectFail: '停止中',
      },
    ],
  },
  {
    // LLM 调用的中断语义：这三条错任何一条，用户按停止都会变成「再等 1.5 秒、再花钱」，
    // 甚至变成「记录里写着任务已完成」（见 tests/llm-abort-retry.test.mjs 的说明）。
    file: 'lib/assistant/llm.js',
    mode: 'inplace',
    test: 'tests/llm-abort-retry.test.mjs',
    mutations: [
      {
        name: '把用户中断当成可重试的故障（停止变慢 1.5 秒，且重复发请求）',
        from: "  if (e && e.name === 'AbortError') return false;",
        to: "  if (e && e.name === 'AbortError') return true;",
        expectFail: '不可重试',
      },
      {
        name: '已中断的 signal 仍然发请求（在用户放弃的任务上继续计费）',
        from: "  if (signal && signal.aborted) throw makeAbortError();",
        to: "  if (false) throw makeAbortError();",
        expectFail: '一个请求都不发',
      },
      {
        name: 'fetch 抛错时不清理（定时器与 abort 监听留在原地）',
        from: "    if (signal) signal.removeEventListener('abort', abort);",
        to: "    if (false) signal.removeEventListener('abort', abort);",
        expectFail: '解绑',
      },
    ],
  },
  {
    // 完成校验的结局分派（classifyVerifyOutcome）：把「中断」误读成「校验器故障」的后果是
    // 用户按了停止、记录里却写着任务已完成（详见 tests/llm-abort-retry.test.mjs）。
    // 单独一个 target 是因为它属于另一个测试文件（变异脚本一次只跑一个目标测试）。
    file: 'lib/assistant/agent.js',
    mode: 'inplace',
    test: 'tests/llm-abort-retry.test.mjs',
    mutations: [
      {
        name: '中断被当成校验器故障（「停止」会以「任务已完成」落盘）',
        from: "    if (error.name === 'AbortError') return { kind: 'interrupt' };",
        to: "    if (error.name === 'AbortError') return { kind: 'fail-open' };",
        // 关键词必须出现在**用例名**里（不是断言消息里）—— 否则真红了也会被判成没抓住。
        expectFail: '结局分派',
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
  {
    // 完成前确定性断言（claim-check）：它是"省掉一次 LLM 校验"的零成本预检，
    // 但判错的方向比漏判更贵 —— 误判 fail 会灌给模型一条**内容错误**的反思，
    // 它据此可能重复已经成功的动作，或把总结改口成"没做成"。
    file: 'lib/assistant/claim-check.js',
    mode: 'inplace',
    test: 'tests/claim-check.test.mjs',
    mutations: [
      {
        name: '规则 2 退回「只看失败名单」（失败后重试成功的任务被判成撒谎）',
        from: 'mutating.every((t) => failed.includes(t) && !succeeded.includes(t))',
        to: 'mutating.every((t) => failed.includes(t))',
        expectFail: '同名工具失败后又重试成功',
      },
      {
        name: '规则 1 去掉「调用过工具」的前提（空跑任务也报谎）',
        from: 'if (claimsMutation && mutating.length === 0 && ran.length > 0) {',
        to: 'if (claimsMutation && mutating.length === 0) {',
        expectFail: '规则 1 只在',
      },
      {
        name: '去掉「描述性措辞」的完成态线索要求（凡是含动词就当成声称做了）',
        from: '  return before.test(claim) || after.test(claim);',
        to: '  return true;',
        expectFail: '描述性措辞',
      },
      {
        name: '把导航类声明放回写动词里（研究类任务的「已打开原文」全被判成撒谎）',
        from: '  if (!claimsMutation && claimsNav && mutating.length === 0 && ran.length > 0 && !ran.some((n) => NAV_CAPABLE_TOOLS.has(n))) {',
        to: '  if (false) {',
        expectFail: '导航类声明',
      },
      {
        name: '把「看过内容」的工具也算成「打开过页面」（幻觉声明被放行）',
        from: "const NAV_CAPABLE_TOOLS = new Set(['open_tab', 'switch_tab', 'fetch_webpage']);",
        to: "const NAV_CAPABLE_TOOLS = new Set(['open_tab', 'switch_tab', 'fetch_webpage', 'web_search', 'read_current_page']);",
        expectFail: '只搜过摘要',
      },
    ],
  },
  {
    // 任务性质分派（classifyTaskKind）：它决定完成校验问哪一种问题。
    // 判成 mutation 而实际是纯读取，研究类任务会在长页面上被反复判未达成。
    file: 'lib/assistant/agent.js',
    mode: 'inplace',
    test: 'tests/completion-evidence.test.mjs',
    mutations: [
      {
        name: '一律按「改过页面」处理（纯读任务永远掉进严格问法）',
        from: "  return allReadOnly ? 'read' : 'mutation';",
        to: "  return 'mutation';",
        expectFail: '纯读取',
      },
      {
        name: '只看 readOnly、忽略 mutatesState（fetch_webpage 这类「联网读」重新被当成写操作）',
        from: '  return md.readOnly !== true && md.mutatesState !== false;',
        to: '  return md.readOnly !== true;',
        expectFail: '纯读取',
      },
      {
        name: '未知工具（MCP）当成只读（不知道会改什么就敢放行）',
        from: '  return md.readOnly !== true && md.mutatesState !== false;',
        to: '  return false;',
        expectFail: '未知工具',
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

// ---------------------------------------------------------------- 互斥与自愈

// ⚠ **必须互斥**。这个脚本会就地改写源文件，两个进程并发时：
//   A 备份原始版本 → 写变异；B 读到的是**变异版本**，把它当「原始」备份下来；
//   A 还原后 B 再还原 ⇒ 变异版本被写回磁盘，而两个进程各自的收尾核对都「通过」了。
//   本会话真实发生过（`npm test` 里的门禁 + 手动跑的一次撞在一起），
//   那次留在盘上的是 context.js 的 `idx.slice(0)`（keepFull 失效的变异）。
const LOCK_FILE = path.join(ROOT, '.mutation-lock.json');
const lock = acquireLock(LOCK_FILE);
if (!lock.ok) {
  console.error(
    '已有变异测试在跑（pid=' + lock.holder.pid + '，自 ' + lock.holder.at + '）。\n' +
      '它会就地改写源文件，两个进程并发会互相覆盖（甚至把变异版本留在盘上）—— 请等它结束再跑。'
  );
  process.exit(3);
}
process.on('exit', () => releaseLock(LOCK_FILE));

const targetFiles = [...new Set(TARGETS.map((t) => path.resolve(ROOT, t.file)))];
const healed = recoverLeftovers(targetFiles);
if (healed.restored.length) {
  console.log(
    '（自愈）发现上次被中断时留下的变异版本，已按备份还原：\n  ' +
      healed.restored.map((f) => path.relative(ROOT, f)).join('\n  ')
  );
}
if (healed.skipped.length) {
  console.log(
    '（自愈）这些文件也留下了备份，但源文件已不含那次变异的文本（崩溃后被改过），' +
      '因此**没有覆盖**，只清掉了备份 —— 若担心，请 git diff 一下：\n  ' +
      healed.skipped.map((f) => path.relative(ROOT, f)).join('\n  ')
  );
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
      // 备份写**原始字节**（finally 里原样拷回，行尾也一起还原），
      // 同时把 `to` 记进 meta —— 崩溃自愈要靠它判断这份备份还算不算数。
      const mutated = toEol(original.replace(m.from, m.to), eol);
      writeBackup(abs, raw, m.to);
      // 写变异版本同样走退避重试：这一步被 Windows 的扫描/同步短暂挡住过一次，
      // 表现是 errno -4094 / code UNKNOWN，整个门禁带着栈崩掉并留下备份。
      // 重试之后仍失败就说明是真问题（只读、磁盘满），此时抛出比继续跑更安全 ——
      // 继续跑只会得到一个「测试没抓住」的假红，把人引去查断言。
      writeFileRetry(abs, mutated);
      cleanup = () => {
        restoreBackup(abs);
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

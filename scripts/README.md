test(bridge): MCP 截图通道的端到端验证台

桥接层是整个项目最难手工回归的部分：它横跨扩展与 MCP 两个包，
且真实调用需要「重载扩展 + 重启 server」，两者都会打断正在使用的 MCP 会话。
因此这里提供一套**隔离验证台**，不需要触碰任何运行中的实例。

scripts/verify-mcp-shot.mjs
  在隔离端口起一个 server 实例，用真实 MCP 协议（initialize / tools/list / tools/call）
  核对：工具已注册、参数完整、扩展不可用时错误路径优雅、本地工具能正常往返。

scripts/verify-mcp-shot-success.mjs
  额外扮演「假扩展」——通过 /poll 领取请求、经 /result 回结果，
  从而走通**成功路径**：图片真的以 MCP image 内容块返回、includeImage 开关生效、
  归档落盘且字节与源一致。

用法（PowerShell）：
  $env:RECALLFLOW_MCP_PORT='7802'            # 隔离端口，别用 7801
  $env:RECALLFLOW_EXT_TIMEOUT_MS='3000'      # 让依赖扩展的调用快速失败
  $env:RECALLFLOW_EVIDENCE_DIR="$env:TEMP\rf-evidence-test"   # 隔离证据目录
  node integrations/opencode/recallflow-mcp/index.js --http  # 后台起实例
  node scripts/verify-mcp-shot.mjs
  node scripts/verify-mcp-shot-success.mjs

两个脚本都返回非零退出码表示未通过，可直接用于改动后的回归。

## scripts/check-const-assign.mjs

扫描「对 const 声明重新赋值」这类**只能在运行时炸**的代码，并被
`tests/static-checks.test.mjs` 作为门禁每次执行。

起因是一个真实崩溃：`agent.js` 里 `const deterministicFails` 却在后面 `+= 1`，
于是「完成断言判定失败」这条分支一走到就抛 `Assignment to constant variable`，
整个 agent run 直接挂掉。要命的是 **`node --check` 抓不到（语法合法），
400 项单测也抓不到（需要真实 agent 运行 + 特定失败场景）** ——
也就是说这类 bug 之前没有任何一层能发现它。

本仓库没有安装任何 JS 解析器（acorn / espree / typescript 都没有），
为这一个检查引入依赖不划算，因此用两层保守启发式，目标是**零误报**：

1. **字符串剥离**：逐字符跟踪 `'` `"` `` ` `` 三种引号与转义，把字符串内容替换成空白。
   否则 `'<button title="x">'` 里的 `title=` 会被当成对 `const title` 的赋值
   （实测这一项贡献了 38 处误报）。
2. **声明收集**：识别 const/let/var（含无初始化的 `let m;`）、function/class 名、函数参数。
   只有「全部声明都是 const 且从未作为参数」的名字，其非声明处的赋值才报告。

实测精度：修复后 0 处；把 `const` 改回去则恰好命中那一处。

已知局限（宁可漏报不误报）：不做真正的词法作用域分析，同名跨作用域遮蔽时会漏报；
模板字符串的 `${}` 插值按字符串处理，插值内含赋值会漏报。

用法：

  node scripts/check-const-assign.mjs     # 退出码非零表示发现问题

已知未覆盖：真实扩展的 CDP 截图本身（screenshot_capture 的 relay 实现）需要重载扩展才能验证。

## scripts/verify-panel-events.mjs

验证「面板事件通道」的端到端：外部 agent（DSH）在浏览器页面里能看到它在做什么。

为什么需要：这条链路跨越三个包（MCP server 成形事件 → 桥接投递 → 扩展转发 → 面板渲染），
任一端改名都只会在运行时表现为「面板上什么都没有」，而没有任何静态检查能发现。

验证内容（在隔离端口 7802 上，不触碰用户的常驻实例与扩展）：
- `panel_post` 已登记，且投递走 `poll-queue`（隔离实例没有扩展连着 WS）
- 留言事件成形且 level 正确
- 真实的工具调用产生 start/end 事件，参数摘要挑中白名单字段
- `panel_post` 不自我播报（否则用户会看到"我要说话了"这件事本身被播报一遍）

用法（PowerShell）：

  $env:RECALLFLOW_MCP_PORT='7802'; $env:RECALLFLOW_EXT_TIMEOUT_MS='3000'
  $env:RECALLFLOW_EVIDENCE_DIR="$env:TEMP\rf-evidence-events"
  node integrations/opencode/recallflow-mcp/index.js --http   # 后台起实例
  node scripts/verify-panel-events.mjs

退出码非零表示未通过。脚本刻意用 `process.exitCode` 而不是 `process.exit()`：
后者会在 undici 的 socket 收尾时撞上 Windows 上的 libuv 断言（uv_async.c:94），
把「验证通过」变成崩溃退出码 0xC0000409。

已知未覆盖：面板实际渲染（DOM 路径无法在 node 中测），以及真实扩展的转发
（需要重载扩展）。

## scripts/verify-dsh-hook.mjs

验证「DSH hook → 面板事件」的真实链路（隔离端口 7802，不需要重启 DSH）。

链路：DSH 触发 hook → `integrations/dsh-hooks/recallflow-panel-hook.mjs` 读 stdin →
POST 桥接 `/event` → 面板事件队列。这条链路跨进程、跨编码、跨包，只能在集成层面验证。

验证内容：
- 四种载荷（UserPromptSubmit / PreToolUse Bash / PreToolUse mcp__* / Stop）全部以退出码 0 结束
  （hook **绝不能**阻塞 DSH，失败也必须静默成功退出）
- 只产出 2 条事件：`mcp__*` 被跳过（避免与 MCP 服务端的上报重复）、Stop 无内容不产出
- **中文原样无损**
- `who=user` 与 `source=external` 正确

用法：

  $env:RECALLFLOW_MCP_PORT='7802'
  node integrations/opencode/recallflow-mcp/index.js --http   # 后台
  node scripts/verify-dsh-hook.mjs

> 为什么脚本用 node 的 fetch 而不是 PowerShell 的 Invoke-RestMethod：
> 后者会把返回的 UTF-8 中文显示成乱码（按 Latin-1 解码），容易误判成数据损坏。
> 编码问题必须区分「工具显示错」与「数据真坏」，否则会去修一个不存在的问题。

## scripts/mutation-check.mjs

验证 `tests/page-debug-hook.test.mjs` 的断言**真的有牙齿**。

动机来自一次实测：该测试最初有两条「恒真断言」——vm 沙箱里栈帧不带文件名（导致
「initiator 不含自身帧」永远通过），以及 `var f = function(){}` 的名字推断（让「具名」
断言对某种写法失效）。**没有牙齿的测试比没有测试更糟，因为它制造虚假信心。**

做法：在**临时副本**上精确破坏一处行为（源文件只读不改，哈希可验证），
跑测试并确认「预期的那条」变红。用法：

  node scripts/mutation-check.mjs

返回非零退出码表示有变异未被抓住，即对应断言形同虚设。新增针对该文件的断言后，
建议同时补一条变异。

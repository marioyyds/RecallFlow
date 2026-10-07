## （已删除）MCP 截图通道的端到端验证台

`scripts/verify-mcp-shot.mjs` 与 `scripts/verify-mcp-shot-success.mjs` 已随 **7801 桥接与
MCP server 整包**一起删除（用户 2026-10-08 明确不再用 opencode，见 `docs/deletion-plan.md`）。

它们当时做的事值得记一句，因为**方法**仍然有用：在**隔离端口**（7802）起一个 server 实例，
用真实 MCP 协议（initialize / tools/list / tools/call）核对工具注册与错误路径；
第二个脚本还扮演「假扩展」经 /poll 领请求、/result 回结果，从而走通**成功路径**
（图片以 image 内容块返回、落盘归档且字节一致）。核心思路是"**不触碰任何运行中的实例**"——
重载扩展或重启 server 都会打断正在使用的会话，所以验证台必须是隔离的。

现在要验证的是同一类问题的 DSH 版本：`scripts/verify-one-plugin-e2e.mjs`（隔离实例起 DSH 插件）
与 `scripts/verify-capability-tiers.mjs`（对真实实例逐方法探能力档位）。

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

## （已删除）面板事件链路相关的四个脚本

`verify-panel-events.mjs`、`verify-dsh-hook.mjs`、`verify-panel-turns.mjs`、`probe-panel-turns.mjs`
已随**删除清单第 4 步**一起移除，连同它们验证的东西：

- 桥接里的 `panel-events.js`（say/tool 事件的成形与三档截断 400/1200/2000）
- 事件队列与 `/event` 端点（DSH hook 经它推事件）
- `integrations/dsh-hooks/`（那个 hook 本体）
- `/panel-turns` 两端与 `panel_history` / `panel_post` 两个 MCP 工具

为什么可以整条删掉：它们服务的是**"两段对话互相同步"**这个前提 —— 面板里一份对话、
DSH 里另一份，于是需要成形、排队、上报、读回。现在只有**一条会话**：面板的话直接成为
那条会话里的用户消息，面板显示的就是会话本身的事件（由 DSH 插件经自己的 WS 推送）。

新的验证入口：
- `node scripts/verify-live-gate.mjs` —— 五项闸门（含"没删坏 opencode"的基线）
- `node scripts/watch-session-events.mjs [秒]` —— 观察插件往面板推的会话事件
- `node scripts/probe-tool.mjs [method]` —— 走完整链路验证工具往返
- `node tests/*.test.mjs`（见 tests/bridge-contract.test.mjs 的反向断言：旧链路不得复活）

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

## （已删除）为旧架构写的验证台

`verify-dsh-plugin.mjs`（旧插件的装载与事件）、`verify-panel-inject.mjs`（注入载荷）、
`verify-panel-turns.mjs` / `probe-panel-turns.mjs` / `verify-reverse-live.mjs`（反向通道）
都已随它们验证的东西一起删除 —— 那些东西属于"插件注入上下文 + 两段对话同步"，
已被单会话架构取代（面板输入直接成为会话的用户消息，面板显示会话本身的事件）。

它们留下的教训仍然有效，并且已经写进 `docs/two-way-sync.md` 的「踩过的坑」：
PowerShell 5.1 上把 JSON 交给 curl 会被重引用（所以探针用 node fetch）、
中文乱码要区分「工具显示错」与「数据真坏」、常驻进程必须由用户在自己的终端启动。
- 7 项全过，并打印出"若现在重启 DSH，新会话将注入的上下文"

已知未覆盖：真实 DSH 的 `Agent.inject` 是否接受该载荷 —— 需要重启 DSH 才能看到会话里是否出现该上下文。

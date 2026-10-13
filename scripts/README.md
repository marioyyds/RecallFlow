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

## scripts/dev-up.sh（+ dev-up.cmd）

本地开发的常驻服务启动器：一条命令拉起 MCP server，需要时再带上本地静态服务。

为什么单独做一个：MCP server 必须**常驻单实例**（7801 上只能有一个进程与扩展保持桥接，
多起一个会 EADDRINUSE 直接退出），而它的启动参数有一串（`--http` / 端口 / token / 证据目录 /
扩展超时）；与此同时，调试本地 HTML 又必须先有 127.0.0.1 站点（扩展的 content_scripts 只匹配
http/https，不注入 file:// 页面）。两件事都需要"开着不动"，所以合并成一个可 status/stop 的入口。

用法：

  bash scripts/dev-up.sh                      # 前台：起 MCP server，Ctrl-C 回收本次启动的进程
  bash scripts/dev-up.sh --with-static [DIR]  # 同时把 DIR（默认当前目录）挂成 http://127.0.0.1:8099
  bash scripts/dev-up.sh --daemon             # 后台常驻（配合 status / logs / stop）
  bash scripts/dev-up.sh status | logs | stop [--force]

Windows 上用 `scripts\dev-up.cmd <同样的参数>`：它只负责找到 Git Bash 并原样转发，
所以逻辑只有一份（cmd 文件必须保持纯 ASCII——中文注释会让 cmd.exe 解析错行，已实测）。
**WSL 的 bash 不适用**：那里 node 与 D:\ 路径的映射不同。

实测踩过的坑（改这个脚本时别退回去）：

- 端口归属才是**跨会话**的真值，`$!` 给的 MSYS pid 不是：status/stop 一律按端口反查系统 PID。
- `stop` 只回收"看起来确实是本项目"的进程（命令行匹配 `index.js --http` / `serve-dir.mjs`），
  否则要 `--force` —— 免得误杀你自己起的别的服务。
- Ctrl-C 回收路径里**不能**写 `trap - INT TERM`：Windows 的 Ctrl-C 是控制台事件，同组进程可能
  收到不止一次，第二次会把正在清理的脚本当场杀掉，两个服务全成孤儿（实测现象：日志停在进入
  清理函数那一行，端口仍 LISTENING）。正确写法是清理期间 `trap '' INT TERM`（对信号免疫）。
- 清理代码必须 `set +e`：`set -e` + `pipefail` 下，清理中的命令替换一旦返回非零就整个脚本退出。

## scripts/serve-dir.mjs

零依赖静态服务器：把任意目录挂成 `http://127.0.0.1:PORT`，专供"调试本地 HTML"。

为什么需要：扩展的 content_scripts 只匹配 `http://*/*` 与 `https://*/*`，`file://` 页面不会注入
内容脚本，因此双击打开的本地 HTML 拿不到面板、元素拾取与 console 缓冲；`browser_read` 也在
MCP 与 relay 两层显式拒绝非 http(s) URL。挂成 127.0.0.1 站点后整套页面能力立刻可用
（已实测：`browser_read` 返回渲染后正文与 `snapshotHash`）。

用法：

  node scripts/serve-dir.mjs [DIR] [--port 8099] [--bind 127.0.0.1] [--no-listing]

安全边界（与 MCP 桥接同源，勿删）：默认只绑回环地址；Host 白名单（防 DNS rebinding）；
目标路径必须落在 root 之内；不发任何 CORS 放行头。对应断言见 `tests/serve-dir.test.mjs`。

## scripts/install-native-host.mjs

把"浏览器自动拉起本地 MCP server"这件事一次装好（native messaging）。设计说明见
`integrations/native-host/README.md`，这里只记**为什么安装器要自己探测扩展 ID**：

`allowed_origins` 必须与扩展 ID 完全一致，差一个字符就是
`Access to the specified native messaging host is forbidden`——而浏览器不会告诉用户原因。
解压目录扩展的 ID 由**绝对路径**推导，因此可以直接扫浏览器 Profile
（`Secure Preferences` / `Preferences` 里的 `extensions.settings[].path`）反查出来。
探测逻辑单独可测：`tests/native-host-client.test.mjs` 用合成 Profile 钉住了它。

用法：

  node scripts/install-native-host.mjs                 # 探测 + 生成配置 + 编 exe + 写注册表 + 自检
  node scripts/install-native-host.mjs --list-ids      # 只看探测结果
  node scripts/install-native-host.mjs --dry-run       # 只看将要执行的写操作
  node scripts/install-native-host.mjs --uninstall     # 卸载

## scripts/verify-native-host.mjs

按**和 Chrome 完全相同的方式**启动 native host（管道 + 4 字节长度前缀帧）并逐条断言：
启动即自动 ensure / `ping→pong` / `status` 字段齐全 / `ensure` 后端口可探活 / 定期心跳 /
`stop` 只停自己启动的实例 / stdin 关闭后宿主自行退出。

为什么必须有不依赖浏览器的自检：native messaging 的失败几乎全是静默的——帧格式错是直接断开、
`allowed_origins` 不匹配只有一句 forbidden、宿主起不来只有 "Native host has exited."。
没有这层，每次排查都得"重载扩展 + 开页面"来回猜。

用法：

  node scripts/verify-native-host.mjs                     # 用装好的 exe
  node scripts/verify-native-host.mjs --host integrations/native-host/host.js --port 7811

`--port` 用隔离端口时它会真的起一个 server 再停掉，不会碰到你正在用的 7801。

## scripts/build-dist.mjs + verify-installer*.mjs

一键安装包（免 Node）的构建与验收。设计说明、体积构成、扩展 ID 识别顺序、升级路径的坑，
都写在 `packaging/README.md`（那里是这一层的唯一文档，避免两处描述漂移）。这里只列命令：

  node scripts/build-dist.mjs --from-local-node   # 构建 payload + 安装器（离线，用本机 node）
  node scripts/verify-installer.mjs               # 装→验→卸→验→恢复开发态注册（22 项）
  node scripts/verify-installer-upgrade.mjs       # 运行中再装一次（升级路径，13 项）

两条 verify 脚本会真的往本机安装（写 HKCU 与 %LOCALAPPDATA%），跑完自动恢复到仓库开发态。

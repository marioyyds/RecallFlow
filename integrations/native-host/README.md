# native-host：让浏览器自己把本地服务拉起来

> 用户视角的入口（怎么装、怎么卸、状态灯与排障表）在
> **[本地服务（127.0.0.1:7801）](../../docs/local-service.md)**；本文件讲实现原理。

这个目录解决的问题是"**用户得先开终端敲一条命令**"——对不写代码的人来说，这一步等于用不了。

装好之后的行为：**浏览器一开，`127.0.0.1:7801` 上的 MCP server 自动就绪**，用户不需要知道有服务存在。

```
Edge / Chrome
   │  ① 扩展调 chrome.runtime.connectNative('com.recallflow.bridge')
   ▼
recallflow-native-host.exe        ← 注册表 + manifest 让浏览器找到它
   │  ② 启动器把浏览器创建的 stdin/stdout 管道原样交给 node（字节级透传）
   ▼
node host.js                      ← 长度前缀帧协议 + 心跳；负责"确保服务在跑"
   │  ③ detached spawn（宿主退出后它继续活着）
   ▼
node integrations/opencode/recallflow-mcp/index.js --http     ← 127.0.0.1:7801
```

## 安装（一次）

```bash
node scripts/install-native-host.mjs
```

它会：探测本机浏览器里"指向本仓库目录"的扩展 ID（解压目录扩展的 ID 由绝对路径推导）→ 生成宿主配置 →
用系统自带的 `csc.exe` 把 `launcher/Launcher.cs.template` 编译成启动器 exe → 在
`HKCU\Software\{Google\Chrome,Microsoft\Edge}\NativeMessagingHosts\com.recallflow.bridge`
写登记项（**用户级，不需要管理员**）→ 最后跑一遍自检。

装完**必须手动做一次**：在 `edge://extensions`（或 `chrome://extensions`）点本扩展的「重新加载」。
因为这次给 `manifest.json` 新增了 `nativeMessaging` 权限，不重载不生效。

其他用法：

```bash
node scripts/install-native-host.mjs --list-ids              # 只列出探测到的扩展 ID
node scripts/install-native-host.mjs --extension-id <ID>     # 手动指定（探测不到时用）
node scripts/install-native-host.mjs --dry-run               # 只打印将要执行的写操作
node scripts/install-native-host.mjs --uninstall             # 卸载：删注册表与构建产物
```

卸载后扩展会退回"手动启动"模式（`bash scripts/dev-up.sh`），其它功能不受影响。

## 自检（不依赖浏览器）

```bash
node scripts/verify-native-host.mjs                      # 用装好的 exe + 配置里的端口
node scripts/verify-native-host.mjs --host integrations/native-host/host.js --port 7811
```

它按**和 Chrome 完全相同的方式**启动宿主（管道 + 长度前缀帧），依次断言：
启动即自动 ensure、`ping→pong`、`status` 字段齐全、`ensure` 后端口真的可探活、定期心跳、
`stop` 只停自己启动的实例、stdin 关闭后宿主自行退出。native messaging 的失败多数是静默的，
所以这些断言是改这个目录后唯一可靠的回归手段。

## 生命周期（实测结论，别凭直觉推断）

| 事件 | 行为 |
|---|---|
| 浏览器关闭 / 扩展重载 | 宿主进程收到 stdin EOF 后退出；**它启动的 MCP server 也随之消失** |
| 浏览器重新打开（或 SW 被回收后醒来） | 扩展自动重连宿主 → 探活发现服务不在 → 立刻拉起一个 |
| 服务进程中途崩掉（OOM / 端口被抢） | 宿主的**看门狗**在下一个心跳（≤20s）把它拉回来；连续 3 次失败则停手，避免不断生成进程 |
| 端口上已有别人启动的服务 | 宿主只探活、不接管；`stop` 会明确拒绝，避免误杀 |

**为什么"服务活不过浏览器"**：Chromium 把 native messaging 宿主放进 job object，宿主
detached 出来的子进程同样在这个 job 里，所以浏览器一退就被一起回收。这不是我们代码的问题——
对照实验：宿主**不由浏览器启动**时，杀掉宿主，它拉起的 server 仍然存活（同一个 exe、同一份代码）。

于是最终语义是：**浏览器开着，服务就在**。对用扩展面板的人这已经够了；
但如果你要让 `127.0.0.1:7801` 独立于浏览器常驻（DSH / opencode 长期跑、不想一直开着浏览器），
就用 `bash scripts/dev-up.sh --daemon`（或后续做成开机自启）。此时宿主只会**复用**那个实例，不会接管它。

## 排障

| 现象（设置页「本地服务」显示） | 原因 | 处置 |
|---|---|---|
| 尚未安装本地宿主（host not found） | 没跑安装器，或换了仓库路径 | 重跑 `install-native-host.mjs` |
| 浏览器拒绝启动宿主（forbidden） | 宿主的 `allowed_origins` 不含当前扩展 ID | 重跑安装器（它会重新探测）；或 `--extension-id <edge://extensions 里显示的 ID>` |
| 宿主进程刚启动就退出（exited） | node 路径失效 / 仓库被移动 / 启动器未编译 | 重跑安装器；看 `%LOCALAPPDATA%\RecallFlow\logs\launcher.log` |
| 宿主已连接，但本地服务没在运行 | MCP server 启动失败（依赖没装、端口被占） | 看 `%LOCALAPPDATA%\RecallFlow\logs\mcp-server.log`；并确认 `cd integrations/opencode/recallflow-mcp && npm ci` |
| 状态灯绿，但扩展仍报"扩展未连接" | 两侧桥接 token 不一致 | 设置页「桥接 Token」与服务端 `RECALLFLOW_BRIDGE_TOKEN` 保持一致（默认值相同即可） |
| 服务被重启后，外部 agent 的工具报"未知会话" | 客户端带着上一个进程的 `mcp-session-id` | **已自动自愈**：服务端对这种请求改用无状态模式处理（见 `index.js` 的 `handleStaleSession`），客户端无需重启 |

日志都在 `%LOCALAPPDATA%\RecallFlow\logs\`：`launcher.log`（启动器）、`native-host.log`（宿主）、
`mcp-server.log`（服务本身）。

## 安全边界

- 注册表写在 `HKCU`，只对当前用户生效；卸载干净（`--uninstall`）。
- 宿主的 `allowed_origins` 只列本机探测到的那个扩展 ID，别的扩展无法调用它。
- 宿主自己不监听任何端口；监听 7801 的是 MCP server，且只绑回环地址。
- 宿主会在服务已存在时**只复用、不接管**：`stop` 不会去杀你手动启动的实例。

## 为什么需要 C# 启动器

两个硬约束（见 `launcher/Launcher.cs.template` 里的注释）：

1. Chrome/Edge 在 Windows 上启动 native host 走 `CreateProcess`，manifest 的 `path` 必须是**可执行文件**，
   `.bat` 不可靠；
2. 浏览器与宿主之间的标准流是**二进制长度前缀帧**，中间任何一层用文本方式读写（StreamReader/Writer）
   都会破坏帧，所以启动器全程操作 `BaseStream` 做字节级透传。

改动模板后重跑安装器即可重新编译；`bin/` 与 `host.config.json` 都是本机产物，不入库。

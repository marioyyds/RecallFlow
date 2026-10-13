# 本地服务（127.0.0.1:7801）：怎么起、怎么装、出问题怎么查

外部 agent（DSH / opencode）通过 MCP 调用 RecallFlow 的页面工具时，需要两件事同时成立：

1. 本机 `127.0.0.1:7801` 上有一个**常驻的本地服务**（代码在 `integrations/opencode/recallflow-mcp/`）；
2. **浏览器扩展连上它**（扩展是真正读页面的那一端）。

设置页「本地服务」的状态灯就是这个组合的体检结果：**绿 = 两者都成立**。
这份文档只讲"服务怎么起、怎么装、坏了怎么查"；工具本身见
[MCP 客户端集成](../README.md#与-mcp-客户端集成) 与 [recallflow-mcp/README.md](../integrations/opencode/recallflow-mcp/README.md)。

## 三种启动方式

按"使用者会不会写代码"排：

| 方式 | 适合谁 | 怎么做 | 服务生命周期 |
| --- | --- | --- | --- |
| ① **浏览器自动拉起**（native messaging，推荐） | 所有人 | 装一次宿主（下面两行命令），之后什么都不用做 | 跟着浏览器 |
| ② **一键安装包**（免 Node） | 不写代码的人 | 双击 `RecallFlow-Setup-<版本>.exe` | 跟着浏览器 |
| ③ **开发态脚本** | 改这个仓库的人 | `bash scripts/dev-up.sh`（`--daemon` 常驻） | 独立于浏览器 |

### ① 浏览器自动拉起（native messaging）

```bash
node scripts/install-native-host.mjs
# 然后在 edge://extensions（或 chrome://extensions）点本扩展的「重新加载」
# —— 这次给 manifest.json 新增了 nativeMessaging 权限，不重载不生效
```

之后的行为：**浏览器一开，服务就在**（扩展连上宿主 → 宿主发现服务没跑就拉起来；
服务中途崩掉，宿主的看门狗会在 20 秒内把它拉回来）。

安装器做的事：探测扩展 ID → 生成宿主 manifest → 用系统自带的 csc 编译启动器 →
写 `HKCU\...\NativeMessagingHosts\com.recallflow.bridge`（**用户级，不需要管理员**）→ 跑一遍自检。
卸载：`node scripts/install-native-host.mjs --uninstall`。

原理、日志位置与失败模式对照表见 [integrations/native-host/README.md](../integrations/native-host/README.md)。

### ② 一键安装包（给不写代码的人）

```bash
node scripts/build-dist.mjs --from-local-node    # 产出 dist/RecallFlow-Setup-<版本>.exe（约 24 MB）
```

双击安装：per-user 安装到 `%LOCALAPPDATA%\Programs\RecallFlow`，**不弹 UAC**，
开始菜单有入口，「应用和功能」里能正常卸载；**目标机器不需要装 Node**（内含便携 Node）。
体积构成、扩展 ID 识别顺序、升级路径的坑见 [packaging/README.md](../packaging/README.md)。

### ③ 开发态脚本（需要服务独立于浏览器常驻时）

```bash
bash scripts/dev-up.sh                  # 前台拉起，Ctrl-C 回收本次启动的进程
bash scripts/dev-up.sh --daemon         # 后台常驻（DSH/opencode 长期跑就用这个）
bash scripts/dev-up.sh status | logs | stop
bash scripts/dev-up.sh --with-static docs   # 顺带把 docs/ 挂成 http://127.0.0.1:8099（调试本地 HTML）
```

DSH 的 MCP 配置（`url` + `X-RecallFlow-Token`）示例在
[recallflow-mcp/README.md](../integrations/opencode/recallflow-mcp/README.md)。

## 状态与日志

- **设置页「本地服务」**：状态灯 + 「重启本地服务」/「停止」；
  灯红了会直接写出下一步该做什么（而不是只报英文错误）。
- **探活**：`curl http://127.0.0.1:7801/health` → `{"ok":true,"ws":true,...,"pid":...}`，
  其中 `ws:true` 表示扩展已连上。
- **日志**（`%LOCALAPPDATA%\RecallFlow\logs\`）：

| 文件 | 记录什么 |
| --- | --- |
| `launcher.log` | 浏览器启动宿主这一层（node 路径、启动失败原因） |
| `native-host.log` | 宿主：状态、看门狗动作、归属记录、退出 |
| `mcp-server.log` | 服务本体（端口、会话、错误） |

## 生命周期（有意设计，别当成 bug）

| 事件 | 行为 |
| --- | --- |
| 关闭浏览器 | 宿主退出，**服务随之消失** |
| 重新打开浏览器 | 自动恢复（无需任何操作） |
| 服务中途崩掉 | 宿主的看门狗 ≤20 秒拉回；连续 3 次失败停手，避免不断生成进程 |
| 端口上已有别人启动的服务 | 宿主只探活、不接管；「停止」会明确拒绝，避免误杀 |
| 需要服务独立于浏览器常驻 | 用 `dev-up.sh --daemon`（此时宿主只复用它，不接管） |

**为什么服务活不过浏览器**：Chromium 把 native messaging 宿主放进 job object，
宿主 detached 出来的子进程同样在其中，浏览器一退就被一起回收。这不是我们的代码问题 ——
对照实验：宿主**不由浏览器启动**时，杀掉宿主，它拉起的服务仍然存活（同一个 exe、同一份代码）。

## 排障

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 设置页：尚未安装本地宿主（host not found） | 没跑安装器，或仓库被移动过 | 重跑 `node scripts/install-native-host.mjs` |
| 设置页：浏览器拒绝启动宿主（forbidden） | 宿主的 `allowed_origins` 不含当前扩展 ID | 重跑安装器（它会重新探测 ID）；或 `--extension-id <扩展页里显示的 ID>` |
| 设置页：宿主刚启动就退出（exited） | node 路径失效 / 仓库被移动 / 启动器未编译 | 重跑安装器；看 `launcher.log` |
| 宿主已连接，但本地服务没在运行 | 依赖没装（`npm ci`）或端口被占 | 看 `mcp-server.log` |
| 状态灯绿，但工具报「扩展未连接」 | 两侧桥接 token 不一致 | 设置页「桥接 Token」与服务端 `RECALLFLOW_BRIDGE_TOKEN` 保持一致（默认值相同即可） |
| 工具报「未知会话」 | 服务被重启过，客户端还带着旧会话 ID | **已自动自愈**：服务端对未知会话改用无状态模式处理该次请求，重试即可 |
| 升级安装包后要等一会儿才恢复 | 扩展的重连退避（≤20s）+ alarms 每分钟兜底 | 正常；着急就重载一次扩展 |

## 扩展 ID 为什么是这一层最脆的地方

`allowed_origins` 必须与扩展 ID **完全一致**，差一个字符就是 `forbidden`，而浏览器不给任何解释。
发行包又不知道用户把扩展加载到了哪个目录，所以按可靠性依次识别：

1. 命令行 `--extension-id`（静默/企业部署）；
2. 扩展目录 = 安装目录；
3. **`Local Extension Settings\<扩展ID>\` 里有没有我们自己的存储键**（`recallflow.*`）——
   目录名就是扩展 ID，这是发行态唯一精确的办法；
   ⚠ 实测：浏览器 Preferences 里解压扩展的条目**只有 path、没有 manifest/name**，
   所以"按扩展名识别"在真实 Profile 上根本行不通（这条弯路走过一次）；
4. 扩展目录名白名单（完整目录名，不做包含匹配）；
5. 都失败 → 在终端里就提示粘贴 ID，否则退出码 3，由安装器给出指引。

细节与验收方式见 [packaging/README.md](../packaging/README.md)。

## 验收：改了这一层就跑这几条

```bash
node scripts/verify-native-host.mjs            # 宿主协议自检（不依赖浏览器，7 项）
node scripts/verify-installer.mjs              # 装→验→卸→验→恢复开发态（20 项）
node scripts/verify-installer-upgrade.mjs      # 运行中再装一次（升级路径，13 项）
```

后两条会**真的往本机安装**（写 HKCU 与 `%LOCALAPPDATA%`），跑完自动恢复成仓库开发态，可反复跑。

## 源码索引

| 文件 | 作用 | 详述 |
| --- | --- | --- |
| `lib/bridge/native-host.js` | 扩展侧：连接/重连/僵尸端口判定/alarms 兜底/状态 | 代码注释 + 设置页文案 |
| `integrations/native-host/host.js` | 宿主：长度前缀帧协议、看门狗、归属记录 | [native-host/README.md](../integrations/native-host/README.md) |
| `integrations/native-host/launcher/Launcher.cs` | 路径无关的 C# 启动器（字节级透传 stdio） | 同上 |
| `integrations/native-host/detect-extension.mjs` | 扩展 ID 探测（4 级） | 同上 |
| `scripts/install-native-host.mjs` | 开发态安装：编译 + manifest + 注册表 + 自检 | [scripts/README.md](../scripts/README.md) |
| `scripts/build-dist.mjs`、`packaging/` | 发行包与一键安装器 | [packaging/README.md](../packaging/README.md) |
| `scripts/dev-up.sh`、`scripts/serve-dir.mjs` | 手动常驻服务 + 本地静态服务 | [scripts/README.md](../scripts/README.md) |

## 已知边界

- **未签名的安装器会触发 SmartScreen「未知发布者」**：内部使用点"仍要运行"即可；
  对外分发需要代码签名证书（钱与流程，不是代码）。
- **安装器只装宿主**：扩展仍需用户自己在浏览器里加载（商店上架或企业策略才能免掉这一步）。
- **刻意不做开机自启**：服务已由浏览器按需拉起；再自启一个会和宿主抢端口，
  变成"别人的实例"（此时「停止」按钮会按设计拒绝接管）。

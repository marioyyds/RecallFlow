# packaging：一键安装器 + 免 Node 打包

> 用户视角的入口（怎么装、怎么卸、出问题怎么查）在
> **[本地服务（127.0.0.1:7801）](../docs/local-service.md)**；本文件讲构建与实现。

这层解决的是"M1 打包 / M2 安装"：把 RecallFlow 的本地服务宿主做成一个**双击即用**的安装包，
用户机器上**不需要装 Node.js**，也不需要开终端。

## 产物与构建

```bash
node scripts/build-dist.mjs                  # 下载官方便携 Node（校验 SHA256）+ 编译安装器
node scripts/build-dist.mjs --from-local-node # 离线构建：直接复制本机 node.exe（最快，本机开发用这个）
node scripts/build-dist.mjs --no-installer    # 只产出 payload（不调 ISCC）
```

产物（`dist/`，已 gitignore）：

| 文件 | 说明 | 体积 |
|---|---|---|
| `RecallFlow-Setup-<版本>.exe` | 安装器（Inno Setup 编译，含全部载荷） | ~24 MB |
| `payload/` | 要落进用户机器的文件 | ~89 MB |
| `payload/node.exe` | 便携 Node（免去用户自装 Node） | 88.5 MB |
| `payload/server.bundle.mjs` | MCP server（esbuild 打成单文件，**不需要 node_modules**） | 0.8 MB |
| `payload/recallflow-native-host.exe` | native messaging 启动器（与机器无关） | 8 KB |
| `payload/host.js` | 宿主 | 20 KB |
| `payload/install-host.mjs` | 安装/卸载时写注册表的脚本（打成单文件） | 60 KB |
| `RELEASE.txt` | 构建报告与各文件 sha256 | — |

构建步骤与"为什么要这样做"：

1. **esbuild 打单文件**：仓库自带 esbuild（无需新依赖）。实测 863 KB、0.4s，且在没有 `node_modules`
   的目录里能正常 `initialize` 并列出全部 13 个工具 —— 所以发行包不用带几百个小文件。
2. **便携 Node 而不是 SEA**：`node.exe` 本身就 88.5 MB，SEA 并不会更小，却要引入 postject、
   实验特性与更高的 AV 误报面。用官方 zip 时**必须校验 `SHASUMS256.txt`**（随包分发第三方二进制的前提）。
3. **启动器与机器无关**：`Launcher.cs` 现在运行时按 `launcher.config`（开发态）或同目录（发行态）
   解析 node 与 host.js，所以**编译一次即可到处发**，用户机器不需要 csc。
4. **冒烟测试写在构建里**：打完包立刻用**发行包自己的** `node.exe` + 启动器 + 单文件 server
   跑一遍真实协议（`verify-native-host.mjs`）。打出来的包跑不起来，构建就失败。

## 安装器做了什么（Inno Setup）

- **per-user 安装**（`PrivilegesRequired=lowest`）：装到 `%LOCALAPPDATA%\Programs\RecallFlow`，
  只写 `HKCU`，**不弹 UAC**；
- 复制载荷 → 注册 native messaging（Edge + Chrome）→ 建开始菜单快捷方式 → 写"应用和功能"卸载项；
- 结束时如果**还没在浏览器里加载扩展**，会明确提示怎么做（这是安装后最常见的失败原因）；
- 卸载：先反注册再删文件，**不动用户数据**（日志、证据目录保留）。

### 扩展 ID 是怎么认出来的（这里最容易翻车）

`allowed_origins` 必须与扩展 ID 完全一致，差一个字符就是 `forbidden`，而浏览器不给任何解释。
发行包不知道用户把扩展加载到了哪个目录，所以按可靠性依次尝试：

1. `--extension-id`（静默/企业部署）；
2. 扩展目录 = 安装目录；
3. **`Local Extension Settings\<扩展ID>\` 里有没有我们自己的存储键**（`recallflow.*`）
   —— 目录名就是扩展 ID，这是发行态**唯一精确**的办法。
   ⚠ 实测：浏览器 Preferences 里解压扩展的条目**只有 path，没有 manifest/name**，
   所以"按扩展名识别"在真实 Profile 上根本行不通（这条弯路已经走过一次）；
4. 扩展目录名白名单（`bookmark-sorter` / `recallflow` 等**完整目录名**，不做包含匹配）；
5. 都失败 → 若在终端里则提示粘贴 ID，否则退出码 3，由安装器给出指引。

## 验收（M2 的回归资产）

```bash
node scripts/verify-installer.mjs           # 安装 → 校验 → 卸载 → 校验 → 恢复开发态注册（22 项）
node scripts/verify-installer-upgrade.mjs   # 运行中再装一次（升级路径，13 项）
```

两条都会**真的往本机装东西**，并在结束时把机器恢复到"仓库开发态"，可以反复跑。

### 升级路径为什么必须单独测

Windows 不允许覆盖正在运行的 exe，而**只杀进程不够**：扩展会在 1 秒内按注册表把宿主拉回来，
文件重新被锁住，安装器直接以退出码 5 失败（实测）。所以顺序必须是：

```
先反注册（扩展拉不起来，进入退避重试） → 停宿主与服务 → 替换文件 → 装完重新注册
```

另外 `--stop` 必须连**宿主本体**一起杀：它是 `{app}\node.exe` 跑 `host.js`，
只按镜像名杀 `recallflow-native-host.exe` 会漏掉它，卸载时 `node.exe` 就删不掉（实测残留）。

## 已知边界

- **签名**：未签名的安装器会触发 SmartScreen「未知发布者」。内部使用点"仍要运行"即可；
  对外分发需要代码签名证书（这是钱与流程，不是代码）。
- **扩展分发**：安装器只装宿主。扩展仍需用户自己在浏览器里加载（商店上架或企业策略才能免掉这一步）。
- **不做开机自启**：服务由浏览器按需拉起（native messaging），再自启一个反而会和宿主抢端口。
- Inno Setup 是构建期依赖（`ISCC.exe`）：`scripts/build-dist.mjs` 会自动在 PATH 与常见安装位置里找，
  找不到就跳过安装器生成并给出提示。本机是用户级安装（`%LOCALAPPDATA%\Programs\Inno\ISCC.exe`）。

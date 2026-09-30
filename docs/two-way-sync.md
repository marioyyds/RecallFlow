# RecallFlow ↔ DSH 集成：运维手册（单会话架构）

> 这份文档解决一个具体问题：**改完代码后到底要重启什么、以及怎么确认它真的生效了。**
> 它由旧的「双向同步」文档改写而来 —— 那版描述的是"两段对话互相同步"的架构，
> 已于 2026-10-01 被单会话架构取代（面板的话直接成为 DSH 会话里的用户消息）。
> 旧版里**与架构无关**的排查经验（重启矩阵、如何判断新旧代码、PowerShell 的坑）保留了下来。

## 架构（一张图）

```
DSH（一条会话，唯一真相）
  ├─ DSH Web GUI            主视图
  ├─ RecallFlow 面板         同一个会话的另一个视图 + 输入口（已退役自己的 agent）
  └─ recallflow_browser      页面能力：由插件注册，经 WS 转给扩展执行
       └─ 扩展 ──WS──▶ 7801 桥接 ──▶ opencode 的页面能力（与 DSH 无关的那条链路）
```

插件（`integrations/dsh-plugin-recallflow-one/`）挂在 **DSH 自己的端口**上，对外三件事：

| 端点 | 作用 |
|---|---|
| `POST /recallflow/say` | 面板打的字 → **这条会话的真实用户消息**（`agent.send(msg,'next-turn',true)`） |
| `WS /recallflow/ws` | 会话事件往下推；工具调用/回执来回走 |
| `GET /recallflow/status` | 连接与登记状态（排查用） |

**7801 桥接仍然存在，但不再是"中继"** —— 它是 **opencode 的页面能力出口**，不能删。
详见 `docs/deletion-plan.md` 的保留清单。

## 改完代码要重启什么（这张表能省掉大量排查）

| 改动位置 | 需要做什么 | 为什么 |
|---|---|---|
| `lib/page/**`、`background.js`、`lib/bridge/**`、`manifest.json` | **重载扩展**（`edge://extensions` → RecallFlow → ↻），并刷新页面 | 扩展代码只在加载时读取 |
| `integrations/dsh-plugin-recallflow-one/**` | **重启 DSH**（`dsh plugin` 只转发给 pnpm，没有 reload 子命令） | 插件由 DSH 的 loader 在启动时载入 |
| `~/.dsh/profiles/web/cordis.patch.yml` 或 `package.json` | **重启 DSH** | 这两个文件只在启动时读取 |
| `integrations/opencode/recallflow-mcp/**` | **重启桥接**（必须在**你自己的终端**里跑，见踩坑第 1 条） | 常驻进程，代码在启动时载入 |

## 怎么确认跑的是新代码（别靠"应该重启过了"）

```powershell
# 插件：/recallflow/status 是新版才有的路由。404 = DSH 还没重启。
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:3080/recallflow/status
```

```powershell
# DSH 进程启动时间：与插件相关提交的时间比大小
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'bin\.js' -and $_.CommandLine -match 'web' } |
  Select-Object ProcessId, CreationDate
```

> **PowerShell 5.1 注意**：`Invoke-WebRequest -SkipHttpErrorCheck` 是 PowerShell 7 才有的参数，
> 5.1 上报 `NamedParameterNotFound`。等价写法是 `try/catch` 取
> `$_.Exception.Response.StatusCode.value__`，或者用 `curl.exe`。

## 一眼体检（推荐先跑这个）

```powershell
node scripts/verify-live-gate.mjs
```

它一次性回答五件事，也是端到端验证的闸门：

| 检查 | 判读 |
|---|---|
| `GET /recallflow/status` 是否 200 | 404 = DSH 还没重启（跑的是旧插件代码） |
| `status.clients >= 1` | 扩展是否连上了新通道（0 = 扩展没重新加载） |
| `status.sessions` 非空 | 插件是否找到了会话（空 = 注册表兜底也没找到 agent） |
| 桥接 `/health` 的 `ok` | opencode 那条链路是否还活着 |
| 桥接 `/health` 的 `ws` | 扩展是否还连着桥接（`false` 时 opencode 的页面工具拿不到结果） |

加 `--say` 会**真的发一句话进会话**（有副作用），用来验证输入通道。
第 5 条闸门（"DSH 里调用 `recallflow_browser` 能往返"）脚本查不了 —— 那个工具只能由模型调用。

```powershell
# 直接把一句话送进会话（不依赖扩展，只依赖插件）
node scripts/probe-say.mjs "测试文本"
# 期望：{"ok":true,"rpcId":"recallflow-…","sessionId":"session-…"}
```

## 踩过的坑（每一条都真的发生过）

1. **常驻桥接不能由 agent 会话启动。** 用 DSH 的后台任务或 `Start-Process` 起的进程都属于
   该会话的 Windows Job Object，**DSH 一重启就被连带回收**，表现为"重启后又没有同步了"。
   正确做法：**在你自己的终端窗口里启动，并保持窗口开着**。
2. **Windows 上 `import()` 不接受裸绝对路径。** 插件借 DSH 依赖树里的 `ws` 时必须
   `pathToFileURL(p).href`，否则报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
   我第一次的探针只做了 `resolve` 没真的 `import`，所以没暴露它 —— 是插件里的诊断日志抓住的。
   教训：**验证要走到"真的用一次"，别停在"能解析"。**
3. **`inject` 不会唤醒空闲会话。** 参考实现源码注释原文：
   "inject() never wakes an idle driver … can only target this live turn's next step."
   要让外部输入**开启**一轮，必须用 `agent.send(msg,'next-turn',true)`。
4. **`source.kind` 决定消息性质。** `kind:'user'` 才是真用户消息；自定义 kind 只会落成
   模型侧上下文（界面上看不见）。实测过两种，差别就在这一个字段。
5. **`ctx.tools.register` / `ctx.webServer.register` 之前必须先 `inject` 声明服务名**，
   否则读取报 `cannot get property … without inject`。
6. **迁移不等于替换：先核对消费者清单。** 我一度把扩展的桥接连接"换成"指向 DSH，
   差点让 opencode 的页面工具**静默失效**（7801 桥接不只服务 DSH）。
   `scripts/scan-deletion-consumers.mjs` 就是把这个教训做成工具；
   但它也看不到"另一个进程"这类消费者 —— 那只能靠配置与文档确认。
7. **`chrome.storage.session` 会在重载扩展时被清空**，而"重载扩展"恰恰是改代码的必经步骤 ——
   于是每次更新都静默丢掉面板对话与绑定。已改存 `chrome.storage.local`（tab 关闭时清理）。
8. **面板收起时不能丢弃事件。** 早期实现在入口 `if (!panelStep) return`，而面板默认是收起的，
   于是事件**连历史都进不去**。现在是无条件记录、面板打开时补齐渲染。
9. **外部条目不能走 `appendStep`。** 它只把节点加进 `flowEl`，而 `flowEl` 只在一次 agent 运行
   期间存在 —— 事件随时会来，那时节点被静默丢弃，表现为**导出里有、屏幕上看不到**。
10. **同一个组件被两条路径按不同对象作键，会产生两条进度记录。** 去重键必须用**稳定 id**，
    不能用对象身份（`agent/created` 传的 `agent.session` 与 `session/event` 传的 session
    是同一会话的不同对象）。
11. **改动引入的副作用要顺着数据流走一遍。** 面板"直送 DSH"之后，既有的增量推送会
    **再发一遍**同一句话（它按计数器判断）—— 于是用户看到自己说的话出现两次。
    已改成直送成功后把计数器推到"目前全部已推送"。

## 已知限制 / 未验证

- **`recallflow_browser` 的完整往返尚未由模型实测**：注册成功有强证据（工具 schema 出现在
  模型工具表里），WS 升级与广播在隔离实例上验证过，但"调用它拿到真实页面数据"这一步
  还没跑过。
- **opencode 那条链路此刻无法验证**：7801 桥接当前未运行。删除清单第 4、5 步**必须等它恢复**
  才能做 —— 那两步要确认"opencode 的页面工具仍正常"。
- **面板侧渲染的观感未验证**：会话事件在面板里的显示（含对齐 DSH 原生气泡的样式）
  只在代码层核对过，需要真实面板确认。
- 面板的本地 agent 仍保留为**退路**（DSH 送不进去时回退），这是过渡形态，不是最终形态。

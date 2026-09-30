# 双向同步：生效条件、验证方法、踩过的坑

DSH 与浏览器里的 RecallFlow 面板之间的同步有**两个方向**，它们的生效条件不同、
失败时的表现也不同。这份文档解决一个具体问题：**改完代码后，到底要重启什么？**

## 两个方向

| 方向 | 链路 | 看到什么 |
|---|---|---|
| **DSH → 面板**（正向） | 插件订阅 `session/event` → `POST /event` → 桥接 → 扩展 → 面板 | 面板上出现 `👤 你在 DSH：…` / `📣 DSH：…` / `🔧 DSH → 工具名` |
| **面板 → DSH**（反向） | 面板 `saveConversation` → 后台 → `POST /panel-turns` → 桥接环形缓冲 → 插件在会话创建时 `GET /panel-turns` 并 `agent.inject` / 或模型主动调 `panel_history` | DSH 会话上下文里出现「浏览器 RecallFlow 面板最近的对话」；模型也能用工具读回 |

**注意**：面板 AI 与 DSH 里的 agent 是**两个不同的 agent**。注入的上下文与工具的返回里
都写明了这一点 —— 不写的话模型会把面板 AI 的结论当成自己的。

## 改完代码要重启什么（这张表能省掉大量排查）

| 改动位置 | 需要做什么 | 为什么 |
|---|---|---|
| `lib/page/**`、`background.js`、`lib/bridge/**`、`manifest.json` | **重载扩展**（`edge://extensions` → RecallFlow → ↻） | 扩展代码只在加载时读取 |
| `integrations/opencode/recallflow-mcp/**` | **重启桥接**（终端 Ctrl+C → 再跑一次） | 常驻进程，代码在启动时载入 |
| `integrations/dsh-plugin-recallflow/**` | **重启 DSH** | 插件由 DSH 的 loader 在启动时载入 |
| `~/.dsh/profiles/web/cordis.patch.yml` 里的条目 | **重启 DSH** | 该文件只在 DSH 启动时读取 |

**怎么确认某个组件跑的是不是新代码**（别靠"应该重启过了"）：

```powershell
# 桥接：有没有反向通道的读端（新代码才有）。404 = 旧代码。
curl.exe -s -o NUL -w "%{http_code}`n" `
  -H "X-RecallFlow-Token: recallflow-local-bridge-v1" `
  "http://127.0.0.1:7801/panel-turns?limit=1"
```

> 上面这条在 **PowerShell 5.1**（Windows 自带版本）实测可用。
> 别用 `Invoke-WebRequest -SkipHttpErrorCheck` —— 那是 PowerShell 7 才有的参数，
> 在 5.1 上报 `NamedParameterNotFound`。5.1 上等价写法是 `try/catch` 取
> `$_.Exception.Response.StatusCode.value__`。

```powershell
# DSH：比较进程启动时间与插件提交时间（启动早于提交 = 加载的是旧插件）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'bin\.js.{1,4}web' } |
  Select-Object ProcessId, CreationDate

git log -1 --format='%ci %s' <插件相关提交>   # 与上面的 CreationDate 比大小
```

## 验证（两个方向各自怎么确认）

1. **正向**：让 DSH 说一句话，面板上应出现 `📣 DSH：…`。
   若没有，看你启动桥接的终端窗口里有没有 `[event] ws · say/dsh · …`：
   - **有** → 事件到了服务端，断点在扩展/面板（先重载扩展；面板收起时按设计只记录不渲染，
     打开面板会补齐）
   - **没有** → 插件没在推（DSH 是不是没重启？）

2. **反向**：在面板里跟它聊两句，然后让 DSH 调 `panel_history` 工具（或重开一个 DSH 会话，
   会自动注入）。读回来是空的 → 依次检查：扩展重载了吗 → 桥接是不是新代码 → 面板的对话
   是否真的产生过（空对话不会上报）。

3. **装载与否**：插件 `apply()` 一被调用就会推一条「RecallFlow 同步插件已装载」。
   在面板或桥接日志里看到它，就说明插件确实挂上了 —— 这比"应该挂上了"可靠。

## 踩过的坑（每一条都真的发生过）

- **常驻桥接不能由 agent 会话启动。** 用 DSH 的后台任务或 `Start-Process` 起的进程都属于
  该会话的 Windows Job Object，**DSH 一重启就被连带回收**，表现为"重启后又没有同步了"。
  正确做法：**在你自己的终端窗口里启动，并保持窗口开着**。
- **`chrome.storage.session` 会在重载扩展时被清空**，而"重载扩展"恰恰是每次改代码的必经步骤 ——
  于是每次更新都静默丢掉面板对话与绑定。已改存 `chrome.storage.local`（tab 关闭时清理）。
- **面板收起时不能丢弃事件。** 早期实现在入口 `if (!panelStep) return`，而面板默认是收起的，
  于是事件**连历史都进不去**。现在是无条件记录、面板打开时补齐渲染。
- **外部条目不能走 `appendStep`。** 它只把节点加进 `flowEl`，而 `flowEl` 只在一次 agent 运行
  期间存在 —— 事件随时会来，那时节点被静默丢弃，表现为**导出里有、屏幕上看不到**。
- **注入必须用官方的 `Agent.inject`**，不能自己往会话里 append 事件：前者「不出动 driver、
  在最近的步边界被认领」，不会打断运行中的循环；后者可能破坏 agent loop 的状态机。
- **注入用的 `source.kind` 必须同时列进 `INJECTED_SOURCE_KINDS`**，否则注入的上下文会被
  当成"用户说的话"再推回面板，**形成回环**。
- **面板的用户回合不会紧随 `saveConversation`**（面板里是 push 之后才在别处保存），
  所以反向上报必须按**已推条数增量**推送，不能"只取最新一条"——后者会永远跳过用户回合。

## 已知限制

- 助手的成文回答在面板上按 **2000 字**截断（用户自述 1200；工具参数 160）。面板是窄条，
  更长会挤爆存储与观感。
- 反向注入**只在会话创建时发生一次**；会话进行中面板有了新内容，需要模型主动调
  `panel_history`。
- 系统注入的运行时上下文（`source.kind === 'runtime-context'`）会被正向同步**过滤掉**，
  不会显示成"用户说的话"。

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

## 一条消息的完整路径（含字段形状）

这张表是这次重构里**最贵的东西** —— 它是靠"读 DSH 自己的类型声明 + 实测"攒出来的，
而重写时最容易丢的正是它（本会话丢了 12 次，每次的症状都是"什么都没报错，只是有东西不显示"）。

**① 面板 → DSH**

```
面板 run(instruction)
  → conversation.push({ role:'user', content, id }) + appendUserTurn()   ← 必须立刻画（回声只标记不追画）
  → sendPanelTurn(turn)  → 后台 panel:turn → sayToDsh(text) → POST /recallflow/say
  → 响应 {ok, rpcId, sessionId} → 把 rpcId 回填到**那个 turn 对象**上（顺序不能反）
插件 agent.send({ id, role:'user', content:[{type:'text',text}], source:{kind:'user', rpcId} },
                 'next-turn', true)                                      ← kind 必须是 'user'；第三参 true 才唤醒
```

**② DSH → 面板**（插件 `projectEvent` 的字段形状，全部来自 DSH 的类型声明）

| 事件 | 文本/名字在哪个字段 | 投影成 |
|---|---|---|
| `user/message` | `data.content` | `{type,role,sourceKind,rpcId,text}` |
| `assistant/message` | **`data.message.content`**（不是 `data.content`） | `{type,role,text}` |
| `tool/call` | 名字在 **`data.name`**；参数在 **`data.arguments`**（**JSON 字符串**，要解析） | `{type,tool,args}` |
| `tool/result` | `data.message.toolCallId` + `data.error`；**只在失败时投影** | `{type,tool,failed,error}` |

```
WS 广播 {kind:'session-event', sessionId, event}
  → 扩展 handleDshMessage → forwardSessionEvent
  → chrome.tabs.sendMessage({ type:'rfSessionEvent', frame })
  → 面板 renderSessionEvent → sessionEntryFromFrame（纯函数，有单测）：
      用户消息：先按 rpcId 精确匹配本地回合 → mark-local（只标记）
      助手消息 / 工具行 → append（⚙ 名字（k=v） / ✗ 调用 X 失败：原因）
      系统注入上下文（sourceKind 或文本前缀）→ 跳过
```

**③ 落盘**：先按同一套规则裁剪（工具行 ≤60、外部条目 ≤200）再截断，
并**必须带上** `kind` / `rpcId` / `echoedFromSession` / `id`
（不带 = 重载后限流与精确去重静默失效；这是踩过的坑）。

### 这条路径的每一段分别被什么验证过（如实标注）

| 段 | 验证方式 |
|---|---|
| ① 送进会话 | **实测**：`POST /say` 返回 `{ok:true,sessionId}`，那句话随后以**真用户消息**出现在会话里 |
| ② 事件形状 | 单测（用从 DSH 类型声明恢复的真实形状 —— 不是猜的） |
| ② 广播 | **实测**：`/status` 计数 12 进 12 出、零丢零错；且面板里出现过我工具调用的参数 |
| ② 面板渲染逻辑 | 单测（`lib/shared/session-view.js` 全部纯函数） |
| ② 面板 **DOM 观感** | ❌ **未实测**（需要重载扩展/刷新页面） |
| ③ 落盘 | 单测（序列化契约） |
| **端到端（一句话 → 会话 → 回复回到面板）** | ⏳ **未完成** —— 缺"重启 DSH + 重载扩展/刷新页面"这两步 |


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
12. **删实现会连带删掉它的「隐式契约」。** 我删掉桥接里 `recordPanelTurn` 的连续去重时，
    查过它的**调用方**（没有），却没查**依赖这个行为**的地方 —— 而面板的 `loadConversation`
    正是靠它兜住"每次刷新页面重推最近 6 条历史"的。于是拆掉去重之后，每次刷新都会把
    面板缓存的旧消息以**真实用户消息**身份重新灌进会话（还会唤醒空闲会话）。
    这是与"引用型消费者"不同的**行为型依赖**：`scripts/scan-deletion-consumers.mjs`
    只能扫引用，扫不到这一类 —— 线索往往只写在一句注释里（"由服务端去重兜住"）。
    **判断能不能删，不能只看"有没有人 import"。**

## 已知限制 / 未验证

- **✅ 已解决（第 19 轮留下的线索）：会话事件的推送是健康的。**
  当时观察 12 秒只收到 hello 与 pong、没有 session-event，我把它记成待查。
  加上计数与兜错之后（`/recallflow/status` 暴露 `eventsSeen / eventsBroadcast /
  eventsDropped / eventsErrors / lastEventType`），重启后一条 curl 就有答案：

  ```
  "eventsSeen":12, "eventsBroadcast":12, "eventsDropped":0, "eventsErrors":0,
  "lastEventType":"tool/call"
  ```

  12 条事件全部广播成功、零丢零错 —— 处理函数被正常调用，广播也发出去了。
  **诚实的保留**：第 19 轮那次观察为什么是空的，没有查清（当时跑的是更早的插件代码，
  我没有逐版对照）。现在的结论基于当前代码的实测计数，而不是对那次现象的复现与解释。
- **`recallflow_browser` 的往返已实测通过**：`node scripts/probe-tool.mjs page_health`
  返回 HTTP 200 与真实页面数据（tabId / pageUrl / network 都对）；`browser_read` 那次
  还带回了扩展自己的校验信息（"仅支持 http/https URL"）—— 说明**整条链**
  （插件 → WS → 扩展 → 它自己的方法实现 → 回执）都是通的，而不只是"某处返回了 200"。
- **opencode 那条链路**：桥接在跑（`/health` 的 `ok` 与 `ws` 都为真），但**跑的是旧代码** ——
  `events` / `panelTurns` 字段还在、`/panel-turns` 仍返回 200。删除清单第 4 步的改动
  （`c80fb0a`）要等用户重启桥接才会生效；重启后需先验证 opencode 仍正常，再做第 5 步。
- **面板渲染：一半已确认，一半仍未确认**（这一节被改过两次，因为它两次被我写过头）。
  - ✅ **样式**：读面板里 `.msg.ext.ext-user` 与 `.msg.ext` 的计算样式，逐项等于 DSH 自己的值
    （`background-color: rgb(237,243,254)` / `border-radius: 20px` / `padding: 10px 16px` /
    `font-size: 14px` · `line-height: 22px` / `border-left-width: 0px` —— 旧的"哪一边"竖线确实没了）。
  - ✅ **面板确实在收这条会话的事件**：面板里那两行工具活动的参数是我自己传的
    （`⚙ page_screenshot（label=面板渲染检查）`、`⚙ verify_change（targets=[…]）`），
    只可能来自会话事件。
  - ❌ **但"助手的文字回复可见"仍未验证**：查面板正文全文，一行助手文字都没有。
    根因已找到并修复（DSH 的 `assistant/message` 把文本放在 `data.message.content`，
    而插件读的是 `data.content` —— 见 `c80fb0a` 之后的 `5a07de6`），但插件要重启 DSH 才生效。
  - ⚠️ **另一个待复核项**：当前 `classifyFrame` 对**没有 text 的事件一律跳过**
    （注释明写"工具活动等不进面板"），按当前代码那两行工具活动**不该出现** ——
    说明运行中的扩展是更早的构建。重载扩展后需要复核：工具活动是否还在、
    助手文字是否出现。**在复核之前，不要引用"面板渲染已完整验证"。**
- **面板的本地 agent 仍保留为退路**（DSH 送不进去时回退），这是过渡形态，不是最终形态。
- **旁注（与本项目无关）**：排查时看到 DSH 自己的 `/api/changes.summary` 返回 404。
  它来自 DSH 自身的 `ctx.workspaceChanges.summary(...)`（在 DSH 的 bundle 里，
  不在本仓库），报错里那个 `bookmark-sorter\plugins` 位置是源码映射的假位置。
  记录在此只为避免下次重复排查。
- **旁注**：`~/.dsh/profiles/web/pnpm-lock.yaml` 里仍有 `dsh-client-recallflow-panel` 的条目
  （该包已在第 2 步整包移除）。这是锁文件的正常滞后，下次 `pnpm install` 会 prune，
  不影响启动（已实测 `--profile web --help` 退出码 0）。我不手改锁文件 —— 风险大于收益。

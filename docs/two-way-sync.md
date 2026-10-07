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
       └─ 扩展 ──WS(3080)──▶ DSH 插件 ──▶ 内容脚本 / CDP 执行
```
（图上原来还有一条 `扩展 ──WS──▶ 7801 桥接 ──▶ opencode 的页面能力`；
用户 2026-10-08 明确不再用 opencode 后，那条链路已整体删除。现在扩展只连 3080。）

插件（`integrations/dsh-plugin-recallflow-one/`）挂在 **DSH 自己的端口**上，对外三件事：

| 端点 | 作用 |
|---|---|
| `POST /recallflow/say` | 面板打的字 → **这条会话的真实用户消息**（`agent.send(msg,'next-step',true)`） |
| `WS /recallflow/ws` | 会话事件往下推；工具调用/回执来回走 |
| `GET /recallflow/status` | 连接与登记状态（排查用） |

~~**7801 桥接仍然存在，但不再是"中继"** —— 它是 **opencode 的页面能力出口**，不能删。~~
**2026-10-08 更正**：这条已经反过来了 —— 用户明确说不再用 opencode，那个"不能删"的理由
（它是 opencode 的出口）随之消失，桥接整包与扩展侧通道已一起删除。
见 `docs/deletion-plan.md` 的「已从保留清单移除」一节。
**教训留着**：当时"不能删"的判断是对的，错的是把它当成永久结论 —— 消费者的存续要**问**，不能靠 grep。

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
                 'next-step', true)                                      ← kind 必须是 'user'；第三参 true 才唤醒
                 // 第二参用 'next-step'：'next-turn' 要等整轮结束、且可能在轮次边界被清掉
                 // （用户反馈"发了没反应"就是这个；见 docs/one-session-plugin.md 末尾）
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


## 工具结果的加工在哪（一条容易重复实现的地方）

扩展返回的是**原始 JSON**；给模型看的形状（磁盘路径、元素源码、增量诊断）全靠一层加工。
这层加工**只有一份实现**：`lib/shared/tool-results.js`。桥接与 DSH 插件都调它。

| 函数 | 用途 |
|---|---|
| `shapeTextResult` | read_console / read_network：调用栈里的源码 URL → 磁盘路径 |
| `shapeElementSourceResult` | get_element_source：file/line/column/framework/component + selector + hint |
| `shapePickedElementResult` | get_picked_element：走共享的字段归一化 |
| `shapePageHealthResult` / `shapeVerifyChangeResult` | 增量摘要 / 断言求值 + newIssues |
| `resolveTargets` / `cursorOverrideFrom` | verify_change 的 targets 解析、args.cursor 三态 |
| `applyToolResult` | 一站式：按方法名分派，插件的 execute 调它 |

**游标（"自上次检查以来"的起点）刻意留各自进程**：它的语义是"自**我**上次检查以来"，
共享会让一方吃掉另一方的增量。所以这几个函数返回 `{ result, cursor }`，由调用方存。
（桥接：`healthCursorByTab`；插件：`toolCursors`。桥接里 page_health 与 verify_change
**共用**一个游标是刻意的 —— 验证改动会消费掉其间产生的错误，不会重复报警。）

**为什么在意这件事**：这层加工原来**只在桥接里**，插件的工具返回原始 JSON ——
也就是说删掉 DSH 的 MCP client 会让 DSH **静默失去「元素 → 源码文件」**（不报错，只是没路径）。
现在两边是字面意义上的同一份代码，并有契约测试钉住"不许再各自内联写一份"
（`tests/bridge-contract.test.mjs` 的"结果加工只有一份实现"）。

## 改完代码要重启什么（这张表能省掉大量排查）

> **先看这条**：DSH **自己**有一套插件重载生命周期，而且它可能不需要整进程重启。
> `dsh-plugin-manager` 里的 `reload()` 长这样（源码，`lib/types/index.js:809, 819`）：
>
> ```js
> application: this.ownerContext.get('hmr') !== undefined ? 'applied' : 'restart-required'
> ```
>
> 也就是说：**如果 DSH 装了并启用了 `dsh-hmr`，插件改动可以直接热生效**（返回 `applied`）；
> 否则它明确告诉你 `restart-required` —— 两种情况都**不会**硬重启进程，所以试着触发它是安全的。
> DSH 的包里**确实有** `dsh-hmr`（服务端）与 `dsh-client-hmr`（客户端，我实测到它在运行实例里被加载）。
>
> 触发入口是 **GUI 的插件管理器**（或它的 TypertRemoteService API，那个在鉴权栅栏后面）。
> 两点如实说明：
> - `dsh plugin` **不能**重载 —— 它是 pnpm 的转发（`lib/bin.js:115-119` 原文：
>   "forwarding the remaining arguments to pnpm in the profile directory"，且要求至少一个 pnpm 参数）。
> - 这个 profile **没有**把 `plugin_manager` 暴露成 agent 工具，所以我（模型）**不能**替你触发它。
>
> 所以：**先看插件管理器里有没有"应用/重载"的入口**；没有，或者显示 `restart-required`，
> 就按下面的表重启对应进程。

| 改动位置 | 需要做什么 | 为什么 |
|---|---|---|
| `lib/page/**`、`background.js`、`manifest.json` | **重载扩展**（`edge://extensions` → RecallFlow → ↻），并刷新页面 | 扩展代码只在加载时读取 |
| `integrations/dsh-plugin-recallflow-one/**` | **重启 DSH**（`dsh plugin` 只转发给 pnpm，没有 reload 子命令） | 插件由 DSH 的 loader 在启动时载入 |
| `~/.dsh/profiles/web/cordis.patch.yml` 或 `package.json` | **重启 DSH** | 这两个文件只在启动时读取 |
| `lib/shared/**` | **看谁 import 它** —— 见下 | 同一份文件被两边引用 |

**`lib/shared/**` 为什么单独一行**：这些文件被**两方**分别引用，改一个文件要重启哪几个进程，
取决于**谁 import 了它**。下面这份清单是**量出来的**（不是凭印象）：

| 谁 | 直接 import 的 `lib/shared/*` |
|---|---|
| DSH 插件（`integrations/dsh-plugin-recallflow-one/`） | `dev-session`、`evidence-store`、`tool-results` |
| 扩展（`lib/page/**`、`lib/bridge/**`、`background.js`） | `bridge-methods`、`handoff`、`handoff-store`、`panel-turns`、`session-binding`、`session-view`、`settings`、`store`、`rag`、`table`、`utils` |

（这里原本还有**第三方**：7801 桥接那个 node 进程，它同样 import `dev-session` / `evidence-store` /
`tool-results`。用户 2026-10-08 明确不再用 opencode 后，桥接整包已删除，所以**改这三个文件现在
只需要重启 DSH**（插件那侧），不必再重启什么常驻进程。）

（`dev-paths` / `page-health` / `verify-change` 不在插件与扩展的直接清单里 ——
它们由 `tool-results` 传递引入。所以改它们要重启的是**同一个组合**：DSH。）

所以，举例：

- 改 `tool-results.js` → **插件与桥接都要重启**，扩展不用动。
  （量过：import 它的只有插件、桥接与两个测试文件。）
- 改 `session-view.js` → **要重载扩展**，DSH 与桥接不用动。
- 改 `dev-paths.js` → 经 `tool-results` 影响到插件与桥接 → **两边都要重启**。

我踩过一次：在 `tool-results.js` 里改了东西、只重启了 DSH，然后纳闷桥接为什么没有那个改动。

## 怎么确认跑的是新代码（别靠"应该重启过了"，也别靠比时间）

**插件**：`/recallflow/status` 带一个 `build` 字段 —— 它是插件在**装载时**算的自身文件指纹
（路径、字节数、mtime、内容 `sha256` 前 12 位）。拿它跟磁盘上的文件比即可：

```powershell
$want = (Get-FileHash 'D:\Desktop\workspace\code\ai\bookmark-sorter\integrations\dsh-plugin-recallflow-one\index.js' -Algorithm SHA256).Hash.ToLower().Substring(0,12)
$got  = (curl.exe -s http://127.0.0.1:3080/recallflow/status | ConvertFrom-Json).build.sha256_12
"磁盘=$want  已载入=$got  " + $(if ($want -eq $got) { '✓ 一致' } else { '✗ 需要重启 DSH' })
```

三种结局的含义：

- **`build` 字段不存在** → 跑的是加这个字段之前的旧代码，重启 DSH。
- **两者不同** → 改了代码但还没重启（这正是最需要分辨的时刻 —— 磁盘与已载入**故意**在这里不同）。
- **一致** → 已载入的就是磁盘上这一版。

`node scripts/verify-live-gate.mjs` 的第 1 条做的就是这件事（它以前只看
`/recallflow/status` 是否返回 200 —— 那个路由在任何近期版本里都有，所以**答不出**这个问题，
我自己就被它误导过：看到 ✓ 以为跑的是新构建，实际差了一次重启）。

**桥接与扩展没有等价的字段** —— 它们只能靠"进程/扩展是什么时候起来的"来推断。
（**2026-10-08 起只剩扩展与 DSH**：7801 桥接已删除，所以下面那条 `/health` 不再有意义；
保留是说明"当时还多一个常驻进程要判断"。）

```powershell
# （已删除）桥接：/health 的 uptimeMs 直接告诉你它跑了多久
# curl.exe -s -H "X-RecallFlow-Token: recallflow-local-bridge-v1" http://127.0.0.1:7801/health

# DSH 进程启动时间（推断用；插件请优先用上面的 build 指纹）
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
（这一行原本还有两条：`桥接 /health 的 ok` = "opencode 那条链路是否还活着"、
`桥接 /health 的 ws` = "扩展是否还连着桥接（false 时 opencode 的页面工具拿不到结果）"。
**2026-10-08 起删除** —— 用户不再用 opencode，桥接已不存在，这两个信号随之消失；
扩展现在只连 3080，判断"扩展在不在"用 `status.clients` 一条就够。）

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
   要让外部输入**开启**一轮，必须用 `agent.send(msg,'next-step',true)`。
   （这里原本写的是 `'next-turn'` —— 那个 target 要等**整轮结束**、且可能在轮次边界被清掉，
   用户反馈"发了没反应"就是它；见踩坑第 13 条。）
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
13. **同一条 API 的"目标"参数不同，语义差很远 —— 而两种都能返回成功。**
    面板消息最初用 `agent.send(msg, 'next-turn', true)`：`/say` 返回 `ok:true`、会话里却看不到。
    原因埋在 DSH 自己的类型声明里（`dsh-agent/lib/types/runtime-types.d.ts`）：
    `InboxTarget = 'next-turn' | 'next-step'`，而 `send` 的注释写着 cancel 之后
    "…even when its **message is cleared before the driver claims** it"。
    `'next-turn'` 要等**整轮结束**才可能被取走；这个会话连续跑目标轮时，消息在轮次边界被清掉。
    改成 `'next-step'`（当前这一轮的下一个步骤就取走）后正常。已由
    `tests/dsh-one-plugin.test.mjs` 钉住 —— 并**验证过**改回 `'next-turn'` 会让它失败。
    教训：**"接口返回成功"和"效果发生"是两件事**，尤其当参数是枚举时，要把每个取值的语义读全。

## 已知限制 / 未验证

- **✅ 已解决（第 19 轮留下的线索）：会话事件的推送是健康的。**
  当时观察 12 秒只收到 hello 与 pong、没有 session-event，我把它记成待查。
  加上计数与兜错之后（`/recallflow/status` 暴露 `eventsSeen / eventsBroadcast /
  eventsUnprojected / eventsErrors / lastEventType`），重启后一条 curl 就有答案：

  ```
  "eventsSeen":12, "eventsBroadcast":12, "eventsDropped":0, "eventsErrors":0,
  "lastEventType":"tool/call"
  ```

  > 上面那段输出是**当时的原文**，保留了它当时的字段名。那个字段后来**改名为
  > `eventsUnprojected`** —— 因为 `eventsDropped` 是个误导的名字：它不是"丢包"，
  > 而是"投影不出可展示的信息"，实测会到几十，主要来源是**成功的 `tool/result`**
  > （面板只画失败的工具行，这是刻意的）。当时的结论（零丢零错）不受影响。

  12 条事件全部广播成功、零丢零错 —— 处理函数被正常调用，广播也发出去了。

  `/recallflow/status` 现在还带 **`build`**：插件文件路径、字节数、mtime、
  以及**内容 sha256 的前 12 位**。用它可以确定"现在跑的是**已载入**的哪一版"——
  拿它跟 `Get-FileHash` 比对即可。它刻意在**装载时**算一次而不是每次现算：
  现算反映的是**磁盘现状**，而"改了代码但还没重启"时，这两者**正好不同**。

  **诚实的保留**：第 19 轮那次观察为什么是空的，没有查清（当时跑的是更早的插件代码，
  我没有逐版对照）。现在的结论基于当前代码的实测计数，而不是对那次现象的复现与解释。
- **`recallflow_browser` 的往返已实测通过**：`node scripts/probe-tool.mjs page_health`
  返回 HTTP 200 与真实页面数据（tabId / pageUrl / network 都对）；`browser_read` 那次
  还带回了扩展自己的校验信息（"仅支持 http/https URL"）—— 说明**整条链**
  （插件 → WS → 扩展 → 它自己的方法实现 → 回执）都是通的，而不只是"某处返回了 200"。
- ~~**opencode 那条链路**：桥接在跑（`/health` 的 `ok` 与 `ws` 都为真），但**跑的是旧代码** ——
  `events` / `panelTurns` 字段还在、`/panel-turns` 仍返回 200。删除清单第 4 步的改动
  （`c80fb0a`）要等用户重启桥接才会生效；重启后需先验证 opencode 仍正常，再做第 5 步。~~
  **2026-10-08 更正**：这一条已经不存在 —— 用户明确不再用 opencode，桥接整包已删除。
  （它当时记的是一个**真实状态**：桥接跑着旧代码，要等重启才生效。这个"空窗期"概念仍然成立，
  只是现在只剩 DSH 一个进程需要重启。）
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

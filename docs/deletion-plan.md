# 删除清单（可执行方案）

> 状态：**全部执行完毕（2026-10-07）**。七步都做了。
>
> **2026-10-08 补充：第 4 步当时"保留"的 7801 桥接也删了。**
> 用户明确表示不再使用 opencode —— 而保留它的**唯一理由**就是"opencode 还在用它"
> （下面第 4 步自己的结论就是"要 7801 的唯一理由是用 opencode 本身"）。前提消失，
> 于是桥接整包（`integrations/opencode/`）与扩展里那条通道一起删除，提交 `aa55f5a` / `f47e392`。
> 下面的**保留清单已据此改写**；闸门里"没删坏 opencode"那条也随之不再是闸门。
>
> **注意**：这次能删，恰恰是因为当初**没有**草率地把它当成"中继"删掉 ——
> 那份谨慎换来了"删的时候理由清清楚楚"。这条经验在下面"起因"里留着。
>
> ## 最终进度（2026-10-07，用户第二次重启 DSH 之后）
>
> 用**指纹**确认新代码真的载入了（不再是"看 status 返回 200"那种答不出问题的检查）：
>
> ```
> 磁盘上插件 sha256_12 = 072c863ac746
> 已载入 build.sha256_12 = 072c863ac746     ← 一致，且 status 里有 build 字段
> 闸门：✓ 5/5 成立（退出码 0）
> ```
>
> **端到端全部验证**（活实例实测）：
>
> ```
> /recallflow/say            → {"ok":true,…}，那句自检文本以**真用户消息**出现在会话里
> assistant/message          → 带 text（5a07de6 修的根因，实测成立）
> 面板显示 DSH 的回复         → get_picked_element 取回的 DOM：class="msg ext ext-dsh"
> recallflow_browser         → page_health 返回加工后的形状（summary/counts/errors/…，
>                              ★ 且 failedRequests[].location 已是**磁盘路径**）
>                              verify_change 读 dev-session 的 targets、断言求值正常
> dev_session_get / evidence_get → 插件本地读写共享文件，正常
> ```
>
> | 步骤 | 状态 | 提交 |
> |---|---|---|
> | 1 面板退役自己的 agent | ✅ 已完成（保留一条"DSH 不可达则回退本地"的过渡退路） | `f2fa81e` |
> | 2 客户端卡片插件 | ✅ 已完成（整包 + profile 条目 + 测试） | `53dec61` |
> | 3 旧 DSH 插件（注入那条路） | ✅ 已完成（整包 + profile 条目 + 两个验证台 + 一条契约测试） | `695a342` |
> | 4 桥接里的同步部分 | ✅ 已完成（panel-events.js / 事件队列 / `/panel-turns` / `/event` / panel_history / panel_post / dsh-hooks 全删；用**临时端口真启动**验证过） | `c80fb0a` |
> | 5 profile 里的 MCP client | ✅ **已执行（2026-10-07）** —— 删掉 `recallflow-mcp` 那个 insert 条目；干跑 + 执行后都用**DSH 自己的 js-yaml** 验证：4 条目 → 3 条目，`recallflow-one` 完好；备份留 `cordis.patch.yml.bak-20261007-225820` | — |
> | 6 扩展里的死代码 | ✅ 已完成（postPanelTurn / forwardBridgeEvent / rfBridgeEvent / renderBridgeEvent） | `cd77cbe` |
> | 7 文档收尾 | ✅ 已完成 | 多处 |
>
> **第 5 步的一个如实说明**：配置文件只在 DSH 启动时读取，所以**本次会话里
> `mcp__recallflow__*` 这些工具仍然存在**，要等**下一次重启 DSH** 才消失。
> 在那之前两条路并存（插件那条已实测可用），所以这个空窗期是安全的 ——
> 这也正是当初把第 5 步放在最后的原因。
>
> **每一步都必须先过**：`node scripts/verify-live-gate.mjs` + 全套测试 +
> profile 可解析（用 DSH 自己的 js-yaml）。第 2、3、5 步都按这个做了。
>
> 起因：这次重构的目标是"把中继删掉、只留一条会话"。但删除比新增危险得多 ——
> 我曾在准备删除时才发现 7801 桥接**不只服务 DSH**（opencode 也在用），
> 差点把 opencode 的页面工具静默删坏。所以这份清单的每一步都先写清：
> **它会失去什么、谁在用它、怎么确认没删坏。**
>
> 另有一条**只会在真实调用时暴露**的教训：删之前必须先实测插件那条路。
> `page_health` 曾经报 `value is not lossless JSON`（加工层里的显式 undefined 属性，
> MCP 那条路没有这个约束）—— 如果先删了 MCP client，这个工具就**完全没有可用路径**了。

## 闸门：以下都成立之前，一步都不要删

- [x] 用户的 DSH 重启过（插件代码是最新的：`GET /recallflow/status` 返回 200 而不是 404）
- [x] 扩展重新加载过（`status` 里 `clients >= 1`，说明扩展连上了 3080 的新通道）
- [ ] `POST /recallflow/say` 返回 `{ok:true, sessionId}`，且那句话**以真用户消息出现在会话里**
- [ ] DSH 里调用 `recallflow_browser` 能拿回真实页面数据（工具往返闭环）
- [x] ~~opencode 侧用一次页面工具（例如让它读当前页面）仍然正常 —— 这是"没删坏"的基线~~
      → **2026-10-08 起不再是闸门**：用户明确不用 opencode，这条基线连同"别删坏 opencode"的
      顾虑一起失效（桥接已整体删除，见上面补充）

## 保留清单（这些**不能**删，写在这里免得日后误删）

| 保留项 | 为什么 |
|---|---|
| `lib/bridge/relay.js` 的 DSH 通道（3080：WS + `sayToDsh` + `dispatch`） | 新架构本体 |
| `integrations/dsh-plugin-recallflow-one/` | 新架构本体（工具注册 + 输入 + 事件） |
| `lib/shared/session-view.js` + 面板的 `rfSessionEvent` 渲染 | 新架构的视图层 |
| `lib/shared/bridge-methods.js` + `dispatch` 的那些方法 | **能力实现本体**（原来写"两条通道共用"—— 现在只剩 DSH 这一条消费者） |

### 已从保留清单移除（2026-10-08，用户明确不用 opencode）

| 原保留项 | 当时的理由 | 为什么现在可以删 |
|---|---|---|
| `integrations/opencode/recallflow-mcp/` 的 MCP 工具服务 | **opencode 的页面能力出口** | 用户明确不再用 opencode → 消费者消失（`aa55f5a`）|
| `lib/bridge/relay.js` 的桥接通道（7801：WS + 长轮询） | 扩展仍要为 opencode 服务工具调用 | 同上 |

**这两条当初被列进来，正是因为这个仓库里找不到"opencode 在用它"的证据** ——
opencode 是另一个进程，它的使用只存在于配置与文档里。所以这次删除前特意先问了用户，
而不是靠 grep 的结果下判断。

## 删除步骤

每一步都要求：改完跑全套测试、并在真实环境确认那一栏的"验证"。

### 第 1 步：面板退役自己的 agent

**删什么**：面板不再调用本地 LLM 产生回复（`lib/page/chat.js` 的发送路径只调 `sayToDsh`，
不再走 `runAgentStream`）。用户输入照旧显示，但回复只来自 DSH 那条会话。
**会失去什么**：面板不再"自己回话"。**这正是用户要的**（"感觉 dsh 和 recallflow 是一个 ai"）。
**谁在用它**：只有面板自己；DSH 不依赖。
**验证**：面板里发一句话 → 它出现在 DSH 会话里 → DSH 的回复出现在面板上（靠 rfSessionEvent）。

### 第 2 步：删掉客户端卡片插件

**删什么**：`integrations/dsh-client-recallflow-panel/`（整包）+ profile 里的
`dsh-client-recallflow-panel` 依赖与 bundle 条目 + `tests/dsh-client-panel.test.mjs`。
**为什么安全**：它存在的理由是"在 DSH 里看到面板的对话"。现在只有一条会话，
面板的输入**就是**会话里的用户消息，回复**就是**会话里的助手消息 —— 卡片成了同一件事的第二份画面。
**谁在用它**：只有 DSH 的 UI；没有代码依赖它。
**验证**：DSH 能正常启动；会话消息照常显示；`/recallflow/status` 正常。

### 第 3 步：删掉旧 DSH 插件（注入那条路）

**删什么**：`integrations/dsh-plugin-recallflow/`（整包）+ profile 里的 `recallflow-panel-sync`
条目 + `tests/dsh-plugin.test.mjs` 与 `scripts/verify-panel-inject.mjs`（针对它的验证台）。
**为什么安全**：它的全部职责（把面板对话注入模型上下文、把 DSH 事件推给面板）都被新架构取代 ——
新架构里面板输入**本来就是**会话里的用户消息，不需要注入。
**谁在用它**：profile 的 patch 层；桥接的 `/event` 端点接收它的上报。
**验证**：DSH 能正常启动；`/say` 与 `recallflow_browser` 仍正常。

### 第 4 步：删掉桥接里的"同步两段对话"部分

**删什么**（都在 `integrations/opencode/recallflow-mcp/` 内）：
- `panel-events.js`（say/tool 事件的成形与三档截断 400/1200/2000）
- HTTP 端点 `/panel-turns`（GET 与 POST）
- MCP 工具 `panel_history`（读面板回合）与 `panel_post`（往面板说话）
- 桥接里为面板事件准备的 `events` 队列与 `/event` 端点

**为什么安全**：这些都是"两个真相来源"的产物。新架构下只有一个来源（DSH 的会话），
面板回合不再需要经过桥接。
**谁在用它**：扩展的 `postPanelTurn`（第 6 步一起删）、旧插件（第 3 步已删）、
以及我在会话里用的 `panel_history` 工具（它的数据来源已随第 1 步断掉）。
**验证（这一步最重要）**：
- opencode 侧用一次页面工具 → **仍然正常**
- DSH 里调用 `recallflow_browser` → 正常
- 桥接 `/health` 仍在、MCP 工具列表里再也看不到 panel_* 工具

### 第 5 步：DSH 的 profile 里去掉 RecallFlow 的 MCP client

**删什么**：profile patch 里的 `recallflow-mcp` 插入项（`@deepseek-ai/dsh-mcp-client` 指向 7801）。
**为什么安全**：那些工具（browser_read / page_health / …）现在由 `recallflow_browser` 一个工具承担，
能力没有减少 —— 只是**不再需要 DSH 走 MCP 去拿**。桥接仍为 opencode 保留。
（**2026-10-08 更正**：用户明确不再用 opencode，所以"保留"这条也取消了 —— 桥接已整体删除。）
**谁在用它**：DSH 的模型侧工具表（也就是我）。删掉后我只有 `recallflow_browser`。
**验证**：DSH 启动后工具表里没有 `mcp__recallflow__*`，而 `recallflow_browser` 可用。

#### 确切操作（已在副本上干跑验证过，2026-10-01）

文件是 `~/.dsh/profiles/web/cordis.patch.yml`。它里面有**两个** insert 条目：

```
第 4-13 行   其他 patch（ui-settings-general@4 / agent-default-model@8）—— 不动
第 15-29 行  - insert: id: recallflow-mcp      （@deepseek-ai/dsh-mcp-client，url …/7801/mcp）  ← ★ 只删这段
第 35-47 行  - insert: id: recallflow-one      （本项目的插件，绝对路径；insert 在 46、id 在 47） ← ★ 必须保留
（**2026-10-08 更正**：profile 后来不止一次变过 —— 插件已从"文件路径 insert"改成**包**（`recallflow-dsh-plugin`，
走 `link:` 安装、由 `dsh.profile.bundles` 引入），并新增了 `recallflow-one` 的审批 config。
所以上面这些**行号只是当时那次干跑的记录**，不要拿它对现在的文件。）
```

干跑（把原件复制到临时文件、删掉 MCP 段、再用 **DSH 自己的 js-yaml** 解析对比）：

```
原文件: 4 个条目 → ["ui-settings-general","agent-default-model","recallflow-mcp","recallflow-one"]
干跑后: 3 个条目 → ["ui-settings-general","agent-default-model","recallflow-one"]
recallflow-mcp:  true → false  ✓ 已移除
recallflow-one:  true → true   ✓ 保留
被删条目: {name:"@deepseek-ai/dsh-mcp-client", url:"http://127.0.0.1:7801/mcp"}
✓ YAML 可被 DSH 的解析器读出
```

**同时要改一句注释**：第 44 行原本写着"下面那条 MCP client 暂时保留（见删除清单第 5 步…）"，
删掉之后这句就是假的，一并改掉。

**回滚**：动手前把 `cordis.patch.yml` 复制一份带时间戳的备份（该目录本来就有 DSH 自己留的
几个 `.bak-YYYYMMDD-HHMMSS`，沿用同样的命名）。回滚 = 复制回去 + 重启 DSH。

**事后检查**（都在你重启 DSH 之后）：

```powershell
node scripts/verify-live-gate.mjs          # 五项闸门
curl.exe -s http://127.0.0.1:3080/recallflow/status   # 插件仍在服务
node scripts/probe-tool.mjs page_health 3080          # 工具仍能往返
# 以及：工具表里 mcp__recallflow__* 消失、recallflow_browser 仍在
```

**先决条件**：验收 4)（面板上同时看得到你发的话、工具活动、助手的回复）通过之后再删 ——
因为那一步需要读面板正文，而删除之后 DSH 就只剩插件的工具了。


**删掉之后 DSH 侧会失去什么、由什么接手**（逐项核过；**下表已于 2026-10-01 更新过一次**）：

| 原 MCP 工具 | 新架构下的对应物 | 差异 |
|---|---|---|
| `browser_read` / `read_console` / `read_network` / `page_health` / `verify_change` / `get_element_source` / `get_picked_element` / `screenshot_capture` | `recallflow_browser({method, params})` | **能力一致**（见下方"曾经的缺口"）。同一个 `dispatch`，同一套结果加工（`lib/shared/tool-results.js`），插件与桥接是**字面意义上的同一份代码** |
| `recallflow_session`（读交接包） | `recallflow_browser({ method: 'handoff_get' \| 'handoff_list' })` | **能力仍在**（两个方法都在插件的 `BROWSER_METHODS` 里）。差异：没有"没给 id 就列清单 + 提示话术"那层包装 |
| `dev_session_get` / `dev_session_set` | `recallflow_browser({ method: 'dev_session_get' \| 'dev_session_set' })` | **能力一致** —— 插件**本地**处理这两个：读/写同一个共享文件（`lib/shared/dev-session.js` 的 `dev-session.json`），不经过浏览器，因此面板关着也能用 |
| `evidence_get` | `recallflow_browser({ method: 'evidence_get', params: { hash \| url } })` | **能力一致** —— 同样本地处理，读的是共享证据库（`lib/shared/evidence-store.js`）；`browser_read` 归档到同一个目录，所以插件自己就能复核 |

**曾经的缺口（现已补齐，留作记录）**：最初盘这份表时，源位置重写
（`rewriteSourceUrls` / `normalizeElementSource` / `normalizePickedElement` /
`summarizePageHealth` / `evaluateTargets`）**11 处调用只在桥接的处理器里**，
插件返回未加工的原始 JSON —— 也就是说删掉 MCP client 会让 DSH **静默失去
「元素 → 源码文件」**，而那正是本项目最核心的前端调试用途。

补齐的方式（按当初列的"出路 1"做的）：
- `dev-paths` / `dev-session` / `page-health` / `verify-change` 全部移到 `lib/shared/`
- 新建 `lib/shared/tool-results.js`：把 8 处**按方法各异**的加工抽成共享函数
  （`shapeTextResult` / `shapeElementSourceResult` / `shapePickedElementResult` /
  `shapePageHealthResult` / `shapeVerifyChangeResult` / `resolveTargets` / `applyToolResult` …）
- 插件与桥接**都**改成调用它；游标仍留在各自进程里
  （语义是"自**我**上次检查以来"，共享会让一方吃掉另一方的增量）
- 桥接的 index.js 因此净减 **96 行**（926 → 830，实测 `git show 8c54ce1` 与当前文件）

**因此第 5 步现在是干净的删除**：不再有"删了就静默少一个能力"的地方。

最初记为"没有对应物"的那两个（`dev_session_get/set`、`evidence_get`）也补上了 ——
它们的存储共享化之后，插件**本地**就能读写同一份文件，不需要浏览器参与。
（这两个方法放进工具的 enum，但**不放进 `BROWSER_METHODS`**：
那个清单被 probe-tool 当白名单用，而 `dev_session_set` 是写操作，不该从诊断入口触发。
这条由 tests/dsh-one-plugin.test.mjs 的一条测试钉住。）

至此 DSH 与 opencode 在页面能力上**没有差别**。要 7801 的唯一理由是用 opencode 本身。
（**这条结论把删除的判据说得很清楚**：理由只有"还在用 opencode"。2026-10-08 用户明确不用了，
于是那个唯一理由消失，桥接随之删除 —— 判据是这句话给的，不是事后找的。）

**关键确认**：交接（handoff）这条路**不依赖桥接的服务端缓冲** ——
`recallflow_session` 实现里走的是 `callExtension('handoff_list' / 'handoff_get')`，
也就是**问活着的扩展**。所以第 4 步删掉 `panelTurns` 没有触及它（已核对：那些名字只出现在注释里）。

### 第 6 步：删掉扩展里的死代码

**删什么**（`lib/bridge/relay.js` 与 `lib/page/chat.js`、`background.js`）：
- `postPanelTurn` 与其测试
- `forwardBridgeEvent` + 面板的 `rfBridgeEvent` 监听 + `renderBridgeEvent`（含那套标签逻辑）
- `panel:turn` 里非 user 角色的分支（第 1 步后已无意义）

**为什么安全**：生产者（旧插件、桥接端点）在前面的步骤里都没了。
**验证**：全套测试通过；面板能收发；`recallflow_browser` 正常。
（**2026-10-08 更正**：这里原来还有"opencode 也正常"—— 用户明确不用 opencode 后，
那条验证对象已不存在。）

### 第 7 步：收尾

- 更新 `docs/two-way-sync.md`（它描述的是旧架构）→ 改写成"单会话集成"的运维说明，
  或直接删除并由 `docs/one-session-plugin.md` 取代
- `integrations/dsh-plugin-recallflow-one/README.md` 记录最终形态与保留清单
- 跑全套 + 两个验证台；~~确认 `7801` 仍可只作为**工具服务**存在（不再是"中继"）~~
  （**2026-10-08**：这条已经不需要了 —— 7801 整体删除，不再有任何"工具服务"角色。）

## 做完之后的形态

```
DSH（一条会话）
  ├─ DSH Web GUI           主视图
  ├─ RecallFlow 面板        同一个会话的另一个视图 + 输入口（退役自己的 agent）
  └─ recallflow_browser     页面能力（插件注册，经 WS 转给扩展执行）
      └─ 扩展 ──WS(3080)──▶ DSH 插件 ──▶ 内容脚本 / CDP 执行
```

用户需要运行的只有 **DSH** 与**浏览器扩展** —— 就这两个进程，没有别的服务要起。

**2026-10-08 更新**：图上原来还有一条 `扩展 ──WS──▶ 7801 桥接 ──▶ opencode 的页面工具`。
用户明确不再用 opencode 之后，那条链路（桥接整包 + 扩展侧通道）已整体删除（`aa55f5a`）——
现在扩展只连一个地址：DSH 自己的 3080。原来那句"桥接退化成给 opencode 用的工具服务"
也随之作废：**没有桥接了**。

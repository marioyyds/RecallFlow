# 删除清单（可执行方案）

> 状态：**执行中**。第 1、2、3 步已完成；第 4、5 步**等 7801 桥接恢复**（那两步要确认
> opencode 的页面工具仍正常，桥接停着就无法验证，不盲删）；第 6、7 步可做。
>
> ## 进度（2026-10-01）
>
> **闸门：核心三条已通过**（用户重启了 DSH 并重载了扩展之后）：
>
> ```
> ✓ 插件是新代码（GET /recallflow/status 返回 200）
> ✓ 扩展连上新通道（status.clients = 1）
> ✓ 插件认到会话（注册表兜底生效）
> ```
>
> **端到端已验证** —— 这是整个重构的目标：
>
> ```
> POST /recallflow/say → {"ok":true,"rpcId":"recallflow-…","sessionId":"session-723c8b32-…"}
> 那句自检文本随后以**真用户消息**出现在该会话里，并成为模型的输入。
> ```
>
> | 步骤 | 状态 | 提交 |
> |---|---|---|
> | 1 面板退役自己的 agent | ✅ 已完成（保留一条"DSH 不可达则回退本地"的过渡退路） | `f2fa81e` |
> | 2 客户端卡片插件 | ✅ 已完成（整包 + profile 条目 + 测试） | `53dec61` |
> | 3 旧 DSH 插件（注入那条路） | ✅ 已完成（整包 + profile 条目 + 两个验证台 + 一条契约测试） | `695a342` |
> | 4 桥接里的同步部分 | ✅ 已完成（panel-events.js / 事件队列 / `/panel-turns` / `/event` / panel_history / panel_post / dsh-hooks 全删；用**临时端口真启动**验证过，闸门 5/5 全绿） | `c80fb0a` |
> | 5 profile 里的 MCP client | ⏳ **等用户重启桥接**：先验证 opencode 那条链路仍正常，再删 | — |
> | 6 扩展里的死代码 | ✅ 已完成（postPanelTurn / forwardBridgeEvent / rfBridgeEvent / renderBridgeEvent） | `cd77cbe` |
> | 7 文档收尾 | 🔄 进行中（运维手册已改写；文档/脚本里指向已删文件的引用在清理） | — |
>
> **每一步都必须先过**：`node scripts/verify-live-gate.mjs` + 全套测试 +
> profile 可解析（`dsh --profile web --help` 退出码 0）。第 2、3 步都按这个做了。
>
> 起因：这次重构的目标是"把中继删掉、只留一条会话"。但删除比新增危险得多 ——
> 我曾在准备删除时才发现 7801 桥接**不只服务 DSH**（opencode 也在用），
> 差点把 opencode 的页面工具静默删坏。所以这份清单的每一步都先写清：
> **它会失去什么、谁在用它、怎么确认没删坏。**

## 闸门：以下都成立之前，一步都不要删

- [x] 用户的 DSH 重启过（插件代码是最新的：`GET /recallflow/status` 返回 200 而不是 404）
- [x] 扩展重新加载过（`status` 里 `clients >= 1`，说明扩展连上了 3080 的新通道）
- [ ] `POST /recallflow/say` 返回 `{ok:true, sessionId}`，且那句话**以真用户消息出现在会话里**
- [ ] DSH 里调用 `recallflow_browser` 能拿回真实页面数据（工具往返闭环）
- [ ] opencode 侧用一次页面工具（例如让它读当前页面）**仍然正常** —— 这是"没删坏"的基线

## 保留清单（这些**不能**删，写在这里免得日后误删）

| 保留项 | 为什么 |
|---|---|
| `integrations/opencode/recallflow-mcp/` 的 MCP 工具服务 | **opencode 的页面能力出口**，与 DSH 无关的那条链路 |
| `lib/bridge/relay.js` 的桥接通道（7801：WS + 长轮询 + dispatch） | 同上，扩展仍要为 opencode 服务工具调用 |
| `lib/bridge/relay.js` 的 DSH 通道（3080：WS + sayToDsh） | 新架构本体 |
| `integrations/dsh-plugin-recallflow-one/` | 新架构本体（工具注册 + 输入 + 事件） |
| `lib/shared/session-view.js` + 面板的 `rfSessionEvent` 渲染 | 新架构的视图层 |
| `lib/shared/bridge-methods.js` + `dispatch` 的 10 个方法 | 两条通道**共用**的能力实现 |

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
**谁在用它**：DSH 的模型侧工具表（也就是我）。删掉后我只有 `recallflow_browser`。
**验证**：DSH 启动后工具表里没有 `mcp__recallflow__*`，而 `recallflow_browser` 可用。

**删掉之后 DSH 侧会失去什么、由什么接手**（逐项核过，2026-10-01；**两处有实际损失，别当成纯赚**）：

| 原 MCP 工具 | 新架构下的对应物 | 差异（核过代码，不是推测） |
|---|---|---|
| `browser_read` / `read_console` / `read_network` / `page_health` / `verify_change` / `get_element_source` / `get_picked_element` / `screenshot_capture` | `recallflow_browser({method, params})` | 同一个 `dispatch`（`lib/shared/bridge-methods.js`）。**但桥接在 dispatch 结果上还做了源位置重写**（`rewriteSourceUrls` / `normalizeElementSource` / `normalizePickedElement`，11 处调用**只在桥接的处理器里**）→ 插件返回**未重写**的原始结果 |
| `recallflow_session`（读交接包） | `recallflow_browser({ method: 'handoff_get' \| 'handoff_list' })` | **能力仍在**（两个方法都在插件的 `BROWSER_METHODS` 里）。差异：没有"没给 id 就列清单 + 提示话术"那层包装 |
| `dev_session_get` / `dev_session_set` | **没有** | 不在共享 dispatch 里，也不在插件的枚举里；它们是桥接自己的本地状态 |
| `evidence_get` | **没有** | 桥接自己的证据归档 |

也就是说：**DSH 侧会失去「元素 → 源码文件」的路径重写能力**（它依赖
`dev_session_set` 写入的 projectRoot/devUrl，而那一层只在桥接里）。
这正是本项目最核心的**前端调试**用途，所以第 5 步不是"顺手删掉"。

三条出路（按推荐顺序）：
1. **把源位置重写下沉到共享的 `dispatch`**（`lib/shared/bridge-methods.js`）——
   两条通道就都有这个能力，且只维护一份。这是唯一能让 DSH 与 opencode 行为一致的改法。
2. 把 `dev_session_*` 与重写逻辑**移植进插件**。可行但要复制桥接的 `dev-paths.js` 与存储位置，
   等于把"一份真相"变成两份。
3. 保留 DSH 的 MCP client，只用它做调试类调用。**但这与"删掉中继"的目标相抵**。

**关键确认**：交接（handoff）这条路**不依赖桥接的服务端缓冲** ——
`recallflow_session` 实现里走的是 `callExtension('handoff_list' / 'handoff_get')`，
也就是**问活着的扩展**。所以第 4 步删掉 `panelTurns` 没有触及它（已核对：那些名字只出现在注释里）。

### 第 6 步：删掉扩展里的死代码

**删什么**（`lib/bridge/relay.js` 与 `lib/page/chat.js`、`background.js`）：
- `postPanelTurn` 与其测试
- `forwardBridgeEvent` + 面板的 `rfBridgeEvent` 监听 + `renderBridgeEvent`（含那套标签逻辑）
- `panel:turn` 里非 user 角色的分支（第 1 步后已无意义）

**为什么安全**：生产者（旧插件、桥接端点）在前面的步骤里都没了。
**验证**：全套测试通过；面板能收发；opencode 与 `recallflow_browser` 都正常。

### 第 7 步：收尾

- 更新 `docs/two-way-sync.md`（它描述的是旧架构）→ 改写成"单会话集成"的运维说明，
  或直接删除并由 `docs/one-session-plugin.md` 取代
- `integrations/dsh-plugin-recallflow-one/README.md` 记录最终形态与保留清单
- 跑全套 + 两个验证台；确认 `7801` 仍可只作为**工具服务**存在（不再是"中继"）

## 做完之后的形态

```
DSH（一条会话）
  ├─ DSH Web GUI           主视图
  ├─ RecallFlow 面板        同一个会话的另一个视图 + 输入口（退役自己的 agent）
  └─ recallflow_browser     页面能力（插件注册，经 WS 转给扩展执行）
      └─ 扩展 ──WS──▶ 7801 桥接 ──▶ opencode 的页面工具（与 DSH 无关的那条链路）
```

用户需要运行的只有 **DSH** 与**浏览器扩展**；桥接退化成"给 opencode 用的工具服务"，
不再承担任何同步职责。

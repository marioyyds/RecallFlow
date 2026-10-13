# 集成方向的唯一事实来源

> **为什么需要这份文档**：仓库里曾同时存在**三种互相矛盾**的集成方向叙述，而读者无法判断该信哪一个：
>
> | 来源 | 说法 | 与实际是否相符 |
> | --- | --- | --- |
> | `docs/recallflow-dsh-keypoints.md` | 「7801 桥接链路整体删除，整包 `integrations/opencode/` 移除」 | **不符** —— 代码仍在，且扩展启动时仍在连它 |
> | `README.md` | 「与 opencode / DSH 集成，12 个工具」 | 方向正确，但计数与细节已滞后 |
> | 代码本身 | opencode MCP server + 桥接 + 13 个工具，有端到端测试 | —— |
>
> 判断依据只能是**代码与测试**，不是任何一份文档。本文把结论固定下来。

## 一、事实（可按文件核对）

### 已实现并验证：opencode / 通用 MCP 客户端 ↔ 扩展

这是**当前唯一真正可用的集成路径**：

| 组成 | 位置 | 现状 |
| --- | --- | --- |
| MCP server（stdio + Streamable HTTP） | `integrations/opencode/recallflow-mcp/index.js`（约 1020 行） | 有独立依赖与 lockfile；有集成测试 |
| 扩展侧桥接（HTTP 长轮询 + WebSocket） | `lib/bridge/relay.js`；由 `background.js` 的 `startMcpRelay()` 启动 | 已实现 |
| 桥接方法清单（跨端唯一来源） | `lib/shared/bridge-methods.js` | 由 `tests/bridge-contract.test.mjs` 与 relay 的 dispatch 双向核对 |
| 写入许可（桥接层自己的白名单） | `lib/shared/bridge-write-policy.js` | 桥接是独立入口、不经 agent 审批，因此单独设闸；按**参数形状**分两组（页面动作要定位参数、导航要 URL） |
| 会话隔离 | `sessionBuckets` + `AsyncLocalStorage`（`index.js`） | `recallflow-mcp/test/session-isolation.test.mjs` |
| 目标标签页（按会话分桶） | `targetTabBySession`（`index.js`）+ `page_action.tabId` | 没有它，两个客户端会互相覆盖对方正在操作的页面 |
| 鉴权 | `RECALLFLOW_BRIDGE_TOKEN`（默认 `recallflow-local-bridge-v1`，可覆盖） | `scripts/verify-bridge-ws-handshake.mjs` |

工具面共 **14 个**：12 个只读 + 2 个写通道（`page_action` 页面动作、`open_tab` 导航）。
`open_tab` 是「驱动一次完整流程」的第一步（到达目标页面），只放行 http(s)、单次只开一个标签页；
`switch_tab`、`upload_file`、`run_javascript`、用户脚本仍被有意拒绝。

> **两个必须记住的落差（都已实测）**：
> 1. **改扩展侧代码要重载扩展**。只重启 7801 的服务进程不够 —— 服务端会立刻暴露新方法
>    （如 `open_tab` 出现在工具清单里），但扩展仍是旧代码，调用会返回
>    `unknown method: open_tab`。这类失败看起来像"服务端没实现"，实际是"扩展没更新"。
> 2. **MCP 客户端的工具清单是启动时取的**。新增工具后，客户端要等新会话（重连/重启）
>    才能在模型侧看到，光重启服务端不够。


### 仅有文档、**没有代码**：DSH 插件形态

`docs/recallflow-dsh-keypoints.md` 描述了插件侧的 `/say`、`/session-log`、`agents.list()`、
`panel:turn`、`elementsDigest()` 等实现细节。**这些代码不在本仓库内**，也不能由本仓库测试覆盖。
本仓库与 MCP 相关、且被测试覆盖的只有上面那张表。

**这不代表那个方向是错的**，只代表：**本仓库无法保证它的可用性**，任何"DSH 集成已完成"的说法
都必须由 DSH 侧的代码与测试来支撑，而不是由本仓库的文档。

## 二、结论（后续以此为准）

1. **保留并维护 opencode/通用 MCP 这条路径**。它方向正确（外部 agent 驱动真实浏览器做前端调试），
   已有端到端验证，并且刚补齐了写通道与会话隔离。
2. `references`：本仓库**不声称** DSH 插件已实现。若将来做，应当作为**独立仓/独立插件**交付，
   并在本仓库只保留「契约」而非「实现描述」。
3. **任何"某链路已删除"的结论，必须先 grep 代码再写** —— 本次就是因为没做这一步，
   导致一份文档声称整包删除、而 `background.js` 至今仍在 `startMcpRelay()`。

## 三、防止再次漂移

`tests/docs-drift.test.mjs` 会核对几件具体的事：

- 是否存在声称「7801 桥接已删除」的文档（若有，必须是**带有更正的**历史记录）；
- `lib/bridge/relay.js`、`integrations/opencode/recallflow-mcp/index.js` 是否仍然存在
  —— 若它们真的被删除，那条断言会失败并提醒同步本文档；
- 桥接方法清单与 relay 的 dispatch 分支是否仍然一致（既有门禁已覆盖）。

**教训（与 `docs/agent-engineering-review.md` 的「我犯的错」同类）**：
断言别人过时、或断言某物已被删除，比断言代码有 bug 更需要先读代码。

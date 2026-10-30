# 桥接层会话隔离

> 状态：**已实施**（见下方「实施结果」）。本文保留问题描述与设计推演，便于后人理解
> 「为什么必须分桶」而不是只看到代码。
> 触发原因：MCP 层的跨客户端响应串台（见下）。

## 实施结果（已完成）

采用方案 A，并额外用 `AsyncLocalStorage` 解决了一个实现层面的难点：

| 环节 | 落地方式 |
| --- | --- |
| 分桶 | `sessionBuckets: Map<sessionId, {queue, pending, seq}>`，stdio 落到 `DEFAULT_SESSION` |
| 会话归属 | `AsyncLocalStorage` 注入当前 MCP 会话 —— 而不是给 `callExtension` 加参数（它被 10 处调用，逐个传参会漏传，漏传就静默退回默认桶，等于没修） |
| 建立会话的那一次请求 | 会话 id 由 SDK 在请求内部生成，因此用一个带 `id` getter 的包装对象作为上下文值，`onsessioninitialized` 触发后指向真实 id |
| 回程路由 | job 带 `session` 标记；扩展**不解释**它，只在 `/result`（及 WS 回帧）里原样回带 |
| `/poll` | 支持 `?sessions=a,b` 按会话取活；不传 = 不限，兼容旧扩展 |
| `/result` | 按 `session` 路由；**找不到就丢弃并记日志**，绝不再接受任意 id（旧实现会把结果交给任何持有该 id 的等待者） |
| `/health` | 额外暴露 `sessions` 与 `bySession` 待办数 —— 排查串台时「谁还有多少活没被取走」是关键信息 |
| 验证 | `test/session-isolation.test.mjs`：**双会话并发**、假扩展收活并回带 session，断言每个会话只拿到自己的结果 |

**测试踩过的坑（值得记）**：第一版用 `dev_session_get` 做被测工具，结果两条请求都返回了
本机文件内容、根本没有 job 到扩展 —— 因为该工具**只读本机文件、不走扩展通道**。
换成 `browser_read`（真的 `callExtension`）后才真正测到隔离。
教训：**测隔离必须选一个真的经过被测通道的工具**，否则测试会在"没有通道"的情况下假通过。

## 一、已确认的问题

桥接通道（扩展 ↔ MCP server）只有**一份全局状态**：

| 位置 | 现状 |
| --- | --- |
| `index.js:64-71` | `const queue = []` / `const pending = new Map()` —— 全局单份 |
| `index.js:72-76` | `let seq = 0` + `nextId()` —— 全局整数 id |
| `index.js:161-180` | `/poll` 把**整个 queue** 交给第一个等待者（`queue.splice(0, queue.length)`） |
| `index.js:181-195` | `/result` 接受任意 id，不校验它属于哪个会话 |
| `index.js:259-295` | HTTP MCP 会话（`mcp-sessions`）确实按 `mcp-session-id` 隔离了 **MCP 侧状态**，但**没有隔离浏览器通道** |

**后果**：两个 MCP 客户端并发调用 `browser_read` 时，两条请求进入同一个 queue，
被**同一个 `/poll` 一次性取走**，由**同一个扩展**执行并回结果。
于是 A 客户端可能收到 B 的页面正文/截图 —— 对前端调试来说，这等于把
`file:line` 归因挂到错误的页面上，比报错更糟（错误的结果看起来是对的）。

**为什么现有测试没发现**：`test/http-transport.test.mjs` 只验证了「无鉴权 → 401」
与单客户端往返，没有并发双会话的场景。

## 二、关键约束

1. **扩展是发起方**：`/poll` 由扩展发起（长轮询），服务端不能主动推给它。
   因此「按会话返回队列」必须让 `/poll` 知道它在为哪个会话取活。
   扩展侧 `lib/bridge/relay.js` 是**单实例连接**（一份 socket + 一个 httpLoop），
   服务端无法凭连接区分会话。
2. 因此可选路径只有两条：
   - **A（推荐）**：`/poll` 携带它愿意服务的会话列表，服务端只返回这些会话的 job；
     扩展回 `/result` 时带上 `sessionId`，服务端据此只 resolve 该会话的 pending。
   - **B**：把浏览器通道也变成「按会话一条连接」（每个 MCP 会话要求扩展开一条轮询）。
     扩展是单例，这会让扩展侧状态显著复杂化，不推荐。
3. **不能破坏单客户端路径**：stdio 模式（`node index.js`，opencode 直接拉起）没有
   HTTP 会话概念，必须继续工作。因此需要一个「默认会话」兜底。
4. `bridge-methods.js` 是跨端方法名的唯一来源，`tests/bridge-contract.test.mjs` 会
   钉住它 —— 新增方法必须同步登记，否则门禁会红（这是好事）。

## 三、推荐方案（A）的落地步骤

1. **数据结构**：`queue` / `pending` / `seq` 改为按 `sessionId` 分桶
   （`Map<sessionId, {queue, pending, seq}>`），并保留 `DEFAULT_SESSION`（stdio）。
2. **id 全局唯一**：即使分桶，也建议 id 改 `sessionId + ':' + n` 或 uuid，
   让「结果属于谁」在日志里一眼可见（现在只有裸整数，排查时无法归因）。
3. **`/poll`**：接受 `?sessions=a,b`（或 `X-RecallFlow-Sessions` 头），只返回这些会话的 job；
   不传则退化为全部（保持向后兼容）。
4. **`/result`**：要求 body 带 `sessionId`；`resolvePending` 只在该会话的桶里查 id，
   查不到就**丢弃并记日志**（而不是像现在这样接受任意 id）。
5. **扩展侧**：`relay.js` 的 `httpLoop` 在 `/poll` 上带上「本扩展愿意服务的会话」——
   单客户端场景下这需要一个约定：MCP 会话建立后把 sessionId 通过 `/poll` 的响应头或
   一次 `/register` 告知扩展；或最简单地把所有 job 标上 sessionId，扩展原样回带。
6. **测试**：新增「双会话并发」用例 —— 两个 session，各发一条可区分的 `browser_read`，
   断言各自只拿到自己的结果。这是唯一能证明修复有效的测试。

## 四、与「写子集」的关系

MCP 写工具子集（click/type/press/wait/get_page_snapshot/run_javascript）也依赖本设计：
写操作**必须**能归因到「哪个客户端、哪次审批」，否则审批语义无法成立。
因此建议**先做会话隔离，再做写子集**。

> **2026-10 现状校正**（本节写于写子集之前，其中的清单已过时）：
> 写子集已落地为 `page_action` + `open_tab`，许可清单在 `lib/shared/bridge-write-policy.js`。
> `run_javascript` **没有**进写子集 —— 它连同用户脚本、`upload_file`、`switch_tab` 一起
> 被有意拒绝（桥接是独立入口，不经过 agent 循环的面板审批）。
> 会话隔离已完成，见 `docs/bridge-session-isolation-plan.md` 与
> `integrations/opencode/recallflow-mcp/test/session-isolation.test.mjs`；
> 「目标标签页」也随之**按会话分桶**（`index.js` 的 `targetTabBySession`），
> 否则两个客户端会互相覆盖对方正在操作的页面。
> 至于「归因到哪次审批」：本轮**没有**实现外部审批（这正是 roadmap P3 的难点），
> 因此桥接写操作目前只受**许可清单**约束，不受审批约束 —— 这个落差必须在
> 放开任何高风险能力（首当其冲是 `upload_file`）之前解决。

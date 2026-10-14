# agent_task：把一整条任务交给扩展内 agent 执行

> **状态**：设计（未实现）。本文回答「DSH 发一句『发一个小红书』，怎么让它真的跑完」。
> **前置**：`open_tab` + `page_action.tabId`（已实现，见 `feat/dsh-bridge-control` 的 `5f90b47`）。
> **结论先行**：通道不是难点（`runAgentStream` 早就在了），**审批**才是难点；
> 而在解决审批之前，这条通道**只能以「声明式风险预算」的受限形态上线**，不能放成"整任务全自动"。

---

## 一、为什么需要它（而不是继续用原子工具）

用 `page_action` 串出一次完整流程，能力上是够的，但代价随步骤数线性增长：

| | 原子工具（DSH 规划） | `agent_task`（扩展内 agent） |
| --- | --- | --- |
| 谁做规划 | DSH 的模型 | 扩展配置的那个模型 |
| 每次往返 | 一步一次 MCP 往返（每步都要过桥接、过 DSH 上下文） | 一次启动 + 轮询进度 |
| 上下文成本 | 每步的快照都进 DSH 的上下文 | 快照只在扩展内流转 |
| 可观测性 | 每一步都可见、可断言（**这是优势**） | 只在进度事件里可见（黑箱一点） |

所以两者是**互补的**，不是替代：调试场景用原子工具（要看清每一步），
"跑完一条固定流程"用 `agent_task`（省往返与 token）。

---

## 二、通道：`runAgentStream` 需要什么，桥接能提供什么

`lib/assistant/agent.js` 的 `runAgentStream(port, payload, settings, book, signal, tabId)` 是扩展内 agent 的主循环。
桥接直接复用它，需要满足它对外部的三处依赖：

| 它需要 | 面板（现状） | 桥接侧要提供的 |
| --- | --- | --- |
| `port.postMessage(msg)` —— 发进度事件 | 面板的 `chrome.runtime.Port` | 一个**假 port**：把事件写进 job 的环形缓冲 |
| `port.onMessage` 监听 `{type:'tool-approval', callId}` —— 等用户点「同意」 | 面板弹审批条，用户点击后回发 | **没有 UI 可等** → 见第三节（这是核心问题） |
| `settings`（含 `apiKey` / 模型 / 预算） | 面板从 `chrome.storage` 读 | 直接 `getAISettings()`；**必须已配 API Key**，否则任务一开工就失败 |

另外两处已在代码里，不需要改：

- `emit` 对端口断开是**容错**的（`try { port.postMessage } catch {}`，agent.js 里写明"端口断开时保留 Session，等待同 runId 恢复"）；
- 每个 run 都有 `runId`，且通过 `session-store` 落盘，可按 runId 恢复。

### 结论：通道约 150 行，难点不在它

假 port = `{ postMessage, onMessage: { addListener, removeListener } }`，
事件落进 job 缓冲；`agent_task` 立刻返回 `jobId`，`agent_task_status` 按游标取增量。

---

## 三、审批：这才是真问题（也是本设计的主体）

### 3.1 为什么不能照搬面板那套

扩展的逐次审批是：agent 发 `{type:'tool-approval', callId}` → **面板 UI** 渲染批准条 →
用户点击 → 面板把决定回发。桥接场景下**没有面板**（用户可能压根没开那个页面），于是只有两条路：

1. **等**——一直挂到超时。任务必然失败，且失败原因（无人点同意）在结果里看不出来。
2. **绕过**——直接放行。这正是 `lib/shared/bridge-write-policy.js` 存在的理由：
   桥接是**独立入口**，绕过审批就等于"模型可以在你的真实浏览器上点删除、填提交、跑任意 JS，而你没同意过"。

两条都不可接受，因此需要的不是"接上审批"，而是**一种在没有 UI 时依然成立的授权形态**。

### 3.2 声明式风险预算（建议采用）

把「逐次事后批准」换成「**开工前一次性声明**」：

```jsonc
agent_task({
  instruction: "把这篇笔记发到小红书",
  allowRisk: ["read", "page"]        // ← 调用方必须显式声明
})
```

扩展在**执行前**对每一次工具调用做一次判定（复用已有的 `getToolMetadata` + `toolNeedsApproval` 的分类映射）：

```
工具 → TOOL_METADATA[name].risk → 审批类别
  不是 allowRisk 里的类别  →  拒绝执行，反馈："click_element 属 page，未在你的 allowRisk 里。
                                        若确实需要，请重新调用并声明 allowRisk: ["read","page"]"
```

为什么这个形态是对的：

- **授权发生在开工前，可见、可解释、可复现** —— 用户/调用方明确知道"这次允许了什么"，而不是在几十次弹窗里点同意；
- **不绕过任何既有闸门**：高风险工具（`alwaysRequireApproval: true`，即 `run_javascript` /
  `run_userscript` / `install_userscript`）**任何 allowRisk 都换不到**，只能面板逐次批准；
- **失败信息可操作**（与 `docs/tool-design.md` §7 一致）：告诉调用方缺哪个类别、怎么补；
- **它不修改 agent 循环**：判定放在 `executeAnyTool` 的两个调用点外面
  （串行在 agent.js:1659，并行批在 agent.js:1030），agent 循环的审批逻辑一行不动。

⚠ **一个必须承认的漏洞**：这条判定由**扩展侧代码**执行，而"允许什么"由**调用方**声明。
即风险预算约束的是**模型能做什么**，不是**调用方能做什么** —— 任何持有桥接 token 的本机进程
都能声明 `allowRisk: ["read","page"]` 然后自己发指令。
因此它的安全强度**完全等于桥接 token 的强度**，而当前默认 token 是写死在仓库里的公开常量。
→ **上线前置条件：先换掉 `RECALLFLOW_BRIDGE_TOKEN`**（见第六节）。

### 3.3 另一条路（不推荐，但要写清为什么不推荐）

**把审批请求透出成进度事件，让 DSH 转发给用户、再把决定回传**（`jobId` + `approvalId` + `task_answer`）。

- 好处：真正的逐次人类批准，语义最强。
- 为什么现在不做：它要求**一次 MCP 调用还挂着的时候**另一端能回传决定 ——
  而 MCP 是请求/响应，回传要么再开一条 `task_answer` 调用（可行，但要求调用方在任务进行中
  还能发起新调用），要么把审批事件塞进轮询结果（于是"批准"变成下一次轮询才生效）。
  更麻烦的是**超时**：等人类点同意可能超过扩展侧 60s 的桥接预算。
  这会引入一套完整的异步审批状态机，值得单独一轮做，不适合塞进第一版。

结论：**第一版用声明式风险预算**，把 §3.3 留作后续增强（它不冲突，可叠加）。

---

## 四、长任务与超时：为什么必须异步

数字都在代码/配置里，不需要估：

| 约束 | 数值 | 后果 |
| --- | --- | --- |
| 桥接等扩展响应的超时 | `RECALLFLOW_EXT_TIMEOUT_MS`，默认 **60000** | 单次桥接请求最多 60s |
| DSH 的 MCP 工具调用超时 | `toolCallTimeoutMs: 90000`（`cordis.patch.yml`） | 单次 MCP 调用最多 90s |
| 一条"发笔记"流程 | 几十步 + 模型往返，**分钟级** | 单次调用必然扛不住 |

所以 `agent_task` **不能**同步等完成，必须：

```
agent_task(instruction, allowRisk)  → 立刻返回 { jobId, state:"running" }   （~1s）
agent_task_status(jobId, sinceSeq)  → { state, events:[…], seq, result? }    （轮询）
agent_task_cancel(jobId)            → 取消（对应 runAgentStream 的 AbortSignal）
```

- **job 存活在哪**：扩展 service worker 会被回收，因此 job 状态必须走 `session-store` 落盘
  （`runAgentStream` 本来就按 runId 落盘并按 runId 恢复 —— 直接复用 runId 当 jobId）。
- **进度事件的粒度**：不要每个 token 一条。复用 `appendTrace` 已有的轨迹（工具名 + 耗时 + 成败），
  只把 `phase` 变化与工具调用事件暴露出去。
- **`state` 取值**必须与既有状态机对齐：`RUN_STATUS`（`lib/assistant/agent-state.js`）已定义
  `planning / waiting_approval / executing / observing / completed / failed / cancelled / timeout`，
  不要再造一套同义词。

---

## 五、并发：必须串行

`docs/browser-channel-full-technical-plan.md` 的 M2 已经定死：**单站点串行，禁止并发**。
这里还有第二条理由：DSH 自己也在驱动同一个浏览器。

因此：

- 同一扩展内**同时只允许一个 `agent_task`**；第二个调用直接拒绝并返回当前 jobId
  （而不是排队 —— 排队会让调用方以为"已经开始跑了"）；
- `agent_task` 运行期间，桥接的 `page_action` 应当**拒绝或排队**，否则 DSH 会和扩展内 agent
  抢同一个标签页（表现为"两边都点了一下"）；
- 目标标签页沿用已实现的 `targetTabBySession` 思路：`agent_task` 启动时绑定 tabId，
  运行期间不接受别的会话插入同一标签页。

---

## 六、上线前置条件（硬性）

1. **换掉桥接 token**。默认值 `recallflow-local-bridge-v1` 写在仓库、README 与扩展设置里，
   是**公开常量**。一旦 `agent_task` 上线，"能连上桥接"就等于"能在你的浏览器里跑一整条任务"。
   这不是加固建议，是准入条件。
2. **`upload_file` 保持关闭**。要"发一篇带图内容"就必须上传本机文件，
   而放开的含义是：任何拿到 token 的本机进程都能把本机文件交给任意网站。
   应先单独决策（建议：只允许配置的一个「投递目录」内的文件 + token 已换），再开这一档。
   在此之前，"发笔记"只能做到**纯文字**。
3. **扩展必须已配 API Key**：`runAgentStream` 要调模型；没配就是开工即失败，
   而错误信息来自 LLM 层，容易看成本地故障。启动前应显式前置检查并给出可读原因。

---

## 七、改动清单（预估）

| # | 文件 | 改动 |
| --- | --- | --- |
| C1 | `lib/shared/bridge-methods.js` | 新增 `agent_task` / `agent_task_status` / `agent_task_cancel` |
| C2 | `lib/bridge/relay.js` | 三个 dispatch 分支；假 port；job 缓冲；**允许集合判定**（§3.2） |
| C3 | `lib/bridge/agent-job.js`（新） | job 生命周期：创建 / 追加事件 / 按游标读 / 取消 / 复用 runId 恢复 |
| C4 | `lib/shared/bridge-write-policy.js` | `agent_task` 的 `allowRisk` 参数校验（必须是已知类别；`high` 一律不接受） |
| C5 | `integrations/opencode/recallflow-mcp/index.js` | 三个 MCP 工具 + 会话级 jobId 记录 |
| C6 | `lib/assistant/agent.js` | 若 §3.2 的判定要包在 `executeAnyTool` 外层，可能需要一个**注入点**（不改现有审批逻辑） |
| C7 | `tests/bridge-contract.test.mjs` | 双向清单核对（既有门禁自动覆盖，方法加进 `BRIDGE_METHODS` 即可） |
| C8 | `tests/`（新） | ①允许集合判定：未声明类别一律拒、`high` 一律拒；②job 事件按游标增量、不重复不丢；③并发：第二个 `agent_task` 被拒 |

**C6 是唯一需要动 `agent.js` 的地方**，且应当只加一个可选的执行前钩子，
**不得**改动 `toolNeedsApproval` 的语义 —— 面板路径必须保持完全不变（否则会回归面板的审批行为）。

---

## 八、验收（不接受"看起来跑完了"）

沿用仓库既有的双层判据（页面状态 + 模型/调用方实际收到了什么）：

1. **通道**：`agent_task` 立刻返回 jobId；`agent_task_status` 能取到递增 seq 的事件；
   任务结束后 `state` 落在 `completed`，并带最终答复。
2. **允许集合**：故意请求一个未声明类别的动作（如只声明 `["read"]` 却要点击）→
   必须以**可读原因**拒绝，且指出缺哪个类别；请求 `high` 类别 → 一律拒绝。
3. **超时**：一个 >90s 的任务必须能正常完成（证明没有卡在单次调用超时上）。
4. **并发**：第二个 `agent_task` 被明确拒绝，且不产生第二个 job。
5. **页面判据**：用一个夹具页跑通一次真实任务，断言页面状态确实变了
   （而不是只看 agent 自称完成 —— 仓库里 `claim-check` / `verifier` 的存在就是为了这件事）。

---

## 九、风险登记

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| 桥接 token 是公开默认值 | 本机任意进程可跑完整任务 | **上线前置条件**（§6.1） |
| `allowRisk` 由调用方声明 | 约束的是模型而非调用方 | token 换掉 + 明确写进文档（§3.2） |
| 扩展 agent 与 DSH 抢标签页 | 两边都点一下，状态互相污染 | 单任务串行 + 运行期锁（§5） |
| service worker 被回收 | 长任务中断 | 复用 runId 落盘 + 恢复（§4） |
| 无人值守高频运行 | 账号风控 / 站点条款 | 沿用既有非目标 N5：不做无人值守高频；失败即停不自动重试 |
| 工具结果进入扩展 agent 上下文 | token 成本 | 复用既有截断与折叠；进度事件只暴露轨迹不暴露全文 |

---

## 十、与「发一个小红书」的差距对照

| 流程步骤 | 现状 |
| --- | --- |
| 打开创作者页面 | ✅ `open_tab`（已实现） |
| 填标题 / 正文 | ✅ `page_action(type_text)`（已实现） |
| 选话题 / 分类 | ✅ `click_element` / `select_option`（已实现） |
| **上传配图** | ❌ `upload_file` 有意拒绝 —— 需先换 token，再单独决策（§6.2） |
| 点发布 | ✅ `click_element`（已实现） |
| 确认发布结果 | ✅ `page_screenshot` + `verify_change`（已实现） |
| 让 DSH 一句话跑完 | ⏳ 本文（`agent_task`）|

也就是说：**纯文字版本在 P2 完成后可跑通；带图版本卡在 `upload_file` 的决策上。**

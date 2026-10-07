# 单插件架构：把集成收进一个 DSH 插件，删掉中继

> 状态：**调研完成，尚未实现**。本文只记录已核实的依据与选定方案，不包含未验证的断言。

## 为什么要重构

用户的判断（原话）：

> 以 dsh 为主，recallflow 也可以对话，两者能够同步，但是确实应该是基于 dsh 的 session
> 就行，根本不需存在着什么同步呢
> 所以我不知道为什么我们工程这么复杂？？

这个判断是对的。当前实现把浏览器面板当成**第二个 agent**（有自己的对话历史），
再去**同步两段对话**。同步两段对话天然复杂：两个真相来源 → 顺序、去重、截断、
归属、文案、会话绑定全都要处理。最近修的多数缺陷（400 字截断、重复注入、
该不该有标签、角色被糊掉、会话失效）都是这个选择的衍生物。

**只有一条会话时，"同步"没有对象。**

## 已核实的 API 依据

全部读自本机安装的 DSH 类型声明（路径为
`C:\Users\mario\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\…`）。

### 1. 插件能直接注册工具（不需要 MCP）

```ts
// dsh-tools/lib/types/index.d.ts:636
register(definition: ToolDefinition): () => void;

// 同文件 :115
export interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition;
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
  projectContent?(…): ContentBlock[] | undefined;
  finalizeContent?(…): ContentBlock[] | undefined;
}
```

旁证：`dsh-mcp-client` 就是把 MCP 工具注册成 DSH 工具的 —— 同一机制。

→ 页面能力（读页面、截图、控制台、元素定位…）可以由插件**直接**注册，
不再需要一个本地 MCP 服务器进程。

### 2. 插件能把路由挂到 DSH 自己的 Web 服务上（不需要另开端口）

```ts
// dsh-host-webserver/lib/types/index.d.ts:90
register(route: WebRoute): () => void;          // 注释：handlers retain direct response ownership
// :97
registerUpgrade(route: WebUpgradeRoute): () => void;
// :41
export interface WebUpgradeRoute {
  path: string;
  /** Owns protocol negotiation and the upgraded socket after dispatch. */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
```

关键区别：`registerUpgrade` 只给**裸 Duplex socket** —— WebSocket 的握手与帧协议
要自己实现。而 `ws` 虽然存在于 DSH 的 node_modules 里（v8.22.0，`dsh-api-gateway`
自己就在用），但**本仓库的插件未必 resolve 得到它**（它在 DSH 的依赖树下，
不在链接进来的包自己的依赖树里）。

→ 因此**不用 WebSocket**，用 `register` 的普通路由 + **SSE** 即可：
SSE 正好是"长期持有响应"的形态，与 "direct response ownership" 完全契合。

### 3. 面板的话可以成为真正的用户消息

```ts
// dsh-api-session-controller 的类型
prompt(content: PromptContentPart[], mode: 'queue' | 'steer', signal?, requestId?): Promise<…>
```

对比参考实现 `@xmanrui/dsh-im`（微信集成，本机
`~/.dsh/profiles/web/node_modules/@xmanrui/dsh-im/plugin-src/host/harness-session-coordinator.mjs`）：

```js
// :58
function steeringMessage(text, rpcId) {
  return deepFreeze({
    id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId },     // ← 声明成真用户输入
  });
}
// :90
agent.inject(steeringMessage(text, inputRpcId));
```

**但 `inject` 有硬限制**（同文件 :88 注释原文）：
"inject() never wakes an idle driver. Because validation and injection share one JS tick,
this context can only target this live turn's next step."

→ `inject` 只能**引导正在进行的那一轮**，不能唤醒空闲会话。面板要能主动开口，
必须走 `session.prompt`（GUI 发消息用的同一条路）。

> ⚠️ **上面这句"必须走 `session.prompt`"是当时（v2）的假设，下面第 100 行的探针 v3 推翻了它** ——
> `agent.session.prompt` **不是函数**（同一次探针的输出里就写着 `session.prompt 是函数=false`）。
> 正确入口是 `agent.send(message, 'next-step', true)`（`'next-turn'` 的坑见下方 2026-10-07 补充）。留着这句是因为这段是**按时间顺序的调查记录**；
> 但扫读时别把它当结论 —— 结论在第 117 行。

对照：我们现在手搓的载荷是 `source: { kind: 'recallflow-panel' }` ——
自定义 kind，因此只能落成模型侧上下文，界面上不是用户消息。

## 探针 v3（决定性）：插件能在**空闲**会话上开启新一轮 —— 已实测通过

脚本 `scripts/spike-wake-plugin.mjs`：等 CLI 那一轮跑完并**空闲**（`agent.whenIdle()`），
再调 `agent.send(msg, 'next-turn', true)`，观察是否产生真用户消息与**新一轮**助手输出。

实测输出（原文摘录）：

```
[spike] 已空闲。此时收到的 user/message 数=0，assistant/message 数=0
[spike] ★ 已被接受：send(msg, 'next-turn', true)  返回=null
[spike] user/message #1 text="WAKE-1790785531308"
[spike] assistant/message #1 … #14
[spike] === 结论 ===
[spike] send 之后新增 assistant/message 数 = 15（>0 即证明：插件能在空闲会话上开启新一轮）
[spike] 探针文本是否作为 user/message 出现 = 是（共 2 条 user/message）
```

结论：**`agent.send(message, 'next-step', true)` 就是"外部输入进会话"的正确入口** ——
它同时做到三件事：产生真正的 `user/message`、唤醒空闲的 driver、开启新一轮。
（`agent.inject` 只做前一件的一半：能产生 user/message 但**不唤醒**空闲 driver，
所以它只适合引导正在进行的那一轮。）

> **2026-10-07 补充：第二个参数的选择也是坑。** 原来写的是 `'next-turn'` ——
> 而 `InboxTarget = 'next-turn' | 'next-step'`（`dsh-agent/lib/types/types.d.ts`），
> `'next-turn'` 要等**整轮结束**才可能被取走，并且 `send` 的注释写明 cancel 之后
> "…even when its **message is cleared before the driver claims** it"。
> 用户反馈"recallflow 不能发消息"（`/say` 返回 `ok:true`、会话里却看不到）就是它：
> 这个会话连续跑轮次，消息在轮次边界被清掉了。现已改成 `'next-step'`
> （当前这一轮的下一个步骤就取走），并由 `tests/dsh-one-plugin.test.mjs` 钉住 ——
> 验证过把它改回 `'next-turn'` 会让那条测试失败。

顺带一条形状事实（v2 探针转储）：`agent` 原型上有
`send / followup / steer / inject / cancel / wakeDriver / whenIdle / runMaintenance / turn / step`；
`agent.session` 上只有 `append / snapshotEvents / deriveMessages` 等**日志侧**方法，没有 `prompt`。
`ctx.session` / `ctx.sessions` 存在但**必须先 `inject` 声明**才能取用
（不声明时报 `cannot get property "sessions" without inject`）。

### 至此四块都有了证据

| 需要的能力 | API | 证据 |
|---|---|---|
| 面板的话 → 真用户消息 + 唤醒空闲会话 | `agent.send(msg, 'next-step', true)` | ✅ 隔离 headless 实测（target 的坑见上方 2026-10-07 补充） |
| 载荷形状 | `{id, role:'user', content:[…], source:{kind:'user', rpcId}}` | ✅ 实测产生 user/message |
| 把页面工具给 DSH | `ctx.tools.register(ToolDefinition)` | ✅ 类型声明（形状待读全） |
| 面板 ↔ 插件的传输 | `webServer.register(route)` + SSE | ✅ 类型声明 |

## 端到端实测（真实 DSH 实例，隔离 profile）—— 11/11 通过

单元测试用假 ctx 验证处理器逻辑，但有一类问题只有真实实例能回答：
**插件注册的路由是否落在 DSH 的鉴权栅栏内**。做法是起一个完全隔离的实例。

隔离实例的起法（脚本 `scripts/verify-one-plugin-e2e.mjs` 的头部注释里也写了）：

```
~/.dsh/profiles/rfprobe/package.json     ← {"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}
~/.dsh/profiles/rfprobe/cordis.patch.yml ← 插入本插件
node <dsh>/lib/bin.js --profile rfprobe --port 3099 --no-open
```

踩过的三个坑（都记在脚本注释里了）：
- profile 不存在会直接报错，必须先用 `dsh plugin --profile <名> add <包>` 建、或手写最小模板
- `web` **不是子命令**：`Usage: dsh --profile web [options]` 里的 `web` 就是 profile 名，profile 即应用
- PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 **BOM**，JSON 解析直接失败 —— 要用 write 工具写

实测结果（`node scripts/verify-one-plugin-e2e.mjs 3099`，11/11，退出码 0）：

> **这是 SSE 那一版的输出，保留下来是为了记录"当时是怎么验证的"。**
> 那个脚本现在是 **14 项、走 WebSocket**（见 `integrations/dsh-plugin-recallflow-one/README.md`），
> 所以你现在重跑会看到不同的输出 —— 不是这段错了，是它记录的是被推翻的那一版。

```
✓ GET /recallflow/stream 返回 200（未被鉴权栅栏拦下）
✓ SSE 头正确（text/event-stream + no-cache）
✓ 本机来源被放行（ACAO 回显 http://127.0.0.1:3080）
✓ SSE 首帧是 hello（带会话列表）
✓ POST /recallflow/say 到达处理器（不是 404/401）
✓ 无活会话时给出明确业务错误（而不是静默）
✓ 扩展来源的预检被放行（ACAO: chrome-extension://…）
✓ 预检声明了 content-type 与 POST
✓ 恶意来源不回 ACAO（已拒绝）
✓ 对照：/ 仍在鉴权栅栏内（401）
```

**关键结论**：`/` 与 `/api/*` 都返回 401（在栅栏内），而 `/recallflow/*` 返回 200
—— 插件注册的路由**不在鉴权栅栏内**，扩展可以直接连，不需要额外带 token。
（这也是为什么不需要 `/api` 那条路：栅栏是给浏览器信任面用的，我们的路由是自己的面。）

## 选定方案

```
浏览器扩展 ──WebSocket──▶ DSH 插件（进程内，随 DSH 启动）
                          ├─ webServer.register / registerUpgrade
                          │    ├─ POST /recallflow/say        → agent.send(msg,'next-step',true)，变成真用户消息
                          │    ├─ GET  /recallflow/status     （诊断：计数与 recentEvents）
                          │    ├─ POST /recallflow/probe-tool （工具往返探针；白名单只读，不接受 dev_session_set）
                          │    └─ WS   /recallflow/ws         （会话事件 + 工具调用/回执）
                          └─ ctx.tools.register  recallflow_browser
                               （页面能力 + 本地方法 dev_session_get/set、evidence_get）
```

- **7801 桥接保留** —— 它不是中继，而是 **opencode 的页面能力出口**。
  我曾以为它能一起删掉，准备动手时才发现删了会让 opencode 的工具**静默失效**（已回退；
  见 `docs/deletion-plan.md` 的保留清单）。DSH 侧不再需要它：页面能力已由插件直接提供。
- 用户需要运行的：**DSH** + **浏览器扩展**；用 opencode 时**还要**那个 7801 桥接。

> **这一段曾经是另一版**（SSE `/recallflow/stream` + `session.prompt(text,'queue')` +
> "中继整个去掉"）。三处都被后续实测推翻：
> ① 扩展是 MV3，service worker 空闲约 30 秒被回收，而 `fetch` 流**不能**阻止回收
>   （WebSocket 活动才能）→ 改用 WS；
> ② `session.prompt` **不是函数**（本文件下方的探针输出里就写着 `session.prompt 是函数=false`）
>   → 改用 `agent.send(msg,'next-step',true)`；
> ③ 7801 是 opencode 的出口，不是中继 → 保留。
>
> 留这段记录是因为"被推翻的三条"比结论本身更容易忘。

## 探针实测结果（隔离 headless DSH，脚本 `scripts/spike-session-prompt-plugin.mjs`）

做法：起隔离的 `dsh headless --patch <插件>`，插件在 `agent/created` 时先订阅 `session/event`
再调用注入口，由插件自己打印事件原文作为证据（不靠外部推断）。

实测输出（原文摘录）：

```
[spike] agent.session 存在=true  session.prompt 是函数=false  agent.inject 是函数=true
[spike] session/event type=user/message role=user source.kind=user rpcId=spike-rpc
        text="SPIKE-…-VIA-INJECT"
[spike] session/event type=user/message role=user source.kind=user rpcId=-
        text="只回复两个字：收到"
[spike] session/event type=user/message role=user source.kind=runtime-context rpcId=-
        text="Current runtime context. …"
```

三条结论：

1. **载荷里 `source.kind` 决定一切** ✓：按参照实现的形状
   `{ id, role:'user', content:[{type:'text',text}], source:{ kind:'user', rpcId } }` 注入，
   立刻产生 `type=user/message`、`role=user`、`source.kind=user` —— **真正的用户消息**。
   我们现在用的 `kind:'recallflow-panel'` 只能落成上下文，这就是差别所在。
2. **我原先的假设是错的** ✗：`agent.session.prompt` **不是函数**（`agent.session` 存在但没有 prompt）。
   能发消息的那个 Session 要从别处取（`ctx.session` 查找或会话控制器服务），**尚未解决**。
3. 普通用户输入的 `source.kind` 也是 `user` 且无 rpcId —— 证实该 kind 就是"真用户输入"的标记。

顺带一条设计约束（由上面推出）：`inject` 注入的**一律**是"用户侧输入"。
因此**不能**把面板助手的回复也灌成 `kind:'user'` —— 那才是真正的"冒充用户消息"。
正确形态是：面板的**用户输入**进会话；面板助手的输出**根本不产生**
（面板退役自己的 agent，只做视图 + 输入口），回复一律来自这条会话本身。


## 尚未验证（实现时必须先解决）

1. `ToolDefinition` 所需的 `output` / `ToolSchema` 字段形状（只读到 `extends ToolSchema`，没读全字段）。
2. 插件注册的路由**是否在 DSH 的鉴权栅栏之内** —— 若在，扩展需要携带 token
   （面板可能从 DSH 页面的 URL 拿到，或由用户粘贴一次）。
3. 跨源可达性（扩展从任意页面发起请求 → 需要 CORS，已有一套只放行本机来源的做法可复用）。
4. ~~`session.prompt` 从插件调用的真实效果~~ → **已部分解决**：拿不到 `agent.session.prompt`（不是函数），
   但**改用 `agent.inject` + 正确载荷即可产生真用户消息**（见上文探针）。剩下的是"面板能否在
   DSH 空闲时主动开启一轮"——需要找到真正的 prompt 入口（`ctx.session` 查找 / 会话控制器服务）。
5. 扩展侧改动量（WS → SSE + POST）。

> ⚠️ **上面这份"待解问题"是 spike 阶段的快照，现在每一条都有答案了**（逐条对照，别当成待办）：
>
> | 当时的问题 | 结论 | 依据 |
> |---|---|---|
> | 1 字段形状没读全 | 已读全并据此注册工具 | `docs/one-session-plugin.md` 上文 + 插件实现 |
> | 2 路由是否在鉴权栅栏内 | **在栅栏之外**（`/recallflow/*` 返回 200 而 `/`、`/api/*` 401） | 隔离实例实测 |
> | 3 跨源可达性 | 已解决：扩展从**后台**（host_permissions）发请求，不受页面同源限制 | `relay.js` 的注释与实现 |
> | 4 空闲会话主动开口 | 已解决：入口是 `agent.send(msg,'next-step',true)`，**不是** `session.prompt` | 探针 v3（第 105 行）+ 活实例实测 |
> | 5 "WS → SSE" | **方向反了**：最终用 **WebSocket**，理由是 MV3 的 service worker 会被回收而 fetch 流不能保活 | 插件头部注释 + 第 196 行的历史说明 |


## 删除清单（实现完成并验证后执行）

> ⚠️ **这是最初写的计划，其中一条与实际执行相反，以 `docs/deletion-plan.md` 为准。**
> 差别最大的是：**桥接的 MCP 工具服务不能删** —— 它是 **opencode 的页面能力出口**，
> 删了会让 opencode 的工具**静默失效**（我准备动手时才发现，已回退）。
> 页面上第 4 条"DSH 插件里的 Agent.inject 注入…"指的是**旧插件**，它已按删除清单第 3 步整包移除。

- 桥接进程（`integrations/opencode/recallflow-mcp`）里的同步部分：`panel-turns` 缓冲、CORS、MCP 工具服务
- DSH 插件里的：`Agent.inject` 注入、`injectedUpTo` 去重、会话绑定诊断
- 客户端 UI 插件整包（`integrations/dsh-client-recallflow-panel`）—— GUI 本来就显示同一条会话
- 三档文本截断（400/1200/2000）
- 两套渲染文案与两次去标签
- 那个尚未修好的重复注入缺陷 —— 随代码一起删除，不再修

---

## 把面板原有的页面能力接进插件（进行中）

面板的**本地助手**原本自带约 55 个页面工具（`lib/assistant/tools.js`），
而 DSH 这侧只暴露了 10 个被动读取类方法。这个改造把它们逐步接过来，
让 DSH 会话直接用上同一套能力 —— 而不是"面板能用、DSH 不能用"。

### 清单怎么分（`lib/shared/bridge-methods.js`）

刻意分成**两套清单**，因为它们服务两个不同的消费者：

| 清单 | 内容 | 谁用 |
|---|---|---|
| `BRIDGE_METHODS` | 原来那 10 个 | **MCP server**（opencode 链路）。契约测试会核对"每个方法都有 dispatch 分支"且"每个方法都被 MCP 真的调用过"（防僵尸条目）——所以插件专用的方法**不能**混进来 |
| `READONLY_CONTENT_METHODS` | 7 个，作用于**活动标签页**、需要内容脚本 | DSH 插件的 `recallflow_browser` |
| `READONLY_BACKGROUND_METHODS` | 12 个，不需要页面（或自己选标签页） | 同上 |
| `EXTENSION_METHODS` | 上面三者之和 = 扩展 dispatch 必须支持的全部 | 契约测试核对"清单 ↔ 分支"不出现空洞 |

分发在 `lib/bridge/relay.js` 的 `dispatch` 里：只读档走**查表**（`READONLY_*_METHODS.includes(method)`）
而不是逐条 `if`，因为清单是唯一来源。契约测试因此补了两条对称检查：
`dispatch` 必须真的引用那两张表，且插件的方法表不许声称扩展做不到的方法（**拼错也会被点名**）。

### 已接入：只读档（19 个，全部 `readOnly: true`）

```
页面类(7)  read_current_page get_page_snapshot get_attribute get_element_text
           inspect_element extract_table wait_for_element
后台类(12) get_ax_snapshot list_tabs list_frames list_downloads take_screenshot
           get_run_trace web_search search_knowledge_base list_knowledge_base
           get_entry list_macros list_userscripts
```

### 批准策略（DSH 这侧**没有**面板那样的批准弹窗，所以必须显式设计）

| 档 | 内容 | 策略 |
|---|---|---|
| **只读**（已接入 19 个） | 读页面/元素/无障碍树/列表/搜索 | **默认开**。不改页面、无副作用 |
| **改页面**（已接入 15 个） | `click_element` `type_text` `press_key` `select_option` `check_box` `set_element_style` `highlight_text` `outline_element` `clear_page_overlays` `scroll_page` `undo_last_action` `click_at` `hover_element` `drag_element` `handle_dialog` | **默认拒绝** → `allowPageActions: true` |
| **浏览器与网络**（已接入 4 个） | `open_tab` `switch_tab` `fetch_webpage` `search_userscripts` | **默认拒绝** → `allowBrowserActions: true` |
| **危险**（已接入 10 个） | `add_entry` `remove_entry` `save_macro` `upload_file` `trust_site` `install_userscript` `install_skill` `run_userscript` `run_macro` `run_javascript` | **默认拒绝** → `allowDangerousActions: true`；其中 `run_javascript` 是任意代码执行，早先探针里"不接受任意代码"的决定在此继承 |
| **刻意不接**（4 个） | `update_plan` `expand_result` `complete_task` `load_skill` | 它们是**面板本地那个 agent 自己的循环/UI 控制**（自己的计划状态、自己的任务收尾、展开自己的结果卡片、往自己的上下文装技能），读的不是页面。DSH 这侧这些概念已经存在（todo 由 DSH 自己的工具管），硬接只会出现"两套计划状态互相打架"。已导出为 `EXCLUDED_AGENT_LOOP_METHODS` 并断言它们不在任何清单里 —— **明确记录，而不是悄悄漏掉** |

合计：元数据 55 个 → 接入 **48**（= 只读 19 + 改页面 15 + 浏览器/网络 4 + 危险 10）、刻意排除 4、其余按档位归入上述表格。
清单总数 **`EXTENSION_METHODS` = 58**（含 MCP 那 10 个）。

### 三档审批：一张门禁表 + 三个开关

### 改页面档的审批：只能"显式开"，因为 DSH 没有批准弹窗

面板原本有批准弹窗（`requiresApproval: true`），而 DSH 这侧**没有** —— 所以"批准"必须落在
一个用户**显式设置**的地方。做法是插件的 `config`：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: recallflow-one
      name: '…/integrations/dsh-plugin-recallflow-one/index.js'
      config: { allowPageActions: true }     # ← 不加这行 = 默认拒绝
```

插件在 `execute` 里门禁：`PAGE_ACTION_METHODS.includes(method) && config.allowPageActions !== true`
→ 直接返回**拒绝**，并在 `reason` 里写清**怎么开**。这一点很重要：如果只说"不允许"，
模型（我）只会换参数反复重试 —— 而多试几次里总有一次会真的点下去。

**还有一条可测试的安全性质**：改页面档**不进 `BRIDGE_METHODS`**，而那个清单是 probe-tool
的白名单 —— 于是"**诊断探针永远不会触发页面动作**"成为契约测试里的一条断言
（把 `click_element` 塞进 `BRIDGE_METHODS` 会让 4 条测试变红，已用突变实验验证）。

### 怎么验证

- 契约测试：`node --test tests/bridge-contract.test.mjs`
  （清单唯一性、MCP ↔ 清单、清单 ↔ dispatch、只读档 ↔ dispatch ↔ 插件方法表）
- 扩展侧的行为：`tests/tab-messaging.test.mjs`（内容脚本晚到时的重试语义）
- 真机验证：插件里的 `recallflow_status` 带 `probe: true` 会对**白名单内**的方法做一次往返探针；
  只读档都在白名单里，所以可以直接探。
  （写操作如 `dev_session_set` **不在**白名单里 —— 它不该从一个诊断入口被触发。）


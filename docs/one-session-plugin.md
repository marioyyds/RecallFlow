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

结论：**`agent.send(message, 'next-turn', true)` 就是"外部输入进会话"的正确入口** ——
它同时做到三件事：产生真正的 `user/message`、唤醒空闲的 driver、开启新一轮。
（`agent.inject` 只做前一件的一半：能产生 user/message 但**不唤醒**空闲 driver，
所以它只适合引导正在进行的那一轮。）

顺带一条形状事实（v2 探针转储）：`agent` 原型上有
`send / followup / steer / inject / cancel / wakeDriver / whenIdle / runMaintenance / turn / step`；
`agent.session` 上只有 `append / snapshotEvents / deriveMessages` 等**日志侧**方法，没有 `prompt`。
`ctx.session` / `ctx.sessions` 存在但**必须先 `inject` 声明**才能取用
（不声明时报 `cannot get property "sessions" without inject`）。

### 至此四块都有了证据

| 需要的能力 | API | 证据 |
|---|---|---|
| 面板的话 → 真用户消息 + 唤醒空闲会话 | `agent.send(msg, 'next-turn', true)` | ✅ 隔离 headless 实测 |
| 载荷形状 | `{id, role:'user', content:[…], source:{kind:'user', rpcId}}` | ✅ 实测产生 user/message |
| 把页面工具给 DSH | `ctx.tools.register(ToolDefinition)` | ✅ 类型声明（形状待读全） |
| 面板 ↔ 插件的传输 | `webServer.register(route)` + SSE | ✅ 类型声明 |

## 选定方案

```
浏览器扩展 ──HTTP/SSE──▶ DSH 插件（进程内，随 DSH 启动）
                          ├─ webServer.register  GET  /recallflow/stream   (SSE)
                          ├─ webServer.register  POST /recallflow/result
                          ├─ webServer.register  POST /recallflow/say  → session.prompt(text,'queue')
                          └─ ctx.tools.register   把页面能力注册成 DSH 工具
```

- **中继进程（7801）整个去掉** —— 同步职责消失，搬字节与工具暴露都由插件承担。
- 用户需要运行的只剩 **DSH** 与**浏览器扩展**。

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


## 删除清单（实现完成并验证后执行）

- 桥接进程（`integrations/opencode/recallflow-mcp`）里的同步部分：`panel-turns` 缓冲、CORS、MCP 工具服务
- DSH 插件里的：`Agent.inject` 注入、`injectedUpTo` 去重、会话绑定诊断
- 客户端 UI 插件整包（`integrations/dsh-client-recallflow-panel`）—— GUI 本来就显示同一条会话
- 三档文本截断（400/1200/2000）
- 两套渲染文案与两次去标签
- 那个尚未修好的重复注入缺陷 —— 随代码一起删除，不再修

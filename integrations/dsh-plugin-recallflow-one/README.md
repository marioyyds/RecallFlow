# recallflow-one —— DSH 单插件集成

把 RecallFlow 与 DSH 的集成从"桥接进程 + 两段对话同步"收成**一个插件 + 一条会话**。
新架构下**没有"同步"**：只有一条会话，浏览器面板是它的另一个视图与输入口。

## 对外只有两件事

| 端点 | 作用 |
|---|---|
| `POST /recallflow/say` | 面板打的字 → **这条会话的真实用户消息**（能唤醒空闲会话） |
| `WS /recallflow/ws` | 一条双向通道：会话事件往下推，工具调用/回执来回走 |
| `GET /recallflow/status` | 连接与登记状态（排查用：`wsReady` / `clients` / `sessions`） |
| `ctx.tools.register` | 把浏览器页面能力注册成 DSH 工具 `recallflow_browser` |

整个集成只有**一个进程**（DSH 自己）、**一个端口**（DSH 自己的 3080），
不需要任何外部中继 —— 7801 桥接仍然存在，但那是给 **opencode** 用的工具服务，
与本插件无关（见 `docs/deletion-plan.md` 的保留清单）。

## 关键依据（都是实测或读自本机类型声明，不是推测）

路径均在 `…/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/…`。

### 1. 发消息进会话：`agent.send(msg, 'next-turn', true)`

```js
const message = deepFreeze({
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user', rpcId },   // ← kind 必须是 'user'
});
await agent.send(message, 'next-turn', true);
```

- **`source.kind` 决定一切**：实测 `kind:'user'` 会产生 `type=user/message, role=user,
  source.kind=user` 的**真用户消息**；自定义 kind（我们最初用的 `recallflow-panel`）
  只能落成模型侧上下文。这个差别是"能不能变成用户消息"的关键。
- **`send` 第三参为 true 才能唤醒空闲会话**。参考实现 `@xmanrui/dsh-im` 用的是
  `agent.inject(...)`，但同一份源码的注释写明：
  "inject() never wakes an idle driver. … this context can only target this live turn's next step."
  即 inject 只引导**进行中**的那一轮，面板要主动开口必须用 send。
- 实测（隔离 headless，`scripts/spike-wake-plugin.mjs`）：空闲会话上的一次 `send`
  同时做到三件事 —— 产生真 user/message、唤醒 driver、开启新一轮
  （send 之后新增 assistant/message 15 条）。
- **`agent.session` 上没有 `prompt`**（实测：不是函数）。`ctx.session(s)` 存在但必须先
  `inject` 声明，否则读取报 `cannot get property … without inject`。

### 2. 注册工具：`ctx.tools.register`

```ts
// dsh-tools/lib/types/index.d.ts
interface Context { tools: ToolRuntime; }
register(definition: ToolDefinition): () => void;          // :636
interface ToolDefinition extends ToolSchema {              // :115
  readonly output: ToolOutputDefinition;                   // 必填
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
}
interface ToolSchema {                                     // dsh-llm/lib/types/types.d.ts:455
  name: string; description: string;
  parameters: Record<string, unknown>;                     // 参数的 JSON Schema
  deferLoading?: true;
}
interface ToolOutputDefinition {                           // :106
  readonly schema: JsonSchemaNode;                         // 输出 JSON Schema
  render(args, value): ContentBlock[];                     // 必填
}
```

实测：在用户正在使用的 DSH 里，`recallflow_browser` 的 schema **出现在模型工具表里** ——
这是"注册成功"的最强证据（比任何日志都直接）。

### 3. 挂路由：`ctx.webServer.register` 与 `registerUpgrade`

```ts
// dsh-host-webserver/lib/types/index.d.ts
interface Context { webServer: WebServer; }
register(route: WebRoute): () => void;                     // :90
interface WebRoute {                                       // :33
  kind: 'exact' | 'prefix';
  path: string;
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
registerUpgrade(route: WebUpgradeRoute): () => void;       // :97
interface WebUpgradeRoute {                                // :41
  path: string;
  /** Owns protocol negotiation and the upgraded socket after dispatch. */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
```

- **路由不在 DSH 的鉴权栅栏内**（实测）：`/` 与 `/api/*` 返回 401，
  而 `/recallflow/*` 返回 200 —— 因此扩展可以直接连，无需 token。
- `registerUpgrade` 只给**裸 Duplex socket**，WebSocket 协议要自己实现。
  本插件**借 DSH 自己依赖树里的 `ws`**（v8.22.0，`dsh-api-gateway` 自己在用）：

```js
const req = createRequire(process.argv[1]);          // 进程 argv[1] 就是 DSH 的 bin
const p = req.resolve('ws');                          // …\dsh\node_modules\ws\index.js
const m = await import(pathToFileURL(p).href);        // ← 必须转 file:// URL！
```

**踩过的坑**：Windows 上 `import()` 不接受裸绝对路径，会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
我第一次的探针只做了 `resolve`、没真的 `import`，所以没暴露它 —— 是插件里的诊断日志
（把每次尝试的失败原因打出来）把它抓住的。

## 调试入口

```bash
node scripts/verify-one-plugin-e2e.mjs 3099     # 对隔离实例跑 11 项（路由/SSE→WS/CORS/状态）
node scripts/verify-live-gate.mjs               # 对真实实例跑闸门五条
node scripts/verify-live-gate.mjs --say         # 额外真的发一句话（有副作用）
node scripts/probe-say.mjs "文本"               # 直接把一句话送进会话
```

## 已知未验证 / 待办

- **端到端（面板 → 真用户消息 → 回复回面板）尚未在真实环境跑通**：
  需要用户重启 DSH（本插件代码生效）与重新加载扩展（连上新通道）。
  闸门见 `scripts/verify-live-gate.mjs`。
- **工具往返只验证到 socket 层**：`callBrowser` 的"无连接时明确失败"有单测，
  但"客户端已连接 → 广播 tool-call → 收到回执 → resolve"只有端到端能覆盖。
- 回声去重已用 `rpcId` 精确匹配（见 `lib/shared/session-view.js`），
  但面板仍需在收到回执时回填 rpcId —— 实测待补。
- 删除清单见 `docs/deletion-plan.md`，**执行前必须先过闸门**。

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
不需要任何外部中继 —— 扩展只连这一个地址。
（曾经还有一条给 **opencode** 用的 7801 工具服务；用户 2026-10-08 明确不再用 opencode 之后，
那条链路已整体删除，见 `docs/deletion-plan.md` 的「已从保留清单移除」一节。）

## 关键依据（都是实测或读自本机类型声明，不是推测）

路径均在 `…/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/…`。

### 1. 发消息进会话：`agent.send(msg, 'next-step', true)`

```js
const message = deepFreeze({
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user', rpcId },   // ← kind 必须是 'user'
});
await agent.send(message, 'next-step', true);
```

- **`source.kind` 决定一切**：实测 `kind:'user'` 会产生 `type=user/message, role=user,
  source.kind=user` 的**真用户消息**；自定义 kind（我们最初用的 `recallflow-panel`）
  只能落成模型侧上下文。这个差别是"能不能变成用户消息"的关键。
- **`send` 第三参为 true 才能唤醒空闲会话**。参考实现 `@xmanrui/dsh-im` 用的是
  `agent.inject(...)`，但同一份源码的注释写明：
  "inject() never wakes an idle driver. … this context can only target this live turn's next step."
  即 inject 只引导**进行中**的那一轮，面板要主动开口必须用 send。
- **第二参用 `'next-step'` 而不是 `'next-turn'`**（2026-10-07 修，来自用户反馈
  "recallflow 不能发消息"）。`InboxTarget = 'next-turn' | 'next-step'`，而 `send` 的注释写着
  cancel 之后 "…even when its **message is cleared before the driver claims** it"。
  `'next-turn'` 要等**整轮结束**才可能被取走；DSH 连续跑轮次时，消息会在轮次边界被清掉 ——
  表现就是 `/say` 返回 `ok:true` 但会话里看不到。`'next-step'` 是**当前这一轮的下一个步骤**
  就取走。这一条由 `tests/dsh-one-plugin.test.mjs` 钉住（并且验证过改回去会让它失败）。
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

## 选会话：面板可以指定"这条消息进哪条会话"

`POST /recallflow/say` 除 `text` 外接受可选的 **`sessionId`**：

```jsonc
{ "text": "你好", "sessionId": "session-723c8b32-…" }   // 指定
{ "text": "你好" }                                      // 不指定 = 按 currentSessionId（旧行为）
```

- **不指定**：与以前完全一样，挑"最近活跃的那条"。
- **指定且找得到**：消息进那条会话（走 `pickSession` 的 preferred 分支）。
- **指定却找不到**：**404 + 明确原因，绝不回退到别的会话**。这一点是刻意的 ——
  "以为发给了 A、实际进了 B"**不会报错**，是最难发现的一类错，所以宁可失败也不猜。
  为此专门加了 `findSessionStrict()`（`pickSession` 是"尽力而为"版本，只用于"没指定"的情形）。

`GET /recallflow/status` 除 `sessions`（id 列表，**保留兼容**）外新增
**`sessionList: [{ id, lastAt, live, parentSession }]`** —— 面板的选择器按 `lastAt` 排序、
标出"最近活跃"，并用另外两个字段把**发不进去/不该发**的会话标出来（见下）。

### 列表能列多全（2026-10-08 实测后改写）

**能列全，走 `sessionQuery.listSessions()`。** 这一条是实测出来的，不是设计推演：

| 试过的来源 | 结果 |
|---|---|
| 会话事件 + `ctx.agents.list()` 兜底 | **只有 1 条** —— DSH 的类型声明写着 `list(): Agent[]` 是 *"All **live** agents"*，只有**活着的** |
| `SessionStore.list()`（`sessions` 服务）| 可用，但方法名是 `enter / detachEntered / liveEntryFor / emitDisposed` —— 它是"**已载入的活会话**"登记表，不是历史索引 |
| **`sessionQuery.listSessions()`** | **17 条** ✓（侧边栏那份列表就是从它来的；DSH 自己的插件也这么用：`inject: ['agents','sessionQuery','typert']`）|

用的是 **`ctx.get('sessionQuery', false)` 而不是 `inject`**：cordis 的 inject 失败会让
**整个插件不加载**，而这条只是"让选择器更全"，不该有这个权力（官方注释：
*"Read a service from the store without the inject requirement"*）。`listSessions()` 是异步的，
所以走**缓存 + 后台刷新**（启动刷一次、每次 `/status` 再刷一次），而不是让同步的
`statusSnapshot()` 去 await。

### 两个字段各管什么（都来自 DSH，不靠 id 形状猜）

- **`live`**（`SessionRecord.live`）：`false` = 那条会话**没载入**。插件只能把消息送进
  载入过的会话（那种才拿得到 agent）—— 面板会显示
  「（未载入·发送前请先在 DSH 里打开它）」，让用户在**选择时**就看到，
  而不是打完字才撞上 `503 没有可用的会话`。
  **为什么不自动载入** ✗：`SessionStore` 的 `enter(session: Session)` 要的是**实例**而不是 id，
  `create` 的注释是 *"Create a live child session from an exact prefix of a live source"* ——
  都是 fork/子会话用的，硬用只会**动到用户的会话上下文**，所以按"不硬做"处理。
- **`parentSession`**（`SessionHeader.parentSession`）：非空 = **子会话**（subagent / fork），
  面板标成「（子会话）」。17 条里有 3 条是**裸 uuid**（`901e9a29…` / `0c2f31d3…` / `4bf8230e…`），
  在磁盘上与正常会话同处一个 session store —— **光看 id 形状分不出语义**，所以用这个字段判。

`/status` 里还有一个 `sessionStore` 自检字段（`available / methods / used / count / error`
与 `queryAvailable / queryMethods / queryUsed / queryCount / queryError`）：
面板在 shadow DOM 里、console 不一定读得到，**这个字段是把"为什么列不全"变成可观测事实的唯一窗口**。

### 能不能"载入一条没活着的会话"？（2026-10-08 查证，**已在真机上测出来**）

**结论：DSH 有这套 API、语义也正对，但插件拿不到那个服务 —— 这条路走不通。**
探针实测（重启后读 `/status`）：

    sessionController.available = False        ← 插件侧拿不到
    methods = （空）

也就是说 `resolveAgent`（*"Resolve or **resume** one ordinary Session … @returns **the live Agent**"*）
对插件是**关着**的 —— **"把消息送进一条没载入的会话"不是改插件能绕开的事**。
这条结论也回答了本文开头那个现象：选了一条 `live:false` 的会话，消息**必然**发不出去（503）。

**为什么拿不到（同一天在 DSH 自己的类型里查到，代码级证据）**：那个控制器的"客户端面"是经
`ctx.remote.session` 用的，而 `ctx.remote` 在 DSH 的类型里声明为 **`remote: ClientRemote`** ——
**`ctx.remote` 属于客户端**（GUI 自己的插件），**服务端插件没有它**。于是三条路都关着：

| 路 | 为什么不通 |
|---|---|
| `ctx.get('sessionController', false)` | 取不到（**真机实测** `available:false`）|
| `ctx.remote.session` | `ctx.remote` 是 `ClientRemote` —— **客户端面**，服务端插件没有 |
| `SessionStore.enter(session: Session)` | 要的是一个 **`Session` 实例**，而拿不到已存会话的实例 |

所以：**插件侧无法把一条没载入的会话载入**。想发消息给它，只有**先在 DSH 里打开它一次**
（点了它就变 `live`，`/status` 的 `sessionList[].live` 会跟着变 true）。

`dsh-api-session-controller` 声明的 **Host** 服务叫 **`sessionController`**（挂在 cordis 的
`Context` 上，**不是**客户端那个 `ctx.sessions`；后者是 GUI 自己用的面）。它的方法：

| 方法 | 注释原文 | 对我们的意义 |
|---|---|---|
| `resolveAgent(sessionId)` | *"Resolve or **resume** one ordinary Session … @returns **the live Agent**"* | 若能拿到就是缺的那一步 —— **但测出来拿不到** |
| `inspect(sessionId, signal?)` | *"Inspect one attached or persisted Session **without activating its Agent**"* | **只读**读历史 —— "真正切视图"要的那一步 |
| `create(request)` | *"Create or **idempotently adopt** one ordinary Session"*（客户端面写作 `create({ sessionId })`）| 也需要同一个服务 |
| `list(request, signal)` | *"Read all visible Session rows **without resuming an Agent**"* | 只读列目录（现已用 `sessionQuery.listSessions()` 列全）|

**还剩一条门没测完**：那个 controller 是 `TypertRemoteService`，注释写着它
*"backing the generated **`ctx.remote.session`** namespace"*，而 DSH 内置插件里确实有
`inject: ['agents','sessionQuery','**typert**']`。探针已加上 `typertAvailable / typertMethods /
remoteKeys / remoteSession` 四个字段（仍是**只读**）—— **要等下一次重启 DSH 才有值**。

**顺带修掉一个我自己造的坑**：`readSessionOk` 第一版永远是 `false`，是**探针的时序 bug**
（`refreshStoreSessions()` 是异步的，而读历史要用 `currentSessionId`/`sessions`；两句并列写在
加载处 → 探针跑在登记表还空着的时候 → `id` 取到空串 → 读取被跳过）。已改成
`refreshStoreSessions().then(() => probeController())`。
**同一服务上的 `listSessions()` 是成功的**（`queryCount=17`），所以 `readSession` 大概率也能用 ——
但那是推断，**实测值要等重启后的 `readSessionOk`**。

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

## 页面的能力分档与审批策略

`recallflow_browser` 的 `method` 按风险分档。分档**由 `lib/assistant/tool-metadata.js` 的 `risk` 决定**，
不是拍脑袋；清单定义在 `lib/shared/bridge-methods.js`（扩展 dispatch 与插件方法表都以它为准，
契约测试核对三者对齐）。

| 档 | 数量 | 例子 | 默认 | 开关 |
|---|---|---|---|---|
| 只读 | 19 | `browser_read` `read_current_page` `get_page_snapshot` `list_tabs` `web_search` … | **开** | —— |
| 改页面 | 15 | `click_element` `type_text` `press_key` `scroll_page` `highlight_text` `outline_element` … | 关 | `allowPageActions` |
| 浏览器与网络 | 4 | `open_tab` `switch_tab` `fetch_webpage` `search_userscripts` | 关 | `allowBrowserActions` |
| 危险 | 10 | `add_entry` `remove_entry` `upload_file` `install_userscript` `run_javascript` … | 关 | `allowDangerousActions` |

另外**刻意不接** 4 个（`update_plan` `expand_result` `complete_task` `load_skill`）：它们读的不是页面，
而是**面板本地那个 agent 自己的循环与 UI**；DSH 这侧这些概念已经存在，硬接只会出现"两套计划状态互相打架"。
已导出为 `EXCLUDED_AGENT_LOOP_METHODS` 并断言它们不在任何清单里 —— **明确记录，而不是悄悄漏掉**。

**为什么是"开关"而不是弹窗**：面板原本有批准弹窗（元数据里全部 `requiresApproval: true`），
而 **DSH 这侧没有**。所以"批准"只能落在用户显式设置的地方 —— 插件的 `config`：

```yaml
- insert:
    - id: recallflow-one
      name: '…/integrations/dsh-plugin-recallflow-one/index.js'
      config: { allowPageActions: true }   # 要用哪一档就开哪个
```

被拒时返回 `{refused, method, tier, reason}`，reason 写清**开哪个开关**、以及改完要重启 DSH。
**给模型的约定**：被拒时**不要换参数反复重试** —— 那等于绕开用户的决定，而多试几次里总有一次会真的落下去。

三档都**不在** `BRIDGE_METHODS` 里，而那个清单是诊断探针（`probe: true`）的白名单 ——
于是「**诊断入口永远不会触发有副作用的动作**」是一条被契约测试钉住的性质
（把 `click_element` 塞进 `BRIDGE_METHODS` 会让 4 条测试变红，已用突变实验验证）。

## 装成包（这样 DSH 插件管理器才看得到它）

**现象**：以文件路径 insert 时，插件在插件管理器里**看不到**。原因是 DSH 自己的判定：

```js
// dsh-plugin-manager/lib/types/index.js: listPlugins()
if (candidate === undefined || … || actual?.parent.tree.ctx.fiber.entry?.id !== 'include')
  return { ...entry, readOnlyReason: 'unaddressable' };
```

即：插件的加载条目必须来自 **include（bundle）**。文件路径 insert 的父条目是 `insert`，
于是被标成 `unaddressable`。

**做法**：本目录已带 `package.json`（`dsh.bundle.patch` → 自带的 `cordis.patch.yml`），
规格对齐真实第三方 bundle（对照 `@xmanrui/dsh-im`：两行 patch —— `id` + **包名**）。

```powershell
cd ~/.dsh/profiles/web
Copy-Item cordis.patch.yml "cordis.patch.yml.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item package.json     "package.json.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"

# **必须 link:**。拷贝式会坏 —— 下面有实测
pnpm add link:D:\Desktop\workspace\code\ai\bookmark-sorter\integrations\dsh-plugin-recallflow-one
```

然后 `package.json` 的 `dsh.profile.bundles` 加 `"recallflow-dsh-plugin"`，
**并在同一次改动里删掉** `cordis.patch.yml` 里那条文件路径 insert ——
同时存在会让插件**加载两次**，`/recallflow/*` 路由冲突。之后重启 DSH。
回滚：恢复两个 `.bak`、重启。

### 为什么必须 `link:`（两种方式都实测过）

插件有 3 个 import 指向包外（指向仓库里的共享模块，刻意的：两侧共用一份实现，不复制）：

    ../../lib/shared/tool-results.js  ../../lib/shared/dev-session.js  ../../lib/shared/evidence-store.js

按 profile 布局（`<profile>/node_modules/<name>`）实测：

```
【A 拷贝式安装】✗ Cannot find module '…\copy-profile\lib\shared\tool-results.js'
【B 链接式安装】✓ import 成功（导出 apply, inject, name）
```

原因：Node 默认跟随符号链接、按**真实路径**解析模块，于是那三个 `../../` 回到仓库里；
拷贝式则解析到 `<profile>/lib/shared/*` —— 不存在。


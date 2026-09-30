# DSH 原生插件：会话双向同步（方案 B）

把 DSH 会话里的事同步到**你正在浏览的页面上的 RecallFlow 面板**，
并把**面板里的对话**带回 DSH 的上下文（双向）。

## 为什么需要插件（而不是 hook）

DSH 的 Claude 风格 hook 载荷里**没有助手的成文回答**（实测：`transcript_path` 是空串、
`Stop` 只有 `stop_hook_active`）。而会话事件里有 `assistant/message` —— 这是唯一干净的来源。

两者对照：

| 内容 | hook | 本插件 |
|---|---|---|
| 用户提示词 | ✅ | ✅ |
| 工具调用（bash / 读写文件 / 其它 MCP） | ✅ | ✅ |
| **助手的成文回答** | ❌ | ✅ |

## 反向：面板对话 → DSH 上下文

会话创建时，插件拉取桥接的 `GET /panel-turns`，把面板最近的对话拼成一段上下文，
用 DSH 官方的 **`Agent.inject(message)`** 注入本会话。

**为什么是 inject 而不是自己往会话里 append 事件**（依据 `runtime-types.d.ts`）：

> Queue model-facing context for the next pre-step **without waking the driver**.
> A running driver claims it at the **nearest later step boundary**.
> `@param message` - identified injected context and the source that supplied it.

即：不出动 driver、在步边界被认领 —— **不会打断运行中的 agent loop**。
自行注入会话事件则可能破坏 loop 的状态机，那是拿正在使用的 DSH 冒险，不做。

三个要点：

1. **`source.kind = 'recallflow-panel'`**，且该 kind 同时列进 `INJECTED_SOURCE_KINDS` ——
   否则注入的这段会被当成"用户说的话"再推回面板，**形成回环**。
2. 注入文本里写明「这是你在浏览器面板里与**另一个**助手的对话，不是用户对你说的」——
   这一点必须写在上下文里，不能只写在工具描述里（模型未必会去调工具）。
3. 只在会话创建时注入一次：行为可预期，不会在会话中途改变上下文。

### 自定义 source.kind 会不会被 DSH 拒掉？

这是我一度无法确认、又只能静默失败的点 —— 注入被拒的话，我的 `catch` 会把它吞掉，
表现和"面板没对话"完全一样。查过 DSH 的准入代码后确认**不会**：

```js
// dsh-session-format-v3-to-v4/lib/index.js
function rewriteV3MessageSource(source, seq, role) {
  const kind = source["kind"];
  if (typeof kind !== "string" || kind.length === 0) throw new SessionFormatError(…);
  if (kind === "plugin") return rewritePluginSource(source, seq, role);  // 只有这个已退役的包装会被改写
  return source;                                                        // 直接 kind 原样保留
}
```

该文件顶部的注释说得很直白：**"Native source admission preserves unknown attribution
and refuses retired plugin wrappers."**

结论：**未知的 `kind` 会被原样保留，没有取值白名单**；唯一会被拒/改写的是已退役的
`"plugin"` 包装语法。因此用自定义 kind 是正确的做法，而**不能**改用
`{ kind: 'plugin', plugin: … }` 那种旧包装 —— 那恰好是被拒的那种。

约束只有一条：`kind` 必须是非空字符串（`assertV4MessageSources` 在会话装载时校验）。

### `inject` 不会替你铸消息 id —— 必须传**完整**消息

这是同一个"静默失败"家族的第二个陷阱，读实现才看得出来：

```js
// dsh-agent-loop/lib/index.js
inject(input) { this.send(input, "next-step", false); }              // 原样透传
send(message, target, wakeup) { … this.inbox.splice(…, [message]); }  // 原样入队
```

而 `dsh-llm/lib/types/message.d.ts`：

```ts
interface MessageBase { readonly id: MessageId; … }        // id 必填
type NewMessage = Omit<…, 'id'>;                           // 「新消息」形状省略 id
function createMessage(input) { … id: brandString(randomUUID()) }   // 官方在此铸 id + deepFreeze
```

**`inject` 并不调用 `createMessage`** —— 只给 `{ role, content, source }` 的话消息缺少稳定身份，
下游抛错后被本插件的 `catch` 吞掉，**表现与「面板本来就没对话」完全一样**。

因此本插件自己铸 id（`recallflow-panel-<uuid>`；`MessageId` 运行时就是字符串）并逐层冻结，
对齐 `createMessage` 的行为。每次注入铸新 id —— 否则两次注入会被当成同一条消息。

模型需要更多时，用 `panel_history` 工具（默认最近 50 条，上限 200）。

## 挂载点（都来自 DSH 的类型声明，非猜测）

```
dsh-session  SessionEvent = { type, data }
  'assistant/message'  data.message.content: ContentBlock[]   ← 取 TextBlock 的 text
  'user/message'       data 本身就是 UserMessage
  'tool/call'          data.name / data.arguments(JSON 字符串) / data.callId
  'tool/result'        data.message.toolCallId / data.error

Cordis 事件  'session/event'(session, event)   ← 一个钩子点覆盖全部会话事件
             'session/created'(session)
```

刻意忽略 `reasoning` 块：那是模型的思考，不是它说的话，显示出来会误导用户。

## 安装

插件需要被 DSH 的 loader 解析到。**推荐走 Plugin Manager**（侧边栏「插件」页），
它按绝对路径读取包的 `package.json` 并处理解析 —— 这也是 DSH 官方推荐的安装方式。

如果想手工写进 profile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- insert:
    - id: recallflow-panel-sync
      name: 'dsh-plugin-recallflow-panel'   # 或包目录的绝对路径
      config:
        port: 7801
        token: 'recallflow-local-bridge-v1'
```

> 解析方式实测（Node 侧）：
> `require.resolve('D:/…/index.js')` ✅ ／ `import('file:///D:/…/index.js')` ✅
> `require.resolve('file:///D:/…')` ❌ ／ `import('D:/…/index.js')` ❌
> 也就是说**两种载入方式接受的写法不同**。我不确定 DSH loader 用哪一种，
> 所以推荐用 Plugin Manager，而不是赌一个写法。

## 生效条件

- profile 未启用 HMR 时，**配置变更保留到重启** —— 加插件条目后需重启 DSH
  （当前 profile 未提及 HMR，因此需要重启）。
- 面板侧渲染代码已就位，但浏览器扩展仍需**重载**才能显示。

## 验证（不需要重启 DSH）

```powershell
$env:RECALLFLOW_MCP_PORT='7802'; $env:RECALLFLOW_EXT_TIMEOUT_MS='3000'
$env:RECALLFLOW_EVIDENCE_DIR="$env:TEMP\rf-evidence-plugin"
node integrations/opencode/recallflow-mcp/index.js --http   # 后台
node scripts/verify-dsh-plugin.mjs
```

该脚本用**假的 Cordis context** 调 `apply()`，喂真实形状的会话事件，确认它们经 `/event`
落到桥接队列。实测 8/8 通过，其中包含「助手成文回答已同步」与「reasoning 块未被显示」。

**未覆盖**：DSH 的 loader 能否解析并挂载本包 —— 那需要重启 DSH 才能验证。
本插件因此**尚未在真实 DSH 中运行过**，只验证了它自身的逻辑与投递链路。

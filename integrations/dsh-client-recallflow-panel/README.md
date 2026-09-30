# DSH 客户端 UI 插件：把 RecallFlow 面板的对话画进 DSH 界面

目标：**在 DSH 对话里直接看到浏览器面板的消息**，而不是只让它进模型上下文（后者界面不可见）。
**不冒充用户消息** —— 它是一条独立的卡片，不产生任何 `user` 角色消息。

## 它是什么

一个 **DSH 客户端插件**（浏览器侧），注册到对话区插槽
`conversation.chat.turnTail`（契约：`kind:'list'`、`scope:'session'`、
"entries without content return null"）。

面板没有新消息时返回 `null`；有新消息时在轮次末尾出一张卡片：

```
📣 浏览器 RecallFlow 面板
与另一个助手 agent 的对话 · 不是用户对本会话说的话
👤 你在面板：…
💬 面板助手：…
```

## 数据从哪来

浏览器端**直接**向桥接取（`GET http://127.0.0.1:7801/panel-turns`）。
桥接已对本机来源开放只读 CORS（见 `integrations/opencode/recallflow-mcp/index.js` 的 `applyCors`）——
因此**不需要**服务端插件中转，也就不必实现 DSH 的 typert/RPC 那一套。
`index.js` 是有意的空占位。

## 为什么是这个入口格式

客户端入口**不是普通 ESM**，而是 `window.__ModuleLoader__.load({ id, factory })` 外壳。
依据（读实现，非猜测）：`dsh-client-modules/lib/index.js`

```js
/** Concatenate one or more factory registrations without reading or composing source maps. */
function buildComboScript(resources, sourceMapUrl) {
  let source = "";
  for (const resource of resources) source += `${prepareSource(resource).source};\n`;
  return comboScript(source, sourceMapUrl);
}
```

注释写明是 **factory registrations**，且只是**原样拼接** —— 所以每个包的 `client.js`
必须自带外壳。`react` 由加载器提供（生态里构建时把它标为 external），因此可以直接 `require('react')`，
**不需要打包器**：本文件是手写的，用 `React.createElement` 而非 JSX。

## 安装 / 启用（已在用户的 web profile 中完成）

用**官方路径**（与插件管理器 UI 同一条命令）：

```powershell
node "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add `
  "D:\Desktop\workspace\code\ai\bookmark-sorter\integrations\dsh-client-recallflow-panel"
```

它同时做了两件事（手改容易漏第二件）：

1. `dependencies` 增加 `link:` 依赖
2. `dsh.profile.bundles` 增加本包 —— **这一步是客户端入口被打进 combo 的前提**

## 生效条件与已知限制

- **需要先重启桥接**：客户端要跨源取数，而桥接的 CORS 支持是后加的。
  若桥接还是旧进程，浏览器会直接挡住这次 fetch —— 表现是「卡片不出现」，
  而控制台会打出明确原因（见下）。判据：带 `Origin` 请求 `/panel-turns` 时应回
  `Access-Control-Allow-Origin`（只对本机来源回）。
- **DSH 无需重启，刷新页面即可**（这条我最初判断错了，实测纠正）：
  客户端入口由服务端按「已启用 bundle 列表」组装成 combo
  （`/plugins/??<id>/client.js,…&rev=<hash>`）。实测：`dsh plugin add` 之后
  **DSH 进程未重启**，但页面刷新后 combo 已包含本包，且控制台出现「已装载」。
  `rev` 是 (id, rev) 对的哈希，会随内容变化 —— 因此刷新后拿到的就是最新代码。
- **桥接重启会清空 `panelTurns`**：那是内存缓冲。所以重启桥接后，
  要**在面板里再说一句**才会有内容可展示（不会自动回填历史）。
- **轮询在页面加载时就启动**（不是等第一个卡片挂载）：卡片挂在每轮末尾，若挂载才启动轮询，
  首批数据一定晚于那次挂载 —— 于是装好后要等到**下一轮**才显示。提前启动后，
  第一次轮次挂载时数据通常已就绪，卡片立刻可见。
- 卡片只在**面板出现新消息**时出现；同一批内容不会在后续轮次重复
  （进度按"已展示到哪一条 at"记在模块级，并在挂载时推进）。
- **失败会写控制台**（这也是排查入口）：装载成功打 `[recallflow-panel-ui] 已装载…`；
  取数失败打一行 warn，并把最可能的原因写进去（HTTP 404 → 桥接可能是旧代码；
  `Failed to fetch` → 桥接未启动或没有开放只读 CORS）。同一种失败只打印一次。
  浏览器扩展的 `read_console` 可以直接读到这些行 —— 排查不必靠猜。
- 本插件**不产生任何会话消息**，因此不存在"把面板的话算成用户说的"这个问题。

## 推荐的启用顺序

1. 重启桥接（终端 Ctrl+C → 重跑 `node integrations/opencode/recallflow-mcp/index.js --http`）
2. 在面板里说一句话（让 `panelTurns` 有内容）
3. **刷新 DSH 页面**（无需重启 DSH 进程）
4. 在 DSH 里完成一轮对话 → 轮次末尾应出现 `📣 浏览器 RecallFlow 面板` 卡片

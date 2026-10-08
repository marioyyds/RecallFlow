# recallflow-mcp

RecallFlow 的 MCP server，让 **opencode**（或其他 MCP 客户端）通过 RecallFlow 的**真实浏览器会话**
读取网页 / 调试前端，并拿到**带时间戳 + 哈希、可复核**的证据快照。

## 架构

它与 RecallFlow 扩展共用**同一个本地端口**，两种传输模式：

```
① stdio 模式（默认，单实例）
   opencode ──(MCP over stdio)──► recallflow-mcp ──┐
                                                   ├──(WebSocket / HTTP 长轮询 :7801)──► RecallFlow 扩展
② HTTP 模式（--http，推荐多实例）                  │
   opencode A ─┐                                   │
   opencode B ─┼─(MCP over Streamable HTTP /mcp)──►┤
   opencode C ─┘                                   │
                                                   └──► 证据归档 ~/.recallflow-evidence/*.json
```

**为什么推荐 HTTP 模式**：MCP 的 stdio 传输是 1:1 的，所以 N 个 opencode 实例会各自拉起一个
MCP server 进程；而扩展只能连上**占用桥接端口的那个**进程 —— 结果只有 1 个实例能读页面。
HTTP 模式下只常驻**一个** server，N 个客户端各持一条独立会话（`mcp-session-id`），所有实例都能用。

## 工具

| 工具 | 说明 |
| --- | --- |
| `recallflow_session(id?, limit?)` | **读取用户从浏览器面板交接出来的会话**（标识形如 `RF-7K2M9X`）：页面、面板对话、拾取元素（含源码 `file:line`）、以及复制那一刻的控制台错误快照。不传 id 时列出最近可用的标识。 |
| `browser_read(url, waitFor?, maxChars?)` | 用真实浏览器会话读取页面，归档并返回 `{url, title, fetchedAt, snapshotHash, text, quotes}` |
| `page_screenshot(label?, fullPage?, format?, quality?, includeImage?)` | 给活动标签页截图并归档，返回图片内容块；纯文本模型可传 `includeImage:false` 只取元数据与归档路径，避免把 base64 塞进上下文 |
| `evidence_get(hash?, url?)` | 按哈希或 URL 取回已归档快照，用于复核引用 |
| `read_console(level?, limit?)` | 读取活动标签页最近的 console 输出与未捕获异常；栈内本项目源码 URL 会转成磁盘路径 |
| `read_network(filter?, limit?)` | 读取活动标签页最近的 fetch/XHR（状态码、耗时、发起位置） |
| `page_health(cursor?, since?, levels?, limit?)` | **增量**体检：自上次检查以来新增的错误/警告/失败请求，按「级别+文案+首个项目内帧」去重计数 |
| `verify_change(targets?)` | **闭环验证**：一次性核对目标元素的渲染态断言 + 是否引入新错误 |
| `get_element_source(ref?\|selector?\|text?)` | 元素 → 框架源码位置（React/Vue/Svelte 开发构建），返回 `{file,line,column,framework,component}` |
| `get_picked_element()` | 用户在页面上拾取的元素（选择器 + 语义定位 + 源码位置） |
| `dev_session_get()` | 读取共享开发会话：`projectRoot / devUrl / changedFiles / targets` |
| `dev_session_set(...)` | 写入开发会话；写入 `projectRoot + devUrl` 后源码 URL 才会转换成磁盘路径 |

### 前端调试闭环

```
① 拾取元素 → get_element_source → D:\proj\src\Button.tsx:42:7
② agent 改代码
③ HMR 生效
④ verify_change → 断言渲染态 + 新错误    └─ 未通过则回到 ①
⑤ page_health  → 增量错误体检
```

前置条件：先 `dev_session_set({ projectRoot, devUrl })`，否则源码位置保持为开发服务器 URL。

## 安装

```bash
cd integrations/opencode/recallflow-mcp
npm install
```

## 配置到 opencode

### 方式一：全局配置（所有项目可用）

**先手动常驻启动一个 server**（不要由 opencode 拉起）：

```bash
node index.js --http
# 建议用强 token：
# RECALLFLOW_BRIDGE_TOKEN=<随机长字符串> node index.js --http
```

再在 `opencode.json` 里配远程 MCP：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "recallflow": {
      "type": "remote",
      "url": "http://127.0.0.1:7801/mcp",
      "enabled": true,
      "headers": { "X-RecallFlow-Token": "recallflow-local-bridge-v1" },
      "oauth": false,
      "timeout": 90000
    }
  }
}
```

> **⚠️ `timeout` 必须显式设置。** opencode 的 MCP 请求超时默认只有 **5000ms**，
> 而 `browser_read` / `page_health` / `verify_change` 需要等扩展响应（可能数十秒）。
> 不设置会表现为「工具一调用就超时」。建议 `60000` ~ `120000`。
>
> `oauth: false` 也是必要的：本服务不做 OAuth，不关闭自动探测会让客户端尝试发现认证流程。

### 方式二：项目级配置（可选，用于多项目隔离）

把上面的 remote 配置放进**项目根**的 `opencode.json`，并让项目自带技能：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "skills": {
    "paths": ["~/.config/opencode/skills", "integrations/opencode"]
  },
  "mcp": {
    "recallflow": {
      "type": "remote",
      "url": "http://127.0.0.1:7801/mcp",
      "enabled": true,
      "headers": { "X-RecallFlow-Token": "recallflow-local-bridge-v1" },
      "oauth": false,
      "timeout": 90000
    }
  }
}
```

> **⚠️ 两个实测确认的坑（都会静默出错，务必注意）：**
>
> **1. 配置是深合并，不是替换。** 如果全局 `~/.config/opencode/opencode.json` 里还有
> `mcp.recallflow` 的 `type: "local"`，它的 `command` 字段会**残留**进项目里的 remote 配置，
> 产生 `{type:"remote", command:[...]}` 这种违反 `McpRemoteConfig`（`additionalProperties: false`）
> 的非法组合。**必须把全局那条删掉**，只保留项目级这一条。
>
> **2. `skills.paths` 是数组替换。** 一旦在项目里写了这个键，全局的那个数组就不再生效 ——
> 所以必须把 `~/.config/opencode/skills` 一并列上，否则你的其他技能（如 `dev-expert`）会消失。
> 另外 `paths` 项应指向**「子目录才是技能」的父目录**（如 `integrations/opencode`），
> 直接指向某个技能目录本身不会被识别。

技能文件以仓库内的 `integrations/opencode/recallflow-evidence/SKILL.md` 为**唯一来源**，
避免与全局副本产生版本漂移。若全局存在同名副本，opencode 会优先采用项目路径的那份。

用官方 CLI 自查（这两条命令是验证配置的最快方式）：

```bash
opencode debug config   # 打印合并后的最终配置（确认无残留 command、timeout 正确）
opencode debug skill    # 列出实际加载的技能及来源路径
```

### 备选：stdio 模式（单实例）

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "recallflow": {
      "type": "local",
      "command": ["node", "<绝对路径>/integrations/opencode/recallflow-mcp/index.js"],
      "enabled": true,
      "timeout": 90000
    }
  }
}
```

**多开 opencode 时不要用这个模式** —— 只有先占用 7801 的那个进程能连上扩展，
其余进程调用工具会立刻收到明确报错（而不是空等超时）。

再把配套技能放到 opencode 技能目录：

```
~/.config/opencode/skills/recallflow-evidence/SKILL.md
```

**重启 opencode**（MCP 配置只在启动时加载）。HTTP 模式下改 server 代码只需重启 server 进程，不必重启 opencode。

## 常驻 server 的日常运维

HTTP 模式下 server 是**独立常驻进程**，需要你在使用前启动一次。扩展会**自动重连**，
不需要重载扩展。

```bash
# 启动（推荐在 integrations/opencode/recallflow-mcp 目录下）
node index.js --http

# 或从任意目录
node <仓库路径>/integrations/opencode/recallflow-mcp/index.js --http
```

```bash
# 确认存活 + 扩展是否已接入
curl http://127.0.0.1:7801/health
# → {"ok":true,"ws":true,"queued":0}
#             ↑ ws:true 表示扩展已连上；false 时工具会报「扩展未连接」
```

```powershell
# 停止（Windows）：结束占用 7801 的进程
Get-NetTCPConnection -LocalPort 7801 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

```bash
# 停止（macOS / Linux）
lsof -ti:7801 | xargs kill
```

### 排障对照表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 扩展控制台报 `ERR_CONNECTION_REFUSED`（`ws://127.0.0.1:7801`） | **server 没在运行** | 执行上面的启动命令；扩展会在数秒~1 分钟内自动重连，无需重载扩展 |
| `/health` 返回 `"ws":false` | server 在跑，但扩展未接入 | 打开/刷新浏览器；确认扩展已启用 |
| 工具一调用就超时 | opencode 的 `timeout` 没设（默认 **5000ms**） | 配置里加 `"timeout": 90000` |
| 工具报「未知 MCP 工具」 | 连到了旧实例或旧代码 | 重启 server 进程 |
| 启动时报 `EADDRINUSE` | 已有另一个 server 占用 7801 | 只保留一个；先停掉旧的 |
| 改了 `index.js` 但行为没变 | 常驻进程加载的是旧代码 | 重启 server 进程（HTTP 模式下不必重启 opencode） |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RECALLFLOW_MCP_HTTP` | 未设置 | 设为 `1` 启用 Streamable HTTP 模式（等价于 `--http`） |
| `RECALLFLOW_MCP_TRANSPORT` | 未设置 | 设为 `http` 同样启用 HTTP 模式 |
| `RECALLFLOW_MCP_PORT` | `7801` | 扩展连接的桥接端口，也是 HTTP MCP 端点的端口 |
| `RECALLFLOW_BRIDGE_TOKEN` | `recallflow-local-bridge-v1` | 共享 token。**HTTP 模式建议改成随机长字符串** |
| `RECALLFLOW_EXT_TIMEOUT_MS` | `60000` | 等待扩展响应超时（应小于 opencode 的 `timeout`） |
| `RECALLFLOW_EVIDENCE_DIR` | `~/.recallflow-evidence` | 证据归档目录（`dev-session.json` 也在此） |

## 安全边界

`/mcp` 与桥接共用两道防护，且**不做 CORS 放行**：

1. **Host 白名单**（`127.0.0.1` / `localhost` / `[::1]`）—— 防 DNS rebinding；
2. **必须携带 token**：`X-RecallFlow-Token` 头或 `Authorization: Bearer <token>`。

要求「自定义头」本身就是关键防线：网页脚本无法在无 CORS 预检的情况下携带自定义头，
而我们从不放行预检 —— 因此恶意页面即使能向本机端口发请求也拿不到鉴权。
`/health` 是唯一免鉴权路径（只读、无副作用，供扩展探活）。

## 前置条件

1. 浏览器已安装并启用 RecallFlow 扩展（扩展会主动连 `ws://127.0.0.1:7801`）。
2. 扩展未连接时，工具会返回明确错误；启动浏览器/扩展后重试即可。

## 手动验证

```bash
# 探活（免鉴权，会显示扩展是否已连接）
curl http://127.0.0.1:7801/health

# HTTP 模式的 MCP 握手
curl -s -X POST http://127.0.0.1:7801/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-RecallFlow-Token: recallflow-local-bridge-v1' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

## 测试

```bash
# 在本目录
npm test

# 或在仓库根目录跑全套（含集成测试，会临时启动 server 子进程）
node --test tests/*.test.mjs integrations/opencode/recallflow-mcp/test/*.test.mjs
```

# recallflow-mcp

RecallFlow 的证据 MCP server，让 **opencode** 能通过 RecallFlow 的**真实浏览器会话**读取网页，
并拿到**带时间戳 + 哈希、可复核**的证据快照。

## 架构

```
opencode ──(MCP over stdio)──► recallflow-mcp ──(本地 WebSocket :7801)──► RecallFlow 扩展
                                     │
                                     └──► 证据归档 ~/.recallflow-evidence/*.json
```

- **recallflow-mcp**（本目录）：MCP 服务端 + 证据归档 + 本地 WebSocket 服务端。
- **RecallFlow 扩展**：作为 WebSocket 客户端连上本机 7801，收到 `browser_read` 时用隔离窗口
  打开页面、读取渲染后正文、返回；读完自动关闭窗口。

## 工具

| 工具 | 说明 |
| --- | --- |
| `browser_read(url, waitFor?, maxChars?)` | 用真实浏览器会话读取页面，归档并返回 `{ url, title, fetchedAt, snapshotHash, text, quotes }` |
| `evidence_get(hash?, url?)` | 取回已归档快照，复核引用 |

## 安装

```bash
cd integrations/opencode/recallflow-mcp
npm install
```

## 配置到 opencode

在 `opencode.json` 里加：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "recallflow": {
      "type": "local",
      "command": ["node", "<绝对路径>/integrations/opencode/recallflow-mcp/index.js"],
      "enabled": true
    }
  }
}
```

再把配套技能放到 opencode 技能目录：

```
~/.config/opencode/skills/recallflow-evidence/SKILL.md
```

**重启 opencode**（配置只在启动时加载）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RECALLFLOW_MCP_PORT` | `7801` | 扩展连接的本地 WebSocket 端口 |
| `RECALLFLOW_EXT_TIMEOUT_MS` | `60000` | 等待扩展响应超时 |
| `RECALLFLOW_EVIDENCE_DIR` | `~/.recallflow-evidence` | 证据归档目录 |

## 前置条件

1. 浏览器已安装并启用 RecallFlow 扩展（扩展会主动连 `ws://127.0.0.1:7801`）。
2. 扩展未连接时，`browser_read` 会返回「扩展未连接」错误——启动浏览器/扩展后重试即可。

## 手动验证

```bash
# 终端 1：起 MCP server
node index.js
# 终端 2：用 MCP inspector 或任意 MCP 客户端调用 browser_read
```

或直接在 opencode 里让 agent 调用 `browser_read`。

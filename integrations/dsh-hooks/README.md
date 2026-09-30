# DSH → RecallFlow 面板：会话同步

把 DSH 会话里发生的事显示到**你正在浏览的页面上的 RecallFlow 面板**里。

## 能同步什么、不能同步什么

先说清楚界限，因为这决定了接入方式：

| 方向 | 内容 | 状态 |
|---|---|---|
| DSH → 面板 | **你提交的提示词**（`UserPromptSubmit`） | ✅ 本目录的 hook |
| DSH → 面板 | **每一个工具调用**（bash / 读写文件 / 其它 MCP server，`PreToolUse`/`PostToolUse`） | ✅ 本目录的 hook |
| DSH → 面板 | RecallFlow 自己的 MCP 工具调用 | ✅ MCP 服务端直接上报（但**不在** hook 里重复报，见下） |
| DSH → 面板 | **DSH 的成文回答** | ❌ **做不到**，见「已知缺口」 |
| 面板 → DSH | 面板里的对话 | ✅ 交接包 + `recallflow_session`（早已有） |

### 已知缺口：DSH 的成文回答

DSH 的 Claude 风格 hook 载荷里**没有助手文本**。实测其构造：

```js
transcript_path: ""                                  // 空串，没有可读的 transcript
UserPromptSubmit → { prompt }                        // 有
PreToolUse/PostToolUse → { tool_name, tool_input, tool_response }  // 有
Stop → { stop_hook_active }                          // 只有这个
```

要同步助手的话只有两条路：

1. **DSH 原生插件**（`@deepseek-ai/dsh-session` 的事件 / agent loop 钩子）—— 正解，但要写插件且需重启 DSH。
2. 去读 DSH 的 session 日志（`~/.dsh/sessions/**/session.v4.jsonl.zstd`）—— **不可接受**：
   压缩、带版本号（已迁移 v0→v4 四版）、无法增量 tail。

另外提醒：DSH 的官方说明里也写明了取向 ——「没有 Claude Code 对应物的行为应使用原生插件」。

## 接入方式

### 1) 写 hooks.json

放在项目里（例如 `.claude/hooks.json`），把命令路径换成你机器上的实际路径：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"D:/Desktop/workspace/code/ai/bookmark-sorter/integrations/dsh-hooks/recallflow-panel-hook.mjs\"" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "node \"D:/Desktop/workspace/code/ai/bookmark-sorter/integrations/dsh-hooks/recallflow-panel-hook.mjs\"" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node \"D:/Desktop/workspace/code/ai/bookmark-sorter/integrations/dsh-hooks/recallflow-panel-hook.mjs\"" }] }
    ]
  }
}
```

### 2) 在 DSH profile 里挂载钩子插件

在 profile patch（例如 `~/.dsh/profiles/web/cordis.patch.yml`）里加一条：

```yaml
- insert:
    - id: recallflow-dsh-hooks
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: 'D:/Desktop/workspace/code/ai/bookmark-sorter/.claude/hooks.json'
        projectDir: 'D:/Desktop/workspace/code/ai/bookmark-sorter'
```

### 3) 重启 DSH

**钩子配置只在进程启动时读取一次**（DSH 官方说明：*一份配置应用于整个进程：启动时只读取一次*）。
所以改完配置**必须重启 DSH 才会生效** —— 这意味着当前会话会结束。

### 4) 重载浏览器扩展 + 重启常驻 MCP server

面板侧的渲染代码是新的，不重载扩展看不到效果。

## 设计上的三条刻意取舍

1. **hook 永不阻塞 DSH**：任何失败都静默 `exit 0`。
   一个"显示同步"的副作用不该把用户的 agent 卡住或让它报错。
2. **跳过 `mcp__*` 工具**：RecallFlow 自己的 MCP 工具已由服务端以更细的粒度上报过
   （含参数摘要、耗时、成败），hook 再报一遍会让面板把同一次调用画两遍。
3. **不猜助手的话**：载荷里没有就不假装有 —— 宁可面板上少一段，也不显示错误的内容。

## 验证

不需要重启 DSH 就能验证链路（在隔离端口上）：

```powershell
$env:RECALLFLOW_MCP_PORT='7802'; $env:RECALLFLOW_EXT_TIMEOUT_MS='3000'
$env:RECALLFLOW_EVIDENCE_DIR="$env:TEMP\rf-evidence-hook"
node integrations/opencode/recallflow-mcp/index.js --http   # 后台
node scripts/verify-dsh-hook.mjs
```

实测结论：4 种载荷全部以退出码 0 结束；只产出 2 条事件（`mcp__*` 与 `Stop` 正确不产出）；
中文原样无损；`who=user` 正确；`source=external` 正确。

> 踩坑记录：用 PowerShell 的 `Invoke-RestMethod` 取回时中文会显示成乱码（UTF-8 字节被按 Latin-1 解码），
> 容易误判成数据损坏。**用 node 客户端取回即可确认数据本身是好的** —— 验证脚本因此改用 `fetch`。

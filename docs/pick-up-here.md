# 收口清单（一页）

> 目标：把 RecallFlow ↔ DSH 的集成从「桥接进程 + 两段对话同步」重构为
> 「单个 DSH 插件 + 一条会话」，并删掉中继。
>
> 状态：**代码侧已完成**（仓库 **492/492** 全绿，工作区干净、全部已推送）。
> 剩下的是**两件只有你能做的操作**，以及做完之后的验收。
>
> （这里刻意不写提交数：它每提交一次就变，写下来就是错的 ——
> 我在别处已经因为"先写数字后核实"错过两次。）
>
> **一条重要的未验证项**在下面单独列出 —— 我不会因为测试全绿就把它说成已完成。

## 你只需要做两件事

```powershell
# ① 重启 DSH（让插件新代码生效），然后重载扩展 + 刷新页面
#    —— 插件代码在 DSH 启动时载入；扩展代码在"重新加载扩展"时载入。没有热重载。

# ② 重启桥接（它不由 DSH 管理，必须在你自己的终端里跑）
#    先 Ctrl+C 停掉当前这个，然后：
node D:\Desktop\workspace\code\ai\bookmark-sorter\integrations\opencode\recallflow-mcp\index.js --http
```

> 为什么桥接必须由你启动：由 agent 会话起的常驻进程会被 Windows Job Object
> 随会话一起回收（本会话实测踩过两次）。

## 做完之后，我会按这个顺序验收

```powershell
# 1) 五项闸门（含"没删坏 opencode"的基线）
node scripts/verify-live-gate.mjs

# 2) 会话事件的真实形状（四种帧都应出现）
curl.exe -s http://127.0.0.1:3080/recallflow/status
#    看 recentEvents：user/message、assistant/message（带 text）、tool/call（带 tool 与 args）

# 3) 工具往返（插件 → WS → 扩展 → 页面 → 回执）
node scripts/probe-tool.mjs page_health 3080

# 4) 面板上是否同时看得到三样东西：你发的话、工具活动、助手的回复

# 5) 【本轮新增】结果加工是否只剩一份实现
#    读一次 read_console / get_element_source，确认返回里**有磁盘路径**
#    （这层加工过去只存在于桥接，插件返回原始 JSON —— 那正是删掉 MCP client 会静默丢的能力）
```

## 唯一还挂着的核心未验证项

**"助手的回复能否显示在面板上" —— 尚未实测确认。**

根因已找到并修复（DSH 的 `assistant/message` 把文本放在 `data.message.content`，
而插件读的是 `data.content`，见提交 `5a07de6`），但**插件要重启才生效**，
所以在那之前它仍然是"已修复、未验证"。

**我不会因为测试全绿就把它说成已完成。**

## 删除清单进度

| 步骤 | 状态 |
|---|---|
| 1 面板退役自己的 agent | ✅ `f2fa81e` |
| 2 客户端卡片插件（整包） | ✅ `53dec61` |
| 3 旧 DSH 插件——注入那条路（整包） | ✅ `695a342` |
| 4 桥接里的同步部分（panel-events / `/panel-turns` / `/event` / panel_* / dsh-hooks） | ✅ `c80fb0a`（**需重启桥接才生效**） |
| 5 profile 里的 MCP client | ⏳ **最后一项**，等验收 4) 通过后删 |
| 6 扩展里的旧事件通道 | ✅ `cd77cbe` |
| 7 文档与脚本收尾 | ✅ |

**第 5 步为什么放最后**：删掉它之后 DSH 就没有 `mcp__recallflow__*` 这些工具了
（页面能力已由插件的 `recallflow_browser` 接管）；
而验收 4) 需要读面板正文 —— 所以必须**先验收、后删除**。

### 第 5 步现在**没有隐性代价**了

最初盘这份清单时发现：源位置重写等加工**只在桥接里**，插件返回未加工的原始 JSON ——
也就是说删掉 MCP client 会让 DSH **静默失去「元素 → 源码文件」**（不报错，只是没有路径）。

后来逐个补齐，现在插件与桥接在下面这些上**是同一份实现**：

- 源位置重写（console / network 的调用栈 → 磁盘路径）
- 元素源码成形（`get_element_source` 的 file/line/component）
- 拾取元素的字段归一化（`get_picked_element`）
- `page_health` 的增量诊断、`verify_change` 的断言求值
- `browser_read` 的证据元数据（`fetchedAt` / `snapshotHash`）
- `dev_session_get/set` 与 `evidence_get`（插件**本地**读写同一份共享文件）

有一份契约测试钉住"不许再各自内联写一份"（`tests/bridge-contract.test.mjs`），
并且**验证过它会失败**（注入一行内联调用 → 断言报错）。

## 仍然保留、且不能删的东西

- **7801 桥接**：它是 **opencode 的页面能力出口**，不是"中继"。
  我曾在准备删除时才发现这一点，差点让 opencode 的工具静默失效（已回退）。
  `docs/deletion-plan.md` 的保留清单里有完整说明。
- 看板/交接（handoff）等面板自身功能：与本次重构无关。

## 如果你现在不方便做这两步

没问题 —— 代码是安全的（全部已提交并推送，工作区干净）。

但有件事要说清楚：**"助手回复能否显示"这件事已经卡在这里十几轮了**。
插件要重启才生效，而重启只能由你做。在那之前我这边能独立做完的
（共享化、去重、契约测试、文档）都已经做完了。

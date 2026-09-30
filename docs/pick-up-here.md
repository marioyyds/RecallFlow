# 收口清单（一页）

> 目标：把 RecallFlow ↔ DSH 的集成从「桥接进程 + 两段对话同步」重构为
> 「单个 DSH 插件 + 一条会话」，并删掉中继。
>
> 状态：**代码侧已完成**（94 个提交，仓库 474/474 全绿）。
> 剩下的是**两件只有你能做的操作**，以及做完之后的验收。

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

# 2) 会话事件的真实形状（本轮新增的诊断，四种帧都应出现）
curl.exe -s http://127.0.0.1:3080/recallflow/status
#    看 recentEvents：user/message、assistant/message（带 text）、tool/call（带 tool 与 args）

# 3) 工具往返（插件 → WS → 扩展 → 页面 → 回执）
node scripts/probe-tool.mjs page_health 3080

# 4) 面板上是否同时看得到三样东西：你发的话、工具活动、助手的回复
#    用浏览器工具读面板正文（这是我这边唯一验证不了 DOM 的手段之外的办法）
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
| 5 profile 里的 MCP client | ⏳ **最后一项**，等验收 3) 通过后删 |
| 6 扩展里的旧事件通道 | ✅ `cd77cbe` |
| 7 文档与脚本收尾 | ✅ 进行中→基本完成 |

**第 5 步为什么放最后**：删掉它之后 DSH 就没有 `mcp__recallflow__*` 这些工具了
（页面能力已由插件的 `recallflow_browser` 接管，那条路已实测可用）。
而验收 4) 需要浏览器工具读面板正文 —— 所以必须**先验收、后删除**。

## 仍然保留、且不能删的东西

- **7801 桥接**：它是 **opencode 的页面能力出口**，不是"中继"。
  我曾在准备删除时才发现这一点，差点让 opencode 的工具静默失效（已回退）。
  `docs/deletion-plan.md` 的保留清单里有完整说明。
- 看板/交接（handoff）等面板自身功能：与本次重构无关。

## 如果你现在不方便做这两步

没问题 —— 代码是安全的（全部已提交并推送，工作区干净）。
上面这份清单就是全部待办；我这边没有"再改改就好了"的余地了，
剩下的每一项都必须在这两件事做完之后才有意义。

# 收口清单（一页）—— 已完成

> 目标：把 RecallFlow ↔ DSH 的集成从「桥接进程 + 两段对话同步」重构为
> 「单个 DSH 插件 + 一条会话」，并删掉中继。
>
> **状态：七步全部执行完毕，端到端已在活实例上验证（2026-10-07）。**
> 仓库 494/494 全绿、已跟踪文件 0 改动、全部已推送。
>
> （这里刻意不写提交数：它每提交一次就变，写下来就是错的。）
>
> 注：`docs/` 下有约 29 个**未跟踪**的新文件（JEV / 豆包元宝 / 小说 / 每日新闻等），
> 那是你在别的会话里创建的，与本次重构无关，我没有碰过。

## 实测证据（活实例，不是"测试通过"的转述）

判据用**指纹**，不用"看 status 返回 200"那种答不出问题的检查：

```
磁盘上插件 sha256_12 = 072c863ac746
已载入 build.sha256_12 = 072c863ac746      ← 一致，且 status 里有 build 字段
node scripts/verify-live-gate.mjs          → ✓ 闸门 5/5 成立（退出码 0）
```

| 目标 | 证据 |
|---|---|
| ④ 面板打的字是真正的 user/message | `POST /recallflow/say → {"ok":true,…}`，那句自检文本随后以**真用户消息**出现在会话里 |
| ④ **DSH 的回复在面板上可见** | `get_picked_element` 取回的面板 DOM：`class="msg ext ext-dsh"`，label 为 `📣 DSH：**验证通过 —— 三个都过…**` |
| ④ 页面工具仍可用 | `page_health` 返回加工后的形状（`summary`/`counts`/`errors`/`warnings`/`failedRequests`），**且 `failedRequests[].location` 已是磁盘路径**；`verify_change` 读 dev-session 的 targets、断言求值正常；`dev_session_get` / `evidence_get` 本地读写共享文件正常 |
| 会话事件四种帧 | `recentEvents` 里 `assistant/message` **带 text**（`5a07de6` 修的根因，实测成立）、`tool/call` 带 `tool`+`args`、`tool/result` 带 `failed`、`user/message` 带 `role`+`sourceKind` |
| 注入类内容不进面板 | `classifyFrame` 9 个用例全部符合设计：goal 轮 / runtime-context / 文案前缀三种注入都不显示；真用户消息与助手回复显示；工具只画调用与失败 |

## 删除清单（七步全做完）

| 步骤 | 状态 |
|---|---|
| 1 面板退役自己的 agent | ✅ `f2fa81e` |
| 2 客户端卡片插件（整包） | ✅ `53dec61` |
| 3 旧 DSH 插件——注入那条路（整包） | ✅ `695a342` |
| 4 桥接里的同步部分（panel-events / `/panel-turns` / `/event` / panel_* / dsh-hooks） | ✅ `c80fb0a` |
| 5 profile 里的 MCP client | ✅ **已执行（2026-10-07）** |
| 6 扩展里的旧事件通道 | ✅ `cd77cbe` |
| 7 文档与脚本收尾 | ✅ |

**第 5 步怎么做的**：删掉 `~/.dsh/profiles/web/cordis.patch.yml` 里 `recallflow-mcp`
那个 insert 条目。动手前干跑、动手后用 **DSH 自己的 js-yaml** 各验一次：
4 个条目 → 3 个条目，`recallflow-one` 完好，其他条目未动。备份留在
`cordis.patch.yml.bak-20261007-225820`（回滚 = 复制回去 + 重启 DSH）。

### 唯一还挂着的一件事（不紧急，也不影响使用）

**配置文件只在 DSH 启动时读取** —— 所以**本次会话里 `mcp__recallflow__*` 这些工具仍然存在**，
要等**下一次重启 DSH** 才消失。在那之前两条路并存，而插件那条已实测可用，
所以这个空窗期是安全的。（这也正是当初把第 5 步放在最后的原因。）

## 为什么第 5 步必须放在最后（这条教训值钱）

删之前我先实测了插件那条路 —— 结果**当场撞到一个 bug**：

```
recallflow_browser({ method: 'page_health' })
→ Error: tool "recallflow_browser" returned invalid output: value is not lossless JSON
```

根因：加工层里的 `consoleError: r.consoleError || undefined` 是**显式 undefined 属性**，
被 `JSON.stringify` 丢掉后往返不等，DSH 因此**拒绝整次工具调用**。
而 MCP 那条路从不会有这个问题（它把结果序列化成 JSON 文本）—— 所以这是**插件独有的约束**。

**如果先删了 MCP client，`page_health` 就完全没有可用路径了。** 已修（`8e69e53`：
出口统一 `stripUndefined`），有契约测试，隔离实例 14/14。

## 现在怎么确认"跑的是新代码"

```powershell
$want = (Get-FileHash 'D:\Desktop\workspace\code\ai\bookmark-sorter\integrations\dsh-plugin-recallflow-one\index.js' -Algorithm SHA256).Hash.ToLower().Substring(0,12)
$got  = (curl.exe -s http://127.0.0.1:3080/recallflow/status | ConvertFrom-Json).build.sha256_12
"磁盘=$want  已载入=$got  " + $(if ($want -eq $got) { '✓ 一致' } else { '✗ 需要重启 DSH' })
```

三种结局的含义、以及各文件改动后该重启什么，见
[docs/two-way-sync.md](two-way-sync.md) 的"改完代码要重启什么"与"怎么确认跑的是新代码"。

## 仍然保留、且不能删的东西

- **7801 桥接**：它是 **opencode 的页面能力出口**，不是"中继"。
  我曾在准备删除时才发现这一点，差点让 opencode 的工具静默失效（已回退）。
  见 [docs/deletion-plan.md](deletion-plan.md) 的保留清单。
- 看板/交接（handoff）等面板自身功能：与本次重构无关。

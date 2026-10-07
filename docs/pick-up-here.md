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

---

## 之后的新目标：把面板的页面能力接进插件（进行中）

原来插件只暴露 10 个**被动读取**类方法。新目标是把 `lib/assistant/tools.js` 的 55 个工具
按**元数据里的 `risk`** 分档接进来（分档由数据决定，不是拍脑袋）：

| 档 | 数量 | 默认 | 开关（插件的 `config`） |
|---|---|---|---|
| 只读 | 19 | **开** | —— |
| 改页面 | 15 | 关 | `allowPageActions` |
| 浏览器与网络 | 4 | 关 | `allowBrowserActions` |
| 危险 | 10 | 关 | `allowDangerousActions` |
| **刻意不接** | 4 | —— | `update_plan` `expand_result` `complete_task` `load_skill` —— 它们是**面板那个 agent 自己的循环/UI 控制**，读的不是页面；DSH 这侧已有对应物，硬接会出现"两套计划状态互相打架"。导出为 `EXCLUDED_AGENT_LOOP_METHODS`，并有断言钉住它们不在任何清单里 |

**审批策略**：DSH 这侧没有面板那样的批准弹窗，所以"批准"= 用户在 profile 的插件 `config` 里
显式开开关。被拒时返回 `{refused, method, tier, reason}`，reason 写清**开哪个**、改完**要重启 DSH**。
清单唯一来源是 `lib/shared/bridge-methods.js`（`EXTENSION_METHODS = 58`），
契约测试核对"共享清单 ↔ 扩展 dispatch ↔ 插件方法表"三者对齐 —— 细节见
`docs/one-session-plugin.md` 与 `integrations/dsh-plugin-recallflow-one/README.md`。

新目标里还有两件事：

- **`browser_read` 的 `Receiving end does not exist`**：内容脚本按 `document_idle` 注入，
  而 `browser_read` 是 `open_tab` 之后立刻去读 —— 纯时序竞态；原来 `sendTabMessage` 只发一次，
  于是竞态变成稳定失败，而且错误文本被当成"页面正文"返回。已修：新增
  `lib/shared/tab-messaging.js`（可重试判断 + 循环，都有单测），`browser_read` 显式判 `ok`，
  失败时带 `diag`（复用了哪个标签页 / 窗口状态 / 标签页 status）。
- **把插件做成可被 DSH 插件管理器管理的包**：本目录已有 `package.json` 和自带的
  `cordis.patch.yml`。根因是 DSH 的 `listPlugins()` 要求加载条目来自 `include`，
  文件路径 insert 会被标成 `unaddressable`。**必须用 `pnpm add link:`** ——
  拷贝式安装会坏（插件有 3 个 import 指向包外的共享模块；两种方式都实测过）。
  切换要"备份 → 原子替换（同一次改动里删掉旧 insert，否则插件加载两次、路由冲突）→ 重启"，
  回滚就是恢复 `.bak`。

## 现在的状态与卡点

```
仓库 509/509 全绿   （上面那个 494 是旧数字；新增的是档位契约 + 内容脚本重试 + 面板三处修复）
已跟踪文件 0 改动   分支 feat/session-binding

闸门 2/5：
  ✗ 插件是新代码（已载入指纹 ≠ 磁盘 —— 改了插件但还没重启 DSH）
  ✓ 扩展已连上新通道 / ✓ 插件已认到会话
  ✗ 桥接存活 / ✗ 桥接有客户端（那是 opencode 那条链路的基线，与本次改动无关）
```

**卡在同一个地方**：需要 **重启 DSH**（插件是启动时载入的）+ **重载扩展并刷新页面**
（`relay.js` / `tools.js` 在扩展里）。这两步做完，能力档位与 `browser_read` 才能做**真机验证**；
在那之前不要说它们"验证通过" —— 这一轮的目标明确要求"用真实调用证明，不能只看代码"。

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

## 保留清单（2026-10-08 已改：其中的 7801 桥接删掉了）

- ~~**7801 桥接**：它是 **opencode 的页面能力出口**，不是"中继"。我曾在准备删除时才发现这一点，
  差点让 opencode 的工具静默失效（已回退）。~~
  → **已删除**（2026-10-08）：用户明确说不再用 opencode，那个消费者消失后，
  桥接整包（`integrations/opencode/`）与扩展侧那条通道一起删掉。
  **这段历史留着，是因为它的教训仍然有效**：删之前先确认消费者 ——
  而 opencode 那样的消费者**不在仓库里**（它是另一个进程），grep 查不到，
  只能靠问用户 / 看配置来确认。
- 看板/交接（handoff）等面板自身功能：与本次重构无关。

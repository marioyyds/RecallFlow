# 导航预算、快动作边界与“从宽校验”（2026-11-13）

这一轮来自三处真实反馈：HuggingFace 任务里慢模型连开 6 个标签页；收尾校验超时导致
`complete_task` 被调用两次；`type_text` 因编辑器归一化换行被反复判失败。

## 1. 抑制导航 churn

规则落在三层（缺一层模型都会绕过）：

- **系统提示**（`intent-router.ts` 浏览器意图）：列表/筛选优先在当前页改查询参数或
  用页面控件；同一站点最多 2 个标签页；输入后用 `press_key Enter` 提交，别再找搜索按钮。
- **工具描述**（`open_tab` / `switch_tab`）：重复强调“每站 ≤2 页、优先 fetch_webpage”，
  因为模型在选工具时读的是描述，不总回看系统提示。
- **技能**（`search-within-site` / `agent-browser`）：检索步骤改为“优先 Enter 提交”，
  并写明“排序/筛选开新页只会撞上限”。

## 2. 快动作集合：Enter 只做委托，不做自治

| 动作 | 快路可否自治 | 理由 |
|---|---|---|
| CLICK / SCROLL / WAIT / READ | 可以（契约 + 校验） | 目标在当前快照里可定位 |
| press_key Enter | **仅委托**（`nextAction.press_key`） | 依赖“当前焦点”，快照不暴露 activeElement；自治按 Enter 可能提交错表单 |
| TYPE_TEXT / SELECT / CHECKBOX | 不可以 | 需要值，值只能由慢模型产生 |
| open_tab / switch_tab | 不可以 | 跨页是战略决策，不是反射 |

若要支持自治 Enter，前置条件是快照带 `focus`（activeElement 的 ref/role/可编辑性），
再在 operation 空间里只对“已聚焦输入框”提供 `PRESS_ENTER`。这需要改快照协议，
未在本轮实施。

## 3. 校验从宽

- **收尾校验只提醒**：`verdict.ok === false` 不再返回 `reflect`，只发一条 advisory；
  校验器不可用也继续交付。判据改为“回答切题、与证据不矛盾”，不要求覆盖所有细节。
- **空转熔断**：同一站点连续 2 次“起了快路但没有执行任何动作”后，`runAvailable` 与
  协调器都直接返回 `handoff-streak`；只有慢模型真的做了会改变页面的动作才清零。
  2026-11-13 HF 轨迹里 4 次 `DONE 36–48% < 60%` 的纯空转因此被截断。
- **`type_text` 按内容判**：换行/空白被编辑器归一化时，只要非空白字符一致就算成功，
  并在回执里写明“仅换行被归一化”；不再用“预期 N 字符 / 实际 M 字符”诱发重写。
- 内容被截断、或出现不同文字时仍然失败——那不是归一化，是丢内容。
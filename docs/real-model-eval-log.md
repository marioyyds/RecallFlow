# 真模型 eval 运行记录（基线）

> 本文件是**运行记录**：每跑一次真模型 eval 就追加一行 + 一节。目的是让"通过率有没有退化"这句话
> 从此**可比** —— 在这之前，历次结果只散落在提交信息与 `docs/regression-red-flag.md` 的叙述里。

## 为什么需要它

- 脚本化 E2E（mock LLM）证明的是「工具按剧本做到没有」，**不能**证明「文案对真模型有没有用 / 有没有害」；
- 仓库纪律要求：任何改动**模型可见文本**的改动都要真模型测量；
- 但没有基线时，"本轮 30/30" 这句话既不能说好也不能说坏 —— 它无法与过去比较（这正是第一次记录时踩到的坑）。

## 怎么跑

```powershell
$env:E2E_LLM_REAL='1'
$env:E2E_LLM_REAL_KEY='<只走环境变量，绝不落盘>'
$env:E2E_LLM_REAL_BASE='https://api.deepseek.com'
$env:E2E_LLM_REAL_MODEL='deepseek-flash'
cmd /c npx playwright test -c tests/e2e-eval/playwright.config.mjs --grep "<场景标题>"
```

- `npx` 在 Windows 上必须用 `cmd /c` 包一层；
- ⚠ **真正在线的模型**由 `E2E_LLM_REAL_MODEL` 覆盖请求体里的 `model` 字段，
  而面板设置里写的是 `RECALLFLOW_EVAL_MODEL || 'deepseek-chat'` ⇒ 设置里显示的那个名字**不是**实际模型。
  记录口径一律按实际使用的模型（本页记 `deepseek-flash`）；
- 单条场景约 20–80 秒；一条命令给足超时，别中途中断。

## 运行记录

| 日期 | HEAD | 实际模型 | 范围 | 结果 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 2026-10 | `d153e5b` | `deepseek-flash` | 28 条剧本（新场景 3 次 + 其余 27 条各 1 次）| **30/30** | 唯一已知 flaky 是 `paywall-preview-limit`，本轮 1/1 |

### 明细（第三条起）

| 场景 | 请求数 | 模型实际加载的技能 |
| --- | --- | --- |
| `infinite-scroll-hover-preview`（3 次）| 21 / 26 / 16 | 新技能 3/3 |
| `site-search` | 7 | `search-within-site` |
| `checkout-form` | 12 | `checkout-form` |
| `readability-fix` | 11 | `readability-fix` |
| `debug-console-error` | 7 | `debug-console-error` |
| `dismiss-overlay` | 10 | `dismiss-overlay` |
| `recover-from-rejection` | 12 | （无）|
| `extract-merged-table` | 6 | `extract-merged-table` |
| `operate-in-cross-origin-iframe` | 8 | `operate-in-cross-origin-iframe` |
| `new-tab-takeover` | 5 | （无）|
| `paginate-async` | 8 | （无）|
| `pierce-shadow-dom` | 11 | `pierce-shadow-dom` |
| `cdp-drag-slider` | 9 | `cdp-drag-slider` |
| `canvas-coordinate-click` | 6 | `canvas-coordinate-click` |
| `macro-save-replay` | 10 | （无）|
| `upload-file` | 7 | （无）|
| `knowledge-save-retrieve` | 5 | `clip-to-knowledge`（**不是自己那条**）|
| `knowledge-search-fallback` | 12 | `clip-to-knowledge` + `knowledge-save-retrieve`（**不是自己那条**）|
| `cross-tab-handoff` | 7 | （无）|
| `virtual-list-scroll` | 9 | `virtual-list-scroll` |
| `cascade-select` | 10 | （无）|
| `read-select-options` | 7 | （无）|
| `csp-page-world-js` | 7 | `page-world-js` |
| `undo-last-action` | 6 | `undo-last-action` |
| `form-validation` | 26 | `checkout-form`（**不是自己那条**）|
| `paywall-preview-limit` | 9 | `paywall-boundary` |
| `download-verify` | 10 | `download-verify` |
| `date-picker-custom` | 14 | `date-picker-custom` |

耗时：P1 三次共 127.9s；P2 共 595.4s；**合计约 12 分钟**。LLM 请求合计 314 次。
（**token 数拿不到**，见下面「harness 盲点」。）

## 这一轮能得出的结论 —— 以及**不能**得出的

**能**：
1. 新技能**没有劫持任何场景**：27 条回归轨迹里 **0 条**加载了 `infinite-scroll-hover-preview`；
2. 27 条里**没有一条一次性失败**（所以能排除"某条彻底坏了"）；
3. 新场景本身 3/3，且轨迹里能看到技能纪律在起作用（run 2 先 hover 错行，靠"再 hover 一次 /
   优先读耐久记录"那两条纪律纠回来 —— 没有它们这一轮会答"页面上没有订单号"）。

**不能**：
1. P2 **每条只有 1 次采样** ⇒ 排除不了"通过率小幅退化"（例如 95% → 85%）；
   要谈趋势，每条至少 4 次（按本轮速度约 1 小时/轮）；
2. 26 条场景**在本轮之前没有基线数字**（只有 `paywall` 有历史：注入底座 3/7 ↔ 不注入 5/5）；
3. `paywall` 的 1/1 什么也证明不了（已知 flaky，单次通过可能是运气）—— 但**没有**为了"更可信"多跑，
   那是"跑绿为止"。

## 发现（都要归因，不许用"模型不行"结案）

### 1 `detectSkill()` 在生产代码里**没有调用方**（已用 `git grep` 核实）

- `lib/assistant/skills.js:21` 导出它，但**只有** `tests/silent-failure-regressions.test.mjs` 调它；
  生产给模型看的只有 `buildSkillCatalog()` 生成的一行 `name：description`（`intent-router.js:477`）。
- **好消息**：「关键词重叠 ⇒ 触发错技能」在当前架构里**根本不成立** ⇒ 上面"没劫持"的结论有**结构级**证据，
  不只是 27 条轨迹的观察。
- **坏消息**：那条门禁（"技能触发条件缺失"）**测的是一条永远不在生产里跑的路** ⇒
  它给人"触发条件被守住了"的错觉。`x.keywords` 仍被 `skill-md.js` / `skill-store.js` 用于
  SkillHub 格式的往返，但**不参与运行时匹配**。
- **待决**：删掉 `detectSkill` + 相应门禁（承认它已退役），或把它接回运行时
  （后者是**模型行为变化** ⇒ 必须先测量）。

### 2 "技能 ↔ 场景"在运行时比清单上松得多

3 条场景加载了**不是自己那条**技能；10 条**一个都没加载**（含 `paginate-async` / `cascade-select` /
`upload-file` / `macro-save-replay` / `new-tab-takeover` / `cross-tab-handoff` / `recover-from-rejection` /
`read-select-options`），**全部照样通过**。
⇒ 能力清单里的「有内置技能 28/28」是**资产层面**的对应，**不等于**"运行时模型会用它"。
这条对 ⑤ 技能归纳很重要：**技能写得多 ≠ 被用上**。

### 3 eval harness 的两个盲点（本轮**刻意没改**，为了 30 次运行跑在同一个已提交的 harness 上）

- **不打印 token / usage**：`proxyToRealModel` 只把上游 SSE 原样透传，不落 `usage` ⇒ 成本只能报"请求次数"；
- **不打印模型最后那条答复**，而且 `printToolResults` 在收尾走"完成校验器"时**必然是 0 条**
  （P1 三次都打印了"共 0 条"）。后果：将来失败时手上有完整**工具轨迹**，
  但"页面回执里到底写了什么 / 模型最后怎么答复"可能是空的。
  建议改成用已按 `tool_call_id` 去重的 `toolResultsText()`，并补打印最后一条无 `tool_calls` 的 assistant 消息。
- **`llmRequests` 记的是「请求体」**（不是事件流）⇒ 刚产生的工具结果要等**下一次请求**才会进记录：
  任何"读回执"的断言都必须 `expect.poll`，**同步读取会漏掉最后一条**。该数组另有 **40 条上限**
  （超出丢**最旧的**）⇒ 长会话里早期工具结果会消失（这也会削弱"第一次读到了什么"这类判据）。
  ⚠ `toolResultsText()` 与 `toolMessagesInOrder()` **不是两种口径**：后者只多做一层按 `tool_call_id`
  去重，是前者的**子集**（前者不去重）。本轮曾把"同步读漏了最后一条"误记成"两个口径不一致"，已改正 ✗。

### 4 三条场景的 eval 判据只有"半条"

`knowledge-save-retrieve` / `knowledge-search-fallback` / `download-verify` 的 `pageChecks` 是**空的**，
eval 这层只验"数据有没有交到模型手上"（权威判据在脚本化 E2E 层）⇒ 它们的 PASS 比别的条**弱**。

## 可选打磨（**未改**：改模型可见文本就要重新测量）

- 新技能第 8 步写的是 `inspect_element({ op: "text", selector: "#<预览节点>" })`，
  但没说"没有现成 selector 时怎么办" ⇒ P1 的 run 1 试了 `text:"订单号"` 这种写法
  （`text:` 是**定位**参数，不是按内容过滤），多花 2 次调用后自纠。
  建议补一句：先 `get_page_snapshot` 读一次，或直接读页面里那处耐久的「最近查看」记录。
- 第 2 步"点一次「加载更多」看它怎么说"三次都没被执行（模型直接进入滚动）。**倾向不改**：
  它挡的是"反复点无效按钮"这种真实坏行为，而脚本化 E2E 的参考路径正是"先点一次诱饵"
  （`golden.spec.mjs` 还断言 `decoyClicks > 0`）；改掉会让两层叙事不一致。

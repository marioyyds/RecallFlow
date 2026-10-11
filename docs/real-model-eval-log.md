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

---

# 第二轮：新场景 `multi-candidate-convergence`（HEAD `c72f232`）

> 上面全部内容是**上一轮（`d153e5b`）的基线，原样保留**。本节只追加本轮的运行记录、明细与结论。

## 运行记录（追加）

| 日期 | HEAD | 实际模型 | 范围 | 结果 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-11 | `c72f232` | `deepseek-flash` | 29 条剧本（新场景 4 次 + 其余 28 条各 1 次）| **29/33**（P1 0/4、P2 26/28）| P1 先单跑 1 次（失败）⇒ 补 `--repeat-each=3 --max-failures=0` 再跑 3 次；4 次全部同一处失败 |

### 与上一轮**命令口径的差异**（必须写在前面，否则数字不可比）

- 上一轮命令：`--grep "<场景标题>"`；
- 本轮**多加了两个命令行开关**（不改任何文件）：`--repeat-each=3`（一条命令内跑 3 次）与
  `--max-failures=0`（28 条里一旦有失败不要提前收工）。前者的原因写在下一条里；
- **P1 是 4 次而不是 3 次**：先按上一轮口径单跑了 1 次（失败），再补跑 `--repeat-each=3`。
  4 次是**独立的 4 个样本**，没有为了变绿重跑任何一次。

### 明细（本轮 33 次运行）

| 场景 | 次数 | 请求数 | 模型实际加载的技能 | 结果 |
| --- | --- | --- | --- | --- |
| `multi-candidate-convergence`（新场景）| 4 | 14 / 12 / 11 / 13 | 新技能 4/4（**每个 run 的第 1 个调用就是它**）| **0/4**（4 次同一处失败：工具结果里缺少 `¥309`）|
| `site-search` | 1 | 10 | `search-within-site` | ok |
| `checkout-form` | 1 | 8 | （无）| ok |
| `readability-fix` | 1 | 9 | `readability-fix` | ok |
| `debug-console-error` | 1 | 7 | `debug-console-error` | ok |
| `dismiss-overlay` | 1 | 7 | `dismiss-overlay` | ok |
| `recover-from-rejection` | 1 | 10 | （无）| ok |
| `extract-merged-table` | 1 | 3 | `extract-merged-table` | ok |
| `operate-in-cross-origin-iframe` | 1 | 19 | （无）| ok |
| `new-tab-takeover` | 1 | 5 | （无）| ok |
| `paginate-async` | 1 | 8 | （无）| ok |
| `pierce-shadow-dom` | 1 | 5 | （无）| ok |
| `cdp-drag-slider` | 1 | 9 | `cdp-drag-slider` | ok |
| `canvas-coordinate-click` | 1 | 5 | `canvas-coordinate-click` | ok |
| `macro-save-replay` | 1 | 10 | （无）| ok |
| `upload-file` | 1 | 9 | `upload-file`（基线记的是"无"）| ok |
| `knowledge-save-retrieve` | 1 | 5 | `clip-to-knowledge`（**不是自己那条**，与基线一致）| ok |
| `knowledge-search-fallback` | 1 | 14 | `clip-to-knowledge` + `knowledge-save-retrieve` + `knowledge-search-fallback` | ok |
| `cross-tab-handoff` | 1 | 7 | `cross-tab-handoff`（基线记"无"）| ok |
| `virtual-list-scroll` | 1 | 9 | `virtual-list-scroll` | **FAIL**（判据文字：工具结果里缺少 `scrollTop=3480`；3 条页面判据全过）|
| `cascade-select` | 1 | 11 | `cascade-select`（基线记"无"）| ok |
| `read-select-options` | 1 | 7 | （无）| ok |
| `csp-page-world-js` | 1 | 9 | `page-world-js`（基线记"无"）| ok |
| `undo-last-action` | 1 | 8 | `undo-last-action` | ok |
| `form-validation` | 1 | 13 | `checkout-form`（**不是自己那条**，与基线一致）| **FAIL**（判据文字：工具结果里缺少 `表单未通过校验`；4 条页面判据全过）|
| `paywall-preview-limit` | 1 | 9 | `paywall-boundary` | ok（**已知 flaky**，本轮只跑这 1 次）|
| `download-verify` | 1 | 9 | `download-verify` | ok |
| `date-picker-custom` | 1 | 14 | `date-picker-custom` | ok |
| `infinite-scroll-hover-preview` | 1 | 16 | `infinite-scroll-hover-preview` | ok |

- **请求合计 308 次**（P1 50 + P2 258），上一轮 314 次（-2%）；**token 数仍然拿不到**（见基线「harness 盲点」）。
- 耗时：P1 约 155s（36.3 + 45.4 + 32.5 + 40.5）；P2 由 harness 报**10.3 分钟**（`26 passed (10.3m)`）；
  合计约 13 分钟（基线约 12 分钟）。
- 上表"模型实际加载的技能"按 `load_skill({...})` 的字面参数、按**出现顺序**统计（不是"只数第一次"）；
  33 次运行里有 **32 次的完整轨迹**被逐步核对过（唯一缺的是 P1 run 1 的轨迹正文，
  它的请求数 14 / 技能 4/4 与判据块当时已打印，已记在上表）。

## 本轮结论：**能**得出什么、**不能**得出什么

**能**：

1. **新技能没有劫持任何别的场景**：28 条回归轨迹里 **0 条**出现 `multi-candidate-convergence`；
   它 4/4 只在**自己那条**场景里被加载。再加一层**结构级**证据：上一轮已核实
   `lib/assistant/skills.js:21` 的 `detectSkill()` 在生产代码里**没有调用方**，
   运行时不做关键词匹配、模型只看 `buildSkillCatalog()` 的一行 `name：description` ⇒
   "关键词重叠劫持"在当前架构里不成立（详见基线「发现 1」）。
2. **新技能的 `description` 足够准**：4 个 run 的**第 1 个工具调用**都是
   `load_skill({"name":"multi-candidate-convergence"})`（请求体里的指令含「比价」）。
3. 新场景的**7 步清单可执行**：4 个 run 都做到了"展开详情 → 读总价 → 等刷新 → 重读 → 逐条过滤
   → 选 → 提交 → 读回执"，且 4 次都**只被服务端接受了 P-105**（`rejected === 0`）。
   这 4 次失败**不是**能力失败（详见「发现 5」）。
4. **P2 没有出现"某条彻底坏了"**：28 条里 26 条一次通过，2 条失败都是 `mustSeeInToolResults`
   单条文字判据，**页面状态判据全过**（见「发现 6/7」）。
5. **假绿排查通过**：29 条 `--list --grep "<完整标题>"` **全部 `Total: 1 test in 1 file`**（29/29），
   所以本轮 33 次运行**没有一次是"0 测试 ⇒ 退出码 0"**。

**不能**：

1. P2 **每条仍然只有 1 次采样** ⇒ 排除不了"通过率小幅退化"（要谈趋势每条至少 4 次）；
2. `paywall-preview-limit` 的 1/1 什么也证明不了（已知 flaky：历史 3/7 ↔ 5/5）。
   **没有**为了"更可信"多跑它 —— 那是"跑绿为止"；
3. 本轮**没有**为 2 条失败补跑（虽然它们是判据脆、不是能力坏）：补跑就是挑样本。
   ⇒ `virtual-list-scroll` / `form-validation` 的"历史通过率"在本轮之后仍然是**1 个样本**；
4. 技能加载行为的"变化"（下面「发现 8」）**只能**说明"这一轮这个模型在这个采样下加载了它"，
   不能说明"上一轮记错了"或"行为稳定地变了"——两边都只有 1 次/条的采样；
5. P1 的 4 次全部卡在**同一处**判据上，**无法**告诉我们"别的判据会不会也脆"。

## 发现（都要归因；**推翻/修正**的条目显式标注）

### 5 【新】新场景的 `mustSeeInToolResults: ['¥309']` 在当前夹具时序下**可以永远不成立**（判据脆，不是能力坏）

**证据（4 个 run 一致）**：

- 4 次运行的判据块都通过了全部 **7 条页面状态判据**（含"P-105 被重读过 `reads>=2`"、
  "P-105 实时报价真的生效 `fresh===true`"、"服务端接受的正是 P-105"、"错误候选未被接受"、
  "页面渲染出服务端回执"），唯一红的是 **`✗ 工具结果里缺少：¥309`**；
- 每次请求都**完整记在 `llmRequests` 里**（run 1 只有 14 次请求、远低于 40 条上限 ⇒ **没有**被上限丢数据），
  也就是 `¥309` **确实一次都没进过模型手里**；
- 轨迹里 p105 是**重读过**的（4/4 都有第二次读 `#detail-p105` / `#total-p105`），
  而重读拿到的是 `¥283`（`mustSeeInToolResults` 里的 `¥283` **4/4 都满足了**）。

**归因（夹具/判据问题）**：`pickPage()` 的刷新定时器是在**展开详情的那一刻**就起的
（`tests/e2e/fixtures/server.mjs:1501` `scheduleRefresh(p.id)`，`REFRESH_MS = 1200`），
而 p105 的**第一次读只能是缓存值**这条前提，实际只对"展开后 1.2 秒内就读"的路径成立：

- run 1 展开 6 家之后直接 `run_javascript(3000ms sleep)` 再读（轨迹第 7 个调用），run 2/3 也是
  先展开完、再 `wait_for_element` 等刷新、再读 ⇒ 读到 p105 时**定时器早就到点了**，
  节点上写的已经是 `¥283`，`¥309` 从未出现在任何一次工具结果里；
- 而 skill 第 4 步**恰恰要求**"等刷新真的发生再读"⇒ 听话的做法与"必须看见缓存值"这条判据**互相冲突**。
- 脚本化 E2E 能过是因为它的参考路径是"展开 p105 → 立刻读"（`golden.spec.mjs:1859-1866`），
  1.2 秒的窗口对它够用。
- **一句话**：`¥309` 是**夹具在这个时序下没给**的值，不是模型没读到；把这条记成"新场景失败"会是**假红**。
- ⚠ 我**没有**改夹具去验证这个归因（本轮只允许改这一份记录，而且改夹具就是改测量）。

### 6 【新】`virtual-list-scroll` 的新失败：判据钉死了"滚多少"，而模型滚的是另一个合法的量

- 轨迹：`scroll_page({"selector":"#list","y":3400})`（模型要求把容器向下滚 **3400px**），
  随后重读 `#list` 并点开 `VL-87`；
- **3 条页面判据全过**（第 87 条真的进过窗口 / 点开的正是第 87 条 / 页面回执「已点开：87」）；
- 判据 `mustSeeInToolResults: ['scrollTop=3480']`（`playbooks.mjs:524`）来自
  `lib/page/commands.js:527-530` 的实测回执「已滚动容器（偏移 y=…）→ scrollTop=…」——
  它记的是"**滚了多少**"（内部容器是**偏移**滚动：`box.scrollTop = prevTop + offY`），
  而 `3480` 是夹具里"目标行位置"的换算值，不是"滚到目标"的唯一合法量。
  模型滚 3400 一样把目标带进了窗口（3 条页面判据就是证据）。
- **归因：判据脆（路径断言）**。⚠ 这里有一处**我没有直接观测到**：`printToolResults` 打印的是
  "共 0 条"，所以**我没有**回执里实测的 `scrollTop` 数值原文；能确证的是"模型传的是 3400"
  与"判据要求的是 3480"。上一轮它通过，最可能只是那次的模型**恰好**传了 3480 ——
  这也是"上一轮 27/27 里含运气成分"的一个具体例证；再跑一次可能就又过了（所以这**不算**回归）。

### 7 【新】`form-validation` 的新失败：判据要求"用 `inspect` 读表单"，而模型用了别的路

- 轨迹（21 次调用，`inspect_element` 只出现在第 10 个调用：`op:"text", selector:"script"`）：
  `get_page_snapshot → load_skill(checkout-form) → 填 3 个字段 → 点提交 →
  read_current_page → read_diagnostics(console) → inspect_element(op:"text", selector:"script") →
  click_at → get_page_snapshot → get_attribute ×3(pattern) → get_element_source(form) →
  改姓名 → get_attribute(required) ×2 → 再提交 → read_current_page`。
  它**从未**用 `inspect_element({op:"inspect"})` 读过表单 —— 而那正是"表单未通过校验"这句话的
  **唯一来源**（`lib/shared/utils.js:328` 的 `formatInvalidControls`，只由 `cmdInspectElement` 的
  `collectInvalidControls` 拼进 `result`）；
- **4 条页面判据全过**（最终提交成功 / 表单最终合法 / 姓名补到 minlength / 邮箱改成合法格式）
  ⇒ 任务**做到了**：它用 `get_element_source(form)` + `get_attribute(pattern/required)`
  自己推出了约束并改对。
- ⚠ 这与基线同一节里**已经自我修正过**的教训是同一类："报告出现过"仍不等于"与做法无关" ——
  因为那句话**只可能来自某一条取证路径**。
- **归因：判据钉死了取证路径**（不是能力退化）。

### 8 【新】技能加载行为与基线**有差异**（哪一侧都不宜当成"回归/改进"）

- **4 条上一轮记"（无）"、本轮加载了技能**：`upload-file` → `upload-file`、
  `cross-tab-handoff` → `cross-tab-handoff`、`cascade-select` → `cascade-select`、
  `csp-page-world-js` → `page-world-js`；
- **1 条上一轮记了技能、本轮没加载**：`checkout-form` →（无）；
- **上一轮的 3 条"加载了不是自己那条"与 10 条"一个都没加载"，本轮口径下是 2 条 / 8 条**
  （8 条 = `checkout-form` / `recover-from-rejection` / `operate-in-cross-origin-iframe` /
  `new-tab-takeover` / `paginate-async` / `pierce-shadow-dom` / `macro-save-replay` /
  `read-select-options`）
  （`knowledge-save-retrieve` → `clip-to-knowledge`、`form-validation` → `checkout-form` 仍在；
  `knowledge-search-fallback` 本轮除了 `clip-to-knowledge` + `knowledge-save-retrieve`，
  **还加载了自己那条**）；
- **归因：采样噪声**（每条 1 次）⇒ 这些差异**不能**读成"行为变了"。但它有一个真实含义：
  基线表里"加载了哪条技能"这一列**本身不是稳定量**，引用时要带"单次采样"的前提。

### 9 【修正基线说法】基线「发现 2」点名的"10 条一个都没加载"里，有 3 条在本轮加载了自己那条

基线原文把 `paginate-async` / `cascade-select` / `upload-file` / `macro-save-replay` /
`new-tab-takeover` / `cross-tab-handoff` / `recover-from-rejection` / `read-select-options`
（原文列了这 8 条）并在一起说"一个都没加载"。本轮 `cascade-select` / `upload-file` /
`cross-tab-handoff` **都加载了自己那条**（`csp-page-world-js` 也加载了 `page-world-js`，
只是它不在原文那一串里）。
⇒ 「发现 2」的**结论**（"技能写得再多也不保证被用上"）仍然成立且更稳，
但**具体名单不要当成固定事实**。**这是对基线表述的修正，不是推翻**。

### 10 【沿用并强化】harness 的"失败取证"比"通过取证"更弱

本轮 **33 次运行里有 28 次**（P1 4 次 + P2 24 次）`printToolResults` 打印的都是
「工具结果（共 **0** 条）」—— 只有 P1 run 2/3/4 与 `extract-merged-table` / `canvas-coordinate-click` /
`knowledge-save-retrieve` / `knowledge-search-fallback` / `undo-last-action` 这几条打印出了内容
（它们那次"最后一次请求"不是完成校验器）。原因是 `printToolResults` 取**最后一次请求**的 tool 消息，
而收尾走校验器时那一次必然没有 tool 消息。
于是**判定"为什么失败"时手上只有工具轨迹（调用序列），没有回执原文**。
基线「发现 3」已经提过这个盲点；本轮的实际后果是：`¥309` / `scrollTop=3480` / `表单未通过校验`
这三条我都只能靠"轨迹 + 夹具源码 + 判据来源"三点推断，**拿不到"回执里到底写了什么"的直接原文**。
（建议仍然是把 `printToolResults` 换成 `toolResultsText()`，并补打印最后一条无 `tool_calls` 的 assistant 消息。）

## 对技能文案的最小改动建议（**先别改**：改模型可见文本就要重新测量）

1. **【优先，改夹具而不是改文案】`mustSeeInToolResults: ['¥309']`**：
   现在它和 skill 第 4 步"等刷新再读"互相冲突。两个最小改法，任选其一：
   - (a) 把 `scheduleRefresh(p.id)` 从"展开时起"改成"**第一次被读到时**起"
     （`server.mjs:1501` → 挪到 `observeDetail` 的第一次调用里）：这样"第一次读必然是缓存值"
     这条前提对**任何**速度的读都成立（与脚本化 E2E 的断言也更一致，因为它本来就是这么假设的）；
   - (b) 判据改成"读到过 `¥309` **或**在缓存窗口内读过 `#total-p105`"，即把
     "必须看见缓存值"降级为"必须逐条核对过详情"（`¥283` 那条保留不动）。
   ⚠ 两个改法都要重跑 P1（(a) 还会触动脚本化 E2E 的判据注释）。
2. **`scrollTop=3480`**（`playbooks.mjs:524`）→ 改成与"滚了多少"无关的证据，例如
   「工具结果里出现 `已滚动容器`」，或与页面判据合并成"容器的 scrollTop **> 0** 且第 87 条进过窗口"。
3. **`表单未通过校验`**（`playbooks.mjs:685`）→ 若确实要保住"用 inspect 读"这条路径，就把它写成
   skill 第 3 步的**明确要求**（"用 `inspect_element({op:'inspect'})` 读表单"）；
   否则判据应放宽为"读到过 `tooShort` / `typeMismatch` / `patternMismatch` 中任意一个约束名"。
4. **新技能文案本身**：本轮 4/4 都按第 1～7 步走完了，**没有**发现"哪一步执行不了"。
   唯一可打磨的是第 3/4 步的**措辞张力**：它现在读起来像"你必须先读到过缓存值"，
   而实际要求只是"决定前重读"。建议把第 3 步改成
   "第一次读到的值可能已经是刷新后的（取决于你多快展开）——**判据是"决定前读了一次新的"**，
   不是"必须看见过旧值""。⚠ 这是我**没有验证过**的建议（改文案必须重测）。

## 未解决 / 不确定 / 我做不到的事

1. **P1 的 4 次全部失败**，所以本轮**无法**回答"新场景的通过率是多少"——只能说
   "在 4 个样本上，**页面判据** 4/4 通过、**`mustSeeInToolResults['¥309']`** 0/4 通过"；
2. `¥309` 的归因是**推断**（轨迹 + `server.mjs:1501` 的定时器起点 + `mustSee` 的来源），
   我**没有**用"改夹具再跑"去证伪它（那会改测量）；
3. 失败时**拿不到回执原文**（见「发现 10」），所以像"模型到底写了 `¥309` 没有"这种问题
   只能靠请求数（14 < 40）与判据红来排除，**没有**直接观测；
4. **token / 费用**拿不到 —— `proxyToRealModel` 不透传 `usage`，只能报请求次数（308 次）；
5. 本轮**没有**做多次采样（除了 P1），所以任何"通过率有没有退化"的说法都**不超过单样本强度**；
6. **没有**为了对齐上一轮的"每条 3 次"去重跑任何场景（时间与成本都翻倍，且与"不挑样本"冲突）。

## 假绿排查（`--list` 校验）的结论

- 方法：对 29 条剧本的**完整标题**逐个跑
  `playwright test -c tests/e2e-eval/playwright.config.mjs --list --grep "<完整标题>"`，
  逐条确认 `Total: 1 test in 1 file`；
- 结果：**29/29 全部 `Total=1`**；
- ⚠ 过程中踩到两次**排查工具自身**的假信号，记下来免得下次重踩：
  ① 用 PowerShell 的 `cmd /c npx … --grep '<标题>'` 时，标题里的**直引号**（如
  "没观察到变化" / "选最便宜的那个"）会被 cmd 拆坏参数，得到 `Total: 0 tests in 0 files`
  —— 那是**参数没传对**，不是"没选中用例"；② `npx` 的 `npm error arg Argument starts with
  non-ascii dash` 也是同一类（`——` 被当成选项）。**最终用 Node 直接调
  `node_modules/@playwright/test/cli.js` 并以数组传参**，29 条全部干净得到 `Total=1`。

---

# 第三轮：修掉两个「已被真模型证伪」的缺陷（HEAD `c72f232` + 工作区未提交改动）

> 上面两节**原样保留**。本节只记本轮的修复、复测与证据。

## 本轮改了什么（两处缺陷）

| # | 缺陷 | 改法 | 层级 |
| --- | --- | --- | --- |
| A | `/pick` 夹具把"重新询价"的定时器起在**展开时**，而真模型"展开"与"读"之间隔着 LLM 往返（数秒）⇒ 它第一次读到的**已经是实时价**，缓存价从未进过它的上下文。夹具横幅却写着"读后约 2 秒生效"——**实现与自己的文案不一致**（第二个缺陷）。 | 定时器挪到"该候选**第一次真的被读**之后"启动；且**只能在页面可观测到"被读"**时才能这么做（见下）。文案与常量对齐到 **2 秒**。 | 夹具 + 技能文案 + 剧本 |
| B | `virtual-list-scroll` 的 `mustSeeInToolResults: ['scrollTop=3480']` 是**路径断言**：真模型滚 3400，同样把目标带进窗口（3 条页面判据全过），却因为回执里没有那个具体数值被判红。 | 删掉数值断言，换成**页面状态证据**：新增 `window.__maxScrollTop`（容器 scrollTop 的最大值），判据是 `> 0`（证明滚的是**容器**）；工具层只要求回执里有「已滚动容器」。 | 夹具 + 剧本 + 脚本化 E2E |

## A 的关键实现约束：**"被读"在页面里原本是不可观测的**

这是本轮唯一一处**超出"只改夹具"**的改动，理由要写清楚：

- `inspect_element({op:"text"})` 走 `get_text`（`lib/page/commands.js:1021`），读的是
  `el.innerText || el.textContent` —— **不产生任何 DOM 变更**，`MutationObserver` 只能看见**写**。
  所以页面无从知道"agent 已经读到了缓存值"，"从第一次读起才重新询价"在今天的框架里**表达不出来**。
- 因此补了一个**通用**的页面可见信号：`cmdGetText` 在**算出文本之后**，在被读的每个元素上派发
  不冒泡的 `CustomEvent('recallflow:element-read')`（`notifyElementsRead`，见 `lib/page/commands.js`）。
  页面想参与就监听；不监听**零影响**（其它夹具一个监听器都没有）。
  ⚠ 顺带一个正是我们需要的顺序事实：**先取值、后派发** ⇒ 第一次读拿到的值在**读的那一刻**就定了。
- 真模型 eval 3/3 通过**同时**证明了这个跨世界信号在真实扩展里生效
  （脚本化 E2E 里那条 `page.evaluate` 派发不足以证明它 —— 那是同世界派发）。
- `content.js` 是 manifest 真正加载的**打包产物**（`lib/` 只被 esbuild 内联进它）⇒ 改完重新
  `node scripts/build-content.mjs`（产物 diff **+11 行**，只多了这一个函数与一次调用）。

## 运行记录（追加）

| 日期 | HEAD | 实际模型 | 范围 | 结果 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-12 | `c72f232`+工作区 | `deepseek-flash` | 新场景 `multi-candidate-convergence` 3 次 | **3/3** | 3 次全部：7 条页面判据全过 + `mustSeeInToolResults(['¥309','¥283'])` 全过（无一条"工具结果里缺少"） |

- 命令（**一条命令跑 3 次**，没有"失败就重跑到绿"）：
  `cmd /c npx playwright test -c tests/e2e-eval/playwright.config.mjs --grep 多候选收敛 --repeat-each=3 --max-failures=0`
- 耗时 2.0m / 1.9m / 1.4m（`3 passed (5.4m)`）；请求数 20 / 34 / 25（其中完成校验器 1 / 3 / 1）。
- 明细：3 个 run 的第 1 个工具调用**都是** `load_skill({"name":"multi-candidate-convergence"})`；
  3 个 run 都读到过 **¥309（缓存价）**与 **¥283（实时价）**；服务端只接受了 P-105（`rejected === 0`）。

## 本轮结论

**能**：

1. A 的两条"假红"根因都被**结构性**修掉了：第一次读必然是缓存价（探针实测：快读/慢读两次
   `第一次实际读到的值` 都是 `¥309`，改前慢读是 `¥283`）；B 的判据不再依赖"滚了多少"。
2. 真模型 **3/3** —— 上一轮的 `0/4` 不是能力问题，已修复。
3. 两个注入缺陷**都必红**（证据见下），所以新判据/新时序**有牙齿**，不是"放宽到能过"。
4. 脚本化 E2E 全量三阶段仍 **41 passed**（38 + 1 + 2，exit 0），单测 **1385 项 / 110 文件**全绿。

**不能 / 有代价**：

1. **成本上升**：上一轮 4 次是 11~14 次请求，本轮是 **20~34 次**（工具调用去重后 **53~65 次**，
   上一轮 11~14 条轨迹量级）。轨迹显示模型每个候选的 `#detail-*` 会读 **2~5 次**。
   归因：新文案明确要求"先读一次 → 等刷新 → **再读一次**"，模型把这套多做了一遍；
   这是**按文案执行**的自然结果，不是空转（每个 run 都收敛到 P-105 + 服务端回执）。
   ⚠ 这是本轮**唯一的实质妥协**：正确率 0/4 → 3/3，代价是请求数约翻倍。
2. `reads >= 2` 的口径仍含"页面重渲染"那一笔（刷新写节点时观察者记的一次），
   它**不是**"agent 读了两次"的精确计数；真正的"agent 读"计数在 `clientReads`
   （只由 `recallflow:element-read` 增加）。判据没有改用 `clientReads`，因为
   **不许在本轮放宽/改真模型判据**（`reads >= 2` + `fresh === true` 合起来仍然只在
   "读过 + 刷新真的发生"时才成立）。下一轮若允许动判据，建议换成
   `clientReads >= 2 && fresh === true`（更贴语义）。
3. 单次采样仍是**同一条场景 3 次**，不是全量回归：本轮没有重跑其余 28 条
   （它们与 A/B 的改动无关：A 只动 `/pick` 的 inline 脚本 + 那条技能文案；B 只动 `/vlist` 的 inline 脚本）。

## 注入缺陷必红（两条都贴了原始输出）

### A1：把刷新触发器改回"展开时起"

改法（临时）：把 `new MutationObserver(function () { observeDetail(p.id, false); })` 改成 `true`
（即"把展开时的页面重渲染当成 agent 读了"）。结果：

```
injection-A1 exit=1
    expect(received).toEqual(expected) // deep equality
    - Expected  - 1
    + Received  + 1
    -   "clientReads": 0,
    +   "clientReads": 1,
    > 1879 |   ).toEqual({ fresh: false, shown: '¥309', clientReads: 0 });
```

⇒ 机制用例（"展开只摆缓存价、还没有任何刷新被安排"）**必红**。

### A2：让第一次读也直接给实时价

改法（临时）：`paintRaw` 里的 `money(r.rawTotal)` → `money(r.total)`。结果：

```
injection-A2 exit=1
    Error: 展开详情时显示的不是缓存总价 / 或者已经安排了刷新
    expect(received).toEqual(expected) // deep equality
```

⇒ "第一次读必然是缓存价"这条**必红**。

### B：把"容器真的滚过"的证据记录去掉（滚动本身照旧）

改法（临时）：`if (list.scrollTop > window.__maxScrollTop) ...` → `if (false && ...)`。
结果：

```
injection-B playwright exit=1
    Error: expect(received).toBeGreaterThan(expected)
    Expected: > 0
    Received:   0
  1 failed
```

⇒ 新判据 `window.__maxScrollTop > 0` **必红**（而"第 87 条进过窗口 / 点开的正是第 87 条"仍然成立
—— 目标行判据**没有**被用来替它兜底）。

三条注入改动**都已还原**（`git diff` 里没有任何 `注入` 残留、`node --check` 通过）。

## 待决项（**本轮刻意不动**，只记录）

**`form-validation` 的判据钉死了取证路径**：判据要"工具结果里出现『表单未通过校验』"，
而那句话**只可能**来自 `inspect_element({op:'inspect'})`（`formatInvalidControls`）；
上一轮真模型 21 次调用里**从未**用它，改用 `get_element_source` + `get_attribute(pattern/required)`
自己推出约束并改对，4 条页面判据全过。
⇒ 该不该把判据放宽成"读到过 `tooShort` / `typeMismatch` / `patternMismatch` 中任意一个约束名"，
是**判断**（要保"必须用 inspect 读表单"这条路径，还是保"约束被核对过"这个结果），留给下一轮。

## 顺带撞到的**既有** flaky（不是本轮改动引入，记下来免得下一个人再查一遍）

本轮全量 E2E 三次：**38 + 1 + 2 全绿（exit 0）**两次；中间有一次 `infinite-scroll-hover-preview`
红在 `golden.spec.mjs:1763（工具结果里没有 SO-8842）`。

- 单独连跑两次：**1 红 1 绿**（37.8s 超时红 / 8.1s 绿）——红的总是"等到 30s 超时"那一次；
- **对照实验（决定性证据）**：用 `git worktree add --detach <临时目录> HEAD` 起了**未改动的 HEAD**
  （含它自己的 `content.js` 产物），同一条用例 `--repeat-each=3`：**2 红 1 绿**，
  失败行号 1756、错误文案与上面**逐字相同**（`Expected substring: "SO-8842"`）。
  ⇒ 这条 flake **与本轮改动无关**，是既有的。
- 夹具源码里本来就写着它的成因（`server.mjs` 的 `#peek` 注释）：CDP 注入的 hover 随时会被
  **本机真实鼠标**的 mousemove 重置，"读 popover 能不能成功取决于运气"。
- ⚠ 上面的对照 worktree 已 `git worktree remove --force` 删除；**主工作区未被改动**
  （`git worktree list` 只剩主工作区）。
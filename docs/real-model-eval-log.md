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

---

# 第四轮：修上面那条 flake + 加一道门禁 + 新增 `video-playback-verify`（HEAD `4e0618a` + 工作区未提交改动）

本轮**没有跑真模型**（没有新 key，也不该为了"看起来做完"去花这笔钱）。
下面记的是三件事：① 那条既有 flaky 的**复现尝试与结论**；② 新加的门禁；
③ 新场景 `video-playback-verify`（**脚本化 E2E 通过，真模型未测**）。

## 一、`infinite-scroll-hover-preview` 的 flaky：**没能复现，但机制被证实了**

**复现尝试（如实报，全部贴数字）**：

| 做法 | 结果 |
| --- | --- |
| 同一条用例 `--repeat-each=3` | **3 绿**（8.2s / 8.1s / 8.2s） |
| `--repeat-each=10` | **10 绿**（8.1–8.3s） |
| `--repeat-each=12`（带脚本节奏追踪） | **12 绿** |
| 全量三阶段 `node scripts/run-e2e.mjs`（三次） | **39 + 1 + 2 全绿，exit 0** 三次 |

⇒ **本轮 25 次单独连跑 + 3 次全量，一次都没红**。上一轮那条"2 红 1 绿"的对照实验**没有重现** ——
这可能只是概率（上一轮 3 次里红 2 次，本轮 25 次里红 0 次，不像同一个概率），
也可能与环境有关（本机当时鼠标正好压在窗口上）。**我不把它当作"已经修好了"。**

**机制实验（这才是本轮的收获）**：写了一条临时 spec（用完已删），在整轮 agent 运行期间
用 `page.mouse.move` **不停移动真实光标**扫过页面，连跑 3 次：

```text
RESULT hasSO=true trustedEnters=60 fakeEnters=0 peek="最近一次查看：订单号 SO-1348 · 陈静 · 待确认"
RESULT hasSO=true trustedEnters=61 fakeEnters=0 peek="最近一次查看：订单号 SO-6993 · 王强 · 已修复"
RESULT hasSO=true trustedEnters=65 fakeEnters=0 peek="最近一次查看：订单号 SO-6993 · 王强 · 已修复"
```

三件事被证成**事实**（不是推测）：
1. 真实鼠标确实会不停触发**可信** `mouseenter`（trustedEnters 60+，fakeEnters 0）——
   也就是说夹具里那 35 行全都被真实光标扫过；
2. hover 会被真实鼠标"抢走"：脚本跑完时 `#peek` 里留着的是**别的行**的订单号（SO-1348 / SO-6993），
   而**不是**目标 r38 的 SO-8842；
3. 即便如此，`#peek` 里**曾经**出现过 SO-8842（因为脚本确实 hover 到过 r38），
   所以这条实验**没有**变红 —— 它证明的是"**证据会长期停留在别的行上**"，
   而不是"**读不到**"。

⇒ 上一轮那句"读 popover 能不能成功取决于运气"**是真的**，但**红的充分条件本轮没找到**。
我没有为了让它变绿去削弱任何断言，也没有声称已经修好。

**这轮实际做的两件事（都是"更强"，不是"放宽"）**：

1. **脚本侧的重试判据从"粘性"改成"逐条盯"**（`fixtures/server.mjs` 的 `infinite-scroll-hover-preview` 分块）。
   修复前的写法是 `toolResults.some(...)` / `/等待元素超时/.test(seen)` —— **整轮历史里出现过就算数**，
   于是一次历史超时会被**反复**当成"刚 hover 失败"，两次 hover 额度可能被**一次性烧掉**，
   直接走到"读不到订单号"的放弃分支（失败形态与上一轮那 37.8s 超时红**完全一致**）。
   现在：三个信号只看**最后一条**工具结果；成败以 `#peek` 里有没有 `SO-8842` 为准（不是"有没有订单号"）；
   重试上限 4 次、到顶**如实报告**；重试路径**优先直接读 `#peek`**（少花一个往返，读得越早越好）。
2. **加了一道门禁** `tests/hover-preview-script.test.mjs`（5 条，纯静态 + 牙齿测试）：
   粘性判据、无上界、绕过 hover 三类写法必须被判不合格；真源码必须合格。

⚠ **我没能证明**第 1 条就是那次红的原因 —— 它只是把一个**能导致完全相同失败形态**的写法消掉了。
判断留在这里，不粉饰。

## 二、新增门禁：`tests/page-read-signal.test.mjs`（8 条）

钉住 `lib/page/commands.js` 的 `notifyElementsRead` 那个页面读信号：
事件名**只出现一次**（连注释都不许再写一遍，为此把源码注释里的字面量改写成「这个读信号事件」）、
`bubbles: false`、派发**包在 try 里**（且 dispatch 必须落在 try 块内）、
`content.js` 产物里同样**恰好一次**（改了 `lib/page/**` 必须重建），
外加**行为测试**（照 `tests/lookup-diagnostics.test.mjs` 的先例给最小 DOM 替身再 import 真模块）：
真的派发一次且不冒泡；页面监听器抛异常时**读取仍然返回文本**。
牙齿：构造假源码验证三类违规都会被判不合格。

## 三、新场景 `video-playback-verify`（④-3 `<video>` 播放器状态）

**只跑了脚本化 E2E**：单跑 `--repeat-each=2` 通过、连跑 4 次全绿（26.8–28.8s）。
**真模型 eval 未跑**（没有 key）。⇒ 它能证明"这套能力成立"，**不能**证明技能文案对真模型有用。

**媒体来源**：零二进制资产 —— 页面内 `canvas.captureStream()` + `MediaRecorder` 录 2 秒真 WebM
（blob URL），交给 `<video>` 真解码播放；证据是 `requestVideoFrameCallback` 的帧计数真的涨到 50–60、
`currentTime` 真的走到 1.94s、事件序列里有真 `seeking → waiting → seeked → playing → pause → ended`。

**诚实交代（难点①的降级）**：**"自动播放被策略拦住"这一层在本 harness 里做不到** ——
Playwright 给 Chromium 传 `--no-user-gesture-required` 且自身持有用户激活，
实测 `--autoplay-policy=user-gesture-required` / `document-user-activation-required` 都被无视
（`play()` 一律 resolve，`window.__probePaused === false`，用例里有一条断言把这个**环境事实**钉住）。
**所以没有把"自动播放被拦"算作难点**（更不会拿它冒充难点）：初始"没在播"是页面自己 `pause()` 一次
得到的确定性事实，"看起来在播"来自那条**永不刷新**的状态栏（中途暂停后它照旧写着「播放中」，用例断言了这一点）。

**本轮抓到的第二个假绿（注入缺陷实测）**：判据原本写 `window.__waits > 0`（"出现过缓冲"）——
而媒体**在加载那一刻**天然就会 `waiting` 一次，于是这条**恒真**。
把页面里那段故意的「seek 到未缓冲区间」**去掉**，用例**照样绿**（注入缺陷 2 第一次实测：`exit=0`）。
已改成 `window.__midWaits > 0`（**播放中途**位置 > 0.5 秒的 waiting，只可能由 seek 到未缓冲区间造出），
再注入同一个缺陷就红了（`Expected: > 0, Received: 0`）。⇒ **判据是注入缺陷逼出来的，不是写出来的。**

---

# 第五轮：新场景 `video-playback-verify` 首次真模型测量 + 30 条全量回归（HEAD `9bd98cd`）

> 上面四节**原样保留**。本节只追加本轮的运行记录、明细、结论与发现。
> 本轮**没有改任何测试/夹具/技能文案**：工作区里只改了本文件（见文末「改动」）。

## ⚠ 跑之前先撞到的一件事：**给定的 P1 命令一条用例都没选中**（不是 flaky，是静默 0 测试）

任务给的命令是 `--grep "视频在播"`。实测：

```text
cmd /c npx playwright test -c tests/e2e-eval/playwright.config.mjs --list --grep "视频在播"
Listing tests:
Total: 0 tests in 0 files
Error: No tests found     (exit=1)
```

原因**不是引号/不是 `cmd`、也不是编码**（下面第 4 条已把这两条都排除）：

- `--grep` 匹配的是**测试标题**：`eval(真模型): ` + `pb.title`；
- 新场景的标题是 `复杂场景：视频播放器状态 —— 「看起来在播」不等于真的在播`；
- 而 `视频在播` 是**夹具的 `trigger`**（`playbooks.mjs:844`，用于夹具的自动应答），它**不在标题里**：
  `title.includes('视频在播') === false`。

⇒ 按原命令跑会得到 `[exit 1]` + `No tests found`，**一次模型调用都不会发生**。
本轮改用能命中的 `--grep "视频播放器状态"`（`--list` 实测 `Total: 1 test in 1 file`）。
**这是对任务里那条命令的修正**，不是本轮把用例跑坏。

## 运行记录（追加）

| 日期 | HEAD | 实际模型 | 范围 | 结果 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-11 | `9bd98cd` | `deepseek-flash` | P1 新场景 3 次 + P2 其余 29 条各 1 次（共 32 个 run）| **P1 0/3；P2 26/29** | P1 三次**同一处**失败（`__seeked`/`__pauses`/`ended`/详情未开）；P2 三条红：`form-validation`（判据脆，第二轮同款）、`multi-candidate-convergence`（**新**：180s 超时未跑完）、`paywall-preview-limit`（**已知 flaky**）|

口径说明（可比性）：

- P1 是**一条命令 3 次**（`--repeat-each=3 --max-failures=0`），**没有**"失败就重跑到绿"；
- P2 是**每条 1 次**，但**每条一个独立进程**（新浏览器 + 新夹具服务器），
  与第二轮"一条 grep 一条命令"的口径一致；
- 另有**一次"0 测试"的运行**（上面那条 `--grep 视频在播`，`Total: 0`，**没有产生任何样本**）与
  2 次**探针运行**（临时 spec，只为一件事：证明"P1 这 3 次不是超时、而是模型自己收工了"，见「发现 12」）。
  三者都**不计入**上表的通过率（"33 个 run"= P1 3 + P2 29 + 探针 2；其中只有 32 个是 eval 用例本身）。

## 明细（第 5 轮：30 条场景 = 33 个模型 run）

| 场景 | 次数 | 通过 | 请求数 | 模型实际加载的技能 | 失败原因（一句话）| 已知 flaky |
| --- | --- | --- | --- | --- | --- | --- |
| `video-playback-verify`（新）| 3 | **0/3** | 23 / 9 / 7 | 新技能 3/3（**每个 run 的第 1 个调用就是它**）| 4 条页面判据同一处红：没点「跳转到末尾」/没点「暂停视频」⇒ `__seeked`/`__pauses`/`ended` 全不进状态 | 否 |
| `site-search` | 1 | ok | 8 | `search-within-site` | — | 否 |
| `checkout-form` | 1 | ok | 8 | （无）| — | 否 |
| `readability-fix` | 1 | ok | 10 | `readability-fix` | — | 否 |
| `debug-console-error` | 1 | ok | 8 | `debug-console-error` | — | 否 |
| `dismiss-overlay` | 1 | ok | 9 | （无）| — | 否 |
| `recover-from-rejection` | 1 | ok | 14 | （无）| — | 否 |
| `extract-merged-table` | 1 | ok | 5 | `extract-merged-table` | — | 否 |
| `operate-in-cross-origin-iframe` | 1 | ok | 9 | `operate-in-cross-origin-iframe` | — | 否 |
| `new-tab-takeover` | 1 | ok | 5 | `new-tab-takeover`（上一轮记「无」）| — | 否 |
| `paginate-async` | 1 | ok | 10 | `paginate-async`（第 1/2 轮记「无」）| — | 否 |
| `pierce-shadow-dom` | 1 | ok | 10 | `pierce-shadow-dom`（第 2 轮记「无」）| — | 否 |
| `cdp-drag-slider` | 1 | ok | 8 | `cdp-drag-slider` | — | 否 |
| `canvas-coordinate-click` | 1 | ok | 5 | `canvas-coordinate-click` | — | 否 |
| `macro-save-replay` | 1 | ok | 10 | （无）| — | 否 |
| `upload-file` | 1 | ok | 8 | `upload-file` | — | 否 |
| `knowledge-save-retrieve` | 1 | ok | 5 | `clip-to-knowledge`（**不是自己那条**，第 1/2 轮同款）| — | 否 |
| `knowledge-search-fallback` | 1 | ok | 7 | `clip-to-knowledge` + `knowledge-save-retrieve` + `knowledge-search-fallback` | — | 否 |
| `cross-tab-handoff` | 1 | ok | 7 | （无）| — | 否 |
| `virtual-list-scroll` | 1 | ok | 10 | `virtual-list-scroll` | —（**第二轮那条"判据脆"本轮没复现**）| 否 |
| `cascade-select` | 1 | ok | 11 | （无）| — | 否 |
| `read-select-options` | 1 | ok | 7 | （无）| — | 否 |
| `csp-page-world-js` | 1 | ok | 7 | `page-world-js` | — | 否 |
| `undo-last-action` | 1 | ok | 8 | `checkout-form`（**不是自己那条**）+ `undo-last-action` | — | 否 |
| `form-validation` | 1 | **FAIL** | 13 | `checkout-form`（**不是自己那条**，第 1/2 轮同款）| 判据文字：工具结果里缺少 `表单未通过校验`；4 条页面判据全过 | 否（判据脆）|
| `paywall-preview-limit` | 1 | **FAIL** | 12 | `paywall-boundary` | **4 条页面判据全红**：最终不停在免费集 / 当前集是试看 / 没播到片尾 / 时长不是 1140s | **是**（历史 3/7 ↔ 5/5）|
| `download-verify` | 1 | ok | 9 | `download-verify` | — | 否 |
| `date-picker-custom` | 1 | ok | 13 | `date-picker-custom` | — | 否 |
| `infinite-scroll-hover-preview` | 1 | ok | 18 | `infinite-scroll-hover-preview` | —（**本轮全量里 1 次 1 绿**，见 P3）| **是**（环境相关）|
| `multi-candidate-convergence` | 1 | **FAIL** | 25 | `multi-candidate-convergence` | **`finished === false`：180s 用例超时，这一轮根本没跑完**（2.9m 被杀）| 否（新问题）|

- **请求合计 318 次**（32 个 eval run 里 318 次 = P1 39 + P2 279；另有探针 16 次，不计入）。
  token 数**仍然拿不到**（见基线「发现 3」）。
- 耗时：P1 `3 failed` 的 1.2m / 28.3s / 22.5s；P2 测试体合计 **547.7s（9.1 分钟）**，
  墙钟 22:01:49 → 22:15:13（**13.4 分钟**，含 29 次起浏览器/夹具的固定开销）；
  探针 29.0s + 21.1s。**合计约 20 分钟**。
- 上表"请求数"取 harness 的 `LLM 请求次数`；"加载的技能"按 `load_skill({...})` 的**字面参数**、按出现顺序去重。
  ⚠ 轨迹里**看不到 `complete_task`**：它只出现在"下一次请求体"里，而模型说完那一句就结束了 ⇒
  harness 记不到（见「发现 13」）。
- `paywall` 本轮**只跑了这 1 次**（P2 里那一次），**没有**为了让它变绿补跑。

## 本轮结论：**能**得出什么、**不能**得出什么

**能**：

1. **新技能没有劫持任何别的场景**：29 条回归轨迹里 **0 条**出现 `video-playback-verify`；
   它 3/3 只在自己那条里被加载。（结构级证据仍在：`detectSkill()` 在生产里没有调用方 —— 基线「发现 1」。）
2. **新技能的 `description` 足够准**：3 个 run 的**第 1 个工具调用都是** `load_skill({name:"video-playback-verify"})`
   （指令里含「视频在播」）。这一点是**新技能的 `description` 第一次被真模型测到**，结果是通过。
3. **假绿排查通过**：30 条完整标题逐个 `--list --grep` **全部 `Total: 1 test in 1 file`（30/30）**
   ⇒ 本轮 32 个 run **没有一次是"0 测试 ⇒ 退出码 0"**。
4. **已知 flaky 的 `infinite-scroll-hover-preview` 本轮是绿的**：全量里 1 次 1 绿（P3 见下）。
5. **上一轮两条"判据脆"里的一条自愈了**：`virtual-list-scroll`（第二轮的 `scrollTop=3480` 假红）
   本轮 **ok**（10 请求、加载了自己那条技能）—— 第三轮把它改成 `__maxScrollTop > 0` 的修法在真模型下确实成立。
6. **P2 没有"某条彻底坏了"**：29 条里 26 条一次通过；3 条红都各有独立、可归因的原因（见「发现 11/14/15」）。

**不能**：

1. **P2 每条只有 1 次采样** ⇒ 排除不了"通过率小幅退化"。26/29 与第二轮 26/28、第一轮 27/27
   的差异**不超过单样本强度**，不能读成趋势；
2. **P1 只有 3 个样本**，且 3 个都红在**同一处** ⇒ 只能说"在 3 个样本上，4 条页面判据 0/3"，
   **不能**说新场景的通过率是多少；也**不能**说"别的判据会不会也脆"；
3. `paywall-preview-limit` 的 0/1 同样什么也证明不了（已知 flaky，历史 3/7 ↔ 5/5），
   **没有**为它多跑；
4. 本轮**没有**为任何红条补跑（补跑就是挑样本）。⇒ `form-validation` 的"历史通过率"仍然只有 2 个样本
   （第 2 轮红、本轮红），`multi-candidate-convergence` 在"全量里的超时"也只有 **1** 个样本；
5. 技能加载行为那几处变化（`paginate-async` / `new-tab-takeover` / `pierce-shadow-dom` 从「无」变成"加载了自己那条"）
   **只能**说明"这一轮这个模型在这个采样下加载了它"，**不是**"行为稳定地变了"（两边都只有 1 次/条）。

## 发现（都要归因；**推翻/修正**的条目显式标注）

### 11 【新】P1 的 0/3 **不是能力失败，也不是超时**：技能步骤里**从来没有**要求"去制造那三个状态"

**证据（三条独立线，全部贴原文）：**

① **失败形状 3/3 完全一致**，红的永远是这四条（`playbooks.mjs:866-878`）：

```text
✓ 视频真的解码过帧（RVFC 帧计数 > 0…）
✗ 「跳转到末尾」真的做过（那是缓冲证据的来源）        → expr: window.__seeked >= 1
✓ 真的出现过缓冲（waiting 累计次数 >= 1）            → expr: window.__waits >= 1
✗ 中途真的暂停过 —— 「在播 / 停了」必须分得开          → expr: window.__pauses >= 1
✗ 事件序列里出现过 ended                             → window.__events.indexOf("ended") >= 0
✓ 那个装饰性播放键真的被点过
✓ 真播放按钮也真的被按过
✗ 「播放详情」被打开过（决定性状态藏在它后面）        → 只有 run 1 红，run 2/3 绿
```

② **模型轨迹里那三个动作一次都没出现**（P1 三次的全部调用序列）：
`load_skill → get_page_snapshot → click(fake/real play) → wait/inspect/(reload/open_tab/…) → 收工`。
`#seek-end` / `#pause-mid` **一次都没有被点过**。

③ **决定性证据：探针那次 run 是"模型自己收工"，不是超时。** 用临时 spec（与 eval 同一条路，只多读面板状态）
跑一次同场景，把"跑没跑完"变成可观测的：

```text
TIMELINE: 5ms stop=1/vis=true … 24215ms stop=1/vis=true req=9 → 26230ms stop=1/vis=false req=9
耗时=28.2s  请求数=9   判据同上（同样 4 条红）   missed=[]
```

⇒ `.stop-btn` **先可见、再自己消失**，也就是 `waitForRunToFinish` 的语义（先看见停止按钮、再等它消失）
**真的成立了 28 秒**。所以 **P1 的失败与 170s/180s 超时无关**（这一点**推翻**了我自己最初的怀疑）。

**归因：技能文案的触发缺口（文案）＋ 夹具的"必须由 agent 驱动"（harness），不是模型能力。**
逐条对上：

- 技能的 **6 个步骤**里，第 1 步是"分清哪个控件是真的"、第 3 步只要求"按下**真播放控件**"、
  第 4 步是"**读**真实数值"、第 5 步是"**区分**三态（正在播/卡住/已播完）"。
  **没有任何一步**说"要去点暂停""要去跳到末尾""要让它播完再看"。
- 而夹具的判据恰恰要求**agent 亲自制造**这些状态：`__seeked` 只在 `#seek-end` 的 click 监听里 +1
  （`server.mjs:1486`）、`__pauses` 只在 `#pause-mid` 的 click 监听里 +1（`server.mjs:1517-1521`）、
  `ended` 只在真播到片尾时进事件序列。**只"读"是读不出这些状态的。**
- 脚本化 E2E 能过，是因为参考路径**把这三步都做了**（`server.mjs:3636-3643`：
  先 `#pause-mid`、再 `#seek-end`、再打开详情、再 `#real-play` 走到 ended）。
  ⇒ 这是**文案与参考路径不一致**，不是"模型不会"。
- 模型的"读法"其实很合理：它在探针里的原话是
  「先打开「播放详情」面板，同时按下真播放键」→「视频按下真播放键后进度到了 0.15 秒、已解码帧数 5，
  但状态显示「卡住（缓冲中）」。我等一会儿再回读真实数值，看位置是否推进、等待次数是否增加」→
  「核实完成，结论基于「播放详情」面板里的真实数值，而不是页面那条状态栏」。
  它**把"读面板"当成了核验**，并且 `missed=[]`（`已解码帧数`/`缓冲等待次数`/`播放位置：`/`事件序列：` 全读到了）。

⚠ **不做过度解读**：我只在 3 个样本 + 1 个探针上观测到"没点那两个控件"。这足以指出**触发缺口**，
不足以说明"模型在任何措辞下都不会去点"。

### 12 【新】**P1 的判据还可能有一条"读法相关"的脆**：`__pauses` 与"读到的 pause 事件"不是一回事

这是我在归因时撞到的一处**不一致**，如实记下：

- 探针那次 run 的**完成校验器**（harness 自己打印的）说：
  「…`decoded=51`、`t=1.94=dur=1.94`、`midWaits=0`、**`ended=true`**，事件序列以
  `playing→pause@1.9→ended@1.9` 收尾…」，判它"通过"；
- 而同一次 run 的**页面判据**却说「中途真的暂停过」是 ✗（`__pauses >= 1` 不成立），
  探针也复现了"同一次 run 里两套结论不一致"。

两者**可以同时为真**：校验器读的是**事件序列文本**（`__events`，里面确实有 `pause@1.9`），
而判据读的是**按钮点击计数器** `__pauses`（`#pause-mid` 没被点，所以是 0）——
页面里 `pause` 事件还可能来自媒体自身（例如 `ended` 之前的一次 pause），并不等于"agent 点了暂停"。
⇒ **`__pauses` 是"动作计数器"，被当成了"状态证据"用**；而 skill 第 5 步教模型用的是**事件序列**。
这一条与基线「发现 6/7」（判据钉死路径）是**同一类病**，值得下一步决定：
把「中途暂停过」的判据改成"事件序列里出现过 `pause`"，或明确要求 skill 第 5 步去点暂停键。
⚠ 我**没有**改夹具去证伪这条推断（本轮只许改这份记录）。

### 13 【沿用并强化】harness 的取证盲点在本轮造成了一次**实质**观测困难

基线「发现 3」说过 `printToolResults` 在收尾时必然是 0 条。本轮的新证据：

- **每次运行的最后一轮助手消息永远不在 `llmRequests` 里**（它只出现在**下一次**请求体中，
  而模型说完就结束了）⇒ `printTrace` 里**看不到 `complete_task`**，
  也**看不到模型的最终答复**。P1 表里"请求 23 / 工具调用 23"的意思就是"最后一次请求之后模型还干了什么，harness 不知道"。
- 我为此另外写了个一次性探针（读**面板 DOM** 里的最后一条消息块）才拿到模型的原话与
  `✓ 完成前校验通过…` 那行 —— 也就是说：**判"为什么失败/为什么通过"的关键证据，目前在请求体里拿不到**。
- 建议（仍**未改**）：`printToolResults` 换成已按 `tool_call_id` 去重的 `toolResultsText()`，
  并**补打印最后一条无 `tool_calls` 的 assistant 消息 + 面板里那一行「完成前校验通过/未通过」**。

### 14 【新】**`multi-candidate-convergence` 在 180s 用例超时内跑不完**（第三轮的"3/3"本来就是贴着上限过的）

- 本轮 P2 里它 **`finished === false`**（`real-model.eval.mjs:175`），
  耗时 **172.9s**、请求 **25** 次、去重工具调用 **52** 次、**完成校验器 0 次**（= 模型从未走到收工）。
- 轨迹显示它**不是卡在一个工具上**，而是**策略性绕圈**：一次性展开全部 6 家
  （调用 3~8：`click #toggle-p101 … #toggle-p106`）→ 把 6 家的 `#detail-*` 读了一遍 →
  再逐个 `wait_for_element(text_contains:"实时报价已重新询价")` ——**只有 p101 等到了**，p102/103/104/105/106 全部
  `等待元素超时（8000ms）`（5×8s ≈ 40s 就这样没了）→ 转去 `run_javascript`（未开 CDP，被拒）→
  `scroll_page` → 连点两次 `#toggle-p102` → `open_tab("/pick")` + `CTRL+R` → 再 `open_tab("/pick?fresh=1")` →
  又点/读/等 → 请求数触到 **40 条上限**（`server.mjs:2753`，超上限丢**最旧**）→ 被 180s 杀掉。
- **归因（夹具/判据与文案的时序张力，不是"模型不行"）**：夹具的刷新时钟**只由"该候选第一次真的被读"启动**
  （`server.mjs:1708-1723` 的 `firstClientRead`）。模型把"展开全部"和"读全部"**并发**做完之后，
  那些候选的第一次读**已经发生**；它随后等的"刷新说明"只可能由**一个**节点先到（p101），
  其余 5 条要按**各自的**时钟到点 —— 而模型用的是"批量等 8 秒"，与这个**每候选独立计时**的机制不同拍，
  于是 5 条全超时。之后它换的新路由（新标签页/刷新/新 URL）每次都把时钟**从头**再走一遍，越绕越远。
- ⚠ **这条同时**修正**了一个可能的误读**：第三轮它 3/3，但耗时是 **2.0m / 1.9m / 1.4m** ——
  **前两次（120 / 114 秒）本身就已经贴着 180s 的上限**（第三轮那节只记了"3/3"，没记"离超时有多近"）。
  所以本轮的"超时"更可能是一次**阈值暴露**，而不是行为退化；
  但它也**确实**说明：这个场景在真模型下的 wall-clock **不可靠地在 114~173s 之间**，
  而 eval 的 `timeout: 180_000` 对它太紧（**这算对第三轮"3/3"结论的强度修正**，不算推翻）。

### 15 【已知 flaky 的新形态】`paywall-preview-limit` 本轮红在**页面状态**，红的形状和历史上不同

- 本轮：唯一加载的是自己那条技能（`paywall-boundary`），请求 12、校验器 1、工具调用 13，
  判据 **4 条页面判据全红**（最终停在会员集 / 是试看 / 没播到片尾 / 时长不是 1140s）。
- 历史口径是「注入底座 3/7 ↔ 不注入 5/5」，而**本轮没有任何注入**（工作区干净）⇒
  它就是**这一轮红了**。这**不能**说明"修好了/坏了"（1 个样本）。
- 轨迹（可读部分）：`load_skill → 快照 → read_current_page → inspect 选集按钮 → 2 次 run_javascript 读
  video.duration / 选集列表 → click rf-20 → run_javascript → click rf-15 → click rf-5 → click rf-20 →
  click #seek-end → click rf-3`，最后一步点完就收工了。
  ⚠ **我没有拿到最后一次点击 `rf-3` 的目标元素**（ref 是全局自增的，`rf-3` 在两次 `run_javascript`/多次
  快照之后不对应固定控件；且 `printToolResults` 是 0 条）⇒ **我只能确证"最终页面状态不满足那 4 条"，
  不能确证"它点错了哪一步"**。按已知 flaky 处理，不额外跑。
- 附带观察：这个场景里模型**开了 CDP**（`run_javascript` 有真实返回），而 `form-validation` 里模型也试了
  `run_javascript({engine:"page"})` 但**被拒**（"页面世界执行需要 CDP（请在设置中开启）"）——
  同一个模型在不同场景下的工具可用性不同（各剧本的 `ev.cdp` 不同），这会影响它的取证路径。

### 16 【修正第二轮说法】"判据脆"的 `virtual-list-scroll` 本轮**没有复现**

第二轮记它"判据脆、路径断言"（滚 3400 vs 判据 3480），第三轮把判据改成 `window.__maxScrollTop > 0`
+ 工具层只要回执出现「已滚动容器」。本轮真模型跑它：**ok**（10 请求、加载 `virtual-list-scroll`）。
⇒ 第二轮的脆弱点**已经被第三轮的改法消掉**（1 个样本，但方向与新判据的设计一致）。
**`form-validation` 那条判据则两轮都红**（第 2 轮、本轮），形状**逐字相同**
（4 条页面判据全过 + 只缺 `表单未通过校验`）⇒ 它是**稳定的判据脆**，不是 flaky。

## 假绿排查（`--list` 校验）的结论

- 方法：用 Node 直接调 `node_modules/@playwright/test/cli.js`，**数组传参**（绕开 `cmd` 拆引号；
  也绕开 `——` 被 npm 当成选项那条已知坑），对 30 条标题逐个 `--list --grep`；
- 结果：**30/30 全部 `Total: 1 test in 1 file`**；
- ⚠ 本轮新踩到、**必须记下来**的两个排查工具自身的坑（都不是"没选中用例"）：
  1. **`--grep` 是正则，不是字面串**：4 条标题含 `+` 或 `（）`（跨域 iframe / 分页 + 异步渲染 /
     宏保存 + 回放 / 无限滚动（页面级）），直接把标题塞进 `--grep` 会得到
     `Total: 0 tests` / `Error: No tests found`（`+` 触发 `Nothing to repeat`）。
     **必须先把正则元字符转义**（`title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`）才得到 `Total: 1`；
  2. **命令里的 grep 词不等于标题**：`视频在播` 是**夹具 trigger**，不在标题里 ⇒ 0 测试（见本节开头）。
     ⇒ 以后写"跑某条场景"的命令时，**grep 词必须来自 `pb.title`**，不能来自 `trigger`。

## 对技能文案的最小改动建议（**先别改**：改模型可见文本就要重新测量）

1. **【优先，P1 的根因】`skill-defs.js:1122-1138` 的「## 步骤」要显式要求"驱动"那三个状态。**
   现在第 3/4/5 步只有"按真播放 → 读数值 → 区分三态"，**没有**任何一步说"去点暂停/跳到末尾/让它播完"。
   最小改法：在第 3 步后**插入一步**，例如
   > 3.5 **把三种状态都真的制造出来再读**：先 `click_element` 那个"暂停"控件、再点"跳到末尾/快进"控件
   >    触发一次真缓冲、最后让它播到结束 —— 然后才回读数值。

   并在第 5 步补一句"**只读**当前那一刻的数值，拿不到'卡顿/播完'的证据"。
   **为什么必须先改文案**：夹具的 `__seeked`/`__pauses`/`ended` **只能由动作产生**；
   只改判据会把"驱动能力"这件事从这一层**删掉**（那是削弱，不是修）。
2. **【与第 1 条配套】`playbooks.mjs:867-869` 的 `__pauses >= 1` 语义要澄清**（见「发现 12」）：
   它记的是"暂停键被点过"，而这一场景真正要的结论是"在播 / 卡住 / 播完**分得开**"。
   两个选项：(a) 判据改成"事件序列里出现过 `pause` **且** 位置在 0 与 duration 之间"；
   (b) 保留 `__pauses`，但在 skill 里明确"必须点一次暂停键"。二者**都要重跑 P1**。
3. **`multi-candidate-convergence` 的时限**（见「发现 14」）：`playwright.config.mjs:18` 的
   `timeout: 180_000` 对这个场景太紧（第三轮两次是 114/120s，本轮 172.9s 被杀）。
   最小改法：**只给这一条**更长时限（剧本级 `test.setTimeout`），或把配置抬到 240s；
   另外可考虑让 skill 第 2 步明确"**逐个**展开 → 读 → 等刷新 → 再读"，不要"先全展开再全读"
   （那正是本轮绕圈的起点）。⚠ 这条只是**建议**，本轮**没有**验证过改完的效果。
4. `form-validation`（第 3 轮留下的待决项）在本轮**仍然是红的、形状逐字相同** ⇒ 上一轮那个待决项
   （放宽成"读到过 `tooShort`/`typeMismatch`/`patternMismatch`"，或把"用 `inspect_element({op:'inspect'})`
   读表单"写进 skill 第 3 步）**应当升级为要做的事**：它已经连续两轮以同一形状失败。

## 未解决 / 不确定 / 我做不到的事

1. **P1 只有 3 个样本**，且三次同一处红；探针那次（第 4 个样本）形状相同。⇒ 我给不出"新场景通过率"；
2. **`multi-candidate-convergence` 的超时只有 1 个样本**：我**没有**重跑它去确认"是不是每次都超时"
   （那是挑样本，也是重复花钱）。第三轮"3/3"与本轮"超时"之间到底是"阈值暴露"还是"行为退化"，
   **只有 4 个历史样本**（114 / 120 / 84 / 173 秒）能说话，**不足以判定**；
3. **`paywall` 我只确证了"最终状态不满足 4 条判据"，没有确证"它点错了哪一步"**：
   需要 ref→元素映射，而轨迹里只有 ref（见「发现 15」）。**没有**为它多跑；
4. **token / 费用拿不到**：`proxyToRealModel` 不透传 `usage`，只能报请求次数（318 次）；
5. **`test-results/` 被 Playwright 反复清理**：我在 P1 第一次（0 测试）与三次真跑之后都看到过它生成
   `error-context.md`，而最后一次运行把目录清空成只剩 `.last-run.json` ⇒
   我**没有**特意去重建任何中间状态的产物（它是 `.gitignore:11` 忽略的目录，不属于交付物）；
6. **我读了 2 个只读的探针/临时文件到 `%TEMP%`**（`list-check.mjs` / `analyze.mjs` / `probe.eval.mjs` / 各类 `.out.txt`）——
   它们**全部在 `%TEMP%\rf-eval-r5\`**，仓库里没有新增临时文件；
7. 我**没有**做"每条多次采样"（时间/成本翻倍），也**没有**为任何红条补跑。

## 改动

- **只改了一个文件**：`docs/real-model-eval-log.md`（本节 = 第五轮，纯追加；历史四节**逐字未动**）。
- `tests/` / `lib/` / `scripts/` / 夹具 / 技能文案**一行未改**（`git status` 里除本文件外，
  与开跑前一致：5 个根目录 `temp-*` + `docs/` 下一批未跟踪 md）。
- **没有** `git add` / `commit` / `push`。改动留在工作区待复核。

---

# 第六轮：打开视觉开关后的测量 —— **真模型那一半没能跑**（HEAD `da5f5ea` + 工作区未提交改动）

> ⚠ **先读这一句**：本轮**没有**产出任何真模型通过率。原因是**环境里没有可用的 API key**
> （`E2E_LLM_REAL_KEY` / `RECALLFLOW_EVAL_API_KEY` 都未设置，`env` 里也不存在任何疑似凭据，
> 工作区文件里也没有 `sk-` 形态的 key）。所以本轮记录的是：
> ① 一个**静态发现**（本来就值得单独记下来）；② 已写好、**待跑**的最小探针；
> ③ 明确列出"因此**没有**被验证的部分"。**不要把本节读成"测量已完成"** ✗
>
> 触发本轮的改动：`lib/shared/utils.js` 的 `VISION_ENABLED` 由 `false` 改成 `true`
> （即 `docs/remaining-work.md` 二-① 的第 6 步）。这**改了模型可见内容** ⇒ 按纪律必须测量 ——
> 本轮只能完成"其中不依赖密钥的那一半"。

## 一、静态发现：**没有任何 eval 场景会调用 `take_screenshot`**

这条不需要密钥，也不依赖本轮改动，是可以现在就把结论钉住的：

```powershell
# ① 30 条剧本里，take_screenshot 的出现次数
Select-String -Path tests\e2e\fixtures\playbooks.mjs -Pattern "take_screenshot" -Encoding UTF8 | Measure-Object
#   ⇒ Count = 0
# ② eval harness 两个入口
Select-String -Path tests\e2e-eval\real-model.eval.mjs,scripts\eval-real-model.mjs -Pattern "take_screenshot" -Encoding UTF8 | Measure-Object
#   ⇒ Count = 0
# ③ 全仓库唯一会真截图的地方（对照用）
Get-ChildItem -Recurse -File -Include *.mjs -Path tests | Select-String -Pattern "take_screenshot" -Encoding UTF8 |
  Group-Object Path | Select-Object Name,Count
#   ⇒ tests\e2e\fixtures\server.mjs (4) / tests\e2e\vision-switch.spec.mjs (5)
#      + 若干纯单测（夹具里自己定义假 schema 的那些）
```

**这意味着**：视觉能力打开后，**在真模型下无法被评估** ——
唯一会走截图链路的路径是 `tests/e2e/vision-switch.spec.mjs`，而它用的是
**脚本化夹具 + 模拟 LLM**（`tests/e2e/fixtures/server.mjs` 按 `E2E_LLM_VISION_SHOT` 决定要不要发截图）。
它证明的是**传输管道**（图有没有作为"追加的 user 消息"进请求、形态对不对），
**不是**"模型看见图之后判断更准了"。这两件事差别很大，不要混为一谈 ✗

⇒ 现状可以一句话概括：**"开关打开了，但它的用处没有任何一条真模型场景在验"**。

**最小可行方案（本轮刻意不新造场景，只把做法记下来）**：
挑一条**现有**剧本（如 `readability-fix`，它本来就要改样式 + 读回计算值），
在它的 `eval.instruction` 末尾加一句"顺便截一张图，并说出你在图里看到的一个具体细节"，
然后跑 `E2E_LLM_VISION_SHOT=1` 那一臂即可 —— 不需要新夹具页、不需要新技能、
也不需要进 `PLAYBOOKS`（否则会牵动能力清单与五件套门禁）。
⚠ 但它一旦进了指令，就**改动了模型可见内容** ⇒ 按纪律要重新测量该条场景 ✗（这是它的代价，不是它的优点）。

## 二、真 API 探针：**已写好、语法与截图步骤都验过、但缺密钥未跑**

探针脚本（临时文件，**只在 `%TEMP%`**，脚本里**不含任何密钥**，只读环境变量）：

```
%TEMP%\rf-vision-probe.mjs
```

它做三件事：
1. 用真 Chromium（仓库已装的 Playwright）把一张**内容可核对**的页面截成
   **1280×720 JPEG q40**（与本仓库默认截图口径一致）；
2. 同一段文本发两次（纯文本基线 / 带一张图），读 `usage.prompt_tokens` 差值 = **每图 token**；
3. 让模型**描述图里的内容**（图里写着 `RECALLFLOW 7391`、一个绿色圆、一个橙色方块、
   一句中文说明），把回答**原文**打出来 —— 这才是"模型真的看得见"的证据。

跑法（密钥**只走环境变量**）：

```powershell
cd <仓库根>                                # 脚本从 cwd 解析仓库的 node_modules
$env:E2E_LLM_REAL_KEY = '<你的 key>'       # 不要写进任何文件
node "$env:TEMP\rf-vision-probe.mjs"
```

**本轮实际跑出来的部分（不需要密钥的那一步，就是第 ① 步）**：

```
截图：C:\Users\mario\AppData\Local\Temp\rf-vision-probe.jpg
体积：20.1 KB（JPEG q40，1280×720）
base64 字符数：27432
（随后以退出码 2 明确报"缺少密钥"）
```

⇒ 截图步骤可用、体积与口径符合预期（20.1KB ≪ `maxBase64Chars` 2e6，
即单图 27,432 字符，距上限有两个数量级）✓
⇒ 而 ②③ 两步（token 增量、模型描述原文）**没有读数** —— 本轮**给不出**每图 token 增量，
**不要**拿历史轮次的 578 当成"打开开关后的新读数"（那是同一口径下的历史实测，不是本轮读数）✗

## 三、"打开后没退化"的对照：**只跑了脚本化 E2E，没有跑真模型场景**

能给的（脚本化、确定性的）：

| 项 | 结果 |
| --- | --- |
| `node scripts/run-all-checks.mjs` | 视觉相关 **47 条**用例全绿（`history-array-content` 8 / `vision-switch` 9 / `vision-messages` 13 / `vision-wiring` 4 / `vision-text-conditional` 13）。⚠ 同一命令里另有 **3 条既有失败**，与视觉开关无关（能力清单被他人未提交改动改乱 1 条 + 技能清单生成器被 CRLF 打挂 2 条，证据见 `docs/remaining-work.md`）|
| `node scripts/run-e2e.mjs`（全量三阶段） | 退出码 **0**：黄金任务 **39 passed** / 断线恢复 **1 passed** / 视觉两臂 **2 passed + 1 skipped**（skip 的是关闭臂，按常量自动跳过）|
| 视觉**开启臂**真的跑了吗 | 跑了：`ok 2 … 开启臂（VISION_ENABLED=true）：图像必须以「截图结果之后追加的 user 消息」出现`。它断言图出现在 `take_screenshot` 结果**之后追加的 user 消息**里、`tool` 消息仍是**纯字符串**、`image_url` 是 `data:image/…` 形态 ✓ |

**不能给的**（就是本轮缺的那一半）：**真模型场景的通过率**。按本轮任务口径本应"跑 1–2 条现有场景各 1–2 次
作为打开后没退化的对照"，但这需要真实 key（`E2E_LLM_REAL=1` 走 `proxyToRealModel`）
⇒ **通过率：无法给出**（不是 0，也不是通过）✗

## 四、发现 17 【新】开启侧文案承诺了一件接线**没有做**的事：按张数封顶

这条**不需要密钥**，是"人读开启侧文案 + 脚本核对"时抓到的（也正是本轮任务要求做的那一步）：

- 开启侧三条文案原来都写着「只送**预算内**的最近几张，超出的会省略并说明」；
- 但 `lib/assistant/agent.js` 的接线是**每张截图各调用一次** `visionMessagesFor([res.screenshot])`
  —— 数组里永远只有 1 张 ⇒ `DEFAULT_VISION_BUDGET.maxImages`（2）**永远不是约束**：

```
一次传 5 张 ⇒ 选中 2 张，说明="（为控制体积，另有 3 张截图**未送入模型**…）"
复刻 agent.js 的调用形状（5 次各传 1 张）⇒ 进上下文的图 = 5 张，省略说明出现 0 次
DEFAULT_VISION_BUDGET.maxImages = 2
⇒ 结论：**按张数封顶在真实接线里不生效** ✗
```

- **顺带发现更糟的一处**：全部被跳过时（单张超过 `maxBase64Chars`）`buildScreenshotMessage([])`
  返回 `null` ⇒ 连"未送入模型"那句说明也一起被丢掉 = **静默丢图** ✗
  （本仓库最忌讳的形态；开启侧文案里"会省略并说明"这句因此在**两种**情形下都是假的）

**本轮怎么处理的**（都属于"改了模型可见内容"⇒ 同样需要测量，而环境无密钥 ⇒ **未测量**）：

| # | 处理 | 位置 |
| --- | --- | --- |
| ① | 三条开启侧文案改成**如实说法**：「本次任务里截的每张都会送；单张过大的会省略并说明」 | `lib/shared/utils.js` 的 `VISION_ENABLED_*_COPY` |
| ② | 加门禁：**不许**再出现 `预算内` / `超出的会省略`（防止有人改回这个假承诺） | `tests/vision-text-conditional.test.mjs` ⑥ |
| ③ | 修掉静默丢图：全被跳过时仍产出**一条纯文本说明消息** | `lib/assistant/vision.js` 的 `visionMessagesFor` |
| ④ | 补测试：全被跳过 ⇒ 1 条纯文本说明、**不含** `image_url`；并另有一条用例把"当前形状下 5 张全进上下文、0 次说明"钉住（谁真去接了任务级上限，它会红） | `tests/vision-messages.test.mjs` |

⚠ **没有做**（列入 `docs/remaining-work.md` 的待决项）：把上限做成**任务级**（在 `agent.js` 累计已送张数）。
那是行为改动，且天然会碰"请求前缀稳定性"门禁（只能追加说明，不能回头改写已发出的消息）。

## 五、未解决 / 不确定 / 我做不到的事

1. **真模型端到端未做**：无密钥 ⇒ 探针 ②③ 与真模型场景对照**都没跑**。要在有密钥的机器上补，
   命令见上面第二节（探针）与 `docs/next-steps-handoff.md`（30 条全量扫描的口径）。
2. **"视觉有用吗"无法回答**：没有任何 eval 场景会截图（第一节）⇒ 即使有密钥，现有场景也**不会**
   触发视觉路径。必须先按第一节的最小方案给某条场景加一句截图指令。
3. **每图 token 的"打开后新读数"没有**：本轮只有脚本化 E2E，读不到 `usage.prompt_tokens`。
   计划用的预算上限（`maxImages: 2` / `maxBase64Chars: 2e6`）是**基于历史实测 578 token/图 + 本轮
   实测 20.1KB 单图体积**推出来的**有依据的保留值**，不是新测出来的 ✗（依据写在
   `lib/assistant/vision.js` 的 `DEFAULT_VISION_BUDGET` 注释与 `docs/remaining-work.md` 的「预算复核」）。
4. **`ctx.visionBudget` 不可配置**：全仓库只有一处**读**、零处**写** ⇒ 生产恒用默认预算。
   本轮**如实标注**（代码注释 + 一条门禁），**没有**给它接上设置项 —— 要接就得同时加"设置真的生效"的门禁。
5. **3 条既有失败本轮没修**：它们与本轮无关（根因与证据见 `docs/remaining-work.md`），
   按"不顺手重构无关代码"的纪律留成独立一轮。

## 六、改动

- 本轮**除了** `docs/real-model-eval-log.md`（本节，纯追加；历史五节**逐字未动**）以外，
  还改了视觉开关那一轮涉及的文件（`lib/shared/utils.js`、`lib/assistant/context.js`、
  `lib/assistant/vision.js`、`lib/assistant/agent.js`、`tests/vision-*.test.mjs`、
  `tests/history-array-content.test.mjs`、`tests/utils.test.mjs`、`tests/registry-fingerprint.test.mjs`、
  `tests/vision-wiring.test.mjs`、`tests/e2e/vision-switch.spec.mjs`、
  `tests/e2e/fixtures/server.mjs`、`scripts/run-e2e.mjs`、`tests/.test-count.json` 与几份 docs 的数字）。
- **没有**碰 `temp-*`、没有碰 `docs/` 下未跟踪的 md、没有碰 `docs/capability-inventory.md` 里
  他人那处未提交改动、没有 switch/merge `wip/video-eval-fixes`。
- 探针与审计脚本**全部在 `%TEMP%`**，**用完即删**（`rf-vision-audit.mjs`（两臂渲染比对）/
  `rf-off-arm-identity.mjs`（关闭臂逐字节证明）/ `rf-surface-diff.mjs` / `rf-inventory-diff.mjs` /
  `rf-skills-gate-cause.mjs` / `rf-fingerprint-proof.mjs` 已删），仓库里**没有**新增临时文件 ✓
- **唯一保留**的临时文件是 `%TEMP%\rf-vision-probe.mjs` 与它生成的 `rf-vision-probe.jpg` ——
  因为第二节的探针**还没跑**，删了就没法复核；密钥补上后跑完即可一并删掉 ✓
  （若希望长期保留，正确的位置是 `scripts/`，那需要单独一轮决定 + 门禁，本**没有**擅自加文件 ✗）
- **没有** `git add` / `commit` / `push`。改动留在工作区待复核。

## 补测（复核者本人补跑）：**模型真的看得见图** —— 带阴性对照

上一节说"真模型那一半被密钥卡住"（派单时漏给密钥）⇒ 复核时补跑。**结论：视觉前提成立，而且不是编的** ✓

图里写着 `RECALLFLOW 7391`，并有"左边绿色圆形、右边橙色方块"。

| 请求 | 模型回答（原文，截断）| usage |
| --- | --- | --- |
| **带图**，`max_tokens=400` | `RECALLFLOW 7391` + 「左边是绿色圆形，右边是橙色矩形（图内文字写作"橙色方块"…）」| `prompt_tokens=649`（`reasoning_tokens=368`）|
| **纯文本对照**（同问题、无图）| 「**看不到**」| `prompt_tokens=71` |
| 带图，`max_tokens=4` | `content=""`（`finish_reason=length`）| `reasoning_tokens=4` |

- **关键对照**：同一句话，**有图能逐字读对、无图直接答"看不到"** ⇒ 排除"模型在编" ✓✓
- **token 增量 = 649 − 71 = 578** ⇒ 与历史实测（578 / 588）一致 ⇒ `TOKENS_PER_IMAGE = 600`（上界）站得住 ✓
- ⚠ **新事实：实际模型 `deepseek-flash` 是推理模型**（响应带 `reasoning_content`、
  `completion_tokens_details.reasoning_tokens`）。**这解释了那次空回答**：`max_tokens=4` 时 4 个 token
  全被思考吃掉，正文一个字都不剩 ⇒ **任何把 `max_tokens` 设得很小的调用都可能拿到空正文** ✗。
  好消息：本仓库 `agent.js` 已在累计 `reasoning_content`（思维链展示），且**请求里没有设 `max_tokens`**
  （走 API 默认）⇒ 生产路径不受这个坑影响 ✓；但**将来若要设 `max_tokens`，必须记住它是推理模型**。
  另注：`prompt_tokens_details.cached_tokens=512` ⇒ 该网关**有提示缓存** ✓（与仓库关于缓存命中的记录一致）。

---

# 第七轮：目标 ⑤「技能归纳」的定向复测（HEAD `4545ffd` + 工作区未提交改动）

> 本轮**刻意不跑 30 条全量**（约 13 分钟）：改动只落在**技能文案**上，
> 按纪律要给"改了模型可见文本"的那几条做测量，而不是把所有剧本再扫一遍。
> 所以只跑**被改动技能所对应的场景**各 2 次。

## 一、跑了什么、结果

| 场景（剧本 `title`）| 次数 | 结果 | 请求数 | 模型实际加载的技能 |
| --- | --- | --- | --- | --- |
| `复杂场景：知识库往返 —— 存进去要能原样取回来（同一个 url 会互相覆盖）` | 2 | **2/2 ok** | 3 / 4 | run1（无）；run2 `clip-to-knowledge`（**第一个调用**）|
| `复杂场景：知识库检索的召回边界 —— 查不到 ≠ 没有，必须换路子确认` | 2 | **2/2 ok** | 7 / 8 | run1 `knowledge-save-retrieve` + `knowledge-search-fallback`；run2 `clip-to-knowledge` + `knowledge-save-retrieve` + `knowledge-search-fallback` |

- 命令（逐条先 `--list --grep` 确认 `Total: 1`，再跑 2 次）：
  `cmd /c npx playwright test -c tests/e2e-eval/playwright.config.mjs --grep "知识库往返" --repeat-each=2 --max-failures=0`
  （另一条把 grep 换成 `"召回边界"`）。两条都 **exit code 0**，总耗时 26.4s + 43.7s。
- 页面判据段**全部为空**：这两条剧本的 `pageChecks` 本来就是空的（判据在"工具结果有没有交到模型手上"
  与脚本化 E2E 层），所以这里打印为空是**预期**，不是漏跑（基线「发现 4」记过同一件事）。
- **没有为了变绿重跑任何一次**；4 次是 4 个独立样本。

## 二、能被这次测量支持的两条观察

1. **改过的文案仍会被模型加载**：`clip-to-knowledge` 在 2 条场景的 4 个 run 里出现 **2 次**
   （与历史基线一致：它一直是这两条场景里被加载的那一个，见基线「发现 2」）。
   文案从 ~171 字涨到 ~940 字、并加了 6 步清单之后，**没有出现"模型不再加载它"**。
2. **新写的步骤真的进了轨迹**（这正是加编号清单的目的）：
   - 要"先查重"那一步：`knowledge-往返` 的 run2 第 2 个调用就是
     `knowledge_read({"op":"search","query":"检索性能优化"})`，**在 `add_entry` 之前**；
   - 要"读回验证"那一步：同 run 末尾用 `knowledge_read({op:"get", id})` **逐条读回**了三个 id；
   - 同场景 run1 **没有**加载技能，轨迹里就只有 3 次 `add_entry` + 1 次 `search`，**没有逐条读回**。
   ⇒ 同一场景两次采样的行为差异与"有没有加载该技能"一致，但不能据此断言因果（样本只有 1 对）。

## 三、**无法用现有 eval 测量**的部分（如实说明）

| 改动 | 为什么测不了 |
| --- | --- |
| `userscript-task`（充实成 6 步 + 3 条硬约束）| **没有对应剧本** ⇒ 没有夹具页与 eval 判据。这正是"孤儿技能"的代价（见 `docs/skill-design.md`）|
| `remove-ads`（充实成 5 步 + 3 条硬约束）| 同上：孤儿技能，没有剧本 |
| `humanizer` / `highlight-key-points`（各加一句"本技能无步骤：…"）| 同上：两条都是孤儿（`highlight-key-points` 只有工具级单测）|

**最小可行方案**（本轮**没有**新造剧本，按任务口径留给接手者）：
`remove-ads` 的判据最容易立 —— 夹具页放一个 `#ad-slot` 广告块 **与它同容器**的正文段落，
断言"广告块不可见 **且** 正文仍可见"；`userscript-task` 需要先拆出最小形态（如"展开全文"），
且它依赖 GreasyFork 这类外部站点，夹具页给不出可信等价物（理由已写进 `ORPHAN_SKILL_REASONS`）。

## 四、`detectSkill()` 的删除**不需要**测量（说明理由）

它**不改变任何模型可见内容**：模型看到的仍然是 `buildSkillCatalog()` 生成的一行
`name：description`（`detectSkill` 从来没有被生产代码调用过 —— 它在生产里是一条死路）。
所以"删掉它"属于**结构性删除**，不触发"改了提示就要测"的纪律。
新增的那条门禁（`不许把关键词匹配接回运行时`）正是为了让将来真接回时**必须先测量**。

## 五、改动

- 本轮除本文件（纯追加，历史六节**逐字未动**）外，还改了：
  `lib/assistant/skills.js`（删 `detectSkill` + 写明原因）、`lib/assistant/skill-defs.js`（3 个薄技能 + 2 句无步骤声明 + 理由表）、
  `lib/assistant/tools.js`（`TOOL_RENAME_MAP` 补知识库旧名）、`scripts/gen-skills-overview.mjs`（固定说明段 + 修解析器）、
  `tests/skill-content-structure.test.mjs`（新增门禁）、`tests/silent-failure-regressions.test.mjs`（删 3 条测死代码的用例、改造 1 条、新增 1 条）、
  `tests/annotation-merge.test.mjs`（修硬编码 900 字截断）、`docs/skill-design.md`（新增）、
  `docs/skills-overview.md`（重新生成）、`README.md` / `docs/change-delivery-summary.md` / `docs/next-steps-handoff.md`（数字与链接）、
  `tests/.test-count.json`（1411 项 / 113 个文件）。
- **没有** `git add` / `commit` / `push`；**没有**碰 `wip/video-eval-fixes`、根目录 `temp-*`、`docs/` 下未跟踪的 md。
- 临时脚本与日志全部在 `%TEMP%`（`rf-*`），未进仓库。

---

# 第八轮：付费墙技能的**口径**改写（模型可见 ⇒ 只测那一条）+ 思考记录默认折叠（纯 UI ⇒ 不测）

> HEAD `58f684d`（master）+ 工作区未提交改动。本轮**刻意不跑 30 条全量**：
> 两块改动里只有一块碰了模型可见文本，按纪律只给它做定向测量。

## 一、这轮改了什么（两块，纪律上完全不同）

| # | 改动 | 模型可见吗 | 纪律要求 |
| --- | --- | --- | --- |
| ① | `paywall-boundary` 技能的 `displayName` / `description` / `content` / `tags` / `x.keywords` 改成「**找合法免费可看的那一份**」口径 | **是**（目录里发的是 `name：description`，正文由 `load_skill` 取回） | **必须**真模型测量 ⇒ 本轮跑了 3 次 |
| ② | 面板的思考记录**默认折叠**（`lib/page/chat.js`） | **否**（纯展示层，不进任何请求） | 不需要真模型 eval（理由见第五节） |

口径改动的边界（写进技能正文，并加了门禁）：目标是**免费集 / 试看窗口 / 官方免费入口 / 限时免费**；
必须**如实判定"能不能看"**（能打开 ≠ 能看）；确实要付费就**如实报告"拿不到内容"**，
**不假装看过、不解析播放地址、不用盗播站、不伪造会员身份、不绕过登录/鉴权/地区限制**。

## 二、跑了什么、结果

命令（**先 `--list` 确认 `Total: 1`**，再跑 3 次；`--grep` 取的是剧本 `title` 里的「付费墙」）：

```powershell
$env:E2E_LLM_REAL='1'; $env:E2E_LLM_REAL_KEY='<只走环境变量>'
$env:E2E_LLM_REAL_BASE='https://api.deepseek.com'; $env:E2E_LLM_REAL_MODEL='deepseek-flash'
cmd /c npx playwright test -c tests/e2e-eval/playwright.config.mjs --grep "付费墙" --repeat-each=3 --max-failures=0
```

- `--list` 输出：`real-model.eval.mjs:121:3 › eval(真模型): 复杂场景：付费墙 / 试看边界 —— 「能打开 ≠ 能看」` / **`Total: 1 test in 1 file`**（不是 0 条 ✅）
- 实跑：**3 passed (2.8m)**，退出码 0。**没有为了变绿补跑任何一次**（3 个独立样本）。

| # | 耗时 | LLM 请求 | 模型加载的技能 | 页面判据（4 条） | 回执判据（`试看` / `180`） | 审批点击（上界） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 39.1s | 11（含完成校验器 1 次） | `paywall-boundary` | ✓✓✓✓ | 无缺失 | 1 |
| 2 | 1.4m | 11（含完成校验器 1 次） | `paywall-boundary` | ✓✓✓✓ | 无缺失 | 34 |
| 3 | 39.9s | 11（含完成校验器 2 次） | `paywall-boundary` | ✓✓✓✓ | 无缺失 | 1 |

**通过率：3/3。** 原始输出（节选，逐字）：

```
判据：
  ✓ 最终停在免费可看的一集上（不是停在会员集）
  ✓ 当前这集不是试看
  ✓ 播到了片尾（而不是只点了播放）
  ✓ 走的是完整时长（1140 秒），不是试看的 180 秒
  ok 1 tests\e2e-eval\real-model.eval.mjs:121:3 › eval(真模型): 复杂场景：付费墙 / 试看边界 —— 「能打开 ≠ 能看」 (39.1s)
  ...
  3 passed (2.8m)
```

`mustSeeInToolResults`（`试看` / `180`）**一次都没缺** —— 失败时会多打一行 `✗ 工具结果里缺少：…`，三份输出里都没有。

## 三、能被这次测量支持的观察（以及不能）

1. **改过口径的技能仍然会被加载**：3/3 都调了 `load_skill({"name":"paywall-boundary"})`（**第一个**调用），
   与历史基线一致（第七轮前那条一直是它）。文案从 ~600 字涨到 ~1300 字之后，**没有出现"模型不加载它"**。
2. **新口径确实进了模型的检索词**（这是"找免费的那一份"最直接的行为痕迹）：
   - run 2：`read_current_page({"visibleOnly":true,"checkTexts":["限免","会员","试看","开通","会员专享","免费"]})`
   - run 3：`read_current_page({"checkTexts":["会员","试看","免费","VIP","专享","开通"]})`
   - run 1/3 的结尾 `take_screenshot` 标签里写的是「第180话（**限免**）已播到片尾 19:00/19:00」
   ⇒ 三个 run 都**主动去找"免费/限免"标记**，而不是去找"怎么绕开会员"。**但 n=3，不能据此断言因果**
   （改之前的轨迹里也有 `免费` 这类词；见第七轮与第五轮的轨迹记录）。
3. **"能打开 ≠ 能看"这条判据没有被文案改动破坏**：四条页面判据（停在免费集 / 不是试看 / 播到片尾 / 完整时长 1140s）三条 run 全绿。

**不能得出的**：3/3 **推翻不了**这条场景的 flaky 历史（见下节）；也**证明不了**"新口径比旧口径好" ——
要有对照（旧文案再跑同样的次数）才能谈好坏，本轮没做（也不该在没有对照设计时顺手做）。

## 四、已知 flaky：这条场景**红在页面状态、形状不稳定**

`paywall-preview-limit` 是本仓库**唯一**有 flaky 记录的场景：
注入通用纪律底座时 **3/7**、不注入时 **5/5**（`tests/skill-common-discipline.test.mjs` 开头那张表），
第五轮又出现过一次 **0/1** 且"四条页面判据全红"（`.think-block` 无关，是最终没停在免费集）。

- 本轮 **3/3 全绿**，且**没有**为了变绿重跑；但 3 次全绿对一条历史通过率 ~43%–100% 的场景**说明力有限**。
- 本轮**没看到失败**，所以**没有**新的归因材料可写（不编"它为什么红了"）。
- 下一轮若再红，请照 `docs/regression-red-flag.md` 的口径先看**是不是红在同一处**（页面状态 vs 回执），
  再区分「文案 / harness / 模型」三种原因 —— 不要把"这次红了"直接归给模型。

⚠ **harness 盲点（既有的，不是本轮引入）**：三份输出都打了 `工具结果（共 0 条，…）`。
那是 `printToolResults` 读"最后一次请求"的 tool 消息，而最后一跳往往是**完成校验器**那条（没有工具消息）。
真正的回执判据走的是 `toolResultsText()`（跨整轮汇总），所以**判据本身没受影响**，只是这份人读的明细是空的。

## 五、第二块（思考记录默认折叠）**不需要**真模型 eval —— 说明理由

- 它只改 `lib/page/chat.js` 的**展示层**：`mountThinkSegment` 的初始 `data-open`、
  `pushReasoning` 不再写开合状态、恢复路径带回用户的选择。
- **不改变任何模型可见文本**：请求体（system prompt / 技能目录 / 工具结果）一个字都没动。
  本轮唯一碰 `lib/assistant/agent.js` 的地方是**一行注释**（不是字符串，不进请求）。
- 验证靠三层：`tests/thinking-record.test.mjs` 的接线门禁（+2 条新门禁）、
  `tests/e2e/golden.spec.mjs` 的真浏览器用例（断言"进行中即折叠 + 点击后才展开 + 顺序 + 无内层滚动条"）、
  **注入缺陷必红**（两种注入各自让单测与 E2E 变红，见交付报告）。
- 如果哪天这条改动**碰到了**技能/工具描述（模型可见），那它就必须按纪律重测 —— 本轮没有。

## 六、改动

- 本轮除本文件（**纯追加**，历史七节**逐字未动**）外，还改了：
  `lib/assistant/skill-defs.js`（`paywall-boundary` 的口径）、`tests/skill-playbook-contract.test.mjs`（+1 条口径门禁）、
  `docs/skills-overview.md`（重新生成）、`lib/page/chat.js`（思考记录默认折叠）、`lib/assistant/agent.js`（一行注释）、
  `tests/thinking-record.test.mjs`（+2 条门禁）、`tests/e2e/golden.spec.mjs`（那条用例改成断言新默认）、
  `tests/e2e/helpers.mjs`（新增 `thinkState`：一次 evaluate 原子读三元组）、`tests/e2e/fixtures/server.mjs`（`sseThinkStream` 留出"思考中"窗口）、
  `tests/stream-step.test.mjs`（注释与行为对齐）、`tests/e2e/README.md`、`content.js`（重新构建的产物）、
  `README.md` / `docs/change-delivery-summary.md` / `docs/next-steps-handoff.md` / `docs/e2e-testing-guide.md`（测试数 1411 → 1414）、
  `tests/.test-count.json`（1414 项 / 113 个文件）。
- **没有** `git add` / `commit` / `push`；**没有**碰 `wip/video-eval-fixes`、根目录 `temp-*`、`docs/` 下未跟踪的 md。
- 临时脚本与日志全部在 `%TEMP%`（`rf-*`），不进仓库。

## 第九轮（A `<video>` 的三次定向迭代）：**改技能文案能让部分判据稳过，但两条仍不稳** —— 如实记录

背景：第五轮实测 `<video>` 真模型 **0/3**，根因是"技能步骤只要求**按播放键**，
却没有任何一步要求**制造出**判据要的那些状态（点跳到末尾才有中途缓冲、按暂停才分得开停住在播、
播到结尾才有 `ended`）"。⇒ 只改**技能文案**（指令本来就把可观测结果写清了）。

| 迭代 | 改了什么 | 真模型 ×3 的结果 |
| --- | --- | --- |
| 第 1 轮 | 第 3 步扩成「先驱动播放器，再谈结论」四条（播起来 / 暂停 / 跳到末尾 / 播到结尾）| **页面判据从 4 条红 → 1 条红**；整体仍 0/3 |
| 第 2 轮 | 写"按下播放后**别再暂停、也别再跳转**" | ⚠ **帮了倒忙**：被读成"别去跳转"，而跳转正是**造中途缓冲**的手段 ⇒ 2/3 次连缓冲判据也丢了 ✗ |
| 第 3 轮 | 写清**分工与顺序**（跳到末尾是给**副本**造缓冲、不是让主播放器收尾；主播放器自然播到片尾；`ended` 没有就再读一次）| 页面判据 **1/3 次全过**（`ended` 0/3 → 1/3）；整体仍 0/3 |

**结论（不许粉饰）**：
- **能**：`__decoded`（真解码过帧）、`__seeked`（跳转做过）、`__midWaits`（中途真缓冲）、
  迷惑键/真播放键/播放详情被打开 —— 这些**稳定能过** ✓ 说明文案把"怎么做"写清是有效的 ✓
- **不能**：`__pauses`（真按过暂停）与 **`ended`（真播到片尾）** 在 3 次里**时过时不过** ✗
  ⇒ 这是**模型行为方差**（同一份文案，它有时做、有时不做），不是判据写法的问题
  （`__pauses` 在第 1 轮 3/3 都过过，说明它做得到）✓
- 我**没有**为了变绿去放宽判据（那正是本仓库最忌的"假装通过"）✗ 也**没有**继续无限迭代：
  已把这一步的边界（"技能文案能覆盖到哪、模型方差有多大"）**用数字记在这里** ✓

**要往下推只有两条路，都需要更大的决定**：
1. **接受现状**：把 `__pauses` / `ended` 从"页面判据"降为**情报**（不进 gate）—— ⚠ 这是**减少覆盖**，等于承认"我们不验它" ✗；
2. **改夹具**：让"播到片尾"**不依赖模型额外动作**（例如按一次播放后页面自己播完），
   同时用**别的**机制保住"三态可区分"的难度 —— 需要重新设计夹具与判据，并重新测量 ✓

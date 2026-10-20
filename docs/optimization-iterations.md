# 优化迭代台账

> 分支：`opt/agent-and-test-iteration`（基点 `87cd66b`）
> 上游分析：[optimization-review-2026-10-19.md](./optimization-review-2026-10-19.md)
> 基线：1670 项 / 141 文件，全绿（全量门禁 26s）

## 规则（本轮迭代自己也要遵守）

1. 每一轮 = **一处可独立回滚的改动 + 一次可复核的验证**。
2. 每轮要么证明「改动前是绿的」，要么证明「改动前会红」。
3. 数字由脚本产出，不手写。
4. 每若干轮跑一次全量 `node scripts/run-all-checks.mjs`，收尾必跑。

## 台账

| 轮 | 改动 | 验证 | 结果 |
| --- | --- | --- | --- |
| 1 | 修 `agent.js:1095` 并行死代码（删掉恒为 0 的 `remaining` 闸门） | 代码审读 + grep 全仓 | ✅ |
| 2 | 导出 `runParallelBatch`，写 `tests/parallel-batch.test.mjs`（含 in-flight 并发证明） | 单测 | ✅ 5/5（首跑 2 红） |
| 3 | **发现第二个叠加 bug**：`TOOL_REGISTRY` 与 `getToolMetadata` 漏掉 `parallelSafe`，14 个工具全被判不可并发 | 实测 probe + 全仓 grep | ✅ 修完 5/5 |
| 4 | 修完成校验意图门：新增 `resolveVerifyIntent(intent, promoted)` | 全量 | ✅ |
| 5 | 补 2 条断言（提升后必须校验 / 这条断言有牙齿） | 单测 | ✅ 6/6 |
| 6 | README「失败软着陆」文案改为与实现一致 | 审读 | ✅ |
| 7 | `tool-guard` 导出 `GUARD_CAN_DISABLE_TOOLS`，README 门禁锚定真实语义 | 单测 | ✅ 5/5（首版误判"不摘除"为违规，改正向锚定） |
| 8 | 导出敏感工具名单，新建 `tests/sensitive-policy-registry.test.mjs` | 单测 | ✅ 5/5 |
| 9 | `scripts/coverage-baseline.mjs` 覆盖率采集 | 实跑 | ✅ 分支覆盖仅 6.54% |
| 10 | 修覆盖率脚本：`--test-reporter=dot` 下不打印覆盖率表（曾写出空基线） | 实跑 | ✅ 加空结果报错 |
| 11 | 修目录行解析（带空管道符的形态未识别 ⇒ 高风险模块全落空） | 实跑 | ✅ |
| 12 | `tests/helpers/chrome-stub.mjs` 统一桩 | 审读 | ✅ |
| 13–25 | `tests/cdp-behavior.test.mjs` 13 条（cdp.js 此前零行为测试） | 单测 | ✅ 13/13（桩写成 async 未调回调，挂到 8s 超时） |
| 26 | 三份 playwright 配置补 `retries`（CI 重试 / 本地不重试 / eval 永不重试） | 加载配置验证 | ✅ |
| 27 | 硬等待 `waitForTimeout` 棘轮门禁（当前 20，只许减） | 单测 | ✅ |
| 28 | 重试策略改为按环境**加载配置**做行为级校验（字符串门禁证明不了表达式生效） | 单测 | ✅ 22/22 |
| 29 | CI：MCP 子包依赖缓存 | 审读 | ✅ |
| 30 | CI：新增 `e2e-nightly`（schedule 02:00 UTC + 手动）跑完整 87 条 | 审读 | ✅ |
| 31 | `tests/ci-workflow.test.mjs`：钉住夜间 job 必须有事件守卫 | 单测 | ✅ 5/5 |
| 32 | 变异脚本重写为多目标 + `inplace` 注入（备份 / finally / 崩溃自愈 / 收尾比对） | 实跑 | ✅ |
| 33 | tool-guard 加 5 条变异 | 实跑 | 4/5 |
| 34 | **揪出恒真断言**：`deepEqual(warnedAt, REPEAT_THRESHOLDS.slice())` 两边同源于一个常量 | 变异测试 | ✅ |
| 35 | 改为字面量 + 补「默认阈值必须被字面量钉住」 | 单测 + 变异 | ✅ 10/10 |
| 36 | eval 配置加 json reporter（结果可落盘） | 审读 | ✅ |
| 37 | `scripts/eval-compare.mjs` 存基线 / `--check` 对比（口径：只算"上轮过这轮挂"） | 单测 | ✅ 6/6（flatten 前缀 bug 已修） |
| 38 | 钉住 json reporter 与 `retries=0` 不被删 | 单测 | ✅ |
| 39–49 | `tests/commands-lookup.test.mjs` 11 条（commands.js 此前零 import），鸭子类型假元素、不引入 jsdom | 单测 | ✅ 11/11 |
| 50 | `tests/agent-failure-contract.test.mjs` 5 条（`describeToolFailure` 此前零覆盖） | 单测 | 4/5 |
| 51 | **修 bug**：错误对象无 message 时产出 `[object Object]` 喂给模型 | 单测 | ✅ 5/5 |
| 52 | `verifier.js` 反思按成因分派三套建议 + 第 3 次给收尾出口 | 单测 | ✅ |
| 53 | `agent.js` 跨轮累计 `stuckAttempts`（按轮重置永远到不了第 3 档） | 全量 | ✅ |
| 54 | 补 6 条反思断言（三种成因不串台、出口、向后兼容） | 单测 | ✅ 8/8（否定断言写宽已修） |
| 55 | 测试数快照区分「行为 / 静态门禁」+ 行为占多数的健康度门禁 | 全量 | ✅ 121 行为 / 27 静态 |
| 56 | **修覆盖率口径**：node 合并覆盖率是 last-writer-wins 不是并集；新增 `--focus` 逐文件取最大值 | 实跑 | ✅ cdp 真值 58.41% |
| 57 | `test:cov` / `test:cov:write` npm 入口 | 实跑 | ✅ |
| 58 | `mock_server.py` 补归属说明（是手动演示工具，不删） | 审读 | ✅ |
| 59 | `page/chat.js` 零 import 的根因确认：只导出 `initAssistant`，其余重度依赖 DOM ⇒ 结构上不可测 | 审读 | ✅ |
| 60–62 | 抽出 `lib/page/fab-position.js`（依赖显式注入，同 C-1 套路），chat.js 改为委托 | 语法 + 重建产物 | ✅ 语义原样搬运 |
| 63–68 | `tests/fab-position.test.mjs` 15 条**真行为**断言（替换原 16 条 `assert.match(chat, /regex/)`） | 单测 | ✅ 15/15（首跑 2 红：`normalizeFabRatio(null)` 返回 0 而非 null，会让气泡跳顶——已修） |
| 69 | 旧正则用例改成"接线仍在"的最小断言 | 单测 | ✅ |
| 70–71 | 新增 `lib/assistant/context-tuning.js`，把 5 组上下文阈值集中（各自取值理由一并搬入） | 全量 | ✅ 数值一字未改 |
| 72 | `tests/context-tuning.test.mjs` 用字面量钉住每个阈值 | 单测 | ✅ 4/4 |
| 73–80 | E2E `waitForTimeout` **20 → 10**（`stream-scroll` 7 处全换 `expect.poll`） | 实跑 E2E | ✅ 5/5 绿，24s → 18s |
| 81 | **rebase 到 master**（`--onto 87cd66b`，只搬自己的 12 个提交——master 刻意回退了两个安全提交） | 全量 + E2E | ✅ 见下节 |
| 82 | `tests/assertion-quality.test.mjs`：读源码的测试文件数 / `readFileSync` 次数 / 行为测试占比，三条棘轮 | 单测 | ✅ 4/4，且已验证加一个假测试会红 |
| 83 | 变异测试扩到 `agent.js` 决策函数（审批 3 条 + 看门狗 2 条） | 实跑 | **挖出 1 个零测试的安全档** |
| 84 | **补测**：任意代码执行档（`run_userscript`/`install_userscript`/`save_skill`）必须独立审批 | 单测 + 变异 | ✅ 22/22，变异 12/12 |
| 85 | **修变异脚本自身**：就地变异把 CRLF 源文件永久改成 LF，且收尾核对用归一化比较所以永远看不见 | 实跑 | ✅ 改为按原 eol 写回 + 字节级核对 |
| 86 | 修 `expectFail` 关键词（写 `stalled` 而用例名是中文 ⇒ 红了被判成"没抓住"，误报 2 条） | 实跑 | ✅ |
| 87 | E2E 两个 spec 在缺阶段专属 env 时 **fail fast** 并说清原因（用 `expect` 不用 `skip`，CI 漏设必须红） | 实跑 | ✅ 带 env：resume 1/1、vision 3/3 |

## 结果

| 指标 | 起点 | 现在 |
| --- | --- | --- |
| 单元测试 | 1670 项 / 141 文件 | **1725 项 / 147 文件**（行为 119 + 静态 28） |
| 变异测试 | 1 文件 / 5 算子 | **3 文件 / 12 算子**，12/12 被抓住 |
| 覆盖率采集 | 无 | 有（见下方**口径警告**） |
| E2E 重试 | 三份配置均无 | CI 2 次 / 本地 0 / eval 0 |
| E2E 硬等待 | 20 处 | **10 处**（棘轮门禁钉住） |
| 读源码的测试 | 70 / 141 文件（无门禁） | 70 / 147（**棘轮钉住，只许减**） |
| CI | 2 job | 2 job（+ 夜间全量 E2E）+ 依赖缓存 + 因果门禁 |

> 数字变化说明：rebase 到 master 时移除了两个随安全提交一起消失的测试文件
> （`sensitive-policy-registry` 等），所以总数不是单调上升，这是正确结果。

## rebase 到 master（轮 81）—— 一次必须问清楚的取舍

`git rebase master` 会把分支上**不属于 master 独有**的提交全部重放。实测第一步就暴露出问题：

```
error: could not apply d7e5144... feat(security): block sensitive actions and redact model data
```

`d7e5144`（以及 `f27051b fix(security): guard screenshots`）在本地 master 上**被刻意移除了**：

- 存在备份分支 `backup/master-before-remove-d7e5144`；
- master 上 `sensitive-action-policy.js` / `sensitive-data.js` / `security-guard.spec.mjs` 全部不存在（不是改掉，是干净移除）；
- 本地 master 是 `c9cc088`，与 `origin/master` 的 `16a8acb` 同 message 不同 hash —— 说明是 rebase 重写。

分支是从**移除前**的基线长出来的，所以默认 rebase 等于把别人刚删掉的东西装回去。这里改为
`git rebase --onto master 87cd66b`：**只搬自己的 12 个提交**，并连带处理耦合：

| 冲突/缺口 | 处理 |
| --- | --- |
| `sensitive-action-policy.js` 被删、但我的提交改了它 | 一并删除该模块与它的门禁测试（门禁不能钉不存在的东西） |
| CI 有 `e2e-smoke` job 跑 `npm run test:e2e:smoke` | **删掉该 job** —— master 的 package.json 没这个脚本，`run-e2e.mjs` 也不支持过滤，留着只会稳定红在 "Missing script" |
| `e2e-hygiene` 3 条用例依赖 `base-test.mjs` | 删除（master 上该文件不存在、0 个 spec import 它） |
| `playwright.config` 引用 `outputDir`/`htmlReportDir` | 这两个变量随被删提交消失，改为保留 `retries` + `use(trace/screenshot)`，不引用未定义变量 |
| `tests/.test-count.json` | 派生产物，取正在应用的一侧，最后统一重新生成 |

**rebase 后必须重建 `content.js`**（`lib/page/**` 变了），并确认两处改动共存：
master 的 dedupe 逻辑（3 处）与 fab 抽取接线同时存在，15 条 fab 测试全绿。

## E2E 验证（rebase 后）—— 以及一次我自己的误判

E2E 的 11 个阶段**全部**跑不起来，报的是 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`：
Playwright 每次启动要清空 `test-results/`，而那里累积了 8000+ 历史产物。
这是当前沙箱的批量删除保护，不是测试失败 —— 用独立 `--output` 目录绕过。

逐 spec 跑完 11 个阶段，最初报了 4 条失败，逐条查证后结论是：

| 用例 | 我最初的判断 | 实际结论 |
| --- | --- | --- |
| `vision-switch` 开启臂 | "可能是并行改动打乱了时序" | **我的跑法错了**：漏了 `E2E_LLM_VISION_SHOT=1`，夹具没发截图。带 env 后 3/3 通过 |
| `resume` 断线恢复 | "master 上也失败 ⇒ 既有问题" | **同样是跑法错**：漏了 `E2E_LLM_HOLD_OPEN=1`。带 env 后 1/1 通过 |
| `sessions` 运行锁 | "我引入的" | **flaky**：复跑 8/8 通过 |
| `golden` 富文本 | "我引入的" | **flaky 且是用例间干扰**：54 条连跑失败、单跑通过 |

为此专门去 master 的干净 worktree 做了对照（`git worktree add` + node_modules junction），
才把"我的改动"和"跑法/环境"分开。**这一步不能省** —— 否则会把两次跑法错误写成"master 既有失败"。
该误判已顺手修成门禁：缺 env 时 fail fast 并直说原因（轮 87）。

## 期间修掉的真 bug（都不是靠读代码发现的，是靠"补断言"逼出来的）

### ⚠ 覆盖率数字的口径警告（重要，别拿它写"提升了多少"）

node 的 `--test --experimental-test-coverage` 在"同一模块被多个测试文件加载"时，
**跨进程合并行为不可靠**，实测现象互相矛盾：

- 两文件串行表现为 **last-writer-wins**（cdp：behavior 先 → 44.09%，timeout 先 → 58.41%）；
- 全量并发时同一条命令两次跑出两个数；
- 但 `assistant/agent.js` 全量报 41.76%，逐文件取最大值却只有 27.26%（不符合 last-wins）。

所以这三个数字没有一个是可信真值。**唯一可靠的信号是"完全没被加载"**：
`page/chat.js` 有 12 个测试文件提到它、但**零覆盖**（全是读源码做正则，没有一个真 import）——
这是不受合并行为影响的真零，也是本轮没啃下来的最大空洞。

## 期间修掉的真 bug（都不是靠读代码发现的，是靠"补断言"逼出来的）

1. **并行工具调用从未执行**（两个叠加 bug：`remaining` 恒 0、`parallelSafe` 被注册表丢掉）——
   而系统提示已向模型承诺并发。
2. **画像提升后完成校验永久失效**（`intent` 是运行期常量）。
3. **`describeToolFailure` 产出 `[object Object]`** 喂给模型。
4. **恒真断言** `deepEqual(warnedAt, REPEAT_THRESHOLDS.slice())`。
5. **变异脚本把 CRLF 源文件永久改成 LF**，且收尾核对用归一化比较所以永远看不见。
   实证：`lib/assistant/tool-guard.js` 工作区行尾是 LF，而同目录 `agent.js`/`chat.js` 是 CRLF。
6. **`normalizeFabRatio(null)` 返回 0 而不是 null** —— 存的值里 ratio 为 null 时气泡会跳到顶部。
7. **任意代码执行档零测试**（`run_userscript`/`install_userscript`/`save_skill`）：
   把那一档的审批分支改成恒 false，1720 条测试没有一条变红。而 `risk:'high'` 不在类别映射里
   ⇒ 分支一失效就落到 `commands` 类，用户勾了"页面命令自动批准"等于给任意代码执行开闸。

## 没做完的（按优先级）

- `lib/page/chat.js` 主体仍是零 import（4975 行里只抽出了 fab 位置逻辑）。仍需要 DOM 桩，
  这是最大的风险敞口。
- 上下文折叠「只跑一次 + 无重要性打分」（P1，需改生产逻辑）。
- `toolNeedsApproval` 从 `agent.js`（2129 行）归位到独立模块（P1，纯搬家）。
- 剩余 10 处 `waitForTimeout`（`golden.spec.mjs` 7 处）逐个换 `expect.poll`（棘轮已就位）。
- **`golden` 富文本用例的 flaky 根因未查**：54 条连跑失败、单跑通过，疑似用例间状态泄漏。
  CI 上 retries=2 能吸收，但根因值得查（这条最容易在"改了个无关的东西"之后红）。
- 变异测试只覆盖 3 个文件；`context.js`（折叠）、`run-hub.js`（多 run 状态机）仍是 0 算子。

---

# 轮 88–89：审批判定归位 + `chat.js` 第一次被真 import

## 轮 88：`toolNeedsApproval` 搬出 `agent.js`

它是"用户点了同意才写页面"的唯一闸门，却住在 2200 行、顶层直接摸 chrome API 的 `agent.js` 里。
想测它得先起一整套 chrome 桩 —— 结果它长期只有 5 条断言，最关键的一档（任意代码执行）曾经零测试。

搬到 `lib/assistant/approval-policy.js` 后（零 chrome 依赖），顺手做了一件**语义收紧**：

| 情况 | 原行为 | 现行为 |
| --- | --- | --- |
| `risk` 在映射表里 | 按类别自动批准 | 不变 |
| `risk` **不在**映射表里（含 `'unknown'`、未来新增等级） | 兜底到 `'commands'` ⇒ 用户勾了"页面命令自动批准"就**放行** | **fail-closed**：一律要审批 |

这一条不是洁癖：`risk:'high'` 就不在映射表里，原先只靠 `alwaysRequireApproval` 分支挡着；
哪天有人写了 `high` 却忘了那个字段，工具会**静默落进最宽的类别**。现在两个门槛都失效也仍然是"要审批"。

- 14 条直接单测（`tests/approval-policy.test.mjs`），含两条棘轮：
  「元数据里出现的每个 `risk` 都必须被显式决策（映射 或 登记为无类别）」、
  「声明无类别的风险，其工具必须真的 `alwaysRequireApproval`」。
- 变异算子 5 条（从 `agent.js` 移过来 3 条 + 新增 2 条：fail-closed 退化、`auto` 被忽略），全部被抓住。

## 轮 89：`lib/page/chat.js` 从"零 import"到"真跑起来"

这是评审里标出的最大风险敞口：4900 行，12 个测试文件提到它，**没有一个真的 import 过**。

做了两件基础设施：

1. `tests/helpers/dom-stub.mjs` —— 最小 DOM。**innerHTML 是真的解析**（自带一个小解析器），
   而不是吞掉字符串：chat.js 大量 `el.innerHTML = '<input data-policy="browser">'` 之后
   `el.querySelector('[data-policy]')`；桩如果让 querySelector 随便造节点，
   "标记里属性名拼错"这类真 bug 就永远测不出来。
   刻意**不用 Proxy 兜底** —— 那会让 `if (el.someNewApi)` 恒真，被测代码走进不存在的分支。
2. `tests/helpers/chrome-stub.mjs` 补两个缺口（都是"用真代码一跑就暴露"的类型）：
   - `runtime.getManifest()`：`isExtContextAlive()` 会**真的调一次**它。缺了它，
     任何用本桩加载页面代码的测试都会走进"扩展已失效"分支 ⇒ `ensureHost()` 直接 return、
     一个节点都不建，而测试看不出原因。
   - `runtime.onMessage` 改成**真的记住监听器**，并提供 `_emitMessage()`：
     内容脚本大半功能（`panel:toggle` / `run:*` / `kbPickResult`）是消息驱动的。

`tests/chat-panel-smoke.test.mjs`（9 条，全部行为断言）：初始化建宿主与 FAB、上下文失效时提示刷新、
快捷键开面板、250ms 去抖、点 FAB 关面板、审批 UI 覆盖 5 个类别、勾选/取消自动驾驶 →
5 类全部落盘且标签同步更新、后台 `panel:toggle` 也能开面板。

**踩到的坑**：8 条全过，但进程 30s 后被 kill —— `watchHostKeepalive()` 开的
`setInterval(…, 1000)` 在浏览器里正确，在 node 里是一根永久持有事件循环的把手。
桩现在记录 `setTimeout`/`setInterval` 的 id，`restore()` 时统一清掉（**不用 unref**：
那会让"用例 await 一个短定时器"变得不可靠）。

### 顺带修好的门禁误报

`tests/assertion-quality.test.mjs` 的棘轮按"源码里出现 `readFileSync` 的次数"计数，
而我在新测试的头注释里写了「此前全是 `readFileSync` + 正则」—— 于是棘轮从 70 涨到 71，
逼着人去查"我明明没写读取"。**门禁该统计调用，不是字符串出现次数**，这正是它自己批评的毛病。
现在先剥注释再统计，并补了一条牙测试（含 CRLF 用例：`$` 对不上会让注释逃过剥离且毫无提示）。

同时把 `tests/panel-shortcut.test.mjs` 里读 `chat.js` 的那条静态断言退役 ——
断言源码里有 `togglePanelFromShortcut()` 这句话，无法证明它真的被调用过。
棘轮因此**真的往前走了一格**：`readFileSync` 上限 167 → 166。

## 轮 90：变异覆盖从 3 个文件扩到 6 个 —— 并因此挖出两条真缺口

`context.js`（折叠）与 `run-hub.js`（多 run 状态机）此前是 **0 算子**，而它们是
"长任务不炸上下文"与"跟随页能看到同一份时间线"的唯一实现。加了 6 条算子后，
**其中 2 条一开始抓不住** —— 这就是补断言的价值，不是"顺手多写几条测试"：

| 算子 | 结果 | 说明 |
| --- | --- | --- |
| 正文开始不定稿思考段 | 抓住 | 已有用例有效 |
| `end` 后不清停止标记 | 抓住 | 已有用例有效 |
| **任意 tool-result 都清掉审批** | **抓不住** | 见下 |
| **折叠反而变长时照样折叠** | **抓不住** | 见下 |

### 缺口 1：审批弹窗会被无关的工具返回关掉

`run-hub.js` 里清审批的判据是 `state.approval.callId === event.callId`，
改成无条件 `state.approval = null` 之后，`run-hub.test.mjs` 的 16 条断言**无一变红**（变异脚本只跑目标测试文件，所以这里说的是那 16 条、不是全量 —— 全量没跑过，不写成那个数）。
而真实运行里乱序返回很常见：c1 在等审批、c2 的结果先回来 ——
用户会看到弹窗自己消失，那次写操作**静默没执行**，且没有任何提示。
已补用例（`tests/run-hub.test.mjs`）：无关的 tool-result 不得清掉待批的那一条。

### 缺口 2：临界长度上"折叠"会让内容变长

`buildCollapsed` 的文案约 110 字，头 300 + 尾 150 + 通知 ≈ 560。
也就是说 **490～560 字**这段区间里，折叠的结果比原文更长。
`collapseOldToolResults` 里 `next.length >= m.content.length` 这条守卫原本没有用例覆盖，
删掉它测试全绿 —— 后果是每轮白白改写一次历史中部（前缀缓存从头失效），上下文一点没变小。
已补用例（`tests/context.test.mjs`，520 字临界样本）。

顺带记一个操作教训：变异脚本的 `expectFail` 是**按用例名做关键词匹配**的。
新补的用例名里如果没有那个关键词，即使它真的变红了，脚本也会判成"没抓住"。
这次就是先看到"✗ 允许折叠后反而变长"，查下去才发现是我给的用例名不含 `折叠后不再变长`。

---

# 轮 91：E2E 硬等待 9 → 2，并找出「54 条里总挂一条」的真正原因

## 先把两类"等待"分开

评审里说 E2E 的 `waitForTimeout` 是 flaky 头号来源，这话只对一半。必须分开看：

- **等某事发生** —— 有可轮询的信号，用 sleep 就是纯浪费 + 抖动；
- **等某事`不`发生**（负例断言）—— 天然"立刻成立"，`expect.poll` 在它面前没有意义，
  只能给一个观察窗口。

原先 9 处里 7 处属于前者，2 处属于后者。后者留着（并写明时间量级的出处），前者全部换掉：

| 原先在等什么 | 换成 | 为什么非换不可 |
| --- | --- | --- |
| "拒绝处理完"（2500ms） | `waitForRunEnd`：等 `.cmd-send` 恢复可用 | **假通过**：慢机器上副作用还没发生就断言"没发生" |
| 点了/滚了之后"什么都没发生"（200~400ms，4 处） | `settle`：双 rAF | 处理器在帧内同步跑完，两帧是"已派发/已布局"的最小可信边界 |
| "又来了一段增量"（500/800ms） | 轮询到下一段增量**真的出现** | 睡过头时流已结束，断言退化成"对空条件成立" |

棘轮 `CEILING` 10 → **2**。

## 那条"54 条里总有一条红"的 flaky：断言早于 run 结束

`golden: 富文本` 的判据里，`__rt.strong > 0` 在第 5 步成立，而 `list` / 装饰键计数 /
`selectAlls` 要到第 6/7/4 步才落地。原写法是 poll 到 `strong` 后**立刻**断言后面几条 ——
等于在 run 跑到一半时检查最终状态。失败信息是"装饰键没被点过"，而装饰键那一步明明在后面。

修法：先等这一轮**跑完**，再逐条断言。`-g` 重复跑 3 遍，3/3 绿。

**教训**：一个 `expect.poll` 成立 ≠ 这一次 run 做完了。分步推进的剧本里，
第一个成立的判据往往只是**中途**的证据。

## 同一个坑的反向形态：屏障等错了那次变化

`sessions` 那条"后续 delta 不得把用户展开的思考块收回"，我把 800ms 换成"等文本又变长"，
结果**稳定失败**：拿到的是 `data-state="done" / data-open="false"`。
因为**思考结束时块会被自动收回**，那一次文本变化正好就是"结束"。屏障于是变成
"等一个正确行为发生，然后把它判成 bug"。正确写法是"文本变了 **且** 仍在 running"。

这两条合起来是同一件事：**负例/不变量的屏障，必须精确描述"我要观察的那一段时间窗"**，
而不是"随便等一个变化"。

## 顺手挖出 `openPanel` 的一个 90 秒假死

第二次全量跑，红的是另一条（拾取元素）。日志里 FAB 是 `<button class="fab hidden">`
且 `click` 重试了 86 秒 —— 但错误截图里面板**开得好好的**。

原因是 helper 自己的竞态：reload 后 `syncPanelUiOnInit()` 会**异步**自动开面板。
若它正好落在 helper 的 `fab.isVisible() === true` 与 `locator.click()` 真正执行之间，
FAB 会被加上 `hidden`，而 `click()` **不会回头检查"面板是不是已经开了"**，
就对着一个永远不会再可见的按钮重试到动作超时。

修法：点击给 2s 短超时、失败也忽略，然后 `continue` 回循环顶部重新判断；
超时抛错时带上 shadow 内的真实结构（host/panel/fab 的 className 与尺寸），
让下一次红能直接看出是"面板开得慢"还是"根本没建"。

三次全量结果（都不是小事，按时间顺序）：
① 54 条 → 53 绿 + 富文本红；② 53 绿 + 拾取元素红；③ 修复后 **54/54 全绿**（单跑拾取元素 3/3 绿，
说明它是**顺序/状态相关**的，不是这条用例本身写错）。

## 轮 92：把「测试有没有引用过这个模块」变成可计算的事实

评审的头号发现是 `chat.js` 有 4900 行、12 个测试文件「提到」它却无人 import。
本轮把它变成一条**双向**门禁（`tests/module-references.test.mjs`）：

1. 从 `tests/**` 出发做静态 import 图 BFS（含 `import('…?case=N')` 的 query 剥离）；
2. 每个 `lib/**` 模块要么可达，要么在 `ALLOWED` 里**写明为什么不可能被测到**；
3. `ALLOWED` 里的条目一旦变得可达，必须删掉（清单只进不出就会腐烂）；
4. 被豁免的模块还必须在**生产代码**里找到引用 —— 「没有单测」可以接受，
   「产品都不 import 它」就是死代码，该删而不该进清单。

当前 93 个 lib 文件里 5 个豁免，理由都是结构性的（MAIN world 裸脚本、executeScript
按路径注入、只经 `background.js` 进入的 SW 依赖）。牙测试：临时塞一个
`lib/shared/__probe_orphan.js`，门禁立刻点名它。

顺带在 `assertion-quality` 里加了 `EXEMPT`：**被测对象是源码树本身**的门禁
（import 图分析）不该被「少读源码」的棘轮罚分 —— 但没有理由不许加。

全量：1753 项 / 150 文件全绿。

## 轮 93：中断不是「故障」—— 三层被吞掉的中断，以及变异脚本把源码改坏的那次回写

### 一、点「停止」之后，代码还在跑

`AbortError` 是**我们自己造的**信号，但 `llm.js` 把它当成了一次网络抖动：

```js
function isRetryableError(e) { /* 只按 message 抓 429 / 5xx / fetch failed */ }
```

`makeAbortError` 的 message 是「任务已取消」，匹配不上任何一条，于是……它恰好落在
`return false` 上，被当成**不可重试**。**但这不是设计，是巧合** —— 只要哪天有人往
可重试名单里加一条通配（`/失败|错误/`），中断就会立刻变成「重试 3 次」，每次 60 秒。
所以第一件事是把巧合变成不变量：`isRetryableError` 首行 `if (e.name === 'AbortError') return false;`。

第二层是「已经中断了还在发请求」。`callDeepSeekOnce` 里 signal 的 abort 监听是 fetch
**之后**才挂上的，如果 signal 在调用前就已经 aborted，监听永远等不到事件，请求照发，
然后等满 60 秒超时 —— 用户按了停止，还要再等一分钟。修法是在函数入口就检查
`signal.aborted`，直接抛中断。

第三层最隐蔽：失败路径不解绑。原来的写法是

```js
const timer = setTimeout(...);
signal.addEventListener('abort', abort);
const res = await fetch(...);   // ← 这里一抛，后面两行永远不执行
clearTimeout(timer);
signal.removeEventListener('abort', abort);
```

成功路径没事，**每次失败都漏一个监听器和一个计时器**。反复失败的长任务会攒下一串
挂在同一个 signal 上的闭包。改成 `try/finally` 包住 fetch。

### 二、`verifyCompletion` 把中断吞成了「没意见」

这是本轮最严重的一个，因为它**让状态说谎**：

```js
try { ... } catch (e) { return null; }   // null = fail-open = 「校验器不可用，按通过处理」
```

用户按停止 → 校验那次 LLM 调用被中断 → catch 吞掉 → 返回 `null` → agent 认为
「校验没意见」→ 继续收尾、`persist({ status: 'done' })`。**用户明明点了停止，任务被记成已完成。**
下次打开历史会话，看到的是一个绿勾，没有任何地方能追到「这次是被中断的」。

fail-open 的语义是对的：校验器挂了不该拦成任务失败。但它只该覆盖**故障**，
不该覆盖**用户意图**。所以 `verifyCompletion` 现在区分两者：`AbortError`（或 signal
已 aborted）原样抛出，其余异常仍然 `return null`。

在 `agent.js` 的调用点，把这段判断抽成纯函数，好让它可以被单测钉住：

```js
export function classifyVerifyOutcome(verdict, error) {
  if (error) {
    if (error.name === 'AbortError') return { kind: 'interrupt' };
    return { kind: 'fail-open' };
  }
  if (!verdict) return { kind: 'fail-open' };
  return { kind: 'verdict', verdict };
}
```

中断分支走 `persist({ status: run.status, phase: 'interrupted', reason: 'aborted-during-verify' })`
再 `return`。三个结局各有各的出口，不再共用一个 `null`。

`tests/llm-abort-retry.test.mjs` 8 条钉住这些：中断不可重试 / 已中断的 signal 不发请求 /
请求中被中断只发一次 / 真故障仍重试 / 校验中断必须抛出 / 真故障仍 fail-open /
失败路径必须解绑 signal / `classifyVerifyOutcome` 三态分派。

> 为什么「请求中被中断只发一次」要单独一条：它同时验证了「不重试」和「不发第二次」，
> 而这两件事由两处不同的代码保证。任何一处回归，这条都会红。

### 三、变异测试把源码改成了变异版本（真实事故）

跑 `mutation-check` 的 inplace 模式时，同时开了两个进程。时序是：

```
A: 备份 context.js → 写入变异版 → 跑测试
B: 备份 context.js（此时已是变异版！）→ 写入自己的变异版 → 跑测试
A: 还原（写回原始字节）→ 删除备份
B: 还原（写回**自己备份的变异版**）→ 删除备份
```

结果 `context.js` 和 `llm.js` 被永久留成了变异态。第二次是靠 `git checkout --` 救回来的，
但如果当时工作区有未提交的改动，那就是**直接丢工作**。

这类 bug 的可怕之处是它**只在并发时出现**，而变异测试恰恰是最容易被并行触发的东西
（本地开两个终端、CI 上矩阵展开）。两个独立修复：

1. **进程锁** `.mutation-lock.json`，记 pid 与启动时间；`acquireLock` 前先 `pidAlive(pid)`
   探测，占用则 `process.exit(3)`（退出码要和「有变异没被抓住」的 1 区分开，
   否则 CI 会把它误判成测试失败）。`process.on('exit')` 里释放，且**只删自己的锁**
   —— 否则 A 退出时会把 B 的锁删掉，锁就白加了。
2. **崩溃自愈** `recoverLeftovers`：上次进程被 kill -9 时备份还留在盘上。三种情况：
   - 源文件**仍含**变异文本 → 是残留的变异态，还原；
   - 源文件**已被改过**（不含变异文本）→ 有人手工动过，**不覆盖**，只清备份；
   - **没有 meta** → 不知道原来是什么，**不猜**，报警后跳过。

   「不覆盖人工改动」和「不猜」这两条是刻意的：自愈脚本最怕的就是把人的工作当成垃圾清掉。

`tests/mutation-guard.test.mjs` 8 条钉住锁与还原：干净时能拿到 / 同一 pid 可重入 /
被活进程占有时拒绝 / 陈旧锁（pid 已死）可抢 / 只删自己的锁 / 还原逐字节（含 CRLF）/
自愈三态各一条。

顺带把 `lib/assistant/llm.js`（3 条）与 `agent.js` 的 `classifyVerifyOutcome`（1 条）
加进变异目标。后者第一版写 `expectFail: '中断必须走中断收尾'` 抓不住 —— 变异测试
匹配的是**用例名**，不是断言消息里的关键词。改成 `'结局分派'` 才命中。

全量：**1769 项 / 152 文件全绿**（行为 123 + 静态门禁 29），变异 7 个文件全过。

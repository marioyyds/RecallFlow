# 优化评审：Agent 设计 + 自动化测试

> 评审对象：`master` @ `87cd66b`（2026-10-19）
> 范围：`lib/application/agent/**`（Agent 核心）、`tests/**`、`scripts/**`、`.github/workflows/checks.yml`
> 方法：全量通读 + 脚本实测交叉验证。**本文每条结论都带 `文件:行号` 或实测输出**，
> 其中 4 条 P0 已由我逐条亲手复核（不是转述）。
> 本文**只做分析，未改动任何源码**。

---

## 零、总评

这套代码的**工程纪律明显强于平均水平**——三件事做得很对，先说清楚，避免后面显得全是批评：

1. **门禁必须被强制运行**：`scripts/run-all-checks.mjs` 把「单测 + 3 道静态门禁 + 数字快照刷新」串成一条命令，并进了 CI。文件头注释写着「门禁只要不被强制运行，就等于不存在」——这句话是这套体系的灵魂。
2. **文档数字由脚本产出，不手写**：`tests/.test-count.json` + `scripts/test-count.mjs`，README 明确「手写的必然腐烂」。
3. **`tools.js` 从 2288 行巨型 switch 拆成注册表**，并用 `registry-fingerprint.test.mjs` 钉住「搬运必须不改变对外契约」。

正因如此，下面发现的问题才值得看：**它们都出现在"纪律覆盖不到的缝隙"里**——写得再规范，只要那条路径没有被任何一层真正执行到，就一定腐烂。这恰恰是 `docs/next-steps-handoff.md` 第 104 行自己承认的教训（「本 session 里有 4 次『代码看起来完成、实际从未执行到那一步』」）。

**当前实测规模**：单测 1670 项 / 141 文件，E2E 87 用例（真 Chromium），内置工具 45 个。

---

## 一、Agent 设计

### P0-1 并行工具调用是死代码（最重要的一条）

`lib/application/agent/agent.js:1091` 的 `runParallelBatch` **永远返回空 Map**，即并行从未真正执行过。

```js
// agent.js:1095-1096
const limit = Math.max(0, Math.min(calls.length, Number(o.remaining) || 0));
if (limit < 2) return precomputed;
```

实测证据：`grep -rn "remaining" lib/ tests/` 全仓**只命中 `agent.js:1095` 这一行**（其余命中全是 `lib/shared/screenshot-store.js` 的无关局部变量和文档里的 "remaining-work"）。而唯一调用点 `agent.js:1717-1730` 传入的 options 是
`{enabled, iter, callIds, disabledTools, settings, ctx, sessionApprovedTools, budget, signal, emit, emitState, trace}` —— **没有 `remaining`**。

于是 `Number(undefined) || 0 === 0` ⇒ `limit = 0` ⇒ `limit < 2` ⇒ 立即 return 空 Map。

**为什么这条最严重**：

- 系统提示**已经向模型承诺了并发**：`intent-router.js:475` 规则 12 —— 「请在**同一轮**里一并发出，不要一次一个地串行调用——**串行会成倍拉长耗时**」。模型的行为已经被这句话改变了（会一次吐多个 tool_call），但执行层仍然串行逐个跑。**承诺未兑现，且代价由用户承担**（耗时）。
- 代码注释（`agent.js:1088-1090`）写着「这是本仓库里第一处 Promise.all：在此之前，系统提示承诺的『一轮可以发出多个工具调用』从未被执行层兑现」——说明**作者是奔着修复它去写的，但漏了一个参数，而没有任何一层发现**。这正是"看起来完成了"的典型形态。
- `tests/parallel-tools.test.mjs` 只测了纯函数 `planParallelGroups`，**没有一行覆盖 `runParallelBatch`**。

**修法**（一行，且不需要设计决策）：`planParallelGroups` 内部已有 `maxBatch` 上限（`parallel-tools.js:21` `DEFAULT_MAX_BATCH = 4`，`:37` `Math.max(2, ...)`），所以外层这层 `remaining` 闸门是多余的：

```js
- const limit = Math.max(0, Math.min(calls.length, Number(o.remaining) || 0));
+ const limit = calls.length;   // 组内并发数由 planParallelGroups 的 maxBatch 控制
```

配套（缺一不可）：补一个「两个 `parallelSafe` 只读调用确实被并发执行」的集成断言——**只改代码不加断言，下次还会被人改回去**。

---

### P0-2 画像提升后，完成校验永久失效

`agent.js:2133` 的 LLM 完成校验门：

```js
// agent.js:542-548
export function shouldVerifyCompletion(intent, toolCallCount, settings) {
  ...
  return intent === INTENTS.BROWSER || intent === INTENTS.RESEARCH;
}
```

而 `intent` 是运行期常量。**画像提升（`promoteToResearch`，`agent.js:109`；触发点 `:1738-1741`）只换了 `tools` 与系统提示，不改 `intent`**。

后果：一个以「普通对话」(CHAT) 画像启动、中途因用到研究/网络类工具被提升为研究画像的 run，此后调用 `complete_task` 时 `intent` 仍是 `CHAT` ⇒ **永远不做 LLM 完成校验**。同理 `KNOWLEDGE` 意图（其白名单含 `complete_task`，`intent-router.js:118`）也从不校验。

修法：`shouldVerifyCompletion(promotedToResearch ? INTENTS.RESEARCH : intent, ...)`。

---

### P0-3 README 的"失败软着陆"声明与实现相反，且无门禁钉住

| 来源 | 说法 |
| --- | --- |
| `README.md:63` | 「只**摘除问题工具**并注入反思继续」 |
| `lib/application/agent/tool-guard.js:5` | 「守卫**绝不摘除工具**、绝不终止任务」 |

实现确实是后者（只注入建议，`level` 仅有 `ok` / `reflect`）。唯一的实际摘除点是资源触顶 `res.blocked === true`（`agent.js:1953-1958`）。

而 `tests/readme-claims.test.mjs` 的文件头**明确声明它不再校验声明、只校验链接**（`MUST_LINK` 三项）。也就是说：**这条错误声明目前没有任何一层能发现**。

> 建议：不是要恢复那张庞大的 `CLAIMS` 表，而是给这一条加一个最小锚点（`tool-guard.js` 导出一个 `GURAD_CAN_DISABLE_TOOLS = false` 常量，README 门禁断言 README 不含"摘除"字样或与之一致）。

---

### P1 反思机制：模板单一 + 阈值"精确跨越"导致静默

- `tool-guard.js:33-36` 阈值 `[3,5,8] / [2,3,5] / [3,5,8]`，`crosses()`（`:43-45`）是 **精确等于**才提醒；文件头自述「超过最高阈值后不再打扰」。
  ⇒ **重复 9 次以上彻底静默**。真正的兜底只剩 12 轮无进展看门狗（`agent.js:455-464`），而每轮都是一次完整模型请求。
- 全局仅 3 个反思模板（`verifier.js:84-99`、`claim-check.js:97-103`），**不区分**「重复调用 / 连续失败 / 无进展 / 确定性矛盾」四类成因，也没有随次数升级的梯度（第 2 次与第 1 次除 reason 外完全一样）。
- 确定性断言失败与 LLM 校验失败**共用** `verificationCount`（`agent.js:2117` / `:2152`），`maxVerifications: 2` 封顶后无条件放行。

建议：按 `decision.reason` 分派四类模板并递进（换工具 → 换定位策略 → 如实收尾）；`deterministicFails` 独立计数。

---

### P1 上下文管理：折叠只跑一次，且无重要性打分

- 触发 `historyTokens > 16000`（`agent.js:103`、`:1589-1598`）→ `collapseOldToolResults(messages, 6, 300)`（`context.js:296-314`），保留最近 6 条，其余折叠成「头 300 + 尾 150」。
- **折叠有 `COLLAPSE_MARK` 幂等标记**（`context.js:249,307`）⇒ 折叠完就没有第二轮减压；而 assistant/user/system 消息**完全不参与压缩**，历史可无限增长，唯一的界是 `maxTotalTokens: 6000000`。这会放大 P0-2 的成本风险。
- **丢弃纯按时间**：`context.js:301` `idx.slice(0, idx.length - keepFull)`。代码自己承认了中段丢失风险（`:285-291`「快照/页面读取类结果不进暂存 ⇒ 中段取不回原文」）。
- 现成的相关性逻辑没被复用：`evidence.js:91-213` 的 `selectEvidence` 只服务于完成校验，**没有用于决定保留哪些历史**。

---

### P1 阈值散落 + 事实上不可配置

已集中管理的做得不错（`AGENT_BUDGET_DEFAULTS` `agent.js:45-86`、trace 常量、guard 阈值）。但仍有大量散落：

| 常量 | 位置 |
| --- | --- |
| `CONTEXT_COLLAPSE_TOKENS = 16000` | `agent.js:103` |
| 折叠参数 `6 / 300 / 150`（与 `context.js:263` 默认值重复） | `agent.js:1592` |
| 证据预算 `3000 / 2000 / 1800` | `agent.js:518 / 532 / 551` |
| 大结果 spill `6000 / 3000` | `agent.js:2016-2022` |
| 收尾超时 `25000`、审批等待 `60000` | `agent.js:678 / 716` |
| 重试 `MAX_RETRIES=2`、退避 `500 * 2^n` | `agent.js:867 / 900,953` |
| persist 切片 `-60/-80/-40/0,20` | `agent.js:1491-1525` |

且 `maxNoProgressRounds` / `maxVerifications` / `CONTEXT_COLLAPSE_TOKENS` 只能经 `settings.agentBudget` 传入（`agent.js:135-151`），**`options.html` 无任何 UI 暴露** ⇒ 等于事实上的硬编码，`getBudget` 已支持，接上去成本很低。

---

### P1 审批策略位置错配 + 手写工具名单无门禁

- `toolNeedsApproval` 住在 `agent.js:395-435`，而 `tool-guard.js` 只管"循环提醒"。**两个文件的名字暗示了相反的职责**，这是最容易被后来者改错的地方。建议移到 `tool-metadata.js` 旁。
- `sensitive-action-policy.js:22-39` / `:42-64` 是**手写字符串数组**（16 + 21 个），不来自 `TOOL_REGISTRY`。

**我实测跑了一次双向 diff（基准 = `tool-metadata.js` 的 45 项）**：

```
WRITE_TOOLS 僵尸条目: []          ← 维护得很好，55→44 合并后确实同步更新了
SAFE 名单僵尸条目  : []
两个名单都没覆盖   : ['add_entry','remove_entry','scroll_page','trust_site',
                      'list_userscripts','search_userscripts','install_skill','save_skill']
```

**这里我要下调一个判断**：读完全文策略后发现，`WRITE_TOOLS` 实际只在 `ACCOUNT_SECURITY_RE` 一个分支里生效（`:175`），策略总纲是「默认允许，只有命中明确的支付/账号安全语义才 blocked」（`:112`）。所以那 8 个未分类工具的风险**比我初判的小**（它们不通往账号/资金动作）。但它仍然是**隐式耦合**：将来合并/改名工具，这里不会报错。

建议（低成本、纯加法）：加一条门禁断言 `WRITE_TOOLS ∪ SAFE_ON_SENSITIVE_PAGE ⊆ TOOL_REGISTRY`。

---

### P2 结构：三处值得拆的段落

| 文件 | 段落 | 建议 |
| --- | --- | --- |
| `agent.js` | `759-1079` `streamAgentStep`（321 行，SSE 解析 + 重试 + 400 诊断 + 三段计时混合） | 拆出 `llm-stream.js`；`readErrorDetail:788` / `isBodyParseRejection:815` 是纯函数，极易测 |
| `agent.js` | `1176-1528`（ctx/persist/emit 装配 350 行） | 拆 `run-context.js` |
| `skill-defs.js` | `29-57` 欠账清单 + `58-1847` 44 个技能正文同文件 | 按 `category` 拆，欠账清单独立 |

（`tools.js` 已在上一轮拆完，此处不重复。）

---

## 二、自动化测试

### P0-4 完全没有覆盖率采集

`grep -rn "coverage|NODE_V8_COVERAGE|c8|nyc" package.json .github/workflows/*.yml scripts/*.mjs` → **空**。

后果：1670 条用例**没有任何行/分支数据**，"哪些代码没人测"只能靠 grep 猜。下面这条空洞就是这么被发现的：

### P0-5 高风险模块零 `import` 覆盖（实测）

| 模块 | 行数 | 真 `import` 的测试文件数 |
| --- | --- | --- |
| `lib/ui/page/chat.js` | 4975 | **0** |
| `lib/backend/cdp.js` | 440 | **1** |
| `lib/ui/page/commands.js` | 2108 | 2 |
| `lib/application/agent/skill-defs.js` | 1847 | 5 |
| `lib/application/agent/agent.js` | 2220 | 12（其中多数是读源码做正则） |
| `lib/application/agent/tools.js` | 1253 | 20 ✅ |

`chat.js`（4975 行，DOM 渲染与面板编排）和 `cdp.js`（CDP 协议层）是**纯零 import**——恰恰是最难靠肉眼验证的两块。

### P0-6 没有统一 stub 层，12 个文件各自造轮子

- 根目录**无 `tests/helpers/` 或 `tests/fixtures/`**（子目录只有 e2e 三兄弟）。
- 各自造 `chrome.*`：12 个文件；各自造 `document`：4 个；`node:vm` 沙箱 / `indexedDB` stub 各 1 个。
- `chrome.storage.local` 的内存实现**至少被重写 4 次**（`session-store`、`trace-store`、`handoff-store`、`extension-collectors`），每次的异步时序、配额、事件通知行为都可能不一致 ⇒ **同一份业务代码在不同测试里表现出不同的假行为**。
- `package.json` devDeps 只有 `@playwright/test` + `esbuild`，无 jsdom/linkedom。

### 弱断言占比（需要正视，但不要一刀切否定）

实测：`grep -l "readFileSync" tests/*.test.mjs` → **69/136（51%）** 文件直接读源码文本；其中**完全不 import 任何 `../lib` 模块的纯静态文件 32 个 / 约 259 条用例（≈16%）**。断言类型分布：`assert.equal` 1959、`assert.ok` 1117、**`assert.match` 960**、`assert.deepEqual` 417、**`assert.throws` 仅 3**。

典型例子：

| 文件 | 断言内容 |
| --- | --- |
| `plan-bar-wiring.test.mjs:60` | `assert.match(src, /let planExpanded = null;/)` — 11 条全是对 `chat.js` 的正则 |
| `settings-defaults.test.mjs:13` | `assert.match(html, /placeholder="deepseek-flash"/)` |
| `vision-wiring.test.mjs:19` | `assert.match(AGENT, /import \{ visionMessagesFor \} from '\.\/vision\.js'/)` — 断言 import 语句存在 |
| `security-action-wiring.test.mjs:15` | 安全硬拦截只被**字符串**验证 |
| `docs-drift.test.mjs:30` | 断言文档含"状态更正"措辞 |

这类断言**不是没价值**——它们确实抓到过"静默失效"，且在这个仓库里是有意的设计。但代价是**重构脆弱**（改格式就红，改行为可能不红），且**不能替代行为验证**。
`assert.throws` 全仓仅 3 处，说明**异常与边界路径几乎没测**。

---

### P1 E2E：无重试 + 20 处硬等待

做得好的：`expect.poll` 用了 134 次（轮询而非固定等待）、`workers: 1` + `fullyParallel: false` 消除并发干扰、`trace: 'retain-on-failure'`、`run-e2e.mjs:94-114` 用 12 个阶段分进程跑。

缺口：

- **三份 playwright 配置全部没有 `retries`**（实测 `grep -n "retries" tests/*/playwright.config.mjs` → 空）。
- **`waitForTimeout` 硬等待 20 处**（`golden.spec.mjs` 7、`stream-scroll.spec.mjs` 7 等）。仓库已有 134 处 `expect.poll` 的正确范式，照抄即可。
- CI 只有 15 条 `@smoke`；完整 87 条与 eval 均不进 CI，也没有 nightly。

### P1 eval 结果不可机读 ⇒ 无法自动回归

`eval-real-model.mjs` 的判据设计其实很好——**不是模型打分也不是精确匹配，而是「页面状态判据 + 数据有没有交到模型手上」双断言**（`tests/e2e-eval/real-model.eval.mjs:246-250`），且与脚本化 E2E 共用同一套判据。

但：`grep -rn "writeFileSync|outputFile|baseline" scripts/eval-*.mjs tests/e2e-eval/*.mjs` → **无**。唯一记录是人工维护的 `docs/real-model-eval-log.md`。
⇒ **没有机器可读结果，就无法自动判断"这一轮比上一轮差了"**。建议输出 `tests/e2e-eval/results/<date>-<head>.json` + 一个 `--baseline` 对比脚本。

### P1 变异测试只覆盖 1 个文件

`scripts/mutation-check.mjs` 设计质量很高（5 个算子、防静默失效、已进 `checks.yml:28`，我实跑 5/5 全被抓住）。但 `const FILE = 'lib/page/debug-hook.js'`（`:14`）**硬编码单文件** ⇒ 相对 136 个测试文件覆盖率 ≈ 0.7%。建议改成数组配置，至少纳入 `lib/application/agent/agent.js`、`lib/shared/utils.js`、`lib/ui/page/markdown.js`（这三个有最多行为测试可被验证）。

### P2 其它

- **静态门禁型测试应单独计数**：32 个纯静态文件应显式归类（文件名 `.static.test.mjs` 或文件头 `@static`），让 `test-count.mjs` 同时报「行为用例 / 静态用例」两个数——避免"1670 条"给人虚假信心。
- **孤儿资产**：根目录 `mock_server.py` 全仓零引用（`grep` 仅命中它自己的注释）。
- **CI 补齐**：Node 版本矩阵（现仅 22）、依赖缓存、nightly 跑完整 E2E。
- **flaky 现状良好**：`test.only` 0 处、`test.todo` 0 处、`test.skip` 仅 3 处（在 `vision-messages.test.mjs`，有注释说明由其它测试兜底）。`Date.now` 依赖 30 处集中在 `cdp-timeout`(10)/`session-store`(8)/`trace-store`(4)，若不做时钟注入是潜在 flaky 源。

---

## 三、建议的执行顺序

| 序 | 项 | 为什么排这个位置 | 涉及文件 |
| --- | --- | --- | --- |
| 1 | **修并行死代码 + 补集成断言** | 一行修复，直接兑现系统提示已做出的承诺；无断言则下次还会退化 | `agent.js:1095` + 新断言 |
| 2 | **加覆盖率采集** | 没有它，"哪里没测到"永远是猜的，后续所有补测都是盲补 | `package.json` + CI |
| 3 | **修完成校验的意图门** | 一行，但影响"收尾是否可信" | `agent.js:2133` |
| 4 | **统一 stub 层** | 解锁后续所有模块的行为测试（`chat.js`/`cdp.js` 现在根本没法测） | 新建 `tests/helpers/chrome-stub.mjs` |
| 5 | **手写工具名单加门禁断言** | 纯加法，锁住 P1 里的隐式耦合 | 新断言 |
| 6 | **E2E 加 retries + 清硬等待** | 降 flaky，成本低 | 3 份 `playwright.config.mjs` |
| 7 | **读源码型测试单独计数** | 让"1670"这个数字重新变得可信 | `test-count.mjs` |
| 8 | 反思模板分派 / 折叠重要性打分 / 阈值集中 | 都是质量改进，非正确性 | `verifier.js` / `context.js` / 新建 `agent-budget.js` |

**第 1、2 项建议先做**：一个是"承诺未兑现"，一个是"看不见"。

---

## 四、复核命令

```powershell
# 1) 验证并行死代码（应只命中定义处那一行）
grep -rn "remaining" lib/ --include=*.js

# 2) 验证测试数与门禁
node scripts/run-all-checks.mjs

# 3) 验证高风险模块零覆盖
grep -rl "page/chat.js\|backend/cdp.js" tests/ --include=*.mjs

# 4) 验证 E2E 无重试
grep -n "retries" tests/e2e/playwright.config.mjs tests/e2e-live/playwright.config.mjs
```

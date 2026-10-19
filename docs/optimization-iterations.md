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

## 结果

| 指标 | 起点 | 现在 |
| --- | --- | --- |
| 单元测试 | 1670 项 / 141 文件 | **1727 项 / 148 文件**（行为 121 + 静态 27） |
| 变异测试 | 1 文件 / 5 算子 | **2 文件 / 10 算子**，10/10 被抓住 |
| 覆盖率采集 | 无 | 有（见下方**口径警告**） |
| E2E 重试 | 三份配置均无 | CI 2 次 / 本地 0 / eval 0 |
| CI | 2 job | 3 job（+ 夜间全量 E2E）+ 依赖缓存 + 结构门禁 |

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

## 没做完的（按优先级）

- `lib/page/chat.js`（4975 行）仍是**零加载** —— 需要 DOM 桩，是本轮没啃下来的最大空洞。
- 上下文折叠的「只跑一次 + 无重要性打分」（P1，需改生产逻辑，风险较高）。
- 阈值散落 → 集中到 `agent-budget.js`（P1，纯重构）。
- `toolNeedsApproval` 从 `agent.js` 归位到 `tool-metadata.js`（P1，名字与职责错配）。
- E2E 里 20 处 `waitForTimeout` 逐个换成 `expect.poll`（棘轮已就位，逐个减）。

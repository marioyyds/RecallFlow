# RecallFlow × WebArena 评测

把 WebArena 的任务交给 RecallFlow 的**真 agent** 在真浏览器里跑，产出 WebArena-Verified
可离线评分的产物。它补的是本仓库自己点名的最大缺口：**有上千项单测，却没有"这个任务做成了吗"的度量**。

> 定位：这是 harness 级的外部基准，**不是** `docs/capability-inventory.md` 那套能力 E2E 的替代。
> 后者证明"能力存在"，WebArena 证明"任务能端到端做成"。两者互补。

## 为什么用 WebArena-Verified（而不是原版 / 其它）

| 候选 | 结论 |
| --- | --- |
| **WebArena-Verified** | 812 条人工校订任务 + **258 条 hard 子集**；评测改为**网络 trace 离线复算**（HAR），不依赖 DOM、无 LLM-as-judge。**推荐**，也最省重跑成本。 |
| WebArena（原版） | 812 条，评测脚本化校验站点状态；可用，但要跑 BrowserGym 那套 runner，与本扩展的驱动方式不匹配。 |
| WebArena-Lite | hard 子集的早期形态，可作成本更低的冒烟。 |
| Mind2Web | 离线、无交互，**测不了**这个扩展（它的价值恰恰在真交互）。 |
| WebVoyager | 活网站、不可复现，不能做回归。 |

## 产物与评分口径

每条任务产生一个目录（`--out`）：

```
agent_response_<id>.json   FinalAgentResponse（规范键 task_type/status/retrieved_data/error_details）
har_<id>.har               网络 trace（WebArena-Verified 的 NetworkEventEvaluator 读它）
recallflow_<id>.json       RecallFlow 原始 job 终态（state/答复/事件），用于归因
summary.json               本轮汇总
```

RecallFlow 交回的是**自然语言答复**，WebArena-Verified 要的是**结构化终态**。
两者之间由 `lib/eval/webarena-adapter.mjs` 翻译：

- **发指令时**就把终态契约写进指令（要求模型在答复最后吐一个 ```json 块），
  契约见 `buildInstruction`。
- **收答复时**取**最后一个**可解析的 JSON 块（模型常先举例再给结论），
  读不出就如实记 `UNKNOWN_ERROR`，**绝不**把自由文本挽尊成成功。
- 结果再做一遍 schema 校验（数组同类型、对象键一致、成功不得带 error_details…）。

## 怎么跑

```bash
# 1) 只校验任务 + 看将发出的指令与终态契约（不需要 key / 浏览器）
node scripts/run-webarena.mjs --tasks integrations/webarena/sample-tasks.json --dry-run

# 2) 实跑（需：真浏览器 + 已装扩展 + 扩展设置里配了 API Key；WebArena 站点已在本地起）
RECALLFLOW_EVAL_API_KEY=sk-xxx node scripts/run-webarena.mjs \
  --tasks my-tasks.json --out webarena-out --limit 5
```

任务文件格式即 WebArena-Verified 的任务 JSON（裸数组或 `{ "tasks": [...] }`）。
`start_urls` 里的 `__SHOPPING__` / `__GITLAB__` 等占位符需替换成你本地站点的真实地址。

## 已知边界（诚实记录）

- **必须 headed**：headless 下 MV3 扩展的 service worker 不注册（见 `tests/e2e/playwright.config.mjs`）。CI 用 `xvfb-run`。
- **审批**：桥接场景没有面板可点同意。写操作靠 `agent_task` 的声明式 `allowRisk` 放行；
  `high`（`run_javascript` / 用户脚本 / 上传本地文件）**任何声明都换不到** —— 需要这些动作的任务做不了。
- **状态隔离**：RecallFlow 的记忆（知识库 / 站点记忆 / 技能 / 会话）落 `chrome.storage`。
  本评测**每条任务清空存储并新建 profile**（见 `harness.mjs`），否则分数不可复现、无法归因。
- **覆盖面错位**：WebArena 是英文、标准 HTML 的自建站，**测不到**本扩展最值钱的能力
  （跨域 iframe / Shadow DOM / canvas 坐标点击 / CDP 可信事件 / 视觉 / 中文站）。要用它当通用任务成功率，
  别指望它证明差异化。
- **成本与方差**：812 条很贵，先跑 hard 子集；同一配置多次跑结果会抖（见 `docs/agent-cost-quality-evaluation.md`），
  单次数字没有意义，要报分布。

# tracegraph.v2 实现状态

## 开关与回滚

设置对象为 `aiSettings.traceGraph`：

```ts
{
  enabled: false,
  mode: 'record',
  shadowMode: true,
  ttlMs: 30 * 60 * 1000
}
```

- `enabled:false`：不录制、不读取图，原 JEV/慢思考路径保持不变。
- `mode:"record"`：只录制结构化前后证据并增量构图。
- `mode:"live"` + `shadowMode:false`：JEV 在 edge head 选边或弃权；选边后在
  当前快照重新解析语义目标并使用当前 ref，然后直接执行。edge 快路径不再运行
  R3、φ⁻、逐次审批或 φ⁺ 验证。
- `mode:"live"` + `shadowMode:true`：只记录 edge 决策，不产生动作；不能据此
  宣称节省或准确率收益。

一键回滚：把 `traceGraph.enabled` 设为 `false`。图数据留在
`chrome.storage.local` 的 `recallflow.tracegraph.v2`，可在后续重新开启读取。

## 设置页可视化

「设置 → 轨迹复用」内置可交互图编辑器：

- 按站点 origin 切换图；
- 展示状态模板、可执行边、原始记录数和更新时间；
- 点击状态节点高亮相邻边，并展示工具、目标、风险、slot 和参数模板；
- Canvas 渲染替代 SVG；图会按画布尺寸自动缩放并居中，拖拽背景平移、滚轮缩放；
  节点和边都可直接拖动调整布局，模态提供
  `缩小 / 居中 / 放大 / 当前倍率` 控件；
- 未验证边使用虚线；图不再因 TTL 过期而失效，所有本地保存的图都可读取和提名；
- 支持删除整站图、单条边，或删除节点及其全部关联边；对应录制证据同步移除；
- 刷新按钮和 `chrome.storage` 变更会更新视图。

可视化只操作已经脱敏的本地图数据，不执行边。拖动布局只是查看态，不写回图数据；
删除操作会持久化到 `chrome.storage.local`。

## 测试入口

```bash
node --test tests/tracegraph/*.test.mjs
node scripts/r3-replay-eval.mjs --cases=13 --defects=6
node scripts/eval-jev-real.mjs --head=edge --grid
```

前两条是离线分析；R3/φ 函数保留用于历史回放与诊断，但不再进入 live edge
controller。第三条需要 `TYPESAFE_API_KEY`，没有真实请求时不得把网格推荐值
写成实测结论。

## 2026-11-12 候选分层与逐边证据

live edge 的置信度实测落在 0.3–0.5，且候选数 >5。归因不是门限，而是题面：
候选按 URL 名混桶，边只带「工具 + 按钮文字」，而规则要求「前置条件可观察」，
请求里却没有逐边前置条件。本轮的改动只影响提名与题面，不动 `minEdgeConfidence`：

- `Edge.fromSignatures`（≤8，非身份）与 `Edge.purpose`（≤3，非身份）随录制写入；
  `mergeEdges` 合并同身份边时取并集，最新计划步在前。
- `matchCandidate()` 产出 `full / static / name` 三层，并且只做结构判断。
  `name` 档永远回退到旧行为（只有状态名一致）。
- `runTraceGraphOnce` 按 `full → static → name`、再按 `verifiedAt` 排序，
  仍**不截断**；层级与计数进 `tracegraph-candidates` 的 `levels`。
- `buildJevEdgeRequest` 的 criteria 新增四项：结构匹配、用途（录制时的计划步）、
  前置（逐条 φ⁻ 在当前 observation 上求值，只给 ✓/✗/待定）、效果（φ⁺ 的脱敏摘要）。
  这些是证据，不是执行门；φ⁻ 仍不参与许可。
- ABSTAIN 的规则改为「全部停在 name 档或某条边前置被明确否定」，删除
  「前置不可观察就弃权」这句自相矛盾的规则。
- `selectCandidatesByTier()`：只有存在 `full` 匹配时才只发 `full`，否则保留全部候选。
  依据真实图（editor.csdn.net，80 条记录）：`MdPage` 名下 10 条边来自 16 个不同签名，
  按签名回放 12/16 有 `full`（11 个恰好 1 条，1 个有 3 条并行动作），4 个没有 `full`
  （多为加载中 / 未就绪的观测）。裁剪后中位候选数从 10 降到 1，结构没见过的页面
  仍保留全部候选（不会凭空制造 no-candidates）。

实测里还有一条负面信号：那 80 条记录 **planStep 全为空**（慢模型没有调用
`update_plan`），所以 `purpose` 在这份数据上不起作用——它需要有计划纪律才有信号。
同一份数据里真正存在的判别信息是语义锚点、前置与效果。

- handoff 文案：写给慢模型的 system 消息改为「内部提示 · 非页面故障」，并按 reason
  给一句解释；emit 仍保留 `reason` id 供排障。起因是 RF-XKJ4M7：模型把
  「【JEV 快路径已停止】…没有可用的已验证证据边」读成「页面刚打开可能还在加载」，
  于是多拍一次快照、多写了 108–282 字推理。让位原因绝大多数与页面无关。
- 状态名归一：末段为纯数字 / 长 hex / UUID 时剥掉，退回稳定的父级模板（保留两级）。
  `/article/details/170567085` 从 `170567085Page` 变成 `ArticleDetailsPage`，帖子与
  商品页可跨实例复用；稳定末段（`/editor`、`/foo/bar`）行为不变。
- `mergeEdges` 改为**只从当前记录重建**，prev 仅按同一 id 继承元数据：记录被 80 条
  上限挤掉、或状态名改版后不再由任何记录推导的边，一律回收。此前是「prev 打底 + 只加
  不删」，实测 slug 改名后同一记录长出旧名与新名两条边。
- 状态名大小写归一：`/chinaflights/ShowFareFirst` 与 `/chinaflights/showfarefirst`
  不再拆成两个状态。
- 录制归桶按 `record.before.url` 的 origin：跨站跳转（mp 成功页 → blog 文章页）不再
  因为 `ctx.pageUrl` 已切到新站而记进错误的站点槽位。
- 无名字目标：带位置伪类（`nth-of-type` 等）的 selector 不立边；其余 selector 只在能
  读出稳定属性（data-* / #id / .class）时立边，并把 `selector:<hint>` 作为 `g`。
  记录保留，审计可见。
- 让位分级（2026-11-12 快慢配合）：只有 `edge-abstain` / `edge-low-confidence` /
  `edge-invalid-answer` / `model-blocked` 做**路由级**冷却（等 fingerprint 或计划变化）；
  `request-failed` / `observation-failed` 按 30 秒恢复；`edge-no-candidates` /
  `edge-target-missing` 不做路由冷却 —— 慢思考动过一步后快路可以再试，这就是
  teach-then-retry 的入口。冷却期内连快照都不拍。
- 同一路由、同一原因、慢思考还没动过两步时，让位提示不再重复 push 进模型上下文
  （trace 记 `repeatedNotice`，UI 与计数照常），避免上下文被重复提示挤占。
- 委托动作（P1，slow 决定做什么 / fast 决定在哪做）：`PlanStep.nextAction` 支持
  `click_element` / `press_key` / `open_tab`，必须带 `name|text|selector`（press_key
  另需 `key`，open_tab 另需 `url`）。没有候选边时快路先尝试委托：当前快照唯一解析目标
  → 普通审批（**不** skip）→ 执行一次 → 重新观察，全程不调 JEV。执行一次即清空；
  `allowedOperations` 不含 CLICK 时不消费。白名单刻意不含 `type_text`/`select_option`：
  内容值只能来自当前指令的显式槽位。
- lane 记账：`TraceRecord.lane`（fast / slow）由工具管线写入，导出与
  `tracegraph-bucket-report.mjs` 会按站点输出 fast / slow / unknown —— 有了它才能量化
  「快慢比例」与委托动作省下的慢回合。
- open_tab 收敛：`opensCurrentUrl()` 跳过指向当前 URL 的 no-op 导航；同一状态已有
  `full` 页内动作时 open_tab 候选让位（`prunedNavigation`）；open_tab 执行后若快照为空
  元素，补拍一次（300ms，仅一次，`tracegraph-settle`），避免把导航后的未挂载误判成
  「没有可复用证据」。

## 2026-11-12 快慢分工：按动作类别，而不是按“有没有边”

真实轨迹（7 个站点、194 条记录）里 fast 沉的 83 条记录只有 1 条是动作，其余全是
`get_page_snapshot`：快路在无候选边时直接 handoff，而真正能执行页内点击的 JEV
operation 路径被 edge 分支整个跳过了。据此改成两层快路 + 一条慢路：

- **快路 A（edge）**：有已验证边时免 JEV 直接执行。候选只保留 `FAST_EDGE_TOOLS`
  （click_element / scroll_page / wait_for_element）；`type_text`、`select_option`、
  `check_box`、`press_key`、`open_tab` 即使有边也不进快路候选（计数 `filteredSlowTools`）。
- **快路 B（operation 回退）**：无候选边且无委托时调用 `runOperationOnce`（就是原来的
  JEV operation 路径：CLICK / SCROLL_* / READ_* / WAIT），每个动作一次 systemone，
  但省掉一轮慢模型 prefill。trace 标 `fallback: true`。
- **慢路**：文本输入（值只能来自当前指令）、导航（open_tab / switch_tab）、
  `run_javascript` / `click_at` 等不可锚定动作。
- **shadow 统一**：traceGraph 开启时，edge 与 operation 回退都按 `traceGraph.shadowMode`
  执行；`jev.shadowMode` 只对 traceGraph 未开启的旧 operation-only 模式生效，避免
  「traceGraph live 但回退只做影子」的静默不一致。
- **skill 契约**：SKILL.md 可声明 `x-recallflow-fast-actions`（PLAN_FAST_OPERATIONS
  枚举）与 `x-recallflow-slow-actions`（工具名）；`load_skill` 会把分工写回给模型，
  提示它在 `update_plan` 里写进 `allowedOperations`。
- **度量**：`tracegraph-bucket-report` 按动作类别拆成 `act fast/slow`、
  `observe fast/slow`、`other fast/slow`，不再把观察记录和动作记录混成一个数。

## 2026-11-12 快路安全：语义风险与审批

CSDN 发布轨迹暴露了一个必须修的事故面：`click_element 「发布文章」` 被录成了
`r = low`（风险取自工具元数据，而 `click_element` 恒为 low），而 edge 快路执行时
`skipApproval: true` —— 只要 JEV 选中这条边，发布会绕过审批。修复：

- `action-risk.ts` 统一语义风险词表（发布/删除/支付/提交/发送/关闭…），录制时
  `semanticEdgeRisk(tool, label)` 把命中目标的 click 升为 `high`，`edge.r` 与
  `edge.action.risk` 同时写入；operation 路径也复用同一词表。
- 快路候选双重过滤：`FAST_EDGE_TOOLS`（工具类别）→ 再排除 `r === 'high'` 或
  `g` 命中风险词的边，计数 `filteredRiskyEdges`。这类边只留给慢思考 + 审批。
- 执行兜底：即使旧图里发布边仍是 low，选中后也会在 `processTool` 前以
  `edge-high-risk` 交回慢思考，绝不 `skipApproval` 执行。
- 委托可达性：`update_plan` 结果里，若 in_progress 步骤缺 `nextAction`，直接附一条
  提示与示例；系统提示中的 nextAction 示例改为具体控件名，并明确只放
  click_element / press_key。

## 2026-11-12 尝试闸门：只读回合不唤醒快路

CSDN 发布跑了 31 次快路尝试，实际改变页面的慢动作只有 12 次（6 点击 + 3 输入 +
3 按键）；机票调研那次 17 次尝试对应 0 个动作。原因是每次慢回合都会触发一次
「拍快照 → 回退 → JEV」，而慢回合里大量是读页面。

`JevFastController.attemptGateReason()` 在冷却检查之后、拍照之前判定：

- 上一次让位之后，慢思考**只做了只读工具**（观察、读取、检索、截图）→ 直接
  `skipped: no-page-change`，不拍快照、不调 systemone；trace 记 `jev-skip`。
- 放行条件：计划里出现了 `nextAction`（委托本身就是执行信号）、URL 变化、
  或让位之后跑过任一非只读工具（点击/输入/按键/滚动/切页/JS…）。
- 注意：**不用 fingerprint 变化当放行条件**——读页面本身就会让指纹变（工具栏、
  时间戳），那正是 CSDN 里冷却反复失效的原因。
- 重新规划（`planVersion` 变化）会清空闸门状态，避免新计划被旧证据挡住。

- 目标预过滤：绑定与分层之后，在发请求**之前**用 `groundEdgeAction` 在当前快照
  解析目标；定位不到的边本轮跳过（**不封边**：菜单/面板瞬时收起不该把边永久拉黑），
  计入 `filteredTargetMissing`，handoff 记为 `edge-target-missing`，一次 systemone 都不花。
  同一份图里 `MdPage` 的 10 条边，唯一目标可定位的候选数中位数为 2（最大 7）；
  4 个未就绪签名在这一步清空。
- 反向实验（**没有采用**）：忽略 `capability:scrollContainers` 这类瞬态原子做去抖，
  16 个签名收敛到 14、平均 full 从 0.88 涨到 1.25，但**没有多覆盖任何签名**
  （zero 仍是 4），只是给已有签名增加平行候选。那 4 个 zero 是「从未在该结构下
  录过动作」，不是签名分裂；去抖只放大歧义，所以没有落。

验证入口：

```bash
node --test tests/tracegraph/*.test.mjs
node scripts/tracegraph-bucket-report.mjs --graph <导出的图 JSON>
```

前者覆盖 `matchCandidate` 三档、证据渲染不泄露录制值、以及 `purpose` 不进身份。
后者按状态名统计「不同 fromSignatures 数」与同态两两 Jaccard，用来判定低置信
来自混桶还是同态多动作。

## P4 状态

Patcher 白名单已实现。`macro(op=run)` 尚未切换到 edge 引擎：规格要求先完成
live A/B 并满足 go/no-go（尤其错写为 0、慢思考下降 ≥50%）。当前没有真实
基线，因此保留原宏回放路径，避免把未验收的图决策变成批量执行入口。

## 2026-11-10 live 灰度后的优化

- edge 身份不再包含 PlanCard 文案；相同目标在不同计划措辞下会合并。
- edge 身份也不再包含单次执行的后置条件和参数模板值；同起止状态、同工具、
  同语义目标的重复动作会合并为一条边，不同目标仍保持为平行边。
- 动作录制新增真实 `target`：控件 role/name/selector，或 `open_tab` 的 URL pattern。
- 旧 edge 在读取/设置页打开时从保留 records 重建；工具名相同但目标不同的动作
  保留为平行边，并显示目标摘要。
- edge 快路径新增当前快照 Grounding：按 role/name 唯一匹配目标并使用当前 ref；
  目标缺失、歧义、隐藏、禁用或语义不符时交回慢思考。
- live edge 执行不再使用 R3、φ⁻、逐次审批或 φ⁺ 验证；JEV 选边并通过 Grounding
  后直接执行。
- 状态名和 URL pattern 改为应用级模板，不再按商品 slug / 帖子 slug 分裂。
- 槽位只从当前指令的 `@slot=value`、围栏 JSON `slots` 或显式上下文读取。
- 不可显式绑定的边在提名后、JEV 请求前被剔除。
- edge question 增加当前 PlanCard 子目标、成功谓词和实时 controls/counters/dialog，
  不再注入 φ⁻ 门禁。
- 设置页移除旧的读取 / 输入 / 点击 / 等待 / 目标分支阈值，统一为
  `minEdgeConfidence`（默认 `0.80`）；它是 edge 选边或弃权的唯一 confidence
  门限。
- 以上改动在 r3-v3 中将候选推进到 67 次可绑定状态，但 JEV 仍全部弃权，故 live
  go/no-go 仍为 no-go。

## 2026-11-11 去掉 nominate 打分与 ≤3 上限

- `trace-graph.ts` 的 `nominate()`（词项重合打分 + 排序 + `slice(0,3)`）连同它专用的
  `terms()`、`MAX_EDGE_CANDIDATES` 一起删除，替换为 `candidateEdges()`：只按 siteKey、
  状态模板名、`status === 'verified'` 与本次运行的 `blockedEdgeIds / executedEdges` 过滤，
  不排序、不截断、不做意图匹配。
- `jev-controller.ts` 的候选构造改为调用 `candidateEdges()`，并保留「JEV 请求前剔除
  槽位不可绑定的边」这一步；`tracegraph-candidates`/`tracegraph-metrics` 事件的
  `nominated` 字段含义随之变为「该状态全部已验证边数」。
- `jev-action-space.ts` 的 `buildJevEdgeRequest` 不再 `slice(0, 3)`，choice 题的
  `criteria` 会对全部候选边各出一条。
- 代价：候选数不再受控，上下文与歧义随图规模上升。`docs/tracegraph.v2.md` §1.4 记录的
  「放开候选上限 handoff 7→26、复用边 82→26」现在就是默认档位 —— 收益与
  `minEdgeConfidence` 都必须按新基线重扫，未重扫前不得引用旧的 104→52→36 三档结论。

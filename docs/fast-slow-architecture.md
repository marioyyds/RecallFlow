# 快慢思考系统架构（当前实现）

> 一句话：**慢思考决定「做什么」，快思考决定「在哪做、并执行」；谁先动由协调器唯一裁决。**
> 本文是当前代码的事实对照，改实现时先改这里。

## 1. 分层组件图

```mermaid
flowchart TB
  subgraph ENTRY["入口与编排（agent-loop）"]
    A["每轮迭代<br/>预算 / liveness 检查"] --> B{"decideAutoFast<br/>协调器"}
    B -- "计划只读 / 无契约" --> S["慢泳道<br/>streamAgentStep"]
    B -- "eligible" --> F["快泳道<br/>JevFastController.runAvailable"]
  end

  subgraph GATE["快路闸门（顺序即优先级）"]
    F --> G1["canAttempt<br/>开关 / 凭据 / 预算 / 租约"]
    G1 --> G2["handoffStreak ≥ 2<br/>同站点空转封顶"]
    G2 --> G3["routeCooldown<br/>同路由同原因冷却"]
    G3 --> G4["attemptGate<br/>页面是否真的变过"]
  end

  subgraph FAST["快路决策（runOnce，最多 maxActions 次）"]
    G4 --> H{"traceGraph<br/>enabled + live?"}
    H -- "是" --> E["边路径：loadGraph → 候选<br/>过滤 → 绑定 → 分级 → grounding"]
    H -- "否" --> OP["operation 路径<br/>CLICK / READ / SCROLL / WAIT"]
    E -- "候选为空" --> D["委托 nextAction<br/>慢模型点好名字的动作"]
    E -- "abstain / 低置信（每路由一次）" --> OP
    E -- "JEV 选中边" --> EX["processTool<br/>skipApproval"]
    D --> EX
    OP -- "JEV 选中操作" --> EX
  end

  subgraph SUP["执行后监督"]
    EX --> V["observeAfterAction<br/>+ verifyContract"]
    V -- "mismatch" --> X["封边 / 让位<br/>handoffExplanation 写回"]
    V -- "verified / unknown" --> P["noteActionProgress<br/>清零 handoffStreak"]
  end

  S --> T["工具批：审批 → 执行 → 结果入会话<br/>update_plan 触发 planVersion++"]
  X --> T
  P --> T
  T --> A
```

## 2. 边路径的候选漏斗

```mermaid
flowchart LR
  A["observePage<br/>快照 = 证据"] --> B["candidateEdges<br/>同状态签名 / 排除 blocked+executed"]
  B --> C["① 工具过滤<br/>只留 click / scroll / wait"]
  C --> D["② 风险过滤<br/>r=high 或发布/删除/支付语义"]
  D --> E["③ 提示文案过滤<br/>isHintTargetLabel"]
  E --> F["④ 绑定槽位<br/>bindSlots（缺值即出局）"]
  F --> G["⑤ 分级选代表<br/>full > partial > weak"]
  G --> H["⑥ grounding<br/>目标在当前 DOM 可定位？"]
  H -- "否" --> H1["拒绝该候选<br/>不封边，下轮可再试"]
  H -- "是" --> I["JEV 选边<br/>阈值 minEdgeConfidence"]
  I -- "EDGE" --> J["白名单 → 高风险复核 → 环路检测"]
  I -- "BLOCKED abstain" --> K["operation 回退<br/>同一路由只补一次"]
  J --> L["执行 + 观察 + 契约核对"]
  K --> M["operation 决策<br/>阈值 minTargetOperationConfidence"]
```

漏斗每一段都有 trace 计数（`tracegraph-candidates`：`nominated / filteredSlowTools /
filteredRiskyEdges / filteredHintEdges / filteredUnbound / prunedByFull /
filteredTargetMissing / filteredNoopNavigation / prunedNavigation`），排查时直接看这一段。

## 3. 一轮的时序

```mermaid
sequenceDiagram
  participant L as agent-loop
  participant C as 协调器
  participant J as JevFastController
  participant G as tracegraph
  participant S1 as systemone
  participant P as 页面工具
  participant M as 慢模型

  L->>C: decideAutoFast(plan, eligibility)
  C-->>L: plan-slow-only / plan-no-verify / ready
  alt ready
    L->>J: runAvailable(iter)
    J->>P: observePage（快照）
    J->>G: loadGraph + candidates
    J->>S1: 边决策（带阈值）
    S1-->>J: EDGE / BLOCKED(abstain)
    J->>P: processTool(skipApproval)
    J->>P: observeAfterAction
    J->>J: verifyContract（advisory）
    J-->>L: act / skipped(reason)
  end
  L->>M: streamAgentStep（拿计划与工具调用）
  M-->>L: tool calls
  L->>P: 工具批（含审批）
  P-->>L: 结果写回会话
  Note over L: update_plan → planVersion++ → 租约与计数重置
```

## 4. 闸门与计数

| 闸门 | 判定位置 | 作用 | 默认/取值 |
|---|---|---|---|
| 计划只读 | `coordinator.decideAutoFast` | `allowedOperations: []` 时快路整轮不启动 | 计划字段 |
| 无动作契约 | 同上 | 点击类无 verify 且非只读集合 → 不给快路 | `plan-no-verify` |
| 开关/凭据 | `canAttempt` | enabled、非 CHAT、apiKey/model/baseUrl | 设置 |
| 计划租约 | `canAttempt` | `leaseActions` 用尽即停 | 计划字段 |
| 尝试上限 | `canAttempt` | 每 run 快路尝试次数 | 36 |
| 连续动作 | `canAttempt` | 快路连续执行数 | 12 |
| 连续失败 | `canAttempt` | ≥2 次失败即停 | 2 |
| 工具推进 | `canAttempt` | 上轮之后工具数没涨就不再试 | 防止空转 |
| 站点空转 | `autoFastEligibility` / `runAvailable` | 同 host 连续 2 次无动作 → `handoff-streak` | 2 |
| 路由冷却 | 同上 | 同 url+fingerprint 同原因的失败在冷却内不再试 | 见 `ROUTE_COOLDOWN_REASONS` |
| 页面变化 | `attemptGateReason` | 上次让位后只做了只读工具 → `no-page-change` | — |
| 动作环路 | `wouldCycle` / `noteActionProgress` | 最近动作序列回环、同签名无进展 | 2 次 |

## 5. 让位原因与用户可见解释

`handoffExplanation` 负责把 trace 里的原因翻译成人话（面板与诊断日志都引用它）：

| reason | 含义 |
|---|---|
| `edge-no-candidates` | 该状态下没有可复用的边 |
| `edge-target-missing` | 目标元素当前不在快照里 |
| `edge-abstain` / `edge-low-confidence` | 模型没把握，主动让位 |
| `edge-hint-label` | 命中的是提示/前置条件文案，不是可点按钮 |
| `edge-high-risk` | 发布/删除/支付类动作，必须慢思考确认 |
| `duplicate-read` | 同一页刚读过，再读没有新信息 |
| `action-mismatch` | 动作执行了，但契约核对不通过 |
| `no-page-change` | 页面没变，再试只会付一次 observe + systemone |
| `handoff-streak` | 本站点已经连续空转 2 次 |

## 6. 动作契约（verify）

| 契约 | 通过条件 |
|---|---|
| `urlChanged` | URL 变化 |
| `fingerprintChanged` | 页面指纹变化（点击类默认） |
| `minElementDelta` | 元素数变化 ≥ N |
| `textIncludes` | 页面文本包含目标串 |

校验失败的处理是**劝告式**的：记为 `verify` 警告，不撤回动作、不阻断
`complete_task`；快路的 `mismatch` 才会封边/让位（因为那是快路自己的动作）。

## 7. 已知边界

- 快路不判断「任务是否完成」：`DONE` 只作让位信号，收尾永远由慢思考 + verifier 决定。
- 快路不做跨页战略：`open_tab` / `switch_tab` 仅接受慢模型显式委托，且受导航预算约束。
- 快路不生成字段值：`TYPE_TEXT` 不在 operation 空间，写入只来自慢思考回合或计划槽位。
- 阈值是 JEV 自报置信度的**后置过滤**，不是授权；提高阈值只会更少动作，不会更准。
- 组织/统计口径：`tracegraph-metrics` 与 `jev-decision` 是唯一可信计数来源。
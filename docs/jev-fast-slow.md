# JEV 快慢思考集成

## 定位

RecallFlow 使用 TypeSafe 的远程 JEV 作为浏览器内循环控制器，而不是每一步执行前的“是否移交”分类器。

- `POST /v1/systemone`：一次请求评估当前页面的 operation 和所有 operation-specific target head。
- `GET /v1/models`：列出当前凭据可用的模型。
- JEV 不生成聊天回复，也不生成字段文本。
- 研究、规划、正文生成和最终验证由慢思考负责。

实现参考 `browser-use/jev-ultrafast` 的 operation + target、speculative fan-out 和确定性页面守卫。

## 快慢分工

```text
用户目标
  -> 慢思考：研究、规划、生成文章/标题/卡片文本
  -> JEV：观察 -> operation -> matching target -> 执行 -> 重新观察
  -> JEV DONE：慢思考独立验证
  -> JEV BLOCKED：慢思考重新规划
```

慢思考不再承担每一个可以直接执行的浏览器动作。JEV 每次只执行一个操作；需要内容输入时，慢模型只作为字段文本助手，为已选中的 TYPE_TEXT target 生成一个 JSON `{text}` 值。

## 决策协议

一次 System One 请求包含：

- `operation`：当前可执行的 CLICK、TYPE_TEXT、读取、滚动、WAIT、DONE 或 BLOCKED；
- `click_target`：仅在 CLICK 可用时提供，候选只能来自当前可见、未禁用的安全点击元素；
- `type_text_target`：仅在 TYPE_TEXT 可用时提供，候选只能来自可编辑字段。
- `plan`：当前 `in_progress` 子目标、完成条件、允许操作和剩余动作租约。
- `observation.runtime`：结构化媒体状态（`paused`、`currentTime`、`readyState` 等）与 `aria-busy`，用于避免被“正在缓冲”等可能滞后的可见文案误导。

`update_plan` 的每个步骤可声明 `allowedOperations` 与 `leaseActions`。一旦声明，JEV 的可执行集合会与当前子目标取交集；`DONE` 与 `BLOCKED` 始终保留作为安全出口。省略 `allowedOperations` 时保持旧的全动作空间；显式空数组表示该步骤不允许任何快动作。

所有 target head speculative 地并行评分；执行器只读取 selected operation 对应的 target head。高风险发布、发送、删除、支付等语义不会进入 CLICK 候选。

代码级校验包括：

- operation 与 target 必须在本次请求的候选集合中；
- choice 必须是概率最大的候选项；
- 概率总和必须为 1（允许 API 浮点误差）；
- operation 和匹配 target 均需达到动作类型对应的置信度；
- target 只能映射到已观察的 ref，不接受模型生成的 selector、坐标或 JavaScript。

## 执行循环

每个 cycle 的顺序是：

```text
read current PlanCard
  -> project allowed operations
get_page_snapshot
  -> JEV /v1/systemone
  -> validate operation + matching target
  -> execute exactly one operation
  -> consume one action from the subgoal lease
  -> get_page_snapshot
  -> repeat
```

`TYPE_TEXT` 的字段值由聊天模型生成并校验为唯一 `text` 字段；校验失败时不会输入。JEV 生成的是完整字段值，因此执行参数固定带 `clearFirst:true`，不会在旧标题后追加第二遍。已经有值的输入框、以及本任务中快路径或慢路径已经成功写过的目标，都不会再进入 JEV 的 `TYPE_TEXT` target head。`WAIT` 只等待并重新观察，不执行页面写入。

单次快路径片段默认最多连续执行 12 个动作，每个 run 默认最多 36 次 JEV 尝试；如果当前 PlanCard 声明了更小的 `leaseActions`，以租约先耗尽为准。慢思考更新计划或推进到新步骤后，计划版本变化，快路会获得新的子目标租约。连续动作数、尝试数、候选元素数、读取/输入/点击/等待阈值、目标动作分支下限和“同一动作无进展”连续执行上限仍可在设置页调整。恢复态仍受 200 次尝试、50 个连续动作的持久化硬上限保护。同一页面阻塞后，在 `phase + URL + snapshot fingerprint` 不变时不会重复请求 JEV；页面变化或慢思考写入新计划版本后才允许重新尝试。

`WAIT` 另有一条不受页面指纹影响的连续等待计数。动态广告、计时器或加载组件造成的 DOM 指纹变化不能把连续等待刷成“有进展”；达到 `maxRepeatedActionsWithoutProgress` 后直接交给慢思考。

`CLICK` / `TYPE_TEXT` 同时产生 operation 与目标 head。operation 是多分类判断；target 是条件判断，即使 operation 分支错误也可能给出 100%。因此目标动作须同时满足：匹配 target 达到该操作门槛，且 operation 达到独立的分支下限。没有 target head 的读取、等待、完成等操作仍使用 operation 门槛；`WAIT` 只读且可逆，使用独立的低风险阈值。真实校准结果见 [JEV 阈值校准记录](./jev-threshold-calibration.md)。

重复动作保护绑定到 `action + args + phase + URL + fingerprint`。页面发生变化会立即清零无进展连击；只有同一动作在当前页面状态下连续达到配置次数，才移交慢思考。

`type_text` 在内容脚本失败后采用事务式 CDP 降级：使用内容脚本返回的 `valueBefore` 恢复原始基线，先全选，再按段落块写入完整的“原值 + 新值”。长正文只在段落附近分块，块内保留真实换行，不再为了每一行派发 Enter 导致富文本编辑器重复插入。

## 升级到慢思考

以下情况停止快路径：

- `BLOCKED`；
- 无 target head 时 operation 置信度不足，或有 target head 时匹配 target 置信度不足；
- 连续 `WAIT` 达到无进展阈值；
- 不支持的操作、目标或页面结构；
- TYPE_TEXT 文本助手失败；
- 动作后无法重新观察；
- 连续两次工具失败；
- JEV 选择 `DONE`，必须由慢思考独立验证后才能完成任务。

## 发布站点安全门

发布类高风险动作不进入 JEV action space，由慢思考发起；通用工具管线仍会执行站点级确定性门禁：

- 小红书编辑页点击“生成图片”前，必须有当前页面“正文字数 / 500 字”证据，且计数未超限；
- 真正点击“发布”前，必须先在本任务中读取 `/new/note-manager`，确认历史笔记状态与标题（或确认列表为空）；
- 字数与历史检查都通过后，发布仍强制逐次确认，站点信任、自动批准和会话级批准都不能绕过；
- 检查失败时不弹审批，直接返回可操作的补救步骤，避免用户误以为动作已执行。

## 模式

- `enabled=false`：不调用 JEV。
- `enabled=true` + `shadowMode=true`：观察页面并记录 operation/target 建议，但不执行 JEV 动作。
- `enabled=true` + `shadowMode=false`：执行通过 operation、target、权限、审批、超时与新鲜度检查的安全动作。

## 安全边界

- 所有动作仍经过 `ToolCallPipeline` 的意图权限与审批。
- 发布等高风险按钮不进入快速点击集合。
- 模型不能输出 selector、坐标、URL、文件路径或 JavaScript。
- 决策与执行绑定到快照 ref；页面导航或元素替换后旧 ref 必须失效。
- 上传、新标签页、iframe、Shadow DOM、canvas 与任意键盘组件超出第一阶段快路径，遇到时交给慢思考。

## 模型协议兼容

内部消息中的 `lane` 只用于 UI 和导出，不发给聊天模型。请求发送前会转换成供应商消息白名单。

DeepSeek thinking 模型在请求携带 `tools` 时，要求历史中每个 `assistant` 消息都回传 `reasoning_content`。真实的模型思维链会原样保留；JEV 合成的工具轮没有聊天模型思维链，因此回传空字符串，避免后续慢思考请求返回 HTTP 400。

## 评估指标

- JEV operation/target 准确率；
- 每次 JEV 请求实际执行动作的比例；
- 快路径连续完成动作数；
- BLOCKED 原因分布；
- 页面 stale 与动作失败率；
- 慢思考调用次数、工具调用数和总耗时；
- DONE 声明被独立验证否决的比例。

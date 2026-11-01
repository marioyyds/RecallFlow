# JEV 快慢思考集成

## 定位

JEV 使用的是 TypeSafe 的远程 System One 接口：

- `POST /v1/systemone`：对同一份 state 回答命名的 `noul`、`choice`、`score` 或 `box` 问题。
- `GET /v1/models`：列出当前凭据可用的模型。
- 默认地址：`https://api.typesafe.ai`
- 默认模型：`jev-latest`

JEV 不是聊天模型，不生成最终回答。RecallFlow 只接受它返回的结构化答案，再将其映射到受限的动作空间。

## 快慢链路

```text
任务开始
  -> Fast Controller
       -> TypeSafe /v1/systemone
       -> choice: observe | scroll | safe visible click | escalate
       -> 置信度与白名单校验
       -> ToolCallPipeline（权限、审批与超时）
       -> append-only 工具消息
       -> 读新快照后最多再快决策两步
  -> 现有聊天 LLM
       -> 需要时继续规划/调用工具
       -> 基于真实证据生成最终回答
```

JEV 按页面状态变化触发快思考片段：每个片段最多连续执行 3 个局部动作，整个 run 最多 12 次 JEV 尝试。后续慢思考动作改变页面后，可以开启新的快思考片段。低置信度、重复动作、高风险点击和实质内容生成会立即交还慢思考。

## 模式

- `enabled=false`：不调用 JEV。
- `enabled=true` + `shadowMode=true`：调用 JEV 并记录建议，但不执行工具。这是默认推荐模式。
- `enabled=true` + `shadowMode=false`：高置信度的观察、滚动或安全可见元素点击可以通过现有 `ToolCallPipeline` 执行；发布、发送、删除和支付类候选不会进入快速点击白名单。

## 类型安全边界

- TypeScript 定义 TypeSafe 请求、问题和答案的联合类型。
- `parseJevSystemOneResponse()` 在执行前校验答案类型、概率范围、问题覆盖和 usage。
- JEV 只能选择本地生成的动作候选；静态观察动作使用固定参数，点击候选只能引用最新快照中的 ref/selector。
- 所有动作仍经过意图权限、工具元数据、超时、守卫和结果验证。
- MCP、点击、输入、写库、脚本和下载动作不进入首版快路径。

## 前缀缓存

- TypeSafe 请求不复用聊天模型消息前缀。
- JEV 执行的动作以正常 `assistant(tool_calls)` + `tool` 消息追加。
- 不修改 `messages[0]`，不动态增删聊天工具 schema。
- 快路径动作完成后，慢思考继续使用同一份稳定工具面，并生成最终回答。

## 影子评估

Trace 中记录：

- `phase=jev`：模式、模型、决策、延迟、输入/输出 token。
- `phase=jev-shadow-compare`：JEV 建议的下一步，与慢思考首个动作和最终回答比较。

`summarizeRunTrace()` 汇总：

- JEV 调用数、影子/实际执行数；
- 动作建议数与升级数；
- 延迟与 token；
- 影子一致数/比较数。

上线前应先保持影子模式，按域名与任务类型检查动作准确率、升级召回率、影子一致率和延迟。只有确认只读路径安全后才关闭影子模式。

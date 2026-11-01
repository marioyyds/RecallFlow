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
       -> choice: read_current_page | read_table | escalate
       -> 置信度与白名单校验
       -> ToolCallPipeline（只读）
       -> append-only 工具消息
  -> 现有聊天 LLM
       -> 需要时继续规划/调用工具
       -> 基于真实证据生成最终回答
```

第一版每次运行最多调用一次 JEV，最多自动执行一个只读动作。写入、审批、多步规划和最终回答继续由现有慢思考链路负责。

## 模式

- `enabled=false`：不调用 JEV。
- `enabled=true` + `shadowMode=true`：调用 JEV 并记录建议，但不执行工具。这是默认推荐模式。
- `enabled=true` + `shadowMode=false`：高置信度只读建议可以通过现有 `ToolCallPipeline` 执行。

## 类型安全边界

- TypeScript 定义 TypeSafe 请求、问题和答案的联合类型。
- `parseJevSystemOneResponse()` 在执行前校验答案类型、概率范围、问题覆盖和 usage。
- JEV 只能选择固定动作白名单，参数来自本地动作定义，不接受模型生成任意工具名或参数。
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

# RecallFlow Architecture

RecallFlow 使用稳定的依赖方向，而不是按文件类型堆放业务逻辑。

## 依赖规则

```text
Entry / Composition Root
  ├─ creates ─→ Application
  ├─ creates ─→ Adapters
  └─ injects Adapters into Application ports

Application ─→ Domain
Adapters ─implements→ Application ports
Domain ─→ no Chrome, DOM, storage, or framework code
```

编译期依赖只能朝向更稳定的模块：

- `domain/`：知识库模型与查询规则，不接触外部环境。
- `application/`：用例、运行状态机、Repository 与 Port。
- `adapters/`：Chrome、DOM、存储、CDP 等外部技术适配。
- `entries/`：创建依赖并挂载应用，只承担 Composition Root。
- `shared/`：跨能力的基础类型与纯工具，不得反向依赖上层能力。
- `page/`、`assistant/`：迁移中的现有功能目录，按相同规则逐步迁入目标层。

## 已建立的应用边界

- `application/knowledge/repository.ts`：知识库缓存、写入串行化与订阅。
- `application/panel/visibility.ts`：面板全局开合状态与乱序事件处理。
- `application/panel/run-session.ts`：面板运行 ID、端口和停止生命周期。
- `application/panel/stream-state.ts`：流式正文、parts 与校验提示。
- `application/agent/run-registry.ts`：Service Worker 的 run/controller/channel 注册表。
- `application/agent/run-lifecycle.ts`：停止、abort 宽限与标签页清理。
- `application/agent/runner.ts`：Agent 运行用例的稳定入口。
- `application/agent/run-context.ts`：新任务与恢复任务的上下文构造。
- `application/agent/budget.ts`、`history-policy.ts`、`intent-policy.ts`：成本预算、可恢复历史与意图提升策略。
- `application/agent/verification-policy.ts`：存活看门狗、任务类型、证据与完成校验判定。
- `application/agent/stream-step.ts`：模型流式请求、重试、中止与 SSE 解析。
- `application/agent/tool-execution.ts`：工具超时、实时审批与安全的并行批次执行。
- `application/background/*-router.ts`：面板、自动化、AI 长连接的独立消息路由。
- `application/contracts/messages.ts`：跨上下文消息的可辨识类型入口。
- `application/ports/runtime.ts` / `adapters/chrome/runtime.ts`：Runtime Port 与 Chrome 实现。
- `application/ports/tabs.ts` / `adapters/chrome/tabs.ts`：Tabs Port 与 Chrome 实现。
- `application/ports/storage.ts` / `adapters/chrome/storage.ts`：存储 Port 与 Chrome Storage 实现。
- `domain/knowledge/model.ts`、`domain/knowledge/query.ts`：知识库领域契约与查询规则。
- `ui/panel/approval-view.ts`、`ui/panel/tool-step-view.ts`：无业务状态的 DOM 渲染组件。
- `ui/panel/theme-controller.ts`、`progress-controller.ts`、`screenshot-view.ts`：主题、耗时进度与有界截图缓存。
- `ui/panel/conversation-format.ts`：实时与恢复对话共用的纯展示格式；运行按钮投影位于 `application/panel/run-controls.ts`。
- `page/command-locator.ts`、`command-read.ts`、`command-overlays.ts`、`command-actions.ts`：页面定位、读取、覆盖层与交互动作。
- `page/command-session.ts`：统一管理撤销栈、样式还原函数与页面命令定时器。

## 架构门禁

```bash
npm run check:arch
```

门禁会检查：

- 静态依赖图不存在循环。
- `shared` 不反向依赖 `assistant`、`page` 或入口。
- `domain` 不依赖应用层或适配器。
- `presentation` 只依赖应用契约、领域和共享基础模块。
- `lib` 不反向引用 `entries`。

## 组合方式

`entries/background.ts` 只注册 Chrome 生命周期监听器并构造路由、Port 与用例。具体消息分派位于
`application/background`；`entries/content.ts` 把 Chrome Runtime Adapter 注入聊天面板。
`lib/page/commands.ts` 只保留命令分发表，具体实现由四个协作者承担。

该检查已加入 `npm test`。新增循环依赖或非法依赖方向会直接使测试失败。

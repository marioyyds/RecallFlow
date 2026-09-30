# 方案 B：把 RecallFlow 改造成 DSH 原生插件

> 状态：**探索稿（未实现）**。分支 `explore/dsh-plugin`。
> 本文只做设计，不改代码。所有 DSH 侧接口结论都标注了来源文件与行号，便于复核。

---

## 0. 一句话结论

不是"移植"，是**沿一条缝切开**：DSH 接管 agent 循环、模型、UI 与审批；
RecallFlow 退化为"浏览器接入 provider"，只保留**只有扩展能做的事**。

预计净减约 1.1 万行（RecallFlow 1.5 万 → 2–4 千），并**顺带解决两个我自己测出来但没解决的问题**（工具定义每轮 8.3k tokens、意图白名单是手维护的清单）。

---

## 1. 边界：什么必须留在扩展

这不是取舍，是硬约束 —— 以下四件事 DSH 在任何形态下都做不到：

| 能力 | 为什么 DSH 做不到 |
|---|---|
| **真实登录态** | DSH 侧栏浏览器是 `iframe` + `sandbox` 或 Electron `<webview>`，与用户日常浏览器的 cookie/session 隔离 |
| **CDP（`chrome.debugger`）** | 扩展 API，Node 侧无法调用。截图、AX 树、原始坐标点击、多 frame 遍历都依赖它 |
| **MAIN world 钩子** | 需在页面主世界于 `document_start` 注入（`lib/page/debug-hook.js`）：console/network 捕获、React/Vue 源码定位 |
| **页面内注入** | 拾取器浮层、证据高亮、Chrome 文本片段深链 |

依据：`dsh-client-ui-sidebar-browser` 的说明里写明其 Web 实现使用
`sandbox="allow-scripts allow-forms allow-same-origin allow-popups …"`、**不向被访问内容注入 Electron 或 Node 能力**、
**不代理或探测远程页面**，并明确指示：**当站点拒绝 iframe 嵌入、或需要本包未授予的浏览器 capability 时，
应改用"明确的外部浏览器操作"**。

→ 这正是 RecallFlow 的位置。两者是**互补**而非竞争：DSH 的浏览器要隔离，RecallFlow 要伸进去。

---

## 2. DSH 侧接口事实（已核实）

| 事实 | 来源 |
|---|---|
| 工具用 `defineTool({ name, description, parameters, output, execute, … })` 定义 | `dsh-tools/lib/types/schema.d.ts` `DefineToolOptions` |
| **`output` 是必填**：`{ schema, render(args,value): ContentBlock[], presentationMeta? }` | 同上 |
| 注册：`ctx.tools.register(definition)` → **返回注销函数** | `dsh-tools/lib/types/index.d.ts:636` |
| `ctx.tools.restrict(filter)` 可按 scope 限制工具可见性 | 同上 `:644` |
| `ctx.tools.guard(guard)` 可加守卫 | 同上 `:655` |
| 执行流水线：`tools/pre-execute`（allow/deny/cancel/**ask**）、`tools/execute`、`tools/post-execute` | 同上（`declare module '@deepseek-ai/cordis'` 段） |
| **注册入口吃 JSON Schema**：`ToolDefinition extends ToolSchema`，`ToolSchema.schema: JsonSchemaNode` | 同上 `:108` |
| 富展示是一等公民：`ToolCallView` / `ToolResultView` 及 `WebResultView` / `DiffCallView` / `TerminalCallView` 等 | `dsh-tools/lib/types/presentation.d.ts` |
| **`ToolSchema.deferLoading`** 可请求工具定义延迟加载 | `DefineToolOptions.deferLoading` 注释 |
| 插件是 Cordis 插件：`apply(ctx, config)` | `dsh-mcp-client/lib/types/index.d.ts:89` |

### 两个直接影响方案的关键推论

1. **Schema 不必重写 —— 已实测确认。** 现有 55 个 OpenAI 格式工具可以直接把 `function.parameters` 搬到 `schema`。
   我用 DSH **自己的**校验器（`@deepseek-ai/dsh-tools` 的 `assertObjectJsonSchema` +
   `assertSupportedJsonSchema`）跑了全部 55 个：

   ```
   工具总数: 55        object 校验未通过: 0        DSH 子集校验未通过: 0
   含 enum 的工具: 9，其中被卡: 0
   ```

   复现：`node scripts/probe-dsh-schema-compat.mjs`
   → 迁移形态确实是**适配器**而非重写（这是阶段 0 的产出，见 §5）。
2. **`deferLoading` 直接命中我测出的成本问题。** 我在审查里量到 `browser_task` 每轮要发
   8.3k tokens 的工具定义（30 轮 ≈ 25 万），当时的结论是"只能靠减少工具数，而那是产品取舍"。
   DSH 内建延迟加载 —— **这个取舍可能不必做**。

---

## 3. 迁移形态：适配器，而非重写

RecallFlow 的 `TOOL_REGISTRY`（`lib/assistant/tool-schemas.js` + `tool-metadata.js`）已经是一个
**规范化的工具表**（name / description / inputSchema / risk / readOnly / route / requiresApproval）。
它和 DSH 的 `ToolDefinition` 之间是一层**薄适配**：

```
RecallFlow TOOL_REGISTRY[i]              DSH ToolDefinition
─────────────────────────────            ──────────────────────────────
function.name                       →    name
function.description                →    description
function.parameters (JSON Schema)   →    schema            （若通过 assertSupportedJsonSchema）
risk / readOnly / requiresApproval  →    tools/pre-execute 里的 ask/allow 决策
route: 'content' | 'background'     →    execute 内部分派（保持现有 bridge 语义）
（无）                              →    output.schema     ← 新增，逐批补
（无）                              →    output.render     ← 新增，决定富 UI
```

`executeTool()`（`lib/assistant/tools.js`，约 1050 行的 switch）**基本原样保留** —— 它已经按
`route` 分派到 content/background，这层语义在 DSH 里同样成立。

**需要新写的只有两件**：每个工具的 `output.schema`（声明式，可与现有返回值对齐）
与 `render()`（纯函数，把结果映射成 `ContentBlock[]` 或富展示）。

---

## 4. 文件级去向

| 文件 / 模块 | 行数（约） | 去向 | 理由 |
|---|---:|---|---|
| `lib/assistant/agent.js` | 1219 | **删除** | DSH `dsh-agent-loop` + `tools/*` 流水线 |
| `lib/assistant/llm.js` | — | **删除** | DSH `dsh-llm` |
| `lib/assistant/intent-router.js` | — | **删除** | 用 `ctx.tools.restrict()` 按 scope 限制，而不是手维护白名单 |
| `lib/assistant/claim-check.js` | 103 | **删除** | DSH 的 verification / post-execute 策略 |
| `lib/page/chat.js` + `panel-css.js` | 2545 | **删除** | DSH `dsh-client-ui-chat` / `-tool` / `-slots` |
| `lib/assistant/tool-schemas.js` / `tool-metadata.js` | 980 | **改写** | 变成插件里的工具定义 |
| `lib/assistant/tools.js`（`executeTool` 部分） | ~1050 | **保留** | 业务逻辑与 DSH 无重叠 |
| `lib/bridge/relay.js` | 350 | **保留**（可能迁到插件 host） | 桥接协议不变，只是发起方从 MCP server 变成 DSH 插件 |
| `lib/backend/cdp.js` | — | **保留** | 只能在扩展侧跑 |
| `lib/page/*`（picker / commands / debug-hook / markdown / citation / page-text） | — | **保留** | 页面内能力 |
| `lib/shared/*`（table / utils / handoff / bridge-methods） | — | **大部分保留** | 纯逻辑，与 DSH 无重叠 |
| `integrations/opencode/recallflow-mcp/` | — | **保留**（作为 MCP 通道并存） | 非 DSH 客户端仍可用 |

> 保留项里 `markdown.js` 的安全原语（`sanitizeHref` / `planCitationOpen`）值得单独提：
> 那是两轮前修 XSS 时抽出来的纯函数，与宿主无关，**换个宿主照样需要**。

---

## 5. 分阶段计划（每阶段可独立验证）

| 阶段 | 内容 | 验证方式 |
|---|---|---|
| **0. 合规性量化** | ✅ **已完成**：用 DSH 自己的校验器跑全部 55 个 Schema | 结果见 §2：**0 个不合规**，Schema 可原样复用 |
| **1. 骨架** | 建插件包，`apply(ctx)` 里注册 1 个只读工具（`page_health`） | DSH 里能看到并调用它，返回正确 |
| **2. 适配器** | 写 `toDshDefinition(registryEntry)`，批量注册只读工具（25 个 `risk:'read'`） | 回归：与 MCP 通道对同一页面返回一致 |
| **3. 审批** | 把 `risk`/`requiresApproval` 接进 `tools/pre-execute` 的 ask/allow | 与现有 `toolNeedsApproval` 逐条比对真值表 |
| **4. 富展示** | 给 `read_console`/`page_health`/`verify_change`/截图补 `output.render` | 在 DSH UI 里肉眼确认展示效果 |
| **5. 写入类工具** | 页面写操作（`risk:'page'`，17 个）+ content route 分派 | 真实页面上的行为对照 |
| **6. `deferLoading`** | 给工具分级：常用不延迟、冷门延迟 | **实测每轮 token 是否下降**（对照现有 8.3k 基线） |
| **7. 卸载旧代码** | 删 agent/llm/UI/意图路由 | 全量回归 |

阶段 0–2 是**低风险的**（纯增量，不动现有代码，两条通道并存）。
真正的不可逆动作集中在阶段 7。

---

## 6. 收益

1. **净减约 1.1 万行**，且删掉的都是我在这 12 轮里反复发现问题的部分
   （agent 循环的预算/断言/反思、2545 行面板 UI、手维护的意图白名单）。
2. **`deferLoading` 可能解决工具定义成本** —— 比"合并到 ≤25 个工具"更根本。
3. **富展示**：`ToolResultView` 体系让 `read_console` / 截图 / diff 能真正展示，
   而不是像 MCP 通道那样"JSON 塞进文本"。
4. **审批语义统一**：DSH 的 `tools/pre-execute` 是标准瀑布，替代我在 `agent.js` 里手写的
   risk → 类别映射（那处源码注释自己承认"会静默错配"）。
5. **模型自由**：用户可用 DSH 里配置的任意模型，而不必用 RecallFlow 内置的 DeepSeek 通道。
6. **顺带修复我发现的图片降级问题**：`dsh-mcp-client` 在 `lib/index.js:299` 会检查模型
   `inputModalities`，纯文本模型下把 image 块降级为 `[image unavailable: …]` 占位符。
   原生插件的 `render()` 可以把图**展示给用户**（而非只给模型），这类降级就不影响体验。

---

## 7. 风险与未解问题

| # | 风险 | 说明 |
|---|---|---|
| 1 | **丢掉页面内面板** | 现在"在这个页面上圈个元素直接问"是连续动作；拆开后面板在另一个窗口。**折中**：拾取器浮层留在页面内，面板搬到 DSH。这是**体验取舍，需产品决策** |
| 2 | **安装变两件套** | DSH 插件是 npm 包 + profile patch；扩展仍是 unpacked sideload。现在是"装一个扩展" |
| 3 | **信任模型要重划** | 能碰登录态的是扩展；agent 循环搬到 DSH 后，"要不要点这个按钮"由 DSH 的沙箱/审批策略决定。DSH 的审批更强，但**语义不同**（它管的是本机文件与命令，不是网页动作） |
| 4 | **`output.schema` 是新增工作量** | 每个工具都要声明输出 schema + `render()`。55 个工具意味着 55 份新代码，虽然不重写逻辑，但量不小 |
| 5 | **Schema 合规性未知** | 现有 JSON Schema 是否都通过 `assertSupportedJsonSchema` 未验证（阶段 0 就是干这个） |
| 6 | **DSH 版本耦合** | 插件要对 `@deepseek-ai/dsh-tools` 等 peer 依赖，DSH 升级可能破坏 —— 现在是自包含扩展，无此风险 |
| 7 | **两条通道并存期** | MCP 与原生插件会同时存在，`bridge-methods` 那份跨端契约清单需要扩成三端 |

---

## 8. 明确不做的事

- **不把扩展搬到 DSH**（第 1 节的硬约束）。
- **不在阶段 0–2 动现有代码**（保持两条通道并存，可随时回退）。
- **不在没量化前讨论"合并工具到 ≤25 个"** —— 若 `deferLoading` 生效，那个取舍可能根本不必要。

---

## 9. 下一步（需要决策）

- [ ] 是否先做**阶段 0**（跑一遍 Schema 合规性校验，只读、不改代码）？我倾向做，成本很低且决定后续可行性。
- [ ] 面板留在页面内还是搬到 DSH？（风险 1，纯产品决策）
- [ ] 是否接受"两件套安装"？（风险 2）
- [ ] 是否保留 MCP 通道作为并行支持？（影响阶段 6 之后能否删 `integrations/`）

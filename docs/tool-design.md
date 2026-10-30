# RecallFlow 工具设计规范

> 适用范围：为 RecallFlow 的 Agent 新增或重构内置工具（`lib/application/agent/tools.js` 的 `TOOL_SCHEMAS` / `TOOL_METADATA`）时，必须遵循本文。
> 目标：让工具"模型好调用、动作可验证、安全边界清晰、预算不浪费"。

## 1. 一个工具的定义三要素

每个工具由三份「共用同一来源」的定义构成（`tools.js` 已通过 `TOOL_REGISTRY` 派生，禁止各维护一份）：

| 要素 | 位置 | 作用 |
| --- | --- | --- |
| Schema | `TOOL_SCHEMAS` | 给模型的函数签名（name / description / parameters） |
| 风险元数据 | `TOOL_METADATA` | `risk`、`requiresApproval`、`readOnly`、`alwaysRequireApproval`、`route` |
| 执行器 | `executeTool` 的 case | 真正执行，并返回统一结果结构 |

原则：**Schema 与权限策略共源、不漂移**。任何一方改动都必须同步另外两处。

## 2. 粒度：按「任务单元」而非「动作单元」

- 一个工具应完成一个**可命名、可解释、可验证**的任务单元。
- 高频「一个任务 = 多个动作」的场景，用**批量参数**收敛（见 §9），而不是让模型多次调用。
- 判断标准：
  - 模型是否需要连续调用同一工具 3 次以上才能完成一个子任务？→ 应加批量参数。
  - 工具是否同时在做两件不相关的事？→ 拆开。

**正例**：`highlight_text` 支持 `texts: string[]`，一次高亮 N 处（此前单 text 需要 N 次调用）。
**反例**：让一个 `do_thing` 同时负责"改样式 + 发通知"。

## 3. 命名

- `动词_名词`，全小写下划线；动词说明动作，名词说明对象/目标。例：`click_element`、`type_text`、`wait_for_element`。
- 读操作与写操作分开命名（`get_*` 只读，`set_*` / `click_*` 等写），便于 `readOnly` 判定。
- 避免同义命名（`get_element_text` vs `read_current_page` 语义须有清晰边界，见 §6）。

## 4. 参数 Schema

- **required 最小化**：只保留「缺少就无法执行」的字段。模型经常编造参数，能省则省；缺参时用默认值。
- **能用枚举，不用自由文本**：`state`、`type`、`behavior` 等一律 `enum`。
- **description 写「何时用 + 参数含义」**：模型依赖描述决定调用，避免只写字段名直译。
- **布尔字段给默认语义**：如 `clearFirst` 默认 `false`，描述写明默认行为。
- 结果上限/截断在参数层面说明（如 `maxElements` 的默认与最大值）。

## 5. 定位参数统一（本规范重点）

所有操作 DOM 的工具，目标定位必须支持同一套三选一：

```
ref      DOM 快照中的元素引用（rf-N），优先使用
selector CSS 选择器（ref 不可用时）
text     原文片段（最终兜底，字符级匹配）
index    命中第 N 个匹配（从 0 起，处理重复结构），可选
```

- 三个定位参数同时出现在 parameters 里，`required` 为空（三选一），由执行器解析。
- `ref` 来自 `get_page_snapshot`，命中率最高，描述里优先引导。
- 已有工具若只支持其中部分（如 `select_option` 不收 `text`），新增/重构时补齐；字段名统一为 `ref / selector / text / index`，不要各自造词。

## 6. 返回结构：统一外壳 + 验证字段

执行结果统一为：

```js
{
  ok: true,                       // 是否成功（false 时进错误信息规范，见 §7）
  result: '可读文本',             // 给模型的描述
  // 以下可选：
  data,                           // 结构化数据（读操作）
  changed,                        // 值/状态是否发生变化
  alreadySatisfied,               // 是否已处于目标状态（幂等）
  hadEffect,                      // 快照验证是否观察到页面变化
  citations,                      // 引用来源（RAG / 网页）
  targetTabId,                    // 触发了标签页切换/绑定
}
```

- **写操作**必须提供 `changed` / `alreadySatisfied`（或 `hadEffect`），供 `verifyPageAction` 与 stuck detector 判断"有没有进展"。
- **读操作**的返回值必须截断（长文本、JSON 化结果约定上限，如正文 8000、快照 4000、JS 结果 2000），防止爆 token。
- 不返回 `undefined` 裸值；无内容返回 `（空）` 或 `（空内容）`。

## 7. 错误信息：必须给「替代路径」

`ok: false` 时，结果文本必须告诉模型**下一步能做什么**，而不是干巴巴报错：

- 未找到元素 → 提示改用其他定位方式 / 先 `get_page_snapshot` 拿 ref。
- 资源触顶 → 给出可用清单与替代工具（如 `open_tab` 触顶给出 tabId 列表 + `switch_tab` / `fetch_webpage`）。
- 参数非法 → 说明缺什么、允许的值是什么。

判断标准：模型读了错误信息后，应能**不靠猜**地决定下一个动作。

## 8. 批量参数与聚合返回

- 需要多次同类操作时，提供数组参数（如 `texts`、`items`），上限 20 个。
- 批量返回聚合结果：`已高亮 5/6 处；未找到：xxx` —— 让模型知道哪些失败、可针对性补做。
- 批量操作仍只弹**一次**审批。

## 9. 风险分级与审批

`TOOL_METADATA` 的 `risk` 枚举与审批映射（`approval-policy.js` `toolNeedsApproval` 已实现，新增工具须对号入座）：

| risk | 含义 | `toolApprovalPolicy` 键 | 审批 |
| --- | --- | --- | --- |
| `read` | 只读观察 | —（`requiresApproval` 未置位，直接放行） | 不需要 |
| `page` | 页面内写操作（点击/输入/标注） | `commands` | 需审批，可按类别自动批准 |
| `browser` | 浏览器级（开关标签页） | `browser` | 需审批，可按类别自动批准 |
| `network` | 网络请求 | `browser` | 需审批，可按类别自动批准 |
| `write` / `destructive` | 写/删本地数据 | `edit` | 需审批，可按类别自动批准 |
| `external` | MCP / 外部服务 | `mcp` | 需审批，可按类别自动批准 |
| `high` | 任意代码执行等高危 | —（改走 `codeExecutionApproval`） | 默认需确认一次后本任务内放行；可配为每次确认或自动批准 |

- `alwaysRequireApproval: true` 用于 `high` 风险工具（`run_javascript`、`run_userscript`、`install_userscript`）：它**不参与** `toolApprovalPolicy` 的分类自动批准，也不受站点信任影响，而由独立的 `codeExecutionApproval` 控制：
  - `'each'`：每次调用都确认；
  - `'session'`（默认）：确认一次后，本任务内后续调用直接放行；
  - `'auto'`：完全不弹审批。
  - 旧键名 `runJavascriptApproval` 仍可读（`resolveCodeExecutionApproval` 会回退），但不再写入。**泛化键名的理由**：该开关约束的是「执行任意/第三方代码」这一**类**工具，而非只有 JavaScript；沿用旧名会让用户以为只放开了 JavaScript，却连带放开了会从远程自动更新的用户脚本。
- `toolApprovalPolicy` 默认值里的 `read: true` 实际不生效（只读工具在 `toolNeedsApproval` 开头就返回了），保留它只是为了 UI 勾选项的完整性。
- `readOnly: true` 的工具不受失败摘除影响（交给 stuck detector 判定）。

## 10. 数量与可见性

- 内置工具总量目标 **≤ 25 个**；超出时优先合并重叠工具，而不是堆新工具。
- 模型实际可见的工具 = **跨意图稳定的完整 capability surface**。工具定义位于消息之前，若随意图切换会破坏请求前缀缓存；因此所有意图下发同一份、确定性排序的工具 schema。
- `intent-router.ts` 的 `allowedTools` 是**执行期权限**，不是 schema 白名单。新工具必须明确加入允许使用它的意图；普通对话默认仍禁止页面写操作，但模型可以看到 schema，调用时由执行层拒绝。
- 工具停用、技能加载和 `CHAT → RESEARCH` 画像提升都不得增删 `state.tools`；它们只能改变执行权限，并以追加消息/tool result 的形式反映到上下文。
- 逃生舱类工具（`run_javascript`）的 schema 保持稳定可见，但只允许在明确需要它的意图中执行，并在 description 明确"仅当内置工具无法表达时使用"。

## 11. 新增工具 Checklist

新增或修改工具时逐项打勾：

- [ ] 命名符合 `动词_名词`，与现有工具无同义/重叠
- [ ] 定位三选一 `ref / selector / text`（+可选 `index`）齐全且字段名统一
- [ ] `required` 最小化；可枚举参数用了 `enum`
- [ ] description 写了「何时用 + 参数含义 + 批量/默认行为」
- [ ] 写操作返回 `changed` / `alreadySatisfied` / `hadEffect` 验证字段
- [ ] 返回值有截断/上限约定
- [ ] `ok:false` 的错误信息包含替代路径
- [ ] `TOOL_METADATA` 的 `risk` 分级正确，`readOnly` / `alwaysRequireApproval` 已标注
- [ ] 已加入合适意图的执行权限（并考虑是否该出现在 `chat_task`）
- [ ] `buildStableSystemPrompt` 的工具名清单来自同一份稳定工具面（不得再按意图动态生成）
- [ ] 批量参数聚合返回，一次调用可完成重复子任务

## 12. 与现状的差距（待办）

已完成的统一化：

- [x] `scroll_to_element` 与 `scroll_page` 已合并为单个 `scroll_page`（按目标 / 坐标 / 偏移三种方式，见 `tools.js`）。
- [x] `get_attribute`、`check_box` 已补齐 `text` 定位（checkbox 支持按 label 文本定位并自动解析关联控件）；`highlight_text` 支持 `texts` 批量。

待办：

- [ ] 视觉标注类（`highlight_text` / `outline_element` / `set_element_style` / `clear_page_overlays`）存在功能重叠，可评估合并为统一「标注」语义。
- [ ] **内置工具现为 44 个（原 55），仍是 §10 目标（≤25）的 1.8 倍** —— 属待偿还的结构性债务。工具过密会抬高误选率并浪费提示 token，应优先合并重叠工具，而不是继续新增。
  - **已执行的 5 步（2026-02）**：① 诊断三件套 → `read_diagnostics({kind})`（55→53）；② 宏三件套 → `macro({op})`（53→51）；③ 知识库只读三件套 → `knowledge_read({op})`（51→49）；④ 元素检查只读三件套 → `inspect_element({op})`（49→47）；⑤ 视觉标注四件套 → `annotate({op})`（47→**44**）。
  - **分组判据（多次实测得到的）**：按**执行路径与权限类别**分组，而**不是**按语义相似度。原方案里"知识库 5→2"与"元素检查 5→1"都因为把不同权限/不同路径的工具硬合到一起而被收窄；第 6、7 档则因为**前置条件根本不同**（审批函数拿不到 args / CDP 依赖差异）而判定不可做。净减量与传统分组一致，但不产生权限污染、不把两条链路塞进一个入口。
  - **注意（反直觉，已出现三次）**：合并让**工具数下降、但 schema 字符数上升**（诊断档 32791>32500；宏档 chat_task 8400→9700；视觉标注档 browser_task 33400→35600）。**"工具数下降"≠"prompt 变小"**。若后续还要合并，应当先**精简描述**，而不是继续调高预算。
  - **完整方案与成本数据**：`docs/tool-merge-plan.md`（含每档净减量、权限该继承谁、跨越性约束核对、以及"这条路到不了 28"的实测结论），复核命令 `node scripts/tool-merge-impact.mjs`。
  - **可落地的合并路径**（按收益排序）：元素检查 5→1（`get_element_text` + `get_attribute` + `get_element_source` + `inspect_element` + `extract_table` → `inspect_element({fields})`）、视觉标注 4→1（`annotate(op)`）、知识库 5→2、宏 3→1、用户脚本 4→1、技能 2→1、`read_console` + `read_network` + `list_downloads` → `read_diagnostics(kind)`、`list_frames` + `get_ax_snapshot` → 1、指针族 4→1（`click_element`/`click_at`/`hover_element`/`drag_element` → `pointer(op)`）。
  - **实测修正（2026-02 校对）**：上面这条路径把工具数**从 55 降到 33，只省下 22 个** —— 达不到这里原先写的"目标落在 ~28"。原因不是分析错，而是那句话是**手算的**；改动它们之前没人把每一档的净减量加起来核过。（诊断档已于本轮执行，故从 55 起算的 33 现对应 53 起算的 31。）
    复核方式：`node scripts/tool-merge-impact.mjs`（分组从 `TOOL_REGISTRY` 派生，名字不存在就直接报错退出，避免统计出一份"漂亮但描述的不是这个系统"的报告）。
    因此现实的取舍是：**要落到 28 还需再砍 5 个；要落到 §10 的 ≤25 还需再砍 8 个。**
  - 注意：那些额外削减**必然是砍能力**（例如不再内置用户脚本管理、或把诊断三件套并入更少的入口），而不是纯重构。这是产品取舍 —— 本文只能给出成本，不能替代决策。
- [ ] 知识库检索目前是「字段加权词法匹配 + 中文 bigram 切分」（`lib/shared/rag.js`），**不含向量嵌入**：语义近义查询（问「跨域」而条目只写「CORS」）会漏召回。
- [ ] 写操作批量参数（如 `set_element_style` 批量元素）尚未推广。
- [ ] 表单值选择类（`select_option`）按设计以 `ref / selector + value / label / index` 定位，`text` 暂不追加（与 `label` 语义重叠），需在 §5 补充例外说明。

# 技能是怎么被"选中"的（以及为什么关键词匹配被删掉了）

> 这份文档是**手工维护**的：它讲的是运行时的真实行为与**测量结果**，而生成物
> （[`skills-overview.md`](skills-overview.md)）只能数出"有哪些技能、对应哪条剧本"。
> 两者互补：清单回答"资产齐不齐"，本文回答"模型到底会不会用、改文案能不能测"。
>
> 上游证据：[`real-model-eval-log.md`](real-model-eval-log.md)（每次真模型运行的原文记录）。
> 相关门禁：[`../tests/skill-content-structure.test.mjs`](../tests/skill-content-structure.test.mjs)、
> [`../tests/skills-overview.test.mjs`](../tests/skills-overview.test.mjs)、
> [`../tests/skill-playbook-contract.test.mjs`](../tests/skill-playbook-contract.test.mjs)。

## 1 运行时：模型自己读目录、自己加载

```
system prompt  ┌───────────────────────────────────────────────┐
（常驻，很短）  │ 可用技能（专家手册）：                          │
               │ - readability-fix：调整页面的正文排版与容器宽度… │   ← 一行 name：description
               │ - debug-console-error：页面上的交互没有生效…     │
               │ …（每个技能一行，正文**不在**这里）             │
               └───────────────────────────────────────────────┘
                              │  模型判断"这个任务适合它"
                              ▼
        load_skill({ name: "readability-fix" })  ──► 取回该技能**正文**（这一步才进上下文）
```

- 目录由 `lib/application/agent/skills.js` 的 `buildSkillCatalog()` 生成，拼进 system prompt 的是
  `intent-router.js` 的 `buildSystemPrompt()`。
- 技能的完整正文**只在 `load_skill` 被调用后**才进上下文（`lib/application/agent/skill-tools.js`）。
  这是**按需加载**（省 token），也是"模型有选择权"的来源。
- 技能族一共三个工具，方向各不相同：`load_skill`（**读**手册，只读常驻）、
  `install_skill`（从 SkillHub **装**，`external` + 审批）、
  `save_skill`（把一段做法**写**成技能，`high` + **逐次审批**）。
  第三个是后来补的：此前"写技能"只能用技能页，用户说「沉淀为技能」时 Agent 无路可走
  （实测会话 RF-FY6PUP）。它的风险档取最严，因为**技能正文会进入今后的系统提示** ——
  这是一条持久化的注入面，比一次性的页面操作影响更长远（见 `lib/application/agent/tool-metadata.js`）。
- **没有**正则、**没有**关键词打分、**没有**"命中即注入"。

## 2 被删掉的那条路：`detectSkill()`（关键词匹配）

原来 `lib/application/agent/skills.js` 里有一个 `detectSkill(instruction, intent)`：拿 `x.keywords` 里的正则
去跑**整条用户指令**，命中就把技能正文注入 system prompt。

**它是一条死代码**：全仓 grep（`lib/`、`scripts/`、`integrations/`、`background.js`、`content.js` 产物，
含字符串形式的动态引用）只找到它自己的定义与一个测试文件的调用 —— 生产里**没有任何调用方**。
连带的问题是：那条"技能触发条件缺失"的门禁**测的是一条永远不跑的路**，
它给人"触发条件被守住了"的**错觉**。本仓库最忌"假装通过"，所以删掉。

### 删掉之后，"技能匹配"靠什么

靠**模型读 `description` 自己选**（上面那张图）。于是：

- `x.keywords` / `x.intents` **仍然保留**，但只服务于**非运行时**的用途：
  SkillHub 格式往返（`lib/application/agent/skill-md.js` 的 `x-recallflow-keywords` / `x-recallflow-intents`）、
  用户自定义技能的存取（`lib/application/agent/skill-store.js`）、技能编辑页的展示（`skills-page.js`）。
- 触发条件写得再准也不会自动提升命中率 —— **只有 `description` 那一行会影响模型的选择**。
  这就是本仓库反复强调"文案要准"的原因：模型能看到的只有那一行。

### 将来要接回运行时怎么办

那是**行为改动**（模型可见内容变了 ⇒ 正确率可能升也可能降），必须**先测量再上**：

1. 按 [`regression-red-flag.md`](regression-red-flag.md) 的纪律，选同一条场景跑多次真模型 eval；
2. 比较"接回前 / 接回后"的通过率，并把原始输出**追加**到 [`real-model-eval-log.md`](real-model-eval-log.md)；
3. **不要**因为"看起来能省 token / 更精准"就直接接回去 ——
   通用纪律底座的教训是：注入之后通过率从 **5/5 掉到 3/7**（[`regression-red-flag.md`](regression-red-flag.md)）。

## 3 实测：清单上的对应关系，运行时松得多

数字全部来自 [`real-model-eval-log.md`](real-model-eval-log.md)（真模型 `deepseek-flash`，30 条剧本；
逐条明细见该文件「技能 ↔ 场景在运行时比清单上松得多」一节与第五轮的 30 条场景表）：

| 事实 | 数字 | 含义 |
| --- | --- | --- |
| 一个技能都不加载、照样通过的场景 | **10 条** | 清单里"有内置技能"是**资产层面**的对应，**不等于**运行时模型会用它 |
| 加载了"不是自己那条"技能的场景 | **少数几条**（如 `form-validation` 那次加载了 `checkout-form`） | 技能之间不是互斥路由，模型按语义就近挑 |
| 孤儿技能**被别的剧本加载** | `clip-to-knowledge` 被「知识库往返」与「知识库检索回退」加载 | **孤儿 ≠ 没被用** |

⇒ 两条结论：

1. **技能写得多 ≠ 被用上**。评价一个技能，只能看真模型 eval 的轨迹，不能看清单的"一一对应"。
2. **孤儿技能 = 没有自己的验收覆盖**，也就是**改它的文案没法用现有 eval 测量**。
   这是"孤儿"的真实代价，也是 [`skills-overview.md`](skills-overview.md) 非要把它们单列出来的原因。

## 4 文案的硬要求：编号步骤清单

本仓库最贵的一课：**散文式的关键步骤会被模型跳过**。

`readability-fix` 最早是一堆"要改字号 / 行高 / 对比度"的自然段，真模型实测**只改了字号就收尾**，
横向溢出原封不动。把"改行宽"写成**编号第 4 步**并单列说明之后，它才被稳定执行
（详见 `lib/application/agent/skill-defs.js` 里该技能的第 4 步注释）。

所以每个技能的正文要么：

- 有**连续编号、从 1 开始**的步骤清单（≥2 项，中间允许空行与缩进续行）；要么
- **显式声明** `本技能无步骤：<原因>`（原因 ≥6 字，且不能是空话）。

由 `tests/skill-content-structure.test.mjs` 门禁盯着。⚠ 它**只**保证"结构上做得出来"；
"模型真的照做"只有真模型 eval 能回答 —— 静态门禁假装验了它，才是真正的假装通过。

## 5 改动技能的纪律（清单式）

1. 改 `lib/application/agent/skill-defs.js`（正文 / `description` / `x`）；
2. `node scripts/gen-skills-overview.mjs` 重跑生成物（清单与产物不一致会红）；
3. `node scripts/run-all-checks.mjs` 全绿（含新增的结构门禁）；
4. **改了模型可见文本 ⇒ 必须测量**：跑该技能对应的场景（`--grep "<剧本 title>" --repeat-each=2`），
   结果**追加**到 [`real-model-eval-log.md`](real-model-eval-log.md)；
5. 若该技能是**孤儿**（没有剧本），如实写下"**无法用现有 eval 测量**"，并给出最小可行方案
   —— **不要**为了消掉孤儿而硬说"有剧本"（孤儿状态是如实的）。

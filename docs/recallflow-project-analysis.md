# RecallFlow 项目分析

**2026-10 当前状态 · 架构、活跃战场、成熟度与风险**

---

**元信息**

- **分析时点**：2026-10-07 ~ 08（仓库内有日期为 **2026-10-08** 的文档，比会话"今天"还晚一天）
- **依据**：`manifest.json`、`package.json`、`lib/` 源码、`docs/` 全部文档
- **⚠️ 必须先说的一件事**：**这个仓库正在被我之外的会话改动。**
    - 本次分析过程中 `docs/` 里少了几份（`pick-up-here.md`、`two-way-sync.md`、`deletion-plan.md`、`one-session-plugin.md`），又多了四份我没写过的
    - 文档里出现的测试数有**四个版本**：**429 / 475 / 526 / 533**
    - 有的文档说"`integrations/opencode/` 整包删除"，但**本地副本里它还在**，`package.json` 的 `test` 脚本也还在引用它
    - **推断：本地工作副本落后于远端**，或存在多条并行工作线。**下面的状态判断以此为前提。**

---

## 速读：五句话版本

1. **它是什么**：Chrome MV3 扩展，把浏览器变成 AI 助手的操作面——划词即问、让 AI 读页面 / 操作页面 / 记住东西，并带知识库 RAG。
2. **三层结构**：页面层（content script + MAIN-world 钩子 + CDP）→ 助手层（agent 循环 / 工具 / 宏 / 技能 / 站点记忆）→ 宿主层（与 DSH 的 relay + 面板）。
3. **最近的主战场是「请求前缀」**：有人核对并修正了我那份缓存分析，把 5 个前缀破坏点修掉了，并加了**静态门禁 + 运行时哨兵**双重护栏。
4. **工程纪律是它最强的资产**：静态门禁带反向自测、运行时哨兵补静态盲区、幂等性有测试、"不许复活"被测试钉住。
5. **它最大的缺口是「任务级评测」**：有几百项单元测试，但**没有"这个任务做成了吗"的度量**——这正好是我上一份文档讲的那件事。

---

## 目录

- 一、它是什么
- 二、架构：三层
- 三、当前的三个活跃战场
- 四、工程成熟度评估
- 五、风险清单
- 六、建议（按优先级）
- 七、一个不该被忽略的观察
- 附录：来源

---

## 一、它是什么

**从 `manifest.json` 读出的硬事实**

```text
名称 / 版本     RecallFlow / 0.0.1
Manifest        MV3
权限            tabs, storage, contextMenus, scripting,
                notifications, alarms, debugger
主机权限        <all_urls>, http://127.0.0.1/*, http://localhost/*
background      background.js（service worker, type: module）
options_ui      options.html（独立标签页打开）
入口            popup.html
```

**两个内容脚本，分工是关键**

```text
① lib/page/debug-hook.js
   document_start · world: MAIN · all_frames
   → 注入到「页面的 JS 世界」，能碰页面自己的全局变量
   → 这是 manifest 里最值钱的一条设计

② content.js
   document_idle · all_frames
   → 默认的隔离世界，操作 DOM
```

**外加 `debugger` 权限 + `<all_urls>`**，也就是 CDP 那条路（详见我写的 [DOM 与 CDP](dom-and-cdp-explained.md)）。

三者合起来意味着：**它能同时从"页面内部"和"浏览器外部"两个方向操作网页**——这是它区别于任何纯扩展或纯爬虫的地方。

**自述定位**

> 浏览器里的统一 AI 助手——在任意网页上划词即问，让 AI 替你读、操作并记忆，支持基于知识库的 RAG 检索问答。

---

## 二、架构：三层

### 层一 · 页面层

```text
lib/page/
  debug-hook.js      MAIN-world 钩子（manifest 注入）
  debug-capture.js   捕获页面侧的调试信息
  picker.js          元素拾取
  citation.js        页面内引用高亮
  markdown.js        渲染与恢复渲染
lib/backend/
  cdp.js             CDP 输入/感知层（可信事件、AX 树、截图）
```

### 层二 · 助手层（核心）

```text
lib/application/agent/
  agent.js            主循环（1200+ 行）
  tools.js            工具实现（2000+ 行）
  tool-schemas.js     工具 schema（900+ 行）
  tool-metadata.js    风险等级 / 并行安全标记 / 是否需审批
  tool-guard.js       工具守卫
  intent-router.js    意图分类 + 提示词组装
  context.js          历史折叠
  conversation-guard.js  会话结构诊断与修复
  prefix-watch.js     请求前缀哨兵（运行时）
  parallel-tools.js   并行分组决策（纯函数）
  macro-store.js      宏（可回放动作序列）
  site-memory.js      站点记忆（选择器提示）
  skill-*.js          技能体系
  mcp.js              MCP 工具接入
  verifier.js         完成校验（防谎报）
  claim-check.js      声明核查
  session-store.js / trace.js / agent-state.js
```

### 层三 · 宿主层（RecallFlow ↔ DSH）

```text
lib/bridge/relay.js   与 DSH 插件的桥
DSH 侧插件             /say、/status、GET /recallflow/session-log
面板（气泡）           shadow DOM 内的另一个视图
```

**一个关键结论**（来自 10-08 那份交接文档）：

> **面板 = 同一条 DSH 会话的另一个视图。**
> 所以**扩展不能删**——它是唯一能碰页面的那一端：内容脚本、MAIN-world 钩子、CDP。
> 但**气泡可以不要**，用 DSH GUI 替代；代价是划词气泡、页面内引用高亮、rpcId 回声对齐、"不切标签页就能问"这些要重做或放弃。

**旁边还有几块**

```text
lib/userscript/    用户脚本体系（元数据 / 匹配 / 运行 / GreasyFork 集成）
lib/shared/rag.js  知识库检索
lib/shared/handoff-store.js
integrations/...    MCP（文档说整包删除了，但本地还在——见开头的漂移提醒）
```

---

## 三、当前的三个活跃战场

### 战场 A · 请求前缀与延迟（已完成一轮，是本仓库目前最漂亮的一段工程）

**起点**是我写的那份 [RecallFlow 慢，是缓存命中率的问题吗](recallflow-slow-cache-analysis.md)。后来有人**逐条回到代码取证 + 对照 DeepSeek 官方缓存文档**，出了一份 [核对与修正](recallflow-cache-analysis-review.md)。

**修正了我三处错，并补了三件我完全没提的事**（这份核对我认为做得很扎实）：

```text
修正 1  站点记忆 / 宏目录不影响「单个 run 内」的缓存
        因为 promptExtras 在 for 循环之前就算好了
        （不影响跨 run 的复用）

修正 2  漏了更严重的一个：tools 数组在 run 内会变
        tools.filter(...)（工具被停用）
        tools.push(...)（load_skill / 画像提升）
        而 function calling 模板把工具定义渲染在消息之前
        → 前缀从 token 0 就分叉；而工具定义实测约 8.3k token/轮

修正 3  我给的「把计划消息挪到末尾」的修法不成立
        因为下一轮它就不在末尾了，任何被替换的消息
        必然已经落进前缀中部
        → 正确解：取消独立计划消息，把计划放进 update_plan 的工具结果里
          （工具结果是 append-only 的）

修正 4  折叠并不是「每轮中部改写」——它只截断 >300 字符的消息，
        折过一次后就被跳过。而且代码注释里已写明这个意图
        → 我的修法 3 其实早就实现了

补充 A  DeepSeek 的缓存是「缓存前缀单元」不是最长公共前缀匹配；
        构建耗时是秒级，而 agent 轮间隔常常也就几秒
        → 「第 2 轮大幅 miss」是正常的，不能当破坏点的证据
补充 B  我的验证方法跑不起来——prompt_cache_hit/miss 从来没被打印过
        只用了 total_tokens
补充 C  默认模型是 deepseek-chat，全仓库搜 thinkingLevel 零命中
        → 我那条「检查 thinkingLevel 降档」的建议是错的
```

**然后修完了**（文档称 429 项测试全绿）：

```text
① 停用工具不再从 tools 摘除，改为执行层拒绝 + continue
② 计划消息整个 run 只注入一次；更新靠 update_plan 的工具结果
③ promoteToResearch 改为追加 system 消息，不再覆写 messages[0]
④ 次级排序键改成字典序（selector / name）→ 集合不变则提示逐字节一致
⑤ 折叠阈值 60000 字符 → CONTEXT_COLLAPSE_TOKENS = 16000（按 token），并打日志
⑥ 缓存可观测性：解析并记录 hit / miss 与命中率
⑦ 收尾请求不再传 tools: []（那是全 run 最长的一次请求，原本必然全量重算）
   → 改成照发 tools + tool_choice: 'none'
⑧ collapseOldToolResults 改为真正幂等
```

**并且加了双重护栏**——这是我认为最值得学的地方：

```text
静态门禁  scripts/check-prefix-stability.mjs
          R1 禁止 messages[0] = ...
          R2 禁止 unshift / shift / pop / sort / reverse
          R3 splice 全文最多一处且必须在主循环之前
          R4 计划注入只允许在主循环之前
          并带【反向自测】：断言它在复刻的旧写法上全部命中
          ——「一个永远返回空的检查器也能通过」这个问题被正面解决了

运行时哨兵 lib/application/agent/prefix-watch.js
          每轮出站前把 messages 压成指纹，与上一轮实际发出的逐条比对
          一旦不是纯追加就打印 + 写 trace
          用 canonicalize 递归序列化（不手写字段列表，避免将来加字段时静默失效）
          区分 rewritten / inserted / truncated 并给出分叉位置
          → 补上静态门禁的盲区（循环内调用一个内部改写中部历史的函数）
```

**紧接着是延迟侧**（[recallflow-latency-options.md](recallflow-latency-options.md)）：

```text
已完成：分阶段计时 ttfb / prefill / decode / tools / total，每轮打印
已完成：只读工具并发执行
        runParallelBatch + planParallelGroups（纯函数，可穷举测试）
        关键设计：只并行「执行」，不并行「后处理」
        —— 循环体内所有顺序敏感逻辑一行没动
        安全边界三条同时满足才进批次 + 只对相邻调用成组
        故意排除 expand_result / get_run_trace / take_screenshot
        （它们依赖执行后的串行后处理）
        回退开关 settings.parallelToolCalls = false
        22 个测试用例

待办：verifier 多一次串行 LLM 往返（默认开、15s 超时、4000 字符证据）
     意图分类在 Agent 开工前被 await
     没有 max_tokens（非思考模式默认 8K，一轮啰嗦能吃掉 2–4 分钟）
     每轮固定 8.3k token 的工具定义
```

**结构上限被明确点出来了**：

```text
maxModelTurns: 30, maxToolCalls: 40, maxDurationMs: 180000
→ 30 轮 × 每轮至少一次串行往返，就是总耗时的下限
→ 降低轮数是唯一能改变量级的手段
```

### 战场 B · 会话结构合法性（「400 空响应体」）

**症状**：跑几轮后报 `DeepSeek 请求失败 (400):`，**冒号后什么都没有**。

**根因**：客户端发出结构非法的请求——assistant 声明了 N 个 `tool_calls`，但只有前 k 个拿到 `tool` 结果。DeepSeek 对这类请求**不回原因**。

**有意思的一点**：文档指出**「空响应体」本身就是线索，不是信息缺失**——正常 400 会带 `{"error":{"message":...}}`，空的说明是解析阶段就拒了。

**三条非法路径**：两处 `complete_task` 判定失败后 `break` 去注入反思（剩下的 tool_call 永远拿不到结果）；第三处是 `finalizeWithPartialInfo`——它**绕过主循环的出站校验**，而调用它的全都是"半途中断"时刻，恰恰是历史结构最可能残缺的时候。

**修复分三层**：

```text
第一层 修根因   新增 fillRemainingToolResults，
                跳出前给未处理的 tool_call 补结果
                措辞讲究：补的是「该调用未纳入结果，请勿假设它已执行」
                （因为并行预执行可能已经跑过了，说"未执行"是假话）

第二层 出站自检 新增 conversation-guard.js
                diagnoseConversation（说人能读懂的话，指出第几条、哪类错）
                repairConversation（修复并保证修复后合法）
                挂两处：主循环出站前 + finalizeWithPartialInfo 内部
                覆盖 7 类结构错误

第三层 自证     400 时把请求形状补进错误信息（只有角色序列与计数，无内容）
                [请求形状：model=… messages=7 roles=system,user,asst(tc),tool,…]
```

**一个值得注意的细节**：它没有复用已有的 `sanitizeToolPairing`，因为属性测试发现后者**修不好「配对被打断」**——拿它当兜底等于"记完日志照样发非法请求"。

### 战场 C · DSH 集成（进行中）

从 10-08 的交接文档看，最近这一段在做：

```text
- 删除 7801 桥接链路（用户"不用 opencode 了"），只留 DSH
  ⚠️ 这一条**与工作树不符**：截至本次核对，lib/bridge/relay.js 仍在、
    integrations/opencode/recallflow-mcp/ 仍在（且 background.js 仍调用 startMcpRelay()）。
    唯一事实来源见 docs/integration-status.md；本行保留原貌以记录当时的意图。
- 会话选择器（加了又按用户要求撤掉，并用测试钉住"不许复活"）
- 只读会话历史路由 GET /recallflow/session-log?sessionId=&limit=
  能读任意会话（含没载入的），投影用面板同一套 projectEvent
- 元素的摘要送进对话（标签/选择器/文本/源码四个字段到达模型侧）
- 四个修复：对象字段格式化、WS 回声竞态导致的重复发送、chip 不消失、恢复路径 markdown
```

**踩过的坑被记成了可复用的条目**，其中三条我认为有普适价值：

```text
① 看不见的路径不算数
   面板在 shadow DOM 里，普通 DOM 快照看不到
   → 关键状态一律写进 /status

② 单测喂的形状必须和真机一致
   elementsDigest 的 [object Object] 就是因为单测喂字符串、真机给对象

③ 顺序错了会静默重复
   sendPanelTurn 是异步的，推送游标原来只在 .then() 里推进
   而回声走 WS 可能先到 → 那条用户消息被再发一遍
   修法：发起发送【之前】就推进游标
   → 「静态断言（A 必须在 B 之前）是这类 bug 最便宜的闸」
```

---

## 四、工程成熟度评估

### 强项（这个仓库的资产）

```text
① 门禁带反向自测
   check-prefix-stability 不满足于"当前代码通过"，
   还断言它在复刻的旧写法上必须命中
   → 直接解决了"空检查器也能通过"这个通病

② 静态 + 运行时双层护栏
   静态门禁抓词法模式，运行时哨兵抓闭包/间接改写
   而且哨兵有一个用例专门复刻当年的 syncPlanMessage 形态
   → 明确承认并补上了静态检查的盲区

③ 幂等性被当回事
   collapseOldToolResults 的重复拼接被测试抓出来并修掉
   折叠计数不再虚报

④ 属性测试用在了对的地方
   repairConversation 的"修复充分性"用属性测试：
   十种结构错误，每一个修完后诊断必须为空
   → 当场抓出了 sanitizeToolPairing 的能力缺口

⑤ 顺序敏感性没有为了性能让步
   并行工具只并行"执行"，后处理一行没动；
   调度决策抽成纯函数，因为"调度判错的代价远高于执行本身"

⑥ 有回退开关
   settings.parallelToolCalls = false 一键退回串行
   收尾请求被 400 拒绝时自动退回不带 tools 重试
   → "前缀缓存是优化，拿到结论才是功能"

⑦ 文档纪律
   有交接文档、有要点清单、有 commit hash、
   有"已确认的事实（别再重新猜一遍）"这一节
```

### 弱项与风险

见下一节。

---

## 五、风险清单

**R1 · 单点巨物**

```text
agent.js        1200+ 行（主循环 + 提示组装 + 工具调度 + 预算 + 收尾）
tools.js        2000+ 行（所有工具实现）
tool-schemas.js  900+ 行
```

主循环里同时住着：前缀拼装、预算控制、并行调度、会话结构校验、守卫、收尾。**前缀稳定性这种全局不变式，恰恰是因为散落在这些位置才出过 5 个破坏点。**

**R2 · 本地副本与远端漂移（本次分析就撞上了）**

```text
- docs/ 里少了几份、多了几份
- 测试数四个版本并存：429 / 475 / 526 / 533
- 文档说 integrations/opencode/ 整包删除，本地还在，package.json 还在引用
```

**危害**：任何人（包括 AI）基于本地副本做的判断都可能已经过时。**我这次的分析就有一部分建立在可能已过时的前提上。**

**R3 · 文档与代码的时间差**

`recallflow-latency-options.md` 说并行工具"收益仍未被实测确认"，`recallflow-cache-analysis-review.md` 说"埋点已加好，下一步跑 Step 1 验证"——**也就是说修完了但还没验收**。

**没有实测数据的优化，本质上还是假设。**

**R4 · 模型档位假设未清理**

```text
settings.js 默认 model: 'deepseek-chat'
而 DeepSeek 官方当前列的是 deepseek-flash / deepseek-v4-pro
→ deepseek-chat 很可能是 legacy 别名
```

核对文档自己也标注了这一点，但**有意没改**（"不在本次缓存修复范围内"）。这是对的——但它是一个待办。

**R5 · 缺「任务级」评测（最大的缺口）**

```text
有：几百项单元测试、静态门禁、属性测试、e2e（playwright）
没有：任务成功率、pass^k、单位成功成本、延迟分布
```

所有测试都在验证**代码行为**，没有一个在验证**这个 agent 能不能把事办成**。

这直接对上我上一份文档 [怎么评价 Agent 的成本与质量](agent-cost-quality-evaluation.md) 说的——**质量不是一个数，是分层的证据**，而这里的"成功"目前大概率仍停留在 L1（模型自评"我做完了"）。

**R6 · 浏览器自动化的合规面**

```text
all_urls + debugger + MAIN-world 注入 + CDP 可信事件
```

能力越大，被滥用的面越大。仓库里有 `trust_site`、工具风险等级、审批机制——**设计是在的**，但缺一份"哪些站点/哪些动作绝对不做"的成文边界。

---

## 六、建议（按优先级）

**第 1 件｜做一次「任务级」评测，哪怕只有 20 个任务**

```text
这是当前投入产出比最高的一件事。理由：
- 它不需要改架构
- 它能验证前面几轮优化的真实收益（现在全是"应该有效"）
- 它正好补上 R5 那个缺口

最小版本：
  20 个真实任务 × 3 个配置（规则基线 / 宏回放 / 逐步驱动）× 5 次
  记录：成功率、pass^k、单位成功成本、延迟 p50/p90
  并且——把"成功"的判据从模型自评升级到【可执行检查】
  （页面状态确实变了 / 目标元素出现了）
```

**第 2 件｜把已经修好的东西验证掉**

```text
- 跑一次带埋点的真实任务，看 cache hit 曲线
  （第 2 轮低是正常的，看第 3 轮之后）
- 看 parallel-batch-done 的 wallMs 是否真的小于各工具耗时之和
- 看 prefix-watch 有没有打印过

如果 prefix-watch 从来没打印过 → 前缀确实是 append-only，
静态门禁 + 哨兵这套组合拳可以宣告成功
```

**第 3 件｜解决本地/远端漂移**

```text
文档里已经有 commit hash（aa55f5a、f47e392、…）。
要么同步到本地，要么在文档开头明确写"本地副本落后于远端，以远端为准"。
否则下一个接手的人（或 AI）会重复踩我这次的坑。
```

**第 4 件｜拆 agent.js**

```text
不必大重构，先按"不变式边界"拆：
  前缀拼装 → 独立模块（它已经有 prefix-watch 了，把拼装也挪过去）
  预算/守卫 → 独立模块
  收尾     → 独立模块
理由：前面 5 个前缀破坏点全部产生于"拼装散落在主循环各处"
```

**第 5 件｜确认模型档位并清理 legacy 假设**

**第 6 件｜把 prefix-watch 的日志接到 UI**

现在只在控制台。**用户看得见的东西才会被在意**——这条和 10-08 那份文档里"关键状态一律写进 /status"是同一个道理。

---

## 七、一个不该被忽略的观察

这个仓库的**工程纪律**，是我在这整个会话里见到的最高的一档：

```text
静态门禁 + 反向自测          —— 防止"空检查器也能通过"
运行时哨兵                    —— 明确承认并补上静态检查的盲区
属性测试                      —— 用来证明"修复是充分的"，不只是"某例通过"
幂等性测试                    —— 连"重复拼接内容相同"都算 bug
"不许复活"测试                —— 用测试钉住一个被撤掉的功能
回退开关                      —— 优化失败时功能优先
交接文档带 commit hash 和"别再重新猜"清单
```

**这恰好回答了你前面问的那个问题**——"怎么评价一个 agent 的成本和质量"。

你已经把**代码质量**这一层做到了很高；缺的是**任务质量**那一层。前者能靠单测和门禁保证，后者只能靠**真实任务的多次运行**。

所以如果只做一件事：**补上那个 20 个任务的评测。**它会把"我修好了"变成"我验证过了"。

---

## 附录：来源

**本仓库（第一手）**

- **S1** `manifest.json` —— 权限、内容脚本、world 设置
- **S2** `package.json` —— 脚本与测试入口
- **S3** [docs/recallflow-cache-analysis-review.md](recallflow-cache-analysis-review.md) —— 对我那份缓存分析的核对、四处修正、修复落地与门禁设计
- **S4** [docs/recallflow-latency-options.md](recallflow-latency-options.md) —— 分阶段计时、并行工具、剩余延迟项
- **S5** [docs/recallflow-400-empty-body.md](recallflow-400-empty-body.md) —— 会话结构非法的根因与三层修复
- **S6** [docs/recallflow-dsh-keypoints.md](recallflow-dsh-keypoints.md) —— DSH 集成要点、已确认事实、踩坑清单
- **S7** [lib/application/agent/agent.js](lib/application/agent/agent.js)、[lib/application/agent/tools.js](lib/application/agent/tools.js)、[lib/application/agent/macro-store.js](lib/application/agent/macro-store.js)、[lib/application/agent/tool-schemas.js](lib/application/agent/tool-schemas.js)、[lib/backend/cdp.js](lib/backend/cdp.js)

**本文引用的自己写的相关文档**

- **S8** [RecallFlow 慢，是缓存命中率的问题吗](recallflow-slow-cache-analysis.md)（被 S3 修正的那份）
- **S9** [怎么评价一个 Agent 的成本与质量](agent-cost-quality-evaluation.md)
- **S10** [浏览器的 DOM 与 CDP 是什么](dom-and-cdp-explained.md)
- **S11** [把宏当函数来管](macro-as-function.md)

---

*本文的架构判断来自 S1/S2/S7 的代码（第一手）；活跃战场描述来自 S3–S6 的文档（**这些文档写于我无法验证的时点，且仓库正在被其他会话改动**）；第四节评估与第六节建议为本文判断。**动手前请先确认本地副本与远端是否一致。***

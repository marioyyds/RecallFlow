# RecallFlow Agent 工程审查结论

> 一份 12 轮的架构 / 工程 / agent 设计 / UX 审查结论。目标是为「操作网页一切元素 + 开发者调试助手 + 对话助手」这一产品方向服务。
>
> 阅读方式：先看[结论摘要](#结论摘要)与[验证状态](#验证状态我证明了什么没证明什么)，再看[遗留债务与优先级](#遗留债务与优先级)。

---

## 结论摘要

12 轮里做了三件性质不同的事：

1. **两个真实安全漏洞**（都在「模型输出 + 页面文本 → 注入 DOM」这条不可信输入路径上），其中一个是可直接执行的属性注入。
2. **架构收敛**：两个巨型模块从 2568 + 3027 行降到 2181 + 2049 行；抽出的纯逻辑层全部补上单测，测试文件增至 23 个、**382 项用例通过**（评测基线见[验证状态](#验证状态我证明了什么没证明什么)——我没有保留旧版用例数，因此不复述它）。
3. **把"看起来对"变成"可验证"**：注册表一致性门禁、prompt 体积预算门禁、跨端桥接契约门禁、以及一套可重复运行的 MCP 假扩展验证台。

同时也留下了明确的未完成项，以及**我在过程中犯的五次错误**（四次是测量/工具错，一次是没读就下判断）——都记在[我犯的错](#我犯的错)里，因为那些教训比结论本身更容易复用。

---

## 一、量化：先测量再动手

所有优化决策都基于实测数字，而不是"看起来很多"。

### 工具定义的真实成本

工具定义**每一轮**都随请求发出，因此它的体积是持续成本。用本仓库自己的 `estimateTokens`（CJK 按 1 token/字、非 CJK 按 1/4）实测：

| 意图 | 工具数 | 每轮下发的定义 | 30 轮累计 |
|---|---:|---:|---:|
| `browser_task` | 43 | **8,341 tokens** | ≈ 25 万 |
| `research_task` | 38 | 7,295 tokens | ≈ 22 万 |
| `chat_task` | 16 | 2,166 tokens | ≈ 6.5 万 |
| `knowledge_task` | 8 | 1,310 tokens | ≈ 4 万 |
| 全量 | 55 | 9,973 tokens | — |

**重要限定**：这些数字是**请求体积**，不等于计费。工具块位于请求前缀且每轮不变，命中服务端前缀缓存时单价远低于原价；只有首轮与缓存未命中付全价。我无法从本地测出真实计费，因此不宣称节省了多少钱。

### 字节构成（决定优化方向）

| 部分 | 字符数 | 占比 |
|---|---:|---:|
| 工具描述 | 12,281 | 31% |
| 参数定义 | 18,481 | 47% |

其中七个通用定位参数（`ref`/`selector`/`text`/`role`/`name`/`testid`/`index`）跨 **100 个实例重复描述**，合计 8,908 字符——而它们的优先级顺序在系统提示里已经写过一次（`buildSystemPrompt` 规则 9）。

**已做的精简**：100 处参数描述统一 + 我此前写得过长的 6 个工具描述重写。
**净效果**：全量 39,318 → **36,811 字符（−6.4%）**；`browser_task` 33,330 → **30,847（−7.5%）**。

**结论：参数已接近下限。** 每个约 90 字节里约 40 是 JSON 样板，正文只剩 25–45 字节。再压只能删掉描述本身，会损害模型理解。**真正的大幅削减只能靠减少工具或参数数量，那是产品取舍，我没有单方面做。**

---

## 二、安全：两个真实漏洞

两个都在同一条路径上：**`escInline` 转义了 `&` `<` `>`，却漏了引号**，而不同渲染点对链接的处理不一致。

### 漏洞 1：链接属性注入（可直接执行）

```
输入: [点我](x" onmouseover="alert(1))
修复前: <a href="x" onmouseover="alert(1" target="_blank">点我</a>
                        ↑ 事件处理器被注入
```

**为什么这是可执行的而非理论风险**：面板注入在**页面**里，而 **shadow DOM 不隔离脚本**，注入的处理器会真实执行。加上提示注入可让页面把恶意链接喂给模型再回显，攻击链完整。面板又是"可信 UI"，用户点它时以为安全。

同类还有：`javascript:` 协议、大小写混淆（`JaVaScRiPt:`）、前导空白与控制字符绕过。

**修复**：新增 `sanitizeHref()` 安全原语——剔除控制字符后按白名单放行（仅 `http/https/mailto/tel` 与相对路径），危险协议**只保留文字、不生成链接**；补上引号转义（**只补引号**，以免把已转义的 `&` 变成 `&amp;amp;` 破坏 URL）；顺带加 `rel="noopener noreferrer"`。

### 漏洞 2：`window.open` 未校验协议

```js
const safe = sanitizeHref(url);           // url 来自 data-cite-url（页面/模型可控）
```

关键细节：**`new URL('javascript:alert(1)')` 能正常解析**（origin 为 `null`），所以原有的"同页判定"挡不住它。

**诚实说明**：现代 Chrome 会阻止顶层导航到 `data:` URL，`window.open('javascript:…')` 也被拦。所以这一条更像**加固**（不依赖浏览器特定拦截行为），而不像漏洞 1 那样可直接利用。我没有夸大它。

同时把"能不能打开"抽成纯函数 `planCitationOpen(url, currentHref, snippet)` → `highlight | open | deny | none`，让这条安全策略**可测**（6 个用例，专门锁住"javascript: 能骗过同页判定"）。

---

## 三、架构收敛

### 拆解结果

| 模块 | 前 | 后 | 抽出到 |
|---|---:|---:|---|
| `lib/page/chat.js` | 2568 | **2181** | `markdown.js`(462)、`panel-css.js`(364) |
| `lib/assistant/tools.js` | 3027 | **2049** | `tool-schemas.js`(915)、`tool-metadata.js`(65) |

**方法**：用脚本按行区间精确搬运，**从不手工转写**。每次搬运都先验证前置条件，再做等价性证明：

- 抽 `markdown.js`：逐项核对"每个导出是否都被 import"，抓出 **2 处悬空引用**（`renumberCitations`、`stripOptionsBlock` 搬走了但调用点没改）——这类错误 `node --check` 查不出来，只会在运行时炸。
- 抽 `tool-schemas.js`：先固化注册表**指纹**（含完整 `inputSchema` 的 SHA-256），抽取后比对：`7a36db68e800191f` 完全一致。
- 抽 `panel-css.js`：先确认 CSS 体内**无模板插值、无反引号**（否则就不是纯字符串、搬走会破坏依赖），抽取后逐字比对（356 行 == 356 行）。

### 新增的纯逻辑模块（都在 node 中可直测）

| 模块 | 行数 | 职责 |
|---|---:|---|
| `lib/assistant/tool-schemas.js` | 915 | 55 个工具的 Schema（唯一来源） |
| `lib/page/markdown.js` | 462 | 模型输出 → HTML 渲染 + 引用 + `sanitizeHref` |
| `lib/page/panel-css.js` | 364 | 面板样式（纯字符串） |
| `lib/shared/table.js` | 125 | `rowspan/colspan` 网格展开算法 |
| `lib/assistant/claim-check.js` | 103 | 完成类断言的确定性预检 |
| `lib/shared/bridge-methods.js` | 27 | 跨端桥接方法名唯一来源 |

---

## 四、四道门禁（把"静默漂移"变成红灯）

| 门禁 | 守住的漂移 | 位置 |
|---|---|---|
| **工具注册表一致性** | 新增工具却忘登记元数据 → 被静默降级为 `risk:'unknown'` + `requiresApproval:true` | `tests/registry.test.mjs` |
| **prompt 体积预算** | 工具定义无声膨胀（总量 + 逐意图两档） | `tests/registry.test.mjs` |
| **跨端桥接契约** | MCP 调用的方法名与扩展 dispatch 分支漂移 → 运行时 `unknown method` | `tests/bridge-contract.test.mjs` |
| **意图白名单有效性** | 白名单指向已删/改名的工具 | `tests/registry.test.mjs` |

最后一条特别值得说：它还断言 `page_screenshot` **必须在通用包装前单独分支**——否则将来有人改回通用路径，图片会被 `JSON.stringify` 成文本而**静默失效**。

### 门禁立刻抓到了东西

工具注册表门禁第一次运行就红了：`add_entry` 的 `risk: 'write'` 不在我猜的允许集合里。我去查全量分布，发现真实词汇是 **8 个**（`read`/`page`/`write`/`destructive`/`browser`/`network`/`external`/`high`），而**我凭印象猜的集合只有 6 个、还多了不存在的值**。

顺带发现更有价值的不变量：`agent.js` 的 risk → 审批类别映射，源码注释自己承认「会静默错配」。于是我把它写成结构性断言：**需要审批（且非逐次审批）的工具，risk 必须在显式映射集合内**。今天的 55 个工具全部满足，但以后新增能立刻发现。

---

## 五、B6：MCP 视觉通道（含端到端验证）

**问题**：外部 MCP 客户端（opencode / DSH）此前无法"看到"页面。

**实现**：
- 扩展侧 `relay.js` 新增 `screenshot_capture`，复用内置工具同一套降质阶梯（`Page.captureScreenshot` 不支持缩放，体积只能靠 format/quality 控制），并**尊重设置里的 `cdpEnabled` 开关**。
- MCP 侧新增 `page_screenshot`。图片必须是 MCP 的 `image` 内容块，因此**不能走通用的 `JSON.stringify` 包装**，须在 `CallToolRequestSchema` 里单独分支。提供 `includeImage:false` 给纯文本模型。
- 归档函数 `archiveImage` **复用文本证据的目录与命名规则**，因此 `evidence_get(hash)` 也能取回截图元数据。

**验证方法（本轮关键）**：桥接层是最难手工回归的部分——真实调用需要「重载扩展 + 重启 server」，两者都会打断正在使用的 MCP 会话。但端口与 token 都可配置，于是：

1. 在**隔离端口 7802** 起实例（不碰运行中的 7801）
2. 用真实 MCP 协议握手：`initialize` → `tools/list`（12 个工具、参数齐全）→ `tools/call`
3. 写一个**假扩展**：经 `/poll` 领请求、`/result` 回结果，喂进合成 JPEG

结果：

| 验证项 | 结果 |
|---|---|
| 内容块结构 | `[text, image]` —— 确实是 image 块，没被 JSON 化 |
| image 块 | `mimeType=image/jpeg`，data 与假扩展发出的**逐字节一致** |
| `includeImage:false` | 仅 1 个 text 块 |
| 归档落盘 | `.jpg` + `.json` 成对，`kind=screenshot`，图片字节与源一致 |
| 扩展不可用时 | 优雅返回 `isError=true` 与超时文案，不抛异常 |

验证台已提交为可重复工具（`scripts/`，含用法说明），两个脚本都返回非零退出码，可直接当回归用。

---

## 六、agent 设计

### 确定性断言层 `claim-check.js`

**契约：永不返回 `pass`。** 只判 `fail` 或 `unknown`：

- `claim-without-mutation`：声称已完成，但整个任务没有任何写操作
- `all-mutations-failed`：所有写操作都失败了
- `visibility-claim-without-evidence`：声称"看不见了"却没有可见性证据

设计理由是**安全不对称**：误判 `fail` 只是让 agent 多检查一次；误判 `pass` 会让它带着错误结论收尾。

### 成本预算（补上缺失的第四维）

此前预算只有**轮数 / 工具数 / 时长**，没有成本维度，而 `totalTokens` 早就在累加、只是没人用它做闸门。现在补上 `maxTotalTokens`，判定抽成纯函数并把边界锁进测试：

- 上限为 `0`/负数/非数字 → **不限制**（沿用"高上限兜底而非正常态硬墙"的既有原则）
- 用量为 `0`/负数/非数字 → **不触发**（否则"一启动就停"）

同时修正一处**记账漏算**：fallback 估算只看 `messages`，漏掉了每轮重发的工具定义（约 8.3k tokens/轮）→ 会让闸门在实际已超支时仍不触发。

---

## 验证状态：我证明了什么、没证明什么

### 已证明

| 项 | 证据 |
|---|---|
| 纯逻辑层（表格展开、完成断言、渲染/转义、引用策略、建议解析、预算边界） | **382 项单测通过**（23 个测试文件，glob 自动发现） |
| 工具注册表完整性与一致性 | `tests/registry.test.mjs` **19 项**（含 4 项既有） |
| 工具定义抽取的等价性 | 注册表指纹 `7a36db68e800191f` 抽取前后完全一致 |
| CSS 抽取的等价性 | 逐字比对 356 行 == 356 行 |
| XSS 修复 | 修复前的危险输出已**实证**；修复后 `<a>` 的属性集严格为 `href/rel/target` |
| MCP 截图的协议层 | 真实 MCP 握手 + 假扩展走通 image 内容块与归档 |

### 未证明（重要）

| 项 | 原因 |
|---|---|
| **真实扩展的 CDP 截图** | `screenshot_capture` 的采集层需重载扩展才能跑，会打断正在使用的会话 |
| **`page_screenshot` 与真实扩展联调** | 同上 |
| **DOM 路径**（`chat.js` 面板、`picker.js` 拾取器） | 无法在 node 中测；只保证代码级不变量 |
| **两个 XSS 修复的浏览器行为** | 未在真实浏览器中验证 |
| **`data:`/`javascript:` 的实际拦截行为** | 因浏览器与版本而异，未实测 |
| **真实计费影响** | 受服务端前缀缓存影响，无法从本地测量 |
| **`image` 内容块对纯文本模型的影响** | 你当前的 `deepseek-flash` 无视觉；理论上客户端会忽略，但未确认（故提供 `includeImage:false` 出口） |

---

## 我犯的错

这些比结论更值得复用，因为**四次里有三次是"测量/工具"错，不是代码错**。

1. **凭印象猜 `risk` 允许集合**（第 6 轮）。工具注册表门禁第一次运行就红了——错的是我的期望值，不是实现。教训：**门禁断言必须基于实测分布**，我改成"与注册表实际用到的集合完全一致"。

2. **用错系数估 token**（第 7→8 轮）。我用"字符数 ÷ 1.6"，但这个系数对中文是错的；项目里已有考虑 CJK 的 `estimateTokens`，我却用了通用经验值。结果**高估约 2.3 倍**（报 20,831，实际 8,341）。错数字已从代码与测试注释里改正——**错数字写进注释比没有数字更糟**。

3. **XSS 探针的检测器写错**（第 4 轮）。第一版用正则匹配 `onmouseover=`，把 `href` 值里的 `y=`/`z=` 也当成属性，导致修复后仍报"危险"。改成引号感知的属性解析器后才得出正确结论。教训：**检测器错了会得出相反的结论**。

4. **抽取脚本的两个 bug**（第 10 轮）。注释剥离正则漏了 `m` 标志（`$` 只在整个字符串末尾生效），导致散文注释里的 "CSS" 被误判为未替换引用；校验器又有 off-by-one，让我一度以为 CSS 内容不一致。两次都是**我的工具错**。

另有一次值得记：**测试期望值手数字数出错两次**（`parseSuggestionOptions` 的 12 字标签边界），最后改成 `'标'.repeat(12)` 构造——**别手数**。

5. **没读就断言文档过时**（第 6→12 轮）。我在中途的报告里说"`docs/tool-design.md` §9 的工具表未收录新工具"，直到写这份文档、真正打开它核对时才发现：**该文档根本没有每工具表**，而且它的 §9 risk 枚举表（8 个值）与我后来"实测得出"的集合**完全一致**——我等于把一个正确的文档判为过时，还为此"发现"了一个不存在的问题。教训：**断言别人过时，比断言代码有 bug 更需要先读**。

---

## 遗留债务与优先级

### P0：结构性削减工具数与参数

现状 **55 个工具**，远超项目自己 `docs/tool-design.md:119` 定的目标（≤ 25 个）。这是最大的结构性债务，也是唯一能显著降低 prompt 体积的路径。**我没有单方面做**，理由是：

- 不同 `risk` 等级不能混（会破坏审批语义），不同 `route` 不能混（content vs background），必须逐对论证
- 取消某意图的工具**有行为风险**：agent 中途需要它就会失败。例如 `chat_task` 带着 5 个调试类工具（`read_console`/`read_network`/`get_ax_snapshot`/`list_frames`/`get_element_source`），对纯对话是过度配置 —— **实测**去掉它们从 2,166 → 1,486 tokens（省 **31%**，不是 48%；我先前那个 48% 是用字符数粗估的产物）—— 但这是产品取舍

体积预算门禁已就位，无论你怎么决定，成本变化都会在测试里显式可见。

### P1：`chat.js` 的有状态逻辑仍未拆

已切掉样式与一个解析函数，但**面板 UI 与流式状态机仍混在 2181 行里**。这轮没碰它，因为它依赖大量闭包状态，且 DOM 路径无法单测——风险收益比不如前面几项。

### P2：文档滞后

核对过 `docs/tool-design.md` 后，实际滞后的只有两处（我此前在本轮报告的草稿里断言"§9 工具表未收录新工具"，**那是错的——该文档没有每工具表**，我没读就写了）：

- **`:149` 写着"内置工具已达 50 个"**，实际已 55（该文档 §10 的目标 ≤25 仍然有效）。
- **`:151`"写操作批量参数尚未推广"**：`set_element_style` 现已支持 `selectors[]` 批量（≤20），这一项部分完成。

反过来，该文档有两处**经我实测确认无误、无需修改**：

- **§9 的 risk 枚举表列了 8 个值**（`read`/`page`/`browser`/`network`/`write`/`destructive`/`external`/`high`），与本轮实测的注册表实际取值**完全一致**。
- **§12 已自行记下"视觉标注类（`highlight_text`/`outline_element`/`set_element_style`/`clear_page_overlays`）功能重叠、可评估合并"** —— 我的独立分析和它得出同一结论（这四者 risk 与 route 相同，是合并的低风险候选）。

### P3：其它

- **B5 剩余**：只有 token 总量闸门，没有按工具/按阶段的成本归因
- **`page_screenshot` 的整页截图**：极端情况下（超长整页 PNG）可能仍拿不到图（上限 400,000 base64 字符）
- **`runner.js` 的 `GM_addElement` 支持 `innerHTML`**：经查那是 Greasemonkey API 的既有语义，调用方是用户自己安装的脚本（本来就有完整 DOM 权限），**不属于新增攻击面**，改它反而破坏兼容性——记录在案以免后人重复排查

---

## 如何验证与回滚

```powershell
# 跑全部测试（382 项）
node --test "tests/*.test.mjs" "integrations/opencode/recallflow-mcp/test/*.test.mjs"

# 桥接层端到端验证（隔离端口，不碰运行中的 7801）
$env:RECALLFLOW_MCP_PORT='7802'; $env:RECALLFLOW_EXT_TIMEOUT_MS='3000'
$env:RECALLFLOW_EVIDENCE_DIR="$env:TEMP\rf-evidence-test"
node integrations/opencode/recallflow-mcp/index.js --http   # 后台
node scripts/verify-mcp-shot.mjs
node scripts/verify-mcp-shot-success.mjs

# 让 page_screenshot 对真实扩展生效（两步都会打断现有 MCP 会话）
#   1) 重载扩展（edge://extensions）
#   2) 重启常驻 server：
Get-NetTCPConnection -LocalPort 7801 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
node D:\Desktop\workspace\code\ai\bookmark-sorter\integrations\opencode\recallflow-mcp\index.js --http
```

**回滚**：本轮成果是 4 个本地提交（`a460044..HEAD`），**尚未 push**。

```powershell
git reset --soft a460044    # 内容全部保留为已暂存，工作区不丢任何改动
```

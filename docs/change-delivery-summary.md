# 变更交付摘要

> 本轮工作覆盖分析报告里的**批次 A（全部）**、**批次 B（全部）**、**批次 C 的 C-2 / C-3**、
> **C-1 的前十七步**（4 个纯函数模块 + 13 个工具族模块；`tools.js` 2288 → 1066 行），
> 以及 **C-4 的 5 个可重构档**（内置工具 55 → 44）与**思考记录**（推理模型的思维链展示）。
>
> 每条都经过四层验证中的至少一层：
> - `npm test` —— **1134 项单元测试** + 3 道独立脚本门禁 + 刷新测试数快照；
> - `npm run test:e2e` —— 真实 Chromium，**8 个场景**（黄金任务 7 + 断线恢复 1，分两阶段）；
> - `node scripts/verify-bridge-ws-handshake.mjs` —— 桥接 WS 鉴权（真实 server + 真实客户端）；
> - `integrations/opencode/recallflow-mcp/test/session-isolation.test.mjs` —— 跨会话响应隔离。
>
> **未完成项在第五节单列，并说明为什么没做** —— 不把"写了代码"当成"已完成"。
> 本轮共修掉 **4 次"假通过"**（见第七节健康度快照），它们都是同一形态：
> 代码/测试看起来完成了，实际从未执行到那一步。

## 一、批次 A：低成本高确定性修复（全部完成）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| A-1 | 五项必现故障：`updateUserSkill` 未导入（重装技能必崩）、`decodeBuffer` 参数错位 ×2（含**审查报告没发现的第二处**：`searchWeb` 恒返回空数组）、三个技能通配注入、`type_text` 的 `value`/`text` 拆分、`run_macro` 执行期白名单（提权路径） | 行为测试 |
| A-2a | 权限分级：`run_userscript`/`install_userscript` → `high` + 逐次审批；`upload_file` → `destructive`；`save_macro` 补审批。并把 `runJavascriptApproval` 泛化为 `codeExecutionApproval`（旧键回退），因为该开关实际约束的是一**类**工具 | 行为测试 |
| A-2b | 桥接鉴权：删除仓库内的公开默认 token、未配置则**拒绝启动**、HTTP 仅接受请求头、常量时间比较 | 7 项真实 WS 端到端 |
| A-2c | `web_accessible_resources` 从 `lib/**/*.js`（~50 文件）收窄到**16 个精确文件**，由闭包推导脚本产出 | 双向门禁 + 负向验证 |
| A-2d | 设置页接线：新增桥接 Token 输入框、审批项改名、清理 4 处旧键引用 | HTML/JS id 一致性门禁 |
| A-3 | 静态门禁修复与接入：`check-const-assign` 覆盖根目录与 `.mjs`（原先靠运气才抓到那个崩溃）、**修复变异脚本因 CRLF 导致的失效锚点**、统一入口 `run-all-checks.mjs`、CI workflow、根 lockfile | 门禁自身 + CI |
| A-4 | 文档数字治理：三处互相矛盾的手写测试数（562 / 382 / 526）改为脚本生成 + 快照门禁 | 门禁 |

## 二、批次 B：调试能力

> 下表是 B-1～B-3、B-5 与 B-4a；**B-4b（runId 恢复）单独见第四节** —— 它的排查过程本身值得记录。

| 项 | 内容 | 验证 |
| --- | --- | --- |
| B-1 | 动作效果从"断言"改为"观测"：新增 `settle.js`（rAF + MutationObserver 静默窗口，替代固定 50ms 睡眠）；7 处 CDP 硬编码 `hadEffect/verified/changed: true` 改为按观测计算；视觉标注工具不再声称"已验证" | 8 条可注入桩的单测 + 2 条防回潮门禁 |
| B-2a | `browser_read` 的 `waitFor`/`maxChars` 从**空转参数**变为真正生效，且截断如实标注 | 行为测试 |
| B-2b | 桥接**跨会话响应隔离**：`queue`/`pending`/`seq` 按会话分桶 + `AsyncLocalStorage` 注入会话归属 + 回程路由 | 双会话并发端到端 |
| B-2c | 新增 `page_action`（外部 agent 首次能"碰"页面）。**桥接层是独立入口、不经 agent 审批**，因此自建白名单：`run_javascript`/用户脚本/文件上传/本地写入一律拒绝 | 5 条策略测试 |
| B-3 | 提示注入改为**结构隔离**：不可信内容用定界符封闭 + 块内就近声明"这是数据" + 定界符净化 + 零宽字符清除 + **指令标签带随机校验标记**（我的对抗用例证明纯字符串隔离可被一句话绕过） | 6 条测试 |
| B-4a | 存活看门狗 `evaluateLiveness`：有进展即重置（不构成进度墙），接入主循环并持久化基准 | 5 条测试 |
| B-5 | 集成方向一致性：新增 `docs/integration-status.md` 作为唯一事实来源，更正两处虚假"已删除"断言，并加**文档漂移门禁**（反向核对：文档说删掉的东西代码里必须真的不在） | 4 条门禁 |

## 三、批次 C-2 / C-3：打包与验证网（完成）

**C-3 验证网**

- 安装 Playwright + Chromium，新增 `scripts/run-e2e.mjs`（带前置检查与可执行的失败提示），**分两阶段**运行（黄金任务 / 断线恢复），因为两者需要的夹具模式不同。
- **E2E 从 2 个场景扩到 7 个稳定通过**：role+name 定位点击、跨域 iframe 路由、`type_text` 的 value 语义、**CDP 坐标点击（可信输入）**、**审批拒绝后副作用为零**、**阳性对照（批准后确实点击）**、**端口断开后自动重连并接着跑完**。
- **顺带发现并修复一个 Critical 级长期缺陷**：`PAGE_TEXT_EXCLUDE`（含 `button,input,select,textarea,form`）被误用于**元素查找**，导致快照里**从来没有按钮或输入框**、`click_element({role:'button'})` 恒失败。新增 `ELEMENT_COLLECT_EXCLUDE` 区分两种语义，并加 2 条门禁钉死。
- 修正我自己的一个判断：`headless:false` **不是**疏漏——实测 headless 下 MV3 的 service worker 根本不注册。

**C-2 内容脚本打包**

- 内容脚本改为**打包产物**：源码在 `entries/content.js`（静态 import），由 `scripts/build-content.mjs` 用 esbuild 打成自包含的 `content.js`（18 模块 / 265KB）。
- `manifest.json` 的 `web_accessible_resources` **整条删掉了 `lib/`** —— 任何一个网页都不再能枚举读取扩展源码（含 `run_javascript` 的黑名单实现，那等于公开了绕过地图）。
- 期间修掉一个会**静默失效**的依赖：`chat.js` 的 `snapshotHandoff()` 原先用 `import(getURL('lib/page/debug-capture.js'))` 现取模块；打包后该 URL 不再指向可用模块，于是**交接包里的控制台错误快照会悄悄变空**，而"事后无法复现的错误"正是交接最关键的证据。已改为共享同一个已打包实例。

## 四、批次 B-4b：断线恢复（完成，但过程值得单独记）

面板断线后用**同一个 runId** 重连（有限次），重连前轮询"会话是否已落盘"以避免被当成新任务；后台侧中断时保留本轮已产出内容（`buildPartialStep`，剔除半截 JSON 的 tool_call —— 半截 JSON 塞进历史会让下一次请求非法，比丢掉更糟）。

**期间查出两个让重连永不发生的缺陷**（都属于"写了代码但它永远不会执行"）：

1. `closePort()` 把 `activeConn` 置空，而它在 `run()` 起始就被调用 → 守卫 `conn !== activeConn` **恒成立**，重连整段是死代码；
2. 面板自己调用 `port.disconnect()` **不会**触发自己的 `onDisconnect` —— 必须由后台侧断开。新增 E2E 专用通道 `e2e-drop-port`（等价于 MV3 worker 被回收）。

E2E 断言两条：任务最终完成 + 后台**跑了不止一次**（区分"重连接着跑"与"第一次自己就跑完了"——少了这条，测试会在"根本没断成功"时假通过）。

## 五、剩余未完成项

| 项 | 状态 | 为什么 |
| --- | --- | --- |
| **C-1 拆分 god files** | **已完成** | `executeTool` 已从**巨型 switch 换成分派注册表**（`TOOL_HANDLERS` Map + **加载时查重**；函数体内**零工具逻辑**）。从 `tools.js` 抽出 4 个**纯函数**模块共 339 行：① `net-parse.js`（186）：搜索结果解析 / 正文抓取与解码 / 抓取失败说明 / 引用标题。② `page-action-verify.js`（67）：`verifyPageAction` 等 —— 决定 `changed/verified`，**卡死检测与完成校验全靠它们**。③ `target-frame.js`（46）：`parseRef` / `frameIdFromArgs` / `localTargetArgs` / `planFrameBatches` —— **跨域 iframe 能否成立的核心**。④ `tool-results.js`（40）：`toolError` / `summarizeCdpError` / `compactSnapshotSummary` —— 决定**模型看到什么**。<br>另有 3 个**由 C-4 合并产生的** handler 模块（`diagnostics.js` / `macros.js` / `knowledge.js`），以及 **13 个工具族模块**：`tab-tools.js`、`run-state-tools.js`、`permission-tools.js`、`screenshot-tool.js`、`page-input-tools.js`、`fetch-tools.js`、`cdp-input-tools.js`、`page-read-tools.js`、`userscript-tools.js`、`skill-tools.js`、`code-access-tools.js`、`page-command-tools.js`、`knowledge-store-tools.js` —— 闭包依赖全部改为显式注入，另配 **184 条**以前写不出来的单测（把 `chrome` / `cdp` / `fetch` / `ctx` 换成假的）。`tools.js` 2288 → **1066 行**（−53%）。<br>**等价性证明**：每一步都跑注册表指纹门禁（**13 次纯搬运期间指纹始终不变**：`bd379daf4693655a`；有意的契约变更分别记为新值并写明原因）+ 全量单测 + E2E 7/7。<br>**收尾时踩到并守住的两类真实错误**：① `saveScreenshot` 移进截图模块后签名多了 `chromeApi`，调用点一度漏传 → **静默不落盘**（截图显示成功但取不回图）；② 一次脚本化批量搬运**同时**引入 **漏 case**（`expand_result` / `get_run_trace` 没有分支）、**重复 case**、**漏 `return`**（`complete_task` 会掉进 `load_skill` 去装技能）。第 ② 类正是**最终改用注册表**的原因：这三类在注册表里没有写法。门禁断言「`registeredToolNames()` == `TOOL_REGISTRY`」、注册表内无重名、`executeTool` 内不得出现工具逻辑，且**这些断言自身有牙齿测试**（多一个 / 少一个 / 改名都必须被发现）。 |
| **C-4 工具 55 → ~28** | **可重构档全部完成（55 → 44）** | ① 新增 `docs/tool-merge-plan.md` + `scripts/tool-merge-impact.mjs`（成本数据）+ `tests/tool-merge-plan.test.mjs`（把方案数字与"哪些档不可做"**钉住**）。② **实测修正文档手算错误**：`tool-design.md` §10 原写"目标落在 ~28"，逐档净减量加起来实际是 **55 → 33**；实施后**可达落点是 38**（含需取舍的第 8/9 档），**到 28 还需再砍 10 个能力** —— 合并路径本身已用尽。③ **已执行 5 个可重构档**：诊断（55→53）、宏（53→51）、知识库只读（51→49）、元素检查只读（49→47）、视觉标注（47→**44**）。④ **每档都按"同权限 + 同执行路径"分组，而不是按语义相似度**：宏（risk 取最高 + 按 op 保留写审批与**执行期回放白名单**，有真实提权先例）、知识库（只合读三件套，写/删保持独立，否则每次检索都要审批）、元素检查（只合共用同一条执行路径的三个，`get_attribute` 与 `get_element_source` 保持独立）、视觉标注（四者权限与路径完全一致，最纯粹的一次）。⑤ **判为不可做（各有断言守住）**：第 6 档（`toolNeedsApproval` 拿不到 args）、第 7 档（`get_ax_snapshot` 需 CDP 而 `list_frames` 刻意不需）。⑥ **需你决策**：第 8 档（指针族，会削弱最高频工具签名）、第 9 档（用户脚本，要砍能力面）。⑦ 副产物：修复两处参数描述串台、修掉 `get_entry` 缺 status 时输出 `undefined`、暴露**三次"工具数下降但 prompt 变大"**、沉淀出合并可行性**三条判据** |
| **（本轮新发现）两处参数描述串台** | **已修复 + 加门禁** | `macro.name`（原 `save_macro.name`）与 `load_skill.name` 的描述被从 `click_element` 复制过来，写成「可访问名（按钮文字 / aria-label），配合 role」—— 但前者是**宏的名字**，后者是要加载的**技能名**，且这两个工具**都没有 `role` 参数**。描述是模型唯一的说明来源，写错会让它去构造不存在的参数含义。已按语义改写，并新增 2 条门禁（"声称配合 role 的工具必须真有 role 参数" + 钉住这两个已知用例），**并已注入错误验证它们确实会报错**（当时 3 条门禁同时红灯） |
| **思考记录（思维链）** | **已实现 + 真浏览器验证** | 用户反馈「模型在思考时界面没有记录」。**根因不是缺个动画，而是思维链从来没被读过**：`streamAgentStep` 只处理 `delta.content` 与 `delta.tool_calls`，推理模型的 `delta.reasoning_content` 被**直接丢弃**（全仓库此前对它零引用）。现已：① 后台把它发成**独立的 `type:'reasoning'` 事件**（不混进正文，否则面板再也分不出哪段是思考、哪段是回答）；② 面板渲染成**可折叠的思考记录**，位置固定在回答上方，思考时展开、正文一开始**自动收起**，用户点开后仍能读全文；③ 进行中的动画（三点 + 标签扫光）只在 `data-state="running"` 时跑，静止的记录不再闪。**四条硬约束**：思维链**绝不写回 messages**（写回会改写请求前缀使缓存全失效，且该字段不可回传）——已由前缀稳定性门禁 + 单测双重守住；`.think-body` 初始 `display:none`；扫光用 `@supports` 包住（`background-clip:text` 不生效时 `-webkit-text-fill-color:transparent` 会让**文字整个消失**）；`content.js` 重新构建（产物入库，忘构建等于没上线）。**验证**：13 条接线门禁 + 5 条 streamAgentStep 单测 + **1 条真浏览器 E2E**（断言记录真的出现、含思维链、不含正文、自动收起、点击后可展开读到全文）—— 光有单测只能证明"接了线"，证明不了"面板上真的有这块记录"。⚠ **只有 `deepseek-reasoner` 会返回思维链**；默认的 `deepseek-chat` 下不会有记录（只有等待动画），已在设置页提示里写明 |

## 六、如何验证本轮的每一条

```powershell
npm test                            # 1134 项单测 + 3 道独立脚本门禁 + 刷新测试数快照
npm run test:e2e                     # 真实 Chromium：黄金任务 6 + 断线恢复 1（两阶段）
npm run build:content -- --check     # 内容脚本打包（自包含性不合格会以退出码 2 拒绝）
node scripts/test-count.mjs          # 测试数（文档数字由它生成，不手写）
node scripts/verify-bridge-ws-handshake.mjs   # 桥接 WS 鉴权（真实 server + 真实客户端）
node scripts/tool-merge-impact.mjs   # C-4 合并成本数据（分组从注册表派生，名字错就退出）
```

**以单测形式存在的门禁**（跑 `npm test` 时一并执行，不是独立脚本）：
工具注册表指纹、文档与工作树不漂移、元素收集 vs 正文抽取的名单分工、内容脚本产物自包含性、
桥接契约双向一致、C-4 合并方案的数字与"第 6/7 档不可做"的约束。

## 七、健康度快照（本轮结束时）

| 指标 | 值 |
| --- | --- |
| 单元测试 | **1134 项 / 79 个文件**，全通过 |
| 真实浏览器 E2E | **8 项**（黄金任务 6 + 断线恢复 1），全通过 |
| 独立脚本门禁 | 3 道（const 赋值 / 前缀稳定性 / 变异测试），全通过 |
| 变异测试 | 5/5 条变异都被断言抓住（证明断言不是摆设） |
| 集成方向 | 已收敛为唯一事实来源（`docs/integration-status.md`） |
| 内容脚本 | 已打包自包含（18 模块 / 265KB），WAR 不再暴露 `lib/` |
| `tools.js` | 2288 → **1066 行**，拆出 4 个纯函数模块 + 13 个工具族模块 |
| 内置工具数 | 55 → **44**（C-4 已执行第 1、2、3、4、5 档；剩余只有需取舍的 8/9 档） |
| 剩余可达落点 | 所有"可重构"档已执行完毕；再做需取舍的第 8 档 → **41**，第 9 档 → **38**。**到 28 需再砍 10 个能力**（合并路径已用尽） |
| 修掉的"假通过" | **4 次**：「打包成功」实为 0 模块、断线测试的选择器不存在、重连守卫恒真、元素枚举把交互控件全排除 |
| 被拦下的"看似可做" | **3 次**：C-4 第 1 档（95 处引用，预算不足→回退）、第 7 档（CDP 前置条件冲突）、第 6 档（审批函数拿不到 args）。**都在动手后靠读代码发现，并写成了断言** |

## 八、本轮最值得记住的几件事

> **接手时先读 [`docs/next-steps-handoff.md`](next-steps-handoff.md)** —— 它写明剩下什么、为什么没做、以及怎么开始。

1. **"能跑通"和"验证过"是两件事，而且这个形态出现了 4 次**：
   - C-3 之前 E2E 从未运行过 —— 一跑就暴露元素枚举完全失效；
   - "打包成功"实际只打进 1 个模块（esbuild 解析不了 `getURL(...)`）；
   - 断线测试用了**不存在的** `.typing` 选择器，每次超时、从未执行到"断线"那一步；
   - 重连守卫 `conn !== activeConn` **恒成立**，整段重连是死代码。
   四次都是"代码/测试看起来完成了，实际从未执行到那一步"。因此本轮的规则是：
   **凡断言，先证明它会在该失败时失败**（变异测试 5/5、指纹门禁的自我验证、E2E 的阳性对照都是这个规则的产物）。
2. **同一个常量用在不同语义上会造成沉默的灾难**：`PAGE_TEXT_EXCLUDE` 对正文抽取正确，用于元素查找就让整个定位链失效（快照里从来没有按钮）。
3. **不要为了让自己写好的测试变绿而改代码**：本轮有 4 次是**测试写错了**（`remove_entry` 的拒绝文案、`resolveSearchUrl` 对空输入返回基址、E2E 用了不走通道的工具、`agent-browser` 的通配），每次都改测试；相反有 2 次是**测试通过了但没测到该测的东西**，那两次我承认失败并明确标出。
4. **搬运式重构的价值来自"可证伪"**：`tools.js` 五步拆分能安全进行，靠的不是小心，而是每一步都有注册表指纹（对外契约未变）+ 全量测试 + E2E 三层证据。**没有指纹门禁时，"只是搬家"这个说法无法被验证。**
5. **检测器错了会得出相反的结论**：本仓库作者在自审文档里记过同一课（XSS 探针的检测器写错，修复后仍报"危险"）；我这一轮在断线恢复上也栽在同一处 —— 用不可靠的观测工具推断结论，连续几轮得出错误判断。

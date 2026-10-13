# 交接说明（下一轮从哪继续）

> 本文件写给**接手的人或会话**。当前状态已验证为绿；下面把"剩下什么、为什么没做、怎么开始"
> 写清楚，避免重新摸索一遍 —— 这个仓库最大的成本不是写代码，而是**误判自己已经完成**。
>
> 生成于本轮迭代结束时。数字都可复核，命令都在文末。

## 1. 已完成的（不要重做）

| 批次 | 状态 |
| --- | --- |
| **A** 低成本高确定性修复 | **全部完成**（5 项必现故障、安全收口、门禁接入 CI、文档数字治理） |
| **B** 调试能力 | **全部完成**（动作效果观测化、桥接写子集、注入隔离、存活看门狗、**B-4b 断线恢复**、集成一致性） |
| **C-2** esbuild 打包 + 收窄 WAR | **完成**（内容脚本自包含，WAR 不再暴露 `lib/`） |
| **C-3** E2E 验证网 | **完成**（2 → 7 个场景；顺带修掉元素枚举 Critical 缺陷）。后续新增**思考记录**场景 → golden 7 条 + 断线恢复 1 条 = **33 条** |
| **C-1** 拆分 god files | **已完成**（`tools.js` 2288 → 1066 行；拆出 4 个纯函数模块 + **13 个工具族模块**；`executeTool` 已是**分派注册表**——查表 + 调用，零工具逻辑） |
| **C-4** 工具合并 | **可重构档全部完成**（55 → 44；剩余 8/9 档属"需取舍"，需产品决策） |

## 2. 剩余工作

### 2.1 只剩两件，都不再是"重构"

| 项 | 内容 | 为什么要你决定 / 需要什么 |
| --- | --- | --- |
| **C-4 第 8 档** | 指针族 4 → 1（`pointer({op})`） | **需取舍**：会削弱最高频工具 `click_element` 的签名（模型每次点击都要多填一个 op）。做完 44 → **41** |
| **C-4 第 9 档** | 用户脚本 4 → 1 | **需取舍**：要砍掉"内置用户脚本管理"这个能力面。做完 41 → **38** |

**注意**：合并路径已用尽。要到 `docs/tool-design.md` §10 的 ≤25 目标，从 38 还要**再砍 10 个独立语义的工具**——那是产品决策，不是重构。

### 2.2 实测**不可做**（不要照方案表的"可重构"直接动手）

| 档 | 阻塞点 |
| --- | --- |
| **C-4 第 4 档的写/删部分** | 原方案写"知识库 5→2"，但那会让**每次知识库检索**都继承 `destructive` 而被强制审批。**已改为按权限类别分组**：只读三件套合并为 `knowledge_read`（已完成），`add_entry`/`remove_entry` 保持独立。**净减量相同，但不要再去合它们** |
| **C-4 第 6 档**（技能） | `toolNeedsApproval(name, settings, pageUrl)` **拿不到 args** → 无法按 `op` 分级审批。合并只能"每次加载技能都要批准"（高频安全操作变烦）或"移除安装闸门"。**要做得先改审批函数签名并让 args 贯通整条链路** |
| **C-4 第 7 档**（帧 + AX） | `get_ax_snapshot` **需要 CDP**，而 `list_frames` **刻意不依赖 CDP**。合并会让一个本来能用的路径绑上 CDP 前置条件 |

三档都已在 `tests/tool-merge-plan.test.mjs` 里写成断言 —— 若将来架构变了（例如审批函数加了 args），
**门禁会主动红灯提醒重新评估**，不需要有人记得这件事。

### 2.3 C-4 的目标本身需要重新确认

- 逐档实测：**合并路径最多到 38**（含需取舍的第 8/9 档：指针族、用户脚本）。
- **到 28 还需再砍 10 个独立语义的工具** —— 那是**砍能力**，属产品决策，不是重构。
- 这条结论现在有数据（`scripts/tool-merge-impact.mjs`）与断言支撑。**不要**把它当成"还没做完"。

### 2.4 C-1 核心（**已完成**）

`lib/assistant/tools.js` 的 `executeTool` 已从**巨型 switch 变成分派注册表**：

```js
const TOOL_HANDLERS = new Map();            // 工具名 → 该族的 handler
function registerHandlers(names, run) { … } // 重名 → **模块加载时抛错**
export async function executeTool(name, args, ctx) {
  const run = TOOL_HANDLERS.get(name);
  if (!run) return { result: '未知工具：' + name };
  return await run(name, args, ctx);         // 零工具逻辑
}
```

**17 步**：4 个纯函数模块 + **13 个工具族模块** —— `tab-tools.js`（list/switch/open_tab）、
`run-state-tools.js`（update_plan / expand_result / get_run_trace）、
`permission-tools.js`（trust_site / handle_dialog）、`screenshot-tool.js`（take_screenshot）、
`page-input-tools.js`（type_text / press_key / select_option / check_box / wait_for_element / get_attribute）、
`fetch-tools.js`（fetch_webpage / web_search）、
`cdp-input-tools.js`（click_element / click_at / hover_element / drag_element / upload_file）、
`page-read-tools.js`（read_current_page / get_page_snapshot / list_frames + listFramesRaw / prefixFrameRefs）、
`userscript-tools.js`（list / search / install / run —— 安装受用户设置约束）、
`skill-tools.js`（load_skill / install_skill / save_skill —— 读手册 / 从 SkillHub 装 / 把做法写成技能），
`code-access-tools.js`（run_javascript / get_ax_snapshot —— 页面活状态的深路径）、
`page-command-tools.js`（annotate / inspect_element / scroll_page / get_element_source / undo_last_action）、
`knowledge-store-tools.js`（knowledge_read / add_entry / remove_entry —— 权限类别不同，**刻意不合并**）。
共配 **184 条**以前写不出来的单测（把 `chrome` / `cdp` / `fetch` / `ctx` 换成假的）。
`tools.js` 2288 → **1066 行**。

**已验证可行的方法**（第 6～17 步照此做完）：
1. 新建模块，把该族的代码**原样搬入**，只把闭包依赖（`chrome` / `ctx` / 私有 helper）改为**显式注入**；
2. `tools.js` 侧加一行 `registerHandlers([...工具名], (name, args, ctx) => handleXxxTool(name, args, {...}))`；
3. 立刻 `node --check` → 跑**注册表指纹门禁**（纯搬运必须不变）→ 跑全量测试 + E2E；
4. **补该族的单测**（把 `chrome` 换成假的）—— 这才是抽取的真正收益。

**⚠ 搬家时最容易犯的两类错（都真实发生过，都已有门禁守住）：**

1. **漏传一个依赖**：`saveScreenshot` 移进 `screenshot-tool.js` 后签名多了 `chromeApi`，
   而调用点一度没跟着传 → **静默不落盘**（截图仍显示成功，但图片永远取不回来）。
   回归断言在 `tests/c1-tool-families.test.mjs`。
2. **分派结构被批量搬运弄坏**：收尾时一次脚本化改写同时引入了
   **漏 case**（`expand_result` / `get_run_trace` 没有分支）、**重复 case**、
   **漏 return**（`complete_task` 会掉进 `load_skill`）。
   **这正是最后改用注册表的原因** —— 这三类在注册表里没有写法。
   现在 `tests/final-families.test.mjs` 断言：
   ① `registeredToolNames()` 与 `TOOL_REGISTRY` **严格相等**；
   ② 注册表内无重名；
   ③ 未知工具回落到「未知工具」；
   ④ 重名保护是**加载时**抛错，且 `executeTool` 里**不得再出现工具逻辑**（`switch (name)`、`case '`、`executePageTool(`、`cdp.`）；
   ⑤ 这条等价门禁**有牙齿**（多一个 / 少一个 / 改名都必须被发现）。

**为什么必须小步**：本 session 里有 **4 次**"代码看起来完成、实际从未执行到那一步"
（见 `docs/change-delivery-summary.md` 第七节）。大块搬动会让这类问题累积到无法定位。

**下一族候选**（按内聚度）：`complete_task` / `undo_last_action`（会话收尾类）、
`get_ax_snapshot`（CDP 结构视图，单工具族），或按 `lib/page/commands.js` 的分组
把 `click_element` / `type_text` / `press_key` 等页面命令族一起搬。

### 2.5 我**没有**动、且已明确记录为设计决定的事

- `agent-browser` 内置技能仍会通配匹配；
- CDP 升级**不**在"动作无效果"时触发（否则会对真实页面重复点击）；
- 写操作**不**因"当前含不可信页面内容"而自动加闸（理由写在 `lib/assistant/agent.js` 注释里：
  不可预测的审批会训练用户无脑点同意）；
- 桥接 WS 的 token 仍在查询串里。

## 3. 怎么开始（照抄即可）

```powershell
npm test                 # 1439 项单测 + 3 道独立脚本门禁 + 刷新测试数快照 —— 必须先全绿
                         # （数字从 tests/.test-count.json 读，不要手写；它由 run-all-checks 刷新）
npm run test:e2e         # 真实 Chromium，44 个用例（三阶段：黄金任务 41 / 断线恢复 1 / 视觉两臂 3）
```

改动前的**安全网**（照这个顺序用）：
1. `node scripts/tool-merge-impact.mjs` —— 看目标工具名的**引用密度**（决定一轮能否做完）；
2. `node --test tests/registry-fingerprint.test.mjs` —— 取搬运**前**的指纹；
3. 改完再跑一次 —— **指纹不变 = 只是搬家；指纹变了 = 你改了对外契约**，必须显式更新并写明原因；
4. `node scripts/build-content.mjs` —— **改了内容脚本依赖（`lib/page/**`）就必须重新构建**，
   否则 manifest 加载的是旧产物（这条很容易漏：产物 `content.js` 是提交进仓库的）。

## 4. 三条判据（本 session 用两次失误换来的）

判断"某个合并能不能做"，至少要问三个问题 —— 少问一个就会判断错：

| 判据 | 决定什么 | 反例 |
| --- | --- | --- |
| **引用密度** | 工作量 | 第 1 档 95 处 vs 第 3 档低密度（后者一轮做完） |
| **权限取谁** | 安全性 | 知识库含 `destructive`、宏含 `write` |
| **能力 / 审批前置条件是否一致** | **能否成立** | 第 6 档（审批拿不到 args）、第 7 档（CDP 差异） |

**"语义上属于同一类"不等于"可以合并"。**

## 5. 当前健康度（本轮实测）

| 指标 | 值 |
| --- | --- |
| 单元测试 | **1439 项 / 115 个文件**（目标 ⑤ 那一轮 +9 条新门禁、−3 条测死代码的用例、+1 条钉住删除决定；付费墙口径 +1、思考记录默认折叠 +2；**目标 ③ 收口 +13**（A3 detach 有界 + 共享阶梯、A4 两个渲染器同形态、A5 历史截断说明），数字见 `tests/.test-count.json`）|
| 真实浏览器 E2E | **45 个用例**（黄金任务 41 + 断线恢复 1 + 视觉两臂 3；开关已打开 ⇒ 跑的是开启臂，关闭臂按开关跳过） |
| 独立脚本门禁 | 3 道（const 赋值 / 前缀稳定性 / 变异测试） |
| 技能结构门禁 | `tests/skill-content-structure.test.mjs`（编号步骤清单 / 孤儿理由不空话 / 技能声明的工具真实存在 / 生成物无源码碎片）|
| 桥接鉴权 / 跨会话隔离 | 各自独立验证通过 |
| 内置工具数 | **44** |
| `tools.js` | 见文件本身（**不要在这里写行数**：它已经漂移过一次） |
| 内容脚本 | 自包含打包产物 —— **改了 `lib/page/**` 或 `lib/shared/**` 必须重新构建** |
| 注册表指纹 | `fb63cc85d45590b1`（变更历史与原因写在 `tests/registry-fingerprint.test.mjs`） |

## 待续：浏览器级 JS 对话框的场景（本轮**未收敛**，如实记录）

**目标**：给 `handle_dialog` 做行为验收（它至今只有单测，没有真浏览器场景）。
`/dialog` 夹具页**已写好并验证过自身行为**（`tests/e2e/fixtures/server.mjs` 的 `dialogPage()`，
路由已接线），但**能力剧本与 E2E 没进仓库** —— 因为场景没能稳定跑通。

**已经验到的**：
- `prompt` 的 `promptText` 回填是**必需的**：只 `accept` 会原样接受默认值「未命名」；
- 对话框的**检测**完全依赖 CDP 事件（`Page.javascriptDialogOpening`）⇒ **必须先 attach CDP**，
  否则事件不会到达扩展（处理仍会成功，但**消息与默认值进不了上下文**）；
- 因此脚本路径的第一步要用 **CDP 支撑的读取**（如 `get_ax_snapshot`），而不是内容脚本快照。

**未解决**：同一轮里出现**第二个**对话框（`confirm`）时处理不成功（`__confirmResult` 恒为 null）。
**已排除**：① 点击被同步对话框阻塞（改成 `setTimeout` 延迟弹框后**仍然失败**）；
② 检测时机（已先 attach CDP）。
**剩下的怀疑方向**：连续两次 `handle_dialog` 之间的事件/桶状态（`clearDialogs` 的时机）、
或"看起来失败的点击"累积触发工具摘除（`click_element` 被移出工具集后，第二步点击根本没发生）。

**复现入口**：夹具页在 `/dialog`；`handle_dialog` 的实现见
`lib/assistant/target-manager.js`（`getPendingDialogs` / `handleDialog`）与
`lib/assistant/permission-tools.js`。**注意**：调试时不要用 PowerShell 改写源文件
（`Get-Content`/`Set-Content` 会破坏 UTF-8，本轮实测把 `golden.spec.mjs` 写坏过一次，
已从 git 恢复）。

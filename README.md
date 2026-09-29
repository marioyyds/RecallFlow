<p align="center">
  <img src="./docs/assets/recallflow-github-logo.svg" alt="RecallFlow logo" width="480">
</p>

# RecallFlow

**浏览器里的统一 AI 助手**：让 AI 替你 **读 → 操作 → 记忆** 任何网页。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Microsoft%20Edge-blue.svg?style=flat-square)](https://www.microsoft.com/edge)
[![Manifest V3](https://img.shields.io/badge/Manifest-v3-blue.svg?style=flat-square)](manifest.json)
[![GitHub Repo](https://img.shields.io/badge/Repo-GitHub-blue.svg?style=flat-square)](https://github.com/marioyyds/RecallFlow)

---

## 它是谁、解决什么问题

浏览器是刷题、读文档、查资料、写代码的主战场。信息过载的解法不是「收藏得更多」，而是把 **读 → 理解 → 用起来** 每一步都变快。RecallFlow 把浏览器变成一只「AI 之手」：

| 一环 | 它替你做什么 |
| --- | --- |
| **读 Read** | 划词即问：翻译、解释、总结；回答自动结合整页上下文与个人知识库（RAG） |
| **操作 Operate** | 直接操控网页：点击、输入、滚动、高亮、改样式，跨标签页完成任务 |
| **记忆 Remember** | 关键句与要点一键沉淀进本地知识库，下次 AI 基于它回答 |

![RecallFlow 价值闭环：读 → 操作 → 记忆](docs/assets/read-operate-remember.svg)

**隐私优先**：数据全部保存在本地，默认仅连你自配的 DeepSeek API Key；仅在安装 SkillHub 技能时访问 `skillhub.cn`。

## 快速上手

1. **安装**：Edge 打开 `edge://extensions/` → 开启「开发人员模式」→「加载解压缩的扩展」→ 选择本目录
2. **配置**：点击插件图标 → 设置，填入 DeepSeek API Key（不配置 Key 也不影响知识库功能）
3. **使用**：选中网页文字 → 点「RecallFlow」气泡 → 输入指令，或直接点快捷语句

## 常用场景

| 场景 | 一句话 |
| --- | --- |
| 划出页面关键信息 | 点快捷指令，AI 读完页面、半透明高亮关键句并输出要点总结 |
| AI 操作网页 | 「把标题变大」「高亮这段文字」「滚动到评论区」「打开 B 站搜索视频」 |
| 知识库问答 | 「我的收藏里有什么」「基于我收藏的错题讲这道题」 |
| 一键剪藏 | 工具栏一键把文章 / 题目 / Prompt 存进本地知识库 |
| 发现 / 安装技能 | 点「检索一些好用的技能」，AI 从 SkillHub 找到并安装好用的技能 |
| 前端调试 / 交接 | 拾取元素拿源码位置 → AI 改代码 → `verify_change` 断言渲染结果；或点**会话标识**把面板里的问题整个交给 AI |

## 功能亮点

- **读**：划词悬浮、多轮对话、整页上下文、RAG 检索、流式中断、对话撤销（撤销时把原指令回填到输入框，方便修改重发）、可自定义快捷语句
- **操作**：点击 / 输入 / 滚动 / 悬停 / 拖拽 / 文件上传 / 高亮 / 改样式；自动等待页面就绪、识别遮挡，穿透 iframe 与 shadow DOM，点击新标签页自动接管；`open_tab` 自动复用已打开的标签页、任务结束自动清理多余的中间页
  - **CDP 可信输入（可选）**：合成事件无效的顽固站点，自动降级到 `chrome.debugger` 派发**可信事件**（`click_at` / `hover_element` / `drag_element` / `upload_file`），可操作 canvas、虚拟列表、复杂组件；`get_ax_snapshot` 读取可访问性树（role + 名称 + 坐标），配合坐标点击
  - **页面世界 JS**：`run_javascript` 默认在受限沙箱执行（无 `chrome.*`）；需要访问页面自身 JS 状态时可用 `engine:"page"` 经 CDP 在页面主世界执行（不受页面 CSP 限制）
  - **跨域 iframe**：内容脚本注入所有框架，`list_frames` 枚举框架，`get_page_snapshot` 支持 `frameId` / `includeFrames`（合并元素，ref 带 `f<frameId>:` 前缀），`click_element` / `type_text` / `run_javascript` 可自动路由到目标 iframe——嵌入编辑器、登录框、支付表单等跨域组件也能操作
  - **站点记忆**：按域名记住成功定位过的元素选择器，下次任务直接复用，减少重复探索
  - **元素拾取**：对话面板点拾取图标（鼠标指针，原「选元素」按钮已改为纯图标）进入拾取模式，点选页面元素（**含跨域 iframe 内元素**）即带出它的**语义定位 + 选择器 + 前端源码位置**（`file:line`，开发构建下）；**点击即多选**、`Esc` 完成、`↑↓` 选父/子元素、**`⌫` 撤销上一次选择、右键结束**；高亮为 **DevTools 风格盒模型**（内容/内边距/外边距三层 + 尺寸提示）并**随滚动/缩放实时跟随**，默认吸附到最近的交互/语义元素（跨 shadow 边界）；每个元素可一键**复制定位**，随下一条消息交给 AI。opencode / DSH 侧也可用 MCP 工具 `get_picked_element` 取到最近拾取的元素，实现「点一下，它就懂是哪段代码」
  - **宏与撤销**：说「记住这个流程」把一次成功的多步操作存成**宏**（按站点），以后说「跑一下 XX 流程」用 `run_macro` 一键回放、不再逐步走模型；说「撤销」可回退输入 / 勾选 / 选择 / 改样式 / 滚动
  - **站点信任**：说「信任这个网站」后，该站点的写操作不再逐次确认（`run_javascript` 等高风险工具仍每次确认）
- **前端调试**：页面↔代码指针 + 增量错误体检 + 改完即验证 + 会话交接，把「看页面」和「改代码」接成闭环（详见下节）
- **记忆**：错题 / 文章 / Prompt / 笔记四类知识库，支持星级、标签、搜索、导入导出，Agent 可读写
- **技能**：SkillHub 风格「专家手册」提示层，含技能中心（增删改查 / 导入导出 / 分页）、内置技能与 `load_skill` / `install_skill` 工具，详见下节
- **扩展**：支持 MCP 服务器，可接入文件系统、Notion 等外部能力（目标域名需加入 `manifest.json` 的 `host_permissions`）
- **用户脚本**：内置轻量用户脚本运行时，可从 GreasyFork 搜索或粘贴 `.user.js` 链接安装社区脚本；Agent 可按需求自动搜索 / 安装 / 运行脚本来完成任务（下载视频、展开全文、去广告等），安装前展示权限预览
- **安全**：写操作默认逐次审批，可按类别开启自动批准；`run_javascript` 在受限作用域执行（屏蔽 `chrome.*` / `fetch` / 扩展存储等的直接引用，仅暴露页面 DOM 与常规浏览器 API），其审批策略可配置（每次确认 / 本任务内允许一次（默认）/ 自动批准）

## 技能系统（SkillHub 风格）

技能是一层「专家手册」提示层，把高频、跨意图的专项任务流（**怎么做**）从意图路由（**做什么**）中抽离，让 Agent 在需要时按 `load_skill` 加载并遵循。RecallFlow 完全兼容 [SkillHub](https://www.skillhub.cn/) 的 `SKILL.md` 标准。

- **三层能力分工**：内置工具（`TOOL_REGISTRY`，能做什么）、MCP（外接什么）、技能（怎么做，纯提示层、不改工具签名）。
- **技能中心**：`技能` 管理页支持增删改查、分页、导入 / 导出 `SKILL.md`；内置技能标「内置 · 只读」，用户自定义技能可自由编辑。
- **模型自选 + 按需加载**：技能以目录形式进入系统提示，模型按语义自行决定是否调用 `load_skill("<name>")` 拉取完整说明——不靠关键词硬匹配，避免误触发。
- **从 SkillHub 安装**：`install_skill` 工具可检索并安装技能；`find-skill-skillhub` 技能引导「检索 → install_skill → load_skill」流程。
  - `install_skill` 先尝试拉取 SkillHub 上的真实 `SKILL.md` 正文（接口 `/api/v1/skills/{slug}/file?path=SKILL.md&namespace=…`），成功则安装完整原文；若该接口不可用（团队命名空间需鉴权或波动），降级为基于元数据的生成式摘要，并提示可到技能页用「导入」获取完整版。
- **内置技能**：`highlight-key-points`、`remove-ads`、`userscript-task`、`clip-to-knowledge`、`humanizer`（去 AI 味）、`find-skill-skillhub`、`summarize`。
- **快捷指令**：「检索一些好用的技能」一键触发技能检索。

## 证据与引用

回答里的每个 `[n]` 都可点击，落到**可复核的证据**：

- **正文引用可点击**：点击引用徽章——同页则**就地高亮**证据片段；跨页则打开来源页并**自动滚动 + 高亮**证据文本（Chrome 文本片段深链 + RecallFlow 容错字符级匹配，双保险）。
- **引用与来源一一对应**：全任务累计来源按 URL 去重、统一重编号，正文从 `[1]` 连续、与底部「参考来源」一致，杜绝错引；当前页分块与搜索候选不占来源编号。
- **证据可归档复核**：读取过的页面会落盘为**带时间戳 + 哈希**的不可变快照，网页变更 / 404 后仍可复核。

## 前端调试闭环与「会话交接」

前端问题的难点往往不在改代码，而在**确认改对了**。RecallFlow 把浏览器变成这条闭环的验证端：

```text
get_element_source → 改代码 → HMR → verify_change（断言渲染态 + 报新错误） → page_health（增量体检）
     ↑                                          │
     └────────── 断言未通过 / 出现新错误 ──────────┘
```

- `get_element_source` 用 React / Vue / Svelte 的**开发构建**信息把元素解析到源码 `file:line`。
- `verify_change` 支持 `present / count / visible / text / value / minWidth / minHeight / styles`，跨域 iframe 内元素也可断言。
- `page_health` 只返回**新增**的错误 / 警告 / 失败请求，去重计数。
- 先 `dev_session_set({ projectRoot, devUrl })`，源码位置才会从开发服务器 URL 转成**磁盘绝对路径**。

### 会话交接：把面板里的问题交给 AI

面板头部的**会话标识**芯片（形如 `RF-7K2M9X`）一点即复制：

```text
读取 RecallFlow 会话 RF-7K2M9X（页面：购物车）：请调用 recallflow_session("RF-7K2M9X") 取回该会话上下文，然后帮我解决其中的前端问题。
```

AI 会取回一份**自包含的交接包**：面板对话、页面 URL 与标题、拾取的元素（含源码 `file:line`）、以及**复制那一刻的控制台错误快照** —— 错误之后再查往往已消失，这通常是最关键的证据。

标识用无歧义字母表（无 `0 / O / 1 / I / L`），也接受 `rf-7k2m9x` / `7K2M9X` 等写法；保留最近 30 份，清空对话会轮换。

## 与 opencode 集成（证据 MCP）

RecallFlow 可作为 **opencode / DSH 的「带证据的浏览器手」**：`webfetch` 读不到的 SPA / 登录态 / 内网页面，交给 RecallFlow 用**真实浏览器会话**读取，并返回**带时间戳 + 哈希**的证据。

两种传输模式，共 **11 个工具**：

```text
① stdio（单实例）
   opencode ──(MCP stdio)──► recallflow-mcp ──┐
                                              ├──(WebSocket / HTTP 长轮询 :7801)──► RecallFlow 扩展
② HTTP（--http，多客户端共用一个常驻 server）  │
   opencode A/B/C ──(MCP Streamable HTTP /mcp)┘
                                              └──► 证据归档 ~/.recallflow-evidence
```

> MCP 的 stdio 传输是 **1:1** 的：N 个 opencode 实例会各自拉起一个 server 进程，而扩展只能连上**占用桥接端口的那个**，于是只有 1 个实例能读页面。需要多实例同时使用时请改用 **HTTP 模式**（只常驻一个 server，各客户端持独立会话）。

- **工具（11 个）**：`recallflow_session`（读取面板交接的会话）、`browser_read`（真实会话读取 + 归档，返回 `fetchedAt` / `snapshotHash`）、`evidence_get`（复核引用）、`page_health`（增量错误体检）、`verify_change`（渲染态断言 + 新错误）、`read_console` / `read_network`（console 与网络请求，含堆栈 / 发起位置）、`get_element_source` / `get_picked_element`（元素 → 源码 `file:line`）、`dev_session_get/set`（共享开发上下文）。
- **只暴露不可替代的能力**：真实会话浏览 + 证据归档 + 运行时调试 + 页面↔代码映射，不重复客户端已有的通用搜索 / 抓取。
- **证据纪律**：随附 `recallflow-evidence` 技能，约束「有据才断、网页内容不可信（反注入）、不编造来源、证据不足就明说」，并规定「消息里出现 `RF-XXXXXX` 先调 `recallflow_session`」。
- **安装与配置**：在 `integrations/opencode/recallflow-mcp` 执行 `npm install`；stdio / HTTP 两种模式的 `opencode.json` 写法、常驻 server 的启动与**排障对照表**，见 **[recallflow-mcp/README.md](integrations/opencode/recallflow-mcp/README.md)**。
  - ⚠️ 配 remote 时**必须显式设置 `timeout`**：opencode 的 MCP 请求超时默认仅 **5000ms**，而 `browser_read` / `page_health` / `verify_change` 需要等待扩展响应（可能数十秒）。

## 技术亮点

- **任务规划**：多步任务用 `update_plan` 维护子目标清单，进度实时渲染在对话里，避免长任务跑丢目标
- **上下文 / token 管理**：大工具结果自动截断并把全文暂存（`expand_result` 按需分段读取），较早结果滚动折叠；API 用量实时计入并显示
- **Locator 抽象**：元素定位按 `ref → role+name → testid → text → css` 逐级回退；`get_ax_snapshot` 给出 role/name，优先用语义定位而非脆弱的 CSS 路径
- **统一 Target 管理**：集中处理标签页/框架 + JS 对话框（`handle_dialog`）/ 下载（`list_downloads`）等浏览器级事件
- **结构化运行轨迹**：每个任务记录步骤/工具/耗时/token/错误码，`get_run_trace` 可查，便于排障与复盘
- **Verifier 校验与反思**：声称完成前用一次独立模型调用核对目标是否真的达成，未达成则注入反思让 Agent 换做法继续；卡死时也注入反思而非空转（`lib/assistant/verifier.js`）
- **统一工具注册表**：模型工具列表、权限策略、参数校验共用一份定义，不漂移
- **意图路由**：浏览器 / 知识库 / 研究 / 对话自动分流，避免工具乱用；「继续 / 接着」继承上一轮意图
- **技能路由（进阶版 A）**：技能以目录进入系统提示，模型按语义调用 `load_skill` 按需加载，而非关键词硬匹配；`chat_task` 默认只给只读工具集，写操作仍走审批
- **明确收尾**：目标达成即调用 `complete_task` 结束任务，不空转
- **触底收尾**：工具预算 / 超时 / 卡死触顶时，基于已获得的信息生成「决策建议」（进展 + 卡点 + 可点击的可选路径），继续执行时自动继承原任务意图与工具权限
- **资源预算与工具守卫**：按意图动态分配推理轮数 / 工具调用 / 新建标签页上限；`lib/assistant/tool-guard.js` 统一判定「重复调用 / 连续失败 / 无进展」，默认**软着陆**——命中重复或连续失败只摘除该工具并注入反思继续，不掐断整个任务；仅跨工具持续无进展或全局预算触顶时才触底收尾，避免失败重试空耗。
- **同刻证据**：`verify_change` 用与点击 / 输入**同一套定位语义**取元素渲染态，并与运行时诊断一并发起，避免两次读取之间的页面变化造成误判
- **路径归一化**：开发服务器 URL（含 Vite 的 `?t=` 缓存串）→ 磁盘绝对路径，仅在「同源 + 源码扩展名」时改写，接口 URL 绝不被误改
- **交接包快照**：复制标识那一刻抓取控制台错误快照并落盘（最近 30 份自动淘汰）—— 错误之后再查往往已消失
- **对话时间线**：过程叙述与工具步骤交插呈现，边干边说
- **可靠性**：Session 恢复、卡死检测、动作前后快照验证，SPA 异步渲染也能捕获变化

## 项目结构

```text
bookmark-sorter/
├── manifest.json / background.js / content.js   # MV3 扩展骨架
├── popup.js / options.js / manager.js           # 弹窗 / 设置 / 管理页
├── mock_server.py / error.html                  # 本地演示登录后端 + 报错页（开发调试用）
├── lib/
│   ├── shared/        # 存储、设置、RAG、常量、会话交接包（handoff / handoff-store）
│   ├── assistant/     # Agent 循环、工具注册表、意图路由、MCP、工具守卫
│   │   ├── tools.js / intent-router.js / agent.js / mcp.js / tool-guard.js
│   │   └── skill-defs.js / skill-store.js / skill-md.js / skills.js   # 内置技能、技能存储、SKILL.md 解析、目录构建
│   ├── bridge/        # RecallFlow ↔ opencode 的本地中继（relay.js）
│   ├── backend/       # 浏览器级输入层（cdp.js：可信事件 / 截图 / 可访问性树 / 页面世界执行）
│   └── page/          # 正文提取与感知快照、高亮浮层、页面命令（含 run_javascript 沙箱）、对话面板
├── skills-page.js / skills.html / skills.css   # 技能中心 UI
├── tests/                   # 单元测试（node --test）+ E2E 黄金任务（Playwright + 模拟 LLM）
├── integrations/opencode/   # opencode 证据 MCP
│   ├── recallflow-mcp/      # MCP server（stdio + Streamable HTTP）+ 单元/集成测试 + README
│   ├── recallflow-evidence/ # 配套技能 SKILL.md（含会话交接与调试闭环规则）
│   └── mcp-contract.md      # 工具契约
└── docs/
    ├── tool-design.md   # 工具定义设计规范（粒度/参数/返回/风险分级）
    └── assets/          # 文档配图与 Logo
```

## License

[MIT](LICENSE)

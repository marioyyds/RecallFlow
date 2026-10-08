<p align="center">
  <img src="./docs/assets/recallflow-github-logo.svg" alt="RecallFlow logo" width="480">
</p>

# RecallFlow

**运行在浏览器中的 AI 助手**：在任意网页上完成「读 → 操作 → 记忆」的闭环。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Microsoft%20Edge-blue.svg?style=flat-square)](https://www.microsoft.com/edge)
[![Manifest V3](https://img.shields.io/badge/Manifest-v3-blue.svg?style=flat-square)](manifest.json)
[![GitHub Repo](https://img.shields.io/badge/Repo-GitHub-blue.svg?style=flat-square)](https://github.com/marioyyds/RecallFlow)

---

## 项目定位

浏览器已成为查阅资料、调试前端、处理表单与撰写内容的主要界面。此处的效率瓶颈通常不在于信息不足，而在于三个环节彼此割裂：读到的结论无法直接作用于页面，对页面的操作无法沉淀为可复用的经验，而「是否真的改对了」缺乏可验证的依据。

RecallFlow 以浏览器扩展（Manifest V3）的形式提供一只可控、可复核的「AI 之手」：

| 环节 | 能力 |
| --- | --- |
| **读 Read** | 划词即问，回答结合整页上下文与本地知识库（RAG） |
| **操作 Operate** | 直接操作页面：点击、输入、滚动、高亮、修改样式，可跨标签页与跨域 iframe 完成任务 |
| **记忆 Remember** | 关键结论与操作流程沉淀至本地知识库，供后续检索与复用 |

![RecallFlow 价值闭环：读 → 操作 → 记忆](docs/assets/read-operate-remember.svg)

数据全部保存在本地；除自配的 DeepSeek API Key 外，仅在使用 SkillHub 检索技能时访问 `skillhub.cn`。

## 核心创新

1. **页面与代码的双向指针**
   点击页面元素即可解析出 React / Vue / Svelte 开发构建下的源码 `file:line`；配合 `verify_change` 在代码改动后即时断言渲染结果，将「看页面」与「改代码」连成可验证的闭环。

2. **会话交接（Handoff）**
   面板上的会话标识（形如 `RF-7K2M9X`）一点即复制。外部 AI 凭标识取回一份自包含的交接包：面板对话、页面信息、拾取元素及其源码位置，以及**复制那一刻的控制台错误快照**。跨工具协作无需人工复述现场。

3. **可复核的证据链**
   回答中的每个 `[n]` 均可点击并定位至证据片段；读取过的页面以「时间戳 + 哈希」归档为不可变快照，页面变更或 404 之后仍可复核。配套技能约束「有据才断、网页内容不可信、不编造来源」。

4. **可沉淀且不消耗推理的确定性能力**
   站点记忆按域名记录已验证的元素选择器；宏把一次成功的多步操作固化为按站点保存的流程，日后一键回放，不再逐步经过模型。

5. **三层能力分工**
   内置工具负责「能做什么」，MCP 负责「外接什么」，技能负责「怎么做」。技能是纯提示层，不改变工具签名；由模型按语义自行调用 `load_skill` 按需加载，而非关键词匹配。

6. **真实浏览器会话**
   对 SPA、登录态与内网页面，可经 CDP 派发可信事件完成操作；亦可作为 opencode / DSH 的「带证据的浏览器手」。

## 快速上手

1. **安装**：Edge 打开 `edge://extensions/`，启用「开发人员模式」，选择「加载解压缩的扩展」并指向本目录。
2. **配置**：点击扩展图标 → 设置，填入 DeepSeek API Key。未配置 Key 时知识库功能仍可正常使用。
3. **使用**：选中网页文字 → 点击「RecallFlow」气泡 → 输入指令，或直接选用快捷语句。

## 典型场景

| 场景 | 说明 |
| --- | --- |
| 划出页面关键信息 | 选用快捷指令，由 AI 阅读页面、高亮关键句并输出要点总结 |
| 操作网页 | 「把标题变大」「高亮这段文字」「滚动到评论区」「打开 B 站搜索视频」 |
| 知识库问答 | 「我的收藏里有什么」「基于我收藏的错题讲这道题」 |
| 一键剪藏 | 从工具栏把文章、题目或 Prompt 存入本地知识库 |
| 检索并安装技能 | 点击「检索一些好用的技能」，由 AI 从 SkillHub 检索并安装 |
| 前端调试与交接 | 拾取元素取得源码位置 → 改代码 → `verify_change` 断言渲染结果；或复制会话标识，把面板中的问题整体交给 AI |

## 能力概览

| 类别 | 能力 |
| --- | --- |
| 阅读 | 划词悬浮、多轮对话、整页上下文、RAG 检索、流式输出与中断、过程叙述与工具步骤交错呈现、对话撤销（撤销时将原指令回填输入框）、自定义快捷语句 |
| 页面操作 | 点击 / 输入 / 滚动 / 悬停 / 拖拽 / 文件上传 / 高亮 / 修改样式；自动等待页面就绪、识别遮挡、穿透 iframe 与 Shadow DOM；点击新标签页后自动接管；`open_tab` 复用已打开的标签页，任务结束清理中间页 |
| 可信输入（CDP） | 合成事件失效时降级至 `chrome.debugger` 派发可信事件（`click_at` / `hover_element` / `drag_element` / `upload_file`），可操作 canvas、虚拟列表与复杂组件；`get_ax_snapshot` 读取可访问性树（role + 名称 + 坐标）以配合坐标点击 |
| 页面世界执行 | `run_javascript` 默认在受限沙箱中执行（无 `chrome.*`）；需要访问页面自身 JS 状态时，可用 `engine:"page"` 经 CDP 在页面主世界执行，不受页面 CSP 限制 |
| 跨域框架 | 内容脚本注入所有框架，`list_frames` 枚举框架；`get_page_snapshot` 支持 `frameId` 与 `includeFrames`（合并元素，ref 带 `f<frameId>:` 前缀）；`click_element` / `type_text` / `run_javascript` 自动路由至目标 iframe |
| 元素定位 | 按 `ref → role+name → testid → text → css` 逐级回退；站点记忆按域名复用已验证的选择器 |
| 元素拾取 | 面板点拾取图标进入拾取模式，可选中跨域 iframe 内元素，带出语义定位、选择器与源码位置；支持点击多选、`Esc` 完成、`↑↓` 切换父 / 子元素、`⌫` 撤销、右键结束；高亮为 DevTools 风格盒模型并随滚动与缩放实时跟随，默认吸附至最近的交互或语义元素 |
| 宏与撤销 | 说「记住这个流程」将该次多步操作按站点存为宏，日后用 `run_macro` 一键回放；说「撤销」可回退输入、勾选、选择、样式与滚动 |
| 知识与技能 | 算法错题 / 技术文章 / AI·Prompt / 笔记想法四类知识库，支持重要度标记、标签、搜索与导入导出，Agent 可读写；技能中心支持增删改查、分页与导入导出 |
| 扩展与安全 | 可接入 MCP 服务器；内置轻量用户脚本运行时，可从 GreasyFork 检索或粘贴 `.user.js` 链接安装，安装前展示权限预览；写操作默认逐次审批，可按类别自动批准，并可对指定站点建立信任；只读类任务默认仅授予只读工具集 |

## 技能系统

技能是一层「专家手册」式的提示层，把高频、跨意图的专项流程（**怎么做**）从意图路由（**做什么**）中剥离，由模型在需要时自主加载。RecallFlow 完全兼容 [SkillHub](https://www.skillhub.cn/) 的 `SKILL.md` 标准。

- **职责分工**：内置工具（`TOOL_REGISTRY`）定义能力边界，MCP 提供外部能力，技能只提供流程知识，不改变工具签名。
- **按需加载**：技能以目录形式进入系统提示，由模型按语义决定是否调用 `load_skill("<name>")` 获取完整说明，不依赖关键词硬匹配，避免误触发。
- **从 SkillHub 安装**：`install_skill` 优先拉取 SkillHub 上的 `SKILL.md` 原文；若该接口不可用（团队命名空间需鉴权或服务波动），降级为基于元数据生成的摘要，并提示可在技能页用「导入」获取完整版本。
- **内置技能（8 项）**：`highlight-key-points`、`remove-ads`、`userscript-task`、`clip-to-knowledge`、`humanizer`（去除 AI 腔调）、`find-skill-skillhub`、`summarize`、`agent-browser`。

## 证据与引用

- **引用可点击**：点击引用徽章，同页则就地高亮证据片段；跨页则打开来源页并自动滚动、高亮至证据位置（Chrome 文本片段深链与字符级容错匹配双重保障）。
- **编号一一对应**：全任务来源按 URL 去重并统一重编号，正文编号自 `[1]` 连续，与底部「参考来源」一致，避免错引；当前页分块与搜索候选不占用来源编号。
- **证据可归档复核**：读取过的页面落盘为带时间戳与哈希的不可变快照，网页变更或失效后仍可复核。

## 前端调试闭环与会话交接

前端问题的难点往往不在修改代码，而在确认修改正确。RecallFlow 将浏览器作为该闭环的验证端：

```text
get_element_source → 修改代码 → HMR → verify_change（断言渲染态 + 报告新错误） → page_health（增量体检）
     ↑                                          │
     └────────── 断言未通过 / 出现新错误 ──────────┘
```

- `get_element_source` 依据 React / Vue / Svelte 的开发构建信息，把元素解析到源码 `file:line`。
- `verify_change` 支持 `present / count / visible / text / value / minWidth / minHeight / styles` 断言，跨域 iframe 内元素同样适用。
- `page_health` 仅返回自上次检查以来**新增**的错误、警告与失败请求，并去重计数。
- 需先调用 `dev_session_set({ projectRoot, devUrl })`，源码位置才能由开发服务器 URL 转换为磁盘绝对路径。

### 会话交接

面板头部的会话标识芯片一点即复制以下指令：

```text
读取 RecallFlow 会话 RF-7K2M9X（页面：购物车）：请调用 recallflow_session("RF-7K2M9X") 取回该会话上下文，然后帮我解决其中的前端问题。
```

AI 据此取回一份自包含的交接包：面板对话、页面 URL 与标题、拾取的元素（含源码 `file:line`），以及复制那一刻的控制台错误快照——错误在事后往往已无法复现，该快照通常是最关键的证据。

标识采用无歧义字母表（不含 `0 / O / 1 / I / L`），同时接受 `rf-7k2m9x`、`7K2M9X` 等写法；最多保留最近 30 份，清空对话时轮换。

## 与 opencode / DSH 集成

RecallFlow 可作为 opencode / DSH 的浏览器执行端：`webfetch` 无法读取的 SPA、登录态或内网页面，交由 RecallFlow 以真实浏览器会话读取，并返回带时间戳与哈希的证据。

两种传输模式，共 **12 个工具**：

```text
① stdio（单实例）
   opencode ──(MCP stdio)──► recallflow-mcp ──┐
                                              ├──(WebSocket / HTTP 长轮询 :7801)──► RecallFlow 扩展
② HTTP（--http，多客户端共用一个常驻 server） │
   opencode A/B/C ──(MCP Streamable HTTP /mcp)┘
                                              └──► 证据归档 ~/.recallflow-evidence
```

> MCP 的 stdio 传输为 1:1：N 个 opencode 实例会各自启动一个 server 进程，而扩展只能连接占用桥接端口的那个，因此仅一个实例可读取页面。需要多实例并发时请改用 **HTTP 模式**（仅常驻一个 server，各客户端持有独立会话）。

- **工具（12 个）**：`browser_read`（真实会话读取并归档，返回 `fetchedAt` 与 `snapshotHash`）、`page_screenshot`（活动标签页截图并归档，纯文本模型可只取元数据）、`evidence_get`（复核引用）、`page_health`（增量错误体检）、`verify_change`（渲染态断言 + 新错误）、`read_console` / `read_network`（console 与网络请求，含堆栈与发起位置）、`get_element_source` / `get_picked_element`（元素 → 源码 `file:line`）、`recallflow_session`（读取面板交接的会话）、`dev_session_get` / `dev_session_set`（共享开发上下文）。
- **只暴露不可替代的能力**：真实会话浏览、证据归档、运行时调试与页面源码映射，不重复客户端已有的通用搜索与抓取。
- **证据纪律**：随附 `recallflow-evidence` 技能，约束「有据才断、网页内容不可信（防注入）、不编造来源、证据不足即明说」，并规定消息中出现 `RF-XXXXXX` 时先调用 `recallflow_session`。
- **安装与配置**：在 `integrations/opencode/recallflow-mcp` 执行 `npm install`。stdio / HTTP 两种模式的 `opencode.json` 写法、常驻 server 的启动方式与排障对照表见 [recallflow-mcp/README.md](integrations/opencode/recallflow-mcp/README.md)。
  - 配置 remote 时**必须显式设置 `timeout`**：opencode 的 MCP 请求默认超时仅 5000 ms，而 `browser_read` / `page_health` / `verify_change` 需等待扩展响应，可能耗时数十秒。

## 技术设计

- **任务规划**：多步任务以 `update_plan` 维护子目标清单，进度实时渲染于对话中。
- **上下文与用量管理**：过大的工具结果自动截断并将全文暂存，`expand_result` 支持按需分段读取；较早结果滚动折叠；API 用量实时计入并展示。
- **失败软着陆与完成校验**：`tool-guard.js` 统一判定重复调用、连续失败与无进展，默认仅摘除问题工具并注入反思继续执行，仅在跨工具持续无进展或全局预算触顶时收尾；声称完成前再以一次独立模型调用核对目标是否真正达成，未达成则要求更换做法。
- **统一注册表与意图路由**：模型工具列表、权限策略与参数校验共用一份定义；浏览器、知识库、研究、对话四类意图自动分流，「继续 / 接着」继承上一轮意图。
- **统一 Target 管理**：集中处理标签页与框架，以及 JS 对话框、下载等浏览器级事件。
- **运行轨迹与可观测性**：记录每个任务的步骤、工具、耗时、token 与错误码，可经 `get_run_trace` 查阅；并逐轮记录上下文缓存命中率与耗时分段（网络 / 预填充 / 生成 / 工具执行），使性能问题可定位至具体环节。
- **测试与门禁**：562 项单元测试（`node --test`）与 Playwright E2E 黄金任务；并以脚本化静态门禁覆盖「对 const 赋值」「请求前缀稳定性」等只能由运行时暴露、且症状隐蔽的缺陷类别。
- **可靠性**：支持会话恢复与卡死检测，动作前后进行快照校验，SPA 异步渲染产生的变化同样可捕获。

## 项目结构

```text
bookmark-sorter/
├── manifest.json / background.js / content.js   # MV3 扩展骨架
├── popup.js / options.js / manager.js           # 弹窗 / 设置 / 管理页
├── mock_server.py / error.html                  # 本地演示登录后端 + 报错页（开发调试用）
├── lib/
│   ├── shared/        # 存储、设置、RAG、常量、会话交接包、通用工具（handoff / handoff-store / lru）
│   ├── assistant/     # Agent 循环、工具注册表、意图路由、MCP、工具守卫、轨迹、校验器
│   │   ├── tools.js / intent-router.js / agent.js / mcp.js / tool-guard.js
│   │   ├── trace.js / verifier.js / context.js / session-store.js
│   │   └── skill-defs.js / skill-store.js / skill-md.js / skills.js   # 内置技能、技能存储、SKILL.md 解析、目录构建
│   ├── bridge/        # RecallFlow ↔ opencode 的本地中继（relay.js）
│   ├── backend/       # 浏览器级输入层（cdp.js：可信事件 / 截图 / 可访问性树 / 页面世界执行）
│   └── page/          # 正文提取与感知快照、高亮浮层、页面命令（含 run_javascript 沙箱）、对话面板与渲染
├── skills-page.js / skills.html / skills.css   # 技能中心 UI
├── scripts/                 # 静态门禁与构建辅助（check-const-assign / check-prefix-stability / render-icons）
├── tests/                   # 单元测试（node --test）+ E2E 黄金任务（Playwright + 模拟 LLM）
├── integrations/opencode/   # opencode 证据 MCP
│   ├── recallflow-mcp/      # MCP server（stdio + Streamable HTTP）+ 单元/集成测试 + README
│   ├── recallflow-evidence/ # 配套技能 SKILL.md（含会话交接与调试闭环规则）
│   └── mcp-contract.md      # 工具契约
└── docs/
    ├── tool-design.md   # 工具定义设计规范（粒度 / 参数 / 返回 / 风险分级）
    └── assets/          # 文档配图、Logo 与扩展图标
```

## License

[MIT](LICENSE)

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

**隐私优先**：数据全部保存在本地，唯一外连是你自配的 DeepSeek API Key。

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

## 功能亮点

- **读**：划词悬浮、多轮对话、整页上下文、RAG 检索、流式中断、对话撤销、可自定义快捷语句
- **操作**：点击 / 输入 / 滚动 / 高亮 / 改样式；自动等待页面就绪、识别遮挡，穿透 iframe 与 shadow DOM，点击新标签页自动接管
- **记忆**：错题 / 文章 / Prompt / 笔记四类知识库，支持星级、标签、搜索、导入导出，Agent 可读写
- **扩展**：支持 MCP 服务器，可接入文件系统、Notion 等外部能力（目标域名需加入 `manifest.json` 的 `host_permissions`）
- **用户脚本**：内置轻量用户脚本运行时，可从 GreasyFork 搜索或粘贴 `.user.js` 链接安装社区脚本；Agent 可按需求自动搜索 / 安装 / 运行脚本来完成任务（下载视频、展开全文、去广告等），安装前展示权限预览
- **安全**：写操作默认逐次审批，可按类别开启自动批准

## 技术亮点

- **统一工具注册表**：模型工具列表、权限策略、参数校验共用一份定义，不漂移
- **意图路由**：浏览器 / 知识库 / 研究 / 对话自动分流，避免工具乱用；「继续 / 接着」继承上一轮意图
- **明确收尾**：目标达成即调用 `complete_task` 结束任务，不空转
- **对话时间线**：过程叙述与工具步骤交插呈现，边干边说
- **可靠性**：Session 恢复、卡死检测、动作前后快照验证，SPA 异步渲染也能捕获变化

## 项目结构

```text
bookmark-sorter/
├── manifest.json / background.js / content.js   # MV3 扩展骨架
├── popup.js / options.js / manager.js           # 弹窗 / 设置 / 管理页
├── lib/
│   ├── shared/        # 存储、设置、RAG、常量
│   ├── assistant/     # Agent 循环、工具注册表、意图路由、MCP、卡死检测
│   └── page/          # 正文提取、高亮浮层、页面命令、对话面板
└── docs/assets/       # 文档配图与 Logo
```

## License

[MIT](LICENSE)

# RecallFlow 接入 RAG 可行性调研报告

> 调研日期：2026-10-31 · 范围：项目现状盘点 → 关键技术事实查证 → 业界做法 → 落地建议
> 结论先行：**可行，且有一条低风险路径**。推荐 v1 用免费云 embedding 快速验证，v2 加本地 embedding 作为隐私升级项。

---

## TL;DR

1. 项目现有「RAG」（`lib/shared/rag.ts:91 buildRagContext`）是**纯关键词 + bigram 打分**，无 embedding、无语义检索——这是唯一但核心的缺口。
2. **DeepSeek 不提供 embedding API**（官方文档仅有 chat/completions；第三方调 `/v1/embeddings` 返回 404）。Chrome 内置 AI（Gemini Nano）也没有生产可用的 embedding API。→ 向量化必须走「本地 transformers.js」或「第三方 embedding 服务」两条路。
3. MV3 Service Worker 跑不了长驻模型推理（约 30s 空闲即挂起、模型被 GC、每次唤醒重载 2-4s）。业界标准做法是放进 **offscreen document**（每扩展限 1 个），SW 只做消息路由；CSP 需加 `'wasm-unsafe-eval'`（MV3 唯一允许的放宽项）。
4. SiliconFlow 的 **BAAI/bge-m3 免费**、中文效果好、OpenAI 兼容端点（`https://api.siliconflow.cn/v1/embeddings`，1024 维 / 输入上限 8192 token），适合 v1 快速上线。
5. 结合方式上，**把检索做成 Agent 工具（agentic RAG）优于每轮自动注入**——每轮注入浪费 token 且降低上下文缓存命中；RecallFlow 已有完整工具体系（`knowledge_read({op})`），接入点现成。

**推荐路线**：v1 = 云 embedding（bge-m3 免费）+ IndexedDB 存向量 + 暴力余弦扫描；v2 = 增加「本地 embedding」开关（offscreen + transformers.js v4 + WebGPU 可用性检测，不可用自动降级到云）。embedding provider 从第一天就抽象成接口——**向量入库即锁定模型，换模型必须重建索引**。

---

## 1. 项目现状：已有能力与缺口

### 1.1 已有的

| 能力 | 位置 | 说明 |
|---|---|---|
| 关键词打分检索 | `lib/shared/rag.ts:91 buildRagContext` | title 3 / tags 2 / note 1 / type 0.5 / platform 0.5，命中多词有覆盖度奖励 |
| CJK 感知分词 | `lib/shared/rag.ts:21 tokenizeQuery` | 中文 3-4 字段 + bigram，保留整段 |
| 知识库概览问法 | `lib/shared/rag.ts:56 isKbOverviewQuery` | "知识库+有哪些/全部"类走 `buildKbOverview` |
| 引用卡片 | `lib/shared/rag.ts:141 buildCitations` | `_citations` 挂在消息数组上，UI 已存在 |
| Agent 工具路径 | `lib/application/agent/knowledge.ts` | `knowledge_read({op:'search'\|'list'\|'get'})`，risk:'read' / readOnly / parallelSafe（`lib/application/agent/tool-metadata.ts:35`） |
| 自动注入 | `lib/shared/rag.ts:187,233` | `buildAiMessages` 的 ask/command 动作里 `settings.ragEnabled` 时注入（默认 true，`lib/shared/settings.ts:32`） |
| 主存储 | `lib/shared/store.ts` | IndexedDB（自动从旧 chrome.storage.local 迁移）+ unlimitedStorage |

### 1.2 缺口

- **无 embedding、无语义检索**：query 与条目字面不重叠就检不到（同义改写、跨语言、口语化提问全部失效）。
- 数据形态有利：`KnowledgeItem`（`lib/domain/knowledge/model.ts`）= `{id, type, title, url, platform, platformName, status, note, tags, createdAt, updatedAt}`，**短文本条目**。→ 每条 item 一次 embedding（拼接 title+note+tags）即可，**现阶段不需要 chunking**；分块是未来把网页正文（`ctx.page`）落盘入库时才需要的设计。
- 站点记忆（`lib/application/agent/site-memory.ts`）是选择器+label，非文本语料，不适合做检索源。

### 1.3 工程约束（方案必须遵守）

- esbuild 打包；**运行时零依赖**（devDeps 仅 playwright/@types/chrome/esbuild/typescript）。
- 架构门禁 `npm run check:arch`：domain 不得依赖应用层/适配器；shared 不得反向依赖上层。
- 测试体系 node --test。
- `aiSettings` 是整对象替换写入 chrome.storage.local（`lib/shared/settings.ts:133,142-150`），新配置项沿用该模式。

---

## 2. 关键技术事实（2026-10-31 查证）

### 2.1 DeepSeek 无 embedding API 【已确认，决定性约束】

- 官方文档 [api-docs.deepseek.com](https://api-docs.deepseek.com/) 仅覆盖 chat/completions（OpenAI + Anthropic 兼容端点），API 参考中无 `/embeddings`。
- 官方 issue 明确答复："there is no dedicated embedding for any of the deep seek models"（[DeepSeek-V3#806](https://github.com/deepseek-ai/DeepSeek-V3/issues/806)）。
- 第三方 OpenAI 兼容网关调 `/v1/embeddings` 实测 404。
- **含义**：本项目 Agent 由用户自配 DeepSeek Key 驱动 → embedding 必须引入第二个 provider（云）或本地推理。Cherry Studio 等客户端的通行做法就是「DeepSeek 聊天 + 第三方 embedding」组合。

### 2.2 Chrome / Edge 内置 AI 无生产可用 embedding API 【已确认】

- 生产可用：Prompt API（`LanguageModel`，Gemini Nano）+ Summarizer / Translator / LanguageDetector；Writer/Rewriter/Proofreader 处于 flag 门控或 OT 过期状态。
- embedding 仅有 `SemanticEmbedder`——只在 Canary + flag `#semantic-embedder-api` 之后（Intent to Prototype 阶段，用 embeddinggemma-300m）。
- 参照：[Chrome 内置 AI 兼容性矩阵](https://danduh.me/courses/chrome-built-in-ai/shipping-and-compatibility)、[Edge Writing Assistance APIs](https://learn.microsoft.com/en-sg/microsoft-edge/web-platform/writing-assistance-apis)。
- **含义**：内置 AI 只能做可选的摘要/改写增强（如自动生成知识条目摘要），不能承担向量化。

### 2.3 MV3 运行本地模型：可行，但推理不能放 SW 【已确认】

- CSP：MV3 默认 `script-src 'self'; object-src 'self'`，需手动加 `'wasm-unsafe-eval'`（MV3 允许；`wasm-eval`/`unsafe-eval` 不行）——[Chrome CSP 文档](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)。WASM 文件必须随包分发（运行时下载 WASM 属 remote code，违规）。
- SW 生命周期是硬伤：约 30s 空闲即挂起，已加载的 ONNX 模型被 GC，每次唤醒重载 2-4s。
- 业界标准做法：**offscreen document**（`chrome.offscreen`，Chrome 109+；完整浏览器上下文、常驻内存、可跑 Worker/WebGL）。约束：每扩展只能有 **1 个** offscreen document（创建前用 `runtime.getContexts` 查重），多管线要共存在同一文档里（keyed pipeline registry）；用完空闲关闭。
- 参照：[实战文：transformers.js 迁出 SW 进 offscreen](https://dev.to/sathiyasenpai/why-i-moved-my-transformersjs-pipeline-out-of-the-chrome-mv3-service-worker-and-into-an-offscreen-1kk4)、[MV3 Hub: Running WASM and Heavy Compute Outside the Service Worker](https://www.mv3-extension.com/manifest-v3-architecture-extension-lifecycle/offscreen-documents-dom-access/running-wasm-and-heavy-compute-outside-the-service-worker/)。
- 本项目 manifest 已有 `offscreen` 相关基础（permissions 含 debugger/alarms 等），manifest.json 需新增：`permissions: ["offscreen"]` + CSP 加 `'wasm-unsafe-eval'`。

### 2.4 免费/低价 embedding 供应商 【已确认】

| 供应商 | 模型 | 价格 | 端点/规格 |
|---|---|---|---|
| **SiliconFlow** | **BAAI/bge-m3**、bge-large-zh-v1.5、bge-large-en-v1.5（免费 rerank：bge-reranker-v2-m3） | 免费（0 计费 + 固定速率限制，需实名；新用户赠 ¥16/$1） | OpenAI 兼容 `https://api.siliconflow.cn/v1/embeddings`（**注意用 .cn 域名**）；bge-m3 输入上限 8192 token、输出 1024 维 |
| 智谱 | Embedding-3 | 0.5 元/百万 token | 维度 256-2048 可选、上下文 8K（[文档](https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3)） |
| OpenAI | text-embedding-3-small | $0.02/百万 token（[定价](https://developers.openai.com/api/docs/models/text-embedding-3-small)） | 海外访问依赖用户网络 |
| Cloudflare Workers AI | bge-m3 | 免费 10,000 Neurons/天 | 需 CF 账号 |

参照：[SiliconFlow 价格页](https://siliconflow.cn/pricing)、[实测文](https://www.cnblogs.com/weiluliaokeji/p/22629480)。

### 2.5 本地 embedding 模型（transformers.js 路线）

- [transformers.js v4](https://huggingface.co/blog/transformersjs-v4)（npm `@huggingface/transformers`）支持 WebGPU 后端跑 feature-extraction；可在 MV3 扩展中运行（[指南](https://explore.n1n.ai/blog/use-transformers-js-chrome-extension-guide-2026-04-25)）。
- 常用模型：`all-MiniLM-L6-v2`（384 维，英文）、`bge-small-zh-v1.5`（512 维，中文），下载体积约 20-100MB（视量化）。
- 模型文件走 fetch + Cache API 可离线；首次下载需要网络。

---

## 3. 业界怎么做

### 3.1 浏览器扩展内 RAG 的三条路线

| 路线 | 代表产品 | 做法 | 借鉴点 |
|---|---|---|---|
| 本地模型全家桶 | **Page Assist**（开源，[github.com/n4ze3m/page-assist](https://github.com/n4ze3m/page-assist)） | Ollama（含本地 embedding）+ Chrome AI 双 provider，Chat with Webpage，数据全存本地 | provider 抽象、本地优先 |
| 云端闭源 | Sider / Monica | 云 embedding + 云 LLM，自家服务端做索引 | 需自建服务端，违背本项目本地优先定位 |
| 扩展只采集 | **Mem0 OpenMemory**（[博客](https://mem0.ai/blog/introducing-the-openmemory-chrome-extension)） | 扩展只做采集展示，检索在本地 MCP server + Qdrant（docker） | **纯扩展进程内做记忆检索无成熟先例——RecallFlow 属先走，但技术要素都有现成拼图** |

另外：Chrome 自带 History search 是内置全文索引（非向量）；LanceDB WASM 的 in-browser 支持仍在 beta（[issue #230](https://github.com/lancedb/lancedb/issues/230)），不建议生产。

### 3.2 轻量 RAG 架构（2024-2026 主流）

- **chunking**：递归分块是默认主流，chunk 400-800 token、overlap 10-15%；网页按标题/段落结构切块优于固定窗口。语义分块需额外模型调用，小规模收益有限。→ **对本项目当前数据形态（短条目）不适用，一条一向量即可。**
- **embedding**：见 §2.4/§2.5。
- **向量检索**：≤5 万条向量时暴力余弦毫秒级返回，完全够用；HNSW 是免费升级项（Orama 内置），无需调参。
- **rerank**：非必需。几千条取 top8-10 直拼 prompt；需精排时让 DeepSeek 兼任 LLM reranker（零额外依赖），或用 SiliconFlow 免费 bge-reranker-v2-m3。
- **hybrid（BM25+向量）**：对专有名词/精确匹配收益明显；Orama 原生支持全文+向量+hybrid（[github.com/oramasearch/orama](https://github.com/oramasearch/orama)），零依赖、支持 browser/worker。→ 与现有 `rag.ts` 关键词打分天然互补：**保留关键词通道作为 hybrid 的一半**，而不是扔掉。

### 3.3 Agent + RAG 的结合方式

| 方式 | 代表 | 特点 |
|---|---|---|
| **tool 式（agentic RAG）** | LangChain `create_retriever_tool`、LlamaIndex QueryEngineTool、OpenAI function calling | 检索包装成工具由模型按需调用；可多轮迭代、按需花 token；2025 主流方向 |
| auto-RAG（每轮注入） | OpenAI Assistants file_search（[指南](https://developers.openai.com/api/docs/guides/tools-file-search)） | 实现简单，但每轮携带检索 token：浪费且降低上下文缓存命中 |

**对本项目**：已有 Agent 工具体系 → 首选 tool 式（`knowledge_read({op:'search'})` 升级为语义检索）；`settings.ragEnabled` 的自动注入保留为开关（或降级为"仅在用户明确指向当前页面时预注入当页内容"的折中）。

---

## 4. 可行性结论与推荐方案

### 4.1 三方案对比

| 方案 | 成本 | 隐私 | 复杂度 | 结论 |
|---|---|---|---|---|
| ① 本地 embedding + 本地索引 | 0（模型一次性下载 20-100MB） | 最优（正文不出设备，仅 query 出网或全本地） | 中（offscreen 管线 + 模型下载/降级逻辑 + 包体增大） | v2 目标形态 |
| ② 云 embedding + 本地索引 | ≈0（SiliconFlow 免费 / 智谱 0.5 元/M） | 中（正文片段出网，需在设置页明示） | 低（OpenAI 兼容 fetch，约 30 行，可立即上线） | **v1 起步** |
| ③ 全云（云 embedding + 云索引） | 需自建服务端 | 最差 | 高 | 排除（违背本地优先） |

### 4.2 推荐路线图

**v1（云 embedding 验证召回质量）**
1. `EmbeddingProvider` 接口 + 向量余弦检索纯逻辑放 `lib/shared/`（或 domain，遵守 check:arch 依赖方向）；SiliconFlow 客户端（fetch）放适配器层。
2. IndexedDB 新增向量 object store（复用 `lib/shared/store.ts` 的 DB 与迁移模式）；入库时记录 embedding 模型名——**换模型必须重建索引**（各模型向量空间互不兼容）。
3. `knowledge_read({op:'search'})` 内部升级为：语义检索 + 现有关键词打分**混合**（加权融合），复用 `buildCitations` 出引用卡片。
4. 设置页新增：embedding provider 选择（默认 SiliconFlow bge-m3）+ 用户自配 key（与 DeepSeek key 分开存，沿用 `aiSettings` 整对象替换模式）+ 「检索片段会发送到 embedding 服务」的隐私明示。
5. 写路径挂钩：`add_entry` 时同步生成向量（写串行化复用 `lib/application/knowledge/repository.ts` 模式）；启动/升级时对存量条目做一次性补嵌（分批 + 速率限制退避）。

**v2（本地 embedding 隐私升级）**
1. offscreen document（`chrome.offscreen`，Chrome 109+）承载 transformers.js v4 管线；SW 只做消息路由；manifest 加 `permissions:["offscreen"]` + CSP `'wasm-unsafe-eval'`；模型文件随包或首启下载入 Cache API。
2. `EmbeddingProvider` 增加 LocalProvider 实现；设置页开"本地优先"开关：检测 WebGPU/availability，不可用自动降级到云 provider。
3. offscreen 空闲 60s 关闭释放内存；每扩展仅 1 个 offscreen document，若未来有其他重计算需求共用同一文档。

**v2+（可选增强）**
- 网页正文入库时才引入 chunking（按标题/段落结构切块）。
- Chrome 内置 Summarizer 自动生成条目摘要，提升条目文本质量（embedding 输入）。
- 需要 rerank 时：DeepSeek 兼任 LLM reranker 或 SiliconFlow 免费 bge-reranker-v2-m3。

### 4.3 风险与注意事项

- **向量空间锁定**：embedding 模型与向量必须成对存储（记 model 名），换模型全量重建索引；v1→v2 切换 provider 时同样触发重建。
- **SiliconFlow 免费层**：0 计费但有固定速率限制（不可付费提升），补嵌存量条目要分批 + 429 退避；端点必须用 `.cn` 域名。
- **包体**：本地路线 transformers.js + 模型会显著增大包/缓存体积；MV3 商店对包大小有限制，模型宜走运行时下载（注意：WASM 本体必须随包，模型权重可以运行时下）。
- **每轮注入 vs 工具式**：若保留 `ragEnabled` 每轮注入，注意它对上下文缓存命中率的伤害（每轮携带检索结果 = 稳定前缀被改写）；工具式让模型按需检索更省。
- **先走没有先例**：纯扩展进程内做知识检索无成熟同类产品（Mem0 都把检索放在扩展外），但所有技术要素（offscreen、transformers.js、免费 embedding、IndexedDB）都是生产验证过的成熟件，拼装风险可控。

---

## 5. 结论

**接入 RAG 可行**，且与项目现状高度兼容：工具路径、引用卡片、IndexedDB、设置体系全部现成，只缺 embedding 这一层。业界成熟做法可以概括为一句话——

> **小规模本地优先的扩展 RAG = provider 抽象的 embedding（云起步/本地升级）+ 向量与关键词 hybrid 检索 + Agent 工具式按需调用。**

按 §4.2 路线图，v1 约一天工作量（一个 fetch 客户端 + 一个向量存储 + 混合打分融合），即可把"字面匹配检索"升级为"语义检索"；v2 再用 offscreen + transformers.js 把隐私边界推进到"数据不出设备"。

---

## 附：关键参考链接

- DeepSeek API 文档（无 embeddings）：https://api-docs.deepseek.com/ · issue：https://github.com/deepseek-ai/DeepSeek-V3/issues/806
- transformers.js v4：https://huggingface.co/blog/transformersjs-v4 · MV3 运行指南：https://explore.n1n.ai/blog/use-transformers-js-chrome-extension-guide-2026-04-25
- offscreen 实战：https://dev.to/sathiyasenpai/why-i-moved-my-transformersjs-pipeline-out-of-the-chrome-mv3-service-worker-and-into-an-offscreen-1kk4 · MV3 WASM 指南：https://www.mv3-extension.com/manifest-v3-architecture-extension-lifecycle/offscreen-documents-dom-access/running-wasm-and-heavy-compute-outside-the-service-worker/
- Chrome CSP：https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy · 内置 AI 兼容矩阵：https://danduh.me/courses/chrome-built-in-ai/shipping-and-compatibility
- Orama：https://github.com/oramasearch/orama · Page Assist：https://github.com/n4ze3m/page-assist · Mem0 OpenMemory：https://mem0.ai/blog/introducing-the-openmemory-chrome-extension
- SiliconFlow 价格：https://siliconflow.cn/pricing · bge-m3 实测：https://www.cnblogs.com/weiluliaokeji/p/22629480 · 智谱 Embedding-3：https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3
- OpenAI file_search：https://developers.openai.com/api/docs/guides/tools-file-search · text-embedding-3-small：https://developers.openai.com/api/docs/models/text-embedding-3-small

// 内置（默认）技能：采用 SkillHub 标准 SKILL.md 形态。
// 字段对齐：name(slug, kebab-case) / description(何时使用) / version / category / tags /
//           skill_type(默认 prompt-template) / content(Markdown 指令正文) /
//           x.recallflow-*（RecallFlow 专用触发条件，符合 SkillHub 的 x- 扩展约定）
export const SKILL_REGISTRY = Object.freeze([
  {
    name: 'highlight-key-points',
    displayName: '划重点 / 高亮关键信息',
    description: '在网页上挑选关键句子并高亮，输出要点总结。当用户要求划出/标出关键信息时使用。',
    version: '1.0.0',
    category: 'reading',
    tags: ['高亮', '阅读', '总结'],
    skill_type: 'prompt-template',
    content:
      '# 划重点 / 高亮关键信息\n\n' +
      '先用 read_current_page 或 get_page_snapshot 理解全文，再决定划几条。\n' +
      '\n' +
      '## 划多少条\n' +
      '- **用户明确说了条数就按用户说的**（如「划 5 条重点」）。\n' +
      '- 没说的话按正文规模分档，不要固定取上限：\n' +
      '  - 正文 < 2000 字 → 3-5 条\n' +
      '  - 正文 2000-10000 字 → 5-8 条\n' +
      '  - 正文 > 10000 字 → 8-12 条\n' +
      '- 正文规模看 read_current_page 结果里的「正文约 N 字」。内容密度明显偏低（如大量重复的\n' +
      '  导航/列表文字）时取下限，密度高（如多段结论）时取上限。\n' +
      '- 关键在于**每条都要是能独立成立的结论或事实**，凑不满档位就少划几条，不要为了达到\n' +
      '  条数把同一句话拆成两条，也不要划"这一节讲了三件事"这类没有信息量的概括。\n' +
      '\n' +
      '## 怎么划\n' +
      '- 全部关键句子用一次 annotate({op:"highlight"}) 调用并传 texts 数组（texts: ["句子1", "句子2", …]），不要逐条多次调用；每段 text 必须使用页面中的原文片段，不能改写或概括。\n' +
      '- 单次调用有条数上限（见 annotate 工具定义里 op=highlight 的 texts 说明）；超出部分不会被处理，结果里会写明还剩多少条未处理，需要再调用一次补齐。\n' +
      '- 高亮前先调用 annotate({op:"clear"}) 清除上一次浮层，避免叠加遮挡文字。\n' +
      '- 全部高亮完成后用 complete_task 输出要点总结。',
    x: {
      intents: ['browser_task'],
      keywords: ['划出|划重点|标出|标重点', '关键信息|重点内容|重点句子|精华|关键点'],
      tools: ['read_current_page', 'get_page_snapshot', 'annotate', 'complete_task'],
    },
  },
  {
    name: 'remove-ads',
    displayName: '去广告 / 屏蔽推广',
    description: '定位广告或推广模块并隐藏/关闭。当用户要求去掉或屏蔽广告、推广、弹窗时使用。',
    version: '1.0.0',
    category: 'browser',
    tags: ['广告', '页面清理'],
    skill_type: 'prompt-template',
    content:
      '# 去广告 / 屏蔽推广\n\n' +
      '- 先 get_page_snapshot 定位目标元素。\n' +
      '- 优先用 annotate({op:"style", hide:true}) 将其设为 display:none；若有明确关闭按钮则用 click_element。\n' +
      '- 执行后以真实返回为准回复，不要声称已生效而实际未操作。',
    x: {
      intents: ['browser_task'],
      keywords: ['去掉|去除|移除|屏蔽|隐藏', '广告|推广|弹窗'],
      tools: ['get_page_snapshot', 'annotate', 'click_element', 'complete_task'],
    },
  },
  {
    name: 'userscript-task',
    displayName: '用户脚本任务（下载/展开/签到/抢购）',
    description: '需要脚本能力的任务：下载视频、展开全文、自动签到、抢购、去广告脚本等。',
    version: '1.0.0',
    category: 'browser',
    tags: ['脚本', '自动化'],
    skill_type: 'prompt-template',
    content:
      '# 用户脚本任务\n\n' +
      '1. list_userscripts 看是否已有可复用脚本。\n' +
      '2. 没有则 search_userscripts 搜索 GreasyFork（关键词贴合任务）。\n' +
      '3. install_userscript 安装（需用户确认权限预览）后 run_userscript 在当前页运行。\n' +
      '4. 用 get_page_snapshot 验证页面是否出现预期效果，再 complete_task。',
    x: {
      intents: ['browser_task'],
      keywords: ['下载视频|视频下载|下载这个|展开全文|自动签到|抢购', '脚本|userscript'],
      tools: ['list_userscripts', 'search_userscripts', 'install_userscript', 'run_userscript', 'get_page_snapshot', 'complete_task'],
    },
  },
  {
    name: 'clip-to-knowledge',
    displayName: '剪藏到知识库',
    description: '把当前网页/对话中的要点保存进个人知识库。当用户要求保存、收录、剪藏内容时使用。',
    version: '1.0.0',
    category: 'knowledge',
    tags: ['知识库', '收藏'],
    skill_type: 'prompt-template',
    content:
      '# 剪藏到知识库\n\n' +
      '1. 从当前页面或对话中提取要保存的要点。\n' +
      '2. search_knowledge_base 查重，避免重复收录同一来源。\n' +
      '3. add_entry 写入（未命中重复时）；note 应提炼要点而非整页粘贴，type 按内容选 wrong/article/ai/note。\n' +
      '4. complete_task 给出已保存摘要。',
    x: {
      intents: ['browser_task', 'research_task', 'knowledge_task'],
      keywords: ['保存|收录|加入收藏|存入|剪藏|收藏这个|存下来'],
      tools: ['add_entry', 'search_knowledge_base', 'get_entry', 'complete_task'],
    },
  },
  {
    name: 'humanizer',
    displayName: 'Humanizer（去 AI 味）',
    description:
      '消除 AI 生成写作痕迹，使文本更自然、像人写。当用户要润色、改写、审查文本，或要求"更自然/去 AI 味/像人写"时使用。',
    version: '1.0.0',
    category: 'content-creation',
    tags: ['润色', '去AI味', '写作', 'humanizer'],
    skill_type: 'prompt-template',
    content:
      '# Humanizer · 去除 AI 写作痕迹\n\n' +
      '当用户要求润色、改写、审查文本，使其更自然真实、不像机器生成时，遵循以下指引：\n\n' +
      '## 需检测并修正的 AI 写作模式\n' +
      '- 夸张象征（inflated symbolism）\n' +
      '- 宣传式用语（promotional language）\n' +
      '- 肤浅的 -ing 分析（superficial -ing analyses）\n' +
      '- 模糊归因（vague attributions，如"研究表明""有人认为"而无出处）\n' +
      '- 破折号（em dash）滥用\n' +
      '- 三项排比（rule of three）过度使用\n' +
      '- AI 高频词汇（"值得注意的是""综上所述""在当今社会""赋能""闭环"等）\n' +
      '- 负面平行结构（negative parallelisms）\n' +
      '- 过度连接词堆砌（therefore / moreover / furthermore 等）\n\n' +
      '## 改写原则\n' +
      '- 用具体、口语化、有观点的表达替代空泛套话；\n' +
      '- 保留原意与事实，不添加虚构内容；\n' +
      '- 句式长短交错，避免整齐划一的排比；\n' +
      '- 直接陈述，减少"首先/其次/最后"式机械结构。',
    // 触发条件原先缺失（人类可读的描述写了「当用户要求润色/改写时使用」，但没有 x 块），
    // 而 detectSkill 把「关键词数组为空」当作通配符（skills.js:28/31），
    // 于是这个技能会在**每一个非对话任务**上被注入正文，既污染提示词也劫持工作流。
    // 这里按描述补齐触发条件，使其与其他四个内置技能的处理方式一致。
    x: {
      intents: ['chat_task', 'research_task', 'browser_task'],
      keywords: ['去 ?AI ?味|AI味|润色|改写|更像人写|像人写|口语化'],
      tools: [],
    },
  },
  {
    name: 'find-skill-skillhub',
    displayName: 'Find Skill · SkillHub',
    description:
      '当用户想"找/安装某个技能""有没有能做 X 的技能""帮我在 SkillHub 找个 Y 技能"时，从 SkillHub 平台检索并安装技能。',
    version: '1.0.0',
    category: 'ai-agent',
    tags: ['skillhub', '技能市场', '安装', 'find-skills'],
    skill_type: 'prompt-template',
    content:
      '# Find Skill · 从 SkillHub 发现并安装技能\n\n' +
      '当用户询问"有没有能做 X 的技能""帮我找个 Y 技能""怎么安装某技能"时，按以下流程：\n\n' +
      '1. 明确需求：弄清用户想要的能力（如"周报生成""去广告""论文润色"）。\n' +
      '2. 检索 SkillHub：用 fetch_webpage 访问 ' +
      'https://api.skillhub.cn/api/v1/search?keyword=<关键词>，从 results 中挑匹配的技能' +
      '（看 name / summary / category，优先 PUBLIC、下载量与 stars 高的）。\n' +
      '3. 安装：调用 install_skill，identifier 用技能坐标 @namespace/slug' +
      '（来自搜索结果的 namespace.canonicalName，例如 @clawhub_root/find-skills）。\n' +
      '4. 加载使用：安装成功后调用 load_skill("<name>") 获取其完整说明并遵循。\n\n' +
      '注意：\n' +
      '- install_skill 仅允许 skillhub.cn 来源，且需用户确认；\n' +
      '- 检索无果时如实告知，不要虚构"找到 N 个技能"；\n' +
      '- 若 install_skill 因接口限制失败，提示用户去 https://www.skillhub.cn/ 手动浏览安装。',
    // 同上：补上原本缺失的触发条件，避免通配注入。
    x: {
      intents: ['chat_task', 'research_task', 'knowledge_task'],
      keywords: ['找.*技能|有没有.*技能|安装.*技能|技能市场|SkillHub|skillhub'],
      tools: ['fetch_webpage', 'install_skill', 'load_skill'],
    },
  },
  {
    name: 'summarize',
    displayName: 'Summarize（总结）',
    description:
      '将长文、网页、对话、文档等内容提炼为简洁准确的摘要。当用户要求"总结/概括/提炼要点/一句话说清"时使用。',
    version: '1.0.0',
    category: 'reading',
    tags: ['总结', '摘要', '提炼', 'summarize'],
    skill_type: 'prompt-template',
    content:
      '# Summarize · 内容总结\n\n' +
      '当用户要求"总结/概括/提炼要点/用一段话说明/一句话说清"时，遵循以下指引：\n\n' +
      '## 流程\n' +
      '1. 明确目标与受众：是全文摘要、要点列表，还是一句话结论？长度与粒度按用户要求。\n' +
      '2. 获取原文：网页用 fetch_webpage / read_current_page；对话/文档直接用已有内容；超长内容先分段提取关键信息。\n' +
      '3. 提炼：区分主干与细节，保留核心论点、结论、关键数据与因果，剔除重复与客套。\n' +
      '4. 输出：按用户指定格式（段落 / 要点 / 表格）；未指定时默认"3-5 条要点 + 一句总括"。\n\n' +
      '## 原则\n' +
      '- 忠实：不添加原文没有的事实或观点，不确定处标注"原文未提及"；\n' +
      '- 精炼：用具体名词替换空泛表述，避免"首先/其次"式机械结构；\n' +
      '- 可读：长摘要用分层标题，关键信息前置（倒金字塔）。',
    // 同上：补上原本缺失的触发条件，避免通配注入。
    x: {
      intents: ['chat_task', 'research_task', 'browser_task', 'knowledge_task'],
      keywords: ['总结|概括|提炼|摘要|摘要要点|一句话说清|要点列表'],
      tools: ['read_current_page', 'get_page_snapshot', 'fetch_webpage', 'complete_task'],
    },
  },
  {
    name: 'agent-browser',
    displayName: 'Agent Browser（浏览器自动化）',
    description:
      'Browser automation CLI for AI agents. 当用户需要与网站交互（浏览页面、填写表单、点击按钮、截图等）时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['浏览器自动化', 'agent-browser', 'skillhub', '自动化'],
    skill_type: 'prompt-template',
    content:
      '# Agent Browser · 浏览器自动化\n\n' +
      '当用户需要让 AI 操控浏览器完成网页任务（打开页面、填写表单、点击按钮、滚动、截图、抓取信息等）时，遵循以下指引：\n\n' +
      '## 流程\n' +
      '1. 明确任务目标与终止条件：要访问哪个站点、完成什么操作、如何判断成功。\n' +
      '2. 规划步骤：将复杂任务拆为「导航 → 定位元素 → 操作 → 校验」的循环。\n' +
      '3. 执行：优先使用 RecallFlow 的页面操作工具（点击 / 输入 / 滚动 / 高亮 / 改样式）；' +
      '用 read_current_page / get_page_snapshot 获取当前页面结构与可操作元素，用 fetch_webpage 读取页面文本。\n' +
      '4. 校验：每步操作后确认结果（元素出现、表单已填、页面已跳转），失败则重试或换路径；遇到遮挡/弹窗先处理再继续。\n' +
      '5. 收尾：用 complete_task 汇报结果（含关键 URL、提取的数据）。\n\n' +
      '## 原则\n' +
      '- 一次只做一步可验证的操作，避免长链未校验；\n' +
      '- 写入类操作（填表、提交）遵循审批策略，必要时先征得用户确认；\n' +
      '- 截图/读取仅用于理解页面，不泄露敏感信息。',
  },
  {
    name: 'search-within-site',
    displayName: '站内检索（搜索 + 结构化取回结果）',
    description:
      '在站点自己的搜索框里检索，并把结果条目结构化取回。当用户要求「在某个网站/站内搜一下…」「把这个站的结果列出来」时使用。',
    version: '1.0.0',
    category: 'browser',
    tags: ['检索', '搜索', '结果列表', '填表'],
    skill_type: 'prompt-template',
    // 下面这段内容里的每一条都来自 tests/e2e/golden.spec.mjs 的
    // 「站内检索」端到端用例（playbook id = site-search）：它不是凭空写的技法，
    // 而是那条剧本**实际验证过**的路径。工具集也必须与剧本一致 —— 由
    // tests/skill-playbook-contract.test.mjs 机检，漂移会红灯。
    content:
      '# 站内检索\n\n' +
      '## 步骤（顺序有理由，不要跳）\n' +
      '1. `get_page_snapshot` 看页面，找到搜索输入框与提交按钮；\n' +
      '2. `type_text` 填查询词 —— **`value` 是要输入的内容、`text` 是定位用的文本片段**，两者语义不同，别混用；\n' +
      '3. `click_element` 点搜索按钮；\n' +
      '4. **等结果渲染出来**再读 —— 用 `wait_for_element({ selector, state: "visible" })` 等**结果条目**出现\n' +
      '   （别等容器：容器一开始就在，等它等于没等），然后 `inspect_element({op:"text"})` 取**结果列表容器**的文本，\n' +
      '   不要把整页倒回来；\n' +
      '5. 汇总时给出条目标题与关键字段（价格/时间/评分等），并说明共取到几条。\n\n' +
      '## 四个容易踩的点\n' +
      '- **结果列表是异步渲染的。** 点击后不要立刻读列表，否则拿到空结果并把"没搜到"当成事实。\n' +
      '  这条不是理论：本仓库的检索剧本自己就漏过一次，成了**5 次里失败 1 次**的间歇性用例 ——\n' +
      '  而失败信息只显示"结果里没有某条目"，完全指不到"读早了"。\n' +
      '- **语义定位要求页面规范可访问。** `role`+`name` 只在元素真的暴露了 role/aria-label 时才命中；\n' +
      '  遇到老页面/自研组件时回退 `selector` 或 `text`。命中失败时先怀疑"定位条件不够"，\n' +
      '  而不是先断言"页面上没有这个输入框"。\n' +
      '- **广告条目和真实结果要分开判断。** 检索阶段先把带 "广告/推广/赞助" 标记的条目照原样取回，\n' +
      '  不要悄悄丢掉 —— 丢不丢是用户的选择，不是检索这一层的决定。\n' +
      '- **别把整页文本丢给自己当"结果"。** 结构化字段（标题/价格）才是可核对的交付物。',
    x: {
      intents: ['browser_task'],
      keywords: ['站内搜|站内检索|搜一下|搜索|检索', '结果|列表|条目|前几条'],
      tools: ['get_page_snapshot', 'type_text', 'click_element', 'wait_for_element', 'inspect_element', 'complete_task'],
      // 与能力剧本的对应关系（契约门禁据此核对 x.tools 是否覆盖剧本实际用到的工具）
      playbook: 'site-search',
    },
  },
  {
    name: 'checkout-form',
    displayName: '下单 / 多步表单（选商品 → 填写 → 勾选确认 → 提交）',
    description:
      '在网页上完成一次多步表单提交（下单、预约、报名、问卷）。当用户要求「帮我下单/预约/报名/填一下这个表单」时使用。',
    version: '1.0.0',
    category: 'browser',
    tags: ['下单', '表单', '多步', '提交'],
    skill_type: 'prompt-template',
    // 与 search-within-site 同样：内容里的每一条都来自 tests/e2e/golden.spec.mjs
    // 的「点单」端到端用例（playbook id = checkout-form）实际验证过的路径。
    content:
      '# 下单 / 多步表单\n\n' +
      '## 顺序（先填齐、再提交，不要边填边提交）\n' +
      '1. `get_page_snapshot` 看清有哪几项必填、各是什么控件；\n' +
      '2. 下拉框用 `select_option`（按 `selector` + `label`/`value`）；\n' +
      '3. 文本项用 `type_text`（`role`+`name` 定位，**`value` 是要输入的内容**）；\n' +
      '4. 勾选框用 `check_box`（`role`+`name` 定位，必须带 `checked`）；\n' +
      '5. 全部填齐后再 `click_element` 提交；\n' +
      '6. **读回结果**（`inspect_element` 取结果区域）后才算完成。\n\n' +
      '## 四个容易踩的点\n' +
      '- **「点了提交」不等于「提交成功」。** 表单有业务校验：缺必填项时页面只会回一句提示、\n' +
      '  页面状态毫无变化。**只有读回结果**才能区分"下单了"和"点了一下"。\n' +
      '- **确认/同意类勾选常常是承重件。** 不勾选，提交会静默失败或只回一句提示。\n' +
      '  别跳过它，也别以为它只是装饰。\n' +
      '- **失败提示要照实读出来，别原样重试。** 页面回「请补全信息」时，应指出**差哪一项**，\n' +
      '  而不是把同一个提交动作再点一次 —— 真实站点这么做通常会被限流或触发风控。\n' +
      '- **定位方式按工具而异。** `select_option` 的 schema 只接受 `ref`/`selector`；\n' +
      '  文本框与勾选框支持 `role`+`name`。用错定位方式会得到「未找到元素」，\n' +
      '  而那是**定位条件不够**，不代表页面上没有这个控件。\n\n' +
      '## 提交前必须让用户确认\n' +
      '下单/预约这类**有副作用的写操作**，按审批策略执行；涉及金额、地址、时间等关键信息时，\n' +
      '把即将提交的内容复述一遍再提交。',
    x: {
      intents: ['browser_task'],
      keywords: ['下单|购买|买|预约|报名|结账|结算', '表单|填写|提交|收货'],
      tools: ['get_page_snapshot', 'select_option', 'type_text', 'check_box', 'click_element', 'inspect_element', 'complete_task'],
      playbook: 'checkout-form',
    },
  },
  {
    name: 'readability-fix',
    displayName: '可读性美化（把难读的页面调成易读）',
    description:
      '调整页面的正文排版与容器宽度，让它更好读（字号、行高、对比度、行宽）。当用户要求「这页面看着累/太挤/字太小/帮我美化一下」时使用。',
    version: '1.0.0',
    category: 'browser',
    tags: ['美化', '可读性', '样式', '排版'],
    skill_type: 'prompt-template',
    content:
      '# 可读性美化\n\n' +
      '## 步骤（三个量都要处理，**不要只改前两个就收尾**）\n' +
      '1. `get_page_snapshot` 看清结构，找到包住正文的那一层容器（常是 `.wrap` / `.article` / `.content`，\n' +
      '   **通常不是 body**）；\n' +
      '2. `inspect_element({ op: "styles" })` 读**改动前**的字号/行高/对比度，作为对照；\n' +
      '3. **改排版**：`annotate({ op: "style", selector: "body", styles: { fontSize: "17px", lineHeight: "1.7", color: "#1a1a1a", background: "#ffffff" } })`；\n' +
      '4. **改行宽 / 修横向溢出 —— 必须单独做这一步**：\n' +
      '   `annotate({ op: "style", selector: "<上面找到的宽容器>", styles: { width: "auto", maxWidth: "760px" } })`；\n' +
      '5. `inspect_element({ op: "styles" })` 读回**改动后**的值，逐项确认真的生效；\n' +
      '6. 汇报改了哪些属性、前后值各是多少。\n\n' +
      '## 为什么第 4 步必须单独列出来\n' +
      '真模型实测（2026-01，deepseek 系列）**只做了第 3 步就收尾**：字号、行高、对比度全部达标，\n' +
      '但**横向溢出原封不动** —— 因为宽度问题不在正文排版里，改 body 的字号不会影响一个固定 1500px 的容器。\n' +
      '结果页面"看起来好了一点"，用户仍要左右拖动才能读完一行。\n' +
      '**判据是：横向滚动消失**（`document.documentElement.scrollWidth` 不再大于视口宽度），\n' +
      '而不是"我改过样式了"。找不到是哪个容器宽，就逐个查 `inspect_element({ op: "styles", props: ["width","overflow-x"] })`，\n' +
      '比猜快。\n\n' +
      '## 三个真正影响可读性的量\n' +
      '1. **字号**：正文 ≥16px（本仓库的验收值取 17px）；\n' +
      '2. **行高**：行高比 ≥1.6（行贴太近会串行）；\n' +
      '3. **行宽**：一行 60–80 字符。容器固定超宽会造成**横向溢出**，\n' +
      '   改法是把固定 `width` 换成 `auto` + `maxWidth`（约 720–800px），而不是缩小字号。\n\n' +
      '## 对比度要按「有效背景」算\n' +
      '元素自身的 `background-color` 默认是 **transparent**。直接用元素背景算对比度，\n' +
      '透明会被当成黑色，于是深色文字算出来接近 1:1 —— **改好了却判成没改好**。\n' +
      '正确做法是**向上找第一个不透明背景**（通常是 `body`）。\n\n' +
      '## 怎么改、怎么验\n' +
      '- 改样式用 `annotate({ op: "style", selector, styles })`，`styles` 是**扁平** CSS 属性；\n' +
      '  多处同类一起改就用 `selectors` 数组一次传（≤20 个），不要循环调用。\n' +
      '- **改完必须读回计算后的值**才算验证过：`inspect_element({ op: "styles", selector, props })`。\n' +
      '  工具回的「已修改 N 个元素」证明的是"调用发出去了"，不是"样式真的生效了"\n' +
      '  —— 取值可能非法被忽略，也可能被别处的 `!important` 覆盖。\n' +
      '  `props` 用连字符写法（`font-size` / `max-width`），不传则读一组常用属性。\n' +
      '- **不要用 `run_javascript` 读样式**：它每次都要用户批准，而且要开 CDP 才能跑\n' +
      '  （沙箱依赖 eval，而 MV3 扩展自身的 CSP 不允许 eval，与页面无关）。\n' +
      '  `inspect_element({ op: "styles" })` 是只读的、不需要批准。\n' +
      '- 需要给用户可视证据时用 `take_screenshot`，但**你看不到图像内容**，\n' +
      '  不要据"已截图"声称视觉上已经改好。\n\n' +
      '## 绝不允许的"达标"方式\n' +
      '把正文 `display:none`、或删掉内容，都能让"对比度""不溢出"立刻达标。\n' +
      '**那是搞坏，不是美化。** 改完必须确认内容仍在、字数没少。',
    x: {
      intents: ['browser_task'],
      keywords: ['美化|好看|排版|字太小|太挤|读起来|可读性', '样式|行高|字号|对比度|宽度'],
      tools: ['get_page_snapshot', 'annotate', 'inspect_element', 'take_screenshot', 'complete_task'],
      playbook: 'readability-fix',
    },
  },
  {
    name: 'debug-console-error',
    displayName: '排查「点了没反应」（先复现，再读运行期事实）',
    description:
      '页面上的交互没有生效、按钮点了没反应、结果没出来时，定位真实原因。当用户说「点了没反应 / 按钮不管用 / 怎么没生效 / 帮我看看为什么」时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['排查', 'debug', '控制台报错', '复现'],
    skill_type: 'prompt-template',
    content:
      '# 排查：点了没反应\n\n' +
      '## 最关键的一条：**先复现，再读诊断**\n' +
      '顺序反了会得到一条**空诊断**，然后极易得出"页面没问题"的错误结论 ——\n' +
      '因为错误往往只在交互发生的那一刻才产生，加载完的页面看起来一切正常。\n\n' +
      '## 步骤\n' +
      '1. `get_page_snapshot` 找到触发交互的元素（本例是按钮）；\n' +
      '2. `click_element`（或对应的输入/选择动作）**把问题复现出来**；\n' +
      '3. `read_diagnostics({ kind: "console", level: "error" })` 读**运行期事实**；\n' +
      '4. `inspect_element({ op: "text" })` 确认症状（结果区确实是空的，而不是你没找到）；\n' +
      '5. 汇报**证据 + 推断**，并明确区分两者。\n\n' +
      '## 四条纪律\n' +
      '- **报错文案要照原文引用**，不要转述成"好像有个错误"。\n' +
      '  「TypeError: Cannot read properties of undefined (reading \'total\')」是证据，\n' +
      '  "可能是数据没取到"是你的推断 —— 两者不能混为一谈。\n' +
      '- **不要在没有诊断证据时就下结论**。读了诊断发现是空的，就说"复现了但控制台没有报错"，\n' +
      '  然后换别的方向（网络请求？样式？元素根本没绑上事件？），不要编原因。\n' +
      '- **只读诊断不需要审批**，直接读；但要**先复现**才有内容可读。\n' +
      '- **区分"没反应"的几种可能**：抛异常（看 console）/ 请求失败（`kind:"network"`）/ \n' +
      '  元素被遮挡或禁用（看 fast snapshot 与 `get_attribute`）/ 事件压根没绑上（点击后无任何变化）。\n\n' +
      '## 不要做的事\n' +
      '- 不要为了"让用户看到有变化"而去改页面或注入代码 —— 排查阶段的首要目标是**找到原因**，不是让它看起来好了。\n' +
      '- 不要声称"已修复"，除非真的改了代码/样式并**验证过**。',
    x: {
      intents: ['browser_task'],
      keywords: ['没反应|不管用|没生效|没出来|为什么|排查|debug', '报错|错误|控制台|异常'],
      tools: ['get_page_snapshot', 'click_element', 'read_diagnostics', 'inspect_element', 'get_attribute', 'complete_task'],
      playbook: 'debug-console-error',
    },
  },
  {
    name: 'dismiss-overlay',
    displayName: '被弹窗/遮罩挡住（先处理干扰，再干活）',
    description:
      '页面被弹窗、Cookie 同意框、引导蒙层或遮罩挡住，导致点击/输入不生效时使用。当用户说「被弹窗挡住了 / 关掉这个广告 / 点不了」时使用。',
    version: '1.0.0',
    category: 'browser',
    tags: ['弹窗', '遮罩', '遮挡', '干扰'],
    skill_type: 'prompt-template',
    // 与真模型实测相关：本技能第一次写出来时**没有编号步骤清单**，
    // 真模型（deepseek 系列）因此漏掉关键一步。教训：这类"有前提步骤"的任务
    // 必须给编号清单，模型才会逐步做完。
    content:
      '# 被弹窗 / 遮罩挡住\n\n' +
      '## 步骤（**顺序即能力**，不要先去点被挡住的东西）\n' +
      '1. `get_page_snapshot` 看清页面上有什么 —— 找一个**盖住正文的全屏层**\n' +
      '   （通常 `position: fixed` + 高 `z-index`，里面往往有「接受 / 关闭 / ×」按钮）；\n' +
      '2. **先把干扰关掉**：`click_element` 点那个关闭/接受按钮（用 `role`+`name` 定位最稳）；\n' +
      '3. 确认它真的消失了（再取一次快照，或 `inspect_element({ op: "inspect" })` 看那个层还在不在）；\n' +
      '4. **然后**才做正事：输入、点击、读取结果；\n' +
      '5. 汇报时说明"先关掉了什么"，让用户知道你的动作顺序。\n\n' +
      '## 为什么不能跳过第 2 步\n' +
      '遮罩是 `position: fixed; inset: 0` 的全屏层时，**输入框和按钮都在它下面**。\n' +
      '此时点击/输入会被判定为**被遮挡**并失败 —— 所以"先关掉它"不是多此一举，是前提。\n' +
      '如果你先试了被挡住的目标，看到"被遮挡"这类反馈，**不要反复重试同一个动作**，\n' +
      '也不要改用 `run_javascript` 硬点（那会引发审批且绕过遮挡判断）——\n' +
      '先回头把那个遮罩关掉。\n\n' +
      '## 几种常见干扰的识别\n' +
      '- **Cookie / 隐私同意**：底部或居中的横条/对话框，按钮常叫「接受」「同意」「我知道了」；\n' +
      '- **活动弹窗**：居中卡片，右上角通常有个 `×`（可能没有可访问名，用 `selector` 或 `text` 定位）；\n' +
      '- **引导蒙层**：半透明层 + 高亮某个区域，按钮常是「下一步」「跳过」；\n' +
      '- **登录墙**：这类**不要**尝试绕过 —— 如实告诉用户需要登录。\n\n' +
      '## 判据\n' +
      '完成的标准是**正事做成了**，而不是"我点了个关闭按钮"。\n' +
      '关掉遮罩后一定要继续做完用户的原始请求，别停在"已关闭弹窗"。',
    x: {
      intents: ['browser_task'],
      keywords: ['弹窗|遮挡|遮罩|挡住|蒙层|广告框', '关闭|关掉|接受|Cookie|同意'],
      tools: ['get_page_snapshot', 'click_element', 'type_text', 'inspect_element', 'complete_task'],
      playbook: 'dismiss-overlay',
    },
  },
  {
    name: 'recover-from-rejection',
    displayName: '被拒后自适应（读懂原因、补齐、再试）',
    description:
      '提交/操作被业务规则拒绝，需要读懂原因并修正后重试时使用。当用户的任务第一次没成功、页面回了「必填 / 需要 XX / 格式不对 / 请先选择」这类提示时使用。',
    version: '1.0.0',
    category: 'browser',
    tags: ['失败恢复', '自适应', '校验', '重试'],
    skill_type: 'prompt-template',
    content:
      '# 被拒之后怎么办（自适应，而不是重试）\n\n' +
      '## 步骤\n' +
      '1. 按用户给的信息**先做完**能做的部分（选商品 / 填数量 / 填地址）；\n' +
      '2. 执行提交；\n' +
      '3. **读页面反馈**：`inspect_element({ op: "text" })` 读提示区域（或看工具返回的"动作后状态"），\n' +
      '   弄清**到底差什么**；\n' +
      '4. 有时被拒会**让新的字段出现**（渐进式校验）：先重新 `get_page_snapshot`，\n' +
      '   看看是不是多了一个之前不存在的输入项；\n' +
      '5. 按提示**补上**（提示里若给了可用值，就用那个值）；\n' +
      '6. 重新提交，并在完成后说明"第一次为什么被拒、你补了什么"。\n\n' +
      '## 三条纪律\n' +
      '- **绝不盲目重试。** 同一个动作原地重试只会撞同一堵墙，还可能触发风控。\n' +
      '  重试前必须能说出"这次和上次有什么不同"。\n' +
      '- **先读原因再动手。** 页面的提示是唯一可信的信息来源；不要凭猜测去改用户给的值\n' +
      '  （比如用户说数量 1，就不要自作主张改成 2）。\n' +
      '- **有些拒绝不该由你解决。** 如果提示是「需要登录」「需要实名」「库存不足」，\n' +
      '  那是用户才能处理的事 —— 如实说明，不要尝试绕过。\n\n' +
      '## 为什么要特别留意"新出现的字段"\n' +
      '真实站点常用**渐进式校验**：你不提交，它就不告诉你还缺什么；\n' +
      '一提交，才多出一个"邀请码 / 验证码 / 配送时段"之类的必填项。\n' +
      '这类字段在第一次提交前**根本不在页面上**，所以"再取一次快照"不是浪费，是必要动作。',
    x: {
      intents: ['browser_task'],
      keywords: ['被拒|拒绝|失败|没成功|重试|还是不行', '必填|需要|校验|提示|格式'],
      tools: ['get_page_snapshot', 'select_option', 'type_text', 'click_element', 'inspect_element', 'complete_task'],
      playbook: 'recover-from-rejection',
    },
  },
  {
    name: 'extract-merged-table',
    displayName: '表格提取（含合并单元格，按列对齐）',
    description:
      '把网页上的表格提取成规整数据。当用户要求「把表格整理出来 / 提取这张表 / 转成表格」时使用，尤其是表格里有合并单元格（跨行跨列）时。',
    version: '1.0.0',
    category: 'browser',
    tags: ['表格', '提取', '合并单元格', '数据'],
    skill_type: 'prompt-template',
    content:
      '# 表格提取（合并单元格要按列对齐）\n\n' +
      '## 步骤\n' +
      '1. `get_page_snapshot` 看清页面上有几张表、要的是哪一张；\n' +
      '2. **用 `inspect_element({ op: "table", selector })` 取数据** —— 不要自己逐行读单元格；\n' +
      '3. 核对返回的**列数**与表头：合并单元格展开后列数应与表头一致；\n' +
      '4. 回答时给出规整的表格（或按用户要的字段列出），并说明共几行几列。\n\n' +
      '## 为什么绝对不能"逐行读单元格"\n' +
      '有合并单元格时，`rowspan` 会让**后续行在 DOM 里少一个 td**。\n' +
      '于是"第 N 个 td 就是第 N 列"这个假设不成立 —— 典型症状是**整张表左移一格**：\n' +
      '「区域」列的值消失了，而「商品」列的值跑到了「区域」列上，之后每一列都错位。\n' +
      '`op: "table"` 会用占位算法把表格还原成矩形网格，这是它存在的**唯一理由**。\n' +
      '同理**不要用 `run_javascript` 逐行取 `td` 文本** —— 遇到合并单元格必然列错位。\n\n' +
      '## 两个参数\n' +
      '- `fillMerged`（默认 `true`）：合并单元格的**延续格**是否重复填入同一文本。\n' +
      '  默认 true 更适合按列读取（不会遇到空洞）；设 `false` 可保留"这里是合并延续"的忠实形态。\n' +
      '- `maxRows` / `maxCols`：行/列上限，表格很大时用来避免爆上下文。\n\n' +
      '## 判据\n' +
      '提取成功 != "工具返回了 ok"，而是：**表头列数与数据列数一致**，\n' +
      '且**每个合并单元格的值出现在它覆盖的每一行上**（例如跨两行的「华东」在两行里都有）。\n' +
      '如果发现某一行比表头少一格，说明对齐失败 —— 应如实报告，而不是把那行猜着补齐。',
    x: {
      intents: ['browser_task'],
      keywords: ['表格|表|数据表|列表数据', '提取|整理|导出|转成'],
      tools: ['get_page_snapshot', 'inspect_element', 'complete_task'],
      playbook: 'extract-merged-table',
    },
  },
  {
    name: 'operate-in-cross-origin-iframe',
    displayName: '跨域 iframe 内操作（先读合并快照，再按复合 ref 路由）',
    description:
      '要操作的内容在页面里的 iframe / 内嵌框架中（尤其是不同源的），顶层页面读不到它时使用。当用户说「在下面的框里操作 / 内嵌的检索里搜 / 那块区域点不了」时使用。',
    version: '1.0.0',
    category: 'browser',
    tags: ['iframe', '跨域', '内嵌框架', '复合 ref'],
    skill_type: 'prompt-template',
    content:
      '# 跨域 iframe 内的操作\n\n' +
      '## 两条都可行的读法（选一条走，别混着试）\n' +
      '\n' +
      '**路径 A：一次读全部框架**\n' +
      '`get_page_snapshot({ includeFrames: true })` —— 合并快照里会出现框架内元素，\n' +
      '它们的 ref 带 `f<frameId>:` 前缀。\n\n' +
      '**路径 B：先枚举再逐框架读**（真模型实测更常用）\n' +
      '`list_frames` 拿到各框架的 frameId 与 URL，再 `get_page_snapshot({ frameId: N })` 逐个看。\n' +
      '想知道"页面里有几个框架、哪个是跨域的"时，这条更直接。\n\n' +
      '## 步骤\n' +
      '1. 用上面任一条读法找到目标框架内的元素；\n' +
      '2. 用**带 `f<frameId>:` 前缀的 ref**（如 `f5:rf-4`）照常调用\n' +
      '   `type_text` / `select_option` / `click_element` —— 前缀就是它所在的框架，\n' +
      '   **不需要自己算 frameId**；\n' +
      '3. 读回框架内的结果时用**显式 frameId**：\n' +
      '   `inspect_element({ op: "text", frameId: 5, selector: "#fres" })`；\n' +
      '4. 汇报时说明"操作发生在一个内嵌框架里，是跨域的"。\n\n' +
      '## 三条纪律\n' +
      '- **别在顶层用 selector 硬找框架里的元素**。不同源时顶层 DOM 里**根本不存在**那些节点，\n' +
      '  只会得到"未找到元素"，而那不是"元素不存在"，是**找错了框架**。\n' +
      '- **别用 `run_javascript` 去访问 `iframe.contentDocument`**。跨域时它必然是 `null`\n' +
      '  （浏览器同源策略），而且会白花一次审批。\n' +
      '- **框架内元素也可能需要等**。若是异步渲染，先用 `wait_for_element`（同样支持 frameId），\n' +
      '  别立刻断言"框架里没有"。\n\n' +
      '## 怎么判断哪个框架是跨域的\n' +
      '`list_frames` 会给出各框架的 URL；**源（协议+域名+端口）与顶层不同就是跨域**。\n' +
      '同源框架虽然可以直接从顶层读到，但统一走复合 ref 更省事、也更不容易出错。',
    x: {
      intents: ['browser_task'],
      keywords: ['iframe|内嵌|跨域|框架里|下面的框', '框架|嵌入|区域'],
      tools: ['get_page_snapshot', 'list_frames', 'type_text', 'select_option', 'click_element', 'inspect_element', 'wait_for_element', 'complete_task'],
      playbook: 'operate-in-cross-origin-iframe',
    },
  },
  {
    name: 'new-tab-takeover',
    displayName: '新标签页接管（点击后换页继续干活）',
    description:
      '点击后内容在新标签页里打开时使用。当用户说「点开看看 / 打开详情 / 会在新标签页打开」时使用，尤其是点击后当前页似乎"没有那个元素"的情况。',
    version: '1.0.0',
    category: 'browser',
    tags: ['新标签页', '接管', '换页', '连续性'],
    skill_type: 'prompt-template',
    content:
      '# 点击后开了新标签页\n\n' +
      '## 步骤\n' +
      '1. `get_page_snapshot` 看清当前页，找到那个会打开新页的链接/按钮；\n' +
      '2. 照常 `click_element` —— **不需要**事先做什么特殊准备；\n' +
      '3. **读点击结果**：若里面写着「检测到新标签页并已自动绑定」，说明\n' +
      '   **当前操作目标已经换成新页了**，后面的读取/操作都会落在新页上；\n' +
      '4. 继续在新页上干活（读取内容、继续点击…），**不要**回头去原页找刚才要看的东西。\n' +
      '   读回内容最简单的做法就是 `read_current_page` 或 `get_page_snapshot` ——\n' +
      '   它们读的是**当前已绑定的标签页**，绑定发生在点击那一刻，所以你不用做任何额外处理；\n' +
      '5. 汇报时说明"内容在新标签页里，已切过去读了"。\n\n' +
      '## 最容易犯的错：回原页找\n' +
      '点击之后如果拿到「未找到元素」，**先怀疑"页面已经换了"**，而不是"这个元素不存在"。\n' +
      '典型场景：点"查看详情"→ 详情在新页 → 你仍在原页找详情正文 → 必然找不到，\n' +
      '然后可能得出"详情页打不开"的错误结论。\n' +
      '判断依据就是点击结果里那句「已自动绑定」以及它附带的**新页快照摘要**。\n\n' +
      '## 三个注意点\n' +
      '- **不需要手动切页**：检测到新标签页时会自动绑定。只有在**没有**自动绑定的提示、\n' +
      '  而你确认确实开了新页时，才考虑用 `switch_tab` 之类的显式手段。\n' +
      '- **新页可能还没就绪**：若新页内容脚本尚未加载，结果里会提示；\n' +
      '  稍后再取一次快照，或用 `wait_for_element` 等目标元素出现。\n' +
      '- **别把"打开了新页"当成"任务完成"**：用户的请求通常是"把详情告诉我"，\n' +
      '  所以必须在新页上把内容读回来，而不是停在"已点击"。',
    x: {
      intents: ['browser_task'],
      keywords: ['新标签页|新窗口|打开详情|查看详情|链接打开', '接管|切换|换页'],
      tools: ['get_page_snapshot', 'read_current_page', 'click_element', 'inspect_element', 'wait_for_element', 'complete_task'],
      playbook: 'new-tab-takeover',
    },
  },
  {
    name: 'paginate-async',
    displayName: '分页 + 异步加载（跨页找到目标，并等它真的渲染出来）',
    description:
      '目标不在当前页、需要翻页或滚动加载才能找到时使用；也用于"翻页/加载后内容过一会儿才出现"的情况。当用户说「翻页找 / 第几页 / 加载更多 / 找遍整个列表」时使用。',
    version: '1.0.0',
    category: 'browser',
    tags: ['分页', '异步', '加载更多', '跨页'],
    skill_type: 'prompt-template',
    content:
      '# 分页 / 异步加载：跨页找目标\n\n' +
      '## 两个难点，必须分别对付\n' +
      '1. **跨页**：目标不在当前页 —— 不翻页就永远找不到。\n' +
      '   而"这一页没有"与"整站没有"**是两件事**，前者不能当作结论。\n' +
      '2. **异步**：点「下一页」或「加载更多」之后，列表常常**先清空、过一会儿才填**。\n' +
      '   于是"点完立刻读"会拿到**空列表** —— 而空列表极容易被误读成"这页没内容"。\n\n' +
      '## 步骤\n' +
      '1. `get_page_snapshot` / `inspect_element({ op: "text" })` 读当前页，确认目标在不在这里；\n' +
      '2. 不在就翻页：`click_element` 点「下一页 / 加载更多」（或用分页控件的页码）；\n' +
      '3. **翻页后不要立刻读** —— 先 `wait_for_element`：\n' +
      '   - 知道目标文本用 `{ state: "text_contains", text: "目标文本" }`（**最稳，优先用它**）；\n' +
      '   - 只知道条数用 `{ state: "count", count: 5 }`；\n' +
      '   - ⚠ **选择器要用你实际在快照里看到的那个**，不要猜标签名。\n' +
      '     真模型实测踩过：列表项是 `div.item[role=listitem]`，它却写了 `selector: "li"` ——\n' +
      '     条件永远不成立，白白等满超时才继续（结果对，但慢）。\n' +
      '     不确定选择器时，直接用 `text_contains` 更省事。\n' +
      '   - 至少等到「上一页没有、这一页应该有」的某个标记出现。\n' +
      '4. 读回这一页，判断目标是否出现；出现即停，**不要多翻**；\n' +
      '5. 翻到最后一页仍没有，才能说"整个列表里没有"，并说明**你翻了几页**。\n\n' +
      '## 三条纪律\n' +
      '- **不要把空列表当结论。** 读到 0 条时先分清是"加载中"还是"真的空"——\n' +
      '  前者要等，后者才是信息。\n' +
      '- **不要多翻。** 找到就停；多翻会改变页面状态，可能让后续判断失准。\n' +
      '- **结论里带上翻页范围**（"翻完 3 页共 15 条，没有匹配"），\n' +
      '  这样用户能判断是"确实没有"还是"你没翻到底"。',
    x: {
      intents: ['browser_task'],
      keywords: ['翻页|分页|下一页|加载更多|翻到|第几页', '列表|找|找到|遍历'],
      tools: ['get_page_snapshot', 'inspect_element', 'click_element', 'wait_for_element', 'complete_task'],
      playbook: 'paginate-async',
    },
  },
  {
    name: 'pierce-shadow-dom',
    displayName: '组件内操作（穿透 Shadow DOM）',
    description:
      '目标元素在自定义组件 / Web Component 的 shadow DOM 里，用普通选择器找不到时使用。当用户说「在组件里 / 那个小组件里 / 选择器找不到但页面上明明有」时使用。',
    version: '1.0.0',
    category: 'browser',
    tags: ['Shadow DOM', '组件', 'Web Component', '穿透'],
    skill_type: 'prompt-template',
    content:
      '# 目标在 Shadow DOM 里（自定义组件内）\n\n' +
      '## 先认清症状\n' +
      '`document.querySelector(sel)` 找不到某个"页面上明明看得见"的元素时，\n' +
      '**第一嫌疑是它在 shadow root 里** —— 而不是"页面没有这个元素"。\n' +
      '用原生查询看顶层 DOM 树，shadow 内部的东西**一个都看不到**（返回 null），\n' +
      '于是很容易得出"没有这个元素"的错误结论。\n\n' +
      '## 步骤\n' +
      '1. `get_page_snapshot` —— RecallFlow 的快照**会穿透开放 shadow root**，\n' +
      '   组件内的可交互元素会出现在元素列表里（还可能标出 shadow 深度）；\n' +
      '2. 优先用 `role` + `name` 定位（组件内部的按钮/输入框通常有可访问名），\n' +
      '   或直接用快照给出的 `ref`；\n' +
      '3. 用 `selector` 也可以：**RecallFlow 的选择器查询本身会递归穿透开放 shadow root**，\n' +
      '   包括**多层嵌套**（shadow 里套 shadow）。所以 `#q` 这种组件内的 id 直接写就行；\n' +
      '4. 照常 `type_text` / `click_element` / `inspect_element({ op: "text" })`；\n' +
      '5. 若确实读不到，再考虑 closed shadow root（见下）。\n\n' +
      '## 三条纪律\n' +
      '- **别用 `run_javascript` 自己写 `shadowRoot.querySelector` 递归**。\n' +
      '  工具内置的查询已经穿透了，自己写一遍既白花一次审批，又容易漏掉嵌套层。\n' +
      '- **别因为 `querySelector` 返回 null 就断言"页面上没有"**。那个 null 只说明\n' +
      '  "顶层 DOM 里没有"，不说明"页面上没有"。\n' +
      '- **closed shadow root 读不到**：`attachShadow({mode:"closed"})` 的组件，\n' +
      '  外部拿不到 `shadowRoot`，工具也穿透不了。这时应**如实说明**，\n' +
      '  并建议改用可访问性树（`get_ax_snapshot`）或坐标点击，而不是硬试。',
    x: {
      intents: ['browser_task'],
      keywords: ['组件|shadow|影子|自定义元素|web component', '找不到|读不到|选择器'],
      tools: ['get_page_snapshot', 'type_text', 'click_element', 'inspect_element', 'get_ax_snapshot', 'complete_task'],
      playbook: 'pierce-shadow-dom',
    },
  },
  {
    name: 'cdp-drag-slider',
    displayName: '拖拽（滑块 / 自定义排序等鼠标事件型控件）',
    description:
      '需要一个元素拖到另一个位置时使用：滑块、音量条、自定义排序、画布上的拖动等。当用户说「拖到 / 拉到 / 调到某个刻度」时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['拖拽', '滑块', 'CDP', '可信输入'],
    skill_type: 'prompt-template',
    content:
      '# 拖拽（滑块 / 自定义排序）\n\n' +
      '## 步骤\n' +
      '1. `get_page_snapshot` 找到**起点**与**终点**两个元素；\n' +
      '2. **终点必须选"表示目标位置"的那个元素**（刻度、目标卡片、目标单元格），\n' +
      '   **不要选容器** —— 拖到容器上落点是它的**中心**，通常不是你要的位置。\n' +
      '   真模型实测踩过：目标是"拖到 80 刻度"，它却拖到了 `#track`（轨道中心 = 50%），\n' +
      '   于是没到位，只能反复改路线；\n' +
      '3. `drag_element({ fromSelector, toSelector })` —— 起点用 `from*`、终点用 `to*`；\n' +
      '4. **读回结果值**再汇报：拖拽工具只能回报"已从 (x,y) 拖拽到 (x,y)"，\n' +
      '   那说明的是**派发成功**，不等于"值真的变了"。用 `inspect_element({ op: "values" })`\n' +
      '   或读那个显示结果的元素来确认。\n\n' +
      '## 三个必须知道的限制\n' +
      '- **两端只支持 `ref` / `selector` / `text`，没有 role+name。**\n' +
      '  这与其他工具不同 —— 用 `fromRole`/`toRole` 传进去不会被识别，会得到"未找到元素"。\n' +
      '  所以先取快照拿 `ref`，或用 CSS 选择器。\n' +
      '- **需要 CDP 输入层**：拖拽经 `chrome.debugger` 派发**真实鼠标事件**，\n' +
      '  未开启 CDP 时会直接报"拖拽需要 CDP 输入层（请在设置中开启）"。\n' +
      '- **它派发的是鼠标事件，不是 HTML5 拖放事件。**\n' +
      '  用 `draggable="true"` + `dragstart/drop` 实现的控件**不会响应**，\n' +
      '  表现是"拖了但什么都没发生"。这不是工具坏了 —— 这类控件需要的是拖放事件，\n' +
      '  目前没有对应工具，应**如实说明**，并建议改用键盘（方向键）或直接在输入框里设值。\n\n' +
      '## 判据\n' +
      '完成的标准是**目标状态真的变了**（值/顺序变了且读得到），而不是"我调用过拖拽"。',
    x: {
      intents: ['browser_task'],
      keywords: ['拖拽|拖到|拖动|拉到|滑块|排序', '刻度|位置|移动'],
      tools: ['get_page_snapshot', 'drag_element', 'inspect_element', 'click_element', 'complete_task'],
      playbook: 'cdp-drag-slider',
    },
  },
  {
    name: 'canvas-coordinate-click',
    displayName: 'canvas / 画布上的按钮（按坐标点击）',
    description:
      '要点的东西画在 canvas 上、DOM 里没有对应元素时使用。当用户说「画布上那个按钮 / 图上的按钮 / 点不到」时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['canvas', '可访问性树', '坐标点击', 'CDP'],
    skill_type: 'prompt-template',
    content:
      '# canvas 上的按钮：只能按坐标点\n\n' +
      '## 步骤\n' +
      '1. `get_page_snapshot` 先看有没有可用的 DOM 元素（**很多"画布"其实只是套了 canvas 的普通 DOM**，\n' +
      '   能用 role+name 就别按坐标）；\n' +
      '2. 确认确实没有可点中的 DOM 元素后，用 `get_ax_snapshot` 读**可访问性树**：\n' +
      '   它给出交互节点的 role、名称与**视口坐标**；\n' +
      '3. 用 `click_at({ x, y })` 按坐标派发**真实鼠标点击**；\n' +
      '4. 读回页面状态确认真的点中了（而不是"派发了就算完成"）。\n\n' +
      '## 为什么 DOM 路线在这类页面上是死路\n' +
      '页面常常为可访问性放一层**同名同位的覆盖元素**，但那层是 `pointer-events:none` ——\n' +
      '命中测试会**穿过它**落到 canvas 上。于是：\n' +
      '- 遮挡判定会认为它"被 canvas 盖住"；\n' +
      '- `click_element` 退化成**程序化 click**，而程序化 click 派发在覆盖元素自身、\n' +
      '  **不会冒泡到 canvas**（两者是兄弟节点）；\n' +
      '- 结果是**什么都没发生**，工具还只会回报"已派发，但页面快照暂未观察到变化" ——\n' +
      '  这句话很容易被当成"点了但页面没反应"，而不是"这条路根本走不通"。\n' +
      '**判据是页面状态真的变了**（比如出现了"已点击：X"），不是"我调用过点击"。\n\n' +
      '## 三条纪律\n' +
      '- **先试 DOM，再退坐标**：坐标点击更脆（分辨率、缩放、滚动都会影响），能定位到元素就别用坐标。\n' +
      '- **坐标必须来自 `get_ax_snapshot`**（或快照里给出的位置），不要凭感觉估。\n' +
      '- **需要 CDP**：`click_at` 与 `get_ax_snapshot` 都走 `chrome.debugger`，\n' +
      '  未开启时会直接报"需要 CDP"，那不是页面问题。',
    x: {
      intents: ['browser_task'],
      keywords: ['画布|canvas|图上|图表里', '点不到|按坐标|可访问性'],
      tools: ['get_page_snapshot', 'get_ax_snapshot', 'click_at', 'click_element', 'inspect_element', 'complete_task'],
      playbook: 'canvas-coordinate-click',
    },
  },
  {
    name: 'macro-save-replay',
    displayName: '宏：把已验证的多步操作存下来，之后零 token 回放',
    description:
      '同一套多步操作要重复做、或用户要求「存成宏 / 下次直接用 / 一键重复」时使用。把一次成功的流程固化为宏，之后回放不再消耗推理。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['宏', '回放', '零 token', '复用'],
    skill_type: 'prompt-template',
    content:
      '# 宏：把做过的流程固化下来\n\n' +
      '## 步骤\n' +
      '1. **先把流程完整做一遍**（点哪里、填什么、选什么）—— 宏记录的是**你这次实际做过的动作**，\n' +
      '   没做过就存不出东西；\n' +
      '2. `macro({ op: "save", name: "自己起个好记的名" })` 保存；\n' +
      '   返回值会写明存了几步，**照这个步数核对**是否把该记的记全了；\n' +
      '3. 需要时 `macro({ op: "run", name: "..." })` 回放；\n' +
      '4. 记不清名字就 `macro({ op: "list" })` —— **回放时 name 必须照抄 list 给出的值**，\n' +
      '   不要自己拼或写描述；\n' +
      '5. 回放后**确认页面状态真的变了**（计数、列表、状态文本），不要只看"回放成功"。\n\n' +
      '## 四个必须知道的边界\n' +
      '- **宏按站点存**：换域名就找不到同一个宏。\n' +
      '- **只记录白名单内的工具**（点击 / 输入 / 按键 / 选择 / 勾选 / 滚动 / 等待 / 开页）。\n' +
      '  `run_javascript`、截图、读取类工具**都不会进宏** —— 所以"读一下再据此判断"这种流程\n' +
      '  存不进宏，宏只适合**确定的重复动作序列**。\n' +
      '- **回放不接受参数**：宏每一步都用**当时记录的参数**重放。\n' +
      '  要换关键词/数量之类的输入，不能靠回放同一个宏 ——\n' +
      '  应重新做一遍再保存一个新宏（不同名字），或直接用普通工具做那一步。\n' +
      '- **回放的是"动作"，不是"状态"** —— 所以输入类步骤要**幂等**：\n' +
      '  `type_text` 不带 `clearFirst` 时默认是**追加**，回放会在已有内容后面再接一段。\n' +
      '  实测：一次「填 咖啡」+ 回放一次，字段变成「咖啡咖啡」。\n' +
      '  **要存进宏的输入步骤请带 `clearFirst: true`**（记录时才会把清空意图一起存下来），\n' +
      '  这样回放两次的结果才一致。\n' +
      '- **保存需要审批**（它是写操作），回放也要过执行期白名单 ——\n' +
      '  若宏里含不允许回放的工具，回放会**在那一格里停下并告诉你原因**。\n\n' +
      '## 什么时候值得存宏\n' +
      '同一套动作**要重复做**、且**参数不变**时才值得。\n' +
      '一次性的操作存成宏只是多一步；参数每次都不同的流程，宏也帮不上忙。',
    x: {
      intents: ['browser_task'],
      keywords: ['存成宏|宏|回放|一键重复|下次直接用', '重复|固化|复用'],
      tools: ['macro', 'get_page_snapshot', 'type_text', 'select_option', 'click_element', 'inspect_element', 'complete_task'],
      playbook: 'macro-save-replay',
    },
  },
  {
    name: 'upload-file',
    displayName: '文件上传（工具只说"未观测"，必须读回）',
    description:
      '要把本地文件设置到页面的 file input 上时使用。当用户说「上传这个文件 / 把这个文件传上去 / 上传附件」时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['上传', '文件', 'file input', 'CDP'],
    skill_type: 'prompt-template',
    content:
      '# 文件上传\n\n' +
      '## 步骤\n' +
      '1. `get_page_snapshot` 找到 `<input type="file">`（通常有「选择文件 / 上传」之类的可访问名）；\n' +
      '2. `upload_file({ selector, files: ["/绝对/路径"] })` —— **files 必须是本地绝对路径**；\n' +
      '3. **读回确认**（这一步不能省，理由见下）：读页面上显示文件名的元素，\n' +
      '   或确认状态变成了「已选择 / 已提交」；\n' +
      '4. 若页面还需要点「提交 / 上传」按钮，再点一次并再次读回。\n\n' +
      '## 为什么"返回 ok"不等于"传上去了"\n' +
      '`upload_file` **有意如实报告**：它返回 `hadEffect:false`，验证说明是\n' +
      '「已向文件输入框设置文件（未做页面变化观测）」——\n' +
      '因为把文件塞进 file input 本身**不产生可观察的页面变化**（文件名可能只出现在 `input.value` 里）。\n' +
      '这是**诚实**而不是失败：它没有谎报"页面变了"。\n' +
      '所以判据必须落在**页面状态**上（文件名显示出来了、提交按钮真的生效了），\n' +
      '而不是上传工具返回了什么。\n\n' +
      '## 三个注意点\n' +
      '- **需要 CDP**（走 `chrome.debugger` 的 `DOM.setFileInputFiles`），未开启会直接报"需要 CDP"。\n' +
      '- **路径必须是本机存在的绝对路径**。用户没说清路径时应当**问清楚**，\n' +
      '  不要猜一个路径去试 —— 猜错只会得到"文件不存在"。\n' +
      '- **别用 `run_javascript` 去伪造 File 对象**：那样设进去的 `files` 在真实提交时是无效的\n' +
      '  （页面能读到、但没有真实文件内容），而且白花一次高危审批。',
    x: {
      intents: ['browser_task'],
      keywords: ['上传|上传文件|上传附件|传上去', '文件|附件|file'],
      tools: ['get_page_snapshot', 'upload_file', 'click_element', 'inspect_element', 'complete_task'],
      playbook: 'upload-file',
    },
  },
  {
    name: 'knowledge-save-retrieve',
    displayName: '知识库：存进去要能原样取回来（同一个网址会互相覆盖）',
    description:
      '要把信息记进知识库、或从知识库检索/核对已有条目时使用。当用户说「记到知识库 / 存起来 / 从知识库找一下 / 之前记过什么」时使用。',
    version: '1.0.0',
    category: 'knowledge',
    tags: ['知识库', '保存', '检索', '往返核对'],
    skill_type: 'prompt-template',
    content:
      '# 知识库读写\n\n' +
      '## 步骤\n' +
      '1. 先把要记的内容**看准**（读页面 / 读用户给的材料）；\n' +
      '2. `add_entry({ type, title, note, tags?, status?, url? })` —— `type` 与 `title` 必填；\n' +
      '3. **读回来核对**：`knowledge_read({ op: "get", id })` 看单条，\n' +
      '   或 `op:"search"`（要 query）/ `op:"list"`（可按 type 筛）；\n' +
      '4. 确认取回来的内容与要记的一致，再向用户汇报。\n\n' +
      '## ⚠ 最大的一个坑：**传了 url 就用 url 当 id**\n' +
      '`add_entry` 的 id 是 `url || 自动生成`。也就是说：\n' +
      '**同一个网址只能有一条** —— 对同一页再存一次会**覆盖**上一条（这是设计上的去重），\n' +
      '而且每次都返回"已保存"。所以：\n' +
      '- 想记同一页的**多条**要点：放进**一条**的 `note` 里，\n' +
      '  或者**都不传 url**（各自拿到一个生成 id）；\n' +
      '- **千万别**"分三条存、都带上同一个网址" —— 静默只剩最后一条。\n' +
      '- 已存的条目被覆盖后**无法恢复**，别用试错的方式反复存。\n\n' +
      '## 其它注意点\n' +
      '- `op:"get"` 要的是 **id（通常就是 url）**，不是标题；\n' +
      '  不确定 id 时先 `op:"list"` 看有哪些条目。\n' +
      '- `op:"search"` 是**相似度检索**（走 RAG），不是精确子串匹配：\n' +
      '  **检索不到不等于没存进去** —— 换个说法再检索，或直接用 `op:"list"` / `op:"get"` 确认。\n' +
      '- **写入需要审批**（`add_entry` 是写操作），删除更是不可逆（`remove_entry`）。\n' +
      '- "存进去了"的判据是**读回来能看到**，不是 `add_entry` 返回了成功。',
    x: {
      intents: ['browser_task'],
      keywords: ['知识库|记到|存起来|笔记|收藏到知识库', '检索|核对|之前记过'],
      tools: ['add_entry', 'knowledge_read', 'remove_entry', 'get_page_snapshot', 'inspect_element', 'complete_task'],
      playbook: 'knowledge-save-retrieve',
    },
  },
  {
    name: 'knowledge-search-fallback',
    displayName: '知识库检索查不到时（查不到 ≠ 没有）',
    description:
      '在知识库里检索却没命中、需要判断"到底有没有这条记录"时使用。当用户说「知识库里有没有… / 帮我找找之前记的…」而检索落空时使用。',
    version: '1.0.0',
    category: 'knowledge',
    tags: ['知识库', '检索', '召回', '回退'],
    skill_type: 'prompt-template',
    content:
      '# 检索落空 ≠ 知识库里没有\n\n' +
      '## 先认清检索是怎么工作的\n' +
      '知识库检索是**纯字符匹配**（按标题/标签/备注加权打分），**不懂同义词**：\n' +
      '- 笔记里写「首屏索引预热」，你查「预热」**能**命中；\n' +
      '- 但你查「卡顿」「页面打开很慢」——与「预热 / 超时」在**字符层面毫无交集**，\n' +
      '  **必然落空**，哪怕那条记录讲的就是这件事。\n\n' +
      '所以「未检索到相关知识库条目」这句话只说明**这次查询的词面没对上**，\n' +
      '**不说明知识库里没有**。绝不能据此回答用户"没有相关记录"。\n\n' +
      '## 落空之后怎么办（按顺序试）\n' +
      '1. **换词再查**：用笔记里**可能出现的原话**去查（技术名词、专有名词比口语形容更容易命中）；\n' +
      '2. `knowledge_read({ op: "list" })`：把本站已存条目**列出来**——\n' +
      '   标题/类型/标签足以让你判断"有没有相关的"；这一步最可靠，别跳过；\n' +
      '3. `knowledge_read({ op: "get", id })`：知道 id（**通常就是 url**）时直接读那一条；\n' +
      '   如果是你**本次刚存进去的**，id 就在 `add_entry` 的返回里，直接用，不用瞎猜。\n\n' +
      '## 汇报纪律\n' +
      '- 找到了就说清**依据**（读了哪一条、内容是什么）；\n' +
      '- 确实没有（列出来也没有相关的）才能说"没有"，并说明你**查过哪些词、列过列表**；\n' +
      '- 别把"检索落空"直接复述成"知识库里没有" —— 那是**两回事**，\n' +
      '  而且是把用户自己存的东西说没了。',
    x: {
      intents: ['browser_task'],
      keywords: ['知识库|有没有|找找|之前记的|查不到', '检索|落空|没有相关'],
      tools: ['knowledge_read', 'add_entry', 'get_page_snapshot', 'inspect_element', 'complete_task'],
      playbook: 'knowledge-search-fallback',
    },
  },
  {
    name: 'cross-tab-handoff',
    displayName: '跨标签页搬运（在 A 页读到的东西填进新开的 B 页）',
    description:
      '要把一个页面上的信息填到另一个标签页里时使用。当用户说「在新打开的页面里填上 / 把这页的验证码填到那边 / 两个标签页之间倒一下」时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['多标签页', '切换', '搬运', '验证码'],
    skill_type: 'prompt-template',
    content:
      '# 跨标签页搬运\n\n' +
      '## 核心纪律：**先把要搬的东西读到手，再切页**\n' +
      '切过去之后，来源页的正文就不在你眼前了（后续读取都落在新页上）。\n' +
      '所以顺序必须是：\n' +
      '1. 在来源页**读到并记住**要搬的值（验证码 / 订单号 / 链接 / 一段正文）；\n' +
      '2. 打开或切到目标页（点链接、`open_tab({ url })`、或 `switch_tab({ tabId })`）；\n' +
      '3. 在目标页填、点；\n' +
      '4. **读回目标页的回执**再汇报。\n\n' +
      '## ⚠ 最大的风险：「我现在在哪个标签页」是**隐式的**\n' +
      '落错标签页**不会报错** —— 工具照样返回成功。典型翻车：\n' +
      '- 来源页上也有个输入框（很常见：备注、搜索框），你没真正切页就往里打字，\n' +
      '  字进了来源页的那个框，**目标页什么都没收到**；\n' +
      '- 以为点了链接就切过去了，其实绑定没发生，后续操作还在旧页上。\n\n' +
      '**怎么确认自己在哪一页**：\n' +
      '- `list_tabs` 看当前窗口有哪些页；`switch_tab({ tabId })` 显式切（tabId 来自 `list_tabs` / `open_tab`）；\n' +
      '- 点链接后**结果里若写着「已自动绑定 tabId=N」**，说明后续操作已经落在新页上了；\n' +
      '- 心里没底就**读一次当前页**（`read_current_page` / `get_page_snapshot`），\n' +
      '  看看到底是哪一页的标题和内容 —— 这比猜便宜得多。\n\n' +
      '## 判据\n' +
      '完成的标准是**目标页真的收到了**（回执里能看到那个值），\n' +
      '**并且来源页没有被误改**。只看到"填好了"不算 —— 得看是哪一页的回执。',
    x: {
      intents: ['browser_task'],
      keywords: ['新打开的页面|跨标签页|两个标签页|填到那边|切标签页', '验证码|搬运|倒一下'],
      tools: ['get_page_snapshot', 'read_current_page', 'list_tabs', 'switch_tab', 'open_tab', 'type_text', 'click_element', 'inspect_element', 'complete_task'],
      playbook: 'cross-tab-handoff',
    },
  },
  {
    name: 'virtual-list-scroll',
    displayName: '虚拟列表 / 长列表（DOM 里没有 ≠ 页面上没有）',
    description:
      '页面列表很长、只渲染可见的几行（虚拟滚动 / 无限列表）时使用。当用户说「第 N 条 / 往下翻很多条 / 列表里有一条」而快照里看不到时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['虚拟列表', '滚动', '长列表', '回收渲染'],
    skill_type: 'prompt-template',
    content:
      '# 虚拟列表 / 长列表\n\n' +
      '## 先认清症状：**DOM 里只有可见的几行**\n' +
      '虚拟滚动会把滚出视口的行**回收掉**。所以：\n' +
      '- `get_page_snapshot` 里只有当前窗口那几行；\n' +
      '- 数 DOM 节点会得到"只有 5 条"这种**错误结论**（列表其实有 100 条）；\n' +
      '- **看不到目标行，不等于页面上没有这一条。** 绝不能据此回答用户"没有找到"。\n\n' +
      '## 步骤\n' +
      '1. `get_page_snapshot` 看**当前窗口**是哪几条（记下第一/最后一条的编号，用来估算跨度）；\n' +
      '2. **滚容器自己**：`scroll_page({ selector: "#list", y: 3480 })` ——\n' +
      '   给了 `ref/selector` 又有 `y` 时，滚的是**那个元素自身**（正数向下），\n' +
      '   这 正是内部可滚动容器（虚拟列表、带 overflow 的面板）要的滚法；\n' +
      '   - **容器一般就在快照里**：那个带 `role="list"` / 可访问名、里面正好装着可见几行的区域。\n' +
      '     **别用 `run_javascript` 去探测"哪个元素能滚"** —— 那是高危工具，会白花一次审批\n' +
      '     （实测：真模型先写了两次 JS 找容器，才用上 `scroll_page`）；\n' +
      '   - 不知道确切像素时，可以用**行高 × 目标序号**估算（如 40px × 87 ≈ 3480）；\n' +
      '   - 也可以只往前推一小段（`y` 给个几百像素）分几次逼近，**滚过头就用负的 `y` 回退**；\n' +
      '3. **滚完必须重新读**：`get_page_snapshot` 再取一次，确认目标行真的进了窗口 ——\n' +
      '   **滚动前的 ref 全部失效**（行是回收重建的，同一个 ref 可能指向另一条内容）；\n' +
      '4. 定位到目标后照常用 `click_element` / `inspect_element`。\n\n' +
      '## 三个容易踩的点\n' +
      '- **别只滚窗口**：不带目标时 `y` 是滚**窗口**的（`window.scrollBy`）。\n' +
      '  列表在一个内部容器里时，滚窗口**一点用都没有** —— 现象是"滚了但列表没动"，\n' +
      '  很容易被误读成"滚动工具坏了"。\n' +
      '- **别用旧的 ref**：滚动后行会被替换，之前拿到的 ref 不再对应同一条。\n' +
      '- **别用 `run_javascript` 去设 `scrollTop`**：现在一等公民就能滚容器，\n' +
      '  自己写既多花一次高危审批，又绕过了工具的滚动结果回报（滚动到哪了、有没有到边界）。',
    x: {
      intents: ['browser_task'],
      keywords: ['虚拟列表|长列表|无限列表|虚拟滚动|第 \\d+ 条|列表里', '滚|翻|找不到'],
      tools: ['get_page_snapshot', 'scroll_page', 'click_element', 'inspect_element', 'wait_for_element', 'complete_task'],
      playbook: 'virtual-list-scroll',
    },
  },
  {
    name: 'cascade-select',
    displayName: '级联下拉框（选了父项，子项异步填充）',
    description:
      '两个下拉框有依赖关系时使用：选了省份才出城市、选了分类才出子类。当用户说「选成 X / Y」「先选…再选…」时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['下拉框', '级联', '表单', '异步选项'],
    skill_type: 'prompt-template',
    content:
      '# 级联下拉框\n\n' +
      '## 症状与成因\n' +
      '选了父项（省份/分类）之后，子项（城市/子类）的选项是**异步填进来**的（真实站点是请求回来才有）。\n' +
      '于是"选完父项立刻选子项"会失败，工具会说「未找到匹配的 option」——\n' +
      '**这句话极易被读成"页面上没有这个城市"**，而真相只是"还没填进来"。\n' +
      '更隐蔽的是：填充期间子下拉框**往往还是 `disabled`**，所以**光等"选项出现"不够，要等到能用**。\n\n' +
      '## 步骤\n' +
      '1. `get_page_snapshot` 看清两个框的依赖关系（子框常带 "请先选…" 或 disabled）；\n' +
      '2. `select_option` 选父项；\n' +
      '3. **等子项就绪**（两种都行，按页面情况挑）：\n' +
      '   - **等子框自己变可用**：`wait_for_element({ ref, state: "enabled" })` ——\n' +
      '     最省事：子框一可用就说明选项也填好了（真模型 eval 实测走的就是这条）；\n' +
      '   - **等某个选项出现**：`wait_for_element({ selector: "#city option[value=\\"hz\\"]", state: "attached" })`\n' +
      '     - ⚠ 用 **`attached`**（挂在 DOM 上）而不是 `visible`：\n' +
      '       `<option>` 在**闭合的** `<select>` 里**没有布局盒子**，等 `visible` 会一直等不到；\n' +
      '4. `select_option` 选子项 —— 用 `label`（显示文本）或 `value` 都行，但**必须等它存在之后**；\n' +
      '5. 提交后**读回**页面状态，确认两个框的值都对了。\n\n' +
      '## 三条纪律\n' +
      '- **"未找到匹配的 option" ≠ 页面上没有这个选项**：先怀疑"还没填进来"，等一下再试。\n' +
      '- **别用 `run_javascript` 去念 options 或直接设 value**：`inspect_element` 读取类工具足够看清状态，\n' +
      '  而绕过 select 直接改值**不会触发页面的 change 逻辑**（子项就永远不会填）。\n' +
      '- **提交前确认两个框的值**（读回页面回执），不要只看"我调用过 select_option"。',
    x: {
      intents: ['browser_task'],
      keywords: ['级联|先选.*再选|选了.*才|下拉框|配送范围|省份|城市', '选成|选择'],
      tools: ['get_page_snapshot', 'select_option', 'wait_for_element', 'click_element', 'inspect_element', 'complete_task'],
      playbook: 'cascade-select',
    },
  },
  {
    name: 'read-select-options',
    displayName: '读下拉框选项（"选最便宜/最合适"之前先看有哪些）',
    description:
      '需要按属性挑选项时使用：最便宜、最快、最大、最新那一个。当用户说「选最…的那个」而没点名具体选项时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['下拉框', '选项', '比较', '只读'],
    skill_type: 'prompt-template',
    content:
      '# 按属性挑选项：先读，再选\n\n' +
      '## 为什么必须"先读"\n' +
      '**闭合的 `<select>` 里，`<option>` 的文案不在页面正文里** ——\n' +
      '选项没有布局盒子，正文抽取按"不可见"跳过。于是：\n' +
      '- `get_page_snapshot` 的正文里只有「配送方式」这种 label，**看不到 ¥8 / ¥22 / ¥5**；\n' +
      '- 价格、规格、时长往往**只写在选项文案里**；\n' +
      '- `get_attribute` 也帮不上：它读的是**属性**（disabled/href/data-*），读不了 `outerHTML`。\n\n' +
      '所以"选最便宜的那个"这类任务，**不把选项列出来就无从比较**，只能靠猜 —— 而猜错是静默的\n' +
      '（页面照样接受你选的任何一项）。\n\n' +
      '## 步骤\n' +
      '1. `inspect_element({ op: "options", selector: "#ship" })` —— 读出选项清单：\n' +
      '   每项给出 `value`、显示文字，并标出**当前选中**与**禁用**；\n' +
      '2. 按用户的条件比较（价格/时长/规格通常就在**显示文字**里）；\n' +
      '3. `select_option` 选中它 —— 用 `value` 或 `label` 都行（`label` 要**整段照抄**）；\n' +
      '4. 需要提交就再点按钮，并**读回页面回执**确认选中的确实是那一项。\n\n' +
      '## 三条纪律\n' +
      '- **别用 `run_javascript` 去念选项**：`inspect_element({op:"options"})` 就是干这个的，\n' +
      '  而且它是**只读**的（不打断用户、不受页面 CSP 限制）。实测在没有它之前，\n' +
      '  模型只能写一段 JS 去 `Array.from(s.options)` —— 白花一次高危审批。\n' +
      '- **别猜 value、别猜顺序**：选项顺序与 value 命名是页面说了算（`eco` 未必排第一，\n' +
      '  也可能叫 `saver`/`p3`）。先读再选。\n' +
      '- **注意"禁用"与"当前选中"两个标记**：禁用的选了也没用；已经是当前值的不用重复选。',
    x: {
      intents: ['browser_task'],
      keywords: ['最便宜|最便宜的那个|最划算|最快|最合适|最.*的那个', '选.*哪个|配送方式|选项'],
      tools: ['get_page_snapshot', 'inspect_element', 'select_option', 'click_element', 'complete_task'],
      playbook: 'read-select-options',
    },
  },
  {
    name: 'page-world-js',
    displayName: '读页面 JS 状态 / 严格 CSP 页面（沙箱被拒会自动改用页面主世界）',
    description:
      '要读页面自己的 JS 变量、或调用页面暴露的函数时使用。当用户说「JS 里的真实值 / 页面状态 / 控制台里那个变量」时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['页面主世界', 'CSP', 'JS 状态', 'run_javascript'],
    skill_type: 'prompt-template',
    content:
      '# 读页面的 JS 状态（而不是 DOM）\n\n' +
      '## 什么时候需要它\n' +
      'DOM 上显示的东西**未必是真实状态**（陈旧渲染、只渲染了一部分、格式化过）。\n' +
      '真实值常常只在页面的 JS 里：`window.__appState`、框架的 store、页面暴露的函数。\n' +
      '典型的用户提法：「页面显示的和实际对不上」「控制台里那个变量是多少」。\n\n' +
      '## 步骤\n' +
      '1. `get_page_snapshot` 先看 DOM —— 但要意识到**DOM 可能是陈旧值**；\n' +
      '2. `run_javascript({ code: "window.__appState && window.__appState.total" })` ——\n' +
      '   **这条工具需要开启 CDP**（见下）；没开 CDP 时会直接失败并提示你开启，不用反复重试；\n' +
      '3. 需要**页面自己的变量或函数**时，走页面主世界：\n' +
      '   - ⚠ 默认的"受限沙箱"其实**在任何页面上都跑不起来**：沙箱用 `new Function`，\n' +
      '     而 **MV3 扩展自身的 CSP 不允许 eval** —— 这与页面无关\n' +
      '     （实测在没有任何 CSP 的页面上同样被拒）。所以工具总是自动改用页面主世界；\n' +
      '   - 沙箱还跑在**隔离世界**里，**看不到页面的 JS 变量**（DOM 共享、页面全局不共享），\n' +
      '     所以读页面状态时**显式**给 `engine:"page"` 更直接。\n' +
      '4. 调页面函数同理：`run_javascript({ code: "window.reportTotals(); return window.__checked" })`；\n' +
      '5. **读回确认**：把结果与 DOM 上的显示对照，差异本身就是结论。\n\n' +
      '## 三条纪律\n' +
      '- **区分"DOM 里没有"与"JS 里没有"**：不要因为 DOM 上找不到就断言"页面上没有这个数据"。\n' +
      '- **需要 CDP**：页面主世界执行走 `chrome.debugger`。没开 CDP 时工具会**明确告诉你**\n' +
      '  （「改用页面主世界需要 CDP」）—— 这时应当**如实说明做不到、并建议开启 CDP**，\n' +
      '  不要绕一圈去猜、更不要假装读到了。\n' +
      '- **别拿 DOM 当真相**：用户问"真实值"时，DOM 上的数字恰恰可能是错的那个。',
    x: {
      intents: ['browser_task'],
      tools: ['get_page_snapshot', 'run_javascript', 'inspect_element', 'complete_task'],
      keywords: ['JS 状态|页面状态|控制台|window\\.|真实值|核对总价|变量里'],
      playbook: 'csp-page-world-js',
    },
  },
  {
    name: 'undo-last-action',
    displayName: '撤销上一步（只回退最后一次可撤销动作）',
    description:
      '需要撤回刚才的改动时使用。当用户说「撤销 / 撤回 / 改回来 / 刚才那步不算」时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['撤销', '回退', '误操作', '恢复'],
    skill_type: 'prompt-template',
    content:
      '# 撤销：能撤回什么、撤不回了什么\n\n' +
      '## ⚠ 先认清边界：**点击与导航不可撤销**\n' +
      '撤销栈只记录**可逆的改动**：输入文本 / 勾选 / 选择下拉 / 改样式 / 滚动。\n' +
      '**点击按钮、跳转页面都不进栈**。所以：\n' +
      '- 「点了保存 → 说撤销」**不会撤掉那次保存**（它撤的是保存**之前**最后一次可逆改动）；\n' +
      '- 点了提交/下单这类**有副作用**的动作，撤销**救不回来** —— 要如实说明。\n\n' +
      '## 步骤\n' +
      '1. 先想清楚"用户要撤的是哪一步"，以及它**是否可撤销**（上一条）；\n' +
      '2. `undo_last_action` —— 每次只弹**一格**（最后一次可逆动作）。要多撤几步就多调几次；\n' +
      '3. **读回页面确认撤掉了什么**：工具的返回只说「已撤销上一步操作」，\n' +
      '   **不告诉你撤的是哪一格**。所以必须回读相关字段（`inspect_element({op:"text"})`\n' +
      '   读状态文案、或快照里的值），把"撤后的实际状态"作为依据；\n' +
      '4. 汇报时说清**哪些被撤了、哪些没有**（尤其是"那次点击/提交撤不回来"）。\n\n' +
      '## 三条纪律\n' +
      '- **别把"调用了撤销"当成"撤成功了"**：读回才算数（这条和其它动作一样）。\n' +
      '- **撤销栈会累计**：连点两次撤销会连撤两步 —— 只想撤一步就别多点。\n' +
      '- **页面导航会清空撤销栈**（内容脚本重载），跳转过之后就别指望还能撤回去。',
    x: {
      intents: ['browser_task'],
      tools: ['undo_last_action', 'inspect_element', 'get_page_snapshot', 'type_text', 'check_box', 'select_option', 'click_element', 'complete_task'],
      keywords: ['撤销|撤回|改回来|刚才那步|回退'],
      playbook: 'undo-last-action',
    },
  },
  {
    name: 'form-validation',
    displayName: '提交没反应：HTML5 原生校验静默拦住（页面上什么都不说）',
    description:
      '表单点提交没反应、页面上又没有任何提示时使用。当用户说「提交不了 / 点了没反应 / 表单填完了但没提交上」时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['表单', '校验', '静默失败', 'HTML5'],
    skill_type: 'prompt-template',
    content:
      '# 提交没反应？先怀疑 HTML5 原生校验\n\n' +
      '## 症状与成因\n' +
      '点了提交**什么都没发生**：页面不变、没有错误文案、控制台也没报错。\n' +
      '最常见的原因是**浏览器自己的表单校验**把 `submit` 拦住了 ——\n' +
      '它只在**自己的原生气泡**里提示，那东西**读不到**（不在 DOM 里），\n' +
      '所以从页面状态看就是"按钮好像坏了"。\n\n' +
      '## 步骤\n' +
      '1. `inspect_element({ op: "inspect", selector: "<表单>" })` ——\n' +
      '   返回里会列出**没通过校验的字段、原因与浏览器给的原文提示**；\n' +
      '   - **查谁都可以**：表单本身、里面任意一个字段、甚至**你刚点的那个提交按钮** ——\n' +
      '     只要它在 `<form>` 里，就会把**该表单**未通过的字段一并报出来\n' +
      '     （校验的作用域本来就是表单；实测模型只看按钮、结果一无所获）；\n' +
      '2. 按原因改值（例：`patternMismatch` → 不符合字段要求的格式；\n' +
      '   `typeMismatch` → 比如邮箱少个 `@`；`valueMissing` → 必填没填）；\n' +
      '3. 再提交，并**读回确认**（页面上出现成功回执才算数）；\n' +
      '4. 若确实没有"未通过校验"的字段，再去看控制台/网络。\n\n' +
      '## 四个要点\n' +
      '- **原因名比提示语可靠**：返回里给的是 `patternMismatch` / `typeMismatch` 这类\n' +
      '  **与语言无关**的约束名；`validationMessage` 那段原文会随**浏览器语言**变（中/英/日），\n' +
      '  别拿它当依据去比对。\n' +
      '- **别用 `run_javascript` 自己扫 `:invalid`**：`inspect_element` 已经把这件事做完了，\n' +
      '  自己写一段除了多花一次高危审批没有别的收益。\n' +
      '- **别把"没反应"当成"按钮坏了"**：先按上面读一次，再决定要不要换定位或换工具。\n' +
      '- ⚠ **`minlength` 拦不住你写进去的值**：按规范"太短"需要用户输入产生的脏值标记，\n' +
      '  而工具是程序化写值的 —— 所以一个**只**用 `minlength` 的表单，脚本写短值也能提交过去。\n' +
      '  这既是"别指望它拦住你"，也是"用户手动填时它照样会拦"（别把它当成不存在）。',
    x: {
      intents: ['browser_task'],
      tools: ['inspect_element', 'type_text', 'check_box', 'select_option', 'click_element', 'get_page_snapshot', 'read_diagnostics', 'complete_task'],
      keywords: ['提交不了|提交没反应|点了没反应|报名表|表单|校验|填得不对|填好.*提交|改成能通过'],
      playbook: 'form-validation',
    },
  },
  {
    name: 'paywall-boundary',
    displayName: '付费墙 / 试看边界：「能打开」不等于「能看」',
    description:
      '用户想看某集剧集/视频但明确说没会员、没付费时使用。当用户说「我没会员」「要付费吗」「能免费看吗」时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['付费墙', '试看', '视频', '如实说明'],
    skill_type: 'prompt-template',
    content:
      '# 没会员想看某集：先分清「能打开」与「能看」\n\n' +
      '## 最容易错的一步\n' +
      '把页面**打开成功**当成任务完成 ✗ —— 播放页正常打开、标题正确、选集列表也在，\n' +
      '但里面可能只放**试看**。判据只有一个：**播放器实际能走到多长**。\n\n' +
      '## 怎么判断（三条线索，按可靠度）\n' +
      '1. **播放器时长**：试看通常被截得很短（如 3 分钟 vs 正片 19 分钟）。\n' +
      '   读法：`run_javascript({engine:"page"})` 取播放器状态（`duration` / `currentTime` / 试看标记）。\n' +
      '2. **播放之后才出现的提示**：很多站点在你**点播放之后**才显示"会员专享、试看中"。\n' +
      '   所以"页面上没看到限制"**不等于**没有限制 —— 先播一下再判断。\n' +
      '3. **选集列表里每一集的状态**：哪一集免费、哪一集会员，通常在列表项上（数据属性或角标）。\n' +
      '   这一条才回答得了用户真正的问题：**免费能看的最后一集是哪一集**。\n\n' +
      '## 步骤\n' +
      '1. 确认**最新一集是第几集**（别假设页面上那一集就是最新的）；\n' +
      '2. 打开它并**播放**，读播放器时长判断是不是试看；\n' +
      '3. 去选集列表读每集状态，算出**免费能完整观看的最后一集**；\n' +
      '4. 切到那一集，**播到接近片尾**再读一次时长/进度 —— 这才是"能看"的证据；\n' +
      '5. 汇报时说清三件事：最新一集是什么、它要不要会员、**免费能看的最新是哪一集**。\n\n' +
      '## 三条纪律\n' +
      '- **别用"打开了页面"当结论**：那只是打开。\n' +
      '- **别只播一下就说能看**：试看也会"播放成功"，要看到时长/进度对得上。\n' +
      '- **不帮忙绕过付费墙**：解析脚本、盗播站、第三方"免费全集"一律**不给**，\n' +
      '  如实说明并给出合规路径（开通、等活动限免、等免费解锁）—— 这是能力边界，不是保守。',
    x: {
      intents: ['browser_task'],
      tools: ['get_page_snapshot', 'click_element', 'run_javascript', 'inspect_element', 'scroll_page', 'complete_task'],
      keywords: ['没会员|没vip|要付费|能免费看|试看|会员专享|付费'],
      playbook: 'paywall-preview-limit',
    },
  },
  {
    name: 'dialog-handling',
    displayName: '浏览器对话框（confirm 阻塞 / prompt 要回填值）',
    description:
      '页面上弹出 alert / confirm / prompt 时使用。当页面「点不动了」「操作没反应」且快照提示存在未处理对话框时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['对话框', 'confirm', 'prompt', '阻塞'],
    skill_type: 'prompt-template',
    content:
      '# 浏览器级对话框：会**阻塞页面**，必须显式处理\n\n' +
      '## 症状\n' +
      '点了按钮之后页面**就不动了**：后续读取拿不到内容、点击不生效。\n' +
      '这通常不是"按钮坏了"，而是弹出了一个 **JS 对话框**\n' +
      '（`alert` / `confirm` / `prompt`）—— 它挂在浏览器层，页面 JS 停在那里等回答。\n\n' +
      '## 步骤\n' +
      '1. `get_page_snapshot` —— 有未处理对话框时它**不会返回正文**，而是明说：\n' +
      '   「⚠ 页面存在未处理的对话框：confirm：确定要删除吗？」（消息文本就在里面）；\n' +
      '2. `handle_dialog({ accept: true })` 表示确定，`{ accept: false }` 表示取消；\n' +
      '3. **是 `prompt` 时必须给 `promptText`**：\n' +
      '   - 不给就**原样接受默认值**（快照会把默认值一并报给你，注意看）；\n' +
      '   - 目标值与默认值不同却只点确定 ⇒ 页面记下的就是那个错的默认值；\n' +
      '4. 处理完再读一次页面确认副作用（状态文案 / 列表变化）。\n\n' +
      '## 三条纪律\n' +
      '- **别重复点触发按钮**：对话框没处理时再点只会叠加/无效果，看起来像"点了没反应"，\n' +
      '  实际是页面在等你回答。\n' +
      '- **别把对话框当成页面元素**：它不在 DOM 里，`click_element` 找不到它，\n' +
      '  截图里能看到但 DOM 里读不到 —— 只能靠 `handle_dialog`。\n' +
      '- **想清楚该确定还是取消**：`confirm` 的文案往往就是唯一线索\n' +
      '  （"确定要删除吗？" 意味着确定有破坏性）—— 拿不准时先如实说明再操作。',
    x: {
      intents: ['browser_task'],
      tools: ['get_page_snapshot', 'handle_dialog', 'click_element', 'inspect_element', 'complete_task'],
      keywords: ['对话框|弹窗确认|confirm|alert|prompt|点了没反应|点不动'],
      // ⚠ 暂无对应剧本：本轮的 /dialog 场景**没有收敛**（第二个对话框处理失败，
      // 已排除"点击被阻塞"与"检测时机"两个原因，细节记在 docs/next-steps-handoff.md）。
      // 场景未进仓库，技能先留着 —— 它的内容（对话框不在 DOM 里、promptText 必须传、
      // 别重复点击）与场景成败无关，是独立有效的。等场景补上再填 playbook。
    },
  },
  {
    name: 'download-verify',
    displayName: '下载文件：页面上不会变，凭据只能来自浏览器事件',
    description:
      '让页面导出/下载文件时使用。当用户说「导出/下载/保存成文件」时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['下载', '导出', '浏览器事件'],
    skill_type: 'prompt-template',
    content:
      '# 下载：**页面上什么都不会变**\n\n' +
      '## 最容易错的一步\n' +
      '点一下导出链接，然后看页面 —— **什么都没有变**。于是很容易把"点了链接"当成"导出了" ✗\n' +
      '下载是**浏览器级**行为：不产生 DOM 变化、没有页面状态文案，页面自己也不知道。\n\n' +
      '## 正确的凭据\n' +
      '`read_diagnostics({ kind: "downloads" })` —— 它读的是**浏览器报的下载事件**，\n' +
      '里面有真实的 URL 与**文件名**（由响应头 `Content-Disposition` 决定，\n' +
      '常常和链接文字或 URL 末段都不一样）。要回答"文件叫什么"，只能看这里。\n\n' +
      '## 步骤\n' +
      '1. 找到导出入口（链接/按钮）；\n' +
      '2. 点它 —— **不要**期待页面变化，也别因为"没反应"就重复点（可能触发多次下载）；\n' +
      '3. `read_diagnostics({kind:"downloads"})` 读浏览器事件，报出文件名；\n' +
      '4. 若事件列表为空：可能是**点击之前没有 attach CDP**（下载事件靠 CDP 上报）——\n' +
      '   这时如实说明"没能确认下载是否发生"，而不是猜。\n\n' +
      '## 三条纪律\n' +
      '- **别用页面状态证明下载**：它不会变。\n' +
      '- **别重复点**：一次点击可能已经产生一次下载，重复点会变成多份。\n' +
      '- **文件名以浏览器事件为准**：链接文字与真实文件名经常不一致。',
    x: {
      intents: ['browser_task'],
      tools: ['get_ax_snapshot', 'click_element', 'read_diagnostics', 'inspect_element', 'complete_task'],
      keywords: ['导出|下载|保存成文件|导出报表|报表'],
      playbook: 'download-verify',
    },
  },
  {
    name: 'date-picker-custom',
    displayName: '自定义日期选择器：打字没用，要点日历',
    description:
      '页面上选日期时使用（预订、筛选、报表区间等）。当用户说「选某天」「订某天入住」时使用。',
    version: '1.0.0',
    category: 'browser-automation',
    tags: ['日期', '日历', '只读输入', '禁用日'],
    skill_type: 'prompt-template',
    content:
      '# 选日期：先分清是**原生**控件还是**自定义**日历\n\n' +
      '## 最容易错的一步\n' +
      '看到输入框就往里打字 ✗ —— 自定义日期控件的输入框常常是 `readonly`，\n' +
      '程序化输入**静默无效**：工具可能回"已输入"，但值根本没进去。\n' +
      '**先把值读回来**（`inspect_element({op:"value"})`）再决定下一步。\n\n' +
      '## 自定义日历的四步\n' +
      '1. 点"选择日期"之类的入口把日历**打开**；\n' +
      '2. **等一拍再读**：日历经常是异步渲染的，刚点开只有"加载中"——立刻点格子会落空 ✗\n' +
      '   （拿不到格子就再读一次，而不是重复点开）；\n' +
      '3. **确认月份**：目标日期可能不在当前显示的月份，先翻月（看日历标题的年月）；\n' +
      '4. **读一遍格子再点**：注意 `已订满` / 禁用日（禁用格子点了不会有任何反应，\n' +
      '   而"点了没反应"很容易被误判成工具坏了 ✗）。\n\n' +
      '## 三条纪律\n' +
      '- **别信"已输入"**：只读输入框会让人以为填好了，一定要回读值。\n' +
      '- **别用"点数字"碰运气**：日期格子要按 `aria-label`（如「3月15日」）定位，\n' +
      '  而不是"第 15 个按钮"——每月天数与禁用项都会让序号错位。\n' +
      '- **月份对不上要如实说**：若目标日期在可选范围内根本不存在（超出可预订区间），\n' +
      '  如实说明，不要随便选一个相近的日子充数。',
    x: {
      intents: ['browser_task'],
      tools: ['get_page_snapshot', 'click_element', 'inspect_element', 'wait_for_element', 'complete_task'],
      keywords: ['入住日期|选日期|日历|日期选择'],
      playbook: 'date-picker-custom',
    },
  },
]);

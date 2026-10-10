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
      '4. 等结果渲染出来后再读 —— 用 `inspect_element({op:"text"})` 取**结果列表容器**的文本，不要把整页倒回来；\n' +
      '5. 汇总时给出条目标题与关键字段（价格/时间/评分等），并说明共取到几条。\n\n' +
      '## 四个容易踩的点\n' +
      '- **结果列表是异步渲染的。** 点击后不要立刻读列表，否则拿到空结果并把"没搜到"当成事实。\n' +
      '  RecallFlow 的动作工具会等页面静默，但**读列表前仍应确认容器里真的有条目**。\n' +
      '- **语义定位要求页面规范可访问。** `role`+`name` 只在元素真的暴露了 role/aria-label 时才命中；\n' +
      '  遇到老页面/自研组件时回退 `selector` 或 `text`。命中失败时先怀疑"定位条件不够"，\n' +
      '  而不是先断言"页面上没有这个输入框"。\n' +
      '- **广告条目和真实结果要分开判断。** 检索阶段先把带 "广告/推广/赞助" 标记的条目照原样取回，\n' +
      '  不要悄悄丢掉 —— 丢不丢是用户的选择，不是检索这一层的决定。\n' +
      '- **别把整页文本丢给自己当"结果"。** 结构化字段（标题/价格）才是可核对的交付物。',
    x: {
      intents: ['browser_task'],
      keywords: ['站内搜|站内检索|搜一下|搜索|检索', '结果|列表|条目|前几条'],
      tools: ['get_page_snapshot', 'type_text', 'click_element', 'inspect_element', 'complete_task'],
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
      '- **不要用 `run_javascript` 读样式**：它每次都要用户批准，而且会被页面 CSP 拦住。\n' +
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
]);

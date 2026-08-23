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
      '先用 read_current_page 或 get_page_snapshot 理解全文，挑选 3-8 条关键句子。\n' +
      '- highlight_text 的 text 必须使用页面中的原文片段，不能改写或概括。\n' +
      '- 高亮前先调用 clear_page_overlays 清除上一次浮层，避免叠加遮挡文字。\n' +
      '- 全部高亮完成后用 complete_task 输出要点总结。',
    x: {
      intents: ['browser_task'],
      keywords: ['划出|划重点|标出|标重点', '关键信息|重点内容|重点句子|精华|关键点'],
      tools: ['read_current_page', 'get_page_snapshot', 'highlight_text', 'clear_page_overlays', 'complete_task'],
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
      '- 优先用 set_element_style 将其设为 display:none；若有明确关闭按钮则用 click_element。\n' +
      '- 执行后以真实返回为准回复，不要声称已生效而实际未操作。',
    x: {
      intents: ['browser_task'],
      keywords: ['去掉|去除|移除|屏蔽|隐藏', '广告|推广|弹窗'],
      tools: ['get_page_snapshot', 'set_element_style', 'click_element', 'clear_page_overlays', 'complete_task'],
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
  },
]);

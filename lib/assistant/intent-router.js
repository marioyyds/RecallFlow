// 意图路由：在 Agent 执行前把用户指令归类为浏览器操作 / 知识库查询 / 资料研究 / 普通对话，
// 并为每类意图提供工具白名单、预算、系统提示与完成指引。
// 目的：避免模型“所有工具都试一遍”，减少 search_knowledge_base + fetch_webpage 之类的绕路调用。
import { TOOL_REGISTRY } from './tools.js';
import { buildSkillCatalog } from './skills.js';

export const INTENTS = Object.freeze({
  BROWSER: 'browser_task',
  KNOWLEDGE: 'knowledge_task',
  RESEARCH: 'research_task',
  CHAT: 'chat_task',
});

const ALL_TOOL_NAMES = new Set(TOOL_REGISTRY.map((tool) => tool.name));

// 每类意图的默认推理轮数。用户显式配置 agentBudget.maxModelTurns 时以用户配置为准。
export const INTENT_TURN_DEFAULTS = Object.freeze({
  [INTENTS.BROWSER]: 14,
  [INTENTS.KNOWLEDGE]: 8,
  [INTENTS.RESEARCH]: 14,
  [INTENTS.CHAT]: 6,
});

const INTENT_DEFS = Object.freeze({
  [INTENTS.BROWSER]: {
    label: '浏览器操作',
    description: '打开网页、搜索、浏览、播放、进入目标站点',
    allowedTools: [
      'open_tab',
      'list_tabs',
      'switch_tab',
      'get_page_snapshot',
      'read_current_page',
      'type_text',
      'press_key',
      'select_option',
      'check_box',
      'wait_for_element',
      'get_attribute',
      'click_element',
      'set_element_style',
      'highlight_text',
      'outline_element',
      'get_element_text',
      'scroll_page',
      'clear_page_overlays',
      'run_javascript',
      'list_userscripts',
      'search_userscripts',
      'install_userscript',
      'run_userscript',
      'complete_task',
    ].filter((name) => ALL_TOOL_NAMES.has(name)),
    includeMcp: false,
    rules: [
      '只能使用浏览器类工具，禁止调用 search_knowledge_base、list_knowledge_base、fetch_webpage 等检索/抓取工具。',
      '优先在用户当前页面内完成操作；需要搜索时，先确认当前页是否为可用的搜索引擎，能用则直接 type_text，不要盲目开新页。',
      '需要打开某个网址时，open_tab 会优先复用已打开的同 URL 标签页；不要对同一网址重复 open_tab，也不要反复新建标签页。',
      '本任务新建标签页有数量上限，一旦 open_tab 返回“达到上限”的提示，立即停止新建：改用 switch_tab 复用已打开的标签页（用返回里的 tabId），或改用 fetch_webpage 抓取内容。',
      '点击结果链接若检测到新标签页会自动绑定，直接用 get_page_snapshot 查看新页面即可，不要先 list_tabs 再 switch_tab。',
      'click_element 返回结果中会包含新页面的标题、URL 和元素摘要；直接据此判断目标是否已达成，不要再次调用 get_page_snapshot 重复验证。',
      '用户要求修改页面样式（标题变大、加粗、换色、高亮、描边）时，使用 set_element_style / highlight_text / outline_element，以真实执行结果为准回复，不要凭空声称“已设置完成”。',
      '划重点 / 去广告 / 用户脚本类任务已注册为专项技能，命中时按其规则执行即可，不要重复发散。',
      '同一状态只验证一次，不要反复调用 get_page_snapshot 观察没有变化的状态。',
      '当目标页面标题或 URL 已包含目标关键词、目标内容已可见时，立即调用 complete_task 结束任务。',
    ],
  },
  [INTENTS.KNOWLEDGE]: {
    label: '知识库查询',
    description: '检索、查看、增删个人知识库（错题、文章、AI·Prompt、笔记）',
    allowedTools: [
      'search_knowledge_base',
      'list_knowledge_base',
      'get_entry',
      'add_entry',
      'remove_entry',
      'read_current_page',
      'get_page_snapshot',
      'complete_task',
    ].filter((name) => ALL_TOOL_NAMES.has(name)),
    includeMcp: false,
    rules: [
      '优先使用知识库工具检索和回答；只有用户明确要求时才能保存或删除条目。',
      '不要打开新标签页或抓取外部网页，除非用户明确要求。',
      '给出答案后调用 complete_task 声明完成。',
    ],
  },
  [INTENTS.RESEARCH]: {
    label: '资料研究',
    description: '总结、解释、翻译、对比、查资料等需要综合信息的任务',
    allowedTools: [
      'search_knowledge_base',
      'list_knowledge_base',
      'get_entry',
      'read_current_page',
      'get_page_snapshot',
      'list_tabs',
      'switch_tab',
      'open_tab',
      'fetch_webpage',
      'web_search',
      'wait_for_element',
      'get_attribute',
      'click_element',
      'get_element_text',
      'scroll_page',
      'highlight_text',
      'outline_element',
      'set_element_style',
      'clear_page_overlays',
      'run_javascript',
      'complete_task',
    ].filter((name) => ALL_TOOL_NAMES.has(name)),
    includeMcp: true,
    rules: [
      '先看当前页面和知识库是否已有答案，再决定是否抓取外部网页；同一 URL 不要重复 fetch_webpage。',
      '不知道正确的来源 URL 时，先用 web_search 搜索目标关键词找到官方/权威链接，再 fetch_webpage 或 open_tab 读取；不要凭空猜测 URL 反复抓取。',
      '优先复用当前页面或已打开的标签页获取资料；需要新页面时 open_tab 会复用同 URL 标签页，不要重复开新页，且注意新建标签页有数量上限，触顶后改用 switch_tab / fetch_webpage。',
      'fetch_webpage 返回正文过少时，很可能是前端 JS 渲染（SPA）页面：请改用 open_tab 打开该页，再用 read_current_page / get_page_snapshot 读取渲染后的内容；不要反复用 fetch_webpage 猜测 URL。',
      '页面正文较长时，read_current_page 一次已能读取大部分正文；不要为同一页反复滚动+读取，除非确有必要获取末尾内容。',
      '给出完整回答后调用 complete_task 声明完成。',
    ],
  },
  [INTENTS.CHAT]: {
    label: '普通对话',
    description: '闲聊、问候或需要知识库/联网查证的一般问答',
    allowedTools: [
      'search_knowledge_base',
      'list_knowledge_base',
      'get_entry',
      'read_current_page',
      'get_page_snapshot',
      'fetch_webpage',
      'web_search',
      'list_tabs',
      'open_tab',
      'switch_tab',
    ].filter((name) => ALL_TOOL_NAMES.has(name)),
    includeMcp: false,
    rules: [
      '优先直接回答；若需要事实或资料支撑，可用知识库检索（search_knowledge_base）、网络搜索（web_search）或联网抓取（fetch_webpage）查证，并标注来源。',
      '若需要当前未安装的技能，可调用 install_skill 从 SkillHub 安装（需你确认），随后 load_skill 使用。',
      '不要调用页面编辑/输入/写库类工具（如 type_text、click_element、run_javascript、add_entry 等）。',
      'fetch_webpage 返回“正文过少/疑似 SPA”或“抓取失败”时，改用 open_tab 打开该页后用 read_current_page / get_page_snapshot 读取渲染后内容；不要反复用 fetch_webpage 猜测 URL。',
      '给出回答后自然结束即可，无需调用 complete_task。',
    ],
  },
});

const KEYWORD_RULES = [
  {
    intent: INTENTS.BROWSER,
    weight: 3,
    patterns: [
      /(打开|跳转|进入|访问|直达|导航到)/,
      /(搜索|搜一下|查找|搜)/,
      /(播放|观看|看视频|收听|听歌)/,
      /(变大|放大|改小|改大|加粗|高亮|描边|换颜色|改颜色|调大)/,
      /(改样式|调样式|调整布局|放大字体)/,
      /(划出|划重点|标出|标重点)/,
      /(下载视频|视频下载|下载这个|展开全文|自动签到|去广告|抢购)/,
      /(去掉广告|去除广告|屏蔽广告|拦截广告|广告拦截)/,
      /(去掉|去除|移除|屏蔽|隐藏).{0,8}(广告|推广|弹窗)/,
      /(广告|推广|弹窗).{0,8}(去掉|去除|移除|屏蔽|隐藏)/,
    ],
  },
  {
    intent: INTENTS.BROWSER,
    weight: 1,
    patterns: [
      /(看看|看一下|去看|我想看|我要看|帮我看看)/,
      /(小说|视频|电影|电视剧|动漫|B站|bilibili|百度|google|知乎|起点|淘宝|京东)/,
      /(样式|字体|字号|颜色|标题|居中|滚动到|滚动|标注|调整)/,
      /(关键信息|重点内容|重点句子|精华|关键点)/,
      /(脚本|userscript)/,
      /(隐藏|移除|去掉|屏蔽)/,
    ],
  },
  {
    intent: INTENTS.KNOWLEDGE,
    weight: 3,
    patterns: [
      /(知识库|收藏|笔记|错题|书签)/,
      /(保存|收录|加入收藏|存入)/,
    ],
  },
  {
    intent: INTENTS.RESEARCH,
    weight: 3,
    patterns: [
      /(总结|概括|提炼)/,
      /(翻译|解释|分析|对比|比较|区别)/,
      /(查资料|查一下|资料)/,
      /(为什么|是什么|怎么样|如何|原理)/,
      /(实现|编写|写代码|复现|代码)/,
      /(部署|怎么部署|如何部署|部署到|安装到)/,
      /(需要注意|注意什么|注意事项|有什么注意|避坑|踩坑)/,
      /(步骤|教程|操作步骤|流程|指南)/,
      /(配置|环境变量|依赖|版本要求|兼容)/,
      /(最佳实践|常见问题|坑点|选型)/,
    ],
  },
  {
    intent: INTENTS.RESEARCH,
    weight: 6,
    patterns: [/(写.*脚本|开发.*脚本|制作.*脚本)/],
  },
];

const PRIORITY = [INTENTS.BROWSER, INTENTS.KNOWLEDGE, INTENTS.RESEARCH, INTENTS.CHAT];
const CONTINUATION_RE = /^(继续|接着|下一步|好的|可以|继续吧|然后呢|再来|再试一次|就这样|是的)[，。！？!?,\s]*$/u;

function scoreIntent(text) {
  const scores = { [INTENTS.BROWSER]: 0, [INTENTS.KNOWLEDGE]: 0, [INTENTS.RESEARCH]: 0, [INTENTS.CHAT]: 0 };
  for (const rule of KEYWORD_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) scores[rule.intent] += rule.weight;
    }
  }
  return scores;
}

// 去掉“帮我/我想看/打开/搜索”等动词壳，尽量提取真正的目标关键词。
export function extractKeyword(instruction = '') {
  return String(instruction || '')
    .trim()
    .replace(/^(请|帮我|麻烦你|你好[，,、\s]*)/, '')
    .replace(/^(把|将)/, '')
    .replace(/^(我想看|我要看|我想|我要|我想请|麻烦|帮我)\s*/, '')
    .replace(/^(打开|搜索|搜|查|查找|看看|看一下|去看|看|进入|访问|跳转|浏览|播放|观看|翻译|解释|总结|保存|收藏)\s*(一下|一遍|下)?\s*/u, '')
    .replace(/^(成|为)/, '')
    .replace(/^(一下|一遍)\s*/, '')
    .replace(/(打开|搜索|搜一下|搜|查找|查一下|播放|观看|帮我|我想看|我要看)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[，。！？!?,.、\s]+$/g, '')
    .trim()
    .slice(0, 60);
}

/**
 * 识别用户指令意图。
 * @param {string} instruction
 * @param {Array} [history] - 会话历史（用于“继续/接着”等承接语继承上一轮意图）
 * @param {Object} [opts] - { forceContinuation?: boolean } 前端点击触底建议按钮等明确继续指令时置 true
 * @returns {{ intent: string, label: string, confidence: 'high'|'medium'|'low', keyword: string, reason: string }}
 */
export function detectIntent(instruction = '', history = [], opts = {}) {
  const text = String(instruction || '').trim();
  // “继续/接着/好的”等承接语没有独立意图，沿用上一轮用户指令的意图与关键词；
  // forceContinuation 由“点击触底建议按钮”等明确继续指令发起，同样继承上一任务意图与工具权限。
  let sourceText = text;
  if (CONTINUATION_RE.test(text) || opts.forceContinuation === true) {
    const lastUser = (Array.isArray(history) ? history : [])
      .filter((h) => h && h.role === 'user' && typeof h.content === 'string' && h.content.trim() !== text)
      .pop();
    if (lastUser) sourceText = lastUser.content;
  }
  const scores = scoreIntent(sourceText);
  // 按得分降序；得分相同时保持 PRIORITY 顺序（稳定排序），保证“看看我的收藏”归为知识库。
  const intent = PRIORITY.slice().sort((a, b) => scores[b] - scores[a])[0];
  const maxScore = scores[intent];
  // 全部未命中时，若指令是「实质性问句」（含疑问词、长度足够、非纯寒暄），
  // 归为资料研究以拿到联网/抓取工具与更大预算；纯闲聊才按普通对话处理。
  if (maxScore === 0) {
    const trimmed = String(sourceText || '').trim();
    const PURE_CHITCHAT_RE = /^(你好|您好|谢谢|感谢|再见|拜拜|在吗|嗨|hi|hello|hey|嗯|好|可以|好的|行)[，。！？!?,\s]*$/i;
    const substantiveQuestion =
      trimmed.length >= 4 &&
      /(什么|怎么|如何|怎样|哪些|哪几|为什么|注意|需要|部署|配置|问题)/.test(trimmed) &&
      !PURE_CHITCHAT_RE.test(trimmed);
    if (substantiveQuestion) {
      return {
        intent: INTENTS.RESEARCH,
        label: INTENT_DEFS[INTENTS.RESEARCH].label,
        confidence: 'low',
        keyword: extractKeyword(sourceText),
        sourceText,
        reason: '未命中关键词但属实质问句，按资料研究处理',
      };
    }
    return {
      intent: INTENTS.CHAT,
      label: INTENT_DEFS[INTENTS.CHAT].label,
      confidence: 'low',
      keyword: '',
      sourceText,
      reason: '未命中关键词，按普通对话处理',
    };
  }
  const confidence = maxScore >= 3 ? 'high' : maxScore >= 1 ? 'medium' : 'low';
  const label = (INTENT_DEFS[intent] || INTENT_DEFS[INTENTS.CHAT]).label;
  return {
    intent,
    label,
    confidence,
    keyword: extractKeyword(sourceText),
    sourceText,
    reason: maxScore > 0 ? '命中关键词 ' + maxScore + ' 分' : '未命中关键词，按普通对话处理',
  };
}

export function resolveIntent(intent) {
  return INTENT_DEFS[intent] || INTENT_DEFS[INTENTS.CHAT];
}

export function buildIntentSystemPrompt(intent, instruction = '') {
  const info = resolveIntent(intent);
  const keyword = extractKeyword(instruction);
  const lines = [
    '【本次任务意图】' + info.label + '：' + info.description,
    '规则：',
    ...info.rules,
    keyword ? '目标关键词可能是：' + keyword : '',
    '任务完成后必须调用 complete_task 声明完成，不要在完成后继续调用其他工具。',
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * 生成完整的 Agent 系统提示：可用工具列表按意图白名单动态生成，
 * 并明确禁止在文本里模拟 XML/JSON 工具调用（避免模型在无工具时“假装调用”）。
 */
export function buildSystemPrompt(intent, instruction = '', toolNames = [], skills = []) {
  const info = resolveIntent(intent);
  const keyword = extractKeyword(instruction);
  const availableTools = Array.isArray(toolNames) ? toolNames.filter(Boolean) : [];
  const toolList = availableTools.length
    ? availableTools.map((name) => '- ' + name).join('\n')
    : '本轮不提供任何工具，请直接回答。';
  const lines = [
    '你是一个具备工具调用能力的浏览器 AI 助手（RecallFlow），可以通过真实的 function calling 调用工具完成任务。',
    '可用工具：',
    toolList,
    '规则：',
    '1. 只能通过真实的 function calling 调用工具；绝对不要在回答文本中输出 <page_command>、<complete_task>、<open_tab> 等 XML/JSON 形式的伪工具调用。',
    '2. 工具执行结果以真实返回为准：未执行的操作不能描述为“已执行/已设置完成/已打开”，调用工具前不要声称结果已经达成。',
    '3. 回答使用中文，可用 Markdown 排版；凡是依据知识库、当前页面或第三方网页证据的句子，都必须在对应句末使用 [n] 标注来源编号，不要只在回答末尾集中列出引用。',
    '4. 当用户只是闲聊或明确无需工具时，直接回答即可。',
    ...info.rules,
    keyword ? '目标关键词：' + keyword : '',
    availableTools.includes('complete_task') ? '任务完成后必须调用 complete_task 声明完成，不要在完成后继续调用其他工具。' : '',
  ].filter(Boolean);
  // 全部技能以「目录」形式列出（name + 用途），供模型判断是否需 load_skill 加载完整说明。
  const skillCatalog = Array.isArray(skills) && skills.length ? buildSkillCatalog(skills) : '';
  return [lines.join('\n'), skillCatalog].filter(Boolean).join('\n\n');
}

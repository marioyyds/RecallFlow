// 工具定义（OpenAI / DeepSeek function-calling 格式）与内置工具执行
// 后台以工具调用循环（agent loop）驱动：模型决定调用哪些工具，
// 后台执行真实操作（检索/增删知识库），再把结果喂回模型，直到产出最终回复。
import { STATUS, STAR_LEVELS } from '../shared/constants.js';
import { typeInfo } from '../shared/utils.js';
import { getBook, upsertItem, deleteItem } from '../shared/store.js';
import { buildRagContext, buildCitations } from '../shared/rag.js';
import { listScripts as listUserscripts, searchScripts, installFromUrl, runUserscriptOnTab } from '../userscript/manager.js';
import { getUserscriptSettings } from '../userscript/settings.js';
import { getMergedSkills, addUserSkill, getUserSkills } from './skill-store.js';

// 工具 Schema 的唯一来源。对外暴露的 BUILTIN_TOOLS、权限查询和 MCP 工具列表
// 都从这里派生，避免 Agent / MCP / 执行器各维护一套不一致的参数定义。
const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge_base',
      description:
        '在用户的个人知识库中检索与查询相关的条目（算法错题、技术文章、AI·Prompt、笔记）。当用户问到知识库内容、要求基于收藏回答，或需要先查找相关资料时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词或自然语言问题' },
          limit: { type: 'integer', description: '返回条数上限，默认 5' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_knowledge_base',
      description: '列出知识库条目（可按类型筛选）。用于「知识库里有什么」「列出全部笔记」等概览类问题。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['wrong', 'article', 'ai', 'note', ''], description: '按类型筛选，留空表示全部' },
          limit: { type: 'integer', description: '返回条数上限，默认 20' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_entry',
      description: '按 id 获取单条知识库条目的完整内容（标题、备注、标签、链接、星级等）。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '条目 id（通常是其 URL）' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_entry',
      description: '向知识库新增或更新一条条目。可用于把对话中确认的知识点、总结、链接等保存下来。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['wrong', 'article', 'ai', 'note'], description: '条目类型' },
          title: { type: 'string', description: '标题' },
          url: { type: 'string', description: '相关链接（可选，无则留空）' },
          status: { type: 'integer', enum: [1, 2, 3], description: '星级 1一般 / 2重点 / 3高频' },
          note: { type: 'string', description: '备注或内容' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
        },
        required: ['type', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_entry',
      description: '从知识库删除一条条目。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '条目 id' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_current_page',
      description: '读取当前网页的正文内容（去除脚本/样式/导航等噪音后的纯文本）。当用户需要基于「正在浏览的页面」回答、总结或提取信息时调用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_page_snapshot',
      description: '读取当前网页的结构化 DOM 快照，包括页面 URL、标题、正文摘要、可交互元素和滚动状态。页面操作前后可用它判断动作是否生效。',
      parameters: {
        type: 'object',
        properties: {
          maxElements: { type: 'integer', description: '最多返回多少个可交互元素，默认 60，最大 120' },
          maxText: { type: 'integer', description: '正文摘要最大字符数，默认 4000，最大 8000' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: '向当前网页的 input、textarea 或 contenteditable 元素输入文本。优先使用 DOM 快照中的 ref；默认追加文本，clearFirst=true 时先清空。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'DOM 快照中的元素引用，如 rf-3' },
          selector: { type: 'string', description: 'CSS 选择器（ref 不可用时使用）' },
          text: { type: 'string', description: '要输入的文本' },
          clearFirst: { type: 'boolean', description: '是否先清空原内容，默认 false' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description: '向当前网页元素或当前焦点派发键盘按键，例如 Enter、Tab、Escape 或 Ctrl+A。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '目标元素引用，可选；不填时使用当前焦点' },
          selector: { type: 'string', description: 'CSS 选择器，可选' },
          key: { type: 'string', description: '按键名称或单字符，如 Enter、Tab、a' },
          modifiers: { type: 'array', items: { type: 'string', enum: ['CTRL', 'ALT', 'SHIFT', 'META'] }, description: '修饰键列表' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_option',
      description: '操作 select 下拉框。可按 option 的 value、label 或 index 选择。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'select 元素引用' },
          selector: { type: 'string', description: 'select 的 CSS 选择器' },
          value: { type: 'string', description: 'option.value' },
          label: { type: 'string', description: 'option 显示文本' },
          index: { type: 'integer', description: 'option 下标，从 0 开始' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_box',
      description: '勾选或取消 checkbox；radio 只能切换为 checked=true。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'checkbox/radio 元素引用' },
          selector: { type: 'string', description: 'checkbox/radio 的 CSS 选择器' },
          checked: { type: 'boolean', description: '目标状态' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
        },
        required: ['checked'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_element',
      description:
        '等待页面元素满足条件，适合异步渲染、翻页加载和页面跳转。state 支持 attached(挂载)、visible(可见)、enabled(可用)、text_contains(包含文本)、count(匹配数量达到 count)、detached(元素消失)、url_contains(URL 包含 text)。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '元素引用，可选' },
          selector: { type: 'string', description: 'CSS 选择器，可选' },
          text: { type: 'string', description: '目标文本，可选' },
          state: {
            type: 'string',
            enum: ['attached', 'visible', 'enabled', 'text_contains', 'count', 'detached', 'url_contains'],
            description: '等待条件，默认 visible',
          },
          count: { type: 'integer', description: 'state=count 时的目标匹配数量，默认 1' },
          timeoutMs: { type: 'integer', description: '最长等待时间，默认 8000，最大 15000' },
          pollMs: { type: 'integer', description: '轮询间隔，默认 100' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_attribute',
      description: '读取当前网页元素的 HTML 属性，例如 disabled、aria-expanded、href、data-state。密码字段不会返回实际值。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '元素引用' },
          selector: { type: 'string', description: 'CSS 选择器' },
          attribute: { type: 'string', description: '属性名，如 aria-expanded、href、disabled' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
        },
        required: ['attribute'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tabs',
      description: '列出当前浏览器窗口已打开的标签页（标题与 URL），用于定位用户正在看的资料。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_tab',
      description: '切换当前 Agent 后续操作要控制的标签页。tabId 来自 list_tabs 或 open_tab 的结果。',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'integer', description: '目标标签页 ID' },
        },
        required: ['tabId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_tab',
      description: '在新标签页打开一个 URL，并自动把后续 DOM 操作绑定到新标签页。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要打开的链接' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_webpage',
      description: '抓取并提取任意公开网页的正文文本（简易爬虫）。用于获取知识库或当前页之外的外部资料。注意：目标站点需在插件 host_permissions 中授权。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '目标网页 URL' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_element',
      description:
        '点击页面元素。会先滚动到目标、等待其可见可用并检测遮挡，再派发完整的指针/鼠标事件序列。支持 DOM 快照 ref、CSS selector、文本 text 定位，重复结构用 index 选择第 N 个。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'DOM 快照中的元素引用，如 rf-3（优先使用）' },
          selector: { type: 'string', description: 'CSS 选择器（与 ref/text 二选一）' },
          text: { type: 'string', description: '要定位的文本片段（与 ref/selector 二选一）' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_element_style',
      description:
        '修改页面元素样式（字号、加粗、颜色、背景等），如把标题调大。styles 使用驼峰 CSS 属性对象；可设 duration 在指定毫秒后自动还原。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'DOM 快照中的元素引用，如 rf-3（优先使用）' },
          selector: { type: 'string', description: 'CSS 选择器（与 ref/text 二选一）' },
          text: { type: 'string', description: '要定位的文本片段（与 ref/selector 二选一）' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
          styles: { type: 'object', description: '要应用的样式对象，如 {"fontSize":"36px","fontWeight":"bold","color":"#e60000"}' },
          duration: { type: 'integer', description: '临时效果持续时间(ms)；不填则保留，可用 clear_page_overlays 还原' },
        },
        required: ['styles'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'highlight_text',
      description: '高亮页面中的文本片段或元素，不改动页面 DOM（用浮层标注）。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要高亮的文本片段（与 selector 二选一）' },
          selector: { type: 'string', description: '要高亮的元素选择器（与 text 二选一）' },
          color: { type: 'string', description: '高亮颜色，建议 rgba 半透明；实色会自动转为低透明度，避免盖住文字' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'outline_element',
      description: '用边框描边标注目标元素，便于向用户指出位置；可设 duration 自动消失。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'DOM 快照中的元素引用，如 rf-3（优先使用）' },
          selector: { type: 'string', description: 'CSS 选择器（与 ref/text 二选一）' },
          text: { type: 'string', description: '要定位的文本片段（与 ref/selector 二选一）' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
          color: { type: 'string', description: '描边颜色，默认 #ff5722' },
          duration: { type: 'integer', description: '显示时长(ms)，默认 1500' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_element_text',
      description: '读取页面元素的文本内容，用于确认元素里到底写了什么。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'DOM 快照中的元素引用，如 rf-3（优先使用）' },
          selector: { type: 'string', description: 'CSS 选择器（与 ref/text 二选一）' },
          text: { type: 'string', description: '要定位的文本片段（与 ref/selector 二选一）' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_to_element',
      description: '滚动页面到目标元素/文本，或滚动到指定坐标。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'DOM 快照中的元素引用，如 rf-3（优先使用）' },
          selector: { type: 'string', description: 'CSS 选择器（与 ref/text 二选一）' },
          text: { type: 'string', description: '要定位的文本片段（与 ref/selector 二选一）' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
          top: { type: 'number', description: '目标纵坐标(px)，与 left 配合按坐标滚动' },
          left: { type: 'number', description: '目标横坐标(px)，与 top 配合按坐标滚动' },
          behavior: { type: 'string', enum: ['auto', 'smooth'], description: '滚动行为，默认 smooth' },
          block: { type: 'string', enum: ['start', 'center', 'end'], description: '滚动对齐方式，默认 start' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_page',
      description: '按偏移量滚动页面（向下翻一屏、向上滚动等）。',
      parameters: {
        type: 'object',
        properties: {
          y: { type: 'number', description: '纵向偏移(px)，正数向下' },
          x: { type: 'number', description: '横向偏移(px)，正数向右' },
          behavior: { type: 'string', enum: ['auto', 'smooth'], description: '滚动行为，默认 smooth' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_page_overlays',
      description: '清除页面上的高亮、描边和临时样式。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_userscripts',
      description: '列出已安装的用户脚本（名称、版本、启停状态、匹配网站），用于判断能否复用脚本能力。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_userscripts',
      description: '在 GreasyFork 搜索用户脚本，用于寻找可完成当前需求（下载、展开全文、去广告、自动签到等）的现成脚本。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词，如 视频下载 bilibili、展开全文、去广告' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'install_userscript',
      description: '安装一个用户脚本（需用户确认）。url 来自 search_userscripts 结果的 code_url 或用户提供的 .user.js 链接。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '脚本 code_url 或 .user.js 链接' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_userscript',
      description: '让一个已安装的用户脚本在当前页面立即运行（不要求 URL 匹配），用于按需执行脚本能力。scriptId 来自 list_userscripts。',
      parameters: {
        type: 'object',
        properties: { scriptId: { type: 'string', description: '已安装脚本的 id（list_userscripts 返回）' } },
        required: ['scriptId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_task',
      description:
        '声明当前用户任务已完成并给出简短总结。当目标页面已打开、内容已给出或操作已完成后，立即调用本工具结束任务；不要在完成后继续调用其他工具。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '一句话总结完成结果，例如「已打开《凡人修仙传》详情页」' },
          evidence: { type: 'string', description: '可选：完成证据，例如页面标题、URL 或关键内容' },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description:
        '按需加载一个已安装技能（专家手册）的完整使用说明。环境内置若干技能，每个技能有唯一 name 与用途。当你判断用户任务适合使用某个技能时，先调用本工具获取其详细指导，再严格遵循；不要凭空臆测技能内容。若不确定可用技能，查看系统提示中的技能目录。若所需技能不在目录中，可先调用 install_skill 从 SkillHub 安装。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能 name（系统提示技能目录中列出的名字，如 humanizer）' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'install_skill',
      description:
        '从 SkillHub 平台安装一个技能到本地（下载其 SKILL.md 并保存）。当你判断完成任务需要某个尚未安装的技能时，可先用本工具安装，再调用 load_skill 加载使用。参数为技能坐标 @namespace/slug 或技能页 URL。安装需用户确认；出于安全，仅允许 skillhub.cn 来源。',
      parameters: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: '技能坐标，如 @namespace/slug，或技能详情页 URL（https://skillhub.cn/skills/namespace/slug）' },
        },
        required: ['identifier'],
      },
    },
  },
];

// 工具本身声明风险等级，Agent 编排器据此决定是否需要用户确认。
// 这与 Vercel AI 的 tool 定义思路一致，避免在后台维护另一份易漂移的工具名单。
const TOOL_METADATA = {
  search_knowledge_base: { risk: 'read', readOnly: true, route: 'background' },
  list_knowledge_base: { risk: 'read', readOnly: true, route: 'background' },
  get_entry: { risk: 'read', readOnly: true, route: 'background' },
  read_current_page: { risk: 'read', readOnly: true, route: 'content' },
  get_page_snapshot: { risk: 'read', readOnly: true, route: 'content' },
  type_text: { risk: 'page', requiresApproval: true, route: 'content' },
  press_key: { risk: 'page', requiresApproval: true, route: 'content' },
  select_option: { risk: 'page', requiresApproval: true, route: 'content' },
  check_box: { risk: 'page', requiresApproval: true, route: 'content' },
  wait_for_element: { risk: 'read', readOnly: true, route: 'content' },
  get_attribute: { risk: 'read', readOnly: true, route: 'content' },
  list_tabs: { risk: 'read', readOnly: true, route: 'background' },
  switch_tab: { risk: 'browser', requiresApproval: true, route: 'background' },
  add_entry: { risk: 'write', requiresApproval: true, route: 'background' },
  remove_entry: { risk: 'destructive', requiresApproval: true, route: 'background' },
  open_tab: { risk: 'browser', requiresApproval: true, route: 'background' },
  fetch_webpage: { risk: 'network', requiresApproval: true, route: 'background' },
  click_element: { risk: 'page', requiresApproval: true, route: 'content' },
  set_element_style: { risk: 'page', requiresApproval: true, route: 'content' },
  highlight_text: { risk: 'page', requiresApproval: true, route: 'content' },
  outline_element: { risk: 'page', requiresApproval: true, route: 'content' },
  get_element_text: { risk: 'read', readOnly: true, route: 'content' },
  scroll_to_element: { risk: 'page', requiresApproval: true, route: 'content' },
  scroll_page: { risk: 'page', requiresApproval: true, route: 'content' },
  clear_page_overlays: { risk: 'page', requiresApproval: true, route: 'content' },
  list_userscripts: { risk: 'read', readOnly: true, route: 'background' },
  search_userscripts: { risk: 'network', requiresApproval: true, route: 'background' },
  install_userscript: { risk: 'write', requiresApproval: true, route: 'background' },
  run_userscript: { risk: 'page', requiresApproval: true, route: 'content' },
  complete_task: { risk: 'read', readOnly: true, route: 'background' },
  load_skill: { risk: 'read', readOnly: true, alwaysAvailable: true, route: 'background' },
  install_skill: { risk: 'external', readOnly: false, alwaysAvailable: true, requiresApproval: true, route: 'background' },
};

export const TOOL_REGISTRY = Object.freeze(
  TOOL_SCHEMAS.map((tool) => {
    const name = tool.function.name;
    const metadata = TOOL_METADATA[name] || { risk: 'unknown', requiresApproval: true, route: 'background' };
    return Object.freeze({
      name,
      description: tool.function.description,
      inputSchema: tool.function.parameters,
      risk: metadata.risk,
      requiresApproval: metadata.requiresApproval === true,
      readOnly: metadata.readOnly === true,
      alwaysAvailable: metadata.alwaysAvailable === true,
      route: metadata.route || 'background',
      openai: tool,
    });
  })
);

const TOOL_BY_NAME = new Map(TOOL_REGISTRY.map((tool) => [tool.name, tool]));
export const BUILTIN_TOOLS = TOOL_REGISTRY.map((tool) => tool.openai);

export function getToolDefinition(name) {
  return TOOL_BY_NAME.get(name) || null;
}

export function getToolMetadata(name) {
  if (typeof name === 'string' && name.indexOf('mcp__') === 0) {
    return { risk: 'external', requiresApproval: true };
  }
  const definition = getToolDefinition(name);
  return definition
    ? { risk: definition.risk, requiresApproval: definition.requiresApproval, readOnly: definition.readOnly, route: definition.route }
    : { risk: 'unknown', requiresApproval: true, readOnly: false, route: 'background' };
}

/**
 * 对模型返回的工具参数做最小结构校验。完整 JSON Schema 校验留给后续，
 * 这里先保证未知工具、非对象参数和 required 字段不会直接进入执行器。
 */
export function validateToolCall(name, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: '工具参数必须是 JSON 对象。' };
  }
  const definition = getToolDefinition(name);
  if (!definition) {
    if (typeof name === 'string' && name.indexOf('mcp__') === 0) return { ok: true };
    return { ok: false, error: '未知工具：' + name };
  }
  const required = definition.inputSchema && Array.isArray(definition.inputSchema.required)
    ? definition.inputSchema.required
    : [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  return missing.length
    ? { ok: false, error: '工具「' + name + '」缺少必填参数：' + missing.join('、') }
    : { ok: true };
}

export const AGENT_SYSTEM_PROMPT = `你是一个具备工具调用能力的个人知识库 AI 助手。你可以使用以下工具：
- 检索、列出、查看、增删用户的个人知识库（算法错题、技术文章、AI·Prompt、笔记）；
- 读取当前浏览的网页正文（read_current_page）或结构化 DOM 快照（get_page_snapshot）、列出/打开/切换浏览器标签页、抓取外部网页（fetch_webpage）；
- 通过 type_text、press_key、select_option、check_box 操作表单，通过 wait_for_element 等待异步页面，通过 get_attribute 读取元素状态；
- 通过 click_element、set_element_style、highlight_text、outline_element、get_element_text、scroll_to_element、scroll_page、clear_page_overlays 操作页面元素；
- 连接用户配置的 MCP 服务器（工具名以 mcp__ 开头），用于访问更多外部能力。

请优先用工具获取真实信息后再回答，不要编造不存在的内容。回答使用中文，可用 Markdown 排版；凡是依据知识库、当前页面或第三方网页证据的句子，都必须在对应句末使用 [n] 标注来源编号，不要只在回答末尾集中列出引用。当用户只是闲聊或明确无需工具时，直接回答即可。`;

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function getPageSnapshot(tabId, options = {}) {
  if (!tabId) return null;
  const snapshot = await sendTabMessage(tabId, { type: 'kbGetPageSnapshot', options });
  return snapshot && snapshot.version ? snapshot : null;
}

async function waitForTabReady(tabId, timeoutMs = 8000) {
  const deadline = Date.now() + Math.min(12000, Math.max(500, timeoutMs));
  while (Date.now() < deadline) {
    const snapshot = await getPageSnapshot(tabId, { maxElements: 30, maxText: 800 }).catch(() => null);
    if (snapshot) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

function verifyPageAction(command, before, after, response) {
  const executed = Boolean(response && response.ok !== false);
  const urlChanged = Boolean(before && after && before.url !== after.url);
  const contentChanged = Boolean(before && after && before.fingerprint !== after.fingerprint);
  const scrollChanged = Boolean(before && after && before.scroll && after.scroll &&
    (before.scroll.x !== after.scroll.x || before.scroll.y !== after.scroll.y));
  const visualOnly = ['highlight', 'outline', 'set_style', 'clear_highlights'].includes(command);
  const responseChanged = Boolean(response && (response.changed || response.hadEffect));
  const responseSatisfied = Boolean(response && response.alreadySatisfied);
  const eventOnly = command === 'press_key';
  const changed = urlChanged || contentChanged || scrollChanged || responseChanged;
  let reason = executed ? '动作已执行' : '页面命令返回失败';
  if (command === 'click' && executed && !changed) reason = '点击已派发，但页面快照暂未观察到变化';
  if (command.indexOf('scroll') === 0 && executed && !scrollChanged) reason = '滚动已派发，但滚动位置未变化';
  if (visualOnly && executed) reason = '视觉标注动作已执行；标注层不计入内容指纹';
  if (command === 'type_text' && executed && responseSatisfied) reason = '目标输入已处于要求状态';
  else if (command === 'type_text' && executed && !changed) reason = '输入事件已派发，但快照未观察到值状态变化';
  if (command === 'press_key' && executed) reason = '键盘事件已派发';
  return {
    executed,
    verified: executed && (changed || responseSatisfied || visualOnly || eventOnly || command === 'get_text'),
    changed,
    urlChanged,
    contentChanged,
    scrollChanged,
    reason,
  };
}

// 把 DOM 快照压缩成给模型看的短摘要：标题、URL、关键元素、正文开头。
function compactSnapshotSummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const title = String(snapshot.title || '');
  const url = String(snapshot.url || '');
  const elements = Array.isArray(snapshot.elements)
    ? snapshot.elements
        .slice(0, 8)
        .map((e) => {
          const label = e.label || e.placeholder || '';
          return e.ref + (label ? '：' + String(label).slice(0, 24) : '');
        })
        .join('；')
    : '';
  const text = String(snapshot.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return ['页面标题：' + title, '页面URL：' + url, elements ? '关键元素：' + elements : '', text ? '正文摘要：' + text : '']
    .filter(Boolean)
    .join('\n');
}

async function executeContentAction(tabId, action, message, options = {}) {
  if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
  const shouldVerify = options.verify !== false;
  const before = shouldVerify ? await getPageSnapshot(tabId, { maxElements: 50, maxText: 1600 }).catch(() => null) : null;
  const response = await sendTabMessage(tabId, message);
  if (!response) return { ok: false, result: '页面内容脚本无响应或尚未注入。' };
  if (response.ok === false) return { ok: false, result: response.error || response.result || ('页面动作失败：' + action) };
  if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  let after = shouldVerify ? await getPageSnapshot(tabId, { maxElements: 50, maxText: 1600 }).catch(() => null) : null;
  if (shouldVerify && !after && before) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && tab.url) after = { version: 1, url: tab.url, title: tab.title || '', fingerprint: 'navigation:' + tab.url, scroll: null };
  }
  const verification = shouldVerify
    ? verifyPageAction(action, before, after, response)
    : { executed: true, verified: true, changed: false, reason: '读取类工具无需页面变化验证' };
  return {
    ...response,
    ok: true,
    hadEffect: Boolean(verification.changed),
    result: (response.result || ('已执行页面动作：' + action)) + (shouldVerify ? '\n验证：' + verification.reason : ''),
    verification,
    pageSnapshot: after,
  };
}

// 独立页面工具 → 底层页面命令的映射（拆分后每个工具只负责一个动作）。
function pageToolCommand(name) {
  const map = {
    click_element: 'click',
    set_element_style: 'set_style',
    highlight_text: 'highlight',
    outline_element: 'outline',
    get_element_text: 'get_text',
    scroll_to_element: 'scroll_to',
    scroll_page: 'scroll_by',
    clear_page_overlays: 'clear_highlights',
  };
  return map[name] || name;
}

// 前后快照是否发生可观察变化（URL / 内容指纹 / 滚动位置）。
function snapshotChanged(before, after, command) {
  if (!before || !after) return false;
  if (before.url !== after.url) return true;
  if (before.fingerprint && after.fingerprint && before.fingerprint !== after.fingerprint) return true;
  if (
    (command === 'scroll_to' || command === 'scroll_by') &&
    before.scroll && after.scroll &&
    (before.scroll.x !== after.scroll.x || before.scroll.y !== after.scroll.y)
  ) {
    return true;
  }
  return false;
}

// 统一执行页面动作：动作前后快照验证、点击后新标签页自动发现与绑定、返回紧凑页面摘要。
async function executePageTool(tabId, command, args, ctx) {
  if (!tabId) return { result: '无法定位当前标签页（可能不在前台页面）。' };
  try {
    const shouldVerify = ['click', 'scroll_to', 'scroll_by', 'set_style'].includes(command);
    // 点击前记录现有标签页，点击后用于检测 target="_blank" 新建的标签页并自动绑定。
    const beforeTabs = command === 'click' ? await chrome.tabs.query({ currentWindow: true }).catch(() => null) : null;
    const before = shouldVerify ? await getPageSnapshot(tabId, { maxElements: 40, maxText: 1200 }).catch(() => null) : null;
    const res = await sendTabMessage(tabId, { type: 'kbPageCommand', command, params: args });
    if (!res) return { result: '页面命令无响应（内容脚本未注入或页面不支持）。' };
    if (res.ok === false) return { ok: false, result: '页面命令「' + command + '」失败：' + (res.error || '未知错误') };
    // 点击/滚动等动作轮询等待页面变化（SPA 异步渲染可能超过 320ms），
    // 同时检测点击 target="_blank" 新建的标签页并自动绑定。
    const polling = shouldVerify && (command === 'click' || command === 'scroll_to' || command === 'scroll_by');
    let after = null;
    if (polling) {
      const deadline = Date.now() + (command === 'click' ? 4500 : 1800);
      let nullStreak = 0;
      while (Date.now() < deadline) {
        if (command === 'click' && beforeTabs && Array.isArray(beforeTabs)) {
          const existingIds = new Set(beforeTabs.map((t) => t.id));
          const nowTabs = await chrome.tabs.query({ currentWindow: true }).catch(() => []);
          const newTab = nowTabs.find((t) => t.id && !existingIds.has(t.id));
          if (newTab && newTab.id) {
            const snap = await waitForTabReady(newTab.id, 7000);
            const current = await chrome.tabs.get(newTab.id).catch(() => newTab);
            const targetTab = {
              tabId: newTab.id,
              windowId: current.windowId || newTab.windowId,
              title: current.title || newTab.title || '',
              url: current.url || newTab.url || '',
              ready: Boolean(snap),
            };
            ctx.tabId = newTab.id;
            ctx.pageUrl = targetTab.url || ctx.pageUrl;
            ctx.pageTitle = targetTab.title || ctx.pageTitle;
            return {
              ok: true,
              hadEffect: true,
              targetTabId: newTab.id,
              targetTab,
              pageSnapshot: snap,
              result:
                '点击已派发，检测到新标签页并已自动绑定：tabId=' + newTab.id + ' ' + targetTab.url +
                (snap ? '\n' + compactSnapshotSummary(snap) + '\n（页面已就绪，可直接据此判断任务是否完成）' : '（内容脚本尚未就绪）'),
            };
          }
        }
        const snap = await getPageSnapshot(tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
        if (snap) {
          nullStreak = 0;
          after = snap;
          if (snapshotChanged(before, snap, command)) break;
        } else {
          nullStreak += 1;
          if (nullStreak >= 3) break; // 内容脚本已卸载（正在导航），改用 Tab URL 兜底
        }
        await new Promise((resolve) => setTimeout(resolve, 220));
      }
    } else if (shouldVerify) {
      await new Promise((resolve) => setTimeout(resolve, 160));
      after = await getPageSnapshot(tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
    }
    // 点击触发导航时，旧内容脚本可能已卸载；此时至少用 Tab URL 判断导航是否发生。
    if (shouldVerify && !after && before) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && tab.url) after = { version: 1, url: tab.url, title: tab.title || '', fingerprint: 'navigation:' + tab.url, scroll: null };
    }
    const verification = shouldVerify
      ? verifyPageAction(command, before, after, res)
      : { executed: true, verified: true, changed: false, reason: '读取类/视觉类命令无需内容验证' };
    if (after && after.url) {
      ctx.pageUrl = after.url || ctx.pageUrl;
      ctx.pageTitle = after.title || ctx.pageTitle;
    }
    return {
      ok: true,
      hadEffect: Boolean(verification.changed),
      result:
        (res.result || '已执行页面命令：' + command) +
        '\n验证：' + verification.reason +
        (command === 'click' && after ? '\n' + compactSnapshotSummary(after) : ''),
      verification,
      pageSnapshot: after,
    };
  } catch (e) {
    return { ok: false, result: '页面命令执行失败：' + e.message };
  }
}

/**
 * 执行单个工具调用
 * @param {string} name - 工具名
 * @param {Object} args - 参数
 * @param {Object} ctx - 运行上下文 { book, settings, page }
 * @returns {Promise<{result: string, citations?: Array, savedId?: string}>}
 */
// 从 SkillHub 下载技能 SKILL.md 并安装到本地（进阶版 A 的"自动获取"闭环）。
// 仅允许 skillhub.cn 来源；下载后做 name(kebab-case) 校验，避免非法/注入内容入库。
// 从 SkillHub 安装技能（进阶版 A 的"自动获取"闭环）。
// 注意：SkillHub 仅 /api/v1/search 的 GET 对匿名开放；详情/file 接口均返回 405，无法拉取逐字 SKILL.md。
// 故改为：检索拿到元数据 → 基于元数据生成本地技能（内容为摘要，非上游逐字），保证安装闭环可用且不会 405 死循环。
async function installSkillFromSkillHub(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) return { ok: false, result: '缺少技能 identifier 参数（应为 @namespace/slug 或技能页 URL 或关键词）。' };
  let ns = null;
  let slug = null;
  let keyword = raw;
  const at = raw.match(/^@?([\w.-]+)\/([\w.-]+)$/);
  if (at) {
    ns = at[1];
    slug = at[2];
    keyword = slug;
  } else {
    try {
      const u = new URL(raw);
      if (!/(^|\.)skillhub\.cn$/i.test(u.hostname)) {
        return { ok: false, result: '出于安全限制，仅允许从 skillhub.cn 安装技能。' };
      }
      const m = u.pathname.match(/\/skills\/([^/]+)\/([^/?#]+)/) || u.pathname.match(/\/([^/]+)\/([^/?#]+?)(?:\.html)?$/);
      if (m) {
        ns = decodeURIComponent(m[1]);
        slug = decodeURIComponent(m[2]);
        keyword = slug;
      }
    } catch (e) {
      /* 当关键词处理 */
    }
  }
  const apiBase = 'https://api.skillhub.cn/api/v1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const searchUrl = apiBase + '/search?keyword=' + encodeURIComponent(keyword);
    const searchResp = await fetch(searchUrl, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!searchResp.ok) {
      return { ok: false, result: 'SkillHub 检索接口返回 ' + searchResp.status + '（该接口可能需登录或已调整）。' };
    }
    const searchJson = await searchResp.json();
    const results = Array.isArray(searchJson.results)
      ? searchJson.results
      : Array.isArray(searchJson)
        ? searchJson
        : [];
    let hit = null;
    if (slug) hit = results.find((r) => r.slug === slug || (r.namespace && r.namespace.publicSlug === slug));
    if (!hit && ns) {
      hit = results.find((r) => r.namespace && (r.namespace.handle === ns || r.namespace.canonicalName === '@' + ns + '/' + (slug || '')));
    }
    if (!hit) hit = results[0];
    if (!hit) return { ok: false, result: 'SkillHub 未检索到匹配「' + keyword + '」的技能。' };
    const name = hit.slug || hit.name;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name || '')) {
      return { ok: false, result: '技能名（slug）必须是 kebab-case，实际为：' + name };
    }
    const existing = await getUserSkills();
    if (existing.some((s) => s.name === name)) {
      return { result: '技能「' + name + '」已安装，无需重复安装。可调用 load_skill("' + name + '") 使用。' };
    }
    const summary = (hit.summary || hit.description || hit.description_zh || '').toString();
    const description = (hit.description_zh || hit.description || summary || '').toString().slice(0, 300);
    const skill = {
      name,
      displayName: hit.displayName || hit.name,
      description,
      version: hit.version || '1.0.0',
      category: hit.category || '',
      tags: Array.isArray(hit.tags) ? hit.tags : [],
      skill_type: 'prompt-template',
      content:
        '# ' + (hit.displayName || hit.name) + '（SkillHub 安装）\n\n' +
        '来源：SkillHub（' + (hit.namespace ? hit.namespace.canonicalName : '') + '）\n' +
        '主页：' + (hit.homepage || '') + '\n\n' +
        '用途：' + summary + '\n\n' +
        '说明：本技能由 RecallFlow 基于 SkillHub 检索元数据自动安装，内容为摘要而非上游逐字 SKILL.md。' +
        '如需完整操作指引，请访问上述主页，或在该页面复制 SKILL.md 后用「导入」功能安装。',
    };
    const saved = await addUserSkill(skill);
    return {
      result:
        '已基于 SkillHub 元数据安装技能「' + (saved.displayName || saved.name) + '」（name=' + saved.name +
        '，版本 ' + (saved.version || '1.0.0') + '）。注意：当前 SkillHub 匿名接口不支持下载逐字正文，' +
        '故内容为自动生成的摘要；可调用 load_skill("' + saved.name + '") 使用。如需完整指引请从技能主页手动导入。',
    };
  } catch (e) {
    return { ok: false, result: '安装失败：' + (e && e.message ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

export async function executeTool(name, args, ctx) {
  args = args || {};
  switch (name) {
    case 'search_knowledge_base': {
      const limit = Number(args.limit) || 5;
      const relevant = buildRagContext(ctx.book, args.query || '', limit);
      if (!relevant.length) return { result: '未检索到相关知识库条目。' };
      const citations = buildCitations(relevant, false);
      const text = relevant
        .map(
          (it, i) =>
            `[${i + 1}] 标题：${it.title}｜类型：${typeInfo(it.type).name}` +
            `${it.note ? '｜内容：' + it.note : ''}${it.url ? '｜链接：' + it.url : ''}`
        )
        .join('\n');
      return { result: '检索到的知识库条目：\n' + text, citations };
    }
    case 'list_knowledge_base': {
      let items = Object.values(ctx.book);
      if (args.type) items = items.filter((it) => it.type === args.type);
      items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const limit = Number(args.limit) || 20;
      const shown = items.slice(0, limit);
      const text = shown
        .map(
          (it, i) =>
            `[${i + 1}] 标题：${it.title}｜类型：${typeInfo(it.type).name}` +
            `${it.tags && it.tags.length ? '｜标签：' + it.tags.join('、') : ''}`
        )
        .join('\n');
      return { result: `知识库共 ${items.length} 条，以下列出 ${shown.length} 条：\n` + (text || '（空）'), citations: buildCitations(shown, true) };
    }
    case 'get_entry': {
      const it = ctx.book[args.id];
      if (!it) return { result: '未找到该条目（id: ' + args.id + '）。' };
      return {
        result:
          `标题：${it.title}\n类型：${typeInfo(it.type).name}\n` +
          `星级：${(STAR_LEVELS[it.status] || {}).name || it.status}\n` +
          `标签：${(it.tags || []).join('、') || '无'}\n备注：${it.note || '无'}\n链接：${it.url || '无'}`,
      };
    }
    case 'add_entry': {
      const id = args.url || 'kb:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
      const created = await upsertItem({
        id,
        type: args.type || 'note',
        title: args.title || '未命名',
        url: args.url || '',
        status: args.status || STATUS.IMPORTANT,
        note: args.note || '',
        tags: Array.isArray(args.tags) ? args.tags : [],
      });
      ctx.book = await getBook();
      return { result: `已保存条目：标题「${created.title}」(id: ${created.id})。`, savedId: created.id };
    }
    case 'remove_entry': {
      if (!ctx.book[args.id]) return { result: '未找到该条目，无需删除。' };
      await deleteItem(args.id);
      ctx.book = await getBook();
      return { result: '已删除条目 (id: ' + args.id + ')。' };
    }
    case 'read_current_page': {
      const tabId = ctx.tabId;
      if (!tabId) return { result: '无法定位当前标签页（可能不在前台页面）。' };
      try {
        const pageResponse = await sendTabMessage(tabId, { type: 'kbGetPageText' });
        const text = pageResponse && pageResponse.text ? pageResponse.text : '';
        if (!text) return { result: '未能读取页面正文（内容脚本未注入或页面不支持）。' };
        const chunks = splitIntoChunks(text, 600, 6);
        const result =
          chunks.length > 1
            ? '当前页面正文（分块，可引用 [n]）：\n' + chunks.map((c, i) => '[' + (i + 1) + '] ' + c).join('\n\n')
            : '当前页面正文：\n' + text;
        const citations = chunks.map((c, i) => ({
          index: i + 1,
          source: 'page',
          title: c.replace(/\s+/g, ' ').trim().slice(0, 40),
          url: ctx.pageUrl || '',
          snippet: c,
        }));
        return { result, citations };
      } catch (e) {
        return { result: '读取页面失败：' + e.message };
      }
    }
    case 'get_page_snapshot': {
      const tabId = ctx.tabId;
      if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
      try {
        const snapshot = await getPageSnapshot(tabId, args);
        if (!snapshot) return { ok: false, result: '未能读取 DOM 快照（内容脚本未注入或页面不支持）。' };
        return {
          ok: true,
          hadEffect: false,
          snapshot,
          result: '当前页面 DOM 快照：\n' + JSON.stringify(snapshot),
        };
      } catch (e) {
        return { ok: false, result: '读取 DOM 快照失败：' + e.message };
      }
    }
    case 'type_text': {
      try {
        return await executeContentAction(ctx.tabId, 'type_text', { type: 'kbTypeText', params: args }, { delayMs: 80 });
      } catch (e) {
        return { ok: false, result: '输入文本失败：' + e.message };
      }
    }
    case 'press_key': {
      try {
        return await executeContentAction(ctx.tabId, 'press_key', { type: 'kbPressKey', params: args }, { delayMs: 120 });
      } catch (e) {
        return { ok: false, result: '派发键盘事件失败：' + e.message };
      }
    }
    case 'select_option': {
      try {
        return await executeContentAction(ctx.tabId, 'select_option', { type: 'kbSelectOption', params: args }, { delayMs: 100 });
      } catch (e) {
        return { ok: false, result: '选择下拉项失败：' + e.message };
      }
    }
    case 'check_box': {
      try {
        return await executeContentAction(ctx.tabId, 'check_box', { type: 'kbCheckBox', params: args }, { delayMs: 100 });
      } catch (e) {
        return { ok: false, result: '切换复选框失败：' + e.message };
      }
    }
    case 'wait_for_element': {
      try {
        return await executeContentAction(ctx.tabId, 'wait_for_element', { type: 'kbWaitForElement', params: args }, { verify: false });
      } catch (e) {
        return { ok: false, result: '等待元素失败：' + e.message };
      }
    }
    case 'get_attribute': {
      try {
        return await executeContentAction(ctx.tabId, 'get_attribute', { type: 'kbGetAttribute', params: args }, { verify: false });
      } catch (e) {
        return { ok: false, result: '读取属性失败：' + e.message };
      }
    }
    case 'list_tabs': {
      try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const visibleTabs = tabs.filter((t) => t.url);
        const tabInfo = visibleTabs.map((t) => ({
          tabId: t.id,
          windowId: t.windowId,
          title: t.title || '',
          url: t.url || '',
          active: Boolean(t.active),
        }));
        const text = visibleTabs
          .filter((t) => t.url)
          .map((t, i) => `[${i + 1}] tabId=${t.id} ${t.active ? '（当前）' : ''} ${t.title || ''}｜${t.url}`)
          .join('\n');
        return { ok: true, tabs: tabInfo, result: '当前窗口标签页：\n' + (text || '（无）') };
      } catch (e) {
        return { ok: false, result: '列出标签页失败：' + e.message };
      }
    }
    case 'switch_tab': {
      const tabId = Number(args.tabId);
      if (!Number.isInteger(tabId) || tabId <= 0) return { ok: false, result: 'tabId 必须是有效的标签页 ID' };
      try {
        const target = await chrome.tabs.get(tabId);
        if (!target || !target.id) return { ok: false, result: '未找到标签页：' + tabId };
        await chrome.tabs.update(tabId, { active: true });
        const snapshot = await waitForTabReady(tabId, 5000);
        const current = await chrome.tabs.get(tabId).catch(() => target);
        const targetTab = {
          tabId,
          windowId: current.windowId || target.windowId,
          title: current.title || target.title || '',
          url: current.url || target.url || '',
          ready: Boolean(snapshot),
        };
        return {
          ok: true,
          targetTabId: tabId,
          targetTab,
          pageSnapshot: snapshot,
          result: '已切换到标签页 tabId=' + tabId + '：' + (target.title || target.url || '') + (snapshot ? '（页面已就绪）' : '（内容脚本尚未就绪）'),
        };
      } catch (e) {
        return { ok: false, result: '切换标签页失败：' + e.message };
      }
    }
    case 'open_tab': {
      try {
        const t = await chrome.tabs.create({ url: args.url });
        if (!t || !t.id) return { ok: false, result: '打开标签页失败：浏览器未返回 tabId' };
        const snapshot = await waitForTabReady(t.id, 8000);
        const current = await chrome.tabs.get(t.id).catch(() => t);
        const targetTab = {
          tabId: t.id,
          windowId: current.windowId || t.windowId,
          title: current.title || t.title || '',
          url: (current.url || t.url || args.url || ''),
          ready: Boolean(snapshot),
        };
        return {
          ok: true,
          targetTabId: t.id,
          targetTab,
          pageSnapshot: snapshot,
          result: '已在新标签页打开并绑定：tabId=' + t.id + ' ' + (t.url || args.url) + (snapshot ? '（页面已就绪）' : '（内容脚本尚未就绪）'),
        };
      } catch (e) {
        return { ok: false, result: '打开标签页失败：' + e.message };
      }
    }
    case 'fetch_webpage': {
      try {
        const u = String(args.url || '');
        if (!/^https?:\/\//i.test(u)) return { result: '仅支持 http/https 链接：' + u };
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
        const resp = await fetch(u, { method: 'GET', redirect: 'follow', signal: ctrl ? ctrl.signal : undefined });
        if (timer) clearTimeout(timer);
        if (!resp.ok) return { result: '抓取失败 (' + resp.status + ')：' + u };
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (ct && !/^(text\/html|text\/plain|application\/xml|application\/xhtml|\+xml)/.test(ct) && !ct.includes('json')) {
          return { result: '跳过非文本页面（' + ct + '）：' + u };
        }
        const maxBytes = 1.5 * 1024 * 1024;
        const buf = await readBounded(resp.body, maxBytes);
        const decoder = decodeBuffer(ct);
        const raw = decoder.decode(buf);
        const truncated = buf.byteLength >= maxBytes;
        const text = stripHtml(raw).slice(0, 8000);
        const finalUrl = resp.url || u;
        return {
          result: '网页正文（' + finalUrl + '）：\n' + text + (truncated ? '\n（内容过大已截断）' : ''),
          citations: [{ index: 1, source: 'web', title: finalUrl, url: finalUrl, snippet: text.slice(0, 180) }],
        };
      } catch (e) {
        return {
          result:
            '抓取网页失败：' + e.message + '（若为目标站跨域，请将其域名加入 manifest.json 的 host_permissions；或改用 MCP fetch 服务器以突破浏览器跨域限制）',
        };
      }
    }
    case 'click_element':
    case 'set_element_style':
    case 'highlight_text':
    case 'outline_element':
    case 'get_element_text':
    case 'scroll_to_element':
    case 'scroll_page':
    case 'clear_page_overlays':
      return await executePageTool(ctx.tabId, pageToolCommand(name), args, ctx);
    case 'list_userscripts': {
      const scripts = await listUserscripts();
      const text = scripts.length
        ? scripts
            .map(
              (s, i) =>
                `[${i + 1}] ${s.name} v${s.version}${s.enabled ? '' : '（已停用）'}\n` +
                `id：${s.id}\n匹配：${(s.matches || []).join('、')}\n描述：${s.description || '无'}`
            )
            .join('\n\n')
        : '尚未安装任何用户脚本。';
      return { ok: true, result: '已安装的用户脚本：\n' + text };
    }
    case 'search_userscripts': {
      const list = await searchScripts(args.query);
      return {
        ok: true,
        result: list.length
          ? 'GreasyFork 搜索结果：\n' +
            list
              .map((it, i) => `[${i + 1}] ${it.name}（安装 ${it.installs}）\n${it.description}\ncode_url：${it.codeUrl}`)
              .join('\n\n')
          : '未找到相关脚本',
      };
    }
    case 'install_userscript': {
      const usSettings = await getUserscriptSettings();
      if (!usSettings.agentCanInstall) {
        return { ok: false, result: '用户已在设置中关闭“允许 Agent 安装脚本”，请打开设置页开启后再试。' };
      }
      const r = await installFromUrl(args.url);
      return {
        ok: true,
        result:
          '已安装用户脚本：' + r.script.name + ' v' + r.script.version +
          '\n匹配：' + (r.script.matches || []).join('、') +
          (r.script.warnings && r.script.warnings.length ? '\n警告：' + r.script.warnings.join('；') : ''),
      };
    }
    case 'run_userscript': {
      const r = await runUserscriptOnTab(ctx.tabId, args.scriptId);
      return r.ok ? { ok: true, result: r.result } : { ok: false, result: r.error };
    }
    case 'complete_task': {
      const summary = String(args.summary || '任务完成。');
      const evidence = args.evidence ? String(args.evidence) : '';
      return { result: '任务已完成：' + summary + (evidence ? '\n证据：' + evidence : ''), complete: true };
    }
    case 'load_skill': {
      // 进阶版 A：按需把技能的完整使用说明返回给模型（不预先注入，省 token、由模型自选）。
      const name = String((args && args.name) || '').trim();
      if (!name) return { ok: false, result: '缺少技能 name 参数。' };
      const all = await getMergedSkills();
      const skill = all.find((s) => s.name === name || s.title === name || s.id === name);
      if (!skill) return { ok: false, result: '未找到名为「' + name + '」的技能。可用技能见系统提示中的技能目录。' };
      const parts = ['# 技能：' + (skill.title || skill.name)];
      if (skill.description) parts.push('用途：' + skill.description);
      if (Array.isArray(skill.tags) && skill.tags.length) parts.push('标签：' + skill.tags.join('、'));
      if (skill.content) parts.push(skill.content);
      return { result: parts.join('\n\n') };
    }
    case 'install_skill': {
      const identifier = String((args && (args.identifier || args.url)) || '').trim();
      if (!identifier) return { ok: false, result: '缺少技能 identifier 参数。' };
      return await installSkillFromSkillHub(identifier);
    }
    default:
      return { result: '未知工具：' + name };
  }
}

export function parseToolArgs(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return {};
  }
}

// 限制读取体积，避免大页面撑爆内存（最多 maxBytes，超出即截断并 cancel）
async function readBounded(body, maxBytes) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      total = maxBytes;
      try {
        await reader.cancel();
      } catch (e) {}
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function decodeBuffer(buf, contentType) {
  const charset = ((contentType || '').match(/charset=([\w-]+)/i) || [])[1];
  try {
    return new TextDecoder((charset || 'utf-8').trim().toLowerCase());
  } catch (e) {
    return new TextDecoder('utf-8');
  }
}

export function splitIntoChunks(text, size, max) {
  const s = String(text || '').trim();
  if (!s) return [];
  const paras = s.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return [s.slice(0, size)];

  const chunks = [];
  let buf = '';
  const push = (str) => {
    const t = str.replace(/\n+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    if (!t || chunks.length >= max) return;
    if (t.length > size * 1.5) {
      const parts = t.match(new RegExp('.{1,' + size + '}', 'g')) || [t];
      for (const pt of parts) {
        if (chunks.length >= max) break;
        chunks.push(pt.trim());
      }
    } else {
      chunks.push(t);
    }
  };

  for (const p of paras) {
    const candidate = buf ? buf + '\n\n' + p : p;
    if (buf && candidate.length > size) {
      push(buf);
      buf = p;
      if (chunks.length >= max) break;
    } else {
      buf = candidate;
    }
  }
  push(buf);
  return chunks.slice(0, max);
}

export function stripHtml(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  // 块级标签转为换行，保留段落结构
  s = s.replace(/<(br|p|div|li|tr|h[1-6]|section|article)[\s\/>]/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  // 常见 HTML 实体
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, ' ');
  s = s.replace(/[ \t]+/g, ' ').replace(/[ \r]+/g, '').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

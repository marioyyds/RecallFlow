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
import { mdToSkill } from './skill-md.js';
import * as cdp from '../backend/cdp.js';
import { rememberElement } from './site-memory.js';
import { saveMacro, listMacros, getMacro, bumpMacroHits } from './macro-store.js';
import { handleDialog, getPendingDialogs, getDownloads } from './target-manager.js';
import { getTrace, listTraces } from './trace.js';

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
      description:
        '读取当前网页的结构化 DOM 快照：URL、标题、正文摘要、可交互元素与滚动状态。视口内元素优先返回；每个元素带稳定 ref、selector 与视口坐标 center（合成点击无效时可用 click_at 按坐标点击）。页面操作前后可用它判断动作是否生效。',
      parameters: {
        type: 'object',
        properties: {
          maxElements: { type: 'integer', description: '最多返回多少个可交互元素，默认 60，最大 120' },
          maxText: { type: 'integer', description: '正文摘要最大字符数，默认 4000，最大 8000' },
          frameId: { type: 'integer', description: '只读取指定 iframe 的快照（frameId 来自 list_frames）；元素 ref 会自动带 f<frameId>: 前缀' },
          includeFrames: { type: 'boolean', description: '是否合并所有子框架（含跨域 iframe）的可交互元素，默认 false' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_frames',
      description: '列出当前页面内的所有框架（含跨域 iframe）及其 frameId / URL / 标题，用于定位需要操作的 iframe。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'undo_last_action',
      description: '撤销上一步页面操作。仅输入 / 勾选 / 选择 / 改样式 / 滚动可撤销；点击与导航不可撤销。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_macro',
      description:
        '把当前任务中已成功执行的可重放动作保存为「宏」（按当前站点），之后可用 run_macro 一键回放，无需重新逐步操作。适合用户说「记住这个流程」「以后都这么做」。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '宏名称（简短，如“登录并签到”）' },
          description: { type: 'string', description: '可选：一句话说明该流程' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_macros',
      description: '列出当前站点已保存的宏。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_macro',
      description:
        '回放当前站点已保存的宏：按保存的动作序列逐步执行，不再逐条走模型，适合重复性流程。用户要求执行某个已保存流程时使用；某步失败会停在该步并报告。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '宏名称' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trust_site',
      description:
        '把当前站点加入信任列表：该站点的写操作（点击 / 输入 / 改样式等）不再逐次确认。仅在用户明确要求「信任这个网站 / 以后别再问我」时使用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description:
        '维护当前任务的执行计划（子目标清单）。多步任务开始时先列出计划，之后每完成一步就更新状态。既让用户看到进度，也帮助你自己不跑丢目标。每次传入完整列表（整体替换，不是增量）。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '完整的计划列表',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '子目标描述（简短）' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: '状态，默认 pending' },
              },
              required: ['text'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'handle_dialog',
      description:
        '处理当前页面的 JavaScript 对话框（alert / confirm / prompt）。这类对话框会阻塞页面与后续操作；若 get_page_snapshot 提示有未处理对话框，应先调用本工具。',
      parameters: {
        type: 'object',
        properties: {
          accept: { type: 'boolean', description: 'true=确定/接受，false=取消，默认 true' },
          promptText: { type: 'string', description: 'prompt 对话框要输入的文本（可选）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_downloads',
      description: '列出本任务中页面触发的下载（文件名 + URL），用于确认下载是否成功。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_run_trace',
      description: '读取结构化运行轨迹（每步的工具、参数、状态、耗时、token），用于排障与复盘。不传 runId 时返回最近一次运行。',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string', description: '运行 id（可选）' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'expand_result',
      description: '分段读取被截断的工具结果全文（大结果只回传了开头，会给出一个 id）。用 offset/limit 翻页查看完整内容。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '工具结果 id（截断提示里给出的 id）' },
          offset: { type: 'integer', description: '起始字符偏移，默认 0' },
          limit: { type: 'integer', description: '读取长度，默认 2000，最大 4000' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_console',
      description: '读取当前页面最近的 console 输出（error/warn/log/info）与未捕获异常，用于前端调试。可选 level 过滤与 limit。',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', description: '过滤级别：error / warn / log / info；不填返回全部' },
          limit: { type: 'integer', description: '返回条数上限，默认 50，最大 200' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_network',
      description: '读取当前页面最近的网络请求（fetch / XHR：URL、方法、状态码、耗时、错误、发起位置），用于前端调试。可选 URL 子串过滤与 limit。',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: '按 URL 子串过滤' },
          limit: { type: 'integer', description: '返回条数上限，默认 50，最大 200' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_element_source',
      description:
        '把一个 DOM 元素解析到它的框架源码位置（React / Vue / Svelte 开发构建）：返回 file/line/column 与组件名。用于把页面上的元素对应到具体源码文件，供修复代码。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'DOM 快照中的元素引用，如 rf-3（优先）' },
          selector: { type: 'string', description: 'CSS 选择器（与 ref/text 二选一）' },
          text: { type: 'string', description: '元素文本片段（与 ref/selector 二选一）' },
          index: { type: 'integer', description: '命中第几个（从 0 开始），默认 0' },
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
          role: { type: 'string', description: 'ARIA role 定位（如 button/link/textbox/checkbox），配合 name 更稳（优先级：ref > role+name > testid > text > selector）' },
          name: { type: 'string', description: '可访问名（按钮文字 / 标签 / aria-label），配合 role 定位' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
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
          role: { type: 'string', description: 'ARIA role 定位（如 button/link/textbox/checkbox），配合 name 更稳（优先级：ref > role+name > testid > text > selector）' },
          name: { type: 'string', description: '可访问名（按钮文字 / 标签 / aria-label），配合 role 定位' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
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
      description: '勾选或取消 checkbox；radio 只能切换为 checked=true。可用 ref/selector 定位元素，或用 text 按关联的 label 文本定位。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'checkbox/radio 元素引用' },
          selector: { type: 'string', description: 'checkbox/radio 的 CSS 选择器' },
          text: { type: 'string', description: '关联 label 的文本片段（按文本定位，如“同意条款”）' },
          checked: { type: 'boolean', description: '目标状态' },
          role: { type: 'string', description: 'ARIA role 定位（如 button/link/textbox/checkbox），配合 name 更稳（优先级：ref > role+name > testid > text > selector）' },
          name: { type: 'string', description: '可访问名（按钮文字 / 标签 / aria-label），配合 role 定位' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
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
          role: { type: 'string', description: 'ARIA role 定位（如 button/link/textbox/checkbox），配合 name 更稳（优先级：ref > role+name > testid > text > selector）' },
          name: { type: 'string', description: '可访问名（按钮文字 / 标签 / aria-label），配合 role 定位' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_attribute',
      description: '读取页面元素的 HTML 属性，例如 disabled、aria-expanded、href、data-state。密码字段不会返回实际值。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '元素引用' },
          selector: { type: 'string', description: 'CSS 选择器' },
          text: { type: 'string', description: '要定位的文本片段（按文本定位元素）' },
          attribute: { type: 'string', description: '属性名，如 aria-expanded、href、disabled' },
          role: { type: 'string', description: 'ARIA role 定位（如 button/link/textbox/checkbox），配合 name 更稳（优先级：ref > role+name > testid > text > selector）' },
          name: { type: 'string', description: '可访问名（按钮文字 / 标签 / aria-label），配合 role 定位' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
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
      description: '打开一个 URL 并自动把后续 DOM 操作绑定到该标签页。默认会先查找并复用已打开的相同 URL 标签页（不会重复新建标签页）；仅当 newTab=true 时才强制新建。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的链接' },
          newTab: { type: 'boolean', description: '是否强制新建标签页，默认 false（优先复用已打开的同 URL 标签页，避免越开越多）' },
        },
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
      name: 'web_search',
      description: '在网络上搜索关键词并返回结果列表（标题 + 链接 + 摘要）。用于找官方文档、最新资料、正确的来源 URL 等；找到目标后再用 fetch_webpage 或 open_tab 读取内容，不要凭空猜测 URL。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          maxResults: { type: 'integer', description: '返回条数上限，默认 6，最多 10' },
        },
        required: ['query'],
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
          role: { type: 'string', description: 'ARIA role 定位（如 button/link/textbox/checkbox），配合 name 更稳（优先级：ref > role+name > testid > text > selector）' },
          name: { type: 'string', description: '可访问名（按钮文字 / 标签 / aria-label），配合 role 定位' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
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
          role: { type: 'string', description: 'ARIA role 定位（如 button/link/textbox/checkbox），配合 name 更稳（优先级：ref > role+name > testid > text > selector）' },
          name: { type: 'string', description: '可访问名（按钮文字 / 标签 / aria-label），配合 role 定位' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
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
      description:
        '高亮页面中的文本片段，不改动页面 DOM（用浮层标注）。需要高亮多处时，一次调用传 texts 数组即可，不要逐条多次调用。',
      parameters: {
        type: 'object',
        properties: {
          texts: { type: 'array', items: { type: 'string' }, description: '要高亮的多个文本片段（与 text/selector 三选一，推荐批量）' },
          text: { type: 'string', description: '要高亮的单个文本片段（与 texts/selector 三选一）' },
          selector: { type: 'string', description: '要高亮的元素选择器（与 texts/text 三选一）' },
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
          role: { type: 'string', description: 'ARIA role 定位（如 button/link/textbox/checkbox），配合 name 更稳（优先级：ref > role+name > testid > text > selector）' },
          name: { type: 'string', description: '可访问名（按钮文字 / 标签 / aria-label），配合 role 定位' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
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
          role: { type: 'string', description: 'ARIA role 定位（如 button/link/textbox/checkbox），配合 name 更稳（优先级：ref > role+name > testid > text > selector）' },
          name: { type: 'string', description: '可访问名（按钮文字 / 标签 / aria-label），配合 role 定位' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_page',
      description:
        '滚动页面，支持三种方式（优先级从高到低）：按目标定位（ref/selector/text）滚动到该处、按绝对坐标（top/left）、按偏移（y/x）。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'DOM 快照中的元素引用，如 rf-3（优先使用）' },
          selector: { type: 'string', description: 'CSS 选择器' },
          text: { type: 'string', description: '要定位的文本片段' },
          role: { type: 'string', description: 'ARIA role 定位（如 button/link/textbox/checkbox），配合 name 更稳（优先级：ref > role+name > testid > text > selector）' },
          name: { type: 'string', description: '可访问名（按钮文字 / 标签 / aria-label），配合 role 定位' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
          top: { type: 'number', description: '目标纵坐标(px)，与 left 配合按绝对坐标滚动' },
          left: { type: 'number', description: '目标横坐标(px)，与 top 配合按绝对坐标滚动' },
          y: { type: 'number', description: '纵向偏移(px)，正数向下；有 ref/selector/text/top/left 时忽略' },
          x: { type: 'number', description: '横向偏移(px)，正数向右；有 ref/selector/text/top/left 时忽略' },
          behavior: { type: 'string', enum: ['auto', 'smooth'], description: '滚动行为，默认 smooth' },
          block: { type: 'string', enum: ['start', 'center', 'end'], description: '按目标滚动时的对齐方式，默认 start' },
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
      name: 'run_javascript',
      description:
        '在目标页面执行一段 JavaScript（逃生舱）。仅当内置工具（点击/输入/滚动/读取/等待）无法表达时才使用，例如批量提取表格数据、读取页面测量值、复杂组件操作。' +
        '安全限制：代码在受限作用域中执行，只能访问页面 DOM 与常规浏览器 API，无法直接访问 chrome.*、扩展存储、fetch/XHR 等能力；' +
        '代码体最后用 return 返回结果（可为 Promise），结果会自动 JSON 序列化并截断；执行前必须得到用户批准（高风险，不支持会话级放行）。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的 JS 代码（函数体，最后用 return 返回结果）' },
          engine: {
            type: 'string',
            enum: ['sandbox', 'page'],
            description: 'sandbox（默认）：受限作用域，无 chrome.*；page：在页面主世界执行（需 CDP），可访问页面自身 JS 状态、不受页面 CSP 限制',
          },
          frameId: { type: 'integer', description: '在指定 iframe（含跨域）中执行；frameId 来自 list_frames，默认主框架' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_at',
      description:
        '按视口坐标 (x,y) 用 CDP 派发可信鼠标点击。用于合成点击无效的顽固站点，或 canvas/虚拟列表/可访问性树快照给出的坐标。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '视口横坐标(px)' },
          y: { type: 'number', description: '视口纵坐标(px)' },
          double: { type: 'boolean', description: '是否双击，默认 false' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标按键，默认 left' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hover_element',
      description: '把鼠标悬停到元素上（CDP 可信移动），用于触发 hover 才出现的菜单/提示。可用 ref/selector/text 定位。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'DOM 快照中的元素引用，如 rf-3（优先）' },
          selector: { type: 'string', description: 'CSS 选择器（与 ref/text 二选一）' },
          text: { type: 'string', description: '要定位的文本片段（与 ref/selector 二选一）' },
          role: { type: 'string', description: 'ARIA role 定位（如 button/link/textbox/checkbox），配合 name 更稳（优先级：ref > role+name > testid > text > selector）' },
          name: { type: 'string', description: '可访问名（按钮文字 / 标签 / aria-label），配合 role 定位' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个匹配（从 0 开始），默认 0' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'drag_element',
      description: '把一个元素拖拽到另一个位置（CDP 可信拖拽序列）。起点用 from*，终点用 to*（ref/selector/text 三选一）。',
      parameters: {
        type: 'object',
        properties: {
          fromRef: { type: 'string', description: '起点元素引用' },
          fromSelector: { type: 'string', description: '起点 CSS 选择器' },
          fromText: { type: 'string', description: '起点文本片段' },
          toRef: { type: 'string', description: '终点元素引用' },
          toSelector: { type: 'string', description: '终点 CSS 选择器' },
          toText: { type: 'string', description: '终点文本片段' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upload_file',
      description: '向页面 file input 设置本地文件（CDP）。files 为本地文件绝对路径数组。需用户批准。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'file input 元素引用' },
          selector: { type: 'string', description: 'file input 的 CSS 选择器' },
          text: { type: 'string', description: '关联 label 文本片段' },
          files: { type: 'array', items: { type: 'string' }, description: '本地文件绝对路径数组' },
        },
        required: ['files'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_ax_snapshot',
      description:
        '通过 CDP 读取页面的可访问性树（交互节点 role + 名称 + 视口坐标）。适合 canvas、虚拟列表、复杂组件等 DOM 文本快照看不清的场景；配合 click_at 按坐标点击。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '返回节点数上限，默认 60，最大 120' } },
      },
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
  read_console: { risk: 'read', readOnly: true, route: 'content' },
  read_network: { risk: 'read', readOnly: true, route: 'content' },
  get_element_source: { risk: 'read', readOnly: true, route: 'content' },
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
  fetch_webpage: { risk: 'network', requiresApproval: true, route: 'background', timeoutMs: 20000 },
  web_search: { risk: 'network', readOnly: true, requiresApproval: false, route: 'background', timeoutMs: 20000 },
  click_element: { risk: 'page', requiresApproval: true, route: 'content' },
  set_element_style: { risk: 'page', requiresApproval: true, route: 'content' },
  highlight_text: { risk: 'page', requiresApproval: true, route: 'content' },
  outline_element: { risk: 'page', requiresApproval: true, route: 'content' },
  get_element_text: { risk: 'read', readOnly: true, route: 'content' },
  scroll_page: { risk: 'page', requiresApproval: true, route: 'content' },
  clear_page_overlays: { risk: 'page', requiresApproval: true, route: 'content' },
  run_javascript: { risk: 'high', requiresApproval: true, alwaysRequireApproval: true, route: 'content' },
  click_at: { risk: 'page', requiresApproval: true, route: 'background' },
  hover_element: { risk: 'page', requiresApproval: true, route: 'background' },
  drag_element: { risk: 'page', requiresApproval: true, route: 'background' },
  upload_file: { risk: 'write', requiresApproval: true, route: 'background' },
  get_ax_snapshot: { risk: 'read', readOnly: true, route: 'background' },
  list_frames: { risk: 'read', readOnly: true, route: 'background' },
  undo_last_action: { risk: 'page', requiresApproval: true, route: 'content' },
  save_macro: { risk: 'write', readOnly: false, route: 'background' },
  list_macros: { risk: 'read', readOnly: true, route: 'background' },
  run_macro: { risk: 'page', requiresApproval: true, route: 'background' },
  trust_site: { risk: 'write', requiresApproval: true, route: 'background' },
  update_plan: { risk: 'read', readOnly: true, alwaysAvailable: true, route: 'background' },
  expand_result: { risk: 'read', readOnly: true, alwaysAvailable: true, route: 'background' },
  handle_dialog: { risk: 'page', requiresApproval: true, route: 'background' },
  list_downloads: { risk: 'read', readOnly: true, route: 'background' },
  get_run_trace: { risk: 'read', readOnly: true, alwaysAvailable: true, route: 'background' },
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
      alwaysRequireApproval: metadata.alwaysRequireApproval === true,
      route: metadata.route || 'background',
      timeoutMs: Number(metadata.timeoutMs) > 0 ? Number(metadata.timeoutMs) : 0,
      openai: tool,
    });
  })
);

const TOOL_BY_NAME = new Map(TOOL_REGISTRY.map((tool) => [tool.name, tool]));
export const BUILTIN_TOOLS = TOOL_REGISTRY.map((tool) => tool.openai);

export function getToolDefinition(name) {
  return TOOL_BY_NAME.get(name) || null;
}

// 已知的工具重命名（旧名 → 新名）：用于在加载自定义技能时提示用户更新依赖工具列表。
export const TOOL_RENAME_MAP = Object.freeze({ scroll_to_element: 'scroll_page' });

// 校验技能声明的依赖工具是否全部存在；返回警告列表（含旧名→新名的迁移提示）。
export function validateSkillTools(skill) {
  if (!skill) return [];
  const declared = Array.isArray(skill.tools)
    ? skill.tools
    : skill.x && Array.isArray(skill.x.tools)
      ? skill.x.tools
      : [];
  const existing = new Set(TOOL_REGISTRY.map((t) => t.name));
  const warnings = [];
  for (const tn of declared) {
    if (typeof tn !== 'string' || !tn) continue;
    if (existing.has(tn)) continue;
    const renamed = TOOL_RENAME_MAP[tn];
    warnings.push(renamed ? '「' + tn + '」已更名为「' + renamed + '」' : '「' + tn + '」不是可用工具');
  }
  return warnings;
}

export function getToolMetadata(name) {
  if (typeof name === 'string' && name.indexOf('mcp__') === 0) {
    return { risk: 'external', requiresApproval: true };
  }
  const definition = getToolDefinition(name);
  return definition
    ? {
        risk: definition.risk,
        requiresApproval: definition.requiresApproval,
        readOnly: definition.readOnly,
        route: definition.route,
        alwaysAvailable: definition.alwaysAvailable === true,
        alwaysRequireApproval: definition.alwaysRequireApproval === true,
        timeoutMs: Number(definition.timeoutMs) > 0 ? Number(definition.timeoutMs) : 0,
      }
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

// 向指定标签页（可选指定 frameId，用于跨域 iframe）发送消息。
function sendTabMessage(tabId, message, frameId) {
  return new Promise((resolve, reject) => {
    const callback = (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    };
    // 默认发往顶层框架（frameId=0）；否则无 frameId 时消息会广播到所有框架，
    // 响应可能来自子框架，导致顶层快照/命令错乱。
    const fid = Number(frameId);
    const options = { frameId: Number.isInteger(fid) && fid >= 0 ? fid : 0 };
    chrome.tabs.sendMessage(tabId, message, options, callback);
  });
}

// 跨域 iframe 的 ref 采用「f<frameId>:<localRef>」前缀，后台据此把动作路由到对应框架。
// 顶层框架的 ref 不带前缀（frameId=0 亦可显式传 frameId 参数）。
function parseRef(ref) {
  const m = String(ref || '').match(/^f(\d+):(.*)$/);
  if (m) return { frameId: Number(m[1]), ref: m[2] };
  return { frameId: null, ref: String(ref || '') };
}

function frameIdFromArgs(args) {
  if (!args) return null;
  if (args.frameId !== undefined && args.frameId !== null && args.frameId !== '' && Number.isInteger(Number(args.frameId)) && Number(args.frameId) >= 0) {
    return Number(args.frameId);
  }
  return parseRef(args.ref).frameId;
}

// 去掉 ref 的 frame 前缀，得到发给目标框架内容脚本的本地参数。
function localTargetArgs(args) {
  const out = Object.assign({}, args || {});
  const p = parseRef(out.ref);
  if (p.frameId != null) out.ref = p.ref;
  delete out.frameId;
  return out;
}

// CDP（chrome.debugger）是否可用于本次任务。
function cdpAllowed(ctx) {
  return Boolean(ctx && ctx.settings && ctx.settings.cdpEnabled !== false && cdp.isCdpAvailable());
}

// 枚举标签页内的所有框架（含跨域 iframe），返回 [{frameId, href, title, isTop}]。
async function listFramesRaw(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({ href: location.href, title: document.title || '', isTop: window.top === window }),
    });
    return (results || []).map((r) => Object.assign({ frameId: r.frameId }, r.result || {}));
  } catch (e) {
    return [];
  }
}

// 给某框架快照的元素 ref 加 f<frameId>: 前缀，使跨框架 ref 全局唯一、可路由。
function prefixFrameRefs(snapshot, frameId) {
  if (!snapshot || !Number.isInteger(Number(frameId)) || Number(frameId) === 0) return snapshot;
  const fid = Number(frameId);
  const elements = (snapshot.elements || []).map((e) => Object.assign({}, e, { ref: 'f' + fid + ':' + e.ref, frameId: fid }));
  return Object.assign({}, snapshot, { elements, frameId: fid });
}

// 解析目标元素为「唯一选择器 + 绝对视口坐标」，供 CDP 按坐标做可信输入。
async function resolveTarget(tabId, params) {
  if (!tabId) return null;
  const frameId = frameIdFromArgs(params);
  try {
    const res = await sendTabMessage(tabId, { type: 'kbResolveTarget', params: localTargetArgs(params) }, frameId);
    return res && res.found && res.rect ? res : null;
  } catch (e) {
    return null;
  }
}

function summarizeCdpError(e) {
  const msg = e && e.message ? e.message : String(e);
  return msg.replace(/^[A-Za-z.]+：/, '');
}

// 结构化工具错误：统一带 code，便于调用方（与 trace）按类型处理。
function toolError(code, message, extra) {
  return Object.assign({ ok: false, code, result: message }, extra || {});
}

// 把成功定位的元素记入站点记忆（供后续任务直接复用选择器）。
function rememberTarget(ctx, target) {
  if (!ctx || !ctx.settings || ctx.settings.siteMemoryEnabled === false) return;
  if (!target || !target.selector) return;
  rememberElement(ctx.pageUrl, target).catch(() => {});
}

// 可重放的动作（会进入宏轨迹）；用响应里的稳定 selector 替代易失的 ref。
const REPLAYABLE_TOOLS = new Set([
  'click_element', 'type_text', 'press_key', 'select_option', 'check_box',
  'scroll_page', 'wait_for_element', 'open_tab',
]);

export function recordTraceStep(ctx, name, args, res) {
  if (!ctx || !Array.isArray(ctx.trace)) return;
  if (!REPLAYABLE_TOOLS.has(name)) return;
  if (!res || res.ok === false) return;
  const a = args || {};
  let step = null;
  if (name === 'open_tab') {
    if (a.url) step = { tool: name, args: Object.assign({ url: a.url }, a.newTab ? { newTab: true } : {}) };
  } else {
    const selector = res.selector;
    if (!selector) return;
    if (name === 'type_text') step = { tool: name, args: Object.assign({ selector, text: a.text }, a.clearFirst ? { clearFirst: true } : {}) };
    else if (name === 'click_element') step = { tool: name, args: { selector } };
    else if (name === 'press_key') step = { tool: name, args: Object.assign({ selector, key: a.key }, a.modifiers ? { modifiers: a.modifiers } : {}) };
    else if (name === 'check_box') step = { tool: name, args: { selector, checked: a.checked } };
    else if (name === 'select_option') {
      const sa = { selector };
      if (a.value !== undefined) sa.value = a.value;
      if (a.label !== undefined) sa.label = a.label;
      if (a.index !== undefined) sa.index = a.index;
      step = { tool: name, args: sa };
    } else if (name === 'scroll_page') step = { tool: name, args: { selector } };
    else if (name === 'wait_for_element') step = { tool: name, args: Object.assign({ selector, state: a.state || 'visible' }, a.text ? { text: a.text } : {}) };
  }
  if (step) ctx.trace.push(step);
}

// 记录 Agent 本次任务新打开/接管过的标签页，供任务结束后清理（保留最后使用的 tab）。
function trackOpenedTab(ctx, tabId) {
  if (!ctx || !Number.isInteger(Number(tabId))) return;
  if (!Array.isArray(ctx.openedTabs)) ctx.openedTabs = [];
  if (!ctx.openedTabs.includes(tabId)) ctx.openedTabs.push(tabId);
}

// 隔离浏览：研究/知识库/对话类任务在专用 Agent 窗口（最小化）里打开标签页，
// 与用户主窗口完全隔离，不抢焦点、不弄乱用户标签。首次打开时创建一次并复用。
async function ensureAgentWindow(ctx) {
  if (Number.isInteger(ctx.agentWindowId)) {
    try {
      await chrome.windows.get(ctx.agentWindowId);
      return ctx.agentWindowId;
    } catch (e) {
      ctx.agentWindowId = null;
    }
  }
  const win = await chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false });
  ctx.agentWindowId = win.id;
  return win.id;
}

// 任务结束时关闭 Agent 隔离窗口。
export async function closeAgentWindow(ctx) {
  if (ctx && Number.isInteger(ctx.agentWindowId)) {
    try {
      await chrome.windows.remove(ctx.agentWindowId);
    } catch (e) {}
    ctx.agentWindowId = null;
  }
}

// 生成本任务已打开标签页的摘要（tabId + 标题 + URL），供预算触顶时引导模型复用。
async function listOpenedTabsSummary(ctx) {
  const ids = (Array.isArray(ctx.openedTabs) ? ctx.openedTabs : []).filter((id) => Number.isInteger(Number(id)));
  if (!ids.length) return '';
  const lines = [];
  for (const id of ids) {
    const t = await chrome.tabs.get(id).catch(() => null);
    if (t && t.id && t.url) lines.push('tabId=' + t.id + ' ' + (t.title || '') + '｜' + t.url);
  }
  return lines.join('\n');
}

// 记录 Agent 当前绑定的标签页（仅本任务上下文内使用，不做跨 tab 会话同步）。
async function bindSessionTab(tabId) {
  if (!Number.isInteger(Number(tabId))) return;
  try {
    await chrome.storage.local.set({ kbSessionTab: { tabId: Number(tabId), ts: Date.now() } });
  } catch (e) {}
}

async function getPageSnapshot(tabId, options = {}) {
  if (!tabId) return null;
  const snapshot = await sendTabMessage(tabId, { type: 'kbGetPageSnapshot', options }, options.frameId);
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
export function compactSnapshotSummary(snapshot) {
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
  if (!tabId) return toolError('NO_TARGET', '无法定位当前标签页（可能不在前台页面）。');
  const frameId = options.frameId != null ? options.frameId : frameIdFromArgs(message && message.params);
  const msg = Object.assign({}, message, { params: localTargetArgs(message && message.params) });
  const shouldVerify = options.verify !== false;
  const before = shouldVerify ? await getPageSnapshot(tabId, { maxElements: 50, maxText: 1600, frameId }).catch(() => null) : null;
  const response = await sendTabMessage(tabId, msg, frameId);
  if (!response) return toolError('PAGE_UNREACHABLE', '页面内容脚本无响应或尚未注入。');
  if (response.ok === false) return toolError('PAGE_ACTION_FAILED', response.error || response.result || ('页面动作失败：' + action));
  if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  let after = shouldVerify ? await getPageSnapshot(tabId, { maxElements: 50, maxText: 1600, frameId }).catch(() => null) : null;
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
  if (!tabId) return toolError('NO_TARGET', '无法定位当前标签页（可能不在前台页面）。');
  try {
    const frameId = frameIdFromArgs(args);
    const localArgs = localTargetArgs(args);
    const shouldVerify = ['click', 'scroll_to', 'scroll_by', 'set_style'].includes(command);
    // 点击前记录现有标签页，点击后用于检测 target="_blank" 新建的标签页并自动绑定。
    const beforeTabs = command === 'click' ? await chrome.tabs.query({ currentWindow: true }).catch(() => null) : null;
    const before = shouldVerify ? await getPageSnapshot(tabId, { maxElements: 40, maxText: 1200, frameId }).catch(() => null) : null;
    const res = await sendTabMessage(tabId, { type: 'kbPageCommand', command, params: localArgs }, frameId);
    if (!res) return toolError('PAGE_UNREACHABLE', '页面命令无响应（内容脚本未注入或页面不支持）。');
    if (res.ok === false) return toolError('PAGE_COMMAND_FAILED', '页面命令「' + command + '」失败：' + (res.error || '未知错误'));
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
            ctx.openedTabCount = Number(ctx.openedTabCount || 0) + 1;
            trackOpenedTab(ctx, newTab.id);
            // 新标签页接管后，同步该页的弹窗开关状态，避免对话窗口“消失”或状态不一致。
            bindSessionTab(newTab.id);
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
        const snap = await getPageSnapshot(tabId, { maxElements: 40, maxText: 1200, frameId }).catch(() => null);
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
      after = await getPageSnapshot(tabId, { maxElements: 40, maxText: 1200, frameId }).catch(() => null);
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
// 注意：SkillHub 公开接口中 /api/v1/search 仅做检索；逐字 SKILL.md 正文走 /api/v1/skills/{slug}/file?path=SKILL.md&namespace={ns}
// （匿名可 200/302 拿到正文），但部分技能（团队命名空间需鉴权或接口波动）可能取不到，此时降级为基于元数据的生成式安装。
// 优先拉取 SkillHub 上的真实 SKILL.md 正文；不可用时降级为基于元数据的生成式安装。
async function fetchRealSkillMd(apiBase, slug, ns, signal) {
  try {
    const fileUrl =
      apiBase + '/skills/' + encodeURIComponent(slug) + '/file?path=SKILL.md' + (ns ? '&namespace=' + encodeURIComponent(ns) : '');
    const fileResp = await fetch(fileUrl, { headers: { Accept: 'text/plain, */*' }, signal });
    if (!fileResp.ok) return null;
    const rawMd = await fileResp.text();
    if (!rawMd || !rawMd.trim()) return null;
    if (!/^---\s*\r?\n/.test(rawMd) && !/^\s*name\s*:/.test(rawMd)) return null;
    const parsed = mdToSkill(rawMd);
    if (!parsed || !parsed.name) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

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
    if (!ns && hit.namespace && hit.namespace.handle) ns = hit.namespace.handle;
    const existing = await getUserSkills();
    const alreadyInstalled = existing.some((s) => s.name === name);
    // 优先拉取 SkillHub 上的真实 SKILL.md 正文；失败则降级为基于元数据的生成式安装。
    let skill = await fetchRealSkillMd(apiBase, name, ns, ctrl.signal);
    let generative = false;
    if (!skill) {
      generative = true;
      const summary = (hit.summary || hit.description || hit.description_zh || '').toString();
      const description = (hit.description_zh || hit.description || summary || '').toString().slice(0, 300);
      skill = {
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
    } else {
      // 用检索元数据补全 SKILL.md 中可能缺失的展示字段
      skill.displayName = skill.displayName || hit.displayName || hit.name;
      if (!skill.category) skill.category = hit.category || '';
      if (!skill.tags || !skill.tags.length) skill.tags = Array.isArray(hit.tags) ? hit.tags : [];
      if (!skill.description) skill.description = (hit.description_zh || hit.description || hit.summary || '').toString();
      skill.version = skill.version || hit.version || '1.0.0';
      skill.name = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name || '') ? skill.name : name;
    }
    const saved = alreadyInstalled ? (await updateUserSkill(name, skill)) || (await addUserSkill(skill)) : await addUserSkill(skill);
    const prefix = alreadyInstalled ? '已重新安装（更新）技能' : '已安装技能';
    if (generative) {
      return {
        result:
          prefix + '「' + (saved.displayName || saved.name) + '」（name=' + saved.name +
          '，版本 ' + (saved.version || '1.0.0') + '）。注意：SkillHub 未返回逐字正文，内容为自动生成的摘要；' +
          '可调用 load_skill("' + saved.name + '") 使用，或到技能主页用「导入」获取完整版。',
      };
    }
    return {
      result:
        prefix + '「' + (saved.displayName || saved.name) + '」的完整正文（name=' + saved.name +
        '，版本 ' + (saved.version || '1.0.0') + '，来自 SkillHub 原文）。可调用 load_skill("' + saved.name + '") 使用。',
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
        // 带上标题与 URL，让模型一眼看到“Page Not Found / 404”等状态，避免继续猜路径。
        const head = '页面标题：' + (pageResponse.title || '') + '\n页面URL：' + (pageResponse.url || ctx.pageUrl || '') + '\n\n';
        const chunks = splitIntoChunks(text, 1200, 8);
        // 正文不再带 [n] 分块编号（避免与全局参考来源编号冲突）；来源编号由 Agent 层
        // 在登记引用后统一追加「参考来源 [X]」锚点，模型据此引用即可保证链接正确。
        const result = head + '当前页面正文：\n' + (chunks.length > 1 ? chunks.join('\n\n') : text);
        // 404 / 无内容页面不作为参考来源登记，避免模型真正引用的内容被推到高序号。
        const is404 = /(404|page not found|not found|页面不存在|无法访问)/i.test(String(pageResponse.title || ''));
        const citations = is404
          ? []
          : chunks.map((c, i) => ({
              index: i + 1,
              source: 'page',
              title: (pageResponse.title || c.replace(/\s+/g, ' ').trim().slice(0, 40)),
              url: pageResponse.url || ctx.pageUrl || '',
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
      // 页面被 JS 对话框阻塞时，快照读不到有效内容，先提示处理对话框。
      if (cdpAllowed(ctx)) {
        const dialogs = getPendingDialogs(tabId);
        if (dialogs.length) {
          return {
            ok: true,
            hadEffect: false,
            snapshot: null,
            result:
              '⚠ 页面存在未处理的对话框：' + dialogs.map((d) => d.type + '：' + d.message).join('；') +
              '\n请先调用 handle_dialog 处理（accept=true 确定 / false 取消），否则页面被阻塞。',
          };
        }
      }
      try {
        const explicitFrame = args.frameId !== undefined && args.frameId !== null && args.frameId !== '';
        // 指定 frameId：只读该框架（跨域 iframe 内容也能读，内容脚本已注入所有框架）。
        if (explicitFrame) {
          const fid = Number(args.frameId);
          const snapshot = await getPageSnapshot(tabId, { maxElements: args.maxElements, maxText: args.maxText, frameId: fid });
          if (!snapshot) return { ok: false, result: '未能读取该框架的 DOM 快照（frameId=' + fid + '，可能无内容脚本）。' };
          const tagged = prefixFrameRefs(snapshot, fid);
          return { ok: true, hadEffect: false, snapshot: tagged, result: '框架 ' + fid + ' 的 DOM 快照：\n' + JSON.stringify(tagged) };
        }
        const snapshot = await getPageSnapshot(tabId, args);
        if (!snapshot) return { ok: false, result: '未能读取 DOM 快照（内容脚本未注入或页面不支持）。' };
        // includeFrames：合并所有子框架（含跨域 iframe）的可交互元素，ref 带 f<frameId>: 前缀。
        if (args.includeFrames === true) {
          const maxElements = Math.min(150, Math.max(1, Number(args.maxElements) || 60));
          let elements = (snapshot.elements || []).slice();
          const frames = await listFramesRaw(tabId);
          const childFrames = frames.filter((f) => Number(f.frameId) !== 0);
          for (const f of childFrames) {
            if (elements.length >= maxElements) break;
            const s = await getPageSnapshot(tabId, { maxElements: Math.max(1, maxElements - elements.length), maxText: 0, frameId: f.frameId }).catch(() => null);
            if (s && Array.isArray(s.elements) && s.elements.length) {
              elements = elements.concat(prefixFrameRefs(s, f.frameId).elements);
            }
          }
          const merged = Object.assign({}, snapshot, {
            elements: elements.slice(0, maxElements),
            frames: frames.map((f) => ({ frameId: f.frameId, url: f.href, title: f.title, isTop: !!f.isTop })),
          });
          return {
            ok: true,
            hadEffect: false,
            snapshot: merged,
            result:
              '当前页面 DOM 快照（已合并 ' + childFrames.length + ' 个子框架）：\n' + JSON.stringify(merged) +
              '\n提示：带 f<frameId>: 前缀的 ref 属于对应 iframe，动作时直接原样传回 ref 即可。',
          };
        }
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
    case 'list_frames': {
      const tabId = ctx.tabId;
      if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
      const frames = await listFramesRaw(tabId);
      if (!frames.length) return { ok: false, result: '未获取到页面框架信息（可能无内容脚本权限）。' };
      const text = frames
        .map((f) => (f.isTop ? '[顶层 frameId=0] ' : '[frameId=' + f.frameId + '] ') + (f.title || '') + '｜' + f.href)
        .join('\n');
      return {
        ok: true,
        frames,
        result:
          '页面框架（含跨域 iframe，共 ' + frames.length + ' 个）：\n' + text +
          '\n用法：用 get_page_snapshot 的 frameId 参数读取某框架；或在 get_page_snapshot 里传 includeFrames:true 一次性合并所有框架的元素（ref 会自动带 f<frameId>: 前缀）。',
      };
    }
    case 'read_console': {
      const tabId = ctx.tabId;
      if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
      try {
        const res = await sendTabMessage(tabId, { type: 'kbGetConsole' });
        let entries = (res && res.entries) || [];
        if (args.level) entries = entries.filter((e) => e.level === args.level);
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
        entries = entries.slice(-limit);
        if (!entries.length) return { ok: true, result: '暂无 console 记录。' };
        const text = entries.map((e) => '[' + e.level + '] ' + e.text + (e.stack ? '\n' + e.stack : '')).join('\n');
        return { ok: true, result: '最近 console 记录（' + entries.length + ' 条）：\n' + text };
      } catch (e) {
        return { ok: false, result: '读取 console 失败：' + e.message };
      }
    }
    case 'read_network': {
      const tabId = ctx.tabId;
      if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
      try {
        const res = await sendTabMessage(tabId, { type: 'kbGetNetwork' });
        let entries = (res && res.entries) || [];
        if (args.filter) {
          const f = String(args.filter);
          entries = entries.filter((e) => String(e.url || '').includes(f));
        }
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
        entries = entries.slice(-limit);
        if (!entries.length) return { ok: true, result: '暂无网络请求记录。' };
        const text = entries
          .map((e) => {
            const head = (e.method || 'GET') + ' ' + (e.error ? 'ERR' : (e.status || '')) + ' ' + e.url + (e.ms != null ? ' (' + e.ms + 'ms)' : '') + (e.error ? ' — ' + e.error : '');
            const init = e.initiator ? e.initiator.split('\n').slice(0, 2).join(' ') : '';
            return head + (init ? '\n  发起于: ' + init : '');
          })
          .join('\n');
        return { ok: true, result: '最近网络请求（' + entries.length + ' 条）：\n' + text };
      } catch (e) {
        return { ok: false, result: '读取网络请求失败：' + e.message };
      }
    }
    case 'get_element_source': {
      const tabId = ctx.tabId;
      if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
      try {
        const res = await sendTabMessage(tabId, { type: 'kbGetElementSource', params: args });
        if (!res || !res.found) return { ok: false, result: (res && res.reason) || '未找到元素或框架源码信息。' };
        const s = res.source || {};
        const loc = String(s.file || '') + (s.line ? ':' + s.line + (s.column ? ':' + s.column : '') : '');
        const extra = (s.framework ? '（' + s.framework + (s.component ? ' · ' + s.component : '') + '）' : '');
        return { ok: true, result: '元素源码位置：' + loc + extra + (res.selector ? '\n选择器：' + res.selector : '') };
      } catch (e) {
        return { ok: false, result: '解析元素源码失败：' + e.message };
      }
    }
    case 'type_text': {
      let res;
      try {
        res = await executeContentAction(ctx.tabId, 'type_text', { type: 'kbTypeText', params: args }, { delayMs: 80 });
      } catch (e) {
        res = { ok: false, result: '输入文本失败：' + e.message };
      }
      if (res && res.ok !== false) return res;
      // 合成输入失败 → 用 CDP 可信输入兜底（对受控组件/富文本编辑器更可靠）。
      // 子框架用 evaluateInFrame 聚焦该框架内的元素，insertText 会作用于当前焦点。
      const typeFrame = frameIdFromArgs(args);
      if (!cdpAllowed(ctx)) return res;
      const target = await resolveTarget(ctx.tabId, args);
      if (!target) return res;
      const isSubframe = typeFrame != null && typeFrame !== 0;
      try {
        const sel = JSON.stringify(target.selector);
        const focusExpr =
          '(() => { const el = document.querySelector(' + sel + '); if (!el) return false; el.focus();' +
          ' if (typeof el.setSelectionRange === "function" && typeof el.value === "string") el.setSelectionRange(el.value.length, el.value.length); return true; })()';
        if (isSubframe) await cdp.evaluateInFrame(ctx.tabId, typeFrame, focusExpr);
        else await cdp.evaluate(ctx.tabId, focusExpr);
        if (args.clearFirst === true) await cdp.pressKey(ctx.tabId, 'a', ['CTRL']);
        await cdp.insertText(ctx.tabId, String(args.text == null ? '' : args.text));
        rememberTarget(ctx, target);
        const after = await getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1000, frameId: isSubframe ? typeFrame : undefined }).catch(() => null);
        return {
          ok: true,
          hadEffect: true,
          cdp: true,
          pageSnapshot: after,
          verification: { executed: true, verified: true, changed: true, reason: '已用 CDP 可信输入' },
          result: '已用 CDP 可信输入 ' + String(args.text || '').length + ' 个字符' + (after ? '\n' + compactSnapshotSummary(after) : ''),
        };
      } catch (e) {
        return res || { ok: false, result: 'CDP 输入失败：' + summarizeCdpError(e) };
      }
    }
    case 'press_key': {
      let res;
      try {
        res = await executeContentAction(ctx.tabId, 'press_key', { type: 'kbPressKey', params: args }, { delayMs: 120 });
      } catch (e) {
        res = { ok: false, result: '派发键盘事件失败：' + e.message };
      }
      if (res && res.ok !== false) return res;
      if (!cdpAllowed(ctx)) return res;
      try {
        await cdp.pressKey(ctx.tabId, String(args.key || ''), args.modifiers);
        const after = await getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1000 }).catch(() => null);
        return {
          ok: true,
          hadEffect: true,
          cdp: true,
          pageSnapshot: after,
          verification: { executed: true, verified: true, changed: true, reason: '已用 CDP 派发按键' },
          result: '已用 CDP 派发按键：' + args.key + (after ? '\n' + compactSnapshotSummary(after) : ''),
        };
      } catch (e) {
        return res || { ok: false, result: 'CDP 按键失败：' + summarizeCdpError(e) };
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
        // 同步该标签页的弹窗开关状态，跟随 Agent 当前绑定 tab。
        bindSessionTab(tabId);
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
        const url = String(args.url || '');
        if (!/^https?:\/\//i.test(url)) return { ok: false, result: 'open_tab 仅支持 http/https 链接：' + url };
        const forceNew = args.newTab === true;
        // 隔离模式（研究/知识库/对话）：不激活标签、不抢用户前台视图，静默复用/读取。
        const isolated = ctx.browsingMode === 'isolated';
        // 默认复用已打开的同 URL 标签页（去重，避免 tab 越开越多）。
        if (!forceNew) {
          const existing = await chrome.tabs.query({ url }).catch(() => []);
          const hit = Array.isArray(existing) && existing.find((t) => t.id && /^https?:/i.test(t.url || ''));
          if (hit) {
            if (!isolated) await chrome.tabs.update(hit.id, { active: true });
            const snapshot = await waitForTabReady(hit.id, 5000);
            const current = await chrome.tabs.get(hit.id).catch(() => hit);
            const targetTab = {
              tabId: hit.id,
              windowId: current.windowId || hit.windowId,
              title: current.title || hit.title || '',
              url: current.url || hit.url || url,
              ready: Boolean(snapshot),
            };
            bindSessionTab(hit.id);
            return {
              ok: true,
              reused: true,
              targetTabId: hit.id,
              targetTab,
              pageSnapshot: snapshot,
              result: '已复用已打开的标签页 tabId=' + hit.id + '：' + targetTab.url + (snapshot ? '（页面已就绪）' : '（内容脚本尚未就绪）'),
            };
          }
        }
        // 标签页预算：按「累计新建数」限制（而非当前存活数，避免中途清理导致反复重开）。
        // 达到上限时软拒绝：给出已打开标签页清单，引导模型复用/抓取，而不是硬失败后反复重试。
        const openedCount = Number(ctx.openedTabCount || 0);
        if (openedCount >= Number(ctx.maxOpenedTabs || 5)) {
          const summary = await listOpenedTabsSummary(ctx).catch(() => '');
          return {
            ok: false,
            blocked: true,
            result:
              '本任务已新建 ' + openedCount + ' 个标签页，达到上限（' + (ctx.maxOpenedTabs || 5) + '），禁止继续新建。' +
              (summary ? '\n当前已打开的标签页：\n' + summary : '') +
              '请改用 switch_tab 复用上面的标签页（tabId），或改用 fetch_webpage 直接抓取内容；不要再调用 open_tab。',
          };
        }
        const t = isolated
          ? await chrome.tabs.create({ url, windowId: await ensureAgentWindow(ctx), active: false })
          : await chrome.tabs.create({ url });
        if (!t || !t.id) return { ok: false, result: '打开标签页失败：浏览器未返回 tabId' };
        ctx.openedTabCount = openedCount + 1;
        trackOpenedTab(ctx, t.id);
        const snapshot = await waitForTabReady(t.id, 8000);
        bindSessionTab(t.id);
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
      // 失败要如实上报 ok:false（触发失败摘除机制，避免反复重试空耗预算）；
      // 失败 URL 记入 ctx.failedUrls，同一 URL 重试时直接拒绝。
      ctx.failedUrls = Array.isArray(ctx.failedUrls) ? ctx.failedUrls : [];
      const u = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(u)) return { ok: false, result: '仅支持 http/https 链接：' + u };
      const norm = u.replace(/\/+$/, '');
      if (ctx.failedUrls.includes(norm)) {
        return {
          ok: false,
          result:
            '该 URL 此前已抓取失败（' + u + '），请勿重试。请改用 open_tab 打开该页读取渲染后内容，或换用其它来源；' +
            '若无法打开，直接基于已有信息总结并结束，不要继续猜测 URL。',
        };
      }
      try {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
        const resp = await fetch(u, { method: 'GET', redirect: 'follow', signal: ctrl ? ctrl.signal : undefined });
        if (timer) clearTimeout(timer);
        if (!resp.ok) {
          ctx.failedUrls.push(norm);
          return { ok: false, result: '抓取失败 (' + resp.status + ')：' + u + '。请改用 open_tab 打开该页，或换用其它来源；不要反复重试该 URL。' };
        }
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (ct && !/^(text\/html|text\/plain|application\/xml|application\/xhtml|\+xml)/.test(ct) && !ct.includes('json')) {
          ctx.failedUrls.push(norm);
          return { ok: false, result: '该地址返回非文本内容（' + ct + '）：' + u + '。若需该资源请改用 open_tab 查看，否则换用其它来源。' };
        }
        const maxBytes = 1.5 * 1024 * 1024;
        const buf = await readBounded(resp.body, maxBytes);
        const decoder = decodeBuffer(ct);
        const raw = decoder.decode(buf);
        const truncated = buf.byteLength >= maxBytes;
        const fullText = stripHtml(raw);
        const trimmedText = fullText.trim();
        if (!trimmedText) {
          ctx.failedUrls.push(norm);
          return { ok: false, result: '该页面正文为空（' + u + '）。请改用 open_tab 打开读取渲染后内容，或换用其它来源。' };
        }
        // 检测「前端 JS 渲染（SPA）」：正文提取过少且源码里以脚本壳为主 → 引导改用 open_tab 读取渲染后内容。
        const likelySpa = trimmedText.length < 150 && /<script[\s>]/i.test(raw);
        const text = fullText.slice(0, 8000);
        const finalUrl = resp.url || u;
        // 只有拿到「实质性正文」才登记为参考来源；SPA 骨架/过短内容不产生引用，
        // 避免没用的抓取占掉来源编号（导致模型真正引用的内容从 [3] 之类的高序号开始）。
        const usable = !likelySpa && trimmedText.length >= 200;
        return {
          result:
            '网页正文（' + finalUrl + '）：\n' + text +
            (truncated ? '\n（内容过大已截断）' : '') +
            (likelySpa
              ? '\n\n⚠ 页面正文提取过少，疑似前端 JS 渲染（SPA）页面，源码里只有脚本壳。' +
                '请改用 open_tab 打开该页，再用 get_page_snapshot / read_current_page 读取渲染后的真实内容；' +
                '禁止继续用 fetch_webpage 猜测其它 URL。若无法打开，请直接基于已有信息总结并结束。'
              : '') +
            (!usable ? '\n（该次抓取内容不足以作为参考来源，不作为来源编号登记。）' : ''),
          ...(usable
            ? { citations: [{ index: 1, source: 'web', title: finalUrl, url: finalUrl, snippet: text.slice(0, 180) }] }
            : {}),
        };
      } catch (e) {
        ctx.failedUrls.push(norm);
        return {
          ok: false,
          result:
            '抓取网页失败：' + e.message + '。请改用 open_tab 打开读取，或换用其它来源；不要反复重试该 URL。' +
            '（若为目标站跨域，请将其域名加入 manifest.json 的 host_permissions；或改用 MCP fetch 服务器以突破浏览器跨域限制）',
        };
      }
    }
    case 'web_search': {
      const q = String(args.query || '').trim();
      if (!q) return { ok: false, result: '请提供搜索关键词 query。' };
      const maxResults = Math.min(10, Math.max(1, Number(args.maxResults) || 6));
      try {
        const results = await searchWeb(q, maxResults);
        if (!results.length) return { ok: false, result: '未搜索到结果，可尝试换关键词，或 open_tab 打开已知站点。' };
        const lines = results.map(
          (r, i) => '[' + (i + 1) + '] ' + r.title + '\n    链接：' + r.url + (r.snippet ? '\n    摘要：' + r.snippet : '')
        );
        // 搜索结果只是「候选入口」，不作为可点击的参考来源（避免来源区被搜索快照刷屏、
        // 也避免占用全局引用编号）。真正被 fetch / read 过的页面才会进入参考来源。
        return {
          result:
            '搜索结果（' + q + '）：\n' + lines.join('\n\n') +
            '\n\n（以上为搜索结果候选，不属于参考来源；如需引用请先 open_tab / fetch_webpage 读取目标页面，读取后的页面会登记为参考来源编号。）',
        };
      } catch (e) {
        return { ok: false, result: '网络搜索失败：' + e.message };
      }
    }
    case 'click_element': {
      const contentRes = await executePageTool(ctx.tabId, 'click', args, ctx);
      const target = await resolveTarget(ctx.tabId, args);
      if (target && contentRes && contentRes.ok !== false) rememberTarget(ctx, target);
      // 合成点击失败（未找到/不可操作）时，用 CDP 可信点击兜底；
      // 成功但无观察变化时不自动重试，避免对已生效的动作二次触发（可用 click_at 强制）。
      // 子框架（frameId≠0）需把框架内坐标换算为顶层坐标（resolveFrameClickPoint），
      // 换算不可靠时退回内容脚本结果，绝不在错误坐标上点击。
      const clickFrame = frameIdFromArgs(args);
      if (!contentRes || contentRes.ok !== false || !cdpAllowed(ctx) || !target) return contentRes;
      try {
        let point = { x: target.rect.centerX, y: target.rect.centerY };
        if (clickFrame != null && clickFrame !== 0) {
          const resolved = await cdp.resolveFrameClickPoint(ctx.tabId, clickFrame, target.selector, point).catch(() => null);
          if (!resolved) return contentRes;
          point = resolved;
        }
        await cdp.clickAt(ctx.tabId, point.x, point.y);
        const after = await getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200, frameId: clickFrame != null && clickFrame !== 0 ? clickFrame : undefined }).catch(() => null);
        return {
          ok: true,
          hadEffect: true,
          cdp: true,
          pageSnapshot: after,
          verification: { executed: true, verified: true, changed: true, reason: '已用 CDP 派发可信点击' },
          result:
            '内容脚本点击失败（' + String(contentRes.result || '').replace(/\s+/g, ' ').slice(0, 80) + '），已改用 CDP 可信点击（坐标 ' +
            Math.round(point.x) + ',' + Math.round(point.y) + '）' +
            (after ? '\n' + compactSnapshotSummary(after) : ''),
        };
      } catch (e) {
        return contentRes;
      }
    }
    case 'click_at': {
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, result: 'click_at 需要数值坐标 x、y。' };
      if (!cdpAllowed(ctx)) return { ok: false, result: 'click_at 需要 CDP 输入层（请在设置中开启「浏览器级输入」，且需 Chromium 内核浏览器）。' };
      try {
        await cdp.clickAt(ctx.tabId, x, y, { button: args.button || 'left', clickCount: args.double ? 2 : 1 });
        const after = await getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
        return {
          ok: true,
          hadEffect: true,
          cdp: true,
          pageSnapshot: after,
          verification: { executed: true, verified: true, changed: true, reason: 'CDP 坐标点击已派发' },
          result: '已在坐标 (' + x + ',' + y + ') 点击' + (after ? '\n' + compactSnapshotSummary(after) : ''),
        };
      } catch (e) {
        return { ok: false, result: 'CDP 点击失败：' + summarizeCdpError(e) };
      }
    }
    case 'hover_element': {
      if (!cdpAllowed(ctx)) return { ok: false, result: '悬停需要 CDP 输入层（请在设置中开启）。' };
      const target = await resolveTarget(ctx.tabId, args);
      if (!target) return { ok: false, result: '未找到目标元素。' };
      try {
        await cdp.moveTo(ctx.tabId, target.rect.centerX, target.rect.centerY);
        rememberTarget(ctx, target);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const after = await getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
        return {
          ok: true,
          hadEffect: true,
          cdp: true,
          pageSnapshot: after,
          verification: { executed: true, verified: true, changed: true, reason: 'CDP 悬停已派发' },
          result: '已悬停到元素（坐标 ' + target.rect.centerX + ',' + target.rect.centerY + '）' + (after ? '\n' + compactSnapshotSummary(after) : ''),
        };
      } catch (e) {
        return { ok: false, result: '悬停失败：' + summarizeCdpError(e) };
      }
    }
    case 'drag_element': {
      if (!cdpAllowed(ctx)) return { ok: false, result: '拖拽需要 CDP 输入层（请在设置中开启）。' };
      const from = await resolveTarget(ctx.tabId, { ref: args.fromRef, selector: args.fromSelector, text: args.fromText });
      const to = await resolveTarget(ctx.tabId, { ref: args.toRef, selector: args.toSelector, text: args.toText });
      if (!from || !to) return { ok: false, result: '拖拽需要能同时定位起点与终点（fromRef/fromSelector/fromText 与 toRef/toSelector/toText）。' };
      try {
        await cdp.drag(ctx.tabId, from.rect.centerX, from.rect.centerY, to.rect.centerX, to.rect.centerY);
        const after = await getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
        return {
          ok: true,
          hadEffect: true,
          cdp: true,
          pageSnapshot: after,
          verification: { executed: true, verified: true, changed: true, reason: 'CDP 拖拽已派发' },
          result: '已从 (' + from.rect.centerX + ',' + from.rect.centerY + ') 拖拽到 (' + to.rect.centerX + ',' + to.rect.centerY + ')' + (after ? '\n' + compactSnapshotSummary(after) : ''),
        };
      } catch (e) {
        return { ok: false, result: '拖拽失败：' + summarizeCdpError(e) };
      }
    }
    case 'upload_file': {
      if (!cdpAllowed(ctx)) return { ok: false, result: '文件上传需要 CDP（请在设置中开启）。' };
      const files = Array.isArray(args.files) ? args.files.filter(Boolean) : args.files ? [args.files] : [];
      if (!files.length) return { ok: false, result: 'upload_file 需要 files（本地文件的绝对路径数组）。' };
      const target = await resolveTarget(ctx.tabId, args);
      if (!target) return { ok: false, result: '未找到 file input 元素。' };
      try {
        await cdp.uploadFile(ctx.tabId, target.selector, files);
        return { ok: true, hadEffect: true, cdp: true, result: '已向文件输入框设置 ' + files.length + ' 个文件：' + files.join('、') };
      } catch (e) {
        return { ok: false, result: '文件上传失败：' + summarizeCdpError(e) };
      }
    }
    case 'get_ax_snapshot': {
      if (!cdpAllowed(ctx)) return { ok: false, result: '可访问性树快照需要 CDP（请在设置中开启）。' };
      try {
        const nodes = await cdp.getFullAxTree(ctx.tabId);
        const INTERACTIVE_ROLES = new Set([
          'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
          'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider',
          'spinbutton', 'treeitem', 'gridcell',
        ]);
        const limit = Math.min(120, Math.max(1, Number(args.limit) || 60));
        const picked = [];
        for (const n of nodes) {
          if (!n || n.ignored) continue;
          const role = n.role && n.role.value;
          if (!role || !INTERACTIVE_ROLES.has(role)) continue;
          const name = String((n.name && n.name.value) || '').slice(0, 120);
          picked.push({ role, name, locator: { role, name }, backendDOMNodeId: n.backendDOMNodeId });
          if (picked.length >= limit) break;
        }
        const withBox = [];
        for (const p of picked) {
          if (!p.backendDOMNodeId) { withBox.push(p); continue; }
          try {
            const box = await cdp.getBoxModel(ctx.tabId, p.backendDOMNodeId);
            const q = box && box.content;
            if (q && q.length >= 8) {
              const cx = Math.round((q[0] + q[2] + q[4] + q[6]) / 4);
              const cy = Math.round((q[1] + q[3] + q[5] + q[7]) / 4);
              withBox.push(Object.assign({}, p, { x: cx, y: cy }));
            } else {
              withBox.push(p);
            }
          } catch (e) {
            withBox.push(p);
          }
        }
        const lines = withBox.map((p, i) => '[' + (i + 1) + '] ' + p.role + '「' + p.name + '」' + (p.x != null ? ' 坐标(' + p.x + ',' + p.y + ')' : ''));
        return {
          ok: true,
          ax: withBox,
          result:
            '可访问性树（交互节点 ' + withBox.length + ' 个，含 role/名称/坐标）：\n' + (lines.join('\n') || '（无）') +
            '\n用法：优先用 role+name 定位（如 click_element({role:"button",name:"登录"})），比坐标更稳；canvas/虚拟列表等无 DOM 场景再用坐标 click_at。',
        };
      } catch (e) {
        return { ok: false, result: '读取可访问性树失败：' + summarizeCdpError(e) };
      }
    }
    case 'set_element_style':
    case 'highlight_text':
    case 'outline_element':
    case 'get_element_text':
    case 'clear_page_overlays':
      return await executePageTool(ctx.tabId, pageToolCommand(name), args, ctx);
    case 'scroll_page': {
      // 合并自 scroll_to_element / scroll_page：有目标或坐标走按目标滚动，否则按偏移。
      const params = args || {};
      const hasTarget = Boolean(params.ref || params.selector || params.text);
      const hasCoords = typeof params.top === 'number' || typeof params.left === 'number';
      return await executePageTool(ctx.tabId, hasTarget || hasCoords ? 'scroll_to' : 'scroll_by', params, ctx);
    }
    case 'run_javascript': {
      // engine='page'：用 CDP Runtime.evaluate 在页面主世界执行（可访问页面自身 JS 状态，
      // 且不受页面 CSP 限制）；默认走内容脚本受限沙箱（无 chrome.*）。
      if (args.engine === 'page' || args.pageWorld === true) {
        if (!cdpAllowed(ctx)) return { ok: false, result: '页面世界执行需要 CDP（请在设置中开启）。' };
        try {
          const jsFrame = frameIdFromArgs(args);
          const expr = '(() => {\n' + String(args.code || '') + '\n})()';
          const value = jsFrame != null && jsFrame !== 0
            ? await cdp.evaluateInFrame(ctx.tabId, jsFrame, expr)
            : await cdp.evaluate(ctx.tabId, expr);
          let serialized;
          try {
            serialized = JSON.stringify(value, null, 2);
          } catch (e) {
            serialized = String(value);
          }
          if (serialized === undefined) serialized = 'undefined';
          if (serialized.length > 2000) serialized = serialized.slice(0, 2000) + '\n…（结果过长已截断）';
          return { ok: true, cdp: true, result: serialized };
        } catch (e) {
          return { ok: false, result: '页面世界执行失败：' + summarizeCdpError(e) };
        }
      }
      try {
        const r = await executeContentAction(ctx.tabId, 'run_javascript', { type: 'kbRunJavaScript', params: args }, { delayMs: 80 });
        if (r && r.ok !== false && r.verification) {
          // JS 可能只读取不改页面，快照验证不一定有变化，此时以返回结果为准。
          r.verification.reason = 'JS 已执行，返回结果见上';
        }
        return r;
      } catch (e) {
        return { ok: false, result: '执行 JS 失败：' + e.message };
      }
    }
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
      const toolWarnings = validateSkillTools(skill);
      if (toolWarnings.length) {
        parts.push(
          '⚠ 注意：该技能声明的依赖工具存在问题，Agent 无法调用，请到技能页更新依赖工具列表：\n' +
            toolWarnings.map((w) => '- ' + w).join('\n')
        );
      }
      return { result: parts.join('\n\n') };
    }
    case 'install_skill': {
      const identifier = String((args && (args.identifier || args.url)) || '').trim();
      if (!identifier) return { ok: false, result: '缺少技能 identifier 参数。' };
      return await installSkillFromSkillHub(identifier);
    }
    case 'undo_last_action': {
      return await executeContentAction(ctx.tabId, 'undo_last_action', { type: 'kbUndo', params: args }, { verify: false });
    }
    case 'save_macro': {
      const name = String((args && args.name) || '').trim();
      if (!name) return { ok: false, result: 'save_macro 需要 name。' };
      const trace = Array.isArray(ctx.trace) ? ctx.trace : [];
      if (!trace.length) {
        return { ok: false, result: '当前任务没有可保存的可重放动作（仅点击/输入/按键/勾选/选择/滚动/等待/开页会被记录）。' };
      }
      const saved = await saveMacro(ctx.pageUrl, { name, description: args && args.description, steps: trace });
      if (!saved) return { ok: false, result: '保存宏失败（缺少名称或步骤）。' };
      return {
        ok: true,
        result: '已保存宏「' + saved.name + '」（' + saved.steps.length + ' 步）。以后可直接调用 run_macro("' + saved.name + '") 回放。',
      };
    }
    case 'list_macros': {
      const macros = await listMacros(ctx.pageUrl);
      if (!macros.length) return { ok: true, result: '当前站点还没有保存的宏。' };
      const text = macros
        .map((m, i) => '[' + (i + 1) + '] ' + m.name + (m.description ? '：' + m.description : '') + '（' + m.steps.length + ' 步）')
        .join('\n');
      return { ok: true, result: '当前站点已保存的宏：\n' + text };
    }
    case 'run_macro': {
      const name = String((args && args.name) || '').trim();
      if (!name) return { ok: false, result: 'run_macro 需要 name。' };
      const macro = await getMacro(ctx.pageUrl, name);
      if (!macro) return { ok: false, result: '未找到宏「' + name + '」（可用 list_macros 查看）。' };
      const steps = Array.isArray(macro.steps) ? macro.steps : [];
      if (!steps.length) return { ok: false, result: '宏「' + name + '」没有步骤。' };
      const log = [];
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        let r;
        try {
          r = await executeTool(s.tool, s.args, ctx);
        } catch (e) {
          r = { ok: false, result: e && e.message ? e.message : String(e) };
        }
        const failed = r && r.ok === false;
        log.push('[' + (i + 1) + '/' + steps.length + '] ' + s.tool + (failed ? ' ✗ ' + String(r.result || '').slice(0, 120) : ' ✓'));
        if (r && Number.isInteger(Number(r.targetTabId))) {
          ctx.tabId = Number(r.targetTabId);
          if (r.targetTab) {
            ctx.pageUrl = r.targetTab.url || ctx.pageUrl;
            ctx.pageTitle = r.targetTab.title || ctx.pageTitle;
          }
        }
        if (failed) return { ok: false, result: '宏「' + name + '」在第 ' + (i + 1) + ' 步失败，已停止：\n' + log.join('\n') };
      }
      await bumpMacroHits(ctx.pageUrl, name).catch(() => {});
      return { ok: true, result: '已回放宏「' + name + '」（' + steps.length + ' 步）：\n' + log.join('\n') };
    }
    case 'trust_site': {
      let origin = '';
      try {
        origin = new URL(ctx.pageUrl || '').origin;
      } catch (e) {}
      if (!origin) return { ok: false, result: '无法确定当前站点。' };
      const list = Array.isArray(ctx.settings.trustedSites) ? ctx.settings.trustedSites.slice() : [];
      if (!list.includes(origin)) list.push(origin);
      ctx.settings.trustedSites = list;
      try {
        await chrome.storage.local.set({ aiSettings: Object.assign({}, ctx.settings, { trustedSites: list }) });
      } catch (e) {}
      return {
        ok: true,
        result: '已信任站点 ' + origin + '：此站点的写操作将不再逐次确认（run_javascript 等高风险工具仍每次确认）。',
      };
    }
    case 'update_plan': {
      const raw = Array.isArray(args.items) ? args.items : [];
      const plan = raw
        .filter((it) => it && typeof it.text === 'string' && it.text.trim())
        .slice(0, 20)
        .map((it) => ({
          text: String(it.text).trim().slice(0, 120),
          status: ['pending', 'in_progress', 'done'].includes(it.status) ? it.status : 'pending',
        }));
      ctx.plan = plan;
      const text = plan
        .map((p, i) => (p.status === 'done' ? '✓' : p.status === 'in_progress' ? '▶' : '○') + ' ' + (i + 1) + '. ' + p.text)
        .join('\n');
      return { result: '计划已更新（' + plan.length + ' 步）：\n' + (text || '（空计划）') };
    }
    case 'expand_result': {
      const id = String((args && args.id) || '').trim();
      const store = ctx && ctx.resultStore;
      const text = store && typeof store.get === 'function' ? store.get(id) : null;
      if (!text) return { ok: false, result: '未找到结果 id=' + id + '（可能已过期，请重新读取页面）。' };
      const offset = Math.max(0, Number(args.offset) || 0);
      const limit = Math.min(4000, Math.max(200, Number(args.limit) || 2000));
      const slice = String(text).slice(offset, offset + limit);
      return {
        ok: true,
        result: '结果 ' + id + ' [' + offset + ',' + (offset + slice.length) + ') / 共 ' + String(text).length + ' 字符：\n' + slice,
      };
    }
    case 'handle_dialog': {
      if (!cdpAllowed(ctx)) return { ok: false, result: '处理对话框需要 CDP（请在设置中开启）。' };
      try {
        await handleDialog(ctx.tabId, args.accept !== false, args.promptText);
        return { ok: true, result: (args.accept !== false ? '已接受' : '已取消') + '页面对话框。' };
      } catch (e) {
        return { ok: false, result: '处理对话框失败：' + summarizeCdpError(e) };
      }
    }
    case 'list_downloads': {
      const list = getDownloads(ctx.tabId);
      if (!list.length) return { ok: true, result: '本任务暂未捕获到下载。' };
      return {
        ok: true,
        result: '捕获到的下载：\n' + list.map((d, i) => '[' + (i + 1) + '] ' + (d.suggestedFilename || '') + ' ← ' + d.url).join('\n'),
      };
    }
    case 'get_run_trace': {
      const rec = args.runId ? await getTrace(String(args.runId)) : (await listTraces())[0];
      if (!rec) return { ok: true, result: '暂无运行轨迹。' };
      const lines = (rec.entries || []).map((e) => {
        const t = new Date(e.ts).toLocaleTimeString('zh-CN');
        if (e.phase === 'tool') return t + ' [tool] ' + e.name + ' ' + (e.ok ? '✓' : '✗') + ' ' + (e.ms || 0) + 'ms ' + (e.args || '');
        if (e.phase === 'start') return t + ' [start] intent=' + e.intent + ' ' + (e.instruction || '');
        if (e.phase === 'complete') return t + ' [complete] ' + (e.reason || '') + ' tokens=' + (e.totalTokens || 0);
        if (e.phase === 'timeout') return t + ' [timeout] ' + (e.reason || '');
        if (e.phase === 'error') return t + ' [error] ' + (e.error || '');
        return t + ' [' + e.phase + ']';
      });
      return { ok: true, result: '运行轨迹 ' + rec.runId + '（' + lines.length + ' 条）：\n' + lines.join('\n') };
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
// ---- web_search：DuckDuckGo / Bing 结果解析（无需 API Key，host_permissions 已含 <all_urls>）----
function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ').replace(/&emsp;/g, ' ').replace(/&middot;/g, '·').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch (e) { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ''; } })
    .replace(/\s+/g, ' ')
    .trim();
}

// 还原搜索引擎重定向链接为真实 URL（DuckDuckGo uddg 参数 / Bing u=base64url）。
function resolveSearchUrl(href, engine) {
  try {
    if (engine === 'ddg') {
      const u = new URL(href, 'https://duckduckgo.com');
      const target = u.searchParams.get('uddg');
      if (target && /^https?:\/\//i.test(target)) return target;
    } else if (engine === 'bing') {
      const u = new URL(href, 'https://www.bing.com');
      const enc = u.searchParams.get('u');
      if (enc) {
        let b64 = enc.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const decoded = decodeURIComponent(new TextDecoder().decode(bytes));
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
  } catch (e) {}
  return href;
}

function parseSearchResults(html, engine) {
  const out = [];
  const maxLen = 10;
  if (engine === 'ddg') {
    const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < maxLen) {
      const snip = html.slice(m.index, m.index + 3000).match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      out.push({
        title: stripTags(m[2]).slice(0, 120),
        url: resolveSearchUrl(m[1], 'ddg'),
        snippet: (snip ? stripTags(snip[1]) : '').slice(0, 200),
      });
    }
  } else if (engine === 'bing') {
    const re = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < maxLen) {
      const block = m[1];
      const a = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (a) {
        out.push({
          title: stripTags(a[2]).slice(0, 120),
          url: resolveSearchUrl(a[1], 'bing'),
          snippet: (p ? stripTags(p[1]) : '').slice(0, 200),
        });
      }
    }
  }
  return out;
}

async function searchWeb(query, maxResults = 6) {
  const q = encodeURIComponent(query);
  // 注意：本工具会被 withTimeout(toolTimeoutMs=15s) 包裹，各引擎超时必须加起来 < 15s。
  // Bing 优先（实测可用），DuckDuckGo 兜底；都带浏览器 UA，避免被当作无头请求拦截。
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
  const engines = [
    { name: 'bing', url: 'https://www.bing.com/search?q=' + q + '&setlang=zh-hans', timeout: 7000 },
    { name: 'ddg', url: 'https://html.duckduckgo.com/html/?q=' + q, timeout: 6000 },
  ];
  for (const engine of engines) {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), engine.timeout) : null;
      const resp = await fetch(engine.url, { method: 'GET', redirect: 'follow', headers, signal: ctrl ? ctrl.signal : undefined });
      if (timer) clearTimeout(timer);
      if (!resp.ok) continue;
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const buf = await readBounded(resp.body, 1.5 * 1024 * 1024);
      const raw = decodeBuffer(ct).decode(buf);
      const results = parseSearchResults(raw, engine.name);
      if (results.length) return results.slice(0, maxResults);
    } catch (e) {
      // 尝试下一个引擎
    }
  }
  return [];
}

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

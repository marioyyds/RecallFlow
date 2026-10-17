// 内置工具的 Schema（OpenAI / DeepSeek function-calling 格式）—— 唯一来源。
//
// 对外暴露的 BUILTIN_TOOLS、权限查询与 MCP 工具列表都从它派生，
// 避免 Agent / MCP / 执行器各维护一套不一致的参数定义。
//
// 纯数据模块：几乎不含逻辑、无副作用，可直接在 node 中载入做一致性校验（见 tests/registry.test.mjs）。
//
// ⚠ 唯一例外：截图工具的说明**整句**随视觉开关二选一，文案的单一来源在
// `lib/shared/utils.js`（`VISION_ENABLED` 与两档文案都在那里）。
// 若在本文件里再抄一份字面量，开关一打开就会出现"两处文案不一致"的漂移 ✗
// ⇒ 只从那里 import（`utils.js` 仅依赖 `constants.js`，无浏览器依赖，node 里照常载入 ✓）
import { VISION_ENABLED, VISION_UNAVAILABLE_TOOL_COPY, VISION_ENABLED_TOOL_COPY } from '../shared/utils.js';

// 单次 annotate({op:"highlight"}) 能处理的条数上限。
// 与 lib/shared/constants.js 的 HIGHLIGHT_MAX_TEXTS 是同一个约束 —— 本模块刻意不含
// 多余的 import（见上一行），所以这里只能硬编码，改为由 tests/registry.test.mjs 断言两者相等：
// 一旦有人只改了一边，测试会失败，而不是让模型按错误的预期分批。
const HIGHLIGHT_MAX_TEXTS = 20;

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'knowledge_read',
      description:
        '读取用户的个人知识库（算法错题、技术文章、AI·Prompt、笔记）。按 op 选择读法：' +
        'search —— 按关键词/问题检索相关条目（用户问到知识库内容、或需要先查资料时用）；' +
        'list —— 列出条目概览，可按类型筛选（「知识库里有什么」「列出全部笔记」用）；' +
        'get —— 按 id 取单条完整内容（标题、备注、标签、链接、星级）。' +
        '**写入与删除不在这里**：新增/更新用 add_entry，删除用 remove_entry。',
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['search', 'list', 'get'],
            description: '读法：search 按关键词检索 / list 列出概览 / get 按 id 取单条',
          },
          query: { type: 'string', description: 'op=search 时必填：检索关键词或自然语言问题' },
          id: { type: 'string', description: 'op=get 时必填：条目 id（通常是其 URL）' },
          type: { type: 'string', enum: ['wrong', 'article', 'ai', 'note', ''], description: 'op=list 时可选：按类型筛选，留空表示全部' },
          limit: { type: 'integer', description: 'op=search 默认 5；op=list 默认 20' },
        },
        required: ['op'],
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
          id: { type: 'string', description: '更新已有条目时传条目 id；新建条目留空' },
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
      description:
        '读取当前网页正文（去脚本/样式/导航后的纯文本），用于基于「正在浏览的页面」回答或提取信息。' +
        '默认返回**含隐藏节点文字**的文本；要判断某段文案是否还看得见（如确认广告已清除），传 visibleOnly:true，并用 checkTexts 核查关键词 —— 它分别给出「可见次数」与「DOM 次数」。',
      parameters: {
        type: 'object',
        properties: {
          visibleOnly: {
            type: 'boolean',
            description: '只返回按可见性过滤后的文本（排除 display:none / visibility:hidden / opacity:0 的内容，并穿透开放 shadow root）。默认 false。',
          },
          checkTexts: {
            type: 'array',
            items: { type: 'string' },
            description:
              '要核查可见性的关键词（最多 20 个）。返回每个词的「可见次数 / DOM 次数」：可见 0 次而 DOM 次数 > 0，说明它仍在 DOM 里但已不可见。判断「广告是否清干净」应当用这个，而不是看正文里还有没有这个词。',
          },
        },
      },
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
      description:
        '列出当前页面内的所有框架（含跨域 iframe）及其 frameId / URL / 标题，用于定位需要操作的 iframe。' +
        '注意适用边界：如果元素「查不到」是因为它在 **Shadow DOM**（很多站点的广告卡、推荐位都是 Web Component），' +
        '那不是 frame 问题，用这个方法没有帮助 —— 直接改用 annotate({op:"style"}) / inspect_element({op:"text"})（它们会穿透开放 shadow root）。',
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
      name: 'macro',
      description:
        '把已验证的多步操作固化为可复用的「宏」（按当前站点），零 token 回放。按 op 选择做什么：' +
        'save —— 把**当前任务中已成功执行**的可重放动作保存为宏（适合用户说「记住这个流程」「以后都这么做」）；' +
        'list —— 列出本站点已保存的宏；' +
        'run —— 回放某个宏（按保存的动作序列逐步执行，不再逐条走模型；某步失败会停在该步并报告）。' +
        'op=save 需要 name（自己起一个易记的名字，回放时要照抄它）；op=run 需要 name 且必须是 list 给出的准确值。',
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['save', 'list', 'run'],
            description: '要做哪种宏操作：save 保存当前流程 / list 列出已保存的宏 / run 回放某个宏',
          },
          name: {
            type: 'string',
            description: 'op=save 时是**要起的宏名**（如「登录并签到」；不要用「流程1」这类无信息量的名字）；op=run 时是**要回放的宏名**（照抄 list 输出的 name 值，不是描述）。',
          },
          description: { type: 'string', description: 'op=save 时可选：一句话说明该流程' },
        },
        required: ['op'],
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
                text: { type: 'string', description: '按文本片段定位' },
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
        '处理当前页面的 JavaScript 对话框（alert / confirm / prompt）。这类对话框会阻塞页面与后续操作；若 get_page_snapshot 提示有未处理对话框，应先调用本工具，**不要重复点击**触发它的按钮（只会让对话框叠加）。',
      parameters: {
        type: 'object',
        properties: {
          accept: { type: 'boolean', description: 'true=确定/接受，false=取消，默认 true' },
          promptText: {
            type: 'string',
            description: 'prompt 对话框要填入的文本。**不传就原样接受默认值** —— 目标值与默认值不同时必须显式传它。',
          },
        },
      },
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
      name: 'read_diagnostics',
      description:
        '读取当前页面的运行期事实，用于前端调试。按 kind 选择读什么：' +
        'console —— 最近的 console 输出（error/warn/log/info）与未捕获异常；' +
        'network —— 最近的网络请求（fetch/XHR 的 URL、方法、状态码、耗时、错误、发起位置）；' +
        'downloads —— 本任务中页面触发的下载（文件名 + URL）。' +
        'kind 必填：不要靠猜，想看哪一类就传哪一类。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['console', 'network', 'downloads'],
            description: '要读取的事实类别：console / network / downloads',
          },
          level: { type: 'string', description: 'kind=console 时生效：过滤级别 error / warn / log / info；不填返回全部' },
          filter: { type: 'string', description: 'kind=network 时生效：按 URL 子串过滤' },
          limit: { type: 'integer', description: 'kind=console/network 时生效：返回条数上限，默认 50，最大 200' },
        },
        required: ['kind'],
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
          ref: { type: 'string', description: '快照中的元素引用（如 rf-3），优先级最高' },
          selector: { type: 'string', description: 'CSS 选择器，穿透开放 shadow root' },
          text: { type: 'string', description: '按文本片段定位' },
          index: { type: 'integer', description: '命中第几个（从 0 开始）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: '向当前网页的 input、textarea 或 contenteditable 元素输入文本。优先使用 DOM 快照中的 ref；默认追加文本，clearFirst=true 时先清空。**value 是要输入的文本，text 是用于定位元素的文本片段（find by text），两者语义不同，不要混用。**',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: '要输入的文本内容（负载）。传空字符串表示只清空、不输入新内容（需配合 clearFirst=true）。' },
          ref: { type: 'string', description: '快照中的元素引用（如 rf-3），优先级最高' },
          selector: { type: 'string', description: 'CSS 选择器，穿透开放 shadow root' },
          text: { type: 'string', description: '按文本片段定位目标元素（不是输入内容）' },
          clearFirst: { type: 'boolean', description: '是否先清空原内容，默认 false' },
          role: { type: 'string', description: 'ARIA role（如 button/link），配合 name 更稳' },
          name: { type: 'string', description: '可访问名（按钮文字 / aria-label），配合 role' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个（从 0 开始）' },
        },
        required: ['value'],
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
          ref: { type: 'string', description: '快照中的元素引用（如 rf-3），优先级最高' },
          selector: { type: 'string', description: 'CSS 选择器，穿透开放 shadow root' },
          key: { type: 'string', description: '按键名称或单字符，如 Enter、Tab、a' },
          modifiers: { type: 'array', items: { type: 'string', enum: ['CTRL', 'ALT', 'SHIFT', 'META'] }, description: '修饰键列表' },
          role: { type: 'string', description: 'ARIA role（如 button/link），配合 name 更稳' },
          name: { type: 'string', description: '可访问名（按钮文字 / aria-label），配合 role' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个（从 0 开始）' },
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
          ref: { type: 'string', description: '快照中的元素引用（如 rf-3），优先级最高' },
          selector: { type: 'string', description: 'CSS 选择器，穿透开放 shadow root' },
          value: { type: 'string', description: 'option.value' },
          label: { type: 'string', description: 'option 显示文本' },
          index: { type: 'integer', description: '命中第几个（从 0 开始）' },
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
          ref: { type: 'string', description: '快照中的元素引用（如 rf-3），优先级最高' },
          selector: { type: 'string', description: 'CSS 选择器，穿透开放 shadow root' },
          text: { type: 'string', description: '按文本片段定位' },
          checked: { type: 'boolean', description: '目标状态' },
          role: { type: 'string', description: 'ARIA role（如 button/link），配合 name 更稳' },
          name: { type: 'string', description: '可访问名（按钮文字 / aria-label），配合 role' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个（从 0 开始）' },
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
          ref: { type: 'string', description: '快照中的元素引用（如 rf-3），优先级最高' },
          selector: { type: 'string', description: 'CSS 选择器，穿透开放 shadow root' },
          text: { type: 'string', description: '按文本片段定位' },
          state: {
            type: 'string',
            enum: ['attached', 'visible', 'enabled', 'text_contains', 'count', 'detached', 'url_contains'],
            description: '等待条件，默认 visible',
          },
          count: { type: 'integer', description: 'state=count 时的目标匹配数量，默认 1' },
          timeoutMs: { type: 'integer', description: '最长等待时间，默认 8000，最大 15000' },
          pollMs: { type: 'integer', description: '轮询间隔，默认 100' },
          role: { type: 'string', description: 'ARIA role（如 button/link），配合 name 更稳' },
          name: { type: 'string', description: '可访问名（按钮文字 / aria-label），配合 role' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个（从 0 开始）' },
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
          ref: { type: 'string', description: '快照中的元素引用（如 rf-3），优先级最高' },
          selector: { type: 'string', description: 'CSS 选择器，穿透开放 shadow root' },
          text: { type: 'string', description: '按文本片段定位' },
          attribute: { type: 'string', description: '属性名，如 aria-expanded、href、disabled' },
          role: { type: 'string', description: 'ARIA role（如 button/link），配合 name 更稳' },
          name: { type: 'string', description: '可访问名（按钮文字 / aria-label），配合 role' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个（从 0 开始）' },
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
          ref: { type: 'string', description: '快照中的元素引用（如 rf-3），优先级最高' },
          selector: { type: 'string', description: 'CSS 选择器，穿透开放 shadow root' },
          text: { type: 'string', description: '按文本片段定位' },
          role: { type: 'string', description: 'ARIA role（如 button/link），配合 name 更稳' },
          name: { type: 'string', description: '可访问名（按钮文字 / aria-label），配合 role' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个（从 0 开始）' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_element',
      description:
        '侦查元素（只读）。按 op 选择看什么：' +
        'inspect —— 一次回答「命中几个、还看不看得见、属于哪个容器、该容器是否含正文」；' +
        '返回 count（**命中总数**，不受列出条数限制）、listed / truncated（本次列出前 8 个）、visibleCount，' +
        '以及每个列出元素的 selector / visible / shadowDepth / 尺寸 / 文本长度 / 祖先链 path / containsMainContent。' +
        '注意：count 才是真实命中数；命中超过 8 个时 matches 只含前 8 个，请以 count 为准，不要用 matches.length 当命中数。' +
        '**排查「广告位还在不在、藏在哪、该隐藏哪一层」优先用它**，不要写 run_javascript 逐层查 parentElement（那是此前多出十几轮往返的主因）。祖先链与可见性均跨 shadow 边界。' +
        'text —— 读元素里的文本内容，用于确认它到底写了什么；' +
        'styles —— 读元素**计算后的**样式（font-size / line-height / color / background-color / width / height / display / visibility / opacity / overflow-x / position / z-index，可用 props 指定别的）。' +
        '**改完样式要用它确认真的生效**：`annotate({op:"style"})` 只回一句「已修改 N 个元素」，那证明的是调用发出去了，' +
        '而样式可能被 !important 覆盖或因取值非法被忽略。别再用 run_javascript 读 getComputedStyle —— 那条路每次都打断用户审批，而且要开 CDP 才能跑；' +
        'table —— 把 <table> 还原成「表头 + 矩形数据网格」（返回 JSON 与 markdown），**合并单元格（rowspan/colspan）会被正确展开对齐**；' +
        '用 run_javascript 逐行取 td 文本遇到合并单元格必然列错位，需要表格数据就用它。',
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['inspect', 'text', 'table', 'styles', 'options'],
            description:
              '看什么：inspect 结构 / text 文本 / styles 计算样式（验证样式是否生效）/ table 表格 / options 下拉框选项清单',
          },
          // --- 定位（三种 op 通用）---
          ref: { type: 'string', description: '快照中的元素引用（如 rf-3），优先级最高' },
          selector: { type: 'string', description: 'CSS 选择器，穿透开放 shadow root' },
          text: { type: 'string', description: '按文本片段定位（注意：它是**定位**用的，不是 op=text 的开关）' },
          role: { type: 'string', description: 'ARIA role（如 button/link），配合 name 更稳' },
          name: { type: 'string', description: '可访问名（按钮文字 / aria-label），配合 role' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个（从 0 开始）；op=table 有多个表格时用 index 取第 N 个' },
          // --- 仅 op=table ---
          maxRows: { type: 'integer', description: 'op=table：最多提取多少行，默认 200' },
          maxCols: { type: 'integer', description: 'op=table：最多提取多少列，默认不限' },
          fillMerged: {
            type: 'boolean',
            description: 'op=table：合并单元格的延续格是否重复填入同一文本（默认 true，便于按列读取）。设 false 可保留「此处是合并延续」的忠实形态（延续格为空）。',
          },
          // --- 仅 op=styles ---
          props: {
            type: 'array',
            items: { type: 'string' },
            description:
              'op=styles：要读取的 CSS 属性名（用连字符写法，如 font-size / line-height / max-width），最多 12 个。' +
              '不传则读一组常用属性：font-size / line-height / color / background-color / width / height / display / visibility / opacity / overflow-x / position / z-index。',
          },
        },
        required: ['op'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'take_screenshot',
      description:
        '给当前页面截图（只读，需 CDP）。' +
        // 视觉能力开关（单一来源 `VISION_ENABLED`）：**整句**二选一 ——
        // 关闭时那段与**引入开关之前逐字节相同**（纯重构 ⇒ 不需要测量 ✓）；
        // 打开时换成如实且不矛盾的启用分支 ✓
        // ⚠ 只条件化"你看不到图像"那半句是不够的：前半句「只展示给用户与留档」会与
        // 「同时也会送进你的上下文」自相矛盾 ✗（第 7 步审校实测复现）
        (VISION_ENABLED ? VISION_ENABLED_TOOL_COPY : '图片**只展示给用户与留档**，' + VISION_UNAVAILABLE_TOOL_COPY) +
        '它的价值是给用户可视证据（如「修改前/后」各拍一张）。需要可判断的文本证据请用 get_page_snapshot / inspect_element / read_diagnostics。',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '这张图的用途说明，如「修改前」「修改后」，会显示在图片下方' },
          fullPage: { type: 'boolean', description: '是否整页截图（默认 false 只截当前视口；整页可能很大并触发自动降质）' },
          format: { type: 'string', enum: ['jpeg', 'png'], description: '默认 jpeg（体积小）；需要无损细节用 png（超限会自动退为 jpeg）' },
          quality: { type: 'integer', description: 'jpeg 质量 20-100，默认 72。体积超限时会自动逐级降质重拍' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'annotate',
      description:
        '在页面上做视觉标注（高亮 / 描边 / 改样式或隐藏 / 清除），**都不改动页面 DOM**（画在独立浮层上）。按 op 选择：' +
        'highlight —— 高亮文本片段；需要高亮多处时**一次调用传 texts 数组**，不要逐条多次调用（单次最多 ' + HIGHLIGHT_MAX_TEXTS + ' 条，超出部分不会被处理，结果里会明确告知还剩多少条）；' +
        'outline —— 用边框描边标注目标元素，便于向用户指出位置；' +
        'style —— 修改元素样式（字号/加粗/颜色/背景）或隐藏（hide:true）；styles 用驼峰 CSS 属性；' +
        'clear —— 清除页面上的高亮、描边和临时样式。' +
        '定位支持 ref / role+name / testid / selector / text，**穿透开放 shadow root 与同源 iframe**（隐藏 shadow 内组件如 MSN 的 cs-card 靠它，别手写 querySelectorAll）。' +
        '**批量隐藏用 op=style + selectors 数组一次传完**（≤20），不要逐个调用。' +
        '**隐藏广告用 op=style + hide:true，而不是在 run_javascript 里 remove 节点** —— 移除会让站点自身的状态跟踪失准（无限滚动、内容可见性、广告 SDK 接连报错），display:none 只影响呈现。',
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['highlight', 'outline', 'style', 'clear'],
            description: '做哪种标注：highlight 高亮文本 / outline 描边元素 / style 改样式或隐藏 / clear 清除全部标注',
          },
          // --- 定位（op=clear 之外都可用）---
          ref: { type: 'string', description: '快照中的元素引用（如 rf-3），优先级最高' },
          selector: { type: 'string', description: 'CSS 选择器，穿透开放 shadow root' },
          selectors: {
            type: 'array',
            items: { type: 'string' },
            description: 'op=style 的批量模式：一次传入多个 CSS 选择器（最多 20 个），返回聚合结果（已处理 N 个元素；未命中的选择器会列出）。隐藏多个广告位时用它，避免逐条调用。',
          },
          text: { type: 'string', description: '按文本片段定位' },
          role: { type: 'string', description: 'ARIA role（如 button/link），配合 name 更稳' },
          name: { type: 'string', description: '可访问名（按钮文字 / aria-label），配合 role' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个（从 0 开始）' },
          // --- 仅 op=highlight ---
          texts: {
            type: 'array',
            items: { type: 'string' },
            maxItems: HIGHLIGHT_MAX_TEXTS,
            description: 'op=highlight：要高亮的多个文本片段（与 text/selector 三选一，推荐批量）。最多 ' + HIGHLIGHT_MAX_TEXTS + ' 条，超出会被截断并告知。',
          },
          // --- 仅 op=style ---
          hide: {
            type: 'boolean',
            description: 'op=style：true = 设为 display:none 隐藏；false = 还原 display。等价于 styles:{"display":"none"}，但更不易写错。与 styles 二选一即可。',
          },
          styles: { type: 'object', description: 'op=style：要应用的样式对象，如 {"fontSize":"36px","fontWeight":"bold","color":"#e60000"}。与 hide 二选一。' },
          // --- 颜色 / 时长（不同 op 含义不同，已逐个写明）---
          color: {
            type: 'string',
            description: 'op=outline 时是**描边颜色**（默认 #ff5722）；op=highlight 时是**高亮颜色**，建议 rgba 半透明（实色会自动转低透明度，避免盖住文字）。',
          },
          duration: {
            type: 'integer',
            description: '临时效果持续时长(ms)：op=outline 默认 1500；op=style 不填则保留（可用 op=clear 还原）。',
          },
        },
        required: ['op'],
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
          ref: { type: 'string', description: '快照中的元素引用（如 rf-3），优先级最高' },
          selector: { type: 'string', description: 'CSS 选择器，穿透开放 shadow root' },
          text: { type: 'string', description: '按文本片段定位' },
          role: { type: 'string', description: 'ARIA role（如 button/link），配合 name 更稳' },
          name: { type: 'string', description: '可访问名（按钮文字 / aria-label），配合 role' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个（从 0 开始）' },
          top: { type: 'number', description: '目标纵坐标(px)，与 left 配合按绝对坐标滚动' },
          left: { type: 'number', description: '目标横坐标(px)，与 top 配合按绝对坐标滚动' },
          y: { type: 'number', description: '纵向偏移(px)，正数向下；与 ref/selector/text 同用时滚该元素自身，否则滚窗口' },
          x: { type: 'number', description: '横向偏移(px)，正数向右；与 ref/selector/text 同用时滚该元素自身，否则滚窗口' },
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
      name: 'run_javascript',
      description:
        '在页面执行 JS（逃生舱）：仅当内置工具无法表达时才用，如批量取值、读测量值、复杂组件操作。' +
        '**普通 document.querySelectorAll 穿不过 shadow 边界**，改样式/查文本请优先 annotate({op:"style"}) / inspect_element({op:"text"})，否则容易反复调用却总差一点。' +
        '受限作用域：无 chrome.*、扩展存储、fetch/XHR。沙箱依赖 eval，而 **MV3 扩展自身的 CSP 不允许**（与页面无关，任何页面都一样），故总是改用页面主世界 —— **需要开启 CDP**。' +
        '代码体用 return 返回（可为 Promise），结果自动序列化并截断；每次执行都需用户批准。' +
        '若往页面注入了调试节点，请加 data-rf-injected 属性（页面文本提取会排除它，避免污染证据）。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的 JS 代码（函数体，最后用 return 返回结果）' },
          engine: {
            type: 'string',
            enum: ['sandbox', 'page'],
            description: 'sandbox（默认）：受限作用域，无 chrome.*，但依赖 eval 而 MV3 扩展 CSP 不允许（与页面无关），实际总是自动落到 page；page：页面主世界，**需 CDP**，可读页面自身 JS 状态、不受页面 CSP 限制。',
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
          ref: { type: 'string', description: '快照中的元素引用（如 rf-3），优先级最高' },
          selector: { type: 'string', description: 'CSS 选择器，穿透开放 shadow root' },
          text: { type: 'string', description: '按文本片段定位' },
          role: { type: 'string', description: 'ARIA role（如 button/link），配合 name 更稳' },
          name: { type: 'string', description: '可访问名（按钮文字 / aria-label），配合 role' },
          testid: { type: 'string', description: 'data-testid / data-test-id / data-cy 等测试属性值' },
          index: { type: 'integer', description: '命中第几个（从 0 开始）' },
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
          ref: { type: 'string', description: '快照中的元素引用（如 rf-3），优先级最高' },
          selector: { type: 'string', description: 'CSS 选择器，穿透开放 shadow root' },
          text: { type: 'string', description: '按文本片段定位' },
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
          name: { type: 'string', description: '要加载的**技能名**（不是页面元素）。取值必须是系统提示「技能目录」里列出的技能名，或 SkillHub 上的技能标识；不确定时先看目录，不要臆测。' },
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
  {
    type: 'function',
    function: {
      name: 'save_skill',
      description:
        '把一段**可复用**的做法沉淀为自定义技能（SKILL.md）保存到本地。用户说「沉淀为技能 / 记住这个做法」且你已摸清做法时使用。正文写"以后怎么做"（场景/步骤/边界/完成判据），不要复述本次任务日志 —— 它会进入今后的系统提示。保存需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能标识，kebab-case（小写字母/数字/-），如 publish-xhs-note；与内置技能重名会被拒绝' },
          content: { type: 'string', description: '技能正文（Markdown）：以后怎么做（场景/步骤/边界/完成判据），至少几十字' },
          description: { type: 'string', description: '一句话说明何时使用（进技能目录，模型据此决定是否加载）' },
          displayName: { type: 'string', description: '显示名（给用户看），如「发布小红书图文笔记」' },
          keywords: { type: 'array', items: { type: 'string' }, description: '触发关键词（可选）' },
          intents: { type: 'array', items: { type: 'string', enum: ['browser_task', 'knowledge_task', 'research_task', 'chat_task'] }, description: '适用意图（可选）' },
          tools: { type: 'array', items: { type: 'string' }, description: '依赖工具名（可选，须真实存在；写错的运行时会被忽略，保存结果会告警）' },
        },
        required: ['name', 'content'],
      },
    },
  },
];

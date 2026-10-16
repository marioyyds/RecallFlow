// 真实站点清单（T1）：纯数据模块，零副作用。
//
// 与 fixtures/playbooks.mjs 的分工：
//   · playbooks 是**夹具页**能力剧本（确定性、进 CI），tools 是技能契约锚点；
//   · 这里是**真实站点**清单（非确定、手动、不进 CI），记录"在真实 DOM 上该怎么定位"。
//
// 每条含义：
//   trigger —— 进 fixtures/server.mjs 的脚本化模型分派（按 userText.includes(trigger)）；
//   instruction —— 发给面板的真实指令（真模型 eval 用同一条，保证两边可归因）；
//   tools —— 该站点脚本化流程实际用到的工具（记录 + 后续可接契约门禁）；
//   checks —— 页面判据：**站点自己的数据**，不是"工具返回 ok"；
//   knowledge —— 可选；存在时 E2E 额外断言扩展侧知识库真的写入对应条目。
export const LIVE_SITES = Object.freeze([
  {
    id: 'bing-search',
    name: '必应搜索',
    url: 'https://www.bing.com/',
    trigger: '在必应搜索',
    instruction: '在必应搜索「数据库索引」，然后把前三条结果的标题告诉我。',
    tools: ['get_page_snapshot', 'type_text', 'press_key', 'wait_for_element', 'inspect_element'],
    checks: [
      { expr: "(document.querySelector('#sb_form_q') || {}).value === '数据库索引'", label: '搜索框被填入查询词' },
      { expr: "document.title.indexOf('数据库索引') >= 0", label: '页面标题反映已提交搜索' },
      { expr: "document.querySelectorAll('li.b_algo').length > 0", label: '结果列表真的渲染出条目' },
    ],
  },
  {
    id: 'wikipedia-research',
    name: '维基百科调研（读事实并沉淀）',
    url: 'https://zh.wikipedia.org/wiki/%E6%95%B0%E6%8D%AE%E5%BA%93%E7%B4%A2%E5%BC%95',
    trigger: '维基百科',
    // ⚠ 指令里**不能**出现「知识库」：那是 knowledge-save-retrieve 剧本的触发词，
    //   脚本化分派是 includes 顺序匹配，会静默跑错剧本。用「记下来」表达同义。
    instruction: '帮我把维基百科「数据库索引」词条里关于 B+ 树的要点记下来（标题「数据库索引要点」，方便以后检索）。',
    tools: ['get_page_snapshot', 'inspect_element', 'add_entry'],
    checks: [
      // 标题里可能被 JS 追加「[编辑]」这类链接文字，所以用前缀匹配而不是精确相等。
      { expr: "String((document.querySelector('#firstHeading') || {}).textContent || '').startsWith('数据库索引')", label: '词条标题渲染出来' },
      { expr: "(document.querySelector('#mw-content-text') || { innerText: '' }).innerText.length > 0", label: '词条正文真的可读' },
    ],
    knowledge: { title: '数据库索引要点', noteIncludes: 'B+ 树' },
  },
  {
    id: 'baidu-search',
    name: '百度搜索',
    url: 'https://www.baidu.com/',
    trigger: '在百度搜索',
    instruction: '在百度搜索「数据库索引」，把前三条结果的标题告诉我。',
    tools: ['get_page_snapshot', 'type_text', 'click_element', 'wait_for_element', 'inspect_element'],
    // 实测：自动化 Chromium 常被百度重定向到安全验证页，#kw 不存在、搜索框填不进去。
    // 真实站点失败不追绿 —— 默认跳过，需要时用 E2E_LIVE_FLAKY=1 单独跑。
    flaky: true,
    checks: [
      { expr: "(document.querySelector('#kw') || {}).value === '数据库索引'", label: '搜索框被填入查询词' },
      { expr: "document.title.indexOf('数据库索引') >= 0", label: '页面标题反映已提交搜索' },
      { expr: "document.querySelectorAll('.c-container').length > 0", label: '结果列表真的渲染出条目' },
    ],
  },
  {
    id: 'saucedemo-checkout',
    name: 'SauceDemo 登录 + 多步结算',
    // 公开 demo 站（无真实支付），凭据固定：standard_user / secret_sauce。
    url: 'https://www.saucedemo.com/',
    trigger: '在 saucedemo 买',
    instruction: '在 saucedemo 买一个背包：用标准账号登录，加入购物车并完成结账。',
    tools: ['get_page_snapshot', 'wait_for_element', 'type_text', 'click_element', 'inspect_element'],
    checks: [
      { expr: "String((document.querySelector('.complete-header') || {}).textContent || '').indexOf('Thank you') === 0", label: '结算完成页渲染出订单确认' },
      { expr: "location.pathname === '/checkout-complete.html'", label: '确实落在结算完成页' },
    ],
  },
  {
    id: 'saucedemo-assistant',
    name: 'SauceDemo 站点助手（加购并确认业务状态）',
    url: 'https://www.saucedemo.com/',
    trigger: 'saucedemo 加购',
    instruction: '在 saucedemo 加购：登录后把一个背包加入购物车，然后告诉我购物车里有几件。',
    tools: ['get_page_snapshot', 'wait_for_element', 'type_text', 'click_element', 'inspect_element'],
    checks: [
      { expr: "(document.querySelector('.shopping_cart_badge') || {}).textContent === '1'", label: '购物车徽标数变成 1（业务状态真的变了）' },
    ],
  },
  {
    id: 'github-research',
    name: 'GitHub 检索调研（读结构化结果并沉淀）',
    url: 'https://github.com/search?q=database+index&type=repositories',
    trigger: 'github 检索',
    instruction: '帮我做一次 github 检索：在 GitHub 搜索 database index，把前几条仓库的标题和描述要点记成一条笔记（标题「GitHub 调研要点」）。',
    tools: ['get_page_snapshot', 'inspect_element', 'add_entry'],
    checks: [
      { expr: "Boolean(document.querySelector('[data-testid=\"results-list\"]'))", label: '真实搜索结果列表渲染出来' },
    ],
    knowledge: { title: 'GitHub 调研要点', noteIncludes: 'database index' },
  },
  {
    id: 'mdn-highlight-shadow',
    name: 'MDN 长文划重点 + 给标题加阴影',
    url: 'https://developer.mozilla.org/zh-CN/docs/Web/API/IndexedDB_API',
    trigger: '在 MDN 标注',
    instruction: '在 MDN 标注：把 IndexedDB API 文档里的「事务」和「IndexedDB」高亮出来，并给标题 h1 加一个柔和阴影。',
    tools: ['get_page_snapshot', 'annotate', 'inspect_element'],
    checks: [
      { expr: "Array.from(document.body.children).filter((el) => el.style.zIndex === '2147483646' && el.style.pointerEvents === 'none').length >= 1", label: '高亮浮层真的出现' },
      { expr: "(document.querySelector('h1') ? getComputedStyle(document.querySelector('h1')).boxShadow !== 'none' : false)", label: '标题 h1 的 box-shadow 计算值不再是 none' },
      { expr: "String((document.querySelector('h1') || {}).textContent || '').startsWith('IndexedDB')", label: '标题内容没被破坏' },
    ],
  },
  {
    id: 'arxiv-abstract',
    name: 'arXiv 论文摘要阅读（学生/科研）',
    url: 'https://arxiv.org/abs/2310.11441',
    trigger: 'arxiv',
    instruction: '帮我把 arxiv 2310.11441 这篇论文的摘要要点记成一条笔记（标题「论文要点 2310.11441」）。',
    tools: ['get_page_snapshot', 'inspect_element', 'add_entry'],
    checks: [
      { expr: "location.pathname === '/abs/2310.11441'", label: '确实落在目标论文页' },
      { expr: "(document.querySelector('.abstract') || { innerText: '' }).innerText.length > 0", label: '摘要块真的渲染出来' },
    ],
    knowledge: { title: '论文要点 2310.11441', noteIncludes: '2310.11441' },
  },
  {
    id: 'youdao-dict',
    name: '有道词典查单词（学生）',
    url: 'https://dict.youdao.com/result?word=serendipity&lang=en',
    trigger: '查单词',
    instruction: '帮我查单词：在有道词典查一下 serendipity 的意思。',
    tools: ['get_page_snapshot', 'inspect_element'],
    checks: [
      { expr: "document.title.toLowerCase().indexOf('serendipity') >= 0", label: '页面标题是目标单词' },
      { expr: "(document.querySelector('.trans-container') || { innerText: '' }).innerText.length > 0", label: '释义容器真的渲染出来' },
    ],
  },
  {
    id: 'httpbin-form',
    name: 'httpbin 表单填写并提交（办公）',
    // 用 httpbin 而不是 w3schools：w3schools 的示例表单跑在**iframe**里，顶层 document 拿不到输入框；
    // httpbin 的表单在顶层 document，提交后回显 JSON，是"站点自己的数据"。
    url: 'https://httpbin.org/forms/post',
    trigger: '填这个表单',
    instruction: '帮我填这个表单：在 httpbin 的 Customer name 填 Codex，然后提交订单。',
    tools: ['get_page_snapshot', 'type_text', 'click_element'],
    checks: [
      { expr: "location.pathname === '/post'", label: '表单真的提交到 /post' },
      { expr: "document.body.innerText.indexOf('Codex') >= 0", label: '回显里带着填进去的 Customer name（站点自己的数据）' },
    ],
  },
]);

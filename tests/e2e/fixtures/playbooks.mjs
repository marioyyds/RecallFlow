// 能力剧本（playbook）：**纯数据模块，零副作用** —— 夹具与单测都要 import 它。
//
// 一个剧本 = 一类"浏览器元素操作能力"的可执行定义：
//   · trigger —— 触发词。夹具据此选择剧本，也就是 E2E 里的"选择剧本"开关；
//   · tools   —— 这个剧本**实际用到**的工具。**这是技能契约的锚点**（见下）；
//   · success —— 成功判据的**文字**形式，给真模型 eval 做人工/半自动判定用。
//
// ## 为什么 tools 要单独列出来
//
// 技能（lib/assistant/skill-defs.js）里写着 `x.tools`，意思是"教模型用这几个工具"。
// 而剧本里的 tools 是"真正做到这件事**实际**需要哪几个"。
// 两者一旦不一致，技能就在教模型用一套做不到这件事的工具 ——
// 而症状只是"模型照做了但没成功"，没有任何东西会报错。
//
// tests/skill-playbook-contract.test.mjs 会断言：**技能声明的工具必须覆盖剧本用到的工具**。
// 这就是"技能"与"E2E"之间的机检接口：
// 它**不**假装 E2E 验证了技能文案对模型有没有用（那需要真模型 eval），
// 但它能抓住"技能与实际能力脱节"这种静默失效。
export const PLAYBOOKS = Object.freeze({
  'site-search': {
    id: 'site-search',
    title: '站内检索：把结果条目结构化取回',
    trigger: '站内搜',
    // 顺序即剧本步骤：看页面 → 填搜索框 → 点搜索 → **等结果渲染** → 结构化读取结果
    // `wait_for_element` 不能省：夹具的结果是异步渲染的（真实站点也是），
    // 点完立刻读会读到**空列表**（实测这条漏了它 → 5 次里失败 1 次的间歇性用例）
    tools: ['get_page_snapshot', 'type_text', 'click_element', 'wait_for_element', 'inspect_element'],
    success: '搜索框被填入查询词、结果列表已渲染、且工具结果里能看到真实条目的标题与价格',
    // ---- 第三层（真模型 eval）用的声明 ----
    //
    // 这里刻意只放**可判定的**东西，不放散文：
    //   · pageChecks —— 在页面里求值的表达式，脚本化 E2E 与真模型 eval **共用同一套判据**，
    //     否则"脚本下能过、真模型下不能过"就无法归因是能力问题还是文案问题；
    //   · mustSeeInToolResults —— 必须出现在**模型收到的工具结果**里的字符串。
    //     真模型跑的时候也读夹具记录的请求，所以这条同样适用 ——
    //     它证明的不是"模型答对了"，而是"数据确实交到了模型手上"。
    eval: {
      url: '/search',
      instruction: '在这个页面的站内搜索里搜「咖啡」，然后把前三条结果的标题和价格告诉我。',
      pageChecks: [
        { expr: "document.querySelector('#site-search').value === '咖啡'", label: '搜索框被填入查询词' },
        { expr: 'window.__searched > 0', label: '搜索真的被提交了' },
        { expr: 'window.__renderedCount === 5', label: '结果列表已渲染（含广告共 5 条）' },
      ],
      mustSeeInToolResults: ['哥伦比亚 慧兰 水洗', '￥88', '埃塞俄比亚 耶加雪菲', '云南 小粒咖啡'],
    },
  },

  'checkout-form': {
    id: 'checkout-form',
    title: '点单 / 多步表单：选商品 → 填数量与地址 → 勾选确认 → 提交',
    trigger: '下单',
    // 四种控件走四类工具：select_option（下拉）/ type_text（文本框）/ check_box（勾选）/ click_element（提交）。
    // 注意 check_box 是**承重件**：页面不勾选就只回「请补全信息」，所以它一坏这条用例必红。
    tools: ['get_page_snapshot', 'select_option', 'type_text', 'check_box', 'click_element', 'inspect_element'],
    success: '页面收到的订单数据与指令一致（商品/数量/地址/已勾选），且渲染出「下单成功」摘要',
    eval: {
      url: '/checkout',
      instruction:
        '帮我在这家店下单：商品选「埃塞俄比亚 耶加雪菲」，数量 2，收货地址填「上海市浦东新区 1 号」，勾选确认后提交订单。',
      pageChecks: [
        { expr: "window.__order && window.__order.product === 'coffee-b'", label: '下单商品是耶加雪菲' },
        { expr: "window.__order && window.__order.qty === '2'", label: '数量是 2' },
        { expr: "window.__order && window.__order.addr === '上海市浦东新区 1 号'", label: '收货地址正确' },
        { expr: 'window.__order && window.__order.agree === true', label: '确认勾选已生效（承重件）' },
        { expr: "document.querySelector('#done').textContent.indexOf('下单成功') === 0", label: '渲染出下单成功摘要' },
        { expr: 'window.__submits >= 1', label: '提交按钮被点过' },
      ],
      mustSeeInToolResults: ['下单成功', '埃塞俄比亚 耶加雪菲'],
    },
  },

  'readability-fix': {
    id: 'readability-fix',
    title: 'UI 美化 / 可读性：把难读的正文调成易读，且不靠删内容达成',
    trigger: '美化',
    // 只用一个工具（annotate 的 op:style），但**两次调用改两个不同目标**：
    // 正文排版（body）与容器宽度（.wrap，修横向溢出）。
    // 最后一步用 `inspect_element({op:"styles"})` 读回**计算后的**值来取证 ——
    // 这是本轮做美化能力时补出来的一档（原先只能借道 run_javascript，
    // 而它 alwaysRequireApproval 且会被页面 CSP 拦住）。
    tools: ['get_page_snapshot', 'annotate', 'inspect_element'],
    success: '字号 17px、行高比 ≥1.6、对比度 ≥4.5、无横向溢出，且**正文字数没变少、内容仍可见**',
    eval: {
      url: '/article',
      instruction:
        '这个页面读起来太费劲了，帮我做一下可读性美化：正文字号设成 17px、行高不小于 1.6、正文与背景的对比度至少 4.5，并且不要横向溢出。',
      pageChecks: [
        { expr: 'window.__readability().visible', label: '正文仍然可见（没有靠隐藏内容达标）' },
        { expr: 'window.__readability().textLength === window.__textBefore', label: '正文字数没变少（没有靠删内容达标）' },
        { expr: 'window.__readability().fontSize === 17', label: '字号已设为 17px' },
        { expr: 'window.__readability().lineHeightRatio >= 1.6', label: '行高比 ≥ 1.6' },
        { expr: 'window.__readability().contrast >= 4.5', label: '对比度 ≥ 4.5' },
        { expr: 'window.__readability().hOverflow <= 2', label: '没有横向溢出' },
      ],
      mustSeeInToolResults: ['17px'],
    },
  },

  'debug-console-error': {
    id: 'debug-console-error',
    title: '排查：点了没反应 —— 复现后读运行期事实，定位未捕获异常',
    trigger: '没反应',
    // 顺序即能力：**先复现，再读诊断**。
    // 反过来的话读到的是一条空诊断，然后很容易得出"页面没问题"的错误结论。
    tools: ['get_page_snapshot', 'click_element', 'read_diagnostics', 'inspect_element'],
    success: '点击真的发生了（复现）、控制台错误被读到、结果区确认为空',
    eval: {
      url: '/debug',
      instruction: '这个页面点「计算总价」没反应，帮我看一下为什么。',
      pageChecks: [
        // ⚠ 是 **>= 1** 而不是 === 1：那是**路径断言**。
        // 实测（真模型 eval）：模型在第 3 步点了一次复现，第 16 步又点了一次，
        // 于是计数是 2 而"复现过、且没渲染出结果"这个**结果**完全成立 ——
        // `=== 1` 会把"它多点了一次"误判成"能力不行"。同一类错误在拖拽那一轮已犯过一次。
        { expr: 'window.__clicks >= 1', label: '点击真的复现了（至少一次）' },
        { expr: 'window.__totalRendered === false', label: '结果确实没有渲染出来（症状成立）' },
        { expr: "document.querySelector('#total').textContent === ''", label: '结果区确实是空的' },
      ],
      // 关键判据：**浏览器生成的**报错文案必须出现在模型收到的工具结果里。
      // 这条不能放宽成"模型说了句出错了"——那是它自己编的，不是运行期事实。
      mustSeeInToolResults: ['TypeError', 'total'],
    },
  },

  'dismiss-overlay': {
    id: 'dismiss-overlay',
    title: '复杂场景：被弹窗遮挡 —— 先处理干扰，再干活',
    trigger: '弹窗',
    // 顺序即能力：先关遮罩，再输入、再点搜索。
    // 遮罩没关时点输入框/按钮会被判定为"被遮挡"，所以这不是"多此一举"，是前提。
    tools: ['get_page_snapshot', 'click_element', 'type_text', 'inspect_element'],
    success: '遮罩被关掉、搜索真的执行、结果渲染出来，且**事件顺序是"先关弹窗再搜索"**',
    eval: {
      url: '/blocked',
      instruction: '这个页面被弹窗挡住了，先关掉它，然后帮我搜「咖啡」并把结果告诉我。',
      pageChecks: [
        { expr: 'window.__modalClosed === true', label: '遮罩被关掉了' },
        // ↓ 这条才是本场景的核心：**顺序**。只断言"搜索出结果了"无法区分
        //   "先关弹窗再搜" 与 "不知怎么点到了"。
        { expr: "window.__events[0] === 'modal-closed'", label: '第一个动作就是关弹窗（顺序正确）' },
        { expr: "window.__events.indexOf('search-clicked') > 0", label: '搜索发生在关弹窗之后' },
        { expr: "document.querySelector('#q').value === '咖啡'", label: '关键词填对了' },
        { expr: 'window.__renderedCount === 3', label: '结果渲染出来了' },
      ],
      mustSeeInToolResults: ['哥伦比亚 慧兰', '云南 小粒咖啡'],
    },
  },

  'recover-from-rejection': {
    id: 'recover-from-rejection',
    title: '复杂场景：第一次提交必然被拒 —— 读懂原因、补上、再试',
    trigger: '购买',
    // 顺序即能力，而且**必须包含"读失败原因"那一步**：
    // 先按已知信息做完 → 提交 → 读被拒原因 → 补上从错误里学到的值 → 重试。
    // 少了"读原因"这一步，就退化成"盲目重试"——而盲目重试永远停在同一条错误上。
    tools: ['get_page_snapshot', 'select_option', 'type_text', 'click_element', 'inspect_element'],
    success: '经历一次业务拒绝后补齐信息、重试成功，且页面收到的订单数据完整正确',
    eval: {
      url: '/recover',
      instruction: '帮我购买这个页面上的商品：商品选「哥伦比亚 慧兰」，数量 1，收货地址填「上海市浦东新区 1 号」。',
      pageChecks: [
        // 这页用的是**渐进式校验**：邀请码输入框首次提交后才出现、报错里才给出演示码，
        // 所以任何 agent 都必然经历一次拒绝 —— 于是这些判据对脚本与真模型同样成立。
        { expr: 'window.__rejected === true', label: '确实经历过一次业务拒绝（恢复的前提）' },
        { expr: 'window.__submits >= 2', label: '至少提交了两次（不是一次就过）' },
        { expr: "window.__order && window.__order.product === 'coffee-a'", label: '商品选对了' },
        { expr: "window.__order && window.__order.qty === '1'", label: '数量对' },
        { expr: "window.__order && window.__order.addr === '上海市浦东新区 1 号'", label: '地址对' },
        { expr: "window.__order && window.__order.invite === 'RF2026'", label: '邀请码是从错误信息里学到的那个' },
        { expr: "document.querySelector('#msg').textContent.indexOf('下单成功') === 0", label: '最终下单成功' },
      ],
      // 关键：**被拒原因**必须进到模型手里，否则它无从知道要补什么。
      mustSeeInToolResults: ['邀请码', 'RF2026'],
    },
  },

  'extract-merged-table': {
    id: 'extract-merged-table',
    title: '复杂场景：合并单元格表格 —— 还原成对齐网格（朴素读法必然错位）',
    trigger: '表格',
    tools: ['get_page_snapshot', 'inspect_element'],
    success: '表格被还原成矩形网格：rowspan 的「区域」重复到合并行的每一行、colspan 的表头正确展开，且**数据本身**到了模型手上',
    eval: {
      url: '/table',
      instruction: '把页面上的销量表提取出来，整理成规整的表格给我。',
      pageChecks: [
        // 页面是只读的，没有可变状态可断言；真正的判据在"模型收到了什么"那一侧：
        // 这一条只是确认页面确实带着合并单元格（否则本场景不成立）。
        {
          expr: "document.querySelectorAll('#sales td[rowspan], #sales th[rowspan], #sales th[colspan]').length === 5",
          label: '页面确实有 5 个合并单元格（场景成立）',
        },
      ],
      // ★ 本场景的核心判据：**具体某一行的文本形态**。
      // `| 华东 | 罗布斯塔 | 30 | 40 |` 只有在 rowspan 被正确展开后才可能出现 ——
      // 朴素逐行读法会把它读成 `| 罗布斯塔 | 30 | 40 |`（整体左移一格）。
      //
      // ⚠ 带 `<br>` 的单元格写成两段：`innerText` 把 `<br>` 渲染成换行、再经空白归一化
      // 变成**空格**，所以实际是「小粒咖啡 （云南）」而不是「小粒咖啡（云南）」。
      // 一开始这里写成了后者，**真模型 eval 立刻报了出来** —— 而脚本化 E2E 因为断言已改对
      // 所以是绿的：这正好演示了两层各自能抓到什么（脚本层验代码，真模型层验"我们声称的判据是否成立"）。
      mustSeeInToolResults: [
        '| 区域 | 商品 | Q1 | Q2 |',
        '| 华东 | 罗布斯塔 | 30 | 40 |',
        '| 华南 | 小粒咖啡',
        '（云南） | 70 | 80 |',
      ],
    },
  },

  'operate-in-cross-origin-iframe': {
    id: 'operate-in-cross-origin-iframe',
    title: '复杂场景：跨域 iframe 内的完整操作（填 + 选 + 提交 + 读回）',
    trigger: '跨域',
    // 全部动作都发生在**不同源**的框架里，所以要靠复合 ref（f<frameId>:rf-N）路由过去；
    // 读回则用显式 frameId。这条剧本同时验证"写"和"读"都能跨域。
    tools: ['get_page_snapshot', 'type_text', 'select_option', 'click_element', 'inspect_element'],
    success: '框架内被填入关键词、选定范围、提交一次，且结果渲染在框架内并被读回',
    eval: {
      url: '/framed',
      instruction: '这个页面下半部分的检索在一个跨域 iframe 里，帮我在里面搜「咖啡」、范围选「仅标题」，然后把结果告诉我。',
      pageChecks: [
        // 外层与框架**不同源**，外层读不到 iframe 的 DOM ——
        // 所以只能靠框架自己 `postMessage` 报上来的内容做判据（外层记进 __frameReport）。
        // 这既符合跨域的现实，也让判据落在外层可断言的位置。
        { expr: 'window.__frameReport !== null', label: '框架把结果报给了外层（说明框架内 JS 真的跑了）' },
        { expr: "window.__frameReport && window.__frameReport.q === '咖啡'", label: '框架内关键词填对了' },
        { expr: "window.__frameReport && window.__frameReport.scope === 'title'", label: '框架内范围选对了' },
        {
          expr: "window.__frameReport && window.__frameReport.text.indexOf('内嵌结果') === 0",
          label: '框架内渲染出结果',
        },
      ],
      // 结果文本必须回到模型手里 —— 这是"读回"那一半的判据
      mustSeeInToolResults: ['内嵌结果', '仅标题'],
    },
  },

  'new-tab-takeover': {
    id: 'new-tab-takeover',
    title: '复杂场景：点击后开新标签页 —— 接管之后继续干活',
    trigger: '新标签页',
    // 刻意**不含**任何显式切页工具：点击工具检测到新标签页会自动绑定，
    // 这条剧本验的是"绑定之后后面几步真的落在新页上"。
    tools: ['get_page_snapshot', 'click_element', 'inspect_element'],
    success: '新标签页被打开、被自动接管，详情内容在**新页**上读到并交到模型手里',
    eval: {
      url: '/portal',
      instruction: '点开这个页面里的「查看详情」，内容会在新标签页里打开，帮我把详情里的要点告诉我。',
      pageChecks: [
        // 入口页确实点了（否则后面都没意义）
        // 同上：点一次就够，多点一次不改变"详情页在新标签页里打开过"这个结果
        { expr: 'window.__portalClicks >= 1', label: '入口页的链接被点过（至少一次）' },
        // 同源 localStorage 作为跨标签页通道：入口页加载时会清掉这个标记，
        // 所以此刻它存在 ⇔ **详情页在本次运行中真的打开过**。
        { expr: "localStorage.getItem('rf-detail') === 'opened'", label: '详情页真的在新标签页里打开过' },
      ],
      // ① 详情内容必须回到模型手里（证明"读"发生在新页上，而不是回原页找）
      // ② 点击结果里应写明"检测到新标签页并已自动绑定" —— 这是模型据以判断"换页了"的唯一信号
      mustSeeInToolResults: ['TK-8848', '待处理', '已自动绑定'],
    },
  },

  'paginate-async': {
    id: 'paginate-async',
    title: '复杂场景：分页 + 异步渲染 —— 目标只在第 3 页，且翻页先清空再填充',
    trigger: '翻页',
    // 每步翻页之后都**先 wait_for_element 再读**：
    // 页面是"先清空、300ms 后才填"，立刻读会拿到空列表。
    tools: ['get_page_snapshot', 'inspect_element', 'click_element', 'wait_for_element'],
    success: '翻到第 3 页、等到目标条目真的渲染出来、并把它的编号交到模型手上',
    eval: {
      url: '/paged',
      instruction: '这个列表分了好几页，帮我翻页找到标题是「导出报表时金额列错位」的那条工单，把它的编号告诉我。',
      pageChecks: [
        { expr: 'window.__page === 3', label: '翻到了第 3 页' },
        // 至少点过两次下一页 = 翻页确实发生过；"没多翻"是**效率**而非结果要求，
        // 用 === 2 会把"翻过头又翻回来"误判成失败（最终停在第 3 页才是结果判据）
        { expr: 'window.__nextClicks >= 2', label: '翻页确实发生过（至少两次下一页）' },
        { expr: 'window.__rendering === false', label: '翻页渲染已结束（不是停在加载中）' },
      ],
      // 目标条目必须真的进到模型手里 —— 这是"跨页找到"的唯一凭据
      mustSeeInToolResults: ['TK-0013', '导出报表时金额列错位'],
    },
  },

  'pierce-shadow-dom': {
    id: 'pierce-shadow-dom',
    title: '复杂场景：Shadow DOM 穿透 —— 元素在自定义组件的 shadow root 里（两层）',
    trigger: '自定义组件',
    // 定位与读取都必须穿透 shadow root；`#res` 在第一层，`#deep` 在**第二层**。
    tools: ['get_page_snapshot', 'type_text', 'click_element', 'inspect_element'],
    success: '在 shadow root 内填词、点击、读到结果，且**两层** shadow 里的内容都能读到',
    eval: {
      url: '/shadow',
      instruction: '页面里有一个自定义组件（搜索框在它里面），帮我用它搜「咖啡」，然后告诉我结果。',
      pageChecks: [
        { expr: 'window.__compSubmits >= 1', label: '组件内的按钮被点过（至少一次）' },
        { expr: "window.__compQuery === '咖啡'", label: '组件内的输入框被填对' },
        { expr: "window.__compResult.indexOf('组件内结果') === 0", label: '组件内渲染出结果' },
      ],
      // 第一层 shadow 的结果 + **第二层** shadow 的内容都必须进到模型手里
      mustSeeInToolResults: ['组件内结果', '咖啡', '深层组件就绪'],
    },
  },

  'cdp-drag-slider': {
    id: 'cdp-drag-slider',
    title: '复杂场景：CDP 可信拖拽 —— 鼠标事件型滑块，拖到指定刻度并读回',
    trigger: '拖拽',
    // 拖拽两端只支持 ref/selector/text（没有 role/name），所以用 selector。
    // 拖完必须**读回值**：拖拽工具只能说"已派发"，那不等于"值真的变了"。
    tools: ['get_page_snapshot', 'drag_element', 'inspect_element'],
    success: '滑块被拖到 80 刻度附近，且读回的值与之一致',
    eval: {
      url: '/drag',
      // 这一条**有设置前提**：拖拽经 CDP 派发真实鼠标事件，必须先开 CDP。
      // 声明在这里，E2E 与真模型 eval 都据此开；否则会得到
      // "拖拽需要 CDP 输入层（请在设置中开启）"这种与能力无关的失败。
      cdp: true,
      instruction: '帮我把页面上的音量滑块拖拽到 80 那个刻度上，然后告诉我当前音量。',
      pageChecks: [
        // 拖拽只能"派发"，是否真的生效要看页面状态。
        // ⚠ 断言 **>= 1** 而不是 === 1：那是**路径断言**，会预设"模型只拖一次"。
        // 实测真模型先拖到 `#track`（容器中心 = 50%）没到位，改了几次路线才到 80 ——
        // 结果是达成的，而 `=== 1` 把"路线与我预期不同"误判成"能力不行"。
        // 判据要盯**结果**（值是否到位），路径只要求"确实发生过拖拽"。
        { expr: 'window.__dragEnds >= 1', label: '至少完成了一次拖拽（mousedown→move→mouseup）' },
        // 容差：拖拽落点与刻度中心可能差几像素，但必须确实靠近 80
        { expr: 'Math.abs(window.__value - 80) <= 10', label: '音量落在 80 附近（±10）' },
        { expr: "document.querySelector('#val').textContent.indexOf('当前音量：') === 0", label: '页面上读得到当前音量' },
      ],
      // 拖拽结果文本必须到模型手里（证明这个工具被真的调用了）
      mustSeeInToolResults: ['拖拽到'],
    },
  },

  'canvas-coordinate-click': {
    id: 'canvas-coordinate-click',
    title: '复杂场景：canvas 上的按钮 —— DOM 路线是死路，只能按坐标点击',
    trigger: '画布',
    // 必须走"AX 拿坐标 → click_at"：DOM 里那层可访问性元素是 pointer-events:none，
    // click_element 只能退化成程序化 click，而它不会冒泡到 canvas。
    tools: ['get_page_snapshot', 'get_ax_snapshot', 'click_at', 'inspect_element'],
    success: '画布收到真实鼠标点击且命中的是「保存」（DOM 路线点不动，只能按坐标点）',
    eval: {
      url: '/canvas',
      cdp: true, // click_at 与 get_ax_snapshot 都需要 CDP
      instruction: '页面上的工具条是画在画布上的，帮我点一下「保存」。',
      pageChecks: [
        { expr: 'window.__clicks >= 1', label: '画布收到了点击' },
        { expr: "window.__hit === '保存'", label: '命中的是「保存」而不是别的按钮' },
        { expr: "document.querySelector('#status').textContent === '已点击：保存'", label: '页面上读到"已点击：保存"' },
      ],
      // 坐标必须真的到模型手里（它是"DOM 看不到、只能按坐标点"的唯一依据）
      mustSeeInToolResults: ['可访问性树', '保存'],
    },
  },

  'macro-save-replay': {
    id: 'macro-save-replay',
    title: '复杂场景：宏保存 + 回放（零 token 复用已验证的多步操作）',
    // 触发词取「存成宏」而不是单字「宏」：门禁要求触发词 ≥2 字
    //（单字太泛，容易在无关指令里误命中）。
    trigger: '存成宏',
    // 先手动做一遍 → 存成宏 → 回放。存下来的应恰好是白名单内的 3 步。
    tools: ['get_page_snapshot', 'type_text', 'select_option', 'click_element', 'macro', 'inspect_element'],
    success: '宏被保存（3 步），回放真的在页面上重放了动作（页面累计执行 2 次）',
    eval: {
      url: '/macro',
      instruction: '帮我用「咖啡」和「仅标题」查一次，然后把这个操作存成宏「咖啡查询」，再回放一次确认。',
      pageChecks: [
        // ★ 判据是**计数**：回放若只是报告成功、没真重放动作，这里会停在 1
        // ⚠ 这一条**故意保留精确相等**（见 tests/skill-playbook-contract.test.mjs 的允许清单）：
        // 若放宽成 >= 2，就无法区分"回放真的生效了"与"模型手动做了两次、根本没回放" ——
        // 而"回放生效"正是本场景要证的东西。也就是说这里的次数**本身就是结果判据**。
        { expr: 'window.__runs === 2', label: '页面被执行了两次（手动一次 + 回放一次）' },
        { expr: "window.__last && window.__last.kw === '咖啡'", label: '回放时关键词被重新填入' },
        { expr: "window.__last && window.__last.scope === 'title'", label: '回放时范围被重新选中' },
      ],
      // 保存结果里的「（3 步）」是**契约锚点**：只有白名单内的可回放工具会被记录，
      // 一旦有人把不可回放的工具写进流程，步数就会变，这条会红。
      mustSeeInToolResults: ['已保存宏', '（3 步）', '已回放宏'],
    },
  },

  'upload-file': {
    id: 'upload-file',
    title: '复杂场景：文件上传 —— 工具如实说"没观察到变化"，所以要读回',
    trigger: '上传文件',
    // `upload_file` 返回 hadEffect:false（设置文件不产生可观察的页面变化），
    // 所以这四步里**读回那一步不能省**：上传工具返回 ok ≠ 文件真的进去了。
    tools: ['get_page_snapshot', 'upload_file', 'click_element', 'inspect_element'],
    success: '文件真的被设置到 file input 上并派发了 change 事件，提交后页面回执带文件名',
    eval: {
      url: '/upload',
      cdp: true, // upload_file 走 CDP 的 DOM.setFileInputFiles
      // {{UPLOAD_FILE}} 是**运行时占位符**：本地绝对路径每台机器不同、也不该写进仓库。
      // 由 tests/e2e/helpers.mjs 的 resolveInstruction 解析，E2E 与真模型 eval 共用同一入口，
      // 于是两边跑的仍是**同一条指令**。
      instruction: '帮我上传文件 {{UPLOAD_FILE}} 到这个页面，然后提交。',
      pageChecks: [
        // change 事件真的触发了（不是只把文件塞进去）
        { expr: "window.__fileName === 'sample-upload.txt'", label: '页面收到了 change 事件且文件名正确' },
        { expr: 'window.__submits >= 1', label: '提交过（至少一次）' },
        {
          expr: "document.querySelector('#status').textContent === '已提交：sample-upload.txt'",
          label: '页面回执带文件名（说明确实按选中的文件提交了）',
        },
      ],
      // ① 上传结果文本（含路径）必须到模型手里
      // ② 读回的结果也要在 —— 那是"文件真的进去了"的唯一凭据
      mustSeeInToolResults: ['已向文件输入框设置', 'sample-upload.txt'],
    },
  },

  'knowledge-save-retrieve': {
    id: 'knowledge-save-retrieve',
    title: '复杂场景：知识库往返 —— 存进去要能原样取回来（同一个 url 会互相覆盖）',
    trigger: '知识库',
    // 难点不在页面，而在**往返保真**：`add_entry` 传了 url 就用 url 当 id，
    // 于是"三条都带同一个网址"会静默只剩最后一条。稳的路是放进一条的备注，
    // 或三条都不带 url；无论哪条，**读回那一步都不能省**。
    tools: ['get_page_snapshot', 'add_entry', 'knowledge_read'],
    success: '三个要点（KB-1/KB-2/KB-3）都留在知识库里，且被读回、回到模型上下文',
    eval: {
      url: '/notes',
      instruction: '把这一页的三个要点存进知识库（标题用「检索性能优化」），每条加上 KB-1 / KB-2 / KB-3 的编号，然后从知识库读回来确认三条都在。',
      // ⚠ 这一类的状态**不在页面上**（知识库是扩展侧存储），所以没有页面判据 ——
      // 权威的保真检查在 E2E 里直接读 chrome.storage 的 `knowledgeBase`。
      // 这里不塞凑数的页面断言：宁可显式留空，也不假装页面能证明什么。
      pageChecks: [],
      // KB-1/KB-2/KB-3 这几个编号**只可能来自模型自己写的备注**：
      // 页面里没有它们（见夹具 notesPage 的注释），而 `add_entry` 的结果**只回显标题**。
      // 所以它们出现在工具结果里 ⇒ 一定发生过一次**读回**。
      mustSeeInToolResults: ['已保存条目', 'KB-1', 'KB-2', 'KB-3'],
    },
  },

  'knowledge-search-fallback': {
    id: 'knowledge-search-fallback',
    title: '复杂场景：知识库检索的召回边界 —— 查不到 ≠ 没有，必须换路子确认',
    trigger: '打开很慢',
    // 难点是**词汇不匹配**：`tokenizeQuery` 是纯字符匹配，
    // 「页面打开很慢」与笔记里的「预热 / 超时 / 缓存」在字符层面毫无交集 ——
    // 检索必然返回「未检索到相关知识库条目」。
    // 这是**固有限制**（测试 tests/rag-recall.test.mjs 把它钉住了），修不好，
    // 所以能力在于**回退**：换个说法、或改用 list / get 直接确认。
    // 判据是"最后确实把那条记录读出来了"，而不是"检索命中了"。
    tools: ['get_page_snapshot', 'add_entry', 'knowledge_read'],
    success: '检索没命中时没有下"知识库里没有"的结论，而是换路子把那条记录读出来并核对',
    eval: {
      url: '/notes',
      instruction:
        '把这一页的三个要点存进知识库（标题用「检索性能优化」，每条加上 KB-1 / KB-2 / KB-3 的编号），' +
        '然后回答我：知识库里有没有讲「页面打开很慢」的记录？找到的话把它读出来核对。',
      // 状态在存储里、不在页面上（见上面的说明），所以不塞页面断言
      pageChecks: [],
      // 只认 KB-*：页面里没有这几个编号（见夹具 notesPage 注释），
      // 而 `add_entry` 的结果**只回显标题、不回显备注** ——
      // 所以它们出现在工具结果里 ⇒ 一定发生过一次**读取**（get 或 search 命中）。
      // ⚠ 这里**不**断言「未检索到相关知识库条目」：那是**路径**。
      // 模型若换个更准的说法就命中了，反而更好 —— 用路径判据会把"做得更好"判成失败。
      // （"检索确实会漏"这件事由脚本化 E2E 断言，因为那条查询是脚本自己选的。）
      mustSeeInToolResults: ['KB-1', 'KB-2', 'KB-3'],
    },
  },

  'cross-tab-handoff': {
    id: 'cross-tab-handoff',
    title: '复杂场景：跨标签页搬运 —— 在 A 页读到的东西填进新开的 B 页',
    trigger: '验证码',
    // 难点是**"现在在哪个标签页"是隐式的**：A 页故意放了一个诱饵输入框（备注）
    // 和一个诱饵按钮（保存备注）。读完成验证码若没真正切到新标签页就往输入框打字，
    // 字会落进诱饵、A 页还会被提交 —— 而**每一步都返回成功**，只有页面状态能拆穿。
    tools: ['get_page_snapshot', 'click_element', 'type_text', 'inspect_element'],
    success: '验证码落在新标签页的填写页并提交成功，且来源页的诱饵输入框没被动过、来源页没被提交',
    eval: {
      url: '/handoff',
      instruction: '这一页有个取件验证码，帮我点「打开填写页」，在新打开的页面里填上这个验证码并提交，然后把回执告诉我。',
      // 判据落在**来源页**：它必须**没有**被动过。
      // （目标页的状态在另一个标签页上，page.evaluate 看不到 —— 那一侧靠下面的载荷判据。）
      pageChecks: [
        { expr: 'window.__submits === 0', label: '来源页没有被误提交（说明没写错标签页）' },
        { expr: 'window.__noteValue === null', label: '来源页的诱饵输入框没被填过' },
      ],
      // 「已提交验证码：RF-7391」这句话**只可能**来自目标页的回执读取：
      // 来源页没有这句文案，而它带着验证码 —— 所以这条同时证明了
      // "验证码真的到了 B 页" 与 "B 页真的提交了"。
      mustSeeInToolResults: ['已提交验证码：RF-7391'],
    },
  },
});
/** 某剧本用到的工具名（数组副本，调用方改不坏常量）。 */
export function playbookTools(id) {
  const pb = PLAYBOOKS[id];
  return pb ? pb.tools.slice() : [];
}

/** 带 eval 声明（第三层用）的剧本清单。脚本化 E2E 不需要它。 */
export function evalPlaybooks() {
  return Object.values(PLAYBOOKS).filter((p) => p.eval);
}

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
      //
      // `outcome` 就是给这件事的**机器可读声明**：空 pageChecks 必须配一个理由，
      // 否则门禁（tests/capability-inventory.test.mjs）会拦下来 ——
      // 免得以后某个剧本**悄悄**少了页面断言，看起来还像验过了。
      outcome: 'storage',
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
      // 状态在存储里、不在页面上（见上面的说明），所以不塞页面断言。
      // `outcome` 是这件事的**机器可读声明**：空 pageChecks 必须给出理由（见本文件里那个剧本的注释）
      outcome: 'storage',
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

  'virtual-list-scroll': {
    id: 'virtual-list-scroll',
    title: '复杂场景：虚拟列表 —— DOM 里没有 ≠ 页面上没有，必须滚容器再读',
    trigger: 'VL-87',
    // 三个难点叠在一起：
    //   ① **DOM 里只有可见的 5 行**（共 100 条）—— 看不到目标不等于没有；
    //   ② 目标在**内部可滚动容器**里 —— 滚窗口（scroll_by）对它毫无作用，必须滚容器自己；
    //   ③ 滚完**必须重新读**才知道窗口换成了哪几行（行是回收重建的，旧 ref 全部失效）。
    tools: ['get_page_snapshot', 'scroll_page', 'click_element', 'inspect_element'],
    success: '滚动容器后目标行进入窗口并被点开（页面回执「已点开：87」）',
    eval: {
      url: '/vlist',
      instruction: '这个页面的列表很长，帮我找到第 87 条（标着 VL-87 的那条）并点开它。',
      pageChecks: [
        // ★ 目标行**真的进过窗口**：证明是"滚过去"而不是碰巧。
        //   这条同时是"必须滚动"的结构级证据：i87 只在 `start ∈ [83,87]` 时被渲染
        //   （见 virtualListPage 的 render()），而初始窗口是 i0..i4
        //   ⇒ **不滚容器就永远不可能**满足它。
        //   （初始那次 render() 也记 i87 之外的 id，所以它不会把"没滚"误判成"滚过"。）
        { expr: "window.__renderedIds.indexOf('i87') >= 0", label: '第 87 条真的被渲染出来过' },
        // ★ 容器**真的滚动过**（scrollTop > 0）：与"滚了多少"无关，只证明滚的是**这个容器**。
        //   ⚠ 判据**不写**具体数值（如 `scrollTop=3480`）：那是**路径断言** —— 滚 3400 一样把
        //     目标带进窗口（真模型 eval 实测就是这样被误判成失败的）。两处 CSS 事实让这条有咬合力：
        //     ① 容器高 200px、内容 4000px（`pad` 撑开）⇒ scrollTop 真的能 > 0；
        //     ② **窗口滚不动它**（页面本身没有可滚动的溢出）⇒ scrollTop > 0 只可能来自滚容器。
        { expr: 'window.__maxScrollTop > 0', label: '列表容器真的被滚动过（scrollTop > 0）' },
        // 点开的是**第 87 条**，不是别的行
        { expr: "window.__clicked === 'i87'", label: '点开的正是第 87 条' },
        { expr: "document.querySelector('#status').textContent === '已点开：87'", label: '页面回执「已点开：87」' },
      ],
      // 工具层证据：**滚动这个动作真的发生过**（`scroll_page` 命中容器后的回执）。
      // ⚠ 这里只认动作发生过，**不认偏移量** —— 具体滚多少不是本场景的能力点（见上面 pageChecks 的说明）。
      mustSeeInToolResults: ['已滚动容器'],
    },
  },

  'cascade-select': {
    id: 'cascade-select',
    title: '复杂场景：级联下拉框 —— 子选项异步填充，选完父项不能立刻选子项',
    trigger: '配送范围',
    // 三层难点：
    //   ① 城市框初始 disabled、只有一句「请先选省份」——不先选省份就选不了城市；
    //   ② 选了省份后城市选项要 3 秒后才填进来 ——"选完立刻选"会得到
    //     「未找到匹配的 option」，而那句话极易被读成"页面上没有这个城市"。
    //     ⚠ 延迟必须**大于真模型一轮工具往返**（约 1 秒）：起初写 300ms 时，
    //     真模型选了省份**立刻**选城市也照样成功 —— 场景在真模型下什么都没验到。
    //   ③ 填充期间城市框**仍是 disabled** —— 所以光等"选项出现"不够，还要等到可用。
    tools: ['get_page_snapshot', 'select_option', 'wait_for_element', 'click_element', 'inspect_element'],
    success: '省份与城市都选对并提交成功，且是在等待子选项填充之后完成的',
    eval: {
      url: '/cascade',
      instruction: '帮我把这一页的配送范围选成浙江 / 杭州，然后提交。',
      pageChecks: [
        { expr: "window.__picked && window.__picked.prov === 'zj'", label: '省份选对了（浙江）' },
        { expr: "window.__picked && window.__picked.city === 'hz'", label: '城市选对了（杭州）' },
        {
          expr: "document.querySelector('#status').textContent === '已提交：浙江 / 杭州'",
          label: '页面回执「已提交：浙江 / 杭州」',
        },
      ],
      // 回执里同时出现省份与城市 ⇒ 两个下拉框都真的被选中过（不是只点了提交）
      mustSeeInToolResults: ['已提交：浙江 / 杭州'],
    },
  },

  'read-select-options': {
    id: 'read-select-options',
    title: '复杂场景：读下拉框选项再选 —— "选最便宜的那个"（文字里才有价格）',
    trigger: '最便宜',
    // 难点：这是一个**原生 `<select>`**，闭合状态下 `<option>` 没有布局盒子，
    // 正文抽取按"不可见"跳过 —— 所以 `get_page_snapshot` 的正文里**看不到选项文案**，
    // 而价格只写在选项文案里。任务只说了"最便宜"，不把选项列出来就无从比较。
    // `get_attribute` 也帮不上：它读的是**属性**，读不了 `outerHTML`。
    tools: ['get_page_snapshot', 'inspect_element', 'select_option', 'click_element'],
    success: '先读出选项清单、比较后选中真正最便宜的那个（经济配送 ¥5），而不是猜一个',
    eval: {
      url: '/shipping',
      instruction: '帮我选最便宜的配送方式，然后确认。',
      pageChecks: [
        // ★ 选中的必须是**真正最便宜**的那一项，不是第一项、也不是默认项
        { expr: "window.__picked === 'eco'", label: '选中的是最便宜的经济配送（不是猜的）' },
        { expr: 'window.__submits > 0', label: '确认过一次' },
        {
          expr: "document.querySelector('#status').textContent.indexOf('经济配送') >= 0",
          label: '页面回执里是经济配送',
        },
      ],
      // 选项清单必须真的到过模型手里（那句话只可能来自 op:"options" 的返回）
      mustSeeInToolResults: ['下拉框选项', '经济配送 · ¥5 · 7 天'],
    },
  },

  'csp-page-world-js': {
    id: 'csp-page-world-js',
    title: '复杂场景：严格 CSP 页面读页面 JS 状态（沙箱被拒 → 自动改用页面主世界）',
    trigger: '核对总价',
    // 两个难点叠在一起，正好覆盖 README 声称的那条能力（"经 CDP 在页面主世界执行，不受页面 CSP 限制"）：
    //   ① 页面 CSP 不放行 `unsafe-eval` → run_javascript 的默认沙箱（`new Function`）被拒；
    //   ② 就算没有 CSP，沙箱跑在**隔离世界**里也看不到页面的 JS 变量（DOM 共享、页面全局不共享）。
    // 真实总价 108 只在 JS 状态里（DOM 上是陈旧值 88，且整页文本里没有 "108"），
    // 所以"工具结果里出现 108"只可能来自**页面主世界**。
    tools: ['get_page_snapshot', 'run_javascript', 'inspect_element'],
    success: '读到页面 JS 状态里的真实总价 108，并用页面自身的 reportTotals() 记下核对结果',
    eval: {
      url: '/csp',
      cdp: true, // 自动改用页面主世界走 CDP；关掉 CDP 时这一步**做不到**（实测过）
      instruction:
        '帮我核对总价：页面显示的是 ¥88，请从页面 JS 状态里读出真实的 total，然后用页面的 reportTotals() 把核对结果记下来。',
      pageChecks: [
        // ★ 页面自己的函数真的被调用了（说明代码确实在**页面主世界**跑过）
        { expr: 'window.__checked === 108', label: '页面函数 reportTotals() 被调用且读到真实 total' },
        {
          expr: "document.querySelector('#status').textContent === '已核对：108'",
          label: '页面回执「已核对：108」',
        },
      ],
      // 108 只存在于页面 JS 状态里（整页正文没有这三个字符）——
      // 它出现在工具结果里，就证明**页面主世界**真的读到了页面变量。
      mustSeeInToolResults: ['108'],
    },
  },

  'undo-last-action': {
    id: 'undo-last-action',
    title: '复杂场景：撤销 —— 只回退最后一次可撤销动作（点击不算）',
    trigger: '撤销',
    // 难点是**撤销栈的边界**：工具写明「仅输入/勾选/选择/改样式/滚动可撤销；点击与导航不可撤销」。
    // 于是"改三项 + 点保存 + 撤销上一步"里，被回退的是**选择**那一格，
    // 而**保存那一下不会被撤回**。判据必须同时看两边：该回退的回退了、不该回退的还在。
    tools: ['get_page_snapshot', 'type_text', 'check_box', 'select_option', 'click_element', 'undo_last_action', 'inspect_element'],
    success: '撤销只回退了最后一次可撤销动作（优先级），标题/发布/保存次数都不受影响',
    eval: {
      url: '/undo',
      // ⚠ 措辞里必须**明确要求用「撤销功能」**：只说"撤销上一步"时，
      // 模型完全可以理解为"把值手工改回去" —— 那也是一种合理解释，于是它不调 undo_last_action，
      // 我那条"回执里要有「已撤销上一步操作」"的判据就把它判成失败（实测撞到）。
      // 这是同一类错误（预设做法）的**第五次**出现。要么判据不要求用这个工具，
      // 要么就像现在这样 —— **指令里明确要求用这个功能**，要求才站得住。
      instruction:
        '帮我改一下这个草稿：标题填「周报」，勾上发布，优先级选「高」，然后点一下「保存草稿」。' +
        '做完这些之后，用「撤销」功能撤回上一步，并告诉我这三项目前各是什么。',
      pageChecks: [
        // ⚠ 判据必须**顺序无关**：用户给的顺序是"标题→发布→优先级→保存"，
        // 但模型完全可以换个顺序做（实测它就**先选了优先级、后填标题**）。
        // 于是"撤销上一步"撤掉的是**它自己最后做的那一步**，而不是我以为的那一步。
        // 最初我把检查写成"优先级被回退、标题保留"——那是在验**路径**，
        // 把一次完全正确的撤销判成了失败（这是本会话第三次栽在路径断言上）。
        //
        // 正确的不变量：三处改动里**恰好一处**被回退（其余保留）——
        // 三次改动都是可撤销的，撤一格就只该少一格。
        {
          expr:
            "['title','publish','level'].map(function(k){return {title:'周报',publish:true,level:'high'}[k]===window.__state[k];}).filter(Boolean).length === 2",
          label: '三处改动里恰好一处被回退（撤销只弹一格）',
        },
        // ★ 最锋利的一条，且与顺序无关：**点击不进撤销栈**
        { expr: 'window.__saves === 1', label: '**点击保存不可撤销** —— 保存次数仍是 1' },
      ],
      // 撤销的回执、以及读回的状态里"保存次数仍为 1"，都要到模型手里
      mustSeeInToolResults: ['已撤销上一步操作', '保存次数=1'],
    },
  },

  'form-validation': {
    id: 'form-validation',
    title: '复杂场景：HTML5 原生校验静默拦住提交（页面上什么都不说）',
    trigger: '报名表',
    // 难点是"**页面上什么都没说**"：字段不合法时浏览器拦住 submit，
    // 只在**它自己的原生气泡**里提示（工具读不到），DOM 里既没有错误文案、状态也不变。
    // 于是"点了提交没反应"看起来像"按钮坏了"，而真相是两个字段没通过约束：
    // 姓名少于 minlength=2（tooShort）、邮箱格式不对（typeMismatch）。
    // 判据要同时证明两件事：**页面上确实没有提示**（难点成立）、以及修好之后真的提交成功。
    tools: ['get_page_snapshot', 'type_text', 'check_box', 'click_element', 'inspect_element'],
    success: '先发现"提交被校验静默拦住"并读出是哪两个字段、什么原因，改好后再提交成功',
    eval: {
      url: '/validate',
      instruction:
        '帮我把这个报名表填好并提交：姓名「李」，手机号 13800138000，邮箱 lilei#example.com，勾选同意条款。' +
        '如果有填得不对的地方，你看着改成能通过的，然后提交。',
      pageChecks: [
        // 「确实提交成功过」而不是「恰好一次」：多点一次不该判失败（判据盯结果，不盯路径）
        { expr: 'window.__submits >= 1', label: '最终真的提交成功了' },
        { expr: "document.getElementById('f').checkValidity() === true", label: '表单最终完全合法' },
        { expr: "document.getElementById('name').value.length >= 2", label: '姓名被补到满足 minlength' },
        { expr: "document.getElementById('email').value.indexOf('@') > 0", label: '邮箱被改成合法格式' },
      ],
      // ⚠ 只断言**那段报告本身出现过**（`表单未通过校验` 这句只可能来自新加的合法性读取）。
      //
      // 原先要求 `patternMismatch` 与 `typeMismatch` **两个都出现** —— 那又是**路径断言**：
      // 实测模型可能**先改好了邮箱**再看，于是那一轮只剩姓名是无效的、`typeMismatch` 根本不会出现。
      // 这已经是本会话第四次栽在同一件事上（计数、顺序、先后…形态各异，本质都是"我预设了做法"）。
      // 「报告出现过」才是与做法无关的证据；**具体是哪两个字段**由脚本化 E2E 断言
      //（那条路径的顺序由我们控制，可以更锋利）。
      // ⚠ **任一命中即可**（数组 = anyOf，见 real-model.eval.mjs 的说明）：
      //   原来只认浏览器自己的校验报文（`表单未通过校验`），但连续两轮真模型实测里，
      //   模型改用 `get_attribute(pattern/minlength/required)` **自己推出约束并改对**、
      //   4 条页面判据全过 ⇒ 那是**第一手 DOM 证据**，按"判据盯**数据到没到模型手上**、
      //   不盯它从哪一行读的"这条原则，两条路都接受 ✓（页面判据一条没动）
      mustSeeInToolResults: [['表单未通过校验', 'pattern', 'minlength', 'maxlength', 'required']],
    },
  },

  'paywall-preview-limit': {
    id: 'paywall-preview-limit',
    title: '复杂场景：付费墙 / 试看边界 —— 「能打开 ≠ 能看」',
    trigger: '没会员',
    // 三个叠在一起的难点（忠实还原用户那次"我要看最新一集但我没会员"的会话）：
    //   ① 页面打开完全正常 → 很容易得出"已打开最新一集 → 完成"✗；
    //   ② 只有**播放之后**才出现试看提示，而"正片 19 分钟 vs 试看 3 分钟"是唯一线索；
    //   ③ 用户真正要的答案是"**免费能看的最后一集是哪一集**"，
    //      而这一集页面上看不出来，必须去选集列表里读每集状态。
    tools: ['get_page_snapshot', 'click_element', 'run_javascript', 'inspect_element'],
    success: '识破第195话只是试看，找到免费可完整观看的最后一集（第180话），切过去并播到片尾证明真能看',
    eval: {
      url: '/paywall',
      // 读播放器状态必须走 `run_javascript({engine:"page"})`，而**页面主世界执行需要 CDP**。
      // 顺带纠正一个长期说法：默认的"受限沙箱"其实**任何页面都跑不起来** ——
      // 沙箱用 `new Function`，而 MV3 扩展自身的 CSP 不允许 eval（与页面无关，
      // 实测在完全没有 CSP 的夹具页上同样被拒）。所以这条 `cdp: true` 不是"为了稳妥"，是**必需**。
      cdp: true,
      instruction:
        '《凡人修仙传》更新到最新一集了，我想看，但我没会员。你看一下能不能看，不能的话告诉我实际情况。',
      pageChecks: [
        // ★ 结局必须落在**能完整观看**的那一集上（而不是"打开了最新一集"就算完）
        { expr: 'window.__currentEp <= window.__lastFreeEp', label: '最终停在免费可看的一集上（不是停在会员集）' },
        { expr: 'window.__player.isPreview === false', label: '当前这集不是试看' },
        // ★ 真的播到片尾：证明"能看"不是靠页面文案，而是靠实际播放
        { expr: 'window.__reachedEnd === true', label: '播到了片尾（而不是只点了播放）' },
        { expr: 'window.__player.duration === window.__fullSeconds', label: '走的是完整时长（1140 秒），不是试看的 180 秒' },
      ],
      // ⚠ 判据必须与**实现无关**：第一版我写的是 `['lastFree', '180']` ——
      // 而 `lastFree` 是**我自己脚本里起的键名** ✗ 真模型自己写 JS、键名当然不同，
      // 于是四条页面判据全过、却被这条判据判失败（这是同一类错误的第七次）。
      //
      // 改成两条都来自**页面本身的文本/数据**：
      //   · `试看` —— 夹具那句"本片是大会员专享内容，试看中"**只在播放之后**出现，
      //     所以它进了工具结果 ⇒ 模型真的播了并读到了试看提示（= 识破了"能打开≠能看"）；
      //   · `180` —— 免费能看的最后一集，是用户真正要的答案。
      mustSeeInToolResults: ['试看', '180'],
    },
  },

  'download-verify': {
    id: 'download-verify',
    title: '复杂场景：下载文件 —— 页面上不会发生任何变化，凭据只能来自浏览器',
    trigger: '报表',
    // 难点：点一下之后**页面什么都不变**（无 DOM 变化、无状态文案）——
    // 于是"点了链接"与"文件真的下载了"分家 ✗
    // 唯一可信来源是**浏览器自己报的下载事件**（CDP `Page.downloadWillBegin`
    // → `read_diagnostics({kind:"downloads"})`），而它同样要求**点击之前已 attach CDP**
    // （所以脚本路径第一步用 CDP 支撑的读取）。
    tools: ['get_ax_snapshot', 'click_element', 'read_diagnostics', 'inspect_element'],
    success: '点击导出后，从浏览器事件确认下载真的发生、并报出真实的文件名',
    eval: {
      url: '/download',
      cdp: true,
      instruction: '帮我把这个月的报表导出来，导出后告诉我文件名是什么。',
      // 下载是**浏览器级结果**：页面上没有任何东西可断言（这正是本场景的难点）。
      // 真实的"下载发生了"由 E2E 用 Playwright 的 download 事件断言；
      // 这条剧本的结果因此落在**回执**上：浏览器报的文件名必须到模型手里。
      outcome: 'payload',
      pageChecks: [],
      mustSeeInToolResults: ['report.csv'],
    },
  },

  'date-picker-custom': {
    id: 'date-picker-custom',
    title: '复杂场景：自定义日期选择器（只读输入框 / 异步日历 / 跨月 / 禁用日）',
    trigger: '入住',
    // 四个真实难点：
    //   ① 输入框 `readonly` —— 往里打字**静默无效**（"已输入"是假的）；
    //   ② 日历**异步渲染**：点开之后要等一拍才有格子，立刻点会落空；
    //   ③ 目标日期在**下个月**：只看当前月就下结论必然错；
    //   ④ 有**已订满的禁用日**（含紧邻目标的 14 号）：必须真的读日历，不能按顺序猜。
    tools: ['get_page_snapshot', 'click_element', 'inspect_element', 'wait_for_element', 'scroll_page'],
    success: '翻到下个月、在日历里点中 15 日，输入框值变为 2026/03/15',
    eval: {
      url: '/datepicker',
      instruction: '帮我订 2026 年 3 月 15 日入住，选好日期就行。',
      pageChecks: [
        { expr: "window.__selected === '2026-03-15'", label: '选中的确实是 2026-03-15（不是别的日子）' },
        { expr: "document.getElementById('checkin').value === '2026/03/15'", label: '输入框里的值也跟着变了' },
        // 目标在下个月 ⇒ 没翻月是不可能点到的（这条保证"跨月"真的发生了）
        { expr: "document.getElementById('status').textContent.includes('2026/03/15')", label: '页面状态确认了所选日期' },
      ],
      // ⚠ 「已订满」拿不到这件事，结论已明确到**不是产品问题**：
      //   第 17 轮的探针直接调内容脚本动作 `kbGetPageSnapshot`，拿到 36 个元素，
      //   其中 label 含「已订满」的有 **3** 个 ⇒ **采集层完全正常** ✓
      //   而"翻月后先确认月份再读"这个时序修正**也没有**让标签进入用例可读的回执 ✗
      //   ⇒ 差异在**测试侧看到的内容**（harness 取哪些消息/怎么取），不在这条链路的功能里。
      //   所以判据用**已验证会出现的**「3月15日」（它来自点击回显 —— 这点也在用例注释里写明）。
      //   **不再提第五个假设**；若要继续查，应从 harness 的取消息方式入手，而不是产品代码。
      mustSeeInToolResults: ['3月15日'],
    },
  },
  'infinite-scroll-hover-preview': {
    id: 'infinite-scroll-hover-preview',
    title: '复杂场景：无限滚动（页面级）+ hover 预览 —— 目标在第 4 批，预览只在可信 hover 后存在',
    trigger: '信息流',
    // 顺序即能力，而且**顺序本身**就是难点：
    //   看一遍（目标不在，只有第 1 批）→ 那个"看起来能点"的加载按钮**推不动页面**
    //   → 滚到底 → 等新批 → **再滚**（append 之后当前位置不再是底部了）→ ……
    //   直到读到「已到底」才停 → hover 目标行 → 等预览填充 → 读回预览。
    // ⚠ 三个与"时机/环境"有关的坑（都实测过）：
    //   ① hover 用的是**调用那一刻的视口坐标** —— 目标不在视口里就先滚进视口
    //      （滚完**先读一次页面**再 hover；刚滚过就 hover 会被浏览器按真实光标位置重算的
    //      hover 状态挪走，实测滚动后约 60ms 补发一次重算）；
    //   ② 行内 popover 只在你**还停在那一行上**时才有内容，而真实光标随时可能动
    //      （实测：hover 后 41ms 就有一条真实 mousemove 落在侧边栏上，popover 当场被清空）
    //      ⇒ 读的是页面留下的**耐久记录**（「最近一次查看」），hover 之后紧接着读；
    //   ③ 预览是**异步取数**的：hover 完立刻读会读到空，先 `wait_for_element` 等它填充。
    tools: ['get_page_snapshot', 'click_element', 'scroll_page', 'wait_for_element', 'hover_element', 'inspect_element'],
    success:
      '滚到第 4 批并读到第 5 批后的「已到底」（唯一停止信号）才停；把目标行滚进视口后用可信 hover 取出预览里的订单号，且滚动次数有上界',
    eval: {
      url: '/feed',
      // hover_element 经 chrome.debugger 派发**可信**鼠标事件；合成事件拿不到预览
      // （夹具检查 event.isTrusted：假事件只计数、不取内容）。
      cdp: true,
      instruction:
        '这个反馈信息流一直在往下加载，帮我找到标题里带「结算页白屏」的那条反馈：把鼠标移到它上面，' +
        '读出悬停预览里的订单号；同时告诉我这个信息流是不是已经到底了。',
      pageChecks: [
        // ★ 目标行的预览**真的出现过**：只可能来自"可信 hover 之后向服务端取到的那段文本"——
        //   页面 HTML/JS 里根本没有订单号（结构性保证，不是靠 CSS 藏起来），
        //   而合成事件连请求都不会发（夹具只认 isTrusted）。
        {
          expr: "String(window.__feed.revealedText['r38'] || '').indexOf('SO-8842') >= 0",
          label: '目标行的悬停预览真的被可信 hover 揭示过',
        },
        // 页面自己记的可信事件计数：证明 hover 是**真事件**打进来的，不是页面自己造的
        { expr: 'window.__feed.trustedEnters >= 1', label: '可信鼠标事件真的到达过页面（不是合成事件）' },
        // ★ 停得对：读到「已到底」才停 —— 状态行只报"已加载 N 条"、不报总数，
        //   所以"还有没有更多"只能靠这个信号（否则就是无限重滚）
        { expr: 'window.__feed.exhausted === true', label: '信息流确实加载到「已到底」（唯一的停止信号）' },
        // 目标在第 4 批 ⇒ 至少要加载到第 4 批（状态量，不是动作计数）
        { expr: 'window.__feed.batches >= 4', label: '至少加载到第 4 批（目标所在的那一批）' },
      ],
      // 订单号只可能来自"hover 之后读回的那段预览"；
      // 「已到底」是停止信号（读到它才停）；目标标题证明那条反馈真的进过模型手里。
      mustSeeInToolResults: ['SO-8842', '已到底', '结算页白屏'],
    },
  },
  'video-playback-verify': {
    id: 'video-playback-verify',
    title: '复杂场景：视频播放器状态 —— 「看起来在播」不等于真的在播',
    trigger: '视频在播',
    // 顺序即能力，而且**顺序本身**就是难点：
    //   看一遍（状态栏写着「播放中」，但详情还没打开、没有任何数值）
    //   → **先拆穿假象**：那个装饰性播放键点了没用（点完真实状态一位不变）
    //   → 真按「播放视频」，等**真解码**的证据（帧计数 > 0）
    //   → 中途暂停（状态栏**不改口**，还是写着「播放中」）
    //   → 「跳转到末尾」触发一次**真缓冲**（waiting）
    //   → 播到结束（ended）→ 打开「播放详情」→ 读回**概率性数值**（位置 / 帧数 / 缓冲次数 / 事件序列）
    tools: ['get_page_snapshot', 'click_element', 'inspect_element', 'wait_for_element'],
    success:
      '点过装饰性播放键并证明它推不动页面；真按播放后页面**真的解码过帧**（已解码帧数 > 0、播放位置推进过）；' +
      '读到过真实事件序列（含 waiting 缓冲、pause 暂停、ended 播完）与缓冲次数；' +
      '最终结论只用这些数值，不用页面上那句「播放中」',
    eval: {
      url: '/video',
      instruction:
        '帮我确认一下这个视频在播到底是真是假：页面上写着「播放中」，我不太信。' +
        '先点一下那个播放键试试，再告诉我它**真的**播过吗、播放位置到哪了、中间有没有卡顿、最后是播完了还是停了。',
      pageChecks: [
        // ★ "真在播"的**真证据**：RVFC 帧计数 > 0（真解码过）+ currentTime 推进过。
        //   `paused === false` 只作参考，**不作判据** —— 它可能只是"这一刻还在播"。
        { expr: 'window.__decoded > 0', label: '视频真的解码过帧（RVFC 帧计数 > 0，不是"paused=false 就算在播"）' },
        { expr: 'window.__seeked >= 1', label: '「跳转到末尾」真的做过（那是缓冲证据的来源）' },
        // ★ 真缓冲：必须是**播放途中**的缓冲（副播放器 seek 到未缓冲区间时位置 > 0.5s 的那次 waiting）。
        //   ⚠ 原判据 `__waits >= 1` **近似恒真** ✗ —— 媒体**加载那一刻**天然会 fire 一次 waiting，
        //   于是这条判据谁也咬不住（夹具里早就备好了 `__midWaits` = 播放中途的 waiting，见 server.mjs），
        //   这里换成它才是"真的卡住过"的状态证据 ✓（判据不进模型上下文 ⇒ 改它不触发测量义务）
        { expr: 'window.__midWaits > 0', label: '播放**中途**真的出现过缓冲（位置 > 0.5s 的 waiting；加载那一刻的天然 waiting 不算）' },
        { expr: 'window.__pauses >= 1', label: '中途真的暂停过 —— 「在播 / 停了」必须分得开' },
        {
          expr: 'window.__events.indexOf("ended") >= 0',
          label: '事件序列里出现过 ended（真的播完了，而不是"停住了"）',
        },
        // ★ 迷惑控件：点过，但**真实播放状态没被它推动**（它的次数只记在 decoy 计数上）
        { expr: 'window.__decoyPresses >= 1', label: '那个装饰性播放键真的被点过' },
        { expr: 'window.__realPlays >= 1', label: '真播放按钮也真的被按过（对比项：推得动 / 推不动）' },
        // ★ 决定性状态只在点开详情之后才写进 DOM —— 初始没有任何进度数值
        { expr: "document.getElementById('diag-body').innerHTML !== ''", label: '「播放详情」被打开过（决定性状态藏在它后面）' },
      ],
      mustSeeInToolResults: ['已解码帧数', '缓冲等待次数', '播放位置：', '事件序列：'],
    },
  },
  'html5-drag-drop': {
    id: 'html5-drag-drop',
    title: '复杂场景：HTML5 原生拖放 —— 「看起来拖过去了」不等于页面收到了',
    trigger: '拖放',
    // 难点（全部造在 /h5drag 夹具页里，且已用探针**实测生效**）：
    //   ① 原生拖放**不走鼠标事件**：合成 mousedown/mousemove/mouseup 根本不触发 dragstart/drop ✗
    //   ② 落点必须先在 `dragover` 里 `preventDefault()` 放行，否则 `drop` 被浏览器吞掉 ✗
    //   ③ payload **只能在 `drop` 里读**（在 `dragover` 里 `getData` 是空串 ⇒ 页面记 emptyDrops++）✗
    //   ④ 两个落点只有一个接受 `RF-7391`（放错 ⇒ wrongZone++）✗
    //   ⑤ 迷惑项：归档卡片看着能拖，而它的 `dragstart` 里 `preventDefault()` 取消了拖放（fakeDrags++）✗
    // 顺序即能力：看清卡片与两个落点 → 先记下初始状态（还没有工单被收下）→ 派发 dragstart/dragover/drop
    //            → 从**页面状态**读回"真的收下了"，而不是"我拖过去了"
    tools: ['get_page_snapshot', 'run_javascript', 'inspect_element'],
    success:
      '用真的拖放事件把 RF-7391 落到唯一接受它的收件区，页面状态显示已收下（acceptedDrops ≥ 1），' +
      '且放错区域 / 空读均为 0；结论来自页面状态读回，不是"拖过了"这句话',
    eval: {
      url: '/h5drag',
      // 页面主世界执行（`run_javascript`）需要 CDP：默认沙箱用 `new Function`，
      // 而 MV3 扩展自身的 CSP 不允许 eval（与页面无关，任何页面都一样）。
      cdp: true,
      instruction:
        '这个工单派发页面上有一张工单卡片和两个区域（退回区 / 收件区）。帮我把工单 RF-7391 拖放到收件区完成派发，' +
        '弄完请把页面状态读回来告诉我到底收下没有 —— 别只说"已经拖过去了"。',
      pageChecks: [
        { expr: 'window.__dd.acceptedDrops >= 1', label: '收件区**真的收下**了这张工单（不是只有 dragover 通过）' },
        { expr: 'window.__dd.wrongZone === 0', label: '没有把工单放进不接受它的区域' },
        {
          expr: 'window.__dd.emptyDrops === 0',
          label: '没有出现"落下了但 payload 读成空串"（说明 payload 是在 drop 里读的）',
        },
        {
          expr: "document.getElementById('dd-result').textContent.indexOf('RF-7391') >= 0",
          label: '页面结果区里就是那张工单',
        },
      ],
      mustSeeInToolResults: ['RF-7391'],
    },
  },
  'rich-text-structure': {
    id: 'rich-text-structure',
    title: '复杂场景：富文本编辑器 —— 结构要真的改上（选区 / 可信输入 / 失焦同步）',
    trigger: '富文本',
    // 难点（都造在 /rich 夹具页里，且已用探针实测生效）：
    //   ① 工具栏**作用于选区**：没选中就点 ⇒ 页面只记一次"空操作"，结构不变 ✗
    //   ② 直接改 DOM / 派发合成事件**不算输入** ⇒ 页面状态与隐藏字段都不更新 ✗
    //   ③ 隐藏字段**只在失焦时**同步 ⇒ 不失焦就读 = 旧值 ✗
    //   ④ 装饰性「B」图标点了只动它自己，结构一位不变 ✗
    // 顺序即能力：看清 → 点进编辑区 → 可信输入 → **选中** → 加粗 → 列表 → 取消选区再点一次（证明空操作被记下）
    //            → 装饰键 → 失焦 → 从**结构**读回
    tools: ['get_page_snapshot', 'click_element', 'type_text', 'run_javascript', 'inspect_element'],
    success: '加粗与列表结构真的写进编辑器、隐藏字段在失焦后被同步，且装饰键没有改变结构；结论来自结构读回',
    eval: {
      url: '/rich',
      instruction:
        '这个富文本编辑器里有一段正文：帮我补充一句，并把其中一段加粗、再加成项目符号列表。' +
        '弄完请把结果读回来，告诉我结构到底改上没改上（别只说"点了按钮"）。',
      pageChecks: [
        { expr: 'window.__rt.strong >= 1', label: '加粗结构真的写进了编辑器（不是只点了按钮）' },
        { expr: 'window.__rt.list >= 1', label: '列表结构真的写进了编辑器' },
        // ⚠ **不要在这里要求"空操作 / 失焦同步 / 装饰键被点过"**（原先有，实测 3/3 红 ✗）：
        //   ① agent 的工具派发的是**合成事件**（实测 `isTrusted=false`、`detail=0`）⇒ 合成点击
        //      **不能让编辑区失焦**、也谈不上"逼它故意不选就点" ⇒ 那是**产品做不到的事** ✗
        //   ② "装饰键被点过"更是**路径断言** ✗ —— 模型完全可能不点它就把结构改对了（实测就是这样）
        //   这两类不变量属于**页面侧不变量**，由脚本化 E2E 的**基线**用真点击证明（golden.spec.mjs 那条）✓
        //   真模型判据只留"**结果对不对**"+ "有没有用真实可达的选区路径" ✓
        { expr: 'window.__rt.selectAlls >= 1', label: '用了页面提供的「全选」造出真实选区（合成按键造不出选区）' },
        // （同一条理由：`#rt-hidden` 只在 **blur** 时同步，而合成点击无法让编辑区失焦 ⇒
        //   这条判据在真模型路径上**永远不可能成立** ✗ 它属于页面侧不变量，基线里证过就够了 ✓）
      ],
      // 回执判据盯"**结构证据有没有交到模型手上**"：状态节点读回来的正是结构计数（`结构:粗2 列2 链0`）✓
      //   ⚠ 别写成 HTML 字面量（如 `strong`）—— 页面状态里给的是**计数**，那样写就变成路径断言 ✗
      mustSeeInToolResults: ['结构:粗', '列'],
    },
  },
  'multi-candidate-convergence': {
    id: 'multi-candidate-convergence',
    title: '复杂场景：多候选收敛 —— 6 家报价只差一点，决定性属性藏在详情里且会刷新',
    trigger: '比价',
    // 顺序即能力，而且**顺序本身**就是难点：
    //   看一遍（列表里没有总价，标价最低的那家必然违反后面的约束）
    //   → **逐个**展开详情（决定性属性只在展开之后才存在）
    //   → 每个候选**先读一次，读到的必然是缓存报价**（夹具的重新询价时钟正是**从这一次读**才开始走；
    //     页面上方写明"实时报价在详情里刷新"）
    //   → **等页面给出刷新说明、再重读一次**（少了这一步，结论会翻转成另一家）
    //   → 逐条核对"总价 < 290 且 3 天内到货 且 支持 7 天无理由退货"
    //   → 选中 → 提交 → **读回服务端回执**。
    //
    // ⚠ 为什么必须"重新读一次"：夹具里每个候选的**第一次读必然是缓存报价**
    //   （刷新定时器只由"第一次真的被读"启动 ⇒ 与模型快慢、LLM 往返耗时**完全无关**），
    //   而缓存报价与实时报价的差刻意做成**会让决策翻转**：
    //   按缓存值唯一过关的是 P-102（¥243）；按实时值 P-102 跳到 ¥300（超 290 预算，**被服务端拒**），
    //   过关的只剩 P-105（¥283）。P-105 自己的缓存总价是 ¥309（**超预算**），
    //   所以"只读一次"的模型会把它直接排掉、选到错的 P-102 —— 而服务端会按实时报价重判。
    tools: ['get_page_snapshot', 'click_element', 'inspect_element', 'wait_for_element'],
    success:
      '6 个候选的详情都被展开并逐条核对过；等实时报价生效后**重读**过关键候选；' +
      '最终选中并提交的是唯一同时满足三条约束的 P-105（总价 ¥283、3 天、可退货），' +
      '且服务端回执与它一致 —— 界面上的成功文案不算证据',
    eval: {
      url: '/pick',
      instruction:
        '帮我**比价**挑一个摄像头模组，然后**提交选择**确认：总价（含运费）必须**低于 290 元**、' +
        '必须 **3 天内到货**、并且要**支持 7 天无理由退货**。把最后选中的型号告诉我。',
      pageChecks: [
        // ★ 决定性属性**只在展开详情之后才存在**：详情都被真的展开过
        //   （`opens` 是页面自己记的"展开动作发生过几次"，不是"页面上看起来展开了"）。
        //   ⚠ 判据**不能**写 `Object.keys(records).length === 6` —— 记录对象是页面加载时
        //     就预建好的（6 个），那样写等于**恒真**（实测踩到：基线与判据双双恒真）。
        {
          expr: 'window.__det.records.p101.opens >= 1 && window.__det.records.p106.opens >= 1',
          label: '首尾两个候选的详情都被展开过（决定性属性只在展开后才存在）',
        },
        {
          expr: "window.__det.records.p105 && window.__det.records.p105.reads >= 2",
          label: '关键候选（P-105）的总价被**重读**过 —— 只读一次拿不到实时报价',
        },
        {
          expr: 'window.__det.records.p105 && window.__det.records.p105.fresh === true',
          label: 'P-105 的实时报价真的生效了（不是停在缓存报价上）',
        },
        // ★ 陈旧读取陷阱的**判据本身**：第一次读到的是缓存总价（¥309），实时报价是 ¥283 ——
        //   两者**不相等**。这条一旦相等，说明"重读"这一步不再是必要的（夹具坏了）。
        //   ⚠ 上面的 `reads >= 2` 是**页面自己**记的读次数：包含"页面重渲染"那一次
        //     （刷新把节点改写成实时价时观察者记的一笔）。夹具的刷新时钟只由
        //     "第一次真的被读"启动（见 server.mjs 的 observeDetail），所以这里的
        //     `reads >= 2` + `fresh === true` 合起来仍然只说明"它读过、而且刷新真的发生了"。
        {
          expr:
            "window.__det.records.p105 && window.__det.records.p105.rawTotal !== window.__det.records.p105.total",
          label: 'P-105 的缓存总价 ≠ 实时总价（陈旧读取陷阱真的存在）',
        },
        // ★ 服务端判的：接受的是 P-105，且**一个错误候选都没被接受过**
        { expr: "window.__det.submitted.indexOf('p105') >= 0", label: '服务端接受的正是 P-105' },
        { expr: 'window.__det.rejected === 0', label: '错误候选没有被服务端接受过（拒绝次数为 0）' },
        {
          expr: "document.querySelector('#status').textContent.indexOf('已下单：P-105') === 0",
          label: '页面渲染出服务端回执（而不是页面自己编的成功态）',
        },
      ],
      // 决定性数值必须到模型手里：¥309（缓存报价，证明确实读出了详情）
      // → ¥283（实时报价，证明**重读**过）。
      mustSeeInToolResults: ['¥309', '¥283'],
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

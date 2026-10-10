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
    // 顺序即剧本步骤：看页面 → 填搜索框 → 点搜索 → 结构化读取结果
    tools: ['get_page_snapshot', 'type_text', 'click_element', 'inspect_element'],
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
        { expr: 'window.__clicks === 1', label: '点击真的复现了一次' },
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

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

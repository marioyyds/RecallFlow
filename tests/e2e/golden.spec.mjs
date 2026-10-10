// 端到端「黄金任务」测试：真实 Chromium + 加载扩展 + 模拟 LLM（fixtures/server.mjs）。
// 覆盖：意图路由 → 工具调用（role+name 定位）→ 页面动作 → 收尾。
//
// 前置：`node scripts/run-e2e.mjs`（它会检查 Playwright 本体、Chromium 二进制与显示环境）。
// 注意：**必须 headless:false** —— 实测 headless 下 MV3 扩展的 service worker 根本不注册
//（见 playwright.config.mjs 的说明）。
//
// 断线重连那一条**不在本文件**：它需要夹具进入"挂起"模式（第一次 LLM 调用不结束），
// 而本文件其余场景需要流正常结束；混在一起会让"第一次调用"的归属取决于执行顺序、
// 测试时好时坏。那条在 tests/e2e/resume.spec.mjs。
import { test, expect } from '@playwright/test';
import { lastToolResultsText } from './fixtures/server.mjs';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  openPanel,
  sendInstruction,
  clickApproval,
  flowOrder,
  panelStyle,
  panelText,
  PANEL,
} from './helpers.mjs';

let context;

test.beforeAll(async () => {
  context = await launchExtension();
});

test.afterAll(async () => {
  await closeExtension(context);
});

test('golden: 用 role+name 定位并点击页面按钮', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);

  // 打开助手面板（FAB 在 open shadow DOM 内，Playwright CSS 会穿透）
  await sendInstruction(page, '点击提交按钮');

  // 断言页面按钮确实被点击（模拟 LLM 会返回 click_element({role:'button',name:'提交'})）
  await expect.poll(() => page.evaluate(() => window.__clicked), { timeout: 30_000 }).toBe(true);
  await page.close();
});

test('golden: 跨域 iframe 内点击（frame 路由 + f<frameId>: 前缀 ref）', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);

  await sendInstruction(page, '点击框架里的按钮');

  // 模拟 LLM 先 includeFrames 读快照，再按 f<frameId>: 前缀 ref 点击；断言跨域 iframe 内被点击。
  await expect
    .poll(
      async () => {
        const frame = page.frames().find((f) => f.url().includes('7803'));
        if (!frame) return false;
        return frame.evaluate(() => window.__frameClicked === true).catch(() => false);
      },
      { timeout: 40_000 }
    )
    .toBe(true);

  await page.close();
});

// 审批闸门的端到端验证：**拒绝之后副作用必须没有发生**。
//
// 为什么这条重要：审批此前只被单测覆盖到「toolNeedsApproval 返回什么」这一层，
// 而"用户点了拒绝之后，页面到底有没有被改"是另一回事 —— 没人端到端验证过。
// 断言「按钮未被点击」而不是「出现了拒绝提示」，因为前者才是真正要保证的性质：
// 审批的价值在于拦住副作用，不在于弹了个框。
test('golden: 审批拒绝后写操作必须没有发生（副作用为零）', async () => {
  await configureSettings(context, {
    // 关掉「页面命令」类别的自动批准 → click_element 必须逐次征求同意
    toolApprovalPolicy: { read: true, edit: true, commands: false, browser: true, mcp: true },
  });
  const page = await openFixturePage(context);

  await sendInstruction(page, '点提交，但不要批准');

  // 审批框出现 → 点「拒绝」
  await clickApproval(page, 'reject');

  // 给它足够时间把「拒绝」处理完（若闸门失效，这里的点击会真的发生）
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => window.__clicked)).toBe(false);
  expect(await page.title()).toBe('夹具主站');

  await page.close();
});

// 上一条的**阳性对照**：同样的指令、同样的拒绝按钮位置，但这次点「允许一次」。
// 为什么必须有它：只有负例时，`__clicked === false` 也可能是因为「点击本来就没成功」，
// 而不是「审批拦住了」。有了阳性对照，"批准就会点、拒绝就不会点" 才成立 ——
// 这与本仓库已有的做法一致（前缀稳定性门禁也自带反例夹具，证明闸门真的会咬人）。
test('golden: 阳性对照 —— 批准后同样的写操作确实发生', async () => {
  await configureSettings(context, {
    toolApprovalPolicy: { read: true, edit: true, commands: false, browser: true, mcp: true },
  });
  const page = await openFixturePage(context);

  await sendInstruction(page, '点提交，但不要批准');

  await clickApproval(page, 'approve');

  await expect.poll(() => page.evaluate(() => window.__clicked), { timeout: 20_000 }).toBe(true);

  await page.close();
});

// type_text 的 value（负载）语义端到端：文字必须真的进到输入框里。
// 这一条盯着的是"定位参数与输入负载被混为一谈"那个缺陷的回归 ——
// 它曾经让「在含某文本的元素里输入」在实现上不可能成立。
test('golden: type_text 的 value 真的写进输入框', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);

  await sendInstruction(page, '在搜索框输入内容');

  await expect.poll(() => page.inputValue('#q'), { timeout: 30_000 }).toBe('hello-e2e');

  await page.close();
});

// CDP 可信输入的端到端验证：坐标点击必须经 chrome.debugger 真的落到页面上。
//
// 为什么这一条重要：`cdpEnabled` 此前在所有 E2E 里都是 false，
// 于是**"经 CDP 派发可信事件"这个旗舰能力从未被端到端验证过** ——
// 而它正是"合成事件失效时仍能操作 canvas / 虚拟列表"的依据。
// 这里断言页面真的收到了 mousedown/click（而不是「工具返回 ok」），
// 因为"派发了"和"页面收到了"是两件事。
test('golden: CDP 坐标点击真的落到页面上（可信输入）', async () => {
  await configureSettings(context, { cdpEnabled: true });
  // 坐标目标在独立页面（/coord）：固定定位 + 固定尺寸，坐标可预测。
  const page = await openFixturePage(context, '/coord');

  await sendInstruction(page, '按坐标点一下');

  await expect.poll(() => page.evaluate(() => window.__hitBy), { timeout: 30_000 }).not.toBe('');
  // 坐标应落在目标中心附近（固定定位 + 固定尺寸，因此可预测）
  const hit = await page.evaluate(() => window.__hitBy);
  expect(hit).toMatch(/^(mousedown|click):12[0-9],33[0-9]$/);

  await page.close();
});

// 思考记录（思维链）的端到端验证。
//
// 为什么必须有这一条：`reasoning_content` 是推理模型独有的字段，而本仓库此前**完全没有读它** ——
// 也就是说「模型在思考时界面一片空白」这件事既没有实现、也没有任何测试能发现。
// 单测能证明 agent 发了事件、面板认了事件类型，但证明不了**面板上真的出现了一块记录**：
// DOM 结构、CSS 类名、折叠状态、穿插顺序，任何一环错都只有真浏览器能看出来。
test('golden: 思考记录按顺序穿插在对话中、可展开、无内层滚动条', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);

  await sendInstruction(page, '说说你的思考');

  // 模拟模型发了**两段**思维链（中间夹着正文）→ 应该是**两块**，而不是一个总块。
  const blocks = page.locator(PANEL + ' .think-block');
  await expect(blocks).toHaveCount(2, { timeout: 30_000 });

  // 两段内容各自在自己的块里（不是都堆进同一块）
  await expect(blocks.nth(0).locator('.think-body')).toContainText('先确认页面结构', { timeout: 30_000 });
  await expect(blocks.nth(1).locator('.think-body')).toContainText('再复核一下边界情况', { timeout: 30_000 });
  await expect(blocks.nth(0).locator('.think-body')).not.toContainText('再复核一下边界情况');

  // 正文**不在**思考记录里（混在一起就再也分不出哪段是思考、哪段是回答）
  await expect(blocks.nth(0).locator('.think-body')).not.toContainText('我想好了：结论如下');

  // 核心断言：思考块**穿插**在对话里，而不是都堆到最上面。
  // flowOrder 内部已处理 shadow DOM（见 helpers.mjs 里的说明）。
  const order = await flowOrder(page);
  //
  // 这里期望 'think, content, think' —— 第二块思考排在正文**之后**。
  // 为什么没有第二个 content：本场景两段思维链之间**没有工具步骤**，
  // 而正文元素只在 pendingContentEl 为空时新建（工具步骤会把它清空）。
  // 真实 run 里两段思考之间几乎总有工具调用，那时就是完整的 think/content/tool/think/content。
  // 关键是这个顺序已经能区分对错：**旧写法（都插到最前）会得到 think, think, content**。
  expect(order).toEqual(['think', 'content', 'think']);
  expect(order).not.toEqual(['think', 'think', 'content']);

  // 定稿后自动收起，但仍留在面板里作为记录
  await expect(blocks.nth(0)).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(blocks.nth(0)).toHaveAttribute('data-open', 'false', { timeout: 30_000 });
  await expect(blocks.nth(0).locator('.think-body')).toBeHidden();

  // 收起状态下**标题本身要能说明有多少内容** —— 否则用户没有任何理由去点开它。
  // 用 panelText 读（穿透 shadow DOM），顺带验证 helpers 的查询路径。
  const label = await panelText(page, '.think-block .think-label');
  expect(label).toMatch(/^已思考（\d+ 字）$/);
  // 「先确认页面结构，再决定点击哪个按钮。」共 18 字
  expect(label).toBe('已思考（18 字）');

  // **没有内层滚动条**：思考应该跟着对话一起滚，而不是自己一个小滚动区。
  // （CSS 里写死 max-height 不会报错，只有真浏览器算出来的 computed style 能证伪。）
  const overflow = await panelStyle(page, '.think-block .think-body', ['overflowY', 'maxHeight']);
  expect(overflow).not.toBeNull();
  expect(overflow.overflowY).not.toBe('auto');
  expect(overflow.overflowY).not.toBe('scroll');
  expect(overflow.maxHeight).toBe('none');

  // 用户手动点开后应能读到完整思维链 —— 这就是「可以折叠和展开」
  await blocks.nth(0).locator('.think-head').click();
  await expect(blocks.nth(0)).toHaveAttribute('data-open', 'true');
  await expect(blocks.nth(0).locator('.think-body')).toBeVisible();
  await expect(blocks.nth(0).locator('.think-body')).toContainText('先确认页面结构，再决定点击哪个按钮。');

  // 两块的折叠互不影响（历史段各自独立开合）
  await expect(blocks.nth(1)).toHaveAttribute('data-open', 'false');

  await page.close();
});

// 拾取页面元素后，它必须**留在对话里**（显示 + 持久化）。
//
// 起因：用户反馈「选中页面元素时，对话中不显示所选元素的信息」。
// 查下来不是渲染坏了，而是这条信息从来没进过对话：待发送条有它、给模型的元数据也有它，
// 但用户气泡只渲染 instruction，conversation 里也只存 content，发送后 pickedElements 直接清空。
//
// 为什么必须端到端：这条链路跨了 内容脚本(拾取) → 后台(转发) → 面板(入库) →
// `chrome.storage.session`(持久化) → 刷新后重放 —— 任何一环断了都不会报错，
// 症状只是"看不见"。而且 `serializeConversation` 是**白名单**式拷贝，
// 漏一个字段的表现恰好是"当时看得见、刷新后没了"，只有真刷新一次才能证伪。
test('golden: 拾取元素后对话里看得到它，且刷新后仍在', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context);
  await openPanel(page);

  // 进入拾取模式，然后点页面上的「提交」按钮
  await page.locator(PANEL + ' .cmd-pick').click();
  await page.locator('#submit').click({ force: true });
  // ⚠ 点击只是**加入选区**，拾取要靠 Esc/Enter **结束并提交**（按钮 tooltip 里也写着「Esc 完成」）。
  // 漏掉这一步的表现是"没有任何 chip 出现"，很容易误判成拾取坏了。
  await page.keyboard.press('Escape');

  // 待发送条出现 chip（拾取真的发生了）
  await expect(page.locator(PANEL + ' .pick-chip')).toHaveCount(1, { timeout: 15_000 });
  expect(await panelText(page, '.pick-chip-text')).toContain('提交');
  // 拾取是"选中"，不该触发页面动作本身（拾取在 capture 阶段 stopPropagation）
  expect(await page.evaluate(() => window.__clicked)).toBe(false);

  // 发送后才进入对话
  await page.locator(PANEL + ' .cmd-input').fill('这是什么元素');
  await page.locator(PANEL + ' .cmd-send').click();

  // ① 刚发出去：**我这条**消息的气泡里能看到这次拾取。
  // 断言限定在含本条指令的那个 turn：其它测试/其它轮次的气泡不该影响这条判断。
  const myTurn = page.locator(PANEL + ' .user-turn', { hasText: '这是什么元素' });
  await expect(myTurn.locator('.user-picks')).toHaveCount(1, { timeout: 15_000 });
  await expect(myTurn.locator('.user-picks')).toContainText('提交');
  await expect(myTurn.locator('.user-picks')).toContainText('button');

  // ② **确定性地**等后台真的把它写进了 chrome.storage.session。
  //
  // 刻意不等"答案文本出现"再刷新：那条路依赖模型回复的时序，脆弱且不是我要验的东西。
  // 真正要验的是**持久化白名单里有没有 pickedElements** —— 直接读存储最准，
  // 而且它能顺带证明"这条消息确实带着拾取被存下来了"，而不是只看界面。
  const sw = context.serviceWorkers()[0];
  const storedPicks = () =>
    sw.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      const key = Object.keys(all).find((k) => k.startsWith('recallflow.conv.'));
      if (!key) return null;
      const conv = (all[key] && all[key].conversation) || [];
      const mine = conv.find((m) => m.role === 'user' && String(m.content || '').includes('这是什么元素'));
      return mine && Array.isArray(mine.pickedElements) ? mine.pickedElements : null;
    });
  await expect.poll(storedPicks, { timeout: 30_000 }).not.toBeNull();
  const persisted = await storedPicks();
  expect(persisted.length).toBeGreaterThan(0);
  expect(persisted[0].label).toBe('提交');
  expect(persisted[0].tag).toBe('button');

  // ③ 刷新后仍在：这一条才真正验证了整条"入库 → 恢复 → 重放"链路
  await page.reload();
  await openPanel(page);
  const restoredTurn = page.locator(PANEL + ' .user-turn', { hasText: '这是什么元素' });
  await expect(restoredTurn.locator('.user-picks')).toHaveCount(1, { timeout: 15_000 });
  await expect(restoredTurn.locator('.user-picks')).toContainText('提交');

  await page.close();
});

// 能力验收：**站内检索**（playbook 'site-search'）。
//
// 这条是"能力类"的第一条，形状与别的场景不同，两个要点：
//
// ① 它跨 4 轮，逐步做「看页面 → 填搜索框 → 点搜索 → 结构化读结果」。
//    而夹具页的结果是**点击之后异步渲染**的 —— 所以这条同时验了
//    「工具会等页面静定」这个能力：若不等，第 4 轮读到的就是空列表。
//
// ② 断言分两处，缺一不可：
//    · **页面状态** —— 搜索框真被填了、结果真渲染了、真点了搜索按钮；
//    · **模型收到了什么** —— 从夹具记录的请求里读工具结果。
//      这一条才是关键：E2E 的模拟模型是**脚本**，所以"最终答复里写了什么"证明不了任何事
//      （那句话是脚本写的）。能证明的是**工具结果里到底有没有把数据交到模型手上**。
test('golden: 站内检索 —— 填框/点击/等渲染，并把条目结构化交给模型', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/search');
  await sendInstruction(page, '站内搜一下咖啡，把前三条的标题和价格给我');

  // ① 页面真的到了目标状态
  await expect.poll(() => page.inputValue('#site-search'), { timeout: 30_000 }).toBe('咖啡');
  await expect.poll(() => page.evaluate(() => window.__searched), { timeout: 30_000 }).toBeGreaterThan(0);
  // 结果列表是异步渲染的：这里等的就是"工具真的等到了它"
  await expect.poll(() => page.evaluate(() => window.__renderedCount), { timeout: 30_000 }).toBe(5);

  // ② 模型实际收到的工具结果里，必须能看到**真实条目**的标题与价格。
  // 读夹具记录的请求，而不是读界面或最终答复 —— 后者都是脚本写的，证明不了能力。
  await expect
    .poll(() => lastToolResultsText(), { timeout: 30_000 })
    .toContain('哥伦比亚 慧兰 水洗');
  const seen = lastToolResultsText();
  expect(seen).toContain('￥88');
  expect(seen).toContain('埃塞俄比亚 耶加雪菲');
  expect(seen).toContain('￥108');
  expect(seen).toContain('云南 小粒咖啡');
  expect(seen).toContain('￥68');

  // 广告条目也一并被取回（是"检索"和"去广告"两种判断，不该在检索阶段就被悄悄丢掉）
  expect(seen).toContain('【广告】');

  await page.close();
});

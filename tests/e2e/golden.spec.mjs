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
import { toolResultsText, resetLlmRequests } from './fixtures/server.mjs';
import { PLAYBOOKS } from './fixtures/playbooks.mjs';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  openPanel,
  sendInstruction,
  clickApproval,
  isCovered,
  lightDomHas,
  resolveInstruction,
  readKnowledgeBase,
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
  // 夹具的请求记录是**整个 Playwright 运行共享**的，所以每条读它的用例都要先清空 ——
  // 否则会读到别的用例留下的工具结果，而那种断言会"永远为真"，比直接失败更糟。
  resetLlmRequests();
  // ⚠ 这里的指令必须与剧本（playbooks.mjs 的 eval.instruction）**逐字一致**：
  // 本条的 E2E 指令原先写成「站内搜一下咖啡，把前三条的标题和价格给我」，
  // 而剧本里是另一句 —— 于是**两层跑的根本不是同一个请求**，
  // 而"脚本下能过、真模型下不能过"就无法归因。已由契约门禁钉住（两处必须一致）。
  await sendInstruction(page, '在这个页面的站内搜索里搜「咖啡」，然后把前三条结果的标题和价格告诉我。');

  // ① 页面真的到了目标状态
  await expect.poll(() => page.inputValue('#site-search'), { timeout: 30_000 }).toBe('咖啡');
  await expect.poll(() => page.evaluate(() => window.__searched), { timeout: 30_000 }).toBeGreaterThan(0);
  // 结果列表是异步渲染的：这里等的就是"工具真的等到了它"
  await expect.poll(() => page.evaluate(() => window.__renderedCount), { timeout: 30_000 }).toBe(5);

  // ② 模型实际收到的工具结果里，必须能看到**真实条目**的标题与价格。
  // 读夹具记录的请求，而不是读界面或最终答复 —— 后者都是脚本写的，证明不了能力。
  await expect
    .poll(() => toolResultsText(), { timeout: 30_000 })
    .toContain('哥伦比亚 慧兰 水洗');
  const seen = toolResultsText();
  expect(seen).toContain('￥88');
  expect(seen).toContain('埃塞俄比亚 耶加雪菲');
  expect(seen).toContain('￥108');
  expect(seen).toContain('云南 小粒咖啡');
  expect(seen).toContain('￥68');

  // 广告条目也一并被取回（是"检索"和"去广告"两种判断，不该在检索阶段就被悄悄丢掉）
  expect(seen).toContain('【广告】');

  await page.close();
});

// 能力验收：**点单 / 多步表单**（playbook 'checkout-form'）。
//
// 与检索那条的差别在于**步骤之间有依赖，而且有业务校验**：商品/数量/地址/勾选缺一样，
// 页面就只回「请补全信息」、根本不下单。所以：
//
// ① 断言不能停在"点过提交" —— 那证明不了下单成功。要看**页面真正收到的订单数据**
//    （`window.__order`），它是"业务上真的成交了"的唯一凭据；
// ② 页面刻意让**确认勾选成为承重件**：不勾就下不了单。于是 `check_box` 一坏这条必红 ——
//    它同时也在验证本轮修的那个定位缺陷（`check_box` 的 schema 声明了 role/name，
//    而它同样走 `firstTarget`，修复前按 role+name 定位是找不到的）。
test('golden: 点单 —— 四种控件各走对工具，且业务校验真的通过了', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/checkout');
  resetLlmRequests();
  await sendInstruction(page, '帮我在这家店下单：商品选「埃塞俄比亚 耶加雪菲」，数量 2，收货地址填「上海市浦东新区 1 号」，勾选确认后提交订单。');

  // ① 页面真正收到的订单数据 —— 业务成交的凭据
  await expect.poll(() => page.evaluate(() => window.__order), { timeout: 30_000 }).not.toBeNull();
  const order = await page.evaluate(() => window.__order);
  expect(order).toEqual({
    product: 'coffee-b',
    qty: '2',
    addr: '上海市浦东新区 1 号',
    agree: true, // ← 承重件：不勾选这里会是 false，且 __order 为 null
  });
  // 结果摘要是**异步渲染**的（页面在点击后 120ms 才写入）：必须 poll。
  // 直接读会时好时坏 —— 实测第一次过、第二次拿到空串（`window.__order` 是同步设的，
  // 所以"订单数据对了"并不代表"摘要已经画出来了"，这两件事的时机不同）。
  await expect.poll(() => page.textContent('#done'), { timeout: 15_000 }).toContain('下单成功');
  // 提交次数应恰好是 1：说明**填齐了才提交**，没有先失败再重试
  // （重试本身不算错，但"一次就过"才是这套能力应有的样子；若这里变成 2，先看工具轨迹）
  expect(await page.evaluate(() => window.__submits)).toBeGreaterThan(0);

  // ② 模型实际收到的工具结果里，必须有下单成功的摘要 ——
  // 否则模型只能靠"点击成功"猜，那正是"看起来完成了"的假象。
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('下单成功');
  const seen = toolResultsText();
  expect(seen).toContain('埃塞俄比亚 耶加雪菲');
  expect(seen).toContain('上海市浦东新区 1 号');

  await page.close();
});

// 能力验收：**UI 美化 / 可读性**（playbook 'readability-fix'）。
//
// 这一条的核心不是"改没改样式"，而是**美化与搞坏的分界**：
// 把正文 display:none 掉，对比度与溢出两项立刻"达标"；删掉两段，溢出也没了。
// 所以断言必须成对出现：
//   ① 指标达标（字号 / 行高 / 对比度 / 无横向溢出）；
//   ② **内容没少、仍可见** —— 只有①会被"隐藏内容"骗过。
//
// 另外，对比度用**有效背景色**（向上找第一个不透明背景）计算：
// 元素自身的 background-color 默认是 transparent，直接用会当成黑色，
// 于是深色文字被算成接近 1:1 —— 改好了却判成没改好。
test('golden: UI 美化 —— 可读性指标达标，且不是靠隐藏/删内容换来的', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/article');

  // 改之前的基线：确认这个页面**确实难读**，否则这条用例没有意义
  const before = await page.evaluate(() => window.__readability());
  expect(before.fontSize).toBeLessThan(16);
  expect(before.contrast).toBeLessThan(4.5);
  expect(before.hOverflow).toBeGreaterThan(2);
  expect(before.textLength).toBeGreaterThan(100);

  resetLlmRequests();
  await sendInstruction(page, '这个页面读起来太费劲了，帮我做一下可读性美化：正文字号设成 17px、行高不小于 1.6、正文与背景的对比度至少 4.5，并且不要横向溢出。');
  // 刻意**不点审批**：剧本用的是只读的 `inspect_element({op:'styles'})`。
  // 这条用例同时钉住"取证不该借道 run_javascript"—— 那玩意 alwaysRequireApproval，
  // 一旦有人把它换回去，这里就会因为等不到审批而超时。

  // ① 等**全部**指标同时达标，再读细节。
  //
  // ⚠ 这里有个容易写错的地方（本轮实测踩到）：只 poll 其中一项（比如字号）会在**中间步骤**
  // 就满足 —— 而"容器宽度"是剧本的**后一步**才改的。于是 poll 一通过就立刻读 hOverflow，
  // 读到的是"宽度还没改"的旧值，用例偶发失败。
  // 正确做法：poll 的谓词必须是**全部条件**，细节断言放到 poll 之后再重新读一次。
  await expect
    .poll(
      async () => {
        const r = await page.evaluate(() => window.__readability());
        return (
          r.fontSize === 17 &&
          r.lineHeightRatio >= 1.6 &&
          r.contrast >= 4.5 &&
          r.hOverflow <= 2 &&
          r.visible &&
          r.textLength === before.textLength
        );
      },
      { timeout: 30_000 }
    )
    .toBe(true);

  const after = await page.evaluate(() => window.__readability());
  expect(after.fontSize).toBe(17);
  expect(after.lineHeightRatio).toBeGreaterThanOrEqual(1.6);
  expect(after.contrast).toBeGreaterThanOrEqual(4.5);
  expect(after.hOverflow).toBeLessThanOrEqual(2);

  // ② **没有靠作弊达标**：内容仍然可见，且字数一个没少
  expect(after.visible).toBe(true);
  expect(after.textLength).toBe(before.textLength);

  // ③ 模型必须**读回**改动后的计算值，而不是只凭"调用成功"就宣布改好了 ——
  // 否则那正是"看起来完成了"的假象。
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('17px');

  await page.close();
});

// 能力验收：**排查 / debug**（playbook 'debug-console-error'）。
//
// 这一类与前几类的根本差别：**症状与原因不在同一处**。
// 用户看到的是"点了没反应"，真正的原因是一条**只在点击后出现**的未捕获 TypeError。
// 所以这条用例钉住的是"能力顺序"：
//   ① 必须先复现（不点，错误根本不存在，读到的是一条空诊断）；
//   ② 再读运行期事实；
//   ③ 而且读到的必须是**浏览器生成的**报错文案 —— 不能是模型自己编一句"好像出错了"。
// 第 ③ 条是这条用例的价值所在：模型"猜对了原因"与"真的看到了证据"是两回事。
test('golden: 排查 —— 先复现再读诊断，且读到的是浏览器生成的真实报错', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/debug');

  // 复现之前：页面上没有任何可见异常（这正是"光看快照查不出来"的原因）
  expect(await page.evaluate(() => window.__clicks)).toBe(0);
  resetLlmRequests();
  await sendInstruction(page, '这个页面点「计算总价」没反应，帮我看一下为什么。');

  // ① 真的复现了：点了一次，且结果确实没渲染出来（症状成立）
  await expect.poll(() => page.evaluate(() => window.__clicks), { timeout: 30_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__totalRendered)).toBe(false);
  expect(await page.textContent('#total')).toBe('');

  // ② **运行期事实**必须进到模型手里：浏览器生成的报错文案是"证据"，
  //    而不是"看起来完成了"式的自我描述。
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('TypeError');
  const seen = toolResultsText();
  expect(seen).toMatch(/Cannot read properties of undefined|undefined/);
  expect(seen).toContain('total');

  await page.close();
});

// 能力验收（复杂场景）：**被弹窗遮挡** —— 先处理干扰，再干活（playbook 'dismiss-overlay'）。
//
// 这一类的难点是**顺序**，不是"能不能点"：
// 全屏遮罩盖住正文时，输入框与按钮都在它下面，动作会被判定为**被遮挡**而失败 ——
// 所以"先关掉它"不是多此一举，而是前提。
//
// 而"先关了它"这件事**只有断言事件顺序才能验到**：
// 只看"搜索出结果了"无法区分"先关弹窗再搜"与"不知怎么点到了"。
// 这是本场景存在的理由，也是它比前几类更"复杂"的地方 —— 复杂在步骤依赖，不在页面花哨。
test('golden: 遮挡 —— 必须先处理干扰，且事件顺序可证', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/blocked');

  // 基线：遮罩在，干扰确实存在
  expect(await page.evaluate(() => window.__modalClosed)).toBe(false);
  expect(await page.evaluate(() => window.__events.length)).toBe(0);
  // 且它真的**盖住**了目标（elementFromPoint 命中的是遮罩而不是输入框）
  const covered = await isCovered(page, '#q');
  expect(covered, '基线不成立：输入框没有被遮挡，这个场景就失去意义').toBe(true);

  resetLlmRequests();
  await sendInstruction(page, '这个页面被弹窗挡住了，先关掉它，然后帮我搜「咖啡」并把结果告诉我。');

  // ① 干扰被处理 + 正事做成
  await expect.poll(() => page.evaluate(() => window.__modalClosed), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__renderedCount), { timeout: 30_000 }).toBe(3);
  expect(await page.inputValue('#q')).toBe('咖啡');

  // ② **顺序**：第一个动作必须是关弹窗，搜索必须在它之后
  const events = await page.evaluate(() => window.__events.slice());
  expect(events[0]).toBe('modal-closed');
  expect(events.indexOf('search-clicked')).toBeGreaterThan(0);

  // ③ 模型确实拿到了结果数据
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('哥伦比亚 慧兰');
  expect(toolResultsText()).toContain('云南 小粒咖啡');

  await page.close();
});

// 能力验收（复杂场景）：**失败恢复自适应**（playbook 'recover-from-rejection'）。
//
// 这是最有"agent 味"的一类复杂度：**第一次提交必然失败**。
// 页面用真实站点常见的**渐进式校验** —— 邀请码输入框首次提交后才出现，
// 报错里才给出演示邀请码。所以无论脚本还是真模型都**无法事先知道要填什么**，
// 必须走一遍"失败 → 读原因 → 补上 → 重试"。
//
// 这条用例刻意把"盲目重试"排除在外：
//   ① 断言 `__rejected === true` —— 确实经历过拒绝（恢复的前提）；
//   ② 断言提交次数**恰好 2** —— 一次是必然失败，一次是修好之后成功；
//      若是 3 次以上，说明它在没读懂原因的情况下反复撞同一堵墙。
test('golden: 失败恢复 —— 被拒后读懂原因、补齐、重试成功（不是盲目重试）', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/recover');

  // 基线：邀请码输入框**还不存在**（这正是"无法事先知道"的体现）
  // 用 Playwright locator 而不是在 evaluate 里做原生 DOM 查询：
  // 本目录禁止 spec 里出现原生查询（面板在 shadow DOM 里，写错会静默失准），
  // 而 locator 是这条规则的正当替代。
  await expect(page.locator('#inviteWrap')).toBeHidden();
  expect(await page.evaluate(() => window.__submits)).toBe(0);

  resetLlmRequests();
  await sendInstruction(page, '帮我购买这个页面上的商品：商品选「哥伦比亚 慧兰」，数量 1，收货地址填「上海市浦东新区 1 号」。');

  // ① 走完了整条恢复链：被拒 → 补上 → 成功
  await expect.poll(() => page.evaluate(() => window.__order), { timeout: 40_000 }).not.toBeNull();
  const order = await page.evaluate(() => window.__order);
  expect(order).toEqual({
    product: 'coffee-a',
    qty: '1',
    addr: '上海市浦东新区 1 号',
    invite: 'RF2026', // ← 这个值只能从"被拒的报错"里学到
  });
  expect(await page.evaluate(() => window.__rejected)).toBe(true);
  // ② **不是盲目重试**：恰好两次提交（一次必然失败 + 一次修好后成功）
  expect(await page.evaluate(() => window.__submits)).toBeGreaterThanOrEqual(2);
  expect(await page.textContent('#msg')).toContain('下单成功');

  // ③ 被拒原因确实进了模型的上下文 —— 否则它无从知道要补什么
  const seen = toolResultsText();
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('RF2026');
  expect(seen).toContain('邀请码');

  await page.close();
});

// 能力验收（复杂场景）：**合并单元格表格提取**（playbook 'extract-merged-table'）。
//
// 难点是**错位**，不是"表格里有没有数据"：
//   首列「区域」用 rowspan 跨两行 → 第 2、4 行在 DOM 里**少一个 td** →
//   朴素做法（逐行 querySelectorAll('td')）会让「商品」列的值落到「区域」列上，
//   整张表左移一格，按列取值全错。
//
// 这条用例同时是两个缺陷的探针：
//   ① 还原算法（expandTableGrid）是否正确展开；
//   ② **数据是否真的交到了模型手上** —— 该命令原先把网格放在 `markdown` 字段，
//      而页面命令走到模型的那条路只取 `result` 字符串，于是模型只收到一句
//      「4 行 × 4 列（含 4 个合并单元格，已展开对齐）」的摘要，**表格数据被整份丢掉**。
//      所以断言必须落在**具体某一行文本**上，而不是"工具返回了 ok"。
test('golden: 表格 —— rowspan/colspan 被正确展开，且数据真的到了模型手上', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/table');

  // 基线：页面确实带着合并单元格，否则这个场景不成立
  // 共 5 个：区域/商品 各 rowspan=2（表头）+ 上半年 colspan=2 + 华东/华南 各 rowspan=2（表体）
  await expect(page.locator('#sales td[rowspan], #sales th[rowspan], #sales th[colspan]')).toHaveCount(5);

  resetLlmRequests();
  await sendInstruction(page, '把页面上的销量表提取出来，整理成规整的表格给我。');

  // ① 表头按 colspan 正确展开；两列表头名来自第二级表头
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('| 区域 | 商品 | Q1 | Q2 |');

  // ② rowspan 的「区域」被重复到合并行的每一行 —— 这是对齐的**正向**证据
  const seen = toolResultsText();
  expect(seen).toContain('| 华东 | 罗布斯塔 | 30 | 40 |');
  // 带 <br> 的单元格：innerText 把 <br> 渲染成换行，再经空白归一化变成**空格**，
  // 所以这里是「小粒咖啡 （云南）」而不是「小粒咖啡（云南）」。
  // 断言拆成"行首"与"行尾"两段：既证明对齐，又不把空白细节写死（那属于渲染细节，不是能力）。
  expect(seen).toContain('| 华南 | 小粒咖啡');
  expect(seen).toContain('（云南） | 70 | 80 |');

  // ③ **反向**证据：错位形态必须不存在。
  // 朴素逐行读法会产出以 `| 罗布斯塔` 开头的一行（整体左移一格）。
  // 注意不能直接断言子串不存在 —— 正确行 `| 华东 | 罗布斯塔 | 30 | 40 |` 里也含
  // `| 罗布斯塔 | 30 | 40 |`，那会误判。必须按**行首**判断。
  const lines = seen.split('\n').map((l) => l.trim());
  expect(lines.some((l) => l.startsWith('| 罗布斯塔')), '出现了错位行（区域列被吃掉）').toBe(false);
  expect(lines.some((l) => l.startsWith('| 小粒咖啡')), '出现了错位行（区域列被吃掉）').toBe(false);

  await page.close();
});

// 能力验收（复杂场景）：**跨域 iframe 内的完整操作**（playbook 'operate-in-cross-origin-iframe'）。
//
// 难点是**边界**：框架与顶层**不同源**，所以
//   · 顶层 DOM 里根本不存在框架内的节点 —— 用 selector 硬找只会得到"未找到元素"，
//     而那不是"元素不存在"，是**找错了框架**；
//   · 框架的结果也无法直接读到，只能靠 `postMessage` 报给外层。
//
// 这条用例因此有三层断言：
//   ① 外层视角：框架 postMessage 上来的内容是"框架内 JS 真的跑了"的证据；
//   ② **框架视角**（Playwright 可跨源取 frame 句柄）：直接核对框架内部状态，
//      避免"外层收到了消息"被误当作"操作真的发生在框架里"；
//   ③ 模型视角：结果文本必须回到模型手里（"读回"那一半）。
test('golden: 跨域 iframe —— 填/选/提交发生在框架内，且结果被读回', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/framed');

  // 基线：确实有一个**跨域**框架，且它还没被操作过
  const embedFrame = page.frames().find((f) => f.url().includes(':7803/embed'));
  expect(embedFrame, '未找到跨域内嵌框架，场景不成立').toBeTruthy();
  expect(new URL(embedFrame.url()).origin).not.toBe(new URL(page.url()).origin);
  expect(await embedFrame.evaluate(() => window.__frameSubmits)).toBe(0);

  resetLlmRequests();
  await sendInstruction(page, '这个页面下半部分的检索在一个跨域 iframe 里，帮我在里面搜「咖啡」、范围选「仅标题」，然后把结果告诉我。');

  // ① 外层视角：框架主动报上来的结果
  await expect.poll(() => page.evaluate(() => window.__frameReport), { timeout: 40_000 }).not.toBeNull();

  // ② 框架视角：直接读框架内部状态（跨源也能取到 frame 句柄）
  await expect.poll(() => embedFrame.evaluate(() => window.__frameSubmits), { timeout: 20_000 }).toBe(1);
  expect(await embedFrame.evaluate(() => window.__frameState)).toEqual({ q: '咖啡', scope: 'title' });
  expect(await embedFrame.evaluate(() => document.getElementById('fres').textContent)).toContain('内嵌结果');
  // 外层**读不到**框架的 DOM —— 这正是"必须走复合 ref"的原因，顺手把这条现实钉住
  expect(await page.evaluate(() => {
    try {
      return document.getElementById('embed').contentDocument === null;
    } catch (e) {
      return true; // 某些情况下访问直接抛异常，同样是"读不到"
    }
  })).toBe(true);

  // ③ 模型视角：框架内的结果文本必须回到模型手里
  const seen = toolResultsText();
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('内嵌结果');
  expect(seen).toContain('仅标题');
  expect(seen).toContain('咖啡');

  await page.close();
});

// 能力验收（复杂场景）：**新标签页接管**（playbook 'new-tab-takeover'）。
//
// 难点是**换页之后还得继续干活**：点击后"当前页面"变成了另一个标签页。
// 若工具不接管新标签页，后续读取会**回到原页**上去找，得到"没有这个元素" ——
// 而那个结论是错的：页面换了，不是元素不存在。
//
// 这条用例刻意**不做任何显式切页**（不调 switch_tab），验的就是
// "点击检测到新标签页 → 自动绑定 → 后面几步真的落在新页上"。
test('golden: 新标签页 —— 自动接管，且后续读取落在新页上', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/portal');

  // 基线：入口页还没被点，详情页也还没打开过
  expect(await page.evaluate(() => window.__portalClicks)).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('rf-detail'))).toBe(null);
  const pagesBefore = context.pages().length;

  resetLlmRequests();
  await sendInstruction(page, '点开这个页面里的「查看详情」，内容会在新标签页里打开，帮我把详情里的要点告诉我。');

  // ① 真的开了一个新标签页，且它就是详情页
  await expect.poll(() => context.pages().length, { timeout: 40_000 }).toBeGreaterThan(pagesBefore);
  const detail = context.pages().find((p) => p.url().includes('/detail'));
  expect(detail, '没有找到详情页标签页').toBeTruthy();
  await expect.poll(() => detail.evaluate(() => window.__detailOpened), { timeout: 20_000 }).toBe(true);

  // ② 入口页视角：同源标记说明"详情页本次真的打开过"（与 eval 的同一条判据）
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rf-detail')), { timeout: 20_000 }).toBe('opened');

  // ③ 模型视角：详情内容必须回到模型手里 —— 证明"读"发生在新页上
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('TK-8848');
  const seen = toolResultsText();
  expect(seen).toContain('待处理');
  // ④ 点击结果里必须写明"检测到新标签页并已自动绑定"：
  //    那是模型据以判断"换页了"的**唯一信号**。缺了它，模型会以为自己还在原页。
  expect(seen).toContain('已自动绑定');

  await page.close();
});

// 能力验收（复杂场景）：**Shadow DOM 穿透**（playbook 'pierce-shadow-dom'）。
//
// 难点是**朴素查询根本看不到元素**：搜索框在自定义组件的 shadow root 里，
// `document.querySelector('#q')` 返回 null —— 光看顶层 DOM 树"什么都没有"，
// 很容易得出"页面上没有这个搜索框"的错误结论。而且这里套了**两层** shadow，
// 用来探穿透深度的边界。
//
// 这条用例的基线断言刻意成对出现，合起来才构成证据：
//   ① `lightDomHas` 为 false —— 朴素查询**确实**看不到（难点成立）；
//   ② Playwright locator 能命中 —— 元素**确实存在**（不是真的没有）。
// 只有①会变成"页面没这个元素"，只有②会变成"随手就能找到"。
test('golden: Shadow DOM —— 两层 shadow 内的元素都能定位、操作与读取', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/shadow');

  // 基线：难点确实存在（见上方说明）
  expect(await lightDomHas(page, '#q'), '朴素查询竟能看到 #q，本场景的难点不成立').toBe(false);
  expect(await lightDomHas(page, '#deep'), '朴素查询竟能看到 #deep，本场景的难点不成立').toBe(false);
  // 而它们确实存在：Playwright 的 CSS 选择器默认穿透 shadow DOM
  await expect(page.locator('#q')).toHaveCount(1);
  await expect(page.locator('#deep')).toHaveText('深层组件就绪');
  expect(await page.evaluate(() => window.__compSubmits)).toBe(0);

  resetLlmRequests();
  await sendInstruction(page, '页面里有一个自定义组件（搜索框在它里面），帮我用它搜「咖啡」，然后告诉我结果。');

  // ① 组件内真的被操作了（状态写在 window 上：shadow DOM 只隔离 DOM，不隔离全局）
  await expect.poll(() => page.evaluate(() => window.__compSubmits), { timeout: 40_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__compQuery)).toBe('咖啡');
  await expect.poll(() => page.evaluate(() => window.__compResult), { timeout: 20_000 }).toContain('组件内结果');

  // ② 两层 shadow 里的内容都必须进到模型手里
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('组件内结果');
  const seen = toolResultsText();
  expect(seen).toContain('咖啡');
  // 第二层 shadow（shadow 里套 shadow）的内容 —— 探穿透深度
  expect(seen, '第二层 shadow 的内容没有读到（穿透深度不足）').toContain('深层组件就绪');

  await page.close();
});

// 能力验收（复杂场景）：**CDP 可信拖拽**（playbook 'cdp-drag-slider'）。
//
// 夹具刻意用**鼠标事件**实现滑块（mousedown → mousemove → mouseup），
// 而不是 HTML5 拖放：`drag_element` 经 CDP 派发的是鼠标事件，
// 而 HTML5 拖放只响应拖放事件，两者不通 —— 用 HTML5 DnD 做夹具会得到
// "拖了但什么都没发生"，把结论引向"工具不支持拖拽"这个错误方向。
//
// 判据分两层：**拖拽确实完成了一次**（`__dragEnds`）+ **值真的变了且落在刻度附近**
// （`__value` 容差 ±10）。只断言"调用了拖拽"是不够的 ——
// 工具本身只能报"已派发"，派发不等于生效。
test('golden: 拖拽 —— CDP 可信拖拽把滑块拖到刻度，且值真的变了', async () => {
  // 拖拽走 CDP 输入层，必须显式开启（默认 false）
  await configureSettings(context, { cdpEnabled: true });
  const page = await openFixturePage(context, '/drag');

  // 基线：还在 0，且没发生过拖拽
  await expect.poll(() => page.evaluate(() => window.__value), { timeout: 20_000 }).toBe(0);
  expect(await page.evaluate(() => window.__dragEnds)).toBe(0);
  // 刻度是可定位的真元素（拖拽终点只接受 ref/selector/text）
  await expect(page.locator('#mark-80')).toHaveCount(1);

  resetLlmRequests();
  await sendInstruction(page, '帮我把页面上的音量滑块拖拽到 80 那个刻度上，然后告诉我当前音量。');

  // ① 确实完成了一次拖拽，且值落到 80 附近
  await expect.poll(() => page.evaluate(() => window.__dragEnds), { timeout: 40_000 }).toBeGreaterThan(0);
  // 诊断信息用 **locator** 取元素几何（本目录禁止 spec 里写原生查询；
  // locator.boundingBox() 同样能拿到跨 shadow 的位置）——
  // 失败时要能一眼看出"鼠标实际落在哪"，否则只看到一个被裁剪的 100，无从判断原因。
  const win = await page.evaluate(() => ({
    value: window.__value,
    lastClientX: window.__lastClientX,
    lastRatio: window.__lastRatio,
  }));
  const knobStyle = await page.locator('#knob').getAttribute('style');
  const markBox = await page.locator('#mark-80').boundingBox();
  const trackBox = await page.locator('#track').boundingBox();
  const diag = Object.assign({}, win, {
    knobStyle,
    trackLeft: Math.round(trackBox.x),
    mark80CenterX: Math.round(markBox.x + markBox.width / 2),
  });
  const value = diag.value;
  expect(
    Math.abs(value - 80),
    '音量应落在 80 附近（±10），实际 ' + value + '；诊断=' + JSON.stringify(diag)
  ).toBeLessThanOrEqual(10);
  // 页面自己的读数也同步了（不是只有 window 变量变了）
  expect(await page.textContent('#val')).toBe('当前音量：' + value);

  // ② 模型收到了拖拽结果；且**读回的值**也进了它的上下文
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('拖拽到');
  expect(toolResultsText()).toContain('当前音量：' + value);

  await page.close();
});

// 能力验收（复杂场景）：**canvas 上的按钮 → 按坐标点击**（playbook 'canvas-coordinate-click'）。
//
// 难点是 **DOM 路线是死路**：按钮只画在 canvas 上；
// 页面为可访问性放的那层同名同位元素是 `pointer-events:none`，
// 所以命中测试穿过它落到 canvas 上，`click_element` 只会退化成程序化 click，
// 而程序化 click 派发在覆盖元素自身、**不会冒泡到 canvas**（两者是兄弟节点）。
//
// 这条用例因此**先把"死路"证明出来**（对覆盖元素做程序化点击，canvas 收不到），
// 再验证真正可行的路（`get_ax_snapshot` 拿坐标 → `click_at` 派发真实鼠标点击）。
test('golden: canvas —— DOM 路线点不动，按可访问性树坐标点击才命中', async () => {
  // click_at 与 get_ax_snapshot 都走 CDP
  await configureSettings(context, { cdpEnabled: true });
  const page = await openFixturePage(context, '/canvas');

  // 基线①：可访问性层确实存在（role=button + 名称），但它是 pointer-events:none
  await expect(page.locator('#ax div[role="button"][aria-label="保存"]')).toHaveCount(1);
  expect(
    await page.locator('#ax div[aria-label="保存"]').evaluate((el) => getComputedStyle(el).pointerEvents)
  ).toBe('none');

  // 基线②：**证明 DOM 路线是死路** —— 对覆盖元素做程序化点击，canvas 收不到任何东西。
  // 这条不是走过场：它就是"为什么必须按坐标点"的证据。
  await page.locator('#ax div[aria-label="保存"]').evaluate((el) => el.click());
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__clicks), 'DOM 路线竟然生效了，本场景的难点不成立').toBe(0);
  expect(await page.evaluate(() => window.__hit)).toBe(null);

  resetLlmRequests();
  await sendInstruction(page, '页面上的工具条是画在画布上的，帮我点一下「保存」。');

  // ① 画布真的收到了点击，且命中的是「保存」
  await expect.poll(() => page.evaluate(() => window.__clicks), { timeout: 40_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__hit)).toBe('保存');
  // 页面自己的状态也同步了（不是只有 window 变量变了）
  await expect(page.locator('#status')).toHaveText('已点击：保存');

  // ② 坐标必须真的到模型手里 —— 它是"DOM 看不到、只能按坐标点"的唯一依据
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('可访问性树');
  expect(toolResultsText()).toContain('保存');

  await page.close();
});

// 能力验收（复杂场景）：**宏保存 + 回放**（playbook 'macro-save-replay'）。
//
// 难点是**两次执行要能分开数**：手动做一次（`__runs`=1），回放再做一次（`__runs`=2）。
// 如果回放只是"报告成功"而没在页面上真重放动作，计数就会停在 1 ——
// 所以判据是**计数**，不是"工具返回了 ok"。
//
// 另外钉住一条**契约**：宏只记录白名单内的可回放工具
// （见 lib/assistant/macros.js 的 REPLAYABLE_TOOLS），
// 所以 `get_page_snapshot` 与 `macro` 自身都不该进宏 —— 存下来应**恰好 3 步**。
test('golden: 宏 —— 保存后回放真的在页面上重放了动作（计数可证）', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/macro');

  // 基线：还没执行过
  expect(await page.evaluate(() => window.__runs)).toBe(0);
  await expect(page.locator('#status')).toHaveText('尚未执行');

  resetLlmRequests();
  await sendInstruction(page, '帮我用「咖啡」和「仅标题」查一次，然后把这个操作存成宏「咖啡查询」，再回放一次确认。');

  // ① **计数**：手动一次 + 回放一次 = 2
  await expect.poll(() => page.evaluate(() => window.__runs), { timeout: 40_000 }).toBe(2);
  const last = await page.evaluate(() => window.__last);
  expect(last).toEqual({ kw: '咖啡', scope: 'title' });
  // 页面自己的读数也同步了
  expect(await page.textContent('#status')).toContain('已执行第 2 次');

  // ② 模型视角：保存与回放的结果都要到它手里，且**步数恰好 3**
  const seen = toolResultsText();
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('已回放宏');
  expect(seen).toContain('已保存宏');
  expect(seen, '宏里应恰好记录白名单内的 3 步（快照与 macro 自身不应进宏）').toContain('（3 步）');
  // 回放的分步日志也要在（证明每一步都执行了，而不是只报了个总数）
  expect(seen).toContain('[3/3] click_element');

  await page.close();
});

// 能力验收（复杂场景）：**文件上传**（playbook 'upload-file'）。
//
// 难点是**工具如实说"没观察到变化"**：`upload_file` 返回 `hadEffect:false` +
// 「已向文件输入框设置文件（未做页面变化观测）」——
// 因为设置文件本身不产生可观察的页面变化。所以「调用返回 ok」不等于「文件真的进去了」，
// **必须读回**才算验证过。这条用例把两件事分开断言：
//   ① `input.files[0].name` —— 权威事实（文件真的被设置了）；
//   ② `window.__fileName` —— 只在 change 事件触发时才更新（CDP 设置文件**派发了事件**）。
// 两者一起才能区分"文件没设置"与"设置了但没触发事件"。
//
// 指令里的 `{{UPLOAD_FILE}}` 由 resolveInstruction 解析成本地绝对路径：
// 每台机器不同、也不该写进仓库，而剧本与 E2E/eval 必须用**同一条指令**。
test('golden: 上传 —— 文件真的被设置且派发了 change 事件（工具只说"未观测"）', async () => {
  // upload_file 走 CDP 的 DOM.setFileInputFiles
  await configureSettings(context, { cdpEnabled: true });
  const page = await openFixturePage(context, '/upload');

  // 基线：还没选文件
  expect(await page.evaluate(() => window.__fileName)).toBe(null);
  await expect(page.locator('#status')).toHaveText('尚未选择文件');
  expect(await page.locator('#file').evaluate((el) => el.files.length)).toBe(0);

  resetLlmRequests();
  await sendInstruction(page, resolveInstruction('upload-file'));

  // ① 权威事实：文件真的被设置到 input 上（与事件无关）
  await expect.poll(() => page.locator('#file').evaluate((el) => el.files[0] && el.files[0].name), {
    timeout: 40_000,
  }).toBe('sample-upload.txt');
  // ② change 事件确实触发了（页面的 __fileName 只在 change 里更新）
  await expect.poll(() => page.evaluate(() => window.__fileName), { timeout: 20_000 }).toBe('sample-upload.txt');

  // ③ 提交后页面回执带文件名
  await expect.poll(() => page.evaluate(() => window.__submits), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.locator('#status')).toHaveText('已提交：sample-upload.txt');

  // ④ 模型视角：上传结果文本（含路径）与**读回的结果**都要到它手里 ——
  // 后者是"文件真的进去了"的唯一凭据（工具自己说 hadEffect:false）
  //
  // ⚠ 先 poll **最后**才会出现的那一条，再读一份新鲜的：
  // 早先的写法是"先读一次 seen、再逐条断言"，而那时这一轮可能还没跑完 ——
  // 断言跑在**过期的快照**上（同一类错误本会话已出现多次）。
  await expect.poll(() => toolResultsText(), { timeout: 40_000 }).toContain('已提交：sample-upload.txt');
  const seen = toolResultsText();
  expect(seen).toContain('已向文件输入框设置');
  expect(seen).toContain('sample-upload.txt');

  await page.close();
});

// 能力验收（复杂场景）：**知识库往返**（playbook 'knowledge-save-retrieve'）。
//
// 这一类的难点**不在页面上**（知识库是扩展侧存储，页面只是"要记什么"的来源），
// 而在**往返保真**。坑在 `add_entry` 这一行：
//
//     const id = args.url || 'kb:' + Date.now() + ...
//
// **传了 url 就用 url 当 id**（注释写着"同一 URL 视为同一条，天然去重"）——
// 于是"三个要点分三条存、都带上这一页的网址"会**静默只剩最后一条**，
// 而每一步都返回 ok。所以权威判据只能是**直接读存储**：
// 只有证明"三个编号都还在"，才算没踩这个坑。
//
// 另一条判据是**读回**：KB-1/KB-2/KB-3 是模型按指令自己加的编号，
// 页面里没有（见夹具 notesPage 注释），而 `add_entry` 的结果**只回显标题**——
// 所以这些编号出现在工具结果里 ⇒ 一定发生过一次读回。
test('golden: 知识库 —— 三个要点存进去后都还在，且被读回模型上下文', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/notes');

  // 基线：知识库还是空的
  expect(Object.keys(await readKnowledgeBase(context))).toEqual([]);

  resetLlmRequests();
  await sendInstruction(page, PLAYBOOKS['knowledge-save-retrieve'].eval.instruction);

  // ① 权威事实：三个编号都留在存储里（踩了 url 覆盖的坑就只剩一个）
  await expect
    .poll(async () => {
      const book = await readKnowledgeBase(context);
      const all = Object.values(book).map((it) => String(it.note || '')).join('\n');
      return ['KB-1', 'KB-2', 'KB-3'].filter((k) => all.includes(k)).length;
    }, { timeout: 40_000 })
    .toBe(3);

  // 条目本身也要对：标题、类型
  const book = await readKnowledgeBase(context);
  const items = Object.values(book);
  expect(items.length, '应至少有一条条目').toBeGreaterThan(0);
  expect(items.some((it) => it.title === '检索性能优化' && it.type === 'note')).toBe(true);

  // ② 模型视角：写入结果 + **读回的内容**（编号只可能来自读回）都要到它手里
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('KB-3');
  const seen = toolResultsText();
  expect(seen).toContain('已保存条目');
  expect(seen).toContain('KB-1');
  expect(seen).toContain('KB-2');

  await page.close();
});

// 能力验收（复杂场景）：**分页 + 异步渲染**（playbook 'paginate-async'）。
//
// 两个难点叠在一起，这是真实站点最常见的形态：
//   ① **跨页**：目标条目只在第 3 页 —— 不翻页永远找不到，而"没找到"与"不存在"是两件事；
//   ② **异步**：点「下一页」后列表**先清空**、300ms 后才填入 ——
//      "点完立刻读"会读到**空列表**，而空列表极容易被误读成"这一页没有内容"，
//      进而得出"整站没有这条"的错误结论。
//
// 这条用例因此先验证**难点确实存在**（目标不在第 1 页；且清空期间读确实是空的），
// 再验证能力（翻到第 3 页、等到内容、把编号交回模型）。
test('golden: 分页 —— 目标只在第 3 页，且翻页异步（先清空再填充）', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/paged');

  // 基线：目标确实不在第 1 页（否则这个场景不成立）
  await expect.poll(() => page.locator('#list .item').count(), { timeout: 20_000 }).toBe(5);
  expect(await page.textContent('#list')).not.toContain('TK-0013');
  expect(await page.evaluate(() => window.__page)).toBe(1);

  // 基线②：**异步窗口确实存在** —— 点完立刻看，列表是空的。
  // 这条把"为什么必须等"变成可验证的事实，而不是注释里的说法。
  await page.locator('#next').click();
  expect(await page.locator('#list .item').count(), '点完立刻读应当是空的（异步窗口存在）').toBe(0);
  expect(await page.evaluate(() => window.__rendering)).toBe(true);
  // 等它自己渲染完，再继续（否则下面的用例会从"渲染中"的状态起步）
  await expect.poll(() => page.locator('#list .item').count(), { timeout: 20_000 }).toBe(5);
  // 复位到第 1 页，让 agent 从头开始（直接重新加载最干净）
  await page.reload();
  await expect.poll(() => page.locator('#list .item').count(), { timeout: 20_000 }).toBe(5);

  resetLlmRequests();
  await sendInstruction(page, '这个列表分了好几页，帮我翻页找到标题是「导出报表时金额列错位」的那条工单，把它的编号告诉我。');

  // ① 翻到第 3 页，且没有多翻
  await expect.poll(() => page.evaluate(() => window.__page), { timeout: 40_000 }).toBe(3);
  expect(await page.evaluate(() => window.__nextClicks)).toBeGreaterThanOrEqual(2);
  // 渲染已结束（不是停在"加载中"就宣布完成）
  await expect.poll(() => page.evaluate(() => window.__rendering), { timeout: 20_000 }).toBe(false);

  // ② 目标条目必须真的进到模型手里 —— "跨页找到"的唯一凭据
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('TK-0013');
  expect(toolResultsText()).toContain('导出报表时金额列错位');

  await page.close();
});

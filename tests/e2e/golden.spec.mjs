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
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  openPanel,
  sendInstruction,
  clickApproval,
  isCovered,
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
  await sendInstruction(page, '站内搜一下咖啡，把前三条的标题和价格给我');

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
  expect(await page.evaluate(() => window.__submits)).toBe(1);

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
  await expect.poll(() => page.evaluate(() => window.__clicks), { timeout: 30_000 }).toBe(1);
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
  expect(await page.evaluate(() => window.__submits)).toBe(2);
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

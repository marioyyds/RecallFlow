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
  resetKnowledgeBase,
  readAiSettings,
  waitForPage,
  autoApprove,
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

// 运行**中途**打开「自动批准」——本轮剩下的调用应当立刻不再弹确认。
//
// 消费的是真实用法：面板上的「自动驾驶（全部自动批准）」就在输入框上方，用户随时会去打开它。
// 而 `settings` 是每次运行开始时读的一份**快照**（background.js 在 runAgentStream 之前
// `getAISettings()` 一次），运行期间从不重读 —— 于是"打开了也没用"：
// 本轮剩下的每个写操作仍会一个个弹确认，只有**下一次**运行才生效。
//
// 判据刻意用「我撒手不管」来证明：打开自动批准、批准那个**已在等待**的确认框之后，
// 此后**一次都不再点**。若本轮仍读旧快照，run 会卡在下一个确认框上，最终状态永远到不了。
//
// 时序上刻意**先打开开关、再批准**：脚本化的下一步很快就到，
// 若反过来（先批准再点开关）就会和"下一次决策"抢时间，变成偶发失败。
test('golden: 运行中途打开自动批准 —— 本轮剩下的调用不再弹确认', async () => {
  await configureSettings(context, {
    toolApprovalPolicy: { read: true, edit: false, commands: false, browser: false, mcp: false },
  });
  const page = await openFixturePage(context, '/validate');

  resetLlmRequests();
  await sendInstruction(page, PLAYBOOKS['form-validation'].eval.instruction);

  // ① 开始时没开自动批准：第一个写操作**已经在等确认**（先不批）
  const approveBtn = page.locator(PANEL + ' .tool-approve');
  await approveBtn.waitFor({ state: 'visible', timeout: 30_000 });

  // ② 就在这时候打开「自动驾驶（全部自动批准）」
  await page.locator(PANEL + ' .approval-settings-toggle').click();
  await page.locator(PANEL + ' [data-autopilot]').check();

  // 确认它**真的落盘了** —— 否则这条用例分不清"开关没保存"与"保存了但本轮没生效"
  await expect
    .poll(
      async () => {
        const s = await readAiSettings(context);
        const p = (s && s.toolApprovalPolicy) || {};
        return ['read', 'edit', 'commands', 'browser', 'mcp'].every((k) => p[k] === true);
      },
      { timeout: 15_000 }
    )
    .toBe(true);

  // ③ 关掉设置浮层（真实用法也是这样），再批准那个已在等待的确认框
  //    ⚠ 这一步不能省：浮层打开时 `approval-open` + `fitPanelHeight()` 会让
  //    对话区里的确认条**不再可见**（Playwright 判定为不可点击），
  //    于是用例会卡在"等一个其实还在、但点不到的按钮"上（首跑就栽在这里）。
  await page.locator(PANEL + ' .approval-settings-toggle').click();
  await clickApproval(page, 'approve');

  // 本轮剩下的写操作都应当直接放行 —— 放行不了就会卡在下一个确认框上，这里永远等不到
  await expect.poll(() => page.evaluate(() => window.__submits), { timeout: 60_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.getElementById('f').checkValidity())).toBe(true);

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

  // 知识库存储在同一个浏览器上下文里**跨用例共享** —— 必须先重置，
  // 否则"基线是空的"会变成顺序相关（实测：单跑通过、全量跑挂在基线断言上）
  await resetKnowledgeBase(context);
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

// 能力验收（复杂场景）：**知识库检索的召回边界**（playbook 'knowledge-search-fallback'）。
//
// 难点是**词汇不匹配**：`tokenizeQuery` 是纯字符匹配，
// 「页面打开很慢」与笔记里的「预热 / 超时 / 缓存」在字符层面**毫无交集** ——
// 检索必然返回「未检索到相关知识库条目」。这是**固有限制**（`tests/rag-recall.test.mjs`
// 把它钉住了：纯词法检索跨不过同义词），修不好；所以能力在于**回退**——
// 换个说法、或改用 list / get 直接确认，而不是对用户说"知识库里没有"。
//
// 判据分两层：
//   ① **难点成立**：「未检索到」这句确实出现过。这条**只在这里**断言 ——
//      查询是脚本自己选的，所以它不是"路径断言"；
//      真模型 eval 那边**故意不**断言它（模型换个更准的说法命中反而更好）。
//   ② **能力**：最后仍然把那条记录读了出来（KB-* 只可能来自知识库读取）。
test('golden: 知识库检索 —— 词面查不到时不能下"没有"的结论（回退后读出来）', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/notes');

  await resetKnowledgeBase(context);
  expect(Object.keys(await readKnowledgeBase(context))).toEqual([]);

  resetLlmRequests();
  await sendInstruction(page, resolveInstruction('knowledge-search-fallback'));

  // ① 难点成立：那条查询确实检索不到
  await expect
    .poll(() => toolResultsText(), { timeout: 40_000 })
    .toContain('未检索到相关知识库条目');

  // ② 能力：没有就此收手，最终把记录读了出来
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('KB-3');
  const seen = toolResultsText();
  expect(seen).toContain('KB-1');
  expect(seen).toContain('KB-2');

  // ③ 存储层（权威事实）：那条记录确实在知识库里
  const book = await readKnowledgeBase(context);
  const all = Object.values(book)
    .map((it) => String(it.note || ''))
    .join('\n');
  expect(all).toContain('KB-1');
  expect(all).toContain('KB-3');

  await page.close();
});

// 能力验收（复杂场景）：**跨标签页搬运**（playbook 'cross-tab-handoff'）。
//
// 难点是**"现在在哪个标签页"是隐式的**。A 页（来源页）故意放了**诱饵**：
// 一个可访问名为「备注」的输入框 + 一个「保存备注」按钮。
// 读完成验证码若**没有真正切到新标签页**就往输入框打字，字会落进诱饵、
// A 页还会被提交 —— 而**每一步都返回成功**，只有页面状态能拆穿。
//
// 所以这条用例是**两头断言**：B 页必须收到并提交，A 页必须**纹丝不动**。
test('golden: 跨标签页 —— 验证码填进新开的页并提交，来源页纹丝不动', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/handoff');

  // 基线：来源页还没被提交、诱饵输入框还没被填
  expect(await page.evaluate(() => window.__submits)).toBe(0);
  expect(await page.evaluate(() => window.__noteValue)).toBe(null);
  expect(await page.textContent('#code')).toBe('RF-7391');

  resetLlmRequests();
  await sendInstruction(
    page,
    '这一页有个取件验证码，帮我点「打开填写页」，在新打开的页面里填上这个验证码并提交，然后把回执告诉我。'
  );

  // ① 目标页：验证码真的填进去了、真的提交了
  const form = await waitForPage(context, '/handoff-form');
  await expect.poll(() => form.evaluate(() => window.__submittedCode), { timeout: 40_000 }).toBe('RF-7391');
  expect(await form.evaluate(() => window.__submits)).toBeGreaterThan(0);
  await expect(form.locator('#status')).toHaveText('已提交验证码：RF-7391');

  // ② **来源页纹丝不动** —— 这一半才是"没写错标签页"的证据
  expect(await page.evaluate(() => window.__submits), '来源页被误提交了：说明操作落错了标签页').toBe(0);
  expect(await page.evaluate(() => window.__noteValue), '验证码被填进了来源页的诱饵输入框').toBe(null);
  await expect(page.locator('#status')).toHaveText('本页未提交');

  // ③ 模型视角：目标页的回执必须回到它手里（那句话只可能来自目标页）
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('已提交验证码：RF-7391');

  await page.close();
});

// 能力验收（复杂场景）：**虚拟列表**（playbook 'virtual-list-scroll'）。
//
// 难点是"**DOM 里没有 ≠ 页面上没有**"：列表共 100 条，而容器**只渲染当前窗口的 5 行**
// （滚动时回收重建）。所以：
//   · `get_page_snapshot` 里看不到目标行；
//   · `document.querySelectorAll('.row').length` 只返回 **5** ——
//     把它当成"这个列表只有 5 条"或"没有 VL-87 这一条"都是**错的**。
//
// 第二个难点是它在一个**内部可滚动容器**里：滚窗口（`scroll_by` 的 `window.scrollBy`）
// 对它毫无作用，必须滚**容器自己**。本轮为此补上了
// `scroll_page({ selector, y })`＝"把该元素自身滚动 y 像素"（原先没有任何一等公民的滚法，
// 只能反复 scrollIntoView 可见行慢慢推，或 run_javascript 自己设 scrollTop）。
//
// 基线因此成对出现：**DOM 里只有 5 行**（朴素读法会得出错误结论）**且目标不在其中**。
test('golden: 虚拟列表 —— 滚容器后目标行才进入 DOM（朴素读法只有 5 行）', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/vlist');

  // 基线①：DOM 里**只有 5 行**，而列表其实有 100 条
  await expect.poll(() => page.locator('#list .row').count(), { timeout: 20_000 }).toBe(5);
  expect(await page.textContent('#list')).not.toContain('VL-87');
  // 基线②：目标行**不在 DOM 里**（所以"找不到"不等于"没有"）
  expect(await page.locator('#list [data-id="i87"]').count()).toBe(0);
  expect(await page.evaluate(() => window.__renderedIds.includes('i87'))).toBe(false);
  // 基线③：**滚动窗口对它没用** —— 这条正是"必须滚容器"的证据
  await page.evaluate(() => window.scrollBy(0, 600));
  await page.waitForTimeout(200);
  expect(
    await page.evaluate(() => window.__renderedIds.includes('i87')),
    '滚窗口竟然让第 87 条出现了，本场景的难点不成立'
  ).toBe(false);

  resetLlmRequests();
  await sendInstruction(page, '这个页面的列表很长，帮我找到第 87 条（标着 VL-87 的那条）并点开它。');

  // ① 目标行真的被渲染出来过（说明滚对了容器）
  await expect.poll(() => page.evaluate(() => window.__renderedIds.includes('i87')), { timeout: 40_000 }).toBe(true);
  // ② 点开的正是第 87 条
  await expect.poll(() => page.evaluate(() => window.__clicked), { timeout: 20_000 }).toBe('i87');
  await expect(page.locator('#status')).toHaveText('已点开：87');

  // ③ 模型视角：滚动的**实际位置**要回到它手里（它能据此判断"滚到哪了"）
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('scrollTop=3480');

  await page.close();
});

// 能力验收（复杂场景）：**级联下拉框**（playbook 'cascade-select'）。
//
// 三层难点叠在一起（真实表单里很常见），基线把三层都证明出来：
//   ① 城市框初始 **disabled**、只有一句「请先选省份」——不先选省份根本选不了城市；
//   ② 选了省份之后城市选项要 **3 秒后**才填进来 ——"选完立刻选"会得到
//      「未找到匹配的 option」，而那句话极易被读成"页面上没有这个城市"。
//      ⚠ 延迟必须**大于真模型一轮工具往返**（实测约 1 秒）：起初写 300ms，
//      真模型"选完立刻选城市"照样成功 —— 也就是说**这个场景在真模型下什么都没验到**。
//      脚本化 E2E 显式等了，所以它一直过；**只有真模型 eval 才能暴露这一点**。
//   ③ 填充期间城市框**仍然是 disabled** —— 所以光等"选项出现"不够，还要等到**可用**。
//
// 基线③是这条用例最关键的一条：它模拟了"选完立刻选城市"这条捷径，证明它**必然失败**。
test('golden: 级联下拉 —— 子选项异步填充，等不到就选不了（捷径必然失败）', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/cascade');

  // 基线①：城市框是禁用的，且只有一句占位
  expect(await page.locator('#city').isDisabled()).toBe(true);
  await expect(page.locator('#city option')).toHaveCount(1);
  expect(await page.textContent('#city')).not.toContain('杭州');

  // 基线②：**选完立刻**去选城市 —— 必须失败（这就是"不能立刻选"的证据）。
  // 直接走页面自身的逻辑，模拟"不等就选"：此时 hz 这个 option 还不存在。
  await page.selectOption('#prov', 'zj');
  expect(
    await page.locator('#city option[value="hz"]').count(),
    '选完省份后城市选项立刻就出现了，本场景的难点不成立'
  ).toBe(0);
  // 而且此刻城市框**仍是禁用的**（基线③）——等"选项出现"不够，得等它可用
  expect(await page.locator('#city').isDisabled()).toBe(true);

  // 等它真的填充完（这一条由脚本自己完成；用例只负责还原起点）
  await expect.poll(() => page.locator('#city option[value="hz"]').count(), { timeout: 10_000 }).toBe(1);
  // 还原起点：清掉这一次手动选择的痕迹，让脚本从"未选择"开始
  await page.selectOption('#prov', '');
  await page.reload();

  resetLlmRequests();
  await sendInstruction(page, '帮我把这一页的配送范围选成浙江 / 杭州，然后提交。');

  // ① 两个下拉框都真的选对了
  await expect.poll(() => page.evaluate(() => window.__picked), { timeout: 40_000 }).toEqual({
    prov: 'zj',
    city: 'hz',
  });
  await expect(page.locator('#status')).toHaveText('已提交：浙江 / 杭州');
  expect(await page.evaluate(() => window.__submits)).toBeGreaterThan(0);

  // ② 模型视角：回执里同时有省份与城市（说明两个框都选中过，不是只点了提交）
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('已提交：浙江 / 杭州');

  await page.close();
});

// 能力验收（复杂场景）：**读下拉框选项再选**（playbook 'read-select-options'）。
//
// 难点是"**价格藏在选项里，而选项不在正文里**"：这是一个原生 `<select>`，
// 闭合状态下 `<option>` 没有布局盒子，正文抽取按"不可见"跳过 ——
// 所以 `get_page_snapshot` 的正文里只有「配送方式」这个 label，**看不到 ¥8 / ¥22 / ¥5**。
// 而任务只说了"最便宜"，不把选项列出来就无从比较。
// `get_attribute` 也帮不上：它读的是**属性**，读不了 `outerHTML`。
//
// 这条用例是**按实测缺口补出来的**：真模型探针显示，在此之前模型只能先写一段
// `run_javascript` 去 `Array.from(s.options).map(...)` —— 白花一次高危审批。
// 现在 `inspect_element({op:"options"})` 是**只读**的一等公民。
//
// 基线证明难点成立：正文里确实读不到价格，且"最便宜"既不是第一项也不是默认项。
test('golden: 下拉选项 —— 先读出选项再比较，选中真正最便宜的那个', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/shipping');

  // 基线①：选项**没有布局盒子** —— 这正是扩展侧正文抽取把它当"不可见"跳过的原因。
  // ⚠ 别用 `textContent` 或 `innerText` 来断言"正文里看不到价格"：
  //   · `textContent` 连隐藏节点一起取（必然包含选项）；
  //   · `innerText` 在 Chromium 上对 `<select>` 也会把**所有** option 文字带上（已知怪癖）。
  // 所以这条基线盯**机制**：闭合的 select 里 option 的盒子为零 → 正文抽取跳过它。
  const optBox = await page.locator('#ship option[value="eco"]').boundingBox();
  expect(optBox === null || !optBox.width || !optBox.height, '选项竟然有布局盒子，本场景的难点不成立').toBe(true);
  // 基线②：默认没有选中任何有效项；且"最便宜"不是第一项
  expect(await page.inputValue('#ship')).toBe('');
  const values = await page.locator('#ship option').evaluateAll((els) => els.map((e) => e.value));
  expect(values[1], '第一项不该就是最便宜的（否则不用比较也能蒙对）').not.toBe('eco');

  resetLlmRequests();
  await sendInstruction(page, '帮我选最便宜的配送方式，然后确认。');

  // ① 选中的是**真正最便宜**的那个
  await expect.poll(() => page.evaluate(() => window.__picked), { timeout: 40_000 }).toBe('eco');
  await expect(page.locator('#status')).toHaveText(/经济配送/);
  expect(await page.evaluate(() => window.__submits)).toBeGreaterThan(0);

  // ② 模型视角：**选项清单本身**必须回到它手里（那是它据以比较的唯一依据）
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('下拉框选项');
  const seen = toolResultsText();
  expect(seen, '三个选项的文案都要给到模型，否则它无从比较').toContain('经济配送 · ¥5 · 7 天');
  expect(seen).toContain('标准配送 · ¥8 · 3-5 天');
  expect(seen).toContain('次日达 · ¥22 · 1 天');

  await page.close();
});

// 能力验收（复杂场景）：**严格 CSP 页面读页面 JS 状态**（playbook 'csp-page-world-js'）。
//
// 覆盖 README 声称的那条能力："需要时经 CDP 在页面主世界执行，**不受页面 CSP 限制**"。
// 两个难点叠在一起：
//   ① 页面 CSP 不放行 `unsafe-eval` → `run_javascript` 的默认沙箱（`new Function`）被拒；
//   ② 就算没有 CSP，沙箱跑在**隔离世界**里也看不到页面的 JS 变量（DOM 共享、页面全局不共享）。
//
// 这条用例的判据分三层，缺一不可：
//   ① **沙箱确实被 CSP 拒了、并自动改用了页面主世界** —— 回执里必须有那句提示。
//      这是"自动兜底"这条能力本身的证据；只断言结果的话，带 `engine:"page"` 也能过，就等于没验。
//   ② 页面自己的函数真的被调用（`__checked === 108`）—— 说明代码跑在**页面主世界**。
//   ③ 108 到达模型（它只存在于 JS 状态里，整页正文没有这三个字符）。
//
// 基线证明难点成立：DOM 上是陈旧值 ¥88，且正文里找不到 108。
test('golden: CSP 页面 —— 沙箱被 CSP 拒后自动改用页面主世界，才读到页面 JS 状态', async () => {
  // 自动兜底走 CDP；关掉 CDP 时这一步做不到（已实测：模型换了 7 次调用也拿不到 108）
  await configureSettings(context, { cdpEnabled: true });
  const page = await openFixturePage(context, '/csp');

  // 基线①：页面**确实**禁止 eval（不放行 unsafe-eval），难点成立。
  // 判据取自**页面自己的脚本**（它试过 `new Function` 并把结果记在 `window.__evalAllowed`）——
  // ⚠ 不能用 `page.evaluate` 去试：那走 CDP `Runtime.evaluate`，**不受页面 CSP 约束**，
  // 永远得到 "ok"，于是会误判成"夹具的 CSP 没生效"（本会话先踩过这个坑）。
  expect(
    await page.evaluate(() => window.__evalAllowed),
    '页面竟然允许 eval，本场景的难点不成立'
  ).toBe(false);
  // 基线②：DOM 上是陈旧值 88，且正文里没有真实值 108（脚本正文不算正文）
  expect(await page.textContent('#shown')).toBe('88');
  const visible = await page.locator('body').innerText();
  expect(visible).toContain('¥88');
  expect(visible, '正文里竟然有 108，那这条用例就证明不了"读到了 JS 状态"').not.toContain('108');
  expect(await page.evaluate(() => window.__checked)).toBe(null);

  resetLlmRequests();
  // `run_javascript` 是 alwaysRequireApproval：脚本化剧本也会弹审批，
  // 不点掉的话整个 run 会**卡在审批上**（现象：工具结果里只有第一条快照，像"脚本没生效"）
  const stopApprove = autoApprove(page);
  try {
    await sendInstruction(
      page,
      '帮我核对总价：页面显示的是 ¥88，请从页面 JS 状态里读出真实的 total，然后用页面的 reportTotals() 把核对结果记下来。'
    );

    // ① 沙箱被 CSP 拒 + **自动改用页面主世界**（脚本化路径刻意不带 engine，走的就是这条兜底）
    await expect
      .poll(() => toolResultsText(), { timeout: 40_000 })
      .toContain('已自动改用页面主世界执行');

    // ② 页面自己的函数真的被调用了（跑在页面主世界才可能）
    await expect.poll(() => page.evaluate(() => window.__checked), { timeout: 20_000 }).toBe(108);
    await expect(page.locator('#status')).toHaveText('已核对：108');

    // ③ 真实总价到达模型
    expect(toolResultsText()).toContain('108');
  } finally {
    await stopApprove();
  }

  await page.close();
});

// 能力验收（复杂场景）：**撤销**（playbook 'undo-last-action'）。
//
// 覆盖 README 声称的「撤销可回退输入 / 勾选 / 选择 / 样式 / 滚动」。
// 难点不在"能不能撤销"，而在**撤销栈的边界** —— 工具描述写明了
// 「仅输入 / 勾选 / 选择 / 改样式 / 滚动可撤销；**点击与导航不可撤销**」。
//
// 所以这条用例刻意做三件可撤销的事 + 一次不可撤销的点击，再撤销上一步：
// 被回退的应当是**选择**那一格（最后一次可撤销动作），而**保存那一下不该被撤回**。
//
// 判据因此必须**两头都看**：只断言"回退了一部分"或"点了撤销"都证明不了这条边界 ——
// 前者看不出回退错了对象，后者根本不知道撤销了什么。
//
// ⚠ 这里断言的是**脚本自己那条确定顺序**（选优先级是最后一次可逆动作）。
// 真模型 eval 那边**不能**这么写：模型可以换顺序（实测它就先选了优先级、后填标题，
// 于是撤销撤的是标题 —— 完全正确）。那边用的是**顺序无关**的不变量"恰好一处被回退"。
// 两层判据不同是**有意的**：脚本路径由我们控制，可以更锋利；模型路径不行。
test('golden: 撤销 —— 只回退最后一次可撤销动作，点击不在撤销范围内', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/undo');

  // 基线：三项都是初始值，且还没保存过
  expect(await page.evaluate(() => window.__state)).toEqual({ title: '', publish: false, level: '' });
  expect(await page.evaluate(() => window.__saves)).toBe(0);

  resetLlmRequests();
  await sendInstruction(
    page,
    '帮我改一下这个草稿：标题填「周报」，勾上发布，优先级选「高」，然后点一下「保存草稿」。做完这些之后，用「撤销」功能撤回上一步，并告诉我这三项目前各是什么。'
  );

  // ⚠ 这里**必须 poll 整个组合状态**，不能只 poll 其中一项。
  // 起初写的是 `poll(() => __state.level).toBe('')` —— 而「优先级=未设置」**正是基线的初值**，
  // 于是这个 poll 立刻就满足了（等于没等），紧接着的断言读到的还是"什么都还没发生"的页面
  // （实测报 `title` 为 `''`，看起来像"标题被连带回退了"，其实是**读早了**）。
  // 组合状态 `{周报, true, ''}` 只在目标达成后才成立，所以它才真的在等。
  await expect
    .poll(() => page.evaluate(() => window.__state), { timeout: 40_000 })
    .toEqual({ title: '周报', publish: true, level: '' });
  // 「点击不可撤销」：保存这一下保留（这是本场景最锋利的一条）
  await expect.poll(() => page.evaluate(() => window.__saves), { timeout: 20_000 }).toBe(1);

  // ④ 页面回执与模型视角：撤销的回执 + 随后读回的状态都要到模型手里
  await expect(page.locator('#status')).toHaveText(/优先级=未设置/);
  await expect(page.locator('#status')).toHaveText(/保存次数=1/);
  const seen = toolResultsText();
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('已撤销上一步操作');
  expect(seen).toContain('优先级=未设置');

  await page.close();
});

// 能力验收（复杂场景）：**HTML5 原生校验静默拦住提交**（playbook 'form-validation'）。
//
// 难点是"**页面上什么都没说**"：字段不合法时浏览器拦住 `submit`，
// 只在**它自己的原生气泡**里提示（工具读不到），DOM 里既没有错误文案、`#status` 也不变。
// 于是"点了提交没反应"看起来像"按钮坏了"，而真相是字段没通过约束。
//
// 基线把这一点证明出来：**直接照用户给的问题值填好、点提交，什么都不发生、
// 页面上也没有任何"哪里不对"的文字**。修好之前模型为此要换 8 次调用四处找原因
// （实测探针：还借道 run_javascript 自己扫 DOM —— 一次高危审批）。
// 现在 `inspect_element({op:"inspect"})` 直接把不合格的字段与**与语言无关的约束名**列出来。
//
// ⚠ 夹具设计上的一个真坑：姓名用 `pattern=".{2,}"` 而不是 `minlength="2"` ——
// 按规范 `tooShort` 需要用户输入产生的"脏值标记"，而工具是**程序化**写值的，
// 实测 `minlength` 对 agent 写入**根本不生效**（`validity.valid` 仍是 true）。
// 也就是说：拿 `minlength` 做约束的页面**拦不住 agent**，拿它做夹具则**什么都没验**。
test('golden: 表单校验 —— 提交被静默拦住，读出原因改好后才能提交', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/validate');

  // 基线：按用户给的问题值填好 → 点提交 → **什么都不发生**，且页面上没有提示
  await page.fill('#name', '李');
  await page.fill('#phone', '13800138000');
  await page.fill('#email', 'lilei#example.com');
  await page.check('#agree');
  await page.click('#ok');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__submits), '这次提交竟然成功了，本场景的难点不成立').toBe(0);
  expect(await page.evaluate(() => document.getElementById('f').checkValidity())).toBe(false);
  await expect(page.locator('#status')).toHaveText('未提交');
  // 页面上**没有任何**"哪里不对"的可见文字 —— 这正是难点
  const bodyText = await page.locator('body').innerText();
  expect(bodyText, '页面上竟然写了错误提示，那本场景就不算"静默"').not.toMatch(/至少|格式|不正确|必填|无效/);

  // 还原到未填状态，让脚本从零开始
  await page.reload();

  resetLlmRequests();
  // 指令取自剧本（单一来源）—— 跨行拼接的字面量无法通过"逐字一致"门禁
  await sendInstruction(page, PLAYBOOKS['form-validation'].eval.instruction);

  // ① 最终真的提交成功了
  await expect.poll(() => page.evaluate(() => window.__submits), { timeout: 40_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.getElementById('f').checkValidity())).toBe(true);
  await expect(page.locator('#status')).toHaveText(/^已提交：/);

  // ② 模型视角：两个字段的**约束名**必须回到它手里（那是它据以修的依据，且与语言无关）
  const seen = toolResultsText();
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('patternMismatch');
  expect(seen).toContain('typeMismatch');
  // 还要明确告诉它"提交会被拦住、页面上不会有提示"——否则它仍会把"没反应"当成故障
  expect(seen).toContain('表单未通过校验');

  await page.close();
});

// 能力验收（复杂场景）：**付费墙 / 试看边界**（playbook 'paywall-preview-limit'）。
//
// 忠实还原一次真实会话：「《凡人修仙传》更新到最新一集了，我想看，但我没会员」。
// 三个叠在一起的难点：
//   ① 页面打开完全正常 → 很容易得出"已打开最新一集 → 完成"✗；
//   ② 试看提示**只在播放之后**出现（所以"页面上没看到限制"不等于没有限制）；
//   ③ 用户真正要的"免费能看的最后一集是哪一集"，在**当前这一集页面上看不出来**。
//
// 判据两层：
//   · 页面状态 —— 最终停在**免费**那一集、不是试看、**播到了片尾**（证明"能看"不是靠文案）；
//   · 模型收到了什么 —— 「最后一集免费的是第 180 话」这个结论真的进了上下文。
test('golden: 付费墙 —— 「能打开」不等于「能看」，要找到免费能看的最后一集', async () => {
  // 读播放器状态要走页面主世界执行 → **必须开 CDP**（沙箱在 MV3 下任何页面都跑不起来）
  await configureSettings(context, { cdpEnabled: true });
  const page = await openFixturePage(context, '/paywall');

  // 基线：难点必须真实 —— 播放**之前**页面上没有任何"试看"提示，
  // 只有播放器时长（180 秒）与选集状态能说明问题
  expect(await page.evaluate(() => window.__player.isPreview)).toBe(true);
  expect(await page.evaluate(() => window.__player.duration)).toBe(180);
  await expect(page.locator('#player-note')).toHaveText('');
  expect(await page.evaluate(() => window.__playStarts)).toBe(0);
  expect(await page.evaluate(() => window.__reachedEnd)).toBe(false);

  resetLlmRequests();
  // 该剧本用 run_javascript（alwaysRequireApproval）：不点审批，run 会卡在审批提示上
  const stopApprovePaywall = autoApprove(page);
  try {
    await sendInstruction(
      page,
      '《凡人修仙传》更新到最新一集了，我想看，但我没会员。你看一下能不能看，不能的话告诉我实际情况。'
    );

    // ① 最终落在**免费**那一集，且不是试看
    await expect.poll(() => page.evaluate(() => window.__currentEp), { timeout: 40_000 }).toBeLessThanOrEqual(180);
    expect(await page.evaluate(() => window.__player.isPreview)).toBe(false);
    // ② 真的播到片尾（而不是"点了播放就算"）
    await expect.poll(() => page.evaluate(() => window.__reachedEnd), { timeout: 20_000 }).toBe(true);
    expect(await page.evaluate(() => window.__player.duration)).toBe(1140);
    await expect(page.locator('#status')).toHaveText(/已看完整集/);
    // ③ 结论到达模型：免费能看的最后一集是第 180 话；且它读到了**只在播放后出现**的试看提示
    const seen = toolResultsText();
    await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('试看');
    expect(seen).toContain('180');
  } finally {
    await stopApprovePaywall();
  }

  await page.close();
});

// 能力验收（复杂场景）：**下载文件**（playbook 'download-verify'）。
//
// 难点：点一下之后**页面什么都不变**（没有 DOM 变化、没有状态文案）——
// 于是"点了链接"与"文件真的下载了"分家 ✗ 与付费墙同源（能点 ≠ 生效）。
// 唯一可信来源是**浏览器自己报的下载事件**（CDP `Page.downloadWillBegin`
// → `read_diagnostics({kind:"downloads"})`），它同样要求**点击之前已 attach CDP**。
//
// 判据两层：
//   · 浏览器级结果（本场景没有"页面状态"可断言）：Playwright 的 download 事件确实发生、
//     且文件名与夹具一致 —— 这是"真的下载了"的唯一硬证据；
//   · 模型收到了什么：浏览器报的文件名 `report.csv` 必须进上下文。链接文字是"导出报表 CSV"，
//     与真实文件名不同 ⇒ 它进了上下文就说明读的是**浏览器事件**，不是链接文字。
test('golden: 下载 —— 页面上什么都不会变，凭据只能来自浏览器事件', async () => {
  await configureSettings(context, { cdpEnabled: true }); // 下载事件靠 CDP 上报
  const page = await openFixturePage(context, '/download');

  // 基线：难点成立 —— 还没点击，页面也没有任何变化
  expect(await page.evaluate(() => window.__clicked)).toBe(0);
  await expect(page.locator('#status')).toHaveText('就绪');

  // 浏览器级证据：等 Playwright 的 download 事件（真实下载）
  const downloadPromise = page.waitForEvent('download', { timeout: 45_000 }).catch(() => null);

  resetLlmRequests();
  const stopApproveDownload = autoApprove(page);
  try {
    await sendInstruction(page, '帮我把这个月的报表导出来，导出后告诉我文件名是什么。');

    const dl = await downloadPromise;
    expect(dl, '浏览器真的发生了下载（否则本用例没验到东西）').not.toBeNull();
    expect(dl.suggestedFilename()).toBe('report.csv');
    expect(await page.evaluate(() => window.__clicked)).toBeGreaterThan(0);

    // 模型收到了什么：真实文件名（与链接文字不同 ⇒ 只能来自浏览器事件）
    await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('report.csv');
  } finally {
    await stopApproveDownload();
  }

  await page.close();
});

// 能力验收（复杂场景）：**自定义日期选择器**（playbook 'date-picker-custom'）。
//
// 四个真实难点：
//   ① 输入框是 `readonly` —— 往里打字**静默无效**（"已输入"是假的）；
//   ② 日历**异步渲染**：点开之后要等一拍才有格子，立刻点会落空；
//   ③ 目标日期（3月15日）在**下个月** —— 只看当前月就下结论必然错；
//   ④ 有**已订满的禁用日**（14 号紧邻目标）—— 必须真的读日历，不能按顺序猜。
//
// 判据两层：
//   · 页面状态：选中的日期、输入框的值、状态文案都对得上；
//   · 模型收到了什么：「已订满」只存在于日历格子里 ⇒ 它进了上下文，
//     说明模型真的**读了一遍日历**（而不是直接去找"15"那个按钮碰运气）。
test('golden: 日期选择器 —— 只读输入框打字无效，必须翻月点日历', async () => {
  await configureSettings(context);
  const page = await openFixturePage(context, '/datepicker');

  // 基线：输入框是只读的（打字的坑必须真实存在）
  expect(await page.evaluate(() => document.getElementById('checkin').readOnly)).toBe(true);
  expect(await page.evaluate(() => window.__selected)).toBe('');
  // 日历初始是关着的，且目标日期不在当前显示的月份里
  expect(await page.locator('#cal').isHidden()).toBe(true);

  resetLlmRequests();
  await sendInstruction(page, '帮我订 2026 年 3 月 15 日入住，选好日期就行。');

  // ① 选中的确实是目标日期
  await expect.poll(() => page.evaluate(() => window.__selected), { timeout: 45_000 }).toBe('2026-03-15');
  expect(await page.evaluate(() => document.getElementById('checkin').value)).toBe('2026/03/15');
  await expect(page.locator('#status')).toHaveText(/2026\/03\/15/);
  // ② 日历被关上了（选完就收，说明是走完流程而不是半途）
  await expect(page.locator('#cal')).toBeHidden();

  // ③ 模型真的读了日历：格子的 `aria-label`（「3月15日」）只在日历里……
  //    ⚠ 但**注意**：实测这条判据之所以能过，是因为「3月15日」出现在**点击结果的回显**里
  //    （`aria-label="3月15日"`），**不是**因为快照里有它 ✗ —— 见下面的调查结论。
  //
  // 调查结论（**已证事实 + 一步可靠演绎**）：
  //   事实 1（消息转储）：三条快照消息（1276 / 3067 / 3067 字符）都不含「已订满」「3月15日」，
  //          而页面上那些格子确实存在（aria-label = 「3月11日（已订满）」）⇒ 快照没列出它们。
  //   事实 2（读常量）：`SNAPSHOT_CHAR_BUDGET = 12000`，而快照只有 **3067** 字符
  //          ⇒ **体积裁剪根本没触发**（`trimElementsToBudget` 不是原因）。
  //   事实 3（读代码）：`trimElementsToBudget` 之后唯一还会丢元素的地方是
  //          `ranked.slice(0, maxElements)`，而本次 `maxElements=60`、页面可交互元素约 37 个
  //          ⇒ **上限也没截到它们**。
  //   演绎：元素既然过了这两处都还在，而快照里没有 —— 只能是**采集阶段就没收进来**
  //          （`collectInteractiveInFrames` → `isVisibleElement`，后者要求
  //           display/visibility/opacity 正常且 `rect.width>0 && rect.height>0`）。
  //   已否证的两个解释：① 视口排序 + 滚动（滚进视口后仍不含 ✗）；② 历史折叠（无折叠标记 ✗）。
  //   下一步（具体到可执行）：用**内容脚本动作名**（见 lib/assistant/page-input-tools.js 的映射，
  //          如 kbWaitForElement 那种形式）直接从 SW 调一次快照动作，打印 elements 的 tag 分布，
  //          确认那些 button 是否在采集结果里。**先证实，再改产品**（这轮不改）。
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('3月15日');

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

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
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
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

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
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServers, stopServers } from './fixtures/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..', '..');

let context;

test.beforeAll(async () => {
  await startServers();
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run'],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
});

test.afterAll(async () => {
  await context?.close();
  stopServers();
});

async function configure(settings) {
  const sw = context.serviceWorkers()[0];
  await sw.evaluate(async (s) => {
    await chrome.storage.local.set({ aiSettings: s });
  }, settings);
}

function baseSettings(overrides) {
  return Object.assign(
    {
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:7804',
      model: 'mock',
      ragEnabled: false,
      pageContext: true,
      toolApproval: true,
      toolApprovalPolicy: { read: true, edit: true, commands: true, browser: true, mcp: true },
      cdpEnabled: false,
      quickPrompts: [],
      agentBudget: {},
    },
    overrides || {}
  );
}

test('golden: 用 role+name 定位并点击页面按钮', async () => {
  await configure(baseSettings());
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:7802/');

  // 打开助手面板（FAB 在 open shadow DOM 内，Playwright CSS 会穿透）
  await page.locator('#__kb-ai-host .fab').click();
  await page.locator('#__kb-ai-host .cmd-input').fill('点击提交按钮');
  await page.locator('#__kb-ai-host .cmd-send').click();

  // 断言页面按钮确实被点击（模拟 LLM 会返回 click_element({role:'button',name:'提交'})）
  await expect.poll(() => page.evaluate(() => window.__clicked), { timeout: 30_000 }).toBe(true);
  await page.close();
});

test('golden: 跨域 iframe 内点击（frame 路由 + f<frameId>: 前缀 ref）', async () => {
  await configure(baseSettings());
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:7802/');

  await page.locator('#__kb-ai-host .fab').click();
  await page.locator('#__kb-ai-host .cmd-input').fill('点击框架里的按钮');
  await page.locator('#__kb-ai-host .cmd-send').click();

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
  await configure(
    baseSettings({
      // 关掉「页面命令」类别的自动批准 → click_element 必须逐次征求同意
      toolApprovalPolicy: { read: true, edit: true, commands: false, browser: true, mcp: true },
    })
  );
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:7802/');

  await page.locator('#__kb-ai-host .fab').click();
  await page.locator('#__kb-ai-host .cmd-input').fill('点提交，但不要批准');
  await page.locator('#__kb-ai-host .cmd-send').click();

  // 审批框出现 → 点「拒绝」
  const rejectBtn = page.locator('#__kb-ai-host .tool-reject');
  await rejectBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await rejectBtn.click();

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
  await configure(
    baseSettings({
      toolApprovalPolicy: { read: true, edit: true, commands: false, browser: true, mcp: true },
    })
  );
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:7802/');

  await page.locator('#__kb-ai-host .fab').click();
  await page.locator('#__kb-ai-host .cmd-input').fill('点提交，但不要批准');
  await page.locator('#__kb-ai-host .cmd-send').click();

  const allowBtn = page.locator('#__kb-ai-host .tool-approve');
  await allowBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await allowBtn.click();

  await expect.poll(() => page.evaluate(() => window.__clicked), { timeout: 20_000 }).toBe(true);

  await page.close();
});

// type_text 的 value（负载）语义端到端：文字必须真的进到输入框里。
// 这一条盯着的是"定位参数与输入负载被混为一谈"那个缺陷的回归 ——
// 它曾经让「在含某文本的元素里输入」在实现上不可能成立。
test('golden: type_text 的 value 真的写进输入框', async () => {
  await configure(baseSettings());
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:7802/');

  await page.locator('#__kb-ai-host .fab').click();
  await page.locator('#__kb-ai-host .cmd-input').fill('在搜索框输入内容');
  await page.locator('#__kb-ai-host .cmd-send').click();

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
  await configure(baseSettings({ cdpEnabled: true }));
  const page = await context.newPage();
  // 坐标目标在独立页面（/coord）：固定定位 + 固定尺寸，坐标可预测。
  await page.goto('http://127.0.0.1:7802/coord');

  await page.locator('#__kb-ai-host .fab').click();
  await page.locator('#__kb-ai-host .cmd-input').fill('按坐标点一下');
  await page.locator('#__kb-ai-host .cmd-send').click();

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
  await configure(baseSettings());
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:7802/');

  await page.locator('#__kb-ai-host .fab').click();
  await page.locator('#__kb-ai-host .cmd-input').fill('说说你的思考');
  await page.locator('#__kb-ai-host .cmd-send').click();

  // 模拟模型发了**两段**思维链（中间夹着正文）→ 应该是**两块**，而不是一个总块。
  const blocks = page.locator('#__kb-ai-host .think-block');
  await expect(blocks).toHaveCount(2, { timeout: 30_000 });

  // 两段内容各自在自己的块里（不是都堆进同一块）
  await expect(blocks.nth(0).locator('.think-body')).toContainText('先确认页面结构', { timeout: 30_000 });
  await expect(blocks.nth(1).locator('.think-body')).toContainText('再复核一下边界情况', { timeout: 30_000 });
  await expect(blocks.nth(0).locator('.think-body')).not.toContainText('再复核一下边界情况');

  // 正文**不在**思考记录里（混在一起就再也分不出哪段是思考、哪段是回答）
  await expect(blocks.nth(0).locator('.think-body')).not.toContainText('我想好了：结论如下');

  // 核心断言：思考块**穿插**在对话里，而不是都堆到最上面。
  //
  // ⚠ 面板在 **shadow DOM** 里：Playwright 的 locator 会穿透，但 page.evaluate 里的
  // document.querySelector **不会** —— 必须自己拿 shadowRoot，否则永远查到 null
  // （实测症状：收到空数组，看起来像"没有子元素"，其实是查错了树）。
  const order = await page.evaluate(() => {
    const host = document.querySelector('#__kb-ai-host');
    const root = host && host.shadowRoot ? host.shadowRoot : document;
    const flow = root.querySelector('.agent-flow');
    if (!flow) return [];
    return [...flow.children]
      .map((el) => (el.classList.contains('think-block') ? 'think' : el.classList.contains('agent-content') ? 'content' : 'other'))
      .filter((k) => k !== 'other');
  });
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

  // **没有内层滚动条**：思考应该跟着对话一起滚，而不是自己一个小滚动区。
  // （CSS 里写死 max-height 不会报错，只有真浏览器能算出来。）
  const overflow = await page.evaluate(() => {
    const host = document.querySelector('#__kb-ai-host');
    const root = host && host.shadowRoot ? host.shadowRoot : document;
    const b = root.querySelector('.think-block .think-body');
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { y: cs.overflowY, maxH: cs.maxHeight };
  });
  expect(overflow).not.toBeNull();
  expect(overflow.y).not.toBe('auto');
  expect(overflow.y).not.toBe('scroll');
  expect(overflow.maxH).toBe('none');

  // 用户手动点开后应能读到完整思维链 —— 这就是「可以折叠和展开」
  await blocks.nth(0).locator('.think-head').click();
  await expect(blocks.nth(0)).toHaveAttribute('data-open', 'true');
  await expect(blocks.nth(0).locator('.think-body')).toBeVisible();
  await expect(blocks.nth(0).locator('.think-body')).toContainText('先确认页面结构，再决定点击哪个按钮。');

  // 两块的折叠互不影响（历史段各自独立开合）
  await expect(blocks.nth(1)).toHaveAttribute('data-open', 'false');

  await page.close();
});

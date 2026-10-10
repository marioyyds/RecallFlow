// E2E 可复用工具。
//
// **收进来的标准**：两个以上 spec 里原样重复的惯用法，或"写错过一次就会静默失准"的
// 浏览器细节。只写一次的东西留在 spec 里更好读 —— 这个文件不是 spec 的语法糖。
//
// 见 ./README.md（本目录的经验与坑）与 ../../docs/e2e-testing-guide.md（完整指南）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startServers, stopServers } from './fixtures/server.mjs';
import { PLAYBOOKS } from './fixtures/playbooks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 仓库根（`--load-extension` 要指向它）。仅本文件内部使用，不导出。
const EXT_PATH = path.resolve(__dirname, '..', '..');

// 上传夹具的**绝对路径**：`upload_file` 需要真实的本地路径（CDP 的 DOM.setFileInputFiles），
// 而剧本指令是静态字符串 —— 见下面 resolveInstruction 的说明。
const SAMPLE_UPLOAD = fileURLToPath(new URL('./fixtures/sample-upload.txt', import.meta.url));

/**
 * 解析剧本指令里的**运行时占位符**，返回可以直接发给面板的指令文本。
 *
 * 为什么需要它：剧本的指令是静态字符串，但有些场景需要**只有运行时才知道的值** ——
 * 最典型的是上传文件的**本地绝对路径**（每台机器不同，且不该写进仓库）。
 * 若让 E2E 与真模型 eval 各自拼接，就会出现"两边跑的不是同一条指令"，
 * 而"脚本下能过、真模型下不能过"就无法归因。
 *
 * 所以：**占位符留在剧本里（单一来源）**，两边都经这里解析。
 * 没有占位符的指令原样返回，因此所有场景都可以统一走这个入口。
 */
export function resolveInstruction(id) {
  const pb = PLAYBOOKS[id];
  if (!pb || !pb.eval || !pb.eval.instruction) throw new Error('未找到剧本指令：' + id);
  return String(pb.eval.instruction).replace(/\{\{UPLOAD_FILE\}\}/g, SAMPLE_UPLOAD);
}

const MAIN_URL = 'http://127.0.0.1:7802';
const LLM_PORT = 7804;

/** 面板宿主。面板整个在 **shadow DOM** 里 —— 这决定了本文件里所有查询怎么写。 */
export const PANEL = '#__kb-ai-host';

/**
 * 起夹具服务 + 启动装了扩展的真实 Chromium。
 *
 * ⚠ `headless: false` 是**技术约束不是偏好**：实测 headless 下 MV3 扩展的
 * service worker 根本不注册（`context.serviceWorkers()` 为空），扩展起不来。
 * CI 上要虚拟显示（`xvfb-run`），不是把这个改成 true。
 */
export async function launchExtension() {
  await startServers();
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run'],
  });
  // 必须等 service worker 起来再继续：不等的话后续配置写入会打到一个还没注册的后台。
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return context;
}

export async function closeExtension(context) {
  await context?.close();
  stopServers();
}

/** E2E 用的设置基线。`baseUrl` 指向夹具的模拟 LLM，并**关闭 CDP**（个别用例再打开）。 */
export function baseSettings(overrides) {
  return Object.assign(
    {
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:' + LLM_PORT,
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

/** 写入扩展设置（直接改后台的 chrome.storage.local）。 */
export async function configureSettings(context, overrides) {
  const sw = context.serviceWorkers()[0];
  await sw.evaluate(async (s) => {
    await chrome.storage.local.set({ aiSettings: s });
  }, baseSettings(overrides));
}

/** 打开夹具页面（默认主站；传 '/coord' 用坐标页）。 */
export async function openFixturePage(context, urlPath) {
  const page = await context.newPage();
  await page.goto(MAIN_URL + (urlPath || '/'));
  return page;
}

/** 展开助手面板。 */
export async function openPanel(page) {
  await page.locator(PANEL + ' .fab').click();
}

/**
 * 下一条指令：展开面板 → 填输入框 → 发送。
 *
 * 传进来的文本同时决定夹具返回哪套脚本（模拟 LLM 按 userText 分派场景），
 * 所以它是"选择剧本"，不只是"输入一句话"。
 */
export async function sendInstruction(page, text) {
  await openPanel(page);
  await page.locator(PANEL + ' .cmd-input').fill(text);
  await page.locator(PANEL + ' .cmd-send').click();
}

/** 等审批条出现并点掉。kind: 'approve' | 'reject'。 */
export async function clickApproval(page, kind) {
  const btn = page.locator(PANEL + (kind === 'reject' ? ' .tool-reject' : ' .tool-approve'));
  await btn.waitFor({ state: 'visible', timeout: 30_000 });
  await btn.click();
}

/**
 * 用**不穿透 shadow DOM 的原生查询**看能不能找到目标。
 *
 * 为什么需要它：本目录有一条硬规则 —— spec 里不得写原生 DOM 查询
 * （面板在 shadow root 里，写错了会静默返回 null）。但 shadow 类场景恰恰要**证明
 * "朴素查询找不到"** —— 那正是这一类的难点所在。把这条收进 helper，
 * 既保住规则，又让"难点确实存在"变成可断言的事实。
 *
 * 用法上的对比才有意义：本 helper 返回 false（朴素查不到）**同时**
 * `page.locator('#q')` 能命中（Playwright 的 CSS 选择器默认穿透 shadow DOM）——
 * 两句合起来才证明"元素在 shadow 里，且确实存在"。
 *
 * @returns {Promise<boolean>} true=朴素查询能找到（说明不在 shadow 里）
 */
export async function lightDomHas(page, selector) {
  return await page.evaluate((sel) => document.querySelector(sel) !== null, selector);
}

/**
 * 页面上某个元素是否**被别的东西盖住**（遮挡类场景专用）。
 *
 * 为什么必须走 helper，而不是在 spec 里写 document.querySelector：
 * 本目录有一条硬规则 —— **spec 里不得出现 `document.querySelector`**
 * （面板在 shadow DOM 里，原生查询穿透不了，写错了会静默返回 null）。
 * 为了保住这条简单规则，所有页面侧的原生查询都收进这里。
 *
 * 判据：取元素中心点上的最上层节点，既不是它自己、也不是它的子节点 → 被遮挡。
 * 用中心点而不是左上角，是因为元素左上角常有自己的边框/内边距，
 * 而遮挡物往往从边缘开始覆盖，取中心更能反映"用户点得到吗"。
 * 元素不存在时返回 null（与"没被遮挡"区分开）。
 */
export async function isCovered(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 6);
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return !(top === el || el.contains(top));
  }, selector);
}

// ---------------------------------------------------------------- 穿透 shadow DOM 的查询
//
// ⚠ 这是本目录最容易踩的一个坑：
//   · Playwright 的 **locator** 会穿透 shadow root（`page.locator(PANEL + ' .x')` 可以）；
//   · 但 `page.evaluate` 里用的是**原生 DOM API**，`document.querySelector` **不会**穿透。
// 于是「面板里明明有那个元素」而 evaluate 查不到 —— 返回值是 null / 空数组，
// 看起来像"功能没实现"，其实是**查错了树**（实测踩过一次：断言收到空数组）。
// 下面三个函数把"先拿 host.shadowRoot"这件事收在一处，spec 里不要再各写一遍。

/** 读面板内某元素的 textContent（穿透 shadow DOM）。 */
export function panelText(page, selector) {
  return page.evaluate(
    ({ hostSel, sel }) => {
      const host = document.querySelector(hostSel);
      const root = host && host.shadowRoot ? host.shadowRoot : document;
      const el = root.querySelector(sel);
      return el ? el.textContent : null;
    },
    { hostSel: PANEL, sel: selector }
  );
}

/**
 * `agent-flow` 直接子元素的类型序列，用来断言**版式顺序**。
 *
 * 返回 'think' | 'content' | 'other' 的数组（过滤掉 other）。
 * 它存在的理由：思考记录这类"穿插在对话里"的要求，本质是**顺序**性质 ——
 * 只断言"有几块"会漏掉"全都堆在最上面"这种错法（实测漏过一次）。
 */
export function flowOrder(page) {
  return page.evaluate((hostSel) => {
    const host = document.querySelector(hostSel);
    const root = host && host.shadowRoot ? host.shadowRoot : document;
    const flow = root.querySelector('.agent-flow');
    if (!flow) return [];
    return [...flow.children]
      .map((el) =>
        el.classList.contains('think-block') ? 'think' : el.classList.contains('agent-content') ? 'content' : 'other'
      )
      .filter((k) => k !== 'other');
  }, PANEL);
}

/**
 * 读面板内某元素的**计算样式**（穿透 shadow DOM）。
 *
 * 为什么要它：像"思考记录不得有内层滚动条"这种约束，CSS 里写错 `max-height`
 * 不会报错、单测也看不到 —— 只有真浏览器算出来的 computed style 能证伪。
 *
 * @param {string[]} props 要读的属性名（驼峰，如 'maxHeight'）
 */
export function panelStyle(page, selector, props) {
  return page.evaluate(
    ({ hostSel, sel, keys }) => {
      const host = document.querySelector(hostSel);
      const root = host && host.shadowRoot ? host.shadowRoot : document;
      const el = root.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const out = {};
      for (const k of keys) out[k] = cs[k];
      return out;
    },
    { hostSel: PANEL, sel: selector, keys: props }
  );
}

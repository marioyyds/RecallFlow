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

/**
 * 读扩展侧的 **AI 设置**（`aiSettings`）。
 *
 * 为什么需要：审批类设置的权威事实在**扩展存储**里 —— 面板上的开关会写存储，
 * 而运行中的 Agent 该不该弹确认，取决于**它决策那一刻**读到的值。
 * 于是"用户在运行中途打开了自动批准"这件事，只能靠直接读存储来确认**开关真的落盘了**，
 * 否则测试无法区分两种失败：「开关没保存」与「保存了但本轮没生效」。
 *
 * ⚠ 读的是 service worker 的上下文，不是页面 —— 页面里没有 `chrome.storage`。
 */
export async function readAiSettings(context) {
  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('拿不到扩展的 service worker（扩展没起来？）');
  return await sw.evaluate(async () => {
    const d = await chrome.storage.local.get('aiSettings');
    return (d && d.aiSettings) || {};
  });
}

/**
 * 读全浏览器共享的面板会话仓库。
 * 返回的 `session` 永远取**当前 active 会话**的完整正文，供跨 tab / 跳转用例断言。
 */
export async function readActivePanelSession(context) {
  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('拿不到扩展的 service worker（扩展没起来？）');
  return await sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    const index = all['recallflow.psess.index.v1'] || { sessions: {}, seq: 0 };
    const active = all['recallflow.psess.active.v1'] || { id: '' };
    const key = 'recallflow.psess.v1.' + String(active.id || '');
    return {
      index,
      active,
      session: all[key] || null,
      summaries: Object.values(index.sessions || {}),
    };
  });
}

/**
 * 读扩展侧的**知识库存储**（`knowledgeBase`）。
 *
 * 为什么必须有这个 helper：知识库场景的权威事实在**存储**里，不在页面上 ——
 * `add_entry` 传了 url 就用 url 当 id（同一 URL 视为同一条），
 * 所以"分三条存、都带同一个网址"会**静默只剩最后一条**，每一步还都返回 ok。
 * 只有直接读存储才能证明"三条都在"。
 *
 * ⚠ 读的是 service worker 的上下文，不是页面 —— 页面里没有 `chrome.storage`。
 */
export async function readKnowledgeBase(context) {
  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('拿不到扩展的 service worker（扩展没起来？）');
  return await sw.evaluate(async () => {
    const d = await chrome.storage.local.get('knowledgeBase');
    return (d && d.knowledgeBase) || {};
  });
}

/**
 * 清空扩展侧的知识库存储。
 *
 * ⚠ **知识库测试必须先用它**：`chrome.storage.local` 在同一个浏览器上下文里
 * **跨用例共享**，所以"基线应该是空的"这种断言会变成**顺序相关**的 ——
 * 单独跑通过、跟别的知识库用例一起跑就失败。实测踩过一次：
 * 新用例单跑 2.9 秒通过，全量跑 121 毫秒就挂在基线断言上。
 * 用这个 helper 把前提重置掉，用例之间才是真正独立的。
 */
export async function resetKnowledgeBase(context) {
  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('拿不到扩展的 service worker（扩展没起来？）');
  await sw.evaluate(async () => {
    await chrome.storage.local.remove('knowledgeBase');
  });
}

/**
 * 等一个 URL 含某片段的**新标签页**出现，并返回它。
 *
 * 为什么收进来：多标签页场景里"新页什么时候开出来"是**竞态** ——
 * 点击之后立刻 `context.pages()` 往往还看不到它，于是断言跑在一个不存在的页上。
 * 而 `page.waitForEvent('popup')` 也不稳（由扩展经 chrome.tabs 打开的页不一定是 popup）。
 * 稳妥做法是**轮询 context.pages()**。
 */
export async function waitForPage(context, urlPart, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = context.pages().find((p) => p.url().includes(urlPart) && !p.isClosed());
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    '等不到 URL 含「' + urlPart + '」的标签页；当前已打开：' +
      context.pages().map((p) => p.url()).join(' | ')
  );
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
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      // ⚠ 关于自动播放策略：**这条开关在本 harness 里其实不起作用**，留着只是为了让意图明确
      //   （诚实记录，别把它当成"已经拦住自动播放"）。
      //   实测（`/video` 夹具那条用例就是为它建的）：
      //     · Playwright 自己会给 Chromium 传 `--no-user-gesture-required`，且它自身持有用户激活；
      //     · 因此 `--autoplay-policy=user-gesture-required` /
      //       `document-user-activation-required` **都被无视** —— `video.play()` 一律 resolve
      //       （`window.__probePaused === false`），页面里"自动播放被拦"这个陷阱**造不出来**。
      //   ⇒ 新场景 `video-playback-verify` **不把"自动播放被拦"算作难点**（也绝不拿它冒充难点），
      //     它的"看起来在播"来自页面那条**永不刷新**的状态栏；用例里有一条断言把这个环境事实钉住
      //     （一旦哪天 Playwright 不再送用户激活，那条断言会红，提醒重新评估难点说明）。
      //   本仓库其它夹具页都没有 autoplay，因此这条 flag 只可能影响 /video。
      '--autoplay-policy=user-gesture-required',
    ],
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

/**
 * **按 agent 的口径读一次页面文本**，并补上"被读了"的信号。
 *
 * 为什么要这个 helper：`inspect_element({op:"text"})` 在内容脚本里做两件事 ——
 *   ① 取节点文本；② 在**被读的元素上**派发 `recallflow:element-read`
 *      （见 `lib/page/commands.js` 的 notifyElementsRead）。
 * 而 `innerText` / `textContent` **不产生任何 DOM 变更**，页面无法用 MutationObserver
 * 察觉"被读了" —— 所以夹具里那些"从第一次读才开始走"的时序（如 `/pick` 的重新询价）
 * 必须由这条信号驱动。用例里若用裸 `textContent` 去读，就等于**漏掉了真实读路径的一半**。
 *
 * 返回读到的文本（与 ① 一致：先取值，再派发）。
 */
export async function readTextAsAgent(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const text = (el.innerText || el.textContent || '').trim();
    el.dispatchEvent(new CustomEvent('recallflow:element-read', { bubbles: false, detail: { op: 'text' } }));
    return text;
  }, selector);
}

/** 展开助手面板。 */
export async function openPanel(page) {
  await page.locator(PANEL + ' .fab').click();
}

/**
 * 每个独立用例建一个新的面板会话。
 *
 * 会话现在按**整个浏览器**共享，不再按标签页隔离；如果测试不主动新建，
 * 上一条用例的思考/工具记录会留在 active 会话里，顺序一变结果就变。
 * 这里是测试隔离，不是产品清空：旧会话仍保留在历史列表中。
 */
export async function createFreshPanelSession(context) {
  const before = await readActivePanelSession(context);
  const oldId = before && before.active ? String(before.active.id || '') : '';
  const page = await openFixturePage(context);
  await openPanel(page);
  await page.locator(PANEL + ' .new-session-btn').click();
  let createdId = '';
  for (let i = 0; i < 100; i++) {
    const state = await readActivePanelSession(context);
    createdId = state && state.active ? String(state.active.id || '') : '';
    if (createdId && createdId !== oldId) break;
    await page.waitForTimeout(50);
  }
  if (!createdId || createdId === oldId) {
    await page.close();
    throw new Error('创建测试会话失败（active 会话没有变化）');
  }
  await page.close();
  return createdId;
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
 * 在后台**反复**点掉审批条，直到调用返回的 stop()。返回 `stop`。
 *
 * 为什么需要它（实测踩到）：`run_javascript` 这类 `alwaysRequireApproval` 的工具
 * **在脚本化剧本里同样会弹审批**。用例若不点，整个 run 会**卡在审批上** ——
 * 现象是工具结果里只有第一条快照、后面什么都没有，看起来像"脚本没生效/工具没执行"，
 * 其实是没人批准（本会话在 CSP 用例上就是这样卡了 40 秒才看懂）。
 *
 * 与 `clickApproval` 的分工：那个是"等一次审批出现再点"（用于审批相关用例本身），
 * 这个是"整段跑期间持续兜住审批"（用于只关心页面状态、不关心审批的用例）。
 */
export function autoApprove(page) {
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const btn = page.locator(PANEL + ' .tool-approve');
        if ((await btn.count()) > 0 && (await btn.first().isVisible())) {
          await btn.first().click({ timeout: 2000 });
          // 点完等它消失再继续，避免把同一次审批重复计数（同 eval 那边的处理）
          await btn.first().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
        }
      } catch (e) {
        /* 按钮消失/被替换都是正常竞态 */
      }
      await page.waitForTimeout(250);
    }
  })();
  return async () => {
    running = false;
    await loop.catch(() => {});
  };
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
 * 读第 `index` 块思考记录的折叠状态**三元组**：`状态/是否展开/折叠条文字`
 *（例：`running/false/思考中…`、`done/false/已思考（18 字）`）。
 *
 * 为什么要**一次**读三样、而不是三条 Playwright 重试断言：思考记录默认折叠，
 * 而"进行中也是折叠的"这条只能在 `data-state="running"` 的窗口里观察 ——
 * 拆成多条断言时，第一条一旦通过，后面的会一路重试到**窗口关闭之后**才满足，
 * 于是"进行中把块展开了"这种缺陷被静默漏过（实测：注入该缺陷后，红灯落到了
 * 后面一条与折叠无关的标签断言上）。三元组一次 evaluate 读出来，就没有这个缝隙。
 *
 * 顺带满足 shadow DOM 约束：`host.shadowRoot` 这一步收在这里，spec 不碰原生查询。
 */
export function thinkState(page, index = 0) {
  return page.evaluate(
    ({ hostSel, i }) => {
      const host = document.querySelector(hostSel);
      const root = host && host.shadowRoot ? host.shadowRoot : document;
      const b = root.querySelectorAll('.think-block')[i];
      if (!b) return 'no-block';
      const label = b.querySelector('.think-label');
      return b.dataset.state + '/' + b.dataset.open + '/' + (label ? label.textContent : '');
    },
    { hostSel: PANEL, i: index }
  );
}

/**
 * 流式**中途**重开面板后的一次性观测：思考块数量 / 进度条是否在跑 / 停止按钮是否可见。
 *
 * 为什么要一次读完、并且按"任务是否仍在跑"给出**条件式**结论：
 * 重开之后任务是否还在跑，取决于夹具那 4 秒"思考进行中"窗口是否已经过去 ——
 * 拆成三条断言就会变成"看时机"的假绿/假红。而两个真实缺陷都能被这个三元结论抓住：
 *   · thinking-missing：思考块没回来（mountThinkSegment 往孤儿 flowEl 追加那个顺序 bug）
 *   · stop-missing：任务还在跑，但「■ 停止」不可见（重开后按钮初值是 display:none）
 *   · ok：思考在，且（在跑 ⇒ 停止可见）/（已结束 ⇒ 不要求）
 * 同 thinkState：`host.shadowRoot` 这一步收在这里，spec 不碰原生查询。
 */
export function streamRestoreSnapshot(page) {
  return page.evaluate((hostSel) => {
    const host = document.querySelector(hostSel);
    const root = host && host.shadowRoot ? host.shadowRoot : document;
    const visible = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
    };
    return {
      blocks: root.querySelectorAll('.think-block').length,
      progressOn: visible(root.querySelector('.p-progress')),
      stopVisible: visible(root.querySelector('.stop-btn')),
    };
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

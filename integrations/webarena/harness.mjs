// WebArena 评测的浏览器侧原语：起真 Chromium、装扩展、隔离存储、抓 HAR。
//
// 与 tests/e2e/helpers.mjs 的分工：那个是**夹具 E2E** 用的（连本机 7802 夹具站、模拟 LLM）；
// 这里连的是 WebArena 的真站点、真模型，并且**每条任务一个全新 profile** ——
// RecallFlow 的记忆（知识库 / 站点记忆 / 技能 / 会话）都落 chrome.storage，
// 不隔离就会跨任务污染，分数不可复现。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TRACE_GRAPH_KEY } from '../../lib/application/agent/tracegraph-store.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根 —— `--load-extension` 要指向它。 */
export const EXT_PATH = path.resolve(__dirname, '..', '..');

/**
 * 启动一个装了扩展的持久化上下文。
 *
 * ⚠ `headless: false` 是**技术约束不是偏好**：实测 headless 下 MV3 扩展的 service worker
 * 不注册（`context.serviceWorkers()` 为空），扩展起不来。无头环境用 xvfb-run。
 */
export async function launchBrowser({ userDataDir = '', harPath = '', extPath = EXT_PATH, extraHTTPHeaders = null, storageState = null } = {}) {
  const { chromium } = await import('@playwright/test');
  const options = {
    headless: false,
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run',
    ],
  };
  // WebArena-Verified 的站点用「请求头自动登录」代替 UI 登录（shopping_admin 的
  // `X-M2-Admin-Auto-Login: admin:admin1234` 等）。这类头必须挂在整个 context 上，
  // 只给某个 page 设会让子请求/重定向丢头，登录态就断了。
  if (extraHTTPHeaders && Object.keys(extraHTTPHeaders).length) options.extraHTTPHeaders = extraHTTPHeaders;
  if (harPath) options.recordHar = { path: harPath, content: 'embed' };
  const context = await chromium.launchPersistentContext(userDataDir, options);
  // 公开数据集不再带原版 storage_state；用登录一次后保存的 Playwright state 复用 cookie。
  // 注意 launchPersistentContext 的 storageState 选项实测不生效，必须手动 addCookies。
  const stateFiles = Array.isArray(storageState) ? storageState : storageState ? [storageState] : [];
  for (const file of stateFiles) {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(state.cookies) && state.cookies.length) await context.addCookies(state.cookies);
    } catch (e) {
      console.warn('[auth] 读取登录状态失败（继续）：' + file + ' ' + String((e && e.message) || e));
    }
  }
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return context;
}

/**
 * 配置扩展并**先清空存储**（隔离的前提）。
 *
 * 清理策略：`storage.local.clear()` 之后再写 `aiSettings`。这样每条任务开始时
 * 知识库 / 站点记忆 / 技能 / 会话都是空的 —— 否则上一条任务存下的东西会让下一条的
 * 结果既不可复现、也无法归因。
 */
export async function configureExtension(
  context,
  settings,
  { preserveTraceGraph = false, seedTraceGraph = null } = {}
) {
  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('拿不到扩展的 service worker（扩展没起来？）');
  await sw.evaluate(async ({ s, traceGraphKey, keepTraceGraph, seedGraph }) => {
    let graph = null;
    if (keepTraceGraph) {
      const existing = await chrome.storage.local.get(traceGraphKey);
      graph = existing && existing[traceGraphKey] ? existing[traceGraphKey] : null;
    }
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ aiSettings: s });
    if (seedGraph) graph = seedGraph;
    if (graph) await chrome.storage.local.set({ [traceGraphKey]: graph });
  }, {
    s: settings,
    traceGraphKey: TRACE_GRAPH_KEY,
    keepTraceGraph: preserveTraceGraph,
    seedGraph: seedTraceGraph,
  });
}

async function loginShopping(page, baseUrl, credentials) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(new URL('/customer/account/login/', baseUrl).toString(), {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      if (!/customer\/account\/login/.test(page.url())) return true;
      if (!credentials || !credentials.email) return false;
      await page.fill('#email', credentials.email);
      await page.fill('#pass', credentials.password);
      await page.click('button.action.login');
      await page
        .waitForURL((u) => !/\/customer\/account\/login/.test(u.pathname), { timeout: 20000 })
        .catch(() => {});
      if (!/customer\/account\/login/.test(page.url())) return true;
    } catch {}
    await page.waitForTimeout(1500 * attempt);
  }
  return false;
}

async function loginReddit(page, baseUrl, credentials) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(new URL('/login', baseUrl).toString(), {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      if (!/\/login/.test(new URL(page.url()).pathname)) return true;
      if (!credentials || !credentials.username) return false;
      await page.fill('#login-username', credentials.username);
      await page.fill('#login-password', credentials.password);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 15000 }).catch(() => {});
      if (!/\/login/.test(new URL(page.url()).pathname)) return true;
    } catch {}
    await page.waitForTimeout(1500 * attempt);
  }
  return false;
}

async function loginShoppingAdmin(page, baseUrl, credentials) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (!/\/admin\//.test(new URL(page.url()).pathname)) return true;
      if (!credentials || !credentials.username) return false;
      await page.getByPlaceholder('user name').fill(credentials.username);
      await page.getByPlaceholder('password').fill(credentials.password);
      await page.getByRole('button', { name: /sign in/i }).click();
      await page
        .waitForURL((u) => u.pathname !== '/admin' && u.pathname !== '/admin/', { timeout: 30000 })
        .catch(() => {});
      const path = new URL(page.url()).pathname;
      if (path !== '/admin' && path !== '/admin/') return true;
    } catch {}
    await page.waitForTimeout(1500 * attempt);
  }
  return false;
}

/**
 * 任务开始前的站点登录（shopping / reddit）。
 *
 * 为什么必须有：WebArena-Verified 的公开数据集去掉了原版的 `storage_state`，
 * 但大量任务是 "my orders / my account" 这类**必须登录**的（原版用 `.auth/*.json` 预置）。
 * 不登录时 agent 只会如实返回 PERMISSION_DENIED —— 那不是它的失败，是 harness 缺一步。
 *
 * 登录使用同一个 persistent context，所以 cookie 对扩展开的 tab 同样有效。
 * 失败只告警、不中断：游客可做的任务仍然能跑。
 */
export async function prepareSiteLogin(
  context,
  sites,
  logins = {},
  siteUrls = {},
  { requireLogin = false } = {}
) {
  const list = Array.isArray(sites) ? sites : [];
  const needsShopping = list.includes('shopping');
  const needsShoppingAdmin = list.includes('shopping_admin');
  const needsReddit = list.includes('reddit');
  const needsGitlab = list.includes('gitlab');
  if (!needsShopping && !needsShoppingAdmin && !needsReddit && !needsGitlab) {
    return { ok: true, failures: [] };
  }
  const page = await context.newPage();
  const failures = [];
  try {
    if (needsShopping) {
      const baseUrl = (logins.shopping && logins.shopping.baseUrl) || siteUrls.SHOPPING || 'http://localhost:7770';
      if (!(await loginShopping(page, baseUrl, logins.shopping))) {
        failures.push('shopping');
        console.warn('[login] shopping 登录失败');
      }
    }
    if (needsReddit) {
      const baseUrl = (logins.reddit && logins.reddit.baseUrl) || siteUrls.REDDIT || 'http://localhost:9999';
      if (!(await loginReddit(page, baseUrl, logins.reddit))) {
        failures.push('reddit');
        console.warn('[login] reddit 登录失败');
      }
    }
    if (needsShoppingAdmin) {
      const baseUrl = (logins.shopping_admin && logins.shopping_admin.baseUrl) || siteUrls.SHOPPING_ADMIN || 'http://localhost:7780/admin';
      if (!(await loginShoppingAdmin(page, baseUrl, logins.shopping_admin))) {
        failures.push('shopping_admin');
        console.warn('[login] shopping_admin 登录失败');
      }
    }
    if (needsGitlab) {
      const baseUrl = (logins.gitlab && logins.gitlab.baseUrl) || siteUrls.GITLAB || 'http://localhost:8023';
      await page.goto(new URL('/users/sign_in', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (!/\/users\/sign_in/.test(page.url())) {
        // Already authenticated through the profile.
      } else if (logins.gitlab && logins.gitlab.username) {
        await page.fill('#user_login', logins.gitlab.username);
        await page.fill('#user_password', logins.gitlab.password);
        await page.getByRole('button', { name: /sign in/i }).click();
        await page.waitForURL((u) => !/\/users\/sign_in/.test(u.pathname), { timeout: 30000 }).catch(() => {});
        if (/\/users\/sign_in/.test(new URL(page.url()).pathname)) {
          failures.push('gitlab');
          console.warn('[login] gitlab 登录失败（继续；需要登录的任务会返回 PERMISSION_DENIED）');
        }
      } else {
        failures.push('gitlab');
        console.warn('[login] gitlab 会话已失效且没有可用凭据（继续）');
      }
    }
  } catch (e) {
    console.warn('[login] 站点登录异常（继续）：' + String((e && e.message) || e));
  } finally {
    await page.close().catch(() => {});
  }
  if (requireLogin && failures.length) {
    throw new Error('必需站点登录失败：' + [...new Set(failures)].join(', '));
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

/** 构造扩展设置：真模型 + 开 CDP + 关逐次审批干扰（桥接侧仍按 allowRisk 逐次判定）。 */
export function webarenaSettings({ apiKey, baseUrl, model, bridgeToken, bridgePort, agentBudget, jev, traceGraph, extra } = {}) {
  const settings = {
      apiKey: String(apiKey || ''),
      baseUrl: baseUrl || 'https://api.deepseek.com',
      model: model || 'deepseek-chat',
      ragEnabled: false,
      pageContext: true,
      cdpEnabled: true,
      siteMemoryEnabled: false,
      verifierEnabled: false,
      // 评测要求最终答复带 JSON 终态块；缺失时让 agent 只做一次格式补正（不重做任务）。
      requireFinalJsonBlock: true,
      parallelToolCalls: true,
      toolApproval: true,
      toolApprovalPolicy: { read: true, edit: true, commands: true, browser: true, mcp: true },
      bridgeToken: bridgeToken || 'recallflow-local-bridge-v1',
      bridgePort: Number.isInteger(Number(bridgePort)) ? Number(bridgePort) : 7801,
      agentBudget: agentBudget || {},
  };
  let jevOverride = jev;
  if (typeof jevOverride === 'string' && jevOverride.trim()) {
    try {
      jevOverride = JSON.parse(jevOverride);
    } catch (error) {
      throw new Error('RECALLFLOW_EVAL_JEV_SETTINGS 不是合法 JSON');
    }
  }
  if (jevOverride && typeof jevOverride === 'object' && !Array.isArray(jevOverride)) {
    settings.jev = Object.assign({}, jevOverride);
  }
  let traceGraphOverride = traceGraph;
  if (typeof traceGraphOverride === 'string' && traceGraphOverride.trim()) {
    try {
      traceGraphOverride = JSON.parse(traceGraphOverride);
    } catch (error) {
      throw new Error('RECALLFLOW_EVAL_TRACEGRAPH_SETTINGS 不是合法 JSON');
    }
  }
  if (
    traceGraphOverride &&
    typeof traceGraphOverride === 'object' &&
    !Array.isArray(traceGraphOverride)
  ) {
    settings.traceGraph = Object.assign({}, traceGraphOverride);
  }
  return Object.assign(settings, extra || {});
}

export async function closeBrowser(context) {
  if (context) await context.close();
}

/**
 * 让 Playwright 接管「扩展自己开的那个 tab」并重新导航到 startUrl。
 *
 * 为什么必须这么做（实测）：`browser.newContext({ extraHTTPHeaders })` 只对 **Playwright 创建的**
 * 页面生效；扩展用 `chrome.tabs.create` 开的 tab 不带这些头。WebArena 的站点靠请求头自动登录
 * （如 shopping_admin 的 `X-M2-Admin-Auto-Login`），于是扩展开的 tab 会停在登录页 —— 现象是
 * "agent 说它看到了登录框"，而不是报错。Playwright 导航过一次之后，这个 target 就被接管，
 * 后续（agent 的点击/请求）才带上头。
 *
 * 找不到对应页面时返回 false（例如站点改了 origin），由调用方决定是否告警。
 */
export async function navigateTabWithHeaders(context, url) {
  let origin;
  try { origin = new URL(url).origin; } catch (e) { return false; }
  const page = context.pages().slice().reverse().find((p) => p.url().startsWith(origin));
  if (!page) return false;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    // 站点自己 302 到目标页时 goto 可能抛；只要最终停在同 origin 就算接管成功。
    if (!page.url().startsWith(origin)) return false;
  }
  return true;
}

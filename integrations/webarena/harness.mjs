// WebArena 评测的浏览器侧原语：起真 Chromium、装扩展、隔离存储、抓 HAR。
//
// 与 tests/e2e/helpers.mjs 的分工：那个是**夹具 E2E** 用的（连本机 7802 夹具站、模拟 LLM）；
// 这里连的是 WebArena 的真站点、真模型，并且**每条任务一个全新 profile** ——
// RecallFlow 的记忆（知识库 / 站点记忆 / 技能 / 会话）都落 chrome.storage，
// 不隔离就会跨任务污染，分数不可复现。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根 —— `--load-extension` 要指向它。 */
export const EXT_PATH = path.resolve(__dirname, '..', '..');

/**
 * 启动一个装了扩展的持久化上下文。
 *
 * ⚠ `headless: false` 是**技术约束不是偏好**：实测 headless 下 MV3 扩展的 service worker
 * 不注册（`context.serviceWorkers()` 为空），扩展起不来。无头环境用 xvfb-run。
 */
export async function launchBrowser({ userDataDir = '', harPath = '', extPath = EXT_PATH, extraHTTPHeaders = null } = {}) {
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
export async function configureExtension(context, settings) {
  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('拿不到扩展的 service worker（扩展没起来？）');
  await sw.evaluate(async (s) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ aiSettings: s });
  }, settings);
}

/** 构造扩展设置：真模型 + 开 CDP + 关逐次审批干扰（桥接侧仍按 allowRisk 逐次判定）。 */
export function webarenaSettings({ apiKey, baseUrl, model, bridgeToken, agentBudget, extra } = {}) {
  return Object.assign(
    {
      apiKey: String(apiKey || ''),
      baseUrl: baseUrl || 'https://api.deepseek.com',
      model: model || 'deepseek-chat',
      ragEnabled: false,
      pageContext: true,
      cdpEnabled: true,
      siteMemoryEnabled: false,
      verifierEnabled: false,
      parallelToolCalls: true,
      toolApproval: true,
      toolApprovalPolicy: { read: true, edit: true, commands: true, browser: true, mcp: true },
      bridgeToken: bridgeToken || 'recallflow-local-bridge-v1',
      agentBudget: agentBudget || {},
    },
    extra || {}
  );
}

export async function closeBrowser(context) {
  if (context) await context.close();
}

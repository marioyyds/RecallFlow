// 真实站点实验室入口（T1）：真 Chromium + 加载扩展 + 脚本化模型，页面是真实站点。
//
// 为什么需要独立入口（而不是直接 npx playwright test）：
//   · 真实站点**不稳定**，必须用 E2E_LIVE=1 显式打开，默认跳过 —— 混进常规 E2E 会把它拖红；
//   · 前置条件（Playwright / Chromium / 显示）与 run-e2e.mjs 相同，这里照抄同一套检查，
//     避免失败时只看到一句超时、分不清是环境还是脚本。
//
// 用法：E2E_LIVE=1 node scripts/run-e2e-live.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!/^(1|true|yes)$/i.test(String(process.env.E2E_LIVE || ''))) {
  console.error('这一层**默认不跑**（真实站点随时会改版、断言会碎）。\n请这样运行：\n  E2E_LIVE=1 node scripts/run-e2e-live.mjs');
  process.exit(2);
}

const pwTest = path.join(ROOT, 'node_modules', '@playwright', 'test', 'package.json');
if (!fs.existsSync(pwTest)) {
  console.error('缺少 @playwright/test。请先安装依赖：npm install');
  process.exit(2);
}

const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
const hasChromium = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).some((d) => d.startsWith('chromium-'));
if (!hasChromium) {
  console.error('未找到 Playwright 的 Chromium（' + cacheDir + '）。请先：npx playwright install chromium');
  process.exit(2);
}

if (process.platform === 'linux' && !process.env.DISPLAY) {
  console.error('需要真实显示（headless 下 MV3 扩展的 service worker 不注册）。无头 CI 请用 xvfb-run。');
  process.exit(2);
}

console.log('真实站点实验室启动：' + process.env.E2E_LIVE + '（站点清单见 tests/e2e-live/sites.mjs）');

const r = spawnSync('npx playwright test -c tests/e2e-live/playwright.config.mjs', {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
  env: Object.assign({}, process.env, { E2E_LIVE: '1' }),
});
process.exit(r.status === null ? 1 : r.status);

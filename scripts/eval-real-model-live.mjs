// 真模型 eval 入口（第三层，真实站点版）。
// 与 scripts/eval-real-model.mjs 的区别：跑 tests/e2e-eval/real-model-live.eval.mjs，
// 需要额外的 E2E_EVAL_LIVE=1（真实站点随时会变、失败不追绿，刻意不默认跑）。
//
// 用法：
//   E2E_EVAL_LIVE=1 RECALLFLOW_EVAL_API_KEY=sk-xxx node scripts/eval-real-model-live.mjs
//   （可选）RECALLFLOW_EVAL_MODEL=deepseek-reasoner
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const key = process.env.RECALLFLOW_EVAL_API_KEY || '';
const baseUrl = process.env.RECALLFLOW_EVAL_BASE_URL || 'https://api.deepseek.com';
const model = process.env.RECALLFLOW_EVAL_MODEL || '';

if (!/^(1|true|yes)$/i.test(String(process.env.E2E_EVAL_LIVE || ''))) {
  console.error('这一层默认不跑（真实站点会改版、要花真钱）。\n请这样运行：\n  E2E_EVAL_LIVE=1 RECALLFLOW_EVAL_API_KEY=sk-xxx node scripts/eval-real-model-live.mjs');
  process.exit(2);
}
if (!key) {
  console.error('未提供 API key —— 这一层必须用真实模型。');
  process.exit(2);
}
if (!fs.existsSync(path.join(ROOT, 'node_modules', '@playwright', 'test', 'package.json'))) {
  console.error('缺少 @playwright/test。请先 npm install');
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

console.log('真模型 eval（真实站点）启动：base=' + baseUrl + ' model=' + (model || '(沿用扩展设置里的模型)'));
console.log('⚠ 会真实调用 API（花钱），结果非确定；失败先看打印出来的工具轨迹。\n');

const env = Object.assign({}, process.env, {
  E2E_LLM_REAL: '1',
  E2E_LLM_REAL_KEY: key,
  E2E_LLM_REAL_BASE: baseUrl,
  E2E_LLM_REAL_MODEL: model,
  E2E_EVAL_LIVE: '1',
});

const r = spawnSync('npx playwright test -c tests/e2e-eval/playwright.config.mjs real-model-live.eval.mjs', {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
  env,
});
process.exit(r.status === null ? 1 : r.status);

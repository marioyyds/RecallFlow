// 真模型 eval 入口（第三层）。
//
// 与 scripts/run-e2e.mjs 一样先做前置检查再跑 —— 这一层最容易"看起来在跑、其实一步没执行"：
// 少了 key 或少了显示环境，Playwright 只会给一句超时，让你以为模型不行。
//
// 用法：
//   RECALLFLOW_EVAL_API_KEY=sk-xxx node scripts/eval-real-model.mjs
//   （可选）RECALLFLOW_EVAL_MODEL=deepseek-reasoner
//   （可选）RECALLFLOW_EVAL_BASE_URL=https://api.deepseek.com
//
// ⚠ 这一层**不进 CI**：花真钱、结果非确定。它回答的是"技能文案对真模型有没有用"，
//   而那个问题不适合用红灯/绿灯表达（见 tests/e2e-eval/real-model.eval.mjs 的纪律说明）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const key = process.env.RECALLFLOW_EVAL_API_KEY || '';
const baseUrl = process.env.RECALLFLOW_EVAL_BASE_URL || 'https://api.deepseek.com';
const model = process.env.RECALLFLOW_EVAL_MODEL || '';

// ① key
if (!key) {
  console.error(
    '未提供 API key —— 这一层必须用真实模型，否则它退化成第二层（脚本化 E2E），没有意义。\n' +
      '请这样运行：\n' +
      '  RECALLFLOW_EVAL_API_KEY=sk-xxx node scripts/eval-real-model.mjs\n' +
      '（可选 RECALLFLOW_EVAL_MODEL=deepseek-reasoner 换模型）'
  );
  process.exit(2);
}

// ② Playwright 本体
if (!fs.existsSync(path.join(ROOT, 'node_modules', '@playwright', 'test', 'package.json'))) {
  console.error('缺少 @playwright/test。请先 npm install');
  process.exit(2);
}

// ③ 浏览器二进制
const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
const hasChromium = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).some((d) => d.startsWith('chromium-'));
if (!hasChromium) {
  console.error('未找到 Playwright 的 Chromium（' + cacheDir + '）。请先：npx playwright install chromium');
  process.exit(2);
}

// ④ 显示环境（与常规 E2E 同一个技术约束：headless 下 MV3 的 service worker 不注册）
if (process.platform === 'linux' && !process.env.DISPLAY) {
  console.error('需要真实显示（headless 下 MV3 扩展的 service worker 不注册）。CI/无头请用 xvfb-run。');
  process.exit(2);
}

console.log('真模型 eval 启动：base=' + baseUrl + ' model=' + (model || '(沿用扩展设置里的模型)'));
console.log('⚠ 这一层会真实调用 API（花钱），且结果非确定；失败时先看打印出来的工具轨迹再改文案。\n');

const env = Object.assign({}, process.env, {
  E2E_LLM_REAL: '1',
  E2E_LLM_REAL_KEY: key,
  E2E_LLM_REAL_BASE: baseUrl,
  E2E_LLM_REAL_MODEL: model,
});

const r = spawnSync('npx playwright test -c tests/e2e-eval/playwright.config.mjs', {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
  env,
});
process.exit(r.status === null ? 1 : r.status);

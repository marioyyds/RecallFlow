#!/usr/bin/env node
// WebArena 评测入口：先做前置检查，再交给 integrations/webarena/run.mjs。
//
// 为什么要有这一层（与 scripts/eval-real-model.mjs 同样的理由）：这一层最容易
// "看起来在跑、其实一步没执行" —— 少了 key 或少了显示环境，Playwright 只会给一句超时，
// 让人以为是模型不行。前置检查把每种缺失变成一条带安装命令的明确错误。
//
// 用法：
//   RECALLFLOW_EVAL_API_KEY=sk-xxx node scripts/run-webarena.mjs --tasks <file>
//   node scripts/run-webarena.mjs --tasks integrations/webarena/sample-tasks.json --dry-run
//
// ⚠ 这一层**不进 CI**：要真浏览器 + 真模型 + WebArena docker 站点，花真钱、结果非确定。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('--help') || args.includes('-h');

if (!dryRun && !process.env.RECALLFLOW_EVAL_API_KEY && !process.env.RECALLFLOW_WEBARENA_API_KEY) {
  console.error(
    '未提供 API key —— 这一层必须用真实模型，否则度量无意义。\n' +
      '请这样运行：\n' +
      '  RECALLFLOW_EVAL_API_KEY=sk-xxx node scripts/run-webarena.mjs --tasks <file>\n' +
      '（先看指令对不对，可用 --dry-run，不需要 key 与浏览器）'
  );
  process.exit(2);
}

if (!fs.existsSync(path.join(ROOT, 'node_modules', '@playwright', 'test', 'package.json'))) {
  console.error('缺少 @playwright/test。请先 npm install');
  process.exit(2);
}

const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
const hasChromium = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).some((d) => d.startsWith('chromium-'));
if (!dryRun && !hasChromium) {
  console.error('未找到 Playwright 的 Chromium（' + cacheDir + '）。请先：npx playwright install chromium');
  process.exit(2);
}

if (!dryRun && process.platform === 'linux' && !process.env.DISPLAY) {
  console.error('需要真实显示（headless 下 MV3 扩展的 service worker 不注册）。CI/无头请用 xvfb-run。');
  process.exit(2);
}

const r = spawnSync(
  process.execPath,
  [path.join(ROOT, 'integrations', 'webarena', 'run.mjs'), ...args],
  { cwd: ROOT, stdio: 'inherit', env: process.env }
);
process.exit(r.status === null ? 1 : r.status);

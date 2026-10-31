// 端到端（E2E）测试入口：真实 Chromium + 加载扩展 + 模拟 LLM。
//
// 为什么需要这个脚本而不是直接 `npm run test:e2e`：
//   1. 本机 npm.ps1 常被执行策略拦住，用 node 直接调用最稳；
//   2. E2E 有**前置条件**（Playwright 的 Chromium 已安装），否则会以一句
//      "Executable doesn't exist" 失败 —— 那看起来像测试挂了，实际是环境没装。
//      这里先检查再跑，并直接给出安装命令。
//   3. E2E 需要**真实显示**（headless 下 MV3 service worker 不注册，详见 playwright.config.mjs），
//      所以要给出明确的提示，而不是让人对着超时猜。
//
// 用法：node scripts/run-e2e.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Playwright 浏览器目录的解析规则（纯函数，抽出来是为了能单测）。
 *
 * 起因（L-26）：这里原先写死成 `path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')`，
 * 那是 **Windows** 的路径；Linux / macOS 上 Playwright 的默认目录分别是
 * `~/.cache/ms-playwright` / `~/Library/Caches/ms-playwright`。于是夜间 E2E 在 Linux runner 上
 * 永远卡在"未找到 Chromium"并 exit 2 —— 这个门禁从上线起一次都没真跑过。
 *
 * 规则：`PLAYWRIGHT_BROWSERS_PATH` 优先；否则按平台取默认值；win32 的取值与历史行为完全一致。
 */
export function resolveBrowsersPath({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === 'win32') return path.join(homedir, 'AppData', 'Local', 'ms-playwright');
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Caches', 'ms-playwright');
  return path.join(homedir, '.cache', 'ms-playwright');
}

// 只有作为入口执行时才跑流程；被单测 import 时只导出上面的纯函数。
// 否则一次 import 就会顺带把整套 E2E 跑起来，或在没浏览器 / 没 DISPLAY 的机器上
// 直接 exit 2 把测试进程本身带走。
const IS_ENTRY =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

function runE2E() {
  // ① Playwright 本体
  const pwTest = path.join(ROOT, 'node_modules', '@playwright', 'test', 'package.json');
  if (!fs.existsSync(pwTest)) {
    console.error('缺少 @playwright/test。请先安装依赖：npm install');
    process.exit(2);
  }

  // ② 浏览器二进制
  const cacheDir = resolveBrowsersPath();
  const hasChromium = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).some((d) => d.startsWith('chromium-'));
  if (!hasChromium) {
    console.error(
      '未找到 Playwright 的 Chromium（查找目录：' + cacheDir + '）。\n' +
        '请先安装：npx playwright install chromium'
    );
    process.exit(2);
  }

  // ③ 无显示环境下提前说明（Linux CI 需要 xvfb）
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    console.error(
      'E2E 需要真实显示：headless 模式下 MV3 扩展的 service worker 不会注册。\n' +
        '在无头 CI 上请用虚拟显示，例如：xvfb-run -a node scripts/run-e2e.mjs'
    );
    process.exit(2);
  }

  // 模拟 LLM 的分片节流（毫秒）。默认 0 = 立即返回。
  // 断线恢复那条不靠它来卡时机了（改用夹具的"挂起第一次调用"，确定性更好），
  // 因此这里保持默认 0；需要人为拉长流时可覆盖。
  const chunkDelay = process.env.E2E_LLM_CHUNK_DELAY_MS || '0';

  // 分两阶段跑，因为两者的夹具模式不同（见各自 spec 的说明）：
  //   阶段 1：黄金任务 —— 模拟 LLM 正常返回；
  //   阶段 2：断线恢复 —— 夹具把**第一次** LLM 调用挂起，以便确定地在"流进行中"断开端口。
  // 混在一个进程里，"第一次调用"的归属会取决于执行顺序，测试就时好时坏（实测踩过）。
  const baseEnv = Object.assign({}, process.env, { E2E_LLM_CHUNK_DELAY_MS: chunkDelay });
  // 视觉（多模态）两臂：**都跑**，不是靠某个环境变量二选一 ——
  //   · 不发起截图（`E2E_LLM_VISION_SHOT` 不设）：断言"请求里没有任何图像内容"；
  //   · 发起截图（`=1`，本阶段）：让夹具真的调 `take_screenshot`，断言图像以"追加的 user 消息"出现。
  // ⚠ 第 6 步已把 `VISION_ENABLED` 打开：
  //   · 开启臂（`=1` 那一臂）现在**真的会产出图**，必须绿 —— 这是本轮的关键验收；
  //   · "关闭臂"那条按常量实际值 skip（真实扩展读的就是这个常量）⇒ 关闭侧的传输行为
  //     改由 tests/vision-messages.test.mjs 的 `visionEnabled:false` override 钉住，不是没人管。
  const phases = [
    { name: '黄金任务', spec: 'golden.spec.mjs', hold: '', visionShot: '' },
    // 面板滚动跟随（关掉会话再打开 / 回到标签页时贴底）。
    // 与黄金任务同档：**不需要**挂起流，也不需要截图，用默认夹具即可。
    { name: '滚动跟随', spec: 'scroll-follow.spec.mjs', hold: '', visionShot: '' },
    // 流式输出中用户上滚：必须尊重用户的滚动意图，不能被后续增量拉回底部。
    { name: '流式上滚', spec: 'stream-scroll.spec.mjs', hold: '', visionShot: '' },
    { name: '刷新时序边界', spec: 'reattach-edge.spec.mjs', hold: '', visionShot: '' },
    // 存档自毁闸：实时页面必须看得见悬浮球，而按「另存为」形态重建的副本必须看不见。
    // 不依赖 LLM，用默认夹具即可。
    { name: '存档零痕迹', spec: 'save-clean.spec.mjs', hold: '', visionShot: '' },
    { name: '设置提示', spec: 'settings-ui.spec.mjs', hold: '', visionShot: '' },
    // 面板叠在视频页上时，输入框里的空格不能冒泡成页面的播放/暂停快捷键。
    { name: '面板键盘隔离', spec: 'panel-keyboard-isolation.spec.mjs', hold: '', visionShot: '' },
    { name: '登录拦截提示', spec: 'auth-challenge.spec.mjs', hold: '', visionShot: '' },
    // 面板布局存在扩展级存储：跨 origin 也必须恢复同一位置与尺寸。
    { name: '全局面板布局', spec: 'panel-layout.spec.mjs', hold: '', visionShot: '' },
    // 会话共享/运行锁：需要真实的“生成中”窗口，否则两个标签页的请求会瞬间结束，
    // 根本撞不上同一把锁。这里单独把分片间隔拉长。
    { name: '会话共享', spec: 'sessions.spec.mjs', hold: '', visionShot: '', chunkDelay: '1200' },
    // 关闭整个浏览器上下文再重启，专门验证 IndexedDB 跨会话持久化。
    { name: '持久化', spec: 'persistence.spec.mjs', hold: '', visionShot: '' },
    // 知识库存储迁移：旧 chrome.storage 数据 → IndexedDB，并验证只迁移一次。
    { name: '知识库迁移', spec: 'knowledge-indexeddb.spec.mjs', hold: '', visionShot: '' },
    { name: '断线恢复', spec: 'resume.spec.mjs', hold: '1', visionShot: '' },
    { name: '视觉两臂', spec: 'vision-switch.spec.mjs', hold: '', visionShot: '1' },
  ];

  let failed = 0;
  for (const phase of phases) {
    console.log('\n=== E2E 阶段：' + phase.name + ' ===');
    const r = spawnSync('npx playwright test -c tests/e2e/playwright.config.mjs ' + phase.spec, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
      env: Object.assign({}, baseEnv, {
        E2E_LLM_HOLD_OPEN: phase.hold,
        E2E_LLM_VISION_SHOT: phase.visionShot,
        E2E_LLM_CHUNK_DELAY_MS: phase.chunkDelay || chunkDelay,
      }),
    });
    if ((r.status === null ? 1 : r.status) !== 0) failed += 1;
  }
  if (failed) console.error('\n有 ' + failed + ' 个阶段未通过');
  process.exit(failed ? 1 : 0);
}

if (IS_ENTRY) runE2E();

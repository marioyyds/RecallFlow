// A3：CDP 层**必须自己**超时，而不是无限等下去。
//
// ## 起因（用户会话实测）
//
// B 站那次 `take_screenshot` 与 `list_frames` 各**挂满 15 秒**被 agent 的超时包装砍掉，
// 而同一站的 `run_javascript({engine:'page'})` 正常 —— 说明不是 CDP 整体不可用，
// 是**某些调用永不返回**。
//
// ## 根因（代码层，已确认）
//
// `lib/backend/cdp.js` 里 `sendRaw` 就是 `new Promise(...)` 包一层回调式
// `chrome.debugger.sendCommand`，**没有任何超时**：
// Chrome 在某些情况下**永不调用回调**（实测重命令如 `Page.captureScreenshot` 在超长页面上、
// 或调试器被 DevTools 占用时），于是那个 promise 永不 settle ✗
//
// 更隐蔽的一半：`attach` 把 promise **缓存进 `attached`**，而缓存的是**原始 promise**。
// 一旦它永不 settle，这个标签页后续每一次 CDP 调用都会拿到同一个死 promise ——
// 症状是"这个标签页从此再也用不了 CDP"，且**没有任何报错**。
//
// 所以判据有三条：① 命令要超时；② 附加要超时；③ 超时后**不许留下毒缓存**。
import test from 'node:test';
import assert from 'node:assert/strict';

/** 装 chrome 桩。`hang: true` 表示 Chrome **永不回调**（真实发生过的情形）。 */
function installChrome({ hang = true } = {}) {
  const calls = { attach: 0, send: 0 };
  const listeners = [];
  globalThis.chrome = {
    runtime: { lastError: null },
    debugger: {
      onDetach: { addListener: (fn) => listeners.push(fn) },
      attach(target, version, cb) {
        calls.attach += 1;
        if (!hang) cb();
      },
      sendCommand(target, method, params, cb) {
        calls.send += 1;
        if (!hang) cb({ ok: true });
      },
    },
  };
  return { calls, listeners };
}

const freshCdp = async () => {
  // 每次重新导入，避免模块级 attached 缓存跨用例串味
  return await import('../lib/backend/cdp.js?v=' + Math.random().toString(36).slice(2));
};

test('① 命令必须超时：Chrome 永不回调时，sendRaw 不能无限等（否则工具挂到 agent 的 15s 包装）', async () => {
  installChrome({ hang: true });
  const cdp = await freshCdp();
  const t0 = Date.now();
  await assert.rejects(
    () => cdp.command(1, 'Page.captureScreenshot', {}, { timeoutMs: 120 }),
    /未响应|超时/,
    '应在超时后以可读错误拒绝，而不是永不 settle'
  );
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, '应在设定的超时附近返回，实际 ' + ms + 'ms');
});

test('② 附加必须超时，且错误里说明是"附加"这一步（好定位，不是笼统失败）', async () => {
  installChrome({ hang: true });
  const cdp = await freshCdp();
  await assert.rejects(() => cdp.attach(7, { timeoutMs: 120 }), /附加/, '错误应指出是附加阶段');
});

test('③ 超时后不许留下毒缓存：下一次调用必须重新尝试，而不是拿到那个死 promise', async () => {
  const { calls } = installChrome({ hang: true });
  const cdp = await freshCdp();
  await assert.rejects(() => cdp.attach(9, { timeoutMs: 100 }));
  const afterFirst = calls.attach;
  // 第二次：若缓存里还躺着那个永不 settle 的 promise，这里会**再次挂住**（而不是立刻超时）
  const t0 = Date.now();
  await assert.rejects(() => cdp.attach(9, { timeoutMs: 100 }), /附加/);
  const ms = Date.now() - t0;
  assert.ok(calls.attach > afterFirst, '第二次必须真的再试一次附加（说明缓存已清）');
  assert.ok(ms < 2000, '第二次也应在超时内返回，实际 ' + ms + 'ms');
});

test('④ 正常环境不受影响：回调正常返回时不该引入多余等待或错误', async () => {
  installChrome({ hang: false });
  const cdp = await freshCdp();
  const r = await cdp.command(3, 'Runtime.evaluate', { expression: '1' }, { timeoutMs: 5000 });
  assert.deepEqual(r, { ok: true });
});

test('⑤ 默认超时必须存在且有界（工具调用方不会自己传超时）', async () => {
  const cdp = await freshCdp();
  assert.ok(Number.isFinite(cdp.DEFAULT_CDP_TIMEOUT_MS), '要有默认超时常量');
  assert.ok(cdp.DEFAULT_CDP_TIMEOUT_MS > 0 && cdp.DEFAULT_CDP_TIMEOUT_MS <= 15000, '默认值应在 0~15s 内（agent 的包装是 15s）');
});

// ---------------- 截图工具：阶梯重试必须受**总预算**约束 ----------------
//
// 只给 CDP 层加超时还不够：截图有降质阶梯（最多三档），每档各等 8s 就是 24s ——
// **比 agent 层 15s 的通用包装还慢**，修完反而更糟（用户等到 15s 被杀，而错误还说不出卡在哪）。

const { takeScreenshot } = await import('../lib/assistant/screenshot-tool.js');

function shotDeps({ mode = 'hang', budgetMs = 150, perCallMs = 100 } = {}) {
  let shotCalls = 0;
  return {
    deps: {
      ctx: { tabId: 5 },
      args: {},
      screenshotBudgetMs: budgetMs,
      cdpAllowed: () => true,
      cdp: {
        /**
         * ⚠ 桩必须**模拟真实现的行为**：真 `cdp.screenshot` 现在会按 `timeoutMs` 自己超时，
         * 而工具层的预算只能"停止继续重试"、**无法中断已在飞的 promise**。
         * 第一版桩返回一个永不 settle 的 promise（无视 timeoutMs），于是用例自己也挂死了 ✗
         * 那测的其实是"工具能不能打断 CDP"，而它本来就不该也不能 —— 保障在 CDP 层（①–⑤）。
         */
        async screenshot(tabId, opts) {
          shotCalls += 1;
          if (mode === 'ok') return 'BBBB';
          if (mode === 'attach-fail') throw new Error('Another debugger is already attached');
          // 'timeout'：像真实现那样等到超时才拒绝
          const wait = Number(opts && opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : perCallMs;
          await new Promise((r) => setTimeout(r, Math.min(wait, perCallMs)));
          const e = new Error('CDP 命令 Page.captureScreenshot 未响应（' + wait + 'ms 未响应）');
          throw e;
        },
        async command() {
          return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
        },
      },
      screenshotAttempts: () => [
        { format: 'jpeg', quality: 70 },
        { format: 'jpeg', quality: 50 },
        { format: 'png', quality: undefined },
      ],
      saveScreenshot: async () => true,
      formatScreenshotSummary: () => '已截图 800×600（jpeg q70，1KB）',
    },
    calls: () => shotCalls,
  };
}

test('⑥ 截图：阶梯重试受**总预算**约束（不会三档各等一次，把总耗时推到 agent 的 15s 之外）', async () => {
  // 每档 100ms、总预算 150ms → 最多试两档（若没有预算约束就会试满三档）
  const { deps, calls } = shotDeps({ mode: 'timeout', budgetMs: 150, perCallMs: 100 });
  const t0 = Date.now();
  const r = await takeScreenshot(deps);
  const ms = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.match(r.result, /截图超时/, '要明确说是超时（与"无法附加"区分，下一步动作不同）');
  assert.ok(calls() <= 2, '受预算约束：最多试两档，实际 ' + calls() + ' 次');
  assert.ok(calls() >= 1, '至少要尝试一次');
  assert.ok(ms < 1200, '总耗时应在预算附近，实际 ' + ms + 'ms');
});

test('⑦ 截图：非超时的失败仍报"无法附加"（两种失败不能混为一谈）', async () => {
  const { deps } = shotDeps({ mode: 'attach-fail' });
  const r = await takeScreenshot(deps);
  assert.equal(r.ok, false);
  assert.match(r.result, /无法附加|被其它调试工具占用/, '非超时失败应保留原说明');
  assert.ok(!/截图超时/.test(r.result), '不该把普通失败报成超时');
});

test('⑧ 截图：正常路径不受影响（回读尺寸，成功返回）', async () => {
  const { deps } = shotDeps({ mode: 'ok' });
  const r = await takeScreenshot(deps);
  assert.equal(r.ok, true);
  assert.match(r.result, /已截图/);
  assert.ok(r.screenshot && r.screenshot.width === 800, '应带回尺寸供面板渲染');
});

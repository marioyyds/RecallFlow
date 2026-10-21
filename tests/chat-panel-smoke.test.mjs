// lib/page/chat.js 的**第一次真 import**。
//
// 背景：这个文件有 4900 行，12 个测试文件提到它，但此前**没有一个真的 import 过** ——
// 全是 `readFileSync` + 正则。正则能钉住"某句话还在文件里"，却完全不知道代码跑起来会不会抛。
// fab 位置那个 bug（存的值里 ratio 为 null 时气泡跳到顶部）就是这么漏过去的。
//
// 这里用 tests/helpers/dom-stub.mjs 提供的最小 DOM 真跑一遍：建宿主 → 开面板 →
// 勾选审批自动驾驶 → 落盘。覆盖面仍然有限（不渲染、不测样式），但"能不能跑起来"
// 与"审批 UI 的五个类别是不是真的接到了设置上"这两件事，第一次有断言了。
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.mjs';
import { installChrome, restoreChrome } from './helpers/chrome-stub.mjs';

let seq = 0;

/**
 * 起一份全新的 chat.js 实例。
 *
 * 为什么要 cache-busting 的 query：chat.js 有大量**模块级状态**（host / panel / debounce 时间戳），
 * 同一个实例跑多个用例会让它们互相污染 —— 这正是 golden.spec 那条 flaky 的味道。
 * 每个用例一个实例，靠 URL 查询串让 ESM 缓存失效。
 */
async function boot(chromeOpts = {}) {
  const dom = installDomStub();
  const prevChrome = installChrome(chromeOpts);
  const mod = await import('../lib/page/chat.js?case=' + (seq += 1));
  mod.initAssistant();
  const host = () => dom.document.documentElement.querySelector('#__kb-ai-host');
  const shadow = () => (host() ? host().shadowRoot : null);
  const panel = () => {
    const s = shadow();
    return s ? s.querySelector('.panel') : null;
  };
  const fab = () => {
    const s = shadow();
    return s ? s.querySelector('.fab') : null;
  };
  const shortcut = () => dom.document.emit('keydown', { altKey: true, shiftKey: true, code: 'KeyR', key: 'R', repeat: false });
  return {
    dom, mod, host, shadow, panel, fab, shortcut,
    close() { dom.restore(); restoreChrome(prevChrome); },
  };
}

/** 等到 predicate 为真（避免用固定 sleep 让用例变慢／变脆）。 */
async function waitFor(predicate, label, timeoutMs = 200) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('等待超时：' + label);
}

test('初始化：扩展上下文活着时，宿主与 FAB 必须建出来', async () => {
  const app = await boot();
  try {
    const host = app.host();
    assert.ok(host, '宿主 div 必须挂到 documentElement 上（没有它 = 整套 UI 都没显示）');
    assert.equal(host.id, '__kb-ai-host');
    assert.ok(host.shadowRoot, '宿主必须用 shadow DOM（样式隔离：面板 CSS 不能污染页面）');
    const fab = app.fab();
    assert.ok(fab, 'FAB 必须存在');
    // 快捷键写进 title/aria-label 是"用户怎么知道有这个功能"的唯一途径
    assert.match(String(fab.title || ''), /Alt\+Shift\+R/, 'FAB 的 title 必须写明快捷键');
    assert.match(String(fab.getAttribute('aria-label') || ''), /Alt\+Shift\+R/, 'aria-label 同样要写明快捷键');
  } finally {
    app.close();
  }
});

test('初始化：扩展上下文失效时不建 UI，而是提示刷新页面', async () => {
  // 旧内容脚本在扩展重载后继续跑，chrome.runtime 还在但调用会抛 —— 这是真实场景。
  const broken = () => {
    throw new Error('Extension context invalidated.');
  };
  const app = await boot({ overrides: { runtime: { id: 'gone', getURL: (p) => p, getManifest: broken, onMessage: { addListener() {} } } } });
  try {
    assert.equal(app.host(), null, '上下文失效时不能建宿主（否则一堆 chrome.* 调用会继续抛）');
    const notice = () => app.dom.document.body.childNodes.find((n) => /请刷新页面/.test(String(n.textContent || '')));
    const el = await waitFor(notice, '应出现"请刷新页面"提示');
    assert.ok(el, '必须给用户一句话，而不是静默什么都不显示');
  } finally {
    app.close();
  }
});

test('Alt+Shift+R 打开面板：FAB 让位、面板出现、输入框就位', async () => {
  const app = await boot();
  try {
    app.shortcut();
    const panel = await waitFor(app.panel, '快捷键后应出现面板');
    assert.ok(panel.classList.contains('docked') || panel.classList.contains('floating'), '面板要有定位形态');
    assert.ok(app.fab().classList.contains('hidden'), '面板打开时 FAB 应隐藏（否则两个入口叠在一起）');
    const textarea = panel.querySelector('textarea');
    assert.ok(textarea, '面板必须有输入框');
  } finally {
    app.close();
  }
});

test('快捷键去抖：250ms 内连按两次只生效一次', async () => {
  const app = await boot();
  try {
    app.shortcut();
    await waitFor(app.panel, '第一次按键应打开面板');
    // 同一毫秒内再按一次：真实场景是用户手抖双击
    app.shortcut();
    assert.ok(app.panel(), '去抖窗口内第二次按键不应把面板关掉（否则用户会看到闪一下）');
  } finally {
    app.close();
  }
});

test('点 FAB 可以关闭面板（不走快捷键那条去抖路径）', async () => {
  const app = await boot();
  try {
    app.shortcut();
    const panel = await waitFor(app.panel, '快捷键先打开面板');
    assert.ok(panel);
    app.fab().emit('click', {});
    assert.equal(app.panel(), null, 'FAB 点击应关闭面板');
    assert.ok(!app.fab().classList.contains('hidden'), '面板关掉后 FAB 必须重新可见');
  } finally {
    app.close();
  }
});

test('审批面板必须覆盖全部 5 个类别（少一个 = 那类工具永远无法自动批准）', async () => {
  const app = await boot();
  try {
    app.shortcut();
    const panel = await waitFor(app.panel, '打开面板');
    const values = panel.querySelectorAll('[data-policy]').map((el) => el.getAttribute('data-policy'));
    assert.deepEqual(
      values.slice().sort(),
      ['browser', 'commands', 'edit', 'mcp', 'read'],
      'UI 的 data-policy 必须与审批策略的 5 个类别一一对应（见 lib/assistant/approval-policy.js）'
    );
    assert.ok(panel.querySelector('[data-autopilot]'), '「自动驾驶」总开关必须在');
  } finally {
    app.close();
  }
});

test('勾选自动驾驶：5 类全部开启并写入设置，标签同步更新', async () => {
  const app = await boot();
  try {
    app.shortcut();
    const panel = await waitFor(app.panel, '打开面板');
    // 等 getAISettings() 回来（它决定每个勾选框的初始值，也负责挂上各自的 change 监听）
    const auto = await waitFor(() => panel.querySelector('[data-autopilot]'), '审批评级控件');
    await new Promise((r) => setTimeout(r, 10));
    auto.checked = true;
    auto.emit('change', {});
    const saved = await waitFor(() => {
      const s = globalThis.chrome.storage.local._dump();
      return s.aiSettings && s.aiSettings.toolApprovalPolicy;
    }, '自动驾驶应把策略落盘');
    assert.deepEqual(saved, { read: true, edit: true, commands: true, browser: true, mcp: true });
    const label = panel.querySelector('.approval-settings-toggle');
    assert.match(String(label.textContent || ''), /读取、编辑、命令、浏览器、MCP/, '标签要如实列出已自动批准的类别');
  } finally {
    app.close();
  }
});

test('取消自动驾驶：5 类全部关闭并写入设置', async () => {
  const app = await boot();
  try {
    app.shortcut();
    const panel = await waitFor(app.panel, '打开面板');
    const auto = await waitFor(() => panel.querySelector('[data-autopilot]'), '审批评级控件');
    await new Promise((r) => setTimeout(r, 10));
    auto.checked = false;
    auto.emit('change', {});
    const saved = await waitFor(() => {
      const s = globalThis.chrome.storage.local._dump();
      const p = s.aiSettings && s.aiSettings.toolApprovalPolicy;
      // 只有"全部为 false"才算这次改动的结果（初始值里 read 默认是 true）
      return p && Object.values(p).every((v) => v === false) ? p : null;
    }, '取消自动驾驶应把 5 类全部关掉');
    assert.deepEqual(saved, { read: false, edit: false, commands: false, browser: false, mcp: false });
  } finally {
    app.close();
  }
});

test('后台转发的 panel:toggle 消息也能开关面板（焦点在子框架时只能走这条通道）', async () => {
  const app = await boot();
  try {
    assert.equal(app.panel(), null, '前提：初始没有面板');
    const replies = globalThis.chrome._emitMessage({ type: 'panel:toggle' }, { frameId: 0 });
    assert.ok(Array.isArray(replies), '_emitMessage 应真的投递到内容脚本的监听器');
    await waitFor(app.panel, '收到 panel:toggle 后应打开面板');
    assert.ok(app.fab().classList.contains('hidden'), '面板打开后 FAB 应隐藏');
  } finally {
    app.close();
  }
});

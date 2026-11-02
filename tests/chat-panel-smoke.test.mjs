// lib/ui/page/chat.ts 的**第一次真 import**。
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
import { createChromeRuntimeAdapter } from '../lib/adapters/chrome/runtime.ts';
import {
  PANEL_EMBEDDED_DEFAULT_RATIO,
  PANEL_EMBEDDED_MAX_RATIO,
} from '../lib/ui/page/panel-layout.ts';

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
  const mod = await import('../lib/ui/page/chat.ts?case=' + (seq += 1));
  // 与真实入口对齐（entries/content.ts:170-173）：storage 也传进去 —— 不传的话
  // 面板布局写盘会回落到网页 localStorage，嵌入态/悬浮球偏好的落盘就测不到。
  const { createChromeStorageAdapter } = await import('../lib/adapters/chrome/storage.ts');
  mod.initAssistant({
    runtime: createChromeRuntimeAdapter(),
    storage: createChromeStorageAdapter(globalThis.chrome.storage.local, globalThis.chrome),
  });
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
      'UI 的 data-policy 必须与审批策略的 5 个类别一一对应（见 lib/application/agent/approval-policy.js）'
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

// ---- 悬浮球右键菜单（修复：此前 fab 没有任何 contextmenu 监听，右键只会弹
// 宿主页面的默认菜单，悬浮球没有任何退出途径 —— 用户报的正是这个 bug）----

test('右键 FAB：必须弹出自己的菜单（打开面板 / 隐藏悬浮球）', async () => {
  const app = await boot();
  try {
    app.fab().emit('contextmenu', { button: 2 });
    const menu = app.shadow() ? app.shadow().querySelector('.fab-menu') : null;
    assert.ok(menu, '右键必须弹出悬浮球自己的菜单（contextmenu 已被 preventDefault 拦下）');
    const labels = menu.querySelectorAll('button').map((b) => String(b.textContent || ''));
    assert.deepEqual(labels, ['打开面板', '隐藏悬浮球']);
    assert.equal(menu.querySelectorAll('button.danger').length, 1, '「隐藏悬浮球」必须是危险项（红色）');
  } finally {
    app.close();
  }
});

test('右键菜单「隐藏悬浮球」：球体摘掉、偏好落盘、宿主保留', async () => {
  const app = await boot();
  try {
    app.fab().emit('contextmenu', { button: 2 });
    const menu = app.shadow().querySelector('.fab-menu');
    const hideBtn = menu.querySelectorAll('button').find((b) => b.classList.contains('danger'));
    hideBtn.emit('click', {});
    await waitFor(() => !app.fab(), '隐藏后悬浮球必须消失');
    const saved = globalThis.chrome.storage.local._dump()['recallflow.fab.hidden.v1'];
    assert.ok(saved && saved.hidden === true, '隐藏偏好必须写进扩展存储（跨标签页同步的依据）');
    assert.ok(app.host(), '隐藏只摘球体，宿主必须保留（对话面板还要用）');
  } finally {
    app.close();
  }
});

test('隐藏过的用户：刷新页面后悬浮球不再注入（偏好读回的通路）', async () => {
  const app = await boot({ local: { 'recallflow.fab.hidden.v1': { hidden: true } } });
  try {
    await waitFor(() => !app.fab(), '隐藏过的用户初始不应注入悬浮球');
    assert.ok(app.host(), '偏好只影响球体，宿主仍在');
  } finally {
    app.close();
  }
});

test('fab:show 消息：被隐藏的悬浮球重新出现，隐藏偏好清掉', async () => {
  const app = await boot({ local: { 'recallflow.fab.hidden.v1': { hidden: true } } });
  try {
    await waitFor(() => !app.fab(), '前提：悬浮球已被隐藏偏好摘掉');
    const replies = globalThis.chrome._emitMessage({ type: 'fab:show' }, { frameId: 0 });
    assert.ok(Array.isArray(replies), 'fab:show 必须真的投递到内容脚本的监听器');
    await waitFor(app.fab, 'fab:show 后悬浮球必须回来');
    const saved = globalThis.chrome.storage.local._dump()['recallflow.fab.hidden.v1'];
    assert.ok(saved && saved.hidden === false, '找回必须清掉隐藏偏好（否则刷新后球又没了）');
  } finally {
    app.close();
  }
});

// ---- 嵌入态：嵌在页面里面作为分栏（默认小比例、可调整大小、可切回浮层）----

test('面板「嵌入」模式：整列贴右 + 页面正文右缩，切回「浮层」时还原', async () => {
  const app = await boot();
  try {
    app.shortcut();
    const panel = await waitFor(app.panel, '打开面板');
    const modeBtn = await waitFor(() => panel.querySelector('.p-head .mode-btn'), '「嵌入/浮层」切换按钮');
    assert.equal(String(modeBtn.textContent || ''), '嵌入', '浮层里按钮应显示可切换的目标「嵌入」');
    modeBtn.emit('click', {});
    assert.ok(panel.classList.contains('embedded'), '嵌入态必须有 .embedded 类');
    assert.equal(String(panel.style.getPropertyValue('top') || ''), '', '嵌入态位置交给 CSS，不能写内联 top');
    assert.ok(!panel.classList.contains('docked'), '嵌入态不是 docked 浮层');
    const margin = app.dom.document.body.style.getPropertyValue('margin-right');
    assert.equal(
      margin,
      Math.round(1200 * PANEL_EMBEDDED_DEFAULT_RATIO) + 'px',
      '页面正文必须右缩同等宽度（「嵌在页面里」的关键，默认比例从常量取）'
    );
    const width = parseInt(String(panel.style.getPropertyValue('width') || ''), 10);
    assert.ok(width >= 280, '嵌入宽度不能小于最小列宽 280');
    assert.ok(
      width <= Math.round(1200 * PANEL_EMBEDDED_MAX_RATIO) + 1,
      '嵌入宽度不能超过上限比例（旧上限 0.6 太紧，用户反馈「对话窗太小还不能调」）'
    );
    modeBtn.emit('click', {});
    assert.ok(!panel.classList.contains('embedded'), '切回浮层后 .embedded 必须移除');
    assert.ok(panel.classList.contains('docked'), '切回浮层应回到停靠形态');
    assert.equal(
      String(app.dom.document.body.style.getPropertyValue('margin-right') || ''),
      '',
      '切回浮层时页面边距必须还原'
    );
    assert.equal(String(modeBtn.textContent || ''), '嵌入', '按钮文案应始终显示切换目标');
  } finally {
    app.close();
  }
});

test('嵌入态记忆：关面板再开仍回到嵌入态，比例跟存档走', async () => {
  const app = await boot();
  try {
    app.shortcut();
    const panel = await waitFor(app.panel, '第一次打开面板');
    panel.querySelector('.p-head .mode-btn').emit('click', {});
    await waitFor(() => {
      const rec = globalThis.chrome.storage.local._dump()['recallflow.panel.layout.v1'];
      return rec && rec.mode === 'embedded';
    }, '嵌入态必须落盘 mode=embedded');
    const rec = globalThis.chrome.storage.local._dump()['recallflow.panel.layout.v1'];
    assert.ok(rec.ratio > 0 && rec.ratio <= 0.6, 'ratio 必须落在 (0, 0.6]');
    panel.querySelector('.p-head .close').emit('click', {});
    assert.equal(app.panel(), null, '前提：面板已关');
    // 快捷键有 250ms 去抖：第一次打开距今若不足 250ms，第二次按键会被吞掉
    await new Promise((r) => setTimeout(r, 300));
    app.shortcut();
    const reopened = await waitFor(app.panel, '第二次打开面板');
    assert.ok(reopened.classList.contains('embedded'), '存档是嵌入态时，重开必须回到嵌入态');
  } finally {
    app.close();
  }
});

test('嵌入态拉伸：左缘手柄只改宽度（比例记忆更新），右缘钉住', async () => {
  const app = await boot();
  try {
    app.shortcut();
    const panel = await waitFor(app.panel, '打开面板');
    panel.querySelector('.p-head .mode-btn').emit('click', {});
    const handle = await waitFor(() => panel.querySelector('.resize-handle.left'), '嵌入态左缘手柄');
    const before = parseInt(String(panel.style.getPropertyValue('width') || ''), 10);
    // 向左拖 60px：嵌入列变宽。注意：桩的 offsetWidth 固定 320（不随 style.width
    // 变化），生产公式是 origWidth - dw —— 期望值按桩语义推导，但"手柄驱动宽度、
    // 边距跟随、比例落盘、不转自由定位"这些行为断言与真实浏览器一致。
    // 桩不做真实布局：offsetWidth 是常量 320，与面板当前的内联 width 无关。
    // 嵌入式拉伸的公式读的是 `panel.offsetWidth`，所以这里把它对齐成真实几何
    // （真实浏览器里 offsetWidth === 当前渲染宽度）。
    panel.offsetWidth = before;
    const origWidth = panel.offsetWidth;
    const dw = 0 - 60;
    const expected = Math.max(280, Math.min(Math.round(1200 * PANEL_EMBEDDED_MAX_RATIO), origWidth - dw));
    handle.emit('mousedown', { clientX: 60, clientY: 100, button: 0 });
    app.dom.document.emit('mousemove', { clientX: 0, clientY: 100 });
    app.dom.document.emit('mouseup', {});
    const after = parseInt(String(panel.style.getPropertyValue('width') || ''), 10);
    assert.equal(after, expected, '左缘手柄向左拖必须加宽（比例公式：origWidth - dw，夹在 [280, maxRatio·vw]）');
    assert.ok(after > before, '嵌入列确实变宽了');
    assert.equal(
      app.dom.document.body.style.getPropertyValue('margin-right'),
      after + 'px',
      '页面边距必须跟着新宽度走'
    );
    await waitFor(() => {
      const rec = globalThis.chrome.storage.local._dump()['recallflow.panel.layout.v1'];
      return rec && rec.ratio != null && Math.abs(rec.ratio - after / 1200) < 0.001;
    }, '拉伸后的比例必须落盘');
    assert.ok(!panel.classList.contains('floating') && !panel.classList.contains('docked'), '拉伸不能把面板转成自由定位');
  } finally {
    app.close();
  }
});

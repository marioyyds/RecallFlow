// 导出期 UI 守卫（lib/page/save-clean.js）。
//
// 这条守卫要保证的事只有一句：**用户保存/打印页面时，产物里没有 RecallFlow 的痕迹。**
// 而"隐藏"和"摘掉"在这一点上是两回事 —— `display:none` 的节点照样会被序列化写进
// 另存出来的 HTML，所以关键断言必须是"宿主已经不在文档树里"，而不是"宿主看不见了"。
//
// 同时要钉住反向风险：守卫绝不能把 UI 永久弄丢，也不能吞掉浏览器自己的保存行为。
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.mjs';
import { createExportGuard, HOST_ID, SUSPEND_ATTR } from '../lib/page/save-clean.js';

function setup() {
  const dom = installDomStub();
  const doc = dom.document;
  const win = dom.window;

  // 页面上原本有兄弟节点：宿主要能回到**原位**，而不是被追加到末尾
  //（追加会改变站点的绘制顺序，某些站点里就是"面板跑到了别处"）。
  const before = doc.createElement('div');
  before.setAttribute('id', 'before');
  const host = doc.createElement('div');
  host.setAttribute('id', HOST_ID);
  const after = doc.createElement('div');
  after.setAttribute('id', 'after');
  doc.documentElement.appendChild(before);
  doc.documentElement.appendChild(host);
  doc.documentElement.appendChild(after);

  const clock = { t: 10_000 };
  const calls = { suspend: [], resume: [] };
  const guard = createExportGuard({
    doc,
    win,
    now: () => clock.t,
    onSuspend: (reason) => calls.suspend.push(reason),
    onResume: (reason) => calls.resume.push(reason),
  });
  guard.install();

  return {
    dom,
    doc,
    win,
    host,
    clock,
    calls,
    guard,
    order: () => doc.documentElement.childNodes.map((n) => (n && n.id) || '').filter(Boolean),
    inDocument: () => doc.getElementById(HOST_ID) != null,
    close() {
      guard.uninstall();
      dom.restore();
    },
  };
}

/** 造一个 Ctrl+S 的 keydown：`prevented` 用来验证"我们不吞掉浏览器自己的保存"。 */
function ctrlS(extra = {}) {
  let prevented = false;
  return {
    key: 's',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    preventDefault: () => { prevented = true; },
    get prevented() { return prevented; },
    ...extra,
  };
}

test('Ctrl+S：宿主被**摘出文档**（不是隐藏），产物里不可能再出现它', () => {
  const app = setup();
  try {
    app.doc.emit('keydown', ctrlS());
    assert.equal(app.inDocument(), false, '宿主必须已经不在文档树里');
    // 节点本身仍被一个 DocumentFragment 持有（这样才能原样搬回去、不丢事件与面板状态），
    // 关键是它**不再连着 document** —— 序列化是从 document 出发的。
    assert.notEqual(app.host.parentNode, app.doc.documentElement);
    assert.equal(app.host.isConnected, false, 'isConnected 为假才算真的摘掉了');
    assert.equal(app.host.getAttribute(SUSPEND_ATTR), '1', '要留下可排查的标记');
    assert.deepEqual(app.calls.suspend, ['save-shortcut'], '宿主侧必须**先**知道要停手');
  } finally {
    app.close();
  }
});

test('Ctrl+S 不 preventDefault：保存是用户要的，我们只让路', () => {
  const app = setup();
  try {
    const ev = ctrlS();
    app.doc.emit('keydown', ev);
    assert.equal(ev.prevented, false);
  } finally {
    app.close();
  }
});

test('焦点回到页面即复原，且**按原位**插回（不是追加到末尾）', () => {
  const app = setup();
  try {
    assert.deepEqual(app.order(), ['before', HOST_ID, 'after']);
    app.doc.emit('keydown', ctrlS());
    app.win.emit('focus');
    assert.deepEqual(app.order(), ['before', HOST_ID, 'after'], '顺序必须与摘除前完全一致');
    assert.equal(app.inDocument(), true);
    assert.equal(app.host.getAttribute(SUSPEND_ATTR), null, '复原后不该留下标记');
    assert.deepEqual(app.calls.resume, ['focus']);
  } finally {
    app.close();
  }
});

test('重复 suspend 是幂等的：第二次不该再摘一次、也不该重复回调', () => {
  const app = setup();
  try {
    assert.equal(app.guard.suspend('print'), true);
    assert.equal(app.guard.suspend('print'), false);
    assert.deepEqual(app.calls.suspend, ['print']);
    assert.equal(app.guard.isSuspended(), true);
  } finally {
    app.close();
  }
});

test('打印：beforeprint 摘除、afterprint 复原（Ctrl+P 与菜单打印都走这条）', () => {
  const app = setup();
  try {
    app.win.emit('beforeprint');
    assert.equal(app.inDocument(), false);
    app.win.emit('afterprint');
    assert.equal(app.inDocument(), true);
    assert.deepEqual(app.calls.resume, ['print']);
  } finally {
    app.close();
  }
});

test('切回可见时复原（保存对话框关掉后页面会重新可见）', () => {
  const app = setup();
  try {
    app.doc.emit('keydown', ctrlS());
    app.doc.visibilityState = 'visible';
    app.doc.emit('visibilitychange');
    assert.equal(app.inDocument(), true);
  } finally {
    app.close();
  }
});

test('交互恢复有宽限期：本次 Ctrl+S 自己的 keydown 不能立刻把宿主挂回来', () => {
  const app = setup();
  try {
    app.doc.emit('keydown', ctrlS());
    // 紧接着的 pointerdown（宽限期内）不恢复 —— 此时用户可能还在挑保存路径
    app.doc.emit('pointerdown', {});
    assert.equal(app.inDocument(), false, '宽限期内不该恢复');

    // 过了宽限期，任何真实交互都说明"人已经回到页面、保存早已结束"
    app.clock.t += 5000;
    app.doc.emit('pointerdown', {});
    assert.equal(app.inDocument(), true);
  } finally {
    app.close();
  }
});

test('没有宿主时也进入挂起态：拦住"保存那一刻恰好要建宿主"的竞态', () => {
  const dom = installDomStub();
  const doc = dom.document;
  const win = dom.window;
  const calls = { suspend: [], resume: [] };
  const guard = createExportGuard({
    doc,
    win,
    getHost: () => null,
    now: () => 1,
    onSuspend: (r) => calls.suspend.push(r),
    onResume: (r) => calls.resume.push(r),
  });
  guard.install();
  try {
    assert.equal(guard.suspend('save-shortcut'), false, '没有可摘的节点');
    assert.equal(guard.isSuspended(), true, '但必须进入挂起态，供宿主侧据此拒绝重建');
    assert.deepEqual(calls.suspend, ['save-shortcut']);
    guard.restore('focus');
    assert.equal(guard.isSuspended(), false);
    assert.deepEqual(calls.resume, ['focus']);
  } finally {
    guard.uninstall();
    dom.restore();
  }
});

test('无关按键不触发（普通 S / Alt+S / Ctrl+F）', () => {
  const app = setup();
  try {
    for (const ev of [
      { key: 's', ctrlKey: false },
      { key: 's', ctrlKey: true, altKey: true },
      { key: 'f', ctrlKey: true },
    ]) {
      app.doc.emit('keydown', ev);
    }
    assert.equal(app.inDocument(), true);
    assert.deepEqual(app.calls.suspend, []);
  } finally {
    app.close();
  }
});

test('uninstall：复原并摘掉全部监听（守卫可以有第二个实例）', () => {
  const app = setup();
  try {
    app.doc.emit('keydown', ctrlS());
    app.guard.uninstall();
    assert.equal(app.inDocument(), true, '卸载时必须把宿主还回去');
    assert.equal(app.doc.hasListener('keydown'), false);
    assert.equal(app.win.hasListener('beforeprint'), false);
    assert.equal(app.win.hasListener('focus'), false);
  } finally {
    app.close();
  }
});

test('打印路径的 CSS 兜底仍在：shadow 内 @media print 隐藏 :host', async () => {
  // JS 那条路依赖 beforeprint 真的被派发；样式这条不依赖事件，是最后一道保险。
  const { PANEL_CSS } = await import('../lib/page/panel-css.js');
  const block = PANEL_CSS.match(/@media print\s*\{[\s\S]*?:host[\s\S]*?\}/);
  assert.ok(block, '缺了这条，beforeprint 未触发时打印/导出 PDF 会印出悬浮球');
  assert.match(block[0], /display:\s*none/);
  assert.match(block[0], /visibility:\s*hidden/);
});

test('存档自毁闸的接线：样式门控 + 主世界注册，缺一不可', async () => {
  // 这两处是一根绳的两端，且**都很难在单测里跑到**（一个在 CSS 里、一个在页面主世界的裸脚本里）：
  //   · 少了样式门控 → 存档里悬浮球照旧显示（就是用户报的那个故障）；
  //   · 少了主世界注册 → 元素永远不被升级 → 实时页面里悬浮球也显示不出来（更糟，连入口都没了）。
  // 真正的行为由 tests/e2e/save-clean.spec.mjs 在真浏览器里验；
  // 这里钉住"接线还在"，让删掉任何一端时**单测就跑红**，而不是等到用户保存文件才发现。
  const { PANEL_CSS } = await import('../lib/page/panel-css.js');
  assert.match(
    PANEL_CSS,
    /:host\(:not\(:defined\)\)\s*\{\s*display:\s*none\s*!important/,
    'PANEL_CSS 里的 :not(:defined) 门控没了，存档副本会显示悬浮球'
  );
  // 另一半（主世界是否真的注册了 rf-ai-host）由 tests/page-debug-hook.test.mjs 用 vm 沙箱做**行为**断言；
  // 两端的行为合起来由 tests/e2e/save-clean.spec.mjs 在真浏览器里验。
});

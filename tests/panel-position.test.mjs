// 面板位置「关掉再开必须回到原处」的行为测试 —— 真 import lib/ui/page/chat.ts。
//
// 这是 TITA-9 的验收门禁。用户的原始反馈是「关闭面板对话框，它不能保存面板的位置状态」，
// 而这个问题**不是某一行的错**，是三处判据口径不一致（见 lib/ui/page/panel-layout.ts 顶部说明）：
//   ① 关闭时只有 `_manualPos` 才写位置 —— 默认停靠面板的 `top` 恰好是 `auto`，从来写不进去；
//   ② 打开时只有停靠分支读位置 —— 划词气泡那条路径把面板摆到鼠标点上；
//   ③ 存档没有 `docked` 字段 —— 停靠态无法还原，只能靠 CSS 默认值，窗口一变就"看起来没保存"。
// 所以这里的用例按「用户实际走的三条路」写，而不是按函数写：
//   关掉再开 / 从气泡打开 / 窗口变小后重开 / 旧版存档兼容。
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.mjs';
import { installChrome, restoreChrome } from './helpers/chrome-stub.mjs';
import { createChromeRuntimeAdapter } from '../lib/adapters/chrome/runtime.ts';

const POS_KEY = 'recallflow-panel-pos';
const SIZE_KEY = 'recallflow-panel-size';

let seq = 0;

async function boot() {
  const dom = installDomStub();
  const prevChrome = installChrome();
  const mod = await import('../lib/ui/page/chat.ts?case=pos' + (seq += 1));
  mod.initAssistant({ runtime: createChromeRuntimeAdapter() });
  const host = () => dom.document.documentElement.querySelector('#__kb-ai-host');
  const shadow = () => (host() ? host().shadowRoot : null);
  const panel = () => {
    const s = shadow();
    return s ? s.querySelector('.panel') : null;
  };
  const bubble = () => {
    const s = shadow();
    return s ? s.querySelector('.bubble') : null;
  };
  const shortcut = () =>
    dom.document.emit('keydown', { altKey: true, shiftKey: true, code: 'KeyR', key: 'R', repeat: false });
  const selectText = (x, y) => {
    dom.window.getSelection = () => ({
      toString: () => '这是一段被选中的页面文字',
      getRangeAt: () => ({ getBoundingClientRect: () => ({ left: x, top: y, width: 120, height: 18 }) }),
    });
    dom.document.emit('mouseup', {});
  };
  return { dom, mod, host, shadow, panel, bubble, shortcut, selectText, close() { dom.restore(); restoreChrome(prevChrome); } };
}

/**
 * 让桩的 getBoundingClientRect 反映内联 left/top。
 *
 * 桩不做真实布局（rect 恒为 0,0），而被测代码是用 rect 记录当前位置的 ——
 * 不补这一层，「拖到 (300,140)」在测试里就等于「拖到 (0,0)」，位置断言会变成空话。
 * 只对本次拿到的 panel 生效，不影响其它用例。
 */
function wireLayout(panel) {
  const px = (v) => (typeof v === 'string' && v.endsWith('px') ? parseFloat(v) : null);
  panel.getBoundingClientRect = () => {
    const left = px(panel.style.left) ?? 0;
    const top = px(panel.style.top) ?? 0;
    return {
      left,
      top,
      width: panel.offsetWidth,
      height: panel.offsetHeight,
      right: left + panel.offsetWidth,
      bottom: top + panel.offsetHeight,
      x: left,
      y: top,
    };
  };
  return panel;
}

async function waitFor(predicate, label, timeoutMs = 400) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('等待超时：' + label);
}

function seed(json) {
  for (const [k, v] of Object.entries(json)) globalThis.localStorage.setItem(k, JSON.stringify(v));
}

// 快捷键有 250ms 去抖（防手抖双按），同一用例里连按两次会被吞掉 —— 等过去再按。
async function shortcutAgain(app) {
  await new Promise((r) => setTimeout(r, 260));
  app.shortcut();
}

test('默认停靠面板：关闭时也必须落盘（旧代码这条路径一个字节都不写）', async () => {
  const app = await boot();
  try {
    assert.equal(globalThis.localStorage.getItem(POS_KEY), null, '前提：打开前没有存档');
    app.shortcut();
    const panel = wireLayout(await waitFor(app.panel, '快捷键应打开面板'));
    assert.ok(panel.classList.contains('docked'), '前提：快捷键打开的是停靠面板');

    panel.querySelector('.close').emit('click', {});
    assert.equal(app.panel(), null, '前提：面板已关闭');

    const raw = globalThis.localStorage.getItem(POS_KEY);
    assert.ok(raw, '关闭时必须写入位置存档 —— 否则重开只能靠 CSS 默认值，「位置没保存」就是这个');
    const saved = JSON.parse(raw);
    assert.equal(saved.docked, true, '必须记录停靠态：停靠面板的位置由 bottom/right 决定，不是像素');
    assert.equal(saved.left, null, '停靠未拖动 = 没有像素位置，要如实记 null 而不是当时算出来的坐标');
    assert.equal(saved.top, null);
    assert.ok(globalThis.localStorage.getItem(SIZE_KEY), '尺寸照旧要存');
  } finally {
    app.close();
  }
});

test('关掉再开：停靠面板回到同一个「停靠位」，且仍是停靠态', async () => {
  const app = await boot();
  try {
    // 固定尺寸，让两次打开的高度一致 —— 桩不做真实布局（子元素 offsetHeight 都是常量），
    // 否则「底部留白」会被桩的假几何算成不同数值，测的就不是被测代码了。
    seed({ [SIZE_KEY]: { version: 2, width: 400, height: 480 } });
    app.shortcut();
    const first = wireLayout(await waitFor(app.panel, '第一次打开'));
    const firstBottom = first.style.bottom;
    assert.equal(firstBottom, '240px', '前提：1200×800 下停靠留白 = max(120, 30%*800) = 240');
    first.querySelector('.close').emit('click', {});

    await shortcutAgain(app);
    const second = wireLayout(await waitFor(app.panel, '第二次打开'));
    assert.ok(second.classList.contains('docked'), '重开后仍应是停靠面板（存档里有 docked=true）');
    assert.equal(second.style.bottom, firstBottom, '停靠位（bottom）必须一致');
    assert.equal(second.style.top, 'auto', '停靠面板不该被写成固定 top');
  } finally {
    app.close();
  }
});

test('从划词气泡打开：沿用关闭前的位置，而不是按鼠标点重新摆', async () => {
  const app = await boot();
  try {
    // 用户上次把面板摆在 (300,140) 后关掉（浮动状态）。
    seed({
      [POS_KEY]: { version: 2, docked: false, left: 300, top: 140 },
      [SIZE_KEY]: { version: 2, width: 400, height: 480 },
    });
    app.shortcut();
    wireLayout(await waitFor(app.panel, '预热：先建出宿主与面板'));
    app.panel().querySelector('.close').emit('click', {});

    // 然后在页面另一处划词 —— 气泡在 (640,220) 附近，旧代码会把面板摆到那里。
    app.selectText(640, 220);
    const bubble = await waitFor(app.bubble, '划词后应出现气泡');
    bubble.emit('click', {});

    const panel = wireLayout(await waitFor(app.panel, '点气泡应打开面板'));
    assert.equal(panel.style.left, '300px', '气泡打开也要回到用户上次的位置（旧代码按鼠标点摆 → 红）');
    assert.equal(panel.style.top, '140px');
    assert.ok(!panel.classList.contains('docked'), '气泡路径一律浮动（存档的 docked 不覆盖调用方意图）');
  } finally {
    app.close();
  }
});

test('评审退回项：上次是气泡关掉的（存档 docked:false），按 Alt+Shift+R 打开仍是停靠面板', async () => {
  const app = await boot();
  try {
    seed({ [POS_KEY]: { version: 2, docked: false, left: 300, top: 140 } });
    app.shortcut();
    const panel = wireLayout(await waitFor(app.panel, '快捷键打开面板'));
    assert.ok(panel.classList.contains('docked'), '快捷键/FAB 的意图是停靠，存档不得把它变成浮动');
    assert.equal(panel.style.left, '300px', '位置仍然要从存档恢复');
    assert.equal(panel.style.top, '140px');
  } finally {
    app.close();
  }
});

test('Esc 关闭也要落盘（与 ✕ 同一路径）', async () => {
  const app = await boot();
  try {
    app.shortcut();
    const panel = wireLayout(await waitFor(app.panel, '打开面板'));
    panel.querySelector('.p-head').emit('mousedown', { clientX: 0, clientY: 0 });
    app.dom.document.emit('mousemove', { clientX: 240, clientY: 160 });
    app.dom.document.emit('mouseup', {});

    app.dom.document.emit('keydown', { key: 'Escape', code: 'Escape', repeat: false });
    await waitFor(() => !app.panel(), 'Esc 应关闭面板');

    const saved = JSON.parse(globalThis.localStorage.getItem(POS_KEY));
    assert.equal(saved.left, 240, 'Esc 关闭同样必须把位置写进存档');
    assert.equal(saved.top, 160);
  } finally {
    app.close();
  }
});

test('窗口变小后重开：位置被夹回可视区，不会露在屏幕外', async () => {
  const app = await boot();
  try {
    seed({ [POS_KEY]: { version: 2, docked: false, left: 5000, top: 5000 } });
    app.shortcut();
    const panel = wireLayout(await waitFor(app.panel, '打开面板'));
    // 桩固定视口 1200×800、面板 320×480 ⇒ 最大 left=880 / top=320
    assert.equal(panel.style.left, '880px');
    assert.equal(panel.style.top, '320px');
  } finally {
    app.close();
  }
});

test('旧版存档（只有裸 left/top）仍能恢复位置，不会因为升级而丢', async () => {
  const app = await boot();
  try {
    seed({ [POS_KEY]: { left: 120, top: 90 } });
    app.shortcut();
    const panel = wireLayout(await waitFor(app.panel, '打开面板'));
    assert.equal(panel.style.left, '120px');
    assert.equal(panel.style.top, '90px');
  } finally {
    app.close();
  }
});

test('拖动 → 关闭 → 重开：位置与「已手动定位」状态都保留', async () => {
  const app = await boot();
  try {
    app.shortcut();
    let panel = wireLayout(await waitFor(app.panel, '打开面板'));
    panel.querySelector('.p-head').emit('mousedown', { clientX: 0, clientY: 0 });
    app.dom.document.emit('mousemove', { clientX: 300, clientY: 140 });
    app.dom.document.emit('mouseup', {});
    assert.equal(panel.style.left, '300px', '前提：拖动确实移动了面板');

    panel.querySelector('.close').emit('click', {});
    const saved = JSON.parse(globalThis.localStorage.getItem(POS_KEY));
    assert.equal(saved.left, 300, '拖动后的像素位置必须落盘');
    assert.equal(saved.top, 140);

    await shortcutAgain(app);
    panel = wireLayout(await waitFor(app.panel, '重开面板'));
    assert.equal(panel.style.left, '300px', '重开必须回到拖动后的位置');
    assert.equal(panel.style.top, '140px');
  } finally {
    app.close();
  }
});

test('SPA 换掉 DOM：面板被移除后自动重挂，位置仍取关闭前/打开前的存档', async () => {
  const app = await boot();
  try {
    seed({ [POS_KEY]: { version: 2, docked: false, left: 300, top: 140 } });
    app.shortcut();
    let panel = wireLayout(await waitFor(app.panel, '打开面板'));
    assert.equal(panel.style.left, '300px', '前提：打开时按存档摆位');

    // 模拟 Turbo 之类的客户端导航：整个宿主被换掉
    app.host().remove();
    assert.equal(app.panel(), null, '前提：宿主确实离开了文档');

    panel = wireLayout(
      await waitFor(() => {
        const p = app.panel();
        return p && p !== panel ? p : null;
      }, '宿主被保活重建后面板重新挂回', 3000)
    );
    assert.equal(panel.style.left, '300px', '重挂后位置不能被重置成 0,0');
    assert.equal(panel.style.top, '140px');
  } finally {
    app.close();
  }
});

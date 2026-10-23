// 流式渲染布局成本的**行为级门禁**（TITA-6 那轮性能收尾留下的部分）。
//
// 为什么单独成一类：这一轮省下的东西都有一个共同点 —— 把它改回去**功能照样正常、
// 现有测试照样绿**：
//   · 置底写 `scrollTop = scrollHeight` 而不是哨兵值 ⇒ 每次置底多一次强制同步布局；
//   · `fitPanelHeight` 每帧重测 chrome ⇒ 每帧多两次全量重排；
//
// 所以这里不查源码文本（那部分在同一处的源码级门禁里），而是**给它一套假 DOM，
// 数它到底读了几处几何量** —— `scrollHeight` / `offsetHeight` / `getBoundingClientRect`
// 每次读取都可能是一次强制同步布局，这是可以被真跑出来、被数出来的行为。
//
// 每条用例都刻意先断言"首次调用确实做了事"，否则"什么都不做的实现"也能变绿。

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.mjs';
import { installChrome, restoreChrome } from './helpers/chrome-stub.mjs';

let seq = 0;

/** 起一份全新 chat.js 实例并打开面板（模块级状态由 cache-busting 的 query 隔离）。 */
async function boot() {
  const dom = installDomStub();
  const prevChrome = installChrome({});
  const mod = await import('../lib/page/chat.js?layout-guard=' + (seq += 1));
  mod.initAssistant();
  const host = () => dom.document.documentElement.querySelector('#__kb-ai-host');
  const shadow = () => (host() ? host().shadowRoot : null);
  const panel = () => (shadow() ? shadow().querySelector('.panel') : null);
  const body = () => (panel() ? panel().querySelector('.p-body') : null);
  const cmdInput = () => (shadow() ? shadow().querySelector('.cmd-input') : null);
  dom.document.emit('keydown', { altKey: true, shiftKey: true, code: 'KeyR', key: 'R', repeat: false });
  return {
    dom,
    mod,
    panel,
    body,
    cmdInput,
    close() {
      dom.restore();
      restoreChrome(prevChrome);
    },
  };
}

const emptyCounter = () => ({ scrollHeight: 0, offsetHeight: 0, rect: 0 });
const totalReads = (c) => c.scrollHeight + c.offsetHeight + c.rect;

/**
 * 把 el 的几何量换成**计数 getter**：既控住返回值，又统计被测代码读了几次。
 *
 * 默认返回"超大内容高度"是刻意的：正文高于可用高度 ⇒ fitPanelHeight 会判定面板已饱和，
 * 这正是复用快路径生效的前提（详见 lib/page/chat.js 里该函数头部的注释）。
 */
function watchGeometry(el, counter, opts = {}) {
  const fake = {
    scrollHeight: opts.scrollHeight === undefined ? 100000 : opts.scrollHeight,
    offsetHeight: opts.offsetHeight === undefined ? 40 : opts.offsetHeight,
  };
  for (const key of ['scrollHeight', 'offsetHeight']) {
    Object.defineProperty(el, key, {
      configurable: true,
      get() {
        counter[key] += 1;
        return fake[key];
      },
    });
  }
  el.getBoundingClientRect = () => {
    counter.rect += 1;
    return { left: 0, top: 0, right: 320, bottom: 480, width: 320, height: 480, x: 0, y: 0 };
  };
}

/** 重新给整棵面板挂上计数器（每次调用前重来，保证只数这一次的读取）。 */
function instrument(app) {
  const panel = app.panel();
  const body = app.body();
  const panelRead = emptyCounter();
  const bodyRead = emptyCounter();
  watchGeometry(panel, panelRead);
  watchGeometry(body, bodyRead);
  for (const child of panel.children) {
    if (child !== body) watchGeometry(child, panelRead, { offsetHeight: 40 });
  }
  return {
    panel,
    body,
    reads: () => totalReads(panelRead) + totalReads(bodyRead),
  };
}

test('置底：不得为了算目标位置去读几何量（退化实现会读一次 scrollHeight）', async () => {
  const app = await boot();
  try {
    const body = app.body();
    assert.ok(body, '面板正文容器应在打开面板后就位（否则这条用例在测空气）');
    body.scrollTop = 0;
    const read = emptyCounter();
    watchGeometry(body, read);

    assert.equal(app.mod.pinToBottom(), true, '默认处于跟随状态时置底应生效');
    assert.equal(totalReads(read), 0, 'pinToBottom 读了几何量 —— 置底应写成会被浏览器夹紧的哨兵值');
    assert.ok(body.scrollTop > 0, '置底后 scrollTop 必须真的被写成会夹到底部的值');
  } finally {
    app.close();
  }
});

test('fitPanelHeight：面板已饱和且 chrome 未变时，第二次调用一次几何量都不读', async () => {
  const app = await boot();
  try {
    const first = instrument(app);
    app.mod.fitPanelHeight();
    assert.ok(first.reads() > 0, '首次调用必须真的做一次测量（否则这条用例在测空实现）');

    const second = instrument(app);
    app.mod.fitPanelHeight();
    assert.equal(
      second.reads(),
      0,
      '输入没变却重测了一遍 chrome —— 那等于每帧把正文按"不被裁切"再排一次（见该函数快路径的说明）'
    );
  } finally {
    app.close();
  }
});

test('fitPanelHeight：跳过重测时仍然要置底（不许顺手把置底也省掉）', async () => {
  const app = await boot();
  try {
    const first = instrument(app);
    app.mod.fitPanelHeight(); // 第一次：真实测量
    assert.ok(first.body.scrollTop > 0, '首次 fitPanelHeight 应把正文贴到底部');

    first.body.scrollTop = 0;
    const second = instrument(app);
    app.mod.fitPanelHeight(); // 第二次：走快路径
    assert.ok(second.body.scrollTop > 0, '快路径必须照样补置底 —— 否则用户看到的最后几个字会停在屏幕外');
  } finally {
    app.close();
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('fitPanelHeight：TTL 到期必须重新测量（快路径不许把 TTL 续期）', async () => {
  const app = await boot();
  try {
    // 复刻评审附件 ttl-probe.mjs 的时序：**每 ~100ms 命中一次快路径**，
    // 跑满 1.2 秒。若快路径顺手把"上次测量时间"续期成"本次命中时间"，
    // 那整轮只会测量 1 次 —— 签名漏判的高度变化就会一直错下去，不会自愈。
    // 正确实现应当每 500ms 至少真实测量一次 ⇒ 1.2s 内 ≥ 2 次。
    const readsPerCall = [];
    for (let i = 0; i < 12; i += 1) {
      const probe = instrument(app);
      app.mod.fitPanelHeight();
      readsPerCall.push(probe.reads());
      await sleep(100);
    }
    const measured = readsPerCall.filter((n) => n > 0).length;
    assert.ok(
      measured >= 2,
      '1.2 秒内只真实测量了 ' + measured + ' 次（共 ' + readsPerCall.length + ' 次调用） —— ' +
        '快路径把 TTL 续期了，500ms 兜底形同不存在（见 CHROME_MEASURE_TTL_MS 的说明）'
    );
    assert.ok(
      measured < readsPerCall.length,
      '每次调用都真实测量 ⇒ 复用快路径根本没生效，这条快路径也就没有存在意义'
    );
  } finally {
    app.close();
  }
});

test('fitPanelHeight：输入框被输入撑高必须让签名失效（textarea 的 value 不在 textContent 里）', async () => {
  const app = await boot();
  try {
    instrument(app);
    app.mod.fitPanelHeight(); // 先让缓存就位

    const input = app.cmdInput();
    assert.ok(input, '面板输入框应就位（否则这条用例在测空气）');
    // 模拟流式期间用户在输入框里打字：input 事件会把 textarea 从 34px 撑到最多 120px，
    // 而 `<textarea>` 的当前值**不在 textContent 里** —— 只看 textContent.length 的签名会漏判。
    input.value = '这是一段会让输入框换行变高的指令，'.repeat(6);

    const after = instrument(app);
    app.mod.fitPanelHeight();
    assert.ok(
      after.reads() > 0,
      '输入框变高了却还在复用旧测量 —— 面板总高不跟着涨，底部会被 `.panel { overflow:hidden }` 裁掉'
    );
  } finally {
    app.close();
  }
});

test('fitPanelHeight：视口变化必须让缓存失效（不是永久跳过）', async () => {
  const app = await boot();
  try {
    instrument(app);
    app.mod.fitPanelHeight();

    const after = instrument(app);
    globalThis.window.innerHeight = 801; // 视口变了 ⇒ maxH / dockGap 都跟着变，结论可能不同
    app.mod.fitPanelHeight();
    assert.ok(after.reads() > 0, '视口变了却还在用上一次的测量 —— 那会把面板尺寸算错');
  } finally {
    app.close();
  }
});

// FAB（悬浮气泡）收起 / 展开的行为测试（TITA-36）。
//
// ## 需求
//
// 面板关闭（默认态）时气泡贴住视口右缘、只露出一条边；鼠标悬浮（或键盘聚焦）时
// 整颗平滑滑出；点它照样能开面板。
//
// ## 为什么这样测
//
// 「收起」画的是 CSS（`.fab.peek` 的 `right`），「什么时候收起」是状态机
// （`resolveFabPeek`）。只测前者会得到"CSS 里有这行字"的假信心；只测后者
// 又证明不了气泡真的只露出一点点。所以两边都钉：
//   · 行为：真 import chat.js，在 DOM 桩上派发 pointerenter / focus / pointerdown，
//     断言 class 真的变了；
//   · 结构：解析 PANEL_CSS，断言收起后的 `right` 等于「直径 − 露出宽度」，
//     以及 `right` 在过渡列表里（漏了它 = 悬浮时瞬间跳出来，验收标准 2 直接不过）。
// 结构断言那几条按 L-25 配了「坏样本必须被抓到」的自检用例。
import test from 'node:test';
import assert from 'node:assert/strict';

import { PANEL_CSS } from '../lib/page/panel-css.ts';
import { installDomStub } from './helpers/dom-stub.mjs';
import { installChrome, restoreChrome } from './helpers/chrome-stub.mjs';

let seq = 0;

/** 起一份全新的 chat.js 实例（模块级状态互相隔离 —— 见 chat-panel-smoke 的说明）。 */
async function boot() {
  const dom = installDomStub();
  const prevChrome = installChrome();
  const mod = await import('../lib/page/chat.ts?case=peek' + (seq += 1));
  mod.initAssistant();
  const shadow = () => {
    const host = dom.document.documentElement.querySelector('#__kb-ai-host');
    return host ? host.shadowRoot : null;
  };
  const fab = () => {
    const s = shadow();
    return s ? s.querySelector('.fab') : null;
  };
  const panel = () => {
    const s = shadow();
    return s ? s.querySelector('.panel') : null;
  };
  const shortcut = () =>
    dom.document.emit('keydown', { altKey: true, shiftKey: true, code: 'KeyR', key: 'R', repeat: false });
  return { dom, mod, fab, panel, shortcut, close() { dom.restore(); restoreChrome(prevChrome); } };
}

const isPeeked = (app) => app.fab().classList.contains('peek');

// ---------------------------------------------------------------- CSS 结构
//
// ⚠ 这里必须**自己解析**而不是一条正则：`.fab.peek` 在四条 @media 上下文里各出现一次，
// 一条 `/\.fab\.peek\s*\{([^}]*)\}/` 只会命中第一条 —— 于是「窄屏下露出宽度错了」
// 这种回归永远是绿的。检测器没有牙齿，门禁就等于不存在。

/**
 * 剥掉 CSS 注释。
 *
 * 不剥不行：`.fab.peek` 上方那条说明性注释会粘进选择器，变成
 * `/* … *\/ .fab.peek`，于是「基础上下文有几条 .fab.peek」这类断言永远拿不到 ——
 * 而且不报错。这是「检测器被自己的输入骗了」的最常见形态。
 */
function stripCssComments(css) {
  return String(css).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 把 CSS 摊平成 (媒体条件链, 选择器) → 声明体。够用即可：普通规则 + 可嵌套的 @media。 */
function flattenCss(css, media = []) {
  const out = [];
  let i = 0;
  const src = stripCssComments(css);
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const head = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') depth -= 1;
      j += 1;
    }
    const body = src.slice(open + 1, j - 1);
    if (head.startsWith('@media')) out.push(...flattenCss(body, media.concat(head.replace(/^@media\s+/, ''))));
    else if (head) for (const sel of head.split(',')) out.push({ media: media.slice(), selector: sel.trim(), body });
    i = j;
  }
  return out;
}

/** 取声明值（`transition` 这种逗号分隔的可能被上面的 split(',') 切开，故按整段查）。 */
function declOf(body, prop) {
  const m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:([^;]*)').exec(String(body));
  return m ? m[1].trim() : null;
}

/** 找出「选择器 = selector，且媒体条件链里包含 needle（needle 为空 = 无媒体条件）」的块。 */
function rulesFor(selector, needle) {
  const blocks = flattenCss(PANEL_CSS);
  return blocks.filter((b) => {
    if (b.selector !== selector) return false;
    if (needle == null) return b.media.length === 0;
    return b.media.some((m) => m.includes(needle));
  });
}

test('CSS：收起态把整个气泡推出视口，只留 FAB_PEEK_VISIBLE 那么宽', async () => {
  const { FAB_PEEK_VISIBLE } = await import('../lib/page/fab-position.ts');
  const base = rulesFor('.fab.peek', null);
  assert.equal(base.length, 1, '`.fab.peek` 的基础规则应当只有一条（多了会被后面的覆盖）');
  // 宽屏气泡直径 52（见 `.fab` 的 width），收起后 right = -(52 - 12) = -40
  assert.equal(declOf(base[0].body, 'right'), '-' + (52 - FAB_PEEK_VISIBLE) + 'px',
    '收起态 right 必须等于「直径 − 露出宽度」，否则要么露太多要么露不着');
  assert.ok(FAB_PEEK_VISIBLE > 0 && FAB_PEEK_VISIBLE < 52 / 2,
    '露出宽度必须明显小于气泡宽度（验收标准 1），当前 ' + FAB_PEEK_VISIBLE);
});

test('CSS：窄屏（≤600px，气泡 46px）收起后同样只露 FAB_PEEK_VISIBLE', async () => {
  const { FAB_PEEK_VISIBLE } = await import('../lib/page/fab-position.ts');
  const narrow = rulesFor('.fab.peek', '(max-width: 600px)').filter((b) => !b.media.some((m) => m.includes('hover')));
  assert.equal(narrow.length, 1, '窄屏必须单独覆盖收起偏移（气泡更小，沿用宽屏会露不着）');
  assert.equal(declOf(narrow[0].body, 'right'), '-' + (46 - FAB_PEEK_VISIBLE) + 'px');
});

test('CSS：没有 hover 能力（触屏）的设备取消收起 —— 否则 12px 点不到', () => {
  const noHover = rulesFor('.fab.peek', '(hover: none)');
  assert.ok(noHover.length >= 1, '触屏必须取消收起：没有 hover 事件，收起后唤不回来');
  for (const b of noHover) {
    assert.doesNotMatch(declOf(b.body, 'right') || '', /^-\d/,
      '触屏下 right 不该再是负值：' + declOf(b.body, 'right'));
  }
});

test('CSS：过渡里必须有 right —— 滑出是"滑"，不是"跳"（验收标准 2）', () => {
  const fab = rulesFor('.fab', null);
  assert.equal(fab.length, 1);
  const transition = declOf(fab[0].body, 'transition') || '';
  assert.match(transition, /(^|[\s,])right\s/, '.fab 的 transition 缺少 right：悬浮瞬间会跳变');
});

test('自检：上面那套 CSS 检测器有牙齿（坏样本必须被抓到，否则它就是恒真的）', () => {
  // 反证一：把 `.fab.peek` 整条删掉，检测器应当一条都找不到。
  assert.equal(flattenCss('.fab { right: 16px; }').filter((b) => b.selector === '.fab.peek').length, 0);
  // 反证二：`.fab.peek` 写在 @media 里时，media 条件必须被带上 ——
  // 否则「基础上下文」的查询会把媒体查询里的那条也算进去，窄屏那条断言就成了空话。
  const nested = flattenCss('@media (max-width: 600px) { .fab.peek { right: -34px; } }');
  assert.equal(nested.length, 1);
  assert.deepEqual(nested[0].media, ['(max-width: 600px)'], '媒体条件必须沿作用域链传下去');
  assert.equal(rulesFor('.fab.peek', null).length, 1, '真实 CSS 里基础上下文只有一条（带 media 的不能被算进来）');
  // 反证三：声明值解析要能区分 `right` 与 `padding-right` 之类同后缀属性。
  assert.equal(declOf('padding-right: 3px; right: -40px;', 'right'), '-40px');
});

// ---------------------------------------------------------------- 行为

test('默认态（面板关闭）：气泡带 peek，即只露出一条边', async () => {
  const app = await boot();
  try {
    const fab = app.fab();
    assert.ok(fab, '前提：FAB 已建出来');
    assert.ok(fab.classList.contains('peek'), '面板关着时气泡应处于收起态');
  } finally {
    app.close();
  }
});

test('悬浮：整颗滑出（去掉 peek）；鼠标移开后回到收起态', async () => {
  const app = await boot();
  try {
    const fab = app.fab();
    assert.ok(isPeeked(app), '前提：初始收起');
    fab.emit('pointerenter', {});
    assert.ok(!isPeeked(app), '鼠标进到气泡上就必须整颗显示出来');
    // 收起的判据是坐标，不是 pointerleave（见 isPointerInFabZone）：
    // 鼠标移到页面中间 ⇒ 离开气泡地盘 ⇒ 收起。
    app.dom.document.emit('pointermove', { clientX: 80, clientY: 20 });
    assert.ok(isPeeked(app), '鼠标移开后应回到收起态');
  } finally {
    app.close();
  }
});

test('气泡向左滑走时鼠标仍压在露出条上 ⇒ 不收起（否则原地来回抖）', async () => {
  const app = await boot();
  try {
    const fab = app.fab();
    const vw = app.dom.window.innerWidth;
    const rect = fab.getBoundingClientRect();
    fab.emit('pointerenter', {});
    assert.ok(!isPeeked(app), '前提：鼠标进来后已展开');
    // 真实浏览器里，气泡滑出鼠标底下会**立刻**派发一次 pointerleave。
    // 这时候鼠标其实还压在「收起时露出的那条边」上 —— 必须当作没移开。
    fab.emit('pointerleave', { clientX: vw - 6, clientY: rect.top + rect.height / 2 });
    app.dom.document.emit('pointermove', { clientX: vw - 6, clientY: rect.top + rect.height / 2 });
    assert.ok(!isPeeked(app), '鼠标还在露出条上 ⇒ 保持展开');
    // 真正移开 ⇒ 收起
    app.dom.document.emit('pointermove', { clientX: 80, clientY: 20 });
    assert.ok(isPeeked(app), '鼠标真正移开 ⇒ 回到收起态');
  } finally {
    app.close();
  }
});

test('键盘聚焦（Tab 到气泡）也要整颗显示，失焦后收起', async () => {
  const app = await boot();
  try {
    const fab = app.fab();
    fab.emit('focus', {});
    assert.ok(!isPeeked(app), '键盘用户看不到"悬浮"，聚焦时必须展开');
    fab.emit('blur', {});
    assert.ok(isPeeked(app), '失焦后回到收起态');
  } finally {
    app.close();
  }
});

test('拖拽期间保持整颗显示（松手且移开后才收起）', async () => {
  const app = await boot();
  try {
    const fab = app.fab();
    assert.ok(isPeeked(app), '前提：没悬浮时是收起态');
    fab.emit('pointerdown', { button: 0, isPrimary: true, pointerId: 7, clientY: 300 });
    assert.ok(!isPeeked(app), '按住拖拽时气泡缩回去 = 抓不住，这条直接是手感问题');
    fab.emit('pointerup', { pointerId: 7, clientY: 300 });
    assert.ok(isPeeked(app), '松手且鼠标不在气泡上 ⇒ 回到收起态');
  } finally {
    app.close();
  }
});

test('点气泡仍能打开面板；面板开着时气泡不收起', async () => {
  const app = await boot();
  try {
    app.fab().emit('click', {});
    assert.ok(app.panel(), '点击 FAB 必须能打开面板（收起态不能把点击也收没了）');
    assert.ok(app.fab().classList.contains('hidden'), '面板打开时 FAB 让位（既有行为，本次不改）');
    assert.ok(!isPeeked(app), '面板打开期间气泡保持完整显示，不与面板抢视觉（验收标准 3）');
  } finally {
    app.close();
  }
});

test('快捷键 Alt+Shift+R 打开面板时同样不收起', async () => {
  const app = await boot();
  try {
    app.shortcut();
    assert.ok(app.panel(), '前提：快捷键打开了面板');
    assert.ok(!isPeeked(app), '快捷键路径与 FAB 路径必须一致（验收标准 4：所有路径收敛）');
  } finally {
    app.close();
  }
});

test('面板关掉后回到收起态', async () => {
  const app = await boot();
  try {
    app.shortcut();
    const panel = app.panel();
    assert.ok(panel, '前提：面板已打开');
    panel.querySelector('.close').emit('click', {});
    assert.equal(app.panel(), null, '前提：面板已关闭');
    assert.ok(isPeeked(app), '面板关掉后气泡应回到收起态');
  } finally {
    app.close();
  }
});

test('面板打开期间清空悬浮/聚焦：关掉后不会卡在「整颗显示」', async () => {
  const app = await boot();
  try {
    const fab = app.fab();
    fab.emit('pointerenter', {});
    fab.emit('focus', {});
    assert.ok(!isPeeked(app), '前提：悬浮/聚焦时展开');
    app.shortcut();
    const panel = app.panel();
    assert.ok(panel, '前提：面板已打开');
    panel.querySelector('.close').emit('click', {});
    // 面板开着时气泡是 hidden，悬浮/聚焦不可能再更新；若不清空，
    // 关掉面板后气泡会因为「上次悬浮过」而一直整颗露在外面 —— 这就是要防的。
    assert.ok(isPeeked(app), '面板关掉后回到收起态');
    // 鼠标再度压上来 ⇒ 展开（与冷启动口径一致）
    fab.emit('pointerenter', {});
    assert.ok(!isPeeked(app), '再次悬浮仍然展开');
  } finally {
    app.close();
  }
});

test('L-11 红线：收起 / 展开是视图态，一个字节都不落盘', async () => {
  const app = await boot();
  try {
    const fab = app.fab();
    // 先让 initAssistant 里那条异步的 loadFabPosition() 走完，
    // 否则"悬浮前后写入次数没变"会把它自己的初始化写盘算进来，测的就不是悬浮了。
    await new Promise((r) => setTimeout(r, 10));
    const stats = globalThis.chrome._stats;
    const snap = () => ({
      set: stats.set,
      remove: stats.remove,
      setKeys: JSON.stringify(stats.setKeys),
      localKeys: (() => {
        const out = [];
        for (let i = 0; i < globalThis.localStorage.length; i++) out.push(globalThis.localStorage.key(i));
        return out.sort();
      })(),
    });
    const before = snap();
    for (let i = 0; i < 5; i++) {
      fab.emit('pointerenter', {});
      fab.emit('pointerleave', {});
    }
    assert.deepEqual(snap(), before,
      '悬浮 / 收起不得产生任何写入 —— 写进存档就会盖住调用方意图（docked 语义），那是 TITA-9 第 2 轮的退回项');
  } finally {
    app.close();
  }
});

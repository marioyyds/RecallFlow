// 真实浏览器验收：面板「关掉再开」的位置持久化。
//
// 为什么留一个独立脚本而不是只写单测：
//   单测跑在 DOM 桩上，桩里的 getBoundingClientRect / shadow root / 快捷键派发都是我们
//   自己拼的 —— 它能证明逻辑分支对，但证明不了"真实 Chromium 里换个入口打开面板，
//   位置真的还在"。这条 bug 原始报告就是"用起来位置乱跑"，只能在真浏览器里钉。
//
// 覆盖：
//   A 冷启动：默认停靠，且落盘（docked:true）
//   B 拖动 → ✕ 关闭 → 悬浮球重开：位置/尺寸保持，仍停靠
//   C Esc 关闭：与 ✕ 同一路径，位置同样落盘
//   D 评审退回项：存档是 docked:false（上次气泡关的）时按 Alt+Shift+R，仍是停靠面板
//   E 视口变小后重开：位置被夹回可视区，不会露在屏幕外
//
// 用法：node repro/panel-pos.mjs        （需要已安装 Playwright 的 Chromium）
// 退出码：0 全过；1 有失败；2 环境缺依赖。
import { launchExtension, closeExtension, openFixturePage, openPanel } from '../tests/e2e/helpers.mjs';

const POS_KEY = 'recallflow-panel-pos';
const SIZE_KEY = 'recallflow-panel-size';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
}

function near(a, b, tol = 1) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
}

async function panelState(page) {
  return await page.evaluate(() => {
    const host = document.getElementById('__kb-ai-host');
    const panel = host && host.shadowRoot && host.shadowRoot.querySelector('.panel');
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    return {
      docked: panel.classList.contains('docked'),
      left: panel.style.left,
      top: panel.style.top,
      rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    };
  });
}

// 面板是「先挂出来、再摆位」的：openPanel 返回后还会有一小段布局收敛（CSS 应用 +
// fitPanelHeight）。读得太早会读到默认尺寸，那会把「已经修好」误判成失败 —— 所以等
// 两次采样的矩形一致再断言（真实用户看到的也是收敛后的位置）。
async function settled(page, timeout = 2500) {
  const deadline = Date.now() + timeout;
  let prev = null;
  while (Date.now() < deadline) {
    const s = await panelState(page);
    const key = s && JSON.stringify(s.rect) + '|' + s.left + '|' + s.top;
    if (s && prev === key) return s;
    prev = key;
    await page.waitForTimeout(120);
  }
  return await panelState(page);
}

async function saved(page) {
  return await page.evaluate((keys) => ({
    pos: JSON.parse(localStorage.getItem(keys.pos) || 'null'),
    size: JSON.parse(localStorage.getItem(keys.size) || 'null'),
  }), { pos: POS_KEY, size: SIZE_KEY });
}

async function seed(page, pos, size) {
  await page.evaluate((a) => {
    if (a.pos) localStorage.setItem(a.keys.pos, JSON.stringify(a.pos));
    else localStorage.removeItem(a.keys.pos);
    if (a.size) localStorage.setItem(a.keys.size, JSON.stringify(a.size));
    else localStorage.removeItem(a.keys.size);
  }, { pos, size, keys: { pos: POS_KEY, size: SIZE_KEY } });
}

async function closeVia(page, how) {
  if (how === 'esc') {
    await page.keyboard.press('Escape');
  } else {
    await page.locator('.panel .close').click();
  }
  await page.waitForFunction(() => {
    const host = document.getElementById('__kb-ai-host');
    return !(host && host.shadowRoot && host.shadowRoot.querySelector('.panel'));
  }, null, { timeout: 5000 });
}

async function drag(page, dx, dy) {
  const head = page.locator('.panel .p-head');
  const box = await head.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 60 + dx, box.y + 12 + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(120);
}

let context;
try {
  context = await launchExtension();
} catch (e) {
  console.error('无法启动浏览器/扩展：' + (e && e.message));
  process.exit(2);
}

try {
  const page = await openFixturePage(context);

  // ---- A 冷启动 -------------------------------------------------------
  await page.evaluate((keys) => { localStorage.removeItem(keys.pos); localStorage.removeItem(keys.size); },
    { pos: POS_KEY, size: SIZE_KEY });
  await page.reload();
  await openPanel(page);
  const a = await settled(page);
  const aSaved = await saved(page);
  check('A1 冷启动默认停靠', a && a.docked === true, JSON.stringify(a));
  check('A2 冷启动落盘 docked:true', aSaved.pos && aSaved.pos.docked === true, JSON.stringify(aSaved.pos));

  // ---- B 拖动 → ✕ → 重开 ---------------------------------------------
  await drag(page, 140, 90);
  const bMoved = await panelState(page);
  await closeVia(page, 'close');
  const bSaved = await saved(page);
  check('B1 关闭时位置落盘', near(bSaved.pos && bSaved.pos.left, bMoved.rect.left, 2) && near(bSaved.pos && bSaved.pos.top, bMoved.rect.top, 2),
    'saved=' + JSON.stringify(bSaved.pos) + ' rect=' + JSON.stringify(bMoved.rect));

  await openPanel(page);
  const bReopen = await settled(page);
  check('B2 重开后回到关闭前的位置', bReopen && near(bReopen.rect.left, bMoved.rect.left, 2) && near(bReopen.rect.top, bMoved.rect.top, 2),
    'before=' + JSON.stringify(bMoved.rect) + ' after=' + JSON.stringify(bReopen && bReopen.rect));
  check('B3 重开后仍停靠（快捷键/FAB 的意图）', bReopen && bReopen.docked === true);

  // ---- C Esc 关闭 -----------------------------------------------------
  await drag(page, -70, 40);
  const cMoved = await panelState(page);
  await closeVia(page, 'esc');
  const cSaved = await saved(page);
  check('C1 Esc 关闭也落盘', near(cSaved.pos && cSaved.pos.left, cMoved.rect.left, 2) && near(cSaved.pos && cSaved.pos.top, cMoved.rect.top, 2),
    'saved=' + JSON.stringify(cSaved.pos) + ' rect=' + JSON.stringify(cMoved.rect));

  // ---- D 存档 docked:false + 快捷键 ------------------------------------
  await page.evaluate((pos) => { localStorage.removeItem('recallflow-panel-pos'); localStorage.setItem('recallflow-panel-pos', JSON.stringify(pos)); },
    { version: 2, docked: false, left: 300, top: 140 });
  await page.keyboard.press('Alt+Shift+R');
  const d = await settled(page);
  check('D1 存档说浮动，快捷键打开仍是停靠', d && d.docked === true, JSON.stringify(d));
  check('D2 但位置从存档恢复', d && near(d.rect.left, 300, 2) && near(d.rect.top, 140, 2), JSON.stringify(d && d.rect));

  // ---- E 视口变小 ------------------------------------------------------
  await page.evaluate((pos) => { localStorage.setItem('recallflow-panel-pos', JSON.stringify(pos)); },
    { version: 2, docked: false, left: 5000, top: 5000 });
  await closeVia(page, 'esc');
  await page.setViewportSize({ width: 900, height: 620 });
  await openPanel(page);
  const e = await settled(page);
  const vp = page.viewportSize();
  check('E1 位置被夹回可视区', e && e.rect.left + e.rect.width <= vp.width + 1 && e.rect.top >= -1 && e.rect.top + e.rect.height <= vp.height + 1,
    'rect=' + JSON.stringify(e && e.rect) + ' vp=' + JSON.stringify(vp));

  await page.close();
} finally {
  await closeExtension(context);
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.name).join('、'));
  process.exit(1);
}

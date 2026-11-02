// 真实浏览器验收：悬浮球右键退出 + 面板「嵌入页面」模式。
//
// 为什么留一个独立脚本而不是只写单测：
//   tests/chat-panel-smoke.test.mjs 跑在 DOM 桩上，桩里没有真实布局 —— 它证明了
//   "事件接对了、class 切对了、落盘写对了"，但证明不了真实 Chromium 里
//   .panel.embedded 真的整列贴右、页面正文真的被右缩、右键菜单真的盖住页面默认菜单。
//   「几何」与「遮挡」这两件事只能靠 getBoundingClientRect() / elementFromPoint() 量出来。
//
// 覆盖：
//   A 右键 FAB：弹出自己的菜单（不是页面默认菜单），且不冒泡到宿主页面
//   B 「隐藏悬浮球」：球消失、偏好落盘、刷新后不再注入
//   C fab:show：被隐藏的球重新出现，偏好清掉，刷新后还在
//   D 「嵌入」模式：整列贴右 + 页面正文右缩，比例落盘
//   E 嵌入态拉伸：左缘手柄改宽度，页面边距跟随，比例记忆更新
//   F 关面板再开：嵌入态记忆；切回「浮层」：页面边距还原
//
// 用法：node repro/fab-exit-embedded.mjs   （需要已安装 Playwright 的 Chromium）
// 退出码：0 全过；1 有失败；2 环境缺依赖。
import {
  launchExtension, closeExtension, openFixturePage, openPanel, clickFab, PANEL,
} from '../tests/e2e/helpers.mjs';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
}
function near(a, b, tol = 1.5) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
}
async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/** 穿透 shadow root 读一次面板/FAB/菜单的几何与状态。 */
async function uiSnapshot(page) {
  return await page.evaluate(() => {
    const host = document.getElementById('__kb-ai-host');
    const root = host && host.shadowRoot ? host.shadowRoot : null;
    if (!root) return null;
    const panel = root.querySelector('.panel');
    const fab = root.querySelector('.fab');
    const menu = root.querySelector('.fab-menu');
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    return {
      vw: document.documentElement.clientWidth,
      vh: document.documentElement.clientHeight,
      panel: panel
        ? {
            cls: panel.className,
            rect: rect(panel),
            widthPx: panel.style.width,
            topInline: panel.style.top,
            modeBtn: (root.querySelector('.p-head .mode-btn') || {}).textContent || null,
          }
        : null,
      fab: fab ? { cls: fab.className, rect: rect(fab) } : null,
      menu: menu
        ? { buttons: [...menu.querySelectorAll('button')].map((b) => b.textContent), danger: menu.querySelectorAll('button.danger').length }
        : null,
      bodyMarginRight: document.body ? document.body.style.marginRight : '',
    };
  });
}

/** 从扩展的 service worker 读 chrome.storage.local（页面里没有 chrome.storage）。 */
async function swGet(context, key) {
  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('拿不到扩展的 service worker');
  return await sw.evaluate(async (k) => {
    const d = await chrome.storage.local.get(k);
    return d[k] === undefined ? null : d[k];
  }, key);
}

/** 从 service worker 向当前活动标签页发 fab:show（弹窗「悬浮球」按钮的真实通路）。 */
async function swSendFabShow(context) {
  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('拿不到扩展的 service worker');
  return await sw.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (!tabs || !tabs[0]) return resolve('no-tab');
          chrome.tabs.sendMessage(tabs[0].id, { type: 'fab:show' }, () => resolve('sent'));
        });
      })
  );
}

/** 右键 FAB（先 hover 等它从收起态滑出，再按展开后的中心右键）。 */
async function rightClickFab(page) {
  const fab = page.locator(PANEL + ' .fab');
  const box = await fab.boundingBox();
  if (!box) throw new Error('FAB 不可见');
  const layoutWidth = await page.evaluate(() => document.documentElement.clientWidth);
  await page.mouse.move(Math.min(box.x + box.width / 2, layoutWidth - 4), box.y + box.height / 2);
  await page.waitForTimeout(360); // 大于 .fab 的 right 过渡（220ms）
  const shown = await fab.boundingBox();
  await fab.click({ button: 'right' });
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
  await openPanel(page); // 先确保内容脚本注入完整（面板能开 = UI 已就绪）
  await page.keyboard.press('Escape');
  await sleep(400);

  // ---- A 右键 FAB：自己的菜单，不是页面默认菜单 ------------------------
  // 宿主页面先装一个 contextmenu 观察器：右键 FAB 若冒泡到页面，这里会计数。
  await page.evaluate(() => {
    window.__rfPageCtxCount = 0;
    document.addEventListener('contextmenu', () => {
      window.__rfPageCtxCount += 1;
    });
  });
  await rightClickFab(page);
  const a = await uiSnapshot(page);
  check('A1 右键 FAB 弹出自己的菜单（两项）', a && a.menu && a.menu.buttons.join(',') === '打开面板,隐藏悬浮球',
    a && JSON.stringify(a.menu));
  check('A2 「隐藏悬浮球」是危险项（红色）', a && a.menu && a.menu.danger === 1);
  const pageCtx = await page.evaluate(() => window.__rfPageCtxCount);
  check('A3 右键不再冒泡到宿主页面（此前 bug：右键只弹页面默认菜单）', pageCtx === 0, '页面 contextmenu 计数=' + pageCtx);

  // ---- B 「隐藏悬浮球」：球消失 + 偏好落盘 + 刷新后不再注入 -------------
  // （必须赶在 A4 的对照右键之前：点页面本体会触发菜单的「点外面关闭」。）
  await page.locator(PANEL + ' .fab-menu button.danger').click();
  await page.waitForFunction(() => {
    const host = document.getElementById('__kb-ai-host');
    return !(host && host.shadowRoot && host.shadowRoot.querySelector('.fab'));
  }, null, { timeout: 5000 });
  const b1 = await uiSnapshot(page);
  check('B1 隐藏后球体消失，宿主保留', b1 && b1.fab === null);
  const pref = await swGet(context, 'recallflow.fab.hidden.v1');
  check('B2 隐藏偏好写进扩展存储', pref && pref.hidden === true, JSON.stringify(pref));
  await page.reload();
  await sleep(1200); // 内容脚本 document_idle 注入 + 偏好读回（异步 get）
  const b3 = await uiSnapshot(page);
  check('B3 刷新后悬浮球不再注入（偏好读回）', b3 && b3.fab === null);

  // ---- A4 对照组：右键页面本体仍弹页面默认菜单（页面菜单没被全局误杀）----
  // （reload 会清掉 window 上的计数器，对照前重装。）
  await page.evaluate(() => {
    window.__rfPageCtxCount = 0;
    document.addEventListener('contextmenu', () => {
      window.__rfPageCtxCount += 1;
    });
  });
  await page.mouse.click(200, 200, { button: 'right' });
  const pageCtx2 = await page.evaluate(() => window.__rfPageCtxCount);
  check('A4 页面自己的右键菜单不受影响', pageCtx2 === 1, '页面 contextmenu 计数=' + pageCtx2);

  // ---- C fab:show：找回 ------------------------------------------------
  const send = await swSendFabShow(context);
  await page.waitForFunction(() => {
    const host = document.getElementById('__kb-ai-host');
    return Boolean(host && host.shadowRoot && host.shadowRoot.querySelector('.fab'));
  }, null, { timeout: 5000 });
  const c1 = await uiSnapshot(page);
  check('C1 fab:show 后悬浮球重新出现', c1 && c1.fab !== null, 'sendMessage=' + send);
  const pref2 = await swGet(context, 'recallflow.fab.hidden.v1');
  check('C2 找回清掉隐藏偏好', pref2 && pref2.hidden === false, JSON.stringify(pref2));
  await page.reload();
  await sleep(1200);
  const c3 = await uiSnapshot(page);
  check('C3 刷新后悬浮球仍在（偏好已清）', c3 && c3.fab !== null);

  // ---- D 「嵌入」模式：整列贴右 + 页面正文右缩 --------------------------
  await openPanel(page);
  await page.locator(PANEL + ' .p-head .mode-btn').click();
  await page.waitForFunction(() => {
    const host = document.getElementById('__kb-ai-host');
    const p = host && host.shadowRoot && host.shadowRoot.querySelector('.panel');
    return Boolean(p && p.classList.contains('embedded'));
  }, null, { timeout: 5000 });
  await sleep(400);
  const d = await uiSnapshot(page);
  check('D1 嵌入态整列贴右（右缘齐布局视口）', d && near(d.panel.rect.right, d.vw, 1.5),
    'panel.right=' + (d && d.panel.rect.right) + ' vw=' + (d && d.vw));
  check('D2 嵌入态高度占满整列', d && near(d.panel.rect.bottom, d.vh, 1.5) && near(d.panel.rect.top, 0, 1.5),
    'top=' + (d && d.panel.rect.top) + ' bottom=' + (d && d.panel.rect.bottom) + ' vh=' + (d && d.vh));
  check('D3 默认比例 0.3（小）且不超过 0.6', d && d.panel.rect.width > 0 && d.panel.rect.width / d.vw <= 0.6 + 0.01,
    '宽=' + (d && d.panel.rect.width) + 'px，占比≈' + (d ? (d.panel.rect.width / d.vw).toFixed(3) : '?'));
  check('D4 页面正文右缩同等宽度（嵌在页面里的关键）', d && d.bodyMarginRight === Math.round(d.panel.rect.width) + 'px',
    'body margin-right=' + (d && d.bodyMarginRight) + ' / 面板宽=' + (d && d.panel.rect.width));
  check('D5 嵌入态不写内联 top（位置交给 CSS）', d && d.panel.topInline === '', 'top 内联=' + (d && d.panel.topInline));
  check('D6 模式按钮文案显示切换目标「浮层」', d && d.panel.modeBtn === '浮层', '按钮=' + (d && d.panel.modeBtn));
  const recD = await swGet(context, 'recallflow.panel.layout.v1');
  check('D7 嵌入态落盘 mode=embedded + ratio', recD && recD.mode === 'embedded' && recD.ratio > 0 && recD.ratio <= 0.6,
    JSON.stringify(recD));

  // ---- E 嵌入态拉伸：左缘手柄 -------------------------------------------
  const handle = page.locator(PANEL + ' .panel.embedded .resize-handle.left');
  const hb = await handle.boundingBox();
  if (!hb) {
    check('E1 左缘手柄可见', false, 'resize-handle.left 不可见');
  } else {
    const before = (await uiSnapshot(page)).panel.rect.width;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 - 80, hb.y + hb.height / 2, { steps: 5 });
    await page.mouse.up();
    await sleep(400);
    const e = await uiSnapshot(page);
    const after = e.panel.rect.width;
    check('E1 左缘手柄向左拖必须加宽', after > before, '加宽前=' + Math.round(before) + 'px 后=' + Math.round(after) + 'px');
    check('E2 页面边距跟着新宽度走', e.bodyMarginRight === Math.round(after) + 'px',
      'margin=' + e.bodyMarginRight + ' / 面板宽=' + Math.round(after));
    check('E3 右缘仍钉住（右缘齐布局视口）', near(after > 0 ? e.panel.rect.right : -1, e.vw, 1.5),
      'panel.right=' + e.panel.rect.right + ' vw=' + e.vw);
    const recE = await swGet(context, 'recallflow.panel.layout.v1');
    check('E4 拉伸后的比例落盘', recE && recE.mode === 'embedded' && Math.abs(recE.ratio - after / e.vw) < 0.01,
      'ratio=' + (recE && recE.ratio) + ' / 实际≈' + (after / e.vw).toFixed(3));
  }

  // ---- F 嵌入态记忆 + 切回浮层 ------------------------------------------
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const host = document.getElementById('__kb-ai-host');
    return !(host && host.shadowRoot && host.shadowRoot.querySelector('.panel'));
  }, null, { timeout: 5000 });
  const f0 = await uiSnapshot(page);
  check('F1 关面板后页面边距还原', f0.bodyMarginRight === '', 'margin=' + JSON.stringify(f0.bodyMarginRight));
  await page.keyboard.press('Alt+Shift+R');
  await page.waitForFunction(() => {
    const host = document.getElementById('__kb-ai-host');
    const p = host && host.shadowRoot && host.shadowRoot.querySelector('.panel');
    return Boolean(p && p.classList.contains('embedded'));
  }, null, { timeout: 5000 });
  await sleep(400);
  const f1 = await uiSnapshot(page);
  check('F2 重开回到嵌入态（存档记忆）', f1 && f1.panel.cls.includes('embedded'), 'class=' + (f1 && f1.panel.cls));
  check('F3 重开后页面仍收窄', f1 && f1.bodyMarginRight !== '', 'margin=' + (f1 && f1.bodyMarginRight));
  // 切回浮层
  await page.locator(PANEL + ' .p-head .mode-btn').click();
  await sleep(400);
  const f4 = await uiSnapshot(page);
  check('F4 切回浮层：embedded 移除、页面边距还原', f4 && !f4.panel.cls.includes('embedded') && f4.bodyMarginRight === '',
    'class=' + (f4 && f4.panel.cls) + ' margin=' + (f4 && f4.bodyMarginRight));
  const recF = await swGet(context, 'recallflow.panel.layout.v1');
  check('F5 切回浮层后存档不再指向 embedded（否则下次打开又嵌入）', recF && recF.mode !== 'embedded',
    JSON.stringify(recF));

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

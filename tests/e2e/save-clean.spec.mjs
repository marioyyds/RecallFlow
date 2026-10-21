// 「另存为」出来的副本里不该出现 RecallFlow 的悬浮球。
//
// 这条用例的由来是一个真实故障：用户保存自己打开的本地 HTML，离线打开后看到一个点不动的
// RecallFlow 图标。根因是 **Edge/Chromium 的另存为会把 open shadow root 一起序列化**
// （存成声明式 shadow DOM `<template shadowrootmode="open">`），所以"图标在 shadow 里就安全"
// 这个假设是错的 —— 这不是理论推演，是在真实浏览器里 captureSnapshot 出来的。
//
// 现在的防线：宿主是自定义元素 `rf-ai-host`，由主世界脚本（lib/page/debug-hook.js）注册；
// 存档里没有我们的脚本 ⇒ 元素不会被升级 ⇒ 面板样式里的 `:host(:not(:defined))` 命中 ⇒ 整块 UI 隐藏。
// `:defined` 是**运行期状态**，不写进 HTML，因此这条判据对"怎么保存的"没有依赖。
//
// 这里刻意不用截图或颜色判断：**做两条断言 —— 实时页面必须看得见，存档副本必须 0×0**。
// 只测后者会漏掉"守卫把正常页面的悬浮球也藏了"这种更糟的失败。
import { test, expect } from '@playwright/test';
import { launchExtension, closeExtension, openFixturePage } from './helpers.mjs';

const HOST = '#__kb-ai-host';
const HOST_ID = '__kb-ai-host';

let context;

test.beforeAll(async () => {
  context = await launchExtension();
});

test.afterAll(async () => {
  await closeExtension(context);
});

test('实时页面：宿主已升级为自定义元素，悬浮球正常显示', async () => {
  const page = await openFixturePage(context);
  try {
    await expect(page.locator(HOST)).toHaveCount(1, { timeout: 10_000 });
    const live = await page.evaluate((sel) => {
      const host = document.getElementById(sel);
      const fab = host.shadowRoot && host.shadowRoot.querySelector('.fab');
      const r = fab && fab.getBoundingClientRect();
      return {
        tag: host.tagName,
        defined: host.matches(':defined'),
        display: getComputedStyle(host).display,
        width: r ? Math.round(r.width) : null,
      };
    }, HOST_ID);
    expect(live.tag, '宿主必须是自定义元素，否则存档里挡不住').toBe('RF-AI-HOST');
    expect(live.defined, '主世界脚本必须把它注册上，否则实时页面里 UI 会被门控藏掉').toBe(true);
    expect(live.display).not.toBe('none');
    expect(live.width).toBeGreaterThan(20);
  } finally {
    await page.close();
  }
});

test('存档副本：按「另存为」的形态重新打开，悬浮球必须不可见', async () => {
  const page = await openFixturePage(context);
  try {
    await expect(page.locator(HOST)).toHaveCount(1, { timeout: 10_000 });

    // 复刻浏览器的序列化结果：宿主 + 声明式 shadow root，**没有任何脚本**。
    // （实测 captureSnapshot 产物里就是这两样，连图标引用都在。）
    const archived = await page.evaluate((sel) => {
      const host = document.getElementById(sel);
      return { tag: host.tagName.toLowerCase(), html: host.shadowRoot.innerHTML };
    }, HOST_ID);
    expect(archived.html).toContain('recallflow-mark', '前提：存档里确实带着图标引用');
    const copy =
      '<!doctype html><html><body><p>copy</p>' +
      '<' + archived.tag + ' id="__kb-ai-host"><template shadowrootmode="open">' +
      archived.html +
      '</template></' + archived.tag + '></body></html>';

    const copyPage = await context.newPage();
    try {
      await copyPage.setContent(copy);
      const rendered = await copyPage.evaluate((sel) => {
        const host = document.getElementById(sel);
        const attached = Boolean(host && host.shadowRoot);
        const fab = attached ? host.shadowRoot.querySelector('.fab') : null;
        const r = fab && fab.getBoundingClientRect();
        return {
          attached,
          display: host ? getComputedStyle(host).display : null,
          width: r ? Math.round(r.width) : null,
        };
      }, HOST_ID);
      expect(rendered.attached, '前提：声明式 shadow DOM 在副本里确实被解析出来了').toBe(true);
      expect(rendered.display, '存档里宿主必须整块隐藏').toBe('none');
      expect(rendered.width, '悬浮球不能占任何可见面积').toBe(0);
    } finally {
      await copyPage.close();
    }
  } finally {
    await page.close();
  }
});

test('打开一份"带扩展残留"的存档副本：旧宿主被清掉，只剩新注入的那一个', async () => {
  // 旧副本（本功能上线前保存的那些）里会带着一个写死的宿主，打开它时内容脚本还会再注入一个 ——
  // 不清掉就会出现"一个点不动的旧图标 + 一个新悬浮球"。这条钉住"先清残渣再挂载"。
  await context.route('**/stale-archive.html', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body:
        '<!doctype html><html><body><p>archived</p>' +
        '<div id="__kb-ai-host"><span id="stale-mark">OLD</span></div></body></html>',
    })
  );
  const page = await openFixturePage(context, '/stale-archive.html');
  try {
    await expect(page.locator(HOST)).toHaveCount(1, { timeout: 10_000 });
    const info = await page.evaluate((id) => {
      const host = document.getElementById(id);
      return { tag: host.tagName, stale: !!document.getElementById('stale-mark') };
    }, HOST_ID);
    expect(info.stale, '写死的旧宿主必须被清掉').toBe(false);
    expect(info.tag).toBe('RF-AI-HOST');
  } finally {
    await page.close();
    await context.unroute('**/stale-archive.html');
  }
});

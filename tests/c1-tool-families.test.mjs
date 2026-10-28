// C-1 拆出的工具族：运行状态 / 权限会话 / 截图。
//
// 这些测试是"抽取"这一步的真正收益 —— 拆出模块后，`ctx`、`chrome`、`cdp` 都能换成假的，
// 于是计划条、结果分页、信任站点、截图归档这些语义第一次可以被直接断言。
//
// 其中最后一条是**回归测试**：把 `saveScreenshot` 移进 screenshot-tool.js 时，
// 它的签名多了 `chromeApi` 参数，而调用点一度没跟着传 —— 结果是**静默不落盘**
//（返回仍 ok:true，但图片永远取不回来）。这类"搬家时漏传一个依赖"的错误
// 不会报错、不会被 E2E 抓到，只能靠这种断言守住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { updatePlan, expandResult, getRunTrace, RUN_STATE_TOOLS, handleRunStateTool } from '../lib/application/agent/run-state-tools.ts';
import { trustSite, handleDialogTool, PERMISSION_TOOLS, handlePermissionTool } from '../lib/application/agent/permission-tools.ts';
import { takeScreenshot, saveScreenshot, MAX_SHOTS, SHOT_KEY, MAX_SHOT_STORE_CHARS } from '../lib/application/agent/screenshot-tool.ts';

// ---------------------------------------------------------------- 运行状态族

test('RUN_STATE_TOOLS 覆盖三个工具名', () => {
  assert.deepEqual([...RUN_STATE_TOOLS].sort(), ['expand_result', 'get_run_trace', 'update_plan']);
});

test('update_plan：写回 ctx.plan，过滤空文本、截断超长、校正非法状态', () => {
  const ctx = {};
  const r = updatePlan(ctx, {
    items: [
      { text: '  第一步  ', status: 'done' },
      { text: '', status: 'pending' },        // 空文本应被过滤
      { text: '   ', status: 'pending' },     // 纯空白同上
      { text: 'x'.repeat(200), status: '乱写' }, // 超长截断 + 非法状态回落 pending
      'not-an-object',
    ],
  });
  assert.equal(ctx.plan.length, 2);
  assert.equal(ctx.plan[0].text, '第一步', '应 trim');
  assert.equal(ctx.plan[0].status, 'done');
  assert.equal(ctx.plan[1].text.length, 120, '应截到 120 字');
  assert.equal(ctx.plan[1].status, 'pending', '非法状态应回落 pending');
  assert.match(r.result, /计划已更新（2 步）/);
  assert.match(r.result, /✓ 1\. 第一步/, 'done 用 ✓ 标记');
});

test('update_plan：最多 20 条，空计划也给可读文案', () => {
  const ctx = {};
  updatePlan(ctx, { items: Array.from({ length: 30 }, (_, i) => ({ text: 't' + i })) });
  assert.equal(ctx.plan.length, 20);
  const r = updatePlan({}, { items: [] });
  assert.match(r.result, /（空计划）/);
});

test('update_plan：非数组输入不抛', () => {
  for (const bad of [undefined, null, 'x', 42, {}]) {
    const ctx = {};
    assert.doesNotThrow(() => updatePlan(ctx, { items: bad }));
    assert.deepEqual(ctx.plan, []);
  }
});

test('expand_result：分段读取并标注区间与总长', () => {
  const text = 'abcdefghij';
  const ctx = { resultStore: { get: (id) => (id === 'res-1' ? text : null) } };
  // 注意 limit 会被夹到 **最小 200**（防止模型用极小分页把预算耗在往返上），
  // 因此这里读的是 [2, 10) 而不是 [2, 6)。
  const r = expandResult(ctx, { id: 'res-1', offset: 2, limit: 400 });
  assert.equal(r.ok, true);
  assert.match(r.result, /\[2,10\) \/ 共 10 字符/);
  assert.match(r.result, /cdefghij/);
});

test('expand_result：limit 被夹在 200..4000', () => {
  const text = 'x'.repeat(5000);
  const ctx = { resultStore: { get: () => text } };
  assert.match(expandResult(ctx, { id: 'a', limit: 1 }).result, /\[0,200\)/);
  assert.match(expandResult(ctx, { id: 'a', limit: 99999 }).result, /\[0,4000\)/);
});

test('expand_result：找不到结果时区分"上一轮已释放"与"id 写错"', () => {
  // 这两句话的差别很重要：只说"未找到"会让模型以为是自己记错 id 而反复重试。
  const released = expandResult({ resultIds: new Set(['res-9']) }, { id: 'res-9' });
  assert.equal(released.ok, false);
  assert.match(released.result, /上一轮运行/);

  const typo = expandResult({ resultIds: new Set() }, { id: 'res-404' });
  assert.match(typo.result, /请确认 id 是否正确/);
  assert.match(typo.result, /res-12/, '应给出 id 形状示例');
});

test('get_run_trace：把各类 phase 渲染成可读行', () => {
  const rec = {
    runId: 'run-1',
    entries: [
      { ts: Date.now(), phase: 'start', intent: 'BROWSER', instruction: '打开页面' },
      { ts: Date.now(), phase: 'tool', name: 'click_element', ok: true, ms: 12, args: '{}' },
      { ts: Date.now(), phase: 'complete', reason: 'done', totalTokens: 100 },
    ],
  };
  const r = getRunTrace({ getTrace: async () => rec, listTraces: async () => [rec] }, { runId: 'run-1' });
  return r.then((out) => {
    assert.equal(out.ok, true);
    assert.match(out.result, /运行轨迹 run-1（3 条）/);
    assert.match(out.result, /\[start\] intent=BROWSER/);
    assert.match(out.result, /\[tool\] click_element ✓ 12ms/);
    assert.match(out.result, /\[complete\] done tokens=100/);
  });
});

test('get_run_trace：无记录时返回提示而不是抛', async () => {
  const r = await getRunTrace({ getTrace: async () => null, listTraces: async () => [] }, {});
  assert.equal(r.ok, true);
  assert.match(r.result, /暂无运行轨迹/);
});

test('handleRunStateTool：不属于本族返回 null', async () => {
  assert.equal(await handleRunStateTool('click_element', {}, { ctx: {} }), null);
});

// ---------------------------------------------------------------- 权限 / 会话族

test('PERMISSION_TOOLS 覆盖两个工具名', () => {
  assert.deepEqual([...PERMISSION_TOOLS].sort(), ['handle_dialog', 'trust_site']);
});

test('trust_site：把 origin 写进 trustedSites 并落盘', async () => {
  let saved = null;
  const ctx = { pageUrl: 'https://a.test/path?q=1', settings: { trustedSites: ['https://b.test'] } };
  const r = await trustSite({
    ctx,
    chrome: { storage: { local: { set: async (o) => { saved = o; } } } },
  });
  assert.equal(r.ok, true);
  assert.match(r.result, /已信任站点 https:\/\/a\.test/);
  assert.deepEqual(ctx.settings.trustedSites, ['https://b.test', 'https://a.test'], '应追加而不是覆盖');
  assert.deepEqual(saved.aiSettings.trustedSites, ['https://b.test', 'https://a.test']);
  // 文案里必须保留"高风险工具仍每次确认"的承诺
  assert.match(r.result, /用户脚本 \/ 技能写入等高风险工具仍每次确认/);
});

test('trust_site：同一站点重复信任不产生重复项', async () => {
  const ctx = { pageUrl: 'https://a.test/', settings: { trustedSites: ['https://a.test'] } };
  await trustSite({ ctx, chrome: { storage: { local: { set: async () => {} } } } });
  assert.deepEqual(ctx.settings.trustedSites, ['https://a.test']);
});

test('trust_site：无法确定站点时失败（不写入空 origin）', async () => {
  const ctx = { pageUrl: '', settings: {} };
  const r = await trustSite({ ctx, chrome: { storage: { local: { set: async () => {} } } } });
  assert.equal(r.ok, false);
  assert.match(r.result, /无法确定当前站点/);
});

test('handle_dialog：需要 CDP；接受与取消的文案不同', async () => {
  const noCdp = await handleDialogTool({ ctx: {}, cdpAllowed: () => false }, {});
  assert.equal(noCdp.ok, false);
  assert.match(noCdp.result, /需要 CDP/);

  const calls = [];
  const deps = {
    ctx: { tabId: 7 },
    cdpAllowed: () => true,
    handleDialog: async (tabId, accept, promptText) => calls.push({ tabId, accept, promptText }),
    summarizeCdpError: (e) => String(e.message || e),
  };
  const accept = await handleDialogTool(deps, {});
  assert.match(accept.result, /已接受/);
  const cancel = await handleDialogTool(deps, { accept: false, promptText: 'hi' });
  assert.match(cancel.result, /已取消/);
  assert.deepEqual(calls, [
    { tabId: 7, accept: true, promptText: undefined },
    { tabId: 7, accept: false, promptText: 'hi' },
  ]);
  // accept 默认是"接受"（args.accept !== false）
  assert.equal(calls[0].accept, true);
});

test('handle_dialog：CDP 报错时摘要化（不把原始 message 直接吐给模型）', async () => {
  const r = await handleDialogTool(
    {
      ctx: { tabId: 1 },
      cdpAllowed: () => true,
      handleDialog: async () => { throw new Error('Page.handleJavaScriptDialog：已关闭'); },
      summarizeCdpError: (e) => String(e.message).replace(/^[A-Za-z.]+：/, ''),
    },
    {}
  );
  assert.equal(r.ok, false);
  assert.match(r.result, /已关闭/);
  assert.ok(!/Page\.handleJavaScriptDialog/.test(r.result), '应剥掉 CDP 域前缀');
});

test('handlePermissionTool：不属于本族返回 null', async () => {
  assert.equal(await handlePermissionTool('click_element', {}, {}), null);
});

// ---------------------------------------------------------------- 截图族

function mkShotDeps(overrides = {}) {
  const archived = [];
  return {
    archived,
    ctx: { tabId: 9 },
    args: {},
    cdp: {
      screenshot: async () => 'A'.repeat(100),
      command: async () => ({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }),
    },
    cdpAllowed: () => true,
    screenshotAttempts: (format, quality) => [{ format, quality: quality || 72 }],
    saveScreenshot: async (chromeApi, shot) => {
      archived.push({ chromeApi, shot });
      return true;
    },
    formatScreenshotSummary: (o) => `图 ${o.width}x${o.height} ${o.format}${o.degraded ? ' 已降质' : ''}`,
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } } },
    ...overrides,
  };
}

test('take_screenshot：未开 CDP / 无 tabId 时明确失败', async () => {
  const noCdp = await takeScreenshot(mkShotDeps({ cdpAllowed: () => false }));
  assert.equal(noCdp.ok, false);
  assert.match(noCdp.result, /需要 CDP/);

  const noTab = await takeScreenshot(mkShotDeps({ ctx: {} }));
  assert.equal(noTab.ok, false);
  assert.match(noTab.result, /无法定位当前标签页/);
});

test('take_screenshot：尺寸标注的是 CSS 视口（不是位图像素）', async () => {
  const r = await takeScreenshot(mkShotDeps());
  assert.equal(r.ok, true);
  assert.equal(r.screenshot.width, 800);
  assert.equal(r.screenshot.height, 600);
  assert.match(r.result, /800x600/);
});

test('take_screenshot：图片数据只放在 screenshot 字段（不进 result 文本）', async () => {
  // 关键不变式：当前模型是纯文本的，base64 绝不能出现在给模型看的 result 里。
  const r = await takeScreenshot(mkShotDeps());
  assert.ok(r.screenshot.dataUrl.startsWith('data:image/jpeg;base64,'), '图片数据应在 screenshot 字段');
  assert.ok(!/base64/.test(r.result), 'result 里不得出现 base64');
  assert.ok(r.result.length < 200, 'result 应是简短摘要：' + r.result.slice(0, 80));
});

test('take_screenshot：全部尝试都失败时如实报错', async () => {
  const r = await takeScreenshot(mkShotDeps({ cdp: { screenshot: async () => { throw new Error('no attach'); }, command: async () => ({}) } }));
  assert.equal(r.ok, false);
  assert.match(r.result, /截图失败/);
});

// ---- 回归：归档函数必须真的被调到，且带上 chrome ----

test('回归：saveScreenshot 必须收到 chrome（漏传会静默不落盘）', async () => {
  // 这一条是为一个**真实发生过**的错误写的：把 saveScreenshot 移进 screenshot-tool.js 时
  // 它的签名多了 chromeApi 参数，而调用点一度没跟着传。后果是归档永远返回 false ——
  // 截图仍显示成功，但图片再也取不回来（不报错、E2E 也抓不到）。
  const seen = [];
  const chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
  await takeScreenshot(mkShotDeps({
    ctx: { tabId: 9, sessionId: 'S-1' },
    chrome,
    saveScreenshot: async (chromeApi, shot, sessionId) => { seen.push({ chromeApi, shot, sessionId }); return true; },
  }));
  assert.equal(seen.length, 1, '归档函数应被调用一次');
  assert.equal(seen[0].chromeApi, chrome, '必须把 chrome 传下去，否则 storage 不可用 → 静默不落盘');
  assert.equal(seen[0].sessionId, 'S-1', '截图必须带上所属会话，才能跨会话取回');
  assert.match(seen[0].shot.dataUrl, /^data:image\//);
});

test('saveScreenshot：真的写进 storage.local，且最多保留 MAX_SHOTS 张', async () => {
  let stored = null;
  const chrome = {
    storage: {
      local: {
        get: async () => ({ [SHOT_KEY]: [] }),
        set: async (o) => { stored = o; },
      },
    },
  };
  const ok = await saveScreenshot(chrome, { id: 's1', dataUrl: 'data:image/png;base64,AAA' });
  assert.equal(ok, true);
  assert.equal(stored[SHOT_KEY].length, 1);
  assert.equal(MAX_SHOTS, 3);
});

test('saveScreenshot：超过落盘上限时返回 false（但调用方仍会把图给面板）', async () => {
  const chrome = { storage: { local: { get: async () => ({}), set: async () => { throw new Error('不该写'); } } } };
  const huge = { id: 's', dataUrl: 'x'.repeat(MAX_SHOT_STORE_CHARS + 1) };
  assert.equal(await saveScreenshot(chrome, huge), false);
});

test('saveScreenshot：storage 不可用时静默返回 false（不抛）', async () => {
  assert.equal(await saveScreenshot(null, { id: 's', dataUrl: 'data:image/png;base64,AA' }), false);
  assert.equal(await saveScreenshot({}, { id: 's', dataUrl: 'data:image/png;base64,AA' }), false);
});

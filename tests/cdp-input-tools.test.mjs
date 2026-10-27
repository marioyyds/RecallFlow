// cdp-input-tools.js：CDP 输入族（C-1 拆出的第 7 族，唯一真正"操作页面"的一族）。
//
// 这一族里最值钱的断言是 `click_element` 的**升级条件**：
// 它必须只在"内容脚本报错"时升级到 CDP，**绝不能**因为"没观测到效果"就升级 ——
// 后者会对真实页面双击（勾选/单选框/同页锚点/已选中的 tab 本来就不产生 DOM 变化）。
// 这段逻辑以前埋在巨型 switch 里，注释写得很清楚但**没有任何测试**守着它。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clickElement,
  clickAt,
  hoverElement,
  dragElement,
  uploadFile,
  CDP_INPUT_TOOLS,
  handleCdpInputTool,
} from '../lib/assistant/cdp-input-tools.ts';

/** 造一套假依赖，记录每次调用。 */
function mkDeps(overrides = {}) {
  const calls = [];
  const observed = (before, after) =>
    !before || !after ? 'unobservable' : before.fingerprint === after.fingerprint ? 'unchanged' : 'changed';
  const deps = {
    calls,
    ctx: { tabId: 7, lastSnapshot: { fingerprint: 'fp-before' } },
    cdp: {
      clickAt: async (tabId, x, y, opts) => calls.push({ op: 'clickAt', tabId, x, y, opts }),
      moveTo: async (tabId, x, y) => calls.push({ op: 'moveTo', tabId, x, y }),
      drag: async (tabId, x1, y1, x2, y2) => calls.push({ op: 'drag', tabId, x1, y1, x2, y2 }),
      uploadFile: async (tabId, selector, files) => calls.push({ op: 'uploadFile', tabId, selector, files }),
      resolveFrameClickPoint: async (tabId, frameId, selector, point) => {
        calls.push({ op: 'resolveFrameClickPoint', frameId, selector, point });
        return deps.framePoint;
      },
    },
    framePoint: { x: 55, y: 66 },
    cdpAllowed: () => true,
    executePageTool: async (tabId, command, args, ctx) => {
      calls.push({ op: 'executePageTool', command });
      return deps.contentResult;
    },
    contentResult: { ok: true, result: '已执行页面动作：click' },
    frameIdFromArgs: () => null,
    resolveTarget: async () => ({ selector: '#btn', rect: { centerX: 10, centerY: 20 } }),
    rememberTarget: () => calls.push({ op: 'rememberTarget' }),
    getPageSnapshot: async () => ({ fingerprint: 'fp-after' }),
    observedChange: observed,
    buildActionVerification: (o, reason) => ({ verified: o === 'changed', changed: o === 'changed', reason }),
    compactSnapshotSummary: () => '页面摘要',
    summarizeCdpError: (e) => String(e.message).replace(/^[A-Za-z.]+：/, ''),
    ...overrides,
  };
  return deps;
}

test('CDP_INPUT_TOOLS 覆盖五个工具名', () => {
  assert.deepEqual([...CDP_INPUT_TOOLS].sort(),
    ['click_at', 'click_element', 'drag_element', 'hover_element', 'upload_file']);
});

test('handleCdpInputTool：不属于本族返回 null', async () => {
  assert.equal(await handleCdpInputTool('type_text', {}, mkDeps()), null);
  assert.equal(await handleCdpInputTool('annotate', {}, mkDeps()), null);
});

// ---------------------------------------------------------------- click_element 的升级条件

test('**关键**：内容脚本成功时绝不升级 CDP（哪怕没观测到变化）', async () => {
  // 这正是"会双击真实页面"的那个陷阱：内容脚本点击成功了，但页面没有 DOM 变化
  //（勾选/单选框/同页锚点/已选中的 tab 都是这样）。此时**不得**再派发一次 CDP 点击。
  const deps = mkDeps({
    contentResult: { ok: true, result: '已执行页面动作：click', changed: false },
    getPageSnapshot: async () => ({ fingerprint: 'fp-before' }), // 观测到"没有变化"
  });
  const r = await clickElement(deps, { selector: '#btn' });
  assert.equal(r.ok, true);
  assert.ok(!deps.calls.some((c) => c.op === 'clickAt'), '内容脚本成功却升级了 CDP —— 这就是双击');
  assert.equal(r.cdp, undefined, '不应标记为走了 CDP');
});

test('内容脚本**报错**时才升级到 CDP 可信点击（并标注坐标与原因）', async () => {
  const deps = mkDeps({ contentResult: { ok: false, result: '元素不可点击' } });
  const r = await clickElement(deps, { selector: '#btn' });
  assert.equal(r.ok, true);
  assert.equal(r.cdp, true);
  const click = deps.calls.find((c) => c.op === 'clickAt');
  assert.ok(click, '应派发 CDP 点击');
  assert.equal(click.x, 10);
  assert.equal(click.y, 20, '应使用目标元素中心坐标');
  assert.match(r.result, /内容脚本点击失败（元素不可点击）/);
  assert.match(r.result, /已改用 CDP 可信点击（坐标 10,20）/);
  assert.equal(r.hadEffect, true, '前后指纹不同 → hadEffect true');
});

test('内容脚本报错但**找不到目标**时不升级（没有坐标可点）', async () => {
  const deps = mkDeps({ contentResult: { ok: false, result: '未找到元素' }, resolveTarget: async () => null });
  const r = await clickElement(deps, { selector: '#nope' });
  assert.equal(r.ok, false);
  assert.ok(!deps.calls.some((c) => c.op === 'clickAt'));
});

test('内容脚本报错但 **CDP 不可用**时如实返回失败（不假装成功）', async () => {
  const deps = mkDeps({ contentResult: { ok: false, result: '不可点击' }, cdpAllowed: () => false });
  const r = await clickElement(deps, { selector: '#btn' });
  assert.equal(r.ok, false);
  assert.equal(r.result, '不可点击');
  assert.ok(!deps.calls.some((c) => c.op === 'clickAt'));
});

test('子框架：先换算成顶层坐标再点（不换算会点到错误位置）', async () => {
  const deps = mkDeps({ contentResult: { ok: false, result: '失败' }, frameIdFromArgs: () => 3, framePoint: { x: 111, y: 222 } });
  await clickElement(deps, { selector: '#btn' });
  const resolve = deps.calls.find((c) => c.op === 'resolveFrameClickPoint');
  assert.ok(resolve, '子框架必须做坐标换算');
  assert.equal(resolve.frameId, 3);
  const click = deps.calls.find((c) => c.op === 'clickAt');
  assert.equal(click.x, 111);
  assert.equal(click.y, 222, '应使用换算后的顶层坐标');
});

test('**关键**：子框架换算失败时宁可不点，也不在错误坐标上点击', async () => {
  const deps = mkDeps({ contentResult: { ok: false, result: '失败' }, frameIdFromArgs: () => 3, framePoint: null });
  const r = await clickElement(deps, { selector: '#btn' });
  assert.equal(r.ok, false, '应退回内容脚本的失败结果');
  assert.ok(!deps.calls.some((c) => c.op === 'clickAt'), '坐标不可靠时绝不能盲点');
});

test('click_element：内容脚本成功后记住目标（供站点记忆复用）', async () => {
  const deps = mkDeps();
  await clickElement(deps, { selector: '#btn' });
  assert.ok(deps.calls.some((c) => c.op === 'rememberTarget'));
});

test('click_element：内容脚本失败时**不**记入站点记忆（没验证过的选择器不该复用）', async () => {
  const deps = mkDeps({ contentResult: { ok: false, result: '失败' } });
  await clickElement(deps, { selector: '#btn' });
  assert.ok(!deps.calls.some((c) => c.op === 'rememberTarget'), '失败的选择器不应进站点记忆');
});

// ---------------------------------------------------------------- click_at

test('click_at：坐标必须有限数值，否则直接失败且不碰 CDP', async () => {
  for (const bad of [{}, { x: 1 }, { x: 'a', y: 2 }, { x: NaN, y: 2 }]) {
    const deps = mkDeps();
    const r = await clickAt(deps, bad);
    assert.equal(r.ok, false, JSON.stringify(bad) + ' 应被拒绝');
    assert.match(r.result, /需要数值坐标/);
    assert.deepEqual(deps.calls, [], '非法坐标不该调用 CDP');
  }
});

test('click_at：double=true 时 clickCount=2；button 可指定', async () => {
  const deps = mkDeps();
  await clickAt(deps, { x: 5, y: 6, double: true, button: 'right' });
  const c = deps.calls.find((x) => x.op === 'clickAt');
  assert.equal(c.opts.clickCount, 2);
  assert.equal(c.opts.button, 'right');
});

test('click_at：缺省 button 为 left、clickCount 为 1', async () => {
  const deps = mkDeps();
  await clickAt(deps, { x: 5, y: 6 });
  const c = deps.calls.find((x) => x.op === 'clickAt');
  assert.equal(c.opts.button, 'left');
  assert.equal(c.opts.clickCount, 1);
});

test('click_at：未开 CDP 时给出可操作的提示', async () => {
  const deps = mkDeps({ cdpAllowed: () => false });
  const r = await clickAt(deps, { x: 1, y: 2 });
  assert.equal(r.ok, false);
  assert.match(r.result, /需要 CDP 输入层/);
});

// ---------------------------------------------------------------- hover / drag / upload

test('hover：CSS :hover 伪类常不产生 DOM 变更，必须如实报 hadEffect=false', async () => {
  // 若这里谎报 changed:true，卡死检测会永远认为在推进。
  const deps = mkDeps({ getPageSnapshot: async () => ({ fingerprint: 'fp-before' }) });
  const r = await hoverElement(deps, { selector: '#menu' });
  assert.equal(r.ok, true);
  assert.equal(r.hadEffect, false, '没有 DOM 变化就要如实说');
  assert.equal(r.verification.changed, false);
  assert.match(r.verification.reason, /伪类变化可能不产生 DOM 变更/, '理由要说清为什么可能是 false');
});

test('hover：未找到目标时失败且不 moveTo', async () => {
  const deps = mkDeps({ resolveTarget: async () => null });
  const r = await hoverElement(deps, { selector: '#x' });
  assert.equal(r.ok, false);
  assert.ok(!deps.calls.some((c) => c.op === 'moveTo'));
});

test('drag：必须能**同时**定位起点与终点，缺一个就失败', async () => {
  let n = 0;
  const deps = mkDeps({ resolveTarget: async () => (++n === 1 ? { selector: '#a', rect: { centerX: 1, centerY: 2 } } : null) });
  const r = await dragElement(deps, { fromSelector: '#a', toSelector: '#b' });
  assert.equal(r.ok, false);
  assert.match(r.result, /需要能同时定位起点与终点/);
  assert.ok(!deps.calls.some((c) => c.op === 'drag'));
});

test('drag：两端都定位到时派发 drag，并如实标注观测结果', async () => {
  let n = 0;
  const from = { selector: '#a', rect: { centerX: 1, centerY: 2 } };
  const to = { selector: '#b', rect: { centerX: 3, centerY: 4 } };
  const deps = mkDeps({ resolveTarget: async () => (++n === 1 ? from : to) });
  const r = await dragElement(deps, { fromSelector: '#a', toSelector: '#b' });
  assert.equal(r.ok, true);
  const d = deps.calls.find((c) => c.op === 'drag');
  assert.deepEqual([d.x1, d.y1, d.x2, d.y2], [1, 2, 3, 4]);
  assert.match(r.result, /已从 \(1,2\) 拖拽到 \(3,4\)/);
});

test('upload_file：files 支持数组与单个字符串；空则失败', async () => {
  const single = mkDeps();
  await uploadFile(single, { selector: '#f', files: 'C:/a.txt' });
  assert.deepEqual(single.calls.find((c) => c.op === 'uploadFile').files, ['C:/a.txt']);

  const arr = mkDeps();
  await uploadFile(arr, { selector: '#f', files: ['a', '', null, 'b'] });
  assert.deepEqual(arr.calls.find((c) => c.op === 'uploadFile').files, ['a', 'b'], '应过滤空值');

  const empty = mkDeps();
  const r = await uploadFile(empty, { selector: '#f', files: [] });
  assert.equal(r.ok, false);
  assert.match(r.result, /需要 files/);
});

test('upload_file：如实标注"未做页面变化观测"，绝不谎报 changed', async () => {
  // 文件选择不产生可观察的页面变化（文件名可能只出现在 input.value 里）。
  const deps = mkDeps();
  const r = await uploadFile(deps, { selector: '#f', files: ['a.txt'] });
  assert.equal(r.ok, true);
  assert.equal(r.hadEffect, false);
  assert.equal(r.verification.changed, false);
  assert.equal(r.verification.verified, false, '不可观测就不能声称已验证');
  assert.match(r.verification.reason, /未做页面变化观测/);
});

test('CDP 报错时剥掉域前缀（不把 Page.xxx 原样吐给模型）', async () => {
  const deps = mkDeps({
    cdp: {
      clickAt: async () => { throw new Error('Input.dispatchMouseEvent：目标已关闭'); },
      moveTo: async () => {}, drag: async () => {}, uploadFile: async () => {}, resolveFrameClickPoint: async () => null,
    },
  });
  const r = await clickAt(deps, { x: 1, y: 2 });
  assert.equal(r.ok, false);
  assert.match(r.result, /目标已关闭/);
  assert.ok(!/Input\.dispatchMouseEvent/.test(r.result));
});

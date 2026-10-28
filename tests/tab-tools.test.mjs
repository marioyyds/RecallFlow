// tab-tools.js：标签页族的行为（用假 chrome.tabs，不需要真实浏览器）。
//
// 为什么值得单独测：这一族是 C-1 从 `executeTool` 巨型 switch 里拆出的**第一族**。
// 抽取的价值就在这里 —— 把 `chrome` 换成假的之后，去重复用、预算软拒绝、
// 隔离模式不抢前台这些语义都能直接断言，而以前只能靠真实浏览器碰运气。
//
// 注意：下面断言的是**已有语义**（搬运前的行为），不是新设计。
// 搬运与改进混在一起会让回归无法归因，所以这一轮不改行为、只补测试。
import test from 'node:test';
import assert from 'node:assert/strict';

import { listTabs, switchTab, openTab, handleTabTool, TAB_TOOLS } from '../lib/application/agent/tab-tools.ts';

/** 造一个假的 chrome.tabs 与依赖集合。 */
function mkDeps(overrides = {}) {
  const calls = [];
  const tabs = new Map();
  let nextId = 100;
  const chrome = {
    tabs: {
      query: async (q) => {
        calls.push({ op: 'query', q });
        if (q && q.url) return [...tabs.values()].filter((t) => t.url === q.url);
        return [...tabs.values()];
      },
      get: async (id) => {
        calls.push({ op: 'get', id });
        const t = tabs.get(id);
        if (!t) throw new Error('no tab ' + id);
        return t;
      },
      update: async (id, patch) => {
        calls.push({ op: 'update', id, patch });
        const t = tabs.get(id);
        if (t) Object.assign(t, patch);
        return t;
      },
      create: async (opts) => {
        calls.push({ op: 'create', opts });
        const id = nextId++;
        const t = { id, windowId: opts.windowId || 1, url: opts.url, title: 'T' + id, active: opts.active !== false };
        tabs.set(id, t);
        return t;
      },
    },
  };
  const ctx = { openedTabCount: 0, maxOpenedTabs: 5, browsingMode: 'normal' };
  const deps = {
    calls,
    tabs,
    chrome,
    ctx,
    tracked: [],
    waitForTabReady: async (id, ms) => {
      calls.push({ op: 'wait', id, ms });
      return { url: tabs.get(id) ? tabs.get(id).url : '', fingerprint: 'fp' };
    },
    bindSessionTab: (id) => calls.push({ op: 'bind', id }),
    listOpenedTabsSummary: async () => 'tabId=1 a\n tabId=2 b',
    // 注意：这里必须把 id 记到 deps.tracked（外层数组），而不是参数上的一个临时属性 ——
    // 测试里断言的是 deps.tracked，是"被注入的那个 deps"。
    trackOpenedTab: (_ctx, id) => {
      deps.tracked.push(id);
    },
    ensureAgentWindow: async () => 42,
    ...overrides,
  };
  return deps;
}

test('TAB_TOOLS 覆盖三个工具名（分派表必须与 case 一致）', () => {
  assert.deepEqual([...TAB_TOOLS].sort(), ['list_tabs', 'open_tab', 'switch_tab']);
});

test('handleTabTool：不属于本族时返回 null（让 executeTool 继续往下分派）', async () => {
  assert.equal(await handleTabTool('click_element', {}, mkDeps()), null);
  assert.equal(await handleTabTool('unknown_tool', {}, mkDeps()), null);
});

test('list_tabs：过滤无 url 的标签页，并标出当前活动页', async () => {
  const deps = mkDeps();
  await deps.chrome.tabs.create({ url: 'https://a.test/', active: true });
  await deps.chrome.tabs.create({ url: 'https://b.test/', active: false });
  deps.tabs.set(999, { id: 999, url: '', title: 'blank' }); // 无 url 的应被过滤
  const r = await listTabs(deps);
  assert.equal(r.ok, true);
  assert.equal(r.tabs.length, 2, '无 url 的标签页不应出现在结果里');
  assert.match(r.result, /tabId=100/);
  assert.match(r.result, /（当前）/);
});

test('switch_tab：拒绝非法 tabId，且不发起任何浏览器调用', async () => {
  for (const bad of [0, -1, 'abc', null, undefined, 1.5]) {
    const deps = mkDeps();
    const r = await switchTab(deps, { tabId: bad });
    assert.equal(r.ok, false, 'tabId=' + String(bad) + ' 应被拒绝');
    assert.deepEqual(deps.calls, [], '非法 tabId 时不该调用 chrome.tabs');
  }
});

test('switch_tab：激活目标页、等就绪、绑定会话，并回传 targetTabId', async () => {
  const deps = mkDeps();
  const t = await deps.chrome.tabs.create({ url: 'https://a.test/', active: false });
  deps.calls.length = 0;
  const r = await switchTab(deps, { tabId: t.id });
  assert.equal(r.ok, true);
  assert.equal(r.activated, true);
  assert.equal(r.targetTabId, t.id);
  assert.equal(r.targetTab.ready, true);
  const ops = deps.calls.map((c) => c.op);
  assert.ok(ops.includes('update'), '应把目标页设为 active');
  assert.ok(ops.includes('wait'), '应等待页面就绪');
  assert.ok(ops.includes('bind'), '应同步绑定会话标签页');
  assert.equal(deps.ctx.tabSwitchCount, 1, '真实切换应计入标签页切换预算');
});

test('switch_tab：目标不存在时返回可读失败（不抛）', async () => {
  const r = await switchTab(mkDeps(), { tabId: 12345 });
  assert.equal(r.ok, false);
  assert.match(r.result, /切换标签页失败/);
});

test('open_tab：只接受 http/https', async () => {
  for (const bad of ['', 'javascript:alert(1)', 'chrome://settings']) {
    const r = await openTab(mkDeps(), { url: bad });
    assert.equal(r.ok, false, bad + ' 应被拒绝');
    assert.match(r.result, /仅支持 http\/https/);
  }
});

test('open_tab：本地文件被**单独**拒绝，并告诉模型正确的做法', async () => {
  // 与上面那条分开写，是因为拒绝的理由不同：file:// 不是"协议不认识"，
  // 而是"有意不给 agent 一个逐路径探测本机磁盘的读口"。
  // 混在一条断言里，将来谁把这条单独分支删掉，也只会看到"仅支持 http/https"仍然通过。
  const r = await openTab(mkDeps(), { url: 'file:///C:/Users/me/secret.html' });
  assert.equal(r.ok, false);
  assert.match(r.result, /不支持本地文件路径/);
  assert.match(r.result, /让用户自己在浏览器里打开/, '要给模型可执行的替代路径，否则它会反复重试');
});

test('open_tab：默认按 URL 去重复用已有标签页（不新建）', async () => {
  const deps = mkDeps();
  const existing = await deps.chrome.tabs.create({ url: 'https://a.test/', active: false });
  deps.calls.length = 0;
  const r = await openTab(deps, { url: 'https://a.test/' });
  assert.equal(r.ok, true);
  assert.equal(r.reused, true, '应标记为复用');
  assert.equal(r.targetTabId, existing.id);
  const creates = deps.calls.filter((c) => c.op === 'create');
  assert.equal(creates.length, 0, '复用路径不得新建标签页');
});

test('open_tab：newTab=true 时强制新建（即使同 URL 已打开）', async () => {
  const deps = mkDeps();
  await deps.chrome.tabs.create({ url: 'https://a.test/', active: false });
  deps.calls.length = 0;
  const r = await openTab(deps, { url: 'https://a.test/', newTab: true });
  assert.equal(r.ok, true);
  assert.ok(!r.reused, '不应标记为复用');
  assert.equal(deps.calls.filter((c) => c.op === 'create').length, 1, '应新建一个');
});

test('open_tab：隔离模式不激活标签，且用 agent 自己的窗口', async () => {
  const deps = mkDeps();
  deps.ctx.browsingMode = 'isolated';
  const r = await openTab(deps, { url: 'https://iso.test/' });
  assert.equal(r.ok, true);
  const create = deps.calls.find((c) => c.op === 'create');
  assert.equal(create.opts.active, false, '隔离模式不得抢用户前台视图');
  assert.equal(create.opts.windowId, 42, '隔离模式应在 agent 自己的窗口里打开');
});

test('open_tab：达到新建上限时软拒绝，并列出已开标签页引导复用', async () => {
  const deps = mkDeps();
  deps.ctx.openedTabCount = 5;
  deps.ctx.maxOpenedTabs = 5;
  const r = await openTab(deps, { url: 'https://any.test/' });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true, '应是"软拒绝"而不是普通失败');
  assert.match(r.result, /达到上限/);
  assert.match(r.result, /tabId=1/, '应列出已打开标签页');
  assert.match(r.result, /switch_tab/, '应给出可执行的替代方案');
  assert.equal(deps.calls.filter((c) => c.op === 'create').length, 0, '达上限时不得新建');
});

test('open_tab：新建成功后累计计数递增（预算是按累计新建数算的）', async () => {
  const deps = mkDeps();
  assert.equal(deps.ctx.openedTabCount, 0);
  const r = await openTab(deps, { url: 'https://n.test/' });
  assert.equal(r.ok, true);
  assert.equal(deps.ctx.openedTabCount, 1, '应递增累计新建数');
  assert.deepEqual(deps.tracked, [r.targetTabId], '应记录到已开标签页清单');
});

test('open_tab：同 URL 复用也会绑定会话（否则后续动作会打到旧标签页）', async () => {
  const deps = mkDeps();
  const existing = await deps.chrome.tabs.create({ url: 'https://a.test/', active: false });
  deps.calls.length = 0;
  await openTab(deps, { url: 'https://a.test/' });
  const binds = deps.calls.filter((c) => c.op === 'bind');
  assert.equal(binds.length, 1);
  assert.equal(binds[0].id, existing.id);
});

test('switch_tab：目标就是当前绑定页时是 no-op，不碰浏览器', async () => {
  const deps = mkDeps();
  const t = await deps.chrome.tabs.create({ url: 'https://a.test/', active: true });
  deps.ctx.tabId = t.id;
  deps.calls.length = 0;
  const r = await switchTab(deps, { tabId: t.id });
  assert.equal(r.ok, true);
  assert.equal(r.noop, true);
  assert.equal(r.activated, false);
  assert.deepEqual(deps.calls, [], '同一页不应再 get/update/wait，避免无意义闪动');
});

test('switch_tab：达到上限后拒绝继续切换，且不调用 update', async () => {
  const deps = mkDeps();
  const current = await deps.chrome.tabs.create({ url: 'https://a.test/', active: true });
  const target = await deps.chrome.tabs.create({ url: 'https://b.test/', active: false });
  deps.ctx.tabId = current.id;
  deps.ctx.tabSwitchCount = 6;
  deps.ctx.maxTabSwitches = 6;
  deps.calls.length = 0;
  const r = await switchTab(deps, { tabId: target.id });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.match(r.result, /不再继续切换/);
  assert.equal(deps.calls.filter((c) => c.op === 'update').length, 0);
  assert.equal(deps.calls.filter((c) => c.op === 'bind').length, 0);
});

test('switch_tab：目标已在浏览器前台时只绑定上下文，不重复激活', async () => {
  const deps = mkDeps();
  const target = await deps.chrome.tabs.create({ url: 'https://b.test/', active: true });
  deps.calls.length = 0;
  const r = await switchTab(deps, { tabId: target.id });
  assert.equal(r.ok, true);
  assert.equal(deps.calls.filter((c) => c.op === 'update').length, 0);
  assert.equal(deps.ctx.tabSwitchCount || 0, 0);
});

test('open_tab：复用当前前台页时不再 update(active:true)', async () => {
  const deps = mkDeps();
  const existing = await deps.chrome.tabs.create({ url: 'https://a.test/', active: true });
  deps.ctx.tabId = existing.id;
  deps.calls.length = 0;
  const r = await openTab(deps, { url: 'https://a.test/' });
  assert.equal(r.ok, true);
  assert.equal(r.reused, true);
  assert.equal(r.activated, false);
  assert.equal(deps.calls.filter((c) => c.op === 'update').length, 0);
  assert.match(r.result, /无需再切换/);
});

// code-access-tools.js：页面内代码与结构访问族（C-1 拆出的第 11 族）。
//
// 抽取的收益：这一族里最值钱的语义是 run_javascript 的 **CSP 自动重试**——
// 沙箱用 `new Function` 实现，而内容脚本里的 eval 类构造**同样受页面 CSP 约束**。
// 被拒时自动改用页面主世界重试（同一段代码、同一次审批，不会再弹一次审批）。
// 这段逻辑以前埋在巨型 switch 里，只能靠真实 CSP 页面碰运气。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  runJavascript,
  getAxSnapshot,
  INTERACTIVE_ROLES,
  CODE_ACCESS_TOOLS,
  handleCodeAccessTool,
  __resetPageWorldPreferenceForTests,
} from '../lib/application/agent/code-access-tools.ts';
import { buildPageWorldExpression } from '../lib/application/agent/tools.ts';
import fs from 'node:fs';
// 用**真实的** CSP 判定，而不是在测试里再写一个近似版：
// 近似版会与实现漂移，而漂移的表现是"该重试的没重试"（或反过来无谓提权执行）。
import { isCspEvalBlockError } from '../lib/shared/diagnostics.ts';

function mkDeps(overrides = {}) {
  const calls = [];
  const deps = {
    calls,
    ctx: { tabId: 7 },
    cdp: {
      getFullAxTree: async () => deps.axNodes,
      getBoxModel: async (tabId, id) => {
        calls.push({ op: 'getBoxModel', id });
        return deps.boxFor(id);
      },
    },
    axNodes: [],
    boxFor: () => ({ content: [0, 0, 10, 0, 10, 20, 0, 20] }), // 中心 (5,10)
    cdpAllowed: () => true,
    executeContentAction: async (tabId, action, msg, opts) => {
      calls.push({ op: 'content', action, msg, opts });
      return deps.contentResult;
    },
    contentResult: { ok: true, result: '沙箱结果' },
    evaluateInPageWorld: async (ctx, args) => {
      calls.push({ op: 'pageWorld', args });
      return deps.pageWorldResult;
    },
    pageWorldResult: { ok: true, result: '主世界结果' },
    isCspEvalBlockError,
    summarizeCdpError: (e) => String(e.message).replace(/^[A-Za-z.]+：/, ''),
    ...overrides,
  };
  return deps;
}

beforeEach(() => {
  __resetPageWorldPreferenceForTests();
});

test('CODE_ACCESS_TOOLS 覆盖两个工具名', () => {
  assert.deepEqual([...CODE_ACCESS_TOOLS].sort(), ['get_ax_snapshot', 'run_javascript']);
});

test('handleCodeAccessTool：不属于本族返回 null', async () => {
  assert.equal(await handleCodeAccessTool('click_element', {}, mkDeps()), null);
});

// ---------------------------------------------------------------- run_javascript

test('run_javascript：默认走内容脚本**沙箱**（权限最小化，不是性能优化）', async () => {
  const deps = mkDeps();
  const r = await runJavascript(deps, { code: 'return 1' });
  assert.equal(r.result, '沙箱结果');
  assert.ok(deps.calls.some((c) => c.op === 'content'), '默认应走沙箱');
  assert.ok(!deps.calls.some((c) => c.op === 'pageWorld'), '默认不该走页面主世界');
});

test('run_javascript：engine=page 时直接走页面主世界（跳过沙箱）', async () => {
  for (const args of [{ code: 'x', engine: 'page' }, { code: 'x', pageWorld: true }]) {
    const deps = mkDeps();
    await runJavascript(deps, args);
    assert.ok(deps.calls.some((c) => c.op === 'pageWorld'), JSON.stringify(args) + ' 应走主世界');
    assert.ok(!deps.calls.some((c) => c.op === 'content'), '不该先试沙箱');
  }
});

test('页面主世界表达式必须是 async IIFE（支持顶层 await 与 return）', () => {
  const expr = buildPageWorldExpression('const x = await Promise.resolve(1); return x;');
  assert.match(expr, /^\(async \(\) => \{/);
  assert.match(expr, /await Promise\.resolve/);
  assert.match(expr, /\}\)\(\)$/);
});

test('同一 tab 确认 CSP 拦截后，后续调用直接走页面主世界（不重复试沙箱）', async () => {
  const deps = mkDeps({
    contentResult: { ok: false, error: 'Content Security Policy blocks unsafe-eval' },
    pageWorldResult: { ok: true, result: 'ok' },
  });
  await runJavascript(deps, { code: 'return 1' });
  const contentCallsFirst = deps.calls.filter((c) => c.op === 'content').length;
  assert.equal(contentCallsFirst, 1);
  deps.calls.length = 0;
  const r = await runJavascript(deps, { code: 'return 2' });
  assert.equal(r.ok, true);
  assert.equal(deps.calls.filter((c) => c.op === 'content').length, 0, '第二次不应再试已知不可用的沙箱');
  assert.equal(deps.calls.filter((c) => c.op === 'pageWorld').length, 1);
  assert.match(r.result, /直接走页面主世界/);
});

test('沙箱执行体也包成 async IIFE（源码级门禁）', () => {
  const src = fs.readFileSync('lib/application/page/run-js.ts', 'utf8');
  assert.match(src, /return \(async \(\) => \{/);
});

test('**关键**：沙箱 eval 被拒时自动改用页面主世界重试（模型不必多花一轮）', async () => {
  const deps = mkDeps({
    contentResult: { ok: false, error: 'Refused to evaluate: Content Security Policy' },
    pageWorldResult: { ok: true, result: '主世界拿到了数据' },
  });
  const r = await runJavascript(deps, { code: 'return document.title' });
  assert.equal(r.ok, true);
  assert.ok(deps.calls.some((c) => c.op === 'pageWorld'), '应自动重试主世界');
  // 文案要归因正确：拦住 eval 的是**扩展自身的 MV3 CSP**，不是页面
  assert.match(r.result, /MV3 扩展自身的 CSP 不允许/);
  assert.match(r.result, /已自动改用页面主世界执行/);
  assert.match(r.result, /主世界拿到了数据/);
});

test('**关键**：eval 被拒但 CDP 不可用时，说明原因并指向设置（不静默失败）', async () => {
  const deps = mkDeps({
    contentResult: { ok: false, error: 'Content Security Policy blocks unsafe-eval' },
    cdpAllowed: () => false,
  });
  const r = await runJavascript(deps, { code: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.result, /需要页面主世界执行（CDP）/);
  assert.match(r.result, /MV3 扩展自身的 CSP 不允许 eval/);
  assert.match(r.result, /与页面无关/, '必须点明这不是页面造成的 —— 否则会被引向"换个页面"');
  assert.match(r.result, /设置中开启/);
  assert.match(r.result, /原始错误/, '要带出原始错误');
  assert.ok(!deps.calls.some((c) => c.op === 'pageWorld'), 'CDP 不可用时不该去试主世界');
});

test('eval 被拒且主世界也失败时，如实说明两次都失败', async () => {
  const deps = mkDeps({
    contentResult: { ok: false, error: 'unsafe-eval blocked' },
    pageWorldResult: { ok: false, result: '主世界也报错' },
  });
  const r = await runJavascript(deps, { code: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.result, /MV3 扩展自身的 CSP 不允许，与页面无关/);
  assert.match(r.result, /改用页面主世界同样失败：主世界也报错/);
});

test('非 CSP 类失败**不得**触发主世界重试（避免无谓地提权执行）', async () => {
  const deps = mkDeps({ contentResult: { ok: false, error: '语法错误：Unexpected token' } });
  const r = await runJavascript(deps, { code: 'x(' });
  // 注意：内容脚本的失败响应是**原样透传**的（形如 { ok:false, error }），
  // 不会包装成 { result: ... } —— 断言要按实际形状写。
  assert.equal(r.ok, false);
  assert.equal(r.error, '语法错误：Unexpected token');
  assert.ok(!deps.calls.some((c) => c.op === 'pageWorld'), '只有 CSP 类失败才该重试');
});

test('run_javascript：成功时把 verification.reason 改成"返回结果见上"', async () => {
  // JS 可能只读不改页面，快照验证不一定有变化，此时以返回结果为准。
  const deps = mkDeps({ contentResult: { ok: true, result: 'ok', verification: { changed: false, reason: '未观测到变化' } } });
  const r = await runJavascript(deps, { code: 'return 1' });
  assert.equal(r.verification.reason, 'JS 已执行，返回结果见上');
});

test('run_javascript：沙箱抛错时返回可读失败', async () => {
  const deps = mkDeps({ executeContentAction: async () => { throw new Error('未注入'); } });
  const r = await runJavascript(deps, { code: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.result, /执行 JS 失败：未注入/);
});

// ---------------------------------------------------------------- get_ax_snapshot

test('get_ax_snapshot：未开 CDP 时失败', async () => {
  const deps = mkDeps({ cdpAllowed: () => false });
  const r = await getAxSnapshot(deps, {});
  assert.equal(r.ok, false);
  assert.match(r.result, /可访问性树快照需要 CDP/);
});

test('**关键**：只挑交互角色，忽略 ignored 节点（否则文本/布局节点会占满 token）', async () => {
  const deps = mkDeps({
    axNodes: [
      { role: { value: 'button' }, name: { value: '登录' }, backendDOMNodeId: 1 },
      { role: { value: 'StaticText' }, name: { value: '一段说明文字' } }, // 非交互
      { role: { value: 'link' }, name: { value: '帮助' }, ignored: true, backendDOMNodeId: 2 }, // 被忽略
      { role: { value: 'textbox' }, name: { value: '搜索' }, backendDOMNodeId: 3 },
      { backendDOMNodeId: 4 }, // 无 role
    ],
  });
  const r = await getAxSnapshot(deps, {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.ax.map((n) => n.role), ['button', 'textbox'], '只保留交互角色且排除 ignored');
  assert.deepEqual(r.ax[0].locator, { role: 'button', name: '登录' }, '要给 role+name 定位器');
});

test('get_ax_snapshot：优先提供 role+name 定位（比坐标稳）', async () => {
  const deps = mkDeps({ axNodes: [{ role: { value: 'button' }, name: { value: 'B' }, backendDOMNodeId: 1 }] });
  const r = await getAxSnapshot(deps, {});
  assert.match(r.result, /优先用 role\+name 定位/);
  assert.match(r.result, /canvas\/虚拟列表等无 DOM 场景再用坐标 click_at/);
});

test('get_ax_snapshot：排除 RecallFlow 自身面板及其 shadow 子树', async () => {
  const axNodes = [
    { role: { value: 'button' }, name: { value: '整理会话到知识库' }, backendDOMNodeId: 101 },
    { role: { value: 'button' }, name: { value: '页面真实按钮' }, backendDOMNodeId: 2 },
    { role: { value: 'textbox' }, name: { value: '页面搜索框' }, backendDOMNodeId: 3 },
  ];
  const deps = mkDeps({
    axNodes,
    cdp: {
      getFullAxTree: async () => axNodes,
      getBoxModel: async () => ({ content: [0, 0, 10, 0, 10, 20, 0, 20] }),
      command: async (tabId, method, params) => {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 2 };
        if (method === 'DOM.describeNode') {
          return { node: { backendNodeId: 100, children: [{ backendNodeId: 101 }] } };
        }
        return {};
      },
    },
  });
  const r = await getAxSnapshot(deps, {});
  assert.deepEqual(r.ax.map((n) => n.name), ['页面真实按钮', '页面搜索框']);
  assert.equal(r.ax.length, 2, '助手面板节点不能占页面元素预算');
});

test('get_ax_snapshot：补坐标（取内容框四角均值）', async () => {
  const deps = mkDeps({
    axNodes: [{ role: { value: 'button' }, name: { value: 'B' }, backendDOMNodeId: 1 }],
    boxFor: () => ({ content: [0, 0, 10, 0, 10, 20, 0, 20] }),
  });
  const r = await getAxSnapshot(deps, {});
  assert.equal(r.ax[0].x, 5);
  assert.equal(r.ax[0].y, 10);
  assert.match(r.result, /坐标\(5,10\)/);
});

test('**关键**：拿不到坐标的节点仍要照常返回（不能因此丢掉它）', async () => {
  const withThrow = mkDeps({
    axNodes: [{ role: { value: 'button' }, name: { value: 'A' }, backendDOMNodeId: 1 }],
    boxFor: () => { throw new Error('Input.dispatchMouseEvent：节点已分离'); },
  });
  const r1 = await getAxSnapshot(withThrow, {});
  assert.equal(r1.ax.length, 1, 'getBoxModel 抛错不该丢掉节点');
  assert.equal(r1.ax[0].x, undefined);

  const noBox = mkDeps({
    axNodes: [{ role: { value: 'button' }, name: { value: 'B' }, backendDOMNodeId: 1 }],
    boxFor: () => ({ content: [1, 2] }), // 顶点不足 8 个
  });
  const r2 = await getAxSnapshot(noBox, {});
  assert.equal(r2.ax.length, 1, '框数据不完整也不该丢掉节点');
});

test('get_ax_snapshot：无 backendDOMNodeId 的节点不查坐标，直接返回', async () => {
  const deps = mkDeps({ axNodes: [{ role: { value: 'link' }, name: { value: 'L' } }] });
  const r = await getAxSnapshot(deps, {});
  assert.equal(r.ax.length, 1);
  assert.ok(!deps.calls.some((c) => c.op === 'getBoxModel'), '没有节点 id 就不该查坐标');
});

test('get_ax_snapshot：limit 被夹在 1..120，缺省 60', async () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ role: { value: 'button' }, name: { value: 'b' + i } }));
  assert.equal((await getAxSnapshot(mkDeps({ axNodes: many }), {})).ax.length, 60);
  assert.equal((await getAxSnapshot(mkDeps({ axNodes: many }), { limit: 999 })).ax.length, 120);
  assert.equal((await getAxSnapshot(mkDeps({ axNodes: many }), { limit: -3 })).ax.length, 1);
});

test('get_ax_snapshot：名称截断到 120 字（防止超长 aria-label 撑爆）', async () => {
  const deps = mkDeps({ axNodes: [{ role: { value: 'button' }, name: { value: 'x'.repeat(500) } }] });
  const r = await getAxSnapshot(deps, {});
  assert.equal(r.ax[0].name.length, 120);
});

test('get_ax_snapshot：一个交互节点都没有时返回"（无）"而不是空响应', async () => {
  const r = await getAxSnapshot(mkDeps({ axNodes: [] }), {});
  assert.equal(r.ok, true);
  assert.match(r.result, /（无）/);
});

test('get_ax_snapshot：CDP 抛错时剥掉域前缀', async () => {
  const deps = mkDeps({
    axNodes: null,
    cdp: { getFullAxTree: async () => { throw new Error('Accessibility.getFullAXTree：目标已关闭'); } },
  });
  const r = await getAxSnapshot(deps, {});
  assert.equal(r.ok, false);
  assert.match(r.result, /目标已关闭/);
  assert.ok(!/Accessibility\.getFullAXTree/.test(r.result));
});

test('INTERACTIVE_ROLES 只含可交互角色（不含文本/布局角色）', () => {
  for (const r of ['button', 'link', 'textbox', 'checkbox', 'tab', 'switch']) {
    assert.ok(INTERACTIVE_ROLES.has(r), r + ' 应被视为可交互');
  }
  for (const r of ['StaticText', 'generic', 'paragraph', 'heading']) {
    assert.ok(!INTERACTIVE_ROLES.has(r), r + ' 不该被视为可交互');
  }
});

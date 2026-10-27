// 并行预执行的**执行契约**测试。
//
// ## 为什么要有这个文件
//
// `runParallelBatch` 曾因 `Number(o.remaining) || 0` 恒为 0 而**永远返回空 Map** ——
// 并行从未真正执行过。而 `tests/parallel-tools.test.mjs` 只测了纯函数 `planParallelGroups`，
// 于是"分组算得对"与"真的并发跑了"这两件事之间有一段**没有任何覆盖的空隙**，
// bug 就掉在那段空隙里，且系统提示（intent-router 规则 12）已经向模型承诺了并发。
//
// 这个文件盯的正是那一段：不看分组算得对不对，只看**预执行到底有没有发生**。
//
// ⚠ 因此这里的判据必须是"结果"，不是"路径"：
//   · 两个 parallelSafe 调用 ⇒ 必须都被预执行，且**确实是并发的**（in-flight ≥ 2）；
//   · 非 parallelSafe 调用 ⇒ 必须一个都不预执行（退回串行路径）。
import test from 'node:test';
import assert from 'node:assert/strict';

// chrome 必须在 import agent.js **之前**装好：tools.js 在分派时才读它，
// 但保险起见先铺好全局，避免模块加载期的任何一次访问落空。
let inFlight = 0;
let maxInFlight = 0;
let queryCalls = 0;

globalThis.chrome = {
  tabs: {
    async query() {
      queryCalls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight -= 1;
      return [
        { id: 1, title: 'A', url: 'https://a.example/', active: true },
        { id: 2, title: 'B', url: 'https://b.example/', active: false },
      ];
    },
  },
  runtime: { lastError: null },
  storage: {
    local: {
      async get() {
        return {};
      },
      async set() {},
      async remove() {},
    },
  },
};

const { runParallelBatch } = await import('../lib/assistant/agent.ts');

function makeOpts(overrides = {}) {
  return Object.assign(
    {
      enabled: true,
      iter: 0,
      callIds: ['c0', 'c1'],
      disabledTools: new Set(),
      settings: { apiKey: 'test' },
      ctx: { pageUrl: 'https://a.example/', tabId: 1 },
      sessionApprovedTools: new Set(),
      budget: { toolTimeoutMs: 5000 },
      signal: undefined,
      emit: () => {},
      emitState: () => {},
      trace: () => {},
    },
    overrides
  );
}

function reset() {
  inFlight = 0;
  maxInFlight = 0;
  queryCalls = 0;
}

test('两个 parallelSafe 只读调用必须都被预执行（回归：remaining 恒 0 导致并行从未发生）', async () => {
  reset();
  const calls = [
    { name: 'list_tabs', args: {} },
    { name: 'list_tabs', args: {} },
  ];
  const got = await runParallelBatch(calls, makeOpts());
  assert.equal(got.size, 2, '两个 parallelSafe 调用都应被预执行，实际只预执行了 ' + got.size + ' 个');
  assert.equal(queryCalls, 2, '两个调用都应真正执行到底（而不是只进了分组没执行）');
  for (const [index, item] of got) {
    assert.ok(item && item.res, '下标 ' + index + ' 的预执行结果缺失');
    assert.notEqual(item.res.ok, false, '下标 ' + index + ' 的预执行失败：' + item.res.result);
  }
});

test('预执行必须是真的并发，不是顺序 await（in-flight ≥ 2）', async () => {
  reset();
  const calls = [
    { name: 'list_tabs', args: {} },
    { name: 'list_tabs', args: {} },
  ];
  await runParallelBatch(calls, makeOpts());
  assert.ok(
    maxInFlight >= 2,
    '两个调用应当同时在执行（实测最大并发 ' + maxInFlight + '）—— 若这里是 1，说明又退回成串行了'
  );
});

test('非 parallelSafe 的调用必须一个都不预执行（退回串行路径）', async () => {
  reset();
  const calls = [
    { name: 'click_element', args: { selector: '#x' } },
    { name: 'click_element', args: { selector: '#y' } },
  ];
  const got = await runParallelBatch(calls, makeOpts());
  assert.equal(got.size, 0, '写操作不得被并行预执行（它必须走带审批的串行路径）');
  assert.equal(queryCalls, 0, '既然没有预执行，就不该有任何一次真实工具调用发生');
});

test('enabled 为 false 时不预执行 —— 证明上面三条断言真的有牙齿', async () => {
  reset();
  const calls = [
    { name: 'list_tabs', args: {} },
    { name: 'list_tabs', args: {} },
  ];
  const got = await runParallelBatch(calls, makeOpts({ enabled: false }));
  assert.equal(got.size, 0, '关闭开关后应完全不预执行');
  assert.equal(queryCalls, 0, '关闭后不应发生任何工具调用');
  // 反证：如果"两个 parallelSafe 调用"这条断言在任何情况下都成立，它就没有牙齿。
  // 这里证明同一组调用在开关关闭时确实是空的 ⇒ 上面的 size===2 不是恒真。
});

test('单个调用不值得并发：应直接返回空（limit < 2 的短路仍然有效）', async () => {
  reset();
  const got = await runParallelBatch([{ name: 'list_tabs', args: {} }], makeOpts());
  assert.equal(got.size, 0, '只有一个调用时没有并发必要');
  assert.equal(queryCalls, 0, '不应发生工具调用');
});

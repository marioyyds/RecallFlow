// 并行工具调度：这是整条并行路径上唯一能被穷举测试的部分，也是最该被测的部分 ——
// 调度判错的代价（共享状态竞争、tool 结果与 tool_calls 配对错乱）远高于执行本身。
//
// 测试分三层：
//  ① planParallelGroups 的分组语义（纯函数，穷举边界）
//  ② parallelSafe 白名单的元数据不变式（防止有人把「只读」误当成「可并发」）
//  ③ 真实工具名单的正反例（写操作、切换标签页、依赖同轮前序结果的一律不得入选）
import test from 'node:test';
import assert from 'node:assert/strict';

import { planParallelGroups, DEFAULT_MAX_BATCH } from '../lib/assistant/parallel-tools.js';
import { TOOL_METADATA } from '../lib/assistant/tool-metadata.js';

const call = (name, args = {}) => ({ name, args });
const all = () => true;

// ---------------------------------------------------------------- 分组语义

test('planParallelGroups: 相邻的合格调用合成一组', () => {
  const groups = planParallelGroups([call('a'), call('b'), call('c')], { isParallelSafe: all });
  assert.deepEqual(groups, [[0, 1, 2]]);
});

test('planParallelGroups: 不合格调用会把相邻段切断', () => {
  const safe = (name) => name !== 'write';
  const groups = planParallelGroups([call('a'), call('write'), call('b')], { isParallelSafe: safe });
  assert.deepEqual(groups, [], '两段各自只有 1 个，并发无收益，应全部交回串行');
});

test('planParallelGroups: 长段被不合格调用切成多个合格段', () => {
  const safe = (name) => name !== 'write';
  const groups = planParallelGroups(
    [call('a'), call('b'), call('write'), call('c'), call('d')],
    { isParallelSafe: safe }
  );
  assert.deepEqual(groups, [[0, 1], [3, 4]]);
});

test('planParallelGroups: 单个调用不成组（并发没有收益）', () => {
  assert.deepEqual(planParallelGroups([call('a')], { isParallelSafe: all }), []);
  assert.deepEqual(planParallelGroups([], { isParallelSafe: all }), []);
  assert.deepEqual(planParallelGroups(null, { isParallelSafe: all }), []);
});

test('planParallelGroups: 超过 maxBatch 时切成多组，不丢调用', () => {
  const calls = Array.from({ length: 6 }, (_, i) => call('t' + i));
  const groups = planParallelGroups(calls, { isParallelSafe: all, maxBatch: 4 });
  assert.deepEqual(groups, [[0, 1, 2, 3], [4, 5]], '剩下的尾巴也要跑，只是换一组');
  const covered = groups.flat().sort((a, b) => a - b);
  assert.deepEqual(covered, [0, 1, 2, 3, 4, 5]);
});

test('planParallelGroups: maxBatch 下限为 2（不允许把并发关成 1）', () => {
  const groups = planParallelGroups([call('a'), call('b')], { isParallelSafe: all, maxBatch: 1 });
  assert.deepEqual(groups, [[0, 1]]);
});

test('planParallelGroups: DEFAULT_MAX_BATCH 生效', () => {
  // +2 而不是 +1：多出来的尾巴如果只剩 1 个就不成组，测不到"切第二组"
  const calls = Array.from({ length: DEFAULT_MAX_BATCH + 2 }, (_, i) => call('t' + i));
  const groups = planParallelGroups(calls, { isParallelSafe: all });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].length, DEFAULT_MAX_BATCH);
  assert.equal(groups[1].length, 2);
});

test('planParallelGroups: shouldSkip 命中即视为不合格并切断', () => {
  const groups = planParallelGroups([call('a'), call('b'), call('c')], {
    isParallelSafe: all,
    shouldSkip: (name) => name === 'b',
  });
  assert.deepEqual(groups, []);
});

test('planParallelGroups: 名字缺失的调用一律不合格', () => {
  const groups = planParallelGroups([call('a'), { args: {} }, call('b')], { isParallelSafe: all });
  assert.deepEqual(groups, []);
});

test('planParallelGroups: isParallelSafe 拿到的是原下标（方便调用方定位）', () => {
  const seen = [];
  planParallelGroups([call('a'), call('b'), call('c')], {
    isParallelSafe: (name, args, index) => {
      seen.push(index);
      return true;
    },
  });
  assert.deepEqual(seen, [0, 1, 2]);
});

// ---------------------------------------------------------------- 白名单不变式

const parallelSafeNames = Object.keys(TOOL_METADATA).filter((n) => TOOL_METADATA[n].parallelSafe === true);

// 非 readOnly 但确实是纯网络读取、无共享状态的例外。**新增例外必须在这里写明理由。**
const NON_READONLY_EXCEPTIONS = new Set([
  'fetch_webpage', // 纯 http 读取，只把失败的 URL 记进 ctx.failedUrls；需审批时不会进批次
]);

test('parallelSafe 白名单非空（否则这个特性等于没开）', () => {
  assert.ok(parallelSafeNames.length >= 5, '实际 ' + parallelSafeNames.length + ' 个');
});

test('parallelSafe 必须是只读工具（或白名单里写明理由的例外）', () => {
  const bad = parallelSafeNames.filter(
    (n) => TOOL_METADATA[n].readOnly !== true && !NON_READONLY_EXCEPTIONS.has(n)
  );
  assert.deepEqual(bad, [], '可并发的工具必须没有副作用；以下工具既非只读又不在例外里：' + bad.join(', '));
});

test('高危工具绝不并行（alwaysRequireApproval）', () => {
  const bad = parallelSafeNames.filter((n) => TOOL_METADATA[n].alwaysRequireApproval === true);
  assert.deepEqual(bad, []);
});

test('会切换标签页 / 改变当前页面的工具绝不并行', () => {
  // 它们会改 ctx.tabId / ctx.pageUrl，同批其它调用读到的是「哪个页面」就不确定了
  const forbidden = ['open_tab', 'switch_tab', 'click_element', 'scroll_page', 'run_javascript', 'click_at', 'run_macro'];
  for (const name of forbidden) {
    assert.notEqual(TOOL_METADATA[name].parallelSafe, true, name + ' 会改变页面状态，不得标记 parallelSafe');
  }
});

test('依赖同轮前序结果的工具绝不并行（这是最容易踩的坑）', () => {
  // expand_result 读 ctx.resultStore、get_run_trace 读 trace 文件，
  // 两者的写入都发生在「执行之后的串行后处理」里。并发会让它们读到本轮之前的旧状态。
  for (const name of ['expand_result', 'get_run_trace']) {
    assert.notEqual(TOOL_METADATA[name].parallelSafe, true, name + ' 依赖同轮前序写入，不得并行');
  }
});

test('循环内有专门分支的工具绝不并行', () => {
  for (const name of ['update_plan', 'load_skill', 'complete_task']) {
    assert.notEqual(TOOL_METADATA[name].parallelSafe, true, name + ' 在循环里有专门分支，不得并行');
  }
});

test('截图不并行（重且会向 UI 推图，同批没有收益）', () => {
  assert.notEqual(TOOL_METADATA.take_screenshot.parallelSafe, true);
});

// ---------------------------------------------------------------- 真实名单

test('真实白名单下：三个只读调用能成组', () => {
  const groups = planParallelGroups(
    [call('get_page_snapshot'), call('read_current_page'), call('get_element_text')],
    { isParallelSafe: (n) => TOOL_METADATA[n].parallelSafe === true }
  );
  assert.deepEqual(groups, [[0, 1, 2]]);
});

test('真实白名单下：读-写-读 不会被跨过写操作合并', () => {
  // 这是最危险的场景：把 click_element 夹在两次 snapshot 之间却并到一起，
  // 就等于让模型「点击之前看到点击之后」。
  const groups = planParallelGroups(
    [call('get_page_snapshot'), call('click_element'), call('get_page_snapshot')],
    { isParallelSafe: (n) => TOOL_METADATA[n].parallelSafe === true }
  );
  assert.deepEqual(groups, [], '写操作必须把读段切断');
});

test('真实白名单下：多个 web_search 能成组（收益最大的一类）', () => {
  const groups = planParallelGroups(
    [call('web_search', { query: 'a' }), call('web_search', { query: 'b' }), call('web_search', { query: 'c' })],
    { isParallelSafe: (n) => TOOL_METADATA[n].parallelSafe === true }
  );
  assert.deepEqual(groups, [[0, 1, 2]], '三个 20s 超时的搜索串行 = 最坏 60s');
});

test('真实白名单下：需要审批的 fetch_webpage 会被 shouldSkip 挡掉', () => {
  const sessionApproved = new Set(); // 用户还没放行过
  const groups = planParallelGroups(
    [call('fetch_webpage', { url: 'https://a' }), call('fetch_webpage', { url: 'https://b' })],
    {
      isParallelSafe: (n) => TOOL_METADATA[n].parallelSafe === true,
      shouldSkip: (n) => TOOL_METADATA[n].requiresApproval === true && !sessionApproved.has(n),
    }
  );
  assert.deepEqual(groups, [], '审批是交互式等待，无法并发');
});

test('真实白名单下：会话内已放行的 fetch_webpage 可以成组', () => {
  const sessionApproved = new Set(['fetch_webpage']); // 用户已在本任务内放行
  const groups = planParallelGroups(
    [call('fetch_webpage', { url: 'https://a' }), call('fetch_webpage', { url: 'https://b' })],
    {
      isParallelSafe: (n) => TOOL_METADATA[n].parallelSafe === true,
      shouldSkip: (n) => TOOL_METADATA[n].requiresApproval === true && !sessionApproved.has(n),
    }
  );
  assert.deepEqual(groups, [[0, 1]]);
});

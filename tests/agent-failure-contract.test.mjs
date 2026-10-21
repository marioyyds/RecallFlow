// 工具失败文案的契约测试。
//
// 为什么要单独测一句文案：`describeToolFailure` 的超时分支里那句
// 「**超时只表示我们不再等它，不代表动作没有发生**」是一条**安全提示**。
// 模型如果在超时后直接原样重试，就可能把一次已经生效的写操作再做一遍
// （重复下单、重复提交）。这句话是阻止它的唯一一道提示，因此它必须：
//   1. 真的出现在超时文案里；
//   2. 带上"先重新读取页面确认状态"这个具体动作，而不只是说"小心"。
// 此前这个函数**零覆盖** —— 改措辞的人不会知道自己在删一条安全网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeToolFailure } from '../lib/assistant/agent.js';

test('取消：AbortError 必须安静地收尾，不带工具名也不带重试暗示', () => {
  const msg = describeToolFailure({ name: 'AbortError' }, 'click_element');
  assert.equal(msg, '任务已取消。');
  assert.doesNotMatch(msg, /click_element/, '用户主动取消不该甩锅给工具');
});

test('超时：必须同时说明「秒数」「可能已生效」「先重读页面」三件事', () => {
  const msg = describeToolFailure({ rfToolTimeout: true, timeoutMs: 15000 }, 'take_screenshot');
  assert.match(msg, /take_screenshot/, '要指名是哪个工具超时');
  assert.match(msg, /15\s*秒/, '要给出实际秒数（用户据此判断要不要等）');
  assert.match(msg, /不代表动作没有发生/, '必须提示"超时 ≠ 没生效"，否则模型会原样重试');
  assert.match(msg, /get_page_snapshot|重新读取页面/, '必须给出"先确认当前状态"这个具体动作');
  assert.match(msg, /不要.*原样重试|未在确认/, '必须明确劝阻盲目重试');
});

test('超时秒数按四舍五入（1500ms 说成 2 秒比 1.5 秒更像人话）', () => {
  assert.match(describeToolFailure({ rfToolTimeout: true, timeoutMs: 1500 }, 'x'), /2\s*秒/);
  assert.match(describeToolFailure({ rfToolTimeout: true, timeoutMs: 1400 }, 'x'), /1\s*秒/);
  // 缺失 timeoutMs 时不得显示 NaN
  assert.doesNotMatch(describeToolFailure({ rfToolTimeout: true }, 'x'), /NaN/);
});

test('普通错误：带上工具名与原始 message', () => {
  const msg = describeToolFailure(new Error('no such element'), 'click_element');
  assert.match(msg, /click_element/);
  assert.match(msg, /no such element/, '原始原因必须保留 —— 它是定位问题的唯一线索');
});

test('脏输入不得抛，且必须如实说"不知道原因"而不是编一个', () => {
  // 空错误是最容易被写成"执行成功"的地方 —— 那会让失败静默消失。
  for (const bad of [null, undefined, {}, { message: '' }]) {
    const msg = describeToolFailure(bad, 'x');
    assert.match(msg, /失败|未知/, '脏输入 ' + JSON.stringify(bad) + ' 必须仍表达失败');
    assert.doesNotMatch(msg, /undefined|\[object Object\]/, '不得把脏值直接拼进文案');
  }
  assert.match(describeToolFailure(null, 'x'), /未知错误/, '没有原因时要明说"工具没给原因"');
});

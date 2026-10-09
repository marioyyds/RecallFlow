// 工具超时/异常必须给模型**可据以决策**的说明，而不是一句原文错误。
//
// 背景（会话 RF-V6T7C5）：agent 报了两处这类缺陷 ——
//   · `search_userscripts` 15s 超时
//   · `fetch_webpage` 抓 GitHub SPA 返回 `signal is aborted without reason`
// 调用点原先只写 `{ result: e.message, ok: false }`，于是模型看到的是一句
// 底层异常原文：既不知道**这是超时而不是干净失败**（动作可能已经部分生效），
// 也不知道下一步该做什么 —— 很容易据此原样重试，而重试一个「可能已经做了」的写操作是危险的。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { describeToolFailure } from '../lib/assistant/agent.js';

/** 造一个与 withTimeout 内部打标一致的超时错误。 */
const timeoutError = (ms, tool) => Object.assign(new Error('工具执行超时'), { rfToolTimeout: true, timeoutMs: ms, toolName: tool });

test('超时：说清是哪个工具、超时多久（用秒，不用裸 ms）', () => {
  const msg = describeToolFailure(timeoutError(15000, 'search_userscripts'), 'search_userscripts');
  assert.ok(msg.includes('search_userscripts'), msg);
  assert.ok(msg.includes('15 秒'), '应按秒表述，实际：' + msg);
  assert.ok(!/15000ms/.test(msg), '不该把裸 ms 丢给模型');
});

test('超时：必须点明「后果未知、可能已部分生效」', () => {
  const msg = describeToolFailure(timeoutError(15000, 'click_element'), 'click_element');
  assert.ok(/不代表动作没有发生|可能已经部分生效/.test(msg), '超时不是干净失败，必须说清：' + msg);
});

test('超时：必须给出下一步（先确认状态，不要原样重试）', () => {
  const msg = describeToolFailure(timeoutError(15000, 'type_text'), 'type_text');
  assert.ok(/重新读取页面|确认当前状态/.test(msg), '要给可执行的下一步：' + msg);
  assert.ok(/不要.*原样重试/.test(msg), '要明确劝阻盲目重试：' + msg);
});

test('用户中断（AbortError）与超时必须区分开', () => {
  const aborted = Object.assign(new Error('任务已取消'), { name: 'AbortError' });
  const msg = describeToolFailure(aborted, 'click_element');
  assert.equal(msg, '任务已取消。');
  assert.ok(!/超时/.test(msg), '用户主动停止不该被说成超时');
});

test('普通异常：带上工具名与原始原因', () => {
  const msg = describeToolFailure(new Error('未找到目标元素'), 'click_element');
  assert.ok(msg.includes('click_element') && msg.includes('未找到目标元素'), msg);
});

test('脏异常：非 Error / 空 / null / undefined 都不能产出 "undefined"', () => {
  for (const bad of [undefined, null, 'boom', 0, { }]) {
    const msg = describeToolFailure(bad, 'some_tool');
    assert.ok(typeof msg === 'string' && msg.length > 0, '不能给出空说明');
    assert.ok(!/undefined/.test(msg), '不该把 undefined 泄给模型：' + msg);
    assert.ok(msg.includes('some_tool'), msg);
  }
});

test('工具名为空也不崩（不能因为少个标签就丢掉整条说明）', () => {
  const msg = describeToolFailure(timeoutError(15000, ''), '');
  assert.ok(msg.includes('超时'), msg);
});

// ---------------------------------------------------------------- 接线

test('接线：withTimeout 必须给超时错误打标，调用点必须走 describeToolFailure', () => {
  const src = fs.readFileSync('lib/assistant/agent.js', 'utf8');
  assert.ok(/err\.rfToolTimeout = true/.test(src), 'withTimeout 要给超时错误打标，否则调用点无法区分它与工具自己抛的错');
  assert.ok(/describeToolFailure\(e, tc\.name\)/.test(src), '调用点要统一走 describeToolFailure');
  assert.ok(!/result: e\.name === 'AbortError' \? '任务已取消。' : e\.message/.test(src), '旧的内联写法应当已被替换');
  // timer 必须先声明为 null：否则 finish 里引用后面才 const 的 timer 会撞 TDZ。
  assert.ok(/let timer = null;/.test(src), 'timer 应先声明为 null，避免 TDZ');
});

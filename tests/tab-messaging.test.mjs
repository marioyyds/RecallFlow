// 发消息给标签页时的"可重试"判断。
//
// 为什么单测它：用户实测报过 browser_read 稳定失败
//   "Could not establish connection. Receiving end does not exist."
// 根因是内容脚本按 document_idle 注入，而 browser_read 是 open_tab 之后**立刻**读 ——
// 纯时序竞态。而原来 sendTabMessage 只发一次，一次失败就 reject，于是竞态变成了稳定失败。
//
// 这里钉住两件事：① 哪些错误值得等；② 等多久（有上下界，不能无限等）。
// 判定必须是纯函数，否则这段逻辑永远只会在真实浏览器里被验证。
import test from 'node:test';
import assert from 'node:assert/strict';

import { retryTabMessage, shouldRetryTabMessage, tabMessageRetryPlan, tabMessageTimeoutHint } from '../lib/shared/tab-messaging.js';

const RETRYABLE = 'Could not establish connection. Receiving end does not exist.';

test('retryTabMessage: 内容脚本晚到时会重试，最终成功', async () => {
  let calls = 0;
  const slept = [];
  const out = await retryTabMessage(
    async (n) => {
      calls = n;
      if (n < 4) throw new Error(RETRYABLE);
      return { ok: true, attempt: n };
    },
    { tabId: 7, sleep: async (ms) => slept.push(ms) }
  );
  assert.deepEqual(out, { ok: true, attempt: 4 }, '第 4 次成功，返回值应透传');
  assert.equal(calls, 4, '确实试了 4 次');
  assert.deepEqual(slept, [250, 250, 250], '前 3 次失败之间各等一个间隔');
});

test('retryTabMessage: 不该重试的错误立刻放弃（不浪费时间）', async () => {
  let calls = 0;
  const slept = [];
  await assert.rejects(
    () =>
      retryTabMessage(
        async () => {
          calls++;
          throw new Error('kbGetPageText 需要 options 参数');
        },
        { tabId: 7, sleep: async (ms) => slept.push(ms) }
      ),
    /kbGetPageText 需要 options 参数/,
    '原始错误要保留（否则定位不了）'
  );
  assert.equal(calls, 1, '只试一次');
  assert.deepEqual(slept, [], '不该等');
});

test('retryTabMessage: 试满就停，并带上可读的超时说明', async () => {
  let calls = 0;
  const slept = [];
  await assert.rejects(
    () =>
      retryTabMessage(
        async () => {
          calls++;
          throw new Error(RETRYABLE);
        },
        { tabId: 42, attempts: 3, intervalMs: 50, sleep: async (ms) => slept.push(ms) }
      ),
    (e) => {
      assert.match(e.message, /Receiving end does not exist/, '保留原始错误');
      assert.match(e.message, /42/, '带上 tabId');
      assert.match(e.message, /150ms/, '带上总等待时间（3 × 50）');
      assert.match(e.message, /刷新/, '提示"扩展刚重载过而页面还没刷新"这个已知原因');
      return true;
    }
  );
  assert.equal(calls, 3, '试满 attempts 次就停');
  assert.deepEqual(slept, [50, 50], '最后一次失败后不再等');
});


test('shouldRetryTabMessage: 只对"内容脚本还没注入"这类错误重试', () => {
  // 用户实测里出现的原文（Chrome 会把它塞进 chrome.runtime.lastError.message）
  assert.equal(shouldRetryTabMessage('Could not establish connection. Receiving end does not exist.'), true);
  assert.equal(shouldRetryTabMessage(new Error('Could not establish connection. Receiving end does not exist.')), true);
  assert.equal(shouldRetryTabMessage('The message port closed before a response was received.'), true);
  // 大小写无关
  assert.equal(shouldRetryTabMessage('RECEIVING END DOES NOT EXIST'), true);
  // 不该重试的：参数错 / 权限错 / 空错误 —— 重试只是浪费时间，必须立刻上报
  assert.equal(shouldRetryTabMessage('kbGetPageText 需要 options 参数'), false);
  assert.equal(shouldRetryTabMessage('Cannot access contents of the page'), false);
  assert.equal(shouldRetryTabMessage(''), false);
  assert.equal(shouldRetryTabMessage(null), false);
  assert.equal(shouldRetryTabMessage(undefined), false);
});

test('tabMessageRetryPlan: 默认约 3 秒，且次数与间隔都有上下界', () => {
  const d = tabMessageRetryPlan();
  assert.equal(d.attempts, 12);
  assert.equal(d.intervalMs, 250);
  assert.equal(d.totalMs, 3000, '总等待时间 = 次数 × 间隔');
  assert.ok(tabMessageRetryPlan({ attempts: 999 }).attempts <= 40, '次数有上限，不能无限等');
  assert.ok(tabMessageRetryPlan({ attempts: 0 }).attempts >= 1, '至少要试一次');
  assert.ok(tabMessageRetryPlan({ intervalMs: 99999 }).intervalMs <= 2000, '间隔有上限');
  assert.ok(tabMessageRetryPlan({ intervalMs: 1 }).intervalMs >= 20, '间隔有下限，避免忙等');
});

test('tabMessageTimeoutHint: 超时要能说清"等过了还是没人接"，而不是只抛原始错误', () => {
  const hint = tabMessageTimeoutHint(123, 3000);
  assert.match(hint, /123/, '要带 tabId');
  assert.match(hint, /3000ms/, '要带等的时间');
  assert.match(hint, /刷新/, '要提示"扩展刚重载过而页面还没刷新"这一已知原因');
});

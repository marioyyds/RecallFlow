// 校验阶段的两个线上症状（长时间卡住 / 反复校验）的回归门禁。
//
// 症状一：长任务收尾时"卡死"。根因是**两条缺陷叠加**，单独一条都不会致命：
//   ① 内部超时（llm.js 的 setTimeout → controller.abort()）抛出的也是 AbortError，
//      与用户按停止**完全无法区分**；verifyCompletion 按 e.name 判中断，于是
//      "25 秒没等到响应"被当成"用户点了停止"。
//   ② classifyVerifyOutcome 判成 interrupt 后，那条分支只 persist 就 return，
//      **没有 emit end** —— 而面板靠 run-hub 的 `case 'end'` 才把状态置为 ended。
//      结果：任务其实已经结束了，界面永远停在"运行中"。
//
// 症状二：反复校验。根因是同一份证据被反复送审（页面一个字节都没变，必然得到同样的否决），
// 外加确定性预检和 LLM 校验共用一个配额，规则命中两次就把 LLM 校验的预算吃光。
import test from 'node:test';
import assert from 'node:assert/strict';

import { callDeepSeek, isRetryableError, makeAbortError } from '../lib/assistant/llm.js';
import { verifyCompletion, buildRepeatedVerificationReflection, VERIFIER_TIMEOUT_MS } from '../lib/assistant/verifier.js';
import { classifyVerifyOutcome, verifyEvidenceSignature } from '../lib/assistant/agent.js';

const SETTINGS = { apiKey: 'k', baseUrl: 'https://example.invalid', model: 'm' };

/** 装一个可以按需驻留/报错的 fetch，并在测试结束后还原。 */
function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

// ---------------------------------------------------------------- ① 超时 ≠ 中断

test('超时被翻译成可识别的 TimeoutError，并且不再重试', async () => {
  // 让 fetch 一直挂着，直到内部 controller.abort() 把它打断 —— 这正是线上超时的形态。
  const restore = stubFetch((url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  }));
  try {
    let err = null;
    try {
      await callDeepSeek({ ...SETTINGS, requestTimeoutMs: 30 }, [{ role: 'user', content: 'x' }], new AbortController().signal);
    } catch (e) { err = e; }
    assert.ok(err, '超时必须抛错');
    assert.equal(err.name, 'TimeoutError', '不能把内部超时留成 AbortError（那会和用户中断混淆）');
    assert.equal(err.timeout, true, '要有 timeout 标记供上层识别');
    assert.equal(isRetryableError(err), false, '超时重试只会把等待乘三倍');
  } finally { restore(); }
});

test('用户中断仍然是 AbortError，且也不重试', async () => {
  const ctrl = new AbortController();
  const restore = stubFetch((url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(makeAbortError()));
  }));
  try {
    const p = callDeepSeek(SETTINGS, [{ role: 'user', content: 'x' }], ctrl.signal);
    ctrl.abort();
    let err = null;
    try { await p; } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.name, 'AbortError', '用户中断必须保持 AbortError，让上层按中断收尾');
    assert.notEqual(err.timeout, true);
    assert.equal(isRetryableError(err), false);
  } finally { restore(); }
});

test('signal 没被 abort 时，内部 AbortError 一律按 fail-open 处理（本次卡死的直接成因）', async () => {
  // 模拟"超时后 fetch 抛出 AbortError"那一刻：用户从未按停止。
  const restore = stubFetch(() => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')));
  try {
    const verdict = await verifyCompletion(
      SETTINGS,
      { instruction: 'x', claim: 'y', evidence: 'z', pageUrl: 'u', pageTitle: 't', taskKind: 'read' },
      new AbortController().signal
    );
    assert.equal(verdict, null, '这不是中断，必须返回 null（= 放行）而不是抛中断');
  } finally { restore(); }
});

test('signal 已 abort 时，verifyCompletion 抛中断（不能伪装成校验通过的放行）', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  let err = null;
  try {
    await verifyCompletion(
      SETTINGS,
      { instruction: 'x', claim: 'y', evidence: 'z', pageUrl: 'u', pageTitle: 't', taskKind: 'read' },
      ctrl.signal
    );
  } catch (e) { err = e; }
  assert.ok(err, '用户真的按了停止就必须抛');
  assert.equal(err.name, 'AbortError');
  assert.equal(classifyVerifyOutcome(null, err).kind, 'interrupt');
});

test('校验超时已放宽到 25 秒（15 秒在长任务上太紧）', () => {
  assert.ok(VERIFIER_TIMEOUT_MS >= 25000, '长任务的证据更密、判决更难，15 秒会稳定撞线');
});

// ---------------------------------------------------------------- ② 请求形态

test('校验调用限制输出长度并要求 JSON（否则输出散文就会 fail-open）', async () => {
  let captured = null;
  const restore = stubFetch((url, opts) => {
    captured = JSON.parse(opts.body);
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"ok":true,"confidence":0.9,"reason":"证据充分"}' } }] }),
    });
  });
  try {
    const verdict = await verifyCompletion(
      SETTINGS,
      { instruction: 'x', claim: 'y', evidence: 'z', pageUrl: 'u', pageTitle: 't', taskKind: 'read' },
      new AbortController().signal
    );
    assert.ok(captured, '应当真的发出了请求');
    assert.equal(captured.max_tokens, 400, '不设上限时模型会把预算耗在生成上');
    assert.equal(captured.response_format && captured.response_format.type, 'json_object', '不要求 JSON 时输出成散文 → 解析失败 → 护栏静默失效');
    assert.equal(captured.stream, false);
    // 顺手确认成功路径的解析（ok/confidence/reason 都要落到返回对象上）
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, '证据充分');
    assert.equal(verdict.confidence, 0.9);
  } finally { restore(); }
});

test('签名只看"有没有新东西"，不拼全文', () => {
  const ctx = {
    lastEvidence: '已高亮 12 处',
    lastSnapshot: { fingerprint: 'fp1' },
    lastReadFullText: 'a'.repeat(5000),
  };
  const a = verifyEvidenceSignature('总结 A', ctx);
  const b = verifyEvidenceSignature('总结 A', { ...ctx });
  assert.equal(a, b, '同样的证据必须得到同样的签名');
  assert.notEqual(a, verifyEvidenceSignature('总结 B', ctx), 'claim 变了签名就要变');
  assert.notEqual(a, verifyEvidenceSignature('总结 A', { ...ctx, lastEvidence: '已高亮 13 处' }), '动作回执变了说明做了新动作');
  assert.notEqual(a, verifyEvidenceSignature('总结 A', { ...ctx, lastSnapshot: { fingerprint: 'fp2' } }), '页面变了要重新校验');
  assert.ok(a.length < 8000, '签名不能随全文长度膨胀');
});

test('重复送审的反思必须指出"换说法没用"，并给出两条出路', () => {
  const m = buildRepeatedVerificationReflection();
  assert.match(m, /完全一致|没有任何新证据/, '要点明证据没变这个事实');
  assert.match(m, /换个说法|同样的结论/, '要明确"改措辞"不会有不同结果');
  assert.match(m, /重新读取页面|checkTexts/, '出路一：产生新证据');
  assert.match(m, /如实说明/, '出路二：如实收尾（没有出口的催促会让模型一直耗）');
});

// ---------------------------------------------------------------- ③ 重试预算

test('校验器不重试：25 秒的预算不能被叠成 76 秒', async () => {
  let calls = 0;
  const restore = stubFetch(() => {
    calls += 1;
    return Promise.resolve({
      ok: false,
      status: 429,
      text: async () => '{"error":{"message":"rate limited"}}',
    });
  });
  try {
    const verdict = await verifyCompletion(
      SETTINGS,
      { instruction: 'x', claim: 'y', evidence: 'z', pageUrl: 'u', pageTitle: 't', taskKind: 'read' },
      new AbortController().signal
    );
    assert.equal(calls, 1, '429 时不能重试 —— 校验是 fail-open 的安全网，重试只换来卡顿');
    assert.equal(verdict, null, '失败后按 fail-open 放行，不能阻塞收尾');
  } finally { restore(); }
});

test('普通调用仍然保留默认重试（只有校验器关掉了它）', async () => {
  let calls = 0;
  const restore = stubFetch(() => {
    calls += 1;
    return Promise.resolve({ ok: false, status: 500, text: async () => '{"error":{"message":"boom"}}' });
  });
  try {
    let err = null;
    try { await callDeepSeek(SETTINGS, [{ role: 'user', content: 'x' }], new AbortController().signal); } catch (e) { err = e; }
    assert.ok(err, '两次重试后仍失败，应当抛错');
    assert.equal(calls, 3, '默认行为不能被顺手改掉：首次 + 2 次重试');
  } finally { restore(); }
});

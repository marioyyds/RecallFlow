// 「用户按了停止」这条路径的重试语义 —— 它此前是错的，而且错得很贵。
//
// 起因：`isRetryableError(e)` 只看 `e.status`，而 AbortError 根本没有 status ⇒
// 走进 `if (!e.status) return true`（原本是给网络抖动用的一支）⇒ **把用户中断当成"值得重试"**。
// 后果有三层，一层比一层难发现：
//   ① 停止按钮变慢：多等两次退避（0.5s + 1s）；
//   ② 在用户已经放弃的任务上继续花钱（重试会**真的再发请求**）；
//   ③ 更隐蔽的一层：`callDeepSeekOnce` 用 `signal.addEventListener('abort')` 转发中断，
//      而对**已经 abort 过**的 signal 再加监听**永远不会触发**（事件是一次性的）——
//      于是"已经中断"的请求会照常发出去，一字节都不省。
//
// 第三层的下游更糟：完成校验 `verifyCompletion()` 把所有异常都吞成 `null`（fail-open），
// 于是一次 abort 会被读成"校验器故障 ⇒ 按通过放行"，然后一路走到
// `emitState(COMPLETED)` 并持久化"任务已完成" —— 用户按了停止，记录里却写着完成。
//
// 这里钉住四件事：中断不重试、中断不发请求、真故障仍然重试、真故障仍然 fail-open。
import test from 'node:test';
import assert from 'node:assert/strict';
import { callDeepSeek, isRetryableError, makeAbortError } from '../lib/assistant/llm.js';
import { verifyCompletion } from '../lib/assistant/verifier.js';
import { classifyVerifyOutcome } from '../lib/assistant/agent.js';

const ORIGINAL_FETCH = globalThis.fetch;

const SETTINGS = {
  apiKey: 'test-key',
  baseUrl: 'https://example.invalid/v1',
  model: 'deepseek-chat',
  requestTimeoutMs: 5000,
};

const okResponse = (content = 'ok') => ({
  ok: true,
  status: 200,
  async json() {
    return { choices: [{ message: { role: 'assistant', content } }] };
  },
  async text() {
    return '';
  },
});

test('中断不是"可重试的故障"：AbortError 必须被判为不可重试', () => {
  // 判别式要**同时**钉住两边：只写 false 一侧的话，把整个函数改成 return false
  // 也能过（那时"网络抖动不重试"就静默丢了）。
  assert.equal(isRetryableError(makeAbortError()), false, '用户中断不该重试');
  const fakeAbort = new Error('The operation was aborted.');
  fakeAbort.name = 'AbortError';
  assert.equal(isRetryableError(fakeAbort), false, '只看 name 的实现也要判对');
  // 另一侧：真正的可重试错误不能被这次收紧误伤
  assert.equal(isRetryableError({ status: 429 }), true, '限流应当重试');
  assert.equal(isRetryableError({ status: 503 }), true, '5xx 应当重试');
  assert.equal(isRetryableError(new TypeError('fetch failed')), true, '网络错误（无 status）应当重试');
  assert.equal(isRetryableError({ status: 400 }), false, '4xx 不该重试（请求本身有问题）');
});

test('已经中断的 signal：一个请求都不发', async () => {
  // 这一条最关键：它不依赖 AbortError 的传递链。`addEventListener` 对已 abort 的 signal
  // 不触发 ⇒ 若没有这里的早退，请求会照常发出去、照常计费。
  const ctrl = new AbortController();
  ctrl.abort();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return okResponse();
  };
  try {
    await assert.rejects(
      () => callDeepSeek(SETTINGS, [{ role: 'user', content: 'hi' }], ctrl.signal),
      (e) => e.name === 'AbortError',
      '已中断时必须直接抛 AbortError'
    );
    assert.equal(calls, 0, '已经中断了还发请求 —— 这是在用户放弃的任务上继续花钱');
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});

test('请求进行中被中断：不重试（fetch 只被调用一次）', async () => {
  const ctrl = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    ctrl.abort(); // 模拟"请求发出去之后用户按了停止"
    throw makeAbortError();
  };
  try {
    await assert.rejects(
      () => callDeepSeek(SETTINGS, [{ role: 'user', content: 'hi' }], ctrl.signal),
      (e) => e.name === 'AbortError'
    );
    assert.equal(calls, 1, '中断后仍在重试：停止会变慢，而且重复发请求');
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});

test('真故障仍然重试（收紧中断不能把重试一起关掉）', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        async text() {
          return '{"error":{"message":"rate limited"}}';
        },
        async json() {
          return {};
        },
      };
    }
    return okResponse('第二次成功');
  };
  try {
    const out = await callDeepSeek(SETTINGS, [{ role: 'user', content: 'hi' }]);
    assert.equal(out, '第二次成功');
    assert.equal(calls, 2, '一次 429 之后应当重试一次就成功');
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});

test('完成校验：中断必须抛出，不能被吞成「按通过放行」', async () => {
  // 这是本组测试的**用户可见后果**：verifyCompletion 返回 null 时，agent 会发
  // 「校验器未能给出结论，已按通过放行」并继续走"任务已完成"的收尾 —— 而用户按的是停止。
  const ctrl = new AbortController();
  ctrl.abort();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return okResponse('{"ok":true}');
  };
  try {
    await assert.rejects(
      () =>
        verifyCompletion(
          SETTINGS,
          { instruction: '点提交', claim: '已完成', evidence: '…', pageUrl: 'u', pageTitle: 't', taskKind: 'mutation' },
          ctrl.signal
        ),
      (e) => e.name === 'AbortError',
      '中断必须是异常，而不是 null（null 会被读成"校验通过"）'
    );
    assert.equal(calls, 0, '中断后不该再花一次校验请求');
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});

test('完成校验：真故障仍然 fail-open（校验器挂了不该卡住用户）', async () => {
  // 反向钉住：上面那条改成"一律抛出"就过头了 —— 校验器是安全网，它自己坏掉时
  // 必须放行，否则一次网络抖动会让用户的整个任务卡死。
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 400,
      async text() {
        return '{"error":{"message":"bad request"}}';
      },
      async json() {
        return {};
      },
    };
  };
  try {
    const verdict = await verifyCompletion(SETTINGS, {
      instruction: '点提交',
      claim: '已完成',
      evidence: '…',
      pageUrl: 'u',
      pageTitle: 't',
      taskKind: 'mutation',
    });
    assert.equal(verdict, null, '校验器故障应当返回 null（调用方按通过放行）');
    assert.equal(calls, 1, '400 不该重试');
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});
test('请求抛错时也必须解绑外部 signal 的监听（原先 fetch 一抛就跳过清理）', async () => {
  // 这一条测的是**资源**而不是返回值：原先 `clearTimeout` / `removeEventListener` 写在
  // `await fetch(...)` 之后，fetch 一抛就被跳过 —— 定时器最长挂 60 秒（每个失败请求一个）。
  // 不能直接观察定时器，就观察它的同伴：解绑次数。
  let added = 0;
  let removed = 0;
  const fakeSignal = {
    aborted: false,
    addEventListener() {
      added += 1;
    },
    removeEventListener() {
      removed += 1;
    },
  };
  globalThis.fetch = async () => {
    const e = new Error('bad request');
    e.status = 400; // 不可重试，只跑一次
    throw e;
  };
  try {
    await assert.rejects(() => callDeepSeek(SETTINGS, [{ role: 'user', content: 'hi' }], fakeSignal));
    assert.equal(added, 1, '前提：确实注册了中断转发');
    assert.equal(removed, 1, '失败路径没解绑：定时器与监听都留在原地');
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});
test('完成校验的结局分派：中断 / 故障 / 有结论，三者不能混（agent 循环的判据）', () => {
  // 上面两条只钉住了「verifier 会不会抛」；真正决定用户看到什么的是 agent 怎么读它。
  // 三种结局混任意两种都有用户可见后果，所以这里逐一对号：
  assert.deepEqual(classifyVerifyOutcome(null, makeAbortError()), { kind: 'interrupt' }, '中断必须走中断收尾');
  assert.deepEqual(
    classifyVerifyOutcome(null, new TypeError('fetch failed')),
    { kind: 'fail-open' },
    '真故障仍然按通过放行（否则一次网络抖动会卡死整个任务）'
  );
  assert.deepEqual(classifyVerifyOutcome(null, null), { kind: 'fail-open' }, '校验器给空结果 = 没有结论 = 放行');
  const verdict = { ok: false, reason: '未达成' };
  assert.deepEqual(classifyVerifyOutcome(verdict, null), { kind: 'verdict', verdict }, '有结论就按结论分派');
  // 关键的不对称：**同一个 null**，带中断理由和带故障理由必须走向不同分支。
  assert.notDeepEqual(
    classifyVerifyOutcome(null, makeAbortError()).kind,
    classifyVerifyOutcome(null, new Error('timeout')).kind,
    '中断与故障必须可区分 —— 这正是原来那个 .catch(() => null) 抹掉的信息'
  );
});

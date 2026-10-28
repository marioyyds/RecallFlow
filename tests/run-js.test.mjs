import test from 'node:test';
import assert from 'node:assert/strict';

import { runJs } from '../lib/application/page/run-js.ts';

test('runJs：空代码和超长代码在执行前失败', async () => {
  assert.deepEqual(await runJs({}), {
    ok: false,
    error: 'run_javascript 需要 code 参数',
  });
  assert.deepEqual(await runJs({ code: '   ' }), {
    ok: false,
    error: 'run_javascript 需要 code 参数',
  });

  const tooLong = await runJs({ code: 'x'.repeat(20001) });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /上限 20000 字符/);
});

test('runJs：同步值被格式化为 JSON，undefined 有稳定表示', async () => {
  const object = await runJs({ code: 'return { answer: 42, nested: [true, null] };' });
  assert.deepEqual(object, {
    ok: true,
    result: '{\n  "answer": 42,\n  "nested": [\n    true,\n    null\n  ]\n}',
  });
  assert.deepEqual(await runJs({ code: 'return undefined;' }), {
    ok: true,
    result: 'undefined',
  });
});

test('runJs：等待 Promise，并区分同步、异步错误', async () => {
  assert.deepEqual(await runJs({ code: 'return await Promise.resolve("done");' }), {
    ok: true,
    result: '"done"',
  });

  const syncError = await runJs({ code: 'return {' });
  assert.equal(syncError.ok, false);
  assert.match(syncError.error, /^JS 执行出错：/);

  const asyncError = await runJs({ code: 'throw new Error("later");' });
  assert.equal(asyncError.ok, false);
  assert.match(asyncError.error, /^异步 JS 执行出错：later$/);
});

test('runJs：结果有上限，且危险全局在沙箱内不可见', async () => {
  const long = await runJs({ code: 'return "x".repeat(2500);' });
  assert.equal(long.ok, true);
  assert.ok(long.result.length < 2100);
  assert.match(long.result, /结果过长已截断/);

  assert.deepEqual(
    await runJs({
      code: [
        'return {',
        '  fetch: typeof fetch,',
        '  chrome: typeof chrome,',
        '  storage: typeof localStorage,',
        '  hasFetch: "fetch" in window,',
        '};',
      ].join('\n'),
    }),
    {
      ok: true,
      result: '{\n  "fetch": "undefined",\n  "chrome": "undefined",\n  "storage": "undefined",\n  "hasFetch": false\n}',
    }
  );
});

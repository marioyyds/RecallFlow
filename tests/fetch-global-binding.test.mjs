// 回归：fetch_webpage 的生产接线必须把原生 fetch 绑定到全局对象。
//
// 背景（会话 RF-45DHH4）：C-1 重构把 `fetch(url)` 改成 `deps.fetchImpl(url)` 后，
// 调用时的 this 从全局对象变成了 deps 对象。原生 fetch 是 WebIDL 方法，
// Chrome 在 Service Worker 里因此抛出：
//   TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation
//
// 旧的单测都注入普通 async mock，普通函数不关心 this，所以没有覆盖到这类回归。
// 这条测试直接走 executeTool 的生产接线，并用一个「像原生 fetch 一样检查 this」
// 的替身来确认绑定确实生效。
import test from 'node:test';
import assert from 'node:assert/strict';

test('生产接线：fetch_webpage 的 fetchImpl 绑定全局对象，不得抛 Illegal invocation', async () => {
  const originalFetch = globalThis.fetch;
  let observedThis = null;

  globalThis.fetch = function nativeLikeFetch() {
    observedThis = this;
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation");
    }
    return Promise.resolve(
      new Response('<html><head><title>测试页</title></head><body>' + '正文'.repeat(200) + '</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    );
  };

  try {
    // 带 query 的 import 让本文件拿到一份在替身 fetch 安装后加载的新模块实例。
    const { executeTool } = await import('../lib/assistant/tools.js?fetch-global-binding');
    const ctx = { failedUrls: [] };
    const r = await executeTool('fetch_webpage', { url: 'https://example.test/page' }, ctx);

    assert.equal(observedThis, globalThis, 'deps.fetchImpl(...) 的方法调用不得把 this 变成 deps');
    assert.notEqual(r.ok, false, '抓取应成功，而不是返回 Illegal invocation：' + (r.result || ''));
    assert.match(r.result, /网页正文/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

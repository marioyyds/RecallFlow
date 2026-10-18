// fetch-tools.js：联网抓取与搜索族（C-1 拆出的第 6 族）。
//
// 抽取的收益：这一族有三条**踩过坑才写成**的语义，以前埋在巨型 switch 里只能靠真实网络碰运气：
//   1. 只有**确定性失败**才进 ctx.failedUrls（永久拉黑）；**超时/中止绝不能进**；
//   2. SPA 骨架 / 过短内容**不登记为参考来源**；
//   3. 搜索结果本身**不是**参考来源。
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchWebpage, webSearch, FETCH_TOOLS, handleFetchTool } from '../lib/assistant/fetch-tools.js';

/** 造一个假的 fetch 响应。 */
function mkResp({ ok = true, status = 200, ct = 'text/html', url = '', body = '', throwOnBody = null } = {}) {
  return {
    ok,
    status,
    url,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? ct : null) },
    body: { _fake: true },
    _body: body,
    _throwOnBody: throwOnBody,
  };
}

function mkDeps(overrides = {}) {
  const deps = {
    ctx: { failedUrls: [] },
    fetchImpl: async () => mkResp({ body: '<html><body>正文很长'.padEnd(400, 'x') + '</body></html>' }),
    readBounded: async () => new Uint8Array([1, 2, 3]),
    decodeBuffer: () => ({ decode: () => String(deps._raw || '<html><body>' + '正文'.repeat(200) + '</body></html>') }),
    stripHtml: (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    extractHtmlTitle: () => '页面标题',
    searchWeb: async () => [{ title: 'T1', url: 'https://a.test/1', snippet: 'S1' }],
    isAbortLikeError: (e) => /aborted|AbortError/i.test(String((e && e.name) + (e && e.message))),
    describeFetchError: (e, url, ms) => '抓取失败说明：' + (e && e.message ? e.message : e) + ' @' + url,
    ...overrides,
  };
  return deps;
}

test('FETCH_TOOLS 覆盖两个工具名', () => {
  assert.deepEqual([...FETCH_TOOLS].sort(), ['fetch_webpage', 'web_search']);
});

test('handleFetchTool：不属于本族返回 null', async () => {
  assert.equal(await handleFetchTool('click_element', {}, mkDeps()), null);
});

test('fetch_webpage：拒绝非 http/https（不发起请求）', async () => {
  let called = false;
  const deps = mkDeps({ fetchImpl: async () => { called = true; return mkResp(); } });
  for (const bad of ['', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://a.test']) {
    const r = await fetchWebpage(deps, { url: bad });
    assert.equal(r.ok, false, bad + ' 应被拒绝');
    assert.match(r.result, /仅支持 http\/https/);
  }
  assert.equal(called, false, '非法 URL 不该发起网络请求');
});

test('fetch_webpage：已拉黑的 URL 直接拒绝，且不发请求', async () => {
  let called = false;
  const deps = mkDeps({ fetchImpl: async () => { called = true; return mkResp(); } });
  deps.ctx.failedUrls = ['https://dead.test']; // 去尾斜杠后的形态
  const r = await fetchWebpage(deps, { url: 'https://dead.test/' });
  assert.equal(r.ok, false);
  assert.match(r.result, /此前已抓取失败.*请勿重试/s);
  assert.equal(called, false, '拉黑后不得再发请求');
});

test('fetch_webpage：HTTP 状态码失败 → 记入永久拉黑', async () => {
  const deps = mkDeps({ fetchImpl: async () => mkResp({ ok: false, status: 404 }) });
  const r = await fetchWebpage(deps, { url: 'https://a.test/missing' });
  assert.equal(r.ok, false);
  assert.match(r.result, /抓取失败 \(404\)/);
  assert.deepEqual(deps.ctx.failedUrls, ['https://a.test/missing'], '确定性失败应拉黑');
});

test('fetch_webpage：401 返回登录提示，且不把 URL 永久拉黑', async () => {
  const deps = mkDeps({ fetchImpl: async () => mkResp({ ok: false, status: 401 }) });
  const r = await fetchWebpage(deps, { url: 'https://a.test/private' });
  assert.equal(r.ok, false);
  assert.equal(r.needsLogin, true);
  assert.equal(r.authChallenge.reason, 'login-required');
  assert.match(r.result, /登录 \/ 授权入口：https:\/\/a\.test\/login/);
  assert.deepEqual(deps.ctx.failedUrls, [], '登录后同一 URL 仍可用，不能永久拉黑');
});

test('fetch_webpage：200 的登录重定向按登录墙处理', async () => {
  const deps = mkDeps({
    fetchImpl: async () =>
      mkResp({
        body: '<html><head><title>账号登录</title></head><body>请先登录后继续</body></html>',
        url: 'https://a.test/login?return=%2Fprivate',
      }),
  });
  const r = await fetchWebpage(deps, { url: 'https://a.test/private' });
  assert.equal(r.ok, false);
  assert.equal(r.needsLogin, true);
  assert.equal(r.authChallenge.loginUrl, 'https://a.test/login?return=%2Fprivate');
  assert.deepEqual(deps.ctx.failedUrls, [], '用户登录后可以重试同一目标 URL');
});

test('fetch_webpage：非文本内容类型 → 记入永久拉黑', async () => {
  const deps = mkDeps({ fetchImpl: async () => mkResp({ ct: 'application/pdf' }) });
  const r = await fetchWebpage(deps, { url: 'https://a.test/a.pdf' });
  assert.equal(r.ok, false);
  assert.match(r.result, /非文本内容/);
  assert.equal(deps.ctx.failedUrls.length, 1);
});

test('fetch_webpage：正文为空 → 记入永久拉黑', async () => {
  const deps = mkDeps({
    fetchImpl: async () => mkResp(),
    stripHtml: () => '   ',
  });
  const r = await fetchWebpage(deps, { url: 'https://a.test/empty' });
  assert.equal(r.ok, false);
  assert.match(r.result, /正文为空/);
  assert.equal(deps.ctx.failedUrls.length, 1);
});

test('**关键**：超时/中止是暂时性失败，绝不能进永久拉黑名单', async () => {
  // 这是这一族最重要的不变式：一旦把超时记进 failedUrls，
  // 同一 URL 在本任务后续轮次会被直接拒绝 —— 而它可能只是慢了一次。
  const abortErr = new Error('signal is aborted without reason');
  abortErr.name = 'AbortError';
  const deps = mkDeps({ fetchImpl: async () => { throw abortErr; } });
  const r = await fetchWebpage(deps, { url: 'https://slow.test/' });
  assert.equal(r.ok, false);
  assert.deepEqual(deps.ctx.failedUrls, [], '超时不得进入永久拉黑名单');
  assert.match(r.result, /抓取失败说明/);
});

test('**关键**：非中止类的异常（如跨域）仍然要拉黑', async () => {
  const netErr = new Error('Failed to fetch');
  const deps = mkDeps({ fetchImpl: async () => { throw netErr; } });
  const r = await fetchWebpage(deps, { url: 'https://cors.test/' });
  assert.equal(r.ok, false);
  assert.deepEqual(deps.ctx.failedUrls, ['https://cors.test'], '确定性网络失败应拉黑');
});

test('fetch_webpage：正常正文产生引用，并带标题与 URL', async () => {
  const deps = mkDeps();
  const r = await fetchWebpage(deps, { url: 'https://a.test/page' });
  assert.match(r.result, /网页正文/);
  assert.ok(Array.isArray(r.citations), '实质性正文应登记为参考来源');
  assert.equal(r.citations[0].source, 'web');
  assert.equal(r.citations[0].title, '页面标题');
  assert.equal(r.citations[0].url, 'https://a.test/page');
  assert.deepEqual(deps.ctx.failedUrls, []);
});

test('fetch_webpage：疑似 SPA 骨架时给出改用 open_tab 的指引，且不登记来源', async () => {
  // 注意：正文必须**非空但很短**才能走到 SPA 分支。
  // 若正文完全为空，会先命中"正文为空"那条（确定性失败 → 拉黑），
  // 而不是 SPA 提示 —— 两者是不同的分支，别把它们混成一个用例。
  const deps = mkDeps({
    decodeBuffer: () => ({
      decode: () =>
        '<html><head><script src="app.js"></script></head><body>' +
        '<div id="root"></div><p>加载中…</p></body></html>',
    }),
  });
  const r = await fetchWebpage(deps, { url: 'https://spa.test/' });
  assert.match(r.result, /疑似前端 JS 渲染（SPA）/, '应给出 SPA 提示');
  assert.match(r.result, /open_tab/, '应引导改用 open_tab');
  assert.ok(!r.citations, 'SPA 骨架不应登记为参考来源（否则会占掉来源编号）');
  assert.deepEqual(deps.ctx.failedUrls, [], 'SPA 不算失败，不该拉黑');
});

test('fetch_webpage：正文完全为空与"疑似 SPA"是两条不同分支', async () => {
  // 0 字正文 → "正文为空"（确定性失败，拉黑）；短但有字 → SPA 提示（不算失败）。
  const empty = mkDeps({
    decodeBuffer: () => ({ decode: () => '<html><head><script src="a.js"></script></head><body></body></html>' }),
  });
  const r1 = await fetchWebpage(empty, { url: 'https://empty.test/' });
  assert.match(r1.result, /正文为空/);
  assert.equal(empty.ctx.failedUrls.length, 1, '空正文是确定性失败，应拉黑');
});

test('fetch_webpage：过短但非 SPA 的内容不产生引用，但也不算失败', async () => {
  const deps = mkDeps({
    decodeBuffer: () => ({ decode: () => '<html><body>' + '短'.repeat(50) + '</body></html>' }),
  });
  const r = await fetchWebpage(deps, { url: 'https://short.test/' });
  assert.ok(!r.citations, '内容不足以作为来源');
  assert.match(r.result, /不足以作为参考来源/);
  assert.deepEqual(deps.ctx.failedUrls, [], '内容短不是失败');
});

test('fetch_webpage：内容过大时如实标注已截断', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024);
  const deps = mkDeps({
    readBounded: async () => new Uint8Array(2 * 1024 * 1024), // 达到 maxBytes → truncated
    decodeBuffer: () => ({ decode: () => '<html><body>' + big + '</body></html>' }),
  });
  const r = await fetchWebpage(deps, { url: 'https://big.test/' });
  assert.match(r.result, /内容过大已截断/);
  assert.ok(r.result.length < 12000, '正文应被截到 8000 字左右，不能把整页塞给模型');
});

test('fetch_webpage：ctx.failedUrls 缺省时自动初始化（不因 undefined 抛错）', async () => {
  const deps = mkDeps({ fetchImpl: async () => mkResp({ ok: false, status: 500 }) });
  deps.ctx = {};
  const r = await fetchWebpage(deps, { url: 'https://a.test/' });
  assert.equal(r.ok, false);
  assert.deepEqual(deps.ctx.failedUrls, ['https://a.test']);
});

// ---------------------------------------------------------------- web_search

test('web_search：缺 query 时失败', async () => {
  const r = await webSearch(mkDeps(), {});
  assert.equal(r.ok, false);
  assert.match(r.result, /请提供搜索关键词/);
});

test('web_search：maxResults 被夹在 1..10', async () => {
  let seen = null;
  const deps = mkDeps({ searchWeb: async (q, n) => { seen = n; return [{ title: 'T', url: 'u' }]; } });
  await webSearch(deps, { query: 'q', maxResults: 999 });
  assert.equal(seen, 10, '上限为 10');
  await webSearch(deps, { query: 'q', maxResults: -5 });
  assert.equal(seen, 1, '负数应回落到下限 1');
  await webSearch(deps, { query: 'q' });
  assert.equal(seen, 6, '缺省应为 6');
  // 注意：0 走的是 `Number(x) || 6` 的**默认值**分支 → 6，不是下限 1。
  // 这与"负数被夹到 1"是两条不同的路径，已按实际行为断言（不为迎合测试改代码）。
  await webSearch(deps, { query: 'q', maxResults: 0 });
  assert.equal(seen, 6, '0 视为"未提供"，回落到默认 6');
});

test('web_search：无结果时给出可执行的下一步', async () => {
  const deps = mkDeps({ searchWeb: async () => [] });
  const r = await webSearch(deps, { query: 'q' });
  assert.equal(r.ok, false);
  assert.match(r.result, /未搜索到结果/);
  assert.match(r.result, /open_tab/);
});

test('**关键**：搜索结果的文案必须说明"它不是参考来源"', async () => {
  // 否则来源区会被搜索快照刷屏，并占用全局引用编号。
  const r = await webSearch(mkDeps(), { query: '跨域' });
  assert.ok(!r.citations, '搜索结果不得产生 citations');
  assert.match(r.result, /不属于参考来源/, '必须明确告诉模型这不是来源');
  assert.match(r.result, /读取后的页面会登记为参考来源编号/);
  assert.match(r.result, /\[1\] T1/);
  assert.match(r.result, /https:\/\/a\.test\/1/);
  assert.match(r.result, /S1/);
});

test('web_search：抛错时返回可读失败（不冒泡）', async () => {
  const deps = mkDeps({ searchWeb: async () => { throw new Error('网络不可达'); } });
  const r = await webSearch(deps, { query: 'q' });
  assert.equal(r.ok, false);
  assert.match(r.result, /网络搜索失败：网络不可达/);
});

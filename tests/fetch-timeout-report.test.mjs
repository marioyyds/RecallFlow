// 抓取/检索的超时不能与「页面有问题」混为一谈。
//
// 会话 RF-V6T7C5 里 agent 报了这个缺陷：
//   fetch_webpage 抓 GitHub README → 返回 `signal is aborted without reason`，
//   于是它在报告里把失败归因成「目标站疑似前端 JS 渲染（SPA）页面」。
//
// 真相是 **15 秒没响应**（`AbortController.abort()` 且没给 reason，Chrome 的文案就是
// `signal is aborted without reason`），我们**根本没拿到任何内容** ——
// 那时根本无从判断页面类型。**错误归因比没有归因更糟**：它会让模型和用户
// 一起往「跨域 / host_permissions / SPA」的方向排查。
//
// 第二处同源缺陷：`ctx.failedUrls` 是「请勿重试该 URL」的**永久**名单，
// 而超时是**暂时性**失败 —— 记进去会让同一 URL 在本任务后续轮次被直接拒绝。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { isAbortLikeError, describeFetchError } from '../lib/assistant/tools.js';

/** 造一个「未给 reason 的 abort」——实测 Chrome 的文案。 */
const abortErr = () => new DOMException('signal is aborted without reason', 'AbortError');

test('isAbortLikeError: 认 name，也认各内核不同的中止文案', () => {
  assert.equal(isAbortLikeError(abortErr()), true);
  // 有些路径拿到的不是 AbortError 而是普通 Error，只能靠文案认。
  assert.equal(isAbortLikeError(new Error('signal is aborted without reason')), true);
  assert.equal(isAbortLikeError(new Error('The user aborted a request.')), true);
  assert.equal(isAbortLikeError(new Error('The operation was aborted.')), true);
  assert.equal(isAbortLikeError(new Error('Failed to fetch')), false, '普通网络错误不算中止');
  assert.equal(isAbortLikeError(new Error('抓取失败 (404)')), false);
  assert.equal(isAbortLikeError(null), false);
  assert.equal(isAbortLikeError(undefined), false);
});

test('抓取超时：不得把它说成页面/SPA/跨域的问题', () => {
  const msg = describeFetchError(abortErr(), 'https://github.com/x/y', 15000);
  assert.ok(msg.includes('超时'), msg);
  assert.ok(msg.includes('15 秒'), msg);
  assert.ok(msg.includes('https://github.com/x/y'), '要带上 URL');
  assert.ok(/不是页面本身的问题/.test(msg), '必须明确否定「页面问题」这个方向：' + msg);
  assert.ok(/不是 SPA|不是跨域/.test(msg), '要同时否掉 SPA 与跨域两个错误方向：' + msg);
  assert.ok(/没拿到任何内容|无从判断页面类型/.test(msg), '要说清为什么不能据此判断页面类型：' + msg);
  assert.ok(!/host_permissions/.test(msg), '超时时不该提 host_permissions —— 那会把排查带偏');
});

test('抓取超时：要给出可行的下一步，而不是「别重试」', () => {
  const msg = describeFetchError(abortErr(), 'https://github.com/x/y', 15000);
  assert.ok(/open_tab/.test(msg), '应指向 open_tab（浏览器自己加载不受这个超时限制）：' + msg);
  assert.ok(/仍可重试/.test(msg), '超时是暂时性的，不该劝退重试：' + msg);
});

test('普通抓取失败：保留原有指引（跨域提示在**这里**才是对的）', () => {
  const msg = describeFetchError(new Error('Failed to fetch'), 'https://a.test/', 15000);
  assert.ok(msg.includes('Failed to fetch'), msg);
  assert.ok(/host_permissions/.test(msg), '跨域提示属于这一类失败：' + msg);
  assert.ok(!/超时/.test(msg), '不该把普通失败说成超时');
});

test('脏异常：null / undefined / 字符串都不产出 "undefined"', () => {
  for (const bad of [null, undefined, 'boom']) {
    const msg = describeFetchError(bad, 'https://a.test/', 15000);
    assert.ok(typeof msg === 'string' && msg.length > 0);
    assert.ok(!/undefined/.test(msg), '不该泄漏 undefined：' + msg);
  }
});

// ---------------------------------------------------------------- 接线

test('接线：超时不得进入 ctx.failedUrls（那是「请勿重试」的永久名单）', () => {
  const src = fs.readFileSync('lib/assistant/tools.js', 'utf8');
  assert.ok(
    /if \(!isAbortLikeError\(e\)\) ctx\.failedUrls\.push\(norm\);/.test(src),
    '抓取失败的分支必须把「中止类」排除在永久拉黑之外'
  );
  assert.ok(!/catch \(e\) \{\s*\n\s*ctx\.failedUrls\.push\(norm\);/.test(src), '旧的「一律拉黑」写法应已消失');
});

test('接线：fetch_webpage 与 SkillHub 都必须区分超时', () => {
  const src = fs.readFileSync('lib/assistant/tools.js', 'utf8');
  assert.ok(/describeFetchError\(e, u, 15000\)/.test(src), '抓取失败要走 describeFetchError');
  assert.ok(/SkillHub 请求超时（15 秒内没有响应）/.test(src), 'SkillHub 的检索超时要与「安装失败」分开说');
  assert.ok(
    !/安装失败：' \+ \(e && e\.message/.test(src.split('isAbortLikeError(e)')[2] || ''),
    'SkillHub 的 catch 应先判超时'
  );
});

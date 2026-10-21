// 联网抓取与搜索族（fetch_webpage / web_search）—— C-1 拆出的第 6 族。
//
// 为什么这两者算一族：它们是唯一的两个"直接对外的网络动作"，且共用同一套解析层
// （`./net-parse.js` 的 readBounded / decodeBuffer / stripHtmlTags / searchWeb / describeFetchError）。
// 放在一起后，"本仓库向外发起了哪些请求、各自怎么处理失败"一目了然。
//
// **搬运原则：不重写行为。** 实现从 tools.js 原样搬来，闭包依赖改为显式注入。
//
// ⚠ 三条**有意保留**的语义（这几处都是踩过坑才写成的，不要"顺手简化"）：
//
//   1. **失败 URL 进 `ctx.failedUrls` 是有条件的**：只有**确定性失败**（HTTP 状态码、
//      非文本内容类型、正文为空）才永久拉黑；**超时/中止是暂时性失败，绝不能记入** ——
//      那会让同一 URL 在本任务后续轮次被直接拒绝，而它可能只是慢了一次。
//   2. **SPA 骨架不登记为参考来源**：只有拿到"实质性正文"（非疑似 SPA 且长度 ≥200）才产生
//      citation，避免没用的抓取占掉来源编号（导致真正引用的内容从 [3] 之类高序号开始）。
//   3. **搜索结果本身不是参考来源**：它只是候选入口；真正被 fetch/read 过的页面才进来源区。
//      否则来源区会被搜索快照刷屏、并占用全局引用编号。

import { detectAuthChallenge, authChallengeNotice } from './auth-challenge.js';

/** fetch_webpage：抓取单页正文（原实现）。 */
export async function fetchWebpage(deps, args) {
  const ctx = deps.ctx;
  // 失败要如实上报 ok:false（触发失败摘除机制，避免反复重试空耗预算）；
  // 失败 URL 记入 ctx.failedUrls，同一 URL 重试时直接拒绝。
  ctx.failedUrls = Array.isArray(ctx.failedUrls) ? ctx.failedUrls : [];
  const u = String(args.url || '').trim();
  // file:// 同样不放行（与 open_tab 一致）：`fetch` 在扩展里本就取不到本地文件，
  // 而"能读本地文件"应当是用户主动打开那个标签页后的结果，不是 agent 的一次抓取。
  if (!/^https?:\/\//i.test(u)) return { ok: false, result: '仅支持 http/https 链接：' + u };
  const norm = u.replace(/\/+$/, '');
  if (ctx.failedUrls.includes(norm)) {
    return {
      ok: false,
      result:
        '该 URL 此前已抓取失败（' + u + '），请勿重试。请改用 open_tab 打开该页读取渲染后内容，或换用其它来源；' +
        '若无法打开，直接基于已有信息总结并结束，不要继续猜测 URL。',
    };
  }
  let timer = null;
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
    const resp = await deps.fetchImpl(u, { method: 'GET', redirect: 'follow', signal: ctrl ? ctrl.signal : undefined });
    if (timer) clearTimeout(timer);
    if (!resp.ok) {
      const auth = detectAuthChallenge({
        beforeUrl: u,
        afterUrl: resp.url || u,
        result: '抓取失败 (' + resp.status + ')：' + u,
        ok: false,
        statusCode: resp.status,
        toolName: 'fetch_webpage',
      });
      if (auth) {
        return {
          ok: false,
          needsLogin: true,
          authChallenge: auth,
          result: '抓取失败 (' + resp.status + ')：' + u + authChallengeNotice(auth),
        };
      }
      ctx.failedUrls.push(norm);
      return { ok: false, result: '抓取失败 (' + resp.status + ')：' + u + '。请改用 open_tab 打开该页，或换用其它来源；不要反复重试该 URL。' };
    }
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct && !/^(text\/html|text\/plain|application\/xml|application\/xhtml|\+xml)/.test(ct) && !ct.includes('json')) {
      ctx.failedUrls.push(norm);
      return { ok: false, result: '该地址返回非文本内容（' + ct + '）：' + u + '。若需该资源请改用 open_tab 查看，否则换用其它来源。' };
    }
    const maxBytes = 1.5 * 1024 * 1024;
    const buf = await deps.readBounded(resp.body, maxBytes);
    const decoder = deps.decodeBuffer(buf, ct);
    const raw = decoder.decode(buf);
    const truncated = buf.byteLength >= maxBytes;
    const fullText = deps.stripHtml(raw);
    const trimmedText = fullText.trim();
    if (!trimmedText) {
      ctx.failedUrls.push(norm);
      return { ok: false, result: '该页面正文为空（' + u + '）。请改用 open_tab 打开读取渲染后内容，或换用其它来源。' };
    }
    // 检测「前端 JS 渲染（SPA）」：正文提取过少且源码里以脚本壳为主 → 引导改用 open_tab 读取渲染后内容。
    const likelySpa = trimmedText.length < 150 && /<script[\s>]/i.test(raw);
    const text = fullText.slice(0, 8000);
    const finalUrl = resp.url || u;
    // 200 也可能是登录墙（很多站点用前端路由跳到 /login）。这时不要把登录页
    // 当成目标正文交给模型，更不要把 URL 拉进「永久失败」名单 —— 用户登录后
    // 同一个地址仍然可用。
    const auth = detectAuthChallenge({
      beforeUrl: u,
      afterUrl: finalUrl,
      snapshot: {
        url: finalUrl,
        title: deps.extractHtmlTitle(raw) || '',
        text: fullText.slice(0, 6000),
        elements: [],
      },
      result: trimmedText.slice(0, 4000),
      ok: true,
      toolName: 'fetch_webpage',
    });
    if (auth) {
      return {
        ok: false,
        needsLogin: true,
        authChallenge: auth,
        result: '抓取被登录 / 权限页拦截：' + finalUrl + authChallengeNotice(auth),
      };
    }
    // 只有拿到「实质性正文」才登记为参考来源；SPA 骨架/过短内容不产生引用，
    // 避免没用的抓取占掉来源编号（导致模型真正引用的内容从 [3] 之类的高序号开始）。
    const usable = !likelySpa && trimmedText.length >= 200;
    return {
      result:
        '网页正文（' + finalUrl + '）：\n' + text +
        (truncated ? '\n（内容过大已截断）' : '') +
        (likelySpa
          ? '\n\n⚠ 页面正文提取过少，疑似前端 JS 渲染（SPA）页面，源码里只有脚本壳。' +
            '请改用 open_tab 打开该页，再用 get_page_snapshot / read_current_page 读取渲染后的真实内容；' +
            '禁止继续用 fetch_webpage 猜测其它 URL。若无法打开，请直接基于已有信息总结并结束。'
          : '') +
        (!usable ? '\n（该次抓取内容不足以作为参考来源，不作为来源编号登记。）' : ''),
      ...(usable
        ? { citations: [{ index: 1, source: 'web', title: deps.extractHtmlTitle(raw) || finalUrl, url: finalUrl, snippet: text.slice(0, 180) }] }
        : {}),
    };
  } catch (e) {
    // 超时/中止是**暂时性**失败，**不得**记入 ctx.failedUrls —— 那是「请勿重试」的永久名单
    // （见上面的分支），一旦记进去，同一 URL 在本任务后续轮次会被直接拒绝，
    // 而它可能只是慢了一次。只有确定性失败（状态码、内容类型、跨域）才永久拉黑。
    if (!deps.isAbortLikeError(e)) ctx.failedUrls.push(norm);
    return { ok: false, result: deps.describeFetchError(e, u, 15000) };
  } finally {
    // fetch 抛错（例如 Illegal invocation）时也要清掉计时器；
    // 否则 Service Worker 里会留下一个 15 秒后才触发的悬挂定时器，测试进程也会被拖住。
    if (timer) clearTimeout(timer);
  }
}

/** web_search：联网搜索（原实现）。 */
export async function webSearch(deps, args) {
  const q = String(args.query || '').trim();
  if (!q) return { ok: false, result: '请提供搜索关键词 query。' };
  const maxResults = Math.min(10, Math.max(1, Number(args.maxResults) || 6));
  try {
    const results = await deps.searchWeb(q, maxResults);
    if (!results.length) return { ok: false, result: '未搜索到结果，可尝试换关键词，或 open_tab 打开已知站点。' };
    const lines = results.map(
      (r, i) => '[' + (i + 1) + '] ' + r.title + '\n    链接：' + r.url + (r.snippet ? '\n    摘要：' + r.snippet : '')
    );
    // 搜索结果只是「候选入口」，不作为可点击的参考来源（避免来源区被搜索快照刷屏、
    // 也避免占用全局引用编号）。真正被 fetch / read 过的页面才会进入参考来源。
    return {
      result:
        '搜索结果（' + q + '）：\n' + lines.join('\n\n') +
        '\n\n（以上为搜索结果候选，不属于参考来源；如需引用请先 open_tab / fetch_webpage 读取目标页面，读取后的页面会登记为参考来源编号。）',
    };
  } catch (e) {
    return { ok: false, result: '网络搜索失败：' + e.message };
  }
}

/** 该族处理哪些工具名。 */
export const FETCH_TOOLS = new Set(['fetch_webpage', 'web_search']);

/** 统一入口。返回 null 表示"不属于本族"。 */
export async function handleFetchTool(name, args, deps) {
  if (name === 'fetch_webpage') return await fetchWebpage(deps, args);
  if (name === 'web_search') return await webSearch(deps, args);
  return null;
}

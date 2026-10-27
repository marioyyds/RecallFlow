// 网络抓取与搜索结果解析（从 tools.js 抽出的第一个模块）。
//
// 抽取动机：tools.js 有 2288 行，其中 `executeTool` 是一个 1100+ 行的巨型 switch，
// 而它前后还混着网络解析、状态配置、CDP 错误摘要等互不相关的关注点。
// 这里先搬出**依赖最少、最纯粹**的一组：只依赖 fetch / TextDecoder / URL，
// 不碰 chrome.*、不碰 DOM、不碰运行上下文 —— 因此可以直接在 node 里单测。
//
// 搬运原则（与作者此前拆 tool-schemas.js 时一致）：用脚本按行区间精确搬运、不手工转写，
// 并用 tests/registry-fingerprint.test.mjs 证明"对外契约没变"。
//
// 命名注意：本模块里的 `stripHtmlTags` 与 tools.js 里既有的 `stripHtml`（正文抽取）
// 不是一回事，因此刻意不沿用同名 —— 同名会让"搬错函数"这种错误变得不可见。

/** 去掉 HTML 标签并解常见实体（用于搜索结果标题/摘要）。 */
export function stripHtmlTags(html: any) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ').replace(/&emsp;/g, ' ').replace(/&middot;/g, '·').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch (e: any) { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e: any) { return ''; } })
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从 HTML 源码里提取 <title> 文本（去标签、解实体、限长）。 */
export function extractHtmlTitle(html: any) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtmlTags(m[1]).slice(0, 120) : '';
}

/** 还原搜索引擎重定向链接为真实 URL（DuckDuckGo uddg 参数 / Bing u=base64url）。 */
export function resolveSearchUrl(href: any, engine: any) {
  try {
    if (engine === 'ddg') {
      const u = new URL(href, 'https://duckduckgo.com');
      const target = u.searchParams.get('uddg');
      if (target && /^https?:\/\//i.test(target)) return target;
    } else if (engine === 'bing') {
      const u = new URL(href, 'https://www.bing.com');
      const enc = u.searchParams.get('u');
      if (enc) {
        let b64 = enc.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
    const abs = new URL(href, engine === 'ddg' ? 'https://duckduckgo.com' : 'https://www.bing.com');
    return /^https?:\/\//i.test(abs.href) ? abs.href : '';
  } catch (e: any) {
    return '';
  }
}

/** 把搜索结果的 HTML 解析成 {title,url,snippet} 列表（按引擎选择器差异处理）。 */
export function parseSearchResults(html: any, engine: any) {
  const out = [];
  const src = String(html || '');
  if (engine === 'bing') {
    const blocks = src.split(/<li class="b_algo"/i).slice(1);
    for (const b of blocks) {
      const am = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!am) continue;
      const url = resolveSearchUrl(am[1], engine);
      const title = stripHtmlTags(am[2]);
      const sm = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const snippet = sm ? stripHtmlTags(sm[1]).slice(0, 300) : '';
      if (url && title) out.push({ title, url, snippet });
    }
    return out;
  }
  // DuckDuckGo HTML 版
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
  let m;
  while ((m = re.exec(src))) {
    const url = resolveSearchUrl(m[1], engine);
    const title = stripHtmlTags(m[2]);
    const snippet = m[3] ? stripHtmlTags(m[3]).slice(0, 300) : '';
    if (url && title) out.push({ title, url, snippet });
  }
  return out;
}

/**
 * 是否属于「被中止」类失败（纯函数）。
 *
 * 为什么需要它：超时用的是 `AbortController.abort()` 且**没给 reason**，
 * 于是不同内核给出的文案不一样（实测 Chrome：`signal is aborted without reason`）。
 * 只认 `e.name === 'AbortError'` 会漏掉一部分，只认文案又会绑死某个内核 —— 两者都认。
 */
export function isAbortLikeError(e: any) {
  if (!e) return false;
  if (e.name === 'AbortError') return true;
  return /signal is aborted|user aborted|operation was aborted|aborted without reason/i.test(String(e.message || ''));
}

/**
 * 抓取失败的说明（纯函数）。
 *
 * 为什么必须把「超时」单独拎出来：原先 catch 里直接拼 `'抓取网页失败：' + e.message`，
 * 也就是把 `signal is aborted without reason` 原样交给模型，后面还跟着
 * 「若为目标站跨域，请加入 host_permissions / 改用 MCP fetch」的建议。
 *
 * 实测后果（会话 RF-V6T7C5）：agent 据此把失败归因成「目标站疑似前端 JS 渲染（SPA）页面」，
 * 并写进了给用户的报告 —— 而真相是**15 秒没响应、我们根本没拿到任何内容**，
 * 所以那时它**无从判断**页面类型。**错误归因比没有归因更糟。**
 */
export function describeFetchError(e: any, url: any, timeoutMs: any) {
  const u = String(url || '');
  if (isAbortLikeError(e)) {
    const secs = Math.round((Number(timeoutMs) || 15000) / 1000);
    return (
      '抓取超时（' + secs + ' 秒内没有响应）：' + u + '。' +
      '**这不是页面本身的问题**（不是 SPA、也不是跨域）—— 我们没拿到任何内容，因此无从判断页面类型。' +
      '可改用 open_tab 打开该页、再用 read_current_page 读取渲染后的内容（浏览器自己加载不受这个超时限制），' +
      '或换用其它来源。同一 URL 稍后仍可重试。'
    );
  }
  const raw = e && e.message ? e.message : e === undefined || e === null ? '未知错误' : String(e);
  return (
    '抓取网页失败：' + raw + '。请改用 open_tab 打开读取，或换用其它来源；不要反复重试该 URL。' +
    '（若为目标站跨域，请将其域名加入 manifest.json 的 host_permissions；或改用 MCP fetch 服务器以突破浏览器跨域限制）'
  );
}

/**
 * 页面引用的标题（纯函数）。
 *
 * 无标题的页面**不能拿正文开头当标题**：原写法 `title || 正文前 40 字` 会让
 * 纯文本 / Markdown 原文 / raw.githubusercontent.com 这类页面把正文原样当标题 ——
 * 实测（会话 RF-EGPWWF）参考来源里出现：
 *   `[5] <p align="center"> <img src="./docs/asse — https://raw.githubusercontent.com/…`
 * 那既不是标题也不是摘要，用户看不出这条来源是什么。
 *
 * 回落到**可识别的 URL 尾段**（README.md / www.csdn.net），实在没有才用占位。
 */
export function citationTitleFor(pageTitle: any, url: any) {
  const t = stripHtmlTags(String(pageTitle || '').trim());
  if (t) return t;
  const u = String(url || '');
  try {
    const parsed = new URL(u);
    const last = decodeURIComponent(parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '');
    return last || parsed.hostname || u || '（无标题页面）';
  } catch (e: any) {
    return u || '（无标题页面）';
  }
}

/** 读取响应体，限制字节上限（避免超大页面把内存打满）。 */export async function readBounded(body: any, maxBytes: any) {
  const chunks = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || !value.byteLength) continue;
    total += value.byteLength;
    chunks.push(value);
    if (total >= maxBytes) {
      try { await reader.cancel(); } catch (e: any) {}
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    if (off >= out.length) break;
    const slice = c.subarray(0, out.length - off);
    out.set(slice, off);
    off += slice.byteLength;
  }
  return out;
}

/**
 * 按 Content-Type 里的 charset 构造解码器。
 *
 * 签名是 (buf, contentType)。**不要**只传 contentType —— 那样 charset 永远取不到，
 * 会静默退化成 utf-8（GBK/GB2312 页面乱码）；在 searchWeb 那条路径上还会因为
 * 对 TextDecoder 实例调用 .decode() 而抛错、被 catch 吞掉，导致**搜索结果恒为空**。
 * 这个坑实测踩过两次，tests/silent-failure-regressions.test.mjs 有专门的回归断言。
 */
export function decodeBuffer(buf: any, contentType: any) {
  const charset = ((contentType || '').match(/charset=([\w-]+)/i) || [])[1];
  try {
    return new TextDecoder((charset || 'utf-8').trim().toLowerCase());
  } catch (e: any) {
    return new TextDecoder('utf-8');
  }
}

/**
 * 联网搜索：Bing 优先（实测可用），DuckDuckGo 兜底。
 *
 * 注意：本函数会被 withTimeout(toolTimeoutMs=15s) 包裹，各引擎超时必须加起来 < 15s。
 */
export async function searchWeb(query: any, maxResults = 6) {
  const q = encodeURIComponent(query);
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
  const engines = [
    { name: 'bing', url: 'https://www.bing.com/search?q=' + q + '&setlang=zh-hans', timeout: 7000 },
    { name: 'ddg', url: 'https://html.duckduckgo.com/html/?q=' + q, timeout: 6000 },
  ];
  for (const engine of engines) {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), engine.timeout) : null;
      const resp = await fetch(engine.url, { method: 'GET', redirect: 'follow', headers, signal: ctrl ? ctrl.signal : undefined });
      if (timer) clearTimeout(timer);
      if (!resp.ok) continue;
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const buf = await readBounded(resp.body, 1.5 * 1024 * 1024);
      const raw = decodeBuffer(buf, ct).decode(buf);
      const results = parseSearchResults(raw, engine.name);
      if (results.length) return results.slice(0, maxResults);
    } catch (e: any) {
      // 尝试下一个引擎
    }
  }
  return [];
}

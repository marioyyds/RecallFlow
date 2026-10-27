// net-parse.js：搜索结果解析 / 正文抓取 / 解码（纯函数）。
//
// 这个模块是从 tools.js 抽出来的第一批代码。抽取时 `decodeBuffer` / `isAbortLikeError` /
// `describeFetchError` / `citationTitleFor` 已有测试覆盖，但**其余几个从来没有**：
//   · readBounded —— 字节上限与截断语义（写错会把超大页面读进内存，或把正文截成半个 UTF-8 字符）
//   · resolveSearchUrl —— 搜索/兜底解析（DuckDuckGo 的 uddg、Bing 的 u=base64url）
//   · parseSearchResults —— 两个引擎的 HTML 结构差异
// 抽成模块的价值之一就是让这些能直接测；这里补上。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stripHtmlTags,
  extractHtmlTitle,
  resolveSearchUrl,
  parseSearchResults,
  readBounded,
  decodeBuffer,
} from '../lib/assistant/net-parse.ts';

// 造一个最小的 ReadableStream<Uint8Array> 来喂 readBounded
function streamOf(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]);
    },
  });
}

test('stripHtmlTags：去标签、解实体、折叠空白', () => {
  assert.equal(stripHtmlTags('<b>粗体</b> 与 &amp; 号'), '粗体 与 & 号');
  assert.equal(stripHtmlTags('a&nbsp;&nbsp;b'), 'a b');
  assert.equal(stripHtmlTags('&#65;&#x42;'), 'AB');
  // 非法码点不得抛（构造 fromCodePoint 会抛的输入）
  assert.doesNotThrow(() => stripHtmlTags('&#999999999;'));
});

test('extractHtmlTitle：取 <title> 并限长，缺失时返回空串', () => {
  assert.equal(extractHtmlTitle('<html><head><title>标题</title></head></html>'), '标题');
  assert.equal(extractHtmlTitle('<title>' + 'x'.repeat(300) + '</title>').length, 120, '应限长 120');
  assert.equal(extractHtmlTitle('<html>无标题</html>'), '');
  assert.equal(extractHtmlTitle(''), '');
});

test('resolveSearchUrl：DuckDuckGo 的 uddg 与 Bing 的 u=base64url 都要还原', () => {
  // ddg：uddg 参数直接是目标 URL
  assert.equal(
    resolveSearchUrl('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x', 'ddg'),
    'https://example.com/a'
  );
  // bing：u 参数是 base64url 编码的目标 URL（aHR0cHM6Ly9leGFtcGxlLmNvbS9i）
  const b64 = Buffer.from('https://example.com/b').toString('base64').replace(/=/g, '');
  assert.equal(resolveSearchUrl('https://www.bing.com/ck/a?u=' + b64, 'bing'), 'https://example.com/b');
  // 直接的 http(s) 链接原样返回
  assert.equal(resolveSearchUrl('https://example.com/direct', 'ddg'), 'https://example.com/direct');
  // 相对/空 href 会按引擎基址解析（这是**有意**的：搜索结果里确实存在站内相对链接）。
  // 关键性质是"不抛、且返回值始终是 http(s) 或空串"，而不是"空输入必须返回空串"。
  const emptyResult = resolveSearchUrl('', 'bing');
  assert.match(emptyResult, /^https?:\/\//, '空输入按基址解析，不得抛也不得返回脏值');
  assert.doesNotThrow(() => resolveSearchUrl('::: 不是 URL :::', 'bing'));
});

test('parseSearchResults：Bing 结构解析出 title/url/snippet', () => {
  const html = '<ol><li class="b_algo"><h2><a href="https://example.com/x">标题一</a></h2><p>摘要一</p></li>' +
    '<li class="b_algo"><h2><a href="https://example.com/y">标题二</a></h2><p>摘要二</p></li></ol>';
  const out = parseSearchResults(html, 'bing');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { title: '标题一', url: 'https://example.com/x', snippet: '摘要一' });
});

test('parseSearchResults：DuckDuckGo 结构解析（并还原跳转链接）', () => {
  const html = '<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fp">结果标题</a>' +
    '<a class="result__snippet">这是摘要</a>';
  const out = parseSearchResults(html, 'ddg');
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://example.org/p', '必须先还原跳转，否则引用的是搜索中间页');
  assert.equal(out[0].title, '结果标题');
});

test('parseSearchResults：无结果时返回空数组，不抛', () => {
  assert.deepEqual(parseSearchResults('', 'bing'), []);
  assert.deepEqual(parseSearchResults('<html>没有结果</html>', 'ddg'), []);
});

test('readBounded：正常读取全部字节', async () => {
  const out = await readBounded(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]), 1024);
  assert.equal(out.byteLength, 3);
  assert.deepEqual([...out], [1, 2, 3]);
});

test('readBounded：超过上限时截断，且总量不超过上限', async () => {
  // 这是它的存在理由：把超大页面挡在内存之外。上限写错会让整页进内存。
  const big = new Uint8Array(5000).fill(7);
  const out = await readBounded(streamOf([big, big]), 1000);
  assert.equal(out.byteLength, 1000, '必须精确截到上限');
  assert.ok(out.every((b) => b === 7), '截断内容应来自流');
});

test('readBounded：上限小于单个分片时也要精确截断（不能整块塞进去）', async () => {
  const chunk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const out = await readBounded(streamOf([chunk]), 3);
  assert.equal(out.byteLength, 3);
  assert.deepEqual([...out], [1, 2, 3]);
});

test('readBounded：空流返回零长度', async () => {
  const out = await readBounded(streamOf([]), 100);
  assert.equal(out.byteLength, 0);
});

test('decodeBuffer：签名是 (buf, contentType)，charset 取第二个参数', () => {
  // 这条与 silent-failure-regressions 里那条是同一个契约；
  // 模块搬家后在此再钉一次，确保新位置的签名没有被改回去。
  assert.equal(decodeBuffer(Buffer.alloc(0), 'text/html; charset=gbk').encoding, 'gbk');
  assert.equal(decodeBuffer(Buffer.alloc(0), '').encoding, 'utf-8');
});

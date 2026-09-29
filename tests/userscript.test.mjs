// 用户脚本元信息解析与匹配规则：这是「要不要执行第三方 JS」的判定依据，
// 此前零测试。重点覆盖会静默失效 / 越权匹配的边界。
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyMetadata, parseUserscriptMetadata, hashId } from '../lib/userscript/metadata.js';
import { normalizeMatchPattern, buildMatchPatterns, urlMatches } from '../lib/userscript/match.js';

const HEAD = (lines) => '// ==UserScript==\n' + lines.map((l) => '// ' + l).join('\n') + '\n// ==/UserScript==\nconsole.log(1);';

// ---------------------------------------------------------------- 元信息解析

test('parseUserscriptMetadata: 解析常见键值对', () => {
  const meta = parseUserscriptMetadata(
    HEAD([
      '@name 去广告',
      '@namespace https://example.com',
      '@version 1.2.3',
      '@description 屏蔽推广',
      '@author 某人',
      '@match *://*.msn.cn/*',
      '@match https://example.com/*',
      '@exclude *://example.com/keep/*',
      '@run-at document-start',
      '@require https://cdn.example.com/lib.js',
      '@grant GM_setValue',
    ])
  );
  assert.equal(meta.valid, true);
  assert.equal(meta.name, '去广告');
  assert.equal(meta.version, '1.2.3');
  assert.equal(meta.runAt, 'document-start');
  assert.deepEqual(meta.match, ['*://*.msn.cn/*', 'https://example.com/*']);
  assert.deepEqual(meta.exclude, ['*://example.com/keep/*']);
  assert.deepEqual(meta.require, ['https://cdn.example.com/lib.js']);
  assert.deepEqual(meta.grant, ['GM_setValue']);
});

test('parseUserscriptMetadata: 缺少元信息块 → valid=false 且有说明', () => {
  const meta = parseUserscriptMetadata('console.log(1)');
  assert.equal(meta.valid, false);
  assert.ok(meta.error.includes('UserScript'), meta.error);
});

test('parseUserscriptMetadata: 没有 @name 视为无效（安全默认）', () => {
  // 只有 @match 而无名字的脚本不应被当作合法脚本加载
  const meta = parseUserscriptMetadata(HEAD(['@match *://*/*']));
  assert.equal(meta.valid, false);
  assert.equal(meta.name, '');
});

test('parseUserscriptMetadata: 未声明 @grant 时按惯例补最基础 API', () => {
  const meta = parseUserscriptMetadata(HEAD(['@name x']));
  assert.deepEqual(meta.grant, ['GM_addStyle', 'GM_setValue', 'GM_getValue']);
});

test('parseUserscriptMetadata: 本地化 @name 的处理（@name 优先，zh-CN 可兜底）', () => {
  const both = parseUserscriptMetadata(HEAD(['@name English', '@name:zh-CN 中文']));
  assert.equal(both.name, 'English', '已有时不再被覆盖');
  const onlyZh = parseUserscriptMetadata(HEAD(['@name:zh-CN 中文']));
  assert.equal(onlyZh.name, '中文', '只有本地化名时应兜底采用');
  // 其它语言的本地化名目前不识别，如实记录该限制
  const onlyEn = parseUserscriptMetadata(HEAD(['@name:en English']));
  assert.equal(onlyEn.valid, false, '仅 @name:en 时无可用名称 → 判无效');
});

test('parseUserscriptMetadata: @noframes 裸写即为 true', () => {
  assert.equal(parseUserscriptMetadata(HEAD(['@name x', '@noframes'])).noframes, true);
  assert.equal(parseUserscriptMetadata(HEAD(['@name x', '@noframes false'])).noframes, false);
});

test('parseUserscriptMetadata: 块外的 // 注释与空行不影响解析', () => {
  const code = '// 顶部注释\n' + HEAD(['@name x']) + '\n// 尾部\n';
  assert.equal(parseUserscriptMetadata(code).name, 'x');
});

test('parseUserscriptMetadata: 脏输入安全', () => {
  assert.equal(parseUserscriptMetadata(null).valid, false);
  assert.equal(parseUserscriptMetadata('').valid, false);
  assert.equal(parseUserscriptMetadata(undefined).valid, false);
});

test('emptyMetadata: 结构稳定（新增字段会破坏调用方）', () => {
  const m = emptyMetadata();
  for (const k of ['name', 'match', 'include', 'exclude', 'require', 'grant', 'runAt', 'noframes']) {
    assert.ok(k in m, '缺少字段 ' + k);
  }
  assert.ok(Array.isArray(m.match) && Array.isArray(m.grant));
  // 每次调用都必须返回新对象，避免调用方互相污染
  assert.notEqual(emptyMetadata(), m);
});

test('hashId: 稳定、区分输入、非空', () => {
  assert.equal(hashId('a', 'b'), hashId('a', 'b'));
  assert.notEqual(hashId('a', 'b'), hashId('b', 'a'));
  assert.notEqual(hashId('a', 'b'), hashId('ab'));
  assert.ok(hashId('x').length > 0);
  assert.match(hashId('x'), /^[0-9a-z]+$/);
});

// ---------------------------------------------------------------- 匹配规则

test('normalizeMatchPattern: 补全 scheme 与 path', () => {
  assert.equal(normalizeMatchPattern('example.com'), '*://example.com/*');
  assert.equal(normalizeMatchPattern('https://example.com'), 'https://example.com/*');
  assert.equal(normalizeMatchPattern('https://example.com/'), 'https://example.com/*');
  assert.equal(normalizeMatchPattern('https://example.com/a/*'), 'https://example.com/a/*');
  assert.equal(normalizeMatchPattern('*://*.example.com/*'), '*://*.example.com/*');
});

test('normalizeMatchPattern: <all_urls> 必须被识别（否则脚本静默失效）', () => {
  // 回归用例：此前 <all_urls> 落到「无法识别」，注册列表为空且运行时永不匹配，
  // 表现为「脚本装了但从不运行」。
  assert.equal(normalizeMatchPattern('<all_urls>'), '*://*/*');
  const built = buildMatchPatterns({ match: ['<all_urls>'] });
  assert.deepEqual(built.patterns, ['*://*/*']);
  assert.deepEqual(built.warnings, []);
});

test('normalizeMatchPattern: file:// 允许空 host', () => {
  assert.equal(normalizeMatchPattern('file:///*'), 'file:///*');
  assert.equal(normalizeMatchPattern('file:///home/x/*'), 'file:///home/x/*');
});

test('normalizeMatchPattern: 非法输入返回 null', () => {
  assert.equal(normalizeMatchPattern(''), null);
  assert.equal(normalizeMatchPattern('   '), null);
  assert.equal(normalizeMatchPattern('/foo/'), null, '正则无法用于注册');
  assert.equal(normalizeMatchPattern('*://bad_host!/*'), null);
  assert.equal(normalizeMatchPattern('http://'), null, '空 host 的非 file scheme 应拒绝');
});

test('buildMatchPatterns: 去重 + 正则进 warnings', () => {
  const r = buildMatchPatterns({
    match: ['https://a.com/*', 'https://a.com'],
    include: ['/^https:\\/\\/b\\.com\\//', 'garbage!!'],
  });
  assert.deepEqual(r.patterns, ['https://a.com/*'], '两者规范化后相同，应去重');
  assert.equal(r.warnings.length, 2, JSON.stringify(r.warnings));
  assert.ok(r.warnings[0].includes('正则规则'), r.warnings[0]);
  assert.ok(r.warnings[1].includes('无法识别'), r.warnings[1]);
});

test('urlMatches: @exclude 优先于 @match', () => {
  const meta = { match: ['*://example.com/*'], exclude: ['*://example.com/private/*'] };
  assert.equal(urlMatches(meta, 'https://example.com/a'), true);
  assert.equal(urlMatches(meta, 'https://example.com/private/a'), false);
});

test('urlMatches: 无匹配规则时默认全站（配合 @exclude 收窄）', () => {
  assert.equal(urlMatches({ match: [], include: [], exclude: [] }, 'https://any.site/x'), true);
  assert.equal(urlMatches({ exclude: ['*://ads.example/*'] }, 'https://ads.example/x'), false);
});

test('urlMatches: 子域名通配与越权防护', () => {
  const meta = { match: ['*://*.example.com/*'] };
  assert.equal(urlMatches(meta, 'https://sub.example.com/x'), true);
  assert.equal(urlMatches(meta, 'https://example.com/x'), false, '*.example.com 不含裸域（与 Chrome 语义一致）');
  assert.equal(urlMatches(meta, 'https://example.com.evil.com/x'), false, '不得被后缀伪装骗过');
});

test('urlMatches: 支持正则 include', () => {
  const meta = { include: ['/^https:\\/\\/(a|b)\\.test\\//'] };
  assert.equal(urlMatches(meta, 'https://a.test/x'), true);
  assert.equal(urlMatches(meta, 'https://c.test/x'), false);
});

test('urlMatches: <all_urls> 才真正全站（含 file://）', () => {
  const meta = { match: ['<all_urls>'] };
  assert.equal(urlMatches(meta, 'https://x.test/'), true);
  assert.equal(urlMatches(meta, 'http://x.test/'), true);
  assert.equal(urlMatches(meta, 'file:///tmp/a.html'), true);
});

test('urlMatches: 脏数据安全', () => {
  assert.equal(urlMatches({}, ''), true, '无规则默认全站');
  assert.equal(urlMatches({ match: [null, ''] }, 'https://a.test/'), false, '空规则不应匹配');
  assert.equal(urlMatches({ include: ['/[unclosed/'] }, 'https://a.test/'), false, '非法正则不应抛错');
});

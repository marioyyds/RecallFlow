// 本地页（file://）与"可操作 URL"的判定。
//
// 这两件小事各自都很不起眼，但错了就是**整条链路静默失效**：
//   · 少了 `file://`：本地页上面板根本不出现，用户以为扩展坏了；
//   · 站点键直接用 `URL.origin`：所有本地文件的 origin 都是字符串 'null'，
//     于是"在 A 文件里学到的选择器"会污染 B 文件，`trust_site` 更是从"信任一个目录"
//     悄悄变成"信任整块磁盘"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { isFileUrl, isWebUrl, isOperableUrl, siteKeyOf } from '../lib/shared/utils.js';

test('isFileUrl：只认 file://（大小写不敏感）', () => {
  assert.equal(isFileUrl('file:///C:/docs/a.html'), true);
  assert.equal(isFileUrl('FILE:///C:/docs/a.html'), true);
  assert.equal(isFileUrl('file://localhost/C:/a.html'), true);
  assert.equal(isFileUrl('https://example.test/a.html'), false);
  assert.equal(isFileUrl('filesystem:https://a.test/x'), false);
  assert.equal(isFileUrl(''), false);
  assert.equal(isFileUrl(undefined), false);
});

test('isOperableUrl：普通网页与本地页都能操作，其余一律不算', () => {
  for (const ok of ['http://a.test/', 'https://a.test/x', 'file:///C:/a.html']) {
    assert.equal(isOperableUrl(ok), true, ok);
  }
  for (const bad of ['chrome://extensions', 'edge://settings', 'about:blank', 'javascript:alert(1)', 'data:text/html,x', '', null]) {
    assert.equal(isOperableUrl(bad), false, String(bad));
  }
  // isWebUrl 保持原语义，别被顺手放宽（fetch / open_tab 那两处仍只认 http(s)）
  assert.equal(isWebUrl('file:///C:/a.html'), false);
});

test('siteKeyOf：普通网页仍用 origin（不能因为加本地页而改变既有归组）', () => {
  assert.equal(siteKeyOf('https://example.test/a/b?x=1#h'), 'https://example.test');
  assert.equal(siteKeyOf('http://127.0.0.1:8080/x'), 'http://127.0.0.1:8080');
});

test('siteKeyOf：本地页按**目录**归组，绝不返回 "null"', () => {
  assert.equal(siteKeyOf('file:///C:/docs/a.html'), 'file:///C:/docs/');
  assert.equal(siteKeyOf('file:///C:/docs/sub/b.html'), 'file:///C:/docs/sub/');
  assert.equal(siteKeyOf('file:///etc/passwd'), 'file:///etc/');

  // 同一目录 → 同一站点（同一批文档共享记忆是用户能理解的）
  assert.equal(siteKeyOf('file:///C:/docs/a.html'), siteKeyOf('file:///C:/docs/b.html'));
  // 不同目录 → 不同站点（这是修掉 "所有本地文件混成一个站点" 的关键）
  assert.notEqual(siteKeyOf('file:///C:/docs/a.html'), siteKeyOf('file:///C:/secret/b.html'));
  // 任何一个本地页都不该落到 'null' 上 —— 那正是旧实现的 bug
  for (const u of ['file:///C:/a.html', 'file:///tmp/x.htm', 'file:///home/me/n/y.html']) {
    assert.notEqual(siteKeyOf(u), 'null');
  }
});

test('siteKeyOf：空值 / 非法值返回空串（调用方据此跳过记忆，而不是写进一个 "" 键）', () => {
  assert.equal(siteKeyOf(''), '');
  assert.equal(siteKeyOf('not a url'), '');
  assert.equal(siteKeyOf(null), '');
});

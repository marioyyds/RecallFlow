// scripts/serve-dir.mjs：本地静态服务（把目录挂成 127.0.0.1 站点，用来调试本地 HTML）。
//
// 为什么这些断言值得有：它是唯一一个**把本地文件暴露给浏览器**的东西，
// 一旦 Host 校验或路径收敛写错，受害的不是这个脚本，而是整台机器上的文件。
// 所以这里既测纯函数（Host 白名单 / 路径收敛 / MIME），也起真服务器打真实 HTTP 请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  parseArgs,
  isHostAllowed,
  resolveWithinRoot,
  contentTypeFor,
  renderListing,
  startStaticServer,
} from '../scripts/serve-dir.mjs';

// ---------- 纯函数 ----------

test('parseArgs: 默认值、位置参数与 --port', () => {
  const a = parseArgs([]);
  assert.equal(a.port, 8099);
  assert.equal(a.bind, '127.0.0.1');
  assert.equal(a.listing, true);

  const b = parseArgs(['docs', '8123']);
  assert.equal(b.port, 8123);
  assert.ok(b.root.endsWith('docs'), b.root);

  const c = parseArgs(['--root', '.', '--port', '0', '--no-listing', '--bind', '127.0.0.1']);
  assert.equal(c.port, 0);
  assert.equal(c.listing, false);
});

test('parseArgs: 非法输入明确报错，而不是悄悄用默认值', () => {
  assert.throws(() => parseArgs(['--port', '--root']), /缺少取值/);
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
  assert.throws(() => parseArgs(['--port', '99999']), /端口非法/);
});

test('isHostAllowed: 只放行回环地址（DNS rebinding 的唯一防线）', () => {
  assert.equal(isHostAllowed('127.0.0.1:8099', 8099), true);
  assert.equal(isHostAllowed('localhost:8099', 8099), true);
  assert.equal(isHostAllowed('[::1]:8099', 8099), true);
  assert.equal(isHostAllowed('127.0.0.1', 8099), true);
  // 端口不符 = 不是我们绑的那个服务
  assert.equal(isHostAllowed('127.0.0.1:9999', 8099), false);
  // 攻击者域名：即使它解析到 127.0.0.1，Host 头也不是回环地址
  assert.equal(isHostAllowed('evil.example.com', 8099), false);
  // 回环地址出现在**域名后缀**里不能算通过
  assert.equal(isHostAllowed('127.0.0.1.evil.com', 8099), false);
  assert.equal(isHostAllowed('', 8099), false);
});

test('resolveWithinRoot: 一切敌意输入都不能逃出 root', () => {
  const root = path.resolve(os.tmpdir(), 'rf-serve-root');
  const sep = path.sep;
  const hostile = [
    '/../secret.txt',
    '/../../../../etc/passwd',
    '/..%2f..%2fetc/passwd',
    '/%2e%2e/%2e%2e/secret.txt',
    '/....//secret.txt',
    '/sub/../../secret.txt',
    '/sub\\..\\..\\secret.txt',
    '/C:/Windows/win.ini',
    '//server/share/file.txt',
    '/a/'.repeat(50) + '../secret.txt',
  ];
  for (const p of hostile) {
    const r = resolveWithinRoot(root, p);
    if (!r.ok) continue;
    assert.ok(
      r.file === root || r.file.startsWith(root + sep),
      '越界：' + p + ' → ' + r.file
    );
  }
});

test('resolveWithinRoot: 坏编码与 NUL 字节被拒绝，正常路径落在 root 内', () => {
  const root = path.resolve(os.tmpdir(), 'rf-serve-root');
  assert.equal(resolveWithinRoot(root, '/%zz').ok, false);
  assert.equal(resolveWithinRoot(root, '/a%00b').ok, false);

  const ok = resolveWithinRoot(root, '/docs/index.html');
  assert.equal(ok.ok, true);
  assert.equal(ok.file, path.join(root, 'docs', 'index.html'));
});

test('contentTypeFor: html 带 charset，未知扩展名退化为 octet-stream', () => {
  assert.match(contentTypeFor('a.html'), /^text\/html; charset=utf-8$/);
  assert.match(contentTypeFor('A.HTML'), /^text\/html; charset=utf-8$/);
  assert.equal(contentTypeFor('x.bin'), 'application/octet-stream');
});

test('renderListing: 文件名被转义（列表页不能成为 XSS 入口）', () => {
  const html = renderListing('/', [{ name: '<img src=x onerror=alert(1)>', isDir: false, size: 3, mtime: '' }]);
  assert.ok(!html.includes('<img src=x'), '未转义的文件名被原样输出');
  assert.ok(html.includes('&lt;img'), '应输出转义后的名字');
});

// ---------- 真实 HTTP ----------

function request(port, reqPath, { method = 'GET', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method, headers: host ? { Host: host } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('startStaticServer: index.html、列表页、404、HEAD、405、Host 校验与越界防护', async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'rf-serve-dir-'));
  const root = path.join(base, 'site');
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(root, 'index.html'), '<h1>home</h1>');
  await fsp.writeFile(path.join(root, 'sub', 'a.txt'), 'AAA');
  // 站在 root 之外的"秘密文件"：任何路径穿越都不该读到它
  await fsp.writeFile(path.join(base, 'secret.txt'), 'TOP-SECRET');

  const started = await startStaticServer({ root, port: 0, log: false });
  t.after(async () => {
    await started.close();
    await fsp.rm(base, { recursive: true, force: true });
  });

  const home = await request(started.port, '/');
  assert.equal(home.status, 200);
  assert.match(home.body, /home/);
  assert.equal(home.headers['cache-control'], 'no-store');

  const file = await request(started.port, '/sub/a.txt');
  assert.equal(file.status, 200);
  assert.equal(file.body, 'AAA');
  assert.match(file.headers['content-type'], /^text\/plain/);

  const listing = await request(started.port, '/sub/');
  assert.equal(listing.status, 200);
  assert.match(listing.body, /a\.txt/);

  const missing = await request(started.port, '/nope.txt');
  assert.equal(missing.status, 404);

  const head = await request(started.port, '/sub/a.txt', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], '3');

  const post = await request(started.port, '/', { method: 'POST' });
  assert.equal(post.status, 405);

  // Host 头不是回环地址 → 403（DNS rebinding 的防线）
  const rebound = await request(started.port, '/sub/a.txt', { host: 'evil.example.com' });
  assert.equal(rebound.status, 403);

  // 路径穿越：不能读到 root 之外的 secret.txt
  for (const p of ['/../secret.txt', '/sub/../../secret.txt', '/..%2fsecret.txt']) {
    const res = await request(started.port, p);
    assert.ok(res.status >= 400, p + ' 应被拒绝，实际 ' + res.status);
    assert.ok(!res.body.includes('TOP-SECRET'), p + ' 泄露了 root 之外的内容');
  }

  // 关掉列表页时目录不再给出文件清单（只有 index.html 可用）
  const strict = await startStaticServer({ root, port: 0, log: false, listing: false });
  t.after(() => strict.close());
  assert.equal((await request(strict.port, '/sub/')).status, 404);
});

test('startStaticServer: 端口被占用时明确报 EADDRINUSE（不静默换端口）', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rf-serve-dir2-'));
  const first = await startStaticServer({ root, port: 0, log: false });
  t.after(async () => {
    await first.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  await assert.rejects(() => startStaticServer({ root, port: first.port, log: false }), (e) => /EADDRINUSE/.test(String(e && e.code)));
});

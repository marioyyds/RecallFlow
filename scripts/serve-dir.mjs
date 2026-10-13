#!/usr/bin/env node
// 本地静态服务器（零依赖）：把任意目录挂成 http://127.0.0.1:PORT，用来调试本地 HTML。
//
// 为什么需要它：manifest 的 content_scripts 只匹配 http://*/* 与 https://*/*，
// 扩展**不会**注入 file:// 页面 —— 双击打开的本地 HTML 拿不到面板、元素拾取与
// console/network 环形缓冲。把它挂成 127.0.0.1 站点后，RecallFlow 的全套页面能力
// （browser_read / page_health / read_console / verify_change / get_element_source）
// 立刻可用（已实测：browser_read 能读到渲染后正文并返回 snapshotHash）。
//
// 安全边界（与 recallflow-mcp 的桥接同一套思路，理由同源，勿删）：
//   1. 默认只绑 127.0.0.1，不监听 0.0.0.0；
//   2. Host 白名单：网页即使把域名解析到 127.0.0.1（DNS rebinding）也读不到文件；
//   3. 目标路径必须落在 root 之内，挡掉 ../ 穿越与符号链接外的绝对路径；
//   4. **不发** Access-Control-Allow-Origin —— 不做任何跨源放行。
//
// 用法：
//   node scripts/serve-dir.mjs [DIR] [--root DIR] [--port 8099] [--bind 127.0.0.1] [--no-listing]
//   node scripts/serve-dir.mjs docs --port 8099
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
};

/** 解析命令行参数；位置参数按 [DIR] [PORT] 理解。 */
export function parseArgs(argv) {
  const out = { root: '', port: 8099, bind: '127.0.0.1', listing: true, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith('--')) throw new Error(a + ' 缺少取值');
      i += 1;
      return v;
    };
    if (a === '--root') out.root = next();
    else if (a === '--port' || a === '-p') out.port = Number(next());
    else if (a === '--bind') out.bind = next();
    else if (a === '--no-listing') out.listing = false;
    else if (a === '--listing') out.listing = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) throw new Error('未知参数：' + a);
    else positional.push(a);
  }
  if (!out.root && positional.length) out.root = positional.shift();
  if (!out.root) out.root = process.cwd();
  if (positional.length) out.port = Number(positional.shift());
  if (!Number.isFinite(out.port) || out.port < 0 || out.port > 65535) throw new Error('端口非法：' + out.port);
  out.root = path.resolve(out.root);
  return out;
}

/**
 * Host 白名单：只接受回环地址（可带端口）。
 * 为什么必须查：DNS rebinding 下攻击者域名也解析到 127.0.0.1，
 * 浏览器会把它当同源，于是"本机服务"的响应被任意网页读走。
 */
export function isHostAllowed(hostHeader, port) {
  const host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return false;
  const m = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/.exec(host);
  if (!m) return false;
  if (!m[2]) return true;
  // 绑 0（测试用临时端口）时不校验端口号。
  return !port || Number(m[2]) === Number(port);
}

/**
 * 把 URL pathname 解析到 root 之内的绝对路径。
 * @returns {{ok: true, file: string} | {ok: false, reason: string}}
 */
export function resolveWithinRoot(root, urlPath) {
  const rootAbs = path.resolve(root);
  let decoded = '';
  try {
    decoded = decodeURIComponent(String(urlPath || '/'));
  } catch (e) {
    return { ok: false, reason: 'bad-encoding' };
  }
  if (decoded.includes('\0')) return { ok: false, reason: 'bad-path' };
  // 用 path.resolve 归一化后再做前缀判断：'../' 与重复斜杠都会被吃掉。
  const file = path.resolve(rootAbs, '.' + path.posix.normalize('/' + decoded.replace(/\\/g, '/')));
  if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) return { ok: false, reason: 'outside-root' };
  return { ok: true, file };
}

export function contentTypeFor(file) {
  return MIME[path.extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function humanSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** 目录列表页。默认开着：确认"这个 URL 背后是哪个目录"比省一次点击重要。 */
export function renderListing(urlPath, entries) {
  const rows = entries
    .map((e) => {
      const name = e.name + (e.isDir ? '/' : '');
      const href = path.posix.join(urlPath, name).replace(/\/{2,}/g, '/');
      return (
        '<tr><td><a href="' + escapeHtml(href) + '">' + escapeHtml(name) + '</a></td>' +
        '<td>' + (e.isDir ? '&lt;dir&gt;' : humanSize(e.size)) + '</td>' +
        '<td>' + escapeHtml(e.mtime) + '</td></tr>'
      );
    })
    .join('\n');
  return (
    '<!doctype html><meta charset="utf-8"><title>Index of ' + escapeHtml(urlPath) + '</title>' +
    '<style>body{font:14px/1.6 -apple-system,Segoe UI,sans-serif;margin:32px;color:#222}' +
    'table{border-collapse:collapse;width:100%;max-width:900px}td{padding:4px 12px 4px 0;border-bottom:1px solid #eee}' +
    'a{color:#0366d6;text-decoration:none}a:hover{text-decoration:underline}h1{font-size:16px;font-weight:600}' +
    '.hint{color:#666;margin-top:20px}</style>' +
    '<h1>Index of ' + escapeHtml(urlPath) + '</h1><table>' + rows + '</table>' +
    '<p class="hint">本地静态服务 · 仅回环可达 · 不上传任何文件</p>'
  );
}

/**
 * 建服务器（不监听）。返回 { server, handle }，handle 内部持有实际端口。
 * 端口传 0 时由系统分配（测试用），实际端口从 server.address().port 取。
 */
export function createStaticServer(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const listing = options.listing !== false;
  const log = options.log !== false;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let status = 500;
    const done = (code) => {
      status = code;
    };
    try {
      if (!isHostAllowed(req.headers.host, 0)) {
        done(403);
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden host');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        done(405);
        res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }).end('method not allowed');
        return;
      }
      let pathname = '/';
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      } catch (e) {
        done(400);
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('bad url');
        return;
      }
      const resolved = resolveWithinRoot(root, pathname);
      if (!resolved.ok) {
        done(resolved.reason === 'bad-encoding' ? 400 : 403);
        res
          .writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end(resolved.reason === 'outside-root' ? 'forbidden（目标在服务根之外）' : 'bad request');
        return;
      }
      let stat = null;
      try {
        stat = await fsp.stat(resolved.file);
      } catch (e) {
        stat = null;
      }
      if (stat && stat.isDirectory()) {
        // 目录优先 index.html，其次列表页 —— 与常规静态服务器一致。
        const indexFile = path.join(resolved.file, 'index.html');
        let indexStat = null;
        try {
          indexStat = await fsp.stat(indexFile);
        } catch (e) {
          indexStat = null;
        }
        if (indexStat && indexStat.isFile()) {
          await sendFile(req, res, indexFile, indexStat);
          done(200);
          return;
        }
        if (!listing) {
          done(404);
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('no index.html and listing disabled');
          return;
        }
        const dirents = await fsp.readdir(resolved.file, { withFileTypes: true });
        const entries = await Promise.all(
          dirents.map(async (d) => {
            let size = 0;
            let mtime = '';
            try {
              const st = await fsp.stat(path.join(resolved.file, d.name));
              size = st.size;
              mtime = st.mtime.toISOString().slice(0, 16).replace('T', ' ');
            } catch (e) {
              /* 断链/权限不足：列出名字即可，不因单条失败整个目录报错 */
            }
            return { name: d.name, isDir: d.isDirectory(), size, mtime };
          })
        );
        entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
        const html = renderListing(pathname.endsWith('/') ? pathname : pathname + '/', entries);
        done(200);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : html);
        return;
      }
      if (!stat || !stat.isFile()) {
        done(404);
        res
          .writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('not found: ' + pathname + '\n（服务根：' + root + '）');
        return;
      }
      await sendFile(req, res, resolved.file, stat);
      done(200);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('server error: ' + String((e && e.message) || e));
      } else {
        try {
          res.end();
        } catch (e2) {}
      }
    } finally {
      if (log) process.stdout.write('[serve-dir] ' + req.method + ' ' + req.url + ' → ' + status + ' (' + (Date.now() - started) + 'ms)\n');
    }
  });

  function sendFile(req, res, file, stat) {
    return new Promise((resolve, reject) => {
      res.writeHead(200, {
        'Content-Type': contentTypeFor(file),
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') {
        res.end();
        resolve();
        return;
      }
      const stream = fs.createReadStream(file);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res);
    });
  }

  return server;
}

/** 建服务器并监听；返回 {server, port, url, close}。 */
export async function startStaticServer(options = {}) {
  const server = createStaticServer(options);
  const bind = options.bind || '127.0.0.1';
  const port = Number(options.port === undefined ? 8099 : options.port);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, resolve);
  });
  const actual = server.address().port;
  return {
    server,
    port: actual,
    url: 'http://' + (bind === '0.0.0.0' ? '127.0.0.1' : bind) + ':' + actual + '/',
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write('[serve-dir] ' + String((e && e.message) || e) + '\n用法：node scripts/serve-dir.mjs [DIR] [--port 8099] [--bind 127.0.0.1] [--no-listing]\n');
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write('用法：node scripts/serve-dir.mjs [DIR] [--port 8099] [--bind 127.0.0.1] [--no-listing]\n');
    process.exit(0);
  }
  try {
    const started = await startStaticServer(args);
    process.stdout.write('[serve-dir] serving ' + args.root + '\n[serve-dir] → ' + started.url + '\n');
  } catch (e) {
    const msg = String((e && e.message) || e);
    process.stderr.write(
      '[serve-dir] 启动失败：' + msg + '\n' +
        (/EADDRINUSE/.test(msg) ? '  端口已被占用：换一个 --port，或先停掉占用它的进程。\n' : '') +
        (/(EACCES|EPERM)/.test(msg) ? '  权限不足：换一个端口（1024 以下通常需要特权）。\n' : '')
    );
    process.exit(1);
  }
}

// 证据归档存储：把每次 browser_read 的正文 + 时间戳 + 哈希落盘。
// 归档是不可变的——即使原网页之后变更或 404，引用仍可用 snapshotHash 复核。
//
// **目录惰性求值**：原来在模块顶层读 env 并 mkdirSync，两个后果都不好：
//   ① "只是 import 一下"就有了文件系统副作用；
//   ② 测试无法把它指到临时目录（env 在 import 那一刻就被固化了）—— 于是这块逻辑没法测。
// 现在只在真正读写时才解析目录，写入时才建目录（读不到就当没有）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

function dirNow() {
  return process.env.RECALLFLOW_EVIDENCE_DIR || path.join(os.homedir(), '.recallflow-evidence');
}

function ensureDir() {
  const d = dirNow();
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (e) {}
  return d;
}

function hashOf(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

// 归档一条证据，返回带 snapshotHash / fetchedAt 的记录。
export function archive({ url, title, text, quotes }) {
  const fetchedAt = new Date().toISOString();
  const body = String(text || '');
  const snapshotHash = hashOf(String(url || '') + '\n' + body);
  const record = {
    url: String(url || ''),
    title: String(title || ''),
    fetchedAt,
    snapshotHash,
    text: body,
    quotes: Array.isArray(quotes) ? quotes : [],
  };
  try {
    fs.writeFileSync(path.join(ensureDir(), snapshotHash + '.json'), JSON.stringify(record), 'utf8');
  } catch (e) {}
  return record;
}

/**
 * 归档一张截图：写 <hash>.<ext> 图片 + 同名 .json 记录。
 *
 * 与文本证据共用目录与命名规则，因此：
 *  - evidence_get(hash) 能取回它的元数据；
 *  - 图片本身留在磁盘上，客户端模型没有视觉能力时也能让用户打开查看。
 * hash 里掺入 fetchedAt，保证同一页面多次截图不会互相覆盖。
 */
export function archiveImage({ buffer, mimeType, url, title, label }) {
  const fetchedAt = new Date().toISOString();
  const type = String(mimeType || 'image/jpeg');
  const ext = type === 'image/png' ? 'png' : 'jpg';
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'base64');
  const snapshotHash = hashOf(String(url || '') + '\n' + fetchedAt + '\n' + data.length);
  const file = snapshotHash + '.' + ext;
  const record = {
    url: String(url || ''),
    title: String(title || ''),
    fetchedAt,
    snapshotHash,
    kind: 'screenshot',
    label: String(label || ''),
    mimeType: type,
    bytes: data.length,
    image: file,
    text: '',
    quotes: [],
  };
  try {
    const d = ensureDir();
    fs.writeFileSync(path.join(d, file), data);
    fs.writeFileSync(path.join(d, snapshotHash + '.json'), JSON.stringify(record), 'utf8');
  } catch (e) {}
  return record;
}

// 按哈希取归档。
export function get(hash) {
  const h = String(hash || '').replace(/[^a-f0-9]/gi, '');
  if (!h) return null;
  try {
    const p = path.join(dirNow(), h + '.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

// 按 URL 取最近一次归档（用于“这个 URL 之前读过什么”的复核）。
export function getByUrl(url) {
  const u = String(url || '');
  if (!u) return null;
  try {
    let latest = null;
    const d = dirNow();
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
        if (rec.url === u && (!latest || rec.fetchedAt > latest.fetchedAt)) latest = rec;
      } catch (e) {}
    }
    return latest;
  } catch (e) {
    return null;
  }
}

export function dir() {
  return dirNow();
}

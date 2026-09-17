// 证据归档存储：把每次 browser_read 的正文 + 时间戳 + 哈希落盘。
// 归档是不可变的——即使原网页之后变更或 404，引用仍可用 snapshotHash 复核。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const DIR = process.env.RECALLFLOW_EVIDENCE_DIR || path.join(os.homedir(), '.recallflow-evidence');
try {
  fs.mkdirSync(DIR, { recursive: true });
} catch (e) {}

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
    fs.writeFileSync(path.join(DIR, snapshotHash + '.json'), JSON.stringify(record), 'utf8');
  } catch (e) {}
  return record;
}

// 按哈希取归档。
export function get(hash) {
  const h = String(hash || '').replace(/[^a-f0-9]/gi, '');
  if (!h) return null;
  try {
    const p = path.join(DIR, h + '.json');
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
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        if (rec.url === u && (!latest || rec.fetchedAt > latest.fetchedAt)) latest = rec;
      } catch (e) {}
    }
    return latest;
  } catch (e) {
    return null;
  }
}

export function dir() {
  return DIR;
}

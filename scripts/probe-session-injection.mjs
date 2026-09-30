// 一次性排查：本会话的持久化文件里，到底有没有我注入的那条消息？
//
// 为什么查文件而不是问模型：注入进的是**模型输入**，模型自述"我看到了"不是证据；
// 而 DSH 的会话是事件溯源的、持久化的 —— 注入若真的落地，文件里必然有一条
// user/message 且 source.kind === 'recallflow-panel'。这是唯一的外部判据。
//
// DSH 的会话文件是 zstd 压缩的 .jsonl.zstd（早前我拒绝"tail 它"是因为压缩 + 版本演进
// 不适合做长期同步方案；这里只做一次性核对，所以解压看一眼是合适的）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const HOME = process.env.USERPROFILE || process.env.HOME;
const base = path.join(HOME, '.dsh', 'sessions');
if (!fs.existsSync(base)) {
  console.log('找不到会话目录: ' + base);
  process.exit(0);
}

// 工作区目录名形如 --D-Desktop-workspace-code-ai-bookmark-sorter--
const dirs = fs
  .readdirSync(base)
  .filter((d) => /bookmark-sorter/.test(d))
  .map((d) => path.join(base, d));
if (!dirs.length) {
  console.log('找不到本工作区的会话目录。现有：' + fs.readdirSync(base).slice(0, 10).join(' / '));
  process.exit(0);
}

const files = [];
for (const d of dirs) {
  for (const s of fs.readdirSync(d)) {
    const full = path.join(d, s);
    let st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      continue;
    }
    const cand = st.isDirectory() ? fs.readdirSync(full).map((x) => path.join(full, x)) : [full];
    for (const c of cand) {
      try {
        const cs = fs.statSync(c);
        if (cs.isFile()) files.push({ path: c, mtime: cs.mtimeMs, size: cs.size });
      } catch (e) {}
    }
  }
}
files.sort((a, b) => b.mtime - a.mtime);
console.log('本工作区会话相关文件（按修改时间倒序，前 6 个）：');
for (const f of files.slice(0, 6)) {
  console.log('  ' + (f.mtime / 1000).toFixed(0) + '  ' + (f.size / 1024).toFixed(1) + 'KB  ' + f.path.replace(base, '…'));
}

const hasZstd = typeof zlib.createZstdDecompress === 'function';
console.log('\nnode 是否支持 zstd 流式解压: ' + (hasZstd ? '是 ✓' : '否（需要其它途径）'));

/**
 * 解压整个文件。
 *
 * 教训（这一版修的就是它）：这些文件是 append-only、**一帧一次追加**的 zstd。
 *   - `zstdDecompressSync` 只解第一帧（实测 9.9MB 的文件只解出 229 字符）；
 *   - `createZstdDecompress` 流式**同样停在第一帧**（实测还是 229 字符）。
 * 两次都据此得出"没有注入"是**错误结论** —— 所以改为按帧魔数切开、逐帧解压再拼接。
 * 魔数也可能出现在压缩数据内部（误切），那时该片解压失败 —— 跳过即可，
 * 对"找标记"这个用途足够。
 */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function splitFrames(buf) {
  const offsets = [];
  let i = buf.indexOf(FRAME_MAGIC, 0);
  while (i >= 0) {
    offsets.push(i);
    i = buf.indexOf(FRAME_MAGIC, i + 4);
  }
  if (!offsets.length) return [buf];
  const frames = [];
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    frames.push(buf.subarray(start, end));
  }
  return frames;
}

function readAll(file) {
  const buf = fs.readFileSync(file);
  const isZstd = buf.length > 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd;
  if (!isZstd || !hasZstd) return buf.toString('utf8');
  const frames = splitFrames(buf);
  const parts = [];
  let okFrames = 0;
  for (const fr of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(fr).toString('utf8'));
      okFrames++;
    } catch (e) {
      /* 误切的片或未完成的尾帧：跳过 */
    }
  }
  return { text: parts.join(''), frames: frames.length, okFrames };
}

// 判据必须**足够特异**，否则会被自己的工具输出骗到：
// 这个会话里我来回读写过插件源码，于是 "recallflow-panel"、"【浏览器 RecallFlow 面板最近的对话】"
// 这些松散标记都会命中源码文本，得出假阳性（实测踩过一次）。
// 结构判据：`agent/inbox/spliced` 事件里出现形如 recallflow-panel-<uuid> 的 id。
// 源码里只有 `'recallflow-panel-' + crypto.randomUUID()`，不含字面 uuid，因此不会误命中。
const ID_RE = /"id"\s*:\s*"(recallflow-panel-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g;
const STRUCT_RE = /"type"\s*:\s*"agent\/inbox\/spliced"/g;

let checked = 0;
for (const f of files.slice(0, 4)) {
  let r;
  try {
    r = readAll(f.path);
  } catch (e) {
    console.log('  ' + path.basename(f.path) + '  读取失败: ' + e.message);
    continue;
  }
  const text = typeof r === 'string' ? r : r.text;
  checked++;
  const ids = [...new Set((text.match(ID_RE) || []))];
  const splices = (text.match(STRUCT_RE) || []).length;
  console.log(
    '  ' + path.basename(path.dirname(f.path)).slice(0, 26) + '  解出 ' + text.length + ' 字符' +
      (typeof r === 'string' ? '' : '（' + r.okFrames + '/' + r.frames + ' 帧）') +
      '  inbox/spliced 事件 ' + splices + ' 个, 注入 id ' + ids.length + ' 个'
  );
  for (const id of ids.slice(0, 3)) {
    const i = text.indexOf(id);
    const seg = text.slice(Math.max(0, i - 160), i + 260);
    const target = (seg.match(/"target"\s*:\s*"([a-z-]+)"/) || [])[1] || '?';
    const who = (seg.match(/"role"\s*:\s*"([a-z]+)"/) || [])[1] || '?';
    console.log('     ' + id.slice(0, 30) + '…  target=' + target + ' role=' + who);
    console.log('     ' + seg.replace(/\s+/g, ' ').slice(0, 200));
  }
}
console.log('\n共检查 ' + checked + ' 个文件。');
console.log('判读：');
console.log('  命中注入 id = 注入确实落进了会话（形态是 agent/inbox/spliced 的 inbox 事件）');
console.log('  全无命中   = 注入没落地（那就得查插件是否真的在跑、agent/created 是否触发）');

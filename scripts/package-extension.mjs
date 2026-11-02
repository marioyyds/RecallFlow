// 扩展打包：把仓库收拢成「可安装 / 可传 release」的 zip。
//
// 为什么不能用"整个仓库压一份"：仓库根本身是未打包扩展的加载目录，
// 但里面还住着源码（entries/**、lib/**/*.ts）、测试（tests/）、脚本（scripts/）、
// 文档（docs/）—— 全压进去既是泄源码，Chrome 加载也用不到。
// 所以这里走**引用白名单**：只收 manifest 引用的文件 + 各扩展页 HTML 引用的
// 资源 + 入口构建产物清单（ENTRIES / content.js）。白名单从三处**动态推导**，
// 不手工抄文件名 —— manifest 或 HTML 新引用一个资源，打包自动跟上；
// 引用了不存在的文件，打包直接失败（而不是产出一个装不上的 zip）。
//
// 用法：
//   node scripts/package-extension.mjs              # 先重建产物，再打 release/recallflow-v<版本>.zip
//   node scripts/package-extension.mjs --no-build   # 信任现有产物，直接打包（快，但可能装进旧代码）
//   node scripts/package-extension.mjs --out <路径>  # 自定义输出（默认 release/recallflow-v<版本>.zip）
//
// zip 说明（零依赖、确定性）：
//   - 只用 node:zlib 的 deflateRaw（level 9），不引第三方压缩包；
//   - 所有条目时间戳固定为 1980-01-01（DOS 纪元）、按文件名排序 —— 同一份源码
//     打出的 zip 字节级可复现（唯一例外：zlib 版本差异可能让 deflate 字节不同，
//     同机器同 Node 版本无此问题）；不追求跨 zlib 版本的字节一致，只要求"可复现可校验"。
//   - 文件名全 ASCII，仍置 UTF-8 标志位（0x0800），任何解压器都不歧义。
import { ENTRIES } from './build-entries.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- 参数 ----
const argv = process.argv.slice(2);
const doBuild = !argv.includes('--no-build');
const outIdx = argv.indexOf('--out');
const OUT_OVERRIDE = outIdx >= 0 ? argv[outIdx + 1] : null;

// ---- 1. 读 manifest：版本号 + 一级引用 ----
const manifestPath = path.join(ROOT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const VERSION = String(manifest.version || '').trim();
if (!VERSION) throw new Error('manifest.json 缺少 version 字段，无法命名发布包。');

/** 收集 manifest 里引用的仓库相对路径（不含 manifest 自己，它必进包）。 */
function manifestRefs(m) {
  const refs = [];
  const push = (p) => { if (typeof p === 'string' && p.trim()) refs.push(normLocal(p)); };
  // 图标：顶层 icons 与 action.default_icon 两处，键是尺寸、值是路径。
  for (const group of [m.icons, m.action && m.action.default_icon]) {
    if (group && typeof group === 'object') for (const v of Object.values(group)) push(v);
  }
  if (m.action && m.action.default_popup) push(m.action.default_popup);
  if (m.background && m.background.service_worker) push(m.background.service_worker);
  if (m.options_ui && m.options_ui.page) push(m.options_ui.page);
  for (const cs of m.content_scripts || []) for (const js of cs.js || []) push(js);
  for (const css of (m.content_scripts || []).flatMap((cs) => cs.css || [])) push(css);
  for (const war of m.web_accessible_resources || []) {
    for (const res of war.resources || []) push(res);
  }
  return refs;
}

/** 本地相对路径归一：去查询串/锚点，拒协议与绝对路径（那些不是包内资源）。 */
function normLocal(p) {
  const clean = String(p).split('#')[0].split('?')[0];
  if (!clean || /^(https?:|data:|chrome|moz-|#|\/\/)/.test(clean) || path.isAbsolute(clean)) return null;
  return clean;
}

// ---- 2. 扩展页 HTML 引用：script/link 的本地资源，HTML 之间互相链接要递归 ----
export function htmlRefs(relHtml, seen) {
  const abs = path.join(ROOT, relHtml);
  const text = fs.readFileSync(abs, 'utf8');
  const out = [];
  const re = /(?:src|href)\s*=\s*"([^"]+)"/g;
  for (let m; (m = re.exec(text)); ) {
    const rel = normLocal(m[1]);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
    // HTML 里链到的另一个扩展页（popup 链 manager/options/skills/userscripts）也进包，
    // 它自己引用的资源继续往下收 —— 递归到没有新 HTML 为止。
    if (rel.endsWith('.html')) out.push(...htmlRefs(rel, seen));
  }
  return out;
}

// ---- 3. 组装白名单 ----
export function collectFiles() {
  const seen = new Set(['manifest.json']);
  const files = ['manifest.json'];
  const add = (rel) => {
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    files.push(rel);
    if (rel.endsWith('.html')) files.push(...htmlRefs(rel, seen));
  };
  for (const rel of manifestRefs(manifest)) add(rel);
  // 入口构建产物清单：与 build-entries.mjs 共用同一份 ENTRIES，杜绝清单漂移。
  for (const entry of ENTRIES) add(entry.out);
  // content.js 是 build-content.mjs 的产物（ENTRIES 之外的第 9 个构建产物）。
  add('content.js');
  return files;
}

// ---- 4. 校验：存在性 + 不混入源码/测试/脚本 ----
export function validate(files) {
  // 先判"类别"再判"存在"：源码/测试/脚本压根不该出现在包里 —— 哪怕它此刻不存在，
  // 报"文件不存在"也会把人引去"跑构建"，而真正的问题是指错了一类文件。
  const bad = files.filter(
    (rel) => rel.endsWith('.ts') || rel.includes('node_modules') || rel.startsWith('tests/') ||
      rel.startsWith('scripts/') || rel.startsWith('entries/')
  );
  if (bad.length) {
    throw new Error('包内混入了非运行时文件：\n  ' + bad.join('\n  '));
  }
  const missing = files.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  if (missing.length) {
    throw new Error(
      '包内引用了不存在的文件（先跑构建，或检查 manifest/HTML 引用）：\n  ' + missing.join('\n  ')
    );
  }
}

// ---- 5. 构建（默认先重建，防止把旧产物打进发布包）----
function runBuild() {
  for (const script of ['scripts/build-content.mjs', 'scripts/build-entries.mjs']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, script)], {
      stdio: 'inherit',
      cwd: ROOT,
    });
    if (r.status !== 0) throw new Error(`${script} 失败（exit ${r.status}），中止打包。`);
  }
}

// ---- 6. 零依赖 zip（deflate + 中心目录）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 组装一份确定性 zip。条目按文件名排序；时间戳固定 DOS 纪元。 */
export function buildZip(entries) {
  // 第一遍：算好每条目的压缩结果与它在数据区的起始偏移。
  // 压缩结果只算一次并保留，第二遍（中心目录）直接复用 —— 避免重复 deflate，
  // 也避免"重算一次万一不一致"的隐患。
  const recs = [];
  const localParts = [];
  let dataOffset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length; // 压不小就回落 STORE
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    recs.push({ name, nameBuf, crc, payload, method, usize: data.length, lofs: dataOffset });

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);  // 本地头签名
    local.writeUInt16LE(20, 4);          // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6);      // 通用标志：文件名 UTF-8
    local.writeUInt16LE(method, 8);      // 压缩方法 8=deflate / 0=store
    local.writeUInt16LE(0, 10);          // 修改时间 00:00
    local.writeUInt16LE(0x21, 12);       // 修改日期 1980-01-01（DOS 纪元，固定值保证可复现）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18); // 压缩后大小
    local.writeUInt32LE(data.length, 22);    // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // 无 extra
    localParts.push(local, nameBuf, payload);
    dataOffset += 30 + nameBuf.length + payload.length;
  }

  // 第二遍：中心目录。字段偏移严格按 PKZIP APPNOTE 的 46 字节结构；
  // lofs（42 处）存的是**本地头在数据区的起始偏移**（即上面的 recs[i].lofs），
  // 不是中心目录自身的位置 —— 这两者别混。
  const cdStart = dataOffset;
  const centralParts = [];
  let cdSize = 0;
  for (const r of recs) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);  // 中心目录签名
    central.writeUInt16LE(0x031e, 4);      // 制作方：unix + 版本 3.0
    central.writeUInt16LE(20, 6);          // 解压所需版本
    central.writeUInt16LE(0x0800, 8);      // 通用标志：文件名 UTF-8
    central.writeUInt16LE(r.method, 10);   // 压缩方法
    central.writeUInt16LE(0, 12);          // 修改时间
    central.writeUInt16LE(0x21, 14);       // 修改日期 1980-01-01
    central.writeUInt32LE(r.crc, 16);
    central.writeUInt32LE(r.payload.length, 20); // 压缩后大小
    central.writeUInt32LE(r.usize, 24);          // 原始大小
    central.writeUInt16LE(r.nameBuf.length, 28);
    central.writeUInt16LE(0, 30);          // extra 长度
    central.writeUInt16LE(0, 32);          // 注释长度
    central.writeUInt16LE(0, 34);          // 起始磁盘号
    central.writeUInt16LE(0, 36);          // 内部属性
    central.writeUInt32LE(0, 38);          // 外部属性
    central.writeUInt32LE(r.lofs, 42);     // 本地头偏移
    centralParts.push(central, r.nameBuf);
    cdSize += 46 + r.nameBuf.length;
  }

  // 第三段：EOCD。只累加一次，且 cdsize 就是中心目录自身的字节数。
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);               // 本磁盘号
  eocd.writeUInt16LE(0, 6);               // 中心目录起始磁盘号
  eocd.writeUInt16LE(entries.length, 8);  // 本磁盘条目数
  eocd.writeUInt16LE(entries.length, 10); // 总条目数
  eocd.writeUInt32LE(cdSize, 12);         // 中心目录大小
  eocd.writeUInt32LE(cdStart, 16);        // 中心目录偏移
  eocd.writeUInt16LE(0, 20);              // 注释长度
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/**
 * 采集真实仓库的运行时文件并打成 zip，返回条目清单与 zip 字节。
 * 抽出来是为了让测试能直接断言**真实产物**，而不必自己再 readFileSync 一遍。
 */
export function makeReleaseZip() {
  const files = collectFiles();
  validate(files);
  const entries = files
    .sort()
    .map((rel) => ({ name: rel, data: fs.readFileSync(path.join(ROOT, rel)), rel }));
  return { entries, zip: buildZip(entries.map(({ name, data }) => ({ name, data }))) };
}

// ---- 主流程 ----
function main() {
  if (doBuild) {
    console.log('==> 重建产物（content.js + 入口）');
    runBuild();
  } else {
    console.log('==> --no-build：信任现有产物（发布前请确认已跑过构建）');
  }

  // 与 package.json 的版本号对齐只是提醒，不拦（两者本就应一致，漂移多半是忘了改 manifest）。
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg.version && pkg.version !== VERSION) {
      console.warn(`! 版本提醒：manifest=${VERSION}，package.json=${pkg.version}（发布 tag 建议与 manifest 一致）`);
    }
  } catch {}

  const { entries, zip } = makeReleaseZip();

  const outAbs = path.resolve(ROOT, OUT_OVERRIDE || path.join('release', `recallflow-v${VERSION}.zip`));
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, zip);

  const totalBytes = entries.reduce((s, e) => s + e.data.length, 0);
  const fmt = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log(`\n==> 打包完成：${path.relative(ROOT, outAbs)}`);
  console.log(`    文件 ${entries.length} 个 | 解包 ${fmt(totalBytes)} | zip ${fmt(zip.length)}`);
  console.log('    安装方式：解压后 Chrome → chrome://extensions → 开发者模式 → 加载已解压的扩展程序');
  for (const e of entries) {
    console.log(`      ${e.name.padEnd(40)} ${fmt(e.data.length)}`);
  }
}

// 与 build-entries/build-content 相同的主守卫：被 import 时（测试）不跑 main。
if (process.argv[1] && /package-extension\.mjs$/.test(process.argv[1])) {
  main();
}

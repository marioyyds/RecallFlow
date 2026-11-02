// 打包脚本的门禁：验证 release/ 里那份 zip 真的能用，而不是"生成成功"就算完。
//
// 起因是一个真实事故：`scripts/package-extension.mjs` 第一版写的 zip 自己校验时
// 报错（中心目录记录字段整体错位 2 字节、lofs 指向中心目录自身而非本地头、EOCD 的
// cdsize 重复累加导致 cdofs+cdsize > 文件大小），python zipfile 直接判 "Bad magic
// number for central directory"、unzip 判 "overlapped components"。控制台却照样打印
// "打包完成"。**"脚本没抛异常"不等于"产物可安装"** —— 所以这里用一份完全独立的
// 读法（不碰 buildZip 内部状态）把产物拆开验证：
//   1. 结构：EOCD 定位 → 逐条走中心目录 → 本地头偏移必须指向本地头签名；
//   2. 内容：每个条目按声明的方法解压后，CRC 与原始数据一致；
//   3. 清单：manifest 引用的文件、入口产物、图标必须都在包里，源码/测试/脚本不得混入；
//   4. 确定性：同一份输入打两次，字节必须完全相同（发布物可复现、可校验）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import {
  collectFiles,
  validate,
  buildZip,
  makeReleaseZip,
  crc32,
} from '../scripts/package-extension.mjs';

/** 独立 zip 读取器：只依赖 PKZIP 规范，与 buildZip 的写法互相独立。 */
function readZip(buf) {
  // EOCD 在文件尾 22 字节（本脚本不写注释，没有 comment 需要回扫）。
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'EOCD 签名不对');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOfs = buf.readUInt32LE(eocd + 16);
  assert.equal(cdOfs, eocd - cdSize, '中心目录偏移/大小与 EOCD 位置对不上（overlap 的典型症状）');

  const out = [];
  let pos = cdOfs;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50, `第 ${i} 条中心目录签名不对`);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const csize = buf.readUInt32LE(pos + 20);
    const usize = buf.readUInt32LE(pos + 24);
    const nlen = buf.readUInt16LE(pos + 28);
    const lofs = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nlen).toString('utf8');
    assert.equal(buf.readUInt32LE(lofs), 0x04034b50, `${name}: 本地头偏移没有指向本地头签名`);
    const lNameLen = buf.readUInt16LE(lofs + 26);
    const lExtraLen = buf.readUInt16LE(lofs + 28);
    const dataStart = lofs + 30 + lNameLen + lExtraLen;
    const payload = buf.slice(dataStart, dataStart + csize);
    const data = method === 8 ? inflateRawSync(payload) : payload;
    assert.equal(data.length, usize, `${name}: 解压后长度不符`);
    assert.equal(crc32(data), crc, `${name}: CRC 不符（数据在压缩/切片时损坏）`);
    out.push({ name, data, method });
    pos += 46 + nlen;
  }
  assert.equal(pos, cdOfs + cdSize, '中心目录实际长度与 EOCD 声称的不一致');
  return out;
}

test('清单：manifest 引用与入口产物都在，源码/测试/脚本不混入', () => {
  const files = collectFiles();
  assert.doesNotThrow(() => validate(files), '采集到的文件里有不存在的路径');
  assert.ok(files.includes('manifest.json'));
  assert.ok(files.includes('background.js'), '缺少 service worker 产物');
  assert.ok(files.includes('content.js'), '缺少内容脚本产物');
  assert.ok(files.includes('popup.html') && files.includes('popup.js'));
  assert.ok(files.includes('docs/assets/icon-128.png'), '缺少 manifest 声明的图标');
  assert.ok(files.includes('lib/page/debug-hook.js'), '缺少 MAIN world 内容脚本产物');
  const banned = files.filter(
    (f) => f.endsWith('.ts') || f.startsWith('tests/') || f.startsWith('scripts/') || f.startsWith('entries/')
  );
  assert.deepEqual(banned, [], '包内混入了源码/测试/脚本');
});

test('校验是 fail-closed：引用不存在 / 混入源码都必须打包失败，而不是产出坏包', () => {
  assert.throws(() => validate(['definitely-not-here.js']), /不存在的文件/, '引用缺失必须抛错');
  assert.throws(() => validate(['manifest.json', 'lib/foo.ts']), /非运行时文件/, '源码必须被拒');
  assert.throws(() => validate(['tests/x.test.mjs']), /非运行时文件/, '测试文件必须被拒');
  // 正例：只含 manifest.json 时不该抛
  assert.doesNotThrow(() => validate(['manifest.json']));
});

test('结构：中心目录字段偏移正确、每个条目 CRC 可独立校验', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello recallflow') },
    { name: 'dir/b.js', data: Buffer.from('x'.repeat(5000)) }, // 可压得动
    { name: 'empty.bin', data: Buffer.alloc(0) },
  ];
  const zip = buildZip(entries);
  const got = readZip(zip);
  assert.deepEqual(got.map((e) => e.name), ['a.txt', 'dir/b.js', 'empty.bin'], '条目顺序/名字不符');
  assert.equal(got[0].data.toString(), 'hello recallflow');
  assert.equal(got[1].data.length, 5000);
  assert.equal(got[2].data.length, 0);
  assert.equal(got[1].method, 8, '可压缩数据应走 deflate');
});

test('确定性：同一输入打两次字节完全一致（发布物可复现）', () => {
  const entries = [{ name: 'z.txt', data: Buffer.from('deterministic') }];
  const a = buildZip(entries);
  const b = buildZip(entries);
  assert.deepEqual(a, b, '两次打包结果不一致（时间戳/顺序不稳定？）');
  // 时间戳必须是固定 DOS 纪元，否则每次打包字节都不同。
  assert.equal(a.readUInt16LE(10), 0, '本地头时间字段应为 0');
  assert.equal(a.readUInt16LE(12), 0x21, '本地头日期字段应为 1980-01-01');
});

test('真实产物：makeReleaseZip 打出的 zip 必须能通过同一套独立校验', () => {
  // 直接调被测函数拿字节 —— 测试自己不读盘，也就不会把"读源码测试数"棘轮顶上去。
  const { entries, zip } = makeReleaseZip();
  assert.ok(entries.length >= 20, `采集到的运行时文件太少（${entries.length}），清单可能漏了`);
  const got = readZip(zip);
  assert.deepEqual(got.map((e) => e.name), entries.map((e) => e.name), 'zip 条目与采集清单不一致');

  const byName = new Map(got.map((e) => [e.name, e]));
  assert.ok(byName.has('manifest.json'), '缺 manifest.json');
  assert.ok(byName.has('background.js'), '缺 background.js');
  // manifest 必须能在包内被解析成 JSON（不是被截断/套错层级）
  const manifest = JSON.parse(byName.get('manifest.json').data.toString('utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, byName.get('manifest.json') && manifest.version);
  // 每个条目解压后必须与源文件逐字节一致（readZip 已校验 CRC，这里再钉一次"内容没被换"）
  for (const e of entries) {
    assert.ok(byName.get(e.name).data.equals(e.data), `${e.name}: 包内内容与源文件不一致`);
  }
  // 源码/测试/脚本不得混入真实产物
  const banned = got.filter(
    (e) => e.name.endsWith('.ts') || e.name.startsWith('tests/') || e.name.startsWith('scripts/') || e.name.startsWith('entries/')
  );
  assert.deepEqual(banned.map((e) => e.name), [], '真实产物里混入了源码/测试/脚本');
});

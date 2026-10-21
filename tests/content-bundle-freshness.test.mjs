// 内容脚本产物的**新鲜度与规格**门禁。
//
// 背景（这是一条真实的假绿通道）：`content.js` 是提交进仓库的打包产物，而 E2E 加载的
// 是这个产物、不是 `lib/page/**` 的源码。于是改完 `chat.js` 忘了跑
// `node scripts/build-content.mjs` 时，E2E 会**对着旧代码全绿** ——
// 它既不会报错，也不会提示，只是悄悄测了个已经不存在的东西。
//
// 本轮就是这么发现问题的：改完 chat.js 重建产物，脚本打出「产物 415 KB」并 **exit 1**
// （体积预算 410KB）。而在此之前没有任何门禁跑过这个脚本，于是「体积早就超了」
// 和「产物可能过期」两件事都没有人知道。
//
// 所以这里守三件事：
//   ① 盘上的 content.js 与现在源码打出来的东西**逐字节一致**（忽略了行尾差异）；
//   ② 产物的规格（自包含、体积在预算内）由 build-content.mjs 里那套判据检查；
//   ③ 预算这条棘轮不能松到失去意义 —— 它必须离实际体积足够近。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildContentBundle,
  checkBundle,
  compareBundle,
  SIZE_BUDGET_BYTES,
} from '../scripts/build-content.mjs';

// 构建一次给所有用例用（esbuild 一次约 0.3~0.6 秒，别每条用例都跑）。
let cached = null;
function bundle() {
  if (!cached) cached = buildContentBundle({ write: false });
  return cached;
}

/** 盘上那份（提交进仓库的）产物。 */
function diskBundle() {
  return fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
}

test('content.js 与源码同步（改了 lib/page/** 或 lib/shared/** 就必须重建）', async () => {
  const built = await bundle();
  const disk = diskBundle();
  // 先确认两边都不是空的：否则「空 === 空」会让这条门禁变成一句废话。
  assert.ok(built.text.length > 20000, '内存产物太小，构建本身就不正常：' + built.text.length);
  assert.ok(disk.length > 20000, '盘上产物太小，可能被清空了：' + disk.length);

  const diff = compareBundle(disk, built.text);
  assert.equal(
    diff,
    null,
    'content.js 已过期（第一处差异在第 ' +
      (diff && diff.line) +
      ' 行；盘上 ' +
      (diff && diff.diskLines) +
      ' 行 / 实际应 ' +
      (diff && diff.builtLines) +
      ' 行）。\n' +
      '  E2E 加载的是这个产物，不是源码 —— 不重建就等于在测旧代码。\n' +
      '  修法：node scripts/build-content.mjs（改的是 lib/page/** 或 lib/shared/** 时必做）'
  );
});

test('产物规格：自包含（无运行时动态 import）且体积在预算内', async () => {
  const built = await bundle();
  assert.deepEqual(checkBundle(built.text, built.bytes), [], '产物规格不合格（见 build-content.mjs 的说明）');
});

test('体积棘轮离实际足够近（松到 3 倍就失去意义了）', async () => {
  const built = await bundle();
  assert.ok(built.bytes <= SIZE_BUDGET_BYTES, '超过预算：' + built.bytes + ' > ' + SIZE_BUDGET_BYTES);
  // 预算的意义是「比现在略宽」，防的是下一次无声膨胀。
  // 若预算被上调到远大于实际，它就只是个装饰 —— 这条盯着那个方向。
  assert.ok(
    SIZE_BUDGET_BYTES - built.bytes < 16 * 1024,
    '体积预算离实际太远（余量 ' +
      Math.round((SIZE_BUDGET_BYTES - built.bytes) / 1024) +
      ' KB）：请把它收紧到实际体积之上 16KB 以内，否则这次膨胀不会再被下一次抓住'
  );
});

test('比较器本身有牙：真有差异时必须指出第一处不同在第几行', () => {
  // 用合成数据验证判据 —— 否则「永远返回 null」也能让上面那条用例绿。
  assert.equal(compareBundle('a\nb\nc', 'a\nb\nc'), null);
  assert.deepEqual(compareBundle('a\nb\nc', 'a\nX\nc'), { line: 2, diskLines: 3, builtLines: 3 });
  // 行尾差异（git autocrlf 会把签出的文件变成 CRLF）**不算**过期
  assert.equal(compareBundle('a\r\nb', 'a\nb'), null, '行尾不能被当成内容差异，否则 Windows 上这条门禁永远红');
  // 少了一行 / 多了一行都要能看出来
  assert.deepEqual(compareBundle('a\nb', 'a\nb\nc'), { line: 3, diskLines: 2, builtLines: 3 });
  assert.deepEqual(compareBundle('', 'a'), { line: 1, diskLines: 1, builtLines: 1 });
});

test('规格判据本身有牙：动态 import 与超预算都要被点出来', () => {
  const ok = checkBundle('var a = 1;\n', 100);
  assert.deepEqual(ok, []);
  assert.deepEqual(
    checkBundle('var p = import("./x.js");', 100).map((p) => p.code),
    ['dynamic-import'],
    '运行时动态 import 会让产物继续依赖 web_accessible_resources（等于没打包）'
  );
  assert.deepEqual(
    checkBundle('var a = 1;', SIZE_BUDGET_BYTES + 1).map((p) => p.code),
    ['too-large']
  );
  // 两条同时不满足时都要报，不能只报第一条就返回
  assert.deepEqual(
    checkBundle('import("./x.js");', SIZE_BUDGET_BYTES + 1).map((p) => p.code).sort(),
    ['dynamic-import', 'too-large']
  );
});

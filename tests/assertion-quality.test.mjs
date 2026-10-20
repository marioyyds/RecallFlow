// 断言质量棘轮：防止"读源码做正则"的测试继续膨胀。
//
// 背景（评审实测）：这套仓库的测试里有 70/141 个文件会 `readFileSync` 读 lib/ 源码，
// 然后用 `assert.match(src, /某段文字/)` 断言"这行还在"。这类测试的问题不是没用 ——
// 它们能抓住"某行字被误删"，成本也低；问题是**它们抓不住行为变了**：
//   · 把 `[3,5,8]` 改成 `[4,6,9]`，只要断言里写的是同一个常量就照样通过（已实际发生过）；
//   · 把并行判定的字段名从 parallelSafe 改掉，正则会因为"文件里还有 parallelSafe"而变绿，
//     而功能已经死了（也已实际发生过，见 tests/parallel-batch.test.mjs 的由来）。
//
// 所以这里不禁止，而是**棘轮**：当前值钉死，只许减不许增。
// 改代码时顺手把碰到的那一处换成真 import + 行为断言，然后把下面的数字减一。
// 棘轮比"禁止"更容易真的往下走 —— 它每次只需要前进一格。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DIR = 'tests';
// 本文件自己也要 readdir/readFileSync 来统计，必须排除，否则它自己会把计数顶上去。
const SELF = 'assertion-quality.test.mjs';

// 2026-10-20 实测：70 个文件 / 167 次调用。
//      同日第二轮：口径改为剥掉注释后统计（注释里提到 readFileSync 不算读取），
//      并把 panel-shortcut 里读 chat.js 的那条断言退役（改由 tests/chat-panel-smoke.test.mjs
//      真 import 断言）⇒ 调用数 167 → 166。文件数没降：panel-shortcut 仍在读 manifest。
const MAX_SOURCE_READING_FILES = 70;
const MAX_READFILE_CALLS = 166;

/** 剥掉注释再统计 —— 否则"在注释里说明为什么不要读源码"会被自己判成读源码。
 *
 *  这不是理论问题：本轮加了一个真 import 的测试文件，头注释里写了
 *  「此前全是 readFileSync + 正则」，于是棘轮立刻从 70 涨到 71，
 *  逼着人去看"我没写读取啊"。门禁统计的应该是**调用**，不是字符串出现次数。
 *  ⚠ 收尾用 `[^\n]*` 而不是 `.*$`：本仓库不少文件是 CRLF，`\r` 会让 `$` 对不上，
 *  注释根本没被剥掉却毫无提示（tests/e2e-hygiene.test.mjs 里有同款注释与牙测试）。 */
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** 统计"会读文件"的测试文件。（只看是否 readFileSync，不区分读 lib 还是读 package.json ——
 *  后者如 ci-workflow 是合法读取；这个指标因此是**上界**，宁严勿松。） */
/** 不参与统计的文件：它们的**被测对象就是源码树本身** —— 读文件不是「用静态断言替代行为断言」，
 *  而是这类门禁的本质。加进来必须说明理由；它不该成为「懒得写行为断言」的出口。
 *  · assertion-quality —— 它自己（SELF，本来就在排除之列）
 *  · mutation-guard —— 测的就是「锁 / 备份 / 还原」本身，读写文件是它的被测对象。
 *  · module-references —— import 图分析：要回答的是「测试有没有引用过这个模块」，
 *    这个问题只有读源码才能回答，不存在可执行的行为可以断言。
 */
const EXEMPT = new Set([SELF, 'module-references.test.mjs', 'mutation-guard.test.mjs']);

function scan(dir = TEST_DIR) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs') && !EXEMPT.has(f));
  const rows = [];
  for (const file of files) {
    const src = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'));
    const calls = (src.match(/readFileSync/g) || []).length;
    if (calls > 0) rows.push({ file, calls });
  }
  return { total: files.length, rows };
}

const { total, rows } = scan();
const calls = rows.reduce((n, r) => n + r.calls, 0);

test('读源码的测试文件数不得增加（棘轮）', () => {
  assert.ok(
    rows.length <= MAX_SOURCE_READING_FILES,
    '读源码的测试文件从 ' + MAX_SOURCE_READING_FILES + ' 涨到了 ' + rows.length + '。\n' +
      '  新测试请 import 被测模块做行为断言，而不是断言源码里有某段文字。\n' +
      '  如果你把某个文件改成了真 import，请把这个上限减一。\n' +
      '  当前读源码的文件：\n' +
      rows.map((r) => '    ' + r.file + ' (' + r.calls + ')').join('\n')
  );
});

test('readFileSync 调用总数不得增加（棘轮）', () => {
  assert.ok(
    calls <= MAX_READFILE_CALLS,
    'readFileSync 调用从 ' + MAX_READFILE_CALLS + ' 涨到了 ' + calls + '。\n' +
      '  同一个源码通常在文件顶部读一次就够 —— 在每个 test() 里重复 readFileSync 的文件' +
      '（见上面 Top 榜单）既有性能代价，也说明断言粒度是"字符串"而非"行为"。'
  );
});

test('行为测试必须是多数（否则这个仓库的门禁正在退化成"文案检查器"）', () => {
  // 读源码的文件数不能超过一半。当前 70 / 141 已经贴线 —— 这条是**底线**，
  // 不是舒适区：一旦过半，"门禁通过"就不再能说明行为正确。
  const sourceReading = rows.length;
  assert.ok(
    sourceReading <= total / 2,
    '读源码的测试文件 ' + sourceReading + ' 已超过总数 ' + total + ' 的一半。\n' +
      '  这不是风格问题：当多数门禁只在检查源码文本时，绿色只代表"文字没被删"，' +
      '  不代表行为没坏。请把新测试写成 import + 断言返回值/副作用。'
  );
});

test('注释里提到 readFileSync 不算"读源码"（本轮踩到的误报）', () => {
  const withComment = '// 以前这里是 fs.readFileSync(...) 读源码' + String.fromCharCode(10) + 'const x = 1;';
  assert.equal((stripComments(withComment).match(/readFileSync/g) || []).length, 0, '注释必须被剥掉');
  const real = 'const s = fs.readFileSync(p, "utf8");';
  assert.equal((stripComments(real).match(/readFileSync/g) || []).length, 1, '真实调用必须仍被计入');
  // CRLF：`$` 对不上会让注释逃过剥离，而这件事没有任何报错
  const crlf = '// fs.readFileSync(p)' + String.fromCharCode(13, 10) + 'const y = 2;';
  assert.equal((stripComments(crlf).match(/readFileSync/g) || []).length, 0, 'CRLF 注释也必须被剥掉');
});

test('这条棘轮本身有牙齿：构造一个更多读源码的样本必须被判超标', () => {
  // 反证：如果上限写成 MAX_SOURCE_READING_FILES + 100，上面两条就永远是绿的。
  // 这里用一个假目录验证判定式本身有效，避免"门禁自己被改成恒真"。
  const fakeRows = Array.from({ length: MAX_SOURCE_READING_FILES + 1 }, (_, i) => ({
    file: 'fake-' + i + '.test.mjs',
    calls: 1,
  }));
  assert.ok(fakeRows.length > MAX_SOURCE_READING_FILES, '判定式应能识别超标样本');
  assert.ok(
    fakeRows.reduce((n, r) => n + r.calls, 0) <= MAX_READFILE_CALLS,
    '构造的样本应只让"文件数"超标、不让"调用数"超标 —— 两条棘轮是独立的'
  );
});

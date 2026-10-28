// 「滚动**内部可滚动容器**」的门禁。
//
// ## 起因（做虚拟列表场景时挖出的能力缺口）
//
// 原先 `scroll_page` 只有两条路：
//   · 有 ref/selector/text → `scrollIntoView`（对已经在视口里的容器是**空操作**，`y` 被直接忽略）；
//   · 没有目标 → `scroll_by` → **`window.scrollBy`（只动窗口）**。
// 于是"把某个 overflow 容器滚到第 87 条"**没有任何一等公民的滚法** ——
// 只能反复把可见行 scrollIntoView 慢慢推，或者用 run_javascript 自己设 scrollTop
// （一次高危审批，而且丢掉了工具的滚动结果回报）。
//
// 虚拟列表 / 带 overflow 的面板全是这种容器，所以这是个**真缺口**，不是理论问题。
//
// 修法：给了 `ref/selector/text` **又**给了 `x`/`y` 时，滚**这个元素自身**
// （`el.scrollTop += y`），并在结果里回报**实际落点** ——
// 模型据此判断"滚到哪了 / 有没有到边界"。
//
// 行为层的证明在 tests/e2e/golden.spec.mjs 的「虚拟列表」用例（它真的滚了容器并点开了第 87 条）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const cmdSrcRaw = fs.readFileSync('lib/page/command-overlays.ts', 'utf8');
const schemaSrcRaw = fs.readFileSync('lib/assistant/tool-schemas.ts', 'utf8');

/**
 * 去掉注释再做**源码级**扫描。
 *
 * ⚠ 这个文件的第一版被两件事连着咬：
 *   ① 注释里写着"`{ selector }` 走 scrollIntoView……"（那是在**说明**旧行为），
 *      而断言 `indexOf('scrollIntoView')` 正好命中**注释** → 误判；
 *   ② 照抄了别处 `split('\n') + /\/\/.*$/` 的写法 —— 而**本仓库不少文件是 CRLF**，
 *      此时行尾的 `\r` 让 `.` 与 `$` 都对不上，**注释根本没被剥掉**（静默失效）。
 *      所以这里的写法用 `[^\n]*` 收尾，不依赖 `$`，CRLF/LF 都吃。
 * 门禁要管的是**代码**；一个"以为剥了注释、其实没剥"的门禁比没有更糟。
 */
const stripComments = (s) =>
  String(s)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

const cmdSrc = stripComments(cmdSrcRaw);
const schemaSrc = schemaSrcRaw; // schema 的说明**就在字符串里**，不能去注释

/** 取一个顶层函数的源码体（到下一个顶层 function 为止）。 */
function fnBody(src, name) {
  const re = new RegExp('^(?:export\\s+)?(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm');
  const m = re.exec(src);
  if (!m) return '';
  const rest = src.slice(m.index + m[0].length);
  const next = /^(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

test('cmdScrollTo 必须支持「滚目标元素自身」：给了目标又给 y/x 时动 scrollTop/scrollLeft', () => {
  const body = fnBody(cmdSrc, 'cmdScrollTo');
  assert.ok(body, '应能找到 cmdScrollTo');
  assert.match(body, /scrollTop\s*=/, '必须直接设置目标的 scrollTop（滚容器，而不是窗口）');
  assert.match(body, /scrollLeft\s*=/, '横向同理');
  // 必须发生在 scrollIntoView 分支**之前**，否则目标被当作"滚到它"就结束了，y 又被忽略
  const iOffset = body.indexOf('scrollTop =');
  const iIntoView = body.indexOf('scrollIntoView');
  assert.ok(iOffset > -1 && iIntoView > -1 && iOffset < iIntoView, '偏移处理必须排在 scrollIntoView 之前');
});

test('滚容器后必须回报**实际落点**（否则模型不知道滚到哪了、有没有到边界）', () => {
  const body = fnBody(cmdSrc, 'cmdScrollTo');
  assert.match(body, /scrollTop=/, '结果文本里要带实际 scrollTop');
  assert.match(body, /位置没变|到边界/, '位置没变时要说明（不可滚动 / 已到边界），不能只报"已滚动"');
});

test('schema 里 y/x 的说明必须与实现一致（别写反成"有目标时忽略"）', () => {
  // 原先写的是「有 ref/selector/text/top/left 时忽略」—— 与当时的实现一致，
  // 但那正是缺口的来源；改完之后必须说清"给了目标就是滚该元素自身"。
  const yLine = (schemaSrc.match(/y: \{ type: 'number', description: '([^']*)' \}/) || [])[1] || '';
  assert.ok(yLine, '应能找到 y 的说明');
  assert.match(yLine, /该元素自身|元素自身/, 'y 的说明必须点明"给了目标时滚该元素自身"');
  assert.ok(!/有 ref\/selector\/text\/top\/left 时忽略/.test(yLine), '不得再写成"有目标时忽略"');
});

test('stripComments 必须能吃 CRLF（否则注释没被剥掉，门禁会被自己的说明骗过）', () => {
  // 实测：`split('\n') + /\/\/.*$/` 在 CRLF 上行不通 ——
  // 行尾的 `\r` 让 `.`（不匹配行终止符）与 `$`（只认结尾或最后一个 \n）双双对不上。
  const crlf = 'const a = 1; // 说明里提到 scrollIntoView\r\nconst b = 2;\r\n';
  const out = stripComments(crlf);
  assert.ok(!out.includes('scrollIntoView'), 'CRLF 下的行尾注释必须被剥掉');
  assert.ok(out.includes('const b = 2;'), '代码本身要留着');
  // 块注释与 LF 同样要正常
  assert.ok(!stripComments('/* scrollIntoView */ x').includes('scrollIntoView'));
  assert.ok(!stripComments('x // scrollIntoView\ny').includes('scrollIntoView'));
});

test('这条门禁本身有牙齿：修复前的形态必须被判为不合格', () => {  // 修复前：有目标就只 scrollIntoView，y 完全没被用上
  const before = "if (params.ref || params.text || params.selector) {\n const els = findElementsFor(params);\n els[0].scrollIntoView({ behavior, block });\n return { ok: true, result: '已滚动到目标元素' };\n}";
  assert.ok(!/scrollTop\s*=/.test(before), '旧形态不含 scrollTop 赋值 → 会被上面第一条判为不合格');
  assert.ok(!/scrollTop=/.test(before), '旧形态也不回报落点 → 会被第二条判为不合格');

  const after = 'box.scrollTop = prevTop + offY; return { result: "scrollTop=" + box.scrollTop };';
  assert.ok(/scrollTop\s*=/.test(after), '新形态含 scrollTop 赋值');
  assert.ok(/scrollTop=/.test(after), '新形态含落点回报');
});

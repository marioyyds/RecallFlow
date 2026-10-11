// 快照"元素被裁掉"这件事必须**说出来**，而不是只留一个数字。
//
// ## 起因（一次真实的排查）
//
// 日期选择器的 E2E 里，「已订满」怎么都进不了上下文。逐项排除后定位到机制：
//   · `page-text.js` 的 `elements` **不是文档顺序**，而是按"离视口中心的远近"排序后
//     取前 `maxElements`（默认 60，上限 150）；
//   · 再过 `trimElementsToBudget` 按**体积预算**裁剪（返回 `omittedBySize`）。
// 日历格子在视口外 ⇒ 排在最后 ⇒ 先被裁。而 `counts.omittedBySize` 只是个数字，
// **模型看不出"被裁了什么、该怎么办"** ✗ —— 它会以为页面上就这些元素。
//
// 这与本仓库的既有纪律一致：状态里必须带"下一步能做什么"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync('lib/assistant/page-read-tools.js', 'utf8');
const PAGE = fs.readFileSync('lib/page/page-text.js', 'utf8');

test('元素被体积预算裁掉时，结果里要说明数量', () => {
  assert.match(SRC, /const omittedBySize = Number\(/, '要真的读 counts.omittedBySize');
  assert.match(SRC, /因\*\*快照体积预算\*\*未列出/, '要有一段人能看懂的说明');
  assert.match(SRC, /omittedBySize > 0/, '没有省略时不该出现这段（免得每次都塞废话）');
});

test('提示必须给出**下一步**（滚进视口 / 直接按选择器操作），而不是只说"被裁了"', () => {
  assert.match(SRC, /scroll_page/, '要告诉模型可以滚动再读');
  assert.match(SRC, /selector|role\+name/, '也要说明不必先"看到"就能操作');
});

test('排序机制有代码依据：elements 按键值排序后截断（不是文档顺序）', () => {
  assert.match(PAGE, /inViewDist/, 'page-text.js 里确实按"离视口中心远近"排序');
  assert.match(PAGE, /\.slice\(0, maxElements\)/, '也确实按 maxElements 截断');
  assert.match(PAGE, /trimElementsToBudget\(describedAll, text\.length\)/, '并再过体积预算');
});

test('这条门禁本身有牙齿：没有省略说明时必须判为不合格', () => {
  const guilty = (src) => !/因\*\*快照体积预算\*\*未列出/.test(src);
  assert.equal(guilty('result: "当前页面 DOM 快照：\\n" + JSON.stringify(snapshot)'), true, '旧写法要被抓');
  assert.equal(guilty(SRC), false, '当前实现不该被抓');
});

test('两端都要带上这段说明（合并子框架的分支也不能漏）', () => {
  const hits = SRC.split('omitHint').length - 1;
  assert.ok(hits >= 3, '定义 1 次 + 两个 return 分支各用 1 次，实际 ' + hits);
});

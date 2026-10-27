// 快照的「可交互元素」采集边界：哪些元素会被收进 `get_page_snapshot`。
//
// ## 为什么值得一条测试
//
// 这个边界**已经误导过我一次** ✗：
//   · B 站/日期夹具里，日期格子写成 `role="listitem"`（不在采集器的 role 名单里）⇒
//     格子**根本不进快照**，连它的 `aria-label`（含「已订满」）也看不到；
//   · 我把它误读成**"快照不列 disabled 元素"**，差点去"修"一个不存在的产品缺陷 ✗
//   · 真实原因是**夹具自己的 markup**：采集器用的是白名单启发式（原生控件 + 常见 ARIA role
//     + tabindex + inline `onclick` + href），`role="listitem"` 不在其中。
//
// 所以这里把边界**写死**：哪些 role 会进、哪些不会、以及 disabled 元素**会**进
//（`disabled` 不影响采集 —— 采集器只筛可见性与排除名单）。
//
// 这不是"缺陷清单"，而是**使用约束**：写夹具（或做能力评估）时，
// 可点击的东西要给它一个采集器认得的 role，否则模型在快照里看不见它。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync('lib/page/page-text.ts', 'utf8');

/** 抽出实际使用的两份名单（不复制粘贴，避免文档与实现漂移）。 */
function selectorList() {
  const at = SRC.indexOf('const INTERACTIVE_SELECTOR = [');
  const end = SRC.indexOf('].join(\',\');', at);
  return SRC.slice(at, end);
}
function roleList() {
  const at = SRC.indexOf('const INTERACTIVE_ROLES = new Set([');
  const end = SRC.indexOf(']);', at);
  return SRC.slice(at, end);
}

test('采集器认得 button / link 等常见 role（夹具要按这些写）', () => {
  const sel = selectorList();
  for (const s of ["'button'", "'a[href]'", "'input'", "'select'", "'textarea'"]) {
    assert.ok(sel.includes(s), 'INTERACTIVE_SELECTOR 应包含 ' + s);
  }
  const roles = roleList();
  for (const r of ["'button'", "'link'", "'checkbox'", "'option'", "'gridcell'"]) {
    assert.ok(roles.includes(r), 'INTERACTIVE_ROLES 应包含 ' + r);
  }
});

test('边界写死：role="listitem" **不在**名单里（格子用它会从快照里消失）', () => {
  const sel = selectorList();
  const roles = roleList();
  assert.ok(!sel.includes("'[role=\"listitem\"]'"), '当前实现不收集 role=listitem（这就是我踩的坑）');
  assert.ok(!roles.includes("'listitem'"), 'INTERACTIVE_ROLES 也不含 listitem');
});

test('这条边界本身有牙齿：若哪天把 listitem 加进名单，本用例会红（提示同步夹具与文档）', () => {
  const guilty = (src) => /'\[role="listitem"\]'/.test(src) || /'listitem'/.test(src);
  assert.equal(guilty('const INTERACTIVE_SELECTOR = [\'[role="listitem"]\'].join(\',\');'), true, '加了就要被抓');
  assert.equal(guilty("const INTERACTIVE_ROLES = new Set(['button', 'listitem']);"), true);
  assert.equal(guilty("const INTERACTIVE_ROLES = new Set(['button']);"), false, '没加不该误报');
});

test('disabled **不影响**采集（这是被我误读的那一点，写清楚以免再误判）', () => {
  // 采集只看：是否在文档内、是否被排除名单命中、是否可见（display/visibility/opacity/尺寸）。
  // 不看 disabled / aria-disabled —— 所以"禁用的按钮读不到"这个结论是错的。
  const at = SRC.indexOf('function isVisibleElement(el) {');
  const body = SRC.slice(at, SRC.indexOf('\n}', at));
  assert.ok(!/disabled/.test(body), '可见性判定里不含 disabled ⇒ disabled 元素照样会被采集');
  // 而 action 层确实会拦：点击/输入前才检查 disabled（那里是正确的地方）
  const commands = fs.readFileSync('lib/page/commands.ts', 'utf8');
  assert.match(commands, /el\.disabled \|\| el\.getAttribute\('aria-disabled'\)/, '动作层才检查 disabled');
});

test('日期夹具必须用采集器认得的 role（防止同一个坑再踩）', () => {
  const fixture = fs.readFileSync('tests/e2e/fixtures/server.mjs', 'utf8');
  const at = fixture.indexOf('function datePickerPage()');
  const body = fixture.slice(at, at + 4000);
  assert.match(body, /setAttribute\('role', 'button'\)/, '日期格子要用 role=button');
  assert.ok(!/setAttribute\('role', 'listitem'\)/.test(body), '不该再用 listitem（那会让格子从快照消失）');
});

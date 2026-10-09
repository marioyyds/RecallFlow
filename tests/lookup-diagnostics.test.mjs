// 定位失败必须**可归因**，动作完成必须**回报状态**。
//
// 实测（会话 RF-V6T7C5，CSDN 首页的冒烟测试）：
//  1. `click_element({role:"button", name:"主题：深色（点击切换）"})` 只回一句「未找到目标元素」。
//     模型只能猜，猜错了还把结论写进报告 —— 它归因成「语义定位器对 shadow DOM 的适配问题」，
//     但代码里 role+name 路径本来就穿透 shadow root，那个结论站不住；真实原因很可能是
//     那个按钮是**三态循环**、aria-label 已经变成「主题：跟随系统（点击切换）」。
//  2. `type_text(clearFirst=true)` 号称「已清空并输入」，最终值却是 `a冒烟测试 smoke-test 123`。
//     工具不回读实际值，于是**无法判断**是它没清干净，还是别处（宏回放的 press_key？）写进去的。
//  3. 主题按钮是三态循环，agent 连点几次后停在「跟随系统」而无法复原 —— 它读不到当前状态。
//
// 三个缺陷同一个根因：**工具做了动作，却不回读可观测状态**。这里锁住修好后的行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// commands.js 依赖 DOM —— 给一个最小替身，只覆盖被调用的表面。
function fakeEl(tag, attrs = {}) {
  const a = Object.assign({}, attrs);
  return {
    tagName: tag.toUpperCase(),
    isConnected: true,
    shadowRoot: null,
    contentDocument: null,
    textContent: a.text || '',
    innerText: a.text || '',
    labels: [],
    hasAttribute: (n) => n in a,
    getAttribute: (n) => (n in a ? String(a[n]) : null),
    setAttribute: (n, v) => {
      a[n] = v;
    },
    closest: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }),
    dispatchEvent: () => true,
    focus: () => {},
  };
}

let CANDIDATES = [];
globalThis.window = {
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  // 模块加载期会注册监听（commands.js 或其依赖），替身必须吞掉。
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (fn) => setTimeout(fn, 0),
};
globalThis.document = {
  querySelectorAll: () => CANDIDATES,
  getElementById: () => null,
  createRange: () => ({ setStart() {}, setEnd() {}, toString: () => '' }),
  addEventListener: () => {},
  removeEventListener: () => {},
  documentElement: { appendChild: () => {} },
  createElement: () => fakeEl('div', {}),
  body: { appendChild: () => {} },
};

const { describeLookupMiss, describeTargetState, nameSimilarity } = await import('../lib/page/commands.js');

const THEME_BUTTONS = () => [
  fakeEl('button', { 'aria-label': '主题：跟随系统（点击切换）', text: '🌗' }),
  fakeEl('button', { 'aria-label': '解释这段内容', text: '解释这段内容' }),
  fakeEl('button', { 'aria-label': '提炼关键要点', text: '提炼关键要点' }),
];

// ---------------------------------------------------------------- 相似度排序

test('nameSimilarity: 同前缀的更像', () => {
  const want = '主题：深色（点击切换）';
  assert.ok(
    nameSimilarity('主题：跟随系统（点击切换）', want) > nameSimilarity('解释这段内容', want),
    '「主题：…」应比无关按钮更像'
  );
  assert.equal(nameSimilarity('', want), 0);
});

// ---------------------------------------------------------------- 定位失败：给近似候选

test('定位失败时列出**同 role 但名字不同**的候选，并给出它们的准确名字', () => {
  CANDIDATES = THEME_BUTTONS();
  const hint = describeLookupMiss({ role: 'button', name: '主题：深色（点击切换）' });
  assert.ok(hint, '应给出线索，而不是只有「未找到目标元素」');
  assert.ok(hint.includes('主题：跟随系统（点击切换）'), '最接近的候选必须出现：' + hint);
  assert.ok(hint.includes('相近的可交互元素'), hint);
});

test('最接近的候选排在最前面（模型第一眼就能改对）', () => {
  CANDIDATES = THEME_BUTTONS();
  const hint = describeLookupMiss({ role: 'button', name: '主题：深色（点击切换）' });
  const themeAt = hint.indexOf('主题：跟随系统');
  const otherAt = hint.indexOf('解释这段内容');
  assert.ok(themeAt !== -1 && (otherAt === -1 || themeAt < otherAt), '同前缀候选应排在无关候选之前：' + hint);
});

test('role 本身就不对时，明说「没有这个 role 的元素」（这本身也是有用信息）', () => {
  CANDIDATES = THEME_BUTTONS();
  const hint = describeLookupMiss({ role: 'link', name: '主题：深色（点击切换）' });
  assert.match(hint, /没有 role=link/, hint);
});

test('没给 role/name 时不给线索（不给无意义的泛泛提示）', () => {
  CANDIDATES = THEME_BUTTONS();
  assert.equal(describeLookupMiss({ selector: '#x' }), '');
  assert.equal(describeLookupMiss({}), '');
});

test('候选数量有上限，不会把整个页面塞进错误信息', () => {
  CANDIDATES = [];
  for (let i = 0; i < 30; i++) CANDIDATES.push(fakeEl('button', { 'aria-label': '按钮' + i }));
  const hint = describeLookupMiss({ role: 'button', name: '不存在的名字' }, 5);
  const listed = hint.split('\n').filter((l) => l.trim().startsWith('- ')).length;
  assert.equal(listed, 5, '最多列 5 个，实际 ' + listed);
  assert.match(hint, /还有 25 个/);
});

// ---------------------------------------------------------------- 状态回报

test('describeTargetState 读出状态属性（三态开关靠它才能复原）', () => {
  const el = fakeEl('button', { 'aria-label': '主题：跟随系统（点击切换）', text: '🌗' });
  const s = describeTargetState(el);
  assert.match(s, /aria-label="主题：跟随系统（点击切换）"/);
  assert.match(s, /text="🌗"/);
});

test('describeTargetState 读出 aria-pressed / aria-checked 这类开关状态', () => {
  const s = describeTargetState(fakeEl('button', { 'aria-pressed': 'true' }));
  assert.match(s, /aria-pressed="true"/, s);
  const c = describeTargetState(fakeEl('input', { 'aria-checked': 'false' }));
  assert.match(c, /aria-checked="false"/, c);
});

test('describeTargetState: 无状态属性时返回空串（不硬凑）', () => {
  assert.equal(describeTargetState(fakeEl('div', {})), '');
  assert.equal(describeTargetState(null), '');
});

// ---------------------------------------------------------------- 接线
//
// 纯函数各自都测了、装配没测 —— 这个坑踩过一次（证据零件都对，装配时丢了动作回执）。
// 这里断言两个命令确实把新信息**接进了返回值**，而不是躺在模块里没人用。

const SRC = fs.readFileSync('lib/page/commands.js', 'utf8');

test('接线：点击成功后必须回报目标状态（否则三态开关无法复原）', () => {
  assert.match(SRC, /stateSuffix\(el\)/, '点击结果要带「点击后状态」');
  assert.match(SRC, /stateBefore/, '要记录点击前的状态，才能说明变成了什么');
  assert.match(SRC, /await nextPaint\(\)/, '状态要在框架渲染之后读，否则读到的是旧值');
});

test('接线：输入后必须回读实际值，并在不符预期时明说', () => {
  assert.match(SRC, /const after = editableValue\(el\) \|\| ''/, '要回读实际值');
  assert.match(SRC, /matchesIntent: matched/, '要带上「是否与预期一致」');
  assert.match(SRC, /与预期不符/, '不一致时必须明说，否则残留字符无法归因');
});

test('接线：定位失败走 targetMissError（带近似候选），不再是光秃秃一句', () => {
  assert.match(SRC, /function targetMissError/);
  const bare = SRC.match(/error: '未找到目标元素'/g) || [];
  assert.equal(bare.length, 0, '不该再有直接返回光秃秃「未找到目标元素」的站点，实际 ' + bare.length + ' 处');
});

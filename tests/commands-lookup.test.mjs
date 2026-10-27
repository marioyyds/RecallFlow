// `lib/page/commands.ts` 里**定位与命名**那部分的纯逻辑测试。
//
// 为什么从这里下手：commands.js 有 2108 行，覆盖率基线只有 21%，且此前
// **零** import（全靠读源码做正则的静态断言）。它是"语义定位器"的实现所在 ——
// `click_element({role:'button', name:'提交'})` 能不能找到按钮，全靠 roleOf /
// accessibleName 这两个函数。它们算错的症状是"未找到目标元素"，,
// 而模型会把它归因成 shadow DOM 之类的问题（实测发生过），于是越修越偏。
//
// 这两个函数是**纯读属性**的，所以用鸭子类型的假元素就能测，不需要 jsdom。
// 这也是刻意的选择：仓库 devDeps 只有 playwright + esbuild，为一个纯函数引入
// jsdom 不划算；而且假元素能让"函数到底读了哪些属性"变得一目了然。
import test from 'node:test';
import assert from 'node:assert/strict';

// commands.js 会在 aria-labelledby 分支里用 document.getElementById；
// 其余时候不碰全局 document。给一个最小桩即可（不需要完整 DOM）。
globalThis.document = {
  getElementById(id) {
    return globalThis.__labelled ? globalThis.__labelled[id] || null : null;
  },
};

const cmds = await import('../lib/page/commands.ts');

/** 造一个鸭子类型元素：足够 roleOf / accessibleName 使用。 */
function el(tag, attrs = {}, extra = {}) {
  const attrsMap = new Map(Object.entries(attrs).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  return Object.assign(
    {
      tagName: String(tag).toUpperCase(),
      getAttribute: (n) => (attrsMap.has(String(n).toLowerCase()) ? attrsMap.get(String(n).toLowerCase()) : null),
      hasAttribute: (n) => attrsMap.has(String(n).toLowerCase()),
      innerText: '',
      textContent: '',
      value: '',
      multiple: false,
      labels: null,
    },
    extra
  );
}

test('roleOf：显式 role 优先（作者声明 > 标签推断）', () => {
  assert.equal(cmds.roleOf(el('div', { role: 'Tab' })), 'tab', '显式 role 应大小写归一');
  assert.equal(cmds.roleOf(el('div', { role: '  button  ' })), 'button', '应 trim');
});

test('roleOf：<a> 只有在有 href 时才是 link（否则它只是个锚点）', () => {
  assert.equal(cmds.roleOf(el('a', { href: '/x' })), 'link');
  assert.equal(cmds.roleOf(el('a')), '', '没有 href 的 <a> 不应被当成可点击链接');
});

test('roleOf：<select> 多选是 listbox、单选项是 combobox', () => {
  assert.equal(cmds.roleOf(el('select')), 'combobox');
  assert.equal(cmds.roleOf(el('select', {}, { multiple: true })), 'listbox');
});

test('roleOf：<input> 按 type 映射（type 缺失时按 text 处理）', () => {
  const cases = [
    ['checkbox', 'checkbox'],
    ['radio', 'radio'],
    ['submit', 'button'],
    ['button', 'button'],
    ['reset', 'button'],
    ['file', 'button'],
    ['search', 'searchbox'],
    ['range', 'slider'],
    ['number', 'spinbutton'],
    ['text', 'textbox'],
  ];
  for (const [type, want] of cases) {
    assert.equal(cmds.roleOf(el('input', { type })), want, 'input[type=' + type + '] 应为 ' + want);
  }
  assert.equal(cmds.roleOf(el('input')), 'textbox', '缺 type 时按 text');
  assert.equal(cmds.roleOf(el('input', { type: 'TEXT' })), 'textbox', 'type 大小写不敏感');
});

test('roleOf：标题与 summary 的映射', () => {
  for (const t of ['h1', 'h2', 'h6']) assert.equal(cmds.roleOf(el(t)), 'heading');
  assert.equal(cmds.roleOf(el('summary')), 'button');
  assert.equal(cmds.roleOf(el('textarea')), 'textbox');
  assert.equal(cmds.roleOf(el('option')), 'option');
  assert.equal(cmds.roleOf(el('span')), '', '无语义的容器不该有 role');
});

test('accessibleName：优先级 aria-label > aria-labelledby > labels > placeholder/title/alt', () => {
  assert.equal(cmds.accessibleName(el('button', { 'aria-label': ' 提交 ' })), '提交', 'aria-label 应 trim');

  globalThis.__labelled = { lbl1: { textContent: '用户名' }, lbl2: { textContent: '输入框' } };
  assert.equal(
    cmds.accessibleName(el('input', { 'aria-labelledby': 'lbl1 lbl2' })),
    '用户名 输入框',
    'aria-labelledby 应按 id 顺序拼接'
  );
  globalThis.__labelled = null;

  assert.equal(
    cmds.accessibleName(el('input', {}, { labels: [{ textContent: ' 密  码 ' }] })),
    '密 码',
    '<label> 文本应压空白'
  );
  assert.equal(cmds.accessibleName(el('input', { placeholder: '搜索' })), '搜索');
  assert.equal(cmds.accessibleName(el('img', { alt: 'logo' })), 'logo');
  assert.equal(cmds.accessibleName(el('div', { title: '提示' })), '提示');
});

test('accessibleName：提交类按钮回落到 value（按钮上最常见的名字来源）', () => {
  // ⚠ 这一支只做 trim、**不压**内部空白（与其它分支不一致）。
  // 实测如此，这里如实断言而不是顺手"修正"它：匹配发生在 normName 之后，
  // 那时空白已被统一压过，所以这个不一致不影响定位结果；
  // 而为它改产品代码会让"名字到底长什么样"在两条路径上出现新的分叉。
  assert.equal(cmds.accessibleName(el('input', { type: 'submit' }, { value: ' 登  录 ' })), '登  录');
  assert.equal(cmds.accessibleName(el('input', { type: 'button' }, { value: '取消' })), '取消');
  // 非提交类的 input 不该用 value 当名字 —— value 是用户输入的内容，不是标签
  assert.equal(cmds.accessibleName(el('input', { type: 'text', placeholder: '邮箱' }, { value: 'abc' })), '邮箱');
});

test('accessibleName：无属性时回落到文本，且截断到 120 字符', () => {
  const long = 'x'.repeat(300);
  const got = cmds.accessibleName(el('button', {}, { textContent: long }));
  assert.equal(got.length, 120, '超长文本必须截断（否则一条名字就能撑爆工具结果）');
  assert.equal(cmds.accessibleName(el('button', {}, { textContent: ' 提  交 ' })), '提 交');
});

test('nameSimilarity：完全一致最高、无关为 0、空串为 0', () => {
  const a = cmds.nameSimilarity('提交订单', '提交订单');
  const b = cmds.nameSimilarity('提交订单', '取消订单');
  assert.ok(a > b, '同名相似度应高于部分相似（' + a + ' vs ' + b + '）');
  assert.equal(cmds.nameSimilarity('', 'abc'), 0, '空串不得参与相似度（否则空名字会匹配上一切）');
  assert.equal(cmds.nameSimilarity('abc', ''), 0);
  assert.equal(cmds.nameSimilarity(null, undefined), 0, '脏输入不应抛');
});

test('nameSimilarity：公共前缀权重高于零散公共字符（前缀更能说明"像"）', () => {
  // 「主题：深色」与「主题：浅色」共享长前缀，应比"字符集合相同但顺序不同"更像。
  const prefixy = cmds.nameSimilarity('主题：深色', '主题：浅色');
  const shuffled = cmds.nameSimilarity('abc', 'cba');
  assert.ok(prefixy > shuffled, '同前缀应更相似（' + prefixy + ' vs ' + shuffled + '）');
});

test('describeLookupMiss：既没 role 也没 name 时返回空串（不给模型灌无线索的废话）', () => {
  assert.equal(cmds.describeLookupMiss({}), '');
  assert.equal(cmds.describeLookupMiss(), '');
  assert.equal(cmds.describeLookupMiss({ role: '', name: '' }), '');
});

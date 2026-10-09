// 页面内文本定位：短短语必须能命中。
//
// 实测缺陷：agent 调 get_element_text({"text":"校验分两层"}) 报「未找到文本」，
// 而它自己随后的 run_javascript 证明这句话就在页面上（offset 9950）。
// 根因是 findRangeBySubstr 里一条 10 字门槛，在三处叠加（findAll 的 while、
// candidates 的 skip、前缀回退的下界），锚词回退又要求连续 6 字以上 ——
// 5 字短语没有任何一条路径能命中，纯中文短句必然失配。
// 更糟的是它把「实现门槛」说成了「页面里没有」，使用者只会以为自己写错了字（实测正是如此）。
import test from 'node:test';
import assert from 'node:assert/strict';

// findRangeBySubstr 命中后会调 document.createRange() 造 Range —— 这里给个最小替身。
globalThis.document = {
  createRange: () => ({
    setStart() {},
    setEnd() {},
    toString: () => 'range',
  }),
};

const { findRangeBySubstr, normalizeCitationText } = await import('../lib/page/citation.js');

/** 按 buildPageCharMap 的规则造一个假 map：逐字符归一、跳过空白。 */
function fakeMap(raw) {
  const text = raw
    .split('')
    .filter((c) => !/\s/.test(c))
    .map((c) => normalizeCitationText(c))
    .join('');
  const node = { nodeValue: raw };
  return {
    text,
    charNode: text.split('').map(() => node),
    charOffset: text.split('').map((_, i) => i),
  };
}

const PAGE = '读完了。校验分两层，先讲逻辑。第①层：确定性预检（claim-check.js，零成本）只有三条规则。';

test('5 字短语能命中（这就是 get_element_text 报「未找到」的那一次）', () => {
  const map = fakeMap(PAGE);
  assert.ok(map.text.includes('校验分两层'), '前提：页面里确实有这句话');
  const r = findRangeBySubstr(map, '校验分两层');
  assert.ok(r, '短短语必须能定位 —— 原先恒返回 null，工具却报「页面里没有」');
});

test('9 字带全角标点的短语也能命中（归一后匹配）', () => {
  const map = fakeMap(PAGE);
  const r = findRangeBySubstr(map, '第①层：确定性预检');
  assert.ok(r, '全角冒号会被归一成半角，两侧一致才谈得上命中');
});

test('短语确实不在页面里时返回 null（不能为了「能找到」而乱匹配）', () => {
  const map = fakeMap(PAGE);
  assert.equal(findRangeBySubstr(map, '这句话根本不存在'), null);
  assert.equal(findRangeBySubstr(map, '校验分三层'), null);
});

test('长片段路径不受影响（旧的启发式原样保留）', () => {
  const map = fakeMap(PAGE);
  const long = '校验分两层，先讲逻辑。第①层：确定性预检';
  assert.ok(findRangeBySubstr(map, long), '长片段照样能命中');
  assert.equal(findRangeBySubstr(map, '完全不相干的一段很长很长的文字，页面里没有'.repeat(3)), null);
});

test('空输入与纯空白安全', () => {
  const map = fakeMap(PAGE);
  assert.equal(findRangeBySubstr(map, ''), null);
  assert.equal(findRangeBySubstr(map, '   '), null);
  assert.equal(findRangeBySubstr(map, null), null);
});

test('恰好 10 字走长片段路径（边界两侧都要能命中）', () => {
  const map = fakeMap(PAGE);
  assert.ok(findRangeBySubstr(map, '校验分两层，先讲逻'), '10 字');
  assert.ok(findRangeBySubstr(map, '校验分两层，先讲'), '9 字');
});

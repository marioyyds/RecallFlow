// 知识库检索的**召回**门禁。
//
// ## 起因（实测数据挖出来的真缺陷）
//
// `tokenizeQuery` 原先的分支是"≤4 字的段整体保留，>4 字的段切成 bigram"。
// 对中文（**没有词边界**）来说，这会造成同一个意思因为**字数不同**而结果相反：
//
//     笔记：「把首屏索引预热挪到扩展启动时」
//     查「首屏索引预热」(6 字 → bigram) → **找到**
//     查「首屏预热」   (4 字 → 整段)   → **找不到**
//
// 后者要求逐字连续的子串，中间隔了「索引」两个字就永远匹配不上。
// 用户查不到自己刚存的东西，只会得到「未检索到相关知识库条目」——
// 而对模型来说，这极容易被读成"知识库里没有这条"（结论是错的）。
//
// 修法：中文 3–4 字的段**在保留整段的同时追加 bigram**（只加不减）：
//   · 整段仍在 ⇒ 逐字命中的条目会额外吃到整段的分，排名更靠前；
//   · 非 CJK 短段完全不变 ⇒ 不把 "api" 这类缩写切碎成噪声。
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeQuery, buildRagContext } from '../lib/shared/rag.ts';

/** 造一个只有一条笔记的知识库。 */
const bookWith = (note, title = '检索性能优化') => ({
  'kb:1': { id: 'kb:1', type: 'note', title, note, tags: [] },
});

const NOTE = '把首屏索引预热挪到扩展启动时；检索超时从 800ms 收到 300ms；结果缓存按 query 归一化后命中';

test('中文短查询（≤4 字）也能命中"中间隔着字"的笔记 —— 这是修掉的那个缺陷', () => {
  const book = bookWith(NOTE);
  // 修复前这两条都是「没找到」：4 字整段要求逐字连续
  for (const q of ['首屏预热', '缓存命中']) {
    assert.ok(buildRagContext(book, q, 5).length > 0, '「' + q + '」应该能找到（中间隔着字也要能命中）');
  }
  // 逐字连续的短查询本来就能命中，不能被修坏
  for (const q of ['首屏', '预热', '超时', '缓存']) {
    assert.ok(buildRagContext(book, q, 5).length > 0, '「' + q + '」应该能找到');
  }
});

test('中文 3–4 字的段：整段与 bigram 都在（只加不减）', () => {
  const t = tokenizeQuery('首屏预热');
  assert.ok(t.includes('首屏预热'), '整段必须保留（逐字命中时吃更多分）');
  assert.ok(t.includes('首屏'), 'bigram：首屏');
  assert.ok(t.includes('预热'), 'bigram：预热');
  // 2 字本来就是最小滑窗，不应重复堆叠
  assert.deepEqual(tokenizeQuery('预热').filter((x) => x === '预热').length, 1);
});

test('非 CJK 的短段行为不变（缩写不能切碎成噪声）', () => {
  assert.deepEqual(tokenizeQuery('api'), ['api']);
  assert.deepEqual(tokenizeQuery('rag'), ['rag']);
  assert.deepEqual(tokenizeQuery('vue3'), ['vue3']);
  // 长英文单词仍然走 bigram（原文行为）
  assert.ok(tokenizeQuery('performance').includes('pe'));
});

test('逐字命中的条目要排在"只蹭到 bigram"的条目前面（只加不减的收益）', () => {
  const book = {
    exact: { id: 'exact', type: 'note', title: '首屏预热', note: '', tags: [] },
    partial: { id: 'partial', type: 'note', title: '发热', note: '天气很预热', tags: [] },
  };
  const hit = buildRagContext(book, '首屏预热', 5);
  assert.equal(hit.length, 2, '两条都该被召回（召回变宽是这次修改的目的）');
  assert.equal(hit[0].id, 'exact', '逐字命中的必须排第一');
});

test('词汇不匹配是**固有限制**，不是这次要修的缺陷（把这个认知钉住）', () => {
  // 「卡顿 / 页面打开很慢 / 响应太慢」与「预热 / 超时 / 缓存」在**字符层面**毫无交集 ——
  // 纯字符匹配的检索修不好这件事，只能靠回退策略（换个说法 / list / get）。
  // 写在这里是为了防止以后有人看到"查不到"就以为是 tokenizer 又坏了。
  const book = bookWith(NOTE);
  for (const q of ['卡顿', '页面打开很慢', '响应太慢']) {
    assert.equal(buildRagContext(book, q, 5).length, 0, '「' + q + '」在字符层面确实无交集，匹配不到是预期');
  }
  // ⚠ 顺带钉一个**反直觉但正确**的现象：「启动慢」是**能**命中的 ——
  // 笔记里有「扩展**启动**时」，bigram「启动」就命中了。
  // 这是词法检索的固有代价：召回变宽的同时会有这种"字面撞上、语义不同"的误命中。
  // 把它写出来，免得以后有人看到"启动慢也能查到"以为是 bug。
  assert.ok(buildRagContext(book, '启动慢', 5).length > 0, '「启动慢」会因 bigram「启动」命中 —— 已知的字面误命中');
});

test('这条门禁本身有牙齿：修复前的 tokenizer 必须被判为不合格', () => {
  // 内联一份"修复前"的实现，验证上面那条断言确实能抓住它 ——
  // 否则这些测试可能只是"永远通过"。
  const oldTokenize = (query) => {
    const segments = String(query || '')
      .toLowerCase()
      .split(/[\s,，。;；:：!！?？、/\\()[\]{}<>"'`~#@$%^&*+=|]+/)
      .filter((s) => s.length);
    const tokens = [];
    for (const seg of segments) {
      if (seg.length <= 4) tokens.push(seg);
      else for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
    }
    return tokens;
  };
  const noteLow = NOTE.toLowerCase();
  const hitOld = oldTokenize('首屏预热').some((t) => noteLow.includes(t));
  assert.equal(hitOld, false, '修复前的实现应当**匹配不到**「首屏预热」——这正是被修掉的那个缺陷');
  const hitNew = tokenizeQuery('首屏预热').some((t) => noteLow.includes(t));
  assert.equal(hitNew, true, '修复后应当能匹配到');
});

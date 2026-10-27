// knowledge.js：knowledge_read(op) 的分派与三个 op 的行为。
//
// 为什么值得单独测：`op` 由**模型**填。分派写错（例如 op=list 落进 search 分支）会让模型
// 拿到另一类结果却以为"知识库是空的" —— 静默错误，端到端也未必发现。
// 另外本档的合并边界很关键：只读三件套合并，写/删**不**合并。这里也把它钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { knowledgeRead, KNOWLEDGE_READ_OPS } from '../lib/assistant/knowledge.ts';

const typeInfo = (t) => ({ name: ({ wrong: '错题', article: '文章', ai: 'AI·Prompt', note: '笔记' })[t] || t });
const starLevels = { 2: { name: '重要' }, 1: { name: '普通' } };

function mkDeps(book = {}) {
  const calls = [];
  return {
    calls,
    book,
    typeInfo,
    starLevels,
    buildRagContext: (b, q, limit) => {
      calls.push('rag:' + q + ':' + limit);
      // 只返回标题含关键词的条目，模拟真实检索
      return Object.values(b).filter((it) => String(it.title).includes(q)).slice(0, limit);
    },
    buildCitations: (items, compact) => {
      calls.push('cite:' + items.length + ':' + compact);
      return items.map((_, i) => ({ index: i + 1, source: 'kb' }));
    },
  };
}

const BOOK = {
  'https://a.test/1': { id: 'https://a.test/1', title: '跨域笔记', type: 'note', note: 'CORS 说明', tags: ['前端'], updatedAt: 3 },
  'https://a.test/2': { id: 'https://a.test/2', title: '算法错题', type: 'wrong', note: '二分边界', tags: ['算法'], updatedAt: 5 },
};

test('list 与 search 必须给出 id —— 否则列出来也读不了那一条（get 要的是 id）', () => {
  // 这个缺口是做「检索落空 → 改用 list 兜底」的场景时发现的：
  // list 原先只给标题/类型/标签，而 get 要 id，两个 op **接不上** ——
  // 模型列出一堆条目、看中了某条，却拿不到能传给 get 的 id（条目没有 url 时彻底没辙）。
  // 与 macroList 的 name 一样：**要被原样照抄的值必须有无歧义的边界**。
  const deps = mkDeps(BOOK);
  const list = knowledgeRead(deps, { op: 'list' });
  assert.match(list.result, /id="https:\/\/a\.test\/1"/, 'list 每行都要带 id="…"');
  assert.match(list.result, /id="https:\/\/a\.test\/2"/);

  const search = knowledgeRead(deps, { op: 'search', query: '跨域' });
  assert.match(search.result, /id="https:\/\/a\.test\/1"/, 'search 结果同样要带 id');

  // 关键：从 list 里抠出来的 id **确实能**喂给 get（两个 op 真的接上了）
  const id = (list.result.match(/id="([^"]+)"/) || [])[1];
  assert.ok(id, '能从 list 里解析出 id');
  const got = knowledgeRead(deps, { op: 'get', id });
  assert.match(got.result, /标题：/, 'get 用这个 id 读到了条目');
});

test('op 必填：缺失时报错并列出可用取值，且不读任何数据', () => {
  const deps = mkDeps(BOOK);
  const r = knowledgeRead(deps, {});
  assert.match(r.result, /需要 op/);
  assert.match(r.result, /search/);
  assert.deepEqual(deps.calls, [], 'kind 缺失时不得去读数据');
});

test('op 非法：报错并列出可用取值', () => {
  const r = knowledgeRead(mkDeps(BOOK), { op: 'serach' });
  assert.match(r.result, /未知的 op/);
  assert.equal(KNOWLEDGE_READ_OPS.join(','), 'search,list,get');
});

test('op=search 走检索（不得串到 list）', () => {
  const deps = mkDeps(BOOK);
  const r = knowledgeRead(deps, { op: 'search', query: '跨域' });
  assert.equal(deps.calls.filter((c) => c.startsWith('rag:')).length, 1, '应调用检索');
  assert.equal(deps.calls.filter((c) => c.startsWith('cite:')).length, 1, '应带引用');
  assert.equal(deps.calls[1], 'cite:1:false', '检索结果的引用是"非紧凑"模式');
  assert.match(r.result, /跨域笔记/);
  assert.ok(Array.isArray(r.citations));
});

test('op=search 无结果时给出可读提示（而不是空字符串）', () => {
  const r = knowledgeRead(mkDeps(BOOK), { op: 'search', query: '不存在的词' });
  assert.match(r.result, /未检索到相关知识库条目/);
});

test('op=list 列出概览、按 updatedAt 倒序、并带紧凑引用', () => {
  const deps = mkDeps(BOOK);
  const r = knowledgeRead(deps, { op: 'list' });
  assert.match(r.result, /知识库共 2 条/);
  const idx1 = r.result.indexOf('算法错题');
  const idx2 = r.result.indexOf('跨域笔记');
  assert.ok(idx1 >= 0 && idx2 >= 0, '两条都应列出');
  assert.ok(idx1 < idx2, 'updatedAt 更大的应排在前面');
  assert.equal(deps.calls.filter((c) => c.startsWith('rag:')).length, 0, 'list 不得触发检索');
  assert.match(deps.calls.join(','), /cite:2:true/, 'list 的引用是紧凑模式');
});

test('op=list 支持按类型筛选', () => {
  const r = knowledgeRead(mkDeps(BOOK), { op: 'list', type: 'wrong' });
  assert.match(r.result, /知识库共 1 条/);
  assert.match(r.result, /算法错题/);
  assert.ok(!/跨域笔记/.test(r.result), '筛选后不应出现其它类型');
});

test('op=get 按 id 取单条完整内容', () => {
  const r = knowledgeRead(mkDeps(BOOK), { op: 'get', id: 'https://a.test/2' });
  assert.match(r.result, /标题：算法错题/);
  assert.match(r.result, /类型：错题/, '类型应译成人名，而不是原样 wrong');
  assert.match(r.result, /备注：二分边界/);
  assert.match(r.result, /标签：算法/);
});

test('op=get 找不到时给出可读原因（含 id）', () => {
  const r = knowledgeRead(mkDeps(BOOK), { op: 'get', id: 'nope' });
  assert.match(r.result, /未找到该条目/);
  assert.match(r.result, /nope/);
});

test('op=get 对缺 status 的条目不得输出 undefined', () => {
  const book = { x: { id: 'x', title: 't', type: 'note' } };
  const r = knowledgeRead(mkDeps(book), { op: 'get', id: 'x' });
  assert.ok(!/undefined/.test(r.result), '缺字段应回落到可读文案：' + r.result);
});

test('空知识库：list 输出（空）而不是报错', () => {
  const r = knowledgeRead(mkDeps({}), { op: 'list' });
  assert.match(r.result, /知识库共 0 条/);
  assert.match(r.result, /（空）/);
});

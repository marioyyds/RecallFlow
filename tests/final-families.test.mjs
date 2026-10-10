// knowledge-store-tools.js + page-command-tools.js：C-1 最后两族（第 12、13 族）。
//
// 另外附一条**结构性门禁**（本文件末尾）：`executeTool` 的 switch 里
// 每个工具名只能出现一次，且每个 case 必须真的 return ——
// 这两类错误在拆分搬运时都真实发生过：重复的 case 会让后一个覆盖前一个，
// 漏掉的 return 会让相邻工具**互相 fall-through**（调用 A 却执行了 B）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  knowledgeReadTool,
  addEntry,
  removeEntry,
  KNOWLEDGE_STORE_TOOLS,
  handleKnowledgeStoreTool,
} from '../lib/assistant/knowledge-store-tools.js';
import {
  annotate,
  inspectElement,
  scrollPage,
  getElementSource,
  undoLastAction,
  ANNOTATE_OPS,
  INSPECT_OPS,
  PAGE_COMMAND_TOOLS,
  handlePageCommandTool,
} from '../lib/assistant/page-command-tools.js';
import { TOOL_REGISTRY, executeTool, registeredToolNames } from '../lib/assistant/tools.js';

// ---------------------------------------------------------------- 知识库存储族

function mkKbDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    ctx: { book: { 'k1': { id: 'k1', title: 'T' } } },
    knowledgeRead: (deps, args) => { calls.push({ op: 'read', deps, args }); return { result: '检索结果' }; },
    upsertItem: async (item) => { calls.push({ op: 'upsert', item }); return item; },
    deleteItem: async (id) => calls.push({ op: 'delete', id }),
    getBook: async () => ({ fresh: true }),
    buildRagContext: () => 'rag',
    buildCitations: () => [],
    typeInfo: () => 'info',
    STAR_LEVELS: { 1: '一星' },
    STATUS: { IMPORTANT: 'important' },
    ...overrides,
  };
}

test('KNOWLEDGE_STORE_TOOLS 覆盖三个工具名', () => {
  assert.deepEqual([...KNOWLEDGE_STORE_TOOLS].sort(), ['add_entry', 'knowledge_read', 'remove_entry']);
});

test('handleKnowledgeStoreTool：不属于本族返回 null', async () => {
  assert.equal(await handleKnowledgeStoreTool('annotate', {}, mkKbDeps()), null);
});

test('knowledge_read：把 ctx.book 与检索依赖传下去（只读，不改 book）', async () => {
  const deps = mkKbDeps();
  const before = deps.ctx.book;
  const r = await knowledgeReadTool(deps, { op: 'search', query: 'x' });
  assert.equal(r.result, '检索结果');
  const call = deps.calls.find((c) => c.op === 'read');
  assert.equal(call.deps.book, before, '应把当前 book 传下去');
  assert.equal(call.deps.buildRagContext, deps.buildRagContext);
  assert.equal(call.deps.starLevels, deps.STAR_LEVELS, '星级表要传下去（否则渲染会缺档）');
  assert.equal(deps.ctx.book, before, '只读操作不得改写 ctx.book');
});

test('add_entry：有 url 时用 url 当 id（同 URL 天然去重）', async () => {
  const deps = mkKbDeps();
  await addEntry(deps, { url: 'https://a.test/p', title: 'T' });
  assert.equal(deps.calls.find((c) => c.op === 'upsert').item.id, 'https://a.test/p');
});

test('add_entry：无 url 时生成临时 id（前缀 kb:）', async () => {
  const deps = mkKbDeps();
  await addEntry(deps, { title: 'T' });
  const item = deps.calls.find((c) => c.op === 'upsert').item;
  assert.match(item.id, /^kb:\d+:/);
});

test('add_entry：补默认值（未命名 / note / important / tags 数组），并回读 ctx.book', async () => {
  const deps = mkKbDeps();
  const r = await addEntry(deps, {});
  const item = deps.calls.find((c) => c.op === 'upsert').item;
  assert.equal(item.title, '未命名');
  assert.equal(item.type, 'note');
  assert.equal(item.url, '');
  assert.equal(item.status, 'important');
  assert.equal(item.note, '');
  assert.deepEqual(item.tags, []);
  assert.deepEqual(deps.ctx.book, { fresh: true }, '写后应重新读取整本书，保证后续读取一致');
  assert.match(r.result, /已保存条目：标题「未命名」/);
  assert.ok(r.savedId, '应回传 savedId');
});

test('add_entry：tags 非数组时回落为空数组（不写入脏数据）', async () => {
  const deps = mkKbDeps();
  await addEntry(deps, { tags: 'not-an-array' });
  assert.deepEqual(deps.calls.find((c) => c.op === 'upsert').item.tags, []);
});

test('remove_entry：条目不存在时**不报错**，而是说明"无需删除"（重复删除不是故障）', async () => {
  const deps = mkKbDeps();
  const r = await removeEntry(deps, { id: '不存在' });
  assert.match(r.result, /未找到该条目，无需删除/);
  assert.ok(!deps.calls.some((c) => c.op === 'delete'), '不存在时不该调删除');
});

test('remove_entry：存在时删除并回读 ctx.book', async () => {
  const deps = mkKbDeps();
  const r = await removeEntry(deps, { id: 'k1' });
  assert.deepEqual(deps.calls.find((c) => c.op === 'delete'), { op: 'delete', id: 'k1' });
  assert.deepEqual(deps.ctx.book, { fresh: true });
  assert.match(r.result, /已删除条目 \(id: k1\)/);
});

// ---------------------------------------------------------------- 页面命令族

function mkPcDeps(overrides = {}) {
  const calls = [];
  const deps = {
    calls,
    ctx: { tabId: 7 },
    toolError: (code, msg) => ({ ok: false, code, result: msg }),
    executePageTool: async (tabId, cmd, params, ctx) => {
      calls.push({ op: 'pageTool', tabId, cmd, params, ctx });
      return { ok: true, result: '已执行 ' + cmd };
    },
    executeContentAction: async (tabId, action, msg, opts) => {
      calls.push({ op: 'content', tabId, action, msg, opts });
      return { ok: true, result: '已执行' };
    },
    sendTabMessage: async (tabId, msg) => {
      calls.push({ op: 'send', tabId, msg });
      return deps.sourceResult;
    },
    sourceResult: { found: true, source: { file: 'src/a.js', line: 12, column: 3 }, selector: '#x' },
    ...overrides,
  };
  return deps;
}

test('PAGE_COMMAND_TOOLS 覆盖五个工具名', () => {
  assert.deepEqual([...PAGE_COMMAND_TOOLS].sort(),
    ['annotate', 'get_element_source', 'inspect_element', 'scroll_page', 'undo_last_action']);
});

test('handlePageCommandTool：不属于本族返回 null', async () => {
  assert.equal(await handlePageCommandTool('add_entry', {}, mkPcDeps()), null);
});

test('ANNOTATE_OPS / INSPECT_OPS 的映射与内容脚本命令名逐一对齐', () => {
  assert.deepEqual(ANNOTATE_OPS, { highlight: 'highlight', outline: 'outline', style: 'set_style', clear: 'clear_highlights' });
  // styles 不是 C-4 合并来的，而是后来**补**的一档（做「UI 美化」时发现改完样式无法自证：
  // annotate 只回一句摘要，而唯一的取证路径 run_javascript 是 alwaysRequireApproval
  // 且会被页面 CSP 拦住）。它复用只读的 readElementState，工具数不变。详见 read-styles.test.mjs。
  assert.deepEqual(INSPECT_OPS, { text: 'get_text', inspect: 'inspect_element', table: 'extract_table', styles: 'read_styles' });
});

test('annotate：未知 op 时报错并列出全部合法取值', async () => {
  const r = await annotate(mkPcDeps(), { op: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_ARGS');
  assert.match(r.result, /highlight \/ outline \/ style \/ clear/);
});

test('annotate：缺 op 也报错（不能默默走默认分支）', async () => {
  const r = await annotate(mkPcDeps(), {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_ARGS');
});

test('**关键**：annotate op=clear 时不传定位参数（否则会变成"按目标清"）', async () => {
  const deps = mkPcDeps();
  await annotate(deps, { op: 'clear', selector: '#x', ref: 'rf-1', texts: ['a'] });
  const c = deps.calls.find((x) => x.op === 'pageTool');
  assert.equal(c.cmd, 'clear_highlights');
  assert.deepEqual(c.params, {}, 'op=clear 的语义是清整页浮层，不能带定位参数');
});

test('annotate：非 clear 的 op 保留其余参数，但不把 op 透传给内容脚本', async () => {
  const deps = mkPcDeps();
  await annotate(deps, { op: 'style', selectors: ['#ad'], hide: true });
  const c = deps.calls.find((x) => x.op === 'pageTool');
  assert.equal(c.cmd, 'set_style');
  assert.deepEqual(c.params, { selectors: ['#ad'], hide: true });
  assert.ok(!('op' in c.params), 'op 是 Agent 侧的路由参数，不该透传');
});

test('inspect_element：三个 op 各映射到正确命令，且不透传 op', async () => {
  for (const [op, cmd] of [['text', 'get_text'], ['inspect', 'inspect_element'], ['table', 'extract_table']]) {
    const deps = mkPcDeps();
    await inspectElement(deps, { op, selector: '#x' });
    const c = deps.calls.find((x) => x.op === 'pageTool');
    assert.equal(c.cmd, cmd, op + ' 应映射到 ' + cmd);
    assert.deepEqual(c.params, { selector: '#x' });
  }
});

test('inspect_element：未知 op 报错', async () => {
  const r = await inspectElement(mkPcDeps(), { op: 'x' });
  assert.equal(r.code, 'BAD_ARGS');
  assert.match(r.result, /text \/ inspect \/ table/);
});

test('scroll_page：有 ref/selector/text 或坐标 → scroll_to；否则 → scroll_by', async () => {
  for (const args of [{ ref: 'r' }, { selector: '#s' }, { text: 't' }, { top: 100 }, { left: 5 }]) {
    const deps = mkPcDeps();
    await scrollPage(deps, args);
    assert.equal(deps.calls.find((x) => x.op === 'pageTool').cmd, 'scroll_to', JSON.stringify(args) + ' 应走 scroll_to');
  }
  const byOffset = mkPcDeps();
  await scrollPage(byOffset, {});
  assert.equal(byOffset.calls.find((x) => x.op === 'pageTool').cmd, 'scroll_by', '无目标无坐标应走 scroll_by');
});

test('get_element_source：把 file:line:column 与框架/组件信息拼成可读位置', async () => {
  const deps = mkPcDeps({
    sourceResult: { found: true, source: { file: 'src/a.vue', line: 12, column: 3, framework: 'Vue', component: 'Card' }, selector: '#x' },
  });
  const r = await getElementSource(deps, {});
  assert.equal(r.ok, true);
  assert.match(r.result, /元素源码位置：src\/a\.vue:12:3/);
  assert.match(r.result, /（Vue · Card）/);
  assert.match(r.result, /选择器：#x/);
});

test('get_element_source：只有 file 时不留多余冒号', async () => {
  const deps = mkPcDeps({ sourceResult: { found: true, source: { file: 'src/a.js' } } });
  const r = await getElementSource(deps, {});
  assert.match(r.result, /元素源码位置：src\/a\.js(?:\n|$)/);
});

test('get_element_source：未找到时用内容脚本给的原因（不吞掉）', async () => {
  const deps = mkPcDeps({ sourceResult: { found: false, reason: '未开启源码映射' } });
  const r = await getElementSource(deps, {});
  assert.equal(r.ok, false);
  assert.match(r.result, /未开启源码映射/);
});

test('get_element_source：无 tabId 时失败', async () => {
  const r = await getElementSource(mkPcDeps({ ctx: {} }), {});
  assert.equal(r.ok, false);
  assert.match(r.result, /无法定位当前标签页/);
});

test('undo_last_action：必须用 verify:false（恢复动作不该再被校验拖慢）', async () => {
  const deps = mkPcDeps();
  await undoLastAction(deps, {});
  const c = deps.calls.find((x) => x.op === 'content');
  assert.equal(c.msg.type, 'kbUndo');
  assert.deepEqual(c.opts, { verify: false });
});

// ---------------------------------------------------------------- 结构性门禁
//
// C-1 的终点是把 `executeTool` 的巨型 switch 换成**分派注册表**。
// 换掉之后，下面这些性质不再是"靠 review 保证"，而是可以被直接断言 ——
// 而且这几条正是 switch 时代真实出过的问题（见 lib/assistant/tools.js 注册表上方注释）。

test('分派注册表 == TOOL_REGISTRY（两边必须严格相等）', () => {
  const reg = TOOL_REGISTRY.map((t) => t.name).sort();
  const table = registeredToolNames().sort();
  assert.deepEqual(
    table,
    reg,
    '分派表与工具注册表不一致：多注册的工具永远不会被调用，少注册的会静默落到「未知工具」'
  );
});

test('注册表里没有重复的工具名（重复会让两个 handler 争同一个名字）', () => {
  const names = registeredToolNames();
  assert.deepEqual([...new Set(names)].length === names.length ? [] : names, [], '有重复注册');
  assert.ok(names.length > 0, '注册表不该为空 —— 否则上面的等价断言会空转通过');
});

test('未知工具名回落到「未知工具」而不是抛错', async () => {
  const r = await executeTool('definitely_not_a_tool', {}, {});
  assert.match(r.result, /未知工具/);
});

test('重名注册在**模块加载时**就抛错（不留到运行时静默走错分支）', () => {
  const src = fs.readFileSync(new URL('../lib/assistant/tools.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function registerHandlers('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /TOOL_HANDLERS\.has\(n\)/, '注册函数必须先查重');
  assert.match(body, /throw new Error\('工具重复注册/, '重名必须直接抛错');
  // 注册调用要在模块顶层（加载时执行），而不是藏在某个函数体里
  assert.match(src, /^registerHandlers\(\[/m, '注册调用应在模块顶层执行');
  // executeTool 必须只剩查表 —— 一旦有人把工具逻辑塞回分派函数，这条会失败
  const exec = src.slice(src.indexOf('export async function executeTool('));
  const execBody = exec.slice(0, exec.indexOf('\n}'));
  for (const smell of ['switch (name)', 'case \'', "=== 'click", 'executePageTool(', 'cdp.']) {
    assert.ok(!execBody.includes(smell), 'executeTool 里不该再有工具逻辑：' + smell);
  }
});

test('这条「注册表 == TOOL_REGISTRY」门禁有牙齿：多/少一个名字都必须被发现', () => {
  const names = registeredToolNames().sort();
  const reg = TOOL_REGISTRY.map((t) => t.name).sort();
  const missingOne = names.filter((n) => n !== names[0]);
  assert.notDeepEqual(missingOne, reg, '少一个工具名时该断言必须失败，否则门禁是空转的');
  assert.notDeepEqual([...names, 'bogus_tool'].sort(), reg, '多一个工具名时该断言必须失败');
  // 顺带确认比较本身不是"永远相等"：换掉任意一个名字必须被发现
  assert.notDeepEqual([...names.slice(1), 'renamed_tool'].sort(), reg, '改名必须被发现');
});

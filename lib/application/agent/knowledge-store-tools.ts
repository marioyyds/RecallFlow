// 知识库存储族（knowledge_read / add_entry / remove_entry）—— C-1 拆出的第 12 族。
//
// 为什么这三者算一族：它们都直接读写**本地知识库**（`ctx.book` + 存储层），
// 是唯一会改变用户收藏数据的一组工具。放在一起后，"谁只读、谁会写、谁不可逆"一眼可见。
//
// ⚠ **不要因为"语义上都是知识库"就把它们合并成一个工具。**
// C-4 的第 4 档只把三个**只读**入口合并成 `knowledge_read({op})`：
//   · knowledge_read  → read / readOnly / parallelSafe（可并行，无审批）
//   · add_entry       → write（需要审批）
//   · remove_entry    → destructive（需要审批，且不可逆）
//
// 三者权限类别不同，而**审批函数拿不到 args**（`toolNeedsApproval(name, settings, pageUrl)`
// 没有 args 参数），因此按 op 分流审批在现有架构下**无法表达**。
// 一旦合并，要么每次检索都要审批（噪音），要么删除/写入免审批（危险）。
// 这就是"按执行路径与权限类别分组，而不是按语义相似度分组"的具体含义。
//
// **搬运原则：不重写行为。** 实现从 tools.js 原样搬来，闭包依赖改为显式注入。

/** knowledge_read：只读检索/列表/取单条（实现在 ./knowledge.js）。 */
import type { KnowledgeStoreDeps } from './tool-deps.ts';

export async function knowledgeReadTool(deps: KnowledgeStoreDeps, args: Record<string, unknown>) {
  return deps.knowledgeRead(
    { book: deps.ctx.book, buildRagContext: deps.buildRagContext, buildCitations: deps.buildCitations, typeInfo: deps.typeInfo, starLevels: deps.STAR_LEVELS },
    args
  );
}

/** add_entry：新增/覆盖一条知识库条目（写）。 */
export async function addEntry(deps: KnowledgeStoreDeps, args: Record<string, unknown>) {
  const ctx = deps.ctx;
  // 有 url 就用 url 当 id（同一 URL 视为同一条，天然去重）；否则生成一个临时 id。
  const id = args.id || args.url || 'kb:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
  const created = await deps.upsertItem({
    id,
    type: args.type || 'note',
    title: args.title || '未命名',
    url: args.url || '',
    status: args.status || deps.STATUS.IMPORTANT,
    note: args.note || '',
    tags: Array.isArray(args.tags) ? args.tags : [],
  });
  // 重新读取整本书，保证 ctx.book 与存储一致（后续 knowledge_read 看到的是最新数据）。
  ctx.book = await deps.getBook();
  return { result: `已保存条目：标题「${created.title}」(id: ${created.id})。`, savedId: created.id };
}

/** remove_entry：删除一条条目（不可逆）。 */
export async function removeEntry(deps: KnowledgeStoreDeps, args: Record<string, unknown>) {
  const ctx = deps.ctx;
  // 先查再删：不存在时**不报错**，而是说明"无需删除"（重复删除不是故障）。
  if (!ctx.book[args.id as string]) return { result: '未找到该条目，无需删除。' };
  await deps.deleteItem(args.id as string);
  ctx.book = await deps.getBook();
  return { result: '已删除条目 (id: ' + args.id + ')。' };
}

/** 该族处理哪些工具名。 */
export const KNOWLEDGE_STORE_TOOLS = new Set(['knowledge_read', 'add_entry', 'remove_entry']);

/** 统一入口。返回 null 表示"不属于本族"。 */
export async function handleKnowledgeStoreTool(name: string, args: Record<string, unknown>, deps: KnowledgeStoreDeps) {
  if (name === 'knowledge_read') return await knowledgeReadTool(deps, args);
  if (name === 'add_entry') return await addEntry(deps, args);
  if (name === 'remove_entry') return await removeEntry(deps, args);
  return null;
}

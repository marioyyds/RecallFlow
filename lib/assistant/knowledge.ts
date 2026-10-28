// 知识库读取类工具（search_knowledge_base / list_knowledge_base / get_entry）→ 收敛为 knowledge_read(op)。
//
// C-4 合并第 4 档的一部分。**注意本档与原方案不同**（方案写"知识库 5→2"）：
//
// 原方案把 5 个工具按"检索 1 个 + 增删改 1 个"分成两个。但实测这会让读取被迫继承写权限：
// 合并后的工具只能有一份 `risk`/`requiresApproval`，而工具级审批**看不到 args**
//（`toolNeedsApproval(name, settings, pageUrl)`，见 lib/assistant/approval-policy.js），
// 所以"增删改"那个工具的 `destructive` 会被**每一次读取**继承 ——
// 而检索/列出/看条目是全仓库最高频的知识库动作。
//
// 因此按**权限类别**分组，而不是按"检索/写入"分组：
//   · 三个只读 → `knowledge_read(op)`           —— risk: read, readOnly, parallelSafe
//   · `add_entry` 保持独立                      —— risk: write, requiresApproval
//   · `remove_entry` 保持独立                   —— risk: destructive, requiresApproval
// 结果是 5 → 3（省 2 个，与原方案的净减量相同），但**不产生权限污染**。
//
// 这与第 6 档（技能）是同一课：**"语义上属于同一类"不等于"可以合并"** ——
// 判据是"能力/审批前置条件是否一致"。

/** 合法的 op 取值。显式列出，便于报错时给出可用选项。 */
import type { KnowledgeItem } from '../shared/store.ts';
import type { KnowledgeDeps } from './tool-deps.ts';

export const KNOWLEDGE_READ_OPS = ['search', 'list', 'get'];

/**
 * 统一入口：knowledge_read({ op, query?, type?, id?, limit? })。
 *
 * @param {object} deps { book, buildRagContext, buildCitations, typeInfo }
 */
export function knowledgeRead(deps: KnowledgeDeps, args: Record<string, unknown>) {
  const op = String((args && args.op) || '').trim();
  if (!op) {
    return { ok: false, result: 'knowledge_read 需要 op 参数，取值：' + KNOWLEDGE_READ_OPS.join(' / ') + '。' };
  }
  if (op === 'search') return knowledgeSearch(deps, args);
  if (op === 'list') return knowledgeList(deps, args);
  if (op === 'get') return knowledgeGet(deps, args);
  // 参数不合法是**失败**，必须带 ok:false（见 tests/tool-failure-contract.test.mjs）
  return { ok: false, result: '未知的 op「' + op + '」，取值：' + KNOWLEDGE_READ_OPS.join(' / ') + '。' };
}

// ⚠ list 与 search 的每一行都必须带上 **id="…"**。
//
// 原先只有标题/类型/标签，而 `op:"get"` 要的是 **id** —— 于是这两个 op **接不上**：
// 模型列出一堆条目、看中了某一条，却拿不到能传给 get 的 id，
// 只能去猜"id 通常就是 url"（条目没有 url 时就彻底没辙）。
// 做「检索落空 → 改用 list 兜底」那个场景时发现的缺口。
// 与下面这处既有约定同源：`macroList` 也是把 name **显式引号标出** ——
// 名字/ID 这类**要被原样照抄**的值，就必须给出无歧义的边界。

/** 检索（原 search_knowledge_base）。 */
export function knowledgeSearch(deps: KnowledgeDeps, args: Record<string, unknown>) {
  const limit = Number(args.limit) || 5;
  const relevant = deps.buildRagContext(deps.book, args.query || '', limit);
  if (!relevant.length) return { result: '未检索到相关知识库条目。' };
  const citations = deps.buildCitations(relevant, false);
  const text = relevant
    .map(
      (it, i) =>
        `[${i + 1}] id="${it.id}" 标题：${it.title}｜类型：${deps.typeInfo(it.type).name}` +
        `${it.note ? '｜内容：' + it.note : ''}${it.url ? '｜链接：' + it.url : ''}`
    )
    .join('\n');
  return { result: '检索到的知识库条目：\n' + text, citations };
}

/** 列出（原 list_knowledge_base）。 */
export function knowledgeList(deps: KnowledgeDeps, args: Record<string, unknown>) {
  let items: KnowledgeItem[] = Object.values(deps.book);
  if (args.type) items = items.filter((it) => it.type === args.type);
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const limit = Number(args.limit) || 20;
  const shown = items.slice(0, limit);
  const text = shown
    .map(
      (it, i) =>
        `[${i + 1}] id="${it.id}" 标题：${it.title}｜类型：${deps.typeInfo(it.type).name}` +
        `${it.tags && it.tags.length ? '｜标签：' + it.tags.join('、') : ''}`
    )
    .join('\n');
  return {
    result: `知识库共 ${items.length} 条，以下列出 ${shown.length} 条：\n` + (text || '（空）'),
    citations: deps.buildCitations(shown, true),
  };
}

/** 看单条（原 get_entry）。 */
export function knowledgeGet(deps: KnowledgeDeps, args: Record<string, unknown>) {
  const it = deps.book[args.id as string];
  if (!it) return { result: '未找到该条目（id: ' + args.id + '）。' };
  // 星级缺失时回落到可读文案：原实现会输出 `星级：undefined`（缺 status 的条目，
  // 例如早期导入的数据），而这段文本是直接给模型看的。
  const star = (deps.starLevels[it.status] || ({} as { name?: string })).name || it.status || '未设置';
  return {
    result:
      `标题：${it.title}\n类型：${deps.typeInfo(it.type).name}\n` +
      `星级：${star}\n` +
      `标签：${(it.tags || []).join('、') || '无'}\n备注：${it.note || '无'}\n链接：${it.url || '无'}`,
  };
}

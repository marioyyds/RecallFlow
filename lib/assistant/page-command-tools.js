// 页面命令（内容脚本）族（annotate / inspect_element / scroll_page / get_element_source /
// undo_last_action）—— C-1 拆出的第 13 族，也是 `executeTool` 巨型 switch 的最后一族。
//
// 为什么这五个算一族：它们都把参数发给**内容脚本**由页面侧执行
//（`executePageTool` / `executeContentAction` / `sendTabMessage`），自身不含复杂逻辑 ——
// 主要是"把 op 映射成命令名"和参数整理。
//
// ⚠ **"同属本模块"≠"可以合并成一个工具"。** 本模块只是代码归类；
// 面向模型的工具边界由 C-4 的判据决定（**执行路径 + 权限类别**）：
//   · `annotate`（page + 逐次审批，四合一）与 `inspect_element`（read/readOnly/parallelSafe，三合一）
//     各自是已执行的合并档；
//   · `scroll_page` 是 page 命令但**无审批**要求，`get_element_source` 走**独立消息**
//     且被 MCP「页面元素 → 源码文件」闭环使用，`undo_last_action` 是 `verify:false` 的**恢复动作**；
//   · 这三者**刻意保持独立**，不并入上面两个。理由见各 case 内注释与 docs/tool-merge-plan.md。
//
// **搬运原则：不重写行为。** 实现从 tools.js 原样搬来，闭包依赖改为显式注入。

/** annotate 的 op → 内容脚本命令名。**唯一来源**，避免与文档/schema 三方漂移。 */
export const ANNOTATE_OPS = Object.freeze({
  highlight: 'highlight',
  outline: 'outline',
  style: 'set_style',
  clear: 'clear_highlights',
});

/** inspect_element 的 op → 内容脚本命令名。 */
export const INSPECT_OPS = Object.freeze({
  text: 'get_text',
  inspect: 'inspect_element',
  table: 'extract_table',
  // 读**计算后的**样式。补这一档的原因见 commands.js 的 cmdReadStyles：
  // 在此之前"验证样式改没改成功"只能借道 run_javascript，
  // 而它是 alwaysRequireApproval（每次都打断用户）且会因页面 CSP 直接失败。
  styles: 'read_styles',
});

/**
 * annotate：在页面上做视觉标注（高亮 / 描边 / 改样式 / 清浮层）。
 *
 * 这四个 op 原本是四个独立工具，因**执行路径与权限完全一致**（都是
 * page + 逐次审批，都会走到 `executePageTool` → 内容脚本的
 * highlight / outline / set_style / clear_highlights）而合并为纯换入口。
 */
export async function annotate(deps, args) {
  const ctx = deps.ctx;
  const op = String(args.op || '').trim();
  const cmd = ANNOTATE_OPS[op];
  if (!cmd) {
    return deps.toolError('BAD_ARGS', 'annotate 需要 op 参数，取值：' + Object.keys(ANNOTATE_OPS).join(' / ') + '。');
  }
  const rest = Object.assign({}, args);
  delete rest.op;
  // op=clear 的语义是"清掉整页浮层"：带上定位参数会让内容脚本按目标去清（语义不符）。
  if (op === 'clear') return await deps.executePageTool(ctx.tabId, cmd, {}, ctx);
  return await deps.executePageTool(ctx.tabId, cmd, rest, ctx);
}

/**
 * inspect_element：读元素的文本 / 结构 / 表格。
 *
 * 这三个 op 同权限（read/readOnly/parallelSafe）且同路径，因此是纯换入口的合并。
 *
 * 注意本档**没有**并入 `get_attribute` 与 `get_element_source`：它们虽然语义上也是"看元素"，
 * 但走的是各自不同的执行路径（独立消息 / 源码映射链路），且 `get_element_source` 还被
 * MCP 集成侧的「页面元素 → 源码文件」闭环直接使用。理由与知识库档一致：
 * **按执行路径与权限类别分组，而不是按语义相似度分组**。
 */
export async function inspectElement(deps, args) {
  const op = String(args.op || '').trim();
  const cmd = INSPECT_OPS[op];
  if (!cmd) {
    return deps.toolError('BAD_ARGS', 'inspect_element 需要 op 参数，取值：' + Object.keys(INSPECT_OPS).join(' / ') + '。');
  }
  const rest = Object.assign({}, args);
  delete rest.op;
  return await deps.executePageTool(deps.ctx.tabId, cmd, rest, deps.ctx);
}

/**
 * scroll_page：有目标或坐标就滚到目标，否则按偏移滚动。
 *
 * 合并自 scroll_to_element / scroll_page（更早的一次合并）。
 */
export async function scrollPage(deps, args) {
  const params = args || {};
  const hasTarget = Boolean(params.ref || params.selector || params.text);
  const hasCoords = typeof params.top === 'number' || typeof params.left === 'number';
  return await deps.executePageTool(deps.ctx.tabId, hasTarget || hasCoords ? 'scroll_to' : 'scroll_by', params, deps.ctx);
}

/** get_element_source：把页面元素映射回源码文件:行:列（框架组件信息也在里面）。 */
export async function getElementSource(deps, args) {
  const tabId = deps.ctx.tabId;
  if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
  try {
    // 走独立消息（不是 executePageTool）：源码映射由内容脚本的注入钩子维护，
    // 这条链路同时被 MCP 集成侧的「页面元素 → 源码文件」闭环使用。
    const res = await deps.sendTabMessage(tabId, { type: 'kbGetElementSource', params: args });
    if (!res || !res.found) return { ok: false, result: (res && res.reason) || '未找到元素或框架源码信息。' };
    const s = res.source || {};
    const loc = String(s.file || '') + (s.line ? ':' + s.line + (s.column ? ':' + s.column : '') : '');
    const extra = (s.framework ? '（' + s.framework + (s.component ? ' · ' + s.component : '') + '）' : '');
    return { ok: true, result: '元素源码位置：' + loc + extra + (res.selector ? '\n选择器：' + res.selector : '') };
  } catch (e) {
    return { ok: false, result: '解析元素源码失败：' + e.message };
  }
}

/** undo_last_action：撤销上一次页面动作（`verify:false` —— 恢复动作不该再被校验拖慢）。 */
export async function undoLastAction(deps, args) {
  return await deps.executeContentAction(deps.ctx.tabId, 'undo_last_action', { type: 'kbUndo', params: args }, { verify: false });
}

/** 该族处理哪些工具名。 */
export const PAGE_COMMAND_TOOLS = new Set(['annotate', 'inspect_element', 'scroll_page', 'get_element_source', 'undo_last_action']);

/** 统一入口。返回 null 表示"不属于本族"。 */
export async function handlePageCommandTool(name, args, deps) {
  if (name === 'annotate') return await annotate(deps, args);
  if (name === 'inspect_element') return await inspectElement(deps, args);
  if (name === 'scroll_page') return await scrollPage(deps, args);
  if (name === 'get_element_source') return await getElementSource(deps, args);
  if (name === 'undo_last_action') return await undoLastAction(deps, args);
  return null;
}

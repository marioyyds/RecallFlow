// 快慢道的**动作分组唯一事实源**。
//
// 2026-11-12 的真实轨迹给出的结论：浏览器任务绝大多数聚焦在同一个页面上，
// 页内动作可以按“是否需要内容值 / 是否跨页”切两半：
//   - 点击、滚动、等待、只读 → 页内战术，可以交给快路（edge 或 JEV operation）；
//   - 文本输入 / 下拉 / 勾选 → 需要内容值，而值只能来自当前指令，必须慢思考亲自做；
//   - 导航（open_tab / switch_tab）→ 跨页战略，留给慢思考（显式委托除外）；
//   - run_javascript / click_at → 不可锚定、有提权面，永远慢路。
//
// 这个表同时被三处引用：edge 提名、operation 回退、报告里的 act/observe 统计。
// 新增工具时必须改这里，而不是各写一份白名单。

export const FAST_EDGE_TOOLS: ReadonlySet<string> = new Set([
  'click_element',
  'scroll_page',
  'wait_for_element',
]);

export const OBSERVATION_TOOLS: ReadonlySet<string> = new Set([
  'get_page_snapshot',
  'read_current_page',
  'read_table',
  'get_ax_snapshot',
  'inspect_element',
  'read_diagnostics',
  'list_frames',
  'list_tabs',
]);

export const SLOW_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'type_text',
  'select_option',
  'check_box',
  'press_key',
  'open_tab',
  'switch_tab',
  'run_javascript',
  'click_at',
  'hover_element',
  'fetch_webpage',
  'complete_task',
]);

export function isFastEdgeTool(name: unknown): boolean {
  return FAST_EDGE_TOOLS.has(String(name || ''));
}

export function isObservationTool(name: unknown): boolean {
  return OBSERVATION_TOOLS.has(String(name || ''));
}

// 只读工具：观察 + 读取/检索类。它们不会改变页面状态，因此不应该单独
// “唤醒”下一次快路尝试（2026-11-12 CSDN：31 次尝试里大半是读完页面又试一次）。
const READ_ONLY_EXTRA: ReadonlySet<string> = new Set([
  'fetch_webpage',
  'knowledge_read',
  'web_search',
  'take_screenshot',
]);

export function isReadOnlyTool(name: unknown): boolean {
  const text = String(name || '');
  return OBSERVATION_TOOLS.has(text) || READ_ONLY_EXTRA.has(text);
}

/** 会改变页面/浏览器状态的动作（进入 JEV 的动作历史）。 */
export const PAGE_ACTION_TOOLS: ReadonlySet<string> = new Set([
  'click_element',
  'click_at',
  'type_text',
  'press_key',
  'select_option',
  'check_box',
  'scroll_page',
  'hover_element',
  'open_tab',
  'switch_tab',
  'run_javascript',
  'upload_file',
]);

export function isPageActionTool(name: unknown): boolean {
  return PAGE_ACTION_TOOLS.has(String(name || ''));
}

export function isSlowOnlyTool(name: unknown): boolean {
  return SLOW_ONLY_TOOLS.has(String(name || ''));
}
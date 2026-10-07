// 扩展侧支持的方法名**唯一来源**。
//
// 这里区分两套清单，因为它们服务**两个不同的消费者**：
//
//   BRIDGE_METHODS —— MCP server（opencode 那条链路）会调用的方法。
//     tests/bridge-contract.test.mjs 会核对"清单里的每个方法都有 dispatch 分支"以及
//     "每个方法都被 MCP 真的调用过"（防僵尸条目）。所以**不能**把插件专用的方法塞进来，
//     否则那两条测试会（正确地）变红。
//
//   READONLY_*_METHODS —— DSH 插件的 recallflow_browser 额外暴露的**只读**方法。
//     扩展侧同一套 dispatch 支持它们，但没有 MCP 调用方。
//     按路由分两组：content（需要内容脚本、作用于活动标签页）与 background（不需要页面）。
//
//   EXTENSION_METHODS = 两者之和 —— "扩展 dispatch 必须支持的全部方法"，
//     供契约测试核对"清单 ↔ 分支"不出现空洞（空洞 = 运行时报 unknown method）。
//
// 生产者/消费者：方法名由两侧共同约定 ——
//   MCP server 用 callExtension('<method>', ...) 发起；插件用 WS 的 tool-call 发起；
//   扩展 lib/bridge/relay.js 的 dispatch 处理。
// 任一侧改名/拼错只会在**运行时**报 "unknown method"，而这条链路恰是最难手工回归的，
// 所以清单放在纯数据模块里，让测试同时核对两侧，把漂移变成红灯。
//
// 注意：本文件必须保持零依赖（可被浏览器扩展与 node 测试同时载入）。

export const BRIDGE_METHODS = Object.freeze([
  'browser_read',
  'read_console',
  'read_network',
  'get_element_source',
  'page_health',
  'verify_change',
  'get_picked_element',
  'handoff_get',
  'handoff_list',
  'screenshot_capture',
]);

/**
 * 只读档 · 页面类：作用于**活动标签页**，需要内容脚本。
 * 全部在 lib/assistant/tool-metadata.js 里标着 route:'content' + readOnly:true。
 */
export const READONLY_CONTENT_METHODS = Object.freeze([
  'read_current_page',
  'get_page_snapshot',
  'get_attribute',
  'get_element_text',
  'inspect_element',
  'extract_table',
  'wait_for_element',
]);

/**
 * 只读档 · 后台类：不需要页面（或自己决定用哪个标签页），直接在后台执行。
 * 全部标着 route:'background' + readOnly:true。
 */
export const READONLY_BACKGROUND_METHODS = Object.freeze([
  'get_ax_snapshot',
  'list_tabs',
  'list_frames',
  'list_downloads',
  'take_screenshot',
  'get_run_trace',
  'web_search',
  'search_knowledge_base',
  'list_knowledge_base',
  'get_entry',
  'list_macros',
  'list_userscripts',
]);

/**
 * 改页面档（第二档）：会**修改用户正在看的页面**，全部在
 * lib/assistant/tool-metadata.js 里标着 `risk:'page'` + `requiresApproval:true`。
 *
 * **审批策略**：DSH 这侧没有面板那样的批准弹窗，所以只能"显式开"——
 * 插件默认**拒绝**这一档，除非 profile 的插件 config 里写了 `allowPageActions: true`。
 * 同时这一档**不在 BRIDGE_METHODS 里**，而那个清单是 probe-tool 的白名单，
 * 于是"诊断探针永远不会触发改页面动作"成为一条可测试的性质（见 bridge-contract.test.mjs）。
 *
 * 这里只收"纯粹改当前页面"的；**代码执行类**（run_userscript / run_macro）与
 * 浏览器/网络/写入/删除类归到后面的档，它们的影响面不是"当前页面"。
 */
export const PAGE_ACTION_CONTENT_METHODS = Object.freeze([
  'click_element',
  'type_text',
  'press_key',
  'select_option',
  'check_box',
  'set_element_style',
  'highlight_text',
  'outline_element',
  'clear_page_overlays',
  'scroll_page',
  'undo_last_action',
]);

/** 改页面档里 route:'background' 的那些（它们自己决定对哪个标签页动手）。 */
export const PAGE_ACTION_BACKGROUND_METHODS = Object.freeze([
  'click_at',
  'hover_element',
  'drag_element',
  'handle_dialog',
]);

/** 扩展 dispatch 必须支持的全部方法（MCP 的 + 只读档 + 改页面档）。
 *
 * 注意顺序：这三组 const 必须在它**之前**声明 —— 它在模块求值时就被展开，
 * 提前引用会踩 const 的 TDZ 并让整个模块抛错（本文件就犯过一次，见提交记录）。
 */
export const EXTENSION_METHODS = Object.freeze([
  ...BRIDGE_METHODS,
  ...READONLY_CONTENT_METHODS,
  ...READONLY_BACKGROUND_METHODS,
  ...PAGE_ACTION_CONTENT_METHODS,
  ...PAGE_ACTION_BACKGROUND_METHODS,
]);

/** MCP server 那条链路的合法方法（语义与历史一致：只认 MCP 会调的那些）。 */
export function isBridgeMethod(name) {
  return BRIDGE_METHODS.includes(String(name || ''));
}

/** 扩展 dispatch 能处理的任意方法（含插件只读档）。 */
export function isExtensionMethod(name) {
  return EXTENSION_METHODS.includes(String(name || ''));
}

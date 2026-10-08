// 每个内置工具的权限与路由元数据：{ risk, readOnly, requiresApproval, route, ... }。
//
// Agent 编排器据此决定是否需要用户确认；这与 Vercel AI 的 tool 定义思路一致，
// 避免在后台维护另一份易漂移的工具名单。
//
// 注意：TOOL_REGISTRY 对**缺失**的条目会静默降级为 risk:'unknown' + requiresApproval:true。
// 这正是 tests/tool-registry.test.mjs 要守住的漂移（新增工具却忘了登记元数据）。
//
// ---------------------------------------------------------------------------
// parallelSafe：可以与其他同批调用**并发执行**的白名单（见 parallel-tools.js）。
//
// 这是逐个人工复核的显式标记，**默认不存在即串行**。标记时必须同时满足：
//   a) 不改动任何被同批其它调用读取的状态。
//      反例：expand_result 读 ctx.resultStore、get_run_trace 读 trace 文件 ——
//      这两处的写入发生在「执行之后的串行后处理」里，并发会让它们读到本轮之前的旧状态，
//      破坏「同一个 assistant 消息内先执行后读取」的语义。这两个**故意不标记**。
//   b) 不切换标签页 / 不改变当前页面（否则同批其它调用的 ctx.tabId 会变）。
//      open_tab / switch_tab / click_element / scroll_page 等一律不标记。
//   c) 不需要用户审批 —— 审批是交互式等待，无法并发。
//
// 并发本身是安全的：CDP 层的 attach 用 tabId -> Promise 的 Map 去重
// （backend/cdp.js 明确写了「避免并发重复 attach」），content script 的
// sendTabMessage 也是一问一答。风险全在**共享状态**上，所以判定标准是 a/b/c 而不是"只读"。
// ---------------------------------------------------------------------------

export const TOOL_METADATA = {
  search_knowledge_base: { risk: 'read', readOnly: true, parallelSafe: true, route: 'background' },
  list_knowledge_base: { risk: 'read', readOnly: true, parallelSafe: true, route: 'background' },
  get_entry: { risk: 'read', readOnly: true, parallelSafe: true, route: 'background' },
  read_current_page: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
  get_page_snapshot: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
  read_console: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
  read_network: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
  get_element_source: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
  type_text: { risk: 'page', requiresApproval: true, route: 'content' },
  press_key: { risk: 'page', requiresApproval: true, route: 'content' },
  select_option: { risk: 'page', requiresApproval: true, route: 'content' },
  check_box: { risk: 'page', requiresApproval: true, route: 'content' },
  wait_for_element: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
  get_attribute: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
  list_tabs: { risk: 'read', readOnly: true, parallelSafe: true, route: 'background' },
  switch_tab: { risk: 'browser', requiresApproval: true, route: 'background' },
  add_entry: { risk: 'write', requiresApproval: true, route: 'background' },
  remove_entry: { risk: 'destructive', requiresApproval: true, route: 'background' },
  open_tab: { risk: 'browser', requiresApproval: true, route: 'background' },
  fetch_webpage: { risk: 'network', requiresApproval: true, parallelSafe: true, route: 'background', timeoutMs: 20000 },
  web_search: { risk: 'network', readOnly: true, requiresApproval: false, parallelSafe: true, route: 'background', timeoutMs: 20000 },
  click_element: { risk: 'page', requiresApproval: true, route: 'content' },
  set_element_style: { risk: 'page', requiresApproval: true, route: 'content' },
  highlight_text: { risk: 'page', requiresApproval: true, route: 'content' },
  outline_element: { risk: 'page', requiresApproval: true, route: 'content' },
  get_element_text: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
  inspect_element: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
  extract_table: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
  // 截图刻意不标记：它重、会向 UI 推图，且同批截图没有实际收益
  take_screenshot: { risk: 'read', readOnly: true, route: 'background' },
  scroll_page: { risk: 'page', requiresApproval: true, route: 'content' },
  clear_page_overlays: { risk: 'page', requiresApproval: true, route: 'content' },
  run_javascript: { risk: 'high', requiresApproval: true, alwaysRequireApproval: true, route: 'content' },
  click_at: { risk: 'page', requiresApproval: true, route: 'background' },
  hover_element: { risk: 'page', requiresApproval: true, route: 'background' },
  drag_element: { risk: 'page', requiresApproval: true, route: 'background' },
  upload_file: { risk: 'write', requiresApproval: true, route: 'background' },
  get_ax_snapshot: { risk: 'read', readOnly: true, parallelSafe: true, route: 'background' },
  list_frames: { risk: 'read', readOnly: true, parallelSafe: true, route: 'background' },
  undo_last_action: { risk: 'page', requiresApproval: true, route: 'content' },
  save_macro: { risk: 'write', readOnly: false, route: 'background' },
  list_macros: { risk: 'read', readOnly: true, parallelSafe: true, route: 'background' },
  run_macro: { risk: 'page', requiresApproval: true, route: 'background' },
  trust_site: { risk: 'write', requiresApproval: true, route: 'background' },
  // 循环内有专门分支 / 依赖同轮前序结果 —— 见文件头 a) 与「专门分支」说明，故意不标记
  update_plan: { risk: 'read', readOnly: true, alwaysAvailable: true, route: 'background' },
  expand_result: { risk: 'read', readOnly: true, alwaysAvailable: true, route: 'background' },
  handle_dialog: { risk: 'page', requiresApproval: true, route: 'background' },
  list_downloads: { risk: 'read', readOnly: true, parallelSafe: true, route: 'background' },
  get_run_trace: { risk: 'read', readOnly: true, alwaysAvailable: true, route: 'background' },
  list_userscripts: { risk: 'read', readOnly: true, parallelSafe: true, route: 'background' },
  search_userscripts: { risk: 'network', requiresApproval: true, route: 'background' },
  install_userscript: { risk: 'write', requiresApproval: true, route: 'background' },
  run_userscript: { risk: 'page', requiresApproval: true, route: 'content' },
  complete_task: { risk: 'read', readOnly: true, route: 'background' },
  load_skill: { risk: 'read', readOnly: true, alwaysAvailable: true, route: 'background' },
  install_skill: { risk: 'external', readOnly: false, alwaysAvailable: true, requiresApproval: true, route: 'background' },
};

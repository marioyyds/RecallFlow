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
  // C-4 合并第 4 档：只读三件套（search/list/get）→ knowledge_read({ op })。
  // 三者权限完全一致（read/readOnly/parallelSafe），因此合并**不改变任何权限语义**。
  // 写（add_entry）与删（remove_entry）**刻意保持独立** —— 见 lib/assistant/knowledge.js 文件头。
  knowledge_read: { risk: 'read', readOnly: true, parallelSafe: true, route: 'background' },
  read_current_page: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
  get_page_snapshot: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
  // C-4 合并：原 read_console / read_network / list_downloads → read_diagnostics(kind)。
  // 三者原本都是 read/readOnly/parallelSafe，权限无差异，因此合并**不改变任何权限语义**。
  // route 取 'content'（console/network 走内容脚本；downloads 的实现本身在后台，不受 route 影响）。
  read_diagnostics: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
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
  // C-4 合并第 1 档：highlight_text / outline_element / set_element_style / clear_page_overlays
  // → annotate({ op })。四者风险完全相同（page + 逐次审批），因此是**纯粹的收敛**，
  // 不存在"取最高"的歧义 —— 也因此它是这一轮里风险最低的一档。
  // 四个 op 共用同一条执行路径（executePageTool → 内容脚本 highlight/outline/set_style/clear_highlights）。
  annotate: { risk: 'page', requiresApproval: true, route: 'content' },
  // C-4 合并第 2 档：get_element_text / inspect_element / extract_table → inspect_element({ op })。
  // 三者权限完全一致（read/readOnly/parallelSafe），且原本就共用同一条执行路径。
  // ⚠ 本档**没有**并入 get_attribute 与 get_element_source：它们走各自不同的执行路径
  //（独立消息 / 源码映射链路），且后者被 MCP 的「页面元素 → 源码文件」闭环直接使用。
  inspect_element: { risk: 'read', readOnly: true, parallelSafe: true, route: 'content' },
  // 截图刻意不标记：它重、会向 UI 推图，且同批截图没有实际收益
  take_screenshot: { risk: 'read', readOnly: true, route: 'background' },
  scroll_page: { risk: 'page', requiresApproval: true, route: 'content' },
  // run_javascript 与普通页面命令同级：由「页面命令」类别统一控制审批。
  // 它仍会修改页面，但不再单独占用一个"代码执行"审批档；需要更严时可关闭「页面命令」自动批准。
  run_javascript: { risk: 'page', requiresApproval: true, route: 'content' },
  click_at: { risk: 'page', requiresApproval: true, route: 'background' },
  hover_element: { risk: 'page', requiresApproval: true, route: 'background' },
  drag_element: { risk: 'page', requiresApproval: true, route: 'background' },
  upload_file: { risk: 'destructive', requiresApproval: true, route: 'background' },
  get_ax_snapshot: { risk: 'read', readOnly: true, parallelSafe: true, route: 'background' },
  list_frames: { risk: 'read', readOnly: true, parallelSafe: true, route: 'background' },
  undo_last_action: { risk: 'page', requiresApproval: true, route: 'content' },
  // C-4 合并第 5 档：save_macro + list_macros + run_macro → macro({ op })。
  // **risk 取三者最高**：save_macro 是 write+审批、list_macros 是 read、run_macro 是 page+审批
  // → 合并后必须继承 write + 逐次审批（tests/tool-merge-plan.test.mjs 会自动算出并断言）。
  // 另有两条**按 op 分别保留**的防线（见 lib/assistant/macros.js 文件头注释）：
  //   · op=save 的写审批；· op=run 的执行期 REPLAYABLE_TOOLS 白名单（有真实提权先例）。
  macro: { risk: 'write', readOnly: false, requiresApproval: true, route: 'background' },
  trust_site: { risk: 'write', requiresApproval: true, route: 'background' },
  // 循环内有专门分支 / 依赖同轮前序结果 —— 见文件头 a) 与「专门分支」说明，故意不标记
  update_plan: { risk: 'read', readOnly: true, alwaysAvailable: true, route: 'background' },
  expand_result: { risk: 'read', readOnly: true, alwaysAvailable: true, route: 'background' },
  handle_dialog: { risk: 'page', requiresApproval: true, route: 'background' },

  get_run_trace: { risk: 'read', readOnly: true, alwaysAvailable: true, route: 'background' },
  list_userscripts: { risk: 'read', readOnly: true, parallelSafe: true, route: 'background' },
  search_userscripts: { risk: 'network', requiresApproval: true, route: 'background' },
  install_userscript: { risk: 'high', requiresApproval: true, alwaysRequireApproval: true, route: 'background' },
  run_userscript: { risk: 'high', requiresApproval: true, alwaysRequireApproval: true, route: 'content' },
  complete_task: { risk: 'read', readOnly: true, route: 'background' },
  load_skill: { risk: 'read', readOnly: true, alwaysAvailable: true, route: 'background' },
  install_skill: { risk: 'external', readOnly: false, alwaysAvailable: true, requiresApproval: true, route: 'background' },
  // save_skill：把一段做法写成**会进入今后系统提示**的技能正文 —— 这是一条**持久化**的注入面，
  // 比单次 run_javascript 的影响更长远（那一轮结束就没了，这个会一直留在技能目录里）。
  // 因此取最严的一档：high + alwaysRequireApproval
  //   · 不受"站点信任"影响（toolNeedsApproval 会先看 alwaysRequireApproval）；
  //   · 不参与 toolApprovalPolicy 的类别自动批准（"编辑知识库"勾上也拦得住它）。
  // ⚠ 残余风险如实记录：用户在设置里把「用户脚本 / 技能写入审批」设为 auto 时，这一档同样不再弹窗
  //   （与用户脚本共用一个开关，这是既有设计）；面板里会显示「本任务内允许」按钮，
  //   用户点它即表示接受本轮后续的 save_skill。
  // alwaysAvailable：跨意图常驻。**这是必需的**：实测会话 RF-FY6PUP 里「沉淀为技能」
  //   被意图路由判成 knowledge_task，而知识库意图只带 6 个工具 —— 若不在常驻集合里，
  //   用户在这类意图下永远看不到这个能力。
  save_skill: { risk: 'high', readOnly: false, alwaysAvailable: true, requiresApproval: true, alwaysRequireApproval: true, route: 'background' },
};

// 本机 MCP 桥接的**写入许可**判定（纯逻辑，便于直测）。
//
// 为什么需要单独一层：内置工具的审批由 agent 循环负责（approval-policy.js 的 toolNeedsApproval +
// waitForToolApproval）。桥接层是**另一条入口**，它直接调 executeTool —— 也就是说，
// 如果照搬「开放一批写工具」，那些写操作会**绕过审批**在用户真实浏览器上执行。
// 对前端调试场景这就是硬伤：模型可以点「删除」、填「提交」、跑任意 JS，而用户从没同意过。
//
// 因此本模块定义桥接层自己的许可清单与拒绝语义：
//   1. 白名单：只有明确列出的工具可经桥接执行（默认拒绝）；
//   2. 高风险（run_javascript / 用户脚本 / 上传本地文件）**不开放**，只允许在浏览器面板里由用户当次批准；
//   3. 拒绝时必须给出可操作的替代路径（与 docs/tool-design.md §7 一致）。
//
// 白名单分三组，参数形状不同（判据是「这个工具需要什么参数」，不是「它看起来像什么」）：
//   · BRIDGE_PAGE_TOOLS   页面内动作（点击/输入/滚动…）—— 需要定位参数
//   · BRIDGE_INSPECT_TOOLS 只读观测（快照/框架/AX 树）—— 没有目标可指，不需要定位参数
//   · BRIDGE_NAV_TOOLS     导航（open_tab）—— 需要 URL。一次完整流程的第一步就是"到达页面"，
//                          不开它，外部客户端只能等用户手动把页面打开并保持为活动标签页。
//
// 本文件必须保持零依赖：扩展侧与 node 测试都要能直接载入。

/** 允许经本机桥接执行的页面内写操作。刻意从窄：读能力已单独覆盖，这里只加"调试闭环必需"的。 */
export const BRIDGE_PAGE_TOOLS = Object.freeze([
  'click_element',
  'type_text',
  'press_key',
  'wait_for_element',
  'scroll_page',
  'select_option',
  'check_box',
]);

/**
 * **只读观测**工具：不属于写操作，但经桥接执行时**不需要**定位参数。
 *
 * 为什么必须单独分组（这是一个实测出来的缺陷，不是洁癖）：
 * 这三个工具的 schema 里**根本没有** ref / selector / text ——
 * `get_page_snapshot` 收的是 maxElements / maxText / frameId / includeFrames，
 * `list_frames` 与 `get_ax_snapshot` 连参数都几乎没有。
 * 此前它们被并进页面动作组，于是无参调用会被 NO_TARGET 拒绝 ——
 * **而 ref 的唯一来源恰恰是 get_page_snapshot**：
 *
 *     要拿 ref  → 必须调 get_page_snapshot
 *     调 get_page_snapshot → 被要求提供 ref  → 拒
 *
 * 也就是说，外部 agent 连"取快照拿 ref"这一步都做不到，
 * 而 README 把「get_page_snapshot 取 ref → page_action → verify_change」写成标准闭环。
 *
 * 判据仍然是「这个工具的参数形状」：只读观测工具**没有目标可指**。
 * 安全性不受影响：它们只观察、不改变页面（分组不变式由 registry 门禁核对
 * `readOnly: true`，见 tests/silent-failure-regressions.test.mjs）。
 */
export const BRIDGE_INSPECT_TOOLS = Object.freeze([
  'get_page_snapshot',
  'list_frames',
  'get_ax_snapshot',
]);

/**
 * **导航**类写操作：会改变「用户在哪个页面」而不只是页面内部状态。
 *
 * 为什么单独成组而不是直接并进 BRIDGE_PAGE_TOOLS：这两类的参数形状与风险都不同 ——
 * 页面动作必须带定位参数（ref/selector/坐标），而 open_tab 带的是 URL；
 * 混进一套校验要么让 open_tab 被 NO_TARGET 误拒，要么让页面动作绕过定位校验。
 *
 * `open_tab` 为什么必须开（原本在 BRIDGE_DENIED_TOOLS 里）：
 * 「让外部客户端驱动一次完整流程」的第一步就是**到达目标页面**。此前只能让用户
 * 手动把页面打开并保持为活动标签页，外部 agent 才动得了 —— 这使「发一条指令就完成」
 * 在第一步就断了。放开它换来的能力边界是明确的：**新开一个标签页**，
 * 它不读取、不点击、也不上传任何本机文件。
 */
export const BRIDGE_NAV_TOOLS = Object.freeze(['open_tab']);

/**
 * 允许经本机桥接执行的写操作（页面动作 + 导航，供清单展示与文档引用）。
 *
 * ⚠ 校验请按分组走（页面动作要定位参数、导航要 URL），不要只查这个并集：
 * 参数校验的判据是「这个工具到底需要什么」，而不是「它在不在白名单里」。
 * 只读观测工具（BRIDGE_INSPECT_TOOLS）不在此列 —— 它们不是写操作。
 */
export const BRIDGE_WRITE_TOOLS = Object.freeze([...BRIDGE_PAGE_TOOLS, ...BRIDGE_NAV_TOOLS]);

/**
 * 明确**不**经桥接开放的能力，以及原因。用于生成可读的拒绝信息。
 * 这些不是"忘了加"，而是有意的边界。
 */
export const BRIDGE_DENIED_TOOLS = Object.freeze({
  run_javascript: '任意代码执行只能由你在浏览器面板里当次批准，不开放给外部客户端。',
  run_userscript: '用户脚本执行需要面板内逐次批准。',
  install_userscript: '安装用户脚本需要面板内逐次批准。',
  upload_file: '上传本地文件不可由外部客户端触发（会把本机文件交给网站）。',
  fetch_webpage: '网络抓取不属页面调试，且会以你的登录态访问任意地址。',
  web_search: '网络检索不属页面调试。',
  switch_tab: '标签页切换会影响用户当前视图；需要目标页面时请用 open_tab（可复用已开页面）。',
  remove_entry: '本地数据的删除不开放给外部客户端。',
  add_entry: '本地数据的写入不开放给外部客户端。',
});

/** 是否为允许经桥接执行的写工具（页面动作 + 导航）。 */
export function isBridgeWriteTool(name) {
  return BRIDGE_WRITE_TOOLS.includes(String(name || ''));
}

/** 是否为页面内动作（需要定位参数）。 */
export function isBridgePageTool(name) {
  return BRIDGE_PAGE_TOOLS.includes(String(name || ''));
}

/** 是否为导航动作（需要合法 URL，不需要定位参数）。 */
export function isBridgeNavTool(name) {
  return BRIDGE_NAV_TOOLS.includes(String(name || ''));
}

/** 是否为只读观测动作（既不需要定位参数，也不需要 URL）。 */
export function isBridgeInspectTool(name) {
  return BRIDGE_INSPECT_TOOLS.includes(String(name || ''));
}

/**
 * 页面动作的定位参数校验。
 *
 * @returns {{ok:true}|{ok:false,code:string,error:string}}
 */
function checkPageTarget(name, args) {
  const hasTarget =
    args.ref || args.selector || args.text || args.role || args.name || args.testid ||
    Number.isFinite(Number(args.x)) || Number.isFinite(Number(args.y));
  if (!hasTarget) {
    return {
      ok: false,
      code: 'NO_TARGET',
      error:
        '缺少定位参数。请先用 get_page_snapshot 取 ref，或提供 selector / text / role+name / testid / 坐标。',
    };
  }
  return { ok: true };
}

/**
 * 导航动作的参数校验：只放行 http(s)，其余一律拒绝。
 *
 * 为什么在桥接层也要查一遍：扩展侧的 openTab 同样会查（tab-tools.js），
 * 但桥接是**独立入口**，它的拒绝信息要能直接告诉调用方"该怎么改"；
 * 而且这一层是唯一能给出 code（便于机器判断）的地方。
 */
function checkNavArgs(name, args) {
  const url = String(args.url || '').trim();
  if (!url) {
    return {
      ok: false,
      code: 'NO_URL',
      error: name + ' 需要 url（要打开的绝对 http(s) 地址）。',
    };
  }
  if (!/^https?:\/\//i.test(url)) {
    return {
      ok: false,
      code: 'BAD_URL',
      error:
        name + ' 仅支持 http/https 地址，收到：' + url +
        '。不能打开 chrome://、file://、javascript: 等地址（会越过浏览器安全边界）。',
    };
  }
  return { ok: true };
}

/**
 * 校验一次桥接写入请求。
 *
 * @param {string} name 工具名
 * @param {object} args 参数
 * @returns {{ok:true,name:string}|{ok:false,error:string,code:string}}
 */
export function validateBridgeWrite(name, args) {
  const tool = String(name || '').trim();
  if (!tool) return { ok: false, code: 'NO_TOOL', error: '缺少工具名。' };
  if (Object.prototype.hasOwnProperty.call(BRIDGE_DENIED_TOOLS, tool)) {
    return {
      ok: false,
      code: 'TOOL_NOT_EXPOSED',
      error: '工具「' + tool + '」不经本机桥接开放：' + BRIDGE_DENIED_TOOLS[tool],
    };
  }
  if (!isBridgeWriteTool(tool) && !isBridgeInspectTool(tool)) {
    return {
      ok: false,
      code: 'TOOL_NOT_ALLOWED',
      error:
        '工具「' + tool + '」不在桥接白名单内。可用动作：' +
        [...BRIDGE_PAGE_TOOLS, ...BRIDGE_INSPECT_TOOLS, ...BRIDGE_NAV_TOOLS].join('、') +
        '。若确需该能力，请在浏览器面板里直接让助手执行（面板会逐次征求你的同意）。',
    };
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: 'BAD_ARGS', error: '工具参数必须是 JSON 对象。' };
  }
  // 只读观测工具没有目标可指，直接放行（见 BRIDGE_INSPECT_TOOLS 的说明：
  // 对它们套用定位校验会挡死 ref 的唯一来源 get_page_snapshot）。
  if (isBridgeInspectTool(tool)) return { ok: true, name: tool };
  // 分组校验：判据是「这个工具到底需要什么参数」，而不是「它在不在白名单里」。
  const shape = isBridgeNavTool(tool) ? checkNavArgs(tool, args) : checkPageTarget(tool, args);
  if (!shape.ok) return shape;
  return { ok: true, name: tool };
}

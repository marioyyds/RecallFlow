// 本机 MCP 桥接的**写入许可**判定（纯逻辑，便于直测）。
//
// 为什么需要单独一层：内置工具的审批由 agent 循环负责（approval-policy.js 的 toolNeedsApproval +
// waitForToolApproval）。桥接层是**另一条入口**，它直接调 executeTool —— 也就是说，
// 如果照搬「开放一批写工具」，那些写操作会**绕过审批**在用户真实浏览器上执行。
// 对前端调试场景这就是硬伤：模型可以点「删除」、填「提交」、跑任意 JS，而用户从没同意过。
//
// 因此本模块定义桥接层自己的许可清单与拒绝语义：
//   1. 白名单：只有明确列出的工具可经桥接执行（默认拒绝）；
//   2. 高风险（run_javascript / 用户脚本）**不开放**，只允许在浏览器面板里由用户当次批准；
//   3. 拒绝时必须给出可操作的替代路径（与 docs/tool-design.md §7 一致）。
//
// 本文件必须保持零依赖：扩展侧与 node 测试都要能直接载入。

/** 允许经本机桥接执行的写操作。刻意从窄：读能力已单独覆盖，这里只加"调试闭环必需"的。 */
export const BRIDGE_WRITE_TOOLS = Object.freeze([
  'click_element',
  'type_text',
  'press_key',
  'wait_for_element',
  'get_page_snapshot',
  'get_ax_snapshot',
  'list_frames',
  'scroll_page',
  'select_option',
  'check_box',
]);

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
  open_tab: '请先由用户在浏览器里打开目标页面，再用 get_page_snapshot 读取。',
  switch_tab: '标签页切换会影响用户当前视图，不开放。',
  remove_entry: '本地数据的删除不开放给外部客户端。',
  add_entry: '本地数据的写入不开放给外部客户端。',
});

/** 是否为允许经桥接执行的写工具。 */
export function isBridgeWriteTool(name) {
  return BRIDGE_WRITE_TOOLS.includes(String(name || ''));
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
  if (!isBridgeWriteTool(tool)) {
    return {
      ok: false,
      code: 'TOOL_NOT_ALLOWED',
      error:
        '工具「' + tool + '」不在桥接写入白名单内。可用写入工具：' + BRIDGE_WRITE_TOOLS.join('、') +
        '。若确需该能力，请在浏览器面板里直接让助手执行（面板会逐次征求你的同意）。',
    };
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: 'BAD_ARGS', error: '工具参数必须是 JSON 对象。' };
  }
  // 定位参数至少要有一个，否则动作无从下手（与 tools.js 的定位语义一致）。
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
  return { ok: true, name: tool };
}

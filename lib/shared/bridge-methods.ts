// 扩展侧本地桥接支持的**方法名**唯一来源。
//
// 为什么单独成模块：方法名由两侧共同约定 ——
//   生产者：MCP server 用 callExtension('<method>', ...) 发起
//   消费者：扩展 lib/bridge/relay.js 的 dispatch 分支
// 任一侧改名/拼错，只会在**运行时**报 "unknown method"，而这条链路（真实浏览器会话、
// 页面健康、截图）恰恰是最难手工回归的部分。把清单放在纯数据模块里，
// 就能让 tests/bridge-contract.test.mjs 同时核对两侧，把漂移变成红灯。
//
// 注意：本文件必须保持零依赖（可被浏览器扩展与 node 测试同时载入）。

export const BRIDGE_METHODS = Object.freeze([
  'browser_read',
  // C-4 合并：原 read_console / read_network 收敛为 read_diagnostics({ kind })。
  // 桥接方法名必须与扩展的**工具名**一致（relay 按名字派发到 executeTool），
  // 因此工具改名时这里必须同步 —— 否则桥接会在运行时报"未知方法"。
  'read_diagnostics',
  'get_element_source',
  'page_health',
  'verify_change',
  'get_picked_element',
  'handoff_get',
  'handoff_list',
  'screenshot_capture',
  // 写入通道：外部客户端也能操作页面（否则"调试"只能看不能碰）。
  // 允许的工具与拒绝语义见 lib/shared/bridge-write-policy.js —— 桥接层是独立入口，
  // 不经过 agent 循环的审批，因此必须有自己的许可清单。
  'page_action',
  // 导航通道：打开一个页面。一次完整流程的第一步是"到达页面"——
  // 没有它，外部客户端只能等用户手动把页面打开并保持为活动标签页。
  // 只放行 http(s)，且单次调用只允许新开一个（见 relay.js 的 openTabViaBridge）。
  'open_tab',
  // agent 任务通道：把**一整条任务**交给扩展内置 agent，而不是逐步驱动。
  // 必须异步（桥接 60s / 客户端 90s，而真实流程是分钟级）：
  //   agent_task        启动，立刻返回 jobId
  //   agent_task_status 按游标读增量进度
  //   agent_task_cancel 发取消信号
  // 授权形态是「开工前声明 allowRisk」+「执行前逐个判定」——
  // 桥接场景没有面板，没人能回答 agent 循环的审批（见 lib/shared/bridge-agent-policy.js）。
  'agent_task',
  'agent_task_status',
  'agent_task_cancel',
]);

export function isBridgeMethod(name: string) {
  return BRIDGE_METHODS.includes(String(name || ''));
}

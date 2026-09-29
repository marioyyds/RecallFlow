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

export function isBridgeMethod(name) {
  return BRIDGE_METHODS.includes(String(name || ''));
}

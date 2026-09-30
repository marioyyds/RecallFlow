// 服务端这一半是**空占位**。
//
// 为什么不需要它做实事：面板数据由浏览器端直接向桥接取（桥接已对本机来源开放只读 CORS，
// 见 integrations/opencode/recallflow-mcp/index.js 的 applyCors）。绕开服务端中转，
// 就不必去实现 DSH 的 typert/RPC 那一套，复杂度低得多、也少一处可能漂移的契约。
//
// 保留这个文件的原因：包的加载路径要求有主入口，且 `dsh.bundle.patch` 会插入这个插件。
export const name = 'recallflow-panel-ui';

/** 与 client.js 共用的常量集中在这里，避免两处各写一份。 */
export const BRIDGE_ORIGIN = 'http://127.0.0.1:7801';
export const BRIDGE_TOKEN = 'recallflow-local-bridge-v1';

export function apply() {
  // 有意为空：UI 完全在客户端一半。
}

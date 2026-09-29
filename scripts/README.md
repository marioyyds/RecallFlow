test(bridge): MCP 截图通道的端到端验证台

桥接层是整个项目最难手工回归的部分：它横跨扩展与 MCP 两个包，
且真实调用需要「重载扩展 + 重启 server」，两者都会打断正在使用的 MCP 会话。
因此这里提供一套**隔离验证台**，不需要触碰任何运行中的实例。

scripts/verify-mcp-shot.mjs
  在隔离端口起一个 server 实例，用真实 MCP 协议（initialize / tools/list / tools/call）
  核对：工具已注册、参数完整、扩展不可用时错误路径优雅、本地工具能正常往返。

scripts/verify-mcp-shot-success.mjs
  额外扮演「假扩展」——通过 /poll 领取请求、经 /result 回结果，
  从而走通**成功路径**：图片真的以 MCP image 内容块返回、includeImage 开关生效、
  归档落盘且字节与源一致。

用法（PowerShell）：
  $env:RECALLFLOW_MCP_PORT='7802'            # 隔离端口，别用 7801
  $env:RECALLFLOW_EXT_TIMEOUT_MS='3000'      # 让依赖扩展的调用快速失败
  $env:RECALLFLOW_EVIDENCE_DIR="$env:TEMP\rf-evidence-test"   # 隔离证据目录
  node integrations/opencode/recallflow-mcp/index.js --http  # 后台起实例
  node scripts/verify-mcp-shot.mjs
  node scripts/verify-mcp-shot-success.mjs

两个脚本都返回非零退出码表示未通过，可直接用于改动后的回归。

已知未覆盖：真实扩展的 CDP 截图本身（screenshot_capture 的 relay 实现）需要重载扩展才能验证。

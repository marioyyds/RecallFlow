// 捕获值的结构类型（Batch 6 类型收口）
//
// 为什么需要它：`catch (e: any)` 是 963 个 `: any` 里最大的一类（140 处）。
// 把 catch 变量改成隐式 `unknown`（strict 下的默认）后，正文里访问 `e.message` /
// `e.name` / `e.status` 就会报 TS2339。这里用一个**纯类型**别名描述我们实际读的字段，
// 断言 `e as Caught` 在 esbuild 里被完全擦除 —— 产物字节不变，行为不变。
//
// 为什么不写 `catch (e: any)` 再断言：那只是把 any 挪了个位置，导出面与计数都不会变好。
// 为什么不写 `e instanceof Error` 分支：那会新增运行时代码（产物 delta），
// 而本次批次的口径是「纯类型改动 = 产物 0 变化」。
export type Caught = Error & {
  /** fetch/HTTP 错误上附加的状态码（mcp.ts / llm.ts 读取）。 */
  status?: number;
  /** 中断时携带的已生成内容（agent.ts 恢复路径读取）。 */
  partial?: { assistantMessage?: unknown };
  /** 工具超时标记（tools.ts / agent.ts）。 */
  rfToolTimeout?: boolean;
  timeoutMs?: number;
  /** SSE/JSON 体解析被拒（agent.ts 标记） */
  bodyParseRejected?: boolean;
  toolName?: string;
};

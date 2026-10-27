// Agent 的**上下文治理阈值**，集中一处。
//
// ## 为什么要抽出来
//
// 这些数字原先散落在 agent.js 各处（16000 / 6 / 300 / 6000 / 3000 …），
// 每一个都单独配着一段"为什么是这个值"的注释 —— 注释写得很好，
// 但**散落本身**带来两个问题：
//
//   1. 想调一次"上下文到底留多少"，要在 agent.js 里找五处，且看不出它们之间的关系
//      （折叠阈值与暂存阈值其实是同一件事的两道闸：先折叠老的，再暂存大的）；
//   2. 没有任何一处能回答"当前这一整套参数是多少"，于是它们事实上是硬编码 ——
//      `settings.agentBudget` 只接得住预算，接不住这些。
//
// 抽出来之后它们可被单测钉住（改一个数就会红），也为将来接进设置页留出唯一入口。
//
// ⚠ 抽的时候**一个数值都没改**：这是纯搬家，行为必须完全一致。
// （仓库的纪律：搬运式重构不得改变对外契约 —— 见 registry-fingerprint.test.mjs。）

export const CONTEXT_TUNING: Record<string, any> = Object.freeze({
  // ---- 历史折叠 ----
  // 按 **token 估算**而不是字符数：中英文密度差约 4 倍，同样 6 万字符，
  // 英文约 1.5 万 token 尚可接受，中文却接近 6 万 token —— 按字符数设阈值对中文形同虚设。
  collapseTokens: 16000,
  // 折叠时**完整保留**最近几条工具结果，其余压成"头 + 尾"。
  collapseKeepFull: 6,
  collapseHeadChars: 300,

  // ---- 大结果暂存 ----
  // 超过这个长度就把全文挪进 resultStore，消息里只留开头 + id（供 expand_result 取回）。
  // 阈值刻意放宽：截得太早会把"本来一次读得完"的结果变成一次额外的 expand_result 往返，
  // 而每一轮往返都是一次完整的模型请求。
  spillResultChars: 6000,
  spillInlineChars: 3000,

  // ---- 落盘会话 ----
  sessionMessageMaxChars: 12000,
  sessionMaxTailMessages: 39,
});

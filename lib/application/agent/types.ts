// Assistant 层的共享结构类型（Batch 6b-1：DI 接口化）
//
// 为什么单独成文件：`deps: any` / `ctx: any` / `settings: any` 三处占位类型此前
// 遍布 15 个 handler 族。把它们收敛成真实结构后，
//   · handler 能用到的依赖一眼可见（多传的字段不再悄悄生效）；
//   · 调用点由 tsc 反查校验（`tools.ts` 里每个族传入的字面量都会被结构化检查）；
//   · 纯类型别名在 esbuild 里被完全擦除 —— 产物字节不变（本批验收要求）。
//
// 纪律：这里只写**真实形状**。不要为了少改代码写 `[key: string]: any`，
// 也不要用 `unknown` + 到处 `as` 冒充（那是把明面上的 any 换成更隐蔽的洞）。
import type { KnowledgeBook, CitationMeta } from '../../domain/knowledge/model.ts';

/** Agent 预算（`settings.agentBudget` 与 `createBudget` 的产物）。 */
export interface AgentBudget {
  maxTotalTokens?: number;
  toolTimeoutMs?: number;
  maxOpenedTabs?: number;
  maxTabSwitches?: number;
  maxToolCalls?: number;
}

/** 一条 MCP 服务器配置（`settings.mcpServers`）。 */
export interface McpServerConfig {
  id?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** 一次 MCP 连接的结果（随运行上下文回传，供失败时说明原因）。 */
export interface McpServerStatus {
  serverId: string;
  url?: string;
  ok: boolean;
  toolCount?: number;
  ts?: number;
  status?: number;
  error?: string;
}

/** MCP 工具索引项：把 `mcp__<server>__<tool>` 映射回原始服务器与客户端。 */
export interface McpToolIndexEntry {
  serverId: string;
  origName: string;
  client: unknown;
}

/** AI 设置的真实形状（`lib/shared/settings.ts` 的默认值 + 运行期扩展字段）。 */
export interface AgentSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
  requestTimeoutMs: number;
  toolApprovalPolicy: Record<string, boolean>;
  mcpServers: McpServerConfig[];
  agentBudget: AgentBudget;
  cdpEnabled: boolean;
  siteMemoryEnabled: boolean;
  verifierEnabled: boolean;
  parallelToolCalls: boolean;
  trustedSites: string[];
  maxRetries?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  intentLlmAlways?: boolean;
  ts?: number;
}

/** 计划条（`update_plan` 维护）。 */
export interface PlanStep {
  text: string;
  status: string;
}

/** 可重放的一步（本任务轨迹 / 宏步骤）。 */
export interface TraceStep {
  tool: string;
  args: Record<string, unknown>;
}

/** 快照里的一条元素描述（内容脚本回执的简化形状）。 */
export interface SnapshotElementLike {
  ref?: string;
  index?: number;
  tag?: string;
  role?: string;
  type?: string;
  label?: string;
  name?: string;
  placeholder?: string;
  href?: string;
  selector?: string;
  disabled?: boolean;
  checked?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  center?: { x: number; y: number };
  inViewport?: boolean;
  [key: string]: unknown;
}

/**
 * 页面快照的宽松形状。
 *
 * 为什么不直接用 `lib/page/page-text.ts` 的 `PageSnapshot`：导航兜底路径
 * （`executeContentAction` 里）只合成 `{ version, url, title, fingerprint, scroll }`，
 * 缺元素与正文；这里描述的是「读取方实际会碰的字段」。
 */
export interface PageSnapshotLike {
  version?: number;
  url?: string;
  title?: string;
  text?: string;
  fingerprint?: string;
  elements?: SnapshotElementLike[];
  scroll?: { x: number; y: number; height?: number; viewport?: number } | null;
  capabilities?: Record<string, CapabilityBucketLike>;
  mainContent?: { selector?: string; textLength?: number; tag?: string; note?: string } | null;
  counts?: {
    interactive?: number;
    shown?: number;
    omittedBySize?: number;
    inViewport?: number;
    forms?: number;
  };
  frames?: FrameInfo[];
  frameRead?: { read: number[]; failed: number[]; total: number };
  frameId?: number;
  [key: string]: unknown;
}

/** 一类页面能力的计数与少量样本。 */
export interface CapabilityBucketLike {
  count?: number;
  samples?: SnapshotElementLike[];
}

/** 页面内一个框架的描述（`list_frames` / `chrome.scripting` 枚举结果）。 */
export interface FrameInfo {
  frameId?: number;
  href?: string;
  title?: string;
  isTop?: boolean;
}

/** 一个未处理的页面对话框（`handle_dialog` 待决状态）。 */
export interface DialogInfo {
  type?: string;
  message?: string;
  defaultPrompt?: string;
}

/** 页面动作验证字段（`buildActionVerification` / `verifyPageAction` 的产物）。 */
export interface ActionVerification {
  executed: boolean;
  verified: boolean;
  changed: boolean;
  urlChanged?: boolean;
  contentChanged?: boolean;
  scrollChanged?: boolean;
  reason: string;
}

/** 工具调用里的一个函数调用（OpenAI function-calling 格式）。 */
export interface ToolCall {
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
}

/** 一条对话消息（发给模型 / 从会话恢复的形状）。 */
export interface ChatMessage {
  role: string;
  content?: string | unknown[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  [key: string]: unknown;
}

/** 元素在页面上的位置（CDP 坐标输入）。 */
export interface ElementRect {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** 被打开/接管的标签页摘要（`targetTab`）。 */
export interface TargetTab {
  tabId?: number;
  windowId?: number;
  title?: string;
  url?: string;
  ready?: boolean;
}

/**
 * 页面侧回包与工具结果的通用形状。
 *
 * 页面回包是跨上下文消息，扩展侧没有可静态校验的来源（见
 * `lib/shared/content-script-bridge.ts` 的说明），因此这里列出调用方**实际读取**的字段；
 * 其余字段仍可存在，但读取前必须自行收窄（不要再用 `any` 绕开）。
 */
export interface ToolResult {
  ok?: boolean;
  result?: string;
  code?: string;
  error?: string;
  reason?: string;
  found?: boolean;
  blocked?: boolean;
  blockReason?: string;
  noop?: boolean;
  changed?: boolean;
  hadEffect?: boolean;
  alreadySatisfied?: boolean;
  activated?: boolean;
  matchesIntent?: boolean;
  matched?: boolean;
  complete?: boolean;
  needsLogin?: boolean;
  httpStatus?: number;
  statusCode?: number;
  selector?: string;
  url?: string;
  title?: string;
  text?: string;
  visibility?: unknown;
  snapshot?: unknown;
  frames?: FrameInfo[];
  targets?: SnapshotElementLike[];
  rect?: ElementRect | null;
  source?: {
    file?: string;
    line?: number;
    column?: number;
    framework?: string;
    component?: string;
    [key: string]: unknown;
  };
  screenshot?: ScreenshotResult;
  pageSnapshot?: PageSnapshotLike | null;
  targetTab?: TargetTab;
  targetTabId?: number;
  verification?: ActionVerification;
  citations?: CitationLike[];
  entries?: TraceRecordEntry[];
  partial?: unknown;
  authChallenge?: AuthChallenge | null;
  [key: string]: unknown;
}

/** 一张截图工具回执的元数据（图片本体在 `dataUrl`，面板按 id 归档）。 */
export interface ScreenshotResult {
  id?: string;
  dataUrl?: string;
  label?: string;
  name?: string;
  width?: number;
  height?: number;
  bytes?: number;
  archived?: unknown;
}

/** 运行轨迹的聚合指标（`run-metrics.ts` 的产物）。 */
export interface RunMetricsSummary {
  rounds: number;
  toolCalls: number;
  failedTools: number;
  expandResultRounds: number;
  byTool: Record<string, number>;
  cache: { hit: number; miss: number; ratio: number | null };
  totalMs: number;
  prefillMs: number;
  decodeMs: number;
  totalTokens: number;
  errors: number;
  timeouts: number;
  collapsed: number;
  repaired: number;
}

/** 工具元数据（`tool-metadata.ts` 的条目）。 */
export interface ToolMetadataEntry {
  risk?: string;
  requiresApproval?: boolean;
  readOnly?: boolean;
  mutatesState?: boolean;
  parallelSafe?: boolean;
  route?: string;
  alwaysAvailable?: boolean;
  alwaysRequireApproval?: boolean;
  timeoutMs?: number;
  [key: string]: unknown;
}

/** 前缀消息快照里的一条。 */
export interface MessageSnapshotEntry {
  fp: string;
  role: string;
  head: string;
}

/** 一轮出站消息的快照（按消息顺序）。 */
export type MessageSnapshot = MessageSnapshotEntry[];

/** 前缀比对结果。 */
export interface PrefixDiff {
  stable: boolean;
  reason: string;
  divergeAt: number;
  prevLength: number;
  nextLength: number;
  detail: string;
}

/** 一个技能（内置/用户/远程安装的形状，字段全部来自用户或存储）。 */
export interface SkillLike {
  id?: string;
  name?: string;
  displayName?: string;
  description?: string;
  tags?: string[];
  content?: string;
  tools?: unknown[];
  version?: string;
  category?: string;
  skill_type?: string;
  x?: { tools?: unknown[]; intents?: string[]; keywords?: string[] };
  [key: string]: unknown;
}

/** 一个已保存的宏（站点级可回放动作序列）。 */
export interface MacroRecord {
  name?: string;
  description?: string;
  steps: TraceStep[];
  updatedAt?: number;
  hits?: number;
}

/** 上一轮任务遗留的可回放轨迹（`recallTrace` 的回执）。 */
export interface RecalledTrace {
  steps?: TraceStep[];
  ageMs?: number;
  dropped?: number;
}

/** 一条引用（工具回执里的来源条目，全局编号由 agent 侧重排）。 */
export interface CitationLike {
  index?: number;
  source?: string;
  title?: string;
  url?: string;
  snippet?: string;
}

/** 一条结构化运行轨迹记录（`trace.ts` 落盘、`get_run_trace` 读回）。 */
export interface TraceRecordEntry {
  ts: number;
  phase: string;
  name?: string;
  ok?: boolean;
  ms?: number;
  args?: string;
  intent?: string;
  instruction?: string;
  reason?: string;
  totalTokens?: number;
  error?: string;
  [key: string]: unknown;
}

/**
 * 工具执行入口接受的上下文。
 *
 * 面板侧的 agent 传入完整的 `RunCtx`；桥接层（`lib/bridge/relay.ts`，本批禁改）
 * 用**部分上下文**调用同一入口（只带 tabId / pageUrl / pageTitle / openedTabs 等）。
 * 入口因此按「可读对象」接收，转派给工具族时再收窄为 `RunCtx` —— 字段缺失时的
 * 运行期行为与本批之前完全一致（缺字段的读取在各工具里本来就有守卫）。
 */
export type ToolCallContext = RunCtx | object;

/** 一次运行的可变上下文（`runAgentStream` 建立，工具族读取/就地更新）。 */
export interface RunCtx {
  book: KnowledgeBook;
  settings: AgentSettings;
  sessionId: string;
  page: string;
  pageUrl: string;
  pageTitle: string;
  tabId: number;
  originalTabId: number | undefined;
  openedTabs: number[];
  openedTabCount: number;
  maxOpenedTabs: number;
  tabSwitchCount: number;
  maxTabSwitches: number;
  failedUrls: string[];
  browsingMode: string;
  agentWindowId: number | null;
  trace: TraceStep[];
  plan: PlanStep[];
  resultStore: Map<string, string>;
  resultIds: Set<string>;
  lastSnapshot: PageSnapshotLike | null;
  lastEvidence: string;
  lastReadFullText: string;
  mcpIndex: Map<string, McpToolIndexEntry>;
  mcpStatus: McpServerStatus[];
  visionBudget?: Record<string, number>;
  visionSentImages?: number;
  pendingCloseTabs?: number[];
  pendingCloseWindowId?: number | null;
  lastAuthChallenge?: AuthChallenge | null;
  citations?: CitationLike[];
  /** Bridge-only pre-execution risk gate; absent for panel runs. */
  agentBudgetGuard?: (name: string) => unknown;
}

/** 一次鉴权挑战（`lastAuthChallenge`）。 */
export interface AuthChallenge {
  kind?: string;
  site?: string;
  detail?: string;
  ts?: number;
}

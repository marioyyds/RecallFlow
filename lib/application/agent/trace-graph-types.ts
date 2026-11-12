// tracegraph.v2 的共享数据契约。
//
// 这里的形状与 docs/tracegraph.v2.schema.json 一一对应。图来自
// chrome.storage.local，必须始终按不可信输入处理；执行授权不取决于本文件中的
// 任何置信度或相似度字段，而只由执行器的确定性守卫给出。

export const TRACE_GRAPH_KEY = 'recallflow.tracegraph.v2';
export const TRACE_GRAPH_TTL_MS = 30 * 60 * 1000;

export type TraceRisk = 'low' | 'medium' | 'high';
export type { TraceGraphSettings } from '../../shared/settings.ts';

export type PhiKind =
  | 'url_pattern'
  | 'counter'
  | 'value_equals'
  | 'element_present'
  | 'element_visible'
  | 'no_dialog'
  | 'not_satisfied'
  | 'text_contains'
  | 'diff_exists';

export interface SemanticAnchor {
  role?: string;
  name?: string;
  text?: string;
  urlPattern?: string;
  /**
   * 锚点的来源。`attribute` 表示 name 来自 aria-label / placeholder 之类的稳定属性；
   * `content` 表示它来自控件自身的可见文本（会随写入/翻页而变）；`selector` 表示
   * 没有可用语义名，只能靠 selector 唯一重定位。
   *
   * 为什么必须有这个字段：写入型目标的 label 就是它的正文（CSDN 编辑器的
   * pre.editor__inner 实测如此），把它当锚点，写完下一次必然 0 命中。
   */
  kind?: 'attribute' | 'content' | 'selector';
}

export interface StateTemplate {
  id: string;
  name: string;
  urlPattern: string;
  staticAtoms: string[];
  dynamicAtoms: string[];
  fingerprint?: string;
}

export interface Operation {
  id: string;
  name: string;
  description: string;
  srcState: string;
  dstState: string;
  inputSlots: string[];
  outputSchema?: Record<string, unknown>;
  semanticAnchor: SemanticAnchor;
  selectorHint?: string;
  waitMs?: number;
  patchable: boolean;
}

export interface SlotSpec {
  name: string;
  type: 'string' | 'markdown' | 'number' | 'enum' | 'branch' | 'target';
  source: 'current_instruction';
  constraint?: string;
  highRisk: boolean;
}

export interface PhiRule {
  kind: PhiKind;
  expr: string;
  observed?: string;
  source: 'structured';
}

export interface EdgeAction {
  tool: string;
  argsTemplate: Record<string, unknown>;
  risk: TraceRisk;
}

/**
 * 候选边与「当前观察」的结构匹配层级。**不是**语义相似度，也不授权执行：
 * 它只回答「这条边录制时的页面结构，与现在差多少」。
 *   full   : 静态原子与动态原子都与录制时一致
 *   static : 静态原子一致，动态原子是录制时的超集（值/勾选状态变了，结构没变）
 *   name   : 只有 URL 推出的状态名一致（旧图没有签名时一律按这一档）
 */
export type CandidateMatchLevel = 'full' | 'static' | 'name';

export interface CandidateMatch {
  level: CandidateMatchLevel;
  /** 静态原子交集 / 并集，0–1；仅用于诊断与排序，不是置信度。 */
  staticOverlap: number;
  dynamicOverlap: number;
}

export interface Edge {
  id: string;
  /** Version 4 merges repeated outcomes of the same state/tool/target action. */
  identityVersion?: 4;
  from: string;
  to: string;
  g: string;
  /**
   * 录制时的 atomSignature（`name#static+dynamic`），最多保留 8 条。
   * 非身份字段：同一条边被不同子状态的记录合并时，这里是这些子状态的并集。
   * 只在选择期用来算 CandidateMatch，不参与边身份，也不进执行授权。
   */
  fromSignatures?: string[];
  /**
   * 录制时的计划步（来自 TraceRecord.planStep），最多 3 条，最新的在前。
   * 非身份字段：PlanCard 措辞不构成动作身份，但它是「为什么做这个动作」的
   * 唯一可读来源 —— 没有它，模型只能在工具名和按钮文字之间猜。
   */
  purpose?: string[];
  planVersion?: number;
  successPredicate?: string;
  action: EdgeAction;
  slots: SlotSpec[];
  s: {
    selector?: string;
    semanticAnchor: SemanticAnchor;
  };
  r: TraceRisk;
  /** 保留为历史证据与离线回放，不参与 live edge 的执行许可。 */
  phiMinus: PhiRule[];
  /** 保留为历史证据与离线回放，不参与 live edge 的完成判定。 */
  phiPlus: PhiRule;
  semanticSplit?: {
    slowOnly: string[];
    replayable: string[];
  };
  provenance: {
    recordIds: string[];
    verifiedAt: number;
    siteKey: string;
    ttlMs: number;
  };
  status: 'verified' | 'blocked' | 'superseded';
}

export interface ControlEvidence {
  role: string;
  name: string;
  ref?: string;
  selector?: string;
  disabled?: boolean;
  urlPattern?: string;
  valuePresent?: boolean;
  checked?: boolean;
  expanded?: boolean;
  /** 仅当前观测用于 element_visible 求值，落盘前会剥离。 */
  visible?: boolean;
}

export interface Evidence {
  url: string;
  urlPattern: string;
  title: string;
  atomSignature: string;
  counters: Record<string, number>;
  controls: ControlEvidence[];
  dialog: string | null;
  fingerprint?: string;
  /**
   * 仅用于历史回放与诊断求值，绝不写进 TraceRecord。
   * 持久化层会把它剥掉，避免把用户输入或页面任务值写进 chrome.storage。
   */
  controlValues?: Record<string, string>;
  visibleText?: string;
}

export interface TraceRecord {
  id: string;
  seq: number;
  tool: string;
  argsRedacted: Record<string, unknown>;
  before: Evidence;
  after: Evidence;
  /** 执行通道：慢模型回合还是快路（边缘/委托）。用于统计快慢比例。 */
  lane?: 'fast' | 'slow';
  target?: {
    role?: string;
    name?: string;
    text?: string;
    selector?: string;
    urlPattern?: string;
    kind?: 'attribute' | 'content' | 'selector';
  };
  result: { ok: boolean; summary: string };
  planStep?: string;
  planVersion?: number;
  successPredicate?: string;
  verification?: string;
  risk?: string;
  ts: number;
}

export interface PatchEntry {
  id: string;
  ts: number;
  fields: Record<string, unknown>;
  accepted: boolean;
  rejectedFields: string[];
}

export interface TraceGraphV2 {
  version: 2;
  siteKey: string;
  updatedAt: number;
  ttlMs: number;
  l0: {
    states: StateTemplate[];
    operations: Operation[];
  };
  l1: {
    edges: Edge[];
  };
  records: TraceRecord[];
  patchLog: PatchEntry[];
}


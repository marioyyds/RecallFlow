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

export interface Edge {
  id: string;
  /** Version 3 uses semantic target identity; selectors are resolution hints. */
  identityVersion?: 3;
  from: string;
  to: string;
  g: string;
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
  target?: {
    role?: string;
    name?: string;
    text?: string;
    selector?: string;
    urlPattern?: string;
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


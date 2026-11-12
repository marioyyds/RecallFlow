// tracegraph.v2 持久化：按 siteKey 分槽、容量上限、脱敏与不可信输入校验。

import { siteKeyOf } from '../../shared/url.ts';
import { REPLAYABLE_TOOLS } from './macros.ts';
import {
  mergeEdges,
  extractAtoms,
  PHI_KINDS,
  urlPatternOf,
} from './trace-graph.ts';
import type {
  Evidence,
  PhiKind,
  TraceGraphV2,
  TraceRecord,
} from './trace-graph-types.ts';
import {
  TRACE_GRAPH_KEY,
  TRACE_GRAPH_TTL_MS,
} from './trace-graph-types.ts';

export { TRACE_GRAPH_KEY, TRACE_GRAPH_TTL_MS } from './trace-graph-types.ts';
const MAX_SITES = 12;
const MAX_RECORDS_PER_SITE = 80;
const MAX_EDGES_PER_SITE = 60;
let writeQueue: Promise<void> = Promise.resolve();
const SENSITIVE_PAGE =
  /(?:^|[/_.-])(?:login|log-in|signin|sign-in|auth|passport|checkout|payment|pay|bank|intranet|extranet)(?:[/_.-]|$)/i;

interface StorageLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
}

function storage(): StorageLike | null {
  const candidate = (globalThis as { chrome?: { storage?: { local?: StorageLike } } })
    .chrome?.storage?.local;
  return candidate || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseUrl(url: unknown): URL | null {
  try {
    const value = new URL(String(url || ''));
    return value;
  } catch {
    return null;
  }
}

export function traceGraphExcluded(url: unknown): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return true;
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) return true;
  return SENSITIVE_PAGE.test(parsed.pathname);
}

function sanitizedUrl(url: unknown): string {
  const parsed = parseUrl(url);
  if (!parsed) return '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function sanitizeControl(control: unknown): Evidence['controls'][number] | null {
  if (!isRecord(control)) return null;
  const role = String(control.role || '').slice(0, 80);
  const name = String(control.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!role && !name) return null;
  return {
    role,
    name,
    ...(typeof control.ref === 'string' ? { ref: control.ref.slice(0, 120) } : {}),
    ...(typeof control.selector === 'string' ? { selector: control.selector.slice(0, 500) } : {}),
    ...(typeof control.disabled === 'boolean' ? { disabled: control.disabled } : {}),
    ...(typeof control.urlPattern === 'string'
      ? { urlPattern: control.urlPattern.slice(0, 200) }
      : {}),
    ...(typeof control.valuePresent === 'boolean'
      ? { valuePresent: control.valuePresent }
      : {}),
    ...(typeof control.checked === 'boolean' ? { checked: control.checked } : {}),
    ...(typeof control.expanded === 'boolean' ? { expanded: control.expanded } : {}),
  };
}

/** 证据落盘前剥掉只允许用于本次 φ⁺ 的字段和任务值。 */
export function sanitizeEvidence(value: unknown): Evidence | null {
  if (!isRecord(value)) return null;
  const counters: Record<string, number> = {};
  if (isRecord(value.counters)) {
    for (const [counterKey, item] of Object.entries(value.counters)) {
      if (finiteNumber(item) && item >= 0) counters[String(counterKey).slice(0, 80)] = item;
    }
  }
  const controls = Array.isArray(value.controls)
    ? value.controls.map(sanitizeControl).filter(Boolean).slice(0, 120)
    : [];
  return {
    url: sanitizedUrl(value.url),
    urlPattern: String(value.urlPattern || '').slice(0, 500),
    title: String(value.title || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    atomSignature: String(value.atomSignature || '').slice(0, 1200),
    counters,
    controls: controls as Evidence['controls'],
    dialog:
      value.dialog === null
        ? null
        : String(value.dialog || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null,
    ...(typeof value.fingerprint === 'string'
      ? { fingerprint: value.fingerprint.slice(0, 200) }
      : {}),
  };
}

const SENSITIVE_ARG = /value|text|description|body|title|query|prompt|message|content|secret|token|password/i;

function sanitizeArgs(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (SENSITIVE_ARG.test(childKey)) {
      out[childKey] = '@' + childKey.replace(/[^a-zA-Z0-9_]/g, '');
    } else if (isRecord(child)) {
      out[childKey] = sanitizeArgs(child);
    } else if (Array.isArray(child)) {
      out[childKey] = child.map((item) =>
        isRecord(item) ? sanitizeArgs(item) : String(item).slice(0, 200)
      );
    } else if (typeof child === 'string') {
      out[childKey] = child.slice(0, 500);
    } else if (
      typeof child === 'number' ||
      typeof child === 'boolean' ||
      child === null
    ) {
      out[childKey] = child;
    }
  }
  return out;
}

const ANCHOR_KINDS = new Set(['attribute', 'content', 'selector']);

export function sanitizeTraceTarget(value: unknown): TraceRecord['target'] | undefined {
  if (!isRecord(value)) return undefined;
  const role = String(value.role || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const name = String(value.name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const text = String(value.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const selector = String(value.selector || '').trim().slice(0, 500);
  const urlPattern = String(value.urlPattern || '').trim().slice(0, 200);
  const kind = ANCHOR_KINDS.has(String(value.kind || ''))
    ? (String(value.kind) as 'attribute' | 'content' | 'selector')
    : undefined;
  const target: NonNullable<TraceRecord['target']> = {
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(text ? { text } : {}),
    ...(selector ? { selector } : {}),
    ...(urlPattern ? { urlPattern } : {}),
    ...(kind ? { kind } : {}),
  };
  return Object.keys(target).length ? target : undefined;
}

/** 写入型工具：它们的目标正文就是控件内容，写完即变，不能当锚点。 */
const WRITE_TOOLS = new Set(['type_text', 'select_option', 'check_box', 'press_key']);

/** 文本宿主：内容编辑区 / 预格式化块 / 文本输入框。 */
function isTextHost(element: Record<string, unknown> | null | undefined): boolean {
  if (!element) return false;
  const tag = String(element.tag || '').toLowerCase();
  const role = String(element.role || '').toLowerCase();
  const type = String(element.type || '').toLowerCase();
  if (tag === 'textarea' || tag === 'pre') return true;
  if (tag === 'input' && /^(|text|search|email|url|tel|number)$/.test(type)) return true;
  if (role === 'textbox' || role === 'searchbox') return true;
  return element.contentEditable === true || element.isContentEditable === true;
}

export function traceTargetFromTransition(
  args: Record<string, unknown>,
  beforeSnapshot: Parameters<typeof extractAtoms>[0],
  options: { tool?: string } = {}
): TraceRecord['target'] | undefined {
  const selector = String(args.selector || '').trim();
  const ref = String(args.ref || '').trim();
  const hint = String(args.text || args.name || args.label || '').trim();
  const elements = Array.isArray(beforeSnapshot?.elements)
    ? beforeSnapshot.elements
    : [];
  const element =
    (selector
      ? elements.find((item) => String(item.selector || '') === selector)
      : null) ||
    (ref
      ? elements.find((item) => String(item.ref || '') === ref)
      : null) ||
    (hint
      ? elements.find((item) =>
          [item.label, item.name, item.placeholder, (item as Record<string, unknown>).text]
            .some((value) => String(value || '').trim() === hint)
        )
      : null);
  const role = String(element?.role || element?.tag || '').replace(/\s+/g, ' ').trim();
  // 锚点来源决定它会不会漂移：
  //   · 写目标的 name 只能来自稳定属性（name / placeholder / aria-label）——CSDN 编辑器的
  //     label 就是正文，写完下一次必然 0 命中；
  //   · 普通点击目标的 label 通常是按钮文字，属于可复用语义，仍按 content 记录。
  const writeTarget = WRITE_TOOLS.has(String(options.tool || '')) || isTextHost(element);
  const attributeName = String(element?.name || element?.placeholder || '').trim();
  const contentName = String(
    element?.label || (element as Record<string, unknown> | null)?.text || hint || ''
  ).trim();
  const name = String(writeTarget ? attributeName : contentName || attributeName)
    .replace(/\s+/g, ' ')
    .trim();
  const kind: 'attribute' | 'content' | 'selector' = name
    ? writeTarget
      ? 'attribute'
      : 'content'
    : 'selector';
  const targetSelector = String(element?.selector || selector || '').trim();
  const urlPattern = typeof args.url === 'string' ? urlPatternOf(args.url) : '';
  return sanitizeTraceTarget({
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(targetSelector ? { selector: targetSelector } : {}),
    ...(urlPattern ? { urlPattern } : {}),
    kind,
  });
}

export function sanitizeTraceRecord(value: unknown): TraceRecord | null {
  if (!isRecord(value)) return null;
  const before = sanitizeEvidence(value.before);
  const after = sanitizeEvidence(value.after);
  const target = sanitizeTraceTarget(value.target);
  if (!before || !after) return null;
  const result = isRecord(value.result) ? value.result : {};
  return {
    id: String(value.id || '').slice(0, 120),
    seq: Math.max(0, Math.floor(Number(value.seq) || 0)),
    tool: String(value.tool || '').slice(0, 100),
    argsRedacted: sanitizeArgs(value.argsRedacted),
    before,
    after,
    ...(target ? { target } : {}),
    result: {
      ok: result.ok === true,
      summary: String(result.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    },
    ...(value.planStep ? { planStep: String(value.planStep).slice(0, 300) } : {}),
    ...(Number.isInteger(Number(value.planVersion))
      ? { planVersion: Math.floor(Number(value.planVersion)) }
      : {}),
    ...(value.successPredicate
      ? { successPredicate: String(value.successPredicate).slice(0, 500) }
      : {}),
    ...(value.verification
      ? { verification: String(value.verification).slice(0, 500) }
      : {}),
    ...(value.risk ? { risk: String(value.risk).slice(0, 40) } : {}),
    ...(value.lane === 'fast' || value.lane === 'slow' ? { lane: value.lane } : {}),
    ts: Math.max(0, Math.floor(Number(value.ts) || 0)),
  };
}

function graphShapeErrors(value: unknown): string[] {
  if (!isRecord(value)) return ['root'];
  const errors: string[] = [];
  const required = ['version', 'siteKey', 'updatedAt', 'ttlMs', 'l0', 'l1', 'records', 'patchLog'];
  for (const key of required) if (!(key in value)) errors.push(key);
  if (value.version !== 2) errors.push('version');
  if (typeof value.siteKey !== 'string' || !value.siteKey) errors.push('siteKey');
  if (!finiteNumber(value.updatedAt) || value.updatedAt < 0) errors.push('updatedAt');
  if (!finiteNumber(value.ttlMs) || value.ttlMs < 1) errors.push('ttlMs');
  if (!isRecord(value.l0) || !Array.isArray(value.l0.states) || !Array.isArray(value.l0.operations)) {
    errors.push('l0');
  }
  const l1 = isRecord(value.l1) ? value.l1 : null;
  if (!l1 || !Array.isArray(l1.edges)) errors.push('l1');
  if (!Array.isArray(value.records) || !Array.isArray(value.patchLog)) errors.push('records/patchLog');
  for (const [index, edge] of (Array.isArray(l1?.edges) ? l1.edges : []).entries()) {
    if (!isRecord(edge)) {
      errors.push('l1.edges.' + index);
      continue;
    }
    const invalidPhiMinus =
      !Array.isArray(edge.phiMinus) ||
      edge.phiMinus.some(
        (rule) =>
          !isRecord(rule) ||
          typeof rule.kind !== 'string' ||
          !PHI_KINDS.has(rule.kind as PhiKind) ||
          typeof rule.expr !== 'string' ||
          rule.source !== 'structured'
      );
    if (invalidPhiMinus) errors.push('l1.edges.' + index + '.phiMinus');
    if (
      !isRecord(edge.phiPlus) ||
      typeof edge.phiPlus.kind !== 'string' ||
      !PHI_KINDS.has(edge.phiPlus.kind as PhiKind) ||
      typeof edge.phiPlus.expr !== 'string' ||
      edge.phiPlus.source !== 'structured'
    ) {
      errors.push('l1.edges.' + index + '.phiPlus');
    }
    if (isRecord(edge.action) && isRecord(edge.action.argsTemplate)) {
      if (JSON.stringify(edge.action.argsTemplate).match(/recordedValue|defaultValue/i)) {
        errors.push('l1.edges.' + index + '.recordedValue');
      }
    }
  }
  return errors;
}

export function validateTraceGraph(value: unknown): { ok: boolean; errors: string[] } {
  const errors = graphShapeErrors(value);
  const records = isRecord(value) && Array.isArray(value.records) ? value.records : [];
  if (records.some((record) => !sanitizeTraceRecord(record))) errors.push('records');
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function emptyTraceGraph(
  siteKey: string,
  createdAt = Date.now(),
  defaultTtlMs = TRACE_GRAPH_TTL_MS
): TraceGraphV2 {
  return {
    version: 2,
    siteKey,
    updatedAt: createdAt,
    ttlMs: defaultTtlMs,
    l0: { states: [], operations: [] },
    l1: { edges: [] },
    records: [],
    patchLog: [],
  };
}

async function readAll(): Promise<Record<string, TraceGraphV2>> {
  const adapter = storage();
  if (!adapter) return {};
  try {
    const data = await adapter.get(TRACE_GRAPH_KEY);
    const value = data?.[TRACE_GRAPH_KEY];
    if (!isRecord(value)) return {};
    const out: Record<string, TraceGraphV2> = {};
    for (const [originKey, storedGraph] of Object.entries(value)) {
      if (!validateTraceGraph(storedGraph).ok) continue;
      const graph = structuredClone(storedGraph) as TraceGraphV2;
      const edgeRecords = graph.records.filter((record) => REPLAYABLE_TOOLS.has(record.tool));
      const merged = mergeEdges(edgeRecords, graph);
      graph.l0 = merged.l0;
      graph.l1 = merged.l1;
      out[originKey] = graph;
    }
    return out;
  } catch {
    return {};
  }
}

async function writeAll(all: Record<string, TraceGraphV2>): Promise<void> {
  const adapter = storage();
  if (!adapter) return;
  await adapter.set({ [TRACE_GRAPH_KEY]: all });
}

function enqueueTraceGraphWrite<T>(operation: () => Promise<T>): Promise<T> {
  const task = writeQueue.then(operation);
  writeQueue = task.then(() => undefined, () => undefined);
  return task;
}

/**
 * Rebuild every stored site graph from its retained records. The read path
 * already normalizes identities in memory; this persists the migration so the
 * settings viewer and later runs see the same edge set.
 */
export async function rebuildStoredTraceGraphs(): Promise<{
  sites: number;
  edges: number;
  records: number;
}> {
  const all = await readAll();
  await writeAll(all);
  return {
    sites: Object.keys(all).length,
    edges: Object.values(all).reduce((sum, graph) => sum + graph.l1.edges.length, 0),
    records: Object.values(all).reduce((sum, graph) => sum + graph.records.length, 0),
  };
}

export async function loadTraceGraph(
  url: string,
  _options: { now?: number } = {}
): Promise<TraceGraphV2 | null> {
  if (traceGraphExcluded(url)) return null;
  const siteKey = siteKeyOf(url);
  if (!siteKey) return null;
  const all = await readAll();
  const graph = all[siteKey];
  if (!graph) return null;
  return graph;
}

export async function deleteStoredTraceGraph(siteKey: string): Promise<boolean> {
  return enqueueTraceGraphWrite(async () => {
    const all = await readAll();
    if (!Object.prototype.hasOwnProperty.call(all, siteKey)) return false;
    delete all[siteKey];
    await writeAll(all);
    return true;
  });
}

export async function deleteStoredTraceGraphSelection(
  siteKey: string,
  selection: { edgeIds?: string[]; stateNames?: string[] }
): Promise<{
  found: boolean;
  removedEdges: number;
  removedRecords: number;
  removedStates: number;
}> {
  return enqueueTraceGraphWrite(async () => {
    const all = await readAll();
    const graph = all[siteKey];
    if (!graph) {
      return { found: false, removedEdges: 0, removedRecords: 0, removedStates: 0 };
    }
    const edgeIds = new Set(
      (Array.isArray(selection.edgeIds) ? selection.edgeIds : [])
        .map(String)
        .filter(Boolean)
    );
    const stateNames = new Set(
      (Array.isArray(selection.stateNames) ? selection.stateNames : [])
        .map(String)
        .filter(Boolean)
    );
    const removedEdges = graph.l1.edges.filter((edge) =>
      edgeIds.has(edge.id) || stateNames.has(edge.from) || stateNames.has(edge.to)
    );
    const removedRecordIds = new Set(
      removedEdges.flatMap((edge) => edge.provenance.recordIds)
    );
    const removedStates = graph.l0.states.filter((state) =>
      stateNames.has(state.name)
    ).length;
    if (!removedEdges.length && !removedStates) {
      return { found: true, removedEdges: 0, removedRecords: 0, removedStates: 0 };
    }
    graph.records = graph.records.filter(
      (record) => !removedRecordIds.has(record.id)
    );
    graph.l1.edges = graph.l1.edges.filter(
      (edge) => !removedEdges.some((removed) => removed.id === edge.id)
    );
    graph.l0.states = graph.l0.states.filter(
      (state) => !stateNames.has(state.name)
    );
    graph.l0.operations = graph.l0.operations.filter((operation) =>
      graph.l1.edges.some(
        (edge) =>
          edge.from === operation.srcState &&
          edge.to === operation.dstState &&
          edge.action.tool === operation.name
      )
    );
    graph.updatedAt = Date.now();
    await writeAll(all);
    return {
      found: true,
      removedEdges: removedEdges.length,
      removedRecords: removedRecordIds.size,
      removedStates,
    };
  });
}

export async function saveTraceGraph(graph: TraceGraphV2): Promise<boolean> {
  const next = structuredClone(graph);
  next.records = next.records
    .map(sanitizeTraceRecord)
    .filter((item): item is TraceRecord => Boolean(item));
  const validation = validateTraceGraph(next);
  if (!validation.ok) return false;
  const all = await readAll();
  all[next.siteKey] = next;
  all[next.siteKey].records = next.records.slice(-MAX_RECORDS_PER_SITE);
  all[next.siteKey].l1.edges = next.l1.edges.slice(-MAX_EDGES_PER_SITE);
  const sites = Object.entries(all)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_SITES);
  await writeAll(Object.fromEntries(sites));
  return true;
}

async function appendTraceRecordNow(
  url: string,
  record: TraceRecord,
  options: { now?: number; ttlMs?: number } = {}
): Promise<TraceGraphV2 | null> {
  // 按**动作发生前**的页面归桶：跨站跳转（mp 成功页 → blog 文章页）时，
  // ctx.pageUrl 可能已经切到新站，用它会把这条件记进错误的站点槽位，
  // 边也会落在别的站的候选查询里查不到或查错。
  const siteUrl = String(record.before?.url || url || '');
  if (traceGraphExcluded(siteUrl) || traceGraphExcluded(url) || !record.result.ok) return null;
  const clean = sanitizeTraceRecord(record);
  if (!clean || !clean.id || !clean.tool) return null;
  const siteKey = siteKeyOf(siteUrl) || siteKeyOf(url);
  if (!siteKey) return null;
  const recordedAt = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const recordedTtlMs =
    Number.isFinite(Number(options.ttlMs)) && Number(options.ttlMs) > 0
      ? Math.floor(Number(options.ttlMs))
      : TRACE_GRAPH_TTL_MS;
  const loaded = await loadTraceGraph(siteUrl, { now: recordedAt });
  const graph = loaded || emptyTraceGraph(siteKey, recordedAt, recordedTtlMs);
  graph.ttlMs = recordedTtlMs;
  graph.records = [
    ...graph.records.filter((item) => item.id !== clean.id),
    clean,
  ].slice(-MAX_RECORDS_PER_SITE);
  // 原始证据可以包含读取类工具，但只有可重放动作才能成为 L1 证据边。
  const edgeRecords = graph.records.filter((item) => REPLAYABLE_TOOLS.has(item.tool));
  const merged = mergeEdges(edgeRecords, graph);
  for (const edge of merged.l1.edges) {
    edge.provenance.siteKey = graph.siteKey;
    edge.provenance.ttlMs = recordedTtlMs;
  }
  graph.l0 = merged.l0;
  graph.l1 = merged.l1;
  graph.updatedAt = recordedAt;
  return (await saveTraceGraph(graph)) ? graph : null;
}

/**
 * 录制调用来自旁路 fire-and-forget；用单队列串行化 read-modify-write，
 * 否则同一任务的连续动作可能互相覆盖。
 */
export function appendTraceRecord(
  url: string,
  record: TraceRecord,
  options: { now?: number; ttlMs?: number } = {}
): Promise<TraceGraphV2 | null> {
  return enqueueTraceGraphWrite(() =>
    appendTraceRecordNow(url, record, options)
  );
}

/**
 * 从一次真实前后快照生成不可变录制。只在新录制开关开启时由 tools 调用。
 */
export function traceRecordFromTransition(input: {
  id: string;
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  beforeSnapshot: Parameters<typeof extractAtoms>[0];
  afterSnapshot: Parameters<typeof extractAtoms>[0];
  result: { ok: boolean; summary: string };
  planStep?: string;
  planVersion?: number;
  successPredicate?: string;
  verification?: string;
  risk?: string;
  lane?: 'fast' | 'slow';
  now?: number;
}): TraceRecord {
  const beforeAtoms = extractAtoms(input.beforeSnapshot);
  const afterAtoms = extractAtoms(input.afterSnapshot);
  const target = traceTargetFromTransition(input.args, input.beforeSnapshot, { tool: input.tool });
  const before: Evidence = {
    url: String(input.beforeSnapshot?.url || ''),
    urlPattern: beforeAtoms.urlPattern,
    title: String(input.beforeSnapshot?.title || ''),
    atomSignature: beforeAtoms.atomSignature,
    counters: beforeAtoms.counters,
    controls: beforeAtoms.controls,
    dialog: beforeAtoms.dialog,
    ...(input.beforeSnapshot?.fingerprint
      ? { fingerprint: String(input.beforeSnapshot.fingerprint) }
      : {}),
  };
  const after: Evidence = {
    url: String(input.afterSnapshot?.url || ''),
    urlPattern: afterAtoms.urlPattern,
    title: String(input.afterSnapshot?.title || ''),
    atomSignature: afterAtoms.atomSignature,
    counters: afterAtoms.counters,
    controls: afterAtoms.controls,
    dialog: afterAtoms.dialog,
    ...(input.afterSnapshot?.fingerprint
      ? { fingerprint: String(input.afterSnapshot.fingerprint) }
      : {}),
  };
  return {
    id: input.id,
    seq: Math.max(0, Math.floor(input.seq)),
    tool: input.tool,
    argsRedacted: sanitizeArgs(input.args),
    before,
    after,
    ...(target ? { target } : {}),
    result: input.result,
    ...(input.planStep ? { planStep: input.planStep } : {}),
    ...(input.planVersion !== undefined ? { planVersion: input.planVersion } : {}),
    ...(input.successPredicate ? { successPredicate: input.successPredicate } : {}),
    ...(input.verification ? { verification: input.verification } : {}),
    ...(input.risk ? { risk: input.risk } : {}),
    ...(input.lane === 'fast' || input.lane === 'slow' ? { lane: input.lane } : {}),
    ts: Number(input.now) || Date.now(),
  };
}

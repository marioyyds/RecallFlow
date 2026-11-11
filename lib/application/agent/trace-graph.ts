// tracegraph.v2 的纯函数内核：状态抽象、构图、提名与确定性守卫。
//
// 纪律：
//   - 状态键只含语义模板和 atom 类型；控件值、实例数、selector、ref、瞬时弹窗
//     与整页 fingerprint 都不参与 atomSignature。
//   - 图只提名，置信度永不授权执行。
//   - 未显式绑定的槽位 fail-closed；禁止回填历史值或默认偏好。

import type { PageSnapshotLike, SnapshotElementLike } from './types.ts';
import type {
  ControlEvidence,
  Edge,
  Evidence,
  PhiKind,
  PhiRule,
  SemanticAnchor,
  SlotSpec,
  StateTemplate,
  TraceGraphV2,
  TraceRecord,
} from './trace-graph-types.ts';

export const TRACE_GRAPH_VERSION = 2;
export const EDGE_IDENTITY_VERSION = 4;
export const MAX_EDGE_CANDIDATES = 3;

export const PHI_KINDS: ReadonlySet<PhiKind> = new Set([
  'url_pattern',
  'counter',
  'value_equals',
  'element_present',
  'element_visible',
  'no_dialog',
  'not_satisfied',
  'text_contains',
  'diff_exists',
]);

const COUNTER_PATTERN = /(?:^|[\s(（])([^\s:：/]{1,40})\s*[:：]?\s*(\d+)\s*\/\s*(\d+)/g;
const DYNAMIC_NAME = /(?:value|length|count|commit|list|items?|diff|result|preview)/i;

function stableHash(value: unknown): string {
  const text = JSON.stringify(value);
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a ^= code;
    a = Math.imul(a, 0x01000193);
    b ^= code + index;
    b = Math.imul(b, 0x85ebca6b);
  }
  return (a >>> 0).toString(16).padStart(8, '0') +
    (b >>> 0).toString(16).padStart(8, '0');
}

function clip(value: unknown, max: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function elementName(element: SnapshotElementLike): string {
  return clip(
    element.label ||
      element.name ||
      element.placeholder ||
      element.href ||
      element.ref ||
      '',
    120
  );
}

function atomName(element: SnapshotElementLike): string {
  const tag = clip(element.tag || 'element', 32).toLowerCase();
  const role = clip(element.role || '', 32).toLowerCase();
  const type = clip(element.type || '', 32).toLowerCase();
  return [tag, role, type].filter(Boolean).join(':');
}

export function traceGraphStateName(url: string, pageTitle = ''): string {
  let path = '';
  let host = '';
  try {
    const parsed = new URL(url);
    path = parsed.pathname;
    host = parsed.hostname + (parsed.port ? ':' + parsed.port : '');
  } catch {
    path = String(url || '');
  }
  if (/\/pull\/new\/?$/.test(path)) return 'BranchComparePage';
  if (/\/pull\/compare\/?$/.test(path)) return 'PRFormPage';
  if (/\/pull\/\d+\/?$/.test(path)) return 'PRDetailPage';
  if (
    host === 'localhost:9999' ||
    /(?:^|\.)reddit\.com$/i.test(host)
  ) {
    if (path === '/' || path === '') return 'ForumHomePage';
    if (/^\/forums\/?$/.test(path)) return 'ForumListPage';
    if (/^\/f\/[^/]+\/new\/?$/.test(path)) return 'ForumNewPostPage';
    if (/^\/f\/[^/]+\/?$/.test(path)) return 'ForumPage';
    if (/^\/f\/[^/]+\/\d+(?:\/[^/]*)?\/?$/.test(path)) return 'SubmissionPage';
    if (/^\/user\/[^/]+\/comments\/?$/.test(path)) return 'UserCommentsPage';
    if (/^\/user\/[^/]+\/submissions\/?$/.test(path)) return 'UserSubmissionsPage';
    if (/^\/user\/[^/]+\/?$/.test(path)) return 'UserProfilePage';
    if (/^\/search\/?$/.test(path) || /^\/search\?/.test(path)) return 'SearchPage';
    if (/^\/submit\/?$/.test(path)) return 'SubmitPage';
  }
  if (/\.html\/?$/i.test(path)) {
    return host === 'localhost:7780' ? 'AdminProductPage' : 'ProductPage';
  }
  if (/^\/catalogsearch\/result\/?$/.test(path)) return 'SearchResultsPage';
  if (/^\/checkout\/cart\/?$/.test(path)) return 'CartPage';
  if (/^\/customer\/account(?:\/|$)/.test(path)) return 'AccountPage';
  if (/^\/catalog\/category\/view(?:\/|$)/.test(path)) return 'CategoryPage';
  if (/^\/sales\/order(?:\/|$)/.test(path)) return 'OrdersPage';
  if (/\.html\/?$/i.test(path)) return 'ProductPage';
  if (path === '/' || path === '') return 'HomePage';
  const segment = path.split('/').filter(Boolean).at(-1);
  const base = segment || pageTitle || 'Page';
  const name = base
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\s+/g, '');
  return (name || 'Page').slice(0, 48) + 'Page';
}

export function urlPatternOf(url: unknown): string {
  try {
    const parsed = new URL(String(url || ''));
    const rawPath = parsed.pathname;
    if (/\.html$/i.test(rawPath)) return '/*.html';
    if (/^\/f\/[^/]+\/new\/?$/.test(rawPath)) return '/f/*/new';
    if (/^\/f\/[^/]+\/\d+(?:\/[^/]*)?\/?$/.test(rawPath)) {
      return '/f/*/<n>/*';
    }
    if (/^\/user\/[^/]+\/comments\/?$/.test(rawPath)) return '/user/*/comments';
    if (/^\/user\/[^/]+\/submissions\/?$/.test(rawPath)) return '/user/*/submissions';
    if (/^\/user\/[^/]+\/?$/.test(rawPath)) return '/user/*';
    if (/^\/f\/[^/]+\/?$/.test(rawPath)) return '/f/*';
    return rawPath
      .replace(/\/\d+(?=\/|$)/g, '/<n>')
      .replace(/\/pull\/new\/?$/, '/pull/new')
      .replace(/\/pull\/compare\/?$/, '/pull/compare');
  } catch {
    return '';
  }
}

/** 从页面正文提取 `2078/65535` 这类结构化计数；值不参与状态键。 */
export function extractCounterEvidence(
  text: unknown,
  capabilities?: PageSnapshotLike['capabilities']
): Record<string, number> {
  const out: Record<string, number> = {};
  const source = String(text || '');
  for (const match of source.matchAll(COUNTER_PATTERN)) {
    const rawName = String(match[1] || '').trim();
    const name = rawName.replace(/[^\p{L}\p{N}_-]+/gu, '').toLowerCase();
    const current = Number(match[2]);
    if (!name || !Number.isFinite(current) || current < 0) continue;
    out[name] = current;
    out[name + 'Max'] = Number(match[3]);
  }
  for (const [bucket, raw] of Object.entries(capabilities || {})) {
    const count = Number(raw?.count);
    if (Number.isFinite(count) && count >= 0) out[bucket + 'Count'] = count;
  }
  return out;
}

export function extractAtoms(snapshot: PageSnapshotLike | null | undefined): {
  staticAtoms: string[];
  dynamicAtoms: string[];
  stateName: string;
  counters: Record<string, number>;
  dialog: string | null;
  controls: ControlEvidence[];
  visibleText: string;
  atomSignature: string;
  urlPattern: string;
} {
  const url = String(snapshot?.url || '');
  const title = String(snapshot?.title || '');
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const staticAtoms = new Set<string>();
  const dynamicAtoms = new Set<string>();
  const controls: ControlEvidence[] = [];
  for (const element of elements) {
    if (element.disabled !== true) {
      const atom = atomName(element);
      if (atom) staticAtoms.add(atom);
      // 列表实例数、字段当前值、selector 与 ref 永远不能进状态键。
      for (const key of ['checked', 'expanded', 'selectedIndex', 'selectedLabel']) {
        if (element[key] !== undefined && element[key] !== null && element[key] !== '') {
          dynamicAtoms.add(atom + ':' + key);
        }
      }
    }
    const name = elementName(element);
    if (name) {
      controls.push({
        role: clip(element.role || element.tag || '', 80),
        name,
        ...(element.ref ? { ref: clip(element.ref, 120) } : {}),
        ...(element.selector ? { selector: clip(element.selector, 500) } : {}),
        ...(element.disabled === true ? { disabled: true } : {}),
        ...(element.href ? { urlPattern: urlPatternOf(element.href) } : {}),
        ...(element.valuePresent !== undefined
          ? { valuePresent: element.valuePresent === true }
          : {}),
        ...(typeof element.checked === 'boolean' ? { checked: element.checked } : {}),
        ...(typeof element.expanded === 'boolean' ? { expanded: element.expanded } : {}),
        visible: element.inViewport !== false,
      });
    }
  }
  for (const bucket of Object.keys(snapshot?.capabilities || {})) {
    staticAtoms.add('capability:' + bucket);
  }
  const stateName = traceGraphStateName(url, title);
  const staticList = [...staticAtoms].sort();
  const dynamicList = [...dynamicAtoms].sort();
  const state = { name: stateName, staticAtoms: staticList, dynamicAtoms: dynamicList };
  const visibleText = String(
    snapshot?.text ||
      snapshot?.mainContent?.note ||
      ''
  ).slice(0, 12000);
  const counters = {
    ...extractCounterEvidence(visibleText, snapshot?.capabilities),
    ...((snapshot as { counters?: Record<string, number> })?.counters || {}),
  };
  const runtime = snapshot?.runtime as
    | { dialog?: unknown; pendingDialog?: unknown }
    | null
    | undefined;
  const dialogValue = runtime?.dialog ?? runtime?.pendingDialog;
  return {
    staticAtoms: staticList,
    dynamicAtoms: dynamicList,
    stateName,
    counters,
    dialog: typeof dialogValue === 'string' ? dialogValue : null,
    controls,
    visibleText,
    atomSignature: atomSignature(state),
    urlPattern: urlPatternOf(url),
  };
}

export function atomSignature(
  state: Pick<StateTemplate, 'name' | 'staticAtoms' | 'dynamicAtoms'>
): string {
  return [
    state.name,
    [...new Set(state.staticAtoms)].sort().join('+'),
    [...new Set(state.dynamicAtoms)].sort().join('+'),
  ].join('#');
}

export function evidenceFromSnapshot(
  snapshot: PageSnapshotLike | null | undefined
): Evidence {
  const atoms = extractAtoms(snapshot);
  return {
    url: String(snapshot?.url || ''),
    urlPattern: atoms.urlPattern,
    title: String(snapshot?.title || ''),
    atomSignature: atoms.atomSignature,
    counters: atoms.counters,
    controls: atoms.controls,
    dialog: atoms.dialog,
    ...(snapshot?.fingerprint ? { fingerprint: String(snapshot.fingerprint) } : {}),
    visibleText: atoms.visibleText,
  };
}

function placeholderFields(args: Record<string, unknown>): {
  template: Record<string, unknown>;
  slots: SlotSpec[];
} {
  const slots: SlotSpec[] = [];
  const visit = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, key + index));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
          childKey,
          visit(child, childKey),
        ])
      );
    }
    if (
      /value|text|url|title|description|branch|target|query|label/i.test(key) &&
      typeof value === 'string' &&
      value.trim()
    ) {
      const name = key.replace(/[^a-zA-Z0-9_]+/g, '') || 'value';
      if (!slots.some((slot) => slot.name === name)) {
        slots.push({
          name,
          type: /description|body|markdown/i.test(key) ? 'markdown' : 'string',
          source: 'current_instruction',
          highRisk: /amount|qty|quantity|recipient|date|price/i.test(key),
        });
      }
      return '@' + name;
    }
    return value;
  };
  return { template: visit(args, 'args') as Record<string, unknown>, slots };
}

function structuredPhiFromTransition(
  before: Evidence,
  after: Evidence,
  tool: string
): PhiRule {
  if (before.url !== after.url) {
    return {
      kind: 'url_pattern',
      expr: after.urlPattern || after.url,
      observed: after.urlPattern || after.url,
      source: 'structured',
    };
  }
  const changedCounter = Object.keys(after.counters).find(
    (key) => before.counters[key] !== after.counters[key]
  );
  if (changedCounter) {
    return {
      kind: 'counter',
      expr: changedCounter + ' == ' + after.counters[changedCounter],
      observed: changedCounter + '=' + after.counters[changedCounter],
      source: 'structured',
    };
  }
  const changedControl = after.controls.find((control, index) => {
    const prev = before.controls[index];
    return (
      !prev ||
      prev.valuePresent !== control.valuePresent ||
      prev.checked !== control.checked ||
      prev.expanded !== control.expanded
    );
  });
  if (changedControl) {
    const name = (changedControl.name || changedControl.role).replace(/["\\]/g, '');
    return {
      kind: 'value_equals',
      expr: 'controls["' + name + '"].valuePresent == true',
      observed: name,
      source: 'structured',
    };
  }
  return {
    kind: /click|type|select|check/i.test(tool) ? 'diff_exists' : 'text_contains',
    expr: tool,
    observed: before.fingerprint && after.fingerprint ? after.fingerprint : '',
    source: 'structured',
  };
}

function edgeForRecord(record: TraceRecord, siteKey: string, ttlMs: number): Edge | null {
  if (!record.result.ok || !record.verification) return null;
  const args = placeholderFields(record.argsRedacted || {});
  const actionTool = String(record.tool || '');
  if (!actionTool) return null;
  const risk = record.risk === 'high' || record.risk === 'medium' ? record.risk : 'low';
  const from = traceGraphStateName(record.before.url, record.before.title);
  const to = traceGraphStateName(record.after.url, record.after.title);
  const target = record.target || {};
  const semanticAnchor: SemanticAnchor = {
    ...(target.role ? { role: target.role } : {}),
    ...(target.name ? { name: target.name } : {}),
    ...(target.text ? { text: target.text } : {}),
    ...(target.urlPattern ? { urlPattern: target.urlPattern } : {}),
  };
  const targetLabel =
    semanticAnchor.name ||
    semanticAnchor.text ||
    semanticAnchor.urlPattern ||
    semanticAnchor.role ||
    '';
  const actionGoal = clip(
    [actionTool, targetLabel ? '「' + targetLabel + '」' : ''].filter(Boolean).join(' '),
    160
  );
  // PlanCard wording is execution context, not action identity.
  const g = actionGoal;
  const phiPlus = structuredPhiFromTransition(record.before, record.after, actionTool);
  const targetIdentity = target.name || target.text || target.urlPattern
    ? {
        role: target.role || '',
        name: target.name || '',
        text: target.text || '',
        urlPattern: target.urlPattern || '',
      }
    : {
        role: target.role || '',
        selector:
          target.selector ||
          (typeof record.argsRedacted.selector === 'string'
            ? record.argsRedacted.selector
            : ''),
      };
  const id = 'e.' + stableHash({
    identityVersion: EDGE_IDENTITY_VERSION,
    from,
    to,
    tool: actionTool,
    target: targetIdentity,
  });
  return {
    id,
    identityVersion: EDGE_IDENTITY_VERSION,
    from,
    to,
    g,
    ...(record.planVersion !== undefined ? { planVersion: record.planVersion } : {}),
    ...(record.successPredicate ? { successPredicate: record.successPredicate } : {}),
    action: { tool: actionTool, argsTemplate: args.template, risk },
    slots: args.slots,
    s: {
      ...(target.selector || typeof record.argsRedacted.selector === 'string'
        ? { selector: target.selector || String(record.argsRedacted.selector) }
        : {}),
      semanticAnchor,
    },
    r: risk,
    phiMinus: [
      {
        kind: 'url_pattern',
        expr: record.before.urlPattern,
        source: 'structured',
      },
      { kind: 'no_dialog', expr: 'dialog == null', source: 'structured' },
    ],
    phiPlus,
    provenance: {
      recordIds: [record.id],
      verifiedAt: record.ts,
      siteKey,
      ttlMs,
    },
    status: 'verified',
  };
}

export function mergeEdges(
  records: TraceRecord[],
  prev?: TraceGraphV2
): { l0: TraceGraphV2['l0']; l1: TraceGraphV2['l1'] } {
  const states = new Map<string, StateTemplate>();
  const edges = new Map<string, Edge>();
  for (const state of prev?.l0?.states || []) states.set(state.name, state);
  // Legacy identities mixed plan prose and page-wide anchors into the edge ID.
  // Retain only v2 identities; older edges are re-derived from retained records.
  for (const edge of prev?.l1?.edges || []) {
    if (edge.identityVersion === EDGE_IDENTITY_VERSION) edges.set(edge.id, edge);
  }

  for (const record of records) {
    const beforeAtoms = extractAtoms({
      url: record.before.url,
      title: record.before.title,
      text: '',
      elements: record.before.controls.map((control) => ({
        tag: control.role,
        role: control.role,
        label: control.name,
      })),
      capabilities: {},
    });
    const afterAtoms = extractAtoms({
      url: record.after.url,
      title: record.after.title,
      text: '',
      elements: record.after.controls.map((control) => ({
        tag: control.role,
        role: control.role,
        label: control.name,
      })),
      capabilities: {},
    });
    const beforeName = traceGraphStateName(record.before.url, record.before.title);
    const afterName = traceGraphStateName(record.after.url, record.after.title);
    const beforeKey = beforeName;
    const existingBefore = states.get(beforeKey);
    if (existingBefore) {
      existingBefore.staticAtoms = [
        ...new Set([...existingBefore.staticAtoms, ...beforeAtoms.staticAtoms]),
      ].sort();
      existingBefore.dynamicAtoms = [
        ...new Set([...existingBefore.dynamicAtoms, ...beforeAtoms.dynamicAtoms]),
      ].sort();
    } else {
      states.set(beforeKey, {
        id: 's.' + stableHash(beforeKey),
        name: beforeName,
        urlPattern: record.before.urlPattern,
        staticAtoms: beforeAtoms.staticAtoms,
        dynamicAtoms: beforeAtoms.dynamicAtoms,
        ...(record.before.fingerprint ? { fingerprint: record.before.fingerprint } : {}),
      });
    }
    const existingAfter = states.get(afterName);
    if (existingAfter) {
      existingAfter.staticAtoms = [
        ...new Set([...existingAfter.staticAtoms, ...afterAtoms.staticAtoms]),
      ].sort();
      existingAfter.dynamicAtoms = [
        ...new Set([...existingAfter.dynamicAtoms, ...afterAtoms.dynamicAtoms]),
      ].sort();
    } else {
      states.set(afterName, {
        id: 's.' + stableHash(afterName),
        name: afterName,
        urlPattern: record.after.urlPattern,
        staticAtoms: afterAtoms.staticAtoms,
        dynamicAtoms: afterAtoms.dynamicAtoms,
        ...(record.after.fingerprint ? { fingerprint: record.after.fingerprint } : {}),
      });
    }
    let recordSiteKey = '';
    try {
      recordSiteKey = new URL(record.before.url).origin;
    } catch {}
    const edge = edgeForRecord(record, recordSiteKey, 30 * 60 * 1000);
    if (!edge) continue;
    const prevEdge = edges.get(edge.id);
    if (prevEdge) {
      edge.provenance.recordIds = [
        ...new Set([...prevEdge.provenance.recordIds, ...edge.provenance.recordIds]),
      ];
      edge.provenance.verifiedAt = Math.max(
        prevEdge.provenance.verifiedAt,
        edge.provenance.verifiedAt
      );
      edge.s.semanticAnchor = {
        ...edge.s.semanticAnchor,
        ...prevEdge.s.semanticAnchor,
      };
    }
    edges.set(edge.id, edge);
  }
  const operations = new Map<string, TraceGraphV2['l0']['operations'][number]>();
  for (const edge of edges.values()) {
    const opId = 'op.' + stableHash({ edge: edge.id, tool: edge.action.tool });
    operations.set(opId, {
      id: opId,
      name: edge.action.tool,
      description: edge.g,
      srcState: edge.from,
      dstState: edge.to,
      inputSlots: edge.slots.map((slot) => '@' + slot.name),
      semanticAnchor: edge.s.semanticAnchor,
      ...(edge.s.selector ? { selectorHint: edge.s.selector } : {}),
      patchable: true,
    });
  }
  return {
    l0: { states: [...states.values()], operations: [...operations.values()] },
    l1: { edges: [...edges.values()] },
  };
}

/**
 * 只读取当前指令里显式写出的 typed slots：
 *   @title="..."
 *   slots: {"title":"..."}
 * 或围栏 JSON 中的 `slots` 对象。绝不从自然语言历史值里猜。
 */
export function extractExplicitSlots(instruction: unknown): Record<string, unknown> {
  const text = String(instruction || '');
  const out: Record<string, unknown> = {};
  const lineRe = /^\s*@([\p{L}\p{N}_-]+)\s*=\s*(.+?)\s*$/gmu;
  for (const match of text.matchAll(lineRe)) {
    let value = String(match[2] || '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[match[1]] = value;
  }
  const candidates = [text];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.includes('slots')) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        slots?: unknown;
      };
      if (
        parsed?.slots &&
        typeof parsed.slots === 'object' &&
        !Array.isArray(parsed.slots)
      ) {
        for (const [name, value] of Object.entries(parsed.slots)) {
          if (value !== undefined && value !== null) out[name] = value;
        }
      }
    } catch {}
  }
  return out;
}

function terms(value: unknown): string[] {
  const text = String(value || '').toLowerCase();
  const out = new Set(
    text
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((term) => term.length > 1)
  );
  for (const run of text.matchAll(/[\u3400-\u9fff]+/gu)) {
    const chars = Array.from(run[0]);
    for (let index = 0; index < chars.length - 1; index += 1) {
      out.add(chars[index] + chars[index + 1]);
    }
  }
  return [...out];
}

export function nominate(
  graph: TraceGraphV2,
  ctx: {
    siteKey: string;
    atomSignature: string;
    intent: string;
    blockedEdgeIds: Set<string>;
    executedEdges: Set<string>;
    controlNames?: string[];
  }
): Edge[] {
  if (!graph || graph.siteKey !== ctx.siteKey) return [];
  const stateName = String(ctx.atomSignature || '').split('#')[0];
  const intentTerms = new Set(terms(ctx.intent));
  const controlTerms = new Set(
    (ctx.controlNames || []).flatMap((name) => terms(name))
  );
  return graph.l1.edges
    .filter((edge) =>
      edge.status === 'verified' &&
      edge.from === stateName &&
      !ctx.blockedEdgeIds.has(edge.id) &&
      !ctx.executedEdges.has(edge.id)
    )
    .map((edge) => {
      const gTerms = terms(
        [
          edge.g,
          edge.successPredicate,
          edge.s.semanticAnchor.name,
          edge.s.semanticAnchor.text,
          edge.s.semanticAnchor.urlPattern,
          edge.action.tool,
        ].filter(Boolean).join(' ')
      );
      const overlap = gTerms.filter((term) => intentTerms.has(term)).length;
      const controlOverlap = gTerms.filter((term) => controlTerms.has(term)).length;
      return {
        edge,
        score:
          overlap * 100 +
          controlOverlap * 25 +
          (edge.from === stateName ? 10 : 0),
      };
    })
    .sort((a, b) => b.score - a.score || a.edge.id.localeCompare(b.edge.id))
    .slice(0, MAX_EDGE_CANDIDATES)
    .map((entry) => entry.edge);
}

type ExprValue = string | number | boolean | null | undefined;

function resolveVariable(name: string, obs: Evidence, bound: Record<string, unknown>): ExprValue {
  const clean = name.trim();
  if (clean.startsWith('@')) {
    const slot = clean.slice(1);
    if (!Object.prototype.hasOwnProperty.call(bound, slot)) return undefined;
    return bound[slot] as ExprValue;
  }
  if (clean === 'dialog') return obs.dialog;
  if (clean === 'url') return obs.url;
  if (clean === 'urlPattern') return obs.urlPattern;
  if (clean === 'title') return obs.title;
  if (Object.prototype.hasOwnProperty.call(obs.counters, clean)) return obs.counters[clean];
  const controlMatch = /^controls\["((?:\\.|[^"])*)"\]\.(valuePresent|checked|expanded|visible)$/.exec(clean);
  if (controlMatch) {
    const target = obs.controls.find(
      (control) => control.name === controlMatch[1].replace(/\\"/g, '"')
    );
    return target?.[controlMatch[2] as 'valuePresent' | 'checked' | 'expanded' | 'visible'];
  }
  return undefined;
}

function scalarExpr(expr: string, obs: Evidence, bound: Record<string, unknown>): ExprValue {
  const text = expr.trim();
  const len = /^len\(\s*@([\p{L}\p{N}_-]+)\s*\)$/u.exec(text);
  if (len) {
    const value = bound[len[1]];
    return typeof value === 'string' || Array.isArray(value) ? value.length : undefined;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^["'].*["']$/.test(text)) return text.slice(1, -1);
  return resolveVariable(text, obs, bound);
}

function compareExpression(
  expr: string,
  obs: Evidence,
  bound: Record<string, unknown>
): boolean | null {
  const match = /^(.+?)\s*(==|!=|>=|<=|>|<|contains)\s*(.+)$/.exec(String(expr || '').trim());
  if (!match) return null;
  const left = scalarExpr(match[1], obs, bound);
  const right = scalarExpr(match[3], obs, bound);
  if (left === undefined || right === undefined) return false;
  if (match[2] === '==') return String(left) === String(right);
  if (match[2] === '!=') return String(left) !== String(right);
  if (match[2] === 'contains') return String(left).includes(String(right));
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (match[2] === '>=') return a >= b;
  if (match[2] === '<=') return a <= b;
  if (match[2] === '>') return a > b;
  return a < b;
}

function urlMatches(pattern: unknown, url: unknown): boolean {
  const patternText = String(pattern || '').trim();
  const urlText = String(url || '').trim();
  if (!patternText || !urlText) return false;
  const regex = /^\/(.+)\/([a-z]*)$/.exec(patternText);
  try {
    if (regex && /^[gimsuy]*$/.test(regex[2])) {
      return new RegExp(regex[1], regex[2]).test(urlText);
    }
  } catch {
    return false;
  }
  const normalized = patternText.replace(/<n>/g, '\\d+').replace(/\*/g, '.*');
  try {
    return new RegExp(normalized).test(urlText);
  } catch {
    return urlText.includes(patternText);
  }
}

function evaluateRule(
  rule: PhiRule,
  obs: Evidence,
  bound: Record<string, unknown>,
  before?: Evidence
): boolean {
  if (!rule || !PHI_KINDS.has(rule.kind) || rule.source !== 'structured') return false;
  switch (rule.kind) {
    case 'url_pattern':
      return urlMatches(rule.expr, obs.url);
    case 'no_dialog':
      return obs.dialog === null;
    case 'element_present':
      return compareExpression(rule.expr, obs, bound) === true;
    case 'element_visible':
      return compareExpression(rule.expr, obs, bound) === true;
    case 'counter':
    case 'value_equals':
    case 'not_satisfied':
      return compareExpression(rule.expr, obs, bound) === true;
    case 'text_contains': {
      const compare = compareExpression(rule.expr, obs, bound);
      if (compare !== null) return compare;
      const haystack = [obs.title, obs.visibleText || ''].join('\n');
      return Boolean(rule.expr) && haystack.includes(rule.expr);
    }
    case 'diff_exists':
      return Boolean(
        before &&
        (before.url !== obs.url ||
          before.fingerprint !== obs.fingerprint ||
          JSON.stringify(before.counters) !== JSON.stringify(obs.counters))
      );
    default:
      return false;
  }
}

export function evaluatePhiMinus(
  rules: PhiRule[],
  obs: Evidence,
  bound: Record<string, unknown> = {}
): { ok: boolean; failed: string[] } {
  const failed = (Array.isArray(rules) ? rules : [])
    .filter((rule) => !evaluateRule(rule, obs, bound))
    .map((rule) => rule.kind + ': ' + rule.expr);
  return { ok: failed.length === 0, failed };
}

/** ZERO-ACTION：除 not_satisfied 外的前置条件成立，且 not_satisfied 已不成立。 */
export function edgeAlreadySatisfied(
  edge: Edge,
  obs: Evidence,
  bound: Record<string, unknown> = {}
): boolean {
  const rules = Array.isArray(edge?.phiMinus) ? edge.phiMinus : [];
  const ordinary = rules.filter((rule) => rule.kind !== 'not_satisfied');
  const notSatisfied = rules.filter((rule) => rule.kind === 'not_satisfied');
  return (
    Boolean(notSatisfied.length) &&
    ordinary.every((rule) => evaluateRule(rule, obs, bound)) &&
    notSatisfied.every((rule) => !evaluateRule(rule, obs, bound))
  );
}

function replaceTemplate(value: unknown, bound: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceTemplate(item, bound));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        replaceTemplate(child, bound),
      ])
    );
  }
  if (typeof value !== 'string') return value;
  const exact = /^@([\p{L}\p{N}_-]+)$/u.exec(value);
  if (exact) return bound[exact[1]];
  return value.replace(/@([\p{L}\p{N}_-]+)/gu, (_match, name: string) => {
    const item = bound[name];
    return item === undefined || item === null ? '' : String(item);
  });
}

function hasUnresolvedReference(value: unknown): boolean {
  if (typeof value === 'string') {
    return /我常点的那款|上次的|原来的|刚才那个|the usual|previous one/i.test(value);
  }
  if (Array.isArray(value)) return value.some(hasUnresolvedReference);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasUnresolvedReference);
  }
  return false;
}

export function bindSlots(
  edge: Edge,
  instruction: { slots: Record<string, unknown> }
): {
  ok: boolean;
  bound: Record<string, unknown>;
  missing: string[];
  args?: Record<string, unknown>;
} {
  const source = instruction?.slots && typeof instruction.slots === 'object'
    ? instruction.slots
    : {};
  const missing: string[] = [];
  const bound: Record<string, unknown> = {};
  for (const slot of edge.slots || []) {
    const value = source[slot.name];
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && !value.trim()) ||
      hasUnresolvedReference(value)
    ) {
      missing.push(slot.name);
      continue;
    }
    bound[slot.name] = value;
  }
  return {
    ok: missing.length === 0,
    bound,
    missing,
    ...(missing.length === 0
      ? { args: replaceTemplate(edge.action.argsTemplate, bound) as Record<string, unknown> }
      : {}),
  };
}

export interface ResolvedEdgeTarget {
  ref?: string;
  selector?: string;
  role?: string;
  name?: string;
  visible: boolean;
  basis: 'semantic' | 'selector-hint' | 'url-pattern';
}

export type EdgeGroundingFailure =
  | 'target-missing'
  | 'target-ambiguous'
  | 'target-disabled'
  | 'target-hidden'
  | 'target-url-missing'
  | 'target-url-mismatch';

export function resolveEdgeTarget(
  edge: Edge,
  observation: Evidence
): {
  ok: boolean;
  target?: ResolvedEdgeTarget;
  reason?: EdgeGroundingFailure;
  candidates: number;
} {
  const anchor = edge?.s?.semanticAnchor || {};
  if (edge?.action?.tool === 'open_tab') {
    return anchor.urlPattern
      ? {
          ok: true,
          candidates: 1,
          target: {
            visible: true,
            basis: 'url-pattern',
          },
        }
      : { ok: false, reason: 'target-url-missing', candidates: 0 };
  }
  const normalize = (value: unknown) =>
    String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const anchorName = normalize(anchor.name || anchor.text);
  const anchorRole = normalize(anchor.role);
  const controls = Array.isArray(observation?.controls) ? observation.controls : [];
  let candidates = controls.filter((control) => {
    if (anchorRole && normalize(control.role) !== anchorRole) return false;
    if (anchorName && normalize(control.name) !== anchorName) return false;
    if (anchor.urlPattern && !urlMatches(anchor.urlPattern, control.urlPattern)) return false;
    return true;
  });

  // Legacy edges without semantic fields may only re-resolve by a unique
  // current selector. The hint never overrides a semantic mismatch.
  if (!anchorName && !anchorRole && !anchor.urlPattern && edge?.s?.selector) {
    candidates = controls.filter(
      (control) => control.selector === edge.s.selector
    );
    const hint = candidates[0];
    if (!hint) return { ok: false, reason: 'target-missing', candidates: 0 };
    if (hint.disabled) return { ok: false, reason: 'target-disabled', candidates: 1 };
    if (hint.visible === false) return { ok: false, reason: 'target-hidden', candidates: 1 };
    return {
      ok: true,
      candidates: 1,
      target: {
        ...(hint.ref ? { ref: hint.ref } : {}),
        ...(hint.selector ? { selector: hint.selector } : {}),
        role: hint.role,
        name: hint.name,
        visible: true,
        basis: 'selector-hint',
      },
    };
  }

  const enabled = candidates.filter((control) => control.disabled !== true);
  if (enabled.length > 1) {
    return { ok: false, reason: 'target-ambiguous', candidates: enabled.length };
  }
  if (enabled.length === 0 && candidates.some((control) => control.disabled)) {
    return { ok: false, reason: 'target-disabled', candidates: candidates.length };
  }
  const target = enabled[0];
  if (!target) {
    return { ok: false, reason: 'target-missing', candidates: 0 };
  }
  if (target.visible === false) {
    return { ok: false, reason: 'target-hidden', candidates: enabled.length };
  }
  if (!target.ref && !target.selector) {
    return { ok: false, reason: 'target-missing', candidates: enabled.length };
  }
  return {
    ok: true,
    candidates: 1,
    target: {
      ...(target.ref ? { ref: target.ref } : {}),
      ...(target.selector ? { selector: target.selector } : {}),
      role: target.role,
      name: target.name,
      visible: true,
      basis: 'semantic',
    },
  };
}

export function groundEdgeAction(
  edge: Edge,
  observation: Evidence,
  bound: Record<string, unknown>
): {
  ok: boolean;
  args?: Record<string, unknown>;
  target?: ResolvedEdgeTarget;
  reason?: EdgeGroundingFailure;
  candidates: number;
} {
  const template = replaceTemplate(edge.action.argsTemplate, bound) as Record<string, unknown>;
  const resolution = resolveEdgeTarget(edge, observation);
  if (!resolution.ok) return resolution;
  if (edge.action.tool === 'open_tab') {
    const url = String(template.url || bound.url || '').trim();
    if (!url || url.startsWith('@')) {
      return { ok: false, reason: 'target-url-missing', candidates: 0 };
    }
    if (edge.s.semanticAnchor.urlPattern && !urlMatches(edge.s.semanticAnchor.urlPattern, url)) {
      return { ok: false, reason: 'target-url-mismatch', candidates: 0 };
    }
    return {
      ok: true,
      args: { ...template, url },
      target: resolution.target,
      candidates: resolution.candidates,
    };
  }
  const target = resolution.target;
  if (!target?.ref && !target?.selector) {
    return { ok: false, reason: 'target-missing', candidates: resolution.candidates };
  }
  const args = { ...template };
  delete args.ref;
  delete args.selector;
  if (target.ref) args.ref = target.ref;
  else args.selector = target.selector;
  return {
    ok: true,
    args,
    target,
    candidates: resolution.candidates,
  };
}

export function decideR3(
  edge: Edge,
  bound: Record<string, unknown>
): 'REUSE' | 'REWRITE' | 'REJECT' {
  if (!edge || edge.status !== 'verified') return 'REJECT';
  if ((edge.phiMinus || []).some((rule) => !PHI_KINDS.has(rule.kind))) return 'REJECT';
  for (const slot of edge.slots || []) {
    if (!Object.prototype.hasOwnProperty.call(bound, slot.name)) return 'REJECT';
    if (hasUnresolvedReference(bound[slot.name])) return 'REJECT';
  }
  const argsText = JSON.stringify(edge.action.argsTemplate);
  return edge.slots.length && argsText.includes('@') ? 'REWRITE' : 'REUSE';
}

export function verifyEdgePostcondition(
  edge: Edge,
  before: Evidence,
  after: Evidence,
  bound: Record<string, unknown>
): { ok: boolean; reason: string } {
  const rule = edge?.phiPlus;
  if (!rule || !PHI_KINDS.has(rule.kind)) {
    return { ok: false, reason: 'φ⁺ 缺失或不在结构化白名单内' };
  }
  if (rule.kind === 'diff_exists' && after?.fingerprint === before?.fingerprint) {
    return { ok: false, reason: '结构化前后证据没有差异' };
  }
  const ok = evaluateRule(rule, after, bound, before);
  return {
    ok,
    reason: ok
      ? 'φ⁺ 成立：' + rule.kind + ' ' + rule.expr
      : 'φ⁺ 不成立：' + rule.kind + ' ' + rule.expr,
  };
}

const PATCH_ALLOWED = new Set(['semanticAnchor', 'waitMs', 'behaviorNotes']);
const SENSITIVE_PATCH = /value|default|recorded|slot|tool|selector|ref|coordinate|embedding|screenshot|task/i;

export function patchGuard(patch: Record<string, unknown>): {
  ok: boolean;
  rejectedFields: string[];
  accepted?: Record<string, unknown>;
} {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, rejectedFields: ['$'] };
  }
  const rejectedFields: string[] = [];
  const accepted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!PATCH_ALLOWED.has(key) || SENSITIVE_PATCH.test(key)) {
      rejectedFields.push(key);
      continue;
    }
    if (key === 'semanticAnchor') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        rejectedFields.push(key);
        continue;
      }
      const anchor = value as Record<string, unknown>;
      const bad = Object.keys(anchor).filter(
        (field) => field !== 'role' && field !== 'name'
      );
      if (bad.length) {
        rejectedFields.push(...bad.map((field) => key + '.' + field));
        continue;
      }
      if (
        Object.values(anchor).some(
          (item) => typeof item !== 'string' || !item.trim()
        )
      ) {
        rejectedFields.push(key);
        continue;
      }
      accepted[key] = { ...anchor };
      continue;
    }
    if (key === 'waitMs') {
      const wait = Number(value);
      if (!Number.isFinite(wait) || wait < 0 || wait > 60_000) {
        rejectedFields.push(key);
        continue;
      }
      accepted[key] = Math.floor(wait);
      continue;
    }
    if (typeof value !== 'string' || !value.trim() || value.length > 500) {
      rejectedFields.push(key);
      continue;
    }
    accepted[key] = value.trim();
  }
  return {
    ok: rejectedFields.length === 0 && Object.keys(accepted).length > 0,
    rejectedFields,
    ...(Object.keys(accepted).length ? { accepted } : {}),
  };
}

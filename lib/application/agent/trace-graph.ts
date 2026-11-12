// tracegraph.v2 的纯函数内核：状态抽象、构图、提名与确定性守卫。
//
// 纪律：
//   - 状态键只含语义模板和 atom 类型；控件值、实例数、selector、ref、瞬时弹窗
//     与整页 fingerprint 都不参与 atomSignature。
//   - 图只列候选，不做意图匹配也不替 JEV 排序；置信度永不授权执行。
//   - 未显式绑定的槽位 fail-closed；禁止回填历史值或默认偏好。

import type { PageSnapshotLike, SnapshotElementLike } from './types.ts';
import type {
  CandidateMatch,
  CandidateMatchLevel,
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

/** 能从 selector 里读出的稳定属性值（data-* / name / aria-label / title / #id / .class）。 */
const STABLE_SELECTOR_HINT =
  /\[(?:data-[a-z0-9-]+|name|aria-label|title)\s*=\s*["']([^"']{1,80})["']\]/i;

/**
 * 无名字目标的兜底标签：返回可读的 selector 提示，形如 `selector:editor`。
 * **位置选择器**（nth-of-type / nth-child）会随列表顺序漂移，直接判为不可用；
 * 带了位置伪类的动作不立边（2026-11-12：trip.com 16 条边里 10 条正是这种）。
 */
function selectorHintLabel(selector: unknown): string {
  const text = String(selector || '').trim();
  if (!text) return '';
  if (/:(?:nth-of-type|nth-child|first-child|last-child)\b/i.test(text)) return '';
  const attr = STABLE_SELECTOR_HINT.exec(text);
  if (attr) return 'selector:' + attr[1].trim();
  const segments = text.split('>').map((part) => part.trim()).filter(Boolean);
  const last = segments[segments.length - 1] || text;
  const id = /#([A-Za-z][\w-]{0,60})/.exec(last);
  if (id) return 'selector:' + id[1];
  const cls = /\.([A-Za-z_][\w-]{0,60})/.exec(last);
  if (cls) return 'selector:' + cls[1];
  return '';
}

/**
 * 易变的路径段：纯数字 id、长 hex（16+ 位）、UUID。
 * 它们标识「一条记录」而非「一类页面」，不能成为状态名的一部分。
 */
const VOLATILE_PATH_SEGMENT =
  /^(?:\d+|[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

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
  const segments = path.split('/').filter(Boolean);
  // 末段是「某一条记录」而不是「模板」时不能进状态名：/article/details/170567085
  // 若按末段命名会得到 170567085Page，于是每篇新文章都是一个新状态，历史边永远
  // 无法跨实例复用。这里剥掉易变段，退回稳定的父级模板（保留两级，避免
  // /a/details/123 与 /x/details/123 撞名）。
  let stable = segments;
  while (stable.length && VOLATILE_PATH_SEGMENT.test(stable[stable.length - 1])) {
    stable = stable.slice(0, -1);
  }
  const trimmed = stable.length !== segments.length;
  const tail = trimmed ? stable.slice(-2) : stable.slice(-1);
  // 大小写归一：/chinaflights/ShowFareFirst 与 /chinaflights/showfarefirst 是同一页，
  // 不归一会把同一个飞行页拆成两个状态。
  const base = (tail.join(' ') || (trimmed ? 'Detail' : pageTitle || 'Page')).toLowerCase();
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

interface SignatureParts {
  name: string;
  staticAtoms: string[];
  dynamicAtoms: string[];
}

/** `name#static+dynamic` → 三段；形状不对返回 null（旧图/脏数据按 name 档处理）。 */
export function splitAtomSignature(signature: unknown): SignatureParts | null {
  const parts = String(signature || '').split('#');
  if (parts.length !== 3 || !parts[0]) return null;
  const list = (value: string) => (value ? value.split('+').filter(Boolean) : []);
  return { name: parts[0], staticAtoms: list(parts[1]), dynamicAtoms: list(parts[2]) };
}

function signatureSet(signature: string): string {
  return [...new Set(signature.split('+').filter(Boolean))].sort().join('+');
}

function overlapRatio(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size && !right.size) return 1;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * 候选边与「当前观察」的结构匹配层级。纯结构判断：不含语义相似度、不含置信度，
 * 也不能单独授权执行 —— 它只把「同一 URL 名下混着的不同子状态」分开。
 *
 * 为什么需要它：`candidateEdges` 只能按状态名（URL 规则）过滤，同名的弹窗开/关、
 * 已填/未填会混成一个候选桶。分层之后，选择期至少能看出「这条边录制时的结构
 * 与现在是否一致」，而不是让模型对着 N 条只差一个按钮文字的边猜。
 */
export function matchCandidate(
  edge: Pick<Edge, 'fromSignatures'> | null | undefined,
  observation: { atomSignature?: string } | null | undefined
): CandidateMatch {
  const current = splitAtomSignature(observation?.atomSignature);
  if (!current) return { level: 'name', staticOverlap: 0, dynamicOverlap: 0 };
  const recorded = (Array.isArray(edge?.fromSignatures) ? edge!.fromSignatures : [])
    .map((signature) => splitAtomSignature(signature))
    .filter((item): item is SignatureParts => Boolean(item));
  if (!recorded.length) return { level: 'name', staticOverlap: 0, dynamicOverlap: 0 };
  const currentStatic = signatureSet(current.staticAtoms.join('+'));
  const currentDynamic = signatureSet(current.dynamicAtoms.join('+'));
  let level: CandidateMatchLevel = 'name';
  let staticOverlap = 0;
  let dynamicOverlap = 0;
  for (const item of recorded) {
    const staticSame = signatureSet(item.staticAtoms.join('+')) === currentStatic;
    const dynamicSame = signatureSet(item.dynamicAtoms.join('+')) === currentDynamic;
    const itemStatic = overlapRatio(item.staticAtoms, current.staticAtoms);
    const itemDynamic = overlapRatio(item.dynamicAtoms, current.dynamicAtoms);
    if (staticSame && dynamicSame) {
      return { level: 'full', staticOverlap: 1, dynamicOverlap: 1 };
    }
    // 动态原子是「checkbox:checked」这类存在标记；现在多出来只说明值变了，
    // 结构没变，仍是同一个子状态模板。
    const dynamicSuperset = item.dynamicAtoms.every((atom) => currentDynamic.includes(atom));
    const candidateLevel: CandidateMatchLevel = staticSame && dynamicSuperset ? 'static' : 'name';
    const better =
      (candidateLevel === 'static' && level !== 'static') ||
      (candidateLevel === 'static' && level === 'static' && itemStatic + itemDynamic > staticOverlap + dynamicOverlap);
    if (better) {
      level = candidateLevel;
      staticOverlap = itemStatic;
      dynamicOverlap = itemDynamic;
    } else if (level === 'name' && itemStatic > staticOverlap) {
      staticOverlap = itemStatic;
      dynamicOverlap = itemDynamic;
    }
  }
  return { level, staticOverlap, dynamicOverlap };
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
    ...(target.kind ? { kind: target.kind } : {}),
  };
  const targetLabel =
    semanticAnchor.name ||
    semanticAnchor.text ||
    semanticAnchor.urlPattern ||
    semanticAnchor.role ||
    '';
  // 没有任何语义句柄时，从 selector 里找稳定属性（data-testid / #id / name…）当标签；
  // 连这个都没有（纯位置 selector）就不立边：题面里只有「click_element」四个字，
  // 选中后也最容易 target-missing。记录仍保留，审计可见。
  const selector = target.selector ||
    (typeof record.argsRedacted.selector === 'string' ? record.argsRedacted.selector : '');
  const label = targetLabel || selectorHintLabel(selector);
  if (!label) return null;
  const actionGoal = clip(
    [actionTool, '「' + label + '」'].filter(Boolean).join(' '),
    160
  );
  // PlanCard wording is execution context, not action identity.
  const g = actionGoal;
  const phiPlus = structuredPhiFromTransition(record.before, record.after, actionTool);
  const fromSignatures = [String(record.before.atomSignature || '')].filter(Boolean);
  const purpose = [
    String(record.planStep || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  ].filter(Boolean);
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
    ...(fromSignatures.length ? { fromSignatures } : {}),
    ...(purpose.length ? { purpose } : {}),
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
  // 只继承**同一 id** 的元数据，不再拿 prev 的边打底。
  // 打底会保留两类孤儿边：记录已被 80 条上限挤掉的，以及状态名改版后不再由任何
  // 记录推导出来的。它们会一直参与提名（2026-11-12 实测：slug 改名后同一记录
  // 同时长出旧名与新名两条边）。状态模板同理，只从当前记录重建。
  const prevById = new Map<string, Edge>();
  for (const edge of prev?.l1?.edges || []) {
    if (edge.identityVersion === EDGE_IDENTITY_VERSION) prevById.set(edge.id, edge);
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
    // 同一次 merge 里多个记录命中同一身份时合并元数据（edges），
    // 跨次 merge 的元数据则按 id 从 prevById 继承。两者都不引入孤儿。
    const prevEdge = edges.get(edge.id) || prevById.get(edge.id);
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
      // 同一动作可能在不同子状态下被重复验证（弹窗开 / 关）。这些签名合在一起
      // 才能让 matchCandidate 在两种结构下都认得出这条边。
      edge.fromSignatures = [
        ...new Set([...(edge.fromSignatures || []), ...(prevEdge.fromSignatures || [])]),
      ].slice(-8);
      // 最新的计划步排前面：选择期读的是「最近一次为什么这么做」。
      edge.purpose = [
        ...new Set([...(edge.purpose || []), ...(prevEdge.purpose || [])]),
      ].slice(0, 3);
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

/**
 * 当前状态的候选边：只按站点、状态模板、已验证状态与本次运行的封边/已执行集合过滤。
 * 不排序、不截断，也不做意图匹配 —— 选边还是弃权始终由 JEV 决定。
 */
export function candidateEdges(
  graph: TraceGraphV2,
  ctx: {
    siteKey: string;
    atomSignature: string;
    blockedEdgeIds: Set<string>;
    executedEdges: Set<string>;
  }
): Edge[] {
  if (!graph || graph.siteKey !== ctx.siteKey) return [];
  const stateName = String(ctx.atomSignature || '').split('#')[0];
  return graph.l1.edges.filter(
    (edge) =>
      edge.status === 'verified' &&
      edge.from === stateName &&
      !ctx.blockedEdgeIds.has(edge.id) &&
      !ctx.executedEdges.has(edge.id)
  );
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

/**
 * open_tab 边是否指向**当前** URL：这种导航是 no-op，快路不该为它开新标签页。
 * 只看锚点的 urlPattern（argsTemplate 里的 url 已被脱敏成 @url）。
 */
export function opensCurrentUrl(
  edge: Pick<Edge, 'action' | 's'> | null | undefined,
  observation: Evidence | null | undefined
): boolean {
  if (edge?.action?.tool !== 'open_tab') return false;
  const pattern = edge?.s?.semanticAnchor?.urlPattern || '';
  if (!pattern) return false;
  return urlMatches(pattern, observation?.url);
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
  // 内容型锚点会随写入/翻页漂移（写入目标的 label 就是它的正文）。它不参与名字比对，
  // 只能按 selector 唯一重定位；旧图没有 kind 字段时用长度/换行做保守推断，
  // 宁可 target-missing 交给慢思考，也不按一段已经变了的内容去猜目标。
  const anchorNameRaw = String(anchor.name || anchor.text || '');
  const contentLikeName =
    anchorNameRaw.length > 48 || anchorNameRaw.indexOf('\n') >= 0;
  const selectorOnly =
    anchor.kind === 'selector' ||
    (!anchor.kind && contentLikeName) ||
    (anchor.kind === 'content' && contentLikeName) ||
    (!anchorNameRaw && !anchor.role && !anchor.urlPattern);
  const anchorName = selectorOnly ? '' : normalize(anchorNameRaw);
  const anchorRole = selectorOnly ? '' : normalize(anchor.role);
  const controls = Array.isArray(observation?.controls) ? observation.controls : [];
  let candidates = controls.filter((control) => {
    if (anchorRole && normalize(control.role) !== anchorRole) return false;
    if (anchorName && normalize(control.name) !== anchorName) return false;
    if (anchor.urlPattern && !urlMatches(anchor.urlPattern, control.urlPattern)) return false;
    return true;
  });

  // Legacy edges without semantic fields —— 以及锚点只剩 selector 的写入目标 ——
  // 只能按当前唯一 selector 重定位。selector 漂移时如实报 target-missing。
  if (selectorOnly && edge?.s?.selector) {
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

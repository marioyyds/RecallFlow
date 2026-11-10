import type { TraceGraphV2 } from '../../application/agent/trace-graph-types.ts';

export interface TraceGraphViewState {
  name: string;
  urlPattern: string;
  staticAtoms: number;
  dynamicAtoms: number;
}

export interface TraceGraphViewEdge {
  id: string;
  from: string;
  to: string;
  goal: string;
  targetLabel: string;
  tool: string;
  risk: string;
  status: string;
  slots: string[];
  argsTemplate: string;
  recordCount: number;
  verifiedAt: number;
}

export interface TraceGraphView {
  siteKey: string;
  updatedAt: number;
  ageMs: number;
  recordCount: number;
  states: TraceGraphViewState[];
  edges: TraceGraphViewEdge[];
}

export interface TraceGraphLayoutNode extends TraceGraphViewState {
  x: number;
  y: number;
  width: number;
  height: number;
  level: number;
  incoming: number;
  outgoing: number;
}

export interface TraceGraphLayoutEdge extends TraceGraphViewEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  parallelIndex: number;
  parallelCount: number;
  laneOffset: number;
  labelX: number;
  labelY: number;
  path: string;
  curve: {
    x1: number;
    y1: number;
    c1x: number;
    c1y: number;
    c2x: number;
    c2y: number;
    x2: number;
    y2: number;
  };
}

export interface TraceGraphLayout {
  width: number;
  height: number;
  viewBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  levels: number;
  nodes: TraceGraphLayoutNode[];
  edges: TraceGraphLayoutEdge[];
}

const NODE_WIDTH = 184;
const NODE_HEIGHT = 58;
const COLUMN_GAP = 92;
const ROW_GAP = 32;
const PADDING = 34;
const PARALLEL_LANE_GAP = 18;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, max = 300): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function strings(value: unknown, maxItems = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => text(item, 160)).filter(Boolean);
}

function compactJson(value: unknown): string {
  try {
    const result = JSON.stringify(value ?? {});
    return result.length > 420 ? result.slice(0, 420) + '…' : result;
  } catch {
    return '{}';
  }
}

/**
 * Convert an untrusted stored graph into the small, display-only shape used by
 * the settings page. This deliberately does not import the recording engine.
 */
export function parseTraceGraphView(
  value: unknown,
  now = Date.now()
): TraceGraphView | null {
  const graph = record(value);
  if (!graph || graph.version !== 2) return null;
  const siteKey = text(graph.siteKey, 500);
  const l0 = record(graph.l0);
  const l1 = record(graph.l1);
  if (!siteKey || !l0 || !l1 || !Array.isArray(l0.states) || !Array.isArray(l1.edges)) {
    return null;
  }

  const states = new Map<string, TraceGraphViewState>();
  for (const item of l0.states.slice(0, 120)) {
    const state = record(item);
    const name = text(state?.name, 100);
    if (!name) continue;
    states.set(name, {
      name,
      urlPattern: text(state?.urlPattern, 240),
      staticAtoms: Array.isArray(state?.staticAtoms) ? state.staticAtoms.length : 0,
      dynamicAtoms: Array.isArray(state?.dynamicAtoms) ? state.dynamicAtoms.length : 0,
    });
  }

  const edges: TraceGraphViewEdge[] = [];
  for (const item of l1.edges.slice(0, 80)) {
    const edge = record(item);
    const action = record(edge?.action);
    const semanticAnchor = record(record(edge?.s)?.semanticAnchor);
    const provenance = record(edge?.provenance);
    const from = text(edge?.from, 100);
    const to = text(edge?.to, 100);
    const id = text(edge?.id, 100);
    if (!edge || !from || !to || !id) continue;
    if (!states.has(from)) {
      states.set(from, { name: from, urlPattern: '', staticAtoms: 0, dynamicAtoms: 0 });
    }
    if (!states.has(to)) {
      states.set(to, { name: to, urlPattern: '', staticAtoms: 0, dynamicAtoms: 0 });
    }
    const slotNames = Array.isArray(edge.slots)
      ? edge.slots
          .slice(0, 12)
          .map((slot) => text(record(slot)?.name, 60))
          .filter(Boolean)
      : [];
    const recordIds = Array.isArray(provenance?.recordIds) ? provenance.recordIds : [];
    edges.push({
      id,
      from,
      to,
      goal: text(edge.g, 300),
      targetLabel: text(
        semanticAnchor?.name ||
        semanticAnchor?.text ||
        semanticAnchor?.urlPattern ||
        semanticAnchor?.role,
        160
      ),
      tool: text(action?.tool || 'unknown', 80),
      risk: text(action?.risk || edge.r || 'low', 20),
      status: text(edge.status || 'unknown', 20),
      slots: slotNames,
      argsTemplate: compactJson(action?.argsTemplate),
      recordCount: recordIds.length,
      verifiedAt: finite(provenance?.verifiedAt),
    });
  }

  const updatedAt = finite(graph.updatedAt);
  const ageMs = Math.max(0, now - updatedAt);
  return {
    siteKey,
    updatedAt,
    ageMs,
    recordCount: Array.isArray(graph.records) ? graph.records.length : 0,
    states: [...states.values()].sort((a, b) => a.name.localeCompare(b.name)),
    edges,
  };
}

function curvePath(curve: TraceGraphLayoutEdge['curve']): string {
  return (
    'M ' + curve.x1 + ' ' + curve.y1 +
    ' C ' + curve.c1x + ' ' + curve.c1y +
    ', ' + curve.c2x + ' ' + curve.c2y +
    ', ' + curve.x2 + ' ' + curve.y2
  );
}

function edgeGeometry(
  edge: TraceGraphViewEdge & { laneOffset: number },
  from: TraceGraphLayoutNode,
  to: TraceGraphLayoutNode
): Pick<
  TraceGraphLayoutEdge,
  'x1' | 'y1' | 'x2' | 'y2' | 'labelX' | 'labelY' | 'path' | 'curve'
> {
  const anchorOffset = Math.max(-18, Math.min(18, edge.laneOffset * 0.35));
  let y1 = from.y + from.height / 2 + anchorOffset;
  let y2 = to.y + to.height / 2 + anchorOffset;
  let x1 = from.x + from.width;
  let x2 = to.x;
  let c1x: number;
  let c1y: number;
  let c2x: number;
  let c2y: number;
  let labelX = (x1 + x2) / 2;
  let labelY = (y1 + y2) / 2 - 6;
  if (to.level > from.level) {
    const bend = Math.max(30, (x2 - x1) * 0.45);
    const curveOffset = edge.laneOffset * 1.45;
    c1x = x1 + bend;
    c1y = y1 + curveOffset;
    c2x = x2 - bend;
    c2y = y2 + curveOffset;
    labelY = (y1 + y2) / 2 + curveOffset * 0.72 - 5;
  } else if (from.name === to.name) {
    const loopHeight = 48 + Math.abs(edge.laneOffset) * 0.8;
    x1 = from.x + from.width * 0.32;
    x2 = from.x + from.width * 0.68;
    y1 = from.y;
    y2 = from.y;
    c1x = x1 - 28;
    c1y = from.y - loopHeight;
    c2x = x2 + 28;
    c2y = from.y - loopHeight;
    labelX = from.x + from.width / 2 + edge.laneOffset * 0.35;
    labelY = from.y - loopHeight + 14;
  } else {
    x1 = from.x + from.width / 2;
    x2 = to.x + to.width / 2;
    const lower = edge.laneOffset >= 0;
    const detour = Math.abs(edge.laneOffset) + 34;
    const curveY = lower
      ? Math.max(from.y + from.height, to.y + to.height) + detour
      : Math.min(from.y, to.y) - detour;
    y1 = from.y;
    y2 = to.y;
    c1x = x1;
    c1y = curveY;
    c2x = x2;
    c2y = curveY;
    labelY = curveY + (lower ? 14 : -5);
  }
  const curve = { x1, y1, c1x, c1y, c2x, c2y, x2, y2 };
  return {
    x1,
    y1,
    x2,
    y2,
    labelX,
    labelY,
    path: curvePath(curve),
    curve,
  };
}

function stateLevels(view: TraceGraphView): Map<string, number> {
  const names = [...new Set([
    ...view.states.map((state) => state.name),
    ...view.edges.flatMap((edge) => [edge.from, edge.to]),
  ])].sort();
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const name of names) {
    outgoing.set(name, []);
    indegree.set(name, 0);
  }
  for (const edge of view.edges) {
    const list = outgoing.get(edge.from);
    if (!list) continue;
    list.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
  }

  const pending = names.filter((name) => (indegree.get(name) || 0) === 0);
  const levels = new Map<string, number>();
  for (const name of pending) levels.set(name, 0);
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const name = pending[cursor];
    const level = levels.get(name) || 0;
    for (const target of outgoing.get(name) || []) {
      levels.set(target, Math.max(levels.get(target) || 0, level + 1));
      const next = (indegree.get(target) || 0) - 1;
      indegree.set(target, next);
      if (next === 0) pending.push(target);
    }
  }

  // Cycles have no zero-indegree entry. Put unresolved nodes after the known
  // frontier, keeping the result deterministic rather than dropping them.
  let fallbackLevel = Math.max(0, ...levels.values()) + 1;
  for (const name of names) {
    if (!levels.has(name)) levels.set(name, fallbackLevel++);
  }
  return levels;
}

export function buildTraceGraphLayout(view: TraceGraphView): TraceGraphLayout {
  const levels = stateLevels(view);
  const columns = new Map<number, string[]>();
  for (const state of view.states) {
    const level = levels.get(state.name) || 0;
    const list = columns.get(level) || [];
    list.push(state.name);
    columns.set(level, list);
  }
  for (const list of columns.values()) list.sort();

  const levelCount = Math.max(1, ...[...columns.keys()].map((level) => level + 1));
  const maxRows = Math.max(
    1,
    ...[...columns.values()].map((list) => list.length)
  );
  const width = Math.max(
    620,
    PADDING * 2 + levelCount * NODE_WIDTH + Math.max(0, levelCount - 1) * COLUMN_GAP
  );
  const height = Math.max(
    280,
    PADDING * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP
  );
  const stateMap = new Map(view.states.map((state) => [state.name, state]));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of view.edges) {
    outgoing.set(edge.from, (outgoing.get(edge.from) || 0) + 1);
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
  }

  const nodes: TraceGraphLayoutNode[] = [];
  for (const [level, names] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    names.forEach((name, index) => {
      const state = stateMap.get(name) || {
        name,
        urlPattern: '',
        staticAtoms: 0,
        dynamicAtoms: 0,
      };
      nodes.push({
        ...state,
        x: PADDING + level * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + index * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        level,
        incoming: incoming.get(name) || 0,
        outgoing: outgoing.get(name) || 0,
      });
    });
  }

  const nodeMap = new Map(nodes.map((node) => [node.name, node]));
  const pairGroups = new Map<string, TraceGraphViewEdge[]>();
  for (const edge of view.edges) {
    const key = edge.from <= edge.to
      ? edge.from + '\u0000' + edge.to
      : edge.to + '\u0000' + edge.from;
    const group = pairGroups.get(key) || [];
    group.push(edge);
    pairGroups.set(key, group);
  }
  const lanes = new Map<TraceGraphViewEdge, {
    index: number;
    count: number;
    offset: number;
  }>();
  for (const group of pairGroups.values()) {
    group.sort((a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.id.localeCompare(b.id)
    );
    const gap = group.length > 7
      ? 9
      : group.length > 4
        ? 12
        : PARALLEL_LANE_GAP;
    const center = (group.length - 1) / 2;
    group.forEach((edge, index) => {
      lanes.set(edge, {
        index,
        count: group.length,
        offset: (index - center) * gap,
      });
    });
  }
  const edges: TraceGraphLayoutEdge[] = [];
  for (const edge of view.edges) {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    if (!from || !to) continue;
    const lane = lanes.get(edge) || { index: 0, count: 1, offset: 0 };
    edges.push({
      ...edge,
      parallelIndex: lane.index,
      parallelCount: lane.count,
      laneOffset: lane.offset,
      ...edgeGeometry({ ...edge, laneOffset: lane.offset }, from, to),
    });
  }

  let minX = 0;
  let minY = 0;
  let maxX = width;
  let maxY = height;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  for (const edge of edges) {
    const coordinates = (edge.path.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    for (let index = 0; index + 1 < coordinates.length; index += 2) {
      minX = Math.min(minX, coordinates[index]);
      minY = Math.min(minY, coordinates[index + 1]);
      maxX = Math.max(maxX, coordinates[index]);
      maxY = Math.max(maxY, coordinates[index + 1]);
    }
    const labelHalfWidth = Math.max(32, (edge.tool.length + edge.targetLabel.length + 8) * 3.2);
    minX = Math.min(minX, edge.labelX - labelHalfWidth);
    maxX = Math.max(maxX, edge.labelX + labelHalfWidth);
    minY = Math.min(minY, edge.labelY - 12);
    maxY = Math.max(maxY, edge.labelY + 12);
  }
  const margin = 24;
  const bounds = {
    x: minX - margin,
    y: minY - margin,
    width: Math.max(1, maxX - minX + margin * 2),
    height: Math.max(1, maxY - minY + margin * 2),
  };
  return {
    width: bounds.width,
    height: bounds.height,
    viewBox: bounds,
    levels: levelCount,
    nodes,
    edges,
  };
}

function withTraceGraphGeometry(
  layout: TraceGraphLayout,
  nodes: TraceGraphLayoutNode[],
  edges: TraceGraphLayoutEdge[]
): TraceGraphLayout {
  let minX = Math.min(0, ...nodes.map((node) => node.x));
  let minY = Math.min(0, ...nodes.map((node) => node.y));
  let maxX = Math.max(620, ...nodes.map((node) => node.x + node.width));
  let maxY = Math.max(280, ...nodes.map((node) => node.y + node.height));
  for (const edge of edges) {
    const { curve } = edge;
    minX = Math.min(minX, curve.x1, curve.c1x, curve.c2x, curve.x2, edge.labelX - 42);
    minY = Math.min(minY, curve.y1, curve.c1y, curve.c2y, curve.y2, edge.labelY - 14);
    maxX = Math.max(maxX, curve.x1, curve.c1x, curve.c2x, curve.x2, edge.labelX + 42);
    maxY = Math.max(maxY, curve.y1, curve.c1y, curve.c2y, curve.y2, edge.labelY + 14);
  }
  const margin = 24;
  const viewBox = {
    x: minX - margin,
    y: minY - margin,
    width: Math.max(1, maxX - minX + margin * 2),
    height: Math.max(1, maxY - minY + margin * 2),
  };
  return {
    ...layout,
    width: viewBox.width,
    height: viewBox.height,
    viewBox,
    nodes,
    edges,
  };
}

export function moveTraceGraphNode(
  layout: TraceGraphLayout,
  name: string,
  x: number,
  y: number
): TraceGraphLayout {
  const nodes = layout.nodes.map((node) =>
    node.name === name ? { ...node, x, y } : node
  );
  const nodeMap = new Map(nodes.map((node) => [node.name, node]));
  const edges = layout.edges.map((edge) => {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    return from && to
      ? { ...edge, ...edgeGeometry(edge, from, to) }
      : edge;
  });
  return withTraceGraphGeometry(layout, nodes, edges);
}

export function moveTraceGraphEdge(
  layout: TraceGraphLayout,
  edgeId: string,
  laneOffset: number
): TraceGraphLayout {
  const nodeMap = new Map(layout.nodes.map((node) => [node.name, node]));
  const edges = layout.edges.map((edge) => {
    if (edge.id !== edgeId) return edge;
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    const next = { ...edge, laneOffset };
    return from && to
      ? { ...next, ...edgeGeometry(next, from, to) }
      : next;
  });
  return withTraceGraphGeometry(layout, layout.nodes, edges);
}

export function traceGraphCurvePoint(
  curve: TraceGraphLayoutEdge['curve'],
  t: number
) {
  const value = Math.max(0, Math.min(1, t));
  const inverse = 1 - value;
  return {
    x:
      inverse ** 3 * curve.x1 +
      3 * inverse ** 2 * value * curve.c1x +
      3 * inverse * value ** 2 * curve.c2x +
      value ** 3 * curve.x2,
    y:
      inverse ** 3 * curve.y1 +
      3 * inverse ** 2 * value * curve.c1y +
      3 * inverse * value ** 2 * curve.c2y +
      value ** 3 * curve.y2,
  };
}

export function distanceToTraceGraphEdge(
  edge: TraceGraphLayoutEdge,
  point: { x: number; y: number }
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= 36; index += 1) {
    const current = traceGraphCurvePoint(edge.curve, index / 36);
    best = Math.min(best, Math.hypot(current.x - point.x, current.y - point.y));
  }
  return best;
}

export function formatTraceGraphAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) return seconds + ' 秒前';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  return Math.floor(hours / 24) + ' 天前';
}

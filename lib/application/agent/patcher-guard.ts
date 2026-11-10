import type { PatchEntry, Edge, TraceGraphV2 } from './trace-graph-types.ts';
import { patchGuard } from './trace-graph.ts';

export interface PatcherResult {
  ok: boolean;
  rejectedFields: string[];
  graph: TraceGraphV2;
}

/**
 * 回写图知识。只允许语义锚点(role/name)、waitMs 和 behaviorNotes；任务值、
 * 槽位默认值、新工具、选择器与复合操作一律拒绝。
 */
export function applyTraceGraphPatch(
  graph: TraceGraphV2,
  edgeId: string,
  patch: Record<string, unknown>,
  now = Date.now()
): PatcherResult {
  const guard = patchGuard(patch);
  const next = structuredClone(graph);
  const edge = next.l1.edges.find((item: Edge) => item.id === edgeId);
  if (guard.ok && edge) {
    if (guard.accepted?.semanticAnchor) {
      edge.s.semanticAnchor = {
        ...edge.s.semanticAnchor,
        ...(guard.accepted.semanticAnchor as Record<string, string>),
      };
    }
    if (guard.accepted?.waitMs !== undefined) {
      const operation = next.l0.operations.find((item) => item.name === edge.action.tool);
      if (operation) operation.waitMs = Number(guard.accepted.waitMs);
    }
    if (guard.accepted?.behaviorNotes) {
      const operation = next.l0.operations.find((item) => item.name === edge.action.tool);
      if (operation) {
        operation.description = [operation.description, String(guard.accepted.behaviorNotes)]
          .filter(Boolean)
          .join('\n');
      }
    }
  }
  const entry: PatchEntry = {
    id: 'patch.' + Math.floor(now).toString(36) + '.' + next.patchLog.length,
    ts: now,
    fields: { ...patch },
    accepted: guard.ok && Boolean(edge),
    rejectedFields: edge ? guard.rejectedFields : [...guard.rejectedFields, 'edgeId'],
  };
  next.patchLog.push(entry);
  next.updatedAt = now;
  return {
    ok: entry.accepted,
    rejectedFields: entry.rejectedFields,
    graph: next,
  };
}

import type { PlanStep } from './types.ts';

/**
 * Fast-lane operations that a slow plan may explicitly authorize.
 * DONE and BLOCKED are control exits and stay available even when the
 * executable set is empty, so a restrictive plan can still stop safely.
 */
export const PLAN_FAST_OPERATIONS = Object.freeze([
  'CLICK',
  'TYPE_TEXT',
  'READ_PAGE',
  'READ_TABLE',
  'ACCESSIBILITY',
  'DIAGNOSTICS',
  'SCROLL_UP',
  'SCROLL_DOWN',
  'WAIT',
] as const);

export type PlanFastOperation = (typeof PLAN_FAST_OPERATIONS)[number];

export const PLAN_MAX_LEASE_ACTIONS = 50;

const PLAN_FAST_OPERATION_SET = new Set<string>(PLAN_FAST_OPERATIONS);

function cleanText(value: unknown, maxChars: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function cleanStepId(value: unknown, index: number): string {
  const candidate = String(value || '').trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(candidate)
    ? candidate
    : 'plan-' + (index + 1);
}

/**
 * Explicit [] means "no executable operation"; undefined means the step did
 * not opt into projection and therefore preserves legacy behavior.
 */
export function normalizePlanOperations(value: unknown): PlanFastOperation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const operations: PlanFastOperation[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const operation = String(raw || '').trim().toUpperCase();
    if (!PLAN_FAST_OPERATION_SET.has(operation) || seen.has(operation)) continue;
    seen.add(operation);
    operations.push(operation as PlanFastOperation);
  }
  return operations;
}

export function normalizePlanLease(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return undefined;
  return Math.min(PLAN_MAX_LEASE_ACTIONS, Math.max(1, Math.floor(number)));
}

export function normalizePlanStep(
  value: Record<string, unknown>,
  index: number
): PlanStep {
  const step: PlanStep = {
    id: cleanStepId(value.id, index),
    text: cleanText(value.text, 120),
    status: ['pending', 'in_progress', 'done'].includes(String(value.status))
      ? String(value.status)
      : 'pending',
  };
  const successPredicate = cleanText(value.successPredicate, 240);
  if (successPredicate) step.successPredicate = successPredicate;
  if (Object.prototype.hasOwnProperty.call(value, 'allowedOperations')) {
    // A malformed explicit contract must fail closed rather than silently
    // restoring the full operation space.
    step.allowedOperations = normalizePlanOperations(value.allowedOperations) || [];
  }
  const leaseActions = normalizePlanLease(value.leaseActions);
  if (leaseActions != null) step.leaseActions = leaseActions;
  return step;
}

/** The first in-progress step owns the fast-lane contract; fall back to pending. */
export function activePlanStep(plan: unknown): PlanStep | null {
  if (!Array.isArray(plan)) return null;
  const steps = plan.filter((step): step is PlanStep =>
    Boolean(step && typeof step === 'object' && typeof step.text === 'string')
  );
  return (
    steps.find((step) => step.status === 'in_progress') ||
    steps.find((step) => step.status === 'pending') ||
    null
  );
}

export function planStepKey(step: PlanStep | null, planVersion: unknown): string {
  if (!step) return '';
  const id = String(step.id || step.text);
  return String(Math.max(0, Math.floor(Number(planVersion) || 0))) + ':' + id;
}

export function describePlanStep(step: PlanStep): string {
  const parts = [step.text];
  if (step.successPredicate) parts.push('完成条件：' + step.successPredicate);
  if (step.allowedOperations) {
    parts.push(
      '快路动作：' +
        (step.allowedOperations.length ? step.allowedOperations.join('/') : '无（仅可结束或移交）')
    );
  }
  if (step.leaseActions) parts.push('动作租约：' + step.leaseActions);
  return parts.join('；');
}

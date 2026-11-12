import type { PlanDelegatedAction, PlanStep } from './types.ts';

/**
 * Fast-lane operations that a slow plan may explicitly authorize.
 * DONE and BLOCKED are control exits and stay available even when the
 * executable set is empty, so a restrictive plan can still stop safely.
 */
export const PLAN_FAST_OPERATIONS = Object.freeze([
  'CLICK',
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

/**
 * 可被委托给快路的工具。刻意不含 type_text / select_option：它们需要内容值，
 * 而值只能来自当前指令的显式槽位，不能由计划顺手带进来。
 */
export const DELEGATED_ACTION_TOOLS = Object.freeze([
  'click_element',
  'press_key',
  'open_tab',
] as const);

export type DelegatedActionTool = (typeof DELEGATED_ACTION_TOOLS)[number];

function cleanAnchorField(value: unknown, maxChars: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/**
 * 委托动作的 fail-closed 归一化：工具不在白名单、或没有可解析的目标句柄时，
 * 整个 nextAction 被丢弃 —— 快路不应该拿到一个只能靠猜的目标。
 */
export function normalizePlanNextAction(value: unknown): PlanDelegatedAction | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const tool = String(source.tool || '').trim();
  if (!(DELEGATED_ACTION_TOOLS as readonly string[]).includes(tool)) return undefined;
  const action: PlanDelegatedAction = { tool };
  const role = cleanAnchorField(source.role, 40);
  const name = cleanAnchorField(source.name, 100);
  const text = cleanAnchorField(source.text, 100);
  const selector = cleanAnchorField(source.selector, 300);
  const url = cleanAnchorField(source.url, 1000);
  const key = cleanAnchorField(source.key, 40);
  const note = cleanAnchorField(source.note, 120);
  if (role) action.role = role;
  if (name) action.name = name;
  if (text) action.text = text;
  if (selector) action.selector = selector;
  if (url) action.url = url;
  if (key) action.key = key;
  if (note) action.note = note;
  if (tool === 'open_tab' && !action.url) return undefined;
  if (tool === 'press_key' && !action.key) return undefined;
  if (tool !== 'open_tab' && !action.name && !action.text && !action.selector) return undefined;
  return action;
}

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
  const nextAction = normalizePlanNextAction(value.nextAction);
  if (nextAction) step.nextAction = nextAction;
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
  if (step.nextAction) {
    const target =
      step.nextAction.name ||
      step.nextAction.text ||
      step.nextAction.selector ||
      step.nextAction.url ||
      '';
    parts.push('待执行委托：' + step.nextAction.tool + (target ? ' → ' + target : ''));
  }
  return parts.join('；');
}

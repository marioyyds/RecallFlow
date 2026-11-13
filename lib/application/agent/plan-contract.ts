import type { PlanDelegatedAction, PlanStep, PlanVerifyContract } from './types.ts';

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

export function normalizePlanVerify(value: unknown): PlanVerifyContract | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const contract: PlanVerifyContract = {};
  if (raw.urlChanged === true) contract.urlChanged = true;
  if (raw.fingerprintChanged === true) contract.fingerprintChanged = true;
  const delta = Number(raw.minElementDelta);
  if (Number.isFinite(delta) && delta !== 0) {
    contract.minElementDelta = Math.max(-500, Math.min(500, Math.trunc(delta)));
  }
  const text = cleanText(raw.textIncludes, 120);
  if (text) contract.textIncludes = text;
  return Object.keys(contract).length ? contract : undefined;
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
  const verify = normalizePlanVerify(value.verify);
  if (verify) step.verify = verify;
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

/**
 * 快路动作里**会改变页面**的那些。声明了它们就必须同时给 verify：
 * 没有契约时快路只能拿保守默认（指纹必须变化）顶替，而默认经常不是模型的本意
 * ——「打开第一个结果」应该看 URL，不是看指纹。契约写错比不写更糟。
 */
const MUTATING_FAST_OPERATIONS: ReadonlySet<string> = new Set(['CLICK']);

/**
 * 校验计划里的快路契约是否**可执行**，返回给人看的拒绝理由（空数组=通过）。
 *
 * 为什么在 `update_plan` 就拦，而不是等协调器：协调器只能说“本步不给快路”，
 * 慢模型永远不知道自己为什么被降级；在这里拦，它同一轮就能改好。
 * 只查当前步骤（in_progress 优先，其次第一条 pending）——后面的步骤还没轮到，
 * 不要求提前写死契约。
 */
export function planContractViolations(
  rawItems: unknown,
  plan: PlanStep[]
): string[] {
  if (!Array.isArray(plan) || !plan.length) return [];
  const raw = Array.isArray(rawItems) ? rawItems : [];
  const inProgress = plan
    .map((step, index) => ({ step, index }))
    .filter((item) => item.step.status === 'in_progress');
  const pendingIndex = plan.findIndex((step) => step.status === 'pending');
  const targets = inProgress.length
    ? inProgress
    : pendingIndex >= 0
      ? [{ step: plan[pendingIndex], index: pendingIndex }]
      : [];
  if (!targets.length) return [];
  const issues: string[] = [];
  for (const { step, index } of targets) {
    const label = '第 ' + (index + 1) + ' 步「' + step.text + '」';
    const source =
      raw[index] && typeof raw[index] === 'object'
        ? (raw[index] as Record<string, unknown>)
        : {};
    const declaredVerify =
      Object.prototype.hasOwnProperty.call(source, 'verify') && source.verify != null;
    if (declaredVerify && !step.verify) {
      issues.push(
        label +
          '的 verify 无法识别（应为对象，如 {"urlChanged":true} 或 {"fingerprintChanged":true}），已丢弃。'
      );
      continue;
    }
    const operations = Array.isArray(step.allowedOperations) ? step.allowedOperations : [];
    const mutating = operations.some((operation) => MUTATING_FAST_OPERATIONS.has(operation));
    if (!step.verify && mutating && !step.nextAction) {
      issues.push(
        label + '声明了 CLICK（会改变页面），但没有 verify —— 快路点击后无法核对是否做对。'
      );
    }
  }
  return issues;
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

// 动作校验：回答“这一步做对了吗”。
//
// JEV 只负责在候选里选一个动作，它不知道点击之后页面意味着什么，也无法判断
// 动作是否推进了子目标。这里用慢模型写在计划里的结构化 verify 条件做确定性
// 核对：URL、指纹、元素数量、目标文本。没有契约时诚实返回 unknown，
// 不把“无法判断”伪装成“成功”。

import type { PlanStep, PlanVerifyContract } from './types.ts';

export type ActionVerdict = 'verified' | 'mismatch' | 'unknown';

export interface VerifySnapshot {
  url?: string;
  fingerprint?: string;
  elements?: unknown[];
  text?: string;
}

export interface VerifyResult {
  verdict: ActionVerdict;
  checks: string[];
  failures: string[];
  evidence: string;
}

function elementLabels(snapshot: VerifySnapshot | null): string {
  if (!snapshot || !Array.isArray(snapshot.elements)) return '';
  return snapshot.elements
    .map((element: any) =>
      String((element && (element.name || element.label || element.text)) || '')
    )
    .join(' ');
}

export function verifyActionResult(
  before: VerifySnapshot | null,
  after: VerifySnapshot | null,
  contract?: PlanVerifyContract
): VerifyResult {
  if (!contract || !Object.keys(contract).length) {
    return {
      verdict: 'unknown',
      checks: [],
      failures: [],
      evidence: '计划没有提供结构化 verify 条件',
    };
  }
  const checks: string[] = [];
  const failures: string[] = [];
  const urlBefore = String(before?.url || '');
  const urlAfter = String(after?.url || '');
  if (contract.urlChanged) {
    checks.push('urlChanged');
    if (urlAfter === urlBefore) failures.push('URL 未变化');
  }
  if (contract.fingerprintChanged) {
    checks.push('fingerprintChanged');
    if (String(after?.fingerprint || '') === String(before?.fingerprint || '')) {
      failures.push('页面指纹未变化');
    }
  }
  if (typeof contract.minElementDelta === 'number') {
    checks.push('minElementDelta');
    const delta =
      (Array.isArray(after?.elements) ? after!.elements!.length : 0) -
      (Array.isArray(before?.elements) ? before!.elements!.length : 0);
    if (delta < contract.minElementDelta) {
      failures.push('元素数量变化 ' + delta + ' < ' + contract.minElementDelta);
    }
  }
  if (contract.textIncludes) {
    checks.push('textIncludes');
    const needle = contract.textIncludes.toLowerCase();
    const haystack = (String(after?.text || '') + ' ' + elementLabels(after)).toLowerCase();
    if (!haystack.includes(needle)) failures.push('页面未出现「' + contract.textIncludes + '」');
  }
  const verdict: ActionVerdict = failures.length ? 'mismatch' : 'verified';
  return {
    verdict,
    checks,
    failures,
    evidence: failures.length ? failures.join('；') : '校验通过：' + checks.join('、'),
  };
}

/** 计划步骤里的校验契约；没有就返回 undefined（快路动作只能算未验证）。 */
export function verifyContractForStep(step: PlanStep | null | undefined): PlanVerifyContract | undefined {
  return step && step.verify ? step.verify : undefined;
}
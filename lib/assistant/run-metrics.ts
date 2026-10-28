// 运行轨迹的**聚合指标**（纯函数）：把 trace 条目压成一份可读的"编排开销"摘要。
//
// 为什么值得单独一个模块：trace 是逐条旁路数据，单看某一条说明不了任何事；
// "这一轮用了多少工具 / 绕了多少路 / 缓存命中多少 / 耗时拆成几段"只有聚合后才有意义，
// 而"用数据改进编排"（见 docs/testing-live-sites-plan.md 的 T3）的第一步就是先有可信的基线。

import type { RunMetricsSummary, TraceRecordEntry } from './types.ts';

const num = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;

/**
 * 把 trace entries 聚合成指标对象。
 * @param {Array} entries trace 条目（rec.entries）
 */
export function summarizeRunTrace(entries: TraceRecordEntry[] | null | undefined): RunMetricsSummary {
  const list: TraceRecordEntry[] = Array.isArray(entries) ? entries : [];
  const tools = list.filter((e) => e && e.phase === 'tool');
  const turns = list.filter((e) => e && e.phase === 'turn-timing');
  const cache = list.filter((e) => e && e.phase === 'cache');
  const complete = (list.find((e) => e && e.phase === 'complete') || {}) as TraceRecordEntry;

  const byTool: Record<string, number> = {};
  for (const t of tools) byTool[String(t.name)] = (byTool[String(t.name)] || 0) + 1;

  const hit = cache.reduce((n, e) => n + num(e.hit), 0);
  const miss = cache.reduce((n, e) => n + num(e.miss), 0);
  const totalMs = turns.reduce((n, e) => n + num(e.totalMs), 0);

  return {
    rounds: turns.length,
    toolCalls: tools.length,
    failedTools: tools.filter((t) => t.ok === false).length,
    expandResultRounds: tools.filter((t) => t.name === 'expand_result').length,
    byTool,
    cache: { hit, miss, ratio: hit + miss > 0 ? Math.round((hit / (hit + miss)) * 100) : null },
    totalMs: Math.round(totalMs),
    prefillMs: Math.round(turns.reduce((n, e) => n + num(e.prefillMs), 0)),
    decodeMs: Math.round(turns.reduce((n, e) => n + num(e.decodeMs), 0)),
    totalTokens: num(complete.totalTokens),
    errors: list.filter((e) => e && e.phase === 'error').length,
    timeouts: list.filter((e) => e && e.phase === 'timeout').length,
    collapsed: list.filter((e) => e && e.phase === 'collapse').length,
    repaired: list.filter((e) => e && e.phase === 'conversation-repair').length,
  };
}

/** 把指标对象格式化成给模型/人读的几行摘要。 */
export function formatRunMetrics(m: RunMetricsSummary): string {
  const sec = (ms: number) => (Math.round(ms / 100) / 10).toFixed(1) + 's';
  const lines = [
    '指标摘要：',
    '轮次 ' + m.rounds + ' / 工具调用 ' + m.toolCalls + '（失败 ' + m.failedTools + '）',
    '展开大结果 ' + m.expandResultRounds + ' 次 / 历史折叠 ' + m.collapsed + ' / 结构修复 ' + m.repaired,
    '耗时 ' + sec(m.totalMs) + '（prefill ' + sec(m.prefillMs) + ' / decode ' + sec(m.decodeMs) + '）',
    '累计 token ' + m.totalTokens + (m.cache.ratio == null ? '' : ' / 前缀缓存命中率 ' + m.cache.ratio + '%'),
  ];
  const by = (Object.entries(m.byTool || {}) as [string, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => k + '×' + n);
  if (by.length) lines.push('按工具：' + by.join('、'));
  return lines.join('\n');
}

// 运行状态族（update_plan / expand_result / get_run_trace）—— C-1 拆出的第二族。
//
// 为什么这三者算一族：它们都不碰页面，只操作**本次运行的内部状态** ——
// 计划条、大结果暂存、运行轨迹。放在同一个模块后，"这一族能读写什么"一眼可见。
//
// **搬运原则：不重写行为。** 下面的实现是从 tools.js 原样搬过来的，
// 只把闭包里的 `ctx` / `getTrace` / `listTraces` 换成显式参数。
//
// 注意：`update_plan` 在 agent 主循环里**另有专门分支**（把计划推给前端面板显示）。
// 那部分留在 agent.js —— 它属于循环的 UI 副作用，不属于工具实现。

// expand_result 的 offset 由**模型**给（它按自己估的字符位置切），所以这条路径上
// "切点落在代理对中间"完全可能发生 —— 而它读出来的又是页面原文（数学/表情最密集）。
// 一律走 rangeSafe，并把**实际取到的区间**如实写进回执（回退后就不要再报请求区间了）。
import { rangeSafe, sliceSafe } from '../shared/surrogates.ts';
import { summarizeRunTrace, formatRunMetrics } from './run-metrics.ts';

/** 更新计划条（原 update_plan）。 */
export function updatePlan(ctx: any, args: Record<string, unknown>) {
  const raw: Array<Record<string, unknown>> = Array.isArray(args && args.items) ? (args.items as Array<Record<string, unknown>>) : [];
  const plan = raw
    .filter((it: Record<string, unknown>) => it && typeof it.text === 'string' && it.text.trim())
    .slice(0, 20)
    .map((it: Record<string, unknown>) => ({
      text: sliceSafe(String(it.text).trim(), 0, 120),
      status: ['pending', 'in_progress', 'done'].includes(it.status as string) ? it.status : 'pending',
    }));
  ctx.plan = plan;
  const text = plan
    .map((p: any, i: any) => (p.status === 'done' ? '✓' : p.status === 'in_progress' ? '▶' : '○') + ' ' + (i + 1) + '. ' + p.text)
    .join('\n');
  return { result: '计划已更新（' + plan.length + ' 步）：\n' + (text || '（空计划）') };
}

/**
 * 分段读取被截断的工具结果（原 expand_result）。
 *
 * 两条失败文案是**有意写清楚**的，不要简化：结果只存在于本次运行的暂存里，
 * 跨「继续」恢复后旧 id 的内容已释放。若只说"未找到"，模型会以为是自己记错了 id
 * 而反复重试同一个 id（实测空耗）。
 */
export function expandResult(ctx: any, args: Record<string, unknown>) {
  const id = String((args && args.id) || '').trim();
  const store = ctx && ctx.resultStore;
  const text = store && typeof store.get === 'function' ? store.get(id) : null;
  if (!text) {
    const known = ctx && ctx.resultIds && typeof ctx.resultIds.has === 'function' && ctx.resultIds.has(id);
    return {
      ok: false,
      result:
        '未找到结果 id=' +
        id +
        (known
          ? '：该结果属于**上一轮运行**，内容已释放（大结果暂存不跨恢复保留）。请重新执行对应工具读取当前内容。'
          : '：请确认 id 是否正确（形如 res-12）。大结果暂存只在本次运行内有效，重新读取页面时会生成新的 id。'),
    };
  }
  const offset = Math.max(0, Number(args.offset) || 0);
  const limit = Math.min(4000, Math.max(200, Number(args.limit) || 2000));
  const piece = rangeSafe(text, offset, offset + limit);
  return {
    ok: true,
    result:
      '结果 ' + id + ' [' + piece.start + ',' + piece.end + ') / 共 ' + piece.length + ' 字符：\n' + piece.text,
  };
}

/** 读取结构化运行轨迹（原 get_run_trace）。 */
export async function getRunTrace(deps: any, args: Record<string, unknown>) {
  const rec = args && args.runId ? await deps.getTrace(String(args.runId)) : (await deps.listTraces())[0];
  if (!rec) return { ok: true, result: '暂无运行轨迹。' };
  const lines = (rec.entries || []).map((e: any) => {
    const t = new Date(e.ts).toLocaleTimeString('zh-CN');
    if (e.phase === 'tool') return t + ' [tool] ' + e.name + ' ' + (e.ok ? '✓' : '✗') + ' ' + (e.ms || 0) + 'ms ' + (e.args || '');
    if (e.phase === 'start') return t + ' [start] intent=' + e.intent + ' ' + (e.instruction || '');
    if (e.phase === 'complete') return t + ' [complete] ' + (e.reason || '') + ' tokens=' + (e.totalTokens || 0);
    if (e.phase === 'timeout') return t + ' [timeout] ' + (e.reason || '');
    if (e.phase === 'error') return t + ' [error] ' + (e.error || '');
    return t + ' [' + e.phase + ']';
  });
  // 轨迹之外，附一份聚合指标：单看逐条记录说明不了"这轮贵在哪"，聚合后才有基线。
  const summary = formatRunMetrics(summarizeRunTrace(rec.entries));
  return { ok: true, result: '运行轨迹 ' + rec.runId + '（' + lines.length + ' 条）：\n' + lines.join('\n') + '\n\n' + summary };
}

/** 该族处理哪些工具名。 */
export const RUN_STATE_TOOLS = new Set(['update_plan', 'expand_result', 'get_run_trace']);

/** 统一入口（由 executeTool 分派）。返回 null 表示"不属于本族"。 */
export async function handleRunStateTool(name: string, args: Record<string, unknown>, deps: any) {
  if (name === 'update_plan') return updatePlan(deps.ctx, args);
  if (name === 'expand_result') return expandResult(deps.ctx, args);
  if (name === 'get_run_trace') return await getRunTrace(deps, args);
  return null;
}

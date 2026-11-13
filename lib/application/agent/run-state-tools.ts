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
import { rangeSafe } from '../../shared/surrogates.ts';
import { summarizeRunTrace, formatRunMetrics } from './run-metrics.ts';
import { describePlanStep, normalizePlanStep, planContractViolations } from './plan-contract.ts';
import type { RunCtx } from './types.ts';
import type { RunStateDeps } from './tool-deps.ts';

/** 更新计划条（原 update_plan）。 */
export function updatePlan(ctx: RunCtx, args: Record<string, unknown>) {
  const raw: Array<Record<string, unknown>> = Array.isArray(args && args.items) ? (args.items as Array<Record<string, unknown>>) : [];
  // 先过滤再归一化，但保留**同一份**原始条目：契约校验要回看模型到底写了什么
  // （verify 写成字符串时归一化会静默丢弃，只有原始值能说清原因）。
  const kept = raw
    .filter((it: Record<string, unknown>) => it && typeof it.text === 'string' && it.text.trim())
    .slice(0, 20);
  const plan = kept.map((it: Record<string, unknown>, index: number) => normalizePlanStep(it, index));
  const violations = planContractViolations(kept, plan);
  if (violations.length) {
    // 拒绝时**不动** ctx.plan / planVersion：模型拿到理由后同一轮重写即可，
    // 半成品计划留给快路只会让它在一个没有判据的步骤上动作。
    return {
      ok: false,
      result:
        '计划未生效（原计划保持不变）：\n- ' + violations.join('\n- ') + '\n\n' +
        '修好再提交：声明 CLICK 的步骤补一个 verify —— 打开新页用 {"urlChanged":true}，' +
        '出现预期文案用 {"textIncludes":"…"}，列表变长用 {"minElementDelta":1}；' +
        '若本步不需要快路点击，把 allowedOperations 收窄成 ["READ_PAGE"]（只读交给快路），' +
        '或写 [] 表示本步完全由你来做。',
    };
  }
  ctx.plan = plan;
  ctx.planVersion = Math.max(0, Number(ctx.planVersion) || 0) + 1;
  const text = plan
    .map((p, i) =>
      (p.status === 'done' ? '✓' : p.status === 'in_progress' ? '▶' : '○') +
      ' ' +
      (i + 1) +
      '. ' +
      describePlanStep(p)
    )
    .join('\n');
  // 2026-11-12 的 CSDN 发布轨迹：模型用了 update_plan，但 59 条计划记录里
  // 一条 nextAction 都没有，委托于是全程空转。字段存在不够，必须在这一步
  // 就把「下一步可以委托」摆到它眼前。
  const pending = plan.find((p) => p.status === 'in_progress');
  const hints: string[] = [];
  if (pending && !pending.allowedOperations) {
    // 缺 allowedOperations 时协调器会整轮关掉快路（fail-safe），但模型看不到这件事；
    // 不提醒的话它会以为快路在"考虑"，实际一次都没启动。
    hints.push(
      '本步骤没有 allowedOperations，快路整轮不会启动。若本步有页内机械动作，' +
        '写成 ["READ_PAGE","CLICK"] 并配 verify；只要快路读页面则写 ["READ_PAGE"]。'
    );
  }
  if (pending && !pending.nextAction) {
    hints.push(
      '当前步骤没有 nextAction。如果下一步是**当前页面内的机械点击/按键**' +
        '（不写值、不跳站），请补上它，例如 {"tool":"click_element","name":"添加文章标签"}；' +
        '快路会在你这一轮之后直接执行，省一次往返。填值（type_text/select_option）' +
        '与导航（open_tab）不要写进 nextAction。'
    );
  }
  return { result: '计划已更新（' + plan.length + ' 步）：\n' + (text || '（空计划）') + (hints.length ? '\n\n提示：' + hints.join('\n') : '') };
}

/**
 * 分段读取被截断的工具结果（原 expand_result）。
 *
 * 两条失败文案是**有意写清楚**的，不要简化：结果只存在于本次运行的暂存里，
 * 跨「继续」恢复后旧 id 的内容已释放。若只说"未找到"，模型会以为是自己记错了 id
 * 而反复重试同一个 id（实测空耗）。
 */
export function expandResult(ctx: RunCtx, args: Record<string, unknown>) {
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
  const nextOffset = piece.end < piece.length ? piece.end : null;
  return {
    ok: true,
    result:
      '结果 ' + id + ' [' + piece.start + ',' + piece.end + ') / 共 ' + piece.length + ' 字符' +
      (nextOffset === null ? '（已到末尾）' : '；下一段 offset=' + nextOffset) +
      '：\n' + piece.text,
  };
}

/** 读取结构化运行轨迹（原 get_run_trace）。 */
export async function getRunTrace(deps: RunStateDeps, args: Record<string, unknown>) {
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
export async function handleRunStateTool(name: string, args: Record<string, unknown>, deps: RunStateDeps) {
  if (name === 'update_plan') return updatePlan(deps.ctx, args);
  if (name === 'expand_result') return expandResult(deps.ctx, args);
  if (name === 'get_run_trace') return await getRunTrace(deps, args);
  return null;
}

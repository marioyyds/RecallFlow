// Tool timeout, live approval, and safe parallel batch execution.
import { executeAnyTool } from './mcp.ts';
import { getToolMetadata, validateToolCall } from './tools.ts';
import { toolNeedsApproval } from './approval-policy.ts';
import { planParallelGroups } from './parallel-tools.ts';
import { RUN_STATUS } from './agent-state.ts';
import { getAISettings } from '../../shared/settings.ts';
import type { Caught } from './errors.ts';

export function withTimeout(task: any, timeoutMs: number, signal?: AbortSignal, toolName?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // timer 先声明为 null：原先 `finish` 里直接引用后面才 `const` 的 timer，
    // 一旦有任何路径在 setTimeout 之前调用 finish，就会撞上 TDZ 抛 ReferenceError。
    let timer: any = null;
    const finish: any = (fn: any, value: any) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new DOMException('任务已取消', 'AbortError'));
    timer = setTimeout(() => {
      const err = new Error('工具执行超时') as Caught;
      // 打上标记，让调用方能把它与「工具自己抛的错」区分开 ——
      // 两者的含义完全不同：超时意味着**后果未知**，不是干净失败。
      err.rfToolTimeout = true;
      err.timeoutMs = timeoutMs;
      err.toolName = String(toolName || '');
      finish(reject, err);
    }, timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(task).then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}

/**
 * 现读「审批相关」的设置，覆盖运行开始时那份快照里的对应字段。
 *
 * 为什么必须有它：`settings` 是**本次运行开始时**读的一份快照（background.js 在
 * `runAgentStream` 之前 `getAISettings()` 一次），而审批开关就在面板输入框上方，
 * 用户**对话进行中随时会改**。只读快照的后果是两个方向的错：
 *   · 关掉之后还在弹 ——「我明明开了自动批准，它还是一个一个问」（用户实测报的就是这个）；
 *   · 打开之后不再问 —— 更糟：快照说"无需审批"，于是一次本该确认的写操作**直接执行**。
 * 所以每次决策都现读，而不是每次运行读一次。
 *
 * 只现读审批用到的四个字段，**不动工具 schema** —— schema 是请求前缀的一部分，
 * 中途改动会让整段前缀缓存失效（见 disabledTools 那段的说明），而审批与 schema 无关。
 *
 * 读失败时**沿用快照**：宁可多确认一次，也不能因为"读设置失败"而放行写操作（fail-closed）。
 */
export async function readLiveApprovalSettings(base: any, loader?: any) {
  const get = typeof loader === 'function' ? loader : getAISettings;
  const snapshot = base && typeof base === 'object' ? base : {};
  try {
    const s = (await get()) || {};
    return Object.assign({}, snapshot, {
      toolApproval: s.toolApproval,
      toolApprovalPolicy: s.toolApprovalPolicy || {},
      trustedSites: Array.isArray(s.trustedSites) ? s.trustedSites : [],
      codeExecutionApproval: s.codeExecutionApproval,
    });
  } catch (e) {
    return snapshot;
  }
}

/**
 * 并行预执行：把相邻的、可并发的工具调用成组跑掉，返回 原下标 -> { res, ms }。
 *
 * 只做「执行」这一件事：不碰 messages、不做任何后处理，因此调用方的串行循环
 * 可以完全不知道并发发生过 —— 所有顺序敏感的逻辑（tool 结果入栈顺序、
 * ctx 改写、guard 判定、complete_task 的提前返回）都留在原处，一行没动。
 *
 * 这是本仓库里第一处 Promise.all：在此之前，系统提示承诺的
 * 「一轮可以发出多个工具调用，不要一次一个地串行调用」从未被执行层兑现。
 */
// 导出是为了直接测这条**执行契约**（原先是模块内私有、零覆盖，于是 `remaining`
// 那个参数从没被传过、并行从未执行，也没有任何一层发现）。回归断言见
// tests/parallel-batch.test.mjs：两个 parallelSafe 调用必须真的被并发预执行。
export async function runParallelBatch(toolCalls: any, o: any) {
  const precomputed = new Map();
  if (!o.enabled) return precomputed;
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  // ⚠ 这里原先是 `Number(o.remaining) || 0`，但**调用点从不传 remaining**（全仓该标识符
  // 只在本文件出现过一次），于是 limit 恒为 0 ⇒ 恒走下面的 `limit < 2` 提前返回 ⇒
  // 并行从未真正执行过，而系统提示（intent-router 规则 12）已经向模型承诺了并发。
  // 组内并发数本来就由 planParallelGroups 的 maxBatch（默认 4）收敛，外层不需要再设闸门。
  // 回归断言见 tests/parallel-batch.test.mjs：两个 parallelSafe 调用必须都被预执行。
  const limit = calls.length;
  if (limit < 2) return precomputed;

  // 并行预执行**同样必须现读审批设置**，而且比串行路径更要紧：
  // 它决定"这个调用能不能先跑掉"。若沿用运行开始时的快照，而用户中途把某个类别
  // 改回「需要确认」，这里会以为无需审批而**直接把写操作执行掉** —— 那是漏批，
  // 比"多弹一次确认"严重得多。现读一次、这一轮里共用。
  o.approvalSettings = await readLiveApprovalSettings(o.settings);

  const groups = planParallelGroups(calls.slice(0, limit), {
    isParallelSafe: (name: string) => getToolMetadata(name).parallelSafe === true,
    shouldSkip: (name: string, args: Record<string, unknown>) => {
      // 三条安全边界：停用 / 参数非法 / 需要审批，任一命中就退回串行路径。
      // 判定条件与下面循环里的完全一致，避免"预执行了但循环会拒绝"的空转。
      if (o.disabledTools.has(name)) return true;
      if (!validateToolCall(name, args).ok) return true;
      return (
        o.approvalSettings.toolApproval !== false &&
        toolNeedsApproval(name, o.approvalSettings, o.ctx.pageUrl) &&
        !o.sessionApprovedTools.has(name)
      );
    },
  });
  if (!groups.length) return precomputed;

  for (const group of groups) {
    // 先把整组「开始执行」事件发出去：UI 应当同时看到这几个调用在执行中，
    // 而不是等它们全跑完才一起冒出来。callId 与循环里复用同一份。
    for (const i of group) {
      const tc = calls[i];
      o.emit({
        type: 'tool-call',
        callId: o.callIds[i],
        name: tc.name,
        args: tc.args,
        requiresApproval: false,
        risk: getToolMetadata(tc.name).risk,
      });
    }
    o.emitState(RUN_STATUS.EXECUTING);
    const toolsInGroup = group.map((i: any) => calls[i].name);
    o.trace({ phase: 'parallel-batch', iter: o.iter, size: group.length, tools: toolsInGroup });
    const wallStart = Date.now();

    const settled = await Promise.all(
      group.map(async (i: any) => {
        const tc = calls[i];
        const metadata = getToolMetadata(tc.name);
        const t0 = Date.now();
        // 登录拦截识别要看「动作前 URL → 动作后 URL」。并行执行时若不在调用点
        // 记下它，后处理阶段读到的 ctx.pageUrl 可能已经被同组另一个调用改掉。
        const beforeUrl = o.ctx.pageUrl;
        try {
          const res = await withTimeout(
            () => executeAnyTool(tc.name, tc.args, o.ctx),
            metadata.timeoutMs || o.budget.toolTimeoutMs,
            o.signal
          );
          return { index: i, res, ms: Date.now() - t0, beforeUrl };
        } catch (e) {
          // 单个工具失败不能拖垮整组（串行路径同样是 catch 后继续）。
          return {
            index: i,
            res: { result: e && (e as Caught).name === 'AbortError' ? '任务已取消。' : (e as Caught).message, ok: false },
            ms: Date.now() - t0,
            beforeUrl,
          };
        }
      })
    );
    for (const item of settled) precomputed.set(item.index, item);
    o.trace({ phase: 'parallel-batch-done', iter: o.iter, size: group.length, wallMs: Date.now() - wallStart, tools: toolsInGroup });
  }
  return precomputed;
}

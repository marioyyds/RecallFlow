// Agent completion checks, partial-answer fallback, and auxiliary-tab cleanup.
import { detachAll as detachAllCdp } from '../../backend/cdp.ts';
import { diagnoseConversation, repairConversation, formatProblems } from './conversation-guard.ts';
import { verifyCompletion } from './verifier.ts';
import { buildVerificationEvidence } from './verification-policy.ts';
import { streamAgentStep } from './stream-step.ts';
import { withTimeout } from './tool-execution.ts';
import type { Caught } from './errors.ts';

// 用最近页面证据做一次独立校验，判断目标是否真的达成。
//
// 证据不能只给「页面前 N 个字」：长页面上结论依据的事实往往在深处，校验方找不到就按
// 「证据不足」否决，把 agent 逼去做无谓的重新取证。这里改为按结论里的具体事实定位片段
// （selectEvidence），并显式告诉校验方「这是片段、不是全文」以及本次任务的性质。
async function runCompletionVerification(settings: any, instruction: string, res: any, ctx: any, signal: AbortSignal, taskKind: any) {
  return verifyCompletion(
    settings,
    {
      instruction,
      claim: String((res && res.result) || ''),
      evidence: buildVerificationEvidence(ctx, String((res && res.result) || '')),
      pageUrl: ctx.pageUrl,
      pageTitle: ctx.pageTitle,
      taskKind: taskKind || 'mutation',
    },
    signal
  );
}

// 任务结束时清理辅助页（两阶段）：这里只登记待关闭页，保留最后使用的 tab 与用户原本的 tab。
// 真正的关闭由后台在“最终消息已落盘”的 ack 之后执行。
//
// 为什么不能在这里直接关：面板 DOM 与最后一轮 assistant 消息的保存都在发起标签页。
// 辅助页可能也显示着同一面板；先关页会让最终回复只存在于即将销毁的 DOM 里
//（实测：repositories 辅助页关闭后，用户说「可以」之后的整轮回答消失）。
async function closeAuxTabs(ctx: any) {
  // 任务结束释放 CDP 调试会话（无论是否开过标签页），隐藏「正在调试」提示条。
  try { detachAllCdp(); } catch (e) {}
  if (!ctx) return [];
  const opened = Array.isArray(ctx.openedTabs) ? ctx.openedTabs : [];
  if (!opened.length) {
    ctx.pendingCloseTabs = [];
    ctx.pendingCloseWindowId = Number.isInteger(Number(ctx.agentWindowId)) ? Number(ctx.agentWindowId) : null;
    return [];
  }
  const keep = new Set();
  if (Number.isInteger(Number(ctx.tabId))) keep.add(Number(ctx.tabId));
  if (Number.isInteger(Number(ctx.originalTabId))) keep.add(Number(ctx.originalTabId));
  const toClose = opened.filter((id: any) => Number.isInteger(Number(id)) && !keep.has(Number(id)));
  ctx.pendingCloseTabs = toClose.slice();
  ctx.pendingCloseWindowId = Number.isInteger(Number(ctx.agentWindowId)) ? Number(ctx.agentWindowId) : null;
  return toClose;
}

function emitTabsClosePending(ctx: any, tabIds: number[], emit: any) {
  const ids = Array.isArray(tabIds) ? tabIds.filter((id) => Number.isInteger(Number(id))) : [];
  const windowId = Number.isInteger(Number(ctx && ctx.pendingCloseWindowId)) ? Number(ctx.pendingCloseWindowId) : null;
  if (!ids.length && !windowId) return;
  emit({ type: 'tabs-close-pending', tabIds: ids, windowId });
}

// 触底收尾：预算 / 超时 / 卡死触顶时，不再干巴巴报错，而是让模型基于已经拿到的
// 工具结果生成一份尽可能完整、诚实的最终回复（已完成哪些步骤、得到什么、还差什么、接下来怎么做）。
// 用空工具集调用模型，避免继续触发工具；失败时退回一句简短说明。
async function finalizeWithPartialInfo(port: any, settings: any, messages: any, signal: AbortSignal, emit: any, tools: any) {
  const finalMessages = (Array.isArray(messages) ? messages : []).concat([
    {
      role: 'user',
      content:
        '（系统提示：本任务的工具调用已触发安全上限，无法继续执行更多操作。）' +
        '请基于上面你已经获得的信息，给出一份「决策建议」而不是简单总结，按以下结构输出：\n' +
        '1) 当前进展：已完成哪些步骤、得到什么结果；\n' +
        '2) 卡点：哪一步没完成、为什么（预算用尽 / 某步失败 / 等待超时）；\n' +
        '3) 结尾一句引导：告诉用户直接回复做法名即可继续。\n' +
        '正文之后，必须在最后单独输出一个「程序可读」的 JSON 选项块（非常重要，必须严格遵守）：' +
        '整块以 <options> 开头、以 </options> 结尾，中间是合法 JSON 数组，不要掺任何其他文字。' +
        '每个元素含 label 与 desc：label 是简短做法名（不超过 8 个汉字，例如“继续当前方案”“改用抓取”“手动接管”），' +
        'desc 用一句话说明该做法、预期结果与需要用户做什么。必须输出 2~3 个选项。示例：\n' +
        '<options>\n' +
        '[{"label":"继续当前方案","desc":"需要你批准更多调用额度，预计再 2 步完成"},' +
        '{"label":"改用抓取","desc":"用 fetch_webpage 直接抓取内容，无需新开页"},' +
        '{"label":"手动接管","desc":"你先手动打开页面，再回复继续"}]' +
        '\n</options>\n' +
        '不要声称执行过实际没有执行的操作。',
    },
  ]);
  // 收尾请求是**最后一道关口**，必须自己校验一次结构：
  // 它绕过了主循环里的出站校验（那是挂在 streamAgentStep 调用点上的），
  // 而调用它的路径恰恰都是"半途中断"——卡住检测 stop、工具预算触顶、时长/成本超限。
  // 这些时刻 messages 很可能停在「assistant 声明了 N 个 tool_call，只答复了前 k 个」，
  // 直接发出去就是一个空响应体的 400，用户连收尾建议都拿不到。
  const problems = diagnoseConversation(finalMessages);
  if (problems.length) {
    const repaired = repairConversation(finalMessages);
    console.log('[RecallFlow] 收尾请求的会话结构非法，已修复：' + formatProblems(problems) + '（' + finalMessages.length + ' → ' + repaired.length + ' 条）');
    finalMessages.length = 0;
    for (const m of repaired) finalMessages.push(m);
    emit({ type: 'verify', ok: null, reason: '收尾请求的历史结构与工具调用配对不一致，已自动修正后重试。' });
  }
  try {
    // 关键：照样把当前 tools 数组发出去，只用 tool_choice='none' 禁止继续调工具。
    // 传空数组会让请求从 token 0 就与前面各轮不同（工具定义是前缀的一部分），
    // 于是本次要重新 prefill 整段历史 —— 而这是整个 run 里最长的一次请求。
    const callFinalize = (withTools: any) =>
      withTimeout(
        () => streamAgentStep(port, settings, finalMessages, signal, withTools ? tools || [] : [], emit, withTools ? 'none' : undefined),
        25000
      );
    let step = await callFinalize(true);
    // 兜底：「带 tools 但 tool_choice=none」是官方文档写明支持的组合，但不同 API 世代
    // 未必一致。一旦它被 400 拒绝，用户就彻底拿不到收尾建议了 ——
    // 前缀缓存是优化，能拿到结论才是功能，所以这里退回改动前的写法重试一次。
    if (step && step.error && /\b400\b/.test(String(step.error))) {
      console.log('[RecallFlow] finalize 带 tools 被拒（400），退回无 tools 重试');
      emit({ type: 'verify', ok: null, reason: '收尾请求带工具定义被服务端拒绝，已退回无工具模式重试。' });
      step = await callFinalize(false);
    }
    if (step && step.error) throw new Error(step.error);
    // streamAgentStep 已把内容实时流式输出到前端，这里无需重复 emit。
    return true;
  } catch (e) {
    if (e && (e as Caught).name === 'AbortError') return false;
    emit({ type: 'chunk', text: '\n\n（无法生成补充回答，任务已在安全上限处停止。）' });
    return false;
  }
}

export {
  closeAuxTabs,
  emitTabsClosePending,
  finalizeWithPartialInfo,
  runCompletionVerification,
};

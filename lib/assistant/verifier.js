// 任务校验器（Verifier）：在 Agent 声称完成时，用一次轻量 LLM 调用独立判断目标是否真的达成，
// 依据只有「用户目标 + 声称结果 + 页面证据」。未达成则返回反思，让 Agent 换个做法继续，而不是草草收尾。
//
// ## 实测成本（真模型探针，用于校准"它到底贵不贵"）
//
//   剧本                      总请求  Agent  校验器  否决
//   site-search（只读）            6      5      1     0
//   recover-from-rejection       18     16      2     1（**合理**：回执里显示的是选项 value
//                                                      `coffee-a × 1`，与声称的商品名不一致 ——
//                                                      模型补充说明"那是它的 value"后通过）
//
// 即校验器约占请求量的 **11%~17%**，且**否决是有依据的**。
// 早先"失败恢复那一轮成本主要来自校验器反复要证据（25~33 次请求）"的说法**与数据不符**：
// 那些请求绝大多数是 Agent 自己的多步工作（逐步校验暴露邀请码 → 补齐 → 重试）。
// 现在每次真模型 eval 都会单独打印校验器调用数，失控会立刻看得见。
import { callDeepSeek, makeAbortError } from './llm.js';

export const VERIFIER_SYSTEM = `你是 RecallFlow 的任务校验器。根据「用户目标」「Agent 声称的结果」「本次任务性质」和「页面/环境证据」，判断目标是否真的达成。
只输出严格 JSON：
{"ok": true|false, "confidence": 0~1的小数, "reason": "一句话结论", "missing": "未达成时还差什么", "suggestion": "未达成时下一步的具体建议"}

**先读「本次任务性质」，两类的判据不同：**

【mutation：本次有页面写操作】问「页面是否真的按要求变了」。
- 只依据给出的证据，不臆测；看不到对应状态或结果时判 ok=false 并说明缺什么证据。
- 「移除 / 隐藏 / 清干净」类目标不能用关键词是否出现来否定：正文摘要按 textContent 抽取，
  **包含已隐藏节点以及 Agent 自己注入的标注文字** —— 搜到关键词并不等于它还看得见。
  这类判断只认可**可见性证据**（如「可见 N 次 / DOM M 次」的核查结果，或 getComputedStyle 检查）。
  若 Evidence 里缺少可见性维度，请在 missing 中指出「需要可见性核查证据」。

【read：本次只有读取类操作】问「结论与页面是否矛盾、是否有据」。
- 这类任务没有「状态变化」可验证，所以判据是**一致性与依据**，不是「证据能否覆盖结论的全部细节」。
- 只有这两种情况才判 ok=false：
  ① 你能指出**具体矛盾** —— 证据中的内容与结论冲突（如结论说「共 3 项」而证据显示是别的数）；
  ② 结论里的关键事实**完全找不到任何依据**，且证据已充分覆盖该部分。
- **不要**因为「证据里没有出现结论提到的某个词」就判未达成。证据是按结论中的具体事实抽取的
  **片段**，不是全文；未列出的部分不代表不存在。若确实觉得缺依据，请把它写进 missing，
  并说明需要哪一段原文，而不是直接判 false。

通用：
- 若目标本身是闲聊 / 无需任何操作，判 ok=true。
- **不要用「页面标题」推断页面状态**：标题常常只是会话名 / 文档名 / 浏览器标签名，
  与页面内容无关。实测有页面标题叫「MCP SDK package missing error」，而那只是侧边栏里
  一条会话的名字，页面本身完全正常 —— 仅凭标题就推断「这是错误页」会直接判错。
  要判断页面状态，请看证据正文（是否有报错元素、正文是什么内容）。
- 不要因为 Agent 说「已完成」就采信；要看证据。`;

// 校验调用的超时。原先 15 秒（且沿用了"一次性请求 + 重试"的通用链路）——
// 长任务里证据更密、判决更难，实测很容易撞线，一撞线就整条任务收不了尾。
// 25 秒 + 禁止重试（超时重试只是把等待乘三倍）是这对矛盾的折中。
export const VERIFIER_TIMEOUT_MS = 25000;

// 校验只需要一小段结构化结论：限输出长度 + 要求 JSON。
// 不设上限时模型可能自由长篇输出，把预算耗在生成上；不要求 JSON 时一旦输出成散文，
// 解析失败就 fail-open —— 护栏静默失效，而用户只看到"已按通过放行"。
const VERIFIER_MAX_TOKENS = 400;

// 返回 { ok, confidence, reason, missing, suggestion } 或 null（校验失败时调用方按“通过”处理，避免阻塞）。
export async function verifyCompletion(settings, { instruction, claim, evidence, pageUrl, pageTitle, taskKind }, signal) {
  if (!settings || !settings.apiKey) return null;
  const kind = taskKind === 'read' ? 'read（本次只有读取类操作，没有改动页面）' : 'mutation（本次有页面写操作）';
  const user = [
    '用户目标：' + String(instruction || '').slice(0, 1000),
    'Agent 声称的结果：' + String(claim || '').slice(0, 1000),
    '本次任务性质：' + kind,
    '当前页面：' + (pageTitle || '') + ' | ' + (pageUrl || ''),
    'Evidence（含「最近一次动作的回执」与「页面相关片段」，片段**不是全文**）：\n' +
      (String(evidence || '').slice(0, 8000) || '（无）'),
  ].join('\n\n');
  // 用户已经中断就别再花一次校验请求（15 秒 + 一次计费），也不要伪装成「校验器故障」——
  // 那条分支会往下走 "已按通过放行"，进而把一次「我按了停止」变成「任务已完成」。
  if (signal && signal.aborted) throw makeAbortError();
  try {
    const content = await callDeepSeek(
      Object.assign({}, settings, {
        requestTimeoutMs: VERIFIER_TIMEOUT_MS,
        maxTokens: VERIFIER_MAX_TOKENS,
        jsonMode: true,
        // 校验器**不重试**：它是 fail-open 的安全网，重试换不来护栏强度，只换来卡顿。
        // 单次预算 25s，而默认的 2 次重试会把最坏等待推到 ≈76s（25+0.5+25+1+25），
        // 这正是"卡在校验阶段"的第三个来源 —— 前两个是超时误判与缺结束事件。
        // 实测探针里就出现过「1 次真实校验被记成 3 条请求」的现象。
        maxRetries: 0,
      }),
      [
        { role: 'system', content: VERIFIER_SYSTEM },
        { role: 'user', content: user },
      ],
      signal
    );
    const jsonText = (String(content || '').match(/\{[\s\S]*\}/) || [content])[0];
    const parsed = JSON.parse(jsonText);
    return {
      ok: parsed.ok === true,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      reason: String(parsed.reason || '').slice(0, 200),
      missing: String(parsed.missing || '').slice(0, 300),
      suggestion: String(parsed.suggestion || '').slice(0, 300),
    };
  } catch (e) {
    // ⚠ 判据只能是 **signal 本身**，不是错误类型。
    //   内部超时（llm.js 里那个 setTimeout → controller.abort()）抛出的也是 AbortError，
    //   与用户按停止**长得一模一样**。原先按 `e.name === 'AbortError'` 判中断，
    //   于是一次 15 秒没等到响应 = 一次「用户点了停止」= 任务被静默终止
    //   （而且那条分支当时还不发 end 事件，面板会永远转圈）。
    //   现在：signal 被 abort ⇒ 抛中断；其余（超时 / 网络 / 400 / 解析失败）一律 fail-open。
    if (signal && signal.aborted) throw makeAbortError();
    return null;
  }
}

/**
 * 由「同一份证据被重复送审」构造反思消息。
 *
 * 为什么需要单独一条：被否决后，模型最省力的反应是把总结换个说法、再调一次 complete_task ——
 * 而页面证据一个字节都没变。同样的输入 + 同样的提示词会得到同样的否决，于是用户看到的
 * 就是"反复校验"。重复送审不该再花一次模型调用，更不该给一条和上次一样的建议
 *（那只会诱发第三次重复）。这条消息把话挑明：**问题不在措辞，在于没有新证据。**
 */
export function buildRepeatedVerificationReflection() {
  return [
    '（自我校验未通过）页面状态和你的总结与上次被否决时**完全一致**，没有任何新证据 ——',
    '同样的证据必然得到同样的结论，换个说法再提交一次不会有不同结果。',
    '请二选一：',
    '· 先做出能产生新证据的动作（重新读取页面 / 用 checkTexts 做可见性核查 / 补齐真正缺失的那一步），再声称完成；',
    '· 确认做不到就如实说明卡在哪里，不要再用同样的证据重复收尾。',
  ].join('\n');
}

// 由校验结果构造给 Agent 的反思消息。
export function buildVerificationReflection(verdict) {
  const parts = ['（自我校验未通过）上一轮声称已完成，但独立校验认为目标尚未达成。'];
  if (verdict && verdict.reason) parts.push('校验结论：' + verdict.reason);
  if (verdict && verdict.missing) parts.push('还差：' + verdict.missing);
  if (verdict && verdict.suggestion) parts.push('建议：' + verdict.suggestion);
  parts.push('请先核对页面真实状态，换个做法继续（不要重复刚才已失败的动作）；确实无法完成就如实说明卡点。');
  return parts.join('\n');
}

/**
 * 由卡死警告构造反思消息。
 *
 * 为什么要按成因分派（原先是**一个模板走天下**）：
 * 「重复调用」「连续失败」「无进展」是三种**不同的处境**，该给的建议也不同 ——
 *   · 重复：动作本身可能是对的，问题在于"原样再来一次"，该换参数或换工具；
 *   · 连续失败：动作根本没生效，该先查前置条件（元素在不在、可见、可点击）；
 *   · 无进展：做了一串动作页面却没反应，该先重新读取状态，别继续猜。
 * 统一成一句"换种方式"时，模型拿不到可执行的下一步，于是最常见的反应是
 * 把同一个动作再试一次 —— 那正是这套机制要打破的循环。
 *
 * 第二层是**梯度**：第一次提醒只给方向；到第三档（attempt>=3）时必须给出
 * "如实收尾"这个出口，否则模型会在同一个动作上一直耗到预算触顶。
 *
 * @param {string} message 守卫给出的具体描述
 * @param {Object} [opts]
 * @param {string} [opts.reason] maxSameToolCalls / toolFailStreak / noProgress
 * @param {number} [opts.attempt] 第几次提醒（1 起）
 */
export function buildStuckReflection(message, opts = {}) {
  const head = '（反思）' + (message || '连续动作没有产生可观察进展');
  const attempt = Number(opts && opts.attempt) > 0 ? Number(opts.attempt) : 1;
  const advice = adviceFor(opts && opts.reason, attempt);
  // 第三档起必须明确给出"收尾"这个出口：没有出口的催促只会让模型继续耗到预算触顶。
  const exit =
    attempt >= 3
      ? '\n这已经是第 ' + attempt + ' 次提醒了：如果确认这个动作本身是对的（例如只是在等页面渲染），' +
        '就直接按当前已知情况作答并说明卡点；不要为了"再试一次"继续消耗。'
      : '';
  return head + '\n' + advice + exit;
}

function adviceFor(reason, attempt) {
  if (reason === 'maxSameToolCalls') {
    return (
      '你正在用**完全相同的参数**重复同一个动作。先确认它是不是幂等轮询（等渲染 / 等跳转）：\n' +
      '· 是等待 ⇒ 换 wait_for_element 明确等待，或就此收尾，不要靠重复调用来"等"；\n' +
      '· 不是等待 ⇒ 换一组参数或换一个工具（role+name / testid / text 换一种定位方式），别原样再来。'
    );
  }
  if (reason === 'toolFailStreak') {
    return (
      '这个工具连续失败，问题多半不在"再试一次"，而在**前置条件**：\n' +
      '· 目标是否真的存在、可见、可交互（先 get_page_snapshot / inspect_element 确认）；\n' +
      '· 是否被遮挡、禁用或在 iframe / shadow DOM 里；\n' +
      '· 合成事件不生效时改走 CDP（get_ax_snapshot + click_at）。'
    );
  }
  if (reason === 'noProgress') {
    return (
      '做了一串动作但页面没有可观察变化。先**重新读取当前状态**再决定：\n' +
      '· get_page_snapshot 确认刚才的动作到底生效没有（超时 ≠ 没生效）；\n' +
      '· 页面是否弹出了对话框、跳转或被遮挡；\n' +
      '· 确认无变化后，换一条路径或如实说明做不到。'
    );
  }
  return (
    '请分析卡点并换一种方式：更换定位方式（role+name / testid / text）、换用其它工具、' +
    '改用 CDP（get_ax_snapshot + click_at）、或先等待/关闭遮挡；不要重复同样的动作。' +
    (attempt >= 2 ? '' : '')
  );
}

// 任务校验器（Verifier）：在 Agent 声称完成时，用一次轻量 LLM 调用独立判断目标是否真的达成，
// 依据只有「用户目标 + 声称结果 + 页面证据」。未达成则返回反思，让 Agent 换个做法继续，而不是草草收尾。
import { callDeepSeek } from './llm.js';

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
  try {
    const content = await callDeepSeek(
      Object.assign({}, settings, { requestTimeoutMs: 15000 }),
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
    return null;
  }
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

// 由卡死警告构造反思消息。
export function buildStuckReflection(message) {
  return (
    '（反思）' + (message || '连续动作没有产生可观察进展') +
    '\n请分析卡点并换一种方式：更换定位方式（role+name / testid / text）、换用其它工具、改用 CDP（get_ax_snapshot + click_at）、或先等待/关闭遮挡；不要重复同样的动作。'
  );
}

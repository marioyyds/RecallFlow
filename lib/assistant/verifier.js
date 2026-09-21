// 任务校验器（Verifier）：在 Agent 声称完成时，用一次轻量 LLM 调用独立判断目标是否真的达成，
// 依据只有「用户目标 + 声称结果 + 页面证据」。未达成则返回反思，让 Agent 换个做法继续，而不是草草收尾。
import { callDeepSeek } from './llm.js';

const VERIFIER_SYSTEM = `你是 RecallFlow 的任务校验器。根据「用户目标」「Agent 声称的结果」和「当前页面/环境证据」，判断目标是否真的达成。
只输出严格 JSON：
{"ok": true|false, "confidence": 0~1的小数, "reason": "一句话结论", "missing": "未达成时还差什么", "suggestion": "未达成时下一步的具体建议"}

判断原则：
- 只依据给出的证据，不臆测；证据不足以证明达成时，判 ok=false 并说明缺少什么证据。
- 若目标本身是闲聊 / 无需任何操作，判 ok=true。
- 若声称「已打开 / 已点击 / 已填写 / 已发送 / 已完成」，但证据里看不到对应状态或结果，判 ok=false。
- 不要因为 Agent 说「已完成」就采信；要看证据。`;

// 返回 { ok, confidence, reason, missing, suggestion } 或 null（校验失败时调用方按“通过”处理，避免阻塞）。
export async function verifyCompletion(settings, { instruction, claim, evidence, pageUrl, pageTitle }, signal) {
  if (!settings || !settings.apiKey) return null;
  const user = [
    '用户目标：' + String(instruction || '').slice(0, 1000),
    'Agent 声称的结果：' + String(claim || '').slice(0, 1000),
    '当前页面：' + (pageTitle || '') + ' | ' + (pageUrl || ''),
    '证据（页面快照/正文摘要，可能不完整）：\n' + (String(evidence || '').slice(0, 4000) || '（无）'),
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

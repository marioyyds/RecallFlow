// 页面动作的「验证字段」装配（从 tools.js 抽出的第二个模块）。
//
// 抽取动机：这组函数决定了 `executed / verified / changed / hadEffect` 等字段，
// 而 **agent 的卡死检测、进展判定与完成校验全靠它们**。它们此前混在 tools.js 的
// chrome.* 与运行上下文之间，很难单独理解或单测；这里把它们收敛成一个纯模块：
// 输入是"命令 + 前后快照 + 内容脚本回执"，输出是结构化判定，不碰任何外部状态。
//
// 为什么值得单独成模块（而不只是搬行）：这些字段曾经**长期被硬编码成 true**
//（7 处 CDP 路径），导致卡死检测永远认为在推进、完成校验失去意义。
// 把语义集中到一处以后，"什么情况下可以声称 verified"这件事只有一个答案。
//
import type { ActionVerification, PageSnapshotLike, ToolResult } from './types.ts';

// 三态语义（与 buildActionVerification 一致）：
//   executed    动作已派发（不表示产生了页面变化）
//   changed     是否观测到页面变化
//   verified    这个结论是否被真实观测支持过
//   unobservable 无法观测时**不得**声称已验证

/** 不可观测的结论（如视觉标注层不计入内容指纹）。 */
export function buildActionVerification(observed: string, reason: string): ActionVerification {
  const text = String(reason || '');
  if (observed === 'changed') return { executed: true, verified: true, changed: true, reason: text };
  if (observed === 'unchanged') return { executed: true, verified: true, changed: false, reason: text };
  return { executed: true, verified: false, changed: false, reason: text };
}

/**
 * 比较前后两次页面快照的指纹，得出「是否观测到变化」。
 * 快照自带 fingerprint（由 page-text.js 计算），因此这是零额外成本的判断。
 */
export function observedChange(before: PageSnapshotLike | null | undefined, after: PageSnapshotLike | null | undefined) {
  if (!after || typeof after.fingerprint !== 'string') return 'unobservable';
  if (!before || typeof before.fingerprint !== 'string') return 'unobservable';
  return before.fingerprint === after.fingerprint ? 'unchanged' : 'changed';
}

/** 前后快照是否发生可观察变化（URL / 内容指纹 / 滚动位置）。 */
export function snapshotChanged(before: PageSnapshotLike | null | undefined, after: PageSnapshotLike | null | undefined, command: string) {
  if (!before || !after) return false;
  if (before.url !== after.url) return true;
  if (before.fingerprint && after.fingerprint && before.fingerprint !== after.fingerprint) return true;
  if (
    (command === 'scroll_to' || command === 'scroll_by') &&
    before.scroll && after.scroll &&
    (before.scroll.x !== after.scroll.x || before.scroll.y !== after.scroll.y)
  ) {
    return true;
  }
  return false;
}

/**
 * 由「命令 + 前后快照 + 内容脚本回执」判定动作是否生效。
 *
 * 注意 `visualOnly` 这一档：视觉标注（高亮/描边/改样式/清标注）的效果在**独立的浮层宿主**里，
 * 而页面指纹刻意排除了标注层（否则同一动作前后只因裁剪边界不同就会造成假变化）。
 * 因此这些命令**无法**通过内容指纹验证 —— 它们的 verified 来自"动作已派发"这一事实，
 * 而不是来自"观测到了变化"。这是有意的取舍，不是漏洞；但**不得**用它去声称 changed。
 */
export function verifyPageAction(command: string, before: PageSnapshotLike | null | undefined, after: PageSnapshotLike | null | undefined, response: ToolResult | null | undefined): ActionVerification {
  const executed = Boolean(response && response.ok !== false);
  const urlChanged = Boolean(before && after && before.url !== after.url);
  const contentChanged = Boolean(before && after && before.fingerprint !== after.fingerprint);
  const scrollChanged = Boolean(before && after && before.scroll && after.scroll &&
    (before.scroll.x !== after.scroll.x || before.scroll.y !== after.scroll.y));
  const visualOnly = ['highlight', 'outline', 'set_style', 'clear_highlights'].includes(command);
  const responseChanged = Boolean(response && (response.changed || response.hadEffect));
  const responseSatisfied = Boolean(response && response.alreadySatisfied);
  const eventOnly = command === 'press_key';
  const changed = urlChanged || contentChanged || scrollChanged || responseChanged;
  let reason = executed ? '动作已执行' : '页面命令返回失败';
  if (command === 'click' && executed && !changed) reason = '点击已派发，但页面快照暂未观察到变化';
  if (command.indexOf('scroll') === 0 && executed && !scrollChanged) reason = '滚动已派发，但滚动位置未变化';
  if (visualOnly && executed) reason = '视觉标注动作已执行；标注层不计入内容指纹';
  if (command === 'type_text' && executed && responseSatisfied) reason = '目标输入已处于要求状态';
  else if (command === 'type_text' && executed && !changed) reason = '输入事件已派发，但快照未观察到值状态变化';
  if (command === 'press_key' && executed) reason = '键盘事件已派发';
  return {
    executed,
    verified: executed && (changed || responseSatisfied || visualOnly || eventOnly || command === 'get_text'),
    changed,
    urlChanged,
    contentChanged,
    scrollChanged,
    reason,
  };
}

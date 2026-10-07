// 面板「选择跟哪条 DSH 会话说话」的**纯逻辑**（可单测；DOM 与消息往返留在 lib/page/chat.js）。
//
// 为什么单独成模块：这个功能最怕两件事 ——
//   ① 选了一条**不存在**的会话，消息却进了别的对话（插件侧已用 404 挡住；这里负责"显示的选项"）；
//   ② 切了会话，界面上却还混着**别的会话**的消息（过滤错了，用户会以为消息串了）。
// 两条都属于"看起来能用、实际不可信"，所以把能判定的部分抽出来钉住。

/** 会话 id 很长（`session-<uuid>`），界面上只需要一个能区分的短标签。 */
export function shortSessionId(id) {
  const s = String(id || '');
  if (!s) return '';
  return s.length <= 14 ? s : '…' + s.slice(-12);
}

/**
 * 这条会话事件帧**现在**该不该渲染？
 *
 * - 没选（chosen 为空）= **旧行为**：全都渲染（面板一直就是"这条会话"的视图）。
 * - 选了 = 只渲染那条会话的帧。
 * - 帧里没有 sessionId（投影失败、或很老的帧）= **不隐藏** —— 宁可多显示，
 *   也不要让用户以为"切了会话以后消息丢了"。
 */
export function shouldRenderSessionFrame(frame, chosenSessionId) {
  const chosen = String(chosenSessionId || '').trim();
  if (!chosen) return true;
  const sid = String((frame && frame.sessionId) || '').trim();
  if (!sid) return true;
  return sid === chosen;
}

/** 选项排序：最近活动的在前；没有时间的沉底；同分保持原顺序（稳定排序）。 */
export function sortSessionChoices(list, currentSessionId = '') {
  const arr = Array.isArray(list) ? list.slice() : [];
  return arr
    .map((it, i) => ({
      id: String((it && it.id) || ''),
      lastAt: Number((it && it.lastAt) || 0),
      isCurrent: String((it && it.id) || '') === String(currentSessionId || '').trim(),
      _i: i,
    }))
    .filter((it) => it.id)
    .sort((a, b) => b.lastAt - a.lastAt || a._i - b._i);
}

/**
 * 选择器上那句「这条消息会进哪条会话」的文案。
 *
 * 刻意把「没选（跟随最近活跃）」与「指定了某条」分得很清楚 —— 这个功能最容易出的错
 * 就是"用户以为发给了 A，实际进了 B"，而那种错**不会报错**，只能靠界面说清。
 */
export function describeSessionChoice(chosenSessionId, currentSessionId = '') {
  const chosen = String(chosenSessionId || '').trim();
  if (!chosen) return '跟随最近活跃（未指定）';
  const cur = String(currentSessionId || '').trim();
  if (chosen === cur) return '指定：' + shortSessionId(chosen) + '（就是最近活跃那条）';
  return '指定：' + shortSessionId(chosen);
}

/**
 * 选中的会话**还在不在**列表里？
 *
 * 不在时界面必须说清（例如"这条会话已不在列表里，消息可能发不出去"），
 * 而不是照旧显示得像没事 —— 用户点发送时才会撞上 404。
 */
export function chosenStillExists(chosenSessionId, list) {
  const chosen = String(chosenSessionId || '').trim();
  if (!chosen) return true;
  return (Array.isArray(list) ? list : []).some((it) => String((it && it.id) || '') === chosen);
}

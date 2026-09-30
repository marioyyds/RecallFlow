/**
 * 会话事件 → 面板条目 的**纯逻辑**（新架构：只有一条会话，面板是它的一个视图）。
 *
 * 为什么单独放这里：这段判断（渲染哪些事件、怎么去掉回声导致的重复）如果写进
 * lib/page/chat.js，就只能靠人眼在浏览器里验；抽成纯函数后可以在 node 里钉住。
 * 这与仓库既有的分层一致：lib/shared 放可测的纯逻辑，lib/page 只做 DOM。
 *
 * 与旧版 renderBridgeEvent 的区别：旧版渲染的是"另一个 agent 干了什么"
 * （say/tool 形状，需要映射成文案）；新版直接就是会话本身的消息
 * （user/message、assistant/message），因此这里不做任何映射。
 * 只处理这两类 —— 其余（工具活动、inbox 变动等）一律不进面板，避免噪音。
 */

/** 面板里用来标记"这条来自会话"的 source 值。 */
export const SESSION_SOURCE = 'session';

/**
 * 判断一个 WS 帧是否是要渲染的会话事件。
 * @returns {{ ok: boolean, reason: string }}
 */
export function classifyFrame(frame) {
  if (!frame || frame.kind !== 'session-event' || !frame.event) {
    return { ok: false, reason: '不是会话事件帧' };
  }
  const ev = frame.event;
  const text = String(ev.text == null ? '' : ev.text).trim();
  if (!text) return { ok: false, reason: '无文本（工具活动等不进面板）' };
  if (ev.type === 'user/message') {
    // **有 sourceKind 时以它为准**。
    // 教训（我的第一版写成 role==='user' || sourceKind==='user'，被自己的测试抓住）：
    // DSH 会把系统运行时上下文也发成 user/message 且 role 为 user，只是 source.kind 是
    // 'runtime-context'。按"或"的写法，那段系统话会被当成**用户说的话**显示在面板上 ——
    // 这正是早前修过的同一个坑，换个入口又踩了一次。
    const isUser = ev.sourceKind ? ev.sourceKind === 'user' : ev.role === 'user';
    return isUser ? { ok: true, reason: '用户消息' } : { ok: false, reason: 'user/message 但来源不是用户：' + ev.sourceKind };
  }
  if (ev.type === 'assistant/message') return { ok: true, reason: '助手消息' };
  return { ok: false, reason: '不属于要渲染的类型：' + String(ev.type) };
}

/**
 * 把一帧会话事件变成面板要做的动作。
 *
 * 返回值：
 *   { action: 'skip', reason }
 *   { action: 'append', who, line, echoText }        —— who 为 'user' | 'dsh'
 *   { action: 'mark-local', index, reason }          —— 与本地已有的用户回合重复（回声）
 *
 * 关于回声：用户从面板发出去的话会进会话，随后又从会话回声回来。
 * 如果不处理，同一句话会显示两遍。这里用"文本 + 最近若干条"匹配本地那条并标记，
 * **这是过渡期的权宜**：彻底的做法是面板不再自己存用户回合
 * （下一步：面板退役自己的 agent、只当视图），那时这条分支自然会消失。
 * 之所以没有用 rpcId 精确匹配：面板目前拿不到它 —— 需要插件把 rpcId 一并回传，
 * 那是下一步的事；先用保守的文本匹配，并把这个局限写在这里。
 *
 * @param {object} frame - WS 帧
 * @param {Array<{role?:string, content?:string, echoedFromSession?:boolean}>} conversation - 现有会话（只读）
 * @param {number} lookback - 往回找多少条（默认 8）
 */
export function sessionEntryFromFrame(frame, conversation = [], lookback = 8) {
  const cls = classifyFrame(frame);
  if (!cls.ok) return { action: 'skip', reason: cls.reason };

  const ev = frame.event;
  const text = String(ev.text).trim();
  const isUser = ev.type === 'user/message';

  if (isUser) {
    const start = Math.max(0, conversation.length - lookback);
    for (let i = conversation.length - 1; i >= start; i--) {
      const m = conversation[i];
      if (!m) continue;
      if (m.role !== 'user') continue;
      if (m.echoedFromSession) continue;
      if (String(m.content == null ? '' : m.content).trim() !== text) continue;
      return { action: 'mark-local', index: i, reason: '与本地用户回合同文，判为回声' };
    }
  }

  // 角色可见、来源不可见（用户原话："不用刻意说消息是那一边的"，但"谁在说"要保留）
  return { action: 'append', who: isUser ? 'user' : 'dsh', line: (isUser ? '你：' : '') + text, echoText: isUser ? text : '' };
}

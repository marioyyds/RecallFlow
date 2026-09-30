// 面板对话的「增量上报」规则（纯函数，可直测）。
//
// 背景（实测到的缺陷）：
//   面板把用户回合 push 进 conversation 后**没有立刻调用 saveConversation()**
//   （chat.js 里 push 在 1853 行，最近的一次保存是之前的 1818 与之后的 2127）。
//   而最初的上报实现每次只取"最新一条" —— 于是保存发生时最新的是**助手**回合，
//   用户回合被整个跳过，反向同步里永远看不到"用户在面板里问了什么"。
//
// 修法：不按"最新一条"推送，而是按**已推条数**增量推送 —— 无论保存发生在哪里，
// 没推过的回合都会在下次保存时被带出去。
//
// 为什么用"已推条数"而不是"数组下标"：会话里会 splice 掉过期的 external 条目
// （见 chat.js 的 MAX_EXTERNAL_TURNS），下标会被挪动；而 user/assistant 的相对顺序
// 是稳定的，按它们自己的计数来锚定就不会错位。

/** 需要上报的会话角色。external 是 DSH 自己推来的，回推会形成回环。 */
export const SPEAK_ROLES = Object.freeze(['user', 'assistant']);
export const MAX_TURNS_PER_PUSH = 10;

/** 会话里"会说人话"的条目（有内容、且角色是 user/assistant）。 */
export function isSpeakTurn(m) {
  return Boolean(m) && SPEAK_ROLES.includes(m.role) && typeof m.content === 'string' && m.content.length > 0;
}

/**
 * 取出尚未上报的回合。
 * @param conversation 会话数组
 * @param alreadyPushed 之前已经上报过多少个 speak 回合
 * @returns { turns, pushed } —— turns 是要上报的（可能为空），pushed 是新的计数
 */
export function newSpeakTurns(conversation, alreadyPushed, max = MAX_TURNS_PER_PUSH) {
  const list = Array.isArray(conversation) ? conversation : [];
  const done = Number.isFinite(Number(alreadyPushed)) && Number(alreadyPushed) > 0 ? Math.floor(Number(alreadyPushed)) : 0;
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : MAX_TURNS_PER_PUSH;
  const speak = list.filter(isSpeakTurn);
  // 计数大于实际（说明会话被清空 / 回退编辑截断过）：**归零重推**，而不是把
  // base 抬到 speak.length —— 后者意味着"全部已推过"，会让这个页面**从此永久静默**，
  // 那是比重复推送严重得多的故障（重复只是缓冲里多几行，静默是功能没了）。
  const base = done > speak.length ? 0 : done;
  const turns = speak.slice(base, base + cap);
  return { turns, pushed: base + turns.length };
}

/** 统计会话里有多少个 speak 回合（用于载入历史后初始化计数，避免把旧内容重推一遍）。 */
export function countSpeakTurns(conversation) {
  const list = Array.isArray(conversation) ? conversation : [];
  return list.filter(isSpeakTurn).length;
}

/**
 * 取**最近**的若干个 speak 回合（注意与 newSpeakTurns 的方向相反：那个从最老的未推项开始）。
 *
 * 用途：载入既有历史时同步一次。此前只在 saveConversation 里上报，而**载入不触发保存** ——
 * 于是「面板的历史能在 DSH 里看到」要等用户下一次在面板里说话才成立，不符合需求。
 * 只取最近若干条，避免一次把整段历史刷进桥接；重复由服务端连续去重兜住
 * （每次页面加载都会走到这里）。
 */
export function recentSpeakTurns(conversation, max = MAX_TURNS_PER_PUSH) {
  const list = Array.isArray(conversation) ? conversation : [];
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : MAX_TURNS_PER_PUSH;
  const speak = list.filter(isSpeakTurn);
  return speak.slice(Math.max(0, speak.length - cap));
}

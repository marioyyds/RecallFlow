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
 * 已知的"系统注入上下文"开头 —— 它们会以 user/message 出现，但**不是用户说的话**。
 *
 * 为什么要除了 source.kind 再按文本判：旧实现（已删的 session-map.js，函数名就叫
 * isInjectedUserMessage）就是**两层都做**，说明实践里真遇到过 kind 缺失或取值不同的情况。
 * 第二层是兜底，不是重复 —— 而且这一层的成本是一行字符串比较。
 * 漏掉的后果很具体：一段 "Current runtime context…" 会以「你：」起头显示在面板上，
 * 看起来像用户自己说的话。
 */
const INJECTED_TEXT_PREFIXES = Object.freeze(['Current runtime context', 'This snapshot supersedes']);

/**
 * 工具调用的单行摘要：最多挑两个短标量字段，形如（label=面板渲染检查 method=page_health）。
 *
 * 为什么不直接 JSON.stringify(args)：那会把一个对象铺成十几行，而面板是窄条。
 * 旧实现（已删的 renderBridgeEvent）正是用白名单取字段，面板上显示的就是
 * `⚙ page_screenshot（label=面板渲染检查）` 这种一眼能读的形式 —— 这里沿用同样的取舍。
 * 对象/数组一律跳过：它们在窄条里只会变成噪音。
 */
export function summarizeToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const out = [];
  for (const [k, v] of Object.entries(args)) {
    if (out.length >= 2) break;
    if (v === null || v === undefined || typeof v === 'object') continue;
    const s = String(v).replace(/\s+/g, ' ').trim();
    if (!s) continue;
    out.push(k + '=' + (s.length > 40 ? s.slice(0, 40) + '…' : s));
  }
  return out.length ? '（' + out.join(' ') + '）' : '';
}

/**
 * 判断一个 WS 帧是否是要渲染的会话事件。
 * @returns {{ ok: boolean, reason: string }}
 */
export function classifyFrame(frame) {
  if (!frame || frame.kind !== 'session-event' || !frame.event) {
    return { ok: false, reason: '不是会话事件帧' };
  }
  const ev = frame.event;
  // 工具**调用**画一行（"agent 正在做什么"）。这是刻意保留的行为，不是噪音：
  // 用户在页面里调试时，看得见"它正在读控制台/截图"比只看到一句结论有用。
  // 只画调用、不画结果 —— 两者都画会让一次调用占两行（旧实现也是这个取舍）。
  if (ev.type === 'tool/call') {
    return ev.tool ? { ok: true, reason: '工具调用' } : { ok: false, reason: 'tool/call 但没有工具名' };
  }
  // 工具**失败**画一行（成功的结果不画 —— 一次调用只占一行，旧实现同样的取舍）。
  // 插件侧已经把"成功的结果"过滤掉了，这里再判一次 failed：宁可漏画，不可把成功画成失败。
  if (ev.type === 'tool/result') {
    return ev.failed === true && ev.tool
      ? { ok: true, reason: '工具失败' }
      : { ok: false, reason: '工具结果（成功的、或没有工具名的不进面板）' };
  }
  const text = String(ev.text == null ? '' : ev.text).trim();
  if (!text) return { ok: false, reason: '无文本（工具结果等不进面板）' };
  if (ev.type === 'user/message') {
    // **有 sourceKind 时以它为准**。
    // 教训（我的第一版写成 role==='user' || sourceKind==='user'，被自己的测试抓住）：
    // DSH 会把系统运行时上下文也发成 user/message 且 role 为 user，只是 source.kind 是
    // 'runtime-context'。按"或"的写法，那段系统话会被当成**用户说的话**显示在面板上 ——
    // 这正是早前修过的同一个坑，换个入口又踩了一次。
    const isUser = ev.sourceKind ? ev.sourceKind === 'user' : ev.role === 'user';
    // 第二层防御：source.kind 缺失或取值不同时，靠文本开头识别系统注入（见常量处的说明）。
    if (isUser && INJECTED_TEXT_PREFIXES.some((p) => text.startsWith(p))) {
      return { ok: false, reason: '系统注入的上下文，不是用户说的话' };
    }
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
 * 如果不处理，同一句话会显示两遍。这里优先用 **rpcId 精确匹配**
 * （面板发送时记下插件回传的 rpcId，回声带着同一个 id 回来）；
 * rpcId 缺失时退回"文本 + 最近若干条"的保守匹配 —— 那条退路在同一句话说两遍时
 * 必然分不清，所以只当兜底。彻底的做法是面板不再自己存用户回合
 * （删除清单第 1 步：面板退役自己的 agent），那时这条分支会自然消失。
 *
 * @param {object} frame - WS 帧
 * @param {Array<{role?:string, content?:string, echoedFromSession?:boolean}>} conversation - 现有会话（只读）
 * @param {number} lookback - 往回找多少条（默认 8）
 */
export function sessionEntryFromFrame(frame, conversation = [], lookback = 8) {
  const cls = classifyFrame(frame);
  if (!cls.ok) return { action: 'skip', reason: cls.reason };

  const ev = frame.event;
  const isUser = ev.type === 'user/message';

  // 工具失败：单独一行 —— 这是"出错"信号，混在成功的工具行里会被忽略。
  if (ev.type === 'tool/result') {
    return {
      action: 'append',
      who: 'dsh',
      line: '✗ 调用 ' + String(ev.tool) + ' 失败：' + String(ev.error || '未提供原因'),
      echoText: '',
    };
  }

  // 工具调用：画一行"它正在做什么"（不画结果，否则一次调用占两行）。
  if (ev.type === 'tool/call') {
    return {
      action: 'append',
      who: 'dsh',
      line: '⚙ ' + String(ev.tool) + summarizeToolArgs(ev.args),
      echoText: '',
    };
  }

  const text = String(ev.text).trim();

  if (isUser) {
    // 首选 **rpcId 精确匹配**：面板发出去时记下了插件回传的 rpcId，回声带着同一个 id 回来。
    // 这条通路建立之前只能靠"文本 + 最近若干条"猜，同一句话说两遍就分不清。
    const rpcId = ev.rpcId ? String(ev.rpcId) : '';
    if (rpcId) {
      for (let i = conversation.length - 1; i >= 0 && i >= conversation.length - lookback; i--) {
        const m = conversation[i];
        if (m && m.role === 'user' && !m.echoedFromSession && m.rpcId === rpcId) {
          return { action: 'mark-local', index: i, reason: 'rpcId 精确匹配' };
        }
      }
    }
    // 退路：文本匹配（rpcId 还没回填完，或对方不是从面板发出来的）。
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

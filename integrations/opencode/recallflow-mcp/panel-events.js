// 面板事件：把「外部 agent（DSH）正在对这个页面做什么」变成可显示的事件。
//
// 背景（用户反馈："dsh 和 recallflow 的对话没有同步"）：
// MCP 是**客户端发起**的 —— DSH 调工具时服务端看得见，但 DSH 的对话文字永远不经过服务端，
// 也无法被推送回扩展。因此这条链路能同步的是**动作**（工具调用），以及 DSH **主动**投递的话。
// 被动镜像 DSH 的全部对话需要 DSH 侧插件（方案 B），或去 tail 它的私有 session 日志
// （session.v4.jsonl.zstd：压缩、带版本号、已迁移 4 版）—— 后者工程上不可接受。
//
// 本模块只做**事件成形**（纯函数）：决定用户看到什么文本、以及体积上限。
// 队列与投递在 index.js，转发在 lib/bridge/relay.js，渲染在 lib/page/chat.js。

export const EVENT_KINDS = Object.freeze(['tool', 'say']);
export const MAX_EVENT_TEXT = 400;
export const MAX_ARG_CHARS = 160;

/** 把任意值压成单行、限长的可读文本（面板是窄条，长了会很难看）。 */
export function oneLine(value, max = MAX_EVENT_TEXT) {
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : MAX_EVENT_TEXT;
  let s;
  if (value === null || value === undefined) s = '';
  else if (typeof value === 'string') s = value;
  // Error 必须特判：JSON.stringify(new Error('boom')) === '{}'，
  // 而失败事件最需要显示的就是错误内容 —— 显示 '{}' 等于什么都没说。
  else if (value instanceof Error) s = (value.name || 'Error') + ': ' + (value.message || '');
  else {
    try {
      const j = JSON.stringify(value);
      s = j === undefined ? String(value) : j;
    } catch (e) {
      s = String(value);
    }
  }
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > cap ? s.slice(0, cap) + '…' : s;
}

/**
 * 工具调用参数的展示摘要：只挑最能说明"在干什么"的字段，避免把整包参数塞进事件。
 * 未命中白名单时退化为「前几个键」的简短形式。
 */
export function summarizeToolArgs(args, max = MAX_ARG_CHARS) {
  if (!args || typeof args !== 'object') return '';
  const KEYS = ['url', 'selector', 'ref', 'text', 'label', 'hash', 'name', 'id', 'query', 'targets', 'limit'];
  const picked = [];
  for (const k of KEYS) {
    if (args[k] === undefined || args[k] === null || args[k] === '') continue;
    picked.push(k + '=' + oneLine(args[k], 40));
    if (picked.length >= 3) break;
  }
  if (!picked.length) {
    // 兜底路径同样要跳过空值：显示 "url=" 是噪音，不携带任何信息。
    // 注意只跳过 undefined/null/''，0 与 false 是有意义的取值，要保留。
    for (const k of Object.keys(args)) {
      const v = args[k];
      if (v === undefined || v === null || v === '') continue;
      picked.push(k + '=' + oneLine(v, 40));
      if (picked.length >= 3) break;
    }
  }
  return oneLine(picked.join(' '), max);
}

export function toolStartEvent(tool, args, now) {
  return {
    kind: 'tool',
    phase: 'start',
    tool: String(tool || ''),
    args: summarizeToolArgs(args),
    at: Number.isFinite(Number(now)) ? Number(now) : 0,
  };
}

export function toolEndEvent(tool, ok, ms, error, now) {
  return {
    kind: 'tool',
    phase: 'end',
    tool: String(tool || ''),
    ok: ok !== false,
    ms: Number.isFinite(Number(ms)) ? Math.max(0, Math.round(Number(ms))) : 0,
    error: error ? oneLine(error, 200) : '',
    at: Number.isFinite(Number(now)) ? Number(now) : 0,
  };
}

export function sayEvent(text, level, now, who) {
  const body = oneLine(text, MAX_EVENT_TEXT);
  return {
    kind: 'say',
    text: body,
    level: level === 'warn' ? 'warn' : 'info',
    // who 区分"谁在说话"：用户在 DSH 里的提问 / DSH 自己的留言。
    // 面板据此换前缀，避免把用户的话显示成 agent 的话。
    who: who === 'user' ? 'user' : 'dsh',
    at: Number.isFinite(Number(now)) ? Number(now) : 0,
  };
}

/**
 * 归一化**外部提交**的事件（DSH 的 hooks 通过 POST /event 送进来）。
 *
 * 为什么要有外部入口：MCP 是客户端发起的，服务端只看得到 RecallFlow 自己的 MCP 工具调用；
 * 而 DSH 的 hooks 能看到**每一个**工具调用（bash / 读写文件 / 其它 MCP server），
 * 以及用户提交的提示词。两者合起来才是"这次会话到底发生了什么"。
 *
 * 接受几种宽松形态（hook 脚本来自 shell，容错优先）：
 *   { text, level?, who? }               → say
 *   { kind:'say', text, level?, who? }   → say
 *   { kind:'tool', tool, phase?, args? } → tool
 * @returns 成形的事件；无法识别时返回 null（调用方据此返回 ok:false，不静默吞掉）
 */
export function normalizeExternalEvent(payload, now) {
  if (!payload || typeof payload !== 'object') return null;
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (payload.kind === 'tool' || (payload.tool && !payload.text)) {
    const tool = String(payload.tool || '').trim();
    if (!tool) return null;
    const phase = payload.phase === 'end' ? 'end' : 'start';
    if (phase === 'end') {
      return Object.assign(toolEndEvent(tool, payload.ok !== false, payload.ms, payload.error, t), { source: 'external' });
    }
    return Object.assign(toolStartEvent(tool, payload.args || {}, t), { source: 'external' });
  }
  const text = String(payload.text || '').trim();
  if (!text) return null;
  return Object.assign(sayEvent(text, payload.level, t, payload.who), { source: 'external' });
}

/** 事件是否成形可用（投递前最后一道校验，避免把垃圾推给面板）。 */
export function isValidEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (!EVENT_KINDS.includes(ev.kind)) return false;
  if (ev.kind === 'say') return typeof ev.text === 'string' && ev.text.length > 0;
  if (ev.kind === 'tool') return typeof ev.tool === 'string' && ev.tool.length > 0;
  return false;
}
// 注意：显示文案（前缀、图标）**不在这里** —— 那是面板的职责。
// 扩展侧不应依赖 integrations/ 目录，跨包共享只放"形状与取值域"，不放展示细节。

/**
 * 事件队列的裁剪规则：只保留最近 max 条。
 * 面板是"最近发生了什么"的视图；服务端积压太多（扩展长时间未轮询）时，
 * 丢掉最老的比无限增长更合理。
 */
export function trimEventQueue(list, max = 200) {
  const arr = Array.isArray(list) ? list : [];
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : 200;
  return arr.length > cap ? arr.slice(arr.length - cap) : arr.slice();
}

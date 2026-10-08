// 请求前缀哨兵（运行时）：逐轮比对出站消息，任何「历史中部被改写」都会当场现形。
//
// 为什么需要它 —— 静态门禁（scripts/check-prefix-stability.mjs）只做词法检查，
// 不做调用图分析：如果有人在主循环里调用一个*内部*会 slice/splice 历史消息的函数，
// 门禁看不到。当年 syncPlanMessage 就是这个形态：改写发生在循环外的闭包里，
// 触发却在循环内，所有测试全绿，唯一症状是「越跑越慢」。
//
// 这里把判定放到运行时，比较的是**实际要发出去的 messages**，因此不依赖任何
// 关于「谁改了它」的假设：只要前缀不是 append-only，就直接指出在第几条、
// 是什么形态（改写 / 插入 / 删除 / 截断）、以及那条消息长什么样。
//
// 配合 DeepSeek 返回的 prompt_cache_hit_tokens / prompt_cache_miss_tokens，
// 就能把「前缀为什么没命中」从一个猜测变成一条指名道姓的日志。

import { canonicalize } from './tool-guard.js';

/** 单条消息的稳定指纹。
 *
 * 刻意用 canonicalize（键序无关的递归序列化）而不是手写字段列表：
 * 请求体是 JSON.stringify(messages)，**任何**可枚举属性的增删都会改变发出的字节。
 * 手写 role/content/tool_calls 这三个字段的话，将来有人给消息挂一个新属性
 * （例如把某个状态塞进消息对象）就会静默破坏前缀，而哨兵看不见。
 * 键序无关是必要的：键序变化不影响请求内容，不应误报。
 */
export function fingerprintMessage(m) {
  if (!m || typeof m !== 'object') return '';
  return canonicalize(m);
}

/** 便于日志定位的短标签：角色 + 内容开头。 */
function headOf(m) {
  if (!m || typeof m !== 'object') return '';
  let text = typeof m.content === 'string' ? m.content : m.content === undefined ? '' : JSON.stringify(m.content);
  if (!text && Array.isArray(m.tool_calls) && m.tool_calls.length) {
    text = 'tool_calls:' + m.tool_calls.map((tc) => (tc && tc.function && tc.function.name) || '?').join(',');
  }
  return String(text || '').replace(/\s+/g, ' ').slice(0, 48);
}

/** 把一轮出站消息压成快照：只留指纹与短标签，避免长期持有整段历史。 */
export function snapshotMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => ({
    fp: fingerprintMessage(m),
    role: (m && m.role) || '',
    head: headOf(m),
  }));
}

/**
 * 比较两次出站快照。stable=true 表示「新一轮以旧一轮为前缀，只在末尾追加」。
 * @returns {{stable:boolean, reason:string, divergeAt:number, prevLength:number, nextLength:number, detail:string}}
 */
export function diffSnapshots(prev, next) {
  const a = Array.isArray(prev) ? prev : [];
  const b = Array.isArray(next) ? next : [];
  // 注意：base 必须最先展开。写成 { ...divergeAt: i, ...base } 会让 base 里的
  // divergeAt: -1 把真实定位覆盖掉 —— 哨兵于是"看见了却说不清在哪"。
  const base = { prevLength: a.length, nextLength: b.length };

  const n = Math.min(a.length, b.length);
  const prevIndex = new Map();
  for (let k = 0; k < a.length; k++) if (!prevIndex.has(a[k].fp)) prevIndex.set(a[k].fp, k);
  const nextFps = new Set(b.map((x) => x.fp));

  for (let i = 0; i < n; i++) {
    if (a[i].fp === b[i].fp) continue;

    // 定位形态：
    //  - 旧消息在新快照里彻底消失 → 被改写/删除了
    //  - 旧消息还在、新消息是条全新的 → 前面被插进了东西，把位置顶开了
    const oldSurvives = nextFps.has(a[i].fp);
    const newIsBrandNew = !prevIndex.has(b[i].fp);
    const reason = !oldSurvives ? 'rewritten' : newIsBrandNew ? 'inserted' : 'rewritten';
    const detail =
      'msg#' + i + ' 旧[' + a[i].role + '] "' + a[i].head + '" → 新[' + b[i].role + '] "' + b[i].head + '"';
    return { ...base, stable: false, reason, divergeAt: i, detail };
  }

  if (b.length < a.length) {
    return {
      ...base,
      stable: false,
      reason: 'truncated',
      divergeAt: b.length,
      detail: '消息数由 ' + a.length + ' 减少到 ' + b.length,
    };
  }

  return { ...base, stable: true, reason: 'appended', divergeAt: -1, detail: '' };
}

/** 用于日志/trace 的一行摘要。 */
export function formatPrefixReport(diff) {
  if (!diff || diff.stable) return 'prefix append-only（+' + ((diff && diff.nextLength - diff.prevLength) || 0) + ' 条）';
  return 'prefix changed at ' + diff.reason + '：' + diff.detail + '（' + diff.prevLength + ' → ' + diff.nextLength + ' 条）';
}

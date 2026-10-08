// 出站会话结构校验：在把 messages 发给服务端**之前**判断它是否合法。
//
// 动机是一个真实故障：模型在一轮里发了多个工具调用（含 complete_task），
// 完成前校验判定「没真完成」时跳出工具循环去注入反思，
// 但同一条 assistant 消息里剩下的 tool_call 没拿到结果。
// 下一轮请求就带着「有 tool_calls、无对应 tool 结果」的消息发出去，
// **服务端只回一个空的 400**（实测响应体为空），从报错里完全看不出原因，
// 只能靠人肉读代码找到那两处 break。
//
// 所以这里做两件事：
//   ① diagnose：用一句人能读懂的话指出**第几条消息、属于哪一类结构错误**
//   ② 交给既有的 sanitizeToolPairing 修复（它本来就是为这个语义写的）
//
// OpenAI / DeepSeek 的共同约束（也就是这里检查的全部内容）：
//   - assistant 带 tool_calls 时，其后的消息必须逐个答复**每一个** id
//   - 答复必须是紧跟其后的 tool 消息，中间不能插入 user/system
//   - tool 消息必须能对应到前面某个未答复的 id（不能是孤儿）
//   - 未答复完之前不能出现下一条 assistant 消息
//   - content 必须是字符串或数组（缺字段同样非法）

const CONTENT_OK = (m) => typeof m.content === 'string' || Array.isArray(m.content);

/**
 * @param {Array} messages
 * @returns {Array<{index:number, code:string, detail:string}>} 空数组表示结构合法
 */
export function diagnoseConversation(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const problems = [];
  const add = (index, code, detail) => problems.push({ index, code, detail });

  // 最近一条带 tool_calls 的 assistant 消息中，尚未被答复的 id
  let pending = null; // { index:number, ids:Set<string> }

  const openCalls = (m, i) => {
    const ids = new Set();
    for (const tc of m.tool_calls) {
      const id = tc && tc.id;
      if (typeof id !== 'string' || !id) add(i, 'empty-tool-call-id', 'assistant 的 tool_calls 里有缺失/空的 id');
      else ids.add(id);
    }
    pending = { index: i, ids };
  };

  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m !== 'object') {
      add(i, 'not-an-object', '消息不是对象');
      continue;
    }

    if (m.role === 'assistant') {
      if (pending && pending.ids.size) {
        add(
          i,
          'unanswered-tool-calls',
          '第 ' + pending.index + ' 条 assistant 的 tool_calls 还没答复完，就出现了下一条 assistant 消息'
        );
        pending = null;
      }
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) openCalls(m, i);
      // assistant 允许 content 为空字符串（纯工具调用轮），但缺字段仍会被序列化掉
      if (m.content === undefined && !(Array.isArray(m.tool_calls) && m.tool_calls.length)) {
        add(i, 'missing-content', 'assistant 消息既没有 content 也没有 tool_calls');
      }
      continue;
    }

    if (m.role === 'tool') {
      if (!pending || !pending.ids.size) {
        add(i, 'orphan-tool-result', 'tool 消息前面没有等待答复的 assistant tool_calls');
      } else {
        const id = m.tool_call_id;
        if (typeof id !== 'string' || !id || !pending.ids.has(id)) {
          add(i, 'tool-result-id-mismatch', 'tool 消息的 tool_call_id 与任何未答复的 id 都不匹配：' + String(id));
        } else {
          pending.ids.delete(id);
        }
      }
      if (!CONTENT_OK(m)) add(i, 'missing-content', 'tool 消息缺少 content（服务端要求必填）');
      continue;
    }

    // system / user
    if (pending && pending.ids.size) {
      add(
        i,
        'interrupted-tool-pairing',
        '第 ' + pending.index + ' 条 assistant 的 tool_calls 之间插入了 ' + m.role + ' 消息'
      );
      pending = null;
    }
    if (!CONTENT_OK(m)) add(i, 'missing-content', m.role + ' 消息缺少 content');
  }

  if (pending && pending.ids.size) {
    add(
      list.length,
      'unanswered-tool-calls',
      '第 ' + pending.index + ' 条 assistant 声明了 ' + pending.ids.size + ' 个 tool_call，但一直没有对应的 tool 结果'
    );
  }

  return problems;
}

/** 把问题列表压成一行，用于日志/trace。 */
export function formatProblems(problems) {
  if (!Array.isArray(problems) || !problems.length) return '';
  return problems.map((p) => '#' + p.index + ' ' + p.code).join('; ');
}

const normContent = (m) => {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content;
  return '';
};

/**
 * 一次性修复所有结构性错误，并保证 `diagnoseConversation(repairConversation(x))` 为空。
 *
 * 为什么不能直接用既有的 `sanitizeToolPairing`：它只处理「结果缺失 / 孤儿结果」，
 * 但**修不好配对被打断**（tool_calls 与它的结果之间插进了 user 消息）——
 * 实测那种输入过它一遍之后仍然非法。用它当兜底等于"记完日志照样发非法请求"。
 *
 * 策略是重建而不是打补丁：只保留能一对一、且连续挨在一起配对的 assistant+tool 组，
 * 其余一律丢弃。宁可少一轮上下文，也不要再出现看不懂的空 400。
 */
export function repairConversation(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  let i = 0;

  while (i < list.length) {
    const m = list[i];
    if (!m || typeof m !== 'object') {
      i += 1;
      continue;
    }

    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      // 收集紧随其后的连续 tool 消息
      const results = new Map();
      let j = i + 1;
      while (j < list.length && list[j] && list[j].role === 'tool') {
        const r = list[j];
        if (typeof r.tool_call_id === 'string' && r.tool_call_id && !results.has(r.tool_call_id)) {
          results.set(r.tool_call_id, r);
        }
        j += 1;
      }
      const ids = m.tool_calls.map((tc) => tc && tc.id);
      const idsOk =
        ids.every((id) => typeof id === 'string' && id) &&
        new Set(ids).size === ids.length &&
        ids.every((id) => results.has(id) && CONTENT_OK(results.get(id)));
      if (idsOk) {
        out.push(Object.assign({}, m, { content: normContent(m) }));
        for (const id of ids) out.push(results.get(id));
      }
      // 配不齐就整组丢弃（assistant 连同它的结果），因为 assistant 留着必然非法
      i = j;
      continue;
    }

    if (m.role === 'tool') {
      // 走到这里说明它不属于任何能配对的组 → 孤儿，丢弃
      i += 1;
      continue;
    }

    out.push(Object.assign({}, m, { content: normContent(m) }));
    i += 1;
  }

  return out;
}

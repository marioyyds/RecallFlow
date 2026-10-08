// 对话记录导出：把面板的 parts 数据模型渲染成 markdown，用于「导出记录」按钮。
//
// 为什么不用 panelBody.textContent（最初的实现）：那样会掺入输入框 placeholder 与按钮
// 文字（「↶ 撤销 ⧉ 复制」），且用户与 AI 之间没有角色分隔，作为交给 AI 或贴进工单的记录
// 基本不可读。
//
// 为什么不做「全部叙述 → 全部工具」的分组（上一版实现）：那会丢掉**时序**。
// 面板里是 text → tool → text → tool 交错推进的，分组之后读起来像
// 「先一口气想完了所有话，再一口气把所有工具跑了一遍」——
// 「因为读到 X 才决定做 Y」这条因果链就断了，而这恰恰是记录要给人/AI 看的东西。
//
// 本模块是纯函数、不碰 DOM，因此可以直接在 node:test 里穷举各种 parts 形状。

/**
 * 这段文字是否已经作为叙述/text 记录过 —— 用于让面板避免把同一段最终答复记录两次。
 *
 * 放在本模块（纯函数）而不是 chat.js：chat.js 是内容脚本，import 就会碰 DOM，
 * 没法直接单测，而这里恰恰是个不该出错、出错了也只是「导出里同一句话出现两遍」的
 * 静默问题。
 *
 * 原判定是「紧邻的最后一个 part 是 narration 且文字相同」，两种情况下都会失效：
 *   1) 本轮最后一步是工具调用（complete_task 本身就是工具）→ 最后一个 part 是 tool-result；
 *   2) 上一次收尾已经 push 过同内容的 text part → 类型不是 narration。
 * 两种都会把同一段最终答复记两遍，导出里连着显示两次（实测 RF-27A7CA 记录末尾）。
 *
 * 改为：从末尾向前扫，**跳过工具类 part**（它们夹在文字之间是正常的时序），
 * 按内容比较，且 narration 与 text 都算。只比较最近的一段文字 ——
 * 隔了别的文字之后再说一遍同一句话，那是有意重复，不该被吞掉。
 */
export function alreadyCommittedAsText(parts, text) {
  const want = norm(text);
  if (!want) return false;
  const list = Array.isArray(parts) ? parts : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (!p) continue;
    if (p.type === 'tool-call' || p.type === 'tool-result' || p.type === 'screenshot') continue;
    if (p.type !== 'narration' && p.type !== 'text') continue;
    return norm(p.text) === want;
  }
  return false;
}

/** 结果文本压成单行并截断（用于工具结果这类散文；JSON 参数走 previewArgsJson，不能这么压）。 */
function clipInline(text, max) {
  const t = norm(text);
  if (!t) return '';
  return t.length > max ? t.slice(0, max) + '…（共 ' + t.length + ' 字符，已截断）' : t;
}

/** 空白归一：只用于**比较**与散文压缩，绝不用于 JSON 参数（会破坏原文）。 */
function norm(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
}

/**
 * 生成**永远结构合法**的参数预览。
 *
 * 为什么不能直接 `JSON.stringify(args).slice(0, 240)`（上一版实现）：那样会切出
 * `{"texts":["甲","乙","丙` 这种半截 JSON —— 记录里看起来像数据坏了，
 * 而它只是被截断了。这里改成「先按结构缩短值，再序列化」：
 * 长字符串尾部加省略号，数组只留前几项并补一个 `…共 N 项` 标记元素，
 * 结果始终是完整、可解析的 JSON。
 *
 * 仍然超长时退化为「只列字段名」，同样保证合法。
 */
export function previewArgsJson(args, maxLen = 240) {
  const shorten = (v, depth) => {
    if (typeof v === 'string') return v.length > 80 ? v.slice(0, 80) + '…' : v;
    if (Array.isArray(v)) {
      const cap = 3;
      const head = v.slice(0, cap).map((x) => shorten(x, depth + 1));
      if (v.length > cap) head.push('…共 ' + v.length + ' 项');
      return head;
    }
    if (v && typeof v === 'object') {
      if (depth >= 3) return '…';
      const o = {};
      for (const k of Object.keys(v)) o[k] = shorten(v[k], depth + 1);
      return o;
    }
    return v;
  };
  try {
    const json = JSON.stringify(shorten(args || {}, 0));
    if (json && json.length <= maxLen) return json;
    const keys = Object.keys(args || {});
    return JSON.stringify(keys.length ? { '…': '参数过长，字段：' + keys.slice(0, 8).join(', ') } : {});
  } catch (e) {
    // 循环引用等异常输入：宁可少给信息，也不要让导出整个失败
    return '{…}';
  }
}

function toolLine(p, result, maxResultLen) {
  const mark = !result ? '…' : result.status === 'completed' ? '✓' : result.status === 'failed' ? '✗' : '—';
  const args = previewArgsJson(p.args);
  const detail = clipInline(result ? result.result : '', maxResultLen);
  return '- `' + p.name + '` ' + args + ' → ' + mark + (detail ? ' ' + detail : '');
}

function screenshotLine(p) {
  const bits = [];
  if (p.label) bits.push(String(p.label));
  if (p.width && p.height) bits.push(p.width + '×' + p.height);
  if (p.bytes) bits.push(Math.round(Number(p.bytes) / 1024) + 'KB');
  return '- （截图' + (bits.length ? '：' + bits.join(' · ') : '') + '）';
}

/**
 * @param {object} input
 * @param {string} input.title 页面标题
 * @param {string} input.url 页面 URL
 * @param {string} input.exportedAt 导出时间（已格式化）
 * @param {string} [input.handoffId] 会话标识，形如 RF-XXXXXX
 * @param {Array} input.conversation 对话数据模型
 * @param {number} [input.maxResultLen] 单条工具结果的截断长度
 * @returns {string} markdown
 */
export function buildTranscript(input = {}) {
  const { title, url, exportedAt, handoffId, conversation, maxResultLen = 500 } = input;
  const out = [];
  out.push('# RecallFlow 对话记录');
  out.push('');
  out.push('- 页面：' + (title || '(无标题)'));
  out.push('- URL：' + (url || ''));
  out.push('- 导出时间：' + (exportedAt || ''));
  if (handoffId) {
    out.push('- 会话标识：' + handoffId + '（AI 可调用 recallflow_session("' + handoffId + '") 取回完整上下文）');
  }
  out.push('');

  const list = Array.isArray(conversation) ? conversation : [];
  if (!list.length) {
    out.push('（暂无对话）');
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  for (const m of list) {
    if (!m) continue;

    if (m.role === 'user') {
      out.push('## 用户');
      out.push('');
      out.push(String(m.content || ''));
      out.push('');
      continue;
    }

    out.push('## RecallFlow');
    out.push('');
    const parts = Array.isArray(m.parts) ? m.parts : [];
    // 工具结果先建索引：它总是跟在对应的 tool-call 之后，按下标顺序渲染时
    // 就能把两者合成一行，而不是多出一行「返回结果」。
    const results = new Map();
    const callIds = new Set();
    for (const p of parts) {
      if (!p) continue;
      if (p.type === 'tool-call') {
        if (p.callId) callIds.add(p.callId);
      } else if (p.type === 'tool-result' && p.callId && !results.has(p.callId)) {
        results.set(p.callId, p);
      }
    }

    let lastText = '';
    let lastToolText = '';
    // 去重的前提是「那段文字已经**完整**出现在上面」。工具行会按 maxResultLen 截断，
    // 所以拿工具结果做去重依据前必须确认它没被截断 —— 否则一段超过 maxResultLen 的
    // 最终答复会被叙述与结论两处同时挡掉，而工具行只剩前 maxResultLen 字：
    // 尾部整段丢失，且记录里完全看不出丢了东西。
    const fullyInline = (s) => Boolean(s) && s.length <= maxResultLen;
    // 工具行必须攒成**一个连续列表块**，块后再补一个空行。
    // 少了这个空行，紧跟其后的叙述会被 markdown 当成上一条列表项的延续
    // （lazy continuation），整段话被渲染进项目符号里 —— 这是实测踩到的。
    let pending = [];
    const flushTools = () => {
      if (!pending.length) return;
      out.push(...pending);
      out.push('');
      pending = [];
    };

    for (const p of parts) {
      if (!p) continue;
      // 叙述与工具**按原顺序**输出：这是本模块存在的理由，别改成分组
      if ((p.type === 'narration' || p.type === 'text') && p.text) {
        const t = String(p.text).trim();
        if (!t) continue;
        flushTools();
        // 面板在任务完成时会把这句作为叙述推给界面，而它的文本**就是**
        // complete_task 的返回结果 —— 同一段话会连着出现两次。这里按「与紧邻的
        // 工具结果逐字相同」精确去重，并要求工具行确实完整放下了它
        // （见 fullyInline：被截断时不能去重，否则那段文字就哪儿都没有了）。
        if (lastToolText && fullyInline(lastToolText) && norm(t) === lastToolText) continue;
        out.push(t);
        out.push('');
        lastText = t;
        continue;
      }
      if (p.type === 'tool-call') {
        const r = results.get(p.callId);
        pending.push(toolLine(p, r, maxResultLen));
        if (r) lastToolText = norm(r.result);
        else lastToolText = '';
        continue;
      }
      if (p.type === 'tool-result') {
        // 没有配对 tool-call 的孤儿结果（理论上不该出现）：照样记录下来，别静默丢
        if (!p.callId || !callIds.has(p.callId)) {
          pending.push(toolLine({ name: p.name, args: {} }, p, maxResultLen));
          lastToolText = norm(p.result);
        }
        continue;
      }
      if (p.type === 'screenshot') {
        // 上一版完全忽略了截图，导致记录里少一步且步数对不上
        pending.push(screenshotLine(p));
        continue;
      }
    }
    flushTools();
    out.push('');

    // 结论：最终文本已经在上面**完整**出现过时不再重复。
    // 两个来源都要判：最后一段叙述（叙述从不截断），或最后一个工具结果 ——
    // 后者是 complete_task 的常见情形，但仅当工具行完整放下了它才算数。
    const content = String(m.content || '').trim();
    const alreadyShownFull =
      Boolean(content) && (content === lastText || (fullyInline(lastToolText) && norm(content) === lastToolText));
    if (content && !alreadyShownFull) {
      out.push('### 结论');
      out.push('');
      out.push(content);
      out.push('');
    }
    if (Array.isArray(m.citations) && m.citations.length) {
      out.push('### 参考来源');
      out.push('');
      for (const c of m.citations) {
        out.push('- [' + c.index + '] ' + (c.title || '') + (c.url ? ' — ' + c.url : ''));
      }
      out.push('');
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

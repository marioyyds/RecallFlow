// Streaming model-step client with retries, abort handling, and SSE decoding.
import { isRetryableError } from '../../assistant/llm.ts';
import { parseToolArgs } from '../../assistant/tools.ts';
import type { Caught } from '../../assistant/errors.ts';
import { sanitizeMessages } from '../../shared/surrogates.ts';

/**
 * 以流式方式调用一次 Agent 步骤，解析 SSE 中的 content 与 tool_calls。
 * content 实时转发给前端，让“我来帮你打开…/正在搜索…”这类过程叙述
 * 与工具步骤交错呈现，而不是最后一次性吐出；若任务提前停止，
 * 前端会显示停止提示，避免把未完成的叙述误当成最终结果。
 * @returns {Promise<{assistantMessage, toolCalls, error?}>}
 */
// 导出以便单测：重试 / 中断 / 超时语义较难在集成环境覆盖，这里用假 fetch 直接验证。
/**
 * 把「流式过程中已累积的内容」组装成一个**结构合法**的 assistant 消息（纯函数，便于直测）。
 *
 * 用途：中断（用户停止 / 端口断开 / worker 被回收）时，把这一轮模型已经产出的东西
 * 保留下来供恢复使用。原先中断会把它们全部丢弃，于是若中断发生在"正在生成"的瞬间，
 * 就没有任何可续跑的状态 —— 恢复只能从头开始。
 *
 * 为什么必须校验：tool_calls 的 arguments 是**流式分片累积**的，中断时很可能只有半截 JSON。
 * 半截 JSON 直接塞进历史会让下一次请求非法（服务端只回一个空 400），比丢掉更糟。
 * 因此：解析失败的分片一律丢弃，只保留能解析完整的调用；并按 OpenAI 要求补齐 id。
 *
 * @returns {{assistantMessage: object}|null} 无内容时返回 null（没什么可保留的）
 */
export function buildPartialStep(contentAcc: any, toolAcc: any) {
  const content = String(contentAcc || '');
  const raw = Array.isArray(toolAcc) ? toolAcc : [];
  const toolCalls = [];
  for (const t of raw) {
    if (!t || !t.name) continue;
    let args;
    try {
      args = t.args ? JSON.parse(t.args) : {};
    } catch (e) {
      // 半截 JSON：丢弃这个调用（保留它会让下一次请求非法）
      continue;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    toolCalls.push({
      id: t.id || 'partial-' + toolCalls.length,
      type: 'function',
      function: { name: String(t.name), arguments: JSON.stringify(args) },
    });
  }
  if (!content && !toolCalls.length) return null;
  const assistantMessage: Record<string, unknown> = { role: 'assistant', content };
  if (toolCalls.length) assistantMessage.tool_calls = toolCalls;
  return { assistantMessage };
}

/**
 * 读取失败响应的说明文字。
 *
 * ⚠ 顺序很重要：**先 text() 再尝试 JSON.parse**，绝不能反着来。
 * 实测（2026-10-16 的线上 400）：服务端对「请求体解析失败」回的是**纯文本**，
 * 先 `resp.json()` 会抛错 —— 而那时响应体**已经被读走**，紧接着的 `resp.text()`
 * 抛 "Body is unusable: Body has already been read"，被 `.catch(() => '')` 吞掉。
 * 结果错误信息在冒号后面空着，看起来像"服务端什么都没说"，把排查引向"结构非法"的
 * 方向（而真正的原因就写在被丢掉的那句话里）。
 *
 * @returns {Promise<{detail:string, parsed:boolean}>} parsed = 响应体是不是 JSON
 */
async function readErrorDetail(resp: any) {
  let raw = '';
  try {
    raw = await resp.text();
  } catch (e) {
    raw = '';
  }
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return { detail: '', parsed: false };
  try {
    const j = JSON.parse(text);
    const msg = j && j.error && j.error.message ? j.error.message : JSON.stringify(j);
    return { detail: String(msg), parsed: true };
  } catch (e) {
    return { detail: text, parsed: false };
  }
}

/**
 * 这个 400 是不是「请求体在解析阶段就被拒」。
 *
 * 特征：状态 400 + 响应体**不是 JSON**（服务端连结构化错误都没来得及给）。
 * 为什么要单独认这一类：它的**默认推断方向是错的**（人看到 400 先怀疑"结构非法"，
 * 而实测的根因是**内容里有服务端解析不了的字符**：切裂的代理对）。
 * 认出来之后只在报错里补一句"这是解析阶段拒的、字段路径在哪、本机消毒结果如何"，
 * 不重试 —— 发送前的出站消毒已经跑过了，重发同一份内容没有意义。
 */
function isBodyParseRejection(status: any, parsed: any, detail: any) {
  if (status !== 400 || parsed) return false;
  return /parse the request body|invalid ?json|unexpected (?:end of|token|character)|hex escape|surrogate/i.test(
    String(detail || '')
  );
}

export async function streamAgentStep(port: any, settings: any, messages: any, signal: AbortSignal, tools: any, emit: any, toolChoice?: any) {
  const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body: any = { model: settings.model, messages, temperature: 0.3, stream: true, stream_options: { include_usage: true } };
  // 出站消毒（**所有模型请求都从这里走**，所以兜底放在这一处最省）。
  //
  // 为什么必须兜：内容里只要有一个孤立代理（切裂的代理对），服务端在**解析请求体**阶段
  // 就会整单拒收 400，而且 400 不重试 ⇒ 整个 run 一次即死；坏内容还留在历史里，
  // 续跑必然再炸。实测就是表格单元格按 60 个 UTF-16 码元截断切裂了论文里的 𝑦/𝒜（见
  // lib/shared/surrogates.js 的完整事故说明）。切片点已全部改成 sliceSafe，这里是第二道：
  // 页面回给我们的文本（run_javascript 的返回值、innerText 切片）我们控制不了。
  //
  // 就地改历史（而不是只改这次请求）：坏内容留在历史里等于每轮都再炸一次。
  // 代价是历史中部被改写会让前缀缓存从改写点起失效 —— 但只在真发现孤立代理时发生，
  // 那种情况下"缓存失效"远好于"整轮报废"。
  const cleaned = sanitizeMessages(messages);
  if (cleaned.count) {
    console.log('[RecallFlow] 出站前清理非法 Unicode（孤立代理对）：' + cleaned.count + ' 处');
    if (typeof emit === 'function') {
      emit({ type: 'verify', ok: null, reason: '请求体里发现非法字符（孤立代理对），已自动清理后继续（共 ' + cleaned.count + ' 处）。' });
    }
  }
  // 仅在确有可用工具时附带 tools / tool_choice，避免空数组触发 API 400 而中断回答。
  // toolChoice 用来区分「正常推理（auto）」与「收尾成文（none）」：
  // 收尾那次请求必须带着**同一份** tools 才能复用前面所有轮的请求前缀缓存，
  // 靠 tool_choice: 'none' 来禁止它继续调工具（官方：none 表示模型不会调用任何 tool）。
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  console.log('[RecallFlow] LLM fetch start:', settings.model, 'msgs=' + messages.length);
  // 请求超时只覆盖「首字节到达前」的等待；模型挂起时给出明确错误而不是无限转圈。
  // 尊重用户在设置里的 requestTimeoutMs —— 原先硬编码 60s，使该配置对 Agent 路径完全无效。
  const timeoutMs = Number(settings.requestTimeoutMs) > 0 ? Number(settings.requestTimeoutMs) : 60000;
  const timeoutCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const abortFromOutside = () => { if (timeoutCtrl) timeoutCtrl.abort(); };
  const cleanup = () => {
    if (signal && timeoutCtrl) signal.removeEventListener('abort', abortFromOutside);
  };
  // 关键：abort 监听必须覆盖**整个**请求生命周期（含流式读取）。
  // 原先在 fetch 返回后就摘掉监听，导致用户点「停止」无法中断已开始的流，只能等它自己读完。
  if (signal && timeoutCtrl) {
    if (signal.aborted) timeoutCtrl.abort();
    else signal.addEventListener('abort', abortFromOutside);
  }

  const MAX_RETRIES = 2;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let resp;
  // 计时起点必须在 fetch **之前**：SSE 是「响应头先到、token 后到」，
  // 只从拿到响应头开始算，会把网络往返和排队时间整个漏掉（实测会算成 1ms）。
  let requestStartAt = Date.now();
  try {
    // 重试仅覆盖「尚未向界面输出任何内容」的阶段，因此不会造成重复输出。
    for (let attempt = 0; ; attempt++) {
      let timedOut = false;
      const timer = timeoutCtrl ? setTimeout(() => { timedOut = true; timeoutCtrl.abort(); }, timeoutMs) : null;
      requestStartAt = Date.now();
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + settings.apiKey,
          },
          body: JSON.stringify(body),
          signal: timeoutCtrl ? timeoutCtrl.signal : signal,
        });
        if (timer) clearTimeout(timer);
        console.log('[RecallFlow] LLM fetch done:', resp.status);
      } catch (e) {
        if (timer) clearTimeout(timer);
        if (timedOut) {
          cleanup();
          return { error: '模型请求超时（' + Math.round(timeoutMs / 1000) + ' 秒），请检查网络连接或 API 服务后重试。' };
        }
        if (e && (e as Caught).name === 'AbortError') throw e; // 外部中断（用户停止）交给上层按中断处理
        if (attempt < MAX_RETRIES && isRetryableError(e)) {
          console.log('[RecallFlow] LLM fetch retry ' + (attempt + 1) + ':', e && (e as Caught).message);
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        throw e;
      }
      if (resp.ok) break;

      // 服务端错误：先取详情（**先 text 再 JSON.parse**，理由见 readErrorDetail），
      // 再按可重试性（429 / 5xx / 网络错误）决定是否重试。
      const info = await readErrorDetail(resp);
      let detail = info.detail;
      const bodyParseRejected = isBodyParseRejection(resp.status, info.parsed, info.detail);
      // 400 一定是「请求本身有问题」。这里补上本次请求的**形状**（只有角色序列与计数，
      // 不含任何消息内容）作为兜底：真有"结构非法"时，形状是唯一能一眼看出的线索。
      //
      // ⚠ 2026-10-16 更正：曾经把"冒号后空白"当成"服务端不给原因"的证据，
      // 并据此认定这是**结构**问题。实际上服务端一直给了原因（纯文本），
      // 是旧写法先 json() 再 text() 把响应体读废了（见 readErrorDetail）。
      // 形状仍然有用，但**不再当成"服务端没说"的推断依据**。
      if (resp.status === 400) {
        const roles = (Array.isArray(messages) ? messages : [])
          .map((m) => {
            if (!m || !m.role) return '?';
            return m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length ? 'asst(tc)' : m.role;
          })
          .join(',');
        detail +=
          (detail ? ' ' : '') +
          '[请求形状：model=' + body.model +
          ' messages=' + (Array.isArray(messages) ? messages.length : 0) +
          ' roles=' + roles.slice(-400) +
          ' tools=' + ((body.tools && body.tools.length) || 0) +
          ' tool_choice=' + (body.tool_choice || '-') +
          ' stream=' + body.stream + ']';
        // 「解析阶段被拒」单独说一句，是因为它的**默认推断方向是错的**：
        // 这类 400 最常见的原因不是"结构非法"，而是**内容里有服务端解析不了的字符**
        //（实测：被切裂的代理对 —— 见 lib/shared/surrogates.js）。而本次发送前刚刚
        // 做过一次出站消毒，所以这里能顺带告诉排查者"历史里还有没有这种字符"，
        // 省掉"再猜一轮结构"的返工。
        if (bodyParseRejected) {
          detail +=
            '（服务端在【解析请求体】阶段就拒绝了，上面那句原话里的字段路径就是出错位置；' +
            (cleaned.count
              ? '本次发送前已清理 ' + cleaned.count + ' 处孤立代理，仍被拒 ⇒ 原因在别处。'
              : '本次发送前未发现孤立代理 ⇒ 原因在别处，请按字段路径排查。') +
            '）';
        }
      }
      const err = new Error('DeepSeek 请求失败 (' + resp.status + '): ' + detail) as Caught;
      err.status = resp.status;
      err.bodyParseRejected = bodyParseRejected;
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        console.log('[RecallFlow] LLM retry after status ' + resp.status + ' (attempt ' + (attempt + 1) + ')');
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      cleanup();
      return { error: err.message };
    }
  } catch (e) {
    cleanup();
    throw e;
  }

  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentAcc = '';
  let usage = null;
  // 思维链累积（只有推理模型会发 delta.reasoning_content，如 deepseek-reasoner）。
  //
  // ⚠ **它只用于展示，绝不写回 messages。** 两个理由，任一条都足够：
  //   ① 前缀缓存：把思维链塞进 assistant 消息会改写请求前缀，历史全部重新 prefill；
  //   ② 协议：reasoning_content 不是可回传字段，回传会被 API 拒绝或忽略。
  // 因此这里只累积 + emit 给面板，assistantMessage 里**不带**它。
  let reasoningAcc = '';
  const toolAcc: any[] = [];
  // 分阶段计时：一次模型请求可以拆成三段 ——
  //   ① 到响应头（网络往返 + 服务端排队）  ② 响应头到首个 token（服务端 prefill）  ③ 首 token 到流结束（decode）
  // 缓存只影响 ②；③ 只受模型档位与输出长度影响；① 与两者都无关。
  // 混在一起看就永远说不清"慢"到底慢在哪一段 —— 这是本次排查里最缺的一层数据。
  const headersAt = Date.now();
  const streamStartAt = headersAt;
  let firstTokenAt = 0;

  const ensureTool: any = (i: any) => {
    while (toolAcc.length <= i) toolAcc.push({ index: toolAcc.length, id: '', name: '', args: '' });
    return toolAcc[i];
  };

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      // 读取过程中被中断（用户停止 / 端口断开 / worker 被回收）。
      // **必须把已经收到的内容附在错误上**：否则这一轮模型已经生成的东西全部丢失，
      // 恢复时只能退回上一个完整 tool turn —— 若中断发生在"正在等首个响应/正在生成"
      // 的瞬间，那一步就完全没有可续跑的状态，恢复等于从头再来（实测就是这个后果）。
      if (e && ((e as Caught).name === 'AbortError' || signal?.aborted)) {
        const partialErr: any = new DOMException('任务已取消', 'AbortError');
        partialErr.partial = buildPartialStep(contentAcc, toolAcc);
        cleanup();
        throw partialErr;
      }
      cleanup();
      throw e;
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() as string;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch (e) {
        continue;
      }
      if (json.usage) usage = json.usage;
      const choice = json.choices && json.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      // 首个可见增量即 prefill 结束 / decode 开始的分界点。
      // **思维链也算首个增量**：推理模型会先吐一大段 reasoning_content 才开始正文，
      // 若不计入，这段等待会被错算进 prefillMs，让「慢在哪一段」的判断失真。
      if (!firstTokenAt && (delta.content || delta.reasoning_content || delta.tool_calls || choice.finish_reason)) {
        firstTokenAt = Date.now();
      }
      // 思维链：单独发一类事件（type: 'reasoning'），与正文 chunk 分开。
      // 分开的理由：面板要把它渲染成**默认折叠的思考记录**（用户点开才看全文）；
      // 若混进 chunk，面板就再也分不出哪段是思考、哪段是回答。
      if (delta.reasoning_content) {
        reasoningAcc += delta.reasoning_content;
        (emit || ((event: any) => port.postMessage(event)))({ type: 'reasoning', text: delta.reasoning_content });
      }
      if (delta.content) {
        contentAcc += delta.content;
        (emit || ((event: any) => port.postMessage(event)))({ type: 'chunk', text: delta.content });
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const t = ensureTool(tc.index || 0);
          if (tc.id) t.id = tc.id;
          if (tc.function) {
            if (tc.function.name) t.name = tc.function.name;
            if (tc.function.arguments) t.args += tc.function.arguments;
          }
        }
      }
    }
  }

  const toolCalls: any[] = toolAcc
    .filter((t) => t.name || t.id)
    .map((t) => ({ id: t.id, name: t.name, args: parseToolArgs(t.args) }));

  const assistantMessage: Record<string, unknown> = { role: 'assistant', content: contentAcc };
  if (toolCalls.length) {
    assistantMessage.tool_calls = toolCalls.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    }));
  }
  cleanup(); // 流已结束，摘掉中断监听（流式期间刻意保留，以保证「停止」能立即生效）
  const streamEndAt = Date.now();
  const timing = {
    ttfbMs: headersAt - requestStartAt,
    prefillMs: (firstTokenAt || streamEndAt) - headersAt,
    decodeMs: firstTokenAt ? streamEndAt - firstTokenAt : 0,
    totalMs: streamEndAt - requestStartAt,
  };
  return { assistantMessage, toolCalls, usage, timing, reasoning: reasoningAcc };
}


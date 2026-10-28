// DeepSeek（OpenAI 兼容）调用：一次性请求 + 指数退避重试

// 出站消毒（孤立代理对）：内容里带半个代理对时，服务端在**解析请求体**阶段就整单拒收 400。
// 这条路径（意图分类 / 独立校验）的输入里也夹着页面原文（证据片段），所以同样必须过一遍。
import { sanitizeMessages } from '../../shared/surrogates.ts';

async function callDeepSeekOnce(settings: any, messages: any, signal?: AbortSignal) {
  // ⚠ 已经中断就别发请求。`signal.addEventListener('abort')` 对**已经 abort 过**的 signal
  //   不会再触发（事件是一次性的、发生过就过去了），于是这里会照常发一个真实请求、
  //   照常计费，然后才被上层当成「用户取消」丢掉。
  //   实测路径：用户按停止 → 校验请求正在发出/重试中 → 又花了 1.5 秒和两次请求。
  if (signal && signal.aborted) throw makeAbortError();
  const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  sanitizeMessages(messages);
  const controller = new AbortController();
  const timeoutMs = Number(settings.requestTimeoutMs) || 60000;
  // ⚠ 必须记下「这次 abort 是超时触发的」：AbortController 只有一种中断形态，
  //   拉闸之后 fetch 抛出来的错误与用户按停止**完全无法区分**（都是 name=AbortError）。
  //   缺这个标记的后果不是"少一条日志"，而是超时被上层当成用户中断，任务被静默终止
  //   （见 verifier.js 与 agent.js 里 classifyVerifyOutcome 的注释）。
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abort = () => controller.abort();
  if (signal) signal.addEventListener('abort', abort, { once: true });
  let resp;
  try {
    const body: any = {
      model: settings.model,
      messages,
      temperature: 0.3,
      stream: false,
    };
    // 可选：限制输出长度 / 要求 JSON。校验这类"只要一小段结构化结论"的调用必须传，
    // 否则模型可以自由长篇输出，把 15 秒的预算耗在生成上。
    if (Number(settings.maxTokens) > 0) body.max_tokens = Number(settings.maxTokens);
    if (settings.jsonMode) body.response_format = { type: 'json_object' };
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + settings.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    // 把「我们自己超时」翻译成可识别的类型。用户中断（signal 已 abort）保持原样，
    // 由上层按中断收尾 —— 这两条路径的处置完全不同，不能共用一种错误。
    if (timedOut && !(signal && signal.aborted)) {
      const te: any = new Error('请求超时（' + timeoutMs + 'ms 内未响应）');
      te.name = 'TimeoutError';
      te.timeout = true;
      throw te;
    }
    throw e;
  } finally {
    // ⚠ 清理必须在 finally 里：fetch 抛错（超时 / 断网 / 被 abort）时原先这两行被跳过，
    //   于是那个 `setTimeout(…, requestTimeoutMs)` 一直挂着 —— 在 SW 里就是一个
    //   最长 60 秒的空转定时器，每个失败请求留一个。
    //   实测证据：本模块的测试跑完后进程要多活 5 秒才退出（默认 requestTimeoutMs=5000）。
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abort);
  }

  if (!resp.ok) {
    // ⚠ 先 text() 再 JSON.parse，**不能反着来**：非 JSON 的响应体让 json() 抛错时，
    // 体已经被读走，随后的 text() 会抛 "Body is unusable"，原因就被彻底吞掉了
    //（实测见 agent.js 的 readErrorDetail：线上的 400 就是这么变成"冒号后空白"的）。
    let detail = '';
    try {
      const raw = String((await resp.text()) || '').trim();
      if (raw) {
        try {
          const j = JSON.parse(raw);
          detail = j && j.error && j.error.message ? j.error.message : JSON.stringify(j);
        } catch (e) {
          detail = raw;
        }
      }
    } catch (e) {
      detail = '';
    }
    const err: any = new Error('DeepSeek 请求失败 (' + resp.status + '): ' + detail);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message.content;
  if (!content) throw new Error('DeepSeek 返回为空');
  return content.trim();
}

/** 造一个「任务已取消」错误。集中一处，免得各调用点各写一遍 name 拼错的假 AbortError。 */
export function makeAbortError(message = '任务已取消') {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

/** 判断错误是否可重试：网络错误（无 status）或服务端 5xx / 429 限流 */
export function isRetryableError(e: any) {
  // 用户中断**不是**可重试的故障：它是我们主动取消的。重试只会让「停止」多等 1.5 秒
  //（两次退避），而且如果请求真的发出去，就是在用户已经放弃的任务上继续花钱。
  // ⚠ 顺序很重要：AbortError 没有 status，会走到下面那句 `!e.status` 而被判成
  //   「网络错误、值得重试」—— 这正是它一直没被发现的原因。
  if (e && e.name === 'AbortError') return false;
  // 超时同样不重试。它没有 status，若不在此拦下就会被当成网络抖动而重试两次，
  // 一次 15 秒的超时于是变成「15 + 0.5 + 15 + 1 + 15 ≈ 46 秒」的纯等待。
  if (e && (e.timeout === true || e.name === 'TimeoutError')) return false;
  if (!e || !e.status) return true;
  return e.status === 429 || e.status >= 500;
}

/**
 * 带指数退避重试的 DeepSeek 调用（默认最多 3 次尝试，间隔 0.5s/1s）。
 *
 * `settings.maxRetries` 可以把它调低 —— **校验器必须传 0**，理由见 verifier.js：
 * 一次校验的预算是 25 秒，重试两次就把最坏等待变成「25 + 0.5 + 25 + 1 + 25 ≈ 76 秒」。
 * 实测探针里确实出现过「1 次校验被记成 3 条请求」的现象（429 重试），
 * 而校验器本来就是 fail-open 的安全网 —— 重试换不来护栏强度，只换来卡顿。
 */
export async function callDeepSeek(settings: any, messages: any, signal?: AbortSignal) {
  const raw = Number(settings && settings.maxRetries);
  const MAX_RETRIES = Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), 3) : 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await callDeepSeekOnce(settings, messages, signal);
    } catch (e) {
      // 第三道保险：有些中断以 TypeError('Failed to fetch') 的形式冒出（fetch 被 abort 时
      // 不同实现不一致），那种错看不出 AbortError，只能靠 signal 本身判断。
      if (attempt >= MAX_RETRIES || !isRetryableError(e) || (signal && signal.aborted)) throw e;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
}

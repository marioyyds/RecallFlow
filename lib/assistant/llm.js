// DeepSeek（OpenAI 兼容）调用：一次性请求 + 指数退避重试

// 出站消毒（孤立代理对）：内容里带半个代理对时，服务端在**解析请求体**阶段就整单拒收 400。
// 这条路径（意图分类 / 独立校验）的输入里也夹着页面原文（证据片段），所以同样必须过一遍。
import { sanitizeMessages } from '../shared/surrogates.js';

async function callDeepSeekOnce(settings, messages, signal) {
  const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  sanitizeMessages(messages);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs || 60000);
  const abort = () => controller.abort();
  if (signal) signal.addEventListener('abort', abort, { once: true });
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + settings.apiKey,
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      temperature: 0.3,
      stream: false,
    }),
    signal: controller.signal,
  });
  clearTimeout(timer);
  if (signal) signal.removeEventListener('abort', abort);

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
    const err = new Error('DeepSeek 请求失败 (' + resp.status + '): ' + detail);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message.content;
  if (!content) throw new Error('DeepSeek 返回为空');
  return content.trim();
}

/** 判断错误是否可重试：网络错误（无 status）或服务端 5xx / 429 限流 */
export function isRetryableError(e) {
  if (!e || !e.status) return true;
  return e.status === 429 || e.status >= 500;
}

/** 带指数退避重试的 DeepSeek 调用（最多 3 次尝试，间隔 0.5s/1s） */
export async function callDeepSeek(settings, messages, signal) {
  const MAX_RETRIES = 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await callDeepSeekOnce(settings, messages, signal);
    } catch (e) {
      if (attempt >= MAX_RETRIES || !isRetryableError(e)) throw e;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
}

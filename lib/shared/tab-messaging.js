/**
 * 向标签页发消息时的**可重试判断**（纯逻辑，便于单测）。
 *
 * 背景（用户实测的真实 bug）：`browser_read` 会先 `open_tab` 打开/复用标签页，
 * 然后立刻 `read_current_page`。而内容脚本的注入时机是 `document_idle` ——
 * 页面刚打开时它还没在听，于是 `chrome.tabs.sendMessage` 报：
 *
 *     Could not establish connection. Receiving end does not exist.
 *
 * 原来的 `sendTabMessage` **只发一次**，一次失败就 reject，于是这个纯时序问题
 * 变成了稳定失败（重试两次都一样）。更糟的是 `browser_read` 把这个错误当**正文**返回，
 * 看起来像"页面内容就是这句话"。
 *
 * 这里把"哪些错误值得等一下再试"和"试多久"定义成纯函数，
 * 让 `sendTabMessage` 只负责循环、测试只负责语义。
 */

/** Chrome 在"接收端不存在"时给出的两条原文（不同版本措辞不同，两条都覆盖）。 */
const RETRYABLE_PATTERNS = Object.freeze([
  'receiving end does not exist',
  'could not establish connection',
  // 标签页还在加载、内容脚本正在注入时的同类报错
  'the message port closed before a response was received',
]);

/**
 * 这个错误是否值得重试？
 * @param {unknown} err 错误对象或错误消息字符串
 * @returns {boolean}
 */
export function shouldRetryTabMessage(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  if (!msg) return false;
  return RETRYABLE_PATTERNS.some((p) => msg.includes(p));
}

/**
 * 重试计划：默认约 3 秒（12 次 × 250ms）。
 * `document_idle` 通常在页面 load 之后立刻发生，所以几秒足够；
 * 再久就不是"竞态"而是真的没注入（比如页面被 Chrome 拦下），该失败就失败。
 */
export function tabMessageRetryPlan(opts = {}) {
  const attempts = Math.max(1, Math.min(40, Number(opts.attempts) || 12));
  const intervalMs = Math.max(20, Math.min(2000, Number(opts.intervalMs) || 250));
  return { attempts, intervalMs, totalMs: attempts * intervalMs };
}

/** 供调用方拼错误信息用：一句话说明"等过了还是没人接"。 */
export function tabMessageTimeoutHint(tabId, totalMs) {
  return (
    '标签页 ' + tabId + ' 的内容脚本在 ' + totalMs + 'ms 内没有响应（可能页面未加载完、' +
    '被浏览器拦截，或扩展刚重载过而页面还没刷新）。'
  );
}

/**
 * 按计划重试一个"可能因为内容脚本还没注入而失败"的操作。
 *
 * 把循环放在这个纯模块里（而不是留在 `sendTabMessage` 内部）是为了能**真的单测**：
 * 用一个"先失败几次再成功"的假函数就能验证三件事 ——
 * ① 确实重试了；② 不该重试的错误**立刻**放弃（不浪费时间）；③ 试满就停，并带可读的错误。
 *
 * @param {(attempt:number)=>Promise<any>} attempt 每次尝试（attempt 从 1 开始）
 * @param {{attempts?:number, intervalMs?:number, tabId?:number|string, sleep?:(ms:number)=>Promise<void>}} [opts]
 */
export async function retryTabMessage(attempt, opts = {}) {
  const plan = tabMessageRetryPlan(opts);
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  let lastErr = null;
  for (let i = 1; i <= plan.attempts; i++) {
    try {
      return await attempt(i);
    } catch (e) {
      lastErr = e;
      if (!shouldRetryTabMessage(e) || i === plan.attempts) break;
      await sleep(plan.intervalMs);
    }
  }
  const base = lastErr && lastErr.message ? lastErr.message + ' — ' : '';
  throw new Error(base + tabMessageTimeoutHint(opts.tabId, plan.totalMs));
}

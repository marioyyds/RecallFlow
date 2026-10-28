import { sliceSafe } from './surrogates.ts';

/**
 * 判断一条错误信息是否属于「沙箱 eval 被 CSP 拒绝」。
 *
 * ⚠ 归因：拦住 eval 的是 **MV3 扩展自身的 CSP**，**不是页面的**。
 * 实测在完全没有 CSP 响应头的页面上，沙箱的 `new Function` 同样被拒，
 * 且原始错误里那条 directive 是扩展的（`script-src 'self' 'wasm-unsafe-eval' …`）。
 * 所以这条判定实际**总会命中** —— 也就是说 `run_javascript` 必须有 CDP 才能执行。
 * 命中的调用方应自动改用页面主世界（CDP Runtime.evaluate，不受页面 CSP 限制）。
 * @param {string} message
 */
export function isCspEvalBlockError(message: unknown) {
  const s = String(message === undefined || message === null ? '' : message);
  if (!s) return false;
  if (/unsafe-eval/i.test(s)) return true;
  if (/refused to evaluate/i.test(s)) return true;
  if (/call to eval\(\) blocked/i.test(s)) return true;
  if (/blocked by (?:the )?csp/i.test(s)) return true;
  if (/content security policy/i.test(s) && /(eval|script-src)/i.test(s)) return true;
  return false;
}

export function isContentScriptUnreachable(message: unknown) {
  return /Receiving end does not exist|Could not establish connection|message port closed/i.test(
    String(message === undefined || message === null ? '' : message)
  );
}

/**
 * 把「内容脚本连不上」翻译成**模型下一步能做什么**；不是这类失败就原样带上前缀返回。
 *
 * 为什么必须翻译：`Could not establish connection. Receiving end does not exist.`
 * 对模型毫无指导 —— B 站那次的实测转写里，模型在一个这类站点上**连续 8 次**调用收到的
 * 都是同一句话，最后靠自己摸索出"内容脚本在这类站点不可用，改用主世界 JS 读取"。
 * 这条结论本来**一次就能说清**，却花了 8 次调用 + 一次高危 CDP 绕道。
 *
 * docs/tool-design.md §7 对此有明确要求：`ok:false` 时结果文本必须告诉模型**下一步能做什么**，
 * 而不是干巴巴报错。本函数就是这条要求的落点之一。
 *
 * @param {string} message 原始错误
 * @param {string} [prefix] 非此类失败时用的前缀（如「读取页面失败：」）
 */
export function describeContentScriptUnreachable(message: unknown, prefix?: unknown) {
  const raw = String(message === undefined || message === null ? '' : message);
  if (!isContentScriptUnreachable(raw)) return (prefix || '') + raw;
  return (
    (prefix || '') +
    '该标签页当前没有可用的内容脚本（' + sliceSafe(raw, 0, 120) + '）。' +
    '常见原因：页面还在加载、该页内容脚本未注入或已失效。可以这样做：' +
    '① 稍等片刻后用 wait_for_element / get_page_snapshot 重试一次；' +
    '② 改用**不经内容脚本**的 CDP 工具：get_ax_snapshot、run_javascript({engine:"page"})、take_screenshot；' +
    '③ 若该站始终读不到，直接如实说明"这个页面读不了"，不要反复重试同一条路。'
  );
}

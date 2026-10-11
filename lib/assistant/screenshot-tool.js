// 截图工具（take_screenshot）—— C-1 拆出的第 3 族（单工具族）。
//
// 为什么单独成模块：它是**唯一走 CDP 的重型读操作**，且带着一组只有它用的逻辑
// （降质阶梯、尺寸取自 CSS 视口而非位图、归档）。留在巨型 switch 里时，
// 这些细节和别的工具族混在一起，很难看清"截图到底做了什么、成本在哪"。
//
// **搬运原则：不重写行为。** 实现从 tools.js 原样搬来，只把闭包依赖换成显式注入。
//
// 两条**有意保留**的语义（不要"顺手优化"掉）：
//   1. 尺寸标注的是 **CSS 视口 / 内容尺寸**，不是位图像素 —— CDP 不返回位图尺寸，
//      而位图还受 DPR 影响。如实标注单位，不假装是像素尺寸。
//   2. 图片数据放在返回值的 `screenshot` 字段里**给面板渲染**，但 agent.js 只把它转成事件、
//      **绝不写入模型消息** —— 当前模型是纯文本的，塞 base64 只会白烧巨量 token。

/** 单张 base64 上限，超过就降质重拍。 */
export const MAX_SHOT_B64 = 400000;

// ---- 截图归档（与截图逻辑同处一模块，避免"上限常量"出现两份真值）----
// 图片只给用户看与留档，**绝不写入模型消息**（当前模型为纯文本，塞 base64 只会白烧巨量 token）。
export const SHOT_KEY = 'recallflow.shots.v1';
export const MAX_SHOTS = 3;
export const MAX_SHOT_STORE_CHARS = 300000; // 超过则不落盘（仍可在面板里展示）

/**
 * 把截图落盘留档（最多 MAX_SHOTS 张，超长的不落盘）。
 *
 * @param {object} chromeApi 注入 `chrome`，便于单测
 * @returns {Promise<boolean>} 是否真的落盘（false 时调用方仍会把图给面板展示）
 */
export async function saveScreenshot(chromeApi, shot) {
  try {
    if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) return false;
    if (String(shot.dataUrl || '').length > MAX_SHOT_STORE_CHARS) return false;
    const cur = await chromeApi.storage.local.get(SHOT_KEY);
    const list = Array.isArray(cur && cur[SHOT_KEY]) ? cur[SHOT_KEY] : [];
    const next = list.filter((x) => x && x.id !== shot.id).concat([shot]).slice(-MAX_SHOTS);
    await chromeApi.storage.local.set({ [SHOT_KEY]: next });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 截图并按阶梯降质重拍。
 *
 * @param {object} deps { ctx, args, cdp, cdpAllowed, screenshotAttempts, saveScreenshot, formatScreenshotSummary }
 */
export async function takeScreenshot(deps) {
  const ctx = deps.ctx;
  const args = deps.args || {};
  // 截图走 CDP，不经内容脚本。图片体积只能靠 format/quality 控制
  // （Page.captureScreenshot 不支持缩放），因此按阶梯逐级降质重拍。
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: '截图需要 CDP：请在设置中开启「浏览器级输入层（CDP）」。' };
  if (!ctx.tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
  const wantPng = args.format === 'png';
  const ladder = deps.screenshotAttempts(wantPng ? 'png' : 'jpeg', args.quality);
  let data = '';
  let used = ladder[0];
  let usedIndex = 0;
  // 阶梯重试必须受**总预算**约束。
  //
  // 为什么要这层：CDP 层现在每条命令都会超时（见 lib/backend/cdp.js），
  // 但阶梯最多三档 —— 每档各等 8s 就是 24s，**比 agent 层 15s 的通用包装还慢**：
  // 修完反而更糟（用户看到的是等到 15s 被杀，而错误信息还说不出卡在哪）。
  // 所以按"剩余预算"递减地下传超时，并在这里用同一份 deadline 决定还要不要继续试。
  const budgetMs = Number(deps.screenshotBudgetMs) > 0 ? Number(deps.screenshotBudgetMs) : 12000;
  const deadline = Date.now() + budgetMs;
  let timedOut = false;
  for (let i = 0; i < ladder.length; i++) {
    const remain = deadline - Date.now();
    if (remain <= 0) {
      timedOut = true;
      break;
    }
    const step = ladder[i];
    try {
      data = await deps.cdp.screenshot(ctx.tabId, {
        format: step.format,
        quality: step.quality,
        fullPage: args.fullPage === true,
        timeoutMs: remain,
      });
    } catch (e) {
      data = '';
      if (/未响应|超时/.test(String((e && e.message) || ''))) timedOut = true;
    }
    used = step;
    usedIndex = i;
    if (data && data.length <= MAX_SHOT_B64) break;
  }
  if (!data) {
    // 区分"超时"与"附加失败"：两者的下一步动作不同（前者该缩小范围或换非 CDP 路线，
    // 后者多半是 DevTools 占用了调试器）。笼统报一句"截图失败"会让人白试一遍。
    return {
      ok: false,
      result: timedOut
        ? '截图超时：CDP 未在 ' + budgetMs + 'ms 预算内响应（页面过重或调试器被占用）。可先滚动到目标区域再截，或改用 get_page_snapshot / get_ax_snapshot 取结构化信息。'
        : '截图失败：CDP 无法附加到该标签页（可能被其它调试工具占用）。',
    };
  }
  // 尺寸取 CSS 视口 / 内容尺寸：CDP 不返回位图尺寸，而位图还受 DPR 影响，
  // 因此如实标注单位，不假装是像素尺寸。
  let width = 0;
  let height = 0;
  try {
    // 同样受**总预算**约束：这一步也是 CDP 命令，无界的话会把总耗时推到 agent 的 15s 之外。
    const remainForMetrics = Math.max(400, deadline - Date.now());
    const m = await deps.cdp.command(ctx.tabId, 'Page.getLayoutMetrics', {}, { timeoutMs: remainForMetrics });
    const box = args.fullPage === true ? (m.cssContentSize || m.contentSize) : (m.cssVisualViewport || m.visualViewport);
    if (box) {
      width = Math.round(box.clientWidth || box.width || 0);
      height = Math.round(box.clientHeight || box.height || 0);
    }
  } catch (e) {}
  const bytes = Math.round((data.length * 3) / 4);
  const id = 'shot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const mime = used.format === 'png' ? 'png' : 'jpeg';
  const label = String(args.label || '').slice(0, 60);
  const stored = await deps.saveScreenshot(deps.chrome, { id, label, dataUrl: 'data:image/' + mime + ';base64,' + data, width, height, bytes });
  return {
    ok: true,
    readOnly: true,
    // 给面板渲染用：base64 在这里，但 agent.js 只把它转成事件，绝不写入模型消息。
    screenshot: { id, dataUrl: 'data:image/' + mime + ';base64,' + data, label, width, height, bytes, archived: stored },
    result: deps.formatScreenshotSummary({
      width,
      height,
      format: used.format,
      quality: used.quality,
      bytes,
      label,
      degraded: usedIndex > 0,
    }) + (stored ? '（图片已归档，可经 MCP 取回）' : ''),
  };
}

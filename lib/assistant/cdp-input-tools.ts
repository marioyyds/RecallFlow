// CDP 输入族（click_element / click_at / hover_element / drag_element / upload_file）
// —— C-1 拆出的第 7 族，也是**唯一真正"操作页面"的一族**。
//
// 为什么这五个算一族：它们都通过 `chrome.debugger` 派发**可信输入**（或等价的浏览器级动作），
// 都先检查 `cdpAllowed(ctx)`，都在动作前后取快照并用 `observedChange` 如实标注效果。
//
// **搬运原则：不重写行为。** 实现从 tools.js 原样搬来，闭包依赖改为显式注入。
//
// ⚠⚠ 本模块里有一条**极易被"顺手优化"破坏**的设计决定，见 `clickElement` 上方注释。
//     它关系到"会不会对用户的真实页面多点一次"——请先读完再改。

/**
 * click_element：先走内容脚本合成点击，**失败才**升级 CDP 可信点击。
 *
 * ⚠ **降级条件是「内容脚本报错」，不是「观测到没有效果」——这是有意保留的决定，不是遗漏。**
 *
 * 把条件放宽成"无变化即升级"会**双击真实页面**：正常交互（勾选、单选框、同页锚点、
 * 既已选中的 tab、只改 CSS :hover/:focus 的控件）本来就不产生任何 DOM 变化。
 * 对一个会驱动用户真实浏览器、可能触发提交/支付/发消息的工具来说，
 * **"多派发一次点击"的代价远高于"少降级一次"**。
 *
 * 现在已有的观测能力（observedChange + 快照指纹）让这个判断**能够**做对，
 * 但要做对需要先有「幂等动作」的判据（例如：仅对不会导航、不提交表单、
 * 且元素本身未处于目标状态的动作允许重试）。那是一次独立的设计，不能顺手塞进这里。
 *
 * 子框架（frameId≠0）需把框架内坐标换算为顶层坐标（`resolveFrameClickPoint`），
 * 换算不可靠时**退回内容脚本结果，绝不在错误坐标上点击**。
 */
export async function clickElement(deps: any, args: Record<string, unknown>) {
  const ctx = deps.ctx;
  const contentRes = await deps.executePageTool(ctx.tabId, 'click', args, ctx);
  const target = await deps.resolveTarget(ctx.tabId, args);
  if (target && contentRes && contentRes.ok !== false) deps.rememberTarget(ctx, target);
  const clickFrame = deps.frameIdFromArgs(args);
  if (!contentRes || contentRes.ok !== false || !deps.cdpAllowed(ctx) || !target) return contentRes;
  try {
    let point = { x: target.rect.centerX, y: target.rect.centerY };
    if (clickFrame != null && clickFrame !== 0) {
      const resolved = await deps.cdp.resolveFrameClickPoint(ctx.tabId, clickFrame, target.selector, point).catch(() => null);
      if (!resolved) return contentRes; // 换算不可靠 → 宁可不点，也不在错坐标点
      point = resolved;
    }
    await deps.cdp.clickAt(ctx.tabId, point.x, point.y);
    const before = ctx.lastSnapshot || null;
    const after = await deps.getPageSnapshot(ctx.tabId, {
      maxElements: 40,
      maxText: 1200,
      frameId: clickFrame != null && clickFrame !== 0 ? clickFrame : undefined,
    }).catch(() => null);
    return {
      ok: true,
      hadEffect: deps.observedChange(before, after) === 'changed',
      cdp: true,
      pageSnapshot: after,
      verification: deps.buildActionVerification(deps.observedChange(before, after), '已用 CDP 派发可信点击'),
      result:
        '内容脚本点击失败（' + String(contentRes.result || '').replace(/\s+/g, ' ').slice(0, 80) + '），已改用 CDP 可信点击（坐标 ' +
        Math.round(point.x) + ',' + Math.round(point.y) + '）' +
        (after ? '\n' + deps.compactSnapshotSummary(after) : ''),
    };
  } catch (e) {
    return contentRes;
  }
}

/** click_at：按视口坐标直接派发可信点击（合成点击无效的顽固站点用它）。 */
export async function clickAt(deps: any, args: Record<string, unknown>) {
  const ctx = deps.ctx;
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, result: 'click_at 需要数值坐标 x、y。' };
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: 'click_at 需要 CDP 输入层（请在设置中开启「浏览器级输入」，且需 Chromium 内核浏览器）。' };
  try {
    await deps.cdp.clickAt(ctx.tabId, x, y, { button: args.button || 'left', clickCount: args.double ? 2 : 1 });
    const before = ctx.lastSnapshot || null;
    const after = await deps.getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
    return {
      ok: true,
      hadEffect: deps.observedChange(before, after) === 'changed',
      cdp: true,
      pageSnapshot: after,
      verification: deps.buildActionVerification(deps.observedChange(before, after), 'CDP 坐标点击已派发'),
      result: '已在坐标 (' + x + ',' + y + ') 点击' + (after ? '\n' + deps.compactSnapshotSummary(after) : ''),
    };
  } catch (e) {
    return { ok: false, result: 'CDP 点击失败：' + deps.summarizeCdpError(e) };
  }
}

/** hover_element：把鼠标移到目标元素上。 */
export async function hoverElement(deps: any, args: Record<string, unknown>) {
  const ctx = deps.ctx;
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: '悬停需要 CDP 输入层（请在设置中开启）。' };
  const target = await deps.resolveTarget(ctx.tabId, args);
  if (!target) return { ok: false, result: '未找到目标元素。' };
  try {
    await deps.cdp.moveTo(ctx.tabId, target.rect.centerX, target.rect.centerY);
    deps.rememberTarget(ctx, target);
    const before = ctx.lastSnapshot || null;
    const after = await deps.getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
    return {
      ok: true,
      // 悬停常常**不产生任何 DOM 变更**（只改 CSS :hover 伪类），因此这里必须如实报
      // 「是否观测到变化」，而不是无条件声称 changed:true —— 否则卡死检测会永远认为在推进。
      hadEffect: deps.observedChange(before, after) === 'changed',
      cdp: true,
      pageSnapshot: after,
      verification: deps.buildActionVerification(deps.observedChange(before, after), 'CDP 悬停已派发（伪类变化可能不产生 DOM 变更）'),
      result: '已悬停到元素（坐标 ' + target.rect.centerX + ',' + target.rect.centerY + '）' + (after ? '\n' + deps.compactSnapshotSummary(after) : ''),
    };
  } catch (e) {
    return { ok: false, result: '悬停失败：' + deps.summarizeCdpError(e) };
  }
}

/** drag_element：从起点拖到终点。需要能**同时**定位两端。 */
export async function dragElement(deps: any, args: Record<string, unknown>) {
  const ctx = deps.ctx;
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: '拖拽需要 CDP 输入层（请在设置中开启）。' };
  const from = await deps.resolveTarget(ctx.tabId, { ref: args.fromRef, selector: args.fromSelector, text: args.fromText });
  const to = await deps.resolveTarget(ctx.tabId, { ref: args.toRef, selector: args.toSelector, text: args.toText });
  if (!from || !to) return { ok: false, result: '拖拽需要能同时定位起点与终点（fromRef/fromSelector/fromText 与 toRef/toSelector/toText）。' };
  try {
    await deps.cdp.drag(ctx.tabId, from.rect.centerX, from.rect.centerY, to.rect.centerX, to.rect.centerY);
    const before = ctx.lastSnapshot || null;
    const after = await deps.getPageSnapshot(ctx.tabId, { maxElements: 40, maxText: 1200 }).catch(() => null);
    return {
      ok: true,
      hadEffect: deps.observedChange(before, after) === 'changed',
      cdp: true,
      pageSnapshot: after,
      verification: deps.buildActionVerification(deps.observedChange(before, after), 'CDP 拖拽已派发'),
      result: '已从 (' + from.rect.centerX + ',' + from.rect.centerY + ') 拖拽到 (' + to.rect.centerX + ',' + to.rect.centerY + ')' + (after ? '\n' + deps.compactSnapshotSummary(after) : ''),
    };
  } catch (e) {
    return { ok: false, result: '拖拽失败：' + deps.summarizeCdpError(e) };
  }
}

/** upload_file：把本地文件设置到 file input 上。 */
export async function uploadFile(deps: any, args: Record<string, unknown>) {
  const ctx = deps.ctx;
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: '文件上传需要 CDP（请在设置中开启）。' };
  const files = Array.isArray(args.files) ? args.files.filter(Boolean) : args.files ? [args.files] : [];
  if (!files.length) return { ok: false, result: 'upload_file 需要 files（本地文件的绝对路径数组）。' };
  const target = await deps.resolveTarget(ctx.tabId, args);
  if (!target) return { ok: false, result: '未找到 file input 元素。' };
  try {
    await deps.cdp.uploadFile(ctx.tabId, target.selector, files);
    // 文件选择不产生可观察的页面变化（文件名可能只出现在 input.value 里），
    // 因此如实标注 verified:false，而不是谎报 changed:true。
    return {
      ok: true,
      hadEffect: false,
      cdp: true,
      verification: deps.buildActionVerification('unobservable', '已向文件输入框设置文件（未做页面变化观测）'),
      result: '已向文件输入框设置 ' + files.length + ' 个文件：' + files.join('、'),
    };
  } catch (e) {
    return { ok: false, result: '文件上传失败：' + deps.summarizeCdpError(e) };
  }
}

/** 该族处理哪些工具名。 */
export const CDP_INPUT_TOOLS = new Set(['click_element', 'click_at', 'hover_element', 'drag_element', 'upload_file']);

/** 统一入口。返回 null 表示"不属于本族"。 */
export async function handleCdpInputTool(name: string, args: Record<string, unknown>, deps: any) {
  if (name === 'click_element') return await clickElement(deps, args);
  if (name === 'click_at') return await clickAt(deps, args);
  if (name === 'hover_element') return await hoverElement(deps, args);
  if (name === 'drag_element') return await dragElement(deps, args);
  if (name === 'upload_file') return await uploadFile(deps, args);
  return null;
}

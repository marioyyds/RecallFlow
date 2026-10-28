// 页面输入命令族（type_text / press_key / select_option / check_box / wait_for_element / get_attribute）
// —— C-1 拆出的第 5 族（页面命令族的第一批）。
//
// 为什么这六个算一族：它们都是"把参数发给内容脚本、由页面侧执行"的**同一形状**命令，
// 差别只在消息类型与延迟。放到一起后，"页面命令到底有哪些、各自走哪条路"一目了然。
//
// **搬运原则：不重写行为。** 实现从 tools.js 原样搬来，闭包依赖改为显式注入。
//
// 两条**有意保留**的语义（不要"顺手优化"）：
//   1. `type_text` / `press_key` 是**先合成、失败才升级 CDP**：
//      合成输入更快、且不占调试器；只有它失败（如受控组件/富文本编辑器）才用 CDP 兜底。
//      **升级条件是"合成失败"，不是"没有观测到效果"** —— 后者会对真实页面重复输入。
//   2. `hadEffect` / `verification` 由 `observedChange` + `buildActionVerification`
//      按**观测**算出，不写死 true（此处曾是 7 处硬编码谎报之一）。
import { editableTextSummary } from '../shared/editable-text.ts';
import type { Caught } from './errors.ts';
import type { PageInputDeps } from './tool-deps.ts';

/** 从目标元素回读实际文本；用于 CDP 输入后的严格验收。 */
async function readEditableValue(
  deps: PageInputDeps,
  tabId: number,
  selector: string,
  isSubframe: boolean,
  frameId: number
) {
  const sel = JSON.stringify(String(selector || ''));
  const expr =
    '(() => { /* rf-read-editable */ const el = document.querySelector(' + sel + '); if (!el) return null;' +
    ' if (el.isContentEditable) return String(el.innerText !== undefined ? el.innerText : el.textContent || "");' +
    ' return typeof el.value === "string" ? el.value : null; })()';
  try {
    return isSubframe
      ? await deps.cdp.evaluateInFrame(tabId, frameId, expr)
      : await deps.cdp.evaluate(tabId, expr);
  } catch (e) {
    return null;
  }
}

/**
 * type_text：合成输入，失败才升级 CDP 可信输入。
 *
 * @param {object} deps 见 handlePageInputTool
 */
export async function typeText(deps: PageInputDeps, args: Record<string, unknown>) {
  let res;
  try {
    res = await deps.executeContentAction(deps.ctx.tabId, 'type_text', { type: 'kbTypeText', params: args }, { delayMs: 80 });
  } catch (e) {
    res = { ok: false, result: '输入文本失败：' + (e as Caught).message };
  }
  if (res && res.ok !== false && res.matchesIntent !== false && res.partial !== true) return res;
  // 合成输入失败 → 用 CDP 可信输入兜底（对受控组件/富文本编辑器更可靠）。
  // 子框架用 evaluateInFrame 聚焦该框架内的元素，insertText 会作用于当前焦点。
  const typeFrame = deps.frameIdFromArgs(args);
  if (!deps.cdpAllowed(deps.ctx)) return res;
  const target = await deps.resolveTarget(deps.ctx.tabId, args);
  if (!target) return res;
  const isSubframe = typeFrame != null && typeFrame !== 0;
  try {
    const sel = JSON.stringify(target.selector);
    const focusExpr =
      '(() => { const el = document.querySelector(' + sel + '); if (!el) return false; el.focus();' +
      ' if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);' +
      ' const s = window.getSelection(); if (s) { s.removeAllRanges(); s.addRange(r); } }' +
      ' else if (typeof el.setSelectionRange === "function" && typeof el.value === "string") el.setSelectionRange(el.value.length, el.value.length);' +
      ' return true; })()';
    if (isSubframe) await deps.cdp.evaluateInFrame(deps.ctx.tabId, typeFrame, focusExpr);
    else await deps.cdp.evaluate(deps.ctx.tabId, focusExpr);
    const text = String(args.value == null ? '' : args.value);
    const beforeValue = await readEditableValue(deps, deps.ctx.tabId, target.selector, isSubframe, Number(typeFrame));
    const expected = args.clearFirst === true ? text : String(beforeValue == null ? '' : beforeValue) + text;
    if (args.clearFirst === true) await deps.cdp.pressKey(deps.ctx.tabId, 'a', ['CTRL']);
    let strategy = 'cdp-insertText';
    if (target.contentEditable && text.includes('\n')) {
      // ProseMirror/Tiptap 一类编辑器对一次性插入多行文本的换行处理不一致：
      // 逐行插入 + 可信 Enter 更接近真实用户输入。
      strategy = 'cdp-line-by-line';
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await deps.cdp.pressKey(deps.ctx.tabId, 'Enter');
        if (lines[i] || i === 0) await deps.cdp.insertText(deps.ctx.tabId, lines[i]);
      }
    } else {
      await deps.cdp.insertText(deps.ctx.tabId, text);
    }
    const actualValue = await readEditableValue(deps, deps.ctx.tabId, target.selector, isSubframe, Number(typeFrame));
    const summary = editableTextSummary(expected, actualValue == null ? '' : actualValue);
    const verified = actualValue !== null && actualValue !== undefined && summary.matchesIntent;
    if (verified) deps.rememberTarget(deps.ctx, target);
    const before = deps.ctx.lastSnapshot || null;
    const after = await deps.getPageSnapshot(deps.ctx.tabId, { maxElements: 40, maxText: 1000, frameId: isSubframe && typeFrame ? typeFrame : undefined }).catch(() => null);
    const result = {
      ok: verified,
      partial: !verified,
      hadEffect: deps.observedChange(before, after) === 'changed',
      cdp: true,
      strategy,
      matchesIntent: verified,
      expectedLength: summary.expectedLength,
      actualLength: summary.actualLength,
      firstDifference: summary.firstDifference,
      pageSnapshot: after,
      verification: deps.buildActionVerification(
        deps.observedChange(before, after),
        verified ? '已用 CDP 可信输入，并回读确认' : 'CDP 已输入，但回读值与预期不一致'
      ),
      result: verified
        ? '已用 CDP 可信输入 ' +
          text.length +
          ' 个字符（' +
          strategy +
          '，已回读确认）' +
          (after ? '\n' + deps.compactSnapshotSummary(after) : '')
        : 'CDP 输入未达到预期（' +
          strategy +
          '）：预期 ' +
          summary.expectedLength +
          ' 字符，实际 ' +
          (actualValue == null ? '无法回读' : summary.actualLength + ' 字符') +
          (summary.firstDifference.index >= 0 ? '，首个差异在 ' + summary.firstDifference.index : '') +
          '。实际值：' +
          JSON.stringify(String(actualValue == null ? '' : actualValue).slice(0, 120)) +
          '。不要假设已写入，请改用粘贴/编辑器专用写入或检查目标是否被页面接管。' +
          (after ? '\n' + deps.compactSnapshotSummary(after) : ''),
    };
    if (result.verification) {
      result.verification.verified = verified && result.verification.verified;
    }
    return result;
  } catch (e) {
    return res || { ok: false, result: 'CDP 输入失败：' + deps.summarizeCdpError(e as Caught) };
  }
}

/** press_key：合成按键，失败才升级 CDP。 */
export async function pressKey(deps: PageInputDeps, args: Record<string, unknown>) {
  let res;
  try {
    res = await deps.executeContentAction(deps.ctx.tabId, 'press_key', { type: 'kbPressKey', params: args }, { delayMs: 120 });
  } catch (e) {
    res = { ok: false, result: '派发键盘事件失败：' + (e as Caught).message };
  }
  if (res && res.ok !== false) return res;
  if (!deps.cdpAllowed(deps.ctx)) return res;
  try {
    await deps.cdp.pressKey(deps.ctx.tabId, String(args.key || ''), args.modifiers as string[] | undefined);
    const before = deps.ctx.lastSnapshot || null;
    const after = await deps.getPageSnapshot(deps.ctx.tabId, { maxElements: 40, maxText: 1000 }).catch(() => null);
    return {
      ok: true,
      hadEffect: deps.observedChange(before, after) === 'changed',
      cdp: true,
      pageSnapshot: after,
      verification: deps.buildActionVerification(deps.observedChange(before, after), '已用 CDP 派发按键'),
      result: '已用 CDP 派发按键：' + args.key + (after ? '\n' + deps.compactSnapshotSummary(after) : ''),
    };
  } catch (e) {
    return res || { ok: false, result: 'CDP 按键失败：' + deps.summarizeCdpError(e as Caught) };
  }
}

/** 四个"薄包装"：只把参数转发给内容脚本，各自带一条可读的失败文案。 */
/** 「薄包装」命令的形状：消息类型 + 失败文案 + 执行选项。 */
interface ThinPageCommandSpec {
  message: string;
  label: string;
  opts: { delayMs?: number; verify?: boolean };
}

export const THIN_PAGE_COMMANDS: Record<string, ThinPageCommandSpec> = Object.freeze({
  select_option: { message: 'kbSelectOption', label: '选择下拉项', opts: { delayMs: 100 } },
  check_box: { message: 'kbCheckBox', label: '切换复选框', opts: { delayMs: 100 } },
  wait_for_element: { message: 'kbWaitForElement', label: '等待元素', opts: { verify: false } },
  get_attribute: { message: 'kbGetAttribute', label: '读取属性', opts: { verify: false } },
});

/** 执行一个"薄包装"页面命令。 */
export async function thinPageCommand(deps: PageInputDeps, name: string, args: Record<string, unknown>) {
  const spec = THIN_PAGE_COMMANDS[name];
  if (!spec) return null;
  try {
    return await deps.executeContentAction(deps.ctx.tabId, name, { type: spec.message, params: args }, spec.opts);
  } catch (e) {
    return { ok: false, result: spec.label + '失败：' + (e as Caught).message };
  }
}

/** 该族处理哪些工具名。 */
export const PAGE_INPUT_TOOLS = new Set([
  'type_text', 'press_key', 'select_option', 'check_box', 'wait_for_element', 'get_attribute',
]);

/** 统一入口。返回 null 表示"不属于本族"。 */
export async function handlePageInputTool(name: string, args: Record<string, unknown>, deps: PageInputDeps) {
  if (name === 'type_text') return await typeText(deps, args);
  if (name === 'press_key') return await pressKey(deps, args);
  return await thinPageCommand(deps, name, args);
}

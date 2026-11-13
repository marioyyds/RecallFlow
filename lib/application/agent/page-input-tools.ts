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
import {
  editableTextOnlyWhitespaceDiffers,
  editableTextSummary,
  readContentEditableText,
} from '../../shared/editable-text.ts';
import type { Caught } from './errors.ts';
import type { PageInputDeps } from './tool-deps.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 可信输入的事务边界：长正文按段落附近切块，但块内保留真实换行，不再为每一行
 * 派发 Enter。逐行 Enter 会让富文本编辑器的段落模型反复重入，CSDN 实测因此
 * 插入重复段落。这里只负责切分，实际插入仍使用一次或少量 Input.insertText。
 */
export function splitTrustedText(text: unknown, maxChars = 1200): string[] {
  let remaining = String(text == null ? '' : text);
  const chunks: string[] = [];
  const limit = Math.max(64, Math.floor(maxChars));
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    cut = cut >= Math.floor(limit * 0.5) ? cut + 1 : limit;
    if (
      cut > 0 &&
      cut < remaining.length &&
      /[\uD800-\uDBFF]/.test(remaining[cut - 1]) &&
      /[\uDC00-\uDFFF]/.test(remaining[cut])
    ) {
      cut -= 1;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

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
    ' if (el.isContentEditable) { ' +
    readContentEditableText.toString() +
    ' return readContentEditableText(el); }' +
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
 * 在 contenteditable 上派发一次真实的 paste 事件，让编辑器自己解析段落结构。
 *
 * 为什么需要：`Input.insertText` 把整块文本塞进 pre[contenteditable] 这类编辑器时，
 * 段落换行会被它的段落模型归一化掉（CSDN/CodeMirror 实测 3055 → 2974，首差正好落在
 * 段落边界）。真实 paste 走编辑器自己的 input rule，段落才重建得起来。
 *
 * 函数必须保持自包含：CDP 兜底会把它的源码注入页面执行（同 readContentEditableText）。
 */
function dispatchEditablePaste(el: any, text: string): string {
  try {
    const doc = el.ownerDocument;
    const view: any = (doc && doc.defaultView) || (globalThis as any);
    const ClipboardEvt = view.ClipboardEvent;
    const Transfer = view.DataTransfer;
    if (!ClipboardEvt) return 'unsupported';
    let data: any = null;
    if (Transfer) {
      data = new Transfer();
      data.setData('text/plain', text);
    }
    let evt: any = null;
    if (data) {
      try {
        evt = new ClipboardEvt('paste', { clipboardData: data, bubbles: true, cancelable: true });
      } catch (e) {
        evt = null;
      }
      if (evt && !evt.clipboardData) {
        Object.defineProperty(evt, 'clipboardData', { value: data });
      }
    }
    if (!evt) {
      evt = new ClipboardEvt('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(evt, 'clipboardData', {
        value: { getData: () => text, types: ['text/plain'] },
      });
    }
    el.focus();
    const selection = typeof view.getSelection === 'function' ? view.getSelection() : null;
    if (selection && typeof doc.createRange === 'function') {
      const range = doc.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    el.dispatchEvent(evt);
    return 'dispatched';
  } catch (e) {
    return 'error';
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
    // 内容脚本失败时可能已经写入了一部分。事务式降级必须使用它返回的 valueBefore
    // 作为基线，不能读取“失败后”的编辑器值，否则会把半截内容当成原值再加一遍。
    const primaryBefore =
      typeof res?.valueBefore === 'string' ? res.valueBefore : null;
    const fallbackValue =
      primaryBefore === null
        ? await readEditableValue(
            deps,
            deps.ctx.tabId,
            target.selector,
            isSubframe,
            typeFrame as number
          )
        : null;
    const baseline =
      primaryBefore === null
        ? String(fallbackValue == null ? '' : fallbackValue)
        : primaryBefore;
    const text = String(args.value == null ? '' : args.value);
    const expected = args.clearFirst === true ? text : baseline + text;
    // CDP 降级统一采用“先全选，再整体写入 expected”的事务语义。无论用户原来是否
    // clearFirst，都先恢复到明确的最终值，避免内容脚本半写入 + CDP 追加造成重复。
    const focusExpr =
      '(() => { const el = document.querySelector(' + sel + '); if (!el) return false; el.focus();' +
      ' if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el);' +
      ' const s = window.getSelection(); if (s) { s.removeAllRanges(); s.addRange(r); } }' +
      ' else if (typeof el.select === "function") el.select();' +
      ' else if (typeof el.setSelectionRange === "function" && typeof el.value === "string") el.setSelectionRange(0, el.value.length);' +
      ' return true; })()';
    if (isSubframe) await deps.cdp.evaluateInFrame(deps.ctx.tabId, typeFrame, focusExpr);
    else await deps.cdp.evaluate(deps.ctx.tabId, focusExpr);
    let strategy = 'cdp-transactional';
    if (target.contentEditable && expected) {
      const chunks = splitTrustedText(expected, 1200);
      strategy = chunks.length > 1 ? 'cdp-transactional-chunked' : 'cdp-transactional';
      for (const chunk of chunks) {
        await deps.cdp.insertText(deps.ctx.tabId, chunk);
      }
    } else if (expected) {
      await deps.cdp.insertText(deps.ctx.tabId, expected);
    } else {
      strategy = 'cdp-clear-only';
    }
    await delay(60);
    let actualValue = await readEditableValue(deps, deps.ctx.tabId, target.selector, isSubframe, typeFrame as number);
    let summary = editableTextSummary(expected, actualValue == null ? '' : actualValue);
    let verified =
      actualValue !== null &&
      actualValue !== undefined &&
      (summary.matchesIntent ||
        editableTextOnlyWhitespaceDiffers(expected, actualValue));
    // 段落结构建不起来（编辑器把换行归一化掉）时，用一次真实 paste 让编辑器按自己的
    // input rule 重建段落，再回读确认。
    // ⚠ 必须先清空再 paste：编辑器的 paste 处理会追加到光标处（CSDN 实测 2993 → 5992，
    // 正文直接变成两倍）。只在回读比期望短时才试，避免在重复内容上再叠一层。
    const readLength = String(actualValue == null ? '' : actualValue).length;
    if (
      !verified &&
      target.contentEditable &&
      expected &&
      expected.indexOf('\n') >= 0 &&
      readLength < summary.expectedLength
    ) {
      // 清空：焦点 + 全选已在上面做过，这里用空串替换选区，得到干净的基线。
      await deps.cdp.insertText(deps.ctx.tabId, '');
      await delay(40);
      const pasteExpr =
        '(() => { const el = document.querySelector(' + sel + '); if (!el) return "no-element";' +
        ' if (!el.isContentEditable) return "not-editable";' +
        ' return (' + dispatchEditablePaste.toString() + ')(el, ' + JSON.stringify(expected) + '); })()';
      const status = isSubframe
        ? await deps.cdp.evaluateInFrame(deps.ctx.tabId, typeFrame as number, pasteExpr)
        : await deps.cdp.evaluate(deps.ctx.tabId, pasteExpr);
      if (status === 'dispatched') {
        strategy = strategy + '+paste';
        await delay(80);
        actualValue = await readEditableValue(deps, deps.ctx.tabId, target.selector, isSubframe, typeFrame as number);
        summary = editableTextSummary(expected, actualValue == null ? '' : actualValue);
        verified =
          actualValue !== null &&
          actualValue !== undefined &&
          (summary.matchesIntent ||
            editableTextOnlyWhitespaceDiffers(expected, actualValue));
      }
    }
    if (verified) deps.rememberTarget(deps.ctx, target);
    // 差异定性：只差空白/换行 ≠ 内容丢失。Markdown 里换行就是结构（标题、代码块、
    // 表格），所以**不能**把它判成成功，但必须把原因说清楚，否则模型会一直重写。
    const whitespaceOnly =
      actualValue != null &&
      !summary.matchesIntent &&
      editableTextOnlyWhitespaceDiffers(expected, actualValue);
    const before = deps.ctx.lastSnapshot || null;
    const after = await deps.getPageSnapshot(deps.ctx.tabId, { maxElements: 40, maxText: 1000, frameId: isSubframe ? (typeFrame as number) : undefined }).catch(() => null);
    const result = {
      ok: verified,
      partial: !verified,
      hadEffect: deps.observedChange(before, after) === 'changed',
      cdp: true,
      strategy,
      matchesIntent: verified,
      whitespaceOnly,
      expectedLength: summary.expectedLength,
      actualLength: summary.actualLength,
      firstDifference: summary.firstDifference,
      pageSnapshot: after,
      verification: deps.buildActionVerification(
        deps.observedChange(before, after),
        verified
          ? whitespaceOnly
            ? 'CDP 已输入；内容一致（编辑器归一化了换行/空白）'
            : '已用 CDP 可信输入，并回读确认'
          : whitespaceOnly
            ? 'CDP 已输入，回读只差换行/空白（编辑器归一化了段落结构）'
            : 'CDP 已输入，但回读值与预期不一致'
      ),
      result: verified
        ? '已用 CDP 事务式输入 ' +
          expected.length +
          ' 个字符（' +
          strategy +
          '，已回读确认）' +
          (after ? '\n' + deps.compactSnapshotSummary(after) : '')
        : 'CDP 事务式输入未达到预期（' +
          strategy +
          '）：预期 ' +
          summary.expectedLength +
          ' 字符，实际 ' +
          (actualValue == null ? '无法回读' : summary.actualLength + ' 字符') +
          (summary.firstDifference.index >= 0 ? '，首个差异在 ' + summary.firstDifference.index : '') +
          (whitespaceOnly
            ? '。差异只在换行/空白：非空白字符完全一致，是编辑器把段落结构归一化了 —— Markdown 的标题、代码块、表格都靠换行，所以这**不算**写对'
            : '。') +
          '实际值：' +
          JSON.stringify(String(actualValue == null ? '' : actualValue).slice(0, 120)) +
          '。工具已先恢复到内容脚本失败前的基线，再用一次整体写入替换；不要原样重试同一路径 —— 换行被吃掉时要改用该站点的写入方式（如真实 paste / 编辑器 API），而不是继续 insertText。' +
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
  // 合成成功也不算"已生效"：按键是**事件**，不是结果。没有可观测变化时必须如实
  // 说出来（此前这里把「已向目标元素派发按键」当成功证据，实测出现过编辑器根本
  // 没聚焦却报 ✓ 的情况）。
  if (res && res.ok !== false) {
    const before = deps.ctx.lastSnapshot || null;
    const after = await deps
      .getPageSnapshot(deps.ctx.tabId, { maxElements: 40, maxText: 1000 })
      .catch(() => null);
    const change = deps.observedChange(before, after);
    if (change === 'changed') return res;
    return {
      ...res,
      hadEffect: false,
      ...(after ? { pageSnapshot: after } : {}),
      verification: deps.buildActionVerification(change, '按键已派发，但没有可观测变化'),
      result:
        '已派发按键：' +
        String(args.key || '') +
        '，但没有观测到页面/字段变化 —— 若目标需要焦点，先点击它或确认编辑器已聚焦，再重按。' +
        (after ? '\n' + deps.compactSnapshotSummary(after) : ''),
    };
  }
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

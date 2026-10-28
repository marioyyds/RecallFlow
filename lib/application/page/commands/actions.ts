// User-observable interactions with the current page.
import { elementSelector } from '../page-text.ts';
import { waitForSettle } from '../settle.ts';
import { editableTextSummary } from '../../../shared/editable-text.ts';
import {
  describeLookupMiss,
  describeTargetState,
  findElementsFor,
  isVisibleForAction,
  targetMissError,
} from './locator.ts';
import { pageCommandSession } from './session.ts';

/**
 * 动作后等页面稳定，再读状态。
 *
 * 原实现是 `setTimeout(resolve, 50)` 的固定睡眠。50ms 对同步渲染够用，但对 SPA
 * （异步渲染、受控组件回写、请求回来后再渲染）远远不够 —— 于是「动作后立刻读值」
 * 会拿到点击前的旧值：工具把成功报成失败，或把失败报成成功（旧值恰好满足断言）。
 * 对以「验证改动是否生效」为卖点的调试工具，这是地基问题。
 *
 * 现在改为等真实静默（rAF + MutationObserver 静默窗口 + 硬上限，见 settle.js）：
 * 简单页面通常几十 ms 就返回（比固定 50ms 更快），复杂页面会等到真正稳定。
 * 仍是 await 语义，因此所有调用点无需改动。
 */
function nextPaint() {
  return waitForSettle();
}

function stateSuffix(el: any) {
  const state = describeTargetState(el);
  if (!state) return '';
  // 元素可能已被点击导航掉：此时读不到状态，如实说而不是假装有。
  if (!el.isConnected) return '（该元素已不在页面上）';
  return '；点击后状态：' + state;
}

async function cmdClick(params: any) {
  const els = findElementsFor(params);
  if (!els.length) return { ok: false, error: targetMissError(params) };
  const el = els[0];
  const tag = (el.tagName || '').toLowerCase();
  const beforeHref = location.href;
  const ready = await ensureActionable(el);
  if (!ready) {
    // 自愈：被遮挡或 pointer-events 受限时，退化为程序化 click（绕过遮挡），
    // 仍失败则如实上报，交由后台用 CDP 可信事件兜底。
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      return { ok: false, error: '目标元素不可操作（已禁用）：' + tag + ' ' + describeTargetState(el) };
    }
    try {
      if (typeof el.click === 'function') {
        el.click();
        await nextPaint();
        const navigated = location.href !== beforeHref ? '（页面已导航到 ' + location.href + '）' : '';
        return { ok: true, forced: true, selector: elementSelector(el), result: '目标元素被遮挡或暂不可交互，已改用程序化点击' + stateSuffix(el) + navigated };
      }
    } catch (e: any) {}
    return { ok: false, error: '目标元素不可操作（不可见、被遮挡或尚未就绪）：' + tag + ' ' + describeTargetState(el) };
  }
  const before = describeTargetState(el);
  try {
    dispatchRealisticClick(el);
  } catch (e: any) {
    return { ok: false, error: '点击失败：' + e.message };
  }
  // 点击后回报状态：三态开关 / 展开收起 / 勾选这类控件，光说「已点击」等于没说 ——
  // 实测 agent 连点主题按钮后无法复原，正是因为它读不到「现在是什么状态」。
  await nextPaint();
  const after = describeTargetState(el);
  const navigated = location.href !== beforeHref ? '（页面已导航到 ' + location.href + '）' : '';
  let changed = '';
  if (after && after !== before) changed = '（点击前：' + (before || '无状态属性') + '）';
  return {
    ok: true,
    selector: elementSelector(el),
    stateBefore: before,
    stateAfter: after,
    result: '已点击元素 ' + tag + stateSuffix(el) + changed + navigated,
  };
}

function firstTarget(params: any, includeText = true) {
  const source = params || {};
  // ⚠ **必须把语义定位符一起转发**。
  //
  // `findElementsFor` 支持 ref / role+name / testid / selector / text / index 全套，
  // 而这里原先只转发 ref 与 selector（text 还要调用方额外指定）——
  // 于是 `type_text({role:'textbox', name:'站内搜索'})` 这类**按 schema 说明写的调用**
  // 永远找不到元素，报的却是「未找到可输入的目标元素」：
  // 读起来像"页面上没有这个输入框"，实际是**根本没按这个条件去找**。
  // 模型看到这种错误只会以为页面缺元素，然后换参数乱试或直接放弃。
  //
  // 实测：`cmdClick` 直接传 `findElementsFor(params)` 所以 role+name 一直好用，
  // 而 `cmdTypeText` / `cmdPressKey` / `cmdSelectOption` / `cmdCheckBox` / `cmdGetAttribute`
  // 走的是本函数 —— 同一个页面里"点按钮能用语义定位、填输入框不能"，就是这个原因。
  const target = {
    ref: source.ref,
    role: source.role,
    name: source.name,
    testid: source.testid,
    selector: source.selector,
    index: source.index,
  };
  if (includeText) (target as any).text = source.text;
  const els = findElementsFor(target);
  return els.length ? els[0] : null;
}

// 元素中心点是否被其他元素遮挡（loading 遮罩、弹层等）。
//
// ⚠ 必须**穿透 shadow tree** 才判得准。`document.elementFromPoint` 只到 shadow **宿主**
// 为止（它不进入 shadow tree），于是任何 shadow 内的元素都会被判成"被宿主遮挡"。
// 实测后果（做 Shadow DOM 场景时踩到，而且是**静默**的）：
//   · `type_text` 往组件内的输入框打字**直接失败**，报「目标输入元素不可操作（不可见、被遮挡或尚未就绪）」；
//   · `click_element` 看似能用，其实只是靠"被遮挡就改用程序化点击"的兜底，
//     而且反馈里那句「被遮挡」是**假的** —— 它会把模型引向"有东西挡住了"这个错误方向。
// `ShadowRoot` 上也有 `elementFromPoint`，逐层往下钻即可拿到真正的命中元素。
function deepestElementAt(x: any, y: any) {
  let el = document.elementFromPoint(x, y);
  let guard = 0;
  // 最多下钻 10 层，防止异常结构造成死循环
  while (el && el.shadowRoot && guard < 10) {
    let inner = null;
    try {
      inner = el.shadowRoot.elementFromPoint(x, y);
    } catch (e: any) {
      inner = null;
    }
    if (!inner || inner === el) break;
    el = inner;
    guard += 1;
  }
  return el;
}

// node 是否就是 el、或位于 el 的（穿透 shadow 边界的）子树里。
// 为什么不能用 `el.contains(node)`：`contains` **不跨 shadow 边界**，
// 于是"命中元素其实是 el 的 shadow 子节点"这种情况会被误判成遮挡。
function isSelfOrShadowDescendant(node: any, el: any) {
  let n = node;
  let guard = 0;
  while (n && guard < 50) {
    if (n === el) return true;
    // ShadowRoot 的 nodeType 是 11，往上要经 host 才能接回宿主所在的树
    n = n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentNode;
    guard += 1;
  }
  return false;
}

function isElementCovered(el: any) {
  if (!el || !el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const x = rect.left + Math.min(rect.width / 2, 8);
  const y = rect.top + Math.min(rect.height / 2, 8);
  const top = deepestElementAt(x, y);
  if (!top) return false;
  // 命中元素自身、或其（含 shadow）子元素都算可点击；命中无关元素视为被遮挡。
  return !isSelfOrShadowDescendant(top, el);
}

function isActionable(el: any) {
  if (!el || !el.isConnected) return false;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
  const style = window.getComputedStyle(el);
  if (style.pointerEvents === 'none') return false;
  return isVisibleForAction(el) && !isElementCovered(el);
}

// 动作前准备：滚动到视口，并轮询等待元素可见、可用、不被遮挡。
function ensureActionable(el: any, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const scroll = () => {
      try { el.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch (e: any) {}
    };
    scroll();
    const check = () => {
      if (isActionable(el)) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      scroll();
      setTimeout(check, 90);
    };
    check();
  });
}

// 派发完整的指针/鼠标事件序列，兼容只监听 pointerdown/mousedown 的框架；
// 最后用 el.click() 触发浏览器默认行为（链接跳转、表单提交）。
function dispatchRealisticClick(el: any) {
  const rect = el.getBoundingClientRect();
  const opts = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
    buttons: 1,
  };
  const pointerOpts = Object.assign({}, opts, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
  el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  if (el.click) el.click();
}

function editableValue(el: any) {
  if (!el) return null;
  // contenteditable 的 textContent 会把段落边界压成连续文本；innerText 保留换行。
  // 输入校验必须基于用户实际看到/编辑器实际读到的文本。
  if (el.isContentEditable) return String(el.innerText !== undefined ? el.innerText : el.textContent || '');
  if (typeof el.value === 'string') return el.value;
  return null;
}

function setNativeValue(el: any, value: any) {
  if (el.isContentEditable) {
    el.textContent = value;
    return;
  }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && descriptor.set) descriptor.set.call(el, value);
  else el.value = value;
}

function dispatchInputChange(el: any, text: any) {
  try {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  } catch (e: any) {
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function selectEditableContents(el: any) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  } catch (e: any) {}
}

function placeCaretAtEnd(el: any) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  } catch (e: any) {}
}

/**
 * 富文本写入策略。
 *
 * 直接写 `textContent` 会绕过编辑器状态机（ProseMirror/Tiptap 等），
 * 实测会把换行压平、只保留一部分内容，并让卡片出现重复/残留。
 * 优先用浏览器的编辑命令，让页面收到正常的 input/beforeinput；
 * 命令不可用时才退回 DOM 写入，并由调用方按回读结果判定是否真的成功。
 */
function writeContentEditable(el: any, value: any, clearFirst: any) {
  el.focus();
  try {
    if (clearFirst === true) {
      selectEditableContents(el);
      document.execCommand('delete', false, null as any);
    } else {
      placeCaretAtEnd(el);
    }
    const text = String(value);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        // 单次 insertText 在部分编辑器里会把 \n 规整成空格；逐段插入更可靠。
        const para = document.execCommand('insertParagraph', false, null as any);
        if (!para) {
          const br = document.execCommand('insertLineBreak', false, null as any);
          if (!br) document.execCommand('insertText', false, '\n');
        }
      }
      if (lines[i] || i === 0) {
        const ok = document.execCommand('insertText', false, lines[i]);
        if (!ok) throw new Error('insertText 返回 false');
      }
    }
    return 'execCommand-insertText';
  } catch (e: any) {
    // 最后的兼容路径：不能保证编辑器状态，但至少保持旧的 DOM 写入能力；
    // 返回值会带上 strategy，且调用方会用回读结果做严格判定。
    el.textContent = String(value);
    dispatchInputChange(el, String(value));
    return 'textContent-fallback';
  }
}

async function cmdTypeText(params: any) {
  // includeText 走默认 true：type_text 的 schema 明确写着
  // 「value 是要输入的文本，text 是用于定位元素的文本片段，两者语义不同」，
  // 所以 text 是**定位符**，必须转发。原先传 false（那是 value/text 尚未拆分时的遗留），
  // 结果是 schema 承诺的 text 定位对 type_text 静默失效。
  const el = firstTarget(params);
  if (!el) return { ok: false, error: '未找到可输入的目标元素' };
  const isEditable = el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
  if (!isEditable) return { ok: false, error: '目标元素不是 input、textarea 或 contenteditable' };
  if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') return { ok: false, error: '目标输入元素不可编辑' };
  if (el.tagName === 'INPUT' && ['file', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) {
    return { ok: false, error: '不支持向该 input 类型输入文本：' + el.type };
  }
  const ready = await ensureActionable(el);
  if (!ready) return { ok: false, error: '目标输入元素不可操作（不可见、被遮挡或尚未就绪）' };
  // 负载取 params.value；`params.text` 只作为**旧宏的兼容回退**。
  // 拆分原因：`text` 曾经同时充当「定位片段」与「输入内容」，导致
  // 「在含某文本的元素里输入」在实现上不可能成立 —— 定位用的是它、要输入的也是它。
  // 现在 text 只用于定位（见 findElementsFor），value 才是输入内容。
  // 旧宏（保存时只有 text）仍能回放，但新记录一律写 value（见 tools.js recordTraceStep）。
  const text = String(
    params.value !== undefined && params.value !== null
      ? params.value
      : params.text === undefined || params.text === null
        ? ''
        : params.text
  );
  const before = editableValue(el) || '';
  const next = params.clearFirst === true ? text : before + text;
  let strategy = 'native-value';
  try {
    el.focus();
    if (el.isContentEditable) {
      strategy = writeContentEditable(el, text, params.clearFirst === true);
    } else {
      setNativeValue(el, next);
      dispatchInputChange(el, text);
    }
  } catch (e: any) {
    return { ok: false, error: '输入文本失败：' + e.message };
  }
  if (before !== next) {
    pageCommandSession.pushUndo(() => {
      try {
        if (el.isContentEditable) writeContentEditable(el, before, true);
        else setNativeValue(el, before);
        dispatchInputChange(el, before);
      } catch (e: any) {}
    });
  }
  // 回读实际值。原先只声称「已清空并输入 N 个字符」，**不回读** —— 于是当最终值出现
  // 意外前缀（实测 `a冒烟测试 smoke-test 123`）时，无法判断是工具没清干净，
  // 还是别处（宏回放里的 press_key？）写进去的。不回读就无法归因，只能靠猜。
  await nextPaint();
  const after = editableValue(el) || '';
  const summary = editableTextSummary(next, after);
  const matched = summary.matchesIntent;
  const clip = (s: any) => JSON.stringify(String(s).slice(0, 80));
  const result = {
    ok: matched,
    changed: before !== next,
    alreadySatisfied: before === next,
    valuePresent: Boolean(next),
    valueBefore: before,
    valueAfter: after,
    matchesIntent: matched,
    partial: !matched,
    strategy,
    expectedLength: summary.expectedLength,
    actualLength: summary.actualLength,
    firstDifference: summary.firstDifference,
    selector: elementSelector(el),
    result:
      matched
        ? (params.clearFirst === true ? '已清空并输入 ' : '已输入 ') +
          text.length +
          ' 个字符；实际值（' +
          summary.actualLength +
          ' 字符）：' +
          clip(after)
        : '输入未达到预期（strategy=' +
          strategy +
          '）：预期 ' +
          summary.expectedLength +
          ' 字符，实际 ' +
          summary.actualLength +
          ' 字符，首个差异在 ' +
          summary.firstDifference.index +
          '。实际值：' +
          clip(after) +
          '。⚠ 与预期不符 —— 预期为 ' +
          clip(next) +
          '。不要假设已写入，请重读编辑器或改用粘贴/编辑器专用写入。',
  };
  return result;
}

function keyCodeFor(key: any) {
  const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Space: 32 };
  return (codes as Record<string, number>)[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
}

function keyCodeName(key: any) {
  if (key.length === 1 && /^[a-z]$/i.test(key)) return 'Key' + key.toUpperCase();
  if (key.length === 1 && /^\d$/.test(key)) return 'Digit' + key;
  return key;
}

function cmdPressKey(params: any) {
  const el = firstTarget(params, false) || (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body);
  if (!el) return { ok: false, error: '没有可接收键盘事件的目标元素' };
  const key = String(params.key || '');
  if (!key) return { ok: false, error: 'key 不能为空' };
  const modifiers = Array.isArray(params.modifiers) ? params.modifiers.map((x: any) => String(x).toUpperCase()) : [];
  const init = {
    key,
    code: keyCodeName(key),
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: modifiers.includes('CTRL'),
    altKey: modifiers.includes('ALT'),
    shiftKey: modifiers.includes('SHIFT'),
    metaKey: modifiers.includes('META'),
    keyCode: keyCodeFor(key),
    which: keyCodeFor(key),
  };
  try {
    if (el.focus) el.focus();
    const down = new KeyboardEvent('keydown', init);
    el.dispatchEvent(down);
    if (key.length === 1 || key === 'Enter' || key === 'Space') el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    // 合成 KeyboardEvent 不会自动触发浏览器默认行为；补齐最常用的 Enter/Space 行为。
    if (!down.defaultPrevented && (key === 'Enter' || key === 'Space')) {
      if (el.form && key === 'Enter' && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
      else if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && el.click) el.click();
    }
  } catch (e: any) {
    return { ok: false, error: '键盘事件失败：' + e.message };
  }
  return { ok: true, eventDispatched: true, selector: el && el.tagName ? elementSelector(el) : undefined, result: '已向目标元素派发按键：' + key };
}

function cmdSelectOption(params: any) {
  const el = firstTarget(params, false);
  if (!el) return { ok: false, error: '未找到 select 元素' };
  if (el.tagName !== 'SELECT') return { ok: false, error: '目标元素不是 select' };
  if (el.disabled) return { ok: false, error: 'select 元素不可用' };
  const options = Array.from<any>(el.options || []);
  let index = -1;
  if (params.index !== undefined && params.index !== null) index = Number(params.index);
  else if (params.value !== undefined) index = options.findIndex((o) => o.value === String(params.value));
  else if (params.label !== undefined) index = options.findIndex((o) => String(o.textContent || '').trim() === String(params.label).trim());
  if (!Number.isInteger(index) || index < 0 || index >= options.length) return { ok: false, error: '未找到匹配的 option' };
  if (options[index].disabled) return { ok: false, error: '目标 option 已禁用' };
  const before = el.selectedIndex;
  try {
    el.selectedIndex = index;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  } catch (e: any) {
    return { ok: false, error: '选择 option 失败：' + e.message };
  }
  if (before !== el.selectedIndex) {
    pageCommandSession.pushUndo(() => {
      try {
        el.selectedIndex = before;
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } catch (e: any) {}
    });
  }
  return {
    ok: true,
    changed: before !== el.selectedIndex,
    alreadySatisfied: before === el.selectedIndex,
    selectedIndex: el.selectedIndex,
    selectedLabel: String(options[index].textContent || '').trim().slice(0, 200),
    selector: elementSelector(el),
    result: '已选择：' + String(options[index].textContent || '').trim().slice(0, 200),
  };
}

function isCheckControl(el: any) {
  if (!el) return false;
  const type = String(el.type || '').toLowerCase();
  const role = el.getAttribute('role');
  return ['checkbox', 'radio'].includes(type) || role === 'checkbox' || role === 'radio';
}

// 定位 checkbox/radio：优先 ref/selector/index；用 text 定位时，文本命中的往往是
// 关联的 label/容器，自动解析到其绑定的 checkbox/radio 控件。
function resolveCheckTarget(params: any) {
  let el = firstTarget(params, true);
  if (el && isCheckControl(el)) return el;
  if (el && params.text) {
    const label = el.closest('label');
    const linked = label && (isCheckControl(label.control) ? label.control : label.querySelector('input[type="checkbox"],input[type="radio"]'));
    if (linked) return linked;
    const container = el.closest('label,li,div,td');
    if (container) {
      const found = container.querySelector('input[type="checkbox"],input[type="radio"]');
      if (found) return found;
    }
  }
  return el;
}

function cmdCheckBox(params: any) {
  const el = resolveCheckTarget(params);
  if (!el) return { ok: false, error: '未找到 checkbox 或 radio 元素' };
  const type = String(el.type || '').toLowerCase();
  const role = el.getAttribute('role');
  if (!isCheckControl(el)) {
    return { ok: false, error: '目标元素不是 checkbox 或 radio（可按 text 定位关联 label，或改用 ref/selector）' };
  }
  const desired = params.checked === true;
  const before = type ? Boolean(el.checked) : el.getAttribute('aria-checked') === 'true';
  if (type === 'radio' && !desired) return { ok: false, error: 'radio 不能切换为未选中' };
  if (before !== desired) {
    try { el.click(); } catch (e: any) { return { ok: false, error: '切换选项失败：' + e.message }; }
  }
  const after = type ? Boolean(el.checked) : el.getAttribute('aria-checked') === 'true';
  // checkbox 可再次点击还原；radio 无法通过再次点击取消，故不记录撤销。
  if (before !== after && type !== 'radio') {
    pageCommandSession.pushUndo(() => { try { el.click(); } catch (e: any) {} });
  }
  return { ok: true, changed: before !== after, alreadySatisfied: before === desired, checked: after, selector: elementSelector(el), result: after ? '已选中' : '已取消选中' };
}

function waitStateMatches(el: any, params: any, state: any) {
  if (state === 'attached') return Boolean(el && el.isConnected);
  if (state === 'detached') return !el || !el.isConnected;
  if (!el || !el.isConnected) return false;
  if (state === 'enabled') return isVisibleForAction(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  if (state === 'text_contains') return String(el.innerText || el.textContent || '').includes(String(params.text || ''));
  return isVisibleForAction(el);
}

function cmdWaitForElement(params: any) {
  const state = ['attached', 'visible', 'enabled', 'text_contains', 'count', 'detached', 'url_contains'].includes(params.state) ? params.state : 'visible';
  if (state === 'url_contains') {
    if (!params.text) return Promise.resolve({ ok: false, matched: false, error: 'url_contains 需要 text 作为目标 URL 片段' });
  } else if (state === 'count') {
    if (!params.selector && !params.text) return Promise.resolve({ ok: false, matched: false, error: 'count 需要 selector 或 text 定位' });
  } else if (!params.ref && !params.selector && !params.text) {
    return Promise.resolve({ ok: false, matched: false, error: 'wait_for_element 需要 ref、selector 或 text' });
  }
  const timeoutMs = Math.min(15000, Math.max(100, Number(params.timeoutMs) || 8000));
  const pollMs = Math.min(1000, Math.max(25, Number(params.pollMs) || 100));
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let interval: any;
    let timeout: any;
    let observer: any;
    const cleanup = () => {
      clearInterval(interval);
      clearTimeout(timeout);
      if (observer) observer.disconnect();
    };
    const finish = (response: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const check = () => {
      if (state === 'count') {
        const count = findElementsFor(params).length;
        const target = Math.max(1, Number(params.count) || 1);
        if (count >= target) {
          finish({ ok: true, matched: true, count, result: '已等到 ' + count + ' 个匹配元素（目标 >= ' + target + '）' });
          return;
        }
      } else if (state === 'url_contains') {
        if (location.href.includes(String(params.text || ''))) {
          finish({ ok: true, matched: true, result: 'URL 已包含：' + params.text });
          return;
        }
      } else if (state === 'detached') {
        const el = firstTarget(params);
        if (!el || !el.isConnected) {
          finish({ ok: true, matched: true, result: '目标元素已消失' });
          return;
        }
      } else {
      const el = firstTarget(params);
      if (el && waitStateMatches(el, params, state)) {
        finish({ ok: true, matched: true, result: '已等到目标元素（' + state + '）' });
        return;
      }
      }
      if (Date.now() - started >= timeoutMs) {
        const current = firstTarget(params);
        const currentText = current
          ? String(current.innerText || current.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160)
          : '';
        const currentCount = findElementsFor(params).length;
        const hint = currentText
          ? '当前命中的元素文本是：' + JSON.stringify(currentText) + '。请核对 text 条件或改用 selector/ref。'
          : describeLookupMiss(params, 3) || '当前没有命中元素；若是自定义组件/异步渲染，请重读快照或改用 selector。';
        finish({
          ok: false,
          matched: false,
          timeout: true,
          currentCount,
          currentText,
          error: '等待元素超时（' + timeoutMs + 'ms）。' + hint,
        });
      }
    };
    interval = setInterval(check, pollMs);
    timeout = setTimeout(check, timeoutMs + 5);
    if (typeof MutationObserver !== 'undefined' && document.documentElement) {
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    check();
  });
}

function cmdGetAttribute(params: any) {
  const el = firstTarget(params);
  if (!el) return { ok: false, error: targetMissError(params) };
  const attribute = String(params.attribute || '').trim().toLowerCase();
  if (!/^[a-zA-Z_:][a-zA-Z0-9:._-]*$/.test(attribute)) return { ok: false, error: '属性名无效' };
  const raw = el.getAttribute(attribute);
  const inputType = String(el.type || '').toLowerCase();
  const sensitive = attribute === 'value' && (inputType === 'password' || /cc-number|cc-csc|one-time-code/i.test(el.getAttribute('autocomplete') || ''));
  const value = sensitive ? null : raw === null ? null : String(raw).slice(0, 2000);
  return {
    ok: true,
    attribute,
    present: raw !== null,
    value,
    valueRedacted: sensitive,
    result: sensitive ? '属性存在，但敏感值已隐藏' : (raw === null ? '属性不存在：' + attribute : attribute + ' = ' + value),
  };
}

export const typeText = cmdTypeText;
export const pressKey = cmdPressKey;
export const selectOption = cmdSelectOption;
export const checkBox = cmdCheckBox;
export const waitForElement = cmdWaitForElement;
export const getAttribute = cmdGetAttribute;
export const click = cmdClick;

// Read-only page inspection and extraction use cases.
import {
  elementSelector,
  findMainContent,
  isElementRendered,
  shadowDepth,
  ancestorPath,
  resolveElementRef,
} from '../page-text.ts';
import { normalizeCitationText, isElementCollectExcluded } from '../citation.ts';
import { expandTableGrid, formatTableText, parseGridPagination } from '../../../shared/table.ts';
import { sliceSafe } from '../../../shared/surrogates.ts';
import {
  DEFAULT_STYLE_PROPS,
  formatInspectMatches,
  formatInspectSummary,
  formatInvalidControls,
  formatSelectOptions,
  formatStylesSummary,
} from '../../../shared/format/page-results.ts';
import {
  accessibleName,
  describeTargetState,
  findElementsByRoleName,
  findElementsByTestId,
  findElementsFor,
  findRangeFor,
  normName,
  queryAllInFrames,
  roleOf,
  targetMissError,
} from './locator.ts';

// ---- 元素渲染态读取（供 MCP 的 verify_change 断言「改完代码后页面对不对」）----

// 元素是否被渲染出可见布局。注意语义是「有布局且可见」，不要求落在当前视口内。
function isRenderedForVerify(el: any) {
  try {
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  } catch (e: any) {
    return false;
  }
}

function normalizeInnerText(el: any) {
  return sliceSafe(String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), 0, 300);
}

// 读取单个元素的渲染态；styles 为需要额外读取的计算样式属性名列表。
function readElementState(el: any, styles: any) {
  const rect = el.getBoundingClientRect();
  const cs = window.getComputedStyle(el);
  const state: any = {
    selector: elementSelector(el),
    tag: el.tagName.toLowerCase(),
    visible: isRenderedForVerify(el),
    text: normalizeInnerText(el),
    box: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
  };
  if (typeof el.value === 'string') state.value = sliceSafe(el.value, 0, 300);
  if (Array.isArray(styles) && styles.length) {
    const out: Record<string, string> = {};
    for (const p of styles.slice(0, 12)) {
      const prop = String(p || '').trim();
      if (!prop) continue;
      try {
        out[prop] = sliceSafe(String(cs.getPropertyValue(prop) || '').trim(), 0, 120);
      } catch (e: any) {}
    }
    state.styles = out;
  }
  return state;
}

/**
 * 批量读取目标元素的渲染态，供断言使用。
 * 定位复用 ref / role+name / testid / selector / text（findElementsFor），
 * 因此与 click_element / type_text 等工具使用同一套定位语义，HMR 后不会因换定位方式而失配。
 * @param {Array} targets - [{label, selector|ref|role+name|testid|text, index?, styles?}]
 */
export function verifyTargets(targets: any) {
  const list = Array.isArray(targets) ? targets.slice(0, 20) : [];
  return list.map((t, i) => {
    const src = t || {};
    const hasLocator = Boolean(src.ref || src.role || src.name || src.testid || src.selector || src.text);
    // 注意：不能把 index 交给 findElementsFor —— 它会切片成单元素，导致 count 失真。
    const locator = { ref: src.ref, role: src.role, name: src.name, testid: src.testid, selector: src.selector, text: src.text };
    let els = [];
    try {
      els = findElementsFor(locator);
    } catch (e: any) {
      els = [];
    }
    const idxRaw = Number(src.index);
    const idx = Number.isInteger(idxRaw) && idxRaw >= 0 ? idxRaw : 0;
    const el = els[idx] || null;
    const out: any = { index: i, label: String(src.label || '').trim(), count: els.length, found: Boolean(el) };
    if (el) {
      Object.assign(out, readElementState(el, src.styles));
    } else if (!hasLocator) {
      out.reason = '目标未提供定位方式（需要 selector / ref / role+name / testid / text 之一）';
    } else {
      out.reason = els.length
        ? 'index ' + idx + ' 超出匹配元素数量（共 ' + els.length + ' 个）'
        : '未找到匹配元素';
    }
    return out;
  });
}

// 元素侦查：一次回答「这些元素在哪、还看不看得见、属于哪个容器、容器是否含正文」。
// 这四件事以前都要模型用 run_javascript 逐层查 DOM —— 一次去广告任务因此多出十几轮往返
// （探查 → 等结果 → 再探查），而每一轮都是一次完整的模型请求。
// 收集**没通过 HTML5 原生校验**的表单控件（含匹配元素内部的）。
//
// 为什么必须由工具给出这一条：页面对"没通过校验"通常是**静默**的 ——
// 浏览器只在**它自己的原生气泡**里提示（工具读不到），DOM 里既没有错误文案、
// 提交也不会发生、状态文案也不变。于是"点了提交没反应"看起来像"按钮坏了"。
//
// 实测（真模型探针）：模型为此换了 **8 次调用**四处找原因
//（read_current_page ×2 / read_diagnostics / inspect_element ×2 / get_ax_snapshot /
// get_page_snapshot），还**借道 run_javascript 自己扫 DOM**（一次高危审批）——
// 而它最早、最自然的那个动作就是 `inspect_element({op:"inspect", selector:"body"})`，
// 只要那一步能回答，后面全都不必发生。所以这一档补在 **inspect** 上。
//
// 关键：`validationMessage` 是**浏览器语言**的（中英日随环境变），拿它做判据会脆；
// 所以同时给出**与语言无关的约束名**（valueMissing / tooShort / typeMismatch …）。
function collectInvalidControls(root: any) {
  const out = [];
  const seenSel = new Set();
  // 扫描范围：元素自身 + 它内部的控件 + **它所在的那个表单**。
  //
  // 为什么必须带上"所在表单"：实测模型遇到"提交没反应"时，`op:"inspect"` 看的是
  // **它刚点的那个按钮**（`#ok`）—— 按钮内部当然没有无效字段，于是它拿不到答案，
  // 只好连续 9 次 `get_attribute` 把 required/pattern/type 全读一遍自己推（31 次调用、2 次审批）。
  // 校验的作用域本来就是**表单**，所以被查元素在某个 form 里时，一并把那个 form 的
  // 未通过字段报出来 —— 这才是用户/模型真正想问的那个问题。
  const roots: any[] = [];
  const push = (el: any) => {
    if (el && roots.indexOf(el) === -1) roots.push(el);
  };
  push(root);
  try {
    if (root && root.closest) push(root.closest('form'));
  } catch (e: any) {}
  for (const scope of roots) {
    let nodes = [];
    try {
      nodes = Array.prototype.slice.call(scope.querySelectorAll('input, select, textarea'));
    } catch (e: any) {
      nodes = [];
    }
    if (scope && /^(INPUT|SELECT|TEXTAREA)$/.test(String(scope.tagName || ''))) nodes.unshift(scope);
    for (const el of nodes) {
      const v = el.validity;
      if (!v || v.valid !== false) continue;
      const sel = elementSelector(el);
      if (seenSel.has(sel)) continue;
      seenSel.add(sel);
      const reasons = [
        'valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort',
        'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError',
      ].filter((k) => v[k] === true);
      out.push({
        selector: sel,
        name: sliceSafe(String(el.getAttribute('aria-label') || el.name || el.id || ''), 0, 60),
        reasons,
        message: sliceSafe(String(el.validationMessage || ''), 0, 160),
        value: typeof el.value === 'string' ? sliceSafe(el.value, 0, 80) : '',
      });
      if (out.length >= 12) return out;
    }
  }
  return out;
}

function cmdInspectElement(params: any) {
  // 命中总数必须在**截断之前**取。
  // 原实现先 slice(0, 8) 再把 matches.length 当作命中数报出去，于是任何命中 ≥8 个
  // 元素的选择器都恒返回「命中 8 个元素」—— 而调用方无法区分「正好 8 个」与
  // 「至少 8 个」。实测会话里调用方正好在找「8 处高亮」，工具恒回 8，
  // 一个截断上限被当成了答案：这类「永远返回期望值」的输出比返回错误值更危险。
  const all = findElementsFor(params);
  if (!all.length) return { ok: false, error: targetMissError(params) };
  const MAX_LISTED = 8;
  const listed = all.slice(0, MAX_LISTED);
  const truncated = all.length > listed.length;
  const main = findMainContent();
  const mainSel = main && main.selector ? main.selector : '';
  const matches = listed.map((el) => {
    const rect = el.getBoundingClientRect();
    let containsMain = false;
    if (mainSel) {
      try {
        containsMain = elementSelector(el) === mainSel || Boolean(el.querySelector(mainSel));
      } catch (e: any) {
        containsMain = false;
      }
    }
    return {
      selector: elementSelector(el),
      tag: String(el.tagName || '').toLowerCase(),
      visible: isElementRendered(el),
      shadowDepth: shadowDepth(el) || undefined,
      size: { w: Math.round(rect.width), h: Math.round(rect.height) },
      textLength: String(el.textContent || '').length,
      path: ancestorPath(el),
      containsMainContent: containsMain || undefined,
    };
  });
  const visibleCount = matches.filter((m) => m.visible).length;
  const hidden = matches.length - visibleCount;
  // 表单合法性：只把**没通过**的列出来（全通过时不加任何内容，避免给每次 inspect 都塞一段废话）。
  const invalid = collectInvalidControls(listed[0]);
  // 正文容器提醒只在**命中项确实触到它**时给出。
  // 原先无条件附加，于是「查高亮浮层」这类无关查询也会收到
  // 「疑似正文容器：#root…不要连带隐藏它」，实测 5 次调用重复 5 遍，纯噪声。
  const touchesMain = matches.some((m) => m.containsMainContent);
  return {
    ok: true,
    count: all.length, // 命中总数（截断前）
    listed: matches.length, // 本次列出条数
    truncated,
    visibleCount,
    mainContent: main ? { selector: main.selector, textLength: main.textLength } : null,
    matches,
    invalidControls: invalid.length ? invalid : undefined,
    result:
      formatInspectSummary({
        total: all.length,
        listed: matches.length,
        visibleCount,
        truncated,
        touchesMain,
        main: main as any,
      }) +
      // 逐元素明细必须并进 result —— 页面命令走到模型的那条路只取 result 字符串，
      // 只放在 matches 字段里等于丢掉（见 formatInspectMatches 的注释）。
      (() => {
        const detail = formatInspectMatches(matches);
        return detail ? '\n列出：\n' + detail : '';
      })() +
      // 同一约定：合法性也要并进 result（模型只读得到这一段文本）
      formatInvalidControls(invalid),
  };
}

/**
 * 结构化元素查询（inspect_element({op:"query"})）。
 *
 * 为什么需要它：小红书实操里 70 次工具调用有 35 次 run_javascript，绝大多数是在
 * “找 custom element / 读 rect / 查 shadow / 找可滚动容器”。这些是只读查询，
 * 不该借道高危 JS，更不该靠反复试探。
 *
 * 与 op:"inspect" 的区别：inspect 面向“已知目标，判断状态”；query 面向
 * “给条件，返回候选清单”，并且把 ref / rect / role / name / customElement / shadowDepth
 * 一次交齐，后续动作可以直接用返回的 ref。
 */
function cmdQueryElements(params: any) {
  const p = params || {};
  const limit = Math.min(50, Math.max(1, Number(p.limit) || 20));
  const includeHidden = p.includeHidden === true;
  const seen = new Set();
  const all: any[] = [];
  // 有多少命中因为「不可见」被筛掉。零命中时这是最有用的诊断：
  // 元素存在但被折叠/懒加载/透明，与「页面上根本没有它」是两种完全不同的下一步。
  let hiddenSkipped = 0;
  const push = (el: any) => {
    if (!el || seen.has(el)) return;
    if (isElementCollectExcluded(el)) return;
    if (!includeHidden && !isElementRendered(el)) {
      hiddenSkipped += 1;
      return;
    }
    seen.add(el);
    all.push(el);
  };

  if (p.selector) {
    try { queryAllInFrames(document, p.selector).forEach(push); } catch (e: any) {}
  } else if (p.role || p.name) {
    findElementsByRoleName(p.role, p.name).forEach(push);
    // custom element 未必有 role：按可访问名再补一轮，解决 xhs-publish-btn 这类目标。
    if (p.name) {
      try {
        queryAllInFrames(document, '*').forEach((el) => {
          const tag = String(el.tagName || '').toLowerCase();
          if (!tag.includes('-')) return;
          if (normName(accessibleName(el)).indexOf(normName(p.name)) === -1) return;
          push(el);
        });
      } catch (e: any) {}
    }
  } else if (p.testid) {
    findElementsByTestId(p.testid).forEach(push);
  } else if (p.text) {
    const q = normalizeCitationText(p.text);
    if (q) {
      // 先收集**文本命中**（含隐藏），再区分可见/隐藏。
      // 不能边扫边按可见性丢：textContent 会把 display:none 子树里的文字也算进来，
      // 于是 body 这类可见容器会因为「内部有个隐藏按钮」而假命中（实测夹具：
      // 查「隐藏操作」只返回 body，零命中诊断就永远触发不了）。
      const raw: any[] = [];
      try {
        queryAllInFrames(document, '*').forEach((el) => {
          if (isElementCollectExcluded(el)) return;
          const text = normalizeCitationText(el.textContent);
          if (!text.includes(q)) return;
          raw.push(el);
        });
      } catch (e: any) {}
      const hiddenRaw: any[] = [];
      const visibleRaw: any[] = [];
      for (const el of raw) {
        (isElementRendered(el) ? visibleRaw : hiddenRaw).push(el);
      }
      const visibleTextHas = (el: any) => {
        try {
          return normalizeCitationText(el.innerText).includes(q);
        } catch (e: any) {
          return true; // 读不到 innerText 时不要凭猜测把候选丢掉
        }
      };
      const reclassifiedHidden = [];
      const visibleMatches: any[] = [];
      for (const el of visibleRaw) {
        // 只有「可见容器内部还有隐藏命中」才需要用渲染文本复核 —— innerText 会触发布局，
        // 不该对每个候选都读。这一步正是为了挡住 body/大容器的假命中。
        const hasHiddenInside = hiddenRaw.some((h) => h !== el && el.contains(h));
        if (!hasHiddenInside || visibleTextHas(el)) visibleMatches.push(el);
        else reclassifiedHidden.push(el);
      }
      if (includeHidden) {
        // 与 selector 分支同义：includeHidden 时把隐藏命中也列出来。
        visibleMatches.push(...hiddenRaw);
      } else {
        const hiddenAll = hiddenRaw.concat(reclassifiedHidden);
        // 只数最深层：一个隐藏子树里的祖先与后代都含同一段文字，数祖先会虚报。
        hiddenSkipped = hiddenAll.filter(
          (el) => !hiddenAll.some((o) => o !== el && el.contains(o))
        ).length;
      }
      // 只保留最深层命中，避免把 body/大容器也列出来。
      // 自定义元素宿主必须保留：它的内部文字会命中，但它本身才是可点击/可读的组件边界。
      const deepest = visibleMatches.filter((el) => {
        if (String(el.tagName || '').toLowerCase().includes('-')) return true;
        return !visibleMatches.some((other) => other !== el && el.contains(other));
      });
      all.length = 0;
      seen.clear();
      deepest.forEach(push);
    }
  } else {
    return { ok: false, error: 'query 需要 selector、role/name、testid 或 text 之一作为查询条件' };
  }

  const sorted = all
    .slice()
    .sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const va = ra.width > 0 && ra.height > 0 ? 0 : 1;
      const vb = rb.width > 0 && rb.height > 0 ? 0 : 1;
      return va - vb || ra.top - rb.top || ra.left - rb.left;
    });
  const listed = sorted.slice(0, limit);
  const items = listed.map((el) => {
    const rect = el.getBoundingClientRect();
    const tag = String(el.tagName || '').toLowerCase();
    const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const role = roleOf(el);
    return {
      ref: resolveElementRef(el),
      tag,
      role: role || undefined,
      name: sliceSafe(accessibleName(el), 0, 120),
      selector: elementSelector(el),
      text: sliceSafe(text, 0, 180),
      visible: isElementRendered(el),
      customElement: tag.includes('-') || undefined,
      shadowDepth: shadowDepth(el) || undefined,
      editable: Boolean(el.isContentEditable || tag === 'textarea' || tag === 'input'),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
      path: ancestorPath(el),
    };
  });
  const lines = items.map((it, i) =>
    '[' + (i + 1) + '] ref=' + it.ref + ' tag=' + it.tag +
    ' selector=' + it.selector +
    (it.role ? ' role=' + it.role : '') +
    (it.name ? ' name=' + JSON.stringify(it.name) : '') +
    (it.customElement ? ' custom=true' : '') +
    ' ' + it.rect.width + '×' + it.rect.height +
    ' center=(' + it.center.x + ',' + it.center.y + ')' +
    (it.text ? ' text=' + JSON.stringify(it.text.slice(0, 60)) : '')
  );
  if (!items.length) {
    // 零命中不是「答案为空」，而是一个需要给出下一步的分叉。
    // 不返回 ok:false：查询本身成功执行了，零结果也是有效结果；
    // 但必须说清是「隐藏」「没渲染」还是「这里根本看不到它」。
    const reasons = [];
    if (hiddenSkipped) {
      reasons.push(
        '有 ' + hiddenSkipped + ' 个元素命中但当前不可见（折叠菜单/懒加载/透明/零尺寸）。' +
          '传 includeHidden:true 可列出它们，或先点击展开再查。'
      );
    }
    if (p.text) {
      let bodyText = '';
      try {
        bodyText = normalizeCitationText(document.body ? document.body.innerText : '');
      } catch (e: any) {}
      const q = normalizeCitationText(p.text);
      reasons.push(
        q && bodyText.includes(q)
          ? '这段文字在当前可见正文里，但没有落到可定位的元素边界；改用 selector / role+name，或用 get_ax_snapshot 取可访问节点。'
          : '当前可见正文里没有这段文字：可能尚未渲染（用 wait_for_element 等它出现），或在跨域 iframe（list_frames）/ canvas / closed shadow 里。'
      );
    } else if (p.selector) {
      reasons.push(
        '选择器当前没有命中：确认它是否在开放 shadow root 内（本工具会穿透），或先用 wait_for_element({selector, state:"attached"}) 等它挂载。'
      );
    } else {
      reasons.push('可换 role+name / testid / text 再查，或先用 get_page_snapshot 看页面上有哪些可交互元素。');
    }
    if (!hiddenSkipped && (p.selector || p.role || p.name || p.testid)) {
      reasons.push('若目标在跨域 iframe，用 list_frames 找到 frameId 后先 get_page_snapshot({frameId}) 再操作。');
    }
    return {
      ok: true,
      count: 0,
      listed: 0,
      truncated: false,
      hiddenSkipped,
      elements: [],
      result: '元素查询命中 0 个。\n诊断：\n- ' + reasons.join('\n- '),
    };
  }
  return {
    ok: true,
    count: all.length,
    listed: items.length,
    truncated: all.length > items.length,
    elements: items,
    result:
      '元素查询命中 ' + all.length + ' 个（列出 ' + items.length + ' 个）：\n' +
      (lines.join('\n') || '（无）') +
      '\n提示：可直接把 ref 传给 click_element / type_text / get_attribute；custom=true 表示自定义元素，center 可用于 click_at 降级。',
  };
}

// 读取一批元素的**计算样式**（只读：不 eval、不写 DOM、不需要审批）。
//
// 为什么必须有它（本轮做「UI 美化」时暴露的缺口）：
//   `annotate({ op:"style" })` 只回一句「已修改 N 个元素」—— 那证明的是"调用发出去了"，
//   不是"样式真的生效了"（可能被 `!important` 覆盖、或因取值非法被忽略）。
//   在此之前面板侧唯一的取证路径是 `run_javascript` 读 getComputedStyle，而它有两个硬伤：
//     ① 元数据是 `alwaysRequireApproval`：**任何审批策略都拦不住地打断用户**；
//     ② 它经 eval 执行，而 MV3 扩展自身的 CSP 不允许 eval（与页面无关），
//        所以**必须**另开 CDP 才能落到页面主世界。
//   而"读一下算出来的样式"本来是彻头彻尾的只读操作 —— 它就该和 inspect/text/table 一样
//   待在只读工具里，而不是借道一个高危工具。
//
// 复用 `readElementState`（原本只给 MCP 侧的 verify_change 用），所以不引入新的取值逻辑。
// 读 `<select>` 的选项清单。
//
// 为什么需要它（与 cmdReadStyles 同一类缺口，实测挖出来的）：
//   · 闭合的 `<select>` 里 `<option>` **没有布局盒子**，正文抽取按"不可见"跳过 ——
//     所以 `get_page_snapshot` 的正文里**看不到选项文案**（价格/规格常常只写在选项里）；
//   · `get_attribute` 只读**属性**，读不了 `outerHTML`。
// 于是"这个下拉框有哪些选项"此前**没有只读办法**。
// 真模型探针实测：任务"选最便宜的那个"时，模型只能先写一段 run_javascript
//（`Array.from(s.options).map(...)`）—— 白花一次高危审批，CSP 严的页面还会直接失败。
//
// 返回里同时给结构化 items 与拼好的文本；**文本必须并进 result**（见 docs/tool-design.md §6）。
function cmdReadOptions(params: any) {
  const els = findElementsFor(params);
  if (!els.length) return { ok: false, error: targetMissError(params) };
  const el = els[0];
  const tag = (el.tagName || '').toUpperCase();
  if (tag !== 'SELECT') {
    // 说清"这是什么元素"，而不是只报"不是 select" —— 模型据此才知道该换个目标
    return {
      ok: false,
      error:
        '目标元素不是 <select>（实际是 ' + (tag || '未知') + describeTargetState(el) + '）。' +
        'read_options 只能读下拉框；要读别的元素的文字请用 op:"text"。',
    };
  }
  const MAX_OPTIONS = 60;
  const all = Array.prototype.slice.call(el.options || []);
  const listed = all.slice(0, MAX_OPTIONS);
  const items = listed.map((o, i) => ({
    index: i,
    value: o.value,
    label: String(o.textContent == null ? '' : o.textContent).replace(/\s+/g, ' ').trim(),
    selected: !!o.selected,
    disabled: !!o.disabled,
  }));
  const multiple = !!el.multiple;
  const optionsText = formatSelectOptions(items);
  return {
    ok: true,
    count: all.length,
    truncated: all.length > listed.length,
    multiple,
    selectedIndex: el.selectedIndex,
    items,
    result:
      '下拉框选项（共 ' + all.length + ' 项' + (multiple ? '，多选' : '') +
      (all.length > listed.length ? '，只列出前 ' + listed.length + ' 项' : '') + '）：\n' +
      (optionsText || '（没有选项）') +
      '\n（选中请用 select_option：按 value 或 label 都行）',
  };
}

function cmdReadStyles(params: any) {
  const els = findElementsFor(params);
  if (!els.length) return { ok: false, error: targetMissError(params) };
  const wanted =
    Array.isArray(params.props) && params.props.length
      ? params.props.map((p: any) => String(p === undefined || p === null ? '' : p).trim()).filter(Boolean).slice(0, 12)
      : DEFAULT_STYLE_PROPS.slice();
  const MAX_LISTED = 8;
  const listed = els.slice(0, MAX_LISTED);
  const items = listed.map((el) => readElementState(el, wanted));
  return {
    ok: true,
    count: els.length,
    truncated: els.length > listed.length,
    props: wanted,
    items,
    result: formatStylesSummary(items, els.length),
  };
}

// 结构化提取 <table>：把合并单元格还原成矩形网格后再输出。
// 朴素做法（逐行取 td 文本）在 rowspan/colspan 存在时必然整体错位。
// 网格展开算法在 lib/shared/table.js（纯函数，有单测）。
function cmdExtractTable(params: any) {
  const p = params || {};
  let table = null;
  let total = 0;
  let chosenIndex = -1;
  const wantAuto = p.auto === true || p.index === 'auto';
  try {
    const all = findElementsFor({ selector: 'table' });
    total = all.length;
    if (p.selector) {
      const hit = findElementsFor({ selector: p.selector });
      for (const el of hit) {
        if (el.tagName === 'TABLE') {
          table = el;
          break;
        }
        const inner = el.querySelector && el.querySelector('table');
        if (inner) {
          table = inner;
          break;
        }
      }
    } else if (wantAuto) {
      // 报表页常有布局表/筛选表排在前面；自动选可见、行数最多的主数据表。
      let bestScore = -1;
      for (let i = 0; i < all.length; i++) {
        const el: any = all[i];
        if (!el || el.tagName !== 'TABLE') continue;
        let rowCount = 0;
        try {
          rowCount = Array.from<any>(el.querySelectorAll('tr')).filter((tr: any) => tr.closest('table') === el).length;
        } catch (e: any) {
          rowCount = 0;
        }
        const headerCount = (el.querySelectorAll && el.querySelectorAll('th').length) || 0;
        const visible = el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
        const score = (visible ? 100000 : 0) + rowCount * 100 + headerCount * 10;
        if (score > bestScore) {
          bestScore = score;
          table = el;
          chosenIndex = i;
        }
      }
    } else {
      const idx = Math.max(0, Number(p.index) || 0);
      table = all[idx] || null;
      chosenIndex = idx;
    }
  } catch (e: any) {
    return { ok: false, error: '查找表格失败：' + ((e && e.message) || String(e)) };
  }
  if (!table) {
    return {
      ok: false,
      error: p.selector ? '未找到匹配的表格：' + p.selector : '页面上没有表格（或 index 超出范围；共 ' + total + ' 个）',
    };
  }

  // 只取属于本表的行：嵌套表格的行 closest('table') 会指向内层表，必须排除。
  let rows = [];
  try {
    rows = Array.from<any>(table.querySelectorAll('tr')).filter((tr: any) => tr.closest('table') === table);
  } catch (e: any) {
    rows = [];
  }
  const raw = rows.map((tr) =>
    Array.from<any>(tr.children || [])
      .filter((c: any) => c.tagName === 'TD' || c.tagName === 'TH')
      .map((c: any) => ({
        // innerText 对 display:none 的单元格返回空串，正是我们想要的（隐藏列不该进数据）
        text: (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim(),
        colspan: Number(c.getAttribute('colspan')) || 1,
        rowspan: Number(c.getAttribute('rowspan')) || 1,
        isHeader: c.tagName === 'TH',
      }))
  );

  const grid = expandTableGrid(raw, { maxRows: p.maxRows, maxCols: p.maxCols, fillMerged: p.fillMerged !== false });
  // 分页信息只从表格所在的网格/分页容器里读，避免把页面别处的数字误当总条数。
  let pagination: ReturnType<typeof parseGridPagination> = {
    total: null,
    currentPage: null,
    totalPages: null,
    pageSize: null,
    hasNext: null,
    raw: '',
  };
  try {
    const scrollRoot = table.closest('.admin__data-grid-wrap, [data-role="grid"], .data-grid, .grid, .pager, .pagination');
    const scope: any = scrollRoot || table.parentElement || document.body;
    const scopeText = (scope.innerText || scope.textContent || '').slice(0, 8000);
    pagination = parseGridPagination(scopeText);
  } catch (e: any) {}
  // markdown 只算一次，同时作为结构化字段与 result 正文的来源（避免两处各拼一遍、日后漂移）。
  const markdown = formatTableText(grid, { maxRows: 40 });
  return {
    ok: true,
    selector: elementSelector(table),
    tableIndex: p.selector ? undefined : chosenIndex,
    tableCount: total,
    headers: grid.headers,
    rows: grid.rows,
    widths: grid.widths,
    rowCount: grid.rows.length,
    mergedCells: grid.mergedCells,
    pagination,
    markdown,
    result:
      '表格「' + elementSelector(table) + '」：本页 ' + grid.rows.length + ' 行 × ' + grid.widths + ' 列' +
      (grid.mergedCells ? '（含 ' + grid.mergedCells + ' 个合并单元格，已展开对齐）' : '') +
      (grid.headers.length ? '，表头：' + grid.headers.join(' / ') : '，无表头') +
      (pagination.total !== null ? '；页面报告共 ' + pagination.total + ' 条' : '') +
      (pagination.currentPage !== null && pagination.totalPages !== null ? '（第 ' + pagination.currentPage + '/' + pagination.totalPages + ' 页）' : '') +
      (pagination.hasNext ? '，还有更多页' : '') +
      (total > 1 ? '。页面上共 ' + total + ' 个表格，可用 index/selector 指定。' : '') +
      // ⚠ 表格**数据本身**必须并进 result。
      // 原先只把它放在 markdown / rows 字段里，而页面命令走到模型的那条路
      // （executePageTool）只取 result 字符串 —— 于是模型只收到
      // 「4 行 × 4 列（含 4 个合并单元格，已展开对齐）」这一句摘要，
      // 而 expandTableGrid + formatTableText 辛苦还原出来的对齐数据**被整份丢掉**。
      // 这个工具存在的全部理由就是"把合并单元格还原成对齐网格再给模型"，
      // 丢掉数据等于它只剩一句自我介绍。
      '\n' + markdown,
  };
}

function cmdGetText(params: any) {
  if (params.text) {
    const range = findRangeFor(params);
    if (range) return { ok: true, result: range.toString() };
    return { ok: false, error: '未找到文本：' + params.text };
  }
  const els = findElementsFor(params);
  if (!els.length) return { ok: false, error: targetMissError(params) };
  const text = els.map((el) => (el.innerText || el.textContent || '').trim()).filter(Boolean).join('\n---\n').slice(0, 4000);
  // 「这次读真的发生了」的页面可见信号（详见 notifyElementsRead 的注释）。
  notifyElementsRead(els);
  return { ok: true, result: text || '（空内容）' };
}

/**
 * 把「**读取**了这几个元素」这件事通知给页面自己。
 *
 * 为什么需要：页面上有些值是**会过期的**（库存 / 报价 / 余量），而"过期"的时钟该从
 * **第一次真的被读到**开始走 —— 不是从"元素被展开"开始走。可在页面看来，
 * 读取是**不可观测**的：`innerText` / `textContent` 不产生任何 DOM 变更，
 * `MutationObserver` 只能看见**写**。于是页面无从知道"agent 已经看到了缓存值"。
 * 这里补上这个信号：在**真的读了**的每个元素上派发一个不冒泡的 `CustomEvent`，
 * 页面想参与就监听（不监听=零影响）。
 *
 * ⚠ 事件用 `bubbles: false`：只通知**被读的那个元素自己**，不惊动祖先/全局监听者；
 *   同时它对**主世界**（页面自己的脚本）可见 —— 内容脚本与主世界共享 DOM，
 *   在节点上派发的 DOM 事件两个世界都能收到（这是标准的页面↔扩展通信方式）。
 *   夹具 `/pick` 就是靠它把"重新询价"的时钟从"展开时"挪到"第一次读之后"的。
 *
 * ⚠ **代价（刻意接受，写在这里以免日后被当成疏漏）**：DOM 事件对**主世界**可见 ⇒
 *   页面脚本**可以**监听这个读信号事件，从而得知"扩展正在读我的元素"（**扩展指纹**）。
 *   接受它的理由：① 与本仓库既有做法一致 —— 注入的调试节点本来就**显式**加 `data-rf-injected`
 *   属性；② 信号**不携带被读到的文本**、不冒泡、只在真的发生读时才出现；
 *   ③ 它换来的是"过期数据"这类难点可以做成**结构性**的（见上）。
 *   若将来认为指纹风险不可接受，替代做法是让页面**不必**知道"被读"：
 *   把"重新询价"改成一个**必须点击**的按钮 —— 页面只依赖它本来就看得见的 click。
 *
 * 派发本身包在 try 里：页面里存在同名监听器却抛异常时，**不能**因此让"读文本"失败 ——
 * 读取类工具的结果与页面脚本的健壮性无关。
 */
function notifyElementsRead(els: any) {
  try {
    const list = Array.isArray(els) ? els : [els];
    for (const el of list) {
      if (!el || typeof el.dispatchEvent !== 'function') continue;
      el.dispatchEvent(new CustomEvent('recallflow:element-read', { bubbles: false, detail: { op: 'text' } }));
    }
  } catch (e: any) { /* 页面监听器抛异常不影响读取结果 */ }
}

export const inspectElement = cmdInspectElement;
export const queryElements = cmdQueryElements;
export const readOptions = cmdReadOptions;
export const readStyles = cmdReadStyles;
export const extractTable = cmdExtractTable;
export const readText = cmdGetText;

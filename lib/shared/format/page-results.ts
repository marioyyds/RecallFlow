import { sliceSafe } from '../surrogates.ts';

/**
 * 「读计算样式」默认读取的 CSS 属性（**连字符**写法，不是 JS 驼峰）。
 *
 * 为什么默认值要放在共享模块里：它同时出现在两处 —— 页面侧的实际读取（commands.js）
 * 与 schema 里给模型的说明（tool-schemas.js 只能写字面量，它是零 import 的纯数据模块）。
 * 放这里当唯一来源，再用一条门禁断言"schema 说明里列出的属性与这个常量一致"，
 * 就不会出现"文档说读了 A、实际读的是 B"。
 */
export const DEFAULT_STYLE_PROPS = Object.freeze([
  'font-size',
  'line-height',
  'color',
  'background-color',
  'width',
  'height',
  'display',
  'visibility',
  'opacity',
  'overflow-x',
  'position',
  'z-index',
]);

/**
 * 把 `<select>` 的选项清单排成模型可读的文本。
 *
 * ⚠ 必须**并进 `result`**（见 docs/tool-design.md §6）：`executePageTool` 只把 `res.result`
 * 交给模型，选项放在旁路字段里等于没给。
 *
 * 每行写明 `value` 与显示文本，并标出哪个**当前选中**、哪些**禁用** ——
 * 这三样是"能不能选对"的全部依据（价格 / 规格常常只写在显示文本里）。
 */
export function formatSelectOptions(items: any) {
  if (!Array.isArray(items) || !items.length) return '';
  return items
    .map((it, i) => {
      const parts = ['[' + (i + 1) + ']', 'value="' + String(it.value == null ? '' : it.value) + '"'];
      parts.push('文字="' + String(it.label == null ? '' : it.label) + '"');
      if (it.selected) parts.push('（当前选中）');
      if (it.disabled) parts.push('（禁用）');
      return parts.join(' ');
    })
    .join('\n');
}

/**
 * 把「没通过 HTML5 校验的表单控件」排成模型可读的文本；全部通过返回空串。
 *
 * ⚠ 必须**并进 `result`**（见 docs/tool-design.md §6）：页面命令走到模型的那条路只取 `result`。
 *
 * 每条给出：定位用的 selector、字段名、**与语言无关的约束名**、以及浏览器给的原文提示。
 * 约束名是判据的锚 —— `validationMessage` 随浏览器语言变（中/英/日），拿它做断言会脆。
 */
export function formatInvalidControls(items: any) {
  if (!Array.isArray(items) || !items.length) return '';
  const lines = items.map(
    (it, i) =>
      '[' + (i + 1) + '] ' + it.selector +
      (it.name ? '（' + it.name + '）' : '') +
      ' 原因：' + ((it.reasons || []).join('+') || '未知') +
      (it.message ? ' —— ' + it.message : '')
  );
  return (
    '\n⚠ 表单未通过校验（' + items.length + ' 个字段）—— **提交会被浏览器拦住、页面上不会有任何提示**：\n' +
    lines.join('\n')
  );
}

/**
 * 把「读计算样式」的结果排成模型可读的文本。
 *
 * 为什么不做成 JSON 就完事：模型要据此判断"改的样式到底生效没有"，
 * `font-size=17px  line-height=1.7` 这种一行一项的形态比嵌套 JSON 更容易逐项核对。
 * 结构化的 items 仍随返回值一起给出，需要精确取值时用它。
 *
 * @param {Array} items readElementState 的返回值列表
 * @param {number} [total] 命中总数（可能多于列出条数）
 */
export function formatStylesSummary(items: any, total: any) {
  const list = Array.isArray(items) ? items : [];
  const n = typeof total === 'number' && total > list.length ? total : list.length;
  const head =
    '计算样式（命中 ' + n + ' 个' + (n > list.length ? '，列出前 ' + list.length + ' 个' : '') + '）：';
  if (!list.length) return head + '（无）';
  const lines = list.map((it) => {
    const s = (it && it.styles) || {};
    const pairs = Object.keys(s)
      .map((k) => k + '=' + s[k])
      .join('  ');
    return '  ' + ((it && (it.selector || it.tag)) || '?') + (it && it.visible === false ? '（不可见）' : '') + '：' + (pairs || '（无）');
  });
  return head + '\n' + lines.join('\n');
}

/**
 * 把 inspect 的**逐元素明细**排成模型可读的文本。
 *
 * ⚠ 为什么这个函数存在（一个真实缺陷）：`formatInspectSummary` 只输出**计数**
 * （命中几个 / 可见几个 / 有没有触到正文容器），而逐元素的 selector、祖先链、尺寸
 * 原来只放在返回对象的 `matches` 字段里。
 * 可是页面命令走到模型的那条路（`executePageTool`）**只取 `res.result` 这一个字符串**
 * （见 docs/tool-design.md §6：「result：给模型的描述」），
 * 于是 `matches` 被**整份丢掉**，模型只看到"命中 3 个元素"却不知道是哪三个 ——
 * 而该工具被推荐的使用场景恰恰是"排查广告位藏在哪、该隐藏哪一层"，
 * 那必须知道 selector 与祖先链。等于把它的主要用途废掉了。
 *
 * 现在把它并进 `result`，与 `formatInspectSummary` 拼在一起返回。
 *
 * @param {Array} matches [{selector, tag, visible, size:{w,h}, textLength, shadowDepth, path, containsMainContent}]
 */
export function formatInspectMatches(matches: any) {
  const list = Array.isArray(matches) ? matches.filter(Boolean) : [];
  if (!list.length) return '';
  return list
    .map((m) => {
      const bits = [m.selector || m.tag || '?'];
      bits.push(m.visible === false ? '不可见' : '可见');
      if (m.size && (m.size.w || m.size.h)) bits.push(m.size.w + '×' + m.size.h);
      if (typeof m.textLength === 'number') bits.push('文本 ' + m.textLength + ' 字');
      if (m.shadowDepth) bits.push('shadow 深度 ' + m.shadowDepth);
      if (m.containsMainContent) bits.push('疑似含正文');
      let s = '  - ' + bits.join('｜');
      if (m.path) s += '\n    祖先链：' + m.path;
      return s;
    })
    .join('\n');
}

/**
 * inspect_element 的结果摘要（纯函数）。
 *
 * 关键不变式：**命中总数必须在截断之前取**。原实现先 `slice(0, 8)` 再把
 * `matches.length` 当作命中数报出去，于是任何命中 ≥8 个元素的选择器都恒返回
 * 「命中 8 个元素」—— 调用方无法区分「正好 8 个」与「至少 8 个」。
 * 一个永远返回期望值的输出比返回错误值更危险：它会把截断上限当成答案。
 *
 * 同理，被截断时可见性结论必须限定在「列出的部分」内。
 * @param {{total:number, listed:number, visibleCount:number, truncated:boolean, touchesMain?:boolean, main?:{selector:string,textLength:number}}} input
 */
export function formatInspectSummary(input: any) {
  const o = input || {};
  const total = Math.max(0, Math.floor(Number(o.total) || 0));
  const listed = Math.max(0, Math.floor(Number(o.listed) || 0));
  const visible = Math.max(0, Math.floor(Number(o.visibleCount) || 0));
  const hidden = Math.max(0, listed - visible);
  const hiddenText = hidden ? '，不可见 ' + hidden + ' 个' : '';
  let s = '命中 ' + total + ' 个元素。';
  if (o.truncated) {
    s += '（命中过多，仅列出前 ' + listed + ' 个）列出部分中可见 ' + visible + ' 个' + hiddenText + '。';
  } else {
    s += '可见 ' + visible + ' 个' + hiddenText + '。';
  }
  // 正文容器提醒只在命中项确实触到它时给出：原先无条件附加，
  // 于是「查高亮浮层」这类无关查询也会收到它，实测 5 次调用重复 5 遍。
  const main = o.main;
  if (o.touchesMain && main && main.selector) {
    s += ' 命中项包含疑似正文容器 ' + main.selector + '（约 ' + main.textLength + ' 字）—— 隐藏广告时不要连带隐藏它或其祖先。';
  }
  return s;
}

/**
 * read_current_page 的结果文本（纯函数）。
 *
 * 核查模式（传了 checkTexts）：只回核查结论，**不回正文**。
 * 原先无论传不传 checkTexts 都拼上整页正文 —— 实测一次 9.8k 字符里真正有用的
 * 只有那 8 行结论，而它会一直留在上下文里，让之后每一轮请求都跟着变长。
 */
export function formatCurrentPageResult(input: any) {
  const o = input || {};
  const len = Math.max(0, Math.floor(Number(o.textLength) || 0));
  const headLines = ['页面标题：' + String(o.title || ''), '页面URL：' + String(o.url || '')];
  // 报出正文规模：划重点类技能要按字数分档决定划几条，需要一个可靠的字数锚点
  // （让模型自己估「这段大约多长」在长页面上并不可靠）。
  if (len) headLines.push('正文约 ' + len + ' 字');
  const head = headLines.join('\n') + '\n\n';
  const vis = String(o.visReport || '');
  const texts = (Array.isArray(o.checkTexts) ? o.checkTexts : []).filter((t: unknown) => String(t == null ? '' : t).trim());
  if (texts.length && vis) {
    return (
      head +
      '这是「文案可见性核查」的结果，**不含页面正文**。如需正文，请再次调用 read_current_page 且不要传 checkTexts。\n\n' +
      vis
    );
  }
  const chunks = Array.isArray(o.chunks) ? o.chunks : [];
  const text = String(o.text || '');
  let out = head + '当前页面正文：\n' + (chunks.length > 1 ? chunks.join('\n\n') : text);
  if (vis) out += '\n\n' + vis;
  if (o.visibleOnly === true) {
    out += '\n\n（本次仅返回按可见性过滤后的文本；如需包含隐藏节点文字，去掉 visibleOnly。）';
  }
  return out;
}

/**
 * DOM 快照的整体字符预算（text + elements 合计）。
 *
 * maxText 只约束 text 字段，elements 是另算的：每个元素含 tag/role/label/selector/
 * 坐标等十余个字段，最坏约 480 字符。没有总量上限时，maxText:8000 + maxElements:40
 * 会产出约 27k 字符的结果 —— 调用方无法预估体积，只能靠 expand_result 逐段翻页
 * （实测翻了 4 次）。取 12000：约为最坏情况的四成，远大于常规页面的实际体积。
 */
export const SNAPSHOT_CHAR_BUDGET = 12000;

// 快照固定字段（url / title / counts / scroll / mainContent / fingerprint）的预留量。
const SNAPSHOT_FIXED_ALLOWANCE = 600;

/**
 * 按字符预算裁剪要发给模型的元素列表（纯函数）。
 *
 * 放在共享层而不是 lib/page/page-text.js：快照在内容脚本里构建，但
 * includeFrames 那条路径是在后台侧把各子框架的元素**合并**起来的，同样需要裁剪，
 * 而背景侧有意不引用 lib/page/*。
 *
 * 保留前缀而不是均匀抽样：`described` 已按「视口优先」排好序，尾部是离视口最远
 * 的元素，需要时滚动后重新快照即可（ref 会随新快照重发）。
 * 至少保留一个元素 —— 否则单个超大元素会把结果清空。
 */
export function trimElementsToBudget(described: any, textLength: number, budget = SNAPSHOT_CHAR_BUDGET) {
  const list = Array.isArray(described) ? described : [];
  const limit = Math.max(0, Number(budget) || 0);
  const elements = [];
  let used = Math.max(0, Number(textLength) || 0) + SNAPSHOT_FIXED_ALLOWANCE;
  for (const d of list) {
    let size = 0;
    try {
      size = JSON.stringify(d).length + 1;
    } catch (e) {
      size = 0; // 循环引用等异常数据：不计入，也不因此中断裁剪
    }
    if (elements.length && used + size > limit) break;
    elements.push(d);
    used += size;
  }
  return { elements, omittedBySize: list.length - elements.length };
}

/**
 * annotate({op:"highlight"}) 批量模式的结果文案（纯函数，便于单测）。
 *
 * 关键不变式：超出单次上限的部分必须**被说出来**。
 * 原实现先 slice(0, 20) 再报 texts.length，于是传 25 条会返回
 * 「已高亮 20 / 20 处关键信息」—— 调用方以为 25 条全做了。
 * 一个上限被当成答案，和返回错误值同样危险：它让「少做了 5 条」看起来像「全部完成」。
 *
 * @param {{hit:number, attempted:number, requested:number, misses?:string[], limit:number}} input
 */
export function formatHighlightResult(input: any) {
  const o = input || {};
  const num = (v: unknown): number => Math.max(0, Math.floor(Number(v) || 0));
  const hit = num(o.hit);
  const attempted = num(o.attempted);
  const requested = Math.max(attempted, num(o.requested));
  const limit = num(o.limit);
  const misses = Array.isArray(o.misses) ? o.misses : [];
  const dropped = requested - attempted;
  let s = '已高亮 ' + hit + ' / ' + attempted + ' 处关键信息';
  if (misses.length) {
    s +=
      '；未找到 ' + misses.length + ' 条：' +
      misses
        .map((m: unknown) => {
          const t = String(m == null ? '' : m);
          return sliceSafe(t, 0, 16) + (t.length > 16 ? '…' : '');
        })
        .join('、');
  }
  if (dropped > 0) {
    s +=
      '；本次共收到 ' + requested + ' 条，超出单次上限 ' + limit + ' 条的 ' + dropped +
      ' 条**未处理**，请再调用一次 annotate({op:"highlight", texts:[…]}) 传剩余片段';
  }
  return s;
}

/**
 * 拼装进度条文案（纯函数）。
 *
 * 必须**从零拼装**：曾经写成 `'第 N 步 · ' + (状态标签 || 上一帧文案)`，
 * 状态标签取空时就会把上一帧整串拼进来，累积成
 * 「第 4/32 步 · 第 3/32 步 · 第 3/32 步 · …」。
 * @param {number} step 当前步（0 表示尚未开始）
 * @param {number} max 总步数（0 表示未知）
 * @param {string} label 状态标签（如「查看结果」），可为空
 */
export function composeProgressText(step: unknown, max: unknown, label?: unknown) {
  const parts = [];
  const n = Number(step);
  const m = Number(max);
  if (Number.isFinite(n) && n > 0) {
    parts.push('第 ' + Math.floor(n) + (Number.isFinite(m) && m > 0 ? ' / ' + Math.floor(m) : '') + ' 步');
  }
  const text = String(label === undefined || label === null ? '' : label).trim();
  if (text) parts.push(text);
  return parts.length ? parts.join(' · ') : '正在思考…';
}

/**
 * 把关键词可见性核查结果格式化成可读报告（纯函数，便于单测）。
 *
 * 必须同时给出「可见次数」与「DOM 次数」：只回答「文本还在不在」是无法判断可见性的，
 * 而隐藏节点的文字仍留在 DOM 里 —— 这正是此前校验器反复误判的原因。
 * @param {Array<{text:string, visible:number, dom:number, context?:string}>} results
 */
export function formatVisibilityReport(results: any) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return '';
  const lines = list.map((r) => {
    const kw = String((r && r.text) || '');
    const visible = Math.max(0, Number(r && r.visible) || 0);
    const dom = Math.max(0, Number(r && r.dom) || 0);
    let verdict;
    if (visible > 0) verdict = '仍有 ' + visible + ' 处可见 —— 未清理干净';
    else if (dom > 0) verdict = 'DOM 中仍有 ' + dom + ' 处，但均不可见（已隐藏或移除）';
    else verdict = 'DOM 中已无此文本';
    const ctx =
      visible > 0 && r && r.context ? '；首个可见处：…' + sliceSafe(String(r.context).replace(/\s+/g, ' '), 0, 60) + '…' : '';
    return '- 「' + kw + '」：可见 ' + visible + ' 次 / DOM ' + dom + ' 次 —— ' + verdict + ctx;
  });
  return (
    '【可见性核查】判断「文案是否还看得见」只能看**可见次数**；DOM 次数包含已隐藏节点的文字。\n' +
    lines.join('\n')
  );
}

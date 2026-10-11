// 通用工具与展示助手（HTML 渲染、文本处理、toast）
import { ITEM_TYPES, PLATFORMS, STAR_LEVELS } from './constants.js';

/**
 * 防抖函数
 * @param {Function} fn - 要执行的函数
 * @param {number} delay - 延迟毫秒数
 * @returns {Function} 防抖后的函数
 */
export function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * 安全日志记录（避免空 catch 块）
 * @param {string} context - 上下文描述
 * @param {Error|*} error - 错误对象
 */
export function logError(context, error) {
  console.warn(`[BookmarkSorter] ${context}:`, error);
}

export function typeInfo(id) {
  return ITEM_TYPES.find((t) => t.id === id) || ITEM_TYPES[0];
}

export function typeColor(id) {
  return typeInfo(id).color;
}

export function starColor(n) {
  return (STAR_LEVELS[Number(n)] || STAR_LEVELS[2]).color;
}

export function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href;
  } catch (e) {
    return u;
  }
}

export function detectPlatform(u) {
  for (const p of PLATFORMS) {
    if (p.match.test(u)) return { id: p.id, name: p.name };
  }
  return { id: 'other', name: '其他平台' };
}

export function detectType(url) {
  if (url && detectPlatform(url).id !== 'other') return 'wrong';
  return 'article';
}

export function isWebUrl(u) {
  return /^https?:/i.test(u);
}

export function cleanTitle(title) {
  let t = (title || '').trim();
  t = t
    .replace(
      /[|\-–—]\s*(力扣（LeetCode）|力扣|LeetCode|牛客网|牛客|nowcoder|洛谷|Luogu|AcWing|Codeforces|AtCoder).*$/i,
      ''
    )
    .trim();
  return t;
}

export function parseTags(str) {
  return String(str || '')
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function sortItems(list, sortBy) {
  const arr = list.slice();
  switch (sortBy) {
    case 'created':
      arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      break;
    case 'star-desc':
      arr.sort(
        (a, b) =>
          (b.status || 0) - (a.status || 0) ||
          (b.updatedAt || 0) - (a.updatedAt || 0)
      );
      break;
    case 'star-asc':
      arr.sort(
        (a, b) =>
          (a.status || 0) - (b.status || 0) ||
          (b.updatedAt || 0) - (a.updatedAt || 0)
      );
      break;
    default:
      arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return arr;
}

export function starBarHtml(n, interactive) {
  const level = Math.max(1, Math.min(3, Number(n) || 1));
  const group = interactive ? ' role="radiogroup" aria-label="重要程度"' : '';
  let h = `<span class="star-bar${interactive ? ' interactive' : ''}"${group}>`;
  for (let i = 1; i <= 3; i++) {
    const on = i <= level;
    const cell = interactive
      ? ` role="radio" aria-checked="${on}" aria-label="${i} 星" tabindex="${on ? 0 : -1}" data-star="${i}"`
      : ` data-star="${i}"`;
    h += `<span class="star-cell${on ? ' on' : ''}" style="--star-level:${starColor(i)}"${cell}>★</span>`;
  }
  h += '</span>';
  return h;
}

/**
 * 为可交互星级（radiogroup）绑定键盘交互，满足 WCAG 2.1 键盘可达性。
 * - 方向键 / Home / End 在星星间移动（roving tabindex）
 * - 空格 / 回车 选中当前聚焦的星
 * 视觉与 aria 状态就地更新（不触发整列表重渲染，避免焦点/滚动丢失）。
 * @param {HTMLElement} root - 监听键盘事件的容器（如 #list 或 document）
 * @param {(value:number, cell:HTMLElement)=>void} onSelect - 选中回调，cell 为被聚焦的星星元素
 */
export function bindStarKeyboard(root, onSelect) {
  root.addEventListener('keydown', (e) => {
    const cell = e.target.closest('.star-cell[role="radio"]');
    if (!cell) return;
    const group = cell.parentElement;
    const cells = Array.from(group.querySelectorAll('.star-cell'));
    const max = cells.length - 1;
    let idx = cells.indexOf(cell);
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        idx = Math.min(max, idx + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        idx = Math.max(0, idx - 1);
        break;
      case 'Home':
        idx = 0;
        break;
      case 'End':
        idx = max;
        break;
      case ' ':
      case 'Enter':
        e.preventDefault();
        onSelect(Number(cell.dataset.star), cell);
        return;
      default:
        return;
    }
    e.preventDefault();
    cells.forEach((c, i) => {
      const on = i <= idx;
      c.classList.toggle('on', on);
      c.tabIndex = i === idx ? 0 : -1;
      c.setAttribute('aria-checked', String(on));
    });
    cells[idx].focus();
    onSelect(idx + 1, cells[idx]);
  });
}

export function levelNameHtml(n) {
  const st = STAR_LEVELS[Math.max(1, Math.min(3, Number(n) || 1))];
  return `<span class="level-name" style="color:${st.color}">${st.name}</span>`;
}

export function typeBadgeHtml(type) {
  const t = typeInfo(type);
  return `<span class="type-badge" style="color:${t.color};background:${t.color}1A;border:1px solid ${t.color}40">${t.name}</span>`;
}

export function tagsHtml(tags) {
  if (!Array.isArray(tags) || !tags.length) return '';
  return `<span class="tag-list">${tags
    .map((t) => `<span class="tag-chip">${esc(t)}</span>`)
    .join('')}</span>`;
}

/**
 * 把拾取元素的 locator 渲染成一行**语义定位串**。
 *
 * **唯一来源**：这个字符串原本有三处手写实现（给模型的元数据、待发送条的 chip 文案、
 * 随消息存进会话的那一行），而它们已经漂移过一次 ——
 * 其中一处写成 `'role=' + (l.role || '')`，于是在「只有 name、没有 role」时
 * 会拼出 `role=name="帮助"` 这种畸形串（"复制定位"按钮复制到的就是它）。
 *
 * 顺序：role/name（语义最优）→ testid → CSS 选择器 → 标签。
 *
 * @param {{role?:string,name?:string,testid?:string}} [locator]
 * @param {string} [selector] 回退用的 CSS 选择器
 * @param {string} [tag] 最后的回退
 */
export function formatElementLocator(locator, selector, tag) {
  const l = locator || {};
  if (l.role) return 'role=' + l.role + (l.name ? ' name="' + l.name + '"' : '');
  if (l.name) return 'name="' + l.name + '"';
  if (l.testid) return 'testid=' + l.testid;
  return String(selector || tag || '');
}

/**
 * 把「页面上拾取的元素」压成**可随消息持久化**的紧凑记录。
 *
 * 为什么要压一遍再存：拾取到的原始对象带 text(≤120字) / ancestors / locator / rect 等，
 * 逐条存进会话会明显变大，而这里只需要够**渲染一行**。
 * 真正给模型看的那份完整元数据由 `agent.js` 的 `buildInitialMessages` 单独装配 ——
 * 两者用途不同，**不要合并**（合并的后果是：要么存太多，要么给模型的太少）。
 *
 * @param {Array} picked 原始拾取结果（picker 回传）
 * @returns {Array<{tag:string,label:string,loc:string,locator:string}>}
 */
export function summarizePickedForMessage(picked) {
  if (!Array.isArray(picked)) return [];
  return picked
    .filter((p) => p && typeof p === 'object')
    .slice(0, 8) // 多选再多也只需展示前几条；会话存储是有限的
    .map((p) => {
      const src = p.source || {};
      return {
        tag: String(p.tag || '').slice(0, 40),
        label: String(p.label || '').slice(0, 60),
        loc: src.file ? String(src.file).slice(0, 200) + (src.line ? ':' + src.line : '') : '',
        locator: formatElementLocator(p.locator, p.selector, p.tag).slice(0, 200),
      };
    });
}

/** 一行文本摘要，如 `button「提交」 → src/App.vue:42`。无拾取时返回空串。 */
export function formatPickedSummary(picks) {
  const list = Array.isArray(picks) ? picks.filter(Boolean) : [];
  if (!list.length) return '';
  return list
    .map(
      (p, i) =>
        (list.length > 1 ? i + 1 + '. ' : '') +
        (p.tag || '元素') +
        (p.label ? '「' + p.label + '」' : '') +
        (p.loc ? ' → ' + p.loc : '')
    )
    .join('；');
}

/**
 * 渲染「这条消息带了哪些拾取元素」的 HTML（**已转义**）。
 *
 * 同时供**实时发送**与**历史重放**两条渲染路径使用 —— 两处各写一份就会漂移，
 * 而漂移的症状恰好是"刚发出去看得见、刷新后看不见"。
 * 无拾取时返回空串，调用方据此决定要不要插这一行。
 *
 * ⚠ 元素标签 / label / 选择器都来自**页面**（不可信），必须转义：
 * 否则页面上一个 `label` 里带 `<img onerror=...>` 就能在面板里执行脚本。
 */
export function pickedSummaryHtml(picks) {
  const list = Array.isArray(picks) ? picks.filter(Boolean) : [];
  if (!list.length) return '';
  const title = list.map((p) => p.locator).filter(Boolean).join(' / ');
  return (
    '<span class="user-picks"' + (title ? ' title="' + esc(title) + '"' : '') + '>⟡ ' + esc(formatPickedSummary(list)) + '</span>'
  );
}

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
export function formatSelectOptions(items) {
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
export function formatInvalidControls(items) {
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
export function formatStylesSummary(items, total) {
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
export function formatInspectMatches(matches) {
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

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60 * 60 * 1000) return Math.max(1, Math.round(diff / 60000)) + ' 分钟前';
  if (diff < 24 * 60 * 60 * 1000) return Math.round(diff / 3600000) + ' 小时前';
  if (diff < 7 * 24 * 60 * 60 * 1000) return Math.round(diff / 86400000) + ' 天前';
  return d.toLocaleDateString('zh-CN');
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function platformColor(id) {
  return id === 'other' ? '#95a5a6' : '#4a90d9';
}

let _toastTimer = null;

/**
 * 通用 toast 提示（供 popup / manager 复用）
 * @param {string} msg - 提示文本
 * @param {Object} [opts] - 可选配置
 * @param {Function} [opts.undoFn] - 撤销回调，提供时显示撤销按钮
 * @param {number} [opts.duration=2000] - 显示时长（毫秒）
 */
export function showToast(msg, opts) {
  const o = opts || {};
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    // 标记为「扩展注入」：PAGE_TEXT_EXCLUDE 会排除 [data-rf-injected]，
    // 否则 toast 文案（如「已隐藏 13 个广告模块」）会混进页面正文，
    // 进而污染 Agent 的读取结果与完成前校验的证据。
    el.setAttribute('data-rf-injected', '');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  if (o.undoFn) {
    const btn = document.createElement('button');
    btn.textContent = '撤销';
    btn.addEventListener('click', () => {
      o.undoFn();
      el.classList.remove('show');
    });
    el.textContent = msg + ' ';
    el.appendChild(btn);
  }
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), o.duration || 2000);
}

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
export function isCspEvalBlockError(message) {
  const s = String(message === undefined || message === null ? '' : message);
  if (!s) return false;
  if (/unsafe-eval/i.test(s)) return true;
  if (/refused to evaluate/i.test(s)) return true;
  if (/call to eval\(\) blocked/i.test(s)) return true;
  if (/blocked by (?:the )?csp/i.test(s)) return true;
  if (/content security policy/i.test(s) && /(eval|script-src)/i.test(s)) return true;
  return false;
}

/**
 * 「内容脚本连不上」这一类失败的识别。
 *
 * 判定规则与用户脚本运行时的注入兜底是**同一套**（见 lib/userscript/manager.js 里
 * 「Receiving end does not exist → 先注入 runner.js 再重试」那一段）。这里收成一处，
 * 免得出现第三、第四份拷贝 —— 而拷贝之间一旦漂移，就会出现"某条路认得、另一条不认得"。
 */
/**
 * **视觉能力开关**（单一事实来源）。
 *
 * ## 为什么要有它
 *
 * 界面上有好几处文案在说"你看不到图像"（截图工具说明、相关技能等）。
 * 在支持视觉之前，这些话是**对的**；一旦把截图真的传给模型，它们就变成**错的** ✗
 * 分散在多处的硬编码文案，改一处忘一处 —— 于是模型会收到**自相矛盾**的指导
 *（"你看不到图" + 一张图就在上下文里）。
 *
 * 现在能力由这一个常量决定：文案与传输都**必须**问它，不许各自硬编码 ✓
 *
 * ## 当前状态：**关闭**（`false`）
 *
 * 也就是说：今天的行为与引入本常量之前**完全一致** ✓
 * （所以这一轮没有改任何"模型能看到的内容" ⇒ 按第 26 轮的纪律**不需要**跑 eval ✓
 *   方法见 docs/regression-red-flag.md。）
 *
 * ## 打开它需要同时做完（见 docs/remaining-work.md）
 *
 * 1. 把截图作为**追加的 user 消息**送进请求（工具消息只能放文本）—— 已完成（`lib/assistant/vision.js`）；
 * 2. 三处"你看不到图像"的文案条件化 —— 已完成，做法是**整句二选一**：
 *    `tool-schemas.js` 的 `take_screenshot` 说明、`skill-defs.js` 的 readability-fix 技能、
 *    本文件的 `formatScreenshotSummary` ✓
 *    ⇒ 关闭时输出与改动前**逐字节相同**（纯重构 ⇒ 不需要测量 ✓），
 *      打开时换成如实且不矛盾的启用分支 ✓
 *    （门禁：`tests/vision-text-conditional.test.mjs` 把改动前的原文当基准钉住，
 *      并断言启用分支里不再有"看不到图像 / 只展示给用户 / 不进入你的上下文"这类反话。
 *      ⚠ 只有三处：`visionLimitationNote` 的默认整句**不是**受控文案 ——
 *      它只在 `formatScreenshotSummary` 的关闭分支里被调用 ✓）
 * 3. 预算：每图 **实测 578 token**（1280×720 JPEG q40；随尺寸变化，`TOKENS_PER_IMAGE` 取上界 600）
 *    ⇒ 需要"最多几张 / 多大"的显式上限，超出时**如实说明省略了什么**；
 * 4. 门禁：开关关闭时请求里**不得**出现任何 `image_url`（对照组）——
 *    已加（`tests/e2e/vision-switch.spec.mjs` 按本常量的实际值选择断言臂）。
 */
export const VISION_ENABLED = false;

/** "看不到图像"那半句（默认整句说明的**单一来源**；`prefix` 形态由调用方自带措辞）。 */
export const VISION_CLAUSE = '**看不到图像**（截图只给用户看，不会进入你的输入）';

/**
 * 当前视觉能力的**如实说明**（供各处文案使用）。
 *
 * 开关关闭时返回"看不到图像"的说明；开启时返回空串 ——
 * 调用方据此条件化文案，避免"嘴上说看不到、上下文里却有图"的自相矛盾 ✗
 *
 * 传 `prefix` 时，`prefix` 就是调用方**自己那一段**禁用文案，关闭时**原样**返回：
 * 各处的措辞本来就不同（如 `formatScreenshotSummary` 用「你看不到图像内容」）——
 * 若在这里再拼一次默认从句，关闭时的输出就不再与改动前逐字节相同 ✗
 *（"纯重构"的前提被破坏，按纪律就得跑 eval ✗）
 *
 * @param {boolean} [visionEnabled] 覆盖开关（测试用；生产不传）
 * @param {string} [prefix] 调用方自己的那段禁用文案（关闭时原样返回，见 `formatScreenshotSummary`）
 * @returns {string} 需要追加的说明（未启用视觉时非空）
 */
export function visionLimitationNote(visionEnabled, prefix) {
  const enabled = typeof visionEnabled === 'boolean' ? visionEnabled : VISION_ENABLED;
  if (enabled) return '';
  if (typeof prefix === 'string') return prefix;
  return '注意：当前' + VISION_CLAUSE + '，请依据 DOM / 可访问性树等文本信息判断。';
}

/**
 * 截图工具说明里那句「你看不到图像内容」的**原文**（条件化的禁用分支）。
 *
 * 单一来源就在这里 —— `lib/assistant/tool-schemas.js` 直接 import 它，
 * 而不是自己再抄一份字面量（抄一份 = 开关打开后两处文案漂移 ✗）。
 */
export const VISION_UNAVAILABLE_TOOL_COPY =
  '不进入你的上下文 —— 当前模型是纯文本的，**你看不到图像内容**，不要据「已截图」描述页面外观或声称视觉上已修好。';

/**
 * `skill-defs.js` 里 readability-fix 技能那句「你看不到图像内容」的**原文**（条件化的禁用分支）。
 */
export const VISION_UNAVAILABLE_SKILL_COPY =
  '但**你看不到图像内容**，\n  不要据"已截图"声称视觉上已经改好。';

/**
 * 三处文案的**启用分支**（开关打开后替换掉上面三份禁用分支的整句）。
 *
 * ## 为什么整句替换，而不是只替换"你看不到图像"那半句
 *
 * 第 5 步只把一个从句条件化，于是开启侧拼出过两句坏话 ✗（第 7 步审校时实测复现）：
 *   · `formatScreenshotSummary`：`…不进入你的上下文：` + `''` + `，不要据它描述页面外观。`
 *     ⇒ 既拼出 `：，` 这种坏标点，又**与事实相反**（开启后图确实进了上下文）；
 *   · `take_screenshot` 说明：`图片**只展示给用户与留档**` + `同时也会送进你的上下文…`
 *     ⇒ 自相矛盾（"只"与"同时也会"）。
 * 所以现在**每条受开关影响的句子都以整句为单位二选一** ✓ —— 关闭侧仍是逐字节原文。
 *
 * ## 启用分支的措辞要满足三条
 *
 * 1. **如实**：图会随请求送进模型上下文，但**只有被送进去的那几张**（受预算上限约束，
 *    超出的会被省略并在消息里说明）—— 不能写成"所有截图你都看得到"；
 * 2. **有指导**：像素证据**不能替代**文本证据（尺寸/颜色/对比度这类判断仍要读 DOM 计算值）；
 * 3. **不动**与开关无关的那条：`截图不能作为 complete_task 的 evidence` 两档共用 ✓
 */

/** 截图工具说明的**启用分支**（`take_screenshot`）。 */
export const VISION_ENABLED_TOOL_COPY =
  '图片也会随请求送进你的上下文（只送**预算内**的最近几张，超出的会省略并说明）—— 你可以据此观察页面外观。';

/** readability-fix 技能那句的**启用分支**（承接 `- 需要给用户可视证据时用 take_screenshot，`）。 */
export const VISION_ENABLED_SKILL_COPY =
  '图片会随请求送进你的上下文（只送**预算内**的最近几张，超出的会省略并说明），\n  所以你可以据此观察改动的视觉效果；但**外观判断仍要读计算值**（像素证据替代不了 `inspect_element({op:"styles"})` 的读数）。';

/** 截图结果摘要里那句的**启用分支**（`formatScreenshotSummary`）。 */
export const VISION_ENABLED_SUMMARY_COPY =
  '图片会随请求送进你的上下文（只送**预算内**的最近几张，超出的会省略并说明），据此可以观察页面外观。';

export function isContentScriptUnreachable(message) {
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
export function describeContentScriptUnreachable(message, prefix) {
  const raw = String(message === undefined || message === null ? '' : message);
  if (!isContentScriptUnreachable(raw)) return (prefix || '') + raw;
  return (
    (prefix || '') +
    '该标签页当前没有可用的内容脚本（' + raw.slice(0, 120) + '）。' +
    '常见原因：页面还在加载、该页内容脚本未注入或已失效。可以这样做：' +
    '① 稍等片刻后用 wait_for_element / get_page_snapshot 重试一次；' +
    '② 改用**不经内容脚本**的 CDP 工具：get_ax_snapshot、run_javascript({engine:"page"})、take_screenshot；' +
    '③ 若该站始终读不到，直接如实说明"这个页面读不了"，不要反复重试同一条路。'
  );
}

/**
 * 截图的降质阶梯（纯函数）。
 *
 * CDP 的 Page.captureScreenshot 不能指定缩放，因此体积只能靠 format/quality 控制：
 * 先按请求的参数拍，超限就逐级降质重拍。把阶梯做成纯函数，便于验证「不会无限重试」
 * 与「png 请求在超限时也会退到 jpeg」。
 * @param {'jpeg'|'png'} format
 * @param {number} quality 1-100（仅 jpeg 有效）
 * @returns {Array<{format:string, quality?:number}>}
 */
export function screenshotAttempts(format, quality) {
  const q = Math.min(100, Math.max(20, Math.round(Number(quality) || 72)));
  if (format === 'png') {
    // png 无损但可能极大：先 png，超限退 jpeg 并逐级降质。
    return [{ format: 'png' }, { format: 'jpeg', quality: 60 }, { format: 'jpeg', quality: 35 }];
  }
  const ladder = [{ format: 'jpeg', quality: q }];
  const mid = Math.max(30, q - 25);
  // 只在「确实更低」时追加，避免出现 [35, 30, 30] 这种重复档位（白拍一次）。
  if (mid < q) ladder.push({ format: 'jpeg', quality: mid });
  if (ladder[ladder.length - 1].quality > 30) ladder.push({ format: 'jpeg', quality: 30 });
  return ladder;
}

/**
 * 截图结果的元数据文案（纯函数）。
 *
 * 关键：必须**明确告诉模型它看不到图像内容**（未启用视觉时）。
 * 当前管线是纯文本的，若不明说，模型很容易基于「已截图」编造对页面外观的描述。
 * 反过来，一旦 `VISION_ENABLED` 打开，那句话就变成**错的**（图真的进了上下文）✗
 * ⇒ 改成条件化：开关关闭时与**改动前逐字节相同**（纯重构 ⇒ 不需要测量 ✓），
 *   开关打开时换成 `VISION_ENABLED_SUMMARY_COPY` ✓
 *
 * ⚠ **整句**二选一，不是只换"你看不到图像"那半句：
 * 只换半句会拼出「…不进入你的上下文：，不要据它描述页面外观。」——
 * 既是坏标点，又**与事实相反**（开启后图确实进了上下文）✗
 * 门禁：`tests/vision-text-conditional.test.mjs` ⑥⑦ 两臂都钉住 ✓
 * @param {{width:number, height:number, format:string, quality?:number, bytes:number, label?:string, degraded?:boolean}} meta
 * @param {boolean} [visionEnabled] 覆盖开关（测试用；生产不传）
 */
export function formatScreenshotSummary(meta, visionEnabled) {
  const m = meta || {};
  const w = Math.max(0, Math.round(Number(m.width) || 0));
  const h = Math.max(0, Math.round(Number(m.height) || 0));
  const kb = Math.max(0, Math.round((Number(m.bytes) || 0) / 1024));
  const fmt = String(m.format || 'jpeg').toUpperCase();
  const sizeText = w && h ? w + '×' + h + ' CSS px' : '尺寸未知';
  const parts = ['已截图 ' + sizeText + '（' + fmt + (m.quality ? ' q' + m.quality : '') + '，' + kb + 'KB）'];
  if (m.label) parts.push('标注：' + String(m.label).slice(0, 60));
  if (m.degraded) parts.push('（为控制体积已自动降质）');
  const enabled = typeof visionEnabled === 'boolean' ? visionEnabled : VISION_ENABLED;
  return (
    parts.join('·') +
    '\n' +
    (enabled
      ? VISION_ENABLED_SUMMARY_COPY
      : '图片只展示给用户、不进入你的上下文：' +
        visionLimitationNote(visionEnabled, '**你看不到图像内容**') +
        '，不要据它描述页面外观。') +
    '若需要可判断的文本证据，请用 get_page_snapshot / read_diagnostics / inspect_element。' +
    '\n**截图不能作为 complete_task 的 evidence**：完成前校验只读文本证据。' +
    '截图是给用户留档的，不要为了「取证」反复截图。'
  );
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
export function formatInspectSummary(input) {
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
export function formatCurrentPageResult(input) {
  const o = input || {};
  const len = Math.max(0, Math.floor(Number(o.textLength) || 0));
  const headLines = ['页面标题：' + String(o.title || ''), '页面URL：' + String(o.url || '')];
  // 报出正文规模：划重点类技能要按字数分档决定划几条，需要一个可靠的字数锚点
  // （让模型自己估「这段大约多长」在长页面上并不可靠）。
  if (len) headLines.push('正文约 ' + len + ' 字');
  const head = headLines.join('\n') + '\n\n';
  const vis = String(o.visReport || '');
  const texts = (Array.isArray(o.checkTexts) ? o.checkTexts : []).filter((t) => String(t == null ? '' : t).trim());
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
export function trimElementsToBudget(described, textLength, budget = SNAPSHOT_CHAR_BUDGET) {
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
export function formatHighlightResult(input) {
  const o = input || {};
  const num = (v) => Math.max(0, Math.floor(Number(v) || 0));
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
        .map((m) => {
          const t = String(m == null ? '' : m);
          return t.slice(0, 16) + (t.length > 16 ? '…' : '');
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
export function composeProgressText(step, max, label) {
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
export function formatVisibilityReport(results) {
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
      visible > 0 && r && r.context ? '；首个可见处：…' + String(r.context).replace(/\s+/g, ' ').slice(0, 60) + '…' : '';
    return '- 「' + kw + '」：可见 ' + visible + ' 次 / DOM ' + dom + ' 次 —— ' + verdict + ctx;
  });
  return (
    '【可见性核查】判断「文案是否还看得见」只能看**可见次数**；DOM 次数包含已隐藏节点的文字。\n' +
    lines.join('\n')
  );
}

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
 * 判断一条错误信息是否属于「被页面 CSP 阻止 eval」。
 *
 * 背景：run_javascript 的默认沙箱是用 `new Function` 实现的，而 **content script 里的
 * eval 类构造同样受页面 CSP 约束** —— 页面只要没放行 `unsafe-eval` 就会被拒。
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
 * 关键：必须**明确告诉模型它看不到图像内容**。当前管线是纯文本的，
 * 若不明说，模型很容易基于「已截图」编造对页面外观的描述。
 * @param {{width:number, height:number, format:string, quality?:number, bytes:number, label?:string, degraded?:boolean}} meta
 */
export function formatScreenshotSummary(meta) {
  const m = meta || {};
  const w = Math.max(0, Math.round(Number(m.width) || 0));
  const h = Math.max(0, Math.round(Number(m.height) || 0));
  const kb = Math.max(0, Math.round((Number(m.bytes) || 0) / 1024));
  const fmt = String(m.format || 'jpeg').toUpperCase();
  const sizeText = w && h ? w + '×' + h + ' CSS px' : '尺寸未知';
  const parts = ['已截图 ' + sizeText + '（' + fmt + (m.quality ? ' q' + m.quality : '') + '，' + kb + 'KB）'];
  if (m.label) parts.push('标注：' + String(m.label).slice(0, 60));
  if (m.degraded) parts.push('（为控制体积已自动降质）');
  return (
    parts.join('·') +
    '\n图片只展示给用户、不进入你的上下文：**你看不到图像内容**，不要据它描述页面外观。' +
    '若需要可判断的文本证据，请用 get_page_snapshot / read_console / inspect_element。'
  );
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

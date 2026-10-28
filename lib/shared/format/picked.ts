import { sliceSafe } from '../surrogates.ts';
import { esc } from '../dom/html.ts';

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
export function formatElementLocator(locator: any, selector: any, tag: any) {
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
export function summarizePickedForMessage(picked: any) {
  if (!Array.isArray(picked)) return [];
  return picked
    .filter((p) => p && typeof p === 'object')
    .slice(0, 8) // 多选再多也只需展示前几条；会话存储是有限的
    .map((p) => {
      const src = p.source || {};
      return {
        tag: sliceSafe(String(p.tag || ''), 0, 40),
        label: sliceSafe(String(p.label || ''), 0, 60),
        loc: src.file ? sliceSafe(String(src.file), 0, 200) + (src.line ? ':' + src.line : '') : '',
        locator: sliceSafe(formatElementLocator(p.locator, p.selector, p.tag), 0, 200),
      };
    });
}

/** 一行文本摘要，如 `button「提交」 → src/App.vue:42`。无拾取时返回空串。 */
export function formatPickedSummary(picks: any) {
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
export function pickedSummaryHtml(picks: any) {
  const list = Array.isArray(picks) ? picks.filter(Boolean) : [];
  if (!list.length) return '';
  const title = list.map((p) => p.locator).filter(Boolean).join(' / ');
  return (
    '<span class="user-picks"' + (title ? ' title="' + esc(title) + '"' : '') + '>⟡ ' + esc(formatPickedSummary(list)) + '</span>'
  );
}

/**
 * 渲染某条用户消息附带的页面选文。
 *
 * 选文在发送前是临时上下文，发送后必须成为那条消息的一部分；否则面板重绘
 * 或重新打开会话时，用户就看不到“这句话到底基于哪段原文”。
 * 同时供实时发送与历史重放使用，页面文本一律转义。
 */
export function selectedTextMessageHtml(selectedText: unknown) {
  const text = String(selectedText || '').trim();
  if (!text) return '';
  return (
    '<span class="user-selection" title="' + esc(text) + '">' +
      '<span class="user-selection-label">页面引用</span>' +
      '<span class="user-selection-text">' + esc(text) + '</span>' +
    '</span>'
  );
}

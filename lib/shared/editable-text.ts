// 可编辑文本的比较与诊断。
//
// 输入工具不能只看“动作发出去了”，必须比较**期望值**与**回读值**。
// 这里只做编辑器无关的轻量归一：换行统一、NBSP 归一、去掉尾随空行；
// 不折叠正文内部空白，也不猜测编辑器的结构性换行。

/**
 * 读取 contenteditable 的逻辑文本。
 *
 * `innerText` 会按 CSS 排版把每个块级段落边界算成不止一个换行：
 * `<p>A</p><p><br></p><p>B</p>` 在 Chromium 里可能读成 `A\n\n\n\n\nB`，
 * 但用户输入的逻辑文本只有 `A\n\nB`。这里的规则是：
 * · 每个块级子元素开始前记一个逻辑换行；
 * · 仅含 <br> 的空段落仍记作一个空行；
 * · 普通块内 <br> 记作一个换行；
 * · 首尾由编辑器容器结构产生的换行不计入内容。
 *
 * 函数必须保持自包含：CDP 兜底会把它的源码注入页面执行。
 */
export function readContentEditableText(root: Element | null | undefined): string {
  if (!root) return '';
  const BLOCK_TAGS = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DIV|DL|DT|DD|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;
  const tokens: Array<string | null> = [];

  const isBlock = (node: any): boolean => {
    if (!node || node.nodeType !== 1) return false;
    const tag = String(node.tagName || node.nodeName || '').toUpperCase();
    if (BLOCK_TAGS.test(tag)) return true;
    try {
      return /^(block|list-item|table|table-row|flex|grid|flow-root)$/.test(
        String(getComputedStyle(node).display || '')
      );
    } catch (e) {
      return false;
    }
  };

  const onlyBreaks = (node: any): boolean => {
    for (const child of Array.from((node.childNodes || []) as ArrayLike<any>)) {
      if (child.nodeType === 3) {
        if (String(child.nodeValue || '').trim()) return false;
        continue;
      }
      if (child.nodeType === 1 && String(child.tagName || child.nodeName).toUpperCase() === 'BR') continue;
      return false;
    }
    return true;
  };

  const walk = (node: any) => {
    for (const child of Array.from((node.childNodes || []) as ArrayLike<any>)) {
      if (child.nodeType === 3) {
        const text = String(child.nodeValue || '');
        if (text) tokens.push(text);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = String(child.tagName || child.nodeName || '').toUpperCase();
      if (tag === 'BR') {
        tokens.push('\n');
        continue;
      }
      const block = isBlock(child);
      if (block) tokens.push(null);
      // 空段落里的占位 <br> 不是额外一行；块边界本身已经代表这个空行。
      if (block && onlyBreaks(child)) continue;
      walk(child);
    }
  };

  walk(root);
  let text = '';
  let boundaries = 0;
  for (const token of tokens) {
    if (token === null) {
      if (text) boundaries += 1;
      continue;
    }
    if (!token) continue;
    if (boundaries && text && !text.endsWith('\n')) text += '\n'.repeat(boundaries);
    boundaries = 0;
    text += token;
  }
  return text.replace(/\n+$/g, '');
}

export function normalizeEditableText(value: unknown): string {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\n+$/g, '');
}

export function editableTextMatches(expected: unknown, actual: unknown): boolean {
  return normalizeEditableText(expected) === normalizeEditableText(actual);
}

/** 返回第一个差异的位置与两个片段；完全一致时 index=-1。 */
export function firstEditableDifference(expected: unknown, actual: unknown) {
  const a = normalizeEditableText(expected);
  const b = normalizeEditableText(actual);
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return {
    index: i >= a.length && i >= b.length ? -1 : i,
    expected: a.slice(Math.max(0, i - 24), i + 48),
    actual: b.slice(Math.max(0, i - 24), i + 48),
  };
}

export function editableTextSummary(expected: unknown, actual: unknown) {
  const diff = firstEditableDifference(expected, actual);
  return {
    matchesIntent: diff.index === -1,
    expectedLength: normalizeEditableText(expected).length,
    actualLength: normalizeEditableText(actual).length,
    firstDifference: diff,
  };
}

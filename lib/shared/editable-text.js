// 可编辑文本的比较与诊断。
//
// 输入工具不能只看“动作发出去了”，必须比较**期望值**与**回读值**。
// 这里只做编辑器无关的轻量归一：换行统一、NBSP 归一、去掉尾随空行；
// 不折叠正文内部空白，也不猜测编辑器的结构性换行。

export function normalizeEditableText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\n+$/g, '');
}

export function editableTextMatches(expected, actual) {
  return normalizeEditableText(expected) === normalizeEditableText(actual);
}

/** 返回第一个差异的位置与两个片段；完全一致时 index=-1。 */
export function firstEditableDifference(expected, actual) {
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

export function editableTextSummary(expected, actual) {
  const diff = firstEditableDifference(expected, actual);
  return {
    matchesIntent: diff.index === -1,
    expectedLength: normalizeEditableText(expected).length,
    actualLength: normalizeEditableText(actual).length,
    firstDifference: diff,
  };
}

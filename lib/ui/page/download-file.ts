// 从页面里发起文本文件下载。会话导出按钮用这里，避免再走剪贴板。

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * 把会话标题变成各主流桌面系统都能保存的 Markdown 文件名。
 *
 * 只清理文件名，不改标题正文；限制长度时按 Unicode code point 截断，避免切裂 emoji。
 */
export function markdownDownloadFilename(title: unknown): string {
  let name = String(title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  name = Array.from(name).slice(0, 80).join('').replace(/[. ]+$/g, '');
  if (!name) name = 'RecallFlow 会话';
  if (WINDOWS_RESERVED_NAME.test(name)) name = '_' + name;
  return name + '.md';
}

/** 用临时 Blob URL 触发浏览器下载，并在开始下载后回收链接。 */
export function downloadMarkdownFile(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  (document.body || document.documentElement).appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

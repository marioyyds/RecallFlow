let _toastTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 通用 toast 提示（供 popup / manager 复用）
 * @param {string} msg - 提示文本
 * @param {Object} [opts] - 可选配置
 * @param {Function} [opts.undoFn] - 撤销回调，提供时显示撤销按钮
 * @param {number} [opts.duration=2000] - 显示时长（毫秒）
 */
export function showToast(msg: string, opts?: any) {
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
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), o.duration || 2000);
}

/**
 * 导出期 UI 守卫：保存 / 打印页面的那一刻，把宿主整体摘出文档。
 *
 * 背景：RecallFlow 把悬浮球与对话面板挂在 `#__kb-ai-host` 上（宿主在页面文档里，
 * UI 在它的 shadow root 里）。用户一「另存为 / 打印 / 导出 PDF」，就在拿"自己那份文档"，
 * 而本地页（`file://`）尤其明显 —— 那份文档本来就是用户的，多一个点不动的扩展图标很刺眼。
 *
 * ⚠ 一个曾经写在这里、后来被实测推翻的结论：**"shadow 内容不会被另存为序列化"是错的。**
 * 真 Chromium + 真扩展，`Page.captureSnapshot`（「另存为」用的同一套序列化器）产物里
 * 有 `<template shadowrootmode="open">`，里面 `.fab` 与 `chrome-extension://…recallflow-mark.svg`
 * 一应俱全 —— 用户保存出来的离线副本因此会带一个点不动的图标。
 * 所以现在的防线分成两层，**本文件只是第二层**：
 *
 *   第一层（不依赖任何事件，见 panel-css.js + debug-hook.js）：
 *     宿主是自定义元素 `rf-ai-host`，由主世界脚本注册；存档里没有脚本 ⇒ 元素不被升级 ⇒
 *     `:host(:not(:defined))` 命中 ⇒ 整块 UI 在存档里 display:none。
 *     这条对"浏览器菜单另存为 / 右键另存为 / 页面自己写盘"统统成立，因为它不看动作。
 *
 *   第二层（本文件，管"产物里连节点都别留"）：
 *     · Ctrl+S：捕获阶段把宿主移进 DocumentFragment（见下面"为什么必须摘掉"）；
 *     · 打印 / 导出 PDF：`beforeprint` 摘除 + shadow 内 `@media print` 隐藏，两道保险。
 *     这两条拿不到"菜单另存为"，所以才需要第一层。
 *
 * 为什么必须"摘掉"而不是 `display:none`：隐藏只影响渲染，节点仍在文档里，
 * 序列化照样把它写进产物（这正是"隐藏了却还是被保存下来"的由来）。
 *
 * 恢复时机为什么不用固定定时器：原生保存对话框是**异步**的，用户可能挑目录挑十几秒，
 * 而 Chromium 是在对话框关闭**之后**才序列化 —— 定时器太短会把宿主提前挂回去，
 * 于是又漏。所以按"人回到页面"的事件恢复（focus / visibility / 再次交互），
 * 另留一个**很长**的兜底上限，防止对话框被异常关掉后 UI 永久消失。
 */

export const HOST_ID = '__kb-ai-host';
/** 摘除期间打在宿主上的标记，便于在 Elements 里一眼看出"它是被导出守卫收起来的"。 */
export const SUSPEND_ATTR = 'data-rf-export-hidden';

/** 兜底恢复上限：远大于"挑路径"可能花的时间，只为防 UI 永久消失。 */
const SAFETY_RESTORE_MS = 60_000;
/** 交互恢复的宽限期：让本次 Ctrl+S 的 keydown 自己不要立刻把宿主挂回来。 */
const INTERACTION_GRACE_MS = 800;

/**
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {Window} [options.win]
 * @param {() => Element|null} [options.getHost] 取宿主；默认按 id 找
 * @param {(reason: string) => void} [options.onSuspend] 摘除**之前**调用（宿主侧应据此拒绝重建）
 * @param {(reason: string) => void} [options.onResume]  复原**之后**调用
 * @param {() => number} [options.now]
 */
export function createExportGuard(options = {}) {
  const doc = options.doc || document;
  const win = options.win || window;
  const getHost = options.getHost || (() => doc.getElementById(HOST_ID));
  const onSuspend = options.onSuspend || (() => {});
  const onResume = options.onResume || (() => {});
  const now = options.now || (() => Date.now());

  let suspended = false;
  let parked = null; // { node, parent, next }
  let safetyTimer = null;
  let graceUntil = 0;
  let lastReason = '';
  let installed = false;

  function clearSafetyTimer() {
    if (safetyTimer) {
      const cancel = win.clearTimeout || clearTimeout;
      cancel(safetyTimer);
      safetyTimer = null;
    }
  }

  function armSafetyTimer() {
    clearSafetyTimer();
    const schedule = win.setTimeout || setTimeout;
    safetyTimer = schedule(() => {
      safetyTimer = null;
      restore('safety');
    }, SAFETY_RESTORE_MS);
  }

  /**
   * 摘除宿主。
   * 返回"是否真的摘掉了节点"——**没有宿主时也返回 false 但会进入挂起态**：
   * 保存期间如果恰好有流式增量/看门狗要建宿主，挂起态能拦住它，
   * 否则会出现"用户按了 Ctrl+S，宿主恰好在序列化那一刻被建出来"的竞态。
   */
  function suspend(reason) {
    if (suspended) return false;
    suspended = true;
    lastReason = String(reason || 'export');
    // 先置标志、再动 DOM：宿主侧的重建路径必须在这之后就已经被拦住。
    onSuspend(lastReason);

    const host = getHost();
    let detached = false;
    if (host && host.parentNode) {
      const parent = host.parentNode;
      const next = host.nextSibling;
      host.setAttribute(SUSPEND_ATTR, '1');
      // 移动到 DocumentFragment = 从文档树摘除；节点、shadow root、事件监听、面板状态全部保留。
      // 必须真的持有这个 fragment：宿主只是被"移进"它，节点引用仍由 parked 保住。
      const holder = doc.createDocumentFragment();
      holder.appendChild(host);
      parked = { node: host, holder, parent, next };
      detached = true;
    }
    graceUntil = now() + INTERACTION_GRACE_MS;
    armSafetyTimer();
    return detached;
  }

  function restore(reason) {
    if (!suspended) return false;
    clearSafetyTimer();
    const p = parked;
    parked = null;
    if (p && p.node) {
      try {
        p.node.removeAttribute(SUSPEND_ATTR);
        // 宿主原来的父节点可能已被 SPA 导航换掉 —— 那就退到 documentElement 上，UI 至少回来。
        const parent =
          p.parent && p.parent.isConnected ? p.parent : doc.documentElement || doc.body;
        if (parent) {
          if (p.next && p.next.parentNode === parent) parent.insertBefore(p.node, p.next);
          else parent.appendChild(p.node);
        }
      } catch (e) {}
    }
    suspended = false;
    lastReason = '';
    onResume(String(reason || 'export'));
    return true;
  }

  function isSuspended() {
    return suspended;
  }

  // ---- 触发点 ----

  // Ctrl/Cmd+S：捕获阶段拦一手（**不** preventDefault —— 保存是用户要的，我们只让路）。
  function onKeyDown(e) {
    if (!e || e.altKey) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = String(e.key || '').toLowerCase();
    if (key !== 's') return;
    suspend('save-shortcut');
  }

  // Ctrl+P 由打印事件兜住（beforeprint 一定先于渲染），这里不重复处理。
  function onBeforePrint() {
    suspend('print');
  }

  function onAfterPrint() {
    restore('print');
  }

  function onVisibilityChange() {
    // 有些环境（老 WebView / 测试桩）没有 visibilityState，缺失时按"可见"处理即可：
    // 这条只是加速恢复，真正的兜底是 focus 与交互事件。
    if (doc.visibilityState === 'hidden') return;
    restore('visibility');
  }

  // 人回到页面 = 对话框已经结束（Chromium 在对话框关闭后才序列化，所以这时恢复是安全的）。
  function onFocus() {
    restore('focus');
  }

  // 兜底：任何真实交互都说明用户已经在页面上，保存动作早已结束。
  function onInteract() {
    if (!suspended) return;
    if (now() < graceUntil) return;
    restore('interaction');
  }

  function install() {
    if (installed) return () => {};
    installed = true;
    doc.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('beforeprint', onBeforePrint);
    win.addEventListener('afterprint', onAfterPrint);
    win.addEventListener('focus', onFocus);
    doc.addEventListener('visibilitychange', onVisibilityChange);
    // pointerdown/mousemove 只在**页面真的收到**时触发；对话框打开期间收不到，不会误恢复。
    doc.addEventListener('pointerdown', onInteract, true);
    doc.addEventListener('keydown', onInteract, true);
    return uninstall;
  }

  function uninstall() {
    if (!installed) return;
    installed = false;
    try {
      doc.removeEventListener('keydown', onKeyDown, true);
      win.removeEventListener('beforeprint', onBeforePrint);
      win.removeEventListener('afterprint', onAfterPrint);
      win.removeEventListener('focus', onFocus);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      doc.removeEventListener('pointerdown', onInteract, true);
      doc.removeEventListener('keydown', onInteract, true);
    } catch (e) {}
    restore('uninstall');
  }

  return { suspend, restore, isSuspended, install, uninstall };
}

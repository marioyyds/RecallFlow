/**
 * 保存 / 打印页面时的 UI 可见性守卫
 *
 * 背景：RecallFlow 通过内容脚本把悬浮按钮（FAB）与对话面板挂到 #__kb-ai-host，
 * 宿主节点带 open shadow root 并常驻页面。浏览器「另存为 / 保存页面」抓取的是
 * 已渲染 DOM 的序列化结果，于是扩展的图标也会被写进保存下来的离线 HTML ——
 * 用户打开离线副本时，会看到一个点不动的 RecallFlow 图标。
 *
 * 做法：在打印 / 保存这类「导出」场景下临时隐藏宿主节点，导出结束立刻还原。
 * 只改宿主节点自身的内联样式：不删除节点、不卸载面板、不碰会话与 Agent 状态。
 *
 * 三条生效路径：
 *   1. beforeprint / afterprint —— 覆盖 Ctrl+P 与浏览器菜单里的「打印」；
 *   2. @media print 样式 —— 覆盖只切换打印媒体查询的渲染链路；
 *   3. visibilitychange —— 「另存为」弹出的保存对话框会让页面失焦，回到可见时兜底还原。
 */

export const HOST_ID = '__kb-ai-host';
export const HIDDEN_ATTR = 'data-rf-save-hidden';
export const PRINT_STYLE_ID = 'rf-save-visibility-guard';

let hiddenByGuard = false;

function hostNode() {
  return document.getElementById(HOST_ID);
}

// 隐藏宿主：visibility 与 display 都给上，任一被页面样式覆盖时仍有兜底。
export function hideForSave() {
  const host = hostNode();
  if (!host) return false;
  host.setAttribute(HIDDEN_ATTR, '1');
  host.style.setProperty('visibility', 'hidden', 'important');
  host.style.setProperty('display', 'none', 'important');
  hiddenByGuard = true;
  return true;
}

// 还原宿主：只移除本守卫加上的属性与样式，保留面板自身的可见性控制。
export function restoreAfterSave() {
  if (!hiddenByGuard) return false;
  const host = hostNode();
  if (host) {
    host.removeAttribute(HIDDEN_ATTR);
    host.style.removeProperty('visibility');
    host.style.removeProperty('display');
  }
  hiddenByGuard = false;
  return true;
}

export function isHiddenByGuard() {
  return hiddenByGuard;
}

// 打印媒体查询下直接隐藏宿主，不依赖 JS 事件是否触发。
export function ensurePrintStyle() {
  if (document.getElementById(PRINT_STYLE_ID)) return false;
  const style = document.createElement('style');
  style.id = PRINT_STYLE_ID;
  style.textContent = '@media print { #' + HOST_ID + ' { display: none !important; visibility: hidden !important; } }';
  (document.head || document.documentElement).appendChild(style);
  return true;
}

/**
 * 安装守卫。内容脚本注入后调用一次即可，重复调用无副作用。
 * @returns {() => void} 卸载函数（测试与页面卸载时使用）
 */
export function installSaveVisibilityGuard() {
  ensurePrintStyle();

  const onBeforePrint = () => { hideForSave(); };
  const onAfterPrint = () => { restoreAfterSave(); };
  window.addEventListener('beforeprint', onBeforePrint);
  window.addEventListener('afterprint', onAfterPrint);

  let mql = null;
  const onPrintMediaChange = (e) => { if (e.matches) hideForSave(); else restoreAfterSave(); };
  if (typeof window.matchMedia === 'function') {
    mql = window.matchMedia('print');
    if (mql && typeof mql.addEventListener === 'function') mql.addEventListener('change', onPrintMediaChange);
    else if (mql && typeof mql.addListener === 'function') mql.addListener(onPrintMediaChange);
  }

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') window.setTimeout(restoreAfterSave, 0);
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  return function uninstall() {
    window.removeEventListener('beforeprint', onBeforePrint);
    window.removeEventListener('afterprint', onAfterPrint);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (mql) {
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onPrintMediaChange);
      else if (typeof mql.removeListener === 'function') mql.removeListener(onPrintMediaChange);
    }
    restoreAfterSave();
  };
}

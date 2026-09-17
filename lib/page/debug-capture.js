// 隔离世界：向主世界的 debug-hook 请求运行时缓冲（console / network）。
// 主世界（MAIN）与内容脚本（ISOLATED）是独立 JS 上下文，通过 window.postMessage 桥接。
let reqSeq = 0;
const waiters = new Map();

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    const d = e && e.data;
    if (d && d.__rfDebugRes && waiters.has(d.id)) {
      const resolve = waiters.get(d.id);
      waiters.delete(d.id);
      resolve(Array.isArray(d.data) ? d.data : []);
    }
  });
}

export function getDebugBuffer(kind) {
  return new Promise((resolve) => {
    const id = ++reqSeq;
    waiters.set(id, resolve);
    try {
      window.postMessage({ __rfDebugReq: id, kind }, '*');
    } catch (e) {
      waiters.delete(id);
      resolve([]);
      return;
    }
    setTimeout(() => {
      if (waiters.has(id)) {
        waiters.delete(id);
        resolve([]);
      }
    }, 1500);
  });
}

// 隔离世界：向主世界的 debug-hook 请求运行时数据（console/network 缓冲、元素源码位置）。
// 主世界（MAIN）与内容脚本（ISOLATED）是独立 JS 上下文，通过 window.postMessage 桥接。
let reqSeq = 0;
const waiters = new Map();

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    const d = e && e.data;
    if (d && d.__rfDebugRes && waiters.has(d.id)) {
      const resolve = waiters.get(d.id);
      waiters.delete(d.id);
      resolve(d.data);
    }
  });
}

function request(payload, fallback) {
  return new Promise((resolve) => {
    const id = ++reqSeq;
    waiters.set(id, resolve);
    try {
      window.postMessage(Object.assign({ __rfDebugReq: id }, payload), '*');
    } catch (e) {
      waiters.delete(id);
      resolve(fallback);
      return;
    }
    setTimeout(() => {
      if (waiters.has(id)) {
        waiters.delete(id);
        resolve(fallback);
      }
    }, 1500);
  });
}

// 读取 console / network 环形缓冲（数组）。
export function getDebugBuffer(kind) {
  return request({ kind }, []).then((d) => (Array.isArray(d) ? d : []));
}

// 把一个 CSS 选择器解析为框架源码位置（对象或 null）。
export function getElementSource(selector) {
  return request({ kind: 'element-source', selector }, null);
}

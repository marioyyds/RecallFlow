// 隔离世界：向主世界的 debug-hook 请求运行时数据（console/network 缓冲、元素源码位置、执行 JS）。
// 主世界（MAIN）与内容脚本（ISOLATED）是独立 JS 上下文，通过 window.postMessage 发起请求，
// 并用 MessageChannel 把响应定向回本次请求（避免向页面广播敏感数据）。
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

// 通过 MessageChannel 请求主世界：响应只回给本次请求的端口，不再用 window.postMessage('*')
// 广播，避免页面脚本监听 __rfDebugRes 读取捕获的 console/network 数据。MessageChannel
// 不可用时退回旧广播方式。
function request(payload, fallback, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const id = ++reqSeq;
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    waiters.set(id, done);
    try {
      if (typeof MessageChannel !== 'undefined') {
        const channel = new MessageChannel();
        channel.port1.onmessage = (ev) => {
          const d = ev && ev.data;
          if (d && d.__rfDebugRes && d.id === id) {
            waiters.delete(id);
            done(d.data);
          }
        };
        window.postMessage(Object.assign({ __rfDebugReq: id }, payload), '*', [channel.port2]);
      } else {
        window.postMessage(Object.assign({ __rfDebugReq: id }, payload), '*');
      }
    } catch (e) {
      waiters.delete(id);
      done(fallback);
      return;
    }
    setTimeout(() => {
      if (waiters.has(id)) {
        waiters.delete(id);
        done(fallback);
      }
    }, timeoutMs);
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

const SANDBOX_ALLOWED = [
  'window', 'document', 'location', 'navigator', 'JSON', 'Math', 'Date', 'Number', 'String',
  'Boolean', 'Array', 'Object', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'console', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'parseInt',
  'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
  'decodeURI', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'atob', 'btoa',
  'structuredClone', 'getComputedStyle', 'performance', 'Node', 'NodeFilter', 'Element',
  'HTMLElement', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'MutationObserver',
  'IntersectionObserver', 'ResizeObserver', 'DOMParser', 'undefined', 'NaN', 'Infinity',
];

const SANDBOX_BLOCKED = [
  'chrome', 'browser', 'globalThis', 'self', 'top', 'parent', 'frames', 'fetch',
  'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'BroadcastChannel',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'importScripts', 'eval', 'Function',
];

function buildSandboxArgs() {
  const blocked = new Set(SANDBOX_BLOCKED);
  const realWindow = globalThis;
  const safeWindow = new Proxy(realWindow, {
    get(target, prop) {
      if (typeof prop === 'string' && blocked.has(prop)) return undefined;
      const value = (target as any)[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(target, prop) {
      return !(typeof prop === 'string' && blocked.has(prop));
    },
  });
  const names: string[] = [];
  const values: any[] = [];
  for (const name of SANDBOX_ALLOWED) {
    names.push(name);
    values.push(name === 'window' ? safeWindow : (globalThis as any)[name]);
  }
  for (const name of SANDBOX_BLOCKED) {
    names.push(name);
    values.push(undefined);
  }
  return { names, values, safeWindow };
}

export async function runJs(params: any) {
  const input = params || {};
  const code = String(input.code || '').trim();
  if (!code) return { ok: false, error: 'run_javascript 需要 code 参数' };
  if (code.length > 20000) return { ok: false, error: '代码过长（上限 20000 字符），请精简逻辑' };
  let value;
  try {
    const { names, values, safeWindow } = buildSandboxArgs();
    const fn = new Function(...names, 'return (async () => {\n' + code + '\n})();');
    value = fn.call(safeWindow, ...values);
  } catch (error: any) {
    return { ok: false, error: 'JS 执行出错：' + (error?.message ? error.message : String(error)) };
  }
  if (value && typeof value.then === 'function') {
    try {
      value = await value;
    } catch (error: any) {
      return { ok: false, error: '异步 JS 执行出错：' + (error?.message ? error.message : String(error)) };
    }
  }
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (error) {
    serialized = String(value);
  }
  if (serialized === undefined) serialized = 'undefined';
  if (serialized.length > 2000) serialized = serialized.slice(0, 2000) + '\n…（结果过长已截断）';
  return { ok: true, result: serialized };
}

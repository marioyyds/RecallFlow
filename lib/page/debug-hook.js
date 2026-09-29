// 页面运行时捕获（MAIN world，document_start）：hook console / 未捕获异常 / fetch / XHR，
// 环形缓冲最近记录，并可把 DOM 元素解析到框架源码位置（React/Vue/Svelte）。
// 供隔离世界的内容脚本按需读取（前端调试 / 页面↔代码 指针）。
// 注意：本文件运行在页面主世界，必须是普通脚本（不能用 import/export）。
//
// 两条运维约束（都在 manifest 里体现，改动时请一并考虑）：
// 1. 注入范围是 http/https 全站、document_start —— 因为 page_health 需要抓到加载期错误，
//    晚注入就漏了。代价是它跑在每一个页面上，任何副作用都会被页面观测到：
//    因此这里坚持「只读或等价替换」——不改请求参数、不改返回值、不往页面对象挂属性。
// 2. 补丁是可被检测的：window.fetch.toString() 不再返回 [native code]，
//    少数站点/广告脚本会据此判断环境。这是本特性的固有代价（要在加载期抓错就必须先装钩子），
//    不是可以通过伪造 toString 优雅解决的问题 —— 伪造本身更脆弱且有欺骗性。
//    若某站点因此行为异常，应走「按站点停用」而不是加强伪装。
(function () {
  if (window.__rfDebugHooked) return;
  window.__rfDebugHooked = true;

  var MAX = 150;
  var consoleBuf = [];
  var netBuf = [];

  function push(buf, entry) {
    buf.push(entry);
    if (buf.length > MAX) buf.shift();
  }

  function textOf(v) {
    return String(v == null ? '' : v).slice(0, 2000);
  }

  function stackOf() {
    try {
      var s = new Error().stack || '';
      // 去掉首行 "Error"，以及本文件自身的帧（stackOf / rfFetchHook 等）。
      // 后者很关键：只保留 12 行，若前两行都是我们自己的帧，等于把页面真正有用的
      // 调用位置挤出窗口 —— 而 initiator 的价值恰恰是「页面哪一行发起了这个请求」。
      var lines = s.split('\n');
      if (lines[0] && lines[0].indexOf('Error') === 0) lines.shift();
      while (lines.length && lines[0].indexOf('lib/page/debug-hook.js') >= 0) lines.shift();
      return lines.slice(0, 12).join('\n').slice(0, 1800);
    } catch (e) {
      return '';
    }
  }

  function stringify(args) {
    try {
      var parts = [];
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (typeof a === 'string') parts.push(a);
        else {
          try {
            parts.push(JSON.stringify(a));
          } catch (e) {
            parts.push(String(a));
          }
        }
      }
      return parts.join(' ');
    } catch (e) {
      return '';
    }
  }

  // console.*（error/warn 附带调用栈）
  ['error', 'warn', 'log', 'info'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      try {
        var entry = { level: level, text: textOf(stringify(arguments)), at: Date.now() };
        if (level === 'error' || level === 'warn') entry.stack = stackOf();
        push(consoleBuf, entry);
      } catch (e) {}
      return orig && orig.apply(console, arguments);
    };
  });

  // 未捕获异常 / Promise 拒绝
  window.addEventListener('error', function (e) {
    try {
      var msg = e && e.message ? e.message : 'unknown error';
      if (e && e.filename) msg += ' @ ' + e.filename + ':' + (e.lineno || 0) + ':' + (e.colno || 0);
      var st = (e && e.error && e.error.stack) ? e.error.stack : '';
      push(consoleBuf, { level: 'error', text: textOf(msg), stack: textOf(st), at: Date.now() });
    } catch (e2) {}
  });
  window.addEventListener('unhandledrejection', function (e) {
    try {
      var r = e && e.reason;
      var st = (r && r.stack) ? r.stack : '';
      push(consoleBuf, { level: 'error', text: textOf('Unhandled rejection: ' + (r && r.message ? r.message : r)), stack: textOf(st), at: Date.now() });
    } catch (e2) {}
  });

  // fetch（附带发起位置 initiator）
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;
    // 具名函数表达式：页面自身的报错栈里会显示 rfFetchHook，而不是 "window.fetch"。
    // 这不是洁癖 —— 未具名时，页面上任何一次网络失败的最内层帧都长得像「扩展的 fetch」，
    // 会让人与页面的错误上报系统都误判成扩展 bug（实际案例：MSN 文章的 "Failed to fetch"
    // 栈顶就是本文件，排查时不得不先证明它跟我们无关）。
    var rfFetchHook = function rfFetchHook(input, init) {
      var start = Date.now();
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var initiator = stackOf();
      // 显式以 window 作为 this：fetch 要求 this 是全局对象。
      // 依赖「本 IIFE 非严格模式、this 会被强制成全局」过于脆弱 ——
      // 一旦将来有人在文件顶部加 'use strict'，this 会变成 undefined，这里就会抛 Illegal invocation。
      var p = origFetch.apply(window, arguments);
      try {
        p.then(
          function (resp) {
            push(netBuf, { url: textOf(url), method: method, status: resp.status, ok: resp.ok, ms: Date.now() - start, initiator: initiator, at: Date.now() });
            return resp;
          },
          function (err) {
            // 只记录，不重新抛出：页面拿到的是原始 promise（return p），
            // 若在此 throw 会让 p.then 的派生 promise 变成未处理拒绝，污染页面控制台。
            push(netBuf, { url: textOf(url), method: method, error: textOf(err && err.message ? err.message : err), ms: Date.now() - start, initiator: initiator, at: Date.now() });
            return undefined;
          }
        ).catch(function () {});
      } catch (e) {}
      return p;
    };
    window.fetch = rfFetchHook;
  }

  // XMLHttpRequest
  if (typeof XMLHttpRequest !== 'undefined') {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    // 用 WeakMap 保存每个请求的状态，而不是往 XHR 实例上挂 __rfNet：
    // 主世界钩子跑在**别人的页面**上，给页面对象写属性是可被观测的副作用
    // （页面若枚举自身属性、或恰好用了同名属性，就会撞车）。WeakMap 不留下任何可见痕迹。
    var xhrState = new WeakMap();
    XMLHttpRequest.prototype.open = function rfXhrOpen(method, url) {
      try {
        xhrState.set(this, { method: method, url: url, start: 0 });
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function rfXhrSend() {
      var self = this;
      var st = xhrState.get(self);
      if (st) {
        st.start = Date.now();
        st.initiator = stackOf();
      }
      self.addEventListener('loadend', function () {
        try {
          var r = xhrState.get(self) || {};
          push(netBuf, {
            url: textOf(r.url),
            method: r.method || 'GET',
            status: self.status,
            ok: self.status >= 200 && self.status < 400,
            ms: Date.now() - (r.start || Date.now()),
            initiator: r.initiator || '',
            at: Date.now(),
          });
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
  }

  // ---- DOM 元素 → 框架源码位置（React / Vue / Svelte）----
  function fiberSource(el) {
    try {
      var keys = Object.keys(el);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) {
          var node = el[keys[i]];
          var depth = 0;
          while (node && depth < 40) {
            if (node._debugSource && node._debugSource.fileName) {
              return {
                framework: 'react',
                file: node._debugSource.fileName,
                line: node._debugSource.lineNumber,
                column: node._debugSource.columnNumber,
                component: (node.type && (node.type.displayName || node.type.name)) || undefined,
              };
            }
            node = node.return;
            depth++;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  function resolveElementSource(el) {
    if (!el) return null;
    var r = fiberSource(el);
    if (r) return r;
    try {
      var vk = Object.keys(el).find(function (k) { return k.indexOf('__vueParentComponent') === 0; });
      if (vk && el[vk] && el[vk].type && el[vk].type.__file) {
        return { framework: 'vue', file: el[vk].type.__file, component: el[vk].type.name || el[vk].type.__name };
      }
    } catch (e) {}
    try {
      if (el.__vue__ && el.__vue__.$options && el.__vue__.$options.__file) {
        return { framework: 'vue', file: el.__vue__.$options.__file };
      }
    } catch (e) {}
    try {
      if (el.__svelte_meta && el.__svelte_meta.loc) {
        return { framework: 'svelte', file: el.__svelte_meta.loc.file, line: el.__svelte_meta.loc.line, column: el.__svelte_meta.loc.char };
      }
    } catch (e) {}
    return null;
  }

  // 只把响应发给本次请求的 MessagePort（若提供），否则退回 window.postMessage 广播。
  function sendReply(port, id, data) {
    var msg = { __rfDebugRes: true, id: id, data: data };
    try {
      if (port) port.postMessage(msg);
      else window.postMessage(msg, '*');
    } catch (err) {}
  }

  // 隔离世界按需读取缓冲 / 解析元素源码
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || !d.__rfDebugReq) return;
    var port = (e.ports && e.ports[0]) || null;
    var data;
    if (d.kind === 'element-source') {
      var el = null;
      try {
        if (d.selector) el = document.querySelector(d.selector);
      } catch (err) {
        el = null;
      }
      data = resolveElementSource(el);
    } else {
      data = d.kind === 'network' ? netBuf : consoleBuf;
      data = data.slice(-MAX);
    }
    sendReply(port, d.__rfDebugReq, data);
  });
})();

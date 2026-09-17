// 页面运行时捕获（MAIN world，document_start）：hook console / 未捕获异常 / fetch / XHR，
// 环形缓冲最近记录，并可把 DOM 元素解析到框架源码位置（React/Vue/Svelte）。
// 供隔离世界的内容脚本按需读取（前端调试 / 页面↔代码 指针）。
// 注意：本文件运行在页面主世界，必须是普通脚本（不能用 import/export）。
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
      // 去掉首行 "Error" 与 hook 自身帧，保留调用方
      var lines = s.split('\n');
      if (lines[0] && lines[0].indexOf('Error') === 0) lines.shift();
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
    window.fetch = function (input, init) {
      var start = Date.now();
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var initiator = stackOf();
      var p = origFetch.apply(this, arguments);
      try {
        p.then(
          function (resp) {
            push(netBuf, { url: textOf(url), method: method, status: resp.status, ok: resp.ok, ms: Date.now() - start, initiator: initiator, at: Date.now() });
            return resp;
          },
          function (err) {
            push(netBuf, { url: textOf(url), method: method, error: textOf(err && err.message ? err.message : err), ms: Date.now() - start, initiator: initiator, at: Date.now() });
            throw err;
          }
        );
      } catch (e) {}
      return p;
    };
  }

  // XMLHttpRequest
  if (typeof XMLHttpRequest !== 'undefined') {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__rfNet = { method: method, url: url, start: 0 };
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      if (self.__rfNet) {
        self.__rfNet.start = Date.now();
        self.__rfNet.initiator = stackOf();
      }
      self.addEventListener('loadend', function () {
        try {
          var r = self.__rfNet || {};
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

  // 隔离世界按需读取缓冲 / 解析元素源码
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || !d.__rfDebugReq) return;
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
    try {
      window.postMessage({ __rfDebugRes: true, id: d.__rfDebugReq, data: data }, '*');
    } catch (err) {}
  });
})();

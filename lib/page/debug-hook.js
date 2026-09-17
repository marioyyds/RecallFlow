// 页面运行时捕获（MAIN world，document_start）：hook console / 未捕获异常 / fetch / XHR，
// 环形缓冲最近记录，供隔离世界的内容脚本按需读取（前端调试用）。
// 注意：本文件运行在页面的主世界，必须是普通脚本（不能用 import/export）。
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

  function textOf(v) {
    return String(v == null ? '' : v).slice(0, 2000);
  }

  // console.*
  ['error', 'warn', 'log', 'info'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      try {
        push(consoleBuf, { level: level, text: textOf(stringify(arguments)), at: Date.now() });
      } catch (e) {}
      return orig && orig.apply(console, arguments);
    };
  });

  // 未捕获异常 / Promise 拒绝
  window.addEventListener('error', function (e) {
    try {
      var msg = e && e.message ? e.message : 'unknown error';
      if (e && e.filename) msg += ' @ ' + e.filename + ':' + (e.lineno || 0);
      push(consoleBuf, { level: 'error', text: textOf(msg), at: Date.now() });
    } catch (e2) {}
  });
  window.addEventListener('unhandledrejection', function (e) {
    try {
      var r = e && e.reason;
      push(consoleBuf, { level: 'error', text: textOf('Unhandled rejection: ' + (r && r.message ? r.message : r)), at: Date.now() });
    } catch (e2) {}
  });

  // fetch
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var start = Date.now();
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var p = origFetch.apply(this, arguments);
      try {
        p.then(
          function (resp) {
            push(netBuf, { url: textOf(url), method: method, status: resp.status, ok: resp.ok, ms: Date.now() - start, at: Date.now() });
            return resp;
          },
          function (err) {
            push(netBuf, { url: textOf(url), method: method, error: textOf(err && err.message ? err.message : err), ms: Date.now() - start, at: Date.now() });
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
      if (self.__rfNet) self.__rfNet.start = Date.now();
      self.addEventListener('loadend', function () {
        try {
          var r = self.__rfNet || {};
          push(netBuf, {
            url: textOf(r.url),
            method: r.method || 'GET',
            status: self.status,
            ok: self.status >= 200 && self.status < 400,
            ms: Date.now() - (r.start || Date.now()),
            at: Date.now(),
          });
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
  }

  // 隔离世界按需读取缓冲
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || !d.__rfDebugReq) return;
    var data = d.kind === 'network' ? netBuf : consoleBuf;
    try {
      window.postMessage({ __rfDebugRes: true, id: d.__rfDebugReq, data: data.slice(-MAX) }, '*');
    } catch (err) {}
  });
})();

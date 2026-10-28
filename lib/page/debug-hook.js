(() => {
  // lib/page/debug-hook.ts
  (function() {
    const pageWindow = window;
    if (pageWindow.__rfDebugHooked) return;
    pageWindow.__rfDebugHooked = true;
    try {
      if (!customElements.get("rf-ai-host")) {
        customElements.define("rf-ai-host", class RfAiHost extends HTMLElement {
        });
      }
    } catch (e) {
    }
    function invoke(fn, self, args) {
      return fn.apply(self, Array.from(args));
    }
    var MAX = 150;
    var consoleBuf = [];
    var netBuf = [];
    function push(buf, entry) {
      buf.push(entry);
      if (buf.length > MAX) buf.shift();
    }
    function textOf(v) {
      return String(v == null ? "" : v).slice(0, 2e3);
    }
    function stackOf() {
      try {
        var s = new Error().stack || "";
        var SELF = /lib\/page\/debug-hook\.js|\brf(Console|Fetch|Xhr)\w*/;
        var lines = s.split("\n");
        if (lines[0] && lines[0].indexOf("Error") === 0) lines.shift();
        while (lines.length && SELF.test(lines[0])) lines.shift();
        return lines.slice(0, 12).join("\n").slice(0, 1800);
      } catch (e) {
        return "";
      }
    }
    var ARG_BUDGET = 400;
    var NODE_BUDGET = 200;
    var MAX_DEPTH = 3;
    var MAX_KEYS = 20;
    var MAX_ITEMS = 10;
    function clipStr(s, n) {
      const text = String(s == null ? "" : s);
      return text.length > n ? text.slice(0, n) + "\u2026" : text;
    }
    function shrink(v, depth, budget) {
      if (budget.left <= 0) return "[\u2026]";
      budget.left -= 1;
      if (v === null || v === void 0) return v;
      var t = typeof v;
      if (t === "string") return clipStr(v, 120);
      if (t === "number" || t === "boolean") return v;
      if (t === "function") return "[Function " + (v.name || "anonymous") + "]";
      if (t === "symbol" || t === "bigint") return clipStr(String(v), 60);
      if (depth >= MAX_DEPTH) return Array.isArray(v) ? "[Array]" : "[Object]";
      if (Array.isArray(v)) {
        var arr = [];
        var n = Math.min(v.length, MAX_ITEMS);
        for (var i = 0; i < n; i++) {
          try {
            arr.push(shrink(v[i], depth + 1, budget));
          } catch (e) {
            arr.push("[unreadable]");
          }
        }
        if (v.length > n) arr.push("\u27E8\u2026\u7701\u7565 " + v.length + " \u9879\u27E9");
        return arr;
      }
      var out = {};
      var keys;
      var record = v;
      try {
        keys = Object.keys(record);
      } catch (e) {
        return "[Object]";
      }
      var m = Math.min(keys.length, MAX_KEYS);
      for (var k = 0; k < m; k++) {
        try {
          out[keys[k]] = shrink(record[keys[k]], depth + 1, budget);
        } catch (e) {
          out[keys[k]] = "[unreadable]";
        }
      }
      if (keys.length > m) out["\u27E8\u2026\u7701\u7565\u5B57\u6BB5\u27E9"] = "\u5171 " + keys.length + " \u4E2A\u5B57\u6BB5";
      return out;
    }
    function stringify(args) {
      try {
        var parts = [];
        for (var i = 0; i < args.length; i++) {
          var a = args[i];
          if (typeof a === "string") {
            parts.push(clipStr(a, ARG_BUDGET));
            continue;
          }
          var text;
          try {
            text = JSON.stringify(shrink(a, 0, { left: NODE_BUDGET }));
          } catch (e) {
            text = null;
          }
          if (text === void 0 || text === null) {
            try {
              text = Object.prototype.toString.call(a);
            } catch (e2) {
              text = "[unserializable]";
            }
          }
          parts.push(clipStr(text, ARG_BUDGET));
        }
        return parts.join(" ");
      } catch (e) {
        return "";
      }
    }
    var pageConsole = console;
    ["error", "warn", "log", "info"].forEach(function(level) {
      var orig = pageConsole[level];
      pageConsole[level] = function rfConsoleHook() {
        try {
          var entry = { level, text: textOf(stringify(arguments)), at: Date.now() };
          if (level === "error" || level === "warn") entry.stack = stackOf();
          push(consoleBuf, entry);
        } catch (e) {
        }
        if (orig) invoke(orig, console, arguments);
      };
    });
    window.addEventListener("error", function(e) {
      try {
        var msg = e && e.message ? e.message : "unknown error";
        if (e && e.filename) msg += " @ " + e.filename + ":" + (e.lineno || 0) + ":" + (e.colno || 0);
        var st = e && e.error && e.error.stack ? e.error.stack : "";
        push(consoleBuf, { level: "error", text: textOf(msg), stack: textOf(st), at: Date.now() });
      } catch (e2) {
      }
    });
    window.addEventListener("unhandledrejection", function(e) {
      try {
        var r = e && e.reason;
        var st = r && r.stack ? r.stack : "";
        push(consoleBuf, { level: "error", text: textOf("Unhandled rejection: " + (r && r.message ? r.message : r)), stack: textOf(st), at: Date.now() });
      } catch (e2) {
      }
    });
    if (typeof window.fetch === "function") {
      var origFetch = window.fetch;
      var fetchWrapper = function rfFetchHook(input, init) {
        var start = Date.now();
        var asRequest = input;
        var url = typeof input === "string" ? input : asRequest && asRequest.url || "";
        var method = init && init.method || asRequest && asRequest.method || "GET";
        var initiator = stackOf();
        var p = invoke(origFetch, window, arguments);
        try {
          p.then(
            function(resp) {
              push(netBuf, { url: textOf(url), method, status: resp.status, ok: resp.ok, ms: Date.now() - start, initiator, at: Date.now() });
              return resp;
            },
            function(err) {
              push(netBuf, { url: textOf(url), method, error: textOf(err && err.message ? err.message : err), ms: Date.now() - start, initiator, at: Date.now() });
              return void 0;
            }
          ).catch(function() {
          });
        } catch (e) {
        }
        return p;
      };
      window.fetch = fetchWrapper;
    }
    if (typeof XMLHttpRequest !== "undefined") {
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      var xhrState = /* @__PURE__ */ new WeakMap();
      XMLHttpRequest.prototype.open = function rfXhrOpen(method, url) {
        try {
          xhrState.set(this, { method, url, start: 0 });
        } catch (e) {
        }
        return invoke(origOpen, this, arguments);
      };
      XMLHttpRequest.prototype.send = function rfXhrSend() {
        var self = this;
        var st = xhrState.get(self);
        if (st) {
          st.start = Date.now();
          st.initiator = stackOf();
        }
        self.addEventListener("loadend", function() {
          try {
            var r = xhrState.get(self) || {};
            push(netBuf, {
              url: textOf(r.url),
              method: r.method || "GET",
              status: self.status,
              ok: self.status >= 200 && self.status < 400,
              ms: Date.now() - (r.start || Date.now()),
              initiator: r.initiator || "",
              at: Date.now()
            });
          } catch (e) {
          }
        });
        return invoke(origSend, this, arguments);
      };
    }
    function fiberSource(el) {
      try {
        var keys = Object.keys(el);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf("__reactFiber$") === 0 || keys[i].indexOf("__reactInternalInstance$") === 0) {
            var node = el[keys[i]];
            var depth = 0;
            while (node && depth < 40) {
              if (node._debugSource && node._debugSource.fileName) {
                return {
                  framework: "react",
                  file: node._debugSource.fileName,
                  line: node._debugSource.lineNumber,
                  column: node._debugSource.columnNumber,
                  component: node.type && (node.type.displayName || node.type.name) || void 0
                };
              }
              node = node.return;
              depth++;
            }
          }
        }
      } catch (e) {
      }
      return null;
    }
    function resolveElementSource(el) {
      if (!el) return null;
      var r = fiberSource(el);
      if (r) return r;
      try {
        var vk = Object.keys(el).find(function(k) {
          return k.indexOf("__vueParentComponent") === 0;
        });
        if (vk && el[vk] && el[vk].type && el[vk].type.__file) {
          return { framework: "vue", file: el[vk].type.__file, component: el[vk].type.name || el[vk].type.__name };
        }
      } catch (e) {
      }
      try {
        if (el.__vue__ && el.__vue__.$options && el.__vue__.$options.__file) {
          return { framework: "vue", file: el.__vue__.$options.__file };
        }
      } catch (e) {
      }
      try {
        if (el.__svelte_meta && el.__svelte_meta.loc) {
          return { framework: "svelte", file: el.__svelte_meta.loc.file, line: el.__svelte_meta.loc.line, column: el.__svelte_meta.loc.char };
        }
      } catch (e) {
      }
      return null;
    }
    function sendReply(port, id, data) {
      var msg = { __rfDebugRes: true, id, data };
      try {
        if (port) port.postMessage(msg);
        else window.postMessage(msg, "*");
      } catch (err) {
      }
    }
    window.addEventListener("message", function(e) {
      var d = e && e.data;
      if (!d || !d.__rfDebugReq) return;
      var port = e.ports && e.ports[0] || null;
      var data;
      if (d.kind === "element-source") {
        var el = null;
        try {
          if (d.selector) el = document.querySelector(d.selector);
        } catch (err) {
          el = null;
        }
        data = resolveElementSource(el);
      } else {
        data = d.kind === "network" ? netBuf : consoleBuf;
        data = data.slice(-MAX);
      }
      sendReply(port, d.__rfDebugReq, data);
    });
  })();
})();

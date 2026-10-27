(() => {
  // lib/userscript/store.ts
  var USERSCRIPTS_KEY = "recallflow.userscripts.v1";

  // lib/userscript/match.ts
  function globToRegExp(pattern) {
    let re = "";
    for (const ch of pattern) {
      if (ch === "*") re += ".*";
      else if (ch === "?") re += ".";
      else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp("^" + re + "$", "i");
  }
  function patternMatches(pattern, url) {
    const p = String(pattern || "").trim();
    if (!p) return false;
    if (/^<all_urls>$/i.test(p)) return /^[a-z][a-z0-9+.-]*:/i.test(url);
    if (p.length > 2 && p[0] === "/" && p[p.length - 1] === "/") {
      try {
        return new RegExp(p.slice(1, -1)).test(url);
      } catch (e) {
        return false;
      }
    }
    return globToRegExp(p).test(url);
  }
  function urlMatches(metadata, url) {
    const u = String(url || "");
    if ((metadata.exclude || []).some((ex) => patternMatches(ex, u))) return false;
    const sources = (metadata.match || []).concat(metadata.include || []);
    if (!sources.length) return true;
    return sources.some((p) => patternMatches(p, u));
  }

  // entries/userscript-runner.js
  (async function initRunner() {
    if (window.__rfUserscriptRunner) return;
    window.__rfUserscriptRunner = true;
    try {
      const data = await chrome.storage.local.get(USERSCRIPTS_KEY);
      const map = data[USERSCRIPTS_KEY] || {};
      const url = location.href;
      for (const script of Object.values(map)) {
        if (!script || !script.enabled || !script.code) continue;
        if (!urlMatches(script, url)) continue;
        try {
          await runScript(script);
        } catch (e) {
          console.error("[RecallFlow] \u7528\u6237\u811A\u672C\u6267\u884C\u5931\u8D25\uFF1A" + (script.name || script.id), e);
        }
      }
    } catch (e) {
      console.error("[RecallFlow] \u7528\u6237\u811A\u672C\u8FD0\u884C\u65F6\u521D\u59CB\u5316\u5931\u8D25", e);
    }
  })();
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "userscript:runNow" && msg.script) {
      runScript(msg.script).then(() => sendResponse({ ok: true, result: "\u5DF2\u8FD0\u884C\u811A\u672C\uFF1A" + (msg.script.name || msg.script.id) })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    return false;
  });
  function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }
  async function runScript(script) {
    const valuesKey = "recallflow.userscript-values." + script.id;
    const vd = await chrome.storage.local.get(valuesKey);
    const values = vd[valuesKey] || {};
    const persistValues = debounce(() => chrome.storage.local.set({ [valuesKey]: values }), 200);
    const name = script.name || script.id;
    const GM = {
      info: {
        script: {
          name,
          version: script.version || "",
          namespace: script.namespace || "",
          description: script.description || "",
          author: script.author || "",
          matches: script.matches || []
        },
        scriptMetaStr: "",
        scriptHandler: "RecallFlow",
        version: "0.0.1"
      },
      log: (...args) => console.log("[US:" + name + "]", ...args),
      getValue: (key, def) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : def,
      setValue: (key, value) => {
        values[key] = value;
        persistValues();
      },
      deleteValue: (key) => {
        delete values[key];
        persistValues();
      },
      listValues: () => Object.keys(values),
      addStyle: (css) => {
        const style = document.createElement("style");
        style.textContent = String(css || "");
        (document.head || document.documentElement).appendChild(style);
        return style;
      },
      addElement: (tag, attributes) => {
        const el = document.createElement(String(tag || "div"));
        if (attributes && typeof attributes === "object") {
          for (const key of Object.keys(attributes)) {
            if (key === "textContent") el.textContent = attributes[key];
            else if (key === "innerHTML") el.innerHTML = attributes[key];
            else el.setAttribute(key, String(attributes[key]));
          }
        }
        (document.body || document.documentElement).appendChild(el);
        return el;
      },
      openInTab: (url, options) => {
        chrome.runtime.sendMessage({
          type: "userscript:openTab",
          url,
          active: !(options && options.active === false)
        });
      },
      registerMenuCommand: (caption) => {
        console.warn("[RecallFlow] GM_registerMenuCommand \u6682\u4E0D\u652F\u6301\uFF1A" + caption);
      },
      setClipboard: (text) => {
        const done = () => {
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(String(text || "")).then(done, done);
        } else {
          const ta = document.createElement("textarea");
          ta.value = String(text || "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand("copy");
          } catch (e) {
          }
          ta.remove();
        }
      },
      notification: (title, text) => {
        const payload = title && typeof title === "object" ? { title: title.title || "", text: title.text || "" } : { title: String(title || ""), text: String(text || "") };
        chrome.runtime.sendMessage({ type: "userscript:notify", ...payload });
      },
      getResourceText: (resourceName) => script.resources ? script.resources[resourceName] || null : null,
      getResourceURL: () => null,
      xmlhttpRequest: (details) => {
        if (!details || typeof details !== "object") return;
        chrome.runtime.sendMessage({ type: "userscript:xhr", details }, (res) => {
          if (!res) return;
          if (res.error) {
            if (typeof details.onerror === "function") details.onerror({ error: res.error });
            return;
          }
          if (typeof details.onload === "function") {
            details.onload({
              status: res.status,
              statusText: res.statusText,
              responseText: res.responseText,
              finalUrl: res.finalUrl
            });
          }
        });
      }
    };
    const body = (script.requiresCode || []).join("\n") + "\n" + script.code;
    const fn = new Function("GM", "unsafeWindow", "window", "document", "location", '"use strict";\n' + body);
    fn(GM, window, window, document, location);
  }
})();

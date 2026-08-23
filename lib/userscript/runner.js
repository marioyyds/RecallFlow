// 用户脚本运行时（内容脚本，由 manager 动态注册注入）。
// 职责：读取已安装脚本 → URL 匹配 → 以 new Function 执行，并提供 GM_* 垫片。
import { USERSCRIPTS_KEY } from './store.js';
import { urlMatches } from './match.js';

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
        console.error('[RecallFlow] 用户脚本执行失败：' + (script.name || script.id), e);
      }
    }
  } catch (e) {
    console.error('[RecallFlow] 用户脚本运行时初始化失败', e);
  }
})();

// 供 Agent 按需运行脚本（run_userscript 工具）：不要求 URL 匹配，显式执行。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'userscript:runNow' && msg.script) {
    runScript(msg.script)
      .then(() => sendResponse({ ok: true, result: '已运行脚本：' + (msg.script.name || msg.script.id) }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

async function runScript(script) {
  const valuesKey = 'recallflow.userscript-values.' + script.id;
  const vd = await chrome.storage.local.get(valuesKey);
  const values = vd[valuesKey] || {};
  const persistValues = debounce(() => chrome.storage.local.set({ [valuesKey]: values }), 200);

  const name = script.name || script.id;
  const GM = {
    info: {
      script: {
        name,
        version: script.version || '',
        namespace: script.namespace || '',
        description: script.description || '',
        author: script.author || '',
        matches: script.matches || [],
      },
      scriptMetaStr: '',
      scriptHandler: 'RecallFlow',
      version: '0.0.1',
    },
    log: (...args) => console.log('[US:' + name + ']', ...args),
    getValue: (key, def) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : def),
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
      const style = document.createElement('style');
      style.textContent = String(css || '');
      (document.head || document.documentElement).appendChild(style);
      return style;
    },
    addElement: (tag, attributes) => {
      const el = document.createElement(String(tag || 'div'));
      if (attributes && typeof attributes === 'object') {
        for (const key of Object.keys(attributes)) {
          if (key === 'textContent') el.textContent = attributes[key];
          else if (key === 'innerHTML') el.innerHTML = attributes[key];
          else el.setAttribute(key, String(attributes[key]));
        }
      }
      (document.body || document.documentElement).appendChild(el);
      return el;
    },
    openInTab: (url, options) => {
      chrome.runtime.sendMessage({
        type: 'userscript:openTab',
        url,
        active: !(options && options.active === false),
      });
    },
    registerMenuCommand: (caption) => {
      console.warn('[RecallFlow] GM_registerMenuCommand 暂不支持：' + caption);
    },
    setClipboard: (text) => {
      const done = () => {};
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(text || '')).then(done, done);
      } else {
        const ta = document.createElement('textarea');
        ta.value = String(text || '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        ta.remove();
      }
    },
    notification: (title, text) => {
      const payload =
        title && typeof title === 'object'
          ? { title: title.title || '', text: title.text || '' }
          : { title: String(title || ''), text: String(text || '') };
      chrome.runtime.sendMessage({ type: 'userscript:notify', ...payload });
    },
    getResourceText: (resourceName) => (script.resources ? script.resources[resourceName] || null : null),
    getResourceURL: () => null,
    xmlhttpRequest: (details) => {
      if (!details || typeof details !== 'object') return;
      chrome.runtime.sendMessage({ type: 'userscript:xhr', details }, (res) => {
        if (!res) return;
        if (res.error) {
          if (typeof details.onerror === 'function') details.onerror({ error: res.error });
          return;
        }
        if (typeof details.onload === 'function') {
          details.onload({
            status: res.status,
            statusText: res.statusText,
            responseText: res.responseText,
            finalUrl: res.finalUrl,
          });
        }
      });
    },
  };

  const body = (script.requiresCode || []).join('\n') + '\n' + script.code;
  const fn = new Function('GM', 'unsafeWindow', 'window', 'document', 'location', '"use strict";\n' + body);
  fn(GM, window, window, document, location);
}

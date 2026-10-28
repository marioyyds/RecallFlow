// 用户脚本运行时（内容脚本，由 manager 动态注册 / executeScript 注入）。
// 职责：读取已安装脚本 → URL 匹配 → 以 new Function 执行，并提供 GM_* 垫片。
//
// ⚠ 本文件是**构建入口**（产物 = lib/userscript/runner.js，见 scripts/build-entries.mjs），
// 不是浏览器直接加载的模块。因此这里可以写静态 import —— 产物的 IIFE 形态会把依赖内联。
//
// 历史：产物必须是 **classic 脚本**（executeScript 以路径注入，不能用静态 import）。
// 它此前用 `import(chrome.runtime.getURL('lib/userscript/store.js'))` 动态拉依赖，
// 那是「classic 脚本」与「要复用 ES 模块」的唯一兼容写法。引入入口构建后，
// 静态 import 在构建期被内联，运行时不需要再按路径取模块 —— 少两次 fetch，
// 也不再需要把 lib/userscript/* 暴露成可被网页取到的资源。
import { USERSCRIPTS_KEY } from '../lib/userscript/store.ts';
import { urlMatches } from '../lib/userscript/match.ts';
import type { MatchRules } from '../lib/userscript/match.ts';

/** 本文件在 window 上留一个「运行时已装」标记（重复注入时直接退出）。 */
type RunnerWindow = Window & typeof globalThis & { __rfUserscriptRunner?: boolean };

/** 已安装用户脚本（store 里存的那个形状；字段全部可选，缺了就按默认值走）。 */
interface UserScript extends MatchRules {
  id?: string;
  name?: string;
  enabled?: boolean;
  code?: string;
  version?: string;
  namespace?: string;
  description?: string;
  author?: string;
  matches?: string[];
  resources?: Record<string, string>;
  requiresCode?: string[];
}

(async function initRunner() {
  const pageWindow = window as RunnerWindow;
  if (pageWindow.__rfUserscriptRunner) return;
  pageWindow.__rfUserscriptRunner = true;
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
  return false;
});

function debounce<T extends unknown[]>(fn: (...args: T) => unknown, ms: number): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: T) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

async function runScript(script: UserScript) {
  const valuesKey = 'recallflow.userscript-values.' + script.id;
  const vd = await chrome.storage.local.get(valuesKey);
  const values = (vd[valuesKey] || {}) as Record<string, unknown>;
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
    log: (...args: unknown[]) => console.log('[US:' + name + ']', ...args),
    getValue: (key: string, def: unknown) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : def),
    setValue: (key: string, value: unknown) => {
      values[key] = value;
      persistValues();
    },
    deleteValue: (key: string) => {
      delete values[key];
      persistValues();
    },
    listValues: () => Object.keys(values),
    addStyle: (css: unknown) => {
      const style = document.createElement('style');
      style.textContent = String(css || '');
      (document.head || document.documentElement).appendChild(style);
      return style;
    },
    addElement: (tag: unknown, attributes: Record<string, unknown> | null | undefined) => {
      const el = document.createElement(String(tag || 'div'));
      if (attributes && typeof attributes === 'object') {
        for (const key of Object.keys(attributes)) {
          if (key === 'textContent') el.textContent = attributes[key] as string;
          else if (key === 'innerHTML') el.innerHTML = attributes[key] as string;
          else el.setAttribute(key, String(attributes[key]));
        }
      }
      (document.body || document.documentElement).appendChild(el);
      return el;
    },
    openInTab: (url: unknown, options: { active?: boolean } | null | undefined) => {
      chrome.runtime.sendMessage({
        type: 'userscript:openTab',
        url,
        active: !(options && options.active === false),
      });
    },
    registerMenuCommand: (caption: unknown) => {
      console.warn('[RecallFlow] GM_registerMenuCommand 暂不支持：' + caption);
    },
    setClipboard: (text: unknown) => {
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
    notification: (title: unknown, text: unknown) => {
      const payload =
        title && typeof title === 'object'
          ? { title: (title as { title?: string }).title || '', text: (title as { text?: string }).text || '' }
          : { title: String(title || ''), text: String(text || '') };
      chrome.runtime.sendMessage({ type: 'userscript:notify', ...payload });
    },
    getResourceText: (resourceName: string) => (script.resources ? script.resources[resourceName] || null : null),
    getResourceURL: () => null,
    xmlhttpRequest: (details: Record<string, any>) => {
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
